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
 *   Wave 2 (2026-10-06):
 *   7. The customer card's photo grid shows the sample drawings (loaded).
 *   8. Contract, proposal and homeowner inspection report generate from the
 *      sample data through the real pre-flight sheet and viewer: the sample
 *      company's brand, Jordan's line items, Kentucky notices and nothing
 *      due at signing, the sample photos, no "lifetime workmanship".
 *   9. The viewer's Send for Signature opens the read-only "Nothing was
 *      sent" preview (the email + the page in a no-permission sandbox).
 *  10. The dashboard's V3 builder, every Next a REAL click (the strip used
 *      to cover the bar): a retail job, per-square, Standard / Preferred /
 *      Elite with System Plus and "sample price", 50% deposit, saved.
 *  11. Its Send for Signature and Send to homeowner show their previews;
 *      the builder's own status line says nothing was sent.
 *  12. The Kentucky insurance job: $0 due at signing, e-mail e-sign off
 *      (the real KY gate), the deal page preview carries the KY notices.
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
// gstatic or the self-hosted copy (#2155): the CRM now imports the latter.
const SDK_URL = /^(?:https:\/\/www\.gstatic\.com\/firebasejs|https?:\/\/[^/]+\/assets\/vendor\/firebase)\/[\d.]+\/firebase-[a-z-]+\.js$/;
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
    await page.evaluate(() => { const s = document.getElementById('nbd-send-preview'); if (s) s.remove(); });

    // ── wave 2: photos, documents, the e-sign preview, the estimate builder ──
    console.log('7. the customer card shows the sample photos');
    await waitFor(page, () => document.querySelectorAll('#photoList img').length >= 4, null, 20000);
    const pics = await page.evaluate(() => [...document.querySelectorAll('#photoList img')].map((i) => ({ src: i.src, w: i.naturalWidth })));
    ok('Jordan\'s photo grid shows the sample drawings, served from this origin', pics.length >= 4 && pics.every((p) => p.src.indexOf(ORIGIN + '/pro/demo-sdk/media/') === 0), JSON.stringify(pics));
    await waitFor(page, () => [...document.querySelectorAll('#photoList img')].every((i) => i.complete && i.naturalWidth > 0), null, 15000).catch(() => {});
    ok('…and every one actually loaded', (await page.evaluate(() => [...document.querySelectorAll('#photoList img')].every((i) => i.naturalWidth > 0))));

    // Generate a document the way the rep does: the Documents tile → the
    // pre-flight sheet → Generate → the viewer.
    async function generateDoc(type) {
      await page.evaluate(() => { const v = document.getElementById('nbd-doc-viewer-overlay'); if (v) v.classList.remove('open'); });
      await page.locator('[data-action="generateCustomerDoc"][data-doc-type="' + type + '"]').evaluate((el) => el.click());
      await page.waitForSelector('.dpf-card', { timeout: 20000 });
      const missing = await page.evaluate(() => [...document.querySelectorAll('.dpf-card .missing')].map((w) => w.getAttribute('data-field-wrap')));
      await page.evaluate(() => { const s = document.getElementById('nbdv-iframe'); if (s) s.srcdoc = ''; });
      await page.locator('.dpf-card button', { hasText: /Generate/i }).last().click();
      await page.waitForSelector('#nbd-doc-viewer-overlay.open', { timeout: 20000 });
      await waitFor(page, () => ((document.getElementById('nbdv-iframe') || {}).srcdoc || '').length > 2000, null, 20000);
      return { missing, html: await page.evaluate(() => document.getElementById('nbdv-iframe').srcdoc) };
    }
    const textOf = (h) => String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ');

    console.log('8. generate the contract, the estimate and the inspection report');
    const contract = await generateDoc('contract');
    ok('the contract pre-flight is complete from the sample data (nothing to type)', contract.missing.length === 0, contract.missing.join(','));
    const ct = textOf(contract.html);
    ok('the contract is the sample company\'s, for Jordan Avery, with the estimate\'s line items', /Sample Roofing Co\./.test(ct) && /Jordan Avery/.test(ct) && /Preferred package/.test(ct) && /\$17,160/.test(ct), ct.slice(0, 600));
    ok('a Kentucky insurance contract: nothing due at signing, the KRS notices, no NBD identity', /nothing is due at signing/i.test(ct) && /367\.62/.test(ct) && !/No Big Deal|1162011|181382/.test(contract.html));
    const proposal = await generateDoc('proposal');
    ok('the estimate (proposal) renders with the sample photos as real images', /Sample Roofing Co\./.test(textOf(proposal.html)) && /\/pro\/demo-sdk\/media\/[\w-]+\.svg/.test(proposal.html) && !/object Object/.test(proposal.html));
    const report = await generateDoc('inspectionHomeowner');
    const rt = textOf(report.html);
    ok('the inspection report renders from the sample photos', (report.html.match(/\/pro\/demo-sdk\/media\/[\w-]+\.svg/g) || []).length >= 4 && /Jordan Avery/.test(rt) && /Inspection/i.test(rt));
    ok('no document promises a lifetime warranty', ![contract, proposal, report].some((d) => /lifetime workmanship/i.test(textOf(d.html))));

    console.log('9. e-sign from the viewer: a read-only preview, nothing sent');
    // The real (contract) document goes back on screen for the send.
    await generateDoc('contract');
    page.once('dialog', (d) => d.accept('jordan.avery@example.com'));
    await page.locator('#nbdv-sign-btn').click(); // a real click: the strip must not cover the viewer's row
    await page.waitForSelector('#nbd-send-preview[data-kind="sign-request"]', { timeout: 15000 });
    const sp1 = await page.evaluate(() => {
      const s = document.getElementById('nbd-send-preview');
      const f = s.querySelector('iframe');
      return { text: s.innerText, sandbox: f && f.getAttribute('sandbox'), doc: f ? f.srcdoc : '' };
    });
    ok('the preview says nothing was sent and shows the email (to Jordan, subject)', /Nothing was sent/.test(sp1.text) && /Jordan Avery <jordan\.avery@example\.com>/.test(sp1.text) && /Please sign: Roofing Contract from Sample Roofing Co\./.test(sp1.text), sp1.text.slice(0, 500));
    ok('…and the page Jordan would open, read-only (sandboxed, no scripts)', sp1.sandbox === '' && /ROOFING CONTRACT/i.test(sp1.doc) && !/<script/i.test(sp1.doc));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    await page.waitForSelector('#nbd-send-preview', { state: 'detached', timeout: 5000 });

    console.log('10. open the dashboard and build a retail estimate in the V3 builder');
    await page.evaluate(() => { const v = document.getElementById('nbd-doc-viewer-overlay'); if (v) v.classList.remove('open'); window.location.href = '/pro/dashboard.html'; });
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 30000 });
    await waitFor(page, () => Array.isArray(window._leads) && window._leads.length >= 20 && typeof window.startNewEstimate === 'function');
    // Every Next below is a REAL click: the Sample account strip used to sit
    // on top of the builder's bottom bar and swallow it.
    async function buildEstimate(leadId, perSq) {
      await page.evaluate((id) => window.startNewEstimate(id), leadId);
      await page.locator('#est-new-chooser button', { hasText: 'Start Blank' }).click();
      await waitFor(page, () => window.EstimateV3 && window.EstimateV3._test.ui.step === 'measure', null, 20000);
      await page.locator('#v2rawSqft').fill('2600');
      await page.locator('#v2rawSqft').dispatchEvent('change');
      const out = {};
      for (let i = 0; i < 14; i++) {
        const s = await page.evaluate(() => window.EstimateV3._test.ui.step);
        if (s === 'package') {
          await page.locator('#estV2Modal [data-v3-act="preset"]').first().click();
          if (perSq) await page.locator('#estV2Modal #v2modePerSq').click();
          await page.locator('#estV2Modal [data-v3-act="tier"][data-v3-val="better"]').click();
          out.pkg = await page.evaluate(() => document.querySelector('#estV2Modal .v3-pkg').innerText);
        }
        if (s === 'review') out.deposit = await page.evaluate(() => document.getElementById('v2deposit').innerText);
        if (s === 'finish') break;
        await page.locator('#estV2Modal .v3-next').click();
      }
      out.step = await page.evaluate(() => window.EstimateV3._test.ui.step);
      out.state = await page.evaluate(() => { const s = window.EstimateV2UI.getState(); return { tier: s.tier, mode: s.mode, jobMode: s.jobMode, scope: s.scope.length }; });
      return out;
    }
    const cash = await buildEstimate('sample-lead-13', true);
    ok('the V3 builder walked every step to Finish with real taps', cash.step === 'finish' && cash.state.scope > 0, JSON.stringify(cash.state));
    const pk = cash.pkg || '';
    ok('packages: Standard / Preferred / Elite, each with GAF System Plus and "sample price"', /STANDARD[\s\S]*PREFERRED[\s\S]*ELITE/i.test(pk) && (pk.match(/System Plus · sample price/g) || []).length === 3, pk);
    ok('per-square pricing shows all three packages side by side', (pk.match(/\$\d[\d,]*/g) || []).length >= 3 && !/Tap to price/.test(pk), pk);
    ok('retail job: the deposit shows (50% due at signing)', /50% deposit of \$[\d,]+ due at signing/.test(cash.deposit || ''), cash.deposit);
    const savedId = await page.evaluate(() => window.EstimateV2UI.save());
    const saved = await page.evaluate(async (id) => {
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const s = await F.getDoc(F.doc(F.getFirestore(), 'estimates', id));
      return s.exists() ? { leadId: s.data().leadId, tier: s.data().tier } : null;
    }, savedId);
    ok('Save writes the estimate to the in-browser store', !!saved && saved.leadId === 'sample-lead-13', JSON.stringify(saved));

    console.log('11. Send for Signature and Send to homeowner: previews, nothing sent');
    await page.locator('#estV2Modal [data-v3-act="more"]').first().click().catch(() => {});
    await page.locator('#v2signBtn').click();
    await page.waitForSelector('#nbd-send-preview[data-kind="esign-envelope"]', { timeout: 15000 });
    const sp2 = await page.evaluate(() => document.getElementById('nbd-send-preview').innerText);
    ok('e-sign preview: to Caleb, the contract subject, the package, total and deposit', /Nothing was sent/.test(sp2) && /Caleb Ross <caleb\.ross@example\.com>/.test(sp2) && /Preferred/.test(sp2) && /50% deposit/.test(sp2), sp2.slice(0, 700));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    const signStatus = await page.evaluate(() => (document.getElementById('v2signStatus') || {}).textContent || '');
    ok('the builder\'s own status line says it was not sent', /In your real account this would/.test(signStatus), signStatus);
    await page.locator('#estV2Modal [data-action="send-to-homeowner"]').first().click();
    await page.waitForSelector('#nbd-send-preview[data-kind="deal-link"]', { timeout: 20000 });
    const sp3 = await page.evaluate(() => { const s = document.getElementById('nbd-send-preview'); const f = s.querySelector('iframe'); return { text: s.innerText, sandbox: f && f.getAttribute('sandbox'), doc: f ? f.srcdoc : '' }; });
    ok('deal-link preview: the text Caleb would get and his deal page, read-only', /Hi Caleb!/.test(sp3.text) && sp3.sandbox === '' && /Sample Roofing Co\./.test(sp3.doc) && /Due at signing: <strong>\$[1-9]/.test(sp3.doc), sp3.text.slice(0, 400));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    await page.evaluate(() => window.closeEstimateV2Builder());

    console.log('12. the Kentucky insurance job: nothing due at signing');
    const ins = await buildEstimate('sample-lead-01', false);
    ok('Jordan\'s estimate is an insurance job that reached Finish', ins.step === 'finish' && ins.state.jobMode === 'insurance', JSON.stringify(ins.state));
    ok('Kentucky insurance: "Due at signing $0", nothing is due at signing', /Due at signing\s*\$0\b/.test(ins.deposit || '') && /Nothing is due at signing/.test(ins.deposit || ''), ins.deposit);
    ok('e-mail e-sign is off for a Kentucky insurance job (the real KY gate)', await page.evaluate(() => document.getElementById('v2signBtn').classList.contains('v2-ky-off')));
    await page.locator('#estV2Modal [data-action="send-to-homeowner"]').first().click();
    await page.waitForSelector('#nbd-send-preview[data-kind="deal-link"]', { timeout: 20000 });
    const kyDeal = await page.evaluate(() => (document.querySelector('#nbd-send-preview iframe') || {}).srcdoc || '');
    ok('Jordan\'s deal page preview: $0 due at signing and the Kentucky notices', /Due at signing: <strong>\$0(\.00)?<\/strong>/.test(kyDeal) && !/Due at signing: <strong>\$[1-9]/.test(kyDeal) && /367\.62/.test(kyDeal));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    await page.evaluate(() => window.closeEstimateV2Builder());
    const previews = await page.evaluate(() => (window.__NBD_DEMO__.previews || []).map((p) => p.callable));
    // (the viewer's sign request was on the customer page, checked in step 9)
    ok('every send on the dashboard went to a preview (one envelope, two deal links)', previews.join(',') === 'sendEstimateEnvelope,createDealAcceptToken,createDealAcceptToken', previews.join(','));

    // ── wave 3: the door-knocking map, Storm Center, Agent inbox, Ask Joe ──
    console.log('13. Door-to-Door: the offline sample map, the storm swath and the knocks');
    await page.evaluate(() => window.goTo('d2d'));
    await waitFor(page, () => window._D2DState && window._D2DState.d2dMap && (window._D2DState.knocks || []).length >= 60, null, 30000);
    await waitFor(page, () => document.querySelectorAll('#d2dMap .nbd-demo-tile svg').length > 0, null, 15000);
    // The territory and the fit to it land after the territories load.
    await waitFor(page, () => {
      const c = window._D2DState.d2dMap.getCenter();
      return Math.abs(c.lat - 39.075) < 0.02 && Math.abs(c.lng + 84.447) < 0.02 &&
        [...document.querySelectorAll('#d2dMap path')].some((p) => p.getAttribute('stroke') === '#BD5728');
    }, null, 20000).catch(() => {});
    const d2d =await page.evaluate(() => {
      const m = window._D2DState.d2dMap, c = m.getCenter(), sw = window.NBD_DEMO_BASEMAP;
      return {
        tiles: document.querySelectorAll('#d2dMap .nbd-demo-tile svg').length,
        realTiles: [...document.querySelectorAll('#d2dMap img')].map((i) => i.src).filter((s) => /^https?:/.test(s) && s.indexOf(location.origin) !== 0),
        attribution: (document.querySelector('#d2dMap .leaflet-control-attribution') || {}).textContent || '',
        knocks: window._D2DState.knocks.length, zoom: m.getZoom(), center: [c.lat, c.lng],
        swathDrawn: [...document.querySelectorAll('#d2dMap path')].some((p) => p.getAttribute('stroke') === '#BD5728' && /6,4|6 4/.test(p.getAttribute('stroke-dasharray') || '')),
        pins: document.querySelectorAll('#d2dMap .leaflet-marker-icon').length,
        houses: sw ? sw.houses().length : 0
      };
    });
    ok('the D2D map draws the offline sample map (SVG tiles), no tile from another site', d2d.tiles > 0 && d2d.realTiles.length === 0 && /Sample map: invented streets/.test(d2d.attribution), JSON.stringify(d2d));
    ok('the sample knocks load (the seed\'s week of door knocking)', d2d.knocks >= 60 && d2d.pins > 0, JSON.stringify(d2d));
    ok('it opens on the story\'s storm: the hail swath territory drawn, centred on Fort Thomas north', d2d.swathDrawn && d2d.zoom >= 13 && Math.abs(d2d.center[0] - 39.075) < 0.02 && Math.abs(d2d.center[1] + 84.447) < 0.02, JSON.stringify(d2d));
    // House level: the sample streets, roofs and names.
    const free = await page.evaluate(() => {
      const st = window._D2DState, knocked = new Set(st.knocks.map((k) => String(k.address).split(',')[0]));
      return window.NBD_DEMO_BASEMAP.houses().find((x) => x.street === 'Placeholder St' && !knocked.has(x.address) && x.number > 320);
    });
    // The map's own "show me the storm" fit lands a moment after it opens;
    // keep asking for house level until it holds.
    await waitFor(page, (h) => {
      const m = window._D2DState.d2dMap;
      if (m.getZoom() !== 19 || m.getCenter().distanceTo([h.lat, h.lng]) > 5) m.setView([h.lat, h.lng], 19, { animate: false });
      return m.getZoom() === 19 && document.querySelectorAll('#d2dMap .nbd-demo-tile svg rect[transform]').length > 4;
    }, free, 20000).catch(() => {});
    await page.waitForTimeout(400);
    const hl = await page.evaluate(() => ({
      roofs: document.querySelectorAll('#d2dMap .nbd-demo-tile svg rect[transform]').length,
      labels: [...document.querySelectorAll('#d2dMap .nbd-demo-lbl')].map((l) => l.textContent)
    }));
    ok('at house level the sample map draws the houses and the street names', hl.roofs > 4 && hl.labels.includes('Placeholder St'), JSON.stringify(hl).slice(0, 300));
    // Log a knock the way a rep does: tap the house on the map.
    const box = await page.locator('#d2dMap').boundingBox();
    const pt = await page.evaluate((h) => { const p = window._D2DState.d2dMap.latLngToContainerPoint([h.lat, h.lng]); return { x: p.x, y: p.y }; }, free);
    await page.mouse.click(box.x + pt.x, box.y + pt.y);
    await page.waitForSelector('#d2d-quick-knock-overlay.open', { timeout: 15000 });
    await waitFor(page, () => { const b = document.getElementById('d2d-addr-badge'); return b && /verified|likely/.test(b.dataset.state || ''); }, null, 15000);
    const qk = await page.evaluate(() => ({ addr: document.getElementById('d2d-qk-address').value, badge: document.getElementById('d2d-addr-badge').dataset.state }));
    ok('the tapped door resolves to its sample address (offline geocoder, no request)', qk.addr.indexOf(free.address) === 0, JSON.stringify({ qk, free: free.address }));
    if (qk.badge !== 'verified') await page.locator('#d2d-addr-confirm-chk').check();
    await page.locator('#d2d-quick-knock-overlay [data-dispo="storm_damage"]').click();
    await page.locator('#d2d-qk-save').click();
    await waitFor(page, (a) => (window._D2DState.knocks || []).some((k) => String(k.address).indexOf(a) === 0 && k.disposition === 'storm_damage'), free.address, 15000);
    ok('the knock saved to the in-browser store and shows on the map', true);
    const hail = await page.evaluate(async () => { const r = await window.D2D.showHail(); return { ok: r && r.ok, hits: (r && r.hits || []).length, swath: !!(r && r.hits && r.hits[0] && r.hits[0].polygon) }; });
    ok('Hail: the sample hail reports (and the swath) come back with no request', hail.ok && hail.hits >= 5 && hail.swath, JSON.stringify(hail));
    const lsr = await page.evaluate(async () => { const r = await window.fetch('/api/storm-report?lat=39.075&lon=-84.447'); return { status: r.status, demo: r.headers.get('X-NBD-Demo'), n: ((await r.json()).events || []).length }; });
    ok('the Storms layer\'s /api/storm-report is answered from sample data, never the function', lsr.status === 200 && lsr.demo === 'sample-offline' && lsr.n >= 5, JSON.stringify(lsr));

    console.log('14. Storm Center: the sample alert and the story\'s storm zone');
    await page.evaluate(() => window.goTo('storm'));
    await waitFor(page, () => /Severe Thunderstorm Warning/.test((document.getElementById('view-storm') || {}).innerText || '') && document.querySelectorAll('#storm-map .nbd-demo-tile svg').length > 0, null, 30000);
    const sc = await page.evaluate(() => ({ text: document.getElementById('view-storm').innerText, zones: JSON.parse(localStorage.getItem('nbd_storm_zones') || '[]').map((z) => z.name) }));
    ok('Storm Center shows the sample alert, marked as sample, on the offline map', /Severe Thunderstorm Warning/.test(sc.text) && /\(sample\)/.test(sc.text), sc.text.slice(0, 400));
    ok('…and the story\'s storm zone (Fort Thomas north)', sc.zones.some((n) => /Fort Thomas north \(sample\)/.test(n)), JSON.stringify(sc.zones));
    await page.locator('#view-storm [data-storm-action="createZone"]').first().click();
    await waitFor(page, () => JSON.parse(localStorage.getItem('nbd_storm_zones') || '[]').length >= 2, null, 10000);
    ok('Create Zone from the sample alert works (a second zone)', true);

    console.log('15. Agent inbox: approve a bot draft with one tap, nothing sent');
    await page.evaluate(() => { window.goTo('home'); window.NBDAgentInbox.open(); });
    await waitFor(page, () => /6 waiting/.test((document.getElementById('aiCount') || {}).textContent || '') && !!document.getElementById('aiSend-sample-inbox-01'), null, 20000);
    const inbox = await page.evaluate(() => document.getElementById('aiOverlay').innerText);
    ok('the inbox shows the sample company\'s own bots (no NBD bot)', /Follow-up helper/.test(inbox) && /Office helper/.test(inbox) && !/Marcus|Quinn|Tucker|NBD Ops/.test(inbox), inbox.slice(0, 600));
    const urlBefore = page.url();
    await page.locator('#aiSend-sample-inbox-01').click(); // "Text from my phone": ONE tap
    await page.waitForSelector('#nbd-send-preview[data-kind="agent-text"]', { timeout: 15000 });
    const sp4 = await page.evaluate(() => document.getElementById('nbd-send-preview').innerText);
    ok('one tap shows "Nothing was sent" with the text and who it was for', /Nothing was sent/.test(sp4) && /Jordan Avery/.test(sp4) && /three roof options/.test(sp4) && /Follow-up helper/.test(sp4), sp4.slice(0, 500));
    ok('…the page did not navigate to sms: (no Messages app)', page.url() === urlBefore, page.url());
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    const filed = await page.evaluate(async () => {
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = F.getFirestore();
      const it = (await F.getDoc(F.doc(db, 'agent_inbox', 'sample-inbox-01'))).data();
      const n = (await F.getDocs(F.query(F.collection(db, 'notes'), F.where('leadId', '==', 'sample-lead-01')))).docs.map((d) => d.data().text).filter((t) => /Nothing was sent/.test(t)).length;
      return { status: it.status, result: it.result, note: n, gone: !document.getElementById('aiItem-sample-inbox-01') };
    });
    ok('the draft is filed (approved, not sent) with a note on Jordan\'s card saying so', filed.status === 'approved' && filed.result === 'sample:not-sent' && filed.note === 1 && filed.gone, JSON.stringify(filed));
    await page.locator('#aiOverlay [data-ai-act="mail"]').first().click();
    const mailNote = await page.evaluate(() => (window.__NBD_DEMO__.notices.slice(-1)[0] || {}).message || '');
    ok('"Open in Mail" does not open the visitor\'s Mail app', /opens your Mail app/.test(mailNote) && page.url() === urlBefore, mailNote);
    await page.locator('#aiOverlay [data-ai-act="mailsent"]').first().click();
    await page.waitForSelector('#nbd-send-preview[data-kind="agent-email"]', { timeout: 15000 });
    const sp5 = await page.evaluate(() => document.getElementById('nbd-send-preview').innerText);
    ok('the email draft\'s Mark sent shows its own "Nothing was sent" sheet', /Nothing was sent/.test(sp5) && /Caleb Ross/.test(sp5) && /Your three roof options/.test(sp5), sp5.slice(0, 400));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    await page.locator('#aiOverlay [data-ai-act="approve"][data-ai-id="sample-inbox-03"]').click();
    const task = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 400));
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      return (await F.getDocs(F.collection(F.getFirestore(), 'leads', 'sample-lead-10', 'tasks'))).docs.map((d) => d.data()).filter((t) => t.source === 'agent_inbox').length;
    });
    ok('a bot reminder goes onto the customer as a task with one tap (Add to CRM)', task === 1, task);
    await page.evaluate(() => window.NBDAgentInbox.close());

    console.log('16. Ask Joe: sample answers, no AI model');
    await page.evaluate(() => window.goTo('joe'));
    await page.locator('[data-fn="joeQuick"][data-arg="What does my pipeline look like right now?"]').click();
    await waitFor(page, () => /Sample pipeline right now/.test((document.getElementById('joeMessages') || {}).innerText || ''), null, 15000);
    await page.locator('#joeInput').fill('What is due at signing on a Kentucky insurance job?');
    await page.locator('#joeSendBtn').click();
    await waitFor(page, () => /nothing is due at signing/i.test((document.getElementById('joeMessages') || {}).innerText || ''), null, 15000);
    const joe = await page.evaluate(() => ({ text: document.getElementById('joeMessages').innerText, n: window.__NBD_DEMO__.joeAnswers || 0, demoProxy: !!(window.callClaude && window.callClaude.__nbdDemo) }));
    ok('Ask Joe answers the starter question from the sample data, labelled a sample answer', /active jobs/.test(joe.text) && (joe.text.match(/No AI model was called/g) || []).length >= 2, joe.text.slice(-600));
    ok('…and the Kentucky rule: nothing due at signing on an insurance job', /nothing is due at signing/i.test(joe.text) && !/NBD Pledge|lifetime/i.test(joe.text));
    const foot = await page.evaluate(() => {
      const v = document.getElementById('view-joe');
      return { text: v ? v.innerText : '', key: !!(v && v.querySelector('[data-fn="clearJoeKey"]')) };
    });
    ok('Ask Joe\'s footnote names no model and offers no key change (it says sample answers)',
      /Sample answers/.test(foot.text) && !/Claude|Haiku|Change Key/i.test(foot.text) && !foot.key, foot.text.slice(-300));
    ok('the sample AI proxy answered (the real claude-proxy.js was never loaded)', joe.n >= 2 && joe.demoProxy && !srv.log.some((e) => /\/js\/claude-proxy\.js$/.test(e.path)) && srv.log.some((e) => e.path === '/pro/demo-sdk/claude-proxy.js'), JSON.stringify({ n: joe.n, demoProxy: joe.demoProxy }));
    const offlineUsed = await page.evaluate(() => (window.__NBD_DEMO__.offlineAnswers || []).map((a) => a.url.replace(/\?.*$/, '')));
    ok('the maps\' weather / geocoder / storm-report reads were answered offline (the path was exercised)', offlineUsed.some((u) => /nominatim/.test(u)) && offlineUsed.some((u) => /api\.weather\.gov/.test(u)) && offlineUsed.some((u) => /storm-report/.test(u)), JSON.stringify([...new Set(offlineUsed)]));

    // ── wave 4: Ask Joe layout, money, invoices, pay links, production, Settings ──
    console.log('17. Ask Joe: the Sample account strip never covers the input (desktop and phone)');
    // Box overlap AND a hit test across the input and the Send button: no tap
    // there may land on the Sample account strip or its toast. (The CRM's own
    // toasts and the phone's bottom nav are the real app's layout, not ours.)
    const joeBoxes = () => page.evaluate(() => {
      const r = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const misses = [];
      const tapsLand = (id) => {
        const el = document.getElementById(id), b = el.getBoundingClientRect(), y = (b.top + b.bottom) / 2;
        return [0.1, 0.5, 0.9].every((f) => {
          const hit = document.elementFromPoint(b.left + (b.right - b.left) * f, y);
          const good = !!hit && !(hit.closest && hit.closest('#nbd-demo-strip, .nbd-demo-toast'));
          if (!good) misses.push(id + '@' + f + '→' + (hit ? hit.tagName + '#' + hit.id + '.' + String(hit.className).slice(0, 40) : 'none'));
          return good;
        });
      };
      // A visitor scrolls the input into view first (the phone pane can be taller than the screen).
      document.getElementById('joeInput').scrollIntoView({ block: 'center' });
      return { input: r('joeInput'), send: r('joeSendBtn'), strip: r('nbd-demo-strip'), inputTaps: tapsLand('joeInput'), sendTaps: tapsLand('joeSendBtn'), misses };
    });
    const hits = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
    const jd = await joeBoxes();
    ok('desktop: the strip clears the Ask Joe input and Send button (boxes and taps)', !hits(jd.strip, jd.input) && !hits(jd.strip, jd.send) && jd.inputTaps && jd.sendTaps, JSON.stringify(jd));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const jp = await joeBoxes();
    // On a phone the pane has no room to reserve: the strip moves up under the app bar.
    ok('phone (390 wide): the strip moves to the top while Ask Joe is open and clears the input and Send button', jp.strip.t < 100 && !hits(jp.strip, jp.input) && !hits(jp.strip, jp.send) && jp.inputTaps && jp.sendTaps, JSON.stringify(jp));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);

    console.log('18. Money: collected money only, from the sample payments');
    await page.evaluate(() => window.goTo('money'));
    await waitFor(page, () => /COLLECTED VS SPENT/i.test((document.getElementById('view-money') || {}).innerText || ''), null, 20000);
    await page.waitForTimeout(800);
    const money = await page.evaluate(async () => {
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const year = new Date().getFullYear();
      const s = await F.getDocs(F.collection(F.getFirestore(), 'invoices'));
      let cents = 0;
      s.docs.forEach((d) => (d.data().payments || []).forEach((p) => { const at = p.at && p.at.toDate ? p.at.toDate() : new Date(p.at); if (at.getFullYear() === year) cents += Math.round(p.amount * 100); }));
      return { text: document.getElementById('view-money').innerText, cents, year };
    });
    const cashM = new RegExp('CASH\\W+' + money.year + '[^$]*?COLLECTED\\s*\\$([\\d,]+)', 'i').exec(money.text);
    ok('the Money view labels revenue as collected money only (payments by payment date)', /collected money only/i.test(money.text) && /COLLECTED/.test(money.text), money.text.slice(0, 300));
    ok('…and its collected total is exactly the sample payments dated this year', !!cashM && Number(cashM[1].replace(/,/g, '')) * 100 === money.cents && money.cents > 0, JSON.stringify({ shown: cashM && cashM[1], cents: money.cents }));

    console.log('19. Create an invoice from an estimate: the real deposit rule, a sample pay link; a Kentucky insurance job holds it');
    async function createInvoice(leadId) {
      await page.evaluate((id) => { window.InvoicePipeline.createInvoiceUI(id); }, leadId);
      await page.locator('#nbd-inv-create').click();
      await page.waitForSelector('#nbd-inv-detail-host .invoice-detail', { timeout: 20000 });
      await page.waitForTimeout(1500); // the pay-link attempt runs after the detail opens
      const r = await page.evaluate(async (id) => {
        const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const s = await F.getDocs(F.query(F.collection(F.getFirestore(), 'invoices'), F.where('leadId', '==', id)));
        const d = s.docs.map((x) => x.data()).sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0];
        return { total: d.total, deposit: d.depositAmount, link: d.stripePaymentLink, ky: d.kyInsuranceHold, terms: d.terms, created: d.createdAt && typeof d.createdAt.toDate === 'function', detail: document.getElementById('nbd-inv-detail-host').innerText };
      }, leadId);
      await page.evaluate(() => { const m = document.getElementById('nbd-invoice-detail-modal'); if (m) m.remove(); });
      return r;
    }
    const cInv = await createInvoice('sample-lead-13');
    ok('a retail invoice: 50% deposit at signing from the real rule, and a SAMPLE pay link for it (never Stripe)',
      cInv.total >= 2000 && cInv.deposit === Math.round(cInv.total * 0.5 / 25) * 25 && /50% deposit of \$[\d,]+ due at signing/.test(cInv.terms) &&
      new RegExp('^' + ORIGIN.replace(/[.]/g, '\\.') + '/pro/explore/sample-pay\\?invoice=[\\w-]+&amount=\\d+\\.\\d\\d$').test(cInv.link || ''), JSON.stringify(cInv).slice(0, 400));
    ok('…the new invoice\'s dates are real Timestamps (no "Invalid Date" on the invoice)', cInv.created && !/Invalid Date/.test(cInv.detail), cInv.detail.slice(0, 300));
    const kInv = await createInvoice('sample-lead-01');
    const heldAns = await page.evaluate(() => (window.__NBD_DEMO__.endpointAnswers || []).filter((a) => a.fn === 'createStripePaymentLink' && a.held).length);
    ok('Jordan\'s Kentucky insurance invoice: $0 at signing, the hold note, and NO pay link (the server answer refused it)',
      kInv.deposit === 0 && kInv.ky === true && !kInv.link && /nothing is due at signing/i.test(kInv.detail) && heldAns >= 1, JSON.stringify({ deposit: kInv.deposit, link: kInv.link, heldAns }));

    console.log('20. Settings: "available in your real account" cards, never wired');
    await page.evaluate(() => window.goTo('settings'));
    await waitFor(page, () => !!document.getElementById('stab-panel-billing') && typeof window.switchSettingsTab === 'function', null, 20000);
    const sealed = {};
    for (const t of ['billing', 'team', 'access', 'bots', 'ai-texting']) {
      await page.evaluate((x) => window.switchSettingsTab(x), t);
      await page.waitForTimeout(300);
      sealed[t] = await page.evaluate((x) => {
        const p = document.getElementById('stab-panel-' + x);
        const card = p.querySelector(':scope > .nbd-demo-real-card');
        const live = [...p.querySelectorAll('button, input, select, textarea, a')].filter((el) => !el.closest('.nbd-demo-real-card') && el.getClientRects().length > 0);
        return { card: card ? card.innerText : '', visibleControls: live.length };
      }, t);
    }
    ok('billing, team, sign-in, Bots & API keys and AI texting each show the card, with none of their own controls reachable',
      Object.values(sealed).every((s) => /Available in your real account/i.test(s.card) && s.visibleControls === 0), JSON.stringify(sealed).slice(0, 600));
    await page.evaluate(() => window.switchSettingsTab('notifications'));
    const notif = await page.evaluate(() => ({ card: (document.querySelector('#stab-panel-notifications > .nbd-demo-real-card') || {}).innerText || '', push: document.getElementById('chPush').disabled && !document.getElementById('chPush').checked }));
    ok('notifications: a push note on top, the push channel switched off', /Push notifications/.test(notif.card) && notif.push, JSON.stringify(notif));
    await page.evaluate(() => window.switchSettingsTab('profile'));
    await page.locator('#stab-panel-profile [data-fn="openLeadImport"]').click();
    await page.waitForSelector('#nbd-demo-real-sheet', { timeout: 10000 });
    const imp = await page.evaluate(() => ({ text: document.getElementById('nbd-demo-real-sheet').innerText, importer: [...document.querySelectorAll('.modal-bg.open, .di-overlay, #leadImportModal, [id*="import" i].open')].filter((e) => e.getClientRects().length).map((e) => e.id || e.className) }));
    ok('Import leads opens the card, not the importer', /Import your customers/.test(imp.text) && imp.importer.length === 0, JSON.stringify(imp));
    await page.locator('#nbd-demo-real-sheet [data-nbd-real="close"]').click();

    console.log('21. Customer card: record a payment against the fake store');
    async function openCustomer(id, name) {
      await page.evaluate((x) => { window.location.href = '/pro/customer.html?id=' + x; }, id);
      await page.waitForURL(new RegExp('/pro/explore/customer\\?id=' + id + '$'), { timeout: 30000 });
      await waitFor(page, (n) => document.body.innerText.indexOf(n) !== -1 && /Record payment/.test((document.getElementById('invoiceList') || {}).innerText || ''), name, 30000);
    }
    await openCustomer('sample-lead-21', 'Felix Grant');
    const before21 = await page.evaluate(() => document.getElementById('invoiceList').innerText);
    ok('Felix\'s invoice: part paid (the 50% deposit), the balance owed', /PARTIAL/i.test(before21) && /\$6,900\.00 owed/.test(before21), before21.slice(0, 300));
    await page.locator('#invoiceList [data-action="NBDCustomerInvoices.markPaid"]').first().click();
    await page.waitForSelector('#nbd-markpaid-modal #nbd-mp-amount', { timeout: 20000 });
    const defAmt = await page.locator('#nbd-mp-amount').inputValue();
    await page.locator('#nbd-mp-ref').fill('1101');
    await page.locator('#nbd-mp-save').click();
    await waitFor(page, () => /\bPAID\b/i.test(document.getElementById('invoiceList').innerText) && !/owed/.test(document.getElementById('invoiceList').innerText), null, 20000).catch(() => {});
    const paid21 = await page.evaluate(async () => {
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = F.getFirestore();
      const inv = (await F.getDoc(F.doc(db, 'invoices', 'sample-inv-01'))).data();
      const notes = (await F.getDocs(F.query(F.collection(db, 'notes'), F.where('leadId', '==', 'sample-lead-21')))).docs.map((d) => d.data()).filter((n) => n.type === 'payment');
      return { status: inv.status, bal: inv.balanceDue, n: inv.payments.length, last: inv.payments[inv.payments.length - 1], notes: notes.length, list: document.getElementById('invoiceList').innerText };
    });
    ok('Record Payment defaults to the balance and saves it: the invoice is paid, two payments, a payment note on the timeline',
      defAmt === '6900.00' && paid21.status === 'paid' && paid21.bal === 0 && paid21.n === 2 && paid21.last.method === 'check' && paid21.last.amount === 6900 && paid21.notes >= 2 && /TOTAL OWED\s*\$0\.00/i.test(paid21.list),
      JSON.stringify({ defAmt, status: paid21.status, bal: paid21.bal, n: paid21.n, notes: paid21.notes }));

    console.log('22. Pay links are samples and say so; Send balance shows "Nothing was sent"');
    await openCustomer('sample-lead-19', 'Ben Albright');
    const benPay = await page.evaluate(() => [...document.querySelectorAll('#invoiceList a.doc-btn')].map((a) => a.href));
    ok('Ben\'s invoice offers a Pay link, and it is a sample page in the sample account', benPay.length === 1 && benPay[0] === ORIGIN + '/pro/explore/sample-pay?invoice=sample-inv-03&amount=7700.00', JSON.stringify(benPay));
    const payPage = await ctx.newPage();
    await payPage.goto(benPay[0]);
    const payText = await payPage.evaluate(() => ({ text: document.body.innerText, disabled: document.querySelector('.xe-pay-btn').disabled, inputs: document.querySelectorAll('input, form').length }));
    ok('the pay page says it is a sample, shows the amount, and takes no card', /This is a sample\./.test(payText.text) && /\$7,700\.00 \(sample\)/.test(payText.text) && payText.disabled && payText.inputs === 0, payText.text.slice(0, 300));
    await payPage.close();
    await page.locator('#invoiceList [data-action="NBDCustomerInvoices.sendBalance"]').first().click();
    await page.locator('#nbd-send-invoice-modal .nbd-send-method[data-method="sms"]').click();
    await page.waitForSelector('#nbd-send-preview[data-kind="text"]', { timeout: 20000 });
    const benSms = await page.evaluate(() => document.getElementById('nbd-send-preview').innerText);
    ok('Send balance by text: "Nothing was sent", the text to Ben with a fresh SAMPLE pay link for the balance',
      /Nothing was sent/.test(benSms) && /Ben Albright/.test(benSms) && /remaining balance of \$7,700\.00/.test(benSms) && benSms.indexOf('Payment link: ' + ORIGIN + '/pro/explore/sample-pay?invoice=sample-inv-03&amount=7700.00') !== -1, benSms.slice(0, 600));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();
    await page.waitForTimeout(800);
    const benAfter = await page.evaluate(async () => {
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const inv = (await F.getDoc(F.doc(F.getFirestore(), 'invoices', 'sample-inv-03'))).data();
      return { status: inv.status, sms: (window.__NBD_DEMO__.endpointAnswers || []).filter((a) => a.fn === 'sendSMS' && a.refused).length };
    });
    ok('…the invoice is not marked sent (still part paid), and the text was refused, never handed to Messages', benAfter.status === 'partial' && benAfter.sms >= 1 && /\/pro\/explore\/customer/.test(page.url()), JSON.stringify(benAfter));

    console.log('23. Kentucky insurance invoice before the carrier decision: the pay link stays held');
    await openCustomer('sample-lead-16', 'Grace Holm');
    // The customer card's own "open this invoice" path (NBDCustomerInvoices.review).
    await page.evaluate(() => { window.NBDCustomerInvoices.review('sample-inv-07'); });
    await page.waitForSelector('#nbd-inv-detail-host [data-ip-ky-hold]', { timeout: 20000 });
    const gDetail = await page.evaluate(() => document.getElementById('nbd-inv-detail-host').innerText);
    await page.locator('#nbd-inv-detail-host [data-ip-action="createPayLink"]').click();
    await page.waitForTimeout(1500);
    const gAfter = await page.evaluate(async () => {
      const F = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const inv = (await F.getDoc(F.doc(F.getFirestore(), 'invoices', 'sample-inv-07'))).data();
      return { link: inv.stripePaymentLink, held: (window.__NBD_DEMO__.endpointAnswers || []).some((a) => a.invoiceId === 'sample-inv-07' && a.held) };
    });
    ok('Grace\'s invoice: "Nothing is due at signing", the KRS 367.626 hold note, and Create Payment Link is refused (no link)',
      /Nothing is due at signing/.test(gDetail) && /KRS 367\.626/.test(gDetail) && !gAfter.link && gAfter.held, JSON.stringify(gAfter));
    await page.evaluate(() => { const m = document.getElementById('nbd-invoice-detail-modal'); if (m) m.remove(); });

    console.log('24. The production strip and "Send to sub"');
    await openCustomer('sample-lead-17', 'Ezra Lane');
    await waitFor(page, () => /Ridge Line Roofing/.test((document.getElementById('productionPanel') || {}).innerText || ''), null, 20000);
    const prod = await page.evaluate(() => document.getElementById('productionPanel').innerText.replace(/\s+/g, ' '));
    ok('Ezra\'s job card: permit filed, materials ordered, delivery date, the sample sub, a two-day start',
      /PERMIT\s*Filed #BA-2026-0412 \(sample\) · Blue Ash/i.test(prod) && /ORDERED\s*Gulf Eagle Supply/i.test(prod) && /DELIVERY/i.test(prod) && /SUB\s*Ridge Line Roofing \(sample sub\)/i.test(prod) && /7:00 am · 2-day job/.test(prod), prod.slice(0, 400));
    const urlProd = page.url();
    await page.locator('#productionPanel [data-pr-action="sheet"]').first().click();
    await page.locator('#productionPanel [data-pr-action="send-sheet"]').click();
    await page.waitForSelector('#nbd-send-preview[data-kind="share"]', { timeout: 15000 });
    const sheet = await page.evaluate(() => document.getElementById('nbd-send-preview').innerText);
    ok('"Send to sub" shows the job sheet in "Nothing was sent" (no share sheet, no Messages), with no dollar figure',
      /Nothing was sent/.test(sheet) && /JOB SHEET/.test(sheet) && /402 Example Hill Rd/.test(sheet) && !/\$\d/.test(sheet) && page.url() === urlProd, sheet.slice(0, 500));
    await page.locator('#nbd-send-preview [data-nbd-sp="close"]').click();

    // ── the zero-network verdict for the walk ─────────────────────────────
    console.log('verdict');
    const state = await page.evaluate(() => ({ blocked: window.__NBD_DEMO__.blocked.slice(), csp: window.__cspViolations.slice() }));
    ok('the tripwire blocked nothing during the walk (no attempt was made)', state.blocked.length === 0, JSON.stringify(state.blocked));
    // img-src too (wave 3): a map tile from another site would be refused here.
    const connectish = state.csp.filter((v) => /^(connect-src|frame-src|form-action|child-src|worker-src|img-src)$/.test(v.directive));
    ok('the CSP refused no connect/frame/form/image attempt during the walk', connectish.length === 0, JSON.stringify(connectish));
    ok('no request reached the network off-origin', offsite.length === 0, offsite.join('\n'));
    const sdk = seen.filter((r) => SDK_URL.test(r.url));
    ok('the Firebase SDK URLs were requested (the swap was exercised, not skipped)', sdk.length >= 5, sdk.length);
    const sdkNet = sdk.filter((r) => !r.sw);
    ok('every Firebase SDK URL was answered by the demo service worker, never the network', sdkNet.length === 0, sdkNet.map((r) => r.url).join('\n'));
    const vendorSeen = sdk.filter((r) => /\/assets\/vendor\/firebase\//.test(r.url));
    ok('the self-hosted SDK path was requested and answered by the worker (the CRM\'s real imports)', vendorSeen.length >= 3 && vendorSeen.every((r) => r.sw), vendorSeen.length);
    const vendorServed = srv.log.filter((e) => /^\/assets\/vendor\/firebase\//.test(e.path));
    ok('the server never served the real Firebase SDK', vendorServed.length === 0, JSON.stringify(vendorServed.slice(0, 5)));
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
