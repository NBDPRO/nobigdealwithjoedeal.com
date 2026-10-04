#!/usr/bin/env node
/**
 * Bring your own bot (2026-10-04): any NBD Pro company on a paid plan connects
 * its OWN AI bots to its CRM through the bot connection (functions/agent-mcp.js,
 * /api/mcp), the way Jo's Grok team does — Settings → Bots & API.
 *
 * The real handlers run over an in-memory Firestore (firebase-admin/firestore
 * and the rate limiter are stubbed through Module._load), so this suite runs
 * in the plain node bucket and against main's file for the break-test.
 *
 *   A. pure rules: bot input, tools a company bot may use (never the personal
 *      tracker ones, never a send), plan gate + switch, timezone, the rules
 *      tool for a company that is not NBD, neutral wording
 *   B. Jo's house team still works unchanged (key auth with no subscription
 *      doc, NBD rules, New York, the bell to Jo)
 *   C. a company makes a bot, mints a key (shown once, hashed), the bot reads
 *      only its own company and files into its own inbox
 *   D. cross-tenant isolation on every new path
 *   E. plan gate + per-company switch
 *   F. timezone from the company profile
 *   G. team accounts: the bell + appointments go to the right person
 *   H. key listing: own keys for everyone, all company keys for an admin
 *   I. client + rules wiring
 *
 * Run: node tests/agent-tenant-bots-2026-10-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── In-memory Firestore (equality + range filters, nested collections,
// dotted updates, transactions) ─────────────────────────────────────────
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
  const val = (x) => (x instanceof Date ? x.getTime() : x);
  const match = (d, f, op, v) => {
    if (!d || !Object.prototype.hasOwnProperty.call(d, f)) return false;
    const a = val(d[f]), b = val(v);
    return op === '==' ? a === b : op === '>=' ? a >= b : op === '<=' ? a <= b : op === '<' ? a < b : op === '>' ? a > b : false;
  };
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
  return { docs, doc: mk, collection: coll, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
}

let DB = fakeDb();
// serverTimestamp → a Timestamp-like "now" (what Firestore stores).
const serverTimestamp = () => { const t = Date.now(); return { toMillis: () => t }; };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp } };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));
const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const who = {
  jo:      { uid: NBD, token: { role: 'admin' } },
  ownerA:  { uid: 'ownerA', token: { companyId: 'coA', role: 'company_admin' } },
  adminA:  { uid: 'adminA', token: { companyId: 'coA', role: 'company_admin' } },
  repA:    { uid: 'repA', token: { companyId: 'coA', role: 'sales_rep' } },
  viewerA: { uid: 'viewerA', token: { companyId: 'coA', role: 'viewer' } },
  ownerB:  { uid: 'ownerB', token: { companyId: 'coB', role: 'company_admin' } },
  ownerD:  { uid: 'ownerD', token: { companyId: 'coD', role: 'company_admin' } },
};
const DAY = '2026-10-06';
function seed() {
  DB = fakeDb();
  const S = (p, v) => DB.docs.set(p, v);
  const old = new Date(Date.now() - 40 * 86400000);
  // NBD (tenant zero): Jo's house team. No subscription doc, no profile.
  S('leads/n1', { companyId: NBD, userId: NBD, firstName: 'Nora', lastName: 'Nbd', address: '1 Home St', stage: 'new', followUp: '2020-01-01', updatedAt: old });
  S('agent_keys/' + sha('nbdk_jo_marcus_key_000000000000000'), { botId: 'marcus', botName: 'Marcus · NBD Ops', companyId: NBD, active: true, prefix: 'nbdk_jo_m', createdBy: NBD });
  S('agent_keys/' + sha('nbdk_jo_coach_key_0000000000000000'), { botId: 'coach', botName: 'Coach · Personal', companyId: NBD, active: true, scope: 'personal', ownerUid: NBD, createdBy: NBD });
  S('userSettings/' + NBD, { dsSnapshot: { asOf: Date.now(), today: { dk: '2026-10-04', floors: [{ label: 'Workout', met: true }] } } });
  // Company A: a TEAM account — the company id is not a person.
  S('companies/coA', { ownerId: 'ownerA', name: 'Sample Roofing Co.' });
  S('subscriptions/coA', { status: 'active', plan: 'team' });
  S('companyProfile/coA', {
    brand: { legalName: 'Sample Roofing Co.' },
    pricing: { tierRates: { good: 505, better: 605, best: 705 } },
    businessRules: { tiers: { enabled: ['good', 'better', 'best'], labels: { good: 'Basic', better: 'Plus', best: 'Max' }, warranty: { good: '10-year workmanship warranty.' } }, deposit: { depositPct: 30, noDepositUnderCents: 100000 } },
  });
  S('leads/a1', { companyId: 'coA', userId: 'repA', firstName: 'Avery', lastName: 'Able', address: '10 Sample Ridge Rd', phone: '5135550101', email: 'avery@example.test', stage: 'contacted', followUp: '2020-01-02', updatedAt: old });
  S('leads/a2', { companyId: 'coA', userId: 'ownerA', firstName: 'Blake', lastName: 'Able', address: '12 Sample Ridge Rd', stage: 'new', followUp: DAY, updatedAt: old });
  S('appointments/ap-owner', { repUid: 'ownerA', startTime: new Date(DAY + 'T15:00:00Z'), attendeeName: 'Owner booking', status: 'confirmed' });
  S('appointments/ap-admin', { repUid: 'adminA', startTime: new Date(DAY + 'T16:00:00Z'), attendeeName: 'Admin booking', status: 'confirmed' });
  S('appointments/ap-coid', { repUid: 'coA', startTime: new Date(DAY + 'T17:00:00Z'), attendeeName: 'Company-id booking', status: 'confirmed' });
  // Company B: free plan.
  S('companies/coB', { ownerId: 'ownerB' });
  S('subscriptions/coB', { status: 'active', plan: 'free' });
  S('leads/b1', { companyId: 'coB', userId: 'ownerB', firstName: 'Casey', lastName: 'Other', address: '99 Placeholder Ln', stage: 'new', followUp: '2020-01-03', updatedAt: old });
  // Company D: paid, no companyProfile doc yet.
  S('subscriptions/coD', { status: 'trialing', plan: 'growth' });
  S('leads/d1', { companyId: 'coD', userId: 'ownerD', firstName: 'Drew', stage: 'new', updatedAt: old });
}

async function call(fnName, auth, data) {
  const fn = M[fnName];
  if (!fn || typeof fn.run !== 'function') return { err: { code: 'missing', message: fnName + ' is not exported' } };
  try { return { r: await fn.run({ auth, data: data || {}, rawRequest: {} }) }; } catch (e) { return { err: e }; }
}
async function http(key, body) {
  const req = { method: 'POST', headers: { authorization: 'Bearer ' + key }, body,
    get(h) { return this.headers[String(h).toLowerCase()]; }, header(h) { return this.get(h); } };
  const res = { code: 200, body: null, hdr: {}, set(k, v) { this.hdr[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
  await M.crmMcp(req, res);
  return res;
}
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params: params || {} });
async function tool(key, name, args) {
  const r = await http(key, rpc('tools/call', { name, arguments: args || {} }));
  const res = r.body && r.body.result;
  if (!res) return { http: r.code, error: r.body && r.body.error };
  let json = null;
  try { json = JSON.parse(res.content[0].text); } catch (_) { json = null; }
  return { http: r.code, isError: res.isError === true, text: res.content[0].text, json };
}
// Runs to the end on main too (break-test): a missing key or bot becomes a
// key that authenticates nowhere, so later sections still report.
const MISSING = 'nbdk_missing_key_000000000000000000';
const NBD_WORDS = /\bJo\b|Jo's|\bNBD\b|No Big Deal|Quinn|TAMKO|HailGuard|jd@|info@|\b(440|550|660|770|880)\b|in-house|subcontractor|Lifetime/;

(async () => {
  console.log('A. pure rules');
  ok('a company bot may use any CRM tool but never the personal tracker ones', L.CUSTOM_TOOLS && L.CUSTOM_TOOLS.length >= 15 && !L.CUSTOM_TOOLS.some((t) => /^my_/.test(t)));
  ok('no tool a company bot can get sends, edits a customer or deletes', !(L.CUSTOM_TOOLS || []).some((t) => /send|text_|email|sms|delete|update|move|charge|pay/i.test(t)));
  const nb = L.normalizeBotInput ? L.normalizeBotInput({ name: '  Ops <b>helper</b> ', role: 'Watches follow-ups', tools: ['list_leads', 'file_note'], routeTo: 'creator' }) : {};
  ok('bot input: name cleaned (no markup), tools kept, route kept', nb.bot && nb.bot.name === 'Ops  b helper /b'.replace(/\s+/g, ' ') && nb.bot.tools.join() === 'list_leads,file_note' && nb.bot.routeTo === 'creator', JSON.stringify(nb));
  ok('bot input: no name / no tools / a personal tool / an unknown tool is refused',
    !!(L.normalizeBotInput && L.normalizeBotInput({ name: '', tools: ['list_leads'] }).error) && !!(L.normalizeBotInput && L.normalizeBotInput({ name: 'x', tools: [] }).error)
    && !!(L.normalizeBotInput && L.normalizeBotInput({ name: 'x', tools: ['my_money'] }).error) && !!(L.normalizeBotInput && L.normalizeBotInput({ name: 'x', tools: ['send_sms'] }).error));
  const gate = (o) => (L.accessDecision ? L.accessDecision(o) : { ok: 'missing' });
  ok('plan gate: active or trialing paid plan passes; free / canceled / no subscription is refused (402)',
    gate({ sub: { status: 'active', plan: 'starter' } }).ok === true && gate({ sub: { status: 'trialing', plan: 'growth' } }).ok === true
    && gate({ sub: { status: 'active', plan: 'free' } }).status === 402 && gate({ sub: { status: 'canceled', plan: 'growth' } }).status === 402 && gate({ sub: null }).status === 402);
  ok('plan gate: NBD and personal tracker keys are exempt', gate({ isNbd: true }).ok === true && gate({ personal: true }).ok === true);
  ok('switch: enabled === false refuses every key (403), NBD included; a missing settings doc is on',
    gate({ isNbd: true, settings: { enabled: false } }).status === 403 && gate({ sub: { status: 'active', plan: 'team' }, settings: { enabled: false } }).status === 403 && gate({ isNbd: true, settings: {} }).ok === true);
  const tz = (p, n, s) => (L.companyTimeZone ? L.companyTimeZone(p, n, s).tz : 'missing');
  ok('timezone: the profile wins; New York is the default for NBD only; others UTC until set',
    tz({ timezone: 'America/Denver' }, false) === 'America/Denver' && tz({ brand: { timeZone: 'America/Chicago' } }, false) === 'America/Chicago'
    && tz(null, true) === 'America/New_York' && tz(null, false) === 'UTC' && tz({ timezone: 'Mars/Base' }, false) === 'UTC' && tz(null, false, 'America/Phoenix') === 'America/Phoenix');
  ok('dayInZone: 03:30 UTC on Oct 5 is still Oct 4 in New York', L.dayInZone && L.dayInZone(Date.parse('2026-10-05T03:30:00Z'), 'America/New_York') === '2026-10-04' && L.dayInZone(Date.parse('2026-10-05T03:30:00Z'), 'UTC') === '2026-10-05');
  const neutral = L.rulesReferenceFor ? L.rulesReferenceFor({ isNbd: false, profile: {}, houseRules: '' }) : null;
  ok('rules for a company with nothing set: neutral guidance + the KY lines, none of NBD\'s tiers, prices, warranties or house rules',
    !!neutral && neutral.tiers.length === 0 && neutral.general_guidance.length >= 3 && !!neutral.kentucky_insurance_jobs && !NBD_WORDS.test(JSON.stringify(neutral)), neutral && JSON.stringify(neutral).match(NBD_WORDS));
  ok('rules for NBD are NBD\'s own (five tiers, unchanged)', L.rulesReferenceFor && L.rulesReferenceFor({ isNbd: true }).tiers.length === 5 && JSON.stringify(L.rulesReferenceFor({ isNbd: true })) === JSON.stringify(L.rulesReference()));
  const descs = Object.values(L.TOOLS).map((t) => t.description).join(' | ');
  ok('no tool description names Jo, NBD or Quinn', !/\bJo\b|Jo's|\bNBD\b|Quinn|\bhis\b|\bhim\b/.test(descs), (descs.match(/\bJo\b|Jo's|\bNBD\b|Quinn|\bhis\b|\bhim\b/) || [])[0]);
  const initCustom = L.initializeResult({}, { name: 'Ops helper', role: 'Watches follow-ups', tools: ['list_leads'], scope: 'crm', custom: true }).instructions;
  ok('a company bot\'s instructions are neutral and name the bot', /Ops helper/.test(initCustom) && !NBD_WORDS.test(initCustom) && /Nothing you do is sent to a customer/.test(initCustom), initCustom);
  ok('…and the house bots\' instructions too', !/\bJo\b|Jo's|Quinn/.test(L.initializeResult({}, 'marcus').instructions + L.initializeResult({}, 'coach').instructions));

  console.log('B. Jo\'s house team keeps working');
  seed();
  const JO = 'nbdk_jo_marcus_key_000000000000000';
  const jl = await http(JO, rpc('tools/list'));
  ok('Jo\'s Marcus key authenticates with no subscription doc and lists Marcus\'s tools', jl.code === 200 && jl.body.result.tools.map((t) => t.name).join() === L.BOTS.marcus.tools.join(), JSON.stringify(jl.body).slice(0, 200));
  const jod = await tool(JO, 'overdue_followups');
  ok('Marcus reads NBD\'s customers only', jod.json && jod.json.customers.map((c) => c.lead_id).join() === 'n1', jod.text);
  const jr = await tool(JO, 'rules_reference');
  ok('Marcus gets NBD\'s own rules (five tiers)', jr.json && jr.json.tiers.length === 5);
  const jf = await tool(JO, 'file_note', { lead_id: 'n1', text: 'Asked about gutters.' });
  const jbell = [...DB.docs.entries()].filter(([k, v]) => k.startsWith('notifications/') && v.type === 'agent_inbox');
  ok('Marcus files into NBD\'s inbox and the bell goes to Jo', jf.json && jf.json.filed === true && jbell.length === 1 && jbell[0][1].userId === NBD, JSON.stringify(jbell.map((x) => x[1].userId)));
  const jsum = await tool(JO, 'crm_summary');
  ok('NBD\'s day is New York', jsum.json && jsum.json.timezone === 'America/New_York', jsum.text);
  const jc = await tool('nbdk_jo_coach_key_0000000000000000', 'my_today');
  ok('Jo\'s personal Coach key still reads his tracker', jc.json && Array.isArray(jc.json.floors) && jc.json.floors.length === 1, jc.text);
  const joMint = await call('createAgentKey', who.jo, { botId: 'quinn' });
  ok('Jo can still mint a house-team key', joMint.r && /^nbdk_/.test(joMint.r.key), joMint.err && joMint.err.message);

  console.log('C. a company makes its own bot');
  seed();
  const made = await call('saveAgentBot', who.ownerA, { name: 'Follow-up Fox', role: 'Finds customers who went quiet', tools: ['crm_summary', 'list_leads', 'lead_detail', 'overdue_followups', 'schedule', 'file_note', 'file_reminder', 'rules_reference', 'team_activity'], routeTo: 'owner', timezone: 'America/Chicago' });
  ok('owner of a paid team account makes a bot', made.r && /^c_/.test(made.r.botId), made.err && made.err.message);
  const botA = (made.r && made.r.botId) || 'c_missingbot01';
  const botDocId = botA.slice(2);
  const stored = botA ? DB.docs.get('agent_bots/' + botDocId) : null;
  ok('stored server-side with its company, tools and maker', stored && stored.companyId === 'coA' && stored.createdBy === 'ownerA' && stored.active === true && stored.tools.length === 9);
  const k1 = await call('createAgentKey', who.ownerA, { botId: botA });
  const keyA = (k1.r && k1.r.key) || MISSING;
  ok('a key is minted for it and shown once', !!k1.r && /^nbdk_/.test(keyA) && k1.r.botName === 'Follow-up Fox' && /\/api\/mcp$/.test(k1.r.url), k1.err && k1.err.message);
  const kdoc = keyA ? DB.docs.get('agent_keys/' + sha(keyA)) : null;
  ok('only the hash is stored (plus a 9-char prefix), bound to the company and bot', kdoc && kdoc.companyId === 'coA' && kdoc.customBotId === botDocId && kdoc.prefix === keyA.slice(0, 9) && !JSON.stringify([...DB.docs.values()]).includes(keyA));
  const al = await http(keyA, rpc('tools/list'));
  ok('tools/list shows exactly the tools the owner picked', al.code === 200 && al.body.result.tools.map((t) => t.name).sort().join() === stored.tools.slice().sort().join());
  const ainit = await http(keyA, rpc('initialize', { protocolVersion: '2025-06-18' }));
  ok('initialize names the company\'s bot, not Jo or NBD', ainit.body.result && /Follow-up Fox/.test(ainit.body.result.instructions) && !NBD_WORDS.test(ainit.body.result.instructions));
  const notAllowed = await tool(keyA, 'job_profit');
  ok('a tool the owner did not pick is refused', notAllowed.isError === true && /not part of your role/.test(notAllowed.text));
  const ll = await tool(keyA, 'list_leads');
  ok('list_leads: only company A\'s customers, never phone or email', ll.json && ll.json.customers.map((c) => c.lead_id).sort().join() === 'a1,a2' && !/5135550101|avery@example/.test(ll.text), ll.text);
  const fn = await tool(keyA, 'file_note', { lead_id: 'a1', text: 'Went quiet after the estimate.' });
  ok('the success reply is neutral ("your Agent inbox"), never "Jo\'s"', fn.json && fn.json.filed === true && /your Agent inbox/.test(fn.json.note) && !/Jo/.test(fn.text), fn.text);
  const item = fn.json ? DB.docs.get('agent_inbox/' + fn.json.item_id) : null;
  ok('the filing lands pending in company A\'s inbox, credited to the bot', item && item.companyId === 'coA' && item.status === 'pending' && item.bot === 'Follow-up Fox' && item.botId === botA);
  const ar = await tool(keyA, 'rules_reference');
  ok('rules_reference serves company A\'s own tiers, prices, warranty and deposit — none of NBD\'s',
    ar.json && ar.json.tiers.map((t) => t.label + ':' + t.retail_per_sq).join() === 'Basic:505,Plus:605,Max:705' && ar.json.tiers[0].warranty === '10-year workmanship warranty.' && ar.json.deposit.cash_deposit_pct === 30 && !NBD_WORDS.test(ar.text), ar.text && ar.text.slice(0, 300));
  await call('saveAgentSettings', who.ownerA, { houseRules: '- Always offer gutters with a roof.\nNever quote over the phone.' });
  const ar2 = await tool(keyA, 'rules_reference');
  ok('…plus the house rules the owner typed', ar2.json && ar2.json.house_rules.join('|') === 'Always offer gutters with a roof.|Never quote over the phone.', ar2.text && ar2.text.slice(0, 200));
  const ta = await tool(keyA, 'team_activity');
  ok('team_activity covers company A\'s bots — not NBD\'s house team', ta.json && ta.json.bots.length === 1 && ta.json.bots[0].bot === 'Follow-up Fox' && ta.json.bots[0].filed === 1, ta.text);

  console.log('D. cross-tenant isolation');
  const bLead = await tool(keyA, 'file_note', { lead_id: 'b1', text: 'x' });
  ok('company A\'s bot cannot file on company B\'s customer', bLead.isError === true);
  const bDetail = await tool(keyA, 'lead_detail', { lead_id: 'n1' });
  ok('…nor read NBD\'s customer', bDetail.isError === true);
  const bMint = await call('createAgentKey', who.ownerB, { botId: botA });
  ok('company B cannot mint a key for company A\'s bot', bMint.err && bMint.err.code === 'not-found');
  const bEdit = await call('saveAgentBot', who.ownerB, { botId: botA, name: 'Hijack', tools: ['job_profit'] });
  ok('company B cannot edit company A\'s bot', !!bEdit.err && (DB.docs.get('agent_bots/' + botDocId) || {}).name === 'Follow-up Fox');
  const bDel = await call('deleteAgentBot', who.ownerB, { botId: botA });
  ok('company B cannot remove company A\'s bot', bDel.err && bDel.err.code === 'not-found' && (DB.docs.get('agent_bots/' + botDocId) || {}).active === true);
  const bRev = await call('revokeAgentKey', who.ownerB, { id: sha(keyA) });
  ok('company B cannot revoke company A\'s key', bRev.err && bRev.err.code === 'not-found' && (DB.docs.get('agent_keys/' + sha(keyA)) || {}).active === true);
  const bList = await call('listAgentKeys', who.ownerB, {});
  ok('company B\'s list shows none of company A\'s bots or keys', bList.r && bList.r.keys.length === 0 && (bList.r.customBots || []).length === 0 && !JSON.stringify(bList.r).includes('Follow-up Fox'));
  // A forged key doc in company B pointing at company A's bot.
  DB.docs.set('agent_keys/' + sha('nbdk_forged_b_points_at_a_000000000'), { botId: botA, customBotId: botDocId, companyId: 'coB', active: true });
  const forged = await http('nbdk_forged_b_points_at_a_000000000', rpc('tools/list'));
  ok('a key can never borrow another company\'s bot', forged.code === 401);
  const houseA = await call('createAgentKey', who.ownerA, { botId: 'marcus' });
  ok('another company cannot mint NBD\'s house-team bots', houseA.err && houseA.err.code === 'permission-denied');
  const listA = await call('listAgentKeys', who.ownerA, {});
  ok('…and its page never lists NBD\'s house team (only the personal tracker bots)', listA.r && listA.r.bots.every((b) => b.personal) && listA.r.canHouse === false);

  console.log('E. plan gate + per-company switch');
  const freeBot = await call('saveAgentBot', who.ownerB, { name: 'Free bot', tools: ['list_leads'] });
  ok('a free-plan company cannot make a bot', freeBot.err && freeBot.err.code === 'failed-precondition' && /paid/.test(freeBot.err.message));
  DB.docs.set('agent_bots/freebotdoc01', { companyId: 'coB', name: 'Old', tools: ['list_leads'], active: true, createdBy: 'ownerB' });
  DB.docs.set('agent_keys/' + sha('nbdk_free_plan_key_0000000000000000'), { botId: 'c_freebotdoc01', customBotId: 'freebotdoc01', companyId: 'coB', active: true });
  const freeCall = await http('nbdk_free_plan_key_0000000000000000', rpc('tools/list'));
  ok('a free-plan company\'s key is refused at the connection (402)', freeCall.code === 402 && /paid/.test(freeCall.body.error.message));
  const off = await call('saveAgentSettings', who.ownerA, { enabled: false });
  const offCall = await http(keyA, rpc('tools/list'));
  ok('the owner switches bots off: company A\'s key is refused (403)', off.r && offCall.code === 403 && /switched off/.test(offCall.body.error.message));
  const offMint = await call('createAgentKey', who.ownerA, { botId: botA });
  ok('…and no new key can be made while off', offMint.err && offMint.err.code === 'failed-precondition');
  const joStill = await http(JO, rpc('tools/list'));
  ok('company A\'s switch does not touch NBD\'s keys', joStill.code === 200);
  const offList = await call('listAgentKeys', who.ownerA, {});
  ok('the page shows the switch off', offList.r && offList.r.enabled === false);
  await call('saveAgentSettings', who.ownerA, { enabled: true });
  ok('switched back on, the key works again', (await http(keyA, rpc('tools/list'))).code === 200);
  const viewerSet = await call('saveAgentSettings', who.viewerA, { enabled: false });
  const repSet = await call('saveAgentBot', who.repA, { name: 'Rep bot', tools: ['list_leads'] });
  ok('a viewer or sales rep cannot flip the switch or make a bot', viewerSet.err && viewerSet.err.code === 'permission-denied' && repSet.err && repSet.err.code === 'permission-denied');

  console.log('F. timezone from the company profile');
  ok('the first bot set company A\'s timezone from the owner\'s browser (on its profile)', (DB.docs.get('companyProfile/coA') || {}).timezone === 'America/Chicago');
  const asum = await tool(keyA, 'crm_summary');
  ok('company A\'s day is Chicago, not New York', asum.json && asum.json.timezone === 'America/Chicago', asum.text);
  const dBot = await call('saveAgentBot', who.ownerD, { name: 'D bot', tools: ['crm_summary'] });
  const dKey = (await call('createAgentKey', who.ownerD, { botId: dBot.r && dBot.r.botId })).r || { key: MISSING };
  const dsum = await tool(dKey.key, 'crm_summary');
  ok('a company with no timezone set is not given New York (UTC until set)', dsum.json && dsum.json.timezone === 'UTC', dsum.text);
  await call('saveAgentSettings', who.ownerD, { timezone: 'America/Denver' });
  const dsum2 = await tool(dKey.key, 'crm_summary');
  ok('set on the Bots page, it is used — and no stub companyProfile is created', dsum2.json && dsum2.json.timezone === 'America/Denver' && !DB.docs.has('companyProfile/coD'), dsum2.text);
  const badTz = await call('saveAgentSettings', who.ownerD, { timezone: 'Not/AZone' });
  ok('a bad timezone is refused', badTz.err && badTz.err.code === 'invalid-argument');

  console.log('G. team accounts: the right person');
  seed();
  const ownerBot = (await call('saveAgentBot', who.ownerA, { name: 'Owner bot', tools: ['schedule', 'file_note'], routeTo: 'owner' })).r;
  const adminBot = (await call('saveAgentBot', who.adminA, { name: 'Admin bot', tools: ['schedule', 'file_note'], routeTo: 'creator' })).r;
  const ko = (ownerBot && (await call('createAgentKey', who.ownerA, { botId: ownerBot.botId })).r) || { key: MISSING };
  const ka = (adminBot && (await call('createAgentKey', who.adminA, { botId: adminBot.botId })).r) || { key: MISSING };
  await tool(ko.key, 'file_note', { lead_id: 'a1', text: 'Owner-routed.' });
  await tool(ka.key, 'file_note', { lead_id: 'a1', text: 'Maker-routed.' });
  const bells = [...DB.docs.values()].filter((v) => v.type === 'agent_inbox');
  ok('the bell goes to the company owner (companies.ownerId), never to the company id', bells.some((b) => b.userId === 'ownerA' && /Owner bot/.test(b.title)) && !bells.some((b) => b.userId === 'coA'), JSON.stringify(bells.map((b) => b.userId + ':' + b.title)));
  ok('a bot set to "me" rings its maker', bells.some((b) => b.userId === 'adminA' && /Admin bot/.test(b.title)));
  const so = await tool(ko.key, 'schedule', { date: DAY });
  const sa = await tool(ka.key, 'schedule', { date: DAY });
  const names = (r) => (r.json ? r.json.items.filter((i) => i.what === 'Appointment').map((i) => i.name).join() : r.text);
  ok('schedule shows the owner\'s bookings for an owner bot', names(so) === 'Owner booking', names(so));
  ok('…and the maker\'s bookings for a "me" bot', names(sa) === 'Admin booking', names(sa));
  ok('schedule includes company A\'s follow-up that day', so.json && so.json.items.some((i) => i.what === 'Follow-up due' && i.lead_id === 'a2'));

  DB.docs.set('agent_keys/' + sha('nbdk_team_house_key_00000000000000'), { botId: 'marcus', companyId: 'coA', active: true, createdBy: 'ownerA' });
  const hk = { id: sha('nbdk_team_house_key_00000000000000'), botId: 'marcus', companyId: 'coA' };
  const hs = JSON.parse((await M._internal.handleRpc(rpc('tools/call', { name: 'schedule', arguments: { date: DAY } }), hk)).result.content[0].text);
  ok('a team company\'s older house-roster key reads the OWNER\'s bookings, not ones filed under the company id', hs.items.filter((i) => i.what === 'Appointment').map((i) => i.name).join() === 'Owner booking', JSON.stringify(hs.items));
  await M._internal.handleRpc(rpc('tools/call', { name: 'file_note', arguments: { lead_id: 'a1', text: 'House key in a team.' } }), hk);
  const hb = [...DB.docs.values()].filter((v) => v.type === 'agent_inbox' && /Marcus/.test(v.title));
  ok('…and rings the owner, not the company id', hb.length === 1 && hb[0].userId === 'ownerA', JSON.stringify(hb.map((b) => b.userId)));

  console.log('H. key listing');
  const repKey = (await call('createAgentKey', who.repA, { botId: 'coach' })).r || { key: MISSING };
  ok('a sales rep can still make a personal tracker key', repKey.key !== MISSING && /^nbdk_/.test(repKey.key));
  const repList = await call('listAgentKeys', who.repA, {});
  ok('a sales rep can list keys — only their own', repList.r && repList.r.keys.length === 1 && repList.r.keys[0].personal === true && repList.r.canManage === false, repList.err && repList.err.message);
  const ownList = await call('listAgentKeys', who.ownerA, {});
  ok('the owner sees every company bot key, but not the rep\'s personal key', ownList.r && ownList.r.keys.filter((k) => k.custom).length === 2 && !ownList.r.keys.some((k) => k.personal), JSON.stringify(ownList.r && ownList.r.keys));
  ok('no listing ever carries a secret', !JSON.stringify(ownList.r).includes(ko.key) && !JSON.stringify(repList.r).includes(repKey.key));
  const repRevokeOther = await call('revokeAgentKey', who.repA, { id: sha(ko.key) });
  ok('a rep cannot revoke the company\'s bot key', repRevokeOther.err && (DB.docs.get('agent_keys/' + sha(ko.key)) || {}).active === true);
  const repRevokeOwn = await call('revokeAgentKey', who.repA, { id: sha(repKey.key) });
  ok('a rep can revoke their own key', repRevokeOwn.r && (DB.docs.get('agent_keys/' + sha(repKey.key)) || {}).active === false);
  const ownerRevokeRep = await call('revokeAgentKey', who.ownerA, { id: sha(repKey.key) });
  ok('the owner cannot touch someone else\'s personal key', ownerRevokeRep.err && ownerRevokeRep.err.code === 'not-found');
  const del = await call('deleteAgentBot', who.ownerA, { botId: ownerBot && ownerBot.botId });
  ok('removing a bot revokes its keys', del.r && del.r.keysRevoked === 1 && (await http(ko.key, rpc('tools/list'))).code === 401);
  const revoked = await call('revokeAgentKey', who.adminA, { id: sha(ka.key) });
  ok('a revoked key stops working', revoked.r && (await http(ka.key, rpc('tools/list'))).code === 401);

  console.log('I. wiring');
  const rules = read('firestore.rules');
  ok('agent_bots and agent_settings are server-only', /match \/agent_bots\/\{botId\}\s+\{ allow read, write: if false; \}/.test(rules) && /match \/agent_settings\/\{companyId\} \{ allow read, write: if false; \}/.test(rules));
  const idx = read('functions/index.js');
  ok('index exports the new callables', ['saveAgentBot', 'deleteAgentBot', 'saveAgentSettings'].every((n) => new RegExp('exports\\.' + n + ' = agentMcp\\.' + n + ';').test(idx)));

  // The Settings page, rendered in a sandbox from listAgentKeys-shaped data.
  const ui = read('docs/pro/js/agent-bots-settings.js');
  const win = { location: { search: '' } };
  win.window = win;
  vm.runInContext(ui, vm.createContext({ window: win, document: { readyState: 'complete', addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } }, console, setTimeout, setInterval, clearInterval, JSON, Math, String, Intl, Date }));
  const B = win.NBDAgentBots;
  ok('the page module loads and exposes its pure renderers', !!B && typeof B.pageHtml === 'function');
  const base = { url: 'https://nobigdealwithjoedeal.com/api/mcp', canManage: true, canHouse: false, isNbd: false, enabled: true, planOk: true, plan: 'team', timezone: 'America/Chicago', timezoneSet: true, houseRules: '',
    toolCatalog: L.CUSTOM_TOOLS.map((n) => ({ name: n, description: L.TOOLS[n].description, files: L.WRITES.indexOf(n) !== -1 })),
    bots: [{ botId: 'coach', name: 'Coach · Personal', tools: ['my_today'], personal: true }],
    customBots: [{ botId: 'c_abc12345', name: '<img src=x onerror=alert(1)>', role: 'Watches "quiet" leads', tools: ['list_leads'], routeTo: 'owner' }],
    keys: [{ id: 'k1', botId: 'c_abc12345', active: true, prefix: 'nbdk_AbCd', createdAt: 1, lastUsedAt: null, custom: true }] };
  const owner = B ? B.pageHtml(base) : '';
  ok('owner on a paid plan: the switch, timezone, house rules, the make-a-bot form and the bot with its key prefix + Revoke',
    /id="abEnabled"/.test(owner) && /id="abTz"/.test(owner) && /id="abRules"/.test(owner) && /id="abNewBot"/.test(owner) && /nbdk_AbCd…/.test(owner) && /data-ab-act="revoke"/.test(owner));
  ok('every bot-supplied string is escaped', !/<img src=x/.test(owner) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(owner) && /&quot;quiet&quot;/.test(owner));
  ok('a non-NBD company never sees the NBD house team', !/NBD house team/.test(owner));
  ok('NBD sees its house team', B && /NBD house team/.test(B.pageHtml(Object.assign({}, base, { isNbd: true, canHouse: true, bots: base.bots.concat([{ botId: 'marcus', name: 'Marcus · NBD Ops', tools: ['list_leads'], personal: false }]) }))));
  const free = B ? B.pageHtml(Object.assign({}, base, { planOk: false, plan: 'free' })) : '';
  ok('a free plan sees the upgrade card and no make-a-bot form', /Bots need a paid plan/.test(free) && !/id="abNewBot"/.test(free) && !/data-ab-act="mkkey" data-ab-id="c_/.test(free));
  const offUi = B ? B.pageHtml(Object.assign({}, base, { enabled: false })) : '';
  ok('switched off: says so, no form, no new keys', /Bots are switched off/.test(offUi) && !/id="abNewBot"/.test(offUi));
  const rep = B ? B.pageHtml(Object.assign({}, base, { canManage: false, customBots: [], keys: [{ id: 'k9', botId: 'coach', active: true, prefix: 'nbdk_rep1', personal: true }] })) : '';
  ok('a rep sees no company settings, only the personal bots with their own key', !/id="abEnabled"|id="abNewBot"/.test(rep) && /nbdk_rep1…/.test(rep) && /set up by the owner or an admin/.test(rep));
  ok('no timezone yet: the page asks for one', B && /No timezone set yet/.test(B.pageHtml(Object.assign({}, base, { timezoneSet: false, timezone: 'UTC' }))));
  const cfg = B ? B.exampleConfig('https://nobigdealwithjoedeal.com/api/mcp', 'Follow-up Fox') : '';
  ok('example config: mcp-remote to the address with the Bearer header, key left as a placeholder', /"mcp-remote"/.test(cfg) && /api\/mcp/.test(cfg) && /Authorization:Bearer \$\{CRM_KEY\}/.test(cfg) && /paste-your-key-here/.test(cfg) && /"follow-up-fox"/.test(cfg));
  const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the page has no send path; its only server calls are the bot callables', !/sendSMS|sendEmail|NBDComms|sendQueued/.test(uiCode) && (uiCode.match(/callable\('(\w+)'/g) || []).every((m) => /createAgentKey|listAgentKeys|revokeAgentKey|saveAgentBot|deleteAgentBot|saveAgentSettings/.test(m)));
  ok('the key is shown once with a copy button and a "shown once" warning', /it is shown once/.test(ui) && /data-ab-act="copykey"/.test(ui) && /id="abFreshKey"/.test(ui));
  const dash = read('docs/pro/dashboard.html');
  ok('Settings has the Bots & API tab + panel; the page script and CSS load', /id="stab-bots"/.test(dash) && /id="stab-panel-bots"/.test(dash) && /id="agentBotsMount"/.test(dash)
    && /<script defer src="js\/agent-bots-settings\.js\?v=\d+"><\/script>/.test(dash) && /css\/agent-bots\.css\?v=\d+/.test(dash));
  ok('the Agent inbox has a nav entry on desktop and in the phone More drawer (hidden until owner/admin)',
    /class="ni dn"[^>]*data-action="module" data-target="NBDAgentInbox\.open" id="nav-agentinbox"/.test(dash) && /class="mm-item dn" data-action="module" data-target="NBDAgentInbox\.open" id="mm-agentinbox"/.test(dash));
  const inboxSrc = read('docs/pro/js/agent-inbox.js');
  ok('the inbox shows its nav entries to the owner/admin and links to Bots & API (keys no longer minted there)',
    /\['nav-agentinbox', 'mm-agentinbox'\]\.forEach/.test(inboxSrc) && /data-ai-act="bots"/.test(inboxSrc) && /window\.NBDAgentBots\.open\(\)/.test(inboxSrc) && !/createAgentKey/.test(inboxSrc));
  ok('?settings=bots deep-links (allowlisted)', /SETTINGS_TABS = \[[^\]]*'bots'/.test(read('docs/pro/js/dashboard-bootstrap.module.js')));
  const howto = read('docs/pro/how-to.html');
  const sec = (howto.match(/<section class="section" id="connect-bots"[\s\S]*?<\/section>/) || [''])[0];
  ok('how-to: a "Connect your own AI bot" section with the address, the header, an example config and the safety notes',
    /Connect your own AI bot/.test(sec) && /https:\/\/nobigdealwithjoedeal\.com\/api\/mcp/.test(sec) && /Authorization: Bearer/.test(sec) && /mcp-remote/.test(sec)
    && /Nothing is sent to a customer/.test(sec) && /file notes, reminders and reports, and nothing else/.test(sec) && /href="#connect-bots"/.test(howto));

  Module._load = origLoad;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
