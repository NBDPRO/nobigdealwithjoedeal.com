/**
 * iphone-parity-2026-11-25.test.js — the iPhone app must not fall behind Android.
 *
 * Joe's report: the CRM on his Android phone feels "further along" than on his
 * iPhone. The 2026-11-25 diagnosis found no code that serves the two phones
 * different builds; the gaps were in how the app boots, resumes and updates on
 * an iPhone, plus Safari-only bugs. Each section pins one fix:
 *
 *   1. feature-flags.js: a slow sign-in (> 10 s, common on an iPhone cold start)
 *      or one failed read left EVERY flag off for the session (47 files read
 *      them). Now the read keeps waiting, retries a failure, and reads again
 *      when the app comes back to the foreground.
 *   2. safe-reload.js: a resumed home-screen app kept running the old build
 *      for days; only a service-worker byte change reloaded it. Now coming back
 *      to the foreground compares the loaded build (window.__NBD_RELEASE) with
 *      the live /version.json and reloads safely, once per live build.
 *   3. theme-color was "var(--bg)" (invalid): Android painted the manifest's
 *      orange, iPhone painted nothing.
 *   4. sms: links: a bare "?body=" is dropped by some iOS versions; the number
 *      must not be %-encoded.
 *   5. The D2D voice memo was labelled audio/webm though an iPhone records mp4.
 *   6. Inputs under 16px make iOS zoom the page on focus.
 *
 * Run: node tests/iphone-parity-2026-11-25.test.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const K = require('./lib/src-kit');

// ── fake clock ──────────────────────────────────────────────────────────
function makeClock() {
  let now = 1_700_000_000_000, seq = 0;
  const timers = new Map();
  const add = (fn, ms, every) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0), every }); return id; };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms || 1),
    clear: (id) => { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        timers.forEach((t, id) => { if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t }; });
        if (!next) break;
        now = next.t.at;
        if (next.t.every) next.t.at = now + next.t.every; else timers.delete(next.id);
        next.t.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

function makeDocEvents() {
  const ls = {};
  return {
    visibilityState: 'visible',
    addEventListener(t, f) { (ls[t] = ls[t] || []).push(f); },
    fire(t) { (ls[t] || []).forEach((f) => f({ type: t })); },
  };
}

// ── 1. feature flags ────────────────────────────────────────────────────
async function flagsSuite() {
  console.log('\nFEATURE FLAGS (js/feature-flags.js)');
  const SRC = read('docs/pro/js/feature-flags.js');

  function boot(opts) {
    const clock = makeClock();
    const document = makeDocEvents();
    let reads = 0;
    const events = [];
    const win = {
      document,
      addEventListener() {},
      dispatchEvent(e) { events.push(e.type); },
      doc: (db, c, id) => ({ id }),
      getDoc: async (ref) => {
        reads++;
        if (opts.fail && opts.fail(reads, ref.id)) throw new Error('unavailable');
        return { exists: () => ref.id === '_default', data: () => ({ followUpBoard: true }) };
      },
    };
    win.window = win;
    const ctx = vm.createContext({
      window: win, document, Date: { now: clock.now },
      setInterval: clock.setInterval, clearInterval: clock.clear,
      setTimeout: clock.setTimeout, clearTimeout: clock.clear,
      CustomEvent: function (t) { this.type = t; }, Promise, Object, console,
    });
    vm.runInContext(SRC, ctx);
    return { clock, win, document, events, reads: () => reads };
  }
  const signIn = (b) => { b.win.db = {}; b.win._user = { uid: 'u1' }; };

  {
    const b = boot({});
    await b.clock.advance(15_000); // an iPhone cold start: sign-in lands after 15 s
    signIn(b);
    await b.clock.advance(1_000);
    ok('a sign-in that lands after 15 s still loads the flags', b.win.NBDFlags.enabled('followUpBoard'),
      'loaded=' + b.win.NBDFlags.isLoaded());
  }
  {
    const b = boot({ fail: (n) => n <= 2 }); // first read (2 docs) fails
    signIn(b);
    await b.clock.advance(1_000);
    ok('control: the first read really failed', !b.win.NBDFlags.isLoaded());
    await b.clock.advance(60_000);
    ok('a failed read is retried and the flags arrive', b.win.NBDFlags.enabled('followUpBoard'));
  }
  {
    const b = boot({});
    signIn(b);
    await b.clock.advance(1_000);
    const before = b.reads();
    ok('control: flags loaded once', b.win.NBDFlags.isLoaded() && before === 2, 'reads=' + before);
    b.document.fire('visibilitychange');
    await b.clock.advance(10);
    ok('foreground inside the 10-minute window does not re-read', b.reads() === before);
    await b.clock.advance(11 * 60_000);
    b.document.fire('visibilitychange');
    await b.clock.advance(10);
    ok('foreground after the window re-reads the flags', b.reads() > before, 'reads=' + b.reads());
    ok('the re-read announces nbd:flags-loaded again', b.events.filter((e) => e === 'nbd:flags-loaded').length >= 2);
  }
}

// ── 2. new build on resume ──────────────────────────────────────────────
async function deploySuite() {
  console.log('\nNEW BUILD ON RESUME (js/safe-reload.js)');
  const SRC = read('docs/pro/js/safe-reload.js');

  function boot(opts) {
    const clock = makeClock();
    const document = makeDocEvents();
    document.querySelectorAll = () => [];
    let bars = 0;
    document.body = { appendChild() { bars++; } };
    document.documentElement = document.body;
    document.createElement = () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} });
    let reloads = 0, fetches = 0, swUpdates = 0;
    const store = opts.session || {};
    const win = {
      __NBD_RELEASE: opts.release,
      location: { reload() { reloads++; } },
      addEventListener() {},
      sessionStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
      navigator: { serviceWorker: { getRegistration: async () => ({ update() { swUpdates++; } }) } },
      fetch: async (url, init) => {
        fetches++;
        if (opts.offline) throw new Error('offline');
        return { ok: true, json: async () => ({ sha: opts.live, url, init }) };
      },
    };
    win.window = win;
    const ctx = vm.createContext({
      window: win, document, navigator: win.navigator, fetch: win.fetch, sessionStorage: win.sessionStorage,
      Date: { now: clock.now }, setTimeout: clock.setTimeout, clearTimeout: clock.clear,
      Set, Object, Promise, String, Number, console,
    });
    vm.runInContext(SRC, ctx);
    return { clock, document, store, bars: () => bars, reloads: () => reloads, fetches: () => fetches, swUpdates: () => swUpdates };
  }
  const A = 'aaaaaaaa' + '0'.repeat(32), B = 'bbbbbbbb' + '0'.repeat(32);
  const resume = async (b) => { b.document.visibilityState = 'visible'; b.document.fire('visibilitychange'); await b.clock.advance(50); await b.clock.advance(50); };

  {
    const b = boot({ release: 'web@2026-11-25-aaaaaaaa', live: B });
    await resume(b);
    ok('foreground with a newer live build does NOT reload under the rep (in-memory work is invisible to the guard)', b.reloads() === 0, 'reloads=' + b.reloads() + ' fetches=' + b.fetches());
    ok('…it offers the reload (the "new version" bar is up)', b.bars() === 1);
    ok('…and asks the service worker to update too', b.swUpdates() >= 1);
    b.document.visibilityState = 'hidden'; b.document.fire('visibilitychange'); await b.clock.advance(50);
    ok('leaving the app while idle reloads onto the new build', b.reloads() === 1, 'reloads=' + b.reloads());
  }
  {
    const b = boot({ release: 'web@2026-11-25-aaaaaaaa', live: A });
    await resume(b);
    ok('control: same build live → no reload', b.reloads() === 0 && b.fetches() === 1, 'fetches=' + b.fetches());
  }
  {
    const b = boot({ release: 'web@2026-11-25-aaaaaaaa', live: B, session: { 'nbd-reloaded-for': 'bbbbbbbb' } });
    await resume(b);
    ok('a page already reloaded for that live build does not loop', b.reloads() === 0);
  }
  {
    const b = boot({ release: 'web@source', live: B });
    await resume(b);
    ok('an unstamped (local/source) build never checks', b.fetches() === 0 && b.reloads() === 0);
  }
  {
    const b = boot({ release: 'web@2026-11-25-aaaaaaaa', live: A });
    await resume(b); await resume(b);
    ok('resume checks are throttled', b.fetches() === 1, 'fetches=' + b.fetches());
    await b.clock.advance(6 * 60_000);
    await resume(b);
    ok('…and run again after the throttle window', b.fetches() === 2, 'fetches=' + b.fetches());
  }
  {
    const b = boot({ release: 'web@2026-11-25-aaaaaaaa', live: B, offline: true });
    await resume(b);
    ok('offline: no reload, no throw', b.reloads() === 0);
  }
}

// ── 3-6. static pins ────────────────────────────────────────────────────
function staticSuite() {
  console.log('\nSTATIC PINS');
  for (const page of ['docs/pro/dashboard.html', 'docs/pro/customer.html']) {
    const meta = K.parseTags(K.read(page)).$('meta[name="theme-color"]');
    const color = meta ? String(meta.attrs.content) : '';
    ok(page + ': theme-color is a literal colour', /^#[0-9a-fA-F]{6}$/.test(color), color);
  }

  const JS = path.join(ROOT, 'docs/pro/js');
  const files = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { if (f.name !== 'vendor') walk(p); } else if (/\.js$/.test(f.name) && !/\.min\.js$/.test(f.name)) files.push(p);
    }
  })(JS);
  const bare = [], encodedNum = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    // A built sms link whose body follows a bare "?body=" (not "?&body=").
    s.split('\n').forEach((line, i) => {
      // Comments, and the validators that accept an old stored draft, are not links.
      if (/^\s*(\/\/|\/?\*)/.test(line) || /_RE\s*=/.test(line) || /replace\('\?body='/.test(line)) return;
      if (/sms:/.test(line) && /[?]body=/.test(line)) bare.push(rel + ':' + (i + 1));
      if (/'sms:'\s*\+\s*encodeURIComponent\(/.test(line)) encodedNum.push(rel + ':' + (i + 1));
    });
  }
  ok('no sms: link uses a bare ?body= (iOS drops it)', bare.length === 0, bare.join(', '));
  ok('no sms: link %-encodes the number', encodedNum.length === 0, encodedNum.join(', '));
  ok('control: the working shape exists (phone-share.js)', /\?&body=/.test(read('docs/pro/js/phone-share.js')));

  ok('D2D voice memo blob takes the recorder\'s real type', /new Blob\(state\.voiceChunks, \{ type: state\.voiceRecorder\.mimeType/.test(read('docs/pro/js/d2d-tracker-ui-2026b.js')));

  const rules = K.cssRules(K.read('docs/pro/css/mobile-polish.css'));
  const px16 = (sel) => { const d = K.cssRule(rules, sel, { media: '(pointer: coarse)' }); return !!d && /^16px\s*!important$/.test(String(d['font-size'])); };
  ok('16px rule covers inputs with no type', px16('input:not([type])'));
  ok('16px rule covers date/time inputs', ['date', 'time', 'datetime-local', 'month'].every((t) => px16('input[type="' + t + '"]')));
  ok('16px rule covers the bulk-action selects and button-styled selects', px16('html #bulkActionBar select') && px16('select.btn'));
  ok('control: an unlisted selector is not reported as covered', !px16('input[type="checkbox"]'));

  // Centred dialogs (follow-up, 2026-11-25): a box centred in the screen starts
  // at (H - h) / 2, so in the installed iPhone app (which draws under the status
  // bar) it clears the Dynamic Island only when h <= H - 2 x the top inset.
  const DIALOGS = [
    ['canvasser', '.cv-card'], ['claim-core-view', '.ccx-maxw560px-wd100-max86vh.ccx-maxw560px-wd100-max86vh.ccx-maxw560px-wd100-max86vh'],
    ['contact-labels', '.cl-sheet'], ['promise', '.pr-sheet'], ['production', '.pr-sheet-card'], ['product-library', '.plx-modal'],
    ['social-studio', '.ss-sheet-card'], ['visit-recorder', '.nbd-vr-sheet'], ['sort-customers', '.sc-modal'],
    ['theme-bridge', '#nbd-picker-inner'], ['theme-bridge', '.nhm-inner'], ['theme-bridge', '#nbd-howto-modal>div'],
    ['call-brief', '.cb-sheet'], ['demo-mode', '.nbd-sp'], ['os/pocket', '.os-pocket'], ['os/system', '.os-sheet'],
    ['os/acts', '.os-acts'], ['os/home', '.os-hw-add'], ['os/peek', '.os-pk'], ['os/privacy', '.os-pv'], ['os/shutdown', '.os-sd'],
  ];
  const uncapped = DIALOGS.filter(([f, sel]) => {
    const d = K.cssRule(K.cssRules(K.read('docs/pro/css/' + f + '.css')), sel);
    return !d || !/calc\(100dvh - 2 \* env\(safe-area-inset-top, 0px\) - 16px\)/.test(String(d['max-height']));
  }).map(([f, sel]) => f + ' ' + sel);
  ok('every centred dialog is capped at the screen minus twice the top safe area', uncapped.length === 0, uncapped.join(', '));
  const sheet = K.cssRule(K.cssRules(K.read('docs/pro/css/winback-view.css')), '.wbx-bgs-ct-bd1pxsolid.wbx-bgs-ct-bd1pxsolid.wbx-bgs-ct-bd1pxsolid');
  ok('the win-back bottom sheet is capped at the screen minus the top safe area', !!sheet && /calc\(100dvh - env\(safe-area-inset-top, 0px\) - 12px\)/.test(String(sheet['max-height'])));
  const cm = K.parseTags(K.read('docs/pro/customer.html')).byId('editCustomerModal');
  ok('customer page Edit Customer modal is capped too', /max-height:min\(85vh, calc\(100dvh - 2 \* env\(safe-area-inset-top, 0px\) - 16px\)\)/.test(String((cm && cm.html) || '')));
}

(async () => {
  await flagsSuite();
  await deploySuite();
  staticSuite();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
