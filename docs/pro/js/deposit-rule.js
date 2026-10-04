/**
 * deposit-rule.js — THE deposit rule. Every surface that computes or prints a
 * deposit, down payment or "due at signing" amount asks this file.
 *
 * Jo's rule (2026-09-25, authoritative):
 *   • CASH jobs under $2,000 total: no deposit — payment due on completion.
 *   • CASH jobs $2,000 and up: 50% deposit at signing, balance on completion.
 *   • INSURANCE-claim jobs: the homeowner's DEDUCTIBLE plus the insurance ACV
 *     payment (the carrier's first check), both up front when possible; the
 *     MINIMUM is the deductible. The deductible is always collected — never
 *     waived, reduced, rebated or absorbed (illegal in OH/KY) — and no sentence
 *     this file writes may imply otherwise. ACV not known yet: the deposit is
 *     the deductible, and the copy says the ACV payment is due when the
 *     carrier releases it.
 *
 * WHY one file (2026-09-25): the app contradicted itself. V2's on-screen
 * Retail Quote fell back to 50/50, the server Retail Quote PDF hard-coded
 * "25% at contract signing", invoices defaulted to 50%, insurance quotes
 * printed a $0 deposit, the contract defaulted to "Fifty percent", and Job
 * Templates saved no deposit at all (so a $555 repair invoiced a 50% deposit).
 * Each of those now calls compute() / fromEstimate() below instead of doing
 * its own arithmetic.
 *
 * Thresholds: window.NBD_ESTIMATE_CONFIG.DEPOSIT_RULE (estimate-config.js),
 * tenant-overridable later. customer.html does not load estimate-config.js, so
 * DEFAULTS below is the fallback; tests/deposit-rule.test.js holds the two
 * equal so they cannot drift.
 *
 * Money is integer cents throughout, and deposit + balance === total exactly.
 *
 * The ACV input is the carrier scope's ACTUAL CASH VALUE line (RCV minus
 * depreciation, before the deductible) — the `acv` field the classic builder,
 * V2's claim block and estimate-finalization's insurance scope already carry.
 * The carrier's first check is ACV − deductible, so "deductible + ACV check"
 * equals the ACV value whenever the ACV exceeds the deductible.
 *
 * KENTUCKY INSURANCE JOBS (Jo, 2026-09-27; KRS 367.626): NOTHING is due at
 * signing. The deductible and the ACV payment are due after the insurer's
 * written coverage decision and the 5-business-day cancellation window; the
 * balance on completion. Emergency tarp/repair work stays billable on its own
 * invoice (367.626(3)). A rep override cannot raise it. Which jobs: the
 * caller passes the job's location (address / zip / state / jurisdiction) and
 * ky-insurance-law.js decides — Kentucky, or an insurance job whose state
 * cannot be read (fail closed, the same test the contract uses). A caller
 * that passes NO location (legacy / unit callers) gets the rule as before.
 * Ohio and cash jobs are unchanged.
 *
 * Persisted plans (toStored) carry display strings and cents only — never a
 * cost figure — so the homeowner portal can print exactly what the rep's
 * paperwork printed without running this file server-side.
 */
(function () {
  'use strict';

  var DEFAULTS = Object.freeze({
    CASH_NO_DEPOSIT_UNDER_CENTS: 200000, // cash under $2,000.00 → no deposit
    CASH_DEPOSIT_PCT: 50,                // cash $2,000.00 and up → 50% at signing
    CASH_DEPOSIT_ROUND_TO_CENTS: 2500    // the percentage deposit rounds to the nearest $25 (the grand-total step)
  });

  var ACV_WORDS = 'insurance ACV payment (your carrier’s first check)';
  var KY_DUE = 'After your insurer’s written coverage decision and the 5-business-day cancellation window';
  var KY_REP_NOTE = 'Kentucky insurance job: nothing is due at signing (KRS 367.626). The deductible and ACV payment become due after ' +
    'the insurer’s written coverage decision and the 5-business-day cancellation window. Bill emergency tarp or repair work ' +
    '(KRS 367.626(3)) on its own invoice.';

  function _jurisdictionApi() {
    var r = _root();
    if (r && r.NBDJurisdiction) return r.NBDJurisdiction;
    if (typeof require === 'function') {
      try { return require('./ky-insurance-law.js'); } catch (_) { /* browser / sandbox */ }
    }
    return null;
  }

  // Does this insurance job get the Kentucky hold? An explicit flag, a stamped
  // jurisdiction, or — when the caller passed the job's location at all —
  // ky-insurance-law.js's classification (Kentucky, or no readable state).
  // When input.lead is passed, its own address / zip / state fill in any the
  // caller left blank, and the lead counts as "location passed".
  function _kyHold(input, insurance) {
    if (!insurance) return false;
    if (input.kentucky === true || input.kyInsurance === true) return true;
    var j = input.jurisdiction;
    if (j && typeof j === 'object' && (j.kyInsurance === true || j.kentucky === true)) return true;
    var lead = (input.lead && typeof input.lead === 'object') ? input.lead : null;
    var hasLoc = !!lead || Object.prototype.hasOwnProperty.call(input, 'address') ||
      Object.prototype.hasOwnProperty.call(input, 'zip') || Object.prototype.hasOwnProperty.call(input, 'state');
    if (!hasLoc) return false;
    var J = _jurisdictionApi();
    if (!J) return false;
    var l = lead || {};
    return J.classify({
      address: input.address || l.address || l.propertyAddress || '',
      zip: input.zip || l.zip || l.zipCode || '',
      state: input.state || l.state || '',
      mode: 'insurance'
    }).kyInsurance === true;
  }

  // Is the LEAD an insurance job, whatever mode the estimate was priced in?
  // The SAME ky-insurance-law.js isInsurance test, on the same lead fields,
  // that puts the KRS 367.624 notices on the contract
  // (document-generator.js _jurisdiction, ky-insurance-law.js payLinkHold):
  // jobType 'insurance', a claim number or a carrier on file. Before
  // 2026-10-03 only est.mode === 'insurance' counted here, so a Kentucky lead
  // with a claim priced in cash / per-square mode got the KY notices AND a
  // 30-50% deposit at signing — an advance payment KRS 367.626 forbids.
  function _leadInsurance(lead) {
    if (!lead || typeof lead !== 'object') return false;
    var J = _jurisdictionApi();
    if (!J || typeof J.isInsurance !== 'function') return false;
    return J.isInsurance({
      jobType: lead.jobType, claimNumber: lead.claimNumber,
      insuranceCarrier: lead.insuranceCarrier, insCarrier: lead.insCarrier
    }) === true;
  }

  // The Kentucky insurance plan: $0 at signing; the deductible + ACV payment
  // after the window; the balance on completion. Amounts shown when known.
  function _kyPlan(totalCents, dedCents, acvCents) {
    var mode = 'insurance';
    var base = { rule: 'insurance-ky', mode: mode, totalCents: totalCents, depositCents: 0, kyHold: true,
      label: 'Due at signing', valueText: fmtCents(0), repNote: KY_REP_NOTE,
      terms: 'Nothing at signing; your deductible and insurance ACV payment ' + KY_DUE.charAt(0).toLowerCase() + KY_DUE.slice(1) +
        '; the balance on completion.' };
    if (dedCents == null) {
      base.needsDeductible = true;
      base.summary = 'Nothing is due at signing. Your insurance deductible and your ' + ACV_WORDS + ' are due after your insurer’s ' +
        'written coverage decision and the 5-business-day cancellation window, and the rest of the balance is due on completion.';
      base.rows = [
        _row('deductible', 'Your deductible', KY_DUE, null, 'Per your policy'),
        _row('acv', 'Insurance ACV payment (your carrier’s first check)', KY_DUE, null, 'Set by your carrier'),
        _row('balance', 'Balance', 'On completion', null, 'Remainder of ' + fmtCents(totalCents))
      ];
      return _plan(base);
    }
    var acvCheck = (acvCents == null) ? null : Math.max(0, acvCents - dedCents);
    base.deductibleCents = dedCents; base.acvValueCents = acvCents; base.acvCheckCents = acvCheck;
    if (dedCents >= totalCents) {
      base.summary = 'Nothing is due at signing. The job total of ' + fmtCents(totalCents) + ' is at or below your ' + fmtCents(dedCents) +
        ' deductible, and it is due after your insurer’s written coverage decision and the 5-business-day cancellation window.';
      base.rows = [_row('deductible', 'Job total (at or below your deductible)', KY_DUE, totalCents)];
      return _plan(base);
    }
    if (acvCheck != null && acvCheck > 0) {
      var later = Math.min(totalCents, dedCents + acvCheck);
      var acvPart = later - dedCents;
      var rest = totalCents - later;
      base.rows = [
        _row('deductible', 'Your deductible', KY_DUE, dedCents),
        _row('acv', 'Insurance ACV payment (your carrier’s first check)', KY_DUE, acvPart)
      ];
      if (rest > 0) base.rows.push(_row('balance', 'Balance', 'On completion', rest));
      base.summary = 'Nothing is due at signing. Your ' + fmtCents(dedCents) + ' deductible and your ' + fmtCents(acvPart) + ' ' + ACV_WORDS +
        ' are due after your insurer’s written coverage decision and the 5-business-day cancellation window' +
        (rest > 0 ? '; the balance of ' + fmtCents(rest) + ' is due on completion.' : '.');
      return _plan(base);
    }
    var balI = totalCents - dedCents;
    base.rows = [
      _row('deductible', 'Your deductible', KY_DUE, dedCents),
      _row('balance', 'Balance', (acvCheck === 0 ? 'On completion' : 'Insurance ACV payment after the cancellation window; the rest on completion'), balI)
    ];
    base.summary = 'Nothing is due at signing. Your ' + fmtCents(dedCents) + ' deductible is due after your insurer’s written coverage ' +
      'decision and the 5-business-day cancellation window' +
      (acvCheck === 0 ? '; the balance of ' + fmtCents(balI) + ' is due on completion.'
        : '. Your ' + ACV_WORDS + ' is due after that window too, and the rest of the ' + fmtCents(balI) + ' balance is due on completion.');
    return _plan(base);
  }

  function _root() {
    return (typeof window !== 'undefined') ? window : null;
  }

  function _int(v) {
    var n = Number(v);
    return (isFinite(n) && n >= 0) ? Math.round(n) : null;
  }

  // Resolve the thresholds: an explicit config (tests, a tenant later) → the
  // loaded estimate-config.js → DEFAULTS, per field, so one bad value can
  // never zero the whole rule.
  function config(override) {
    var r = _root();
    // The company's own rule (tenant-rules.js, Settings → Business rules,
    // 2026-10-04) sits between an explicit override and the configured NBD
    // rule. null for NBD with no saved rule → unchanged. Kentucky insurance
    // jobs never reach these numbers: _kyHold below runs first, per property.
    var tr = r && r.NBDTenantRules;
    var own = (!override && tr && typeof tr.depositConfig === 'function') ? tr.depositConfig() : null;
    var src = override || own || (r && r.NBD_ESTIMATE_CONFIG && r.NBD_ESTIMATE_CONFIG.DEPOSIT_RULE) || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      var v = _int(src[k]);
      out[k] = (v == null) ? DEFAULTS[k] : v;
    });
    if (out.CASH_DEPOSIT_PCT > 100) out.CASH_DEPOSIT_PCT = DEFAULTS.CASH_DEPOSIT_PCT;
    if (!out.CASH_DEPOSIT_ROUND_TO_CENTS) out.CASH_DEPOSIT_ROUND_TO_CENTS = 1;
    return out;
  }

  // Dollars (number or "$1,234.50" string) → integer cents; blank/NaN → null.
  function toCents(v) {
    if (v == null || v === '') return null;
    var n = (typeof v === 'string') ? Number(v.replace(/[$,\s]/g, '')) : Number(v);
    if (!isFinite(n)) return null;
    return Math.round(n * 100);
  }

  // House money style (render-pdf.js `money`, estimate-view.js): whole dollars
  // when whole, cents when present — $1,000 / $3,494.07.
  function fmtCents(cents) {
    var c = Math.round(Number(cents) || 0);
    var neg = c < 0;
    c = Math.abs(c);
    var d = (c % 100 === 0) ? 0 : 2;
    return (neg ? '-' : '') + '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function isInsuranceMode(mode) {
    return String(mode == null ? '' : mode).trim().toLowerCase() === 'insurance';
  }

  function _clamp(c, total) { return Math.max(0, Math.min(total, c)); }

  function _pctDeposit(totalCents, pct, stepCents) {
    if (pct >= 100) return totalCents;
    if (pct <= 0) return 0;
    var raw = Math.round(totalCents * pct / 100);
    var step = stepCents > 0 ? stepCents : 1;
    return _clamp(Math.round(raw / step) * step, totalCents);
  }

  function _validPct(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    return (isFinite(n) && n >= 0 && n <= 100) ? n : null;
  }

  function _row(key, label, due, amountCents, amountText) {
    return {
      key: key, label: label, due: due,
      amountCents: (amountCents == null ? null : amountCents),
      amountText: amountText || (amountCents == null ? '' : fmtCents(amountCents))
    };
  }

  function _plan(base) {
    var p = {
      version: 1,
      rule: base.rule,
      kind: base.kind || base.rule,
      mode: base.mode,
      totalCents: base.totalCents,
      depositCents: base.depositCents,
      balanceCents: base.totalCents - base.depositCents,
      pct: base.totalCents > 0 ? Math.round(base.depositCents * 100 / base.totalCents) : 0,
      deductibleCents: base.deductibleCents == null ? null : base.deductibleCents,
      acvValueCents: base.acvValueCents == null ? null : base.acvValueCents,
      acvCheckCents: base.acvCheckCents == null ? null : base.acvCheckCents,
      acvKnown: base.acvCheckCents != null,
      needsDeductible: !!base.needsDeductible,
      label: base.label,
      valueText: base.valueText,
      summary: base.summary,
      terms: base.terms,
      rows: base.rows,
      override: base.override || null,
      repNote: base.repNote || '',
      kyHold: !!base.kyHold
    };
    if (base.pctLabel != null) p.pct = base.pctLabel;
    return p;
  }

  // ── The rule itself, no override ───────────────────────────────────────
  function _rulePlan(totalCents, insurance, dedCents, acvCents, c, stepCents) {
    var mode = insurance ? 'insurance' : 'cash';
    if (!(totalCents > 0)) {
      return _plan({ rule: 'none', mode: mode, totalCents: 0, depositCents: 0,
        label: 'Due at signing', valueText: fmtCents(0), summary: '', terms: '', rows: [] });
    }

    if (!insurance) {
      var pct = c.CASH_DEPOSIT_PCT;
      if (totalCents < c.CASH_NO_DEPOSIT_UNDER_CENTS || pct <= 0) {
        return _plan({ rule: 'cash-none', mode: mode, totalCents: totalCents, depositCents: 0,
          label: 'Due at signing', valueText: 'No deposit',
          summary: 'No deposit. The full ' + fmtCents(totalCents) + ' is due on completion.',
          terms: 'No deposit — payment in full on completion.',
          rows: [_row('completion', 'Payment in full', 'On completion', totalCents)] });
      }
      var dep = _pctDeposit(totalCents, pct, stepCents);
      var bal = totalCents - dep;
      var rows = [_row('deposit', pct + '% deposit', 'At signing', dep)];
      if (bal > 0) rows.push(_row('balance', 'Balance', 'On completion', bal));
      return _plan({ rule: 'cash-percent', mode: mode, totalCents: totalCents, depositCents: dep, pctLabel: pct,
        label: 'Due at signing', valueText: fmtCents(dep),
        summary: pct + '% deposit of ' + fmtCents(dep) + ' due at signing' +
          (bal > 0 ? '; balance of ' + fmtCents(bal) + ' due on completion.' : '.'),
        terms: pct + '% deposit at signing; balance on completion.',
        rows: rows });
    }

    // ── Insurance ──
    if (dedCents == null) {
      // No deductible entered. It is still due — the copy says so without a
      // number, and the rep surfaces warn (repNote). $0 is never printed as
      // "the deductible".
      return _plan({ rule: 'insurance', mode: mode, totalCents: totalCents, depositCents: 0, needsDeductible: true,
        label: 'Due at signing', valueText: 'Your deductible',
        summary: 'Your insurance deductible is due at signing. Your ' + ACV_WORDS +
          ' is due when your carrier releases it, and the rest of the balance is due on completion.',
        terms: 'Your deductible at signing; your insurance ACV payment when your carrier releases it; the balance on completion.',
        rows: [
          _row('deductible', 'Your deductible', 'At signing', null, 'Per your policy'),
          _row('acv', 'Insurance ACV payment (your carrier’s first check)', 'When your carrier releases it', null, 'Set by your carrier'),
          _row('balance', 'Balance', 'On completion', null, 'Remainder of ' + fmtCents(totalCents))
        ],
        repNote: 'No deductible entered — the deductible is always collected, so enter it to set the deposit.' });
    }

    var acvCheck = (acvCents == null) ? null : Math.max(0, acvCents - dedCents);

    if (dedCents >= totalCents) {
      return _plan({ rule: 'insurance', mode: mode, totalCents: totalCents, depositCents: totalCents,
        deductibleCents: dedCents, acvValueCents: acvCents, acvCheckCents: acvCheck,
        label: 'Due at signing', valueText: fmtCents(totalCents),
        summary: 'The job total of ' + fmtCents(totalCents) + ' is at or below your ' + fmtCents(dedCents) +
          ' deductible, so the full ' + fmtCents(totalCents) + ' is due at signing.',
        terms: 'The full job total at signing (it is at or below your deductible).',
        rows: [_row('deductible', 'Job total (at or below your deductible)', 'At signing', totalCents)],
        repNote: 'Job total is at or below the deductible — no insurance payment is expected on this job.' });
    }

    if (acvCheck != null && acvCheck > 0) {
      var upfront = Math.min(totalCents, dedCents + acvCheck);
      var acvPart = upfront - dedCents;
      var rest = totalCents - upfront;
      var r2 = [
        _row('deductible', 'Your deductible', 'At signing', dedCents),
        _row('acv', 'Insurance ACV payment (your carrier’s first check)', 'Up front — as soon as your carrier releases it', acvPart)
      ];
      if (rest > 0) r2.push(_row('balance', 'Balance', 'On completion', rest));
      return _plan({ rule: 'insurance', mode: mode, totalCents: totalCents, depositCents: upfront,
        deductibleCents: dedCents, acvValueCents: acvCents, acvCheckCents: acvCheck,
        label: 'Due up front', valueText: fmtCents(upfront),
        summary: 'Due up front: your ' + fmtCents(dedCents) + ' deductible at signing, plus your ' + fmtCents(acvPart) +
          ' ' + ACV_WORDS + ' as soon as your carrier releases it — ' + fmtCents(upfront) + ' in all.' +
          (rest > 0 ? ' Balance of ' + fmtCents(rest) + ' due on completion.' : ''),
        terms: 'Your deductible at signing and your insurance ACV payment as soon as it is released; the balance on completion.',
        rows: r2 });
    }

    var balI = totalCents - dedCents;
    if (acvCheck === 0) {
      // ACV known and at or below the deductible: the carrier's first check is
      // $0, so there is no ACV payment to ask for up front.
      return _plan({ rule: 'insurance', mode: mode, totalCents: totalCents, depositCents: dedCents,
        deductibleCents: dedCents, acvValueCents: acvCents, acvCheckCents: 0,
        label: 'Due at signing', valueText: fmtCents(dedCents),
        summary: 'Your ' + fmtCents(dedCents) + ' deductible is due at signing; balance of ' + fmtCents(balI) + ' due on completion.',
        terms: 'Your deductible at signing; the balance on completion.',
        rows: [_row('deductible', 'Your deductible', 'At signing', dedCents),
               _row('balance', 'Balance', 'On completion', balI)] });
    }

    // ACV not known yet: the deposit is the deductible, and the ACV payment is
    // due when the carrier releases it.
    return _plan({ rule: 'insurance', mode: mode, totalCents: totalCents, depositCents: dedCents,
      deductibleCents: dedCents, acvValueCents: null, acvCheckCents: null,
      label: 'Due at signing', valueText: fmtCents(dedCents),
      summary: 'Your ' + fmtCents(dedCents) + ' deductible is due at signing. Your ' + ACV_WORDS +
        ' is due when your carrier releases it, and the rest of the ' + fmtCents(balI) + ' balance is due on completion.',
      terms: 'Your deductible at signing; your insurance ACV payment when your carrier releases it; the balance on completion.',
      rows: [_row('deductible', 'Your deductible', 'At signing', dedCents),
             _row('balance', 'Balance', 'Insurance ACV payment when your carrier releases it; the rest on completion', balI)] });
  }

  /**
   * compute(input) → plan
   *   input.total | input.totalCents   job total (dollars | integer cents)
   *   input.mode                       'insurance' | anything else = cash
   *   input.deductible, input.acv      dollars (insurance only; 0/blank = not entered)
   *   input.overridePct | input.overrideAmount   an existing REP OVERRIDE
   *       (classic builder "Override %", doc pre-flight "Deposit Amount").
   *       Honored and labelled (plan.kind 'override', plan.repNote); on an
   *       insurance job it can never go below the deductible.
   *   input.roundToCents, input.config  optional (tests / tenant settings)
   *   input.lead                       optional lead doc: its claim number /
   *       carrier / jobType make the job an insurance job for the Kentucky
   *       hold even in cash mode (the contract's isInsurance test), and its
   *       address / zip / state fill in a location the caller left blank.
   */
  function compute(input) {
    input = input || {};
    var c = config(input.config);
    var totalCents = (input.totalCents != null) ? _int(input.totalCents) : toCents(input.total);
    if (!(totalCents > 0)) totalCents = 0;
    var insurance = isInsuranceMode(input.mode);
    var ded = insurance ? toCents(input.deductible) : null;
    if (!(ded > 0)) ded = null;
    var acv = insurance ? toCents(input.acv) : null;
    if (!(acv > 0)) acv = null;
    var step = _int(input.roundToCents) || c.CASH_DEPOSIT_ROUND_TO_CENTS;

    // Kentucky insurance job: $0 at signing, whatever the override says. The
    // estimate's mode OR the lead's own insurance signals make it one.
    if (totalCents > 0 && _kyHold(input, insurance || _leadInsurance(input.lead))) {
      var kDed = ded, kAcv = acv;
      if (!insurance) {
        // Priced in cash mode: read the claim figures the caller still has.
        kDed = toCents(input.deductible); if (!(kDed > 0)) kDed = null;
        kAcv = toCents(input.acv); if (!(kAcv > 0)) kAcv = null;
      }
      var ky = _kyPlan(totalCents, kDed, kAcv);
      var hadOverride = (input.overrideAmount != null && input.overrideAmount !== '') || _validPct(input.overridePct) != null;
      if (hadOverride) ky.repNote = 'Rep override ignored — ' + KY_REP_NOTE.charAt(0).toLowerCase() + KY_REP_NOTE.slice(1);
      return ky;
    }

    var base = _rulePlan(totalCents, insurance, ded, acv, c, step);
    if (!(totalCents > 0)) return base;

    var ovAmt = (input.overrideAmount != null && input.overrideAmount !== '') ? toCents(input.overrideAmount) : null;
    if (ovAmt != null && ovAmt < 0) ovAmt = null;
    var ovPct = (ovAmt == null) ? _validPct(input.overridePct) : null;
    if (ovAmt == null && ovPct == null) return base;

    var dep = (ovAmt != null) ? _clamp(ovAmt, totalCents) : _pctDeposit(totalCents, ovPct, step);
    if (insurance && ded == null && dep === 0) {
      // Never let an override print "no deposit" on a claim whose deductible
      // nobody has entered — the deductible is still owed.
      base.repNote = 'Rep override of $0 ignored — the deductible is always collected; enter it to set the deposit.';
      return base;
    }
    var raised = false;
    if (insurance && ded != null) {
      var floor = Math.min(ded, totalCents);
      if (dep < floor) { dep = floor; raised = true; }
    }
    if (dep === base.depositCents) {
      // The override says what the rule says — or asked for less than the
      // deductible and was raised back to it. Either way the rule's own plan
      // stands; only the raise is worth telling the rep about.
      if (raised) base.repNote = 'Rep override of ' + fmtCents(ovAmt != null ? ovAmt : _pctDeposit(totalCents, ovPct, step)) +
        ' raised to the ' + fmtCents(dep) + ' deductible, which is never reduced.';
      return base;
    }

    var bal = totalCents - dep;
    var pctWord = (ovPct != null) ? (ovPct + '% deposit') : 'Deposit';
    var rows = dep > 0
      ? [_row('deposit', pctWord, 'At signing', dep)]
      : [_row('completion', 'Payment in full', 'On completion', totalCents)];
    if (dep > 0 && bal > 0) rows.push(_row('balance', 'Balance', 'On completion', bal));
    var summary = dep > 0
      ? (pctWord + ' of ' + fmtCents(dep) + ' due at signing' + (bal > 0 ? '; balance of ' + fmtCents(bal) + ' due on completion.' : '.'))
      : ('No deposit. The full ' + fmtCents(totalCents) + ' is due on completion.');
    if (insurance && ded != null) summary += ' The deposit includes your ' + fmtCents(Math.min(ded, totalCents)) + ' deductible.';
    else if (insurance) summary += ' Your insurance deductible is always collected in full.';
    return _plan({ rule: base.rule, kind: 'override', mode: base.mode, totalCents: totalCents, depositCents: dep,
      pctLabel: ovPct != null ? ovPct : null,
      deductibleCents: base.deductibleCents, acvValueCents: base.acvValueCents, acvCheckCents: base.acvCheckCents,
      label: 'Due at signing', valueText: dep > 0 ? fmtCents(dep) : 'No deposit',
      summary: summary,
      terms: dep > 0 ? (pctWord + ' at signing; balance on completion.') : 'No deposit — payment in full on completion.',
      rows: rows,
      override: { pct: ovPct, amountCents: ovAmt, ruleDepositCents: base.depositCents, raisedToDeductible: raised },
      repNote: (insurance && ded == null)
        ? 'Rep override — enter the deductible: the deposit can never be less than it.'
        : ('Rep override — the deposit rule would ask ' + fmtCents(base.depositCents) +
          (raised ? '; raised to the deductible, which is never reduced' : '') + '.') });
  }

  function _first() {
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (v != null && v !== '' && isFinite(Number(v))) return v;
    }
    return null;
  }
  // A deductible of 0 is "not entered" (V2's claim input coerces a cleared
  // field to 0), so it falls through to the lead's recorded deductible.
  function _firstPositive() {
    for (var i = 0; i < arguments.length; i++) {
      var c = toCents(arguments[i]);
      if (c != null && c > 0) return c / 100;
    }
    return null;
  }

  // V2 defaulted state.claim.deductible to a $2,500 PLACEHOLDER until this
  // rule landed (2026-09-25) and saved the claim whenever the deductible was
  // non-null — i.e. always — so every V2 estimate saved before the rule
  // carries claim.deductible 2500 whether or not anybody entered it. Such a
  // doc has no depositPlan stamp (the rule writes one on every save), so
  // "no stamp + exactly $2,500" is the unconfirmed placeholder: the lead's
  // recorded deductible wins, and with none the deductible is treated as not
  // entered (and the rep is told why) — never printed as the homeowner's.
  // V2's prefillFromLead has treated 2500 as unset for the same reason.
  var LEGACY_PLACEHOLDER_DEDUCTIBLE_CENTS = 250000;
  function hasLegacyPlaceholderDeductible(est) {
    if (!est || typeof est !== 'object' || est.depositPlan) return false;
    var c = est.claim;
    return !!(c && typeof c === 'object' && toCents(c.deductible) === LEGACY_PLACEHOLDER_DEDUCTIBLE_CENTS);
  }

  /**
   * fromEstimate(est, opts) → plan for a SAVED or in-builder estimate doc
   * (classic, V2 or Job Template shape).
   *   opts.total / opts.totalCents — price to split (an invoice folds in
   *     approved supplements, so it passes its own total)
   *   opts.claim — live claim fields (V2 state.claim) instead of est.claim
   *   opts.lead  — lead doc; its deductible fills in when the estimate has
   *     none, or only the old $2,500 placeholder (see above)
   *   opts.overrideAmount / opts.overridePct — a rep override from the caller
   * A stored plan's override is honored; a stored plan's AMOUNT never is —
   * the deposit is always recomputed, so an estimate saved under the old
   * 50/50 / 25% / $0 logic gets the rule, not its stale number.
   */
  function fromEstimate(est, opts) {
    est = est || {};
    opts = opts || {};
    var totalCents = (opts.totalCents != null) ? _int(opts.totalCents)
      : toCents(_first(opts.total, est.grandTotal, est.total));
    var mode = opts.mode || est.mode || est.jobMode || (est.insurance === true ? 'insurance' : '');
    var claim = opts.claim || est.claim
      || ((est.insurance && typeof est.insurance === 'object') ? est.insurance : null) || {};
    var lead = opts.lead || {};
    // A live claim (opts.claim — V2's state) is the rep's current entry; only
    // the SAVED claim can carry the old placeholder.
    var placeholder = !opts.claim && hasLegacyPlaceholderDeductible(est);
    var leadDeductible = _firstPositive(lead.deductibleOrOwedByHO, lead.deductible);
    var deductible = placeholder ? leadDeductible : _firstPositive(claim.deductible, leadDeductible);
    var input = {
      totalCents: totalCents, mode: mode,
      deductible: deductible, acv: _first(claim.acv),
      config: opts.config, roundToCents: opts.roundToCents,
      // The job's location, for the Kentucky hold (2026-09-27): always
      // passed from here, so an insurance estimate with no readable state is
      // held like the contract treats it (fail closed).
      address: (opts.address != null ? opts.address : (est.addr || est.address || est.propertyAddress || lead.address || '')),
      zip: opts.zip || lead.zip || '',
      state: opts.state || lead.state || '',
      jurisdiction: opts.jurisdiction || null,
      // The lead's insurance signals (claim number, carrier, jobType) decide
      // the Kentucky hold too, not just the estimate's mode (2026-10-03).
      lead: opts.lead || null
    };
    var stored = est.depositPlan && est.depositPlan.override;
    if (opts.overrideAmount != null && opts.overrideAmount !== '') input.overrideAmount = opts.overrideAmount;
    else if (opts.overridePct != null && opts.overridePct !== '') input.overridePct = opts.overridePct;
    else if (stored && stored.amountCents != null) input.overrideAmount = stored.amountCents / 100;
    else if (stored && stored.pct != null) input.overridePct = stored.pct;
    else if (est.depositPctOverride != null && est.depositPctOverride !== '') input.overridePct = est.depositPctOverride;
    else if (est.depositOverridePct != null && est.depositOverridePct !== '') input.overridePct = est.depositOverridePct;
    var plan = compute(input);
    if (placeholder && plan.mode === 'insurance' && plan.totalCents > 0) {
      var why = (leadDeductible != null)
        ? 'This estimate was saved with the old $2,500 placeholder deductible, so the customer record’s ' +
          fmtCents(toCents(leadDeductible)) + ' deductible is used.'
        : 'This estimate was saved with the old $2,500 placeholder deductible, which nobody confirmed — enter the real deductible to set the deposit.';
      plan.repNote = (plan.repNote && !plan.needsDeductible) ? (why + ' ' + plan.repNote) : why;
      plan.legacyPlaceholderDeductible = true;
    }
    return plan;
  }

  // The persisted / whitelisted shape: display strings + cents, no repNote
  // (rep-facing) and no claim internals beyond what the summary already says.
  function toStored(plan) {
    if (!plan || !(plan.totalCents > 0)) return null;
    return {
      v: 1,
      kind: plan.kind, rule: plan.rule, mode: plan.mode,
      totalCents: plan.totalCents, depositCents: plan.depositCents, balanceCents: plan.balanceCents,
      pct: plan.pct,
      label: plan.label, valueText: plan.valueText, summary: plan.summary, terms: plan.terms,
      rows: (plan.rows || []).map(function (r) {
        return { label: r.label, due: r.due, amountCents: r.amountCents, amountText: r.amountText };
      }),
      override: plan.override ? {
        pct: plan.override.pct == null ? null : plan.override.pct,
        amountCents: plan.override.amountCents == null ? null : plan.override.amountCents
      } : null
    };
  }

  // Generic statement of the rule for boilerplate that knows no job (company
  // profile payment-terms defaults, contract fallback).
  function policyText(override) {
    var c = config(override);
    var under = fmtCents(c.CASH_NO_DEPOSIT_UNDER_CENTS);
    // A company that takes no cash deposit (pct 0 — a new company's neutral
    // default until it sets its own rule, 2026-10-04) says exactly that.
    var cash = (c.CASH_DEPOSIT_PCT <= 0)
      ? 'Cash jobs: no deposit — payment in full on completion. '
      : (c.CASH_NO_DEPOSIT_UNDER_CENTS > 0
        ? 'Cash jobs under ' + under + ': no deposit — payment in full on completion. ' +
          'Cash jobs of ' + under + ' or more: ' + c.CASH_DEPOSIT_PCT + '% deposit at contract signing, balance on completion. '
        : 'Cash jobs: ' + c.CASH_DEPOSIT_PCT + '% deposit at contract signing, balance on completion. ');
    return cash +
      'Insurance claims: the homeowner’s deductible is due at signing and the insurance ACV payment (the carrier’s first check) ' +
      'is due as soon as the carrier releases it; the balance is due on completion. ' +
      'Kentucky insurance claims: nothing is due at signing; the deductible and the ACV payment are due after the insurer’s ' +
      'written coverage decision and the 5-business-day cancellation window. ' +
      'The deductible is the homeowner’s responsibility and is never waived or reduced.';
  }

  // ONE due-date rule for every invoice (2026-10-03). The Stripe invoice
  // (functions/stripe-crm-invoice.js days_until_due) and the NBD-500 PDF
  // (money-paper-logic.js) said 7 days — Jo's live-CRM handoff, 2026-09-30:
  // "7 days; was 14" — while the CRM invoice doc and its terms said Net 14,
  // so one bill carried two due dates. Every writer now reads this value.
  var INVOICE_DUE_DAYS = 7;
  function invoiceDueDateMs(nowMs) {
    var n = Number(nowMs);
    return (Number.isFinite(n) ? n : Date.now()) + INVOICE_DUE_DAYS * 86400000;
  }
  function netTermsText() { return 'Net ' + INVOICE_DUE_DAYS + '.'; }

  var API = {
    INVOICE_DUE_DAYS: INVOICE_DUE_DAYS,
    invoiceDueDateMs: invoiceDueDateMs,
    netTermsText: netTermsText,
    DEFAULTS: DEFAULTS,
    config: config,
    compute: compute,
    fromEstimate: fromEstimate,
    toStored: toStored,
    policyText: policyText,
    hasLegacyPlaceholderDeductible: hasLegacyPlaceholderDeductible,
    fmtCents: fmtCents,
    toCents: toCents,
    isInsuranceMode: isInsuranceMode
  };

  if (typeof window !== 'undefined') window.NBDDepositRule = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
