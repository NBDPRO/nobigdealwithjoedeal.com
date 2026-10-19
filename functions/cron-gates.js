'use strict';

/**
 * functions/cron-gates.js — the canonical list of feature-gate env vars
 * that scheduled functions check before doing real work. health-digest.js's
 * gate-status table and tests/cron-gate-drift.test.js both read this ONE
 * list, rather than each keeping its own hand-copied copy that can drift
 * out of sync with what a function actually checks (add a gate to a new
 * cron and forget to register it here, or rename one and leave a stale
 * entry behind — either way this is the single place that would catch it).
 *
 * Two polarities exist:
 *   - 'enabled'  — the gate defaults OFF; the cron only runs when the env
 *                  var is the literal string 'true'.
 *   - 'disabled' — the gate defaults ON; the cron skips only when the env
 *                  var is the literal string 'true'.
 *   - 'default-on' — the gate defaults ON; the function skips / goes dry-run
 *                  only when the env var is the literal string 'false'
 *                  (estimate-email.js, lead-followup.js).
 */
const CRON_GATES = [
  { name: 'ANNIVERSARY_TOUCH_ENABLED', polarity: 'enabled', file: 'anniversary-touch.js' },
  { name: 'DORMANT_NUDGE_ENABLED', polarity: 'enabled', file: 'dormant-leads.js' },
  { name: 'ESTIMATE_EMAIL_ENABLED', polarity: 'default-on', file: 'estimate-email.js' },
  { name: 'FUNNEL_RECOVERY_ENABLED', polarity: 'enabled', file: 'funnel-recovery.js' },
  { name: 'HEALTH_DIGEST_ENABLED', polarity: 'enabled', file: 'health-digest.js' },
  { name: 'LEAD_ACK_SMS_ENABLED', polarity: 'enabled', file: 'lead-alert.js' },
  { name: 'LEAD_FOLLOWUP_ENABLED', polarity: 'default-on', file: 'lead-followup.js' },
  { name: 'MORNING_BRIEF_ENABLED', polarity: 'enabled', file: 'morning-brief.js' },
  // One morning email (2026-10-04): the 6:45 brief absorbs the 07:00 lead
  // digest, the 07:15 "said you'd do" sweep and the owner's 08:15 review asks.
  { name: 'MORNING_BRIEF_ABSORB_ENABLED', polarity: 'enabled', file: 'morning-brief-absorb.js' },
  // Brief delta mode (2026-10-18, notification policy step 1): new-since-yesterday only. Off = today's full brief.
  { name: 'MORNING_BRIEF_DELTA_ENABLED', polarity: 'enabled', file: 'morning-brief.js' },
  // Nightly promise cleanup (2026-10-04): Haiku marks a call promise kept only
  // on explicit later evidence; every change logged to promise_cleanup_log.
  { name: 'PROMISE_CLEANUP_ENABLED', polarity: 'enabled', file: 'promise-cleanup.js' },
  // Call Center ingest: dry-run (list + count) until Jo says go.
  { name: 'CALL_CENTER_INGEST_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Call Center transcripts + AI notes: OFF until Jo OKs a one-call test.
  { name: 'CALL_CENTER_TRANSCRIBE_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Call Center "you said you'd" reminder email: dry-run until Jo says go.
  { name: 'CALL_CENTER_SWEEP_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Every-2-hours call check (8 AM-8 PM ET): new calls needing Jo + slow updates (bell + push).
  { name: 'CALL_WATCH_ENABLED', polarity: 'enabled', file: 'call-watch.js' },
  // Daily own-document expiry watch (2026-10-18): Agent-inbox reports to the owner at 30/14/7 days and on expiry. Dark until Jo says go.
  { name: 'COMPANY_DOC_EXPIRY_ENABLED', polarity: 'enabled', file: 'company-doc-expiry.js' },
  // Away mode: the 15-min tick that tells the backup person (dry-run until Jo
  // says go). Ending an expired window is NOT behind this gate.
  { name: 'AWAY_MODE_ENABLED', polarity: 'enabled', file: 'away-mode.js' },
  // Thursday per-label caller playbooks (2026-10-12): the caller lookup adds the
  // playbook / label kind / handled / away wording. Not a cron. DARK until Jo says go.
  { name: 'THURSDAY_LABEL_PLAYBOOKS_ENABLED', polarity: 'enabled', file: 'integrations/thursday.js' },
  // Missed-lead-alert re-send (every 10 min, email + push to Jo): ON unless killed.
  { name: 'LEAD_ALERT_WATCHDOG_DISABLED', polarity: 'disabled', file: 'lead-alert-watchdog.js' },
  // Text Inbox ingest (SMS Backup & Restore → phone_texts): dry-run until Jo says go.
  { name: 'TEXT_INBOX_ENABLED', polarity: 'enabled', file: 'text-inbox.js' },
  // Text notes (AI per conversation-day): dry-run until texts flow and Jo says go.
  { name: 'TEXT_NOTES_ENABLED', polarity: 'enabled', file: 'text-inbox.js' },
  { name: 'REVIEW_NUDGE_ENABLED', polarity: 'enabled', file: 'review-request-nudge.js' },
  { name: 'STORM_TEXT_ENABLED', polarity: 'enabled', file: 'storm-watch.js' },
  { name: 'STORM_NWS_TEXT_ENABLED', polarity: 'enabled', file: 'sms-functions.js' },
  { name: 'STORM_CONFIRM_TEXT_ENABLED', polarity: 'enabled', file: 'storm-poller.js' },
  // Social Studio publisher kill switch (per-company on/off lives in
  // companies/{id}/social_settings/config, default OFF).
  { name: 'SOCIAL_PUBLISHER_DISABLED', polarity: 'disabled', file: 'social-studio.js' },
  // Social Studio's Google Business posting stub: OFF until API access lands.
  { name: 'SOCIAL_GBP_ENABLED', polarity: 'enabled', file: 'social-studio.js' },
  { name: 'VISUALIZER_IMAGEGEN_ENABLED', polarity: 'enabled', file: 'visualizer-image-gen.js' },
  { name: 'WEEKLY_DIGEST_ENABLED', polarity: 'enabled', file: 'weekly-digest.js' },
  // Not a cron: a lead trigger that writes jobs/j1 + activeJobId onto live
  // leads (multi-job phase 1). OFF until Jo says go (2026-09-30).
  { name: 'JOBS_MIRROR_ENABLED', polarity: 'enabled', file: 'jobs-mirror.js' },
  { name: 'MONTHLY_OVERHEAD_ALERT_DISABLED', polarity: 'disabled', file: 'monthly-overhead-alert.js' },
  { name: 'STRIPE_LEDGER_DISABLED', polarity: 'disabled', file: 'stripe-ledger.js' },
  { name: 'GOOGLE_CALENDAR_SYNC_DISABLED', polarity: 'disabled', file: 'google-calendar.js' },
  // Not a cron: the Grok Bot team's CRM connection (crmMcp). ON unless set.
  { name: 'AGENT_MCP_DISABLED', polarity: 'disabled', file: 'agent-mcp.js' },
  // E-sign reminders + link expiry (2026-10-04, replaced BoldSign's). ON unless set.
  { name: 'ESIGN_REMINDERS_DISABLED', polarity: 'disabled', file: 'esign-reminders.js' },
  // Not a cron: NBD's Twilio line webhooks (/api/twilio/*, 2026-10-06). DARK
  // until A2P is approved and Jo flips it (fixed TwiML, nothing written).
  { name: 'TWILIO_INBOUND_ENABLED', polarity: 'enabled', file: 'twilio-line.js' },
  // Speed-to-lead (2026-10-15): the Call Center ingest auto-texts a missed
  // caller with stored web-form consent (missed-call-autotext.js). DARK until
  // the A2P campaign is approved; the one-tap reply DRAFT is not behind it.
  { name: 'MISSED_CALL_AUTOTEXT_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Automatic homeowner review ask (2026-10-15, reviewAskAutoSweep 10:00 ET):
  // the email is live on nobigdeal-pro; the text is DARK until A2P approval.
  { name: 'REVIEW_ASK_AUTO_EMAIL_ENABLED', polarity: 'enabled', file: 'review-ask-auto.js' },
  { name: 'REVIEW_ASK_AUTO_TEXT_ENABLED', polarity: 'enabled', file: 'review-ask-auto.js' },
];

/**
 * Reads `env` (normally process.env) and returns each gate's live on/off
 * state, respecting its polarity.
 */
function gateStatus(env) {
  return CRON_GATES.map((g) => {
    const raw = env[g.name];
    const on = g.polarity === 'enabled' ? raw === 'true'
      : g.polarity === 'default-on' ? raw !== 'false'
      : raw !== 'true';
    return { name: g.name, file: g.file, polarity: g.polarity, raw: raw || '(unset)', on };
  });
}

module.exports = { CRON_GATES, gateStatus };
