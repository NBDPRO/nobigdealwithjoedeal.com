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
