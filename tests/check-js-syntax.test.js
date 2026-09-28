/**
 * check-js-syntax.test.js — the guard on the syntax gate's grammar choice
 *
 * scripts/check-js-syntax.js decides, per file, which grammar a parse must
 * pass: Node's (CommonJS or module) for functions/ and tests/, and the
 * browser's for docs/ — the goal the pages that load a file impose, read from
 * their <script src> tags. That decision is where the gate has gone silently
 * green twice:
 *   - 2026-09-25: bare `node --check <file>` never parsed a .js containing
 *     import/export (module detection), so 47 module files went unchecked.
 *   - 2026-09-26: docs/ was held to "CommonJS or module", so a top-level
 *     `return`, or an `import` in a file pages load with a plain <script
 *     src>, passed while the browser would reject the file on every page.
 * The script self-tests its parser on every run; this suite pins the parts
 * the self-test cannot see — the page scan and the per-file requirement.
 *
 * Dependency-free — runs with: node tests/check-js-syntax.test.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  scriptLoads, requirementFor, checkSource, SELF_TEST, NODE_GOALS, BROWSER_GOALS,
} = require(path.join(ROOT, 'scripts/check-js-syntax.js'));

let passed = 0;
let failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

/** scriptLoads() as a plain object: { rel: { goal: [pages] } }. */
function loadsOf(pages) {
  const out = {};
  for (const [rel, byGoal] of scriptLoads(pages)) out[rel] = Object.fromEntries(byGoal);
  return out;
}

// ── The page scan ────────────────────────────────────────────────────

test('absolute and relative src resolve inside docs/; query and hash are dropped', () => {
  eq(loadsOf([{
    page: 'docs/areas/x.html',
    html: '<script src="/assets/js/a.js?v=3" defer></script><script src="b.js#top"></script>' +
      '<script src="../c.js"></script>',
  }]), {
    'docs/assets/js/a.js': { script: ['docs/areas/x.html'] },
    'docs/areas/b.js': { script: ['docs/areas/x.html'] },
    'docs/c.js': { script: ['docs/areas/x.html'] },
  }, 'loads');
});

test('type="module" in any case or quoting is the module goal; JavaScript MIME types are classic', () => {
  eq(loadsOf([{
    page: 'docs/p.html',
    html: '<SCRIPT TYPE="MODULE" SRC="/m1.js"></SCRIPT><script type=module src=/m2.js></script>' +
      "<script type='text/javascript' src='/c1.js'></script>" +
      '<script type="application/javascript" src="/c2.js"></script>' +
      '<script type=" Text/JavaScript " src="/c3.js"></script><script type="" src="/c4.js"></script>',
  }]), {
    'docs/m1.js': { module: ['docs/p.html'] },
    'docs/m2.js': { module: ['docs/p.html'] },
    'docs/c1.js': { script: ['docs/p.html'] },
    'docs/c2.js': { script: ['docs/p.html'] },
    'docs/c3.js': { script: ['docs/p.html'] },
    'docs/c4.js': { script: ['docs/p.html'] },
  }, 'goals');
});

test('data blocks, external, inline, commented-out and data-src scripts impose nothing', () => {
  eq(loadsOf([{
    page: 'docs/p.html',
    html: [
      '<script type="application/ld+json" src="/ld.js"></script>',
      '<script type="importmap" src="/map.js"></script>',
      '<script type="text/javascript; charset=utf-8" src="/param.js"></script>',
      '<script src="https://cdn.example.com/x.js"></script>',
      '<script src="//cdn.example.com/y.js"></script>',
      '<script src="data:text/javascript,1"></script>',
      '<script src="/../outside.js"></script>',
      '<script>window.inline = 1;</script>',
      '<!-- <script src="/old.js"></script> -->',
      '<script data-src="/lazy.js"></script>',
    ].join('\n'),
  }]), {}, 'loads');
});

test('pages that agree collect together; pages that disagree record both goals', () => {
  eq(loadsOf([
    { page: 'docs/a.html', html: '<script src="/shared.js"></script><script src="/both.js"></script>' },
    { page: 'docs/b.html', html: '<script src="/shared.js"></script><script type="module" src="/both.js"></script>' },
  ]), {
    'docs/shared.js': { script: ['docs/a.html', 'docs/b.html'] },
    'docs/both.js': { script: ['docs/a.html'], module: ['docs/b.html'] },
  }, 'loads');
});

test('the live docs/ pages: scan finds both goals, and nearly every resolved path exists', () => {
  const pages = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '_archive') walk(full);
      else if (e.isFile() && e.name.endsWith('.html')) {
        pages.push({ page: path.relative(ROOT, full).split(path.sep).join('/'), html: fs.readFileSync(full, 'utf8') });
      }
    }
  })(path.join(ROOT, 'docs'));
  const loads = scriptLoads(pages);
  const goals = [...loads.values()].flatMap((byGoal) => [...byGoal.keys()]);
  if (!goals.includes('script') || !goals.includes('module')) {
    throw new Error(`expected classic and module loads across ${pages.length} pages, got ${JSON.stringify([...new Set(goals)])}`);
  }
  const missing = [...loads.keys()].filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length > loads.size * 0.1) {
    throw new Error(`${missing.length} of ${loads.size} resolved srcs do not exist — resolution is wrong? e.g. ${missing.slice(0, 3)}`);
  }
});

// ── The per-file requirement ─────────────────────────────────────────

test('functions/ and tests/ keep Node grammars; an unloaded docs/ file takes either browser goal', () => {
  const loads = scriptLoads([{ page: 'docs/p.html', html: '<script src="/functions/x.js"></script>' }]);
  eq(requirementFor('functions/index.js', loads), NODE_GOALS, 'functions/');
  eq(requirementFor('tests/e2e/x.spec.js', loads), NODE_GOALS, 'tests/');
  eq(requirementFor('docs/pro/js/unloaded.js', loads), BROWSER_GOALS, 'unloaded docs/');
  eq(NODE_GOALS, { anyOf: ['commonjs', 'module'] }, 'NODE_GOALS');
  eq(BROWSER_GOALS, { anyOf: ['script', 'module'] }, 'BROWSER_GOALS');
});

test('a docs/ file pages load must parse under every goal they load it with', () => {
  const loads = scriptLoads([
    { page: 'docs/a.html', html: '<script src="/x.js"></script>' },
    { page: 'docs/b.html', html: '<script type="module" src="/x.js"></script>' },
  ]);
  eq(requirementFor('docs/x.js', loads), {
    allOf: [{ grammar: 'script', pages: ['docs/a.html'] }, { grammar: 'module', pages: ['docs/b.html'] }],
  }, 'requirement');
});

// ── The parse, end to end ────────────────────────────────────────────

test('each broken browser self-test sample passes under Node grammars — only the browser goal catches it', async () => {
  const browser = SELF_TEST.filter((t) => t.need && t.line);
  if (browser.length < 3) throw new Error(`expected at least 3 broken browser samples, found ${browser.length}`);
  for (const t of browser) {
    const asNode = await checkSource(t.source, t.label, NODE_GOALS);
    if (asNode) throw new Error(`${t.label} fails even under Node grammars, so it proves nothing about the browser goal:\n${asNode}`);
    const asBrowser = await checkSource(t.source, t.label, t.need);
    if (!asBrowser || !asBrowser.includes(`${t.label}:${t.line}`)) {
      throw new Error(`${t.label}: expected a report at line ${t.line}, got ${asBrowser}`);
    }
  }
});

test('the 2026-09-25 hole: an error after import/export is found, under both rules', async () => {
  const src = "import x from './y.js';\nconst a = 'it's broken';\n";
  for (const need of [NODE_GOALS, BROWSER_GOALS]) {
    const report = await checkSource(src, 'docs/esmbad.js', need);
    if (!report || !report.includes('docs/esmbad.js:2') || !/Unexpected identifier/.test(report)) {
      throw new Error(`expected docs/esmbad.js:2 Unexpected identifier under ${JSON.stringify(need)}, got ${report}`);
    }
  }
});

test('reports say which rule failed, name the loading page, and drop stack frames', async () => {
  const need = requirementFor('docs/y.js', scriptLoads([
    { page: 'docs/a.html', html: '<script src="/y.js"></script>' },
    { page: 'docs/b.html', html: '<script src="/y.js"></script>' },
    { page: 'docs/c.html', html: '<script type="module" src="/y.js"></script>' },
  ]));
  const both = await checkSource('const a = 1;\nexport default a;\n', 'docs/y.js', need);
  if (!both || !both.startsWith('loaded as a classic script by docs/a.html and 1 other page(s), but does not parse as one:')) {
    throw new Error(`classic-load report wrong:\n${both}`);
  }
  if (/as an ES module/.test(both)) throw new Error(`the module goal parses and must not be reported:\n${both}`);
  const neither = await checkSource('if (!globalThis.x) return;\n', 'docs/z.js', BROWSER_GOALS);
  if (!neither || !neither.startsWith('parses as neither a classic script nor an ES module:\ndocs/z.js:1')) {
    throw new Error(`either-goal report wrong:\n${neither}`);
  }
  for (const r of [both, neither]) {
    if (/\n\s+at /.test(r) || !/SyntaxError: [^\n]+$/.test(r)) throw new Error(`report should end at its SyntaxError line:\n${r}`);
  }
});

(async () => {
  console.log('');
  console.log('check-js-syntax.test.js');
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('  ✓ ' + name);
      passed++;
    } catch (e) {
      console.error('  ✘ ' + name);
      console.error('    ' + (e.stack || e.message));
      failed++;
    }
  }
  console.log('');
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
})();
