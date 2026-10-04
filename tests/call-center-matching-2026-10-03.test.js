/**
 * tests/call-center-matching-2026-10-03.test.js — the call screens' side of
 * smarter call→customer matching (docs/pro/js/call-center-view.js and
 * docs/pro/js/customer-calls.js), vm-loaded with a tiny DOM stub so the real
 * functions run. Server side: tests/call-center-action-2026-10-01.test.js
 * (re-file, move, tagged match) and call-center-notes (stored suggestion).
 *
 *   - "Looks like X / File on X" shows on the main call card from the stored
 *     suggestion, and from a number already on a customer; never for a
 *     deleted customer; "Not in CRM yet — Make lead" for a tagged contact
 *   - no duplicate leads: "+ New lead" is never offered for a number that is
 *     a customer's, a tap on Make lead files on the existing customer
 *     instead, and two cards for one number make ONE lead
 *   - Said-you'd-do cards group by caller
 *   - customer page: ✓ Handled and "Wrong customer → move to…" send the
 *     callCenterAction calls
 *
 * Run: node tests/call-center-matching-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// A DOM just big enough: delegated listeners, one render target, status slots.
function makeEnv(opts) {
  const listeners = {};
  const target = { innerHTML: '' };
  const slots = {}; // data-*-status="<id>" → text
  const document = {
    activeElement: null,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
    querySelector: (sel) => (sel === opts.rootSel ? target : null),
    querySelectorAll: (sel) => {
      const m = /status="([^"]+)"/.exec(sel);
      if (!m) return [];
      const id = m[1];
      return [{ set textContent(v) { slots[id] = v; }, get textContent() { return slots[id]; } }];
    },
    getElementById: (id) => (opts.inputs && opts.inputs[id]) || null,
  };
  const calls = [];
  const win = {
    document, CSS: { escape: (s) => String(s) }, console, setTimeout, Promise, Date, Object, String, Number, Array, JSON, RegExp, Math, URLSearchParams,
    location: { pathname: opts.pathname || '/pro/dashboard.html', search: '', hash: '' },
    history: { replaceState() {} },
    _functions: {},
    _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: (opts.reply && opts.reply(name, data)) || { ok: true } }; },
    addEventListener() {},
  };
  win.window = win;
  Object.assign(win, opts.globals || {});
  const ctx = vm.createContext(win);
  return { win, ctx, target, slots, calls, listeners, click: async (btn) => { for (const fn of listeners.click || []) await fn({ target: btn }); } };
}
// A fake button the delegated handlers can read and rewrite.
function button(attrs, inView) {
  const a = Object.assign({}, attrs);
  const b = {
    disabled: false, hidden: false, textContent: '',
    getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); },
    closest: (sel) => {
      if (sel === '#view-calls') return inView ? {} : null;
      const keys = (sel.match(/\[([a-z-]+)(?:="([^"]+)")?\]/g) || []).map((s) => /\[([a-z-]+)(?:="([^"]+)")?\]/.exec(s));
      return keys.some((k) => k[1] in a && (k[2] == null || a[k[1]] === k[2])) ? b : null;
    },
  };
  return b;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  const src = read('docs/pro/js/call-center-view.js');
  const NOW = Date.now();

  // Firestore stubs that hand the view these phone_calls rows.
  const rows = [];
  const fsGlobals = {
    db: {}, _user: { uid: 'u1' }, _userClaims: {},
    collection: (_db, name) => name, where: () => null, orderBy: () => null, limit: () => null,
    query: (name) => name,
    getDocs: async (name) => ({ docs: name === 'phone_calls' ? rows.map((r) => ({ id: r.id, data: () => r })) : [] }),
  };
  const call = (id, extra) => Object.assign({ id, userId: 'u1', companyId: 'u1', startedAtMs: NOW - 3600e3, status: 'noted', direction: 'inbound', bucket: 'contact', tags: [], promises: [], summary: 's', leadId: null }, extra);

  console.log('\n1. "Looks like X" on the main call cards');
  rows.splice(0, rows.length,
    call('cube_SUG1', { contactName: 'Roof Guy', phoneDigits: '5135550201', suggestedLeadId: 'LD', suggestedLeadName: 'Dana Rivers', suggestedWhy: 'their name said on the call' }),
    call('cube_SUGF', { contactName: '', phoneDigits: '5135550207', suggestedLeadId: 'LD', suggestedLeadName: 'Dana Rivers', suggestedWhy: 'name + Florence' }),
    call('cube_NUM1', { contactName: 'Pat Cell', phoneDigits: '5135550202' }),
    call('cube_GONE', { contactName: 'X', phoneDigits: '5135550203', suggestedLeadId: 'LDEL', suggestedLeadName: 'Deleted Person' }),
    call('cube_TAG1', { contactName: 'Morgan New', phoneDigits: '5135550204', tags: ['customer'] }),
    call('cube_PLAIN', { contactName: 'Plain Contact', phoneDigits: '5135550205' }),
    call('cube_FILED', { contactName: 'Filed', phoneDigits: '5135550206', leadId: 'LD', bucket: 'customer', suggestedLeadId: 'LP' }));
  const leads = [
    { id: 'LD', firstName: 'Dana', lastName: 'Rivers', address: '412 Oak Hill Dr' },
    { id: 'LP', firstName: 'Pat', lastName: 'Example', phone: '', altPhone: '+1 (513) 555-0202' },
    { id: 'LDEL', firstName: 'Deleted', lastName: 'Person', deleted: true },
  ];
  let saved = [];
  const env = makeEnv({
    rootSel: '#view-calls .view-scroll',
    globals: Object.assign({}, fsGlobals, {
      _leads: leads,
      _saveLead: async (d) => { saved.push(d); const id = 'NEW' + saved.length; leads.push(Object.assign({ id }, d)); return id; },
    }),
    reply: (name, data) => (name === 'callCenterAction' ? { ok: true, leadId: data.leadId, refiled: { calls: 1, textDays: 0, texts: 2 } } : name === 'callPromisesList' ? { items: [], counts: {} } : null),
  });
  vm.runInContext(src, env.ctx);
  const CC = env.win.NBDCallCenter;
  CC._state.filter = 'all';
  await CC.reload();
  const html = env.target.innerHTML;
  const cardOf = (id) => { const i = html.indexOf('data-call-id="' + id + '"'); const j = html.indexOf('data-call-id="', i + 10); return i < 0 ? '' : html.slice(i, j < 0 ? undefined : j); };
  ok('stored suggestion → "Looks like Dana Rivers" + a one-tap File on button', /Looks like <b>Dana Rivers<\/b> — their name said on the call/.test(cardOf('cube_SUG1')) && /data-ccp="suggest" data-id="cube_SUG1" data-lead="LD"/.test(cardOf('cube_SUG1')), cardOf('cube_SUG1').slice(0, 600));
  ok('a caller-facts suggestion shows its reason on the chip: "name + Florence"', cardOf('cube_SUGF').includes('Looks like <b>Dana Rivers</b> — name + Florence.') && /data-ccp="suggest" data-id="cube_SUGF" data-lead="LD"/.test(cardOf('cube_SUGF')), cardOf('cube_SUGF').slice(0, 600));
  ok('a number already on a customer (their alt phone) → File on that customer', /Looks like <b>Pat Example<\/b> — this number is already on them/.test(cardOf('cube_NUM1')) && /data-lead="LP"/.test(cardOf('cube_NUM1')));
  ok('…and no "+ New lead" for that number (it would be a duplicate)', !/data-cc="newlead" data-id="cube_NUM1"/.test(cardOf('cube_NUM1')));
  ok('a suggestion naming a deleted customer is not shown', !/Looks like/.test(cardOf('cube_GONE')));
  ok('a tagged "NBD Customer" contact on no lead → Not in CRM yet + Make lead', /not in the CRM yet/.test(cardOf('cube_TAG1')) && /data-ccp="newlead" data-id="cube_TAG1"/.test(cardOf('cube_TAG1')));
  ok('a plain contact keeps the ordinary + New lead, no prompt', /data-cc="newlead" data-id="cube_PLAIN"/.test(cardOf('cube_PLAIN')) && !/cc-suggest/.test(cardOf('cube_PLAIN')));
  ok('a call already filed shows no suggestion', !/Looks like/.test(cardOf('cube_FILED')));
  ok('fileTarget: a day of texts is never offered for filing (attach is calls only)', typeof CC._fileTarget === 'function' && CC._fileTarget({ id: 'txt_1', channel: 'text', phoneDigits: '5135550202' }) === null);

  console.log('\n2. File on X — a tap, never automatic');
  ok('rendering filed nothing', !env.calls.some((c) => c.data && c.data.action === 'attach'));
  await env.click(button({ 'data-ccp': 'suggest', 'data-id': 'cube_SUG1', 'data-lead': 'LD', 'data-name': 'Dana Rivers' }, true));
  await flush();
  const at = env.calls.filter((c) => c.data && c.data.action === 'attach');
  ok('the tap sends one attach for that call and customer', at.length === 1 && at[0].data.id === 'cube_SUG1' && at[0].data.leadId === 'LD');
  ok('the status says what else came with it', /Filed on Dana Rivers \(plus 1 more from this number\)/.test(env.slots.cube_SUG1 || ''), env.slots.cube_SUG1);

  console.log('\n3. No duplicate leads from the call screens');
  saved = [];
  const mk = button({ 'data-ccp': 'newlead', 'data-id': 'cube_NUM1' }, false);
  await env.click(mk);
  await flush();
  ok('Make lead on a number already on a customer makes NO lead', saved.length === 0);
  ok('…and turns into "File on Pat Example" instead', mk.getAttribute('data-ccp') === 'suggest' && mk.getAttribute('data-lead') === 'LP' && mk.textContent === 'File on Pat Example' && /already on Pat Example/.test(env.slots.cube_NUM1 || ''));
  // Two cards for one new number: the first makes the lead, the second files on it.
  rows.push(call('cube_TWO1', { contactName: 'Casey Two', phoneDigits: '5135550299' }), call('cube_TWO2', { contactName: 'Casey Two', phoneDigits: '5135550299' }));
  await CC.reload();
  const before = env.calls.length;
  // Leads list hasn't refreshed yet (the new lead isn't in _leads).
  const leadsSnapshot = leads.slice();
  env.win._saveLead = async (d) => { saved.push(d); return 'NEWCASEY'; };
  await env.click(button({ 'data-ccp': 'newlead', 'data-id': 'cube_TWO1' }, false));
  await flush();
  const second = button({ 'data-ccp': 'newlead', 'data-id': 'cube_TWO2' }, false);
  await env.click(second);
  await flush();
  ok('two cards for one number make ONE lead', saved.length === 1 && saved[0].phone === '(513) 555-0299' && saved[0].firstName === 'Casey', JSON.stringify(saved));
  ok('the second card offers the lead just made', second.getAttribute('data-lead') === 'NEWCASEY');
  ok('the first card filed its call on the new lead', env.calls.slice(before).some((c) => c.data.action === 'attach' && c.data.id === 'cube_TWO1' && c.data.leadId === 'NEWCASEY'));
  ok('_leads untouched by the guard (no fake leads added)', leads.length === leadsSnapshot.length);
  ok('leadForNumber: leading 1 and formatting ignored; deleted leads never match', typeof CC._leadForNumber === 'function' && CC._leadForNumber('1-513-555-0202').leadId === 'LP' && CC._leadForNumber('(513) 555-0203') === null);

  ['PXA', 'PXB', 'PXC'].forEach((id) => leads.push({ id, firstName: id, lastName: 'Relay', phone: '(513) 555-0777' }));
  ok('a number on 3+ customers is a proxy: not "already a customer", so no File on X from it', typeof CC._leadForNumber === 'function' && CC._leadForNumber('5135550777') === null
    && CC._fileTarget({ id: 'cube_PX', phoneDigits: '5135550777' }) === null);
  leads.splice(leads.length - 3, 3);

  console.log('\n4. Said you\'d do — one card per caller');
  const g = (CC._groupPromises || (() => []))([
    { callId: 'a', phoneDigits: '5135550300', leadId: null, kind: 'nofile' },
    { callId: 'b', phoneDigits: '+1 513 555 0300', leadId: null, kind: 'nofile' },
    { callId: 'c', phoneDigits: '5135550301', leadId: 'L9', kind: 'due' },
    { callId: 'd', phoneDigits: '5135550302', leadId: 'L9', kind: 'due', channel: 'text' },
    { callId: 'e', phoneDigits: '', leadId: null, kind: 'nofile' },
  ]);
  ok('two calls from one number are one card', g.length === 3 && g[0].key === 'num:5135550300' && g[0].id === 'a' && g[0].items.map((p) => p.callId).join() === 'a,b', JSON.stringify(g.map((x) => [x.key, x.items.length])));
  ok('a customer\'s calls and texts are one card', g[1].key === 'lead:L9' && g[1].items.length === 2);
  ok('a call with no number stands alone', g[2].key === 'id:e');

  console.log('\n5. Customer page: ✓ Handled + "Wrong customer → move to…"');
  const csrc = read('docs/pro/js/customer-calls.js');
  const prow = [{ _id: 'cube_C1', userId: 'u1', companyId: 'u1', leadId: 'HERE', status: 'noted', startedAtMs: NOW - 60e3, contactName: 'Sam', phoneDigits: '5135550400', summary: 'Siding quote.', promises: [], alternateLeadIds: ['ALTLEAD1'] }];
  const cleads = [{ id: 'HERE', firstName: 'Wrong', lastName: 'Person' }, { id: 'ALTLEAD1', firstName: 'Right', lastName: 'Person', address: '1 Main' }, { id: 'GONE', firstName: 'Del', deleted: true }];
  const inputs = { 'pcMove-cube_C1': { value: 'Right Person — 1 Main #ALTLEAD1' } };
  const moveBox = { hidden: true, innerHTML: '', querySelector: () => null };
  const cenv = makeEnv({
    rootSel: '#none', pathname: '/pro/customer.html', inputs,
    globals: {
      db: {}, auth: { currentUser: { uid: 'u1' } }, _customerId: 'HERE', _userClaims: {},
      collection: (_db, name) => name, where: () => null, orderBy: () => null, limit: () => null,
      query: (name) => name,
      getDocs: async (name) => ({ docs: name === 'phone_calls' ? prow.map((r) => ({ id: r._id, data: () => r })) : name === 'leads' ? cleads.map((l) => ({ id: l.id, data: () => l })) : [] }),
    },
  });
  const list = { innerHTML: '', querySelector: () => null };
  cenv.win.document.getElementById = (id) => (id === 'callsList' ? list : inputs[id] || null);
  cenv.win.document.querySelector = (sel) => (/data-calls-move/.test(sel) ? moveBox : null);
  vm.runInContext(csrc, cenv.ctx);
  for (let i = 0; i < 20 && !/data-call-card/.test(list.innerHTML); i++) await new Promise((r) => setTimeout(r, 320));
  ok('the phone call card has ✓ Handled and Wrong customer → move to…', /data-calls-act="pc-handled" data-call-id="phone:cube_C1"/.test(list.innerHTML) && /Wrong customer → move to…/.test(list.innerHTML), list.innerHTML.slice(0, 300));
  await cenv.click(button({ 'data-calls-act': 'pc-handled', 'data-call-id': 'phone:cube_C1' }));
  await flush();
  ok('✓ Handled sends handled for that call', cenv.calls.some((c) => c.name === 'callCenterAction' && c.data.id === 'cube_C1' && c.data.action === 'handled'));
  await cenv.click(button({ 'data-calls-act': 'pc-moveopen', 'data-call-id': 'phone:cube_C1' }));
  await flush(); await flush();
  ok('the picker offers the number\'s other customer first, never this one or a deleted one', /Move to Right Person/.test(moveBox.innerHTML) && !/#HERE"/.test(moveBox.innerHTML) && !/#GONE"/.test(moveBox.innerHTML), moveBox.innerHTML.slice(0, 400));
  await cenv.click(button({ 'data-calls-act': 'pc-move', 'data-call-id': 'phone:cube_C1' }));
  await flush(); await flush();
  const mv = cenv.calls.filter((c) => c.data.action === 'move');
  ok('Move sends the call and the picked customer to the server', mv.length === 1 && mv[0].data.id === 'cube_C1' && mv[0].data.leadId === 'ALTLEAD1');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
