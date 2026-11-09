/**
 * tests/nbd-os-acts-2026-11-09.test.js - NBD OS P2, Activities and Focus modes
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md section 6.3, uncommon #3).
 *
 * Pure logic, plain Node:
 *   docs/pro/js/os/home-logic.js   the stored shape: layoutState['os-home'].acts (at most 4 named modes,
 *                                  each { id, name, focus, phone?, desk?, wp? }) and .on ({ phone, desk }:
 *                                  which mode is on), kept through every existing key op, counted in the
 *                                  12,000-char max fill; activeAct / setActOn / renameAct / setActList /
 *                                  setActWp; actHides (what "In a home" never paints)
 *   docs/pro/js/os/acts-logic.js   the focus lens (the osacts bundle): a lead's job phase from its tenant
 *                                  stage role, the current appointment, the Today plan filtered to a phase
 *                                  and stripped of every other customer's name, phone and street in
 *                                  "In a home", the storm offer (an offer, never a switch)
 *
 * Run: node tests/nbd-os-acts-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
function done() { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(failed ? 1 : 0); }

const H = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const AL_FILE = path.join(ROOT, 'docs/pro/js/os/acts-logic.js');
let AL = null;
try { AL = require(AL_FILE); } catch (e) { AL = null; }

console.log('\n1. the presets: four modes, a phone face and a laptop face each');
ok('home-logic has the Activities API', ['activeAct', 'setActOn', 'renameAct', 'setActList', 'setActWp', 'actsOf', 'actHides'].every((f) => typeof H[f] === 'function'),
  ['activeAct', 'setActOn', 'renameAct', 'setActList', 'setActWp', 'actsOf', 'actHides'].filter((f) => typeof H[f] !== 'function').join());
if (typeof H.actsOf !== 'function') done();
ok('at most 4 modes', H.ACT_MAX === 4 && H.ACT_PRESETS.length === 4);
ok('phone presets: Canvassing, In a home, Storm day, Office', J(H.ACT_PRESETS.map((a) => a.name)) === J(['Canvassing', 'In a home', 'Storm day', 'Office']), J(H.ACT_PRESETS.map((a) => a.name)));
ok('laptop desks 1-4 are the job phases Leads, Inspect/Claim, Build, Collect',
  J(H.PHASES.map((p) => H.PHASE_NAME[p])) === J(['Leads', 'Inspect/Claim', 'Build', 'Collect']));
ok('"In a home" is the privacy mode; no other preset is', J(H.ACT_PRESETS.map((a) => !!a.focus.privacy)) === J([false, true, false, false]));
ok('Canvassing focuses on the Leads phase', H.ACT_PRESETS[0].focus.phase === 'leads');
ok('every preset widget is in the catalog, within the mode cap', H.ACT_PRESETS.every((a) => !a.phone || (a.phone.every((it) => !!H.CATALOG[it.id]) && H.weight(a.phone) <= H.ACT_ITEMS)));
ok('actsOf a key with no acts gives the four presets, in order', J(H.actsOf({}).map((a) => a.id)) === J(['canvass', 'inhome', 'storm', 'office']));
ok('...and a copy (changing it does not change the presets)', (() => { const a = H.actsOf(null); a[0].name = 'x'; return H.ACT_PRESETS[0].name === 'Canvassing'; })());

console.log('\n2. normalize keeps acts and on, and only clean ones');
{
  const old = { v: 1, phone: [{ id: 'glance', s: 'm' }], desk: [] };
  ok('a key saved before P2 normalises with no acts and no on', !('acts' in H.normalize(old)) && !('on' in H.normalize(old)), J(H.normalize(old)));
  ok('acts that are not a list are dropped', !('acts' in H.normalize({ acts: 'x' })) && !('acts' in H.normalize({ acts: { a: 1 } })));
  const raw = { acts: [
    { id: 'inhome', name: '  At the\u0000 kitchen   table  ', focus: { privacy: true, phase: 'bogus' }, phone: [{ id: 'glance', s: 'l' }, { id: 'nope' }] },
    { id: 'inhome', name: 'second copy' },
    { id: 'hacker', name: 'x' },
    { id: 'canvass', name: '', focus: { phase: 'build' } },
    { id: 'storm', name: 'S'.repeat(80), phone: 'x' },
    { id: 'office', desk: [{ id: 'upnext', s: 'm' }, { id: 'glance', s: 's' }], wp: { phone: 'tod', desk: 'javascript:x' } },
  ], on: { phone: 'inhome', desk: 'office' } };
  const k = H.normalize(raw);
  ok('four acts, one per preset id, in preset order (duplicates and unknown ids dropped)', k.acts && J(k.acts.map((a) => a.id)) === J(['canvass', 'inhome', 'storm', 'office']), J(k.acts));
  ok('a name is trimmed, control characters out, whitespace folded', k.acts[1].name === 'At the kitchen table', J(k.acts[1].name));
  ok('an empty name falls back to the preset name', k.acts[0].name === 'Canvassing');
  ok('a long name is cut to 24 characters', k.acts[2].name.length === H.ACT_NAME_MAX && H.ACT_NAME_MAX === 24);
  ok('focus keeps only known values (an unknown phase is dropped)', J(k.acts[1].focus) === J({ privacy: true }) && J(k.acts[0].focus) === J({ phase: 'build' }), J(k.acts.map((a) => a.focus)));
  ok('a mode\'s phone list is cleaned like a home (unknown widgets dropped)', J(k.acts[1].phone) === J([{ id: 'glance', s: 'l' }]), J(k.acts[1].phone));
  ok('a list that is not a list is no list (the mode shows your home)', !('phone' in k.acts[2]), J(k.acts[2]));
  ok('a mode\'s desk list gets board cells', k.acts[3].desk.length === 2 && k.acts[3].desk.every((it) => typeof it.x === 'number' && typeof it.y === 'number'), J(k.acts[3].desk));
  ok('a mode\'s wallpaper keeps ids only', J(k.acts[3].wp) === J({ phone: 'tod', desk: null }), J(k.acts[3].wp));
  ok('on keeps known mode ids', J(k.on) === J({ phone: 'inhome', desk: 'office' }));
  ok('on with unknown ids is dropped', !('on' in H.normalize({ on: { phone: 'x', desk: 3 } })));
  ok('normalize is a round trip with acts and on', J(H.normalize(k)) === J(k));
  const big = []; for (let i = 0; i < 30; i++) big.push({ id: 'shortcuts', s: 's', cfg: { clock: 'off' } });
  const capped = H.normalize({ acts: [{ id: 'office', phone: big, desk: big }] });
  ok('a mode holds at most ' + H.ACT_ITEMS + ' widgets a surface', H.weight(capped.acts[3].phone) === H.ACT_ITEMS && H.weight(capped.acts[3].desk) === H.ACT_ITEMS && H.ACT_ITEMS === 8);
  const stacks = H.normalize({ acts: [{ id: 'office', phone: [{ id: 'stack', s: 'l', items: ['upnext', 'storm', 'daily', 'coach'] }, { id: 'stack', s: 'm', items: ['upnext', 'storm', 'daily', 'coach'] }, { id: 'glance', s: 'm' }] }] });
  ok('...a stack counting its cards', H.weight(stacks.acts[3].phone) === 8 && stacks.acts[3].phone.length === 2, J(stacks.acts[3].phone));
}

console.log('\n3. every existing key op keeps acts and on');
{
  const key = H.normalize({ phone: [{ id: 'glance', s: 'm' }], acts: [{ id: 'inhome', name: 'Kitchen' }], on: { phone: 'inhome' } });
  const a = H.setSurface(key, 'phone', [{ id: 'upnext', s: 'l' }]);
  ok('setSurface keeps them', J(a.acts) === J(key.acts) && J(a.on) === J(key.on), J(a));
  const b = H.setWp(key, 'phone', 'tod');
  ok('setWp keeps them', J(b.acts) === J(key.acts) && J(b.on) === J(key.on), J(b));
  const c = H.resolveHome({ own: key });
  ok('resolveHome still resolves the lists (acts change nothing there)', J(c.phone) === J(key.phone) && c.src.phone === 'user');
}

console.log('\n4. switching, renaming, a mode\'s own widgets and wallpaper');
{
  ok('no mode on: activeAct is null on both surfaces', H.activeAct({}, 'phone', 0) === null && H.activeAct({ on: { phone: 'inhome' } }, 'desk', 1) === null);
  const k1 = H.setActOn({ phone: [{ id: 'glance', s: 'm' }] }, 'phone', 'inhome');
  ok('setActOn sets the phone mode', J(k1.on) === J({ phone: 'inhome', desk: null }), J(k1));
  ok('...and keeps the member\'s own lists only (a surface on the company home stays on it)', 'phone' in k1 && !('desk' in k1), J(k1));
  ok('...without writing the presets into the key', !('acts' in k1));
  const a1 = H.activeAct(k1, 'phone', 0);
  ok('the phone face: In a home, privacy on, its preset widgets', a1 && a1.id === 'inhome' && a1.name === 'In a home' && a1.focus.privacy === true && J(a1.items) === J(H.ACT_PRESETS[1].phone), J(a1));
  ok('setActOn(null) turns it off', !('on' in H.setActOn(k1, 'phone', null)) && H.activeAct(H.setActOn(k1, 'phone', null), 'phone', 0) === null);
  ok('an unknown mode id turns it off too', H.activeAct(H.setActOn(k1, 'phone', 'nope'), 'phone', 0) === null);
  const kd = H.setActOn({}, 'desk', 'canvass');
  const d2 = H.activeAct(kd, 'desk', 2);
  ok('the laptop face follows the desk: desk 3 is Build, phase build, no privacy', d2 && d2.slot === 2 && d2.name === 'Build' && J(d2.focus) === J({ phase: 'build' }), J(d2));
  ok('...desk 1 is Leads', H.activeAct(kd, 'desk', 0).focus.phase === 'leads');
  ok('...a garbage desk index is desk 1', H.activeAct(kd, 'desk', 'x').slot === 0 && H.activeAct(kd, 'desk', 9).slot === 0);
  ok('the phone mode and the laptop workspaces are separate', H.activeAct(kd, 'phone', 0) === null);
  const r = H.renameAct(k1, 'inhome', '<b>Kitchen</b>');
  ok('renameAct writes all four modes, the one renamed (text kept as text; the page escapes it)', r.acts.length === 4 && r.acts[1].name === '<b>Kitchen</b>' && r.acts[0].name === 'Canvassing', J(r.acts));
  ok('...keeping on', J(r.on) === J(k1.on));
  ok('renameAct of an unknown mode is null', H.renameAct(k1, 'nope', 'x') === null);
  const l = H.setActList(k1, 'inhome', 'phone', [{ id: 'coach', s: 'm' }]);
  ok('setActList gives the mode its own phone widgets', J(H.activeAct(l, 'phone', 0).items) === J([{ id: 'coach', s: 'm' }]));
  ok('...and leaves the member\'s home as it was', J(l.phone) === J(k1.phone));
  const ld = H.setActList(kd, 'storm', 'desk', [{ id: 'upnext', s: 'm' }]);
  ok('a desk list lands on that desk\'s mode (desk 3 = the third mode)', J(H.activeAct(ld, 'desk', 2).items.map((it) => it.id)) === J(['upnext']) && H.activeAct(ld, 'desk', 0).items === null, J(H.activeAct(ld, 'desk', 2)));
  const w = H.setActWp(k1, 'inhome', 'phone', 'none');
  ok('setActWp gives the mode its own wallpaper', H.activeAct(w, 'phone', 0).wp === 'none' && !('wp' in w));
  ok('...and a bad id clears it', H.activeAct(H.setActWp(w, 'inhome', 'phone', 'https://x'), 'phone', 0).wp === null);
}

console.log('\n5. what "In a home" never paints');
{
  const P = { privacy: true };
  ok('Money, Closes this week and Shutdown are hidden (dollars and other customers\' names)', ['money', 'closes', 'shutdown'].every((id) => H.actHides(P, id)));
  ok('the rest still paints (their names are filtered by the lens)', ['glance', 'upnext', 'shortcuts', 'coach', 'daily', 'needsyou', 'storm', 'stack'].every((id) => !H.actHides(P, id)));
  ok('a phase focus hides nothing', H.ids().every((id) => !H.actHides({ phase: 'build' }, id)));
  ok('no focus hides nothing', H.ids().every((id) => !H.actHides(null, id)));
}

console.log('\n6. max fill: every field at once stays under the 12,000-char budget');
{
  const cfgIds = H.ids().filter((id) => H.CATALOG[id].config);
  let worst = { id: H.ids().reduce((a, b) => (b.length > a.length ? b : a)), s: 'm' };
  cfgIds.forEach((id) => {
    const conf = H.CATALOG[id].config; const cfg = {};
    Object.keys(conf).forEach((k) => { cfg[k] = conf[k].reduce((a, b) => (String(b).length > String(a).length ? b : a)); });
    const it = { id, s: 'm', cfg: H.cleanCfg(id, cfg) };
    if (J(it).length > J(worst).length) worst = it;
  });
  const fill = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(worst); return a; };
  const WP = { phone: 'z'.repeat(16), desk: 'y'.repeat(16) };
  const acts = H.ACT_PRESETS.map((p) => ({ id: p.id, name: 'W'.repeat(40), focus: { phase: 'inspect', privacy: true }, phone: fill(20), desk: fill(20), wp: WP }));
  const k = H.normalize({ v: 1, phone: fill(30), desk: fill(30), wp: WP, acts, on: { phone: 'storm', desk: 'office' } });
  const n = J(k).length;
  ok('the max-fill home with 4 full modes serialises under 12,000 chars (' + n + ')', n < 12000 && n <= R.MAX_STATE_JSON && k.acts.length === 4 && k.acts.every((a) => H.weight(a.phone) === H.ACT_ITEMS && H.weight(a.desk) === H.ACT_ITEMS), n);
  ok('LayoutRegistry keeps it (its per-key budget)', !!R.normalizeUser({ layoutState: { 'os-home': k } }).layoutState['os-home']);
  // the bound with every field at its largest the catalog allows today: the longest id or largest valid cfg
  // with a desk cell, or a 4-card stack's share (a widget added later with a bigger cfg raises it)
  const unit = Math.max(J(Object.assign({}, worst, { x: 3, y: H.DESK_MAX_Y, w: 2, h: 2 })).length,
    Math.ceil(J({ id: 'stack', s: 'l', x: 3, y: H.DESK_MAX_Y, w: 2, h: 2, items: H.ids().filter((id) => !H.CATALOG[id].stack).sort((p, q) => q.length - p.length).slice(0, 4) }).length / H.STACK_MAX));
  const actHead = J({ id: 'canvass', name: 'W'.repeat(H.ACT_NAME_MAX), focus: { phase: 'collect', privacy: true }, phone: [], desk: [], wp: WP }).length;
  const bound = 2 * H.MAX_ITEMS * unit + H.ACT_MAX * (2 * H.ACT_ITEMS * unit + actHead) + J({ wp: WP, on: { phone: 'canvass', desk: 'canvass' } }).length + 40;
  ok('the bound with every field at its catalog maximum (' + bound + ')', bound < 12000, bound);
}

console.log('\n7. the focus lens (os/acts-logic.js, the osacts bundle)');
ok('docs/pro/js/os/acts-logic.js exists and require()s in Node', !!AL && typeof AL.lensPlan === 'function', fs.existsSync(AL_FILE) ? 'loaded but no lensPlan' : 'missing');
if (!AL) done();
const NOW = new Date(2026, 10, 9, 13, 5).getTime();
const ROLE = { new: 'new', contacted: 'active', inspected: 'active', permit_pulled: 'job', final_payment: 'won', lost: 'lost', my_custom: 'job' };
const roleOf = (k) => ROLE[k] || 'active';
const LEADS = [
  { id: 'L1', firstName: 'Pat', lastName: 'Current', stage: 'inspected' },
  { id: 'L2', firstName: 'Nina', lastName: 'Newlead', stage: 'new' },
  { id: 'L3', firstName: 'Bo', lastName: 'Builder', stage: 'permit_pulled' },
  { id: 'L4', firstName: 'Cass', lastName: 'Collect', stage: 'final_payment' },
  { id: 'L5', firstName: 'Lou', lastName: 'Lost', stage: 'lost' },
  { id: 'L6', firstName: 'Tess', lastName: 'Tenant', _stageKey: 'my_custom' },
  { id: 'L7', firstName: 'Ray', lastName: 'Stamped', stage: 'new', _stageRole: 'won' },
];
function plan() {
  return {
    total: 9,
    appointments: [
      { key: 'appt:1', name: 'Pat Current', leadId: 'L1', address: '12 Oak St, Cincinnati, OH', phone: '5135550101', timeLabel: '1:00 PM', sortMs: NOW - 5 * 60000, allDay: false, title: 'Inspection - Pat Current' },
      { key: 'appt:2', name: 'Bo Builder', leadId: 'L3', address: '9 Elm Rd, Mason, OH', phone: '5135550103', timeLabel: '3:30 PM', sortMs: NOW + 145 * 60000, allDay: false, title: 'Build - Bo Builder' },
    ],
    promises: [{ key: 'pr:L6', name: 'Tess Tenant', leadId: 'L6', promiseTasks: [{ overdue: true, text: 'Call Tess Tenant back' }] }],
    calls: [{ key: 'lead:L2', name: 'Nina Newlead', leadId: 'L2', phone: '(513) 555-0102', missed: true, latestMs: NOW - 3600000, text: 'Hi this is Nina' },
      { key: 'call:x', name: 'Unknown Ursula', phone: '5135550199', missed: true, latestMs: NOW - 7200000 }],
    promised: [{ key: 'prom:L4', name: 'Cass Collect', leadId: 'L4', overdue: true }],
    estimates: [{ key: 'est:L1', name: 'Pat Current', leadId: 'L1', bucket: 'd2' }],
    money: [{ key: 'inv:L4', name: 'Cass Collect', leadId: 'L4', kind: 'invoice', invoiceId: 'I9', cents: 125000, overdue: true }],
    stalled: [{ key: 'st:L5', name: 'Lou Lost', leadId: 'L5', daysLate: 4 }],
    waiting: [{ name: 'Wendy Waiting' }], waitingPeople: ['Wendy Waiting'],
    noNextStep: { count: 3 },
  };
}
const ctx = (focus, extra) => Object.assign({ focus, leads: LEADS, roleOf, now: NOW }, extra || {});
{
  const byId = {}; LEADS.forEach((l) => { byId[l.id] = l; });
  ok('a lead\'s phase is its tenant stage role: new Leads, active Inspect/Claim, job Build, won Collect, lost none',
    J(['L2', 'L1', 'L3', 'L4', 'L5'].map((id) => AL.leadPhase(byId[id], roleOf))) === J(['leads', 'inspect', 'build', 'collect', '']), J(LEADS.map((l) => AL.leadPhase(l, roleOf))));
  ok('a tenant\'s custom stage goes by the role it declares', AL.leadPhase(byId.L6, roleOf) === 'build');
  ok('the lead\'s own stored role wins over its stage key', AL.leadPhase(byId.L7, roleOf) === 'collect');
  ok('no role function: only a "new" stage is known', AL.leadPhase(byId.L2, null) === 'leads' && AL.leadPhase(byId.L3, null) === '');

  ok('the current appointment: the one started in the last 3 hours', J(AL.currentAppt(plan(), NOW)) === J({ key: 'appt:1', leadId: 'L1' }), J(AL.currentAppt(plan(), NOW)));
  const p2 = plan(); p2.appointments[0].sortMs = NOW - 4 * 3600000;
  ok('...none started lately: none until the next is under an hour away', AL.currentAppt(p2, NOW) === null);
  p2.appointments[1].sortMs = NOW + 40 * 60000;
  ok('...the next one under an hour away', J(AL.currentAppt(p2, NOW)) === J({ key: 'appt:2', leadId: 'L3' }));
  const p3 = plan(); p3.appointments[1].sortMs = NOW - 60 * 60000;
  ok('...two started: the later one', AL.currentAppt(p3, NOW).key === 'appt:1');
  ok('...no plan: none', AL.currentAppt(null, NOW) === null);

  const raw = plan();
  ok('no focus: the plan is passed through untouched', AL.lensPlan(raw, ctx(null)) === raw && AL.lensPlan(raw, ctx({})) === raw);

  const lp = AL.lensPlan(plan(), ctx({ phase: 'leads' }));
  ok('Leads: only rows whose lead is in the Leads phase, plus calls with no lead', J(lp.calls.map((r) => r.key)) === J(['lead:L2', 'call:x']) && lp.appointments.length === 0 && lp.estimates.length === 0 && lp.money.length === 0, J(lp));
  ok('...the total is what is left (counted, never the old number)', lp.total === 2, lp.total);
  ok('...the no-next-step count, which has no per-lead list, is left out', lp.noNextStep === null);
  const lb = AL.lensPlan(plan(), ctx({ phase: 'build' }));
  ok('Build: the job-role leads, a tenant custom stage included', J(lb.appointments.map((r) => r.key)) === J(['appt:2']) && J(lb.promises.map((r) => r.key)) === J(['pr:L6']) && lb.total === 2, J(lb));
  const lc = AL.lensPlan(plan(), ctx({ phase: 'collect' }));
  ok('Collect: the won-role leads, money included', J(lc.money.map((r) => r.key)) === J(['inv:L4']) && J(lc.promised.map((r) => r.key)) === J(['prom:L4']), J(lc));
  ok('a lost lead is in no phase', ['leads', 'inspect', 'build', 'collect'].every((ph) => AL.lensPlan(plan(), ctx({ phase: ph })).stalled.length === 0));
  ok('the raw plan is not changed', J(raw) === J(plan()));
  // a lead swapped in place (same array, same length) is read fresh, never from a map built on an earlier call
  const ls = LEADS.slice();
  ok('a lead in place: Collect shows its money', AL.lensPlan(plan(), ctx({ phase: 'collect' }, { leads: ls })).money.length === 1);
  ls[3] = { id: 'L4', firstName: 'Cass', lastName: 'Collect', stage: 'new' };
  const lsw = AL.lensPlan(plan(), ctx({ phase: 'collect' }, { leads: ls }));
  ok('...swapped in place for one back in Leads: Collect no longer shows it', lsw.money.length === 0 && lsw.promised.length === 0, J(lsw));

  const pv = AL.lensPlan(plan(), ctx({ privacy: true }));
  const s = J(pv);
  ok('In a home: the current appointment\'s customer keeps their name', /Pat Current/.test(s), s);
  const others = ['Nina', 'Newlead', 'Bo Builder', 'Builder', 'Tess', 'Cass', 'Lou Lost', 'Ursula', 'Wendy'];
  ok('...no other customer\'s name reaches the plan', others.every((n) => s.indexOf(n) === -1), others.filter((n) => s.indexOf(n) !== -1).join());
  ok('...no other customer\'s phone or street', ['555-0102', '5135550103', '5135550199', 'Elm Rd', 'Mason'].every((n) => s.indexOf(n) === -1), s);
  ok('...no money rows (nothing to collect, no cents)', pv.money.length === 0 && s.indexOf('125000') === -1 && s.indexOf('I9') === -1);
  ok('...the rows are still there, neutral, so the day still counts', pv.calls.length === 2 && pv.calls[0].name === 'A call to return' && pv.appointments[1].name === 'Appointment' && pv.total === 8, J(pv.calls) + ' ' + pv.total);
  ok('...and a row still taps through to its own record (the lead id is not a name)', pv.calls[0].leadId === 'L2' && pv.appointments[1].leadId === 'L3');
  const ups = H.upNext(pv, { n: 9 });
  ok('...Up Next built from it names only the current customer', J(ups).indexOf('Nina') === -1 && ups.some((r) => r.name === 'Pat Current'), J(ups.map((r) => r.name)));
  ok('...At a Glance\'s next appointment shows no other street', AL.lensPlan(p2, ctx({ privacy: true })).appointments.every((a) => a.leadId === 'L3' ? !!a.address : !a.address));
  const both = AL.lensPlan(plan(), ctx({ privacy: true, phase: 'leads' }));
  ok('privacy and a phase together: filtered, then stripped', both.calls.length === 2 && J(both).indexOf('Nina') === -1);

  ok('lensLeads: a phase keeps that phase\'s leads', J(AL.lensLeads(LEADS, ctx({ phase: 'build' })).map((l) => l.id)) === J(['L3', 'L6']));
  ok('lensLeads: privacy alone keeps every lead (counts stay honest); names are gated by nameOk', AL.lensLeads(LEADS, ctx({ privacy: true })) === LEADS);
  ok('nameOk: only the current appointment\'s lead in privacy', AL.nameOk('L1', ctx({ privacy: true }), AL.currentAppt(plan(), NOW)) && !AL.nameOk('L2', ctx({ privacy: true }), AL.currentAppt(plan(), NOW)));
  ok('nameOk: everyone with no privacy', AL.nameOk('L2', ctx({ phase: 'build' }), null));
  const u = { kind: 'lead', n: 2, oldestMin: 9 };
  ok('a new-lead wait shows in Leads and with no phase; not on a Build desk', AL.lensUrgency(u, { phase: 'leads' }) === u && AL.lensUrgency(u, {}) === u && AL.lensUrgency(u, { phase: 'build' }) === null);
}

console.log('\n8. a storm OFFERS Storm day, never switches');
{
  const alert = { ts: NOW - 10 * 60000, data: [{ event: 'Severe Thunderstorm Warning' }] };
  const o1 = AL.stormOffer({ cache: alert, now: NOW, on: null, offered: null });
  ok('a fresh alert, Storm day off, not offered yet: an offer for this alert', o1 && o1.offer === true && o1.mark === String(alert.ts) && /Severe Thunderstorm Warning/.test(o1.event), J(o1));
  ok('already in Storm day: no offer', AL.stormOffer({ cache: alert, now: NOW, on: 'storm', offered: null }).offer === false);
  ok('already offered for this alert: no offer', AL.stormOffer({ cache: alert, now: NOW, on: null, offered: String(alert.ts) }).offer === false);
  ok('a stale cache or none: no offer', AL.stormOffer({ cache: { ts: NOW - 2 * 3600000, data: [{ event: 'x' }] }, now: NOW }).offer === false && AL.stormOffer({ cache: null, now: NOW }).offer === false);
  ok('the offer has no switch in it: the module returns data, never a key', !('key' in o1) && !('on' in o1));
  const src = fs.readFileSync(AL_FILE, 'utf8');
  ok('acts-logic.js touches no DOM, storage, clock or network', !/document\.|localStorage|Date\.now|fetch\(|setTimeout|setInterval/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
}

done();
