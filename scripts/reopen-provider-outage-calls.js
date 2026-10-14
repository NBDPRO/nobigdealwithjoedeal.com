/**
 * scripts/reopen-provider-outage-calls.js
 *
 * Reopens phone_calls that were dropped for good because the AI PROVIDER was
 * out, not because the call was bad.
 *
 * Background (2026-10-13): 14 calls sat at status 'stored' with
 * transcribeAttempts = 3 and transcribeError "anthropic 400: Your credit
 * balance is too low to access the Anthropic API". Before the fix in this PR
 * a billing/auth error counted as a strike, and three strikes dropped a call
 * forever, even after the account was topped up.
 *
 * What it does, per matching doc: transcribeAttempts := 0, transcribeError
 * cleared. That is all - the next half-hourly callCenterTranscribe run picks
 * the call up again. (Since the fix, pickToTranscribe also lets these calls
 * through on its own while the stored error is an outage error, so this
 * script is the explicit, auditable version of the same reopening and also
 * clears the stale error text.)
 *
 * Matches: status === 'stored' AND transcribeError classified as a provider
 * outage by functions/call-center-logic.js classifyProviderError (credit,
 * auth, rate limit, overloaded). A call that failed for its own reasons
 * ("notes: no JSON", a timeout) is left alone.
 *
 * SAFETY
 *   - DRY-RUN by default. Writes only with --apply.
 *   - Refuses to run without --project <id> (no default project).
 *   - Prints COUNTS only: no call ids, names, numbers, transcripts.
 *   - Never touches status, transcript, storagePath or anything else.
 *   - Idempotent: a second run matches nothing.
 *
 * RUN (Jo must approve running it against prod):
 *   node scripts/reopen-provider-outage-calls.js --project nobigdeal-pro
 *   node scripts/reopen-provider-outage-calls.js --project nobigdeal-pro --apply
 */
'use strict';

const L = require('../functions/call-center-logic');

const COLLECTION = 'phone_calls';
const BATCH = 400;

/** Pure: which docs the script would reopen. rows = [{ id, data }]. */
function planReopen(rows) {
  const out = { scanned: 0, matched: [], byKind: {}, skipped: 0 };
  for (const r of rows || []) {
    out.scanned++;
    const d = (r && r.data) || {};
    if (d.status !== 'stored') { out.skipped++; continue; }
    const c = L.classifyProviderError(d.transcribeError);
    if (!c) { out.skipped++; continue; }
    out.matched.push(r.id);
    const k = c.provider + ':' + c.kind;
    out.byKind[k] = (out.byKind[k] || 0) + 1;
  }
  return out;
}

/** db: a Firestore-like handle. Returns the counts it printed. */
async function run({ db, apply, log }) {
  const say = log || console.log;
  const rows = [];
  const snap = await db.collection(COLLECTION).where('status', '==', 'stored').get();
  snap.forEach((d) => rows.push({ id: d.id, data: d.data() }));
  const plan = planReopen(rows);
  say('stored calls scanned : ' + plan.scanned);
  say('would reopen         : ' + plan.matched.length);
  Object.keys(plan.byKind).sort().forEach((k) => say('  ' + k + ' : ' + plan.byKind[k]));
  say('left alone (own fault / not stored): ' + plan.skipped);
  let written = 0;
  if (apply) {
    for (let i = 0; i < plan.matched.length; i += BATCH) {
      const batch = db.batch();
      plan.matched.slice(i, i + BATCH).forEach((id) => {
        batch.update(db.collection(COLLECTION).doc(id), { transcribeAttempts: 0, transcribeError: null });
      });
      await batch.commit();
      written += Math.min(BATCH, plan.matched.length - i);
    }
    say('reopened             : ' + written);
  } else {
    say('DRY-RUN: nothing written. Re-run with --apply to reopen.');
  }
  return { scanned: plan.scanned, matched: plan.matched.length, written, byKind: plan.byKind };
}

function parseArgs(argv) {
  const a = { apply: false, project: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--project') a.project = argv[++i] || null;
    else if (/^--project=/.test(argv[i])) a.project = argv[i].slice('--project='.length) || null;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project) {
    console.error('Refusing to run without --project <firebase-project-id>.');
    process.exit(2);
  }
  const { initAdmin, getFirestore } = require('./_admin');
  initAdmin({ projectId: args.project });
  console.log('project : ' + args.project);
  console.log('mode    : ' + (args.apply ? 'APPLY (writing)' : 'DRY-RUN (no changes)'));
  await run({ db: getFirestore(), apply: args.apply });
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
}

module.exports = { planReopen, run, parseArgs };
