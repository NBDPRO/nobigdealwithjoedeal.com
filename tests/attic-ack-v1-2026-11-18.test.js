/**
 * attic-ack-v1-2026-11-18.test.js - phase 3 of the template/liability overhaul: the Attic, Ventilation & Moisture
 * Acknowledgment, behind the per-user flag docAtticAckV1 (default OFF). See documentation/projects/ATTIC-ACK-V1-2026-11-18.md.
 *
 *   A. scope (Q22)            B. photo minimums (Q69)      C. wording is the packet's    D. recommendations (Q28)
 *   E. tick controls          F. the gate (Q2, Q18)        G. warranty and free check    (later sections are added with each step)
 *
 * Run: node tests/attic-ack-v1-2026-11-18.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const AA = require('../functions/attic-ack.js');
const TXT = require('../functions/attic-ack-text.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }

// ═══════════════════════════════════════════════════════
section('0. the two copies, the flag');
ok('attic-ack.js: server copy is the browser copy, byte for byte', read('docs/pro/js/attic-ack.js') === read('functions/attic-ack.js'));
ok('attic-ack-text.js: server copy is the browser copy, byte for byte', read('docs/pro/js/attic-ack-text.js') === read('functions/attic-ack-text.js'));
{
  const R = require('../functions/flags-registry.js');
  const row = R.FIRESTORE_FLAGS.find((f) => f.name === 'docAtticAckV1');
  ok('docAtticAckV1 is a registered Firestore flag, default OFF, ships dark', !!row && row.default === false && row.dark === true);
  ok('the module names the same flag', AA.FLAG === 'docAtticAckV1' && AA.VERSION === 'ATTIC_ACK_V1' && TXT.VERSION === 'ATTIC_ACK_V1');
}

// ═══════════════════════════════════════════════════════
section('A. scope (Q22): defaulted from tear-off lines, the rep\'s choice wins');
{
  const tear = { rows: [{ code: 'RFG 240-GAF-HDZ' }, { code: 'LAB TO1' }] };
  ok('an estimate with a tear-off line defaults to reroof', AA.scopeFromEstimate(tear) === 'reroof');
  ok('tear-off found in lineItems too', AA.scopeFromEstimate({ lineItems: [{ code: 'LAB TO-MT' }] }) === 'reroof');
  ok('a repair estimate with no tear-off defaults to repair', AA.scopeFromEstimate({ workKind: 'repair', rows: [{ code: 'LAB RPR' }] }) === 'repair');
  ok('no tear-off and no repair kind defaults to other', AA.scopeFromEstimate({ rows: [{ code: 'GTR 5K' }] }) === 'other');
  ok('no estimate at all is other, never reroof', AA.scopeFromEstimate(null) === 'other' && AA.scopeFromEstimate({}) === 'other');
  ok('the lead\'s explicit scope wins over the estimate', AA.effectiveScope({ scope: 'repair' }, tear) === 'repair');
  ok('an unknown stored scope falls back to the estimate', AA.effectiveScope({ scope: 'bogus' }, tear) === 'reroof' && AA.effectiveScope({}, tear) === 'reroof');
  ok('the five scopes', AA.SCOPES.join() === 'reroof,repair,siding,gutters,other');
  ok('only reroof needs the form', AA.needsForm('reroof') && !AA.needsForm('repair') && !AA.needsForm('siding') && !AA.needsForm('gutters') && !AA.needsForm('other'));
}

// ═══════════════════════════════════════════════════════
section('B. the attic record: Q69 photo minimums');
{
  const ph = (kind, n) => Array.from({ length: n || 1 }, (_, i) => ({ id: kind + i, kind }));
  const insp = (extra) => Object.assign({ status: 'inspected', inspectedOn: '2026-11-18', accessPoint: 'hatch', conditions: { none: true }, photos: ph('overview') }, extra);
  const codes = (r) => AA.validate(r).map((g) => g.code);
  ok('inspected, no visible concerns, one overview photo: valid', codes(insp()).length === 0);
  ok('inspected with no overview photo: refused', codes(insp({ photos: [] })).indexOf('photo_overview') !== -1);
  ok('a ticked condition needs its own photo', codes(insp({ conditions: { mold: true } })).indexOf('photo_mold') !== -1);
  ok('...and is valid with one', codes(insp({ conditions: { mold: true }, photos: ph('overview').concat(ph('cond:mold')) })).length === 0);
  ok('one photo per ticked condition, each', codes(insp({ conditions: { mold: true, frost: true }, photos: ph('overview').concat(ph('cond:mold')) })).join() === 'photo_frost');
  ok('"No visible concerns" needs no condition photo', codes(insp({ conditions: { none: true } })).length === 0);
  ok('nothing ticked is refused', codes(insp({ conditions: {} })).indexOf('conditions') !== -1);
  ok('no date and no access point are refused', codes(insp({ inspectedOn: '', accessPoint: '' })).join() === 'inspectedOn,accessPoint');
  ok('"Other" needs a description', codes(insp({ conditions: { other: true }, photos: ph('overview').concat(ph('cond:other')) })).join() === 'conditionOther');
  ok('a photo with no id does not count', codes(insp({ photos: [{ kind: 'overview' }] })).indexOf('photo_overview') !== -1);
  const ni = (reason, extra) => Object.assign({ status: 'not_inspected', reason }, extra);
  ok('not inspected, declined: a reason is enough, no photo', codes(ni('declined')).length === 0);
  ok('not inspected, either scheduling reason: a reason is enough', codes(ni('scheduling_homeowner')).length === 0 && codes(ni('scheduling_nbd')).length === 0);
  ok('no attic space: a reason is enough', codes(ni('no_attic')).length === 0);
  ok('no access needs one photo', codes(ni('no_access')).join() === 'photo_access' && codes(ni('no_access', { photos: ph('access') })).length === 0);
  ok('unsafe needs one photo', codes(ni('unsafe')).join() === 'photo_access' && codes(ni('unsafe', { photos: ph('access') })).length === 0);
  ok('not inspected with no reason, or an unknown one, is refused', codes({ status: 'not_inspected' }).join() === 'reason' && codes(ni('bogus')).join() === 'reason');
  ok('"other" needs text', codes(ni('other')).join() === 'reasonText' && codes(ni('other', { reasonText: 'locked' })).length === 0);
  ok('no status is refused', codes({}).join() === 'status' && codes(null).join() === 'status');
  ok('who could not: a missed NBD visit is never the homeowner\'s choice',
    AA.REASON_WHO.scheduling_nbd === 'nbd' && AA.REASON_WHO.scheduling_homeowner === 'homeowner' && AA.REASON_WHO.declined === 'homeowner' && AA.REASON_WHO.no_access === 'conditions');
  ok('the seven reasons', AA.REASONS.join() === 'declined,scheduling_homeowner,scheduling_nbd,no_access,unsafe,no_attic,other');
}

// ═══════════════════════════════════════════════════════
section('C. the wording is the attorney packet\'s, verbatim');
{
  const packet = read('tests/fixtures/attorney-packet-2026-11-18.md');
  const flat = packet.replace(/\n> ?/g, ' ').replace(/\s+/g, ' ');
  const inPacket = (s) => flat.indexOf(String(s).replace(/\s+/g, ' ')) !== -1;
  const all = [].concat(TXT.WHY, TXT.INSPECTED, TXT.NOT_INSPECTED, TXT.SAW_INTRO, TXT.CONDITIONS, TXT.ACKS, TXT.SAVINGS, TXT.REASONS, TXT.STATEMENTS, TXT.RECS_THIRD_PARTY, TXT.RECS_INTRO, TXT.WARRANTY_LINE);
  all.forEach((s, i) => ok('packet text #' + i + ' is in the packet: ' + String(s).slice(0, 40), inPacket(s)));
  ok('13 conditions, 6 acknowledgments, 6 reason lines, 4 statements', TXT.CONDITIONS.length === 13 && TXT.ACKS.length === 6 && TXT.REASONS.length === 6 && TXT.STATEMENTS.length === 4);
  ok('the savings sentence is the packet\'s', /Nothing in this form limits NBD's responsibility for the work NBD does/.test(TXT.SAVINGS) && /NBD remains responsible under my contract and warranty/.test(TXT.SAVINGS));
  ok('the form is never called a waiver', !/waiver/i.test(JSON.stringify(TXT)));
  ok('NBD never offers to test or remove mold: the text says it does not', /NBD does not test for, identify, or remove mold/.test(TXT.ACKS[3]));
  ok('the "3 days" number comes from config; the default prints the packet\'s own words',
    AA.words(TXT.STATEMENTS[1], { atticFreeCheckDays: 3 }, true) === TXT.STATEMENTS[1]
    && /at least 5 days before the start date/.test(AA.words(TXT.STATEMENTS[1], { atticFreeCheckDays: 5 }, true))
    && /\{\{atticFreeCheckDays\}\}/.test(AA.words(TXT.STATEMENTS[1], { atticFreeCheckDays: null }, true)));
  ok('an unset number is named for the send gate', AA.missingTerms({ atticFreeCheckDays: null }).join() === 'atticFreeCheckDays' && AA.missingTerms({ atticFreeCheckDays: 3 }).length === 0);
  ok('another tenant\'s paper says Contractor, never NBD', !/\bNBD\b/.test(AA.words(TXT.ACKS[0] + TXT.SAVINGS, { atticFreeCheckDays: 3 }, false)) && /Contractor/.test(AA.words(TXT.SAVINGS, {}, false)));
  const scan = (() => { try { return require('./helpers/banned-phrases'); } catch (_) { return null; } })();
  const bad = /\b(licensed|in-house)\b/i;
  ok('no banned phrase in the wording', !bad.test(JSON.stringify(TXT)));
  void scan;
}

// ═══════════════════════════════════════════════════════
section('D. recommendations (Q28): a line with no price is hidden, prices are never typed');
{
  const terms = { deckingPerSheetCents: 10000 };
  const rec = { recs: [{ id: 'ridge_vent', qty: 40 }, { id: 'soffit_intake' }, { id: 'box_vents' }, { id: 'bath_fan_duct' }, { id: 'decking', qty: 3 }] };
  let lines = AA.recommendationLines(rec, terms, {});
  const mine = (l) => l.filter((x) => !x.thirdParty);
  ok('with no catalog prices only the decking line (priced from paymentTerms) shows', mine(lines).length === 1 && mine(lines)[0].id === 'decking');
  ok('decking = per-sheet cents x sheets, in cents', mine(lines)[0].priceCents === 30000 && mine(lines)[0].qty === 3 && /3 sheets/.test(mine(lines)[0].label));
  lines = AA.recommendationLines(rec, { deckingPerSheetCents: null }, {});
  ok('decking price unset (the default): no priced line at all', mine(lines).length === 0);
  lines = AA.recommendationLines(rec, terms, { ridge_vent: 450, soffit_intake: 8000 });
  ok('a priced ridge vent shows: per-foot cents x feet', mine(lines).some((l) => l.id === 'ridge_vent' && l.priceCents === 18000 && /40 ft/.test(l.label)));
  ok('a priced flat line shows once', mine(lines).filter((l) => l.id === 'soffit_intake').length === 1 && mine(lines).find((l) => l.id === 'soffit_intake').priceCents === 8000);
  ok('lines that stay unpriced stay hidden', !mine(lines).some((l) => l.id === 'box_vents' || l.id === 'bath_fan_duct'));
  ok('the default price table has no price anywhere (Jo prices them)', AA.REC_DEFS.every((d) => d.cents === null));
  ok('a line the rep did not recommend never shows', AA.recommendationLines({ recs: [] }, terms, { ridge_vent: 450 }).filter((x) => !x.thirdParty).length === 0);
  ok('the two "you arrange and pay them" lines always print, with no price', lines.filter((l) => l.thirdParty).length === 2 && lines.filter((l) => l.thirdParty).every((l) => l.priceCents === null));
  ok('a bad quantity hides the line', AA.recommendationLines({ recs: [{ id: 'ridge_vent', qty: 0 }] }, terms, { ridge_vent: 450 }).filter((x) => !x.thirdParty).length === 0);
  ok('prices are whole cents', mine(lines).every((l) => Number.isInteger(l.priceCents)));
}

// ═══════════════════════════════════════════════════════
section('E. the tick controls and reading a signed copy back');
{
  const form = '<input type="checkbox" data-nbd-ack="ack:saw" data-nbd-required="1">'
    + '<input type="checkbox" data-nbd-ack="ack:declined" data-nbd-required="1">'
    + '<input type="radio" name="g1" data-nbd-ack="rec:decking:yes"><input type="radio" name="g1" data-nbd-ack="rec:decking:no">';
  const done = form.replace(/data-nbd-ack="(ack:[a-z]+|rec:decking:no)"/g, 'data-nbd-ack="$1" checked=""');
  const a0 = AA.parseAcks(form), a1 = AA.parseAcks(done);
  ok('parseAcks reads every control, ticked or not', a0.length === 4 && a0.every((x) => x.checked === false) && a1.filter((x) => x.checked).length === 3);
  ok('required and radio are read', a0[0].required && a0[0].type === 'checkbox' && a0[2].type === 'radio' && !a0[2].required);
  ok('an unticked form is not complete: names the missing ones', !AA.acksComplete(a0).ok && AA.acksComplete(a0).missing.join() === 'ack:saw,ack:declined,rec:decking');
  ok('every required tick and one answer per line is complete', AA.acksComplete(a1).ok);
  ok('two answers on one line (yes and no) is not complete', !AA.acksComplete(AA.parseAcks(done.replace('data-nbd-ack="rec:decking:yes"', 'data-nbd-ack="rec:decking:yes" checked=""'))).ok);
  ok('a form with no controls is never complete', !AA.acksComplete([]).ok);
  ok('a "No" on a ventilation line is a decline', AA.declinedAny(a1) && !AA.declinedAny(a0));
  ok('"checked" in another attribute value does not count', AA.parseAcks('<input type="checkbox" data-nbd-ack="ack:x" title="checked box">')[0].checked === false);
  ok('a "No" on a third-party line (a mold or HVAC professional) is not a ventilation decline', !AA.declinedAny([{ id: 'rec:third_party_1:no', checked: true }]));
  ok('evidence is [{id, checked}]', JSON.stringify(AA.evidenceAcks(a1)[0]) === '{"id":"ack:saw","checked":true}');
}

// ═══════════════════════════════════════════════════════
section('F. the gate (Q2, Q18): a reroof needs the form, the not-inspected page or a recorded override');
{
  const g = (o) => AA.gate(o);
  ok('reroof, nothing signed: refused with a plain message', !g({ scope: 'reroof' }).satisfied && /cannot be sent or signed/.test(g({ scope: 'reroof' }).message));
  ok('reroof with the signed form: clear', g({ scope: 'reroof', signedForm: true }).satisfied && g({ scope: 'reroof', signedForm: true }).how === 'form');
  ok('reroof with an override: clear, and says how', g({ scope: 'reroof', override: true }).how === 'override');
  ok('repair: warn only, never blocked', g({ scope: 'repair' }).satisfied && g({ scope: 'repair' }).warn === true);
  ok('siding, gutters, other: no form, no warning', ['siding', 'gutters', 'other'].every((s) => g({ scope: s }).satisfied && !g({ scope: s }).required && !g({ scope: s }).warn));
  const row = { type: 'attic_acknowledgment', status: 'signed', signedAt: { seconds: 1 } };
  ok('a signed form row counts, either document', AA.isSignedForm(row) && AA.isSignedForm(Object.assign({}, row, { type: 'attic_not_inspected' })));
  ok('a draft, a sent or an unstamped row does not count', !AA.isSignedForm(Object.assign({}, row, { status: 'sent' })) && !AA.isSignedForm(Object.assign({}, row, { signedAt: null })) && !AA.isSignedForm({ type: 'contract', status: 'signed', signedAt: 1 }));
}

// ═══════════════════════════════════════════════════════
section('G. the warranty line and the free later check (Q17, Q20, Q71)');
{
  ok('the exclusion prints for a decline or a not-inspected attic, not otherwise', AA.needsWarrantyExclusion({ declined: true }) && AA.needsWarrantyExclusion({ notInspected: true }) && !AA.needsWarrantyExclusion({}) && !AA.needsWarrantyExclusion(null));
  const line = AA.warrantyLine('November 18, 2026');
  ok('the warranty line is the packet\'s WAR-2 added line with the form date', /that the homeowner chose on November 18, 2026 not to correct/.test(line) && !/\{\{/.test(line));
  ok('a free check is offered on declined and both scheduling reasons only', AA.wantsFreeCheck({ status: 'not_inspected', reason: 'declined' }) && AA.wantsFreeCheck({ status: 'not_inspected', reason: 'scheduling_nbd' })
    && AA.wantsFreeCheck({ status: 'not_inspected', reason: 'scheduling_homeowner' }) && !AA.wantsFreeCheck({ status: 'not_inspected', reason: 'no_access' }) && !AA.wantsFreeCheck({ status: 'inspected' }));
  const D = 86400000, start = Date.UTC(2026, 11, 10), contract = Date.UTC(2026, 10, 18);
  ok('due = start date minus atticFreeCheckDays', AA.freeCheckDue({ startMs: start, contractMs: contract, days: 3 }) === start - 3 * D);
  ok('no start date: contract date + 7 days', AA.freeCheckDue({ contractMs: contract, days: 3 }) === contract + 7 * D);
  ok('nothing to compute from: null', AA.freeCheckDue({}) === null);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
