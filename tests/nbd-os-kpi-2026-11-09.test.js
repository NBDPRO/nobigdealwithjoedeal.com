/**
 * tests/nbd-os-kpi-2026-11-09.test.js - NBD OS P3 "Saved view" KPI tile
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P3, XFCE genmon).
 *
 * The tile counts the leads already in memory (window._leads) that match one of the
 * team's EXISTING saved filters: the Customers map layer's saved views
 * (companyProfile.mapViews, docs/pro/js/maps-customers.js). No new filter language:
 * os/kpi-logic.js is the map's own test as pure code, and this suite runs both over
 * the same leads to pin parity (the map's _custApplyView + _custPasses, vm-loaded).
 * It stores the view's id only (never its name or filters), shows no number when the
 * view or the leads are missing, opens that view on the Map when tapped, and several
 * tiles may sit on one home within the 24 cap. Renderers load as the runtime
 * ScriptLoader bundle 'oskpi' (layout-system.js needs is full).
 *
 * Run: node tests/nbd-os-kpi-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const KL = req('docs/pro/js/os/kpi-logic.js');
const tick = () => new Promise((r) => setImmediate(r));
const MAPS_SRC = read('docs/pro/js/maps-customers.js');
const KPI_JS = read('docs/pro/js/os/kpi.js');
const KPI_CSS = read('docs/pro/css/os/kpi.css');
const HOME_JS = read('docs/pro/js/os/home.js');

// ── the map's own filter, vm-loaded (as tests/map-views-hydration.test.js does) ──
function mapFilter(win) {
  const sandbox = {
    window: win, document: { getElementById() { return null; }, createElement() { return { style: {} }; }, head: { appendChild() {} } },
    navigator: {}, mainMap: null, L: {}, console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(MAPS_SRC, sandbox, { filename: 'maps-customers.js' });
  sandbox.buildCustomersLayer = function () {};   // _custApplyView rebuilds the layer: no map here
  return {
    count(view, leads) {
      sandbox._custApplyView(view);
      let n = 0;
      for (const lead of leads) { if (!lead || lead.deleted) continue; if (sandbox._custPasses(lead)) n++; }
      return n;
    },
    sandbox,
  };
}

// a small seeded generator: the same leads and views every run
let seed = 20261109;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pickOne = (a) => a[Math.floor(rnd() * a.length)];
const STAGES = ['new', 'contacted', 'Inspection Scheduled', 'estimate_sent', 'won', 'lost', 'in_production', '', undefined, 'weird stage'];
const DAMAGE = ['Hail', 'hail and wind', 'WIND', 'fire', 'Water leak', 'gutters', 'Full exterior', 'mold', '', undefined, '  '];
const VALUES = [0, '0', 5000, '9999.99', 10000, 24999, '25000', 49999, 50000, 120000, '', null, 'abc', -5];
const REPS = ['u1', 'u2', 'u3', '', undefined];
const ROLES = { new: 'new', contacted: 'active', inspection_scheduled: 'active', estimate_sent: 'active', won: 'won', lost: 'lost', in_production: 'job' };
const env = {
  normalizeStage: (s) => String(s || 'new').toLowerCase().replace(/\s+/g, '_'),
  stageRole: (k) => { if (k === 'weird_stage') throw new Error('unknown stage'); return ROLES[k] || 'active'; },
};
function makeLead(i) {
  const l = { id: 'L' + i, stage: pickOne(STAGES), damageType: pickOne(DAMAGE), userId: pickOne(REPS), assignedTo: pickOne(REPS) };
  const v = pickOne(VALUES);
  const which = pickOne(['jobValue', 'value', 'contractValue']);
  l[which] = v;
  if (rnd() < 0.2) l._stageKey = pickOne(['won', 'new', 'estimate_sent']);
  if (rnd() < 0.2) l._stageRole = pickOne(['job', 'won']);
  if (rnd() < 0.1) l.deleted = true;
  return l;
}
const LEADS = []; for (let i = 0; i < 400; i++) LEADS.push(makeLead(i));
LEADS.push(null);
const DIMCATS = { stage: ['new', 'active', 'job', 'won', 'lost'], damage: ['hailwind', 'hail', 'wind', 'fire', 'water', 'gutters', 'full', 'other', 'unset'], value: ['v0', 'v1', 'v2', 'v3', 'v4'], rep: ['u1', 'u2', 'u3', 'unassigned'] };
function makeView(i) {
  const f = {};
  Object.keys(DIMCATS).forEach((dk) => { f[dk] = rnd() < 0.5 ? null : DIMCATS[dk].filter(() => rnd() < 0.5); });
  const v = { name: 'View ' + i, colorBy: pickOne(['stage', 'damage', 'value', 'rep']), filters: f };
  const r = rnd();
  if (r < 0.3) { v.valMin = pickOne([0, 2500, 10000, 25000]); v.valMax = pickOne([100000, 50000, 25000, 0]); }
  else if (r < 0.4) { v.valMin = '5000'; v.valMax = null; }   // not numbers: the map's defaults
  return v;
}

console.log('\n1. parity with the map\'s own filter (maps-customers.js _custApplyView + _custPasses)');
{
  ok('kpi-logic loads in Node', !!KL && typeof KL.count === 'function' && typeof KL.viewId === 'function');
  const win = { normalizeStage: env.normalizeStage, stageRole: env.stageRole, _leads: LEADS, _companyProfile: {} };
  const M = mapFilter(win);
  const bad = [];
  const fixed = [
    { name: 'Hot Hail >$25k', colorBy: 'damage', filters: { stage: null, damage: ['hail'], value: null, rep: null }, valMin: 25000, valMax: 100000 },
    { name: 'Won jobs', colorBy: 'stage', filters: { stage: ['won'], damage: null, value: null, rep: null }, valMin: 0, valMax: 100000 },
    { name: 'Everything' },
    { name: 'Nothing', filters: { stage: [] } },
    { name: 'Riley, unassigned', filters: { rep: ['u2', 'unassigned'] }, valMax: 0 },
  ];
  const views = fixed.concat(Array.from({ length: 300 }, (_, i) => makeView(i)));
  views.forEach((v) => {
    const a = KL && KL.count(v, LEADS, env), b = M.count(v, LEADS);
    if (a !== b) bad.push(v.name + ': tile ' + a + ' vs map ' + b);
  });
  ok('the tile\'s count equals the map\'s over 305 saved views x 401 leads', !bad.length, bad.slice(0, 3).join(' | '));
  ok('…and the counts are real (a filter that matches some, one that matches none)', KL && KL.count(fixed[1], LEADS, env) > 0 && KL.count(fixed[3], LEADS, env) === 0 && KL.count(fixed[2], LEADS, env) === LEADS.filter((l) => l && !l.deleted).length);
  const per = [];
  LEADS.slice(0, 120).forEach((l) => { if (!l || l.deleted) return; views.slice(0, 40).forEach((v) => { M.sandbox._custApplyView(v); if (KL.passes(v, l, env) !== M.sandbox._custPasses(l)) per.push(l.id + '/' + v.name); }); });
  ok('…and lead by lead (passes == _custPasses)', !per.length, per.slice(0, 3).join(' | '));
  ok('leads not loaded (not a list): no count, never 0', KL && KL.count(fixed[0], null, env) === null && KL.count(fixed[0], undefined, env) === null);
  ok('a view that is not an object: no count', KL && KL.count(null, LEADS, env) === null && KL.count('x', LEADS, env) === null);
}

console.log('\n2. views and ids (ids only, never the name)');
{
  const prof = { mapViews: [{ name: 'Hot Hail' }, null, 'junk', { name: '' }, { name: 'Hot Hail', filters: { stage: ['won'] } }, { name: 'Wind <b>x</b>' }] };
  const list = KL.listViews(prof);
  ok('listViews: objects only, in the map\'s order, an unnamed one named as the map names it ("View 4")', J(list.map((v) => v.name)) === J(['Hot Hail', 'View 4', 'Wind <b>x</b>']), J(list));
  ok('…two views with one name: the first wins', list[0].index === 0);
  ok('ids are 8 lowercase hex characters and stable', list.every((v) => /^[0-9a-f]{8}$/.test(v.id)) && KL.viewId('Hot Hail') === KL.viewId('Hot Hail') && KL.viewId('Hot Hail') !== KL.viewId('Hot hail'));
  ok('findView by id; a bad or unknown id finds nothing', KL.findView(prof, list[0].id).view === prof.mapViews[0] && KL.findView(prof, 'zzzzzzzz') === null && KL.findView(prof, '00000000') === null && KL.findView(null, list[0].id) === null);
  ok('no mapViews (or no profile): no views', J(KL.listViews({})) === '[]' && J(KL.listViews(null)) === '[]');
}

console.log('\n3. the catalog and the os-home key');
{
  const c = HL && HL.CATALOG.kpi;
  ok('kpi: "Saved view", S/M, reads 0, an id setting, never a stack card, the oskpi bundle, in Tools', c && c.title === 'Saved view' && J(c.sizes) === J(['s', 'm']) && c.def === 's' && c.reads === 0 && J(c.cfgId) === J(['view']) && c.nostack === true && c.bundle === 'oskpi' && c.cat === 'tools', J(c));
  ok('cfg keeps an 8-hex id and nothing else', J(HL.cleanCfg('kpi', { view: 'a1b2c3d4', name: 'Hot Hail', filters: {} })) === J({ view: 'a1b2c3d4' }));
  ok('…a name, markup or a long string is dropped', HL.cleanCfg('kpi', { view: 'Hot Hail' }) === null && HL.cleanCfg('kpi', { view: '<img src=x>' }) === null && HL.cleanCfg('kpi', { view: 'a1b2c3d4e' }) === null && HL.cleanCfg('kpi', { view: 12345678 }) === null);
  ok('another widget never takes an id setting', HL.cleanCfg('coach', { view: 'a1b2c3d4' }) === null);
  const many = []; for (let i = 0; i < 30; i++) many.push({ id: 'kpi', s: 'm', cfg: { view: KL.viewId('v' + i) } });
  const k = HL.normalize({ phone: many, desk: many });
  ok('several tiles on one home, each its own view, within the 24 cap', k.phone.length === 24 && new Set(k.phone.map((x) => x.cfg.view)).size === 24 && k.desk.length === 24, k.phone.length);
  ok('a Smart Stack never holds one (its card would have no view)', J(HL.stackItems(['kpi', 'glance'])) === J(['glance']) && HL.toggleCard([{ id: 'stack', s: 'm', items: ['glance'] }], 0, 'kpi') === null);
  ok('Add puts one in (no view yet)', J(HL.add([{ id: 'glance', s: 'm' }], 'kpi', 's').slice(-1)) === J([{ id: 'kpi', s: 's' }]));
}

// ── the widget on a real home (the fake-DOM harness, the real layout) ──
const VIEWS = [
  { name: 'Hot Hail >$25k', colorBy: 'damage', filters: { stage: null, damage: ['hail'], value: null, rep: null }, valMin: 25000, valMax: 100000 },
  { name: 'Won <b>jobs</b>', colorBy: 'stage', filters: { stage: ['won'], damage: null, value: null, rep: null }, valMin: 0, valMax: 100000 },
];
const HOME_LEADS = [
  { id: 'a', stage: 'won', damageType: 'Hail', jobValue: 30000 },
  { id: 'b', stage: 'won', damageType: 'wind', jobValue: 5000 },
  { id: 'c', stage: 'new', damageType: 'hail', jobValue: '26000' },
  { id: 'd', stage: 'won', damageType: 'hail', jobValue: 40000, deleted: true },
  { id: 'e', stage: 'new', damageType: 'hail', jobValue: 1000 },
];
const ID0 = KL.viewId(VIEWS[0].name), ID1 = KL.viewId(VIEWS[1].name);
async function mount(items, opts) {
  const o = opts || {};
  const T = makeWin(Object.assign({ surface: o.phone ? 'phone' : 'desk', loader: true, leads: HOME_LEADS,
    home: o.phone ? { phone: items, desk: [] } : { phone: [], desk: items } }, o));
  T.W._companyProfile = o.profile === undefined ? { mapViews: VIEWS } : o.profile;
  T.W._companyProfileLoaded = o.profileLoaded === undefined ? true : o.profileLoaded;
  T.W.normalizeStage = (s) => String(s || 'new').toLowerCase();
  T.W.stageRole = (k) => (k === 'won' ? 'won' : k === 'new' ? 'new' : 'active');
  T.W._impl.mount({ surface: o.phone ? 'phone' : 'desktop' });
  for (let i = 0; i < 6; i++) await tick();
  const ph = o.phone ? T.document.getElementById('osPhone') : T.document.querySelector('.os-widgets');
  return { T, ph, card: (k) => byKey(ph, k) };
}

(async () => {
  console.log('\n4. the tile: one counted number, a tap opens the view');
  {
    const m = await mount([{ id: 'kpi', s: 's', cfg: { view: ID0 } }, { id: 'kpi', s: 'm', cfg: { view: ID1 } }]);
    const c1 = m.card('kpi-1'), c2 = m.card('kpi-2');
    ok('the oskpi bundle was registered and loaded on first paint', m.T.W.ScriptLoader.calls.indexOf('oskpi') !== -1 && J(m.T.W.ScriptLoader.bundles.oskpi) === J(['css/os/kpi.css?v=1', 'js/os/kpi-logic.js?v=1', 'js/os/kpi.js?v=1']), J(m.T.W.ScriptLoader.calls));
    ok('S: the view\'s name and its count (2: one hail lead over $25k is deleted, one is under)', /Hot Hail >\$25k/.test(text(c1)) && text(c1.querySelector('.os-kpi-n')) === '2', text(c1));
    ok('M: its own view (Won: 2 not deleted) and Change view', text(c2.querySelector('.os-kpi-n')) === '2' && !!c2.querySelector('[data-oshw-kpi="pick"]'), text(c2));
    ok('a view name with markup arrives as text', !c2.querySelector('b') && /Won <b>jobs<\/b>/.test(text(c2)), c2.innerHTML);
    ok('the number is a 44px button with a spoken label', c1.querySelector('button.os-hw-row.os-kpi-big[data-oshw-kpi="open"]') && /^2 leads match Hot Hail >\$25k\. Open it on the map$/.test(c1.querySelector('[data-oshw-kpi="open"]').getAttribute('aria-label')));
    ok('no Firestore read, no compute()', m.T.reads.length === 0 && m.T.today.computeCalls === 0, J(m.T.reads));
    let opened = null;
    m.T.W.openCustomersView = (name) => { opened = name; };
    click(m.T.dom, c1.querySelector('[data-oshw-kpi="open"]'));
    await tick(); await tick();
    ok('tap: the Map (goTo map), then that view by name (maps-customers.js openCustomersView)', m.T.W.goTos.slice(-1)[0] === 'map' && opened === VIEWS[0].name, J([m.T.W.goTos, opened]));
    // the leads change: the count follows on the next event, still no read
    m.T.W._leads = HOME_LEADS.concat([{ id: 'f', stage: 'won', damageType: 'hail', jobValue: 99000 }]);
    m.T.W.dispatchEvent(new m.T.W.CustomEvent('nbd:data-refreshed'));
    ok('new leads: the count follows on the next refresh event', text(m.card('kpi-1').querySelector('.os-kpi-n')) === '3' && m.T.reads.length === 0, text(m.card('kpi-1')));
  }

  console.log('\n5. missing data shows no number');
  {
    const none = await mount([{ id: 'kpi', s: 'm' }]);
    ok('no view picked: no number, a Pick a view button', !none.card('kpi-1').querySelector('.os-kpi-n') && !!none.card('kpi-1').querySelector('[data-oshw-kpi="pick"]') && !/\d/.test(text(none.card('kpi-1'))), text(none.card('kpi-1')));
    const gone = await mount([{ id: 'kpi', s: 's', cfg: { view: KL.viewId('Deleted view') } }]);
    ok('a view that is gone (deleted, or another company\'s): no number, says so', !gone.card('kpi-1').querySelector('.os-kpi-n') && /gone/.test(text(gone.card('kpi-1'))) && !/\d/.test(text(gone.card('kpi-1'))), text(gone.card('kpi-1')));
    const noViews = await mount([{ id: 'kpi', s: 'm', cfg: { view: ID0 } }], { profile: {} });
    ok('no saved views at all: says how to make one, no number', /no saved map views/.test(text(noViews.card('kpi-1'))) && !noViews.card('kpi-1').querySelector('.os-kpi-n') && !noViews.card('kpi-1').querySelector('[data-oshw-kpi="pick"]'), text(noViews.card('kpi-1')));
    const noProfile = await mount([{ id: 'kpi', s: 's', cfg: { view: ID0 } }], { profile: null });
    ok('no company profile: no number', !noProfile.card('kpi-1').querySelector('.os-kpi-n'), text(noProfile.card('kpi-1')));
    const notLoaded = await mount([{ id: 'kpi', s: 's', cfg: { view: ID0 } }], { leadsLoaded: false });
    ok('leads not loaded yet: the name, "Waiting for your leads", never 0', /Waiting for your leads/.test(text(notLoaded.card('kpi-1'))) && !notLoaded.card('kpi-1').querySelector('.os-kpi-n'), text(notLoaded.card('kpi-1')));
    // the profile not read yet (_companyProfileLoaded unset): it holds the NBD defaults, mapViews []
    const early = await mount([{ id: 'kpi', s: 'm', cfg: { view: ID0 } }, { id: 'kpi', s: 's' }], { profile: { mapViews: [] }, profileLoaded: undefined });
    early.T.W._companyProfileLoaded = false;
    early.T.W.dispatchEvent(new early.T.W.CustomEvent('nbd:data-refreshed'));
    const e1 = early.card('kpi-1'), e2 = early.card('kpi-2');
    ok('profile not loaded yet: a picked tile says the views are loading, never "no saved map views"', /Loading your team's views/.test(text(e1)) && !/no saved/i.test(text(e1)) && !e1.querySelector('.os-kpi-n') && !e1.querySelector('[data-oshw-kpi="pick"]'), text(e1));
    ok('…and an unpicked one too (S)', /Loading your team's views/.test(text(e2)) && !/no saved/i.test(text(e2)), text(e2));
    early.T.W._companyProfile = { mapViews: VIEWS };
    early.T.W._companyProfileLoaded = true;
    early.T.W.dispatchEvent(new early.T.W.CustomEvent('nbd:company-profile-loaded'));
    ok('…the profile lands (nbd:company-profile-loaded): the count shows', text(early.card('kpi-1').querySelector('.os-kpi-n')) === '2', text(early.card('kpi-1')));
    early.T.W._companyProfileLoaded = false;
    early.T.W._companyProfile = { mapViews: [] };
    early.T.W.NBDOSKpi.pick({});
    await tick();
    const ed = early.T.document.querySelector('dialog.os-kpi-dlg');
    ok('the picker before the profile lands: says the views are loading, not "no saved map views"', ed && /still loading/.test(text(ed)) && !/no saved map views/.test(text(ed)) && !ed.querySelector('[data-oskpi-view]'), ed && text(ed));
    // the bundle fails: Couldn't load, Retry (never a number)
    const T = makeWin({ surface: 'desk', home: { phone: [], desk: [{ id: 'kpi', s: 's', cfg: { view: ID0 } }] }, leads: HOME_LEADS });
    T.W.ScriptLoader = { bundles: {}, loadBundle: () => Promise.reject(new Error('offline')) };
    T.W._companyProfile = { mapViews: VIEWS };
    T.W._impl.mount({ surface: 'desktop' });
    for (let i = 0; i < 6; i++) await tick();
    const fc = byKey(T.document.querySelector('.os-widgets'), 'kpi-1');
    ok('the bundle fails: Couldn\'t load with Retry', fc && !!fc.querySelector('[data-oshw-retry="kpi"]') && !fc.querySelector('.os-kpi-n'), fc && text(fc));
  }

  console.log('\n6. picking a view (the tile\'s own button and the edit-mode View chip)');
  {
    const m = await mount([{ id: 'kpi', s: 'm' }, { id: 'glance', s: 'm' }], { phone: true });
    click(m.T.dom, m.card('kpi-1').querySelector('[data-oshw-kpi="pick"]'));
    await tick(); await tick();
    const d = m.T.document.querySelector('dialog.os-kpi-dlg');
    ok('Pick a view opens a native <dialog> listing the team\'s views with their counts', d && d.querySelectorAll('[data-oskpi-view]').length === 2 && /2 leads match/.test(text(d)), d && text(d));
    ok('…the names arrive as text', d && !d.querySelector('b'));
    click(m.T.dom, d.querySelector('[data-oskpi-view="' + ID1 + '"]'));
    await tick();
    const save = (m.T.W._saves || []).slice(-1)[0];
    m.T.fire(700);   // the layout's SAVE_MS write
    const after = (m.T.W._saves || []).slice(-1)[0] || save;
    const ph = after && after.layoutState && after.layoutState['os-home'] && after.layoutState['os-home'].phone;
    ok('the pick is saved as the tile\'s cfg: the id only', ph && J(ph.find((x) => x.id === 'kpi').cfg) === J({ view: ID1 }), J(after));
    ok('…through saveUser, os-home only (patch-only)', after && J(Object.keys(after.layoutState)) === J(['os-home']));
    ok('…and the tile shows that view\'s count', text(m.card('kpi-1').querySelector('.os-kpi-n')) === '2' && /Won/.test(text(m.card('kpi-1'))), text(m.card('kpi-1')));
    // edit mode: the View chip
    m.T.W._impl && m.T.W.NBDOSLayout;
    const Hm = m.T.W.NBDOSLayout.state().home;
    Hm.setEditing(true);
    const chip = m.card('kpi-1').querySelector('[data-oshw-ed="kpiview"]');
    ok('edit mode: a View chip on the tile (and none on other widgets)', !!chip && !m.card('glance-1').querySelector('[data-oshw-ed="kpiview"]'));
    click(m.T.dom, chip);
    await tick(); await tick();
    ok('…which opens the same picker, the current view marked', !!m.T.document.querySelector('dialog.os-kpi-dlg [data-oskpi-view="' + ID1 + '"][aria-pressed="true"]'));
  }

  console.log('\n7. a company-locked home: the pick is refused, with the lock message');
  {
    const co = { defaultWidgets: { 'os-phone': [{ id: 'kpi', s: 'm', cfg: { view: ID0 } }], 'os-desk': [] }, homeLocked: true };
    const m = await mount([], { phone: true, company: co, claims: { role: 'sales_rep', companyId: 'c1' }, home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } });
    ok('the locked company home paints its tile with the published view', text(m.card('kpi-1').querySelector('.os-kpi-n')) === '2', text(m.card('kpi-1')));
    const c = m.card('kpi-1');
    ok('a locked tile offers no Pick a view / Change view (a pick could only be refused)', !c.querySelector('[data-oshw-kpi="pick"]') && !!c.querySelector('[data-oshw-kpi="open"]'), c.innerHTML);
    const unpicked = await mount([], { phone: true, company: { defaultWidgets: { 'os-phone': [{ id: 'kpi', s: 'm' }], 'os-desk': [] }, homeLocked: true }, claims: { role: 'sales_rep', companyId: 'c1' }, home: { phone: [{ id: 'glance', s: 'm' }], desk: [] } });
    const u = unpicked.card('kpi-1');
    ok('…a locked tile with no view says the company has not picked one, no button, no number', !u.querySelector('[data-oshw-kpi="pick"]') && !u.querySelector('.os-kpi-n') && /company/i.test(text(u)), text(u));
    // the refusal path itself (only reachable if edit mode were on): nothing saved, the lock toast, no "Counting" said
    const before = (m.T.W._saves || []).length;
    const Hm = m.T.W.NBDOSLayout.state().home;
    Hm.setEditing(true);
    const chip = m.card('kpi-1').querySelector('[data-oshw-ed="kpiview"]');
    if (chip) {
      click(m.T.dom, chip);
      await tick(); await tick();
      const dv = m.T.document.querySelector('dialog.os-kpi-dlg [data-oskpi-view="' + ID1 + '"]');
      if (dv) click(m.T.dom, dv);
      await tick(); m.T.fire(700);
    }
    const live = m.T.document.querySelector('.os-hw-live[role="status"]');
    ok('a refused pick: nothing is saved and the member is told why', (m.T.W._saves || []).length === before && m.T.W.toasts.some((t) => /company set this home/.test(t.msg)), J(m.T.W.toasts));
    ok('…and the live region never says "Counting"', live && !/Counting/.test(text(live)), live && text(live));
  }

  console.log('\n8. hygiene');
  {
    const code = noComments(KPI_JS);
    ok('kpi.js escapes every value (no raw concatenation)', /function esc\(/.test(code) && !/' \+ (?!esc\(|String\(|\(|'|\w+Html \+|\w+Html\(|PICK|h\b|out\b)[a-zA-Z_.]+(?:\[[^\]]+\])? \+ '/.test(code), (code.match(/' \+ (?!esc\(|String\(|\(|')[a-zA-Z_.]+ \+ '/g) || []).slice(0, 4).join(' | '));
    ok('no Firestore, fetch, timers or listeners of its own', !/\b(getDoc|getDocs|onSnapshot|collection|fetch|setInterval|import\s*\()\b/.test(code));
    ok('no style attributes, no inline handlers, no el.style', !/style\s*=|\son[a-z]+\s*=|\.style\./.test(code + noComments(read('docs/pro/js/os/kpi-logic.js'))));
    ok('kpi.css: no text under 11px, no motion, tokens only', !/font-size:\s*(?:[0-9]|10)px/.test(KPI_CSS) && !/transition|animation/.test(KPI_CSS) && !/#[0-9a-f]{3,6}\b/i.test(KPI_CSS));
    ok('home.js registers oskpi with same-origin js/os + css/os files only', /var KPI_BUNDLE = \['css\/os\/kpi\.css\?v=1', 'js\/os\/kpi-logic\.js\?v=1', 'js\/os\/kpi\.js\?v=1'\];/.test(HOME_JS));
    const mc = noComments(MAPS_SRC);
    ok('maps-customers.js exposes openCustomersView (the tap\'s landing) and maps-core.js bumped its ?v=', /window\.openCustomersView\s*=\s*openCustomersView/.test(mc) && /maps-customers\.js\?v=14/.test(read('docs/pro/js/maps-core.js')));
  }

  console.log('\n9. openCustomersView on the map (vm-loaded maps-customers.js)');
  {
    const applied = [], toggles = [];
    const tog = { id: 'tog-customers' };
    const panelSel = { value: '' };
    const win = { _companyProfile: { mapViews: VIEWS }, _leads: [], toggleOverlay: (t, el) => { toggles.push([t, el === tog]); sandbox.overlayState.customers = true; } };
    const timers = [];
    const sandbox = {
      window: win, document: { getElementById: (id) => (id === 'tog-customers' ? tog : null), createElement() { return { style: {} }; }, head: { appendChild() {} } },
      navigator: {}, mainMap: null, L: {}, overlayState: { customers: false }, setTimeout: (fn) => { timers.push(fn); return timers.length; }, console: { log() {}, warn() {}, error() {} },
    };
    vm.createContext(sandbox);
    vm.runInContext(MAPS_SRC + '\n;this.__setPanel = function (p) { _custPanelEl = p; };', sandbox, { filename: 'maps-customers.js' });
    sandbox.buildCustomersLayer = function () { applied.push(JSON.stringify(sandbox.__state ? 1 : 0)); };
    sandbox.window.openCustomersView(VIEWS[1].name);
    ok('the map not built yet: it waits (a bounded retry), nothing applied', timers.length === 1 && applied.length === 0 && toggles.length === 0);
    sandbox.mainMap = {};
    sandbox.__setPanel({ querySelector: (s) => (s === '[data-cust-view]' ? panelSel : null) });
    timers.shift()();
    ok('then: the Customers layer on (its own toggle), the view applied, the View list showing it', J(toggles) === J([['customers', true]]) && applied.length === 1 && panelSel.value === '1', J([toggles, applied, panelSel]));
    sandbox.window.openCustomersView('No such view');
    ok('a name no view has does nothing', applied.length === 1 && toggles.length === 1);
    sandbox.mainMap = null;
    const t0 = timers.length;
    sandbox.window.openCustomersView(VIEWS[0].name, 40);
    ok('it stops waiting after 40 tries', timers.length === t0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
