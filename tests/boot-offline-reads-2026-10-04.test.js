/**
 * tests/boot-offline-reads-2026-10-04.test.js — two boot reads that turned a
 * passing "client is offline" moment into a permanent wrong state, and the
 * E2E wait helper that hid it (2026-10-04, the @shard2 deflake).
 *
 * The Firestore client goes Offline after one failed watch stream or 10 s
 * without one (OnlineStateTracker), which a cold boot on a busy emulator — or
 * a phone on a bad signal — hits. While Offline, with the memory cache:
 *   - getDoc REJECTS ("Failed to get document because the client is offline");
 *   - an onSnapshot listener gets a from-cache snapshot, and when the server
 *     answer then matches that view (no doc, or no change) only the sync state
 *     changes — which is NOT delivered unless includeMetadataChanges is set.
 *
 *   1. game-card.js: a rejected settings read set { enabled: false } for the
 *      page's life — game mode on, card never shown (phone-game-card.spec.js
 *      :105 waited on settings.enabled until the 150 s test timeout, three CI
 *      runs in a row). Now a transient failure / empty cached read is retried,
 *      and a choice the user makes meanwhile is never overwritten.
 *   2. my-skin.js: the listener skipped the from-cache snapshot and waited for
 *      a server copy that never came for a user with no userSettings doc —
 *      cfg stayed null (my-skin.spec.js:35, 150 s). Now it listens with
 *      includeMetadataChanges, so the in-sync transition lands.
 *   3. tests/e2e/fixtures/auth.js safeWaitForFunction read only (page, fn,
 *      opts); 31 callers pass page.waitForFunction's (page, fn, arg, opts), so
 *      their timeout was dropped and every wait ran to the test timeout.
 *
 * The Firestore SDK is modelled, not loaded: getDoc / onSnapshot stubs that
 * follow the SDK's raise rules (QueryListener.shouldRaiseEvent) for exactly
 * these cases.
 *
 * Run: node tests/boot-offline-reads-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// A window/document just big enough for the two modules' boot paths.
function sandbox(extra) {
  const el = () => ({ hidden: false, innerHTML: '', style: { setProperty() {}, removeProperty() {} }, classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, hasAttribute() { return false; }, appendChild() {}, remove() {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  const html = el(); html.classList = Object.assign([], { add() {}, remove() {}, contains() { return false; } });
  const document = {
    readyState: 'complete', body: el(), documentElement: html, activeElement: null,
    addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }, createElement: el,
  };
  // Fast timers: the modules' 250 ms–1.5 s backoffs run at 1/50 speed.
  const fastTimeout = (fn, ms) => setTimeout(fn, Math.max(0, Math.ceil((ms || 0) / 50)));
  const win = Object.assign({
    document, setTimeout: fastTimeout, clearTimeout, console, Promise, Date, JSON, Math, Object, Array, String, Number, Error, RegExp,
    MutationObserver: function () { this.observe = () => {}; },
    sessionStorage: { getItem() { return null; }, setItem() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    _user: { uid: 'u1', displayName: 'Jo Test' }, db: {}, storage: {},
    doc: (db, col, id) => ({ path: col + '/' + id }),
  }, extra || {});
  win.window = win; win.self = win;
  return vm.createContext(win);
}
function load(ctx, rel) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel });
}
const offline = () => Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
const snapOf = (data, fromCache) => ({ exists: () => !!data, data: () => data, metadata: { fromCache: !!fromCache, hasPendingWrites: false } });

(async () => {
  // ── 1. game-card.js ───────────────────────────────────────────────────
  console.log('\n1. game-card.js: a cold-boot offline read is retried, not taken as "off"');
  {
    let calls = 0;
    const ctx = sandbox({
      getDoc: async () => { calls++; if (calls === 1) throw offline(); return snapOf({ game: { enabled: true, avatar: { tool: 'ladder' } } }); },
      setDoc: async () => {},
    });
    load(ctx, 'docs/pro/js/game-card.js');
    for (let i = 0; i < 100 && !(ctx.NBDGameCard._state.settings && ctx.NBDGameCard._state.settings.enabled); i++) await tick(10);
    const s = ctx.NBDGameCard._state.settings;
    ok('game mode saved ON comes back ON after one "client is offline" read', !!(s && s.enabled === true), 'settings=' + JSON.stringify(s) + ' reads=' + calls);
    ok('…and was read again (not cached as off)', calls >= 2, 'reads=' + calls);
  }
  {
    // An empty answer from the cache while connecting is not "no settings".
    let calls = 0;
    const ctx = sandbox({
      getDoc: async () => { calls++; return calls === 1 ? snapOf(null, true) : snapOf({ game: { enabled: true } }); },
      setDoc: async () => {},
    });
    load(ctx, 'docs/pro/js/game-card.js');
    for (let i = 0; i < 100 && !(ctx.NBDGameCard._state.settings && ctx.NBDGameCard._state.settings.enabled); i++) await tick(10);
    ok('an empty from-cache read is retried until the server answers', !!(ctx.NBDGameCard._state.settings || {}).enabled, 'reads=' + calls);
  }
  {
    // A real "no settings" answer from the server is final: off, one read.
    let calls = 0;
    const ctx = sandbox({ getDoc: async () => { calls++; return snapOf(null, false); }, setDoc: async () => {} });
    load(ctx, 'docs/pro/js/game-card.js');
    for (let i = 0; i < 100 && !ctx.NBDGameCard._state.settings; i++) await tick(10);
    await tick(80);
    ok('no settings doc on the server → off, read once', JSON.stringify(ctx.NBDGameCard._state.settings) === '{"enabled":false}' && calls === 1, 'settings=' + JSON.stringify(ctx.NBDGameCard._state.settings) + ' reads=' + calls);
  }
  {
    // A permission error is not transient: off at once, no retry loop.
    let calls = 0;
    const ctx = sandbox({ getDoc: async () => { calls++; throw Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' }); }, setDoc: async () => {} });
    load(ctx, 'docs/pro/js/game-card.js');
    for (let i = 0; i < 100 && !ctx.NBDGameCard._state.settings; i++) await tick(10);
    await tick(80);
    ok('a permission error falls back to off without retrying', JSON.stringify(ctx.NBDGameCard._state.settings) === '{"enabled":false}' && calls === 1, 'reads=' + calls);
  }
  {
    // Still offline for good: it gives up (off) instead of retrying forever.
    let calls = 0;
    const ctx = sandbox({ getDoc: async () => { calls++; throw offline(); }, setDoc: async () => {} });
    load(ctx, 'docs/pro/js/game-card.js');
    for (let i = 0; i < 400 && !ctx.NBDGameCard._state.settings; i++) await tick(10);
    const n = calls; await tick(200);
    ok('offline for good: settles on off after a bounded number of reads', JSON.stringify(ctx.NBDGameCard._state.settings) === '{"enabled":false}' && n >= 2 && n <= 8 && calls === n, 'reads=' + calls);
  }

  // ── 2. my-skin.js ─────────────────────────────────────────────────────
  console.log('\n2. my-skin.js: the in-sync snapshot after an offline one is heard');
  // The SDK's raise rules for one doc listener: while Offline the first,
  // from-cache snapshot is raised; when the server's answer equals that view,
  // only the sync state changes — raised only with includeMetadataChanges.
  function snapshotModel(serverData) {
    const seen = { opts: null };
    const onSnapshot = function (ref, a, b, c) {
      const opts = (a && typeof a === 'object' && typeof a !== 'function') ? a : {};
      const next = typeof a === 'function' ? a : b;
      seen.opts = opts;
      setTimeout(() => next(snapOf(null, true)), 1);                    // offline: empty cache
      setTimeout(() => {
        const changed = !!serverData;                                    // a doc appeared → doc change
        if (changed || opts.includeMetadataChanges === true) next(snapOf(serverData, false));
      }, 5);
      return () => {};
    };
    return { onSnapshot, seen };
  }
  {
    const m = snapshotModel(null);   // a user with no userSettings doc yet
    const ctx = sandbox({ onSnapshot: m.onSnapshot, getDoc: async () => snapOf(null, false), setDoc: async () => {} });
    load(ctx, 'docs/pro/js/my-skin-logic.js');
    load(ctx, 'docs/pro/js/my-skin.js');
    for (let i = 0; i < 200 && !ctx.NBDMySkin.state().cfg; i++) await tick(10);
    ok('no settings doc + an offline first snapshot: the config still loads', !!ctx.NBDMySkin.state().cfg, 'cfg=' + JSON.stringify(ctx.NBDMySkin.state().cfg) + ' opts=' + JSON.stringify(m.seen.opts));
    ok('the listener asks for metadata changes', !!(m.seen.opts && m.seen.opts.includeMetadataChanges === true), JSON.stringify(m.seen.opts));
  }
  {
    const m = snapshotModel({ mySkin: { enabled: true, side: 'left' } });
    const ctx = sandbox({ onSnapshot: m.onSnapshot, getDoc: async () => snapOf(null, false), setDoc: async () => {} });
    load(ctx, 'docs/pro/js/my-skin-logic.js');
    load(ctx, 'docs/pro/js/my-skin.js');
    for (let i = 0; i < 200 && !ctx.NBDMySkin.state().cfg; i++) await tick(10);
    const cfg = ctx.NBDMySkin.state().cfg;
    ok('a saved skin still arrives from the server copy', !!(cfg && cfg.enabled === true), JSON.stringify(cfg));
  }

  // ── 3. safeWaitForFunction argument shapes ────────────────────────────
  console.log('\n3. tests/e2e/fixtures/auth.js: safeWaitForFunction honours both call shapes');
  {
    const calls = [];
    const page = { waitForFunction: async (fn, arg, opts) => { calls.push({ arg, opts }); return true; }, waitForLoadState: async () => {}, waitForTimeout: async () => {} };
    let auth;
    try { auth = require('./e2e/fixtures/auth.js'); } catch (e) { auth = null; console.log('  (fixtures/auth.js not loadable here: ' + e.message + ')'); }
    if (auth) {
      const fn = () => true;
      await auth.safeWaitForFunction(page, fn, null, { timeout: 30000 });
      await auth.safeWaitForFunction(page, fn, { timeout: 20000 });
      await auth.safeWaitForFunction(page, fn, { timeout: 10000 }, ['a', 'b']);
      await auth.safeWaitForFunction(page, fn, 'x', { timeout: 5000, polling: 100 });
      await auth.safeWaitForFunction(page, fn);
      ok('(page, fn, null, { timeout }) keeps the timeout', calls[0].opts && calls[0].opts.timeout === 30000 && calls[0].arg === null, JSON.stringify(calls[0]));
      ok('(page, fn, { timeout }) keeps the timeout', calls[1].opts.timeout === 20000 && calls[1].arg === null, JSON.stringify(calls[1]));
      ok('(page, fn, { timeout }, arg) passes the arg', calls[2].opts.timeout === 10000 && JSON.stringify(calls[2].arg) === '["a","b"]', JSON.stringify(calls[2]));
      ok('(page, fn, arg, { timeout, polling }) passes both', calls[3].arg === 'x' && calls[3].opts.timeout === 5000 && calls[3].opts.polling === 100, JSON.stringify(calls[3]));
      ok('(page, fn) waits with defaults', calls[4].arg === null && JSON.stringify(calls[4].opts) === '{}', JSON.stringify(calls[4]));
    } else ok('fixtures/auth.js loads', false);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
