/**
 * tests/sms-optout-key.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * The TCPA opt-out register was written under an 11-digit key and read under a
 * 10-digit one, so a homeowner's STOP was never honoured on any rep- or
 * AI-initiated text. This suite pins the property that failure violated:
 *
 *     the key a STOP is STORED under must equal the key a send LOOKS UP,
 *     for every phone format either side can plausibly see.
 *
 * That is deliberately a round-trip property, not two separate assertions
 * about two functions. The old code had a perfectly self-consistent write side
 * and a perfectly self-consistent read side; nothing about either in isolation
 * was wrong. Only the pair was.
 *
 * Uses a small in-memory Firestore double rather than the emulator so it runs
 * in the REQUIRED unit-suite job — the emulator buckets are advisory, and a
 * compliance gate should not sit outside the merge gate.
 *
 * Run: node tests/sms-optout-key.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OptOut = require('../functions/sms-optout');
const { phoneDigits10 } = require('../functions/phone-utils');

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}
async function checkAsync(name, fn) {
  try { await fn(); passed++; } catch (e) {
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

// ── Minimal Firestore double ────────────────────────────────────────────
// Only what sms-optout.js touches: db.doc(path).get()/.set()/.delete().
function makeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  let throwOnGet = false;
  return {
    _store: store,
    _failNextGet() { throwOnGet = true; },
    doc(p) {
      return {
        async get() {
          if (throwOnGet) { throwOnGet = false; throw new Error('emulated Firestore outage'); }
          return { exists: store.has(p), data: () => store.get(p) };
        },
        async set(v) { store.set(p, v); },
        async delete() { store.delete(p); },
      };
    },
  };
}

const C = OptOut.COLLECTION;
// Every lookup names whose Do Not Text list applies (2026-10-05); see
// tests/sms-dnc-2026-10-05.test.js for the list itself.
const T = { companyId: 'co-1' };

// Formats Twilio sends (always E.164) vs formats reps type. Every pair below
// is the SAME human being.
const SAME_PERSON = [
  ['+18595550134', '(859) 555-0134'],
  ['+18595550134', '859-555-0134'],
  ['+18595550134', '8595550134'],
  ['+18595550134', '1-859-555-0134'],
  ['+18595550134', ' 859 555 0134 '],
  ['+15135550123', '513.555.0123'],
];

console.log('SMS OPT-OUT KEY — stored key must equal looked-up key');
console.log('='.repeat(64));

// ── The property ────────────────────────────────────────────────────────

check('K1  THE REGRESSION — inbound E.164 and rep-typed forms derive ONE key', () => {
  for (const [inbound, typed] of SAME_PERSON) {
    assert.strictEqual(
      OptOut.optOutKey(inbound), OptOut.optOutKey(typed),
      `${inbound} and ${typed} are the same person and must key identically`,
    );
  }
});

check('K2  the canonical key is the last-10 form, country code dropped', () => {
  assert.strictEqual(OptOut.optOutKey('+18595550134'), '8595550134');
  assert.strictEqual(OptOut.optOutKey('(859) 555-0134'), '8595550134');
});

check('K3  the key derivation IS phone-utils, not a private copy', () => {
  // If these ever diverge, an opt-out and its lead stop agreeing again.
  for (const [a, b] of SAME_PERSON) {
    assert.strictEqual(OptOut.optOutKey(a), phoneDigits10(a));
    assert.strictEqual(OptOut.optOutKey(b), phoneDigits10(b));
  }
});

check('K4  the legacy key reproduces the OLD behaviour exactly', () => {
  // The backfill and the fallback both depend on this being the pre-fix
  // derivation, not an approximation of it.
  assert.strictEqual(OptOut.legacyOptOutKey('+18595550134'), '18595550134');
  assert.strictEqual(OptOut.legacyOptOutKey('(859) 555-0134'), '8595550134');
});

check('K5  empty/garbage input yields no key rather than a junk one', () => {
  for (const v of ['', null, undefined, 'abc', '   ']) {
    assert.strictEqual(OptOut.optOutKey(v), '', `${JSON.stringify(v)} must not produce a key`);
  }
});

// ── Round trip through the store ────────────────────────────────────────

(async () => {
  await checkAsync('K6  STOP from Twilio is honoured on a rep-typed send', async () => {
    const db = makeDb();
    await OptOut.recordOptOut(db, '+18595550134', { keyword: 'STOP' });
    const r = await OptOut.isOptedOut(db, '(859) 555-0134', T);
    assert.strictEqual(r.optedOut, true, 'the exact failure this fix exists to close');
    assert.strictEqual(r.viaLegacyKey, false, 'a freshly written record must hit the canonical key');
  });

  await checkAsync('K7  every rep-typed variant of the same number is suppressed', async () => {
    const db = makeDb();
    await OptOut.recordOptOut(db, '+18595550134', { keyword: 'STOP' });
    for (const [, typed] of SAME_PERSON.filter((p) => p[0] === '+18595550134')) {
      const r = await OptOut.isOptedOut(db, typed, T);
      assert.strictEqual(r.optedOut, true, `${typed} should be suppressed`);
    }
  });

  await checkAsync('K8  a PRE-MIGRATION 11-digit record is still honoured', async () => {
    // The backfill may not have run yet. Nobody may be missed in that window.
    const db = makeDb({ [`${C}/18595550134`]: { keyword: 'STOP' } });
    const r = await OptOut.isOptedOut(db, '(859) 555-0134', T);
    assert.strictEqual(r.optedOut, true, 'legacy records must remain honoured pre-backfill');
    assert.strictEqual(r.viaLegacyKey, true, 'and must be reported so the fallback can be retired');
    assert.strictEqual(r.key, '18595550134');
  });

  await checkAsync('K9  a number that never opted out is NOT suppressed', async () => {
    // Without this, a check that returns true for everything passes K6-K8.
    const db = makeDb({ [`${C}/18595550134`]: { keyword: 'STOP' } });
    const r = await OptOut.isOptedOut(db, '(513) 555-9999', T);
    assert.strictEqual(r.optedOut, false);
    assert.strictEqual(r.viaLegacyKey, false);
  });

  await checkAsync('K10 START clears BOTH keys, so a resumed number is textable', async () => {
    const db = makeDb({
      [`${C}/18595550134`]: { keyword: 'STOP' },   // legacy
      [`${C}/8595550134`]: { keyword: 'STOP' },    // canonical
    });
    await OptOut.clearOptOut(db, '+18595550134');
    const r = await OptOut.isOptedOut(db, '(859) 555-0134', T);
    assert.strictEqual(r.optedOut, false,
      'clearing only the canonical key would leave the legacy branch suppressing a '
      + 'homeowner who explicitly asked to resume');
    assert.strictEqual(db._store.size, 0, 'both documents should be gone');
  });

  await checkAsync('K11 a Firestore error THROWS rather than reporting "not opted out"', async () => {
    // Fail closed. Returning false on a transient blip turns an outage into a
    // message to someone who said STOP.
    const db = makeDb();
    db._failNextGet();
    await assert.rejects(
      () => OptOut.isOptedOut(db, '+18595550134', T),
      /outage/,
      'the lookup must propagate, not swallow into a false negative',
    );
  });

  await checkAsync('K12 no phone means no lookup and no suppression', async () => {
    const db = makeDb();
    const r = await OptOut.isOptedOut(db, '', T);
    assert.strictEqual(r.optedOut, false);
    assert.strictEqual(r.key, '');
  });

  // ── The bounded lookup (review of #1667) ──────────────────────────────
  // sendSMS / sendD2DSMS pass { timeoutMs }. A read that never answers must
  // reject — the caller turns that into 503 optout_unverified — instead of
  // outliving the browser's 25s fetch abort, which the client hands off to
  // device Messages like being offline.

  // A db whose reads from the n-th one (1-based) on never settle.
  function hangingDb(fromRead, seed) {
    const store = new Map(Object.entries(seed || {}));
    let reads = 0;
    return {
      reads: () => reads,
      doc(p) {
        return {
          get() {
            reads++;
            if (reads >= fromRead) return new Promise(() => {});
            return Promise.resolve({ exists: store.has(p), data: () => store.get(p) });
          },
        };
      },
    };
  }
  // Watchdog. Without it, an unbounded lookup leaves nothing on the event
  // loop, and Node exits 0 halfway through the suite — a silent pass.
  function within(promise, ms) {
    let t;
    const dog = new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error('HUNG: no answer within ' + ms + 'ms')), ms);
    });
    return Promise.race([promise, dog]).finally(() => clearTimeout(t));
  }
  async function rejection(promise) {
    try { await promise; } catch (e) { return e; }
    return null;
  }
  const activeTimers = () => (typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length : 0);

  await checkAsync('K17 a bounded lookup whose read hangs rejects with code optout_read_timeout', async () => {
    const t0 = Date.now();
    const e = await within(rejection(OptOut.isOptedOut(hangingDb(1), '(859) 555-0134', { companyId: 'co-1', timeoutMs: 30 })), 2000);
    assert.ok(e, 'expected a rejection, got a verdict');
    assert.strictEqual(e.code, 'optout_read_timeout', 'got ' + (e && (e.code || e.message)));
    assert.ok(Date.now() - t0 < 1000, 'rejected at the bound, not long after it');
  });

  await checkAsync('K18 the bound covers the whole lookup, not only its first read', async () => {
    // Canonical key misses (read 1), the legacy '1'+key read hangs (read 2).
    const db = hangingDb(2);
    const e = await within(rejection(OptOut.isOptedOut(db, '(859) 555-0134', { companyId: 'co-1', timeoutMs: 30 })), 2000);
    assert.strictEqual(db.reads(), 2, 'the second read is the one that hung');
    assert.ok(e && e.code === 'optout_read_timeout', 'got ' + (e && (e.code || e.message)));
  });

  await checkAsync('K19 an options object with no usable timeoutMs still gets the default bound', async () => {
    // A typo'd or missing option must not quietly remove the bound. The
    // default is read from the export at call time; shorten it for the test.
    const saved = OptOut.READ_TIMEOUT_MS;
    OptOut.READ_TIMEOUT_MS = 30;
    try {
      for (const opts of [{}, { timeoutMs: undefined }, { timeoutMs: 0 }, { timeoutMs: -5 },
        { timeoutMs: NaN }, { timeoutMs: 'soon' }, { timeoutMs: Infinity }, { timeOutMs: 30 }]) {
        const e = await within(rejection(OptOut.isOptedOut(hangingDb(1), '8595550134', Object.assign({ companyId: 'co-1' }, opts))), 2000);
        assert.ok(e && e.code === 'optout_read_timeout',
          JSON.stringify(opts) + ' → ' + (e ? (e.code || e.message) : 'a verdict'));
      }
    } finally {
      OptOut.READ_TIMEOUT_MS = saved;
    }
  });

  await checkAsync('K20 a bounded lookup that answers in time returns the verdict and leaves no timer', async () => {
    const before = activeTimers();
    const hit = await OptOut.isOptedOut(makeDb({ [C + '/8595550134']: { phone: '+18595550134' } }),
      '(859) 555-0134', { companyId: 'co-1', timeoutMs: 5000 });
    assert.strictEqual(hit.optedOut, true);
    const miss = await OptOut.isOptedOut(makeDb(), '(859) 555-0134', { companyId: 'co-1', timeoutMs: 5000 });
    assert.strictEqual(miss.optedOut, false);
    assert.strictEqual(activeTimers(), before, 'the deadline timer must be cleared once the lookup answers');
  });

  await checkAsync('K21 a read error inside the bound still rejects as that read error', async () => {
    const db = makeDb();
    db._failNextGet();
    const e = await within(rejection(OptOut.isOptedOut(db, '(859) 555-0134', { companyId: 'co-1', timeoutMs: 5000 })), 2000);
    assert.ok(e && /emulated Firestore outage/.test(e.message), 'got ' + (e && e.message));
  });

  check('K22 the default bound is well under the browser client\'s fetch abort', () => {
    // nbd-comms.js hands an aborted fetch off to device Messages. The server
    // must answer 503 first, with room left for a cold start and auth.
    const COMMS = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', 'nbd-comms.js'), 'utf8');
    const m = COMMS.match(/setTimeout\(\(\) => controller\.abort\(\), (\d+)\)/);
    assert.ok(m, 'could not find the fetch abort timer in nbd-comms.js');
    const clientAbortMs = Number(m[1]);
    assert.ok(Number.isFinite(OptOut.READ_TIMEOUT_MS) && OptOut.READ_TIMEOUT_MS > 0,
      'READ_TIMEOUT_MS must be a positive number');
    assert.ok(OptOut.READ_TIMEOUT_MS <= clientAbortMs - 10000,
      `READ_TIMEOUT_MS ${OptOut.READ_TIMEOUT_MS} must leave >=10s under the client abort ${clientAbortMs}`);
  });

  // ── Source contracts on the call sites ────────────────────────────────
  // The module being correct is worth nothing if sms-functions.js goes back
  // to hand-rolling the key.

  const SMS = fs.readFileSync(path.join(ROOT, 'functions', 'sms-functions.js'), 'utf8');

  check('K13 no call site derives an opt-out key by hand any more', () => {
    const raw = SMS.match(/doc\((['"`])sms_opt_outs\//g) || [];
    assert.deepStrictEqual(raw, [],
      'sms-functions.js must reach the register only through functions/sms-optout.js');
  });

  check('K14 all three send paths call isOptedOut', () => {
    const n = (SMS.match(/OptOut\.isOptedOut\(/g) || []).length;
    assert.strictEqual(n, 3,
      `expected sendSMS, sendD2DSMS and the AI-draft path to check the register; found ${n}`);
  });

  check('K15 the per-recipient rate-limit bucket uses the canonical key too', () => {
    // Two derivations meant the AI path (E.164 fallback) and the manual path
    // counted into different buckets, doubling the stated 5/day ceiling.
    const strips = SMS.match(/const toDigits = String\([^)]*\)\.replace\(\/\\D\/g, ''\)/g) || [];
    assert.deepStrictEqual(strips, [],
      'toDigits must come from OptOut.optOutKey so one person is one bucket');
    assert.ok(/const toDigits = OptOut\.optOutKey\(/.test(SMS));
  });

  check('K16 the backfill exists, is dry-run by default and is non-destructive', () => {
    const BF = fs.readFileSync(path.join(ROOT, 'scripts', 'backfill-sms-optout-keys.js'), 'utf8');
    assert.ok(/--apply/.test(BF) && /--yes/.test(BF), 'must require --apply --yes');
    assert.ok(/Refusing to --apply without --yes/.test(BF));
    assert.ok(/phoneDigits10/.test(BF), 'must reuse the canonical derivation, not re-implement it');
    assert.ok(/existing\.exists/.test(BF), 'must be idempotent — never clobber a canonical record');
    assert.ok(/PRUNE/.test(BF) && /args\.includes\('--prune'\)/.test(BF),
      'legacy deletion must be opt-in, not the default');
  });

  // ── Report ──────────────────────────────────────────────────────────
  console.log('');
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f.name}\n      ${f.message}`);
    console.log('');
    console.log(`FAILED — ${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`PASSED — ${passed} assertions; stored key === looked-up key`);
  process.exit(0);
})();
