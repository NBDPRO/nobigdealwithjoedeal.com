/**
 * tests/nbd-os-runner-2026-11-09.test.js — the KRunner-style action runner
 * (NBD OS P2, design §6.4, uncommon #4): docs/pro/js/command-runner.js on top
 * of the Cmd+K palette (command-palette.js + command-palette-scopes.js).
 *
 * Checks:
 *   - pure: phone / maps links, the lead verbs, provider rows made safe, the
 *     Quick Key store (aliases, defaults, limits), the type-anywhere guard
 *     (WCAG 2.1.4) and the hot-corner box;
 *   - the provider registry: id + match required, reserved prefixes refused,
 *     a prefixed provider answers alone, a throwing provider is ignored;
 *   - the merge: lead verbs on the palette's own lead rows (its run stays the
 *     Open verb), provider rows lend verbs to a row with the same id, a Quick
 *     Key's target comes first, math/theme rows are left alone;
 *   - verbs per row run the right thing: Call = tel:, Navigate = the Maps
 *     search link, Text = a checked sms: link (phone-share.js asks "ok to
 *     text?"; never sent here), and nothing at all without phone-share;
 *   - keys: Tab / Shift+Tab / Right / Left between verbs, Tab past the last
 *     verb falls through (to the palette's lead pin);
 *   - escaping: hostile names, provider labels and verb labels are inert;
 *   - the real palette + layer + runner in a fake DOM: "12 Oak" shows the lead
 *     row with Open / Call / Text / Navigate buttons, a verb click runs it;
 *   - the real NBD OS desk (tests/lib/nbd-os-home-harness.js): the runner
 *     bundle loads on the laptop desk, typing on the bare desk opens the runner
 *     pre-filled, typing in an input or after a press in a window never does,
 *     the setting turns it off, the hot corner is off by default and opens
 *     after the 250 ms dwell when on, the Control Center switch toggles it;
 *   - wiring: lazy (no new script tag), no style attributes, no inline handlers,
 *     css on theme tokens only, no Firestore / network in the runner.
 *
 * Zero deps. Run: node tests/nbd-os-runner-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const RUNNER = 'docs/pro/js/command-runner.js';
if (!fs.existsSync(path.join(ROOT, RUNNER))) {
  ok('command-runner.js exists', false, RUNNER + ' is missing');
  console.log('\nFAILED ' + failed);
  process.exit(1);
}

/** A fresh runner in its own window (a fake DOM, localStorage, leads). */
function fresh(opts) {
  const o = opts || {};
  const dom = H.makeDom();
  const store = Object.assign({}, o.store || {});
  const timers = [];
  const W = {
    document: dom.document, console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    location: { href: '' }, opened: [], toasts: [],
    _leads: o.leads || [],
  };
  W.open = (u, t, f) => { W.opened.push([u, t, f]); };
  W.showToast = (m, k) => { W.toasts.push([String(m), k]); };
  if (o.phoneShare !== false) W.NBDPhoneShare = { checkText() { return Promise.resolve({ ok: true }); } };
  const ctx = vm.createContext(W);
  ctx.window = ctx;
  if (o.before) o.before(ctx, dom);
  vm.runInContext(read(RUNNER), ctx, { filename: RUNNER });
  const fire = (ms) => timers.forEach((t) => { if (t.fn && (ms == null || t.ms === ms)) { const f = t.fn; t.fn = null; f(); } });
  return { W: ctx, R: ctx.NBDRunner, dom, store, timers, fire };
}
const LEADS = [
  { id: 'L1', firstName: 'Pat', lastName: 'Oakley', address: '12 Oak St, Cincinnati, OH', phone: '(513) 555-0101' },
  { id: 'L2', firstName: '<img src=x onerror=alert(1)>', lastName: '', address: '9 Elm "Ave"', phone: '' },
  { id: 'L3', firstName: 'Dee', lastName: 'Four', address: '', phone: '1-513-555-0103' },
  { id: 'L4', firstName: 'Gone', lastName: 'Lead', address: '12 Oak Ct', phone: '5135550104', deleted: true },
];

const T0 = fresh();
const P = T0.R._pure;

console.log('RUNNER — pure helpers');
{
  ok('tel: is +1 and ten digits, an 11-digit 1-number too', P.telUrl('(513) 555-0101') === 'tel:+15135550101' && P.telUrl('1-513-555-0103') === 'tel:+15135550103');
  ok('a short or empty phone gives no link', P.telUrl('555-0101') === '' && P.telUrl('') === '' && P.smsUrl(null) === '');
  ok('sms: has the same shape', P.smsUrl('5135550101') === 'sms:+15135550101');
  ok('Navigate is the Google Maps search link the CRM already uses, encoded',
    P.mapsUrl('12 Oak St, Cincinnati') === 'https://www.google.com/maps/search/?api=1&query=12%20Oak%20St%2C%20Cincinnati' && P.mapsUrl('  ') === '');
  const v1 = P.leadVerbs(LEADS[0]).map((v) => v.id).join();
  ok('a lead with a phone and an address: Open, Call, Text, Navigate', v1 === 'open,call,text,nav', v1);
  ok('no phone: no Call, no Text', P.leadVerbs(LEADS[1]).map((v) => v.id).join() === 'open,nav');
  ok('no address: no Navigate', P.leadVerbs(LEADS[2]).map((v) => v.id).join() === 'open,call,text');
  ok('Text is marked as a checked sms: link', P.leadVerbs(LEADS[0]).filter((v) => v.id === 'text')[0].sms === true);
  ok('scoreText: prefix 100, substring 60, word prefixes 25, none 0',
    P.scoreText('oak', 'Oakley') === 100 && P.scoreText('kle', 'Oakley') === 60 && P.scoreText('ne le', 'New Lead') === 25 && P.scoreText('zzz', 'Oakley') === 0 && P.scoreText('', 'x') === 0);
}

console.log('\nRUNNER — provider rows are made safe');
{
  const run = () => {};
  ok('a row needs a label', P.normalizeRow({ label: '  ', actions: [{ id: 'a', run }] }, 'p', 0) === null);
  ok('a row needs at least one verb', P.normalizeRow({ label: 'X', actions: [] }, 'p', 0) === null);
  const r = P.normalizeRow({ label: 'X', actions: [{ id: 'a', label: 'A', href: 'javascript:alert(1)' }, { id: 'b', label: 'B', href: 'tel:+15135550101' }, { id: 'c', run }] }, 'p', 3, 'Mine');
  ok('a javascript: href is dropped; tel: and run() verbs stay', r.verbs.map((v) => v.id).join() === 'b,c', r && r.verbs.map((v) => v.id).join());
  ok('an id-less row gets prov:<provider>:<i>, the provider label is the group', r.id === 'prov:p:3' && r.group === 'Mine' && r.xrow === 'runner');
  const many = P.normalizeRow({ label: 'Y'.repeat(300), actions: Array.from({ length: 9 }, (_, i) => ({ id: 'v' + i, run })) }, 'p', 0);
  ok('labels are capped at 120 and verbs at 6', many.label.length === 120 && many.verbs.length === 6);
  ok('an https link verb opens outside; a protocol-relative one is refused',
    P.normalizeRow({ label: 'Z', actions: [{ href: 'https://example.com/a' }] }, 'p', 0).verbs[0].ext === true &&
    P.normalizeRow({ label: 'Z', actions: [{ href: '//evil.example' }] }, 'p', 0) === null);
}

console.log('\nRUNNER — Quick Keys (device-only aliases)');
{
  const D = P.parseAliases(null);
  ok('nothing stored = the defaults nl, rv, ds', D.nl === 'action-new-lead' && D.rv === 'runner:record-visit' && D.ds === 'runner:daily-success');
  ok('garbage stored = the defaults', P.parseAliases('{nope').nl === 'action-new-lead' && P.parseAliases('[1,2]').nl === 'action-new-lead');
  ok('a saved empty set stays empty (the rep removed them all)', Object.keys(P.parseAliases('{}')).length === 0);
  const parsed = P.parseAliases(JSON.stringify({ NL: 'go-crm', 'b a d': 'x', ok7chars: 'x', '<b>': 'x', zz: 42 }));
  ok('stored keys are normalized; bad keys and non-string targets dropped', JSON.stringify(parsed) === '{"nl":"go-crm"}', JSON.stringify(parsed));
  ok('normalizeAlias: 1-6 letters/digits, lower case', P.normalizeAlias(' RV ') === 'rv' && P.normalizeAlias('') === null && P.normalizeAlias('abcdefg') === null && P.normalizeAlias('a-b') === null);
  const s1 = P.setAlias(D, 'ds', 'go-crm');
  ok('setAlias replaces a key and leaves the input alone', s1.map.ds === 'go-crm' && D.ds === 'runner:daily-success');
  ok('setAlias explains a bad key or a missing target', /1 to 6/.test(P.setAlias(D, '??', 'x').error) && /Pick/.test(P.setAlias(D, 'ok', '').error));
  let big = {};
  for (let i = 0; i < 30; i++) big = P.setAlias(big, 'k' + i, 't').map;
  ok('at most 30 Quick Keys', /most Quick Keys/.test(P.setAlias(big, 'one', 't').error || '') && !!P.setAlias(big, 'k3', 'u').map);
  ok('removeAlias takes one key away', !('nl' in P.removeAlias(D, 'NL')) && 'rv' in P.removeAlias(D, 'NL'));
  ok('aliasTarget matches the whole box only', P.aliasTarget(D, ' NL ') === 'action-new-lead' && P.aliasTarget(D, 'nl x') === null && P.aliasTarget(D, 'n') === null);
  const T = fresh();
  T.R.quickKeys.set('xy', 'go-crm');
  ok('the store is the nbd_ localStorage key (sign-out wipes nbd_ keys)', /^nbd_/.test(P.QK_KEY) && JSON.parse(T.store[P.QK_KEY]).xy === 'go-crm' && JSON.parse(T.store[P.QK_KEY]).nl === 'action-new-lead');
  T.R.quickKeys.reset();
  ok('reset goes back to the defaults', !(P.QK_KEY in T.store) && T.R.quickKeys.get().nl === 'action-new-lead');
}

console.log('\nRUNNER — the type-anywhere guard (WCAG 2.1.4)');
{
  const base = { enabled: true, armed: true, onDesk: true, paletteOpen: false };
  const k = (key, extra) => Object.assign({ key, defaultPrevented: false }, extra || {});
  ok('a letter on the armed desk with the setting on opens', P.shouldTypeOpen(k('a'), base) === true && P.shouldTypeOpen(k('1'), base) === true);
  ok('the setting off: never', P.shouldTypeOpen(k('a'), Object.assign({}, base, { enabled: false })) === false);
  ok('focus not on the desk (an input, a window): never', P.shouldTypeOpen(k('a'), Object.assign({}, base, { onDesk: false })) === false);
  ok('not armed by a press on the desk background: never', P.shouldTypeOpen(k('a'), Object.assign({}, base, { armed: false })) === false);
  ok('the palette or a dialog already open: never', P.shouldTypeOpen(k('a'), Object.assign({}, base, { paletteOpen: true })) === false &&
    P.shouldTypeOpen(k('a'), Object.assign({}, base, { modalOpen: true })) === false);
  ok('modifier chords never (Ctrl, Cmd, Alt)', ['ctrlKey', 'metaKey', 'altKey'].every((m) => P.shouldTypeOpen(k('a', { [m]: true }), base) === false));
  ok('named keys, space and "/" (the palette\'s own key) never',
    ['Enter', 'Tab', 'Shift', 'Escape', 'ArrowDown', ' ', '/'].every((x) => P.shouldTypeOpen(k(x), base) === false));
  ok('IME composition and an already-handled key never', P.shouldTypeOpen(k('a', { isComposing: true }), base) === false && P.shouldTypeOpen(k('a', { defaultPrevented: true }), base) === false);
  ok('hot corner: within 2px of the top-left only', P.inCorner(0, 0) && P.inCorner(2, 2) && !P.inCorner(3, 0) && !P.inCorner(0, 3) && !P.inCorner(-1, 0));
  ok('the dwell is 250 ms', P.DWELL_MS === 250);
}

console.log('\nRUNNER — the provider registry');
{
  const T = fresh({ leads: LEADS });
  const R = T.R;
  ok('built in: leads, views, apps, settings', R.providers().filter((p) => p.builtin).map((p) => p.id).join() === 'leads,views,apps,settings');
  ok('a provider needs an id and match()', R.registerProvider({ id: 'x' }) === false && R.registerProvider({ match() { return []; } }) === false);
  ok('the palette\'s own prefixes are reserved', ['@', '#', '>', '=', 't:', 'T:'].every((p) => R.registerProvider({ id: 'r' + p, prefix: p, match: () => [] }) === false));
  let asked = null;
  ok('a custom prefix registers', R.registerProvider({ id: 'jobs-x', prefix: 'j:', label: 'Jobs X', match(q) { asked = q; return [{ label: 'Job <b>1</b>', actions: [{ id: 'go', label: 'Go', run() {} }] }]; } }) === true);
  const pre = R.decorate([{ id: 'go-crm', label: 'CRM' }], 'j: roof', {});
  ok('a prefixed query is answered by that provider alone, prefix stripped', pre.length === 1 && pre[0].label === 'Job <b>1</b>' && asked === 'roof', JSON.stringify(pre.map((r) => r.id)));
  R.registerProvider({ id: 'boom', match() { throw new Error('x'); } });
  R.registerProvider({ id: 'notarray', match() { return 'nope'; } });
  const plain = R.decorate([], 'zzzz', {});
  ok('a provider that throws or returns junk is skipped, not fatal', Array.isArray(plain));
  R.registerProvider({ id: 'jobs-x', prefix: 'j:', match() { return []; } });
  ok('the same id replaces the provider', R.providers().filter((p) => p.id === 'jobs-x').length === 1 && R.decorate([], 'j: x', {}).length === 0);
  R.unregisterProvider('jobs-x');
  ok('unregisterProvider removes it', !R.providers().some((p) => p.id === 'jobs-x'));
  // queued before load (NBDCommand.registerProvider stores them on window.__nbdCmdProviders)
  const T2 = fresh({ before(ctx) { ctx.__nbdCmdProviders = [{ id: 'early', match: () => [] }]; } });
  ok('providers queued before the runner loaded are registered on load', T2.R.providers().some((p) => p.id === 'early') && T2.W.__nbdCmdProviders.length === 0);
}

console.log('\nRUNNER — merging verbs into the palette\'s rows');
{
  const T = fresh({ leads: LEADS });
  const R = T.R;
  let opened = 0;
  const base = [
    { id: 'lead:L1', label: 'Pat Oakley', sublabel: '12 Oak St', group: 'Leads', card: { stage: 'Inspection', value: '$12,400' }, run() { opened++; } },
    { id: 'go-crm', label: 'CRM Kanban', group: 'Navigation', run() {} },
    { id: 'math:result', xrow: 'math', label: '$5', run() {} },
  ];
  const actions = () => [{ id: 'action-new-lead', label: 'New Lead', group: 'Actions', run() {} }, { id: 'go-crm', label: 'CRM Kanban', run() {} }];
  const out = R.decorate(base, '12 Oak', { allActions: actions });
  const lead = out.filter((r) => r.id === 'lead:L1');
  ok('the lead row gets Open, Call, Text, Navigate and stays one row', lead.length === 1 && lead[0].verbs.map((v) => v.label).join() === 'Open,Call,Text,Navigate', lead[0] && lead[0].verbs.map((v) => v.label).join());
  ok('a deleted lead never comes back as a provider row', !out.some((r) => r.id === 'lead:L4'));
  ok('the math row is left alone', out.filter((r) => r.id === 'math:result')[0].xrow === 'math' && !out.filter((r) => r.id === 'math:result')[0].verbs);
  lead[0].run();
  ok('Enter on the row runs the lit verb (Open = the palette\'s own run)', opened === 1);
  // provider rows lend verbs to a row with the same id; new ones are added under
  R.registerProvider({ id: 'mine', match: (q) => [
    { id: 'go-crm', label: 'CRM again', actions: [{ id: 'o', label: 'Open', run() {} }, { id: 'n', label: 'New tab', href: '/pro/dashboard.html#crm' }] },
    { label: 'Fresh row', sub: 'from mine', actions: [{ id: 'x', label: 'Do', run() {} }] },
  ] });
  const out2 = R.decorate(base, 'crm', { allActions: actions });
  ok('a provider row with an existing id adds verbs to that row, not a second row',
    out2.filter((r) => r.id === 'go-crm').length === 1 && out2.filter((r) => r.id === 'go-crm')[0].verbs.length === 2 && out2.filter((r) => r.id === 'go-crm')[0].label === 'CRM Kanban');
  ok('a new provider row is added under the palette\'s rows', out2[out2.length - 1].label === 'Fresh row' && out2[out2.length - 1].sublabel === 'from mine');
  R.unregisterProvider('mine');
  const empty = R.decorate(base.slice(0, 2), '', { allActions: actions });
  ok('an empty box asks no provider (the hot leads still get verbs)', empty.length === 2 && empty[0].verbs.length === 4);
  // Quick Key
  const qk = R.decorate(base, 'nl', { allActions: actions });
  ok('a Quick Key puts its target first, marked', qk[0].id === 'action-new-lead' && qk[0].group === 'Quick Key' && qk[0].sublabel === 'Quick Key nl');
  R.quickKeys.set('crm', 'go-crm');
  const qk2 = R.decorate(base, 'CRM', { allActions: actions });
  ok('a Quick Key target already in the list moves up, never twice', qk2[0].id === 'go-crm' && qk2.filter((r) => r.id === 'go-crm').length === 1);
  ok('a Quick Key whose target is not on the page shows nothing extra', R.decorate([], 'ds', { allActions: actions }).every((r) => r.group !== 'Quick Key'));
  // scoped @ / # rows
  const sc = R.decorateLeads([{ id: 'lead:L3', label: 'Dee Four', run() {} }, { id: 'lead:nope', label: 'Unknown', run() {} }]);
  ok('@ / # lead rows get verbs; a row whose lead is not loaded is left as it was', sc[0].verbs.map((v) => v.id).join() === 'open,call,text' && !sc[1].verbs);
}

console.log('\nRUNNER — verbs run the right thing');
{
  const T = fresh({ leads: LEADS });
  const rows = T.R.decorate([{ id: 'lead:L1', label: 'Pat', run() {} }], '', {});
  const vb = (id) => rows[0].verbs.filter((v) => v.id === id)[0];
  T.R.runVerb(vb('call'));
  ok('Call dials tel:+1…', T.W.location.href === 'tel:+15135550101');
  T.R.runVerb(vb('nav'));
  ok('Navigate opens the Maps search in a new tab, noopener', T.W.opened.length === 1 && /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=12%20Oak/.test(T.W.opened[0][0]) && T.W.opened[0][1] === '_blank' && T.W.opened[0][2] === 'noopener');
  T.W.location.href = '';
  T.R.runVerb(vb('text'));
  const a = T.dom.document.body.querySelector('a');
  ok('Text hands a checked sms: link to phone-share.js (data-ps-check, the lead id), never sends',
    a && a.getAttribute('href') === 'sms:+15135550101' && a.hasAttribute('data-ps-check') && a.getAttribute('data-ps-lead') === 'L1' && T.W.location.href === '');
  T.fire(0);
  ok('the link is removed again', !T.dom.document.body.querySelector('a'));
  const T2 = fresh({ leads: LEADS, phoneShare: false });
  const rows2 = T2.R.decorate([{ id: 'lead:L1', label: 'Pat', run() {} }], '', {});
  T2.R.runVerb(rows2[0].verbs.filter((v) => v.id === 'text')[0]);
  ok('without phone-share.js (no "ok to text?" check) Text opens nothing and says why',
    !T2.dom.document.body.querySelector('a') && T2.W.location.href === '' && /Texting isn't ready/.test((T2.W.toasts[0] || [])[0] || ''));
  let ran = 0;
  T.R.runVerb({ run() { ran++; throw new Error('verb boom'); } });
  ok('a verb that throws is contained', ran === 1);
}

console.log('\nRUNNER — keys between a row\'s verbs');
{
  const T = fresh({ leads: LEADS });
  const R = T.R;
  const rows = R.decorate([{ id: 'lead:L1', label: 'Pat', run() {} }, { id: 'go-crm', label: 'CRM', run() {} }], '', {});
  const input = { value: 'oak', selectionStart: 3 };
  const st = (i) => ({ results: rows, index: i, input });
  const ev = (key, extra) => Object.assign({ key, prevented: false, preventDefault() { this.prevented = true; } }, extra || {});
  R.onSelect(rows[0]);
  const e1 = ev('Tab');
  ok('Tab moves to the next verb (Call)', R.onKey(e1, st(0)) === true && e1.prevented);
  let lastHref = null;
  rows[0].verbs.forEach((v) => { if (v.id === 'call') lastHref = v.href; });
  T.W.location.href = '';
  rows[0].run();
  ok('Enter then runs the lit verb: Call', T.W.location.href === lastHref);
  ok('ArrowRight with the caret at the end moves on (Text)', R.onKey(ev('ArrowRight'), st(0)) === true);
  input.selectionStart = 1;
  ok('ArrowRight in the middle of the text is left to the caret', R.onKey(ev('ArrowRight'), st(0)) === false);
  input.selectionStart = 3;
  ok('ArrowLeft moves back', R.onKey(ev('ArrowLeft'), st(0)) === true);
  ok('Shift+Tab moves back', R.onKey(ev('Tab', { shiftKey: true }), st(0)) === true);
  ok('Shift+Tab on the first verb falls through', R.onKey(ev('Tab', { shiftKey: true }), st(0)) === false);
  R.onKey(ev('Tab'), st(0)); R.onKey(ev('Tab'), st(0)); R.onKey(ev('Tab'), st(0));
  ok('Tab on the last verb falls through (the palette then pins the lead)', R.onKey(ev('Tab'), st(0)) === false);
  R.onSelect(rows[1]);
  ok('a row without verbs is not handled', R.onKey(ev('Tab'), st(1)) === false);
  ok('only the selected row shows a lit verb', !/is-on/.test(R.rowHtml(rows[0], 0)));
  R.onSelect(rows[0]);
  T.W.location.href = '';
  let opened = 0; rows[0].verbs[0].run = () => { opened++; };
  rows[0].run();
  ok('selecting a row again starts at its first verb (Open)', opened === 1);
}

console.log('\nRUNNER — every field escaped');
{
  const T = fresh({ leads: LEADS });
  const rows = T.R.decorate([{ id: 'lead:L2', label: LEADS[1].firstName, sublabel: '9 Elm "Ave"', card: { stage: '<script>x</script>' }, run() {} }], '', {});
  const html = T.R.rowHtml(rows[0], 0);
  ok('a hostile lead name, stage and address are escaped', !/<img|<script/i.test(html) && html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('9 Elm &quot;Ave&quot;'));
  const prow = T.R._pure.normalizeRow({ label: '"><svg onload=alert(1)>', sub: "<i>'x'</i>", icon: '<b>', actions: [{ id: 'v', label: '<u>Go</u>', run() {} }] }, 'p', 0);
  const ph = T.R.rowHtml(prow, '1" onclick="x');
  ok('a provider label, sub, icon and verb label are escaped', !/<svg|<u>|<i>|<b>/.test(ph) && ph.includes('&lt;u&gt;Go&lt;/u&gt;'));
  ok('the row index is a number, never markup', /data-idx="0"/.test(ph) && !/onclick/.test(ph));
  ok('verb buttons are real buttons, out of the tab order (the box keeps focus)', (html.match(/<button type="button" tabindex="-1" class="cmdr-verb/g) || []).length === 2);
}

console.log('\nRUNNER — the real palette, layer and runner in a fake DOM');
{
  const dom = H.makeDom();
  const { document } = dom;
  // the palette reads row.dataset.idx; the shared fake DOM has no dataset
  Object.defineProperty(dom.El.prototype, 'dataset', { configurable: true, get() {
    const o = {};
    Object.keys(this.attrs).forEach((k) => { if (k.indexOf('data-') === 0) o[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = this.attrs[k]; });
    return o;
  } });
  const store = {};
  const timers = [];
  const W = {
    document, console: { log() {}, warn() {}, error() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    location: { href: '', pathname: '/pro/dashboard.html' }, opened: [], toasts: [], goTos: [],
    _leads: LEADS, Promise, Map, Set, JSON, Math, Object, Array, String, Number, RegExp, Error,
    NBDPhoneShare: {},
  };
  W.open = (u, t, f) => W.opened.push([u, t, f]);
  W.goTo = (id) => W.goTos.push(id);
  W.showToast = (m) => W.toasts.push(m);
  W.Event = function (t) { this.type = t; };
  document.createElement = ((orig) => (t) => { const el = orig(t); el.dispatchEvent = (ev) => { const f = (el.listeners[ev.type] || []).slice(); f.forEach((g) => g(Object.assign({ target: el }, ev))); }; return el; })(document.createElement);
  const ctx = vm.createContext(W);
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.runInContext(read('docs/pro/js/command-palette.js'), ctx);
  vm.runInContext(read('docs/pro/js/command-palette-scopes.js'), ctx);
  vm.runInContext(read(RUNNER), ctx);
  const C = ctx.NBDCommand;
  ok('NBDCommand.registerProvider exists and reaches the runner', typeof C.registerProvider === 'function');
  C.registerProvider({ id: 'tp', prefix: 'z:', match: () => [{ label: 'Zed row', actions: [{ id: 'z', label: 'Zap', run() { W.zapped = 1; } }] }] });
  ok('…registered on the runner', ctx.NBDRunner.providers().some((p) => p.id === 'tp'));
  C.open();
  const input = document.getElementById('nbd-cmd-input');
  input.value = '12 Oak';
  (input.listeners.input || []).forEach((f) => f({ target: input }));
  const list = document.getElementById('nbd-cmd-results');
  const row = list.querySelectorAll('.cmdr-row')[0];
  const verbs = row ? row.querySelectorAll('[data-cmdr-v]').map((b) => b.textContent) : [];
  ok('"12 Oak" shows the lead row with Open, Call, Text, Navigate', row && /Pat Oakley/.test(row.textContent) && verbs.join() === 'Open,Call,Text,Navigate', verbs.join());
  ok('the first verb is lit', row && row.querySelectorAll('.cmdr-verb')[0].classList.contains('is-on'));
  // Tab through the real palette keydown
  const kd = (k, extra) => (input.listeners.keydown || []).forEach((f) => f(Object.assign({ key: k, target: input, preventDefault() {} }, extra || {})));
  kd('Tab');
  ok('Tab in the box lights the next verb (Call)', row.querySelectorAll('.cmdr-verb')[1].classList.contains('is-on') && !row.querySelectorAll('.cmdr-verb')[0].classList.contains('is-on'));
  kd('Enter');
  timers.forEach((t) => { if (t.fn && t.ms === 0) { const f = t.fn; t.fn = null; f(); } });
  ok('Enter runs Call through the palette', W.location.href === 'tel:+15135550101' && !document.getElementById('nbd-cmd-modal'));
  // a verb button click runs that verb, never the row
  C.open();
  const input2 = document.getElementById('nbd-cmd-input');
  input2.value = '12 Oak';
  (input2.listeners.input || []).forEach((f) => f({ target: input2 }));
  const list2 = document.getElementById('nbd-cmd-results');
  const nav = list2.querySelectorAll('.cmdr-row')[0].querySelectorAll('[data-cmdr-v]')[3];
  H.fire(dom, nav, 'click');
  ok('clicking Navigate opens Maps and closes the palette (the row\'s own run never fires)',
    W.opened.length === 1 && /google\.com\/maps/.test(W.opened[0][0]) && !document.getElementById('nbd-cmd-modal'));
  // the custom prefix provider
  C.open();
  const input3 = document.getElementById('nbd-cmd-input');
  input3.value = 'z: anything';
  (input3.listeners.input || []).forEach((f) => f({ target: input3 }));
  const zr = document.getElementById('nbd-cmd-results').querySelectorAll('.cmdr-row');
  ok('a prefixed provider row renders with its verb', zr.length === 1 && /Zed row/.test(zr[0].textContent) && /Zap/.test(zr[0].textContent));
  // the Quick Keys editor
  ctx.NBDRunner.openEditor();
  const ed = document.querySelector('.cmdr-ed');
  ok('the Quick Keys editor opens inside the palette and hides the results', !!ed && document.getElementById('nbd-cmd-results').classList.contains('cmdr-hidden'));
  ok('it lists the default keys and offers the palette\'s actions', /nl/.test(ed.textContent) && ed.querySelectorAll('option').length > 10);
  ed.querySelector('.cmdr-ed-key').value = 'CK';
  ed.querySelector('.cmdr-ed-target').value = 'go-crm';
  H.fire(dom, ed.querySelector('[data-cmdr-add]'), 'click');
  ok('Add saves the key on this device', JSON.parse(store.nbd_cmd_quickkeys_v1).ck === 'go-crm' && /Saved: ck/.test(document.querySelector('.cmdr-ed').textContent));
  ed.querySelector('.cmdr-ed-key').value = 'b a d';
  H.fire(dom, ed.querySelector('[data-cmdr-add]'), 'click');
  ok('a bad key is explained, nothing saved', /1 to 6/.test(ed.querySelector('.cmdr-ed-msg').textContent) && !('b a d' in JSON.parse(store.nbd_cmd_quickkeys_v1)));
  const typeBox = ed.querySelector('[data-cmdr-opt="type"]');
  ok('"Type to search" is on by default; the hot corner is off', typeBox.hasAttribute('checked') && !ed.querySelector('[data-cmdr-opt="corner"]').hasAttribute('checked'));
  typeBox.checked = false;
  H.fire(dom, typeBox, 'change');
  ok('unticking it turns type-anywhere off (device-only)', store.nbd_runner_type_v1 === '0' && ctx.NBDRunner.typeOpen.on() === false);
  H.fire(dom, ed.querySelector('[data-cmdr-done]'), 'click');
  ok('Done closes the editor and shows the results again', !document.querySelector('.cmdr-ed') && !document.getElementById('nbd-cmd-results').classList.contains('cmdr-hidden'));
  // "Edit Quick Keys" through the palette's own run path (Enter -> _execute -> setTimeout -> open + editor)
  const flush0 = () => { let n; do { n = 0; timers.forEach((t) => { if (t.fn && t.ms === 0) { const f = t.fn; t.fn = null; f(); n++; } }); } while (n); };
  flush0();
  C.close();
  C.open();
  const in4 = document.getElementById('nbd-cmd-input');
  in4.value = 'Edit Quick Keys';
  (in4.listeners.input || []).forEach((f) => f({ target: in4 }));
  const qrow = document.getElementById('nbd-cmd-results').querySelectorAll('.nbd-cmd-row').filter((r) => /Edit Quick Keys/.test(r.textContent))[0];
  ok('control: the palette lists Edit Quick Keys', !!qrow);
  for (let i = 0; i < Number(qrow.getAttribute('data-idx')); i++) H.fire(dom, in4, 'keydown', { key: 'ArrowDown' });
  H.fire(dom, in4, 'keydown', { key: 'Enter' });
  flush0();
  const ed2 = document.querySelector('.cmdr-ed');
  const sIn = document.getElementById('nbd-cmd-input');
  ok('run from the palette, the editor opens with the Key field focused (not the hidden search box)',
    !!ed2 && document.activeElement === ed2.querySelector('.cmdr-ed-key'), document.activeElement && (document.activeElement.className || document.activeElement.id));
  const href0 = W.location.href, opened0 = W.opened.length, goTos0 = W.goTos.length;
  sIn.focus();
  H.fire(dom, sIn, 'keydown', { key: 'ArrowDown' });
  const en = H.fire(dom, sIn, 'keydown', { key: 'Enter' });
  flush0();
  ok('Enter / arrows in the search box while the editor is open run nothing it cannot see',
    !!document.getElementById('nbd-cmd-modal') && !!document.querySelector('.cmdr-ed') && W.location.href === href0 && W.opened.length === opened0 && W.goTos.length === goTos0 && en.defaultPrevented);
  sIn.value = 'crm';
  (sIn.listeners.input || []).forEach((f) => f({ target: sIn }));
  const res4 = document.getElementById('nbd-cmd-results');
  ok('typing in the search box closes the editor and shows the results', !document.querySelector('.cmdr-ed') && !!res4 && !res4.classList.contains('cmdr-hidden'));
}

console.log('\nRUNNER — on the real NBD OS laptop desk');
{
  const T = H.makeWin({ surface: 'desktop', loader: true, system: true, leads: LEADS });
  const W = T.W;
  let prefilled = null;
  W.NBDCommand = {
    open() { W.searches++; if (!T.document.getElementById('nbd-cmd-input')) { const i = T.document.createElement('input'); i.setAttribute('id', 'nbd-cmd-input'); T.document.body.appendChild(i); } },
    registerAction() {}, unregisterAction() {},
  };
  W._impl.mount({ surface: 'desktop' });
  // promises settle
  return Promise.resolve().then(() => new Promise((r) => setImmediate(r))).then(() => {
    ok('the laptop desk loads the runner as the cmdrunner bundle', !!W.NBDRunner && W.ScriptLoader.calls.indexOf('cmdrunner') !== -1 && W.ScriptLoader.bundles.cmdrunner[0] === 'js/command-runner.js?v=1');
    const desk = T.document.getElementById('osDesk');
    const area = desk.querySelector('.os-desk-area');
    const body = T.document.body;
    const typed = (target, k, extra) => H.fire(T.dom, target, 'keydown', Object.assign({ key: k }, extra || {}));
    const before = W.searches;
    typed(body, 'o');
    ok('typing before any press on the desk does nothing', W.searches === before);
    H.fire(T.dom, area, 'pointerdown');
    const ev = typed(body, 'o');
    const inp = T.document.getElementById('nbd-cmd-input');
    ok('a press on the bare desk, then a letter: the runner opens pre-filled', W.searches === before + 1 && inp && inp.value === 'o' && ev.defaultPrevented);
    T.document.getElementById('nbd-cmd-input').remove();
    // the dashboard keeps hidden aria-modal sheets in the page (mCreatePopover, mJobDetail…): they must not block it
    const sheet = T.document.createElement('div'); sheet.setAttribute('aria-modal', 'true'); sheet.hidden = true;
    T.document.body.appendChild(sheet);
    H.fire(T.dom, area, 'pointerdown');
    typed(body, 'p');
    ok('a hidden aria-modal sheet in the page does not block it', W.searches === before + 2 && T.document.getElementById('nbd-cmd-input').value === 'p');
    T.document.getElementById('nbd-cmd-input').remove();
    sheet.hidden = false;
    H.fire(T.dom, area, 'pointerdown');
    typed(body, 'q');
    ok('an open dialog on screen does', W.searches === before + 2);
    sheet.remove();
    W.searches -= 1;   // keep the counts below as they were
    const field = T.document.createElement('input');
    area.appendChild(field);
    H.fire(T.dom, area, 'pointerdown');
    typed(field, 'x');
    ok('typing in an input never opens it', W.searches === before + 1);
    H.fire(T.dom, field, 'focusin');
    typed(body, 'x');
    ok('focus moved into a control: typing on the page no longer opens it', W.searches === before + 1);
    // a press inside a window
    const win = T.document.createElement('div'); win.className = 'os-win';
    const inner = T.document.createElement('div'); win.appendChild(inner);
    desk.querySelector('.os-wins').appendChild(win);
    H.fire(T.dom, inner, 'pointerdown');
    typed(body, 'x');
    ok('a press inside a window: typing never opens it', W.searches === before + 1);
    H.fire(T.dom, desk.querySelector('.os-taskbar'), 'pointerdown');
    typed(body, 'x');
    ok('a press on the taskbar: typing never opens it', W.searches === before + 1);
    const col = desk.querySelector('.os-widgets');
    const card = T.document.createElement('div'); card.className = 'os-hw os-hw-glance';
    const cardText = T.document.createElement('span'); card.appendChild(cardText); col.appendChild(card);
    H.fire(T.dom, cardText, 'pointerdown');
    typed(body, 'x');
    ok('a press on a widget: typing never opens it', W.searches === before + 1);
    H.fire(T.dom, col, 'pointerdown');
    typed(body, 'c');
    ok('the widget column\'s empty space is desk: typing opens it', W.searches === before + 2 && T.document.getElementById('nbd-cmd-input').value === 'c');
    T.document.getElementById('nbd-cmd-input').remove();
    W.searches -= 1;
    H.fire(T.dom, area, 'pointerdown');
    typed(body, 'k', { ctrlKey: true });
    ok('Ctrl+letter on the desk is not type-anywhere', W.searches === before + 1);
    W.NBDRunner.typeOpen.set(false);
    H.fire(T.dom, area, 'pointerdown');
    typed(body, 'x');
    ok('the setting off: typing on the desk does nothing (WCAG 2.1.4)', W.searches === before + 1 && T.store.nbd_runner_type_v1 === '0');
    // Control Center switch
    const tile = W.controls.filter((c) => c.id === 'os-runner-type')[0];
    ok('the Control Center has a "Type to search" switch on the desk', !!tile && tile.label === 'Type to search' && tile.hint() === 'Off');
    tile.run();
    ok('…which turns it back on and says so', W.NBDRunner.typeOpen.on() === true && tile.hint() === 'On: type on the desktop' && /Type to search is on/.test(W.toasts[W.toasts.length - 1].msg));
    // hot corner
    const move = (x, y, extra) => H.fire(T.dom, body, 'pointermove', Object.assign({ clientX: x, clientY: y, pointerType: 'mouse', buttons: 0 }, extra || {}));
    const s0 = W.searches;
    const moves = () => (T.document.listeners.pointermove || []).length;
    const pm0 = moves();
    let cornerReads = 0;
    const gi = W.localStorage.getItem;
    W.localStorage.getItem = (k) => { if (k === W.NBDRunner._pure.CORNER_KEY) cornerReads++; return gi(k); };
    for (let i = 0; i < 20; i++) move(40 + i, 40);
    move(0, 0);
    T.fire(250);
    ok('the hot corner is off by default', W.searches === s0);
    ok('…and costs nothing while off: no storage read per mouse move', cornerReads === 0, cornerReads);
    W.NBDRunner.corner.set(true);
    ok('turning it on adds the one pointermove listener', moves() === pm0 + 1, moves() + ' vs ' + pm0);
    const cornerFn = T.document.listeners.pointermove[T.document.listeners.pointermove.length - 1];
    move(0, 0);
    move(100, 100);
    T.fire(250);
    ok('leaving the corner before 250 ms cancels it', W.searches === s0);
    move(1, 1);
    move(0, 1, { pointerType: 'touch' });
    T.fire(250);
    ok('a touch pointer never triggers it', W.searches === s0);
    move(1, 1);
    T.fire(250);
    ok('when on: resting in the top-left corner for 250 ms opens the runner', W.searches === s0 + 1);
    ok('the setting is cached: no storage read per move while on either', cornerReads === 0, cornerReads);
    W.NBDRunner.corner.set(false);
    ok('turning it off takes the listener away again', moves() === pm0);
    W.NBDRunner.corner.set(true);
    // phone: nothing attached, no switch
    W._impl.unmount();
    ok('unmount takes the Control Center switch down', !W.controls.some((c) => c.id === 'os-runner-type'));
    H.fire(T.dom, area, 'pointerdown');
    const s1 = W.searches;
    typed(body, 'z');
    ok('after unmount the desk listeners are gone (the hot corner\'s too)', W.searches === s1 && (T.document.listeners.pointermove || []).indexOf(cornerFn) === -1);
    const P2 = H.makeWin({ surface: 'phone', loader: true, system: true });
    P2.W._impl.mount({ surface: 'phone' });
    ok('the phone attaches no type-anywhere and shows no switch', P2.W.ScriptLoader.calls.indexOf('cmdrunner') === -1 && !(P2.W.controls || []).some((c) => c.id === 'os-runner-type'));
  }).then(hotkeyClash).then(finishWiring);
}

/** The fake document has no capture phase: give one (document capture, element capture, element bubble, document bubble). */
function withDocCapture(T) {
  const D = T.document, cap = {};
  const add = D.addEventListener, rem = D.removeEventListener;
  const isCap = (o) => o === true || !!(o && o.capture);
  D.addEventListener = (t, f, o) => { if (isCap(o)) (cap[t] = cap[t] || []).push(f); else add(t, f, o); };
  D.removeEventListener = (t, f, o) => { if (isCap(o)) cap[t] = (cap[t] || []).filter((x) => x !== f); else rem(t, f, o); };
  return function fireDoc(target, type, extra) {
    const ev = Object.assign({
      type, target, defaultPrevented: false, stopped: false, clientX: 10, clientY: 10,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; },
    }, extra || {});
    const chain = [];
    for (let n = target; n && n.attrs; n = n.parentNode) chain.push(n);
    const run = (fns) => (fns || []).slice().forEach((f) => { if (!ev.stopped) f(ev); });
    run(cap[type]);
    for (let i = chain.length - 1; i >= 0 && !ev.stopped; i--) run(chain[i].capture[type]);
    for (let i = 0; i < chain.length && !ev.stopped; i++) run(chain[i].listeners[type]);
    if (!ev.stopped) run(D.listeners[type]);
    return ev;
  };
}

function hotkeyClash() {
  console.log('\nRUNNER — type-anywhere wins over the dashboard\'s own N / E hotkeys');
  const T = H.makeWin({ surface: 'desktop', loader: true, system: true, leads: LEADS });
  const W = T.W, D = T.document;
  const fireDoc = withDocCapture(T);
  W.NBDCommand = {
    open() { W.searches++; if (!D.getElementById('nbd-cmd-input')) { const i = D.createElement('input'); i.setAttribute('id', 'nbd-cmd-input'); D.body.appendChild(i); } },
    registerAction() {}, unregisterAction() {},
  };
  // dashboard-bootstrap.module.js's single-letter hotkeys: a bubble-phase document listener added at boot
  const hot = { n: 0, e: 0 };
  D.addEventListener('keydown', (e) => {
    const t = e.target || {};
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n' || e.key === 'e') hot[e.key]++;
  });
  W._impl.mount({ surface: 'desktop' });
  return Promise.resolve().then(() => new Promise((r) => setImmediate(r))).then(() => {
    const area = D.getElementById('osDesk').querySelector('.os-desk-area');
    const s0 = W.searches;
    fireDoc(area, 'pointerdown');
    const ev = fireDoc(D.body, 'keydown', { key: 'n' });
    ok('typing "n" on the bare desk opens the runner pre-filled, and the N hotkey (New Lead) never fires',
      W.searches === s0 + 1 && D.getElementById('nbd-cmd-input').value === 'n' && hot.n === 0 && ev.defaultPrevented && ev.stopped, JSON.stringify(hot));
    D.getElementById('nbd-cmd-input').remove();
    fireDoc(area, 'pointerdown');
    fireDoc(D.body, 'keydown', { key: 'e' });
    ok('…nor "e" (New Estimate)', W.searches === s0 + 2 && hot.e === 0);
    D.getElementById('nbd-cmd-input').remove();
    W.NBDRunner.typeOpen.set(false);
    fireDoc(area, 'pointerdown');
    const ev2 = fireDoc(D.body, 'keydown', { key: 'n' });
    ok('with type-anywhere off the key is left alone: the hotkey gets it', W.searches === s0 + 2 && hot.n === 1 && !ev2.defaultPrevented);
    W.NBDRunner.typeOpen.set(true);
    W._impl.unmount();
  });
}

function finishWiring() {
  console.log('\nRUNNER — wiring');
  const cp = read('docs/pro/js/command-palette.js');
  ok('the palette exposes registerProvider and queues it until the runner loads', /registerProvider: function \(p\)/.test(cp) && /__nbdCmdProviders/.test(cp));
  ok('the palette passes Tab, Backspace and Left/Right to the layer', /\^\(Tab\|Backspace\|ArrowLeft\|ArrowRight\)\$/.test(cp));
  ok('augment gets the action list (Quick Key targets)', /x\.augment\(base, query, \{ allActions: _allActions \}\)/.test(cp));
  const sc = read('docs/pro/js/command-palette-scopes.js');
  ok('the layer loads the runner lazily as the cmdrunner bundle', /SL\.bundles\.cmdrunner = \[RUNNER_SRC\]/.test(sc) && /RUNNER_SRC = 'js\/command-runner\.js\?v=1'/.test(sc));
  ok('the layer hands rows, keys, selection and paint to the runner', /R\.decorate\(out, raw, ctx\)/.test(sc) && /runner\(\)\.onKey\(e, st\)/.test(sc) && /runner\(\)\.onSelect\(item\)/.test(sc) && /runner\(\)\.afterRender\(listEl\)/.test(sc));
  const html = read('docs/pro/dashboard.html') + read('docs/pro/customer.html');
  ok('no page gained a script tag for the runner', !/command-runner/.test(html));
  const os = read('docs/pro/js/layouts/os.js');
  ok('the OS desk loads it (cmdrunner bundle) and detaches it on unmount', /SL\.loadBundle\('cmdrunner'\)/.test(os) && /st\.runnerOff/.test(os));
  const src = strip(read(RUNNER));
  ok('no style attributes, no inline handlers, no el.style writes', !/\bstyle\s*=\s*\\?["'`]/.test(src) && !/\son[a-z]+\s*=\s*["']/i.test(src) && !/\.style\.[a-z]+\s*=(?!=)/.test(src));
  ok('no Firestore, callable or network in the runner', !/\b(getDoc|getDocs|onSnapshot|setDoc|updateDoc|addDoc|httpsCallable|fetch)\s*\(/.test(src));
  ok('innerHTML only ever gets editorHtml (escaped)', (src.match(/\.innerHTML\s*=/g) || []).length === 1 && /ed\.innerHTML = editorHtml\(msg\)/.test(src));
  const css = strip(read('docs/pro/css/command-runner.css'));
  ok('css: no hex literal, no animation or transition', (css.match(/#[0-9a-f]{3,8}\b/gi) || []).length === 0 && !/animation|transition/.test(css));
  const used = [...new Set((css.match(/var\(\s*(--[a-z0-9-]+)/g) || []).map((s) => s.replace(/var\(\s*/, '')))];
  const defined = (n) => ['docs/pro/css/theme-system.css', 'docs/pro/css/dashboard-app.css'].some((f) => new RegExp(n.replace(/-/g, '\\-') + '\\s*:').test(read(f)));
  const undef = used.filter((t) => !defined(t));
  ok('css: every theme token it reads exists (' + used.length + ')', used.length >= 5 && undef.length === 0, undef.join(', '));
  ok('css: 44px targets, no text under 11px', /min-height: 44px/.test(css) && !(css.match(/font-size:\s*(\d+(?:\.\d+)?)px/g) || []).some((m) => parseFloat(m.replace(/[^\d.]/g, '')) < 11));
  const scss = read('docs/pro/css/command-palette-scopes.css');
  ok('the scope chips (@ # > = t:) are 44px on a phone / touch screen', /\(max-width: 640px\), \(pointer: coarse\)[\s\S]*\.cmdx-hint, \.cmdx-chip \{ min-height: 44px/.test(scss));
  console.log('\n' + (failed ? 'FAILED ' + failed : 'PASSED ' + passed) + ' (' + passed + ' ok)');
  process.exit(failed ? 1 : 0);
}
