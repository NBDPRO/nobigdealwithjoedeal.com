/**
 * scripts/import-line-costs.js
 *
 * Loads ONE company's own material and labor cost for estimate line types (the
 * codes of NBD_XACT_CATALOG, docs/pro/js/estimate-catalog-xactimate.js) into
 * catalogCosts/{companyId}.xactCosts, from a sheet the owner filled in.
 *
 * Why (Jo, 2026-11-17): the line-item builder and the job templates price every
 * coded line from the tenant's xactCosts entry and fall back to the published
 * starter baseline when there is none. A cost book with no line costs therefore
 * quotes, and reports margin, off figures that are not the company's. No screen
 * writes xactCosts, and scripts/merge-catalog-costs.js --xact only updates the
 * material cost of an entry that already exists, so it can not start a book.
 *
 * THE SHEET (CSV, kept OUTSIDE the repo: these are cost figures)
 *   Needs the columns `code`, `material_cost_per_unit_tax_included` and
 *   `labor_cost_per_unit`; any other column is ignored. One row per line type.
 *     both costs filled in   -> loaded (a 0 is a real cost: a labor-only line)
 *     both blank             -> skipped (not started)
 *     one filled in          -> left out and named: xactCost() ignores an entry
 *                               that is missing either number
 *   So a half-finished sheet loads what is finished.
 *
 * SAFETY
 *   • Dry run by default: reads the sheet and the live document, prints COUNTS
 *     and codes, writes nothing.
 *   • --company=<companyId> and --in=<file> are REQUIRED. Only that tenant.
 *   • --apply requires --yes as well.
 *   • One bad row (an unknown code, a negative or non-numeric cost, zero on both,
 *     a code listed twice) stops the run with nothing written.
 *   • A code that already has a line cost is not overwritten without --force.
 *   • Before any write the live document is saved to .local/ (gitignored).
 *   • Writes only the named codes under xactCosts (a merge); the product cost
 *     book (`costs`), jtCosts and every other code are untouched.
 *   • Prints counts and codes only: never a cost.
 *   • Agents never run this with --apply unless Jo approved that run in chat
 *     (CLAUDE.md rule f).
 *
 * RUN
 *   node scripts/import-line-costs.js --company=<id> --in=<sheet.csv>               # dry run
 *   node scripts/import-line-costs.js --company=<id> --in=<sheet.csv> --apply --yes # write
 */
'use strict';

const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COLLECTION = 'catalogCosts';
const MAX_COST = 1000000;
const COL = { code: 'code', material: 'material_cost_per_unit_tax_included', labor: 'labor_cost_per_unit' };

/** Flags from argv (pure). */
function parseArgs(argv) {
  const a = argv || [];
  const val = (name) => ((a.find((x) => String(x).startsWith(name + '=')) || '').slice(name.length + 1) || '').trim();
  return { company: val('--company'), in: val('--in'), apply: a.includes('--apply'), yes: a.includes('--yes'), force: a.includes('--force') };
}

/** Why this run is refused, or null (pure). */
function refusal(args) {
  if (!args.company || !VALID_ID.test(args.company)) return 'Required: --company=<companyId>';
  if (!args.in) return 'Required: --in=<the filled-in sheet, a CSV kept outside the repo>';
  if (args.apply && !args.yes) return 'Refusing to --apply without --yes.';
  return null;
}

/** CSV text to [{ code, material, labor }] (cells as typed). Throws when a needed column is missing. */
function parseSheet(text) {
  const rows = []; let row = [], cur = '', q = false;
  const t = String(text == null ? '' : text).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) { if (ch === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  const head = (rows.shift() || []).map((h) => String(h).trim());
  const at = {};
  Object.keys(COL).forEach((k) => { at[k] = head.indexOf(COL[k]); });
  const missing = Object.keys(COL).filter((k) => at[k] === -1).map((k) => COL[k]);
  if (missing.length) throw new Error('the sheet has no column: ' + missing.join(', '));
  return rows.filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => ({
    code: String(r[at.code] == null ? '' : r[at.code]).trim(),
    material: String(r[at.material] == null ? '' : r[at.material]).trim(),
    labor: String(r[at.labor] == null ? '' : r[at.labor]).trim(),
  }));
}

/** A typed amount ("11.11", "$1,111.00", "0") to a number of dollars, or null. */
function money(text) {
  let t = String(text).trim();
  if (t.charAt(0) === '$') t = t.slice(1).trim();
  if (/^\d{1,3}(,\d{3})+(\.\d{1,4})?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^\d{1,7}(\.\d{1,4})?$/.test(t)) return null;
  const n = Number(t);
  return (Number.isFinite(n) && n >= 0 && n <= MAX_COST) ? n : null;
}

/**
 * What the sheet would write (pure).
 *   rows      from parseSheet
 *   codes     a Set of the catalog's codes
 *   existing  the live xactCosts map (or {})
 * Error lines name the code and the problem, never a figure.
 */
function plan(rows, codes, existing) {
  const out = { xactCosts: {}, errors: [], incomplete: [], existing: [], counts: { rows: 0, ready: 0, blank: 0, incomplete: 0, existing: 0 } };
  const seen = new Set();
  (rows || []).forEach((r) => {
    out.counts.rows++;
    const code = r.code;
    if (!code) { out.errors.push('a row has no code'); return; }
    if (seen.has(code)) { out.errors.push(code + ': listed twice'); return; }
    seen.add(code);
    if (!codes.has(code)) { out.errors.push(code + ': not a line type in the catalog'); return; }
    const hasM = r.material !== '', hasL = r.labor !== '';
    if (!hasM && !hasL) { out.counts.blank++; return; }
    if (!hasM || !hasL) { out.counts.incomplete++; out.incomplete.push(code); return; }
    const m = money(r.material), l = money(r.labor);
    if (m === null) { out.errors.push(code + ': the material cost is not a number from 0 up'); return; }
    if (l === null) { out.errors.push(code + ': the labor cost is not a number from 0 up'); return; }
    if (m === 0 && l === 0) { out.errors.push(code + ': both costs are 0 (leave both blank if it is not filled in yet)'); return; }
    out.xactCosts[code] = { materialCost: m, laborCost: l };
    out.counts.ready++;
    if (existing && Object.prototype.hasOwnProperty.call(existing, code)) { out.existing.push(code); out.counts.existing++; }
  });
  return out;
}

/**
 * Read, plan and (only with apply) write. Everything it touches is passed in.
 *   io = { db, company, text, codes, apply, force, backup(liveDoc), stamp }
 */
async function run(io) {
  const ref = io.db.doc(COLLECTION + '/' + io.company);
  const snap = await ref.get();
  const live = snap.exists ? (snap.data() || {}) : null;
  const p = plan(parseSheet(io.text), io.codes, (live && live.xactCosts) || {});
  const result = Object.assign({ mode: io.apply ? 'APPLY' : 'DRY-RUN', written: 0, refused: false, errors: p.errors, incompleteCodes: p.incomplete, existingCodes: p.existing }, p.counts);
  if (p.errors.length) { result.refused = true; return result; }
  if (!io.apply || !p.counts.ready) return result;
  if (p.existing.length && !io.force) { result.refused = true; return result; }
  if (typeof io.backup === 'function') await io.backup(live);
  // A merge: only the codes named here change; `costs`, `jtCosts` and every other code stay as they are.
  await ref.set({ xactCosts: p.xactCosts, xactImportedAt: io.stamp !== undefined ? io.stamp : new Date() }, { merge: true });
  result.written = p.counts.ready;
  return result;
}

module.exports = { parseArgs, refusal, parseSheet, plan, run, COLLECTION };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const no = refusal(args);
  if (no) { console.error(no); process.exit(2); }

  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const ROOT = path.join(__dirname, '..');

  let text;
  try { text = fs.readFileSync(path.resolve(args.in), 'utf8'); }
  catch (e) { console.error('Cannot read the sheet: ' + e.message); process.exit(2); }

  // The catalog's codes, from the working tree (public: codes and names only).
  const win = {}; win.window = win;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'estimate-catalog-xactimate.js'), 'utf8'), { window: win, console: { log() {}, warn() {}, error() {}, info() {} } });
  const codes = new Set(((win.NBD_XACT_CATALOG && win.NBD_XACT_CATALOG.items) || []).map((i) => i.code));
  if (!codes.size) { console.error('The line catalog did not load.'); process.exit(2); }

  const { initAdmin, getFirestore, FieldValue } = require('./_admin');
  const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

  (async () => {
    initAdmin({ projectId: PROJECT });
    console.log('Line costs  project=' + PROJECT + '  target=' + COLLECTION + '/' + args.company + '.xactCosts  mode=' + (args.apply ? 'APPLY' : 'DRY-RUN'));
    const result = await run({
      db: getFirestore(), company: args.company, text, codes, apply: args.apply, force: args.force, stamp: FieldValue.serverTimestamp(),
      backup: async (live) => {
        const dir = path.resolve(ROOT, '.local');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'catalogCosts-' + args.company + '-' + new Date().toISOString().replace(/[:.]/g, '-') + '.backup.json');
        fs.writeFileSync(file, JSON.stringify(live, null, 2));
        console.log('backup: ' + file);
      },
    });
    console.log(JSON.stringify(result, null, 1));
    if (result.errors.length) console.error('Nothing written: fix the rows above and run again.');
    else if (result.refused) console.error('Nothing written: ' + result.existingCodes.length + ' code(s) already have a line cost. Re-run with --force to replace them.');
    else if (!args.apply) console.log('(dry run: re-run with --apply --yes to write)');
    process.exit(result.refused ? 1 : 0);
  })().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(2); });
}
