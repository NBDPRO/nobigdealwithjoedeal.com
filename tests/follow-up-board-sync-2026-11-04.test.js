/**
 * tests/follow-up-board-sync-2026-11-04.test.js
 *
 * Regression: the Follow-up board's header button (#followUpBoardBtn) never showed after a
 * normal page load. The button lives in the lazily-mounted CRM view template, so the module's
 * first syncButton() (a 2.2s timer after DOMContentLoaded) ran before the button existed
 * and/or before the flags and leads had arrived, and nothing re-ran it when the Pipeline
 * view mounted, when flags finished loading, or when leads loaded.
 *
 * Pins, in the real follow-up-board.js run in a vm sandbox whose button is mounted LATE:
 *   1. old behaviour reproduced: the first sync (no button) leaves nothing to show;
 *   2. 'nbd:view-entered' {name:'crm'} (button now mounted, flag on, leads loaded) un-hides it
 *      with the right badge;
 *   3. 'nbd:flags-loaded' un-hides it when only the flags were late;
 *   4. 'nbd:data-refreshed' (leads arriving late) updates the badge;
 *   5. other views entering do nothing; flag off / viewer role stay hidden (dark by default);
 *   6. wiring: dashboard-actions.js dispatches nbd:view-entered from the crm branch, and
 *      nothing here polls or adds inline script.
 * Synthetic data only (ZZ_QA). Run: node tests/follow-up-board-sync-2026-11-04.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const F = require(path.join(ROOT, 'docs/pro/js/follow-up-board-logic.js'));
const EB = require(path.join(ROOT, 'docs/pro/js/estimate-follow-board.js'));
const EF = require(path.join(ROOT, 'docs/pro/js/estimate-followups.js'));

const H = 3600000;
const NOW = Date.UTC(2026, 10, 4, 15);
const lead = (id, hoursAgo) => ({ id, firstName: 'ZZ_QA', lastName: id, phone: '5135550100', stage: 'contacted', lastInboundAt: NOW - hoursAgo * H });

const SRC = read('docs/pro/js/follow-up-board.js');

// Boot the real module. The button is NOT in the DOM until mountButton() is called; the flag and
// leads can be flipped later, like a real load.
function boot(opts) {
  opts = opts || {};
  const handlers = {};      // document listeners
  const winHandlers = {};   // window listeners
  const btn = { id: 'followUpBoardBtn', hidden: true, getAttribute() { return null; } };
  btn.closest = () => btn;
  const badge = { id: 'followUpBoardBadge', hidden: true, textContent: '0' };
  const state = { mounted: false, flag: !!opts.flag };
  const document = {
    readyState: 'complete', body: { appendChild() {}, removeChild() {} },
    getElementById: (id) => (!state.mounted ? null : id === 'followUpBoardBtn' ? btn : id === 'followUpBoardBadge' ? badge : null),
    createElement() { return { className: '', innerHTML: '', setAttribute() {}, querySelector() { return null; } }; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
    activeElement: null,
  };
  const win = {
    document, _leads: opts.leads || [], _userClaims: opts.claims || {}, _user: { uid: 'u1' },
    NBDFlags: { enabled: (n) => state.flag && n === 'followUpBoard', load: () => Promise.resolve() },
    NBDEstimateFollowups: EF, NBDEstimateFollowBoard: { _pure: EB }, NBDFollowUpLogic: F,
    db: {}, showToast() {},
    addEventListener(t, fn) { (winHandlers[t] = winHandlers[t] || []).push(fn); },
  };
  win.window = win;
  const timers = [];
  const ctx = { window: win, document, setTimeout: (fn) => { timers.push(fn); return 0; }, setInterval: () => 0, console, Date, Promise, Math, JSON, String, Object, Array, Number, CustomEvent: function () {} };
  vm.runInNewContext(SRC, ctx, { filename: 'follow-up-board.js' });
  return {
    win, btn, badge, state,
    runInitTimer: () => timers.splice(0).forEach((fn) => fn()),
    emit: (type, detail) => (winHandlers[type] || []).forEach((fn) => fn({ type, detail })),
  };
}

const realNow = Date.now;
Date.now = () => NOW;
(async () => {
  try {
    console.log('1. late-mounted button, late flags, late leads (the live bug)');
    {
      const e = boot({ flag: false, leads: [] });
      e.runInitTimer(); // first sync: no button in the DOM, flag not loaded, no leads
      ok('first sync with no button mounted leaves the button hidden (nothing to find)', e.btn.hidden === true);
      e.state.mounted = true;
      e.win.NBDFollowUpBoard.sync();
      ok('control: mounted but flag still off -> stays hidden', e.btn.hidden === true);

      e.state.flag = true;
      e.win._leads = [lead('ZZ_A', 5), lead('ZZ_B', 9)];
      e.emit('nbd:view-entered', { name: 'crm' });
      ok('Pipeline view mounts (flag on, leads loaded) -> button un-hides without a manual sync()', e.btn.hidden === false, 'hidden=' + e.btn.hidden);
      ok('...with the correct badge', e.badge.textContent === '2' && e.badge.hidden === false, 'badge=' + e.badge.textContent);
    }

    console.log('2. flags finish loading after the view is mounted');
    {
      const e = boot({ flag: false, leads: [lead('ZZ_A', 5)] });
      e.state.mounted = true;
      e.runInitTimer();
      ok('flag still loading -> hidden', e.btn.hidden === true);
      e.state.flag = true;
      e.emit('nbd:flags-loaded');
      ok('nbd:flags-loaded un-hides it', e.btn.hidden === false && e.badge.textContent === '1', 'hidden=' + e.btn.hidden + ' badge=' + e.badge.textContent);
    }

    console.log('3. leads load or change after the button is up');
    {
      const e = boot({ flag: true, leads: [] });
      e.state.mounted = true;
      e.runInitTimer();
      ok('flag on, no leads yet -> badge 0 and hidden badge', e.badge.textContent === '0' && e.badge.hidden === true);
      e.win._leads = [lead('ZZ_A', 5), lead('ZZ_B', 6), lead('ZZ_C', 7)];
      e.emit('nbd:data-refreshed', { source: 'leads' });
      ok('nbd:data-refreshed (leads) updates the badge', e.badge.textContent === '3' && e.badge.hidden === false, 'badge=' + e.badge.textContent);
    }

    console.log('4. stays dark / does not over-fire');
    {
      const e = boot({ flag: true, leads: [lead('ZZ_A', 5)] });
      e.state.mounted = true;
      e.emit('nbd:view-entered', { name: 'home' });
      ok('another view entering does not sync', e.btn.hidden === true);
      e.emit('nbd:view-entered', {});
      e.emit('nbd:view-entered');
      ok('a view-entered event with no detail is harmless', e.btn.hidden === true);

      const off = boot({ flag: false, leads: [lead('ZZ_A', 5)] });
      off.state.mounted = true;
      off.emit('nbd:view-entered', { name: 'crm' }); off.emit('nbd:flags-loaded');
      ok('flag off: view mount + flags-loaded keep the button hidden (dark for everyone)', off.btn.hidden === true);

      const viewer = boot({ flag: true, claims: { role: 'viewer' }, leads: [lead('ZZ_A', 5)] });
      viewer.state.mounted = true;
      viewer.emit('nbd:view-entered', { name: 'crm' });
      ok('flag on but viewer role: still hidden', viewer.btn.hidden === true);
    }
  } finally { Date.now = realNow; }

  console.log('5. wiring');
  {
    const act = read('docs/pro/js/dashboard-actions.js');
    const i = act.indexOf("if(name==='crm')");
    const j = act.indexOf("if(name==='storm')", i);
    const block = i >= 0 && j > i ? act.slice(i, j) : '';
    ok("goTo's crm branch dispatches nbd:view-entered {name:'crm'}", /nbd:view-entered['"],\s*\{\s*detail:\s*\{\s*name:\s*'crm'/.test(block));
    ok('the board listens for both events', /addEventListener\('nbd:flags-loaded'/.test(SRC) && /addEventListener\('nbd:view-entered'/.test(SRC));
    ok('flag default untouched: no followUpBoard: true in the board module', !/followUpBoard['"]?\s*:\s*true/.test(SRC));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
