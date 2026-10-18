/**
 * po-name.js — the "NBD-0042 Smith" text Jo pastes into Home Depot Pro Xtra
 * PO/Job Names and the Lowe's PO field at checkout (2026-10-18).
 *
 * Why: the receipt importers (hd-import.js, the receipt sorter) match a
 * purchase to a job EXACTLY when the PO/Job name carries the CRM customer
 * number. Nothing else Jo can do at the register is as accurate. This module
 * builds that string and wires the "Copy PO name" button next to the customer
 * number chip on the customer page.
 *
 * Pure part: NBDPoName.poText(lead) → 'NBD-0042 Smith' (or '' with no number).
 * The text keeps the number first (the importer's CUST_RE reads it anywhere)
 * and the last name second (for the human reading the receipt).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const MAX_NAME = 24;

  // A business name keeps its first words; a person is shown by last name.
  const BIZ = /\b(llc|inc|corp|co|company|holdings|properties|church|ltd|trust|group)\b\.?/i;

  function clean(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9 '.&-]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function nameOf(lead) {
    const l = lead || {};
    const full = clean(((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || '');
    if (!full) {
      const street = clean(String(l.address || '').split(',')[0]);
      return street.slice(0, MAX_NAME).trim();
    }
    if (BIZ.test(full)) return full.slice(0, MAX_NAME).trim();
    const last = clean(l.lastName || '') || full.split(' ').slice(-1)[0];
    return last.slice(0, MAX_NAME).trim();
  }

  function poText(lead) {
    const id = String((lead && lead.customerId) || '').trim().toUpperCase();
    if (!/^[A-Z]{2,5}-\d{3,5}(?:-[A-Z0-9]{4})?$/.test(id)) return '';
    const n = nameOf(lead);
    return n ? id + ' ' + n : id;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch (e) { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const done = document.execCommand('copy');
      ta.remove();
      return !!done;
    } catch (e) { return false; }
  }

  function toast(msg, kind) { if (typeof window.showToast === 'function') window.showToast(msg, kind || 'ok'); }

  async function copyFor(lead) {
    const text = poText(lead);
    if (!text) { toast('This customer has no number yet', 'error'); return ''; }
    const ok = await copyText(text);
    toast(ok ? 'Copied: ' + text + ' — paste it as the PO/Job name' : 'Could not copy. PO name: ' + text, ok ? 'ok' : 'error');
    return ok ? text : '';
  }

  if (typeof document !== 'undefined' && !window._NBD_PO_DELEGATE) {
    window._NBD_PO_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest && ev.target.closest('[data-copy-po]');
      if (!t) return;
      ev.preventDefault();
      copyFor(window._leadDoc || null);
    });
  }

  window.NBDPoName = { poText, nameOf, copyText, copyFor };
})();
