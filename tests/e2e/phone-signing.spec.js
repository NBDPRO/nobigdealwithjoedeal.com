// tests/e2e/phone-signing.spec.js — the signing and review pages on a phone.
//
// The 2026-09-25 phone audit (lane "signing") confirmed five defects on the
// pages a homeowner signs on and the rep's photo review, each reproduced at
// 412px (Jo's Android) and 360px:
//   homeowner#2  sign.html showed a contract at PRINT size: 9-10px clause
//                text (the 3-day cancellation notice included) in a 277px
//                column under a 66px blank band.
//   homeowner#3  the signature pad's Clear / Undo were 22px tall.
//   homeowner#6  esign "Next field" silently TICKED a required checkbox the
//                signer was never shown the words of.
//   homeowner#9  Photo Review's chips (the Review Sprint control) were 21px,
//                and the "x/y reviewed" counter was hidden on phones.
//   homeowner#10 the sandbox's per-card arrows, the only touch control that
//                moves a card, were 26x22.
//
// Every assertion here is BEHAVIOURAL: sizes measured with
// getBoundingClientRect, reachability by hit-testing the control's centre
// with elementFromPoint, and actions done with real taps. The pipeline menus
// stayed "green" for months because a test only checked a class name.
//
// The contract is also held to the rule that matters most: the phone layout
// lives only on screen. The record POSTed to submitSignature must be the
// same bytes whichever layout the signer saw — the bytes of a record signed
// with no phone layout code loaded at all — and printing the live phone
// document must produce the same PDF as printing the stored original, on
// Letter and on a page narrow enough for the layout's width query.
//
// homeowner#2's second half (2026-09-25): the rep's doc viewer, where the
// same contract is signed IN PERSON, showed it at print size too. It now
// shares sign.html's phone layout (docs/pro/js/doc-phone-layout.js) and is
// held to the same two rules — plus a third that only it has: html2pdf
// renders the document's own <style> blocks in the rep's page, so what the
// viewer saves, PDFs and prints must be the same bytes at 412/360/1280 as
// with no phone layout code loaded.
//
// Cloud Functions (getSignDocument / submitSignature / getEsignEnvelope /
// submitEsignEnvelope) are mocked with page.route. Tagged @audit so the
// authed emulator job's audit shard runs it.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate } = require('./fixtures/auth');
const { buildContract, measureContract, expectReadableOnPhone, expectPaperOnDesktop, normalizeSigned } = require('./fixtures/generated-contract');

const REPO = path.join(__dirname, '..', '..');
const WIDGET = '/pro/js/signature-widget.js';
const CORP = 'Cross-Origin-Resource-Policy';

// The header Firebase Hosting sends for `pathname`, from firebase.json: every
// matching `headers` rule in order, a later rule overriding an earlier one for
// the same key, matched with superstatic's own configMatcher (the engine the
// hosting emulator runs). Sources are slashed with POSIX rules on purpose:
// superstatic's glob-slasher uses path.join, which on Windows turns '/**' into
// a backslash glob that matches nothing - the reason the Windows hosting
// emulator sends NO firebase.json headers, and why this spec once passed
// locally while production blocked the signature pad.
function firebaseHeader(pathname, key) {
  const { configMatcher } = require('superstatic/lib/utils/patterns');
  const norm = (g) => path.posix.normalize(path.posix.join('/', g));
  const rules = JSON.parse(fs.readFileSync(path.join(REPO, 'firebase.json'), 'utf8')).hosting.headers || [];
  let value;
  for (const r of rules) {
    if (!configMatcher(pathname, r.source ? { ...r, source: norm(r.source) } : r)) continue;
    for (const h of r.headers || []) if (h.key.toLowerCase() === key.toLowerCase()) value = h.value;
  }
  return value;
}

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'https://nobigdealwithjoedeal.com';
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(BASE);
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const PHONES = [412, 360];
const DESKTOP = 1280;

function ctxOpts(width) {
  const o = { baseURL: BASE, viewport: { width, height: 860 }, serviceWorkers: 'block', ...(LOCAL ? { bypassCSP: true } : {}) };
  return width < 1000 ? { ...o, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, userAgent: UA } : o;
}

function fulfillJson(route, body, status) {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  return route.fulfill({ status: status || 200, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// Runs in the page/frame: is `sel`'s centre actually `sel` (not covered)?
// Returns the element's box too, so callers assert size and reach at once.
function probeFn(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const reach = !!hit && (hit === el || el.contains(hit));
  // What is on top instead, so a red run names the cover.
  const by = reach ? '' : (hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + (typeof hit.className === 'string' && hit.className ? '.' + hit.className.trim().split(/\s+/).join('.') : '') : 'nothing');
  return { w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, reach, by };
}

// Draw a stroke on a signature pad inside the document frame the way a
// finger drags across it (page coordinates = frame box + canvas box).
async function drawSignature(p, f, frameEl, role) {
  await f.evaluate((r) => document.querySelector(`[data-nbd-sig="${r}"]`).scrollIntoView({ block: 'center' }), role);
  const fr = await frameEl.boundingBox();
  const c = await f.evaluate((r) => { const b = document.querySelector(`[data-nbd-sig="${r}"] canvas`).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width }; }, role);
  await p.mouse.move(fr.x + c.x + 20, fr.y + c.y + 40);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(fr.x + c.x + 20 + i * ((c.w - 40) / 12), fr.y + c.y + 40 + (i % 3) * 12);
  await p.mouse.up();
}

// Chromium's print of `html` (a fresh 1280 page) on `paper`, minus the
// creation/mod dates and random document ID it stamps on every PDF.
async function pdfOf(browser, html, paper) {
  const ctx = await browser.newContext(ctxOpts(DESKTOP));
  try {
    const p = await ctx.newPage();
    await p.setContent(html, { waitUntil: 'load' });
    const buf = await p.pdf({ ...paper, printBackground: true });
    return buf.toString('latin1').replace(/\/(CreationDate|ModDate) \([^)]*\)/g, '').replace(/\/ID \[<[0-9A-Fa-f]+> <[0-9A-Fa-f]+>\]/g, '');
  } finally { await ctx.close(); }
}

// The papers the live phone document is printed on. Letter is what a real
// print uses, but it lays out 816px wide, where a max-width:600px rule could
// never match — so on Letter alone the sheet's `screen` guard could go and
// nothing would change (a 2026-09-25 review break-test dropped it and every
// test stayed green). A 4in-wide page lays out 384px wide, inside the
// sheet's width: there only `@media screen` keeps the phone layout out of
// the print.
const PAPERS = [['Letter', { format: 'Letter' }], ['4in-wide', { width: '4in', height: '6in' }]];

// The reference record: the same contract signed at 1280 with
// doc-phone-layout.js never loaded, so no phone layout code ran at all (the
// consumers fall back to the document as served). Comparing phone records to
// DESKTOP's alone cannot see a leftover that the add-then-strip round trip
// leaves at EVERY width — desktop runs the same round trip; a 2026-09-25
// review break-test made it leave a <meta> in all three records and every
// test stayed green.
const BARE = 'no phone layout code';
const PHONE_LAYOUT_JS = /\/pro\/js\/doc-phone-layout\.js/;

// First-run UI (the onboarding tour's full-screen overlay, the push opt-in
// card) lands a moment AFTER dashboard boot on a fresh tenant — over the
// open doc viewer, which a break-test run of the viewer case caught
// ("viewer frame is the element under its own centre": the tour's Welcome
// card). Arrive as a returning user, as phone-dashnav.spec.js does; the
// tour has its own spec in dashboard-actions-audit.spec.js.
async function returningUser(context) {
  await context.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000));
    } catch (e) { /* storage blocked: the tour just shows */ }
  });
}

// The installed iPhone app's @media(display-mode: standalone) cascade,
// copied to the top level: a browser tab never matches that query, and Jo
// signs in person from the home-screen app (same technique as
// phone-views.spec.js / phone-dashnav.spec.js).
async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) {
          for (const inner of r.cssRules) css += inner.cssText + '\n';
        }
      }
    }
    const s = document.createElement('style');
    s.id = 'e2e-force-standalone';
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}

// ── homeowner#2 / #3: remote contract on sign.html ─────────────────────
test.describe('phone signing: remote contract on sign.html @audit', () => {
  // sign.html (and the doc viewer's in-person signing) show the document in
  // an <iframe srcdoc> sandboxed WITHOUT allow-same-origin, so everything the
  // document fetches from our own origin is a request from an OPAQUE origin.
  // firebase.json's global CORP same-origin blocks those
  // (net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin): until 2026-09-25 production
  // refused signature-widget.js there, so no pad worked on any signing link.
  // The Linux hosting emulator in CI applies the headers and caught it; the
  // Windows one sends none, so this is also asserted from firebase.json itself.
  test('everything a generated document loads from our origin may load into the opaque-origin frame', async ({ request }) => {
    const gen = fs.readFileSync(path.join(REPO, 'docs/pro/js/document-generator.js'), 'utf8');
    const baked = [...gen.matchAll(/_assetOrigin\(\)\s*\+\s*'(\/[^']+)'/g)].map((m) => m[1]);
    expect(baked, 'document-generator bakes the pad script by absolute URL').toContain(WIDGET);
    for (const p of baked) {
      expect(firebaseHeader(p, CORP), `firebase.json ${CORP} for ${p}`).toBe('cross-origin');
      const served = (await request.get(p)).headers()[CORP.toLowerCase()];
      // A server that applies firebase.json (CI's Linux emulator, production)
      // must agree; one that sends no CORP at all (Windows emulator) is
      // covered by the firebase.json assertion above.
      if (served !== undefined) expect(served, `${CORP} the server sent for ${p}`).toBe('cross-origin');
    }
  });

  test('contract reads at phone size, pads have finger-sized controls, the record is unchanged', async ({ page, browser }) => {
    test.setTimeout(150_000);
    let creds;
    try { creds = requireTestUser(); } catch (e) { test.skip(true, e.message); return; }

    // A REAL contract from the generator, so the template's own inch-based
    // CSS and inline 9px clause blocks are what gets measured.
    await loginAs(page, creds);
    const contract = await buildContract(page);
    expect(contract, 'generator produced a contract with signature pads').toMatch(/data-nbd-sig="homeowner"/);

    const records = {};
    let livePhoneDoc = null;
    for (const run of [...PHONES, DESKTOP, BARE]) {
      await test.step(run === BARE ? `${DESKTOP}px, ${BARE}` : `${run}px`, async () => {
        const width = run === BARE ? DESKTOP : run;
        const phone = width < 1000;
        const ctx = await browser.newContext(ctxOpts(width));
        try {
          if (run === BARE) await ctx.route(PHONE_LAYOUT_JS, (r) => r.abort());
          const p = await ctx.newPage();
          const widgetFailures = [];
          p.on('requestfailed', (r) => { if (r.url().includes(WIDGET)) widgetFailures.push(r.failure() ? r.failure().errorText : 'failed'); });
          let signed = null;
          await p.route('**/getSignDocument', (r) => fulfillJson(r, { html: contract, docTypeName: 'Roofing Contract' }));
          await p.route('**/submitSignature', (r) => {
            if (r.request().method() === 'POST') signed = JSON.parse(r.request().postData()).signedHtml;
            return fulfillJson(r, { ok: true });
          });
          await p.goto('/pro/sign.html?token=phonesigning000000001');
          await expect(p.locator('#spFoot')).toBeVisible({ timeout: 20_000 });
          const frameEl = await p.$('#spFrame');
          const f = await frameEl.contentFrame();
          // Name the cause when the pad script never runs: a CORP block
          // (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin) otherwise surfaces only as
          // a 15s timeout, which is how it read in CI on 2026-09-25.
          await f.waitForFunction(() => window.__NBD_LOADED && window.__NBD_LOADED['signature-widget'], null, { timeout: 15_000 })
            .catch((e) => { throw new Error(`${WIDGET} never ran in the sandboxed signing frame (request failures: ${widgetFailures.join(', ') || 'none'}): ${e.message}`); });
          if (run === BARE) expect(await p.evaluate(() => typeof window.NBDDocPhoneLayout), 'reference run: no phone layout code loaded').toBe('undefined');

          const m = await f.evaluate(measureContract);
          if (phone) expectReadableOnPhone(expect, m, width, 'sign.html');
          else expectPaperOnDesktop(expect, m, 'sign.html');
          if (phone && !livePhoneDoc) livePhoneDoc = await f.evaluate(() => '<!DOCTYPE html>\n' + document.documentElement.outerHTML);

          const draw = (role) => drawSignature(p, f, frameEl, role);
          await draw('homeowner');
          const hb = '[data-nbd-sig="homeowner"]';
          await expect(f.locator(`${hb} .nbd-sig-state`)).toHaveText(/signed/);
          for (const action of ['clear', 'undo']) {
            const b = await f.evaluate(probeFn, `${hb} [data-nbd-sig-action="${action}"]`);
            if (phone) {
              expect(b.h, `${action} button height`).toBeGreaterThanOrEqual(40);
              expect(b.reach, `${action} button is the element under its own centre`).toBe(true);
            } else {
              expect(b.h, `desktop ${action} button unchanged`).toBeLessThanOrEqual(24);
            }
          }
          const stateFont = await f.evaluate((sel) => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize), `${hb} .nbd-sig-state`);
          if (phone) expect(stateFont, '"✓ signed" label size').toBeGreaterThanOrEqual(13);
          // A real tap on Clear must empty the pad.
          const clear = f.locator(`${hb} [data-nbd-sig-action="clear"]`);
          if (phone) await clear.tap(); else await clear.click();
          await expect(f.locator(`${hb} .nbd-sig-state`)).toHaveText('');
          const ink = await f.evaluate((sel) => {
            const cv = document.querySelector(sel + ' canvas');
            const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
            let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
            return n;
          }, hb);
          expect(ink, 'pad is blank after Clear').toBe(0);

          await draw('homeowner');
          await draw('contractor');
          await p.locator('#spSubmit').click();
          await expect(p.locator('#spMsgTitle')).toHaveText(/All done/, { timeout: 15_000 });
          expect(signed, 'submitSignature received the signed document').toBeTruthy();
          expect(signed, 'phone layout sheet kept out of the signed record').not.toContain('nbd-doc-phone');
          expect(signed, 'touch sheet kept out of the signed record').not.toContain('nbd-sig-touch');
          records[run] = normalizeSigned(signed);
        } finally {
          await ctx.close();
        }
      });
    }

    // The executed record does not depend on which layout the signer saw,
    // and carries nothing the layout code put there: every width equals the
    // record signed with no phone layout code at all.
    for (const run of [...PHONES, DESKTOP]) {
      expect(records[run] === records[BARE], `signed record at ${run}px is byte-identical to the one signed with ${BARE}`).toBe(true);
    }

    // Printing the live phone document (phone + touch sheets present) gives
    // the same PDF as printing the stored original: both sheets are screen-only.
    expect(livePhoneDoc, 'the live phone document carried the phone sheet').toContain('id="nbd-doc-phone"');
    for (const [paper, opts] of PAPERS) {
      const [livePdf, storedPdf] = [await pdfOf(browser, livePhoneDoc, opts), await pdfOf(browser, contract, opts)];
      expect(livePdf === storedPdf, `${paper} print of the live phone document matches print of the stored contract`).toBe(true);
    }
  });
});

// ── homeowner#2, second half: in-person signing in the rep's doc viewer ──
// The rep generates the contract on the dashboard (the installed iPhone app)
// and hands the phone over: NBDDocViewer shows it in #nbdv-iframe, the
// homeowner signs there, and Save / Download PDF / Print each finalize the
// signatures first. Until 2026-09-25 that was the print-size contract
// sign.html had just stopped showing. The viewer is driven exactly as the
// generator drives it (NBDDocViewer.open with onSave + onPersistFinalized);
// html2pdf and the print fallback's window.open are swapped for recorders so
// the HTML each path receives is captured, not rendered.
test.describe('phone signing: in-person contract in the rep\'s doc viewer @audit', () => {
  test('contract reads at phone size in the viewer; what it saves, PDFs and prints is unchanged', async ({ browser }) => {
    test.setTimeout(300_000);
    let creds;
    try { creds = requireTestUser(); } catch (e) { test.skip(true, e.message); return; }

    let contract = null;
    let livePhoneDoc = null;
    const saved = {}; const pdfIn = {}; const printIn = {};
    for (const run of [...PHONES, DESKTOP, BARE]) {
      await test.step(run === BARE ? `${DESKTOP}px, ${BARE}` : `${run}px`, async () => {
        const width = run === BARE ? DESKTOP : run;
        const phone = width < 1000;
        const ctx = await browser.newContext(ctxOpts(width));
        try {
          await returningUser(ctx);
          if (run === BARE) await ctx.route(PHONE_LAYOUT_JS, (r) => r.abort());
          const p = await ctx.newPage();
          await loginAs(p, creds);
          if (!contract) {
            contract = await buildContract(p);
            expect(contract, 'generator produced a contract with signature pads').toMatch(/data-nbd-sig="homeowner"/);
          }
          await p.waitForFunction(() => window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function', null, { timeout: 30_000 });
          // The dashboard's boot splash (#nbd-loader, z 99999) removes itself
          // ~0.7s after DOMContentLoaded; a rep cannot open a document before
          // then, so neither does this test (it once measured the splash).
          await p.waitForSelector('#nbd-loader', { state: 'detached', timeout: 20_000 });
          if (run === BARE) expect(await p.evaluate(() => typeof window.NBDDocPhoneLayout), 'reference run: no phone layout code loaded').toBe('undefined');
          if (phone) expect(await forceStandalone(p), 'found the installed-app rules to force').toBeGreaterThan(200);
          await safeEvaluate(p, () => {
            window.__e2eDoc = { persisted: [], pdf: null, print: null };
            // html2pdf renders what .from() is handed, in THIS page.
            window.html2pdf = () => {
              const chain = { set: () => chain, from: (el) => { window.__e2eDoc.pdf = el.outerHTML; return chain; }, save: () => Promise.resolve() };
              return chain;
            };
            // handlePrint's fallback writes currentContext.html into a new window.
            window.open = () => ({ closed: false, print() {}, document: { open() {}, close() {}, write: (h) => { window.__e2eDoc.print = h; } } });
          });
          await safeEvaluate(p, (html) => window.NBDDocViewer.open({
            html, title: 'Roofing Contract — Pat Phone', filename: 'Roofing-Contract.pdf',
            onSave: async () => {},
            onPersistFinalized: (signedHtml) => { window.__e2eDoc.persisted.push(signedHtml); },
          }), contract);
          const frameEl = await p.waitForSelector('#nbdv-iframe');
          const f = await frameEl.contentFrame();
          await f.waitForFunction(() => document.querySelector('.document-container') && window.__NBD_LOADED && window.__NBD_LOADED['signature-widget'], null, { timeout: 20_000 });

          const m = await f.evaluate(measureContract);
          if (phone) expectReadableOnPhone(expect, m, width, 'doc viewer');
          else expectPaperOnDesktop(expect, m, 'doc viewer');
          if (phone && !livePhoneDoc) livePhoneDoc = await f.evaluate(() => '<!DOCTYPE html>\n' + document.documentElement.outerHTML);

          if (phone) {
            // Nothing of the installed app's chrome sits over the viewer.
            const frameProbe = await p.evaluate(probeFn, '#nbdv-iframe');
            expect(frameProbe.w, `${width}px: viewer frame spans the phone`).toBeGreaterThanOrEqual(width - 1);
            expect(frameProbe.reach, `${width}px: viewer frame is the element under its own centre (covered by ${frameProbe.by})`).toBe(true);
            for (const sel of ['#nbdv-close', '.nbdv-action-btn.primary']) {
              const b = await p.evaluate(probeFn, sel);
              expect(b.h, `${width}px: ${sel} height`).toBeGreaterThanOrEqual(44);
              expect(b.reach, `${width}px: ${sel} is the element under its own centre (covered by ${b.by})`).toBe(true);
            }
          }

          await drawSignature(p, f, frameEl, 'homeowner');
          if (phone) {
            const clear = await f.evaluate(probeFn, '[data-nbd-sig="homeowner"] [data-nbd-sig-action="clear"]');
            expect(clear.h, `${width}px: Clear under the pad height`).toBeGreaterThanOrEqual(40);
            expect(clear.reach, `${width}px: Clear is the element under its own centre (covered by ${clear.by})`).toBe(true);
          }
          await drawSignature(p, f, frameEl, 'contractor');
          const press = (label) => { const b = p.locator('.nbdv-action-btn', { hasText: label }); return phone ? b.tap() : b.click(); };

          await press('Save to Customer');
          await p.waitForFunction(() => window.__e2eDoc.persisted.length >= 1, null, { timeout: 15_000 });
          await press('Download PDF');
          await p.waitForFunction(() => !!window.__e2eDoc.pdf, null, { timeout: 20_000 });
          await press('Print');
          await p.waitForFunction(() => !!window.__e2eDoc.print, null, { timeout: 15_000 });
          const got = await p.evaluate(() => window.__e2eDoc);

          for (const [what, html] of [['saved record', got.persisted[0]], ['html2pdf input', got.pdf], ['print fallback', got.print]]) {
            expect(html, `${width}px ${what}: phone sheet kept out`).not.toContain('nbd-doc-phone');
            expect(html, `${width}px ${what}: touch sheet kept out`).not.toContain('nbd-sig-touch');
          }
          expect(got.persisted.every((h) => !h.includes('nbd-doc-phone')), `${width}px every re-finalize persisted a clean record`).toBe(true);
          saved[run] = normalizeSigned(got.persisted[0]);
          pdfIn[run] = normalizeSigned(got.pdf);
          printIn[run] = normalizeSigned(got.print);
          expect(printIn[run] === saved[run], `${width}px: the printed record is the saved record`).toBe(true);

          if (run === PHONES[0]) {
            // Only the generator's letter documents get the phone sheet: the
            // viewer also shows reports with their own design, like the Close
            // Board's light-on-dark page, which a white body would blank out.
            await safeEvaluate(p, () => window.NBDDocViewer.close());
            await safeEvaluate(p, () => window.NBDDocViewer.open({
              html: '<!DOCTYPE html><html><head><style>body{background:#0d0f14;color:#e5e7eb}</style></head><body><div class="section"><h1 id="e2eDark">Close Board</h1></div></body></html>',
              title: 'Close Board',
            }));
            await f.waitForSelector('#e2eDark', { timeout: 10_000 });
            const dark = await f.evaluate(() => ({ sheet: !!document.getElementById('nbd-doc-phone'), bg: getComputedStyle(document.body).backgroundColor }));
            expect(dark.sheet, 'a non-letter document gets no phone sheet').toBe(false);
            expect(dark.bg, 'a dark report keeps its own background').toBe('rgb(13, 15, 20)');
          }
          await safeEvaluate(p, () => window.NBDDocViewer.close());
        } finally {
          await ctx.close();
        }
      });
    }

    // The record does not depend on which layout the signer saw — saved,
    // handed to html2pdf, or printed — and carries nothing the layout code
    // put there: every width equals the run with no phone layout code.
    for (const run of [...PHONES, DESKTOP]) {
      expect(saved[run] === saved[BARE], `saved record at ${run}px is byte-identical to the one saved with ${BARE}`).toBe(true);
      expect(pdfIn[run] === pdfIn[BARE], `html2pdf input at ${run}px is byte-identical to the one with ${BARE}`).toBe(true);
      expect(printIn[run] === printIn[BARE], `print fallback at ${run}px is byte-identical to the one with ${BARE}`).toBe(true);
    }

    // Printing the live phone document (phone sheet present) from the
    // viewer's own Print gives the same PDF as printing the original.
    expect(livePhoneDoc, 'the live phone document carried the phone sheet').toContain('id="nbd-doc-phone"');
    for (const [paper, opts] of PAPERS) {
      const [livePdf, storedPdf] = [await pdfOf(browser, livePhoneDoc, opts), await pdfOf(browser, contract, opts)];
      expect(livePdf === storedPdf, `${paper} print of the live phone document in the viewer matches print of the original`).toBe(true);
    }
  });
});

// ── homeowner#6: esign "Next field" ────────────────────────────────────
// A one-page PDF built by hand (no pdf-lib in tests/): a heading, a 16pt
// box with the acknowledgement beside it in 10pt Helvetica — the size the
// audit measured at 5.5-6.3px on a phone at fit scale — and a second box at
// the RIGHT margin whose statement runs to its left.
const CLAIM_TEXT_X = 60;
function tinyPdf() {
  const esc = (s) => s.replace(/[()\\]/g, (c) => '\\' + c);
  const text = (x, y, size, s) => `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET`;
  const content = [
    text(60, 740, 16, 'ROOFING AGREEMENT'),
    '1 w 60 500 16 16 re S',
    text(84, 504, 10, 'I have read and agree to the Terms & Conditions and the 3-day right to cancel.'),
    text(60, 440, 10, 'Initials: ________'),
    text(CLAIM_TEXT_X, 380, 10, 'Owner confirms the insurance claim number provided is accurate and current:'),
    '1 w 530 376 16 16 re S',
    text(60, 300, 10, 'Signature: ______________________      Date: ____________'),
  ].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((n) => String(n).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

test.describe('phone signing: esign Next field never ticks a box @audit', () => {
  test('Next shows the words beside a checkbox and waits for the signer to check it', async ({ browser }) => {
    test.setTimeout(90_000);
    const envelope = {
      title: 'Roofing Agreement', companyName: '', signerName: 'Pat Phone', consentText: 'I agree to sign electronically.',
      pages: [{ w: 612, h: 792, rotation: 0 }], pdf: tinyPdf(),
      // label:'' is what production writes (esign-setup.js, esign-autodetect.js).
      fields: [
        { id: 'ini', type: 'initials', page: 0, x: 110, y: 436, w: 64, h: 40, required: true, label: '' },
        { id: 'ack', type: 'checkbox', page: 0, x: 60, y: 500, w: 16, h: 16, required: true, label: '' },
        { id: 'claim', type: 'checkbox', page: 0, x: 530, y: 376, w: 16, h: 16, required: true, label: '' },
        { id: 'sig', type: 'signature', page: 0, x: 120, y: 296, w: 190, h: 46, required: true, label: '' },
        { id: 'dt', type: 'date', page: 0, x: 390, y: 296, w: 120, h: 22, required: true, label: '' },
      ],
    };
    for (const width of [...PHONES, DESKTOP]) {
      await test.step(`${width}px`, async () => {
        const phone = width < 1000;
        const ctx = await browser.newContext(ctxOpts(width));
        try {
          const p = await ctx.newPage();
          let submitted = null;
          await p.route('**/getEsignEnvelope', (r) => fulfillJson(r, envelope));
          await p.route('**/submitEsignEnvelope', (r) => {
            if (r.request().method() === 'POST') submitted = JSON.parse(r.request().postData());
            return fulfillJson(r, { ok: true });
          });
          const tap = (loc) => (phone ? loc.tap() : loc.click());
          const isDone = (id = 'ack') => p.locator(`.es-field[data-field-id="${id}"]`).evaluate((n) => n.classList.contains('is-done'));
          const excerptDrawn = () => p.waitForFunction(() => {
            const c = document.querySelector('#esExcerpt canvas');
            if (!c) return false;
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
            return dark > 400;
          }, null, { timeout: 10_000 });
          await p.goto('/pro/esign?t=phonesigning000000001');
          await expect(p.locator('.es-field')).toHaveCount(5, { timeout: 30_000 });

          await tap(p.locator('#esNext'));                      // -> initials
          await expect(p.locator('#esSheet')).toBeVisible();
          await tap(p.locator('#esTabs button[data-mode="type"]'));
          await p.locator('#esTypeInput').fill('PP');
          await tap(p.locator('#esApply'));
          await expect(p.locator('#esSheet')).toBeHidden();
          await expect(p.locator('#esProgress')).toHaveText('1 of 5');

          await tap(p.locator('#esNext'));                      // -> the checkbox
          await expect(p.locator('#esSheet'), 'Next on a checkbox opens a sheet').toBeVisible();
          expect(await isDone(), 'Next did not tick the box by itself').toBe(false);
          await expect(p.locator('#esProgress')).toHaveText('1 of 5');

          // The excerpt shows the page's own words, drawn at a readable scale.
          await excerptDrawn();
          const ex = await p.evaluate(() => {
            const c = document.querySelector('#esExcerpt canvas');
            const panel = document.querySelector('#esSheet .es-sheet-panel');
            const mark = document.querySelector('#esExcerpt .es-excerpt-box');
            const r = mark.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return {
              pxPerPt: c.getBoundingClientRect().width / 612,
              boxOnScreen: !!hit && document.getElementById('esExcerpt').contains(hit),
              panelSideways: panel.scrollWidth - panel.clientWidth,
            };
          });
          expect(ex.pxPerPt * 10, 'CSS px of 10pt document text in the excerpt').toBeGreaterThanOrEqual(14);
          expect(ex.boxOnScreen, 'the outlined box is visible in the excerpt').toBe(true);
          expect(ex.panelSideways, 'the sheet itself never scrolls sideways (only the excerpt does)').toBeLessThanOrEqual(1);

          const check = await p.evaluate(probeFn, '#esApply');
          expect(check.h, 'Check-this-box button height').toBeGreaterThanOrEqual(44);
          expect(check.reach, 'Check-this-box button is reachable').toBe(true);
          await expect(p.locator('#esApply')).toHaveText(/Check this box/);
          await tap(p.locator('#esApply'));                     // the signer's own act
          await expect(p.locator('#esSheet')).toBeHidden();
          expect(await isDone(), 'box is checked after the signer checks it').toBe(true);
          await expect(p.locator('#esProgress')).toHaveText('2 of 5');

          // A box at the RIGHT margin, its statement running to its left. The
          // excerpt used to open at the box (clamped to the page's right end),
          // showing only "...nd current:". It must open at the statement's
          // first word, say where the box is, and still not tick it.
          await tap(p.locator('#esNext'));                      // -> the right-margin checkbox
          await expect(p.locator('#esSheet')).toBeVisible();
          expect(await isDone('claim'), 'Next did not tick the right-margin box').toBe(false);
          await expect(p.locator('#esApply')).toHaveText(/Check this box/);
          await excerptDrawn();
          const cl = await p.evaluate(() => {
            const exd = document.getElementById('esExcerpt');
            const mark = exd.querySelector('.es-excerpt-box');
            return {
              scrollLeft: exd.scrollLeft, view: exd.clientWidth,
              pxPerPt: exd.querySelector('canvas').getBoundingClientRect().width / 612,
              boxRight: mark.offsetLeft + mark.offsetWidth,
              hint: document.getElementById('esCheckHint').textContent,
            };
          });
          const firstWord = CLAIM_TEXT_X * cl.pxPerPt;
          expect(firstWord, 'statement starts inside the opening view (left edge)').toBeGreaterThanOrEqual(cl.scrollLeft);
          expect(firstWord + 60, 'statement starts inside the opening view (right edge)').toBeLessThanOrEqual(cl.scrollLeft + cl.view);
          if (cl.boxRight > cl.scrollLeft + cl.view) expect(cl.hint, 'hint says where the off-screen box is').toMatch(/box is at the end of this line/);
          await tap(p.locator('#esApply'));
          await expect(p.locator('#esSheet')).toBeHidden();
          expect(await isDone('claim'), 'right-margin box is checked after the signer checks it').toBe(true);
          await expect(p.locator('#esProgress')).toHaveText('3 of 5');

          await tap(p.locator('#esNext'));                      // -> signature
          await expect(p.locator('#esSheet')).toBeVisible();
          await expect(p.locator('#esApply'), 'a later sheet is back to Apply').toHaveText('Apply');
          await tap(p.locator('#esTabs button[data-mode="type"]'));
          await p.locator('#esTypeInput').fill('Pat Phone');
          await tap(p.locator('#esApply'));
          await expect(p.locator('#esSheet')).toBeHidden();
          await tap(p.locator('#esNext'));                      // -> date (prefilled)
          await expect(p.locator('#esSheet')).toBeVisible();
          await tap(p.locator('#esApply'));
          await expect(p.locator('#esProgress')).toHaveText('5 of 5');
          await tap(p.locator('#esFinish'));
          await tap(p.locator('#esConsent'));
          await tap(p.locator('#esSubmit'));
          await expect(p.locator('#esMsgTitle')).toHaveText(/All done/, { timeout: 15_000 });
          expect(submitted && submitted.values && submitted.values.ack, 'posted checkbox value').toEqual({ checked: true });
          expect(submitted.values.claim, 'posted right-margin checkbox value').toEqual({ checked: true });
        } finally {
          await ctx.close();
        }
      });
    }
  });
});

// ── homeowner#9: Photo Review chips / counter / bulk bar ───────────────
test.describe('phone signing: photo review controls @audit', () => {
  test('chips, filters and bulk actions are finger-sized and the reviewed count shows', async ({ browser }) => {
    test.setTimeout(150_000);
    let creds;
    try { creds = requireTestUser(); } catch (e) { test.skip(true, e.message); return; }
    const openReview = async (page) => {
      // Expose the module's state + render so photos can be shown without
      // Storage uploads. Nothing is written: only EMPTY chips are tapped
      // (they open the picker), never a value.
      await page.route('**/pro/js/pages/photo-review.js*', async (route) => {
        const resp = await route.fetch();
        const body = (await resp.text()) + '\n;window.__prPhoneTest = { state, render };\n';
        await route.fulfill({ response: resp, body, headers: { ...resp.headers(), 'content-type': 'application/javascript' } });
      });
      await loginAs(page, creds);

      // No lead record on purpose. The page needs a signed-in user (auth
      // gate) but what is measured is renderTile()'s output for injected
      // photos, which does not read the lead. Seeding one made this test
      // hostage to Firestore: with the emulator under load ("client is
      // offline") the save + read-back timed the test out, twice in a row.
      // A missing lead ends in the page's own "Couldn't load this lead"
      // branch, after which render() draws the injected grid.
      await page.goto('/pro/photo-review.html?lead=phone-signing-no-such-lead');
      await page.waitForFunction(() => window.__prPhoneTest
        && (window.__prPhoneTest.state.unsub || /Couldn.t load this lead/.test(document.getElementById('prBody').textContent)),
      null, { timeout: 30_000 });
      await page.evaluate(() => {
        const st = window.__prPhoneTest.state;
        // A live /photos listener's first (empty) snapshot would wipe the
        // injected photos if it landed after them.
        if (st.unsub) { st.unsub(); st.unsub = null; }
        const img = 'data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';
        const photos = [];
        for (let i = 0; i < 8; i++) {
          const ph = { id: 'phoneReview' + i, url: img, urls: { thumb: img }, uploadedAt: { seconds: 1700000000 + i } };
          if (i % 4 === 1) ph.aiSuggestion = { phase: 'Before', damageType: 'hail', severity: 'moderate', confidence: 0.86 };
          if (i % 4 === 2) { ph.aiSuggestion = { phase: 'During', confidence: 0.6 }; ph.phase = 'During'; }
          photos.push(ph);
        }
        const s = window.__prPhoneTest.state;
        s.photos = photos; s.photosById.clear();
        for (const ph of photos) s.photosById.set(ph.id, ph);
        window.__prPhoneTest.render();
      });
      await expect(page.locator('.pr-chip').first()).toBeVisible();
    };

    // The phones share one touch context (412, then resized to 360). The
    // desktop guard gets its OWN non-touch 1280 context: resizing the phone
    // context would keep its mobile UA and touch emulation, which is not
    // what a desktop reviewer has.
    for (const [ctxWidth, widths] of [[PHONES[0], PHONES], [DESKTOP, [DESKTOP]]]) {
      const ctx = await browser.newContext(ctxOpts(ctxWidth));
      try {
        const page = await ctx.newPage();
        await openReview(page);
        for (const width of widths) {
          await test.step(`${width}px`, async () => {
            const phone = width < 1000;
            if (width !== ctxWidth) await page.setViewportSize({ width, height: 860 });
            await page.evaluate(() => window.scrollTo(0, 0));
            const m = await page.evaluate(() => {
              const vw = document.documentElement.clientWidth;
              const hs = (sel) => [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect().height);
              const counter = document.getElementById('prCounter');
              const cr = counter.getBoundingClientRect();
              const hit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
              return {
                chipH: Math.min(...hs('.pr-chip')), maxChipH: Math.max(...hs('.pr-chip')),
                filterH: Math.min(...hs('.pr-filter')),
                counter: { shown: cr.width > 0 && cr.height > 0 && cr.left >= 0 && cr.right <= vw, reach: !!hit && counter.contains(hit), text: counter.textContent },
                overflow: document.documentElement.scrollWidth - vw,
              };
            });
            expect(m.counter.shown, 'the "x/y reviewed" counter is on screen').toBe(true);
            expect(m.counter.reach, 'the counter is not covered').toBe(true);
            expect(m.counter.text).toMatch(/\d+\/8 reviewed/);
            expect(m.overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);
            if (!phone) {
              expect(m.maxChipH, 'desktop chips keep the dense layout').toBeLessThanOrEqual(24);
              return;
            }
            expect(m.chipH, 'shortest chip').toBeGreaterThanOrEqual(36);
            expect(m.filterH, 'shortest filter pill').toBeGreaterThanOrEqual(38);

            // A real tap on an empty chip opens its picker.
            const chip = page.locator('.pr-chip[data-state="empty"]').first();
            await chip.scrollIntoViewIfNeeded();
            const cb = await chip.evaluate((el) => { const r = el.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === el || el.contains(h); });
            expect(cb, 'empty chip is the element under its own centre').toBe(true);
            await chip.tap();
            await expect(page.locator('#prPicker')).toHaveAttribute('data-open', 'true');
            await page.keyboard.press('Escape');
            await expect(page.locator('#prPicker')).toHaveAttribute('data-open', 'false');

            // Select a tile: every bulk action must be on screen and tappable.
            const img = page.locator('[data-tile-img]').first();
            await img.scrollIntoViewIfNeeded();
            await img.tap();
            await expect(page.locator('#prBulkBar')).toHaveAttribute('data-open', 'true');
            await page.waitForTimeout(300); // the bar slides up (.22s)
            const btns = await page.evaluate(() => {
              const vw = document.documentElement.clientWidth;
              return [...document.querySelectorAll('#prBulkBar .pr-bulk-btn')].map((b) => {
                const r = b.getBoundingClientRect();
                const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                return { t: b.textContent.trim(), h: r.height, inView: r.left >= 0 && r.right <= vw, reach: !!h && (h === b || b.contains(h)) };
              });
            });
            for (const b of btns) {
              expect(b.inView, `bulk "${b.t}" fully on screen`).toBe(true);
              expect(b.reach, `bulk "${b.t}" reachable`).toBe(true);
              expect(b.h, `bulk "${b.t}" height`).toBeGreaterThanOrEqual(38);
            }
            await page.locator('#prBulkClear').tap();
            await expect(page.locator('#prBulkBar')).toHaveAttribute('data-open', 'false');
          });
        }
      } finally {
        await ctx.close();
      }
    }
  });
});

// ── homeowner#10 → the guided demo (2026-10-06) ───────────────────────
// The drag-the-pipeline sandbox (and its per-card arrows) was replaced by the
// guided job story at /pro/sandbox. The phone rule it held is the same one:
// the one control a prospect needs — Back / Next under the thumb — is
// finger-sized, is the element under its own centre (not covered), works by
// tap, and nothing scrolls sideways on any step.
test.describe('phone signing: guided demo pager @audit', () => {
  test('Back / Next are finger-sized, reachable, and walk every step with no sideways scroll', async ({ browser }) => {
    test.setTimeout(90_000);
    for (const width of [...PHONES, DESKTOP]) {
      await test.step(width + 'px', async () => {
        const phone = width < 1000;
        const ctx = await browser.newContext(ctxOpts(width));
        try {
          const p = await ctx.newPage();
          await p.goto('/pro/sandbox');
          const next = p.locator('.sx-pager [data-sx-nav="next"]');
          await expect(next).toBeVisible();
          await expect(p.locator('#sx-count')).toHaveText(/Step 1 of 9/);
          for (const sel of ['.sx-pager [data-sx-nav="next"]', '.sx-pager [data-sx-nav="back"]']) {
            const a = await p.evaluate(probeFn, sel);
            expect(a.h, sel + ' height').toBeGreaterThanOrEqual(44);
            expect(a.w, sel + ' width').toBeGreaterThanOrEqual(phone ? 100 : 120);
            if (sel.includes('next')) expect(a.reach, sel + ' is the element under its own centre (covered by ' + a.by + ')').toBe(true);
          }
          for (let i = 2; i <= 9; i++) {
            if (phone) await next.tap(); else await next.click();
            await expect(p.locator('#sx-count')).toHaveText(new RegExp('Step ' + i + ' of 9'));
            const sideways = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(sideways, 'step ' + i + ' scrolls sideways').toBeLessThanOrEqual(0);
          }
          if (phone) await next.tap(); else await next.click();
          await expect(p.locator('#sx-count')).toHaveText(/Done/);
          await expect(p.locator('.sx-cta-main')).toBeVisible();
        } finally {
          await ctx.close();
        }
      });
    }
  });
});
