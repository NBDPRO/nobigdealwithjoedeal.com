/**
 * ky-insurance-law.js — which law a contract is written under, and the
 * statutory text that law requires on the paper.
 *
 * WHY (2026-09-27): 2026 Ky. Acts ch. 54 (SB 153) covers every contract signed
 * on or after 2026-07-15 for goods or services on Kentucky real estate that are
 * expected to be paid from property/casualty insurance proceeds:
 *   - KRS 367.624 — BEFORE the contract is signed the contractor must furnish
 *     its mailing address, its phone (+ fax/email), two notices in >= 10-point
 *     boldface, and a fully completed, easily detachable NOTICE OF
 *     CANCELLATION form in duplicate;
 *   - KRS 304.20-105 — an assignment of the insured's policy rights or
 *     benefits is void (policies issued/renewed on or after 2024-04-02), and a
 *     contract containing one is void and unenforceable (notice (3)(b));
 *   - KRS 367.628(2)(g) — no lien for amounts above what the insurer pays.
 * Separately, the server contract promised "the attached Notice of
 * Cancellation form" (the FTC Cooling-Off Rule sentence, 16 CFR 429.1(a)) and
 * attached nothing. This module holds that form too (429.1(b)).
 *
 * Texts below are copied VERBATIM from the enrolled act
 * (apps.legislature.ky.gov/law/acts/26RS/documents/0054.pdf, Section 2) and
 * from eCFR 16 CFR 429.1 / 429.0 (read 2026-09-27). Do not "tidy" them — the
 * statute prescribes the words. tests/ky-insurance-law.test.js pins them.
 *
 * ONE MODULE, TWO COPIES. The browser loads docs/pro/js/ky-insurance-law.js
 * (window.NBDJurisdiction); Cloud Functions require functions/ky-insurance-law.js
 * (functions/ deploys on its own and cannot reach docs/). The test pins the two
 * byte-identical after EOL normalisation — edit this one, then copy it over.
 *
 * FAIL CLOSED. An insurance job whose state cannot be read is treated as a
 * Kentucky insurance job: the extra notices cost nothing on an Ohio contract,
 * while their absence can void a Kentucky one.
 *
 * Statutory text is copied verbatim from 2026 Ky. Acts ch. 54 and 16 CFR 429.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDJurisdiction = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // ── Statutory text (verbatim) ────────────────────────────────────────────
  // KRS 367.624(3)(a) and (3)(b), as amended by 2026 Ky. Acts ch. 54 § 2.
  var KY_NOTICE_CANCEL =
    'You may cancel this contract at any time before midnight on the fifth business day after you have ' +
    'received written notification from the insurer that all or any part of the contracted goods, services, or ' +
    'goods and services is not a covered loss under the property, casualty, or property and casualty insurance ' +
    'policy. This right to cancel is in addition to any other rights of cancellation you may have under state or ' +
    'federal law or regulation. See the attached Notice of Cancellation form for an explanation of this right.';
  var KY_NOTICE_NO_ASSIGNMENT =
    'This contract shall not assign or otherwise transfer, in whole or in part, your duties, rights, or ' +
    'benefits under the property, casualty, or property and casualty insurance policy in violation of KRS ' +
    '304.20-105. Any contract entered in violation of KRS 304.20-105 shall be void and unenforceable.';

  // KRS 367.624(4) form body. The three "(enter …)" blanks are filled per
  // contract by kyCancellationFormsHtml().
  var KY_FORM_CAPTION = 'NOTICE OF CANCELLATION';
  var KY_FORM_BODY_PARTS = [
    'If you are notified by the insurer that all or any part of the contracted goods, services, or goods and services is ' +
    'not a covered loss under the property, casualty, or property and casualty insurance policy, you may cancel this ' +
    'contract without penalty or monetary obligation before midnight of the fifth business day after you have ' +
    'received the notice. To cancel this transaction, you may use any of the following methods: mail or otherwise ' +
    'deliver a signed and dated copy of this cancellation notice, or any other written notice of cancellation which ' +
    'you sign and date, to ',
    /* physical address of contractor */
    ', or email a notice of cancellation to ',
    /* email address of contractor */
    ', or transmit a notice of cancellation to ',
    /* facsimile number of contractor */
    ', not later than midnight of the fifth day after you receive notice from the insurer.'
  ];
  var CANCEL_LINE = 'I HEREBY CANCEL THIS TRANSACTION.';
  // No fax: the statute's blank is "if applicable" in 367.624(2); this is the
  // only wording choice made inside the form.
  var NO_FAX_TEXT = '(none — the contractor has no facsimile number)';

  // KRS 367.628(2)(g) — the contractor's own undertaking, KY insurance jobs.
  var KY_LIEN_CLAUSE =
    "Contractor will not file or claim a mechanic's lien for any amount in excess of what your insurer pays or is expected to pay.";

  // 16 CFR 429.1(a) statement and 429.1(b) form, verbatim.
  var FTC_STATEMENT =
    'You, the buyer, may cancel this transaction at any time prior to midnight of the third business day after ' +
    'the date of this transaction. See the attached notice of cancellation form for an explanation of this right.';
  var FTC_FORM_CAPTION = 'NOTICE OF CANCELLATION';
  var FTC_FORM_PARAS = [
    'You may CANCEL this transaction, without any Penalty or Obligation, within THREE BUSINESS DAYS from the above date.',
    'If you cancel, any property traded in, any payments made by you under the contract or sale, and any negotiable ' +
    'instrument executed by you will be returned within TEN BUSINESS DAYS following receipt by the seller of your ' +
    'cancellation notice, and any security interest arising out of the transaction will be cancelled.',
    'If you cancel, you must make available to the seller at your residence, in substantially as good condition as ' +
    'when received, any goods delivered to you under this contract or sale, or you may, if you wish, comply with the ' +
    "instructions of the seller regarding the return shipment of the goods at the seller's expense and risk.",
    'If you do make the goods available to the seller and the seller does not pick them up within 20 days of the date ' +
    'of your Notice of Cancellation, you may retain or dispose of the goods without any further obligation. If you ' +
    'fail to make the goods available to the seller, or if you agree to return the goods to the seller and fail to do ' +
    'so, then you remain liable for performance of all obligations under the contract.'
  ];

  // ── Rep-facing messages (one copy, shared by every surface) ──────────────
  var MSG = {
    addressRequired:
      'Kentucky insurance contracts must show your business mailing and physical address. Add your street address ' +
      '(street, city, state, ZIP — not a PO box) in Settings → Company Profile → "Mailing Address (one line)", then Save Company Profile.',
    depositHold:
      'Kentucky insurance job: nothing is due at signing (KRS 367.626). The deductible and ACV payment become due after the ' +
      'insurer\'s written coverage decision and the 5-business-day cancellation window. Bill emergency tarp or repair work ' +
      '(KRS 367.626(3)) on its own invoice.',
    payLinkHeld:
      'Online payment link withheld: Kentucky insurance job (KRS 367.626). Record the date the carrier\'s written coverage ' +
      'decision arrived on the lead (Claim section → "Carrier decision"); the link can be created 5 business days ' +
      'later. Emergency tarp or repair invoices can be marked Emergency and billed now (KRS 367.626(3)).',
    aobRetired:
      'The Assignment of Benefits and the Direction to Pay have been retired. Contracts carry a plain payment clause; ' +
      'nothing moves any of the homeowner\'s policy rights to you.',
    stateUnknown:
      'The property state could not be read from the address, so this insurance job is treated as a Kentucky insurance job (statutory notices + cancellation form added).'
  };

  // ── State detection ──────────────────────────────────────────────────────
  var US_STATES = ('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM ' +
    'NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' ');
  var STATE_NAMES = { KENTUCKY: 'KY', OHIO: 'OH', INDIANA: 'IN' };

  function _str(v) { return v == null ? '' : String(v); }
  function _isState(s) { return US_STATES.indexOf(String(s || '').toUpperCase()) !== -1; }

  /** The 5-digit ZIP: an explicit zip field first, else the LAST one in the address. */
  function zipOf(address, zip) {
    var z = _str(zip).match(/\b(\d{5})(?:-\d{4})?\b/);
    if (z) return z[1];
    var all = _str(address).match(/\b\d{5}(?:-\d{4})?\b/g);
    return all ? all[all.length - 1].slice(0, 5) : '';
  }

  /** State implied by a ZIP's 3-digit prefix, for the three states NBD works. */
  function stateFromZip(zip5) {
    var z = _str(zip5);
    if (!/^\d{5}$/.test(z)) return '';
    var p = parseInt(z.slice(0, 3), 10);
    if (p >= 400 && p <= 427) return 'KY';
    if (p >= 430 && p <= 459) return 'OH';
    if (p >= 460 && p <= 479) return 'IN';
    return '';
  }

  /**
   * State written in a free-text address. Only positions an address puts a
   * state in count, so "100 Kentucky Ave" or a street ending in "Ct" never
   * decides it:
   *   "…, KY 41075" / "… KY 41075"  (two letters followed by a ZIP)
   *   "…, KY" / "…, ky 41075"        (after the last comma, end of string)
   *   "…, Kentucky 41075" / "…, Kentucky"
   */
  function stateFromAddress(address) {
    var s = _str(address).trim().replace(/[,\s]*(?:USA|U\.S\.A\.|US|United States)\.?$/i, '');
    if (!s) return '';
    // Two letters then a ZIP: upper-case anywhere ("… OH 45202"), any case
    // only straight after a comma (", ky 41042") — so "12 Oak Ct 45202"
    // never reads as Connecticut. The LAST such pair wins.
    var m, last = '';
    var reZip = /(,\s*)?\b([A-Za-z]{2})\.?,?\s+\d{5}(?:-\d{4})?\b/g;
    while ((m = reZip.exec(s))) {
      if (_isState(m[2]) && (m[1] || m[2] === m[2].toUpperCase())) last = m[2].toUpperCase();
    }
    if (last) return last;
    var tail = s.match(/,\s*([A-Za-z]{2})\.?\s*(?:\d{5}(?:-\d{4})?)?\s*$/);
    if (tail && _isState(tail[1])) return tail[1].toUpperCase();
    // "…, Goshen OH" — upper-case, end of string, only the states NBD works.
    var bare = s.match(/\s(OH|KY|IN)\.?$/);
    if (bare) return bare[1];
    var named = s.match(/(?:,\s*|\s)(Kentucky|Ohio|Indiana)\.?\s*(?:\d{5}(?:-\d{4})?)?\s*$/i);
    if (named) return STATE_NAMES[named[1].toUpperCase()];
    return '';
  }

  function _present(v) {
    var s = _str(v).trim().toLowerCase();
    return !!s && ['none', 'n/a', 'na', '-', '—', 'no', 'null', 'undefined', 'false', '0'].indexOf(s) === -1;
  }

  /**
   * Is this job paid (or expected to be paid) from insurance proceeds?
   * Any one signal is enough — jobType/mode 'insurance', an insurance flag,
   * a claim number or a carrier on file.
   */
  function isInsurance(ctx) {
    ctx = ctx || {};
    if (normJobType(ctx.jobType) === 'insurance' || normJobType(ctx.mode || ctx.jobMode) === 'insurance') return true;
    if (ctx.isInsurance === true || ctx.isInsuranceJob === true || ctx.insuranceClaim === true || ctx.insurance === true) return true;
    if (_hasClaimIdentity(ctx)) return true;
    var ins = ctx.insurance;
    if (ins && typeof ins === 'object' && (_present(ins.claimNumber) || _present(ins.carrier))) return true;
    return false;
  }

  // ── The shared "is this an insurance job?" check (Jo, 2026-09-30) ─────────
  // One place defines the job types and the claim signals. Each consumer
  // applies its own policy on top:
  //   - isInsurance (above, Kentucky law): ANY signal → insurance. Over-
  //     inclusive on purpose — the law's protections must never be skipped.
  //   - claimPanelMode (below, the customer page's claim panel): the job TYPE
  //     decides when it is set; the signals only decide while it is unset.
  //   - crm-stages inferJobType reads the type through normJobType too.
  var JOB_TYPES = ['insurance', 'cash', 'finance', 'warranty', 'service'];
  /** 'Insurance ' → 'insurance'; anything not a known type → ''. */
  function normJobType(v) {
    var s = _str(v).trim().toLowerCase();
    return JOB_TYPES.indexOf(s) !== -1 ? s : '';
  }
  // The insurance track's own pipeline stages (crm-stages.js S.* values).
  var INSURANCE_STAGES = ['claim_filed', 'adjuster_meeting_scheduled', 'adjuster_inspection_done',
    'scope_received', 'supplement_requested', 'supplement_approved'];
  function _hasClaimIdentity(o) {
    return _present(o.claimNumber) || _present(o.insuranceCarrier) || _present(o.insCarrier) || _present(o.insuranceCompany);
  }
  /** A claim status that says something ('No Claim' and blanks say nothing). */
  function _claimStatusOf(lead) {
    var s = _str(lead && lead.claimStatus).trim();
    return (s && s.toLowerCase() !== 'no claim' && _present(s)) ? s : '';
  }
  /**
   * Everything on a lead (or one job's view of it) that points at an
   * insurance claim. Each field is the evidence, or '' / false.
   */
  function claimSignals(lead) {
    lead = lead || {};
    var stage = _str(lead._stageKey || lead.stage).trim().toLowerCase();
    return {
      carrier: _present(lead.insCarrier) ? _str(lead.insCarrier).trim() : (_present(lead.insuranceCarrier) ? _str(lead.insuranceCarrier).trim() : ''),
      claimNumber: _present(lead.claimNumber) ? _str(lead.claimNumber).trim() : '',
      claimStatus: _claimStatusOf(lead),
      claimStage: _str(lead.claimStage).trim(),           // the panel's own progress, once advanced
      insuranceStage: INSURANCE_STAGES.indexOf(stage) !== -1
    };
  }
  function hasClaimSignals(lead) {
    var s = claimSignals(lead);
    return !!(s.carrier || s.claimNumber || s.claimStatus || s.claimStage || s.insuranceStage);
  }
  /**
   * The customer page's Insurance Claim panel, decided for the job on the card:
   *   'full'    insurance job — or no type yet, but the job shows claim signs
   *   'summary' a cash / finance / service / warranty job with a claim on file
   *             (e.g. denied, then paid cash): one read-only line, no Advance
   *   'hidden'  a cash / finance / service / warranty job with no claim
   *   'prompt'  no type and no claim signs: ask "Insurance job?" instead
   */
  function claimPanelMode(lead) {
    var jt = normJobType(lead && lead.jobType);
    if (jt === 'insurance') return 'full';
    var any = hasClaimSignals(lead);
    if (jt) {
      var s = claimSignals(lead);
      return (s.claimNumber || s.claimStatus || s.claimStage || s.carrier) ? 'summary' : 'hidden';
    }
    return any ? 'full' : 'prompt';
  }

  /**
   * classify(ctx) → {
   *   state        'KY' | 'OH' | … | ''  (any Kentucky signal wins)
   *   stateKnown   the address or ZIP named a state
   *   kentucky     address OR ZIP OR an explicit state says Kentucky
   *   insurance    isInsurance(ctx)
   *   kyInsurance  insurance && (kentucky || state unknown)   ← FAIL CLOSED
   *   aobBarred    kentucky || kyInsurance
   *   conflict     the address's state and the ZIP's state disagree
   * }
   * ctx: { address, zip, state, jobType, mode, claimNumber, insuranceCarrier,
   *        insCarrier, insuranceCompany, insuranceClaim, isInsurance, insurance }
   */
  function classify(ctx) {
    ctx = ctx || {};
    var explicit = _isState(ctx.state) ? String(ctx.state).toUpperCase() : '';
    var addrState = stateFromAddress(ctx.address);
    var zipState = stateFromZip(zipOf(ctx.address, ctx.zip));
    var kentucky = explicit === 'KY' || addrState === 'KY' || zipState === 'KY';
    var state = kentucky ? 'KY' : (explicit || addrState || zipState || '');
    var insurance = isInsurance(ctx);
    var kyInsurance = insurance && (kentucky || !state);
    return {
      state: state,
      stateKnown: !!state,
      kentucky: kentucky,
      insurance: insurance,
      kyInsurance: kyInsurance,
      aobBarred: kentucky || kyInsurance,
      conflict: !!(addrState && zipState && addrState !== zipState),
      addressState: addrState,
      zipState: zipState
    };
  }

  /** Classification for a lead record (+ optional estimate). */
  function classifyLead(lead, estimate) {
    lead = lead || {};
    estimate = estimate || {};
    return classify({
      address: lead.address || lead.propertyAddress || '',
      zip: lead.zip || lead.zipCode || '',
      state: lead.state || '',
      jobType: lead.jobType,
      mode: estimate.mode || estimate.jobMode || '',
      claimNumber: lead.claimNumber,
      insuranceCarrier: lead.insuranceCarrier,
      insCarrier: lead.insCarrier,
      insurance: (estimate.insurance === true) ? true : undefined
    });
  }

  // ── Business days (16 CFR 429.0) ─────────────────────────────────────────
  // "Any calendar day except Sunday or any federal holiday". Both the actual
  // date and the observed weekday of a fixed-date holiday are skipped, which
  // can only push the buyer's deadline later — never earlier.
  function _nthWeekday(y, m, dow, n) { // m 0-based; n = 1..5, or -1 for last
    if (n > 0) {
      var d = new Date(Date.UTC(y, m, 1));
      var add = (dow - d.getUTCDay() + 7) % 7 + (n - 1) * 7;
      return Date.UTC(y, m, 1 + add);
    }
    var last = new Date(Date.UTC(y, m + 1, 0));
    var back = (last.getUTCDay() - dow + 7) % 7;
    return Date.UTC(y, m, last.getUTCDate() - back);
  }
  function _federalHolidays(y) {
    var out = {};
    function add(t) { out[t] = true; }
    [[0, 1], [5, 19], [6, 4], [10, 11], [11, 25]].forEach(function (md) {
      var t = Date.UTC(y, md[0], md[1]);
      add(t);
      var dow = new Date(t).getUTCDay();
      if (dow === 6) add(t - 86400000);
      if (dow === 0) add(t + 86400000);
    });
    add(_nthWeekday(y, 0, 1, 3));  // Martin Luther King Jr. Day
    add(_nthWeekday(y, 1, 1, 3));  // Washington's Birthday
    add(_nthWeekday(y, 4, 1, -1)); // Memorial Day
    add(_nthWeekday(y, 8, 1, 1));  // Labor Day
    add(_nthWeekday(y, 9, 1, 2));  // Columbus Day
    add(_nthWeekday(y, 10, 4, 4)); // Thanksgiving Day
    // Next year's Jan 1 observed on this Dec 31.
    var ny = Date.UTC(y + 1, 0, 1);
    if (new Date(ny).getUTCDay() === 6) add(Date.UTC(y, 11, 31));
    return out;
  }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // ── The signing DATE is a local calendar date (2026-09-27 fix) ─────────
  // A contract signed at 10:30 pm in Kentucky or Ohio is dated that day, not
  // the next one: the date of the transaction (and the FTC deadline counted
  // from it) is the calendar date in the tenant's timezone — never the UTC
  // date of the instant, which is what Cloud Functions' clock (UTC) and a
  // browser elsewhere would otherwise print. America/New_York is NBD's zone
  // (Cincinnati + Northern Kentucky) and the default; a tenant profile may
  // carry its own IANA zone as `timezone` / `timeZone`.
  var DEFAULT_TIME_ZONE = 'America/New_York';
  function _validZone(z) {
    if (!z || typeof z !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }).format(0); return true; } catch (_) { return false; }
  }
  /** The tenant's timezone from a company profile (or brand), else America/New_York. */
  function resolveTimeZone(profile) {
    var p = profile || {};
    var b = p.brand || {};
    var cands = [p.timezone, p.timeZone, b.timezone, b.timeZone];
    for (var i = 0; i < cands.length; i++) if (_validZone(cands[i])) return cands[i];
    return DEFAULT_TIME_ZONE;
  }
  /** The calendar date of an instant in a timezone → UTC-midnight ms. */
  function _dayInZone(ms, tz) {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: _validZone(tz) ? tz : DEFAULT_TIME_ZONE,
      year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(ms));
    var get = function (type) { for (var i = 0; i < parts.length; i++) if (parts[i].type === type) return +parts[i].value; return NaN; };
    return Date.UTC(get('year'), get('month') - 1, get('day'));
  }
  /**
   * The calendar day a value names → UTC-midnight ms, or null.
   *   "2026-09-27" / "September 27, 2026"  a DATE — taken as written
   *   a Date, a timestamp, "2026-09-28T02:30:00Z"  an INSTANT — its date in
   *     `tz` (default America/New_York), never its UTC date
   */
  function toUtcDay(v, tz) {
    if (v == null || v === '') return null;
    if (typeof v === 'string') {
      var s = v.trim();
      var iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
      if (!/\d:\d/.test(s)) {           // a written date, no clock time
        var w = new Date(s);
        if (isNaN(w.getTime())) return null;
        return Date.UTC(w.getFullYear(), w.getMonth(), w.getDate());
      }
    }
    var d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return _dayInZone(d.getTime(), tz);
  }
  /** Today's calendar date in `tz` → UTC-midnight ms. */
  function todayIn(tz) { return _dayInZone(Date.now(), tz); }
  /** UTC-midnight ms → "2026-09-27". */
  function isoDay(t) { return new Date(t).toISOString().slice(0, 10); }
  function formatDay(t) {
    var d = new Date(t);
    return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
  }
  function isBusinessDay(t) {
    var d = new Date(t);
    if (d.getUTCDay() === 0) return false;
    return !_federalHolidays(d.getUTCFullYear())[t];
  }
  // ── The Kentucky cancellation window (KRS 367.622 / 367.626) ───────────
  // A Kentucky insurance contract can be cancelled "before midnight of the
  // fifth business day after" the homeowner receives the insurer's written
  // coverage decision, and KRS 367.626 bars requiring any payment before that
  // period expires (emergency work at a reasonable charge excepted, (3)).
  // Jo's rule (2026-09-27): nothing at signing; the deductible and the ACV
  // payment fall due after the written decision AND the 5-business-day
  // window. Business days here skip Saturday too — the conservative reading,
  // and it can only push the release later, never earlier.
  var KY_HOLD_DUE = 'After your insurer\u2019s written coverage decision and the 5-business-day cancellation window';
  function isKyBusinessDay(t) {
    var d = new Date(t);
    var dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return false;
    return !_federalHolidays(d.getUTCFullYear())[t];
  }
  /** The 5th Kentucky business day after the decision date (UTC-midnight ms), or null. */
  function kyWindowEnd(decisionDate, tz) {
    var t = toUtcDay(decisionDate, tz);
    if (t == null) return null;
    var cur = t, left = 5;
    while (left > 0) { cur += 86400000; if (isKyBusinessDay(cur)) left--; }
    return cur;
  }
  /**
   * May a Kentucky insurance job be asked for money yet? Only once the
   * carrier's written decision date is recorded AND the window has run
   * (today, in the tenant's zone, is after its last day).
   */
  function kyPaymentsReleased(decisionDate, now, tz) {
    var end = kyWindowEnd(decisionDate, tz);
    if (end == null) return false;
    var today = toUtcDay(now == null ? new Date() : now, tz);
    return today != null && today > end;
  }
  /**
   * payLinkHold(lead, invoice, now, tz) → { held, releaseDate }
   * The online payment link for an invoice is HELD when the job is a Kentucky
   * insurance job (classified from the lead; an invoice's kyInsuranceHold
   * flag can only add the hold) and the window after the carrier's written
   * decision (lead.carrierDecisionAt) has not run. An invoice marked
   * emergencyServices (KRS 367.626(3)) is never held.
   */
  function payLinkHold(lead, invoice, now, tz) {
    var inv = invoice || {};
    if (inv.emergencyServices === true) return { held: false, releaseDate: '' };
    var l = lead || null;
    var ky = !!(l && classify({
      address: l.address || '', zip: l.zip || '', state: l.state || '', jobType: l.jobType,
      claimNumber: l.claimNumber, insuranceCarrier: l.insuranceCarrier, insCarrier: l.insCarrier
    }).kyInsurance);
    if (!ky && inv.kyInsuranceHold !== true) return { held: false, releaseDate: '' };
    var decision = l ? l.carrierDecisionAt : null;
    return { held: !kyPaymentsReleased(decision, now, tz), releaseDate: kyReleaseDateText(decision, tz) };
  }

  /**
   * payUrlOf(invoice) → the homeowner's pay link, or ''.
   * Two writers, two fields: a payment link minted by the CRM is
   * stripePaymentLink; a Stripe Invoice (stripe-crm-invoice.js, and every
   * invoice the Stripe ledger mirrors in from the dashboard) is
   * stripeHostedUrl. Every surface read only stripePaymentLink, so the
   * Stripe invoices — all 7 in the 2026-10-03 prod audit — showed no Pay
   * button anywhere. http(s) only; anything else is ''.
   * Use payUrlUnlessHeld wherever the link reaches a homeowner.
   */
  function payUrlOf(invoice) {
    var inv = invoice || {};
    var cands = [inv.stripePaymentLink, inv.stripeHostedUrl];
    for (var i = 0; i < cands.length; i++) {
      var u = _str(cands[i]).trim();
      if (u && /^https?:\/\/[^\s"'<>]+$/i.test(u)) return u;
    }
    return '';
  }
  /**
   * payUrlUnlessHeld(lead, invoice, now, tz) → payUrlOf(invoice), or '' while
   * the Kentucky insurance hold (payLinkHold) applies. A hosted Stripe
   * invoice is minted outside createStripePaymentLink's gate (the ledger
   * mirrors dashboard invoices), so the hold is re-checked at every surface.
   */
  function payUrlUnlessHeld(lead, invoice, now, tz) {
    if (payLinkHold(lead, invoice, now, tz).held) return '';
    return payUrlOf(invoice);
  }

  /**
   * invoiceOverdue(invoice, lead, now, tz) → { pastDue, held, overdue, days }
   * THE overdue rule (review round 4 R4-6-6) — the server's overdue task
   * (invoice-overdue-logic.js), the Invoices tab, Money aging/Collections and
   * Today's plan all ask this, so they agree:
   *   pastDue  today, in the tenant's zone, is AFTER the due date's calendar
   *            day (due Oct 13 → overdue from Oct 14, whatever the clock time)
   *   held     the Kentucky pay hold applies (payLinkHold): KRS 367.626 bars
   *            asking for payment yet, so it is never overdue for collection
   *   overdue  pastDue && !held
   *   days     whole calendar days past due (0 unless overdue)
   * Whether the invoice is OWED (not paid/draft/void) is the caller's check
   * (invoice-owed.js). No readable due date: never overdue.
   */
  function _dueInstant(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'string') return v;
    if (typeof v.toDate === 'function') { try { return v.toDate(); } catch (_) { return null; } }
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return null; } }
    if (typeof v === 'object' && !(v instanceof Date) && typeof v.seconds === 'number') return v.seconds * 1000;
    return v;
  }
  function invoiceOverdue(invoice, lead, now, tz) {
    var inv = invoice || {};
    var none = { pastDue: false, held: false, overdue: false, days: 0 };
    var dueDay = toUtcDay(_dueInstant(inv.dueDate), tz);
    if (dueDay == null) return none;
    var today = toUtcDay(now == null ? new Date() : now, tz);
    if (today == null) return none;
    var pastDue = today > dueDay;
    var held = payLinkHold(lead || null, inv, now == null ? new Date() : now, tz).held;
    var overdue = pastDue && !held;
    return { pastDue: pastDue, held: held, overdue: overdue, days: overdue ? Math.round((today - dueDay) / 86400000) : 0 };
  }

  /** The first day payment may be asked for ("October 6, 2026"), or ''. */
  function kyReleaseDateText(decisionDate, tz) {
    var end = kyWindowEnd(decisionDate, tz);
    return end == null ? '' : formatDay(end + 86400000);
  }

  /** The Nth business day AFTER the given day, as a UTC-midnight ms. */
  function addBusinessDays(t, n) {
    var cur = t;
    var left = n;
    while (left > 0) {
      cur += 86400000;
      if (isBusinessDay(cur)) left--;
    }
    return cur;
  }

  // ── HTML (shared by the browser contract and the server PDF) ─────────────
  function esc(s) {
    return _str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 13px on screen, 10pt in print (KRS 367.624(3)/(4): "at least ten (10)
  // point boldface type"; 16 CFR 429.1: "bold face type of a minimum size of
  // 10 points"). The inline style is the floor if the <style> block is lost.
  var STATUTORY_CSS =
    '<style>' +
    '.nbd-statutory{font-weight:700 !important;font-size:13px !important;line-height:1.45;color:#111;}' +
    '.nbd-statutory p{margin:0 0 8px;font-weight:700 !important;font-size:13px !important;}' +
    '.nbd-noc-page{page-break-before:always;break-before:page;}' +
    '.nbd-noc{border:1.5px solid #111;padding:14px 16px;margin:0 0 6px;page-break-inside:avoid;break-inside:avoid;}' +
    '.nbd-noc-caption{text-align:center;font-weight:800 !important;letter-spacing:.06em;margin-bottom:8px;}' +
    '.nbd-noc-blank{display:inline-block;min-width:240px;border-bottom:1px solid #111;}' +
    '.nbd-noc-cut{border-top:2px dashed #555;margin:14px 0;position:relative;text-align:center;}' +
    '.nbd-noc-cut span{position:relative;top:-9px;background:#fff;padding:0 8px;font-size:10px;color:#444;font-weight:600;}' +
    '.nbd-noc-copy{font-size:10px;color:#444;text-align:right;margin-bottom:4px;font-weight:600;}' +
    '@media print{.nbd-statutory,.nbd-statutory p{font-size:10pt !important;}.nbd-noc-cut span{font-size:8pt;}}' +
    '</style>';
  var BOLD = 'font-weight:700;font-size:13px;';

  /** The two KRS 367.624(3) notices — place BEFORE the signature block. */
  function kyNoticesHtml() {
    return '<div class="nbd-statutory nbd-ky-notices" data-nbd-statutory="ky-367-624-3" style="' + BOLD +
      'border:1.5px solid #111;padding:12px 14px;margin:12px 0;page-break-inside:avoid;break-inside:avoid;">' +
      '<p style="' + BOLD + '">' + esc(KY_NOTICE_CANCEL) + '</p>' +
      '<p style="' + BOLD + 'margin-bottom:0;">' + esc(KY_NOTICE_NO_ASSIGNMENT) + '</p>' +
      '</div>';
  }

  /** 16 CFR 429.1(a) statement — place in immediate proximity to the buyer's signature. */
  function ftcStatementHtml() {
    return '<div class="nbd-statutory nbd-ftc-statement" data-nbd-statutory="ftc-429-1-a" style="' + BOLD +
      'margin:10px 0;">' + esc(FTC_STATEMENT) + '</div>';
  }

  function _blank(value, label) {
    var v = _str(value).trim();
    return v ? esc(v) : '<span class="nbd-noc-blank">&nbsp;</span> <span style="font-weight:400;">(' + esc(label) + ')</span>';
  }
  function _cut(label) {
    return '<div class="nbd-noc-cut" aria-hidden="true"><span>&#9986; ' + esc(label) + '</span></div>';
  }
  function _sigLines(buyerLabel) {
    return '<div style="margin-top:14px;">' +
      '<div class="nbd-noc-blank" style="min-width:260px;">&nbsp;</div><div style="font-weight:700;">(Date)</div>' +
      '<div class="nbd-noc-blank" style="min-width:260px;margin-top:18px;">&nbsp;</div><div style="font-weight:700;">' + esc(buyerLabel) + '</div>' +
      '</div>';
  }

  /**
   * KRS 367.624(4): the NOTICE OF CANCELLATION, fully completed, in duplicate,
   * on its own page after the signatures, each copy detachable.
   * opts: { transactionDate, physicalAddress, email, fax, timeZone }
   * transactionDate: a written date as-is, or an instant (default: now) read
   * as its calendar date in timeZone (default America/New_York).
   */
  function kyCancellationFormsHtml(opts) {
    opts = opts || {};
    var t = toUtcDay(opts.transactionDate == null || opts.transactionDate === '' ? new Date() : opts.transactionDate, opts.timeZone);
    var dateText = t != null ? formatDay(t) : _str(opts.transactionDate);
    var fax = _str(opts.fax).trim() || NO_FAX_TEXT;
    function one(copyLabel) {
      return '<div class="nbd-noc nbd-statutory" data-nbd-noc="ky" style="' + BOLD + '">' +
        '<div class="nbd-noc-copy">' + esc(copyLabel) + '</div>' +
        '<div class="nbd-noc-caption">' + esc(KY_FORM_CAPTION) + '</div>' +
        '<p style="' + BOLD + '">' + _blank(dateText, 'enter date of transaction') + '<br>(Date of transaction)</p>' +
        '<p style="' + BOLD + '">' +
          esc(KY_FORM_BODY_PARTS[0]) + _blank(opts.physicalAddress, 'physical address of contractor') +
          esc(KY_FORM_BODY_PARTS[1]) + _blank(opts.email, 'email address of contractor') +
          esc(KY_FORM_BODY_PARTS[2]) + esc(fax) +
          esc(KY_FORM_BODY_PARTS[3]) +
        '</p>' +
        '<p style="' + BOLD + '">' + esc(CANCEL_LINE) + '</p>' +
        _sigLines("(Buyer's Signature)") +
        '</div>';
    }
    return '<div class="nbd-noc-page" data-nbd-noc-page="ky" style="page-break-before:always;break-before:page;padding-top:8px;">' +
      '<div style="font-size:11px;color:#444;margin-bottom:10px;">Kentucky Revised Statutes 367.624(4) — two copies of this form are attached. Cut along the dashed line to detach a copy.</div>' +
      _cut('Detach along this line') +
      one('Copy 1 of 2 — Buyer') +
      _cut('Detach along this line') +
      one('Copy 2 of 2 — Buyer') +
      _cut('Detach along this line') +
      '</div>';
  }

  /**
   * 16 CFR 429.1(b)/(c): the FTC NOTICE OF CANCELLATION, completed, in
   * duplicate. opts: { transactionDate, sellerName, sellerAddress, timeZone }
   * The deadline counts business days from the LOCAL signing date.
   */
  function ftcCancellationFormsHtml(opts) {
    opts = opts || {};
    var t = toUtcDay(opts.transactionDate == null || opts.transactionDate === '' ? new Date() : opts.transactionDate, opts.timeZone);
    var dateText = t != null ? formatDay(t) : _str(opts.transactionDate);
    var deadline = t != null ? formatDay(addBusinessDays(t, 3)) : '';
    function one(copyLabel) {
      return '<div class="nbd-noc nbd-statutory" data-nbd-noc="ftc" style="' + BOLD + '">' +
        '<div class="nbd-noc-copy">' + esc(copyLabel) + '</div>' +
        '<div class="nbd-noc-caption">' + esc(FTC_FORM_CAPTION) + '</div>' +
        '<p style="' + BOLD + '">' + _blank(dateText, 'enter date of transaction') + '<br>(Date)</p>' +
        FTC_FORM_PARAS.map(function (p) { return '<p style="' + BOLD + '">' + esc(p) + '</p>'; }).join('') +
        '<p style="' + BOLD + '">To cancel this transaction, mail or deliver a signed and dated copy of this Cancellation Notice or any other written notice, or send a telegram, to ' +
          _blank(opts.sellerName, 'Name of seller') + ', at ' + _blank(opts.sellerAddress, "address of seller's place of business") +
          ' NOT LATER THAN MIDNIGHT OF ' + _blank(deadline, 'date') + '.</p>' +
        '<p style="' + BOLD + '">' + esc(CANCEL_LINE) + '</p>' +
        _sigLines("(Buyer's signature)") +
        '</div>';
    }
    return '<div class="nbd-noc-page" data-nbd-noc-page="ftc" style="page-break-before:always;break-before:page;padding-top:8px;">' +
      '<div style="font-size:11px;color:#444;margin-bottom:10px;">Federal Trade Commission Cooling-Off Rule (16 CFR 429.1) — two copies of this form are attached. Cut along the dashed line to detach a copy.</div>' +
      _cut('Detach along this line') +
      one('Copy 1 of 2 — Buyer') +
      _cut('Detach along this line') +
      one('Copy 2 of 2 — Buyer') +
      _cut('Detach along this line') +
      '</div>';
  }

  // ── The Notice of Right to Cancel packet (2026-10-04) ─────────────────────
  // Contracts signed IN THE APP (in person on the phone, the deal page's
  // "Sign on this phone", a remote signing link) carried no FTC Notice of
  // Cancellation: only the server-rendered PDF attached it. 16 CFR 429.1 and
  // the Ohio / Kentucky home solicitation laws want the buyer to get the
  // notice and two completed forms AT THE TIME OF SALE. This packet is the
  // body of the template library's "Notice of Right to Cancel" (the same
  // statement, steps and forms), attached to every contract-class document.
  //
  // It is wrapped in two comment markers and carries its own inputs
  // (data-nbd-cancel-opts), so whoever records the signature can re-date it
  // to the day the buyer actually signed (restampCancelPacket) — a contract
  // generated Monday and signed Wednesday must say Wednesday, and count the
  // three business days from Wednesday. The server re-dates remote and
  // deal-page signings itself, from the copy it served, never from the
  // signer's bytes.
  var HOME_SOLICITATION_LAW = {
    OH: "Ohio's Home Solicitation Sales Act (Ohio Revised Code 1345.21 to 1345.28)",
    KY: "Kentucky's home solicitation sales law (Kentucky Revised Statutes 367.410 to 367.460)"
  };
  var PACKET_START = '<!--nbd-cancel-packet:start-->';
  var PACKET_END = '<!--nbd-cancel-packet:end-->';
  var PACKET_RE = /<!--nbd-cancel-packet:start-->[\s\S]*?<!--nbd-cancel-packet:end-->/g;
  // Stages that start the work. Moving a job into one of them inside the
  // cancellation window gets a warning (never a block).
  var WORK_START_STAGES = ['materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress', 'install_complete'];

  /** The last day to cancel (UTC-midnight ms): 3 business days after the local transaction date. */
  function cancelByDay(transactionDate, tz) {
    var t = toUtcDay(transactionDate == null || transactionDate === '' ? new Date() : transactionDate, tz);
    return t == null ? null : addBusinessDays(t, 3);
  }
  /** The last day to cancel as "2026-10-07", or ''. */
  function cancelBy(transactionDate, tz) {
    var t = cancelByDay(transactionDate, tz);
    return t == null ? '' : isoDay(t);
  }
  function _isoToDay(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(_str(iso).trim());
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
  }
  /** Is the buyer still inside the window? True through the whole cancelBy day (midnight). */
  function cancelWindowOpen(cancelByIso, now, tz) {
    var end = _isoToDay(cancelByIso);
    if (end == null) return false;
    var today = toUtcDay(now == null ? new Date() : now, tz);
    return today != null && today <= end;
  }
  /** "October 7, 2026" for a stored cancelBy, or ''. */
  function cancelByText(cancelByIso) {
    var t = _isoToDay(cancelByIso);
    return t == null ? '' : formatDay(t);
  }
  /**
   * The soft warning for a stage move that starts work inside the window, or
   * ''. Warn, never block (Jo, 2026-10-04).
   */
  function workStartWarning(lead, nextStage, now, tz) {
    if (WORK_START_STAGES.indexOf(_str(nextStage)) === -1) return '';
    var cb = lead && lead.cancelBy;
    if (!cancelWindowOpen(cb, now, tz)) return '';
    return 'This job is still in the 3-day cancellation window (it ends at midnight on ' + cancelByText(cb) +
      '). The homeowner can still cancel without penalty.';
  }

  /**
   * The "How to cancel" steps (escaped HTML), shared with the library template.
   * o.strongClass: wrap the deadline in <span class="…"> instead of <strong>
   * (the library's own emphasis class, so its document is unchanged).
   */
  function cancelHowToSteps(o) {
    o = o || {};
    var co = esc(o.sellerName || 'us');
    var sOpen = o.strongClass ? '<span class="' + esc(o.strongClass) + '">' : '<strong>';
    var sClose = o.strongClass ? '</span>' : '</strong>';
    return [
      'Fill in and sign one of the two Notice of Cancellation forms attached to this notice.',
      'Mail it, or deliver it, to ' + co + (o.sellerAddress ? ' at ' + esc(o.sellerAddress) : ' at the address on the form') +
        (o.deadlineText ? ' — it must be sent before midnight of ' + sOpen + esc(o.deadlineText) + sClose + '.'
          : ' — before midnight of the third business day after the contract date.'),
      'Keep the other copy for your records.',
      'If you cancel, anything you paid is returned within 10 business days of our receiving your notice.'
    ];
  }
  function homeSolicitationLawText(state) {
    var s = HOME_SOLICITATION_LAW[_str(state).toUpperCase()];
    return s ? 'federal law (the FTC Cooling-Off Rule) and ' + s
      : 'federal law (the FTC Cooling-Off Rule) and your state’s home solicitation sales law';
  }

  var CANCEL_PACKET_CSS =
    '<style>' +
    '.nbd-cxl{background:#fff;color:#111;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5;padding:16px;border-radius:8px;margin:16px 0 0;page-break-before:always;break-before:page;text-align:left;}' +
    '.nbd-cxl h2{font-size:18px;letter-spacing:.04em;text-transform:uppercase;text-align:center;margin:0 0 4px;color:#111;}' +
    '.nbd-cxl-sub{text-align:center;color:#444;font-size:12px;margin:0 0 12px;}' +
    '.nbd-cxl-h{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px;color:#111;}' +
    '.nbd-cxl-kv{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0 0 6px;}' +
    '.nbd-cxl-kv div{flex:1 1 180px;min-width:0;}' +
    '.nbd-cxl-kv dt{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#555;margin:0;}' +
    '.nbd-cxl-kv dd{margin:2px 0 0;font-weight:700;overflow-wrap:anywhere;}' +
    '.nbd-cxl ol{margin:0;padding-left:20px;}.nbd-cxl li{margin:0 0 6px;}' +
    '.nbd-cxl p{margin:0 0 8px;}' +
    '.nbd-cxl-ack{margin-top:12px;font-size:12px;color:#222;}' +
    // Read on a phone (the doc viewer, sign.html, the deal page): no text
    // under 12px and nothing wider than the screen. Screen only — the
    // printed / PDF'd record keeps the paper sizes above.
    '@media screen and (max-width:600px){' +
      '.nbd-cxl{padding:12px;}' +
      '.nbd-cxl-kv dt,.nbd-cxl .nbd-noc-copy,.nbd-cxl .nbd-noc-cut span,.nbd-cxl .nbd-noc-page>div[style*="font-size:11px"]{font-size:12px !important;}' +
      '.nbd-cxl .nbd-noc{padding:12px;}' +
      '.nbd-cxl .nbd-noc-blank{min-width:0 !important;width:75%;max-width:100%;}' +
    '}' +
    '</style>';

  /**
   * The Notice of Right to Cancel + the two completed FTC forms (+ the KY
   * 367.624(3) notices and (4) forms on a Kentucky insurance job).
   * opts: { transactionDate, timeZone, sellerName, sellerAddress, email, fax,
   *         homeownerName, propertyAddress, state, kyInsurance,
   *         kyNoticesInDocument }
   * kyNoticesInDocument: the document the packet is attached to already prints
   * the KRS 367.624(3) notices before its signatures (the contract, the deal
   * page) — the packet then points to them instead of printing them twice.
   */
  function cancelPacketHtml(opts) {
    opts = opts || {};
    var tz = _validZone(opts.timeZone) ? opts.timeZone : DEFAULT_TIME_ZONE;
    var tx = (opts.transactionDate == null || opts.transactionDate === '') ? new Date() : opts.transactionDate;
    var t = toUtcDay(tx, tz);
    var dateText = t != null ? formatDay(t) : _str(tx);
    var endT = t != null ? addBusinessDays(t, 3) : null;
    var deadline = endT != null ? formatDay(endT) : '';
    var ky = opts.kyInsurance === true;
    var stored = {
      timeZone: tz, sellerName: _str(opts.sellerName), sellerAddress: _str(opts.sellerAddress),
      email: _str(opts.email), fax: _str(opts.fax), homeownerName: _str(opts.homeownerName),
      propertyAddress: _str(opts.propertyAddress), state: _str(opts.state), kyInsurance: ky,
      kyNoticesInDocument: opts.kyNoticesInDocument === true
    };
    var kv = [['Homeowner', stored.homeownerName], ['Property', stored.propertyAddress], ['Contract date', dateText],
      ['Last day to cancel', deadline ? deadline + ' (before midnight)' : '']];
    var steps = cancelHowToSteps({ sellerName: stored.sellerName, sellerAddress: stored.sellerAddress, deadlineText: deadline });
    var kyPart = ky
      ? '<div class="nbd-cxl-h">Kentucky insurance job: a second right to cancel</div>' +
        '<p>Because this work may be paid by your insurance, Kentucky law gives you another right: if your insurer tells you in ' +
        'writing that any part of the work is not covered, you may cancel within five business days of getting that notice. ' +
        'A separate form for that is attached.</p>' +
        (stored.kyNoticesInDocument ? '<p>The two Kentucky notices this right comes from are printed above your signature on the contract.</p>' : kyNoticesHtml())
      : '';
    return PACKET_START +
      '<div class="nbd-cxl" data-nbd-cancel-packet="1" data-nbd-cancel-by="' + (endT != null ? isoDay(endT) : '') +
        '" data-nbd-cancel-opts="' + encodeURIComponent(JSON.stringify(stored)) + '">' +
      STATUTORY_CSS + CANCEL_PACKET_CSS +
      '<h2>Notice of Right to Cancel</h2>' +
      '<p class="nbd-cxl-sub">Contract date: ' + esc(dateText) + '</p>' +
      '<p>You signed a contract with ' + esc(stored.sellerName || 'us') + ' at your home. Under ' + esc(homeSolicitationLawText(stored.state)) +
        ', you can cancel it within three business days without any penalty or obligation.</p>' +
      '<dl class="nbd-cxl-kv">' + kv.map(function (r) {
        return '<div><dt>' + esc(r[0]) + '</dt><dd>' + (r[1] ? esc(r[1]) : '&mdash;') + '</dd></div>';
      }).join('') + '</dl>' +
      '<div class="nbd-cxl-h">How to cancel</div>' +
      '<ol>' + steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>' +
      ftcStatementHtml() +
      kyPart +
      '<p class="nbd-cxl-ack">The homeowner received this notice and two completed copies of the Notice of Cancellation form on ' +
        esc(dateText) + '.</p>' +
      ftcCancellationFormsHtml({ transactionDate: tx, timeZone: tz, sellerName: stored.sellerName, sellerAddress: stored.sellerAddress }) +
      (ky ? kyCancellationFormsHtml({ transactionDate: tx, timeZone: tz, physicalAddress: stored.sellerAddress, email: stored.email, fax: stored.fax }) : '') +
      '</div>' + PACKET_END;
  }

  function _packetOpts(block) {
    var m = /data-nbd-cancel-opts="([^"]*)"/.exec(block);
    if (!m) return null;
    try { return JSON.parse(decodeURIComponent(m[1].replace(/&amp;/g, '&'))); } catch (_) { return null; }
  }
  /** Does this HTML carry the packet (and its two FTC forms)? */
  function hasCancelPacket(html) {
    var s = _str(html);
    var m = s.match(PACKET_RE);
    if (!m) return false;
    return (m[0].match(/data-nbd-noc="ftc"/g) || []).length === 2;
  }
  /** The stored "last day to cancel" of the packet in this HTML, or ''. */
  function packetCancelBy(html) {
    var m = _str(html).match(PACKET_RE);
    if (!m) return '';
    var b = /data-nbd-cancel-by="(\d{4}-\d{2}-\d{2})"/.exec(m[0]);
    return b ? b[1] : '';
  }
  /** The HTML with every packet removed (for comparing a signed copy to its original). */
  function stripCancelPacket(html) {
    return _str(html).replace(PACKET_RE, '');
  }
  /**
   * Re-date the packet(s) in `html` to `transactionDate` (default now), from
   * the inputs stored in `sourceHtml`'s packet (default: `html`'s own).
   * HTML without a packet comes back unchanged.
   */
  function restampCancelPacket(html, transactionDate, sourceHtml) {
    var s = _str(html);
    var src = _str(sourceHtml == null ? html : sourceHtml).match(PACKET_RE);
    var opts = src ? _packetOpts(src[0]) : null;
    if (!opts) return s;
    var packet = cancelPacketHtml(Object.assign({}, opts, {
      transactionDate: transactionDate == null || transactionDate === '' ? new Date() : transactionDate
    }));
    return s.replace(PACKET_RE, function () { return packet; });
  }

  /**
   * Remove the "Insurance assignment(s) accepted." sentence from a payment
   * terms string. Applied to every job since the AOB was retired (2026-09-27):
   * a tenant's saved boilerplate may still carry it.
   */
  function stripAssignmentSentences(text) {
    return _str(text).replace(/\s*Insurance assignments? accepted\.?/gi, '').replace(/\s{2,}/g, ' ').trim();
  }

  // ── Payment clause (Jo, 2026-09-27) ──────────────────────────────────────
  // Jo's rule: no Assignment of Benefits, no direction to pay, no co-payee
  // instrument of any kind, in any state. Every contract (client and server
  // renderers print this same string) says plainly how it is paid and that it
  // moves nothing under the homeowner's policy. Worded so it never needs the
  // words a guard test forbids on contracts.
  /**
   * The contractor's address for the paperwork that legally requires one
   * (Jo, 2026-09-27): brand.contact.mailingAddress — the Company Profile
   * "Mailing Address (one line)" field, the same one the CAN-SPAM footer
   * prints. NEVER businessAddress (the letterhead / microsite field), so the
   * address appears only where the law puts it. Accepts a company profile
   * ({ brand: { contact } }) or a brand ({ contact }).
   */
  function contractorMailingAddress(src) {
    var s = src || {};
    var c = (s.brand && s.brand.contact) || s.contact || {};
    return _str(c.mailingAddress).trim();
  }

  var PAYMENT_CLAUSE =
    'Homeowner will pay Contractor the contract price according to the payment schedule above. Homeowner may pay from ' +
    'insurance proceeds, personal funds, financing, or any combination. This contract does not transfer or give Contractor ' +
    'any rights or benefits under Homeowner\u2019s insurance policy, and Contractor will not represent Homeowner or act for ' +
    'Homeowner on any insurance claim.';

  return {
    KY_NOTICE_CANCEL: KY_NOTICE_CANCEL,
    KY_NOTICE_NO_ASSIGNMENT: KY_NOTICE_NO_ASSIGNMENT,
    KY_FORM_CAPTION: KY_FORM_CAPTION,
    KY_FORM_BODY_PARTS: KY_FORM_BODY_PARTS.slice(),
    KY_LIEN_CLAUSE: KY_LIEN_CLAUSE,
    CANCEL_LINE: CANCEL_LINE,
    NO_FAX_TEXT: NO_FAX_TEXT,
    FTC_STATEMENT: FTC_STATEMENT,
    FTC_FORM_PARAS: FTC_FORM_PARAS.slice(),
    MSG: MSG,
    STATUTORY_CSS: STATUTORY_CSS,
    zipOf: zipOf,
    stateFromZip: stateFromZip,
    stateFromAddress: stateFromAddress,
    isInsurance: isInsurance,
    JOB_TYPES: JOB_TYPES.slice(),
    normJobType: normJobType,
    claimSignals: claimSignals,
    hasClaimSignals: hasClaimSignals,
    claimPanelMode: claimPanelMode,
    classify: classify,
    classifyLead: classifyLead,
    DEFAULT_TIME_ZONE: DEFAULT_TIME_ZONE,
    resolveTimeZone: resolveTimeZone,
    toUtcDay: toUtcDay,
    todayIn: todayIn,
    isoDay: isoDay,
    formatDay: formatDay,
    isBusinessDay: isBusinessDay,
    KY_HOLD_DUE: KY_HOLD_DUE,
    isKyBusinessDay: isKyBusinessDay,
    kyWindowEnd: kyWindowEnd,
    kyPaymentsReleased: kyPaymentsReleased,
    kyReleaseDateText: kyReleaseDateText,
    payLinkHold: payLinkHold,
    invoiceOverdue: invoiceOverdue,
    payUrlOf: payUrlOf,
    payUrlUnlessHeld: payUrlUnlessHeld,
    addBusinessDays: addBusinessDays,
    esc: esc,
    kyNoticesHtml: kyNoticesHtml,
    ftcStatementHtml: ftcStatementHtml,
    kyCancellationFormsHtml: kyCancellationFormsHtml,
    ftcCancellationFormsHtml: ftcCancellationFormsHtml,
    stripAssignmentSentences: stripAssignmentSentences,
    HOME_SOLICITATION_LAW: HOME_SOLICITATION_LAW,
    WORK_START_STAGES: WORK_START_STAGES.slice(),
    cancelByDay: cancelByDay,
    cancelBy: cancelBy,
    cancelWindowOpen: cancelWindowOpen,
    cancelByText: cancelByText,
    workStartWarning: workStartWarning,
    cancelHowToSteps: cancelHowToSteps,
    homeSolicitationLawText: homeSolicitationLawText,
    cancelPacketHtml: cancelPacketHtml,
    hasCancelPacket: hasCancelPacket,
    packetCancelBy: packetCancelBy,
    stripCancelPacket: stripCancelPacket,
    restampCancelPacket: restampCancelPacket,
    PAYMENT_CLAUSE: PAYMENT_CLAUSE,
    contractorMailingAddress: contractorMailingAddress
  };
});
