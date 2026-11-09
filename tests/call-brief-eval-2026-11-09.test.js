/**
 * tests/call-brief-eval-2026-11-09.test.js — Call to Close P0 step 0: the eval
 * HARNESS (scripts/eval-call-brief.js) on the synthetic fixtures
 * (tests/fixtures/call-brief-eval.json). The real ~20-call eval spends API
 * money and needs prod transcripts, so it is Jo's run (--live); this suite
 * proves the harness and the server checks offline.
 *
 *   - the fixtures cover claim / repair / replace / angry / Spanish / cut-off /
 *     shared number, and are synthetic (555, Example street names)
 *   - offline mode never touches the network (fetch is a tripwire here)
 *   - the shared-number case is refused by the gate with no model call
 *   - the angry case's invented promise and its "$9,500" are dropped
 *   - the Spanish case is caught as unreliable even though the canned model
 *     said reliable
 *   - a wrong answer moves the metrics, and --bar-* exits 1 when missed
 *   - --live refuses without ANTHROPIC_API_KEY; --model is checked
 *
 * Run: node tests/call-brief-eval-2026-11-09.test.js
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..');

let fetchCalls = 0;
global.fetch = async () => { fetchCalls++; throw new Error('network in a test'); };

const E = require(path.join(ROOT, 'scripts', 'eval-call-brief.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
const quiet = async (fn) => { const log = console.log, err = console.error; const out = []; console.log = (...a) => out.push(a.join(' ')); console.error = console.log; try { return { code: await fn(), out: out.join('\n') }; } finally { console.log = log; console.error = err; } };

(async () => {
  console.log('\nFixtures');
  const cases = E.loadCases();
  const kinds = cases.map((c) => c.kind);
  ok('cover claim, repair, replace, angry, spanish, cut-off, shared-number', ['claim', 'repair', 'replace', 'angry', 'spanish', 'cut-off', 'shared-number'].every((k) => kinds.includes(k)), kinds);
  ok('synthetic: no real-looking phone numbers, Example street names', cases.every((c) => !/\b\d{3}[-. ]?\d{3}[-. ]?\d{4}\b/.test(c.transcript) || /555/.test(c.transcript)) && cases.some((c) => /Example/.test(c.transcript)));

  console.log('\nOffline run');
  const r = await E.runEval({ cases });
  ok('no network', fetchCalls === 0);
  ok('the shared-number case is refused by the human-filed gate, with no model call', r.rows.find((x) => x.kind === 'shared-number').refused === true && r.overall.modelCalls === cases.length - 1, r.overall);
  ok('overall: precision, claim #, promise and reliability all 100% on the canned answers', r.overall.precision === 1 && r.overall.claim === 1 && r.overall.promise === 1 && r.overall.reliable === 1 && r.overall.gate === 1, r.overall);
  const angry = r.rows.find((x) => x.kind === 'angry');
  ok('angry: the invented "match their price" promise is dropped as ungrounded', angry.dropped.ungrounded >= 1 && angry.promise === 1, angry);
  ok('angry: the "$9,500" said quantity is dropped by the digit rule', angry.dropped.digits >= 1, angry.dropped);
  ok('spanish: unreliable though the canned model said reliable', r.rows.find((x) => x.kind === 'spanish').reliable === true);
  ok('cut-off: carried', r.rows.find((x) => x.kind === 'cut-off').cutOff === true);

  console.log('\nA wrong model moves the metrics');
  const wrong = await E.runEval({
    cases,
    callModel: async (req, c) => {
      const j = JSON.parse(JSON.stringify(c.canned));
      if (j.fields.claimNumber.value) { j.fields.claimNumber.value = 'H44728'; }
      j.promises = j.promises.map((p) => Object.assign({}, p, { who: 'jo', kind: 'order' }));
      return { content: [{ type: 'text', text: JSON.stringify(j) }] };
    },
  });
  ok('a misheard claim # is dropped (digit rule) and the claim metric misses', wrong.rows.find((x) => x.kind === 'claim').claim === false, wrong.rows.find((x) => x.kind === 'claim'));
  ok('wrong promise kinds lower the promise metric', wrong.overall.promise < 1, wrong.overall);
  ok('the request each case sent is the callable\'s: strict schema, fenced transcript, no notes', await (async () => {
    let seen = null;
    await E.runEval({ cases: [cases[0]], callModel: async (req, c) => { seen = req; return { content: [{ type: 'text', text: JSON.stringify(c.canned) }] }; } });
    return seen && seen.output_config.format.type === 'json_schema' && /<transcript>/.test(seen.messages[0].content) && !/temperature/.test(JSON.stringify(seen));
  })());

  console.log('\nCLI');
  const fx = path.join(ROOT, 'tests', 'fixtures', 'call-brief-eval.json');
  const plain = await quiet(() => E.main([], {}));
  ok('offline CLI exits 0 and prints the table', plain.code === 0 && /OFFLINE/.test(plain.out) && /OVERALL/.test(plain.out), plain.out.slice(0, 200));
  const bar = await quiet(() => E.main(['--bar-precision', '1.01'], {}));
  ok('a missed bar exits 1 and says which', bar.code === 1 && /BELOW BAR: precision/.test(bar.out));
  const live = await quiet(() => E.main(['--live', '--cases', fx], {}));
  ok('--live without ANTHROPIC_API_KEY refuses (exit 2), no call made', live.code === 2 && fetchCalls === 0 && /ANTHROPIC_API_KEY/.test(live.out));
  const badModel = await quiet(() => E.main(['--model', 'gpt-4'], {}));
  ok('--model off the allowlist is refused', badModel.code === 2);
  ok('still no network after the CLI runs', fetchCalls === 0);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
