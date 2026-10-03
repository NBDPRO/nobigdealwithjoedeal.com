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
 */
const CRON_GATES = [
  { name: 'ANNIVERSARY_TOUCH_ENABLED', polarity: 'enabled', file: 'anniversary-touch.js' },
  { name: 'DORMANT_NUDGE_ENABLED', polarity: 'enabled', file: 'dormant-leads.js' },
  { name: 'ESTIMATE_EMAIL_ENABLED', polarity: 'enabled', file: 'estimate-email.js' },
  { name: 'FUNNEL_RECOVERY_ENABLED', polarity: 'enabled', file: 'funnel-recovery.js' },
  { name: 'HEALTH_DIGEST_ENABLED', polarity: 'enabled', file: 'health-digest.js' },
  { name: 'LEAD_ACK_SMS_ENABLED', polarity: 'enabled', file: 'lead-alert.js' },
  { name: 'LEAD_FOLLOWUP_ENABLED', polarity: 'enabled', file: 'lead-followup.js' },
  { name: 'MORNING_BRIEF_ENABLED', polarity: 'enabled', file: 'morning-brief.js' },
  // Call Center ingest: dry-run (list + count) until Jo says go.
  { name: 'CALL_CENTER_INGEST_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Call Center transcripts + AI notes: OFF until Jo OKs a one-call test.
  { name: 'CALL_CENTER_TRANSCRIBE_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Call Center "you said you'd" reminder email: dry-run until Jo says go.
  { name: 'CALL_CENTER_SWEEP_ENABLED', polarity: 'enabled', file: 'call-center.js' },
  // Every-2-hours call check (8 AM-8 PM ET): new calls needing Jo + slow updates (bell + push).
  { name: 'CALL_WATCH_ENABLED', polarity: 'enabled', file: 'call-watch.js' },
  // Text Inbox ingest (SMS Backup & Restore → phone_texts): dry-run until Jo says go.
  { name: 'TEXT_INBOX_ENABLED', polarity: 'enabled', file: 'text-inbox.js' },
  // Text notes (AI per conversation-day): dry-run until texts flow and Jo says go.
  { name: 'TEXT_NOTES_ENABLED', polarity: 'enabled', file: 'text-inbox.js' },
  { name: 'REVIEW_NUDGE_ENABLED', polarity: 'enabled', file: 'review-request-nudge.js' },
  { name: 'STORM_TEXT_ENABLED', polarity: 'enabled', file: 'storm-watch.js' },
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
];

/**
 * Reads `env` (normally process.env) and returns each gate's live on/off
 * state, respecting its polarity.
 */
function gateStatus(env) {
  return CRON_GATES.map((g) => {
    const raw = env[g.name];
    const on = g.polarity === 'enabled' ? raw === 'true' : raw !== 'true';
    return { name: g.name, file: g.file, polarity: g.polarity, raw: raw || '(unset)', on };
  });
}

module.exports = { CRON_GATES, gateStatus };
