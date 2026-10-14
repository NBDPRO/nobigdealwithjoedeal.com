// flow.js <scenario|all> - the PR-A / PR-B flow checks on the emulator at
// 390x844 (installed-iPhone rules forced). A repro harness, NOT a CI spec.
// Same setup as lib.js (emulator on, seed.js ran). Each scenario reseeds.
//
//   A-dana     an urgent missed call is visible in Dana's promised row; Done
//              leaves it unhandled in Firestore
//   A-handled  one-tap Handled (no sheet), Undo toast, Undo reopens, the
//              promise sheet is the secondary button
//   A-failed   callable down: error told, row comes back, nothing lost
//   A-center   Call Center Handled updates the Home strip at once
//   B-boot     cold boot: no false "NOT an all-clear" banner
//   B-phone    first-real-section y before/after at 390x844
//   B-undo     Today actions have a 6 s Undo; Mark dead confirms
'use strict';
const lib = require('./lib');
const path = require('path');
const { execFileSync } = require('child_process');

const S = {};
const say = (...a) => console.log(...a);
const reseed = () => execFileSync(process.execPath, [path.join(__dirname, 'seed.js')], { stdio: ['ignore', 'ignore', 'inherit'] });
const results = [];
function check(name, cond, detail) { results.push([name, !!cond]); say((cond ? '  PASS ' : '  FAIL ') + name + (cond ? '' : '   ' + (detail || ''))); }

async function open(opts) {
  const h = await lib.launch(opts);
  await lib.login(h.page);
  await lib.forceStandalone(h.page);
  await lib.waitToday(h.page, opts && opts.waitOpts);
  return h;
}
const row = (page, key) => page.locator('[data-tp-row="' + key + '"]');
const callDoc = async (id) => { const d = await lib.admin().db.doc('phone_calls/' + id).get(); return d.exists ? d.data() : null; };
const toastText = (page) => page.evaluate(() => Array.from(document.querySelectorAll('#toastContainer .toast')).map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim()));

S['A-dana'] = async () => {
  reseed();
  const h = await open();
  const r = row(h.page, 'prom:ux_dana');
  await r.scrollIntoViewIfNeeded();
  const txt = (await r.innerText()).replace(/\s+/g, ' ');
  say('ROW:', txt);
  check('Dana\'s row says urgent', /urgent/i.test(txt), txt);
  check('Dana\'s row says missed call', /missed call/i.test(txt), txt);
  await lib.shot(h.page, 'A-10-dana-row', { mark: ['[data-tp-row="prom:ux_dana"]'] });
  await r.locator('[data-tp-act="done"]').click();
  await h.page.waitForTimeout(4500);
  const m = await callDoc('cube_ux_dana_missed'), o = await callDoc('cube_ux_dana_old');
  check('Done did NOT handle the urgent missed call (server)', !m.handledAtMs, 'handledAtMs=' + m.handledAtMs);
  check('Done handled the promise-carrying call (server)', !!o.handledAtMs);
  const after = (await row(h.page, 'lead:ux_dana').innerText().catch(() => '')).replace(/\s+/g, ' ');
  check('the urgent call is still on Today after Done', /urgent/i.test(after) || /Dana/.test(await h.page.locator('#todayPlan').innerText()), after);
  await lib.shot(h.page, 'A-11-dana-after-done');
  await h.browser.close();
};

S['A-handled'] = async () => {
  reseed();
  const h = await open();
  const key = 'num:5135550142';
  await row(h.page, key).scrollIntoViewIfNeeded();
  const btnH = await row(h.page, key).locator('[data-tp-act="handled"]').evaluate((b) => Math.round(b.getBoundingClientRect().height));
  const sec = await row(h.page, key).locator('[data-tp-act="promised"]').evaluate((b) => Math.round(b.getBoundingClientRect().height));
  check('Handled and "I promised something" are >= 44 px tall', btnH >= 44 && sec >= 44, btnH + ' / ' + sec);
  await lib.shot(h.page, 'A-20-handled-row', { mark: ['[data-tp-row="num:5135550142"]'] });
  await row(h.page, key).locator('[data-tp-act="handled"]').click();
  await h.page.waitForTimeout(700);
  const sheetOpen = await h.page.evaluate(() => { const s = document.getElementById('prSheet'); return !!s && !s.hidden; });
  check('one tap: no sheet opens', !sheetOpen);
  check('the row left Today at once', (await row(h.page, key).count()) === 0);
  const t = await toastText(h.page);
  check('an Undo toast is on screen', t.some((x) => /Handled/.test(x) && /Undo/.test(x)), JSON.stringify(t));
  await lib.shot(h.page, 'A-21-handled-toast');
  await h.page.waitForTimeout(1500);
  check('the call is handled in Firestore', !!(await callDoc('cube_ux_leak')).handledAtMs);
  await h.page.locator('#toastContainer .toast-btn').first().click();
  await h.page.waitForTimeout(2500);
  check('Undo: the call is open again in Firestore', !(await callDoc('cube_ux_leak')).handledAtMs);
  check('Undo: the row is back on Today', (await row(h.page, key).count()) === 1);
  await row(h.page, key).locator('[data-tp-act="promised"]').click();
  await h.page.waitForSelector('#prSheet:not([hidden])', { timeout: 8000 });
  check('"I promised something" opens the sheet', true);
  await lib.shot(h.page, 'A-22-promised-sheet');
  await h.browser.close();
};

S['A-failed'] = async () => {
  reseed();
  const h = await open();
  await h.page.route('**/callCenterAction*', (route) => route.abort('failed'));
  const key = 'num:5135550177';
  await row(h.page, key).scrollIntoViewIfNeeded();
  await row(h.page, key).locator('[data-tp-act="handled"]').click();
  await h.page.waitForTimeout(3000);
  const t = await toastText(h.page);
  check('a failed save is told', t.some((x) => /Couldn.t save|Only \d+ of \d+/.test(x)), JSON.stringify(t));
  check('...and the person is back on Today', (await row(h.page, key).count()) === 1);
  await lib.shot(h.page, 'A-30-failed');
  await h.browser.close();
};

S['A-center'] = async () => {
  reseed();
  const h = await open();
  const stripBefore = await h.page.evaluate(() => (document.getElementById('homeAttention') || {}).textContent || '');
  await h.page.evaluate(() => { location.hash = '#/calls'; });
  await h.page.waitForSelector('#view-calls .pc-play[data-cc="handled"]', { timeout: 20000 });
  const btn = h.page.locator('#view-calls [data-cc="handled"]').first();
  await btn.click();
  await h.page.waitForTimeout(2500);
  await h.page.evaluate(() => { location.hash = '#/home'; });
  await h.page.waitForTimeout(800);
  const stripAfter = await h.page.evaluate(() => (document.getElementById('homeAttention') || {}).textContent || '');
  say('strip before:', stripBefore.replace(/\s+/g, ' ').slice(0, 120));
  say('strip after: ', stripAfter.replace(/\s+/g, ' ').slice(0, 120));
  const n = (s) => Number((s.match(/(\d+)\s+people? need/) || [])[1] || NaN);
  check('Home strip count dropped without a reload', n(stripAfter) < n(stripBefore), n(stripBefore) + ' -> ' + n(stripAfter));
  await h.browser.close();
};

// Cold boot x N: does a false "NOT an all-clear" ever paint (the walk saw it on
// 4 of 9 boots)? Counts boots that showed a banner at ANY moment in the first
// 12 s, and boots that still showed one at 12 s (the real, persistent kind).
S['B-boot'] = async () => {
  const N = Number(process.env.BOOTS || 6);
  let anyBanner = 0, stuck = 0, sawChecking = 0;
  for (let i = 0; i < N; i++) {
    reseed();
    const h = await lib.launch();
    await lib.login(h.page);
    await lib.forceStandalone(h.page);
    let seen = false, checking = false, firstBad = '';
    const t0 = Date.now();
    const probe = async () => h.page.evaluate(() => {
      const t = (document.getElementById('todayPlan') || {}).textContent || '';
      const s = (document.getElementById('homeAttention') || {}).textContent || '';
      return { bad: /could not load|did not load|NOT an all-clear/i.test(t + ' ' + s) && !/could not check your calls/i.test(t), checking: /Checking/.test(t + ' ' + s), text: (t + ' | ' + s).replace(/\s+/g, ' ').slice(0, 240) };
    });
    let last = null;
    while (Date.now() - t0 < 14000) {
      try { last = await probe(); } catch (_) { last = null; }
      if (last && last.bad && !seen) firstBad = (Date.now() - t0) + 'ms ' + last.text;
      if (last && last.bad) seen = true;
      if (last && last.checking) checking = true;
      await h.page.waitForTimeout(250);
    }
    if (seen) anyBanner++;
    if (last && last.bad) stuck++;
    if (checking) sawChecking++;
    say('  boot ' + (i + 1) + ': banner at some point=' + seen + ', still at 14 s=' + !!(last && last.bad) + ', saw Checking=' + checking + (firstBad ? ' :: first banner at ' + firstBad : ''));
    await h.browser.close();
  }
  say('BOOT SUMMARY: ' + N + ' boots, banner at any moment ' + anyBanner + ', persistent at 14 s ' + stuck + ', "Checking" shown ' + sawChecking);
  check('no cold boot leaves a false "NOT an all-clear" standing', stuck === 0, stuck + ' of ' + N);
  check('no cold boot paints a false banner even for a moment', anyBanner === 0, anyBanner + ' of ' + N);
};

// Undo on a Today action + the hold: Done on Sam's row, take it back, and a
// double tap at the same spot must not act on the next person.
S['B-undo'] = async () => {
  reseed();
  const h = await open();
  const taskDoc = async () => { const d = await lib.admin().db.doc('leads/ux_sam/tasks/task-ux1').get(); return d.exists ? d.data() : null; };
  const key = 'prom:ux_sam';
  await row(h.page, key).scrollIntoViewIfNeeded();
  await row(h.page, key).locator('[data-tp-act="done"]').click();
  await h.page.waitForTimeout(1200);
  check('Done: the task is done in Firestore', (await taskDoc()).done === true);
  const t = await toastText(h.page);
  check('a 6 s Undo toast is on screen', t.some((x) => /Done/.test(x) && /Undo/.test(x)), JSON.stringify(t));
  await lib.shot(h.page, 'B-50-undo-toast');
  await h.page.locator('#toastContainer .toast-btn').first().click();
  await h.page.waitForTimeout(1800);
  check('Undo: the task is open again in Firestore', (await taskDoc()).done === false);
  check('Undo: the row is back on Today', (await row(h.page, key).count()) === 1);
  // double tap: Done twice at the same coordinates 70 ms apart
  const before = {};
  for (const id of ['cube_ux_dana_old', 'cube_ux_dana_missed', 'cube_ux_priya']) before[id] = !!(await callDoc(id)).handledAtMs;
  const btn = row(h.page, key).locator('[data-tp-act="done"]');
  await row(h.page, key).scrollIntoViewIfNeeded();
  const box = await btn.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const rowKeys = () => h.page.evaluate(() => Array.from(document.querySelectorAll('#todayPlan [data-tp-row]')).map((r) => r.getAttribute('data-tp-row')));
  const keysBefore = await rowKeys();
  await h.page.mouse.click(cx, cy);
  await h.page.waitForTimeout(70);
  const keysMid = await rowKeys();
  check('70 ms after the tap the list has NOT shifted (the row holds; nothing slid under the thumb)', JSON.stringify(keysBefore) === JSON.stringify(keysMid), JSON.stringify({ keysBefore: keysBefore.slice(0, 8), keysMid: keysMid.slice(0, 8) }));
  await h.page.mouse.click(cx, cy);
  await h.page.waitForTimeout(2500);
  const after = {};
  for (const id of ['cube_ux_dana_old', 'cube_ux_dana_missed', 'cube_ux_priya']) after[id] = !!(await callDoc(id)).handledAtMs;
  check('a double tap did not act on the next person (no other call changed)', JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));
  const stillDone = (await taskDoc()).done === true;
  check('...and Sam\'s Done landed once', stillDone);
  await h.browser.close();
};

// Phone first screen: where does the first real section start (y in CSS px at
// 390x844, standalone, scrolled to top)? The walk measured 886 before the fix.
S['B-phone'] = async () => {
  reseed();
  const h = await open();
  await h.page.evaluate(() => window.scrollTo(0, 0));
  await h.page.waitForTimeout(500);
  const m = await h.page.evaluate(() => {
    const top = (el) => (el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null);
    const secs = Array.from(document.querySelectorAll('#todayPlan [data-tp-sec]')).filter((s) => s.getAttribute('data-tp-sec') !== 'suggestions');
    const first = secs[0];
    const firstRow = first ? first.querySelector('.tp-row') : null;
    const hdr = document.querySelector('.view-scroll > .page-hdr');
    const strip = document.getElementById('homeAttention');
    const plan = document.getElementById('todayPlan');
    const sug = document.querySelector('#todayPlan [data-tp-sec="suggestions"]');
    return {
      firstSection: first ? first.getAttribute('data-tp-sec') : null,
      firstSectionY: top(first),
      firstRowTop: top(firstRow), firstRowBottom: firstRow ? Math.round(firstRow.getBoundingClientRect().bottom + window.scrollY) : null,
      headerHeight: hdr ? Math.round(hdr.getBoundingClientRect().height) : null,
      stripShown: !!strip && !strip.hidden && getComputedStyle(strip).display !== 'none',
      suggestionVisibleAtTop: sug ? (sug.getBoundingClientRect().top < 844) : false,
      planTop: top(plan), planHeight: plan ? Math.round(plan.getBoundingClientRect().height) : null,
      stripTop: top(strip), stripVisible: !!strip && !strip.hidden, stripText: strip ? strip.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : '',
      suggestionsY: top(sug), suggestionCount: sug ? sug.children.length : 0,
      docHeight: document.documentElement.scrollHeight,
      welcome: !!document.querySelector('.home-welcome, .hw-welcome, [data-home-welcome], #homeWelcome'),
    };
  });
  say(JSON.stringify(m));
  await lib.shot(h.page, process.env.UX_SHOT || 'B-41-phone-first-screen-after');   // B-40 is the "before" (PR-A build)
  check('first real section starts on the first screen (y < 844)', m.firstSectionY != null && m.firstSectionY < 844, 'y=' + m.firstSectionY);
  check('the first real ROW sits fully above the bottom nav (bottom < 760)', m.firstRowBottom != null && m.firstRowBottom < 760, 'bottom=' + m.firstRowBottom);
  check('no suggestion chip on the first screen', !m.suggestionVisibleAtTop, 'suggestionsY=' + m.suggestionsY);
  await h.browser.close();
};

(async () => {
  const want = process.argv[2] || 'all';
  const names = want === 'all' ? Object.keys(S) : [want];
  for (const n of names) {
    if (!S[n]) { say('unknown scenario', n); process.exit(2); }
    say('\n== ' + n);
    try { await S[n](); } catch (e) { say('  ERROR', e && e.message); results.push([n + ' (threw)', false]); }
  }
  const bad = results.filter((r) => !r[1]);
  say('\n' + (results.length - bad.length) + ' pass, ' + bad.length + ' fail');
  process.exit(bad.length ? 1 : 0);
})();
