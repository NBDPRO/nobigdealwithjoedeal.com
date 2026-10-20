/**
 * tests/sub-paperwork-2026-10-19.test.js
 *
 * The Sub paperwork tracker (flag `subPaperwork`): docs/pro/js/sub-paperwork-logic.js,
 * sub-paperwork.js, functions/sub-paperwork-logic.js + sub-paperwork-watch.js, and
 * the static shape of the rules (the emulator suites are
 * firestore-rules.sub-paperwork.test.js and storage-rules.sub-papers.test.js).
 * Synthetic names and amounts only (public repo). Every check has a positive and a
 * negative control so it can fail.
 *
 * Run: node tests/sub-paperwork-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map((l) => l.replace(/\/\*.*?\*\//g, '').replace(/\s\/\/\s.*$/, ''))
  .join('\n');

const L = require(path.join(ROOT, 'docs/pro/js/sub-paperwork-logic.js'));
const FL = require(path.join(ROOT, 'functions/sub-paperwork-logic.js'));
const CD = require(path.join(ROOT, 'functions/company-doc-expiry-logic.js'));
const day = (y, m, d) => new Date(y, m - 1, d);
let seq = 0;
const pay = (o) => Object.assign({ id: 'p' + (++seq), category: 'subcontractor', costType: 'direct', source: 'cash_payout', supplier: 'CA Roofing', amountCents: 100000, taxCents: 0, paymentMethod: 'check', date: day(2026, 10, 3), userId: 'u1' }, o || {});
const TODAY = '2026-10-19';

console.log('\n— status bands (same as the company-document watcher) —');
{
  let same = true, n = 0;
  for (let d = -40; d <= 400; d++) {
    const t = new Date(Date.UTC(2026, 9, 19) + d * 86400000).toISOString().slice(0, 10);
    const a = L.statusOf(t, TODAY), b = CD.statusOf(t, TODAY);
    if (a.state !== b.state || a.days !== b.days) same = false;
    n++;
  }
  ok('browser and server bands agree on ' + n + ' dates', same);
  ok('bands: 31 days ok, 30 due30, 14 due14, 7 due7, 0 due7, -1 expired',
    L.statusOf('2026-11-19', TODAY).state === 'ok' && L.statusOf('2026-11-18', TODAY).state === 'due30' && L.statusOf('2026-11-02', TODAY).state === 'due14' &&
    L.statusOf('2026-10-26', TODAY).state === 'due7' && L.statusOf(TODAY, TODAY).state === 'due7' && L.statusOf('2026-10-18', TODAY).state === 'expired');
  ok('a bad or empty date has no status, no crash', L.statusOf('', TODAY).state === 'none' && L.statusOf('2026-02-30', TODAY).state === 'none' && L.statusOf(null, TODAY).state === 'none');
}

console.log('\n— chips —');
{
  const base = { name: 'CA Roofing' };
  const c0 = L.chipsFor(base, TODAY);
  ok('a bare sub: W-9, liability and workers comp all read Missing', c0.length === 3 && c0.every((c) => c.state === 'missing'));
  const good = Object.assign({}, base, { w9Status: 'on_file', w9ReceivedOn: '2026-10-01', glExpiry: '2027-06-01', wcExpiry: '2027-06-01' });
  ok('a complete sub: all ok, nothing needs attention', L.chipsFor(good, TODAY).every((c) => c.state === 'ok') && !L.needsAttention(good, TODAY));
  ok('W-9 asked for but not back reads soon (needs attention)', L.chipsFor(Object.assign({}, good, { w9Status: 'requested' }), TODAY)[0].state === 'soon' && L.needsAttention(Object.assign({}, good, { w9Status: 'requested' }), TODAY));
  ok('liability ending in 10 days reads soon; ended reads expired', L.chipsFor(Object.assign({}, good, { glExpiry: '2026-10-29' }), TODAY)[1].state === 'soon' && L.chipsFor(Object.assign({}, good, { glExpiry: '2026-10-01' }), TODAY)[1].state === 'expired');
  ok('the older insuranceExpiry field still counts as the liability date', L.chipsFor({ name: 'x', insuranceExpiry: '2027-06-01' }, TODAY)[1].state === 'ok' && L.glExpiryOf({ glExpiry: '2027-01-01', insuranceExpiry: '2026-01-01' }) === '2027-01-01');
  const ex = L.chipsFor(Object.assign({}, good, { wcExempt: true, wcExpiry: '' }), TODAY);
  ok('workers comp exempt reads ok with no date', ex[2].state === 'ok' && /Exempt/.test(ex[2].text));
  ok('no license chip unless the trade needs one', L.chipsFor(good, TODAY).length === 3 && L.chipsFor(Object.assign({}, good, { licenseRequired: true }), TODAY).length === 4 && L.chipsFor(Object.assign({}, good, { licenseRequired: true }), TODAY)[3].state === 'missing');
  ok('worst-first: an expired paper outranks a soon one', L.worstOf([{ rank: 3 }, { rank: 4 }]) === 4);
}

console.log('\n— the form (no tax ID, ever) —');
{
  const form = (o) => Object.assign({ legalName: 'CA Roofing LLC', entityType: 'LLC', w9Status: 'on_file', w9ReceivedOn: '2026-10-19', glExpiry: '2027-03-01', wcExpiry: '2027-03-01', paperworkNote: 'own helpers' }, o || {});
  const g = L.cleanPaperwork(form());
  ok('control: a good form is accepted', g.ok === true);
  ok('only the whitelisted keys leave the form', Object.keys(g.fields).every((k) => L.FIELDS.indexOf(k) !== -1) && Object.keys(g.fields).length === L.FIELDS.length);
  ok('no field is named like a tax id', !Object.keys(g.fields).some((k) => /^(ssn|ein|tin|tax)/i.test(k)));
  ok('an SSN in the note is refused', L.cleanPaperwork(form({ paperworkNote: 'ssn 123-45-6789' })).ok === false);
  ok('an EIN in the legal name is refused', L.cleanPaperwork(form({ legalName: 'CA Roofing 12-3456789' })).ok === false);
  ok('nine digits alone are refused', L.cleanPaperwork(form({ licenseNote: '123456789' })).ok === false);
  ok('digit groups split by spaces or dots are refused', L.cleanPaperwork(form({ paperworkNote: '123 45 6789' })).ok === false && L.cleanPaperwork(form({ paperworkNote: '123.45.6789' })).ok === false && L.cleanPaperwork(form({ paperworkNote: 'ein 12 3456789' })).ok === false);
  ok('a ZIP+4 and a dashed phone are not mistaken for one (negative control)', L.cleanPaperwork(form({ paperworkNote: '45202-1234 or 513-555-0100' })).ok === true);
  ok('a 10-digit phone number is NOT mistaken for a tax id (negative control)', L.cleanPaperwork(form({ paperworkNote: 'call 5135550100' })).ok === true && L.cleanPaperwork(form({ paperworkNote: 'call 513-555-0100' })).ok === true);
  ok('a bad date is refused', L.cleanPaperwork(form({ glExpiry: '03/01/2027' })).ok === false);
  ok('a bad W-9 status is refused', L.cleanPaperwork(form({ w9Status: 'maybe' })).ok === false);
  ok('exempt from workers comp needs a reason', L.cleanPaperwork(form({ wcExempt: true, wcExemptNote: '' })).ok === false && L.cleanPaperwork(form({ wcExempt: true, wcExemptNote: 'letter on file' })).ok === true);
  ok('a W-9 received date is dropped unless the W-9 is on file', L.cleanPaperwork(form({ w9Status: 'requested' })).fields.w9ReceivedOn === null);
  ok('text is trimmed to the rules\' bounds', L.cleanPaperwork(form({ paperworkNote: 'n'.repeat(900) })).fields.paperworkNote.length === 500 && L.cleanPaperwork(form({ legalName: 'x'.repeat(300) })).fields.legalName.length === 120);
}

console.log('\n— private paper paths —');
{
  ok('a sub-papers path is a valid private path', L.paperPathOk('sub-papers/co1/s1/1760000000_w9.pdf'));
  ok('a link, a token, a wrong folder, a missing sub and .. are all refused',
    !L.paperPathOk('https://firebasestorage.googleapis.com/v0/b/x/o/a.pdf?token=1') && !L.paperPathOk('sub-papers/co1/s1/a.pdf?token=1') && !L.paperPathOk('receipts/u1/a.jpg') &&
    !L.paperPathOk('sub-papers/co1/a.pdf') && !L.paperPathOk('sub-papers/co1/s1/..') && !L.paperPathOk(null));
  const PP = require(path.join(ROOT, 'docs/pro/js/proof-photos.js'));
  ok('the shared opener accepts a paper path and still refuses everything else it did before',
    PP.pathOk('sub-papers/co1/s1/1_w9.pdf') && PP.pathOk('receipts/u1/sub-proofs/1_a.jpg') && PP.pathOk('payment-proofs/u1/inv1/1_a.jpg') &&
    !PP.pathOk('receipts/u1/a.jpg') && !PP.pathOk('photos/u1/a.jpg') && !PP.pathOk('sub-papers/co1/a.pdf') && !PP.pathOk('sub-papers/co1/s1/../x'));
}

console.log('\n— year totals (plain /expenses, nothing unmerged) —');
const roster = [{ id: 's1', name: 'CA Roofing', legalName: 'CA Roofing LLC', aliases: [], w9Status: 'on_file', entityType: 'LLC' }, { id: 's2', name: 'Bright Gutters', aliases: ['BG Gutters'], w9Status: 'none' }, { id: 's3', name: 'Idle Crew' }];
{
  const rows = [
    pay({ amountCents: 100000, paymentMethod: 'cash' }),
    pay({ supplier: 'CA Roofing (Alex)', amountCents: 50050, paymentMethod: 'zelle', date: day(2026, 12, 31) }),
    pay({ supplier: 'whoever', subId: 's2', amountCents: 20000, paymentMethod: 'check' }),
    pay({ supplier: 'BG Gutters', amountCents: 10000, paymentMethod: '' }),
    pay({ supplier: 'Zed Siding', amountCents: 77700, paymentMethod: 'cash' }),
    pay({ supplier: 'Zed Siding LLC', amountCents: 300, taxCents: 25 }),
    pay({ amountCents: 99999, deleted: true }),
    pay({ amountCents: 88888, estimated: true }),
    pay({ amountCents: 12345, date: day(2025, 12, 31) }),
    pay({ amountCents: 11111, date: day(2027, 1, 1) }),
    pay({ category: 'materials', supplier: 'CA Roofing', amountCents: 55555 }),
    pay({ amountCents: 0 }),
  ];
  const yt = L.yearTotals(rows, roster, 2026);
  const t = (id) => yt.subs.find((x) => x.sub.id === id).totals;
  ok('a roster sub totals its own rows and its alias spelling ("CA Roofing (Alex)")', t('s1').cents === 150050 && t('s1').count === 2);
  ok('subId beats the typed name; an alias spelling lands on its sub', t('s2').cents === 30000 && t('s2').count === 2);
  ok('split by method, with "no method" its own bucket', t('s1').byMethod.cash === 100000 && t('s1').byMethod.zelle === 50050 && t('s2').byMethod.check === 20000 && t('s2').byMethod.none === 10000 && t('s2').noMethod === 1);
  ok('deleted, estimated, other-year, other-category and $0 rows are NOT counted', yt.all.cents === 150050 + 30000 + 77700 + 325 && yt.all.count === 6);
  ok('estimated rows are reported apart, never added', yt.estimated.cents === 88888 && yt.estimated.count === 1);
  ok('Dec 31 counts in its year and Jan 1 of the next does not', t('s1').count === 2 && L.yearTotals(rows, roster, 2027).all.cents === 11111);
  ok('a payee on no roster sub is listed (grouped by name key), never dropped', yt.unassigned.length === 1 && yt.unassigned[0].totals.cents === 78025 && yt.unassigned[0].totals.count === 2);
  ok('sales-tax cents on a row are included in what was paid', yt.unassigned[0].totals.cents === 77700 + 300 + 25);
  ok('an idle roster sub is present with zero', t('s3').cents === 0 && t('s3').count === 0);
  ok('money is whole cents everywhere', yt.subs.every((x) => Number.isInteger(x.totals.cents)) && Number.isInteger(yt.all.cents));
  ok('a legal name on the roster also matches payments written under it', L.yearTotals([pay({ supplier: 'CA Roofing LLC' })], roster, 2026).subs[0].totals.count === 1);
  const pf = L.paymentsFor(rows, roster, 's1', 2026, 10);
  ok('the sheet list is newest first and only that sub', pf.length === 2 && pf[0].supplier === 'CA Roofing (Alex)');
  ok('a string date (YYYY-MM-DD) is read as its own year, not shifted by the time zone', L.yearOf('2026-01-01') === 2026 && L.yearOf(new Date(2026, 0, 1, 0, 30)) === 2026);
}

console.log('\n— 1099 prep rows and CSV —');
{
  const rows = [
    pay({ amountCents: 100000, paymentMethod: 'cash' }),
    pay({ supplier: 'BG Gutters', amountCents: 10000, paymentMethod: '' }),
    pay({ supplier: 'Zed Siding', amountCents: 77700 }),
    pay({ amountCents: 88888, estimated: true }),
  ];
  const yt = L.yearTotals(rows, roster, 2026);
  const pr = L.prepRows(yt, {});
  const by = (n) => pr.find((r) => r.name === n);
  ok('rows: paid subs and unmatched payees; the idle sub is left out', pr.length === 3 && !pr.some((r) => r.name === 'Idle Crew'));
  ok('flag: no W-9 on file', by('Bright Gutters').flags.indexOf('No W-9 on file') !== -1 && by('CA Roofing LLC').flags.indexOf('No W-9 on file') === -1);
  ok('flag: payee not matched to a roster sub', by('Zed Siding').flags.indexOf('Payee not matched to a roster sub') !== -1 && by('Zed Siding').kind === 'unassigned');
  ok('flag: payments with no method', by('Bright Gutters').flags.some((f) => /1 payment with no method/.test(f)));
  const csv = L.csv1099(yt, {});
  ok('CSV: header row, legal name used for the 1099, dollars from whole cents', /Legal name,Name on the roster/.test(csv) && /CA Roofing LLC,CA Roofing,LLC,On file,,1000\.00,1,1000\.00,0\.00,0\.00,0\.00,0\.00,/.test(csv));
  ok('CSV: unassigned block and a grand total of everything above', /Unassigned: payees not matched/.test(csv) && /"Total paid, all rows above",,,,,1877\.00,3/.test(csv));
  ok('CSV: the estimated rows are named as left out', /Left out: 1 estimated cost row\(s\) totalling 888\.88/.test(csv));
  ok('CSV: says to confirm with the CPA and that unlogged cash is missing', csv.indexOf(L.CPA_NOTE) !== -1 && /Confirm thresholds, who needs a 1099, and filing deadlines with your CPA\./.test(csv) && /never logged is not here/.test(csv));
  ok('CSV: states no threshold or deadline figure as fact', !/\$\s?\d|threshold (of|is)|due (by|on)|January 31|\b600\b|\b2,?000\b/.test(csv.replace(/[0-9]+\.[0-9]{2}/g, '')));
  ok('CSV: no tax-id-looking value and no SSN/EIN column', !/\b\d{3}-\d{2}-\d{4}\b|\b\d{2}-\d{7}\b/.test(csv) && !/SSN|EIN|Tax ?ID/i.test(csv.split('\r\n')[1]) && /holds no Social Security or tax ID numbers/.test(csv));
  const inj = L.csv1099(L.yearTotals([pay({ supplier: '=HYPERLINK("http://x","y")' }), pay({ supplier: 'a,"b"' })], roster, 2026), {});
  ok('CSV: a payee starting with = is defused, commas and quotes are quoted', /'=HYPERLINK/.test(inj) && /"a,""b"""/.test(inj) && !/(^|\n)=HYPERLINK/.test(inj));
  ok('CSV: Windows line endings and a final newline', csv.indexOf('\r\n') > 0 && /\r\n$/.test(csv));
  ok('CSV: an empty year still has the notes (no crash)', /Calendar year 2031/.test(L.csv1099(L.yearTotals([], roster, 2031), {})) && /CPA/.test(L.csv1099(L.yearTotals([], roster, 2031), {})));
}

console.log('\n— export is owner-only, capped loads are flagged, odd payee names —');
{
  const cons = [pay({ supplier: 'constructor' }), pay({ supplier: '__proto__', amountCents: 500 }), pay({ supplier: 'toString', amountCents: 700 })];
  let yt2; let threw = false;
  try { yt2 = L.yearTotals(cons, roster, 2026); } catch (e) { threw = true; }
  ok('a payee named constructor / __proto__ / toString is just a name (no crash, own bucket)', !threw && yt2.unassigned.length === 3 && yt2.all.cents === 101200);
  ok('a roster sub whose id is "constructor" still totals', L.yearTotals([pay({ subId: 'constructor' })], [{ id: 'constructor', name: 'CA Roofing' }], 2026).subs[0].totals.count === 1);
  const cap = (c, o) => L.capWarning({ count: c, cap: 1000, oldestMs: o }, 2026);
  ok('cap hit and oldest row after Jan 1 of the year: warns', /can be too low/.test(cap(1000, new Date(2026, 3, 1).getTime())) && /not use this export for filing/.test(cap(1000, new Date(2026, 3, 1).getTime())));
  ok('cap hit but the load reaches back before the year: no warning', cap(1000, new Date(2025, 11, 31).getTime()) === '');
  ok('cap not hit (999 raw rows): no warning', cap(999, new Date(2026, 3, 1).getTime()) === '');
  ok('no meta known: no warning, no crash', L.capWarning(null, 2026) === '' && L.capWarning({ count: 1000, cap: 1000, oldestMs: null }, 2026) === '');
  ok('the CSV carries the warning line when capped, not otherwise', /WARNING: Only the newest 1000/.test(L.csv1099(L.yearTotals([], roster, 2026), { capNote: cap(1000, new Date(2026, 3, 1).getTime()) })) && !/WARNING/.test(L.csv1099(L.yearTotals([], roster, 2026), {})));
  const ex = stripComments(read('docs/pro/js/expenses.js'));
  ok('Expenses.meta() counts the RAW rows (voided included) before they are dropped', ex.indexOf('_loadMeta = { count: snap.docs.length') > 0 && ex.indexOf('_loadMeta = { count: snap.docs.length') < ex.indexOf('.filter(function (e) { return e.deleted !== true; })') && ex.includes('meta: function ()'));
  const ui2 = stripComments(read('docs/pro/js/sub-paperwork.js'));
  ok('export is owner/company_admin only: exportHtml, downloadCsv, print and the tab each check canWrite()',
    /function exportHtml\(\) \{\s*if \(!canWrite\(\)\) return ''/.test(ui2) && /function downloadCsv\(\) \{\s*if \(!canWrite\(\) \|\| !S\) return/.test(ui2) &&
    ui2.includes("a === 'print') { if (canWrite())") && ui2.includes("a === 'tab-export') { if (!canWrite()) return") && ui2.includes("(canWrite() ? '<button type=\"button\" class=\"spw-tab\" data-spw-act=\"tab-export\""));
  ok('a viewer / manager cannot even open the export view', ui2.includes("view === 'export' && !canWrite() ? 'list'"));
}

console.log('\n— the daily watcher (owner only) —');
{
  const subs = [
    { id: 's1', name: 'CA Roofing', glExpiry: '2026-10-26', wcExpiry: '2026-10-01', licenseRequired: true, licenseExpiry: '2026-11-10' },
    { id: 's2', name: 'Bright Gutters', insuranceExpiry: '2026-11-02', wcExempt: true, wcExpiry: '2026-10-01' },
    { id: 's3', name: 'Idle Crew' },
    { id: 's4', name: 'Gone', active: false, glExpiry: '2026-10-20' },
    { id: 's5', name: 'Fine', glExpiry: '2028-01-01', wcExpiry: '2028-01-01' },
    { id: 's6', name: 'No license needed', glExpiry: '2028-01-01', licenseRequired: false, licenseExpiry: '2026-10-20' },
  ];
  const a = FL.planAlerts('co1', subs, TODAY);
  const ids = a.map((x) => x.id).sort();
  ok('s1: liability due7, workers comp expired, license due30 -> three reports', ids.filter((i) => i.indexOf('_s1_') > 0).length === 3);
  ok('ids are deterministic: company, sub, kind, expiry, stage', a.some((x) => x.id === 'subdoc_co1_s1_gl_2026-10-26_due7') && a.some((x) => x.id === 'subdoc_co1_s1_wc_2026-10-01_expired') && a.some((x) => x.id === 'subdoc_co1_s1_license_2026-11-10_due30'));
  ok('the legacy insuranceExpiry is watched as liability', a.some((x) => x.id === 'subdoc_co1_s2_gl_2026-11-02_due14'));
  ok('an exempt sub raises no workers-comp alert (its stale date is ignored)', !a.some((x) => /_s2_wc_/.test(x.id)));
  ok('no dates = no alert; inactive subs, healthy subs and an unneeded license raise none', !a.some((x) => /_s3_|_s4_|_s5_|_s6_/.test(x.id)));
  ok('renewing (a new date) makes a new id; the same day makes the same id', FL.planAlerts('co1', [{ id: 's1', name: 'x', glExpiry: '2026-10-26' }], TODAY)[0].id === FL.planAlerts('co1', [{ id: 's1', name: 'x', glExpiry: '2026-10-26' }], '2026-10-19')[0].id && FL.planAlerts('co1', [{ id: 's1', name: 'x', glExpiry: '2026-10-28' }], '2026-10-23')[0].id !== 'subdoc_co1_s1_gl_2026-10-26_due7');
  const item = a[0].item;
  ok('every report is an owner report: kind report, no lead, no phone/email, says nothing was sent', a.every((x) => x.item.kind === 'report' && x.item.leadId === null && /Nothing was sent to the sub/.test(x.item.text)) && !/@|\b\d{3}[- .]\d{4}\b/.test(JSON.stringify(item)));
  ok('titles are bounded', a.every((x) => x.item.title.length <= 140));

  // runWatch with a fake Firestore: dry run writes nothing, live files once.
  const writes = { create: 0, set: 0 };
  const store = new Set();
  const fakeDb = {
    collectionGroup: () => ({ limit: () => ({ get: async () => ({ forEach: (fn) => subs.forEach((s) => fn({ ref: { path: 'companies/co1/subs/' + s.id }, data: () => { const d = Object.assign({}, s); delete d.id; return d; } })) }) }) }),
    doc: (p) => ({
      get: async () => ({ exists: false, data: () => ({}) }),
      create: async (obj) => { if (store.has(p)) { const e = new Error('already exists'); e.code = 6; throw e; } store.add(p); writes.create++; if (obj.status !== 'pending') throw new Error('shape'); },
      set: async () => { writes.set++; },
    }),
  };
  // The watcher's cloud imports are stubbed so this runs without functions/node_modules.
  const Module = require('module');
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === 'firebase-functions/v2') return { logger: { info() {}, warn() {} } };
    if (req === 'firebase-admin/firestore') return { getFirestore() { return null; }, FieldValue: { serverTimestamp: () => 'TS' } };
    if (/integrations\/heartbeat$/.test(req)) return { onSchedule: (o, f) => f };
    return origLoad.apply(this, arguments);
  };
  const W = require(path.join(ROOT, 'functions/sub-paperwork-watch.js'));
  Module._load = origLoad;
  (async () => {
    const nowMs = Date.UTC(2026, 9, 19, 16, 0, 0);
    const dry = await W.runWatch({ db: fakeDb, nowMs, live: false });
    ok('dry run: counts what is due, writes nothing', dry.due === a.length && writes.create === 0 && writes.set === 0);
    const live = await W.runWatch({ db: fakeDb, nowMs, live: true });
    ok('live run: files every report once and one bell for the company', live.filed === a.length && writes.create === a.length && writes.set === 1);
    const again = await W.runWatch({ db: fakeDb, nowMs, live: true });
    ok('a second run the same day files nothing new (create() + stable ids)', again.filed === 0 && again.alreadyFiled === a.length && writes.set === 1);

    console.log('\n— source wiring (comments stripped) —');
    const ui = stripComments(read('docs/pro/js/sub-paperwork.js'));
    const lg = stripComments(read('docs/pro/js/sub-paperwork-logic.js'));
    const wsrc = stripComments(read('functions/sub-paperwork-watch.js') + read('functions/sub-paperwork-logic.js'));
    const css = read('docs/pro/css/sub-paperwork.css');
    ok('UI reads the subPaperwork flag; default off', /FLAG = 'subPaperwork'/.test(ui) && !/feature_flags[^\n]*subPaperwork\s*:\s*true/.test(ui));
    ok('no inline handlers or inline scripts in generated markup', !/\son[a-z]+=/.test(ui) && !/<script/i.test(ui));
    ok('files open through the shared blob opener; no download URL or token anywhere', !/getDownloadURL|downloadURL|downloadUrl/i.test(ui + lg) && !/token=/.test(ui + lg) && /NBDProofPhotos/.test(ui));
    ok('the UI uploads with the SHARED component (EXIF stripped), not its own copy', /PP\(\)\.upload\(/.test(ui) && !/toBlob\(/.test(ui));
    ok('uploads go to the private sub-papers path and only the PATH is stored', /'sub-papers\/' \+ t \+ '\/' \+ subId/.test(ui) && /storagePath: f\.path/.test(ui));
    ok('viewer and manager get no files: papers load and the upload button need write access', /async function loadPapers[\s\S]{0,80}if \(!canWrite\(\)\) return \[\]/.test(ui) && /if \(canWrite\(\)\) h \+= papersHtml\(\)/.test(ui));
    ok('owner / company_admin write; sales rep reads nothing', /WRITE_ROLES = \['', 'company_admin'\]/.test(ui) && !/READ_ROLES[^\n]*sales_rep/.test(ui));
    ok('the form asks for no SSN/EIN and says so', !/id="spw(Ssn|Ein|Tax)/i.test(ui) && /Do not type a Social Security or tax ID number/.test(ui));
    ok('a stray id field in the data never wins over the doc id (UI roster, watcher)', ui.includes('Object.assign({}, s, { id: d.id,') && wsrc.includes('Object.assign({}, d.data(), { id: m[2] })'));
    ok('a failed pointer write removes the uploaded file (no invisible W-9 left behind)', ui.includes('uploaded = done.map') && ui.includes('deleteObject(st.ref(w.storage, p))'));
    ok('the UI states no 1099 threshold (it shows the CPA note)', /CPA_NOTE/.test(ui) && !/\$600|\$2,?000|threshold of/.test(ui + lg));
    ok('crews are never called employees (UI, logic, server, CSS)', !/employee|payroll|in-house|in house|W-?2\b/i.test(ui + lg + wsrc + css));
    ok('no old brand oranges', !/E8720C|F08030/i.test(css));
    ok('the watcher sends nothing: no SMS, email, Twilio, Resend or draft path', !/twilio|sendgrid|resend|nodemailer|sendSms|sendEmail|email_queue|sms_queue|outbox|messaging/i.test(wsrc));
    ok('the watcher is a dry run unless SUB_PAPERWORK_WATCH_ENABLED === true, and the env file ships it false', /SUB_PAPERWORK_WATCH_ENABLED === 'true'/.test(wsrc) && /^SUB_PAPERWORK_WATCH_ENABLED=false/m.test(read('functions/.env.nobigdeal-pro')));
    ok('the function is exported and indexed', /exports\.subPaperworkWatch = require\('\.\/sub-paperwork-watch'\)/.test(read('functions/index.js')) && /`subPaperworkWatch`/.test(read('functions/FUNCTIONS_INDEX.md')));
    const sl = read('docs/pro/js/script-loader.js');
    ok('script-loader: proof-photos, then logic, then ui, in the expenses bundle', sl.indexOf('js/proof-photos.js') > 0 && sl.indexOf('js/proof-photos.js') < sl.indexOf('js/sub-paperwork-logic.js') && sl.indexOf('js/sub-paperwork-logic.js') < sl.indexOf('js/sub-paperwork.js') && /sub-paperwork\.css/.test(sl));
    ok('expenses.js mounts the panel', /NBDSubPaperwork\.panelHtml\(\)/.test(read('docs/pro/js/expenses.js')));

    console.log('\n— rules text (the emulator suites prove behavior) —');
    const fr = read('firestore.rules'), sr = read('storage.rules');
    ok('subs: the paperwork validator is part of subWriteOk', /&& subPaperworkOk\(d\);/.test(fr));
    ok('subs: tax-id keys and tax-id text are refused', /hasAny\(\['ssn', 'ein', 'tin'/.test(fr) && /\(\?s\)\.\*\(\^\|\[\^0-9\]\)/.test(fr));
    ok('subs: a manager cannot set or change a paperwork field', /subPaperworkWriter\(\)/.test(fr) && /affectedKeys\(\)\.hasAny\(subPaperworkKeys\(\)\)/.test(fr));
    ok('papers: no update, path pinned to this company and sub, no link', /match \/papers\/\{paperId\}/.test(fr) && /allow update: if false;/.test(fr.slice(fr.indexOf('match /papers/'))) && /'\^sub-papers\/' \+ companyId \+ '\/' \+ subId/.test(fr));
    ok('storage: sub-papers read/create/delete are company_admin or solo owner only; no platform admin', (() => { const b = sr.slice(sr.indexOf('match /sub-papers/'), sr.indexOf('// ── YARD-SIGN')); return /allow read: if isCompanyAdminOf\(companyId\);/.test(b) && /allow delete: if isCompanyAdminOf\(companyId\);/.test(b) && !/isAdmin\(\)|isOwner\(/.test(b) && /isProofType\(\)/.test(b) && /allow update: if false;/.test(b); })());

    ok('L3 guard: no getDownloadURL in the shared proof opener or the paperwork UI/logic', !/getDownloadURL/.test(stripComments(read('docs/pro/js/proof-photos.js')) + ui + lg));

    console.log('\n— BEHAVIOR: who can reach the 1099 export (fake document) —');
    const handlers = {};
    async function whoCanExport(claims) {
      const els = {};
      let blobs = 0, clicks = [];
      const mkEl = () => ({ innerHTML: '', id: '', className: '', setAttribute() {}, remove() {}, appendChild() {}, click() { clicks.push(1); }, querySelectorAll: () => [] });
      const doc = {
        body: { appendChild(e) { els[e.id] = e; } },
        createElement: () => mkEl(),
        getElementById: (id) => els[id] || null,
        addEventListener: (t, fn) => { handlers[t] = fn; },
      };
      const rows = [{ id: 's1', data: { name: 'CA Roofing', trade: 'Roofing' } }];
      const win = { console, document: doc, Blob: class { constructor() { } }, setTimeout: () => 0,
        URL: { createObjectURL: () => { blobs++; return 'blob:x'; }, revokeObjectURL() { } },
        NBDFlags: { enabled: (n) => n === 'subPaperwork' }, _user: { uid: 'u1' }, _userClaims: claims,
        db: {}, collection: (...a) => a, getDocs: async () => ({ forEach: (fn) => rows.forEach((r) => fn({ id: r.id, data: () => r.data })) }),
        serverTimestamp: () => 'TS', Expenses: { list: () => [pay({ amountCents: 123400 })], meta: () => null }, print: () => { win.__printed = true; } };
      win.window = win;
      vm.createContext(win);
      ['docs/pro/js/sub-payments-logic.js', 'docs/pro/js/sub-paperwork-logic.js', 'docs/pro/js/proof-photos.js', 'docs/pro/js/sub-paperwork.js'].forEach((f) => vm.runInContext(read(f), win, { filename: f }));
      const click = async (act) => { await handlers.click({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-spw-act' ? act : null) }) }, preventDefault() { } }); await new Promise((r) => setImmediate(r)); };
      await win.NBDSubPaperwork.open('export');
      const afterOpen = (els.spwOverlay || { innerHTML: '' }).innerHTML;
      await click('tab-export');
      const afterTab = els.spwOverlay.innerHTML;
      await click('csv'); await click('print');
      return { tabShown: /data-spw-act="tab-export"/.test(afterOpen), exportShown: /data-spw-act="csv"/.test(afterTab) || /data-spw-act="csv"/.test(afterOpen), csvDownloads: blobs, printed: !!win.__printed };
    }
    for (const [who, claims, allowed] of [['owner', {}, true], ['company_admin', { role: 'company_admin', companyId: 'co' }, true], ['manager', { role: 'manager', companyId: 'co' }, false], ['viewer', { role: 'viewer', companyId: 'co' }, false]]) {
      const r = await whoCanExport(claims);
      ok(who + ': export tab ' + (allowed ? 'shown' : 'NOT shown') + ', csv button ' + (allowed ? 'shown' : 'absent') + ', downloads ' + (allowed ? 1 : 0) + ', print ' + (allowed ? 'works' : 'blocked'),
        r.tabShown === allowed && r.exportShown === allowed && r.csvDownloads === (allowed ? 1 : 0) && r.printed === allowed, JSON.stringify(r));
    }

    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    process.exit(failed ? 1 : 0);
  })().catch((e) => { console.error(e); process.exit(1); });
}

// The UI module under a fake window (flag, role, panel). Runs before the async block prints.
console.log('\n— the UI module (flag, role) —');
{
  const sandbox = (extra) => {
    const win = Object.assign({ console }, extra || {});
    win.window = win;
    vm.createContext(win);
    ['docs/pro/js/sub-paperwork-logic.js', 'docs/pro/js/sub-paperwork.js'].forEach((f) => vm.runInContext(read(f), win, { filename: f }));
    return win;
  };
  const flags = (on) => ({ enabled: (n) => on && n === 'subPaperwork' });
  const off = sandbox({ NBDFlags: flags(false), _user: { uid: 'u1' }, _userClaims: {} });
  ok('flag off: no panel', off.NBDSubPaperwork.panelHtml() === '');
  ok('flags not loaded: no panel', sandbox({ _user: { uid: 'u1' }, _userClaims: {} }).NBDSubPaperwork.panelHtml() === '');
  const owner = sandbox({ NBDFlags: flags(true), _user: { uid: 'u1' }, _userClaims: {} });
  ok('flag on, owner: the panel renders with an Open button', /data-spw-act="open"/.test(owner.NBDSubPaperwork.panelHtml()) && /Sub paperwork/.test(owner.NBDSubPaperwork.panelHtml()));
  ok('viewer: sees the panel (statuses and totals)', /data-spw-act="open"/.test(sandbox({ NBDFlags: flags(true), _user: { uid: 'u2' }, _userClaims: { role: 'viewer', companyId: 'co' } }).NBDSubPaperwork.panelHtml()));
  ok('sales rep: nothing', sandbox({ NBDFlags: flags(true), _user: { uid: 'u3' }, _userClaims: { role: 'sales_rep', companyId: 'co' } }).NBDSubPaperwork.panelHtml() === '');
  ok('signed out: nothing', sandbox({ NBDFlags: flags(true), _userClaims: {} }).NBDSubPaperwork.panelHtml() === '');
}
