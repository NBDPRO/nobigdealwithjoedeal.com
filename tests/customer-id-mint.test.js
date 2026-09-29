/**
 * tests/customer-id-mint.test.js — server-side customerId mint for leads the
 * backend creates (functions/customer-id-mint.js).
 *
 * WHY: server bridges (website forms, Thumbtack, Cal.com, ...) created leads
 * with no customerId — 77 of 223 live NBD leads on 2026-09-29 — and the Home
 * Depot import matches receipts by that number. Pins:
 *   - sequential ids off counters/{counterId}.next, continuing the live value
 *   - NBD owner → un-salted 'NBD-####' from the shared 'customerIds' counter
 *   - any other tenant → salted '<PFX>-####-<salt>' from its own counter
 *   - an unprovisioned non-owner tenant is skipped, never stamped 'NBD-'
 *   - an existing lead / preset customerId is never overwritten, no number burned
 *   - mint failure still creates the lead (without a customerId)
 *   - formatting is byte-identical to the client mint (company-profile.js)
 *
 * Zero deps: fake Firestore with a buffered transaction. Run:
 *   node tests/customer-id-mint.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'functions', 'customer-id-mint.js'));
const { custIdSalt, formatCustomerId } = require(path.join(ROOT, 'functions', 'customer-id.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
}

const OWNER = 'ownerUid_NBD';
const quietLog = () => { const l = { warns: [] }; l.warn = (m, d) => l.warns.push({ m, d }); l.info = () => {}; l.error = () => {}; return l; };

// Minimal Firestore: store keyed by 'coll/id'; runTransaction buffers writes
// and applies them only if the callback resolves (atomic, like the real one).
function makeDb(seed, faults) {
  const store = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  faults = faults || {};
  let autoId = 0;
  const alreadyExists = (p) => Object.assign(new Error('6 ALREADY_EXISTS: ' + p), { code: 6 });
  const snapOf = (p) => ({ exists: store.has(p), data: () => (store.has(p) ? JSON.parse(JSON.stringify(store.get(p))) : undefined) });
  function ref(coll, id) {
    const p = coll + '/' + id;
    return {
      id, path: p,
      async get() {
        if (faults.getFails && faults.getFails(p)) throw new Error('UNAVAILABLE: read ' + p);
        return snapOf(p);
      },
      async create(data) {
        if (store.has(p)) throw alreadyExists(p);
        store.set(p, JSON.parse(JSON.stringify(data)));
      },
    };
  }
  const db = {
    store,
    txCount: 0,
    collection(coll) {
      return { doc: (id) => ref(coll, id === undefined ? 'auto' + (++autoId) : String(id)) };
    },
    async runTransaction(fn) {
      db.txCount++;
      if (faults.txFails) throw new Error('ABORTED: contention');
      const writes = [];
      let wrote = false;
      const tx = {
        async get(r) {
          if (wrote) throw new Error('reads must precede writes');
          if (faults.getFails && faults.getFails(r.path)) throw new Error('UNAVAILABLE: read ' + r.path);
          return snapOf(r.path);
        },
        set(r, data, opts) { wrote = true; writes.push(['set', r.path, data, opts]); },
        create(r, data) { wrote = true; writes.push(['create', r.path, data]); },
      };
      const out = await fn(tx);
      // All-or-nothing: a create that would collide aborts the whole commit.
      for (const [op, p] of writes) if (op === 'create' && store.has(p)) throw alreadyExists(p);
      for (const [op, p, data, opts] of writes) {
        if (op === 'create') {
          store.set(p, JSON.parse(JSON.stringify(data)));
        } else {
          const base = (opts && opts.merge && store.has(p)) ? store.get(p) : {};
          store.set(p, Object.assign({}, base, JSON.parse(JSON.stringify(data))));
        }
      }
      return out;
    },
  };
  return db;
}

function loadClientProfile() {
  const src = fs.readFileSync(path.join(ROOT, 'docs/pro/js', 'company-profile.js'), 'utf8');
  const store = {};
  const localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const win = { addEventListener() {}, removeEventListener() {}, localStorage };
  win.window = win;
  vm.runInNewContext(src, { window: win, localStorage, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON }, { filename: 'company-profile.js' });
  return win;
}

(async () => {
  const lead = (companyId, extra) => Object.assign({ firstName: 'Pat', lastName: 'Q', stage: 'new', userId: companyId, companyId }, extra || {});
  const leadsRef = (db, id) => db.collection('leads').doc(id);

  console.log('NBD owner — sequential, un-salted, continues the live counter');
  {
    const db = makeDb({ 'counters/customerIds': { next: 265 }, [`companyProfile/${OWNER}`]: { brand: { legalName: 'No Big Deal Home Solutions' } } });
    const a = await M.createLeadWithCustomerId(db, leadsRef(db, 'contact__a'), lead(OWNER), { nbdOwnerUid: OWNER, logger: quietLog() });
    const b = await M.createLeadWithCustomerId(db, leadsRef(db, 'calcom__b'), lead(OWNER), { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('first lead gets NBD-0266', a.customerId === 'NBD-0266', a);
    ok('second lead gets NBD-0267', b.customerId === 'NBD-0267', b);
    ok('customerId is written ON the lead doc', db.store.get('leads/contact__a').customerId === 'NBD-0266');
    ok('shared counter advanced to 267', db.store.get('counters/customerIds').next === 267);
    ok('NBD format is exactly NBD-#### (no salt)', /^NBD-\d{4}$/.test(a.customerId) && /^NBD-\d{4}$/.test(b.customerId));
    ok('lead fields survive the mint', db.store.get('leads/calcom__b').firstName === 'Pat' && db.store.get('leads/calcom__b').companyId === OWNER);
  }

  console.log('NBD owner with no profile doc and no counter yet');
  {
    const db = makeDb({});
    const r = await M.createLeadWithCustomerId(db, leadsRef(db, 'x'), lead(OWNER), { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('missing counter starts at NBD-0001 (client: nextNum = 1)', r.customerId === 'NBD-0001', r);
  }

  console.log('Other tenants — salted, own counter');
  {
    const db = makeDb({
      'counters/customerIds': { next: 265 },
      'counters/customerIds_co-oak': { next: 4 },
      'companyProfile/co-oak': { brand: { legalName: 'Oaks Roofing LLC', docPrefix: 'OAK' } },
      'companyProfile/co-derived': { brand: { legalName: 'Summit Exteriors' } },
    });
    const r = await M.createLeadWithCustomerId(db, leadsRef(db, 'o1'), lead('co-oak'), { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('reserved prefix + salt: OAK-0005-<salt>', r.customerId === 'OAK-0005-' + custIdSalt('co-oak'), r);
    ok('salted format shape', /^OAK-\d{4}-[0-9A-Z]{4}$/.test(r.customerId));
    ok('tenant counter advanced', db.store.get('counters/customerIds_co-oak').next === 5);
    ok('NBD shared counter untouched', db.store.get('counters/customerIds').next === 265);

    const d = await M.createLeadWithCustomerId(db, leadsRef(db, 'd1'), lead('co-derived'), { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('unreserved tenant: derived prefix, salted, own counter', d.customerId === 'SE-0001-' + custIdSalt('co-derived'), d);
    ok('derived tenant minted from customerIds_co-derived', db.store.get('counters/customerIds_co-derived').next === 1);
  }

  console.log('Platform-identity veto — an unprovisioned tenant is never stamped NBD-');
  {
    const db = makeDb({ 'counters/customerIds': { next: 265 }, 'companyProfile/co-new': { brand: {} } });
    const log = quietLog();
    const r = await M.createLeadWithCustomerId(db, leadsRef(db, 'n1'), lead('co-new'), { nbdOwnerUid: OWNER, logger: log });
    ok('no customerId minted', r.customerId === null, r);
    ok('lead still created, without customerId', db.store.has('leads/n1') && !('customerId' in db.store.get('leads/n1')));
    ok('shared NBD counter untouched', db.store.get('counters/customerIds').next === 265);
    const r2 = await M.createLeadWithCustomerId(db, leadsRef(db, 'n2'), lead(''), { nbdOwnerUid: OWNER, logger: log });
    ok('a lead with no companyId is created un-minted', r2.customerId === null && db.store.has('leads/n2'));
  }

  console.log('Never overwrite');
  {
    const db = makeDb({
      'counters/customerIds': { next: 265 },
      'leads/contact__dup': { firstName: 'Edited by Jo', customerId: 'NBD-0007', companyId: OWNER },
    });
    let err = null;
    try { await M.createLeadWithCustomerId(db, leadsRef(db, 'contact__dup'), lead(OWNER), { nbdOwnerUid: OWNER, logger: quietLog() }); } catch (e) { err = e; }
    ok('redelivery throws ALREADY_EXISTS (code 6), same contract as ref.create()', !!err && err.code === 6 && M.isAlreadyExists(err), err && err.message);
    ok('existing lead untouched — customerId kept', db.store.get('leads/contact__dup').customerId === 'NBD-0007');
    ok('existing lead untouched — rep edits kept', db.store.get('leads/contact__dup').firstName === 'Edited by Jo');
    ok('no number burned on a redelivery', db.store.get('counters/customerIds').next === 265);

    const pre = await M.createLeadWithCustomerId(db, leadsRef(db, 'preset'), lead(OWNER, { customerId: 'NBD-0042' }), { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('a preset customerId is kept as-is', pre.customerId === 'NBD-0042' && db.store.get('leads/preset').customerId === 'NBD-0042');
    ok('preset path mints nothing', db.store.get('counters/customerIds').next === 265 && db.txCount === 1);
  }

  console.log('Failure-tolerant — the lead always lands');
  {
    const db = makeDb({ 'counters/customerIds': { next: 265 } }, { txFails: true });
    const log = quietLog();
    const r = await M.createLeadWithCustomerId(db, leadsRef(db, 'f1'), lead(OWNER), { nbdOwnerUid: OWNER, logger: log });
    ok('transaction failure → customerId null', r.customerId === null, r);
    ok('transaction failure → lead created without customerId', db.store.has('leads/f1') && !('customerId' in db.store.get('leads/f1')));
    ok('transaction failure is logged', log.warns.some((w) => /mint transaction failed/.test(w.m)));
    ok('counter untouched after failed transaction', db.store.get('counters/customerIds').next === 265);
  }
  {
    const db = makeDb({ 'counters/customerIds': { next: 265 } }, { getFails: (p) => p.startsWith('companyProfile/') });
    const log = quietLog();
    const r = await M.createLeadWithCustomerId(db, leadsRef(db, 'f2'), lead(OWNER), { nbdOwnerUid: OWNER, logger: log });
    ok('profile read failure → lead created without customerId', r.customerId === null && db.store.has('leads/f2'));
    ok('profile read failure is logged', log.warns.some((w) => /profile read failed/.test(w.m)));
  }
  {
    const db = makeDb({ 'counters/customerIds': { next: 265 } }, { txFails: true });
    let err = null;
    db.store.set('leads/f3', { customerId: 'NBD-0100' });
    try { await M.createLeadWithCustomerId(db, leadsRef(db, 'f3'), lead(OWNER), { nbdOwnerUid: OWNER, logger: quietLog() }); } catch (e) { err = e; }
    ok('fallback create still refuses to overwrite an existing lead', !!err && err.code === 6 && db.store.get('leads/f3').customerId === 'NBD-0100');
  }

  console.log('mintCustomerId (standalone)');
  {
    const db = makeDb({ 'counters/customerIds': { next: 9 } });
    const brand = { legalName: 'No Big Deal Home Solutions' };
    const a = await M.mintCustomerId(db, OWNER, brand, { nbdOwnerUid: OWNER, logger: quietLog() });
    const b = await M.mintCustomerId(db, OWNER, brand, { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('sequential standalone mints', a === 'NBD-0010' && b === 'NBD-0011', [a, b]);
    const bad = await M.mintCustomerId(makeDb({}, { txFails: true }), OWNER, brand, { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('standalone failure returns null, never throws', bad === null);
    const veto = await M.mintCustomerId(db, 'co-new', {}, { nbdOwnerUid: OWNER, logger: quietLog() });
    ok('standalone veto returns null for an unprovisioned tenant', veto === null && db.store.get('counters/customerIds').next === 11);
  }

  console.log('Byte-compat with the client mint (company-profile.js)');
  {
    const win = loadClientProfile();
    const cases = [['NBD', 266, OWNER], ['NBD', 1, 'anything'], ['OAK', 5, 'co-oak'], ['SE', 1234, 'co-derived'], ['CUS', 12, 'xYz_123']];
    const hasClient = typeof win._formatCustomerId === 'function';
    ok('client exposes window._formatCustomerId', hasClient);
    if (hasClient) {
      for (const [p, n, c] of cases) {
        ok(`client == server for (${p}, ${n}, ${c})`, win._formatCustomerId(p, n, c) === formatCustomerId(p, n, c), [win._formatCustomerId(p, n, c), formatCustomerId(p, n, c)]);
      }
    }
  }

  console.log('Every server lead creator routes through the mint');
  {
    const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const callers = {
      'functions/lead-bridge.js': /createLeadWithCustomerId\(db, db\.collection\('leads'\)\.doc\(id\)/,
      'functions/integrations/calcom.js': /createLeadWithCustomerId\(db, db\.collection\('leads'\)\.doc\(newLeadId\)/,
      'functions/integrations/thursday.js': /createLeadWithCustomerId\(db\(\), db\(\)\.doc\('leads\/' \+ leadId\)/,
      'functions/referrals.js': /createLeadWithCustomerId\(db, ref, leadData\)/,
      'functions/handlers/inbound-sms-convert.js': /createLeadWithCustomerId\(db, created,/,
    };
    for (const [file, re] of Object.entries(callers)) {
      const src = strip(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      ok(file + ' creates its lead via createLeadWithCustomerId', re.test(src));
      ok(file + ' has no bare leads create()/add()', !/collection\('leads'\)\.(add\(|doc\([^)]*\)\.create\()/.test(src) && !/createIfAbsent\(db\(\)\.doc\('leads\/' \+ leadId\),/.test(src));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
