/**
 * tests/dt-f12-2026-11-08.test.js — leaving Door-to-Door stops the live team
 * listener; coming back with team mode on starts it again (CRM audit
 * 2026-11-06, DT-F12 + VW-F05, one fix).
 *
 * subscribeTeamActivity() (d2d-tracker-core-2026b.js) is an onSnapshot on the
 * newest 1000 company knocks, and every snapshot re-renders the D2D view. The
 * only teardowns were the Team toggle and pagehide, so a manager who turned
 * team mode on and went to the Pipeline kept streaming knocks into a hidden
 * view for the rest of the session. goTo() (dashboard-actions.js) now calls
 * window.D2D.leaveView() (d2d-tracker-2026b.js) for every view but D2D, and
 * initD2D() re-subscribes on entry when team mode is still on and no listener
 * is live.
 *
 * Runs the real goTo(), the real team-listener block + initD2D() from the
 * core, and the real window.D2D shim in one vm, with a counting onSnapshot.
 * Zero deps. Run: node tests/dt-f12-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const CORE = read('docs/pro/js/d2d-tracker-core-2026b.js');
const SHIM = read('docs/pro/js/d2d-tracker-2026b.js');
const ACTIONS = read('docs/pro/js/dashboard-actions.js');

function slice(src, start, endMarker) {
  const i = src.indexOf(start); if (i < 0) return '';
  const j = src.indexOf(endMarker, i); return j < 0 ? '' : src.slice(i, j);
}
function braceFn(src, head) {
  const start = src.indexOf(head); if (start < 0) return '';
  let depth = 0, i = src.indexOf('{', start + head.length - 1);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return '';
}
const TEAM_BLOCK = slice(CORE, '  const TEAM_LIVE_KNOCK_LIMIT = ', '  function getTeamActivity()');
const INIT = braceFn(CORE, '  async function initD2D() {');
const GOTO = braceFn(ACTIONS, 'function goTo(name, params = {}) {');
ok('control: the team listener block, initD2D() and goTo() are found',
  /function subscribeTeamActivity\(\)/.test(TEAM_BLOCK) && /function unsubscribeTeamActivity\(\)/.test(TEAM_BLOCK)
  && /state\.d2dInited/.test(INIT) && /window\.D2D\.init\(\)/.test(GOTO),
  TEAM_BLOCK.length + ' / ' + INIT.length + ' / ' + GOTO.length);

function rig() {
  const counts = { listen: 0, unsub: 0, render: 0, oneShot: 0 };
  const els = {};
  const el = (id) => (els[id] || (els[id] = { id, classList: { add() {}, remove() {} }, children: [], innerHTML: '', textContent: '' }));
  const win = {
    _db: {},
    _user: { uid: 'mgr' },
    location: { hash: '' },
    L: { markerClusterGroup: () => ({}) },
    collection: (_db, name) => name,
    where: (f, op, v) => ({ f, op, v }),
    orderBy: () => ({}),
    limit: (n) => ({ n }),
    query: (...a) => a,
    onSnapshot: (q, next) => { counts.listen++; win._next = next; return () => { counts.unsub++; }; },
    dispatchEvent() {},
  };
  const state = win._D2DState = {
    currentRep: { userId: 'mgr', role: 'manager', companyId: 'co-a' },
    teamMode: false,
    d2dInited: true,
    d2dInitializing: false,
    knocks: [],
    renderD2D: () => { counts.render++; },
    loadKnocks: () => Promise.resolve(),
  };
  const sb = {
    window: win,
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => (/^view-/.test(id) ? el(id) : null),
      querySelectorAll: () => [],
    },
    localStorage: { getItem: () => '1', setItem() {} },
    CustomEvent: function CustomEvent(t, o) { this.type = t; this.detail = o && o.detail; },
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
    requestAnimationFrame() {},
    Promise,
    showToast() {},
    PRO_ONLY_VIEWS: [],
    _hydrateViewTemplate() {},
    updateBreadcrumb() {},
    loadTeamKnocks: () => { counts.oneShot++; return Promise.resolve(); },
    loadOfflineQueue() {}, loadRepProfile: async () => {}, loadKnocks: async () => {},
    initD2DMap() {}, flushOfflineQueue() {}, flushKnockPhotoQueue() {},
  };
  vm.createContext(sb);
  vm.runInContext('const state = window._D2DState;\n' + TEAM_BLOCK + INIT + '\n'
    + 'state.subscribeTeamActivity = subscribeTeamActivity;\n'
    + 'state.unsubscribeTeamActivity = unsubscribeTeamActivity;\n'
    + 'state.initD2D = initD2D;\n', sb);
  vm.runInContext(SHIM, sb);
  vm.runInContext(GOTO + '\nthis.goTo = goTo;', sb);
  return { sb, win, state, counts, goTo: sb.goTo };
}
const tick = () => new Promise((r) => setImmediate(r));

(async function main() {
  console.log('\nD2D TEAM LISTENER: stops when you leave, resumes when you return (DT-F12 / VW-F05)');
  {
    const r = rig();
    ok('control: the real window.D2D shim loaded', !!(r.win.D2D && typeof r.win.D2D.toggleTeamMode === 'function'));
    r.win.D2D.toggleTeamMode();
    ok('control: turning team mode on opens one live listener', r.counts.listen === 1 && r.state.teamMode === true, JSON.stringify(r.counts));

    r.goTo('crm');
    await tick();
    ok('leaving D2D for the Pipeline closes the live team listener', r.counts.unsub === 1, JSON.stringify(r.counts));
    ok('leaving D2D keeps team mode on (the button still reads Team on when you come back)', r.state.teamMode === true);
    r.goTo('est');
    ok('a second non-D2D hop does not try to close it again', r.counts.unsub === 1, JSON.stringify(r.counts));

    r.goTo('d2d');
    await tick();
    ok('coming back to D2D with team mode on opens the listener again', r.counts.listen === 2, JSON.stringify(r.counts));
    ok('re-entry still re-renders the view', r.counts.render >= 1, JSON.stringify(r.counts));

    r.goTo('d2d');
    await tick();
    ok('re-tapping D2D while the listener is live does not open a second one (no repeat 1000-knock read)',
      r.counts.listen === 2 && r.counts.unsub === 1, JSON.stringify(r.counts));

    r.goTo('map');
    await tick();
    ok('the retired Maps & Pins key routes to D2D and keeps the listener', r.counts.unsub === 1 && r.counts.listen === 2, JSON.stringify(r.counts));

    r.win.D2D.toggleTeamMode();
    ok('control: turning team mode off closes it', r.counts.unsub === 2 && r.state.teamMode === false, JSON.stringify(r.counts));
    r.goTo('crm');
    r.goTo('d2d');
    await tick();
    ok('team mode off: leaving and coming back opens nothing', r.counts.listen === 2 && r.counts.unsub === 2, JSON.stringify(r.counts));
  }
  {
    const r = rig();
    let threw = null;
    try { r.goTo('crm'); r.goTo('home'); } catch (e) { threw = e; }
    ok('leaving D2D when team mode was never on is a quiet no-op', !threw && r.counts.unsub === 0 && r.counts.listen === 0, threw && threw.message);
  }
  {
    const r = rig();
    delete r.win.D2D;
    let threw = null;
    try { r.goTo('crm'); } catch (e) { threw = e; }
    ok('goTo() before the lazy D2D bundle has loaded (no window.D2D) does not throw', !threw, threw && threw.message);
  }
  {
    const r = rig();
    r.win.D2D.toggleTeamMode();
    const has = typeof r.win.D2D.leaveView === 'function';
    ok('window.D2D exports leaveView()', has);
    if (has) r.win.D2D.leaveView();
    ok('window.D2D.leaveView() closes the listener and leaves team mode on', r.counts.unsub === 1 && r.state.teamMode === true, JSON.stringify(r.counts));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
