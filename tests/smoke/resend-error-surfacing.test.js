/**
 * tests/smoke/resend-error-surfacing.test.js
 *
 * The Resend SDK (v6.24.0) does NOT throw on an API-level rejection (bad/
 * expired key, suspended account, rejected sender domain, 429 rate limit,
 * 5xx) — it resolves normally to `{ data: null, error: {...} }`. Every
 * `resend.emails.send()` call site that only wraps the send in try/catch
 * and never inspects `.error` treats that rejection as a genuine delivery.
 * Found first in `sendEmail` (functions/email-functions.js) live-testing
 * invoicing 2026-09-08 — documentation/audit/STRIPE-INVOICING-STATUS-2026-09-08.md
 * — with ~18 more call sites at the same shape flagged as a follow-up.
 * This file is that follow-up's regression suite; the full file-by-file
 * disposition (fixed vs. deliberately left silent) is in
 * documentation/audit/RESEND-ERROR-SURFACING-SWEEP-2026-09-08.md.
 *
 * Section 1 is a REAL function call (not regex) against the shared
 * functions/resend-guard.js helper — it has zero external requires, so it
 * loads and runs with plain Node, no functions/node_modules needed.
 *
 * Section 2 is regex-over-source, matching this repo's dominant smoke
 * style for functions/*.js (no local node_modules to actually invoke the
 * firebase-functions-wrapped handlers). Each assertion anchors on the
 * SPECIFIC post-fix token sequence (the resendRejected(...) guard immediately
 * followed by the file's own downstream failure/success marker) — a regex
 * that only requires "resendRejected" to appear ANYWHERE would keep passing
 * against a fix that checked the wrong response variable or landed in the
 * wrong branch, so every assertion below stitches the guard to the specific
 * line it must gate. Proven red on the pre-fix source, green after
 * (documentation/audit/RESEND-ERROR-SURFACING-SWEEP-2026-09-08.md §Verification).
 */

'use strict';

const path = require('path');
const { FUNCTIONS, read } = require('./_shared');

let resendGuard;
let loadError;
try {
  resendGuard = require(path.join(FUNCTIONS, 'resend-guard.js'));
} catch (e) {
  loadError = e;
}

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

  section('resend-guard.js — real function calls (not regex)');
  {
    assert('resend-guard.js loads without throwing',
      !loadError, loadError ? loadError.message : '');
    if (loadError) return;

    const { resendRejected, resendErrorMessage } = resendGuard;
    assert('resendRejected is exported', typeof resendRejected === 'function');
    assert('resendErrorMessage is exported', typeof resendErrorMessage === 'function');
    if (typeof resendRejected !== 'function' || typeof resendErrorMessage !== 'function') return;

    // The exact shape Resend's SDK resolves to on an API-level rejection.
    const rejected = { data: null, error: { message: 'API key is invalid', name: 'validation_error' } };
    // The exact shape it resolves to on a genuine send.
    const ok = { data: { id: 're_abc123' }, error: null };

    assert('resendRejected(rejected) is true',  resendRejected(rejected) === true);
    assert('resendRejected(ok) is false',       resendRejected(ok) === false);
    assert('resendRejected(null) is false',     resendRejected(null) === false);
    assert('resendRejected(undefined) is false', resendRejected(undefined) === false);
    assert('resendRejected({}) is false',       resendRejected({}) === false);

    assert('resendErrorMessage extracts .error.message',
      resendErrorMessage(rejected) === 'API key is invalid');
    assert('resendErrorMessage handles a string error',
      resendErrorMessage({ error: 'suspended' }) === 'suspended');
    assert('resendErrorMessage falls back when error has no message',
      resendErrorMessage({ error: {} }) === 'Email provider rejected the request');
    assert('resendErrorMessage falls back to the given default on no error',
      resendErrorMessage(ok, 'n/a') === 'n/a');
  }

  section('resend.emails.send() call sites — fixed to check .error (not just throws)');
  {
    // ── functions/email-functions.js (sendEmail) — the reference fix ──
    const ef = read(path.join(FUNCTIONS, 'email-functions.js'));
    assert('sendEmail requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(ef));
    assert('sendEmail checks resendRejected(response) and marks the log + HTTP response failed',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,250}logEmailToFirestore\(db, to, subject, decoded\.uid, 'failed'[\s\S]{0,150}res\.status\(502\)\.json\(\{ error: 'Failed to send email', detail: msg \}\);/.test(ef));

    // ── functions/esign-envelope.js (sendEsignEnvelope) ──
    // 2026-10-04: every e-sign email (link, reminder, next signer, signed
    // copy) goes through ONE sender, esign-io.js sendMail.
    const ee = read(path.join(FUNCTIONS, 'esign-io.js'));
    assert('sendEsignEnvelope requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(ee));
    assert('sendEsignEnvelope throws on resendRejected(response) before setting emailed = true',
      /if \(resendRejected\(response\)\) throw new Error\(resendErrorMessage\(response\)\);\s*return \{ emailed: true/.test(ee));
    assert('esign-envelope.js sends no email except through esign-io.js',
      !/resend\.emails\.send/.test(read(path.join(FUNCTIONS, 'esign-envelope.js'))));

    // ── functions/lead-alert.js — TWO call sites ──
    const la = read(path.join(FUNCTIONS, 'lead-alert.js'));
    assert('lead-alert.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(la));
    assert('ackHomeowner throws on resendRejected(response) before stamping ackEmailSentAt',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}\s*logger\.info\('leadAck: email sent'/.test(la));
    assert('the tenant-alert email throws on resendRejected(resp) before outcomes.email = \'sent\' (feeds alert_outbox dashboard banner)',
      /if \(resendRejected\(resp\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(resp\)\);[\s\S]{0,20}\}\s*outcomes\.email = 'sent';/.test(la));

    // ── functions/storm-report-email.js ──
    const sr = read(path.join(FUNCTIONS, 'storm-report-email.js'));
    assert('stormReportEmail requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(sr));
    assert('stormReportEmail throws on resendRejected(resp) before recording reportEmailId as sent',
      /if \(resendRejected\(resp\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(resp\)\);[\s\S]{0,20}\}\s*const id = /.test(sr));

    // ── functions/handlers/invites.js (teamInviteEmail) ──
    const inv = read(path.join(FUNCTIONS, 'handlers/invites.js'));
    assert('teamInviteEmail requires resend-guard',
      /require\('\.\.\/resend-guard'\)/.test(inv));
    assert('teamInviteEmail throws on resendRejected(response) before emailStatus = \'sent\' (feeds the same alert_outbox banner)',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}\s*emailStatus = 'sent';/.test(inv));

    // ── functions/estimate-email.js ──
    const est = read(path.join(FUNCTIONS, 'estimate-email.js'));
    assert('estimate-email.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(est));
    assert('estimate-email throws on resendRejected(response) before estimateEmailStatus: \'sent\'',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,60}\}[\s\S]{0,60}estimateEmailStatus: 'sent'/.test(est));

    // ── functions/funnel-recovery.js ──
    const fr = read(path.join(FUNCTIONS, 'funnel-recovery.js'));
    assert('funnel-recovery.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(fr));
    // The gap after the closing `}` is wider than this file's other
    // assertions: the double-send hardening fix (funnel-recovery-hardening
    // task) wraps the stamp write in its own try/catch (so a bookkeeping
    // failure AFTER a real send can't be replayed as a re-send — see the
    // claim-before-send comment in the source) with an explanatory comment
    // ahead of it. Still a tight, single-purpose gap: the very next write
    // after the resendRejected guard, not "somewhere in the file".
    assert('funnel-recovery throws on resendRejected(response) before recoveryEmailSentAt is stamped (that stamp gates all future retries)',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,60}\}[\s\S]{0,320}recoveryEmailSentAt: FieldValue\.serverTimestamp\(\)/.test(fr));

    // ── functions/lead-followup.js ──
    const lf = read(path.join(FUNCTIONS, 'lead-followup.js'));
    assert('lead-followup.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(lf));
    // 2026-10-03: claim-before-send — the send is marked delivered (so a
    // later stamp failure is not mistaken for a send failure) between the
    // guard and the stamp; behaviour is pinned in
    // tests/background-job-reliability-2026-10-03.test.js.
    assert('leadFollowUp throws on resendRejected(response) before followUpEmailSentAt is stamped (one send ever per lead)',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,80}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}\s*delivered = true;\s*sent\+\+;\s*await doc\.ref\.update\(\{ followUpEmailSentAt:/.test(lf));

    // ── functions/report-sharing.js (createReportShareToken) ──
    const rs = read(path.join(FUNCTIONS, 'report-sharing.js'));
    assert('report-sharing.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(rs));
    assert('createReportShareToken throws on resendRejected(response) before emailed = true',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}\s*emailed = true;/.test(rs));

    // ── functions/remote-signing.js (createSignRequest) ──
    const remS = read(path.join(FUNCTIONS, 'remote-signing.js'));
    assert('remote-signing.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(remS));
    assert('createSignRequest throws on resendRejected(response) before emailed = true',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}\s*emailed = true;/.test(remS));

    // ── functions/verify-functions.js (notifyNewLead) ──
    const vf = read(path.join(FUNCTIONS, 'verify-functions.js'));
    assert('verify-functions.js requires resend-guard',
      /require\('\.\/resend-guard'\)/.test(vf));
    assert('notifyNewLead throws on resendRejected(response) before returning { success: true }',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,60}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}[\s\S]{0,120}return \{ success: true \};/.test(vf));

    // ── functions/integrations/email-queue-worker.js ──
    const eq = read(path.join(FUNCTIONS, 'integrations/email-queue-worker.js'));
    assert('email-queue-worker.js requires resend-guard',
      /require\('\.\.\/resend-guard'\)/.test(eq));
    assert('emailQueueWorker throws on resendRejected(response) before status: \'sent\' (preserves the MAX_ATTEMPTS retry state machine)',
      /if \(resendRejected\(response\)\) \{[\s\S]{0,80}throw new Error\(resendErrorMessage\(response\)\);[\s\S]{0,20}\}\s*await doc\.ref\.update\(\{\s*status: 'sent'/.test(eq));
  }

  section('resend.emails.send() call sites — deliberately left as-is (best-effort digests, self-healing next cycle)');
  {
    // These are all internal rep/ops digests where the *_SentAt field
    // written after the send is never read back to gate anything (verified
    // by grep — see the sweep note), so a silently-dropped send just means
    // the same recipients are picked up again next cycle. Pinning the
    // absence of a stamp-gate here is what would make one of these
    // "legitimately fine to leave" — if a future edit adds a read of e.g.
    // lastDormantNudgeSentAt as a skip-condition, that turns this into a
    // permanent-loss bug like funnel-recovery's and should be fixed +
    // moved to the section above.
    const dl = read(path.join(FUNCTIONS, 'dormant-leads.js'));
    assert('dormant-leads.js: lastDormantNudgeSentAt is written but never read (no retry-suppressing gate)',
      /lastDormantNudgeSentAt: FieldValue\.serverTimestamp\(\)/.test(dl)
      && (dl.match(/lastDormantNudgeSentAt/g) || []).length === 1);

    const wd = read(path.join(FUNCTIONS, 'weekly-digest.js'));
    assert('weekly-digest.js: lastDigestSentAt is written but never read (no retry-suppressing gate)',
      /lastDigestSentAt: FieldValue\.serverTimestamp\(\)/.test(wd)
      && (wd.match(/lastDigestSentAt/g) || []).length === 1);

    const at = read(path.join(FUNCTIONS, 'anniversary-touch.js'));
    assert('anniversary-touch.js: the bell (writeAnniversaryActivity + markAnniversaryTouched) fires unconditionally BEFORE the email attempt, independent of send outcome',
      /for \(const lead of anniversaries\) \{\s*await writeAnniversaryActivity\(db, lead\.id, uid\);\s*await markAnniversaryTouched\(db, lead\.id\);/.test(at)
      && at.indexOf('for (const lead of anniversaries)') < at.indexOf('resend.emails.send('));
  }
};
