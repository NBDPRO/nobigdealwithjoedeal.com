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
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
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
      if (nv(e.supplier) !== name) return sum;
      var d = toDate(e.date);
      if (!d || d.getFullYear() !== year) return sum;
      return sum + (parseInt(e.amountCents, 10) || 0);
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
  function findDuplicate(supplier, amountCents, dateStr) {
    // Match vendors the SAME way the 1099/YTD rollup does (normVendor) so a re-scan
    // that returns 'ABC Supply' vs 'ABC Supply, LLC' still trips the dup guard.
    var nv = (EC() && EC().normVendor) ? EC().normVendor : function (s) { return String(s || '').trim().toLowerCase(); };
    var sup = nv(supplier);
    return _expenses.find(function (e) {
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
      source: form.source === 'ocr' ? 'ocr' : 'manual',
      ocrConfidence: typeof form.ocrConfidence === 'number' ? form.ocrConfidence : null,
      needsReview: !!form.needsReview,
      createdAt: window.serverTimestamp(),
      createdBy: u,
      updatedAt: window.serverTimestamp()
    };
    try {
      await window.addDoc(window.collection(window.db, 'expenses'), docData);
      toast(unassignedDirect
        ? 'Expense logged — not linked to a job, so it won’t count toward job margin'
        : 'Expense logged', unassignedDirect ? 'warn' : 'ok');
      return true;
    } catch (e) {
      console.error('[expenses] create failed', e);
      toast('Failed to save expense', 'error');
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
    var mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
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
    var totalCents = 0, directCents = 0, overheadCents = 0;
    var bySupplier = {}, byCategory = {}, byJob = {};
    list.forEach(function (e) {
      // Spend/COGS rollups = tax-INCLUDED total (amount + tax): tax paid to the
      // supplier is real spend (product decision 2026-07-08). Same rule in
      // profit-tracker.js + money-dashboard.js. (#9)
      var cents = (parseInt(e.amountCents, 10) || 0) + (parseInt(e.taxCents, 10) || 0);
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
      if (!byJob[job]) byJob[job] = { cents: 0, directCents: 0, count: 0 };
      byJob[job].cents += cents;
      if (ct === 'direct') byJob[job].directCents += cents;
      byJob[job].count += 1;
    });
    var suppliers = Object.keys(bySupplier).map(function (k) {
      return { supplier: bySupplier[k].label, cents: bySupplier[k].cents, pct: totalCents ? (bySupplier[k].cents / totalCents * 100) : 0 };
    }).sort(function (a, b) { return b.cents - a.cents; });
    var categories = Object.keys(byCategory).map(function (k) {
      return { category: k, label: c ? c.labelFor(k) : k, cents: byCategory[k], pct: totalCents ? (byCategory[k] / totalCents * 100) : 0 };
    }).sort(function (a, b) { return b.cents - a.cents; });
    return {
      totalCents: totalCents, directCents: directCents, overheadCents: overheadCents,
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
      .reduce(function (sum, e) { return sum + (parseInt(e.amountCents, 10) || 0) + (parseInt(e.taxCents, 10) || 0); }, 0);
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
    return '<div style="height:6px;background:var(--s2,rgba(255,255,255,.06));border-radius:4px;overflow:hidden;margin-top:4px;">' +
      '<div style="height:100%;width:' + Math.max(2, Math.min(100, pct)).toFixed(1) + '%;background:' + color + ';"></div></div>';
  }

  function render() {
    var scroll = document.querySelector('#view-expenses .view-scroll');
    if (!scroll) return;
    var agg = aggregate(_expenses);
    var accent = 'var(--orange,#BD5728)';

    var html = '';
    // Header
    html += '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:18px;">' +
      '<div><h2 style="margin:0;font-family:\'Barlow Condensed\',sans-serif;font-size:26px;font-weight:800;color:var(--t,#fff);">🧾 Expenses &amp; Supplier Spend</h2>' +
      '<div style="font-size:12px;color:var(--m,#9ca3af);margin-top:2px;">' + (isStaff() && claims().companyId ? 'Team-wide (all reps)' : 'Your expenses') + ' · ' + _expenses.length + ' logged</div></div>' +
      '<div style="display:flex;gap:8px;">' +
        (_expenses.length ? '<button type="button" class="btn btn-ghost" data-exp-action="export-csv" title="Download CSV for your accountant">⬇ Export CSV</button>' : '') +
        (window.NBDHdImport ? '<button type="button" class="btn btn-ghost" data-hd-action="open" title="Import Home Depot Pro Xtra purchases (Purchase History › Export)">🧡 Import Home Depot</button>' : '') +
        '<button type="button" class="btn btn-orange" data-exp-action="open-form">+ Log Expense</button>' +
      '</div>' +
      '</div>';

    // Summary cards
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;">';
    html += card('Total Spend', money(agg.totalCents), agg.supplierCount + (agg.supplierCount === 1 ? ' supplier' : ' suppliers'), accent);
    html += card('Direct / Job Costs', money(agg.directCents), 'COGS — feeds margin', 'var(--green,#16a34a)');
    html += card('Overhead', money(agg.overheadCents), 'Operating costs', 'var(--blue,#3b82f6)');
    html += '</div>';

    // Lead Spend — two subcategories (see leadSpendSummary above). Independent
    // of _expenses.length: leadCost lives on the lead doc, so this can have
    // real numbers before anyone logs a conventional expense.
    var ls = leadSpendSummary();
    if (ls.leadCents > 0 || ls.marketingCents > 0) {
      var lsTotal = ls.leadCents + ls.marketingCents;
      var leadPct = lsTotal ? (ls.leadCents / lsTotal * 100) : 0;
      var mktPct = lsTotal ? (ls.marketingCents / lsTotal * 100) : 0;
      html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;margin-bottom:20px;">' +
        '<h3 style="margin:0 0 4px;font-size:14px;color:var(--t,#fff);">📣 Lead Spend</h3>' +
        '<div style="font-size:11px;color:var(--m,#9ca3af);margin-bottom:12px;">What it costs to generate a lead — per-lead marketplace fees plus the marketing/advertising you log by hand.</div>' +
        '<div style="margin-bottom:14px;">' +
          '<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--t,#fff);">' +
          '<span>Lead / Acquisition Cost <span style="font-size:10px;color:var(--m,#9ca3af);">(job cost — Thumbtack auto-captured)</span></span>' +
          '<span style="font-weight:700;">' + money(ls.leadCents) + '</span></div>' +
          bar(leadPct, 'var(--green,#16a34a)') +
          (ls.leadCount
            ? '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:4px;">' + ls.leadCount + ' lead' + (ls.leadCount === 1 ? '' : 's') +
              ' · ' + money(Math.round(ls.leadCents / ls.leadCount)) + ' avg' +
              (ls.sourceRows.length ? ' · ' + ls.sourceRows.slice(0, 3).map(function (r) { return esc(r.source) + ' ' + money(r.cents); }).join(' · ') : '') +
              '</div>'
            : '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:4px;">No per-lead cost captured yet.</div>') +
        '</div>' +
        '<div>' +
          '<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--t,#fff);">' +
          '<span>Marketing &amp; Advertising <span style="font-size:10px;color:var(--m,#9ca3af);">(overhead — logged by hand, e.g. Yelp/Angi invoices)</span></span>' +
          '<span style="font-weight:700;">' + money(ls.marketingCents) + '</span></div>' +
          bar(mktPct, 'var(--blue,#3b82f6)') +
        '</div>' +
        '</div>';
    }

    if (_expenses.length === 0) {
      html += '<div style="border:1px dashed var(--br,rgba(255,255,255,.12));border-radius:12px;">' +
        '<div class="nbd-empty"><div class="ne-icon">🧾</div>' +
        '<div class="ne-msg">No expenses yet</div>' +
        '<div class="ne-sub">Log your first material or supplier cost to start tracking spend and job margin. You can also add suppliers below.</div></div></div>';
    }

    // Expense-only analytics (spend report + per-job rollup) — only when there
    // are expenses. The Recurring + Suppliers sections below always render so
    // they're reachable even before the first expense is logged.
    if (_expenses.length) {
    // Two-column: supplier spend + category breakdown
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:20px;">';
    // Supplier spend (the explicit ask)
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;">' +
      '<h3 style="margin:0 0 12px;font-size:14px;color:var(--t,#fff);">Spend by Supplier</h3>';
    agg.suppliers.slice(0, 8).forEach(function (s) {
      html += '<div style="margin-bottom:10px;">' +
        '<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--t,#fff);">' +
        '<span>' + esc(s.supplier) + '</span><span style="font-weight:700;">' + money(s.cents) + '</span></div>' +
        '<div style="font-size:11px;color:var(--m,#9ca3af);">' + s.pct.toFixed(0) + '% of total</div>' +
        bar(s.pct, accent) + '</div>';
    });
    html += '</div>';
    // Category breakdown
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;">' +
      '<h3 style="margin:0 0 12px;font-size:14px;color:var(--t,#fff);">Spend by Category</h3>';
    agg.categories.forEach(function (cat) {
      html += '<div style="margin-bottom:10px;">' +
        '<div style="display:flex;justify-content:space-between;font-size:13px;color:var(--t,#fff);">' +
        '<span>' + esc(cat.label) + '</span><span style="font-weight:700;">' + money(cat.cents) + '</span></div>' +
        bar(cat.pct, 'var(--blue,#3b82f6)') + '</div>';
    });
    html += '</div>';
    html += '</div>';

    // Per-job rollup with margin
    var jobIds = Object.keys(agg.byJob).filter(function (k) { return k !== '__unassigned__'; });
    if (jobIds.length) {
      html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;margin-bottom:20px;">' +
        '<h3 style="margin:0 0 12px;font-size:14px;color:var(--t,#fff);">Cost &amp; Margin by Job</h3>';
      jobIds.map(function (jid) {
        var jb = agg.byJob[jid];
        var lead = leadById(jid);
        var jobExp = _expenses.filter(function (e) { return e.leadId === jid; });
        var pl = jobMargin(lead, jobExp);
        return { jid: jid, jb: jb, lead: lead, pl: pl };
      }).sort(function (a, b) { return b.jb.cents - a.jb.cents; }).forEach(function (row) {
        var mColor = !row.pl ? 'var(--m,#9ca3af)' : row.pl.grossMargin >= 40 ? 'var(--green,#16a34a)' : row.pl.grossMargin >= 25 ? 'var(--gold,#eab308)' : 'var(--red,#dc2626)';
        var marginTxt = row.pl ? (row.pl.grossMargin + '% margin') : (row.lead ? 'set Job Value' : 'job not found');
        // A4: budget / margin-floor flag (direct cost vs contract value)
        var ecB = EC();
        var rev = (ecB && row.lead) ? ecB.getJobRevenue(row.lead) : 0;
        var bDefaults = (window._companyProfile && window._companyProfile.budgetDefaults) || null;
        var bStatus = ecB && ecB.budgetStatus ? ecB.budgetStatus(rev, row.jb.directCents / 100, bDefaults) : null;
        var budgetBadge = bStatus === 'breach' ? '<span title="Over budget / margin below floor" style="color:var(--red,#dc2626);">⚠ </span>'
          : bStatus === 'warn' ? '<span title="Approaching cost budget" style="color:var(--gold,#eab308);">⚠ </span>' : '';
        // Estimated-vs-actual (V2 estimates only)
        var va = estVsActual(row.jid, row.jb.directCents);
        var vaTxt = '';
        if (va) {
          var over = va.varianceCents > 0;
          var vColor = over ? 'var(--red,#dc2626)' : 'var(--green,#16a34a)';
          vaTxt = '<div style="font-size:11px;color:var(--m,#9ca3af);">est ' + money(va.estCents) + ' · ' +
            '<span style="color:' + vColor + ';font-weight:700;">' + (over ? '+' : '') + money(Math.abs(va.varianceCents)) + (over ? ' over' : ' under') + '</span></div>';
        }
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--br,rgba(255,255,255,.06));">' +
          '<div style="min-width:0;"><div style="font-size:13px;color:var(--t,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(leadName(row.lead)) + '</div>' +
          '<div style="font-size:11px;color:var(--m,#9ca3af);">' + row.jb.count + (row.jb.count === 1 ? ' expense · ' : ' expenses · ') + money(row.jb.directCents) + ' direct</div>' + vaTxt + '</div>' +
          '<div style="text-align:right;white-space:nowrap;"><div style="font-size:14px;font-weight:700;color:var(--t,#fff);">' + money(row.jb.cents) + '</div>' +
          '<div style="font-size:11px;font-weight:700;color:' + mColor + ';">' + budgetBadge + marginTxt + '</div></div></div>';
      });
      html += '<div style="font-size:10px;color:var(--m,#9ca3af);margin-top:10px;">Gross margin = Job Value − direct job costs (before overhead &amp; commission). "est" = budgeted cost from the job\'s estimate (V2 builder only).</div>';
      html += '</div>';
    }
    } // end expense-only analytics

    // A1b: Recurring templates + one-tap "Due" chips
    if (_recurring.length) {
      html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;margin-bottom:20px;">' +
        '<h3 style="margin:0 0 12px;font-size:14px;color:var(--t,#fff);">🔁 Recurring</h3>';
      _recurring.slice().sort(function (a, b) { return (toDate(a.nextDueDate) || 0) - (toDate(b.nextDueDate) || 0); }).forEach(function (t) {
        var due = isDue(t);
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--br,rgba(255,255,255,.06));">' +
          '<div style="min-width:0;"><div style="font-size:13px;color:var(--t,#fff);">' + esc(t.name || 'Recurring') + ' · ' + money(t.amountCents) + '</div>' +
          '<div style="font-size:11px;color:var(--m,#9ca3af);">' + esc(t.frequency || 'monthly') + ' · ' + (t.status !== 'active' ? 'paused' : 'next ' + esc(fmtDate(t.nextDueDate))) + '</div></div>' +
          '<div style="white-space:nowrap;">' +
            (due ? '<button type="button" class="btn btn-orange btn-sm" data-exp-action="add-recurring" data-rec-id="' + esc(t.id) + '">Due — Add</button> ' : '') +
            '<button data-exp-action="del-recurring" data-rec-id="' + esc(t.id) + '" title="Delete template" style="background:none;border:none;color:var(--red,#dc2626);cursor:pointer;font-size:13px;">✕</button>' +
          '</div></div>';
      });
      html += '</div>';
    }

    // A5: Suppliers & 1099 tracking
    var taxYear = new Date().getFullYear();
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;margin-bottom:20px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
        '<h3 style="margin:0;font-size:14px;color:var(--t,#fff);">🧑‍🔧 Suppliers &amp; 1099 (' + taxYear + ')</h3>' +
        '<div style="display:flex;gap:8px;">' +
          (_suppliers.length ? '<button type="button" class="btn btn-ghost btn-sm" data-exp-action="export-1099" title="Year-end 1099 worklist CSV">⬇ 1099 CSV</button>' : '') +
          '<button type="button" class="btn btn-orange btn-sm" data-exp-action="open-supplier">+ Supplier</button>' +
        '</div></div>';
    if (!_suppliers.length) {
      html += '<div style="font-size:12px;color:var(--m,#9ca3af);">No suppliers yet. Add subcontractors/vendors to track who needs a 1099-NEC at year-end (services ≥ ' + money(thresholdCents(taxYear)) + ' in ' + taxYear + ').</div>';
    } else {
      _suppliers.slice().sort(function (a, b) { return (a.displayName || '').localeCompare(b.displayName || ''); }).forEach(function (s) {
        var ytd = supplierYtdCents(s.displayName, taxYear, _expenses);
        var flag = needs1099(s, taxYear, _expenses);
        var tc = TAX_CLASS_BY_KEY[s.taxClassification];
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--br,rgba(255,255,255,.06));">' +
          '<div style="min-width:0;"><div style="font-size:13px;color:var(--t,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(s.displayName) + '</div>' +
          '<div style="font-size:11px;color:var(--m,#9ca3af);">' + esc(tc ? tc.label : s.taxClassification || '') + ' · W-9: ' + esc(s.w9Status || 'not_requested') + (s.is1099Eligible ? ' · 1099-eligible' : ' · exempt') + '</div></div>' +
          '<div style="text-align:right;white-space:nowrap;"><div style="font-size:13px;font-weight:700;color:var(--t,#fff);">' + money(ytd) + ' YTD</div>' +
          (flag ? '<div style="font-size:11px;font-weight:700;color:var(--orange,#BD5728);">⚑ 1099 due</div>' : '') +
          '</div>' +
          '<button data-exp-action="del-supplier" data-sup-id="' + esc(s.id) + '" title="Delete" style="background:none;border:none;color:var(--red,#dc2626);cursor:pointer;font-size:13px;">✕</button>' +
          '</div>';
      });
      html += '<div style="font-size:10px;color:var(--m,#9ca3af);margin-top:10px;">YTD = subcontractor/labor payments matched by name, this year. 1099 due = eligible class + W-9 on file + YTD ≥ ' + money(thresholdCents(taxYear)) + '. No tax IDs are stored.</div>';
    }
    html += '</div>';

    // Recent expense list (only when there are expenses)
    if (_expenses.length) {
    var noReceipt = _expenses.filter(function (e) { return !e.receiptStoragePath && e.category !== 'mileage'; }).length;
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;">' +
      '<h3 style="margin:0 0 4px;font-size:14px;color:var(--t,#fff);">Recent Expenses</h3>' +
      (noReceipt ? '<div style="font-size:11px;color:var(--gold,#eab308);margin-bottom:10px;">📎 ' + noReceipt + ' expense' + (noReceipt === 1 ? '' : 's') + ' without a receipt — attaching a photo or PDF is recommended (taxes, disputes, warranty claims).</div>' : '<div style="margin-bottom:8px;"></div>');
    _expenses.slice(0, 60).forEach(function (e) {
      var lead = e.leadId ? leadById(e.leadId) : null;
      html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--br,rgba(255,255,255,.06));">' +
        '<div style="min-width:0;flex:1;">' +
        '<div style="font-size:13px;color:var(--t,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(e.supplier || 'Unknown') +
        ' <span style="font-size:10px;color:var(--m,#9ca3af);">· ' + esc(EC() ? EC().labelFor(e.category) : e.category) + '</span></div>' +
        '<div style="font-size:11px;color:var(--m,#9ca3af);">' + esc(fmtDate(e.date)) + (lead ? ' · ' + esc(leadName(lead)) : '') + (e.note ? ' · ' + esc(e.note) : '') + (e.source === 'ocr' ? ' · scanned' : e.source === 'import_homedepot' ? ' · Home Depot import' : '') + '</div></div>' +
        (e.needsReview ? '<span title="AI scan — review the amount/vendor" style="color:var(--gold,#eab308);font-size:13px;">⚠</span>' : '') +
        (e.receiptStoragePath
          ? '<button data-exp-action="receipt" data-exp-path="' + esc(e.receiptStoragePath) + '" title="View receipt" style="background:none;border:none;cursor:pointer;font-size:15px;">📎</button>'
          // No receipt yet — recommended, never required (Jo, 2026-09-29).
          : '<button data-exp-action="attach" data-exp-id="' + esc(e.id) + '" title="Attach a receipt (photo or PDF)" style="background:none;border:1px dashed var(--br,rgba(255,255,255,.25));border-radius:6px;color:var(--m,#9ca3af);cursor:pointer;font-size:11px;padding:3px 7px;white-space:nowrap;">📎 Add receipt</button>') +
        // Total incl. sales tax — the same figure every card above sums
        // (a $1,234.56 + $87.65 tax row used to read $1,234.56 under a
        // $1,322.21 total). The tax is named on a second line.
        '<div style="text-align:right;white-space:nowrap;"><div style="font-size:14px;font-weight:700;color:var(--t,#fff);">' +
          money((parseInt(e.amountCents, 10) || 0) + (parseInt(e.taxCents, 10) || 0)) + '</div>' +
          ((parseInt(e.taxCents, 10) || 0) > 0 ? '<div style="font-size:10px;color:var(--m,#9ca3af);">incl. ' + money(e.taxCents) + ' tax</div>' : '') +
        '</div>' +
        '<button data-exp-action="delete" data-exp-id="' + esc(e.id) + '" title="Delete" style="background:none;border:none;color:var(--red,#dc2626);cursor:pointer;font-size:14px;">✕</button>' +
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
      '<div class="stat-lbl" style="margin-top:0;text-transform:uppercase;letter-spacing:.05em;">' + esc(label) + '</div>' +
      '<div class="stat-val" style="font-weight:800;color:' + color + ';-webkit-text-fill-color:' + color + ';margin:2px 0;">' + value + '</div>' +
      '<div style="font-size:10px;color:var(--m,#9ca3af);">' + esc(sub) + '</div></div>';
  }

  // ── entry form (modal) ──────────────────────────────────────────────
  function openForm() {
    var c = EC();
    if (document.getElementById('expFormOverlay')) return;
    var cats = (c ? c.CATEGORIES : []).map(function (x) {
      return '<option value="' + esc(x.key) + '">' + esc(x.label) + (x.costType === 'direct' ? ' (job cost)' : ' (overhead)') + '</option>';
    }).join('');
    var leadOpts = '<option value="">— No job (overhead) —</option>' + (window._leads || []).slice(0, 500).map(function (l) {
      return '<option value="' + esc(l.id) + '">' + esc(leadName(l)) + '</option>';
    }).join('');
    var today = ymdLocal(new Date());
    var fld = 'width:100%;padding:10px;background:var(--s2,rgba(255,255,255,.04));border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;color:var(--t,#fff);font-size:14px;box-sizing:border-box;';
    var lbl = 'font-size:11px;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px;';

    // Canonical modal pair (dashboard-app.css): .modal-bg backdrop at
    // var(--z-overlay) + .modal card; open/close is ONLY the .open class
    // (cert-round rule), driven through nbdModal below.
    var ov = document.createElement('div');
    ov.id = 'expFormOverlay';
    ov.className = 'modal-bg';
    ov.innerHTML =
      '<div class="modal" style="max-width:440px;">' +
        '<button type="button" class="modal-close" data-exp-action="close-form" title="Close">✕</button>' +
        '<h3 style="margin:0 0 16px;color:var(--t,#fff);font-size:18px;">Log Expense</h3>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
          '<div><label style="' + lbl + '">Amount ($)</label><input id="expAmount" type="number" step="0.01" min="0" inputmode="decimal" autofocus style="' + fld + '"></div>' +
          '<div><label style="' + lbl + '">Date</label><input id="expDate" type="date" value="' + today + '" style="' + fld + '"></div>' +
          '<div><label style="' + lbl + '">Sales Tax ($)</label><input id="expTax" type="number" step="0.01" min="0" inputmode="decimal" style="' + fld + '"></div>' +
          '<div><label style="' + lbl + '">Category</label><select id="expCategory" style="' + fld + '">' + cats + '</select></div>' +
        '</div>' +
        '<div id="expMileageRow" style="display:none;margin-top:12px;"><label style="' + lbl + '">Miles</label>' +
          '<input id="expMiles" type="number" step="0.1" min="0" inputmode="decimal" style="' + fld + '">' +
          '<div id="expMileageHint" style="font-size:11px;color:var(--m,#9ca3af);margin-top:4px;"></div></div>' +
        '<div id="expSourceRow" style="display:none;margin-top:12px;"><label style="' + lbl + '">Lead Source / Campaign</label>' +
          '<input id="expSource" type="text" maxlength="60" placeholder="e.g. Door-to-Door, Google, Storm" style="' + fld + '"></div>' +
        '<div style="margin-top:12px;"><label style="' + lbl + '">Supplier / Vendor</label><input id="expSupplier" type="text" maxlength="120" list="expSupplierList" placeholder="e.g. ABC Supply" style="' + fld + '">' +
          '<datalist id="expSupplierList">' + _suppliers.map(function (s) { return '<option value="' + esc(s.displayName) + '">'; }).join('') + '</datalist></div>' +
        '<div style="margin-top:12px;"><label style="' + lbl + '">Job (optional)</label><select id="expLead" style="' + fld + '">' + leadOpts + '</select></div>' +
        '<div style="margin-top:12px;"><label style="' + lbl + '">Note (optional)</label><input id="expNote" type="text" maxlength="500" style="' + fld + '"></div>' +
        '<div style="margin-top:12px;"><label style="' + lbl + '">Repeat (optional)</label><select id="expRepeat" style="' + fld + '"><option value="none">One-time</option>' +
          FREQUENCIES.map(function (f) { return '<option value="' + f.key + '">' + f.label + '</option>'; }).join('') + '</select></div>' +
        '<div style="margin-top:12px;"><label style="' + lbl + '">Receipt (image / PDF, optional)</label>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<input id="expFile" type="file" accept="image/*,application/pdf" style="' + fld + 'flex:1;">' +
            '<button data-exp-action="scan" type="button" class="btn btn-ghost" style="white-space:nowrap;">📷 Scan with AI</button>' +
          '</div>' +
          '<div id="expScanStatus" style="font-size:11px;color:var(--m,#9ca3af);margin-top:6px;min-height:14px;"></div>' +
        '</div>' +
        '<button type="button" class="btn btn-orange" data-exp-action="save" style="width:100%;margin-top:18px;justify-content:center;">Save Expense</button>' +
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
    if (catSel) catSel.addEventListener('change', syncCategoryFields);
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
    var dup = findDuplicate(v('expSupplier'), dupCents, v('expDate'));
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
      if (repeat && repeat !== 'none' && v('expCategory') !== 'mileage') {
        await createRecurringTemplate({ amount: v('expAmount'), date: v('expDate'), supplier: v('expSupplier'), category: v('expCategory') }, repeat);
      }
      closeForm(); await refresh();
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
    if (scroll && !_loaded) scroll.innerHTML = '<div style="padding:40px;text-align:center;color:var(--m,#9ca3af);">Loading expenses…</div>';
    refresh();
  }

  // ── CSV export (accountant-ready; do this BEFORE any QuickBooks/Xero API) ──
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // Neutralize spreadsheet formula injection: a leading =,+,-,@,tab,CR makes
    // Excel/Sheets EXECUTE the cell. OCR-extracted vendor text is attacker-
    // influenceable (a crafted receipt image) and this CSV is opened by the
    // accountant — prefix a single quote so the cell is treated as text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCSV() {
    var c = EC();
    if (!_expenses.length) { toast('No expenses to export', 'warn'); return; }
    var cols = ['Date', 'Supplier', 'Category', 'Cost Type', 'Amount', 'Sales Tax', 'Job', 'Note', 'Source', 'Schedule C (suggested)'];
    var rows = _expenses.map(function (e) {
      var d = toDate(e.date);
      var lead = e.leadId ? leadById(e.leadId) : null;
      var hint = (c && c.byKey[e.category] && c.byKey[e.category].scheduleCHint) || '';
      return [
        d ? ymdLocal(d) : '',
        e.supplier || '',
        (c ? c.labelFor(e.category) : e.category) || '',
        e.costType || '',
        ((parseInt(e.amountCents, 10) || 0) / 100).toFixed(2),
        ((parseInt(e.taxCents, 10) || 0) / 100).toFixed(2),
        lead ? leadName(lead) : '',
        e.note || '',
        e.source || 'manual',
        hint
      ].map(csvCell).join(',');
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
    var fld = 'width:100%;padding:10px;background:var(--s2,rgba(255,255,255,.04));border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;color:var(--t,#fff);font-size:14px;box-sizing:border-box;';
    var lbl = 'font-size:11px;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;display:block;margin-bottom:4px;';
    var classOpts = TAX_CLASSES.map(function (t) { return '<option value="' + t.key + '">' + esc(t.label) + (t.eligible ? '' : ' — exempt') + '</option>'; }).join('');
    var w9Opts = [['not_requested', 'Not requested'], ['requested', 'Requested'], ['received', 'Received'], ['verified', 'Verified']]
      .map(function (o) { return '<option value="' + o[0] + '">' + o[1] + '</option>'; }).join('');
    // Canonical modal pair — same contract as openForm above.
    var ov = document.createElement('div');
    ov.id = 'supFormOverlay';
    ov.className = 'modal-bg';
    ov.innerHTML =
      '<div class="modal" style="max-width:440px;">' +
        '<button type="button" class="modal-close" data-exp-action="close-supplier" title="Close">✕</button>' +
        '<h3 style="margin:0 0 16px;color:var(--t,#fff);font-size:18px;">Add Supplier</h3>' +
        '<div style="margin-bottom:12px;"><label style="' + lbl + '">Supplier / Vendor name</label><input id="supName" type="text" maxlength="120" placeholder="e.g. Crew Co" autofocus style="' + fld + '"></div>' +
        '<div style="margin-bottom:12px;"><label style="' + lbl + '">Legal name (for the 1099)</label><input id="supLegal" type="text" maxlength="120" style="' + fld + '"></div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
          '<div><label style="' + lbl + '">Tax classification (from W-9)</label><select id="supClass" style="' + fld + '">' + classOpts + '</select></div>' +
          '<div><label style="' + lbl + '">W-9 status</label><select id="supW9" style="' + fld + '">' + w9Opts + '</select></div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">' +
          '<div><label style="' + lbl + '">Phone</label><input id="supPhone" type="tel" maxlength="40" style="' + fld + '"></div>' +
          '<div><label style="' + lbl + '">Email</label><input id="supEmail" type="email" maxlength="120" style="' + fld + '"></div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:10px;">1099-eligibility is derived from the tax classification. No SSN/EIN is stored — keep tax IDs in your tax software.</div>' +
        '<button type="button" class="btn btn-orange" data-exp-action="save-supplier" style="width:100%;margin-top:16px;justify-content:center;">Save Supplier</button>' +
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
    render: render,
    refresh: refresh,
    // data-layer (used by Phase 2 OCR + future surfaces)
    createExpense: createExpense,
    removeExpense: removeExpense,
    exportCSV: exportCSV,
    // Loaded expenses (hd-import.js skips receipts already imported).
    list: function () { return _expenses.slice(); },
    saveAttachedReceipt: saveAttachedReceipt,
    // pure functions (exported for unit tests)
    aggregate: aggregate,
    jobMargin: jobMargin,
    leadSpendSummary: leadSpendSummary,
    estVsActual: estVsActual,
    findDuplicate: findDuplicate,
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
