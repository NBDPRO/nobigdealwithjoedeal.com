#!/usr/bin/env node
/**
 * tests/send-window-2026-11-22.test.js — ONE customer send window (Joe,
 * 2026-11-22): automated customer emails AND texts go only 8:00-20:00 in the
 * RECIPIENT's local time. Audit: documentation/audit/
 * BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §3.8 (leadFollowUpSweep ran
 * '0 *\/3' including 00:00 and 03:00 ET; runAbandonRecovery had no timeZone
 * and no hour check; text quiet hours lived in each caller, not guardTwilio).
 *
 *   A. functions/send-window.js, pure: the window, nextOpenMs across DST, the
 *      recipient time zone chain (tz → state / ZIP / address → company → ET)
 *   B. guardTwilio refuses an automated text outside the window CENTRALLY,
 *      even when the caller forgot to pass any recipient; owner alerts,
 *      instant confirmations and rep-typed texts are exempt only by an
 *      explicit marker
 *   C. leadFollowUpSweep at 3am ET leaves the lead UNCLAIMED and sends at
 *      8am; a Pacific homeowner waits for 8am Pacific (behavioural, the real
 *      module with its deps stubbed at Module._load)
 *   D. every other automated customer path (funnel recovery, e-sign
 *      reminders, review asks, storm texts, storm confirm, missed-call
 *      auto-text) defers BEFORE its one-shot claim, so a deferral never burns
 *      the send (behavioural, each with a daytime control)
 *   E. the exempt senders carry their marker (the only source-text pins)
 *
 * Needs functions/node_modules (junctioned in a worktree).
 * Run: node tests/send-window-2026-11-22.test.js
 */
'use strict';
// Only NBD texts on NBD's Twilio sender (review-ask guardrail plan S0, 2026-11-26): this suite's
// fixture tenant stands in for NBD. sms-texting-gate.js refuses every other company (no_own_sender).
process.env.NBD_OWNER_UID = 'O';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (f) => fs.readFileSync(path.join(FN, f), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const iso = (ms) => (ms == null || !Number.isFinite(ms) ? String(ms) : new Date(ms).toISOString());
const T = (s) => Date.parse(s);

let SW = null;
try { SW = require(path.join(FN, 'send-window.js')); } catch (e) { SW = null; }
ok('functions/send-window.js exists and loads', !!SW);
if (!SW) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

(async () => {
  console.log('\nA. the window, in the recipient\'s local time');
  ok('START_H = 8, END_H = 20', SW.START_H === 8 && SW.END_H === 20, [SW.START_H, SW.END_H]);
  ok('03:00 ET is outside', SW.inWindow(T('2026-11-23T08:00:00Z'), 'America/New_York') === false);
  ok('08:00 ET is inside (start inclusive)', SW.inWindow(T('2026-11-23T13:00:00Z'), 'America/New_York') === true);
  ok('19:59 ET is inside', SW.inWindow(T('2026-11-24T00:59:00Z'), 'America/New_York') === true);
  ok('20:00 ET is outside (end exclusive)', SW.inWindow(T('2026-11-24T01:00:00Z'), 'America/New_York') === false);
  {
    const at = T('2026-11-23T08:00:00Z'); // 03:00 EST
    const next = SW.nextOpenMs(at, 'America/New_York');
    ok('3am ET opens at 8am ET the same day', next === T('2026-11-23T13:00:00Z'), iso(next));
    ok('inside the window, nextOpenMs is now', SW.nextOpenMs(T('2026-11-23T15:00:00Z'), 'America/New_York') === T('2026-11-23T15:00:00Z'));
    const evening = SW.nextOpenMs(T('2026-11-24T01:30:00Z'), 'America/New_York'); // 20:30 EST
    ok('8:30pm ET waits for 8am ET tomorrow', evening === T('2026-11-24T13:00:00Z'), iso(evening));
  }
  {
    // 9am ET = 6am PT: a Pacific recipient is still asleep.
    const at = T('2026-11-23T14:00:00Z');
    ok('9am ET is outside for Los Angeles', SW.inWindow(at, 'America/Los_Angeles') === false);
    ok('...opens at 8am Pacific (16:00Z)', SW.nextOpenMs(at, 'America/Los_Angeles') === T('2026-11-23T16:00:00Z'), iso(SW.nextOpenMs(at, 'America/Los_Angeles')));
  }
  {
    // DST: a naive "+N hours" answer is an hour off on both change days.
    const spring = SW.nextOpenMs(T('2026-03-08T06:30:00Z'), 'America/New_York'); // 01:30 EST, clocks jump at 2am
    ok('spring forward: 1:30am EST opens at 8:00 EDT (12:00Z)', spring === T('2026-03-08T12:00:00Z'), iso(spring));
    const fall = SW.nextOpenMs(T('2026-11-01T05:30:00Z'), 'America/New_York'); // 01:30 EDT, clocks fall back at 2am
    ok('fall back: 1:30am EDT opens at 8:00 EST (13:00Z)', fall === T('2026-11-01T13:00:00Z'), iso(fall));
    ok('the hour after fall-back (1:30 EST, second pass) is outside', SW.inWindow(T('2026-11-01T06:30:00Z'), 'America/New_York') === false);
  }
  {
    const z = SW.recipientZones({ state: 'KY' }, null);
    ok('a state-only Kentucky record must clear BOTH its zones', z.zones.length === 2 && z.zones.includes('America/New_York') && z.zones.includes('America/Chicago'), z);
    const at = T('2026-11-23T13:30:00Z'); // 8:30 EST, 7:30 CST
    ok('8:30 ET is still 7:30 in western KY: outside', SW.inWindow(at, z.zones) === false);
    ok('...opens at 9am ET / 8am CT', SW.nextOpenMs(at, z.zones) === T('2026-11-23T14:00:00Z'), iso(SW.nextOpenMs(at, z.zones)));
    ok('a Northern KY ZIP narrows to Eastern', SW.recipientTz({ state: 'KY', zip: '41042' }, null) === 'America/New_York');
    ok('a free-text address tail ("..., CA 90012") is Pacific', SW.recipientTz({ address: '1 Main St, Los Angeles, CA 90012' }, null) === 'America/Los_Angeles');
    ok('an explicit IANA tz on the record wins', SW.recipientTz({ tz: 'America/Denver', state: 'OH' }, null) === 'America/Denver');
    ok('no location → the company timezone', SW.recipientTz({}, { timezone: 'America/Phoenix' }) === 'America/Phoenix');
    ok('no location, companyProfile.timeZone spelling also read', SW.recipientTz({}, { timeZone: 'America/Chicago' }) === 'America/Chicago');
    ok('no location, a bad company zone → America/New_York', SW.recipientTz({}, { timezone: 'Not/AZone' }) === 'America/New_York');
    ok('nothing at all → America/New_York', SW.recipientTz(null, null) === 'America/New_York');
    ok('the record\'s own location beats the company zone', SW.recipientTz({ state: 'CA' }, { timezone: 'America/New_York' }) === 'America/Los_Angeles');
  }
  {
    const c = SW.check(T('2026-11-23T08:00:00Z'), { state: 'OH' }, null);
    ok('check(): outside → ok false with the opening time', c.ok === false && c.nextOpenMs === T('2026-11-23T13:00:00Z'), c);
    ok('isExempt() accepts only the explicit markers', SW.isExempt('exempt:internal') && SW.isExempt('exempt:transactional') && SW.isExempt('exempt:manual')
      && !SW.isExempt('exempt:whatever') && !SW.isExempt(true) && !SW.isExempt(undefined));
  }

  console.log('\nB. guardTwilio: the central refusal');
  const MC = require(path.join(FN, 'messaging-controls.js'));
  const { OPEN_CONTROLS } = require('./lib/messaging-controls-open');
  const fakeDb = (extra) => {
    const docs = Object.assign({}, OPEN_CONTROLS, extra || {});
    return { doc: (p) => ({ async get() { return { exists: docs[p] !== undefined, data: () => docs[p] }; } }) };
  };
  const fakeClient = () => {
    const sent = [];
    return { sent, messages: { create: async (m) => { sent.push(m); return { sid: 'SM' + sent.length }; }, list: async () => [] } };
  };
  const NIGHT = T('2026-11-23T08:00:00Z');   // 03:00 ET
  const MORNING_PT = T('2026-11-23T14:00:00Z'); // 09:00 ET / 06:00 PT
  const NOON_PT = T('2026-11-23T20:00:00Z');   // 15:00 ET / 12:00 PT
  async function attempt(client, ctxOpts, perCall, msg) {
    MC._resetCache();
    try {
      await MC.guardTwilio(fakeDb(), client, ctxOpts).messages.create(msg || { to: '+18595550142', from: '+15135550100', body: 'hi' }, perCall);
      return { sent: true };
    } catch (e) { return { sent: false, e }; }
  }
  {
    const c = fakeClient();
    const r = await attempt(c, { nowMs: NIGHT });
    ok('a caller that FORGOT the recipient is still refused at 3am ET', !r.sent && c.sent.length === 0, r.e && r.e.message);
    ok('...as a definite no-send (messagingPaused, 403, code messaging_paused)', r.e && r.e.messagingPaused === true && r.e.status === 403 && r.e.code === 'messaging_paused');
    ok('...naming the reason and when the window opens', r.e && r.e.reason === 'outside_send_window' && r.e.nextOpenMs === T('2026-11-23T13:00:00Z'), r.e && [r.e.reason, iso(r.e.nextOpenMs)]);
  }
  {
    const c = fakeClient();
    const r = await attempt(c, { nowMs: MORNING_PT }, { recipient: { state: 'CA' } });
    ok('a Pacific recipient at 6am PT is refused (per-call recipient)', !r.sent && c.sent.length === 0 && r.e.reason === 'outside_send_window');
    const c2 = fakeClient();
    const r2 = await attempt(c2, { nowMs: NOON_PT }, { recipient: { state: 'CA' } });
    ok('...and sent at noon Pacific', r2.sent && c2.sent.length === 1, r2.e && r2.e.message);
    const c3 = fakeClient();
    const r3 = await attempt(c3, { nowMs: NOON_PT, recipient: { state: 'OH' } });
    ok('a client-wide recipient (opts.recipient) is honoured too', r3.sent && c3.sent.length === 1);
  }
  {
    const c = fakeClient();
    const r = await attempt(c, { nowMs: NIGHT, companyProfile: { timezone: 'America/Los_Angeles' } });
    ok('no recipient location → the company zone decides (midnight PT: refused)', !r.sent && r.e.reason === 'outside_send_window');
    const db = fakeDb({ 'companyProfile/co1': { timezone: 'Pacific/Honolulu' } });
    MC._resetCache();
    const c2 = fakeClient();
    let sent2 = true;
    try { await MC.guardTwilio(db, c2, { nowMs: T('2026-11-24T03:00:00Z'), companyId: 'co1' }).messages.create({ to: '+18085550100', body: 'x' }); }
    catch (e) { sent2 = false; }
    ok('opts.companyId reads companyProfile/{id}.timezone (5pm Honolulu: sent)', sent2 && c2.sent.length === 1);
  }
  for (const marker of ['exempt:internal', 'exempt:transactional', 'exempt:manual']) {
    const c = fakeClient();
    const r = await attempt(c, { nowMs: NIGHT, sendWindow: marker });
    ok(marker + ' passes the central window (its caller keeps its own rules)', r.sent && c.sent.length === 1, r.e && r.e.message);
  }
  {
    const c = fakeClient();
    const r = await attempt(c, { nowMs: NIGHT, sendWindow: true });
    ok('a truthy non-marker is NOT an exemption', !r.sent && c.sent.length === 0);
  }
  {
    // The kill switch still comes first: a paused channel answers its own reason.
    MC._resetCache();
    const c = fakeClient();
    const db = fakeDb({ 'messaging_controls/global': { customerSendsEnabled: false, smsEnabled: true } });
    let reason = null;
    try { await MC.guardTwilio(db, c, { nowMs: NIGHT }).messages.create({ to: '+18595550142', body: 'x' }); } catch (e) { reason = e.reason; }
    ok('a paused switch still answers customer_sends_off (not the window)', reason === 'customer_sends_off', reason);
  }
  {
    // The central check rides the shared clock seam when no nowMs is passed.
    const Outbox = require(path.join(FN, 'sms-outbox-guard.js'));
    const saved = Outbox.nowMs;
    Outbox.nowMs = () => NIGHT;
    const c = fakeClient();
    const r = await attempt(c, {});
    ok('no nowMs → the sms-outbox-guard clock seam (pinned to 3am: refused)', !r.sent && r.e && r.e.reason === 'outside_send_window');
    Outbox.nowMs = () => T('2026-11-23T17:00:00Z');
    const c2 = fakeClient();
    const r2 = await attempt(c2, {});
    ok('...(pinned to noon ET: sent)', r2.sent && c2.sent.length === 1);
    Outbox.nowMs = saved;
  }

  console.log('\nC. leadFollowUpSweep defers, never drops');
  let stubs = {};
  const realLoad = Module._load;
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.apply(this, arguments);
  };
  function followupWorld(card) {
    const docs = {};
    const sends = [];
    const ref = (p) => ({
      id: p.split('/').pop(),
      async get() { return { exists: !!docs[p], data: () => docs[p] }; },
      async update(d) { docs[p] = Object.assign({}, docs[p] || {}, d); },
    });
    const coll = (name) => {
      const q = {
        where: () => q, limit: () => q,
        async get() {
          let rows;
          if (name === 'leads') rows = [{ id: 'crm-1', data: () => Object.assign({ stage: 'new', status: 'new' }, card || {}) }];
          else rows = Object.keys(docs).filter((k) => k.startsWith(name + '/'))
            .map((k) => ({ id: k.split('/')[1], data: () => Object.assign({}, docs[k]), ref: ref(k) }));
          return { empty: rows.length === 0, docs: rows, size: rows.length };
        },
        doc: (id) => ref(name + '/' + id),
      };
      return q;
    };
    const db = { collection: coll, doc: ref };
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-admin/firestore': {
        getFirestore: () => db,
        FieldValue: { serverTimestamp: () => '__ts__' },
        Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) },
      },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k-' + n }) },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h, __opts: o }) },
      './lead-bridge-logic': { isFollowUpEvent: () => false, isStartedEstimate: () => false },
      './email-suppression': {
        READ_TIMEOUT_MS: 1000,
        gateCommercialEmail: async () => ({ suppressed: false, headers: {}, tags: [] }),
        applyFooter: (u, html, text) => ({ html, text }),
      },
      resend: { Resend: function () { this.emails = { send: async (m) => { sends.push(m); return { data: { id: 're_' + sends.length }, error: null }; } }; } },
    };
    delete process.env.LEAD_FOLLOWUP_ENABLED;
    const p = require.resolve(path.join(FN, 'lead-followup.js'));
    delete require.cache[p];
    const mod = require(p);
    return { mod, docs, sends };
  }
  const savedNow = SW.nowMs;
  try {
    const w = followupWorld({ state: 'OH', zip: '45202' });
    const at3 = T('2026-11-23T08:00:00Z'); // 03:00 ET
    w.docs['estimate_leads/p1'] = { email: 'homeowner@example.com', firstName: 'Pat', createdAt: { toMillis: () => at3 - 30 * 3600e3 } };
    SW.nowMs = () => at3;
    await w.mod.leadFollowUpSweep.__handler({});
    ok('3am ET: no follow-up email is sent', w.sends.length === 0, w.sends.length);
    ok('...and the lead is NOT claimed (no followUpEmailStatus): it is still owed', w.docs['estimate_leads/p1'].followUpEmailStatus === undefined, w.docs['estimate_leads/p1']);
    SW.nowMs = () => T('2026-11-23T13:00:00Z'); // 08:00 ET, the lead is 35h old: still inside 20-48h
    await w.mod.leadFollowUpSweep.__handler({});
    ok('8am ET: the same lead gets its one email', w.sends.length === 1 && w.docs['estimate_leads/p1'].followUpEmailStatus === 'sent', w.docs['estimate_leads/p1']);
    await w.mod.leadFollowUpSweep.__handler({});
    ok('...exactly once', w.sends.length === 1);
  } catch (e) { ok('lead follow-up world ran', false, e && e.stack); }
  try {
    const w = followupWorld({ address: '9 Pine Ave, Sacramento, CA 95814' });
    const at = T('2026-11-23T14:00:00Z'); // 09:00 ET / 06:00 PT
    w.docs['estimate_leads/p2'] = { email: 'west@example.com', firstName: 'Lee', createdAt: { toMillis: () => at - 24 * 3600e3 } };
    SW.nowMs = () => at;
    await w.mod.leadFollowUpSweep.__handler({});
    ok('a Pacific homeowner (CRM card address) gets nothing at 6am PT', w.sends.length === 0 && w.docs['estimate_leads/p2'].followUpEmailStatus === undefined);
    SW.nowMs = () => T('2026-11-23T16:00:00Z'); // 08:00 PT
    await w.mod.leadFollowUpSweep.__handler({});
    ok('...and gets it at 8am Pacific', w.sends.length === 1, w.sends.length);
  } catch (e) { ok('Pacific follow-up world ran', false, e && e.stack); }
  SW.nowMs = savedNow;

  // ── D. the other automated customer paths defer BEFORE their one-shot claim ──
  console.log('\nD. funnel recovery, e-sign reminders, review asks, storm and missed-call texts');
  try {
    // runAbandonRecovery: the real module, deps stubbed; the window is the real one.
    const docs = {};
    const sends = [];
    const ref = (p) => ({
      id: p.split('/').pop(),
      async get() { return { exists: !!docs[p], data: () => docs[p] }; },
      async update(d) { docs[p] = Object.assign({}, docs[p] || {}, d); },
    });
    const funnelQuery = () => {
      let status;
      const q = {
        where: (f, op, v) => { if (f === 'recoveryEmailStatus') status = v; return q; },
        orderBy: () => q, startAfter: () => q, limit: () => q,
        async get() {
          const rows = Object.keys(docs).filter((k) => k.startsWith('funnel_abandoned/') && (docs[k].recoveryEmailStatus === undefined ? null : docs[k].recoveryEmailStatus) === status)
            .map((k) => ({ id: k.split('/')[1], data: () => Object.assign({}, docs[k]), ref: ref(k) }));
          return { empty: !rows.length, docs: rows, size: rows.length };
        },
      };
      return q;
    };
    const db = { collection: () => funnelQuery(), doc: ref };
    stubs = {
      './messaging-controls': require('./lib/messaging-controls-stub'),
      'firebase-functions/v2/https': { onRequest: (o, h) => h },
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h, __opts: o }) },
      'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => 'k-' + n }) },
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {}, debug() {} } },
      'firebase-admin/firestore': {
        getFirestore: () => db,
        FieldValue: { serverTimestamp: () => '__ts__' },
        Timestamp: { fromDate: (d) => ({ toMillis: () => d.getTime() }), fromMillis: (ms) => ({ toMillis: () => ms }) },
      },
      './integrations/upstash-ratelimit': { httpRateLimit: async () => true, enforceRateLimit: async () => {} },
      './resend-guard': { resendRejected: () => false, resendErrorMessage: () => 'rejected' },
      './email-suppression': {
        READ_TIMEOUT_MS: 1000, maskEmail: () => 'x***',
        gateCommercialEmail: async () => ({ suppressed: false, headers: {}, tags: [] }),
        applyFooter: (u, html, text) => ({ html, text }),
      },
      './alert-recipients': { capRecipients: async (k, list) => ({ allowed: list }) },
      resend: { Resend: function () { this.emails = { send: async (m) => { sends.push(m); return { data: { id: 're_' + sends.length }, error: null }; } }; } },
    };
    process.env.FUNNEL_RECOVERY_ENABLED = 'true';
    process.env.RESEND_API_KEY = 'k-test';
    const p = require.resolve(path.join(FN, 'funnel-recovery.js'));
    delete require.cache[p];
    const mod = require(p);
    const at = T('2026-11-23T14:00:00Z'); // 09:00 ET / 06:00 PT
    docs['funnel_abandoned/f1'] = { email: 'visitor@example.com', firstName: 'Sam', address: '9 Pine Ave, Sacramento, CA 95814', recoveryEmailStatus: null, createdAt: { toMillis: () => at - 3 * 3600e3 } };
    SW.nowMs = () => at;
    await mod.runAbandonRecovery.__handler({});
    ok('funnel recovery: a Pacific visitor gets nothing at 6am PT, and the record is NOT claimed', sends.length === 0 && docs['funnel_abandoned/f1'].recoveryEmailStatus === null, docs['funnel_abandoned/f1']);
    SW.nowMs = () => T('2026-11-23T16:00:00Z'); // 08:00 PT
    await mod.runAbandonRecovery.__handler({});
    ok('...and the recovery email goes at 8am Pacific, once', sends.length === 1 && docs['funnel_abandoned/f1'].recoveryEmailStatus === 'sent', [sends.length, docs['funnel_abandoned/f1'].recoveryEmailStatus]);
    ok('runAbandonRecovery runs on a named time zone', mod.runAbandonRecovery.__opts.timeZone === 'America/New_York');
  } catch (e) { ok('funnel recovery world ran', false, e && e.stack); }
  finally { delete process.env.FUNNEL_RECOVERY_ENABLED; delete process.env.RESEND_API_KEY; SW.nowMs = savedNow; }

  try {
    // esign reminders: runSweep with a fake db; the signer's lead says Pacific.
    const docs = {
      'esign_envelopes/E1': { status: 'sent', leadId: 'L1', companyId: 'co1', signerEmail: 'signer@example.com', signerName: 'Pat', reminders: { enabled: true, count: 0 }, remindNextAt: 0 },
      'esign_tokens/T1': { envelopeId: 'E1', status: 'pending', signerId: 'signer', expiresAt: { toMillis: () => Infinity } },
      'leads/L1': { state: 'CA', companyId: 'co1' },
    };
    const mails = [];
    const ref = (p) => ({ id: p.split('/').pop(), async get() { return { exists: !!docs[p], data: () => docs[p] }; }, async set(d) { docs[p] = Object.assign({}, docs[p] || {}, d); } });
    const db = {
      doc: ref,
      collection: (name) => {
        const conds = [];
        const q = {
          where: (f, op, v) => { conds.push([f, op, v]); return q; }, limit: () => q,
          async get() {
            const rows = Object.keys(docs).filter((k) => k.startsWith(name + '/')).filter((k) => conds.every(([f, op, v]) => (op === '<=' ? docs[k][f] != null && docs[k][f] <= v : docs[k][f] === v)))
              .map((k) => ({ id: k.split('/')[1], data: () => docs[k], ref: ref(k) }));
            return { docs: rows, forEach: (fn) => rows.forEach(fn) };
          },
        };
        return q;
      },
    };
    stubs = {
      'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
      'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => '__ts__', delete: () => undefined, arrayUnion: (x) => [x] } },
      './integrations/heartbeat': { onSchedule: (o, h) => ({ __handler: h, __opts: o }) },
      './esign-io': { SIGN_URL_BASE: 'https://x/sign/', emailLink: async (env, signer, url) => { mails.push(url); return { emailed: true }; }, syncEstimate: async () => {}, notifyRep: async () => {} },
    };
    const p = require.resolve(path.join(FN, 'esign-reminders.js'));
    delete require.cache[p];
    const R = require(p);
    const early = T('2026-11-23T14:00:00Z'); // 06:00 PT
    docs['esign_envelopes/E1'].remindNextAt = early - 1;
    const r1 = await R._runSweep(db, early);
    ok('e-sign reminder: a Pacific signer is not emailed at 6am PT; no reminder slot used', r1.deferred === 1 && mails.length === 0 && docs['esign_envelopes/E1'].reminders.count === 0, [r1, mails.length]);
    // remindNextAt moves to the window's opening, so deferred envelopes leave the
    // 200-row due page instead of filling it every hour (review 2026-11-25).
    ok('...remindNextAt moves to 8am Pacific (out of the due page until then)', docs['esign_envelopes/E1'].remindNextAt === T('2026-11-23T16:00:00Z'), iso(docs['esign_envelopes/E1'].remindNextAt));
    const r1b = await R._runSweep(db, T('2026-11-23T15:00:00Z')); // 07:00 PT: not due yet
    ok('...an hour later it is not even read (not due)', r1b.deferred === 0 && r1b.reminded === 0 && mails.length === 0, r1b);
    const r2 = await R._runSweep(db, T('2026-11-23T17:00:00Z')); // 09:00 PT
    ok('...and the next hourly run inside their window sends it', r2.reminded === 1 && mails.length === 1 && docs['esign_envelopes/E1'].reminders.count === 1, [r2, mails.length]);
    // A solo owner's envelope (companyId null) whose lead is gone: the owner's
    // own company zone decides, not Eastern (review 2026-11-25).
    docs['esign_envelopes/E2'] = { status: 'sent', leadId: 'GONE', companyId: null, ownerUid: 'solo1', signerEmail: 's2@example.com', signerName: 'Lee', reminders: { enabled: true, count: 0 }, remindNextAt: 0 };
    docs['esign_tokens/T2'] = { envelopeId: 'E2', status: 'pending', signerId: 'signer', expiresAt: { toMillis: () => Infinity } };
    docs['companyProfile/solo1'] = { timezone: 'America/Los_Angeles' };
    const at13 = T('2026-11-23T13:00:00Z'); // 08:00 ET / 05:00 PT
    docs['esign_envelopes/E2'].remindNextAt = at13 - 1;
    const before = mails.length;
    const r3 = await R._runSweep(db, at13);
    ok('e-sign: companyId null + missing lead → the ownerUid\'s Pacific zone (5am PT: deferred)', r3.deferred === 1 && mails.length === before, [r3, mails.length - before]);
  } catch (e) { ok('e-sign world ran', false, e && e.stack); }
  stubs = {};

  try {
    // review asks: askOne holds the window itself, before planning or claiming anything.
    const AUTO = require(path.join(FN, 'review-ask-auto.js'))._test;
    const touched = [];
    const spyDb = new Proxy({}, { get: (t, k) => () => { touched.push(String(k)); throw new Error('db touched: ' + String(k)); } });
    const entry = { id: 'L9', jobId: 'j1', email: 'cust@example.com', state: 'OH', receivedMs: NIGHT - 86400e3 };
    const r = await AUTO.askOne(spyDb, entry, 'owner', { env: {}, nowMs: NIGHT, logger: { info() {}, warn() {}, error() {} } });
    ok('review ask at 3am ET: outside_send_window, with no read, claim or send', r.sent === false && r.reason === 'outside_send_window' && touched.length === 0, [r, touched]);
  } catch (e) { ok('review ask ran', false, e && e.stack); }

  try {
    // storm texts: 8:30pm ET clears the TCPA 9pm check but not the customer window.
    const SG = require(path.join(FN, 'storm-sms-guard.js'));
    const late = T('2026-11-24T01:30:00Z'); // 20:30 EST
    let sendCalls = 0;
    const touched = [];
    const spyDb = new Proxy({}, { get: (t, k) => () => { touched.push(String(k)); throw new Error('db touched'); } });
    const r = await SG.sendGuardedStormText({ db: spyDb, subscriberRef: { id: 's1' }, phone: '+15135550100', source: 'test', eventKey: 'e1', companyId: 'co1',
      recipient: { state: 'OH', zip: '45202' }, nowMs: late, send: async () => { sendCalls++; return { sid: 'x' }; }, logger: { info() {}, warn() {}, error() {} } });
    ok('storm text at 8:30pm ET: quiet_hours, nothing claimed or sent', r.status === 'quiet_hours' && sendCalls === 0 && touched.length === 0, [r, touched]);
    const r2 = await SG.sendGuardedStormText({ db: spyDb, subscriberRef: { id: 's1' }, phone: '+15135550100', source: 'test', eventKey: 'e1', companyId: 'co1',
      recipient: { state: 'OH', zip: '45202' }, nowMs: T('2026-11-23T17:00:00Z'), send: async () => { sendCalls++; return { sid: 'x' }; }, logger: { info() {}, warn() {}, error() {} } });
    ok('...control: at noon ET it gets past the window (to the opt-out read)', r2.status !== 'quiet_hours' && touched.length > 0, [r2, touched]);
  } catch (e) { ok('storm text ran', false, e && e.stack); }
  {
    const MR = require(path.join(FN, 'missed-call-reply-logic.js'));
    const lead = { userId: 'O', companyId: 'O', phone: '(513) 555-0100', tcpaConsent: true, tcpaConsentText: 'tcpa-v2-2026-10-05', state: 'OH' };
    // a missed call as call-watch-logic.js isMissedCall defines it: inbound, short, not a text
    const plan = (t) => MR.planAutoText({ env: { MISSED_CALL_AUTOTEXT_ENABLED: 'true' }, lead, nowMs: t,
      call: { id: 'c1', leadId: 'L1', phoneDigits: '5135550100', direction: 'inbound', status: 'short', startedAtMs: t - 60000 } });
    const noon = plan(T('2026-11-23T17:00:00Z'));
    ok('missed-call auto-text: control, a consented missed call at noon ET sends', noon.send === true, noon);
    const late = plan(T('2026-11-24T01:30:00Z')); // 20:30 EST
    ok('...8:30pm ET is quiet_hours (inside TCPA 9pm, outside the 8pm window)', late.send === false && late.reason === 'quiet_hours', late);
  }
  try {
    // storm confirm: the same pre-claim check, through sendPendingConfirmations.
    const SC = require(path.join(FN, 'storm-confirm.js'));
    const late = T('2026-11-24T01:30:00Z'); // 20:30 EST
    const touched = [];
    let sendCalls = 0;
    const subDocs = [{ id: 'sub1', data: () => ({ tcpaConsent: true, phone: '5135550100', zip: '45202', state: 'OH', createdAt: { toMillis: () => late - 3600e3 } }),
      ref: { id: 'sub1', update: async () => { touched.push('update'); } } }];
    const q = { where: () => q, orderBy: () => q, limit: () => q, startAfter: () => q, async get() { return { empty: false, docs: subDocs, size: 1, forEach: (fn) => subDocs.forEach(fn) }; } };
    const db = { collection: () => q, doc: () => ({ async get() { return { exists: false }; } }), runTransaction: async () => { touched.push('tx'); throw new Error('tx'); } };
    const out = await SC.sendPendingConfirmations({ db, nowMs: late, maxPerRun: 5, send: async () => { sendCalls++; }, logger: { info() {}, warn() {}, error() {} }, serverTimestamp: () => '__ts__' });
    ok('storm confirm at 8:30pm ET: quiet_hours before any claim, nothing sent', sendCalls === 0 && touched.length === 0 && out.skipped && out.skipped.quiet_hours === 1, [out, touched]);
    const out2 = await SC.sendPendingConfirmations({ db, nowMs: T('2026-11-23T17:00:00Z'), maxPerRun: 5, send: async () => { sendCalls++; }, logger: { info() {}, warn() {}, error() {} }, serverTimestamp: () => '__ts__' });
    ok('...control: at noon ET the same subscriber gets past the window', !(out2.skipped && out2.skipped.quiet_hours), out2);
  } catch (e) { ok('storm confirm ran', false, e && e.stack); }

  // ── F. the pre-check and guardTwilio give ONE answer (review 2026-11-25) ──
  // A path that checks the window before its one-time claim must hand the same
  // instant and company zone to guardTwilio, or a run that crosses 20:00 (or a
  // lead with no location under a non-Eastern company) spends the claim and is
  // then refused centrally: a lost text, not a deferral.
  console.log('\nF. the pre-claim check and the central check agree');
  function claimDb(seed) {
    const store = new Map(Object.entries(Object.assign({}, OPEN_CONTROLS, seed || {})));
    const exists = () => { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; return e; };
    const ref = (p) => ({
      id: p.split('/').pop(), path: p,
      async get() { const v = store.get(p); return { exists: v !== undefined, id: p.split('/').pop(), data: () => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) }; },
      async set(v, o) { store.set(p, o && o.merge ? Object.assign({}, store.get(p) || {}, v) : v); },
      async create(v) { if (store.has(p)) throw exists(); store.set(p, v); },
      async update(v) { if (!store.has(p)) throw new Error('missing'); store.set(p, Object.assign({}, store.get(p), v)); },
      collection: (c) => coll(p + '/' + c),
    });
    const query = (c, filters, lim) => ({
      where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim),
      orderBy: () => query(c, filters, lim),
      limit: (n) => query(c, filters, n),
      async get() {
        const docs = [];
        for (const [k, v] of store) {
          if (k.indexOf(c + '/') !== 0 || k.slice(c.length + 1).indexOf('/') !== -1) continue;
          if (!filters.every(([f, op, x]) => (op === '==' ? v[f] === x : op === '>=' ? v[f] >= x : true))) continue;
          docs.push({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(v)) });
        }
        return { docs: lim ? docs.slice(0, lim) : docs, empty: !docs.length, size: docs.length };
      },
    });
    const coll = (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0));
    return {
      store, doc: ref, collection: coll,
      async runTransaction(fn) {
        return fn({
          get: (r) => r.get(),
          set: (r, v, o) => { r.set(v, o); },
          create: (r, v) => { if (store.has(r.path)) throw exists(); store.set(r.path, v); },
          update: (r, v) => { store.set(r.path, Object.assign({}, store.get(r.path) || {}, v)); },
        });
      },
    };
  }
  const Outbox = require(path.join(FN, 'sms-outbox-guard.js'));
  const savedClock = Outbox.nowMs;
  const EDGE_BEFORE = T('2026-11-24T00:59:59Z'); // 19:59:59 EST: the run's instant, inside
  const EDGE_AFTER = T('2026-11-24T01:00:01Z');  // 20:00:01 EST: when the text reaches guardTwilio
  const AT = require(path.join(FN, 'missed-call-autotext.js'));
  const consentedLead = { userId: 'O', companyId: 'O', phone: '(513) 555-0100', tcpaConsent: true, tcpaConsentText: 'tcpa-v2-2026-10-05' };
  const missedCall = (t) => ({ id: 'c-edge', leadId: 'L1', phoneDigits: '5135550100', direction: 'inbound', status: 'short', startedAtMs: t - 60000 });
  // call-center.js sendAutoText's shape: what the plan hands send() goes on to guardTwilio as ctx.
  const ccSend = (db, client) => (m) => MC.guardTwilio(db, client).messages.create({ to: m.to, body: m.body }, { recipient: m.recipient, companyProfile: m.companyProfile, nowMs: m.nowMs });
  const quietLog = { info() {}, warn() {}, error() {} };
  try {
    MC._resetCache();
    Outbox.nowMs = () => EDGE_AFTER;
    const db = claimDb({ 'leads/L1': Object.assign({ state: 'OH' }, consentedLead), 'sms_settings/O': { registered: true } });
    const client = fakeClient();
    const r = await AT.maybeAutoTextMissedCall({ db, call: missedCall(EDGE_BEFORE), nowMs: EDGE_BEFORE, env: { MISSED_CALL_AUTOTEXT_ENABLED: 'true' }, send: ccSend(db, client), tenantKey: 'O', logger: quietLog });
    ok('missed-call text claimed at 19:59:59 ET is SENT when guardTwilio runs at 20:00:01 (one instant, no lost text)', r.sent === true && client.sent.length === 1, r);
  } catch (e) { ok('missed-call edge world ran', false, e && e.stack); }
  finally { Outbox.nowMs = savedClock; }
  try {
    // A lead with no location under a Central-time company: 8:30 ET is 7:30 CT.
    const seed = { 'leads/L1': consentedLead, 'sms_settings/O': { registered: true }, 'companyProfile/O': { timezone: 'America/Chicago' } };
    const t = T('2026-11-23T13:30:00Z');
    MC._resetCache();
    Outbox.nowMs = () => t;
    const db = claimDb(seed);
    const client = fakeClient();
    const r = await AT.maybeAutoTextMissedCall({ db, call: missedCall(t), nowMs: t, env: { MISSED_CALL_AUTOTEXT_ENABLED: 'true' }, send: ccSend(db, client), tenantKey: 'O', logger: quietLog });
    ok('no-location lead, Central company, 8:30 ET: the PRE-check uses the company zone (quiet_hours, nothing claimed)',
      r.reason === 'quiet_hours' && client.sent.length === 0 && !db.store.has('missed_call_autotext/O__5135550100'), r);
    const t2 = T('2026-11-23T14:30:00Z'); // 8:30 CT
    MC._resetCache();
    Outbox.nowMs = () => t2;
    const db2 = claimDb(seed);
    const client2 = fakeClient();
    const r2 = await AT.maybeAutoTextMissedCall({ db: db2, call: missedCall(t2), nowMs: t2, env: { MISSED_CALL_AUTOTEXT_ENABLED: 'true' }, send: ccSend(db2, client2), tenantKey: 'O', logger: quietLog });
    ok('...control: at 8:30 CT the same lead is texted once', r2.sent === true && client2.sent.length === 1, r2);
  } catch (e) { ok('missed-call zone world ran', false, e && e.stack); }
  finally { Outbox.nowMs = savedClock; }
  try {
    // Storm text: storm-watch.js / sms-functions.js forward send()'s argument to guardTwilio.
    MC._resetCache();
    Outbox.nowMs = () => EDGE_AFTER;
    const SG = require(path.join(FN, 'storm-sms-guard.js'));
    const db = claimDb({ 'storm_alert_subscribers/s1': { active: true, tcpaConsent: true, smsConfirmedAt: 1, phone: '+15135550100', zip: '45202' } });
    const client = fakeClient();
    const recipient = { zip: '45202', state: 'OH' };
    const r = await SG.sendGuardedStormText({ db, subscriberRef: db.doc('storm_alert_subscribers/s1'), claimRef: db.doc('storm_alerts_sent/a1__s1'), phone: '+15135550100',
      source: 'test', eventKey: 'a1', companyId: 'O', recipient, nowMs: EDGE_BEFORE, serverTimestamp: () => EDGE_BEFORE, logger: quietLog,
      send: (w) => MC.guardTwilio(db, client).messages.create({ to: '+15135550100', body: 'storm' }, Object.assign({ recipient }, w)) });
    ok('storm text claimed at 19:59:59 ET is SENT at 20:00:01 (the guard hands send() its instant)', r.status === 'sent' && client.sent.length === 1, r.status + ' ' + (r.error && r.error.message));
  } catch (e) { ok('storm edge world ran', false, e && e.stack); }
  finally { Outbox.nowMs = savedClock; }
  try {
    // Storm confirm: send(to, body, ctx) carries the run's instant and zone.
    const SC = require(path.join(FN, 'storm-confirm.js'));
    const seen = [];
    const t = T('2026-11-23T17:00:00Z');
    const subDocs = [{ id: 'sub1', data: () => ({ tcpaConsent: true, phone: '5135550100', zip: '45202', state: 'OH', createdAt: { toMillis: () => t - 3600e3 } }),
      ref: { id: 'sub1', update: async () => {} } }];
    const db = claimDb({});
    const baseDoc = db.doc;
    db.collection = (name) => {
      const q = { where: () => q, orderBy: () => q, limit: () => q, startAfter: () => q, doc: (id) => baseDoc(name + '/' + id),
        async get() { return { empty: false, docs: subDocs, size: 1, forEach: (fn) => subDocs.forEach(fn) }; } };
      return q;
    };
    db.runTransaction = async () => true;
    await SC.sendPendingConfirmations({ db, nowMs: t, maxPerRun: 5, send: async (to, body, ctx) => { seen.push(ctx); }, logger: quietLog, serverTimestamp: () => '__ts__' });
    ok('storm confirm hands the run\'s nowMs and company zone to send()', seen.length === 1 && !!seen[0] && seen[0].nowMs === t && 'companyProfile' in seen[0] && !!seen[0].recipient, seen);
  } catch (e) { ok('storm confirm ctx world ran', false, e && e.stack); }

  console.log('\nE. the senders that are exempt say so (the marker is the only way past the window)');
  {
    const lead = read('lead-alert.js');
    ok('lead-alert: the tenant owner\'s alert text is exempt:internal', /guardTwilio\(getFirestore\(\), rawClient, \{ sendWindow: 'exempt:internal' \}\)/.test(lead));
    ok('lead-alert: the instant request ack text is exempt:transactional', /\{ sendWindow: 'exempt:transactional' \}\)/.test(lead));
    ok('sms-functions: the three rep sends are exempt:manual (sendSMS, D2D, approved AI reply)', (read('sms-functions.js').match(/sendWindow: 'exempt:manual'/g) || []).length === 3);
    ok('call-center: the missed-call auto-text passes the lead to the central window', /messages\.create\(\{ to, from, body \}, \{ recipient/.test(read('call-center.js')));
  }
  Module._load = realLoad;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
