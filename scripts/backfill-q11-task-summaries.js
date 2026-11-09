#!/usr/bin/env node
/**
 * scripts/backfill-q11-task-summaries.js — Call to Close Q11 backfill
 * (2026-11-09): take call content out of follow-up tasks filed before the
 * writers stopped putting it there.
 *
 * Viewers read a customer's tasks. Since 2026-11-09 the writers put only a
 * pointer line ("The summary is on the customer's timeline.") in a follow-up
 * task's notes. Tasks filed before that still carry the AI summary:
 *   leads/{leadId}/tasks/cube-<callId>, sms-<dayId>   a "Call: <summary>" paragraph
 *   leads/{leadId}/tasks/thursday-<callId>            "Summary: …" and "Urgent: …" lines
 * Each such task's notes go through scrubTaskSummary
 * (functions/call-center-logic.js; 'thursday' mode for thursday- tasks), the
 * same function moveCallToLead copies a task through.
 *
 * What it writes: notes (the scrubbed text) and updatedAt (server time, as
 * every server-side task write in functions/call-center.js does), with
 * update(), so a task deleted mid-run is never re-created. Nothing else:
 * never deletes a task, never touches a task whose id does not start with
 * cube- / sms- / thursday-, a task outside leads/{id}/tasks, or a task whose
 * notes scrubTaskSummary leaves as they are. Idempotent: a second run finds
 * nothing to change.
 *
 * Output is counts only. It never prints notes, the summary, or a write's
 * error text: those are call content.
 *
 * DRY RUN by default. --apply writes (needs Jo's OK for a production run).
 * --company <companyId> limits it to leads of one company: lead.companyId, or
 * for a lead with no companyId (a solo owner, NBD's own feed) lead.userId.
 *
 * Credentials: Application Default Credentials (`gcloud auth
 * application-default login`), or a short-lived token in NBD_ACCESS_TOKEN
 * (`NBD_ACCESS_TOKEN=$(gcloud auth print-access-token)`), which goes over
 * Firestore REST (scripts/_firestore-rest.js, collection-group query).
 *
 * Usage:
 *   node scripts/backfill-q11-task-summaries.js                        # dry run, every company
 *   node scripts/backfill-q11-task-summaries.js --company <companyId>  # dry run, one company
 *   node scripts/backfill-q11-task-summaries.js --apply [--company <companyId>]   # write
 */
'use strict';

const path = require('path');
const { scrubTaskSummary } = require(path.join(__dirname, '..', 'functions', 'call-center-logic.js'));

const PREFIXES = ['cube', 'sms', 'thursday'];
const LEAD_TASK = /^leads\/([^/]+)\/tasks\/([^/]+)$/;

function parseArgs(argv) {
  const out = { apply: false, company: '', project: 'nobigdeal-pro' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') { out.apply = true; continue; }
    if (k === '--company' || k === '--project') {
      const v = String(argv[++i] || '');
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(v)) throw new Error(k + ' must be a document id');
      out[k.slice(2)] = v;
      continue;
    }
    throw new Error('unknown argument: ' + k);
  }
  return out;
}

/** The id prefix (cube / sms / thursday) of a leads/{id}/tasks/{taskId} path, else null. */
function prefixOf(taskPath) {
  const m = LEAD_TASK.exec(String(taskPath || ''));
  if (!m) return null;
  return PREFIXES.find((p) => m[2].startsWith(p + '-')) || null;
}

/** { notes } to write, or null when the task is out of scope or already clean. */
function planTask(taskPath, data) {
  const prefix = prefixOf(taskPath);
  if (!prefix) return null;
  const notes = (data || {}).notes;
  if (typeof notes !== 'string') return null;
  const next = scrubTaskSummary(notes, prefix === 'thursday' ? 'thursday' : undefined);
  return typeof next === 'string' && next !== notes ? { notes: next } : null;
}

/** Does leads/{leadId} belong to company? companyId, else (no companyId) userId. */
function leadInCompany(lead, company) {
  if (!lead) return false;
  if (lead.companyId) return lead.companyId === company;
  return lead.userId === company;
}

async function run({ db, args, log = console.log, serverTimestamp, pageSize = 500 }) {
  const counts = { scanned: 0, notLeadTask: 0, otherPrefix: 0, alreadyClean: 0, outOfScope: 0, toChange: 0, byPrefix: { cube: 0, sms: 0, thursday: 0 }, written: 0, failures: 0 };
  const leadCache = new Map();
  async function companyOwns(leadId) {
    if (!leadCache.has(leadId)) {
      const s = await db.doc('leads/' + leadId).get();
      leadCache.set(leadId, leadInCompany(s.exists ? s.data() : null, args.company));
    }
    return leadCache.get(leadId);
  }

  log('Q11 task-summary backfill (' + args.project + ', ' + (args.company ? 'company ' + args.company : 'every company') + ', ' + (args.apply ? 'APPLY' : 'DRY RUN') + ')');
  let last = null;
  for (;;) {
    let q = db.collectionGroup('tasks').orderBy('__name__').limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      counts.scanned++;
      const p = d.ref.path;
      const m = LEAD_TASK.exec(p);
      if (!m) { counts.notLeadTask++; continue; }
      const prefix = prefixOf(p);
      if (!prefix) { counts.otherPrefix++; continue; }
      const patch = planTask(p, d.data());
      if (!patch) { counts.alreadyClean++; continue; }
      if (args.company && !(await companyOwns(m[1]))) { counts.outOfScope++; continue; }
      counts.toChange++;
      counts.byPrefix[prefix]++;
      if (!args.apply) continue;
      try {
        await db.doc(p).update('notes', patch.notes, 'updatedAt', serverTimestamp());
        counts.written++;
      } catch (_) {
        counts.failures++; // the error text can quote the document; not printed
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }

  log('  tasks scanned                     : ' + counts.scanned);
  log('  not under leads/{id}/tasks (skip) : ' + counts.notLeadTask);
  log('  other id prefix (skip)            : ' + counts.otherPrefix);
  log('  cube-/sms-/thursday-, clean       : ' + counts.alreadyClean);
  if (args.company) log('  old notes, other company (skip)   : ' + counts.outOfScope);
  log('  old notes to scrub                : ' + counts.toChange + ' (cube ' + counts.byPrefix.cube + ', sms ' + counts.byPrefix.sms + ', thursday ' + counts.byPrefix.thursday + ')');
  if (!counts.toChange) log('nothing to change');
  else if (args.apply) log('  written: ' + counts.written + ', failures: ' + counts.failures);
  else log('DRY RUN: nothing written. Add --apply to write (production: only with Jo\'s OK).');
  return { counts };
}

module.exports = { parseArgs, prefixOf, planTask, leadInCompany, run };

if (require.main === module) {
  (async () => {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    let r;
    if (process.env.NBD_ACCESS_TOKEN) {
      // Token mode: Firestore REST with a short-lived access token (scripts/_firestore-rest.js).
      const R = require('./_firestore-rest');
      const db = R.restFirestore({ projectId: args.project, token: process.env.NBD_ACCESS_TOKEN });
      r = await run({ db, args, serverTimestamp: R.serverTimestamp });
    } else {
      const { initAdmin, getFirestore, FieldValue } = require('./_admin');
      initAdmin({ projectId: args.project });
      r = await run({ db: getFirestore(), args, serverTimestamp: () => FieldValue.serverTimestamp() });
    }
    process.exit(r.counts.failures ? 1 : 0);
  })().catch((e) => { console.error(e.message || e); process.exit(1); });
}
