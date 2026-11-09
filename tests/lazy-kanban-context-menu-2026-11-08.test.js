/**
 * tests/lazy-kanban-context-menu-2026-11-08.test.js — the kanban card menu
 * (kanban-context-menu.js: right-click / long-press / the card's ⋮, and the
 * stage / classification chip pickers) loads on first use, not on every
 * dashboard boot (boot-weight lane, 2026-11-08).
 *
 * Before: an eager <script defer> on every boot (26 KB readable), though its
 * listeners only act on a .k-card and the only .k-cards are the Pipeline
 * board's. After: a ScriptLoader bundle `kanbanctx`, registered at runtime by
 * dashboard-actions.js (script-loader.js is blocking and at its byte ceiling),
 * loaded when goTo('crm') reports the board painted (nbd:view-entered), and a
 * load-then-run stub for window.KanbanContextMenu so the ⋮ and the chips in the
 * card-detail modal / mobile job detail (reachable from Home without the
 * Pipeline) still open their menu on a cold first tap. Pins:
 *   - dashboard.html has no eager tag; portal-link-helpers.js stays eager;
 *   - the block in dashboard-actions.js, run in a vm on the REAL script-loader.js,
 *     registers exactly that bundle, fetches nothing at boot, and fetches the
 *     file once when the Pipeline is entered (never for another view);
 *   - the REAL callers (cdPickStage / cdPickType from dashboard-actions.js, the
 *     ⋮ handler from crm-pipeline.js) open the REAL menu after a cold load, at
 *     the anchor measured at tap time; afterwards they open it at once;
 *   - a failed fetch opens nothing, throws nothing, says so, and the next tap
 *     fetches again (the fake <head> keeps and lists its tags, as a browser
 *     does, so this holds only because ScriptLoader drops the dead tag);
 *     no ScriptLoader = nothing happens; a page that already has the real menu
 *     keeps it untouched.
 *
 * Zero deps. Run: node tests/lazy-kanban-context-menu-2026-11-08.test.js
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

const DASH = read('docs/pro/dashboard.html');
const ACTIONS = read('docs/pro/js/dashboard-actions.js');
const PIPELINE = read('docs/pro/js/crm-pipeline.js');
const KCM = read('docs/pro/js/kanban-context-menu.js');
const LOADER = read('docs/pro/js/script-loader.js');

// Slice `head … }` verbatim, brace-matched from head's own '{' (none of these bodies has a brace in a string or comment).
function sliceBlock(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return null;
  let i = at + head.length - 1, depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const BLOCK = sliceBlock(ACTIONS, "if (typeof window.KanbanContextMenu === 'undefined') {");
const PICK_STAGE = sliceBlock(ACTIONS, '  function cdPickStage(el) {');
const PICK_TYPE = sliceBlock(ACTIONS, '  function cdPickType(el) {');
const OVERFLOW = sliceBlock(PIPELINE, "'card-overflow':(el, ev)  => {");
const flush = () => new Promise((r) => setImmediate(r));
const base = (s) => String(s).split('?')[0];

// ── a dashboard-shaped window: fake DOM, the REAL script-loader.js, the block ─
function makeEnv(opts) {
  opts = opts || {};
  const winL = {}, docL = {};
  const mk = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, attrs: {}, children: [], innerHTML: '', parentNode: null, id: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { if (this.attrs[k] != null) return this.attrs[k]; return k === 'src' && this.src != null ? this.src : null; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
    addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    getBoundingClientRect: () => ({ width: 200, height: 300, left: 0, top: 0, right: 200, bottom: 300 }),
    contains: () => false, focus() {},
  });
  const headEl = mk('head'), bodyEl = mk('body');
  // Every <script> the page asks the network for, and the toasts shown.
  const fetched = [], toasts = [];
  const headAppend = headEl.appendChild;
  headEl.appendChild = function (c) { if (c && c.tagName === 'SCRIPT') fetched.push(c.src); return headAppend.call(this, c); };
  const document = {
    readyState: 'complete', baseURI: 'https://x.test/pro/dashboard.html', head: headEl, body: bodyEl,
    addEventListener(t, fn) { (docL[t] = docL[t] || []).push(fn); },
    removeEventListener(t, fn) { const l = docL[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); },
    getElementById: (id) => bodyEl.children.find((c) => c.id === id) || null,
    // A browser lists every <script> in <head>, a failed one too, and
    // ScriptLoader's eager-tag scan reads that list.
    querySelector: () => null, createElement: mk,
    querySelectorAll: (sel) => (String(sel).indexOf('script') === 0 ? headEl.children.filter((c) => c.tagName === 'SCRIPT') : []),
  };
  const win = {
    document, innerWidth: 390, innerHeight: 844,
    _leads: [{ id: 'lead-1', firstName: 'Test', lastName: 'Homeowner', stage: 'new', jobType: 'insurance' }],
    stageOptionsForType: () => [{ value: 'new', label: 'New' }, { value: 'lost', label: 'Lost' }],
    JOB_TYPE_META: { insurance: { label: 'Insurance', icon: 'I' }, cash: { label: 'Cash', icon: 'C' } },
    normalizeStage: (s) => s,
    addEventListener(t, fn) { (winL[t] = winL[t] || []).push(fn); },
    removeEventListener() {},
  };
  const ctx = { window: win, document, navigator: { userAgent: 'test' }, console: { log() {}, warn() {}, error() {}, info() {} },
    setTimeout, clearTimeout, URL, showToast: (m, k) => toasts.push([String(m), k]) };
  vm.createContext(ctx);
  if (opts.loader !== false) vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
  const bundlesBefore = win.ScriptLoader ? Object.keys(win.ScriptLoader.bundles) : [];
  if (opts.kcmFirst) vm.runInContext(KCM, ctx, { filename: 'kanban-context-menu.js' });
  let threw = null;
  if (BLOCK) { try { vm.runInContext(BLOCK, ctx, { filename: 'dashboard-actions.js (kanbanctx block)' }); } catch (e) { threw = e; } }
  // The real callers, verbatim, bound into this window.
  if (PICK_STAGE && PICK_TYPE && OVERFLOW) {
    vm.runInContext(PICK_STAGE + '\n' + PICK_TYPE + '\nglobalThis.__pickStage = cdPickStage; globalThis.__pickType = cdPickType;\n'
      + 'globalThis.__overflow = ' + OVERFLOW.replace(/^'card-overflow':/, '') + ';', ctx);
  }
  return {
    ctx, win, document, winL, docL, headEl, bodyEl, bundlesBefore, threw, fetched, toasts,
    scripts: () => headEl.children.filter((c) => c.tagName === 'SCRIPT'),
    menus: () => bodyEl.children.filter((c) => c.id === 'nbd-kanban-ctx-menu'),
    // The browser's half of a fetch: run the file, then fire onload; or fire onerror (offline, 404).
    arrive(el, good) { if (!el) return; if (good) vm.runInContext(KCM, ctx, { filename: 'kanban-context-menu.js' }); (good ? el.onload : el.onerror)(); },
    dispatch(type, detail) { (winL[type] || []).forEach((fn) => fn({ type, detail })); },
  };
}
const chipEl = { getBoundingClientRect: () => ({ left: 40, top: 100, right: 140, bottom: 120, width: 100, height: 20 }) };
const overflowEl = { dataset: { id: 'lead-1' }, getBoundingClientRect: () => ({ left: 280, top: 180, right: 300, bottom: 200 }),
  closest: () => ({ dataset: {} }) };

(async function main() {
  console.log('\nKANBAN MENU: dashboard.html');
  {
    ok('no eager <script> tag for kanban-context-menu.js any more', !/<script[^>]*src="js\/kanban-context-menu\.js/.test(DASH));
    ok('portal-link-helpers.js (the menu\'s portal-link items) is still an eager deferred tag', /<script defer src="js\/portal-link-helpers\.js\?v=\d+"><\/script>/.test(DASH));
    const sl = DASH.indexOf('<script src="js/script-loader.js'), da = DASH.indexOf('<script defer src="js/dashboard-actions.js');
    ok('dashboard-actions.js (which registers the bundle) is deferred and after the blocking script-loader.js', sl > 0 && da > sl, sl + ' / ' + da);
    ok('the four chip hooks are unchanged (cdPickStage / cdPickType on #mJobDetail and #cardDetailModal)',
      (DASH.match(/data-fn="cdPickStage"/g) || []).length === 2 && (DASH.match(/data-fn="cdPickType"/g) || []).length === 2);
    ok('goTo still announces the painted Pipeline (nbd:view-entered {name:\'crm\'}), the load trigger',
      /dispatchEvent\(new CustomEvent\('nbd:view-entered', \{ detail: \{ name: 'crm' \} \}\)\)/.test(ACTIONS));
    ok('the real callers are found (cdPickStage, cdPickType, the ⋮ card-overflow handler)', !!(PICK_STAGE && PICK_TYPE && OVERFLOW));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-kanban-context-menu-2026-11-08.test.js"') >= 0);
  }

  console.log('\nKANBAN MENU: the bundle on the real script-loader.js');
  ok('dashboard-actions.js carries the kanbanctx block', !!BLOCK);
  if (!BLOCK) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
  {
    ok('control: script-loader.js itself does not carry the bundle (blocking, at its byte ceiling)', !/kanbanctx/.test(LOADER));
    const e = makeEnv();
    ok('the block runs without throwing', !e.threw, e.threw && e.threw.message);
    const B = e.win.ScriptLoader.bundles;
    ok('it registers exactly one bundle, kanbanctx', Object.keys(B).length === e.bundlesBefore.length + 1 && !!B.kanbanctx, Object.keys(B).length);
    ok('kanbanctx is just kanban-context-menu.js, with a cache-buster', Array.isArray(B.kanbanctx) && B.kanbanctx.length === 1
      && base(B.kanbanctx[0]) === 'js/kanban-context-menu.js' && /\?v=\d+$/.test(B.kanbanctx[0]), B.kanbanctx);
    ok('portal-link-helpers.js is NOT in it (the deploy joins eager tags, so the loader would run it a second time)',
      (B.kanbanctx || []).every((s) => !/portal-link-helpers/.test(s)));
  }

  console.log('\nKANBAN MENU: boot and the Pipeline');
  {
    const e = makeEnv();
    ok('at boot nothing is fetched or preloaded', e.headEl.children.length === 0, e.headEl.children.map((c) => c.tagName));
    ok('at boot the menu\'s document listeners are not armed (the real file has not run)', !e.docL.contextmenu && !e.docL.touchstart);
    const k = e.win.KanbanContextMenu;
    ok('window.KanbanContextMenu is a stand-in with open / openStagePicker / openTypePicker / close, so the callers\' guards pass',
      !!k && ['open', 'openStagePicker', 'openTypePicker', 'close'].every((m) => typeof k[m] === 'function') && k.__sentinel !== 'nbd-kanban-ctx-v1');
    e.dispatch('nbd:view-entered', { name: 'home' });
    e.dispatch('nbd:view-entered', { name: 'settings' });
    await flush();
    ok('entering another view fetches nothing', e.scripts().length === 0, e.scripts().length);
    e.dispatch('nbd:view-entered', { name: 'crm' });
    await flush();
    ok('entering the Pipeline fetches kanban-context-menu.js', e.scripts().length === 1 && base(e.scripts()[0].src) === 'js/kanban-context-menu.js', e.scripts().map((s) => s.src));
    e.dispatch('nbd:view-entered', { name: 'crm' });
    await flush();
    ok('a second entry while it is on its way does not fetch it again', e.scripts().length === 1, e.scripts().length);
    e.arrive(e.scripts()[0], true);
    await flush(); await flush();
    ok('once it lands, right-click and long-press are armed on the board', (e.docL.contextmenu || []).length === 1 && (e.docL.touchstart || []).length === 1);
    ok('…and the real menu replaced the stand-in', e.win.KanbanContextMenu.__sentinel === 'nbd-kanban-ctx-v1');
    const card = { getAttribute: (a) => (a === 'data-id' ? 'lead-1' : null) };
    card.closest = () => card;
    const ev = { target: card, clientX: 12, clientY: 34, prevented: false, preventDefault() { this.prevented = true; } };
    e.docL.contextmenu.forEach((fn) => fn(ev));
    ok('a right-click on a card opens the menu, naming the lead', ev.prevented && e.menus().length === 1 && /Test Homeowner/.test(e.menus()[0].innerHTML));
    e.win.KanbanContextMenu.close();
    e.dispatch('nbd:view-entered', { name: 'crm' });
    await flush();
    ok('coming back to the Pipeline later fetches nothing', e.scripts().length === 1, e.scripts().length);
  }

  console.log('\nKANBAN MENU: the chips and the ⋮ from a cold start (Home, no Pipeline yet)');
  {
    const e = makeEnv();
    e.win._cardDetailLeadId = 'lead-1';
    e.ctx.__pickStage(chipEl);
    ok('a stage-chip tap opens nothing synchronously (the file is not here yet)', e.menus().length === 0);
    await flush();
    ok('…and fetches the menu file once', e.scripts().length === 1 && base(e.scripts()[0].src) === 'js/kanban-context-menu.js', e.scripts().length);
    e.arrive(e.scripts()[0], true);
    await flush(); await flush();
    const m = e.menus()[0];
    ok('when it lands, the stage picker opens for that lead', !!m && m.attrs['aria-label'] === 'Move to stage' && /Lost/.test(m.innerHTML), m && m.attrs['aria-label']);
    ok('…at the chip as measured at tap time (left, bottom + 4)', !!m && m.style.left === '40px' && m.style.top === '124px', m && (m.style.left + ',' + m.style.top));
    e.ctx.__pickType(chipEl);
    const m2 = e.menus()[0];
    ok('afterwards the classification chip opens its picker at once', e.menus().length === 1 && m2.attrs['aria-label'] === 'Change classification' && /Cash/.test(m2.innerHTML), m2 && m2.attrs['aria-label']);
    await flush();
    ok('…with no second fetch', e.scripts().length === 1, e.scripts().length);
  }
  {
    const e = makeEnv();
    e.ctx.__overflow(overflowEl, {});
    await flush();
    ok('a cold ⋮ tap fetches the menu file', e.scripts().length === 1, e.scripts().length);
    e.arrive(e.scripts()[0], true);
    await flush(); await flush();
    ok('…and opens the card menu for that lead when it lands', e.menus().length === 1 && /Test Homeowner/.test(e.menus()[0].innerHTML) && /View details/.test(e.menus()[0].innerHTML));
  }
  {
    const e = makeEnv();
    e.win._cardDetailLeadId = 'lead-1';
    e.ctx.__pickType(chipEl);
    await flush();
    const s1 = e.scripts()[0];
    let threw = false;
    try { e.arrive(s1, false); await flush(); await flush(); } catch (err) { threw = true; }
    ok('a failed fetch opens nothing and throws nothing', !threw && e.menus().length === 0);
    ok('…and leaves the stand-in, so the caller\'s guard still passes', !!e.win.KanbanContextMenu && typeof e.win.KanbanContextMenu.openTypePicker === 'function');
    ok('…and tells the rep to tap again', e.toasts.some((x) => /Could not load the card menu/.test(x[0]) && x[1] === 'error'), JSON.stringify(e.toasts));
    ok('…and its dead tag is gone from <head>', e.scripts().length === 0, e.scripts().length);
    e.ctx.__pickType(chipEl);
    await flush();
    ok('…so the next tap fetches the menu file again', e.fetched.length === 2 && e.scripts().length === 1, e.fetched.length + ' fetches, ' + e.scripts().length + ' tags');
    e.arrive(e.scripts()[0], true);
    await flush(); await flush();
    ok('…which opens the picker once it works', e.menus().length === 1 && e.menus()[0].attrs['aria-label'] === 'Change classification');
  }
  {
    const e = makeEnv({ loader: false });
    let threw = false;
    try { e.win._cardDetailLeadId = 'lead-1'; e.ctx.__pickStage(chipEl); e.ctx.__overflow(overflowEl, {}); e.dispatch('nbd:view-entered', { name: 'crm' }); await flush(); } catch (err) { threw = true; }
    ok('no ScriptLoader on the page: nothing opens and nothing throws', !e.threw && !threw && e.menus().length === 0);
  }
  {
    const e = makeEnv({ kcmFirst: true });
    ok('a page that already ran the real menu keeps it (no stand-in, no listener)', e.win.KanbanContextMenu.__sentinel === 'nbd-kanban-ctx-v1' && !e.winL['nbd:view-entered']);
  }
  {
    const e = makeEnv();
    vm.runInContext(BLOCK, e.ctx);
    ok('running the block twice adds one Pipeline listener', (e.winL['nbd:view-entered'] || []).length === 1, (e.winL['nbd:view-entered'] || []).length);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
