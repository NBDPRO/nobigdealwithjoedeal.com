#!/usr/bin/env node
/**
 * Close the Quinn gate (roadmap step 8, 2026-11-25;
 * documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §2.6 / §3.1 / §3.5).
 * Quinn checked drafts AFTER they were already waiting in the owner's send
 * queue (11-22: 7 of 10 flagged drafts were already waiting), no bot could take
 * an item back, Grok's social drafts skipped her, and the social wording gate
 * only knew the two Kentucky claim rules. Joe decided: warn + one extra tap,
 * never block.
 *
 *   A. logic: Quinn state / label, the send gate, verify + withdraw decisions,
 *      the wider social wording gate (each banned phrase, clean text, tenancy)
 *   B. the real crmMcp handler + agentDraftAction over an in-memory Firestore:
 *      drafts stored quinn 'unchecked'; withdraw_item (own company, pending
 *      only, the filer or Quinn, audited); self-verification refused; the
 *      owner's send refused without confirmUnverified unless Quinn passed it
 *   C. the Agent inbox client: the "Not checked by Quinn" / "Quinn flagged"
 *      badge from the server check, one extra confirm before sending, and the
 *      confirm flag on the send
 *
 * The Firestore emulator run is tests/quinn-gate.integration.test.js.
 * Run: node tests/quinn-gate-2026-11-25.test.js (needs functions/node_modules)
 */
'use strict';
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const kit = require('./lib/src-kit');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── In-memory Firestore (the agent-drafts-2026-10-06 idiom) ──────────────
function fakeDb() {
  const docs = new Map();
  let auto = 0;
  const setDotted = (o, k, v) => { const parts = k.split('.'); let cur = o; for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = Object.assign({}, cur[parts[i]] || {}); cur = cur[parts[i]]; } cur[parts[parts.length - 1]] = v; };
  const snap = (p) => ({ id: p.split('/').pop(), ref: mk(p), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snap(p),
      set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : Object.assign({}, v)); },
      update: async (v) => {
        if (!docs.has(p)) { const e = new Error('NOT_FOUND ' + p); e.code = 5; throw e; }
        const cur = Object.assign({}, docs.get(p)); Object.keys(v).forEach((k) => setDotted(cur, k, v[k])); docs.set(p, cur);
      },
      collection: (n) => coll(p + '/' + n),
    };
  }
  const match = (d, f, op, v) => !!d && Object.prototype.hasOwnProperty.call(d, f) && (op === '==' ? d[f] === v : op === '>=' ? d[f] >= v : op === '<=' ? d[f] <= v : false);
  function query(cp, filters, lim) {
    return {
      where: (f, op, v) => query(cp, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(cp, filters, lim),
      limit: (n) => query(cp, filters, n),
      get: async () => {
        const depth = cp.split('/').length + 1;
        const rows = [...docs.keys()].filter((k) => k.startsWith(cp + '/') && k.split('/').length === depth
          && filters.every(([f, op, v]) => match(docs.get(k), f, op, v))).slice(0, lim || 1e9).map(snap);
        return { docs: rows, size: rows.length, empty: rows.length === 0, forEach: (fn) => rows.forEach(fn) };
      },
    };
  }
  function coll(cp) {
    const next = () => 'auto' + String(++auto).padStart(10, '0');
    return Object.assign(query(cp, [], null), {
      doc: (id) => mk(cp + '/' + (id || next())),
      add: async (v) => { const r = mk(cp + '/' + next()); await r.set(v); return r; },
    });
  }
  return { docs, doc: mk, collection: coll, collectionGroup: (n) => query('__group__' + n, [], null), runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
}
let DB = fakeDb();
const serverTimestamp = () => { const t = Date.now(); return { toMillis: () => t }; };
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: {} }) }) };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const KEYS = {};
['marcus', 'tucker', 'dana', 'quinn', 'cos'].forEach((b) => { KEYS[b] = 'nbdk_' + b + '_quinngate_' + '0'.repeat(24 - b.length); });
function seed() {
  DB = fakeDb();
  const S = (p, v) => DB.docs.set(p, v);
  Object.keys(KEYS).forEach((b) => S('agent_keys/' + sha(KEYS[b]), { botId: b, botName: L.BOTS[b].name, companyId: NBD, active: true, prefix: KEYS[b].slice(0, 9), createdBy: NBD }));
  S('leads/q1', { userId: NBD, companyId: NBD, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St', phone: '(513) 555-0147', email: 'maria@example.test', tcpaConsent: true, stage: 'contacted' });
  S('agent_inbox/foreign1', { companyId: 'coX', botId: 'marcus', bot: 'Marcus', kind: 'note', leadId: 'x', text: 'not yours', status: 'pending' });
}
async function tool(bot, name, args) {
  const req = { method: 'POST', headers: { authorization: 'Bearer ' + KEYS[bot] }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args || {} } }, get(h) { return this.headers[String(h).toLowerCase()]; } };
  const res = { body: null, set() { return this; }, status() { return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  await M.crmMcp(req, res);
  const r = res.body && res.body.result;
  if (!r) return { isError: true, text: JSON.stringify(res.body) };
  let json = null; try { json = JSON.parse(r.content[0].text); } catch (_) {}
  return { isError: r.isError === true, text: r.content[0].text, json };
}
const owner = { uid: NBD, token: { companyId: NBD, role: 'company_admin' } };
async function send(data) { try { return { r: await M.agentDraftAction.run({ auth: owner, data, rawRequest: {} }) }; } catch (e) { return { err: e }; } }
const item = (id) => DB.docs.get('agent_inbox/' + id);
const audits = () => [...DB.docs.entries()].filter(([k]) => /^agent_audit\//.test(k)).map(([, v]) => v);

(async () => {
  console.log('A. logic');
  ok('quinnState: missing → unchecked; legacy verified → passed; legacy flag (note, not verified) → flagged; the quinn field wins',
    L.quinnState({}) === 'unchecked' && L.quinnState({ verified: true }) === 'passed' && L.quinnState({ verified: false, quinnNote: 'price wrong' }) === 'flagged'
    && L.quinnState({ verified: true, quinn: { state: 'flagged', reason: 'x' } }) === 'flagged' && L.quinnState({ quinn: { state: 'bogus' } }) === 'unchecked');
  const bot = (o) => Object.assign({ kind: 'draft_text', botId: 'marcus', companyId: NBD }, o);
  ok('the send gate: unchecked or flagged → a reason; passed, or the owner confirmed → none',
    /Not checked by Quinn — confirm to send anyway/.test(L.sendGateProblem(bot({ quinn: { state: 'unchecked' } }), false) || '')
    && /Quinn flagged: says licensed — confirm to send anyway/.test(L.sendGateProblem(bot({ quinn: { state: 'flagged', reason: 'says licensed' } }), false) || '')
    && L.sendGateProblem(bot({ quinn: { state: 'passed' } }), false) === null
    && L.sendGateProblem(bot({ quinn: { state: 'flagged', reason: 'r' } }), true) === null);
  ok('a pre-gate draft of a house bot (no quinn field) is gated too; an owner-made draft (Storm Mode, Pixel, a company\'s own bot) is not',
    !!L.sendGateProblem(bot({}), false) && L.sendGateProblem({ kind: 'draft_text', botId: 'storm-mode' }, false) === null
    && L.sendGateProblem({ kind: 'draft_text', botId: 'follow_up' }, false) === null && L.sendGateProblem({ kind: 'draft_text', botId: 'pixel-world' }, false) === null);
  const V = L.verifyDecision;
  const pend = { companyId: NBD, status: 'pending', botId: 'marcus' };
  ok('verify: a bot cannot verify its own item', /own/i.test((V(pend, NBD, 'marcus', true, '') || {}).error || ''));
  ok('verify: another company\'s item is unknown, a decided one is refused', /unknown/.test(V(pend, 'coX', 'quinn', true, '').error || '') && /decided/.test(V(Object.assign({}, pend, { status: 'dismissed' }), NBD, 'quinn', true, '').error || ''));
  ok('verify: a flag needs the reason; pass → passed, flag → flagged with the reason',
    !!V(pend, NBD, 'quinn', false, '  ').error && V(pend, NBD, 'quinn', true, '').state === 'passed'
    && V(pend, NBD, 'quinn', false, 'says licensed').state === 'flagged' && V(pend, NBD, 'quinn', false, 'says licensed').reason === 'says licensed');
  const W = L.withdrawDecision;
  const filed = Object.assign({ keyId: 'abc123' }, pend);
  ok('withdraw: the filer may, Quinn (a checker) may, another bot may not', !W(filed, NBD, 'marcus', false, 'dup').error && !W(filed, NBD, 'quinn', true, 'wrong price').error && !!W(filed, NBD, 'tucker', false, 'dup').error);
  ok('withdraw: the checker reaches only a bot-filed item (keyId), never Storm Mode / a Storm report / the owner\'s own',
    !!W({ companyId: NBD, status: 'pending', botId: 'storm-mode' }, NBD, 'quinn', true, 'x').error && !!W({ companyId: NBD, status: 'pending', botId: 'storm-report' }, NBD, 'quinn', true, 'x').error);
  ok('the checker is the house bot only: a company\'s own bot given verify_item is not one, and cannot check a customer draft (it would lift the send warning)',
    L.isHouseChecker('quinn') && !L.isHouseChecker('c_abc') && !L.isHouseChecker('marcus')
    && /house fact checker/.test(V(bot({ status: 'pending', quinn: { state: 'unchecked' } }), NBD, 'c_abc', true, '').error || '')
    && V(Object.assign({ kind: 'note' }, pend), NBD, 'c_abc', true, '').state === 'passed');
  ok('withdraw: own company only, pending only, a reason required', /unknown/.test(W(pend, 'coX', 'marcus', false, 'x').error || '') && /decided/.test(W(Object.assign({}, pend, { status: 'sent_by_owner' }), NBD, 'marcus', false, 'x').error || '') && /reason/.test(W(pend, NBD, 'marcus', false, ' ').error || ''));
  ok('withdraw_item is a tool every filing house bot and Quinn have; personal bots do not', ['marcus', 'tucker', 'dana', 'priya', 'cos', 'frank', 'theo', 'quinn'].every((b) => L.botAllows(b, 'withdraw_item')) && !L.botAllows('coach', 'withdraw_item') && L.annotationsFor('withdraw_item').readOnlyHint === false);

  console.log('A2. the social wording gate');
  const SW = (t, nbd) => L.socialWordingProblem(t, nbd !== false);
  const BAD = {
    licensed: 'We are licensed and ready for storm season.',
    'lifetime warranty': 'Every roof comes with a lifetime warranty.',
    'limited lifetime': 'GAF shingles with a limited lifetime guarantee.',
    'lifetime workmanship': 'Lifetime workmanship on every job.',
    '$0 out of pocket': 'Storm damage? $0 out of pocket for most homeowners.',
    'no out-of-pocket': 'A new roof with no out-of-pocket cost.',
    'since 2019': 'Serving Cincinnati since 2019.',
    'founded in 2018': 'Founded in 2018 by a local roofer.',
    'Master Elite': 'A GAF Master Elite contractor near you.',
    'Golden Pledge': 'Ask about the Golden Pledge warranty.',
    '4.9 stars': '4.9 stars on Google from our neighbors.',
    '5-star rated': '5-star rated on Google.',
    'five-star': 'Over 80 five-star reviews.',
    'deductible (shared social rule)': 'We can help with your deductible.',
    'claim talk (shared social rule)': 'Free help with your hail claim process.',
    'claim promise (Kentucky)': 'We handle your insurance claim start to finish.',
  };
  // Look-alike spellings (review 2026-11-25): each one came back clean before the caption was normalized.
  Object.assign(BAD, {
    'lic<ZWSP>ensed': 'We are lic​ensed and insured.',
    'fullwidth licensed': 'We are ｌｉｃｅｎｓｅｄ roofers.',
    'emoji stars': 'Rated ⭐⭐⭐⭐⭐ on Google',
    'emoji stars + VS16': 'Rated ⭐️⭐️⭐️ on Google',
    '4.9 on Google': 'We are 4.9 on Google.',
    'a 5.0 rating': 'Proud of a 5.0 rating.',
    'life-time warranty': 'A life-time warranty on every roof.',
    'life time warranty': 'A life time warranty on every roof.',
    'warranty for life': 'Your roof is under warranty for life.',
    'Master-Elite': 'GAF Master-Elite contractor.',
    'MasterElite': 'A MasterElite crew.',
    '$0 out<NB hyphen>of<NB hyphen>pocket': 'Storm damage? $0 out‑of‑pocket.',
    'Since <ZWSP>2016': 'Since ​2016 in Cincinnati.',
    "since '09": "Roofing here since '09.",
    'insurance<NBSP>claim (Kentucky / social)': 'We handle your insurance claim.',
  });
  const misses = Object.keys(BAD).filter((k) => !SW(BAD[k]));
  ok('each banned phrase is refused with a reason (' + Object.keys(BAD).length + ' cases)', misses.length === 0, 'not caught: ' + misses.join(', '));
  ok('the "licensed" refusal says what to say instead', /fully insured/.test(SW(BAD.licensed) || ''));
  const CLEAN = ['Storm season tips from No Big Deal.', 'Fully insured, 7+ years on Cincinnati roofs.', 'GAF Certified and TAMKO Pro Gold.', 'Unlicensed contractors cost homeowners. Ask for proof of insurance.', 'Check your gutters before the leaves fall.', 'Read our reviews on Google.',
    'A roof built to last ⭐ Read our reviews on Google.', 'Friends for life, neighbors first.', 'Spring check‑ups are open.'];
  const falsePos = CLEAN.filter((t) => SW(t));
  ok('clean captions pass', falsePos.length === 0, falsePos.map((t) => t + ' → ' + SW(t)).join(' | '));
  ok('another company keeps its own credentials (licensed, a founding year) but never "$0 out of pocket" or a hard-coded rating',
    SW(BAD.licensed, false) === null && SW(BAD['since 2019'], false) === null && !!SW(BAD['$0 out of pocket'], false) && !!SW(BAD['4.9 stars'], false));

  console.log('B. the real handler');
  seed();
  let t = await tool('marcus', 'draft_email', { lead_id: 'q1', subject: 'Your gutter quote', body: 'Hi Maria, the quote is attached.', reason: 'follow-up', from: 'jd' });
  const em = t.json && t.json.item_id;
  ok('a bot draft is stored with quinn: unchecked', !t.isError && item(em).quinn && item(em).quinn.state === 'unchecked', t.text);
  t = await tool('dana', 'file_social_draft', { brand: 'nbd', platform: 'facebook', caption: 'Storm season tips from No Big Deal.', reason: 'Season' });
  const soc = t.json && t.json.item_id;
  ok('a social draft (Grok\'s path) lands unchecked too', !t.isError && item(soc).quinn.state === 'unchecked', t.text);
  t = await tool('dana', 'file_social_draft', { brand: 'nbd', platform: 'facebook', caption: 'Licensed and insured since 2019.', reason: 'Season' });
  ok('the wider social gate refuses through the handler', t.isError && /fully insured|founding|since/i.test(t.text), t.text);

  let r = await send({ action: 'sent', id: em, subject: 'Your gutter quote', body: 'Hi Maria, the quote is attached.' });
  ok('send without confirm while unchecked → failed-precondition "Not checked by Quinn", not sent', !!r.err && r.err.code === 'failed-precondition' && /Not checked by Quinn — confirm to send anyway/.test(r.err.message) && item(em).status === 'pending', r.err ? r.err.message : JSON.stringify(r.r));
  r = await send({ action: 'check', ids: [em, soc] });
  ok('the owner\'s check carries the Quinn label for each draft (social included)', r.r && r.r.results[em].quinn === 'Not checked by Quinn' && r.r.results[soc].ok === true && r.r.results[soc].quinn === 'Not checked by Quinn', JSON.stringify(r.r || r.err.message));

  t = await tool('quinn', 'file_report', { title: 'Weekly check', text: 'All drafts read.' });
  const qrep = t.json && t.json.item_id;
  t = await tool('quinn', 'verify_item', { item_id: qrep, ok: true });
  ok('self-verification is refused (Quinn cannot pass her own filing)', t.isError && /own/i.test(t.text) && item(qrep).verified === false && !item(qrep).quinn, t.text);
  t = await tool('quinn', 'verify_item', { item_id: em, ok: false });
  ok('a flag without a reason is refused', t.isError && /reason|note/i.test(t.text));
  t = await tool('quinn', 'verify_item', { item_id: em, ok: false, note: 'Quote is not attached.' });
  ok('Quinn flags it: quinn.state flagged with the reason (legacy fields kept)', !t.isError && item(em).quinn.state === 'flagged' && item(em).quinn.reason === 'Quote is not attached.' && item(em).verified === false && item(em).quinnNote === 'Quote is not attached.', t.text);
  ok('the check records which key made it, on the item itself', item(em).quinn.keyId === sha(KEYS.quinn).slice(0, 12) && item(em).quinn.botId === 'quinn', JSON.stringify(item(em).quinn));
  r = await send({ action: 'sent', id: em, subject: 'Your gutter quote', body: 'Hi Maria, the quote is attached.' });
  ok('send without confirm while flagged → "Quinn flagged: <reason>"', !!r.err && r.err.code === 'failed-precondition' && /Quinn flagged: Quote is not attached\./.test(r.err.message) && item(em).status === 'pending', r.err && r.err.message);
  r = await send({ action: 'sent', id: em, subject: 'Your gutter quote', body: 'Hi Maria, the quote is attached.', confirmUnverified: true });
  ok('…with confirmUnverified: sent, and the item records what Quinn said at send time', r.r && r.r.ok === true && item(em).status === 'sent_by_owner' && item(em).quinnAtSend === 'flagged', r.err ? r.err.message : JSON.stringify(item(em)));

  t = await tool('tucker', 'draft_email', { lead_id: 'q1', subject: 'Thanks', body: 'Hi Maria, thanks again.', reason: 'thanks', from: 'jd' });
  const em2 = t.json.item_id;
  await tool('quinn', 'verify_item', { item_id: em2, ok: true, note: 'Fine.' });
  ok('Quinn passes it', item(em2).quinn.state === 'passed' && item(em2).verified === true);
  r = await send({ action: 'sent', id: em2, subject: 'Thanks', body: 'Hi Maria, thanks again.' });
  ok('a passed draft sends with no extra confirm', r.r && r.r.ok === true && item(em2).status === 'sent_by_owner', r.err && r.err.message);

  t = await tool('marcus', 'file_note', { lead_id: 'q1', text: 'Maria asked about gutters.' });
  const note = t.json.item_id;
  t = await tool('tucker', 'withdraw_item', { item_id: note, reason: 'duplicate' });
  ok('withdraw: another bot cannot take back Marcus\'s item', t.isError && item(note).status === 'pending', t.text);
  t = await tool('marcus', 'withdraw_item', { item_id: 'foreign1', reason: 'mine?' });
  ok('withdraw: another company\'s item is unknown and untouched', t.isError && /unknown/.test(t.text) && item('foreign1').status === 'pending', t.text);
  t = await tool('marcus', 'withdraw_item', { item_id: note, reason: 'Filed twice by mistake.' });
  ok('withdraw: the filer takes it back — status withdrawn with the reason', !t.isError && item(note).status === 'withdrawn' && item(note).withdrawReason === 'Filed twice by mistake.' && item(note).withdrawnBy === L.BOTS.marcus.name, t.text);
  ok('withdraw: the key that withdrew it is on the item', item(note).withdrawnByKeyId === sha(KEYS.marcus).slice(0, 12) && item(note).withdrawnByBotId === 'marcus');
  ok('withdraw: audited with the item id',audits().some((a) => a.tool === 'withdraw_item' && a.ok === true && a.itemId === note && a.botId === 'marcus'));
  t = await tool('marcus', 'withdraw_item', { item_id: note, reason: 'again' });
  ok('withdraw: only a still-pending item', t.isError && /decided/.test(t.text), t.text);
  t = await tool('quinn', 'withdraw_item', { item_id: soc, reason: 'Mentions a price we do not quote.' });
  ok('withdraw: Quinn can take back another bot\'s waiting draft', !t.isError && item(soc).status === 'withdrawn', t.text);
  DB.docs.set('agent_inbox/storm1', { companyId: NBD, botId: 'storm-mode', bot: 'Storm Mode', kind: 'draft_text', leadId: 'q1', text: 'Checking in after the storm.', status: 'pending' });
  t = await tool('quinn', 'withdraw_item', { item_id: 'storm1', reason: 'not needed' });
  ok('withdraw: Quinn cannot take back the owner\'s Storm Mode draft (no bot filed it)', t.isError && item('storm1').status === 'pending', t.text);
  t = await tool('quinn', 'inbox_pending', {});
  ok('withdrawn items leave the pending list (the owner sees them like dismissed)', !t.isError && !t.json.items.some((i) => i.item_id === note || i.item_id === soc));
  const team = L.teamActivity([], [{ botId: 'marcus', status: 'withdrawn', createdAt: Date.now() }], Date.now(), 7).bots.find((b) => b.bot_id === 'marcus');
  ok('team_activity counts a withdrawn item as withdrawn, not waiting', team.withdrawn === 1 && team.waiting === 0, JSON.stringify(team));

  console.log('C. the Agent inbox client');
  const calls = [];
  let confirmAnswer = true;
  const confirms = [];
  const assigned = [], added = [];
  const sentFail = {};
  const ITEMS = [
    { id: 'u1', kind: 'draft_email', leadId: 'q1', bot: 'Marcus', botId: 'marcus', title: 'Quote', text: 'Hi', fromAddress: 'jd@example.test', status: 'pending', companyId: 'co1' },
    { id: 'p1', kind: 'draft_email', leadId: 'q1', bot: 'Tucker', botId: 'tucker', title: 'Thanks', text: 'Hi', fromAddress: 'jd@example.test', status: 'pending', companyId: 'co1' },
    { id: 't1', kind: 'draft_text', leadId: 'q1', bot: 'Marcus', botId: 'marcus', text: 'Hi Maria', status: 'pending', companyId: 'co1' },
    { id: 'm1', kind: 'draft_email', leadId: 'q1', bot: 'Marcus', botId: 'marcus', title: 'Gutters', text: 'Hi', fromAddress: 'jd@example.test', status: 'pending', companyId: 'co1' },
    { id: 's1', kind: 'social_draft', bot: 'Dana', botId: 'dana', title: 'Storm tips', text: 'Storm season tips.', brand: 'nbd', platform: 'facebook', status: 'pending', companyId: 'co1' },
    { id: 'r1', kind: 'draft_email', leadId: 'q1', bot: 'Tucker', botId: 'tucker', title: 'Hello', text: 'Hi', fromAddress: 'jd@example.test', status: 'pending', companyId: 'co1' },
  ];
  const to = { ok: true, to: 'maria@example.test', name: 'Maria' };
  const CHECK = { u1: Object.assign({ quinn: 'Quinn flagged: price is wrong' }, to), p1: Object.assign({ quinn: null }, to), t1: { ok: true, to: '+15135550147', name: 'Maria', quinn: 'Not checked by Quinn' },
    m1: Object.assign({ quinn: 'Not checked by Quinn' }, to), s1: { ok: true, quinn: 'Not checked by Quinn' }, r1: Object.assign({ quinn: null }, to) };
  let checkFails = false, checkHold = null;
  const inboxGlobals = () => ({
    location: { search: '', pathname: '/pro/dashboard.html', hash: '', assign(h) { assigned.push(h); } }, history: { replaceState() {} }, navigator: { userAgent: '' },
    _user: { uid: 'co1' }, _userClaims: {}, _leads: [{ id: 'q1', firstName: 'Maria' }], showToast() {},
    db: {}, collection: () => ({}), where: () => ({}), query: () => ({}), doc: () => ({}), serverTimestamp: () => 0,
    addDoc: async (_c, v) => { added.push(v); return { id: 'sp' + added.length }; }, updateDoc: async () => {},
    getDocs: async () => ({ empty: false, metadata: {}, docs: ITEMS.map((i) => ({ id: i.id, data: () => i })) }),
    _functions: {},
    _httpsCallable: (_f, name) => async (payload) => {
      calls.push({ name, payload });
      if (payload.action === 'check') { if (checkHold) await checkHold; if (checkFails) throw new Error('unavailable'); return { data: { results: CHECK } }; }
      if (sentFail[payload.id]) { const m = sentFail[payload.id]; delete sentFail[payload.id]; const e = new Error(m); e.code = 'functions/failed-precondition'; throw e; }
      return { data: { ok: true } };
    },
    nbdConfirm: async (m) => { confirms.push(m); return confirmAnswer; },
    setTimeout, Promise, JSON, Math, String, Object, Array, encodeURIComponent,
  });
  const loadInbox = async (noWait) => {
    const c = kit.loadInVm('docs/pro/js/agent-inbox.js', inboxGlobals(), { dom: true });
    Object.defineProperty(c.__dom.El.prototype, 'dataset', { configurable: true, get() { const o = {}; Object.keys(this.attrs).forEach((k) => { if (/^data-/.test(k)) o[k.slice(5).replace(/-([a-z])/g, (_, x) => x.toUpperCase())] = this.attrs[k]; }); return o; } });
    Object.defineProperty(c.__dom.El.prototype, 'value', { configurable: true, get() { return this.textContent; } });
    const opened = c.NBDAgentInbox.open();
    if (!noWait) await opened;
    return c;
  };
  const tick = () => new Promise((res) => setTimeout(res, 20));
  const ctx = await loadInbox();
  const dom = ctx.__dom;
  const row = (id) => ctx.document.getElementById('aiItem-' + id);
  ok('the check asked about every draft', calls.some((c) => c.name === 'agentDraftAction' && c.payload.action === 'check' && c.payload.ids.join() === 'u1,p1,t1,m1,s1,r1'), JSON.stringify(calls));
  ok('a flagged draft shows "Quinn flagged: <reason>"; a passed one shows no warning', row('u1') && /Quinn flagged: price is wrong/.test(row('u1').textContent) && row('p1') && !/Quinn flagged|Not checked by Quinn/.test(row('p1').textContent));
  const mark = (id) => ctx.document.querySelector('#aiItem-' + id + ' [data-ai-act="mailsent"]');
  confirmAnswer = false;
  kit.click(dom, mark('u1'));
  await new Promise((res) => setTimeout(res, 20));
  ok('tapping send on it asks ONE extra confirm naming why; saying no sends nothing', confirms.length === 1 && /Quinn flagged: price is wrong/.test(confirms[0]) && !calls.some((c) => c.payload.action === 'sent'), JSON.stringify(confirms));
  confirmAnswer = true;
  kit.click(dom, mark('u1'));
  await new Promise((res) => setTimeout(res, 20));
  const sentU = calls.find((c) => c.payload.action === 'sent' && c.payload.id === 'u1');
  ok('saying yes sends with confirmUnverified: true', confirms.length === 2 && !!sentU && sentU.payload.confirmUnverified === true, JSON.stringify(calls.map((c) => c.payload)));
  kit.click(dom, mark('p1'));
  await new Promise((res) => setTimeout(res, 20));
  const sentP = calls.find((c) => c.payload.action === 'sent' && c.payload.id === 'p1');
  ok('a draft Quinn passed sends with no extra confirm', confirms.length === 2 && !!sentP && !sentP.payload.confirmUnverified, JSON.stringify(calls.map((c) => c.payload)));

  const sel = (id, act) => ctx.document.querySelector('#aiItem-' + id + ' [data-ai-act="' + act + '"]');
  const sentOf = (id) => calls.filter((c) => c.payload.action === 'sent' && c.payload.id === id);
  // Text from my phone (draft_text): the confirm comes before the Messages app opens.
  confirmAnswer = false;
  let ev = kit.click(dom, sel('t1', 'text'));
  await tick();
  ok('text: the tap asks the Quinn confirm; on no, nothing is logged and Messages does not open', ev.defaultPrevented && confirms.length === 3 && /Not checked by Quinn/.test(confirms[2]) && sentOf('t1').length === 0 && assigned.length === 0, JSON.stringify({ confirms, assigned }));
  confirmAnswer = true;
  kit.click(dom, sel('t1', 'text'));
  await tick();
  ok('text: on yes, logged with confirmUnverified and Messages opens', confirms.length === 4 && sentOf('t1').length === 1 && sentOf('t1')[0].payload.confirmUnverified === true && assigned.length === 1 && /^sms:/.test(assigned[0]), JSON.stringify({ assigned, s: sentOf('t1') }));
  // Open in Mail (draft_email): the confirm comes BEFORE Mail opens, not at Mark sent afterwards.
  confirmAnswer = false;
  ev = kit.click(dom, sel('m1', 'mail'));
  await tick();
  ok('mail: Open in Mail asks the confirm first; on no, Mail does not open', ev.defaultPrevented && confirms.length === 5 && assigned.length === 1, JSON.stringify({ confirms, assigned }));
  confirmAnswer = true;
  kit.click(dom, sel('m1', 'mail'));
  await tick();
  ok('mail: on yes, Mail opens', confirms.length === 6 && assigned.length === 2 && /^mailto:/.test(assigned[1]), JSON.stringify(assigned));
  kit.click(dom, sel('m1', 'mailsent'));
  await tick();
  ok('mail: Mark sent afterwards does not ask again, and logs confirmUnverified', confirms.length === 6 && sentOf('m1').length === 1 && sentOf('m1')[0].payload.confirmUnverified === true, JSON.stringify(sentOf('m1')));
  // Send to Social Studio (social_draft).
  ok('social: the draft shows "Not checked by Quinn"', /Not checked by Quinn/.test(row('s1').textContent));
  confirmAnswer = false;
  kit.click(dom, sel('s1', 'social'));
  await tick();
  ok('social: the tap asks the confirm; on no, nothing reaches Social Studio', confirms.length === 7 && added.length === 0, JSON.stringify(added));
  confirmAnswer = true;
  kit.click(dom, sel('s1', 'social'));
  await tick();
  ok('social: on yes, it goes to Social Studio', confirms.length === 8 && added.length === 1, JSON.stringify(added));
  // Quinn's verdict changed after the inbox opened: the server refuses; the next tap asks.
  sentFail.r1 = 'Quinn flagged: wrong name — confirm to send anyway.';
  kit.click(dom, sel('r1', 'mailsent'));
  await tick();
  ok('stale: a draft that read as passed is refused by the server, with no confirm yet', confirms.length === 8 && sentOf('r1').length === 1 && !sentOf('r1')[0].payload.confirmUnverified);
  kit.click(dom, sel('r1', 'mailsent'));
  await tick();
  ok('stale: the next tap asks the confirm with the new reason, then sends with confirmUnverified', confirms.length === 9 && /^Quinn flagged: wrong name\. Send\?$/.test(confirms[8]) && sentOf('r1').length === 2 && sentOf('r1')[1].payload.confirmUnverified === true, JSON.stringify(confirms[8]));

  // The check never answered (offline / cold start): a social draft still asks.
  checkFails = true;
  const c2 = await loadInbox();
  const n0 = confirms.length, a0 = added.length;
  ok('check failed: the social draft shows "Not checked by Quinn"', /Not checked by Quinn/.test(c2.document.getElementById('aiItem-s1').textContent));
  confirmAnswer = false;
  kit.click(c2.__dom, c2.document.querySelector('#aiItem-s1 [data-ai-act="social"]'));
  await tick();
  ok('check failed: Send to Social Studio still asks the confirm (fails closed); on no, nothing is added', confirms.length === n0 + 1 && added.length === a0, JSON.stringify(confirms.slice(n0)));

  // The check has not answered yet: a tap on Send to Social Studio in that window still asks.
  checkFails = false;
  let release;
  checkHold = new Promise((res) => { release = res; });
  const c3 = await loadInbox(true);
  await tick();
  const n1 = confirms.length, b3 = c3.document.querySelector('#aiItem-s1 [data-ai-act="social"]');
  if (b3) kit.click(c3.__dom, b3);
  await tick();
  ok('check still running: Send to Social Studio asks the confirm; on no, nothing is added', !!b3 && confirms.length === n1 + 1 && /^Not checked by Quinn/.test(confirms[n1] || '') && added.length === a0, JSON.stringify(confirms.slice(n1)));
  release();
  checkHold = null;
  await tick();

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
