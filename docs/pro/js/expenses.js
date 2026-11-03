/**
 * expenses.js — Expenses & Supplier-Spend view (#/expenses).
 *
 * Phase 1 of the expense subsystem: manual expense logging (with optional
 * receipt upload), supplier-spend metrics, category + per-job breakdowns, and
 * per-job gross margin fed from the expense ledger via ProfitTracker.
 *
 * Exposes: window.Expenses
 *
 * Depends on window.ExpenseConfig (loaded first in the same lazy bundle) for
 * the category->costType map, revenue basis, and cents<->dollars helpers — the
 * single source of truth. Pure functions (aggregate / jobMargin) are exported
 * for unit testing in the vm sandbox.
 *
 * Data: expenses/{id} (company-shared; see firestore.rules). Reads are scoped
 * by the rule — a company_admin/manager queries by companyId (whole team), a
 * rep/solo operator queries by userId (own). Querying by companyId as a non-
 * staff user is permission-denied, so the scope is chosen from the role claim.
 * Receipts: receipts/{uid}/ in Storage (image/PDF, see storage.rules).
 */
(function () {
  'use strict';

  var EC = function () { return window.ExpenseConfig; };

  // ── identity / scope ────────────────────────────────────────────────
  function uid() { return (window._user && window._user.uid) || null; }
  function claims() { return window._userClaims || {}; }
  function companyId() { return claims().companyId || uid(); }
  // Flag `costsPaidFrom` (feature_flags/_default; absent = off, "ship dark"). On: paidFrom is
  // required on new costs, the receipt link + CSV columns appear, zero-cost jobs show
  // "no costs entered", and the bulk CSV import is available.
  var COSTS_FLAG = 'costsPaidFrom';
  function costsFlagOn() {
    return !!(window.NBDFlags && typeof window.NBDFlags.enabled === 'function' && window.NBDFlags.enabled(COSTS_FLAG));
  }
  // Flag `costCredits` (feature_flags/_default; absent = off, "ship dark"). On: the Log Expense
  // form gets an entry-type picker (cost / credit / adjustment), the bulk CSV import accepts an
  // `entryType` column, and the CSV export gets Entry Type + Related columns. Reading is NOT
  // gated: a credit row that already exists always nets out of every total (see
  // ExpenseConfig.signedCents), so turning the flag off never overstates spend.
  var CREDITS_FLAG = 'costCredits';
  function creditsFlagOn() {
    return !!(window.NBDFlags && typeof window.NBDFlags.enabled === 'function' && window.NBDFlags.enabled(CREDITS_FLAG));
  }
  // Signed cents of one ledger row (credit = negative). Falls back to the same rule when
  // ExpenseConfig is not loaded so a total can never silently ignore a credit.
  function sgnCents(e, withTax) {
    var c = EC();
    if (c && c.signedCents) return c.signedCents(e, withTax);
    var v = (parseInt(e && e.amountCents, 10) || 0) + (withTax === false ? 0 : (parseInt(e && e.taxCents, 10) || 0));
    return e && e.entryType === 'credit' ? -v : v;
  }
  function isStaff() {
    var r = claims().role;
    return r === 'company_admin' || r === 'manager' || r === 'admin';
  }
  // The job on this customer's card right now (multi-job), or null.
  function jobIdForLead(leadId) {
    if (!leadId) return null;
    var l = (window._leads || []).find(function (x) { return x && x.id === leadId; });
    var j = l && l.activeJobId;
    return typeof j === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(j) ? j : null;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, type) {
    if (typeof window.showToast === 'function') return window.showToast(msg, type);
    if (typeof window.toast === 'function') return window.toast(msg, type);
    console.log('[expenses]', type || 'info', msg);
  }
  function money(cents) {
    var c = EC();
    return c ? c.formatCents(cents) : ('$' + ((parseInt(cents, 10) || 0) / 100).toFixed(2));
  }
  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate(); // Firestore Timestamp
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDate(v) {
    var d = toDate(v);
    return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }
  // LOCAL yyyy-mm-dd — toISOString() converts to UTC and shifts the day back in
  // US timezones for local-midnight dates (QA finding). Use for date keys/CSV.
  function ymdLocal(d) {
    if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  var _expenses = [];
  // What the 1000-row cap did to the last load, judged on the RAW rows (voided ones included):
  // { capped, count, cap, oldestMs|null }. Month close reads it so a capped list cannot pass as complete.
  var EXPENSE_CAP = 1000;
  var _expMeta = { capped: false, count: 0, cap: EXPENSE_CAP, oldestMs: null };
  var _loaded = false;
  var _scannedPath = null;       // receipt uploaded during an AI scan (reused on save)
  var _scanExtraction = null;    // last extraction (carries source/needsReview to save)
  var _receiptCallable = null;
  var _estCostByLead = {};       // leadId -> budgeted direct cost in CENTS (from V2 estimates)
  var _recurring = [];           // recurringExpenses templates (A1b)
  var _suppliers = [];           // supplier records (A5)

  // ── data layer ──────────────────────────────────────────────────────
  async function fetchExpenses() {
    if (!window.db || !uid() || !window.getDocs) return [];
    var col = window.collection(window.db, 'expenses');
    var q;
    // Rule-safe scope: staff read the whole tenant (companyId); everyone else
    // reads only their own (userId). A companyId query by a non-staff user is
    // permission-denied (isCompanyStaff() is false).
    if (isStaff() && claims().companyId) {
      q = window.query(col, window.where('companyId', '==', companyId()), window.orderBy('date', 'desc'), window.limit(1000));
    } else {
      q = window.query(col, window.where('userId', '==', uid()), window.orderBy('date', 'desc'), window.limit(1000));
    }
    try {
      var snap = await window.getDocs(q);
      var oldest = 0;
      snap.docs.forEach(function (d) {
        var v = d.data().date, ms = !v ? 0 : (typeof v.toMillis === 'function' ? v.toMillis() : (v instanceof Date ? v.getTime() : (typeof v.seconds === 'number' ? v.seconds * 1000 : new Date(v).getTime())));
        if (ms && (!oldest || ms < oldest)) oldest = ms;
      });
      _expMeta = { capped: snap.docs.length >= EXPENSE_CAP, count: snap.docs.length, cap: EXPENSE_CAP, oldestMs: oldest || null };
      // A voided row (a cash payout marked deleted) is kept in Firestore for its
      // audit note but must not count in any total.
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .filter(function (e) { return e.deleted !== true; });
    } catch (e) {
      console.warn('[expenses] fetch failed', e);
      toast('Could not load expenses', 'error');
      return [];
    }
  }

  // Budgeted direct cost per job for estimated-vs-actual variance. Only the V2
  // estimate builder persists a cost basis (materialCost + laborCost); the
  // classic builder stores only grandTotal (customer PRICE, not cost), so those
  // jobs get no variance. Rule-safe: estimates are owner-read, so query by
  // userId (a company_admin viewing a teammate's job won't get their estimate —
  // variance just shows "—" there). where(userId==) needs only the auto
  // single-field index.
  async function fetchEstimateCosts() {
    _estCostByLead = {};
    if (!window.db || !uid() || !window.getDocs) return;
    try {
      var snap = await window.getDocs(window.query(
        window.collection(window.db, 'estimates'),
        window.where('userId', '==', uid()), window.limit(1000)));
      snap.docs.forEach(function (d) {
        var e = d.data();
        if (!e || !e.leadId) return;
        var mat = parseFloat(e.materialCost), lab = parseFloat(e.laborCost);
        if (!isFinite(mat) && !isFinite(lab)) return; // classic / no cost basis
        var cents = Math.round(((isFinite(mat) ? mat : 0) + (isFinite(lab) ? lab : 0)) * 100);
        // Keep the largest cost-basis estimate per lead (latest revision tends
        // to be the most complete; ties resolve to the bigger number).
        if (cents > 0 && cents >= (_estCostByLead[e.leadId] || 0)) _estCostByLead[e.leadId] = cents;
      });
    } catch (err) { console.warn('[expenses] estimate-cost fetch failed', err); }
  }

  // Estimated-vs-actual for one job. Returns null if no V2 cost basis exists.
  function estVsActual(leadId, actualDirectCents) {
    var est = _estCostByLead[leadId];
    if (!est || est <= 0) return null;
    return { estCents: est, actualCents: actualDirectCents, varianceCents: actualDirectCents - est };
  }

  // ── A1b: recurring-expense templates (one-tap-add model) ────────────
  var FREQUENCIES = [
    { key: 'weekly', label: 'Weekly' }, { key: 'biweekly', label: 'Every 2 weeks' },
    { key: 'monthly', label: 'Monthly' }, { key: 'quarterly', label: 'Quarterly' }, { key: 'annual', label: 'Annual' }
  ];
  // Advance a date by one cadence. Pure (exported for tests). Month-stepping
  // cadences CLAMP the day to the target month's last day so Jan 31 + 1mo ->
  // Feb 28/29 (not a skip to Mar 3, which setMonth would do) — QA finding.
  function addMonthsClamped(d, n) {
    var day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    var lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  }
  function advanceDate(date, frequency) {
    var d = toDate(date) || new Date();
    d = new Date(d.getTime());
    if (frequency === 'weekly') d.setDate(d.getDate() + 7);
    else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
    else if (frequency === 'quarterly') addMonthsClamped(d, 3);
    else if (frequency === 'annual') addMonthsClamped(d, 12);
    else addMonthsClamped(d, 1); // monthly (default)
    return d;
  }
  // Advance a template's nextDueDate to the first occurrence STRICTLY in the
  // future, so a long-overdue template doesn't stay perpetually "Due" or
  // double-log on repeated taps (QA finding).
  function advanceToFuture(date, frequency) {
    var nd = advanceDate(date, frequency);
    var guard = 0;
    while (toDate(nd) && toDate(nd).getTime() <= Date.now() && guard++ < 600) nd = advanceDate(nd, frequency);
    return nd;
  }
  function isDue(template) {
    if (!template || template.status !== 'active') return false;
    var due = toDate(template.nextDueDate);
    return due && due.getTime() <= Date.now();
  }

  async function fetchRecurring() {
    _recurring = [];
    if (!window.db || !uid() || !window.getDocs) return;
    try {
      // Single-equality scope (auto single-field index, no composite). Sort client-side.
      var q = (isStaff() && claims().companyId)
        ? window.query(window.collection(window.db, 'recurringExpenses'), window.where('companyId', '==', companyId()))
        : window.query(window.collection(window.db, 'recurringExpenses'), window.where('userId', '==', uid()));
      var snap = await window.getDocs(q);
      _recurring = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) { console.warn('[expenses] recurring fetch failed', e); }
  }

  async function createRecurringTemplate(form, freq) {
    var u = uid(), c = EC();
    if (!u || !window.addDoc || !c) return;
    var category = (form.category && c.byKey[form.category]) ? form.category : 'materials';
    try {
      await window.addDoc(window.collection(window.db, 'recurringExpenses'), {
        userId: u, companyId: claims().companyId || u,
        name: (form.supplier || c.labelFor(category)).slice(0, 80),
        amountCents: c.dollarsToCents(form.amount), category: category, costType: c.costTypeFor(category),
        supplier: (form.supplier || '').trim().slice(0, 120), frequency: freq, status: 'active',
        nextDueDate: advanceDate(form.date ? new Date(form.date + 'T00:00:00') : new Date(), freq),
        createdAt: window.serverTimestamp(), createdBy: u, updatedAt: window.serverTimestamp()
      });
    } catch (e) { console.warn('[expenses] recurring template create failed', e); }
  }

  // One-tap: log an expense from a due template + advance its nextDueDate.
  async function addFromTemplate(id) {
    var t = _recurring.find(function (r) { return r.id === id; });
    if (!t) return;
    var ok = await createExpense({
      amount: ((parseInt(t.amountCents, 10) || 0) / 100).toFixed(2),
      date: ymdLocal(new Date()),
      supplier: t.supplier || '', category: t.category, note: 'Recurring: ' + (t.name || ''), source: 'manual'
    });
    if (ok) {
      try {
        await window.updateDoc(window.doc(window.db, 'recurringExpenses', id), {
          nextDueDate: advanceToFuture(t.nextDueDate, t.frequency), updatedAt: window.serverTimestamp()
        });
      } catch (e) { console.warn('[expenses] advance recurring failed', e); }
      await refresh();
    }
  }
  async function deleteTemplate(id) {
    try { await window.deleteDoc(window.doc(window.db, 'recurringExpenses', id)); await refresh(); }
    catch (e) { toast('Could not delete (only the owner can)', 'error'); }
  }

  // ── A5: suppliers / 1099 tracking (NO TIN stored — tracking only) ───
  // Tax classifications and whether they're generally 1099-eligible. Derived
  // from the W-9 tax classification, NOT guessed. Corps are exempt EXCEPT
  // attorneys; materials-only (pure goods) is never 1099-NEC reportable.
  var TAX_CLASSES = [
    { key: 'individual',  label: 'Individual / Sole-prop', eligible: true },
    { key: 'partnership', label: 'Partnership',            eligible: true },
    { key: 'llc',         label: 'LLC (not taxed as corp)', eligible: true },
    { key: 'attorney',    label: 'Attorney / Law firm',    eligible: true },
    { key: 'c_corp',      label: 'C-Corporation',          eligible: false },
    { key: 's_corp',      label: 'S-Corporation',          eligible: false },
    { key: 'materials_only', label: 'Materials-only (goods)', eligible: false }
  ];
  var TAX_CLASS_BY_KEY = {};
  TAX_CLASSES.forEach(function (t) { TAX_CLASS_BY_KEY[t.key] = t; });
  function is1099EligibleFromClass(taxClass) {
    var t = TAX_CLASS_BY_KEY[taxClass];
    return t ? !!t.eligible : false;
  }
  // 1099-NEC reporting threshold by tax year. OBBBA raised it to $2,000 for
  // 2026+; do NOT hardcode $600. Cents.
  var TAX_1099_THRESHOLD_CENTS = { 2023: 60000, 2024: 60000, 2025: 60000, 2026: 200000 };
  function thresholdCents(year) { return TAX_1099_THRESHOLD_CENTS[year] || 200000; }

  async function fetchSuppliers() {
    _suppliers = [];
    if (!window.db || !uid() || !window.getDocs) return;
    try {
      var q = (isStaff() && claims().companyId)
        ? window.query(window.collection(window.db, 'suppliers'), window.where('companyId', '==', companyId()))
        : window.query(window.collection(window.db, 'suppliers'), window.where('userId', '==', uid()));
      var snap = await window.getDocs(q);
      _suppliers = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) { console.warn('[expenses] suppliers fetch failed', e); }
  }

  // YTD service-payment rollup for a supplier (cents), matched by name to
  // service-category expenses in the given year. Only services count toward a
  // 1099 (materials/goods don't). Pure (exported for tests).
  function supplierYtdCents(supplierName, year, expenses) {
    var nv = EC() && EC().normVendor ? EC().normVendor : function (s) { return String(s || '').trim().toLowerCase(); };
    var name = nv(supplierName);
    if (!name) return 0;
    return (expenses || []).reduce(function (sum, e) {
      if (!e || (e.category !== 'subcontractor' && e.category !== 'direct_labor')) return sum;
      if (e.estimated === true) return sum; // an estimate was never paid: not a 1099 payment
      if (nv(e.supplier) !== name) return sum;
      var d = toDate(e.date);
      if (!d || d.getFullYear() !== year) return sum;
      // Pre-tax; a credit (refund of a sub payment) nets the 1099 total down.
      return sum + sgnCents(e, false);
    }, 0);
  }
  // Is this supplier on the year-end 1099 worklist? eligible class + W-9 on file
  // + YTD service spend at/above the year's threshold. Pure (exported).
  function needs1099(supplier, year, expenses) {
    if (!supplier || !is1099EligibleFromClass(supplier.taxClassification)) return false;
    var w9ok = supplier.w9Status === 'received' || supplier.w9Status === 'verified';
    var ytd = supplierYtdCents(supplier.displayName, year, expenses);
    return w9ok && ytd >= thresholdCents(year);
  }

  async function createSupplier(form) {
    var u = uid(), c = EC();
    if (!u || !window.addDoc) { toast('Not signed in', 'error'); return false; }
    var name = (form.displayName || '').trim();
    if (!name) { toast('Supplier name required', 'error'); return false; }
    var taxClass = TAX_CLASS_BY_KEY[form.taxClassification] ? form.taxClassification : 'individual';
    try {
      await window.addDoc(window.collection(window.db, 'suppliers'), {
        userId: u, companyId: claims().companyId || u,
        displayName: name.slice(0, 120),
        legalName: (form.legalName || '').trim().slice(0, 120),
        taxClassification: taxClass,
        is1099Eligible: is1099EligibleFromClass(taxClass),
        w9Status: ['not_requested', 'requested', 'received', 'verified'].indexOf(form.w9Status) !== -1 ? form.w9Status : 'not_requested',
        contact: { phone: (form.phone || '').trim().slice(0, 40), email: (form.email || '').trim().slice(0, 120) },
        createdAt: window.serverTimestamp(), createdBy: u, updatedAt: window.serverTimestamp()
        // NOTE: NO tin/ssn/ein field — tracking only (rules hard-reject those keys).
      });
      toast('Supplier added', 'ok');
      return true;
    } catch (e) { console.error('[expenses] createSupplier failed', e); toast('Failed to add supplier', 'error'); return false; }
  }

  async function uploadReceipt(file, u) {
    if (!window.storage || !window.ref || !window.uploadBytes) throw new Error('storage unavailable');
    var ts = Date.now();
    var safe = (file.name || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    var body = await downscaleImage(file); // shrink huge phone photos; no-op for PDF/HEIC
    var path = 'receipts/' + u + '/' + ts + '_' + safe;
    await window.uploadBytes(window.ref(window.storage, path), body, { contentType: (body && body.type) || file.type || 'application/octet-stream' });
    return path;
  }

  // Downscale a large JPEG/PNG/WebP via canvas before upload (cuts upload size +
  // OCR cost/latency). Returns a Blob, or the ORIGINAL file unchanged for PDFs,
  // HEIC/other formats the browser can't decode, small images, or any failure.
  function downscaleImage(file) {
    return new Promise(function (resolve) {
      try {
        var t = file && file.type || '';
        if (!/^image\/(jpeg|png|webp)$/.test(t) || file.size < 1200 * 1024) return resolve(file);
        var url = URL.createObjectURL(file);
        var img = new Image();
        var done = false;
        var finish = function (out) { if (done) return; done = true; try { URL.revokeObjectURL(url); } catch (e) {} resolve(out); };
        var timer = setTimeout(function () { finish(file); }, 8000);
        img.onload = function () {
          try {
            var max = 1600, scale = Math.min(1, max / Math.max(img.width, img.height));
            if (scale >= 1) { clearTimeout(timer); return finish(file); }
            var cv = document.createElement('canvas');
            cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            cv.toBlob(function (blob) { clearTimeout(timer); finish(blob && blob.size < file.size ? blob : file); }, 'image/jpeg', 0.85);
          } catch (e) { clearTimeout(timer); finish(file); }
        };
        img.onerror = function () { clearTimeout(timer); finish(file); }; // HEIC etc. → keep original
        img.src = url;
      } catch (e) { resolve(file); }
    });
  }

  // Client-side duplicate guard: same supplier + amount + calendar day already
  // logged. Returns the matching expense or null.
  function findDuplicate(supplier, amountCents, dateStr, entryType) {
    // Match vendors the SAME way the 1099/YTD rollup does (normVendor) so a re-scan
    // that returns 'ABC Supply' vs 'ABC Supply, LLC' still trips the dup guard.
    var nv = (EC() && EC().normVendor) ? EC().normVendor : function (s) { return String(s || '').trim().toLowerCase(); };
    var sup = nv(supplier);
    var wantType = (EC() && EC().entryTypeKey && EC().entryTypeKey(entryType)) || 'cost';
    return _expenses.find(function (e) {
      // A $100 credit on the same day as a $100 cost is a refund, not a duplicate.
      if (((EC() && EC().entryTypeOf) ? EC().entryTypeOf(e) : 'cost') !== wantType) return false;
      if ((parseInt(e.amountCents, 10) || 0) !== amountCents) return false;
      if (nv(e.supplier) !== sup) return false;
      var ed = toDate(e.date);
      return ed && ymdLocal(ed) === dateStr;
    }) || null;
  }

  // file must be an image or PDF (storage rule: isDocType allows image/* + pdf)
  function receiptTypeOk(file) {
    if (!file) return true;
    var t = file.type || '';
    return /^image\//.test(t) || t === 'application/pdf';
  }

  async function createExpense(form) {
    var u = uid();
    var c = EC();
    if (!u || !window.db || !window.addDoc) { toast('Not signed in', 'error'); return false; }
    if (!c) { toast('Expense config not loaded', 'error'); return false; }

    var category = (form.category && c.byKey[form.category]) ? form.category : 'materials';
    var costType = c.costTypeFor(category);

    // Flag costCredits: a credit / refund / return / adjustment is its own dated row
    // (append-only; the original cost is never touched). Amount stays POSITIVE.
    var entryType = (c.entryTypeKey && c.entryTypeKey(form.entryType)) || 'cost';
    var credit = null; // { relatedExpenseId, creditRef, reason } for non-cost rows
    if (entryType !== 'cost') {
      var bad = function (m) { if (!form.quiet) toast(m, 'error'); return false; };
      if (!creditsFlagOn()) return bad('Credits and adjustments are not turned on');
      if (category === 'mileage') return bad('Mileage cannot be a credit; log a cost instead');
      var relId = String(form.relatedExpenseId == null ? '' : form.relatedExpenseId).trim();
      if (relId) {
        if (relId.length > c.RELATED_ID_MAX) return bad('Related cost id is too long');
        if (!_expenses.some(function (x) { return x && x.id === relId; })) return bad('The related cost was not found in your ledger');
      }
      var cref = String(form.creditRef == null ? '' : form.creditRef).trim();
      var why = String(form.reason == null ? '' : form.reason).trim();
      if (cref.length > c.CREDIT_REF_MAX) return bad('Credit memo number is over ' + c.CREDIT_REF_MAX + ' characters');
      if (why.length > c.REASON_MAX) return bad('Reason is over ' + c.REASON_MAX + ' characters');
      credit = { relatedExpenseId: relId, creditRef: cref, reason: why };
    }

    // Flag costsPaidFrom: how it was paid is required, the receipt link must be https.
    // A credit / adjustment is not a payment, so it does not need a "paid from".
    var paidFlag = costsFlagOn();
    var paidFrom = paidFlag ? c.paidFromKey(form.paidFrom) : '';
    var receiptUrl = paidFlag ? String(form.receiptUrl == null ? '' : form.receiptUrl).trim() : '';
    if (paidFlag) {
      if (!paidFrom && entryType === 'cost') { if (!form.quiet) toast('Pick how this was paid', 'error'); return false; }
      if (!c.receiptUrlOk(receiptUrl)) { if (!form.quiet) toast('Receipt link must start with https:// (max ' + c.RECEIPT_URL_MAX + ' characters)', 'error'); return false; }
    }

    // Mileage: the amount is COMPUTED (miles x the IRS rate snapshotted by the
    // entry's tax year), not typed.
    var miles = null, mileageRateCents = null, amountCents;
    if (category === 'mileage') {
      miles = parseFloat(form.miles);
      if (!isFinite(miles) || miles <= 0) { toast('Enter miles greater than 0', 'error'); return false; }
      var mDate = form.date ? new Date(form.date + 'T00:00:00') : new Date();
      mileageRateCents = c.mileageRateCents(isNaN(mDate.getTime()) ? new Date() : mDate);
      amountCents = c.mileageAmountCents(miles, mileageRateCents);
    } else {
      amountCents = c.dollarsToCents(form.amount);
    }
    if (amountCents <= 0) { toast('Enter an amount greater than $0', 'error'); return false; }

    // A direct-cost expense with no job attached is allowed, but its COGS won't
    // reach any job's margin — nudge non-blockingly via the save toast below
    // (product decision 2026-07-08: allow but warn). A blocking confirm() would
    // stall bulk entry and every automated/headless save. (#6)
    var unassignedDirect = costType === 'direct' && !form.leadId;

    var receiptStoragePath = null;
    if (form.uploadedPath) {
      // Already uploaded during an AI scan — reuse it, don't upload twice.
      receiptStoragePath = form.uploadedPath;
    } else if (form.file) {
      if (!receiptTypeOk(form.file)) { toast('Receipt must be an image or PDF', 'error'); return false; }
      if (form.file.size > 25 * 1024 * 1024) { toast('Receipt is over the 25MB limit', 'error'); return false; }
      try { receiptStoragePath = await uploadReceipt(form.file, u); }
      catch (e) { console.warn('[expenses] receipt upload failed', e); toast('Receipt upload failed; saved without it', 'warn'); }
    }

    var dateObj = form.date ? new Date(form.date + 'T00:00:00') : new Date();
    if (isNaN(dateObj.getTime())) dateObj = new Date();

    var docData = {
      userId: u,
      companyId: claims().companyId || u,
      leadId: form.leadId || null,
      // Multi-job (2026-09-30): the job this cost belongs to — the job on the
      // customer's card when it's logged — so margin can later go per job.
      jobId: jobIdForLead(form.leadId),
      category: category,
      costType: costType,
      supplier: (form.supplier || '').trim().slice(0, 120),
      amountCents: amountCents,
      // Clamp negative tax — ExpenseConfig.dollarsToCents does not reject negatives
      // and the form's min=0 is client-only, so a typed '-5' would persist -500.
      taxCents: Math.max(0, c.dollarsToCents(form.tax) || 0),
      currency: c.DEFAULT_CURRENCY,
      date: dateObj,
      note: (form.note || '').trim().slice(0, 500),
      receiptStoragePath: receiptStoragePath,
      receiptDocRef: null,
      miles: miles,
      mileageRateCents: mileageRateCents,
      marketingSource: (category === 'marketing' && form.marketingSource) ? String(form.marketingSource).trim().slice(0, 60) : null,
      source: form.source === 'ocr' ? 'ocr' : (form.source === 'import' ? 'import' : 'manual'),
      ocrConfidence: typeof form.ocrConfidence === 'number' ? form.ocrConfidence : null,
      needsReview: !!form.needsReview,
      createdAt: window.serverTimestamp(),
      createdBy: u,
      updatedAt: window.serverTimestamp()
    };
    if (paidFlag) {
      if (paidFrom) docData.paidFrom = paidFrom;
      if (receiptUrl) docData.receiptUrl = receiptUrl;
    }
    if (credit) {
      docData.entryType = entryType;
      if (credit.relatedExpenseId) docData.relatedExpenseId = credit.relatedExpenseId;
      if (credit.creditRef) docData.creditRef = credit.creditRef;
      if (credit.reason) docData.reason = credit.reason;
    }
    try {
      await window.addDoc(window.collection(window.db, 'expenses'), docData);
      if (form.quiet) return true;
      if (entryType !== 'cost') { toast(entryType === 'credit' ? 'Credit logged. Totals now net it.' : 'Adjustment logged', 'ok'); return true; }
      toast(unassignedDirect
        ? 'Expense logged — not linked to a job, so it won’t count toward job margin'
        : 'Expense logged', unassignedDirect ? 'warn' : 'ok');
      return true;
    } catch (e) {
      console.error('[expenses] create failed', e);
      if (!form.quiet) toast('Failed to save expense', 'error');
      return false;
    }
  }

  async function removeExpense(id) {
    if (!id || !window.db || !window.deleteDoc) return false;
    try {
      await window.deleteDoc(window.doc(window.db, 'expenses', id));
      toast('Expense deleted', 'ok');
      return true;
    } catch (e) {
      console.error('[expenses] delete failed', e);
      toast('Failed to delete (only the owner can)', 'error');
      return false;
    }
  }

  // ── AI receipt scan (Phase 2) ───────────────────────────────────────
  async function ensureReceiptCallable() {
    if (_receiptCallable) return _receiptCallable;
    if (window._httpsCallable && window._functions) {
      _receiptCallable = window._httpsCallable(window._functions, 'extractReceiptData');
      return _receiptCallable;
    }
    var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
    window._functions = window._functions || mod.getFunctions();
    window._httpsCallable = mod.httpsCallable;
    _receiptCallable = mod.httpsCallable(window._functions, 'extractReceiptData');
    return _receiptCallable;
  }

  function setScanStatus(msg, kind) {
    var el = document.getElementById('expScanStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'warn' ? 'var(--gold,#eab308)' : kind === 'error' ? 'var(--red,#dc2626)' : kind === 'ok' ? 'var(--green,#16a34a)' : 'var(--m,#9ca3af)';
  }

  function applyExtraction(d) {
    var ex = (d && d.extracted) || {};
    _scanExtraction = d || null;
    var setVal = function (id, v) { var el = document.getElementById(id); if (el && v != null && v !== '') el.value = v; };
    if (ex.totalCents) setVal('expAmount', (ex.totalCents / 100).toFixed(2)); // skip $0 — would dead-end Save
    if (ex.taxCents) setVal('expTax', (ex.taxCents / 100).toFixed(2));
    if (ex.vendor) setVal('expSupplier', ex.vendor);
    if (ex.date) setVal('expDate', ex.date);
    if (ex.suggestedCategory) { var sel = document.getElementById('expCategory'); if (sel) sel.value = ex.suggestedCategory; }
    var conf = Math.round((ex.confidence || 0) * 100);
    if (d && d.needsReview) {
      var why = (d.reconcile && !d.reconcile.matched) ? ' — line items don’t sum to the total' : '';
      setScanStatus('⚠ Review the fields' + why + ' (confidence ' + conf + '%). Correct anything off, then Save.', 'warn');
    } else {
      setScanStatus('✓ Scanned (confidence ' + conf + '%). Double-check, then Save.', 'ok');
    }
  }

  async function scanReceipt(btn) {
    var fileEl = document.getElementById('expFile');
    var file = fileEl && fileEl.files && fileEl.files[0];
    if (!file) { setScanStatus('Choose a receipt image or PDF first.', 'warn'); return; }
    if (!receiptTypeOk(file)) { setScanStatus('Receipt must be an image or PDF.', 'error'); return; }
    if (file.size > 25 * 1024 * 1024) { setScanStatus('Receipt is over the 25MB limit.', 'error'); return; }
    var u = uid();
    if (!u) { setScanStatus('Sign in required.', 'error'); return; }
    if (btn) btn.disabled = true;
    try {
      if (!_scannedPath) {
        setScanStatus('Uploading…');
        _scannedPath = await uploadReceipt(file, u);
      }
      setScanStatus('Reading the receipt with AI…');
      var call = await ensureReceiptCallable();
      var res = await call({ storagePath: _scannedPath });
      var d = res && res.data;
      if (!d || d.skipped) {
        var reason = d && d.reason;
        setScanStatus(
          reason === 'unsupported-format' ? 'That image format can’t be auto-read — enter the details manually.'
          : reason === 'user-cap' ? 'Monthly AI limit reached — enter the details manually.'
          : 'Couldn’t scan this one — enter the details manually.', 'warn');
        return;
      }
      applyExtraction(d);
    } catch (e) {
      console.warn('[expenses] scan failed', e);
      setScanStatus('Scan failed — enter the details manually (the receipt is still attached).', 'error');
    } finally { if (btn) btn.disabled = false; }
  }

  // Attach a receipt (photo or PDF) to an expense that has none — imported
  // Home Depot purchases arrive without one. Recommended, never required.
  function attachReceipt(expenseId) {
    var u = uid();
    if (!u || !expenseId) return;
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*,application/pdf';
    inp.style.display = 'none';
    inp.addEventListener('change', function () {
      var file = inp.files && inp.files[0];
      inp.remove();
      saveAttachedReceipt(expenseId, file);
    });
    document.body.appendChild(inp);
    inp.click();
  }

  async function saveAttachedReceipt(expenseId, file) {
    var u = uid();
    if (!file || !u) return false;
    if (!receiptTypeOk(file)) { toast('Receipt must be a photo or PDF', 'error'); return false; }
    if (file.size > 25 * 1024 * 1024) { toast('Receipt is over the 25MB limit', 'error'); return false; }
    if (!window.updateDoc || !window.doc) { toast('Not connected — try again', 'error'); return false; }
    try {
      toast('Uploading receipt…', 'info');
      var path = await uploadReceipt(file, u);
      await window.updateDoc(window.doc(window.db, 'expenses', expenseId), { receiptStoragePath: path, updatedAt: window.serverTimestamp() });
      _expenses.forEach(function (e) { if (e.id === expenseId) e.receiptStoragePath = path; });
      toast('Receipt attached', 'ok');
      render();
      return true;
    } catch (e) {
      console.warn('[expenses] attach receipt failed', e && e.code);
      toast(/permission/i.test((e && (e.code || e.message)) || '') ? 'Only the person who logged this expense can attach its receipt' : 'Could not attach the receipt — try again', 'error');
      return false;
    }
  }

  async function openReceipt(path) {
    if (!path || !window.getDownloadURL || !window.ref) return;
    try {
      var url = await window.getDownloadURL(window.ref(window.storage, path));
      window.open(url, '_blank', 'noopener');
    } catch (e) { toast('Could not open receipt', 'error'); }
  }

  // ── pure aggregation (exported for tests) ───────────────────────────
  function aggregate(list) {
    list = list || [];
    var c = EC();
    // Normalize vendor for grouping so "ABC Supply" / "abc supply " collapse to
    // one row (same normVendor the 1099 rollup uses); keep the first-seen raw
    // name as the display label. (#5)
    var nv = (c && c.normVendor) ? c.normVendor : function (s) { return String(s || '').trim().toLowerCase(); };
    var totalCents = 0, directCents = 0, overheadCents = 0, creditsCents = 0, creditCount = 0;
    var bySupplier = {}, byCategory = {}, byJob = {}, creditsByCategory = {}, creditsBySupplier = {};
    list.forEach(function (e) {
      // Spend/COGS rollups = tax-INCLUDED total (amount + tax): tax paid to the
      // supplier is real spend (product decision 2026-07-08). Same rule in
      // profit-tracker.js + money-dashboard.js. (#9)
      // A credit / refund row is SUBTRACTED (flag costCredits); amounts are stored positive.
      var cents = sgnCents(e);
      var isCr = c && c.isCredit ? c.isCredit(e) : e.entryType === 'credit';
      var ct = e.costType || (c ? c.costTypeFor(e.category) : 'overhead');
      totalCents += cents;
      if (ct === 'direct') directCents += cents; else overheadCents += cents;

      var supRaw = (e.supplier || '').trim() || 'Unknown';
      var supKey = nv(supRaw) || 'unknown';
      if (!bySupplier[supKey]) bySupplier[supKey] = { label: supRaw, cents: 0 };
      bySupplier[supKey].cents += cents;

      var cat = e.category || 'uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + cents;

      var job = e.leadId || '__unassigned__';
      if (!byJob[job]) byJob[job] = { cents: 0, directCents: 0, creditsCents: 0, count: 0 };
      byJob[job].cents += cents;
      if (ct === 'direct') byJob[job].directCents += cents;
      byJob[job].count += 1;
      if (isCr) {
        creditsCents += -cents; creditCount += 1;
        creditsByCategory[cat] = (creditsByCategory[cat] || 0) - cents;
        creditsBySupplier[supKey] = (creditsBySupplier[supKey] || 0) - cents;
        byJob[job].creditsCents += -cents;
      }
    });
    // Credits that exceed the costs in a bucket leave it NEGATIVE. That is shown as is (never
    // clamped to $0) and flagged, so nobody mistakes "we got more back than we spent" for a typo.
    Object.keys(byJob).forEach(function (k) {
      byJob[k].creditsExceed = byJob[k].creditsCents > 0 && byJob[k].cents < 0;
      byJob[k].directCreditsExceed = byJob[k].creditsCents > 0 && byJob[k].directCents < 0;
    });
    var suppliers = Object.keys(bySupplier).map(function (k) {
      return { supplier: bySupplier[k].label, cents: bySupplier[k].cents, creditsCents: creditsBySupplier[k] || 0,
        creditsExceed: (creditsBySupplier[k] || 0) > 0 && bySupplier[k].cents < 0,
        pct: totalCents ? (bySupplier[k].cents / totalCents * 100) : 0 };
    }).sort(function (a, b) { return b.cents - a.cents; });
    var categories = Object.keys(byCategory).map(function (k) {
      return { category: k, label: c ? c.labelFor(k) : k, cents: byCategory[k], creditsCents: creditsByCategory[k] || 0,
        creditsExceed: (creditsByCategory[k] || 0) > 0 && byCategory[k] < 0,
        pct: totalCents ? (byCategory[k] / totalCents * 100) : 0 };
    }).sort(function (a, b) { return b.cents - a.cents; });
    return {
      totalCents: totalCents, directCents: directCents, overheadCents: overheadCents,
      creditsCents: creditsCents, creditCount: creditCount,
      creditsExceed: creditsCents > 0 && (totalCents < 0 || directCents < 0 || overheadCents < 0),
      supplierCount: suppliers.length, suppliers: suppliers, categories: categories, byJob: byJob
    };
  }

  // Lead spend rollup (2026-09-20). Two subcategories, matching
  // expense-config.js's own taxonomy exactly: per-lead acquisition cost
  // (DIRECT — leadCost lives on the LEAD doc, not an expenses/{id} row, by
  // deliberate 09-06 decision, so it never double-books the same dollar in
  // two places) and Marketing & Advertising (OVERHEAD — the real expenses
  // ledger: Yelp/Angi monthly invoices, general ads, logged by hand since
  // those arrive as invoices, not a per-lead API figure). Reads
  // window._leads directly so this has real numbers even before anyone logs
  // a conventional expense.
  function leadSpendSummary() {
    var leads = (window._leads || []).filter(function (l) { return l && !l.deleted && !l.isProspect; });
    var leadCents = 0, leadCount = 0, bySource = {};
    leads.forEach(function (l) {
      var n = parseFloat(l.leadCost);
      if (!isFinite(n) || n <= 0) return;
      var c = Math.round(n * 100);
      leadCents += c; leadCount++;
      var src = (l.source || 'Unknown').trim() || 'Unknown';
      bySource[src] = (bySource[src] || 0) + c;
    });
    var sourceRows = Object.keys(bySource).map(function (k) {
      return { source: k, cents: bySource[k] };
    }).sort(function (a, b) { return b.cents - a.cents; });
    var marketingCents = _expenses.filter(function (e) { return e.category === 'marketing'; })
      .reduce(function (sum, e) { return sum + sgnCents(e); }, 0);
    return { leadCents: leadCents, leadCount: leadCount, sourceRows: sourceRows, marketingCents: marketingCents };
  }

  // Per-job gross margin from the expense ledger, via the existing margin
  // engine. Returns null when revenue or ProfitTracker is unavailable.
  function jobMargin(lead, jobExpenses) {
    if (!lead || !window.ProfitTracker || !window.ProfitTracker.computeJobPLWithExpenses) return null;
    var c = EC();
    var rev = c ? c.getJobRevenue(lead) : (parseFloat(lead.jobValue) || 0);
    if (!(rev > 0)) return null;
    return window.ProfitTracker.computeJobPLWithExpenses(lead, jobExpenses || []);
  }

  function leadById(id) { return (window._leads || []).find(function (l) { return l.id === id; }) || null; }
  function leadName(l) {
    if (!l) return 'Unknown job';
    var n = (l.name || ((l.firstName || '') + ' ' + (l.lastName || '')).trim());
    return n || l.address || 'Unnamed job';
  }

  // ── render ──────────────────────────────────────────────────────────
  function bar(pct, color) {
    return '<div class="exx-hei6px-bgs2-r4px">' +
      '<div style="height:100%;width:' + Math.max(2, Math.min(100, pct)).toFixed(1) + '%;background:' + color + ';"></div></div>';
  }

  function render() {
    var scroll = document.querySelector('#view-expenses .view-scroll');
    if (!scroll) return;
    var agg = aggregate(_expenses);
    var accent = 'var(--orange,#BD5728)';

    var html = '';
    // Header
    html += '<div class="exx-dflex-aicenter-jcspacebet">' +
      '<div><h2 class="exx-m0-ffbarlowco-fs26px">🧾 Expenses &amp; Supplier Spend</h2>' +
      '<div class="exx-fs12px-cm-mt2px">' + (isStaff() && claims().companyId ? 'Team-wide (all reps)' : 'Your expenses') + ' · ' + _expenses.length + ' logged</div></div>' +
      '<div class="exx-dflex-gap8px">' +
        (_expenses.length ? '<button type="button" class="btn btn-ghost" data-exp-action="export-csv" title="Download CSV for your accountant">⬇ Export CSV</button>' : '') +
        (costsFlagOn() ? '<button type="button" class="btn btn-ghost" data-exp-action="open-import" title="Import many costs from a CSV; you approve each row">⬆ Import costs (CSV)</button>' : '') +
        (window.NBDLowesImport ? window.NBDLowesImport.buttonHtml() : '') + (window.NBDHdImport ? '<button type="button" class="btn btn-ghost" data-hd-action="open" title="Import Home Depot Pro Xtra purchases (Purchase History › Export)">🧡 Import Home Depot</button>' : '') + (window.NBDReceiptSorter && window.NBDReceiptSorter.enabled() ? window.NBDReceiptSorter.buttonHtml() : '') +
        (window.NBDCashPayouts ? window.NBDCashPayouts.buttonHtml() : '') +
        (window.NBDJobCostAuditor ? window.NBDJobCostAuditor.buttonHtml() : '') +
        (window.NBDSubPayments ? window.NBDSubPayments.buttonHtml() : '') +
        (window.NBDPaymentBackfill ? window.NBDPaymentBackfill.buttonHtml() : '') +
        '<button type="button" class="btn btn-orange" data-exp-action="open-form">+ Log Expense</button>' +
      '</div>' +
      '</div>';

    // Summary cards
    html += '<div class="exx-dgrid-gtcrepeatau-gap12px">';
    // Credits are netted into every figure; the sub-line says how much, so a smaller
    // number is never a mystery. Credits bigger than the costs show as a NEGATIVE
    // figure with a warning, never as $0.
    var creditNote = agg.creditCount ? ' · net of ' + money(agg.creditsCents) + ' credits' : '';
    html += card('Total Spend', money(agg.totalCents), agg.supplierCount + (agg.supplierCount === 1 ? ' supplier' : ' suppliers') + creditNote, accent);
    html += card('Direct / Job Costs', money(agg.directCents), 'COGS — feeds margin', 'var(--green,#16a34a)');
    html += card('Overhead', money(agg.overheadCents), 'Operating costs', 'var(--blue,#3b82f6)');
    html += '</div>';
    if (agg.creditsExceed) {
      html += '<div class="exx-fs11px-cgold-mb10px">⚠ Credits (' + money(agg.creditsCents) + ') are more than the costs logged for part of this ledger, so a figure above is negative. Check the credits and their dates.</div>';
    }

    // Lead Spend — two subcategories (see leadSpendSummary above). Independent
    // of _expenses.length: leadCost lives on the lead doc, so this can have
    // real numbers before anyone logs a conventional expense.
    var ls = leadSpendSummary();
    if (ls.leadCents > 0 || ls.marketingCents !== 0) {
      var lsTotal = ls.leadCents + ls.marketingCents;
      var leadPct = lsTotal ? (ls.leadCents / lsTotal * 100) : 0;
      var mktPct = lsTotal ? (ls.marketingCents / lsTotal * 100) : 0;
      html += '<div class="ui-card exx-mb20px">' +
        '<h3 class="exx-m004px-fs14px-ct">📣 Lead Spend</h3>' +
        '<div class="exx-fs11px-cm-mb12px">What it costs to generate a lead — per-lead marketplace fees plus the marketing/advertising you log by hand.</div>' +
        '<div class="exx-mb14px">' +
          '<div class="ui-kv">' +
          '<span>Lead / Acquisition Cost <span class="ui-hint">(job cost — Thumbtack auto-captured)</span></span>' +
          '<span class="exx-w700">' + money(ls.leadCents) + '</span></div>' +
          bar(leadPct, 'var(--green,#16a34a)') +
          (ls.leadCount
            ? '<div class="exx-fs11px-cm-mt4px">' + ls.leadCount + ' lead' + (ls.leadCount === 1 ? '' : 's') +
              ' · ' + money(Math.round(ls.leadCents / ls.leadCount)) + ' avg' +
              (ls.sourceRows.length ? ' · ' + ls.sourceRows.slice(0, 3).map(function (r) { return esc(r.source) + ' ' + money(r.cents); }).join(' · ') : '') +
              '</div>'
            : '<div class="exx-fs11px-cm-mt4px">No per-lead cost captured yet.</div>') +
        '</div>' +
        '<div>' +
          '<div class="ui-kv">' +
          '<span>Marketing &amp; Advertising <span class="ui-hint">(overhead — logged by hand, e.g. Yelp/Angi invoices)</span></span>' +
          '<span class="exx-w700">' + money(ls.marketingCents) + '</span></div>' +
          (ls.marketingCents < 0 ? '<div class="exx-fs11px-cgold-mb10px">⚠ Marketing credits are more than the marketing costs logged.</div>' : '') +
          bar(Math.max(0, mktPct), 'var(--blue,#3b82f6)') +
        '</div>' +
        '</div>';
    }

    if (_expenses.length === 0) {
      html += '<div class="exx-bd1pxdashe-r12px">' +
        '<div class="nbd-empty"><div class="ne-icon">🧾</div>' +
        '<div class="ne-msg">No expenses yet</div>' +
        '<div class="ne-sub">Log your first material or supplier cost to start tracking spend and job margin. You can also add suppliers below.</div></div></div>';
    }

    // Expense-only analytics (spend report + per-job rollup) — only when there
    // are expenses. The Recurring + Suppliers sections below always render so
    // they're reachable even before the first expense is logged.
    if (_expenses.length) {
    // Two-column: supplier spend + category breakdown
    html += '<div class="exx-dgrid-gtcrepeatau-gap16px">';
    // Supplier spend (the explicit ask)
    html += '<div class="ui-card">' +
      '<h3 class="ui-card-head">Spend by Supplier</h3>';
    agg.suppliers.slice(0, 8).forEach(function (s) {
      html += '<div class="exx-mb10px">' +
        '<div class="ui-kv">' +
        '<span>' + esc(s.supplier) + '</span><span class="exx-w700">' + money(s.cents) + '</span></div>' +
        '<div class="ui-note">' + s.pct.toFixed(0) + '% of total' + (s.creditsCents ? ' · incl. ' + money(s.creditsCents) + ' credits' : '') + '</div>' +
        (s.creditsExceed ? '<div class="exx-fs11px-cgold-mb10px">⚠ Credits exceed costs for this supplier</div>' : '') +
        bar(Math.max(0, s.pct), accent) + '</div>';
    });
    html += '</div>';
    // Category breakdown
    html += '<div class="ui-card">' +
      '<h3 class="ui-card-head">Spend by Category</h3>';
    agg.categories.forEach(function (cat) {
      html += '<div class="exx-mb10px">' +
        '<div class="ui-kv">' +
        '<span>' + esc(cat.label) + '</span><span class="exx-w700">' + money(cat.cents) + '</span></div>' +
        (cat.creditsCents ? '<div class="ui-note">incl. ' + money(cat.creditsCents) + ' credits</div>' : '') +
        (cat.creditsExceed ? '<div class="exx-fs11px-cgold-mb10px">⚠ Credits exceed costs in this category</div>' : '') +
        bar(Math.max(0, cat.pct), 'var(--blue,#3b82f6)') + '</div>';
    });
    html += '</div>';
    html += '</div>';

    // Receipt health: unsorted receipts, finished jobs with no costs, PO-name copy.
    if (window.NBDReceiptHealth) html += window.NBDReceiptHealth.panelHtml(_expenses, window._leads || []);

    // Cash paid out to crew / subs (flag cashPayoutsLog; empty string when off).
    if (window.NBDCashPayouts) html += window.NBDCashPayouts.panelHtml(_expenses);

    // Job cost auditor (flag jobCostAuditor; empty string when off).
    if (window.NBDJobCostAuditor) html += window.NBDJobCostAuditor.panelHtml();

    // Sub payments sorter (flag subPaymentsSorter; empty string when off).
    if (window.NBDSubPayments) html += window.NBDSubPayments.panelHtml(_expenses);

    // Customer payment backfill (flag paymentBackfill, owner only; empty string when off).
    if (window.NBDPaymentBackfill) html += window.NBDPaymentBackfill.panelHtml();

    // Sub paperwork: W-9s, insurance papers, 1099 prep (flag subPaperwork; empty string when off).
    if (window.NBDSubPaperwork) html += window.NBDSubPaperwork.panelHtml();

    // Month close (flag monthClose; empty string when off).
    if (window.NBDMonthClose) html += window.NBDMonthClose.panelHtml();

    // Per-job rollup with margin
    var jobIds = Object.keys(agg.byJob).filter(function (k) { return k !== '__unassigned__'; });
    if (jobIds.length) {
      html += '<div class="ui-card exx-mb20px">' +
        '<h3 class="ui-card-head">Cost &amp; Margin by Job</h3>';
      jobIds.map(function (jid) {
        var jb = agg.byJob[jid];
        var lead = leadById(jid);
        var jobExp = _expenses.filter(function (e) { return e.leadId === jid; });
        var pl = jobMargin(lead, jobExp);
        return { jid: jid, jb: jb, lead: lead, pl: pl };
      }).sort(function (a, b) { return b.jb.cents - a.jb.cents; }).forEach(function (row) {
        var mColor = (!row.pl || row.pl.noCosts) ? 'var(--m,#9ca3af)' : row.pl.grossMargin >= 40 ? 'var(--green,#16a34a)' : row.pl.grossMargin >= 25 ? 'var(--gold,#eab308)' : 'var(--red,#dc2626)';
        var marginTxt = row.pl && row.pl.noCosts ? 'no costs entered' : row.pl ? (row.pl.grossMargin + '% margin' + (row.pl.creditsExceedCosts ? ' (credits exceed costs)' : '')) : (row.lead ? 'set Job Value' : 'job not found');
        // A4: budget / margin-floor flag (direct cost vs contract value)
        var ecB = EC();
        var rev = (ecB && row.lead) ? ecB.getJobRevenue(row.lead) : 0;
        var bDefaults = (window._companyProfile && window._companyProfile.budgetDefaults) || null;
        var bStatus = ecB && ecB.budgetStatus ? ecB.budgetStatus(rev, row.jb.directCents / 100, bDefaults) : null;
        var budgetBadge = bStatus === 'breach' ? '<span title="Over budget / margin below floor" class="exx-cred">⚠ </span>'
          : bStatus === 'warn' ? '<span title="Approaching cost budget" class="exx-cgold">⚠ </span>' : '';
        // Estimated-vs-actual (V2 estimates only)
        var va = estVsActual(row.jid, row.jb.directCents);
        var vaTxt = '';
        if (va) {
          var over = va.varianceCents > 0;
          var vColor = over ? 'var(--red,#dc2626)' : 'var(--green,#16a34a)';
          vaTxt = '<div class="ui-note">est ' + money(va.estCents) + ' · ' +
            '<span style="color:' + vColor + ';font-weight:700;">' + (over ? '+' : '') + money(Math.abs(va.varianceCents)) + (over ? ' over' : ' under') + '</span></div>';
        }
        html += '<div class="exx-dflex-jcspacebet-aicenter">' +
          '<div class="exx-minw0"><div class="exx-fs13px-ct-whinowrap">' + esc(leadName(row.lead)) + '</div>' +
          '<div class="ui-note">' + row.jb.count + (row.jb.count === 1 ? ' expense · ' : ' expenses · ') + money(row.jb.directCents) + ' direct' +
            (row.jb.creditsCents ? ' · incl. ' + money(row.jb.creditsCents) + ' credits' : '') + '</div>' +
          (row.jb.creditsExceed ? '<div class="exx-fs11px-cgold-mb10px">⚠ Credits exceed costs on this job; the total is negative until more costs are logged.</div>' : '') + vaTxt + '</div>' +
          '<div class="exx-taright-whinowrap"><div class="exx-fs14px-w700-ct">' + money(row.jb.cents) + '</div>' +
          '<div style="font-size:11px;font-weight:700;color:' + mColor + ';">' + budgetBadge + marginTxt + '</div></div></div>';
      });
      html += '<div class="exx-fs10px-cm-mt10px">Gross margin = Job Value − direct job costs (before overhead &amp; commission). "est" = budgeted cost from the job\'s estimate (V2 builder only).</div>';
      html += '</div>';
    }
    } // end expense-only analytics

    // A1b: Recurring templates + one-tap "Due" chips
    if (_recurring.length) {
      html += '<div class="ui-card exx-mb20px">' +
        '<h3 class="ui-card-head">🔁 Recurring</h3>';
      _recurring.slice().sort(function (a, b) { return (toDate(a.nextDueDate) || 0) - (toDate(b.nextDueDate) || 0); }).forEach(function (t) {
        var due = isDue(t);
        html += '<div class="ui-list-row">' +
          '<div class="exx-minw0"><div class="exx-fs13px-ct">' + esc(t.name || 'Recurring') + ' · ' + money(t.amountCents) + '</div>' +
          '<div class="ui-note">' + esc(t.frequency || 'monthly') + ' · ' + (t.status !== 'active' ? 'paused' : 'next ' + esc(fmtDate(t.nextDueDate))) + '</div></div>' +
          '<div class="exx-whinowrap">' +
            (due ? '<button type="button" class="btn btn-orange btn-sm" data-exp-action="add-recurring" data-rec-id="' + esc(t.id) + '">Due — Add</button> ' : '') +
            '<button data-exp-action="del-recurring" data-rec-id="' + esc(t.id) + '" title="Delete template" class="exx-bgnone-bdnone-cred">✕</button>' +
          '</div></div>';
      });
      html += '</div>';
    }

    // A5: Suppliers & 1099 tracking
    var taxYear = new Date().getFullYear();
    html += '<div class="ui-card exx-mb20px">' +
      '<div class="exx-dflex-jcspacebet-aicenter-2">' +
        '<h3 class="exx-m0-fs14px-ct">🧑‍🔧 Suppliers &amp; 1099 (' + taxYear + ')</h3>' +
        '<div class="exx-dflex-gap8px">' +
          (_suppliers.length ? '<button type="button" class="btn btn-ghost btn-sm" data-exp-action="export-1099" title="Year-end 1099 worklist CSV">⬇ 1099 CSV</button>' : '') +
          '<button type="button" class="btn btn-orange btn-sm" data-exp-action="open-supplier">+ Supplier</button>' +
        '</div></div>';
    if (!_suppliers.length) {
      html += '<div class="exx-fs12px-cm">No suppliers yet. Add subcontractors/vendors to track who needs a 1099-NEC at year-end (services ≥ ' + money(thresholdCents(taxYear)) + ' in ' + taxYear + ').</div>';
    } else {
      _suppliers.slice().sort(function (a, b) { return (a.displayName || '').localeCompare(b.displayName || ''); }).forEach(function (s) {
        var ytd = supplierYtdCents(s.displayName, taxYear, _expenses);
        var flag = needs1099(s, taxYear, _expenses);
        var tc = TAX_CLASS_BY_KEY[s.taxClassification];
        html += '<div class="ui-list-row">' +
          '<div class="exx-minw0"><div class="exx-fs13px-ct-whinowrap">' + esc(s.displayName) + '</div>' +
          '<div class="ui-note">' + esc(tc ? tc.label : s.taxClassification || '') + ' · W-9: ' + esc(s.w9Status || 'not_requested') + (s.is1099Eligible ? ' · 1099-eligible' : ' · exempt') + '</div></div>' +
          '<div class="exx-taright-whinowrap"><div class="exx-fs13px-w700-ct">' + money(ytd) + ' YTD</div>' +
          (flag ? '<div class="exx-fs11px-w700-corange">⚑ 1099 due</div>' : '') +
          '</div>' +
          '<button data-exp-action="del-supplier" data-sup-id="' + esc(s.id) + '" title="Delete" class="exx-bgnone-bdnone-cred">✕</button>' +
          '</div>';
      });
      html += '<div class="exx-fs10px-cm-mt10px">YTD = subcontractor/labor payments matched by name, this year. 1099 due = eligible class + W-9 on file + YTD ≥ ' + money(thresholdCents(taxYear)) + '. No tax IDs are stored.</div>';
    }
    html += '</div>';

    // Recent expense list (only when there are expenses)
    if (_expenses.length) {
    var noReceipt = _expenses.filter(function (e) { return !e.receiptStoragePath && e.category !== 'mileage'; }).length;
    html += '<div class="ui-card">' +
      '<h3 class="exx-m004px-fs14px-ct">Recent Expenses</h3>' +
      (noReceipt ? '<div class="exx-fs11px-cgold-mb10px">📎 ' + noReceipt + ' expense' + (noReceipt === 1 ? '' : 's') + ' without a receipt — attaching a photo or PDF is recommended (taxes, disputes, warranty claims).</div>' : '<div class="exx-mb8px"></div>');
    _expenses.slice(0, 60).forEach(function (e) {
      var lead = e.leadId ? leadById(e.leadId) : null;
      html += '<div class="ui-list-row">' +
        '<div class="exx-minw0-fx1">' +
        '<div class="exx-fs13px-ct-whinowrap">' + esc(e.supplier || 'Unknown') +
        ' <span class="ui-hint">· ' + esc(EC() ? EC().labelFor(e.category) : e.category) + '</span>' +
        (EC() && EC().entryTypeOf(e) !== 'cost' ? ' <span class="rh-chip">' + esc(EC().entryTypeOf(e) === 'credit' ? 'CREDIT' : 'ADJUSTMENT') + (e.creditRef ? ' ' + esc(e.creditRef) : '') + '</span>' : '') +
        (window.NBDReceiptHealth && window.NBDReceiptHealth.isUnsorted(e) ? ' <span class="rh-chip">UNSORTED</span>' : '') + '</div>' +
        '<div class="ui-note">' + esc(fmtDate(e.date)) + (lead ? ' · ' + esc(leadName(lead)) : '') + (e.reason ? ' · ' + esc(e.reason) : '') + (e.note ? ' · ' + esc(e.note) : '') + (e.source === 'ocr' ? ' · scanned' : e.source === 'import_homedepot' ? ' · Home Depot import' : '') + '</div></div>' +
        (e.needsReview ? '<span title="AI scan — review the amount/vendor" class="exx-cgold-fs13px">⚠</span>' : '') +
        (e.receiptStoragePath
          ? '<button data-exp-action="receipt" data-exp-path="' + esc(e.receiptStoragePath) + '" title="View receipt" class="exx-bgnone-bdnone-curpointer">📎</button>'
          // No receipt yet — recommended, never required (Jo, 2026-09-29).
          : '<button data-exp-action="attach" data-exp-id="' + esc(e.id) + '" title="Attach a receipt (photo or PDF)" class="exx-bgnone-bd1pxdashe-r6px">📎 Add receipt</button>') +
        // Total incl. sales tax — the same figure every card above sums
        // (a $1,234.56 + $87.65 tax row used to read $1,234.56 under a
        // $1,322.21 total). The tax is named on a second line.
        '<div class="exx-taright-whinowrap"><div class="exx-fs14px-w700-ct">' +
          money(sgnCents(e)) + '</div>' +
          ((parseInt(e.taxCents, 10) || 0) > 0 ? '<div class="ui-hint">incl. ' + money(e.taxCents) + ' tax</div>' : '') +
        '</div>' +
        '<button data-exp-action="delete" data-exp-id="' + esc(e.id) + '" title="Delete" class="exx-bgnone-bdnone-cred-2">✕</button>' +
        '</div>';
    });
    html += '</div>';
    } // end recent-expense list

    scroll.innerHTML = html;
  }

  // KPI tile on the canonical .stat-card spec (dashboard-app.css). Column
  // layout + top accent are per-tile layout, not chrome. The colored value
  // sets -webkit-text-fill-color too because the polished .stat-val paints
  // via a background-clip gradient (fill-color transparent) — inline color
  // alone would be invisible.
  function card(label, value, sub, color) {
    return '<div class="stat-card" style="flex-direction:column;align-items:flex-start;gap:2px;border-top:2px solid ' + color + ';">' +
      '<div class="stat-lbl exx-mt0-ttuppercas-ls05em">' + esc(label) + '</div>' +
      '<div class="stat-val" style="font-weight:800;color:' + color + ';-webkit-text-fill-color:' + color + ';margin:2px 0;">' + value + '</div>' +
      '<div class="ui-hint">' + esc(sub) + '</div></div>';
  }

  // ── entry form (modal) ──────────────────────────────────────────────
  // opts.leadId (2026-10-04): the Sunday review's "Costs needed" list opens
  // the form already on that job, category Materials — one tap to a cost.
  function openForm(opts) {
    var c = EC();
    if (document.getElementById('expFormOverlay')) return;
    var cats = (c ? c.CATEGORIES : []).map(function (x) {
      return '<option value="' + esc(x.key) + '">' + esc(x.label) + (x.costType === 'direct' ? ' (job cost)' : ' (overhead)') + '</option>';
    }).join('');
    var leadOpts = '<option value="">— No job (overhead) —</option>' + (window._leads || []).slice(0, 500).map(function (l) {
      return '<option value="' + esc(l.id) + '">' + esc(leadName(l)) + '</option>';
    }).join('');
    var today = ymdLocal(new Date());

    // Canonical modal pair (dashboard-app.css): .modal-bg backdrop at
    // var(--z-overlay) + .modal card; open/close is ONLY the .open class
    // (cert-round rule), driven through nbdModal below.
    var ov = document.createElement('div');
    ov.id = 'expFormOverlay';
    ov.className = 'modal-bg';
    ov.innerHTML =
      '<div class="modal exx-maxw440px">' +
        '<button type="button" class="modal-close" data-exp-action="close-form" title="Close">✕</button>' +
        '<h3 class="exx-m0016px-ct-fs18px">Log Expense</h3>' +
        (creditsFlagOn()
          ? '<div class="exx-mb12px"><label class="ui-label-caps" for="expEntryType">Entry type</label><select id="expEntryType" class="ui-input-lg">' +
              '<option value="cost">Cost (money spent)</option>' +
              '<option value="credit">Credit / refund / return (reduces cost)</option>' +
              '<option value="adjustment">Adjustment (extra cost the original missed)</option></select>' +
              '<div class="exx-fs11px-cm-mt4px">Enter the amount as a positive number. A credit is saved as its own dated entry; the original cost is never changed.</div></div>' +
            '<div id="expCreditRow" style="display:none;margin-bottom:12px;">' +
              '<label class="ui-label-caps" for="expCreditRef">Credit memo # / reference (optional)</label><input id="expCreditRef" type="text" maxlength="80" class="ui-input-lg">' +
              '<label class="ui-label-caps exx-mt12px" for="expRelated">Related cost (optional)</label><select id="expRelated" class="ui-input-lg"><option value="">— Not tied to one cost —</option>' +
                _expenses.filter(function (x) { return x && x.id && (!c || c.entryTypeOf(x) === 'cost'); }).slice(0, 100).map(function (x) {
                  return '<option value="' + esc(x.id) + '">' + esc((x.supplier || 'Unknown') + ' · ' + fmtDate(x.date) + ' · ' + money(sgnCents(x))) + '</option>';
                }).join('') + '</select>' +
              '<label class="ui-label-caps exx-mt12px" for="expReason">Reason (optional)</label><input id="expReason" type="text" maxlength="500" placeholder="e.g. returned 12 bundles, wrong color" class="ui-input-lg"></div>'
          : '') +
        '<div class="exx-dgrid-gtc1fr1fr-gap12px">' +
          '<div><label class="ui-label-caps">Amount ($)</label><input id="expAmount" type="number" step="0.01" min="0" inputmode="decimal" autofocus class="ui-input-lg"></div>' +
          '<div><label class="ui-label-caps">Date</label><input id="expDate" type="date" value="' + today + '" class="ui-input-lg"></div>' +
          '<div><label class="ui-label-caps">Sales Tax ($)</label><input id="expTax" type="number" step="0.01" min="0" inputmode="decimal" class="ui-input-lg"></div>' +
          '<div class="exp-cat-cell"><label class="ui-label-caps">Category</label><select id="expCategory" class="ui-input-lg">' + cats + '</select></div>' +
        '</div>' +
        '<div id="expMileageRow" style="display:none;margin-top:12px;"><label class="ui-label-caps">Miles</label>' +
          '<input id="expMiles" type="number" step="0.1" min="0" inputmode="decimal" class="ui-input-lg">' +
          '<div id="expMileageHint" class="exx-fs11px-cm-mt4px"></div></div>' +
        '<div id="expSourceRow" style="display:none;margin-top:12px;"><label class="ui-label-caps">Lead Source / Campaign</label>' +
          '<input id="expSource" type="text" maxlength="60" placeholder="e.g. Door-to-Door, Google, Storm" class="ui-input-lg"></div>' +
        '<div class="exx-mt12px"><label class="ui-label-caps">Supplier / Vendor</label><input id="expSupplier" type="text" maxlength="120" list="expSupplierList" placeholder="e.g. ABC Supply" class="ui-input-lg">' +
          '<datalist id="expSupplierList">' + _suppliers.map(function (s) { return '<option value="' + esc(s.displayName) + '">'; }).join('') + '</datalist></div>' +
        (costsFlagOn()
          ? '<div class="exx-mt12px"><label class="ui-label-caps" for="expPaidFrom">Paid from</label><select id="expPaidFrom" class="ui-input-lg"><option value="">— Select how it was paid —</option>' +
              ((c && c.PAID_FROM) || []).map(function (p) { return '<option value="' + esc(p.key) + '">' + esc(p.label) + '</option>'; }).join('') + '</select></div>' +
            '<div class="exx-mt12px"><label class="ui-label-caps" for="expReceiptUrl">Receipt link (optional)</label><input id="expReceiptUrl" type="url" maxlength="500" placeholder="https://drive.google.com/…" class="ui-input-lg"></div>'
          : '') +
        '<div class="exx-mt12px"><label class="ui-label-caps">Job (optional)</label><select id="expLead" class="ui-input-lg">' + leadOpts + '</select></div>' +
        '<div class="exx-mt12px"><label class="ui-label-caps">Note (optional)</label><input id="expNote" type="text" maxlength="500" class="ui-input-lg"></div>' +
        '<div class="exx-mt12px"><label class="ui-label-caps">Repeat (optional)</label><select id="expRepeat" class="ui-input-lg"><option value="none">One-time</option>' +
          FREQUENCIES.map(function (f) { return '<option value="' + f.key + '">' + f.label + '</option>'; }).join('') + '</select></div>' +
        '<div class="exx-mt12px"><label class="ui-label-caps">Receipt (image / PDF, optional)</label>' +
          '<div class="exx-dflex-gap8px-aicenter exp-receipt-row">' +
            '<input id="expFile" type="file" accept="image/*,application/pdf" class="ui-input-lg exx-fx1">' +
            '<button data-exp-action="scan" type="button" class="btn btn-ghost exx-whinowrap">📷 Scan with AI</button>' +
          '</div>' +
          '<div id="expScanStatus" class="exx-fs11px-cm-mt6px"></div>' +
        '</div>' +
        '<button type="button" class="btn btn-orange exx-wd100-mt18px-jccenter" data-exp-action="save">Save Expense</button>' +
      '</div>';
    document.body.appendChild(ov);
    // nbdModal owns backdrop-click + Esc; its onClose hook runs the teardown
    // no matter which path closed the modal. Fallback keeps the old behavior
    // if the helper is somehow absent — still class-toggled, never inline display.
    if (window.nbdModal) {
      window.nbdModal.open(ov, { onClose: teardownForm });
    } else {
      ov.classList.add('open');
      ov.addEventListener('click', function (ev) { if (ev.target === ov) closeForm(); });
    }

    // Mileage + marketing-source conditional fields, driven by the category.
    var catSel = document.getElementById('expCategory');
    var milesEl = document.getElementById('expMiles');
    function recomputeMileage() {
      var ecfg = EC(); if (!ecfg) return;
      var dEl = document.getElementById('expDate');
      var rate = ecfg.mileageRateCents(dEl && dEl.value ? new Date(dEl.value) : new Date());
      var miles = parseFloat(milesEl && milesEl.value);
      var amtEl = document.getElementById('expAmount');
      var hint = document.getElementById('expMileageHint');
      if (isFinite(miles) && miles > 0) {
        var cents = ecfg.mileageAmountCents(miles, rate);
        if (amtEl) amtEl.value = (cents / 100).toFixed(2);
        if (hint) hint.textContent = miles + ' mi × ' + rate + '¢/mi = ' + ecfg.formatCents(cents);
      } else if (hint) { hint.textContent = 'IRS rate ' + rate + '¢/mi'; }
    }
    function syncCategoryFields() {
      var cat = catSel ? catSel.value : '';
      var isMileage = cat === 'mileage';
      var mr = document.getElementById('expMileageRow'); if (mr) mr.style.display = isMileage ? '' : 'none';
      var sr = document.getElementById('expSourceRow'); if (sr) sr.style.display = (cat === 'marketing') ? '' : 'none';
      var amtEl = document.getElementById('expAmount');
      if (amtEl) { amtEl.readOnly = isMileage; amtEl.style.opacity = isMileage ? '.6' : '1'; } // mileage amount is computed
      if (isMileage) recomputeMileage();
    }
    function syncEntryType() {
      var et = document.getElementById('expEntryType');
      var cr = document.getElementById('expCreditRow');
      if (cr) cr.style.display = (et && et.value !== 'cost') ? '' : 'none';
      // Mileage is computed from miles; it cannot be a credit.
      if (et && catSel && catSel.value === 'mileage' && et.value !== 'cost') et.value = 'cost';
    }
    var etSel = document.getElementById('expEntryType');
    if (etSel) etSel.addEventListener('change', syncEntryType);
    if (opts && opts.leadId) {
      var leadSel = document.getElementById('expLead');
      if (leadSel) leadSel.value = String(opts.leadId);
      if (catSel && opts.category) catSel.value = String(opts.category);
    }
    if (catSel) catSel.addEventListener('change', function () { syncCategoryFields(); syncEntryType(); });
    if (milesEl) milesEl.addEventListener('input', recomputeMileage);
    var dateEl = document.getElementById('expDate');
    if (dateEl) dateEl.addEventListener('change', function () { if (catSel && catSel.value === 'mileage') recomputeMileage(); });
    // Re-selecting a receipt MUST force a fresh upload + OCR of the new file —
    // scanReceipt only uploads when _scannedPath is falsy, so without this reset a
    // 2nd file pick re-scans the FIRST receipt (wrong image + wrong $ on save).
    var fileEl = document.getElementById('expFile');
    if (fileEl) fileEl.addEventListener('change', function () {
      _scannedPath = null;
      _scanExtraction = null;
      if (typeof setScanStatus === 'function') setScanStatus('');
    });
    syncCategoryFields();

    var amt = document.getElementById('expAmount');
    if (amt) amt.focus();
  }
  // Idempotent teardown — reached via nbdModal's onClose (backdrop/Esc/close
  // button) or directly when the helper is absent.
  function teardownForm() {
    var ov = document.getElementById('expFormOverlay');
    if (ov) ov.remove();
    _scannedPath = null;
    _scanExtraction = null;
  }
  function closeForm() {
    var ov = document.getElementById('expFormOverlay');
    if (ov && window.nbdModal) window.nbdModal.close(ov); // -> onClose -> teardownForm
    teardownForm();
  }
  async function saveFromForm(btn) {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var fileEl = document.getElementById('expFile');
    var c = EC();
    // Duplicate guard: same supplier + amount + day already logged → confirm.
    // Batch 2 (iOS PWA): native confirm() always returns true in standalone
    // mode (standalone-compat.js), so the guard would auto-save the duplicate —
    // a phantom ledger row that skews margin and the 1099 rollup. nbdConfirm
    // gives a real Promise<boolean> modal there, native confirm on desktop.
    // Same reason for every other confirm in this file.
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    var dupCents = c ? c.dollarsToCents(v('expAmount')) : 0;
    var formEntryType = v('expEntryType') || 'cost';
    var dup = findDuplicate(v('expSupplier'), dupCents, v('expDate'), formEntryType);
    if (dup && !(await ask('Looks like a possible duplicate — ' + (v('expSupplier') || 'this vendor') + ' for ' + money(dupCents) + ' on ' + v('expDate') + ' is already logged. Save it anyway?'))) {
      return;
    }
    // If the receipt was scanned, the doc carries the OCR provenance + the
    // already-uploaded path (no double upload), and the user's edits to the
    // pre-filled fields win.
    var scanned = _scanExtraction && _scannedPath;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var ok = await createExpense({
      amount: v('expAmount'),
      tax: v('expTax'),
      date: v('expDate'),
      supplier: v('expSupplier'),
      category: v('expCategory'),
      leadId: v('expLead'),
      note: v('expNote'),
      paidFrom: v('expPaidFrom'),
      receiptUrl: v('expReceiptUrl'),
      entryType: formEntryType,
      relatedExpenseId: v('expRelated'),
      creditRef: v('expCreditRef'),
      reason: v('expReason'),
      miles: v('expMiles'),
      marketingSource: v('expSource'),
      file: fileEl && fileEl.files && fileEl.files[0],
      uploadedPath: _scannedPath || null,
      source: scanned ? 'ocr' : 'manual',
      ocrConfidence: scanned && _scanExtraction.extracted ? _scanExtraction.extracted.confidence : null,
      needsReview: scanned ? !!_scanExtraction.needsReview : false
    });
    if (ok) {
      // If marked recurring, also create a template (A1b). Mileage can't recur.
      var repeat = v('expRepeat');
      // A credit never repeats on a schedule.
      if (repeat && repeat !== 'none' && v('expCategory') !== 'mileage' && formEntryType === 'cost') {
        await createRecurringTemplate({ amount: v('expAmount'), date: v('expDate'), supplier: v('expSupplier'), category: v('expCategory') }, repeat);
      }
      closeForm(); await refresh();
      // The Sunday review's "Costs needed" list re-reads on this.
      try { window.dispatchEvent(new CustomEvent('nbd:expenses-changed')); } catch (_) { /* old browser */ }
    } else if (btn) { btn.disabled = false; btn.textContent = 'Save Expense'; }
  }

  // ── lifecycle ───────────────────────────────────────────────────────
  async function refresh() {
    var results = await Promise.all([fetchExpenses(), fetchEstimateCosts(), fetchRecurring(), fetchSuppliers()]);
    _expenses = results[0];
    _loaded = true;
    render();
  }
  function init() {
    var scroll = document.querySelector('#view-expenses .view-scroll');
    if (scroll && !_loaded) scroll.innerHTML = '<div class="exx-p40px-tacenter-cm">Loading expenses…</div>';
    refresh();
  }

  // ── CSV export (accountant-ready; do this BEFORE any QuickBooks/Xero API) ──
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // Neutralize spreadsheet formula injection: a leading =,+,-,@,tab,CR makes
    // Excel/Sheets EXECUTE the cell. OCR-extracted vendor text is attacker-
    // influenceable (a crafted receipt image) and this CSV is opened by the
    // accountant — prefix a single quote so the cell is treated as text.
    // A plain negative number (a signed credit, "-1017.84") is not a formula: keep it numeric.
    if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function paidFromLabel(k) {
    var c = EC(), key = c && c.paidFromKey ? c.paidFromKey(k) : '';
    if (!key) return '';
    for (var i = 0; i < c.PAID_FROM.length; i++) if (c.PAID_FROM[i].key === key) return c.PAID_FROM[i].label;
    return '';
  }
  function exportCSV() {
    var c = EC();
    if (!_expenses.length) { toast('No expenses to export', 'warn'); return; }
    var paidCols = costsFlagOn();
    var cols = ['Date', 'Supplier', 'Category', 'Cost Type', 'Amount', 'Sales Tax', 'Job', 'Note', 'Source', 'Estimated', 'Schedule C (suggested)'];
    if (paidCols) cols.push('Paid From', 'Receipt Link');
    // Flag costCredits: Entry Type + Related (+ Credit Ref, Reason) columns. Amount and Sales Tax
    // are SIGNED in the file (a credit exports negative) so a plain SUM in a spreadsheet is right.
    var credCols = creditsFlagOn();
    if (credCols) cols.push('Entry Type', 'Related', 'Credit Ref', 'Reason');
    var rows = _expenses.map(function (e) {
      var d = toDate(e.date);
      var lead = e.leadId ? leadById(e.leadId) : null;
      var hint = (c && c.byKey[e.category] && c.byKey[e.category].scheduleCHint) || '';
      return [
        d ? ymdLocal(d) : '',
        e.supplier || '',
        (c ? c.labelFor(e.category) : e.category) || '',
        e.costType || '',
        (sgnCents(e, false) / 100).toFixed(2),
        ((c && c.signOf ? c.signOf(e) : 1) * (parseInt(e.taxCents, 10) || 0) / 100).toFixed(2),
        lead ? leadName(lead) : '',
        e.note || '',
        e.source || 'manual',
        e.estimated === true ? 'Yes' : '',
        hint
      ].concat(paidCols ? [paidFromLabel(e.paidFrom), e.receiptUrl || ''] : [])
        .concat(credCols ? [c && c.ENTRY_TYPE_LABELS ? c.ENTRY_TYPE_LABELS[c.entryTypeOf(e)] : 'Cost', e.relatedExpenseId || '', e.creditRef || '', e.reason || ''] : [])
        .map(csvCell).join(',');
    });
    if (downloadCSV('nbd-expenses-' + new Date().toISOString().slice(0, 10) + '.csv', cols.join(',') + '\n' + rows.join('\n'))) {
      toast('Exported ' + _expenses.length + (_expenses.length === 1 ? ' expense' : ' expenses'), 'ok');
    } else { toast('Export failed', 'error'); }
  }
  function downloadCSV(filename, csv) {
    try {
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
      return true;
    } catch (e) { console.warn('[expenses] csv download failed', e); return false; }
  }

  // A5: year-end 1099 worklist CSV (eligible suppliers over the year's threshold).
  function export1099() {
    var year = new Date().getFullYear();
    var elig = _suppliers.filter(function (s) { return needs1099(s, year, _expenses); });
    if (!elig.length) { toast('No suppliers meet the ' + year + ' 1099 threshold yet', 'warn'); return; }
    var cols = ['Supplier', 'Legal Name', 'Tax Classification', 'W-9 Status', 'YTD Service Payments', 'Tax Year'];
    var rows = elig.map(function (s) {
      var tc = TAX_CLASS_BY_KEY[s.taxClassification];
      return [s.displayName || '', s.legalName || '', tc ? tc.label : (s.taxClassification || ''), s.w9Status || '',
        (supplierYtdCents(s.displayName, year, _expenses) / 100).toFixed(2), String(year)].map(csvCell).join(',');
    });
    if (downloadCSV('nbd-1099-worklist-' + year + '.csv', cols.join(',') + '\n' + rows.join('\n'))) {
      toast('Exported ' + elig.length + ' supplier(s) for 1099', 'ok');
    } else { toast('Export failed', 'error'); }
  }

  // A5: add-supplier modal (NO tax-ID field — tracking only).
  function openSupplierForm() {
    if (document.getElementById('supFormOverlay')) return;
    var classOpts = TAX_CLASSES.map(function (t) { return '<option value="' + t.key + '">' + esc(t.label) + (t.eligible ? '' : ' — exempt') + '</option>'; }).join('');
    var w9Opts = [['not_requested', 'Not requested'], ['requested', 'Requested'], ['received', 'Received'], ['verified', 'Verified']]
      .map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('');
    // Canonical modal pair — same contract as openForm above.
    var ov = document.createElement('div');
    ov.id = 'supFormOverlay';
    ov.className = 'modal-bg';
    ov.innerHTML =
      '<div class="modal exx-maxw440px">' +
        '<button type="button" class="modal-close" data-exp-action="close-supplier" title="Close">✕</button>' +
        '<h3 class="exx-m0016px-ct-fs18px">Add Supplier</h3>' +
        '<div class="exx-mb12px"><label class="ui-label-caps">Supplier / Vendor name</label><input id="supName" type="text" maxlength="120" placeholder="e.g. Crew Co" autofocus class="ui-input-lg"></div>' +
        '<div class="exx-mb12px"><label class="ui-label-caps">Legal name (for the 1099)</label><input id="supLegal" type="text" maxlength="120" class="ui-input-lg"></div>' +
        '<div class="exx-dgrid-gtc1fr1fr-gap12px">' +
          '<div><label class="ui-label-caps">Tax classification (from W-9)</label><select id="supClass" class="ui-input-lg">' + classOpts + '</select></div>' +
          '<div><label class="ui-label-caps">W-9 status</label><select id="supW9" class="ui-input-lg">' + w9Opts + '</select></div>' +
        '</div>' +
        '<div class="exx-dgrid-gtc1fr1fr-gap12px-2">' +
          '<div><label class="ui-label-caps">Phone</label><input id="supPhone" type="tel" maxlength="40" class="ui-input-lg"></div>' +
          '<div><label class="ui-label-caps">Email</label><input id="supEmail" type="email" maxlength="120" class="ui-input-lg"></div>' +
        '</div>' +
        '<div class="exx-fs11px-cm-mt10px">1099-eligibility is derived from the tax classification. No SSN/EIN is stored — keep tax IDs in your tax software.</div>' +
        '<button type="button" class="btn btn-orange exx-wd100-mt16px-jccenter" data-exp-action="save-supplier">Save Supplier</button>' +
      '</div>';
    document.body.appendChild(ov);
    if (window.nbdModal) {
      window.nbdModal.open(ov, { onClose: teardownSupplierForm });
    } else {
      ov.classList.add('open');
      ov.addEventListener('click', function (ev) { if (ev.target === ov) closeSupplierForm(); });
    }
    var n = document.getElementById('supName'); if (n) n.focus();
  }
  function teardownSupplierForm() { var ov = document.getElementById('supFormOverlay'); if (ov) ov.remove(); }
  function closeSupplierForm() {
    var ov = document.getElementById('supFormOverlay');
    if (ov && window.nbdModal) window.nbdModal.close(ov); // -> onClose -> teardownSupplierForm
    teardownSupplierForm();
  }
  async function saveSupplierFromForm(btn) {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var ok = await createSupplier({
      displayName: v('supName'), legalName: v('supLegal'), taxClassification: v('supClass'),
      w9Status: v('supW9'), phone: v('supPhone'), email: v('supEmail')
    });
    if (ok) { closeSupplierForm(); await refresh(); }
    else if (btn) { btn.disabled = false; btn.textContent = 'Save Supplier'; }
  }
  async function deleteSupplier(id) {
    if (!id || !window.deleteDoc) return;
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
    if (!(await ask('Delete this supplier?'))) return;
    try { await window.deleteDoc(window.doc(window.db, 'suppliers', id)); await refresh(); }
    catch (e) { toast('Could not delete (only the owner can)', 'error'); }
  }

  // ── Bulk cost CSV import (flag costsPaidFrom) ───────────────────────
  // Upload a CSV, parse it here in the browser, match every row to a job, run it
  // through findDuplicate, then show a preview where EACH ROW is approved or
  // rejected on its own (no "approve all"): Jo confirms every money change. Only
  // approved rows are written, through createExpense (same path as the form, with
  // source 'import'). Nothing is ever written silently. Columns:
  // job, vendor, date, amount, category, paidFrom, receiptUrl, note.
  var IMPORT_MAX_ROWS = 500;
  var IMPORT_MAX_BYTES = 1024 * 1024;

  // RFC-4180-ish: quoted cells, doubled quotes, CRLF/LF, a leading BOM.
  function parseCsv(text) {
    var s = String(text == null ? '' : text).replace(/^﻿/, '');
    var rows = [], row = [], cell = '', q = false, i = 0, ch;
    for (; i < s.length; i++) {
      ch = s.charAt(i);
      if (q) {
        if (ch === '"') { if (s.charAt(i + 1) === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"' && cell === '') { q = true; }
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s.charAt(i + 1) === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (x) { return String(x).trim() !== ''; }); });
  }

  var IMPORT_HEADER_ALIASES = {
    job: 'job', customer: 'job', customername: 'job', jobname: 'job', leadid: 'job', jobid: 'job',
    vendor: 'vendor', supplier: 'vendor',
    date: 'date', amount: 'amount', total: 'amount',
    category: 'category',
    paidfrom: 'paidFrom', paidwith: 'paidFrom', paymentsource: 'paidFrom',
    receipturl: 'receiptUrl', receiptlink: 'receiptUrl', receipt: 'receiptUrl',
    note: 'note', notes: 'note',
    // Flag costCredits. A credit memo is its own dated row; the amount column stays POSITIVE.
    entrytype: 'entryType', type: 'entryType',
    relatedexpenseid: 'relatedExpenseId', relatedid: 'relatedExpenseId', related: 'relatedExpenseId',
    creditref: 'creditRef', creditmemo: 'creditRef', creditmemonumber: 'creditRef', memonumber: 'creditRef',
    reason: 'reason'
  };
  var IMPORT_REQUIRED = ['job', 'date', 'amount', 'category', 'paidFrom'];

  function normName(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // 'YYYY-MM-DD' or 'M/D/YYYY' -> 'YYYY-MM-DD' for a REAL calendar day, else ''.
  function parseImportDate(v) {
    var s = String(v == null ? '' : v).trim(), y, m, d, mt;
    if ((mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
    else if ((mt = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) { m = +mt[1]; d = +mt[2]; y = +mt[3]; }
    else return '';
    var dt = new Date(y, m - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d || y < 2000 || y > 2100) return '';
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }
  // '$1,234.50' -> 123450; anything that is not a plain positive money amount -> 0.
  function parseImportAmountCents(v) {
    var s = String(v == null ? '' : v).trim().replace(/^\$/, '').replace(/,/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return 0;
    var cents = Math.round(parseFloat(s) * 100);
    return cents > 0 && cents < 1000000000 ? cents : 0;
  }
  function importCategoryKey(v) {
    var c = EC(), n = normName(v);
    if (!c || !n) return '';
    for (var i = 0; i < c.CATEGORIES.length; i++) {
      if (normName(c.CATEGORIES[i].key) === n || normName(c.CATEGORIES[i].label) === n) return c.CATEGORIES[i].key;
    }
    return '';
  }
  function matchImportJob(cell, leads) {
    var raw = String(cell == null ? '' : cell).trim();
    if (!raw) return { error: 'Job is empty' };
    var live = (leads || []).filter(function (l) { return l && !l.deleted; });
    var byId = live.filter(function (l) { return l.id === raw; });
    if (byId.length === 1) return { lead: byId[0] };
    var n = normName(raw);
    var byName = live.filter(function (l) { return normName(leadName(l)) === n || (l.name && normName(l.name) === n); });
    if (byName.length === 1) return { lead: byName[0] };
    if (byName.length > 1) return { error: 'Job "' + raw + '" matches ' + byName.length + ' customers; use the lead id' };
    return { error: 'Unknown job "' + raw + '"' };
  }

  // Pure: CSV text -> { error } | { rows }. Each row: { line, raw, status: 'ok' | 'duplicate' | 'rejected',
  // reasons[], jobLabel, draft } where draft is the createExpense() form for rows that can be approved.
  // `leads` = job list; findDup(vendor, cents, ymd) = duplicate lookup against the loaded ledger.
  // `relatedExists(id)` (optional) = is this id a row in the loaded ledger?
  function buildImportPreview(text, leads, findDup, relatedExists) {
    var c = EC();
    if (!c) return { error: 'Expense config not loaded' };
    var table = parseCsv(text);
    if (table.length < 2) return { error: 'No data rows found. The first row must be the column names.' };
    var idx = {};
    table[0].forEach(function (h, i) {
      var k = IMPORT_HEADER_ALIASES[String(h).toLowerCase().replace(/[^a-z]/g, '')];
      if (k && idx[k] == null) idx[k] = i;
    });
    var missing = IMPORT_REQUIRED.filter(function (k) { return idx[k] == null; });
    if (missing.length) return { error: 'Missing column(s): ' + missing.join(', ') + '. Expected: job, vendor, date, amount, category, paidFrom, receiptUrl, note.' };
    if (table.length - 1 > IMPORT_MAX_ROWS) return { error: 'Too many rows (' + (table.length - 1) + '). Import up to ' + IMPORT_MAX_ROWS + ' at a time.' };
    var get = function (r, k) { return idx[k] == null ? '' : String(r[idx[k]] == null ? '' : r[idx[k]]).trim(); };
    var seen = [];
    var rows = table.slice(1).map(function (r, n) {
      var out = { line: n + 2, raw: { job: get(r, 'job'), vendor: get(r, 'vendor'), date: get(r, 'date'), amount: get(r, 'amount'), category: get(r, 'category'), paidFrom: get(r, 'paidFrom'), receiptUrl: get(r, 'receiptUrl'), note: get(r, 'note'),
          entryType: get(r, 'entryType'), relatedExpenseId: get(r, 'relatedExpenseId'), creditRef: get(r, 'creditRef'), reason: get(r, 'reason') },
        status: 'ok', reasons: [], jobLabel: '', draft: null, entryType: 'cost' };
      var bad = function (m) { out.reasons.push(m); };
      var job = matchImportJob(out.raw.job, leads);
      if (job.error) bad(job.error); else out.jobLabel = leadName(job.lead);
      var ymd = parseImportDate(out.raw.date);
      if (!ymd) bad('Bad date "' + out.raw.date + '" (use YYYY-MM-DD or M/D/YYYY)');
      // entryType: blank = cost. A credit / adjustment is only accepted when the costCredits flag is
      // on; it is NEVER guessed, because reading a credit as a cost would double the error.
      var etype = out.raw.entryType ? c.entryTypeKey(out.raw.entryType) : 'cost';
      if (!etype) bad('Bad entryType "' + out.raw.entryType + '" (one of: cost, credit, adjustment)');
      else if (etype !== 'cost' && !creditsFlagOn()) { bad('Credits and adjustments are not turned on yet'); etype = ''; }
      out.entryType = etype || 'cost';
      // Amounts stay positive. A negative number is rejected on purpose; the entryType column says direction.
      var cents = parseImportAmountCents(out.raw.amount);
      if (!cents) {
        bad('Bad amount "' + out.raw.amount + '" (a positive number like 125.50)' +
          (/^\s*[-(]/.test(out.raw.amount) ? '. For a credit or refund, enter the amount as a positive number and set entryType to credit' : ''));
      }
      var cat = importCategoryKey(out.raw.category);
      if (!cat) bad('Unknown category "' + out.raw.category + '"');
      else if (cat === 'mileage') bad('Mileage is computed from miles; log it with the form');
      // A credit / adjustment is not a payment, so paidFrom may be blank for it (but must be valid when given).
      var paid = c.paidFromKey(out.raw.paidFrom);
      if (!paid && !(out.entryType !== 'cost' && !out.raw.paidFrom)) bad('Bad paidFrom "' + out.raw.paidFrom + '" (one of: ' + c.PAID_FROM.map(function (p) { return p.key; }).join(', ') + ')');
      if (out.raw.creditRef.length > c.CREDIT_REF_MAX) bad('Credit memo number is over ' + c.CREDIT_REF_MAX + ' characters');
      if (out.raw.reason.length > c.REASON_MAX) bad('Reason is over ' + c.REASON_MAX + ' characters');
      if (out.raw.relatedExpenseId) {
        if (out.entryType === 'cost') bad('relatedExpenseId only applies to a credit or adjustment');
        else if (typeof relatedExists === 'function' && !relatedExists(out.raw.relatedExpenseId)) bad('relatedExpenseId "' + out.raw.relatedExpenseId.slice(0, 40) + '" was not found in your ledger');
      }
      if (out.raw.receiptUrl && !c.receiptUrlOk(out.raw.receiptUrl)) bad('Receipt link must be an https:// URL, max ' + c.RECEIPT_URL_MAX + ' characters');
      if (out.raw.vendor.length > 120) bad('Vendor is over 120 characters');
      if (out.raw.note.length > 500) bad('Note is over 500 characters');
      if (out.reasons.length) { out.status = 'rejected'; return out; }
      out.draft = { leadId: job.lead.id, supplier: out.raw.vendor, date: ymd, amount: (cents / 100).toFixed(2), category: cat,
        paidFrom: paid, receiptUrl: out.raw.receiptUrl, note: out.raw.note, source: 'import',
        entryType: out.entryType, relatedExpenseId: out.raw.relatedExpenseId, creditRef: out.raw.creditRef, reason: out.raw.reason };
      out.cents = cents;
      var dup = typeof findDup === 'function' ? findDup(out.raw.vendor, cents, ymd, out.entryType) : null;
      if (dup) { out.status = 'duplicate'; bad('Looks like a duplicate of an entry already logged (same type, vendor, amount and day)'); }
      var key = out.entryType + '|' + c.normVendor(out.raw.vendor) + '|' + cents + '|' + ymd;
      var earlier = seen.filter(function (s) { return s.key === key; })[0];
      if (earlier) { out.status = 'duplicate'; bad('Same vendor, amount and day as row ' + earlier.line + ' in this file'); }
      seen.push({ key: key, line: out.line });
      return out;
    });
    return { rows: rows };
  }

  var _imp = null; // { fileName, rows, decision: {rowIndex: 'approved'|'rejected'}, results: {rowIndex: 'saved'|'failed'}, writing, done }

  function importApprovedCount() { return _imp ? Object.keys(_imp.decision).filter(function (k) { return _imp.decision[k] === 'approved' && !_imp.results[k]; }).length : 0; }

  function importBodyHtml() {
    var c = EC();
    if (!_imp || !_imp.rows) {
      return '<div class="ui-note exx-mt12px">Columns: <b>job, vendor, date, amount, category, paidFrom, receiptUrl, note</b>. ' +
        'Job is a customer name or lead id. Date is YYYY-MM-DD or M/D/YYYY. Category and paidFrom use the names in the Log Expense form. ' +
        (creditsFlagOn() ? 'Optional columns: <b>entryType</b> (cost, credit or adjustment; blank = cost), <b>creditRef</b> (credit memo number), <b>reason</b>, <b>relatedExpenseId</b>. ' +
          'Amounts are always positive: a credit memo of $1,017.84 is amount 1017.84 with entryType credit. paidFrom can be blank on a credit. ' : '') +
        'Every row is shown below and nothing is saved until you approve that row.</div>' +
        '<div class="exx-mt12px"><input id="expImpFile" type="file" accept=".csv,text/csv" class="ui-input-lg"></div>' +
        '<div id="expImpError" class="exx-fs11px-cm-mt6px"></div>';
    }
    var okCount = _imp.rows.filter(function (r) { return r.status !== 'rejected'; }).length;
    var html = '<div class="ui-note exx-mt12px">' + esc(_imp.fileName) + ': ' + _imp.rows.length + ' rows, ' + okCount + ' can be approved, ' + (_imp.rows.length - okCount) + ' rejected by checks. Approve or reject each row.</div>';
    html += '<div class="exx-imp-scroll"><table class="exx-imp-table"><thead><tr>' +
      ['Row', 'Job', 'Type', 'Vendor', 'Date', 'Amount', 'Category', 'Paid from', 'Receipt', 'Check', 'Decision'].map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr></thead><tbody>';
    _imp.rows.forEach(function (r, i) {
      var d = _imp.decision[i], res = _imp.results[i];
      var chk = r.status === 'ok' ? 'OK' : esc(r.reasons.join('; '));
      var cell;
      if (res) cell = res === 'saved' ? '<b>Saved</b>' : '<b>Failed to save</b>';
      else if (r.status === 'rejected') cell = '<span>Rejected</span>';
      else if (_imp.writing) cell = esc(d || 'pending');
      else cell = '<button type="button" class="btn btn-sm ' + (d === 'approved' ? 'btn-orange' : 'btn-ghost') + '" data-exp-action="imp-approve" data-imp-idx="' + i + '">' + (d === 'approved' ? 'Approved' : 'Approve') + '</button> ' +
        '<button type="button" class="btn btn-sm ' + (d === 'rejected' ? 'btn-orange' : 'btn-ghost') + '" data-exp-action="imp-reject" data-imp-idx="' + i + '">' + (d === 'rejected' ? 'Rejected' : 'Reject') + '</button>';
      html += '<tr>' +
        '<td>' + r.line + '</td>' +
        '<td>' + esc(r.jobLabel || r.raw.job) + '</td>' +
        '<td>' + (r.entryType === 'credit' ? '<b>Credit</b>' : r.entryType === 'adjustment' ? '<b>Adjustment</b>' : 'Cost') + (r.raw.creditRef ? ' ' + esc(r.raw.creditRef) : '') + '</td>' +
        '<td>' + esc(r.raw.vendor) + '</td>' +
        '<td>' + esc(r.draft ? r.draft.date : r.raw.date) + '</td>' +
        '<td>' + (r.cents ? (r.entryType === 'credit' ? '&minus;' : '') + money(r.cents) : esc(r.raw.amount)) + '</td>' +
        '<td>' + esc(r.draft && c ? c.labelFor(r.draft.category) : r.raw.category) + '</td>' +
        '<td>' + esc(r.draft ? paidFromLabel(r.draft.paidFrom) : r.raw.paidFrom) + '</td>' +
        '<td>' + (r.raw.receiptUrl ? 'link' : '') + '</td>' +
        '<td>' + chk + '</td>' +
        '<td class="exx-imp-nowrap">' + cell + '</td></tr>';
    });
    html += '</tbody></table></div>';
    var n = importApprovedCount();
    html += '<button type="button" class="btn btn-orange exx-wd100-mt18px-jccenter" data-exp-action="imp-write"' + (n && !_imp.writing && !_imp.done ? '' : ' disabled') + '>' +
      (_imp.done ? 'Done' : _imp.writing ? 'Saving…' : 'Save ' + n + ' approved ' + (n === 1 ? 'cost' : 'costs')) + '</button>';
    return html;
  }
  function renderImport() {
    var body = document.getElementById('expImpBody');
    if (body) body.innerHTML = importBodyHtml();
    wireImportFile();
  }
  function wireImportFile() {
    var f = document.getElementById('expImpFile');
    if (f && !f._nbdWired) { f._nbdWired = true; f.addEventListener('change', onImportFile); }
  }
  function onImportFile() {
    var f = document.getElementById('expImpFile');
    var file = f && f.files && f.files[0];
    var errEl = document.getElementById('expImpError');
    var fail = function (m) { if (errEl) errEl.textContent = m; };
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) { fail('File is over 1 MB.'); return; }
    var reader = new FileReader();
    reader.onerror = function () { fail('Could not read that file.'); };
    reader.onload = function () {
      var prev = buildImportPreview(String(reader.result || ''), window._leads || [], findDuplicate,
        function (id) { return _expenses.some(function (x) { return x && x.id === id; }); });
      if (prev.error) { fail(prev.error); return; }
      _imp = { fileName: file.name, rows: prev.rows, decision: {}, results: {}, writing: false, done: false };
      renderImport();
    };
    reader.readAsText(file);
  }
  function openImport() {
    if (!costsFlagOn()) return;
    if (document.getElementById('expImportOverlay')) return;
    _imp = null;
    var ov = document.createElement('div');
    ov.id = 'expImportOverlay';
    ov.className = 'modal-bg';
    ov.innerHTML = '<div class="modal exx-imp-modal">' +
      '<button type="button" class="modal-close" data-exp-action="imp-close" title="Close">✕</button>' +
      '<h3 class="exx-m0-ffbarlowco-fs26px">Import costs from CSV</h3><div id="expImpBody"></div></div>';
    document.body.appendChild(ov);
    if (window.nbdModal) window.nbdModal.open(ov, { onClose: teardownImport });
    else ov.classList.add('open');
    renderImport();
  }
  function teardownImport() {
    var ov = document.getElementById('expImportOverlay');
    if (ov) ov.remove();
    _imp = null;
  }
  function closeImport() {
    var ov = document.getElementById('expImportOverlay');
    if (ov && window.nbdModal) window.nbdModal.close(ov);
    teardownImport();
  }
  function decideImport(i, what) {
    if (!_imp || _imp.writing || _imp.done || _imp.results[i]) return;
    var r = _imp.rows[i];
    if (!r || r.status === 'rejected') return; // failed checks can never be approved
    if (_imp.decision[i] === what) delete _imp.decision[i]; else _imp.decision[i] = what;
    renderImport();
  }
  // Writes ONLY the rows Jo approved, one at a time, through createExpense.
  async function writeImport() {
    if (!_imp || _imp.writing || _imp.done || !costsFlagOn()) return;
    var todo = Object.keys(_imp.decision).filter(function (k) { return _imp.decision[k] === 'approved' && !_imp.results[k]; }).map(Number).sort(function (a, b) { return a - b; });
    if (!todo.length) return;
    _imp.writing = true; renderImport();
    var saved = 0, failed = 0;
    for (var j = 0; j < todo.length; j++) {
      var i = todo[j];
      var form = Object.assign({}, _imp.rows[i].draft, { source: 'import', quiet: true });
      var ok = false;
      try { ok = await createExpense(form); } catch (e) { ok = false; }
      _imp.results[i] = ok ? 'saved' : 'failed';
      if (ok) saved++; else failed++;
    }
    _imp.writing = false; _imp.done = true;
    renderImport();
    toast('Imported ' + saved + (saved === 1 ? ' cost' : ' costs') + (failed ? ', ' + failed + ' failed' : ''), failed ? 'warn' : 'ok');
    await refresh();
    try { window.dispatchEvent(new CustomEvent('nbd:expenses-changed')); } catch (_) { /* old browser */ }
  }

  // ── CSP-safe delegated events ───────────────────────────────────────
  if (!window._NBD_EXP_DELEGATE) {
    window._NBD_EXP_DELEGATE = true;
    document.addEventListener('click', async function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-exp-action]');
      if (!t) return;
      var a = t.dataset.expAction;
      var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };
      if (a === 'open-form') openForm();
      else if (a === 'close-form') closeForm();
      else if (a === 'export-csv') exportCSV();
      else if (a === 'open-import') openImport();
      else if (a === 'imp-close') closeImport();
      else if (a === 'imp-approve') decideImport(parseInt(t.dataset.impIdx, 10), 'approved');
      else if (a === 'imp-reject') decideImport(parseInt(t.dataset.impIdx, 10), 'rejected');
      else if (a === 'imp-write') writeImport();
      else if (a === 'scan') scanReceipt(t);
      else if (a === 'save') saveFromForm(t);
      else if (a === 'receipt') openReceipt(t.dataset.expPath);
      else if (a === 'attach') attachReceipt(t.dataset.expId);
      else if (a === 'add-recurring') addFromTemplate(t.dataset.recId);
      else if (a === 'del-recurring') { if (await ask('Delete this recurring template?')) deleteTemplate(t.dataset.recId); }
      else if (a === 'open-supplier') openSupplierForm();
      else if (a === 'close-supplier') closeSupplierForm();
      else if (a === 'save-supplier') saveSupplierFromForm(t);
      else if (a === 'del-supplier') deleteSupplier(t.dataset.supId);
      else if (a === 'export-1099') export1099();
      else if (a === 'delete') {
        var id = t.dataset.expId;
        if (id && await ask('Delete this expense? This cannot be undone.')) {
          removeExpense(id).then(function (done) { if (done) refresh(); });
        }
      }
    });
  }

  window.Expenses = {
    init: init,
    openForm: openForm,
    render: render,
    refresh: refresh,
    // data-layer (used by Phase 2 OCR + future surfaces)
    createExpense: createExpense,
    removeExpense: removeExpense,
    exportCSV: exportCSV,
    // Loaded expenses (hd-import.js skips receipts already imported).
    list: function () { return _expenses.slice(); },
    meta: function () { return { capped: _expMeta.capped, count: _expMeta.count, cap: _expMeta.cap, oldestMs: _expMeta.oldestMs }; },
    saveAttachedReceipt: saveAttachedReceipt,
    // pure functions (exported for unit tests)
    aggregate: aggregate,
    jobMargin: jobMargin,
    leadSpendSummary: leadSpendSummary,
    estVsActual: estVsActual,
    findDuplicate: findDuplicate,
    parseCsv: parseCsv,
    buildImportPreview: buildImportPreview,
    csvCell: csvCell,
    advanceDate: advanceDate,
    supplierYtdCents: supplierYtdCents,
    needs1099: needs1099,
    is1099EligibleFromClass: is1099EligibleFromClass,
    _setData: function (list) { _expenses = list || []; _loaded = true; }, // test/seed hook
    _setEstCosts: function (map) { _estCostByLead = map || {}; },           // test/seed hook
    _setSuppliers: function (list) { _suppliers = list || []; },            // test/seed hook
    _setRecurring: function (list) { _recurring = list || []; }             // test/seed hook
  };
})();
