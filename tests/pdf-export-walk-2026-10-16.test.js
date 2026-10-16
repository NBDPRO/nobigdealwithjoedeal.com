/* tests/pdf-export-walk-2026-10-16.test.js
 *
 * The client PDF engines, in a real browser, on the sample account
 * (repos report 2026-10-16 item 2: jsPDF 2.5.1 -> 4.2.1, html2pdf -> 0.14.0
 * built by scripts/vendor-pdf-libs.js on top of the ONE standalone jsPDF).
 *
 * Same server and Chromium recipe as pro-demo-zero-network-2026-10-06
 * (tests/lib/demo-hosting-server.js: firebase.json's rewrites + headers,
 * the demo service worker, no network). The walk:
 *   1. Customer card -> Documents -> Invoice -> the viewer's real
 *      "Download PDF" button: a real PDF file downloads (html2pdf path).
 *   2. A contract with two signature pads: both pads are drawn on, then
 *      "Download PDF": the signed, multi-page PDF downloads.
 *   3. The customer estimate export (exportCustomerEstimate, direct jsPDF).
 * And across all three: jsPDF 4.2.1 is the jsPDF in the page, each PDF
 * library file was fetched once and nothing else of jsPDF/html2pdf was,
 * no CSP violation, no uncaught page error.
 *
 * CI: ci.yml pro-demo-zero-network job, on the readable tree and again on
 * the minified build the deploy ships.
 * Run: cd tests && node pdf-export-walk-2026-10-16.test.js
 */
'use strict';
const { start } = require('./lib/demo-hosting-server');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 500) : '')); }
}
function report() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
}
const FONT_HOST = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//;
const waitFor = (page, fn, arg, ms) => page.waitForFunction(fn, arg, { timeout: ms || 30000, polling: 200 });
async function pdfInfo(download) {
  const fs = require('fs');
  const p = await download.path();
  const buf = fs.readFileSync(p);
  const s = buf.toString('latin1');
  return { size: buf.length, header: s.slice(0, 5), pages: (s.match(/\/Type\s*\/Page[^s]/g) || []).length, producer: (s.match(/\/Producer \(([^)]*)\)/) || [])[1] || '' };
}

(async () => {
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (_) {
    if (process.env.CI) { ok('playwright is installed (required in CI)', false); return report(); }
    console.log('  ! playwright unavailable — SKIPPED'); return report();
  }
  const srv = await start();
  const O = srv.origin;
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow', acceptDownloads: true });
    await ctx.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push({ directive: e.effectiveDirective, blocked: String(e.blockedURI || '').slice(0, 200) });
      });
    });
    const offsite = [];
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (u.startsWith(O + '/')) return route.continue();
      if (FONT_HOST.test(u)) return route.fulfill({ status: 200, contentType: /googleapis/.test(u) ? 'text/css' : 'font/woff2', body: '' });
      offsite.push(u);
      return route.abort('blockedbyclient');
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 300)));
    const libs = [];
    page.on('request', (r) => { if (/\/assets\/vendor\/(jspdf|html2pdf)\//.test(r.url())) libs.push(r.url().slice(O.length)); });

    await page.goto(O + '/pro/explore');
    await page.waitForURL(O + '/pro/explore/dashboard', { timeout: 30000 });
    await waitFor(page, () => Array.isArray(window._leads) && window._leads.length >= 20);
    await page.evaluate(() => { window.location.href = '/pro/customer.html?id=sample-lead-01'; });
    await page.waitForURL(/\/pro\/explore\/customer\?id=sample-lead-01$/, { timeout: 30000 });
    await waitFor(page, () => /Jordan Avery/.test(document.body.innerText) && typeof window.exportCustomerEstimate === 'function', null, 30000);

    async function generateDoc(type) {
      await page.evaluate(() => { const v = document.getElementById('nbd-doc-viewer-overlay'); if (v) v.classList.remove('open'); });
      await page.locator('[data-action="generateCustomerDoc"][data-doc-type="' + type + '"]').first().evaluate((el) => el.click());
      await page.waitForSelector('.dpf-card', { timeout: 20000 });
      await page.evaluate(() => { const s = document.getElementById('nbdv-iframe'); if (s) s.srcdoc = ''; });
      await page.locator('.dpf-card button', { hasText: /Generate/i }).last().click();
      await page.waitForSelector('#nbd-doc-viewer-overlay.open', { timeout: 20000 });
      await waitFor(page, () => ((document.getElementById('nbdv-iframe') || {}).srcdoc || '').length > 2000, null, 20000);
    }
    async function clickDownload() {
      const dl = page.waitForEvent('download', { timeout: 60000 });
      await page.locator('#nbd-doc-viewer-overlay button', { hasText: /Download PDF/ }).first().click();
      return dl;
    }

    console.log('1. invoice -> Download PDF (html2pdf)');
    await generateDoc('invoice');
    const inv = await pdfInfo(await clickDownload());
    ok('the invoice downloads as a real PDF', inv.header === '%PDF-' && inv.pages >= 1 && inv.size > 10000, JSON.stringify(inv));
    ok('jsPDF 4.2.1 is the jsPDF in the page', (await page.evaluate(() => window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.version)) === '4.2.1');
    ok('html2pdf is the 0.14.0 build on the page\'s jsPDF (its Worker exists, no second jsPDF)',
      await page.evaluate(() => typeof window.html2pdf === 'function' && typeof window.html2pdf.Worker === 'function'));

    console.log('2. a signed contract -> Download PDF');
    await generateDoc('contract');
    const frame = page.frames().find((f) => f !== page.mainFrame() && f.parentFrame() === page.mainFrame());
    let pads = 0;
    for (const c of (frame ? await frame.locator('canvas').elementHandles() : [])) {
      await c.scrollIntoViewIfNeeded().catch(() => {});
      const bb = await c.boundingBox();
      if (!bb || bb.width < 50) continue;
      await page.mouse.move(bb.x + 20, bb.y + bb.height * 0.6);
      await page.mouse.down();
      for (let k = 1; k <= 12; k++) await page.mouse.move(bb.x + 20 + k * (bb.width - 60) / 12, bb.y + bb.height * (0.6 - 0.3 * Math.sin(k)), { steps: 2 });
      await page.mouse.up();
      pads++;
    }
    ok('the contract has signature pads and both were signed', pads >= 2, 'pads ' + pads);
    const con = await pdfInfo(await clickDownload());
    ok('the signed contract downloads as a real multi-page PDF', con.header === '%PDF-' && con.pages >= 5, JSON.stringify(con));

    console.log('3. estimate export (jsPDF directly)');
    await page.evaluate(() => { const v = document.getElementById('nbd-doc-viewer-overlay'); if (v) v.classList.remove('open'); });
    const estId = await page.evaluate(() => { const b = document.querySelector('[data-est-id]'); return b && b.dataset.estId; });
    ok('the sample customer has an estimate to export', !!estId);
    const dlE = page.waitForEvent('download', { timeout: 60000 });
    await page.evaluate((id) => window.exportCustomerEstimate(id), estId);
    const est = await pdfInfo(await dlE);
    ok('the estimate export downloads as a one-page jsPDF 4.2.1 PDF', est.header === '%PDF-' && est.pages === 1 && /jsPDF 4\.2\.1/.test(est.producer), JSON.stringify(est));

    console.log('across the walk');
    const uniq = [...new Set(libs.map((u) => u.split('?')[0]))].sort();
    ok('exactly the two PDF library files were fetched: jsPDF 4.2.1 and the html2pdf 0.14.0 build',
      JSON.stringify(uniq) === JSON.stringify(['/assets/vendor/html2pdf/0.14.0/html2pdf.nbd.min.js', '/assets/vendor/jspdf/4.2.1/jspdf.umd.min.js']), JSON.stringify(libs));
    const csp = await page.evaluate(() => window.__cspViolations || []);
    ok('no CSP violation', csp.length === 0, JSON.stringify(csp));
    ok('no uncaught page error', pageErrors.length === 0, pageErrors.join(' | '));
    ok('nothing left this machine', offsite.length === 0, offsite.join(', '));
  } catch (e) {
    ok('the walk ran to the end', false, e && e.stack || e);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  report();
})();
