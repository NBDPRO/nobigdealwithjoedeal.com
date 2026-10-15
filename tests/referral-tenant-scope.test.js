/**
 * tests/referral-tenant-scope.test.js — submitReferral must resolve the source
 * customer WITHIN ONE TENANT, and refuse rather than guess when it cannot.
 *
 * WHY
 * The resolver was `where('customerId','==',ref).limit(1)` — a global query
 * with no tenant scope. Whatever Firestore returned first won, and the new
 * lead is then created on sourceLead.userId's book under sourceLead.companyId.
 * So when two tenants held the same customerId, a homeowner's name, phone,
 * email and address were filed into the wrong company's CRM — silently to
 * both sides. Colliding with the platform tenant needs no cleverness at all:
 * customer-id.js mints un-salted sequential 'NBD-####'.
 *
 * HOW THIS TESTS IT
 * Rather than pinning the source text (which passes for the wrong reasons the
 * moment someone reformats it), this extracts the REAL resolution block out of
 * functions/referrals.js by brace-matching and executes it in a vm against a
 * stateful fake Firestore — the same approach as stripe-dispute-branches.js.
 * If the block is restructured, extraction fails loudly rather than silently
 * testing nothing.
 *
 * Zero deps. Run: node tests/referral-tenant-scope.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'functions', 'referrals.js'), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

// ── extract the resolution block ──────────────────────────────────────────
// From `let sourceLead = null;` through the end of its try/catch.
const START = 'let sourceLead = null;';
const startIdx = SRC.indexOf(START);
if (startIdx < 0) {
  console.error('FATAL: could not find the resolution block in functions/referrals.js.');
  console.error('If the resolver was restructured, update this extractor — do NOT delete the test.');
  process.exit(2);
}
/** End index (exclusive) of the {...} whose opening brace is at/after `from`. */
function matchBraces(src, from) {
  const open = src.indexOf('{', from);
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

const tryIdx = SRC.indexOf('try {', startIdx);
if (tryIdx < 0) { console.error('FATAL: no try block in the resolver'); process.exit(2); }
const tryEnd = matchBraces(SRC, tryIdx);
if (tryEnd < 0) { console.error('FATAL: could not brace-match the resolver try block'); process.exit(2); }
// The catch clause is part of the statement — cutting it off mid-call yields
// a syntax error rather than a useful failure, so match its body too.
const catchIdx = SRC.indexOf('catch', tryEnd);
const catchEnd = matchBraces(SRC, catchIdx);
if (catchIdx < 0 || catchEnd < 0) { console.error('FATAL: could not brace-match the resolver catch block'); process.exit(2); }
const BLOCK = SRC.slice(startIdx, catchEnd);

console.log('REFERRAL RESOLVER — TENANT SCOPING');
ok(`extracted the real resolution block (${BLOCK.length} chars)`, BLOCK.length > 300 && BLOCK.includes('customerId'));

// ── fake Firestore ────────────────────────────────────────────────────────
function makeDb({ leads = [], prefixes = {} }) {
  const calls = { queries: [], prefixGets: [] };
  return {
    calls,
    doc(p) {
      return {
        async get() {
          const m = /^docPrefixes\/(.+)$/.exec(p);
          if (m) {
            calls.prefixGets.push(m[1]);
            const v = prefixes[m[1]];
            return { exists: !!v, get: (k) => (v ? v[k] : undefined) };
          }
          const lm = /^leads\/(.+)$/.exec(p);
          const lead = lm ? leads.find(l => l.id === lm[1]) : null;
          return { exists: !!lead, id: lead && lead.id, data: () => (lead || {}) };
        },
      };
    },
    collection() {
      const q = { field: null, value: null, cap: null };
      const api = {
        where(f, _op, v) { q.field = f; q.value = v; return api; },
        limit(n) { q.cap = n; return api; },
        async get() {
          calls.queries.push({ ...q });
          const matched = leads.filter(l => l[q.field] === q.value).slice(0, q.cap || 100);
          return {
            empty: matched.length === 0,
            size: matched.length,
            docs: matched.map(l => ({ id: l.id, data: () => l, get: (k) => l[k] })),
          };
        },
      };
      return api;
    },
  };
}

async function resolve({ ref, leads, prefixes }) {
  const db = makeDb({ leads, prefixes });
  const logged = [];
  let badCall = null;
  const sandbox = {
    db, ref,
    logger: { warn: (m, d) => logged.push({ lvl: 'warn', m, d }), error: (m, d) => logged.push({ lvl: 'error', m, d }) },
    bad: (res, code, msg) => { badCall = { code, msg }; return { __bad: true }; },
    // 2026-10-15 (L1): every refused code answers through refUnavailable (one
    // uniform 404, the reason logged only) — same exit shape as bad().
    refUnavailable: (res, reason) => { badCall = { code: 404, msg: reason }; return { __bad: true }; },
    res: {},
    console,
  };
  // `return bad(...)` inside the block needs a function body to return from.
  const wrapped = `(async () => { ${BLOCK} ; return sourceLead; })()`;
  vm.createContext(sandbox);
  let out = await vm.runInContext(wrapped, sandbox, { timeout: 5000 });
  // `return bad(res, ...)` inside the block exits the handler early. In this
  // wrapper that value lands where sourceLead would, and it is truthy — which
  // would read as "a lead was resolved" and mask exactly the refusal we are
  // asserting. Normalise the early-return sentinel to "nothing resolved".
  if (out && out.__bad) out = null;
  return { sourceLead: out, badCall, logged, calls: db.calls };
}

(async () => {
  const OAK = { id: 'leadOak', customerId: 'OAK-0001-K3', companyId: 'co-oak', userId: 'oakRep' };
  const NBD = { id: 'leadNbd', customerId: 'NBD-0001',    companyId: 'co-nbd', userId: 'nbdRep' };
  const PREFIXES = { OAK: { companyId: 'co-oak' }, NBD: { companyId: 'co-nbd' } };

  // 1. Happy path still resolves.
  {
    const r = await resolve({ ref: 'OAK-0001-K3', leads: [OAK, NBD], prefixes: PREFIXES });
    ok('resolves an unambiguous tenant code', r.sourceLead && r.sourceLead.id === 'leadOak');
    ok('consulted docPrefixes to derive the tenant', r.calls.prefixGets.includes('OAK'));
  }

  // 2. THE BUG: same customerId in two tenants must never silently pick one.
  {
    const collide = { id: 'leadEvil', customerId: 'NBD-0001', companyId: 'co-evil', userId: 'evilRep' };
    const r = await resolve({ ref: 'NBD-0001', leads: [collide, NBD], prefixes: PREFIXES });
    ok('collision across tenants does NOT resolve to the wrong tenant',
      !r.sourceLead || r.sourceLead.companyId === 'co-nbd');
    ok('collision resolves to the tenant the code prefix belongs to',
      !!r.sourceLead && r.sourceLead.id === 'leadNbd');
  }

  // 3. Ambiguity WITHIN the correct tenant must fail closed, not guess.
  {
    const dupeA = { id: 'dupA', customerId: 'OAK-0009-Z1', companyId: 'co-oak', userId: 'r1' };
    const dupeB = { id: 'dupB', customerId: 'OAK-0009-Z1', companyId: 'co-oak', userId: 'r2' };
    const r = await resolve({ ref: 'OAK-0009-Z1', leads: [dupeA, dupeB], prefixes: PREFIXES });
    ok('ambiguous code refuses instead of picking one', !r.sourceLead);
    ok('ambiguous code returns a 4xx to the caller', !!r.badCall && r.badCall.code >= 400);
    ok('ambiguity is logged at error level', r.logged.some(l => l.lvl === 'error'));
  }

  // 4. A code whose prefix belongs to another tenant must not resolve.
  {
    const r = await resolve({ ref: 'OAK-0001-K3', leads: [{ ...OAK, companyId: 'co-someone-else' }], prefixes: PREFIXES });
    ok('code prefix must match the owning tenant', !r.sourceLead);
  }

  // 5. The query must not cap at 1 — with limit(1) an ambiguous code is
  //    indistinguishable from a unique one, which is how this hid.
  {
    const r = await resolve({ ref: 'OAK-0001-K3', leads: [OAK], prefixes: PREFIXES });
    const custQuery = r.calls.queries.find(q => q.field === 'customerId');
    ok('customerId query exists', !!custQuery);
    ok('customerId query does not cap at 1 (ambiguity must be observable)',
      !!custQuery && custQuery.cap !== 1);
  }

  // 6. Raw doc-id fallback still works (doc ids are unique — no ambiguity).
  {
    const raw = { id: 'abcdefghij0123456789', customerId: undefined, companyId: 'co-oak', userId: 'oakRep' };
    const r = await resolve({ ref: 'abcdefghij0123456789', leads: [raw], prefixes: PREFIXES });
    ok('raw lead-id fallback still resolves', !!r.sourceLead && r.sourceLead.id === raw.id);
  }

  // 7. Unknown code resolves to nothing (caller 404s downstream).
  {
    const r = await resolve({ ref: 'ZZZ-9999-QQ', leads: [OAK, NBD], prefixes: PREFIXES });
    ok('unknown code resolves to nothing', !r.sourceLead);
  }

  console.log('\n' + '─'.repeat(50));
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    for (const f of fails) console.log('  - ' + f);
    console.log(`
The referral resolver must scope to ONE tenant and refuse when ambiguous.
Resolving the wrong source files a homeowner's PII into another company's CRM.`);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e && e.stack || e); process.exit(2); });
