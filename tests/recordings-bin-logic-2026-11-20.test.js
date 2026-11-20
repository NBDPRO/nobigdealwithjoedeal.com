/**
 * tests/recordings-bin-logic-2026-11-20.test.js - the phone's pure Bin / Keep logic (recordings Bin PR 1):
 * docs/pro/js/visit-recorder-logic.js binPatch / restorePatch / keepPatch / isUnfiled / binDaysLeft / audioDaysLeft,
 * and that the phone and the server (functions/visit-capture-logic.js) agree on what "binned" means.
 * The screens that use these come in PR 2, behind the flag recordingsBin.
 *
 * Run: node tests/recordings-bin-logic-2026-11-20.test.js
 */
const L = require('../docs/pro/js/visit-recorder-logic.js');
const S = require('../functions/visit-capture-logic.js');

let failed = 0;
function ok(name, cond, detail) { console.log((cond ? 'ok   ' : 'FAIL ') + name + (!cond && detail ? ' :: ' + String(detail).slice(0, 260) : '')); if (!cond) failed++; }
const J = (x) => JSON.stringify(x);

const DAY = 86400000;
const NOW = Date.parse('2026-11-20T15:00:00Z');
const rec = (extra) => Object.assign({ id: 'v1', status: 'uploaded', leadId: null }, extra || {});

console.log('what the phone may write');
ok('the five new fields are in the phone\'s write list', ['keptAtMs', 'binnedAtMs', 'hardDeleteAtMs', 'binnedFrom', 'binnedLeadId'].every((k) => L.DOC_FIELDS.includes(k)));
ok('the Hold fields are NOT (server-owned)', !['legalHold', 'holdBy', 'holdAtMs'].some((k) => L.DOC_FIELDS.includes(k)));
ok('the upload statuses did not change: discarded is still the only terminal one the phone writes', J(L.STATUSES) === J(['recording', 'stored', 'uploading', 'uploaded', 'failed', 'discarded']));

console.log('Bin and Restore');
{
  const un = rec({ leadId: null });
  const p = L.binPatch(un, NOW);
  ok('binning an unassigned recording: the exact 30-day deadline, from unfiled, no customer', p.binnedAtMs === NOW && p.hardDeleteAtMs === NOW + 30 * DAY && p.binnedFrom === 'unfiled' && p.binnedLeadId === null && p.leadId === null && p.keptAtMs === null);
  const at = rec({ leadId: 'LeadOne01' });
  const q = L.binPatch(at, NOW);
  ok('binning an attached one remembers the customer and takes it off (the server then retracts what it filed)', q.binnedFrom === 'attached' && q.binnedLeadId === 'LeadOne01' && q.leadId === null);
  ok('binning clears Kept (a recording is one thing at a time)', L.binPatch(rec({ keptAtMs: NOW - DAY }), NOW).keptAtMs === null);
  const binned = Object.assign({}, at, q);
  ok('restoring an attached one puts it back on the same customer and clears every Bin field', J(L.restorePatch(binned)) === J({ binnedAtMs: null, hardDeleteAtMs: null, binnedFrom: null, binnedLeadId: null, leadId: 'LeadOne01' }));
  ok('restoring an unassigned one leaves it unassigned', L.restorePatch(Object.assign({}, un, p)).leadId === null);
  const round = Object.assign({}, binned, L.restorePatch(binned));
  ok('bin then restore is a round trip: same customer, not binned, no Bin fields left', round.leadId === 'LeadOne01' && !L.isBinned(round) && round.binnedAtMs === null && round.hardDeleteAtMs === null);
  ok('restore never invents a customer: "attached" with no remembered id restores to unassigned', L.restorePatch({ binnedFrom: 'attached', binnedLeadId: null }).leadId === null);
  ok('the deadline is the rules\' shape (binnedAtMs + 2,592,000,000 ms) and the server\'s constant', p.hardDeleteAtMs === p.binnedAtMs + 2592000000 && L.BIN_DAYS === S.BIN_DAYS && S.BIN_MS === 2592000000);
}

console.log('Keep');
{
  ok('keeping stamps the time; un-keeping clears it', J(L.keepPatch(NOW)) === J({ keptAtMs: NOW }) && J(L.unkeepPatch()) === J({ keptAtMs: null }));
  ok('a Kept recording is not unassigned (it leaves the count and the reminders)', !L.isUnfiled(rec({ keptAtMs: NOW })) && L.isKept(rec({ keptAtMs: NOW })) && L.isUnfiled(rec({ keptAtMs: null })));
}

console.log('what counts as unassigned');
{
  ok('an uploaded recording with no customer is unassigned', L.isUnfiled(rec()));
  ok('a binned one is not (it left the count the moment it was binned)', !L.isUnfiled(rec({ binnedAtMs: NOW, hardDeleteAtMs: NOW + 30 * DAY })));
  ok('restoring it makes it unassigned again', L.isUnfiled(Object.assign({}, rec(Object.assign({}, L.binPatch(rec(), NOW))), L.restorePatch(rec(L.binPatch(rec(), NOW))))));
  ok('one that is on a customer, discarded, or still recording is not', !L.isUnfiled(rec({ leadId: 'LeadOne01' })) && !L.isUnfiled(rec({ status: 'discarded' })) && !L.isUnfiled(rec({ status: 'recording' })));
  ok('the old dead pipeline states still keep one out', !L.isUnfiled(rec({ pipelineStatus: 'purge_pending' })) && !L.isUnfiled(rec({ pipelineStatus: 'skipped' })));
  ok('a recording that was binned and then discarded for good is not "binned" any more', !L.isBinned(rec({ status: 'discarded', binnedAtMs: NOW })));
}

console.log('days left');
{
  const b = Object.assign(rec(), L.binPatch(rec(), NOW));
  ok('a Bin item shows whole days left: 30 on day one, 28 after two days and a bit', L.binDaysLeft(b, NOW) === 30 && L.binDaysLeft(b, NOW + 2.2 * DAY) === 28);
  ok('0 on the last day, never negative', L.binDaysLeft(b, NOW + 30 * DAY - 1000) === 1 && L.binDaysLeft(b, NOW + 40 * DAY) === 0);
  ok('nothing for a recording that is not in the Bin, and nothing for a Held one (it does not expire)', L.binDaysLeft(rec(), NOW) === null && L.binDaysLeft(Object.assign({}, b, { legalHold: true }), NOW) === null);
  const au = rec({ firstSeenAtMs: NOW - 10 * DAY, audioLive: true });
  ok('audio expiry: 90 days from the server stamp, whole days left', L.audioDaysLeft(au, 90, NOW) === 80 && L.audioDaysLeft(au, 30, NOW) === 20);
  ok('...0 once it is due, never negative', L.audioDaysLeft(rec({ firstSeenAtMs: NOW - 200 * DAY, audioLive: true }), 90, NOW) === 0);
  ok('...nothing when the audio is already gone, on Hold, or the server has not stamped it yet', L.audioDaysLeft(rec({ firstSeenAtMs: NOW, audioLive: false }), 90, NOW) === null && L.audioDaysLeft(Object.assign({}, au, { legalHold: true }), 90, NOW) === null && L.audioDaysLeft(rec({ audioLive: true }), 90, NOW) === null && L.audioDaysLeft(au, 0, NOW) === null);
}

console.log('the phone and the server agree');
{
  const samples = [
    rec(), rec({ binnedAtMs: NOW }), rec({ binnedAtMs: 0 }), rec({ binnedAtMs: null }), rec({ status: 'discarded', binnedAtMs: NOW }), rec({ binnedAtMs: NOW, legalHold: true }),
    rec({ keptAtMs: NOW }), rec({ keptAtMs: 0 }), rec({ keptAtMs: null }),
  ];
  ok('isBinned means the same on the phone and the server for every sample', samples.every((d) => L.isBinned(d) === S.isBinned(d)), J(samples.map((d) => [L.isBinned(d), S.isBinned(d)])));
  ok('isKept means the same too', samples.every((d) => L.isKept(d) === S.isKept(d)));
  ok('a recording the phone just binned is binned to the server, and its state machine unfiles whatever it had filed', S.isBinned(Object.assign(rec({ leadId: 'LeadOne01', attachedLeadId: 'LeadOne01' }), L.binPatch(rec({ leadId: 'LeadOne01' }), NOW))) && S.nextStep(Object.assign(rec({ leadId: 'LeadOne01', attachedLeadId: 'LeadOne01', pipelineStatus: 'ready' }), L.binPatch(rec({ leadId: 'LeadOne01' }), NOW)), NOW).step === 'unfile');
  ok('and after the phone restores it, the server files it again (finalize), not leaves it parked', S.nextStep(Object.assign(rec({ pipelineStatus: 'ready', attachedLeadId: null, finalizedKey: null }), L.restorePatch({ binnedFrom: 'attached', binnedLeadId: 'LeadOne01' })), NOW).step === 'finalize');
  ok('the Bin days left agree to the day', (() => { const b = Object.assign(rec(), L.binPatch(rec(), NOW)); return [0, 1, 2.2, 29.5, 31].every((d) => L.binDaysLeft(b, NOW + d * DAY) === S.binDaysLeft(b, NOW + d * DAY)); })());
}

if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
console.log('\nall passed');
