/**
 * tests/storm-report-honest-failure-2026-10-26.test.js — /storm-report says so
 * when the storm-data lookup failed, and a failure is never cached as "no
 * storms" (overnight pass, 2026-10-26, funnel-3).
 *
 * The defect: functions/storm-report.js swallowed every failed yearly IEM fetch
 * (`continue`), so an IEM outage returned a zero-count report with HTTP 200 and
 * wrote it to public_cache/storm_* for 24 h; and storm-report-page.js showed
 * "No major storm reports logged near this address" (and "Light storm history
 * on record", "No individual reports on file", "Report range: 5 years") for an
 * HTTP 500, an aborted request and the server's own empty:true fallback —
 * under a hero promising verified NOAA / NWS records. The lead story then read
 * "0 events/5yr" and the follow-up email repeated it as a real result.
 *
 *   SERVER   every year failed  -> the stale-or-empty path (empty:true, never
 *                                  cached, no-store); some years failed -> the
 *                                  events found, partial:true + failedYears,
 *                                  never cached; all years ok -> cached as before.
 *   PAGE     HTTP error / abort / empty:true / no counts / a partial lookup that
 *            found nothing -> "we couldn't check" with a Retry; the verdict,
 *            table row and source line say the same; the lead still goes in.
 *   EMAIL    a lead whose story says the lookup failed gets no "verified storm
 *            history" email (nothing to send), and the claim is not consumed.
 *
 * Every script is EXECUTED (vm + a fake DOM; the real handler with firebase
 * stubbed at the module loader and IEM stubbed at global fetch).
 * Zero deps. Run: node tests/storm-report-honest-failure-2026-10-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const F = (rel) => path.join(ROOT, 'functions', rel);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };

// ── module-loader stubs for the Cloud Functions ─────────────────────────────
const realLoad = Module._load;
let stubs = null;
Module._load = function (request) {
  if (stubs && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return realLoad.apply(this, arguments);
};
function fresh(file) { delete require.cache[file]; return require(file); }
const noopLogger = { info() {}, warn() {}, error() {} };
function mkRes() {
  return { code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, set(k, v) { this.headers[k] = v; return this; }, end() { return this; }, send(b) { this.body = b; return this; } };
}

// ── SERVER: the stormReport handler, IEM stubbed at global fetch ────────────
const LAT = 39.087, LON = -84.39;
function loadServer(store) {
  const sets = [];
  const db = {
    doc: (p) => ({
      get: async () => ({ exists: store[p] !== undefined, data: () => store[p] }),
      set: async (v) => { sets.push({ path: p, value: v }); store[p] = v; },
    }),
  };
  stubs = {
    'firebase-functions/v2/https': { onRequest: (o, h) => ({ __opts: o, __handler: h }) },
    'firebase-functions/v2': { logger: noopLogger },
    'firebase-admin/firestore': { getFirestore: () => db },
    './integrations/upstash-ratelimit': { httpRateLimit: async () => true },
    './integrations/asos-gust': { gustsForTopStormDays: async () => [] },
  };
  const mod = fresh(F('storm-report.js'));
  stubs = null;
  return { handler: mod.stormReport.__handler, sets };
}
// plan[i] is what the i-th yearly request (newest year first) does:
// 'ok' = one hail report 2 mi away, '500' = HTTP 500, 'throw' = the request rejects (timeout).
function stubIem(plan) {
  const state = { calls: 0 };
  global.fetch = async () => {
    const i = state.calls++;
    const how = plan[i % plan.length];
    if (how === 'throw') throw new Error('The operation was aborted due to timeout');
    if (how === '500') return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: true, status: 200,
      json: async () => ({ features: [{ geometry: { coordinates: [LON + 0.02, LAT + 0.02] }, properties: { typetext: 'HAIL', magf: 1.25, valid: (2026 - i) + '-05-17T00:25:00Z', city: 'Cincinnati' } }] }),
    };
  };
  return state;
}
async function callServer(h) {
  const res = mkRes();
  await h({ query: { lat: String(LAT), lon: String(LON) } }, res);
  return res;
}
const CACHE_PATH = 'public_cache/' + require(F('asos-gust-logic')).stormReportCacheKey(LAT, LON);

// ── PAGE: storm-report-page.js in a vm with a fake DOM ──────────────────────
const HTML = read('docs/storm-report.html');
const textOf = (id) => {
  const m = HTML.match(new RegExp('id="' + id + '"[^>]*>([^<]*)<'));
  return m ? m[1].replace(/&amp;/g, '&').trim() : null;
};
function loadPage(fetchImpl) {
  const els = {}; let active = null; let clickHandler = null; let posted = null;
  const fetches = [];
  function el(id) {
    if (!els[id]) {
      let text = '', html = '';
      els[id] = {
        id, value: '', checked: true, hidden: false, disabled: false, style: {}, dataset: {},
        classList: { add(c) { if (c === 'active') active = id; }, remove() {} },
        get textContent() { return text; }, set textContent(v) { text = String(v); },
        get innerHTML() { return html; }, set innerHTML(v) { html = String(v); },
        appendChild() {}, addEventListener() {},
        get childElementCount() { return 0; },
      };
    }
    return els[id];
  }
  // the gate copy as the real page ships it
  el('sr-gate-lead').textContent = textOf('sr-gate-lead') || '';
  el('sr-gate-sub').textContent = textOf('sr-gate-sub') || '';
  el('sr-unlock').textContent = textOf('sr-unlock') || '';
  if (/id="sr-retry"[^>]*\bhidden\b/.test(HTML)) el('sr-retry').hidden = true;
  const doc = {
    readyState: 'complete',
    getElementById: (id) => (/^(lf-css|lf-js|sr-map)$/.test(id) ? null : el(id)),
    querySelectorAll: () => [],
    addEventListener(t, fn) { if (t === 'click') clickHandler = fn; },
    createElement() { return { style: {} }; },
    head: { appendChild() {} },
  };
  const win = {
    __NBD_STORM_API: '/api/storm-report', scrollTo() {},
    submitPublicLead: (kind, payload) => { posted = { kind, payload }; return Promise.resolve({ ok: true }); },
  };
  win.window = win;
  const sandbox = {
    window: win, document: doc, console,
    fetch: (u) => { fetches.push(u); return fetchImpl(u); },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  };
  vm.runInNewContext(read('docs/assets/js/storm-report-page.js'), sandbox, { filename: 'storm-report-page.js' });
  const click = (action) => clickHandler({ target: { closest: (sel) => (sel === '[data-action]' ? { dataset: { action } } : null) } });
  win._srAc = [{ display_name: '123 Main St, Cincinnati, OH', lat: String(LAT), lon: String(LON) }];
  clickHandler({ target: { closest: (sel) => (sel.indexOf('sr-ac-item') >= 0 ? { dataset: { idx: '0' } } : null) } });
  return {
    el, click, fetches,
    get active() { return active; },
    get posted() { return posted; },
    async generate() { click('generate'); await settle(); },
    async unlock() {
      el('sr-firstName').value = 'Pat'; el('sr-phone').value = '(513) 555-0101'; el('sr-email').value = 'pat@example.com';
      click('unlock'); await settle();
    },
  };
}
const respond = (status, body) => () => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const GOOD = { counts: { total: 3, hail: 2, wind: 1, tornado: 0, stormDays: 2 }, maxHail: 1.5, years: 5, radiusMi: 30, source: 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet',
  events: [{ date: '2026-05-17T00:25:00Z', type: 'hail', magnitude: 1.5, unit: 'in', distanceMi: 2, severity: 'significant' }] };
const ZERO = { counts: { total: 0, hail: 0, wind: 0, tornado: 0, stormDays: 0 }, maxHail: null, years: 5, radiusMi: 30, events: [], source: 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet' };
const SERVER_FALLBACK = Object.assign({}, ZERO, { empty: true, source: 'NWS LSR via IEM' });
const FALSE_ALL_CLEAR = /No major storm reports|doesn.t rule out damage|Light storm history|No individual reports|Report range/;

let failedStory = null;   // the line the page really posts for a failed lookup
(async () => {
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nSERVER — a failed lookup is not cached as "no storms"');
  {
    // 1. IEM down: every yearly request fails (HTTP 500).
    const store = {};
    const { handler, sets } = loadServer(store);
    const iem = stubIem(['500']);
    const down = await callServer(handler);
    ok('IEM down: five yearly requests were tried', iem.calls === 5, iem.calls);
    ok('IEM down: the response says the lookup failed (empty:true), zero counts, no events', down.code === 200 && down.body.empty === true && down.body.counts.total === 0 && down.body.events.length === 0, down.body);
    ok('IEM down: nothing is written to public_cache', sets.length === 0 && store[CACHE_PATH] === undefined, sets);
    ok('IEM down: not allowed to sit in a browser/CDN cache (no-store)', down.headers['Cache-Control'] === 'no-store', down.headers);

    // 2. IEM comes back: the same cell is looked up again, not served "0 events" from a poisoned cache.
    const iem2 = stubIem(['ok']);
    const back = await callServer(handler);
    ok('IEM back: the same cell is fetched fresh (no poisoned cache hit)', iem2.calls === 5 && back.body.cached === false, { calls: iem2.calls, cached: back.body.cached });
    ok('IEM back: the real events are returned', back.body.counts.total === 5 && !back.body.empty && !back.body.partial, back.body.counts);
    ok('IEM back: a complete report is cached once, with the public max-age', sets.length === 1 && sets[0].path === CACHE_PATH && back.headers['Cache-Control'] === 'public, max-age=3600', { sets: sets.length, h: back.headers });
    ok('the cached doc keeps the shape it always had (no failure fields)', sets[0] && sets[0].value.data && !('failedYears' in sets[0].value.data) && !('partial' in sets[0].value.data), sets[0] && Object.keys(sets[0].value.data));

    // 3. A fresh cache hit still short-circuits IEM.
    const iem3 = stubIem(['500']);
    const hit = await callServer(handler);
    ok('a fresh cached report is served without touching IEM', iem3.calls === 0 && hit.body.cached === true && hit.body.counts.total === 5, { calls: iem3.calls });
  }
  {
    // 4. Aborted/timed-out requests are failures too.
    const store = {};
    const { handler, sets } = loadServer(store);
    stubIem(['throw']);
    const r = await callServer(handler);
    ok('IEM timeouts: empty:true and nothing cached', r.body.empty === true && sets.length === 0, r.body);
  }
  {
    // 5. IEM down but an older (expired) good report exists: serve it stale, keep it, do not overwrite.
    const old = { data: Object.assign({ lat: LAT, lon: LON, radiusMi: 30, years: 5, source: 's' }, { counts: { total: 7, stormDays: 3, hail: 4, wind: 3, tornado: 0 }, maxHail: 1.75, events: [] }), fetchedAt: Date.now() - 3 * 24 * 3600 * 1000 };
    const store = { [CACHE_PATH]: old };
    const { handler, sets } = loadServer(store);
    stubIem(['500']);
    const r = await callServer(handler);
    ok('IEM down + an expired good report: served as stale real data, not as zero', r.body.stale === true && r.body.cached === true && r.body.counts.total === 7 && !r.body.empty, r.body);
    ok('…and the good report is left in place', sets.length === 0 && store[CACHE_PATH] === old);
  }
  {
    // 6. Some years fail: what was found comes back, flagged, never cached.
    const store = {};
    const { handler, sets } = loadServer(store);
    stubIem(['ok', '500', 'ok', 'throw', 'ok']);
    const r = await callServer(handler);
    ok('2 of 5 years failed: the events from the other 3 are returned', r.code === 200 && r.body.counts.total === 3 && !r.body.empty, r.body.counts);
    ok('…flagged partial with the number of years lost', r.body.partial === true && r.body.failedYears === 2, { partial: r.body.partial, failedYears: r.body.failedYears });
    ok('…never cached, never shared (no-store)', sets.length === 0 && r.headers['Cache-Control'] === 'no-store', { sets: sets.length, h: r.headers });
    ok('…the five-year range is still what the page is told it asked for (years stays 5)', r.body.years === 5);
  }
  {
    // 7. 4 of 5 years fail and the survivor found nothing near the address: still partial, still not a clean zero.
    const store = {};
    const { handler, sets } = loadServer(store);
    let n = 0;
    global.fetch = async () => (n++ === 0 ? { ok: true, json: async () => ({ features: [] }) } : { ok: false, status: 502, json: async () => ({}) });
    const r = await callServer(handler);
    ok('4 of 5 years failed, 0 events in the one that worked: partial:true, not a cached zero', r.body.partial === true && r.body.failedYears === 4 && r.body.counts.total === 0 && sets.length === 0, r.body);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nPAGE — the markup carries the retry and the gate copy');
  {
    ok('a Retry button exists in the teaser panel, wired to data-action="retry", shipped hidden', /<button[^>]*id="sr-retry"[^>]*data-action="retry"[^>]*hidden|<button[^>]*data-action="retry"[^>]*id="sr-retry"[^>]*hidden/.test(HTML));
    const teaser = HTML.slice(HTML.indexOf('id="sr-teaser"'), HTML.indexOf('id="sr-report"'));
    ok('…inside the teaser panel', /id="sr-retry"/.test(teaser));
    ok('the gate heading, sub-line and button have ids the script can swap', !!textOf('sr-gate-lead') && !!textOf('sr-gate-sub') && !!textOf('sr-unlock'));
    ok('the script is cache-busted past v=7', Number((HTML.match(/storm-report-page\.js\?v=(\d+)"/) || [])[1]) >= 8);
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nPAGE — every kind of failed lookup shows "couldn\'t check", never "no storms"');
  const FAILURES = [
    ['HTTP 500', respond(500, { error: 'boom' })],
    ['HTTP 503 with an HTML body', () => Promise.resolve({ ok: false, status: 503, json: () => Promise.reject(new SyntaxError('Unexpected token <')) })],
    ['an aborted / offline request', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the server\'s own empty:true fallback (HTTP 200)', respond(200, SERVER_FALLBACK)],
    ['a 200 with no counts at all', respond(200, {})],
    ['a partial lookup that found nothing', respond(200, Object.assign({}, ZERO, { partial: true, failedYears: 4 }))],
  ];
  for (const [label, impl] of FAILURES) {
    const p = loadPage(impl);
    await p.generate();
    const headline = p.el('sr-teaser-headline').textContent, sub = p.el('sr-teaser-sub').textContent;
    ok(label + ': the teaser opens', p.active === 'sr-teaser');
    ok(label + ': headline says the records could not be checked', /couldn.t check storm records/i.test(headline), headline);
    ok(label + ': no "no major storm reports" / "doesn\'t rule out damage" line', !FALSE_ALL_CLEAR.test(headline + ' ' + sub), headline + ' | ' + sub);
    ok(label + ': the sub-line says it is not a "no storms" result and offers a retry or a free look', /not a .no storms. result/i.test(sub) && /try again/i.test(sub) && /free/i.test(sub), sub);
    ok(label + ': no zero-count chips (0 hail / 0 wind / 0 storm days)', p.el('sr-teaser-chips').innerHTML === '', p.el('sr-teaser-chips').innerHTML);
    ok(label + ': Retry is shown', p.el('sr-retry').hidden === false);
    ok(label + ': the gate stops promising "every event, a map"', !/every event|emails you a copy/i.test(p.el('sr-gate-lead').textContent + ' ' + p.el('sr-gate-sub').textContent) && /Send my request/.test(p.el('sr-unlock').textContent), p.el('sr-gate-lead').textContent + ' | ' + p.el('sr-gate-sub').textContent);
  }

  console.log('\nPAGE — a real zero stays a real zero; a normal result is unchanged');
  {
    const p = loadPage(respond(200, ZERO));
    await p.generate();
    ok('a clean zero-event lookup still says no major storm reports (that IS the verified answer)', p.el('sr-teaser-headline').textContent === 'No major storm reports logged near this address', p.el('sr-teaser-headline').textContent);
    ok('…with Retry hidden and the original gate copy', p.el('sr-retry').hidden === true && p.el('sr-gate-lead').textContent === textOf('sr-gate-lead') && p.el('sr-unlock').textContent === textOf('sr-unlock'));
    const g = loadPage(respond(200, GOOD));
    await g.generate();
    ok('a normal result: "We found 3 storm events", chips, no retry', g.el('sr-teaser-headline').textContent === 'We found 3 storm events near this address' && /2 hail/.test(g.el('sr-teaser-chips').innerHTML) && g.el('sr-retry').hidden === true);
    ok('…and the sub-line carries no partial caveat', !/couldn.t be checked/.test(g.el('sr-teaser-sub').textContent), g.el('sr-teaser-sub').textContent);
    await g.unlock();
    ok('…the full report and the lead story are exactly what they were', g.active === 'sr-report'
      && g.posted && g.posted.payload.story === 'STORM REPORT | 3 events/5yr (2 hail, 1 wind, 0 tornado, max 1.5″)'
      && /Report range: 5 years within 30 miles\.$/.test(g.el('sr-rep-source').textContent), g.posted && g.posted.payload.story);
  }

  console.log('\nPAGE — Retry runs the lookup again and restores the normal teaser when it works');
  {
    let calls = 0;
    const p = loadPage(() => (calls++ === 0 ? respond(500, {})() : respond(200, GOOD)()));
    await p.generate();
    ok('first lookup fails: failed teaser + Retry', /couldn.t check/i.test(p.el('sr-teaser-headline').textContent) && p.el('sr-retry').hidden === false);
    p.click('retry'); await settle();
    ok('Retry fetched the same point again', p.fetches.length === 2 && p.fetches[0] === p.fetches[1] && /lat=39\.087&lon=-84\.39/.test(p.fetches[1]), p.fetches);
    ok('…and the teaser now shows the real result, Retry hidden, gate copy back', p.el('sr-teaser-headline').textContent === 'We found 3 storm events near this address' && p.el('sr-retry').hidden === true
      && p.el('sr-gate-lead').textContent === textOf('sr-gate-lead') && p.el('sr-gate-sub').textContent === textOf('sr-gate-sub') && p.el('sr-unlock').textContent === textOf('sr-unlock'));
  }

  console.log('\nPAGE — a partial lookup that did find storms keeps them and says it may be incomplete');
  {
    const PART = Object.assign({}, GOOD, { partial: true, failedYears: 2 });
    const p = loadPage(respond(200, PART));
    await p.generate();
    ok('teaser still leads with the events found', p.el('sr-teaser-headline').textContent === 'We found 3 storm events near this address');
    ok('…and says some records could not be checked, so there may be more', /couldn.t be checked just now, so there may be more/.test(p.el('sr-teaser-sub').textContent), p.el('sr-teaser-sub').textContent);
    ok('…with Retry offered', p.el('sr-retry').hidden === false);
    await p.unlock();
    ok('full report: the table and stats are the real ones', /storm events/.test(p.el('sr-rep-summary').innerHTML) && /sr-tag sr-hail/.test(p.el('sr-rep-rows').innerHTML));
    ok('full report: the source line no longer claims a clean five-year range', /may be incomplete/.test(p.el('sr-rep-source').textContent) && /Source: /.test(p.el('sr-rep-source').textContent), p.el('sr-rep-source').textContent);
    ok('lead story: counts the years actually checked (3, not 5)', p.posted && p.posted.payload.story === 'STORM REPORT | 3 events/3yr (2 hail, 1 wind, 0 tornado, max 1.5″)', p.posted && p.posted.payload.story);
    const light = loadPage(respond(200, { counts: { total: 2, hail: 0, wind: 2, tornado: 0, stormDays: 1 }, maxHail: null, years: 5, radiusMi: 30, partial: true, failedYears: 1, events: [{ date: '2026-05-17T00:25:00Z', type: 'wind', magnitude: 50, unit: 'mph', distanceMi: 4, severity: 'minor' }] }));
    await light.generate(); await light.unlock();
    ok('a partial result never gets the "Light storm history on record" verdict', !/Light storm history/.test(light.el('sr-rep-detail').textContent) && /couldn.t be checked/.test(light.el('sr-rep-detail').textContent), light.el('sr-rep-detail').textContent);
  }

  console.log('\nPAGE — the full report after a failed lookup is honest in the verdict, table and source line');
  {
    const p = loadPage(respond(500, {}));
    await p.generate();
    await p.unlock();
    const head = p.el('sr-rep-headline').textContent, detail = p.el('sr-rep-detail').textContent;
    ok('the full report opens', p.active === 'sr-report');
    ok('verdict headline says the records could not be checked', /couldn.t check storm records/i.test(head), head);
    ok('verdict body: not a "no storms" result; free inspection is the way to be sure', /not a .no storms. result/i.test(detail) && /free inspection/i.test(detail) && !/Light storm history/.test(detail), detail);
    ok('no zero stat tiles (0 storm events / 0 hail / 0″ max hail)', p.el('sr-rep-summary').innerHTML === '', p.el('sr-rep-summary').innerHTML);
    ok('table: one honest row, not "No individual reports on file near this address"', /could(n.t| not) be checked/i.test(p.el('sr-rep-rows').innerHTML) && !/No individual reports/.test(p.el('sr-rep-rows').innerHTML), p.el('sr-rep-rows').innerHTML);
    ok('source line: says the lookup failed, no "Report range: 5 years within 30 miles"', /could not be checked/i.test(p.el('sr-rep-source').textContent) && !/Report range|NWS Local Storm Reports/.test(p.el('sr-rep-source').textContent), p.el('sr-rep-source').textContent);
    ok('nothing on the report reads as a verified all-clear', !FALSE_ALL_CLEAR.test([head, detail, p.el('sr-rep-rows').innerHTML, p.el('sr-rep-source').textContent].join(' ')));
    ok('the wind-gust block stays hidden', p.el('sr-rep-gusts').hidden === true);
    // The lead path itself is untouched: same call, same fields, the report point still rides along.
    const pl = p.posted && p.posted.payload;
    ok('lead capture: still submitPublicLead("inspect") with name, phone, email, source, consent, point', p.posted && p.posted.kind === 'inspect' && pl.name === 'Pat' && pl.phone === '(513) 555-0101' && pl.email === 'pat@example.com' && pl.source === '/storm-report' && pl.tcpaConsent === true && pl.lat === LAT && pl.lon === LON, pl);
    ok('the button does not say "Building your report…" for a report that has no data', p.el('sr-unlock').textContent === 'Sending…', p.el('sr-unlock').textContent);
    failedStory = pl.story;
    ok('lead story says the lookup was unavailable, never "0 events/5yr"', pl.story === 'STORM REPORT | storm records unavailable', pl.story);
    ok('no "report could not be auto-saved" warning when the lead saved', p.el('sr-rep-warn').style.display !== 'block');
  }

  // ═══════════════════════════════════════════════════════════════════════
  console.log('\nEMAIL — no "verified storm history" email for a lookup that failed');
  {
    const sent = [], updates = [];
    let claimed = 0;
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/firestore': { onDocumentCreated: (o, h) => ({ __opts: o, __handler: h }) },
      'firebase-functions/params': { defineSecret: (name) => ({ name, value: () => 'test-' + name }) },
      'firebase-functions/v2': { logger: noopLogger },
      resend: { Resend: class { constructor() { this.emails = { send: async (p) => { sent.push(p); return { data: { id: 'em' }, error: null }; } }; } } },
      'firebase-admin/firestore': {
        FieldValue: { serverTimestamp: () => '__ts__', delete: () => '__del__' },
        getFirestore: () => ({
          runTransaction: async (fn) => fn({ get: async () => ({ exists: true, get: () => null }), update() { claimed++; } }),
          doc: () => ({ get: async () => ({ exists: false }) }),
        }),
      },
      './integrations/asos-gust': { gustForAddressDay: async () => null },
      './rate-limit': { enforceRateLimit: async () => ({ allowed: true }), rateLimitIpKey: (x) => x },
    };
    const SR = fresh(F('storm-report-email.js'));
    stubs = null;
    const fire = (doc, id) => SR.stormReportEmail.__handler({ data: { data: () => doc, ref: { update: async (u) => { updates.push(u); } } }, params: { leadId: id } });
    const base = { source: '/storm-report', email: 'pat@example.com', name: 'Pat Q', address: '12 Oak St, Fort Thomas, KY 41075' };

    await fire(Object.assign({}, base, { story: failedStory }), 'f1');   // the exact line the page posted above
    ok('a lead whose storm lookup failed: no email is sent', sent.length === 0, sent.length);
    ok('…the one-shot claim is not consumed (nothing was "emailed")', claimed === 0 && !updates.some((u) => u && u.reportEmailedAt), { claimed, updates });
    ok('…and the lead is marked so the office can see why no copy went out', updates.some((u) => u && u.reportEmailHeld === 'storm_lookup_failed'), updates);

    await fire(Object.assign({}, base, { email: 'real@example.com', story: 'STORM REPORT | 42 events/5yr (3 hail, 38 wind, 1 tornado, max 1.75″)' }), 'f2');
    ok('a real report still gets its email, numbers intact', sent.length === 1 && /42 events\/5yr \(3 hail, 38 wind, 1 tornado, max 1\.75″\)/.test(sent[0].html));
    await fire(Object.assign({}, base, { email: 'partial@example.com', story: 'STORM REPORT | 3 events/3yr (2 hail, 1 wind, 0 tornado, max 1.5″)' }), 'f3');
    ok('a partial lookup\'s story (fewer years) still matches the email\'s shape', sent.length === 2 && /3 events\/3yr \(2 hail, 1 wind, 0 tornado, max 1\.5″\)/.test(sent[1].html));
    await fire(Object.assign({}, base, { email: 'junk@example.com', story: 'STORM REPORT | storm records unavailable http://evil.example' }), 'f4');
    ok('only the exact failed-lookup line suppresses the email (anything else is the old generic summary)', sent.length === 3 && /a multi-year history of hail and wind storms/.test(sent[2].html) && !/evil\.example/.test(sent[2].html));

    ok('the story under test is the one the page posts (not a literal the test made up)', typeof failedStory === 'string' && failedStory.length > 0);
  }

  Module._load = realLoad;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
