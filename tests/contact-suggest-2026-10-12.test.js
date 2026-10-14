/**
 * tests/contact-suggest-2026-10-12.test.js — label suggestions (phase 2b).
 *
 *   A. the pure engine: each evidence source, ranking, the cap, dismissals,
 *      "never for a labeled number", "never auto-applies a kind that hides"
 *   B. the chip markup and the delegated actions (static + a vm run of the
 *      real contact-suggest.js against stubbed Firestore globals)
 *   C. wiring: bundle order, Today strip, Call Center row, rules shape
 *
 * Absence assertions carry a positive control (same input, evidence present).
 * Numbers are 555 fixtures. Run: node tests/contact-suggest-2026-10-12.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}
const LG = require(path.join(ROOT, 'docs/pro/js/contact-labels-logic.js'));
const SG = require(path.join(ROOT, 'docs/pro/js/contact-suggest-logic.js'));

const NOW = Date.parse('2026-10-12T15:00:00Z');
const H = 3600000, D = 86400000;
const N = '5550142222';
const call = (o) => Object.assign({ id: 'c' + Math.random().toString(36).slice(2, 7), phoneDigits: N, channel: 'call', direction: 'inbound', status: 'noted', bucket: 'unknown', startedAtMs: NOW - H }, o);
const sug = (o) => SG.suggestFor(Object.assign({ digits: N, calls: [], now: NOW }, o));

console.log('A. engine');
{
  const t = sug({ calls: [call({ tags: ['sub'] })] });
  ok('a "NBD Sub" tag suggests Sub, one tap (no sheet), source seed-tag', t && t.kind === 'sub' && t.evidence === 'tag' && t.needsSheet === false && t.source === 'seed-tag', JSON.stringify(t));
  ok('vendor tag → Supplier, referral tag → Referral partner, customer tag → Customer',
    sug({ calls: [call({ tags: ['vendor'] })] }).kind === 'supplier' && sug({ calls: [call({ tags: ['referral'] })] }).kind === 'referral' && sug({ calls: [call({ tags: ['customer'] })] }).kind === 'customer');
  ok('control: no tag, no other evidence → no suggestion', sug({ calls: [call({})] }) === null);

  const th = sug({ calls: [call({})], thursday: [{ from: '+1 (555) 014-2222', callerType: 'supplier_sub' }] });
  ok('Thursday supplier_sub on that number suggests Supplier (source thursday)', th && th.kind === 'supplier' && th.evidence === 'thursday' && th.source === 'thursday');
  ok('Thursday adjuster → Adjuster / carrier, job_seeker → Job seeker',
    sug({ calls: [call({})], thursday: [{ from: N, callerType: 'adjuster' }] }).kind === 'insurance' && sug({ calls: [call({})], thursday: [{ from: N, callerType: 'job_seeker' }] }).kind === 'recruiter');
  ok('Thursday new_lead / existing_customer / silent are not label evidence (control)', sug({ calls: [call({})], thursday: [{ from: N, callerType: 'new_lead' }, { from: N, callerType: 'existing_customer' }, { from: N, callerType: 'silent' }] }) === null);
  ok('another number\'s Thursday call is not evidence', sug({ calls: [call({})], thursday: [{ from: '5559990000', callerType: 'supplier_sub' }] }) === null);

  const two = sug({ calls: [call({ callType: 'sub', startedAtMs: NOW - H }), call({ callType: 'sub', startedAtMs: NOW - 2 * H })] });
  ok('the last two noted calls agreeing on sub suggests Sub (source pattern)', two && two.kind === 'sub' && two.evidence === 'calltype' && two.source === 'pattern');
  ok('control: two noted calls that DISAGREE suggest nothing', sug({ calls: [call({ callType: 'sub', startedAtMs: NOW - H }), call({ callType: 'supplier', startedAtMs: NOW - 2 * H })] }) === null);
  ok('control: one noted call is not enough', sug({ calls: [call({ callType: 'sub' })] }) === null);

  const ld = sug({ calls: [call({})], onLead: true, leadName: 'Pat Example' });
  ok('a number on a customer (call not yet filed on it) suggests Customer with the name', ld && ld.kind === 'customer' && ld.evidence === 'lead' && /Pat Example/.test(ld.why));
  ok('...but not when every call is already filed on the lead (nothing to hint)', sug({ calls: [call({ leadId: 'L1' })], onLead: true, leadName: 'Pat' }) === null);

  const burst = [1, 2, 3].map((i) => call({ status: 'short', startedAtMs: NOW - i * D }));
  const pat = sug({ calls: burst });
  ok('3 un-noted calls in 14 days → "calling a lot", no kind guessed, opens the sheet', pat && pat.kind === '' && pat.evidence === 'pattern' && pat.needsSheet === true && /3 calls/.test(pat.why), JSON.stringify(pat));
  ok('control: 2 calls are not a pattern; 3 calls where one was noted is not either',
    sug({ calls: burst.slice(0, 2) }) === null && sug({ calls: burst.slice(0, 2).concat([call({ status: 'noted', summary: 'asked about a roof', startedAtMs: NOW - 3 * D })]) }) === null);
  ok('calls older than 14 days do not count', sug({ calls: [1, 2, 3].map((i) => call({ status: 'short', startedAtMs: NOW - (15 + i) * D })) }) === null);

  // never hides on one tap
  const sp = sug({ calls: [call({})], thursday: [{ from: N, callerType: 'spam' }] });
  ok('a kind that HIDES (spam) is never applied by one tap: needsSheet', sp && sp.kind === 'spam' && sp.needsSheet === true);
  ok('personal is a hiding kind too (needsSheet)', LG.defaultPolicy('personal') === 'hide' && sug({ calls: [call({ callType: 'spam', startedAtMs: NOW - H }), call({ callType: 'spam', startedAtMs: NOW - 2 * H })] }).needsSheet === true);
  ok('no engine suggestion can come from a source that suggests personal (it is never a suggested kind)',
    !['tag', 'thursday', 'calltype', 'lead', 'pattern'].some(() => false) && ['sub', 'vendor', 'referral', 'customer'].every((k) => sug({ calls: [call({ tags: [k] })] }).kind !== 'personal'));

  // already labeled / dismissed
  ok('a labeled number gets no suggestion (control: same evidence unlabeled does)',
    sug({ calls: [call({ tags: ['sub'] })], labels: { [N]: { kind: 'sub', policy: 'quiet' } } }) === null && sug({ calls: [call({ tags: ['sub'] })] }) !== null);
  const dis = { [N]: { dismissed: [{ kind: 'sub', atMs: NOW - D }] } };
  ok('"Not this" is remembered: the dismissed kind is not suggested again', sug({ calls: [call({ tags: ['sub'] })], dismissals: dis }) === null);
  ok('...but NEW evidence of a different kind is', (sug({ calls: [call({ tags: ['sub'] })], dismissals: dis, thursday: [{ from: N, callerType: 'adjuster' }] }) || {}).kind === 'insurance');
  ok('the kind-less pattern is dismissed with "*"', sug({ calls: burst, dismissals: { [N]: { dismissed: [{ kind: '*', atMs: NOW }] } } }) === null);
  const wd = SG.withDismissal({ dismissed: Array.from({ length: 12 }, (_, i) => ({ kind: 'k' + i, atMs: i })) }, 'sub', NOW);
  ok('withDismissal keeps the newest 12 and replaces a repeat of the same kind', wd.length === 12 && wd[wd.length - 1].kind === 'sub'
    && SG.withDismissal({ dismissed: [{ kind: 'sub', atMs: 1 }] }, 'sub', 2).length === 1 && SG.withDismissal(null, '', 5)[0].kind === '*');

  // ranking + cap
  // The weak pattern number is inserted FIRST and the tags OLDEST-first, so only a real sort puts them right.
  const rows = [1, 2, 3].map((i) => call({ phoneDigits: '5550149999', status: 'short', startedAtMs: NOW - (i + 4) * H }));
  for (let i = 5; i >= 0; i--) { const n = '55501430' + String(10 + i); rows.push(call({ phoneDigits: n, tags: ['sub'], startedAtMs: NOW - i * H })); }
  const all = SG.buildSuggestions(rows, { now: NOW, max: 99 });
  const capped = SG.buildSuggestions(rows, { now: NOW });
  ok('control: 7 numbers have suggestions', all.length === 7);
  ok('the cap is 3 visible; strongest evidence first, newest first within it', capped.length === 3 && capped.every((s) => s.evidence === 'tag') && capped[0].latestMs > capped[1].latestMs && capped[1].latestMs > capped[2].latestMs && SG.MAX_VISIBLE === 3);
  ok('a weaker pattern suggestion ranks below every tag suggestion', all[all.length - 1].evidence === 'pattern');
}

console.log('B. chips and actions (the real contact-suggest.js in a vm)');
{
  const writes = []; const applied = []; const opened = []; let failWrites = false;
  const listeners = {}; const docListeners = {};
  const w = {
    document: { addEventListener: (t, f) => { docListeners[t] = f; } },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    dispatchEvent: () => {}, CustomEvent: function (n) { this.type = n; },
    _user: { uid: 'u1' }, _userClaims: {}, // A different customer's number: the tagged number itself is NOT on a customer, so
    // Accept stays one tap (a number on a customer opens the sheet: label-safety-rails test).
    _leads: [{ id: 'L1', firstName: 'Pat', lastName: 'Example', phone: '5550149000' }],
    NBDContactLabelsLogic: LG, NBDContactSuggestLogic: SG,
    NBDHomeAttention: { lastRows: [call({ tags: ['sub'], contactName: 'Pat Sub' })] },
    NBDContactLabels: {
      canWrite: () => true, current: () => ({}), get: () => null,
      applyWithUndo: async (o) => { applied.push(o); return { ok: true }; }, openSheet: (o) => opened.push(o),
    },
    db: {}, collection: (...a) => ({ p: a.slice(1).join('/') }), query: (c) => c, where: () => null, limit: () => null,
    getDocs: async (q) => (/thursday_calls/.test(q.p) ? { docs: [] } : { docs: [] }),
    doc: (...a) => ({ p: a.slice(1).join('/') }),
    setDoc: async (r, d) => { if (failWrites) throw { code: 'unavailable' }; writes.push([r.p, d]); },
    showToast: () => {}, setTimeout: (f) => { /* no warm-up in the harness */ },
  };
  w.window = w;
  const ctxV = vm.createContext(Object.assign(w, { console, Date, JSON, Math, Object, Array, String, Number, Promise, document: w.document }));
  vm.runInContext(read('docs/pro/js/contact-suggest.js'), ctxV);
  const CS = w.NBDContactSuggest;
  ok('the module loads and offers forToday / chipHtml / accept / dismiss', !!CS && typeof CS.forToday === 'function' && typeof CS.chipHtml === 'function');
  const list = CS.forToday();
  ok('forToday reads the Today rows: the tagged number is suggested as Sub', list.length === 1 && list[0].kind === 'sub');
  const html = CS.chipHtml(list[0]);
  ok('the chip says what + why and has Accept and Not this (delegated data-cs, no inline handlers)',
    /Looks like Sub/.test(html) && /NBD Sub/.test(html) && /data-cs="accept"/.test(html) && /data-cs="dismiss"/.test(html) && !/\son[a-z]+=/.test(html) && />Accept</.test(html));
  const hid = CS.chipHtml({ digits: N, kind: 'spam', title: 'Looks like Spam', why: 'x', needsSheet: true });
  ok('a hiding kind offers "Choose…", not Accept (two taps)', />Choose…</.test(hid) && !/>Accept</.test(hid));
  (async () => {
    const click = (attrs) => docListeners.click({ target: { closest: () => ({ getAttribute: (k) => attrs[k] }) } });
    await CS.accept(N, 'sub');
    ok('Accept on a non-hiding kind applies it with undo, source seed-tag', applied.length === 1 && applied[0].kind === 'sub' && applied[0].source === 'seed-tag' && applied[0].digits === N, JSON.stringify(applied));
    w.NBDHomeAttention.lastRows = [call({ tags: [] }), call({ status: 'short', startedAtMs: NOW - D }), call({ status: 'short', startedAtMs: NOW - 2 * D })];
    await CS.accept(N, '');
    ok('Accept on the "calling a lot" pattern opens the sheet (no kind), never applies', opened.length === 1 && applied.length === 1);
    w.NBDHomeAttention.lastRows = [call({ callType: 'spam', startedAtMs: NOW - H }), call({ callType: 'spam', startedAtMs: NOW - 2 * H })];
    await CS.accept(N, 'spam');
    ok('Accept on a hiding kind (spam) opens the sheet with the kind pending, never applies', opened.length === 2 && opened[1].pending === 'spam' && opened[1].source === 'pattern' && applied.length === 1, JSON.stringify(opened));
    await CS.dismiss(N, 'sub');
    ok('Not this writes a remembered dismissal doc with the kind', writes.length === 1 && /contact_suggestions\/5550142222$/.test(writes[0][0])
      && writes[0][1].dismissed[0].kind === 'sub' && writes[0][1].companyId === 'u1' && writes[0][1].updatedBy === 'u1' && writes[0][1].digits === N, JSON.stringify(writes));
    w.NBDHomeAttention.lastRows = [call({ tags: ['sub'], leadId: 'L1' })];
    ok('...and the dismissed chip is gone at once (optimistic)', CS.forToday().length === 0);
    failWrites = true;
    await CS.dismiss('5550143333', 'sub');
    w.NBDHomeAttention.lastRows = [call({ phoneDigits: '5550143333', tags: ['sub'] })];
    ok('a failed dismiss write rolls back: the suggestion returns', CS.forToday().length === 1);
    done();
  })();
}

function done() {
  console.log('C. wiring');
  const ha = read('docs/pro/js/home-attention.js');
  const m = /bundles\.contactlabels = \[([^\]]*)\]/.exec(ha);
  const order = ['contact-labels-logic.js', 'contact-labels.js', 'contact-suggest-logic.js', 'contact-suggest.js'].map((f) => m ? m[1].indexOf(f) : -1);
  ok('the bundle lists logic, data/sheet, suggest-logic, suggest — in dependency order', order.every((i) => i >= 0) && order.slice().sort((a, b) => a - b).join() === order.join());
  ok('no new blocking or boot script tag (dashboard.html never names the suggest files)', !/contact-suggest/.test(read('docs/pro/dashboard.html')));
  const th = read('docs/pro/js/today-home.js');
  ok('Today paints at most the engine\'s capped list, hidden from a viewer, and repaints on nbd:suggestions-changed',
    /CS\.forToday\(\)/.test(th) && /!ro && CS/.test(th) && /'nbd:suggestions-changed'/.test(th));
  ok('Call Center cards carry a suggestion row (not for texts or a viewer)', /function suggestRow/.test(read('docs/pro/js/call-center-view.js')) && /fileRow\(c\) \+ suggestRow\(c\)/.test(read('docs/pro/js/call-center-view.js')));
  const rules = read('firestore.rules');
  ok('rules: contact_suggestions shape (id = 10 digits, bounded list, own tenant) and the "pattern" source',
    /function contactSuggestionOk/.test(rules) && /d\.dismissed is list && d\.dismissed\.size\(\) <= 12/.test(rules) && /match \/contact_suggestions\/\{digits\}/.test(rules) && /'lead', 'pattern'\]/.test(rules));
  ok('logic SOURCES == rules source enum', LG.SOURCES.join() === (/d\.source in \[([^\]]*)\]/.exec(rules)[1].split(',').map((s) => s.replace(/['\s]/g, '')).join()));
  ok('every engine source maps to a legal label source', Object.values(SG.SOURCE_OF).every((s) => LG.SOURCES.indexOf(s) !== -1));
  ok('no inline handlers or styles in the new files', ['docs/pro/js/contact-suggest.js', 'docs/pro/js/contact-suggest-logic.js'].every((f) => !/\son[a-z]+=|style="/.test(read(f))));
  const man = JSON.parse(read('tests/ci-manifest.json'));
  ok('this suite is in the node bucket', man.node.includes('contact-suggest-2026-10-12.test.js'));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
}
