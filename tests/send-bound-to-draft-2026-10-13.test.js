/**
 * send-bound-to-draft-2026-10-13.test.js — security review of #2447 ("Docs to
 * review"): sendEmail now sends a DRAFT, not a caller's claim.
 *
 * Drives the REAL sendEmail handler (functions/email-functions.js) against
 * stubbed firebase modules at the module loader, with a fake Firestore that
 * has real transaction semantics (optimistic concurrency + retry, reads that
 * yield to the event loop) and a stub provider that honours concurrency, so
 * "two parallel sends -> ONE provider call" is observed, not assumed.
 *
 *   A. a draft send: recipient + kind come FROM THE DRAFT (a caller's
 *      to / kind are ignored), the rep's edits are applied and stored
 *   B. concurrency: two (and five) parallel sends -> exactly one provider
 *      call, one 200, the rest 409; the loser's edits never land
 *   C. server-side gates (commercial kind): unsubscribed, STOP, no postal
 *      address, unreadable register — each refuses BEFORE the claim, each
 *      with a positive control; transactional kinds still reach an
 *      unsubscribed address
 *   D. do-not-contact enforced server-side on BOTH paths (+ fail closed)
 *   E. text validation: placeholders, length, control/bidi stripping
 *   F. provider outcomes: definite refusal releases the claim; anything
 *      ambiguous keeps it ('check_provider') and is never retried
 *   G. tenant / role / draft-state refusals
 *   H. legacy path: a claimed transactional kind is honoured only with its
 *      record (caller table in documentation/projects/SEND-BOUND-TO-DRAFT-
 *      2026-10-13.md); every existing CRM caller shape still works
 *   I. the warranty tier comes from the SIGNED estimate, not lead.soldTier
 *
 * Run: node tests/send-bound-to-draft-2026-10-13.test.js  (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const sha = (e) => crypto.createHash('sha256').update(String(e).trim().toLowerCase()).digest('hex');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

// ── loader hook ─────────────────────────────────────────────────────────
let world = null;
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (world && Object.prototype.hasOwnProperty.call(world.stubs, request)) return world.stubs[request];
  return realLoad.apply(this, arguments);
};
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }

const DELETE = { __delete: true };
const tick = () => new Promise((r) => setImmediate(r));

/**
 * opts: docs, token, limited[], provider: async (msg, n, world) => response|throw,
 *       failWrite(path, data) -> true to throw on a write to that path,
 *       onLimit(mutate) runs between prepare and claim (a concurrent writer),
 *       docThrows(path) makes db.doc(path) throw synchronously,
 *       txCommitThrows(writes) makes a transaction commit throw
 */
function makeWorld(opts) {
  opts = opts || {};
  const docs = {};
  const versions = {};
  Object.keys(opts.docs || {}).forEach((p) => { docs[p] = JSON.parse(JSON.stringify(opts.docs[p])); versions[p] = 1; });
  const events = [];
  const sends = [];
  const adds = {};
  const logs = { error: [], warn: [], info: [] };
  const limited = new Set(opts.limited || []);
  const ver = (p) => versions[p] || 0;
  const snapOf = (p) => ({ exists: docs[p] != null, id: p.split('/').pop(), data: () => (docs[p] == null ? undefined : JSON.parse(JSON.stringify(docs[p]))) });
  function applyPatch(p, data, isSet) {
    if (opts.failWrite && opts.failWrite(p, data)) throw new Error('simulated write failure');
    const cur = isSet ? {} : (docs[p] || {});
    const next = Object.assign({}, cur);
    Object.keys(data).forEach((k) => { if (data[k] === DELETE) delete next[k]; else next[k] = data[k]; });
    docs[p] = next; versions[p] = ver(p) + 1;
  }
  // A concurrent writer's write: bypasses failWrite, bumps the version.
  function mutate(p, patch) {
    const next = Object.assign({}, docs[p] || {});
    Object.keys(patch).forEach((k) => { if (patch[k] === DELETE) delete next[k]; else next[k] = patch[k]; });
    docs[p] = next; versions[p] = ver(p) + 1;
  }
  function docRef(p) {
    if (opts.docThrows && opts.docThrows(p)) throw new Error('simulated db.doc failure');
    return {
      id: p.split('/').pop(), path: p,
      get: async () => {
        events.push('read:' + p);
        if (opts.readThrows && opts.readThrows(p)) throw new Error('simulated Firestore UNAVAILABLE');
        await tick();
        return snapOf(p);
      },
      // A write is a network round trip: a read-then-write that is not in a
      // transaction has a real window in which another caller gets in.
      set: async (data) => { await tick(); applyPatch(p, data, true); events.push('write:' + p); },
      update: async (data) => { await tick(); applyPatch(p, data, false); events.push('update:' + p); },
      collection: (n) => db.collection(p + '/' + n),
    };
  }
  const db = {
    doc: docRef,
    collection: (name) => ({
      add: async (row) => { (adds[name] = adds[name] || []).push(row); return { id: 'x' }; },
      doc: (id) => docRef(name + '/' + id),
      where: () => ({ get: async () => ({ docs: [] }), limit: () => ({ get: async () => ({ docs: [] }) }) }),
    }),
    // Optimistic concurrency, like Firestore: if anything read changed before
    // commit the function re-runs. Reads yield, so two callers interleave.
    runTransaction: async (fn) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        const reads = new Map();
        const writes = [];
        const tx = {
          get: async (ref) => { reads.set(ref.path, ver(ref.path)); await tick(); return snapOf(ref.path); },
          update: (ref, data) => writes.push([ref.path, data, false]),
          set: (ref, data) => writes.push([ref.path, data, true]),
        };
        const out = await fn(tx);
        let clean = true;
        reads.forEach((v, p) => { if (ver(p) !== v) clean = false; });
        if (!clean) continue;
        if (opts.txCommitThrows && opts.txCommitThrows(writes)) throw new Error('simulated commit failure');
        writes.forEach(([p, d, s]) => applyPatch(p, d, s));
        return out;
      }
      throw new Error('ABORTED: too much contention');
    },
  };
  let sendN = 0;
  class Resend {
    constructor() {
      this.emails = {
        send: async (msg) => {
          events.push('resend-send');
          sends.push(msg);
          const n = ++sendN;
          if (opts.provider) return opts.provider(msg, n, self);
          await tick(); await tick();
          return { data: { id: 're_' + n }, error: null };
        },
      };
    }
  }
  const limiter = {
    httpRateLimit: async (req, res, ns) => {
      events.push('limit:' + ns);
      if (opts.onLimit && ns === 'sendEmail:ip') opts.onLimit(mutate);
      if (limited.has(ns)) { res.status(429).json({ error: 'Too many requests' }); return false; }
      return true;
    },
    enforceRateLimit: async (ns) => {
      events.push('limit:' + ns);
      if (limited.has(ns)) { const e = new Error('rate_limited'); e.rateLimited = true; throw e; }
      return { count: 1 };
    },
    clientIp: () => '203.0.113.9', rateLimitIpKey: (ip) => ip,
  };
  const stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }), onCall: (o, h) => ({ __opts: o, __handler: h }), HttpsError },
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => { if (opts.secretThrows) throw new Error('no secret'); return 'secret-' + n; } }) },
    'firebase-functions/v2': { logger: { error: (...a) => logs.error.push(a), warn: (...a) => logs.warn.push(a), info: (...a) => logs.info.push(a) } },
    'firebase-admin/firestore': {
      getFirestore: () => db,
      FieldValue: { serverTimestamp: () => '__server_ts__', delete: () => DELETE },
      Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }), fromDate: (d) => ({ toMillis: () => d.getTime() }) },
    },
    'firebase-admin/auth': {
      getAuth: () => ({ verifyIdToken: async () => Object.assign({ uid: 'rep-a', companyId: 'co-a', role: 'company_admin', email_verified: true }, opts.token || {}) }),
    },
    resend: { Resend },
    './rate-limit': limiter,
    './integrations/upstash-ratelimit': limiter,
    './integrations/_shared': { secretOr: (s, d) => d },
    './integrations/heartbeat': { onSchedule: (o, h) => ({ __opts: o, __handler: h }) },
    './lead-bridge-logic': { isFollowUpEvent: () => false },
  };
  const self = { stubs, docs, events, sends, adds, logs, mutate };
  return self;
}

function load(opts) {
  world = makeWorld(opts);
  ['email-functions.js', 'email-suppression.js', 'resend-guard.js', 'doc-draft-send.js', 'email-send-guard.js', 'doc-drafts-logic.js']
    .forEach((f) => { delete require.cache[path.join(FUNCTIONS, f)]; });
  return { mod: require(path.join(FUNCTIONS, 'email-functions.js')), w: world };
}

function mkRes() {
  const r = { statusCode: 200, body: undefined, headersSent: false };
  r.set = () => r; r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.headersSent = true; return r; }; r.send = r.json;
  return r;
}
async function invoke(handler, body) {
  const res = mkRes();
  try { await handler({ method: 'POST', headers: { authorization: 'Bearer t' }, body }, res); } catch (e) { res.statusCode = 500; res.body = 'threw'; res.threw = e; }
  return res;
}

// ── fixtures ────────────────────────────────────────────────────────────
const HOMEOWNER = 'Pat.Homeowner@Example.com';
const POSTAL = 'PO Box 77, Goshen, OH 45122';
const LEAD = 'L1';
const DRAFT = 'ddraft_L1_warranty_j1';
const THANKS = 'ddraft_L1_thank_you_j1';
const RECEIPT = 'ddraft_L1_paid_receipt_j1';
const dPath = (id) => 'leads/' + LEAD + '/doc_drafts/' + (id || DRAFT);
const leadDoc = (o) => Object.assign({ userId: 'rep-a', companyId: 'co-a', name: 'Pat Homeowner', email: HOMEOWNER, stage: 'install_complete' }, o || {});
const draftDoc = (o) => Object.assign({
  status: 'draft', kind: 'warranty', label: 'Warranty summary', emailKind: 'document', event: 'installed',
  channel: 'email', to: HOMEOWNER, subject: 'Your warranty summary', body: 'Hi Pat,\n\nYour warranty is on file.\n\n— No Big Deal',
  leadId: LEAD, jobId: 'j1', companyId: 'co-a', userId: 'rep-a',
}, o || {});
const baseDocs = (extra) => Object.assign({
  ['leads/' + LEAD]: leadDoc(),
  [dPath(DRAFT)]: draftDoc(),
  [dPath(THANKS)]: draftDoc({ kind: 'thank_you', label: 'Thank-you', emailKind: '', subject: 'Thank you', body: 'Hi Pat,\n\nThank you. Review: https://example.test/r\n\n— NBD' }),
  [dPath(RECEIPT)]: draftDoc({ kind: 'paid_receipt', label: 'Paid-in-full receipt', emailKind: 'receipt', subject: 'Paid in full', body: 'Hi Pat,\n\nPaid in full: $1,000.00.' }),
  'companyProfile/co-a': { brand: { contact: { mailingAddress: POSTAL } } },
}, extra || {});
const SUPPRESSED = { ['email_suppressions/co-a__' + sha(HOMEOWNER)]: { companyId: 'co-a', emailHash: sha(HOMEOWNER), email: HOMEOWNER.toLowerCase(), source: 'link' } };

async function send(opts, body) {
  const { mod, w } = load(opts);
  const res = await invoke(mod.sendEmail.__handler, body);
  return { res, w, mod };
}
const draftBody = (id, extra) => Object.assign({ leadId: LEAD, draftId: id || DRAFT }, extra || {});
const st = (w, id) => (w.docs[dPath(id || DRAFT)] || {}).status;

// Every code point sendEmail's text cleaning must remove (kept independent of
// the source's regex so a narrowed regex is caught).
const STRIP_RANGES = [[0x0, 0x8], [0xB, 0xC], [0xE, 0x1F], [0x7F, 0x9F], [0x61C, 0x61C], [0x200B, 0x200F],
  [0x2028, 0x2029], [0x202A, 0x202E], [0x2060, 0x206F], [0xFEFF, 0xFEFF]];
const strippedCodePoints = () => { const out = []; STRIP_RANGES.forEach(([a, b]) => { for (let c = a; c <= b; c++) out.push(c); }); return out; };
function hasStripped(s) {
  const set = new Set(strippedCodePoints());
  for (const ch of String(s)) if (set.has(ch.codePointAt(0))) return true;
  return false;
}

(async () => {
  // ═══ A. a draft send ═════════════════════════════════════════════════
  console.log('A. a draft send: the draft is the authority');
  {
    const { res, w } = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'Edited subject', body: 'Hi Pat,\n\nEdited by the rep.' }));
    ok('200 success with the provider id', res.statusCode === 200 && res.body && res.body.success === true && res.body.id === 're_1', JSON.stringify(res.body));
    ok('exactly one provider call, to the DRAFT\'s address', w.sends.length === 1 && w.sends[0].to === HOMEOWNER);
    ok('the rep\'s edited subject + body are what went out', w.sends[0].subject === 'Edited subject' && /Edited by the rep/.test(w.sends[0].html));
    const d = w.docs[dPath()];
    ok('the SERVER wrote status sent + sentAt + messageId + sentBy, and cleared the claim state',
      d.status === 'sent' && d.sentAt === '__server_ts__' && d.messageId === 're_1' && d.sentBy === 'rep-a' && !('sendState' in d), JSON.stringify(d));
    ok('the edits are stored on the draft (what was sent is on the record)', d.subject === 'Edited subject' && /Edited by the rep/.test(d.body));
    ok('an email_log row names the draft and the kind it was sent as', (w.adds.email_log || []).some((r) => r.status === 'sent' && r.draftId === DRAFT && r.kind === 'document'), JSON.stringify(w.adds.email_log));
  }
  {
    // caller-supplied to / kind / html / replyTo are ignored in draft mode
    const { res, w } = await send({ docs: baseDocs(SUPPRESSED) }, draftBody(THANKS, { to: 'attacker@evil.test', kind: 'document', category: 'transactional', html: '<script>x</script>', replyTo: 'x@y.z' }));
    ok('a COMMERCIAL draft with a caller claiming kind:"document" is still gated as commercial (unsubscribed -> 403)',
      res.statusCode === 403 && res.body.code === 'unsubscribed' && w.sends.length === 0, JSON.stringify(res.body));
    ok('...and nothing was claimed (the draft is still a draft)', st(w, THANKS) === 'draft');
    const c = await send({ docs: baseDocs() }, draftBody(THANKS, { to: 'attacker@evil.test', kind: 'document', html: '<script>x</script>' }));
    ok('control: the same request on a clean address sends to the DRAFT\'s recipient only, never the caller\'s `to`',
      c.res.statusCode === 200 && c.w.sends.length === 1 && c.w.sends[0].to === HOMEOWNER && !/script/.test(c.w.sends[0].html), JSON.stringify(c.res.body));
    ok('control: that commercial send carries the unsubscribe footer + RFC 8058 headers',
      /Unsubscribe/.test(c.w.sends[0].html) && c.w.sends[0].headers && /List-Unsubscribe/.test(Object.keys(c.w.sends[0].headers).join()));
  }

  // ═══ B. concurrency ═══════════════════════════════════════════════════
  console.log('\nB. two tabs / two people');
  {
    const { mod, w } = load({ docs: baseDocs() });
    const h = mod.sendEmail.__handler;
    const [a, b] = await Promise.all([
      invoke(h, draftBody(DRAFT, { body: 'Hi Pat,\n\nVersion A from tab one.' })),
      invoke(h, draftBody(DRAFT, { body: 'Hi Pat,\n\nVersion B from tab two.' })),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    ok('two parallel sends -> ONE provider call', w.sends.length === 1, 'sends=' + w.sends.length);
    ok('...one 200 and one 409', codes[0] === 200 && codes[1] === 409, JSON.stringify([a.body, b.body]));
    const loser = a.statusCode === 409 ? a : b;
    ok('...the loser is told someone else already sent / is sending it', ['already_sent', 'already_sending'].indexOf(loser.body.code) !== -1, JSON.stringify(loser.body));
    ok('...the draft ends "sent", with the WINNER\'s text and nothing from the loser',
      st(w) === 'sent' && w.docs[dPath()].body === (a.statusCode === 200 ? 'Hi Pat,\n\nVersion A from tab one.' : 'Hi Pat,\n\nVersion B from tab two.'));
    ok('...and exactly one "sent" row in the email log', (w.adds.email_log || []).filter((r) => r.status === 'sent').length === 1);
  }
  {
    const { mod, w } = load({ docs: baseDocs() });
    const h = mod.sendEmail.__handler;
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => invoke(h, draftBody())));
    ok('five parallel sends -> ONE provider call, one 200, four 409', w.sends.length === 1 && rs.filter((r) => r.statusCode === 200).length === 1 && rs.filter((r) => r.statusCode === 409).length === 4,
      'sends=' + w.sends.length + ' ' + rs.map((r) => r.statusCode).join());
  }
  {
    const { mod, w } = load({ docs: baseDocs() });
    const h = mod.sendEmail.__handler;
    const first = await invoke(h, draftBody());
    const again = await invoke(h, draftBody());
    ok('control: a sequential second send is a 409 already_sent and does not call the provider', first.statusCode === 200 && again.statusCode === 409 && again.body.code === 'already_sent' && w.sends.length === 1);
  }

  // ═══ C. server-side gates (commercial) ════════════════════════════════
  console.log('\nC. unsubscribe / STOP / postal address, by the DRAFT\'s kind');
  {
    const r = await send({ docs: baseDocs(SUPPRESSED) }, draftBody(THANKS));
    ok('review ask to an unsubscribed address: 403 unsubscribed, no provider call, draft untouched',
      r.res.statusCode === 403 && r.res.body.code === 'unsubscribed' && r.w.sends.length === 0 && st(r.w, THANKS) === 'draft');
    ok('...and the refusal is logged as suppressed', (r.w.adds.email_log || []).some((x) => x.status === 'suppressed'));
    const w2 = await send({ docs: baseDocs(SUPPRESSED) }, draftBody(DRAFT));
    ok('control: a TRANSACTIONAL draft (warranty) still reaches that unsubscribed address', w2.res.statusCode === 200 && w2.w.sends.length === 1);
    const rc = await send({ docs: baseDocs(SUPPRESSED) }, draftBody(RECEIPT));
    ok('control: so does the paid receipt', rc.res.statusCode === 200 && rc.w.sends.length === 1);
  }
  {
    const r = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ smsOptedOut: true }) }) }, draftBody(THANKS));
    ok('review ask after the customer texted STOP: 403 stop_requested, nothing sent', r.res.statusCode === 403 && r.res.body.code === 'stop_requested' && r.w.sends.length === 0 && st(r.w, THANKS) === 'draft');
    const t = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ smsOptedOut: true }) }) }, draftBody(DRAFT));
    ok('control: a transactional draft is not blocked by STOP', t.res.statusCode === 200);
  }
  {
    const docs = baseDocs(); delete docs['companyProfile/co-a'];
    const r = await send({ docs }, draftBody(THANKS));
    ok('review ask with no company mailing address: 403 (CAN-SPAM), nothing sent, draft untouched',
      r.res.statusCode === 403 && r.res.body.code === 'no_postal_address' && r.w.sends.length === 0 && st(r.w, THANKS) === 'draft', JSON.stringify(r.res.body));
    const t = await send({ docs }, draftBody(DRAFT));
    ok('control: a transactional draft needs no postal address', t.res.statusCode === 200);
  }
  {
    const r = await send({ docs: baseDocs(), readThrows: (p) => /^email_suppressions\//.test(p) }, draftBody(THANKS));
    ok('review ask with the register unreadable: 503 suppression_unverified, nothing sent, draft untouched',
      r.res.statusCode === 503 && r.res.body.code === 'suppression_unverified' && r.w.sends.length === 0 && st(r.w, THANKS) === 'draft');
    const t = await send({ docs: baseDocs(), readThrows: (p) => /^email_suppressions\//.test(p) }, draftBody(DRAFT));
    ok('control: a transactional draft never reads the register, so an outage does not block it', t.res.statusCode === 200);
  }

  // ═══ D. do-not-contact ════════════════════════════════════════════════
  console.log('\nD. do-not-contact, server-side, both paths');
  for (const field of ['doNotContact', 'dnc']) {
    const r = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ [field]: true }) }) }, draftBody(DRAFT));
    ok('draft path: ' + field + ' -> 403 do_not_contact for EVERY kind (even a transactional warranty), nothing sent, not claimed',
      r.res.statusCode === 403 && r.res.body.code === 'do_not_contact' && r.w.sends.length === 0 && st(r.w) === 'draft');
  }
  {
    const r = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ doNotContact: true }) }) }, { to: HOMEOWNER, subject: 'S', body: 'b', leadId: LEAD, kind: 'invoice' });
    ok('legacy path: doNotContact -> 403 do_not_contact', r.res.statusCode === 403 && r.res.body.code === 'do_not_contact' && r.w.sends.length === 0, JSON.stringify(r.res.body));
    const c = await send({ docs: baseDocs() }, { to: HOMEOWNER, subject: 'S', body: 'b', leadId: LEAD, kind: 'document' });
    ok('control: the same legacy request without the flag sends', c.res.statusCode === 200 && c.w.sends.length === 1);
  }
  {
    // invoice-only send reaches the lead through invoice.leadId
    const docs = baseDocs({ 'leads/L1': leadDoc({ dnc: true }), 'invoices/inv1': { companyId: 'co-a', customerEmail: HOMEOWNER, leadId: LEAD } });
    const r = await send({ docs }, { to: HOMEOWNER, subject: 'Invoice', body: 'b', invoiceId: 'inv1', kind: 'invoice' });
    ok('legacy invoice-only send: the lead\'s do-not-contact is found through invoice.leadId', r.res.statusCode === 403 && r.res.body.code === 'do_not_contact');
    docs['leads/L1'] = leadDoc();
    const c = await send({ docs }, { to: HOMEOWNER, subject: 'Invoice', body: 'b', invoiceId: 'inv1', kind: 'invoice' });
    ok('control: invoice-only send with no flag goes', c.res.statusCode === 200);
    const f = await send({ docs: Object.assign({}, docs), readThrows: (p) => p === 'leads/L1' }, { to: HOMEOWNER, subject: 'Invoice', body: 'b', invoiceId: 'inv1', kind: 'invoice' });
    ok('FAIL CLOSED: the lead behind an invoice unreadable -> 503 record_unverified, nothing sent', f.res.statusCode === 503 && f.res.body.code === 'record_unverified' && f.w.sends.length === 0, JSON.stringify(f.res.body));
  }
  {
    const f = await send({ docs: baseDocs(), readThrows: (p) => p === 'leads/L1' }, draftBody(DRAFT));
    ok('FAIL CLOSED (draft path): the lead unreadable -> 503 record_unverified, nothing sent', f.res.statusCode === 503 && f.res.body.code === 'record_unverified' && f.w.sends.length === 0);
  }

  // ═══ E. text validation ═══════════════════════════════════════════════
  console.log('\nE. subject / body validation');
  {
    const r = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: 'Date: [[install date]]' }));
    ok('an unresolved [[placeholder]] in the body: 422, nothing sent, not claimed',
      r.res.statusCode === 422 && r.res.body.code === 'unresolved_placeholders' && r.w.sends.length === 0 && st(r.w) === 'draft', JSON.stringify(r.res.body));
    const s = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'Hi [[company name]]' }));
    ok('...and in the SUBJECT', s.res.statusCode === 422 && s.res.body.code === 'unresolved_placeholders');
    const c = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: 'Date: Tuesday, October 21' }));
    ok('control: the filled-in body sends', c.res.statusCode === 200);
    const stored = await send({ docs: baseDocs({ [dPath(DRAFT)]: draftDoc({ body: 'Date: [[install date]]' }) }) }, draftBody(DRAFT));
    ok('a STORED placeholder (no client edit) is refused too', stored.res.statusCode === 422 && stored.w.sends.length === 0);
  }
  {
    const bidi = '\u202Eevil\u202C \u200Bhidden\u0007 ok\u2066x\u2069';
    const r = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'Warranty' + bidi + '\nBcc: x@y.z', body: 'Hi\u0000 Pat,\r\n\r\nSafe' + bidi }));
    const m = r.w.sends[0] || {};
    ok('control/characters: sends', r.res.statusCode === 200 && r.w.sends.length === 1);
    ok('bidi overrides, zero-width marks and control chars are stripped from subject and body',
      !hasStripped(m.subject + m.html), JSON.stringify(m.subject));
    ok('a newline in the subject cannot become a header: collapsed to one line', !/\n|\r/.test(m.subject) && /Bcc: x@y\.z/.test(m.subject) === true && m.subject.indexOf('\n') === -1);
    const long = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'x'.repeat(301) }));
    ok('a 301-character subject is refused (422 invalid_text)', long.res.statusCode === 422 && long.res.body.code === 'invalid_text' && long.w.sends.length === 0);
    const edge = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'x'.repeat(300) }));
    ok('control: 300 characters is accepted', edge.res.statusCode === 200);
    const bigBody = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: 'y'.repeat(10001) }));
    ok('a 10,001-character body is refused', bigBody.res.statusCode === 422 && bigBody.w.sends.length === 0);
    const empty = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: ' \n\u200B ' }));
    ok('a body that is empty after stripping is refused', empty.res.statusCode === 422 && empty.res.body.code === 'invalid_text');
    const html = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: '<img src=x onerror=alert(1)> hi' }));
    ok('markup in the body is escaped (plain text only)', html.res.statusCode === 200 && /&lt;img/.test(html.w.sends[0].html) && !/<img/.test(html.w.sends[0].html));
  }

  // ═══ F. provider outcomes ═════════════════════════════════════════════
  console.log('\nF. provider outcomes: release only on a DEFINITE refusal');
  {
    // definite: 422 from the API -> released, can be sent again
    const { mod, w } = load({
      docs: baseDocs(),
      provider: async (m, n) => (n === 1 ? { data: null, error: { name: 'validation_error', message: 'invalid from', statusCode: 422 } } : { data: { id: 're_ok' }, error: null }),
    });
    const h = mod.sendEmail.__handler;
    const a = await invoke(h, draftBody());
    ok('a definite provider refusal (422): 502 provider_rejected', a.statusCode === 502 && a.body.code === 'provider_rejected', JSON.stringify(a.body));
    const d = w.docs[dPath()];
    ok('...the claim is RELEASED back to draft (nonce + claim fields gone, lastSendError kept)',
      d.status === 'draft' && !('sendNonce' in d) && !('sendState' in d) && d.lastSendError && d.lastSendError.code === 'provider_rejected', JSON.stringify(d));
    const b = await invoke(h, draftBody());
    ok('...and a retry sends (two provider calls in total, the second delivers)', b.statusCode === 200 && w.sends.length === 2 && st(w) === 'sent');
  }
  for (const [label, resp] of [
    ['the provider call throws (network / timeout)', { throws: true }],
    ['a 5xx from the provider', { data: null, error: { name: 'application_error', message: 'boom', statusCode: 503 } }],
    ['a 408 timeout from the provider', { data: null, error: { name: 'timeout', message: 'slow', statusCode: 408 } }],
    ['an error with no status code (SDK network failure)', { data: null, error: { name: 'application_error', message: 'Unable to fetch data', statusCode: null } }],
  ]) {
    const { mod, w } = load({ docs: baseDocs(), provider: async () => { if (resp.throws) throw new Error('ECONNRESET'); return resp; } });
    const h = mod.sendEmail.__handler;
    const a = await invoke(h, draftBody());
    const d = w.docs[dPath()];
    ok('AMBIGUOUS (' + label + '): 502 send_unconfirmed; the claim is KEPT as sending / check_provider',
      a.statusCode === 502 && a.body.code === 'send_unconfirmed' && d.status === 'sending' && d.sendState === 'check_provider' && !!d.sendNonce, JSON.stringify([a.body, d]));
    const b = await invoke(h, draftBody());
    ok('...and it is NOT retried: a second send is a 409 and the provider is not called again', b.statusCode === 409 && b.body.code === 'already_sending' && w.sends.length === 1);
    ok('...logged as unconfirmed, not as sent or failed', (w.adds.email_log || []).some((r) => r.status === 'unconfirmed') && !(w.adds.email_log || []).some((r) => r.status === 'sent' || r.status === 'failed'));
  }
  {
    // the provider ACCEPTED but our bookkeeping write failed
    const { res, w } = await send({ docs: baseDocs(), failWrite: (p, d) => p === dPath() && d.status === 'sent' }, draftBody());
    ok('provider accepted + the "sent" write failed: still a 200 success with bookkeeping "failed" — never "could not send"',
      res.statusCode === 200 && res.body.success === true && res.body.bookkeeping === 'failed' && w.sends.length === 1, JSON.stringify(res.body));
    ok('...and the draft stays claimed (sending), so it cannot be sent again', st(w) === 'sending');
  }
  {
    // the message build throws AFTER the claim: nothing was sent -> released
    const { mod, w } = load({ docs: baseDocs(), secretThrows: true });
    const h = mod.sendEmail.__handler;
    const a = await invoke(h, draftBody());
    ok('a failure BEFORE the provider call (build) releases the claim and sends nothing',
      a.statusCode === 500 && st(w) === 'draft' && w.sends.length === 0 && a.body && a.body.code === 'build_failed', JSON.stringify([a.statusCode, a.body, st(w)]));
  }
  {
    const limited = await send({ docs: baseDocs(), limited: ['sendEmail:ip'] }, draftBody());
    ok('a 429 happens BEFORE the claim: the draft is still a draft and nothing was sent', limited.res.statusCode === 429 && st(limited.w) === 'draft' && limited.w.sends.length === 0);
    const lim2 = await send({ docs: baseDocs(), limited: ['sendEmail:uid'] }, draftBody());
    ok('...same for the daily per-user limit', lim2.res.statusCode === 429 && st(lim2.w) === 'draft' && lim2.w.sends.length === 0);
  }

  // ═══ G. tenant / role / state ═════════════════════════════════════════
  console.log('\nG. who may send which draft, and in what state');
  {
    const other = await send({ docs: baseDocs(), token: { uid: 'bob', companyId: 'co-b', role: 'company_admin' } }, draftBody());
    ok('another tenant\'s company_admin: 403 record_forbidden, nothing sent', other.res.statusCode === 403 && other.res.body.code === 'record_forbidden' && other.w.sends.length === 0 && st(other.w) === 'draft');
    const rep = await send({ docs: baseDocs(), token: { uid: 'rep-z', companyId: 'co-a', role: 'sales_rep' } }, draftBody());
    ok('a sales_rep who does not own the lead: 403', rep.res.statusCode === 403 && rep.w.sends.length === 0);
    const own = await send({ docs: baseDocs(), token: { uid: 'rep-a', companyId: 'co-a', role: 'sales_rep' } }, draftBody());
    ok('control: the sales_rep who OWNS the lead sends', own.res.statusCode === 200 && own.w.sends.length === 1);
    const mgr = await send({ docs: baseDocs(), token: { uid: 'm1', companyId: 'co-a', role: 'manager' } }, draftBody());
    ok('control: a same-company manager sends', mgr.res.statusCode === 200);
    const viewer = await send({ docs: baseDocs(), token: { role: 'viewer' } }, draftBody());
    ok('a viewer: 403, nothing sent', viewer.res.statusCode === 403 && viewer.w.sends.length === 0);
    const unv = await send({ docs: baseDocs(), token: { email_verified: false } }, draftBody());
    ok('an unverified account: 403 email_unverified', unv.res.statusCode === 403 && unv.res.body.code === 'email_unverified' && unv.w.sends.length === 0);
  }
  {
    const cases = [
      ['already sent', draftDoc({ status: 'sent' }), 409, 'already_sent'],
      ['dismissed', draftDoc({ status: 'dismissed' }), 409, 'draft_not_sendable'],
      ['copied', draftDoc({ status: 'copied' }), 409, 'draft_not_sendable'],
      ['a failed marker', draftDoc({ status: 'failed', kind: 'failed' }), 409, 'draft_not_sendable'],
      ['sending', draftDoc({ status: 'sending', sendState: 'in_flight', sendNonce: 'n' }), 409, 'already_sending'],
    ];
    for (const [label, doc, code, why] of cases) {
      const r = await send({ docs: baseDocs({ [dPath()]: doc }) }, draftBody());
      ok('a draft that is "' + label + '": ' + code + ' ' + why + ', provider not called', r.res.statusCode === code && r.res.body.code === why && r.w.sends.length === 0, JSON.stringify(r.res.body));
    }
    const miss = await send({ docs: baseDocs() }, draftBody('ddraft_nope'));
    ok('a draft id that does not exist: 404', miss.res.statusCode === 404 && miss.res.body.code === 'draft_not_found');
    const bad = await send({ docs: baseDocs() }, { leadId: LEAD, draftId: '../leads/x' });
    ok('a malformed draft id: 400, nothing read as a path', bad.res.statusCode === 400 && bad.res.body.code === 'bad_draft_ref');
    const cross = await send({ docs: baseDocs({ [dPath()]: draftDoc({ leadId: 'OTHER' }) }) }, draftBody());
    ok('a draft whose leadId names another customer is refused', cross.res.statusCode === 403 && cross.w.sends.length === 0);
    const copyCh = await send({ docs: baseDocs({ [dPath()]: draftDoc({ channel: 'copy', to: '' }) }) }, draftBody());
    ok('a copy-channel draft (Thumbtack / no email) cannot be sent from the server either', copyCh.res.statusCode === 422 && copyCh.res.body.code === 'not_email_draft' && copyCh.w.sends.length === 0);
    const changed = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ email: 'new.address@example.com' }) }) }, draftBody());
    ok('the customer\'s email changed after drafting: 422 recipient_not_on_record, nothing sent', changed.res.statusCode === 422 && changed.res.body.code === 'recipient_not_on_record' && changed.w.sends.length === 0);
    const unk = await send({ docs: baseDocs({ [dPath()]: draftDoc({ kind: 'surprise_discount', emailKind: 'document' }) }) }, draftBody());
    ok('an unknown draft kind is refused (the kind table is the server\'s, not the stored copy)', unk.res.statusCode === 422 && unk.res.body.code === 'unknown_draft_kind');
    const forged = await send({ docs: baseDocs(Object.assign({}, SUPPRESSED, { [dPath(THANKS)]: draftDoc({ kind: 'thank_you', emailKind: 'document', label: 'x', subject: 'T', body: 'b' }) })) }, draftBody(THANKS));
    ok('a stored emailKind that disagrees with the kind table does not skip the gate (thank_you is commercial whatever the stored copy says)',
      forged.res.statusCode === 403 && forged.res.body.code === 'unsubscribed' && forged.w.sends.length === 0);
  }

  // ═══ H. legacy path ═══════════════════════════════════════════════════
  console.log('\nH. legacy path: a claimed transactional kind needs its record');
  {
    const inv = { 'invoices/inv1': { companyId: 'co-a', customerEmail: HOMEOWNER, leadId: LEAD } };
    const legacy = (extra, docs, kind, opts) => send(Object.assign({ docs: Object.assign(baseDocs(SUPPRESSED), inv, docs || {}) }, opts || {}),
      Object.assign({ to: HOMEOWNER, subject: 'S', body: 'b', leadId: LEAD, kind }, extra || {}));
    // every shape an existing CRM caller sends (caller table): to an UNSUBSCRIBED address,
    // transactional ones must still go and the commercial ones must not.
    const rows = [
      ['invoice-pipeline invoice  {leadId, invoiceId, kind:invoice}', { invoiceId: 'inv1' }, 'invoice', 200],
      ['invoice-pipeline receipt  {leadId, invoiceId, kind:receipt}', { invoiceId: 'inv1' }, 'receipt', 200],
      ['invoice-reminder          {leadId, invoiceId, kind:invoice}', { invoiceId: 'inv1' }, 'invoice', 200],
      ['close-board proposal      {leadId, kind:proposal}', {}, 'proposal', 200],
      ['email_system estimate     {leadId, kind:estimate}', {}, 'estimate', 200],
      ['email_system photoReport  {leadId, kind:document}', {}, 'document', 200],
      ['nbd-comms stage email     {leadId, kind:appointment}', {}, 'appointment', 200],
      ['portal-link-helpers       {leadId, kind:portal_link}', {}, 'portal_link', 200],
      ['smart-followup portal     {leadId, kind:portal_link}', {}, 'portal_link', 200],
      ['smart-followup follow-up  {leadId, no kind}', {}, undefined, 403],
      ['review-engine             {leadId, kind:review_request}', {}, 'review_request', 403],
      ['winback                   {leadId, kind:winback}', {}, 'winback', 403],
    ];
    for (const [label, extra, kind, want] of rows) {
      const r = await legacy(extra, null, kind);
      ok('caller ' + label + ' -> ' + want, r.res.statusCode === want, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
    }
    // demotions: the claimed kind's record is missing -> commercial
    const dem = [
      ['kind:invoice with a lead but NO invoiceId', { }, 'invoice'],
      ['kind:receipt with a lead but NO invoiceId', { }, 'receipt'],
      ['kind:invoice naming an invoice that does not exist', { invoiceId: 'nope' }, 'invoice'],
      ['kind:contract (no CRM caller sends it)', {}, 'contract'],
      ['kind:"Document" (case is not forgiven)', {}, 'Document'],
      ['kind:newsletter (unknown)', {}, 'newsletter'],
    ];
    for (const [label, extra, kind] of dem) {
      const r = await legacy(extra, null, kind);
      ok('DEMOTED to commercial: ' + label + ' -> 403 unsubscribed', r.res.statusCode === 403 && r.res.body.code === 'unsubscribed' && r.w.sends.length === 0, r.res.statusCode + ' ' + JSON.stringify(r.res.body));
    }
    const log = await legacy({}, null, 'contract');
    ok('the log row records what the caller CLAIMED and what it was treated as',
      (log.w.adds.email_log || []).some((x) => x.status === 'suppressed' && x.claimedKind === 'contract' && x.kind === 'commercial'), JSON.stringify(log.w.adds.email_log));
    const okRow = await legacy({ invoiceId: 'inv1' }, null, 'invoice', { docs: Object.assign(baseDocs(), inv) });
    ok('an honoured kind is logged as itself with no claimedKind', okRow.res.statusCode === 200 && (okRow.w.adds.email_log || []).some((x) => x.status === 'sent' && x.kind === 'invoice' && !x.claimedKind), JSON.stringify(okRow.w.adds.email_log));
  }
  {
    // pure table
    const G = require(path.join(FUNCTIONS, 'email-send-guard.js'));
    ok('honouredKind: invoice/receipt need an invoice; lead-only kinds need a record; others are ""',
      G.honouredKind('invoice', { invoice: {} }) === 'invoice' && G.honouredKind('invoice', { lead: {} }) === ''
      && G.honouredKind('receipt', { lead: {} }) === '' && G.honouredKind('document', { lead: {} }) === 'document'
      && G.honouredKind('document', {}) === '' && G.honouredKind('contract', { lead: {}, invoice: {} }) === ''
      && G.honouredKind(undefined, { lead: {} }) === '' && G.honouredKind({}, { lead: {} }) === '');
    ok('the allowlist keys are exactly the kinds a CRM caller sends today', JSON.stringify(Object.keys(G.LEGACY_KIND_NEEDS).sort()) === JSON.stringify(['appointment', 'document', 'estimate', 'invoice', 'portal_link', 'proposal', 'receipt']));
    const S = require(path.join(FUNCTIONS, 'email-suppression.js'));
    ok('...and every one of them is on the suppression module\'s transactional list (no drift)', Object.keys(G.LEGACY_KIND_NEEDS).every((k) => S.TRANSACTIONAL_KINDS.indexOf(k) !== -1));
    const DS = require(path.join(FUNCTIONS, 'doc-draft-send.js'));
    ok('cleanText: strips bidi/zero-width/control, keeps newlines in a body, flattens a subject',
      DS.cleanText('a\u202Eb\u200Bc\u0007d\ne', true) === 'abcd\ne' && DS.cleanText('a\u202Eb\nc', false) === 'ab c');
    ok('definiteProviderRefusal: 4xx (not 408) yes; 5xx / 408 / none / thrown-shape no',
      DS.definiteProviderRefusal({ error: { statusCode: 422 } }) && DS.definiteProviderRefusal({ error: { statusCode: 429 } })
      && !DS.definiteProviderRefusal({ error: { statusCode: 500 } }) && !DS.definiteProviderRefusal({ error: { statusCode: 408 } })
      && !DS.definiteProviderRefusal({ error: { message: 'x' } }) && !DS.definiteProviderRefusal({ data: {} }));
  }

  // ═══ I. the warranty tier is the SIGNED tier ══════════════════════════
  console.log('\nI. warranty years come from the signed estimate, not lead.soldTier');
  {
    const DDF = require(path.join(FUNCTIONS, 'doc-drafts.js'));
    const FV = { serverTimestamp: () => '__TS__' };
    const quiet = { info() {}, warn() {}, error() {} };
    function fakeDb(seed, opts) {
      const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
      const ref = (p) => ({
        path: p,
        collection: (c) => col(p + '/' + c),
        async get() {
          if (opts && opts.failEstimate && /^estimates\//.test(p)) throw new Error('simulated read failure');
          const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) };
        },
        async create(data) { if (store.has(p)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, JSON.parse(JSON.stringify(data))); },
      });
      const col = (c) => ({ doc: (id) => ref(c + '/' + id), where: () => ({ get: async () => ({ docs: [] }), limit: () => ({ get: async () => ({ docs: [] }) }) }) });
      return { store, collection: col, doc: ref };
    }
    const NBD = require(path.join(FUNCTIONS, 'doc-drafts-logic.js')).NBD_OWNER_UID;
    const lead = (o) => Object.assign({ userId: NBD, companyId: NBD, stage: 'install_complete', firstName: 'Pat', email: 'pat@x.test', activeJobId: 'j1', jobType: 'cash', primaryEstimateId: 'est1' }, o || {});
    const est = (o) => Object.assign({ userId: NBD, leadId: 'L1', selectedTier: 'better', tier: 'better', signedPrice: { fields: { selectedTier: 'better', tier: 'better', total: 14500 }, totalCents: 1450000, fingerprint: 'p1-x' } }, o || {});
    async function warrantyFor(leadO, estO, opts, noEst) {
      const seed = { 'leads/L1': lead(leadO), ['companyProfile/' + NBD]: { brand: { displayName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382' } } } };
      if (!noEst) seed['estimates/est1'] = estO === null ? undefined : est(estO);
      if (seed['estimates/est1'] === undefined) delete seed['estimates/est1'];
      const db = fakeDb(seed, opts);
      const out = await DDF.draftDocsForEvent(db, { leadId: 'L1', event: 'installed' }, { FieldValue: FV, logger: quiet, now: () => Date.parse('2026-10-13T15:00:00Z') });
      const d = db.store.get('leads/L1/doc_drafts/ddraft_L1_warranty_j1');
      return { out, body: d ? d.body : null };
    }
    const years = (b) => { const m = /labor\) warranty: (\d+) years?/.exec(b || ''); return m ? +m[1] : null; };
    const r1 = await warrantyFor({ soldTier: 'better' });
    ok('control: a signed estimate at "better" and soldTier "better" -> 10 years', years(r1.body) === 10, r1.body);
    const r2 = await warrantyFor({ soldTier: 'beyond', soldTierSource: 'manual' });
    ok('a rep sets soldTier "beyond" but the SIGNED estimate is "better": the draft says 10 (signed wins), never 20',
      years(r2.body) === 10 && !/20 years|HailGuard/.test(r2.body), r2.body);
    const r3 = await warrantyFor({ soldTier: 'best' }, null);
    ok('soldTier "best" with NO estimate on file: the placeholder, no years', years(r3.body) === null && /\[\[workmanship warranty term/.test(r3.body), r3.body);
    const r4 = await warrantyFor({ soldTier: 'best' }, { signedPrice: undefined });
    ok('an UNSIGNED estimate (no signedPrice) is no evidence: placeholder', years(r4.body) === null && /\[\[workmanship warranty term/.test(r4.body), r4.body);
    const r5 = await warrantyFor({ soldTier: 'best' }, { userId: 'someone-else' });
    ok('another user\'s estimate is no evidence: placeholder', years(r5.body) === null && /\[\[workmanship warranty term/.test(r5.body));
    const r6 = await warrantyFor({ soldTier: 'best' }, {}, { failEstimate: true });
    ok('estimate unreadable: the draft is STILL created, with the placeholder (fails to the safe side)', !!r6.body && years(r6.body) === null && /\[\[workmanship warranty term/.test(r6.body) && !r6.out.error, JSON.stringify(r6.out));
    const r7 = await warrantyFor({ soldTier: 'best' }, { deleted: true });
    ok('a deleted estimate is no evidence', years(r7.body) === null);
    const r8 = await warrantyFor({ soldTier: 'better', primaryEstimateId: undefined }, null, null, true);
    ok('no primaryEstimateId at all: placeholder (the rep reads the contract)', years(r8.body) === null && /\[\[workmanship warranty term/.test(r8.body));
    const r9 = await warrantyFor({ soldTier: 'better' }, { signedPrice: { fields: { selectedTier: 'zzz', tier: 'zzz' }, totalCents: 1 } });
    ok('a signed estimate with an unknown tier value: placeholder', years(r9.body) === null);
    const r10 = await warrantyFor({}, { signedPrice: { fields: { tier: 'good' }, totalCents: 1 }, selectedTier: undefined, tier: 'best' });
    ok('the SIGNED copy of the tier wins over a later edit to the estimate (signed "good", now "best") -> 5', years(r10.body) === 5, r10.body);
  }

  // ═══ J. review round 1 (silent-failure + security reviews) ════════════
  console.log('\nJ. review round 1');
  {
    // DNC mix: an invoice of ANOTHER lead must not ride through this lead's clean flag
    const docs = baseDocs({
      'leads/L2': leadDoc({ doNotContact: true, email: 'dnc.customer@example.com' }),
      'invoices/invB': { companyId: 'co-a', customerEmail: 'dnc.customer@example.com', leadId: 'L2' },
    });
    const r = await send({ docs }, { to: 'dnc.customer@example.com', subject: 'Invoice', body: 'b', leadId: LEAD, invoiceId: 'invB', kind: 'invoice' });
    ok('lead L1 (clean) + the invoice of DNC lead L2: 422 record_mismatch, nothing sent', r.res.statusCode === 422 && r.res.body.code === 'record_mismatch' && r.w.sends.length === 0, JSON.stringify(r.res.body));
    const c = await send({ docs: baseDocs({ 'invoices/invA': { companyId: 'co-a', customerEmail: HOMEOWNER, leadId: LEAD } }) }, { to: HOMEOWNER, subject: 'Invoice', body: 'b', leadId: LEAD, invoiceId: 'invA', kind: 'invoice' });
    ok('control: lead + ITS OWN invoice sends', c.res.statusCode === 200 && c.w.sends.length === 1, JSON.stringify(c.res.body));
    const legacyNoLead = await send({ docs: baseDocs({ 'invoices/invOld': { companyId: 'co-a', customerEmail: HOMEOWNER } }) }, { to: HOMEOWNER, subject: 'Invoice', body: 'b', leadId: LEAD, invoiceId: 'invOld', kind: 'invoice' });
    ok('control: a legacy invoice with no leadId is bound by the recipient check and still sends', legacyNoLead.res.statusCode === 200);
  }
  for (const [label, val, want] of [['string "true"', 'true', 403], ['string "Yes"', 'Yes', 403], ['number 1', 1, 403], ['string "false"', 'false', 200], ['number 0', 0, 200], ['absent', undefined, 200]]) {
    const lead = leadDoc(); if (val !== undefined) lead.doNotContact = val;
    const r = await send({ docs: baseDocs({ 'leads/L1': lead }) }, draftBody());
    ok('do-not-contact flag as ' + label + ' -> ' + want, r.res.statusCode === want, JSON.stringify(r.res.body));
  }
  {
    const G = require(path.join(FUNCTIONS, 'email-send-guard.js'));
    ok('flagOn: true / 1 / "true" / "YES" / " on " on; false / 0 / "false" / "no" / null / {} off',
      [true, 1, 'true', 'YES', ' on '].every((v) => G.flagOn(v)) && [false, 0, 'false', 'no', null, undefined, {}, []].every((v) => !G.flagOn(v)));
  }
  {
    // tenant: a caller whose company is not the lead's company
    const r = await send({ docs: baseDocs(), token: { uid: 'rep-a', companyId: 'co-b', role: 'company_admin' } }, draftBody(THANKS));
    ok('the lead\'s OWNER now acting under another company: 403 (not the wrong tenant\'s register)', r.res.statusCode === 403 && r.res.body.code === 'record_forbidden' && r.w.sends.length === 0, JSON.stringify(r.res.body));
    // platform admin: the LEAD's tenant register and postal address are used
    const sup = await send({ docs: baseDocs(SUPPRESSED), token: { uid: 'joe', role: 'admin', companyId: undefined } }, draftBody(THANKS));
    ok('platform admin sending a co-a thank-you: co-a\'s unsubscribe register applies (403 unsubscribed)', sup.res.statusCode === 403 && sup.res.body.code === 'unsubscribed' && sup.w.sends.length === 0, JSON.stringify(sup.res.body));
    const okAdmin = await send({ docs: baseDocs(), token: { uid: 'joe', role: 'admin', companyId: undefined } }, draftBody(THANKS));
    ok('control: ...and with a clean register it sends, footer carrying co-a\'s postal address',
      okAdmin.res.statusCode === 200 && okAdmin.w.sends.length === 1 && okAdmin.w.sends[0].html.indexOf('PO Box 77') !== -1, JSON.stringify(okAdmin.res.body));
    const noCo = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ companyId: undefined }), [dPath()]: draftDoc({ companyId: null }) }) }, draftBody());
    ok('control: a legacy lead + draft with no companyId still send for their owner', noCo.res.statusCode === 200);
    const ownerMismatch = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ companyId: undefined }), [dPath()]: draftDoc({ companyId: null, userId: 'someone-else' }) }) }, draftBody());
    ok('legacy lead with no companyId: a draft stamped for a DIFFERENT owner is refused', ownerMismatch.res.statusCode === 403 && ownerMismatch.w.sends.length === 0);
  }
  {
    // finalise failed: the email went; the marker must say so, not "check provider"
    const { res, w } = await send({ docs: baseDocs(), failWrite: (p, d) => p === dPath() && d.status === 'sent' }, draftBody());
    const d = w.docs[dPath()];
    ok('provider accepted + the sent write failed: the draft is marked sent_unrecorded with the message id (durable)',
      res.statusCode === 200 && d.status === 'sending' && d.sendState === 'sent_unrecorded' && d.messageId === 're_1', JSON.stringify(d));
    ok('...and the browser UI reads that as "WAS sent", not "may not have gone out"',
      require(path.join(ROOT, 'docs/pro/js/doc-drafts-ui.js')).sendingState(d, Date.now() + 3600 * 1000) === 'sent_unrecorded');
  }
  {
    const UI = require(path.join(ROOT, 'docs/pro/js/doc-drafts-ui.js'));
    const t0 = 1700000000000;
    ok('sendingState: fresh in_flight -> in_flight; same claim 6 min later -> check_provider; check_provider flag wins; non-sending -> ""',
      UI.sendingState({ status: 'sending', sendState: 'in_flight', sendingAt: { toMillis: () => t0 } }, t0 + 1000) === 'in_flight'
      && UI.sendingState({ status: 'sending', sendState: 'in_flight', sendingAt: { toMillis: () => t0 } }, t0 + 6 * 60 * 1000) === 'check_provider'
      && UI.sendingState({ status: 'sending', sendState: 'check_provider', sendingAt: { toMillis: () => t0 } }, t0 + 1000) === 'check_provider'
      && UI.sendingState({ status: 'draft' }, t0) === '' && UI.sendingState({ status: 'sent' }, t0) === ''
      && UI.sendingState({ status: 'sending', sendState: 'in_flight' }, t0) === 'check_provider');
    ok('isLostRace names every "not yours to send" code and nothing else',
      ['already_sent', 'already_sending', 'draft_not_sendable', 'draft_changed', 'draft_not_found'].every((c) => UI.isLostRace(c)) && !UI.isLostRace('provider_rejected') && !UI.isLostRace('unsubscribed') && !UI.isLostRace(undefined));
  }
  {
    // provider_rejected: no provider wording to the browser
    const { mod } = load({ docs: baseDocs(), provider: async () => ({ data: null, error: { name: 'validation_error', message: 'The sender domain secret-domain.test is not verified', statusCode: 422 } }) });
    const a = await invoke(mod.sendEmail.__handler, draftBody());
    ok('provider_rejected carries no provider detail to the browser', a.statusCode === 502 && a.body.code === 'provider_rejected' && !/secret-domain|detail/.test(JSON.stringify(a.body)), JSON.stringify(a.body));
  }
  {
    // the signed estimate must name THIS lead
    const DDF = require(path.join(FUNCTIONS, 'doc-drafts.js'));
    const NBD = require(path.join(FUNCTIONS, 'doc-drafts-logic.js')).NBD_OWNER_UID;
    const mk = (estO) => {
      const store = new Map(Object.entries({
        'leads/L1': { userId: NBD, companyId: NBD, stage: 'install_complete', firstName: 'Pat', email: 'pat@x.test', activeJobId: 'j1', jobType: 'cash', primaryEstimateId: 'est1', soldTier: 'best' },
        ['companyProfile/' + NBD]: { brand: { displayName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382' } } },
        'estimates/est1': Object.assign({ userId: NBD, companyId: NBD, leadId: 'L1', signedPrice: { fields: { selectedTier: 'better', tier: 'better' }, totalCents: 1 } }, estO),
      }));
      const ref = (p) => ({ path: p, collection: (c) => col(p + '/' + c),
        async get() { const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) }; },
        async create(data) { if (store.has(p)) { const e = new Error('x'); e.code = 6; throw e; } store.set(p, JSON.parse(JSON.stringify(data))); } });
      const col = (c) => ({ doc: (id) => ref(c + '/' + id), where: () => ({ get: async () => ({ docs: [] }), limit: () => ({ get: async () => ({ docs: [] }) }) }) });
      return { store, collection: col, doc: ref };
    };
    const run = async (estO) => {
      const db = mk(estO);
      await DDF.draftDocsForEvent(db, { leadId: 'L1', event: 'installed' }, { FieldValue: { serverTimestamp: () => 'ts' }, logger: { info() {}, warn() {}, error() {} }, now: () => 1 });
      const d = db.store.get('leads/L1/doc_drafts/ddraft_L1_warranty_j1');
      return d ? d.body : '';
    };
    const yrs = (b) => { const m = /labor\) warranty: (\d+) years?/.exec(b); return m ? +m[1] : null; };
    ok('control: a signed estimate that names L1 and the tenant -> its tier (better = 10)', yrs(await run({})) === 10);
    ok('an estimate that names ANOTHER lead is no evidence -> placeholder', yrs(await run({ leadId: 'L9' })) === null);
    ok('an estimate with NO leadId is no evidence -> placeholder', yrs(await run({ leadId: undefined })) === null);
    ok('a same-company estimate made by another user is still evidence (manager built it) -> 10', yrs(await run({ userId: 'manager-1' })) === 10);
    ok('an estimate with neither the lead\'s user nor company is no evidence -> placeholder', yrs(await run({ userId: 'x', companyId: 'y' })) === null);
  }

  // ═══ K. survivors from the vacuity audit (server) ═════════════════════
  console.log('\nK. vacuity-audit survivors: server');
  {
    // (3) the draft changes BETWEEN prepare and claim (a concurrent writer)
    const want = { sent: [409, 'already_sent'], sending: [409, 'already_sending'], dismissed: [409, 'draft_not_sendable'], copied: [409, 'draft_not_sendable'], failed: [409, 'draft_not_sendable'] };
    for (const status of Object.keys(want)) {
      const r = await send({ docs: baseDocs(), onLimit: (m) => m(dPath(), { status }) }, draftBody());
      ok('draft turns "' + status + '" between prepare and claim: ' + want[status].join(' ') + ', NO provider call',
        r.res.statusCode === want[status][0] && r.res.body.code === want[status][1] && r.w.sends.length === 0, JSON.stringify(r.res.body));
      ok('...and the claim did not overwrite it (still "' + status + '")', st(r.w) === status && !r.w.docs[dPath()].sendNonce);
    }
    const c = await send({ docs: baseDocs(), onLimit: (m) => m(dPath(), { note: 'unrelated field' }) }, draftBody());
    ok('control: an unrelated concurrent write to the draft does not stop the send', c.res.statusCode === 200 && c.w.sends.length === 1);
  }
  for (const [field, val] of [['to', 'other@example.com'], ['kind', 'paid_receipt'], ['channel', 'copy'], ['emailKind', 'receipt']]) {
    const r = await send({ docs: baseDocs(), onLimit: (m) => m(dPath(), { [field]: val }) }, draftBody());
    ok('draft ' + field + ' changes between prepare and claim: 409 draft_changed, NO provider call',
      r.res.statusCode === 409 && r.res.body.code === 'draft_changed' && r.w.sends.length === 0 && st(r.w) === 'draft', JSON.stringify(r.res.body));
  }
  {
    // (4)(5) the claim holder LOST the claim during the provider call
    const lostNonce = await send({ docs: baseDocs(), provider: async (m, n, w) => { w.mutate(dPath(), { sendNonce: 'someone-else' }); return { data: { id: 're_9' }, error: null }; } }, draftBody());
    const d = lostNonce.w.docs[dPath()];
    ok('claim lost (nonce changed): still reported as sent (the email went), bookkeeping "claim_lost"',
      lostNonce.res.statusCode === 200 && lostNonce.res.body.success === true && lostNonce.res.body.bookkeeping === 'claim_lost', JSON.stringify(lostNonce.res.body));
    ok('...and finalise wrote NOTHING over the other holder (no sent status / sentAt / messageId / marker)',
      d.status === 'sending' && d.sendNonce === 'someone-else' && !d.sentAt && !d.messageId && d.sendState === 'in_flight', JSON.stringify(d));
    const dismissed = await send({ docs: baseDocs(), provider: async (m, n, w) => { w.mutate(dPath(), { status: 'dismissed' }); return { data: { id: 're_9' }, error: null }; } }, draftBody());
    ok('draft dismissed while the provider call was running: finalise does not resurrect it as sent',
      dismissed.res.statusCode === 200 && dismissed.res.body.bookkeeping === 'claim_lost' && dismissed.w.docs[dPath()].status === 'dismissed' && !dismissed.w.docs[dPath()].messageId);
    const ctl = await send({ docs: baseDocs() }, draftBody());
    ok('control: with the claim intact, bookkeeping is "ok" and the draft is sent', ctl.res.body.bookkeeping === 'ok' && st(ctl.w) === 'sent');
  }
  {
    // (6) the claim transaction cannot commit
    const r = await send({ docs: baseDocs(), txCommitThrows: (writes) => writes.some((w) => w[0] === dPath() && w[1].status === 'sending') }, draftBody());
    ok('the claim cannot commit: 503 claim_failed, NO provider call, draft still a draft',
      r.res.statusCode === 503 && r.res.body.code === 'claim_failed' && r.w.sends.length === 0 && st(r.w) === 'draft', JSON.stringify(r.res.body));
  }
  {
    // (1) draft vs lead company, (10) malformed leadId, (9) empty subject
    const co = await send({ docs: baseDocs({ [dPath()]: draftDoc({ companyId: 'co-z' }) }) }, draftBody());
    ok('draft.companyId != lead.companyId: 403 record_forbidden, nothing sent', co.res.statusCode === 403 && co.res.body.code === 'record_forbidden' && co.w.sends.length === 0);
    for (const bad of ['bad/id', '', 123, null, 'a'.repeat(129), '../leads/x']) {
      const r = await send({ docs: baseDocs() }, { leadId: bad, draftId: DRAFT });
      ok('malformed leadId ' + JSON.stringify(bad) + ': 400 bad_draft_ref, nothing sent', r.res.statusCode === 400 && r.res.body.code === 'bad_draft_ref' && r.w.sends.length === 0, JSON.stringify(r.res.body));
    }
    const noSubject = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: '   ' }));
    ok('an empty (whitespace) subject: 422 invalid_text, nothing sent', noSubject.res.statusCode === 422 && noSubject.res.body.code === 'invalid_text' && noSubject.w.sends.length === 0);
    const storedEmpty = await send({ docs: baseDocs({ [dPath()]: draftDoc({ subject: '' }) }) }, draftBody());
    ok('a stored empty subject with no client edit is refused too', storedEmpty.res.statusCode === 422 && storedEmpty.w.sends.length === 0);
    const nonString = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 42, body: { a: 1 } }));
    ok('non-string subject/body from the client fall back to the stored text and still send', nonString.res.statusCode === 200 && nonString.w.sends[0].subject === 'Your warranty summary');
  }
  {
    // (11)(12)(13) log rows + the message that went out
    const profile = { brand: { displayName: 'Oaks Roofing', contact: { mailingAddress: POSTAL, email: 'office@oaks.example.test', phone: '(555) 010-0101' } } };
    const c = await send({ docs: baseDocs({ 'companyProfile/co-a': profile }) }, draftBody(THANKS));
    const m = c.w.sends[0];
    ok('commercial send: message from carries the tenant brand, reply_to the business email, to the draft address',
      c.res.statusCode === 200 && /Oaks Roofing/.test(m.from) && m.reply_to === 'office@oaks.example.test' && m.to === HOMEOWNER, JSON.stringify({ from: m.from, reply_to: m.reply_to, to: m.to }));
    ok('commercial send: unsubscribe tag + List-Unsubscribe headers + postal address footer',
      Array.isArray(m.tags) && m.tags.some((t) => t.name === 'nbd_unsub' && /^[A-Za-z0-9_-]{43}$/.test(t.value))
      && m.headers && /List-Unsubscribe/.test(Object.keys(m.headers).join()) && /PO Box 77/.test(m.html));
    const row = (c.w.adds.email_log || []).find((r) => r.status === 'sent');
    ok('commercial send: the log row carries leadId, companyId, uid, to, subject, draftId, kind "commercial", category "commercial"',
      !!row && row.leadId === LEAD && row.companyId === 'co-a' && row.uid === 'rep-a' && row.to === HOMEOWNER && row.subject === 'Thank you'
      && row.draftId === THANKS && row.kind === 'commercial' && row.category === 'commercial', JSON.stringify(row));
    const t = await send({ docs: baseDocs({ 'companyProfile/co-a': profile }) }, draftBody(DRAFT));
    const tm = t.w.sends[0];
    ok('transactional send: no tags, no List-Unsubscribe headers, no footer',
      t.res.statusCode === 200 && !tm.tags && !tm.headers && !/Unsubscribe/.test(tm.html));
    const trow = (t.w.adds.email_log || []).find((r) => r.status === 'sent');
    ok('transactional send: log row kind "document", category "transactional", companyId + leadId set',
      !!trow && trow.kind === 'document' && trow.category === 'transactional' && trow.companyId === 'co-a' && trow.leadId === LEAD, JSON.stringify(trow));
    const docs = baseDocs(); delete docs['companyProfile/co-a'];
    const np = await send({ docs }, draftBody(THANKS));
    const nrow = (np.w.adds.email_log || []).find((r) => r.status === 'blocked_no_postal_address');
    ok('no postal address: a blocked_no_postal_address log row with to, subject, draftId, leadId, companyId',
      !!nrow && nrow.to === HOMEOWNER && nrow.subject === 'Thank you' && nrow.draftId === THANKS && nrow.leadId === LEAD && nrow.companyId === 'co-a', JSON.stringify(nrow));
    const sup = await send({ docs: baseDocs(SUPPRESSED) }, draftBody(THANKS));
    const srow = (sup.w.adds.email_log || []).find((r) => r.status === 'suppressed');
    ok('unsubscribed: a suppressed log row carries to, draftId, leadId', !!srow && srow.to === HOMEOWNER && srow.draftId === THANKS && srow.leadId === LEAD);
    const fail = await send({ docs: baseDocs(), provider: async () => ({ data: null, error: { statusCode: 422, message: 'no' } }) }, draftBody());
    const frow = (fail.w.adds.email_log || []).find((r) => r.status === 'failed');
    ok('definite provider refusal: a failed log row names the draft and kind', !!frow && frow.draftId === DRAFT && frow.kind === 'document');
  }
  {
    // (14) an unexpected throw in the draft branch
    const r = await send({ docs: baseDocs(), docThrows: (p) => p === 'leads/' + LEAD }, draftBody());
    ok('an unexpected throw while preparing: 500 draft_send_error (never a hang, never a send)',
      r.res.statusCode === 500 && r.res.body && r.res.body.code === 'draft_send_error' && r.w.sends.length === 0, JSON.stringify([r.res.statusCode, r.res.body]));
    const ctl = await send({ docs: baseDocs(), docThrows: (p) => p === 'leads/OTHER' }, draftBody());
    ok('control: a doc() failure on an unrelated path does not stop the send', ctl.res.statusCode === 200);
  }
  {
    // (15)(17) honouredKind + DNC booleans / strings
    const G = require(path.join(FUNCTIONS, 'email-send-guard.js'));
    ok('lead-only kinds with ONLY an invoice are demoted (estimate, proposal, portal_link, document, appointment); with a lead they are honoured',
      ['estimate', 'proposal', 'portal_link', 'document', 'appointment'].every((k) => G.honouredKind(k, { invoice: {} }) === '' && G.honouredKind(k, { lead: {} }) === k));
    for (const [label, v, blocked] of [['boolean true', true, true], ['boolean false', false, false], ['string "true"', 'true', true], ['string "false"', 'false', false]]) {
      for (const field of ['doNotContact', 'dnc']) {
        const r = await send({ docs: baseDocs({ 'leads/L1': leadDoc({ [field]: v }) }) }, draftBody());
        ok(field + ' = ' + label + (blocked ? ' blocks (403 do_not_contact)' : ' does not block (sends)'),
          blocked ? (r.res.statusCode === 403 && r.res.body.code === 'do_not_contact' && r.w.sends.length === 0) : (r.res.statusCode === 200 && r.w.sends.length === 1), JSON.stringify(r.res.body));
      }
    }
  }
  {
    // (7)(8) text cleaning, every stripped code point
    const DS = require(path.join(FUNCTIONS, 'doc-draft-send.js'));
    const all = strippedCodePoints();
    const survivors = all.filter((cp) => DS.cleanText('a' + String.fromCodePoint(cp) + 'b', true) !== 'ab' && !(cp === 0xA || cp === 0x9 || cp === 0xD));
    ok('cleanText removes every one of the ' + all.length + ' listed control / bidi / zero-width / separator code points (body mode)',
      survivors.length === 0, 'survivors: ' + survivors.map((c) => c.toString(16)).join(','));
    const subjSurvivors = all.filter((cp) => DS.cleanText('a' + String.fromCodePoint(cp) + 'b', false) !== 'ab');
    ok('...and in subject mode', subjSurvivors.length === 0, 'survivors: ' + subjSurvivors.map((c) => c.toString(16)).join(','));
    ok('CRLF and lone CR become LF; tab becomes a space; newlines survive in a body; a subject is one line',
      DS.cleanText('a\r\nb\rc\td', true) === 'a\nb\nc d' && DS.cleanText('x\ny', true) === 'x\ny' && DS.cleanText('a\n\n b', false) === 'a b');
    ok('control: ordinary text, accents, emoji and a normal space are untouched',
      DS.cleanText('Café — 5% off 👍', true) === 'Café — 5% off 👍');
    ok('boundaries: U+0009/000A/000D are not "stripped" as bytes (tab -> space, LF kept), U+0020 and U+00A0 kept, U+00A0 is not in the strip set',
      DS.cleanText('a b', true) === 'a b' && DS.cleanText('a b', true) === 'a b' && DS.cleanText('a\u0080b', true) === 'ab' && DS.cleanText('a\u009Fb', true) === 'ab' && DS.cleanText('a b', true).length === 3);
    // end to end for the ones most likely to be narrowed: separators + BOM + ALM + isolates
    const bad = '\u2028\u2029\uFEFF\u061C\u2066\u2067\u2068\u2069\u007F\u0085\u000B\u000C\u001F';
    const r = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'Hi' + bad + 'there', body: 'Dear' + bad + 'Pat' }));
    ok('end to end: none of them reaches the provider message', r.res.statusCode === 200 && !hasStripped(r.w.sends[0].subject + r.w.sends[0].html) && r.w.sends[0].subject === 'Hithere');
  }

  // ═══ L. warranty text + estimate evidence edge cases ═══════════════════
  console.log('\nL. vacuity-audit survivors: tier text and signed-tier evidence');
  {
    const DL = require(path.join(FUNCTIONS, 'doc-drafts-logic.js'));
    const nbd = DL.brandOf({ brand: { displayName: 'NBD', contact: { phone: '1' } } }, DL.NBD_OWNER_UID);
    for (const evil of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'prototype']) {
      ok('trustedTier("' + evil + '") is "" (no prototype key reaches the text)', DL.trustedTier(evil) === '');
      const body = DL.build('warranty', { lead: {}, brand: nbd, tier: evil }).body;
      ok('build(warranty, tier "' + evil + '") has no function text and uses the placeholder',
        !/native code|function|undefined|\[object/.test(body) && /\[\[workmanship warranty term/.test(body) && !/Your package/.test(body), body.slice(0, 200));
    }
    ok('control: a real tier still states its years', /labor\) warranty: 10 years/.test(DL.build('warranty', { lead: {}, brand: nbd, tier: 'better' }).body) && DL.trustedTier('Better') === 'better');
    const dec = DL.decide({ leadId: 'L1', event: 'installed', kind: 'warranty', lead: { userId: 'u', companyId: 'u', email: 'a@b.co', stage: 'install_complete', soldTier: 'best' }, profile: null, tenantKey: DL.NBD_OWNER_UID, jobId: 'j', signedTier: 'constructor', nowMs: 1 });
    ok('decide() with a signedTier of "constructor" yields the placeholder, never a function string', dec.action === 'create' && /\[\[workmanship warranty term/.test(dec.doc.body) && !/native code/.test(dec.doc.body));

    const DDF = require(path.join(FUNCTIONS, 'doc-drafts.js'));
    const NBD = DL.NBD_OWNER_UID;
    function mk(estO, leadO, reads) {
      const store = new Map(Object.entries({
        'leads/L1': Object.assign({ userId: NBD, companyId: NBD, stage: 'install_complete', firstName: 'Pat', email: 'pat@x.test', activeJobId: 'j1', jobType: 'cash', primaryEstimateId: 'est1' }, leadO || {}),
        ['companyProfile/' + NBD]: { brand: { displayName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382' } } },
        'estimates/est1': Object.assign({ userId: NBD, companyId: NBD, leadId: 'L1', signedPrice: { fields: { selectedTier: 'better', tier: 'better' }, totalCents: 1 } }, estO),
      }));
      const ref = (p) => ({ path: p, collection: (c) => col(p + '/' + c),
        async get() { if (reads) reads.push(p); const d = store.get(p); return { exists: d !== undefined, data: () => (d === undefined ? undefined : JSON.parse(JSON.stringify(d))) }; },
        async create(data) { if (store.has(p)) { const e = new Error('x'); e.code = 6; throw e; } store.set(p, JSON.parse(JSON.stringify(data))); } });
      const col = (c) => ({ doc: (id) => ref(c + '/' + id), where: () => ({ get: async () => ({ docs: [] }), limit: () => ({ get: async () => ({ docs: [] }) }) }) });
      return { store, collection: col, doc: ref };
    }
    const run = async (estO, leadO, reads) => {
      const db = mk(estO, leadO, reads);
      await DDF.draftDocsForEvent(db, { leadId: 'L1', event: 'installed' }, { FieldValue: { serverTimestamp: () => 'ts' }, logger: { info() {}, warn() {}, error() {} }, now: () => 1 });
      const d = db.store.get('leads/L1/doc_drafts/ddraft_L1_warranty_j1');
      return d ? d.body : '';
    };
    const yrs = (b) => { const m = /labor\) warranty: (\d+) years?/.exec(b); return m ? +m[1] : null; };
    // (20) selectedTier vs tier when they disagree
    ok('signed selectedTier "good" and tier "best" disagree: selectedTier wins -> 5 years', yrs(await run({ signedPrice: { fields: { selectedTier: 'good', tier: 'best' }, totalCents: 1 } })) === 5);
    ok('...and with only tier "best" signed -> 20 years', yrs(await run({ signedPrice: { fields: { tier: 'best' }, totalCents: 1 } })) === 20);
    ok('a signed selectedTier of "constructor" -> placeholder (not "function Object()")', (await run({ signedPrice: { fields: { selectedTier: 'constructor', tier: 'best' }, totalCents: 1 } })).indexOf('native code') === -1
      && yrs(await run({ signedPrice: { fields: { selectedTier: 'constructor' }, totalCents: 1 } })) === null);
    // (19) primaryEstimateId shape
    for (const bad of ['../x', 'a/b', '', 'x'.repeat(129), 'has space', 5]) {
      const reads = [];
      const b = await run({}, { primaryEstimateId: bad }, reads);
      ok('primaryEstimateId ' + JSON.stringify(bad) + ': the estimate is never read, placeholder', !reads.some((p) => /^estimates\//.test(p)) && yrs(b) === null && /\[\[workmanship warranty term/.test(b));
    }
    const reads = [];
    ok('control: a well-formed id IS read and yields the signed tier', yrs(await run({}, {}, reads)) === 10 && reads.indexOf('estimates/est1') !== -1);
  }

  // ═══ M. the queue UI, driven for real ══════════════════════════════════
  console.log('\nM. vacuity-audit survivors: queue UI behaviour');
  {
    function mkEl(tag) {
      const e = { tag, style: {}, children: [], listeners: {}, disabled: false, readOnly: false, value: '', textContent: '', removed: false };
      e.appendChild = (c) => { e.children.push(c); return c; };
      e.insertBefore = (c) => { e.children.unshift(c); return c; };
      e.addEventListener = (n, f) => { (e.listeners[n] = e.listeners[n] || []).push(f); };
      e.setAttribute = () => {};
      e.remove = () => { e.removed = true; };
      e.querySelectorAll = (sel) => { const out = []; (function walk(n) { n.children.forEach((c) => { if (c.tag === sel && !c.removed) out.push(c); walk(c); }); })(e); return out; };
      e.click = () => (e.listeners.click || []).forEach((f) => f());
      return e;
    }
    const wait = () => new Promise((r) => setTimeout(r, 25));
    async function ui(rows, sendImpl, role) {
      const host = mkEl('div');
      const w = {
        document: { createElement: mkEl, getElementById: (id) => (id === 'overviewTab' ? host : null) },
        console, db: {}, _userClaims: { role: role || 'company_admin' }, auth: { currentUser: { uid: 'u1' } },
        toasts: [], reads: 0, updates: [], sends: [],
        showToast(m, k) { w.toasts.push((k || 'info') + ': ' + m); },
        collection: (...a) => ({ a }), doc: (...a) => ({ a }), query: (...a) => ({ a }), where: (...a) => ({ a }),
        getDocs: async () => { w.reads++; return { forEach: (f) => rows.forEach((r) => f({ id: r.id, data: () => r.data })) }; },
        updateDoc: async (_r, patch) => { w.updates.push(patch); },
        setDoc: async () => {},
        NBDComms: { sendDraftEmail: async (p) => { w.sends.push(p); if (sendImpl === 'throw') throw new Error('boom'); return sendImpl ? sendImpl(p) : { success: true, mode: 'platform' }; } },
        nbdConfirm: async () => true,
        sessionStorage: { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; } },
      };
      w.window = w;
      vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/doc-drafts-ui.js'), 'utf8'), vm.createContext(w), { filename: 'doc-drafts-ui.js' });
      await w.NBDDocDrafts.render('L1', {});
      const btns = (label) => { const out = []; (function walk(x) { x.children.forEach((c) => { if (c.tag === 'button' && c.textContent === label && !c.removed) out.push(c); walk(c); }); })(host); return out; };
      const all = () => ({ send: btns('Send email').length, copy: btns('Copy').length, mark: btns('Mark sent').length, dismiss: btns('Dismiss').length, refresh: btns('Refresh').length });
      return { w, host, btns, all, area: () => host.querySelectorAll('textarea')[0], input: () => host.querySelectorAll('input')[0] };
    }
    const base = { status: 'draft', kind: 'warranty', label: 'Warranty summary', emailKind: 'document', channel: 'email', to: 'a@b.co', subject: 'S', body: 'Hello there.' };
    const row = (id, over) => ({ id, data: Object.assign({}, base, over || {}) });
    const ago = (ms) => ({ toMillis: () => Date.now() - ms });

    for (const code of ['already_sent', 'already_sending', 'draft_not_sendable', 'draft_changed', 'draft_not_found']) {
      const h = await ui([row('d1')], () => ({ success: false, mode: 'platform', error: code, message: 'x' }));
      h.btns('Send email')[0].click();
      await wait();
      ok('server says ' + code + ': the panel is RE-READ (refresh), a "someone else" notice shows, nothing is written',
        h.w.reads === 2 && h.w.toasts.some((t) => /Someone else/.test(t)) && h.w.updates.length === 0, 'reads=' + h.w.reads + ' ' + JSON.stringify(h.w.toasts));
    }
    {
      const h = await ui([row('d1')], () => ({ success: false, mode: 'platform', error: 'send_unconfirmed', unconfirmed: true, message: 'x' }));
      h.btns('Send email')[0].click();
      await wait();
      ok('an unconfirmed send: warns "may or may not", re-reads, writes nothing, never says "Could not send"',
        h.w.toasts.some((t) => /may or may not/.test(t)) && h.w.reads === 2 && h.w.updates.length === 0 && !h.w.toasts.some((t) => /Could not send/.test(t)));
      const h2 = await ui([row('d1')], 'throw');
      h2.btns('Send email')[0].click();
      await wait();
      ok('an unexpected throw from sendDraftEmail: "Could not confirm", the panel is re-read, nothing written',
        h2.w.toasts.some((t) => /Could not confirm the send/.test(t)) && h2.w.reads === 2 && h2.w.updates.length === 0);
      const h3 = await ui([row('d1')], () => ({ success: false, mode: 'platform', error: 'provider_rejected', message: 'Failed to send email' }));
      h3.btns('Send email')[0].click();
      await wait();
      ok('a provider refusal: message shown, panel re-read (the claim was released server-side)', h3.w.toasts.some((t) => /Failed to send email/.test(t)) && h3.w.reads === 2);
      const h4 = await ui([row('d1')], () => ({ success: false, mode: 'platform', error: 'do_not_contact', message: 'DNC!' }));
      h4.btns('Send email')[0].click();
      await wait();
      ok('a plain refusal (do_not_contact): message shown, NO re-read, Send usable again', h4.w.toasts.some((t) => /DNC!/.test(t)) && h4.w.reads === 1 && h4.btns('Send email')[0].disabled === false);
    }
    {
      // statuses -> which controls exist
      const inflight = await ui([row('s1', { status: 'sending', sendState: 'in_flight', sendingAt: ago(1000) })]);
      ok('sending / in_flight: only Refresh; no Send, Mark sent, Dismiss, Copy; fields read-only',
        JSON.stringify(inflight.all()) === JSON.stringify({ send: 0, copy: 0, mark: 0, dismiss: 0, refresh: 1 }) && inflight.area().readOnly === true && inflight.input().readOnly === true, JSON.stringify(inflight.all()));
      inflight.btns('Refresh')[0].click(); await wait();
      ok('...Refresh re-reads the queue', inflight.w.reads === 2);
      const stale = await ui([row('s2', { status: 'sending', sendState: 'in_flight', sendingAt: ago(6 * 60 * 1000) })]);
      ok('sending, claim 6 minutes old: treated as unconfirmed — Mark sent + Dismiss, no Send, no Refresh',
        JSON.stringify(stale.all()) === JSON.stringify({ send: 0, copy: 0, mark: 1, dismiss: 1, refresh: 0 }), JSON.stringify(stale.all()));
      const chk = await ui([row('s3', { status: 'sending', sendState: 'check_provider', sendingAt: ago(1000) })]);
      ok('sending / check_provider (fresh): Mark sent + Dismiss', JSON.stringify(chk.all()) === JSON.stringify({ send: 0, copy: 0, mark: 1, dismiss: 1, refresh: 0 }));
      const unrec = await ui([row('s4', { status: 'sending', sendState: 'sent_unrecorded', sendingAt: ago(1000), messageId: 're_1' })]);
      let unrecText = '';
      (function walk(x) { if (typeof x.textContent === 'string') unrecText += x.textContent + '|'; x.children.forEach(walk); })(unrec.host);
      ok('sending / sent_unrecorded: Mark sent + Dismiss, no Send, and the card says it WAS sent',
        unrec.all().mark === 1 && unrec.all().dismiss === 1 && unrec.all().send === 0 && /WAS sent/.test(unrecText), unrecText.slice(0, 200));
      // isEmail vs status: Send exists only for a status 'draft' email card
      const copyCh = await ui([row('c1', { channel: 'copy', to: '' })]);
      const failed = await ui([row('f1', { status: 'failed', kind: 'failed', channel: 'none' })]);
      const sendingEmail = await ui([row('s5', { status: 'sending', sendState: 'check_provider', channel: 'email', to: 'a@b.co' })]);
      const okDraft = await ui([row('o1')]);
      ok('Send exists only for a status "draft" email card (copy channel, failed marker and sending cards have none; control: the plain draft has it)',
        copyCh.all().send === 0 && failed.all().send === 0 && sendingEmail.all().send === 0 && okDraft.all().send === 1, JSON.stringify([copyCh.all(), failed.all(), sendingEmail.all(), okDraft.all()]));
      ok('a failed marker is read-only and has only Dismiss', failed.area().readOnly === true && JSON.stringify(failed.all()) === JSON.stringify({ send: 0, copy: 0, mark: 0, dismiss: 1, refresh: 0 }));
    }
    {
      // what the stale-claim Mark sent / Dismiss actually WRITE
      const h = await ui([row('s2', { status: 'sending', sendState: 'check_provider', sendingAt: ago(1000), subject: 'Stored S', body: 'Stored body.' })]);
      h.area().value = 'EDITED BODY'; // read-only in the real UI; must still never be written
      h.btns('Mark sent')[0].click();
      await wait();
      ok('Mark sent on an unconfirmed claim writes exactly {status:"copied", copiedAt} — never sent / sending / subject / body',
        h.w.updates.length === 1 && JSON.stringify(Object.keys(h.w.updates[0]).sort()) === '["copiedAt","status"]' && h.w.updates[0].status === 'copied', JSON.stringify(h.w.updates));
      const d = await ui([row('s2', { status: 'sending', sendState: 'check_provider', sendingAt: ago(1000) })]);
      d.btns('Dismiss')[0].click();
      await wait();
      ok('Dismiss on an unconfirmed claim writes exactly {status:"dismissed", dismissedAt}',
        d.w.updates.length === 1 && JSON.stringify(Object.keys(d.w.updates[0]).sort()) === '["dismissedAt","status"]' && d.w.updates[0].status === 'dismissed');
      const n = await ui([row('o1', { subject: 'Hello', body: 'Body text.' })]);
      n.btns('Mark sent')[0].click();
      await wait();
      ok('Mark sent on a normal draft writes status "copied" with the (edited) subject + body and copiedAt only',
        n.w.updates.length === 1 && n.w.updates[0].status === 'copied' && JSON.stringify(Object.keys(n.w.updates[0]).sort()) === '["body","copiedAt","status","subject"]' && n.w.updates.every((u) => u.status !== 'sent' && u.status !== 'sending'));
    }
    {
      const UI = require(path.join(ROOT, 'docs/pro/js/doc-drafts-ui.js'));
      const t0 = 1700000000000; const FIVE = 5 * 60 * 1000;
      const at = (ms) => ({ status: 'sending', sendState: 'in_flight', sendingAt: { toMillis: () => t0 } });
      ok('sendingState boundary: exactly 5 minutes is still in_flight, 5 minutes + 1 ms is check_provider, 1 ms is in_flight',
        UI.sendingState(at(), t0 + FIVE) === 'in_flight' && UI.sendingState(at(), t0 + FIVE + 1) === 'check_provider' && UI.sendingState(at(), t0 + 1) === 'in_flight');
      ok('sendingState reads Date, ISO string, {seconds} and {_seconds} claim times',
        UI.sendingState({ status: 'sending', sendingAt: new Date(t0) }, t0 + 1000) === 'in_flight'
        && UI.sendingState({ status: 'sending', sendingAt: new Date(t0).toISOString() }, t0 + 1000) === 'in_flight'
        && UI.sendingState({ status: 'sending', sendingAt: { seconds: t0 / 1000 } }, t0 + 1000) === 'in_flight'
        && UI.sendingState({ status: 'sending', sendingAt: { _seconds: t0 / 1000 } }, t0 + FIVE + 5000) === 'check_provider'
        && UI.sendingState({ status: 'sending', sendingAt: 'garbage' }, t0) === 'check_provider');
    }
    {
      // source shape, whitespace/EOL tolerant (the behavioural cases above carry the weight)
      const code = fs.readFileSync(path.join(ROOT, 'docs/pro/js/doc-drafts-ui.js'), 'utf8').replace(/\r/g, '');
      ok('the UI never writes status sent / sending (tolerant of spacing and quotes)', !/status\s*:\s*['"](sent|sending)['"]/.test(code));
    }
  }

  // ═══ N. NBDComms.sendDraftEmail, for real ══════════════════════════════
  console.log('\nN. NBDComms.sendDraftEmail');
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
    let h = loadComms(jsonRes(200, { success: true, id: 're_1', draftStatus: 'sent', bookkeeping: 'ok' }));
    let r = await h.C.sendDraftEmail({ leadId: 'L1', draftId: 'd1', subject: 'S', body: 'B', to: 'attacker@evil.test', kind: 'document', html: '<b>x</b>', invoiceId: 'i', replyTo: 'x@y.z' });
    ok('posts to /sendEmail with ONLY leadId, draftId, subject, body (to / kind / html / invoiceId / replyTo are dropped)',
      h.posts.length === 1 && /\/sendEmail$/.test(h.posts[0].url) && JSON.stringify(Object.keys(h.posts[0].body).sort()) === '["body","draftId","leadId","subject"]', JSON.stringify(h.posts[0]));
    ok('success: { success, mode platform, id, draftStatus, bookkeeping }, no mailto', r.success === true && r.mode === 'platform' && r.id === 're_1' && r.draftStatus === 'sent' && r.bookkeeping === 'ok' && h.opened.length === 0);
    h = loadComms(jsonRes(200, { success: true, id: 're_1' }));
    await h.C.sendDraftEmail({ leadId: 'L1', draftId: 'd1' });
    ok('subject / body are omitted from the request when not strings', JSON.stringify(Object.keys(h.posts[0].body).sort()) === '["draftId","leadId"]');
    h = loadComms(jsonRes(200, {}));
    r = await h.C.sendDraftEmail({ leadId: 'L1' });
    ok('a missing draftId makes no request at all', r.success === false && r.error === 'bad-request' && h.posts.length === 0);
    h = loadComms(jsonRes(200, {}));
    r = await h.C.sendDraftEmail();
    ok('no arguments at all: bad-request, no request', r.success === false && h.posts.length === 0);
    for (const [status, body, errWant, unconfirmedWant] of [
      [409, { error: 'This was already sent.', code: 'already_sent' }, 'already_sent', false],
      [409, { error: 'x', code: 'already_sending' }, 'already_sending', false],
      [403, { error: 'no', code: 'do_not_contact' }, 'do_not_contact', false],
      [403, { error: 'no', code: 'unsubscribed' }, 'unsubscribed', false],
      [422, { error: 'no', code: 'unresolved_placeholders' }, 'unresolved_placeholders', false],
      [502, { error: 'maybe', code: 'send_unconfirmed' }, 'send_unconfirmed', true],
      [502, { error: 'no', code: 'provider_rejected' }, 'provider_rejected', false],
      [503, { error: 'no', code: 'suppression_unverified' }, 'suppression_unverified', false],
    ]) {
      h = loadComms(jsonRes(status, body));
      r = await h.C.sendDraftEmail({ leadId: 'L1', draftId: 'd1', subject: 'S', body: 'B' });
      ok('HTTP ' + status + ' ' + body.code + ': success false, mode platform, error "' + errWant + '", unconfirmed ' + unconfirmedWant + ', NEVER a mailto handoff',
        r.success === false && r.mode === 'platform' && r.error === errWant && r.unconfirmed === unconfirmedWant && h.opened.length === 0, JSON.stringify(r));
    }
    {
      const toasts = [], opened = [];
      const window = { _user: { getIdToken: async () => 'id' }, showToast: (m, t) => toasts.push(t + ':' + m), dispatchEvent() {}, location: { set href(v) { opened.push(v); }, get href() { return ''; } } };
      const sandbox = { window, document: { createElement: () => { const a = { style: {}, remove() {} }; a.click = () => opened.push('click'); return a; }, body: { appendChild() {} }, addEventListener() {} }, console, location: { hostname: 'nobigdealwithjoedeal.com' }, fetch: async () => { throw new Error('network down'); }, AbortController, setTimeout, clearTimeout, CustomEvent: function () {} };
      vm.createContext(sandbox);
      vm.runInContext(SRC, sandbox, { filename: 'nbd-comms.js' });
      const rr = await window.NBDComms.sendDraftEmail({ leadId: 'L1', draftId: 'd1', subject: 'S', body: 'B' });
      ok('no answer at all (network down / abort): unconfirmed true (the request may have been processed), no mailto handoff, no success toast',
        rr.success === false && rr.mode === 'platform' && rr.unconfirmed === true && opened.length === 0 && !toasts.some((t) => /Email sent/.test(t)), JSON.stringify([rr, opened, toasts]));
    }
    {
      const toasts = [];
      h = loadComms(jsonRes(200, { success: true, id: 'x' }));
      await h.C.sendDraftEmail({ leadId: 'L1', draftId: 'd1', subject: 'S', body: 'B' });
      ok('a success toasts "Email sent"; a refusal does not', h.toasts.some((t) => t.type === 'success' && /Email sent/.test(t.msg)));
      h = loadComms(jsonRes(409, { error: 'no', code: 'already_sent' }));
      await h.C.sendDraftEmail({ leadId: 'L1', draftId: 'd1', subject: 'S', body: 'B' });
      ok('...(control) a 409 does not toast "Email sent"', !h.toasts.some((t) => /Email sent/.test(t.msg)));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
