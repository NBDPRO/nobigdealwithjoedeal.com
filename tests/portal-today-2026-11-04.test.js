/**
 * tests/portal-today-2026-11-04.test.js
 *
 * Customer portal Phase 2 (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 * the install-day "Today" card.
 *
 *   1. functions/portal-today.js (pure): when the card shows, its heading
 *      key, the crew COMPANY only, the weather days, and the rep's note
 *      (fresh, capped, and dropped when it trips the KY claim-wording rules).
 *   2. loadToday: tenant-scoped crew lookup, never lead.crew; a slow
 *      forecast is skipped instead of holding the portal.
 *   3. Wording: TODAY_COPY has no claim words and no "our team"; rain says
 *      the day MAY move, never that it moved.
 *   4. Wiring: getHomeownerPortalView ships view.today with the copy;
 *      portal.js renders it first, escapes the note, and only shows a rep
 *      photo; the CRM button checks wording and writes {text, atMs} / null;
 *      firestore.rules shape-checks portalNote; viewers are gated.
 *
 * Run: node tests/portal-today-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

(async () => {
  const T = require(path.join(ROOT, 'functions/portal-today.js'));
  const PF = require(path.join(ROOT, 'functions/production-flow-logic.js'));
  const SW = require(path.join(ROOT, 'functions/schedule-window.js'));

  // Noon New York time on a fixed day, so the day maths never sits on an edge.
  const NOW = Date.UTC(2026, 10, 10, 17, 0, 0);
  const TODAY = PF.nyDate(NOW);
  const TOMORROW = SW.addDays(TODAY, 1);
  const IN3 = SW.addDays(TODAY, 3);
  const IN10 = SW.addDays(TODAY, 10);

  console.log('\n1. todayCard (pure)');
  ok('no job day, not working, no note → no card', T.todayCard({ stage: 'estimate_sent' }, { nowMs: NOW }) === null);
  ok('a build day 10 days out → no card yet', T.todayCard({ scheduledDate: IN10 }, { nowMs: NOW }) === null);
  const c0 = T.todayCard({ scheduledDate: TODAY }, { nowMs: NOW, repName: 'Joe Deal' });
  ok('build day today → when=today', c0 && c0.when === 'today', JSON.stringify(c0));
  ok('rep is the first name only', c0 && c0.rep === 'Joe');
  ok('no rep name → "your rep"', T.repFirst('') === 'your rep' && T.repFirst('Your rep') === 'your rep');
  ok('tomorrow → when=tomorrow', (T.todayCard({ scheduledDate: TOMORROW }, { nowMs: NOW }) || {}).when === 'tomorrow');
  ok('in 3 days → when=soon', (T.todayCard({ scheduledDate: IN3 }, { nowMs: NOW }) || {}).when === 'soon');
  ok('install_in_progress with no date → when=working', (T.todayCard({ stage: 'install_in_progress' }, { nowMs: NOW }) || {}).when === 'working');
  const multi = T.todayCard({ scheduledDate: SW.addDays(TODAY, -1), scheduledEndDate: TOMORROW }, { nowMs: NOW });
  ok('a 3-day job that started yesterday → today, days from today on', multi && multi.when === 'today' && multi.days.join() === [TODAY, TOMORROW].join(), JSON.stringify(multi));
  const wx = T.todayCard({ scheduledDate: TODAY }, { nowMs: NOW, weather: { [TODAY]: { level: 'warn', label: 'Thunderstorms likely' }, [IN10]: { level: 'ok', label: 'x' } } });
  ok('weather only for the job days', wx.weather.length === 1 && wx.weather[0].level === 'warn' && wx.weather[0].date === TODAY);
  const badWx = T.todayCard({ scheduledDate: TODAY }, { nowMs: NOW, weather: { [TODAY]: { level: '<script>', label: 'x' } } });
  ok('an unknown weather level is dropped', badWx.weather.length === 0);
  ok('crew is a trimmed, capped string or null', T.todayCard({ scheduledDate: TODAY }, { nowMs: NOW, crewName: '  ' }).crew === null
    && T.todayCard({ scheduledDate: TODAY }, { nowMs: NOW, crewName: 'X'.repeat(90) }).crew.length === 60);

  console.log('\n2. noteFor');
  const fresh = { text: '  Crew arrives 7:30.\n Please move the cars.  ', atMs: NOW - 3600e3 };
  const n1 = T.noteFor({ portalNote: fresh }, NOW);
  ok('fresh note → whitespace collapsed', n1 && n1.text === 'Crew arrives 7:30. Please move the cars.', JSON.stringify(n1));
  ok('a note alone shows the card (when=note)', (T.todayCard({ portalNote: fresh }, { nowMs: NOW }) || {}).when === 'note');
  ok('older than 7 days → hidden', T.noteFor({ portalNote: { text: 'hi', atMs: NOW - T.NOTE_FRESH_MS - 1 } }, NOW) === null);
  ok('dated more than an hour ahead → hidden', T.noteFor({ portalNote: { text: 'hi', atMs: NOW + 2 * 3600e3 } }, NOW) === null);
  ok('blank / malformed → hidden', T.noteFor({ portalNote: { text: '   ', atMs: NOW } }, NOW) === null
    && T.noteFor({ portalNote: 'hello' }, NOW) === null && T.noteFor({ portalNote: { text: 'hi' } }, NOW) === null);
  ok('capped at 160', T.noteFor({ portalNote: { text: 'a'.repeat(400), atMs: NOW } }, NOW).text.length === T.NOTE_MAX && T.NOTE_MAX === 160);
  ok('KY claim wording → dropped on the server', T.noteFor({ portalNote: { text: 'We will handle your insurance claim for you.', atMs: NOW } }, NOW) === null);
  ok('control: plain wording passes the same check', T.noteFor({ portalNote: { text: 'Dumpster arrives Monday morning.', atMs: NOW } }, NOW) !== null);

  console.log('\n3. loadToday');
  const reads = [];
  const db = {
    doc(p) {
      reads.push(p);
      return { get: async () => (p === 'companies/co_nbd/subs/sub1'
        ? { exists: true, data: () => ({ company: 'Ridgeline Roofing LLC', phone: '555-0100', contactName: 'Mike' }) }
        : { exists: false, data: () => null }) };
    },
  };
  const fastWx = { weatherByDay: async () => ({ [TODAY]: { level: 'watch', label: 'Chance of showers' } }) };
  const lead = { scheduledDate: TODAY, subId: 'sub1', crew: 'Mike', lat: 39.1, lng: -84.5 };
  const L1 = await T.loadToday(db, lead, { tenant: 'co_nbd', repName: 'Joe', nowMs: NOW, jobWeather: fastWx });
  ok('crew = the sub COMPANY name', L1 && L1.crew === 'Ridgeline Roofing LLC', JSON.stringify(L1));
  ok('no crew phone or person name leaks into the card', !/555-0100|Mike/.test(JSON.stringify(L1)));
  ok('weather comes through', L1.weather.length === 1 && L1.weather[0].level === 'watch');
  reads.length = 0;
  const L2 = await T.loadToday(db, lead, { tenant: 'co_other', nowMs: NOW, jobWeather: fastWx });
  ok('another tenant\'s token never reads co_nbd\'s subs', reads.every((p) => p.indexOf('companies/co_other/') === 0) && L2.crew === null);
  const L3 = await T.loadToday(db, { scheduledDate: TODAY, crew: 'Mike' }, { tenant: 'co_nbd', nowMs: NOW, jobWeather: fastWx });
  ok('no subId → no crew line (lead.crew is never the fallback)', L3.crew === null);
  ok('a path-y subId is refused', await T.crewNameFor(db, { subId: '../x' }, 'co_nbd') === null);
  const slowWx = { weatherByDay: () => new Promise((r) => setTimeout(() => r({ [TODAY]: { level: 'ok', label: 'Sunny' } }), 400)) };
  const t0 = Date.now();
  const L4 = await T.loadToday(db, lead, { tenant: 'co_nbd', nowMs: NOW, jobWeather: slowWx, weatherBudgetMs: 50 });
  ok('a slow forecast is skipped, not waited on', L4 && L4.weather.length === 0 && Date.now() - t0 < 350, String(Date.now() - t0));
  const L5 = await T.loadToday(db, lead, { tenant: 'co_nbd', nowMs: NOW, jobWeather: { weatherByDay: async () => { throw new Error('nws down'); } } });
  ok('a forecast error never throws', L5 && L5.weather.length === 0);
  ok('nothing to show → no lookups at all', (reads.length = 0, await T.loadToday(db, { stage: 'new' }, { tenant: 'co_nbd', nowMs: NOW, jobWeather: fastWx })) === null && reads.length === 0);

  console.log('\n4. wording');
  const copy = Object.values(T.TODAY_COPY).join(' | ');
  ok('no claim / carrier / adjuster / deductible words', !/\b(claim|carrier|adjuster|deductible|insurance)\b/i.test(copy));
  ok('no "our team" / "in-house"; the crew is called independent', !/our team|in-house|our crew|employees/i.test(copy) && /independent crew/.test(T.TODAY_COPY.crewLine));
  ok('rain says MAY move, never "moved" / "cancelled"', /may move/i.test(T.TODAY_COPY.weatherWarn) && !/\b(moved|cancel)/i.test(copy));
  ok('the copy table is frozen', Object.isFrozen(T.TODAY_COPY));
  const CW = require(path.join(ROOT, 'functions/social-claim-wording.js'));
  ok('every line passes the KY scanner', Object.values(T.TODAY_COPY).every((s) => CW.scanText(s).length === 0));

  console.log('\n5. wiring');
  const portalFn = stripComments(read('functions/portal.js'));
  ok('view.today is built with the copy attached', /today: _today \? Object\.assign\(\{ copy: PortalToday\.TODAY_COPY \}, _today\) : null/.test(portalFn));
  ok('the view is tenant-scoped (loadToday gets tenant)', /PortalToday\.loadToday\(db, lead, \{ tenant,/.test(portalFn));
  ok('a Today failure never breaks the portal (try/catch)', /try \{\s*_today = await PortalToday\.loadToday[\s\S]{0,200}\} catch/.test(portalFn));
  const pjs = stripComments(read('docs/pro/js/portal.js'));
  const iToday = pjs.indexOf('id="today-card"'), iProg = pjs.indexOf('Project progress tracker') === -1 ? pjs.indexOf('progress-steps') : pjs.indexOf('Project progress tracker');
  ok('the card renders before the progress tracker', iToday > 0 && (iProg === -1 || iToday < pjs.indexOf('class="progress-steps') || iToday < iProg));
  ok('the note is escaped', /esc\(tdy\.note\.text\)/.test(pjs));
  ok('only a rep-shared photo (never the homeowner\'s own)', /ph\.source !== 'homeowner'/.test(pjs) && /safeUrl\(latest\.urls\.thumb\)/.test(pjs));
  ok('install-day changes go to the message box, not self-serve', /href="#pm-card">' \+ esc\(fillT\(tc\.changeAsk\)\)/.test(pjs) && /id="pm-card"/.test(pjs));
  const html = read('docs/pro/portal.html');
  ok('portal CSS has the card styles', /\.today-card\b/.test(html) && /\.today-wx-note\[data-level="warn"\]/.test(html));
  ok('portal.js cache-buster bumped (v>=20)', Number((html.match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 20);

  const share = stripComments(read('docs/pro/js/customer-gallery-share.js'));
  ok('CRM: button wired', /id="portalNoteBtn" data-action="editPortalNote"/.test(read('docs/pro/customer.html')));
  ok('CRM: handler checks the KY wording before writing', /NBDClaimWording\.scanText\(text\);\s*if \(hits\.length\) \{[^}]{0,200}return; \}/.test(share)
    && share.indexOf('scanText(text)') < share.indexOf("{ portalNote: note }"));
  ok('CRM: writes {text, atMs} or null, nothing else', /const note = text \? \{ text, atMs: Date\.now\(\) \} : null;/.test(share) && /\{ portalNote: note \}/.test(share));
  ok('CRM: refuses over 160 before writing', /text\.length > PORTAL_NOTE_MAX/.test(share) && /const PORTAL_NOTE_MAX = 160;/.test(share));
  ok('CRM: viewers are gated (role-gate WRITE_ACTIONS)', /'editPortalNote'/.test(read('docs/pro/js/role-gate.js')));

  const rules = read('firestore.rules');
  ok('rules: portalNote shape check exists', /function portalNoteOk\(\)[\s\S]{0,400}n\.keys\(\)\.hasOnly\(\['text', 'atMs'\]\)[\s\S]{0,120}n\.text\.size\(\) <= 160[\s\S]{0,60}n\.atMs is number/.test(rules));
  ok('rules: wired into the leads update', /&& scheduleWindowOk\(\)\s*&& portalNoteOk\(\)\s*\);/.test(rules));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
