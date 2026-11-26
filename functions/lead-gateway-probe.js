'use strict';
/**
 * functions/lead-gateway-probe.js — leadGatewayProbe (2026-11-26, web-leads
 * outage follow-up 5; Joe chose every option below on 2026-11-26).
 *
 * WHY: from 2026-10-13 to 2026-11-25 every website lead form answered 403
 * (TURNSTILE_REQUIRED=true with the `__unset__` stub secret) and nothing said
 * so for six weeks. The alarms added on 2026-11-25 (GA4 lead_submit_failed,
 * monitoring/alert-lead-submit-failures.json) only fire when a homeowner
 * submits, and the site gets a few submits a month. This cron makes the
 * submit itself, every morning, so a broken gateway is caught with zero
 * traffic. documentation/projects/LEAD-GATEWAY-PROBE-2026-11-26.md.
 *
 * WHAT IT DOES (daily 09:00 ET, daytime so a failure text goes out at once):
 *  1. For every public lead kind, POSTs a probe body to the LIVE
 *     submitPublicLead with the site's Origin, the probe header and a Google
 *     ID token for this function's own service account (lead-probe-auth.js).
 *     The gateway runs every gate a real submit runs (per-IP limit, Turnstile
 *     posture, kind / field / phone validation) and answers 200 { probe: true }
 *     WITHOUT storing anything: no lead, no CRM bridge, no text or email.
 *     Pass = 200, probe:true, and the CORS allow-origin for the site.
 *  2. Any failure → notifyOwner severity 'alert' (text + bell + push), and the
 *     run throws so the heartbeat reports /fail. A failed probe also returns
 *     4xx/5xx, so the 2026-11-25 Cloud Monitoring email policy fires too.
 *  3. Quiet leads: if the newest doc across every public lead collection is
 *     older than QUIET_DAYS (14), notifyOwner severity 'info' (bell + push, no
 *     text), once per silence (system/leadGatewayProbe.quietNotifiedNewestMs).
 *
 * SAFETY (the probe must never create a lead):
 *  - the gateway answers the probe before its Firestore add, tenant read and
 *    flood/duplicate buckets (tests/lead-gateway-probe-2026-11-26.test.js);
 *  - every probe body carries the honeypot sentinel, so a gateway that does not
 *    know probe mode (deploy skew) pretends success and stores nothing, and
 *    this cron then reports "not a probe answer";
 *  - fictional data only: 513-555-0100, lead-probe@example.com.
 * No enable gate, on purpose (backup-freshness.js design note 2): an alarm a
 * flag can silence is how the outage stayed hidden.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const LeadProbe = require('./lead-probe-auth');

const SITE_ORIGIN = 'https://nobigdealwithjoedeal.com';
const QUIET_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_DOC = 'system/leadGatewayProbe';
const PROBE_SENTINEL = LeadProbe.PROBE_SENTINEL;
const PROBE_PHONE = '5135550100';

// Valid sample values by field name; anything else gets a short plain string.
const SAMPLE = {
  phone: PROBE_PHONE,
  zip: '45202',
  email: 'lead-probe@example.com',
  address: '1 Probe St, Cincinnati, OH 45202',
  source: 'lead-gateway-probe',
  story: 'Daily lead-gateway probe. Not a homeowner; never stored.',
};

function probeKinds(spec) {
  return Object.keys((spec && spec.PUBLIC_LEAD_KINDS) || {});
}

/** A body that passes the kind's REAL validation, plus the honeypot sentinel. (pure) */
function buildProbeBody(kind, spec) {
  const k = spec.PUBLIC_LEAD_KINDS[kind];
  const body = { nbd_hp: PROBE_SENTINEL };
  for (const key of k.required) {
    let v = Object.prototype.hasOwnProperty.call(SAMPLE, key) ? SAMPLE[key] : 'Lead Probe';
    const exact = k.exact && k.exact[key];
    if (exact) v = (v + '00000000').slice(0, exact);
    const max = (k.maxLen && k.maxLen[key]) || 200;
    body[key] = v.slice(0, max);
  }
  return body;
}

/** One verdict per kind: { kind, ok, status, reason }. */
async function runProbes({ spec, url, token, origin, fetchImpl }) {
  const site = origin || SITE_ORIGIN;
  const doFetch = fetchImpl || fetch;
  const out = [];
  for (const kind of probeKinds(spec)) {
    const body = Object.assign({ kind }, buildProbeBody(kind, spec));
    let status = 0;
    try {
      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: site,
          [LeadProbe.PROBE_HEADER]: '1',
          [LeadProbe.TOKEN_HEADER]: token,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      status = res.status;
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      const acao = res.headers && typeof res.headers.get === 'function' ? res.headers.get('access-control-allow-origin') : null;
      if (status !== 200) {
        const why = json && (json.reason || json.error) ? ' ' + String(json.reason || json.error).slice(0, 80) : '';
        out.push({ kind, ok: false, status, reason: 'HTTP ' + status + why });
      } else if (!json || json.success !== true || json.probe !== true) {
        out.push({ kind, ok: false, status, reason: 'not a probe answer (gateway without probe mode, or honeypot)' });
      } else if (acao !== site) {
        out.push({ kind, ok: false, status, reason: 'CORS allow-origin is ' + (acao || 'missing') + ', not ' + site + ': browsers would be blocked' });
      } else {
        out.push({ kind, ok: true, status, turnstile: json.turnstile || '' });
      }
    } catch (e) {
      out.push({ kind, ok: false, status, reason: 'network: ' + String((e && e.message) || e).slice(0, 120) });
    }
  }
  return out;
}

/**
 * Quiet-leads notice, once per silence. newestMs: newest stored public lead
 * (0 = none at all; null = could not read → never notify from a failed read).
 */
function quietDecision({ newestMs, nowMs, state }) {
  if (newestMs == null || !Number.isFinite(newestMs)) return { notify: false };
  const days = Math.floor((nowMs - newestMs) / DAY_MS);
  if (newestMs > 0 && days < QUIET_DAYS) return { notify: false, days };
  const st = state || {};
  if (Object.prototype.hasOwnProperty.call(st, 'quietNotifiedNewestMs') && st.quietNotifiedNewestMs === newestMs) {
    return { notify: false, days };
  }
  return { notify: true, days };
}

function tsMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Newest NBD-own public lead (no companyId: NBD's forms send none; a tenant
 * microsite lead carries one and must not reset NBD's quiet clock). Reads the
 * newest QUIET_SCAN docs per collection and keeps the first untagged one.
 */
const QUIET_SCAN = 25;
function isNbdOwn(d) { return !d || !d.companyId; }
async function newestLeadMs(db, collections) {
  let newest = 0;
  for (const c of collections) {
    const snap = await db.collection(c).orderBy('createdAt', 'desc').limit(QUIET_SCAN).get();
    let found = false;
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (found || !isNbdOwn(d)) return;
      found = true;
      newest = Math.max(newest, tsMs(d.createdAt));
    });
  }
  return newest;
}

exports.leadGatewayProbe = onSchedule(
  {
    schedule: '0 9 * * *',
    timeZone: 'America/New_York',
    maxInstances: 1,
    timeoutSeconds: 180,
    memory: '256MiB',
    retry: false,
    // owner-notify.js may text the owner.
    secrets: require('./owner-notify').SMS_SECRETS,
  },
  async () => {
    const { getFirestore } = require('firebase-admin/firestore');
    const db = getFirestore();
    const nowMs = Date.now();
    const spec = require('./handlers/integrations')._publicLeadSpec;
    const url = LeadProbe.probeAudience();

    let results;
    try {
      const token = await LeadProbe.mintProbeToken(url);
      results = await runProbes({ spec, url, token });
    } catch (e) {
      results = [{ kind: '*', ok: false, status: 0, reason: 'could not sign the probe: ' + String((e && e.message) || e).slice(0, 120) }];
    }
    const failedKinds = results.filter((r) => !r.ok);
    logger.info('leadGatewayProbe', { ok: failedKinds.length === 0, results });

    let state = {};
    try { const s = await db.doc(STATE_DOC).get(); state = (s.exists && s.data()) || {}; } catch (_) { state = {}; }
    const patch = { lastRunAtMs: nowMs, lastOk: failedKinds.length === 0, lastFailures: failedKinds.map((r) => r.kind + ': ' + r.reason).slice(0, 10) };

    if (failedKinds.length) {
      const body = 'Website lead forms would FAIL right now. ' +
        failedKinds.map((r) => r.kind + ': ' + r.reason).join('; ').slice(0, 600) +
        ' — runbook: documentation/runbooks/TURNSTILE-SETUP.md "Emergency"; logs: submitpubliclead.';
      try {
        await require('./owner-notify').notifyOwner(db, {
          title: 'Website lead forms failing', body, severity: 'alert',
          key: 'lead-gateway-probe', type: 'lead_gateway_watch', clickUrl: '/pro/dashboard.html', idPrefix: 'lead-gateway-probe-',
        });
      } catch (e) { logger.warn('leadGatewayProbe: owner notify failed', { err: e && e.message }); }
    }

    // Quiet leads (bell only). A read failure skips the notice, never fakes one.
    let newest = null;
    try {
      const collections = [...new Set(Object.values(spec.PUBLIC_LEAD_KINDS).map((k) => k.collection))];
      newest = await newestLeadMs(db, collections);
    } catch (e) { logger.warn('leadGatewayProbe: quiet-leads read failed', { err: e && e.message }); }
    const q = quietDecision({ newestMs: newest, nowMs, state });
    if (q.notify) {
      const body = newest
        ? 'No website lead has been stored for ' + q.days + ' days (newest ' + new Date(newest).toISOString().slice(0, 10) + '). The daily probe says the forms ' + (failedKinds.length ? 'are FAILING.' : 'work, so this is likely just a quiet stretch.')
        : 'No website lead has ever been stored in the public lead collections.';
      try {
        await require('./owner-notify').notifyOwner(db, {
          title: 'No website leads for ' + (newest ? q.days + ' days' : 'a long time'), body, severity: 'info',
          key: 'lead-gateway-quiet', type: 'lead_gateway_watch', clickUrl: '/pro/dashboard.html', idPrefix: 'lead-gateway-quiet-',
        });
        patch.quietNotifiedNewestMs = newest;
      } catch (e) { logger.warn('leadGatewayProbe: quiet notify failed', { err: e && e.message }); }
    }
    try { await db.doc(STATE_DOC).set(patch, { merge: true }); } catch (e) { logger.warn('leadGatewayProbe: state write failed', { err: e && e.message }); }

    if (failedKinds.length) throw new Error('lead gateway probe failed: ' + failedKinds.map((r) => r.kind).join(', '));
  }
);

exports._internal = { probeKinds, buildProbeBody, runProbes, quietDecision, newestLeadMs, QUIET_DAYS, SITE_ORIGIN, PROBE_SENTINEL, PROBE_PHONE, STATE_DOC };
