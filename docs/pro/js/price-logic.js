/**
 * price-logic.js (screen copy): pure logic for the supplier price ledger
 * (js/price-ledger.js and js/price-offers-ui.js, 2026-11). Exposes window.NBDPriceLogic.
 *
 * The block between the SHARED markers is a byte-for-byte copy of the same block in
 * functions/price-logic.js. tests/price-logic-2026-11.test.js fails if the two drift
 * apart, so units, money, the evidence ladder, the ranking and the sanitizers behave
 * the same on the server and on the phone. Edit the server file first, then run
 * node scripts/sync-price-logic.js.
 *
 * Nothing here reads or writes anything, and no price is ever invented: a missing
 * conversion is null, never a guess.
 */
(function () {
  'use strict';
  var root = typeof window !== 'undefined' ? window : globalThis;

// ---- BEGIN SHARED (copied byte-for-byte into docs/pro/js/price-logic.js; tests/price-logic-2026-11 parity) ----
var FLAG_NAME = 'supplierPricing';
var FLAG_DEFAULT = false;

var PL_DAY_MS = 86400000;
var PL_MAX_PRICE_MICROS = 100000000000;   // 10^11 micro-dollars
var PL_MAX_PACK_NUM = 100000;
var PL_MAX_PACK_DEN = 10000;
var PL_PAID_FRESH_DAYS = 60;
var PL_PORTAL_FRESH_DAYS = 7;
var PL_QUOTE_VALID_DAYS = 30;
var PL_SUMMARY_ROWS = 200;
var PL_RECENT_MAX = 8;

// The integrations the product knows. Which ones a tenant uses is its supplierAccounts.
var SUPPLIERS = {
  homedepot: { label: 'Home Depot', type: 'retail', skuKinds: ['store_sku', 'internet_sku'], hosts: ['homedepot.com'] },
  lowes: { label: "Lowe's", type: 'retail', skuKinds: ['item_number', 'model'], hosts: ['lowes.com'] },
  menards: { label: 'Menards', type: 'retail', skuKinds: ['store_sku'], hosts: ['menards.com'] },
  abc: { label: 'ABC Supply', type: 'distributor', skuKinds: ['item_number'], hosts: ['abcsupply.com'] },
  srs: { label: 'SRS Distribution', type: 'distributor', skuKinds: ['item_number'], hosts: ['roofhub.pro', 'srsdistribution.com'] },
  qxo: { label: 'QXO (Beacon)', type: 'distributor', skuKinds: ['item_number'], hosts: ['qxo.com'] },
  gulfeagle: { label: 'Gulfeagle Supply', type: 'distributor', skuKinds: ['item_number'], hosts: ['gulfeaglesupply.com'] },
  mbs: { label: 'Modern Builders Supply', type: 'distributor', skuKinds: ['item_number'], hosts: ['modernbuilderssupply.com'] },
  other: { label: 'Other', type: 'either', skuKinds: [], hosts: [] }
};
var PL_OTHER_ID = /^other_[a-z0-9]{2,24}$/;

/** The registry row for a supplier id (`other_<slug>` shares the `other` row), or null. */
function supplierOf(id) {
  var s = String(id == null ? '' : id);
  if (Object.prototype.hasOwnProperty.call(SUPPLIERS, s)) return SUPPLIERS[s];
  return PL_OTHER_ID.test(s) ? SUPPLIERS.other : null;
}

// Stated and purchase units. Catalog units are the keys of NBD_UNITS and are NOT
// the same strings (the catalog says BDNL for a bundle, and CT is "Container"),
// so unit equality is never a string compare: it goes through CATALOG_UNIT_OF.
var UNITS = ['BDL', 'RL', 'BX', 'PC', 'EA', 'SHT', 'SQ', 'LF', 'SF', 'GAL', 'PAIL', 'TUBE', 'BAG', 'CTN', 'PLT', 'LB'];
var CATALOG_UNIT_OF = { BDL: 'BDNL', RL: 'RL', BX: 'BX', PC: 'PC', EA: 'EA', SQ: 'SQ', LF: 'LF', SF: 'SF', GAL: 'GAL', TUBE: 'TUBE', BAG: 'BAG' };
var NO_PURCHASE_TWIN = ['CT', 'HR', 'RM', 'JOB', 'DAY'];
var PL_UOM_ALIASES = {
  BDL: ['BDL', 'BD', 'BNDL', 'BUNDLE', 'BUNDLES', 'BDLE'],
  RL: ['RL', 'ROLL', 'ROLLS', 'RO'],
  BX: ['BX', 'BOX', 'BOXES'],
  PC: ['PC', 'PCS', 'PIECE', 'PIECES'],
  EA: ['EA', 'EACH'],
  SHT: ['SHT', 'SHEET', 'SHEETS', 'SH'],
  SQ: ['SQ', 'SQUARE', 'SQUARES'],
  LF: ['LF', 'LINFT', 'LIN FT', 'LINEAR FT', 'LINEAR FOOT', 'LINEAR FEET', 'FT'],
  SF: ['SF', 'SQFT', 'SQ FT', 'SQUARE FOOT', 'SQUARE FEET'],
  GAL: ['GAL', 'GALLON', 'GALLONS', 'GA'],
  PAIL: ['PAIL', 'PAILS', 'PL'],
  TUBE: ['TUBE', 'TUBES', 'TB'],
  BAG: ['BAG', 'BAGS', 'BG'],
  CTN: ['CTN', 'CARTON', 'CARTONS'],
  PLT: ['PLT', 'PALLET', 'PALLETS', 'PAL'],
  LB: ['LB', 'LBS', 'POUND', 'POUNDS']
};

/**
 * A supplier's unit text to { unit, per }. `per` is 1, 100 ("per C") or 1000
 * ("per M"). `unit` is null when the text names only a per-hundred or
 * per-thousand basis. Text nobody knows returns null: there is no default unit.
 */
function normaliseUom(text) {
  var t = String(text == null ? '' : text).toUpperCase().replace(/[.\s]+/g, ' ').replace(/^\s+|\s+$/g, '');
  if (!t) return null;
  var per = 1;
  var m = /(?:^|\s)(?:PER|\/)\s*(C|100|M|1000)$/.exec(t) || /\/(C|100|M|1000)$/.exec(t);
  if (m) {
    per = (m[1] === 'C' || m[1] === '100') ? 100 : 1000;
    t = t.slice(0, m.index).replace(/^\s+|\s+$/g, '');
    if (!t) return { unit: null, per: per };
  }
  t = t.replace(/^(?:PER|\/)\s*/, '');
  for (var i = 0; i < UNITS.length; i++) {
    if (PL_UOM_ALIASES[UNITS[i]].indexOf(t) !== -1) return { unit: UNITS[i], per: per };
  }
  return null;
}

/** Is this purchase unit the same thing as this catalog unit? Never a string compare. */
function sameUnit(purchaseUnit, catalogUnit) {
  return Object.prototype.hasOwnProperty.call(CATALOG_UNIT_OF, purchaseUnit) && CATALOG_UNIT_OF[purchaseUnit] === catalogUnit;
}

function plIsPosInt(n) { return typeof n === 'number' && isFinite(n) && Math.floor(n) === n && n > 0; }

/** A pack with a usable conversion: one purchase unit = num / den catalog units. */
function validPack(pack) {
  return !!pack && pack.status === 'known' && UNITS.indexOf(pack.purchaseUnit) !== -1
    && typeof pack.catalogUnit === 'string' && pack.catalogUnit.length > 0
    && plIsPosInt(pack.num) && pack.num <= PL_MAX_PACK_NUM && plIsPosInt(pack.den) && pack.den <= PL_MAX_PACK_DEN;
}

function plGcd(a, b) { while (b) { var t = a % b; a = b; b = t; } return a; }

/**
 * A suggested conversion, or null. Always `verified: false`: it is saved only when a
 * person accepts it. Same unit is 1 to 1 and coverage is ignored (a roll bought for a
 * product priced per roll is not "squares per roll").
 */
function suggestPack(purchaseUnit, catalogUnit, coverage) {
  if (UNITS.indexOf(purchaseUnit) === -1 || !catalogUnit) return null;
  if (sameUnit(purchaseUnit, catalogUnit)) return { num: 1, den: 1, basis: 'same_unit', verified: false };
  var c = coverage || {};
  if (purchaseUnit === 'BDL' && catalogUnit === 'SQ' && plIsPosInt(c.bundlesPerSq) && c.bundlesPerSq <= PL_MAX_PACK_DEN) {
    return { num: 1, den: c.bundlesPerSq, basis: 'seed_coverage', verified: false };
  }
  if (purchaseUnit === 'RL' && catalogUnit === 'SQ' && typeof c.sqPerRoll === 'number' && c.sqPerRoll > 0) {
    var hundredths = Math.round(c.sqPerRoll * 100);
    var g = plGcd(hundredths, 100);
    var num = hundredths / g, den = 100 / g;
    if (plIsPosInt(num) && num <= PL_MAX_PACK_NUM) return { num: num, den: den, basis: 'seed_coverage', verified: false };
  }
  return null;
}

/**
 * A decimal string ("11.1111", "$1,111.00") to integer micro-dollars by digit
 * arithmetic: up to six decimals, no float. Anything else is null.
 */
function moneyTextToMicros(text) {
  var t = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
  if (t.charAt(0) === '$') t = t.slice(1).replace(/^\s+/, '');
  if (/^\d{1,3}(,\d{3})+(\.\d{1,6})?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(t)) return null;
  var parts = t.split('.');
  var frac = (parts[1] || '');
  while (frac.length < 6) frac += '0';
  var micros = Number(parts[0]) * 1000000 + Number(frac);
  return (Number.isSafeInteger(micros) && micros <= PL_MAX_PRICE_MICROS) ? micros : null;
}
function centsToMicros(c) { return c * 10000; }
function microsToCents(m) { return Math.round(m / 10000); }

/**
 * Micro-dollars as text for a screen: "$1,111.00". A price that is not a whole
 * number of cents keeps four decimals ("$0.1111"). Not a number: an empty string,
 * so a missing price is never shown as $0.00.
 */
function microsToText(m) {
  if (typeof m !== 'number' || !Number.isSafeInteger(m) || m < 0) return '';
  var places = (m % 10000 === 0) ? 2 : 4;
  var unit = places === 2 ? 10000 : 100;
  var scaled = Math.round(m / unit), per = places === 2 ? 100 : 10000;
  var whole = Math.floor(scaled / per), frac = String(scaled % per);
  while (frac.length < places) frac = '0' + frac;
  return '$' + String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + frac;
}

/**
 * A stated price to the price of ONE catalog unit: { micros, flag }.
 *   pack unknown                      -> null
 *   stated per the purchase unit      -> price * den / (num * per)
 *   stated per the catalog unit       -> price / per, flag stated_per_catalog_unit
 *   any other unit                    -> null, flag unit_mismatch
 */
function toCatalogMicros(priceMicros, per, statedUnit, pack) {
  if (!validPack(pack)) return { micros: null, flag: null };
  if (!plIsPosInt(priceMicros) || priceMicros > PL_MAX_PRICE_MICROS) return { micros: null, flag: null };
  if (per !== 1 && per !== 100 && per !== 1000) return { micros: null, flag: null };
  if (statedUnit === pack.purchaseUnit) {
    var top = priceMicros * pack.den, bottom = pack.num * per;
    if (!Number.isSafeInteger(top) || !Number.isSafeInteger(bottom)) return { micros: null, flag: null };
    return { micros: Math.round(top / bottom), flag: null };
  }
  if (sameUnit(statedUnit, pack.catalogUnit)) return { micros: Math.round(priceMicros / per), flag: 'stated_per_catalog_unit' };
  return { micros: null, flag: 'unit_mismatch' };
}

/**
 * Does this price look like a per-<unit A> price entered as per-<unit B>?
 * With a reference: the new price over the reference is within 15% of num/den or
 * den/num. Skipped when the pack ratio is close to 1 (up to 6 to 5 either way),
 * where it would fire on ordinary price moves. With no reference: above the
 * product's sell, or below 5% of it.
 */
function suspectUnitSwap(newCatalogMicros, referenceMicros, pack, sellMicros) {
  if (!plIsPosInt(newCatalogMicros)) return false;
  if (plIsPosInt(referenceMicros)) {
    if (!validPack(pack)) return false;
    var k = pack.num / pack.den;
    if (Math.max(pack.num, pack.den) * 5 <= Math.min(pack.num, pack.den) * 6) return false;
    var r = newCatalogMicros / referenceMicros;
    return Math.abs(r - k) <= 0.15 * k || Math.abs(r - 1 / k) <= 0.15 / k;
  }
  if (plIsPosInt(sellMicros)) return newCatalogMicros > sellMicros || newCatalogMicros * 20 < sellMicros;
  return false;
}

var KINDS = ['paid', 'quote', 'contract', 'price_sheet', 'portal_read', 'manual', 'api_account', 'live_shelf'];
var CALLER_KINDS = ['paid', 'quote', 'contract', 'price_sheet', 'portal_read', 'manual'];
var PL_PAPER_KINDS = ['paid', 'quote', 'contract', 'price_sheet', 'portal_read', 'api_account'];
var PL_DATED_KINDS = ['quote', 'contract', 'price_sheet'];

function plQuoteDays(d) { return (plIsPosInt(d) && d <= 365) ? d : PL_QUOTE_VALID_DAYS; }

/** Evidence level 1 (best) to 5. Every kind and age has exactly one level. */
function evidenceLevel(obs, nowMs, quoteValidDays) {
  var kind = obs && obs.kind, age = nowMs - (obs ? obs.observedAtMs : 0);
  if (kind === 'paid') return age <= PL_PAID_FRESH_DAYS * PL_DAY_MS ? 1 : 3;
  if (PL_DATED_KINDS.indexOf(kind) !== -1) {
    if (typeof obs.validThroughMs === 'number') return obs.validThroughMs >= nowMs ? 1 : 4;
    return age <= plQuoteDays(quoteValidDays) * PL_DAY_MS ? 1 : 4;
  }
  if (kind === 'portal_read' || kind === 'api_account') return age <= PL_PORTAL_FRESH_DAYS * PL_DAY_MS ? 2 : 5;
  return 5;
}

/** The moment this row's level next changes, or null when it never does. */
function plNextBoundary(obs, nowMs, quoteValidDays) {
  var kind = obs.kind, b = null;
  if (kind === 'paid') b = obs.observedAtMs + PL_PAID_FRESH_DAYS * PL_DAY_MS;
  else if (PL_DATED_KINDS.indexOf(kind) !== -1) b = (typeof obs.validThroughMs === 'number') ? obs.validThroughMs : obs.observedAtMs + plQuoteDays(quoteValidDays) * PL_DAY_MS;
  else if (kind === 'portal_read' || kind === 'api_account') b = obs.observedAtMs + PL_PORTAL_FRESH_DAYS * PL_DAY_MS;
  return (b !== null && b >= nowMs) ? b : null;
}

function plNewer(a, b) {
  if (a.observedAtMs !== b.observedAtMs) return a.observedAtMs > b.observedAtMs;
  return (a.createdAtMs || 0) > (b.createdAtMs || 0);
}

/**
 * Step A.1: the rows that can rank. Voided rows and rows with no per-catalog-unit
 * price never rank; of the rest only the newest per (kind, branch) is current.
 */
function currentRows(rows) {
  var byKey = {}, order = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r || r.voided === true || !plIsPosInt(r.catalogMicros)) continue;
    var key = r.kind + '|' + (r.locationId == null ? '' : r.locationId);
    if (!Object.prototype.hasOwnProperty.call(byKey, key)) { byKey[key] = r; order.push(key); }
    else if (plNewer(r, byKey[key])) byKey[key] = r;
  }
  var out = [];
  for (var j = 0; j < order.length; j++) out.push(byKey[order[j]]);
  return out;
}

/**
 * The offer's current row. Pass 1 admits the tenant's own paperwork and account
 * prices; a typed note or a shelf price ranks only when pass 1 is empty. Inside a
 * pass: lower level, then newer. Price is never a tie-break inside one offer.
 */
function bestForOffer(rows, nowMs, quoteValidDays, comparableOnly) {
  var cur = currentRows(rows), pool = [];
  for (var i = 0; i < cur.length; i++) if (!comparableOnly || cur[i].compare === true) pool.push(cur[i]);
  var pass = [];
  for (var j = 0; j < pool.length; j++) if (PL_PAPER_KINDS.indexOf(pool[j].kind) !== -1) pass.push(pool[j]);
  if (!pass.length) pass = pool;
  var best = null, bestLevel = 0;
  for (var k = 0; k < pass.length; k++) {
    var lvl = evidenceLevel(pass[k], nowMs, quoteValidDays);
    if (best === null || lvl < bestLevel || (lvl === bestLevel && plNewer(pass[k], best))) { best = pass[k]; bestLevel = lvl; }
  }
  return best;
}

// SHA-1 over UTF-8 bytes, as 40 hex characters. Ids only; nothing here is a secret.
function plSha1(str) {
  var s = unescape(encodeURIComponent(String(str))), n = s.length, words = [], i;
  for (i = 0; i < n; i++) words[i >> 2] |= s.charCodeAt(i) << (24 - (i % 4) * 8);
  words[n >> 2] |= 0x80 << (24 - (n % 4) * 8);
  words[(((n + 8) >> 6) << 4) + 15] = n * 8;
  var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0, w = [];
  function rol(x, c) { return (x << c) | (x >>> (32 - c)); }
  for (var b = 0; b < words.length; b += 16) {
    var a = h0, bb = h1, c = h2, d = h3, e = h4;
    for (var t = 0; t < 80; t++) {
      w[t] = t < 16 ? (words[b + t] | 0) : rol(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
      var f = t < 20 ? ((bb & c) | (~bb & d)) : t < 40 ? (bb ^ c ^ d) : t < 60 ? ((bb & c) | (bb & d) | (c & d)) : (bb ^ c ^ d);
      var kk = t < 20 ? 0x5A827999 : t < 40 ? 0x6ED9EBA1 : t < 60 ? 0x8F1BBCDC : 0xCA62C1D6;
      var tmp = (rol(a, 5) + f + e + kk + w[t]) | 0;
      e = d; d = c; c = rol(bb, 30); bb = a; a = tmp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + bb) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  var out = '', hs = [h0, h1, h2, h3, h4];
  for (i = 0; i < 5; i++) out += ('00000000' + (hs[i] >>> 0).toString(16)).slice(-8);
  return out;
}

/**
 * The offer id for one SKU at one supplier. A SKU made only of letters, digits and
 * dashes gives `<supplierId>_<sku>` (equal to the legacy keyFor for the five legacy
 * stores); a SKU the cleaner changed keeps a short hash so 12/34 and 1234 stay two
 * offers; no SKU at all hashes the title and purchase unit.
 */
function offerIdFor(supplierId, sku, title, purchaseUnit) {
  var sup = String(supplierId == null ? '' : supplierId);
  var raw = String(sku == null ? '' : sku).replace(/^\s+|\s+$/g, '');
  var clean = raw.replace(/[^A-Za-z0-9-]/g, '');
  if (!raw) return sup + '_x' + plSha1(String(title == null ? '' : title).toLowerCase() + '|' + String(purchaseUnit == null ? '' : purchaseUnit)).slice(0, 10);
  if (clean === raw) return sup + '_' + clean;
  return sup + '_' + clean + '-h' + plSha1(raw).slice(0, 6);
}

/** The id of a row read from a document: the same fact read twice is one row. */
function obsIdFor(row) {
  var doc = (row && row.doc) || {};
  return plSha1([row.offerId, row.kind, doc.type || '', doc.ref || '', row.observedOn, row.statedUnit == null ? '' : row.statedUnit, row.per, row.priceMicros].join('|')).slice(0, 28);
}

function plText(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, max);
}
function plTextOrNull(v, max) { var t = plText(v, max); return t ? t : null; }
function plBad(reason) { return { ok: false, reason: reason }; }
function plOkSupplierId(id) { return typeof id === 'string' && supplierOf(id) !== null; }

/** YYYY-MM-DD for a real calendar day, as UTC midnight ms; else null. */
function plDateMs(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s));
  if (!m) return null;
  var ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  var d = new Date(ms);
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

/** The host of an https URL, or null (http, a userinfo part and a bare host are all refused). */
function plHttpsHost(url) {
  var m = /^https:\/\/([A-Za-z0-9.-]+)(?::\d{1,5})?(?:[\/?#]|$)/.exec(String(url == null ? '' : url));
  return m ? m[1].toLowerCase() : null;
}

/** May this supplier's offers link to this URL? Registry hosts only; `other` takes any https host. */
function urlAllowedFor(supplierId, url) {
  var sup = supplierOf(supplierId), host = plHttpsHost(url);
  if (!sup || !host || String(url).length > 500) return false;
  if (!sup.hosts.length) return true;
  for (var i = 0; i < sup.hosts.length; i++) {
    var h = sup.hosts[i];
    if (host === h || host.slice(-(h.length + 1)) === '.' + h) return true;
  }
  return false;
}

/** A supplier account as a caller may save it: { ok, value } or { ok: false, reason }. `link` is server-only. */
function sanitizeSupplierAccount(d) {
  d = d || {};
  if (!plOkSupplierId(d.supplierId)) return plBad('bad_supplier');
  var reg = supplierOf(d.supplierId), custom = reg === SUPPLIERS.other;
  var label = plText(d.label, 60);
  if (custom && d.supplierId !== 'other' && !label) return plBad('label_required');
  var type = reg.type;
  if (type === 'either') {
    if (d.type !== 'retail' && d.type !== 'distributor') return plBad('bad_type');
    type = d.type;
  }
  var locs = [], seen = {}, preferred = 0;
  if (d.locations != null) {
    if (!Array.isArray(d.locations) || d.locations.length > 20) return plBad('bad_locations');
    for (var i = 0; i < d.locations.length; i++) {
      var L = d.locations[i] || {};
      if (typeof L.id !== 'string' || !/^[a-z0-9-]{1,24}$/.test(L.id) || seen[L.id]) return plBad('bad_locations');
      seen[L.id] = true;
      if (L.preferred === true) preferred++;
      locs.push({ id: L.id, label: plText(L.label, 60), storeNumber: plTextOrNull(L.storeNumber, 20), branchNumber: plTextOrNull(L.branchNumber, 20), zip: plTextOrNull(L.zip, 10), preferred: L.preferred === true });
    }
    if (locs.length && preferred !== 1) return plBad('bad_locations');
  }
  var rep = null;
  if (d.rep != null) {
    if (typeof d.rep !== 'object') return plBad('bad_rep');
    rep = { name: plText(d.rep.name, 120), phone: plText(d.rep.phone, 120), email: plText(d.rep.email, 120) };
  }
  var terms = null;
  if (d.terms != null) {
    var T = d.terms;
    var fee = T.deliveryFeeCents == null ? 0 : T.deliveryFeeCents, min = T.minOrderCents == null ? 0 : T.minOrderCents;
    var days = T.quoteValidDays == null ? PL_QUOTE_VALID_DAYS : T.quoteValidDays;
    if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(min) || min < 0 || !plIsPosInt(days) || days > 365) return plBad('bad_terms');
    terms = { deliveryFeeCents: fee, minOrderCents: min, quoteValidDays: days };
  }
  var pf = [];
  if (d.preferredFor != null) {
    if (!Array.isArray(d.preferredFor) || d.preferredFor.length > 16) return plBad('bad_preferred_for');
    for (var j = 0; j < d.preferredFor.length; j++) {
      if (typeof d.preferredFor[j] !== 'string' || !/^[a-z0-9_]{1,40}$/.test(d.preferredFor[j])) return plBad('bad_preferred_for');
      if (pf.indexOf(d.preferredFor[j]) === -1) pf.push(d.preferredFor[j]);
    }
  }
  var acct = plText(d.accountRef, 40);
  return { ok: true, value: {
    supplierId: d.supplierId, label: label || reg.label, type: type, active: d.active !== false,
    locations: locs, accountRef: acct ? acct.slice(-4) : null, rep: rep, terms: terms, preferredFor: pf
  } };
}

var PL_SKU_KINDS = ['store_sku', 'item_number', 'internet_sku', 'mfr_part', 'none'];
var PL_TIERS = ['good', 'better', 'best'];
var PL_MATCHES = ['exact', 'equivalent', 'comparable'];
var PL_PACK_BASES = ['manufacturer_spec', 'supplier_doc', 'owner_entered', 'seed_coverage', 'same_unit'];

/** A pack as a caller may send it. `verified` is never taken from a caller: the verifyPack op sets it. */
function sanitizePack(p) {
  p = p || {};
  if (UNITS.indexOf(p.purchaseUnit) === -1) return plBad('bad_pack');
  var cu = p.catalogUnit == null ? null : String(p.catalogUnit);
  if (cu !== null && !/^[A-Z]{1,8}$/.test(cu)) return plBad('bad_pack');
  var note = plText(p.note, 80);
  if (p.status === 'unknown' || p.status == null) {
    return { ok: true, value: { purchaseUnit: p.purchaseUnit, catalogUnit: cu, num: null, den: null, status: 'unknown', basis: null, verified: false, verifiedBy: null, verifiedAtMs: null, note: note } };
  }
  var basis = PL_PACK_BASES.indexOf(p.basis) !== -1 ? p.basis : 'owner_entered';
  var v = { purchaseUnit: p.purchaseUnit, catalogUnit: cu, num: p.num, den: p.den, status: 'known', basis: basis, verified: false, verifiedBy: null, verifiedAtMs: null, note: note };
  if (p.status !== 'known' || !validPack(v) || NO_PURCHASE_TWIN.indexOf(cu) > 0) return plBad('bad_pack');
  return { ok: true, value: v };
}

/** An offer as a caller may save it. Unknown keys are dropped; `latest`, `nextCheckMs`, `photo` are server-only. */
function sanitizeOffer(d) {
  d = d || {};
  if (!plOkSupplierId(d.supplierId)) return plBad('bad_supplier');
  var sku = d.sku == null ? '' : String(d.sku).replace(/^\s+|\s+$/g, '');
  if (sku.length > 40 || /[\u0000-\u001F\u007F]/.test(sku)) return plBad('bad_sku');
  var title = plText(d.title, 160);
  if (!title) return plBad('title_required');
  var url = null;
  if (d.url != null && d.url !== '') {
    if (!urlAllowedFor(d.supplierId, d.url)) return plBad('bad_url');
    url = String(d.url);
  }
  var productId = null;
  if (d.productId != null && d.productId !== '') {
    if (typeof d.productId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(d.productId)) return plBad('bad_product');
    productId = d.productId;
  }
  var alt = d.altIds || {}, upc = plTextOrNull(alt.upc, 40);
  if (upc !== null && !/^\d{8,14}$/.test(upc)) return plBad('bad_upc');
  var tiers = [];
  if (d.tiers != null) {
    if (!Array.isArray(d.tiers)) return plBad('bad_tiers');
    for (var i = 0; i < d.tiers.length; i++) {
      if (PL_TIERS.indexOf(d.tiers[i]) === -1) return plBad('bad_tiers');
      if (tiers.indexOf(d.tiers[i]) === -1) tiers.push(d.tiers[i]);
    }
  }
  if (!tiers.length) tiers = ['good'];
  var match = d.match == null ? 'exact' : d.match;
  if (PL_MATCHES.indexOf(match) === -1) return plBad('bad_match');
  var pack = sanitizePack(d.pack);
  if (!pack.ok) return pack;
  var vr = d.variant || {};
  return { ok: true, value: {
    v: 1, supplierId: d.supplierId, sku: sku, skuKind: PL_SKU_KINDS.indexOf(d.skuKind) !== -1 ? d.skuKind : 'none',
    altIds: { upc: upc, model: plTextOrNull(alt.model, 40), internetSku: plTextOrNull(alt.internetSku, 40), mfrPart: plTextOrNull(alt.mfrPart, 40) },
    title: title, brand: plTextOrNull(d.brand, 60), url: url, productId: productId,
    variant: { color: plTextOrNull(vr.color, 60), size: plTextOrNull(vr.size, 60), style: plTextOrNull(vr.style, 60) },
    tiers: tiers, match: match, pack: pack.value, watch: d.watch === true, active: d.active !== false
  } };
}

var PL_PRICE_TYPES = ['net', 'list', 'account', 'promo'];
var PL_DOC_TYPES = ['receipt', 'invoice', 'quote', 'price_sheet', 'contract', 'portal', 'api', 'none'];
var PL_MIN_DATE_MS = Date.UTC(2000, 0, 1);

/**
 * One price row as a caller may send it: { ok, value } or { ok: false, reason }.
 * Only the fields named here survive. `ctx.nowMs` bounds the date (not after tomorrow).
 * `api_account` and `live_shelf` are written by server adapters only.
 */
function sanitizeObservation(row, ctx) {
  row = row || {}; ctx = ctx || {};
  if (typeof row.offerId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(row.offerId)) return plBad('bad_offer');
  if (CALLER_KINDS.indexOf(row.kind) === -1) return plBad('bad_kind');
  if (!plIsPosInt(row.priceMicros) || row.priceMicros > PL_MAX_PRICE_MICROS) return plBad('bad_price');
  // A store export has no unit column. On those channels only, a row with no unit
  // is kept as "price as stated": it has no per-catalog-unit price until the
  // offer's pack is confirmed (catalogMicrosFor).
  var nullUnitOk = plNullUnitChannel(ctx.channel);
  var unitText = row.statedUnit != null && row.statedUnit !== '' ? row.statedUnit : row.uomRaw;
  var noUnit = unitText == null || unitText === '';
  var uom = (nullUnitOk && noUnit) ? { unit: null, per: 1 } : normaliseUom(unitText);
  if (!uom || (!uom.unit && !(nullUnitOk && noUnit))) return plBad('needs_unit');
  var per = row.per == null ? uom.per : row.per;
  if (per !== 1 && per !== 100 && per !== 1000) return plBad('bad_per');
  if (PL_PRICE_TYPES.indexOf(row.priceType) === -1) return plBad('bad_price_type');
  if (typeof row.taxIncluded !== 'boolean') return plBad('tax_required');
  var onMs = plDateMs(row.observedOn);
  if (onMs === null || onMs < PL_MIN_DATE_MS) return plBad('bad_date');
  if (typeof ctx.nowMs === 'number' && onMs > ctx.nowMs + PL_DAY_MS) return plBad('bad_date');
  var through = null;
  if (row.validThroughOn != null && row.validThroughOn !== '') {
    if (plDateMs(row.validThroughOn) === null) return plBad('bad_valid_through');
    through = row.validThroughOn;
  }
  var qty = null;
  if (row.qty != null) {
    if (typeof row.qty !== 'number' || !isFinite(row.qty) || row.qty <= 0) return plBad('bad_qty');
    qty = row.qty;
  }
  var ext = null;
  if (row.extCents != null) {
    if (!Number.isSafeInteger(row.extCents)) return plBad('bad_ext');
    ext = row.extCents;
  }
  var loc = null;
  if (row.locationId != null && row.locationId !== '') {
    if (typeof row.locationId !== 'string' || !/^[a-z0-9-]{1,24}$/.test(row.locationId)) return plBad('bad_location');
    loc = row.locationId;
  }
  var doc = row.doc || {};
  // The store number and the offer stub travel only on the store-export channels.
  var storeNumber = null, stub = null;
  if (nullUnitOk) {
    storeNumber = plTextOrNull(row.storeNumber, 20);
    if (row.offer != null) {
      stub = sanitizeStub(row.offer);
      if (stub === null) return plBad('bad_offer');
    }
  }
  return { ok: true, value: {
    offerId: row.offerId, kind: row.kind, priceMicros: row.priceMicros, per: per, statedUnit: uom.unit,
    uomRaw: plText(row.uomRaw != null ? row.uomRaw : row.statedUnit, 20), qty: qty, extCents: ext,
    priceType: row.priceType, taxIncluded: row.taxIncluded, delivered: typeof row.delivered === 'boolean' ? row.delivered : null,
    locationId: loc, observedOn: row.observedOn, validThroughOn: through,
    doc: { type: PL_DOC_TYPES.indexOf(doc.type) !== -1 ? doc.type : 'none', ref: plText(doc.ref, 80) },
    note: plText(row.note, 200), storeNumber: storeNumber, offer: stub
  } };
}

// Channels whose rows may arrive with no unit (a store's purchase export, and the
// one-time copy of the legacy price book, which was built from the same exports).
var NULL_UNIT_CHANNELS = ['hd_csv', 'legacy_pricebook'];
function plNullUnitChannel(ch) { return NULL_UNIT_CHANNELS.indexOf(ch) !== -1; }

/** The few fields of an offer a receipt line can state: { supplierId, sku, title, internetSku }, or null. */
function sanitizeStub(s) {
  if (!s || typeof s !== 'object' || !plOkSupplierId(s.supplierId)) return null;
  var sku = s.sku == null ? '' : String(s.sku).replace(/^\s+|\s+$/g, '');
  if (!sku || sku.length > 40 || /[\u0000-\u001F\u007F]/.test(sku)) return null;
  return { supplierId: s.supplierId, sku: sku, title: plText(s.title, 160) || sku, internetSku: plTextOrNull(s.internetSku, 40) };
}

/**
 * A minimal, unlinked offer built from a receipt line. sanitizePack refuses a pack
 * with no purchase unit, so the unknown pack is written out here.
 */
function stubOffer(stub) {
  var s = sanitizeStub(stub);
  if (s === null) return null;
  var reg = supplierOf(s.supplierId);
  return {
    v: 1, supplierId: s.supplierId, sku: s.sku, skuKind: reg.skuKinds.length ? reg.skuKinds[0] : 'none',
    altIds: { upc: null, model: null, internetSku: s.internetSku, mfrPart: null },
    title: s.title, brand: null, url: null, productId: null,
    variant: { color: null, size: null, style: null },
    tiers: ['good'], match: 'exact',
    pack: { purchaseUnit: null, catalogUnit: null, num: null, den: null, status: 'unknown', basis: null, verified: false, verifiedBy: null, verifiedAtMs: null, note: '' },
    watch: false, active: true
  };
}

/**
 * The price of one catalog unit for a stored row: { micros, flag }. A row with a
 * unit goes through toCatalogMicros. A row with no unit (a store export) is read as
 * priced per the offer's purchase unit, and only when the supplier is a retail
 * store and a person has confirmed the pack; otherwise it has no per-unit price.
 */
function catalogMicrosFor(row, offer) {
  row = row || {}; offer = offer || {};
  var pack = offer.pack;
  if (row.statedUnit != null) return toCatalogMicros(row.priceMicros, row.per, row.statedUnit, pack);
  var ch = (row.source && row.source.channel) || row.channel;
  var sup = supplierOf(offer.supplierId);
  if (plNullUnitChannel(ch) && sup && sup.type === 'retail' && validPack(pack) && pack.verified === true) {
    return toCatalogMicros(row.priceMicros, row.per, pack.purchaseUnit, pack);
  }
  return { micros: null, flag: null };
}

/**
 * One legacy price-book purchase ({ store, sku, desc, cents, qty, date, ref }) as a
 * ledger row, or null when it can not be one (no SKU, no price, a bad date, a store
 * the registry does not know). The offer id equals the legacy keyFor(store, sku).
 */
function legacyPurchaseToRow(p) {
  p = p || {};
  var stub = plLegacyStub(p.store, p.sku, p.desc);
  var cents = Math.round(Number(p.cents));
  if (stub === null || !plIsPosInt(cents) || plDateMs(p.date) === null) return null;
  var micros = centsToMicros(cents);
  if (!Number.isSafeInteger(micros) || micros > PL_MAX_PRICE_MICROS) return null;
  var qty = Number(p.qty);
  return {
    offerId: offerIdFor(stub.supplierId, stub.sku), kind: 'paid', priceMicros: micros,
    priceType: 'net', taxIncluded: false, observedOn: String(p.date),
    qty: (isFinite(qty) && qty > 0) ? qty : null,
    doc: { type: 'receipt', ref: plText(p.ref, 80) },
    offer: stub
  };
}

/** The legacy key's two halves as a stub (store and SKU cleaned exactly as the legacy keyFor cleans them), or null. */
function plLegacyStub(store, sku, desc) {
  var s = String(store == null ? '' : store).toLowerCase().replace(/[^a-z0-9]/g, '');
  var k = String(sku == null ? '' : sku).replace(/^\s+|\s+$/g, '').replace(/[^A-Za-z0-9-]/g, '');
  if (!s || !k || k.length > 40 || !plOkSupplierId(s)) return null;
  return { supplierId: s, sku: k, title: plText(desc, 160) || k, internetSku: null };
}

/** One legacy price-book item as { offerId, offer, rows }: an unlinked stub and one paid row per history entry. */
function legacyItemToLedger(key, item) {
  item = item || {};
  var stub = plLegacyStub(item.store, item.sku, item.desc);
  if (stub === null) return { offerId: null, offer: null, rows: [] };
  var rows = [], hist = Array.isArray(item.history) ? item.history : [];
  for (var i = 0; i < hist.length; i++) {
    var h = hist[i] || {};
    var r = legacyPurchaseToRow({ store: item.store, sku: item.sku, desc: item.desc, cents: h.cents, qty: h.qty, date: h.date, ref: h.ref });
    if (r) rows.push(r);
  }
  return { offerId: offerIdFor(stub.supplierId, stub.sku), offer: stubOffer(stub), rows: rows };
}

function plPoint(r, cm) {
  return { obsId: r.obsId, kind: r.kind, priceMicros: r.priceMicros, per: r.per, statedUnit: r.statedUnit, catalogMicros: cm,
    taxIncluded: r.taxIncluded === true, locationId: r.locationId == null ? null : r.locationId, observedAtMs: r.observedAtMs,
    validThroughMs: typeof r.validThroughMs === 'number' ? r.validThroughMs : null, compare: r.compare === true, attested: r.attested === true };
}

/**
 * Build an offer's `latest` from a full read of its newest rows (newest first or
 * not: order does not matter). Nothing here is an increment, so two appends that
 * interleave both end with the same summary. The per-catalog-unit price is
 * re-derived from each row's stated price and the offer's CURRENT pack.
 */
function summarize(offer, rows, nowMs, quoteValidDays) {
  offer = offer || {};
  var pack = offer.pack, prev = offer.latest || null, all = (rows || []).slice();
  all.sort(function (a, b) { return plNewer(a, b) ? -1 : (plNewer(b, a) ? 1 : 0); });
  var capped = all.length > PL_SUMMARY_ROWS;
  if (capped) all = all.slice(0, PL_SUMMARY_ROWS);
  var live = [], i;
  for (i = 0; i < all.length; i++) {
    if (!all[i] || all[i].voided === true) continue;
    var copy = {}, src = all[i];
    for (var key in src) if (Object.prototype.hasOwnProperty.call(src, key)) copy[key] = src[key];
    copy.catalogMicros = catalogMicrosFor(src, offer).micros;
    live.push(copy);
  }
  var best = bestForOffer(live, nowMs, quoteValidDays, false);
  var bestCmp = bestForOffer(live, nowMs, quoteValidDays, true);
  var lastPaid = null, recent = [];
  for (i = 0; i < live.length; i++) {
    if (lastPaid === null && live[i].kind === 'paid') lastPaid = live[i];
    if (recent.length < PL_RECENT_MAX) recent.push({ ms: live[i].observedAtMs, m: live[i].catalogMicros, k: live[i].kind, cmp: live[i].compare === true });
  }
  var prevBest = (prev && prev.prevBest) || null;
  if (prev && prev.best && (!best || best.obsId !== prev.best.obsId)) {
    prevBest = { priceMicros: prev.best.priceMicros, catalogMicros: prev.best.catalogMicros, observedAtMs: prev.best.observedAtMs };
  }
  var next = null, cur = currentRows(live);
  for (i = 0; i < cur.length; i++) {
    var b = plNextBoundary(cur[i], nowMs, quoteValidDays);
    if (b !== null && (next === null || b < next)) next = b;
  }
  return {
    best: best ? plPoint(best, best.catalogMicros) : null,
    bestComparable: bestCmp ? plPoint(bestCmp, bestCmp.catalogMicros) : null,
    lastPaid: lastPaid ? { obsId: lastPaid.obsId, priceMicros: lastPaid.priceMicros, per: lastPaid.per, statedUnit: lastPaid.statedUnit, catalogMicros: lastPaid.catalogMicros, observedAtMs: lastPaid.observedAtMs, locationId: lastPaid.locationId == null ? null : lastPaid.locationId } : null,
    shelf: null, prevBest: prevBest, lastCheck: null, recent: recent,
    count: live.length, countCapped: capped,
    unitState: validPack(pack) ? 'ok' : 'needs_unit',
    nextReviewMs: next, updatedAtMs: nowMs
  };
}

/** Is the ledger switched on for this person? Only the boolean true turns it on. */
function flagOn(flagsDefault, flagsMine) {
  var merged = {}, k;
  for (k in (flagsDefault || {})) if (Object.prototype.hasOwnProperty.call(flagsDefault, k)) merged[k] = flagsDefault[k];
  for (k in (flagsMine || {})) if (Object.prototype.hasOwnProperty.call(flagsMine, k)) merged[k] = flagsMine[k];
  return merged[FLAG_NAME] === true;
}
// ---- END SHARED ----

  var api = {
    FLAG_NAME: FLAG_NAME, FLAG_DEFAULT: FLAG_DEFAULT, SUPPLIERS: SUPPLIERS, supplierOf: supplierOf, UNITS: UNITS,
    CATALOG_UNIT_OF: CATALOG_UNIT_OF, NO_PURCHASE_TWIN: NO_PURCHASE_TWIN,
    normaliseUom: normaliseUom, sameUnit: sameUnit, validPack: validPack, suggestPack: suggestPack,
    moneyTextToMicros: moneyTextToMicros, centsToMicros: centsToMicros, microsToCents: microsToCents, microsToText: microsToText,
    toCatalogMicros: toCatalogMicros, suspectUnitSwap: suspectUnitSwap,
    KINDS: KINDS, CALLER_KINDS: CALLER_KINDS, evidenceLevel: evidenceLevel, currentRows: currentRows, bestForOffer: bestForOffer,
    offerIdFor: offerIdFor, obsIdFor: obsIdFor, urlAllowedFor: urlAllowedFor,
    sanitizeSupplierAccount: sanitizeSupplierAccount, sanitizePack: sanitizePack, sanitizeOffer: sanitizeOffer,
    sanitizeObservation: sanitizeObservation, summarize: summarize, flagOn: flagOn,
    NULL_UNIT_CHANNELS: NULL_UNIT_CHANNELS, stubOffer: stubOffer, catalogMicrosFor: catalogMicrosFor,
    legacyPurchaseToRow: legacyPurchaseToRow, legacyItemToLedger: legacyItemToLedger
  };
  root.NBDPriceLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
