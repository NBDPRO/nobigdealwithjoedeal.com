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
 * Not legal advice — counsel should review notice placement and e-delivery.
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
  // No fax: the statute's blank is "if applicable" in 367.624(2). Flagged for
  // counsel — this is the only wording choice made inside the form.
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
      'Kentucky insurance contracts must show your business mailing and physical address. Add your full street address in ' +
      'Settings → Company Profile → Letterhead → "Mailing Address (one line)" (street, city, state, ZIP), then Save Company Profile.',
    depositHold:
      'Kentucky insurance job: nothing is due at signing (KRS 367.626). The deductible and ACV payment become due after the ' +
      'insurer\'s written coverage decision and the 5-business-day cancellation window. Bill emergency tarp or repair work ' +
      '(KRS 367.626(3)) on its own invoice.',
    payLinkHeld:
      'Online payment link withheld: Kentucky insurance job (KRS 367.626). Record the date the carrier\'s written coverage ' +
      'decision arrived on the lead (Claim section → "Carrier decision received"); the link can be created 5 business days ' +
      'later. Emergency tarp or repair invoices can be marked Emergency and billed now (KRS 367.626(3)).',
    aobRetired:
      'The Assignment of Benefits has been retired. Use the Direction to Pay instead: it has the insurer pay you for the work ' +
      'without assigning any of the homeowner\'s policy rights.',
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
   * state in count, so "1944 Kentucky Ave" or a street ending in "Ct" never
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
    var jt = _str(ctx.jobType).trim().toLowerCase();
    var mode = _str(ctx.mode || ctx.jobMode).trim().toLowerCase();
    if (jt === 'insurance' || mode === 'insurance') return true;
    if (ctx.isInsurance === true || ctx.isInsuranceJob === true || ctx.insuranceClaim === true || ctx.insurance === true) return true;
    if (_present(ctx.claimNumber)) return true;
    if (_present(ctx.insuranceCarrier) || _present(ctx.insCarrier) || _present(ctx.insuranceCompany)) return true;
    var ins = ctx.insurance;
    if (ins && typeof ins === 'object' && (_present(ins.claimNumber) || _present(ins.carrier))) return true;
    return false;
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

  /**
   * Remove the "Insurance assignment(s) accepted." sentence from a payment
   * terms string. Applied to every job since the AOB was retired (2026-09-27):
   * a tenant's saved boilerplate may still carry it.
   */
  function stripAssignmentSentences(text) {
    return _str(text).replace(/\s*Insurance assignments? accepted\.?/gi, '').replace(/\s{2,}/g, ' ').trim();
  }

  // ── Direction to Pay (Jo, 2026-09-27) ────────────────────────────────────
  // Replaces the Assignment of Benefits in EVERY state. KRS 304.20-105(4)(b)
  // leaves "authorizing or directing payment to ... a person for services"
  // untouched by the anti-assignment rule; Ohio has no equivalent bar but Jo
  // chose one form for both states. DRAFT WORDING, kept minimal on purpose —
  // for Jo's attorney to review before first use. It names the contractor as
  // payee and does nothing else: no assignment of policy rights or benefits,
  // no authority over the claim, the homeowner keeps control.
  var DTP_NOT_ASSIGNMENT =
    'This is a direction to pay only. It does not assign or transfer any of the homeowner\u2019s rights or benefits under the ' +
    'insurance policy, and it gives the contractor no authority to adjust, settle or bargain over the claim or to act for the ' +
    'homeowner with the insurer. The homeowner keeps full control of the claim.';
  /** The contract / work-authorization clause, naming the contractor. */
  function directionToPayText(contractorName) {
    var n = _str(contractorName).trim() || 'the contractor';
    return 'If any of this work is paid from an insurance claim, the homeowner directs the insurance company to include ' + n +
      ' as a payee on, or to pay ' + n + ' directly, any payment for the work in this contract, up to the contract price. ' +
      DTP_NOT_ASSIGNMENT;
  }
  /** A Direction to Pay clause prints on insurance jobs, in every state. */
  function showsDirectionToPay(j) {
    return !!(j && j.insurance);
  }

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
    addBusinessDays: addBusinessDays,
    esc: esc,
    kyNoticesHtml: kyNoticesHtml,
    ftcStatementHtml: ftcStatementHtml,
    kyCancellationFormsHtml: kyCancellationFormsHtml,
    ftcCancellationFormsHtml: ftcCancellationFormsHtml,
    stripAssignmentSentences: stripAssignmentSentences,
    DTP_NOT_ASSIGNMENT: DTP_NOT_ASSIGNMENT,
    directionToPayText: directionToPayText,
    showsDirectionToPay: showsDirectionToPay
  };
});
