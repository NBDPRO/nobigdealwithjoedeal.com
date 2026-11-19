/**
 * phase5-templates-2026-11-19.test.js - phase 5 templates (flag docClauseSetV1, default OFF), through the REAL generator:
 *   property_condition, decking_authorization, emergency_services_request, final_walkthrough, ohio_insurance_ack.
 * Each template: registers only with the flag on, prints the registry wording verbatim, the party block and signature
 * caption, required ticks / signers, fails closed on a hole, carries no placeholder on a good copy.
 * Run: node tests/phase5-templates-2026-11-19.test.js   (needs functions/node_modules)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
module.paths.unshift(path.join(ROOT, 'functions', 'node_modules'));
const H = require('./helpers/clause-v1-harness');
const { scanSource } = require('./lib/outbound-template-scan');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; if (process.env.V1_VERBOSE) console.log('  ok ' + name); }
  else { failed++; fails.push(name); console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + detail : '')); }
}
function section(name) { console.log('\n' + name); }
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const NBD_PARTY = 'No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions';
const OAKS = { legalName: 'Oaks Roofing & Construction', entityName: 'Oaks Roofing LLC', displayName: 'Oaks Roofing & Construction', seal: 'ORC', docPrefix: 'OAK', colors: {}, contact: { email: 'o@oaks.test', phone: '(513) 555-0100' } };
const ALL = ['property_condition', 'decking_authorization', 'emergency_services_request', 'final_walkthrough', 'ohio_insurance_ack'];
const decode = (h) => String(h).replace(/&#0*39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const textOf = (h) => decode(String(h).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\*\*/g, '').replace(/\s+/g, ' ');

// The docgen stack as the browser loads it, with the phase 2/3/5 modules and the library.
function stack(o) {
  const opts = o || {};
  const env = H.docs({ flags: opts.flags || {}, brand: opts.brand });
  ['docs/pro/js/attic-ack-text.js', 'docs/pro/js/attic-ack.js', 'docs/pro/js/p5-forms.js', 'docs/pro/js/document-generator-library.js'].forEach((f) => {
    if (fs.existsSync(path.join(ROOT, f))) H.load(env, f);
  });
  return env;
}
const SIGNERS = [{ role: 'homeowner', label: 'Homeowner', required: true }, { role: 'rep', label: 'Authorized NBD Representative', required: true }];
const TERMS = { deckingPerSheetCents: 10000, deckingSheetsBeforeChangeOrder: 10, finalPaymentDays: 7, punchListDays: 3 };

// generate() the way the app does: the viewer receives the page. Returns { html, toasts }.
async function gen(env, type, data, o) {
  const opts = o || {};
  const W = env.win;
  let cap = null;
  W.NBDDocViewer = { open: (x) => { cap = x; return {}; } };
  const cp = Object.assign({}, H.profileFor(W, H.BIZ_ADDR), { paymentTerms: opts.terms === undefined ? TERMS : opts.terms });
  W._legal = () => cp;   // generate() reads the tenant's terms from window._legal()
  W._leadDoc = { id: 'L1', address: (data && data.address) || H.OH_ADDR, jobType: 'cash' };
  const before = env.toasts.length;
  await W.NBDDocGen.generate(type, Object.assign({ homeownerName: 'Jane Smith', address: H.OH_ADDR, contractDate: '2026-11-18', companyProfile: cp,
    signers: opts.noSigners ? undefined : SIGNERS }, data || {}));
  return { html: cap && cap.html, toasts: env.toasts.slice(before).map((t) => t.m) };
}
const syncOn = (env) => { const DG = env.win.NBDDocGen; if (typeof DG.syncPhase5Types === 'function') DG.syncPhase5Types(); return DG; };
const reqIds = (html) => [...html.matchAll(/<input\b[^>]*data-nbd-ack="([^"]+)"[^>]*data-nbd-required="1"[^>]*>/g)].map((m) => m[1]);
const ackIds = (html) => [...html.matchAll(/<input\b[^>]*data-nbd-ack="([^"]+)"/g)].map((m) => m[1]);

(async () => {
  // ═══════════════════════════════════════════════════════════════
  section('0. the flag: registered only with docClauseSetV1 on; flag off leaves the registries as they were');
  {
    const off = stack({ flags: {} });
    const DGoff = syncOn(off);
    const base = Object.keys(DGoff.DOCUMENT_TYPES);
    ok('flag off: none of the five types is in DOCUMENT_TYPES', ALL.every((t) => !DGoff.DOCUMENT_TYPES[t]));
    ok('flag off: none in the pre-flight schemas', ALL.every((t) => !(off.win.DocPreflight && off.win.DocPreflight.DOC_SCHEMAS && off.win.DocPreflight.DOC_SCHEMAS[t])));
    const on = stack({ flags: { docClauseSetV1: true } });
    const DGon = syncOn(on);
    const added = Object.keys(DGon.DOCUMENT_TYPES).filter((k) => base.indexOf(k) === -1).sort();
    ok('flag on: exactly the registered phase 5 types are added (and nothing else changes)', added.every((t) => ALL.indexOf(t) !== -1) && base.every((k) => !!DGon.DOCUMENT_TYPES[k]), added.join(','));
    // a flag turned off again removes them (a person whose flag flips back sees the old picker)
    on.win.NBDFlags.enabled = () => false; DGon.syncPhase5Types();
    ok('flag turned off again: the types are gone', ALL.every((t) => !DGon.DOCUMENT_TYPES[t]));
    const ui = read('docs/pro/js/customer-tasks-ui.js');
    ok('the picker catalog entries carry the flag, so the flag-off picker lists the same cards', ALL.every((t) => !new RegExp("type:'" + t + "'").test(ui) || new RegExp("type:'" + t + "'[^\\n]*flag:'docClauseSetV1'").test(ui)));
  }

  // ═══════════════════════════════════════════════════════════════
  section('1. Property Condition & Access Acknowledgment');
  {
    const T = 'property_condition';
    const env = stack({ flags: { docClauseSetV1: true } });
    const DG = syncOn(env);
    const CS = env.win.NBDClauseSet;
    ok('registered with homeowner + contractor required signers', !!DG.DOCUMENT_TYPES[T] && DG.DOCUMENT_TYPES[T].defaultSigners.map((s) => s.role + ':' + s.required).join() === 'homeowner:true,rep:true');
    ok('pre-flight schema registered under the flag', !!(env.win.DocPreflight && env.win.DocPreflight.DOC_SCHEMAS[T]));
    const data = { propertyCondition: { walkedOn: '2026-11-17', notes: { driveway: 'Hairline crack near the garage', pets: 'One dog, kept inside' }, photos: [{ id: 'ph1', item: 'driveway' }, { id: 'ph2', item: 'skylights' }] }, propertyPhotoUrls: { ph1: 'https://firebasestorage.example/o/ph1.jpg' } };
    const r = await gen(env, T, data);
    const h = r.html || '';
    const tx = textOf(h);
    ok('generate() produced the form', h.length > 4000, r.toasts.join('|'));
    const terms = CS.paymentTermsFor(TERMS, true);
    const party = CS.partyFor(env.win._brand(), true);
    const sch2 = CS.textV1('SCH-2', { terms, party })[0];
    const disp6 = CS.textV1('DISP-6', { terms, party })[0];
    ok('SCH-2 prints verbatim from the registry', sch2 && sch2.length > 80 && tx.indexOf(sch2.replace(/\*\*/g, '')) !== -1);
    ok('DISP-6 (specific limits) prints verbatim from the registry', disp6 && tx.indexOf(disp6.replace(/\*\*/g, '')) !== -1);
    ok('party block names the legal party', tx.indexOf(NBD_PARTY) !== -1);
    ok('signature caption: By: Joe Deal, Manager (NBD only)', h.indexOf('By: Joe Deal, Manager') !== -1);
    const req = reqIds(h);
    const items = ['driveway', 'landscaping', 'gutters', 'satellite_dish', 'solar', 'skylights', 'wall_items', 'attic_items', 'ceilings', 'pets', 'utilities', 'parking'];
    ok('a required recorded tick for each of the twelve checklist items plus the notice', items.every((k) => req.indexOf('ack:pc_' + k) !== -1) && req.indexOf('ack:pc_notice') !== -1 && req.length === 13, req.join());
    ok('only checkboxes, no initials fields', !/initial/i.test(h) && ackIds(h).length === 13);
    ok('the rep notes and the photo refs appear', tx.indexOf('Hairline crack near the garage') !== -1 && h.indexOf('ph1.jpg') !== -1 && tx.indexOf('ph2') !== -1);
    ok('two signature blocks (homeowner, contractor)', (h.match(/data-nbd-sig="/g) || []).length === 2);
    ok('no placeholder token on the good copy', !/\{\{|\[Homeowner Name\]|\[Property Address\]/.test(h));
    ok('never "licensed", never a claim promise', !/licensed|we handle|handle your claim|guarantee/i.test(tx));
    ok('a nbd:p5 marker names the type, version and clause refs', /<!-- nbd:p5 P5_FORMS_V1 property_condition base SCH-2_V1,DISP-6_V1,MEDIA-1_V1 -->/.test(h));
    // fail closed
    const noAddr = await gen(env, T, { address: '' });
    ok('a blank address refuses the send (no document)', !noAddr.html && noAddr.toasts.some((m) => /address/i.test(m)), noAddr.toasts.join('|'));
    const noName = await gen(env, T, { homeownerName: '' });
    ok('a blank homeowner name refuses the send', !noName.html && noName.toasts.some((m) => /name/i.test(m)), noName.toasts.join('|'));
    // tenant
    const oaks = stack({ flags: { docClauseSetV1: true }, brand: OAKS });
    syncOn(oaks);
    const ro = await gen(oaks, T, data);
    const to = textOf(ro.html || '');
    ok('tenant: its own entity name, no NBD names, no Joe Deal', to.indexOf('Oaks Roofing LLC') !== -1 && !/No Big Deal|Joe Deal|\bNBD\b/.test(to) && (ro.html || '').indexOf('By: ______________') !== -1, ro.toasts.join('|'));
    // preview copy keeps placeholders (the send check, not the render, refuses)
    const prev = await gen(env, T, { _isBlankPreview: true, homeownerName: undefined, address: undefined });
    ok('flag on, blank preview still renders', !!prev.html);
  }

  // ═══════════════════════════════════════════════════════════════
  section('2. Hidden Conditions / Decking Authorization');
  {
    const T = 'decking_authorization';
    const env = stack({ flags: { docClauseSetV1: true } });
    const DG = syncOn(env);
    const CS = env.win.NBDClauseSet;
    ok('registered with homeowner + contractor required signers', !!DG.DOCUMENT_TYPES[T] && DG.DOCUMENT_TYPES[T].defaultSigners.map((s) => s.role + ':' + s.required).join() === 'homeowner:true,rep:true');
    ok('pre-flight schema registered under the flag', !!(env.win.DocPreflight && env.win.DocPreflight.DOC_SCHEMAS[T]));
    const data = { deckingSheets: 4, deckingFoundOn: '2026-11-19', deckingWhere: 'North slope near the chimney', deckingPhotos: ['dk1', 'dk2'], deckingPhotoUrls: { dk1: 'https://firebasestorage.example/o/dk1.jpg' } };
    const r = await gen(env, T, data);
    const h = r.html || '';
    const tx = textOf(h);
    ok('generate() produced the form', h.length > 4000, r.toasts.join('|'));
    const terms = CS.paymentTermsFor(TERMS, true);
    const party = CS.partyFor(env.win._brand(), true);
    const co2 = CS.textV1('CO-2', { terms, party })[0];
    ok('CO-2 prints verbatim from the registry, with the per-sheet price from payment terms', co2 && co2.indexOf('$100.00 per sheet') !== -1 && tx.indexOf(co2.replace(/\*\*/g, '')) !== -1);
    ok('sheets, price per sheet and the total (4 x $100.00 = $400.00) are shown', /Sheets to replace\s+4/.test(tx) && /Price per sheet\s+\$100\.00/.test(tx) && /Total for these sheets\s+\$400\.00/.test(tx), tx.slice(tx.indexOf('Sheets to replace') - 20, tx.indexOf('Sheets to replace') + 200));
    ok('photos are referenced by id (a thumbnail when a url is known)', h.indexOf('dk1.jpg') !== -1 && tx.indexOf('dk2') !== -1);
    ok('party block and signature caption', tx.indexOf(NBD_PARTY) !== -1 && h.indexOf('By: Joe Deal, Manager') !== -1);
    ok('approve / decline is a recorded Yes/No pair, plus one required tick', /data-nbd-ack="rec:decking:yes"/.test(h) && /data-nbd-ack="rec:decking:no"/.test(h) && reqIds(h).join() === 'ack:decking_read' && ackIds(h).length === 3, ackIds(h).join());
    ok('neither answer is pre-selected and no initials', !/checked/.test(h.replace(/<style[\s\S]*?<\/style>/g, '')) && !/initial/i.test(h));
    ok('no placeholder on the good copy; never "licensed" or a claim promise', !/\{\{|\[[A-Z][A-Za-z ]+\]/.test(textOf(h).replace(/\[ \]/g, '')) && !/licensed|we handle|guarantee/i.test(tx));
    ok('a marker names the type, version and CO-2', /<!-- nbd:p5 P5_FORMS_V1 decking_authorization base CO-2_V1 -->/.test(h));
    // fail closed
    const noPrice = await gen(env, T, data, { terms: {} });
    ok('no per-sheet price set: refused, naming deckingPerSheetCents', !noPrice.html && noPrice.toasts.some((m) => /deckingPerSheetCents/.test(m)), noPrice.toasts.join('|'));
    const zero = await gen(env, T, data, { terms: Object.assign({}, TERMS, { deckingPerSheetCents: 0 }) });
    ok('a $0 per-sheet price is refused', !zero.html, zero.toasts.join('|'));
    const noSheets = await gen(env, T, { deckingSheets: undefined });
    ok('no sheet count: refused', !noSheets.html && noSheets.toasts.some((m) => /placeholder/i.test(m)), noSheets.toasts.join('|'));
    const over = await gen(env, T, Object.assign({}, data, { deckingSheets: 11 }));
    ok('more sheets than the contract allows without a change order: refused, says so', !over.html && over.toasts.some((m) => /Change Order/i.test(m)), over.toasts.join('|'));
    const noAddr = await gen(env, T, Object.assign({}, data, { address: '' }));
    ok('a blank address is refused', !noAddr.html && noAddr.toasts.some((m) => /address/i.test(m)));
    // tenant: its own numbers only (a tenant with none set is refused, never given NBD's)
    const oaks = stack({ flags: { docClauseSetV1: true }, brand: OAKS });
    syncOn(oaks);
    const ro = await gen(oaks, T, data, { terms: { deckingPerSheetCents: 12500, deckingSheetsBeforeChangeOrder: 8 } });
    const to = textOf(ro.html || '');
    ok('tenant: its own entity and price ($125.00 x 4 = $500.00), no NBD names', to.indexOf('Oaks Roofing LLC') !== -1 && /Total for these sheets\s+\$500\.00/.test(to) && !/No Big Deal|Joe Deal|\bNBD\b/.test(to), ro.toasts.join('|'));
    const rn = await gen(oaks, T, data, { terms: {} });
    ok('tenant with no payment terms: refused (NBD defaults never leak)', !rn.html, rn.toasts.join('|'));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
