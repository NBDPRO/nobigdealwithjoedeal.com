#!/usr/bin/env node
/**
 * tests/review-sprint-2026-10-16.test.js — the CRM MCP tool review_sprint.
 *
 * One pass over every 2026 customer paid in full and never asked for a Google
 * review, for Marcus / Tucker to DRAFT the asks (draft_email / draft_text) for
 * Joe to send. Read only.
 *
 *   A. the tool: read-only, Marcus + Tucker only, never phone or email
 *   B. who is listed: paid in full in 2026 by DATE RECEIVED; pre-2026 (Joe's
 *      work for other companies), no dated payment, finished before 2026,
 *      quiet backfill, another company, lost, do not contact, declined,
 *      already asked / tried, tagged pre-NBD, a draft already waiting, a
 *      balance still owed: all left out, each counted under its reason
 *   C. the channel: email, text only with written consent, else in person
 *   D. the ask wording: the automatic email's words, no rating, no incentive
 *   E. the real handler over an in-memory Firestore: this company only, the
 *      review link, nothing written but the audit row; Quinn / Dana refused
 *
 * Run: node tests/review-sprint-2026-10-16.test.js   (needs functions/node_modules)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 600) : '')); failed++; }
}

// ── In-memory Firestore (photo-match-2026-10-15's idiom) ──
function fakeDb() {
  const docs = new Map();
  let auto = 0;
  const writes = [];
  const setDotted = (o, k, v) => { const parts = k.split('.'); let cur = o; for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = Object.assign({}, cur[parts[i]] || {}); cur = cur[parts[i]]; } cur[parts[parts.length - 1]] = v; };
  const snap = (p) => ({ id: p.split('/').pop(), ref: mk(p), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    const parts = p.split('/');
    return {
      id: parts[parts.length - 1], path: p,
      parent: { id: parts[parts.length - 2], parent: parts.length >= 4 ? { id: parts[parts.length - 3] } : null },
      get: async () => snap(p),
      set: async (v, o) => { writes.push(p); docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : Object.assign({}, v)); },
      update: async (v) => {
        writes.push(p);
        if (!docs.has(p)) { const e = new Error('NOT_FOUND ' + p); e.code = 5; throw e; }
        const cur = Object.assign({}, docs.get(p)); Object.keys(v).forEach((k) => setDotted(cur, k, v[k])); docs.set(p, cur);
      },
      collection: (n) => coll(p + '/' + n),
    };
  }
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  const match = (d, f, op, v) => {
    if (!d || !Object.prototype.hasOwnProperty.call(d, f)) return false;
    const a = val(d[f]), b = val(v);
    return op === '==' ? a === b : op === '>=' ? a >= b : op === '<=' ? a <= b : false;
  };
  function query(test, filters, lim) {
    return {
      where: (f, op, v) => query(test, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(test, filters, lim),
      limit: (n) => query(test, filters, n),
      get: async () => {
        const rows = [...docs.keys()].filter((k) => test(k) && filters.every(([f, op, v]) => match(docs.get(k), f, op, v))).slice(0, lim || 1e9).map(snap);
        return { docs: rows, size: rows.length, empty: rows.length === 0, forEach: (fn) => rows.forEach(fn) };
      },
    };
  }
  function coll(cp) {
    const depth = cp.split('/').length + 1;
    const next = () => 'auto' + String(++auto).padStart(10, '0');
    return Object.assign(query((k) => k.startsWith(cp + '/') && k.split('/').length === depth, [], null), {
      doc: (id) => mk(cp + '/' + (id || next())),
      add: async (v) => { const r = mk(cp + '/' + next()); await r.set(v); return r; },
    });
  }
  const group = (name) => query((k) => { const s = k.split('/'); return s.length >= 2 && s.length % 2 === 0 && s[s.length - 2] === name; }, [], null);
  return { docs, writes, doc: mk, collection: coll, collectionGroup: group, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
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
const RA = require(path.join(ROOT, 'functions', 'review-ask-auto-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const TZ = 'America/New_York';
const CO = 'coSprintA';
const NOW = Date.parse('2026-10-16T15:00:00Z');
const lead = (id, o) => Object.assign({ id, companyId: CO, userId: CO, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St, Florence, KY 41042',
  phone: '(859) 555-0147', email: 'maria@example.test', stage: 'final_payment', jobType: 'Roof replacement' }, o || {});
const paidInv = (leadId, at, o) => Object.assign({ id: 'inv_' + leadId + '_' + at, leadId, companyId: CO, status: 'paid', total: 12000, amountPaid: 12000,
  payments: [{ amount: 12000, at }] }, o || {});
const run = (leads, invoices, extra) => L.reviewSprint(leads, invoices, (extra && extra.jobs) || null, (extra && extra.inbox) || [], CO, NOW, (extra && extra.args) || {}, TZ);
const ids = (r) => r.customers.map((c) => c.lead_id).join();

(async () => {
  console.log('A. the tool');
  {
    ok('review_sprint is a tool with a description and a closed schema', !!L.TOOLS.review_sprint && L.TOOLS.review_sprint.inputSchema.additionalProperties === false);
    ok('it is read-only (not a write, annotated readOnly)', L.WRITES.indexOf('review_sprint') === -1 && L.annotationsFor('review_sprint').readOnlyHint === true, JSON.stringify(L.annotationsFor('review_sprint')));
    ok('Marcus and Tucker have it; no other house bot does', Object.keys(L.BOTS).filter((b) => L.botAllows(b, 'review_sprint')).sort().join() === 'marcus,tucker');
    ok('the description says drafts only, one per customer, no gating or incentive, and never phone / email',
      /DRAFT|draft_email/.test(L.TOOLS.review_sprint.description) && /ONE draft per customer/.test(L.TOOLS.review_sprint.description)
      && /no rating first/.test(L.TOOLS.review_sprint.description) && /nothing offered/.test(L.TOOLS.review_sprint.description) && /Never phone or email/.test(L.TOOLS.review_sprint.description));
    ok('its name cannot send anything (the "no tool sends" guard still holds)', !/send|text_|sms|email|call_|delete|pay/.test('review_sprint'));
    ok('the Settings page names it for a custom bot', /review_sprint: 'Review sprint \(paid in 2026, never asked\)'/.test(read('docs/pro/js/agent-bots-settings.js')));
  }

  console.log('B. who is listed');
  {
    const at = Date.parse('2026-08-12T16:00:00Z');
    const r = run([lead('a')], [paidInv('a', at)]);
    ok('paid in full in 2026, never asked → listed', ids(r) === 'a' && r.total === 1, JSON.stringify(r));
    ok('the row: lead_id, first name, short name, town, paid_on (date received), job, channel', Object.keys(r.customers[0]).sort().join() === 'channel,first_name,job,lead_id,name,paid_on,town'
      && r.customers[0].name === 'Maria L.' && r.customers[0].town === 'Florence' && r.customers[0].paid_on === '2026-08-12' && r.customers[0].first_name === 'Maria', JSON.stringify(r.customers[0]));
    const s = JSON.stringify(r);
    ok('never the phone, email or street', !/555|0147|example\.test|Oak St|Lopez/.test(s) && r.customers.every((c) => L.FORBIDDEN_KEYS.every((k) => !(k in c))), s);

    const pre = run([lead('a')], [paidInv('a', Date.parse('2025-11-02T16:00:00Z'))]);
    ok('money received in 2025 → left out (before_2026: Joe\'s work before NBD)', pre.total === 0 && pre.skipped.before_2026 === 1, JSON.stringify(pre));
    const edge = run([lead('a'), lead('b')], [paidInv('a', Date.parse('2026-01-01T04:59:59Z')), paidInv('b', Date.parse('2026-01-01T05:00:00Z'))]);
    ok('the line is 2026-01-01 00:00 Eastern: one second before is out, midnight is in', ids(edge) === 'b' && edge.skipped.before_2026 === 1, JSON.stringify(edge));
    const recorded = run([lead('a')], [paidInv('a', Date.parse('2025-06-01T16:00:00Z'), { recordedAt: Date.parse('2026-10-15T16:00:00Z'), paidAt: Date.parse('2026-10-15T16:00:00Z') })]);
    ok('an old payment typed in today (backfill) counts by its DATE RECEIVED, so it stays out', recorded.total === 0 && recorded.skipped.before_2026 === 1, JSON.stringify(recorded));
    const finishedOld = run([lead('a', { installCompletedAt: Date.parse('2025-12-10T16:00:00Z') })], [paidInv('a', at)]);
    ok('a job finished before 2026 (paid later) → left out', finishedOld.total === 0 && finishedOld.skipped.before_2026 === 1);
    const undated = run([lead('a')], [{ id: 'i', leadId: 'a', companyId: CO, status: 'paid', total: 100 }]);
    ok('paid but no dated payment → left out (cannot show it is a 2026 job)', undated.total === 0 && undated.skipped.no_received_date === 1, JSON.stringify(undated));
    const owing = run([lead('a')], [paidInv('a', at), { id: 'i2', leadId: 'a', companyId: CO, status: 'sent', total: 500, amountPaid: 0 }]);
    ok('a balance still owed → left out (not paid in full)', owing.total === 0 && owing.skipped.not_paid_in_full === 1, JSON.stringify(owing));
    const notStage = run([lead('a', { stage: 'install_complete' })], [paidInv('a', at)]);
    ok('Install Done (before Final Payment) is not paid in full', notStage.total === 0);
    const quiet = run([lead('a', { stageHistory: [{ to: 'install_complete', backfill: true }] })], [paidInv('a', at)]);
    ok('marked finished after the fact (quiet backfill) → left out', quiet.total === 0 && quiet.skipped.quiet_backfill === 1, JSON.stringify(quiet));
    const other = run([lead('a', { companyId: 'coOther', userId: 'coOther' })], [paidInv('a', at, { companyId: 'coOther' })]);
    ok('another company\'s customer → left out', other.total === 0 && other.skipped.other_company === 1);
    const tagged = run([lead('a', { tags: ['Pre-NBD'] }), lead('b', { tags: 'other company job' })], [paidInv('a', at), paidInv('b', at)]);
    ok('tagged pre-NBD / other company → left out', tagged.total === 0 && tagged.skipped.pre_nbd === 2, JSON.stringify(tagged));
    const each = (o) => run([lead('a', o)], [paidInv('a', at)]).total;
    ok('do not contact / dnc → left out', each({ doNotContact: true }) === 0 && each({ dnc: 'yes' }) === 0);
    ok('"don\'t ask this one" → left out', each({ reviewAskDeclined: true }) === 0);
    ok('already asked (reviewRequested / reviewRequestedAt) or tried by the automatic ask → left out',
      each({ reviewRequested: true }) === 0 && each({ reviewRequestedAt: Date.parse('2026-09-01T00:00:00Z') }) === 0 && each({ reviewAutoAsk: { jobKey: '_lead', status: 'sent' } }) === 0);
    ok('lost / deleted → left out', each({ stage: 'lost' }) === 0 && each({ deleted: true }) === 0);
    const jobAsked = run([lead('a')], [paidInv('a', at)], { jobs: { a: [{ id: 'j2', stage: 'final_payment', reviewRequestedAt: Date.parse('2026-09-01T00:00:00Z') }] } });
    ok('asked on any of the customer\'s jobs → left out (one ask per customer)', jobAsked.total === 0 && jobAsked.skipped.already_asked === 1);
    const jobPaid = run([lead('a', { stage: 'contract_signed' })], [paidInv('a', at, { jobId: 'j1' })], { jobs: { a: [{ id: 'j1', stage: 'closed', title: 'Gutters' }] } });
    ok('a job (leads/{id}/jobs) paid in full in 2026 lists the customer, named by that job', ids(jobPaid) === 'a' && jobPaid.customers[0].job === 'Gutters', JSON.stringify(jobPaid));
    const waiting = run([lead('a'), lead('b')], [paidInv('a', at), paidInv('b', at)], { inbox: [
      { companyId: CO, leadId: 'a', kind: 'draft_email', status: 'pending', title: 'Would you leave us a quick Google review?', text: '...' },
      { companyId: CO, leadId: 'b', kind: 'draft_email', status: 'pending', title: 'Your estimate', text: 'about the gutters' },
    ] });
    ok('a review-ask draft already waiting → left out; another kind of draft does not count', ids(waiting) === 'b' && waiting.skipped.draft_waiting === 1, JSON.stringify(waiting));
    const tossed = run([lead('a')], [paidInv('a', at)], { inbox: [{ leadId: 'a', kind: 'draft_email', status: 'dismissed', title: 'Google review' }] });
    ok('a tossed review draft does not block it', tossed.total === 1);
    const order = run([lead('a'), lead('b'), lead('c')], [paidInv('a', Date.parse('2026-05-01T16:00:00Z')), paidInv('b', Date.parse('2026-09-01T16:00:00Z')), paidInv('c', Date.parse('2026-07-01T16:00:00Z'))], { args: { limit: 2 } });
    ok('newest paid first; limit pages it while total counts all', ids(order) === 'b,c' && order.total === 3, JSON.stringify(order));
  }

  console.log('C. the channel');
  {
    const at = Date.parse('2026-08-12T16:00:00Z');
    const ch = (o) => run([lead('a', o)], [paidInv('a', at)]).customers[0].channel;
    ok('an email on file → email', ch({}) === 'email');
    ok('no email, a number and written texting consent → text_consented', ch({ email: '', tcpaConsent: true }) === 'text_consented');
    ok('no email, no consent on file → in person (never a text)', ch({ email: '', tcpaConsent: undefined }) === 'in_person' && ch({ email: '', tcpaConsent: false }) === 'in_person');
    ok('consent but Do Not Text / opted out → in person', ch({ email: '', tcpaConsent: true, doNotText: true }) === 'in_person' && ch({ email: '', tcpaConsent: true, smsOptOut: 'yes' }) === 'in_person');
    ok('consent but no textable number → in person', ch({ email: '', phone: '555-01', tcpaConsent: true }) === 'in_person');
  }

  console.log('D. the ask wording');
  {
    const a = L.reviewSprintAsk(RA.NBD_REVIEW_URL, 'No Big Deal Home Solutions');
    ok('the automatic email\'s ask, with the review link', /Would you take a minute to leave us a Google review\? Honest feedback, whatever it is, helps your neighbors pick a contractor\./.test(a.email_body) && a.email_body.indexOf(RA.NBD_REVIEW_URL) !== -1 && a.subject === 'Would you leave No Big Deal Home Solutions a quick Google review?');
    const all = a.subject + ' ' + a.email_body + ' ' + a.text_body;
    ok('no rating first, no gating, no incentive', !/happy|satisf|star|rate us|rating|reward|discount|gift|\$|free|enter|chance|raffle|coupon/i.test(all), all);
    ok('it passes the claim-wording check', !L.claimWordingProblem(a.email_body) && !L.claimWordingProblem(a.text_body));
  }

  console.log('E. the handler over an in-memory Firestore');
  {
    DB = fakeDb();
    const S = (p, v) => DB.docs.set(p, v);
    const KEY = 'nbdk_marcus_sprint_' + '0'.repeat(24), QKEY = 'nbdk_quinn_sprint_' + '0'.repeat(25);
    S('agent_keys/' + sha(KEY), { botId: 'marcus', botName: L.BOTS.marcus.name, companyId: CO, active: true, prefix: KEY.slice(0, 9), createdBy: CO });
    S('agent_keys/' + sha(QKEY), { botId: 'quinn', botName: L.BOTS.quinn.name, companyId: CO, active: true, prefix: QKEY.slice(0, 9), createdBy: CO });
    S('agent_settings/' + CO, { enabled: true });
    S('subscriptions/' + CO, { status: 'active', plan: 'growth' });
    S('companyProfile/' + CO, { timezone: TZ, brand: { name: 'Acme Roofing' } });
    S('users/' + CO, { googleReviewUrl: 'https://g.page/r/acme/review' });
    const at = Date.parse('2026-08-12T16:00:00Z');
    S('leads/mine', lead('mine'));
    S('invoices/i1', paidInv('mine', at));
    S('leads/theirs', lead('theirs', { companyId: 'coOther', userId: 'coOther', firstName: 'Oscar' }));
    S('invoices/i2', paidInv('theirs', at, { companyId: 'coOther', createdBy: 'coOther' }));
    S('agent_inbox/x', { companyId: 'coOther', leadId: 'mine', kind: 'draft_email', status: 'pending', title: 'Google review' });
    const callTool = async (key, name, args) => {
      const req = { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, get(h) { return this.headers[String(h).toLowerCase()]; } };
      const res = { code: 200, body: null, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
      await M.crmMcp(req, res);
      const out = res.body && res.body.result;
      let json = null; try { json = JSON.parse(out.content[0].text); } catch (_) {}
      return { code: res.code, isError: !!(out && out.isError), text: out ? out.content[0].text : JSON.stringify(res.body), json };
    };
    const before = new Set(DB.docs.keys());
    const r = await callTool(KEY, 'review_sprint', {});
    ok('Marcus gets the list', r.code === 200 && !r.isError && r.json && Array.isArray(r.json.customers), r.text);
    ok('only this company\'s customer; another company\'s inbox row does not hide ours', r.json && ids(r.json) === 'mine' && !/Oscar|theirs/.test(r.text), r.text);
    ok('the rep\'s own review link and the company\'s own name (never NBD\'s for another company)', r.json && r.json.review_url === 'https://g.page/r/acme/review'
      && /Acme Roofing/.test(r.json.ask.subject) && r.text.indexOf(RA.NBD_REVIEW_URL) === -1, r.text);
    ok('the note: one draft per customer, text only with consent, in person otherwise, nothing sent', r.json && /ONE ask per customer/.test(r.json.note) && /draft_text ONLY for "text_consented"/.test(r.json.note) && /Nothing is sent/.test(r.json.note));
    ok('no phone or email in the answer', !/555|0147|example\.test/.test(r.text));
    const newDocs = [...DB.docs.keys()].filter((k) => !before.has(k));
    ok('nothing written but the audit row', newDocs.every((k) => /^agent_audit\//.test(k)), JSON.stringify(newDocs));
    const q = await callTool(QKEY, 'review_sprint', {});
    ok('Quinn (not her role) is refused', q.isError && /not part of your role/.test(q.text), q.text);

    const src = read('functions/agent-mcp.js');
    const blk = src.slice(src.indexOf("if (name === 'review_sprint')"), src.indexOf("if (name === 'lead_sources')"));
    ok('the handler reads this company\'s leads, invoices, jobs and inbox, and writes nothing', /companyLeads\(company\), companyDocs\('invoices', company/.test(blk) && /where\('companyId', '==', company\)/.test(blk) && !/\.(set|update|add|delete)\(/.test(blk));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
