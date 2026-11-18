#!/usr/bin/env node
/**
 * scripts/build-product-seed-public.js: writes functions/product-seed-public.json,
 * the published catalog's unit and retail sells per product, for the server
 * (live supplier pricing slice 4, documentation/projects/LIVE-SUPPLIER-PRICING-SLICE-4-PLAN-2026-11-17.md).
 *
 * The functions bundle does not contain docs/, and approving a supplier price into
 * the cost book needs each product's current unit (a per-square cost must never
 * land on a product priced per bundle) and its sell (the margin guards). A
 * company's own library rows (productLibrary/{companyId}.items) win over this file.
 *
 * Only public figures: the unit and the retail sells that docs/pro/js/product-data.js
 * and roofivent-catalog.js already publish. Never a cost and never labor.
 *
 *   node scripts/build-product-seed-public.js           write the file
 *   node scripts/build-product-seed-public.js --check   exit 1 when the file is stale
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['docs/pro/js/product-data.js', 'docs/pro/js/roofivent-catalog.js'];
const OUT = path.join(ROOT, 'functions', 'product-seed-public.json');
const TIERS = ['good', 'better', 'best'];

/** { id: { unit, sell: { good, better, best } } } from the published catalog files, ids sorted. */
function build() {
  const win = {};
  const ctx = { window: win, console: { log() {}, info() {}, warn() {}, error() {} } };
  vm.createContext(ctx);
  SOURCES.forEach((rel) => vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), ctx, { filename: rel }));
  const out = {};
  (win.NBD_PRODUCTS || []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).forEach((p) => {
    if (!p || typeof p.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(p.id)) return;
    const sell = {};
    TIERS.forEach((t) => {
      const v = p.pricing && p.pricing[t] && p.pricing[t].sell;
      sell[t] = (typeof v === 'number' && isFinite(v)) ? v : null;
    });
    out[p.id] = { unit: typeof p.unit === 'string' ? p.unit : null, sell };
  });
  return out;
}

const text = () => JSON.stringify(build(), null, 1) + '\n';

if (require.main === module) {
  const want = text();
  if (process.argv.includes('--check')) {
    const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (have !== want) {
      console.error('functions/product-seed-public.json is stale. Run: node scripts/build-product-seed-public.js');
      process.exit(1);
    }
    console.log('product-seed-public.json is current (' + Object.keys(JSON.parse(want)).length + ' products).');
  } else {
    fs.writeFileSync(OUT, want);
    console.log('wrote functions/product-seed-public.json (' + Object.keys(JSON.parse(want)).length + ' products).');
  }
}

module.exports = { build, text, OUT };
