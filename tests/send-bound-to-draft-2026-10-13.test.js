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
 * opts: docs, token, limited[], provider: async (msg, n) => response|throw,
 *       failWrite(path, data) -> true to throw on a write to that path
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
  function docRef(p) {
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
          if (opts.provider) return opts.provider(msg, n);
          await tick(); await tick();
          return { data: { id: 're_' + n }, error: null };
        },
      };
    }
  }
  const limiter = {
    httpRateLimit: async (req, res, ns) => {
      events.push('limit:' + ns);
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
  return { stubs, docs, events, sends, adds, logs };
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
    const bidi = '‮evil‬ ​hidden\u0007 ok⁦x⁩';
    const r = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'Warranty' + bidi + '\nBcc: x@y.z', body: 'Hi\u0000 Pat,\r\n\r\nSafe' + bidi }));
    const m = r.w.sends[0] || {};
    ok('control/characters: sends', r.res.statusCode === 200 && r.w.sends.length === 1);
    ok('bidi overrides, zero-width marks and control chars are stripped from subject and body',
      !/[‪-‮⁦-⁩​-‏\u0000-\u0008]/.test(m.subject + m.html), JSON.stringify(m.subject));
    ok('a newline in the subject cannot become a header: collapsed to one line', !/\n|\r/.test(m.subject) && /Bcc: x@y\.z/.test(m.subject) === true && m.subject.indexOf('\n') === -1);
    const long = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'x'.repeat(301) }));
    ok('a 301-character subject is refused (422 invalid_text)', long.res.statusCode === 422 && long.res.body.code === 'invalid_text' && long.w.sends.length === 0);
    const edge = await send({ docs: baseDocs() }, draftBody(DRAFT, { subject: 'x'.repeat(300) }));
    ok('control: 300 characters is accepted', edge.res.statusCode === 200);
    const bigBody = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: 'y'.repeat(10001) }));
    ok('a 10,001-character body is refused', bigBody.res.statusCode === 422 && bigBody.w.sends.length === 0);
    const empty = await send({ docs: baseDocs() }, draftBody(DRAFT, { body: ' \n​ ' }));
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
      DS.cleanText('a‮b​c\u0007d\ne', true) === 'abcd\ne' && DS.cleanText('a‮b\nc', false) === 'ab c');
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('\nFailures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
