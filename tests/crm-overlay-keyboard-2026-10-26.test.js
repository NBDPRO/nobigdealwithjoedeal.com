/* tests/crm-overlay-keyboard-2026-10-26.test.js
 *
 * Overnight pass 2026-10-26, cluster "CRM overlays and controls: Escape closes,
 * focus moves in and returns, Tab stays inside, plus the small tap targets and
 * unnamed controls" (findings crm-5 and crm-10). Real Chromium on the real
 * /pro/explore sample account, served by tests/lib/demo-hosting-server.js with
 * firebase.json's own rewrites; no network, no auth. Runs in the "Pro demo
 * zero-network walk (Chromium)" CI job.
 *
 *   1. crm-5  Eight self-built dialogs: Customize widgets, New knock, Import
 *      Home Depot, Place sign, Ask Joe Scenarios, Appearance, Theme guide and
 *      What's new. Each is opened with the KEYBOARD (Enter on its opener) and
 *      must: be a named modal dialog, take focus inside, keep Tab and
 *      Shift+Tab inside, close on Escape, and hand focus back to the opener.
 *   2. crm-5  While one is open the single-letter hotkeys stay off (typing
 *      "n" over the knock sheet opened Add Lead behind it), and Escape is
 *      layered: a confirm opened over a dialog closes first, the dialog next;
 *      the knock sheet's address suggestions close before the sheet does.
 *      Tab and Shift+Tab inside that confirm stay in the confirm (they used to
 *      jump to the dialog behind it), and a Tab from a lower dialog is still
 *      pulled up to the top one. Escape on a knock sheet the rep has typed into
 *      asks "Discard this knock?" first (Keep editing / Escape keeps it, Discard
 *      closes it and frees the opener); an untouched or pre-filled sheet closes
 *      at once. Also: the visible × gives focus back, a dialog that re-renders itself
 *      (Ask Joe scenarios: picker -> detail -> Back) keeps its opener, and the
 *      Theme guide opened over Appearance closes first (a closed Appearance
 *      holds no aria-modal that would read as "a modal is open").
 *   3. crm-10 The hot-lead action buttons keep their 36px look on a phone but
 *      every one has a 44x44 hit area (measured with elementFromPoint), still
 *      on one row at 360 / 375 / 390 / 430 px; the photo Share pill's hit
 *      area is 44 wide and stays inside its badge strip (it must not take a
 *      bite out of the photo tile's own tap).
 *   4. crm-10 Names: each task checkbox carries the task's title, the cost
 *      notes box has a label.
 *   5. crm-10 The sidebar's section headers are keyboard controls (Tab stops,
 *      Enter and Space toggle, aria-expanded follows), and a collapsed
 *      section's items leave the tab order.
 *
 * Locally it SKIPS when playwright is not resolvable; under CI=true that is
 * a failure.   Run: cd tests && node crm-overlay-keyboard-2026-10-26.test.js
 */
'use strict';

const { start } = require('./lib/demo-hosting-server');

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 600) : '')); }
}
function report() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
  process.exit(0);
}

const FONT_HOST = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

// The eight dialogs. `mode` says how "showing" reads: the element exists, or it carries .open.
const OVERLAYS = [
  { name: 'Customize widgets', view: 'home', opener: '[data-target="NBDWidgets.openPicker"].home-hdr-extra', sel: '#wPickerOverlay', mode: 'exists' },
  { name: 'New knock', view: 'd2d', opener: 'button.d2d-big-btn[data-d2d-action="openQuickKnock"]', sel: '#d2d-quick-knock-overlay', mode: 'open' },
  { name: 'Import Home Depot', view: 'expenses', opener: '[data-hd-action="open"]', sel: '#hdImportModal', mode: 'exists' },
  { name: 'Place sign', view: 'signs', opener: '[data-ys-action="open-place"]', sel: '#ysPlaceModal', mode: 'exists' },
  { name: 'Ask Joe scenarios', view: 'joe', opener: '[data-fn="openDecisionPicker"]', sel: '#nbd-decision-modal', mode: 'exists' },
  { name: 'Appearance', view: 'home', opener: 'button.hdr-tool[data-fn="openSettingsTab"][data-arg="appearance"]', sel: '#nbd-picker-modal', mode: 'open' },
  { name: 'Theme guide', view: 'home', opener: 'button.hdr-tool[data-fn="nbdHowtoOpen"]', sel: '#nbd-howto-modal', mode: 'open' },
  { name: "What's new", view: 'home', opener: '#nbd-whats-new-bell', sel: '#nbd-whats-new-panel', mode: 'exists' }
];

async function newContext(browser, ORIGIN, opts) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'allow', reducedMotion: 'reduce' }, opts));
  await ctx.route('**/*', async (route) => {
    const u = route.request().url();
    if (u.startsWith(ORIGIN + '/')) return route.continue();
    if (FONT_HOST.test(u)) {
      const css = /fonts\.googleapis\.com/.test(u);
      return route.fulfill({ status: 200, contentType: css ? 'text/css' : 'font/woff2', body: css ? '/* hermetic */' : '' });
    }
    return route.abort('blockedbyclient');
  });
  return ctx;
}

// Close whatever a failing run left open, so one broken dialog cannot cascade.
async function sweepOverlays(page) {
  await page.evaluate(() => {
    ['#wPickerContainer', '#d2d-quick-knock-overlay', '#hdImportModal', '#ysPlaceModal', '#nbd-decision-modal', '#nbd-whats-new-panel']
      .forEach((s) => document.querySelectorAll(s).forEach((e) => e.remove()));
    ['#nbd-picker-modal', '#nbd-howto-modal', '.modal-bg.open'].forEach((s) => document.querySelectorAll(s).forEach((e) => e.classList.remove('open')));
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
  await page.waitForTimeout(120);
}

// How far does an element OWN the point under a finger? Installed in the page as a real function (the
// demo CSP has no unsafe-eval). Walks out from the element's centre in 1 px steps with elementFromPoint.
function installHit() {
  window.__ovkHit = (el, max) => {
    const r = el.getBoundingClientRect();
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    const owns = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
    const run = (dx, dy) => { let d = 0; while (d < max && owns(cx + dx * (d + 0.5), cy + dy * (d + 0.5))) d++; return d; };
    const left = run(-1, 0), right = run(1, 0), up = run(0, -1), down = run(0, 1);
    return { w: left + right, h: up + down, left, right, up, down, pill: [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] };
  };
}
// Is the dialog showing? (`mode`: it exists, or it carries .open)
function isShowing(arg) {
  const e = document.querySelector(arg.sel);
  return arg.want === (!!e && e.isConnected && (arg.mode === 'exists' || e.classList.contains('open')));
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
    // ════════════════════════════════════════════════════════════════════
    // Desktop (1280 x 900): the dialogs, the hotkeys, the sidebar
    // ════════════════════════════════════════════════════════════════════
    const ctx = await newContext(browser, ORIGIN, { viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String((e && e.message) || e).slice(0, 300)));
    await page.goto(ORIGIN + '/pro/explore');
    await page.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 40000 });
    await page.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && typeof window.goTo === 'function', null, { timeout: 40000, polling: 200 });
    await page.waitForTimeout(800);

    const activeInside = (sel) => page.evaluate((s) => { const o = document.querySelector(s); const a = document.activeElement; return !!o && !!a && o !== a && o.contains(a); }, sel);

    const focusDesc = () => page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '#' + a.id + '.' + String(a.className).slice(0, 30) + '|' + (a.getAttribute('data-ovk') || '') : 'none'; });
    const mark = (s, v) => page.evaluate(([sel, val]) => { document.querySelectorAll('[data-ovk]').forEach((e) => e.removeAttribute('data-ovk')); document.querySelector(sel).setAttribute('data-ovk', val); }, [s, v]);
    const focusIs = async (v) => { try { await page.waitForFunction((val) => { const a = document.activeElement; return !!a && a.getAttribute && a.getAttribute('data-ovk') === val; }, v, { timeout: 2000, polling: 50 }); return true; } catch (_) { return false; } };

    // ── 1. each dialog, driven by the keyboard ──────────────────────────
    console.log('1. the eight dialogs: named, focus in, Tab stays in, Escape closes, focus returns (crm-5)');
    for (const o of OVERLAYS) {
      await sweepOverlays(page);
      await page.evaluate((v) => window.goTo(v), o.view);
      let opener = null;
      try {
        await page.waitForSelector(o.opener, { state: 'visible', timeout: 20000 });
        opener = o.opener;
      } catch (_) { /* reported below */ }
      ok(o.name + ': its opener is on screen (harness check)', !!opener, o.opener);
      if (!opener) continue;
      await page.evaluate((s) => { document.querySelectorAll('[data-ovk-opener]').forEach((e) => e.removeAttribute('data-ovk-opener')); document.querySelector(s).setAttribute('data-ovk-opener', '1'); }, opener);
      await page.focus(opener);
      await page.keyboard.press('Enter');
      let opened = false;
      try { await page.waitForFunction(isShowing, { sel: o.sel, mode: o.mode, want: true }, { timeout: 15000, polling: 100 }); opened = true; } catch (_) { /* reported below */ }
      ok(o.name + ': Enter on its opener opens it', opened);
      if (!opened) continue;
      await page.waitForTimeout(250);

      // a named modal dialog
      const sem = await page.evaluate((s) => {
        const ov = document.querySelector(s);
        const d = ov.matches('[role="dialog"],[role="alertdialog"]') ? ov : ov.querySelector('[role="dialog"],[role="alertdialog"]');
        if (!d) return { role: null };
        const lab = d.getAttribute('aria-label') || '';
        const by = d.getAttribute('aria-labelledby');
        const byEl = by && document.getElementById(by);
        return { role: d.getAttribute('role'), modal: d.getAttribute('aria-modal'), name: (lab || (byEl && byEl.textContent) || '').trim() };
      }, o.sel);
      ok(o.name + ': it is a modal dialog with a name', !!sem.role && sem.modal === 'true' && sem.name.length > 2, JSON.stringify(sem));

      // focus moved inside
      let inFocus = false;
      try { await page.waitForFunction((s) => { const ov = document.querySelector(s); const a = document.activeElement; return !!ov && !!a && ov !== a && ov.contains(a); }, o.sel, { timeout: 2000, polling: 50 }); inFocus = true; } catch (_) { /* below */ }
      ok(o.name + ': focus moved into it on open', inFocus, await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '#' + a.id + '.' + String(a.className).slice(0, 30) : 'none'; }));

      // Tab / Shift+Tab never leave it
      const strays = [];
      for (let i = 0; i < 28; i++) { await page.keyboard.press('Tab'); if (!(await activeInside(o.sel))) strays.push('Tab#' + (i + 1)); }
      for (let i = 0; i < 4; i++) { await page.keyboard.press('Shift+Tab'); if (!(await activeInside(o.sel))) strays.push('Shift+Tab#' + (i + 1)); }
      ok(o.name + ': 28 Tab and 4 Shift+Tab presses all stay inside it', strays.length === 0, strays.slice(0, 6).join(', '));

      // Escape closes it and gives focus back to the opener
      await page.keyboard.press('Escape');
      let closed = false;
      try { await page.waitForFunction(isShowing, { sel: o.sel, mode: o.mode, want: false }, { timeout: 2500, polling: 50 }); closed = true; } catch (_) { /* below */ }
      ok(o.name + ': Escape closes it', closed);
      let back = false;
      try { await page.waitForFunction(() => { const a = document.activeElement; return !!a && a.getAttribute && a.getAttribute('data-ovk-opener') === '1'; }, null, { timeout: 2000, polling: 50 }); back = true; } catch (_) { /* below */ }
      ok(o.name + ': focus is back on the button that opened it', back, await page.evaluate(() => { const a = document.activeElement; return a ? a.tagName + '#' + a.id + '.' + String(a.className).slice(0, 30) : 'none'; }));
    }
    await sweepOverlays(page);

    // ── 2. hotkeys off, layered Escape ──────────────────────────────────
    console.log('2. hotkeys stay off behind a dialog; Escape closes the top layer first (crm-5)');
    await page.evaluate(() => window.goTo('d2d'));
    await page.waitForSelector('button.d2d-big-btn[data-d2d-action="openQuickKnock"]', { state: 'visible', timeout: 20000 });
    await page.focus('button.d2d-big-btn[data-d2d-action="openQuickKnock"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#d2d-quick-knock-overlay.open', { timeout: 10000 });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => (document.querySelector('.view.active') || {}).id);
    await page.keyboard.press('n');
    await page.keyboard.press('e');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ view: (document.querySelector('.view.active') || {}).id, lead: !!document.querySelector('#leadModal.open'), sheet: !!document.querySelector('#d2d-quick-knock-overlay.open') }));
    ok('typing n and e over the knock sheet does not open Add Lead or leave the Door-to-Door view', !after.lead && after.view === before && after.sheet, JSON.stringify({ before, after }));
    // The address suggestions close before the sheet does.
    await page.evaluate(() => {
      const row = document.getElementById('d2d-qk-address').parentElement;
      let dd = document.getElementById('d2d-qk-address-ac');
      if (!dd) { dd = document.createElement('div'); dd.id = 'd2d-qk-address-ac'; dd.className = 'd2d-ac-dropdown'; row.appendChild(dd); }
      dd.textContent = '1 Test Way'; dd.style.display = 'block';
    });
    await page.focus('#d2d-qk-address');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const ac = await page.evaluate(() => ({ dd: document.getElementById('d2d-qk-address-ac').style.display, sheet: !!document.querySelector('#d2d-quick-knock-overlay.open') }));
    ok('Escape with the address suggestions showing closes the suggestions, not the knock sheet', ac.dd === 'none' && ac.sheet, JSON.stringify(ac));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('a second Escape closes the knock sheet', await page.evaluate(() => !document.querySelector('#d2d-quick-knock-overlay.open')), await page.evaluate(() => { const v = (id) => (document.getElementById(id) || {}).value; return JSON.stringify({ a: v('d2d-qk-address'), h: v('d2d-qk-homeowner'), n: v('d2d-qk-notes'), confirm: !!document.querySelector('#nbdConfirmModal.open') }); }));
    await sweepOverlays(page);

    // Escape on a knock the rep has typed into asks before it discards the knock.
    console.log('2a. Escape on a knock sheet with input asks before discarding it (crm-5)');
    const knockOpen = () => page.evaluate(() => !!document.querySelector('#d2d-quick-knock-overlay.open'));
    const confirmOpen = () => page.evaluate(() => !!document.querySelector('#nbdConfirmModal.open'));
    const knockState = () => page.evaluate(() => ({ entry: !!(window._D2DState && window._D2DState.currentKnockEntry), who: (document.getElementById('d2d-qk-homeowner') || {}).value, note: (document.getElementById('d2d-qk-notes') || {}).value }));
    // homeowner / notes sit in the sheet's collapsed "more details" block
    const openKnockDetails = () => page.evaluate(() => document.querySelectorAll('#d2d-quick-knock-overlay details').forEach((d) => d.setAttribute('open', '')));
    const clickConfirm = async (cls) => { await page.click('#nbdConfirmModal .' + cls); await page.waitForTimeout(300); };
    // pre-filled and untouched: closes at once
    await page.evaluate(() => window.D2D.openQuickKnock({ address: '12 Elm St, Cincinnati, OH' }));
    await page.waitForSelector('#d2d-quick-knock-overlay.open', { timeout: 10000 });
    await page.waitForTimeout(300);
    ok('harness check: the sheet opened with the address pre-filled', await page.evaluate(() => document.getElementById('d2d-qk-address').value === '12 Elm St, Cincinnati, OH'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('Escape on a pre-filled sheet nobody typed into closes it with no question', !(await knockOpen()) && !(await confirmOpen()));
    await sweepOverlays(page);
    // typed into: asks
    await page.evaluate(() => window.goTo('d2d'));
    await page.waitForSelector('button.d2d-big-btn[data-d2d-action="openQuickKnock"]', { state: 'visible', timeout: 20000 });
    await mark('button.d2d-big-btn[data-d2d-action="openQuickKnock"]', 'KNOCKQ');
    await page.focus('button.d2d-big-btn[data-d2d-action="openQuickKnock"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#d2d-quick-knock-overlay.open', { timeout: 10000 });
    await page.waitForTimeout(300);
    await openKnockDetails();
    await page.fill('#d2d-qk-homeowner', 'Pat Test');
    await page.fill('#d2d-qk-notes', 'Back door, dog in yard');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const q1 = await page.evaluate(() => ({ title: ((document.querySelector('#nbdConfirmModal.open .nbd-confirm-title') || {}).textContent || ''), ok: ((document.querySelector('#nbdConfirmModal .nbd-confirm-ok') || {}).textContent || ''), keep: ((document.querySelector('#nbdConfirmModal .nbd-confirm-cancel') || {}).textContent || ''), sheet: !!document.querySelector('#d2d-quick-knock-overlay.open') }));
    ok('Escape on a sheet with input asks "Discard this knock?" and leaves the sheet open', q1.title === 'Discard this knock?' && q1.ok === 'Discard' && q1.keep === 'Keep editing' && q1.sheet, JSON.stringify(q1));
    ok('the question has the keyboard (focus inside it)', await activeInside('#nbdConfirmModal'));
    const qStrays = [];
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); if (!(await activeInside('#nbdConfirmModal'))) qStrays.push('Tab#' + (i + 1)); }
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Shift+Tab'); if (!(await activeInside('#nbdConfirmModal'))) qStrays.push('Shift+Tab#' + (i + 1)); }
    ok('Tab and Shift+Tab stay on the question, not the sheet behind it', qStrays.length === 0, qStrays.join(', '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const q2 = await knockState();
    ok('Escape on the question keeps the knock: sheet open, entry alive, text still there', (await knockOpen()) && !(await confirmOpen()) && q2.entry && q2.who === 'Pat Test' && q2.note === 'Back door, dog in yard', JSON.stringify(q2));
    ok('focus is back inside the sheet', await activeInside('#d2d-quick-knock-overlay'), await focusDesc());
    await page.keyboard.press('Escape');
    await page.waitForSelector('#nbdConfirmModal.open', { timeout: 5000 });
    await clickConfirm('nbd-confirm-cancel');
    const q3 = await knockState();
    ok('"Keep editing" keeps the knock', (await knockOpen()) && !(await confirmOpen()) && q3.entry && q3.who === 'Pat Test', JSON.stringify(q3));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#nbdConfirmModal.open', { timeout: 5000 });
    await clickConfirm('nbd-confirm-ok');
    await page.waitForTimeout(400);
    const q4 = await knockState();
    ok('"Discard" closes the sheet and drops the entry', !(await knockOpen()) && !(await confirmOpen()) && !q4.entry, JSON.stringify(q4));
    ok('and focus is back on the Knock button that opened it', await focusIs('KNOCKQ'), await focusDesc());
    await sweepOverlays(page);
    // the × stays a deliberate close, as before
    await page.evaluate(() => window.goTo('d2d'));
    await page.waitForSelector('button.d2d-big-btn[data-d2d-action="openQuickKnock"]', { state: 'visible', timeout: 20000 });
    await page.focus('button.d2d-big-btn[data-d2d-action="openQuickKnock"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#d2d-quick-knock-overlay.open', { timeout: 10000 });
    await openKnockDetails();
    await page.fill('#d2d-qk-homeowner', 'Pat Test');
    await page.click('#d2d-quick-knock-overlay .d2d-modal-close');
    await page.waitForTimeout(300);
    ok('the × still closes a typed-into sheet at once (unchanged)', !(await knockOpen()) && !(await confirmOpen()));
    await sweepOverlays(page);

    await page.evaluate(() => window.goTo('home'));
    await page.waitForSelector('[data-target="NBDWidgets.openPicker"].home-hdr-extra', { state: 'visible', timeout: 20000 });
    await page.focus('[data-target="NBDWidgets.openPicker"].home-hdr-extra');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#wPickerOverlay', { timeout: 10000 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__ovkRes = 'pending'; window.nbdModal.confirm({ title: 'Layer check', body: 'x' }).then((v) => { window.__ovkRes = v; }); });
    await page.waitForSelector('#nbdConfirmModal.open', { timeout: 5000 });
    ok('a confirm opened over a dialog takes focus', await activeInside('#nbdConfirmModal'));
    const confirmStrays = [];
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); if (!(await activeInside('#nbdConfirmModal'))) confirmStrays.push('Tab#' + (i + 1)); }
    for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+Tab'); if (!(await activeInside('#nbdConfirmModal'))) confirmStrays.push('Shift+Tab#' + (i + 1)); }
    ok('Tab and Shift+Tab over a confirm stay inside the confirm (not on the dialog behind it)', confirmStrays.length === 0, confirmStrays.join(', '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const l1 = await page.evaluate(() => ({ res: window.__ovkRes, confirmOpen: !!document.querySelector('#nbdConfirmModal.open'), picker: !!document.querySelector('#wPickerOverlay') }));
    ok('Escape over a confirm closes the confirm and leaves the dialog under it open', l1.res === false && !l1.confirmOpen && l1.picker, JSON.stringify(l1));
    const backStrays = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); if (!(await activeInside('#wPickerOverlay'))) backStrays.push('Tab#' + (i + 1)); }
    ok('once the confirm is gone the dialog keeps its own Tab trap', backStrays.length === 0, backStrays.join(', '));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    ok('the next Escape closes the dialog', await page.evaluate(() => !document.querySelector('#wPickerOverlay')));
    await sweepOverlays(page);

    // The same contract on the paths the loop above does not take.
    console.log('2b. the visible × returns focus; a re-rendered dialog keeps its opener; stacked dialogs unwind in order (crm-5)');
    // × on the knock sheet
    await page.evaluate(() => window.goTo('d2d'));
    await page.waitForSelector('button.d2d-big-btn[data-d2d-action="openQuickKnock"]', { state: 'visible', timeout: 20000 });
    await mark('button.d2d-big-btn[data-d2d-action="openQuickKnock"]', 'KNOCK');
    await page.focus('button.d2d-big-btn[data-d2d-action="openQuickKnock"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#d2d-quick-knock-overlay.open', { timeout: 10000 });
    await page.click('#d2d-quick-knock-overlay .d2d-modal-close');
    ok('closing the knock sheet with its × puts focus back on the Knock button', await focusIs('KNOCK'), await focusDesc());
    await sweepOverlays(page);
    // Decision Engine: picker -> scenario -> Escape, and picker -> scenario -> Back -> Escape
    await page.evaluate(() => window.goTo('joe'));
    await page.waitForSelector('[data-fn="openDecisionPicker"]', { state: 'visible', timeout: 20000 });
    await mark('[data-fn="openDecisionPicker"]', 'SCEN');
    await page.focus('[data-fn="openDecisionPicker"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#nbd-decision-modal [data-scenario]', { timeout: 10000 });
    await page.click('#nbd-decision-modal [data-scenario]');
    await page.waitForSelector('#nbd-decision-modal [data-action="back"]', { timeout: 5000 });
    await page.waitForTimeout(200);
    ok('Scenario detail is still a dialog with focus inside it', await activeInside('#nbd-decision-modal'), await focusDesc());
    await page.keyboard.press('Escape');
    ok('Escape in the scenario detail closes it and focus goes back to Scenarios', await focusIs('SCEN') && await page.evaluate(() => !document.querySelector('#nbd-decision-modal')), await focusDesc());
    await page.focus('[data-fn="openDecisionPicker"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#nbd-decision-modal [data-scenario]', { timeout: 10000 });
    await page.click('#nbd-decision-modal [data-scenario]');
    await page.waitForSelector('#nbd-decision-modal [data-action="back"]', { timeout: 5000 });
    await page.click('#nbd-decision-modal [data-action="back"]');
    await page.waitForSelector('#nbd-decision-modal [data-cat]', { timeout: 5000 });
    await page.keyboard.press('Escape');
    ok('Back to the picker, then Escape: still returns to Scenarios (the opener survives the re-render)', await focusIs('SCEN') && await page.evaluate(() => !document.querySelector('#nbd-decision-modal')), await focusDesc());
    await sweepOverlays(page);
    // Appearance -> Theme guide: two layers
    await page.evaluate(() => window.goTo('home'));
    await page.waitForSelector('button.hdr-tool[data-fn="openSettingsTab"][data-arg="appearance"]', { state: 'visible', timeout: 20000 });
    await mark('button.hdr-tool[data-fn="openSettingsTab"][data-arg="appearance"]', 'THEME');
    await page.focus('button.hdr-tool[data-fn="openSettingsTab"][data-arg="appearance"]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#nbd-picker-modal.open', { timeout: 10000 });
    await page.click('#nbd-picker-modal [data-fn="nbdHowtoOpen"]');
    await page.waitForSelector('#nbd-howto-modal.open', { timeout: 5000 });
    await page.evaluate(() => { const b = [...document.querySelectorAll('#nbd-picker-modal button')].find((x) => !x.closest('#nbd-howto-modal')); if (b) b.focus(); });
    ok('harness check: focus is on a control of Appearance, behind the Theme guide', await page.evaluate(() => { const a = document.activeElement; return !!a && !!a.closest('#nbd-picker-modal') && !a.closest('#nbd-howto-modal'); }));
    await page.keyboard.press('Tab');
    ok('a Tab from the lower dialog (Appearance) lands in the top one (Theme guide)', await activeInside('#nbd-howto-modal'), await focusDesc());
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const two = await page.evaluate(() => ({ guide: document.querySelector('#nbd-howto-modal').classList.contains('open'), picker: document.querySelector('#nbd-picker-modal').classList.contains('open') }));
    ok('Escape over Theme guide (opened from Appearance) closes the guide only', !two.guide && two.picker, JSON.stringify(two));
    await page.keyboard.press('Escape');
    ok('the next Escape closes Appearance and focus is back on the palette button', await focusIs('THEME') && await page.evaluate(() => !document.querySelector('#nbd-picker-modal').classList.contains('open')), await focusDesc());
    ok('a closed Appearance holds no aria-modal (it would read as "a modal is open" to layout-offer.js and nbdModal.anyOpen)', await page.evaluate(() => !document.querySelector('#nbd-picker-modal').hasAttribute('aria-modal') && !document.querySelector('#nbd-howto-modal').hasAttribute('aria-modal') && !window.nbdModal.anyOpen()));
    await sweepOverlays(page);

    // ── 5. the sidebar section headers ──────────────────────────────────
    console.log('5. sidebar section headers are keyboard controls (crm-10)');
    await page.evaluate(() => window.goTo('home'));
    await page.waitForTimeout(400);
    const hdrs = await page.evaluate(() => [...document.querySelectorAll('.nav-section-header')].map((h) => {
      const id = h.getAttribute('data-target');
      const c = document.getElementById('section-' + id);
      return { id, role: h.getAttribute('role'), tab: h.getAttribute('tabindex'), exp: h.getAttribute('aria-expanded'), ctl: h.getAttribute('aria-controls'), open: !!c && c.classList.contains('open') };
    }));
    ok('three headers (tools, insights, ai-tools)', hdrs.length === 3 && hdrs.map((h) => h.id).join() === 'tools,insights,ai-tools', JSON.stringify(hdrs));
    ok('each is role=button, tabindex=0, aria-controls its section and aria-expanded matches it', hdrs.every((h) => h.role === 'button' && h.tab === '0' && h.ctl === 'section-' + h.id && h.exp === String(h.open)), JSON.stringify(hdrs));
    await page.focus('#nav-est');
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(() => { const a = document.activeElement; return a && a.classList && a.classList.contains('nav-section-header') ? a.getAttribute('data-target') : (a ? a.tagName + '#' + a.id : 'none'); });
    ok('Tab from Estimates lands on the TOOLS header', reached === 'tools', reached);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(450);
    let st = await page.evaluate(() => ({ open: document.getElementById('section-tools').classList.contains('open'), exp: document.querySelector('.nav-section-header[data-target="tools"]').getAttribute('aria-expanded'), vis: getComputedStyle(document.getElementById('nav-d2d')).visibility, focus: document.activeElement.getAttribute('data-target') }));
    ok('Enter collapses TOOLS, aria-expanded goes false, focus stays on the header', !st.open && st.exp === 'false' && st.focus === 'tools', JSON.stringify(st));
    ok('a collapsed section\'s items are out of the tab order (visibility:hidden)', st.vis === 'hidden', JSON.stringify(st));
    await page.keyboard.press('Tab');
    const next = await page.evaluate(() => { const a = document.activeElement; return a ? a.id || (a.getAttribute('data-target') || a.tagName) : 'none'; });
    ok('Tab from the collapsed header skips TOOLS\' hidden items (next stop is not one of them)', !!next && !/^nav-(d2d|map|photos|docs|products|job-templates|draw|training|academy|roofrep)$/.test(next), next);
    await page.focus('.nav-section-header[data-target="tools"]');
    await page.keyboard.press('Space');
    await page.waitForTimeout(450);
    st = await page.evaluate(() => ({ open: document.getElementById('section-tools').classList.contains('open'), exp: document.querySelector('.nav-section-header[data-target="tools"]').getAttribute('aria-expanded'), vis: getComputedStyle(document.getElementById('nav-d2d')).visibility }));
    ok('Space opens it again: aria-expanded true, items visible', st.open && st.exp === 'true' && st.vis === 'visible', JSON.stringify(st));
    await page.evaluate(() => { try { localStorage.removeItem('nav-tools'); } catch (_) {} });

    ok('no page error mentions the overlays', pageErrors.every((m) => !/nbdOverlay|overlay-a11y/.test(m)), pageErrors.join(' | '));
    await ctx.close();

    // ════════════════════════════════════════════════════════════════════
    // Phone (touch): the hot-lead actions on the dashboard
    // ════════════════════════════════════════════════════════════════════
    console.log('3a. hot-lead action buttons on a phone: 36px look, 44px hit area, one row (crm-10)');
    const pctx = await newContext(browser, ORIGIN, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const pp = await pctx.newPage();
    await pp.goto(ORIGIN + '/pro/explore');
    await pp.waitForURL(ORIGIN + '/pro/explore/dashboard', { timeout: 40000 });
    await pp.waitForFunction(() => Array.isArray(window._leads) && window._leads.length >= 20 && typeof window.goTo === 'function', null, { timeout: 40000, polling: 200 });
    await pp.evaluate(() => window.goTo('dash'));
    await pp.waitForSelector('#hot-leads-body .hl-action', { timeout: 20000 });
    await pp.evaluate(installHit);
    for (const w of [360, 375, 390, 430]) {
      await pp.setViewportSize({ width: w, height: 844 });
      await pp.waitForTimeout(300);
      const rows = await pp.evaluate(() => [...document.querySelectorAll('#hot-leads-body .hl-actions')].map((g) => {
        const bs = [...g.querySelectorAll('.hl-action')].map((b) => { const r = b.getBoundingClientRect(); return { y: Math.round(r.y * 10) / 10, w: r.width, h: r.height }; });
        return { n: bs.length, oneRow: bs.every((b) => Math.abs(b.y - bs[0].y) < 1), looks36: bs.every((b) => b.w === 36 && b.h === 36) };
      }));
      ok(w + ' px: every hot-lead row keeps its actions on one line, pills still 36 x 36', rows.length >= 3 && rows.every((r) => r.oneRow && r.looks36), JSON.stringify(rows.filter((r) => !r.oneRow || !r.looks36).slice(0, 2)));
    }
    await pp.setViewportSize({ width: 390, height: 844 });
    await pp.waitForTimeout(300);
    const nBtn = await pp.evaluate(() => document.querySelectorAll('#hot-leads-body .hl-action').length);
    const bad = [];
    for (let i = 0; i < Math.min(nBtn, 10); i++) {
      const h = await pp.evaluate((idx) => {
        const el = document.querySelectorAll('#hot-leads-body .hl-action')[idx];
        el.scrollIntoView({ block: 'center' });
        return window.__ovkHit(el, 40);
      }, i);
      if (h.w < 43 || h.h < 43) bad.push('#' + i + ' ' + h.w + 'x' + h.h + ' (L' + h.left + ' R' + h.right + ' U' + h.up + ' D' + h.down + ')');
    }
    ok('390 px: each of the first ten hot-lead buttons owns a 44 x 44 box under a finger', nBtn >= 10 && bad.length === 0, bad.join('; '));
    await pctx.close();

    // ════════════════════════════════════════════════════════════════════
    // Phone: the customer card (Share pill, task checkboxes, cost notes)
    // ════════════════════════════════════════════════════════════════════
    console.log('3b/4. customer card on a phone: Share pill hit area, task checkbox names, cost notes label (crm-10)');
    const cctx = await newContext(browser, ORIGIN, { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const cp = await cctx.newPage();
    await cp.goto(ORIGIN + '/pro/explore/customer?id=sample-lead-01');
    await cp.waitForSelector('.nbd-share-toggle', { timeout: 40000 });
    await cp.waitForTimeout(1500);
    await cp.evaluate(installHit);
    const sh = await cp.evaluate(() => {
      const el = document.querySelector('.nbd-share-toggle');
      el.scrollIntoView({ block: 'center' });
      const strip = el.parentElement.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const hit = window.__ovkHit(el, 40);
      const cy = r.top + r.height / 2;
      return Object.assign(hit, { stripTop: strip.top, stripBottom: strip.bottom, hitTop: cy - hit.up, hitBottom: cy + hit.down });
    });
    ok('Share pill: hit area is 44 wide and taller than the 14px pill', sh.w >= 43 && sh.h >= 20, JSON.stringify(sh));
    ok('Share pill: the hit area stays inside its badge strip (nothing taken from the photo above it)', sh.hitTop >= sh.stripTop - 1 && sh.hitBottom <= sh.stripBottom + 1, JSON.stringify(sh));
    ok('Share pill: the pill itself is unchanged (36 x 14)', sh.pill[0] === 36 && sh.pill[1] === 14, JSON.stringify(sh.pill));
    const names = await cp.evaluate(() => [...document.querySelectorAll('input.nbd-tl-task-check')].map((c) => ({
      label: c.getAttribute('aria-label') || '',
      title: ((c.parentElement.querySelector('span') || {}).textContent || '').trim()
    })));
    ok('both task checkboxes are named after their task ("Mark done: <title>")', names.length >= 2 && names.every((n) => n.title && n.label === 'Mark done: ' + n.title), JSON.stringify(names));
    const notes = await cp.evaluate(() => { const t = document.getElementById('ptNotes'); return t ? { labels: t.labels ? t.labels.length : -1, text: t.labels && t.labels[0] ? t.labels[0].textContent.trim() : '' } : null; });
    ok('the cost notes box has its label ("Cost Notes")', !!notes && notes.labels === 1 && /cost notes/i.test(notes.text), JSON.stringify(notes));
    await cctx.close();
  } finally {
    await browser.close();
    await srv.close();
  }
  report();
})().catch((e) => { console.error(e); process.exit(1); });
