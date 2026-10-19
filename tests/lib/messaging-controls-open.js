/**
 * tests/lib/messaging-controls-open.js — the messaging_controls docs a TEST
 * seeds so a send path can run. The real default is fail-closed (a missing doc
 * = no customer send), so every test of a sender seeds these; a test of the
 * kill switch itself seeds nothing, or its own.
 */
'use strict';

const ALL_AUTOMATIONS = {
  leadAckSms: true, leadAckEmail: true, leadFollowupEmail: true, reviewAskAutoText: true,
  reviewAskAutoEmail: true, missedCallAutotext: true, stormText: true, stormNwsText: true,
  funnelRecoveryEmail: true, twilioInbound: true, a2pServerTexts: true, stormConfirmText: true, maxPerRun: 50,
};

const OPEN_CONTROLS = {
  'messaging_controls/global': { customerSendsEnabled: true, smsEnabled: true, emailEnabled: true, otpEnabled: true, canary: false },
  'messaging_controls/automations': ALL_AUTOMATIONS,
  'messaging_controls/internal': { ownerPhone: '+18595550100' },
};

module.exports = { OPEN_CONTROLS, ALL_AUTOMATIONS };
