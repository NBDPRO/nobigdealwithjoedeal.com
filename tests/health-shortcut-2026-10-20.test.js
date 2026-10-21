/**
 * tests/health-shortcut-2026-10-20.test.js
 *
 * The Apple Health weight Shortcut (functions/health-shortcut.js +
 * health-shortcut-logic.js). Runs the real handler against an in-memory
 * Firestore fake and a fake rate limiter: no emulator, no network, no SMS, no
 * email. Every guard has a NEGATIVE CONTROL: the same request with the one
 * defect removed succeeds, so a handler that rejects everything cannot pass.
 *
 * Run: node tests/health-shortcut-2026-10-20.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'functions', 'health-shortcut-logic.js'));
const HS = require(path.join(ROOT, 'functions', 'health-shortcut.js'));
const SYNC = require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'ds-sync-logic.js'));
const HIST = require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'tracker-history-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

// ── in-memory Firestore ────────────────────────────────────────────────────
const isDelete = (v) => v && v.constructor && v.constructor.name === 'DeleteTransform';
const isSentinel = (v) => v && typeof v === 'object' && v.constructor && /Transform$/.test(v.constructor.name);
function mergeInto(dst, src) {
  for (const [k, v] of Object.entries(src)) {
    if (isDelete(v)) delete dst[k];
    else if (isSentinel(v)) dst[k] = 'SERVER_TS';
    else if (v && typeof v === 'object' && !Array.isArray(v) && dst[k] && typeof dst[k] === 'object' && !Array.isArray(dst[k])) mergeInto(dst[k], v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) { dst[k] = {}; mergeInto(dst[k], v); }
    else dst[k] = v;
  }
  return dst;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
function makeDb() {
  const store = new Map();
  const snap = (p) => ({ id: p.split('/').pop(), exists: store.has(p), data: () => (store.has(p) ? clone(store.get(p)) : undefined) });
  const apply = (op) => {
    if (op.type === 'delete') store.delete(op.path);
    else if (op.merge) store.set(op.path, mergeInto(store.has(op.path) ? store.get(op.path) : {}, op.data));
    else store.set(op.path, mergeInto({}, op.data));
  };
  const ref = (p) => ({ path: p, get: async () => snap(p), set: async (data, o) => apply({ type: 'set', path: p, data, merge: !!(o && o.merge) }) });
  const coll = (p) => ({
    where: (f, op, v) => ({ __q: true, run: () => [...store.entries()].filter(([k, d]) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/') && d[f] === v).map(([k]) => snap(k)) }),
  });
  return {
    store, failNextTx: false,
    doc: ref, collection: coll,
    async runTransaction(fn) {
      if (this.failNextTx) { this.failNextTx = false; throw new Error('boom'); }
      const ops = [];
      const tx = {
        get: async (r) => (r.__q ? { forEach: (cb) => r.run().forEach(cb) } : snap(r.path)),
        set: (r, data, o) => { ops.push({ type: 'set', path: r.path, data, merge: !!(o && o.merge) }); },
        delete: (r) => { ops.push({ type: 'delete', path: r.path }); },
      };
      const out = await fn(tx);
      ops.forEach(apply);
      return out;
    },
  };
}

// ── harness ────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-10-20T14:00:00Z');
function makeWorld(over) {
  const db = makeDb();
  const logs = [];
  const counters = new Map();
  const mkLog = (lvl) => (...a) => logs.push([lvl, ...a]);
  const world = {
    db, logs, counters, now: NOW, env: {},
    limits: over && over.limits || {},
  };
  const deps = () => ({
    db,
    killed: () => world.env.HEALTH_SHORTCUT_DISABLED === 'true',
    now: () => world.now,
    logger: { info: mkLog('info'), warn: mkLog('warn'), error: mkLog('error') },
    // the same contract as functions/rate-limit.js: count per (namespace,key), throw .rateLimited past the limit
    enforceRateLimit: async (ns, key, limit) => {
      const k = ns + '|' + key; const n = (counters.get(k) || 0) + 1; counters.set(k, n);
      const cap = world.limits[ns] != null ? world.limits[ns] : limit;
      if (n > cap) { const e = new Error('rate_limited'); e.rateLimited = true; e.retryAfterMs = 1000; throw e; }
    },
    httpRateLimit: async (req, res, ns, limit) => {
      const k = ns + '|ip'; const n = (counters.get(k) || 0) + 1; counters.set(k, n);
      const cap = world.limits[ns] != null ? world.limits[ns] : limit;
      if (n > cap) { res.set('Retry-After', '1'); res.status(429).json({ error: 'Too many requests' }); return false; }
      return true;
    },
  });
  world.handler = HS._makeIngest(deps);
  world.deps = deps;
  return world;
}
function mkRes() {
  const r = { code: null, body: null, headers: {} };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
async function call(world, o) {
  const body = o.body === undefined ? { date: '2026-10-20', weightLbs: 185.24 } : o.body;
  const rawStr = typeof body === 'string' ? body : JSON.stringify(body);
  const req = {
    query: o.query || {},
    method: o.method || 'POST',
    headers: Object.assign({ 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(rawStr)) },
      o.token === null ? {} : { authorization: 'Bearer ' + (o.token || world.token) }, o.headers || {}),
    body: typeof body === 'string' ? undefined : body,
    rawBody: Buffer.from(rawStr),
  };
  if (o.rawAuth !== undefined) req.headers.authorization = o.rawAuth;
  const res = mkRes();
  await world.handler(req, res);
  return res;
}
async function setup(over, uid) {
  const w = makeWorld(over);
  w.db.store.set('system/healthShortcut', { enabled: true });
  const mc = await HS._manageCore(w.deps(), uid || 'jo-uid', 'create');
  w.token = mc.token;
  w.hash = L.hashToken(mc.token);
  return w;
}
const pagesOf = (w, dk) => [...w.db.store.entries()].filter(([k, d]) => k.startsWith('users/jo-uid/ds_pages/') && (!dk || d.dk === dk)).map(([k, d]) => ({ path: k, d }));
const logText = (w) => JSON.stringify(w.logs);

(async () => {
  console.log('\nKEY: mint, hash, lookup');
  {
    const t1 = L.mintToken(), t2 = L.mintToken();
    ok('a key is nbdh_ + 43 url-safe chars (256 bits)', /^nbdh_[A-Za-z0-9_-]{43}$/.test(t1), t1.length + '');
    ok('two keys differ', t1 !== t2);
    ok('the hash is 64 hex and is not the key', /^[0-9a-f]{64}$/.test(L.hashToken(t1)) && !L.hashToken(t1).includes(t1.slice(5, 20)));
    ok('safeEqualHex: equal true, different false, junk false (no throw)', L.safeEqualHex(L.hashToken(t1), L.hashToken(t1)) && !L.safeEqualHex(L.hashToken(t1), L.hashToken(t2)) && !L.safeEqualHex('zz', L.hashToken(t1)) && !L.safeEqualHex(undefined, undefined));
    ok('parseBearer: right shape passes; no prefix / short / wrong scheme / lowercase scheme / extra token fail',
      L.parseBearer('Bearer ' + t1) === t1 && L.parseBearer('Bearer abc') === null && L.parseBearer('Bearer ' + t1.slice(5)) === null
      && L.parseBearer('Basic ' + t1) === null && L.parseBearer('bearer ' + t1) === null && L.parseBearer('Bearer ' + t1 + ' x') === null && L.parseBearer(undefined) === null);
  }

  console.log('\nVALID WRITE');
  {
    const w = await setup();
    const r = await call(w, {});
    ok('valid POST -> 200 written', r.code === 200 && r.body.ok === true && r.body.result === 'written', JSON.stringify(r));
    const ps = pagesOf(w, '2026-10-20');
    ok('a day page was created with data[bm-wt] = "185.2" (rounded to 0.1)', ps.length === 1 && ps[0].d.data['bm-wt'] === '185.2', JSON.stringify(ps));
    const p = ps[0].d;
    ok('the new page has the client mkPage shape (id, dk, suf 1, kpi, arrays, mt, _uid)', typeof p.id === 'number' && p.dk === '2026-10-20' && p.suf === 1 && p.kpi && p.kpi.doors === 0 && Array.isArray(p.exercises) && typeof p.mt === 'number' && p._uid === 'jo-uid');
    ok('the doc id is String(page.id), like the client', ps[0].path.endsWith('/' + String(p.id)));
    ok('weightSeries (the tracker) reads the server-made page', HIST.weightSeries([p]).length === 1 && HIST.weightSeries([p])[0].lbs === 185.2);
    const st = w.db.store.get('health_shortcut_state/jo-uid');
    ok('the state doc records last date, weight and result', st.lastDate === '2026-10-20' && st.lastWeightLbs === 185.2 && st.lastResult === 'written');
    ok('sleepHours is accepted but discarded in v1 (response says sleepStored:false)', r.body.sleepStored === false);
    const r2 = await call(w, { body: { date: '2026-10-19', weightLbs: 184.9, sleepHours: 7.5 } });
    ok('with sleepHours -> 200 and no sleep field on the page', r2.code === 200 && !JSON.stringify(pagesOf(w, '2026-10-19')).includes('sleep'));
    ok('the key is stored only as a hash: the plain key appears nowhere in the store', !JSON.stringify([...w.db.store.entries()]).includes(w.token));
  }

  console.log('\nAUTH');
  {
    const w = await setup();
    ok('control: right key -> 200', (await call(w, {})).code === 200);
    ok('no Authorization header -> 401', (await call(w, { token: null })).code === 401);
    ok('wrong key (same shape) -> 401', (await call(w, { token: L.mintToken() })).code === 401);
    ok('malformed bearer -> 401', (await call(w, { rawAuth: 'Bearer nope' })).code === 401);
    ok('a key in the query string is not accepted: no header + ?token=<key> -> 401', (await call(w, { token: null, query: { token: w.token, key: w.token } })).code === 401);
    const old = w.token;
    const rot = await HS._manageCore(w.deps(), 'jo-uid', 'create');
    ok('rotating returns a different key', rot.token && rot.token !== old);
    ok('rotated: the OLD key is rejected at once (401)', (await call(w, { token: old })).code === 401);
    ok('rotated: the old key doc is gone from the store', !w.db.store.has('health_shortcut_keys/' + L.hashToken(old)));
    ok('control: the NEW key works', (await call(w, { token: rot.token })).code === 200);
    const off = await HS._manageCore(w.deps(), 'jo-uid', 'off');
    ok('turn off reports enabled:false', off.enabled === false);
    ok('turned off: the new key is rejected (401)', (await call(w, { token: rot.token })).code === 401);
    // a stale lookup that races Turn off/rotate: the key doc survives but the state doc no longer names it
    const w2 = await setup();
    w2.db.store.set('health_shortcut_state/jo-uid', Object.assign({}, w2.db.store.get('health_shortcut_state/jo-uid'), { keyHash: 'f'.repeat(64) }));
    ok('a key doc that the state doc no longer names cannot write (race with rotate) -> 401', (await call(w2, {})).code === 401);
    ok('...and wrote nothing', pagesOf(w2).length === 0);
    const w3 = await setup();
    w3.db.store.get('health_shortcut_keys/' + w3.hash).hash = 'e'.repeat(64);
    ok('a key doc whose stored hash does not match the presented key -> 401', (await call(w3, {})).code === 401);
  }

  console.log('\nDARK: flag + kill switch');
  {
    const w = await setup();
    w.db.store.delete('system/healthShortcut');
    const r = await call(w, {});
    ok('no system/healthShortcut doc -> 404 and nothing written', r.code === 404 && pagesOf(w).length === 0);
    w.db.store.set('system/healthShortcut', { enabled: 'true' });
    ok('enabled must be the boolean true (the string "true" is off) -> 404', (await call(w, {})).code === 404);
    w.db.store.set('system/healthShortcut', { enabled: true });
    ok('control: enabled:true -> 200', (await call(w, {})).code === 200);
    w.env.HEALTH_SHORTCUT_DISABLED = 'true';
    ok('kill switch HEALTH_SHORTCUT_DISABLED=true overrides the flag -> 404', (await call(w, { body: { date: '2026-10-18', weightLbs: 180 } })).code === 404);
    ok('...and nothing was written for that call', pagesOf(w, '2026-10-18').length === 0);
    const wm = makeWorld();
    let threw = null; try { await HS._manageCore(wm.deps(), 'jo-uid', 'create'); } catch (e) { threw = e; }
    ok('flag off: create is refused (failed-precondition) and mints nothing', threw && threw.code === 'failed-precondition' && wm.db.store.size === 0);
    const st = await HS._manageCore(wm.deps(), 'jo-uid', 'status');
    ok('flag off: status says available:false (the card stays hidden)', st.available === false);
    const wd = await setup();
    wd.db.store.delete('system/healthShortcut'); wd.counters.clear();
    await call(wd, {}); await call(wd, { token: L.mintToken() });
    ok('dark: a POST touches no rate-limit counter and writes no page (nothing is written while off)', wd.counters.size === 0 && pagesOf(wd).length === 0);
    ok('control: with the flag on the same POST does touch the limiter', (wd.db.store.set('system/healthShortcut', { enabled: true }), await call(wd, {}), wd.counters.size > 0));
    const wo = await setup();
    wo.db.store.delete('system/healthShortcut');
    const offDark = await HS._manageCore(wo.deps(), 'jo-uid', 'off');
    ok('Turn off works while the flag is off, and the key doc is deleted', offDark.enabled === false && !wo.db.store.has('health_shortcut_keys/' + wo.hash));
    const wk = await setup(); wk.env.HEALTH_SHORTCUT_DISABLED = 'true';
    await HS._manageCore(wk.deps(), 'jo-uid', 'off');
    ok('...and under the kill switch too', !wk.db.store.has('health_shortcut_keys/' + wk.hash));
    const wa = await setup(); wa.db.store.set('system/healthShortcut', { enabled: true, allowedUids: ['someone-else'] });
    ok('allowedUids: a key for an unlisted user is refused (401)', (await call(wa, {})).code === 401 && pagesOf(wa).length === 0);
    ok('allowedUids: an unlisted user sees no card and cannot create', (await HS._manageCore(wa.deps(), 'jo-uid', 'status')).available === false);
    wa.db.store.set('system/healthShortcut', { enabled: true, allowedUids: ['jo-uid'] });
    ok('control: the listed user works', (await call(wa, {})).code === 200 && (await HS._manageCore(wa.deps(), 'jo-uid', 'status')).available === true);
  }

  console.log('\nVALIDATION (every failure is the same generic 400)');
  {
    const w = await setup({ limits: { 'healthshortcut:ip': 1000, 'healthshortcut:key': 1000, 'healthshortcut:day': 1000 } });
    const bad = async (label, body) => { const r = await call(w, { body }); ok(label, r.code === 400 && r.body.error === 'bad_request', r.code + ' ' + JSON.stringify(r.body)); };
    await bad('weight 59.9 -> 400', { date: '2026-10-20', weightLbs: 59.9 });
    await bad('weight 700.1 -> 400', { date: '2026-10-20', weightLbs: 700.1 });
    await bad('weight NaN (null in JSON) -> 400', { date: '2026-10-20', weightLbs: null });
    await bad('weight as a string "185" -> 400', { date: '2026-10-20', weightLbs: '185' });
    await bad('weight missing -> 400', { date: '2026-10-20' });
    await bad('weight Infinity (1e999 in JSON) -> 400', JSON.parse('{"date":"2026-10-20","weightLbs":1e999}'));
    await bad('negative sleep -> 400', { date: '2026-10-20', weightLbs: 185, sleepHours: -1 });
    await bad('sleep 24.1 -> 400', { date: '2026-10-20', weightLbs: 185, sleepHours: 24.1 });
    await bad('sleep as a string -> 400', { date: '2026-10-20', weightLbs: 185, sleepHours: '7' });
    await bad('not a date -> 400', { date: 'yesterday', weightLbs: 185 });
    await bad('impossible date 2026-02-30 -> 400', { date: '2026-02-30', weightLbs: 185 });
    await bad('date with a time -> 400', { date: '2026-10-20T10:00:00Z', weightLbs: 185 });
    await bad('3 days ahead -> 400', { date: '2026-10-23', weightLbs: 185 });
    await bad('401 days back -> 400', { date: '2025-09-14', weightLbs: 185 });
    await bad('an unknown extra field -> 400', { date: '2026-10-20', weightLbs: 185, note: 'hi' });
    await bad('an array body -> 400', [1, 2]);
    await bad('a bare string body -> 400', 'hello');
    ok('no page was written by any rejected request', pagesOf(w).length === 0);
    // controls: the edges themselves are accepted
    const edge = async (label, body) => { const r = await call(w, { body }); ok(label, r.code === 200, r.code + ''); };
    await edge('control: weight 60 exactly -> 200', { date: '2026-10-20', weightLbs: 60 });
    await edge('control: weight 700 exactly -> 200', { date: '2026-10-19', weightLbs: 700 });
    await edge('control: 2 days ahead -> 200', { date: '2026-10-22', weightLbs: 185 });
    await edge('control: 400 days back (2025-09-15) -> 200', { date: '2025-09-15', weightLbs: 185 });
    await edge('control: sleep 0 and 24 -> 200', { date: '2026-10-18', weightLbs: 185, sleepHours: 24 });
  }

  console.log('\nTRANSPORT: size, type, method, CORS');
  {
    const w = await setup({ limits: { 'healthshortcut:ip': 1000, 'healthshortcut:key': 1000, 'healthshortcut:day': 1000 } });
    const big ={ date: '2026-10-20', weightLbs: 185, pad: 'x'.repeat(600) };
    const rb = await call(w, { body: big });
    ok('oversize body (600+ bytes) -> 400', rb.code === 400);
    const rc = await call(w, { headers: { 'content-length': '99999' } });
    ok('a Content-Length over the cap -> 400 before the body is read', rc.code === 400);
    const rt = await call(w, { headers: { 'content-type': 'text/plain' } });
    ok('content-type text/plain -> 400', rt.code === 400);
    ok('control: content-type application/json; charset=utf-8 -> 200', (await call(w, { headers: { 'content-type': 'application/json; charset=utf-8' } })).code === 200);
    for (const m of ['GET', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
      const r = await call(w, { method: m });
      ok(m + ' -> 405 with Allow: POST', r.code === 405 && r.headers.Allow === 'POST');
    }
    ok('control: POST -> 200', (await call(w, {})).code === 200);
    const r = await call(w, {});
    ok('no CORS headers on any response', !Object.keys(r.headers).some((k) => /^access-control/i.test(k)));
    ok('responses are Cache-Control: no-store', r.headers['Cache-Control'] === 'no-store');
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'health-shortcut.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    const ingestSrc = src.slice(src.indexOf('exports.healthShortcutIngest'), src.indexOf('const CORS_ORIGINS'));
    ok('the onRequest function sets no cors option and the handler never reads req.query', !/cors/i.test(ingestSrc) && !/req\.query/.test(src));
    ok('the onCall (settings card) enforces App Check', /enforceAppCheck:\s*true/.test(src));
  }

  console.log('\nRATE LIMITS');
  {
    const w = await setup({ limits: { 'healthshortcut:ip': 3 } });
    const codes = []; for (let i = 0; i < 4; i++) codes.push((await call(w, {})).code);
    ok('per-IP limit trips: 3 allowed, 4th -> 429', codes.join() === '200,200,200,429', codes.join());
    const w2 = await setup({ limits: { 'healthshortcut:key': 2 } });
    const c2 = []; for (let i = 0; i < 3; i++) c2.push((await call(w2, {})).code);
    ok('per-key limit trips -> 429 (and Retry-After is set)', c2.join() === '200,200,429', c2.join());
    const r429 = await call(w2, {});
    ok('...with a Retry-After header', !!r429.headers['Retry-After']);
    const w3 = await setup({ limits: { 'healthshortcut:day': 2 } });
    const c3 = []; for (let i = 0; i < 3; i++) c3.push((await call(w3, { body: { date: '2026-10-1' + (i + 5), weightLbs: 180 + i } })).code);
    ok('per-user daily cap trips -> 429, and the 3rd reading was not written', c3.join() === '200,200,429' && pagesOf(w3, '2026-10-17').length === 0, c3.join());
    ok('the real daily cap is 50 and the key window is 10/hour, the IP window 20/10min (source pins)', L.DAILY_CAP === 50 && /KEY_LIMIT = 10/.test(fs.readFileSync(path.join(ROOT, 'functions', 'health-shortcut.js'), 'utf8')) && /IP_LIMIT = 20/.test(fs.readFileSync(path.join(ROOT, 'functions', 'health-shortcut.js'), 'utf8')));
    const w5 = await setup({ limits: { 'healthshortcut:day': 2, 'healthshortcut:ip': 1000, 'healthshortcut:key': 1000 } });
    for (let i = 0; i < 5; i++) await call(w5, { body: { date: 'bad', weightLbs: 1 } });
    const okc = []; for (let i = 0; i < 3; i++) okc.push((await call(w5, { body: { date: '2026-10-1' + (i + 5), weightLbs: 180 + i } })).code);
    ok('junk bodies do not burn the daily cap: 5 rejected, then 2 good readings still pass and the 3rd trips', okc.join() === '200,200,429', okc.join());
    const w4 = await setup();
    const bad401 = await call(w4, { token: L.mintToken() });
    ok('control: with the default limits the same request is not 429', (await call(w4, {})).code === 200 && bad401.code === 401);
  }

  console.log('\nIDEMPOTENCE + THE PAGE RULE');
  {
    const w = await setup();
    await call(w, { body: { date: '2026-10-20', weightLbs: 185.2 } });
    const again = await call(w, { body: { date: '2026-10-20', weightLbs: 185.2 } });
    ok('the same reading twice -> "unchanged", still ONE page for the day', again.code === 200 && again.body.result === 'unchanged' && pagesOf(w, '2026-10-20').length === 1);
    const newer = await call(w, { body: { date: '2026-10-20', weightLbs: 184.6 } });
    ok('a newer reading the same day overwrites (last one wins), still one page', newer.body.result === 'written' && pagesOf(w, '2026-10-20').length === 1 && pagesOf(w, '2026-10-20')[0].d.data['bm-wt'] === '184.6');

    // other fields on the page survive the merge
    const w2 = await setup();
    w2.db.store.set('users/jo-uid/ds_pages/777.5', { id: 777.5, dk: '2026-10-20', suf: 1, name: 'Leg day', mt: 1000, data: { 'l-workout': '1', 'bm-wt': '', 'journal': 'felt great' }, kpi: { doors: 40, contacts: 5, appts: 1, closes: 0, noshow: 0 }, exercises: [{ n: 'Squat', s: '5x5' }], objections: [], commissions: [], _uid: 'jo-uid' });
    const r = await call(w2, { body: { date: '2026-10-20', weightLbs: 181 } });
    const p = w2.db.store.get('users/jo-uid/ds_pages/777.5');
    ok('empty weight box on an existing page -> written into THAT page, no second page', r.body.result === 'written' && pagesOf(w2).length === 1 && p.data['bm-wt'] === '181');
    ok('...and nothing else on the page changed (workout floor, journal, kpi, exercises, name)', p.data['l-workout'] === '1' && p.data.journal === 'felt great' && p.kpi.doors === 40 && p.exercises.length === 1 && p.name === 'Leg day');
    ok('...and the page gained ONLY the weight, the hw marker, mt, _updatedAt (no stray keys)', Object.keys(p.data).sort().join() === 'bm-wt,journal,l-workout' && Object.keys(p).sort().join() === ['_uid', '_updatedAt', 'commissions', 'data', 'dk', 'exercises', 'hw', 'id', 'kpi', 'mt', 'name', 'objections', 'suf'].join(), Object.keys(p).sort().join());
    ok('...mt moved forward so the phone\'s mergePages takes it', p.mt === NOW && SYNC.mergePages([{ id: 777.5, dk: '2026-10-20', mt: 1000, data: {} }], [Object.assign({}, p, { id: 777.5 })], []).pages[0].data['bm-wt'] === '181');

    // hand-typed weight is never overwritten
    const w3 = await setup();
    w3.db.store.set('users/jo-uid/ds_pages/888.1', { id: 888.1, dk: '2026-10-20', suf: 1, name: '', mt: 5, data: { 'bm-wt': '190' }, kpi: {}, _uid: 'jo-uid' });
    const h = await call(w3, { body: { date: '2026-10-20', weightLbs: 185 } });
    ok('a hand-typed weight is kept: reading answers 200 "hand_entered" and the page is untouched', h.code === 200 && h.body.result === 'hand_entered' && w3.db.store.get('users/jo-uid/ds_pages/888.1').data['bm-wt'] === '190' && w3.db.store.get('users/jo-uid/ds_pages/888.1').mt === 5);
    // control for the same page: clear the hand weight and the reading goes in
    w3.db.store.get('users/jo-uid/ds_pages/888.1').data['bm-wt'] = '';
    ok('control: the same reading is written once the box is empty', (await call(w3, { body: { date: '2026-10-20', weightLbs: 185 } })).body.result === 'written');
    // auto value later hand-edited
    const w4 = await setup();
    await call(w4, { body: { date: '2026-10-20', weightLbs: 185.2 } });
    pagesOf(w4, '2026-10-20')[0].d.data['bm-wt'] = '186';
    const ed = await call(w4, { body: { date: '2026-10-20', weightLbs: 184 } });
    ok('an automatic value Jo later edited counts as hand-typed: the next reading is kept out', ed.body.result === 'hand_entered' && pagesOf(w4, '2026-10-20')[0].d.data['bm-wt'] === '186');

    // deleted days stay deleted
    const w5 = await setup();
    w5.db.store.set('users/jo-uid/ds_pages/999.9', { id: 999.9, dk: '2026-10-20', deleted: true, _uid: 'jo-uid' });
    const dl = await call(w5, { body: { date: '2026-10-20', weightLbs: 185 } });
    ok('a deleted (tombstoned) day is NOT resurrected: 200 "deleted", no new page, tombstone intact', dl.body.result === 'deleted' && pagesOf(w5).length === 1 && w5.db.store.get('users/jo-uid/ds_pages/999.9').deleted === true && !w5.db.store.get('users/jo-uid/ds_pages/999.9').data);
    const nd = await call(w5, { body: { date: '2026-10-19', weightLbs: 185 } });
    ok('control: a different, never-deleted day is created normally', nd.body.result === 'written' && pagesOf(w5, '2026-10-19').length === 1);
    // a deleted entry next to a live one: the live one takes it
    const w6 = await setup();
    w6.db.store.set('users/jo-uid/ds_pages/1.1', { id: 1.1, dk: '2026-10-20', deleted: true });
    w6.db.store.set('users/jo-uid/ds_pages/2.2', { id: 2.2, dk: '2026-10-20', suf: 2, data: {} });
    ok('deleted entry + live entry on one day -> the live page is written', (await call(w6, {})).body.result === 'written' && w6.db.store.get('users/jo-uid/ds_pages/2.2').data['bm-wt'] === '185.2');
    // two entries: the one already holding a weight is the one weightSeries reads
    const w7 = await setup();
    w7.db.store.set('users/jo-uid/ds_pages/3.3', { id: 3.3, dk: '2026-10-20', suf: 1, data: {} });
    w7.db.store.set('users/jo-uid/ds_pages/4.4', { id: 4.4, dk: '2026-10-20', suf: 2, data: { 'bm-wt': '181' } });
    await call(w7, { body: { date: '2026-10-20', weightLbs: 184 } });
    ok('two entries on a day: the reading goes to neither a hand weight (kept)... ', w7.db.store.get('users/jo-uid/ds_pages/4.4').data['bm-wt'] === '181' && !w7.db.store.get('users/jo-uid/ds_pages/3.3').data['bm-wt']);
    // pure decision table
    ok('decidePageWrite: no pages -> create', L.decidePageWrite([], '185').action === 'create');
    ok('decidePageWrite: control — empty box -> update', L.decidePageWrite([{ id: 'a', data: { data: {} } }], '185').action === 'update');
    ok('decidePageWrite: own marker matches -> update; marker stale -> skip hand_entered',
      L.decidePageWrite([{ id: 'a', data: { data: { 'bm-wt': '180' }, hw: { wt: '180' } } }], '185').action === 'update'
      && L.decidePageWrite([{ id: 'a', data: { data: { 'bm-wt': '181' }, hw: { wt: '180' } } }], '185').reason === 'hand_entered');
    // the client sync does not undo it: a page written here survives a pull
    const w8 = await setup();
    await call(w8, {});
    const cloudPage = pagesOf(w8, '2026-10-20')[0].d;
    delete cloudPage._updatedAt;
    const merged = SYNC.mergePages([], [cloudPage], []);
    ok('the client mergePages keeps the server-made page (not deleted, not dropped)', merged.pages.length === 1 && merged.pages[0].data['bm-wt'] === '185.2');
  }

  console.log('\nFAILURE MODES');
  {
    const w = await setup();
    w.db.failNextTx = true;
    const r = await call(w, {});
    ok('a Firestore failure mid-write -> 503, no partial page', r.code === 503 && pagesOf(w).length === 0);
    ok('control: the next request succeeds', (await call(w, {})).code === 200);
    const wf = makeWorld();
    wf.db.doc = () => ({ get: async () => { throw new Error('down'); } });
    const rf = await wf.handler({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + L.mintToken() }, body: {}, rawBody: Buffer.from('{}') }, mkRes());
    const rfRes = mkRes(); await wf.handler({ method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + L.mintToken() }, body: {}, rawBody: Buffer.from('{}') }, rfRes);
    ok('the flag read failing closes the endpoint: 404, no throw', rf === undefined && rfRes.code === 404, String(rfRes.code));
  }

  console.log('\nLOGS: no token, no body, no header');
  {
    const w = await setup({ limits: { 'healthshortcut:day': 1000 } }, 'uidlongname1234');
    await call(w, {}); await call(w, { token: L.mintToken() }); await call(w, { body: { date: 'x', weightLbs: 1 } });
    w.limits['healthshortcut:key'] = 1; await call(w, {});
    w.db.failNextTx = true; await call(w, { body: { date: '2026-10-17', weightLbs: 170 } });
    const text = logText(w);
    ok('something was logged (the check is not vacuous)', w.logs.length >= 3, String(w.logs.length));
    ok('the key never appears in a log line', !text.includes(w.token) && !text.includes(w.token.slice(5)));
    ok('the key hash never appears in a log line', !text.includes(w.hash));
    ok('no weight value or request body appears in a log line', !/185\.2|185\.24|weightLbs/.test(text));
    ok('the full uid never appears (6-char prefix only)', !text.includes('uidlongname1234') && text.includes('uidlon'));
    ok('log lines carry status and date', /"status":200/.test(text) && /"date":"2026-10-20"/.test(text));
    // negative control: the detector itself must flag a leaky log
    const leaky = JSON.stringify([['info', 'got header', 'Bearer ' + w.token]]);
    ok('NEGATIVE CONTROL: the same leak check flags a log that prints the Authorization header', leaky.includes(w.token));
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'health-shortcut.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
    ok('source: no logger call mentions token, headers, body, hash or authorization', !/logger\.\w+\([^)]*(token|headers|req\.body|authorization|hash)/i.test(src.replace(/d\.logger/g, 'logger')));
  }

  console.log('\nMANAGE (the settings card)');
  {
    const w = await makeWorld(); w.db.store.set('system/healthShortcut', { enabled: true });
    const s0 = await HS._manageCore(w.deps(), 'jo-uid', 'status');
    ok('before any key: available true, enabled false, no key', s0.available === true && s0.enabled === false && !s0.token);
    const c = await HS._manageCore(w.deps(), 'jo-uid', 'create');
    ok('create returns the key once and enabled:true', /^nbdh_/.test(c.token) && c.enabled === true);
    const s1 = await HS._manageCore(w.deps(), 'jo-uid', 'status');
    ok('status afterwards never includes the key or its hash', !JSON.stringify(s1).includes(c.token) && !JSON.stringify(s1).includes(L.hashToken(c.token)) && s1.enabled === true);
    ok('exactly one key doc exists per user after two creates', (await HS._manageCore(w.deps(), 'jo-uid', 'create'), [...w.db.store.keys()].filter((k) => k.startsWith('health_shortcut_keys/')).length === 1));
    const other = await HS._manageCore(w.deps(), 'other-uid', 'create');
    ok('another user\'s create does not touch Jo\'s key', [...w.db.store.keys()].filter((k) => k.startsWith('health_shortcut_keys/')).length === 2 && other.token);
    let bad = null; try { await HS._manageCore(w.deps(), 'jo-uid', 'nope'); } catch (e) { bad = e; }
    ok('an unknown action is invalid-argument', bad && bad.code === 'invalid-argument');
  }

  console.log('\nWIRING');
  {
    const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
    ok('index.js exports both functions by name (the test seams are not deployed)', /exports\.healthShortcutIngest\s*=/.test(idx) && /exports\.healthShortcutManage\s*=/.test(idx) && !/Object\.assign\(exports,\s*healthShortcutFunctions\)/.test(idx));
    const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'functions', 'function-map.json'), 'utf8'));
    ok('function-map.json lists both', map.healthShortcutIngest === './health-shortcut' && map.healthShortcutManage === './health-shortcut');
    const fi = fs.readFileSync(path.join(ROOT, 'functions', 'FUNCTIONS_INDEX.md'), 'utf8');
    ok('FUNCTIONS_INDEX.md lists both', fi.includes('`healthShortcutIngest`') && fi.includes('`healthShortcutManage`'));
    const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    ok('firestore.rules denies both new collections', /match \/health_shortcut_keys\/\{hash\}\s*\{\s*allow read, write: if false;/.test(rules) && /match \/health_shortcut_state\/\{uid\}\s*\{\s*allow read, write: if false;/.test(rules));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
