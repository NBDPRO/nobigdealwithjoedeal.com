/**
 * tests/customer-calls-by-number-2026-11-06.test.js — approved additive
 * feature (CRM audit 2026-11-06, CU-F06): the customer card's Calls list also
 * shows phone_calls matched by the customer's NUMBER.
 *
 * Most recorded calls (functions/call-center.js → phone_calls) carry
 * leadId: null and a 10-digit phoneDigits, so the leadId-only queries missed
 * them. fetchCalls now also reads phone_calls where phoneDigits == the lead's
 * number, inside the same userId / companyId scopes the rules allow, and never
 * claims a call already attached to a DIFFERENT customer.
 *
 * Runs the real fetchCalls / leadDigits extracted from customer-calls.js with
 * a stubbed Firestore. Zero deps. Run: node tests/customer-calls-by-number-2026-11-06.test.js
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
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'customer-calls.js'), 'utf8');
const EOL = SRC.includes('\r\n') ? '\r\n' : '\n';
function slice(start, end) {
  const s = SRC.indexOf(start);
  if (s < 0) return '';
  const e = SRC.indexOf(end, s);
  return e < 0 ? '' : SRC.slice(s, e + end.length);
}
const FN = slice('  function leadDigits() {', EOL + '  }') + '\n' + slice('  async function fetchCalls(leadId) {', EOL + '  }') + '\n' + slice('  function callTime(c) {', EOL + '  }');

// Docs in the stub "database"; each query is a list of [field, value] filters.
const CALLS = [
  { id: 'c-attached', d: { leadId: 'L1', userId: 'u1', companyId: 'co', phoneDigits: '5550101000', startedAtMs: 3 } },
  { id: 'c-unmatched', d: { leadId: null, userId: 'u1', companyId: 'co', phoneDigits: '5550101000', startedAtMs: 2 } },
  { id: 'c-other-lead', d: { leadId: 'L9', userId: 'u1', companyId: 'co', phoneDigits: '5550101000', startedAtMs: 1 } },
  { id: 'c-other-number', d: { leadId: null, userId: 'u1', companyId: 'co', phoneDigits: '5550109999', startedAtMs: 4 } },
];

async function run(lead, role) {
  const queries = [];
  const win = {
    db: {}, auth: { currentUser: { uid: 'u1' } }, _leadDoc: lead, _userClaims: { role: role || 'company_admin', companyId: 'co' },
    where: (f, op, v) => ({ f, v }), limit: (n) => ({ limit: n }), collection: (db, name) => ({ col: name }),
    query: (c, ...fs) => ({ col: c.col, filters: fs.filter((x) => x && x.f) }),
    getDocs: async (q) => {
      queries.push(q);
      const src = q.col === 'phone_calls' ? CALLS : [];
      const docs = src.filter((x) => q.filters.every((f) => x.d[f.f] === f.v)).map((x) => ({ id: x.id, data: () => x.d }));
      return { docs };
    },
  };
  const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Object, String, Number, Date,
    claims: () => win._userClaims, toDate: () => null };
  vm.createContext(sandbox);
  vm.runInContext(FN + '\nglobalThis.__f = fetchCalls;', sandbox);
  const out = await sandbox.__f('L1');
  return { ids: out.map((c) => c._id), out, queries };
}

(async () => {
  ok('fetchCalls + leadDigits are found (positive control)', /function leadDigits/.test(FN) && /async function fetchCalls/.test(FN));
  console.log('CALLS MATCHED BY NUMBER');
  {
    const r = await run({ phone: '(555) 010-1000' });
    ok('the call attached by leadId still shows (positive control)', r.ids.indexOf('c-attached') !== -1);
    ok('an unattached call on the customer\'s number now shows', r.ids.indexOf('c-unmatched') !== -1, r.ids.join(','));
    ok('…marked "matched by number"', (r.out.find((c) => c._id === 'c-unmatched') || {})._byNumber === true);
    ok('a call attached to a DIFFERENT customer is never claimed', r.ids.indexOf('c-other-lead') === -1);
    ok('a call on another number does not show', r.ids.indexOf('c-other-number') === -1);
    ok('no duplicates', new Set(r.ids).size === r.ids.length);
    const byNum = r.queries.filter((q) => q.filters.some((f) => f.f === 'phoneDigits'));
    ok('every by-number query is scoped by userId or companyId (rules)', byNum.length > 0 && byNum.every((q) => q.filters.some((f) => f.f === 'userId' || f.f === 'companyId')));
  }
  {
    const r = await run({ phone: '' });
    ok('a lead with no usable number runs no by-number query', !r.queries.some((q) => q.filters.some((f) => f.f === 'phoneDigits')));
  }
  {
    const r = await run({ phone: '+1 (555) 010-1000' });
    ok('a +1 number still matches', r.ids.indexOf('c-unmatched') !== -1);
  }
  {
    const r = await run({ phone: '(555) 010-1000' }, 'sales_rep');
    const byNum = r.queries.filter((q) => q.filters.some((f) => f.f === 'phoneDigits'));
    ok('a sales rep only reads by-number calls in their own userId scope', byNum.length === 1 && byNum[0].filters.some((f) => f.f === 'userId'));
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
