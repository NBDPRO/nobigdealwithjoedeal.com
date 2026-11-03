/**
 * tests/inbound-stamp-2026-11-03.test.js
 *
 * Follow-up board, server half: an inbound customer message stamps
 * lastInboundAt (functions/inbound-stamp.js) and does NOT make the lead look
 * touched by Jo. Pins:
 *   1. the patch: sms and portal stamp lastInboundAt / lastInboundVia, never
 *      lastContactedAt; a possible STOP, an unknown channel or no message stamps
 *      nothing (null);
 *   2. incomingSMS (functions/sms-functions.js) goes through that helper and no
 *      longer writes lastContactedAt for an inbound text; the portal message
 *      write stamps lastInboundAt (static scans, comments stripped, with a
 *      positive control proving the scan can see the old write);
 *   3. the behaviour that matters: a customer reply does not hide an open
 *      estimate from the estimate board, and it puts the lead in "waiting";
 *   4. readers that used lastContactedAt as "any activity" also read
 *      lastInboundAt, so a lead that just wrote is not stale.
 * Synthetic data only. Run: node tests/inbound-stamp-2026-11-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const S = require(path.join(ROOT, 'functions/inbound-stamp.js'));
const FU = require(path.join(ROOT, 'docs/pro/js/follow-up-board-logic.js'));
const EB = require(path.join(ROOT, 'docs/pro/js/estimate-follow-board.js'));

const fv = { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }) };

console.log('1. the patch');
{
  const sms = S.inboundLeadPatch({ via: 'sms' }, fv);
  ok('sms: lastInboundAt, lastInboundVia and unreadInbound', sms && sms.lastInboundAt === 'TS' && sms.lastInboundVia === 'sms' && sms.unreadInbound.inc === 1);
  ok('sms: never writes lastContactedAt (that is Jo\'s touch)', !('lastContactedAt' in sms));
  const portal = S.inboundLeadPatch({ via: 'portal' }, fv);
  ok('portal: lastInboundVia portal', portal && portal.lastInboundVia === 'portal' && !('lastContactedAt' in portal));
  ok('a possible STOP stamps nothing', S.inboundLeadPatch({ via: 'sms', possibleStop: true }, fv) === null);
  ok('unknown channel / no message stamps nothing', S.inboundLeadPatch({ via: 'carrier-pigeon' }, fv) === null && S.inboundLeadPatch(null, fv) === null);
}

console.log('2. the writers');
{
  const sms = strip(read('functions/sms-functions.js'));
  const i = sms.indexOf("direction: 'incoming'");
  const region = sms.slice(i, i + 2500);
  ok('incomingSMS builds its lead patch with inboundLeadPatch and writes it', /inboundLeadPatch\(\{ via: 'sms', possibleStop \}, FieldValue\)/.test(region) && /update\(inboundPatch\)/.test(region));
  ok('incomingSMS no longer writes lastContactedAt after the inbound note', !/lastContactedAt:\s*FieldValue\.serverTimestamp\(\)/.test(region));
  // positive control: the scan can see the old write
  const oldShape = "await db.doc(`leads/${leadId}`).update({\n lastContactedAt: FieldValue.serverTimestamp()\n });";
  ok('positive control: the scan flags the old inbound write', /lastContactedAt:\s*FieldValue\.serverTimestamp\(\)/.test(oldShape));
  const portal = strip(read('functions/portal.js'));
  const j = portal.indexOf('lastHomeownerMessageAt: FieldValue.serverTimestamp()');
  ok('a portal message also stamps lastInboundAt (one field for the board)', j > 0 && /lastInboundAt:\s*FieldValue\.serverTimestamp\(\)/.test(portal.slice(j, j + 400)));
}

console.log('3. a customer reply');
{
  const DAY = 86400000, NOW = Date.UTC(2026, 10, 3, 15);
  const lead = { id: 'ZZ_QA_1', firstName: 'Maria', stage: 'estimate_sent_cash', lastSharedAt: NOW - 6 * DAY, jobValue: 10000, phone: '5135550101' };
  // The customer wrote 5 hours ago. Under the OLD write that also set lastContactedAt = 5h ago.
  const wrote = Object.assign({}, lead, { lastInboundAt: NOW - 5 * 3600000 });
  const oldWrite = Object.assign({}, lead, { lastContactedAt: NOW - 5 * 3600000 });
  ok('control: the old write (lastContactedAt) hides the estimate from the estimate board', EB.buildBoard([oldWrite], NOW).total === 0);
  ok('now: a reply (lastInboundAt only) leaves the estimate on the estimate board', EB.buildBoard([wrote], NOW).total === 1);
  ok('and the follow-up board puts them under "waiting on your reply"', FU.buildFollowUps([wrote], NOW).sections[0].rows.map((r) => r.leadId).join() === 'ZZ_QA_1');
  ok('Jo answering (lastOutboundAt after the reply) takes them off "waiting"', FU.buildFollowUps([Object.assign({}, wrote, { lastOutboundAt: NOW - 3600000 })], NOW).sections[0].rows.length === 0);
}

console.log('4. activity readers also read lastInboundAt');
{
  const files = ['docs/pro/js/pixel-logic.js', 'docs/pro/js/no-next-step.js', 'docs/pro/js/stale-leads-cleanup.js', 'docs/pro/js/closes-week-logic.js',
    'functions/closes-week-logic.js', 'functions/call-center-logic.js', 'functions/visit-capture-logic.js', 'docs/pro/js/ask-joe-proactive.js'];
  files.forEach((f) => ok(f + ' counts a customer message as activity', /lastInboundAt/.test(strip(read(f)))));
  const SL = require(path.join(ROOT, 'docs/pro/js/stale-leads-cleanup.js'));
  const probe = SL.lastActivityMs || (SL._pure && SL._pure.lastActivityMs);
  if (probe) {
    const t = Date.UTC(2026, 10, 1);
    ok('stale-leads-cleanup: a lead that only just wrote is not older than that message', probe({ createdAt: t - 40 * 86400000, lastInboundAt: t }) === t);
  } else console.log('  - stale-leads-cleanup does not export lastActivityMs; static check above covers it');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
