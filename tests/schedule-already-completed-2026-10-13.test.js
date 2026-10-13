/**
 * tests/schedule-already-completed-2026-10-13.test.js
 *
 * "Already completed" on the Schedule view's Plan jobs panel (Jo, 2026-10-13:
 * "We need to be able to say already completed on anything that missed
 * scheduling and it forwards it to the next stage"). Answers on record:
 * target = Install Done (install_complete); ask for the completion date
 * (default today, never in the future); QUIET — no drip, review ask, auto
 * Before & After report or any customer-facing send.
 *
 *   1. which rows qualify  (schedule-planner-logic.js: rowsFor.missed, completedOffer)
 *   2. the date rule       (completionIssue — and stage-write.js's twin agrees)
 *   3. the write path      (stage-write.js commitStageChange opts.backfill, in a vm)
 *   4. Undo                (undoBackfillCompletion: only while nothing moved the lead)
 *   5. every consumer honours the quiet flag (server fakes + client sandbox)
 *   6. the panel UI wiring (schedule-planner.js)
 *
 * Every absence assertion has a positive control beside it: the same input
 * WITHOUT the flag must fire, so a harness that blanks the thing under test
 * cannot pass vacuously. Synthetic data only.
 *
 * Run: node tests/schedule-already-completed-2026-10-13.test.js   (needs functions/ deps for section 5)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

let passed = 0, failed = 0; const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const P = require(path.join(ROOT, 'docs/pro/js/schedule-planner-logic.js'));
const TODAY = '2026-10-13';
const L = (id, stage, extra) => Object.assign({ id, stage, firstName: 'ZZ_QA', lastName: id, userId: 'u-jo', companyId: 'co1' }, extra);

// The dashboard's insurance track, trimmed to what the rules read.
const INS = ['new', 'contacted', 'inspected', 'claim_filed', 'estimate_sent', 'contract_signed', 'job_created', 'permit_pulled',
  'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress', 'install_complete', 'final_photos', 'final_payment', 'closed'];
const WARR = ['warranty_claim', 'warranty_scheduled', 'warranty_repaired', 'closed'];
const JOB_KEYS = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress'];
const ROLE = (k) => (['install_complete', 'final_photos', 'final_payment', 'closed'].includes(k) ? 'won' : (k === 'lost' ? 'lost' : (JOB_KEYS.includes(k) ? 'job' : 'active')));
const ME = { role: 'sales_rep', uid: 'u-jo', companyId: 'co1', roleOf: ROLE };

// ═══ 1. which rows qualify ═══════════════════════════════════════════════
console.log('\n1. which rows carry "Already completed"');
{
  const leads = [
    L('needs', 'contract_signed'),
    L('needsLate', 'materials_delivered'),
    L('past', 'install_in_progress', { scheduledDate: '2026-10-01' }),
    L('pastMulti', 'install_in_progress', { scheduledDate: '2026-10-10', scheduledEndDate: '2026-10-14' }),
    L('today', 'crew_scheduled', { scheduledDate: TODAY }),
    L('future', 'crew_scheduled', { scheduledDate: '2026-10-20' }),
    L('pastDone', 'install_complete', { scheduledDate: '2026-09-20' }),
    L('pastLost', 'lost', { scheduledDate: '2026-09-20' }),
    L('pastEstimate', 'estimate_sent', { scheduledDate: '2026-09-20' }),
    L('pastDeleted', 'crew_scheduled', { scheduledDate: '2026-09-20', deleted: true }),
    L('weekGone', 'contract_signed', { scheduledWeek: '2026-09-21' }),
  ];
  const r = P.rowsFor(leads, { today: TODAY });
  const need = r.needs.map((x) => x.id);
  const miss = r.missed.map((x) => x.id);
  ok('a past-dated, never-advanced job lands in the new Missed group', miss.includes('past'), miss.join());
  ok('a multi-day project is missed only once its LAST day is behind us', !miss.includes('pastMulti'), miss.join());
  ok('a job scheduled for today or later is not missed', !miss.includes('today') && !miss.includes('future'));
  ok('already at Install Done / lost / deleted → not missed', !miss.includes('pastDone') && !miss.includes('pastLost') && !miss.includes('pastDeleted'));
  ok('an estimate-stage lead is not missed by default (same filter as "needs")', !miss.includes('pastEstimate'));
  ok('…and "Show all open leads" widens Missed the way it widens Needs', P.rowsFor(leads, { today: TODAY, all: true }).missed.map((x) => x.id).includes('pastEstimate'));
  ok('Needs-a-date rows are unchanged (incl. a week that went by)', need.includes('needs') && need.includes('needsLate') && need.includes('weekGone'), need.join());
  ok('a missed row is in no other list (nothing is shown twice)', !need.includes('past') && !r.scheduled.map((x) => x.id).includes('past'));
  ok('the missed row says which day it was set for', r.missed.find((x) => x.id === 'past').missedOn === '2026-10-01');
  const two = P.rowsFor([L('b', 'crew_scheduled', { scheduledDate: '2026-10-05' }), L('a', 'crew_scheduled', { scheduledDate: '2026-09-02' })], { today: TODAY }).missed.map((x) => x.id);
  ok('most overdue first', two.join() === 'a,b', two.join());
}

console.log('\n1b. completedOffer — a forward move on the lead\'s own track, where the user may write');
{
  const offer = (lead, order, o) => P.completedOffer(lead, order || INS, Object.assign({}, ME, o || {}));
  ok('contract signed → offered', offer(L('a', 'contract_signed')) === true);
  ok('materials delivered → offered', offer(L('a', 'materials_delivered')) === true);
  ok('installing → offered', offer(L('a', 'install_in_progress')) === true);
  ok('already Install Done → hidden', offer(L('a', 'install_complete')) === false);
  ok('past Install Done (final photos / final payment / closed) → hidden',
    ['final_photos', 'final_payment', 'closed'].every((s) => offer(L('a', s)) === false));
  ok('lost → hidden', offer(L('a', 'lost')) === false);
  ok('an estimate-stage lead (the sale not made) → hidden', offer(L('a', 'estimate_sent')) === false);
  ok('a track with no Install Done (warranty) → hidden', offer(L('a', 'warranty_scheduled'), WARR) === false);
  ok('a stage not on the track → hidden', offer(L('a', 'mystery_stage')) === false);
  ok('an open warranty claim → hidden', offer(L('a', 'crew_scheduled', { openWarrantyClaimId: 'wc1' })) === false);
  ok('deleted / prospect → hidden', offer(L('a', 'crew_scheduled', { deleted: true })) === false && offer(L('a', 'crew_scheduled', { isProspect: true })) === false);
  ok('viewer → no button (rules refuse the write anyway)', offer(L('a', 'crew_scheduled'), INS, { role: 'viewer' }) === false);
  ok('a rep never gets it on a teammate\'s lead', offer(L('a', 'crew_scheduled', { userId: 'someone-else' })) === false);
  ok('…company_admin / manager do, for their own tenant only',
    offer(L('a', 'crew_scheduled', { userId: 'someone-else' }), INS, { role: 'company_admin' }) === true
    && offer(L('a', 'crew_scheduled', { userId: 'someone-else', companyId: 'co2' }), INS, { role: 'manager' }) === false);
  ok('the lead\'s normalized key wins over a raw legacy stage string',
    P.completedOffer(L('a', 'Approved'), INS, Object.assign({}, ME, { normalize: (s) => (s === 'Approved' ? 'contract_signed' : s) })) === true);
  const sk = P.skippedBetween(L('a', 'materials_ordered'), INS, {});
  ok('skippedBetween names exactly the steps jumped over', sk.join() === 'materials_delivered,crew_scheduled,install_in_progress', sk.join());
}

// ═══ 2. the date rule ═══════════════════════════════════════════════════
console.log('\n2. the completion date — real, not future, not absurd');
const SW_SRC = read('docs/pro/js/stage-write.js').replace(/^export (async )?function/gm, '$1function');
function loadSW(win) {
  const sandbox = { window: win, console: { warn() {}, log() {} }, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
  vm.createContext(sandbox);
  return vm.runInContext(SW_SRC + '\n;({ commitStageChange, undoBackfillCompletion, completionDateIssue, completionLabel, autoBeforeAfterOnStage })', sandbox, { filename: 'stage-write.js' });
}
{
  const SW = loadSW({});
  const cases = [
    ['2026-10-13', ''], ['2026-10-12', ''], ['2026-01-02', ''],
    ['2026-10-14', 'future'], ['2027-01-01', 'future'],
    ['', 'malformed'], ['10/13/2026', 'malformed'], ['2026-13-01', 'malformed'], ['2026-02-30', 'malformed'], ['not a date', 'malformed'], ['2026-1-5', 'malformed'],
    ['2014-12-31', 'too-old'], ['2015-01-01', ''],
  ];
  for (const [d, want] of cases) {
    const got = P.completionIssue(d, TODAY);
    ok('completionIssue(' + JSON.stringify(d) + ') → ' + JSON.stringify(want), got === want, 'got ' + JSON.stringify(got));
  }
  ok('stage-write.js applies the SAME rule on every case (the write re-checks what the UI checked)',
    cases.every(([d]) => SW.completionDateIssue(d, TODAY) === P.completionIssue(d, TODAY)));
  ok('no usable "today" is never accepted by the UI rule', P.completionIssue('2026-10-01', '') === 'malformed');
  ok('every refusal has wording for Jo', ['malformed', 'future', 'too-old'].every((k) => typeof P.COMPLETION_MESSAGES[k] === 'string' && P.COMPLETION_MESSAGES[k].length > 5));
  ok('the date label is calendar text with no timezone shift', SW.completionLabel('2026-10-01') === 'Oct 1, 2026' && SW.completionLabel('2026-12-31') === 'Dec 31, 2026');
}

// ═══ 3. the write path ═══════════════════════════════════════════════════
console.log('\n3. commitStageChange({ backfill }) — one transaction, exact patch, quiet');
const clone = (o) => Object.assign({}, o);
function mkWin(seed) {
  const state = { lead: Object.assign({ stage: 'install_in_progress', stageRole: 'job', stageStartedAt: 'T-OLD', closedAt: 'T-SOLD', stageHistory: [{ to: 'install_in_progress' }] }, seed || {}) };
  const rec = { patches: [], notes: [], drip: [], checklist: [], production: [], report: [], reportLoader: [], transactions: 0 };
  const apply = (cur, patch) => {
    const out = clone(cur);
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      out[k] = (v && v.__union) ? (out[k] || []).concat(v.__union) : v;
    });
    return out;
  };
  const win = {
    db: {}, auth: { currentUser: { uid: 'u-jo', email: 'jo@nbd.test', displayName: 'Jo' } },
    doc: (db, c, id) => ({ path: c + '/' + id }),
    collection: (db, c) => ({ path: c }),
    serverTimestamp: () => '__TS__',
    arrayUnion: (...x) => ({ __union: x }),
    runTransaction: async (db, fn) => {
      rec.transactions++;
      const pending = [];
      await fn({ get: async () => ({ exists: () => true, data: () => clone(state.lead) }), update: (r, p) => pending.push(p) });
      pending.forEach((p) => { rec.patches.push(p); state.lead = apply(state.lead, p); });
    },
    updateDoc: async (r, p) => { rec.patches.push(p); state.lead = apply(state.lead, p); },
    addDoc: async (c, d) => { rec.notes.push(d); },
    stageRole: (k) => ROLE(k),
    stageLabel: (k) => ({ install_complete: 'Install Done', install_in_progress: 'Installing', materials_delivered: 'Materials Delivered' }[k] || k),
    EmailDrip: { onStageChange: (...a) => rec.drip.push(a) },
    StageChecklist: { onStageChange: (...a) => rec.checklist.push(a) },
    NBDProduction: { onStageChange: (...a) => rec.production.push(a) },
    NBDAutoBeforeAfter: { onInstallComplete: async (id) => { rec.report.push(id); return 'filed'; } },
    ScriptLoader: { loadBundle: async (n) => { rec.reportLoader.push(n); } },
  };
  return { win, rec, state };
}
const settle = () => new Promise((r) => setImmediate(r));

(async () => {
  const DATE = '2026-10-01';
  {
    const { win, rec, state } = mkWin({ jobType: 'insurance' });
    const SW = loadSW(win);
    const out = await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', {
      jobType: 'insurance',
      backfill: { date: DATE, today: TODAY, skipped: ['Crew Scheduled'], unchecked: ['Warranty Cert Filed'] },
    });
    await settle();
    const p = rec.patches[0] || {};
    ok('one transaction, one lead write', rec.transactions === 1 && rec.patches.length === 1);
    ok('moves to install_complete with the won role', p.stage === 'install_complete' && p.stageRole === 'won');
    ok('completedAt is the chosen day (local noon — same calendar day anywhere in the US)',
      p.completedAt instanceof Date && p.completedAt.getFullYear() === 2026 && p.completedAt.getMonth() === 9 && p.completedAt.getDate() === 1 && p.completedAt.getHours() === 12);
    ok('it entered Install Done on that day (stageStartedAt), not "now"', p.stageStartedAt instanceof Date && +p.stageStartedAt === +p.completedAt);
    const cb = p.completedBackfill || {};
    ok('the quiet flag: completedBackfill carries date, quiet, actor, reason, from-stage and a token',
      cb.date === DATE && cb.quiet === true && cb.reason === 'missed_scheduling' && cb.byUid === 'u-jo' && cb.by === 'jo@nbd.test'
      && cb.fromStage === 'install_in_progress' && typeof cb.token === 'string' && cb.token.length > 10 && cb.at === '__TS__', JSON.stringify(cb));
    const ev = (p.stageHistory && p.stageHistory.__union && p.stageHistory.__union[0]) || {};
    ok('stageHistory event: from → to, backfill, the date, what was skipped and not checked',
      ev.from === 'install_in_progress' && ev.to === 'install_complete' && ev.backfill === true && ev.completedOn === DATE
      && ev.skipped.join() === 'Crew Scheduled' && ev.unchecked.join() === 'Warranty Cert Filed' && ev.by === 'u-jo', JSON.stringify(ev));
    ok('the history timestamp IS the undo token', ev.timestamp === cb.token);
    ok('no closedAt overwrite — the sale date stands', !('closedAt' in p));
    ok('exactly one activity note, with the wording Jo asked for + what was bypassed',
      rec.notes.length === 1 && rec.notes[0].text === 'Marked already completed on Oct 1, 2026 (missed scheduling) — skipped Crew Scheduled; not checked: Warranty Cert Filed'
      && rec.notes[0].type === 'stage_change' && rec.notes[0].leadId === 'L1', JSON.stringify(rec.notes));
    ok('the result hands back what Undo needs (prev stage / role / stageStartedAt / completion fields)',
      out.backfill && out.backfill.prev.stage === 'install_in_progress' && out.backfill.prev.stageRole === 'job'
      && out.backfill.prev.stageStartedAt === 'T-OLD'
      && out.backfill.prev.completedAt === null && out.backfill.prev.completedBackfill === null && out.backfill.token === cb.token, JSON.stringify(out.backfill));
    ok('closedAt was not written, so it is not in prev either (nothing to restore)', !('closedAt' in out.backfill.prev));
    ok('a won move: the caller is told it entered won (the invoice offer cue)', out.enteredWon === true);
    ok('QUIET: no EmailDrip stage toast', rec.drip.length === 0);
    ok('QUIET: no automatic Before & After report (and no bundle load to build one)', rec.report.length === 0 && rec.reportLoader.length === 0);
    ok('the rep\'s own next-step tasks still arrive (internal, no customer send)', rec.checklist.length === 1 && rec.production.length === 1);
    ok('the lead is what the patch says', state.lead.stage === 'install_complete' && state.lead.completedBackfill.date === DATE);
  }
  {
    // POSITIVE CONTROL: the same move WITHOUT backfill fires drip + report, so the
    // absences above are the flag's doing, not a harness that blanks them.
    const { win, rec } = mkWin({});
    const SW = loadSW(win);
    await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', { jobType: 'insurance' });
    await settle();
    ok('control: an ordinary move to Install Done DOES fire the drip toast and the report', rec.drip.length === 1 && rec.report.length === 1);
    ok('control: …and writes no completion fields', !('completedAt' in rec.patches[0]) && !('completedBackfill' in rec.patches[0]));
    ok('control: …with the ordinary "Stage moved to" note', rec.notes[0].text === 'Stage moved to "Install Done"');
  }
  {
    const bad = async (backfill, stage, why) => {
      const { win, rec } = mkWin({});
      const SW = loadSW(win);
      let err = '';
      try { await SW.commitStageChange('L1', stage || 'install_complete', 'install_in_progress', { backfill }); } catch (e) { err = e.message; }
      return { err, rec, why };
    };
    let r = await bad({ date: '2026-10-14', today: TODAY });
    ok('a FUTURE date is refused and nothing is written', r.err === 'BACKFILL_DATE_INVALID' && r.rec.transactions === 0 && r.rec.patches.length === 0 && r.rec.notes.length === 0, r.err);
    r = await bad({ date: 'yesterday', today: TODAY });
    ok('a malformed date is refused and nothing is written', r.err === 'BACKFILL_DATE_INVALID' && r.rec.patches.length === 0, r.err);
    r = await bad({ date: '2026-02-30', today: TODAY });
    ok('an impossible calendar day is refused', r.err === 'BACKFILL_DATE_INVALID' && r.rec.patches.length === 0, r.err);
    r = await bad({ date: '2026-10-01', today: TODAY }, 'final_payment');
    ok('a backfill aimed at any stage but Install Done is refused', r.err === 'BACKFILL_STAGE_INVALID' && r.rec.patches.length === 0, r.err);
  }
  {
    // The same race guards as a kanban move.
    const lost = mkWin({ stage: 'crew_scheduled' });
    let e1 = '';
    try { await loadSW(lost.win).commitStageChange('L1', 'install_complete', 'install_in_progress', { backfill: { date: DATE, today: TODAY } }); } catch (e) { e1 = e.message; }
    ok('another tab moved it first → STAGE_RACE_LOST, nothing written', e1 === 'STAGE_RACE_LOST' && lost.rec.patches.length === 0 && lost.rec.notes.length === 0, e1);
    const noop = mkWin({ stage: 'install_complete' });
    let e2 = '';
    try { await loadSW(noop.win).commitStageChange('L1', 'install_complete', 'install_complete', { backfill: { date: DATE, today: TODAY } }); } catch (e) { e2 = e.message; }
    ok('already at Install Done → STAGE_RACE_NOOP, nothing written (no second completion stamp)', e2 === 'STAGE_RACE_NOOP' && noop.rec.patches.length === 0, e2);
  }
  {
    // A sale-less lead path: a tenant on a page without runTransaction still writes ONE patch.
    const m = mkWin({});
    delete m.win.runTransaction;
    const out = await loadSW(m.win).commitStageChange('L1', 'install_complete', 'install_in_progress', { backfill: { date: DATE, today: TODAY } });
    const p = m.rec.patches[0] || {};
    ok('fallback path (no runTransaction) carries the same completion fields', m.rec.patches.length === 1 && p.completedBackfill && p.completedBackfill.quiet === true && p.completedAt instanceof Date && out.backfill && out.backfill.token === p.completedBackfill.token);
  }

  // ═══ 4. Undo ═══════════════════════════════════════════════════════════
  console.log('\n4. Undo — back to the stage it was on, only while nothing else has moved it');
  {
    const { win, rec, state } = mkWin({ jobType: 'insurance' });
    const SW = loadSW(win);
    const out = await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', { backfill: { date: DATE, today: TODAY } });
    rec.patches.length = 0; rec.notes.length = 0;
    const res = await SW.undoBackfillCompletion('L1', out.backfill);
    const p = rec.patches[0] || {};
    ok('restores stage, role and stage-entry time; leaves the sale date alone', res.stage === 'install_in_progress' && p.stage === 'install_in_progress' && p.stageRole === 'job' && p.stageStartedAt === 'T-OLD' && !('closedAt' in p) && state.lead.closedAt === 'T-SOLD', JSON.stringify(p));
    ok('clears completedAt and completedBackfill (null — the app reads null and absent alike)', p.completedAt === null && p.completedBackfill === null);
    const uev = (p.stageHistory && p.stageHistory.__union && p.stageHistory.__union[0]) || {};
    ok('appends an undo event; the history is never rewritten', uev.backfillUndo === true && uev.undoOf === out.backfill.token && uev.from === 'install_complete' && uev.to === 'install_in_progress'
      && state.lead.stageHistory.length === 3);
    ok('notes the undo', rec.notes.length === 1 && /^Undid "already completed"/.test(rec.notes[0].text));
    ok('Undo is not itself quiet-flagged: the lead is clean again', state.lead.stage === 'install_in_progress' && !state.lead.completedBackfill && !state.lead.completedAt);
  }
  {
    const { win, rec, state } = mkWin({});
    const SW = loadSW(win);
    const out = await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', { backfill: { date: DATE, today: TODAY } });
    state.lead.stage = 'final_photos';                    // somebody moved it on
    rec.patches.length = 0; rec.notes.length = 0;
    let err = '';
    try { await SW.undoBackfillCompletion('L1', out.backfill); } catch (e) { err = e.message; }
    ok('moved on since → UNDO_STALE and nothing written', err === 'UNDO_STALE' && rec.patches.length === 0 && rec.notes.length === 0, err);
    state.lead.stage = 'install_complete';
    state.lead.completedBackfill = Object.assign({}, state.lead.completedBackfill, { token: 'a-later-backfill' });
    err = '';
    try { await SW.undoBackfillCompletion('L1', out.backfill); } catch (e) { err = e.message; }
    ok('a different/later completion is not undone by an old Undo', err === 'UNDO_STALE' && rec.patches.length === 0, err);
    err = '';
    try { await SW.undoBackfillCompletion('L1', { token: 'x' }); } catch (e) { err = e.message; }
    ok('a snapshot without a previous stage is refused', err === 'UNDO_UNAVAILABLE');
  }

  {
    // A lead that was never given a sale date: the move stamps closedAt, and Undo puts it back to null.
    const { win, rec, state } = mkWin({ closedAt: undefined });
    delete state.lead.closedAt;
    const SW = loadSW(win);
    const out = await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', { backfill: { date: DATE, today: TODAY } });
    ok('no sale date on the lead → the usual won-stage closedAt stamp applies, and prev records it as absent', rec.patches[0].closedAt === '__TS__' && out.backfill.prev.closedAt === null);
    rec.patches.length = 0;
    await SW.undoBackfillCompletion('L1', out.backfill);
    ok('…and Undo clears that stamp too', rec.patches[0].closedAt === null);
  }

  // ═══ 5. every consumer honours the quiet flag ═══════════════════════════
  console.log('\n5. after-install automations — quiet means quiet (each with a positive control)');
  // 5a. install-final-invoice trigger: no draft invoice / "Send final invoice" task.
  {
    const IFI = require(path.join(ROOT, 'functions/install-final-invoice.js'))._internal;
    const calls = [];
    const deps = { recordJobEvent: async (db, args) => { calls.push(args); return { finalDraft: { reason: 'drafted' } }; } };
    const before = { stage: 'install_in_progress', stageRole: 'job', activeJobId: 'j1' };
    const quietAfter = { stage: 'install_complete', stageRole: 'won', activeJobId: 'j1', completedBackfill: { quiet: true, token: 't' } };
    const plainAfter = { stage: 'install_complete', stageRole: 'won', activeJobId: 'j1' };
    const q = await IFI.onLeadWrite({}, 'L1', before, quietAfter, deps);
    ok('install-final-invoice: a quiet backfill drafts nothing', q && q.skipped === 'quiet_backfill' && calls.length === 0, JSON.stringify(q));
    await IFI.onLeadWrite({}, 'L1', before, plainAfter, deps);
    ok('control: the same entry WITHOUT the flag records the installed event (drafts the final invoice)', calls.length === 1 && calls[0].event === 'installed');
    calls.length = 0;
    await IFI.onLeadWrite({}, 'L1', Object.assign({}, before, { completedBackfill: { quiet: true } }), quietAfter, deps);
    ok('an ordinary later re-entry (flag already on the lead) is not swallowed', calls.length === 1);
  }
  // 5b. review ask: nudge digest, spine task, anniversary.
  {
    const RN = (require(path.join(ROOT, 'functions/review-request-nudge.js')))._test;
    const NOW = Date.now(), DAY = 86400000;
    const lead = (o) => Object.assign({ userId: 'u1', companyId: 'u1', firstName: 'Pat', lastName: 'J', phone: '5135550142', email: 'p@x.test', stage: 'final_payment', stageRole: 'won', stageStartedAt: NOW - 10 * DAY }, o || {});
    const mkDb = (leads) => ({
      collection(name) {
        const docs = name === 'leads' ? Object.keys(leads).map((id) => ({ id, data: leads[id] })) : [];
        const q = (list) => ({
          where(f, op, v) { return q(list.filter((d) => (op === 'in' ? v.includes(d.data[f]) : d.data[f] === v))); },
          limit() { return q(list); },
          async get() { return { docs: list.map((d) => ({ id: d.id, data: () => d.data, ref: { id: d.id, parent: { parent: { id: d.id } } } })), empty: list.length === 0, size: list.length }; },
        });
        return q(docs);
      },
      collectionGroup() { return { where() { return { limit() { return { async get() { return { docs: [] }; } }; } }; } }; },
    });
    // Invoices answer as "none owed" (a paid-in-full job).
    const db = mkDb({ QUIET: lead({ completedBackfill: { quiet: true } }), PLAIN: lead({}) });
    const origCollection = db.collection.bind(db);
    db.collection = (n) => {
      if (n !== 'invoices') return origCollection(n);
      const chain = { where() { return chain; }, limit() { return chain; }, async get() { return { docs: [], empty: true, size: 0 }; } };
      return chain;
    };
    let ids = [];
    try { ids = (await RN.findReviewDueLeads(db, 'u1')).map((x) => x.id); } catch (e) { ids = ['ERR ' + e.message]; }
    ok('review-request-nudge: a quiet backfill is never nudged', !ids.includes('QUIET'), ids.join());
    ok('control: the same paid job WITHOUT the flag is nudged (the harness really finds due leads)', ids.includes('PLAIN'), ids.join());
  }
  {
    const AT = require(path.join(ROOT, 'functions/anniversary-touch.js'))._test;
    const DAY = 86400000;
    const lead = (o) => Object.assign({ userId: 'u1', stage: 'install_complete', completedAt: Date.now() - 370 * DAY }, o || {});
    const leads = { QUIET: lead({ completedBackfill: { quiet: true } }), PLAIN: lead({}) };
    const applyOp = (a, op, v) => (op === '==' ? a === v : v.indexOf(a) !== -1);
    const mk = (docs) => ({ where(f, op, v) { return mk(docs.filter((d) => applyOp(d.data[f], op, v))); }, limit() { return mk(docs); }, async get() { return { docs: docs.map((d) => ({ id: d.id, data: () => d.data })) }; } });
    const db = { collection: (n) => { if (n !== 'leads') return mk([]); return mk(Object.keys(leads).map((id) => ({ id, data: leads[id] }))); }, collectionGroup: () => mk([]) };
    const ids = (await AT.findAnniversaryLeads(db, 'u1')).map((x) => x.id);
    ok('anniversary-touch: a quiet backfill queues no anniversary check-in', !ids.includes('QUIET'), ids.join());
    ok('control: the same finished job WITHOUT the flag does', ids.includes('PLAIN'), ids.join());
  }
  {
    const SPINE = require(path.join(ROOT, 'functions/job-spine.js'));
    const mkDb = (lead) => ({
      collection(c) {
        return { doc(id) { return {
          async get() { return { exists: c === 'leads', data: () => lead }; },
          collection() { return { doc() { return { async create() {} }; } }; },
        }; }, where() { const ch = { where() { return ch; }, limit() { return ch; }, async get() { return { docs: [], empty: true }; } }; return ch; } };
      },
    });
    const FV = { serverTimestamp: () => 'TS' };
    const deps = { FieldValue: FV, logger: { info() {}, warn() {}, error() {} }, now: () => Date.now() };
    const base = { userId: 'u1', companyId: 'u1', stage: 'final_payment', stageRole: 'won' };
    const q = await SPINE.requestReviewTaskIfPaid(mkDb(Object.assign({}, base, { completedBackfill: { quiet: true } })), 'L1', 'u1', deps);
    ok('job spine: no "Request Review" task for a quiet backfill', q && q.created === false && q.reason === 'quiet_backfill', JSON.stringify(q));
    const c = await SPINE.requestReviewTaskIfPaid(mkDb(base), 'L1', 'u1', deps);
    ok('control: without the flag the same lead is NOT stopped at that gate', !(c && c.reason === 'quiet_backfill'), JSON.stringify(c));
  }
  // 5c. client engines (vm): review bell, review deck, Ask Joe's morning opportunity.
  {
    const src = {
      engine: read('docs/pro/js/review-engine.js'),
      deck: read('docs/pro/js/review-deck.js'),
      revenue: read('docs/pro/js/collected-revenue.js'),
      proactive: read('docs/pro/js/ask-joe-proactive.js'),
    };
    const rec = { added: [] };
    const mkClient = (leads) => {
      const win = {
        _leads: leads, _user: { uid: 'u1' }, db: {}, _brand: () => ({ legalName: 'NBD' }),
        doc: (db, ...p) => ({ path: p.join('/') }), collection: (db, ...p) => ({ path: p.join('/') }), query: (c) => c, where: () => null,
        getDoc: async () => ({ exists: () => false, data: () => ({}) }), getDocs: async () => ({ empty: true, docs: [] }),
        addDoc: async (c, d) => { rec.added.push([c.path, d]); return { id: 'a' }; }, updateDoc: async () => {},
        serverTimestamp: () => '__TS__', addEventListener() {}, dispatchEvent() {},
        NBDComms: { sendSMS: async () => ({}), sendEmail: async () => ({}) },
      };
      win.window = win;
      const sandbox = Object.assign(win, { document: { addEventListener() {}, getElementById() { return null; } }, localStorage: { getItem: () => null, setItem() {} },
        showToast() {}, setTimeout: () => 0, clearTimeout() {}, CustomEvent: function () {}, console, Date, Math, JSON, Promise, encodeURIComponent, URLSearchParams });
      vm.createContext(sandbox);
      vm.runInContext(src.revenue, sandbox, { filename: 'collected-revenue.js' });
      const real = win.NBDRevenue;
      win.NBDRevenue = Object.assign({}, real, { cached: () => [], loadInvoices: async () => [] });
      vm.runInContext(src.engine, sandbox, { filename: 'review-engine.js' });
      vm.runInContext(src.deck, sandbox, { filename: 'review-deck.js' });
      return win;
    };
    const recent = { seconds: Math.floor(Date.now() / 1000) - 2 * 86400 };
    const lead = (id, o) => Object.assign({ id, userId: 'u1', firstName: id, lastName: 'T', stage: 'final_payment', stageRole: 'won', stageStartedAt: recent }, o || {});
    const win = mkClient([lead('QUIET', { completedBackfill: { quiet: true } }), lead('PLAIN')]);
    win.ReviewEngine.checkAutoReviews();
    await settle(); await settle();
    const bells = rec.added.filter(([p]) => p === 'notifications').map(([, d]) => d.leadId);
    ok('review bell: nothing for a quiet backfill', !bells.includes('QUIET'), bells.join());
    ok('control: the bell DOES fire for the same paid job without the flag', bells.includes('PLAIN'), bells.join());
    const deck = win.NBDReviewDeck.candidates(win._leads, 'u1').map((l) => l.id);
    ok('review deck / Home count: a quiet backfill is not a candidate', !deck.includes('QUIET') && deck.includes('PLAIN'), deck.join());
    // Ask Joe proactive: the "Ask for review" opportunity reads stage + completedAt.
    const pro = strip(src.proactive);
    ok('Ask Joe morning brief: the review opportunity skips a quiet backfill', /if \(!lead\.completedAt\) return false;\s*if \(lead\.completedBackfill\) return false;/.test(pro));
  }

  // ═══ 6. the panel wiring ═══════════════════════════════════════════════
  console.log('\n6. schedule-planner.js — the button, the confirm, the single write path');
  {
    const ui = strip(read('docs/pro/js/schedule-planner.js'));
    ok('Needs and Missed rows carry the control; Next 30 days rows do not', /kind !== 'scheduled' \? doneHtml\(r\) : ''/.test(ui));
    ok('the Missed group renders with the same row UI', /rowHtml\(r, 'missed'\)/.test(ui) && /Missed — date passed/.test(ui));
    ok('the date input defaults to today and cannot go past it', /type="date" class="sp-done-date" max="' \+ esc\(today\)/.test(ui) && /\|\| today\)/.test(ui));
    ok('the move goes through stage-write.js commitStageChange with opts.backfill (not a raw updateDoc of the stage)',
      /commitStageChange\(id, 'install_complete'/.test(ui) && /backfill: \{ date, skipped, unchecked/.test(ui)
      && !/updateDoc\([^)]*stage:\s*'install_complete'/.test(ui));
    ok('the date is validated before the write', /P\(\)\.completionIssue\(date, todayYmd\(\)\)/.test(ui));
    ok('the offer is re-judged at tap time (a stale row cannot move a lead that already moved)', /if \(!offerCompleted\(lead\)\)/.test(ui));
    ok('the toast says what Jo asked for and keeps a one-tap Undo', /'Marked completed ✓ - now '/.test(ui) && /undoText: snap \? 'Undo'/.test(ui) && /undoBackfillCompletion\(id, snap\)/.test(ui));
    ok('viewers never see the panel (existing) and the offer itself checks the role', /role: claims\.role/.test(ui) && /role\(\) === 'viewer'/.test(ui));
    ok('no inline handlers or inline scripts were added', !/\son[a-z]+\s*=\s*"/i.test(ui) && !/<script/i.test(ui));
    const css = read('docs/pro/css/google-calendar.css');
    ok('44px touch targets on the new controls', /\.sp-done-open \{ min-height: 44px/.test(css) && /\.sp-done input \{[^}]*min-height: 44px/.test(css) && /\.sp-done-go, \.sp-done-no \{ min-height: 44px/.test(css));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
