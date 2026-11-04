'use strict';
/**
 * opp-draft-templates.js — the fixed first-message wordings for the Thumbtack
 * Opportunities watcher (2026-11-04, flag thumbtackOpportunities, ships dark).
 * PURE DATA. No Firestore, no send path, nothing read from Thumbtack.
 *
 * Three wordings per trade (so messages do not read as copies), six trades:
 * the four shortlist trades plus the two install trades (which only reach a
 * draft when the shortlist found a real replacement). The server picks or
 * accepts a KEY; nobody types words into a template.
 *
 * A template is a list of sentences with these merge slots, filled by
 * opp-draft-logic.js buildOppDraft():
 *   {company}  the company's own name from its profile
 *   {near}     "near <city>" or "in your area" (city: letters only, validated)
 *   {problem}  the customer's own words as a short quote, sanitized (no links,
 *              numbers, phone shapes, instructions or insurance talk), or one of
 *              our own fallback phrases ("the leak", "the roof repair")
 *   {photo}    one sentence: thanks for the photos, or ask for one photo
 * Every wording says it is Fully insured, offers a free look and a time window,
 * and tells them they can reply right here in Thumbtack.
 *
 * What a template may NEVER say (tests/opp-draft-2026-11-04.test.js proves every
 * line, and that the proof can fail): a digit, a price or estimate, a deadline
 * or pressure line, the words call / text / phone / number / email, the
 * insurance claim, adjuster, deductible or coverage, "licensed", "in-house",
 * "lifetime", a guarantee or warranty, an emoji, "Dear homeowner". Say
 * "fully insured", never more.
 */
const TRADE_KEYS = Object.freeze(['roof_repair', 'roof_inspection', 'siding_repair', 'gutter_repair', 'roof_install', 'siding_install']);

const PHOTO = Object.freeze({
  yes: 'Thanks for including photos, and you can reply right here in Thumbtack with a time that suits you.',
  no: 'If you have one photo of the area, you can send it by replying right here in Thumbtack.',
});

const T = {
  // ── Roof repair ──────────────────────────────────────────────────────────
  opp_roof_repair_a: {
    trade: 'roof_repair',
    lines: ['Hi, I\'m with {company}, a local roofing company {near}, fully insured.', 'I saw your request about {problem}.', 'I would be glad to take a free look at the roof and tell you plainly what I find.', 'I have openings this week, mornings or afternoons.', '{photo}'],
  },
  opp_roof_repair_b: {
    trade: 'roof_repair',
    lines: ['Hello from {company}.', 'We are {near} and fully insured.', 'Your request mentions {problem}, and that is something I can help with.', 'A free look is the easiest first step, and I can fit one in this week at a time that suits you.', '{photo}'],
  },
  opp_roof_repair_c: {
    trade: 'roof_repair',
    lines: ['Hi, this is {company}, fully insured and {near}.', 'Thanks for posting about {problem}.', 'I can stop by for a free look at the roof, mornings or afternoons this week.', 'No pressure, I will just tell you what I see.', '{photo}'],
  },
  // ── Roof inspection ──────────────────────────────────────────────────────
  opp_roof_inspection_a: {
    trade: 'roof_inspection',
    lines: ['Hi, I\'m with {company}, a local roofing company {near}, fully insured.', 'I saw your request for a roof inspection, and you mentioned {problem}.', 'I can come take a free, careful look at the roof and tell you plainly what I see.', 'I have openings this week, mornings or afternoons.', '{photo}'],
  },
  opp_roof_inspection_b: {
    trade: 'roof_inspection',
    lines: ['Hello from {company}.', 'We are {near} and fully insured.', 'You asked for a roof inspection and mentioned {problem}.', 'I would start with a free look at the roof and give you an honest read, and I can come this week.', '{photo}'],
  },
  opp_roof_inspection_c: {
    trade: 'roof_inspection',
    lines: ['Hi, this is {company}, fully insured and {near}.', 'Thanks for posting about {problem}.', 'A free look at the roof will show what is going on, and I can come by this week.', 'You will get my plain opinion, nothing more.', '{photo}'],
  },
  // ── Siding repair ────────────────────────────────────────────────────────
  opp_siding_repair_a: {
    trade: 'siding_repair',
    lines: ['Hi, I\'m with {company}, a local exterior contractor {near}, fully insured.', 'I saw your request about {problem}.', 'I would be glad to take a free look at the siding and tell you plainly what it needs.', 'I have openings this week, mornings or afternoons.', '{photo}'],
  },
  opp_siding_repair_b: {
    trade: 'siding_repair',
    lines: ['Hello from {company}.', 'We are {near} and fully insured.', 'Your request mentions {problem}, and I can help with that.', 'A free look at the siding is the easiest first step, and I can fit one in this week.', '{photo}'],
  },
  opp_siding_repair_c: {
    trade: 'siding_repair',
    lines: ['Hi, this is {company}, fully insured and {near}.', 'Thanks for posting about {problem}.', 'I can stop by for a free look at the siding, mornings or afternoons this week.', 'No pressure, I will just tell you what I see.', '{photo}'],
  },
  // ── Gutter repair ────────────────────────────────────────────────────────
  opp_gutter_repair_a: {
    trade: 'gutter_repair',
    lines: ['Hi, I\'m with {company}, a local exterior contractor {near}, fully insured.', 'I saw your request about {problem}.', 'I would be glad to take a free look at the gutters and tell you plainly what they need.', 'I have openings this week, mornings or afternoons.', '{photo}'],
  },
  opp_gutter_repair_b: {
    trade: 'gutter_repair',
    lines: ['Hello from {company}.', 'We are {near} and fully insured.', 'Your request mentions {problem}, and I can help with that.', 'A free look at the gutters is the easiest first step, and I can fit one in this week.', '{photo}'],
  },
  opp_gutter_repair_c: {
    trade: 'gutter_repair',
    lines: ['Hi, this is {company}, fully insured and {near}.', 'Thanks for posting about {problem}.', 'I can stop by for a free look at the gutters, mornings or afternoons this week.', 'No pressure, I will just tell you what I see.', '{photo}'],
  },
  // ── Roof replacement (only a real replacement reaches a draft) ───────────
  opp_roof_install_a: {
    trade: 'roof_install',
    lines: ['Hi, I\'m with {company}, a local roofing company {near}, fully insured.', 'I saw your request about {problem}.', 'I would be glad to take a free look at the roof so we can talk through what a replacement involves.', 'I have openings this week, mornings or afternoons.', '{photo}'],
  },
  opp_roof_install_b: {
    trade: 'roof_install',
    lines: ['Hello from {company}.', 'We are {near} and fully insured.', 'Your request mentions {problem}, and a new roof is a big decision.', 'A free look at the roof is a good first step, and I can come this week.', '{photo}'],
  },
  opp_roof_install_c: {
    trade: 'roof_install',
    lines: ['Hi, this is {company}, fully insured and {near}.', 'Thanks for posting about {problem}.', 'I can stop by for a free look at the roof, mornings or afternoons this week.', 'No pressure, I will just tell you what I see and answer your questions.', '{photo}'],
  },
  // ── Siding replacement ───────────────────────────────────────────────────
  opp_siding_install_a: {
    trade: 'siding_install',
    lines: ['Hi, I\'m with {company}, a local exterior contractor {near}, fully insured.', 'I saw your request about {problem}.', 'I would be glad to take a free look at the siding so we can talk through what a replacement involves.', 'I have openings this week, mornings or afternoons.', '{photo}'],
  },
  opp_siding_install_b: {
    trade: 'siding_install',
    lines: ['Hello from {company}.', 'We are {near} and fully insured.', 'Your request mentions {problem}, and new siding is a big decision.', 'A free look at the house is a good first step, and I can come this week.', '{photo}'],
  },
  opp_siding_install_c: {
    trade: 'siding_install',
    lines: ['Hi, this is {company}, fully insured and {near}.', 'Thanks for posting about {problem}.', 'I can stop by for a free look at the siding, mornings or afternoons this week.', 'No pressure, I will just tell you what I see and answer your questions.', '{photo}'],
  },
};

const TEMPLATES = Object.freeze(Object.keys(T).reduce((o, k) => { o[k] = Object.freeze({ trade: T[k].trade, lines: Object.freeze(T[k].lines.slice()) }); return o; }, {}));
const TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATES));

/** The three keys for a trade, in order a, b, c. */
function keysForTrade(tradeKey) { return TEMPLATE_KEYS.filter((k) => TEMPLATES[k].trade === tradeKey); }
/** Is this one of our fixed keys? (own keys only: never "__proto__" or "constructor") */
function isTemplateKey(k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, k); }

/** Words a template line may not contain (tested on every line, with a positive control). */
const FORBIDDEN_IN_TEMPLATE = /[0-9$%]|\b(prices?|pricing|costs?|quotes?|estimates?|discounts?|cheap\w*|guarantee\w*|warrant\w*|licensed|certified|in[- ]house|lifetime|insurance|claims?|adjusters?|deductibles?|coverage|covered|specialists?|experts?|approved?|limited|hurry|urgent\w*|immediately|asap|now or|act now|last chance|before it|today only|call\w*|text\w*|phone\w*|numbers?|emails?|e-mail|cell|mobile|whatsapp|website|dear|homeowner)\b/i;

module.exports = { TRADE_KEYS, PHOTO, TEMPLATES, TEMPLATE_KEYS, keysForTrade, isTemplateKey, FORBIDDEN_IN_TEMPLATE };
