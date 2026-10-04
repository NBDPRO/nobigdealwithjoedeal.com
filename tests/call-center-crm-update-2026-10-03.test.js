#!/usr/bin/env node
/**
 * tests/call-center-crm-update-2026-10-03.test.js — "the CRM knows I called"
 * (2026-10-03), the client half:
 *
 *   - docs/pro/js/call-timeline.js: a noted call / day of texts filed as
 *     leads/{id}/activity/cube-* | sms-* becomes a customer-timeline row;
 *     every other activity doc (thursday-*, measurement, rep notes) is left
 *     to its own source so nothing is listed twice; AI text stays a plain
 *     string (escaped by the renderer)
 *   - customer-bootstrap.module.js reads that subcollection for the timeline
 *     AND the PDF report, through the escaping renderer
 *   - docs/pro/js/call-center-view.js (vm-loaded, fake Firestore): 📞 Call
 *     and 💬 Text on every call card, a person's group card, a day of texts
 *     and the Needs-attention deck's ⋯ menu; ?call=<id> opens that card
 *
 * Server half: tests/call-center-notes-2026-10-01.test.js (lead update,
 * urgent push), call-center-action (taskDone mirror), call-watch (rules).
 *
 * Run: node tests/call-center-crm-update-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

(async () => {
  console.log('\n1. call-timeline.js — calls + texts on the customer timeline');
  let CT = { fromActivity: () => null };
  try { CT = require(path.join(ROOT, 'docs/pro/js/call-timeline.js')); } catch (_) { /* not on this branch */ }
  const L = require(path.join(ROOT, 'functions/call-center-logic.js'));
  const at = Date.parse('2026-10-01T15:00:00Z');
  const act = L.buildCallActivity({
    call: { id: 'cube_x', direction: 'inbound', contactName: 'Pat Example', durationSec: 95, startedAtMs: at },
    notes: { summary: 'Gutter leaking; Jo will send the quote.', promises: [{ who: 'jo', text: 'Send the quote' }, { who: 'them', text: 'Leave the gate open' }], followUpDate: '2026-10-02' },
    ownerUid: 'U',
  });
  const row = CT.fromActivity('cube-cube_x', Object.assign({ createdAt: { toDate: () => new Date(at + 3600e3) } }, act));
  ok('a noted call (what the server writes) → a Calls row: who + length, summary, Jo\'s promise, follow-up', row && row.type === 'communication' && row.kind === 'call'
    && row.title === 'They called · Pat Example · 1m 35s' && /Gutter leaking/.test(row.desc) && /You said you would: Send the quote/.test(row.desc) && !/gate open/.test(row.desc) && /Follow up 2026-10-02/.test(row.desc), JSON.stringify(row));
  ok('dated when the CALL happened, not when it was filed', !!row && row.time.getTime() === at);
  const old = CT.fromActivity('cube-cube_y', { label: 'You called', summary: 's', createdAt: { toDate: () => new Date(at) } });
  ok('an entry filed before startedAtMs existed falls back to createdAt', !!old && old.time.getTime() === at);
  const sms = CT.fromActivity('sms-txt_5135550100_20261001', { type: 'text', label: 'Texts · Pat (4)', summary: 'Sent photos.', startedAtMs: at });
  ok('a day of texts → a Texts row', !!sms && sms.kind === 'text' && sms.title === 'Texts · Pat (4)' && sms.desc === 'Sent photos.');
  ok('thursday-*, measurement and rep-written activity are NOT read here (shown from their own sources — no duplicates)',
    CT.fromActivity('thursday-abc', { summary: 'x' }) === null && CT.fromActivity('measure-1', { type: 'measurement_ready' }) === null && CT.fromActivity('a1b2c3', { type: 'note', source: 'rep' }) === null);
  const evil = CT.fromActivity('cube-cube_z', { label: '<img src=x onerror=alert(1)>', summary: '<script>alert(2)</script>', promises: [{ who: 'jo', text: '"><b>x</b>' }] });
  ok('AI text from customer speech stays a plain string (the renderer escapes it)', !!evil && evil.title.includes('<img') && evil.desc.includes('<script>') && typeof evil.desc === 'string');

  console.log('\n2. customer page wiring');
  const cb = read('docs/pro/js/customer-bootstrap.module.js');
  const tl = cb.slice(cb.indexOf('async function loadTimeline('), cb.indexOf('// Sort by time (newest first)'));
  ok('loadTimeline reads leads/{id}/activity through NBDCallTimeline', /getDocs\(collection\(db, 'leads', leadId, 'activity'\)\)/.test(tl) && /CT\.fromActivity\(d\.id, d\.data\(\)\)/.test(tl));
  const render = cb.slice(cb.indexOf('// Sort by time (newest first)'), cb.indexOf("document.getElementById('timelineList').innerHTML = html"));
  ok('…and every row is rendered through esc() (title + desc)', /\$\{esc\(item\.title\)\}/.test(render) && /\$\{esc\(item\.desc\)\}/.test(render));
  const rep = cb.slice(cb.indexOf('async function _gatherTimelineForReport('), cb.indexOf('async function _gatherNotesForReport('));
  ok('the PDF report gathers the same calls + texts', /collection\(window\.db, 'leads', leadId, 'activity'\)/.test(rep) && /CT\.fromActivity/.test(rep));
  const html = read('docs/pro/customer.html');
  const iCT = html.indexOf('js/call-timeline.js?v='), iCB = html.indexOf('js/customer-bootstrap.module.js?v=');
  ok('customer.html loads call-timeline.js (defer) before the bootstrap module', iCT > 0 && iCB > iCT && /<script defer src="js\/call-timeline\.js\?v=\d+"><\/script>/.test(html));
  const rules = read('firestore.rules');
  ok('firestore.rules already lets the lead\'s owner / company read activity (no rules change)', /match \/activity\/\{activityId\} \{\s*allow read:\s*if isAuth\(\) && \(isAdmin\(\)\s*\|\| isOwner\(get\(\/databases\/\$\(database\)\/documents\/leads\/\$\(leadId\)\)\.data\.userId\)\s*\|\| parentLeadInMyCompany\(leadId\)\);/.test(rules));

  console.log('\n3. call-center-view.js — Call / Text on every card');
  const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
  const NOW = Date.now(), H = 3600e3;
  const rowsDb = {
    phone_calls: [
      { id: 'cube_one1', userId: 'U', leadId: 'L1', bucket: 'customer', contactName: 'Ann Example', phoneDigits: '5135550101', direction: 'inbound', status: 'noted', startedAtMs: NOW - H, promises: [{ who: 'jo', text: 'send quote' }] },
      { id: 'cube_two1', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', direction: 'inbound', status: 'noted', startedAtMs: NOW - 2 * H, summary: 'New roof?' },
      { id: 'cube_two2', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', direction: 'inbound', status: 'short', startedAtMs: NOW - 3 * H },
      { id: 'cube_old1', userId: 'U', leadId: 'L1', bucket: 'customer', phoneDigits: '', direction: 'outbound', status: 'noted', startedAtMs: NOW - 30 * 24 * H, summary: 'old' },
    ],
    phone_text_days: [{ id: 'txt_5135550103_20261001', userId: 'U', channel: 'text', phoneDigits: '5135550103', status: 'noted', startedAtMs: NOW - 4 * H, messageCount: 3, contactName: 'Kim' }],
  };
  const listeners = {};
  const view = { innerHTML: '' };
  const scrolled = [];
  const cards = {};
  const document = {
    readyState: 'complete',
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    querySelector: (sel) => {
      if (sel === '#view-calls .view-scroll') return view;
      const m = /data-call-id="([^"]+)"/.exec(sel);
      if (m && view.innerHTML.includes('data-call-id="' + m[1] + '"')) {
        cards[m[1]] = cards[m[1]] || { classList: { set: new Set(), add(c) { this.set.add(c); } }, scrollIntoView() { scrolled.push(m[1]); } };
        const card = cards[m[1]];
        return { closest: () => card };
      }
      return null;
    },
    getElementById: () => null,
    activeElement: null,
  };
  let deckOpts = null;
  const win = {
    document, NBDHomeAttention: HA, _userClaims: {}, _user: { uid: 'U' },
    _leads: [{ id: 'L1', firstName: 'Ann', lastName: 'Example', phone: '(513) 555-0101' }],
    NBDTriageDeck: { open: (o) => { deckOpts = o; } },
    db: {}, collection: (db, n) => n, where: () => null, orderBy: () => null, limit: () => null,
    query: (col) => col,
    getDocs: async (col) => ({ docs: (rowsDb[col] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }),
    location: { search: '?call=cube_old1', pathname: '/pro/dashboard.html', hash: '#/calls' },
    _functions: {}, _httpsCallable: () => async () => ({ data: { items: [] } }),
  };
  const replaced = [];
  const sandbox = {
    window: win, document, console, setTimeout, Promise, URLSearchParams, Date, Object, Array, String, Number, JSON, Math, RegExp,
    CSS: { escape: (s) => String(s) }, history: { replaceState: (a, b, u) => replaced.push(u) },
  };
  sandbox.window.history = sandbox.history;
  vm.createContext(sandbox);
  vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
  const CC = win.NBDCallCenter;
  await CC.reload();
  let out = view.innerHTML;
  const callBtns = (out.match(/<a class="btn btn-ghost pc-play cc-reach" href="tel:\+1\d{10}" data-cc-reach="call">📞 Call<\/a>/g) || []).length;
  const textBtns = (out.match(/<a class="btn btn-ghost pc-play cc-reach" href="sms:\+1\d{10}" data-cc-reach="text">💬 Text<\/a>/g) || []).length;
  ok('Needs attention: the customer card and the unknown caller\'s group card each get 📞 Call + 💬 Text', callBtns === 2 && textBtns === 2, callBtns + '/' + textBtns);
  ok('the numbers are the caller\'s', out.includes('href="tel:+15135550101"') && out.includes('href="sms:+15135550102"'));
  ok('no inline handlers or inline styles on them (CSP)', !/cc-reach[^>]*(onclick|style=)/.test(out));
  CC._state.filter = 'all';
  await CC.reload();
  out = view.innerHTML;
  ok('All tab: every call card and the day of texts has Call + Text (5 rows)', (out.match(/data-cc-reach="call"/g) || []).length === 5 && out.includes('href="sms:+15135550103"'), (out.match(/data-cc-reach="call"/g) || []).length);
  ok('a call with no number of its own uses the customer\'s phone', typeof win.NBDCallCenter._telOf === 'function' && win.NBDCallCenter._telOf({ phoneDigits: '' }, { phone: '(513) 555-0101' }) === '+15135550101' && win.NBDCallCenter._telOf({ phoneDigits: '12' }, null) === '');
  ok('the 44px touch target and link look come from the stylesheet', /\.pc-play \{ min-height: 44px; \}/.test(read('docs/pro/css/phone-calls.css')) && /\.cc-reach \{[^}]*display: inline-flex/.test(read('docs/pro/css/phone-calls.css')));
  CC._state.filter = 'attention';
  await CC.reload();
  // The Needs-attention deck's ⋯ menu.
  listeners.click.forEach((f) => f({ target: { closest: (s) => (s === '[data-cc]' ? { getAttribute: (a) => (a === 'data-cc' ? 'deck' : null), closest: () => true } : null) } }));
  ok('the deck opened', !!deckOpts && deckOpts.items.length === 2);
  const more = deckOpts.more(deckOpts.items.find((g) => g.key === 'lead:L1')).map((m) => m.label + ' ' + (m.href || ''));
  ok('the deck\'s ⋯ menu: Call, Text, then Open customer', more[0] === '📞 Call tel:+15135550101' && more[1] === '💬 Text sms:+15135550101' && /^Open customer/.test(more[2]), JSON.stringify(more));
  const moreU = deckOpts.more(deckOpts.items.find((g) => g.key === 'num:5135550102')).map((m) => m.label);
  ok('an unknown caller\'s ⋯ menu has Call + Text (it had nothing before)', moreU.join() === '📞 Call,💬 Text', moreU.join());

  console.log('\n4. ?call=<id> opens that call\'s card');
  const focusT = typeof CC._focusTarget === 'function' ? CC._focusTarget : () => undefined;
  const t1 = focusT(CC._state.calls, 'cube_one1', CC._needsAttention);
  ok('a call that still needs Jo opens on Needs attention', !!t1 && t1.filter === 'attention');
  const t2 = focusT(CC._state.calls, 'cube_old1', CC._needsAttention);
  ok('a call that doesn\'t opens on All', !!t2 && t2.filter === 'all');
  ok('an unknown id → nothing', focusT(CC._state.calls, 'cube_nope', CC._needsAttention) === null);
  CC._state.filter = 'attention';
  CC.init();
  await new Promise((r) => setTimeout(r, 600));
  ok('init with ?call=: the param is dropped from the URL, the All tab shows, that card is scrolled to and marked',
    replaced.some((u) => u === '/pro/dashboard.html#/calls') && CC._state.filter === 'all' && scrolled.includes('cube_old1') && cards.cube_old1.classList.set.has('cc-focus'), JSON.stringify({ replaced, f: CC._state.filter, scrolled }));
  delete cards.cube_old1;
  await CC.reload();
  ok('the mark survives a later re-render (a data refresh rebuilds the list)', cards.cube_old1 && cards.cube_old1.classList.set.has('cc-focus'));
  // The first read came back without the call (a boot read from the empty
  // local cache): the link reads again rather than giving up.
  rowsDb.phone_calls.push({ id: 'cube_late1', userId: 'U', leadId: 'L1', bucket: 'customer', phoneDigits: '5135550101', direction: 'outbound', status: 'noted', startedAtMs: NOW - 5 * H, summary: 'late' });
  ok('(the list in memory does not have it yet)', !CC._state.calls.some((c) => c.id === 'cube_late1'));
  if (typeof CC.focusCall === 'function') CC.focusCall('cube_late1');
  await new Promise((r) => setTimeout(r, 2000));
  ok('a ?call= link whose first read missed the call reads again and still opens it', !!cards.cube_late1 && cards.cube_late1.classList.set.has('cc-focus') && scrolled.includes('cube_late1'));

  // Cold start: init() runs before Firestore / the user exist (a push or the
  // email opening #/calls). It must wait, not settle on an empty list.
  const view2 = { innerHTML: '' };
  const doc2 = Object.assign({}, document, { querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view2 : null) });
  const win2 = Object.assign({}, win, { document: doc2, db: undefined, _user: null, location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' } });
  delete win2.NBDCallCenter;
  const sb2 = Object.assign({}, sandbox, { window: win2, document: doc2 });
  vm.createContext(sb2);
  vm.runInContext(read('docs/pro/js/call-center-view.js'), sb2);
  win2.NBDCallCenter.init();
  await new Promise((r) => setTimeout(r, 300));
  const waiting = view2.innerHTML.includes('Loading calls') && !win2.NBDCallCenter._state.loaded;
  win2.db = {}; win2._user = { uid: 'U' };
  await new Promise((r) => setTimeout(r, 700));
  ok('a cold start waits for Firestore + the user ("Loading calls…"), then loads — never "No calls yet" with calls on file',
    waiting && win2.NBDCallCenter._state.loaded && win2.NBDCallCenter._state.calls.length === rowsDb.phone_calls.length + rowsDb.phone_text_days.length && !view2.innerHTML.includes('No calls yet'), JSON.stringify({ waiting, n: win2.NBDCallCenter._state.calls.length }));
  ok('.cc-focus is styled in the stylesheet (no inline style)', /\.cc-card\.cc-focus \{/.test(read('docs/pro/css/phone-calls.css')));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
