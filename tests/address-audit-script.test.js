/**
 * tests/address-audit-script.test.js — the recurring address gate.
 *
 * scripts/audit-lead-addresses.js is what .github/workflows/address-audit.yml
 * runs every morning, and its EXIT CODE is the whole point: non-zero when a
 * mangled or blank address is back in the CRM, zero otherwise.
 *
 * Two ways that gate can quietly stop meaning anything:
 *
 *   1. It goes permanently RED. The app soft-deletes (`deleted: true`) rather
 *      than destroying rows, so merged duplicates and retired test records sit
 *      in /leads forever. Counting them means the audit can never pass — and a
 *      check that is always failing is a check nobody reads.
 *   2. It goes permanently GREEN, by classifying something broken as fine.
 *
 * This suite drives the REAL script against a stubbed Firestore and asserts
 * the exit code both ways. scripts/_admin.js (the shared firebase-admin
 * entrypoint the script imports) is stubbed at the module loader, so no
 * credentials, no network, no functions/ install, and it can run in the
 * ordinary CI bucket.
 *
 * Run: node tests/address-audit-script.test.js
 */
'use strict';

const path = require('path');
const Module = require('module');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

const SCRIPT = path.join(__dirname, '..', 'scripts', 'audit-lead-addresses.js');

/**
 * Run the real script over `rows`, returning { code, out }.
 * Each row: { id, address, firstName?, lastName?, jobValue?, deleted? }
 */
function runAudit(rows, argv, opts) {
  // CI itself runs with GITHUB_ACTIONS=true, which forces redaction — so each
  // case pins the variable explicitly instead of inheriting the runner's.
  const ciEnv = !!(opts && opts.ci);
  const docs = rows.map(r => ({ id: r.id, data: () => r }));

  const makeQuery = () => {
    let started = false;
    const q = {
      orderBy: () => q,
      limit: () => q,
      startAfter: () => { started = true; return q; },
      get: async () => started
        ? { empty: true, docs: [], size: 0 }
        : { empty: docs.length === 0, docs, size: docs.length },
    };
    return q;
  };

  const adminStub = {
    initAdmin() {},
    getFirestore: () => ({ collection: () => makeQuery() }),
  };

  // Stub scripts/_admin.js at the loader — the real module would require
  // firebase-admin out of functions/ and mint ADC credentials — and clear the
  // script from the cache so each case re-executes it from scratch.
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === './_admin') return adminStub;
    return realLoad.apply(this, arguments);
  };

  const realLog = console.log;
  const realErr = console.error;
  const realExit = process.exit;
  const realArgv = process.argv;
  const realCi = process.env.GITHUB_ACTIONS;
  if (ciEnv) process.env.GITHUB_ACTIONS = 'true'; else delete process.env.GITHUB_ACTIONS;

  let out = '';
  let code = null;
  console.log = (...a) => { out += a.join(' ') + '\n'; };
  console.error = (...a) => { out += a.join(' ') + '\n'; };
  process.argv = ['node', SCRIPT].concat(argv || []);
  // The script calls process.exit() at the very end of main(). Record the
  // first code and return rather than throwing: the script wraps main() in a
  // .catch that itself calls process.exit(1), so a throw here would be
  // swallowed by that handler and reported as exit 1 no matter what the audit
  // actually decided. (This does mean the --csv early-exit path would fall
  // through; these cases don't exercise it.)
  process.exit = (c) => { if (code === null) code = c; };

  const restore = () => {
    Module._load = realLoad;
    console.log = realLog; console.error = realErr;
    process.exit = realExit; process.argv = realArgv;
    if (realCi === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = realCi;
  };

  delete require.cache[require.resolve(SCRIPT)];
  return (async () => {
    try {
      require(SCRIPT);
      // main() is async and the script does not export it; give its microtasks
      // a chance to run to the process.exit() call.
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
    } catch (e) {
      out += 'THREW: ' + (e && e.message) + '\n';
    } finally {
      restore();
    }
    return { code, out };
  })();
}

const CLEAN = { id: 'A1', firstName: 'Clean', lastName: 'Row', address: '5448 Hagewa Dr, Blue Ash, OH 45242', jobValue: 100 };
const THIN  = { id: 'A2', firstName: 'Thin', lastName: 'Row', address: 'Cincinnati, OH 45229', jobValue: 100 };
const MANGLED = { id: 'A3', firstName: 'Mangled', lastName: 'Row', address: '7003, Greenstone Trace, O’Bannon Creek', jobValue: 100 };
const BLANK = { id: 'A4', firstName: 'Blank', lastName: 'Row', address: '', jobValue: 100 };

(async function main() {
  console.log('ADDRESS AUDIT SCRIPT — exit-code contract');

  {
    const { code, out } = await runAudit([CLEAN, THIN]);
    ok('clean + thin rows → PASS (exit 0)', code === 0);
    ok('a thin "city only" address does NOT fail the gate', /PASS/.test(out));
  }
  {
    const { code, out } = await runAudit([CLEAN, MANGLED]);
    ok('a mangled address → FAIL (exit 1)', code === 1);
    ok('failure message names the count', /FAIL — 1 address/.test(out));
  }
  {
    const { code } = await runAudit([CLEAN, BLANK]);
    ok('a blank address → FAIL (exit 1)', code === 1);
  }

  console.log('ADDRESS AUDIT SCRIPT — a web lead that gave no address is missing, not broken');
  {
    const webBlank = Object.assign({}, BLANK, { id: 'W1', webLead: true });
    const { code, out } = await runAudit([CLEAN, webBlank], ['--list']);
    ok('blank address on a web lead → PASS (exit 0)', code === 0);
    ok('…listed under "web lead, none given", not hidden', /─── THIN\s+web lead, none given ───\s+W1\b/.test(out));
    const { code: c2 } = await runAudit([CLEAN, webBlank, BLANK]);
    ok('a blank CRM-entered lead still fails alongside it', c2 === 1);
  }

  console.log('ADDRESS AUDIT SCRIPT — public Actions logs never get customer data');
  {
    const { code, out } = await runAudit([CLEAN, THIN, MANGLED], ['--list'], { ci: true });
    ok('CI --list still fails on the mangled row', code === 1);
    ok('CI --list prints the offending doc ids', /^\s+A3$/m.test(out) && /^\s+A2$/m.test(out));
    ok('CI --list prints no names', !/Mangled|Thin Row|Clean Row/.test(out));
    ok('CI --list prints no addresses', !/Greenstone|Cincinnati|Hagewa/.test(out));
    ok('CI output prints no dollar figures', !/\$/.test(out));
    const local = await runAudit([CLEAN, MANGLED], ['--list']);
    ok('locally --list still shows name + address (the redaction is CI-only)', /Mangled Row/.test(local.out) && /Greenstone/.test(local.out));
    const red = await runAudit([CLEAN, MANGLED], ['--list', '--redact']);
    ok('--redact gives the CI output locally', !/Mangled Row|Greenstone/.test(red.out) && /^\s+A3$/m.test(red.out));
    const csv = await runAudit([CLEAN, MANGLED], ['--csv'], { ci: true });
    ok('--csv is refused in CI (exit 2)', csv.code === 2);
  }

  console.log('ADDRESS AUDIT SCRIPT — soft-deleted rows are not the working set');
  {
    // The regression that would make this gate useless: retired rows counted.
    const retiredMangled = Object.assign({}, MANGLED, { id: 'D1', deleted: true });
    const retiredBlank = Object.assign({}, BLANK, { id: 'D2', deleted: true });
    const { code, out } = await runAudit([CLEAN, THIN, retiredMangled, retiredBlank]);
    ok('soft-deleted mangled + blank rows do NOT fail the gate', code === 0);
    ok('they are reported as skipped, not silently dropped', /retired\/soft-deleted/.test(out));
    ok('the skip count is accurate (2)', /plus 2 retired/.test(out));
    ok('scanned count excludes them (2 live rows)', /scanned: 2\b/.test(out));
  }
  {
    // …but a LIVE broken row still fails even when retired ones are present.
    const retired = Object.assign({}, BLANK, { id: 'D3', deleted: true });
    const { code } = await runAudit([CLEAN, MANGLED, retired]);
    ok('a live mangled row still fails when retired rows are also present', code === 1);
  }
  {
    // deleted: false is the app's normal value — must be treated as live.
    const live = Object.assign({}, MANGLED, { id: 'L1', deleted: false });
    const { code } = await runAudit([CLEAN, live]);
    ok('deleted:false is LIVE and still fails (only === true is retired)', code === 1);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
