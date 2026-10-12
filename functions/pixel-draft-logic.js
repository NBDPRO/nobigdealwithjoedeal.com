'use strict';
/**
 * pixel-draft-logic.js — the pure half of fileLeadTextDraft (Pixel World
 * "DRAFT TEXT", 2026-10-11). No Firestore, no Firebase: a fixed list of
 * template keys and the function that turns (template key, lead, company
 * names) into the text of ONE draft, or a refusal.
 *
 * The client sends a template KEY. It never sends words. Every body is built
 * here from the fixed lines below plus two merge fields (the lead's first
 * name, the company's name); buildTextDraft (agent-mcp-logic.js, the same
 * builder every bot draft and Storm Mode use) adds the STOP line and checks
 * the company name and length, then claimWordingProblem (the Kentucky wording
 * gate) runs on the finished text.
 *
 * What a template may never say (tests/pixel-draft-2026-10-11.test.js proves
 * every line, and that the proof can fail): the insurance claim, an
 * adjuster, coverage, a deductible, advance / up-front payment, a waiver or
 * rebate, an assignment of benefits, a guarantee or a price. These are the
 * Kentucky insurance-job rules (no "we handle / negotiate the claim", no
 * AOB, no advance pay, no more than $100 to the insured) applied to EVERY
 * lead, not only to leads that look like Kentucky insurance jobs, because a
 * template that is safe everywhere needs no per-lead branching to stay safe.
 */
const L = require('./agent-mcp-logic');

// key -> { label (what the game shows), line (the sentence after "Hi X, this
// is Co."), reason (shown to the owner in the Agent inbox, never the customer) }
const TEMPLATES = Object.freeze({
  followup: Object.freeze({
    label: 'Follow up',
    line: 'I wanted to follow up on your roof. Do you have any questions, or is there a good time for us to stop by? Happy to help whenever you are ready.',
    reason: 'Pixel World: a friendly follow-up, drafted from the town.',
  }),
  estimate_check_in: Object.freeze({
    label: 'Estimate check-in',
    line: 'I wanted to check in on the estimate we sent over. Do you have any questions about it? Happy to go over any part of it with you.',
    reason: 'Pixel World: a check-in on a sent estimate, drafted from the town.',
  }),
  appointment_reminder: Object.freeze({
    label: 'Appointment reminder',
    line: 'This is a quick reminder about your upcoming appointment with us. If the time no longer works, just reply and we will find another.',
    reason: 'Pixel World: an appointment reminder, drafted from the town. Check the date with the customer before sending.',
  }),
  thanks_after_job: Object.freeze({
    label: 'Thanks after the job',
    line: 'Thank you for trusting us with your project. If you have any questions about the work, just reply here.',
    reason: 'Pixel World: a thank-you after a finished job, drafted from the town.',
  }),
});
const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATES));

/** The words no template line may contain (see the header). Tested, not run on a finished body. */
const FORBIDDEN_IN_TEMPLATE = /\$|\b(claims?|insur\w*|adjusters?|coverage|covered|deductibles?|advance|up[- ]?front|deposits?|waiv\w*|rebates?|assign\w*|aob|guarantee\w*|free|approved?|negotiat\w*|handle|prices?|cost|discount)\b/i;

/** Is this one of the fixed template keys? (own keys only: never "__proto__" or "constructor") */
function isTemplateKey(k) {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, k);
}

/** The lead's first name, letters only, for "Hi Maria". Never throws. */
function firstNameOf(lead) {
  const raw = String((lead && lead.firstName) || '');
  return raw.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/[^A-Za-zÀ-ɏ' -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * @param {string} key a TEMPLATE_KEYS entry
 * @param {object} lead stored lead (only firstName is read)
 * @param {string[]} names L.companyNames(profile, isNbd)
 * @returns {{body:string, reason:string}|{error:string, code:string}}
 */
function buildLeadTextDraft(key, lead, names) {
  if (!isTemplateKey(key)) return { error: 'Unknown message.', code: 'unknown_template' };
  const t = TEMPLATES[key];
  const company = (names || []).filter(Boolean)[0] || '';
  if (!company) return { error: 'The company has no name set on its profile, so a text cannot say who it is from.', code: 'no_company_name' };
  const first = firstNameOf(lead);
  const body = (first ? 'Hi ' + first + ', this is ' : 'Hi, this is ') + company + '. ' + t.line;
  const d = L.buildTextDraft({ body, reason: t.reason }, names);
  if (d.error) return { error: d.error, code: 'text_refused' };
  const wording = L.claimWordingProblem(d.body);
  if (wording) return { error: wording, code: 'claim_wording' };
  return { body: d.body, reason: d.reason };
}

module.exports = { TEMPLATES, TEMPLATE_KEYS, FORBIDDEN_IN_TEMPLATE, isTemplateKey, firstNameOf, buildLeadTextDraft };
