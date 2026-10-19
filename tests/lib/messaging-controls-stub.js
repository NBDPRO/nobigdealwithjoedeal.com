/**
 * tests/lib/messaging-controls-stub.js — an OPEN functions/messaging-controls.js
 * for the older suites that build their own stubbed module graph (Module._load
 * maps) instead of the shared fake-Firestore world. Everything is allowed and
 * nothing is rewritten, so those suites keep testing what they were written to
 * test. The kill switch / canary themselves are tested against the REAL module
 * in tests/messaging-controls-2026-10-19.test.js.
 *
 * Usage in a stubs map: { './messaging-controls': require('./lib/messaging-controls-stub') }
 * (or '../messaging-controls' from a subdirectory).
 */
'use strict';

const open = { allowed: true, reason: null, canary: false, message: null };

module.exports = {
  REFUSAL: {},
  DEFAULT_MAX_PER_RUN: 5,
  MAX_AUTOMATION_AGE_DAYS: 7,
  AUTOMATION_KEYS: [],
  channelStatus: async () => open,
  guardEmail: async (db, msg) => ({ send: true, msg, reason: null, canary: false }),
  guardSms: async (db, to, body) => ({ send: true, to, body, reason: null, canary: false }),
  guardTwilio: (db, client) => client,
  guardResend: (db, resend) => resend,
  // honours the env flag the caller passes (so a suite's "flag off = dry run" cases still mean what they say)
  automationStatus: async (db, key, channel, envOn) => ({ enabled: envOn === true, reason: envOn === true ? null : 'env_flag_off', maxPerRun: 100000, canary: false }),
  readAutomations: async () => ({ readable: true, exists: true, flags: new Proxy({}, { get: () => true }), maxPerRun: 100000 }),
  a2pServerTextsAllowed: async () => true,
  internalAlertStatus: async () => ({ allowed: true, reason: null, phone: '+18594207382', email: '' }),
  readOwnerContact: async () => ({ readable: true, phone: '+18594207382', email: '', internalAlertsEnabled: true }),
  claimSendOnce: async () => true,
  withinAutomationAge: () => true,
  normPhone: (v) => String(v || ''),
  normEmail: (v) => String(v || ''),
  _resetCache: () => {},
};
