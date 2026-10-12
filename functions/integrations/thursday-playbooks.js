'use strict';
/**
 * integrations/thursday-playbooks.js — Thursday's per-label caller playbooks
 * (2026-10-12). PURE: no Firestore, no clock, no network.
 *
 * Design + the prompt DIFF Jo reviews before anything is switched on:
 * documentation/projects/THURSDAY-LABEL-PLAYBOOKS-2026-10-12.md.
 *
 * What this module does: given the caller's number and what the CRM already
 * knows about it (the contact label, the "let Thursday handle this number"
 * setting, whether a lead owns it, the approved away wording), say WHICH
 * playbook Thursday runs and the plain-string variables the Bland pathway
 * receives. thursdayCallerLookup (thursday.js) is the only caller.
 *
 * Hard rules (each has a test in tests/thursday-playbooks-2026-10-12.test.js):
 *   - DARK: `enabled !== true` returns null, so the lookup response is
 *     byte-for-byte what it was before this module existed.
 *   - A label is a HINT about who usually calls from a number, never proof of
 *     who is speaking. Every playbook still falls back to the normal script.
 *   - `personal` and `spam` never get a first name (minimal disclosure).
 *   - `spam` gets no engagement and no away wording.
 *   - Away wording is the APPROVED text only (away-mode-logic
 *     thursdayAwayContext), bounded, and dropped entirely if it contains the
 *     backup's name, email or number — fail closed; she says the owner is away,
 *     never who covers.
 *   - Inbound only. Nothing here can place a call or send a text.
 */

// label kind (contact-labels-logic.js KINDS) → playbook id
const KIND_TO_PLAYBOOK = {
  customer: 'customer',
  prospect: 'prospect',
  contractor: 'sub',
  sub: 'sub',
  supplier: 'supplier',
  insurance: 'insurance',
  referral: 'referral',
  personal: 'personal',
  spam: 'spam',
  recruiter: 'recruiter',
  other: 'unknown',
};
const PLAYBOOK_IDS = ['customer', 'prospect', 'sub', 'supplier', 'insurance', 'referral', 'personal', 'recruiter', 'spam', 'unknown'];
// No first name is ever returned for these, even when a lead owns the number.
const NO_NAME_PLAYBOOKS = ['personal', 'spam'];
const AWAY_TEXT_MAX = 600;
// Everyday words the approved wording itself uses, which a backup may also be
// called. Skipped for the single-name-part check ONLY (the whole name and the
// email are still caught in any case). Kept to the words the default draft uses.
const COMMON_WORDS = ['will', 'may', 'mark'];

function digits10(v) {
  let d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
  return d.length === 10 ? d : '';
}

function cleanText(s, max) {
  return String(s == null ? '' : s)
    // control, bidi-override and zero-width characters never reach a prompt
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * The approved away wording, or '' when it must not be spoken.
 *   awayContext   thursdayAwayContext(...) result or null
 *   backup        { name, email, phone } — anything that must NOT appear
 */
function safeAwayText(awayContext, backup) {
  if (!awayContext || awayContext.active !== true) return '';
  // One line: a newline in a prompt variable is structure the owner never meant.
  const text = cleanText(String(awayContext.text == null ? '' : awayContext.text).replace(/\s*\n+\s*/g, ' '), AWAY_TEXT_MAX);
  if (!text) return '';
  const hay = text.toLowerCase();
  const b = backup || {};
  // The whole name and the email always count, in any letter case. Each name
  // part of 3+ letters counts too, in any case, EXCEPT the everyday words the
  // approved wording itself uses (COMMON_WORDS): a backup called "Will" must not
  // silence "Jo will call you back"; the whole-name check still catches
  // "Will Smith".
  const full = cleanText(b.name, 120).toLowerCase();
  if (full.length >= 3 && hay.indexOf(full) !== -1) return '';
  const email = cleanText(b.email, 120).toLowerCase();
  if (email && hay.indexOf(email) !== -1) return '';
  const parts = cleanText(b.name, 120).split(/\s+/)
    .map((x) => x.replace(/[^A-Za-z0-9\u00C0-\u024F]/g, ''))
    .filter((x) => x.length >= 3 && COMMON_WORDS.indexOf(x.toLowerCase()) === -1);
  for (const x of parts) {
    // Any letter case (McDonald, SAM, sam). Whole word, so "Sam" is not "Samuel".
    if (new RegExp('\\b' + x + '\\b', 'i').test(text)) return '';
  }
  const bp = digits10(b.phone);
  if (bp && text.replace(/\D/g, '').indexOf(bp) !== -1) return '';
  return text;
}

/**
 * o: {
 *   enabled        THURSDAY_LABEL_PLAYBOOKS_ENABLED === 'true'
 *   from           the caller's number (any format)
 *   label          { kind, policy } | null          contact_labels doc
 *   handled        true when thursday_handled/{digits} exists
 *   leadKnown      buildLookupResponse().known — exactly one lead owns it
 *   awayContext    thursdayAwayContext() | null
 *   backup         { name, email, phone } | null    (to scrub the away text)
 * }
 * Returns null when disabled or the number is unusable, else
 *   { playbook, labelKind, handled, engage, suppressName, awayText, vars }
 */
function resolvePlaybook(o) {
  const x = o || {};
  if (x.enabled !== true) return null;
  const d = digits10(x.from);
  if (!d) return null;
  const label = x.label && typeof x.label === 'object' ? x.label : null;
  const kind = label && Object.prototype.hasOwnProperty.call(KIND_TO_PLAYBOOK, label.kind) ? label.kind : '';
  let playbook;
  if (kind) playbook = KIND_TO_PLAYBOOK[kind];
  else playbook = x.leadKnown === true ? 'customer' : 'unknown';
  const handled = x.handled === true && playbook !== 'spam';
  const engage = playbook !== 'spam';
  const suppressName = NO_NAME_PLAYBOOKS.indexOf(playbook) !== -1;
  const awayText = engage ? safeAwayText(x.awayContext, x.backup) : '';
  return {
    playbook,
    labelKind: kind,
    handled,
    engage,
    suppressName,
    awayText,
    vars: {
      caller_playbook: playbook,
      caller_label_kind: kind,
      caller_handled: handled ? 'true' : 'false',
      caller_away_text: awayText,
    },
  };
}

/**
 * Fold the playbook onto the lookup response thursdayCallerLookup already
 * returns. Widens, never narrows — except the two no-name playbooks, which
 * blank the first name (and its job hint). Disabled (resolved === null) returns
 * the base object untouched.
 */
function widenLookupResponse(base, resolved) {
  if (!resolved) return base;
  const out = Object.assign({}, base);
  if (resolved.suppressName) { out.known = false; out.first_name = ''; out.job_hint = ''; }
  out.playbook = resolved.playbook;
  out.label_kind = resolved.labelKind;
  out.handled = resolved.handled;
  out.away_text = resolved.awayText;
  return out;
}

// ── The text Jo approves (NOT applied anywhere by this repo) ────────────────
// Appended to the agent node prompt in the Bland builder, after the existing
// "REMEMBERING CALLERS" / "RECORDING NOTICE" blocks. Plain strings so the
// design note can print an exact diff and a test can read the same bytes.
const PROMPT_MARK = '# CALLER PLAYBOOKS (label playbooks, 2026-10-12)';
const PROMPT_BLOCK = `

${PROMPT_MARK}
The phone system may tell you what Jo already knows about this number. It is a HINT about who usually calls from it, never proof of who is speaking: a spouse, a borrowed phone or a wrong number can all be on that line. If it does not fit what the caller says, drop it and use the normal call script.

Every call, no matter the playbook, ends with two things: a name (or "no name given") and a number Jo can call back (the number they called from is fine if they say so). Say "I'll make sure Jo gets this." Never promise a time, a price, a crew, a date or an outcome.

If {{caller_away_text}} is not empty, say it word for word in your first reply after the greeting, then carry on with the playbook. Never add anything to it, never say who is covering, and never name anyone other than the owner.

Run the playbook named by {{caller_playbook}}. If it is empty or anything else, use the normal call script.

- customer or prospect: the normal call script. For a customer: what is going on, the address of the job, the best number. Water coming in is urgent: use the emergency tool.
- sub: "Is this about a job?" Take who is calling, which company, which job or address, what they need, and a callback number. Never agree to scheduling, pay or scope, and never give out any customer's name, address or details.
- supplier: take the delivery or order message: company, the job or address if they volunteer it, what changed, when. Never agree to a delivery time or accept a change.
- insurance: you are talking to an adjuster or carrier. Take the claim number, the adjuster's name, the carrier, the property address, a callback number and when they would like to inspect (as a request). Stay neutral: never say whether anything is covered, never describe what Jo does with a claim, and never confirm details about the customer.
- referral: thank them warmly. Take who they sent (name, number). Never talk about any payment or credit.
- personal: short and warm. "I'll let him know you called." Take a message if they want to leave one. No intake questions, no address, no name guessing.
- recruiter: someone asking for work. Take name, number and trade. "Jo will reach out if there is an opening." Never discuss pay.
- spam: say "Thanks, we're not interested. Goodbye." and use the hang-up tool. Do not collect anything and do not answer questions.

If {{caller_handled}} is "true", Jo has asked you to take these calls fully. After the message ask: "Is there anything Jo needs to do, and by when?" and repeat it back so it can be written down. You still make no promises.`;

// The Initialization snippet the builder would save (replaces INIT_CODE in
// scripts/thursday-agent-lookup.js). It passes the playbook variables through
// and reads them only as strings. LOOKUP_URL is the deployed function URL.
function initCode(lookupUrl) {
  return `export default {
  async fetch(request, env, ctx) {
    const json = await request.json().catch(() => ({}));
    const from = json.from || json.phone_number || json.caller || json.short_from || '';
    const unknown = { caller_known: 'false', caller_first_name: '', caller_job_hint: '', caller_playbook: '', caller_label_kind: '', caller_handled: 'false', caller_away_text: '' };
    const token = env && (env.THURSDAY_LOOKUP_TOKEN || (env.vars && env.vars.THURSDAY_LOOKUP_TOKEN));
    if (!from || !token) return Response.json(unknown);
    try {
      const r = await fetch('${lookupUrl}', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify({ from: String(from) }),
        signal: AbortSignal.timeout(2500),
      });
      if (!r.ok) return Response.json(unknown);
      const d = await r.json();
      if (!d) return Response.json(unknown);
      const known = d.known === true && !!d.first_name;
      return Response.json({
        caller_known: known ? 'true' : 'false',
        caller_first_name: known ? String(d.first_name) : '',
        caller_job_hint: known ? String(d.job_hint || '') : '',
        caller_playbook: String(d.playbook || ''),
        caller_label_kind: String(d.label_kind || ''),
        caller_handled: d.handled === true ? 'true' : 'false',
        caller_away_text: String(d.away_text || ''),
      });
    } catch (e) {
      return Response.json(unknown);
    }
  }
}`;
}

module.exports = {
  KIND_TO_PLAYBOOK, PLAYBOOK_IDS, NO_NAME_PLAYBOOKS, AWAY_TEXT_MAX,
  digits10, cleanText, safeAwayText, resolvePlaybook, widenLookupResponse,
  PROMPT_MARK, PROMPT_BLOCK, initCode,
};
