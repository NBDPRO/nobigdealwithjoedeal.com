/**
 * tests/lazy-customer-photo-report-picker-2026-11-08.test.js — the photo report
 * builder (customer-photo-report-picker.js) leaves the customer page's boot
 * path (boot-weight lane, 2026-11-08).
 *
 * Before: an eager <script defer> on every customer card (~11 KB shipped) that
 * painted nothing at boot: it bound listeners on the hidden #photoReportPicker
 * modal, defined the functions that open it, and installed the load-then-run
 * stub for photo-report.js. After: the ScriptLoader bundle `photoreportpicker`,
 * registered at runtime by js/customer-photo-report-lazy.js, which keeps on the
 * boot path only what must be there:
 *   - window.generatePhotoReport, the photo-report.js stub (the "📋 Generate
 *     Report" button dispatches it by name; tests/e2e/boot-weight.spec.js
 *     expects it at boot);
 *   - window.openPhotoReportPicker, a load-then-call stub for the "📸 Photo
 *     Report" button;
 *   - the #photo-report deep link (photo-review.html, the dashboard chip),
 *     which loads the bundle at boot so the picker's own auto-open runs.
 * Pins, with the REAL script-loader.js in a vm and a fake <head> that lists
 * the tags appended to it and lets a tag remove() itself, as a browser does:
 *   - nothing is fetched at boot without the deep link;
 *   - a click before the file lands opens the builder once it lands;
 *   - a failed fetch leaves the card working and says so; ScriptLoader drops
 *     the dead tag, so the next click fetches again and the builder opens;
 *   - the deep link loads the bundle at boot and the builder opens;
 *   - no ScriptLoader: nothing throws, the click says why;
 *   - customer.html carries the boot file, not the picker; script-loader.js
 *     (blocking budget, at its ceiling) is untouched.
 *
 * Run: node tests/lazy-customer-photo-report-picker-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const exists = (p) => fs.existsSync(path.join(ROOT, p));
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const LAZY_FILE = 'docs/pro/js/customer-photo-report-lazy.js';
const LAZY = exists(LAZY_FILE) ? read(LAZY_FILE) : '';
const PICKER = read('docs/pro/js/customer-photo-report-picker.js');
const LOADER = read('docs/pro/js/script-loader.js');
const CUSTOMER = read('docs/pro/customer.html');
const flush = () => new Promise((r) => setImmediate(r));

// A customer page: window IS the global (bare showToast / setTimeout resolve
// the way they do in a browser), and <head> lists the tags appended to it
// until one remove()s itself (ScriptLoader drops a dead tag on error).
function makePage(opts) {
  opts = opts || {};
  const head = [], appended = [], timers = [], toasts = [], opened = [], replaced = [], warns = [];
  function el(tag) {
    return {
      tagName: String(tag).toUpperCase(), attrs: {}, parentNode: null,
      remove() { if (this.parentNode) this.parentNode.removeChild(this); },
      setAttribute(n, v) { this.attrs[n] = String(v); },
      getAttribute(n) {
        if (n === 'src') return this.src == null ? null : this.src;
        if (n === 'href') return this.href == null ? null : this.href;
        return n in this.attrs ? this.attrs[n] : null;
      },
      addEventListener() {},
    };
  }
  const document = {
    readyState: 'complete',
    baseURI: 'https://x.test/pro/customer.html',
    head: {
      appendChild(e) { head.push(e); appended.push(e); e.parentNode = document.head; return e; },
      removeChild(e) { const i = head.indexOf(e); if (i >= 0) head.splice(i, 1); e.parentNode = null; return e; },
    },
    createElement: el,
    querySelector: () => null,
    querySelectorAll(sel) {
      if (sel === 'script[src]') return head.filter((e) => e.tagName === 'SCRIPT' && e.src);
      if (sel === 'link[rel="stylesheet"][href]') return head.filter((e) => e.tagName === 'LINK' && e.rel === 'stylesheet' && e.href);
      return [];
    },
    getElementById: () => null,
    addEventListener() {},
  };
  const ctx = {
    document, URL, Promise,
    console: { log() {}, info() {}, error() {}, warn(...a) { warns.push(a.join(' ')); } },
    setTimeout(fn) { timers.push(fn); return timers.length; },
    history: { replaceState(...a) { replaced.push(a); } },
    location: { hash: opts.hash || '', pathname: '/pro/customer.html', search: '?id=lead-1' },
    addEventListener() {},
    showToast(m, k) { toasts.push([k, m]); },
    nbdModal: { open(id) { opened.push(id); }, close() {} },
    _customerId: 'lead-1',
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  const page = {
    ctx, head, appended, timers, toasts, opened, replaced, warns,
    run(src, name) { vm.runInContext(src, ctx, { filename: name }); },
    // Call a page global the way the action delegate does; missing = undefined, not a crash.
    call(name, ...a) { return typeof ctx[name] === 'function' ? ctx[name](...a) : undefined; },
    pickerTags() { return head.filter((e) => e.tagName === 'SCRIPT' && /customer-photo-report-picker\.js/.test(String(e.src))); },
    scriptTags() { return head.filter((e) => e.tagName === 'SCRIPT'); },
    runTimers() { while (timers.length) timers.shift()(); },
  };
  if (opts.loader !== false) page.run(LOADER, 'script-loader.js');
  return page;
}
function boot(opts) {
  const page = makePage(opts);
  let threw = null;
  try { page.run(LAZY, 'customer-photo-report-lazy.js'); } catch (e) { threw = e; }
  page.threw = threw;
  return page;
}

(async function main() {
  console.log('\nPHOTO REPORT PICKER: the boot file');
  ok('js/customer-photo-report-lazy.js exists', !!LAZY);
  {
    const p = boot();
    ok('it runs on the real script-loader.js without throwing', !p.threw, p.threw && p.threw.message);
    const B = p.ctx.ScriptLoader && p.ctx.ScriptLoader.bundles;
    const list = (B && B.photoreportpicker) || [];
    ok('it registers the photoreportpicker bundle at runtime, holding only the picker',
      list.length === 1 && /^js\/customer-photo-report-picker\.js\?v=\d+$/.test(list[0]), JSON.stringify(list));
    ok('nothing is fetched at boot (no tag appended, no preload)', p.head.length === 0, p.head.map((e) => e.src || e.href).join(', '));
    const g = p.ctx.generatePhotoReport;
    ok('window.generatePhotoReport is the lazy photo-report.js stub at boot (the e2e boot-weight contract)',
      typeof g === 'function' && g.__nbdLazyPhotoReportStub === true);
    ok('window.openPhotoReportPicker exists at boot, so the 📸 Photo Report button is never an unknown action',
      typeof p.ctx.openPhotoReportPicker === 'function');
  }
  {
    const realOpen = function () {}, realGen = function () {};
    const p = makePage();
    p.ctx.openPhotoReportPicker = realOpen;
    p.ctx.generatePhotoReport = realGen;
    try { p.run(LAZY, 'customer-photo-report-lazy.js'); } catch (e) { /* reported below */ }
    ok('a real implementation already on the page is never clobbered (typeof guards)',
      p.ctx.openPhotoReportPicker === realOpen && p.ctx.generatePhotoReport === realGen);
  }
  {
    // The generatePhotoReport stub, moved here verbatim: loads 'photos', then
    // forwards every argument (the builder's third one too) to the real one.
    const calls = [], got = [];
    const p = makePage({ loader: false });
    p.ctx.ScriptLoader = { bundles: {}, loadBundle(n) { calls.push(n); if (n === 'photos') p.ctx.generatePhotoReport = function () { got.push([].slice.call(arguments)); }; return Promise.resolve(); } };
    try { p.run(LAZY, 'customer-photo-report-lazy.js'); } catch (e) { /* reported below */ }
    const stub = p.ctx.generatePhotoReport;
    if (typeof stub === 'function') await stub('lead-1', 'adjuster', { notes: {} });
    ok('the generatePhotoReport stub loads photos and forwards all three arguments to photo-report.js',
      calls.join() === 'photos' && got.length === 1 && got[0][0] === 'lead-1' && got[0][1] === 'adjuster' && !!got[0][2], JSON.stringify({ calls, got }));
  }

  console.log('\nPHOTO REPORT PICKER: a click before the file lands');
  {
    const p = boot();
    const r = p.call('openPhotoReportPicker');
    await flush();
    const tags = p.pickerTags();
    ok('the click fetches the picker: one tag appended', tags.length === 1, p.scriptTags().map((e) => e.src).join(', '));
    ok('nothing opens before the file lands', p.opened.length === 0, p.opened);
    if (tags[0]) { p.run(PICKER, 'customer-photo-report-picker.js'); tags[0].onload(); }
    await r; await flush();
    ok('once it lands, the same click opens the builder (load-then-call)', p.opened.join() === 'photoReportPicker', p.opened);
    ok('the picker\'s own openPhotoReportPicker replaced the stub', typeof p.ctx.openPhotoReportPicker === 'function' && !p.ctx.openPhotoReportPicker.__nbdLazyPhotoReportPickerStub);
    ok('no error toast on the happy path', !p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
    p.call('openPhotoReportPicker');
    await flush();
    ok('a second click opens it directly, with no second fetch', p.opened.length === 2 && p.pickerTags().length === 1, p.pickerTags().length);
    ok('generatePhotoReport is still the boot stub after the picker lands (the picker no longer defines it)',
      typeof p.ctx.generatePhotoReport === 'function' && p.ctx.generatePhotoReport.__nbdLazyPhotoReportStub === true);
  }

  console.log('\nPHOTO REPORT PICKER: a failed fetch');
  {
    const p = boot();
    let threw = null, r = null;
    try { r = p.call('openPhotoReportPicker'); } catch (e) { threw = e; }
    await flush();
    const tags = p.pickerTags();
    if (tags[0]) tags[0].onerror();
    try { await r; } catch (e) { threw = e; }
    await flush();
    ok('the click neither throws nor rejects', !threw, threw && threw.message);
    ok('nothing opens', p.opened.length === 0, p.opened);
    ok('the rep is told, in an error toast that asks for another tap (not a refresh)',
      p.toasts.some((t) => t[0] === 'error' && /check your connection/i.test(t[1]) && /tap again/i.test(t[1]) && !/refresh/i.test(t[1])), JSON.stringify(p.toasts));
    ok('ScriptLoader drops the dead tag from <head>', !!tags[0] && p.pickerTags().length === 0 && tags[0].parentNode === null,
      p.pickerTags().map((e) => e.src).join(', '));
    p.toasts.length = 0;
    let threw2 = null, r2 = null;
    try { r2 = p.call('openPhotoReportPicker'); } catch (e) { threw2 = e; }
    await flush();
    const again = p.appended.filter((e) => /customer-photo-report-picker\.js/.test(String(e.src)));
    ok('the next click fetches again: a second, new tag', again.length === 2 && again[1] !== tags[0], again.length);
    if (again[1]) { p.run(PICKER, 'customer-photo-report-picker.js'); again[1].onload(); }
    try { await r2; } catch (e) { threw2 = e; }
    await flush();
    ok('...and when it lands, that click opens the builder, with no error toast',
      !threw2 && p.opened.join() === 'photoReportPicker' && !p.toasts.some((t) => t[0] === 'error'), JSON.stringify({ opened: p.opened, toasts: p.toasts }));
    p.toasts.length = 0;
    const gen = p.call('generatePhotoReport', 'lead-1', 'homeowner');
    await flush();
    ok('the card keeps working: 📋 Generate Report still starts photo-report.js\'s bundle',
      p.scriptTags().some((e) => /photo-engine\.js/.test(String(e.src))), p.scriptTags().map((e) => e.src).join(', '));
    void gen;
  }

  console.log('\nPHOTO REPORT PICKER: the #photo-report deep link');
  {
    const p = boot({ hash: '#photo-report' });
    await flush();
    const tags = p.pickerTags();
    ok('with the hash, the boot file starts the picker at boot', tags.length === 1, p.head.map((e) => e.src || e.href).join(', '));
    if (tags[0]) { p.run(PICKER, 'customer-photo-report-picker.js'); tags[0].onload(); }
    await flush();
    p.runTimers();
    await flush();
    ok('once it lands, the picker\'s own auto-open opens the builder', p.opened.join() === 'photoReportPicker', p.opened);
    ok('and clears the hash, as before', p.replaced.length === 1 && p.replaced[0][2] === '/pro/customer.html?id=lead-1', JSON.stringify(p.replaced));
  }
  {
    const p = boot({ hash: '#schedule' });
    await flush();
    ok('any other hash fetches nothing', p.head.length === 0);
  }

  console.log('\nPHOTO REPORT PICKER: no ScriptLoader on the page');
  {
    const p = boot({ loader: false });
    ok('the boot file runs without throwing', !p.threw, p.threw && p.threw.message);
    let threw = null;
    try { await p.call('openPhotoReportPicker'); } catch (e) { threw = e; }
    ok('a click neither throws nor opens, and says why', !threw && p.opened.length === 0 && p.toasts.some((t) => t[0] === 'error'), JSON.stringify(p.toasts));
    const q = boot({ loader: false, hash: '#photo-report' });
    ok('the deep link without a ScriptLoader throws nothing', !q.threw, q.threw && q.threw.message);
  }

  console.log('\nPHOTO REPORT PICKER: the picker file');
  {
    ok('it no longer installs the generatePhotoReport stub (the boot file does)', !/window\.generatePhotoReport\s*=/.test(PICKER));
    ok('it still assigns openPhotoReportPicker unconditionally, so it replaces the stub', /\n  window\.openPhotoReportPicker = function \(\) \{/.test(PICKER));
    ok('it still owns the #photo-report auto-open', /function maybeAutoOpenFromHash\(\)/.test(PICKER) && /'#photo-report'/.test(PICKER));
  }

  console.log('\nPHOTO REPORT PICKER: customer.html and script-loader.js');
  {
    ok('customer.html has no eager tag for the picker', !/<script[^>]*src="[^"]*customer-photo-report-picker\.js/.test(CUSTOMER));
    ok('customer.html carries the boot file as a deferred external tag', /<script defer src="js\/customer-photo-report-lazy\.js\?v=\d+"><\/script>/.test(CUSTOMER));
    ok('it comes after script-loader.js (registration and the deep-link load need it)',
      CUSTOMER.indexOf('js/customer-photo-report-lazy.js') > CUSTOMER.indexOf('js/script-loader.js') && CUSTOMER.indexOf('js/script-loader.js') > 0);
    ok('the 📸 Photo Report button still dispatches openPhotoReportPicker', /data-action="openPhotoReportPicker"/.test(CUSTOMER));
    ok('the modal markup the picker drives is unchanged', ['photoReportPicker', 'prpBuilder', 'prpToggle', 'prpCancel', 'prpGenerate'].every((id) => CUSTOMER.indexOf('id="' + id + '"') >= 0));
    ok('photo-report.js is still not an eager tag', !/<script[^>]+src="[^"]*photo-report\.js/.test(CUSTOMER));
    ok('📋 Generate Report still dispatches generatePhotoReport by name', /data-action="generatePhotoReport"/.test(read('docs/pro/js/customer-bootstrap.module.js')));
    ok('script-loader.js is untouched: no picker bundle in the blocking file', !/customer-photo-report-picker|photoreportpicker/.test(LOADER));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-customer-photo-report-picker-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('  ✗ crashed: ' + (e && e.stack)); process.exit(1); });
