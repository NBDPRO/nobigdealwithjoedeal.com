#!/usr/bin/env node
/**
 * list_leads paging (2026-10-06). The bot tool returned one page (max 50) with
 * no way to see the rest — NBD has 76 leads in 'new', so the office sweep
 * could not see 26 of them and mis-reported them. Now list_leads takes an
 * opaque `cursor`, returns `next_cursor` (null on the last page) and `total`,
 * in a stable order (createdAt desc, lead id tiebreak).
 *
 *   A. pure paging (agent-mcp-logic.js listLeadsPage): every match exactly
 *      once over >2 pages, default and max page size, ties + missing
 *      createdAt, a lead edited / deleted between pages, total, stage filter
 *      on the canonical key (same buckets as crm_summary), stale filter
 *   B. cursors: malformed, tampered, other filter, other company, wrong type —
 *      all refused with no rows
 *   C. minimization: no phone / email / FORBIDDEN_KEYS on any page
 *   D. the real handler (in-memory Firestore): Marcus pages all 76 through
 *      /api/mcp, the cursor is bound to the key's company, the tool
 *      description tells bots to page, server version 1.3.0
 *
 * Run: node tests/agent-list-leads-paging-2026-10-06.test.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const Module = require('module');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// ── In-memory Firestore (equality filters only — all agent-mcp.js needs here)
function fakeDb() {
  const docs = new Map();
  let auto = 0;
  const snap = (p) => ({ id: p.split('/').pop(), ref: mk(p), exists: docs.has(p), data: () => docs.get(p) });
  function mk(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: async () => snap(p),
      set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : Object.assign({}, v)); },
      update: async (v) => { docs.set(p, Object.assign({}, docs.get(p) || {}, v)); },
      collection: (n) => coll(p + '/' + n),
    };
  }
  function query(cp, filters, lim) {
    return {
      where: (f, op, v) => query(cp, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(cp, filters, lim),
      limit: (n) => query(cp, filters, n),
      get: async () => {
        const depth = cp.split('/').length + 1;
        const rows = [...docs.keys()].filter((k) => k.startsWith(cp + '/') && k.split('/').length === depth
          && filters.every(([f, op, v]) => op === '==' && docs.get(k) && docs.get(k)[f] === v)).slice(0, lim || 1e9).map(snap);
        return { docs: rows, size: rows.length, empty: rows.length === 0, forEach: (fn) => rows.forEach(fn) };
      },
    };
  }
  function coll(cp) {
    return Object.assign(query(cp, [], null), {
      doc: (id) => mk(cp + '/' + (id || 'auto' + (++auto))),
      add: async (v) => { const r = mk(cp + '/auto' + (++auto)); await r.set(v); return r; },
    });
  }
  return { docs, doc: mk, collection: coll, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, v, o) => r.set(v, o), update: (r, v) => r.update(v) }) };
}
let DB = fakeDb();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp: () => ({ toMillis: () => Date.now() }) } };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const L = require(path.join(ROOT, 'functions', 'agent-mcp-logic.js'));
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ── Fixture: 76 'new' (three spellings of the stage), 30 contacted, ties,
// leads with no createdAt, deleted + test leads, every one with phone/email.
const BASE = Date.parse('2026-01-01T00:00:00Z');
function fixture() {
  const out = [];
  const spell = ['new', 'New', ''];
  for (let i = 0; i < 76; i++) {
    out.push({
      id: 'n' + String(i).padStart(3, '0'), firstName: 'New' + i, lastName: 'Lead', address: i + ' Elm St',
      stage: spell[i % 3], phone: '51355501' + String(i).padStart(2, '0'), email: 'new' + i + '@example.test',
      phone2: '8595550000', altPhone: '8595550001', claimNumber: 'CLM-' + i, policyNumber: 'POL-' + i, ssn: '000-00-0000', dob: '1970-01-01',
      // groups of 4 share a createdAt (tiebreak by id); 6 have none at all
      createdAt: i < 6 ? undefined : BASE + Math.floor(i / 4) * 3600000,
      updatedAt: BASE + i * 1000,
    });
  }
  for (let i = 0; i < 30; i++) out.push({ id: 'c' + String(i).padStart(3, '0'), firstName: 'Con' + i, stage: 'contacted', phone: '5130000000', email: 'c@example.test', createdAt: BASE + i * 7200000, updatedAt: BASE });
  out.push({ id: 'zdel', stage: 'new', deleted: true, createdAt: BASE });
  out.push({ id: 'ztest', stage: 'new', e2eTestData: true, createdAt: BASE });
  // Firestore hands docs back in no promised order: shuffle (seeded) so the
  // id tiebreak — not insertion order — is what keeps ties stable.
  let seed = 7;
  for (let i = out.length - 1; i > 0; i--) { seed = (seed * 48271) % 2147483647; const j = seed % (i + 1); const t = out[i]; out[i] = out[j]; out[j] = t; }
  return out;
}
function pageAll(leads, args, scope, mutate) {
  const seen = [];
  let cursor; let pages = 0; let total = null; let err = null;
  do {
    const p = L.listLeadsPage(leads, Object.assign({}, args, cursor ? { cursor } : {}), Date.parse('2026-10-06'), scope);
    if (p.error) { err = p.error; break; }
    pages++; total = p.total;
    p.customers.forEach((c) => seen.push(c));
    cursor = p.next_cursor;
    if (mutate && cursor) mutate(pages);
    if (pages > 100) { err = 'runaway'; break; }
  } while (cursor);
  return { seen, pages, total, err };
}
const ids = (rows) => rows.map((r) => r.lead_id);
const uniq = (a) => new Set(a).size === a.length;
const FORBIDDEN_RE = /5135550|859555000|example\.test|CLM-|POL-|000-00-0000|1970-01-01/;

(async () => {
  console.log('A. paging');
  const leads = fixture();
  const expectNew = leads.filter((l) => !l.deleted && !l.e2eTestData && /^(new|New|)$/.test(l.stage)).map((l) => l.id).sort();
  const d = pageAll(leads, { stage: 'new' }, 'coNBD');
  ok('default page (20): all 76 new leads, each exactly once, over 4 pages', !d.err && d.seen.length === 76 && uniq(ids(d.seen)) && ids(d.seen).slice().sort().join() === expectNew.join() && d.pages === 4, JSON.stringify({ err: d.err, n: d.seen.length, pages: d.pages }));
  ok('total = 76 on every page (count of the filter, not the page)', d.total === 76);
  const big = pageAll(leads, { stage: 'new', limit: 50 }, 'coNBD');
  ok('limit 50: 50 + 26 = 76, 2 pages, no duplicates', !big.err && big.pages === 2 && big.seen.length === 76 && uniq(ids(big.seen)));
  const small = pageAll(leads, { stage: 'new', limit: 7 }, 'coNBD');
  ok('limit 7: 11 pages, still all 76 once (ties + no-createdAt rows cross page edges)', !small.err && small.pages === 11 && small.seen.length === 76 && uniq(ids(small.seen)));
  ok('limit above 50 is still capped at 50', L.listLeadsPage(leads, { stage: 'new', limit: 500 }, 0, 'coNBD').customers.length === 50);
  const first = L.listLeadsPage(leads, { stage: 'new' }, 0, 'coNBD');
  ok('order: newest added first, id tiebreak, no-createdAt last', ids(first.customers).slice(0, 4).join() === 'n072,n073,n074,n075' && ids(small.seen).slice(-6).join() === 'n000,n001,n002,n003,n004,n005', ids(first.customers).slice(0, 4).join() + ' … ' + ids(small.seen).slice(-6).join());
  ok('first page has a next_cursor; the last page has null', typeof first.next_cursor === 'string' && first.next_cursor.length > 0
    && L.listLeadsPage(leads, { stage: 'new', limit: 50, cursor: L.listLeadsPage(leads, { stage: 'new', limit: 50 }, 0, 'coNBD').next_cursor }, 0, 'coNBD').next_cursor === null);
  ok('exactly one full page → no next_cursor (no empty extra page)', L.listLeadsPage(leads, { stage: 'contacted', limit: 30 }, 0, 'coNBD').next_cursor === null);
  ok('a filter with nothing → empty, total 0, null cursor', (() => { const p = L.listLeadsPage(leads, { stage: 'negotiating' }, 0, 'coNBD'); return p.customers.length === 0 && p.total === 0 && p.next_cursor === null; })());
  // Edits between pages: updatedAt changes do not move a lead (order is by createdAt).
  const live = fixture();
  const edited = pageAll(live, { stage: 'new', limit: 10 }, 'coNBD', (n) => { live.forEach((l) => { if (l.stage !== 'contacted') l.updatedAt = Date.now() + n; }); });
  ok('leads edited between pages: still every one once', !edited.err && edited.seen.length === 76 && uniq(ids(edited.seen)));
  const shrink = fixture();
  // After page 1 delete the LAST row it showed (the cursor's own lead) and one not yet seen.
  let lastShown = null;
  const del = pageAll(shrink, { stage: 'new', limit: 10 }, 'coNBD', (n) => {
    if (n !== 1) return;
    const p1 = L.listLeadsPage(fixture(), { stage: 'new', limit: 10 }, 0, 'coNBD').customers;
    lastShown = p1[p1.length - 1].lead_id;
    shrink.forEach((l) => { if (l.id === lastShown || l.id === 'n010') l.deleted = true; });
  });
  const delIds = ids(del.seen);
  ok('leads deleted between pages (incl. the cursor\'s own lead): the other 75 all there, none twice', !del.err && uniq(delIds) && delIds.length === 75 && delIds.indexOf('n010') === -1 && delIds.indexOf(lastShown) !== -1, del.err + ' ' + delIds.length);
  ok('total agrees with crm_summary by_stage.new', L.summary(leads, '2026-10-06').by_stage.new === d.total, JSON.stringify(L.summary(leads, '2026-10-06').by_stage));
  ok('stage "New" (as stored) = the same 76', L.listLeadsPage(leads, { stage: 'New' }, 0, 'coNBD').total === 76);
  ok('no stage → every active lead (106), deleted + test leads out', L.listLeadsPage(leads, {}, 0, 'coNBD').total === 106);
  const stale = L.listLeadsPage([{ id: 's1', stage: 'new', updatedAt: Date.parse('2026-01-01') }, { id: 's2', stage: 'new', updatedAt: Date.parse('2026-10-05') }, { id: 's3', stage: 'closed', updatedAt: Date.parse('2026-01-01') }], { stale_days: 30 }, Date.parse('2026-10-06'), 'x');
  ok('stale_days still filters (open + not updated), total follows the filter', ids(stale.customers).join() === 's1' && stale.total === 1);
  ok('listLeads (first page rows) still works', L.listLeads(leads, { stage: 'new' }, 0, 'coNBD').length === 20);

  console.log('B. cursors');
  const good = first.next_cursor;
  const decoded = JSON.parse(Buffer.from(good, 'base64url').toString('utf8'));
  const enc = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  const refused = (args, scope) => { const p = L.listLeadsPage(leads, args, 0, scope || 'coNBD'); return !!p.error && !p.customers && /cursor/i.test(p.error); };
  ok('the good cursor continues (sanity)', !L.listLeadsPage(leads, { stage: 'new', cursor: good }, 0, 'coNBD').error);
  ok('garbage string refused', refused({ stage: 'new', cursor: 'not a cursor!!' }));
  ok('base64 of non-JSON refused', refused({ stage: 'new', cursor: Buffer.from('hello').toString('base64url') }));
  ok('JSON array refused', refused({ stage: 'new', cursor: enc([1, 2]) }));
  ok('edited position (k) refused', refused({ stage: 'new', cursor: enc(Object.assign({}, decoded, { k: decoded.k - 1 })) }));
  ok('edited lead id refused', refused({ stage: 'new', cursor: enc(Object.assign({}, decoded, { i: 'n000' })) }));
  ok('edited tag refused', refused({ stage: 'new', cursor: enc(Object.assign({}, decoded, { t: '0'.repeat(24) })) }));
  ok('extra field refused', refused({ stage: 'new', cursor: enc(Object.assign({}, decoded, { companyId: 'coB' })) }));
  ok('wrong version refused', refused({ stage: 'new', cursor: enc(Object.assign({}, decoded, { v: 2 })) }));
  ok('id with path / markup chars refused', refused({ stage: 'new', cursor: enc(Object.assign({}, decoded, { i: '../x<b>' })) }));
  ok('a cursor from another filter (stage) refused', refused({ stage: 'contacted', cursor: good }));
  ok('a cursor from another filter (stale_days) refused', refused({ stage: 'new', stale_days: 5, cursor: good }));
  ok('a cursor from another company refused', refused({ stage: 'new', cursor: good }, 'coB'));
  ok('non-string cursor refused', refused({ stage: 'new', cursor: { k: 1 } }) && refused({ stage: 'new', cursor: 12345 }));
  ok('oversize cursor refused', refused({ stage: 'new', cursor: 'A'.repeat(L.LIST_CURSOR_MAX + 1) }));
  ok('non-string stage refused', !!L.listLeadsPage(leads, { stage: { $ne: 1 } }, 0, 'coNBD').error);

  console.log('C. minimization');
  const allText = JSON.stringify(small.seen) + JSON.stringify(L.listLeadsPage(leads, {}, 0, 'coNBD'));
  ok('no phone / email / claim / policy / ssn / dob on any page', !FORBIDDEN_RE.test(allText), (allText.match(FORBIDDEN_RE) || [])[0]);
  ok('no FORBIDDEN_KEYS on any row', small.seen.every((r) => L.FORBIDDEN_KEYS.every((k) => !(k in r))));
  ok('page shape is customers + total + next_cursor + page_size only', Object.keys(first).sort().join() === 'customers,next_cursor,page_size,total');

  console.log('D. the real handler');
  const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
  const MARCUS = 'nbdk_jo_marcus_key_000000000000000';
  const OTHER = 'nbdk_coA_bot_key_00000000000000000';
  DB.docs.set('agent_keys/' + sha(MARCUS), { botId: 'marcus', botName: 'Marcus · NBD Ops', companyId: NBD, active: true, prefix: 'nbdk_jo_m', createdBy: NBD });
  DB.docs.set('agent_keys/' + sha(OTHER), { botId: 'marcus', botName: 'Marcus', companyId: 'coA', active: true, prefix: 'nbdk_coA_', createdBy: 'ownerA' });
  DB.docs.set('subscriptions/coA', { status: 'active', plan: 'team' });
  fixture().forEach((l) => { const v = Object.assign({ companyId: NBD, userId: NBD }, l); Object.keys(v).forEach((k) => v[k] === undefined && delete v[k]); DB.docs.set('leads/' + l.id, v); });
  for (let i = 0; i < 5; i++) DB.docs.set('leads/a' + i, { companyId: 'coA', userId: 'ownerA', firstName: 'A' + i, stage: 'new', createdAt: BASE, phone: '5130001111' });
  async function http(key, body) {
    const req = { method: 'POST', headers: { authorization: 'Bearer ' + key }, body, get(h) { return this.headers[String(h).toLowerCase()]; }, header(h) { return this.get(h); } };
    const res = { code: 200, body: null, hdr: {}, set(k, v) { this.hdr[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
    await M.crmMcp(req, res);
    return res;
  }
  async function tool(key, args) {
    const r = await http(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_leads', arguments: args } });
    const res = r.body && r.body.result;
    if (!res) return { error: r.body };
    let json = null; try { json = JSON.parse(res.content[0].text); } catch (_) { json = null; }
    return { isError: res.isError === true, text: res.content[0].text, json };
  }
  const got = []; let cur = null; let pages = 0; let lastTotal = null; let texts = '';
  do {
    const r = await tool(MARCUS, Object.assign({ stage: 'new', limit: 20 }, cur ? { cursor: cur } : {}));
    if (!r.json) { ok('handler page ' + (pages + 1) + ' answered', false, JSON.stringify(r).slice(0, 300)); break; }
    texts += r.text; pages++; lastTotal = r.json.total;
    r.json.customers.forEach((c) => got.push(c.lead_id));
    cur = r.json.next_cursor;
  } while (cur && pages < 20);
  ok('Marcus pages all 76 new leads through /api/mcp, none twice, NBD only', got.length === 76 && uniq(got) && got.every((x) => /^n\d{3}$/.test(x)) && pages === 4, got.length + ' in ' + pages);
  ok('handler total = 76', lastTotal === 76);
  ok('handler pages carry no phone / email', !FORBIDDEN_RE.test(texts) && !/5130001111/.test(texts));
  const p1 = await tool(MARCUS, { stage: 'new' });
  const cross = await tool(OTHER, { stage: 'new', cursor: p1.json && p1.json.next_cursor });
  ok('an NBD cursor used with another company\'s key is refused', cross.isError === true && /cursor/i.test(cross.text), JSON.stringify(cross).slice(0, 200));
  const forged = await tool(MARCUS, { stage: 'new', cursor: 'eyJ2IjoxfQ' });
  ok('a forged cursor through the handler is an error, not data', forged.isError === true && !forged.json);
  const tl = await http(MARCUS, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const ll = tl.body && tl.body.result && tl.body.result.tools.find((t) => t.name === 'list_leads');
  ok('tools/list: list_leads takes cursor and tells bots to follow next_cursor', !!ll && ll.inputSchema.properties.cursor && ll.inputSchema.properties.cursor.type === 'string' && /next_cursor/.test(ll.description) && /total/.test(ll.description) && /null/.test(ll.description) && ll.inputSchema.additionalProperties === false);
  ok('list_leads still only for bots that had it (Marcus, Quinn, Tucker; not CoS)', ['marcus', 'quinn', 'tucker'].every((b) => L.botAllows(b, 'list_leads')) && !L.botAllows('cos', 'list_leads'));
  ok('server version 1.3.0 (list_leads paging)', L.SERVER_INFO.version === '1.3.0');
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'agent-mcp.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  ok('handler passes the key\'s company as the cursor scope', /L\.listLeadsPage\(\s*await companyLeads\(company\)\s*,\s*args\s*,\s*Date\.now\(\)\s*,\s*company\s*\)/.test(src));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
