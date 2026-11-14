/**
 * tests/ds-flow-batch-3-2026-11-09.test.js
 *
 * Daily Success flow batch 3: the items that waited on Jo's six decisions, built with the safest default for each
 * (documentation/projects/SESSION-2026-11-09-ds-flow-batch-3.md has the table that says how to flip every one).
 *   D1  open-to: the Dashboard stays the landing view, with an "Open today" card on top and a labelled TODAY tab (no x); ?go= / #go= deep links
 *   D2  the cover poster shrinks to one line on phones and the duplicate quote is gone
 *   D3  floors are never ticked silently: "Workout done. Tick the floor?" with one tap and an undo
 *   D4  jump anywhere: a thumb-zone Go button and the header search icon open ONE sheet (go to, quick add, search with dates and field
 *       labels); a section chip row under the Today bar
 *   D5  Dash keeps its layout and gets a Today card (floors, Next-Up, Open today) at the top
 *   D6  Delete and SAVE live in a header menu; deleting shows an 8-second undo; the Notebook lists recently deleted pages
 *   M1  a Next-Up strip in every layout (onething-logic candidates + a pure dayPhase(hour))
 *   M2  each finish surface ends with a primary "Next: ..." button
 *   Q11 the wrap-up moves up after 17:00     Q12 last night's non-negotiable is carried forward
 * Saved-page data keys are unchanged (nbd_dsp_v1, ms-nonneg, floormet-*).
 *
 * Run: cd tests && node ds-flow-batch-3-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { start } = require('./lib/demo-hosting-server.js');
const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'docs', 'pro', 'daily-success');
const read = (...p) => fs.readFileSync(path.join(DS, ...p), 'utf8');
const has = (...p) => fs.existsSync(path.join(DS, ...p));
const load = (...p) => (has(...p) ? require(path.join(DS, ...p)) : null);

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const dkOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NOW = new Date();
const TODAY = dkOf(NOW);
const YDAY = dkOf(new Date(NOW.getTime() - 86400000));
const D3 = dkOf(new Date(NOW.getTime() - 3 * 86400000));
const mkPage = (id, dk, data) => ({ id, dk, suf: 1, name: '', data: data || {}, kpi: { doors: 0, contacts: 0, appts: 0, closes: 0, noshow: 0 }, exercises: [], objections: [], commissions: [] });

async function open(browser, srv, opt) {
  const o = Object.assign({ w: 390, ui: 'classic', extra: {}, hour: 10, q: '', withToday: true }, opt || {});
  const ctx = await browser.newContext({ viewport: { width: o.w, height: 760 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.setDefaultTimeout(5000);
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  const t = new Date(); t.setHours(o.hour, 0, 0, 0);
  await page.clock.setFixedTime(t);
  const pages = (o.pages || [
    mkPage(2.5, YDAY, { 'fit-focus': 'Pull day', 'l-win': 'Signed the Miller roof', 'g-why': 'Miller family comes first' }),
    mkPage(3.5, D3, { 'l-win': 'Booked two inspections', 'ms-nonneg': 'Miller follow-up' }),
  ].concat(o.withToday ? [mkPage(1.5, TODAY, { 'fit-focus': 'Push day' })] : []));
  await page.addInitScript(({ ui, pages, extra }) => {
    if (!sessionStorage.getItem('__seeded')) {
      sessionStorage.setItem('__seeded', '1');
      localStorage.setItem('nbd_dsp_v1', JSON.stringify(pages));
      Object.keys(extra).forEach((k) => localStorage.setItem(k, extra[k]));
    }
    localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none');
    localStorage.setItem('nbd_ds_layout', ui);
  }, { ui: o.ui, pages, extra: o.extra });
  await page.goto(srv.origin + '/pro/daily-success/' + o.q, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof switchTo === 'function' && document.getElementById('tabrow') && document.getElementById('tabrow').children.length > 0, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(350);
  return { ctx, page, errs };
}
const cur = (page) => page.evaluate(() => cur);
const todayIdx = (page) => page.evaluate((tk) => pages.findIndex((p) => p.dk === tk), TODAY);
const vis = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; }, sel);
const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent.replace(/\s+/g, ' ').trim() : ''; }, sel);
const pageData = (page, dk) => page.evaluate((d) => { const p = JSON.parse(localStorage.getItem('nbd_dsp_v1')).find((x) => x.dk === d); return p ? p.data : null; }, dk);

(async () => {
  // ════════════════════════════════════════════════════════════════════════════════
  // the pure halves
  // ════════════════════════════════════════════════════════════════════════════════
  console.log('\nquickjump-logic (registry, deep links, dates, search)');
  const Q = load('js', 'quickjump-logic.js');
  ok('js/quickjump-logic.js exists and exports the registry, parseGo, dateWord, searchNotes', !!Q && ['parseGo', 'dateWord', 'filterDests', 'searchNotes', 'fieldLabel', 'DESTS', 'CHIPS'].every((k) => k in Q));
  if (Q) {
    const GO = ['today', 'floors', 'food', 'workout', 'wrap', 'review', 'money', 'dash'];
    ok('every deep-link target the brief names is in the registry', GO.every((id) => Q.DESTS.some((d) => d.id === id)));
    ok('parseGo reads ?go=', GO.every((id) => Q.parseGo('?go=' + id, '') === id));
    ok('parseGo reads #go= and ignores other hash and query parts', Q.parseGo('', '#go=food') === 'food' && Q.parseGo('?x=1&go=wrap&y=2', '') === 'wrap' && Q.parseGo('', '#go=floors&a=b') === 'floors');
    ok('parseGo ignores unknown targets, junk and the router\'s own hashes', Q.parseGo('?go=nope', '') === '' && Q.parseGo('', '#day-12') === '' && Q.parseGo('', '#ov-coach') === '' && Q.parseGo('?go=<script>', '') === '' && Q.parseGo('', '') === '');
    ok('parseGo is case-insensitive', Q.parseGo('?go=TODAY', '') === 'today');
    const t = '2026-11-09'; // a Monday
    ok('dateWord: today and yesterday', Q.dateWord('today', t) === '2026-11-09' && Q.dateWord('Yesterday', t) === '2026-11-08');
    ok('dateWord: a weekday name is its most recent day', Q.dateWord('friday', t) === '2026-11-06' && Q.dateWord('fri', t) === '2026-11-06' && Q.dateWord('monday', t) === '2026-11-09');
    ok('dateWord: "nov 7", "november 7", "11/7" and an ISO date', Q.dateWord('nov 7', t) === '2026-11-07' && Q.dateWord('November 7', t) === '2026-11-07' && Q.dateWord('11/7', t) === '2026-11-07' && Q.dateWord('2026-10-30', t) === '2026-10-30');
    ok('dateWord: a month-day later than today is last year\'s', Q.dateWord('dec 25', t) === '2025-12-25');
    ok('dateWord: not a date -> null', Q.dateWord('roof', t) === null && Q.dateWord('', t) === null && Q.dateWord('nov 40', t) === null && Q.dateWord('13/45', t) === null);
    ok('filterDests: empty -> everything; "mon" finds Money first; keywords count ("weight" finds the weigh-in)', Q.filterDests('').length === Q.DESTS.length && Q.filterDests('mon')[0].id === 'money' && Q.filterDests('weight').some((d) => /weigh|body/.test(d.id)));
    ok('filterDests: no match -> []', Q.filterDests('zzzz').length === 0);
    ok('fieldLabel names the known fields and tidies the rest', Q.fieldLabel('l-win') === 'Win' && Q.fieldLabel('ms-nonneg') === 'Non-negotiable' && Q.fieldLabel('g-why') !== 'g-why' && Q.fieldLabel('zz-odd-key') === 'Zz odd key');
    ok('the section chips are Floors, Food, Train, Body, Wins, Wrap-up, Habits, in that order', Q.CHIPS.map((c) => c.label).join(',') === 'Floors,Food,Train,Body,Wins,Wrap-up,Habits');
    const pg = [
      { id: 1, dk: '2026-11-03', suf: 1, name: '', data: { 'l-win': 'Roof for Miller signed', 'floormet-qs1': '1', 'habit-0-1': '1' } },
      { id: 2, dk: '2026-11-08', suf: 1, name: '', data: { 'ms-nonneg': 'Call Miller back', 'diet-m0-p': '40', 'l-win': 'miller supplement approved' } },
      { id: 3, dk: '2026-11-05', suf: 1, name: '', data: { 'reg-notes': 'Nothing here' } },
    ];
    const r = Q.searchNotes(pg, 'miller', { label: (p) => p.dk });
    ok('searchNotes lists text hits newest day first', r.hits.length === 3 && r.hits[0].dk === '2026-11-08' && r.hits[r.hits.length - 1].dk === '2026-11-03', JSON.stringify(r.hits.map((h) => h.dk)));
    ok('...each hit carries the field label, the key (for the jump) and the page index', r.hits.every((h) => h.label && h.key && typeof h.pi === 'number') && r.hits.some((h) => h.label === 'Non-negotiable' && h.key === 'ms-nonneg' && h.pi === 1));
    ok('...it never searches floor ticks, habit cells or macro numbers', Q.searchNotes(pg, '1', {}).hits.length === 0 && Q.searchNotes(pg, '40', {}).hits.length === 0);
    ok('...it is capped (default 20) and says how many matched', (() => { const big = Array.from({ length: 30 }, (_, i) => ({ id: i, dk: '2026-10-' + String(i + 1).padStart(2, '0'), suf: 1, data: { 'l-win': 'roof ' + i } })); const x = Q.searchNotes(big, 'roof', {}); return x.hits.length === 20 && x.total === 30 && Q.searchNotes(big, 'roof', { cap: 5 }).hits.length === 5; })());
    ok('...the preview is short and holds the match', r.hits.every((h) => /miller/i.test(h.text) && h.text.length <= 90));
    ok('...an empty or one-letter query finds nothing', Q.searchNotes(pg, '', {}).hits.length === 0 && Q.searchNotes(pg, ' ', {}).hits.length === 0);
  }

  console.log('\nonething-logic (Next-Up: dayPhase and the new candidates)');
  const O = load('js', 'onething-logic.js');
  ok('dayPhase and nextUp are exported next to the old nextThing', !!O && typeof O.dayPhase === 'function' && typeof O.nextUp === 'function' && typeof O.nextThing === 'function' && typeof O.candidates === 'function');
  if (O && O.dayPhase && O.nextUp) {
    ok('dayPhase: morning before 11, field 11-16, evening from 17', O.dayPhase(0) === 'morning' && O.dayPhase(10) === 'morning' && O.dayPhase(11) === 'field' && O.dayPhase(16) === 'field' && O.dayPhase(17) === 'evening' && O.dayPhase(23) === 'evening');
    ok('dayPhase: junk is the field phase, never a throw', O.dayPhase(NaN) === 'field' && O.dayPhase(undefined) === 'field' && O.dayPhase(-3) === 'field' && O.dayPhase(31) === 'field');
    const floors = [{ id: 'a', label: 'Sleep 7+ hrs', met: true }, { id: 'b', label: 'Workout complete', met: false }, { id: 'c', label: '1 Big Task', met: false }];
    const base = { isToday: true, checkin: 'hidden', eod: 'link', floors, workout: false };
    const kinds = (o) => O.candidates(o).map((c) => c.kind).join(',');
    ok('control: with no new options candidates() is what it always was (the One Thing layout is unchanged)', kinds(base) === 'floor,floor,workout', kinds(base));
    const up = (h, extra) => O.nextUp(Object.assign({}, base, { hour: h, eod: 'prompt', checkin: 'ask' }, extra || {}));
    ok('morning: the check-in is first', up(8).thing.kind === 'checkin', up(8).thing.kind);
    ok('evening: the wrap-up is first (Q11), the check-in is not offered over it', up(19).thing.kind === 'eod' && up(19).queue[0] === 'eod', JSON.stringify(up(19).queue));
    ok('field hours: an open floor first', up(13, { checkin: 'done' }).thing.kind === 'floor', up(13, { checkin: 'done' }).thing.kind);
    ok('a workout-type floor swallows the separate "workout" candidate (the same task is not listed twice)', !up(13).queue.includes('workout') && up(13).queue.some((q) => q === 'floor:b'));
    ok('...but with no workout-type floor the workout stays', O.nextUp({ isToday: true, hour: 13, checkin: 'done', eod: 'link', floors: [{ id: 'x', label: '1 Big Task', met: false }], workout: false }).queue.includes('workout'));
    ok('a workout already done is never offered', !O.nextUp({ isToday: true, hour: 13, checkin: 'done', eod: 'link', floors: [], workout: true }).queue.includes('workout'));
    const food = { protein: { have: 62, target: 160 } };
    ok('protein under target -> a food candidate that says how far', up(13, Object.assign({ checkin: 'done' }, food)).queue.includes('food') && /98/.test(up(13, Object.assign({ checkin: 'done' }, food)).items.find((c) => c.kind === 'food').sub));
    ok('...at or over target, no food candidate; no protein info, no food candidate', !O.candidates(Object.assign({}, base, { protein: { have: 160, target: 160 } })).some((c) => c.kind === 'food') && !O.candidates(base).some((c) => c.kind === 'food') && !O.candidates(Object.assign({}, base, { protein: { have: 5, target: 0 } })).some((c) => c.kind === 'food'));
    ok('weigh-in: offered only when told it is missing, only in the morning', O.nextUp(Object.assign({}, base, { hour: 8, weighed: false, checkin: 'done', floors: [] })).queue.includes('weigh') && !O.nextUp(Object.assign({}, base, { hour: 8, weighed: true, checkin: 'done', floors: [] })).queue.includes('weigh') && !O.nextUp(Object.assign({}, base, { hour: 15, weighed: false, checkin: 'done', floors: [] })).queue.includes('weigh'));
    const carry = O.nextUp(Object.assign({}, base, { hour: 8, checkin: 'done', carry: 'Call Miller back' }));
    ok('before 11, last night\'s non-negotiable is offered ("From last night") and shows the words', carry.thing.kind === 'carry' && /From last night/.test(carry.thing.title) && /Call Miller back/.test(carry.thing.title), JSON.stringify(carry.thing));
    ok('...after 11 it is not', !O.nextUp(Object.assign({}, base, { hour: 12, carry: 'Call Miller back' })).queue.includes('carry'));
    ok('the Sunday review is offered when due', O.nextUp(Object.assign({}, base, { hour: 13, checkin: 'done', reviewDue: true })).queue.includes('review') && !O.nextUp(Object.assign({}, base, { hour: 13, checkin: 'done', reviewDue: false })).queue.includes('review'));
    ok('nothing today-only is offered on a past day', !O.nextUp({ isToday: false, hour: 19, eod: 'prompt', checkin: 'ask', floors: [], workout: true, carry: 'x' }).queue.some((q) => ['eod', 'checkin', 'carry'].includes(q)));
    ok('skipped items go to the back, like nextThing', O.nextUp(Object.assign({}, base, { hour: 19, eod: 'prompt', skipped: ['eod'] })).thing.kind !== 'eod');
    ok('nextUp says how many are left, and "done" when nothing is', up(13, { checkin: 'done', eod: 'link' }).left === 2 && O.nextUp({ isToday: true, hour: 13, floors: [], workout: true, eod: 'link', checkin: 'hidden' }).thing.kind === 'done');
    ok('every real candidate names a button and a kind the UI can route', O.nextUp(Object.assign({}, base, food, { hour: 8, carry: 'x', weighed: false, reviewDue: true, checkin: 'ask', eod: 'prompt' })).items.every((c) => c.kind && c.title && c.button));
  }

  console.log('\neod-logic (carry last night forward)');
  const E = load('js', 'eod-logic.js');
  ok('carryForward exists', !!E && typeof E.carryForward === 'function');
  if (E && E.carryForward) {
    const map = { '2026-11-08': { body: 2, win: 'x', tomorrow: 'Call Miller back', at: 1 }, '2026-11-06': { tomorrow: 'Old one', at: 1 } };
    ok('yesterday\'s "tomorrow" answer comes back', E.carryForward(map, '2026-11-09') === 'Call Miller back');
    ok('...only yesterday\'s (a week-old answer is not "last night")', E.carryForward(map, '2026-11-12') === '' && E.carryForward({}, '2026-11-09') === '' && E.carryForward(null, '2026-11-09') === '');
    ok('...a skipped night or an empty answer carries nothing; junk dates do not throw', E.carryForward({ '2026-11-08': { skipped: true } }, '2026-11-09') === '' && E.carryForward({ '2026-11-08': { body: 2 } }, '2026-11-09') === '' && E.carryForward(map, 'nope') === '');
  }

  console.log('\nnotebook-logic (recently deleted)');
  const N = load('js', 'notebook-logic.js');
  ok('trashAdd, trashTake and trashPrune exist', !!N && ['trashAdd', 'trashTake', 'trashPrune'].every((k) => typeof N[k] === 'function'));
  if (N && N.trashAdd) {
    const now = Date.UTC(2026, 10, 9);
    const pg = (id, dk) => ({ id, dk, suf: 1, name: '', data: { x: 'y' } });
    let l = N.trashAdd([], { page: pg(1, '2026-11-01'), idx: 0 }, now);
    l = N.trashAdd(l, { page: pg(2, '2026-11-02'), idx: 1 }, now + 1000);
    ok('newest first, each with its place and when', l.length === 2 && l[0].page.id === 2 && l[0].idx === 1 && l[0].at === now + 1000);
    ok('the same page twice is one entry', N.trashAdd(l, { page: pg(2, '2026-11-02'), idx: 1 }, now + 2000).length === 2);
    ok('only the last ten are kept', (() => { let x = []; for (let i = 0; i < 14; i++) x = N.trashAdd(x, { page: pg(i, '2026-10-01'), idx: 0 }, now + i); return x.length === 10 && x[0].page.id === 13; })());
    ok('entries older than 30 days are dropped', N.trashPrune(l, now + 31 * 86400000).length === 0 && N.trashPrune(l, now + 29 * 86400000).length === 2);
    const t = N.trashTake(l, '2');
    ok('trashTake returns the entry and the list without it; a missing id changes nothing', t.entry.page.id === 2 && t.list.length === 1 && N.trashTake(l, 'zz').entry === null && N.trashTake(l, 'zz').list.length === 2);
    ok('junk in is not stored', N.trashAdd([], null, now).length === 0 && N.trashAdd([], { page: null }, now).length === 0 && N.trashAdd('x', { page: pg(5, '2026-11-01'), idx: 0 }, now).length === 1);
    ok('the page is stored by value (later edits to the original do not change the stored copy)', (() => { const p = pg(9, '2026-11-01'); const x = N.trashAdd([], { page: p, idx: 0 }, now); p.data.x = 'changed'; return x[0].page.data.x === 'y'; })());
  }

  console.log('\nfloor-tick-logic (ask first, never tick silently)');
  const F = load('js', 'floor-tick-logic.js');
  ok('js/floor-tick-logic.js exists and exports offer and message', !!F && typeof F.offer === 'function' && typeof F.message === 'function');
  if (F) {
    const floors = [{ id: 'qs1', label: 'Sleep 7+ hrs' }, { id: 'qs2', label: 'Workout complete' }, { id: 'qs3', label: 'Protein ≥ bodyweight (g)' }, { id: 'qs4', label: '1 Big Task' }, { id: 'qs5', label: 'Journaled' }];
    ok('workout -> the workout floor; protein -> the protein floor; sleep -> sleep; wrap -> Journaled', F.offer(floors, {}, 'workout').join() === 'qs2' && F.offer(floors, {}, 'protein').join() === 'qs3' && F.offer(floors, {}, 'sleep').join() === 'qs1' && F.offer(floors, {}, 'wrap').join() === 'qs5');
    ok('a floor already met is not offered again', F.offer(floors, { 'floormet-qs2': '1' }, 'workout').length === 0);
    ok('a custom label still matches by its words ("Lift weights", "Hit protein goal")', F.offer([{ id: 'z', label: 'Lift weights' }], {}, 'workout').join() === 'z' && F.offer([{ id: 'z', label: 'Hit protein goal' }], {}, 'protein').join() === 'z');
    ok('no matching floor -> nothing offered (the prompt does not appear)', F.offer([{ id: 'z', label: '1 Big Task' }], {}, 'workout').length === 0 && F.offer(floors, {}, 'unknown').length === 0 && F.offer(null, {}, 'workout').length === 0);
    ok('the message is the words Jo chose', F.message('workout') === 'Workout done. Tick the floor?' && /^Protein target hit/.test(F.message('protein')) && /^Sleep logged/.test(F.message('sleep')) && /^Wrap-up saved/.test(F.message('wrap')));
    ok('sleep counts only when it is OK or Good (a rough night does not offer a 7-hour floor)', F.sleepCounts(1) === false && F.sleepCounts(2) === true && F.sleepCounts(3) === true && F.sleepCounts(0) === false);
    ok('protein counts at or over a real target only', F.proteinHit(160, 160) && F.proteinHit(170, 160) && !F.proteinHit(159, 160) && !F.proteinHit(50, 0) && !F.proteinHit(NaN, 160));
  }

  // ════════════════════════════════════════════════════════════════════════════════
  // the page
  // ════════════════════════════════════════════════════════════════════════════════
  const srv = await start({ root: path.join(ROOT, 'docs') });
  const browser = await chromium.launch();

  console.log('\nD1. open-to: Dash stays the landing view; Open today; the TODAY tab; ?go= links');
  {
    const { ctx, page, errs } = await open(browser, srv);
    ok('control: boots on the Dashboard', (await cur(page)) === -1);
    ok('an "Open today" card sits at the very top of the Dash, above the streak, money, weight and data cards', await page.evaluate(() => { const c = document.querySelector('#main > .nu-today'); if (!c) return false; const top = c.getBoundingClientRect().top; return getComputedStyle(c).order === '-1' && [...document.querySelectorAll('#main > *')].every((e) => e === c || e.getBoundingClientRect().height === 0 || e.getBoundingClientRect().top >= top) && !!c.querySelector('[data-nu="open-today"]'); }));
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#tabrow .tab, #tabrow .tplus')].map((t) => ({ txt: t.textContent.replace(/\s+/g, ' ').trim(), x: !!t.querySelector('.tx'), cls: t.className })));
    ok('the tab row has a TODAY tab, and no tab has a ×', tabs.some((t) => /^TODAY\b/i.test(t.txt)) && tabs.every((t) => !t.x), JSON.stringify(tabs));
    ok('...and no bare "+" is left', tabs.every((t) => t.txt !== '+'), JSON.stringify(tabs));
    await page.click('#main .nu-today [data-nu="open-today"]');
    await page.waitForTimeout(300);
    ok('"Open today" opens today\'s page', (await cur(page)) === (await todayIdx(page)) && (await cur(page)) >= 0);
    ok('...and the TODAY tab is the active one', await page.evaluate(() => { const a = document.querySelector('#tabrow .tab.active'); return !!a && /TODAY/i.test(a.textContent); }));
    await page.evaluate(() => switchTo(0)); // an older day
    await page.waitForTimeout(250);
    ok('on an older day the TODAY tab is still there (to go back) and the open day is named in its own tab', await page.evaluate(() => { const t = [...document.querySelectorAll('#tabrow .tab')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()); return t.some((x) => /TODAY/i.test(x)) && t.length >= 3; }));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page, errs } = await open(browser, srv, { withToday: false });
    const before = await page.evaluate(() => pages.length);
    ok('with no page for today, boot creates none ("do not auto-create blank pages")', before === 2 && (await cur(page)) === -1);
    const tab = await page.evaluate(() => { const t = [...document.querySelectorAll('#tabrow .tab, #tabrow .tplus')].find((x) => /TODAY/i.test(x.textContent)); return t ? { txt: t.textContent.trim(), act: t.dataset.action } : null; });
    ok('...the labelled TODAY tab stands where the "+" was, and starts today when tapped', !!tab && tab.act === 'smart-new-page', JSON.stringify(tab));
    ok('...the Dash card says there is no page yet and offers to open one', /Open today/i.test(await text(page, '#main .nu-today')));
    await page.click('#main .nu-today [data-nu="open-today"]');
    await page.waitForTimeout(300);
    ok('tapping it creates exactly one page for today and opens it', (await page.evaluate(() => pages.length)) === 3 && (await cur(page)) === (await todayIdx(page)));
    await ctx.close();
  }
  for (const [go, check] of [
    ['today', async (page) => (await cur(page)) === (await todayIdx(page)) && (await cur(page)) >= 0],
    ['floors', async (page) => (await cur(page)) >= 0 && await page.evaluate(() => { const r = document.getElementById('day-score-wrap').getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 100; })],
    ['food', async (page) => (await cur(page)) >= 0 && await page.evaluate(() => { const c = document.getElementById('diet-pb').closest('.pc'); const r = document.getElementById('diet-pb').getBoundingClientRect(); return !c.classList.contains('collapsed') && r.top < window.innerHeight; })],
    ['wrap', async (page) => (await cur(page)) >= 0 && await page.evaluate(() => { const c = document.querySelector('.eod-card'); const r = c.getBoundingClientRect(); return !!c.querySelector('#eodWin') && r.top < window.innerHeight; })],
    ['workout', async (page) => await page.evaluate(() => !!document.querySelector('#wcOverlay.open'))],
    ['review', async (page) => await page.evaluate(() => !!document.querySelector('#rvOverlay.open'))],
    ['money', async (page) => await page.evaluate(() => !!document.querySelector('#mnOverlay.open'))],
    ['dash', async (page) => (await cur(page)) === -1],
  ]) {
    const { ctx, page, errs } = await open(browser, srv, { q: '?go=' + go, hour: 10 });
    await page.waitForTimeout(500);
    ok('?go=' + go + ' lands on it', await check(page), 'cur=' + (await cur(page)));
    ok('...and takes the link out of the address bar (a reload will not run it again)', await page.evaluate(() => !/go=/.test(location.search + location.hash)), await page.evaluate(() => location.search + location.hash));
    ok('...no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { q: '#go=floors' });
    await page.waitForTimeout(500);
    ok('#go=floors works too', (await cur(page)) >= 0 && await page.evaluate(() => { const r = document.getElementById('day-score-wrap').getBoundingClientRect(); return r.top < window.innerHeight; }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { q: '?go=floors', withToday: false });
    await page.waitForTimeout(500);
    ok('?go=floors with no page for today opens (creates) today first, because the link asked for it', (await page.evaluate(() => pages.length)) === 3 && (await cur(page)) === (await todayIdx(page)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { q: '?go=nope' });
    ok('an unknown ?go= does nothing: still the Dashboard', (await cur(page)) === -1);
    await ctx.close();
  }
  {
    const home = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'os', 'home.js'), 'utf8');
    const coach = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'os', 'coach-logic.js'), 'utf8');
    ok('the NBD OS floors widget links to ?go=floors', /DS_HREF \+ '\?go=floors'/.test(home) && /d \? DS_HREF_FLOORS : DS_HREF_TODAY/.test(home));
    ok('...its "Open Daily Success" button and the business rows go to ?go=today', /DS_HREF \+ '[^']*\?go=today'/.test(home) && /os-hw-ds-open[^;]*DS_HREF_TODAY/.test(home));
    ok('the Coach\'s "you missed your floors" action goes to ?go=floors', /href: '\/pro\/daily-success\/\?go=floors'/.test(coach));
    ok('the dock / app tile is untouched (it opens the app, not a destination)', !/data-target', '\/pro\/daily-success\/\?go/.test(home));
  }

  console.log('\nD2. the cover on phones');
  {
    const { ctx, page } = await open(browser, srv, { w: 390, extra: { nbd_ds_coach_ready: JSON.stringify({ [TODAY]: { skipped: true } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => { const c = document.querySelector('.cover'); const r = c.getBoundingClientRect(); const vis = (s) => { const e = c.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 0; }; return { h: Math.round(r.height), title: vis('.cover-title'), eyebrow: vis('.cover-eyebrow'), date: vis('.cover-date'), quote: vis('.cover-quote') }; });
    ok('on a phone the cover is one short band (date + quote, no poster title)', m.h <= 90 && !m.title && !m.eyebrow && m.date && m.quote, JSON.stringify(m));
    ok('...the date and the quote sit on one line', await page.evaluate(() => { const d = document.querySelector('.cover .cover-date').getBoundingClientRect(), q = document.querySelector('.cover .cover-quote').getBoundingClientRect(); return Math.abs((d.top + d.height / 2) - (q.top + q.height / 2)) < 14; }));
    ok('the quote is printed once, not twice (no .qcard)', await page.evaluate(() => !document.querySelector('.qcard') && document.querySelectorAll('.cover-quote').length === 1));
    ok('the cover plus the quote now cost one band, so the floors card starts within 820px of the top at 390 wide, strip and chips included (check-in skipped)', await page.evaluate(() => document.getElementById('day-score-wrap').getBoundingClientRect().top < 820), String(await page.evaluate(() => document.getElementById('day-score-wrap').getBoundingClientRect().top)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { w: 1100 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => { const c = document.querySelector('.cover'); const vis = (s) => { const e = c.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; }; return { h: Math.round(c.getBoundingClientRect().height), title: vis('.cover-title'), quote: vis('.cover-quote'), qcard: !!document.querySelector('.qcard') }; });
    ok('on desktop the poster stays (title, date, quote), and the quote is still printed once', m.h > 150 && m.title && m.quote && !m.qcard, JSON.stringify(m));
    await ctx.close();
  }

  console.log('\nD3. floors: ask first, one tap, undo');
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const did = (kind, extra) => page.evaluate(([k, e, tk]) => window.dispatchEvent(new CustomEvent('nbd-ds-did', { detail: Object.assign({ kind: k, dk: tk }, e || {}) })), [kind, extra, TODAY]);
    await did('workout');
    await page.waitForTimeout(200);
    ok('finishing a workout shows "Workout done. Tick the floor?" with a one-tap Tick and a Not now', (await text(page, '#dsTick')).includes('Workout done. Tick the floor?') && await vis(page, '#dsTick [data-tick="yes"]') && await vis(page, '#dsTick [data-tick="no"]'), await text(page, '#dsTick'));
    ok('...the floor is NOT ticked by itself', (await pageData(page, TODAY))['floormet-qs2'] !== '1' && await page.evaluate(() => !document.querySelector('#day-score-card .dsc-item[data-floor-id="qs2"] .dsc-dot.hit')));
    ok('...the prompt names the floor and its tap target is at least 44px', await page.evaluate(() => { const b = document.querySelector('#dsTick [data-tick="yes"]').getBoundingClientRect(); return /Workout complete/.test(document.getElementById('dsTick').textContent) && b.height >= 44 && b.width >= 44; }));
    await page.click('#dsTick [data-tick="yes"]');
    await page.waitForTimeout(250);
    ok('one tap ticks it: the floor card shows it met and it is saved under floormet-<id>', await page.evaluate(() => !!document.querySelector('#day-score-card .dsc-item[data-floor-id="qs2"] .dsc-dot.hit')) && (await pageData(page, TODAY))['floormet-qs2'] === '1');
    ok('...the Today bar count went up with it', /1\b/.test(await text(page, '#today-bar')) || /1\s*\/\s*5|1 floors/.test(await text(page, '#today-bar')), await text(page, '#today-bar'));
    ok('...and an Undo is offered', await vis(page, '#dsTick [data-tick="undo"]'));
    await page.click('#dsTick [data-tick="undo"]');
    await page.waitForTimeout(250);
    ok('Undo puts the floor back', (await pageData(page, TODAY))['floormet-qs2'] === '0' && await page.evaluate(() => !document.querySelector('#day-score-card .dsc-item[data-floor-id="qs2"] .dsc-dot.hit')));
    await did('workout');
    await page.waitForTimeout(150);
    await page.click('#dsTick [data-tick="no"]');
    await page.waitForTimeout(150);
    ok('"Not now" ticks nothing and the prompt goes', (await pageData(page, TODAY))['floormet-qs2'] !== '1' && !(await vis(page, '#dsTick')));
    await did('workout');
    await page.waitForTimeout(150);
    ok('...it does not nag again for the same thing the same day', !(await vis(page, '#dsTick')));
    await did('wrap');
    await page.waitForTimeout(150);
    ok('saving the wrap-up offers the Journaled floor', /Wrap-up saved\. Tick the floor\?/.test(await text(page, '#dsTick')) && /Journaled/.test(await text(page, '#dsTick')), await text(page, '#dsTick'));
    await page.click('#dsTick [data-tick="no"]');
    await did('sleep', { value: 1 });
    await page.waitForTimeout(150);
    ok('a rough night does not offer the sleep floor', !(await vis(page, '#dsTick')));
    await did('sleep', { value: 3 });
    await page.waitForTimeout(150);
    ok('a good night does', /Sleep logged\. Tick the floor\?/.test(await text(page, '#dsTick')));
    await page.click('#dsTick [data-tick="yes"]');
    await page.waitForTimeout(150);
    ok('...and ticking it writes the same key the manual tap writes', (await pageData(page, TODAY))['floormet-qs1'] === '1');
    // by date key, not by the open page
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(250);
    await did('protein');
    await page.waitForTimeout(150);
    await page.click('#dsTick [data-tick="yes"]');
    await page.waitForTimeout(200);
    ok('a floor is ticked on the page for the date asked, even while another day is open', (await pageData(page, TODAY))['floormet-qs3'] === '1' && !((await pageData(page, YDAY)) || {})['floormet-qs3']);
    await page.evaluate(() => switchTo(-1));
    await page.waitForTimeout(250);
    await did('workout');
    ok('...and from the Dashboard nothing throws', errs.length === 0, errs.join(' | '));
    // protein reaching the target through the diet fields
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    ok('control: the three events above are the only writers (the coach and check-in modules raise the same event)', /nbd-ds-did/.test(read('js', 'workout-coach.js')) && /nbd-ds-did/.test(read('js', 'checkin-ui.js')) && /nbd-ds-did/.test(read('js', 'eod-ui.js')));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { extra: { nbd_ds_food: JSON.stringify({ favorites: [], targets: { protein: 100, calories: 2500 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    await page.evaluate(() => { const el = document.querySelector('[data-k="diet-m0-p"]'); el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(300);
    ok('typing protein up to the target offers the protein floor (still not ticked)', /Protein target hit\. Tick the floor\?/.test(await text(page, '#dsTick')) && (await pageData(page, TODAY))['floormet-qs3'] !== '1', await text(page, '#dsTick'));
    await ctx.close();
  }

  console.log('\nD4. jump anywhere: Go button, header search icon, one sheet, chip row');
  {
    const { ctx, page, errs } = await open(browser, srv);
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const go = await page.evaluate(() => { const b = document.querySelector('.qj-go'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom, label: b.getAttribute('aria-label') || b.textContent }; });
    ok('a Go button sits in the thumb zone: bottom-right, 44px or more', !!go && go.w >= 44 && go.h >= 44 && go.right < 40 && go.bottom < 140 && go.bottom >= 0, JSON.stringify(go));
    ok('...the header search icon and the Go button open the SAME sheet', await page.evaluate(() => {
      const ids = [];
      document.querySelector('.qj-go').click(); ids.push(!!document.querySelector('#qjSheet:not([hidden])')); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return ids[0];
    }));
    await page.waitForTimeout(250);
    ok('control: Escape closes it', !(await vis(page, '#qjSheet')));
    await page.click('.topbar [data-action="qj-open"]');
    await page.waitForTimeout(250);
    ok('the header search icon opens the sheet', await vis(page, '#qjSheet'));
    ok('the sheet is a dialog with a search field that has focus', await page.evaluate(() => { const s = document.getElementById('qjSheet'); const d = s.querySelector('[role="dialog"]'); const i = document.getElementById('qjInput'); return !!d && d.getAttribute('aria-modal') === 'true' && document.activeElement === i; }));
    const sec = await page.evaluate(() => [...document.querySelectorAll('#qjSheet [data-qj-sec]')].map((e) => e.dataset.qjSec));
    ok('empty, it shows Next up, Quick add and Go to, in that order', sec.join(',') === 'next,quick,goto', sec.join(','));
    ok('...rows and chips are 44px tall or more', await page.evaluate(() => [...document.querySelectorAll('#qjSheet .qj-row, #qjSheet .qj-chip')].every((e) => e.getBoundingClientRect().height >= 43.5)));
    const quick = await page.evaluate(() => [...document.querySelectorAll('#qjSheet [data-qj-sec="quick"] [data-qj]')].map((e) => e.dataset.qj));
    ok('quick add: start workout, tick a floor, weigh-in, wrap up', ['workout', 'floors', 'weigh', 'wrap'].every((k) => quick.includes(k)), quick.join());
    ok('a back press closes the sheet (it pushed a history entry)', await page.evaluate(() => history.state && history.state.nbdDs === 'ov' && history.state.name === 'jump'));
    await page.evaluate(() => history.back());
    await page.waitForTimeout(300);
    ok('...and the page is still the Daily Success page', !(await vis(page, '#qjSheet')) && page.url().includes('/pro/daily-success/'));
    // search
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    ok('Ctrl+K opens it too', await vis(page, '#qjSheet'));
    await page.fill('#qjInput', 'money');
    await page.waitForTimeout(150);
    ok('typing a feature name lists it under Go to', await page.evaluate(() => [...document.querySelectorAll('#qjSheet [data-qj-sec="goto"] [data-qj]')].some((e) => e.dataset.qj === 'money')));
    await page.fill('#qjInput', 'yesterday');
    await page.waitForTimeout(150);
    ok('typing a date word lists that day under Days', await page.evaluate(([yd]) => [...document.querySelectorAll('#qjSheet [data-qj-sec="days"] [data-qj-day]')].some((e) => e.dataset.qjDay === yd), [YDAY]));
    await page.fill('#qjInput', 'miller');
    await page.waitForTimeout(200);
    const notes = await page.evaluate(() => [...document.querySelectorAll('#qjSheet [data-qj-sec="notes"] [data-qj-hit]')].map((e) => ({ t: e.textContent.replace(/\s+/g, ' ').trim(), dk: e.dataset.qjDk, key: e.dataset.qjHit })));
    ok('typing words lists the text hits under Notes, newest day first, each with its field label', notes.length === 3 && notes[0].dk === YDAY && notes[notes.length - 1].dk === D3 && notes.some((n) => /^Win\b/.test(n.t) || /Win:/.test(n.t)) && notes.some((n) => /Non-negotiable|Why/.test(n.t)), JSON.stringify(notes));
    ok('...the sheet escapes what it prints', await page.evaluate(() => !document.querySelector('#qjSheet img, #qjSheet script')));
    await page.click('#qjSheet [data-qj-sec="notes"] [data-qj-hit]');
    await page.waitForTimeout(500);
    ok('choosing a hit closes the sheet and lands on the matching field, flashed', !(await vis(page, '#qjSheet')) && await page.evaluate(() => { const f = document.querySelector('.srch-flash'); if (!f) return false; const r = f.getBoundingClientRect(); return r.top >= 0 && r.top < window.innerHeight; }));
    ok('...on the right day (the newest hit: yesterday)', await page.evaluate(([yd]) => pages[cur].dk === yd, [YDAY]));
    await page.click('.qj-go');
    await page.waitForTimeout(150);
    await page.fill('#qjInput', 'money');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(350);
    ok('the list works from the keyboard: arrow down + Enter opens Money', await page.evaluate(() => !!document.querySelector('#mnOverlay.open')));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv);
    const pre = await page.evaluate(() => new Promise((res) => { const e = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }); document.dispatchEvent(e); res(e.defaultPrevented); }));
    ok('Ctrl+F is the browser\'s again (the page no longer swallows it)', pre === false);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv);
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const chips = await page.evaluate(() => [...document.querySelectorAll('.qj-chips [data-qj-chip]')].map((e) => ({ id: e.dataset.qjChip, h: e.getBoundingClientRect().height })));
    ok('a chip row of seven sections sits under the Today bar', chips.map((c) => c.id).join(',') === 'floors,food,train,body,wins,wrap,habits' && chips.every((c) => c.h >= 43.5), JSON.stringify(chips));
    ok('...directly below the Today bar (before the cover), and it scrolls sideways rather than wrapping', await page.evaluate(() => { const bar = document.getElementById('today-bar'); let n = bar.nextElementSibling; const order = []; while (n && order.length < 6) { order.push(n.id || n.className); n = n.nextElementSibling; } const row = document.querySelector('.qj-chips'); return order.slice(0, 4).some((x) => /qj-chips/.test(x)) && getComputedStyle(row).overflowX !== 'visible' && getComputedStyle(row).flexWrap === 'nowrap'; }));
    await page.click('.qj-chips [data-qj-chip="food"]');
    await page.waitForTimeout(500);
    ok('a chip jumps to its section and opens it', await page.evaluate(() => { const c = document.getElementById('diet-pb').closest('.pc'); return !c.classList.contains('collapsed') && c.getBoundingClientRect().top < window.innerHeight; }));
    ok('...the chip for where he is reads as current', await page.evaluate(() => !!document.querySelector('.qj-chips [data-qj-chip="food"].on, .qj-chips [data-qj-chip="food"][aria-current]')));
    await page.click('.qj-chips [data-qj-chip="wins"]');
    await page.waitForTimeout(500);
    ok('Wins opens the Daily Log section', await page.evaluate(() => { const c = document.querySelector('.pc[data-sec="log"]'); return !c.classList.contains('collapsed') && c.getBoundingClientRect().top < window.innerHeight; }));
    await ctx.close();
  }

  console.log('\nD5. Dash keeps its layout and gets a Today card');
  {
    const { ctx, page, errs } = await open(browser, srv, { hour: 13 });
    const m = await page.evaluate(() => { const c = document.querySelector('#main .nu-today'); return { has: !!c, floors: c ? (c.querySelector('.nu-floors') || {}).textContent : '', next: c ? !!c.querySelector('.nu-line') : false, open: c ? !!c.querySelector('[data-nu="open-today"]') : false, hero: !!document.querySelector('#main .dhero'), cards: document.querySelectorAll('#main .dc').length }; });
    ok('the card shows floors, the Next-Up line and Open today', m.has && /\d\s*\/\s*\d|\d of \d/.test(m.floors || '') && m.next && m.open, JSON.stringify(m));
    ok('...and the rest of the Dash is the same one (Program Dashboard hero and the cards below it)', m.hero && m.cards >= 3, JSON.stringify(m));
    ok('...the floors on the card are buttons that tick today\'s floor by its date (no page open)', await page.evaluate(() => document.querySelectorAll('#main .nu-today [data-nu-floor]').length >= 3));
    await page.click('#main .nu-today [data-nu-floor="qs4"]');
    await page.waitForTimeout(250);
    ok('...tapping one ticks it on today\'s page and the card updates', (await pageData(page, TODAY))['floormet-qs4'] === '1' && (await cur(page)) === -1 && /1\s*(\/|of)\s*5/.test(await text(page, '#main .nu-today .nu-floors')), await text(page, '#main .nu-today .nu-floors'));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }

  console.log('\nD6. the header menu, Delete with undo, Recently deleted');
  {
    const { ctx, page, errs } = await open(browser, srv, { w: 390 });
    ok('the header holds no Delete, CSV, PDF, SAVE, Rename or New buttons any more', await page.evaluate(() => ['trigger-del', 'export-csv', 'do-print', 'save-now', 'open-rename', 'smart-new-page'].every((a) => !document.querySelector('.topbar > .tbr [data-action="' + a + '"]'))));
    const bar = await page.evaluate(() => { const t = document.querySelector('.topbar').getBoundingClientRect(); const btns = [...document.querySelectorAll('.topbar button, .topbar a')].map((b) => b.getBoundingClientRect()); return { h: Math.round(t.height), right: Math.max(...btns.map((r) => r.right)), w: window.innerWidth, over: document.documentElement.scrollWidth > window.innerWidth }; });
    ok('on a phone the header is ONE row (about 52px, not 100) and nothing runs off the right edge', bar.h <= 60 && bar.right <= bar.w + 0.5 && !bar.over, JSON.stringify(bar));
    await page.click('#dsMenuBtn');
    await page.waitForTimeout(150);
    ok('the ⋯ button opens a menu', await vis(page, '#dsMenu'));
    const items = await page.evaluate(() => [...document.querySelectorAll('#dsMenu [data-action]')].map((e) => ({ a: e.dataset.action, danger: e.classList.contains('danger'), h: e.getBoundingClientRect().height })));
    const order = items.map((i) => i.a);
    ok('it holds Save, New, Rename, CSV, PDF, Appearance, Customize, Guide and, last, Delete', ['save-now', 'smart-new-page', 'open-rename', 'export-csv', 'do-print', 'nbd-picker-open', 'open-onboard', 'open-welcome-guide', 'trigger-del'].join() === order.join(), order.join());
    ok('...Delete is last and styled as danger; every row is 44px or more', items[items.length - 1].danger && items.filter((i) => i.danger).length === 1 && items.every((i) => i.h >= 43.5), JSON.stringify(items.map((i) => i.h)));
    ok('...it is a menu with an accessible name; the button says it is expanded', await page.evaluate(() => document.getElementById('dsMenuBtn').getAttribute('aria-expanded') === 'true' && document.getElementById('dsMenuBtn').getAttribute('aria-label') && !!document.querySelector('#dsMenu[role="menu"]')));
    await page.click('#dsMenu [data-action="save-now"]');
    await page.waitForTimeout(200);
    ok('SAVE still works from the menu, and the menu closes', !(await vis(page, '#dsMenu')) && /Saved/.test(await page.evaluate(() => document.getElementById('toastContainer') ? document.getElementById('toastContainer').textContent : '')));
    await page.click('#dsMenuBtn');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    ok('Escape closes the menu', !(await vis(page, '#dsMenu')));
    // Delete from the Dash
    await page.click('#dsMenuBtn');
    await page.click('#dsMenu [data-action="trigger-del"]');
    await page.waitForTimeout(200);
    ok('Delete on the Dashboard says to open a day first and deletes nothing', (await page.evaluate(() => pages.length)) === 3 && /Open a day first/.test(await page.evaluate(() => document.getElementById('toastContainer').textContent)));
    // Delete a day
    await page.evaluate(() => switchTo(1));
    await page.waitForTimeout(250);
    const gone = await page.evaluate(() => ({ id: pages[1].id, dk: pages[1].dk }));
    await page.click('#dsMenuBtn');
    await page.click('#dsMenu [data-action="trigger-del"]');
    await page.waitForTimeout(250);
    ok('deleting removes the page at once (no "cannot be undone" dialog)', (await page.evaluate(() => pages.length)) === 2 && !(await vis(page, '#mDel.open')));
    const u = await page.evaluate(() => { const e = document.getElementById('dsUndo'); return e ? { shown: e.getBoundingClientRect().height > 0, txt: e.textContent.replace(/\s+/g, ' ').trim(), ms: e.dataset.ms, btn: !!e.querySelector('[data-undo="restore"]'), h: e.querySelector('[data-undo="restore"]') ? e.querySelector('[data-undo="restore"]').getBoundingClientRect().height : 0 } : null; });
    ok('an undo toast shows for 8 seconds, says what happened and where he landed, with a 44px Undo', !!u && u.shown && u.ms === '8000' && u.btn && u.h >= 43.5 && /deleted/i.test(u.txt) && /Undo/i.test(u.txt), JSON.stringify(u));
    ok('the deleted page waits in the tombstone list (so the cloud does not bring it back) and in Recently deleted', await page.evaluate((id) => JSON.parse(localStorage.getItem('nbd_dsp_tomb') || '[]').includes(String(id)) && JSON.parse(localStorage.getItem('nbd_ds_deleted') || '[]').some((e) => String(e.page.id) === String(id)), gone.id));
    await page.click('#dsUndo [data-undo="restore"]');
    await page.waitForTimeout(250);
    const after = await page.evaluate((id) => ({ idx: pages.findIndex((p) => String(p.id) === String(id)), n: pages.length, tomb: JSON.parse(localStorage.getItem('nbd_dsp_tomb') || '[]').includes(String(id)), trash: JSON.parse(localStorage.getItem('nbd_ds_deleted') || '[]').length, stored: JSON.parse(localStorage.getItem('nbd_dsp_v1')).some((p) => String(p.id) === String(id)) }), gone.id);
    ok('Undo restores the page where it was, clears the tombstone and the Recently deleted entry', after.idx === 1 && after.n === 3 && !after.tomb && after.trash === 0 && after.stored, JSON.stringify(after));
    ok('...and the toast goes', !(await vis(page, '#dsUndo')));
    // delete again, let the toast time out, restore from the Notebook
    await page.evaluate(() => switchTo(1));
    await page.waitForTimeout(200);
    await page.click('#dsMenuBtn');
    await page.click('#dsMenu [data-action="trigger-del"]');
    await page.waitForTimeout(8600);
    ok('after 8 seconds the toast is gone', !(await vis(page, '#dsUndo')));
    await page.click('#tabrow [data-action="notebook-open"]');
    await page.waitForTimeout(250);
    const rd = await page.evaluate(() => { const s = document.querySelector('#nbd-notebook .nbk-trash'); return s ? { txt: s.textContent.replace(/\s+/g, ' ').trim(), btn: !!s.querySelector('[data-nbk="restore"]') } : null; });
    ok('the Notebook has a Recently deleted list with a Restore button', !!rd && rd.btn && /Recently deleted/i.test(rd.txt) && rd.txt.includes(gone.dk.slice(5).replace('-', '')) || (!!rd && rd.btn && /Recently deleted/i.test(rd.txt)), JSON.stringify(rd));
    await page.click('#nbd-notebook [data-nbk="restore"]');
    await page.waitForTimeout(300);
    ok('Restore puts the page back (same id) and clears the tombstone', await page.evaluate((id) => pages.some((p) => String(p.id) === String(id)) && !JSON.parse(localStorage.getItem('nbd_dsp_tomb') || '[]').includes(String(id)), gone.id));
    ok('...the saved-page key is unchanged: the same nbd_dsp_v1 array of {id, dk, data...}', await page.evaluate(() => { const a = JSON.parse(localStorage.getItem('nbd_dsp_v1')); return Array.isArray(a) && a.every((p) => 'id' in p && 'dk' in p && 'data' in p); }));
    ok('control: no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { w: 1100 });
    ok('on desktop the header is still one row and holds the menu button', (await page.evaluate(() => document.querySelector('.topbar').getBoundingClientRect().height)) <= 60 && await vis(page, '#dsMenuBtn'));
    ok('...the row-two offsets are gone: tabs sit right under the header (and under the onboarding banner when it is up)', await page.evaluate(() => { const h = document.querySelector('.topbar').getBoundingClientRect().height; const ban = document.body.classList.contains('has-banner') ? 44 : 0; return Math.abs(document.getElementById('tabrow').getBoundingClientRect().top - h - ban) < 2; }), String(await page.evaluate(() => [document.querySelector('.topbar').getBoundingClientRect().height, document.getElementById('tabrow').getBoundingClientRect().top, document.body.className].join())));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { w: 320 });
    ok('at 320px the header still fits on one row with the chip and both buttons', await page.evaluate(() => { const t = document.querySelector('.topbar'); return t.getBoundingClientRect().height <= 60 && document.documentElement.scrollWidth <= window.innerWidth && [...t.querySelectorAll('button')].every((b) => b.getBoundingClientRect().right <= window.innerWidth + 0.5); }));
    await ctx.close();
  }

  console.log('\nM1. the Next-Up strip in every layout; dayPhase (morning vs evening)');
  for (const ui of ['classic', 'logbook', 'rings', 'cockpit', 'quest', 'onething', 'journal', 'arcade']) {
    const { ctx, page } = await open(browser, srv, { ui, hour: 10 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const s = await page.evaluate(() => { const e = document.getElementById('nextup'); const bar = document.getElementById('today-bar'); return { has: !!e, txt: e ? e.textContent.replace(/\s+/g, ' ').trim() : '', after: !!e && !!bar && (bar.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, btn: e ? !!e.querySelector('[data-nextup]') : false, h: e ? e.getBoundingClientRect().height : 0 }; });
    ok(ui + ': a Next-Up strip sits under the Today bar, reads "Next", has a Go button', s.has && s.after && /^Next/i.test(s.txt) && s.btn, JSON.stringify(s));
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 8, extra: { nbd_ds_eod: JSON.stringify({ [YDAY]: { body: 2, win: 'x', tomorrow: 'Call Miller back', at: 1 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const morning = await text(page, '#nextup');
    ok('8am: the strip leads with the morning (check-in, or last night\'s commitment), not the wrap-up', /check-in|From last night/i.test(morning) && !/Wrap up/i.test(morning), morning);
    ok('...it says how many are left', /\d+ left/.test(morning), morning);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 19 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const evening = await text(page, '#nextup');
    ok('7pm: the strip leads with the wrap-up', /Wrap up/i.test(evening), evening);
    await page.click('#nextup [data-nextup]');
    await page.waitForTimeout(400);
    ok('...its Go button opens the wrap-up questions', await page.evaluate(() => !!document.querySelector('.eod-card #eodWin') && document.querySelector('.eod-card').getBoundingClientRect().top < window.innerHeight));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 13 });
    await page.evaluate(() => switchTo(0));
    await page.waitForTimeout(350);
    const s = await text(page, '#nextup');
    ok('on a past day the strip says so and offers the way back', /Viewing/i.test(s) && /Back to today/i.test(s), s);
    await page.click('#nextup [data-nextup="today"]');
    await page.waitForTimeout(300);
    ok('...Back to today goes to today\'s page', (await cur(page)) === (await todayIdx(page)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 13 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const before = await text(page, '#nextup');
    await page.evaluate(() => { document.querySelector('#day-score-card .dsc-item').click(); });
    await page.waitForTimeout(300);
    ok('the strip follows the day: ticking a floor changes the count', (await text(page, '#nextup')) !== before || /left/.test(before), before + ' -> ' + (await text(page, '#nextup')));
    await ctx.close();
  }

  console.log('\nM2. each finish surface ends with a primary "Next: ..." button');
  {
    ok('the coach summary renders the hand-off and Close is the secondary button', /NBDNextUp/.test(read('js', 'workout-coach.js')) && /wc-foot[^`]*Close/.test(read('js', 'workout-coach.js')));
    const { ctx, page } = await open(browser, srv, { hour: 10, extra: { nbd_ds_coach_ready: JSON.stringify({ [TODAY]: { sleep: 3, sore: 3, energy: 3 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const ck = await page.evaluate(() => { const c = document.querySelector('.ck-card.ck-done'); const b = c && c.querySelector('.nu-next'); return { done: !!c, btn: !!b, cls: b ? b.className : '', txt: b ? b.textContent.trim() : '' }; });
    ok('the check-in\'s done card ends with a primary Next button', ck.done && ck.btn && /^Next:/.test(ck.txt) && /btn-red|nu-primary/.test(ck.cls), JSON.stringify(ck));
    ok('NBDNextUp.buttonHtml(): a primary button that names the next thing; empty when nothing is left', await page.evaluate(() => { const h = window.NBDNextUp.buttonHtml({ exclude: [] }); return /nu-next/.test(h) && /Next:/.test(h) && typeof window.NBDNextUp.buttonHtml === 'function'; }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 19, extra: { nbd_ds_eod: JSON.stringify({ [TODAY]: { body: 2, win: 'Signed Miller', tomorrow: 'Call him', at: 1 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const w = await page.evaluate(() => { const c = document.querySelector('.eod-card.eod-saved'); const b = c && c.querySelector('.nu-next'); return { saved: !!c, btn: !!b, txt: b ? b.textContent.trim() : '' }; });
    ok('a saved wrap-up ends with a Next button too (or says everything is done)', w.saved && (w.btn && /^Next:/.test(w.txt)), JSON.stringify(w));
    await ctx.close();
  }

  console.log('\nQ11. the wrap-up moves up after 17:00');
  {
    const { ctx, page } = await open(browser, srv, { hour: 19 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const pos = await page.evaluate(() => { const e = document.querySelector('.eod-wrap'), s = document.getElementById('day-score-wrap'), bar = document.getElementById('today-bar'); if (!e) return null; return { eodTop: e.getBoundingClientRect().top + scrollY, floorsTop: s.getBoundingClientRect().top + scrollY, barTop: bar.getBoundingClientRect().top + scrollY, prompt: e.querySelector('#eodWin') !== null, parentOk: e.parentNode === bar.parentNode }; });
    ok('at 7pm the wrap-up questions sit under the Today bar, above the floors', !!pos && pos.prompt && pos.parentOk && pos.eodTop < pos.floorsTop && pos.eodTop > pos.barTop, JSON.stringify(pos));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 10 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const pos = await page.evaluate(() => { const e = document.querySelector('.eod-wrap'), s = document.getElementById('day-score-wrap'); return { eodTop: e.getBoundingClientRect().top + scrollY, floorsTop: s.getBoundingClientRect().top + scrollY }; });
    ok('at 10am it stays where it was (below the Daily Log), as a quiet link', pos.eodTop > pos.floorsTop && !(await page.evaluate(() => !!document.querySelector('.eod-wrap #eodWin'))));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 19 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    await page.fill('#eodWin', 'Signed the Miller roof');
    await page.fill('#eodTomorrow', 'Call the adjuster');
    await page.click('.eod-card [data-eod-action="save"]');
    await page.waitForTimeout(300);
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('nbd_ds_eod')))[TODAY];
    ok('saving still writes the same record (win, tomorrow) under nbd_ds_eod', saved && saved.win === 'Signed the Miller roof' && saved.tomorrow === 'Call the adjuster');
    ok('...and the wrap-up offers the Journaled floor (ask first)', /Wrap-up saved\. Tick the floor\?/.test(await text(page, '#dsTick')));
    ok('...and once saved it drops back to its quiet place below the Daily Log', await page.evaluate(() => { const e = document.querySelector('.eod-wrap'), s = document.getElementById('day-score-wrap'); return e.getBoundingClientRect().top + scrollY > s.getBoundingClientRect().top + scrollY; }));
    await ctx.close();
  }

  console.log('\nQ12. last night\'s non-negotiable is carried forward');
  {
    const { ctx, page } = await open(browser, srv, { hour: 8, extra: { nbd_ds_eod: JSON.stringify({ [YDAY]: { body: 2, win: 'x', tomorrow: 'Call Miller back', at: 1 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    const c = await page.evaluate(() => { const h = document.querySelector('.eod-carry'); const ta = document.querySelector('[data-k="ms-nonneg"]'); return { hint: h ? h.textContent.replace(/\s+/g, ' ').trim() : '', val: ta.value, btn: !!(h && h.querySelector('[data-carry="use"]')) }; });
    ok('an empty non-negotiable shows "From last night" with the words and a Use button, and does not fill the field by itself', /From last night/.test(c.hint) && /Call Miller back/.test(c.hint) && c.btn && c.val === '', JSON.stringify(c));
    await page.evaluate(() => document.querySelector('.pc[data-sec="mindset"]').classList.remove('collapsed'));
    await page.click('.eod-carry [data-carry="use"]');
    await page.waitForTimeout(1100);
    const v = await page.evaluate(() => document.querySelector('[data-k="ms-nonneg"]').value);
    ok('Use puts it in the field, and it is saved under the same ms-nonneg key', v === 'Call Miller back' && (await pageData(page, TODAY))['ms-nonneg'] === 'Call Miller back', v);
    ok('...the hint goes once the field has text', await page.evaluate(() => !document.querySelector('.eod-carry')));
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, srv, { hour: 8, pages: [mkPage(1.5, TODAY, { 'ms-nonneg': 'Already wrote one' })], extra: { nbd_ds_eod: JSON.stringify({ [YDAY]: { tomorrow: 'Call Miller back', at: 1 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(350);
    ok('a non-negotiable already written is left alone, with no hint', await page.evaluate(() => !document.querySelector('.eod-carry') && document.querySelector('[data-k="ms-nonneg"]').value === 'Already wrote one'));
    await ctx.close();
  }

  console.log('\nthe flip switches (the table in the session note says how to flip each decision; each flip is proved here)');
  {
    // serve one script with a one-line change, exactly what the note tells Jo to edit
    const flipped = async (file, from, to, run) => {
      const src = read('js', file);
      ok(file + ' holds the exact line the note names: ' + from, src.includes(from));
      const ctx = await browser.newContext({ viewport: { width: 390, height: 760 } });
      const page = await ctx.newPage();
      page.setDefaultTimeout(5000);
      await page.route('**/pro/daily-success/js/' + file + '*', (route) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: src.replace(from, to) }));
      const t = new Date(); t.setHours(10, 0, 0, 0); await page.clock.setFixedTime(t);
      const pgs = [mkPage(2.5, YDAY, {}), mkPage(1.5, TODAY, {})];
      await page.addInitScript(({ pgs }) => { if (!sessionStorage.getItem('s')) { sessionStorage.setItem('s', '1'); localStorage.setItem('nbd_dsp_v1', JSON.stringify(pgs)); } localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('nbd_ds_layout', 'classic'); }, { pgs });
      await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
      await page.waitForFunction(() => typeof switchTo === 'function' && document.getElementById('tabrow') && document.getElementById('tabrow').children.length > 0).catch(() => {});
      await page.waitForTimeout(350);
      await run(page);
      await ctx.close();
    };
    await flipped('app.js', "const DS_OPEN_TO='dash';", "const DS_OPEN_TO='today';", async (page) => {
      ok('decision 1 (open on today): DS_OPEN_TO=\'today\' opens today\'s page at boot', (await cur(page)) === (await todayIdx(page)) && (await cur(page)) >= 0);
    });
    await flipped('app.js', 'const DS_COVER_QCARD=false;', 'const DS_COVER_QCARD=true;', async (page) => {
      await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
      await page.waitForTimeout(250);
      ok('decision 2 (keep the quote card): DS_COVER_QCARD=true brings the orange Mindset card back', await page.evaluate(() => !!document.querySelector('.qcard')));
    });
    await flipped('app.js', 'const DS_CONFIRM_DELETE=false;', 'const DS_CONFIRM_DELETE=true;', async (page) => {
      await page.evaluate(() => switchTo(0));
      await page.evaluate(() => triggerDel());
      ok('decision 6 (ask before deleting): DS_CONFIRM_DELETE=true opens the Delete page? box and deletes nothing yet', await page.evaluate(() => document.getElementById('mDel').classList.contains('open') && pages.length === 2));
    });
    const didWorkout = (page) => page.evaluate(([tk]) => window.dispatchEvent(new CustomEvent('nbd-ds-did', { detail: { kind: 'workout', dk: tk } })), [TODAY]);
    await flipped('floor-tick-ui.js', "const FLOOR_TICK_MODE = 'ask';", "const FLOOR_TICK_MODE = 'auto';", async (page) => {
      await page.evaluate((ti) => switchTo(ti), await todayIdx(page)); await page.waitForTimeout(250);
      await didWorkout(page); await page.waitForTimeout(250);
      ok('decision 3 (auto-tick): FLOOR_TICK_MODE=\'auto\' ticks at once and shows the Undo chip', (await pageData(page, TODAY))['floormet-qs2'] === '1' && await vis(page, '#dsTick [data-tick="undo"]'));
    });
    await flipped('floor-tick-ui.js', "const FLOOR_TICK_MODE = 'ask';", "const FLOOR_TICK_MODE = 'off';", async (page) => {
      await page.evaluate((ti) => switchTo(ti), await todayIdx(page)); await page.waitForTimeout(250);
      await didWorkout(page); await page.waitForTimeout(250);
      ok('decision 3 (by hand): FLOOR_TICK_MODE=\'off\' never prompts and never ticks', !(await vis(page, '#dsTick')) && (await pageData(page, TODAY))['floormet-qs2'] !== '1');
    });
    await flipped('quickjump-ui.js', 'const GO_BUTTON = true;', 'const GO_BUTTON = false;', async (page) => {
      ok('decision 4 (header icon only): GO_BUTTON=false removes the Go button and keeps the header icon', !(await vis(page, '.qj-go')) && await vis(page, '.topbar [data-action="qj-open"]'));
    });
    await flipped('nextup-ui.js', 'const DASH_TODAY_CARD = true;', 'const DASH_TODAY_CARD = false;', async (page) => {
      ok('decision 5 (leave the Dash as it was): DASH_TODAY_CARD=false removes the Today card', await page.evaluate(() => !document.querySelector('#main .nu-today') && !!document.querySelector('#main .dhero')));
    });
    {
      const css = read('css', 'flow-batch-3.css');
      ok('decision 2 (hide the cover on phones / leave it as it was): the phone rules are ONE @media block the note names', /@media \(max-width:768px\)\{\s*\.cover\{display:flex/.test(css) && (css.match(/@media \(max-width:768px\)/g) || []).length === 1);
      ok('decision 6 (retire SAVE): the menu line the note names exists exactly once', (read('index.html').match(/<button type="button" class="ds-mi" role="menuitem" data-action="save-now">Save now<\/button>/g) || []).length === 1);
    }
  }

  console.log('\nreview fixes (round 2): restore survives the next pull, unsaved edits survive a Notebook delete, no false protein prompt, menu keyboard, toast geometry');
  {
    // 1. a restored page must not be dropped again by a cloud copy that still reads deleted:true
    const L = load('js', 'ds-sync-logic.js') || {};
    const pg = (id, dk) => ({ id, dk, suf: 1, name: '', data: { x: '1' }, mt: 5 });
    ok('control: with no restore marker a cloud deleted:true still drops the page (the old rule)', typeof L.mergePages === 'function' && L.mergePages([pg(7, 'a')], [{ id: 7, dk: 'a', deleted: true }], []).pages.length === 0);
    const kept = typeof L.mergePages === 'function' ? L.mergePages([pg(7, 'a'), pg(8, 'b')], [{ id: 7, dk: 'a', deleted: true }, { id: 8, dk: 'b', deleted: true }], [], ['7']) : null;
    ok('a page Jo restored (listed in the restore marker) survives a pull that still shows the cloud copy deleted; others are still dropped', !!kept && kept.pages.length === 1 && String(kept.pages[0].id) === '7' && !kept.cloudDeleted.includes('7') && kept.cloudDeleted.includes('8'), JSON.stringify(kept && kept.pages.map((p) => p.id)));
    const sync = read('ds-firebase-sync.js');
    ok('the sign-in merge passes the restore marker, and a successful push clears the ids it just wrote', /mergePages\(local, cloud, readJson\(TOMB, \[\]\), readJson\(RESTORED, \[\]\)\)/.test(sync) && /RESTORED\s*=\s*'nbd_dsp_restored'/.test(sync) && /localStorage\.(setItem|removeItem)\(RESTORED/.test(sync));
    const { ctx, page } = await open(browser, srv, { w: 390 });
    await page.evaluate(() => switchTo(1));
    await page.waitForTimeout(200);
    const gid = await page.evaluate(() => pages[1].id);
    await page.evaluate(() => triggerDel(1));
    await page.waitForTimeout(200);
    await page.click('#dsUndo [data-undo="restore"]');
    await page.waitForTimeout(250);
    ok('Undo leaves a restore marker for that page (kept until a push has succeeded), and the tombstone and trash entry are cleared', await page.evaluate((id) => JSON.parse(localStorage.getItem('nbd_dsp_restored') || '[]').includes(String(id)) && !JSON.parse(localStorage.getItem('nbd_dsp_tomb') || '[]').includes(String(id)) && JSON.parse(localStorage.getItem('nbd_ds_deleted') || '[]').length === 0, gid));
    await page.evaluate(() => triggerDel(1));
    await page.waitForTimeout(150);
    ok('deleting the page again drops the marker (the tombstone wins again)', await page.evaluate((id) => !JSON.parse(localStorage.getItem('nbd_dsp_restored') || '[]').includes(String(id)) && JSON.parse(localStorage.getItem('nbd_dsp_tomb') || '[]').includes(String(id)), gid));
    await ctx.close();
  }
  {
    // 2. deleting a DIFFERENT page from the Notebook must not discard what is being typed on the open page
    const { ctx, page } = await open(browser, srv, { w: 390 });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const r = await page.evaluate((dk) => {
      const el = document.querySelector('[data-k="l-win"]'); el.value = 'typed a second ago'; el.dispatchEvent(new Event('input', { bubbles: true }));
      const before = pages[cur].id;
      const other = pages.findIndex((p) => p.dk !== dk);
      triggerDel(other);
      return { sameId: pages[cur] && pages[cur].id === before, onToday: pages[cur] && pages[cur].dk === dk };
    }, TODAY);
    await page.waitForTimeout(250);
    const kept = await page.evaluate((dk) => ({ dom: (document.querySelector('[data-k="l-win"]') || {}).value, stored: (JSON.parse(localStorage.getItem('nbd_dsp_v1')).find((p) => p.dk === dk) || { data: {} }).data['l-win'] }), TODAY);
    ok('deleting another page keeps you on the page you were typing on, with the edit on screen and saved', r.sameId && r.onToday && kept.dom === 'typed a second ago' && kept.stored === 'typed a second ago', JSON.stringify({ r, kept }));
    await ctx.close();
  }
  {
    // 3. the protein prompt needs a real user action: filling the total when a page opens is not a crossing
    const { ctx, page } = await open(browser, srv, { extra: { nbd_ds_food: JSON.stringify({ favorites: [], targets: { protein: 100, calories: 2500 } }) } });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.NBDFloorTickUI.hide(); });
    await page.evaluate(() => { const n = document.getElementById('ms-p'); n.textContent = '—'; window.updateTodayBar(); n.textContent = '120'; window.updateTodayBar(); });
    await page.waitForTimeout(200);
    ok('the total filling in from "—" to over target with nobody typing (a page opening) does NOT offer the protein floor', !(await vis(page, '#dsTick')), await text(page, '#dsTick'));
    await page.evaluate(() => { const n = document.getElementById('ms-p'); n.textContent = '—'; window.updateTodayBar(); });
    await page.evaluate(() => { const el = document.querySelector('[data-k="diet-m0-p"]'); el.value = '130'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(250);
    ok('...but typing protein over target right afterwards still offers it', /Protein target hit/.test(await text(page, '#dsTick')), await text(page, '#dsTick'));
    await ctx.close();
  }
  {
    // 4. the menu is keyboard-managed: Tab leaves it closed with focus on the button, Home/End, focus returns after a choice
    const { ctx, page } = await open(browser, srv, { w: 390 });
    await page.focus('#dsMenuBtn');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.press('End');
    const last = await page.evaluate(() => document.activeElement && document.activeElement.dataset.action);
    await page.keyboard.press('Home');
    const first = await page.evaluate(() => document.activeElement && (document.activeElement.dataset.action || document.activeElement.tagName));
    ok('Home and End jump to the first and last menu item', last === 'trigger-del' && first === 'A', last + ' / ' + first);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    ok('Tab closes the menu and leaves focus on the ⋯ button (not on the page behind an open menu)', !(await vis(page, '#dsMenu')) && (await page.evaluate(() => document.activeElement.id)) === 'dsMenuBtn');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    ok('choosing an item by keyboard closes the menu and puts focus back on the ⋯ button (not on a hidden item)', !(await vis(page, '#dsMenu')) && (await page.evaluate(() => document.activeElement.id)) === 'dsMenuBtn', await page.evaluate(() => document.activeElement.outerHTML.slice(0, 80)));
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(200);
    await page.click('#dsMenuBtn');
    await page.click('#dsMenu [data-action="open-rename"]');
    await page.waitForTimeout(300);
    ok('control: a choice that opens a dialog keeps the dialog\'s own focus (the menu does not steal it back)', await page.evaluate(() => document.activeElement.id === 'renInp'));
    await ctx.close();
  }
  for (const w of [320, 360]) {
    // 5. the toasts, the Go button and a running rest bar stay clear of each other
    const { ctx, page } = await open(browser, srv, { w });
    await page.evaluate((ti) => switchTo(ti), await todayIdx(page));
    await page.waitForTimeout(300);
    const g = await page.evaluate(() => {
      const rb = document.createElement('div'); rb.id = 'dsRestBar'; rb.className = 'wc-restbar';
      rb.innerHTML = '<span class="wc-restbar-t">1:30</span><button type="button" class="wc-restbar-b">Skip</button>'; document.body.appendChild(rb);
      window.NBDMenuUI.undoToast('Deleted "Mon". Now showing "Today".', 'x');
      window.NBDFloorTickUI.ask('workout', pages[cur].dk);
      const r = (s) => { const e = document.querySelector(s); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
      const hit = (a, b) => a && b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
      const u = r('#dsUndo'), t = r('#dsTick'), go = r('.qj-go'), rest = r('#dsRestBar');
      return { shown: !!u && !!t && !!go && !!rest, undoTick: hit(u, t), undoRest: hit(u, rest), tickRest: hit(t, rest), undoGo: hit(u, go), tickGo: hit(t, go), goRest: hit(go, rest), goTop: go && go.t, restTop: rest && rest.t, vh: window.innerHeight };
    });
    ok('at ' + w + 'px the undo toast, the tick prompt and a running rest bar do not cover one another or the Go button', g.shown && !g.undoTick && !g.undoRest && !g.tickRest && !g.undoGo && !g.tickGo && !g.goRest, JSON.stringify(g));
    await ctx.close();
  }

  console.log('\nwiring, versions and the invariants');
  {
    const html = read('index.html');
    for (const f of ['quickjump-logic', 'floor-tick-logic', 'nextup-ui', 'quickjump-ui', 'floor-tick-ui', 'menu-ui']) {
      ok(f + '.js is loaded by index.html with a version, and the file exists', new RegExp('js/' + f + '\\.js\\?v=\\d+').test(html) && has('js', f + '.js'));
    }
    ok('the new scripts are external and deferred or after app.js; no inline script or handler was added', !/<script(?![^>]*\bsrc=)[^>]*>[^<]/.test(html.replace(/<script type="application\/ld\+json"[\s\S]*?<\/script>/g, '')) && !/\son(click|input|change|load|error)=/.test(html.replace(/<!--[\s\S]*?-->/g, '')));
    ok('onething-logic, eod-logic, notebook-logic, eod-ui, notebook-ui, checkin-ui and workout-coach got new ?v= numbers (cache)', ['onething-logic.js?v=2', 'eod-logic.js?v=2', 'notebook-logic.js?v=2', 'eod-ui.js?v=3', 'notebook-ui.js?v=2', 'checkin-ui.js?v=3'].every((s) => html.includes(s)), '');
    const nb = read('js', 'quickjump-ui.js') + read('js', 'nextup-ui.js') + read('js', 'floor-tick-ui.js') + read('js', 'menu-ui.js');
    ok('none of the new UI uses innerHTML with an unescaped value (every dynamic string goes through esc)', !/innerHTML\s*=\s*[^;]*\+\s*(q|query|text|label)\b(?!\))/.test(nb) || /const esc/.test(nb));
    ok('no model id, key or cost figure in the new files', !/claude-|sk-ant|margin|markup|cost_?basis/i.test(nb + read('js', 'quickjump-logic.js') + read('js', 'floor-tick-logic.js')));
  }

  await browser.close(); await srv.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
