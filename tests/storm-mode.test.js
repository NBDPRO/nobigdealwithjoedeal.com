/**
 * tests/storm-mode.test.js — Storm Mode client logic (roadmap C2, OPT-IN).
 *
 *   A. alert parsing: only WARNINGS for hail / wind qualify (not watches or
 *      advisories), expired / cancelled / non-actual are dropped
 *   B. point-in-polygon + which customers sit inside a warned polygon
 *   C. the state machine: activate, update, all-clear needs two SUCCESSFUL
 *      empty polls (a failed poll is never an all-clear), drafts only after
 *      the storm has passed, 24 h pending window
 *   D. glue in a vm sandbox, injected clock, stubbed NWS: OFF by default and
 *      then NEVER touches the theme or the DOM; ON switches to Storm Season,
 *      stashes and restores the theme, "Keep my theme", a hand-pick during
 *      the storm is respected, no drafts while the storm is active, drafts
 *      only after all-clear and only when the setting is on
 *
 * Run: node tests/storm-mode.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', 'docs', 'pro', 'js', 'storm-mode.js');
const core = require(FILE);

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const T0 = Date.parse('2026-06-14T20:00:00Z');
const sq = (la, ln, d) => [[ln - d, la - d], [ln + d, la - d], [ln + d, la + d], [ln - d, la + d], [ln - d, la - d]]; // GeoJSON [lng,lat]
const feat = (id, event, over) => ({
  id, properties: Object.assign({ id, event, status: 'Actual', messageType: 'Alert', expires: new Date(T0 + 3600000).toISOString(), description: 'Wind gusts to 60 mph.', geocode: { UGC: ['OHC061'] }, parameters: {} }, (over || {}).props || {}),
  geometry: (over && 'geometry' in over) ? over.geometry : { type: 'Polygon', coordinates: [sq(39.1, -84.5, 0.1)] },
});

console.log('\nSTORM MODE — which alerts qualify');
{
  const json = { features: [
    feat('a1', 'Severe Thunderstorm Warning'),
    feat('a2', 'Severe Thunderstorm Watch'),
    feat('a3', 'Wind Advisory'),
    feat('a4', 'Tornado Warning'),
    feat('a5', 'High Wind Warning', { geometry: null }),
    feat('a6', 'Severe Thunderstorm Warning', { props: { expires: new Date(T0 - 1000).toISOString() } }),
    feat('a7', 'Severe Thunderstorm Warning', { props: { status: 'Test' } }),
    feat('a8', 'Severe Thunderstorm Warning', { props: { messageType: 'Cancel' } }),
    feat('a9', 'Flood Warning'),
  ] };
  const got = core.parseAlerts(json, T0).map((a) => a.id).sort().join();
  ok('only hail/wind WARNINGS qualify; watches, advisories, floods, expired, test, cancelled do not', got === 'a1,a4,a5', got);
  ok('hail hazard from maxHailSize', core.hazardOf({ parameters: { maxHailSize: ['1.75'] } }) === 'hail');
  ok('hail hazard from the text', core.hazardOf({ description: 'Quarter size hail possible' }) === 'hail');
  ok('otherwise wind', core.hazardOf({ description: 'Gusts to 60 mph' }) === 'wind');
  ok('a polygon-less warning has no rings but keeps its UGC codes', (() => { const a = core.parseAlerts(json, T0).find((x) => x.id === 'a5'); return a.rings.length === 0 && a.ugc[0] === 'OHC061'; })());
}

console.log('\nSTORM MODE — customers inside the polygon');
{
  const a = core.parseAlerts({ features: [feat('p', 'Severe Thunderstorm Warning')] }, T0)[0];
  const leads = [
    { id: 'in1', lat: 39.1, lng: -84.5 },
    { id: 'in2', lat: '39.15', lng: '-84.45' },
    { id: 'out', lat: 39.5, lng: -84.5 },
    { id: 'nocoord' },
    { id: 'zero', lat: 0, lng: 0 },
    { id: 'gone', lat: 39.1, lng: -84.5, deleted: true },
    { id: 'test', lat: 39.1, lng: -84.5, e2eTestData: true },
  ];
  ok('inside = exactly the customers with coordinates in the polygon', core.customersInside(a, leads).sort().join() === 'in1,in2', core.customersInside(a, leads).join());
  ok('no polygon, no customers (zone-wide warnings never pick a recipient list)', core.customersInside({ rings: [] }, leads).length === 0);
  ok('pointInRing: edge sanity', core.pointInRing(0.5, 0.5, [[0, 0], [0, 1], [1, 1], [1, 0]]) && !core.pointInRing(1.5, 0.5, [[0, 0], [0, 1], [1, 1], [1, 0]]));
  const anchors = core.serviceAnchors([{ lat: 39.1, lng: -84.4 }, { lat: 39.12, lng: -84.42 }, { lat: 38.9, lng: -84.6 }, { id: 'x' }]);
  ok('anchors: densest grid cell first, rounded cell centre (not an address)', anchors[0].n === 2 && Math.abs(anchors[0].lat - 39.125) < 0.01 && anchors.length === 2);
}

console.log('\nSTORM MODE — state machine');
{
  const hit = (ids) => ({ matches: [{ id: 'w1', hazard: 'hail', leadIds: ids }] });
  let r = core.step({}, hit(['a', 'b']), T0);
  ok('a match activates', r.state.active && r.actions[0] === 'activate' && r.state.leadIds.length === 2 && /^sm[0-9a-f]{8}$/.test(r.state.eventKey));
  ok('no drafts are pending while the storm is active', !r.state.pending && r.actions.indexOf('file-drafts') < 0);
  let s = r.state;
  r = core.step(s, hit(['b', 'c']), T0 + 300000);
  ok('a second poll updates and unions the customers', r.actions[0] === 'update' && r.state.leadIds.sort().join() === 'a,b,c');
  s = r.state;
  r = core.step(s, null, T0 + 600000);
  ok('a FAILED poll (null) is never an all-clear', r.state.active && r.actions.length === 0 && r.state.clearPolls === 0);
  r = core.step(s, { matches: [] }, T0 + 600000);
  ok('one empty poll is not yet all-clear', r.state.active && r.actions.length === 0 && r.state.clearPolls === 1);
  r = core.step(r.state, { matches: [] }, T0 + 900000);
  ok('two empty polls = all-clear, then drafts are queued for the customers in the path', !r.state.active && r.actions.join() === 'all-clear,file-drafts' && r.state.pending.leadIds.sort().join() === 'a,b,c');
  ok('the pending draft carries the event key + hazard the server needs', r.state.pending.eventKey === s.eventKey && r.state.pending.hazard === 'hail');
  const again = core.step(r.state, { matches: [] }, T0 + 1200000);
  ok('pending drafts keep being offered until they are filed', again.actions.join() === 'file-drafts');
  const old = core.step(r.state, { matches: [] }, T0 + 900000 + core.DRAFT_WINDOW_MS + 1000);
  ok('after 24 h an unfiled draft set is dropped, not sent late', !old.state.pending && old.actions.length === 0);
  const zone = core.step({}, { matches: [{ id: 'z', hazard: 'wind', leadIds: [] }] }, T0);
  const zoneEnd = core.step(core.step(zone.state, { matches: [] }, T0 + 1).state, { matches: [] }, T0 + 2);
  ok('a zone-wide warning (no polygon) never queues drafts', zoneEnd.actions.join() === 'all-clear' && !zoneEnd.state.pending);
  ok('event key is order independent and stable', core.eventKeyOf(['b', 'a']) === core.eventKeyOf(['a', 'b']) && core.eventKeyOf(['a']) !== core.eventKeyOf(['b']));
}

// ── glue ──────────────────────────────────────────────────────────
function harness(opts) {
  opts = opts || {};
  const listeners = {};
  const store = Object.assign({}, opts.storage || {});
  const body = { classes: new Set(), classList: { add(c) { body.classes.add(c); }, remove(c) { body.classes.delete(c); }, contains(c) { return body.classes.has(c); } }, appended: [], appendChild(el) { body.appended.push(el); } };
  const els = {};
  const document = {
    readyState: 'complete', hidden: false, body,
    head: { appendChild() {} },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    getElementById(id) { return els[id] || null; },
    createElement() {
      const el = { children: [], attrs: {}, hidden: false, className: '', textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, hasAttribute(k) { return k in this.attrs; }, getAttribute(k) { return this.attrs[k]; }, appendChild(c) { this.children.push(c); }, querySelector(sel) { const m = /data-sm-keep/.test(sel) ? 'data-sm-keep' : /msg/.test(sel) ? 'msg' : null; return this.children.find((c) => (m === 'msg' ? c.className === 'storm-mode-msg' : m && c.attrs[m])) || null; } };
      return el;
    },
    dispatchEvent(ev) { (listeners[ev.type] || []).forEach((f) => f(ev)); },
  };
  let current = opts.current || 'nbd-original';
  const applied = [];
  const ThemeEngine = {
    getCurrent: () => current,
    get: () => ({}), isUnlocked: () => true, getAll: () => ({}),
    apply(k, save) { applied.push({ key: k, save }); current = k; document.dispatchEvent({ type: 'themechange', detail: k }); },
  };
  const win = { ThemeEngine, document, _leads: [{ id: 'L1', lat: 39.1, lng: -84.5 }], showToast() {}, _functions: {} };
  win.window = win;
  const calls = [];
  win._httpsCallable = (fns, name) => (payload) => { calls.push({ name, payload }); return Promise.resolve({ data: { ok: true, filed: (payload.leadIds || []).length } }); };
  const sb = {
    window: win, document, localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    fetch: () => { throw new Error('network must not be touched in this test'); },
    console, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    Date, Math, JSON, Object, Array, Number, String, isFinite, Promise, encodeURIComponent,
  };
  vm.runInNewContext(fs.readFileSync(FILE, 'utf8'), sb, { filename: 'storm-mode.js' });
  const S = win.NBDStormMode;
  S._reset();
  let now = T0;
  S._setClock(() => now);
  return { S, win, document, body, applied, store, calls, setNow(n) { now = n; }, current: () => current, userPicks(k) { current = k; document.dispatchEvent({ type: 'themechange', detail: k }); },
    banner() { return body.appended[0] || null; } };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  console.log('\nSTORM MODE — glue (injected clock, stubbed NWS)');
  {
    const h = harness();
    ok('OFF by default', h.S.isEnabled() === false);
    h.S._observeWith(() => Promise.resolve({ matches: [{ id: 'w', hazard: 'hail', leadIds: ['L1'] }] }));
    await h.S.poll();
    ok('off: a warning changes nothing — no theme switch, no class, no banner, no network', h.applied.length === 0 && !h.body.classes.has('storm-alert') && h.body.appended.length === 0 && h.calls.length === 0);
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    ok('enabling writes the device flag and the cfg copy', h.store.nbd_storm_mode === '1' && JSON.parse(h.store.nbd_storm_mode_cfg).enabled === true);
    let obs = { matches: [{ id: 'w', hazard: 'hail', leadIds: ['L1'] }] };
    h.S._observeWith(() => Promise.resolve(obs));
    await h.S.poll();
    ok('a warning over a customer switches to Storm Season, unsaved', h.current() === 'storm-season' && h.applied[0].save === false);
    ok('body.storm-alert is set and the banner shows', h.body.classes.has('storm-alert') && h.banner() && h.banner().hidden === false);
    ok('the banner links to Storm Watch through the delegated goTo action, no inline handler', h.banner().children.some((c) => c.attrs['data-action'] === 'goTo' && c.attrs['data-target'] === 'storm') && !h.banner().children.some((c) => Object.keys(c.attrs).some((k) => /^on/i.test(k))));
    ok('the banner never shows a customer name or address', !/L1|Maria|St\b/.test(h.banner().children[0].textContent) && /1 customer address/.test(h.banner().children[0].textContent));
    ok('no drafts are filed while the storm is active', h.calls.length === 0);
    obs = { matches: [] };
    h.setNow(T0 + 300000); await h.S.poll();
    ok('first empty poll: still in storm mode', h.current() === 'storm-season');
    h.setNow(T0 + 600000); await h.S.poll(); await settle(); await settle();
    ok('all-clear restores the stashed theme', h.current() === 'nbd-original' && !h.body.classes.has('storm-alert'));
    ok('banner is hidden at all-clear', h.banner().hidden === true);
    ok('after all-clear exactly one draft request is made, with ids + hazard only (no wording)', h.calls.length === 1 && h.calls[0].name === 'fileStormDrafts'
      && JSON.stringify(Object.keys(h.calls[0].payload).sort()) === '["eventKey","hazard","leadIds"]' && h.calls[0].payload.leadIds.join() === 'L1' && h.calls[0].payload.hazard === 'hail');
    h.setNow(T0 + 900000); await h.S.poll(); await settle();
    ok('drafts are not requested twice', h.calls.length === 1);
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    h.S.update({ keepTheme: true });
    h.S._observeWith(() => Promise.resolve({ matches: [{ id: 'w', hazard: 'wind', leadIds: ['L1'] }] }));
    await h.S.poll();
    ok('"banner only" setting: banner shows, theme and accent untouched', h.current() === 'nbd-original' && h.applied.length === 0 && !h.body.classes.has('storm-alert') && h.banner() && h.banner().hidden === false);
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    h.S._observeWith(() => Promise.resolve({ matches: [{ id: 'w', hazard: 'hail', leadIds: ['L1'] }] }));
    await h.S.poll();
    const keepBtn = h.banner().children.find((c) => c.attrs['data-sm-keep']);
    h.document.dispatchEvent({ type: 'click', target: { closest: () => keepBtn } });
    ok('"Keep my theme" restores it immediately and drops the yellow accent', h.current() === 'nbd-original' && !h.body.classes.has('storm-alert'));
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    let obs = { matches: [{ id: 'w', hazard: 'hail', leadIds: ['L1'] }] };
    h.S._observeWith(() => Promise.resolve(obs));
    await h.S.poll();
    h.userPicks('ember');
    obs = { matches: [] };
    h.setNow(T0 + 300000); await h.S.poll(); h.setNow(T0 + 600000); await h.S.poll(); await settle();
    ok('a theme the user picked mid-storm is never overwritten at all-clear', h.current() === 'ember');
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    h.S.update({ drafts: false });
    let obs = { matches: [{ id: 'w', hazard: 'hail', leadIds: ['L1'] }] };
    h.S._observeWith(() => Promise.resolve(obs));
    await h.S.poll();
    obs = { matches: [] };
    h.setNow(T0 + 300000); await h.S.poll(); h.setNow(T0 + 600000); await h.S.poll(); await settle(); await settle();
    ok('drafts setting off: theme restores and no draft request is made', h.current() === 'nbd-original' && h.calls.length === 0);
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    h.S._observeWith(() => Promise.resolve(null));
    await h.S.poll();
    ok('a failed NWS poll changes nothing', h.applied.length === 0 && h.S.getState().active !== true);
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    h.S.preview();
    ok('preview shows the look (theme + banner) but queues nothing and calls nothing', h.current() === 'storm-season' && h.calls.length === 0 && /PREVIEW/.test(h.banner().children[0].textContent));
    h.S.endPreview();
    ok('preview ends back on the user\'s theme', h.current() === 'nbd-original' && !h.body.classes.has('storm-alert'));
  }
  {
    const h = harness();
    h.S.setEnabled(true);
    h.S._observeWith(() => Promise.resolve({ matches: [{ id: 'w', hazard: 'hail', leadIds: ['L1'] }] }));
    await h.S.poll();
    h.S.setEnabled(false);
    ok('turning it off mid-storm puts the theme back and hides the banner', h.current() === 'nbd-original' && h.banner().hidden === true && !('nbd_storm_mode' in h.store));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
