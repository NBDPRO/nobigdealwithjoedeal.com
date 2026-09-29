/**
 * expense-config.js — SINGLE SOURCE OF TRUTH for the expense / supplier-spend
 * subsystem. Shared by the entry form (Phase 1), the supplier-spend reports,
 * and the per-job margin engine so their definitions can never drift.
 *
 * Exposes: window.ExpenseConfig
 *
 * WHY a shared config: the recurring trap in this codebase is the same metric
 * defined two ways in two files (server writes one field, client reads another;
 * three views each pick a different "revenue"). Everything money-shaped about
 * expenses is defined ONCE here.
 *
 * Money rule: amounts are stored as INTEGER CENTS in Firestore (amountCents,
 * taxCents) to avoid binary-float drift. Dollars only ever exist at the UI
 * boundary. ProfitTracker.computeJobPL currently reads `lead.materialCost` in
 * DOLLARS, so the Phase-1 wiring converts cents -> dollars at that boundary.
 *
 * Revenue basis (Decision #3): gross margin is computed against the job's
 * ACCEPTED/CONTRACT price = lead.jobValue — the only revenue field present on
 * every job and the same one analytics-kpi / forecasting / lead-source-roi
 * already sum. Margin EXCLUDES commission + overhead by definition, so it is
 * labelled "Gross Margin (before overhead & commission)".
 *
 * Firestore: expenses/{id} (company-shared; see firestore.rules) +
 *   storage receipts/{uid}/ for the original image/PDF.
 */
(function () {
  'use strict';
  if (window.ExpenseConfig) return; // idempotent (re-exec under <template>/hydration)

  // ── Cost-type taxonomy ──────────────────────────────────────────────
  // 'direct'   = a job/COGS cost. Requires a leadId. SUBTRACTS from that
  //              job's revenue to produce gross margin.
  // 'overhead' = a company operating cost. Job-agnostic (leadId may be null).
  //              Does NOT touch any single job's gross margin.
  var COST_TYPE = { DIRECT: 'direct', OVERHEAD: 'overhead' };

  // Ordered category list (Decision #4 — roofing-tuned default).
  // scheduleCHint is an informational SUGGESTION only for the future CSV
  // export — it is NEVER auto-applied to a tax form (a service roofer with no
  // inventory generally expenses materials in Part II, not Part III COGS).
  // The export must let the accountant remap it.
  var CATEGORIES = [
    // Direct / job costs (feed per-job gross margin)
    { key: 'materials',         label: 'Materials',            costType: COST_TYPE.DIRECT,   scheduleCHint: 'Part II — Supplies (L22)' },
    { key: 'subcontractor',     label: 'Subcontractor',        costType: COST_TYPE.DIRECT,   scheduleCHint: 'Contract Labor (L11)', is1099: true },
    { key: 'direct_labor',      label: 'Direct Labor (crew)',  costType: COST_TYPE.DIRECT,   scheduleCHint: 'Wages (L26)' },
    { key: 'equipment_dumpster',label: 'Equipment & Dumpster', costType: COST_TYPE.DIRECT,   scheduleCHint: 'Rent/Lease — Other (L20b)' },
    { key: 'permits_fees',      label: 'Permits & Fees',       costType: COST_TYPE.DIRECT,   scheduleCHint: 'Taxes & Licenses (L23)' },
    { key: 'disposal',          label: 'Disposal / Tear-off',  costType: COST_TYPE.DIRECT,   scheduleCHint: 'Part II — Supplies (L22)' },
    // A per-lead acquisition fee (Thumbtack / Yelp / Angi). DIRECT, not
    // overhead: the fee bought THIS job, so it belongs against THIS job's
    // margin. Logging lead fees under 'marketing' (overhead) is precisely why
    // lead spend never reached the per-job gross-margin line.
    { key: 'lead_acquisition',  label: 'Lead / Acquisition Cost', costType: COST_TYPE.DIRECT, scheduleCHint: 'Advertising (L8)' },
    // Overhead / operating (company-level; do not hit per-job margin)
    { key: 'vehicle_fuel',      label: 'Vehicle & Fuel',       costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Car & Truck (L9)' },
    { key: 'insurance',         label: 'Insurance',            costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Insurance (L15)' },
    { key: 'marketing',         label: 'Marketing & Advertising', costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Advertising (L8)' },
    { key: 'software',          label: 'Software & Subscriptions', costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Other Expenses (L27a)' },
    { key: 'phone_internet',    label: 'Phone & Internet',     costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Utilities (L25)' },
    { key: 'office_supplies',   label: 'Office & Supplies',    costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Office Expense (L18)' },
    // Tools that outlive one job (drills, ladders, saws) — overhead, not a
    // single job's cost. Home Depot imports suggest it for tool-department
    // receipts and "TOOLS" job names (hd-import.js, 2026-09-29). Big-ticket
    // items may need depreciating — the accountant decides via the export.
    { key: 'tools_small_equipment', label: 'Tools & Small Equipment', costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Supplies (L22) / Depreciation (L13)' },
    { key: 'professional_admin',label: 'Professional & Admin', costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Legal & Professional (L17)' },
    // Mileage: a vehicle deduction (miles x IRS rate). costType overhead — it's
    // a business-vehicle cost, not a single job's COGS. amountCents is computed
    // from miles, not typed. NOTE: standard mileage and actual-vehicle-cost
    // methods are mutually exclusive per vehicle/year — don't claim both.
    { key: 'mileage',           label: 'Mileage',              costType: COST_TYPE.OVERHEAD, scheduleCHint: 'Car & Truck (L9)' }
  ];

  var BY_KEY = {};
  CATEGORIES.forEach(function (c) { BY_KEY[c.key] = c; });

  function costTypeFor(categoryKey) {
    var c = BY_KEY[categoryKey];
    return c ? c.costType : COST_TYPE.OVERHEAD; // unknown -> overhead (never silently counts as a job cost)
  }
  function isDirect(categoryKey) { return costTypeFor(categoryKey) === COST_TYPE.DIRECT; }

  // ── IRS standard mileage rate (BUSINESS), cents per mile, by tax year ──
  // Changes every January — keep this table current. Only the BUSINESS rate is
  // exposed (medical/charitable differ + would invite mis-entry).
  var IRS_MILEAGE_CENTS = { 2023: 65.5, 2024: 67.0, 2025: 70.0, 2026: 72.5 };
  var LATEST_MILEAGE_YEAR = 2026;
  function mileageRateCents(yearOrDate) {
    var y = yearOrDate;
    if (yearOrDate instanceof Date) y = yearOrDate.getFullYear();
    else if (typeof yearOrDate === 'string') y = new Date(yearOrDate).getFullYear();
    if (!IRS_MILEAGE_CENTS[y]) {
      // CLAMP to the nearest known year, don't fall FORWARD — a pre-2023 date
      // using the 2026 rate would overstate the deduction (QA finding).
      var ys = Object.keys(IRS_MILEAGE_CENTS).map(Number);
      var min = Math.min.apply(null, ys), max = Math.max.apply(null, ys);
      y = y < min ? min : max;
    }
    return IRS_MILEAGE_CENTS[y];
  }
  // Canonicalize a vendor/supplier name for matching: lowercase, strip
  // punctuation + common entity suffixes + collapse whitespace. Used to match
  // free-text expense.supplier to supplier records for YTD/1099 rollups so
  // 'ABC Supply', 'ABC Supply, LLC', 'abc  supply co.' all match (QA finding).
  function normVendor(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[.,#&]/g, ' ')
      .replace(/\b(inc|llc|l\.l\.c|co|corp|company|ltd)\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  // miles x cents/mile -> integer cents. Round (don't truncate) the half-cent.
  function mileageAmountCents(miles, rateCents) {
    var m = parseFloat(miles);
    if (!isFinite(m) || m < 0) return 0;
    var r = parseFloat(rateCents);
    if (!isFinite(r) || r <= 0) r = IRS_MILEAGE_CENTS[LATEST_MILEAGE_YEAR];
    return Math.round(m * r);
  }
  function labelFor(categoryKey) {
    var c = BY_KEY[categoryKey];
    return c ? c.label : (categoryKey || 'Uncategorized');
  }

  // ── Money helpers (cents <-> dollars) ───────────────────────────────
  // dollarsToCents: parse a user-typed dollar string to a SAFE integer cents.
  // Rounds to the nearest cent; non-numeric -> 0 (never NaN into Firestore).
  function dollarsToCents(input) {
    var n = parseFloat(input);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }
  function centsToDollars(cents) {
    var n = parseInt(cents, 10);
    if (!isFinite(n)) n = 0;
    return n / 100;
  }
  // formatCents: integer cents -> "$1,234.56" (USD). The ONE currency
  // formatter for this subsystem — do not add a fourth elsewhere.
  function formatCents(cents) {
    return centsToDollars(cents).toLocaleString('en-US', {
      style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  // ── Revenue basis (Decision #3) ─────────────────────────────────────
  var REVENUE_FIELD = 'jobValue';
  function getJobRevenue(lead) {
    if (!lead) return 0;
    var v = parseFloat(lead[REVENUE_FIELD]);
    return isFinite(v) ? v : 0; // dollars (matches ProfitTracker.computeJobPL)
  }

  // Sum the DIRECT-material cents for one job's expenses -> dollars, for the
  // ProfitTracker.materialCost boundary. (Phase 1 wires this in.)
  function jobMaterialDollars(expenses) {
    if (!Array.isArray(expenses)) return 0;
    var cents = expenses.reduce(function (sum, e) {
      return e && e.category === 'materials' ? sum + (parseInt(e.amountCents, 10) || 0) : sum;
    }, 0);
    return cents / 100;
  }

  // Required vs optional fields on an expenses/{id} doc (mirrors the rule
  // schema comment). Used by the Phase-1 form validator + the OCR reconcile.
  var REQUIRED_FIELDS = ['userId', 'companyId', 'category', 'costType', 'amountCents', 'date'];

  // ── A4: budget / overspend thresholds ──
  // directCostPctWarn: amber when a job's direct costs exceed this % of its
  // contract value. marginFloorPct: red when projected gross margin drops below
  // this. Industry-convention defaults; tenants override via
  // companyProfile.budgetDefaults (Settings → Company Profile → Job Budget
  // Alerts), threaded in as budgetStatus's optional 3rd arg.
  var BUDGET = { directCostPctWarn: 65, marginFloorPct: 30 };
  // A threshold override only counts if it is a real percentage; anything
  // else (blank field, string, 0, ≥100) falls back to the default so a
  // half-saved profile can never disable or invert the alerts.
  function _pct(v, fallback) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return (isFinite(n) && n > 0 && n < 100) ? n : fallback;
  }
  // Returns null (no signal) | 'warn' | 'breach' for a job's cost health.
  // thresholds: optional { directCostPctWarn, marginFloorPct } tenant override.
  function budgetStatus(revenueDollars, directCostDollars, thresholds) {
    if (!(revenueDollars > 0) || !(directCostDollars > 0)) return null;
    var t = thresholds || BUDGET;
    var warnPct = _pct(t.directCostPctWarn, BUDGET.directCostPctWarn);
    var floorPct = _pct(t.marginFloorPct, BUDGET.marginFloorPct);
    var marginPct = (revenueDollars - directCostDollars) / revenueDollars * 100;
    var costPct = directCostDollars / revenueDollars * 100;
    if (marginPct < floorPct || costPct >= 100) return 'breach';
    if (costPct >= warnPct) return 'warn';
    return null;
  }

  window.ExpenseConfig = {
    COST_TYPE: COST_TYPE,
    CATEGORIES: CATEGORIES,
    byKey: BY_KEY,
    costTypeFor: costTypeFor,
    isDirect: isDirect,
    labelFor: labelFor,
    IRS_MILEAGE_CENTS: IRS_MILEAGE_CENTS,
    LATEST_MILEAGE_YEAR: LATEST_MILEAGE_YEAR,
    mileageRateCents: mileageRateCents,
    mileageAmountCents: mileageAmountCents,
    normVendor: normVendor,
    BUDGET: BUDGET,
    budgetStatus: budgetStatus,
    dollarsToCents: dollarsToCents,
    centsToDollars: centsToDollars,
    formatCents: formatCents,
    REVENUE_FIELD: REVENUE_FIELD,
    getJobRevenue: getJobRevenue,
    jobMaterialDollars: jobMaterialDollars,
    REQUIRED_FIELDS: REQUIRED_FIELDS,
    // Currency is USD-only for v1 (matches invoices/estimates). OCR may return
    // a currency code; the form clamps to 'USD' until multi-currency is built.
    DEFAULT_CURRENCY: 'USD'
  };
})();
