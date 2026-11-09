/**
 * tests/call-to-close-said-2026-11-09.test.js — Call to Close P1: "said vs.
 * proposal". Before Generate on a proposal, list what a call said the work
 * includes that the proposal leaves out.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §5.2, §6 #3, §9 P1.
 *
 *   1. the matcher (docs/pro/js/call-to-close-logic.js saidVsProposal): fixed
 *      phrases only; grounded scope mentions and the service count; a promise
 *      counts only once a person ACCEPTED it on the brief shown; anything the
 *      proposal already says is left out; an unreliable transcript says
 *      nothing; each item carries its quote, never copied onto the document
 *   2. copyIntoScope: adds the fixed phrase once, to a new list
 *   3. loadLeadBriefs: a viewer reads nothing; a call nobody filed is skipped;
 *      briefs are read by their id path; failures are quiet
 *   4. doc-preflight.js: the check runs for a proposal only, after the form is
 *      open, never blocks Generate, and "Copy into scope" fills only the
 *      visible scope list (no write, no docOverrides seeding, Q10)
 *
 * Run: node tests/call-to-close-said-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const LOGIC_PATH = 'docs/pro/js/call-to-close-logic.js';

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)) : '')); }
}

const GEN = 1762365600000;
const brief = (over) => Object.assign({
  v: 1, transcriptOk: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Leak; wants gutters looked at.', quotes: ['the gutters are pulling off the fascia'], inferred: false },
  fields: { damageType: { value: 'hail', quote: 'hail storm', conf: 'said' } },
  scope: { service: { value: 'Roof replacement', quote: 'we want a whole new roof' }, mentions: { gutters: true, chimney: false, skylight: false, decking: false }, saidQuantities: [] },
  promises: [
    { who: 'jo', text: 'Include the skylight in the estimate', kind: 'estimate', quote: 'I will put the skylight in the estimate', dueYmd: '' },
    { who: 'jo', text: 'Check the chimney', kind: 'callback', quote: 'I will check the chimney too', dueYmd: '' },
  ],
  stage: null,
}, over || {});

(async () => {
  let C = null;
  try { C = require(path.join(ROOT, LOGIC_PATH)); } catch (e) { ok('call-to-close-logic.js loads in node', false, e.message); }

  console.log('\n1. The matcher');
  if (C) {
    const accepted0 = [{ item: 'promise:0', decision: 'accept', gen: GEN }];
    const rows = [{ callId: 'cube_A', brief: brief(), decisions: accepted0, generatedAtMs: GEN }];
    const empty = { projectDescription: 'Complete roof replacement.', scopeItems: ['Tear off', 'New shingles'], termsNote: '', lineItems: [{ description: 'Architectural shingles' }] };
    const out = C.saidVsProposal(rows, empty);
    const keys = out.map((x) => x.key);
    ok('a grounded scope mention the proposal leaves out is listed (gutters)', keys.includes('gutters'), out);
    ok('…with the words that were said', (out.find((x) => x.key === 'gutters') || {}).quote === 'the gutters are pulling off the fascia');
    ok('an ACCEPTED promise that names scope is listed (skylight), with its quote', keys.includes('skylight') && out.find((x) => x.key === 'skylight').quote === 'I will put the skylight in the estimate' && out.find((x) => x.key === 'skylight').from === 'promise');
    ok('a promise nobody accepted is not (chimney)', !keys.includes('chimney'));
    ok('a mention flag the server did not ground is not (decking false)', !keys.includes('decking'));
    ok('each item names its call', out.every((x) => x.callId === 'cube_A'));
    ok('the copy phrase is a fixed phrase from the vocabulary, never the model\'s words', out.every((x) => C.VOCAB.some((v) => v.key === x.key && v.phrase === x.phrase)) && !out.some((x) => /estimate|put the/i.test(x.phrase)));
    ok('no phrase carries a number', C.VOCAB.every((v) => !/\d/.test(v.phrase)));
    const covered = Object.assign({}, empty, { scopeItems: ['Tear off', 'Seamless 6" gutters'], lineItems: [{ description: 'Skylight flashing kit' }] });
    ok('anything the proposal already says (scope list or a line item) is left out', C.saidVsProposal(rows, covered).length === 0, C.saidVsProposal(rows, covered));
    ok('the project description counts too', !C.saidVsProposal(rows, Object.assign({}, empty, { projectDescription: 'New roof and gutters.' })).some((x) => x.key === 'gutters'));
    const oldGen = [{ callId: 'cube_A', brief: brief(), decisions: [{ item: 'promise:0', decision: 'accept', gen: GEN - 5 }], generatedAtMs: GEN }];
    ok('an accept made on an earlier brief of the call does not count (decisions keyed by gen)', !C.saidVsProposal(oldGen, empty).some((x) => x.key === 'skylight'));
    const skipped = [{ callId: 'cube_A', brief: brief(), decisions: accepted0.concat([{ item: 'promise:0', decision: 'skip', gen: GEN }]), generatedAtMs: GEN }];
    ok('the latest decision wins (accepted, then skipped → not listed)', !C.saidVsProposal(skipped, empty).some((x) => x.key === 'skylight'));
    const unreliable = [{ callId: 'cube_A', brief: brief({ transcriptOk: { reliable: false } }), decisions: accepted0, generatedAtMs: GEN }];
    ok('an unreliable transcript says nothing', C.saidVsProposal(unreliable, empty).length === 0);
    const two = [rows[0], { callId: 'cube_B', brief: brief({ summary: { text: '', quotes: ['gutters again'] } }), decisions: [], generatedAtMs: GEN }];
    const twoOut = C.saidVsProposal(two, empty);
    ok('one row per item across calls (the first call to say it gives the quote)', twoOut.filter((x) => x.key === 'gutters').length === 1 && twoOut.find((x) => x.key === 'gutters').callId === 'cube_A');
    const guards = [{ callId: 'cube_C', brief: brief({ scope: { service: { value: 'Gutter guards', quote: 'put gutter guards on' }, mentions: {} }, promises: [] }), decisions: [], generatedAtMs: GEN }];
    const gOut = C.saidVsProposal(guards, Object.assign({}, empty, { scopeItems: ['New gutters'] }));
    ok('gutter guards are their own item: gutters in the proposal do not cover them', gOut.length === 1 && gOut[0].key === 'gutterGuards', gOut);
    ok('no briefs, a bad row or no proposal → nothing, no throw', C.saidVsProposal([], empty).length === 0 && C.saidVsProposal([null, { brief: 'x' }], null).length === 0 && Array.isArray(C.saidVsProposal(rows, undefined)));
    ok('the matcher calls no model and no network', !/fetch\(|callable\(|anthropic|httpsCallable/i.test(read(LOGIC_PATH).split('function saidVsProposal')[1].split('function copyIntoScope')[0]));
  }

  console.log('\n2. Copy into scope');
  if (C) {
    const before = ['Tear off'];
    const after = C.copyIntoScope(before, 'Gutters');
    ok('adds the phrase at the end, as a new list', after.join('|') === 'Tear off|Gutters' && before.length === 1);
    ok('never twice', C.copyIntoScope(['Tear off', 'gutters'], 'Gutters').length === 2);
    ok('drops blank rows, accepts a single string', C.copyIntoScope(['', 'A', '  '], 'B').join('|') === 'A|B' && C.copyIntoScope('A', 'B').join('|') === 'A|B');
  }

  console.log('\n3. Reading the lead\'s briefs');
  if (C) {
    const reads = [];
    const fb = (calls, briefs, failOn) => ({
      db: {}, where: (f, op, v) => ({ f, op, v }), collection: (_db, name) => ({ name }), query: (c, ...w) => ({ c, w }),
      getDocs: async (q) => { reads.push({ kind: 'query', q }); if (failOn === 'query') throw new Error('denied'); return { docs: calls.map(([id, d]) => ({ id, data: () => d })) }; },
      doc: (_db, ...p) => p.join('/'),
      getDoc: async (p) => { reads.push({ kind: 'get', p }); if (failOn === 'get') throw new Error('denied'); const b = briefs[p]; return { exists: () => !!b, data: () => b }; },
    });
    const CALLS = [['cube_1', { leadId: 'L1', attachedBy: 'jo', startedAtMs: 2 }], ['cube_2', { leadId: 'L1', startedAtMs: 3 }], ['cube_3', { leadId: 'L1', movedBy: 'jo', startedAtMs: 1 }]];
    const BRIEFS = { 'leads/L1/call_briefs/cube_1': { brief: brief(), decisions: [], generatedAtMs: GEN }, 'leads/L1/call_briefs/cube_3': { brief: brief(), decisions: [], generatedAtMs: GEN } };
    const v = await C.loadLeadBriefs(fb(CALLS, BRIEFS), { uid: 'v', role: 'viewer', companyId: 'co1' }, 'L1');
    ok('a viewer reads nothing (no query at all)', v.length === 0 && reads.length === 0);
    const got = await C.loadLeadBriefs(fb(CALLS, BRIEFS), { uid: 'jo', role: '', companyId: 'jo' }, 'L1');
    ok('the owner gets the briefs of the calls a person filed, newest first', got.map((g) => g.callId).join(',') === 'cube_1,cube_3', got.map((g) => g.callId));
    ok('a call matched by number only (no attachedBy / movedBy) is never read', !reads.some((r) => r.kind === 'get' && /cube_2/.test(r.p)));
    ok('phone_calls is read by leadId + the user\'s own uid (the rules\' audience)', reads.some((r) => r.kind === 'query' && r.q.c.name === 'phone_calls' && r.q.w.some((w) => w.f === 'leadId' && w.v === 'L1') && r.q.w.some((w) => w.f === 'userId' && w.v === 'jo')));
    reads.length = 0;
    await C.loadLeadBriefs(fb(CALLS, BRIEFS), { uid: 'mg', role: 'manager', companyId: 'co1' }, 'L1');
    ok('a manager also reads the company\'s calls on the lead', reads.some((r) => r.kind === 'query' && r.q.w.some((w) => w.f === 'companyId' && w.v === 'co1')));
    const q = await C.loadLeadBriefs(fb(CALLS, BRIEFS, 'query'), { uid: 'jo' }, 'L1');
    const g = await C.loadLeadBriefs(fb(CALLS, BRIEFS, 'get'), { uid: 'jo' }, 'L1');
    ok('a refused read is quiet (no throw, nothing listed)', q.length === 0 && g.length === 0);
    ok('no lead or no Firestore → nothing', (await C.loadLeadBriefs({}, { uid: 'jo' }, 'L1')).length === 0 && (await C.loadLeadBriefs(fb(CALLS, BRIEFS), { uid: 'jo' }, '')).length === 0);
  }

  console.log('\n4. doc-preflight.js');
  {
    const src = read('docs/pro/js/doc-preflight.js');
    const submitBody = (src.split('async function submit()')[1] || '').split('\n  function applyPaymentAgreementPlan')[0];
    ok('Generate (submit) never waits on or reads the call check', submitBody.length > 0 && !/said|NBDCallToClose|call_briefs/i.test(submitBody));
    ok('the check is wired for a proposal only, and loads the logic lazily', /type === 'proposal'[\s\S]{0,200}loadSaid|loadSaid[\s\S]{0,400}'proposal'/.test(src) && /ScriptLoader\.load\([^)]*call-to-close-logic\.js|call-to-close-logic\.js/.test(src));
    ok('no <script> tag for the logic in any page', !/call-to-close-logic\.js/.test(read('docs/pro/customer.html')) && !/call-to-close-logic\.js/.test(read('docs/pro/dashboard.html')));
    // Run the real file in a sandbox and drive the panel's copy action.
    const listeners = {};
    const redraws = [];
    const writes = [];
    const win = {
      ScriptLoader: { load: async () => {} }, showToast: () => {},
      updateDoc: async () => { writes.push('updateDoc'); }, setDoc: async () => { writes.push('setDoc'); },
    };
    const doc = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, removeEventListener() {}, createElement: () => ({ style: {} }), head: { appendChild() {} }, body: { appendChild() {} } };
    const ctx = vm.createContext({ window: win, document: doc, console, setTimeout, CSS: { escape: (s) => s } });
    let DP = null;
    try { vm.runInContext(read(LOGIC_PATH), ctx); vm.runInContext(src, ctx); DP = win.DocPreflight; } catch (e) { ok('doc-preflight.js runs in a sandbox', false, e.message); }
    ok('DocPreflight exposes the said check for tests', !!(DP && DP._said && typeof DP._said.copy === 'function' && typeof DP._said.html === 'function'));
    if (DP && DP._said) {
      const st = DP._state;
      st.type = 'proposal';
      st.open = true;
      st.fieldIndex = { projectDescription: { key: 'projectDescription', persist: 'lead' }, scopeItems: { key: 'scopeItems', persist: 'document' } };
      st.values = { projectDescription: 'Complete roof replacement.', scopeItems: ['Tear off'] };
      st.callSaid = [{ key: 'gutters', label: 'Gutters', phrase: 'Gutters', quote: 'the <b>gutters</b> are pulling off', callId: 'cube_A', from: 'mention' }];
      const html = DP._said.html();
      ok('the panel lists the item with its quote, escaped', /Gutters/.test(html) && /&lt;b&gt;gutters&lt;\/b&gt;/.test(html) && !/<b>gutters/.test(html));
      ok('the panel says it never blocks Generate', /does not stop|never stops|you decide|Generate still/i.test(html));
      ok('…with a "Copy into scope" action, no inline handler or style', /data-dpf-said-copy="gutters"/.test(html) && /Copy into scope/.test(html) && !/\son[a-z]+=|style=/.test(html));
      DP._said.redraw = (k) => redraws.push(k);
      DP._said.copy('gutters');
      ok('Copy puts the fixed phrase in the visible scope list', st.values.scopeItems.join('|') === 'Tear off|Gutters', st.values.scopeItems);
      ok('…and nothing else: the description is untouched, nothing written', st.values.projectDescription === 'Complete roof replacement.' && writes.length === 0);
      ok('…the scope field is redrawn so the person sees it', redraws.includes('scopeItems'), redraws);
      ok('…the item drops off the list', !st.callSaid.some((x) => x.key === 'gutters'));
      DP._said.copy('nope');
      ok('an unknown item changes nothing', st.values.scopeItems.join('|') === 'Tear off|Gutters');
      st.callSaid = [];
      ok('no items → no panel', DP._said.html() === '');
    }
    const openBody = (src.split('  function open(type, customerId) {')[1] || '').split('\n  function close()')[0];
    ok('open() never seeds the scope list from a call (Q10): no copy before a tap', !/copyIntoScope|callSaid\s*=\s*[^[]/.test(openBody.replace(/state\.callSaid = \[\];/, '')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
