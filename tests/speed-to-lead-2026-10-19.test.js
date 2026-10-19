/**
 * tests/speed-to-lead-2026-10-19.test.js
 *
 * "Speed to lead" (docs/pro/js/speed-to-lead.js, flag speedToLead). Pins:
 *   1. the pure logic: waiting list, median / p90 by source over 30 days,
 *      unstamped leads counted separately and never as slow, stamp / undo patches;
 *   2. call matching: outbound only, same customer (leadId, else phone), at or
 *      after the lead was created, inside the window, earliest wins, and a lead
 *      that already has a stamp is never re-stamped;
 *   3. the REAL module in a vm sandbox: flag off renders / reads / writes nothing
 *      (with a flag-on positive control), the one tap stamps through a transaction
 *      only while unstamped, Undo clears only a manual stamp;
 *   4. the inbox stops the "nobody has been in touch" timer once a reply is on file;
 *   5. source guards (comments stripped): nothing is sent, no messaging code,
 *      no inline handlers, flag name, markup wiring.
 *
 * Synthetic data only (public repo): ZZ_QA ids.
 * Run: node tests/speed-to-lead-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/speed-to-lead.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const CODE = strip(SRC);

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setImmediate(r));

const P = require(SRC_PATH);
const MIN = 60000, DAY = 86400000;
const NOW = Date.UTC(2026, 9, 19, 15, 0, 0);
const ago = (ms) => NOW - ms;
const mk = (id, over) => Object.assign({
  id, firstName: 'ZZ_QA', lastName: id, source: 'Thumbtack', stage: 'new', _stageKey: 'new',
  createdAt: ago(60 * MIN), phone: '(555) 010-0001',
}, over || {});

// ── 1. pure logic ────────────────────────────────────────────────────────
console.log('waiting list');
{
  const leads = [
    mk('a_new'), mk('b_newer', { createdAt: ago(10 * MIN) }),
    mk('c_old', { createdAt: ago(8 * DAY) }),
    mk('d_stamped', { firstRespondedAt: ago(5 * MIN) }),
    mk('e_contacted', { stage: 'contacted', _stageKey: 'contacted' }),
    mk('f_deleted', { deleted: true }), mk('g_prospect', { isProspect: true }),
    mk('h_nodate', { createdAt: undefined }),
    mk('i_future', { createdAt: NOW + 5 * MIN }),
    mk('j_nullstamp', { firstRespondedAt: null }),
  ];
  const w = P.waitingLeads(leads, { now: NOW });
  const ids = w.map((r) => r.id).join();
  ok('new leads from the last 7 days with no stamp, newest first', ids.split(',').length === 3 && ids.split(',')[0] === 'b_newer' && /a_new/.test(ids) && /j_nullstamp/.test(ids), ids);
  ok('stamped, old, other-stage, deleted, prospect, undated and future leads are left out', !/c_old|d_stamped|e_contacted|f_deleted|g_prospect|h_nodate|i_future/.test(ids), ids);
  ok('a null stamp still counts as waiting', /j_nullstamp/.test(ids));
  ok('canChange filters leads the user may not edit', P.waitingLeads(leads, { now: NOW }, { canChange: (l) => l.id !== 'a_new' }).every((r) => r.id !== 'a_new'));
  ok('default channel follows the source', P.guessChannel({ source: 'Thumbtack' }) === 'thumbtack' && P.guessChannel({ source: 'Yelp Leads' }) === 'yelp' && P.guessChannel({ source: 'Google' }) === 'text' && P.guessChannel({}) === 'text');
}
console.log('summary: median / p90 by source, unstamped separate');
{
  const at = (min) => ago(2 * DAY) + min * MIN;       // stamp `min` minutes after a lead created 2 days ago
  const base = ago(2 * DAY);
  const L = (id, source, min) => mk(id, { source, createdAt: base, firstRespondedAt: min == null ? undefined : at(min) });
  const leads = [
    L('t1', 'Thumbtack', 5), L('t2', 'Thumbtack', 15), L('t3', 'Thumbtack', 25), L('t4', 'Thumbtack', 45),
    L('t5', 'Thumbtack', null), L('t6', 'Thumbtack', null),
    L('y1', 'Yelp', 120), L('y2', 'yelp', 600),
    L('g1', 'Google', null),
    mk('old', { source: 'Thumbtack', createdAt: ago(45 * DAY), firstRespondedAt: ago(45 * DAY) + MIN }),   // outside 30 days
    mk('del', { source: 'Thumbtack', deleted: true, createdAt: base, firstRespondedAt: at(1) }),
    mk('pre', { source: 'Thumbtack', createdAt: base, firstRespondedAt: base - 10 * MIN }),               // stamp before created
  ];
  const s = P.summarize(leads, { now: NOW });
  const tt = s.rows.find((r) => r.source === 'Thumbtack');
  ok('Thumbtack: 5 stamped (incl. the clamped one), 2 unstamped', tt.stamped === 5 && tt.unstamped === 2 && tt.total === 7, JSON.stringify(tt));
  ok('median of 0,5,15,25,45 is 15; p90 (nearest rank) is 45', tt.medianMin === 15 && tt.p90Min === 45, JSON.stringify(tt));
  ok('a stamp before createdAt reads as 0 minutes, not negative', P.summarize([mk('p', { createdAt: base, firstRespondedAt: base - MIN })], { now: NOW }).all.medianMin === 0);
  const yy = s.rows.find((r) => r.source.toLowerCase() === 'yelp');
  ok('source names merge case-insensitively; even count averages the middle two', yy.stamped === 2 && yy.medianMin === 360, JSON.stringify(yy));
  const gg = s.rows.find((r) => r.source === 'Google');
  ok('a source with no stamps has no median or p90 and is NOT treated as slow', gg.stamped === 0 && gg.unstamped === 1 && gg.medianMin === null && gg.p90Min === null);
  ok('unstamped leads never move the median (adding 20 of them changes nothing)',
    P.summarize(leads.concat(Array.from({ length: 20 }, (_, i) => L('u' + i, 'Thumbtack', null))), { now: NOW }).rows.find((r) => r.source === 'Thumbtack').medianMin === 15);
  ok('leads older than 30 days and deleted leads are not counted', s.all.total === 10, JSON.stringify(s.all));
  ok('rows are biggest source first', s.rows[0].source === 'Thumbtack');
  ok('fmtMin', P.fmtMin(null) === '—' && P.fmtMin(0) === '0 min' && P.fmtMin(12) === '12 min' && P.fmtMin(65) === '1h 5m' && P.fmtMin(60 * 26) === '1d 2h');
  ok('percentile of an empty list is null', P.percentile([], 0.9) === null && P.median([]) === null);
}
console.log('stamp / undo patches');
{
  const p = P.stampPatch('yelp', 'TS');
  ok('stamp patch carries time, channel and a manual source', p.firstRespondedAt === 'TS' && p.firstRespondedChannel === 'yelp' && p.firstRespondedSource === 'manual');
  ok('an unknown channel falls back to other', P.stampPatch('carrier-pigeon', 'TS').firstRespondedChannel === 'other');
  ok('canStamp only while unstamped (null / absent / 0 all unstamped)', P.canStamp({}) && P.canStamp({ firstRespondedAt: null }) && P.canStamp({ firstRespondedAt: 0 }) && !P.canStamp({ firstRespondedAt: 5 }) && !P.canStamp(null));
  ok('undo clears a manual stamp of the same channel', P.undoPatch({ firstRespondedAt: 5, firstRespondedSource: 'manual', firstRespondedChannel: 'text' }, 'text').firstRespondedAt === null);
  ok('undo leaves a call-match stamp alone', P.undoPatch({ firstRespondedAt: 5, firstRespondedSource: 'call-match', firstRespondedChannel: 'call' }, 'call') === null);
  ok('undo leaves a lead alone that is no longer stamped or was re-stamped on another channel', P.undoPatch({}, 'text') === null && P.undoPatch({ firstRespondedAt: 5, firstRespondedSource: 'manual', firstRespondedChannel: 'yelp' }, 'text') === null);
}

// ── 2. call matching ─────────────────────────────────────────────────────
console.log('call matching');
{
  const lead = mk('ZZ_QA_L', { createdAt: ago(3 * 60 * MIN) });
  const call = (id, over) => Object.assign({ id, direction: 'outbound', channel: 'call', startedAtMs: ago(2 * 60 * MIN), phoneDigits: '5550100001', leadId: null }, over || {});
  ok('an outbound call to the lead phone after creation matches', P.matchCall(lead, [call('c1')]).startedAtMs === ago(2 * 60 * MIN));
  ok('matches by the call leadId even if the number differs', P.matchCall(lead, [call('c2', { leadId: 'ZZ_QA_L', phoneDigits: '5559999999' })]) !== null);
  ok('an inbound call is not a response', P.matchCall(lead, [call('c3', { direction: 'inbound' })]) === null);
  ok('a text day row is not a call', P.matchCall(lead, [call('c4', { channel: 'text' })]) === null);
  ok('a call BEFORE the lead existed is not the first response', P.matchCall(lead, [call('c5', { startedAtMs: ago(4 * 60 * MIN) })]) === null);
  ok('a call more than 14 days later is not the first response', P.matchCall(lead, [call('c6', { startedAtMs: lead.createdAt + 15 * DAY })]) === null);
  ok('a call filed to a different lead does not match by phone', P.matchCall(lead, [call('c7', { leadId: 'ZZ_QA_OTHER' })]) === null);
  ok('a different number does not match', P.matchCall(lead, [call('c8', { phoneDigits: '5550109999' })]) === null);
  const first = P.matchCall(lead, [call('late', { startedAtMs: ago(60 * MIN) }), call('early', { startedAtMs: ago(150 * MIN) })]);
  ok('the earliest qualifying call wins', first.id === 'early');
  ok('country-code and formatting variants of the phone still match', P.matchCall(mk('ZZ_QA_F', { createdAt: ago(3 * 60 * MIN), phone: '+1 (555) 010-0001' }), [call('c9')]) !== null);
  ok('a lead with no createdAt is never matched', P.matchCall(mk('ZZ_QA_N', { createdAt: undefined }), [call('c10')]) === null);

  const plan = P.planCallMatches([
    mk('p1', { createdAt: ago(3 * 60 * MIN) }),                                              // unstamped, has a call
    mk('p2', { createdAt: ago(3 * 60 * MIN), firstRespondedAt: ago(100 * MIN) }),             // already stamped: never re-stamped
    mk('p3', { createdAt: ago(3 * 60 * MIN), phone: '(555) 010-7777' }),                      // no call
    mk('p4', { createdAt: ago(40 * DAY) }),                                                  // older than 30 days
  ], [call('c11')], { now: NOW });
  ok('the plan holds only unstamped, recent leads that have a call', plan.length === 1 && plan[0].id === 'p1' && plan[0].callId === 'c11', JSON.stringify(plan));
  const mp = P.matchPatch(plan[0]);
  ok('the match patch uses the call start time, channel call, source call-match', mp.firstRespondedAt.getTime() === ago(2 * 60 * MIN) && mp.firstRespondedChannel === 'call' && mp.firstRespondedSource === 'call-match');
  ok('the plan is capped per run', P.planCallMatches(Array.from({ length: 80 }, (_, i) => mk('m' + i, { createdAt: ago(3 * 60 * MIN) })), [call('c12')], { now: NOW }).length === 50);
}

// ── 3. the real module in a sandbox ──────────────────────────────────────
function boot(opts) {
  opts = opts || {};
  const handlers = {};
  const created = [];
  const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
  const btn = { id: 'speedToLeadBtn', hidden: true, getAttribute() { return null; } };
  btn.closest = () => btn;
  const badge = { id: 'speedToLeadBadge', hidden: true, textContent: '' };
  const document = {
    readyState: 'complete', body,
    getElementById: (id) => (id === 'speedToLeadBtn' ? btn : id === 'speedToLeadBadge' ? badge : null),
    createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, remove() { body.removeChild(n); } }; created.push(n); return n; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
  };
  const txWrites = [], reads = [];
  const stored = {};
  (opts.leads || []).forEach((l) => { stored[l.id] = Object.assign({}, l); });
  const win = {
    document, _leads: opts.leads || [], _userClaims: opts.claims || { role: 'owner' }, _user: { uid: 'u1' },
    NBDFlags: { enabled: (n) => !!opts.flag && n === 'speedToLead', load: () => Promise.resolve() },
    addEventListener() {}, dispatchEvent() {}, showToast() {},
    db: {}, doc: (db, c, id) => ({ c, id }), collection: (db, c) => ({ c }),
    query: (c) => c, where: () => ({}), orderBy: () => ({}), limit: () => ({}),
    getDocs: async (q) => { reads.push(q.c); return { docs: (opts.calls || []).map((c) => ({ id: c.id, data: () => c })) }; },
    serverTimestamp: () => new Date(NOW),
    runTransaction: async (db, fn) => fn({
      get: async (ref) => ({ exists: () => !!stored[ref.id], data: () => stored[ref.id] }),
      update: (ref, patch) => { txWrites.push({ id: ref.id, patch }); Object.assign(stored[ref.id], patch); },
    }),
  };
  const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Set, Math, JSON, parseInt, String, Object, Array, isFinite, CustomEvent: function () {} };
  win.window = win; win.CustomEvent = ctx.CustomEvent;
  vm.runInNewContext(SRC, ctx, { filename: 'speed-to-lead.js' });
  const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
  const clickAct = (act, id) => { const t = { id: '', getAttribute: (n) => (n === 'data-stl-act' ? act : n === 'data-stl-id' ? id : null) }; t.closest = () => t; fire('click', { target: t, preventDefault() {} }); };
  const clickBtn = () => fire('click', { target: btn, preventDefault() {} });
  const pickChannel = (id, value) => fire('change', { target: { value, getAttribute: (n) => (n === 'data-stl-ch' ? id : null) } });
  return { win, created, body, btn, badge, txWrites, reads, stored, clickAct, clickBtn, pickChannel, overlay: () => created[0] };
}
const fresh = () => [mk('ZZ_QA_1', { userId: 'u1' }), mk('ZZ_QA_2', { userId: 'u1', source: 'Yelp' })];

(async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    console.log('flag off renders, reads and writes nothing');
    {
      const e = boot({ flag: false, leads: fresh(), calls: [{ id: 'c', direction: 'outbound', startedAtMs: ago(30 * MIN), phoneDigits: '5550100001' }] });
      e.win.NBDSpeedToLead.sync();
      ok('toolbar button stays hidden, no badge', e.btn.hidden === true && e.badge.hidden === true);
      ok('open() refuses and nothing mounts', e.win.NBDSpeedToLead.open() === false && e.created.length === 0);
      e.clickBtn(); e.clickAct('replied', 'ZZ_QA_1');
      const n = await e.win.NBDSpeedToLead.matchCalls();
      ok('no call read, no write, no match', n === 0 && e.reads.length === 0 && e.txWrites.length === 0);
    }
    {
      const e = boot({ flag: true, claims: { role: 'viewer' }, leads: fresh() });
      e.win.NBDSpeedToLead.sync();
      ok('flag on but viewer: hidden, refuses, nothing written', e.btn.hidden === true && e.win.NBDSpeedToLead.open() === false && e.txWrites.length === 0);
    }
    console.log('flag on (positive control): the one tap');
    {
      const e = boot({ flag: true, leads: fresh() });
      e.win.NBDSpeedToLead.sync();
      ok('button shows with the waiting count', e.btn.hidden === false && e.badge.textContent === '2' && e.badge.hidden === false);
      e.clickBtn();
      let h = e.overlay().innerHTML;
      ok('panel lists each waiting lead with a Replied button and a channel choice', e.created.length === 1 && (h.match(/data-stl-act="replied"/g) || []).length === 2 && /data-stl-ch="ZZ_QA_1"/.test(h));
      ok('the Thumbtack lead defaults to the Thumbtack channel, the Yelp one to Yelp', /data-stl-ch="ZZ_QA_1"[^>]*>(?:(?!<\/select>).)*<option value="thumbtack" selected/.test(h) && /data-stl-ch="ZZ_QA_2"[^>]*>(?:(?!<\/select>).)*<option value="yelp" selected/.test(h));
      ok('nothing was written just by opening it', e.txWrites.length === 0);
      e.pickChannel('ZZ_QA_1', 'call');
      e.clickAct('replied', 'ZZ_QA_1');
      await tick(); await tick();
      ok('one write, in a transaction, only to the tapped lead', e.txWrites.length === 1 && e.txWrites[0].id === 'ZZ_QA_1');
      const w = e.txWrites[0].patch;
      ok('it stamps a server time, the chosen channel and a manual source', w.firstRespondedAt.getTime() === NOW && w.firstRespondedChannel === 'call' && w.firstRespondedSource === 'manual', JSON.stringify(w));
      ok('it writes nothing else (no stage, no note, no message)', Object.keys(w).sort().join() === 'firstRespondedAt,firstRespondedChannel,firstRespondedSource');
      h = e.overlay().innerHTML;
      ok('the lead leaves the waiting list and Undo appears', !/data-stl-id="ZZ_QA_1"/.test(h) && /data-stl-act="undo"/.test(h) && e.badge.textContent === '1');
      e.clickAct('undo');
      await tick(); await tick();
      ok('Undo clears the manual stamp', e.stored.ZZ_QA_1.firstRespondedAt === null && e.stored.ZZ_QA_1.firstRespondedChannel === null);
      ok('the lead is waiting again', /data-stl-id="ZZ_QA_1"/.test(e.overlay().innerHTML));
    }
    console.log('never overwrites an existing stamp');
    {
      const leads = fresh();
      const e = boot({ flag: true, leads });
      e.clickBtn();
      e.stored.ZZ_QA_1.firstRespondedAt = 12345;          // stamped elsewhere (another device / a call match) after the list was drawn
      e.clickAct('replied', 'ZZ_QA_1');
      await tick(); await tick();
      ok('the transaction sees the stamp and writes nothing', e.txWrites.length === 0 && e.stored.ZZ_QA_1.firstRespondedAt === 12345);
      ok('the panel says it was left alone', /left alone/.test(e.overlay().innerHTML));
    }
    console.log('automatic call matching');
    {
      const calls = [
        { id: 'c1', direction: 'outbound', channel: 'call', startedAtMs: ago(30 * MIN), phoneDigits: '5550100001', leadId: 'ZZ_QA_1' },
        { id: 'c2', direction: 'inbound', channel: 'call', startedAtMs: ago(20 * MIN), phoneDigits: '5550100001', leadId: 'ZZ_QA_2' },
        { id: 'c3', direction: 'outbound', channel: 'call', startedAtMs: ago(10 * MIN), phoneDigits: '5550100004', leadId: null },
      ];
      const leads = [mk('ZZ_QA_1', { userId: 'u1' }), mk('ZZ_QA_2', { userId: 'u1', phone: '(555) 010-0002' }), mk('ZZ_QA_3', { userId: 'u1', firstRespondedAt: ago(50 * MIN), phone: '(555) 010-0001' }), mk('ZZ_QA_4', { userId: 'u2', phone: '(555) 010-0004' })];
      const e = boot({ flag: true, leads, calls });
      const n = await e.win.NBDSpeedToLead.matchCalls();
      ok('reads phone_calls and stamps exactly the one lead with an outbound call', n === 1 && e.reads[0] === 'phone_calls' && e.txWrites.length === 1 && e.txWrites[0].id === 'ZZ_QA_1', JSON.stringify(e.txWrites));
      const p = e.txWrites[0].patch;
      ok('the stamp is the call time with channel call and source call-match', p.firstRespondedAt.getTime() === ago(30 * MIN) && p.firstRespondedChannel === 'call' && p.firstRespondedSource === 'call-match' && p.firstRespondedCallId === 'c1');
      ok('the inbound-call lead and the already-stamped lead are untouched', !('firstRespondedAt' in e.stored.ZZ_QA_2) && e.stored.ZZ_QA_3.firstRespondedAt === ago(50 * MIN));
      ok('a lead the signed-in user may not edit (another owner) is not stamped', !('firstRespondedAt' in e.stored.ZZ_QA_4));
      const again = await e.win.NBDSpeedToLead.matchCalls();
      ok('a second run is a no-op', again === 0 && e.txWrites.length === 1);
      e.stored.ZZ_QA_2.firstRespondedAt = null;
    }
  } finally { Date.now = realNow; }

  // ── 4. the inbox timer stops once a reply is on file ───────────────────
  console.log('inbox');
  {
    const L = require(path.join(ROOT, 'docs/pro/js/layouts/inbox.js'));
    const base = { now: NOW, groups: [], estimateRows: [], plan: {}, aiDrafts: [], agentDrafts: [] };
    const a = L.buildItems(Object.assign({}, base, { leads: [mk('ZZ_QA_W', { createdAt: ago(20 * MIN) })] }));
    ok('control: an unstamped new lead is on the inbox with a timer', a.length === 1 && a[0].timer && /^(red|gold|green)$/.test(a[0].timer.state), JSON.stringify(a.map((x) => x.key)));
    const b = L.buildItems(Object.assign({}, base, { leads: [mk('ZZ_QA_W', { createdAt: ago(20 * MIN), firstRespondedAt: new Date(ago(5 * MIN)) })] }));
    ok('a lead with a reply on file no longer shows "nobody has been in touch"', b.length === 0, JSON.stringify(b.map((x) => x.key)));
    const c = L.buildItems(Object.assign({}, base, { leads: [mk('ZZ_QA_W', { createdAt: ago(20 * MIN), firstRespondedAt: null })] }));
    ok('a null stamp (after Undo) puts it back', c.length === 1);
  }

  // ── 5. source guards ──────────────────────────────────────────────────
  console.log('source guards');
  ok('flag name', /var FLAG = 'speedToLead'/.test(CODE) && P.FLAG === 'speedToLead');
  ok('never sends: no sms / email / fetch / XHR / callable / mailto / tel / sendBeacon', !/\b(sms|email|mailto|sendBeacon|XMLHttpRequest|httpsCallable|twilio|resend)\b|\bfetch\s*\(|href\s*=\s*['"](?:tel|sms):/i.test(CODE), (CODE.match(/\b(sms|email|mailto|sendBeacon|XMLHttpRequest|httpsCallable|twilio|resend)\b|\bfetch\s*\(/i) || [])[0]);
  ok('touches no messaging collections or modules', !/sms_log|email_log|alert_outbox|messaging|phone_text_days|outbox/i.test(CODE));
  ok('no delete, no deleted flag, no raw batch write, no addDoc', !/deleteDoc|\bdeleted\s*:|writeBatch|addDoc|setDoc/.test(CODE));
  ok('only writes through a transaction', /runTransaction/.test(CODE) && !/updateDoc/.test(CODE));
  ok('no inline handlers or script injection in the markup it builds', !/\son[a-z]+\s*=/i.test(CODE) && !/createElement\(['"]script/.test(CODE));
  ok('dashboard loads it deferred, once, with its stylesheet and a hidden toolbar button',
    (fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8').match(/<script defer src="js\/speed-to-lead\.js\?v=1"><\/script>/g) || []).length === 1 &&
    /href="css\/speed-to-lead\.css/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8')) &&
    /id="speedToLeadBtn"[^>]*\shidden/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8')));
  ok('phone-fit CSS: 44px targets and a narrow-width block', /min-height: 44px/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/css/speed-to-lead.css'), 'utf8')) && /@media \(max-width: 480px\)/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/css/speed-to-lead.css'), 'utf8')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
