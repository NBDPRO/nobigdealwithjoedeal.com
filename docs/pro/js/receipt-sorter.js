/**
 * receipt-sorter.js — the receipt review queue (2026-10-18).
 *
 * Jo: sort the Home Depot / Lowe's purchases that could not be matched to a job
 * on their own. One card at a time, thumb-sized, in the CRM (Expenses ›
 * "Sort receipts"). Each card shows what the receipt says (PO/job name FIRST,
 * store #, date, total, what was bought) and the three most likely jobs with a
 * plain-language "why". One tap: Assign / Overhead / Skip, and Undo for the
 * last one.
 *
 * Flag `receiptSorterQueue` (feature_flags/_default, absent = off). Off = the
 * button never renders and this file does nothing. The queue only ever writes
 * the sort result onto the expense (leadId, jobId, reviewState, costType,
 * matchEvidence, sortedBy/At). Remembered job names are saved ONCE when the
 * sheet closes, and only for assignments that were not undone — a remembered
 * name is later treated as an exact match, so a wrong, undone tap must never
 * leave one behind.
 *
 * Matching lives in receipt-sorter-logic.js (pure, unit-tested).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'receiptSorterQueue';
  const LG = () => w.NBDReceiptSorterLogic;

  let S = null; // { ids[], i, byId{}, leads[], aliases{}, learned{}, history[], skipped{}, siblings{} }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };

  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }

  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function dateKey(v) {
    const d = toDate(v);
    if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function prettyDate(k) {
    if (!k) return 'no date';
    const d = new Date(k + 'T12:00:00');
    return isNaN(d.getTime()) ? k : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Expense doc → what the logic and the card need.
  function view(e) {
    return {
      id: e.id,
      poJobName: String(e.poJobName || '').trim(),
      storeNumber: String(e.storeNumber || ''),
      dateKey: dateKey(e.date),
      items: Array.isArray(e.items) ? e.items : [],
      note: String(e.note || ''),
      category: e.category || '',
      supplier: e.supplier || '',
      totalCents: (Number(e.amountCents) || 0) + (Number(e.taxCents) || 0),
      raw: e,
    };
  }

  function activeLeads() { return (w._leads || []).filter((l) => l && l.id && !l.deleted); }
  function leadName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Untitled'; }
  function leadLine(l) {
    const a = String(l.address || '').split(',')[0];
    return (l.customerId ? l.customerId + ' · ' : '') + leadName(l) + (a && a !== leadName(l) ? ' — ' + a : '');
  }

  function list() { return (w.Expenses && typeof w.Expenses.list === 'function') ? w.Expenses.list() : []; }
  function pending() { const LGC = LG(); return LGC ? list().filter(LGC.needsSorting) : []; }

  function buttonHtml() {
    if (!enabled() || !LG()) return '';
    const n = pending().length;
    return '<button type="button" class="btn btn-ghost" data-rs-action="open" title="Sort the receipts that have no job yet">🧾 Sort receipts' + (n ? ' (' + n + ')' : '') + '</button>';
  }

  async function open() {
    if (!enabled() || !LG()) return;
    const items = pending();
    if (!items.length) { toast('Nothing to sort. Every receipt has a job or is overhead.', 'ok'); return; }
    let aliases = {};
    try { if (w.NBDHdImport && typeof w.NBDHdImport.loadAliases === 'function') aliases = await w.NBDHdImport.loadAliases(); } catch (e) { aliases = {}; }
    const byId = {};
    const all = list();
    all.forEach((e) => { byId[e.id] = view(e); });
    S = {
      ids: items.map((e) => e.id).sort((a, b) => (byId[a].dateKey < byId[b].dateKey ? 1 : -1)),
      i: 0, byId, leads: activeLeads(), aliases, learned: {}, history: [], skipped: {},
      siblings: LG().buildSiblings(all.map((e) => Object.assign({}, e, { dateKey: dateKey(e.date) }))),
      total: items.length, done: 0,
    };
    render();
  }

  function overlay() {
    let m = document.getElementById('rsOverlay');
    if (!m) { m = document.createElement('div'); m.id = 'rsOverlay'; m.className = 'rs-overlay'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); document.body.appendChild(m); }
    return m;
  }

  function cur() {
    if (!S) return null;
    for (let k = S.i; k < S.ids.length; k++) { if (!S.skipped[S.ids[k]]) { S.i = k; return S.byId[S.ids[k]]; } }
    return null;
  }

  function candidatesFor(r) {
    return LG().rank(r, S.leads, { aliases: Object.assign({}, S.aliases, S.learned), siblings: S.siblings });
  }

  function itemsHtml(r) {
    if (!r.items.length) return '<div class="rs-note">' + (r.note ? esc(r.note) : 'No item list on this receipt.') + '</div>';
    const rows = r.items.slice(0, 8).map((i) => '<li><span class="rs-q">' + esc(i.qty > 0 ? i.qty + '×' : '') + '</span> ' + esc(i.desc) + '</li>').join('');
    return '<ul class="rs-items">' + rows + (r.items.length > 8 ? '<li class="rs-more">+ ' + (r.items.length - 8) + ' more</li>' : '') + '</ul>';
  }

  function render() {
    const m = overlay();
    const r = cur();
    if (!r) { finish(); return; }
    const rank = candidatesFor(r);
    const left = S.ids.slice(S.i).filter((id) => !S.skipped[id]).length;
    const cands = rank.candidates.map((c) => {
      const lead = S.leads.find((l) => l.id === c.leadId);
      if (!lead) return '';
      const tag = c.level === 'high' ? '<span class="rs-tag rs-tag-hi">Exact match</span>' : '<span class="rs-tag">' + (c.score >= 55 ? 'Good match' : c.score >= 30 ? 'Possible' : 'Weak') + '</span>';
      return '<div class="rs-cand"><div class="rs-cand-top"><div class="rs-cand-name">' + esc(leadLine(lead)) + '</div>' + tag + '</div>' +
        '<ul class="rs-why">' + c.evidence.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
        '<button type="button" class="rs-btn rs-btn-primary" data-rs-action="assign" data-rs-lead="' + esc(c.leadId) + '">Assign to this job</button></div>';
    }).join('');
    const closeCall = rank.closeCall ? '<div class="rs-warn">Close call. These are about equally likely, so check before you tap.</div>' : '';
    const opts = '<option value="">Pick another job…</option>' + S.leads.slice().sort((a, b) => leadName(a).localeCompare(leadName(b)))
      .map((l) => '<option value="' + esc(l.id) + '">' + esc(leadLine(l)) + '</option>').join('');
    m.innerHTML = '<div class="rs-sheet">' +
      '<div class="rs-head"><div class="rs-count">' + left + ' left · ' + S.done + ' sorted</div>' +
      '<button type="button" class="rs-x" data-rs-action="close" aria-label="Close">✕</button></div>' +
      '<div class="rs-card">' +
        '<div class="rs-po-label">PO / Job name</div><div class="rs-po">' + (r.poJobName ? esc(r.poJobName) : '<span class="rs-none">(blank)</span>') + '</div>' +
        '<div class="rs-meta"><span>' + esc(r.supplier || 'Store') + (r.storeNumber ? ' #' + esc(r.storeNumber) : '') + '</span><span>' + esc(prettyDate(r.dateKey)) + '</span><span class="rs-total">' + money(r.totalCents) + '</span></div>' +
        itemsHtml(r) +
      '</div>' + closeCall +
      (cands || '<div class="rs-empty">No job stands out. The PO name, store and date are not enough on their own.</div>') +
      '<div class="rs-pick"><select data-rs-pick aria-label="Pick another job">' + opts + '</select></div>' +
      '<div class="rs-actions">' +
        '<button type="button" class="rs-btn' + (rank.overhead.hint ? ' rs-btn-primary' : '') + '" data-rs-action="overhead">Overhead / shop' + (rank.overhead.hint ? ' <small>(' + esc(rank.overhead.why) + ')</small>' : '') + '</button>' +
        '<button type="button" class="rs-btn" data-rs-action="skip">Skip for now</button>' +
        '<button type="button" class="rs-btn" data-rs-action="undo"' + (S.history.length ? '' : ' disabled') + '>Undo last</button>' +
      '</div></div>';
  }

  function stamp(patch) {
    patch.sortedBy = (w._user && w._user.uid) || null;
    patch.sortedAt = w.serverTimestamp ? w.serverTimestamp() : new Date();
    patch.updatedAt = w.serverTimestamp ? w.serverTimestamp() : new Date();
    return patch;
  }

  // the in-memory copy never holds server-timestamp placeholders
  function local(patch) { const o = Object.assign({}, patch); delete o.sortedAt; delete o.updatedAt; delete o.sortedBy; return o; }

  async function write(id, patch) {
    if (!w.updateDoc || !w.doc || !w.db) { toast('Not connected. Try again.', 'error'); return false; }
    try { await w.updateDoc(w.doc(w.db, 'expenses', id), patch); return true; }
    catch (e) { console.warn('[receipt-sorter] save failed', id, e && e.code); toast('Could not save that one. Nothing changed.', 'error'); return false; }
  }

  function remember(r, leadId) {
    const po = r.poJobName;
    const key = LG().norm(po);
    const code = LG().parsePo(po);
    if (!key || code.code || code.shop) return null;
    return key;
  }

  async function assign(leadId) {
    const r = cur(); if (!r || !leadId) return;
    const lead = S.leads.find((l) => l.id === leadId); if (!lead) return;
    const rank = candidatesFor(r);
    const cand = rank.candidates.find((c) => c.leadId === leadId);
    const prev = { leadId: r.raw.leadId || null, jobId: r.raw.jobId || null, reviewState: r.raw.reviewState || null, costType: r.raw.costType || null, matchEvidence: r.raw.matchEvidence || [] };
    const jobId = typeof lead.activeJobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(lead.activeJobId) ? lead.activeJobId : null;
    const patch = stamp({ leadId, jobId, reviewState: 'assigned', matchEvidence: cand ? cand.evidence.slice(0, 5) : ['Picked by hand'] });
    if (r.raw.category && r.raw.category !== 'tools_small_equipment') patch.costType = 'direct';
    if (!(await write(r.id, patch))) return;
    const k = remember(r, leadId);
    const hadLearned = k ? S.learned[k] : undefined;
    if (k) S.learned[k] = leadId;
    S.history.push({ id: r.id, prev, key: k, hadLearned, was: Object.assign({}, r.raw) });
    Object.assign(r.raw, local(patch));
    S.done++; S.i++;
    render();
  }

  async function overhead() {
    const r = cur(); if (!r) return;
    const prev = { leadId: r.raw.leadId || null, jobId: r.raw.jobId || null, reviewState: r.raw.reviewState || null, costType: r.raw.costType || null, matchEvidence: r.raw.matchEvidence || [] };
    const patch = stamp({ leadId: null, jobId: null, reviewState: 'overhead', costType: 'overhead', matchEvidence: ['Marked overhead / shop by hand'] });
    if (!(await write(r.id, patch))) return;
    S.history.push({ id: r.id, prev, key: null });
    Object.assign(r.raw, local(patch));
    S.done++; S.i++;
    render();
  }

  function skip() { const r = cur(); if (!r) return; S.skipped[r.id] = true; S.i++; render(); }

  async function undo() {
    const h = S && S.history.pop(); if (!h) return;
    const patch = stamp(Object.assign({}, h.prev));
    if (!patch.reviewState) patch.reviewState = 'unsorted';
    if (!(await write(h.id, patch))) { S.history.push(h); return; }
    if (h.key) { if (h.hadLearned === undefined) delete S.learned[h.key]; else S.learned[h.key] = h.hadLearned; }
    Object.assign(S.byId[h.id].raw, local(patch));
    delete S.skipped[h.id];
    S.done = Math.max(0, S.done - 1);
    S.i = Math.max(0, S.ids.indexOf(h.id));
    render();
  }

  async function saveLearned() {
    const keys = S ? Object.keys(S.learned) : [];
    if (!keys.length || !w.NBDHdImport || typeof w.NBDHdImport.saveAliases !== 'function') return;
    try { await w.NBDHdImport.saveAliases(Object.assign({}, S.aliases, S.learned)); } catch (e) { console.warn('[receipt-sorter] could not remember job names'); }
  }

  async function finish() {
    await saveLearned();
    const done = S ? S.done : 0;
    const m = document.getElementById('rsOverlay'); if (m) m.remove();
    S = null;
    toast(done ? 'Sorted ' + done + ' receipt' + (done === 1 ? '' : 's') : 'Closed', 'ok');
    if (w.Expenses && typeof w.Expenses.refresh === 'function') w.Expenses.refresh();
  }

  if (!w._NBD_RS_DELEGATE) {
    w._NBD_RS_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest && ev.target.closest('[data-rs-action]');
      if (!t || t.disabled) return;
      const a = t.dataset.rsAction;
      if (a === 'open') open();
      else if (a === 'close') finish();
      else if (a === 'assign') assign(t.dataset.rsLead);
      else if (a === 'overhead') overhead();
      else if (a === 'skip') skip();
      else if (a === 'undo') undo();
    });
    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (el && el.matches && el.matches('[data-rs-pick]') && el.value) assign(el.value);
    });
  }

  w.NBDReceiptSorter = { enabled, open, buttonHtml, view, dateKey };
})();
