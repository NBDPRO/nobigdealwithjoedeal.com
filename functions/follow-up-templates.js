'use strict';
/**
 * follow-up-templates.js — the three Follow-up board wordings (2026-11-03,
 * flag followUpBoard). PURE DATA. No Firestore, no send path.
 *
 * Extra template keys for the EXISTING fileLeadTextDraft callable
 * (pixel-draft.js), which files one draft_text into the Agent inbox. Jo edits it
 * and sends it himself; the client sends a KEY, never words. The business name
 * and the STOP line are added by buildTextDraft. Same banned-word rules as the
 * other templates (pixel-draft-logic.js FORBIDDEN_IN_TEMPLATE; tested).
 *
 *   fu_reply_ack     a customer wrote and nobody answered. Neutral on purpose: it
 *                    never answers a question for Jo.
 *   fu_promise_est   Jo promised an estimate and it has not gone out.
 *   fu_new_checkin   a lead stuck at New. Closest to marketing: counsel should
 *                    read it before the flag goes on (design note, risks).
 */
const TEMPLATES = Object.freeze({
  fu_reply_ack: Object.freeze({
    label: 'Follow-up: reply to a message',
    line: 'Thanks for your message. I saw it and will get back to you today.',
    reason: 'Follow-up board: a customer wrote and has no answer yet. Edit it, then send it from your phone.',
  }),
  fu_promise_est: Object.freeze({
    label: 'Follow-up: promised estimate',
    line: 'I have not forgotten your roof estimate. I am finishing it and will get it to you shortly.',
    reason: 'Follow-up board: you promised an estimate that has not gone out. Edit it, then send it from your phone.',
  }),
  fu_new_checkin: Object.freeze({
    label: 'Follow-up: check-in on a new lead',
    line: 'I wanted to see if you still need help with your roof. Reply whenever works for you.',
    reason: 'Follow-up board: a new lead nobody has contacted. Edit it, then send it from your phone.',
  }),
});
const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATES));

module.exports = { TEMPLATES, TEMPLATE_KEYS };
