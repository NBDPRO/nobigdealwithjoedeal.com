#!/usr/bin/env node
/**
 * tests/home-strips-2026-10-16.test.js — "Call back now" (speed-to-lead) in
 * Field and Focus, and "Needs you" (money and momentum) in Field and Mission.
 *
 *   A. Call back now: missed calls and new leads from the last 30 minutes only
 *   B. its buttons: Call is tel:, Text is held by checkText; the missed-call draft is used only when safe
 *   C. Needs you: the Today list's own counts, money first
 *   D. wiring: slots, Customize cards, lazy bundle, CSP-clean
 *
 * Run: node tests/home-strips-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const H = require(path.join(ROOT, 'docs/pro/js/home-strips.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}
const NOW = Date.parse('2026-10-16T15:00:00Z');
const MIN = 60000;
const call = (id, minAgo, o) => Object.assign({ id, channel: 'call', status: 'short', direction: 'inbound', startedAtMs: NOW - minAgo * MIN, phoneDigits: '8595550111' }, o || {});
const group = (key, c) => ({ key, calls: [c], latestMs: c.startedAtMs });
const DRAFT = 'sms:+18595550111?body=' + encodeURIComponent("Hi, it's Joe with No Big Deal Home Solutions. Sorry I missed your call, I'm on a roof.");

console.log('\nA. Call back now: the last 30 minutes only');
{
  const leads = [
    { id: 'L1', firstName: 'Dana', lastName: 'Smith', phone: '(859) 555-0111' },
    { id: 'N1', firstName: 'Ray', stage: 'new', source: 'storm_alert', createdAt: new Date(NOW - 8 * MIN).toISOString(), phone: '5135550122' },
    { id: 'N2', firstName: 'Old', stage: 'new', createdAt: new Date(NOW - 90 * MIN).toISOString() },
    { id: 'C1', firstName: 'Won', stage: 'contacted', createdAt: new Date(NOW - 5 * MIN).toISOString() },
  ];
  const rows = H.speedToLead({ nowMs: NOW, leads, groups: [
    group('lead:L1', call('c1', 12, { leadId: 'L1', replyDraft: { smsHref: DRAFT } })),
    group('num:1', call('c2', 45)),
    group('num:2', call('c3', 5, { status: 'answered' })),
    group('num:3', call('c4', 3, { channel: 'text' })),
  ] });
  ok('a missed call 12 minutes ago is listed with the customer\'s name', rows.some((r) => r.kind === 'missed' && r.name === 'Dana Smith' && r.leadId === 'L1'), JSON.stringify(rows));
  ok('a missed call 45 minutes ago is not', !rows.some((r) => r.key === 'call:num:1'));
  ok('an answered call or a text is not a missed call', !rows.some((r) => r.key === 'call:num:2' || r.key === 'call:num:3'));
  ok('a new lead from 8 minutes ago is listed, with its source', rows.some((r) => r.kind === 'lead' && r.leadId === 'N1' && r.source === 'storm_alert'));
  ok('an older new lead, or a lead past "new", is not', !rows.some((r) => r.leadId === 'N2' || r.leadId === 'C1'));
  ok('newest first', rows.every((r, i) => i === 0 || rows[i - 1].atMs >= r.atMs));
  ok('the window is 30 minutes and at most 3 rows show', H.WINDOW_MS === 30 * MIN && H.MAX_ROWS === 3 && H.speedToLead({ nowMs: NOW, leads: [], groups: [1, 2, 3, 4, 5].map((i) => group('n' + i, call('x' + i, i, { phoneDigits: '859555010' + i }))) }).length === 3);
  ok('a caller who is also a new lead is one row, not two', H.speedToLead({ nowMs: NOW, leads: [{ id: 'N1', stage: 'new', createdAt: new Date(NOW - 2 * MIN).toISOString() }], groups: [group('lead:N1', call('c9', 1, { leadId: 'N1' }))] }).length === 1);
  ok('deleted and test leads never show', H.speedToLead({ nowMs: NOW, leads: [{ id: 'D', stage: 'new', deleted: true, createdAt: NOW - MIN }, { id: 'T', stage: 'new', e2eTestData: true, createdAt: NOW - MIN }], groups: [] }).length === 0);
}

console.log('\nB. the buttons');
{
  ok('the missed-call reply draft is used only when it is our own safe sms: shape', H.safeSmsHref(DRAFT) === DRAFT && H.safeSmsHref('sms:+18595550111?body=<script>') === '' && H.safeSmsHref('javascript:alert(1)') === '' && H.safeSmsHref('https://x.test') === '');
  // render the strip in a sandbox
  const win = { addEventListener() {}, setInterval() {}, document: null };
  const doc = { querySelectorAll: () => [], addEventListener() {}, body: {} };
  win.document = doc;
  const ctx = { window: win, document: doc, console, Date, Math, JSON, String, Array, Object, isFinite, encodeURIComponent, setTimeout: () => 1, setInterval: () => 1 };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/home-strips.js'), ctx);
  const h = win.NBDHomeStrips._stlHtml([
    { key: 'call:a', kind: 'missed', name: '<b>Dana</b>', phone: '8595550111', leadId: 'L1', atMs: Date.now() - 12 * MIN, smsHref: DRAFT },
    { key: 'lead:b', kind: 'lead', name: 'Ray', phone: '5135550122', leadId: 'N1', atMs: Date.now() - 8 * MIN, smsHref: '', source: 'storm_alert' },
    { key: 'call:c', kind: 'missed', name: 'Unknown caller', phone: '', leadId: '', atMs: Date.now() - MIN, smsHref: '' },
  ]);
  ok('Call is a tel: link', /<a class="hs-btn hs-btn-primary" href="tel:\+18595550111">Call<\/a>/.test(h));
  ok('Text back carries the drafted reply and is held by checkText (data-ps-check + the lead)', /href="sms:\+18595550111\?body=Hi%2C[^"]*" data-ps-check="1" data-ps-lead="L1">Text back \(draft\)</.test(h), h);
  ok('a new lead gets a plain checked Text', /href="sms:\+15135550122" data-ps-check="1" data-ps-lead="N1">Text</.test(h));
  ok('every sms: link on the strip is checked', (h.match(/href="sms:/g) || []).length === (h.match(/data-ps-check="1"/g) || []).length);
  ok('no number: a disabled button, no dead link', /<button type="button" class="hs-btn" disabled>No number<\/button>/.test(h));
  ok('names are escaped and it says nothing is sent for you', !/<b>Dana/.test(h) && /nothing is sent for you/.test(h));
  ok('nothing to show: no strip at all', win.NBDHomeStrips._stlHtml([]) === '' && win.NBDHomeStrips._nyHtml({ estimates: 0, unpaid: { count: 0, cents: 0 }, overdue: 0, newLeads: 0 }) === '');
  const ny = win.NBDHomeStrips._nyHtml({ estimates: 3, unpaid: { count: 4, cents: 2750000 }, overdue: 5, newLeads: 1 });
  ok('Needs you: money first, each chip opens the view that holds it', /data-ny-go="money">4 unpaid invoices · \$27.5k</.test(ny) && ny.indexOf('data-ny-go="money"') < ny.indexOf('data-ny-go="closeboard"') && /data-ny-go="closeboard">3 estimates to follow up</.test(ny) && /5 overdue follow-ups/.test(ny) && /1 new lead this week/.test(ny), ny);
}

console.log('\nC. Needs you counts come from the Today list');
{
  const plan = {
    estimates: [{ leadId: 'a' }, { leadId: 'b' }],
    money: [{ kind: 'invoice', cents: 50000 }, { kind: 'invoice', cents: 25000 }, { kind: 'deposit', cents: 99900 }, { kind: 'stripe', count: 2, cents: 0 }],
    stalled: [{}, {}, {}],
  };
  const leads = [{ id: 1, stage: 'new', createdAt: NOW - 2 * 86400000 }, { id: 2, stage: 'new', createdAt: NOW - 9 * 86400000 }, { id: 3, stage: 'inspected', createdAt: NOW }];
  const n = H.needsYou(plan, leads, NOW);
  ok('estimates = the Today list\'s "Estimates to follow up"', n.estimates === 2);
  ok('unpaid = owed invoices only (not draft deposits or Stripe), with their total', n.unpaid.count === 2 && n.unpaid.cents === 75000, JSON.stringify(n));
  ok('overdue follow-ups = Stalled', n.overdue === 3);
  ok('new leads = stage "new" from the last 7 days', n.newLeads === 1);
}

console.log('\nD. wiring');
{
  const field = read('docs/pro/js/layouts/field.js'), focus = read('docs/pro/js/layouts/focus.js'), mission = read('docs/pro/js/layouts/mission.js');
  ok('Field: Call back now right under the next stop; Needs you before Cash', /data-ns-slot="field" data-ns-variant="compact"><\/div>';\s*\/\/[^\n]*\n[^\n]*\n\s*h \+= '<div data-stl-slot="field"><\/div>';/.test(field) && /<div data-ny-slot="field"><\/div><div data-cash-slot="field"/.test(field));
  ok('Focus: Call back now under the next stop', /<div data-ns-slot="focus"><\/div><div data-stl-slot="focus"><\/div>/.test(focus));
  ok('Mission: Needs you strip under Cash', /data-cash-slot="mission" data-cash-variant="compact"><\/div><div class="mc-ny" data-ny-slot="mission"><\/div>/.test(mission));
  const CP = require(path.join(ROOT, 'docs/pro/js/card-prefs.js'));
  ok('Customize knows the new cards (Field, Focus, Mission)', CP.idsOf('field').indexOf('callback') !== -1 && CP.idsOf('field').indexOf('needsyou') !== -1 && CP.idsOf('focus').indexOf('callback') !== -1 && CP.idsOf('mission').indexOf('needsyou') !== -1);
  ok('lazy bundle "homestrips" (?v=), kicked by today-home.js', /homestrips: \[\s*'css\/home-strips\.css\?v=\d+',\s*'js\/home-strips\.js\?v=\d+'\s*\]/.test(read('docs/pro/js/script-loader.js')) && /loadBundle\('homestrips'\)/.test(read('docs/pro/js/today-home.js')));
  const js = read('docs/pro/js/home-strips.js'), css = read('docs/pro/css/home-strips.css');
  ok('CSP: no inline handlers or style attributes; nothing sends', !/\son[a-z]+=/i.test(js) && !/style=/.test(js) && !/fetch\(|httpsCallable/.test(js));
  ok('44px buttons and chips', /\.hs-btn\{[^}]*min-height:44px/.test(css) && /\.hs-chip\{[^}]*min-height:44px/.test(css));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
