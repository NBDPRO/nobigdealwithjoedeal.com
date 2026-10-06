/**
 * docs/pro/js/claim-wording-filter.js — the Kentucky claim-wording rules as a
 * RUNTIME filter, shared by the public-site gate and the CRM's generated
 * reports.
 *
 * WHY (2026-10-04)
 * KRS 367.628 (eff. 2026-07-15) bars a residential contractor from
 * representing or negotiating for the insured on a claim, or marketing itself
 * as a claims / insurance specialist; Ohio reserves claim negotiation to
 * licensed public adjusters. tests/claim-wording.test.js already held the
 * PUBLIC site (docs/ minus the CRM) to that vocabulary — but only static
 * files. The CRM's Storm Damage report printed "File Insurance Claim: YES",
 * and AI photo captions (Claude Vision) flowed into the homeowner's PDF
 * unchecked, so a model could write "recommend filing a claim — insurance
 * will cover a full replacement" straight onto the contractor's letterhead.
 *
 * WHAT IT IS
 *   RULES          — the public-site rule set. MOVED here verbatim from
 *                    tests/claim-wording.test.js, which now requires this
 *                    file, so the static gate and the runtime filter can
 *                    never drift apart.
 *   REPORT_RULES   — extra report-only phrasings: a recommendation to file,
 *                    "File claim: YES", promises about what the insurer will
 *                    pay or approve, "qualifies for a claim", deductible
 *                    games, "free roof".
 *   cleanText(s)   — drops every sentence that trips RULES + REPORT_RULES
 *                    and returns the rest UNCHANGED (a string with no hit is
 *                    returned as-is, byte for byte).
 *   cleanDeep(v)   — cleanText over every string in an object/array (URL /
 *                    id / path keys skipped); returns a copy, never mutates.
 *   scanText(s)    — [{ rule, sentence }] for tests and audits.
 *
 * Dropping, not rewriting: a rewritten sentence would put words in the rep's
 * (or the model's) mouth; the report template itself carries the one
 * compliant line ("damage consistent with … observed; the homeowner may
 * contact their insurer").
 *
 * Loaded by the ScriptLoader 'photos' bundle BEFORE inspection-report-engine.js
 * and photo-report.js (window.NBDClaimWording), and by Node via module.exports.
 * No lookbehind regexes in the runtime path (older iOS Safari).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NBDClaimWording = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Claim / insurance context — most rules only fire inside it.
  const CTX = /\b(claims?|insur\w*|adjusters?|carriers?|supplements?|scope|line items?)\b/i;
  // Third parties who MAY lawfully negotiate for the insured.
  const THIRD_PARTY = /\b(public adjusters?|attorneys?|lawyers?)\b/i;

  const RULES = [
    { id: 'claims-specialist', why: '(1)(a)2.a claims-specialist/-expert framing',
      re: /\bclaims? (specialist|expert|expertise)s?\b/i },
    { id: 'insurance-specialist', why: '(1)(a)2.b insurance-specialist/-expert framing',
      re: /\binsurance(-| )(restoration |claims? |adjuster |)(specialist|specialty|expert|expertise)s?\b/i },
    { id: 'storm-specialist', why: '(1)(a)2 specialist framing next to insurance',
      re: /\b(storm|hail|restoration) specialists?\b/i, ctx: true },
    { id: 'handles-claim', why: '(1)(a)1 represent on the claim',
      re: /\b(I|we|Joe|he)( will|'ll| can)? (handle|handles|manage|manages|navigate|navigates|run|runs|take care of)( the| your| their| all the| the whole| the entire| your entire| the full)? (insurance( claims?| side| process)?|claims?( process)?)\b/i },
    { id: 'claim-handled', why: '(1)(a)1 represent on the claim',
      re: /\b(insurance|claims?) (claims? )?(handled|managed|navigated)\b/i },
    { id: 'handled-the-claim', why: '(1)(a)1 represent on the claim',
      re: /\b(handled|managed|navigated) (the|your|their) (insurance )?claim\b/i },
    { id: 'claim-for-you', why: '(1)(a)1 represent on the claim',
      re: /\b(handle|manage|navigate|file|files)\b[^.]{0,40}\bclaim\b[^.]{0,20}\bfor you\b/i },
    { id: 'negotiate', why: '(1)(a)1 negotiate on behalf of the insured',
      // "Negotiating" in quotes is the CRM's cash-pipeline STAGE name, which the
      // public how-to names when explaining it is not an insurance stage.
      re: /\bnegotiat\w*/i, ctx: true, unless: new RegExp(THIRD_PARTY.source + '|"Negotiating"', 'i') },
    { id: 'advocate', why: '(1)(a)1 represent on the claim',
      re: /\badvoca(te|tes|ting|cy)\b/i, ctx: true, unless: THIRD_PARTY },
    { id: 'on-your-behalf', why: '(1)(a)1 on behalf of the insured',
      // Narrower context than CTX: "guessing on your behalf" about a permit
      // scope is fine; "on your behalf" next to the carrier is not.
      re: /\bon (your|the homeowner'?s?|their) behalf\b/i, ctx: /\b(claims?|insur\w*|adjusters?|carriers?)\b/i, unless: THIRD_PARTY },
    { id: 'fight', why: '(1)(a)1 represent/negotiate against the insurer',
      re: /\b(I|we|Joe|he)( will|'ll| can)?\b[^.]{0,50}\b(fight|fights|push back|pushing back)\b/i, ctx: true },
    { id: 'files-claim', why: '(1)(a)1 contractor files the claim for the insured',
      re: /\b(I|we|Joe)( will|'ll)? (file|files) (the|your|a) (insurance )?claim\b|\b(I|we|Joe) (file|files) with your (carrier|insurer|insurance)/i },
    { id: 'work-with-insurer', why: '(1)(a)1 deals with the insurer for the insured',
      re: /\b(work|works|coordinate|coordinates|deal|deals)( directly)? with your (insurance company|carrier|insurer)\b/i },
    { id: 'claim-communication', why: '(1)(a)1 represent on the claim',
      re: /\b(handle|handles|handling) (all )?(the )?(communication|back-and-forth|adjuster communication)\b/i },
    // "advocate" above needs the claim word in the SAME sentence. "Homeowners
    // file without professional advocacy" (2026-09-27, hail-damage-wilmington)
    // had it one sentence earlier and passed. `near: true` checks the context
    // against the sentence plus its neighbours; third-party advice still passes.
    { id: 'advocacy-near-claim', why: '(1)(a)1 represent on the claim (claim context in an adjacent sentence)',
      re: /\badvoca(te|tes|ting|cy)\b/i, ctx: /\b(claims?|insur\w*|adjusters?)\b/i, near: true, unless: THIRD_PARTY },
    // Measuring the contractor's work against a public adjuster's frames it as
    // claim representation ("the same level of detail a public adjuster would
    // prepare", storm-damage-lebanon, 2026-09-27). Advice to HIRE one ("hire a
    // public adjuster to negotiate on your behalf") does not match this.
    { id: 'public-adjuster-would', why: '(1)(a)1 represent "as a public adjuster or otherwise"',
      re: /\bpublic adjusters? would\b/i },
    // Claim-filing help offered as a service (2026-09-27: 41 pages still read
    // "Insurance claim filing assistance — start through final payment",
    // "claim filing support", "Insurance claim assistance included"). Offering
    // to help file or run the claim is advertising to represent the insured;
    // the allowed line is "I document the damage and write the estimate; you
    // file, and I can meet the adjuster". A manufacturer WARRANTY claim is not
    // an insurance claim, so it passes.
    { id: 'claim-assistance', why: '(1)(a)1 advertise to represent (claim-filing help as a service)',
      re: /\bclaims?(-| )(filing )?(assistance|help|support|guidance)\b/i, unless: /\bwarranty\b/i },
    // "help you file", "help filing your claim", "assist with your insurance
    // claim", "Does Joe help with the insurance claim?". "An inspection helps
    // you decide whether to file" is advice and passes (the verb must be the
    // filing itself). "We file the claim" is files-claim above.
    { id: 'help-file-claim', why: '(1)(a)1 contractor helps file / assists with the claim',
      re: /\b(help|helps|helping|assist|assists|assisting)( you| homeowners| them| the homeowner)?( to)? (file|filing)\b|\b(help|helps|helping|assist|assists|assisting|assistance) (with|in) (filing|(your|the|a|their) (insurance )?claims?)\b/i,
      ctx: true, unless: THIRD_PARTY },
    // 2026-10-02: the claim word without a "handle" verb still slipped through.
    // "walk you through the (entire) claim process from filing through final
    // payment" is claim guidance (claim-assistance above) in other words, and
    // ran on 8 hail/storm pages; "You focus on your deductible; we handle the
    // rest" sat on the HOMEPAGE FAQ; "I … can request a re-inspection" acts
    // for the insured (the homeowner asks the carrier — advice that YOU can is
    // fine); "I stay involved through adjuster visits" and "someone who knows
    // the insurance side" sell claim involvement / insurance expertise.
    // Explaining is fine: "walk you through whether a claim makes sense" and
    // "what a claim looks like" don't match.
    { id: 'walk-through-claim', why: '(1)(a)1 advertise to represent (guiding the insured through the claim)',
      re: /\b(walk|walks|walking|guide|guides|guiding|take|takes|taking) (you|them|homeowners|the homeowner|families)( all the way)? through (the |your |their )?(entire |whole |full )?(insurance )?claims?\b/i },
    { id: 'through-the-claim', why: '(1)(a)1 advertise to represent (carrying the insured through the claim)',
      re: /\b(get|gets|getting|got|see|sees|seeing) ([\w.-]+ )?(homeowners|you|them|families|customers) through (the|your|their) (insurance )?claims?\b/i },
    { id: 'handle-the-rest', why: '(1)(a)1 represent on the claim (everything but the deductible)',
      re: /\b(we|I|Joe)('ll| will)? (handle|take care of) (the rest|everything else)\b/i, ctx: /\b(claims?|insur\w*|adjusters?|carriers?|deductibles?)\b/i, near: true },
    { id: 'contractor-reinspection', why: '(1)(a)1 act for the insured with the carrier',
      re: /\b(I|we|Joe)\b[^.;]{0,100}\b(can|will|'ll) (request|demand|order) (a |another )?re-?inspections?\b/i },
    { id: 'stay-involved', why: '(1)(a)1 represent on the claim',
      re: /\b(I|we|Joe)( stay| stays| remain| remains| keep| keeps) involved\b/i, ctx: true },
    { id: 'insurance-side', why: '(1)(a)2 market insurance expertise',
      re: /\bknows? the insurance side\b/i },
    // 2026-10-03: outcome promises on the claim. "get Mason homeowners the full
    // payout they're owed", the "Max Your Payout" trust badge, and "fight for
    // the full, legitimate payout" on 9 pages (the fight rule missed it: no
    // claim word in that sentence) all sell a claim result — representing the
    // insured. Describing payouts passes ("the initial payout is below actual
    // scope", "policies with larger maximum payouts", "a partial payout").
    { id: 'payout-promise', why: '(1)(a)1 advertise to represent (promising the claim payout)',
      re: /\b(full|fullest|max|maximum|maximi[sz]e|maximi[sz]ing|biggest|largest)\b[^.;]{0,25}\b(payouts?|settlements?)\b|\b(payouts?|settlements?|money|amount) (they're|you're|they are|you are|homeowners are) owed\b/i,
      unless: /\b(polic(y|ies)|coverage)\b/i },
    // "make sure your claim reflects every dollar of damage" — a promise about
    // the claim's value. Needs the claim word in the sentence, so a blog line
    // about homeowners who "get every dollar they deserved" by pushing back
    // themselves still passes.
    { id: 'every-dollar', why: '(1)(a)1 advertise to represent (promising the claim value)',
      re: /\bevery (last )?(dollar|penny|cent)\b/i, ctx: true },
    // "Denials get appealed." / "I appeal denied claims" — the contractor
    // contesting the carrier's decision for the insured. "to support an
    // appeal" sold the supplement as appeal work. A homeowner asking their
    // carrier to reconsider is advice and passes.
    { id: 'appeal-promise', why: '(1)(a)1 represent/negotiate (appealing the claim decision)',
      re: /\b(denials?|claims?|decisions?)( (get|gets|will be|are|is|can be))? appealed\b|\b(I|we|Joe|he)( will|'ll| can)? (appeal|appeals)\b|\b(support|file|handle|win|run) (an |the |your )?appeals?\b/i },
    // "I know how to document damage, file claims, and …" / "I've documented
    // and filed Warren County hail claims since 2018" — plural claims, which
    // files-claim above (one "the/your/a claim") never saw. The homeowner
    // filing in the same sentence passes.
    { id: 'files-claims', why: '(1)(a)1 contractor files the claims for the insured',
      re: /\b(I|we|Joe|he)\b[^.;]{0,60}\b(file|files|filed|filing) ([\w-]+ ){0,3}claims\b/i,
      unless: /\b(you|homeowners?|homes|houses|neighbou?rs|they|owners?|customers?|families) (file|files|filed)\b|\b(not|never|don't|won't)\b[^.;]{0,30}\bfil(e|ing)\b/i },
    // 2026-10-04: claim administration sold as a product feature. The NBD Pro
    // FAQ offered claim management and adjuster coordination — managing the
    // insured's claim and coordinating their adjuster is representing them.
    // "meet the adjuster on the roof" is the allowed (1)(c)2 conference.
    { id: 'claims-management', why: '(1)(a)1 represent on the claim (claim management / adjuster coordination as a service)',
      re: /\b(insurance )?claims? (management|administration|coordination)\b|\badjusters? (coordination|management)\b|\bcoordinat\w* (with )?(the |your |their )?(insurance )?adjusters?\b/i,
      unless: THIRD_PARTY },
    // 2026-10-04: an assignment of benefits is void in Kentucky (KRS
    // 304.20-105) and Jo retired it in both states (2026-09-27). The public
    // pages may only mention it to say it is not used, or to warn a homeowner
    // off signing one ("hands control of your claim … to someone else").
    { id: 'aob', why: 'KRS 304.20-105 assignment of benefits (void in Kentucky; retired)',
      re: /\bAOBs?\b|\bassignments? of benefits\b/i,
      unless: /\b(no|never|not|don't|do not|won't|retired|void|voids|banned|forbid\w*|prohibit\w*|illegal|unlawful|avoid|hands? control)\b/i },
    // 2026-10-05 (homeowner honesty audit): predicting the claim outcome. The
    // /storm-check result said "You likely have a claimable loss", /storm-report
    // said "Strong claim potential … exactly what insurers act on", and a blog
    // FAQ said "insurance should cover it regardless of age". Jo: never promise
    // an insurance outcome. Saying an inspection is worth it passes.
    { id: 'claim-outcome-prediction', why: '(1)(a)1 predicting / promising the claim outcome',
      re: /\bclaimable loss(es)?\b|\b(strong|good|high|great|real|significant) (insurance )?claim potential\b|\binsurers? (act|acts|will act) on\b/i },
    { id: 'covers-regardless', why: '(1)(a)1 promising the claim outcome (coverage "regardless")',
      re: /\b(insurance|insurer|carrier|policy|polic(y|ies)|coverage)\b[^.;!?]{0,40}\b(should|will|must|is going to)( still)? (cover|pay)\b[^.;!?]{0,40}\bregardless\b|\b(get|gets|pays?|paid) the full amount regardless\b/i },
  ];

  // ── Report-only phrasings (2026-10-04) ────────────────────────────────
  // Generated reports and AI captions say things a marketing page never
  // does. Each is the contractor (or its software) advising the insured on
  // the claim or promising its outcome.
  var NOT_ADVICE_AGAINST = /\b(no contractor|cannot|can't|can not|illegal|unlawful|fraud)\b/i;
  const REPORT_RULES = [
    { id: 'recommend-filing', why: '(1)(a)1 advising the insured to file',
      re: /\b(recommend\w*|advis\w*|suggest\w*|urg\w*|encourag\w*|should|must|needs? to|ought to)\b[^.;!?]{0,40}\b(file|files|filed|filing|open|opening|submit\w*)\b[^.;!?]{0,30}\b(insurance )?claims?\b/i },
    { id: 'file-claim-yes', why: '(1)(a)1 a filing recommendation as a form field',
      re: /\bfile (an |a |the )?(insurance )?claims?\s*[:\-\u2013\u2014]\s*(yes|y|true|recommended)\b/i },
    { id: 'claim-recommended', why: '(1)(a)1 advising the insured to file',
      re: /\b(insurance )?claims? (is |are )?(strongly |highly )?(recommended|advised|warranted|justified)\b/i },
    { id: 'insurer-will-pay', why: '(1)(a)1 promising the claim outcome',
      re: /\b(insurance|insurer|carrier|policy|adjuster)s?\b[^.;!?]{0,40}\b(will|should|must|is going to|are going to)( likely| definitely| probably)? (pay|cover|approve|replace|total)\b/i },
    { id: 'qualifies-for-claim', why: '(1)(a)1 promising the claim outcome',
      re: /\b(qualif(y|ies|ied)|eligible)\b[^.;!?]{0,30}\b(claims?|insurance|coverage|full replacement|new roof)\b/i },
    { id: 'claim-approval', why: '(1)(a)1 promising the claim outcome',
      re: /\b(get|gets|getting|guarantee\w*)\b[^.;!?]{0,30}\b(claims?|roof|replacement) (approved|paid|covered)\b/i },
    { id: 'deductible-games', why: 'KRS 367.628(2) waiving / absorbing / rebating the deductible',
      re: /\b(waive\w*|absorb\w*|rebate\w*|cover\w*|eat|eats)\b[^.;!?]{0,25}\bdeductibles?\b|\bdeductibles?\b[^.;!?]{0,20}\b(waived|absorbed|rebated|covered)\b/i,
      unless: NOT_ADVICE_AGAINST },
    { id: 'free-roof', why: '(1)(a)1 / (2) promising the claim outcome',
      re: /\bfree (new )?roof\b/i },
  ];
  const ALL_RULES = RULES.concat(REPORT_RULES);

  // `win` is the sentence with its neighbours; only `near` rules read it.
  function checkSentence(s, win, rules) {
    const list = rules || RULES;
    const w = win == null ? s : win;
    const hits = [];
    for (const r of list) {
      if (!r.re.test(s)) continue;
      if (r.ctx && !(r.ctx === true ? CTX : r.ctx).test(r.near ? w : s)) continue;
      if (r.unless && r.unless.test(s)) continue;
      hits.push(r.id);
    }
    return hits;
  }

  // Sentence chunks that concatenate back to the exact input (terminator and
  // trailing whitespace stay on their chunk).
  function chunks(text) {
    return String(text).match(/[^.!?\n]*(?:[.!?]+|\n|$)[ \t\r\n]*/g).filter(function (c) { return c !== ''; });
  }

  function scanText(text, rules) {
    if (typeof text !== 'string' || !text) return [];
    const cs = chunks(text).map(function (c) { return c.replace(/\s+/g, ' ').trim(); });
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      if (!cs[i]) continue;
      const win = [cs[i - 1], cs[i], cs[i + 1]].filter(Boolean).join(' ');
      for (const id of checkSentence(cs[i], win, rules || ALL_RULES)) out.push({ rule: id, sentence: cs[i] });
    }
    return out;
  }

  function cleanText(text) {
    if (typeof text !== 'string' || !text) return text;
    const cs = chunks(text);
    const flat = cs.map(function (c) { return c.replace(/\s+/g, ' ').trim(); });
    let dropped = false;
    const kept = [];
    for (let i = 0; i < cs.length; i++) {
      const win = [flat[i - 1], flat[i], flat[i + 1]].filter(Boolean).join(' ');
      if (flat[i] && checkSentence(flat[i], win, ALL_RULES).length) { dropped = true; continue; }
      kept.push(cs[i]);
    }
    return dropped ? kept.join('').trim() : text;
  }

  const SKIP_KEY = /(url|urls|src|href|path|id|ids|uid|token)$/i;
  function cleanDeep(value, key) {
    if (typeof value === 'string') return (key && SKIP_KEY.test(key)) ? value : cleanText(value);
    if (Array.isArray(value)) return value.map(function (v) { return cleanDeep(v, key); });
    if (value && typeof value === 'object') {
      // Plain object = its prototype is a ROOT prototype (realm-agnostic, so
      // an object built in another frame/vm still counts). Date, Firestore
      // Timestamp, File … are returned as-is.
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && Object.getPrototypeOf(proto) !== null) return value;
      const out = {};
      for (const k of Object.keys(value)) out[k] = cleanDeep(value[k], k);
      return out;
    }
    return value;
  }

  return {
    CTX: CTX,
    THIRD_PARTY: THIRD_PARTY,
    RULES: RULES,
    REPORT_RULES: REPORT_RULES,
    ALL_RULES: ALL_RULES,
    checkSentence: checkSentence,
    scanText: scanText,
    cleanText: cleanText,
    cleanDeep: cleanDeep,
  };
});
