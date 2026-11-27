/**
 * tests/labor-book-ui-2026-11-19.test.js — the Labor hours book editor panel
 * (docs/pro/js/labor-book.js, flag laborHoursBook).
 *
 * Behaviour, not source shape: the REAL panel and the REAL labor-book-logic run in a
 * vm sandbox against a tiny fake DOM, a fake company book (NBDCatalogCosts), a fake
 * labor catalog and a fake Firestore. The assertions that matter:
 *   - the book starts empty: nothing is pre-filled, nothing is guessed
 *   - a save writes ONLY { hoursPerUnit } for that action (never a rate), and only
 *     what actually changed
 *   - invalid input saves nothing and names the action
 *   - an unloaded book shows no editable boxes (an empty box over a held number would lie)
 *   - owner and company_admin only; flag off = no panel
 *   - crew size goes to the sub's own doc as { crewSize, updatedAt } and nothing else
 *   - action names are escaped; the rate never reaches the screen
 * Every number is synthetic (public repo).
 *
 * Run: node tests/labor-book-ui-2026-11-19.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok  ' + name); } else { failed++; fails.push(name); console.log('  FAIL ' + name); }
}
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

const LIST = [
  { id: 'A1', name: 'Alpha install', unit: 'SQ', category: 'install' },
  { id: 'A2', name: 'Alpha <b>tear-off</b>', unit: 'SQ', category: 'tear-off' },
  { id: 'B1', name: 'Beta detail', unit: 'LF', category: 'detail' },
];
const SUBS = [
  { id: 's1', name: 'Mike Ruiz', trade: 'Roofing', active: true, crewSize: 2 },
  { id: 's2', name: 'Sam Lee', trade: 'Gutters', active: true },
  { id: 's3', name: 'Retired Crew', active: false },
];

function makeEnv(opts) {
  const o = Object.assign({ flag: true, claims: {}, uid: 'co-a', hash: '#/schedule', book: { A1: { hoursPerUnit: 0.37, rate: 4242 }, B1: { hoursPerUnit: 0 } }, loaded: true, hydrate: 'ok', refuseWrites: false, failCrew: false }, opts || {});
  const reg = {}, docL = {}, winL = {};
  const calls = { record: [], update: [], hydrate: 0, toasts: [] };
  const makeEl = () => ({ id: '', className: '', innerHTML: '', remove() { if (this.id) delete reg[this.id]; }, insertAdjacentElement(pos, e) { if (e.id) reg[e.id] = e; return e; } });
  const anchor = makeEl(); anchor.id = 'schedPlanPanel'; reg.schedPlanPanel = anchor;
  const state = { loaded: o.loaded };
  const sb = {
    console, setTimeout, clearTimeout, Promise, Math, Date, Number, String, Array, Object, JSON, RegExp, parseInt, parseFloat, isFinite,
    document: {
      readyState: 'complete',
      getElementById: (id) => reg[id] || null,
      createElement: makeEl,
      querySelector: () => null,
      addEventListener: (t, fn) => { (docL[t] = docL[t] || []).push(fn); },
    },
    location: { hash: o.hash },
    _userClaims: o.claims, _user: { uid: o.uid }, db: {},
    NBDFlags: { enabled: (n) => !!o.flag && n === 'laborHoursBook' },
    NBD_LABOR: { search: () => LIST },
    NBDCatalogCosts: {
      laborOp: (id) => o.book[id] || null,
      isLoaded: () => state.loaded,
      hydrate: async () => { calls.hydrate++; await null; if (o.hydrate === 'fail') throw new Error('offline'); if (o.hydrate === 'ok') state.loaded = true; },
      recordLaborOp: async (id, entry) => { calls.record.push({ id, entry: JSON.parse(JSON.stringify(entry)) }); if (o.refuseWrites) return false; o.book[id] = Object.assign({}, o.book[id] || {}, entry); return true; },
    },
    NBDProduction: { loadSubs: async () => SUBS, subs: () => SUBS.map((s) => s) },
    showToast: (m) => calls.toasts.push(m),
    doc: (db, ...p) => ({ path: p }),
    serverTimestamp: () => 'SERVER_TS',
    updateDoc: async (ref, data) => { if (o.failCrew) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; } calls.update.push({ path: ref.path, data }); },
  };
  sb.window = sb;
  sb.addEventListener = (t, fn) => { (winL[t] = winL[t] || []).push(fn); };
  vm.createContext(sb);
  (o.jobHours === false ? ['labor-book-logic.js', 'labor-book.js'] : ['labor-hours-logic.js', 'job-hours-logic.js', 'labor-book-logic.js', 'labor-book.js']).forEach((f) => vm.runInContext(fs.readFileSync(path.join(JS, f), 'utf8'), sb, { filename: f }));
  const html = () => (reg.laborBookPanel ? reg.laborBookPanel.innerHTML : null);
  const fire = (t) => (winL[t] || []).forEach((fn) => fn({}));
  const panelObj = () => reg.laborBookPanel;
  const click = (action) => {
    const t = { closest: (sel) => (sel === '[data-lb-action]' ? t : sel === '#laborBookPanel' ? panelObj() : null), getAttribute: (a) => (a === 'data-lb-action' ? action : null) };
    (docL.click || []).forEach((fn) => fn({ target: t }));
  };
  const type = (attr, id, value) => {
    const t = { value, closest: (sel) => (sel === '#laborBookPanel' ? panelObj() : null), getAttribute: (a) => (a === attr ? (attr === 'data-lb-f' ? 'q' : id) : null) };
    (docL.input || []).forEach((fn) => fn({ target: t }));
  };
  return { calls, html, fire, click, type, book: o.book };
}
const start = async (opts) => { const e = makeEnv(opts); e.fire('nbd:data-refreshed'); await tick(); return e; };

(async () => {
  console.log('1. who sees it');
  {
    ok('flag off: no panel', (await start({ flag: false })).html() === null);
    ok('the solo owner sees it', (await start()).html() !== null);
    ok('a company_admin sees it', (await start({ claims: { role: 'company_admin', companyId: 'co-a' }, uid: 'carol' })).html() !== null);
    ok('a manager does NOT (the book is owner / company_admin write)', (await start({ claims: { role: 'manager', companyId: 'co-a' }, uid: 'mike' })).html() === null);
    ok('the platform admin who OWNS the tenant (company id = their uid) sees it', (await start({ claims: { role: 'admin', companyId: 'co-a' }, uid: 'co-a' })).html() !== null);
    ok('a platform admin who does NOT own the tenant does not', (await start({ claims: { role: 'admin', companyId: 'co-a' }, uid: 'joe' })).html() === null);
    ok('a sales rep does NOT', (await start({ claims: { role: 'sales_rep', companyId: 'co-a' }, uid: 'al' })).html() === null);
    ok('a viewer does NOT', (await start({ claims: { role: 'viewer', companyId: 'co-a' }, uid: 'vic' })).html() === null);
    ok('off the Schedule view, nothing renders', (await start({ hash: '#/leads' })).html() === null);
  }

  console.log('2. what it shows');
  {
    const e = await start();
    const h = e.html();
    ok('every labor action is listed', /Alpha install/.test(h) && /Beta detail/.test(h) && /data-lb-hours="A2"/.test(h));
    ok('a held number is prefilled; a held 0 shows as 0', /data-lb-hours="A1" value="0.37"/.test(h) && /data-lb-hours="B1" value="0"/.test(h));
    ok('an action with no hours is an EMPTY box (nothing is guessed)', /data-lb-hours="A2" value=""/.test(h));
    ok('action names are escaped (no raw <b> tag)', !/<b>tear-off/.test(h) && /&lt;b&gt;tear-off/.test(h));
    ok('PRIVACY: the stored rate never reaches the screen', !/4242/.test(h));
    ok('active subs get a crew box; a retired sub does not', /data-lb-crew="s1" value="2"/.test(h) && /data-lb-crew="s2" value=""/.test(h) && !/data-lb-crew="s3"/.test(h));
    ok('the default crew is stated, not hidden', /crew of 3/.test(h));
  }

  console.log('3. an unloaded book is not editable');
  {
    const e = await start({ loaded: false, hydrate: 'ok' });
    ok('after one successful load the editor appears', /data-lb-hours="A1"/.test(e.html()) && e.calls.hydrate === 1);
    const f = await start({ loaded: false, hydrate: 'fail' });
    ok('a failed load shows a message and NO editable boxes (an empty box over a held number would lie)', /Could not load your labor book/.test(f.html()) && !/data-lb-hours/.test(f.html()) && f.calls.hydrate === 1);
    const n = await start({ loaded: false, hydrate: 'ok-but-not-loaded' });
    ok('a company with no book yet is ready after one load (no endless reloading)', /data-lb-hours="A2"/.test(n.html()) && n.calls.hydrate === 1);
    const s = makeEnv({ loaded: false, hydrate: 'ok' });
    s.fire('nbd:data-refreshed');
    ok('while loading, the panel says so and shows no boxes', /Loading your labor book/.test(s.html()) && !/data-lb-hours/.test(s.html()));
  }

  console.log('4. saving hours');
  {
    const e = await start();
    e.type('data-lb-hours', 'A2', '1.25');
    e.type('data-lb-hours', 'A1', '0.37');           // unchanged
    e.type('data-lb-hours', 'B1', '0');              // unchanged real 0
    e.click('save-hours'); await tick();
    ok('only the changed action is written', e.calls.record.length === 1 && e.calls.record[0].id === 'A2');
    ok('the write is { hoursPerUnit } and NOTHING else (never a rate or crew size)', JSON.stringify(e.calls.record[0].entry) === JSON.stringify({ hoursPerUnit: 1.25 }));
    ok('the typed value now shows as held, and the success is said', /data-lb-hours="A2" value="1.25"/.test(e.html()) && /1 saved/.test(e.html()));
    ok('the rate on another action is untouched', e.book.A1.rate === 4242);

    const z = await start();
    z.type('data-lb-hours', 'A2', '0'); z.click('save-hours'); await tick();
    ok('typing 0 on an action with nothing held IS saved (a real 0)', z.calls.record.length === 1 && z.calls.record[0].entry.hoursPerUnit === 0);

    const b = await start();
    b.type('data-lb-hours', 'A2', 'abc'); b.type('data-lb-hours', 'A1', '5'); b.click('save-hours'); await tick();
    ok('an invalid box saves NOTHING (not even the valid one) and names the action', b.calls.record.length === 0 && /Alpha <b>tear-off<\/b>|Alpha &lt;b&gt;tear-off&lt;\/b&gt;/.test(b.html()) && /Nothing was saved/.test(b.html()));
    ok('control: fixing the box lets both save', (b.type('data-lb-hours', 'A2', '2'), b.click('save-hours'), await tick(), b.calls.record.length === 2));

    const c = await start();
    c.type('data-lb-hours', 'A1', ''); c.click('save-hours'); await tick();
    ok('a blank over a held number writes nothing and says clearing is not supported', c.calls.record.length === 0 && /Clearing a number is not supported/.test(c.html()));

    const n = await start();
    n.click('save-hours'); await tick();
    ok('saving with nothing typed writes nothing', n.calls.record.length === 0 && /Nothing changed/.test(n.html()));

    const r = await start({ refuseWrites: true });
    r.type('data-lb-hours', 'A2', '3'); r.click('save-hours'); await tick();
    ok('a refused write says so, and keeps what was typed', /could not be saved/.test(r.html()) && /data-lb-hours="A2" value="3"/.test(r.html()));
  }

  console.log('5. search keeps what you typed');
  {
    const e = await start();
    e.type('data-lb-hours', 'A2', '1.5');
    e.type('data-lb-f', null, 'beta');
    ok('the search narrows the list', /Beta detail/.test(e.html()) && !/data-lb-hours="A2"/.test(e.html()));
    e.type('data-lb-f', null, '');
    ok('a typed-but-unsaved value survives a search and clearing it', /data-lb-hours="A2" value="1.5"/.test(e.html()));
  }

  console.log('6. crew size');
  {
    const e = await start();
    e.type('data-lb-crew', 's2', '4'); e.type('data-lb-crew', 's1', '2');
    e.click('save-crew'); await tick();
    ok('only the changed sub is written, to that sub\'s own doc', e.calls.update.length === 1 && e.calls.update[0].path.join('/') === 'companies/co-a/subs/s2');
    ok('the write is { crewSize, updatedAt } and nothing else', Object.keys(e.calls.update[0].data).sort().join() === 'crewSize,updatedAt' && e.calls.update[0].data.crewSize === 4 && e.calls.update[0].data.updatedAt === 'SERVER_TS');

    const bad = await start();
    bad.type('data-lb-crew', 's2', '0'); bad.click('save-crew'); await tick();
    ok('a crew of 0 saves nothing and says why', bad.calls.update.length === 0 && /whole number from 1 to 20/.test(bad.html()));
    bad.type('data-lb-crew', 's2', '2.5'); bad.click('save-crew'); await tick();
    ok('a decimal crew saves nothing', bad.calls.update.length === 0);

    const blank = await start();
    blank.type('data-lb-crew', 's1', ''); blank.click('save-crew'); await tick();
    ok('a blank crew box writes nothing (it does not clear a held size)', blank.calls.update.length === 0);

    const f = await start({ failCrew: true });
    f.type('data-lb-crew', 's2', '5'); f.click('save-crew'); await tick();
    ok('a refused crew write is reported, not swallowed', /could not be saved/.test(f.html()));
  }

  console.log('7. book time per job type');
  {
    const e = await start();
    const h = e.html();
    ok('both job types get a whole-job book time box, empty until typed', /Book time per job type/.test(h) && /data-lb-hours="BOOK:replacement" value=""/.test(h) && /data-lb-hours="BOOK:repair" value=""/.test(h));
    ok('a replacement is per SQ and a repair is per job', /Man-hours per SQ for Roof replacement/.test(h) && /Man-hours per job for Repair/.test(h));
    const held = await start({ book: { 'BOOK:replacement': { hoursPerUnit: 1.25 }, 'BOOK:repair': { hoursPerUnit: 0 } } });
    ok('held book times are prefilled, and a held 0 shows as 0', /data-lb-hours="BOOK:replacement" value="1.25"/.test(held.html()) && /data-lb-hours="BOOK:repair" value="0"/.test(held.html()));
    e.type('data-lb-hours', 'BOOK:replacement', '1.5'); e.click('save-hours'); await tick();
    ok('saving writes { hoursPerUnit } under the reserved key and nothing else', e.calls.record.length === 1 && e.calls.record[0].id === 'BOOK:replacement' && JSON.stringify(e.calls.record[0].entry) === JSON.stringify({ hoursPerUnit: 1.5 }));
    const bad = await start();
    bad.type('data-lb-hours', 'BOOK:repair', 'abc'); bad.click('save-hours'); await tick();
    ok('an invalid book time saves nothing and says so', bad.calls.record.length === 0 && /Nothing was saved/.test(bad.html()));
    const s = await start();
    s.type('data-lb-f', null, 'zzz');
    ok('the search never hides the book time rows', /data-lb-hours="BOOK:replacement"/.test(s.html()) && /Nothing matches/.test(s.html()));
    const off = await start({ jobHours: false });
    ok('control: without the job-hours logic there is no book time section, and the actions still list', !/Book time per job type/.test(off.html()) && /data-lb-hours="A1"/.test(off.html()));
    ok('PRIVACY: a book time never writes a rate', e.calls.record.every((c) => !('rate' in c.entry)));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
