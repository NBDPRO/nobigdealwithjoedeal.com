/**
 * tests/nbd-os-p2-integration-2026-11-09.test.js - NBD OS P2, where the six lanes meet.
 *
 * Each P2 lane (Activities, runner, peek, Coach AI, Team, P1 fixes) was built alone on
 * c67983361. This suite pins what only shows once they are together:
 *   1. "In a home" (privacy) never paints the owner's Team widget (it names teammates) and
 *      never loads its bundle or reads the leaderboard
 *   2. "In a home" never shows the Coach's AI focus line (no oscoachai load, no button)
 *   3. "In a home" never offers a Peek at an appointment whose customer the mode hides
 *      (the sheet shows name, address and notes); the current customer's Peek stays
 *   4. "In a home" never opens the Welcome Recap (it lists carried leads by name); it is
 *      asked again once the mode is off
 *   5. the action runner lists the Activities' Spotlight actions ("Switch to <mode>")
 *
 * Run: node tests/nbd-os-p2-integration-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, text, NOW } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 500) : '')); }
}
const J = (v) => JSON.stringify(v);
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
async function G(fn) { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } }

const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));

const LEADS = [
  { id: 'L1', firstName: 'Pat', lastName: 'Customer', stage: 'inspected' },
  { id: 'L2', firstName: 'Ivy', lastName: 'Inbound', stage: 'new', notes: 'Gate code 4411' },
];
/** Pat's appointment started 30 min ago (the current one); Ivy's starts in 20 min (the Peek window). */
function plan() {
  const p = H.plan();
  p.appointments = [
    { key: 'appt:1', name: 'Pat Customer', title: 'Inspection - Pat', leadId: 'L1', address: '12 Oak St', timeLabel: '1:30 PM', sortMs: NOW - 30 * 60000, allDay: false },
    { key: 'appt:2', name: 'Ivy Inbound', title: 'Inspection - Ivy', leadId: 'L2', address: '905 Elm St', timeLabel: '2:20 PM', sortMs: NOW + 20 * 60000, allDay: false },
  ];
  return p;
}

function loader(T) {
  const W = T.W;
  W.bundleLoads = [];
  W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      W.bundleLoads.push(name);
      (this.bundles[name] || []).forEach((src) => {
        if (/\.css(\?|$)/.test(src)) return;
        const f = 'docs/pro/' + String(src).replace(/\?.*$/, '');
        vm.runInContext(read(f), W, { filename: f });
      });
      return Promise.resolve();
    },
  };
}
function win(o) {
  const opts = Object.assign({ surface: 'phone', plan: plan(), leads: LEADS, stageRole: () => 'active', claims: { role: 'owner', companyId: 'u1' }, uid: 'u1' }, o || {});
  const T = makeWin(opts);
  loader(T);
  const W = T.W;
  W.reads = [];
  W.firebase = W.firebase || {};
  W.db = {};
  W.getDocs = () => { W.reads.push('getDocs'); return Promise.resolve({ docs: [], forEach() {} }); };
  W._companyProfile = { coachAiEnabled: true };
  W.cmd = [];
  W.NBDCommand = { open() {}, registerAction(a) { W.cmd = W.cmd.filter((x) => x.id !== a.id).concat([a]); }, unregisterAction(id) { W.cmd = W.cmd.filter((x) => x.id !== id); } };
  W._impl.mount({ surface: opts.surface });
  return T;
}
const phoneEl = (T) => T.document.getElementById('osPhone');
const teamCard = (T) => / teamboard-\d/.test(attrs(phoneEl(T)));
const attrs = (el) => { let h = ''; (function walk(n) { (n.children || []).forEach((c) => { if (c.attrs) { h += ' ' + Object.keys(c.attrs).map((k) => c.attrs[k]).join(' '); walk(c); } }); })(el); return h; };
function homeWith(widgets, on) {
  return { v: 1, phone: widgets, acts: [{ id: 'inhome', name: 'In a home', focus: { privacy: true }, phone: widgets }], on: on === false ? {} : { phone: 'inhome' } };
}

(async () => {
  console.log('\n1. "In a home" hides the owner\'s Team widget');
  await G(async () => {
    ok('home-logic: a privacy focus hides teamboard (it names teammates)', HL.actHides({ privacy: true }, 'teamboard') === true);
    ok('...and still hides Money', HL.actHides({ privacy: true }, 'money') === true);
    ok('...but no mode hides nothing', HL.actHides(null, 'teamboard') === false);
    const T = win({ home: homeWith([{ id: 'glance', s: 'm' }, { id: 'teamboard', s: 'm' }]) });
    await flush();
    const t = text(phoneEl(T));
    ok('no Team card is painted in the mode', !teamCard(T), t.slice(0, 300));
    ok('the osteam bundle is never loaded and nothing is read', T.W.bundleLoads.indexOf('osteam') === -1 && T.W.reads.length === 0, J(T.W.bundleLoads));
    // the first paint runs inside the home's mount: it already uses the mode's own widgets
    const own = { v: 1, phone: [{ id: 'teamboard', s: 'm' }, { id: 'upnext', s: 'l' }], acts: [{ id: 'inhome', name: 'In a home', focus: { privacy: true }, phone: [{ id: 'glance', s: 'm' }] }], on: { phone: 'inhome' } };
    const F = win({ home: own });
    await flush();
    ok('a home whose own widgets include Team, with "In a home" on: Team is never painted, loaded or read, even at mount',
      !teamCard(F) && F.W.bundleLoads.indexOf('osteam') === -1 && F.W.reads.length === 0, J(F.W.bundleLoads));
    ok('...nor the Peek bundle or Ivy\'s name from the own home\'s Up Next', F.W.bundleLoads.indexOf('osp2peek') === -1 && !/Ivy/.test(text(phoneEl(F)) + attrs(phoneEl(F))));
    const C = win({ home: homeWith([{ id: 'glance', s: 'm' }, { id: 'teamboard', s: 'm' }], false) });
    await flush();
    ok('control: with the mode off the owner\'s Team card is painted', teamCard(C), text(phoneEl(C)).slice(0, 300));
  });

  console.log('\n2. "In a home" hides the Coach\'s AI focus line');
  await G(async () => {
    const T = win({ home: homeWith([{ id: 'coach', s: 'l' }]) });
    await flush();
    ok('no AI focus button in the Coach', !phoneEl(T).querySelector('[data-oshw-coach="ai"]'), attrs(phoneEl(T)).slice(0, 400));
    ok('the oscoachai bundle is never loaded', T.W.bundleLoads.indexOf('oscoachai') === -1, J(T.W.bundleLoads));
    const C = win({ home: homeWith([{ id: 'coach', s: 'l' }], false) });
    await flush();
    ok('control: with the mode off an opted-in Coach loads the AI line bundle', C.W.bundleLoads.indexOf('oscoachai') !== -1, J(C.W.bundleLoads));
  });

  console.log('\n3. "In a home" never offers a Peek at a hidden customer');
  await G(async () => {
    const T = win({ home: homeWith([{ id: 'upnext', s: 'l' }]) });
    await flush();
    const el = phoneEl(T);
    ok('no Peek button for Ivy\'s appointment (not the current customer)', !el.querySelector('[data-oshw-peek]'), attrs(el).slice(0, 400));
    ok('no Ivy, no Elm St in the text or the attributes', !/Ivy|Elm/.test(text(el) + attrs(el)), (text(el) + attrs(el)).slice(0, 400));
    const C = win({ home: homeWith([{ id: 'upnext', s: 'l' }], false) });
    await flush();
    ok('control: with the mode off Up Next offers the Peek', !!phoneEl(C).querySelector('[data-oshw-peek="appt:2"]'));
    const P = plan();
    P.appointments = [P.appointments[1]];   // Ivy alone: the next under an hour away is the current one
    const S = win({ plan: P, home: homeWith([{ id: 'upnext', s: 'l' }]) });
    await flush();
    ok('the current customer\'s appointment keeps its Peek in the mode', !!phoneEl(S).querySelector('[data-oshw-peek="appt:2"]'), attrs(phoneEl(S)).slice(0, 400));
  });

  console.log('\n4. "In a home" never opens the Welcome Recap');
  await G(async () => {
    const y = HL.dayKey(NOW - 86400000);
    const carry = J({ v: 1, uid: 'u1', dk: y, leads: ['L2'], visits: [], promises: [] });
    ok('seed: the recap is due', HL.recapDue(carry, null, 'u1', NOW) === true);
    const T = win({ store: { nbd_os_carry: carry }, home: homeWith([{ id: 'glance', s: 'm' }]) });
    await flush();
    ok('in the mode the recap bundle is not loaded and no dialog opens', T.W.bundleLoads.indexOf('osp2peek') === -1 && !T.document.querySelector('dialog'), J(T.W.bundleLoads));
    const C = win({ store: { nbd_os_carry: carry }, home: homeWith([{ id: 'glance', s: 'm' }], false) });
    await flush();
    ok('control: with the mode off the recap loads', C.W.bundleLoads.indexOf('osp2peek') !== -1, J(C.W.bundleLoads));
  });

  console.log('\n5. the runner lists the Activities\' Spotlight actions');
  await G(async () => {
    const RUN = read('docs/pro/js/command-runner.js');
    const PAL = read('docs/pro/js/command-palette.js');
    ok('the palette keeps registerAction / unregisterAction (Activities registers its modes there)', /function registerAction\(/.test(PAL) && /function unregisterAction\(/.test(PAL));
    ok('the runner gets the palette\'s action list (augment), so "Switch to <mode>" is searchable and a Quick Key target', /augment/.test(PAL) && /actions/.test(RUN));
    const T = win({ home: homeWith([{ id: 'glance', s: 'm' }]) });
    await flush();
    ok('the layout registers "Switch to In a home" and "Turn mode off"', T.W.cmd.some((a) => a.label === 'Switch to In a home') && T.W.cmd.some((a) => a.label === 'Turn mode off'), J(T.W.cmd.map((a) => a.label)));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
