/**
 * data-export.js — Wave 21 (CSV Data Export)
 *
 * Reps coming from spreadsheets routinely ask "can I get my leads
 * out as a CSV?" and the answer until now was "no, you'd have to
 * use the Firestore CLI." Bad answer. Real escape hatch / backup
 * utility, ships against already-loaded in-memory caches so it's
 * one click + zero server round-trips.
 *
 * Exports:
 *   - Leads:     window._leads → CSV with one row per lead
 *   - Estimates: window._estimates → CSV with one row per estimate,
 *                joined to leads for friendly leadName column
 *
 * Properly RFC-4180 quoted: fields containing comma, quote, or
 * newline get wrapped in double quotes with internal quotes
 * doubled. Excel-safe BOM prepended so non-ASCII names don't get
 * mojibake'd in Excel for Windows. Formula-leading fields are
 * neutralized before quoting — see csvEscape.
 *
 * Filename pattern: nbd-{type}-YYYY-MM-DD.csv (date in local TZ
 * so the rep recognizes it).
 *
 * Exposes: DataExport.{exportLeads, exportEstimates,
 *                              csvEscape, toCsv}
 *          window.exportLeadsCsv / window.exportEstimatesCsv
 *          (legacy onclick names mirroring the bell + cmd-palette
 *          pattern from prior waves)
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['data-export']) return;
  __NBD_LOADED['data-export'] = true;

  // ─── CSV serialization ───────────────────────────────────────────
  // Excel and Sheets treat a cell whose FIRST character is one of
  // = + - @ TAB CR as a formula and evaluate it the moment the file
  // is double-clicked. Lead names and notes arrive from the PUBLIC
  // intake form, so without this a hostile submission is code that
  // runs on the owner's own machine, in his own spreadsheet, from an
  // export he made himself. Prefixing the spreadsheet text marker
  // (a single quote) demotes the cell to text.
  const FORMULA_LEAD = /^[=+\-@\t\r]/;
  // ...but a plain signed number is a legitimate cell — jobValue can
  // be -1500 (a credit) and Total can be negative, and those still
  // have to sum and sort for the rep, not sit there as text with a
  // stray apostrophe. So wholly-numeric values are exempt. That's
  // safe rather than a compromise: a string Number() would accept has
  // no room left for an expression — "-1500" cannot call anything,
  // while "-2+3+cmd|' /C calc'!A0" is not a number and does get the
  // marker.
  const PLAIN_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
  function neutralizeFormula(s) {
    if (!FORMULA_LEAD.test(s)) return s;
    if (PLAIN_NUMBER.test(s)) return s;
    return "'" + s;
  }

  // Value → string, with no escaping of any kind. Split out of csvEscape so
  // the TSV path (Open in Google Sheets) coerces Dates, Firestore Timestamps
  // and objects identically — a second coercion would be a second set of bugs.
  function cellText(v) {
    if (v == null) return '';
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'object') {
      // Firestore Timestamps + plain objects — try to extract ISO
      // string; otherwise stringify.
      if (typeof v.toDate === 'function') return v.toDate().toISOString();
      if (typeof v.toMillis === 'function') return new Date(v.toMillis()).toISOString();
      return JSON.stringify(v);
    }
    return String(v);
  }

  function csvEscape(v) {
    const s = cellText(v);
    const marked = neutralizeFormula(s);
    // Quote if contains separator, quote, or newline — and ALWAYS
    // when we added the marker, so the apostrophe can't be read as
    // anything but the first character of this one cell.
    if (marked !== s || /[",\n\r]/.test(marked)) {
      return '"' + marked.replace(/"/g, '""') + '"';
    }
    return marked;
  }

  function toCsv(rows, headers) {
    const headerLine = headers.map(h => csvEscape(h.label || h.key)).join(',');
    const lines = [headerLine];
    for (const row of rows) {
      lines.push(headers.map(h => csvEscape(h.value ? h.value(row) : row[h.key])).join(','));
    }
    // Excel-safe BOM so UTF-8 displays correctly in Excel for Windows.
    return '﻿' + lines.join('\r\n');
  }

  // ─── TSV serialization (clipboard → Google Sheets) ───────────────
  // Sheets parses a pasted block as tab-separated. There is no quoting
  // convention it honours on paste, so a cell that itself contains a tab or a
  // newline would shift every later column into the wrong field — or split one
  // lead across two rows. Cells are therefore FLATTENED rather than quoted.
  //
  // Order is load-bearing: flatten, then trim, then neutralize. Flattening
  // first means a value like "\n=cmd|' /C calc'!A0" — whose leading character
  // is a newline, which FORMULA_LEAD does not match — is reduced to "=cmd|…"
  // and still gets the text marker. Doing it the other way round would let
  // that cell reach the sheet as a live formula. The resulting invariant is
  // flat: no TSV cell begins with = + - @ TAB or CR unless it is a plain
  // number, which is what the test asserts.
  function tsvCell(v) {
    const flat = cellText(v).replace(/[\t\r\n]+/g, ' ').trim();
    return neutralizeFormula(flat);
  }

  function toTsv(rows, headers) {
    const lines = [headers.map(h => tsvCell(h.label || h.key)).join('\t')];
    for (const row of rows) {
      lines.push(headers.map(h => tsvCell(h.value ? h.value(row) : row[h.key])).join('\t'));
    }
    // No BOM: this goes to the clipboard, not to a file Excel will sniff.
    return lines.join('\r\n');
  }

  // ─── File download helper ───────────────────────────────────────
  function downloadCsv(filename, csvText) {
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  // File names carry the company (2026-10-04, tenant-ready): 'nbd' for NBD,
  // the company's own name for everyone else (tenant-rules.js filePrefix).
  function exportPrefix() {
    const TR = (typeof window !== 'undefined') && window.NBDTenantRules;
    return (TR && typeof TR.filePrefix === 'function') ? TR.filePrefix() : 'nbd';
  }

  function todayStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ─── Header definitions ─────────────────────────────────────────
  // Order matters — this is the column order in the CSV. Each header
  // is { key, label, value? }. value() is optional; falls back to
  // row[key].
  const LEAD_HEADERS = [
    { key: 'customerId',     label: 'Customer ID' },
    { key: 'firstName',      label: 'First Name' },
    { key: 'lastName',       label: 'Last Name' },
    { key: 'address',        label: 'Address' },
    { key: 'phone',          label: 'Phone' },
    { key: 'email',          label: 'Email' },
    { key: 'stage',          label: 'Stage' },
    { key: 'jobType',        label: 'Job Type' },
    { key: 'source',         label: 'Source' },
    { key: 'damageType',     label: 'Damage Type' },
    { key: 'jobValue',       label: 'Job Value' },
    { key: 'claimNumber',    label: 'Claim #' },
    { key: 'insCarrier',     label: 'Carrier',
      value: r => r.insCarrier || r.insuranceCarrier || '' },
    { key: 'claimStatus',    label: 'Claim Status' },
    // Date of loss + the lead's pin, so a storm backtest can match a
    // job to the day and place the hail hit without a database read.
    // lat/lng are numbers (negative longitude included), so they pass
    // the plain-number exemption and still sort and plot as numbers.
    { key: 'dateOfLoss',     label: 'Date of Loss' },
    { key: 'lat',            label: 'Latitude',
      value: r => (r.lat != null ? r.lat : '') },
    { key: 'lng',            label: 'Longitude',
      value: r => (r.lng != null ? r.lng : '') },
    { key: 'createdAt',      label: 'Created' },
    { key: 'updatedAt',      label: 'Updated' },
    { key: 'stageStartedAt', label: 'Current Stage Since' },
    { key: 'notes',          label: 'Notes' },
  ];

  // ─── Lead export ────────────────────────────────────────────────
  // Row selection, shared by the CSV download and the Sheets clipboard path so
  // the two can never disagree about which leads a rep just exported.
  // Skip soft-deleted; respect prospect filter for the export
  // (matches what the rep sees in the kanban). If they want
  // prospects included, they'll toggle "Show prospects" first.
  function collectLeadRows() {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const showProspects = (() => {
      try { return localStorage.getItem('nbd_crm_show_prospects') === '1'; }
      catch (e) { return false; }
    })();
    return leads
      .filter(l => l && !l.deleted)
      .filter(l => showProspects || !l.isProspect);
  }

  function exportLeads() {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    if (leads.length === 0) {
      _toast('No leads to export', 'error');
      return;
    }
    const rows = collectLeadRows();

    if (rows.length === 0) {
      _toast('No leads match your current filters', 'error');
      return;
    }

    const csv = toCsv(rows, LEAD_HEADERS);
    const fname = `${exportPrefix()}-leads-${todayStamp()}.csv`;
    downloadCsv(fname, csv);
    _toast(`Exported ${rows.length} lead${rows.length === 1 ? '' : 's'} → ${fname}`, 'success');
  }

  // ─── Estimate export ────────────────────────────────────────────
  // Built per call because the leadName / leadAddress columns close over the
  // lead index. Shared by the CSV and Sheets paths so both export the same
  // columns in the same order.
  function estimateHeaders(leadById) {
    return [
      { key: 'id',              label: 'Estimate ID' },
      { key: 'estimateNumber',  label: 'Estimate #',
        value: r => r.estimateNumber || r.number || '' },
      { key: 'leadId',          label: 'Lead ID' },
      { key: 'leadName',        label: 'Lead Name', value: r => {
          const l = leadById[r.leadId];
          if (!l) return '';
          return `${l.firstName || ''} ${l.lastName || ''}`.trim() || l.address || '';
        } },
      { key: 'leadAddress',     label: 'Lead Address', value: r => leadById[r.leadId]?.address || '' },
      { key: 'status',          label: 'Status' },
      { key: 'total',           label: 'Total', value: r => Number(r.total || r.amount || 0) },
      { key: 'lineItemsCount',  label: 'Line Items', value: r => Array.isArray(r.lineItems) ? r.lineItems.length : 0 },
      { key: 'createdAt',       label: 'Created' },
      { key: 'sentAt',          label: 'Sent' },
      { key: 'viewedAt',        label: 'Viewed' },
      { key: 'respondedAt',     label: 'Responded' },
    ];
  }

  function leadIndex() {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const leadById = {};
    for (const l of leads) leadById[l.id] = l;
    return leadById;
  }

  function exportEstimates() {
    const estimates = Array.isArray(window._estimates) ? window._estimates : [];
    if (estimates.length === 0) {
      _toast('No estimates to export', 'error');
      return;
    }
    const headers = estimateHeaders(leadIndex());

    const csv = toCsv(estimates, headers);
    const fname = `${exportPrefix()}-estimates-${todayStamp()}.csv`;
    downloadCsv(fname, csv);
    _toast(`Exported ${estimates.length} estimate${estimates.length === 1 ? '' : 's'} → ${fname}`, 'success');
  }

  // ─── Open in Google Sheets ──────────────────────────────────────
  // A CSV on an iPhone is close to unopenable — Safari previews it and there
  // is nowhere to go from there. This path skips the file entirely: it copies
  // the same rows as TSV and opens a blank Google Sheet for the rep to paste
  // into. No API key, no OAuth, no server round-trip, no vendor account of
  // ours: the rep's own Google login is the only credential and the data goes
  // to their clipboard, never through us.
  const SHEETS_NEW_URL = 'https://sheets.new';

  // clipboard-fix.js already has this logic but never exposes it (its "Expose
  // globally" comment at :54 is followed by nothing), so it is inlined here
  // rather than depended on. Fire-and-forget by design — see openInSheets.
  function _execCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      if (typeof ta.select === 'function') ta.select();
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, text.length);
      // execCommand reports failure by returning false, not by throwing, so
      // the caller needs that value to know whether to try the async path.
      const ok = document.execCommand('copy') === true;
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      console.warn('[DataExport] clipboard copy failed', e);
      return false;
    }
  }

  function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
        const p = navigator.clipboard.writeText(text);
        // Mobile Safari rejects writeText in some contexts; fall back without
        // awaiting, so the caller never yields the click's task.
        if (p && typeof p.catch === 'function') p.catch(() => _execCopy(text));
        return;
      }
    } catch (e) { /* fall through to the textarea path */ }
    _execCopy(text);
  }

  function openInSheets(kind) {
    let rows, headers, label;
    if (kind === 'estimates') {
      rows = Array.isArray(window._estimates) ? window._estimates : [];
      if (rows.length === 0) { _toast('No estimates to export', 'error'); return; }
      headers = estimateHeaders(leadIndex());
      label = 'estimate';
    } else {
      const leads = Array.isArray(window._leads) ? window._leads : [];
      if (leads.length === 0) { _toast('No leads to export', 'error'); return; }
      rows = collectLeadRows();
      if (rows.length === 0) { _toast('No leads match your current filters', 'error'); return; }
      headers = LEAD_HEADERS;
      label = 'lead';
    }

    const tsv = toTsv(rows, headers);

    // Copy SYNCHRONOUSLY first, then open — both in the click's own task.
    //
    // It used to be open-then-copy, with the async Clipboard API. On desktop
    // that silently failed: the new sheet takes focus, writeText rejects with
    // "Document is not focused", and the execCommand fallback then ran in a
    // promise callback with no focus and no user activation, so it failed too.
    // The rep pasted whatever was already on their clipboard (2026-09-24).
    //
    // The iOS rule the old order protected is still kept: Safari only honours
    // a popup opened in the same task as the click, so nothing may be AWAITED
    // before window.open. A synchronous execCommand copy awaits nothing — it
    // runs and returns within this task, while the page still has focus.
    const copied = _execCopy(tsv);

    let opened = null;
    try { opened = window.open(SHEETS_NEW_URL, '_blank', 'noopener'); } catch (e) { opened = null; }

    // Only if the synchronous copy failed: best-effort async attempt. It can
    // still work where execCommand is unsupported and no tab stole focus.
    if (!copied) copyText(tsv);

    const n = rows.length;
    const plural = n === 1 ? '' : 's';
    if (opened) {
      _toast(`Copied ${n} ${label}${plural} — tap cell A1 in the new sheet and paste`, 'success');
    } else {
      _toast(`Copied ${n} ${label}${plural}. Pop-up blocked — open sheets.new and paste`, 'info');
    }
  }

  // ─── Toast helper (uses dashboard's showToast if present) ───────
  function _toast(msg, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'info');
    } else {
      console.log('[DataExport]', msg);
    }
  }

  // ─── Public API ─────────────────────────────────────────────────
  const DataExport = {
    exportLeads,
    exportEstimates,
    csvEscape,
    toCsv,
    tsvCell,
    toTsv,
  };
  // Friendly globals for inline onclick handlers — same convention
  // we used for openCmdPalette / toggleNotificationDropdown so the
  // settings buttons can stay declarative.
  window.exportLeadsCsv     = exportLeads;
  window.exportEstimatesCsv = exportEstimates;
  window.openLeadsInSheets     = function () { openInSheets('leads'); };
  window.openEstimatesInSheets = function () { openInSheets('estimates'); };
})();
