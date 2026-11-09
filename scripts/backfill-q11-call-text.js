#!/usr/bin/env node
/**
 * scripts/backfill-q11-call-text.js — Call to Close Q11, the second backfill
 * (2026-11-09): give tasks and leads filed before the change the same generic,
 * viewer-safe shape the live writers now write.
 *
 * documentation/projects/SESSION-2026-11-09-call-to-close-p0.md, "For Jo,
 * still open" item 1. scripts/backfill-q11-task-summaries.js scrubs the AI
 * summary out of task notes; this one does the rest. Run the summary scrub
 * FIRST: a cube-/sms- task whose notes still carry a "Call: " paragraph is
 * skipped here (counted "summary scrub first").
 *
 * Per task under leads/{leadId}/tasks (collection group 'tasks'), when the
 * task does not already have callText: true:
 *   cube-<callId> / sms-<dayId>   title / text become "Follow up with <who>"
 *       (who: the phone_calls / phone_text_days doc's contactName, exactly as
 *       call-center-logic.js buildFollowUpTask computes it); the notes drop the
 *       "You said you would" block. A task whose call / text day is gone is
 *       skipped ("who unknown").
 *   thursday-<callId>   title / text are cut at " — <issue>". The expected
 *       title is rebuilt with thursday-logic.js buildTask from the call doc's
 *       stored extraction, call and route, and its issue suffix must be the
 *       call's issue; otherwise skipped ("issue mismatch").
 *   promise-<callId>[-n] with a why   text / title become
 *       promise-logic.js taskText(kind, '', waitingOn), why ''.
 * Each is changed only when the task still holds exactly what the server
 * wrote (rebuilt with the live writer from the task's own content); anything
 * else is an owner's edit and is skipped ("edited"). The full text goes in
 * leads/{leadId}/task_call_text/{taskId} as { full, generic } through
 * task-call-text.js split / sideDoc (the shape the writers write), with
 * create(): an existing sidecar is never overwritten. The sidecar is written
 * BEFORE the task, so a crash never leaves a generic task without its call
 * text; a rerun that finds the identical sidecar carries on with the task,
 * a different sidecar skips the task ("other sidecar"). The task update sets
 * the generic fields, callText: true and updatedAt (server time), with
 * update() conditional on the updateTime the page read.
 *
 * Per lead (collection group 'leads', top-level leads/{leadId} only) with
 * publicLeadCollection 'thursday_calls' whose notes still are the old
 * thursday-logic.js callNotes() text ("📞 Thursday call …", rebuilt from the
 * call doc, or equal to the call doc's callNotes): the call doc's callNotes
 * gets that text when it has none (update, conditional on the call doc's
 * updateTime), THEN lead.notes becomes leadNotesPointer(call) (+ updatedAt,
 * conditional on the page's updateTime). A call doc whose callNotes holds
 * other text is left alone and the lead skipped ("call notes differ").
 *
 * No updateTime on a read: no write (the Admin SDK reads { lastUpdateTime:
 * undefined } as no precondition). Never deletes. Idempotent: a second run
 * finds nothing to change.
 *
 * Output is counts only: never a title, notes, a name, an issue or an id, and
 * never a Firestore error's text (a fatal error prints its status code only).
 *
 * DRY RUN by default. --apply writes (production: only with Jo's OK, per run).
 * --company <companyId> limits it to leads of one company: lead.companyId, or
 * for a lead with no companyId (a solo owner, NBD's own feed) lead.userId.
 * --project <id> (default nobigdeal-pro).
 *
 * Credentials: Application Default Credentials, or a short-lived token in
 * NBD_ACCESS_TOKEN (Firestore REST via scripts/_firestore-rest.js:
 * collectionGroup, create, update precondition, get updateTime).
 *
 * Usage:
 *   node scripts/backfill-q11-call-text.js                        # dry run, every company
 *   node scripts/backfill-q11-call-text.js --company <companyId>  # dry run, one company
 *   node scripts/backfill-q11-call-text.js --apply [--company <companyId>]   # write
 */
'use strict';

const path = require('path');
const FN = path.join(__dirname, '..', 'functions');
const TCT = require(path.join(FN, 'task-call-text.js'));
const L = require(path.join(FN, 'call-center-logic.js'));
const T = require(path.join(FN, 'integrations', 'thursday-logic.js'));
const PR = require(path.join(FN, 'promise-logic.js'));
const { parseArgs, leadInCompany } = require('./backfill-q11-task-summaries.js');
const { describeFatal } = require('./retag-voicemail-activity.js');

const LEAD_TASK = /^leads\/([^/]+)\/tasks\/([^/]+)$/;
const LEAD_DOC = /^leads\/([^/]+)$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const OLD_LEAD_NOTES = '📞 Thursday call ';
// The pointer line buildFollowUpTask writes when a call had a summary, as the
// writer itself produces it (no copy of the string here).
const POINTER = L.buildFollowUpTask({ call: { id: 'x' }, notes: { promises: [], followUpDate: 'x', summary: 'x' }, leadId: 'x', ownerUid: 'x', todayYmd: 'x' }).notes;

const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 'cube' | 'sms' | 'thursday' | 'promise' for a leads/{id}/tasks/{taskId} path, else null. */
function kindOf(taskPath) {
  const m = LEAD_TASK.exec(String(taskPath || ''));
  if (!m) return null;
  return ['cube', 'sms', 'thursday', 'promise'].find((p) => m[2].startsWith(p + '-')) || null;
}

/** Where a cube-/sms-/thursday- task's call lives (null for promise, or a bad id). */
function sourcePathOf(kind, taskId) {
  const rest = String(taskId).slice(kind.length + 1);
  if (!ID.test(rest)) return null;
  if (kind === 'cube') return 'phone_calls/' + rest;
  if (kind === 'sms') return 'phone_text_days/' + rest;
  if (kind === 'thursday') { try { return 'thursday_calls/' + T.callDocId(rest); } catch (_) { return null; } }
  return null;
}

/** The "You said you would" bullets parsed back to promises; two readings of the first when its text ends "(by …)". */
function promiseReadings(block) {
  const lines = block.split('\n');
  if (lines[0] !== 'You said you would:' || lines.length < 2) return null;
  const bullets = lines.slice(1);
  if (!bullets.every((b) => b.startsWith('• ') && b.length > 2)) return null;
  const parse = (b, split) => {
    const t = b.slice(2);
    const m = split ? /^(.*) \(by ([^()]*)\)$/.exec(t) : null;
    return m ? { who: 'jo', text: m[1], due: m[2] } : { who: 'jo', text: t };
  };
  const rest = bullets.slice(1).map((b) => parse(b, true));
  return [true, false].map((s) => [parse(bullets[0], s)].concat(rest));
}

/**
 * A cube-/sms- task: { generic } or { skip: reason }. src is the phone_calls /
 * phone_text_days doc (null when gone).
 */
function planFollowUp(kind, taskId, data, src) {
  if (!src) return { skip: 'whoUnknown' };
  const notes = typeof data.notes === 'string' ? data.notes : '';
  const paras = notes ? notes.split('\n\n') : [];
  if (paras.some((p) => /^Call: /.test(p))) return { skip: 'needsSummaryScrub' };
  const hasPointer = paras.includes(POINTER);
  const rest = paras.filter((p) => p !== POINTER);
  if (rest.length > 1) return { skip: 'edited' };
  const readings = rest.length ? promiseReadings(rest[0]) : [[]];
  if (!readings) return { skip: 'edited' };
  const id = String(taskId).slice(kind.length + 1);
  for (const promises of readings) {
    const n = { promises, summary: hasPointer ? 'x' : '', followUpDate: promises.length ? null : 'x', urgent: false };
    const args = { notes: n, leadId: 'x', ownerUid: 'x', todayYmd: 'x' };
    const built = kind === 'sms'
      ? L.buildTextDayTask(Object.assign({ day: { id, contactName: src.contactName } }, args))
      : L.buildFollowUpTask(Object.assign({ call: { id, contactName: src.contactName } }, args));
    if (!built) continue;
    const full = Object.assign({ title: built.title, text: built.text, notes: built.notes }, built.callTextFull ? built.callTextFull.full : {});
    if (data.title !== full.title || data.text !== full.text || notes !== full.notes) continue;
    if (!built.callTextFull) return { skip: 'alreadyGeneric' };
    return { generic: built.callTextFull.generic };
  }
  return { skip: 'edited' };
}

/** A thursday- task: { generic } or { skip }. src is the thursday_calls doc. */
function planThursday(data, src) {
  if (!src) return { skip: 'sourceMissing' };
  let built = null;
  try {
    built = T.buildTask({ extraction: src.extraction, call: src.call || {}, route: { action: src.route && src.route.action }, leadId: 'x', ownerUid: 'x' });
  } catch (_) { built = null; }
  const g = built && built.callTextFull ? built.callTextFull.generic : null;
  if (built && data.title === built.title && data.text === built.text) return { skip: 'alreadyGeneric' };
  // The cut: the title ends " — <issue>", with the call's own issue
  // (thursday-logic.js shortIssue: the issue, else Bland's summary, 90 chars).
  const issue = T.str(src.issue || (src.call && src.call.summary) || 'called', 90);
  const title = typeof data.title === 'string' ? data.title : '';
  if (!g || !issue || !title.endsWith(' — ' + issue)) return { skip: 'issueMismatch' };
  const full = built.callTextFull.full;
  if (title.slice(0, -(issue.length + 3)) !== g.title || title !== full.title || data.text !== full.text) return { skip: 'edited' };
  return { generic: g };
}

/** A promise- task: { generic } or { skip }. */
function planPromise(data) {
  const why = data.why;
  if (typeof why !== 'string' || !why) return { skip: 'alreadyGeneric' };
  if (data.kind !== 'promise' || !has(PR.KINDS, data.promiseKind)) return { skip: 'edited' };
  const waitingOn = data.promiseKind === 'waiting' ? data.waitingOn : null;
  const fullText = PR.taskText(data.promiseKind, why, waitingOn);
  if (why !== PR.cleanWhy(why) || data.text !== fullText || data.title !== fullText) return { skip: 'edited' };
  const generic = PR.taskText(data.promiseKind, '', waitingOn);
  return { generic: { title: generic, text: generic, why: '' } };
}

/** The old lead notes and what to write, or { skip }. call is the thursday_calls doc. */
function planLead(lead, call) {
  if (!call) return { skip: 'sourceMissing' };
  let rebuilt = null;
  try { rebuilt = T.callNotes(call.extraction, call.call || {}); } catch (_) { rebuilt = null; }
  const callNotes = typeof call.callNotes === 'string' && call.callNotes ? call.callNotes : null;
  if (lead.notes !== rebuilt && lead.notes !== callNotes) return { skip: 'edited' };
  if (callNotes && callNotes !== lead.notes) return { skip: 'callNotesDiffer' };
  return { copyCallNotes: !callNotes, notes: T.leadNotesPointer(call.call || {}) };
}

async function run({ db, args, log = console.log, serverTimestamp, pageSize = 500 }) {
  const counts = {
    tasksScanned: 0, outOfScope: 0, notCandidate: 0, alreadyDone: 0, alreadyGeneric: 0,
    edited: 0, whoUnknown: 0, sourceMissing: 0, issueMismatch: 0, needsSummaryScrub: 0, otherSidecar: 0,
    toChange: 0, byKind: { cube: 0, sms: 0, thursday: 0, promise: 0 }, sidecarsWritten: 0, tasksWritten: 0,
    leadsScanned: 0, leadsOutOfScope: 0, leadsNotOld: 0, leadsEdited: 0, leadsCallMissing: 0, leadsCallNotesDiffer: 0,
    leadsToChange: 0, callNotesWritten: 0, leadsWritten: 0, failures: 0,
  };
  const leadCache = new Map();
  async function companyOwns(leadId) {
    if (!leadCache.has(leadId)) {
      const s = await db.doc('leads/' + leadId).get();
      leadCache.set(leadId, leadInCompany(s.exists ? s.data() : null, args.company));
    }
    return leadCache.get(leadId);
  }
  async function read(p) {
    const s = await db.doc(p).get();
    return s && s.exists ? { data: s.data() || {}, updateTime: s.updateTime } : null;
  }
  async function pages(group, each) {
    let last = null;
    for (;;) {
      let q = db.collectionGroup(group).orderBy('__name__').limit(pageSize);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      for (const d of snap.docs) await each(d);
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break;
    }
  }

  log('Q11 call-text backfill (' + args.project + ', ' + (args.company ? 'company ' + args.company : 'every company') + ', ' + (args.apply ? 'APPLY' : 'DRY RUN') + ')');

  await pages('tasks', async (d) => {
    counts.tasksScanned++;
    const p = d.ref.path;
    const m = LEAD_TASK.exec(p);
    const kind = kindOf(p);
    if (!m || !kind) { counts.notCandidate++; return; }
    const data = d.data() || {};
    if (data.callText === true) { counts.alreadyDone++; return; }
    if (args.company && !(await companyOwns(m[1]))) { counts.outOfScope++; return; }
    let plan;
    if (kind === 'promise') plan = planPromise(data);
    else {
      const sp = sourcePathOf(kind, m[2]);
      const src = sp ? await read(sp) : null;
      plan = kind === 'thursday' ? planThursday(data, src && src.data) : planFollowUp(kind, m[2], data, src && src.data);
    }
    if (plan.skip) { counts[plan.skip]++; return; }
    counts.toChange++;
    counts.byKind[kind]++;
    if (!args.apply) return;
    if (!d.updateTime) { counts.failures++; return; }
    // The task as the writers store it: split() puts { full, generic } on it.
    const split = TCT.split(Object.assign({}, data), plan.generic);
    if (!split.callTextFull) { counts.alreadyGeneric++; return; }
    try {
      // Sidecar first: a crash after it leaves the full task, never a bare generic one.
      if (await TCT.writeSideIfAbsent(db, p, split)) counts.sidecarsWritten++;
      else {
        const have = await read(TCT.sidePath(p));
        const want = TCT.sideDoc(p, split);
        if (!have || !same(have.data.full, want.full) || !same(have.data.generic, want.generic)) { counts.otherSidecar++; return; }
      }
      const pairs = [];
      for (const k of Object.keys(split.callTextFull.generic)) pairs.push(k, split.callTextFull.generic[k]);
      pairs.push('callText', true, 'updatedAt', serverTimestamp(), { lastUpdateTime: d.updateTime });
      await db.doc(p).update(...pairs);
      counts.tasksWritten++;
    } catch (_) {
      counts.failures++; // the error text can quote the document; not printed
    }
  });

  await pages('leads', async (d) => {
    const p = d.ref.path;
    if (!LEAD_DOC.test(p)) return;
    counts.leadsScanned++;
    const lead = d.data() || {};
    if (lead.publicLeadCollection !== 'thursday_calls' || typeof lead.notes !== 'string' || !lead.notes.startsWith(OLD_LEAD_NOTES)) { counts.leadsNotOld++; return; }
    if (args.company && !leadInCompany(lead, args.company)) { counts.leadsOutOfScope++; return; }
    const callPath = ID.test(String(lead.publicLeadId || '')) ? 'thursday_calls/' + lead.publicLeadId : null;
    const call = callPath ? await read(callPath) : null;
    const plan = planLead(lead, call && call.data);
    if (plan.skip === 'sourceMissing') { counts.leadsCallMissing++; return; }
    if (plan.skip === 'callNotesDiffer') { counts.leadsCallNotesDiffer++; return; }
    if (plan.skip) { counts.leadsEdited++; return; }
    counts.leadsToChange++;
    if (!args.apply) return;
    if (!d.updateTime || (plan.copyCallNotes && !call.updateTime)) { counts.failures++; return; }
    try {
      // The call keeps the text first; only then does the lead point at it.
      if (plan.copyCallNotes) {
        await db.doc(callPath).update('callNotes', lead.notes, { lastUpdateTime: call.updateTime });
        counts.callNotesWritten++;
      }
      await db.doc(p).update('notes', plan.notes, 'updatedAt', serverTimestamp(), { lastUpdateTime: d.updateTime });
      counts.leadsWritten++;
    } catch (_) {
      counts.failures++;
    }
  });

  const c = counts;
  log('  tasks scanned                        : ' + c.tasksScanned);
  log('  not a lead cube-/sms-/thursday-/promise- task (skip): ' + c.notCandidate);
  log('  already callText (skip)              : ' + c.alreadyDone);
  if (args.company) log('  other company (skip)                 : ' + c.outOfScope);
  log('  already generic (skip)               : ' + c.alreadyGeneric);
  log('  edited by an owner (skip)            : ' + c.edited);
  log('  who unknown, call gone (skip)        : ' + c.whoUnknown);
  log('  Thursday call gone (skip)            : ' + c.sourceMissing);
  log('  Thursday issue mismatch (skip)       : ' + c.issueMismatch);
  log('  summary scrub first (skip)           : ' + c.needsSummaryScrub);
  if (args.apply) log('  other sidecar already there (skip)   : ' + c.otherSidecar);
  log('  tasks to make generic                : ' + c.toChange + ' (cube ' + c.byKind.cube + ', sms ' + c.byKind.sms + ', thursday ' + c.byKind.thursday + ', promise ' + c.byKind.promise + ')');
  log('  leads scanned                        : ' + c.leadsScanned);
  log('  not an old Thursday lead (skip)      : ' + c.leadsNotOld);
  if (args.company) log('  other company (skip)                 : ' + c.leadsOutOfScope);
  log('  lead notes edited (skip)             : ' + c.leadsEdited);
  log('  Thursday call gone (skip)            : ' + c.leadsCallMissing);
  log('  call notes differ (skip)             : ' + c.leadsCallNotesDiffer);
  log('  leads to point at the call           : ' + c.leadsToChange);
  if (!c.toChange && !c.leadsToChange) log('nothing to change');
  else if (args.apply) log('  written: sidecars ' + c.sidecarsWritten + ', tasks ' + c.tasksWritten + ', call notes ' + c.callNotesWritten + ', leads ' + c.leadsWritten + '; failures: ' + c.failures);
  else log('DRY RUN: nothing written. Add --apply to write (production: only with Jo\'s OK).');
  return { counts };
}

module.exports = { parseArgs, kindOf, sourcePathOf, planFollowUp, planThursday, planPromise, planLead, run, POINTER };

if (require.main === module) {
  (async () => {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    let r;
    if (process.env.NBD_ACCESS_TOKEN) {
      const R = require('./_firestore-rest');
      const db = R.restFirestore({ projectId: args.project, token: process.env.NBD_ACCESS_TOKEN });
      r = await run({ db, args, serverTimestamp: R.serverTimestamp });
    } else {
      const { initAdmin, getFirestore, FieldValue } = require('./_admin');
      initAdmin({ projectId: args.project });
      r = await run({ db: getFirestore(), args, serverTimestamp: () => FieldValue.serverTimestamp() });
    }
    process.exit(r.counts.failures ? 1 : 0);
  })().catch((e) => { console.error(describeFatal(e)); process.exit(1); });
}
