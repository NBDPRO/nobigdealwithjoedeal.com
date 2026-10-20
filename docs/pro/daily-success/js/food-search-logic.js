/**
 * food-search-logic.js — the pure rules behind "Find a food" (Daily Success,
 * tracker revamp Phase 2: food search + barcode lookup, Jo 2026-10-20).
 *
 * Data comes from Open Food Facts (free, open, no key). Only the words Jo
 * typed, or a barcode number, leave the device — nothing about him.
 *   searchUrl(q) / barcodeUrl(code)   the two GET URLs
 *   parseSearch(json)                 → up to 12 normalized foods
 *   parseProduct(json)                → one normalized food (barcode hit) or null
 *   normalizeProduct(p)               → { code, name, brand, label, p, c, f, cal } per serving, or null
 *   scaleFood / toFav                 servings multiplier → the row the food log adds to a meal
 *   validBarcode(code)                EAN-8 / UPC-A / EAN-13 / GTIN-14 check digit
 *
 * Macros are per SERVING when the label gives one (or a gram weight to scale
 * the per-100 g numbers by); otherwise per 100 g, and the label says so. A
 * product with no calories/protein/carbs/fat at all is dropped — it would add
 * a blank row.
 *
 * Exposed as window.NBDFoodSearch and module.exports (tests).
 */
(function (root) {
  'use strict';

  const BASE = 'https://world.openfoodfacts.org';
  const FIELDS = 'code,product_name,brands,serving_size,serving_quantity,nutriments';

  const num = (v) => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : NaN; };
  const r1 = (v) => Math.round(v * 10) / 10;
  const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  function searchUrl(q) {
    const term = clean(q).slice(0, 80);
    return BASE + '/cgi/search.pl?search_terms=' + encodeURIComponent(term) +
      '&search_simple=1&action=process&json=1&page_size=12&fields=' + FIELDS;
  }
  function barcodeUrl(code) {
    return BASE + '/api/v2/product/' + encodeURIComponent(String(code).replace(/\D/g, '')) + '.json?fields=' + FIELDS;
  }

  /** GS1 check digit over 8, 12, 13 or 14 digits. */
  function validBarcode(code) {
    const s = String(code == null ? '' : code).trim();
    if (!/^\d+$/.test(s) || ![8, 12, 13, 14].includes(s.length)) return false;
    let sum = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const d = +s[s.length - 2 - i];
      sum += d * (i % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10 === +s[s.length - 1];
  }

  /** nutriments value for a key, trying the per-serving then the per-100 g field. */
  function pick(n, key, basis) {
    const v = num(n[key + '_' + basis]);
    return isFinite(v) ? v : NaN;
  }

  function normalizeProduct(p) {
    if (!p || typeof p !== 'object') return null;
    const name = clean(p.product_name);
    if (!name) return null;
    const n = p.nutriments || {};
    const grams = num(p.serving_quantity);
    const keys = { p: 'proteins', c: 'carbohydrates', f: 'fat', cal: 'energy-kcal' };
    let out = null;
    // 1. the label's own per-serving numbers
    const perServing = {};
    let anyServing = false;
    for (const k of Object.keys(keys)) { const v = pick(n, keys[k], 'serving'); perServing[k] = isFinite(v) ? v : 0; if (isFinite(v) && v > 0) anyServing = true; }
    if (anyServing) out = Object.assign({ label: clean(p.serving_size) || '1 serving' }, perServing);
    // 2. per-100 g scaled by the serving's gram weight
    const per100 = {};
    let any100 = false;
    for (const k of Object.keys(keys)) { const v = pick(n, keys[k], '100g'); per100[k] = isFinite(v) ? v : 0; if (isFinite(v) && v > 0) any100 = true; }
    if (!out && any100 && isFinite(grams) && grams > 0) {
      out = { label: clean(p.serving_size) || (Math.round(grams) + ' g') };
      for (const k of Object.keys(keys)) out[k] = per100[k] * grams / 100;
    }
    // 3. plain per-100 g
    if (!out && any100) out = Object.assign({ label: '100 g' }, per100);
    if (!out) return null;
    return {
      code: clean(p.code), name: name.slice(0, 80), brand: clean(String(p.brands || '').split(',')[0]).slice(0, 40),
      label: out.label.slice(0, 40), p: r1(out.p), c: r1(out.c), f: r1(out.f), cal: Math.round(out.cal),
    };
  }

  function parseSearch(json) {
    const list = json && Array.isArray(json.products) ? json.products : [];
    const seen = new Set();
    const out = [];
    for (const p of list) {
      const f = normalizeProduct(p);
      if (!f) continue;
      const key = (f.brand + '|' + f.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
      if (out.length >= 12) break;
    }
    return out;
  }

  function parseProduct(json) {
    if (!json || json.status === 0 || !json.product) return null;
    return normalizeProduct(Object.assign({ code: json.code }, json.product));
  }

  function scaleFood(food, servings) {
    const s = num(servings);
    const k = isFinite(s) && s > 0 ? Math.min(s, 20) : 1;
    return { p: r1(food.p * k), c: r1(food.c * k), f: r1(food.f * k), cal: Math.round(food.cal * k), servings: k };
  }

  /** The favorite-shaped row NBDFoodLog.addToMeal takes: { name, p, c, f, cal }. */
  function toFav(food, servings) {
    const sc = scaleFood(food, servings);
    const qty = sc.servings === 1 ? '' : ' ×' + sc.servings;
    const label = (food.brand ? food.brand + ' ' : '') + food.name;
    return { name: (label + qty).slice(0, 100), p: sc.p, c: sc.c, f: sc.f, cal: sc.cal };
  }

  const api = { BASE, searchUrl, barcodeUrl, validBarcode, normalizeProduct, parseSearch, parseProduct, scaleFood, toFav };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDFoodSearch = api;
})(typeof window !== 'undefined' ? window : null);
