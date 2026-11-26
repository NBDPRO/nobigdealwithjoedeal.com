/**
 * functions/cron-manifest.js — one entry per scheduled (onSchedule) export
 * (2026-11-22, documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md
 * §3.8 / §4).
 *
 * Only what the code cannot say for itself is written here:
 *   sendsToCustomers  'email' | 'text' | 'email+text' | 'none' — does this
 *                     cron (or anything it runs) send an AUTOMATED message to
 *                     a homeowner / lead / subscriber? Owner, staff and
 *                     contractor-account mail is 'none'.
 *   usesSendWindow    true when every customer send it makes waits for the
 *                     customer send window (send-window.js, 8:00-20:00 in the
 *                     recipient's time).
 *   gate              what turns it on / off: 'env:<NAME>' (a CRON_GATES env
 *                     var, cron-gates.js, or a module's own kill switch),
 *                     'automation:<key>' (the MessagingControls automations doc,
 *                     messaging-controls.js AUTOMATION_KEYS) or
 *                     'flag:<doc.field>' (feature_flags). [] = always on.
 *
 * Everything else (module, schedule, timeZone, timeoutSeconds) is DERIVED
 * from the deployed endpoint (functions/index.js exports) and
 * function-map.json by build(), never hand-copied. check() lists every
 * drift: a cron with no entry, an entry with no cron, a cron with no time
 * zone, a customer-sending cron outside the window, an unknown gate.
 *
 * The two hand-written booleans are TIED TO THE CODE when check() is given
 * opts.reach (reach() below: the static require() graph of the cron's
 * function-map module). usesSendWindow: true must reach send-window.js by a
 * path that does not run through messaging-controls.js (every sender loads
 * that, and its lazy send-window require proves nothing about this cron). A
 * 'none' cron whose code reaches the resend / twilio packages or the Twilio
 * Messages.json REST URL must carry a `why`: who that mail or text goes to.
 * The graph is per MODULE, so a cron sharing a file with a sender (all of
 * call-center.js's crons) is flagged too and answers with its why.
 * tests/cron-manifest-2026-11-22.test.js runs it in CI.
 *
 * No npm deps (callers pass the loaded exports, the map and the gate lists;
 * reach() reads the source files with fs).
 */
'use strict';

const SENDS = Object.freeze(['email', 'text', 'email+text', 'none']);

// why: required when the cron's code can send mail or texts (see reach()).
const none = (gate, why) => Object.assign({ sendsToCustomers: 'none', usesSendWindow: false, gate: gate || [] }, why ? { why } : {});
const CALL_CENTER_WHY = 'shares call-center.js, whose one customer send (the missed-call auto-text) only callCenterIngest runs; this cron mails the owner at most';

const ENTRIES = Object.freeze({
  // ── automated CUSTOMER sends: every one waits for the send window ──
  esignReminderSweep: { sendsToCustomers: 'email', usesSendWindow: true, gate: ['env:ESIGN_REMINDERS_DISABLED'] },
  stormTipsSweep: { sendsToCustomers: 'email', usesSendWindow: true, gate: ['env:STORM_TIPS_EMAIL_ENABLED', 'automation:stormTipsEmail'] },
  runAbandonRecovery: { sendsToCustomers: 'email', usesSendWindow: true, gate: ['env:FUNNEL_RECOVERY_ENABLED', 'automation:funnelRecoveryEmail'] },
  leadFollowUpSweep: { sendsToCustomers: 'email', usesSendWindow: true, gate: ['env:LEAD_FOLLOWUP_ENABLED', 'automation:leadFollowupEmail'] },
  reviewAskAutoSweep: { sendsToCustomers: 'email+text', usesSendWindow: true, gate: ['env:REVIEW_ASK_AUTO_EMAIL_ENABLED', 'env:REVIEW_ASK_AUTO_TEXT_ENABLED', 'automation:reviewAskAutoEmail', 'automation:reviewAskAutoText'] },
  // storm-watch subscriber texts, NWS storm texts, the subscriber confirm text
  stormPoller: { sendsToCustomers: 'text', usesSendWindow: true, gate: ['env:STORM_TEXT_ENABLED', 'env:STORM_NWS_TEXT_ENABLED', 'env:STORM_CONFIRM_TEXT_ENABLED', 'automation:stormText', 'automation:stormNwsText', 'automation:stormConfirmText'] },
  // the missed-call auto-text (missed-call-autotext.js)
  callCenterIngest: { sendsToCustomers: 'text', usesSendWindow: true, gate: ['env:CALL_CENTER_INGEST_ENABLED', 'env:MISSED_CALL_AUTOTEXT_ENABLED', 'automation:missedCallAutotext'] },

  // ── owner / staff / contractor-account / no message at all ──
  onAppointmentReminder: none(),          // push to the rep
  onFollowUpDue: none(),                  // push to the rep
  onYardSignPickupDue: none(),            // push to the rep
  onAfterInstallDay: none(),              // push to the rep
  cronDeadman: none(['env:CRON_DEADMAN_DISABLED'], 'owner-notify.js: bell + push to the owner about stopped crons (step 11, #3237); never a customer'),
  leadAlertWatchdog: none(['env:LEAD_ALERT_WATCHDOG_DISABLED'], 'lead-alert.js alertJoe re-sent to the owner (ack: false, never the homeowner ack)'),
  hailMatchCron: none(),
  meshHailCron: none(['flag:global.meshHailEnabled']),
  auditLogRetentionCron: none(),
  emailQueueWorker: none([], 'account mail only: owner, platform and contractor Auth addresses (email-queue-worker.js header; tests/email-queue-recipients-2026-10-19.test.js)'),
  recordingRetentionCron: none(['flag:global.voiceIntelDisabled'], 'deletes old recordings; reaches call-center.js only through visit-capture.js'),
  docLinkFollowupSweep: none(['env:DOC_LINK_FOLLOWUP_ENABLED']), // Agent-inbox reminder to the owner
  pdfRenderRetention: none(),
  stripeLedgerReconcile: none(['env:STRIPE_LEDGER_DISABLED']),
  invoiceOverdueSweep: none(['env:NBD_INVOICE_OVERDUE']), // a task on the lead, nothing sent
  googleCalendarReconcile: none(['env:GOOGLE_CALENDAR_SYNC_DISABLED']),
  dailyFirestoreBackup: none(),
  firestoreBackupRetention: none(),
  backupFreshnessCron: none([], 'owner only: email_queue to the owner + owner-notify.js text to the owner phone (step 13); never a customer'),
  weeklyVendorConfigExport: none(),
  migrationsTick: none(),
  dailyLeadDigest: none([], 'the digest to DIGEST_EMAILS (the owner)'),
  monthlyMarketingReport: none([], 'the report to REPORT_EMAILS (the owner)'),
  weeklyDigest: none(['env:WEEKLY_DIGEST_ENABLED'], "to the user's verified Auth email"),
  dormantLeadNudge: none(['env:DORMANT_NUDGE_ENABLED'], "to the rep's verified Auth email, never the homeowner"),
  anniversaryAutoTouch: none(['env:ANNIVERSARY_TOUCH_ENABLED'], "to the rep's verified Auth email, never the homeowner"),
  enforceLapsedSeats: none(),
  resumeMemberStorageMoves: none(),
  reviewRequestNudge: none(['env:REVIEW_NUDGE_ENABLED'], "to the rep's verified Auth email"),
  morningBrief: none(['env:MORNING_BRIEF_ENABLED', 'env:MORNING_BRIEF_ABSORB_ENABLED', 'env:MORNING_BRIEF_DELTA_ENABLED'], "to the user's own email (plus DIGEST_EMAILS when absorbed)"),
  promiseCleanup: none(['env:PROMISE_CLEANUP_ENABLED'], CALL_CENTER_WHY),
  callRetention: none(['env:CALL_RETENTION_ENABLED', 'env:CALL_RETENTION_THURSDAY_ENABLED']),
  awayModeTick: none(['env:AWAY_MODE_ENABLED']),
  callCenterTranscribe: none(['env:CALL_CENTER_TRANSCRIBE_ENABLED'], CALL_CENTER_WHY),
  callCenterSweep: none(['env:CALL_CENTER_SWEEP_ENABLED'], CALL_CENTER_WHY + " (the \"you said you'd\" email)"),
  callWatch: none(['env:CALL_WATCH_ENABLED'], 'reads Twilio Messages.json (GET) and emails the owner'),
  companyDocExpiryWatch: none(['env:COMPANY_DOC_EXPIRY_ENABLED']),
  subPaperworkWatch: none(['env:SUB_PAPERWORK_WATCH_ENABLED']),
  ownerWeeklyDigest: none(['env:OWNER_WEEKLY_DIGEST_ENABLED'], CALL_CENTER_WHY),
  officePlanner: none(['env:OFFICE_PLANNER_ENABLED']),
  leaderboardAggregate: none(['env:LEADERBOARD_AGGREGATE_ENABLED']),
  messagingWatch: none(['flag:messagingControlCenter']),
  visitCaptureSweep: none([], CALL_CENTER_WHY),
  visitBinSweep: none([], CALL_CENTER_WHY),
  textInboxIngest: none(['env:TEXT_INBOX_ENABLED'], CALL_CENTER_WHY),
  textInboxNotes: none(['env:TEXT_NOTES_ENABLED'], CALL_CENTER_WHY),
  syncGbpReviews: none(),
  socialPublisher: none(['env:SOCIAL_PUBLISHER_DISABLED', 'env:SOCIAL_GBP_ENABLED']), // public posts, not messages
  reelCleanup: none(['flag:global.reelStudioDisabled'], 'deletes old reels; reaches call-center.js only through voice-intelligence.js / visit-capture.js'),
  healthDigestCron: none(['env:HEALTH_DIGEST_ENABLED'], 'owner only: the daily health digest to the owner + owner-notify.js alerts (step 13); never a customer'),
  monthlyOverheadAlertCron: none(['env:MONTHLY_OVERHEAD_ALERT_DISABLED']),
  mailFeed: none(['env:MAIL_FEED_ENABLED']), // reads mail (IMAP read-only, Gmail GET), sends nothing
});

const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const NOT_WALKED = Object.freeze(['messaging-controls.js']);

/**
 * What a module's code can reach through require() (lazy ones included: a
 * regex over the source, so a require inside a function counts). Relative
 * requires are followed inside fnDir; messaging-controls.js is recorded but
 * not walked (see the header).
 * @returns {{ files: Set<string>, packages: Set<string>, twilioRest: boolean }}
 *   files: paths relative to fnDir ('send-window.js', 'integrations/x.js');
 *   packages: top-level package names ('resend', 'twilio', ...)
 */
function reach(fnDir, moduleRel) {
  const fs = require('fs');
  const path = require('path');
  const out = { files: new Set(), packages: new Set(), twilioRest: false };
  const resolveFrom = (from, spec) => {
    const b = path.resolve(path.dirname(from), spec);
    for (const c of [b, b + '.js', path.join(b, 'index.js')]) {
      try { if (fs.statSync(c).isFile()) return c; } catch (_) { /* next candidate */ }
    }
    return null;
  };
  const start = moduleRel ? resolveFrom(path.join(fnDir, 'index.js'), moduleRel) : null;
  const stack = start ? [start] : [];
  const seen = new Set();
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const rel = path.relative(fnDir, f).split(path.sep).join('/');
    out.files.add(rel);
    if (!f.endsWith('.js') || (f !== start && NOT_WALKED.indexOf(rel) !== -1)) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (src.indexOf('Messages.json') !== -1) out.twilioRest = true;
    for (const m of src.matchAll(REQUIRE_RE)) {
      if (m[1].charAt(0) === '.') {
        const r = resolveFrom(f, m[1]);
        if (r && !path.relative(fnDir, r).startsWith('..')) stack.push(r);
      } else {
        out.packages.add(m[1].charAt(0) === '@' ? m[1].split('/').slice(0, 2).join('/') : m[1].split('/')[0]);
      }
    }
  }
  return out;
}

function isScheduled(fn) {
  return !!(fn && fn.__endpoint && fn.__endpoint.scheduleTrigger);
}

/** A real value, or null for an unset / ResetValue option. */
function plain(v) {
  return typeof v === 'string' || typeof v === 'number' ? v : null;
}

/**
 * The full manifest: one row per scheduled export, derived facts merged with
 * the hand entry (null fields when there is no entry).
 * @param {object} indexExports  require('./index.js')
 * @param {object} functionMap   require('./function-map.json')
 * @param {object} [entries]     defaults to ENTRIES (tests pass their own)
 */
function build(indexExports, functionMap, entries) {
  const hand = entries || ENTRIES;
  const rows = [];
  for (const name of Object.keys(indexExports || {}).sort()) {
    const fn = indexExports[name];
    if (!isScheduled(fn)) continue;
    const ep = fn.__endpoint;
    const e = Object.prototype.hasOwnProperty.call(hand, name) ? hand[name] : null;
    rows.push({
      name,
      module: (functionMap && functionMap[name]) || null,
      schedule: plain(ep.scheduleTrigger.schedule),
      timeZone: plain(ep.scheduleTrigger.timeZone),
      timeoutSeconds: plain(ep.timeoutSeconds),
      sendsToCustomers: e ? e.sendsToCustomers : null,
      usesSendWindow: e ? e.usesSendWindow : null,
      gate: e ? e.gate : null,
      why: e && typeof e.why === 'string' ? e.why : null,
      hasEntry: !!e,
    });
  }
  return rows;
}

function validTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

/**
 * Every drift between the deployed crons and the manifest. [] = clean.
 * opts: { entries, cronGates: [{name}], automationKeys: [string],
 *         reach: (moduleRel) => reach()'s answer (turns on the code tie) }
 */
function check(indexExports, functionMap, opts) {
  const o = opts || {};
  const hand = o.entries || ENTRIES;
  const gateNames = new Set((o.cronGates || []).map((g) => g.name));
  const autoKeys = new Set(o.automationKeys || []);
  const rows = build(indexExports, functionMap, hand);
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.name);
    if (!r.hasEntry) { problems.push(r.name + ': scheduled but has no cron-manifest.js entry'); continue; }
    if (!r.module) problems.push(r.name + ': not in function-map.json (run node scripts/gen-function-map.js)');
    if (!validTimeZone(r.timeZone)) problems.push(r.name + ': no timeZone (a cron without one runs in UTC)');
    if (SENDS.indexOf(r.sendsToCustomers) === -1) problems.push(r.name + ': sendsToCustomers must be one of ' + SENDS.join(' | '));
    if (typeof r.usesSendWindow !== 'boolean') problems.push(r.name + ': usesSendWindow must be true or false');
    if (r.sendsToCustomers !== 'none' && r.usesSendWindow !== true) problems.push(r.name + ': sends to customers but does not use the customer send window (send-window.js)');
    if (typeof o.reach === 'function' && r.module) {
      const g = o.reach(r.module);
      if (r.usesSendWindow === true && !g.files.has('send-window.js')) problems.push(r.name + ': says usesSendWindow but its code (' + r.module + ') never reaches send-window.js');
      const senders = ['resend', 'twilio'].filter((p) => g.packages.has(p)).concat(g.twilioRest ? ['Twilio Messages.json'] : []);
      if (r.sendsToCustomers === 'none' && senders.length && !(r.why && r.why.trim())) {
        problems.push(r.name + ': marked none but its code reaches ' + senders.join(' + ') + ': add a why (who that mail / text goes to)');
      }
    }
    if (!Array.isArray(r.gate)) { problems.push(r.name + ': gate must be an array'); continue; }
    for (const g of r.gate) {
      const m = /^(env|automation|flag):(.+)$/.exec(String(g));
      if (!m) { problems.push(r.name + ': gate "' + g + '" must start env: / automation: / flag:'); continue; }
      if (m[1] === 'env' && /_(ENABLED|DISABLED)$/.test(m[2]) && gateNames.size && !gateNames.has(m[2])) problems.push(r.name + ': gate ' + g + ' is not in cron-gates.js');
      if (m[1] === 'automation' && autoKeys.size && !autoKeys.has(m[2])) problems.push(r.name + ': gate ' + g + ' is not a MessagingControls AUTOMATION_KEYS entry');
    }
  }
  for (const name of Object.keys(hand)) {
    if (!seen.has(name)) problems.push(name + ': cron-manifest.js entry for something that is not a scheduled export');
  }
  return problems;
}

module.exports = { ENTRIES, SENDS, build, check, reach, isScheduled };
