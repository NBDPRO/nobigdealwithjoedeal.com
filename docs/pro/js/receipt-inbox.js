/**
 * receipt-inbox.js — the Receipt inbox screen (2026-11-04, phase 1, flag `receiptInbox`).
 *
 * Jo: photograph or upload a receipt inside the CRM, the reader fills a DRAFT, and you approve
 * ONE ROW AT A TIME. This screen:
 *   - uploads a phone photo / PDF to receipts/{uid}/inbox/ and asks the server to read it
 *     (submitInboxReceipt); shows "AI reading used this month: $x of $10"
 *   - lists the drafts waiting (receipt_inbox, filed by the server, never by this page)
 *   - shows ONE approval card: the picture, what was read (quoted), warnings in colour,
 *     a "looks like an existing cost" box, the three most likely jobs with why (the existing
 *     receipt sorter ranking), a plain-language money line, and the buttons
 *   - Approve and add: creates exactly ONE expense through Expenses.createExpense, then marks
 *     that draft approved. Nothing touches any total before that tap.
 *   - Skip, Not a business receipt (deletes the picture), Undo a skip.
 *
 * There is NO approve-all and NO auto-approve at any confidence: Approve is disabled until a
 * person has picked a job, Overhead or Park as unsorted for THIS receipt, and the only code path
 * to a write is the click on that one button. A draft is never preselected to a job unless
 * the PO text carries an exact customer number (the sorter's HIGH level), and even then the
 * person taps.
 *
 * Flag `receiptInbox` (feature_flags/{uid} or _default, absent = off). Off = the button never
 * renders and this file does nothing. All text from a document is rendered as text (esc()),
 * never as markup. Pure logic lives in receipt-inbox-logic.js (unit-tested, mirrored with the
 * server). External file: no inline script, no inline style.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'receiptInbox';
  const CREDITS_FLAG = 'costCredits';
  const PAID_FLAG = 'costsPaidFrom';
  const STORAGE_SDK = '/assets/vendor/firebase/10.12.2/firebase-storage.js';
  const MAX_BYTES = 25 * 1024 * 1024;
  const LG = () => w.NBDReceiptInboxLogic;

  let S = null;            // the open sheet's state, null when closed
  let _callable = null;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const flagOn = (n) => !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(n));
  const usd = (c) => (LG() ? LG().inboxUsd(c) : '$' + ((c || 0) / 100).toFixed(2));
  const uid = () => (w._user && w._user.uid) || null;

  function enabled() { return flagOn(FLAG) && !!LG() && !!w.Expenses; }

  function toMs(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) return v.getTime();
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  function prettyDate(k) {
    if (!k) return 'no date';
    const d = new Date(k + 'T12:00:00');
    return isNaN(d.getTime()) ? String(k) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function monthDay(k) {
    const d = new Date(k + 'T12:00:00');
    return isNaN(d.getTime()) ? String(k || '') : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  const centsToStr = (c) => (typeof c === 'number' && c > 0 ? (c / 100).toFixed(2) : '');
  function centsOf(str) {
    const p = LG().inboxParseMoney(String(str == null ? '' : str));
    return p && !p.negative ? p.cents : 0;
  }

  function leadName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Untitled'; }
  function leadLine(l) {
    const a = String(l.address || '').split(',')[0];
    return (l.customerId ? l.customerId + ' · ' : '') + leadName(l) + (a && a !== leadName(l) ? ' — ' + a : '');
  }
  const activeLeads = () => (w._leads || []).filter((l) => l && l.id && !l.deleted);
  const expensesList = () => (w.Expenses && typeof w.Expenses.list === 'function' ? w.Expenses.list() : []);

  // ── data ────────────────────────────────────────────────────────────
  async function loadDrafts() {
    if (!w.db || !uid() || !w.getDocs || !w.query || !w.collection || !w.where || !w.orderBy || !w.limit) return [];
    try {
      const q = w.query(w.collection(w.db, 'receipt_inbox'), w.where('ownerUid', '==', uid()), w.orderBy('receivedAt', 'desc'), w.limit(60));
      const snap = await w.getDocs(q);
      const out = [];
      snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
      return out;
    } catch (e) {
      console.warn('[receipt-inbox] could not load drafts', e && e.code);
      toast('Could not load the receipt inbox. Try again.', 'error');
      return [];
    }
  }
  async function loadSpend() {
    const cap = LG().INBOX_MONTHLY_USD_CAP;
    const out = { spentUsd: 0, capUsd: cap };
    if (!w.db || !uid() || !w.getDoc || !w.doc) return out;
    try {
      const s = await w.getDoc(w.doc(w.db, 'userCostMeter', uid() + '__' + LG().inboxMonthKey(Date.now())));
      if (s.exists()) out.spentUsd = Number((s.data() || {}).inboxUsd) || 0;
    } catch (e) { /* the meter is a nicety; the server enforces the cap either way */ }
    return out;
  }
  async function refreshAll() {
    if (!S) return;
    const [drafts, spend] = await Promise.all([loadDrafts(), loadSpend()]);
    S.drafts = drafts;
    S.spend = Object.assign({}, S.spend, spend);
    render();
  }
  async function ensureCallable() {
    if (_callable) return _callable;
    if (w._httpsCallable && w._functions) { _callable = w._httpsCallable(w._functions, 'submitInboxReceipt'); return _callable; }
    const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
    w._functions = w._functions || mod.getFunctions();
    w._httpsCallable = mod.httpsCallable;
    _callable = mod.httpsCallable(w._functions, 'submitInboxReceipt');
    return _callable;
  }
  async function deleteFile(path) {
    if (!path || !w.storage) return false;
    try {
      const st = w.deleteObject ? { deleteObject: w.deleteObject, ref: w.ref } : await import(STORAGE_SDK);
      await st.deleteObject(st.ref(w.storage, path));
      return true;
    } catch (e) { return !!(e && /object-not-found/.test(e.code || '')); }
  }

  // ── upload + read ───────────────────────────────────────────────────
  const REASONS = {
    'dry-run': 'The receipt inbox is switched off on the server, so nothing was read.',
    paused: 'The receipt inbox is paused for your company, so nothing was read.',
    'inbox-cap': 'The inbox AI limit for this month is reached, so nothing was read.',
    'unsupported-format': 'That picture format cannot be read. Try a JPEG, PNG or PDF.',
    'ocr-unavailable': 'The reader is busy right now. Try again in a minute.',
  };
  function fileOk(f) {
    if (!f) return 'No file.';
    const t = f.type || '';
    if (!/^image\//.test(t) && t !== 'application/pdf') return 'Only pictures and PDFs can go in the inbox.';
    if (f.size > MAX_BYTES) return 'That file is over the 25 MB limit.';
    return '';
  }
  async function uploadOne(f) {
    if (!w.storage || !w.ref || !w.uploadBytes || !uid()) throw new Error('storage unavailable');
    const safe = (f.name || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const path = 'receipts/' + uid() + '/inbox/' + Date.now() + '_' + safe;
    await w.uploadBytes(w.ref(w.storage, path), f, { contentType: f.type || 'application/octet-stream' });
    return path;
  }
  async function handleFiles(files) {
    if (!S || S.uploading) return;
    const list = Array.prototype.slice.call(files || []).slice(0, 10);
    if (!list.length) return;
    S.uploading = true; S.notice = '';
    let read = 0, waiting = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const bad = fileOk(f);
      if (bad) { toast(bad, 'error'); continue; }
      S.notice = 'Reading ' + (i + 1) + ' of ' + list.length + '…';
      render();
      let path = null;
      try {
        path = await uploadOne(f);
        const call = await ensureCallable();
        const res = await call({ storagePath: path });
        const d = (res && res.data) || {};
        if (typeof d.spentUsd === 'number') S.spend = { spentUsd: d.spentUsd, capUsd: typeof d.capUsd === 'number' ? d.capUsd : S.spend.capUsd };
        if (d.skipped) {
          toast(REASONS[d.reason] || 'That receipt was not read.', d.reason === 'inbox-cap' ? 'warn' : 'info');
          await deleteFile(path);           // nothing was read, so nothing is kept
          if (d.reason === 'inbox-cap' || d.reason === 'dry-run' || d.reason === 'paused') break;
          continue;
        }
        if (d.existing) toast('That receipt is already in the inbox.', 'info');
        else if (d.status === 'not_business') { read++; toast('That one is not a business receipt. It was dropped and the picture deleted.', 'info'); }
        else if (d.status === 'failed') toast('That picture could not be read. Try a clearer photo.', 'warn');
        else { read++; waiting++; }
      } catch (e) {
        console.warn('[receipt-inbox] upload/read failed', e && e.code);
        const code = String((e && e.code) || '');
        toast(/unavailable/.test(code) ? 'AI is switched off right now. Nothing was read.' : /resource-exhausted/.test(code) ? 'Too many at once. Wait a minute and try again.' : 'Could not read that receipt. Try again.', 'error');
        if (path && /unavailable|permission/.test(code)) await deleteFile(path);
      }
    }
    S.uploading = false; S.notice = read ? read + ' read. Review each one below; nothing is added until you tap Approve.' : '';
    await refreshAll();
  }
  async function retryDraft(id) {
    const d = S && S.drafts.find((x) => x.id === id);
    if (!d || !d.storagePath || S.busy) return;
    S.busy = true; render();
    try {
      const call = await ensureCallable();
      const res = await call({ storagePath: d.storagePath });
      const r = (res && res.data) || {};
      if (r.skipped) toast(REASONS[r.reason] || 'Not read.', 'info');
    } catch (e) { toast('Could not read it. Try again.', 'error'); }
    S.busy = false;
    await refreshAll();
  }

  // ── the card ────────────────────────────────────────────────────────
  function startChoice(d) {
    const read = d.read || {};
    const rel = read.isCredit ? LG().findRelatedCostCandidates(read, expensesList(), {}) : { preselectId: null };
    return {
      vendor: read.vendor || '', date: read.date || '', total: centsToStr(read.totalCents), tax: centsToStr(read.taxCents),
      totalEdited: false, taxEdited: false,
      category: read.suggestedCategory || 'materials', paidFrom: d.suggestedPaidFrom || '', note: '',
      sort: '', leadId: '', relatedExpenseId: rel.preselectId || '', dupOk: false,
    };
  }
  function openDraft(id) {
    const d = S && S.drafts.find((x) => x.id === id);
    if (!d) return;
    S.curId = id; S.choice = startChoice(d); S.confirmNB = false; S.imgUrl = '';
    render();
    loadImage(d);
  }
  async function loadImage(d) {
    if (!d || !d.storagePath || d.fileDeleted || !w.getDownloadURL || !w.ref || !w.storage) return;
    try {
      const url = await w.getDownloadURL(w.ref(w.storage, d.storagePath));
      if (!S || S.curId !== d.id) return;
      S.imgUrl = url;
      const img = document.getElementById('riImg');
      const a = document.getElementById('riPdf');
      if (img && !/pdf/i.test(d.mime || '')) img.src = url;
      if (a) { a.href = url; a.hidden = false; }
    } catch (e) { /* the picture is a help, not a gate */ }
  }

  function modelFor(d) {
    const L = LG();
    const read = d.read;
    const ch = S.choice;
    const out = { read, dups: [], rank: { candidates: [], notes: [], closeCall: false, high: null }, related: { candidates: [], preselectId: null }, warnings: [], m: null, blockers: [], line: '', lead: null };
    if (!read) return out;
    out.dups = L.findInboxDuplicates(read, expensesList());
    out.rank = L.rankInboxJobs(read, activeLeads(), { aliases: S.aliases || {}, siblings: {} });
    out.related = read.isCredit ? L.findRelatedCostCandidates(read, expensesList(), { leadId: ch.leadId }) : out.related;
    out.lead = ch.leadId ? activeLeads().find((l) => l.id === ch.leadId) || null : null;
    const jobInfo = out.lead ? { createdMs: toMs(out.lead.createdAt), finishedMs: toMs(out.lead.completedAt || out.lead.closedAt || out.lead.finishedAt) } : null;
    out.warnings = (Array.isArray(d.warnings) ? d.warnings : []).concat(jobInfo ? L.inboxJobDateWarnings(ch.date || read.date, jobInfo) : []);
    out.m = L.mapInboxDraftToForm(d, {
      sort: ch.sort || undefined, leadId: ch.leadId || undefined, category: ch.category, paidFrom: ch.paidFrom,
      vendor: ch.vendor, date: ch.date, note: ch.note,
      totalCents: ch.totalEdited || read.totalCents == null ? centsOf(ch.total) : undefined,
      taxCents: ch.taxEdited ? centsOf(ch.tax) : undefined,
      relatedExpenseId: ch.relatedExpenseId || undefined,
    }, { matchEvidence: ch.leadId && out.rank.candidates.find((c) => c.leadId === ch.leadId) ? out.rank.candidates.find((c) => c.leadId === ch.leadId).evidence : (ch.sort === 'assigned' ? ['Picked by hand'] : []) });
    if (!out.m.ok) out.blockers.push(out.m.error);
    if (read.isCredit && !flagOn(CREDITS_FLAG)) out.blockers.push('Credits are not turned on for your account, so this credit memo cannot be added. Skip it for now.');
    if (out.dups.length && !ch.dupOk) out.blockers.push('Tick "This is a different purchase" above, or skip this one.');
    if (flagOn(PAID_FLAG) && !read.isCredit && !ch.paidFrom) out.blockers.push('Pick how this was paid.');
    if (S.busy) out.blockers.push('Working…');
    if (out.m.ok) {
      const rel = read.isCredit && ch.relatedExpenseId ? expensesList().find((e) => e.id === ch.relatedExpenseId) : null;
      const relLabel = rel ? 'the ' + monthDay(LG().inboxDateKey(rel.date)) + ' ' + (rel.supplier || 'supplier') + ' cost of ' + usd((Number(rel.amountCents) || 0) + (Number(rel.taxCents) || 0)) : '';
      out.line = LG().inboxMoneyLine(out.m.form, { jobName: out.lead ? leadName(out.lead) : '', relatedLabel: relLabel });
    } else {
      out.line = 'Nothing will be added yet. ' + out.m.error;
    }
    return out;
  }

  const warnHtml = (list) => list.map((x) => '<div class="ri-warn ri-warn-' + (x.level === 'red' ? 'red' : 'amber') + '" role="alert">' + esc(x.text) + '</div>').join('');

  function jobSection(d, mdl) {
    const ch = S.choice;
    const leads = activeLeads();
    const cands = mdl.rank.candidates.map((c) => {
      const lead = leads.find((l) => l.id === c.leadId);
      if (!lead) return '';
      const tag = c.level === 'high' ? '<span class="ri-tag ri-tag-hi">Exact match</span>' : '<span class="ri-tag">' + (c.score >= 55 ? 'Good match' : c.score >= 30 ? 'Possible' : 'Weak') + '</span>';
      const on = ch.sort === 'assigned' && ch.leadId === c.leadId;
      return '<div class="ri-cand' + (on ? ' ri-cand-on' : '') + '"><div class="ri-cand-top"><div class="ri-cand-name">' + esc(leadLine(lead)) + '</div>' + tag + '</div>' +
        '<ul class="ri-why">' + c.evidence.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' +
        '<button type="button" class="ri-btn' + (on ? ' ri-btn-on' : '') + '" data-ri-action="pick-job" data-ri-lead="' + esc(c.leadId) + '"' + (on ? ' aria-pressed="true"' : ' aria-pressed="false"') + '>' + (on ? 'Chosen' : 'Use this job') + '</button></div>';
    }).join('');
    const opts = '<option value="">Pick another job…</option>' + leads.slice().sort((a, b) => leadName(a).localeCompare(leadName(b)))
      .map((l) => '<option value="' + esc(l.id) + '">' + esc(leadLine(l)) + '</option>').join('');
    const notes = mdl.rank.notes.map((n) => '<div class="ri-warn ri-warn-amber" role="alert">' + esc(n) + '</div>').join('') +
      (mdl.rank.closeCall ? '<div class="ri-warn ri-warn-amber" role="alert">Close call. These jobs are about equally likely, so check before you tap.</div>' : '');
    return '<div class="ri-sec"><div class="ri-lab">Which job is this for?</div>' + notes +
      (cands || '<div class="ri-empty">No job stands out. The PO text and ship-to address are not enough on their own.</div>') +
      '<div class="ri-pick"><select data-ri-pick aria-label="Pick another job">' + opts + '</select></div>' +
      '<div class="ri-row2">' +
        '<button type="button" class="ri-btn' + (ch.sort === 'overhead' ? ' ri-btn-on' : '') + '" data-ri-action="pick-overhead" aria-pressed="' + (ch.sort === 'overhead') + '">Overhead / shop</button>' +
        '<button type="button" class="ri-btn' + (ch.sort === 'unsorted' ? ' ri-btn-on' : '') + '" data-ri-action="pick-park" aria-pressed="' + (ch.sort === 'unsorted') + '">Park as unsorted</button>' +
      '</div>' +
      '<div class="ri-chosen" id="riChosen">' + chosenText(mdl) + '</div></div>';
  }
  function chosenText(mdl) {
    const ch = S.choice;
    if (ch.sort === 'assigned' && mdl.lead) return 'Chosen: ' + esc(leadLine(mdl.lead));
    if (ch.sort === 'overhead') return 'Chosen: Overhead (no job)';
    if (ch.sort === 'unsorted') return 'Chosen: Park as unsorted (it goes to the Sort receipts queue). Parking still adds a cost when you tap Approve.';
    return 'Nothing chosen yet.';
  }

  function relatedSection(mdl) {
    if (!mdl.read.isCredit) return '';
    const ch = S.choice;
    const rows = mdl.related.candidates.map((c) => {
      const e = expensesList().find((x) => x.id === c.expenseId);
      if (!e) return '';
      const label = esc(e.supplier || 'Supplier') + ' · ' + esc(prettyDate(LG().inboxDateKey(e.date))) + ' · ' + esc(usd((Number(e.amountCents) || 0) + (Number(e.taxCents) || 0)));
      return '<label class="ri-radio"><input type="radio" name="riRel" data-ri-field="related" value="' + esc(c.expenseId) + '"' + (ch.relatedExpenseId === c.expenseId ? ' checked' : '') + '> <span>' + label + '<small>' + esc(c.why) + '</small></span></label>';
    }).join('');
    return '<div class="ri-sec"><div class="ri-lab">Which cost is this credit for?</div>' +
      (mdl.related.preselectId ? '<div class="ri-note">The memo names invoice ' + esc(mdl.read.relatedDocNumber) + ', and exactly one cost has it. Check it is the right one.</div>' : '') +
      rows + '<label class="ri-radio"><input type="radio" name="riRel" data-ri-field="related" value=""' + (!ch.relatedExpenseId ? ' checked' : '') + '> <span>None / not sure</span></label></div>';
  }

  function dupHtml(mdl) {
    if (!mdl.dups.length) return '';
    const rows = mdl.dups.map((x) => {
      const e = expensesList().find((y) => y.id === x.expenseId);
      const what = e ? esc(e.supplier || 'Supplier') + ' · ' + esc(prettyDate(LG().inboxDateKey(e.date))) + ' · ' + esc(usd((Number(e.amountCents) || 0) + (Number(e.taxCents) || 0))) : 'An existing row';
      return '<li>' + what + '<small>' + esc(x.why) + '</small></li>';
    }).join('');
    return '<div class="ri-dup" role="alert"><strong>Looks like an existing cost</strong><ul>' + rows + '</ul>' +
      '<label class="ri-check"><input type="checkbox" data-ri-field="dupOk"' + (S.choice.dupOk ? ' checked' : '') + '> This is a different purchase</label></div>';
  }

  function categoryOptions(sel) {
    const cfg = w.ExpenseConfig;
    const keys = LG().ALLOWED_CATEGORIES;
    return keys.map((k) => '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(cfg && cfg.labelFor ? cfg.labelFor(k) : k) + '</option>').join('');
  }
  function paidOptions(sel) {
    const L = LG();
    return '<option value="">(not chosen)</option>' + L.PAID_FROM_KEYS.map((k) => '<option value="' + esc(k) + '"' + (k === sel ? ' selected' : '') + '>' + esc(L.PAID_FROM_LABELS[k]) + '</option>').join('');
  }

  function cardHtml(d) {
    const mdl = modelFor(d);
    const read = d.read;
    const ch = S.choice;
    if (!read) {
      return '<div class="ri-sheet"><div class="ri-head"><button type="button" class="ri-link" data-ri-action="back">← Inbox</button><button type="button" class="ri-x" data-ri-action="close" aria-label="Close">✕</button></div>' +
        '<div class="ri-card"><div class="ri-empty">This one has nothing to approve (it was dropped or could not be read).</div></div></div>';
    }
    const conf = Math.round((read.confidence || 0) * 100);
    const isPdf = /pdf/i.test(d.mime || '');
    const picture = d.fileDeleted || !d.storagePath ? '<div class="ri-empty">The picture was deleted.</div>'
      : (isPdf ? '' : '<img id="riImg" class="ri-img" alt="Picture of the receipt">') + '<a id="riPdf" class="ri-link" target="_blank" rel="noopener" hidden>Open the full ' + (isPdf ? 'PDF' : 'picture') + '</a>';
    const quotes = '<div class="ri-quotes">' +
      (read.poText ? '<div>PO / job text as read: <q>' + esc(read.poText) + '</q></div>' : '') +
      (read.shipTo ? '<div>Ship-to as read: <q>' + esc(read.shipTo) + '</q></div>' : '') +
      (read.docNumber ? '<div>Document number: ' + esc(read.docNumber) + '</div>' : '') +
      (read.paymentLast4 ? '<div>Card ending ' + esc(read.paymentLast4) + '</div>' : '') +
      (read.reasons && read.reasons.length ? '<div>Reader notes: ' + esc(read.reasons.join(' · ')) + '</div>' : '') + '</div>';
    const nb = S.confirmNB
      ? '<div class="ri-warn ri-warn-amber" role="alert">This deletes the picture from the CRM and keeps nothing. <button type="button" class="ri-btn" data-ri-action="not-business-yes">Yes, not a business receipt</button> <button type="button" class="ri-btn" data-ri-action="not-business-no">Cancel</button></div>' : '';
    const typeWord = read.isCredit ? 'Credit memo / return' : (read.documentType || 'document').replace(/_/g, ' ');
    return '<div class="ri-sheet">' +
      '<div class="ri-head"><button type="button" class="ri-link" data-ri-action="back">← Inbox</button><div class="ri-count">' + esc(typeWord) + ' · reader confidence ' + conf + '%</div>' +
      '<button type="button" class="ri-x" data-ri-action="close" aria-label="Close">✕</button></div>' +
      '<div class="ri-card">' +
        '<div class="ri-pic">' + picture + '</div>' +
        warnHtml(mdl.warnings) + dupHtml(mdl) + quotes +
        '<div class="ri-fields">' +
          '<label class="ri-f"><span>Supplier</span><input type="text" data-ri-field="vendor" maxlength="120" value="' + esc(ch.vendor) + '"></label>' +
          '<label class="ri-f"><span>Date</span><input type="date" data-ri-field="date" value="' + esc(ch.date) + '"></label>' +
          '<label class="ri-f ri-f-total"><span>' + (read.isCredit ? 'Credit total (with tax)' : 'Total paid (with tax)') + '</span><input type="text" inputmode="decimal" data-ri-field="total" value="' + esc(ch.total) + '" placeholder="0.00"></label>' +
          '<label class="ri-f"><span>Tax in that total</span><input type="text" inputmode="decimal" data-ri-field="tax" value="' + esc(ch.tax) + '" placeholder="0.00"></label>' +
          '<label class="ri-f"><span>Category</span><select data-ri-field="category">' + categoryOptions(ch.category) + '</select></label>' +
          (read.isCredit ? '' : '<label class="ri-f"><span>Paid from</span><select data-ri-field="paidFrom">' + paidOptions(ch.paidFrom) + '</select></label>') +
          '<label class="ri-f ri-f-wide"><span>Note (optional)</span><input type="text" data-ri-field="note" maxlength="200" value="' + esc(ch.note) + '"></label>' +
        '</div>' +
        relatedSection(mdl) + jobSection(d, mdl) +
      '</div>' +
      '<div class="ri-money" id="riMoney" role="status">' + esc(mdl.line) + '</div>' +
      '<div class="ri-blockers" id="riBlockers">' + (mdl.blockers.length ? esc(mdl.blockers[0]) : '') + '</div>' +
      '<button type="button" class="ri-btn ri-btn-primary" id="riApprove" data-ri-action="approve"' + (mdl.blockers.length ? ' disabled' : '') + '>Approve and add</button>' +
      '<div class="ri-fine">Nothing is added to any total until you tap this button for this one receipt.</div>' +
      nb +
      '<div class="ri-row2"><button type="button" class="ri-btn" data-ri-action="skip">Skip for now</button><button type="button" class="ri-btn" data-ri-action="not-business">Not a business receipt</button></div>' +
    '</div>';
  }

  // ── the list ────────────────────────────────────────────────────────
  const WAITING = ['ready', 'needs_look', 'failed', 'reading'];
  const DONE = ['approved', 'skipped', 'not_business'];
  const STATUS_WORD = { ready: 'Ready to check', needs_look: 'Needs a close look', failed: 'Could not read', reading: 'Reading…', approved: 'Added', skipped: 'Skipped', not_business: 'Not a business receipt' };

  function rowHtml(d) {
    const read = d.read;
    const who = read && read.vendor ? read.vendor : (d.status === 'not_business' ? '(dropped)' : '(no name read)');
    const amt = read && typeof read.totalCents === 'number' ? (read.isCredit ? 'Credit ' : '') + usd(read.totalCents) : '';
    const when = read && read.date ? prettyDate(read.date) : (toMs(d.receivedAt) ? new Date(toMs(d.receivedAt)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
    let act = '';
    if (d.status === 'ready' || d.status === 'needs_look') act = '<button type="button" class="ri-btn ri-btn-primary" data-ri-action="review" data-ri-id="' + esc(d.id) + '">Review</button>';
    else if (d.status === 'failed') act = '<button type="button" class="ri-btn" data-ri-action="retry" data-ri-id="' + esc(d.id) + '">Try again</button>';
    else if (d.status === 'skipped' && read) act = '<button type="button" class="ri-btn" data-ri-action="undo" data-ri-id="' + esc(d.id) + '">Put back</button>';
    return '<div class="ri-item"><div class="ri-item-main"><div class="ri-item-name">' + esc(who) + '</div>' +
      '<div class="ri-item-meta">' + esc(when) + (amt ? ' · ' + esc(amt) : '') + '</div>' +
      '<span class="ri-tag' + (d.status === 'needs_look' ? ' ri-tag-warn' : '') + '">' + esc(STATUS_WORD[d.status] || d.status) + '</span></div>' + act + '</div>';
  }

  function spendLine() {
    const sp = S.spend || { spentUsd: 0, capUsd: LG().INBOX_MONTHLY_USD_CAP };
    const hit = sp.spentUsd >= sp.capUsd;
    return '<div class="ri-spend' + (hit ? ' ri-spend-hit' : '') + '">AI reading this month: $' + sp.spentUsd.toFixed(2) + ' of $' + sp.capUsd.toFixed(2) + (hit ? ' used. Reading is stopped until next month.' : ' used. It stops at the limit.') + '</div>';
  }

  function listHtml() {
    const f = S.filter;
    const rows = S.drafts.filter((d) => (f === 'done' ? DONE.indexOf(d.status) !== -1 : WAITING.indexOf(d.status) !== -1));
    const nWait = S.drafts.filter((d) => WAITING.indexOf(d.status) !== -1).length;
    return '<div class="ri-sheet">' +
      '<div class="ri-head"><div class="ri-title">Receipt inbox</div><button type="button" class="ri-x" data-ri-action="close" aria-label="Close">✕</button></div>' +
      spendLine() +
      '<div class="ri-capture">' +
        '<label class="ri-btn ri-btn-primary ri-file-btn" for="riCam">Take a photo</label><input id="riCam" class="ri-file" type="file" accept="image/*" capture="environment" data-ri-file>' +
        '<label class="ri-btn ri-file-btn" for="riPick">Choose files</label><input id="riPick" class="ri-file" type="file" accept="image/*,application/pdf" multiple data-ri-file>' +
      '</div>' +
      '<div class="ri-fine">Pictures and PDFs only. Each one is read into a draft. Nothing is added until you approve it, one at a time. Anything that is not a business receipt is dropped and its picture deleted.</div>' +
      (S.notice ? '<div class="ri-note" role="status">' + esc(S.notice) + '</div>' : '') +
      '<div class="ri-tabs"><button type="button" class="ri-tab' + (f === 'waiting' ? ' ri-tab-on' : '') + '" data-ri-action="filter" data-ri-filter="waiting">Waiting (' + nWait + ')</button>' +
      '<button type="button" class="ri-tab' + (f === 'done' ? ' ri-tab-on' : '') + '" data-ri-action="filter" data-ri-filter="done">Done</button></div>' +
      (rows.length ? rows.map(rowHtml).join('') : '<div class="ri-empty">' + (f === 'done' ? 'Nothing here yet.' : 'Nothing waiting. Take a photo of a receipt to start.') + '</div>') +
    '</div>';
  }

  function overlay() {
    let m = document.getElementById('riOverlay');
    if (!m) { m = document.createElement('div'); m.id = 'riOverlay'; m.className = 'ri-overlay'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Receipt inbox'); document.body.appendChild(m); }
    return m;
  }
  function render() {
    if (!S) return;
    const m = overlay();
    const d = S.curId ? S.drafts.find((x) => x.id === S.curId) : null;
    m.innerHTML = d ? cardHtml(d) : listHtml();
  }
  // Re-evaluate only the money line and the Approve button while typing (keeps focus in the field).
  function refreshLive() {
    const d = S && S.curId ? S.drafts.find((x) => x.id === S.curId) : null;
    if (!d || !d.read) return;
    const mdl = modelFor(d);
    const line = document.getElementById('riMoney'); if (line) line.textContent = mdl.line;
    const bl = document.getElementById('riBlockers'); if (bl) bl.textContent = mdl.blockers.length ? mdl.blockers[0] : '';
    const ap = document.getElementById('riApprove'); if (ap) ap.disabled = mdl.blockers.length > 0;
  }

  // ── decisions ───────────────────────────────────────────────────────
  async function writeDecision(id, patch) {
    if (!w.updateDoc || !w.doc || !w.db) { toast('Not connected. Try again.', 'error'); return false; }
    try {
      await w.updateDoc(w.doc(w.db, 'receipt_inbox', id), Object.assign({ updatedAt: w.serverTimestamp ? w.serverTimestamp() : new Date() }, patch));
      return true;
    } catch (e) {
      console.warn('[receipt-inbox] decision failed', id, e && e.code);
      toast('Could not save that. Nothing changed.', 'error');
      return false;
    }
  }
  const stamp = () => ({ decidedBy: uid(), decidedAt: w.serverTimestamp ? w.serverTimestamp() : new Date() });

  function nextWaitingId(afterId) {
    const waiting = S.drafts.filter((d) => (d.status === 'ready' || d.status === 'needs_look') && d.id !== afterId);
    return waiting.length ? waiting[0].id : '';
  }

  async function approve() {
    if (!S || S.busy) return;
    const d = S.drafts.find((x) => x.id === S.curId);
    if (!d || !d.read || (d.status !== 'ready' && d.status !== 'needs_look')) return;
    const mdl = modelFor(d);
    if (mdl.blockers.length || !mdl.m.ok) { toast(mdl.blockers[0] || 'Check the receipt first.', 'warn'); return; }
    // A draft that already made an expense (a retry after a failed second write) never makes a second one.
    const done = expensesList().find((e) => e && e.inboxId === d.id);
    S.busy = true; render();
    let expenseId = done ? done.id : null;
    if (!expenseId) {
      const form = Object.assign({}, mdl.m.form, { returnId: true });
      let res = false;
      try { res = await w.Expenses.createExpense(form); } catch (e) { res = false; }
      if (!res || res === true) { S.busy = false; render(); if (!res) toast('Could not add the cost. Nothing was added.', 'error'); return; }
      expenseId = res;
    }
    const f = mdl.m.form;
    const ok = await writeDecision(d.id, Object.assign(stamp(), {
      status: 'approved',
      decision: { expenseId, sort: f.reviewState, leadId: f.leadId || null, totalCents: f.totalCents, taxCents: f.taxCents, entryType: f.entryType, relatedExpenseId: f.relatedExpenseId || null, edited: !!(S.choice.totalEdited || S.choice.taxEdited) },
    }));
    S.busy = false;
    if (!ok) {
      toast('The cost WAS added, but the inbox row did not update. Do not approve it again; close and reopen the inbox.', 'warn');
      render();
      return;
    }
    d.status = 'approved';
    toast('Added. ' + (f.entryType === 'credit' ? 'Totals now net this credit.' : 'One cost added.'), 'ok');
    const nxt = nextWaitingId(d.id);
    S.curId = '';
    if (w.Expenses && typeof w.Expenses.refresh === 'function') { try { w.Expenses.refresh(); } catch (e) { /* the list refreshes on its own */ } }
    if (nxt) { openDraft(nxt); } else { await refreshAll(); }
  }

  async function skip() {
    const d = S && S.drafts.find((x) => x.id === S.curId);
    if (!d || S.busy) return;
    S.busy = true;
    const ok = await writeDecision(d.id, Object.assign(stamp(), { status: 'skipped', decision: { note: 'skipped' } }));
    S.busy = false;
    if (!ok) return;
    d.status = 'skipped';
    S.curId = '';
    await refreshAll();
  }
  async function notBusiness() {
    const d = S && S.drafts.find((x) => x.id === S.curId);
    if (!d || S.busy) return;
    S.busy = true; render();
    const gone = await deleteFile(d.storagePath);
    const ok = await writeDecision(d.id, Object.assign(stamp(), { status: 'not_business', fileDeleted: gone, decision: { note: 'not a business receipt' } }));
    S.busy = false; S.confirmNB = false;
    if (!ok) { render(); return; }
    d.status = 'not_business';
    S.curId = '';
    toast(gone ? 'Dropped. The picture was deleted.' : 'Dropped, but the picture could not be deleted. Delete it from the receipts folder.', gone ? 'ok' : 'warn');
    await refreshAll();
  }
  async function undo(id) {
    const d = S && S.drafts.find((x) => x.id === id);
    if (!d || !d.read || S.busy) return;
    const back = d.status === 'skipped' ? ((d.warnings || []).some((x) => x.level === 'red') ? 'needs_look' : 'ready') : '';
    if (!back) return;
    if (await writeDecision(id, { status: back })) { d.status = back; await refreshAll(); }
  }

  // ── open / close ────────────────────────────────────────────────────
  async function open() {
    if (!enabled()) return;
    S = { drafts: [], filter: 'waiting', curId: '', choice: null, spend: { spentUsd: 0, capUsd: LG().INBOX_MONTHLY_USD_CAP }, busy: false, uploading: false, notice: '', aliases: {}, confirmNB: false, imgUrl: '' };
    try { if (w.NBDHdImport && typeof w.NBDHdImport.loadAliases === 'function') S.aliases = await w.NBDHdImport.loadAliases(); } catch (e) { S.aliases = {}; }
    render();
    await refreshAll();
  }
  function close() {
    const m = document.getElementById('riOverlay'); if (m) m.remove();
    S = null;
    if (w.Expenses && typeof w.Expenses.refresh === 'function') { try { w.Expenses.refresh(); } catch (e) { /* ignore */ } }
  }
  function buttonHtml() {
    if (!enabled()) return '';
    return '<button type="button" class="btn btn-ghost" data-ri-action="open" title="Photograph or upload a receipt and approve it one at a time">📥 Receipt inbox</button>';
  }

  // ── events ──────────────────────────────────────────────────────────
  function onField(el, live) {
    const f = el.dataset.riField;
    const ch = S && S.choice;
    if (!ch) return;
    if (f === 'dupOk') ch.dupOk = !!el.checked;
    else if (f === 'related') ch.relatedExpenseId = el.value || '';
    else if (f === 'total') { ch.total = el.value; ch.totalEdited = true; }
    else if (f === 'tax') { ch.tax = el.value; ch.taxEdited = true; }
    else if (f === 'vendor' || f === 'date' || f === 'category' || f === 'paidFrom' || f === 'note') ch[f] = el.value;
    if (live) refreshLive(); else { render(); const d = S.drafts.find((x) => x.id === S.curId); if (d) loadImage(d); }
  }
  function pick(kind, leadId) {
    const ch = S && S.choice; if (!ch) return;
    if (kind === 'job') { ch.sort = 'assigned'; ch.leadId = leadId; }
    else if (kind === 'overhead') { ch.sort = 'overhead'; ch.leadId = ''; }
    else { ch.sort = 'unsorted'; ch.leadId = ''; }
    render();
    const d = S.drafts.find((x) => x.id === S.curId); if (d) loadImage(d);
  }

  if (!w._NBD_RI_DELEGATE) {
    w._NBD_RI_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest && ev.target.closest('[data-ri-action]');
      if (!t || t.disabled) return;
      const a = t.dataset.riAction;
      if (a === 'open') open();
      else if (!S) return;
      else if (a === 'close') close();
      else if (a === 'back') { S.curId = ''; render(); }
      else if (a === 'filter') { S.filter = t.dataset.riFilter === 'done' ? 'done' : 'waiting'; render(); }
      else if (a === 'review') openDraft(t.dataset.riId);
      else if (a === 'retry') retryDraft(t.dataset.riId);
      else if (a === 'undo') undo(t.dataset.riId);
      else if (a === 'pick-job') pick('job', t.dataset.riLead);
      else if (a === 'pick-overhead') pick('overhead');
      else if (a === 'pick-park') pick('park');
      else if (a === 'approve') approve();
      else if (a === 'skip') skip();
      else if (a === 'not-business') { S.confirmNB = true; render(); const d = S.drafts.find((x) => x.id === S.curId); if (d) loadImage(d); }
      else if (a === 'not-business-no') { S.confirmNB = false; render(); const d = S.drafts.find((x) => x.id === S.curId); if (d) loadImage(d); }
      else if (a === 'not-business-yes') notBusiness();
    });
    document.addEventListener('input', (ev) => {
      const el = ev.target;
      if (S && el && el.dataset && el.dataset.riField && (el.type === 'text' || el.type === 'date')) onField(el, true);
    });
    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (!S || !el || !el.matches) return;
      if (el.matches('[data-ri-file]')) { handleFiles(el.files); el.value = ''; return; }
      if (el.matches('[data-ri-pick]') && el.value) { pick('job', el.value); return; }
      if (el.dataset && el.dataset.riField) onField(el, el.tagName === 'INPUT' && el.type === 'text');
    });
  }

  w.NBDReceiptInbox = { enabled, open, close, buttonHtml, _modelFor: modelFor, _state: () => S, _setState: (s) => { S = s; } };
})();
