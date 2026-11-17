/**
 * price-compare-ui.js: "Compare suppliers" (2026-11-17, slice 3, flag supplierPricing).
 *
 * Two things, both worked out on screen from the stored offers (there is no server
 * job and no stored alert; NBDPriceLogic.supplierAlerts does the arithmetic):
 *   - the Product Library's "Compare suppliers" button (data-prc-action="open";
 *     owner and company admins only) with the count of open alerts on it, opening
 *     a list of price moves and cheaper suppliers, each with "Seen" (one shared
 *     list for the owner and admins; an alert comes back when a newer price lands)
 *   - productBlock(): the side-by-side table on a product's Stores & prices sheet,
 *     every supplier's current price per catalog unit, tax included, with fresh
 *     prices in full and older ones greyed, quote expiry, delivery fee and minimum
 *
 * Settings come from Company Settings → Supplier Price Compare
 * (companyProfile.pricing.supplierCompare): the purchase tax rate and the alert
 * threshold. Both are off until set; nothing here supplies a number of its own.
 * Nothing here changes a cost book, a sell price or an estimate.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const LG = () => w.NBDPriceLogic;
  const PL = () => w.NBDPriceLedger;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };
  const COUNT_TTL_MS = 60000;
  const KIND_SHORT = { paid: 'Paid', quote: 'Quote', contract: 'Contract', price_sheet: 'Price sheet', portal_read: 'Portal', manual: 'Note', api_account: 'Account', live_shelf: 'Shelf' };

  let S = null;
  let countCache = { at: 0, open: null, key: '' };

  const products = () => ((w._productLib && typeof w._productLib.getProducts === 'function') ? w._productLib.getProducts() : (w.NBD_PRODUCTS || [])) || [];
  // A tax-added price is shown to the cent (the stored prices keep every micro).
  const money = (m) => LG().microsToText(LG().centsToMicros(LG().microsToCents(m)));
  const unitLabel = (u) => (w.NBD_UNITS && w.NBD_UNITS[u] && w.NBD_UNITS[u].label) || String(u || '');
  const pct = (bps) => (Math.round(bps / 10) / 10) + '%';
  const dateText = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
  function todayMs() { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }
  function labelOf(accounts, id) {
    const a = (accounts || []).find((x) => x && (x.supplierId === id || x.id === id));
    if (a && a.label) return a.label;
    const reg = LG().supplierOf(id);
    return reg ? reg.label : String(id || '');
  }
  const centsText = (c) => LG().microsToText(LG().centsToMicros(c));

  /** "good for N more days", a warning in the last 7, "expired" after. Empty for a row with no end date. */
  function expiryHtml(validThroughMs) {
    const e = LG().quoteExpiryState(validThroughMs, todayMs());
    if (e.state === 'none') return '';
    if (e.state === 'expired') return ' <span class="ui-badge is-danger">Expired</span>';
    const words = e.daysLeft === 0 ? 'Last day' : 'Good for ' + e.daysLeft + ' more day' + (e.daysLeft === 1 ? '' : 's');
    return ' <span class="ui-badge ' + (e.state === 'warn' ? 'is-warn' : 'is-info') + '">' + esc(words) + '</span>';
  }

  function termsText(t) {
    if (!t) return '';
    const bits = [];
    if (t.deliveryFeeCents > 0) bits.push('delivery ' + centsText(t.deliveryFeeCents));
    if (t.minOrderCents > 0) bits.push('minimum order ' + centsText(t.minOrderCents));
    return bits.join(', ');
  }

  /**
   * The side-by-side block for one product's sheet. offers: the product's offers;
   * accounts: the company's supplier accounts. Owner and company admins only.
   */
  function productBlock(product, offers, accounts) {
    if (!LG() || !PL() || !PL().canSave() || !product) return '';
    const st = PL().compareSettings();
    const c = LG().compareProduct(product, offers || [], { nowMs: Date.now(), accounts, taxBps: st.taxBps, alertBps: st.alertBps });
    if (!c.rows.length) return '';
    const priced = c.rows.filter((r) => r.state === 'fresh' || r.state === 'stale').sort((a, b) => (b.fresh - a.fresh) || ((a.compareMicros || a.catalogMicros) - (b.compareMicros || b.catalogMicros)));
    const basis = st.taxBps === null ? 'as recorded' : 'tax included';
    const rows = priced.map((r) => '<div class="prc-row' + (r.fresh ? '' : ' is-stale') + '">' +
      '<div class="prc-main"><span class="prl-store">' + esc(labelOf(accounts, r.supplierId)) + '</span>' +
      (r.supplierId === c.usualSupplierId ? '<span class="ui-badge is-info">Usual</span> ' : '') +
      '<span class="ui-money">' + esc(money(r.compareMicros !== null ? r.compareMicros : r.catalogMicros)) + '</span> per ' + esc(unitLabel(c.unit)) +
      (r.compareMicros === null ? ' <span class="prl-dim">(' + (r.taxIncluded ? 'tax included' : 'before tax') + ', not compared)</span>' : '') + '</div>' +
      '<div class="prl-src">' + esc(KIND_SHORT[r.kind] || r.kind) + ' · ' + esc(dateText(r.observedAtMs)) + (r.fresh ? '' : ' · too old to compare') +
      expiryHtml(r.validThroughMs) + (termsText(r.terms) ? ' · ' + esc(termsText(r.terms)) : '') + '</div></div>').join('');
    const notes = [];
    if (c.needsPack) notes.push(c.needsPack + ' item' + (c.needsPack === 1 ? ' needs a pack size' : 's need a pack size') + ' before ' + (c.needsPack === 1 ? 'it' : 'they') + ' can be compared.');
    if (c.needsTaxRate) notes.push('Some prices include tax and some do not. Set your purchase tax rate in Company Settings (Supplier Price Compare) to compare them.');
    if (c.alert) notes.push(labelOf(accounts, c.alert.supplierId) + ' is ' + pct(c.alert.downBps) + ' cheaper than your usual supplier.');
    return '<div class="prc-block"><h3 class="prl-h3">Suppliers side by side <span class="prl-dim">(per ' + esc(unitLabel(c.unit)) + ', ' + esc(basis) + ')</span></h3>' +
      (rows || '<div class="prl-dim">No supplier has a price for this product yet.</div>') +
      notes.map((n) => '<div class="prl-note">' + esc(n) + '</div>').join('') + '</div>';
  }

  async function load() {
    const [accounts, offers, seen] = await Promise.all([PL().suppliers(), PL().allOffers(), PL().seenMarks()]);
    const settings = PL().compareSettings();
    const res = LG().supplierAlerts({ products: products(), offers, accounts, settings, seen, nowMs: Date.now() });
    return { accounts, offers, settings, res };
  }

  /** Fill the open-alert count on the Product Library button (cached for a minute). */
  async function refreshCount(force) {
    try {
      const el = document.querySelector('[data-prc-count]');
      if (!el || !PL() || !PL().enabled() || !PL().canSave() || !LG()) return;
      const key = String(PL().companyKey());
      if (!force && countCache.key === key && Date.now() - countCache.at < COUNT_TTL_MS && countCache.open !== null) { paintCount(el, countCache.open); return; }
      const { res } = await load();
      countCache = { at: Date.now(), open: res.open, key };
      const now = document.querySelector('[data-prc-count]');
      if (now) paintCount(now, res.open);
    } catch (e) { console.warn('[price-compare] count:', e && e.message); }
  }
  function paintCount(el, n) {
    el.textContent = n > 0 ? String(n) : '';
    el.hidden = !(n > 0);
    const btn = el.closest && el.closest('button');
    if (btn) btn.setAttribute('aria-label', 'Compare suppliers' + (n > 0 ? ', ' + n + ' open alert' + (n === 1 ? '' : 's') : ''));
  }

  function alertHtml(a) {
    const p = products().find((x) => x && x.id === a.productId);
    const name = p ? p.name : (a.productId || 'An item not linked to a product');
    const offer = (S.offers || []).find((o) => o.id === a.offerId) || {};
    const per = p && p.unit && (a.type === 'cheaper' || (offer.pack && offer.pack.catalogUnit)) ? ' per ' + unitLabel(p.unit) : '';
    const text = a.type === 'cheaper'
      ? labelOf(S.accounts, a.supplierId) + ' is ' + pct(a.downBps) + ' cheaper than your usual supplier, ' + labelOf(S.accounts, a.usualSupplierId) + ': ' + money(a.newMicros) + ' against ' + money(a.oldMicros) + per + '.'
      : labelOf(S.accounts, a.supplierId) + '\'s price for ' + (offer.title || 'this item') + ' is up ' + pct(a.upBps) + ' on what you last paid: ' + money(a.newMicros) + ' against ' + money(a.oldMicros) + per + '.';
    return '<div class="prl-offer' + (a.seen ? ' is-seen' : '') + '">' +
      '<div class="prl-otitle"><span class="ui-badge ' + (a.type === 'cheaper' ? 'is-success' : 'is-warn') + '">' + (a.type === 'cheaper' ? 'Cheaper elsewhere' : 'Price went up') + '</span> ' + esc(name) + '</div>' +
      '<div class="prl-src">' + esc(text) + (a.type === 'cheaper' ? (S.settings.taxBps === null ? ' (as recorded)' : ' (tax included)') : '') + '</div>' +
      '<div class="prl-actions">' + (a.productId ? '<button type="button" class="btn btn-ghost prl-btn" data-prc-action="close" data-prl-action="openProduct" data-prl-id="' + esc(a.productId) + '">Open the product</button>' : '') +
      (a.seen ? '' : '<button type="button" class="ui-btn-quiet prl-btn" data-prc-action="seen" data-prc-id="' + esc(a.id) + '" data-prc-obs="' + esc(a.obsId) + '">Seen</button>') + '</div></div>';
  }

  function bodyHtml() {
    if (S.loading) return '<div class="prl-empty">Loading…</div>';
    const r = S.res, st = S.settings, notes = [];
    if (st.alertBps === null) notes.push('Alerts are off. Set an alert threshold in Company Settings (Supplier Price Compare) to turn them on.');
    if (st.taxBps === null) notes.push('No purchase tax rate is set, so prices with and without tax are not compared. Set it in Company Settings (Supplier Price Compare).');
    if (r.needsPack) notes.push(r.needsPack + ' item' + (r.needsPack === 1 ? ' needs a pack size' : 's need a pack size') + ' before ' + (r.needsPack === 1 ? 'it' : 'they') + ' can be compared.');
    const open = r.alerts.filter((a) => !a.seen), seen = r.alerts.filter((a) => a.seen);
    return notes.map((n) => '<div class="prl-note">' + esc(n) + '</div>').join('') +
      (open.length ? open.map(alertHtml).join('') : '<div class="prl-empty">No open alerts. Only fresh prices count: paid in the last 60 days, a quote still good, an account price from the last 7 days.</div>') +
      (seen.length ? '<details class="prc-seen"><summary>' + seen.length + ' seen</summary>' + seen.map(alertHtml).join('') + '</details>' : '');
  }
  function paint() { const el = document.getElementById('prcBody'); if (el && S) el.innerHTML = bodyHtml(); }

  async function open() {
    if (!PL() || !PL().enabled() || !PL().canSave() || !LG()) return;
    close();
    S = { loading: true, lastFocus: document.activeElement };
    const ov = document.createElement('div');
    ov.className = 'modal-bg open prl-bg';
    ov.id = 'prcOverlay';
    ov.innerHTML = '<div class="modal prl-modal" role="dialog" aria-modal="true" aria-labelledby="prcTitle">' +
      '<div class="prl-head"><h2 class="prl-title" id="prcTitle">Compare suppliers</h2><button type="button" class="prl-close" data-prc-action="close" aria-label="Close">✕</button></div>' +
      '<p class="prl-sub">Prices that went up since you last paid, and products another supplier sells for less than your usual one. Internal only.</p><div id="prcBody"></div></div>';
    document.body.appendChild(ov);
    paint();
    const closeBtn = ov.querySelector('.prl-close');
    if (closeBtn) closeBtn.focus();
    const data = await load();
    if (!S) return;
    Object.assign(S, data, { loading: false });
    countCache = { at: Date.now(), open: data.res.open, key: String(PL().companyKey()) };
    paint();
  }
  function close() {
    const o = document.getElementById('prcOverlay');
    if (o) o.remove();
    const back = S && S.lastFocus;
    S = null;
    const el = document.querySelector('[data-prc-count]');
    if (el && countCache.open !== null) paintCount(el, countCache.open);
    if (back && typeof back.focus === 'function') { try { back.focus(); } catch (e) { /* re-rendered */ } }
  }

  const actions = {
    open,
    close,
    async seen(t) {
      const id = t.dataset.prcId, obs = t.dataset.prcObs;
      t.disabled = true;
      const r = await PL().markSeen(id, obs);
      if (!S) return;
      if (!r.ok) { t.disabled = false; toast(r.message, 'error'); return; }
      const a = S.res.alerts.find((x) => x.id === id);
      if (a) { a.seen = true; S.res.open = S.res.alerts.filter((x) => !x.seen).length; countCache.open = S.res.open; }
      paint();
    },
  };

  if (!w._NBD_PRC_DELEGATE) {
    w._NBD_PRC_DELEGATE = true;
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-prc-action]');
      if (t) {
        const fn = actions[t.dataset.prcAction];
        if (typeof fn !== 'function' || (t.dataset.prcAction !== 'open' && !S)) return;
        Promise.resolve().then(() => fn(t)).catch((e) => console.error('[price-compare] ' + t.dataset.prcAction + ' failed:', e));
        return;
      }
      if (ev.target && ev.target.id === 'prcOverlay') close();
    });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && document.getElementById('prcOverlay')) close(); });
  }

  w.NBDPriceCompareUI = { open, close, refreshCount, productBlock, expiryHtml };
})();
