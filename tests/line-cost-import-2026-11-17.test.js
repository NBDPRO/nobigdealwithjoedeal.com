/**
 * tests/line-cost-import-2026-11-17.test.js
 *
 * scripts/import-line-costs.js: loads ONE company's own material and labor cost
 * for estimate line types (the Xactimate-style catalog codes) into
 * catalogCosts/{companyId}.xactCosts, from a sheet the owner filled in
 * (Jo, 2026-11-17: the line-item builder was pricing from the published starter
 * baseline because the cost book held no line costs).
 *
 * Guards:
 *   - dry run by default; --company required; --apply needs --yes
 *   - a row is written only when BOTH costs are filled in (xactCost() ignores an
 *     entry missing either), so a half-filled sheet loads what is finished
 *   - a code the catalog does not have, a negative or non-numeric cost, and a row
 *     that is zero on both are refused, and nothing is written
 *   - a code that already has an entry is not overwritten without --force
 *   - only the named codes are written; the product cost book is untouched
 *   - a backup is taken before any write; the result carries counts and codes,
 *     never a cost
 *
 * Every figure here is synthetic (multiples of 1111 cents).
 * Pure-Node. Run: node tests/line-cost-import-2026-11-17.test.js
 */
'use strict';

const path = require('path');
const M = require(path.join(__dirname, '..', 'scripts', 'import-line-costs.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const HEAD = 'code,line,priced_per,material_cost_per_unit_tax_included,labor_cost_per_unit,prefilled_from,note\n';
const sheet = (rows) => '﻿' + HEAD + rows.join('\n') + '\n';
const CODES = new Set(['RFG SYN', 'RFG IWS', 'LAB TO1', 'LAB MOB', 'RFG STRT']);

function fakeDb(existing) {
  const state = { doc: existing === undefined ? null : JSON.parse(JSON.stringify(existing)), sets: [] };
  return {
    state,
    doc: (p) => ({
      path: p,
      get: async () => ({ exists: state.doc !== null, data: () => state.doc }),
      set: async (v, o) => { state.sets.push({ path: p, v, o }); },
    }),
  };
}

(async () => {
  console.log('\nFlags');
  {
    ok('no --company is refused', M.refusal(M.parseArgs([])) !== null);
    ok('--apply without --yes is refused', /--yes/.test(M.refusal(M.parseArgs(['--company=co-a', '--in=x.csv', '--apply'])) || ''));
    ok('no --in is refused', /--in/.test(M.refusal(M.parseArgs(['--company=co-a'])) || ''));
    ok('a company id that is not an id is refused', M.refusal(M.parseArgs(['--company=a/b', '--in=x.csv'])) !== null);
    const dry = M.parseArgs(['--company=co-a', '--in=x.csv']);
    ok('--company and --in alone are a dry run', M.refusal(dry) === null && dry.apply === false && dry.force === false);
  }

  console.log('\nReading the sheet');
  {
    const rows = M.parseSheet(sheet(['"RFG SYN","Synthetic, standard",square,11.11,22.22,"x","CHECK THIS"', '"LAB TO1","Tear off",square,0,$33.33,,', '"LAB MOB","Mobilization",job,,,,', 'RFG IWS,Ice and water,square,"1,111.00",,,']));
    ok('quoted cells, a BOM, a $ sign and a thousands comma are read', rows.length === 4 && rows[0].code === 'RFG SYN' && rows[0].material === '11.11' && rows[1].labor === '$33.33' && rows[3].material === '1,111.00', rows);
    ok('a sheet with no code column is refused', (() => { try { M.parseSheet('a,b\n1,2\n'); return false; } catch (e) { return /code/.test(e.message); } })());
  }

  console.log('\nThe plan');
  {
    const p = M.plan(M.parseSheet(sheet(['RFG SYN,,square,11.11,22.22,,', 'LAB TO1,,square,0,33.33,,', 'LAB MOB,,job,,,,', 'RFG IWS,,square,"1,111.00",,,', 'RFG STRT,,linear foot,,44.44,,'])), CODES, {});
    ok('a row with both costs is planned, as numbers', p.errors.length === 0 && p.xactCosts['RFG SYN'].materialCost === 11.11 && p.xactCosts['RFG SYN'].laborCost === 22.22, p);
    ok('an explicit 0 on one side is a real cost', p.xactCosts['LAB TO1'].materialCost === 0 && p.xactCosts['LAB TO1'].laborCost === 33.33);
    ok('a row with nothing filled in is skipped as not started', p.counts.blank === 1 && !('LAB MOB' in p.xactCosts));
    ok('a row with only one cost filled in is left out and named', p.counts.incomplete === 2 && p.incomplete.join() === 'RFG IWS,RFG STRT' && !('RFG IWS' in p.xactCosts));
    ok('the counts add up', p.counts.rows === 5 && p.counts.ready === 2, p.counts);

    const bad = M.plan(M.parseSheet(sheet(['RFG NOPE,,square,11.11,22.22,,', 'RFG SYN,,square,-1,22.22,,', 'RFG IWS,,square,abc,22.22,,', 'LAB TO1,,square,0,0,,', 'LAB MOB,,job,11.11,22.22,,', 'LAB MOB,,job,11.11,22.22,,'])), CODES, {});
    ok('an unknown code, a negative, a non-number, zero on both and a repeated code are errors', bad.errors.length === 5 && /RFG NOPE/.test(bad.errors.join('|')) && /twice/.test(bad.errors.join('|')), bad.errors);
    ok('no error line repeats a cost figure', !/11\.11|22\.22/.test(bad.errors.join('|')), bad.errors);

    const over = M.plan(M.parseSheet(sheet(['RFG SYN,,square,11.11,22.22,,', 'LAB TO1,,square,0,33.33,,'])), CODES, { 'RFG SYN': { materialCost: 1, laborCost: 2 } });
    ok('a code that already has a cost is held back and named', over.existing.join() === 'RFG SYN' && over.counts.ready === 2 && over.counts.existing === 1, over);
  }

  console.log('\nRun');
  {
    const text = sheet(['RFG SYN,,square,11.11,22.22,,', 'LAB TO1,,square,0,33.33,,', 'LAB MOB,,job,,,,']);
    const io = (db, extra) => Object.assign({ db, company: 'co-a', text, codes: CODES, apply: false, force: false, backup: async () => { backups++; } }, extra || {});
    let backups = 0;

    const d0 = fakeDb({ costs: { shingle_001: { cost: { good: 1 } } } });
    const dry = await M.run(io(d0));
    ok('a dry run writes nothing and takes no backup', dry.mode === 'DRY-RUN' && dry.ready === 2 && dry.written === 0 && d0.state.sets.length === 0 && backups === 0, dry);

    const wet = await M.run(io(d0, { apply: true }));
    const w = d0.state.sets[0];
    ok('an apply backs up once and writes one merge', wet.written === 2 && backups === 1 && d0.state.sets.length === 1 && w.path === 'catalogCosts/co-a' && w.o && w.o.merge === true, [wet, d0.state.sets.length]);
    ok('it writes only xactCosts for the ready codes, and a timestamp', Object.keys(w.v).sort().join() === 'xactCosts,xactImportedAt' && Object.keys(w.v.xactCosts).sort().join() === 'LAB TO1,RFG SYN' && !('costs' in w.v), Object.keys(w.v));
    ok('the result carries counts and codes, never a cost', !/11\.11|22\.22|33\.33/.test(JSON.stringify(wet)), wet);

    const d1 = fakeDb({ xactCosts: { 'RFG SYN': { materialCost: 1, laborCost: 2 } } });
    const held = await M.run(io(d1, { apply: true }));
    ok('without --force, a code that already has a cost stops the run with nothing written', held.refused === true && held.written === 0 && d1.state.sets.length === 0, held);
    const forced = await M.run(io(d1, { apply: true, force: true }));
    ok('with --force it is replaced', forced.written === 2 && d1.state.sets.length === 1 && d1.state.sets[0].v.xactCosts['RFG SYN'].materialCost === 11.11);

    const d2 = fakeDb({});
    const broken = await M.run(io(d2, { apply: true, text: sheet(['RFG NOPE,,square,11.11,22.22,,', 'RFG SYN,,square,11.11,22.22,,']) }));
    ok('one bad row stops the whole run: nothing written', broken.refused === true && broken.errors.length === 1 && broken.written === 0 && d2.state.sets.length === 0, broken);

    const d3 = fakeDb(undefined);
    const fresh = await M.run(io(d3, { apply: true }));
    ok('a company with no cost book document yet still gets its line costs', fresh.written === 2 && d3.state.sets.length === 1);
    const none = await M.run(io(fakeDb({}), { apply: true, text: sheet(['LAB MOB,,job,,,,']) }));
    ok('a sheet with nothing finished writes nothing', none.ready === 0 && none.written === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
