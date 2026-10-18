/**
 * lowes-import.js — import Lowe's Pro purchases as job expenses (2026-10-18).
 *
 * Jo started Lowe's Pro tracking on 2026-10-08. Lowe's Pro › My Purchase
 * History › Export Purchase History (pick a date range, Request Report,
 * Download) gives ONE CSV, one row per ORDER (no line items):
 *
 *   Date ("14-Oct-2026"), Purchased From, Fulfillment Type, Fulfillment Store #,
 *   Fulfillment Store Location, Fulfillment Status, PO Number, Project Name,
 *   Group Name, Purchaser Name / Email / Phone, Order # / Trans., Invoice Number,
 *   Tax, Order Total, CC Type, CC# (last 4), Loyalty Rewards Earned, Order Ref
 *
 * The PO Number column is where Jo types the job (same rule as Home Depot:
 * "NBD-0042 Smith"). It is matched with the Home Depot importer's rules
 * (NBDHdImport.matchJob): customer number → exact; a remembered name → exact;
 * shop / tool words → overhead; name or street → a suggestion the review table
 * shows; otherwise the row is left for the receipt sorter.
 *
 * PRIVACY: the export carries the purchaser's email, phone and card digits.
 * Only date, store, PO text, order number, tax and total are ever read into a
 * receipt; the raw text is never kept.
 *
 * Flag `lowesImport` (feature_flags/_default, absent = off): off = no button,
 * nothing here runs. Nothing is saved until the review table's Import selected.
 *
 * Every order is keyed `lw-o-<order #>` (externalRef), so importing the same
 * file twice never double-counts.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const SOURCE = 'import_lowes';
  const SUPPLIER = "Lowe's";
  const FLAG = 'lowesImport';
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  const HD = () => w.NBDHdImport || null;
  const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG) && HD()); }

  function cents(v) {
    const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (!s) return 0;
    const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
    const n = parseFloat(s.replace(/[()\-]/g, ''));
    return isFinite(n) ? (neg ? -1 : 1) * Math.round(n * 100) : 0;
  }

  // "14-Oct-2026" | "2026-10-14" | "10/14/2026" → "2026-10-14"
  function ymd(v) {
    const s = String(v || '').trim();
    let m = /^(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})$/.exec(s);
    if (m && MONTHS[m[2].toLowerCase()]) return m[3] + '-' + String(MONTHS[m[2].toLowerCase()]).padStart(2, '0') + '-' + m[1].padStart(2, '0');
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
    if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
    return '';
  }

  const blankish = (s) => { const t = String(s || '').trim(); return /^(n\/a|na|none|-|—)$/i.test(t) ? '' : t; };

  // The Lowe's export: header row, data rows, then a legend line ("multiple*: …").
  function kindOf(text) {
    const H = HD();
    if (!H) return null;
    const rows = H.parseCsv(text);
    return rows.some((r) => { const h = r.map(norm); return h.includes('purchasedfrom') && h.includes('ordertotal'); }) ? 'lowes' : null;
  }

  function parseOrders(text) {
    const H = HD();
    if (!H) return [];
    const rows = H.parseCsv(text);
    const hi = rows.findIndex((r) => { const h = r.map(norm); return h.includes('purchasedfrom') && h.includes('ordertotal'); });
    if (hi < 0) return [];
    const head = rows[hi].map(norm);
    const col = (name) => head.indexOf(norm(name));
    const iDate = col('Date'), iStore = col('Fulfillment Store #'), iLoc = col('Fulfillment Store Location'), iStatus = col('Fulfillment Status'),
      iPo = col('PO Number'), iProj = col('Project Name'), iOrder = col('Order # / Trans.'), iInv = col('Invoice Number'),
      iTax = col('Tax'), iTotal = col('Order Total'), iType = col('Fulfillment Type');
    const get = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
    const out = [];
    const seen = {};
    rows.slice(hi + 1).forEach((r) => {
      const date = ymd(get(r, iDate));
      if (!date) return; // the legend / blank lines
      const status = get(r, iStatus);
      if (/cancel|return|refund|void/i.test(status)) return;
      const order = get(r, iOrder).replace(/[^A-Za-z0-9-]/g, '');
      const totalCents = cents(get(r, iTotal));
      if (!order || totalCents <= 0) return;
      const taxCents = Math.max(0, Math.min(totalCents, cents(get(r, iTax))));
      const key = 'lw-o-' + order;
      if (seen[key]) return; // the same order twice in one file is one purchase
      seen[key] = 1;
      // PO Number is the job name; Project Name is a second place Jo might type it.
      const po = blankish(get(r, iPo)) || blankish(get(r, iProj));
      out.push({
        key, date, order,
        store: get(r, iStore).replace(/[^0-9]/g, ''),
        storeName: get(r, iLoc),
        fulfillment: get(r, iType),
        jobName: po,
        invoice: get(r, iInv),
        totalCents, taxCents, pretaxCents: totalCents - taxCents,
        items: [], departments: {},
      });
    });
    return out;
  }

  // Receipts ready for review: a match + default category per order.
  function plan(text, leads, aliases, importedKeys) {
    const H = HD();
    if (!H) return [];
    const done = new Set(importedKeys || []);
    return parseOrders(text).map((r) => {
      const m = H.matchJob(r.jobName, leads, aliases || {});
      return Object.assign(r, {
        match: m, leadId: m.leadId,
        category: H.suggestCategory({ jobName: r.jobName, departments: {}, items: [] }),
        already: done.has(r.key), include: !done.has(r.key),
      });
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  function reviewStateOf(r) {
    if (r.leadId) return 'assigned';
    if (r.noJob || (r.match && r.match.status === 'overhead') || r.category === 'tools_small_equipment') return 'overhead';
    return 'unsorted';
  }

  // Same shape as hd-import.js expenseDoc (+ import provenance). No email,
  // phone or card digits: they are never read into `r`.
  function expenseDoc(r, ctx) {
    const cfg = w.ExpenseConfig;
    const costType = cfg && typeof cfg.costTypeFor === 'function' ? cfg.costTypeFor(r.category) : (r.category === 'materials' ? 'direct' : 'overhead');
    const note = [SUPPLIER + (r.storeName ? ' ' + r.storeName : '') + (r.store ? ' #' + r.store : ''),
      r.jobName ? 'PO/Job: ' + r.jobName : '', 'Order ' + r.order + ' (order total only; Lowe\'s gives no item list)'].filter(Boolean).join(' · ').slice(0, 500);
    return {
      userId: ctx.uid,
      companyId: ctx.companyId,
      leadId: r.leadId || null,
      category: r.category,
      costType,
      supplier: SUPPLIER,
      amountCents: r.totalCents - r.taxCents,
      taxCents: r.taxCents,
      currency: 'USD',
      date: new Date(r.date + 'T12:00:00'),
      note,
      receiptStoragePath: null,
      receiptDocRef: null,
      miles: null,
      mileageRateCents: null,
      marketingSource: null,
      source: SOURCE,
      externalRef: r.key,
      poJobName: String(r.jobName || '').slice(0, 120),
      storeNumber: r.store || null,
      orderNumber: r.order || null,
      itemCount: 0,
      items: [],
      reviewState: reviewStateOf(r),
      matchEvidence: r.match && r.match.reason ? [String(r.match.reason).slice(0, 160)] : [],
      ocrConfidence: null,
      needsReview: false,
    };
  }

  // ── UI ───────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const BADGE = {
    code: ['Customer #', 'li-ok'], alias: ['Remembered', 'li-ok'], suggested: ['Suggested', 'li-warn'],
    overhead: ['Overhead', 'li-info'], ambiguous: ['Pick a job', 'li-bad'], none: ['No match', 'li-bad'],
  };
  let _st = null; // { rows, aliases }

  function leadsList() { return (w._leads || []).filter((l) => l && !l.deleted); }
  function leadLabel(l) {
    const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || '';
    const a = String(l.address || '').split(',')[0];
    return (l.customerId ? l.customerId + ' · ' : '') + (n || a || 'Untitled') + (n && a ? ' — ' + a : '');
  }
  function importedKeys() {
    const list = (w.Expenses && typeof w.Expenses.list === 'function') ? w.Expenses.list() : [];
    return list.filter((e) => e && e.externalRef).map((e) => e.externalRef);
  }
  function modal() {
    let m = document.getElementById('lwImportModal');
    if (!m) { m = document.createElement('div'); m.id = 'lwImportModal'; m.className = 'li-overlay'; document.body.appendChild(m); }
    return m;
  }
  function shell(inner) {
    return '<div class="li-sheet"><div class="li-head"><h3>🔵 Import Lowe\'s purchases</h3>' +
      '<button type="button" class="modal-close" data-lw-action="close" title="Close">✕</button></div>' + inner + '</div>';
  }

  function buttonHtml() {
    return enabled() ? '<button type="button" class="btn btn-ghost" data-lw-action="open" title="Import Lowe\'s Pro purchases (My Purchase History › Export)">🔵 Import Lowe\'s</button>' : '';
  }

  function open() {
    if (!enabled()) return;
    _st = { rows: [], aliases: {} };
    modal().innerHTML = shell('<ol class="li-steps"><li>Lowe\'s Pro › <b>My Purchase History</b> › <b>Export Purchase History</b> › pick the dates › <b>Request Report</b> › <b>Download</b>.</li>' +
      '<li>Put the CRM customer number in the <b>PO</b> field at checkout (<b>NBD-0042 Smith</b>), the same as at Home Depot.</li>' +
      '<li>Choose the file below. Nothing is saved until you review and press Import.</li></ol>' +
      '<input type="file" accept=".csv,text/csv" data-lw-file>' +
      '<div class="li-msg" data-lw-msg></div>' +
      '<button type="button" class="btn btn-orange li-go" data-lw-action="review">Review purchases →</button>');
  }
  function close() { const m = document.getElementById('lwImportModal'); if (m) m.remove(); _st = null; }

  async function loadAliases() {
    try { const H = HD(); return H && typeof H.loadAliases === 'function' ? await H.loadAliases() : {}; } catch (e) { return {}; }
  }

  async function review() {
    const m = modal();
    const msg = m.querySelector('[data-lw-msg]');
    const f = m.querySelector('[data-lw-file]') && m.querySelector('[data-lw-file]').files[0];
    if (!f) { if (msg) msg.textContent = 'Choose the Lowe\'s CSV first.'; return; }
    const text = await f.text();
    if (!kindOf(text)) { if (msg) msg.textContent = 'That does not look like a Lowe\'s Pro purchase export (it needs "Purchased From" and "Order Total").'; return; }
    _st.aliases = await loadAliases();
    _st.rows = plan(text, leadsList(), _st.aliases, importedKeys());
    if (!_st.rows.length) { if (msg) msg.textContent = 'No purchases found in that file.'; return; }
    renderReview();
  }

  function renderReview() {
    const leads = leadsList();
    const byId = {}; leads.forEach((l) => { byId[l.id] = l; });
    const catOpts = (sel) => ((w.ExpenseConfig && w.ExpenseConfig.CATEGORIES) || [])
      .map((c) => '<option value="' + esc(c.key) + '"' + (c.key === sel ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    const leadOpts = (r) => {
      const first = (r.match.candidates || []).filter((id) => byId[id]);
      const rest = leads.filter((l) => first.indexOf(l.id) === -1).slice(0, 400);
      const opt = (l) => '<option value="' + esc(l.id) + '"' + (l.id === r.leadId ? ' selected' : '') + '>' + esc(leadLabel(l)) + '</option>';
      return '<option value="">— No job (overhead / shop) —</option>' +
        (first.length ? '<optgroup label="Best matches">' + first.map((id) => opt(byId[id])).join('') + '</optgroup>' : '') +
        '<optgroup label="All jobs">' + rest.map(opt).join('') + '</optgroup>';
    };
    const rows = _st.rows;
    const todo = rows.filter((r) => !r.already);
    const total = todo.filter((r) => r.include).reduce((a, r) => a + r.totalCents, 0);
    const body = rows.map((r, i) => {
      const b = r.already ? ['Imported', 'li-dim'] : BADGE[r.match.status];
      return '<tr class="' + (r.already ? 'li-done' : '') + '">' +
        '<td><input type="checkbox" data-lw-inc="' + i + '"' + (r.include ? ' checked' : '') + (r.already ? ' disabled' : '') + '></td>' +
        '<td class="li-nw">' + esc(r.date) + '<div class="li-sub">Store #' + esc(r.store || '?') + ' ' + esc(r.storeName) + '</div></td>' +
        '<td><b>' + esc(r.jobName || '—') + '</b><div class="li-sub ' + b[1] + '">' + esc(b[0]) + ' · ' + esc(r.already ? 'already in your expenses' : r.match.reason) + '</div>' +
        '<div class="li-sub">Order ' + esc(r.order) + '</div></td>' +
        '<td class="li-num">' + money(r.totalCents) + '<div class="li-sub">tax ' + money(r.taxCents) + '</div></td>' +
        '<td><select data-lw-lead="' + i + '"' + (r.already ? ' disabled' : '') + '>' + leadOpts(r) + '</select></td>' +
        '<td><select data-lw-cat="' + i + '"' + (r.already ? ' disabled' : '') + '>' + catOpts(r.category) + '</select></td></tr>';
    }).join('');
    modal().innerHTML = shell(
      '<div class="li-msg">' + rows.length + ' orders · ' + (rows.length - todo.length) + ' already imported · Lowe\'s gives order totals only (no item list). Orders with no clear job stay unsorted for the receipt sorter.</div>' +
      '<div class="li-scroll"><table class="li-table"><thead><tr><th></th><th>Date / store</th><th>PO / Job name</th><th class="li-num">Total</th><th>Job</th><th>Category</th></tr></thead><tbody>' + body + '</tbody></table></div>' +
      '<div class="li-foot"><div class="li-msg" data-lw-msg>' + todo.filter((r) => r.include).length + ' to import · ' + money(total) + '</div>' +
      '<button type="button" class="btn btn-orange" data-lw-action="import">Import selected</button></div>');
  }

  async function doImport(btn) {
    const uid = w._user && w._user.uid;
    const claims = w._userClaims || {};
    if (!uid || !w.addDoc) { if (w.showToast) w.showToast('Not signed in', 'error'); return; }
    const ctx = { uid, companyId: claims.companyId || uid };
    const todo = _st.rows.filter((r) => r.include && !r.already);
    if (!todo.length) { if (w.showToast) w.showToast('Nothing selected to import', 'info'); return; }
    btn.disabled = true;
    let ok = 0, fail = 0;
    for (const r of todo) {
      try {
        const d = expenseDoc(r, ctx);
        const lead = d.leadId ? (w._leads || []).find((x) => x && x.id === d.leadId) : null;
        d.jobId = lead && typeof lead.activeJobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(lead.activeJobId) ? lead.activeJobId : null;
        d.createdAt = w.serverTimestamp(); d.createdBy = uid; d.updatedAt = w.serverTimestamp();
        await w.addDoc(w.collection(w.db, 'expenses'), d);
        ok++; r.already = true;
      } catch (e) { fail++; console.warn('[lowes-import] save failed', r.key, e && e.code); }
    }
    if (w.showToast) w.showToast('Imported ' + ok + ' Lowe\'s purchase' + (ok === 1 ? '' : 's') + (fail ? ' · ' + fail + ' failed' : ''), fail ? 'error' : 'ok');
    if (w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh();
    close();
  }

  if (typeof document !== 'undefined' && !w._NBD_LW_DELEGATE) {
    w._NBD_LW_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest && ev.target.closest('[data-lw-action]');
      if (!t) return;
      const a = t.dataset.lwAction;
      if (a === 'open') open(); else if (a === 'close') close(); else if (a === 'review') review(); else if (a === 'import') doImport(t);
    });
    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!_st || !el || !el.dataset) return;
      if (el.dataset.lwInc != null) { _st.rows[+el.dataset.lwInc].include = !!el.checked; renderReview(); }
      else if (el.dataset.lwLead != null) { const r = _st.rows[+el.dataset.lwLead]; r.leadId = el.value || null; r.noJob = !el.value; }
      else if (el.dataset.lwCat != null) { _st.rows[+el.dataset.lwCat].category = el.value; }
    });
  }

  w.NBDLowesImport = { enabled, open, close, buttonHtml, kindOf, parseOrders, plan, expenseDoc, reviewStateOf, ymd, SOURCE };
})();
