/**
 * tests/tracker-business-tile-2026-10-23.test.js
 *
 * Daily Success: the "Today's business" tile. The CRM's Today screen publishes
 * a counts-only summary (today-plan.js summaryForTracker, written by
 * today-home.js to localStorage nbd_today_summary); the tracker reads it
 * (business-tile-logic.js read) and never touches Firestore for it.
 * Clock checks pass `now` in / fake Date; synthetic data only.
 *
 * Run: node tests/tracker-business-tile-2026-10-23.test.js
 */
'use strict';

process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const DS = path.join(ROOT, 'docs', 'pro', 'daily-success');
const TP = require(path.join(ROOT, 'docs', 'pro', 'js', 'today-plan.js'));
const B = require(path.join(DS, 'js', 'business-tile-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ok  ' + label); passed++; }
  else { console.log('  FAIL ' + label + (detail ? ' - ' + detail : '')); failed++; }
}
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/^\/\*[\s\S]*?\*\//, '').replace(/^\s*\/\/.*$/gm, '');

const NOW = new Date(2026, 9, 23, 9, 30).getTime();   // Fri Oct 23 2026, 9:30 am local
const good = (o) => JSON.stringify(Object.assign({ v: 1, uid: 'u1', asOf: new Date(2026, 9, 23, 7, 40).getTime(), calls: 3, followUps: 5, jobs: 2 }, o || {}));

console.log('\n1. the CRM side publishes counts, not people');
{
  const plan = {
    calls: [{ key: 'a', name: 'Pat Smith', phone: '5135550001' }, { key: 'b', name: 'Lee Jones' }],
    promised: [{ leadId: 'p1' }], promises: [{ leadId: 'p2' }, { leadId: 'p3' }], estimates: [{ leadId: 'e1' }], stalled: [{ leadId: 's1' }, { leadId: 's2' }],
    appointments: [{ id: 'x' }], money: [{ id: 'm' }], waiting: [{ id: 'w' }],
  };
  const s = TP.summaryForTracker(plan, 'u1', NOW);
  ok('calls are people, follow-ups are promised + promises + estimates + stalled, jobs are appointments', s.calls === 2 && s.followUps === 6 && s.jobs === 1);
  ok('the summary has exactly these fields and nothing else', JSON.stringify(Object.keys(s).sort()) === '["asOf","calls","followUps","jobs","uid","v"]');
  ok('no names, phones or ids leak into the stored text', !/Pat|Smith|Jones|5135550001|p1|e1|s1/.test(JSON.stringify(s)));
  ok('stamped with the time and the signed-in uid', s.asOf === NOW && s.uid === 'u1' && s.v === 1);
  ok('a rule that threw publishes nothing, never a quiet zero (negative control)', TP.summaryForTracker(Object.assign({}, plan, { computeFailed: ['your calls list'] }), 'u1', NOW) === null);
  ok('no signed-in user publishes nothing', TP.summaryForTracker(plan, '', NOW) === null && TP.summaryForTracker(plan, null, NOW) === null);
  ok('no plan or no clock publishes nothing', TP.summaryForTracker(null, 'u1', NOW) === null && TP.summaryForTracker(plan, 'u1', 0) === null);
  const z = TP.summaryForTracker({}, 'u1', NOW);
  ok('an empty day is a real zero (all three 0)', z.calls === 0 && z.followUps === 0 && z.jobs === 0);
}

console.log('\n2. the tracker trusts only its own, fresh, well-formed summary');
{
  const r = B.read(good(), 'u1', NOW);
  ok('a good summary reads back its three numbers and its age', r.ok && r.calls === 3 && r.followUps === 5 && r.jobs === 2 && r.label === 'as of 7:40 am');
  ok('a summary for another account is ignored (negative control)', B.read(good({ uid: 'u2' }), 'u1', NOW).reason === 'other-account');
  ok('no signed-in uid reads nothing, even a valid summary', B.read(good(), '', NOW).reason === 'no-user' && B.read(good(), null, NOW).reason === 'no-user');
  ok('missing is missing', B.read(null, 'u1', NOW).reason === 'missing' && B.read('', 'u1', NOW).reason === 'missing');
  ok('corrupt JSON, arrays and wrong versions are bad', B.read('{nope', 'u1', NOW).reason === 'bad' && B.read('[1]', 'u1', NOW).reason === 'bad' && B.read(good({ v: 2 }), 'u1', NOW).reason === 'bad');
  ok('counts must be whole numbers 0-9999', ['-1', '1.5', '"3"', 'null', '10000'].every((c) => B.read(good().replace('"calls":3', '"calls":' + c), 'u1', NOW).reason === 'bad'));
  ok('over 12 hours old is stale, not shown as current', B.read(good({ asOf: NOW - 12 * 3600000 - 1 }), 'u1', NOW).reason === 'stale');
  ok('just under 12 hours old (same day) is still current', B.read(good({ asOf: new Date(2026, 9, 23, 0, 5).getTime() }), 'u1', new Date(2026, 9, 23, 11, 0).getTime()).ok === true);
  ok('over 12 hours old on the SAME day is stale too', B.read(good({ asOf: new Date(2026, 9, 23, 0, 5).getTime() }), 'u1', new Date(2026, 9, 23, 13, 0).getTime()).reason === 'stale');
  ok('yesterday evening is stale even inside 12 hours', B.read(good({ asOf: new Date(2026, 9, 22, 23, 50).getTime() }), 'u1', new Date(2026, 9, 23, 5, 0).getTime()).reason === 'stale');
  ok('a stamp from the future is bad (beyond a few minutes of clock skew)', B.read(good({ asOf: NOW + 3600000 }), 'u1', NOW).reason === 'bad' && B.read(good({ asOf: NOW + 60000 }), 'u1', NOW).ok === true);
  ok('stale and missing both say to open the CRM, never show numbers', /Open the CRM/.test(B.refreshText('stale')) && /Open the CRM/.test(B.refreshText('missing')));
  ok('the age label reads pm correctly', B.label(new Date(2026, 9, 23, 13, 5).getTime()) === 'as of 1:05 pm' && B.label(new Date(2026, 9, 23, 0, 7).getTime()) === 'as of 12:07 am');
}

console.log('\n3. the card (vm, faked clock and storage)');
{
  function run(stored, lastUid, thrower) {
    const store = Object.assign({}, stored || {});
    if (lastUid !== null) store.nbd_last_uid = lastUid || 'u1';
    const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
    const win = { todayKey: () => '2026-10-23', addEventListener() {}, NBDBusinessTile: B };
    const ctx = {
      window: win, Date: FakeDate, console, pages: [{ dk: '2026-10-23' }], cur: 0,
      document: { readyState: 'complete', addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; }, getElementById() { return null; } },
      localStorage: { getItem: (k) => { if (thrower) throw new Error('blocked'); return k in store ? store[k] : null; }, setItem() {} },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DS, 'js', 'business-tile-ui.js'), 'utf8'), ctx);
    return win.NBDBusinessTileUI.cardHtml();
  }
  const html = run({ nbd_today_summary: good() });
  ok('shows the three numbers and the age', /<b>3<\/b><span>people to call back/.test(html) && /<b>5<\/b><span>follow-ups due/.test(html) && /<b>2<\/b><span>jobs today/.test(html) && /as of 7:40 am/.test(html));
  ok('singular labels at 1', /person to call back/.test(run({ nbd_today_summary: good({ calls: 1, followUps: 1, jobs: 1 }) })) && /job today/.test(run({ nbd_today_summary: good({ jobs: 1 }) })));
  const other = run({ nbd_today_summary: good({ uid: 'someone-else' }) });
  ok('another account\'s summary shows no numbers (negative control)', !/bt-stat/.test(other) && /Open the CRM/.test(other));
  ok('stale shows no numbers, only the refresh line', !/bt-stat/.test(run({ nbd_today_summary: good({ asOf: NOW - 20 * 3600000 }) })) && /too old/.test(run({ nbd_today_summary: good({ asOf: NOW - 20 * 3600000 }) })));
  ok('missing storage: refresh line, no throw', !/bt-stat/.test(run({})) && /Open the CRM/.test(run({})));
  ok('storage that throws still renders the card (no numbers)', /Today's business/.test(run({ nbd_today_summary: good() }, 'u1', true)) && !/bt-stat/.test(run({ nbd_today_summary: good() }, 'u1', true)));
  function mountOn(pageDk) {
    const inserted = [];
    const bar = { parentNode: { insertBefore: (n) => inserted.push(n) }, nextSibling: null };
    const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } };
    const win = { todayKey: () => '2026-10-23', addEventListener() {}, NBDBusinessTile: B };
    const ctx = {
      window: win, Date: FakeDate, console, pages: [{ dk: pageDk }], cur: 0,
      document: { readyState: 'complete', addEventListener() {}, querySelectorAll() { return []; }, getElementById: (id) => (id === 'today-bar' ? bar : null), createElement: () => ({}) },
      localStorage: { getItem: (k) => (k === 'nbd_last_uid' ? 'u1' : k === 'nbd_today_summary' ? good() : null) },
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DS, 'js', 'business-tile-ui.js'), 'utf8'), ctx);
    win.NBDBusinessTileUI.mount();
    return inserted.length;
  }
  ok('the tile mounts on today\'s page', mountOn('2026-10-23') >= 1);
  ok('the tile never mounts on a past day (negative control)', mountOn('2026-10-22') === 0);
  ok('no recorded tracker uid: nothing trusted', !/bt-stat/.test(run({ nbd_today_summary: good() }, null)));
}

console.log('\n4. purge, scope and house rules');
{
  const KEEP_SRC = read('docs', 'pro', 'js', 'nbd-auth.js');
  const purgeBody = KEEP_SRC.slice(KEEP_SRC.indexOf('purgeAccountStorage() {'), KEEP_SRC.indexOf('purgeSmsOutbox() {'));
  const keepList = purgeBody.slice(purgeBody.indexOf('const KEEP = new Set(['), purgeBody.indexOf(']);', purgeBody.indexOf('const KEEP = new Set([')));
  ok('the summary key starts with nbd_, so the sign-out and account-switch purge removes it', /^nbd_/.test(B.KEY) && /\/\^\(nbd\[_-\]\|nav-\)\/\.test\(k\)/.test(purgeBody));
  ok('the summary key is NOT in the purge keep-list (it is customer-derived account data)', keepList.indexOf(B.KEY) === -1);
  // run the real purge loop against a fake storage holding the summary and a kept key
  {
    const store = { [B.KEY]: good(), nbd_last_uid: 'u1', nbd_theme: 'x' };
    const ctx = { localStorage: { get length() { return Object.keys(store).length; }, key: (i) => Object.keys(store)[i], removeItem: (k) => { delete store[k]; } }, window: {}, console };
    vm.createContext(ctx);
    const m = purgeBody.match(/const KEEP = new Set\(\[[\s\S]*?\]\);\n\s*const drop = \[\];[\s\S]*?drop\.forEach\([^\n]*\n/);
    vm.runInContext(m[0], ctx);
    ok('running the real purge removes the summary and keeps device preferences', !(B.KEY in store) && 'nbd_theme' in store && 'nbd_last_uid' in store);
  }
  const ui = stripComments(read('docs', 'pro', 'daily-success', 'js', 'business-tile-ui.js'));
  const lg = stripComments(read('docs', 'pro', 'daily-success', 'js', 'business-tile-logic.js'));
  ok('the tracker side has no Firestore, network or auth code', !/firebase|firestore|fetch\(|XMLHttpRequest|getDoc|onSnapshot/i.test(ui + lg));
  ok('every storage read in the tracker is try/catch wrapped', /const store = \(k\) => \{ try \{ return localStorage\.getItem\(k\); \} catch/.test(ui) && !/localStorage/.test(lg));
  ok('no inline handlers, no body.className', !/\son[a-z]+=/i.test(ui) && !/body\.className\s*=/.test(ui));
  const home = stripComments(read('docs', 'pro', 'js', 'today-home.js'));
  const pub = home.slice(home.indexOf('function publishToTracker'), home.indexOf('function btn('));
  ok('the CRM write is one small function, guarded on every read having answered', /_leadsLoaded !== true/.test(pub) && /appts\.failed/.test(pub) && /appts\.checking/.test(pub) && (home.match(/nbd_today_summary/g) || []).length === 1);
  ok('the CRM write is called once, from the plan build', (home.match(/publishToTracker\(plan_\)/g) || []).length === 1);
  const idx = read('docs', 'pro', 'daily-success', 'index.html');
  ok('scripts load with defer and the stylesheet is linked', /business-tile-logic\.js\?v=\d+" defer/.test(idx) && /business-tile-ui\.js\?v=\d+" defer/.test(idx) && /css\/business-tile\.css/.test(idx));
  const styles = idx.match(/<style[\s\S]*?<\/style>/g);
  ok('phone rules sit in the LAST style block', /\.bt-stat b\{/.test(styles[styles.length - 1]) && !styles.slice(0, -1).some((b) => /\.bt-stat b\{/.test(b)));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
