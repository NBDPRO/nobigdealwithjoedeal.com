/**
 * tests/sms-dnc-2026-10-05.test.js
 *
 * WHY THIS EXISTS (texting review 2026-10-05, Jo's Do Not Call decision)
 * ──────────────────────────────────────────────────────────────────────
 * "No Do Not Call check exists anywhere." Jo chose an INTERNAL per-company
 * Do Not Text list — STOP replies plus numbers a rep adds from the CRM, no
 * paid registry — enforced inside the opt-out check every sender already
 * calls (functions/sms-optout.js isOptedOut), so no path can skip it.
 *
 *   A. isOptedOut: a number on company X's list is refused for X and only X;
 *      the lookup REJECTS without a companyId (a new path that forgets it
 *      fails closed); a list read error rejects; the time bound covers the
 *      list read too.
 *   B. every send path refuses a listed number with Twilio never called:
 *      sendSMS (live and queued), sendD2DSMS, onAiDraftApproved, and the
 *      storm-text guard both storm crons use.
 *   C. source contract: every isOptedOut call in functions/ (comments
 *      stripped) passes a companyId.
 *   D. manageSmsCompliance: list / add / remove, who may do which, and a
 *      STOP-reply entry can never be removed from the CRM.
 *   E. firestore.rules keeps sms_dnc admin-SDK only.
 *
 * Run: node tests/sms-dnc-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const W = require('./lib/sms-compliance-world');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
async function rejection(p) { try { await p; } catch (e) { return e; } return null; }

const ROOT = path.join(__dirname, '..');
const PHONE = '(859) 555-0134';
const KEY = '8595550134';
const DNC_CO1 = { ['sms_dnc/co-1__' + KEY]: { companyId: 'co-1', key: KEY, phone: PHONE, source: 'manual' } };
// Every scenario's tenant is allowed to text (the master switch, when present,
// is not what these tests are about).
const OPEN = { 'sms_settings/co-1': { registered: true, enabled: true } };

function seed(extra) { return Object.assign({}, OPEN, extra || {}); }

(async () => {
  // ═══ A. isOptedOut ═════════════════════════════════════════════════════
  console.log('A. isOptedOut — the company Do Not Text list');
  {
    const w = W.makeWorld({ docs: DNC_CO1 });
    const OptOut = W.load(w, 'sms-optout.js');
    const hit = await OptOut.isOptedOut(w.db, PHONE, { companyId: 'co-1' }).catch((e) => e);
    ok('a number on co-1\'s list is refused for co-1 (source dnc)', hit && hit.optedOut === true && hit.source === 'dnc', JSON.stringify(hit && (hit.message || hit)));
    const e164 = await OptOut.isOptedOut(w.db, '+1 859 555 0134', { companyId: 'co-1' }).catch((e) => e);
    ok('…in any phone format (one canonical key)', e164 && e164.optedOut === true);
    const other = await OptOut.isOptedOut(w.db, PHONE, { companyId: 'co-2' }).catch((e) => e);
    ok('…and NOT for co-2 (the list is per company)', other && other.optedOut === false, JSON.stringify(other && (other.message || other)));
    const arr = await OptOut.isOptedOut(w.db, PHONE, { companyId: ['co-2', 'co-1'] }).catch((e) => e);
    ok('an array of tenants checks each list', arr && arr.optedOut === true && arr.companyId === 'co-1');
    for (const bad of [undefined, {}, { companyId: '' }, { companyId: null }, { companyId: [] }, { companyId: 'a/b' }]) {
      const e = await rejection(OptOut.isOptedOut(w.db, PHONE, bad));
      ok('no usable companyId (' + JSON.stringify(bad) + ') → REJECTS optout_no_tenant (fail closed)', !!e && e.code === 'optout_no_tenant', e ? e.code || e.message : 'a verdict');
    }
  }
  {
    const w = W.makeWorld({ docs: {}, readThrows: (p) => p.startsWith('sms_dnc/') });
    const OptOut = W.load(w, 'sms-optout.js');
    const e = await rejection(OptOut.isOptedOut(w.db, PHONE, { companyId: 'co-1' }));
    ok('a Do Not Text list read error REJECTS (never "not listed")', !!e && /UNAVAILABLE/.test(e.message));
  }
  {
    const w = W.makeWorld({ docs: {} });
    const OptOut = W.load(w, 'sms-optout.js');
    // Register reads answer; the list read never does.
    const realDoc = w.db.doc;
    w.db.doc = (p) => (p.startsWith('sms_dnc/') ? { get: () => new Promise(() => {}) } : realDoc(p));
    const t0 = Date.now();
    const e = await rejection(OptOut.isOptedOut(w.db, PHONE, { companyId: 'co-1', timeoutMs: 40 }));
    ok('the time bound covers the list read (rejects optout_read_timeout)', !!e && e.code === 'optout_read_timeout' && Date.now() - t0 < 1500, e && (e.code || e.message));
  }

  // ═══ B. every send path ════════════════════════════════════════════════
  console.log('\nB. every send path refuses a number on the company\'s list');
  {
    const w = W.makeWorld({ docs: seed(DNC_CO1) });
    const mod = W.load(w, 'sms-functions.js');
    const res = await W.invoke(mod.sendSMS.__handler, { body: { to: PHONE, body: 'Hi Sam', leadId: 'lead-1' } });
    ok('sendSMS → 403 opted_out (list dnc), Twilio never called',
      res.statusCode === 403 && res.body && res.body.code === 'opted_out' && res.body.list === 'dnc' && w.twilioCalls.length === 0,
      res.statusCode + ' ' + JSON.stringify(res.body));
    ok('…the words say it is the company list, not a STOP', /Do Not Text list/.test((res.body && res.body.error) || ''));
  }
  {
    const w = W.makeWorld({ docs: seed() });
    const mod = W.load(w, 'sms-functions.js');
    const res = await W.invoke(mod.sendSMS.__handler, { body: { to: PHONE, body: 'Hi Sam' } });
    ok('control: the same send with the number NOT listed goes out', res.statusCode === 200 && w.twilioCalls.length === 1, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const w = W.makeWorld({ docs: seed(DNC_CO1) });
    const mod = W.load(w, 'sms-functions.js');
    const res = await W.invoke(mod.sendQueuedSMS.__handler, {
      body: { to: PHONE, body: 'Hi Sam', clientMsgId: 'abcdefghijklmnop1234', queuedAt: w.clock.now - 60000, queuedAgeMs: 60000 },
    });
    ok('sendQueuedSMS → 403 opted_out, Twilio never called', res.statusCode === 403 && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const knock = { userId: 'rep-1', companyId: 'co-1', phone: PHONE, firstName: 'Sam', repName: 'Joe', smsConsent: true };
    const w = W.makeWorld({ docs: seed(Object.assign({ 'knocks/knock-1': knock }, DNC_CO1)) });
    const mod = W.load(w, 'sms-functions.js');
    const res = await W.invoke(mod.sendD2DSMS.__handler, { body: { knockId: 'knock-1', templateKey: 'follow_up' } });
    ok('sendD2DSMS → 403 opted_out, Twilio never called', res.statusCode === 403 && res.body && res.body.code === 'opted_out' && w.twilioCalls.length === 0, res.statusCode + ' ' + JSON.stringify(res.body));
  }
  {
    const w = W.makeWorld({ docs: seed(Object.assign({ 'leads/lead-1/ai_drafts/d1': { status: 'approved' } }, DNC_CO1)) });
    const mod = W.load(w, 'sms-functions.js');
    const after = { status: 'approved', draftText: 'Sure, Tuesday works.', customerPhone: PHONE, userId: 'rep-1', companyId: 'co-1' };
    await mod.onAiDraftApproved.__handler({
      params: { leadId: 'lead-1', draftId: 'd1' },
      data: { before: { data: () => ({ status: 'pending' }) }, after: { data: () => after } },
    });
    const d = w.store.get('leads/lead-1/ai_drafts/d1') || {};
    ok('onAiDraftApproved → draft failed opted_out, Twilio never called', d.status === 'failed' && d.failureReason === 'opted_out' && w.twilioCalls.length === 0, JSON.stringify(d));
  }
  {
    const w = W.makeWorld({ docs: seed(Object.assign({ 'leads/lead-1/ai_drafts/d1': { status: 'approved' } })) });
    const mod = W.load(w, 'sms-functions.js');
    const after = { status: 'approved', draftText: 'Sure.', customerPhone: PHONE };
    await mod.onAiDraftApproved.__handler({
      params: { leadId: 'lead-1', draftId: 'd1' },
      data: { before: { data: () => ({ status: 'pending' }) }, after: { data: () => after } },
    });
    const d = w.store.get('leads/lead-1/ai_drafts/d1') || {};
    ok('an AI draft with no tenant fails closed (optout_check_error), Twilio never called', d.status === 'failed' && d.failureReason === 'optout_check_error' && w.twilioCalls.length === 0, JSON.stringify(d));
  }
  {
    const NBD = 'nbd-owner';
    const w = W.makeWorld({
      docs: {
        ['sms_dnc/' + NBD + '__' + KEY]: { companyId: NBD, key: KEY, source: 'manual' },
        'storm_alert_subscribers/s1': { phone: PHONE, active: true, zip: '45122', tcpaConsent: true },
      },
    });
    const Guard = W.load(w, 'storm-sms-guard.js');
    let sends = 0;
    const r = await Guard.sendGuardedStormText({
      db: w.db, subscriberRef: w.db.doc('storm_alert_subscribers/s1'), phone: '+18595550134',
      source: 't', companyId: NBD, eventKey: 'E1', nowMs: w.clock.now, send: async () => { sends++; return { sid: 'x' }; },
    });
    ok('storm guard (checkStormAlerts + stormWatch) → opted_out, nothing sent', r.status === 'opted_out' && sends === 0, JSON.stringify(r));
    const r2 = await Guard.sendGuardedStormText({
      db: w.db, subscriberRef: w.db.doc('storm_alert_subscribers/s1'), phone: '+18595550134',
      source: 't', eventKey: 'E1', nowMs: w.clock.now, send: async () => { sends++; return { sid: 'x' }; },
    });
    ok('storm guard with no companyId → optout_unverified, nothing sent', r2.status === 'optout_unverified' && sends === 0, JSON.stringify(r2));
  }

  // ═══ C. source contract ════════════════════════════════════════════════
  console.log('\nC. every isOptedOut call site names a tenant');
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const files = fs.readdirSync(path.join(ROOT, 'functions')).filter((f) => f.endsWith('.js'))
      .concat(fs.readdirSync(path.join(ROOT, 'functions', 'handlers')).filter((f) => f.endsWith('.js')).map((f) => 'handlers/' + f));
    const sites = [];
    for (const f of files) {
      const src = strip(fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8'));
      const re = /isOptedOut\(/g;
      let m;
      while ((m = re.exec(src))) {
        if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue; // the definition
        // The call's own argument list (balanced parens).
        let depth = 0, i = m.index + 'isOptedOut'.length, end = i;
        for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')') { depth--; if (!depth) { end = i; break; } } }
        sites.push({ f, args: src.slice(m.index, end + 1) });
      }
    }
    ok('found the call sites (sendSMS, sendD2DSMS, AI draft, storm guard)', sites.length >= 4, sites.map((s) => s.f).join(','));
    const bare = sites.filter((s) => !/companyId\s*:/.test(s.args));
    ok('every isOptedOut call passes companyId', bare.length === 0, bare.map((s) => s.f + ': ' + s.args.slice(0, 80)).join(' | '));
  }

  // ═══ D. manageSmsCompliance ════════════════════════════════════════════
  console.log('\nD. manageSmsCompliance — the CRM\'s list');
  async function call(token, data, docs) {
    const w = W.makeWorld({ docs: docs || {} });
    let mod;
    try { mod = W.load(w, 'sms-dnc.js'); } catch (e) { return { w, err: e }; }
    try {
      const out = await mod.manageSmsCompliance.__handler({ auth: token ? { uid: token.uid, token } : null, data });
      return { w, out };
    } catch (e) { return { w, err: e }; }
  }
  const REP = { uid: 'rep-1', companyId: 'co-1', role: 'sales_rep' };
  const ADMIN = { uid: 'adm-1', companyId: 'co-1', role: 'company_admin' };
  const VIEWER = { uid: 'v-1', companyId: 'co-1', role: 'viewer' };
  const SOLO = { uid: 'solo-1' };
  {
    const r = await call(REP, { action: 'addDnc', phone: PHONE, note: 'asked at the door' });
    ok('a sales rep can add a number (source manual, their company)', r.out && r.out.ok && r.out.created === true
      && r.w.store.get('sms_dnc/co-1__' + KEY) && r.w.store.get('sms_dnc/co-1__' + KEY).source === 'manual'
      && r.w.store.get('sms_dnc/co-1__' + KEY).addedBy === 'rep-1', JSON.stringify(r.err ? r.err.message : r.out));
  }
  {
    const r = await call(SOLO, { action: 'addDnc', phone: '859-555-0134' });
    ok('a solo owner adds to the list keyed by their uid', !!(r.out && r.w.store.get('sms_dnc/solo-1__' + KEY)), JSON.stringify(r.err ? r.err.message : r.out));
  }
  {
    const r = await call(VIEWER, { action: 'addDnc', phone: PHONE });
    ok('a viewer cannot add (permission-denied, nothing written)', r.err && r.err.code === 'permission-denied' && !r.w.store.has('sms_dnc/co-1__' + KEY));
  }
  {
    const r = await call(REP, { action: 'addDnc', phone: '555-0134' });
    ok('a number that is not 10 US digits is refused (invalid-argument)', r.err && r.err.code === 'invalid-argument');
  }
  {
    const r = await call(null, { action: 'listDnc' });
    ok('signed out → unauthenticated', r.err && r.err.code === 'unauthenticated');
  }
  {
    const r = await call(VIEWER, { action: 'listDnc' }, Object.assign({
      'sms_dnc/co-2__5135550123': { companyId: 'co-2', key: '5135550123', source: 'manual' },
    }, DNC_CO1));
    ok('anyone in the company can read the list — and only their company\'s entries',
      r.out && r.out.entries.length === 1 && r.out.entries[0].key === KEY, JSON.stringify(r.err ? r.err.message : r.out));
  }
  {
    const r = await call(REP, { action: 'removeDnc', phone: PHONE }, DNC_CO1);
    ok('a sales rep cannot remove (permission-denied, entry kept)', r.err && r.err.code === 'permission-denied' && r.w.store.has('sms_dnc/co-1__' + KEY));
  }
  {
    const r = await call(ADMIN, { action: 'removeDnc', phone: PHONE }, DNC_CO1);
    ok('a company_admin removes a manual entry', r.out && r.out.result === 'removed' && !r.w.store.has('sms_dnc/co-1__' + KEY), JSON.stringify(r.err ? r.err.message : r.out));
  }
  {
    const r = await call(ADMIN, { action: 'removeDnc', phone: PHONE }, {
      ['sms_dnc/co-1__' + KEY]: { companyId: 'co-1', key: KEY, source: 'stop_reply' },
    });
    ok('a STOP-reply entry is NEVER removed from the CRM (only the homeowner\'s START lifts it)',
      r.out && r.out.ok === false && r.out.result === 'stop_reply' && r.w.store.has('sms_dnc/co-1__' + KEY), JSON.stringify(r.err ? r.err.message : r.out));
  }
  {
    const r = await call(REP, { action: 'addDnc', phone: PHONE }, {
      ['sms_dnc/co-1__' + KEY]: { companyId: 'co-1', key: KEY, source: 'stop_reply' },
    });
    ok('adding a number already on the list is idempotent (a STOP-reply entry is not rewritten)',
      r.out && r.out.created === false && r.w.store.get('sms_dnc/co-1__' + KEY).source === 'stop_reply');
  }

  // ═══ E. rules ══════════════════════════════════════════════════════════
  console.log('\nE. firestore.rules');
  {
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    const m = rules.match(/match \/sms_dnc\/\{id\} \{([\s\S]*?)\}/);
    ok('sms_dnc is admin-SDK only (allow read, write: if false)', !!m && /allow read, write: if false;/.test(m[1]) && !/allow (create|update|get|list)/.test(m[1]));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
