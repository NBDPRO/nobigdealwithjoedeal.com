#!/usr/bin/env node
/**
 * scripts/retag-voicemail-activity.js — Call to Close Q11 item 4 backfill
 * (2026-11-09): move voicemail rows saved before the change off the viewer
 * read allowlist.
 *
 * Since 2026-11-09 docs/pro/js/voicemail.js files its timeline row as
 * source 'voicemail' (firestore.rules: a viewer reads activity of source
 * 'rep' and 'visit-capture' only). Rows filed before that are
 * leads/{leadId}/activity/{id} with type 'voicemail' and source 'rep', and
 * carry the transcript and an AI summary, so a viewer can still read them.
 * This retags each such row to source 'voicemail'. Every non-viewer reader
 * reads the whole collection (or is server-side), so nobody else loses a row.
 *
 * What it writes: source = 'voicemail', nothing else, with update(), so a row
 * deleted mid-run is never re-created, conditional on the updateTime the page
 * read (activity rows are never edited by clients, so a mismatch means a
 * server touched it; counted as a failure, a rerun picks it up). Never touches
 * a row that is not under leads/{id}/activity, not type 'voicemail', or not
 * source 'rep'. Idempotent: a second run finds nothing to change.
 *
 * Output is counts only. It never prints a transcript, a summary, a lead or
 * document id, or any Firestore error's text (a failed write is counted; a
 * fatal read error prints its status code only): those can quote the row.
 *
 * DRY RUN by default. --apply writes (needs Jo's OK for a production run).
 * --company <companyId> limits it to leads of one company: lead.companyId, or
 * for a lead with no companyId (a solo owner) lead.userId.
 *
 * Credentials: Application Default Credentials (`gcloud auth
 * application-default login`). Token mode (NBD_ACCESS_TOKEN, Firestore REST
 * via scripts/_firestore-rest.js) needs the adapter's collection-group query
 * and update precondition, which branch q11-backfill adds with this same API
 * shape (db.collectionGroup(id).orderBy('__name__').limit(n).startAfter(snap)
 * .get(); ref.update(field, value, { lastUpdateTime })). Until that is merged,
 * token mode refuses to start and says so.
 *
 * Usage:
 *   node scripts/retag-voicemail-activity.js                        # dry run, every company
 *   node scripts/retag-voicemail-activity.js --company <companyId>  # dry run, one company
 *   node scripts/retag-voicemail-activity.js --apply [--company <companyId>]   # write
 */
'use strict';

const LEAD_ACTIVITY = /^leads\/([^/]+)\/activity\/([^/]+)$/;
const NEW_SOURCE = 'voicemail';

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

/** True for a pre-change voicemail row: type 'voicemail' filed as source 'rep'. */
function needsRetag(data) {
  return !!data && data.type === 'voicemail' && data.source === 'rep';
}

/** Does leads/{leadId} belong to company? companyId, else (no companyId) userId. */
function leadInCompany(lead, company) {
  if (!lead) return false;
  if (lead.companyId) return lead.companyId === company;
  return lead.userId === company;
}

async function run({ db, args, log = console.log, pageSize = 500 }) {
  if (!db || typeof db.collectionGroup !== 'function') {
    throw Object.assign(new Error('this Firestore client has no collection-group query. Token mode needs scripts/_firestore-rest.js from branch q11-backfill; use Application Default Credentials (unset NBD_ACCESS_TOKEN). Nothing read or written.'), { ownMessage: true });
  }
  const counts = { scanned: 0, notLeadActivity: 0, notVoicemail: 0, alreadyTagged: 0, outOfScope: 0, toChange: 0, written: 0, failures: 0 };
  const leadCache = new Map();
  async function companyOwns(leadId) {
    if (!leadCache.has(leadId)) {
      const s = await db.doc('leads/' + leadId).get();
      leadCache.set(leadId, leadInCompany(s.exists ? s.data() : null, args.company));
    }
    return leadCache.get(leadId);
  }

  log('Q11 voicemail retag (' + args.project + ', ' + (args.company ? 'company ' + args.company : 'every company') + ', ' + (args.apply ? 'APPLY' : 'DRY RUN') + ')');
  let last = null;
  for (;;) {
    let q = db.collectionGroup('activity').orderBy('__name__').limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    if (snap.empty) break;
    for (const d of snap.docs) {
      counts.scanned++;
      const p = d.ref.path;
      const m = LEAD_ACTIVITY.exec(p);
      if (!m) { counts.notLeadActivity++; continue; }
      const data = d.data() || {};
      if (data.type !== 'voicemail') { counts.notVoicemail++; continue; }
      if (!needsRetag(data)) { counts.alreadyTagged++; continue; }
      if (args.company && !(await companyOwns(m[1]))) { counts.outOfScope++; continue; }
      counts.toChange++;
      if (!args.apply) continue;
      // No updateTime, no write: the Admin SDK reads { lastUpdateTime: undefined }
      // as no precondition at all, an upsert that could re-create a deleted row.
      if (!d.updateTime) { counts.failures++; continue; }
      try {
        await db.doc(p).update('source', NEW_SOURCE, { lastUpdateTime: d.updateTime });
        counts.written++;
      } catch (_) {
        counts.failures++; // the error text can quote the document; not printed
      }
    }
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < pageSize) break;
  }

  log('  activity rows scanned                 : ' + counts.scanned);
  log('  not under leads/{id}/activity (skip)  : ' + counts.notLeadActivity);
  log('  not type voicemail (skip)             : ' + counts.notVoicemail);
  log('  voicemail, already off source rep     : ' + counts.alreadyTagged);
  if (args.company) log('  other company (skip)                  : ' + counts.outOfScope);
  log('  voicemail rows to retag rep -> voicemail: ' + counts.toChange);
  if (!counts.toChange) log('nothing to change');
  else if (args.apply) log('  written: ' + counts.written + ', failures: ' + counts.failures);
  else log('DRY RUN: nothing written. Add --apply to write (production: only with Jo\'s OK).');
  return { counts };
}

/**
 * What a fatal error prints. A Firestore error's text can name a document
 * path (a lead id) or quote a row, so only this script's own messages print
 * verbatim; anything else prints its status code and nothing of its text.
 */
function describeFatal(e) {
  if (e && e.ownMessage) return e.message;
  const code = e && e.code;
  const status = e && typeof e.message === 'string' && (/\b(?:NOT_FOUND|PERMISSION_DENIED|UNAUTHENTICATED|FAILED_PRECONDITION|RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|ABORTED|INTERNAL|INVALID_ARGUMENT)\b/.exec(e.message) || [])[0];
  const parts = [];
  if (typeof code === 'number' || (typeof code === 'string' && /^[A-Za-z0-9_/-]{1,64}$/.test(code))) parts.push('code ' + code);
  if (status) parts.push(status);
  return 'failed' + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '; error text not printed (it can name a document).';
}

module.exports = { parseArgs, needsRetag, leadInCompany, run, describeFatal, NEW_SOURCE };

if (require.main === module) {
  (async () => {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    let r;
    if (process.env.NBD_ACCESS_TOKEN) {
      // Token mode: Firestore REST with a short-lived access token (scripts/_firestore-rest.js).
      const R = require('./_firestore-rest');
      const db = R.restFirestore({ projectId: args.project, token: process.env.NBD_ACCESS_TOKEN });
      r = await run({ db, args });
    } else {
      const { initAdmin, getFirestore } = require('./_admin');
      initAdmin({ projectId: args.project });
      r = await run({ db: getFirestore(), args });
    }
    process.exit(r.counts.failures ? 1 : 0);
  })().catch((e) => { console.error(describeFatal(e)); process.exit(1); });
}
