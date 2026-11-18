/**
 * price-offers-ui.js: the "Stores & prices" sheet (2026-11-17, flag supplierPricing).
 *
 * The Product Library's "Unlinked items" button (data-prl-action="openUnlinked",
 * slice 2) opens the same sheet as a list of receipt items no product is linked
 * to yet; the owner or an admin links each to a product. Slice 3: each one shows a
 * suggested product (SKU match first, else name match) that links with one tap; the
 * picker is still there to choose another. A product's sheet also shows its suppliers
 * side by side and each quote's "good for N more days" (js/price-compare-ui.js).
 *
 * Opened from a product card (data-prl-action="openProduct"). For one product it
 * shows the store and supplier items linked to it, each with its pack size, its
 * current price with the source and date, and (for the owner, an admin or a
 * manager) the dated history. The owner or an admin can add a store or supplier,
 * add an item, set and confirm the pack size, type a price and void a wrong row.
 * A manager can type a price, which is saved as a note until an owner confirms it.
 *
 * Rules this file keeps:
 *   - every price on screen shows where it came from and when; a missing price
 *     says "No price yet", never 0. Nothing is invented or interpolated
 *   - every store or supplier string goes through esc() before it reaches the page,
 *     attributes included; a link is drawn only when it is https on that
 *     supplier's own host (NBDPriceLogic.urlAllowedFor)
 *   - nothing here changes a cost book, a sell price or an estimate
 *   - one document-level click delegate on data-prl-action; no inline handlers,
 *     no inline style
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const LG = () => w.NBDPriceLogic;
  const PL = () => w.NBDPriceLedger;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const DAY_MS = 86400000;

  const KIND_LABELS = { paid: 'Paid (receipt or invoice)', quote: 'Quote', contract: 'Contract price', price_sheet: 'Price sheet', portal_read: 'Read on my account portal', manual: 'Note (no paperwork)', api_account: 'Account price (API)', live_shelf: 'Shelf price today' };
  const KIND_SHORT = { paid: 'Paid', quote: 'Quote', contract: 'Contract', price_sheet: 'Price sheet', portal_read: 'Portal', manual: 'Note', api_account: 'Account', live_shelf: 'Shelf' };
  const LEVELS = {
    1: { text: 'Current', cls: 'is-success' },
    2: { text: 'Account price, this week', cls: 'is-info' },
    3: { text: 'Paid, over 60 days ago', cls: 'is-warn' },
    4: { text: 'Quote expired', cls: 'is-warn' },
    5: { text: 'Not confirmed', cls: 'is-danger' },
  };
  const UNIT_WORDS = { BDL: 'bundle', RL: 'roll', BX: 'box', PC: 'piece', EA: 'each', SHT: 'sheet', SQ: 'square', LF: 'linear foot', SF: 'square foot', GAL: 'gallon', PAIL: 'pail', TUBE: 'tube', BAG: 'bag', CTN: 'carton', PLT: 'pallet', LB: 'pound' };
  const PRICE_TYPES = { account: 'My account price', net: 'Net price', list: 'List price', promo: 'Sale or promo price' };
  const DOC_TYPES = { none: 'No document', receipt: 'Receipt', invoice: 'Invoice', quote: 'Quote', price_sheet: 'Price sheet', contract: 'Contract', portal: 'Account portal' };

  let S = null;

  const today = () => { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  function productOf(id) {
    const list = (w._productLib && typeof w._productLib.getProducts === 'function') ? w._productLib.getProducts() : (w.NBD_PRODUCTS || []);
    return (list || []).find((p) => p && p.id === id) || null;
  }
  function supplierLabel(id) {
    const a = (S.suppliers || []).find((x) => x.supplierId === id || x.id === id);
    if (a && a.label) return a.label;
    const reg = LG().supplierOf(id);
    return reg ? reg.label : String(id || '');
  }
  const accountOf = (id) => (S.suppliers || []).find((x) => x.supplierId === id || x.id === id) || null;
  const quoteDays = (supplierId) => { const a = accountOf(supplierId); return (a && a.terms && a.terms.quoteValidDays) || undefined; };
  const unitWord = (u) => UNIT_WORDS[u] || String(u || '');
  const catalogUnitLabel = (u) => (w.NBD_UNITS && w.NBD_UNITS[u] && w.NBD_UNITS[u].label) || String(u || '');
  const money = (m) => LG().microsToText(m);
  function ageText(ms) {
    if (!ms) return '';
    const days = Math.floor((Date.now() - ms) / DAY_MS);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return days + ' days ago';
  }
  const dateText = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');

  // Is the offer's pack still about this product's unit? (The product's unit can be changed.)
  function packState(offer) {
    const p = offer.pack || {};
    if (!LG().validPack(p)) return 'needs_unit';
    if (S.product && S.product.unit && p.catalogUnit !== S.product.unit) return 'unit_changed';
    return 'ok';
  }
  function packLine(offer) {
    const p = offer.pack || {}, st = packState(offer);
    if (st === 'needs_unit') return '<span class="ui-badge is-warn">Needs a unit</span> <span class="prl-dim">Set the pack size to compare this price with the product.</span>';
    if (st === 'unit_changed') return '<span class="ui-badge is-danger">The product\'s unit changed</span> <span class="prl-dim">Set the pack size again.</span>';
    const ratio = p.den === 1 ? String(p.num) : p.num + '/' + p.den;
    return '1 ' + esc(unitWord(p.purchaseUnit)) + ' = ' + esc(ratio) + ' ' + esc(catalogUnitLabel(p.catalogUnit)) +
      (p.verified ? ' <span class="ui-badge is-success">Confirmed</span>' : ' <span class="ui-badge is-warn">Not confirmed</span>');
  }
  function statedText(r) {
    const per = r.per === 100 ? ' per 100 ' : r.per === 1000 ? ' per 1,000 ' : ' per ';
    return esc(money(r.priceMicros)) + esc(per) + esc(r.statedUnit ? unitWord(r.statedUnit) + (r.per > 1 ? 's' : '') : 'unit not stated');
  }
  function levelBadge(r, supplierId) {
    const lv = LG().evidenceLevel({ kind: r.kind, observedAtMs: r.observedAtMs, validThroughMs: r.validThroughMs }, Date.now(), quoteDays(supplierId));
    const L = LEVELS[lv] || LEVELS[5];
    return '<span class="ui-badge ' + L.cls + '">' + esc(L.text) + '</span>';
  }
  function perCatalog(offer, r) {
    if (packState(offer) !== 'ok') return '';
    // A summary point (latest.best, latest.lastPaid) carries no channel; its
    // per-unit price was already derived by the server from the current pack.
    const c = (r.source == null && r.statedUnit == null) ? { micros: typeof r.catalogMicros === 'number' ? r.catalogMicros : null, flag: null } : LG().catalogMicrosFor(r, offer);
    if (c.micros === null) return c.flag === 'unit_mismatch' ? '<span class="prl-dim">Unit does not match this item</span>' : '';
    return '<span class="ui-money">' + esc(money(c.micros)) + '</span> per ' + esc(catalogUnitLabel(offer.pack.catalogUnit));
  }

  function bestBlock(offer) {
    const b = offer.latest && offer.latest.best;
    if (!b) return '<div class="prl-noprice">No price yet</div>';
    return '<div class="prl-best">' +
      '<div class="prl-price"><span class="ui-money">' + statedText(b) + '</span>' + (perCatalog(offer, b) ? ' <span class="prl-dim">·</span> ' + perCatalog(offer, b) : '') + '</div>' +
      '<div class="prl-src">' + esc(KIND_SHORT[b.kind] || b.kind) + ' · ' + esc(dateText(b.observedAtMs)) + ' (' + esc(ageText(b.observedAtMs)) + ')' +
      (b.taxIncluded ? ' · tax included' : ' · before tax') + ' ' + levelBadge(b, offer.supplierId) +
      (w.NBDPriceCompareUI ? w.NBDPriceCompareUI.expiryHtml(b.validThroughMs) : '') + '</div></div>';
  }

  function historyBlock(offer) {
    const rows = S.history[offer.id];
    if (rows === undefined) return '';
    if (rows === null) return '<div class="prl-hist"><div class="prl-dim">Loading the history…</div></div>';
    if (!rows.length) return '<div class="prl-hist"><div class="prl-dim">No prices recorded for this item yet.</div></div>';
    const canVoid = PL().canSave();
    return '<div class="prl-hist">' + rows.map((r) => {
      const kind = (KIND_SHORT[r.kind] || r.kind) + (r.claimedKind ? ' (typed as ' + (KIND_SHORT[r.claimedKind] || r.claimedKind) + ', waiting for an owner)' : '');
      const doc = r.doc && r.doc.ref ? ' · ' + (DOC_TYPES[r.doc.type] || 'Document') + ' ' + r.doc.ref : '';
      const loc = r.locationId ? ' · branch ' + r.locationId : '';
      return '<div class="prl-hrow' + (r.voided ? ' is-void' : '') + '">' +
        '<div class="prl-hmain"><span class="ui-money">' + statedText(r) + '</span>' + (perCatalog(offer, r) ? ' <span class="prl-dim">·</span> ' + perCatalog(offer, r) : '') + '</div>' +
        '<div class="prl-src">' + esc(r.observedOn || dateText(r.observedAtMs)) + ' · ' + esc(kind) + esc(loc) + esc(doc) + ' · as of ' + esc(ageText(r.observedAtMs)) + ' ' +
        (r.voided ? '<span class="ui-badge is-danger">Voided</span>' + (r.voidReason ? ' <span class="prl-dim">' + esc(r.voidReason) + '</span>' : '') : levelBadge(r, offer.supplierId)) + '</div>' +
        (r.note ? '<div class="prl-dim">' + esc(r.note) + '</div>' : '') +
        (canVoid && !r.voided ? '<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="voidRow" data-prl-id="' + esc(r.obsId) + '" data-prl-offer="' + esc(offer.id) + '">Void this row</button>' : '') +
        '</div>';
    }).join('') + '</div>';
  }

  function offerCard(offer) {
    const admin = PL().canSave(), staff = PL().canRecord();
    const link = (offer.url && LG().urlAllowedFor(offer.supplierId, offer.url)) ? ' · <a href="' + esc(offer.url) + '" target="_blank" rel="noopener noreferrer">open at the supplier</a>' : '';
    const st = packState(offer);
    const btns = [];
    if (staff) btns.push('<button type="button" class="btn btn-ghost prl-btn" data-prl-action="showAddPrice" data-prl-id="' + esc(offer.id) + '">Add a price</button>');
    if (staff) btns.push('<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="toggleHistory" data-prl-id="' + esc(offer.id) + '">' + (S.history[offer.id] !== undefined ? 'Hide history' : 'History') + '</button>');
    if (admin) btns.push('<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="showPack" data-prl-id="' + esc(offer.id) + '">' + (st === 'ok' ? 'Change pack size' : 'Set pack size') + '</button>');
    if (admin && st === 'ok' && !offer.pack.verified) btns.push('<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="confirmPack" data-prl-id="' + esc(offer.id) + '">Confirm pack size</button>');
    if (admin && offer.latest && offer.latest.bestComparable) btns.unshift('<button type="button" class="btn btn-orange prl-btn" data-prl-action="showCost" data-prl-id="' + esc(offer.id) + '">Update my cost</button>');
    if (admin) btns.push('<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="archive" data-prl-id="' + esc(offer.id) + '">Remove</button>');
    return '<div class="prl-offer">' +
      '<div class="prl-otitle"><span class="prl-store">' + esc(supplierLabel(offer.supplierId)) + '</span>' + esc(offer.title) + '</div>' +
      '<div class="prl-src">' + (offer.sku ? 'SKU ' + esc(offer.sku) : 'No SKU') + link + '</div>' +
      '<div class="prl-pack">' + packLine(offer) + '</div>' +
      bestBlock(offer) +
      '<div class="prl-actions">' + btns.join('') + '</div>' +
      costPanelHtml(offer) +
      (S.form && S.form.offerId === offer.id ? formHtml() : '') +
      historyBlock(offer) +
      '</div>';
  }

  // ── Slice 4: Update my cost (a supplier price into the cost book, line by line) ──
  const TIER_WORDS = { good: 'Good', better: 'Better', best: 'Best' };
  const COST_REASONS = {
    no_price: 'No price to use yet.',
    not_paperwork: 'Only your own paperwork can update a cost: a receipt, invoice, quote, price sheet or account price an owner or admin entered.',
    price_type: 'A list or sale price can not update your cost.',
    delivered: 'A delivered price includes delivery, so it can not update your cost.',
    not_comparable: 'This price can not be used for cost changes.',
    unit_suspect: 'This price looks like it was entered in the wrong unit. Check it or void it first.',
    stale: 'This price is too old to trust. Get a current receipt or quote first.',
    needs_pack: 'Confirm the pack size first.',
    unit_changed: 'The product\'s unit changed. Set the pack size again first.',
    needs_tax_rate: 'Set your purchase sales tax rate first (Company Settings, Supplier Price Compare).',
    no_cost_book: 'Open the Product Library once on the owner\'s device so your costs are saved, then try again.',
    below_one_cent: 'That cost rounds to less than one cent.',
    no_change: 'Your cost book already has this cost.',
    changed: 'Something changed since this was shown. Look again.',
  };
  const centsText = (c) => (typeof c === 'number' ? (c < 0 ? '-' : '') + money(LG().centsToMicros(Math.abs(c))) : '');
  function tierTicks(selected) {
    const sel = (selected && selected.length) ? selected : ['good'];
    return '<fieldset class="prl-field prl-ticks"><legend class="prl-label">This item is for the tiers</legend>' +
      ['good', 'better', 'best'].map((t) => '<label class="prl-tick"><input type="checkbox" name="tier" value="' + t + '"' + (sel.indexOf(t) !== -1 ? ' checked' : '') + '> ' + esc(TIER_WORDS[t]) + '</label>').join('') +
      '<span class="prl-hint">Update my cost changes only the ticked tiers.</span></fieldset>';
  }
  const tiersFrom = (fd) => fd.getAll('tier').filter((t) => TIER_WORDS[t]);

  /** The approval panel's lines, built on this device with the same code the server runs again. */
  function buildCost(offer, row) {
    const PLx = PL(), CC = w.NBDCatalogCosts;
    const acct = accountOf(offer.supplierId);
    const r = Object.assign({}, row, { catalogMicros: offer.latest && offer.latest.bestComparable ? offer.latest.bestComparable.catalogMicros : null });
    return LG().proposalLines({
      product: S.product || {}, offer, row: r, book: (CC && typeof CC.get === 'function') ? CC.get() : null,
      taxBps: PLx.compareSettings().taxBps, floorTenths: LG().marginFloorTenths(w._companyProfile || {}),
      nowMs: Date.now(), quoteValidDays: acct && acct.terms && acct.terms.quoteValidDays,
    });
  }
  function costLineHtml(l, ticked) {
    const g = l.guard, can = !l.blocked;
    const ct = l.fromCents === null || l.toCents === null ? null : LG().changeTenths(l.fromCents, l.toCents);
    const plus = (n) => (n > 0 ? '+' : '');
    const change = (l.fromCents === null) ? 'no cost set before' : (plus(l.toCents - l.fromCents) + centsText(l.toCents - l.fromCents) + (ct === null ? '' : ' (' + plus(ct) + LG().tenthsText(ct) + ')'));
    const margin = g.marginAfter === null ? '<span class="prl-dim">No sell price on this tier, so no margin to show.</span>'
      : 'Margin after labor: ' + (g.marginBefore === null ? '' : esc(LG().tenthsText(g.marginBefore)) + ' → ') + '<strong>' + esc(LG().tenthsText(g.marginAfter)) + '</strong>' + (g.laborKnown ? '' : ' <span class="prl-dim">(no labor set)</span>');
    const warns = [];
    if (can && g.aboveSell) warns.push('<span class="ui-badge is-danger">Cost is above the sell</span>');
    if (can && g.belowFloor) warns.push('<span class="ui-badge is-warn">Under your margin floor</span>');
    return '<div class="prl-hrow">' +
      (can ? '<label class="prl-tick"><input type="checkbox" data-prl-change="costTick" value="' + esc(l.tier) + '"' + (ticked ? ' checked' : '') + '> <strong>' + esc(TIER_WORDS[l.tier]) + '</strong></label>' : '<strong>' + esc(TIER_WORDS[l.tier]) + '</strong>') +
      '<div class="prl-hmain">Was ' + (l.fromCents === null ? 'not set' : '<span class="ui-money">' + esc(centsText(l.fromCents)) + '</span>') +
      (l.toCents === null ? '' : ' · now <span class="ui-money">' + esc(centsText(l.toCents)) + '</span> · ' + esc(change)) + '</div>' +
      (l.toCents === null ? '' : '<div class="prl-src">' + margin + (warns.length ? ' ' + warns.join(' ') : '') + '</div>') +
      (l.blocked ? '<div class="prl-dim">' + esc(COST_REASONS[l.blocked] || 'This line can not be approved.') + '</div>' : '') +
      '</div>';
  }
  function costPanelHtml(offer) {
    const c = S.cost;
    if (!c || c.offerId !== offer.id) return '';
    if (c.loading) return '<div class="prl-form"><div class="prl-dim">Checking this price…</div></div>';
    const built = c.built, can = built.lines.filter((l) => !l.blocked);
    return '<div class="prl-form">' +
      '<h3 class="prl-h3">Update my cost</h3>' +
      '<div class="prl-hint">The new cost is this price per ' + esc(catalogUnitLabel(offer.pack && offer.pack.catalogUnit)) + (c.row && c.row.taxIncluded ? ' (tax included)' : ' with your sales tax added') +
      '. Only the cost changes: no sell price, labor or estimate moves.</div>' +
      (built.blocked && COST_REASONS[built.blocked] ? '<div class="prl-note">' + esc(COST_REASONS[built.blocked]) + '</div>' : '') +
      '<div class="prl-hist">' + built.lines.map((l) => costLineHtml(l, c.ticks[l.tier] === true)).join('') + '</div>' +
      '<div class="prl-actions">' + (can.length ? '<button type="button" class="btn btn-orange prl-btn" data-prl-action="approveCost"' + (S.busy ? ' disabled' : '') + '>Approve</button>' : '') +
      '<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="cancelCost">Cancel</button></div>' +
      (S.error ? '<div class="prl-error" role="alert">' + esc(S.error) + '</div>' : '') +
      '</div>';
  }
  /** Above the items: a tier whose cost is above its sell (Q5), and the last approved change per tier with Undo (Q8). */
  function costNotesHtml() {
    const p = S.product, out = [];
    if (!p) return '';
    ['good', 'better', 'best'].forEach((t) => {
      const tp = p.pricing && p.pricing[t];
      if (tp && typeof tp.cost === 'number' && typeof tp.sell === 'number' && tp.sell > 0 && tp.cost > tp.sell) out.push('<div class="prl-note">' + esc(TIER_WORDS[t]) + ': the cost is above the sell price. Raise the sell in the product to make money on this tier.</div>');
    });
    const applied = (S.link && S.link.applied) || {};
    if (PL().canSave()) {
      ['good', 'better', 'best'].forEach((t) => {
        const a = applied[t];
        if (!a || a.undo === true || typeof a.dollars !== 'number') return;
        const cur = p.pricing && p.pricing[t] && p.pricing[t].cost;
        if (typeof cur !== 'number' || LG().dollarsToMicros(cur) !== LG().dollarsToMicros(a.dollars)) return;
        out.push('<div class="prl-src">' + esc(TIER_WORDS[t]) + ' cost updated from a supplier price ' + esc(ageText(a.atMs)) + ': ' +
          (typeof a.fromDollars === 'number' ? esc(money(LG().dollarsToMicros(a.fromDollars))) : 'not set') + ' → ' + esc(money(LG().dollarsToMicros(a.dollars))) +
          ' <button type="button" class="ui-btn-quiet prl-btn" data-prl-action="undoCost" data-prl-id="' + esc(t) + '" data-prl-audit="' + esc(a.auditId) + '">Undo</button></div>');
      });
    }
    return out.join('');
  }

  const opt = (value, label, selected) => '<option value="' + esc(value) + '"' + (selected ? ' selected' : '') + '>' + esc(label) + '</option>';
  const field = (label, control, hint) => '<label class="prl-field"><span class="prl-label">' + esc(label) + '</span>' + control + (hint ? '<span class="prl-hint">' + esc(hint) + '</span>' : '') + '</label>';
  const unitOptions = (selected) => LG().UNITS.map((u) => opt(u, unitWord(u) + ' (' + u + ')', u === selected)).join('');

  function packFields(purchaseUnit, pack) {
    const cu = S.product ? S.product.unit : '';
    const sug = LG().suggestPack(purchaseUnit, cu, S.product && S.product.coverage);
    const num = pack && pack.num ? pack.num : (sug ? sug.num : '');
    const den = pack && pack.den ? pack.den : (sug ? sug.den : '');
    const hint = sug ? 'Suggested from the product: 1 ' + unitWord(purchaseUnit) + ' = ' + (sug.den === 1 ? sug.num : sug.num + '/' + sug.den) + ' ' + catalogUnitLabel(cu) + '. Change it if your supplier packs it differently.'
      : 'How many ' + catalogUnitLabel(cu) + ' is one ' + unitWord(purchaseUnit) + '? Leave both blank if you do not know yet.';
    return '<div class="prl-row2">' +
      field('One ' + unitWord(purchaseUnit) + ' covers', '<input class="prl-input" name="num" inputmode="numeric" pattern="[0-9]*" value="' + esc(num) + '" autocomplete="off">') +
      field('out of (divide by)', '<input class="prl-input" name="den" inputmode="numeric" pattern="[0-9]*" value="' + esc(den) + '" autocomplete="off">') +
      '</div><div class="prl-hint" id="prlPackHint">' + esc(hint) + '</div>';
  }

  function formHtml() {
    const f = S.form;
    if (!f) return '';
    const busy = S.busy ? ' disabled' : '';
    const foot = '<div class="prl-actions"><button type="submit" class="btn btn-orange prl-btn"' + busy + '>' + esc(f.submit) + '</button>' +
      '<button type="button" class="ui-btn-quiet prl-btn" data-prl-action="cancelForm">Cancel</button></div>' +
      (S.error ? '<div class="prl-error" role="alert">' + esc(S.error) + '</div>' : '');
    if (f.type === 'supplier') {
      const reg = LG().SUPPLIERS;
      const have = (S.suppliers || []).map((a) => a.supplierId || a.id);
      const options = Object.keys(reg).filter((id) => id !== 'other' && have.indexOf(id) === -1).map((id) => opt(id, reg[id].label)).join('') + opt('custom', 'Another store or supplier (name it)');
      return '<form class="prl-form" data-prl-form="supplier" novalidate>' +
        '<h3 class="prl-h3">Add a store or supplier</h3>' +
        field('Store or supplier', '<select class="prl-input" name="supplierId">' + options + '</select>') +
        field('Name (only for another store or supplier)', '<input class="prl-input" name="label" maxlength="60" autocomplete="off">') +
        field('Kind (only for another store or supplier)', '<select class="prl-input" name="type">' + opt('distributor', 'Distributor') + opt('retail', 'Retail store') + '</select>') +
        field('Your usual branch or store (optional)', '<input class="prl-input" name="branch" maxlength="60" autocomplete="off">', 'For example the town, or the store number.') +
        foot + '</form>';
    }
    if (f.type === 'offer') {
      const accts = S.suppliers || [];
      return '<form class="prl-form" data-prl-form="offer" novalidate>' +
        '<h3 class="prl-h3">Add an item this product is bought as</h3>' +
        field('Store or supplier', '<select class="prl-input" name="supplierId">' + accts.map((a) => opt(a.supplierId || a.id, a.label || a.supplierId)).join('') + '</select>') +
        field('Their name for the item', '<input class="prl-input" name="title" maxlength="160" required autocomplete="off">') +
        field('SKU or item number (optional)', '<input class="prl-input" name="sku" maxlength="40" autocomplete="off">') +
        field('Link to the item (optional)', '<input class="prl-input" name="url" type="url" maxlength="500" autocomplete="off">', 'An https link on that supplier\'s own site.') +
        field('Sold by the', '<select class="prl-input" name="purchaseUnit" data-prl-change="packUnit">' + unitOptions('EA') + '</select>') +
        '<div id="prlPackFields">' + packFields('EA', null) + '</div>' +
        tierTicks(['good']) +
        foot + '</form>';
    }
    const offer = (S.offers || []).find((o) => o.id === f.offerId) || {};
    if (f.type === 'link') {
      const products = (((w._productLib && typeof w._productLib.getProducts === 'function') ? w._productLib.getProducts() : (w.NBD_PRODUCTS || [])) || [])
        .filter((p) => p && p.id && p.isActive !== false)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      return '<form class="prl-form" data-prl-form="link" novalidate>' +
        '<h3 class="prl-h3">Link to a product</h3>' +
        field('Product in your library', '<select class="prl-input" name="productId" required>' + opt('', 'Choose…', true) + products.map((p) => opt(p.id, (p.name || p.id) + (p.unit ? ' (per ' + catalogUnitLabel(p.unit) + ')' : ''))).join('') + '</select>',
          'After linking, open the product\'s Stores & prices to set the pack size.') +
        tierTicks(offer.tiers) +
        foot + '</form>';
    }
    if (f.type === 'pack') {
      const pu = (offer.pack && offer.pack.purchaseUnit) || 'EA';
      return '<form class="prl-form" data-prl-form="pack" novalidate>' +
        '<h3 class="prl-h3">Pack size</h3>' +
        field('Sold by the', '<select class="prl-input" name="purchaseUnit" data-prl-change="packUnit">' + unitOptions(pu) + '</select>') +
        '<div id="prlPackFields">' + packFields(pu, packState(offer) === 'ok' ? offer.pack : null) + '</div>' +
        tierTicks(offer.tiers) +
        foot + '</form>';
    }
    // price
    const acct = accountOf(offer.supplierId);
    const locs = (acct && acct.locations) || [];
    const pu = (offer.pack && offer.pack.purchaseUnit) || 'EA';
    const kinds = LG().CALLER_KINDS.map((k) => opt(k, KIND_LABELS[k], k === 'paid')).join('');
    return '<form class="prl-form" data-prl-form="price" novalidate>' +
      '<h3 class="prl-h3">Add a price</h3>' +
      (PL().canSave() ? '' : '<div class="prl-note">Saved as a note until an owner confirms it.</div>') +
      field('Where the price comes from', '<select class="prl-input" name="kind">' + kinds + '</select>') +
      '<div class="prl-row2">' +
      field('Price', '<input class="prl-input" name="priceText" inputmode="decimal" required autocomplete="off" placeholder="0.00">') +
      field('For one', '<select class="prl-input" name="statedUnit">' + unitOptions(pu) + '</select>', 'The unit printed on the document.') +
      '</div><div class="prl-row2">' +
      field('Priced per', '<select class="prl-input" name="per">' + opt('1', 'one') + opt('100', '100 (per C)') + opt('1000', '1,000 (per M)') + '</select>') +
      field('Kind of price', '<select class="prl-input" name="priceType">' + Object.keys(PRICE_TYPES).map((k) => opt(k, PRICE_TYPES[k])).join('') + '</select>') +
      '</div>' +
      field('Is sales tax in this price?', '<select class="prl-input" name="tax" required>' + opt('', 'Choose…', true) + opt('no', 'No, before tax') + opt('yes', 'Yes, tax included') + '</select>') +
      '<div class="prl-row2">' +
      field('Date on the document', '<input class="prl-input" name="observedOn" type="date" required value="' + esc(today()) + '" max="' + esc(today()) + '">') +
      field('Good through (quotes)', '<input class="prl-input" name="validThroughOn" type="date">') +
      '</div><div class="prl-row2">' +
      field('Document', '<select class="prl-input" name="docType">' + Object.keys(DOC_TYPES).map((k) => opt(k, DOC_TYPES[k])).join('') + '</select>') +
      field('Document number (optional)', '<input class="prl-input" name="docRef" maxlength="80" autocomplete="off">') +
      '</div>' +
      (locs.length ? field('Branch', '<select class="prl-input" name="locationId">' + opt('', 'Not stated') + locs.map((l) => opt(l.id, l.label || l.id, l.preferred === true)).join('') + '</select>') : '') +
      field('Note (optional)', '<input class="prl-input" name="note" maxlength="200" autocomplete="off">') +
      foot + '</form>';
  }

  // The "Unlinked items" list: receipt lines for SKUs no product is linked to yet.
  function unlinkedHtml() {
    const admin = PL().canSave();
    const offers = (S.offers || []).filter((o) => o.active !== false);
    if (!offers.length) return '<div class="prl-empty">Nothing is waiting to be linked. Items from your store receipts show up here until they are linked to a product.</div>';
    const products = admin ? allProducts() : [];
    return offers.map((o) => {
      const lp = o.latest && o.latest.lastPaid;
      // A suggestion only: nothing links until the owner or an admin taps it.
      const sug = admin ? LG().suggestLink(o, products) : null;
      const sp = sug ? products.find((p) => p.id === sug.productId) : null;
      return '<div class="prl-offer">' +
        '<div class="prl-otitle"><span class="prl-store">' + esc(supplierLabel(o.supplierId)) + '</span>' + esc(o.title) + '</div>' +
        '<div class="prl-src">' + (o.sku ? 'SKU ' + esc(o.sku) : 'No SKU') + '</div>' +
        (lp ? '<div class="prl-best"><div class="prl-price"><span class="ui-money">' + statedText(lp) + '</span></div>' +
          '<div class="prl-src">Last paid · ' + esc(dateText(lp.observedAtMs)) + ' (' + esc(ageText(lp.observedAtMs)) + ') · as printed on the receipt</div></div>'
          : '<div class="prl-noprice">No price yet</div>') +
        (sp ? '<div class="prl-src">Suggested: <strong>' + esc(sp.name || sp.id) + '</strong> <span class="ui-badge ' + (sug.kind === 'sku' ? 'is-success">SKU match' : 'is-info">Name match') + '</span></div>' : '') +
        (admin ? '<div class="prl-actions">' + (sp ? '<button type="button" class="btn btn-orange prl-btn" data-prl-action="acceptSuggest" data-prl-id="' + esc(o.id) + '" data-prl-product="' + esc(sp.id) + '">Link to ' + esc(sp.name || sp.id) + '</button>' : '') +
          '<button type="button" class="' + (sp ? 'ui-btn-quiet' : 'btn btn-ghost') + ' prl-btn" data-prl-action="showLink" data-prl-id="' + esc(o.id) + '">' + (sp ? 'Choose another product' : 'Link to a product') + '</button></div>' : '') +
        (S.form && S.form.offerId === o.id ? formHtml() : '') +
        '</div>';
    }).join('');
  }

  function allProducts() {
    return (((w._productLib && typeof w._productLib.getProducts === 'function') ? w._productLib.getProducts() : (w.NBD_PRODUCTS || [])) || []).filter((p) => p && p.id && p.isActive !== false);
  }

  function bodyHtml() {
    if (S.loading) return '<div class="prl-empty">Loading…</div>';
    if (S.mode === 'unlinked') return unlinkedHtml();
    const admin = PL().canSave();
    const offers = (S.offers || []).filter((o) => o.active !== false);
    const top = [];
    if (admin && (S.suppliers || []).length) top.push('<button type="button" class="btn btn-orange prl-btn" data-prl-action="showAddOffer">Add an item</button>');
    if (admin) top.push('<button type="button" class="' + ((S.suppliers || []).length ? 'ui-btn-quiet' : 'btn btn-orange') + ' prl-btn" data-prl-action="showAddSupplier">Add a store or supplier</button>');
    const empty = offers.length ? '' : '<div class="prl-empty">' + ((S.suppliers || []).length
      ? 'No store or supplier item is linked to this product yet.' + (admin ? ' Add the item the way your supplier lists it, then type what you paid or were quoted.' : '')
      : (admin ? 'Start by adding a store or supplier you buy from.' : 'No stores or suppliers have been added yet. An owner or admin adds them.')) + '</div>';
    return '<div class="prl-actions">' + top.join('') + '</div>' +
      (S.form && !S.form.offerId ? formHtml() : '') +
      costNotesHtml() +
      (w.NBDPriceCompareUI ? w.NBDPriceCompareUI.productBlock(S.product, offers, S.suppliers) : '') +
      empty + offers.map(offerCard).join('');
  }

  function paint() {
    const el = document.getElementById('prlBody');
    if (el && S) el.innerHTML = bodyHtml();
  }

  async function reload() {
    const [suppliers, offers, links] = await Promise.all([PL().suppliers(), S.mode === 'unlinked' ? PL().unlinked() : PL().offersFor([S.productId]),
      (S.mode !== 'unlinked' && PL().canSave() && typeof PL().productLinks === 'function') ? PL().productLinks() : Promise.resolve([])]);
    if (!S) return;
    S.suppliers = suppliers; S.offers = offers; S.loading = false;
    S.link = (links || []).find((l) => l && l.id === S.productId) || null;
    if (S.productId) S.product = productOf(S.productId) || S.product;
    paint();
  }

  async function openProduct(productId) {
    if (!PL() || !PL().enabled() || !LG()) return;
    close();
    const product = productOf(productId);
    S = { productId, product, suppliers: [], offers: [], history: {}, form: null, cost: null, link: null, busy: false, error: '', loading: true, lastFocus: document.activeElement };
    const ov = document.createElement('div');
    ov.className = 'modal-bg open prl-bg';
    ov.id = 'prlOverlay';
    ov.innerHTML = '<div class="modal prl-modal" role="dialog" aria-modal="true" aria-labelledby="prlTitle">' +
      '<div class="prl-head"><h2 class="prl-title" id="prlTitle">Stores &amp; prices</h2><button type="button" class="prl-close" data-prl-action="close" aria-label="Close">✕</button></div>' +
      '<p class="prl-sub">' + esc(product ? product.name : 'This product') + (product && product.unit ? ' · priced per ' + esc(catalogUnitLabel(product.unit)) : '') + '. What your stores and suppliers charge you for it. Internal only.</p>' +
      '<div id="prlBody"></div></div>';
    document.body.appendChild(ov);
    paint();
    const closeBtn = ov.querySelector('.prl-close');
    if (closeBtn) closeBtn.focus();
    await reload();
  }
  /** The list of items no product is linked to yet (the Product Library's "Unlinked items" button). */
  async function openUnlinked() {
    if (!PL() || !PL().enabled() || !LG()) return;
    close();
    S = { mode: 'unlinked', productId: null, product: null, suppliers: [], offers: [], history: {}, form: null, busy: false, error: '', loading: true, lastFocus: document.activeElement };
    const ov = document.createElement('div');
    ov.className = 'modal-bg open prl-bg';
    ov.id = 'prlOverlay';
    ov.innerHTML = '<div class="modal prl-modal" role="dialog" aria-modal="true" aria-labelledby="prlTitle">' +
      '<div class="prl-head"><h2 class="prl-title" id="prlTitle">Unlinked items</h2><button type="button" class="prl-close" data-prl-action="close" aria-label="Close">✕</button></div>' +
      '<p class="prl-sub">Things on your store receipts that are not linked to a product in your library yet. Link one and its prices show on that product. Internal only.</p>' +
      '<div id="prlBody"></div></div>';
    document.body.appendChild(ov);
    paint();
    const closeBtn = ov.querySelector('.prl-close');
    if (closeBtn) closeBtn.focus();
    await reload();
  }
  function close() {
    const o = document.getElementById('prlOverlay');
    if (o) o.remove();
    const back = S && S.lastFocus;
    S = null;
    if (back && typeof back.focus === 'function') { try { back.focus(); } catch (e) { /* the card was re-rendered */ } }
  }

  function setForm(form) { S.form = form; S.error = ''; S.busy = false; paint(); const first = document.querySelector('#prlBody .prl-form .prl-input'); if (first) first.focus(); }

  const actions = {
    openProduct,
    openUnlinked,
    close,
    cancelForm() { setForm(null); },
    showLink(id) { setForm({ type: 'link', offerId: id, submit: 'Link' }); },
    async acceptSuggest(id, el) {
      const productId = el && el.dataset.prlProduct;
      if (!productId) return;
      if (el) el.disabled = true;
      const r = await PL().linkOffer(id, productId, 'exact');
      if (!S) return;
      if (!r.ok) { if (el) el.disabled = false; toast(r.message, 'error'); return; }
      toast('Linked. Open that product\'s Stores & prices to set the pack size.', 'success');
      await reload();
    },
    async showCost(id) {
      const offer = (S.offers || []).find((o) => o.id === id);
      const point = offer && offer.latest && offer.latest.bestComparable;
      if (!offer || !point) return;
      S.form = null; S.error = '';
      S.cost = { offerId: id, loading: true, ticks: {} };
      paint();
      const row = (await PL().observation(point.obsId)) || point;
      if (!S || !S.cost || S.cost.offerId !== id) return;
      S.cost.row = row; S.cost.obsId = point.obsId;
      S.cost.built = buildCost(offer, row);
      S.cost.built.lines.forEach((l) => { if (!l.blocked) S.cost.ticks[l.tier] = true; });
      S.cost.loading = false;
      paint();
    },
    cancelCost() { S.cost = null; S.error = ''; paint(); },
    async approveCost(_id, el, confirmed) {
      const c = S.cost;
      if (!c || c.loading || S.busy) return;
      const lines = c.built.lines.filter((l) => !l.blocked && c.ticks[l.tier] === true);
      if (!lines.length) { S.error = 'Tick at least one tier to update.'; paint(); return; }
      const below = lines.some((l) => l.guard.belowFloor), above = lines.some((l) => l.guard.aboveSell);
      const ask = w.nbdConfirm || ((m) => Promise.resolve(w.confirm(m)));
      if (confirmed !== true && (below || above)) {
        const yes = await ask((above ? 'This cost is above the sell price' : 'This takes the margin after labor under your floor') + '. Approve anyway?');
        if (!yes || !S || S.cost !== c) return;
      }
      S.busy = true; S.error = ''; paint();
      const r = await PL().approveCost({ productId: S.productId, offerId: c.offerId, obsId: c.obsId,
        lines: lines.map((l) => ({ tier: l.tier, fromCents: l.fromCents, toCents: l.toCents })),
        confirmBelowFloor: below || confirmed === true, confirmAboveSell: above || confirmed === true });
      if (!S) return;
      S.busy = false;
      if (!r.ok && (r.reason === 'confirm_floor' || r.reason === 'confirm_above_sell') && confirmed !== true) {
        // The server reads the company's own sell, which can differ from this device's: ask, then send again.
        paint();
        if (await ask(r.message + ' Approve anyway?') && S && S.cost === c) return actions.approveCost(null, el, true);
        return;
      }
      if (!r.ok) { S.error = r.message || 'That did not go through. Try again.'; paint(); return; }
      S.cost = null;
      toast('Cost updated. Your other devices pick it up the next time they load.', 'success');
      await reload();
    },
    async undoCost(tier, el) {
      const auditId = el && el.dataset.prlAudit;
      if (!auditId) return;
      const ask = w.nbdConfirm || ((m) => Promise.resolve(w.confirm(m)));
      if (!(await ask('Put the ' + (TIER_WORDS[tier] || tier) + ' cost back to what it was?')) || !S) return;
      const r = await PL().undoCost(S.productId, tier, auditId);
      if (!S) return;
      if (!r.ok) { toast(r.message, 'error'); await reload(); return; }
      toast('Cost put back.', 'success');
      await reload();
    },
    async openCost(productId, el) {
      const offerId = el && el.dataset.prlOffer;
      await openProduct(productId);
      if (S && offerId && PL().canSave()) await actions.showCost(offerId);
    },
    showAddSupplier() { setForm({ type: 'supplier', submit: 'Save' }); },
    showAddOffer() { setForm({ type: 'offer', submit: 'Save item' }); },
    showAddPrice(id) { setForm({ type: 'price', offerId: id, submit: 'Save price' }); },
    showPack(id) { setForm({ type: 'pack', offerId: id, submit: 'Save pack size' }); },
    async toggleHistory(id) {
      if (S.history[id] !== undefined) { delete S.history[id]; paint(); return; }
      S.history[id] = null; paint();
      const rows = await PL().history(id);
      if (!S) return;
      S.history[id] = rows; paint();
    },
    async confirmPack(id) {
      const r = await PL().verifyPack(id);
      if (!S) return;
      if (!r.ok) { toast(r.message, 'error'); return; }
      toast('Pack size confirmed.', 'success');
      await reload();
    },
    async archive(id) {
      const r = await PL().archiveOffer(id, false);
      if (!S) return;
      if (!r.ok) { toast(r.message, 'error'); return; }
      toast('Item removed from this product. Its price history is kept.', 'success');
      await reload();
    },
    async voidRow(obsId, el) {
      const offerId = el && el.dataset.prlOffer;
      const r = await PL().voidObservation(obsId, 'Voided on the Stores & prices sheet');
      if (!S) return;
      if (!r.ok) { toast(r.message, 'error'); return; }
      toast('Row voided. It stays in the history, crossed out.', 'success');
      if (offerId) S.history[offerId] = await PL().history(offerId);
      await reload();
    },
  };

  const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 24);
  const wholeOrNull = (v) => { const t = String(v == null ? '' : v).trim(); return /^[0-9]{1,6}$/.test(t) ? Number(t) : null; };
  function packFrom(fd) {
    const purchaseUnit = fd.get('purchaseUnit');
    const cu = S.product ? S.product.unit : null;
    const numText = String(fd.get('num') || '').trim(), denText = String(fd.get('den') || '').trim();
    if (!numText && !denText) return { pack: { purchaseUnit, catalogUnit: cu, status: 'unknown' } };
    const num = wholeOrNull(numText), den = wholeOrNull(denText);
    if (!num || !den) return { error: 'Type the pack size as two whole numbers above zero, or leave both blank.' };
    const sug = LG().suggestPack(purchaseUnit, cu, S.product && S.product.coverage);
    const basis = (sug && sug.num === num && sug.den === den) ? sug.basis : 'owner_entered';
    return { pack: { purchaseUnit, catalogUnit: cu, num, den, status: 'known', basis } };
  }

  async function submit(form) {
    if (!S || S.busy) return;
    const fd = new FormData(form), kind = form.dataset.prlForm;
    const fail = (msg) => { S.error = msg; S.busy = false; paint(); };
    S.busy = true; S.error = '';
    let r;
    if (kind === 'supplier') {
      let supplierId = fd.get('supplierId'), label = String(fd.get('label') || '').trim();
      const data = { active: true };
      if (supplierId === 'custom') {
        if (slug(label).length < 2) return fail('Give the store or supplier a name.');
        supplierId = 'other_' + slug(label); data.label = label; data.type = fd.get('type');
      }
      data.supplierId = supplierId;
      const branch = String(fd.get('branch') || '').trim();
      if (branch) data.locations = [{ id: 'main', label: branch, preferred: true }];
      r = await PL().saveAccount(data);
    } else if (kind === 'offer') {
      const p = packFrom(fd);
      if (p.error) return fail(p.error);
      const title = String(fd.get('title') || '').trim();
      if (!title) return fail('Give the item a name.');
      const tiers = tiersFrom(fd);
      if (!tiers.length) return fail('Tick at least one tier this item is for.');
      r = await PL().saveOffer({ supplierId: fd.get('supplierId'), sku: String(fd.get('sku') || '').trim(), title, url: String(fd.get('url') || '').trim() || null, productId: S.productId, tiers, pack: p.pack });
    } else if (kind === 'link') {
      const productId = String(fd.get('productId') || '');
      if (!productId) return fail('Choose the product this item is.');
      const tiers = tiersFrom(fd);
      if (!tiers.length) return fail('Tick at least one tier this item is for.');
      r = await PL().linkOffer(S.form.offerId, productId, 'exact', tiers);
      if (r && r.ok) r.message = 'Linked. Open that product\'s Stores & prices to set the pack size.';
    } else if (kind === 'pack') {
      const p = packFrom(fd);
      if (p.error) return fail(p.error);
      const offer = (S.offers || []).find((o) => o.id === S.form.offerId);
      if (!offer) return fail('That item was not found. Close this and open it again.');
      r = await PL().saveOffer({ offerId: offer.id, supplierId: offer.supplierId, sku: offer.sku, skuKind: offer.skuKind, altIds: offer.altIds, title: offer.title, brand: offer.brand, url: offer.url, productId: offer.productId, variant: offer.variant, tiers: tiersFrom(fd).length ? tiersFrom(fd) : offer.tiers, match: offer.match, watch: offer.watch, active: offer.active, pack: p.pack });
    } else if (kind === 'price') {
      const tax = fd.get('tax');
      if (tax !== 'yes' && tax !== 'no') return fail('Say whether sales tax is in this price.');
      if (LG().moneyTextToMicros(fd.get('priceText')) === null) return fail('Type the price as a number, like 11.11.');
      const res = await PL().record([{
        offerId: S.form.offerId, kind: fd.get('kind'), priceText: fd.get('priceText'), per: Number(fd.get('per')) || 1,
        statedUnit: fd.get('statedUnit'), uomRaw: fd.get('statedUnit'), priceType: fd.get('priceType'), taxIncluded: tax === 'yes',
        observedOn: fd.get('observedOn'), validThroughOn: fd.get('validThroughOn') || null,
        doc: { type: fd.get('docType'), ref: String(fd.get('docRef') || '').trim() },
        locationId: fd.get('locationId') || null, note: String(fd.get('note') || '').trim(),
      }]);
      const one = (res.results || [])[0] || {};
      if (res.ok && one.status === 'duplicate') r = { ok: true, message: 'That price was already recorded.' };
      else if (res.ok && one.status === 'written') r = { ok: true, message: one.needsUnit ? 'Price saved. Set the pack size to compare it with the product.' : 'Price saved.' };
      else r = { ok: false, message: res.message || REASON_TEXT[one.reason] || 'That price could not be saved. Check the unit and the date.' };
    }
    if (!S) return;
    if (!r || !r.ok) return fail((r && r.message) || 'That did not go through. Try again.');
    const offerId = S.form && S.form.offerId;
    S.form = null; S.busy = false;
    toast(r.message || 'Saved.', 'success');
    if (offerId && S.history[offerId] !== undefined) S.history[offerId] = await PL().history(offerId);
    await reload();
  }
  const REASON_TEXT = {
    needs_unit: 'Pick the unit printed on the document.', bad_date: 'Check the date: it can not be in the future.', bad_valid_through: 'Check the good-through date.',
    unknown_location: 'That branch is not on this supplier.', unknown_offer: 'That item was not found. Close this and open it again.', bad_price: 'Type the price as a number, like 11.11.',
  };

  if (!w._NBD_PRL_DELEGATE) {
    w._NBD_PRL_DELEGATE = true;
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-prl-action]');
      if (t) {
        const fn = actions[t.dataset.prlAction];
        if (typeof fn !== 'function') return;
        if (t.dataset.prlAction !== 'openProduct' && t.dataset.prlAction !== 'openUnlinked' && t.dataset.prlAction !== 'openCost' && !S) return;
        try { Promise.resolve(fn(t.dataset.prlId, t)).catch((e) => console.error('[price-offers-ui] ' + t.dataset.prlAction + ' failed:', e)); }
        catch (e) { console.error('[price-offers-ui] ' + t.dataset.prlAction + ' failed:', e); }
        return;
      }
      if (ev.target && ev.target.id === 'prlOverlay') close();
    });
    document.addEventListener('submit', function (ev) {
      const f = ev.target;
      if (!f || !f.dataset || !f.dataset.prlForm) return;
      ev.preventDefault();
      submit(f).catch((e) => console.error('[price-offers-ui] save failed:', e));
    });
    document.addEventListener('change', function (ev) {
      const el = ev.target;
      if (S && el && el.dataset && el.dataset.prlChange === 'costTick' && S.cost) { S.cost.ticks[el.value] = el.checked === true; return; }
      if (!S || !el || !el.dataset || el.dataset.prlChange !== 'packUnit') return;
      const box = document.getElementById('prlPackFields');
      if (box) box.innerHTML = packFields(el.value, null);
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && document.getElementById('prlOverlay')) close(); });
  }

  w.NBDPriceOffersUI = { open: openProduct, openUnlinked, close, _internal: { buildCost: (offer, row, state) => { const keep = S; S = state; try { return buildCost(offer, row); } finally { S = keep; } }, costNotesHtml: (state) => { const keep = S; S = state; try { return costNotesHtml(); } finally { S = keep; } }, costPanelHtml: (offer, state) => { const keep = S; S = state; try { return costPanelHtml(offer); } finally { S = keep; } }, packState: (offer, product) => { const keep = S; S = { product }; try { return packState(offer); } finally { S = keep; } } } };
})();
