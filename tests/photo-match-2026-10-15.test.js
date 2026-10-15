#!/usr/bin/env node
/**
 * tests/photo-match-2026-10-15.test.js — the CRM MCP tool match_photo_location.
 *
 * Marcus's local photo intake (nbd-agents media agent) sends each photo's EXIF
 * GPS + time; the CRM answers which of the company's located customers had
 * work on the calendar then, within radius_m. The answer never carries the
 * customer's coordinates, street, phone or email.
 *
 *   A. the tool: schema, read-only, Marcus only among the house bots
 *   B. validation: array cap (200), lat / lng / taken_at, radius_m and window_hours ranges
 *   C. matching: in / out of radius, nearest first, one row per customer,
 *      distance in 10 m steps, window edges (single day, multi-day job, the
 *      adjuster meeting, a job on leads/{id}/jobs, an appointment)
 *   D. no PII in the output
 *   E. the real handler over an in-memory Firestore: another company's
 *      customer never matches (even at the same spot and day), another
 *      company's appointment never brings in a customer, the points are not
 *      written anywhere, a bot outside the role is refused
 *
 * Run: node tests/photo-match-2026-10-15.test.js
 *      (needs functions/node_modules, like agent-drafts-2026-10-06)
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
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// ── In-memory Firestore (the agent-drafts-2026-10-06 idiom + collectionGroup) ──
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
const M = require(path.join(ROOT, 'functions', 'agent-mcp.js'));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const TZ = 'America/New_York';
const HOUSE = { lat: 39.0, lng: -84.6 };
const north = (m) => ({ lat: HOUSE.lat + m / 111195, lng: HOUSE.lng });   // ~1 m of latitude per 1/111195°
const et = (ymd, hm) => { const [h, mi] = hm.split(':'); const off = ymd >= '2026-11-01' ? '-05:00' : '-04:00'; return ymd + 'T' + h + ':' + mi + ':00' + off; };
const pt = (loc, iso) => ({ lat: loc.lat, lng: loc.lng, taken_at: iso });
const lead = (id, o) => Object.assign({ id, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St, Florence, KY 41042', phone: '(859) 555-0147', email: 'maria@example.test',
  stage: 'install_scheduled', damageType: 'hail', jobType: 'roof_replacement', lat: HOUSE.lat, lng: HOUSE.lng }, o || {});
const run = (leads, args, extra) => L.matchPhotoLocation(leads, (extra && extra.jobs) || null, (extra && extra.appts) || [], args, TZ);
const m0 = (r, i) => (r.points && r.points[i || 0] ? r.points[i || 0].matches : null);

(async () => {
  console.log('A. the tool');
  {
    const t = L.TOOLS.match_photo_location;
    ok('match_photo_location is a tool with a closed object schema, points required', !!t && t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false && t.inputSchema.required.join() === 'points');
    ok('the schema states the caps: 200 points, radius 10..300, window 0..72', t.inputSchema.properties.points.maxItems === 200 && t.inputSchema.properties.radius_m.maximum === 300 && t.inputSchema.properties.window_hours.maximum === 72);
    ok('read-only (annotation) and not a filing', L.annotationsFor('match_photo_location').readOnlyHint === true && L.WRITES.indexOf('match_photo_location') === -1);
    ok('Marcus has it; no other house bot does', Object.keys(L.BOTS).filter((b) => L.botAllows(b, 'match_photo_location')).join() === 'marcus');
    ok('the personal bots never do', !L.botAllows('coach', 'match_photo_location') && !L.botAllows('board', 'match_photo_location'));
    ok('the Settings label exists', /match_photo_location: 'Match photos to customers'/.test(read('docs/pro/js/agent-bots-settings.js')));
  }

  console.log('B. validation');
  {
    const P = pt(HOUSE, et('2026-10-20', '10:00'));
    const bad = (args) => (run([lead('a', { scheduledDate: '2026-10-20' })], args).error || '');
    ok('points missing / empty / not an array → refused', /non-empty array/.test(bad({})) && /non-empty array/.test(bad({ points: [] })) && /non-empty array/.test(bad({ points: 'x' })));
    ok('200 points accepted, 201 refused (the cap)', !run([], { points: Array(200).fill(P) }).error && /at most 200/.test(bad({ points: Array(201).fill(P) })));
    ok('lat / lng out of range or not numbers → refused, naming the point', /points\[1\]: lat/.test(bad({ points: [P, { lat: 91, lng: 0, taken_at: P.taken_at }] }))
      && /points\[0\]: lat/.test(bad({ points: [{ lat: 39, lng: -181, taken_at: P.taken_at }] })) && /points\[0\]: lat/.test(bad({ points: [{ lat: '39', lng: -84, taken_at: P.taken_at }] }))
      && /points\[0\]: lat/.test(bad({ points: [{ lat: NaN, lng: -84, taken_at: P.taken_at }] })));
    ok('taken_at missing or not ISO → refused', /taken_at/.test(bad({ points: [{ lat: 39, lng: -84 }] })) && /taken_at/.test(bad({ points: [{ lat: 39, lng: -84, taken_at: 'yesterday' }] }))
      && /taken_at/.test(bad({ points: [{ lat: 39, lng: -84, taken_at: 1760000000000 }] })));
    ok('a point that is not an object → refused', /points\[0\] must be/.test(bad({ points: [null] })) && /points\[0\] must be/.test(bad({ points: [[39, -84]] })));
    ok('radius_m outside 10..300 → refused; 300 accepted', /radius_m/.test(bad({ points: [P], radius_m: 301 })) && /radius_m/.test(bad({ points: [P], radius_m: 5 })) && /radius_m/.test(bad({ points: [P], radius_m: '150' }))
      && !run([], { points: [P], radius_m: 300 }).error);
    ok('window_hours outside 0..72 → refused; 0 accepted', /window_hours/.test(bad({ points: [P], window_hours: 73 })) && /window_hours/.test(bad({ points: [P], window_hours: -1 })) && !run([], { points: [P], window_hours: 0 }).error);
    ok('EXIF-style local time (no offset) is the company\'s wall clock, not UTC', L.photoTimeMs('2026-10-20T10:00:00', TZ) === Date.parse('2026-10-20T14:00:00Z')
      && L.photoTimeMs('2026-10-20T10:00:00Z', TZ) === Date.parse('2026-10-20T10:00:00Z') && L.photoTimeMs('2026-10-20T10:00:00-04:00', TZ) === Date.parse('2026-10-20T14:00:00Z'));
  }

  console.log('C. matching');
  {
    const leads = [lead('a', { scheduledDate: '2026-10-20' })];
    let r = run(leads, { points: [pt(north(90), et('2026-10-20', '11:00')), pt(north(400), et('2026-10-20', '11:00'))] });
    ok('within 150 m → one match; 400 m away → none', m0(r, 0).length === 1 && m0(r, 0)[0].lead_id === 'a' && m0(r, 1).length === 0, JSON.stringify(r));
    ok('distance in 10 m steps (90 m → 90)', m0(r, 0)[0].distance_m === 90, JSON.stringify(m0(r, 0)));
    ok('per point: index + matches, nothing else', r.points.every((p, i) => p.index === i && Object.keys(p).sort().join() === 'index,matches') && Object.keys(r).join() === 'points');
    ok('a match: lead_id, label, distance_m, stage — nothing else', Object.keys(m0(r, 0)[0]).sort().join() === 'distance_m,label,lead_id,stage');
    ok('label is "First L. · Town · job type"', m0(r, 0)[0].label === 'Maria L. · Florence · Roof replacement', m0(r, 0)[0].label);
    ok('radius_m widens and narrows it (400 m matches at 300? no; 90 m at 50? no)', m0(run(leads, { points: [pt(north(400), et('2026-10-20', '11:00'))], radius_m: 300 }), 0).length === 0
      && m0(run(leads, { points: [pt(north(90), et('2026-10-20', '11:00'))], radius_m: 50 }), 0).length === 0 && m0(run(leads, { points: [pt(north(250), et('2026-10-20', '11:00'))], radius_m: 300 }), 0).length === 1);
    const two = [lead('a', { scheduledDate: '2026-10-20' }), lead('b', { firstName: 'Sam', lastName: 'Ng', scheduledDate: '2026-10-20', lat: north(120).lat, lng: north(120).lng })];
    r = run(two, { points: [pt(north(80), et('2026-10-20', '11:00'))] });
    ok('two customers in range → both, nearest first', m0(r).map((x) => x.lead_id).join() === 'b,a' && m0(r)[0].distance_m === 40 && m0(r)[1].distance_m === 80, JSON.stringify(m0(r)));
    r = run([lead('a', { scheduledDate: '2026-10-20', adjusterMeetingDate: '2026-10-20' })], { points: [pt(HOUSE, et('2026-10-20', '11:00'))] }, { jobs: { a: [{ id: 'j1', scheduledDate: '2026-10-20' }] } });
    ok('one row per customer even when a job, its mirror and an adjuster meeting all cover the day', m0(r).length === 1);
    ok('a customer with no location never matches', m0(run([lead('a', { scheduledDate: '2026-10-20', lat: null, lng: null })], { points: [pt(HOUSE, et('2026-10-20', '11:00'))] })).length === 0
      && m0(run([lead('a', { scheduledDate: '2026-10-20', lat: 0, lng: 0 })], { points: [pt({ lat: 0, lng: 0 }, et('2026-10-20', '11:00'))] })).length === 0);
    ok('a deleted / test-data customer never matches', m0(run([lead('a', { scheduledDate: '2026-10-20', deleted: true }), lead('b', { scheduledDate: '2026-10-20', e2eTestData: true })], { points: [pt(HOUSE, et('2026-10-20', '11:00'))] })).length === 0);
    ok('a customer with nothing on the calendar never matches', m0(run([lead('a', {})], { points: [pt(HOUSE, et('2026-10-20', '11:00'))] })).length === 0);

    // Window edges: [00:00 of the first day, end of the last day + window_hours].
    const one = [lead('a', { scheduledDate: '2026-10-20' })];
    const at = (iso, w) => m0(run(one, Object.assign({ points: [pt(HOUSE, iso)] }, w == null ? {} : { window_hours: w }))).length;
    ok('single day: from 00:00 on the day (and not a second before)', at(et('2026-10-20', '00:00')) === 1 && at('2026-10-19T23:59:59-04:00') === 0);
    ok('single day: until the end of the day + 36 h (default), not a second after', at('2026-10-22T12:00:00-04:00') === 1 && at('2026-10-22T12:00:01-04:00') === 0);
    ok('window_hours 0: the day itself only', at('2026-10-20T23:59:59-04:00', 0) === 1 && at('2026-10-21T00:00:01-04:00', 0) === 0);
    const multi = [lead('a', { scheduledDate: '2026-10-20', scheduledEndDate: '2026-10-22', scheduledStart: '07:00' })];
    const atM = (iso) => m0(run(multi, { points: [pt(HOUSE, iso)] })).length;
    ok('multi-day job: open on day 2 and through the last day + 36 h', atM(et('2026-10-21', '13:00')) === 1 && atM('2026-10-24T12:00:00-04:00') === 1 && atM('2026-10-24T12:00:01-04:00') === 0);
    ok('multi-day job: closed before its first day', atM('2026-10-19T23:00:00-04:00') === 0);
    ok('a job on leads/{id}/jobs (second job, its own days) is a window too', m0(run([lead('a', {})], { points: [pt(HOUSE, et('2026-11-03', '10:00'))] }, { jobs: { a: [{ id: 'j2', scheduledDate: '2026-11-03', title: 'Gutters', stage: 'scheduled' }] } }))[0].label === 'Maria L. · Florence · Gutters');
    ok('the job\'s own property location wins over the customer\'s', m0(run([lead('a', {})], { points: [pt(north(2000), et('2026-11-03', '10:00'))] }, { jobs: { a: [{ id: 'j2', scheduledDate: '2026-11-03', property: north(2010) }] } })).length === 1);
    ok('an adjuster meeting is a window', m0(run([lead('a', { adjusterMeetingDate: '2026-10-25' })], { points: [pt(HOUSE, et('2026-10-25', '15:00'))] })).length === 1);
    const appt = { leadId: 'a', startTime: new Date(et('2026-10-27', '14:00')), status: 'confirmed' };
    ok('an appointment tied to the customer is a window; a cancelled one is not', m0(run([lead('a', {})], { points: [pt(HOUSE, et('2026-10-27', '09:00'))] }, { appts: [appt] })).length === 1
      && m0(run([lead('a', {})], { points: [pt(HOUSE, et('2026-10-27', '09:00'))] }, { appts: [Object.assign({}, appt, { status: 'cancelled' })] })).length === 0);
    ok('an appointment for a lead that is not in this list never brings one in', m0(run([lead('a', {})], { points: [pt(HOUSE, et('2026-10-27', '09:00'))] }, { appts: [Object.assign({}, appt, { leadId: 'zzz' })] })).length === 0);
    ok('town from lead.city first, never a bare street', L.townOf({ city: 'Union', address: '9 Elm St, Florence, KY' }) === 'Union' && L.townOf({ address: '4022 Forest Ave' }) === '' && L.townOf({ address: '4022 Forest Ave, Mason, OH 45040' }) === 'Mason');
  }

  console.log('D. no PII in the output');
  {
    const leads = [lead('a', { scheduledDate: '2026-10-20', lat: 39.012345, lng: -84.612345, zip: '41042' })];
    const r = run(leads, { points: [pt({ lat: 39.0124, lng: -84.6124 }, et('2026-10-20', '11:00'))] });
    const s = JSON.stringify(r);
    ok('matched (sanity)', m0(r).length === 1, s);
    ok('no coordinates, street, phone, email or zip of the customer', !/39\.012345|84\.612345|1420|Oak St|555|0147|example\.test|Lopez|41042/.test(s), s);
    ok('no forbidden key, no lat / lng / address key', L.FORBIDDEN_KEYS.concat(['lat', 'lng', 'address']).every((k) => s.indexOf('"' + k + '"') === -1), s);
  }

  console.log('E. the handler, two companies, in-memory Firestore');
  {
    DB = fakeDb();
    const S = (p, v) => DB.docs.set(p, v);
    const CO = 'coPhotoA', OTHER = 'coPhotoB';
    const KEY = 'nbdk_marcus_photo_' + '0'.repeat(24), TKEY = 'nbdk_tucker_photo_' + '0'.repeat(24);
    S('agent_keys/' + sha(KEY), { botId: 'marcus', botName: L.BOTS.marcus.name, companyId: CO, active: true, prefix: KEY.slice(0, 9), createdBy: CO });
    S('agent_keys/' + sha(TKEY), { botId: 'tucker', botName: L.BOTS.tucker.name, companyId: CO, active: true, prefix: TKEY.slice(0, 9), createdBy: CO });
    S('agent_settings/' + CO, { enabled: true });
    S('subscriptions/' + CO, { status: 'active', plan: 'growth' });
    S('companyProfile/' + CO, { timezone: TZ });
    S('leads/mine', { companyId: CO, userId: CO, firstName: 'Maria', lastName: 'Lopez', address: '1420 Oak St, Florence, KY 41042', phone: '8595550147', stage: 'install_scheduled', jobType: 'roof_replacement', scheduledDate: '2026-10-20', lat: HOUSE.lat, lng: HOUSE.lng });
    S('leads/theirs', { companyId: OTHER, userId: OTHER, firstName: 'Oscar', lastName: 'Other', address: '1420 Oak St, Florence, KY 41042', stage: 'install_scheduled', scheduledDate: '2026-10-20', lat: HOUSE.lat, lng: HOUSE.lng });
    S('leads/theirs/jobs/j1', { companyId: OTHER, userId: OTHER, scheduledDate: '2026-10-21', property: { lat: HOUSE.lat, lng: HOUSE.lng } });
    S('leads/mine2', { companyId: CO, userId: CO, firstName: 'Ann', lastName: 'Two', stage: 'inspection', lat: north(60).lat, lng: north(60).lng });
    // The other company's appointment names one of ITS leads; ours names ours.
    S('appointments/x', { repUid: OTHER, userId: OTHER, leadId: 'theirs', startTime: new Date(et('2026-10-21', '10:00')), status: 'confirmed' });
    S('appointments/y', { repUid: CO, userId: CO, leadId: 'mine2', startTime: new Date(et('2026-10-21', '10:00')), status: 'confirmed' });
    // Our rep's appointment naming the OTHER company's lead (bad data) must not bring it in.
    S('appointments/z', { repUid: CO, leadId: 'theirs', startTime: new Date(et('2026-10-21', '10:00')), status: 'confirmed' });

    const callTool = async (key, name, args) => {
      const req = { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, get(h) { return this.headers[String(h).toLowerCase()]; } };
      const res = { code: 200, body: null, set() { return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
      await M.crmMcp(req, res);
      const out = res.body && res.body.result;
      let json = null; try { json = JSON.parse(out.content[0].text); } catch (_) {}
      return { code: res.code, isError: !!(out && out.isError), text: out ? out.content[0].text : JSON.stringify(res.body), json };
    };
    const before = new Set(DB.docs.keys());
    DB.writes.length = 0;
    const r = await callTool(KEY, 'match_photo_location', { points: [pt(HOUSE, et('2026-10-20', '12:00')), pt(HOUSE, et('2026-10-21', '12:00')), pt(north(60), et('2026-10-21', '12:00'))] });
    ok('Marcus gets an answer', r.code === 200 && !r.isError && r.json && Array.isArray(r.json.points), r.text);
    const ids = (i) => r.json.points[i].matches.map((x) => x.lead_id).join();
    ok('same spot, same day: only this company\'s customer matches, never the other company\'s', ids(0) === 'mine', ids(0));
    ok('the other company\'s job on leads/{id}/jobs and its appointments never match', !/theirs/.test(r.text), r.text);
    ok('our appointment brings in our customer (next day)', /mine2/.test(ids(2)), ids(2));
    ok('no customer street, phone or other company\'s name in the answer', !/Oak St|8595550147|Oscar|Other/.test(r.text), r.text);
    const newDocs = [...DB.docs.keys()].filter((k) => !before.has(k));
    ok('the points are stored nowhere: the only new doc is the usual audit row, with no coordinates', newDocs.length === 1 && /^agent_audit\//.test(newDocs[0])
      && !/39|84\.6|lat|lng|taken/.test(JSON.stringify(DB.docs.get(newDocs[0]))), JSON.stringify(newDocs.map((k) => [k, DB.docs.get(k)])));
    ok('the only update is the key\'s lastUsedAt (as on every call)', DB.writes.filter((p) => !/^agent_audit\//.test(p)).every((p) => p === 'agent_keys/' + sha(KEY)));
    const bad = await callTool(KEY, 'match_photo_location', { points: Array(201).fill(pt(HOUSE, et('2026-10-20', '12:00'))) });
    ok('the cap is enforced by the server', bad.isError && /at most 200/.test(bad.text), bad.text);
    const tuck = await callTool(TKEY, 'match_photo_location', { points: [pt(HOUSE, et('2026-10-20', '12:00'))] });
    ok('Tucker (not his role) is refused', tuck.isError && /not part of your role/.test(tuck.text), tuck.text);

    const src = read('functions/agent-mcp.js');
    const blk = src.slice(src.indexOf("if (name === 'match_photo_location')"), src.indexOf("if (name === 'team_activity')"));
    ok('the handler validates first, reads only this company\'s leads + jobs, and writes nothing', /validatePhotoMatch\(args, tz\)[\s\S]*companyLeads\(company\), companyJobsByLead\(company\)/.test(blk) && !/\.(set|update|add|delete)\(/.test(blk));
    ok('the handler never logs the points (only an error message)', !/logger\.\w+\([^)]*(args|points|lat|lng)/.test(blk));
    ok('a failed tool logs only its name, never its arguments', /logger\.error\('\[crmMcp\] tool failed', \{ name, msg: e\.message \}\)/.test(src) && !/logger\.\w+\([^)]*p\.arguments/.test(src));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
