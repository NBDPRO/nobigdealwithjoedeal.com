'use strict';

/**
 * functions/storm-poller.js — ONE storm poller (2026-10-04).
 *
 * checkStormAlerts (NWS weather ALERTS → subscriber texts, sms-functions.js)
 * and stormWatch (NWS/IEM storm REPORTS → Jo's alert + gated subscriber
 * texts, storm-watch.js) both ran every 30 minutes and already shared one
 * cooldown. They are now one scheduled function that runs both halves back to
 * back. Nothing about either half's behaviour changed — the same TCPA guards
 * (#2114, storm-sms-guard.js) sit underneath both: the integrations/
 * stormAlerts master switch, the sms_opt_outs register, quiet hours in the
 * subscriber's own time zone, the cooldown claimed in a transaction BEFORE
 * any send, and STORM_TEXT_ENABLED for the reports half's subscriber texts.
 *
 * Order: reports first (Jo's own alert is the time-critical one), then alerts.
 * Each half is isolated: one throwing never skips the other.
 * Timeout: the alerts half stops itself at its own 420 s run budget
 * (STORM_RUN_BUDGET_MS, measured from its own start), so 900 s covers a slow
 * reports half plus a full alerts fan-out.
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const SW = require('./storm-watch');
const SMS = require('./sms-functions');

// Union by secret name (each module defines its own param objects).
const SECRETS = [];
for (const s of SW.STORM_WATCH_SECRETS.concat(SMS.STORM_ALERT_SECRETS)) {
  if (!SECRETS.some((x) => x.name === s.name)) SECRETS.push(s);
}

async function runStormPoller(deps) {
  const d = deps || {};
  const watch = d.runStormWatch || SW.runStormWatch;
  const alerts = d.runCheckStormAlerts || SMS.runCheckStormAlerts;
  const log = d.log || logger;
  const out = { reports: 'ok', alerts: 'ok' };
  try { await watch(); } catch (e) { out.reports = 'failed'; log.error('stormPoller: reports half failed', { err: e && e.message }); }
  try { await alerts({}); } catch (e) { out.alerts = 'failed'; log.error('stormPoller: alerts half failed', { err: e && e.message }); }
  return out;
}

exports.stormPoller = onSchedule(
  {
    schedule: 'every 30 minutes',
    timeZone: 'America/New_York',
    secrets: SECRETS,
    maxInstances: 1,
    timeoutSeconds: 900,
    memory: '256MiB',
  },
  () => runStormPoller()
);

exports._test = { runStormPoller, SECRETS };
