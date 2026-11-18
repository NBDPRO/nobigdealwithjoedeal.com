/**
 * price-logic.js: pure logic for the supplier price ledger
 * (design: documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md, slice 1).
 *
 * No Firebase, no network, no clock except where a caller passes one in. Used by
 * functions/price-ledger.js and functions/price-ledger-store.js, and mirrored
 * byte-for-byte into docs/pro/js/price-logic.js (the "Stores & prices" sheet)
 * between the SHARED markers below; tests/price-logic-2026-11.test.js keeps the
 * two copies identical.
 *
 * What this file owns:
 *   - the supplier registry (ids, labels, allowed link hosts; no prices)
 *   - units: the purchase-unit list, the explicit map onto catalog units, pack
 *     conversion, the per-bundle / per-square swap check
 *   - money: integer micro-dollars everywhere (1 cent = 10000). This is the only
 *     ledger file that converts money; nothing here uses a float parse
 *   - the evidence ladder (L1 to L5), the per-offer ranking and the `latest`
 *     summary an offer carries
 *   - ids (offerIdFor, obsIdFor) and the sanitizers that decide which caller
 *     fields survive. A caller can never set provenance (compare, attested,
 *     source, latest, catalogMicros): those keys are simply not read
 *   - the per-person flag `supplierPricing` (off by default)
 */
'use strict';

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
  TUBE: ['TUBE', 'TUBES', 'TB', 'TUB', 'TUBS'],
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
  // A supplier file (slice 3) is paperwork: paid, quote, contract or price sheet only.
  if (ctx.channel === 'csv_import' && PL_IMPORT_KINDS.indexOf(row.kind) === -1) return plBad('bad_kind');
  if (!plIsPosInt(row.priceMicros) || row.priceMicros > PL_MAX_PRICE_MICROS) return plBad('bad_price');
  // A store export has no unit column. On those channels only, a row with no unit
  // is kept as "price as stated": it has no per-catalog-unit price until the
  // offer's pack is confirmed (catalogMicrosFor).
  var nullUnitOk = plNullUnitChannel(ctx.channel);
  var unitText = row.statedUnit != null && row.statedUnit !== '' ? row.statedUnit : row.uomRaw;
  // A supplier file keeps unit text nobody knows in uomRaw and sends no unit: kept as stated.
  var noUnit = unitText == null || unitText === '' || (ctx.channel === 'csv_import' && (row.statedUnit == null || row.statedUnit === ''));
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
  if (ctx.channel === 'csv_import' && row.kind === 'quote' && through === null) return plBad('quote_needs_date');
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
  // A file row's id is hashed from its document reference, so it must have one.
  if (ctx.channel === 'csv_import' && !plText(doc.ref, 80)) return plBad('needs_doc_ref');
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
// A supplier file (csv_import, slice 3) may lack a unit column too.
var NULL_UNIT_CHANNELS = ['hd_csv', 'legacy_pricebook', 'csv_import'];
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
    v: 1, supplierId: s.supplierId, sku: s.sku, skuKind: reg.skuKinds.length ? reg.skuKinds[0] : 'item_number',
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
    lastPaid: lastPaid ? { obsId: lastPaid.obsId, priceMicros: lastPaid.priceMicros, per: lastPaid.per, statedUnit: lastPaid.statedUnit, catalogMicros: lastPaid.catalogMicros, taxIncluded: lastPaid.taxIncluded === true, observedAtMs: lastPaid.observedAtMs, locationId: lastPaid.locationId == null ? null : lastPaid.locationId } : null,
    shelf: null, prevBest: prevBest, lastCheck: null, recent: recent,
    count: live.length, countCapped: capped,
    unitState: validPack(pack) ? 'ok' : 'needs_unit',
    nextReviewMs: next, updatedAtMs: nowMs
  };
}

// ---- Slice 3 (Jo, 2026-11-17): supplier files, side-by-side prices, on-screen alerts ----

/**
 * A CSV file's text as rows of cells. Quoted cells may hold commas, line breaks and
 * doubled quotes; a byte-order mark and blank lines are dropped. No row is guessed.
 */
function parseCsv(text) {
  var s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  var rows = [], row = [], cell = '', quoted = false, i;
  for (i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (quoted) {
      if (ch === '"') { if (s.charAt(i + 1) === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"' && cell.replace(/\s+/g, '') === '') { quoted = true; cell = ''; }
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s.charAt(i + 1) === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  var out = [];
  for (i = 0; i < rows.length; i++) if (rows[i].join('').replace(/\s+/g, '') !== '') out.push(rows[i]);
  return out;
}

function plHeaderWords(h) { return String(h == null ? '' : h).toLowerCase().replace(/#/g, ' no ').replace(/[^a-z0-9]+/g, ' ').replace(/^\s+|\s+$/g, ''); }
var PL_COLUMN_WORDS = {
  sku: /^(item|item no|item number|item num|item code|item id|sku|sku no|part|part no|part number|product code|product no|product number|product id|catalog no|catalog number|mfr part|mfr part no|material|material no|material number)$/,
  title: /^(description|desc|item description|product description|product name|product|item name|name|material description)$/,
  price: /^(unit price|price|net price|net|your price|unit cost|cost|each|price each|net each|sell price|contract price|quote price|account price|live price)$/,
  unit: /^(uom|u m|um|unit|units|unit of measure|sell uom|price uom|pricing uom)$/,
  per: /^(per|price per|priced per|pricing unit|price unit|c m)$/,
  qty: /^(qty|quantity|qty ordered|qty shipped|ship qty|order qty|shipped|ordered)$/
};
var PL_COLUMNS = ['sku', 'title', 'price', 'unit', 'per', 'qty'];

/** The column index of each field by its header words, or -1. A person can change every pick. */
function guessColumns(headers) {
  var out = {}, used = {}, h = (headers || []).map(plHeaderWords);
  for (var c = 0; c < PL_COLUMNS.length; c++) {
    var key = PL_COLUMNS[c];
    out[key] = -1;
    for (var i = 0; i < h.length; i++) if (!used[i] && PL_COLUMN_WORDS[key].test(h[i])) { out[key] = i; used[i] = true; break; }
  }
  return out;
}

/** The first of the top 20 rows that names an item-number column and a price column; else 0. */
function guessHeaderRow(table) {
  for (var i = 0; i < Math.min(20, (table || []).length); i++) {
    var g = guessColumns(table[i]);
    if (g.sku !== -1 && g.price !== -1) return i;
  }
  return 0;
}

// A supplier file's three kinds (Jo): what each is stored as.
var IMPORT_DOC_KINDS = { quote: { kind: 'quote', docType: 'quote', priceType: 'account' }, price_sheet: { kind: 'price_sheet', docType: 'price_sheet', priceType: 'account' }, invoice: { kind: 'paid', docType: 'invoice', priceType: 'net' } };
var PL_IMPORT_KINDS = ['paid', 'quote', 'contract', 'price_sheet'];
var PL_IMPORT_MAX_ROWS = 5000;

/** A "per" cell: '' or 1 or EA is per one, C or 100 is per hundred, M or 1000 per thousand; else null. */
function plPerText(text) {
  var t = String(text == null ? '' : text).toUpperCase().replace(/[\s.\/]+/g, '').replace(/^PER/, '');
  if (t === '' || t === '1' || t === 'EA' || t === 'EACH') return 1;
  if (t === 'C' || t === '100') return 100;
  if (t === 'M' || t === '1000') return 1000;
  return null;
}
function plCell(row, i) { return (i == null || i < 0 || !row || i >= row.length) ? '' : String(row[i] == null ? '' : row[i]).replace(/^\s+|\s+$/g, ''); }

/**
 * One supplier file into ledger rows and a preview. opts: { supplierId, docKind
 * (quote | price_sheet | invoice), docDateOn, validThroughOn (a quote needs it),
 * taxIncluded (true or false, no default), docRef, fileName, locationId, headerRow,
 * map: { sku, title, price, unit, per, qty } (column indexes, -1 for none),
 * knownOfferIds (an object of ids already in the ledger), nowMs }.
 * Answers { ok: false, reason } for a bad setup, or { ok: true, rows, lines, counts }.
 * A row with no unit, or a unit nobody knows, is sent as stated with no unit and
 * counted as needing one; nothing is guessed. Only the file's name is kept.
 */
function buildImport(table, opts) {
  opts = opts || {};
  var dk = Object.prototype.hasOwnProperty.call(IMPORT_DOC_KINDS, opts.docKind) ? IMPORT_DOC_KINDS[opts.docKind] : null;
  if (!plOkSupplierId(opts.supplierId)) return plBad('bad_supplier');
  if (!dk) return plBad('bad_kind');
  if (typeof opts.taxIncluded !== 'boolean') return plBad('tax_required');
  var onMs = plDateMs(opts.docDateOn);
  if (onMs === null || onMs < PL_MIN_DATE_MS || (typeof opts.nowMs === 'number' && onMs > opts.nowMs + PL_DAY_MS)) return plBad('bad_date');
  var through = null;
  if (dk.kind === 'quote') {
    if (opts.validThroughOn == null || opts.validThroughOn === '') return plBad('quote_needs_date');
    var thMs = plDateMs(opts.validThroughOn);
    if (thMs === null || thMs < onMs) return plBad('bad_valid_through');
    through = opts.validThroughOn;
  }
  var map = opts.map || {};
  if (!(map.sku >= 0) || !(map.price >= 0)) return plBad('map_required');
  var head = (opts.headerRow >= 0) ? opts.headerRow : 0;
  var data = (table || []).slice(head + 1);
  if (data.length > PL_IMPORT_MAX_ROWS) return plBad('too_many_rows');
  var loc = (typeof opts.locationId === 'string' && /^[a-z0-9-]{1,24}$/.test(opts.locationId)) ? opts.locationId : null;
  var fileName = plText(opts.fileName, 80);
  var ref = plText(opts.docRef, 80) || fileName || (opts.docKind + '-' + opts.docDateOn + '-' + (loc || 'all'));
  var note = fileName ? plText('Imported from ' + fileName, 200) : '';
  var known = opts.knownOfferIds || {}, seenNew = {};
  var rows = [], lines = [], counts = { rows: data.length, send: 0, ok: 0, needsUnit: 0, rejected: 0, newItems: 0 };
  for (var i = 0; i < data.length; i++) {
    var r = data[i], line = { line: head + 2 + i, sku: plCell(r, map.sku), title: plText(plCell(r, map.title), 160), status: 'ok', reason: null };
    lines.push(line);
    var reject = plImportCheck(line, r, map);
    if (reject) { line.status = 'rejected'; line.reason = reject; counts.rejected++; continue; }
    var unitText = plCell(r, map.unit), perCol = plPerText(plCell(r, map.per));
    var uom = unitText ? normaliseUom(unitText) : null;
    var unit = uom ? uom.unit : null, per = (uom && uom.per !== 1) ? uom.per : perCol;
    var qtyText = plCell(r, map.qty), qty = null;
    if (qtyText && /^\d{1,7}(\.\d{1,4})?$/.test(qtyText) && Number(qtyText) > 0) qty = Number(qtyText);
    var offerId = offerIdFor(opts.supplierId, line.sku);
    line.offerId = offerId; line.priceMicros = moneyTextToMicros(plCell(r, map.price)); line.per = per; line.statedUnit = unit; line.uomRaw = plText(unitText, 20);
    line.isNew = !known[offerId];
    if (line.isNew && !seenNew[offerId]) { seenNew[offerId] = true; counts.newItems++; }
    if (unit === null) { line.status = 'needs_unit'; counts.needsUnit++; } else counts.ok++;
    counts.send++;
    rows.push({
      offerId: offerId, kind: dk.kind, priceMicros: line.priceMicros, per: per, statedUnit: unit, uomRaw: line.uomRaw, qty: qty,
      priceType: dk.priceType, taxIncluded: opts.taxIncluded, observedOn: opts.docDateOn, validThroughOn: through, locationId: loc,
      doc: { type: dk.docType, ref: ref }, note: note,
      offer: { supplierId: opts.supplierId, sku: line.sku, title: line.title || line.sku }
    });
  }
  return { ok: true, rows: rows, lines: lines, counts: counts };
}

/** Why one file row can not be sent, or null. */
function plImportCheck(line, r, map) {
  if (!line.sku) return 'no_item_number';
  if (line.sku.length > 40 || /[\u0000-\u001F\u007F]/.test(line.sku)) return 'bad_item_number';
  if (!plIsPosInt(moneyTextToMicros(plCell(r, map.price)))) return 'bad_price';
  if (plPerText(plCell(r, map.per)) === null) return 'bad_per';
  return null;
}

function applyTaxMicros(m, bps) { return Math.round(m * (10000 + bps) / 10000); }
function removeTaxMicros(m, bps) { return Math.round(m * 10000 / (10000 + bps)); }
function plPctToBps(v, min, max) {
  if (typeof v !== 'number' || !isFinite(v) || v < min || v > max) return null;
  return Math.round(v * 100);
}

/**
 * The company's comparison settings (companyProfile.pricing.supplierCompare), as
 * basis points. Off unless set: a company that never set them gets nulls, never
 * another company's numbers. A tax rate of 0 is a real choice.
 */
function supplierCompareSettings(profile) {
  var s = (profile && profile.pricing && profile.pricing.supplierCompare) || {};
  return { taxBps: plPctToBps(s.purchaseTaxPct, 0, 25), alertBps: plPctToBps(s.alertPct, 0.1, 100) };
}

/**
 * A quote's good-through state against today's date (UTC midnight of the local day):
 * 'none', 'ok', 'warn' (7 days or fewer left, the last day included) or 'expired'.
 */
var PL_QUOTE_WARN_DAYS = 7;
function quoteExpiryState(validThroughMs, todayMs) {
  if (typeof validThroughMs !== 'number' || !isFinite(validThroughMs)) return { state: 'none', daysLeft: null };
  var endDay = validThroughMs - 36 * 3600000;
  var left = Math.round((endDay - todayMs) / PL_DAY_MS);
  if (left < 0) return { state: 'expired', daysLeft: left };
  return { state: left <= PL_QUOTE_WARN_DAYS ? 'warn' : 'ok', daysLeft: left };
}

function plAccountOf(accounts, supplierId) {
  for (var i = 0; i < (accounts || []).length; i++) {
    var a = accounts[i];
    if (a && (a.supplierId === supplierId || a.id === supplierId)) return a;
  }
  return null;
}
function plFresh(point, nowMs, account) {
  return evidenceLevel(point, nowMs, account && account.terms && account.terms.quoteValidDays) <= 2;
}

/**
 * One product's suppliers side by side, per catalog unit. ctx: { nowMs, accounts,
 * taxBps, alertBps }. Only each offer's `bestComparable` row is read. A row is fresh
 * at evidence level 1 or 2; an older one is shown and never alerts. An offer with no
 * confirmed pack for this product's unit is counted in needsPack and not compared.
 * Prices are compared tax-included: a before-tax price gets the company's rate;
 * with no rate, prices with and without tax are not compared at all (needsTaxRate).
 */
function compareProduct(product, offers, ctx) {
  ctx = ctx || {};
  var pid = product && product.id, unit = product && product.unit, rows = [], needsPack = 0, i;
  var taxBps = (typeof ctx.taxBps === 'number') ? ctx.taxBps : null;
  for (i = 0; i < (offers || []).length; i++) {
    var o = offers[i];
    if (!o || o.productId !== pid || o.active === false) continue;
    var acct = plAccountOf(ctx.accounts, o.supplierId);
    var row = { offerId: o.id, supplierId: o.supplierId, terms: (acct && acct.terms) || null, compareMicros: null, fresh: false };
    if (!validPack(o.pack) || o.pack.catalogUnit !== unit) { needsPack++; row.state = 'needs_pack'; rows.push(row); continue; }
    var p = o.latest && o.latest.bestComparable;
    if (!p || !plIsPosInt(p.catalogMicros)) { row.state = 'no_price'; rows.push(row); continue; }
    row.obsId = p.obsId; row.kind = p.kind; row.catalogMicros = p.catalogMicros; row.taxIncluded = p.taxIncluded === true;
    row.observedAtMs = p.observedAtMs; row.validThroughMs = typeof p.validThroughMs === 'number' ? p.validThroughMs : null;
    row.fresh = plFresh(p, ctx.nowMs, acct); row.state = row.fresh ? 'fresh' : 'stale';
    rows.push(row);
  }
  var anyIn = false, anyOut = false;
  for (i = 0; i < rows.length; i++) if (rows[i].fresh) { if (rows[i].taxIncluded) anyIn = true; else anyOut = true; }
  var needsTaxRate = taxBps === null && anyIn && anyOut;
  for (i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!plIsPosInt(r.catalogMicros) || needsTaxRate) continue;
    r.compareMicros = (r.taxIncluded || taxBps === null) ? r.catalogMicros : applyTaxMicros(r.catalogMicros, taxBps);
  }
  var usual = plUsualSupplier(product, offers, rows, ctx.accounts);
  var usualRow = null, other = null;
  for (i = 0; i < rows.length; i++) {
    var x = rows[i];
    if (!x.fresh || x.compareMicros === null) continue;
    if (x.supplierId === usual) { if (!usualRow || x.compareMicros < usualRow.compareMicros) usualRow = x; }
    else if (!other || x.compareMicros < other.compareMicros) other = x;
  }
  var alert = null, alertBps = ctx.alertBps;
  if (usualRow && other && plIsPosInt(alertBps) && other.compareMicros < usualRow.compareMicros
    && (usualRow.compareMicros - other.compareMicros) * 10000 >= alertBps * usualRow.compareMicros) {
    var newer = other.observedAtMs >= usualRow.observedAtMs ? other : usualRow;
    alert = { id: 'cheaper_' + pid, type: 'cheaper', productId: pid, offerId: other.offerId, supplierId: other.supplierId, usualSupplierId: usual,
      usualOfferId: usualRow.offerId, obsId: newer.obsId, newMicros: other.compareMicros, oldMicros: usualRow.compareMicros,
      downBps: Math.round((usualRow.compareMicros - other.compareMicros) * 10000 / usualRow.compareMicros) };
  }
  return { productId: pid, unit: unit, rows: rows, usualSupplierId: usual, usualMicros: usualRow ? usualRow.compareMicros : null, needsPack: needsPack, needsTaxRate: needsTaxRate, alert: alert };
}

/**
 * The usual supplier for a product: an active account whose preferredFor names the
 * product's category and that has an item for it, else the one paid most recently.
 */
function plUsualSupplier(product, offers, rows, accounts) {
  var have = {}, i, pid = product && product.id;
  for (i = 0; i < rows.length; i++) have[rows[i].supplierId] = true;
  var accts = (accounts || []).slice().sort(function (a, b) { return String(a && (a.supplierId || a.id)) < String(b && (b.supplierId || b.id)) ? -1 : 1; });
  for (i = 0; i < accts.length; i++) {
    var a = accts[i], sid = a && (a.supplierId || a.id);
    if (a && a.active !== false && have[sid] && (a.preferredFor || []).indexOf(product && product.category) !== -1) return sid;
  }
  var usual = null, newest = -1;
  for (i = 0; i < (offers || []).length; i++) {
    var o = offers[i], lp = o && o.productId === pid && o.active !== false && o.latest && o.latest.lastPaid;
    if (lp && typeof lp.observedAtMs === 'number' && lp.observedAtMs > newest) { newest = lp.observedAtMs; usual = o.supplierId; }
  }
  return usual;
}

/**
 * Price move on one item: its current price is at least the threshold above what was
 * last paid that supplier for it. Both sides on one basis: the per-catalog-unit price
 * when both have one, else the stated price when both state the same unit; tax as in
 * compareProduct. ctx: { nowMs, accounts, taxBps, alertBps }. Answers an alert or null.
 */
function priceMoveAlert(offer, ctx) {
  ctx = ctx || {};
  var lt = (offer && offer.latest) || {}, b = lt.best, lp = lt.lastPaid, alertBps = ctx.alertBps;
  if (!b || !lp || !plIsPosInt(alertBps) || b.obsId === lp.obsId || offer.active === false) return null;
  if (!(b.observedAtMs >= lp.observedAtMs) || !plFresh(b, ctx.nowMs, plAccountOf(ctx.accounts, offer.supplierId))) return null;
  var nw, old;
  if (plIsPosInt(b.catalogMicros) && plIsPosInt(lp.catalogMicros)) { nw = b.catalogMicros; old = lp.catalogMicros; }
  else if (b.statedUnit != null && b.statedUnit === lp.statedUnit && b.per === lp.per && plIsPosInt(b.priceMicros) && plIsPosInt(lp.priceMicros)) { nw = b.priceMicros; old = lp.priceMicros; }
  else return null;
  if (typeof lp.taxIncluded !== 'boolean') return null;
  var bIn = b.taxIncluded === true, lpIn = lp.taxIncluded;
  if (bIn !== lpIn) {
    if (typeof ctx.taxBps !== 'number') return null;
    if (!bIn) nw = applyTaxMicros(nw, ctx.taxBps); else old = applyTaxMicros(old, ctx.taxBps);
  }
  if (nw <= old || (nw - old) * 10000 < alertBps * old) return null;
  return { id: 'move_' + offer.id, type: 'move', productId: offer.productId || null, offerId: offer.id, supplierId: offer.supplierId,
    obsId: b.obsId, newMicros: nw, oldMicros: old, upBps: Math.round((nw - old) * 10000 / old) };
}

/** A "seen" mark as the save op takes it: { alertId, obsId }. */
function sanitizeSeenMark(d) {
  d = d || {};
  if (typeof d.alertId !== 'string' || !/^(move|cheaper)_[A-Za-z0-9_-]{1,140}$/.test(d.alertId)) return plBad('bad_alert');
  if (typeof d.obsId !== 'string' || !/^[A-Za-z0-9_-]{1,140}$/.test(d.obsId)) return plBad('bad_alert');
  return { ok: true, value: { alertId: d.alertId, obsId: d.obsId } };
}

/**
 * Every alert for the company, worked out from the stored offers. input: { products,
 * offers, accounts, settings: { taxBps, alertBps }, seen: { alertId: obsId }, nowMs }.
 * An alert is seen while its mark names its newest price; a newer price brings it back.
 */
function supplierAlerts(input) {
  input = input || {};
  var st = input.settings || {}, seen = input.seen || {}, offers = input.offers || [], i;
  var ctx = { nowMs: input.nowMs, accounts: input.accounts, taxBps: st.taxBps, alertBps: st.alertBps };
  var alerts = [], comparisons = [], needsPack = 0, needsTaxRate = false, linked = {};
  for (i = 0; i < offers.length; i++) if (offers[i] && offers[i].productId && offers[i].active !== false) linked[offers[i].productId] = true;
  var products = input.products || [];
  for (i = 0; i < products.length; i++) {
    var p = products[i];
    if (!p || !linked[p.id]) continue;
    var c = compareProduct(p, offers, ctx);
    comparisons.push(c);
    needsPack += c.needsPack;
    if (c.needsTaxRate) needsTaxRate = true;
    if (c.alert) alerts.push(c.alert);
  }
  for (i = 0; i < offers.length; i++) { var m = priceMoveAlert(offers[i], ctx); if (m) alerts.push(m); }
  var open = 0;
  for (i = 0; i < alerts.length; i++) { alerts[i].seen = seen[alerts[i].id] === alerts[i].obsId; if (!alerts[i].seen) open++; }
  return { alerts: alerts, open: open, needsPack: needsPack, needsTaxRate: needsTaxRate, comparisons: comparisons };
}

var PL_STOP_WORDS = ['the', 'and', 'for', 'with', 'per', 'in', 'ft', 'lf', 'sq', 'ea', 'each', 'pc', 'pcs', 'box', 'bx', 'bdl', 'roll', 'rl'];
function plTokens(s) {
  var raw = String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/), out = [];
  for (var i = 0; i < raw.length; i++) if (raw[i].length >= 2 && PL_STOP_WORDS.indexOf(raw[i]) === -1 && out.indexOf(raw[i]) === -1) out.push(raw[i]);
  return out;
}
function plSkuKey(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

/**
 * A suggested product for an unlinked item: its SKU (or an alternate id) equal to a
 * product's SKU first ('sku'), else the closest name by shared words ('name', at
 * least two shared and a Dice score of 0.3). Archived products are never suggested.
 * Only a suggestion: nothing links until a person taps it.
 */
function suggestLink(offer, products) {
  offer = offer || {};
  var alt = offer.altIds || {}, keys = [], i, ids = [offer.sku, alt.mfrPart, alt.model, alt.internetSku, alt.upc];
  for (i = 0; i < ids.length; i++) { var k = plSkuKey(ids[i]); if (k.length >= 3) keys.push(k); }
  var live = [];
  for (i = 0; i < (products || []).length; i++) if (products[i] && products[i].id && products[i].isActive !== false) live.push(products[i]);
  for (i = 0; i < live.length; i++) { var ps = plSkuKey(live[i].sku); if (ps.length >= 3 && keys.indexOf(ps) !== -1) return { productId: live[i].id, kind: 'sku', score: 1 }; }
  var a = plTokens(offer.title), best = null;
  if (!a.length) return null;
  for (i = 0; i < live.length; i++) {
    var b = plTokens(live[i].name), shared = 0;
    for (var j = 0; j < a.length; j++) if (b.indexOf(a[j]) !== -1) shared++;
    var score = (2 * shared) / (a.length + b.length);
    if (shared >= 2 && score >= 0.3 && (!best || score > best.score)) best = { productId: live[i].id, kind: 'name', score: Math.round(score * 1000) / 1000 };
  }
  return best;
}

// ---- Slice 4 (Jo, 2026-11-17): approve a supplier price into the cost book ----

/**
 * Money at the cost book boundary (design 5.1). The cost book holds dollars as
 * floats; this system writes whole cents only. bookMicros is a price as the cost
 * book would hold it, so "has it changed" is always asked in whole cents.
 */
function microsToCostBookDollars(m) { return Math.round(m / 10000) / 100; }
function dollarsToMicros(d) { return Math.round(d * 1000000); }
function bookMicros(m) { return dollarsToMicros(microsToCostBookDollars(m)); }
function plDollarsToCents(d) { return (typeof d === 'number' && isFinite(d)) ? Math.round(d * 100) : null; }
function plCentsToDollars(c) { return c / 100; }

/**
 * The company's margin floor for a cost change, in tenths of a percent, or null
 * when none is set: the estimate floor (companyProfile.pricing.marginFloor.floorPct,
 * Jo 2026-11-17). Above 0 and under 95, one decimal, as margin-floor.js reads it.
 */
function marginFloorTenths(profile) {
  var f = profile && profile.pricing && profile.pricing.marginFloor;
  var v = f ? f.floorPct : null;
  if (v === null || v === undefined || v === '') return null;
  var n = Number(v);
  if (!isFinite(n) || n <= 0 || n >= 95) return null;
  return Math.round(n * 10);
}

/** Margin after labor, (sell - cost - labor) / sell, in whole tenths of a percent (rounded down). Null with no sell. */
function marginAfterLabor(sellCents, costCents, laborCents) {
  if (!plIsPosInt(sellCents) || typeof costCents !== 'number') return null;
  return Math.floor((sellCents - costCents - (laborCents || 0)) * 1000 / sellCents);
}

var PL_APPROVE_KINDS = ['paid', 'quote', 'contract', 'price_sheet', 'portal_read', 'api_account'];
var PL_APPROVE_PRICE_TYPES = ['net', 'account'];

/**
 * Can this price row be approved into the cost book? (Jo, 2026-11-17: fresh own
 * paperwork only.) row: the observation, with observedAtMs and validThroughMs as
 * numbers. Answers { ok: true } or { ok: false, reason }.
 */
function approvalSource(row, nowMs, quoteValidDays) {
  if (!row) return plBad('no_price');
  if (row.voided === true) return plBad('changed');
  if (PL_APPROVE_KINDS.indexOf(row.kind) === -1) return plBad('not_paperwork');
  if (row.attested !== true) return plBad('not_paperwork');
  if (PL_APPROVE_PRICE_TYPES.indexOf(row.priceType) === -1) return plBad('price_type');
  if (row.delivered === true) return plBad('delivered');
  if (row.compare !== true) return plBad('not_comparable');
  var flags = row.flags || [];
  if (flags.indexOf('unit_suspect') !== -1 || flags.indexOf('unit_mismatch') !== -1) return plBad('unit_suspect');
  if (evidenceLevel(row, nowMs, quoteValidDays) > 2) return plBad('stale');
  return { ok: true };
}

/**
 * The lines a person can approve for one product from one offer's price, one per
 * tier the item is for. input: {
 *   product: { id, unit, pricing: { <tier>: { sell } } }  (dollars, as the library holds them)
 *   offer, row (the observation, its catalogMicros from the offer's current pack),
 *   book: the catalogCosts document or null, taxBps, floorTenths, nowMs, quoteValidDays }
 * Answers { blocked, lines: [{ tier, fromCents, toCents, created, blocked,
 *   guard: { sellCents, laborCents, laborKnown, marginBefore, marginAfter, belowFloor, aboveSell } }] }.
 * blocked (for every line): no_price, not_paperwork, price_type, delivered,
 * not_comparable, unit_suspect, stale, needs_pack, unit_changed, needs_tax_rate,
 * no_cost_book. A line's own: below_one_cent, no_change. A blocked line can not be approved.
 */
function proposalLines(input) {
  input = input || {};
  var product = input.product || {}, offer = input.offer || {}, row = input.row, book = input.book;
  var blocked = null;
  var src = approvalSource(row, input.nowMs, input.quoteValidDays);
  if (!src.ok) blocked = src.reason;
  else if (!validPack(offer.pack) || offer.pack.verified !== true) blocked = 'needs_pack';
  else if (offer.pack.catalogUnit !== product.unit) blocked = 'unit_changed';
  else if (!plIsPosInt(row.catalogMicros)) blocked = 'needs_pack';
  else if (typeof input.taxBps !== 'number') blocked = 'needs_tax_rate';
  var costs = book && book.costs && typeof book.costs === 'object' ? book.costs : null;
  if (!blocked && (!costs || !Object.keys(costs).length)) blocked = 'no_cost_book';
  var entry = (costs && costs[product.id] && typeof costs[product.id] === 'object') ? costs[product.id] : null;
  var laborC = entry && entry.labor ? plDollarsToCents(entry.labor.perUnit) : null;
  var laborKnown = laborC !== null && laborC > 0;
  if (laborC === null || laborC < 0) laborC = 0;
  var toCents = null;
  if (!blocked) toCents = microsToCents(bookMicros(row.taxIncluded === true ? row.catalogMicros : applyTaxMicros(row.catalogMicros, input.taxBps)));
  var tiers = (offer.tiers && offer.tiers.length) ? offer.tiers : ['good'], lines = [];
  for (var i = 0; i < tiers.length; i++) {
    var t = tiers[i];
    if (PL_TIERS.indexOf(t) === -1) continue;
    var fromC = entry && entry.cost ? plDollarsToCents(entry.cost[t]) : null;
    var tierP = product.pricing && product.pricing[t];
    var sellC = tierP ? plDollarsToCents(tierP.sell) : null;
    if (sellC !== null && sellC <= 0) sellC = null;
    var line = { tier: t, fromCents: fromC, toCents: toCents, created: fromC === null, blocked: blocked,
      guard: { sellCents: sellC, laborCents: laborC, laborKnown: laborKnown, marginBefore: fromC === null ? null : marginAfterLabor(sellC, fromC, laborC),
        marginAfter: toCents === null ? null : marginAfterLabor(sellC, toCents, laborC), belowFloor: false, aboveSell: false } };
    if (!line.blocked && toCents < 1) line.blocked = 'below_one_cent';
    if (!line.blocked && fromC === toCents) line.blocked = 'no_change';
    if (!line.blocked && sellC !== null) {
      line.guard.aboveSell = toCents > sellC;
      line.guard.belowFloor = typeof input.floorTenths === 'number' && (sellC - toCents - laborC) * 1000 < input.floorTenths * sellC;
    }
    lines.push(line);
  }
  return { blocked: blocked, lines: lines };
}

/** Does this line need a confirm the call did not carry? Answers null or 'confirm_floor' / 'confirm_above_sell'. */
function costGuardRefusal(line, confirm) {
  confirm = confirm || {};
  if (line.guard.aboveSell && confirm.confirmAboveSell !== true) return 'confirm_above_sell';
  if (line.guard.belowFloor && confirm.confirmBelowFloor !== true) return 'confirm_floor';
  return null;
}

/** The change from one cost to another in tenths of a percent (rounded), or null with no old cost. */
function changeTenths(fromCents, toCents) {
  if (!plIsPosInt(fromCents) || typeof toCents !== 'number') return null;
  return Math.round((toCents - fromCents) * 1000 / fromCents);
}
/** Tenths of a percent as text: 574 -> '57.4%', -25 -> '-2.5%'. */
function tenthsText(t) {
  if (typeof t !== 'number' || !isFinite(t)) return '';
  var a = Math.abs(Math.round(t));
  return (t < 0 ? '-' : '') + Math.floor(a / 10) + '.' + (a % 10) + '%';
}

/** Is the ledger switched on for this person? Only the boolean true turns it on. */
function flagOn(flagsDefault, flagsMine) {
  var merged = {}, k;
  for (k in (flagsDefault || {})) if (Object.prototype.hasOwnProperty.call(flagsDefault, k)) merged[k] = flagsDefault[k];
  for (k in (flagsMine || {})) if (Object.prototype.hasOwnProperty.call(flagsMine, k)) merged[k] = flagsMine[k];
  return merged[FLAG_NAME] === true;
}
// ---- END SHARED ----

module.exports = {
  FLAG_NAME, FLAG_DEFAULT, SUPPLIERS, supplierOf, UNITS, CATALOG_UNIT_OF, NO_PURCHASE_TWIN,
  normaliseUom, sameUnit, validPack, suggestPack,
  moneyTextToMicros, centsToMicros, microsToCents, microsToText, toCatalogMicros, suspectUnitSwap,
  KINDS, CALLER_KINDS, evidenceLevel, currentRows, bestForOffer,
  offerIdFor, obsIdFor, urlAllowedFor,
  sanitizeSupplierAccount, sanitizePack, sanitizeOffer, sanitizeObservation,
  NULL_UNIT_CHANNELS, stubOffer, catalogMicrosFor, legacyPurchaseToRow, legacyItemToLedger,
  summarize, flagOn,
  parseCsv, guessColumns, guessHeaderRow, IMPORT_DOC_KINDS, buildImport, applyTaxMicros, removeTaxMicros,
  supplierCompareSettings, quoteExpiryState, compareProduct, priceMoveAlert, sanitizeSeenMark, supplierAlerts, suggestLink,
  microsToCostBookDollars, dollarsToMicros, bookMicros, marginFloorTenths, marginAfterLabor, approvalSource, proposalLines, costGuardRefusal, changeTenths, tenthsText,
};
