/**
 * price-import.js: "Import prices" (2026-11-17, slice 3, flag supplierPricing).
 *
 * The Product Library's "Import prices" button (data-pri-action="open"; owner and
 * company admins only) opens one sheet: pick the supplier, the kind of document
 * (quote, price sheet or invoice), its date (and a quote's good-through date), say
 * whether the prices include sales tax (no default), pick a CSV file, match its
 * columns, preview the counts, then save. Rows go through priceLedgerRecord on
 * channel csv_import, 500 a call (NBDPriceLedger.importRows). An item number the
 * ledger has not seen becomes a new unlinked item (see "Unlinked items").
 *
 * Slice 9 (2026-11-18): instead of a CSV, a PDF or a photo of the supplier's
 * document can be read by the reader on the server (NBDPriceLedger.readDocument,
 * priceDocRead). Its lines fill the same column match and preview; the kind, dates,
 * tax and document number it read are filled in for the person to check; nothing is
 * saved until they press Save. The original is kept privately, and every saved row
 * carries the document's id, so "Remove this document" voids them all.
 *
 * Rules this file keeps:
 *   - a CSV is read in the browser and never uploaded or stored: only its rows,
 *     its name and the document date reach the ledger
 *   - prices are read by digits (NBDPriceLogic.moneyTextToMicros), never guessed;
 *     a row with no unit is saved as stated and counted as needing one
 *   - every cell from the file goes through esc() before it reaches the page
 *   - one click, change and submit delegate on data-pri-*; no inline handlers or style
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const LG = () => w.NBDPriceLogic;
  const PL = () => w.NBDPriceLedger;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const PREVIEW_LINES = 100;
  const FIELDS = [
    ['sku', 'Item number or SKU (required)'], ['title', 'Description'], ['price', 'Price (required)'],
    ['unit', 'Unit (UOM)'], ['per', 'Priced per (C or M), if a column says so'], ['qty', 'Quantity (optional)'],
  ];
  const KINDS = { quote: 'Quote', price_sheet: 'Price sheet', invoice: 'Invoice' };
  const STATUS = { ok: 'Ready', needs_unit: 'Needs a unit', rejected: 'Skipped' };
  const REASONS = {
    no_item_number: 'no item number', bad_item_number: 'item number too long', bad_price: 'no price, or not a number', bad_per: '"per" not C or M',
    bad_supplier: 'Pick the supplier.', bad_kind: 'Pick the kind of document.', tax_required: 'Say whether sales tax is in these prices.',
    bad_date: 'Check the document date: it can not be in the future.', quote_needs_date: 'A quote needs the date it is good through.',
    bad_valid_through: 'Check the good-through date: it can not be before the document date.', map_required: 'Match the item number and price columns.',
    too_many_rows: 'That file has more than 5,000 rows. Split it into smaller files.',
  };

  let S = null;
  const today = () => { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const opt = (value, label, selected) => '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  const field = (label, control, hint) => '<label class="prl-field"><span class="prl-label">' + esc(label) + '</span>' + control + (hint ? '<span class="prl-hint">' + esc(hint) + '</span>' : '') + '</label>';

  function setupHtml() {
    const f = S.f;
    const accts = (S.suppliers || []).filter((a) => a.active !== false);
    if (!accts.length) return '<div class="prl-empty">Add the supplier first: open any product\'s Stores &amp; prices and use "Add a store or supplier".</div>';
    const acct = accts.find((a) => (a.supplierId || a.id) === f.supplierId) || accts[0];
    const locs = (acct && acct.locations) || [];
    return '<form class="prl-form" data-pri-form="setup" novalidate>' +
      field('Supplier', '<select class="prl-input" name="supplierId" data-pri-change="setup">' + accts.map((a) => opt(a.supplierId || a.id, a.label || a.supplierId, (a.supplierId || a.id) === f.supplierId)).join('') + '</select>') +
      (locs.length ? field('Branch', '<select class="prl-input" name="locationId" data-pri-change="setup">' + opt('', 'Not stated') + locs.map((l) => opt(l.id, l.label || l.id, l.id === f.locationId)).join('') + '</select>') : '') +
      '<div class="prl-row2">' +
      field('Kind of document', '<select class="prl-input" name="docKind" data-pri-change="setup">' + Object.keys(KINDS).map((k) => opt(k, KINDS[k], k === f.docKind)).join('') + '</select>') +
      field('Is sales tax in these prices?', '<select class="prl-input" name="tax" data-pri-change="setup">' + opt('', 'Choose…', f.tax === '') + opt('no', 'No, before tax', f.tax === 'no') + opt('yes', 'Yes, tax included', f.tax === 'yes') + '</select>', 'Asked once for the whole file.') +
      '</div><div class="prl-row2">' +
      field('Date on the document', '<input class="prl-input" name="docDateOn" type="date" data-pri-change="setup" value="' + esc(f.docDateOn) + '" max="' + esc(today()) + '">') +
      (f.docKind === 'quote' ? field('Good through (required for a quote)', '<input class="prl-input" name="validThroughOn" type="date" data-pri-change="setup" value="' + esc(f.validThroughOn) + '">') : '<span></span>') +
      '</div>' +
      field('Document number (optional)', '<input class="prl-input" name="docRef" maxlength="80" autocomplete="off" data-pri-change="setup" value="' + esc(f.docRef) + '">', 'Left blank, the file name is used.') +
      field('File (CSV)', '<input class="prl-input" name="file" type="file" accept=".csv,text/csv" data-pri-change="file">', 'An Excel file must be saved as CSV first (File, Save As, CSV). The file stays on this device: only its rows and its name are saved.') +
      field('Or read a PDF or photo', '<input class="prl-input" name="doc" type="file" accept="application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" data-pri-change="doc"' + (S.busy ? ' disabled' : '') + '>',
        'Read on the server by AI: check every line before you save. The original is kept privately for you and your admins.') +
      (S.reading ? '<div class="prl-dim" role="status">' + esc(S.reading) + '</div>' : '') +
      (S.readNote ? '<div class="prl-note">' + S.readNote + '</div>' : '') +
      (S.file ? mapHtml() : '') +
      (S.error ? '<div class="prl-error" role="alert">' + esc(S.error) + '</div>' : '') +
      (S.file ? '<div class="prl-actions"><button type="submit" class="btn btn-orange prl-btn">Preview</button></div>' : '') +
      '</form>';
  }

  /** The documents read so far, each with Open and Remove this document. */
  function docsHtml() {
    const docs = (S.docs || []).filter((d) => d && d.state !== 'failed');
    if (!docs.length) return '';
    return '<h3 class="prl-h3">Documents read</h3>' + docs.slice(0, 20).map((d) => '<div class="prl-hrow">' +
      '<div class="prl-hmain">' + esc(d.fileName || 'document') + '</div>' +
      '<div class="prl-src">' + esc(d.createdAtMs ? new Date(d.createdAtMs).toISOString().slice(0, 10) : '') + ' · ' + esc(d.lineCount || 0) + ' lines read' +
      (d.read && d.read.docNumber ? ' · ' + esc(d.read.docNumber) : '') + (d.state === 'removed' ? ' · <span class="ui-badge is-danger">Removed</span>' : '') + '</div>' +
      (d.state === 'read' ? '<div class="prl-actions">' + (d.storagePath ? '<button type="button" class="ui-btn-quiet prl-btn" data-pri-action="openDoc" data-pri-id="' + esc(d.id) + '">Open</button>' : '') +
        '<button type="button" class="ui-btn-quiet prl-btn" data-pri-action="removeDoc" data-pri-id="' + esc(d.id) + '">Remove this document</button></div>' : '') +
      '</div>').join('');
  }

  function mapHtml() {
    const head = (S.file.table[S.headerRow] || []);
    const cols = opt('-1', 'Not in this file') + head.map((h, i) => opt(String(i), 'Column ' + (i + 1) + (String(h).trim() ? ': ' + String(h).trim().slice(0, 40) : ''))).join('');
    return '<h3 class="prl-h3">Match the columns of ' + esc(S.file.name) + '</h3>' +
      field('Column names are on row', '<input class="prl-input" name="headerRow" inputmode="numeric" pattern="[0-9]*" data-pri-change="header" value="' + esc(S.headerRow + 1) + '">', S.file.table.length + ' rows in the file.') +
      '<div class="prl-row2">' + FIELDS.map(([k, label]) => field(label, '<select class="prl-input" name="map_' + k + '">' + cols.replace('value="' + esc(String(S.map[k])) + '"', 'value="' + esc(String(S.map[k])) + '" selected') + '</select>')).join('') + '</div>';
  }

  function previewHtml() {
    const p = S.preview, c = p.counts;
    const lines = p.lines.slice(0, PREVIEW_LINES).map((l) => '<tr class="pri-' + esc(l.status) + '"><td>' + esc(l.line) + '</td><td>' + esc(l.sku) + '</td><td>' + esc(l.title) + '</td><td class="ui-money">' +
      esc(l.priceMicros ? LG().microsToText(l.priceMicros) : '') + '</td><td>' + esc(l.statedUnit || l.uomRaw || '') + (l.per > 1 ? ' per ' + esc(l.per) : '') + '</td><td>' +
      esc(STATUS[l.status]) + (l.reason ? ' (' + esc(REASONS[l.reason] || l.reason) + ')' : '') + (l.isNew && l.status !== 'rejected' ? ' · new item' : '') + '</td></tr>').join('');
    return '<div class="pri-counts">' +
      '<div><strong>' + esc(c.rows) + '</strong> rows</div><div><strong>' + esc(c.send) + '</strong> to save</div>' +
      '<div><strong>' + esc(c.newItems) + '</strong> new items</div><div><strong>' + esc(c.needsUnit) + '</strong> need a unit</div><div><strong>' + esc(c.rejected) + '</strong> skipped</div></div>' +
      (c.newItems ? '<p class="prl-dim">New items arrive unlinked: link each to a product under "Unlinked items".</p>' : '') +
      (c.needsUnit ? '<p class="prl-dim">A row with no unit is saved as printed and can not be compared until it has one. Map the unit column if the file has one.</p>' : '') +
      '<div class="pri-scroll"><table class="pri-table"><thead><tr><th>Row</th><th>Item</th><th>Description</th><th>Price</th><th>Unit</th><th>Status</th></tr></thead><tbody>' + lines + '</tbody></table></div>' +
      (p.lines.length > PREVIEW_LINES ? '<p class="prl-dim">Showing the first ' + PREVIEW_LINES + ' rows.</p>' : '') +
      '<div class="prl-actions">' +
      (c.send ? '<button type="button" class="btn btn-orange prl-btn" data-pri-action="save"' + (S.busy ? ' disabled' : '') + '>Save ' + esc(c.send) + ' prices</button>' : '') +
      '<button type="button" class="ui-btn-quiet prl-btn" data-pri-action="back"' + (S.busy ? ' disabled' : '') + '>Back</button></div>' +
      (S.progress ? '<div class="prl-dim" role="status">' + esc(S.progress) + '</div>' : '');
  }

  function resultHtml() {
    const r = S.result;
    return '<div class="prl-empty" role="status"><strong>Saved.</strong> ' + esc(r.written) + ' new prices, ' + esc(r.duplicates) + ' already there' +
      (r.rejected ? ', ' + esc(r.rejected) + ' refused' : '') + '.</div>' +
      // The server's needsUnit counts rows with no per-unit price yet: a new, unlinked item has
      // no pack size, so it lands here even when its unit is printed. Say what to do, not "unit".
      (r.needsUnit ? '<p class="prl-dim">' + esc(r.needsUnit) + ' of them can not be compared yet: link each item to a product and set its pack size.</p>' : '') +
      '<div class="prl-actions"><button type="button" class="btn btn-ghost prl-btn" data-pri-action="close" data-prl-action="openUnlinked">Unlinked items</button>' +
      '<button type="button" class="ui-btn-quiet prl-btn" data-pri-action="another">Import another file</button></div>';
  }

  function paint() {
    const el = document.getElementById('priBody');
    if (!el || !S) return;
    el.innerHTML = S.loading ? '<div class="prl-empty">Loading…</div>' : S.result ? resultHtml() : S.preview ? previewHtml() : setupHtml() + docsHtml();
  }

  function fresh(keep) {
    return { supplierId: keep ? keep.supplierId : '', locationId: '', docKind: 'price_sheet', tax: '', docDateOn: today(), validThroughOn: '', docRef: '' };
  }

  async function open() {
    if (!PL() || !PL().enabled() || !PL().canSave() || !LG()) return;
    close();
    S = { f: fresh(), suppliers: [], known: {}, file: null, headerRow: 0, map: {}, preview: null, result: null, busy: false, error: '', loading: true, lastFocus: document.activeElement };
    const ov = document.createElement('div');
    ov.className = 'modal-bg open prl-bg';
    ov.id = 'priOverlay';
    ov.innerHTML = '<div class="modal prl-modal" role="dialog" aria-modal="true" aria-labelledby="priTitle">' +
      '<div class="prl-head"><h2 class="prl-title" id="priTitle">Import prices</h2><button type="button" class="prl-close" data-pri-action="close" aria-label="Close">✕</button></div>' +
      '<p class="prl-sub">A supplier\'s quote, price sheet or invoice: a CSV file, or a PDF or photo read for you. Internal only.</p><div id="priBody"></div></div>';
    document.body.appendChild(ov);
    paint();
    const closeBtn = ov.querySelector('.prl-close');
    if (closeBtn) closeBtn.focus();
    const [suppliers, offers, docs] = await Promise.all([PL().suppliers(), PL().allOffers(), typeof PL().priceDocs === 'function' ? PL().priceDocs() : Promise.resolve([])]);
    if (!S) return;
    S.suppliers = suppliers;
    S.docs = docs;
    offers.forEach((o) => { S.known[o.id] = true; });
    const first = suppliers.find((a) => a.active !== false);
    if (first) S.f.supplierId = first.supplierId || first.id;
    S.loading = false;
    paint();
  }
  function close() {
    const o = document.getElementById('priOverlay');
    if (o) o.remove();
    const back = S && S.lastFocus;
    S = null;
    if (back && typeof back.focus === 'function') { try { back.focus(); } catch (e) { /* re-rendered */ } }
  }

  function readSetup(form) {
    const fd = new FormData(form);
    ['supplierId', 'locationId', 'docKind', 'tax', 'docDateOn', 'validThroughOn', 'docRef'].forEach((k) => { if (fd.has(k)) S.f[k] = String(fd.get(k) || ''); });
    if (S.file) FIELDS.forEach(([k]) => { if (fd.has('map_' + k)) S.map[k] = Number(fd.get('map_' + k)); });
  }

  function onFile(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && !/csv/i.test(file.type || '')) { S.error = 'That is not a CSV file. Save it as CSV first (File, Save As, CSV).'; S.file = null; paint(); return; }
    const reader = new FileReader();
    reader.onload = () => {
      if (!S) return;
      const table = LG().parseCsv(String(reader.result || ''));
      if (!table.length) { S.error = 'That file is empty.'; S.file = null; paint(); return; }
      S.file = { name: file.name, table };
      S.headerRow = LG().guessHeaderRow(table);
      S.map = LG().guessColumns(table[S.headerRow]);
      S.error = '';
      paint();
    };
    reader.onerror = () => { if (S) { S.error = 'That file could not be read.'; paint(); } };
    reader.readAsText(file);
  }

  /**
   * A PDF or photo: the reader's lines become the same table a CSV would, with its
   * columns already matched, and the kind, dates, tax and number it read are filled in
   * for the person to check. Nothing is saved here.
   */
  async function onDoc(input) {
    const file = input.files && input.files[0];
    if (!file || S.busy) return;
    S.busy = true; S.error = ''; S.readNote = ''; S.reading = 'Reading ' + file.name + '… this can take half a minute.'; paint();
    const r = await PL().readDocument(file, S.f.supplierId);
    if (!S) return;
    S.busy = false; S.reading = '';
    if (!r || !r.ok) { S.error = (r && r.message) || 'That document could not be read.'; S.file = null; paint(); return; }
    const rd = r.read || {};
    const perText = (p) => (p === 100 ? 'C' : p === 1000 ? 'M' : '');
    const table = [['Item number', 'Description', 'Price', 'Unit', 'Per', 'Qty']].concat((rd.lines || []).map((l) => [l.sku || '', l.description || '', l.unitPrice || '', l.unit || '', perText(l.per), l.qty == null ? '' : String(l.qty)]));
    S.file = { name: file.name, table, docId: r.docId };
    S.headerRow = 0;
    S.map = { sku: 0, title: 1, price: 2, unit: 3, per: 4, qty: 5 };
    const f = S.f;
    if (KINDS[rd.docKind]) f.docKind = rd.docKind;
    if (rd.date) f.docDateOn = rd.date;
    f.validThroughOn = rd.validThrough || f.validThroughOn;
    f.tax = rd.taxIncluded === true ? 'yes' : (rd.taxIncluded === false ? 'no' : '');
    if (rd.docNumber) f.docRef = rd.docNumber;
    S.readNote = '<strong>' + esc(file.name) + '</strong>' + (r.existing ? ' was read before; its lines are below.' : ' was read.') +
      ' The kind, dates, tax and document number above were filled in from it: check each, then Preview.' +
      (rd.supplierName ? ' The document names the supplier "' + esc(rd.supplierName) + '"; make sure the supplier above is right.' : '') +
      ((rd.reasons || []).length ? '<br>The reader noted: ' + rd.reasons.map(esc).join('; ') : '') +
      (typeof r.spentUsd === 'number' && typeof r.capUsd === 'number' ? '<br>Document reading this month: $' + esc(r.spentUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' of $' + esc(r.capUsd) + '.' : '');
    if (!(rd.lines || []).length) S.error = 'No price lines were found on that document.';
    if (typeof PL().priceDocs === 'function') S.docs = await PL().priceDocs();
    if (!S) return;
    paint();
  }

  function preview(form) {
    readSetup(form);
    const f = S.f;
    const r = LG().buildImport(S.file.table, {
      supplierId: f.supplierId, docKind: f.docKind, docDateOn: f.docDateOn, validThroughOn: f.validThroughOn || null,
      taxIncluded: f.tax === 'yes' ? true : (f.tax === 'no' ? false : undefined), docRef: f.docRef, fileName: S.file.name,
      locationId: f.locationId || null, headerRow: S.headerRow, map: S.map, knownOfferIds: S.known, nowMs: Date.now(),
      importId: S.file.docId || null,
    });
    if (!r.ok) { S.error = REASONS[r.reason] || 'Check the details above.'; paint(); return; }
    S.error = ''; S.preview = r; paint();
  }

  const actions = {
    open,
    close,
    back() { S.preview = null; S.progress = ''; paint(); },
    another() { S.result = null; S.preview = null; S.file = null; S.readNote = ''; S.f = fresh(S.f); paint(); },
    async openDoc(t) {
      const d = (S.docs || []).find((x) => x.id === t.dataset.priId);
      const url = d && await PL().documentUrl(d.storagePath);
      if (!url) { toast('That document could not be opened.', 'error'); return; }
      w.open(url, '_blank', 'noopener');
    },
    async removeDoc(t) {
      const id = t.dataset.priId;
      const ask = w.nbdConfirm || ((m) => Promise.resolve(w.confirm(m)));
      if (!(await ask('Remove this document? Every price saved from it is voided (kept in the history, crossed out) and the stored file is deleted.')) || !S) return;
      t.disabled = true;
      const r = await PL().removeDocument(id);
      if (!S) return;
      if (!r.ok) { t.disabled = false; toast(r.message, 'error'); return; }
      toast('Document removed. ' + (r.voided || 0) + ' prices voided.', 'success');
      S.docs = await PL().priceDocs();
      if (S) paint();
    },
    async save() {
      if (S.busy || !S.preview) return;
      S.busy = true; S.progress = 'Saving…'; paint();
      const out = await PL().importRows(S.preview.rows, (done, total) => { if (S) { S.progress = 'Saved ' + done + ' of ' + total + '…'; paint(); } });
      if (!S) return;
      S.busy = false; S.progress = '';
      if (!out.ok) { toast(out.message || 'That did not go through. Try again.', 'error'); paint(); return; }
      S.preview.rows.forEach((row) => { S.known[row.offerId] = true; });
      S.result = out; paint();
      toast('Prices imported.', 'success');
    },
  };

  if (!w._NBD_PRI_DELEGATE) {
    w._NBD_PRI_DELEGATE = true;
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-pri-action]');
      if (t) {
        const fn = actions[t.dataset.priAction];
        if (typeof fn !== 'function' || (t.dataset.priAction !== 'open' && !S)) return;
        Promise.resolve().then(() => fn(t)).catch((e) => console.error('[price-import] ' + t.dataset.priAction + ' failed:', e));
        return;
      }
      if (ev.target && ev.target.id === 'priOverlay') close();
    });
    document.addEventListener('change', function (ev) {
      const el = ev.target;
      if (!S || !el || !el.dataset || !el.dataset.priChange) return;
      const form = el.closest && el.closest('form');
      if (el.dataset.priChange === 'file') { if (form) readSetup(form); S.readNote = ''; onFile(el); return; }
      if (el.dataset.priChange === 'doc') { if (form) readSetup(form); onDoc(el).catch((e) => console.error('[price-import] read failed:', e)); return; }
      if (el.dataset.priChange === 'header') {
        if (form) readSetup(form);
        const n = Math.floor(Number(el.value));
        if (S.file && n >= 1 && n <= S.file.table.length) { S.headerRow = n - 1; S.map = LG().guessColumns(S.file.table[S.headerRow]); }
        paint();
        return;
      }
      if (form) { readSetup(form); if (el.name === 'docKind' || el.name === 'supplierId') paint(); }
    });
    document.addEventListener('submit', function (ev) {
      const f = ev.target;
      if (!f || !f.dataset || f.dataset.priForm !== 'setup' || !S) return;
      ev.preventDefault();
      if (S.file) preview(f);
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && document.getElementById('priOverlay')) close(); });
  }

  w.NBDPriceImportUI = { open, close };
})();
