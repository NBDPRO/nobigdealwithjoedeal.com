/**
 * hd-import.js — import Home Depot Pro Xtra purchases as job expenses.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Jo (2026-09-29): "start sorting and saving more expenses easily. They have
 * POs / job names". Home Depot › Purchase History › Export gives two CSVs:
 *
 *   SUMMARY — one row per receipt: Date, Order Origin ("#3822, Western
 *             Hills"), Transaction ID, Register Number, Project Name,
 *             Job Name, Pre-tax Amount, Total Amount Paid, Order Number,
 *             Invoice Number, Payment ("X-7769") …  → the money.
 *   DETAILS — one row per line item: Date, Store Number, Transaction ID,
 *             Job Name, SKU Description, Quantity, Department Name,
 *             Net Unit Price …                     → what was bought.
 *
 * Returns / cancellations are excluded by Home Depot's export, so every
 * amount is ≥ 0 (firestore.rules validExpenseMoney rejects negatives).
 *
 * MATCHING A RECEIPT TO A JOB (the rules Jo follows at checkout — see
 * documentation/runbooks/HOME-DEPOT-EXPENSES.md):
 *   1. The Job Name holds the CRM customer number ("NBD-0042 Smith") → exact.
 *   2. A name this company already assigned once ("Lora" → that lead) →
 *      remembered alias (userSettings/{uid}.hdJobAliases).
 *   3. SHOP / STOCK / TOOLS / OFFICE / TRUCK → no job (overhead).
 *   4. Otherwise a suggestion from the lead's name / street address, which
 *      the review table shows for a one-click confirm. Never auto-saved
 *      without the review.
 *
 * Every receipt carries a stable key (store + date + transaction, or the
 * online order number) stored as `externalRef`, so importing the same file
 * twice never double-counts.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const SOURCE = 'import_homedepot';
  const SUPPLIER = 'Home Depot';
  const OVERHEAD_WORDS = /^(shop|stock|inventory|tools?|office|truck|van|misc|etc|overhead|personal)\b/i;
  const TOOL_WORDS = /^tools?\b/i;

  // ── CSV ──────────────────────────────────────────────────────────────
  // RFC-4180-ish: quotes, "" escapes, commas/newlines inside quotes, CRLF,
  // BOM. Returns an array of string arrays.
  function parseCsv(text) {
    const s = String(text || '').replace(/^﻿/, '');
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  }

  const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  // Find the header row (Home Depot puts 5-6 lines of account info above it).
  function table(text) {
    const rows = parseCsv(text);
    const hi = rows.findIndex((r) => r.map(norm).includes('transactionid'));
    if (hi < 0) return null;
    const head = rows[hi].map(norm);
    const col = (name) => head.indexOf(norm(name));
    return { head, col, rows: rows.slice(hi + 1) };
  }

  function kindOf(text) {
    const t = table(text);
    if (!t) return null;
    if (t.col('Total Amount Paid') >= 0) return 'summary';
    if (t.col('SKU Number') >= 0 || t.col('SKU Description') >= 0) return 'details';
    return null;
  }

  function cents(v) {
    const s = String(v == null ? '' : v).replace(/[$,\s]/g, '');
    if (!s) return 0;
    const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
    const n = parseFloat(s.replace(/[()\-]/g, ''));
    if (!isFinite(n)) return 0;
    return (neg ? -1 : 1) * Math.round(n * 100);
  }

  function ymd(v) {
    const s = String(v || '').trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
    if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0'); }
    return '';
  }

  function storeNum(v) { const m = /#?\s*(\d{3,5})/.exec(String(v || '')); return m ? m[1] : ''; }
  function receiptKey(date, store, txn, order) {
    if (order) return 'hd-o-' + String(order).trim().replace(/[^A-Za-z0-9-]/g, '');
    return 'hd-' + date + '-' + (store || 'x') + '-' + String(txn || '').trim().replace(/[^A-Za-z0-9-]/g, '');
  }

  // ── SUMMARY → receipts ───────────────────────────────────────────────
  function parseSummary(text) {
    const t = table(text);
    if (!t || t.col('Total Amount Paid') < 0) return [];
    const g = (r, name) => { const i = t.col(name); return i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : ''; };
    return t.rows.map((r) => {
      const date = ymd(g(r, 'Date'));
      const origin = g(r, 'Order Origin');
      const store = storeNum(origin) || g(r, 'Store Number');
      const txn = g(r, 'Transaction ID');
      const order = g(r, 'Order Number');
      const totalCents = Math.max(0, cents(g(r, 'Total Amount Paid')));
      const pretaxCents = Math.max(0, cents(g(r, 'Pre-tax Amount')));
      return {
        key: receiptKey(date, store, txn, order),
        date, store, storeName: origin.replace(/^#?\s*\d+\s*,?\s*/, '') || '',
        txn, register: g(r, 'Register Number'), order,
        jobName: g(r, 'Job Name'), projectName: g(r, 'Project Name'),
        invoice: g(r, 'Invoice Number'), card: g(r, 'Payment'),
        totalCents, pretaxCents,
        taxCents: Math.max(0, totalCents - pretaxCents),
        items: [], departments: {},
      };
    }).filter((x) => x.date && (x.txn || x.order) && x.totalCents > 0);
  }

  // ── DETAILS → line items attached to receipts ───────────────────────
  function parseDetails(text) {
    const t = table(text);
    if (!t) return [];
    const g = (r, name) => { const i = t.col(name); return i >= 0 ? String(r[i] == null ? '' : r[i]).trim() : ''; };
    return t.rows.map((r) => {
      const date = ymd(g(r, 'Date'));
      return {
        key: receiptKey(date, g(r, 'Store Number'), g(r, 'Transaction ID'), g(r, 'Order Number')),
        desc: g(r, 'SKU Description').replace(/�/g, ''),
        qty: parseFloat(g(r, 'Quantity')) || 0,
        dept: g(r, 'Department Name').toUpperCase(),
        cents: Math.max(0, cents(g(r, 'Net Unit Price') || g(r, 'Extended Retail (before discount)'))),
      };
    }).filter((x) => x.key && x.desc);
  }

  function attachDetails(receipts, lines) {
    const by = {};
    receipts.forEach((r) => { by[r.key] = r; });
    lines.forEach((l) => {
      const r = by[l.key];
      if (!r) return;
      r.items.push({ desc: l.desc, qty: l.qty, dept: l.dept, cents: l.cents });
      r.departments[l.dept || 'OTHER'] = (r.departments[l.dept || 'OTHER'] || 0) + l.cents;
    });
    return receipts;
  }

  // Home Depot files power tools under HARDWARE, same as nails — so the
  // department can't tell a drill from a box of screws. Brand / tool words in
  // the job name or the item descriptions can (checked on Jo's real export,
  // 2026-09-29: "M18 8 Tool Combo", "Milwaukee Roofing Nail Gun", "Ryobi Vac"…).
  const TOOL_ITEM = /\b(m12|m18|milwaukee|ryobi|dewalt|makita|ridgid|bosch|combo kit|drill|impact driver|circular saw|miter saw|reciprocating|sawzall|oscillating|nail(er| gun)|stapler|compressor|blower|shop vac|wet\/dry vac|vac\b|battery|batteries|charger|ladder|tool ?(set|kit|bag|box)|tools?)\b/i;
  function suggestCategory(r) {
    if (TOOL_WORDS.test(r.jobName || '') || TOOL_ITEM.test(r.jobName || '')) return 'tools_small_equipment';
    const d = r.departments || {};
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    if (total > 0 && (d['TOOL RENTAL'] || 0) / total >= 0.6) return 'equipment_dumpster';
    const toolCents = (r.items || []).filter((i) => TOOL_ITEM.test(i.desc)).reduce((a, i) => a + i.cents, 0);
    if (total > 0 && toolCents / total >= 0.6) return 'tools_small_equipment';
    return 'materials';
  }

  // ── matching ─────────────────────────────────────────────────────────
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const CUST_RE = /\b([A-Z]{2,5}-\d{3,5}(?:-[A-Z0-9]{4})?)\b/i;

  function leadLabel(l) {
    const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || '';
    const a = String(l.address || '').split(',')[0];
    return (l.customerId ? l.customerId + ' · ' : '') + (n || a || 'Untitled') + (n && a ? ' — ' + a : '');
  }

  // Returns { status, leadId, reason, candidates[] }.
  //   status: 'code' | 'alias' | 'overhead' | 'suggested' | 'ambiguous' | 'none'
  function matchJob(jobName, leads, aliases) {
    const raw = String(jobName || '').trim();
    const live = (leads || []).filter((l) => l && l.id && !l.deleted);
    if (!raw) return { status: 'none', leadId: null, reason: 'No PO/Job name on the receipt', candidates: [] };
    const code = CUST_RE.exec(raw);
    if (code) {
      const hit = live.find((l) => String(l.customerId || '').toUpperCase() === code[1].toUpperCase());
      if (hit) return { status: 'code', leadId: hit.id, reason: 'Customer # ' + code[1].toUpperCase(), candidates: [hit.id] };
    }
    const k = key(raw);
    const aliasId = aliases && aliases[k];
    if (aliasId && live.some((l) => l.id === aliasId)) return { status: 'alias', leadId: aliasId, reason: 'Remembered: "' + raw + '"', candidates: [aliasId] };
    // A tool buy ("SCOTT TOOLS", "M18 8 Tool Combo…") is overhead wherever the
    // tool word sits — the first real-data pass matched "SCOTT TOOLS" to a
    // lead named Scott.
    if (OVERHEAD_WORDS.test(raw) || TOOL_ITEM.test(raw)) return { status: 'overhead', leadId: null, reason: 'Shop / tools — no job', candidates: [] };

    // Score leads by name / address. Strong: full name, or the street (house
    // number + street, or the street name alone — "victory ave", "fisher ln").
    // Medium: last name. Weak: first name. Street words match on their first
    // 4 letters so a typo ("Meuller" / "Mueller") still lands.
    const SUFFIX = /^(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|way|pl|place|pkwy|ter|trl|hwy|us|sr)$/;
    const sig = (arr) => arr.filter((w) => w && !/^\d+$/.test(w) && !SUFFIX.test(w) && w.length >= 3);
    const near = (a, b) => a.slice(0, 4) === b.slice(0, 4);
    const words = k.split(' ').filter(Boolean);
    const jobNum = words.find((w) => /^\d+$/.test(w)) || '';
    const jobSig = sig(words);
    const scored = [];
    live.forEach((l) => {
      const first = key(l.firstName), last = key(l.lastName);
      const full = key((l.firstName || '') + ' ' + (l.lastName || ''));
      const street = key(String(l.address || '').split(',')[0]);
      let s = 0;
      if (full && (k === full || k.includes(full))) s = Math.max(s, 90);
      // "Rita Hatley" for "Rita Hatley Jr", "Dealroom Homeowner"-style partials:
      // two or more job-name words that all appear in the full name.
      else if (full && words.length >= 2 && words.every((w) => full.split(' ').includes(w))) s = Math.max(s, 80);
      if (street) {
        const sw = street.split(' ');
        const stNum = /^\d+$/.test(sw[0]) ? sw[0] : '';
        const stSig = sig(sw);
        const allNear = jobSig.length > 0 && jobSig.every((w) => stSig.some((x) => near(w, x)));
        if (k === street) s = Math.max(s, 95);
        else if (allNear && jobNum && jobNum === stNum) s = Math.max(s, 88);
        else if (allNear && !jobNum) s = Math.max(s, 70);
        else if (jobNum && jobNum === stNum && words.length === 1) s = Math.max(s, 50);
      }
      if (last && last.length >= 3 && words.includes(last)) s = Math.max(s, 60);
      if (first && first.length >= 3 && (k === first || words[0] === first)) s = Math.max(s, 40);
      if (s) scored.push({ id: l.id, s, t: l.updatedAt || l.createdAt || 0 });
    });
    if (!scored.length) return { status: 'none', leadId: null, reason: 'No job matches "' + raw + '"', candidates: [] };
    scored.sort((a, b) => b.s - a.s);
    const best = scored[0].s;
    const top = scored.filter((x) => x.s === best);
    if (top.length === 1 && best >= 40) return { status: 'suggested', leadId: top[0].id, reason: 'Looks like this job (name/address)', candidates: scored.slice(0, 5).map((x) => x.id) };
    return { status: 'ambiguous', leadId: null, reason: top.length + ' jobs match "' + raw + '" — pick one', candidates: top.slice(0, 8).map((x) => x.id) };
  }

  // Receipts ready for review: each gets a match + default category.
  function plan(summaryText, detailsText, leads, aliases, importedKeys) {
    const receipts = attachDetails(parseSummary(summaryText), detailsText ? parseDetails(detailsText) : []);
    const done = new Set(importedKeys || []);
    return receipts.map((r) => {
      const m = matchJob(r.jobName, leads, aliases);
      const already = done.has(r.key);
      return Object.assign(r, {
        match: m,
        leadId: m.leadId,
        category: suggestCategory(r),
        already,
        include: !already,
      });
    }).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  // The expense document for one reviewed receipt (same shape as
  // expenses.js createExpense, plus the import provenance fields).
  function expenseDoc(r, ctx) {
    const cfg = window.ExpenseConfig;
    const costType = cfg && typeof cfg.costTypeFor === 'function' ? cfg.costTypeFor(r.category) : (r.category === 'materials' ? 'direct' : 'overhead');
    const itemLine = r.items.slice(0, 6).map((i) => (i.qty ? i.qty + '× ' : '') + i.desc).join('; ');
    const note = ['Home Depot' + (r.storeName ? ' ' + r.storeName : '') + (r.store ? ' #' + r.store : ''),
      r.jobName ? 'PO/Job: ' + r.jobName : '', itemLine].filter(Boolean).join(' · ').slice(0, 500);
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
      itemCount: r.items.length,
      ocrConfidence: null,
      needsReview: false,
    };
  }

  // ── UI ───────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const BADGE = {
    code: ['Customer #', '#16a34a'], alias: ['Remembered', '#16a34a'], suggested: ['Suggested', '#d97706'],
    overhead: ['Overhead', '#3b82f6'], ambiguous: ['Pick a job', '#dc2626'], none: ['No match', '#dc2626'],
  };
  let _state = null; // { rows, summaryText, detailsText, aliases, onDone }

  function leadsList() { return (window._leads || []).filter((l) => l && !l.deleted); }

  async function loadAliases() {
    try {
      const uid = window._user && window._user.uid;
      if (!uid || !window.getDoc) return {};
      const snap = await window.getDoc(window.doc(window.db, 'userSettings', uid));
      const a = snap.exists() ? (snap.data() || {}).hdJobAliases : null;
      return (a && typeof a === 'object') ? a : {};
    } catch (e) { return {}; }
  }

  async function saveAliases(aliases) {
    try {
      const uid = window._user && window._user.uid;
      if (!uid || !window.setDoc) return;
      await window.setDoc(window.doc(window.db, 'userSettings', uid), { hdJobAliases: aliases }, { merge: true });
    } catch (e) { console.warn('[hd-import] could not save job-name memory', e && e.code); }
  }

  function importedKeys() {
    const list = (window.Expenses && typeof window.Expenses.list === 'function') ? window.Expenses.list() : [];
    return list.filter((e) => e && e.externalRef).map((e) => e.externalRef);
  }

  function modalEl() {
    let m = document.getElementById('hdImportModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'hdImportModal';
      // Own class, not .modal-bg: dashboard-app.css hides .modal-bg (opacity 0 /
      // visibility hidden) until .open, which this self-rendered overlay
      // doesn't use.
      m.className = 'hd-import-overlay';
      m.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.7);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 12px;';
      document.body.appendChild(m);
    }
    return m;
  }

  function open() {
    _state = { rows: [], summaryText: '', detailsText: '', aliases: {} };
    renderPick();
  }
  function close() { const m = document.getElementById('hdImportModal'); if (m) m.remove(); _state = null; }

  function shell(inner) {
    return '<div style="background:var(--s,#12223D);border:1px solid var(--br,#2a2f37);border-radius:12px;width:100%;max-width:1100px;padding:18px;color:var(--t,#fff);">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
      '<h3 style="margin:0;font-family:\'Barlow Condensed\',sans-serif;font-size:22px;">🧡 Import Home Depot purchases</h3>' +
      '<button type="button" data-hd-action="close" class="modal-close" title="Close">✕</button></div>' + inner + '</div>';
  }

  function renderPick() {
    modalEl().innerHTML = shell(
      '<ol style="font-size:13px;color:var(--m,#9ca3af);line-height:1.6;margin:0 0 12px 18px;padding:0;">' +
      '<li>Home Depot › Purchase History › <b>Export</b> › <b>Summary Data</b> (and optionally <b>Details Data</b> for item lists).</li>' +
      '<li>Choose the file(s) below — nothing is saved until you review and press Import.</li></ol>' +
      '<label style="display:block;font-size:12px;margin:8px 0 4px;">Summary CSV (required)</label>' +
      '<input type="file" accept=".csv,text/csv" data-hd-file="summary">' +
      '<label style="display:block;font-size:12px;margin:12px 0 4px;">Details CSV (optional — adds item lists &amp; spots tool buys)</label>' +
      '<input type="file" accept=".csv,text/csv" data-hd-file="details">' +
      '<div data-hd-msg style="font-size:12px;color:var(--m,#9ca3af);margin-top:10px;"></div>' +
      '<button type="button" class="btn btn-orange" data-hd-action="review" style="margin-top:14px;">Review purchases →</button>');
  }

  function renderReview() {
    const leads = leadsList();
    const byId = {};
    leads.forEach((l) => { byId[l.id] = l; });
    const catOpts = (sel) => ((window.ExpenseConfig && window.ExpenseConfig.CATEGORIES) || [])
      .map((c) => '<option value="' + esc(c.key) + '"' + (c.key === sel ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('');
    const leadOpts = (r) => {
      const first = (r.match.candidates || []).filter((id) => byId[id]);
      const rest = leads.filter((l) => first.indexOf(l.id) === -1).slice(0, 400);
      const opt = (l) => '<option value="' + esc(l.id) + '"' + (l.id === r.leadId ? ' selected' : '') + '>' + esc(leadLabel(l)) + '</option>';
      return '<option value="">— No job (overhead / shop) —</option>' +
        (first.length ? '<optgroup label="Best matches">' + first.map((id) => opt(byId[id])).join('') + '</optgroup>' : '') +
        '<optgroup label="All jobs">' + rest.map(opt).join('') + '</optgroup>';
    };
    const rows = _state.rows;
    const todo = rows.filter((r) => !r.already);
    const total = todo.filter((r) => r.include).reduce((a, r) => a + r.totalCents, 0);
    const body = rows.map((r, i) => {
      const b = r.already ? ['Imported', '#6b7280'] : BADGE[r.match.status];
      return '<tr style="border-top:1px solid var(--br,#2a2f37);' + (r.already ? 'opacity:.5;' : '') + '">' +
        '<td><input type="checkbox" data-hd-inc="' + i + '"' + (r.include ? ' checked' : '') + (r.already ? ' disabled' : '') + '></td>' +
        '<td style="white-space:nowrap;">' + esc(r.date) + '<div style="font-size:10px;color:var(--m);">' + esc(r.storeName || ('#' + r.store)) + '</div></td>' +
        '<td><b>' + esc(r.jobName || '—') + '</b><div style="font-size:10px;color:' + b[1] + ';">' + esc(b[0]) + ' · ' + esc(r.already ? 'already in your expenses' : r.match.reason) + '</div>' +
        (r.items.length ? '<div style="font-size:10px;color:var(--m);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(r.items.map((x) => x.desc).join('; ')) + '</div>' : '') + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' + money(r.totalCents) + '<div style="font-size:10px;color:var(--m);">tax ' + money(r.taxCents) + '</div></td>' +
        '<td><select data-hd-lead="' + i + '" style="max-width:260px;"' + (r.already ? ' disabled' : '') + '>' + leadOpts(r) + '</select></td>' +
        '<td><select data-hd-cat="' + i + '"' + (r.already ? ' disabled' : '') + '>' + catOpts(r.category) + '</select></td>' +
        '</tr>';
    }).join('');
    modalEl().innerHTML = shell(
      '<div style="font-size:12px;color:var(--m,#9ca3af);margin-bottom:8px;">' + rows.length + ' receipts · ' + (rows.length - todo.length) + ' already imported · ' +
      'green = matched by customer # or a name you assigned before · amber = suggested, check it · red = pick the job. ' +
      'Job names you assign are remembered for next time.</div>' +
      '<div style="overflow:auto;max-height:60vh;"><table style="width:100%;border-collapse:collapse;font-size:12px;">' +
      '<thead><tr style="text-align:left;color:var(--m);"><th></th><th>Date</th><th>PO / Job name</th><th style="text-align:right;">Total</th><th>Job</th><th>Category</th></tr></thead>' +
      '<tbody>' + body + '</tbody></table></div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:14px;gap:10px;flex-wrap:wrap;">' +
      '<div data-hd-msg style="font-size:12px;color:var(--m);">' + todo.filter((r) => r.include).length + ' to import · ' + money(total) + '</div>' +
      '<button type="button" class="btn btn-orange" data-hd-action="import">Import selected</button></div>');
  }

  async function readFile(input) {
    const f = input && input.files && input.files[0];
    if (!f) return '';
    return f.text();
  }

  async function review() {
    const m = modalEl();
    const msg = m.querySelector('[data-hd-msg]');
    const sTxt = await readFile(m.querySelector('[data-hd-file="summary"]'));
    const dTxt = await readFile(m.querySelector('[data-hd-file="details"]'));
    // Either file may have been picked into either box — sort them by content.
    const files = [sTxt, dTxt].filter(Boolean);
    const summaryText = files.find((t) => kindOf(t) === 'summary') || '';
    const detailsText = files.find((t) => kindOf(t) === 'details') || '';
    if (!summaryText) { if (msg) msg.textContent = 'Choose the Summary Data CSV from Home Depot (it has "Total Amount Paid").'; return; }
    _state.summaryText = summaryText;
    _state.detailsText = detailsText;
    _state.aliases = await loadAliases();
    _state.rows = plan(summaryText, detailsText, leadsList(), _state.aliases, importedKeys());
    if (!_state.rows.length) { if (msg) msg.textContent = 'No purchases found in that file.'; return; }
    renderReview();
  }

  async function doImport(btn) {
    const uid = window._user && window._user.uid;
    const claims = window._userClaims || {};
    if (!uid || !window.addDoc) { if (window.showToast) window.showToast('Not signed in', 'error'); return; }
    const ctx = { uid, companyId: claims.companyId || uid };
    const todo = _state.rows.filter((r) => r.include && !r.already);
    if (!todo.length) { if (window.showToast) window.showToast('Nothing selected to import', 'info'); return; }
    btn.disabled = true;
    let ok = 0, fail = 0;
    const aliases = Object.assign({}, _state.aliases);
    for (const r of todo) {
      try {
        const d = expenseDoc(r, ctx);
        d.createdAt = window.serverTimestamp();
        d.createdBy = uid;
        d.updatedAt = window.serverTimestamp();
        await window.addDoc(window.collection(window.db, 'expenses'), d);
        ok++;
        r.already = true;
        // Remember the job name → job, unless it's a customer # (already exact)
        // or an overhead word.
        const k = key(r.jobName);
        if (k && r.leadId && !CUST_RE.test(r.jobName) && !OVERHEAD_WORDS.test(r.jobName)) aliases[k] = r.leadId;
      } catch (e) { fail++; console.warn('[hd-import] save failed', r.key, e && e.code); }
    }
    await saveAliases(aliases);
    _state.aliases = aliases;
    if (window.showToast) window.showToast('Imported ' + ok + ' Home Depot purchase' + (ok === 1 ? '' : 's') + (fail ? ' · ' + fail + ' failed' : ''), fail ? 'error' : 'ok');
    if (window.Expenses && typeof window.Expenses.refresh === 'function') window.Expenses.refresh();
    close();
  }

  if (!window._NBD_HD_DELEGATE) {
    window._NBD_HD_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-hd-action]');
      if (!t) return;
      const a = t.dataset.hdAction;
      if (a === 'open') open();
      else if (a === 'close') close();
      else if (a === 'review') review();
      else if (a === 'import') doImport(t);
    });
    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!_state || !el || !el.dataset) return;
      if (el.dataset.hdInc != null) { _state.rows[+el.dataset.hdInc].include = !!el.checked; renderReview(); }
      else if (el.dataset.hdLead != null) { const r = _state.rows[+el.dataset.hdLead]; r.leadId = el.value || null; }
      else if (el.dataset.hdCat != null) { _state.rows[+el.dataset.hdCat].category = el.value; }
    });
  }

  window.NBDHdImport = {
    open, close,
    // pure — exported for tests
    parseCsv, kindOf, parseSummary, parseDetails, attachDetails, suggestCategory, matchJob, plan, expenseDoc, receiptKey,
    SOURCE,
  };
})();
