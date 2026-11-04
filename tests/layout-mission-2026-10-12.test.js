/**
 * tests/layout-mission-2026-10-12.test.js - M2: L02 Mission Control
 * (js/layouts/mission-logic.js + mission.js + css, the storm-mode.js context
 * switch and the registry entry).
 *
 *   1. in the path: only addresses inside a warning, biggest hail first;
 *      0,0 / deleted / test leads never count
 *   2. hail at an address: warning size + nearest REPORT within range and age
 *   3. turfs: cuts conserve the area, balance doors, stay inside the warning
 *   4. knock stats: HOT dispositions, per-turf and overall rates
 *   5. timeline window + playback
 *   6. the context switch is only ever an OFFER: locked / not allowed / wrong
 *      screen / already there / dismissed / Storm Mode off -> no offer
 *   7. wording: the script and every string in the layout go through the
 *      claim-wording filter (with a control that it can fail)
 *   8. registry + lazy assets, and the draft hand-off sends nothing
 *
 * Run: node tests/layout-mission-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n      ' + detail : '')); }
}

const ML = require(path.join(ROOT, 'docs/pro/js/layouts/mission-logic.js'));
const SM = require(path.join(ROOT, 'docs/pro/js/storm-mode.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));

// a warning over the western half of a 0.2 x 0.4 degree box
const BOX = [[39.0, -84.8], [39.0, -84.4], [39.2, -84.4], [39.2, -84.8]];
const W1 = { id: 'w1', event: 'Severe Thunderstorm Warning', hazard: 'hail', hailIn: 1.75, rings: [BOX] };
const lead = (id, lat, lng, x) => Object.assign({ id, lat, lng }, x || {});

console.log('\n1. in the path');
{
  const leads = [lead('in', 39.1, -84.6), lead('out', 39.5, -84.6), lead('zero', 0, 0), lead('del', 39.1, -84.5, { deleted: true }),
    lead('e2e', 39.1, -84.5, { e2eTestData: true }), lead('str', '39.1', '-84.7'), lead('blank', '', '')];
  const got = ML.customersInPath([W1], leads);
  ok('only the two real in-box addresses count', got.map((g) => g.leadId).sort().join() === 'in,str', JSON.stringify(got));
  ok('hail size rides along', got[0].hailIn === 1.75);
  const small = { id: 'w2', event: 'Severe Thunderstorm Warning', hailIn: 0.75, rings: [BOX] };
  ok('the LARGEST warned hail over the address wins', ML.customersInPath([small, W1], [lead('in', 39.1, -84.6)])[0].hailIn === 1.75);
  ok('sorted biggest hail first', (() => {
    const tiny = { id: 'w3', event: 'x', hailIn: 0.5, rings: [[[40, -85], [40, -84.9], [40.1, -84.9], [40.1, -85]]] };
    const r = ML.customersInPath([tiny, W1], [lead('a', 40.05, -84.95), lead('b', 39.1, -84.6)]);
    return r[0].leadId === 'b';
  })());
  const ORIGIN = { id: 'o', hailIn: 1, rings: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]] };
  ok('a lead stuck at 0,0 is "no location" even under a polygon that covers it', ML.customersInPath([ORIGIN], [lead('z', 0, 0)]).length === 0
    && ML.leadPoint(lead('z', 0, 0)) === null && ML.leadCenter([lead('z', 0, 0)]) === null);
  ok('a warning with no polygon covers nobody (never "everyone")', ML.customersInPath([{ id: 'z', hailIn: 1, rings: [] }], leads).length === 0);
}

console.log('\n2. hail at an address');
{
  const now = Date.parse('2026-10-12T20:00:00Z');
  const rep = (lat, lon, mag, date, type) => ({ type: type || 'hail', lat, lon, magnitude: mag, date });
  const h = ML.hailAtPoint(39.1, -84.6, [W1], [rep(39.11, -84.6, 1.25, '2026-10-12T18:00')], now);
  ok('warned size', h.warnedIn === 1.75);
  ok('nearest report found within range', h.report && h.report.inches === 1.25 && h.report.miles < 1.5);
  ok('a report 10 mi away is ignored', ML.hailAtPoint(39.1, -84.6, [], [rep(39.25, -84.6, 2, '2026-10-12T18:00')], now).report === null);
  ok('a report from last week is ignored', ML.hailAtPoint(39.1, -84.6, [], [rep(39.1, -84.6, 2, '2026-10-01T18:00')], now).report === null);
  ok('wind reports are not hail', ML.hailAtPoint(39.1, -84.6, [], [rep(39.1, -84.6, 70, '2026-10-12T18:00', 'wind')], now).report === null);
  ok('outside every warning is warnedIn null', ML.hailAtPoint(39.9, -84.6, [W1], [], now).warnedIn === null);
  ok('the nearer of two reports wins', ML.hailAtPoint(39.1, -84.6, [], [rep(39.13, -84.6, 1, '2026-10-12T18:00'), rep(39.101, -84.6, 1.5, '2026-10-12T18:00')], now).report.inches === 1.5);
  ok('zone-only wind warning: warnedIn 0, not null', ML.hailAtPoint(39.1, -84.6, [{ id: 'q', hailIn: 0, rings: [BOX] }], [], now).warnedIn === 0);
}

console.log('\n3. turfs');
{
  const total = ML.ringAreaSqMi(BOX);
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push({ lat: 39.05 + (i % 5) * 0.02, lng: -84.78 + (i % 10) * 0.01 });   // all in the west quarter
  for (let i = 0; i < 6; i++) pts.push({ lat: 39.1, lng: -84.45 + i * 0.005 });
  const eq = ML.splitTurfs([BOX], 3, []);
  ok('three turfs', eq.length === 3 && eq[0].name === 'Turf A' && eq[2].name === 'Turf C');
  ok('equal-width cuts conserve the area (within 1%)', Math.abs(eq.reduce((s, t) => s + t.areaSqMi, 0) - total) / total < 0.01, eq.map((t) => t.areaSqMi).join());
  ok('equal-width turfs are about a third each', eq.every((t) => Math.abs(t.areaSqMi - total / 3) / total < 0.02));
  const bal = ML.splitTurfs([BOX], 3, pts);
  const doors = bal.map((t) => t.doors);
  ok('door-balanced cuts: no turf is empty and none holds more than half', doors.every((d) => d > 0 && d <= pts.length / 2), doors.join());
  ok('door-balanced cuts conserve the area too', Math.abs(bal.reduce((s, t) => s + t.areaSqMi, 0) - total) / total < 0.01);
  ok('every door lands in exactly one turf (cuts do not drop or double)', doors.reduce((a, b) => a + b, 0) === pts.length, doors.join());
  ok('n is clamped 1..8 and junk is 1', ML.splitTurfs([BOX], 99, []).length <= 8 && ML.splitTurfs([BOX], 'x', []).length === 1);
  ok('no area -> no turfs', ML.splitTurfs([], 3, pts).length === 0);
  // 2026-10-25: four doors on ONE coordinate (the e2e rep's test customers, or a
  // street of leads geocoded to the same pin) made every quantile cut the same
  // number; the de-dup kept one and the rep got 2 turfs under a "3 turfs" stepper.
  const stacked = [1, 2, 3, 4].map(() => ({ lat: 39.1, lng: -84.5 }));
  const st = ML.splitTurfs([BOX], 3, stacked);
  ok('doors stacked on one point still yield the N turfs asked for (equal-width fallback)', st.length === 3, String(st.length));
  ok('…and every stacked door is counted once', st.reduce((a, t) => a + t.doors, 0) === 4, st.map((t) => t.doors).join());
  // a tall box is cut across its LONG side (latitude)
  const tall = [[39.0, -84.5], [39.0, -84.45], [39.6, -84.45], [39.6, -84.5]];
  const tt = ML.splitTurfs([tall], 2, []);
  ok('a tall area is cut by latitude', tt.length === 2 && tt[0].rings[0].every((p) => p[0] <= 39.31) && tt[1].rings[0].every((p) => p[0] >= 39.29));
  ok('all turf vertices stay inside the original bounds', bal.every((t) => t.rings.every((r) => r.every((p) => p[0] >= 39 - 1e-9 && p[0] <= 39.2 + 1e-9 && p[1] >= -84.8 - 1e-9 && p[1] <= -84.4 + 1e-9))));
  const hull = ML.hullOf([{ lat: 39, lng: -84 }, { lat: 39.1, lng: -84 }, { lat: 39.1, lng: -84.1 }, { lat: 39, lng: -84.1 }, { lat: 39.05, lng: -84.05 }]);
  ok('hull has the 4 corners and not the interior point', hull.length === 4);
  ok('one report still gets a small box', ML.hullOf([{ lat: 39, lng: -84 }]).length === 4);
  ok('no points, no hull', ML.hullOf([]) === null);
}

console.log('\n4. knock stats');
{
  const turfs = ML.splitTurfs([BOX], 2, []);
  const k = (lat, lng, d) => ({ lat, lng, disposition: d });
  const st = ML.knockStats([k(39.1, -84.7, 'appointment'), k(39.1, -84.7, 'not_home'), k(39.1, -84.5, 'interested'), k(39.1, -84.5, 'not_interested'),
    k(39.1, -84.5, 'callback'), k(0, 0, 'appointment'), k(50, -70, 'interested')], turfs);
  ok('overall counts every knock, rate is hot/total', st.overall.knocks === 7 && st.overall.hot === 5 && st.overall.rate === 71, JSON.stringify(st.overall));
  ok('per turf counts only knocks inside it', st.turfs[0].knocks === 2 && st.turfs[1].knocks === 3, JSON.stringify(st.turfs));
  ok('per turf rate', st.turfs[0].rate === 50 && st.turfs[1].rate === 67);
  ok('no knocks -> null rate, not 0%', ML.knockStats([], turfs).overall.rate === null && ML.knockStats([], turfs).turfs[0].rate === null);
  ok('HOT list matches the D2D tracker\'s', ['appointment', 'interested', 'storm_damage', 'ins_has_claim', 'ins_needs_file', 'callback'].every((d) => ML.HOT.indexOf(d) !== -1) && ML.HOT.length === 6);
}

console.log('\n5. timeline');
{
  const ev = (iso, mag, type) => ({ type: type || 'hail', lat: 39.1, lon: -84.5, magnitude: mag, date: iso, city: 'X' });
  const win = ML.timelineWindow([ev('2026-10-12T18:00', 1), ev('2026-10-12T14:00', 1.5), ev('2026-10-12T04:00', 2), ev('2026-06-01T10:00', 1), { type: 'hail', lat: 0, lon: 0, date: '2026-10-12T18:00' }, ev('garbage', 1)], 12);
  ok('window ends at the newest report and spans 12 h', win.end === Date.parse('2026-10-12T18:00Z') && win.start === Date.parse('2026-10-12T14:00Z') && win.items.length === 2, JSON.stringify([win.start, win.end, win.items.length]));
  ok('IEM times are read as UTC', ML.parseMs('2026-10-12T18:00') === Date.parse('2026-10-12T18:00:00Z'));
  ok('an explicit offset is respected', ML.parseMs('2026-10-12T18:00-04:00') === Date.parse('2026-10-12T22:00:00Z'));
  ok('playback is cumulative up to the cursor', ML.reportsUpTo(win, Date.parse('2026-10-12T15:00Z')).length === 1 && ML.reportsUpTo(win, win.end).length === 2);
  ok('nothing to show is an empty window, not a crash', ML.timelineWindow([], 12).items.length === 0 && ML.timelineWindow(null).end === null);
}

console.log('\n6. the context switch is only an offer');
{
  const base = { storm: { active: true, dismissed: false }, enabled: true, hasLayout: true, surfaces: ['phone', 'tablet', 'desktop'], surface: 'desktop', company: { locked: false, allowed: null }, current: 'classic' };
  const o = (patch) => SM.missionOffer(Object.assign({}, base, patch));
  ok('warning + opted in + free to switch -> offered', o({}) === true);
  ok('company LOCKED layout -> never offered', o({ company: { locked: true } }) === false);
  ok('admin allow-list without it -> not offered', o({ company: { allowed: ['classic', 'field'] } }) === false);
  ok('allow-list with it -> offered', o({ company: { allowed: ['classic', 'mission'] } }) === true);
  ok('Storm Mode off -> not offered', o({ enabled: false }) === false);
  ok('no active warning -> not offered', o({ storm: { active: false } }) === false);
  ok('banner dismissed -> not offered', o({ storm: { active: true, dismissed: true } }) === false);
  ok('layout not registered -> not offered', o({ hasLayout: false }) === false);
  ok('layout cannot show on this screen -> not offered', o({ surfaces: ['phone'] }) === false);
  ok('already in Mission Control -> not offered', o({ current: 'mission' }) === false);
  const sm = read('docs/pro/js/storm-mode.js');
  ok('the banner button only ever calls apply from its own click handler (no silent apply)',
    (sm.match(/LayoutEngine\.apply\('mission'/g) || []).length === 1 && /data-sm-mission'\)\) \{[\s\S]{0,400}LayoutEngine\.apply\('mission'/.test(sm));
  ok('all-clear returns the layout we moved them to, and says so', /current\(\)\.id === 'mission' && LE\.current\(\)\.source === 'storm'/.test(sm) && /Storm cleared/.test(sm));
}

console.log('\n7. wording');
{
  const script = ML.doorScript({ company: 'No Big Deal Home Solutions', rep: 'Sam', hailIn: 1.5, whenLabel: 'on Oct 12' }).concat(ML.doorScript({}));
  const bad = [];
  script.forEach((l) => CW.scanText(l.text).forEach((h) => bad.push(h.rule + ': ' + h.sentence)));
  ok('the door-knock script trips no claim-wording rule', bad.length === 0, bad.join(' | '));
  ok('control: the filter does flag a claim-handling sentence', CW.scanText('We handle the insurance claim for you.').length > 0);
  ok('the script never says insurance / claim / deductible / free roof / guarantee',
    !/\b(insurance|claim|deductible|guarantee\w*|approved|covered|free roof|no cost)\b/i.test(script.map((l) => l.text).join(' ')));
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const copy = [];
  ['docs/pro/js/layouts/mission.js', 'docs/pro/js/layouts/mission-logic.js'].forEach((f) => {
    const re = /'((?:[^'\\\n]|\\.)*)'/g; let m; const code = strip(read(f));
    while ((m = re.exec(code))) if (/\s/.test(m[1]) && /[A-Za-z]{3}/.test(m[1])) copy.push(m[1].replace(/\\'/g, "'"));
  });
  const hits = [];
  copy.forEach((s) => CW.scanText(s).forEach((h) => hits.push(h.rule + ': ' + h.sentence)));
  ok('there is copy to scan', copy.length > 30);
  ok('no string in mission.js / mission-logic.js trips the rules', hits.length === 0, hits.slice(0, 3).join(' | '));
  ok('hail is described as a report / weather data, never as damage', !/\b(your roof is damaged|damage confirmed|you have damage)\b/i.test(copy.join(' ')) && /not an inspection finding/.test(read('docs/pro/js/layouts/mission.js')));
}

console.log('\n8. registry, lazy assets, nothing is sent');
{
  const d = R.get('mission');
  ok('registered, every surface', d && d.surfaces.slice().sort().join() === 'desktop,phone,tablet');
  ok('script, css and every needs file exist', fs.existsSync(path.join(ROOT, 'docs/pro', d.script)) && fs.existsSync(path.join(ROOT, 'docs/pro', d.css))
    && d.needs.script.concat(d.needs.css).every((p) => fs.existsSync(path.join(ROOT, 'docs/pro', p))));
  ok('mapview + logic ride in needs (lazy), not as page tags', d.needs.script.indexOf('js/layouts/mapview.js') !== -1 && d.needs.script.indexOf('js/layouts/mission-logic.js') !== -1);
  ok('a company lock can pin it', R.resolve({ surface: 'desktop', user: { id: 'classic' }, company: { defaultLayout: 'mission', locked: true } }).id === 'mission');
  ok('a lock elsewhere beats the storm offer\'s target (resolve never returns mission)', R.resolve({ surface: 'desktop', user: { id: 'mission' }, company: { defaultLayout: 'classic', locked: true } }).id === 'classic');
  const js = strip2(read('docs/pro/js/layouts/mission.js'));
  function strip2(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); }
  ok('no sender: no sms_log / sendSms / sendEmail / addDoc / setDoc / fileStormDrafts in the layout',
    !/\b(sms_log|sendSms|sendEmail|sendText|addDoc|setDoc|updateDoc|fileStormDrafts|fileLeadTextDraft)\b/.test(js));
  ok('the only network calls are the storm feed and one limited knocks read', (js.match(/\bfetch\(/g) || []).length === 1 && /\/api\/storm-report/.test(js) && /W\.limit\(500\)/.test(js));
  ok('the hand-off is labelled a draft and says nothing was sent', /Send routes to phones \(draft\)/.test(js) && /Nothing was sent/.test(js));
  // 2026-10-15: the way out is "Menu" in every layout; Mission's Menu (always in
  // the top bar) holds the app's pages plus "Leave Mission Control".
  ok('Menu is always rendered in the top bar, and it holds the way out', /data-mc="menu"[^>]*>Menu</.test(js) && /data-mc="back">Leave Mission Control</.test(js) && /K\.menuItems\('mc'\)/.test(js));
  const sheet = ML.turfSheetText([{ name: 'Turf A', rep: 'Sam', doors: 12, areaSqMi: 3.2, center: [39.1, -84.5] }], { when: 'Oct 12' });
  ok('turf sheet is plain text with the draft caveat', /draft, review before sharing/.test(sheet) && /Turf A - Sam: 12 known doors/.test(sheet));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
