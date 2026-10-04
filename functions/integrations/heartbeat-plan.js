/**
 * integrations/heartbeat-plan.js — which Healthchecks.io check each cron pings.
 *
 * WHY (2026-10-04)
 * ────────────────
 * 35 scheduled functions, and Healthchecks' free tier holds 20 checks. With
 * one slug per cron (the wrapper's old default), 15 crons pinged slugs that
 * could never have a check behind them — invisible by construction, and
 * nothing said which. This file is the explicit plan: every cron is listed,
 * high-stakes crons keep a dedicated check (slug = kebab-case export name, the
 * same slug they always sent, so checks Jo already created keep working), and
 * low-stakes crons on a similar cadence SHARE one check.
 *
 * What a shared check does and does not catch: any member's throw pings
 * `<slug>/fail` and turns the check red (so failures are never hidden); but a
 * member that silently STOPS while a sibling keeps pinging is not caught.
 * That is the deliberate trade for staying inside 20 — only crons where a
 * silent stop is low-stakes (cleanup, nudges, syncs with their own visible
 * output) are grouped.
 *
 * `exempt: '<YYYY-MM-DD> reason'` opts a cron out of pinging entirely (none
 * today). tests/cron-heartbeat.test.js fails CI when a cron is missing here,
 * an entry names no cron, a slug lacks period/grace, or the plan needs more
 * than MAX_CHECKS checks. Jo's checks to create:
 * documentation/runbooks/HEALTHCHECKS-SETUP.md (the table there is pinned to
 * this file by the same test).
 *
 * period / grace are what to type into the check (Simple schedule), or a cron
 * expression + timezone where the cadence is not a fixed interval.
 */
'use strict';

const MAX_CHECKS = 20; // Healthchecks.io free "Hobbyist" tier

/** Shared / dedicated checks: slug → schedule to configure. */
const CHECKS = {
  // ── dedicated: a silent stop here costs money, data, or a missed customer
  'email-queue-worker':      { period: '1 minute',  grace: '10 minutes', why: 'every outbound email rides this queue' },
  'on-appointment-reminder': { period: '15 minutes', grace: '30 minutes', why: 'appointment reminders' },
  'daily-firestore-backup':  { period: '1 day',     grace: '6 hours',    why: 'the nightly backup' },
  'backup-freshness-cron':   { period: '1 day',     grace: '3 hours',    why: 'the alarm on the backup' },
  'migrations-tick':         { period: '1 day',     grace: '12 hours',   why: 'went silent 2026-08-31 with nothing watching' },
  'stripe-ledger-reconcile': { period: '1 day',     grace: '6 hours',    why: 'money ledger' },
  'enforce-lapsed-seats':    { period: '1 day',     grace: '6 hours',    why: 'billing / seat access' },
  'health-digest-cron':      { period: '1 day',     grace: '6 hours',    why: 'daily health digest' },
  'lead-follow-up-sweep':    { period: '3 hours',   grace: '4 hours',    why: 'follow-up to untouched new leads' },
  // ── shared: same cadence, failures still surface via /fail
  'storm-crons':             { period: '30 minutes', grace: '1 hour',    why: 'storm alert texts + NWS storm watch' },
  'calls-texts-ingest':      { period: '30 minutes', grace: '1 hour',    why: 'call recordings, transcripts, texts in' },
  'hourly-crons':            { period: '1 hour',    grace: '2 hours',    why: 'abandoned-estimate recovery + text notes' },
  'call-followups':          { period: '12 hours',  grace: '1 hour',     why: 'call watch (2h, 08-20 ET) + promise sweep (07:15/15:15 ET)' },
  'daily-retention':         { period: '1 day',     grace: '6 hours',    why: 'cleanup / retention jobs' },
  'daily-customer-touches':  { period: '1 day',     grace: '6 hours',    why: 'morning digests + nudges to Jo (not homeowners)' },
  'daily-syncs':             { period: '1 day',     grace: '6 hours',    why: 'GBP reviews, Google Calendar reconcile, hail match' },
  'weekly-crons':            { period: '1 week',    grace: '12 hours',   why: 'weekly digest (Mon) + dormant-lead nudge (Wed)' },
  'monthly-crons':           { period: 'cron 0 7 1 * * (America/New_York)', grace: '12 hours', why: 'marketing report + overhead alert, 1st of month' },
};

/** Every scheduled export → { slug } | { exempt: 'YYYY-MM-DD reason' }. */
const PLAN = {
  emailQueueWorker:          { slug: 'email-queue-worker' },
  onAppointmentReminder:     { slug: 'on-appointment-reminder' },
  dailyFirestoreBackup:      { slug: 'daily-firestore-backup' },
  backupFreshnessCron:       { slug: 'backup-freshness-cron' },
  migrationsTick:            { slug: 'migrations-tick' },
  stripeLedgerReconcile:     { slug: 'stripe-ledger-reconcile' },
  enforceLapsedSeats:        { slug: 'enforce-lapsed-seats' },
  healthDigestCron:          { slug: 'health-digest-cron' },
  leadFollowUpSweep:         { slug: 'lead-follow-up-sweep' },

  checkStormAlerts:          { slug: 'storm-crons' },
  stormWatch:                { slug: 'storm-crons' },

  callCenterIngest:          { slug: 'calls-texts-ingest' },
  callCenterTranscribe:      { slug: 'calls-texts-ingest' },
  textInboxIngest:           { slug: 'calls-texts-ingest' },

  runAbandonRecovery:        { slug: 'hourly-crons' },
  textInboxNotes:            { slug: 'hourly-crons' },

  callWatch:                 { slug: 'call-followups' },
  callCenterSweep:           { slug: 'call-followups' },

  firestoreBackupRetention:  { slug: 'daily-retention' },
  auditLogRetentionCron:     { slug: 'daily-retention' },
  recordingRetentionCron:    { slug: 'daily-retention' },
  pdfRenderRetention:        { slug: 'daily-retention' },

  dailyLeadDigest:           { slug: 'daily-customer-touches' },
  morningBrief:              { slug: 'daily-customer-touches' },
  onFollowUpDue:             { slug: 'daily-customer-touches' },
  onYardSignPickupDue:       { slug: 'daily-customer-touches' },
  anniversaryAutoTouch:      { slug: 'daily-customer-touches' },
  reviewRequestNudge:        { slug: 'daily-customer-touches' },

  syncGbpReviews:            { slug: 'daily-syncs' },
  googleCalendarReconcile:   { slug: 'daily-syncs' },
  hailMatchCron:             { slug: 'daily-syncs' },

  weeklyDigest:              { slug: 'weekly-crons' },
  dormantLeadNudge:          { slug: 'weekly-crons' },

  monthlyMarketingReport:    { slug: 'monthly-crons' },
  monthlyOverheadAlertCron:  { slug: 'monthly-crons' },
};

/**
 * The slug a cron pings, or null when exempt. Unknown names return undefined
 * so the wrapper can fall back to the kebab-case default (a cron added without
 * a plan entry still pings — and CI fails until the plan says where).
 */
function planFor(name) {
  if (!name || !Object.prototype.hasOwnProperty.call(PLAN, name)) return undefined;
  const e = PLAN[name];
  return e.exempt ? null : e.slug;
}

module.exports = { PLAN, CHECKS, MAX_CHECKS, planFor };
