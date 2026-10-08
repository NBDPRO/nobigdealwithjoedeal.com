/**
 * customer-estimate-rows.js — customer-facing display rows for a SAVED estimate.
 *
 * The customer-portal estimate export (exportCustomerEstimate in
 * customer-bootstrap.module.js) used to print est.rows verbatim. Post-sweep V2
 * saves persist the RETAIL price in rows[].rate/total (+ rows[].retailTotal),
 * but V2/insurance docs saved BEFORE the 2026-07-18 money-math sweep wrote the
 * raw COST basis (material+labor, no markup, no O&P) there — so the portal PDF
 * showed the contractor's cost under a retail total and exposed the margin to
 * the homeowner/adjuster.
 *
 * buildDisplayRows(est) mirrors InvoicePipeline.buildRowItems (which customer
 * pages don't load) with the same ladder, per row:
 *   1. rows[].retailTotal when present            → post-sweep saves, exact
 *   2. materialTotal×(1+markup) + laborTotal      → older V2 docs w/ cost split
 *      (rows whose split is all-zero — SVC pass-through fees — stay at face)
 *   3. rows[].total verbatim                      → classic rows: already the
 *      all-in customer price; rate keeps its display string ('$595/SQ')
 * plus the same two structural rules:
 *   - per-SQ docs return NO rows: their rows are the internal cost basis and
 *     can never foot to the selected-tier grandTotal (the invoice bills these
 *     as one summary line; the server quote suppresses lines the same way)
 *   - V2 docs with an O&P ladder get an 'Overhead & Profit (N%)' row appended
 *     so the printed lines foot to the subtotal, matching the signed scope.
 *   - then the sales tax row and the Rounding / Minimum job charge
 *     adjustment row (footingRows, 2026-10-06), so the lines foot to the
 *     PRICE — the e-sign contract and the estimate link print no other tax.
 *
 * Pure + dependency-free: unit-tested in tests/customer-estimate-rows.test.js.
 */
(function () {
  'use strict';

  // First numeric token out of a value — qty/rate/total may be display strings
  // ('20.00 SQ', '$595/SQ'); a bare parseFloat would NaN on the '$' forms.
  function numFrom(v) {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // ONE money reader for a stored dollar field (lead.jobValue first of all;
  // review R2, 2026-10-06). jobValue is a number on every current writer, but
  // legacy / imported docs can hold text, and the surfaces parsed it three
  // ways: parseFloat('45,000') is 45, parseFloat('$45,000') and Number('45,000')
  // are NaN → 0. This reads '$45,000', '45,000' and '45000.50' alike; anything
  // without a number ('', null, 'TBD') is 0, never NaN.
  function moneyValue(v) {
    const n = numFrom(v);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * @param {object} est saved estimate doc (classic or V2 shape)
   * @returns {Array<{code:string,desc:string,qty:string,rate:string,total:number}>}
   */
  function buildDisplayRows(est) {
    if (!est) return [];
    // Per-SQ: rows are internal cost lines; the tier price is the only
    // customer number. Same detection as InvoicePipeline.createInvoiceFromEstimate.
    if (est.priceMode === 'per-sq' || est.prices != null) return [];

    const markup = Number(est.materialMarkupPct);
    const hasV2Pricing = Number.isFinite(markup);

    const rows = (est.rows || []).map(function (row) {
      const explicitRetail = (row.retailTotal != null && Number.isFinite(Number(row.retailTotal)))
        ? Number(row.retailTotal) : null;
      const hasSplit = hasV2Pricing && (row.materialTotal != null || row.laborTotal != null);
      let total;
      if (explicitRetail != null) {
        total = explicitRetail;
      } else if (hasSplit) {
        const mat = Number(row.materialTotal) || 0;
        const lab = Number(row.laborTotal) || 0;
        total = (mat === 0 && lab === 0) ? numFrom(row.total) : mat * (1 + markup) + lab;
      } else {
        total = numFrom(row.total);
      }
      total = Number.isFinite(total) ? round2(total) : 0;

      let rate;
      if (explicitRetail != null || hasSplit) {
        // Retail-priced row: derive the unit rate from the retail total — the
        // saved rate string on pre-sweep docs is the COST rate, never print it.
        const qty = numFrom(row.qty);
        const unit = (Number.isFinite(qty) && qty !== 0) ? total / qty : total;
        rate = '$' + round2(unit).toFixed(2);
      } else {
        rate = row.rate == null ? '' : String(row.rate);
      }

      return {
        code: row.code == null ? '' : String(row.code),
        desc: String(row.desc || row.description || ''),
        qty: row.qty == null ? '' : String(row.qty),
        rate: rate,
        total: total
      };
    });

    const ohp = (Number(est.overhead) || 0) + (Number(est.profit) || 0);
    if (hasV2Pricing && ohp > 0 && rows.length) {
      const pct = Math.round(((Number(est.overheadPct) || 0) + (Number(est.profitPct) || 0)) * 100);
      rows.push({
        code: 'O&P',
        desc: 'Overhead & Profit' + (pct ? ' (' + pct + '%)' : ''),
        qty: '',
        rate: '',
        total: round2(ohp)
      });
    }
    if (rows.length) footingRows(est, rows).forEach(function (r) { rows.push(r); });
    return rows;
  }

  /**
   * The rows that take a saved estimate's lines from its subtotal to its
   * price (review R2-2-2, 2026-10-06): a "Sales tax (r%)" row, then the
   * difference the quote bakes in — nearest-$25 rounding or the job-minimum
   * lift — as "Rounding" / "Minimum job charge adjustment". Same rule, same
   * cents and same label as the invoice's adjustment line
   * (invoiceTotalsFromEstimate, #2200) and the estimate preview, so the
   * contract and the estimate link foot to the price they print.
   *
   * Only when the estimate saved a subtotal and a price: without a saved
   * subtotal there is no way to tell what the lines already include, so
   * nothing is added (the old behaviour).
   *
   * The adjustment is measured from the PRINTED lines when they sit within
   * $1 of the saved subtotal (the engine rounds each row, which leaves a cent
   * or two), so what is printed adds up to the price to the cent. Further
   * apart (an old doc whose lines never footed) it is measured from the
   * subtotal, exactly like the invoice, so a real gap is never relabelled
   * "Rounding".
   */
  function footingRows(est, printed) {
    const grand = estimateValue(est);
    const sub = Number(est && est.subtotal);
    if (!(Number.isFinite(grand) && grand > 0) || est.subtotal == null || !Number.isFinite(sub)) return [];
    const taxRaw = Number(est.taxAmount != null ? est.taxAmount : est.tax);
    const taxCents = Number.isFinite(taxRaw) ? Math.round(taxRaw * 100) : 0;
    const out = [];
    if (taxCents !== 0) {
      const rate = Number(est.taxRate);
      const pct = (Number.isFinite(rate) && rate > 0) ? String(Math.round(rate * 100000) / 1000) + '%' : '';
      out.push({ code: 'TAX', desc: 'Sales tax' + (pct ? ' (' + pct + ')' : ''), qty: '', rate: '', total: taxCents / 100 });
    }
    const subCents = Math.round(sub * 100);
    const linesCents = (printed || []).reduce(function (s, r) { return s + Math.round((Number(r.total) || 0) * 100); }, 0);
    const baseCents = Math.abs(linesCents - subCents) <= 100 ? linesCents : subCents;
    const adjCents = Math.round(grand * 100) - baseCents - taxCents;
    if (adjCents !== 0) {
      out.push({
        code: 'ADJ',
        desc: (est.minJobApplied && adjCents > 0) ? 'Minimum job charge adjustment' : 'Rounding',
        qty: '',
        rate: '',
        total: adjCents / 100
      });
    }
    return out;
  }

  /**
   * Doc-generator line items for a saved estimate, in EITHER shape.
   *
   * WHY THIS EXISTS. The document generator and its pre-flight read
   * `est.lineItems`. V2 — the builder every estimate goes through now — writes
   * `est.rows` and the string `lineItems` does not appear in estimate-v2-ui.js
   * even once. So the scope came back empty for every V2 estimate, and two
   * things followed:
   *   1. `lineItems` is required:true on proposal, contract, supplement_request
   *      and invoice, so every one of those documents started with an empty
   *      REQUIRED field and had to be typed by hand.
   *   2. The same empty array reached resolveDocManufacturer, which finds no
   *      shingle line and falls back to its hardcoded default — so warranty
   *      certificates and proposals claimed "GAF Timberline" on TAMKO jobs.
   *
   * It lives HERE, next to buildDisplayRows and its test, because the answer
   * is the retail ladder — and a fourth private copy of that math is exactly
   * what leaked the cost basis to homeowners in the first place.
   *
   * Three shapes in, one shape out:
   *   - classic `lineItems`  → mapped straight across
   *   - per-SQ V2            → ONE summary line at the locked tier total,
   *                            mirroring InvoicePipeline.createInvoiceFromEstimate.
   *                            buildDisplayRows deliberately returns [] here
   *                            (the rows are internal cost lines that cannot
   *                            foot to the tier price) — but a CONTRACT with no
   *                            scope is the bug being fixed, so summarise
   *                            rather than emit nothing.
   *   - row-based V2/classic → buildDisplayRows, i.e. the retail ladder + O&P
   *
   * Emits both naming conventions on purpose: `description`/`qty`/`rate` for
   * the doc templates, and `code`/`name` for resolveDocManufacturer, which
   * inspects `li.code || li.name` and would otherwise never see the shingle.
   */
  function buildDocLineItems(est) {
    if (!est) return [];

    function shape(o) {
      const qty = Number.isFinite(o.qty) ? o.qty : 1;
      const total = round2(Number(o.total) || 0);
      const rate = Number.isFinite(o.rate) ? round2(o.rate) : (qty ? round2(total / qty) : total);
      return {
        code: o.code || '',
        name: o.desc || '',
        description: o.desc || 'Line item',
        qty: qty,
        quantity: qty,
        unit: o.unit || 'ea',
        rate: rate,
        unitPrice: rate,
        total: total,
        amount: total,
      };
    }
    function footShape(r) {
      return shape({ code: r.code, desc: r.desc, unit: 'ea', qty: 1, rate: r.total, total: r.total });
    }

    // Classic estimates already carry the customer-facing ladder. A doc that
    // ALSO has rows is a builder estimate whose lineItems were written by doc
    // pre-flight's old "Save to estimate" (review R6-2-1, 2026-10-07): the
    // contract, estimate link, invoice and portal all print its rows, so the
    // document line items do too — one set of lines on every surface.
    const hasRows = Array.isArray(est.rows) && est.rows.length > 0;
    if (!hasRows && Array.isArray(est.lineItems) && est.lineItems.length) {
      const lines = est.lineItems.map(function (it) {
        if (it && (it.code === 'TAX' || it.code === 'ADJ')) return null; // a footing row saved back from pre-flight
        const qty = numFrom(it.quantity != null ? it.quantity : it.qty);
        const amt = numFrom(it.amount != null ? it.amount : it.total);
        const rate = numFrom(it.unitPrice != null ? it.unitPrice : it.rate);
        const q = Number.isFinite(qty) && qty !== 0 ? qty : 1;
        const t = Number.isFinite(amt) ? amt : (Number.isFinite(rate) ? rate * q : 0);
        return shape({
          code: it.code, desc: it.description || it.name, unit: it.unit,
          qty: q, rate: Number.isFinite(rate) ? rate : null, total: t,
        });
      }).filter(Boolean);
      return lines.length ? lines.concat(footingRows(est, lines).map(footShape)) : lines;
    }

    // Per-SQ: the customer price is the locked selected-tier total.
    const isPerSq = (est.priceMode === 'per-sq') || (est.prices != null);
    if (isPerSq) {
      const grand = estimateValue(est);
      if (!grand) return [];
      // Customer-facing label, not the raw internal good/better/best key
      // (GBB audit 2026-09-09 §9 — this line was still printing "Better
      // tier" on invoices/receipts after every other surface moved to
      // Standard/Preferred/Elite). No shared-config import: this file ships
      // as a byte-identical mirror to BOTH docs/pro/js/ (browser, has
      // estimate-config.js) and functions/ (server, no window/DOM, no
      // estimate-config.js) — a 3-entry literal map is the simplest thing
      // that stays correct in both runtimes. Unknown/future tier keys fall
      // back to the old capitalize-first-letter behavior rather than
      // printing blank.
      const TIER_LABELS = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
      const rawTier = String(est.selectedTier || est.tier || '');
      const tier = TIER_LABELS[rawTier] || rawTier.replace(/^./, function (c) { return c.toUpperCase(); });
      return [shape({
        code: '', desc: 'Roofing system' + (tier ? ' — ' + tier + ' tier' : ''),
        unit: 'ea', qty: 1, rate: grand, total: grand,
      })];
    }

    return buildDisplayRows(est).map(function (r) {
      const qty = numFrom(r.qty);
      // qty arrives as a display string ('20.00 SQ') — split the unit back off.
      const unit = String(r.qty == null ? '' : r.qty).replace(/^[\s\d.,-]+/, '').trim();
      const q = Number.isFinite(qty) && qty !== 0 ? qty : 1;
      return shape({
        code: r.code, desc: r.desc, unit: unit || 'ea',
        qty: q, rate: numFrom(r.rate), total: r.total,
      });
    });
  }

  // ── Two-shape estimate readers ──────────────────────────────────────
  // Estimates exist in TWO shapes and every reader used to invent its own
  // guess at which key holds the money and the label:
  //   V2      → name  / grandTotal / rows
  //   Classic → title / amount|total / lineItems
  // That drift is not cosmetic. setPrimaryEstimate read `grandTotal` ONLY, so
  // making a visible $14,500 Classic estimate primary wrote `jobValue: 0` over
  // the lead and blanked the header, the profit panel and every pipeline
  // number. These two helpers are the single source of truth — any surface
  // that needs "what is this estimate worth / what is it called" calls them.
  //
  // Order matters: grandTotal first (V2's authoritative total), then total,
  // then amount (Classic's two spellings). Falsy-but-present 0 is preserved via
  // the != null checks — a genuine $0 draft must not fall through to a stale key.
  function estimateValue(est) {
    if (!est) return 0;
    const v = est.grandTotal != null ? est.grandTotal
      : est.total != null ? est.total
      : est.amount != null ? est.amount : 0;
    const n = numFrom(v);
    return isFinite(n) ? n : 0;
  }

  function estimateName(est) {
    if (!est) return 'Estimate';
    return est.title || est.name || est.addr || 'Estimate';
  }

  // ── Tier + workmanship warranty of a SAVED estimate (2026-09-25) ────
  // Job Templates showed a Good/Better/Best row that priced nothing: all 107
  // templates resolve to identical totals at every tier. The saved tier was a
  // silent default ('better'), and the paperwork turned it into "Preferred"
  // plus a LIFETIME workmanship warranty on gutter jobs, repairs and
  // inspections. Template estimates now save `tierApplies: false` and a
  // job-type `warrantyKind` (job-templates.js buildEstimatePayload), and every
  // customer-facing reader asks these two helpers instead of printing est.tier.
  // documentation/projects/UPGRADES-ADDONS-DESIGN-2026-09-25.md
  //
  // They live here because this file already reaches all three runtimes that
  // print an estimate: dashboard.html, customer.html and functions/ (the
  // portal). customer.html does NOT load estimate-config.js, so the kind→years
  // table below is a copy of NBD_ESTIMATE_CONFIG.WORKMANSHIP_WARRANTY, used
  // only when that global is absent; tests/job-template-honest-paperwork.test.js
  // fails if the two ever differ.
  const WORKMANSHIP_WARRANTY_FALLBACK = {
    gutter_system:   { years: 5 },
    guard_only:      { years: 2 },
    install_default: { years: 2 },
    repair:          { years: 1, optIn: true },
    none:            { years: 0 },
    roof:            { tierWording: true },
  };

  // ESTIMATES SAVED BEFORE 2026-09-25 carry no tierApplies/warrantyKind, only
  // the silent tier and `sourceTemplates`. The rule for them: a Job Template
  // estimate whose sources include no ROOFING template gets no tier, and the
  // workmanship warranty of its job type (LEGACY_WARRANTY_BY_ID below), never
  // the tier's lifetime claim. Provable because (a) tiers priced nothing on any
  // Job Template, so the saved tier never recorded a choice the homeowner paid
  // for, and (b) the ids below are exactly the default templates whose
  // warrantyKind is 'roof' — the test pins this pattern against
  // job-templates-data.js both ways. Roofing keeps its tier and wording
  // untouched, which is Jo's call for roofing. A template the rep made with
  // Duplicate (jt_custom_*) cannot be classified from its id and falls on the
  // no-claim side: printing nothing is honest for a roof, printing "lifetime"
  // is not for a gutter.
  const ROOFING_TEMPLATE_ID_RE = /^jt_fr_|^jt_sp_(standing_seam_full|exposed_fastener_metal|designer_shingle_full|cedar_shake_replacement|tpo_flat_full|modbit_lowslope)$/;

  // The default templates whose job type carries a workmanship warranty with
  // no rep choice involved: [warrantyKind, name], copied from
  // job-templates-data.js (this file cannot load it — customer.html and the
  // portal don't). Review 2026-09-25: without it, an in-flight K5 gutter job
  // quoted before the change got NO warranty on its contract and a refused
  // certificate, where Jo's term for a new gutter system is 5 years. Repairs
  // are absent on purpose: an old estimate never had the 1-year box ticked, so
  // it prints none (the rep re-creates the estimate to add it). Inspections,
  // cleaning and Duplicates (jt_custom_*) are absent too and print none.
  // tests/job-template-honest-paperwork.test.js pins this table to the data
  // both ways (every gutter_system / guard_only / install_default default is
  // here with its kind and name, and nothing else is).
  const LEGACY_WARRANTY_BY_ID = {
    jt_lf_chimney_cricket: ['install_default', 'Chimney Cricket / Saddle Install'],
    jt_lf_skylight_replace_curb: ['install_default', 'Skylight Replacement (Curb-Mount)'],
    jt_lf_kickout_install: ['install_default', 'Kickout Flashing Install + Siding Patch'],
    jt_gr_downspout_ext_4ea: ['install_default', 'Downspout Extension Install (4 EA)'],
    jt_gr_guard_install_50lf: ['guard_only', 'Gutter Guard Install (50 LF)'],
    jt_gi_k5_seamless_full: ['gutter_system', 'Seamless K5 Gutter System (Full Wrap)'],
    jt_gi_k6_oversize: ['gutter_system', 'Seamless K6 Oversize Gutter System'],
    jt_gi_half_round: ['gutter_system', 'Half-Round Gutter System'],
    jt_gi_gutters_guards_package: ['gutter_system', 'Gutters + Guards Complete Package'],
    jt_gi_downspout_only: ['install_default', 'Downspout-Only Package (Whole House)'],
    jt_gi_partial_run_60: ['gutter_system', 'Partial Gutter Run (One Elevation)'],
    jt_gi_copper_accent: ['gutter_system', 'Copper Accent Run (Front Elevation)'],
    jt_gi_new_construction: ['gutter_system', 'New Construction Gutter Package'],
    jt_sf_fascia_replacement_wrap: ['install_default', 'Fascia Replacement (60 LF) + Aluminum Wrap'],
    jt_sf_soffit_replacement_vented: ['install_default', 'Soffit Replacement — Vented (~80 SF)'],
    jt_sf_alum_fascia_wrap: ['install_default', 'Aluminum Fascia Wrap Only (80 LF)'],
    jt_sf_rake_board_replacement: ['install_default', 'Rake Board Replacement (30 LF)'],
    jt_vt_ridge_vent_retrofit: ['install_default', 'Ridge Vent Retrofit (Cut-In, ~40 LF)'],
    jt_vt_turbine_vent_install: ['install_default', 'Turbine Vent Install'],
    jt_vt_power_attic_fan: ['install_default', 'Power Attic Fan Install (Electric)'],
    jt_vt_solar_attic_fan: ['install_default', 'Solar Attic Fan Install'],
    jt_vt_bath_fan_termination: ['install_default', 'Bath Fan Roof Termination'],
    jt_vt_soffit_intake_retrofit: ['install_default', 'Intake / Soffit Vent Retrofit'],
    jt_vt_balance_package: ['install_default', 'Ventilation Balance Package (Intake + Exhaust)'],
    jt_sp_porch_metal_accent: ['install_default', 'Porch / Accent Standing Seam Metal Roof'],
    jt_sp_flat_roof_coating: ['install_default', 'Flat Roof Coating / Restoration'],
    jt_ex_siding_replace_elevation: ['install_default', 'Siding Replacement — One Elevation'],
    jt_ex_window_replace_1: ['install_default', 'Window Replacement (1 EA)'],
    jt_ex_entry_door_replace: ['install_default', 'Entry Door Replacement'],
    jt_ex_deck_rebuild_100sf: ['install_default', 'Small Deck Rebuild (~100 SF)'],
  };

  // warrantyParts for an estimate saved before 2026-09-25, from its sources.
  function legacyWarrantyParts(est) {
    return (Array.isArray(est.sourceTemplates) ? est.sourceTemplates : []).map(function (id) {
      const hit = Object.prototype.hasOwnProperty.call(LEGACY_WARRANTY_BY_ID, String(id))
        ? LEGACY_WARRANTY_BY_ID[String(id)] : null;
      return hit ? { kind: hit[0], name: hit[1] } : { kind: null, name: '' };
    });
  }

  function warrantyTable() {
    const cfg = (typeof window !== 'undefined') && window.NBD_ESTIMATE_CONFIG;
    return (cfg && cfg.WORKMANSHIP_WARRANTY) || WORKMANSHIP_WARRANTY_FALLBACK;
  }

  // Per-SQ is the one pricing model where Good/Better/Best changes the price
  // (V2's 545/595/660 per SQ). A template estimate re-saved from V2 in per-SQ
  // mode is a roofing quote with a real tier, whatever it started as.
  function isPerSqEstimate(est) {
    return !!est && (est.priceMode === 'per-sq' || est.prices != null);
  }

  function isJobTemplateEstimate(est) {
    return !!est && (est.builder === 'template'
      || (Array.isArray(est.sourceTemplates) && est.sourceTemplates.length > 0));
  }

  function hasRoofingSource(est) {
    return Array.isArray(est.sourceTemplates)
      && est.sourceTemplates.some(function (id) { return ROOFING_TEMPLATE_ID_RE.test(String(id)); });
  }

  /**
   * Does a Good/Better/Best tier apply to this saved estimate?
   * false → print nothing tier-related (no "Preferred", no "Better tier").
   * true for anything that is not a Job Template estimate, so every other
   * builder's output is untouched; true for null (nothing to suppress).
   */
  function tierApplies(est) {
    if (!est) return true;
    if (isPerSqEstimate(est)) return true;
    if (est.tierApplies === true) return true;
    if (est.tierApplies === false) return false;
    if (isJobTemplateEstimate(est)) return hasRoofingSource(est);
    return true;
  }

  function warrantyYears(kind, repairWarranty) {
    const entry = warrantyTable()[kind];
    if (!entry || entry.tierWording) return 0;
    if (entry.optIn && repairWarranty !== true) return 0;
    const y = Number(entry.years);
    return Number.isFinite(y) && y > 0 ? y : 0;
  }

  function joinNames(names) {
    if (names.length <= 1) return names[0] || '';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  /**
   * The workmanship warranty a saved estimate carries.
   *
   *   null — not a Job Template estimate (or per-SQ, or a pre-2026-09-25
   *          roofing one). The caller keeps its existing tier wording.
   *          Exception: a non-template REPAIR (workKind 'repair') gets
   *          { kind:'repair', years, text } like a repair template job.
   *   { kind:'roof', wordingTier, text:null } — roofing: print the caller's
   *          existing tier wording for `wordingTier`. A new roofing template
   *          estimate has no tier, so this is 'better', the value that flow
   *          always saved; the printed sentence is unchanged.
   *   { kind, wordingTier:'', years, text } — any other job type. `text` is
   *          the plain-text sentence to print ('' = no workmanship warranty:
   *          an unticked repair, an inspection). `years` is set when one
   *          duration covers the whole job, else null. Plain text: HTML
   *          renderers escape it.
   *   …plus `legacy: true` for a non-roofing template estimate saved before
   *          2026-09-25: its kinds come from LEGACY_WARRANTY_BY_ID, so a gutter
   *          system still gets its 5 years and a repair gets none (the box
   *          did not exist). Screens use the flag to say why there is none.
   */
  function estimateWarranty(est) {
    if (!est || isPerSqEstimate(est)) return null;
    if (!isJobTemplateEstimate(est)) {
      // A REPAIR built outside Job Templates (2026-10-07, audit H4): the V2
      // repair presets, the V3 "Repair" choice and the rep's "This is repair
      // work" button save workKind 'repair' with no sourceTemplates, so this
      // returned null and every reader printed ROOFING's tier sentence — a
      // $500 shingle patch promised a "10-year … transferable … GAF System
      // Plus" warranty in the deal room. A repair carries the repair warranty:
      // 1 year only when the rep ticked it (repairWarranty === true), else
      // none. Any other non-template estimate keeps the caller's wording.
      if (est.workKind !== 'repair') return null;
      const ry = warrantyYears('repair', est.repairWarranty);
      return { kind: 'repair', wordingTier: '', years: ry || null, text: ry ? ry + '-year workmanship warranty.' : '' };
    }
    let kind = est.warrantyKind || null;
    let parts = est.warrantyParts;
    let legacy = false;
    if (!kind) {
      if (est.tierApplies !== undefined) return { kind: null, wordingTier: '', years: null, text: '' };
      if (hasRoofingSource(est)) return null;
      legacy = true;
      parts = legacyWarrantyParts(est);
      kind = (parts.length && parts.every(function (p) { return p.kind === parts[0].kind; }))
        ? parts[0].kind : (parts.length ? 'mixed' : null);
    }
    // One return shape; `legacy` only rides on the pre-2026-09-25 results.
    const result = function (years, text) {
      const r = { kind: kind, wordingTier: '', years: years, text: text };
      if (legacy) r.legacy = true;
      return r;
    };
    if (kind === 'roof') {
      const t = tierApplies(est) ? String(est.tier || est.selectedTier || '').toLowerCase() : '';
      return { kind: 'roof', wordingTier: t || 'better', years: null, text: null };
    }
    if (!(Array.isArray(parts) && parts.length)) parts = [{ name: '', kind: kind }];
    const covered = [];
    parts.forEach(function (p) {
      const y = warrantyYears(p && p.kind, est.repairWarranty);
      if (y > 0) covered.push({ name: String((p && p.name) || '').trim(), years: y });
    });
    if (!covered.length) return result(null, '');
    const uniform = covered.every(function (c) { return c.years === covered[0].years; });
    if (uniform && covered.length === parts.length) {
      return result(covered[0].years, covered[0].years + '-year workmanship warranty.');
    }
    // Part of the job is warranted and part is not, or durations differ: name
    // each warranted part, so the sentence cannot be read as covering the rest.
    const byYears = {};
    const order = [];
    covered.forEach(function (c) {
      if (!byYears[c.years]) { byYears[c.years] = []; order.push(c.years); }
      if (c.name) byYears[c.years].push(c.name);
    });
    const text = order.map(function (y) {
      const names = byYears[y];
      return y + '-year workmanship warranty' + (names.length ? ' on ' + joinNames(names) : '') + '.';
    }).join(' ');
    return result(null, text);
  }

  // ── Signed price (review R6-2-2 / R6-2-5; Jo's rules, 2026-10-07) ────────
  // A signed estimate stays editable, but the SIGNED price is what every bill
  // charges (deposit + final drafts, invoices, the portal's amount, Stripe)
  // until the homeowner re-signs. When a signature lands, the server stamps
  // estimates/{id}.signedPrice (functions/signed-price.js; the field is
  // server-only in firestore.rules):
  //   { fields: <the priced fields below, as signed>, fingerprint, totalCents,
  //     source, sourceId, at }
  // Billing readers read signedView(est): the estimate with its priced fields
  // put back to what was signed. Everything else (the builder, the estimate
  // link, the contract for a re-sign) keeps reading the estimate as saved.
  // pricedFingerprint is the version of an estimate's price: a signed
  // estimate whose fingerprint moved has changes the homeowner never signed,
  // and a deal-room link carries the fingerprint it was issued at.
  const PRICED_FIELDS = [
    'grandTotal', 'total', 'amount', 'subtotal', 'tax', 'taxAmount', 'taxRate',
    'rows', 'lineItems', 'prices', 'priceMode', 'tier', 'selectedTier', 'tierName',
    'tierApplies', 'builder', 'sourceTemplates', 'materialMarkupPct', 'overhead',
    'profit', 'overheadPct', 'profitPct', 'minJobApplied', 'mode', 'jobMode',
    'claim', 'deposit', 'depositPlan', 'depositPctOverride', 'depositOverridePct',
  ];
  // Carried with the signed price, but not part of its version: the deposit
  // stamp is derived from the price (and carries display text).
  const UNVERSIONED = { deposit: true, depositPlan: true };

  // Only the claim's money inputs are priced (the deposit rule's deductible +
  // ACV); its carrier / claim number are not, and stay as saved.
  function _claimMoney(c) {
    if (!c || typeof c !== 'object') return null;
    const n = function (v) { const x = Number(v); return (v == null || v === '' || !isFinite(x)) ? null : x; };
    return { deductible: n(c.deductible), acv: n(c.acv) };
  }

  // Canonical JSON: keys sorted, timestamps as millis, undefined dropped, so
  // the browser and the admin SDK hash the same document identically.
  function _canon(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v !== 'object') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (Array.isArray(v)) return v.map(_canon);
    const out = {};
    Object.keys(v).sort().forEach(function (k) {
      if (v[k] !== undefined) out[k] = _canon(v[k]);
    });
    return out;
  }

  // cyrb53 — a small, dependency-free 53-bit string hash (browser + Node alike).
  function _hash53(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  }

  /** The priced fields of an estimate, as they would be signed (present keys only). */
  function signedPriceSnapshot(est) {
    const out = {};
    if (!est || typeof est !== 'object') return out;
    PRICED_FIELDS.forEach(function (k) {
      if (est[k] === undefined) return;
      out[k] = (k === 'claim') ? _claimMoney(est[k]) : est[k];
    });
    return out;
  }

  /** The version of an estimate's price — changes when any priced field does. */
  function pricedFingerprint(est) {
    const snap = signedPriceSnapshot(est);
    const versioned = {};
    Object.keys(snap).forEach(function (k) { if (!UNVERSIONED[k]) versioned[k] = snap[k]; });
    return 'p1-' + _hash53(JSON.stringify(_canon(versioned)));
  }

  function _signed(est) {
    const sp = est && est.signedPrice;
    return (sp && typeof sp === 'object' && sp.fields && typeof sp.fields === 'object') ? sp : null;
  }

  /** Has this estimate been signed (a server-stamped signed price)? */
  function hasSignedPrice(est) { return !!_signed(est); }

  /**
   * The estimate as SIGNED: every priced field put back to the signed copy
   * (a field the signed copy did not have is removed, so a line list added
   * after signing cannot leak into a bill). No signed price → est unchanged.
   */
  function signedView(est) {
    const sp = _signed(est);
    if (!sp) return est;
    const out = Object.assign({}, est);
    PRICED_FIELDS.forEach(function (k) {
      if (k === 'claim') {
        if (sp.fields.claim && typeof sp.fields.claim === 'object') {
          out.claim = Object.assign({}, (est.claim && typeof est.claim === 'object') ? est.claim : {}, sp.fields.claim);
        }
        return;
      }
      if (Object.prototype.hasOwnProperty.call(sp.fields, k)) out[k] = sp.fields[k];
      else delete out[k];
    });
    return out;
  }

  /** Signed, then re-priced: the saved estimate is not what the homeowner signed. */
  function hasUnsignedChanges(est) {
    const sp = _signed(est);
    if (!sp) return false;
    return pricedFingerprint(est) !== (sp.fingerprint || pricedFingerprint(signedView(est)));
  }

  /** The signed total in cents, or null when the estimate has no signed price. */
  function signedTotalCents(est) {
    const sp = _signed(est);
    if (!sp) return null;
    if (Number.isFinite(Number(sp.totalCents)) && Number(sp.totalCents) > 0) return Math.round(Number(sp.totalCents));
    const v = estimateValue(signedView(est));
    return v > 0 ? Math.round(v * 100) : null;
  }
  // ── end signed price ──

  const _api = {
    buildDocLineItems: buildDocLineItems,
    buildDisplayRows: buildDisplayRows,
    numFrom: numFrom,
    moneyValue: moneyValue,
    estimateValue: estimateValue,
    estimateName: estimateName,
    tierApplies: tierApplies,
    estimateWarranty: estimateWarranty,
    WORKMANSHIP_WARRANTY_FALLBACK: WORKMANSHIP_WARRANTY_FALLBACK,
    ROOFING_TEMPLATE_ID_RE: ROOFING_TEMPLATE_ID_RE,
    LEGACY_WARRANTY_BY_ID: LEGACY_WARRANTY_BY_ID,
    PRICED_FIELDS: PRICED_FIELDS,
    signedPriceSnapshot: signedPriceSnapshot,
    pricedFingerprint: pricedFingerprint,
    hasSignedPrice: hasSignedPrice,
    signedView: signedView,
    hasUnsignedChanges: hasUnsignedChanges,
    signedTotalCents: signedTotalCents,
  };
  if (typeof window !== 'undefined') {
    window.NBDCustomerEstimateRows = _api;
  }
  // Node (unit tests) require() this file; expose the same API via CommonJS.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
  }
})();
