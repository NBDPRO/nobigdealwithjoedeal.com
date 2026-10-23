'use strict';

/**
 * functions/flags-registry.js — the ONE registry of every feature flag the
 * functions read from their runtime env, with a plain-English meaning and the
 * owner decision doc. Zero deps (tests/flags-registry-drift.test.js requires it
 * without functions/node_modules).
 *
 * Feeds the owner/admin-only `flagStatus` callable (handlers/integrations.js)
 * and the CRM panel at Settings -> Access -> "Live feature flags"
 * (docs/pro/js/prod-flags-panel.js). READ-ONLY: nothing here writes an env var.
 *
 * Kinds (how the code reads the value — mirrored from the code, not guessed):
 *   enabled     runs only when the value is the literal 'true'; unset = OFF
 *   default-on  runs unless the value is the literal 'false' ('false' = PAUSED)
 *   disabled    kill switch: runs unless the value is the literal 'true'
 *               ('true' = PAUSED); the polarity comes from cron-gates.js
 *   off-switch  runs unless the value is the literal 'off' ('off' = PAUSED)
 *   required    a hard requirement: 'true' (any case) = REQUIRED, else OFF
 *   one-on      ON only when the value is the literal '1' (QA-only switches)
 *   mode        a three-way switch: off | test | live (anything else = off)
 *
 * The 32 scheduled/trigger gates are NOT re-listed with their polarity here:
 * their kind is read from cron-gates.js (CRON_GATES), so the polarity has one
 * source. This file adds the meaning, group, doc and "dark" hint for each.
 *
 * `dark: true` = shipped dark and waiting for Jo's go-ahead; the panel shows
 * "dark - needs Jo's go" while the flag is OFF.
 *
 * SECRETS: this registry never holds a secret and the callable never returns
 * one. isSafeName() denies any name containing KEY/SECRET/TOKEN/PASSWORD, and
 * safeValue() only passes short plain tokens through.
 */

const { CRON_GATES } = require('./cron-gates');

const GROUPS = [
  'Calls & texts',
  'Alerts & away',
  'Customer follow-ups',
  'Money',
  'Public forms',
  'Experiments',
];

const ENV_DOC = 'functions/.env.nobigdeal-pro';

// name -> { group, meaning, doc, dark?, kind? (non-gate flags only), file? }
const ROWS = {
  // ── Calls & texts ───────────────────────────────────────────────────────
  CALL_CENTER_INGEST_ENABLED: { group: 'Calls & texts', doc: 'documentation/architecture/CALL-CENTER-2026-10-01.md',
    meaning: 'Copies your Cube call recordings from Drive into the CRM every 30 minutes. Off = it only counts them.' },
  CALL_CENTER_TRANSCRIBE_ENABLED: { group: 'Calls & texts', doc: 'documentation/architecture/CALL-CENTER-2026-10-01.md',
    meaning: 'Turns recent customer calls into a transcript, summary and follow-up task. Off = recordings only.' },
  CALL_CENTER_SWEEP_ENABLED: { group: 'Calls & texts', doc: 'documentation/architecture/CALL-CENTER-2026-10-01.md',
    meaning: 'Emails you the "you said you would" list of open call promises, morning and afternoon.' },
  CALL_WATCH_ENABLED: { group: 'Calls & texts', doc: 'documentation/architecture/CALL-CENTER-2026-10-01.md',
    meaning: 'Every 2 hours, 8 AM to 8 PM: a bell and push to you when a new call needs you or an update is slow.' },
  TEXT_INBOX_ENABLED: { group: 'Calls & texts', dark: true, doc: 'documentation/architecture/CALL-CENTER-2026-10-01.md',
    meaning: 'Takes in texts exported from your phone (SMS Backup and Restore) into the CRM. Off = dry run, nothing stored.' },
  TEXT_NOTES_ENABLED: { group: 'Calls & texts', dark: true, doc: 'documentation/architecture/CALL-CENTER-2026-10-01.md',
    meaning: 'Writes an AI note per customer text conversation each day. Off = dry run, no notes.' },
  TWILIO_INBOUND_ENABLED: { group: 'Calls & texts', dark: true, doc: 'documentation/runbooks/TWILIO-LINE-GO-LIVE.md',
    meaning: 'Lets the Twilio line read inbound texts and forward inbound calls. Off = fixed message, nothing read or written. Waits on A2P approval.' },
  THURSDAY_LABEL_PLAYBOOKS_ENABLED: { group: 'Calls & texts', dark: true, doc: 'documentation/projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md',
    meaning: 'Thursday (the AI receptionist) gets per-label caller playbooks and away wording on a caller lookup.' },
  MISSED_CALL_AUTOTEXT_ENABLED: { group: 'Calls & texts', dark: true, doc: 'documentation/runbooks/TWILIO-LINE-GO-LIVE.md',
    meaning: 'Auto-texts a missed caller who gave texting consent on a web form (8am-9pm, once a day). Off = Jo gets the one-tap reply draft only. Waits on A2P.' },
  LEAD_ACK_SMS_ENABLED: { group: 'Calls & texts', doc: ENV_DOC,
    meaning: 'Texts the homeowner a quick acknowledgement when a new lead arrives. Off = no acknowledgement text.' },
  STORM_TEXT_ENABLED: { group: 'Calls & texts', doc: 'documentation/projects/AI-AUTOMATIONS-2026-10-04.md',
    meaning: 'Storm-watch texts to Storm Alert subscribers after hail. Also needs messaging_controls/automations stormText and a confirmed (replied YES) subscriber. Off = the watch runs but sends nothing.' },
  STORM_NWS_TEXT_ENABLED: { group: 'Calls & texts', doc: 'documentation/audit/MESSAGING-HARDENING-2026-10-19.md',
    meaning: 'NWS weather-alert texts to confirmed Storm Alert subscribers. Also needs messaging_controls/automations stormNwsText and integrations/stormAlerts.enabled=true. Off = the NWS half does not even fetch.' },
  STORM_CONFIRM_TEXT_ENABLED: { group: 'Calls & texts', doc: 'documentation/audit/MESSAGING-HARDENING-2026-10-19.md',
    meaning: 'Sends the one "reply YES to confirm" text to a new Storm Alert subscriber (double opt-in). Also needs messaging_controls/automations stormConfirmText. Off = nobody can become confirmed.' },

  // ── Alerts & away ───────────────────────────────────────────────────────
  AWAY_MODE_ENABLED: { group: 'Alerts & away', dark: true, doc: 'documentation/projects/AWAY-MODE-BACKUP-2026-10-12.md',
    meaning: 'The 15-minute tick that actually tells your backup person while you are away. Off = dry run, nobody is notified.' },
  LEAD_ALERT_WATCHDOG_DISABLED: { group: 'Alerts & away', doc: ENV_DOC,
    meaning: 'Re-sends the new-lead alert (email + push) every 10 minutes when nobody has opened it. PAUSED = no re-sends.' },
  HEALTH_DIGEST_ENABLED: { group: 'Alerts & away', doc: 'documentation/runbooks/SPEND_KILLSWITCH.md',
    meaning: 'The daily ops health email to jd@. Off = the cron skips itself.' },
  MORNING_BRIEF_ENABLED: { group: 'Alerts & away', doc: ENV_DOC,
    meaning: 'The 6:45 AM appointment email to you. Off = no brief.' },
  MORNING_BRIEF_ABSORB_ENABLED: { group: 'Alerts & away', doc: 'documentation/projects/AI-AUTOMATIONS-2026-10-04.md',
    meaning: 'Folds the lead digest, call promises and review asks into the 6:45 brief. Off = three separate emails.' },
  MORNING_BRIEF_DELTA_ENABLED: { group: 'Alerts & away', dark: true, doc: 'documentation/projects/MORNING-BRIEF-DELTA-2026-10-18.md',
    meaning: 'The 6:45 brief shows only what is new since yesterday and collapses the standing lists (signed jobs needing a week, open promises, review asks) to a count plus a link. Off = the brief repeats the full lists, as today.' },
  COMPANY_DOC_EXPIRY_ENABLED: { group: 'Alerts & away', dark: true, doc: 'documentation/projects/COMPANY-DOC-EXPIRY-2026-10-18.md',
    meaning: 'Daily 9 AM: a note in your Agent inbox when your own insurance certificate, license or certification is 30, 14 or 7 days from expiring, or has expired. Never goes to a customer. Off = dry run, logs only.' },
  SUB_PAPERWORK_WATCH_ENABLED: { group: 'Alerts & away', dark: true, doc: 'documentation/projects/SUB-PAPERWORK-2026-10-19.md',
    meaning: 'Daily 9:15 AM: a note in your Agent inbox when a sub insurance certificate or license is 30, 14 or 7 days from ending, or has ended. Never goes to a sub or customer. Off = dry run, logs only.' },
  OWNER_WEEKLY_DIGEST_ENABLED: { group: 'Alerts & away', dark: true, doc: 'documentation/projects/WAVE3-ADDONS-RECON-2026-10-22.md',
    meaning: 'Monday 7:30 AM: one note in your Agent inbox with last week collected money, estimates awaiting signature (projected), calls to return and the jobs this week. Never goes to a customer or a rep. Off = dry run, logs only.' },
  WEEKLY_DIGEST_ENABLED: { group: 'Alerts & away', doc: 'documentation/runbooks/SPEND_KILLSWITCH.md',
    meaning: 'The weekly roll-up email. Off = dry run, not sent.' },
  MONTHLY_OVERHEAD_ALERT_DISABLED: { group: 'Alerts & away', doc: 'documentation/projects/WEEKLY_CADENCE.md',
    meaning: 'Monthly reminder that overhead is due to be reviewed. PAUSED = no reminder.' },
  PROMISE_CLEANUP_ENABLED: { group: 'Alerts & away', doc: 'documentation/projects/AI-AUTOMATIONS-2026-10-04.md',
    meaning: 'Nightly: marks a call promise kept only on explicit later evidence. Off = dry run, logs only.' },

  // ── Customer follow-ups ─────────────────────────────────────────────────
  ESTIMATE_EMAIL_ENABLED: { group: 'Customer follow-ups', doc: ENV_DOC,
    meaning: 'Estimate follow-up emails to homeowners. Live unless set to false (false = dry run, logs only).' },
  LEAD_FOLLOWUP_ENABLED: { group: 'Customer follow-ups', doc: ENV_DOC,
    meaning: 'Automatic follow-up to new leads that went quiet. Live unless set to false (false = skipped).' },
  DORMANT_NUDGE_ENABLED: { group: 'Customer follow-ups', doc: 'documentation/runbooks/SPEND_KILLSWITCH.md',
    meaning: 'Nudges dormant leads to wake them up. Off = dry run, logs only.' },
  ANNIVERSARY_TOUCH_ENABLED: { group: 'Customer follow-ups', doc: 'documentation/runbooks/SPEND_KILLSWITCH.md',
    meaning: 'Job-anniversary note to past customers. Off = dry run, logs only.' },
  REVIEW_ASK_AUTO_EMAIL_ENABLED: { group: 'Customer follow-ups', doc: ENV_DOC,
    meaning: 'Emails each paid-in-full customer one Google review ask from jd@, 3-21 days after the money came in. Off = the rep nudge only.' },
  REVIEW_ASK_EMAIL_PHOTO_ENABLED: { group: 'Customer follow-ups', kind: 'enabled', file: 'review-ask-photo.js', doc: ENV_DOC,
    meaning: 'Puts the customer\'s own before/after photo (from their job in the CRM) in the review ask email. Off = the email without a photo.' },
  REVIEW_ASK_AUTO_TEXT_ENABLED: { group: 'Customer follow-ups', dark: true, doc: 'documentation/runbooks/TWILIO-LINE-GO-LIVE.md',
    meaning: 'Texts the review ask to a customer with no email who gave texting consent on a web form (8am-9pm). Waits on A2P.' },
  REVIEW_NUDGE_ENABLED: { group: 'Customer follow-ups', doc: ENV_DOC,
    meaning: 'Emails your reps the list of won jobs not yet asked for a review. Off = the bell row only.' },
  ESIGN_REMINDERS_DISABLED: { group: 'Customer follow-ups', doc: ENV_DOC,
    meaning: 'E-sign reminders and link expiry for unsigned documents. PAUSED = no reminders, links never expire.' },

  // ── Money ───────────────────────────────────────────────────────────────
  STRIPE_LEDGER_DISABLED: { group: 'Money', doc: 'documentation/projects/STRIPE-FULL-INTEGRATION-2026-09-29.md',
    meaning: 'Books Stripe payments onto CRM invoices. PAUSED = payments are not booked automatically.' },
  CARE_PLAN_MODE: { group: 'Money', kind: 'mode', dark: true, file: 'care-plan-logic.js', doc: 'documentation/projects/ROOF-CARE-PLAN-2026-10-05.md',
    meaning: 'Roof Care Plan sales. off = nothing sells; test = only your invite links and ?preview=careplan; live = sells to everyone.' },
  NBD_MONEY_PAPER: { group: 'Money', kind: 'off-switch', file: 'money-paper.js', doc: ENV_DOC,
    meaning: 'Paper trail on invoice changes (money spine). "off" = the kill switch is on and it stops writing.' },
  NBD_INVOICE_OVERDUE: { group: 'Money', kind: 'off-switch', file: 'invoice-overdue.js', doc: ENV_DOC,
    meaning: 'Daily overdue-invoice sweep. "off" = the sweep is skipped.' },
  NBD_CRM_STRIPE_INVOICES: { group: 'Money', kind: 'off-switch', file: 'stripe.js', doc: ENV_DOC,
    meaning: 'Pay Online mints a Stripe invoice for CRM invoices. "off" = falls back to the plain link.' },

  // ── Public forms ────────────────────────────────────────────────────────
  NBD_CONNECT_ALLOW_TEST_MODE: { group: 'Money', kind: 'one-on', file: 'stripe-connect-logic.js', doc: 'documentation/audit/INVOICE-PIPELINE-CORS-FIX-2026-09-08.md',
    meaning: 'QA only: lets Stripe Connect accept test-mode keys. Should always read OFF in production.' },
  TURNSTILE_REQUIRED: { group: 'Public forms', kind: 'required', file: 'integrations/turnstile.js', doc: 'documentation/runbooks/TURNSTILE-SETUP.md',
    meaning: 'If the Turnstile secret ever goes missing, public forms fail closed instead of letting everything through.' },
  FUNNEL_RECOVERY_ENABLED: { group: 'Public forms', doc: 'documentation/runbooks/SPEND_KILLSWITCH.md',
    meaning: 'Follows up people who started a public form but did not finish. Off = none sent.' },

  // ── Experiments ─────────────────────────────────────────────────────────
  JOBS_MIRROR_ENABLED: { group: 'Experiments', doc: ENV_DOC,
    meaning: 'Multi-job phase 1: keeps each lead\'s jobs/j1 copy in step with the lead. Off = leads are not mirrored.' },
  VISUALIZER_IMAGEGEN_ENABLED: { group: 'Experiments', doc: 'documentation/runbooks/VISUALIZER-KIE-PROVIDER.md',
    meaning: 'The roof visualizer\'s paid image generation. Off = no image spend.' },
  SOCIAL_PUBLISHER_DISABLED: { group: 'Experiments', doc: 'documentation/runbooks/SOCIAL-PUBLISHER-SETUP.md',
    meaning: 'Social Studio publisher global kill switch (each company still has its own on/off). PAUSED = nothing posts.' },
  SOCIAL_GBP_ENABLED: { group: 'Experiments', dark: true, doc: 'documentation/runbooks/SOCIAL-PUBLISHER-SETUP.md',
    meaning: 'Social Studio posting to Google Business. Off until Google API access is granted.' },
  GOOGLE_CALENDAR_SYNC_DISABLED: { group: 'Experiments', doc: ENV_DOC,
    meaning: 'Two-way Google Calendar sync. PAUSED = no sync.' },
  HEALTH_SHORTCUT_DISABLED: { group: 'Experiments', doc: 'documentation/runbooks/HEALTH-SHORTCUT.md',
    meaning: 'Kill switch for the Apple Health weight Shortcut. PAUSED = the endpoint answers 404 to everyone.' },
  AGENT_MCP_DISABLED: { group: 'Experiments', doc: 'documentation/projects/AI-AUTOMATIONS-2026-10-04.md',
    meaning: 'The Grok Bot team\'s read/notes connection to the CRM. PAUSED = bots are locked out.' },
};

// Non-gate flags need a `kind`; gates take their polarity from CRON_GATES.
const GATE_BY_NAME = {};
for (const g of CRON_GATES) GATE_BY_NAME[g.name] = g;

const FLAGS = Object.keys(ROWS).map((name) => {
  const r = ROWS[name];
  const gate = GATE_BY_NAME[name];
  return {
    name,
    kind: gate ? gate.polarity : r.kind,
    group: r.group,
    file: gate ? gate.file : r.file,
    meaning: r.meaning,
    doc: r.doc,
    dark: !!r.dark,
  };
});

// ── safety ────────────────────────────────────────────────────────────────
const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;
function isSafeName(name) {
  return typeof name === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(name) && !SECRET_NAME_RE.test(name);
}
// A flag value is a short plain word ('true', 'off', 'live'). Anything else —
// a long string, a URL, something with punctuation or whitespace — is never
// echoed back. The case is kept EXACTLY: the code compares literals
// (=== 'true'), so 'TRUE' is OFF at runtime and must read as 'TRUE' here, not
// be folded to a flattering 'true'.
function safeValue(v) {
  if (v === undefined || v === null || v === '') return 'unset';
  const s = String(v);
  if (/^[A-Za-z0-9_-]{1,16}$/.test(s)) return s;
  return 'other';
}

function stateFor(kind, raw) {
  const v = raw === 'unset' ? '' : raw;
  switch (kind) {
    case 'enabled': return v === 'true' ? 'ON' : 'OFF';
    case 'disabled': return v === 'true' ? 'PAUSED' : 'ON';
    case 'default-on': return v === 'false' ? 'PAUSED' : 'ON';
    case 'off-switch': return v === 'off' ? 'PAUSED' : 'ON';
    case 'required': return v.toLowerCase() === 'true' ? 'ON' : 'OFF';   // turnstile.js lower-cases first
    case 'one-on': return v === '1' ? 'ON' : 'OFF';
    case 'mode': { const m = v.toLowerCase(); return m === 'live' ? 'ON' : (m === 'test' ? 'TEST' : 'OFF'); }   // carePlanMode() lower-cases
    default: return 'OFF';
  }
}

// Minimal dotenv parse limited to registry names (never returns anything else).
function parseCommitted(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  const names = new Set(FLAGS.map((f) => f.name));
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && names.has(m[1])) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * env: the running env (process.env). committed: null (file unavailable) or the
 * parseCommitted() map. Returns one row per registered flag.
 */
function flagStatus(env, committed) {
  const e = env || {};
  return FLAGS.filter((f) => isSafeName(f.name)).map((f) => {
    const effective = safeValue(e[f.name]);
    const state = stateFor(f.kind, effective);
    let committedVal = null;
    let drift = null;
    if (committed) {
      committedVal = safeValue(committed[f.name]);
      drift = committedVal !== effective;
    }
    return {
      name: f.name, group: f.group, kind: f.kind, file: f.file, meaning: f.meaning,
      doc: f.doc, dark: f.dark, effective, state, committed: committedVal, drift,
    };
  });
}

/**
 * The whole `flagStatus` payload, as one pure function so a test can plant
 * secrets in `env` and scan what actually comes out (handlers/integrations.js
 * only reads the env file and calls this).
 */
function buildResponse(env, committedText, extra) {
  const committed = typeof committedText === 'string' ? parseCommitted(committedText) : null;
  const x = extra || {};
  return {
    flags: flagStatus(env, committed),
    groups: GROUPS.slice(),
    committedAvailable: committed !== null,
    revision: safeValue(x.revision) === 'other' ? null : (x.revision || null),
    generatedAtMs: Number(x.nowMs) || Date.now(),
  };
}

module.exports = { buildResponse, FLAGS, GROUPS, ENV_DOC, flagStatus, parseCommitted, isSafeName, safeValue, stateFor, SECRET_NAME_RE };
