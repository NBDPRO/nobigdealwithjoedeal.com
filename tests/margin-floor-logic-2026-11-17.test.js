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

console.log('\nAn estimate, as a builder hands it over');
{
  // Line-item / template shape: total includes tax; the engine's own marginPct counted tax as margin.
  const li = { mode: 'cash', total: 10780, tax: 780, subtotal: 10000, materialCost: 4000, laborCost: 3000, hardCost: 7000, internal: { hardCost: 7000, margin: 3780, marginPct: 35.06 }, costUnsetCount: 0 };
  const j = F.jobFromEstimate(li);
  ok('the price is total minus tax, the cost is the hard cost', j.preTaxCents === 1000000 && j.costCents === 700000 && j.costKnown === true && j.mode === 'cash', j);
  const v = F.view(li, NBD);
  ok('the margin shown leaves sales tax out', v.known === true && v.marginPct === 30 && v.marginCents === 300000 && v.state === 'ok' && v.band === 'between' && v.cls === 'is-warn', v);
  ok('a minimum charge or a discount already inside the total is what is measured', F.view({ mode: 'cash', total: 2500, tax: 0, subtotal: 600, hardCost: 400 }, NBD).marginPct === 84 && F.view({ mode: 'cash', total: 9702, tax: 702, subtotal: 9000, hardCost: 7000 }, NBD).state === 'under');
  ok('an uncosted line makes the margin unknown, with no warning', F.view(Object.assign({}, li, { costUnsetCount: 2 }), NBD).state === 'unknown' && F.view(Object.assign({}, li, { costUnsetCount: 2 }), NBD).band === 'unknown' && F.view(Object.assign({}, li, { costUnsetCount: 2 }), NBD).marginPct === null);
  ok('a builder that says it has no cost basis (marginPct null) is unknown, not a perfect margin', F.view({ mode: 'cash', total: 10000, tax: 0, internal: { hardCost: 0, margin: null, marginPct: null } }, NBD).state === 'unknown'
    && F.view({ mode: 'cash', total: 10000, tax: 0, hardCost: 0 }, NBD).state === 'unknown');
  ok('saved shape: grandTotal, taxAmount, materialCost + laborCost', F.jobFromEstimate({ mode: 'cash', grandTotal: 10780, taxAmount: 780, materialCost: 4000, laborCost: 3000 }).preTaxCents === 1000000 && F.jobFromEstimate({ grandTotal: 10780, taxAmount: 780, materialCost: 4000, laborCost: 3000 }).costCents === 700000);
  ok('classic shape: one cost basis', F.view({ mode: 'cash', grandTotal: 10000, taxAmount: 0, costBasis: 6000 }, NBD).marginPct === 40 && F.view({ mode: 'cash', grandTotal: 10000, taxAmount: 0, costBasis: 6000 }, NBD).band === 'target');
  const ins = F.view(Object.assign({}, li, { mode: 'insurance', total: 10000, tax: 0, hardCost: 9000 }), NBD);
  ok('an insurance job shows its margin with no band and no warning', ins.state === 'exempt' && ins.band === 'plain' && ins.marginPct === 10 && F.badgeHtml(ins) === '', ins);
  const off = F.view(li, null);
  ok('with no floor set the margin still shows, tax-free, with no band', off.state === 'off' && off.band === 'plain' && off.marginPct === 30 && F.badgeHtml(off) === '', off);
  ok('nothing usable gives unknown, never a throw', F.view(null, NBD).known === false && F.view({}, NBD).state === 'unknown' && F.view({ total: 'abc' }, NBD).known === false);
  ok('the badge is a shared ui-badge with fixed words', F.badgeHtml(F.view(Object.assign({}, li, { hardCost: 8000 }), NBD)) === '<span class="ui-badge is-danger">Under your floor</span>' && F.badgeHtml(null) === '');
}

console.log('\nThe company setting and the signed-in person');
{
  ok('no company profile is off', F.settingsNow().on === false);
  win._companyProfile = { pricing: { marginFloor: { floorPct: 30, targetPct: 35 } } };
  ok('the floor is read from the company profile at call time', F.settingsNow().on === true && F.settingsNow().floorPct === 30 && F.view({ mode: 'cash', total: 10000, tax: 0, hardCost: 8000 }).state === 'under');
  win._companyProfile = { pricing: {}, budgetDefaults: { marginFloorPct: 30 } };
  ok('the expense budget\'s own floor is a different setting and does not switch this on', F.settingsNow().on === false);
  const as = (claims, uid) => { win._userClaims = claims; win._user = uid ? { uid } : null; return F.callerRole(); };
  ok('a solo owner has no role claim and is the owner', as({}, 'u1') === 'owner' && as({ companyId: 'u1' }, 'u1') === 'owner' && F.canFinalizeUnder(as({}, 'u1')) === true);
  ok('a company admin, a platform admin and an owner claim are read', as({ companyId: 'co', role: 'company_admin' }, 'u2') === 'company_admin' && as({ admin: true }, 'u3') === 'admin' && as({ role: 'admin' }, 'u3') === 'admin' && as({ companyId: 'co', owner: true }, 'u4') === 'owner');
  ok('a manager, a rep and a company member with no role may not go under', ['manager', 'sales_rep'].every((r) => F.canFinalizeUnder(as({ companyId: 'co', role: r }, 'u5')) === false) && as({ companyId: 'co' }, 'u6') === '' && F.canFinalizeUnder(as({ companyId: 'co' }, 'u6')) === false);
  delete win._companyProfile; delete win._userClaims; delete win._user;
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
