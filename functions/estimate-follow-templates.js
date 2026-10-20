'use strict';
/**
 * estimate-follow-templates.js — the four estimate follow-up cadence wordings
 * (Open Estimates Follow-Up Board, 2026-10-19, flag estimateFollowBoard).
 *
 * PURE DATA. No Firestore, no send path. These are extra template keys for the
 * EXISTING fileLeadTextDraft callable (pixel-draft.js / pixel-draft-logic.js),
 * which files one draft_text into the Agent inbox; Jo edits it and sends it
 * himself from his own phone, where the "sent" action re-checks STOP / Do Not
 * Text / consent / the texting switch / texting hours. The client sends a KEY,
 * never words.
 *
 * Same rules as the Pixel templates (tests/estimate-follow-board-2026-10-19.test.js
 * proves each line and that the proof can fail): nothing about the insurance
 * claim, an adjuster, coverage, a deductible, advance payment, a waiver or
 * rebate, an assignment of benefits, a guarantee, a price or a fake deadline.
 * One wording for every job type so no per-lead branching is needed to stay
 * safe. The business name and the STOP line are added by buildTextDraft.
 *
 * Day = days since the estimate went out (3, 7, 14, 30). The day-30 text is the
 * "closing the file" message; after it the row leaves the board.
 */
const CADENCE_DAYS = Object.freeze([3, 7, 14, 30]);

const TEMPLATES = Object.freeze({
  est_follow_d3: Object.freeze({
    label: 'Estimate follow-up, day 3',
    day: 3,
    line: 'I wanted to make sure your roof estimate came through okay. If you have any questions, I am happy to walk through it with you.',
    reason: 'Estimate follow-up board: day 3 check that the estimate arrived. Edit it, then send it from your phone.',
  }),
  est_follow_d7: Object.freeze({
    label: 'Estimate follow-up, day 7',
    day: 7,
    line: 'I am checking in on your roof estimate. If something did not fit, tell me and I will see what I can change.',
    reason: 'Estimate follow-up board: day 7 check-in. Edit it, then send it from your phone.',
  }),
  est_follow_d14: Object.freeze({
    label: 'Estimate follow-up, day 14',
    day: 14,
    line: 'I wanted to check in one more time on your roof estimate. If you went another direction, no hard feelings, just let me know either way.',
    reason: 'Estimate follow-up board: day 14 check-in. Edit it, then send it from your phone.',
  }),
  est_follow_d30: Object.freeze({
    label: 'Estimate follow-up, day 30 (closing the file)',
    day: 30,
    line: 'I will close out your estimate for now. If your plans change, just reply and I will pick it back up.',
    reason: 'Estimate follow-up board: day 30, closing the file. Edit it, then send it from your phone.',
  }),
});
const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATES));

module.exports = { CADENCE_DAYS, TEMPLATES, TEMPLATE_KEYS };
