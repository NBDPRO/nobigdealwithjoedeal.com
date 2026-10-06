/* tests/pro-demo-zero-network-2026-10-06.test.js
 *
 * Pro demo phase 2, wave 1: the browser-only sample account makes ZERO
 * network calls to Firebase, Stripe, Twilio or any other service.
 *
 * Real Chromium, real pages: the REAL docs/pro/dashboard.html and
 * customer.html, served under /pro/explore/ by tests/lib/demo-hosting-server.js
 * with firebase.json's own rewrites and effective headers (so the demo
 * route's CSP is the one Hosting would send), with the demo service worker
 * running. The walk:
 *
 *   1. /pro/explore registers the demo worker and lands on the dashboard;
 *      the sample company's leads load; the "Sample account" strip shows.
 *   2. Pipeline: a kanban arrow moves a lead to the next stage through the
 *      CRM's own move-card handler.
 *   3. Reload: the move survived (IndexedDB mirror), still no network.
 *   4. The CRM's own absolute navigation to /pro/customer.html?id=… is kept
 *      inside the sample account (/pro/explore/customer?id=…) and the
 *      customer card renders the story customer.
 *   5. A note is saved through the page's own saveNote().
 *   6. A "send" callable answers with what it would do, never a fake send.
 *
 * Fails if ANY of these happened during the walk:
 *   - a request left 127.0.0.1, other than (a) the gstatic SDK URLs the
 *     demo worker answers itself (asserted fromServiceWorker, so never on
 *     the network) and (b) static Google Fonts CSS/woff2 (answered locally
 *     here so the run is hermetic)
 *   - the server saw anything but a GET/HEAD of a static file, or any hit on
 *     a function rewrite (/api/**, /cspReport, …)
 *   - the page's tripwire blocked an attempt (window.__NBD_DEMO__.blocked)
 *   - the CSP refused a connect-src / frame-src / form-action attempt
 *
 * Then it proves the two guards independently: an attempt to reach
 * firestore.googleapis.com through window.fetch is stopped by the tripwire,
 * and the same attempt through an unwrapped fetch (an about:blank iframe's)
 * is stopped by the CSP (connect-src 'self'), with nothing reaching the
 * network either way. And a load WITHOUT the demo worker never boots the CRM.
 *
 * Wired individually in CI (needs Playwright's Chromium). Locally it SKIPS
 * when playwright is not resolvable; under CI=true that is a failure.
 */
'use strict';

const { start } = require('./lib/demo-hosting-server');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 1500) : '')); }
}
function report() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}

const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const SDK_URL = /^https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-[a-z-]+\.js$/;
const ALLOWED_MISSING = new Set(['/pro/nosw.txt']); // the SW kill-switch probe: a 404 HEAD is the normal answer

async function waitFor(page, fn, arg, ms) {
  return page.waitForFunction(fn, arg, { timeout: ms || 30000, polling: 200 });
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    if (process.env.CI) { ok('playwright is installed (required in CI)', false); return report(); }
    console.log('  ! playwright unavailable — SKIPPED'); return report();
  }

  const srv = await start();
  const ORIGIN = srv.origin;
  const browser = await chromium.launch();
  try {
    // ── the walk ──────────────────────────────────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow' });
    const offsite = [];      // requests that reached the router (i.e. the network) off-origin
    const seen = [];         // every request the browser made, with provenance
    await ctx.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI || '').slice(0, 200) });
      });
    });
    await ctx.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN + '/')) return route.continue();
      if (FONT_HOST.test(u)) {
        const css = /fonts\.googleapis\.com/.test(u);
        return route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* hermetic */' : '' });
      }
      offsite.push(route.request().method() + ' ' + u);
      return route.abort('blockedbyclient');
    });
    ctx.on('requestfinished', async (req) => {
      let sw = false;
      try { const res = await req.response(); sw = !!(res && res.fromServiceWorker()); } catch (_) {}
      seen.push({ url: req.url(), method: req.method(), sw });
    });
    ctx.on('requestfailed', (req) => seen.push({ url: req.url(), method: req.method(), failed: (req.failure() || {}).errorText }));

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 300)));

    console.log('1. open the sample account');
    await page.goto(ORIGIN + '/pro/explore');
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 30000 });
    await waitFor(page, () => Array.isArray(window._leads) && window._leads.length >= 20);
    const boot = await page.evaluate(() => ({
      demo: !!(window.__NBD_DEMO__ && window.__NBD_DEMO__.active),
      controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      uid: window._user && window._user.uid,
      strip: (document.getElementById('nbd-demo-strip') || {}).textContent || '',
      appDemo: !!(window.db && window.db.__nbdDemo),
      key: window.__NBD_APP_CHECK_KEY || ''
    }));
    ok('the dashboard runs under the demo service worker', boot.controlled && boot.demo);
    ok('the CRM is on the fake Firestore (window.db.__nbdDemo)', boot.appDemo);
    ok('signed in as the sample owner', boot.uid === 'demo-owner');
    ok('the "Sample account" strip is on screen', /Sample account/.test(boot.strip) && /Reset/.test(boot.strip) && /Start free/.test(boot.strip), boot.strip);
    ok('no production App Check key was loaded', boot.key === '');

    console.log('2. move a lead on the pipeline');
    await page.evaluate(() => window.goTo('crm'));
    const arrow = page.locator('[data-action="move-card"][data-id="sample-lead-02"][data-target-stage="contacted"]');
    await arrow.waitFor({ state: 'visible', timeout: 20000 });
    await arrow.click();
    await waitFor(page, () => (window._leads || []).some((l) => l.id === 'sample-lead-02' && l.stage === 'contacted'), null, 15000);
    ok('the kanban arrow moved Maya Brooks to Contacted', true);

    console.log('3. reload keeps the change');
    await page.waitForTimeout(600); // IndexedDB mirror is debounced (150 ms)
    await page.reload();
    await waitFor(page, () => Array.isArray(window._leads) && window._leads.length >= 20);
    const kept = await page.evaluate(() => ((window._leads || []).find((l) => l.id === 'sample-lead-02') || {}).stage);
    ok('after a reload the lead is still Contacted', kept === 'contacted', kept);

    console.log('4. open the customer card through the CRM\'s own navigation');
    await page.evaluate(() => { window.location.href = '/pro/customer.html?id=sample-lead-01'; });
    await page.waitForURL(/\/pro\/explore\/customer\?id=sample-lead-01$/, { timeout: 30000 });
    await waitFor(page, () => /Jordan Avery/.test(document.body.innerText) && typeof window.saveNote === 'function', null, 30000);
    ok('the absolute /pro/customer.html link stayed inside the sample account', /\/pro\/explore\/customer\?id=sample-lead-01$/.test(page.url()), page.url());
    const cust = await page.evaluate(() => document.body.innerText);
    ok('the customer card shows the story customer and address', /Jordan Avery/.test(cust) && /214 Sample Ridge Rd/.test(cust));

    console.log('5. save a note');
    const note = await page.evaluate(async () => {
      const t = document.getElementById('noteText');
      if (!t) return { err: 'no #noteText' };
      t.value = 'Sample note from the zero-network walk';
      await window.saveNote();
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const s = await F.getDocs(F.query(F.collection(F.getFirestore(), 'notes'), F.where('leadId', '==', 'sample-lead-01')));
      return { n: s.docs.filter((d) => d.data().text === 'Sample note from the zero-network walk').length };
    });
    ok('the note saved to the in-browser store', note.n === 1, JSON.stringify(note));

    console.log('6. a send callable is honest');
    const call = await page.evaluate(async () => {
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      try { await m.httpsCallable(m.getFunctions(), 'sendEstimateEnvelope')({ leadId: 'sample-lead-01' }); return { sent: true }; }
      catch (e) { return { code: e.code, msg: e.message }; }
    });
    ok('sendEstimateEnvelope says what it would do and sends nothing', !call.sent && /In your real account this would email the estimate/.test(call.msg || ''), JSON.stringify(call));

    // ── the zero-network verdict for the walk ─────────────────────────────
    console.log('verdict');
    const state = await page.evaluate(() => ({ blocked: window.__NBD_DEMO__.blocked.slice(), csp: window.__cspViolations.slice() }));
    ok('the tripwire blocked nothing during the walk (no attempt was made)', state.blocked.length === 0, JSON.stringify(state.blocked));
    const connectish = state.csp.filter((v) => /^(connect-src|frame-src|form-action|child-src|worker-src)$/.test(v.directive));
    ok('the CSP refused no connect/frame/form attempt during the walk', connectish.length === 0, JSON.stringify(connectish));
    ok('no request reached the network off-origin', offsite.length === 0, offsite.join('\n'));
    const sdk = seen.filter((r) => SDK_URL.test(r.url));
    ok('the Firebase SDK URLs were requested (the swap was exercised, not skipped)', sdk.length >= 5, sdk.length);
    const sdkNet = sdk.filter((r) => !r.sw);
    ok('every Firebase SDK URL was answered by the demo service worker, never the network', sdkNet.length === 0, sdkNet.map((r) => r.url).join('\n'));
    const strayOff = seen.filter((r) => !r.url.startsWith(ORIGIN + '/') && !SDK_URL.test(r.url) && !FONT_HOST.test(r.url) && !/^(blob|data):/.test(r.url));
    ok('no other off-origin request was even attempted', strayOff.length === 0, strayOff.map((r) => r.method + ' ' + r.url).join('\n'));
    const badServer = srv.log.filter((e) => !(e.method === 'GET' || e.method === 'HEAD') || e.kind === 'function' || e.kind === 'write' || (e.kind === 'missing' && !ALLOWED_MISSING.has(e.path)));
    ok('the server saw only static GET/HEAD reads (no function rewrite, no write)', badServer.length === 0, JSON.stringify(badServer.slice(0, 10)));
    ok('the server served the real pages through the rewrites', srv.log.some((e) => e.path === '/pro/explore/dashboard' && e.kind === 'rewrite') && srv.log.some((e) => e.path === '/pro/explore/customer' && e.kind === 'rewrite'));
    ok('no uncaught page errors', pageErrors.length === 0, pageErrors.join('\n'));

    // ── both guards, proven on purpose ────────────────────────────────────
    console.log('guards');
    const before = offsite.length;
    const probe = await page.evaluate(async () => {
      const target = 'https://firestore.googleapis.com/v1/projects/nobigdeal-pro/databases/(default)/documents/leads';
      const out = {};
      try { await window.fetch(target); out.tripwire = 'reached'; } catch (e) { out.tripwire = 'blocked'; }
      out.blockedAfter = window.__NBD_DEMO__.blocked.length;
      const ifr = document.createElement('iframe');
      document.body.appendChild(ifr);
      const rawFetch = ifr.contentWindow.fetch.bind(ifr.contentWindow); // NOT wrapped by demo-mode.js
      try { await rawFetch(target); out.csp = 'reached'; } catch (e) { out.csp = 'blocked'; }
      await new Promise((r) => setTimeout(r, 300));
      out.cspViolation = window.__cspViolations.some((v) => v.directive === 'connect-src' && /googleapis/.test(v.blocked)) ||
        (ifr.contentWindow.__cspViolations || []).length > 0;
      return out;
    });
    ok('tripwire: window.fetch to Firestore is refused and logged', probe.tripwire === 'blocked' && probe.blockedAfter === 1, JSON.stringify(probe));
    ok('CSP: an unwrapped fetch to Firestore is refused by connect-src \'self\'', probe.csp === 'blocked', JSON.stringify(probe));
    ok('neither attempt reached the network', offsite.length === before, offsite.slice(before).join('\n'));
    await ctx.close();

    // ── no demo worker, no CRM boot ───────────────────────────────────────
    console.log('no service worker');
    const ctx2 = await browser.newContext({ serviceWorkers: 'block' });
    const net2 = [];
    await ctx2.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(ORIGIN + '/')) return route.continue();
      if (!FONT_HOST.test(u)) net2.push(u);
      return FONT_HOST.test(u) ? route.fulfill({ status: 200, body: '' }) : route.abort('blockedbyclient');
    });
    const p2 = await ctx2.newPage();
    await p2.goto(ORIGIN + '/pro/explore/dashboard');
    await p2.waitForURL(/\/pro\/explore\?next=/, { timeout: 15000 });
    await p2.waitForTimeout(1500);
    const st2 = await p2.evaluate(() => ({ leads: Array.isArray(window._leads), msg: (document.getElementById('xe-status') || {}).textContent || '' }));
    ok('without the demo worker the dashboard does not boot; the entry page explains', !st2.leads && /cannot|could not/.test(st2.msg), JSON.stringify(st2));
    const api2 = net2.filter((u) => !SDK_URL.test(u));
    ok('and nothing but (at most) the static SDK files was even requested off-origin', api2.length === 0, api2.join('\n'));
    await ctx2.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
