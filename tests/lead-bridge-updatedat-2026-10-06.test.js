/**
 * tests/lead-bridge-updatedat-2026-10-06.test.js
 *
 * Incident (office-team self-test, 2026-10-06): two fresh Thumbtack leads
 * (alerts 10/05) were reported as "no CRM card". The cards existed — the
 * bridge created both within seconds — but lead-bridge.js never stamped
 * `updatedAt`. The agent MCP's list_leads sorts by updatedAt (newest first)
 * and returns at most 50, so a card with no updatedAt sorts as 0 and falls
 * off the page once a stage holds more than 50 leads (NBD: 76 'new', 60 of
 * them with no updatedAt). stale_days filtered them out for the same reason.
 *
 * This drives the REAL bridge trigger (firebase stubbed, in-memory Firestore)
 * and the REAL agent-mcp-logic listLeads over what it wrote.
 *
 * RUN: node tests/lead-bridge-updatedat-2026-10-06.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const FieldValue = { serverTimestamp: () => 'SERVER_TS' };
let _currentDb = null;
const stubs = {
  'firebase-functions/v2/firestore': { onDocumentCreated: (opts, fn) => fn },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => _currentDb, FieldValue },
  './customer-id-mint': {
    createLeadWithCustomerId: async (db, ref, doc) => {
      if ((await ref.get()).exists) { const e = new Error('already exists'); e.code = 6; throw e; }
      await ref.set(doc);
      return { customerId: null };
    },
  },
};
function requireFn(rel) {
  const origLoad = Module._load;
  Module._load = function (req) { if (stubs[req]) return stubs[req]; return origLoad.apply(this, arguments); };
  try { return require(path.join(ROOT, 'functions', rel)); } finally { Module._load = origLoad; }
}

function makeDb() {
  const store = new Map();
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  function ref(p) {
    return {
      path: p, id: p.split('/').pop(),
      async get() { const d = store.get(p); return { exists: d !== undefined, id: p.split('/').pop(), data: () => clone(d) }; },
      async set(data) { store.set(p, clone(data)); },
      async update(patch) { if (!store.has(p)) throw new Error('no doc ' + p); Object.assign(store.get(p), clone(patch)); },
    };
  }
  function query(c, filters, lim) {
    return {
      where(f, op, v) { return query(c, filters.concat([[f, v]]), lim); },
      limit(n) { return query(c, filters, n); },
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          if (!k.startsWith(c + '/') || k.split('/').length !== c.split('/').length + 1) continue;
          if (filters.every(([f, val]) => v[f] === val)) docs.push({ id: k.split('/').pop(), data: () => clone(v) });
        }
        return { docs: lim ? docs.slice(0, lim) : docs, empty: !docs.length };
      },
    };
  }
  function col(c) { return Object.assign(query(c, [], 0), { doc: (id) => ref(c + '/' + id) }); }
  return { store, collection: col };
}

(async () => {
  const BR = requireFn('lead-bridge.js');
  const A = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
  const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

  console.log('\n1. the bridge stamps updatedAt on the card it creates');
  const db = makeDb();
  _currentDb = db;
  await BR.leadBridgeThumbtack({
    data: { data: () => ({ firstName: 'Fresh', lastName: 'Thumbtack', phone: '6695550142', phoneDigits: '6695550142', notes: 'Thumbtack — Drywall Repair', source: 'Thumbtack' }) },
    params: { leadId: 'lead_tt_fresh' },
  });
  await BR.leadBridgeContact({
    data: { data: () => ({ name: 'Web Form', phone: '5135550101', message: 'roof leak' }) },
    params: { leadId: 'web_fresh' },
  });
  const tt = db.store.get('leads/thumbtack_leads__lead_tt_fresh');
  const web = db.store.get('leads/contact_leads__web_fresh');
  ok('Thumbtack card created', !!tt);
  ok('…with updatedAt (server timestamp), like createdAt', tt && tt.updatedAt === 'SERVER_TS' && tt.createdAt === 'SERVER_TS', JSON.stringify(tt && { u: tt.updatedAt, c: tt.createdAt }));
  ok('website-form card gets updatedAt too', web && web.updatedAt === 'SERVER_TS', JSON.stringify(web && web.updatedAt));

  console.log('\n2. list_leads (newest first, max 50) can see a just-bridged card in a crowded stage');
  // 60 older 'new' leads, all touched in the last 30 days — more than one page.
  const NOW = Date.UTC(2026, 9, 6, 12);
  const leads = [];
  for (let i = 0; i < 60; i++) {
    const t = NOW - (i + 2) * 3600000 * 12;
    leads.push({ id: 'old_' + i, firstName: 'Old', lastName: String(i), stage: 'new', companyId: OWNER, createdAt: t, updatedAt: t });
  }
  // The bridged card as Firestore stores it: server timestamps resolve to "now".
  const resolve = (doc, id) => {
    const out = { id };
    Object.keys(doc).forEach((k) => { out[k] = doc[k] === 'SERVER_TS' ? NOW - 60000 : doc[k]; });
    return out;
  };
  leads.push(resolve(tt, 'thumbtack_leads__lead_tt_fresh'));
  const page = A.listLeads(leads, { stage: 'new', limit: 50 }, NOW);
  ok('the fresh Thumbtack card is on the first page', page.some((c) => c.lead_id === 'thumbtack_leads__lead_tt_fresh'), 'page=' + page.length);
  ok('…at the top (it is the newest)', page[0] && page[0].lead_id === 'thumbtack_leads__lead_tt_fresh', page[0] && page[0].lead_id);

  console.log('\n3. stale_days counts a bridged card nobody has touched');
  const old = resolve(tt, 'thumbtack_leads__lead_tt_old');
  old.createdAt = NOW - 10 * 86400000; old.stageStartedAt = old.createdAt;
  if (old.updatedAt) old.updatedAt = old.createdAt; // as stamped at create; never invented here
  const stale = A.listLeads([old], { stale_days: 7 }, NOW);
  ok('a 10-day-old untouched bridged lead is stale at 7 days', stale.length === 1, JSON.stringify(stale));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
