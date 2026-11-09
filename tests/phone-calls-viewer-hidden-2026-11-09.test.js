/**
 * tests/phone-calls-viewer-hidden-2026-11-09.test.js — Call to Close Q11
 * (Jo, 2026-11-09): a user with the viewer role no longer reads phone_calls
 * (call transcripts, recording paths, AI notes).
 *
 * The rule itself is proven under the emulator in
 * tests/firestore-rules.cross-tenant.test.js (viewer denied, owner / admin /
 * company_admin / manager / solo owner still read, cross-tenant denied). This
 * suite pins the CLIENT half: every surface that reads phone_calls skips the
 * read for a viewer (a denied read would otherwise show as "Could not load"),
 * the Call Center and the customer card say quietly that calls are hidden, and
 * non-viewer roles still issue their reads.
 *
 * Runs the real fetchFrom (call-center-view.js) and fetchCalls
 * (customer-calls.js) against a stubbed Firestore; source checks for the
 * Home strip, the Inbox layout and the rule block. Zero deps.
 * Run: node tests/phone-calls-viewer-hidden-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function slicer(SRC) {
  const EOL = SRC.includes('\r\n') ? '\r\n' : '\n';
  return function (start, end) {
    const s = SRC.indexOf(start);
    if (s < 0) return '';
    const e = SRC.indexOf(end.replace(/\n/g, EOL), s);
    return e < 0 ? '' : SRC.slice(s, e + end.length + (EOL.length - 1) * (end.split('\n').length - 1));
  };
}

function stubWin(role, queries) {
  return {
    db: {}, auth: { currentUser: { uid: 'u1' } }, _user: { uid: 'u1' }, _leadDoc: { phone: '5550101000' },
    _userClaims: { role, companyId: 'co' },
    where: (f, op, v) => ({ f, v }), orderBy: () => ({}), limit: () => ({}),
    collection: (db, name) => ({ col: name }),
    query: (c, ...fs) => ({ col: c.col, filters: fs.filter((x) => x && x.f) }),
    getDocs: async (q) => {
      queries.push(q);
      if (q.col === 'phone_calls' && role === 'viewer') { const e = new Error('denied'); e.code = 'permission-denied'; throw e; }
      return { docs: [] };
    },
  };
}

// ── call-center-view.js: fetchFrom ────────────────────────────────────
const CCV = read('docs/pro/js/call-center-view.js');
const ccvSlice = slicer(CCV);
const FETCH_FROM = ccvSlice('  async function fetchFrom(name, channel) {', '\n  }\n');
async function runCcv(role) {
  const queries = [];
  const win = stubWin(role, queries);
  const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Object, Date, Infinity,
    state: { readFailed: [], error: '', cappedBefore: 0 }, LIMIT: 300, PROMISE_WINDOW_MS: 1,
    claims: () => win._userClaims, isViewer: () => win._userClaims.role === 'viewer' };
  vm.createContext(sandbox);
  vm.runInContext(FETCH_FROM + '\nglobalThis.__f = fetchFrom;', sandbox);
  const rows = await sandbox.__f('phone_calls', 'call');
  const texts = await sandbox.__f('phone_text_days', 'text');
  return { rows, texts, queries, state: sandbox.state };
}

// ── customer-calls.js: fetchCalls ─────────────────────────────────────
const CC = read('docs/pro/js/customer-calls.js');
const ccSlice = slicer(CC);
const FETCH_CALLS = ccSlice('  function leadDigits() {', '\n  }') + '\n' + ccSlice('  async function fetchCalls(leadId) {', '\n  }') + '\n' + ccSlice('  function callTime(c) {', '\n  }');
async function runCc(role) {
  const queries = [];
  const win = stubWin(role, queries);
  const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Object, String, Number, Date,
    claims: () => win._userClaims, toDate: () => null };
  vm.createContext(sandbox);
  vm.runInContext(FETCH_CALLS + '\nglobalThis.__f = fetchCalls;', sandbox);
  await sandbox.__f('L1');
  return { queries };
}

(async () => {
  console.log('CALL CENTER (call-center-view.js)');
  ok('fetchFrom is found (positive control)', /async function fetchFrom/.test(FETCH_FROM));
  {
    const v = await runCcv('viewer');
    ok('a viewer issues NO phone_calls read', !v.queries.some((q) => q.col === 'phone_calls'), v.queries.map((q) => q.col).join(','));
    ok('…so no "Could not load your calls" banner', v.state.readFailed.length === 0 && !v.state.error, JSON.stringify(v.state.readFailed));
    ok('a viewer still reads phone_text_days (texts are not part of Q11)', v.queries.some((q) => q.col === 'phone_text_days'));
    const m = await runCcv('manager');
    ok('a manager still reads phone_calls by userId and companyId', m.queries.filter((q) => q.col === 'phone_calls').length === 2);
    const a = await runCcv('company_admin');
    ok('a company_admin still reads phone_calls', a.queries.some((q) => q.col === 'phone_calls'));
    const s = await runCcv('');
    ok('a solo owner (no role) still reads own phone_calls', s.queries.some((q) => q.col === 'phone_calls' && q.filters.some((f) => f.f === 'userId')));
  }
  ok('the Call Center says "Calls are hidden for your role." for a viewer', /isViewer\(\)\) body = '<div class="cc-empty cc-hidden-note" role="status">Calls are hidden for your role\.<\/div>'/.test(CCV));
  ok('…and keeps the note above the texts a viewer still sees', /state\.calls\.length && isViewer\(\)\) body = '<div class="cc-empty cc-hidden-note"/.test(CCV));

  console.log('CUSTOMER CARD (customer-calls.js)');
  ok('fetchCalls is found (positive control)', /async function fetchCalls/.test(FETCH_CALLS));
  {
    const v = await runCc('viewer');
    ok('a viewer issues NO phone_calls read (leadId or by-number)', !v.queries.some((q) => q.col === 'phone_calls'), v.queries.map((q) => q.col).join(','));
    ok('a viewer still reads thursday_calls', v.queries.some((q) => q.col === 'thursday_calls'));
    const m = await runCc('manager');
    ok('a manager still reads phone_calls (leadId + by-number)', m.queries.filter((q) => q.col === 'phone_calls').length >= 3);
  }
  ok('the customer card says calls from the phone are hidden for a viewer', /if \(isViewer\(\)\) top \+= '<div class="pc-meta pc-hidden-note" role="status">Calls from your phone are hidden for your role\.<\/div>'/.test(CC));
  ok('…and a viewer with nothing else sees only that note, not "No calls yet"', /!calls\.length && !texts\.length && isViewer\(\)\) \{ el\.innerHTML = top; return; \}/.test(CC));

  console.log('HOME STRIP / INBOX / SPEED-TO-LEAD');
  const HA = read('docs/pro/js/home-attention.js');
  const haReads = HA.match(/jobs\.push\([^\n]*'phone_calls'/g) || [];
  ok('home-attention has two phone_calls reads (positive control)', haReads.length === 2, String(haReads.length));
  ok('both are skipped for a viewer (no failed-read warning)', /const callsHidden = \(c\.role \|\| ''\) === 'viewer';/.test(HA) &&
    (HA.match(/if \(!callsHidden\) jobs\.push\(/g) || []).length === 2);
  const IB = read('docs/pro/js/layouts/inbox.js');
  ok('the Inbox layout skips its phone_calls read for a viewer', /var a = \(claims\(\)\.role \|\| ''\) === 'viewer' \? Promise\.resolve\(\) : W\.getDocs\(W\.query\(W\.collection\(W\.db, 'phone_calls'\)/.test(IB));
  const STL = read('docs/pro/js/speed-to-lead.js');
  ok('speed-to-lead call matching already never runs for a viewer', /function available\(\) \{ return flagOn\(\) && !isViewer\(\); \}/.test(STL) && /async function matchCalls\(\) \{\s*if \(matching \|\| !available\(\)/.test(STL));

  console.log('RULES (firestore.rules)');
  const RULES = read('firestore.rules');
  const block = (RULES.match(/match \/phone_calls\/\{docId\} \{[\s\S]*?\n    \}/) || [''])[0];
  ok('the phone_calls block is found (positive control)', /allow write: if false;/.test(block));
  ok('phone_calls read requires notViewer()', /allow read: if notViewer\(\)/.test(block));
  ok('phone_calls read no longer uses isCompanyReader() (which includes viewer)', block && !/isCompanyReader\(\)/.test(block));
  ok('same-company staff read is company_admin / manager only', /in \['company_admin', 'manager'\]\s*&& sameCompanyAsResource\(\)/.test(block));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
