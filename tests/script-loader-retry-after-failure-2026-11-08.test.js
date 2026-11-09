/**
 * tests/script-loader-retry-after-failure-2026-11-08.test.js — a lazy bundle
 * whose fetch failed loads again the next time it is asked for.
 *
 * THE BUG: load() resolves a failed fetch (onerror, never rejects) but left the
 * dead <script> tag in <head>. The next load() of the same file scans the
 * page's script tags first (the guard against re-injecting an eager tag), found
 * the dead tag by its cache key and marked the key loaded without fetching. So
 * one dropped request (a 503, a dead spot on a roof) kept that feature off for
 * the rest of the session, for every lazy bundle: estimates, photos, docgen,
 * and the boot moves of 2026-11-08 (Ask Joe's tools, Plan Jobs, the kanban card
 * menu, My Skin, the tour). Two review agents reproduced it in Chromium with
 * the real script-loader.js and a 503.
 *
 * THE FIX: onerror removes the dead tag (el.remove?.()), so the tag scan no
 * longer finds it and the next ask fetches again.
 *
 * Runs the REAL script-loader.js in a vm against a fake <head> that KEEPS every
 * appended tag and returns it from querySelectorAll('script[src]'), the way a
 * browser does (the earlier lazy-move suites returned [] there, which hid this).
 *
 * Zero deps. Run: node tests/script-loader-retry-after-failure-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/script-loader.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}

// opts.failFirst: the first fetch of each script fails, later ones succeed.
// opts.noRemove: script elements without remove() (older test doubles).
function makeEnv(opts) {
  opts = opts || {};
  const kids = [];          // what is in <head> right now
  const fetched = [];       // every script src the page asked the network for
  const warns = [];
  const tries = {};
  const el = (tag) => {
    const e = {
      tagName: String(tag).toUpperCase(), attrs: {},
      set rel(v) { this.attrs.rel = v; }, get rel() { return this.attrs.rel; },
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return k === 'src' ? this.src : k === 'href' ? this.href : this.attrs[k]; },
    };
    if (!opts.noRemove) e.remove = function () { const i = kids.indexOf(this); if (i !== -1) kids.splice(i, 1); };
    return e;
  };
  const document = {
    baseURI: 'https://nobigdealwithjoedeal.com/pro/dashboard',
    createElement: el,
    head: {
      appendChild(e) {
        kids.push(e);
        if (e.tagName === 'SCRIPT') {
          fetched.push(e.src);
          const n = (tries[e.src] = (tries[e.src] || 0) + 1);
          setTimeout(() => { if (opts.failFirst && n === 1) e.onerror && e.onerror(); else e.onload && e.onload(); }, 0);
        } else if (e.rel === 'stylesheet') {
          setTimeout(() => e.onload && e.onload(), 0);
        }
        return e;
      },
    },
    querySelector: () => null,
    querySelectorAll: (sel) => (String(sel).startsWith('script') ? kids.filter((k) => k.tagName === 'SCRIPT')
      : String(sel).startsWith('link') ? kids.filter((k) => k.tagName === 'LINK' && k.rel === 'stylesheet') : []),
  };
  const con = { warn(...a) { warns.push(a.join(' ')); }, log() {}, info() {}, error() {} };
  const window = { console: con };
  const ctx = { window, document, console: con, URL, setTimeout, clearTimeout, Promise };
  window.window = window; window.document = document;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { SL: ctx.window.ScriptLoader, kids, fetched, warns };
}
const scriptsIn = (env, src) => env.kids.filter((k) => k.tagName === 'SCRIPT' && String(k.src).indexOf(src) !== -1).length;

(async () => {
  console.log('\nA failed fetch is fetched again on the next ask');
  {
    const env = makeEnv({ failFirst: true });
    ok('control: the real ScriptLoader loaded', env.SL && typeof env.SL.load === 'function' && typeof env.SL.loadBundle === 'function');
    await env.SL.load('js/plan.js?v=1');
    ok('the first fetch went out and failed (warned, not rejected)', env.fetched.length === 1 && env.warns.some((w) => /plan\.js/.test(w)), JSON.stringify(env.warns));
    ok('…the dead tag is gone from <head>', scriptsIn(env, 'plan.js') === 0, scriptsIn(env, 'plan.js'));
    ok('…and the file does not count as loaded', env.SL.isLoaded ? env.SL.isLoaded('js/plan.js?v=1') === false : true);
    await env.SL.load('js/plan.js?v=1');
    ok('the next ask fetches the file again', env.fetched.length === 2, JSON.stringify(env.fetched));
    ok('…and this time it loads (one live tag)', scriptsIn(env, 'plan.js') === 1 && (!env.SL.isLoaded || env.SL.isLoaded('js/plan.js?v=1') === true));
    await env.SL.load('js/plan.js?v=1');
    ok('a loaded file is never fetched a third time', env.fetched.length === 2, JSON.stringify(env.fetched));
  }
  {
    const env = makeEnv({ failFirst: true });
    env.SL.bundles.retrytest = ['js/a.js?v=1', 'js/b.js?v=1'];
    await env.SL.loadBundle('retrytest');
    ok('a bundle whose files failed leaves no dead tags', scriptsIn(env, 'a.js') === 0 && scriptsIn(env, 'b.js') === 0, JSON.stringify(env.kids.map((k) => k.src || k.href)));
    await env.SL.loadBundle('retrytest');
    ok('the next loadBundle fetches both files again and loads them, in order',
      scriptsIn(env, 'a.js') === 1 && scriptsIn(env, 'b.js') === 1
        && env.fetched.filter((s) => /a\.js/.test(s)).length === 2 && env.fetched.filter((s) => /b\.js/.test(s)).length === 2,
      JSON.stringify(env.fetched));
  }
  console.log('\nThe eager-tag guard still holds');
  {
    const env = makeEnv();
    await env.SL.load('js/eager.js?v=3');
    const n = env.fetched.length;
    await env.SL.load('js/eager.js?v=3');
    ok('a file that loaded once is not injected again', env.fetched.length === n && scriptsIn(env, 'eager.js') === 1);
  }
  {
    const env = makeEnv({ failFirst: true, noRemove: true });
    let threw = null;
    try { await env.SL.load('js/old-double.js?v=1'); } catch (e) { threw = e; }
    ok('a script element without remove() (older test doubles) does not throw', !threw, threw && threw.message);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
