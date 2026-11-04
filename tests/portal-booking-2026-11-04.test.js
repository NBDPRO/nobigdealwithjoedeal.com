/**
 * tests/portal-booking-2026-11-04.test.js
 *
 * Customer portal Phase 4 (documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md):
 *
 *   1. functions/portal-booking.js bookingCard (pure): the next live Cal.com
 *      appointment; reschedule / cancel links on Cal.com's own pages, only
 *      for a real booking uid and only at inspection / estimate (self-serve
 *      stops after signing).
 *   2. sharedReportRows (pure): a report shows only after Jo shared it, only
 *      while the share is live, only as a /report/<token> link on our domain.
 *   3. Wiring: the view reads appointments tenant-filtered and never fails on
 *      them; shared reports join the documents shelf; the client renders the
 *      card, escapes the title, and stops offering "book" while booked; the
 *      reschedule / cancel metrics are allowlisted.
 *
 * Run: node tests/portal-booking-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const PB = require(path.join(ROOT, 'functions/portal-booking.js'));
const NOW = Date.UTC(2026, 10, 4, 17);
const ts = (ms) => ({ toMillis: () => ms });
const UID = 'bk7Qz2LmNpRs4tUv';

console.log('\n1. bookingCard');
const appt = { source: 'calcom', bookingId: UID, status: 'booked', title: 'Roof inspection', startTime: ts(NOW + 86400e3), endTime: ts(NOW + 86400e3 + 3600e3) };
const c = PB.bookingCard([appt], 'inspection', NOW);
ok('upcoming booking → card with start and end', c && c.startMs === NOW + 86400e3 && c.endMs === NOW + 86400e3 + 3600e3);
ok('reschedule + cancel on Cal.com\'s own pages, by uid', c.manage && c.manage.reschedule === 'https://app.cal.com/reschedule/' + UID
  && c.manage.cancel === 'https://app.cal.com/booking/' + UID + '?cancel=true', JSON.stringify(c.manage));
ok('still self-serve at the estimate step', !!PB.bookingCard([appt], 'estimate', NOW).manage);
ok('after signing → card, but no self-serve links', (() => { const s = PB.bookingCard([appt], 'signed', NOW); return s && s.manage === null; })());
ok('during the build → no self-serve links', PB.bookingCard([appt], 'build', NOW).manage === null);
ok('a past appointment → no card', PB.bookingCard([Object.assign({}, appt, { startTime: ts(NOW - 1) })], 'inspection', NOW) === null);
ok('a cancelled appointment → no card', PB.bookingCard([Object.assign({}, appt, { status: 'cancelled' })], 'inspection', NOW) === null);
ok('the EARLIEST upcoming wins', PB.bookingCard([Object.assign({}, appt, { startTime: ts(NOW + 9e8) }), Object.assign({}, appt, { startTime: ts(NOW + 5e6) })], 'inspection', NOW).startMs === NOW + 5e6);
ok('a numeric (non-uid) booking id → card without links', PB.bookingCard([Object.assign({}, appt, { bookingId: '123456' })], 'inspection', NOW).manage === null);
ok('a uid with URL characters → no links', PB.bookingCard([Object.assign({}, appt, { bookingId: 'abc/../../evil?x=1' })], 'inspection', NOW).manage === null);
ok('not from Cal.com → no links', PB.bookingCard([Object.assign({}, appt, { source: 'manual' })], 'inspection', NOW).manage === null);
ok('title trimmed + capped', PB.bookingCard([Object.assign({}, appt, { title: '  a\n b ' + 'x'.repeat(200) })], 'inspection', NOW).title.length === 80);
ok('a junk start time → no card', PB.bookingCard([Object.assign({}, appt, { startTime: 'soon' })], 'inspection', NOW) === null);

console.log('\n2. sharedReportRows');
const TOK = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const row = { id: 'd1', name: 'Photo report', reportNumber: 'PR-7', shareUrl: PB.REPORT_URL_BASE + TOK, sharedAt: ts(NOW - 3600e3), shareExpiresAt: ts(NOW + 864e5) };
const r = PB.sharedReportRows([row], new Set(), NOW);
ok('a live shared report → one shelf row linking the share page', r.length === 1 && r[0].url === PB.REPORT_URL_BASE + TOK && r[0].viaHtml === false && r[0].date);
ok('never shared → not shown', PB.sharedReportRows([{ id: 'd2', name: 'Report' }], new Set(), NOW).length === 0);
ok('share expired → not shown', PB.sharedReportRows([Object.assign({}, row, { shareExpiresAt: ts(NOW - 1) })], new Set(), NOW).length === 0);
ok('deleted → not shown', PB.sharedReportRows([Object.assign({}, row, { deleted: true })], new Set(), NOW).length === 0);
ok('already on the shelf → not listed twice', PB.sharedReportRows([row], new Set(['d1']), NOW).length === 0);
// Same length as the real base, so only the host check (not the token shape) can refuse it.
const EVIL = ('https://evil.test/' + 'a'.repeat(60)).slice(0, PB.REPORT_URL_BASE.length) + TOK;
ok('a shareUrl on another host → refused', EVIL.length === (PB.REPORT_URL_BASE + TOK).length
  && PB.sharedReportRows([Object.assign({}, row, { shareUrl: EVIL })], new Set(), NOW).length === 0);
ok('a shareUrl with extra path / query → refused', PB.sharedReportRows([Object.assign({}, row, { shareUrl: PB.REPORT_URL_BASE + TOK + '/../x?y' })], new Set(), NOW).length === 0);
ok('REPORT_URL_BASE matches report-sharing.js', /const REPORT_URL_BASE = 'https:\/\/nobigdealwithjoedeal\.com\/report\/';/.test(read('functions/report-sharing.js')));

console.log('\n3. wiring');
const fn = stripComments(read('functions/portal.js'));
ok('appointments read by leadId, tenant-filtered', /db\.collection\('appointments'\)\.where\('leadId', '==', tok\.leadId\)\.limit\(10\)\.get\(\)/.test(fn)
  && /filter\(\(a\) => recordInPortalTenant\(a, \['userId', 'repUid'\], tenant\)\)/.test(fn));
ok('a failed appointments read never breaks the portal', /let _booking = null;\s*try \{[\s\S]{0,400}\} catch \(e\) \{\s*logger\.warn\('portal booking read failed'/.test(fn));
ok('the view sends booking', /booking: _booking,/.test(fn));
ok('shared reports join the shelf', /_generatedDocs\.concat\(_esignDocs, _sharedReports\)/.test(fn));
const pjs = stripComments(read('docs/pro/js/portal.js'));
ok('the card renders with Cal.com links in a new tab', /id="appt-card" data-portal-booking/.test(pjs) && /data-metric="reschedule" href="' \+ esc\(rs\) \+ '" target="_blank" rel="noopener"/.test(pjs));
ok('the title is escaped', /esc\(bk\.title\)/.test(pjs));
ok('no self-serve → a message to the rep instead', /Need to change it\? Send ' \+ esc\(repName\) \+ ' a message below\./.test(pjs));
ok('times shown in Eastern time', /timeZone: 'America\/New_York'/.test(pjs));
ok('while booked: no "book" action and no booking embed', /view\.bookingUrl && !view\.booking && copy\.bookLink/.test(pjs) && /if \(view\.bookingUrl && !view\.booking\) \{/.test(pjs));
ok('reschedule / cancel metrics allowlisted', /METRIC_ACTIONS = new Set\(\[[^\]]*'reschedule', 'cancel'\]\)/.test(read('functions/customer-audit.js')));
ok('portal.js cache-buster bumped (v>=23)', Number((read('docs/pro/portal.html').match(/js\/portal\.js\?v=(\d+)/) || [])[1]) >= 23);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
