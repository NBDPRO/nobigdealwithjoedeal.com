/**
 * tests/doc-link-2026-11-04.test.js — Secure Document Link (document tracker).
 *
 * Dark behind SECURE_DOC_LINK_ENABLED / DOC_LINK_FOLLOWUP_ENABLED. Everything
 * here is EXECUTED against stubbed firebase modules and a fake Firestore
 * (tests/lib/doc-link-world.js); nothing reaches a network and nothing can be
 * sent to a customer.
 *
 *   A. pure logic: password (scrypt), lockout, unlock cookie, device, clamps, reminder decision, copy
 *   B. flag OFF: getSharedReport is byte-identical to origin/main (golden), secure links fail closed
 *   C. mint: createEstimateReviewLink { secure } + revokeDocumentLink
 *   D. serve: password gate, lockout, shell, file
 *   E. beacon: open / ping / reading-now / tenant isolation / bots / throttles
 *   F. 24h reminder sweep
 *   G. static: CSP-safe pages, no pixel, flags registered
 *
 * Run: node tests/doc-link-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const world = require('./lib/doc-link-world');
const { ROOT, FUNCTIONS, fnPath, W, DB, call, mkReq, mkRes, flush, baseWorld, UPLOAD_PATH, Timestamp } = world;

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const L = require(fnPath('doc-link-logic.js'));
const SEND = require(fnPath('estimate-send.js'));
const SHARE = require(fnPath('report-sharing.js'));
const PING = require(fnPath('doc-link-ping.js'));
const SWEEP = require(fnPath('doc-link-followup.js'));
const COPY = require(path.join(ROOT, 'docs/pro/js/doc-link-copy.js'));
const VIEW = require(path.join(ROOT, 'docs/pro/js/doc-link-view.js'));
const golden = require('./lib/doc-link-golden-scenarios');

const OWNER = { uid: 'u1' };
const IPHONE = world.IPHONE;
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const H = 3600000, D = 86400000;
const ON = () => { process.env.SECURE_DOC_LINK_ENABLED = 'true'; };
const OFF = () => { delete process.env.SECURE_DOC_LINK_ENABLED; };
const notes = () => Object.keys(W.docs).filter((k) => k.startsWith('notifications/')).map((k) => W.docs[k]);
const tokenDocs = () => Object.keys(W.docs).filter((k) => k.startsWith('report_share_tokens/'));
const viewRows = () => Object.keys(W.docs).filter((k) => k.startsWith('leads/lead-1/docViews/'));
const cookieOf = (res) => String(res.headers['Set-Cookie'] || '').split(';')[0];

async function mintSecure(data) {
  const r = await call(SEND.createEstimateReviewLink, Object.assign({ leadId: 'lead-1', documentId: 'doc-1', secure: true }, data || {}), OWNER);
  return r;
}
async function fetchShell(token, headers) {
  const res = mkRes();
  await SHARE.getSharedReport(mkReq({ path: '/report/' + token, headers }), res);
  await flush();
  return res;
}
const viewIdOf = (res) => (/name="nbd-doc-view" content="([a-z0-9]{16})"/.exec(String(res.body)) || [])[1];
function beacon(token, viewId, k, s, ua, extra) {
  const res = mkRes();
  const req = mkReq({ method: 'POST', path: '/api/doc-link-ping', body: JSON.stringify({ t: token, v: viewId, k, s }), headers: { 'user-agent': ua || IPHONE } });
  return PING.handle(req, res, Object.assign({ db: DB, now: () => W.now, push: world.pushStub }, extra || {})).then(() => { return res; });
}

(async () => {
  // ═════════════════════════════════════════════════════════════════
  console.log('A. pure logic');
  // ═════════════════════════════════════════════════════════════════
  {
    const a = await L.hashPassword('blue-door-42');
    const b = await L.hashPassword('blue-door-42');
    ok('scrypt round trip: the right password verifies', await L.verifyPassword('blue-door-42', a));
    ok('a wrong password does not verify', !(await L.verifyPassword('blue-door-43', a)));
    ok('the same password under two salts gives two different hashes', a.passwordHash !== b.passwordHash && a.passwordSalt !== b.passwordSalt);
    ok('the stored record never contains the plain text', !JSON.stringify(a).includes('blue-door'));
    ok('params are scrypt N=32768 r=8 p=1, 16-byte salt, 32-byte key',
      a.passwordParams.alg === 'scrypt' && a.passwordParams.N === 32768 && Buffer.from(a.passwordSalt, 'base64').length === 16 && Buffer.from(a.passwordHash, 'base64').length === 32);
    ok('a record with weakened/odd params never verifies', !(await L.verifyPassword('blue-door-42', Object.assign({}, a, { passwordParams: Object.assign({}, a.passwordParams, { N: 2 }) }))));
    ok('a truncated hash never verifies (length guard)', !(await L.verifyPassword('blue-door-42', Object.assign({}, a, { passwordHash: a.passwordHash.slice(0, 8) }))));
    ok('an empty record never verifies', !(await L.verifyPassword('x', {})) && !(await L.verifyPassword('x', null)));
    const g = L.generatePassword();
    ok('a generated code is 8 unambiguous characters shown as ABCD-EFGH', /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(g), g);
    const gh = await L.hashPassword(g);
    ok('a generated code verifies typed lower-case, without the hyphen, or with spaces',
      await L.verifyPassword(g.toLowerCase(), gh) && await L.verifyPassword(g.replace('-', ''), gh) && await L.verifyPassword(' ' + g + ' ', gh));
    ok('two generated codes differ', L.generatePassword() !== L.generatePassword());
    ok('password length rules: 6..64', !L.passwordOk('12345') && L.passwordOk('123456') && L.passwordOk('x'.repeat(64)) && !L.passwordOk('x'.repeat(65)));
  }
  {
    const T0 = 1_000_000_000_000;
    let tok = {};
    let r;
    const seq = [];
    for (let i = 1; i <= 5; i++) { r = L.reserveAttempt(tok, T0 + i * 1000); seq.push(r.allowed); tok = Object.assign({}, tok, r.patch); }
    ok('tries 1..5 are allowed', seq.every(Boolean));
    ok('the 5th try arms the lock (willLock) so a failure there locks the link', r.willLock === true && tok.pwLockedUntilMs === T0 + 5000 + 15 * 60000);
    r = L.reserveAttempt(tok, T0 + 6000);
    ok('the 6th try inside the window is refused with a retry time, before any password check', r.allowed === false && r.retryAfterMs > 0);
    const clr = Object.assign({}, tok, L.clearAttempts());
    ok('a correct password clears the counters', L.reserveAttempt(clr, T0 + 7000).allowed && L.reserveAttempt(clr, T0 + 7000).patch.failedPwCount === 1);
    r = L.reserveAttempt(tok, T0 + 5000 + 15 * 60000 + 1);
    ok('after the 15 minute lock the budget starts over', r.allowed && r.patch.failedPwCount === 1 && !r.willLock);
    let t2 = {}; for (let i = 0; i < 4; i++) t2 = Object.assign({}, t2, L.reserveAttempt(t2, T0 + i * 1000).patch);
    r = L.reserveAttempt(t2, T0 + 16 * 60000);
    ok('four wrong tries, then a quiet 15 minutes, then a try: counted as the first', r.allowed && r.patch.failedPwCount === 1);
  }
  {
    const now = 5_000_000;
    const c = L.unlockCookie('', 'TOKENAAAAAAAAAAAAAAAAAAAA', 'key-1', now);
    ok('the unlock proof is a cookie named __session (the only one Hosting forwards)', /^__session=/.test(c) && /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c));
    const val = c.split(';')[0];
    ok('it unlocks its own link', L.isUnlocked(val, 'TOKENAAAAAAAAAAAAAAAAAAAA', 'key-1', now + 1000));
    ok('…not after 2 hours', !L.isUnlocked(val, 'TOKENAAAAAAAAAAAAAAAAAAAA', 'key-1', now + 2 * H + 1));
    ok('…not with a different link key (a proof for one link is no proof for another)', !L.isUnlocked(val, 'TOKENAAAAAAAAAAAAAAAAAAAA', 'key-2', now + 1000));
    ok('…not for a different token', !L.isUnlocked(val, 'TOKENBBBBBBBBBBBBBBBBBBBB', 'key-1', now + 1000));
    ok('…a tampered expiry fails', !L.isUnlocked(val.replace(/:(\d+):/, ':99999999999999:'), 'TOKENAAAAAAAAAAAAAAAAAAAA', 'key-1', now + 1000));
    ok('…no key on the token means never unlocked', !L.isUnlocked(val, 'TOKENAAAAAAAAAAAAAAAAAAAA', '', now + 1000));
    const two = L.unlockCookie(val, 'TOKENBBBBBBBBBBBBBBBBBBBB', 'key-2', now).split(';')[0];
    ok('one cookie can carry two links', L.isUnlocked(two, 'TOKENAAAAAAAAAAAAAAAAAAAA', 'key-1', now + 1) && L.isUnlocked(two, 'TOKENBBBBBBBBBBBBBBBBBBBB', 'key-2', now + 1));
  }
  {
    const P = L.parseDevice;
    ok('iPhone', P(IPHONE).device === 'mobile' && P(IPHONE).os === 'iOS' && P(IPHONE).browser === 'Safari');
    ok('iPad', P('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1').device === 'tablet');
    ok('Android phone vs tablet', P('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36').device === 'mobile'
      && P('Mozilla/5.0 (Linux; Android 14; SM-X900) AppleWebKit/537.36 Chrome/130 Safari/537.36').device === 'tablet');
    ok('Windows Chrome desktop', P(DESKTOP).device === 'desktop' && P(DESKTOP).os === 'Windows' && P(DESKTOP).browser === 'Chrome');
    ok('Mac Safari desktop', P('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15').os === 'macOS');
    ok('empty UA is unknown', P('').device === 'unknown' && P(undefined).device === 'unknown');
    ok('only a class is returned, never the string', Object.keys(P(IPHONE)).sort().join() === 'browser,device,os');
    ok('scanners and preview fetchers are bots, a phone is not', L.isBot('') && L.isBot('facebookexternalhit/1.1') && L.isBot('Mozilla/5.0 (compatible; Googlebot/2.1)') && !L.isBot(IPHONE));
  }
  {
    ok('clampPing: NaN, negative and zero add nothing', L.clampPing(NaN, 20000, 0) === 0 && L.clampPing(-5, 20000, 0) === 0 && L.clampPing(0, 20000, 0) === 0);
    ok('clampPing: at most 60 seconds', L.clampPing(500, 600000, 0) === 60);
    ok('clampPing: no more than wall clock + 5 s slack', L.clampPing(60, 10000, 0) === 15 && L.clampPing(15, 2000, 0) === 7);
    ok('clampPing: a negative elapsed adds nothing', L.clampPing(10, -1, 0) === 0);
    ok('clampPing: the 4 hour per-view cap', L.clampPing(60, 600000, 14390) === 10 && L.clampPing(60, 600000, 14400) === 0);
    ok('shouldPromoteOpen needs 3 visible seconds AND 2.5 s since the fetch',
      !L.shouldPromoteOpen(2, 9000) && L.shouldPromoteOpen(3, 9000) && !L.shouldPromoteOpen(3, 100) && !L.shouldPromoteOpen('x', 9000));
    ok('expiryDays: default 14, max 90, junk -> 14', L.expiryDays(undefined) === 14 && L.expiryDays(7) === 7 && L.expiryDays(500) === 90 && L.expiryDays('abc') === 14 && L.expiryDays(0) === 14);
  }
  {
    const now = 10 * D;
    const tok = (o) => Object.assign({ purpose: 'secure_doc', status: 'active', ownerUid: 'u1', firstOpenedAt: now - 30 * H, followUpDueAtMs: now - H, expiresAt: now + 5 * D }, o);
    const lead = (o) => Object.assign({ userId: 'u1', stage: 'estimate_sent_cash' }, o);
    const d = (t, l) => L.followUpDecision(t, l, now);
    ok('due and nothing else going on -> file', d(tok(), lead()).action === 'file');
    ok('not due yet -> wait', d(tok({ followUpDueAtMs: now + H }), lead()).action === 'wait');
    ok('already filed -> skip', d(tok({ followUpFiledAt: now - 1 }), lead()).action === 'skip');
    ok('stage moved on (signed) -> skip and clear', d(tok(), lead({ stage: 'contract_signed' })).reason === 'moved_on' && d(tok(), lead({ stage: 'lost' })).clear);
    ok('Jo nudged after the first open -> skip', d(tok(), lead({ lastEstimateNudgeAt: now - 2 * H })).reason === 'nudged');
    ok('a nudge BEFORE the first open does not hide it', d(tok(), lead({ lastEstimateNudgeAt: now - 40 * H })).action === 'file');
    ok('the customer wrote after the first open (lastInboundAt) -> skip', d(tok(), lead({ lastInboundAt: now - 3 * H })).reason === 'replied');
    ok('revoked / expired -> skip', d(tok({ status: 'revoked' }), lead()).reason === 'revoked' && d(tok({ expiresAt: now - 1 }), lead()).reason === 'expired');
    ok('lead deleted or missing -> skip', d(tok(), null).reason === 'no_lead' && d(tok(), lead({ deleted: true })).reason === 'no_lead');
    ok('lead owned by someone else -> skip (tenant)', d(tok(), lead({ userId: 'u2' })).reason === 'owner_mismatch');
    ok('a due time a week old is stale, not filed', d(tok({ followUpDueAtMs: now - 8 * D }), lead()).reason === 'stale');
    ok('a legacy (non secure) token is never reminded', d(tok({ purpose: 'estimate_review' }), lead()).reason === 'not_secure');
  }
  {
    const exp = Date.parse('2026-11-18T15:00:00Z');
    const approved = 'This is a private link to your estimate from No Big Deal. It\'s tracked: Joe can see when it\'s opened, how many times and for how long, so he knows when to follow up. It expires on November 18, 2026.';
    ok('the server notice is Jo\'s approved sentence, word for word', L.trackingNotice({ expiresAtMs: exp }) === approved, L.trackingNotice({ expiresAtMs: exp }));
    ok('the client notice is identical to the server notice', COPY.trackingNotice({ expiresAtMs: exp }) === L.trackingNotice({ expiresAtMs: exp }));
    const other = L.trackingNotice({ expiresAtMs: exp, brand: 'Acme Roofing', rep: 'Dana' });
    ok('another tenant gets its own name in the same sentence, never NBD\'s', /from Acme Roofing\./.test(other) && /Dana can see/.test(other) && !/No Big Deal|Joe/.test(other));
    const msg = COPY.secureReviewMessage({ firstName: 'Sam', from: 'Joe with No Big Deal', url: 'https://nobigdealwithjoedeal.com/report/ABC', expiresAtMs: exp, hasCode: true });
    ok('the share message carries the notice and the expiry date', msg.includes(approved) && /November 18, 2026/.test(msg));
    ok('…the link, and says the code comes separately', msg.includes('/report/ABC') && /code/i.test(msg) && !/[A-Z2-9]{4}-[A-Z2-9]{4}/.test(msg));
    ok('…no tracking pixel or markup', !/<img|<script|<iframe|pixel/i.test(msg));
    ok('…no claim-handling wording', !/claim|insur|adjuster|deductible/i.test(msg));
    const rem = L.reminderCopy({ name: 'Sam Smith', docLabel: 'Estimate.pdf', openCount: 3, readSeconds: 360, firstOpenedAtMs: exp, tz: 'America/New_York' });
    ok('the reminder names the customer, views and minutes, says nothing was sent, and does not claim a reply is impossible',
      /Sam Smith opened "Estimate.pdf"/.test(rem.text) && /3 views/.test(rem.text) && /about 6 min with the page open/.test(rem.text) && /Nothing was sent to the customer/.test(rem.text) && /don't see a reply in the CRM/.test(rem.text), rem.text);
    ok('the chip says "with the page open", never "reading"', /with the page open/.test(COPY.chipText({ openCount: 2, firstOpenedAt: exp, lastOpenedAt: exp + H, readSeconds: 400, device: 'mobile' }, exp)) && !/reading/i.test(COPY.chipText({ openCount: 2, readSeconds: 400 }, exp)));
    ok('the chip for an unopened link says so', /^Not opened yet/.test(COPY.chipText({ openCount: 0, expiresAt: exp + D }, exp)));
  }

  // ═════════════════════════════════════════════════════════════════
  console.log('\nB. flag OFF: nothing changes');
  // ═════════════════════════════════════════════════════════════════
  {
    OFF();
    const want = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'doc-link-golden-main.json'), 'utf8'));
    const got = JSON.parse(JSON.stringify(await golden.run(fnPath('report-sharing.js'))));
    const names = Object.keys(want);
    ok('golden: ' + names.length + ' legacy scenarios recorded from origin/main', names.length >= 12);
    for (const n of names) {
      ok('golden ' + n + ': status, every header, body bytes and every Firestore write are byte-identical to origin/main',
        JSON.stringify(got[n]) === JSON.stringify(want[n]), JSON.stringify(got[n]).slice(0, 200));
    }
  }
  {
    OFF();
    baseWorld();
    const r = await mintSecure();
    ok('with the master flag off a secure mint is refused and writes nothing', r.err && r.err.code === 'failed-precondition' && !tokenDocs().length);
    const legacy = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    ok('the legacy mint still works and is NOT a secure link', legacy.value && W.docs['report_share_tokens/' + legacy.value.token].purpose === 'estimate_review');
    // A secure token that exists while the flag is off must never be served (it may be password-protected).
    ON();
    const m = (await mintSecure({ password: 'generate' })).value;
    OFF();
    const res = await fetchShell(m.token);
    ok('flag off + an existing secure token -> unavailable (fail closed), no PDF bytes, no view row', res.statusCode === 503 && !String(res.bytes() + res.body).includes('%PDF') && !viewRows().length);
    const b = await beacon(m.token, 'abcdefghijklmnop', 'open', 5);
    ok('flag off: the beacon answers 204 and writes nothing', b.statusCode === 204 && !viewRows().length);
  }

  // ═════════════════════════════════════════════════════════════════
  console.log('\nC. mint + revoke');
  // ═════════════════════════════════════════════════════════════════
  {
    ON(); baseWorld();
    const r = await mintSecure({ password: 'generate', expiryDays: 7 });
    const v = r.value || {};
    ok('mint ok: secure link, 7 days, code shown once', r.value && v.secure === true && v.expiryDays === 7 && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(v.password || ''), r.err && r.err.message);
    const tok = W.docs['report_share_tokens/' + v.token];
    ok('token doc: purpose secure_doc, kind lead_document, scrypt record, per-link unlock key',
      tok.purpose === 'secure_doc' && tok.kind === 'lead_document' && tok.passwordRequired === true && tok.passwordParams.alg === 'scrypt' && !!tok.passwordHash && !!tok.passwordSalt && String(tok.unlockKey).length >= 40);
    const plain = v.password.replace('-', '');
    const world_ = JSON.stringify(W.docs);
    ok('the plain code is stored NOWHERE (not on the token, the lead, the document row or any other doc)', !world_.includes(v.password) && !world_.includes(plain));
    ok('the code is not in the URL', !v.shareUrl.includes(plain));
    ok('expiry = now + 7 days', Math.abs(tok.expiresAt.toMillis() - (W.now + 7 * D)) < 5000);
    ok('the lead carries the chip summary (lead.docTrack) for this link', W.docs['leads/lead-1'].docTrack && W.docs['leads/lead-1'].docTrack.tokenRef === v.token.slice(0, 10) && W.docs['leads/lead-1'].docTrack.passwordSet === true);
    ok('the verifier accepts the shown code', await L.verifyPassword(v.password, tok));
    const again = await mintSecure({ password: 'generate' });
    ok('a second tap mints a NEW link (a reused one could not show its code again)', again.value && again.value.token !== v.token);
    const legacy = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER);
    ok('the legacy "Send for review" never hands out a secure link', legacy.value && W.docs['report_share_tokens/' + legacy.value.token].purpose === 'estimate_review');
  }
  {
    ON(); baseWorld();
    const none = await mintSecure({});
    ok('no password asked -> no hash stored, 14 days by default', none.value && none.value.password === null && none.value.passwordRequired === false && none.value.expiryDays === 14 && !W.docs['report_share_tokens/' + none.value.token].passwordHash);
    const big = await mintSecure({ expiryDays: 400 });
    ok('server max is 90 days', big.value && big.value.expiryDays === 90);
    const own = await mintSecure({ password: 'my own phrase' });
    ok('a typed password hashes and is not echoed back', own.value && own.value.password === null && own.value.passwordRequired === true && !JSON.stringify(W.docs).includes('my own phrase'));
    const short = await mintSecure({ password: 'abc' });
    ok('a too-short password is refused', short.err && short.err.code === 'invalid-argument');
    const stranger = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1', secure: true }, { uid: 'u9', role: 'sales_rep', companyId: 'other' });
    ok('another tenant cannot mint', stranger.err && stranger.err.code === 'permission-denied');
    const viewer = await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1', secure: true }, { uid: 'u1', role: 'viewer' });
    ok('a viewer cannot mint', !!viewer.err);
  }
  {
    ON(); baseWorld({ 'companyProfile/u1': { brand: { legalName: 'Acme Roofing LLC' } } });
    const r = await mintSecure();
    ok('another tenant\'s brand rides on the token for the notice', r.value && W.docs['report_share_tokens/' + r.value.token].noticeBrand === 'Acme Roofing LLC');
  }
  {
    ON(); baseWorld();
    const m = (await mintSecure()).value;
    const leg = (await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER)).value;
    W.docs['report_share_tokens/' + m.token].followUpDueAtMs = W.now + D;
    const stranger = await call(SEND.revokeDocumentLink, { leadId: 'lead-1', token: m.token }, { uid: 'u9', role: 'sales_rep', companyId: 'other' });
    ok('another tenant cannot revoke', stranger.err && stranger.err.code === 'permission-denied' && W.docs['report_share_tokens/' + m.token].status === 'active');
    const lg = await call(SEND.revokeDocumentLink, { leadId: 'lead-1', token: leg.token }, OWNER);
    ok('revoke only works on a secure link of this lead', lg.err && lg.err.code === 'failed-precondition' && W.docs['report_share_tokens/' + leg.token].status === 'active');
    const r = await call(SEND.revokeDocumentLink, { leadId: 'lead-1', token: m.token }, OWNER);
    const t = W.docs['report_share_tokens/' + m.token];
    ok('revoke: status revoked, expiry in the past, who/when stamped, reminder cleared', r.value && r.value.ok && t.status === 'revoked' && t.expiresAt.toMillis() < Date.now() && t.revokedBy === 'u1' && t.followUpDueAtMs === null);
    const res = await fetchShell(m.token);
    ok('the customer then sees "revoked, ask for a fresh one" and nothing else', res.statusCode === 410 && /revoked/.test(String(res.body)) && !viewRows().length);
  }

  // ═════════════════════════════════════════════════════════════════
  console.log('\nD. serve: password gate, lockout, shell, file');
  // ═════════════════════════════════════════════════════════════════
  {
    ON(); baseWorld();
    const m = (await mintSecure({ password: 'generate' })).value;
    const code = m.password;
    let res = await fetchShell(m.token);
    ok('password set, no cookie -> the password page', res.statusCode === 200 && /name="code"/.test(String(res.body)) && /type="password"/.test(String(res.body)));
    ok('…it has no PDF bytes, no document name and writes no view row', !String(res.body).includes('%PDF') && !String(res.body).includes('Smith_Estimate') && !viewRows().length);
    ok('…the code is a POST field, never in the URL (form method=post)', /method="post"/.test(String(res.body)));
    let file = mkRes();
    await SHARE.getSharedReport(mkReq({ path: '/report/' + m.token + '/file' }), file);
    await flush();
    ok('/file without the unlock proof is the password page, not the bytes', !file.bytes().includes('%PDF') && /name="code"/.test(String(file.body)));
    const tooBad = mkRes();
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/' + m.token + '/unlock' }), tooBad);
    ok('GET /unlock just redirects (no side effect)', tooBad.statusCode === 303);

    const post = async (c, cookie) => {
      const r = mkRes();
      await SHARE.getSharedReport(mkReq({ method: 'POST', path: '/report/' + m.token + '/unlock', body: { code: c }, headers: cookie ? { cookie } : {} }), r);
      await flush();
      return r;
    };
    // five wrong tries
    let last;
    for (let i = 1; i <= 5; i++) last = await post('WRONG-' + i);
    ok('wrong code -> 401 and the password page again', last.statusCode === 401 && /did not match/.test(String(last.body)));
    ok('the 5th wrong try locks the link and tells Jo once (a bell, not a text)', notes().filter((n) => /guessing the password/.test(n.message || '')).length === 1 && W.docs['report_share_tokens/' + m.token].pwLockedUntilMs > W.now - 1);
    ok('…the bell does not contain the code', !JSON.stringify(notes()).includes(code));
    const sixth = await post(code);
    ok('the 6th try is locked even with the RIGHT code (429, no cookie)', sixth.statusCode === 429 && !sixth.headers['Set-Cookie']);
    ok('…and a locked link serves no bytes through /file either', !(await (async () => { const f = mkRes(); await SHARE.getSharedReport(mkReq({ path: '/report/' + m.token + '/file' }), f); await flush(); return f.bytes().includes('%PDF'); })()));
    // unlock after the lock expires
    W.docs['report_share_tokens/' + m.token].pwLockedUntilMs = Date.now() - 1;
    const good = await post(code.toLowerCase());
    ok('after the lock passes the right code unlocks (303 + __session cookie)', good.statusCode === 303 && /^__session=/.test(cookieOf(good)) && good.redirectTo === '/report/' + m.token);
    ok('…and the counters reset', W.docs['report_share_tokens/' + m.token].failedPwCount === 0);
    const cookie = cookieOf(good);
    res = await fetchShell(m.token, { cookie });
    ok('with the cookie: the viewer shell, 200, no-store, noindex', res.statusCode === 200 && res.headers['Cache-Control'] === 'no-store' && /noindex/.test(res.headers['X-Robots-Tag']));
    const html = String(res.body);
    ok('the shell carries the approved tracking notice banner', html.includes('This is a private link to your estimate from No Big Deal. It&#039;s tracked: Joe can see when it&#039;s opened, how many times and for how long, so he knows when to follow up. It expires on '));
    ok('the shell has the Open full document fallback and a frame to /file', /Open full document/.test(html) && /<iframe[^>]+\/file\?v=/.test(html));
    ok('the shell CSP is strict (script-src self, no unsafe-inline, frame-ancestors none, no sandbox needed)',
      /script-src 'self'/.test(res.headers['Content-Security-Policy']) && !/unsafe-inline/.test(res.headers['Content-Security-Policy']) && /frame-ancestors 'none'/.test(res.headers['Content-Security-Policy']));
    const rows = viewRows();
    ok('stage 1: exactly one view row was logged as FETCHED (not opened)', rows.length === 1 && W.docs[rows[0]].openedAt === null && W.docs[rows[0]].fetchedAt);
    const row = W.docs[rows[0]];
    ok('the row stores a device class only: no IP, no UA string', row.device === 'mobile' && row.os === 'iOS' && !JSON.stringify(row).includes('Mozilla') && !JSON.stringify(row).includes('203.0.113') && !('ip' in row) && !('userAgent' in row));
    ok('the row carries tenant ids from the token and a 180 day TTL', row.companyId === 'u1' && row.ownerUid === 'u1' && Math.abs(row.expireAt.toMillis() - (W.now + 180 * D)) < 5000);
    ok('a fetch never alerts Jo and never stamps lead.lastViewedAt', !notes().some((n) => n.type === 'estimate_viewed') && !W.docs['leads/lead-1'].lastViewedAt && W.pushes.length === 0);
    ok('the token counts it as a fetch, not an open', W.docs['report_share_tokens/' + m.token].fetchCount === 1 && !W.docs['report_share_tokens/' + m.token].openCount);
    file = mkRes();
    await SHARE.getSharedReport(mkReq({ path: '/report/' + m.token + '/file', headers: { cookie } }), file);
    await flush();
    ok('/file with the cookie streams the PDF, frameable by us only', file.statusCode === 200 && file.headers['Content-Type'] === 'application/pdf' && file.bytes().startsWith('%PDF')
      && file.headers['X-Frame-Options'] === 'SAMEORIGIN' && /frame-ancestors 'self'/.test(file.headers['Content-Security-Policy']) && file.headers['Cache-Control'] === 'no-store');
    const otherCookie = L.unlockCookie('', 'ZZZZZZZZZZZZZZZZZZZZZZZZ', 'some-key', Date.now()).split(';')[0];
    const forged = await fetchShell(m.token, { cookie: otherCookie });
    ok('a proof minted for another link does not unlock this one', /name="code"/.test(String(forged.body)));
  }
  {
    ON(); baseWorld();
    const m = (await mintSecure()).value;      // no password
    const res = await fetchShell(m.token);
    ok('no password: straight to the shell', res.statusCode === 200 && /Open full document/.test(String(res.body)) && viewRows().length === 1);
    const bot = await fetchShell(m.token, { 'user-agent': 'Mozilla/5.0 (compatible; Proofpoint-URLDefense bot)' });
    const botRow = W.docs[viewRows().filter((k) => W.docs[k].botSuspect)[0]];
    ok('a scanner is logged as a bot-suspect fetch and never as an open', bot.statusCode === 200 && !!botRow && botRow.openedAt === null && !notes().length);
    const res2 = mkRes();
    await SHARE.getSharedReport(mkReq({ method: 'GET', path: '/report/' + m.token + '/unlock' }), res2);
    ok('/unlock on a link with no password just redirects', res2.statusCode === 303);
  }
  {
    ON(); baseWorld();
    const m = (await mintSecure()).value;
    W.docs['report_share_tokens/' + m.token].expiresAt = Timestamp.fromMillis(Date.now() - 1000);
    const exp = await fetchShell(m.token);
    ok('expired -> "ask for a fresh one", nothing else, no write', exp.statusCode === 410 && /expired/.test(String(exp.body)) && !viewRows().length && !W.docs['report_share_tokens/' + m.token].fetchCount);
    const unk = await fetchShell('NOSUCHTOKENNOSUCHTOKEN1');
    ok('unknown -> invalid, no write', unk.statusCode === 404 && !viewRows().length);
    W.docs['report_share_tokens/' + m.token].expiresAt = Timestamp.fromMillis(Date.now() + D);
    W.docs['leads/lead-1'].userId = 'someone-else';
    const stolen = await fetchShell(m.token);
    ok('tenant: a lead re-created under another owner gets no view row and no page', stolen.statusCode === 404 && !viewRows().length);
  }

  // ═════════════════════════════════════════════════════════════════
  console.log('\nE. beacon: open, ping, reading now, isolation');
  // ═════════════════════════════════════════════════════════════════
  {
    ON(); baseWorld();
    const m = (await mintSecure()).value;
    const shell = await fetchShell(m.token);
    const vid = viewIdOf(shell);
    ok('the shell minted a 16 character view id', /^[a-z0-9]{16}$/.test(vid || ''));
    const T = 'report_share_tokens/' + m.token;
    W.now += 1000;
    let b = await beacon(m.token, vid, 'open', 3);
    ok('an open sent 1 s after the fetch is too early (scripted instant POST)', b.statusCode === 204 && !W.docs[T].openCount);
    W.now += 9000;
    b = await beacon(m.token, vid, 'open', 2);
    ok('2 visible seconds is not an open', !W.docs[T].openCount);
    const bot = await beacon(m.token, vid, 'open', 5, 'facebookexternalhit/1.1');
    ok('a preview-bot UA is ignored', !W.docs[T].openCount && bot.statusCode === 204);
    const bad = await beacon(m.token, 'NOTAVIEWID', 'open', 5);
    ok('a malformed view id is ignored (204)', bad.statusCode === 204 && !W.docs[T].openCount);
    b = await beacon(m.token, vid, 'open', 4);
    const t1 = W.docs[T];
    ok('stage 2: a real open sets openCount 1, firstOpenedAt, lastDevice', t1.openCount === 1 && !!t1.firstOpenedAt && t1.lastDevice === 'mobile' && t1.devices.mobile === 1);
    ok('…and the 24h reminder due time, exactly once', t1.followUpDueAtMs === W.now + 24 * H);
    ok('…lead.lastViewedAt/Via stamped, ONE estimate_viewed bell + one push naming the document', W.docs['leads/lead-1'].lastViewedVia === 'secure_link' && notes().filter((n) => n.type === 'estimate_viewed').length === 1
      && W.pushes.length === 1 && /Smith_Estimate\.pdf/.test(W.pushes[0].body));
    ok('…lead.docTrack updated for the chip', W.docs['leads/lead-1'].docTrack.openCount === 1 && !!W.docs['leads/lead-1'].docTrack.firstOpenedAt && W.docs['leads/lead-1'].docTrack.device === 'mobile');
    const due1 = t1.followUpDueAtMs;
    const dup = await beacon(m.token, vid, 'open', 6);
    ok('the same view cannot be opened twice', W.docs[T].openCount === 1 && dup.statusCode === 204);

    // time with the page open
    W.now += 15000;
    await beacon(m.token, vid, 'ping', 5);
    ok('a 5 s ping adds 5 s to the view, the token and the lead summary', W.docs['leads/lead-1/docViews/' + vid].readSeconds === 5 && W.docs[T].readSeconds === 5 && W.docs['leads/lead-1'].docTrack.readSeconds === 5);
    ok('…under 10 s total: no "reading now" yet', !W.docs['notifications/fv_u1_lead-1']);
    W.now += 15000;
    await beacon(m.token, vid, 'ping', 15);
    const fv = W.docs['notifications/fv_u1_lead-1'];
    ok('crossing 10 s fires ONE "viewing your estimate right now" bell + push (reusing fresh-view-logic)', !!fv && /viewing their estimate right now/.test(fv.message) && fv.type === 'estimate_viewed' && W.pushes.length === 2);
    W.now += 15000;
    await beacon(m.token, vid, 'ping', 15);
    ok('…the view is marked so it can alert only once', W.docs['leads/lead-1/docViews/' + vid].readingAlerted === true);
    ok('…a further ping in the same view does not alert again', W.pushes.length === 2 && W.docs['leads/lead-1/docViews/' + vid].readSeconds === 35);
    W.now += 5000;
    await beacon(m.token, vid, 'ping', 60);
    ok('a claimed 60 s after 5 s of wall clock is clamped to 10 s', W.docs['leads/lead-1/docViews/' + vid].readSeconds === 45);
    {
      W.now += 15000;
      const again = await PING.applyBeacon(DB, { token: m.token, viewId: vid, kind: 'ping', seconds: 15, ua: IPHONE, nowMs: W.now });
      ok('…and a later ping in that view reports no new "reading now"', again.ok === true && again.reading === false);
    }

    // a second visit 7 hours later, a fresh view
    W.now += 7 * H;
    const shell2 = await fetchShell(m.token, { 'user-agent': DESKTOP });
    const vid2 = viewIdOf(shell2);
    W.now += 10000;
    await beacon(m.token, vid2, 'open', 5, DESKTOP);
    ok('a second visit 7 h later counts (openCount 2), devices split, reminder time NOT moved', W.docs[T].openCount === 2 && W.docs[T].devices.desktop === 1 && W.docs[T].followUpDueAtMs === due1);
    ok('…and alerts again (6 h passed)', notes().filter((n) => n.type === 'estimate_viewed' && n.source === 'secure_link').length >= 2);
    W.now += 20000;
    await beacon(m.token, vid2, 'ping', 15, DESKTOP);
    await beacon(m.token, vid2, 'ping', 15, DESKTOP);
    ok('…"reading now" is on a 2 hour cooldown per lead, so a return 7 h later may alert (cooldown passed)', W.pushes.length >= 3);
  }
  {
    ON(); baseWorld();
    const m = (await mintSecure()).value;
    const v1 = viewIdOf(await fetchShell(m.token));
    const T = 'report_share_tokens/' + m.token;
    W.now += 10000;
    await beacon(m.token, v1, 'open', 4);
    W.now += 1 * H;                      // 1 h later: a second visit inside the 6 h alert window
    const v2 = viewIdOf(await fetchShell(m.token));
    const pushesBefore = W.pushes.length, bellsBefore = notes().filter((n) => n.type === 'estimate_viewed').length;
    W.now += 10000;
    await beacon(m.token, v2, 'open', 4);
    ok('a second open inside 6 h bumps the count but throttles the alert (no new bell, no new push)', W.docs[T].openCount === 2 && W.pushes.length === pushesBefore && notes().filter((n) => n.type === 'estimate_viewed').length === bellsBefore);
    // reading-now cooldown
    W.now += 15000; await beacon(m.token, v2, 'ping', 15);
    W.now += 15000; await beacon(m.token, v2, 'ping', 15);
    const afterFirst = W.pushes.length;
    const v3 = viewIdOf(await fetchShell(m.token));
    W.now += 10000; await beacon(m.token, v3, 'open', 4);
    W.now += 15000; await beacon(m.token, v3, 'ping', 15);
    W.now += 15000; await beacon(m.token, v3, 'ping', 15);
    ok('"reading now" within 2 h of the last one for this lead stays quiet', W.pushes.length === afterFirst, W.pushes.length + ' vs ' + afterFirst);
  }
  {
    // isolation: a view id from ANOTHER token / tenant is ignored
    ON(); baseWorld({
      'leads/lead-2': { userId: 'u2', companyId: 'u2', firstName: 'Other' },
      'leads/lead-2/documents/doc-9': { filename: 'x.pdf', type: 'application/pdf' },
    });
    const m1 = (await mintSecure()).value;
    const v1 = viewIdOf(await fetchShell(m1.token));
    // a second tenant's link, minted by hand
    const T2 = 'ABCDEFGHJKLMNPQRSTUV2345';
    W.docs['report_share_tokens/' + T2] = {
      kind: 'lead_document', purpose: 'secure_doc', status: 'active', ownerUid: 'u2', companyId: 'u2', leadId: 'lead-2', documentId: 'doc-9',
      expiresAt: Timestamp.fromMillis(Date.now() + D), storagePath: 'docs/u2/lead-2_1_x.pdf', docLabel: 'x.pdf', unlockKey: 'k2',
    };
    W.now += 10000;
    await beacon(T2, v1, 'open', 5);
    ok('tenant: a view id that belongs to another token is ignored (204, nothing written on either side)',
      !W.docs['report_share_tokens/' + T2].openCount && !W.docs['report_share_tokens/' + m1.token].openCount && !W.docs['leads/lead-2'].lastViewedAt && !W.docs['leads/lead-1'].lastViewedAt);
    // token's companyId disagrees with the view row
    W.docs['report_share_tokens/' + m1.token].companyId = 'u-other';
    await beacon(m1.token, v1, 'open', 5);
    ok('tenant: a token whose company differs from its view row writes nothing', !W.docs['report_share_tokens/' + m1.token].openCount && !W.docs['leads/lead-1'].lastViewedAt);
    W.docs['report_share_tokens/' + m1.token].companyId = 'u1';
    W.docs['leads/lead-1'].userId = 'intruder';
    await beacon(m1.token, v1, 'open', 5);
    ok('tenant: a lead now owned by someone else gets no open, no alert', !W.docs['report_share_tokens/' + m1.token].openCount && W.pushes.length === 0);
    W.docs['leads/lead-1'].userId = 'u1';
    // same lead, two secure links: a view of link A is no view of link B
    const mB = (await mintSecure()).value;
    const mA = (await mintSecure()).value;
    const vA = viewIdOf(await fetchShell(mA.token));
    W.now += 10000;
    await beacon(mB.token, vA, 'open', 5);
    ok('tenant: a view row of link A cannot be opened through link B (same lead, different token)', !W.docs['report_share_tokens/' + mB.token].openCount && !W.docs['report_share_tokens/' + mA.token].openCount);
    // revoked / expired token: beacon ignored
    W.docs['report_share_tokens/' + m1.token].status = 'revoked';
    await beacon(m1.token, v1, 'open', 5);
    ok('a revoked link\'s beacon is ignored', !W.docs['report_share_tokens/' + m1.token].openCount);
    W.docs['report_share_tokens/' + m1.token].status = 'active';
    // non-secure token
    const leg = (await call(SEND.createEstimateReviewLink, { leadId: 'lead-1', documentId: 'doc-1' }, OWNER)).value;
    await beacon(leg.token, v1, 'open', 5);
    ok('a legacy review token is not a beacon target', !W.docs['report_share_tokens/' + leg.token].openCount);
    // even with a view row that matches the legacy token in every other way
    W.docs['leads/lead-1/docViews/legacyviewabcde0'] = { tokenRef: leg.token.slice(0, 10), companyId: 'u1', ownerUid: 'u1', fetchedAt: Timestamp.fromMillis(W.now - 60000), openedAt: null, readSeconds: 0, botSuspect: false };
    await beacon(leg.token, 'legacyviewabcde0', 'open', 5);
    ok('…not even with a matching view row (secure_doc only)', !W.docs['report_share_tokens/' + leg.token].openCount && !W.docs['leads/lead-1/docViews/legacyviewabcde0'].openedAt);
    // GET, junk, unauthenticated
    const get = mkRes();
    await PING.handle(mkReq({ method: 'GET' }), get, { db: DB, now: () => W.now });
    ok('GET is 405', get.statusCode === 405);
    // per-view throttle
    W.rl = null;
    W.docs['report_share_tokens/' + m1.token].status = 'active';
    W.docs['report_share_tokens/' + m1.token].companyId = 'u1';
    W.docs['leads/lead-1'].userId = 'u1';
    const counts = {};
    W.rl = (ns, key, limit) => { const k = ns + key; counts[k] = (counts[k] || 0) + 1; return counts[k] <= limit; };
    await beacon(m1.token, v1, 'open', 5);
    for (let i = 0; i < 14; i++) { W.now += 1000; await beacon(m1.token, v1, 'ping', 1); }
    ok('the per-view ping limit (10 a minute) answers 204 and stops processing: 1 open + 9 pings counted, the rest ignored',
      W.docs['leads/lead-1/docViews/' + v1].readSeconds === 9, String(W.docs['leads/lead-1/docViews/' + v1].readSeconds));
    W.rl = null;
  }
  {
    // client tracker
    let vis = true; const sent = [];
    const t = VIEW.createTracker({ send: (o) => sent.push(o), visible: () => vis });
    for (let i = 0; i < 2; i++) t.tick();
    ok('client: no open before 3 visible seconds', sent.length === 0);
    t.tick();
    ok('client: exactly one open at the 3rd visible second', sent.length === 1 && sent[0].k === 'open');
    vis = false; for (let i = 0; i < 100; i++) t.tick();
    ok('client: hidden seconds never count', t.state().sinceFlush === 0 && sent.length === 1);
    vis = true; for (let i = 0; i < 15; i++) t.tick();
    ok('client: a ping every 15 visible seconds carrying exactly 15', sent.length === 2 && sent[1].k === 'ping' && sent[1].s === 15);
    for (let i = 0; i < 7; i++) t.tick();
    t.flush();
    ok('client: flush on hide/pagehide sends the remainder', sent.length === 3 && sent[2].s === 7);
    t.flush();
    ok('client: nothing to flush sends nothing', sent.length === 3);
    const early = VIEW.createTracker({ send: (o) => sent.push(o), visible: () => true });
    early.tick(); early.flush(); early.file();
    ok('client: flush/file before the open send nothing', sent.length === 3);
  }

  // ═════════════════════════════════════════════════════════════════
  console.log('\nF. 24h reminder sweep');
  // ═════════════════════════════════════════════════════════════════
  {
    ON(); baseWorld();
    const m = (await mintSecure()).value;
    const T = 'report_share_tokens/' + m.token;
    const v = viewIdOf(await fetchShell(m.token));
    W.now += 10000; await beacon(m.token, v, 'open', 4);
    W.now += 15000; await beacon(m.token, v, 'ping', 15);
    const t0 = W.now;
    const run = (nowMs, live) => SWEEP.runSweep({ db: DB, nowMs, live });
    let r = await run(t0 + 2 * H, true);
    ok('not due yet: nothing scanned', r.scanned === 0 && !Object.keys(W.docs).some((k) => k.startsWith('agent_inbox/')));
    const due = W.docs[T].followUpDueAtMs;
    r = await run(due + 1000, false);
    ok('gate OFF: dry run counts it and writes nothing', r.due === 1 && r.filed === 0 && !Object.keys(W.docs).some((k) => k.startsWith('agent_inbox/')) && W.docs[T].followUpDueAtMs === due);
    const before = W.pushes.length;
    for (let i = 0; i < 3; i++) await run(due + 1000 + i * 60000, true);
    const inbox = Object.keys(W.docs).filter((k) => k.startsWith('agent_inbox/'));
    ok('three live runs file exactly ONE inbox reminder', inbox.length === 1 && inbox[0] === 'agent_inbox/doclink_' + m.token.slice(0, 10) + '_fu');
    const item = W.docs[inbox[0]];
    ok('…a reminder for the owner\'s company, about the lead, status pending, kind reminder', item.kind === 'reminder' && item.status === 'pending' && item.companyId === 'u1' && item.leadId === 'lead-1' && item.botId === 'doc-tracker');
    ok('…that says nothing went to the customer and does not claim to know of a call', /Nothing was sent to the customer/.test(item.text) && /Sam Smith/.test(item.text));
    ok('…one bell for Jo; NO push, text or email, and nothing for the customer', notes().filter((n) => n.type === 'agent_inbox').length === 1 && W.pushes.length === before);
    ok('…the token is marked filed and the due time cleared', !!W.docs[T].followUpFiledAt && W.docs[T].followUpDueAtMs === null);
    // collision treated as already filed
    W.docs[T].followUpDueAtMs = due; delete W.docs[T].followUpFiledAt;
    r = await run(due + 5000, true);
    ok('a create() collision counts as already filed (no duplicate, no failure)', r.alreadyFiled === 1 && r.failed === 0);
  }
  {
    const cases = [
      ['stage moved on', (l) => { l.stage = 'contract_signed'; }],
      ['Jo already nudged after the first open', (l) => { l.lastEstimateNudgeAt = W.now + 2 * H; }],
      ['the customer wrote after the first open', (l) => { l.lastInboundAt = W.now + 2 * H; }],
    ];
    for (const [name, mutate] of cases) {
      ON(); baseWorld();
      const m = (await mintSecure()).value;
      const T = 'report_share_tokens/' + m.token;
      const v = viewIdOf(await fetchShell(m.token));
      W.now += 10000; await beacon(m.token, v, 'open', 4);
      const due = W.docs[T].followUpDueAtMs;
      mutate(W.docs['leads/lead-1']);
      await SWEEP.runSweep({ db: DB, nowMs: due + 1000, live: true });
      ok('skipped and cleared: ' + name, !Object.keys(W.docs).some((k) => k.startsWith('agent_inbox/')) && W.docs[T].followUpDueAtMs === null);
    }
    ON(); baseWorld();
    const m = (await mintSecure()).value;
    const T = 'report_share_tokens/' + m.token;
    const v = viewIdOf(await fetchShell(m.token));
    W.now += 10000; await beacon(m.token, v, 'open', 4);
    const due = W.docs[T].followUpDueAtMs;
    await call(SEND.revokeDocumentLink, { leadId: 'lead-1', token: m.token }, OWNER);
    await SWEEP.runSweep({ db: DB, nowMs: due + 1000, live: true });
    ok('skipped: the link was revoked', !Object.keys(W.docs).some((k) => k.startsWith('agent_inbox/')));
  }

  // ═════════════════════════════════════════════════════════════════
  console.log('\nG. static checks');
  // ═════════════════════════════════════════════════════════════════
  {
    const shell = L.shellHtml({ token: 'ABC', viewId: 'abcdefghijklmnop', docLabel: '<b>"x"</b>', notice: 'n' });
    const pw = L.passwordHtml({ token: 'ABC', wrong: true });
    for (const [name, h] of [['viewer shell', shell], ['password page', pw]]) {
      ok(name + ': no inline <script>, no on*= handler, no style= attribute, no <style>',
        !/<script(?![^>]*\bsrc=)/i.test(h) && !/\son[a-z]+\s*=/i.test(h) && !/\sstyle\s*=/i.test(h) && !/<style/i.test(h), h.slice(0, 200));
      ok(name + ': no third-party host, no <img> pixel', !/https?:\/\//i.test(h) && !/<img/i.test(h));
    }
    ok('the shell escapes the document name', !shell.includes('<b>"x"</b>') && shell.includes('&lt;b&gt;'));
    ok('the shell loads its script from our own /pro/js with defer', /<script src="\/pro\/js\/doc-link-view\.js" defer><\/script>/.test(shell));
    const js = fs.readFileSync(path.join(ROOT, 'docs/pro/js/doc-link-view.js'), 'utf8');
    ok('doc-link-view.js: no inline style, no document.cookie, no third-party URL, no Image() pixel', !/style\s*=/.test(js) && !/document\.cookie/.test(js) && !/https?:\/\//.test(js) && !/new Image/.test(js));
    const copyJs = fs.readFileSync(path.join(ROOT, 'docs/pro/js/doc-link-copy.js'), 'utf8');
    ok('doc-link-copy.js: no style attribute', !/\bstyle\s*=/.test(copyJs));
    ok('the files are real (css exists)', fs.existsSync(path.join(ROOT, 'docs/pro/css/doc-link-view.css')));
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    const rw = fb.hosting.rewrites.find((x) => x.source === '/api/doc-link-ping');
    ok('firebase.json: /api/doc-link-ping -> docLinkPing, and /report/** still covers /unlock and /file', rw && rw.function.functionId === 'docLinkPing' && fb.hosting.rewrites.some((x) => x.source === '/report/**'));
    const hdr = fb.hosting.headers.find((x) => x.source === '/report/*/file');
    ok('firebase.json: only /report/*/file is frameable by our own pages', hdr && hdr.headers.some((h) => h.key === 'X-Frame-Options' && h.value === 'SAMEORIGIN') && hdr.headers.some((h) => h.key === 'Cache-Control' && h.value === 'no-store'));
    const gates = require(fnPath('cron-gates.js')).CRON_GATES;
    const reg = require(fnPath('flags-registry.js')).FLAGS;
    ok('both flags are registered with polarity enabled (default OFF)', ['SECURE_DOC_LINK_ENABLED', 'DOC_LINK_FOLLOWUP_ENABLED'].every((n) => gates.some((g) => g.name === n && g.polarity === 'enabled') && reg.some((f) => f.name === n)));
    ok('the master switch is on (Jo go 2026-11-04) and no longer dark; the 24h reminder is still dark', reg.some((f) => f.name === 'SECURE_DOC_LINK_ENABLED' && !f.dark) && reg.some((f) => f.name === 'DOC_LINK_FOLLOWUP_ENABLED' && f.dark === true));
    const env = fs.readFileSync(path.join(FUNCTIONS, '.env.nobigdeal-pro'), 'utf8');
    ok('the master switch is on in the committed env file and the 24h reminder is NOT', /^SECURE_DOC_LINK_ENABLED\s*=\s*true\s*$/m.test(env) && !/^\s*DOC_LINK_FOLLOWUP_ENABLED\s*=\s*true/m.test(env));
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    ok('rules: docViews is never client-writable', /match \/docViews\/\{viewId\}[\s\S]{0,500}allow write: if false;/.test(rules));
    const idx = fs.readFileSync(path.join(FUNCTIONS, 'FUNCTIONS_INDEX.md'), 'utf8');
    ok('FUNCTIONS_INDEX lists the three new functions', ['revokeDocumentLink', 'docLinkPing', 'docLinkFollowupSweep'].every((n) => idx.includes('`' + n + '`')));
  }
  OFF();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
