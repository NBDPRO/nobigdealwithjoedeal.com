/**
 * tests/margin-floor-logic-2026-11-17.test.js
 *
 * docs/pro/js/margin-floor.js: the pure half of the estimate margin floor
 * (plan: documentation/projects/ESTIMATE-MARGIN-FLOOR-PLAN-2026-11-17.md).
 *
 * The rule (Jo, 2026-11-17): margin = (pre-tax price - material - labor) / pre-tax
 * price, on the job total, on cash jobs; insurance scopes are exempt; a job with
 * an uncosted line has no margin to judge; the floor and the target are a
 * per-company setting that is OFF unless the company sets it; under the floor is
 * a warning with the price that reaches the floor, never a block; only the owner
 * or a company admin finalizes under it.
 *
 * Every figure here is made up. Money is integer cents throughout.
 * Pure-Node. Run: node tests/margin-floor-logic-2026-11-17.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const win = {}; win.window = win;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'margin-floor.js'), 'utf8'), { window: win }, { filename: 'margin-floor.js' });
const F = win.NBDMarginFloor;
const NBD = F.sanitizeSettings({ floorPct: 30, targetPct: 35 });

console.log('\nSettings: off unless a company sets them');
{
  ok('nothing set is off', F.sanitizeSettings(null).on === false && F.sanitizeSettings({}).on === false && F.sanitizeSettings({ floorPct: '' }).on === false);
  ok('a floor and a target are kept', NBD.on === true && NBD.floorPct === 30 && NBD.targetPct === 35, NBD);
  ok('a floor with no target uses the floor as the target', F.sanitizeSettings({ floorPct: 25 }).targetPct === 25);
  ok('a target under the floor is lifted to the floor', F.sanitizeSettings({ floorPct: 30, targetPct: 20 }).targetPct === 30);
  ok('one decimal is kept, more are rounded', F.sanitizeSettings({ floorPct: 32.5 }).floorPct === 32.5 && F.sanitizeSettings({ floorPct: 32.54 }).floorPct === 32.5);
  ok('a string number is read; text, zero, a negative and 95 or more are off', F.sanitizeSettings({ floorPct: '30' }).on === true
    && [{ floorPct: 'thirty' }, { floorPct: 0 }, { floorPct: -5 }, { floorPct: 95 }, { floorPct: NaN }, { floorPct: Infinity }].every((s) => F.sanitizeSettings(s).on === false));
  ok('there is no built-in floor: the module carries no company\'s numbers', F.sanitizeSettings(undefined).floorPct === null && F.sanitizeSettings(undefined).targetPct === null);
}

console.log('\nMargin before tax');
{
  const m = F.marginOf({ preTaxCents: 1000000, costCents: 700000, costKnown: true });
  ok('(price - cost) / price', m.known === true && m.pct === 30 && m.marginCents === 300000, m);
  ok('an unknown cost has no margin', F.marginOf({ preTaxCents: 1000000, costCents: 0, costKnown: false }).known === false && F.marginOf({ preTaxCents: 1000000, costCents: 0, costKnown: false }).pct === null);
  ok('a zero or missing price has no margin', F.marginOf({ preTaxCents: 0, costCents: 100, costKnown: true }).known === false && F.marginOf({ costCents: 100, costKnown: true }).known === false);
  ok('a job sold below cost is a negative margin, not unknown', F.marginOf({ preTaxCents: 100000, costCents: 150000, costKnown: true }).pct === -50);
  ok('non-integer or non-finite cents are refused as unknown', F.marginOf({ preTaxCents: 1000.5, costCents: 1, costKnown: true }).known === false && F.marginOf({ preTaxCents: NaN, costCents: 1, costKnown: true }).known === false);
}

console.log('\nThe price that reaches the floor');
{
  ok('cost / (1 - floor), rounded up to the cent', F.priceForFloorCents(700000, 30) === 1000000 && F.priceForFloorCents(700001, 30) === 1000002);
  const p = F.priceForFloorCents(123457, 30);
  ok('it reaches the floor and one cent less does not', F.check({ mode: 'cash', preTaxCents: p, costCents: 123457, costKnown: true, settings: NBD }).state === 'ok'
    && F.check({ mode: 'cash', preTaxCents: p - 1, costCents: 123457, costKnown: true, settings: NBD }).state === 'under', p);
  ok('rounded up to the builder\'s rounding step when one is given', F.priceForFloorCents(700001, 30, 2500) === 1002500 && F.priceForFloorCents(700000, 30, 2500) === 1000000);
  ok('no cost or no floor gives null', F.priceForFloorCents(0, 30) === null && F.priceForFloorCents(700000, null) === null);
}

console.log('\nThe check');
{
  const base = { mode: 'cash', preTaxCents: 1000000, costCents: 750000, costKnown: true, settings: NBD };
  const under = F.check(base);
  ok('a cash job under the floor: under, with the price that reaches it and the gap', under.state === 'under' && under.applies === true && under.marginPct === 25 && under.neededPreTaxCents === F.priceForFloorCents(750000, 30) && under.shortCents === under.neededPreTaxCents - 1000000, under);
  ok('exactly on the floor is ok', F.check(Object.assign({}, base, { costCents: 700000 })).state === 'ok');
  ok('one cent of cost over the floor is under', F.check(Object.assign({}, base, { costCents: 700001 })).state === 'under');
  ok('an insurance job is exempt whatever its margin', F.check(Object.assign({}, base, { mode: 'insurance' })).state === 'exempt' && F.check(Object.assign({}, base, { mode: 'insurance' })).applies === false);
  ok('a job with an uncosted line is unknown and does not warn', F.check(Object.assign({}, base, { costKnown: false })).state === 'unknown' && F.check(Object.assign({}, base, { costKnown: false })).applies === false);
  ok('a company with no floor set is off, whatever the margin', F.check(Object.assign({}, base, { settings: F.sanitizeSettings(null) })).state === 'off' && F.check(Object.assign({}, base, { settings: undefined })).state === 'off');
  ok('a mode that is not insurance is treated as cash', F.check(Object.assign({}, base, { mode: undefined })).state === 'under' && F.check(Object.assign({}, base, { mode: 'retail' })).state === 'under');
  ok('a one-decimal floor is compared exactly', F.check(Object.assign({}, base, { costCents: 675000, settings: F.sanitizeSettings({ floorPct: 32.5 }) })).state === 'ok'
    && F.check(Object.assign({}, base, { costCents: 675001, settings: F.sanitizeSettings({ floorPct: 32.5 }) })).state === 'under');
}

console.log('\nBands');
{
  ok('at or above the target', F.band(35, NBD) === 'target' && F.band(60, NBD) === 'target');
  ok('from the floor up to the target', F.band(30, NBD) === 'between' && F.band(34.9, NBD) === 'between');
  ok('under the floor', F.band(29.9, NBD) === 'under' && F.band(-10, NBD) === 'under');
  ok('no margin is unknown; no floor set is plain', F.band(null, NBD) === 'unknown' && F.band(40, F.sanitizeSettings(null)) === 'plain' && F.band(5, undefined) === 'plain');
  ok('each band has words for the screen and none names a number of its own', ['target', 'between', 'under', 'unknown', 'plain'].every((b) => typeof F.BAND_TEXT[b] === 'string') && !/\d/.test(Object.values(F.BAND_TEXT).join('')));
}

console.log('\nWho may go under, and the note');
{
  ok('the owner, a company admin and the platform admin may finalize under the floor', ['owner', 'company_admin', 'admin'].every((r) => F.canFinalizeUnder(r) === true));
  ok('a manager, a rep, a member, a viewer and no role may not', ['manager', 'sales_rep', 'member', 'viewer', '', null, undefined].every((r) => F.canFinalizeUnder(r) === false));
  const note = F.confirmNote({ uid: 'u1', role: 'owner', marginPct: 27.4567, floorPct: 30, atMs: 1700000000000 });
  ok('the note keeps who, when, the margin to one decimal and the floor', note.by === 'u1' && note.role === 'owner' && note.marginPct === 27.5 && note.floorPct === 30 && note.atMs === 1700000000000 && Object.keys(note).length === 5, note);
  ok('a note with no person is refused', F.confirmNote({ role: 'owner', marginPct: 27, floorPct: 30, atMs: 1 }) === null);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
