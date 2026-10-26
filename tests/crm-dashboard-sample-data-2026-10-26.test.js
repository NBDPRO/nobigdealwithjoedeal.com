/* tests/crm-dashboard-sample-data-2026-10-26.test.js
 *
 * Overnight pass 2026-10-26, cluster "CRM dashboard: weekly activity tiles
 * populate, Door-to-Door tabs fit on phones, sample estimates use the real
 * field shape". Dependency-free half; the painted half (real Chromium on the
 * sample account) is tests/crm-dashboard-sample-render-2026-10-26.test.js.
 *
 *   A. Sample estimates carry the fields the builders write and the readers
 *      use (crm-7). The seed had address / squares / status only, so every
 *      Estimates card read "No address · — · — SQ · —", the status band read
 *      0 sent / 0 signed (estimate-analytics.js classifies on sentAt and
 *      signedAt, never on status 'accepted'), and Reports showed a $0 avg
 *      ticket beside an 89% close rate. The seed must emit addr, sq, roofType,
 *      tierName and sentAt on every estimate and signedAt on the accepted one,
 *      keep the older fields, and stay retail-only. The REAL estimate-analytics.js
 *      is run over the revived seed.
 *   B. The "This Week" tiles (crm-2): calculateWeeklyStats() lives inside the
 *      ES module dashboard-bootstrap.module.js, so dashboard-widgets.js's
 *      `typeof calculateWeeklyStats` was always 'undefined' and the tiles
 *      stayed 0 until the next lead load. The module must put it on window and
 *      the goTo('dash') re-sync must call it once the template is hydrated.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

let failed = 0;
let passed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 600) : '')); }
}

const seed = JSON.parse(read('docs/pro/demo-sdk/sample-company.json'));
const D = seed.docs;
const { readSample } = require('../scripts/build-demo-seed.js');
const S = readSample();

// ── A. sample estimates in the builders' field shape ────────────────────
console.log('A. sample estimates (crm-7)');
const estPaths = Object.keys(D).filter((p) => /^estimates\/[^/]+$/.test(p)).sort();
const ests = estPaths.map((p) => Object.assign({ id: p.split('/')[1] }, D[p]));
ok('the seed has its four sample estimates', ests.length === 4, estPaths.join(', '));
ok('seed version is 9 or later (a returning browser reseeds: _store.js compares it)', seed.version >= 9, seed.version);

const tierLabels = S.tiers.map((t) => t.label);
const ROOF_TYPES = ['Hip', 'Gable', 'Hip & Gable', 'Flat', 'Shed', 'Gambrel']; // #estRoofType's options
const isTs = (v) => !!(v && v.__ts && typeof v.__ts.days === 'number');
const hours = (v) => (isTs(v) ? v.__ts.days * 24 + (v.__ts.hour == null ? 10 : v.__ts.hour) : NaN); // _store.js relDate: hour defaults to 10
ests.forEach((e) => {
  ok(e.id + ': addr is the estimate\'s address (the field the Estimates card reads)', typeof e.addr === 'string' && e.addr.length > 0 && e.addr === e.address, JSON.stringify([e.addr, e.address]));
  ok(e.id + ': sq is a number of squares', typeof e.sq === 'number' && e.sq > 0 && e.sq < 100, e.sq);
  ok(e.id + ': roofType is one of the builder\'s roof types', ROOF_TYPES.includes(e.roofType), e.roofType);
  ok(e.id + ': tierName is one of the sample company\'s package labels', tierLabels.includes(e.tierName), e.tierName);
  ok(e.id + ': sentAt is a relative timestamp in the past', isTs(e.sentAt) && e.sentAt.__ts.days < 0, JSON.stringify(e.sentAt));
  ok(e.id + ': sentAt is not before createdAt', hours(e.sentAt) >= hours(e.createdAt));
});
const accepted = ests.filter((e) => e.status === 'accepted');
ok('exactly one sample estimate is accepted, and it carries signedAt after sentAt',
  accepted.length === 1 && hours(accepted[0].signedAt) > hours(accepted[0].sentAt),
  accepted[0] && JSON.stringify([accepted[0].sentAt, accepted[0].signedAt]));
ok('only the accepted estimate carries signedAt', ests.filter((e) => e.signedAt).length === 1);
// Reports' funnel counts leads CREATED in its window (reports-dashboard.js leadsInWindow), so the
// signed lead behind the accepted estimate must be younger than the default 30 days or "Signed" reads 0
// beside a $20k avg ticket. It also has to predate its own estimate (the story reads in order).
const signedLead = accepted[0] && D['leads/' + accepted[0].leadId];
ok('the signed lead behind the accepted estimate was created inside Reports\' 30-day window, before its estimate',
  !!signedLead && isTs(signedLead.createdAt) && signedLead.createdAt.__ts.days > -30 && hours(signedLead.createdAt) < hours(accepted[0].createdAt),
  signedLead && JSON.stringify([signedLead.createdAt, accepted[0].createdAt]));
// The older fields stay (other readers: the customer card, the story, the contract).
ok('the older fields are kept (address, name, package, total, grandTotal, status, leadId, tier, lineItems)',
  ests.every((e) => e.address && e.name && e.package && e.total > 0 && e.grandTotal === e.total && e.status && e.leadId && e.tier && Array.isArray(e.lineItems) && e.lineItems.length));
const story = ests.find((e) => e.id === 'sample-est-01');
ok('the story estimate keeps its squares and uses the story\'s square count for sq', story && story.squares === S.squares && story.sq === S.squares, story && JSON.stringify([story.squares, story.sq]));
ok('retail prices only: no cost, margin, markup or contractor key on any estimate',
  !/"[^"]*(cost|margin|markup|contractor|profit)[^"]*"\s*:/i.test(JSON.stringify(estPaths.map((p) => D[p]))));

// The REAL estimate-analytics.js over the revived seed.
const DAY = 86400000;
const revive = (v) => {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(revive);
  if (v.__ts) { const ms = Date.now() + v.__ts.days * DAY; return { toMillis: () => ms, seconds: Math.floor(ms / 1000) }; }
  const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o;
};
function analytics(list) {
  const win = { _estimates: list, addEventListener() {}, NBD_ESTIMATE_CONFIG: undefined };
  win.window = win;
  const doc = { readyState: 'loading', addEventListener() {}, getElementById() { return null; } };
  const sb = { window: win, document: doc, console, setTimeout() {}, Date, Math, Number, String, Array, Object, JSON, isFinite };
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/estimate-analytics.js'), sb, { filename: 'estimate-analytics.js' });
  return win.NBDEstimateAnalytics.compute();
}
const stats = analytics(ests.map(revive));
ok('the status band classifies them: 3 sent, 1 signed, 0 draft (it reads sentAt / signedAt, not status)',
  stats.total === 4 && stats.sent === 3 && stats.signed === 1 && stats.draft === 0, JSON.stringify({ total: stats.total, sent: stats.sent, signed: stats.signed, draft: stats.draft }));
ok('avg ticket is the accepted estimate\'s retail total, not $0', stats.avgTicket === accepted[0].grandTotal && stats.avgTicket > 0, stats.avgTicket);
ok('the close rate is a number (signed / (sent + signed + lost)), not "—"', stats.closeRate > 0 && Math.abs(stats.closeRate - 1 / 4) < 1e-9, stats.closeRate);
ok('time-to-sign has a sample (sentAt before signedAt)', stats.timeToSignDays.length === 1 && stats.timeToSignDays[0] > 0, JSON.stringify(stats.timeToSignDays));
// Positive control: the pre-fix shape (status only) classifies as nothing, which is the bug.
const legacy = ests.map((e) => { const c = revive(e); delete c.sentAt; delete c.signedAt; return c; });
const l0 = analytics(legacy);
ok('control: without sentAt / signedAt the same estimates count as nothing (the bug this fixes)', l0.sent === 0 && l0.signed === 0 && l0.avgTicket === 0, JSON.stringify({ sent: l0.sent, signed: l0.signed }));

// ── B. the This Week tiles ──────────────────────────────────────────────
console.log('B. the "This Week" tiles (crm-2)');
const mod = stripComments(read('docs/pro/js/dashboard-bootstrap.module.js'));
ok('the module defines calculateWeeklyStats', /function calculateWeeklyStats\s*\(/.test(mod));
ok('the module puts it on window (dashboard-widgets.js tests `typeof calculateWeeklyStats`, a classic script that cannot see module scope)',
  /window\.calculateWeeklyStats\s*=\s*calculateWeeklyStats\b/.test(mod));
const act = stripComments(read('docs/pro/js/dashboard-actions.js'));
const dashStart = act.indexOf("if(name==='dash')");
const estStart = act.indexOf("if(name==='est')", dashStart);
const dashBlock = dashStart >= 0 && estStart > dashStart ? act.slice(dashStart, estStart) : '';
ok('found goTo\'s dash block', dashBlock.length > 0);
ok('entering the dashboard recomputes the weekly tiles after the view is hydrated',
  /window\.calculateWeeklyStats\s*(\?\.\(|&&|\))|typeof window\.calculateWeeklyStats === 'function'/.test(dashBlock), dashBlock.slice(0, 200));
ok('...and does so alongside the KPI refresh (before the nbd:data-refreshed re-emit)',
  dashBlock.indexOf('calculateWeeklyStats') > -1 && dashBlock.indexOf('calculateWeeklyStats') < dashBlock.indexOf('nbd:data-refreshed'));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
