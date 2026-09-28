# Syntax gate: docs/ parses under the browser's grammar (2026-09-26)

Branch `ci/syntax-gate-browser-goal`, stacked on #1778
(`ci/syntax-gate-e2e-specs`, audit note
[SYNTAX-GATE-TESTS-AND-ESM-2026-09-25](SYNTAX-GATE-TESTS-AND-ESM-2026-09-25.md)).
Script: `scripts/check-js-syntax.js`, the `Node syntax check` job in ci.yml
and the pre-Hosting gate in firebase-deploy.yml.

## Why this was opened

Jo's brief (repro dated 2026-09-25) reported the module-file hole: a stray
apostrophe inside a single-quoted string in
`docs/pro/js/dashboard-bootstrap.module.js` sailed through the gate ("525
files parsed cleanly"). #1778 already fixes that hole,
so this session verified #1778 instead of rebuilding it. The verification
found a second hole of the same kind, which this branch closes.

### #1778 verified against current main (fff5a32c)

- **The reported break.** An unescaped apostrophe went into an existing
  string at `dashboard-bootstrap.module.js:86`.
  - main's checker printed "530 files parsed cleanly" and exited 0.
  - #1778's checker printed `docs/pro/js/dashboard-bootstrap.module.js:86`
    `SyntaxError: Unexpected identifier 's'` and exited 1. `--shipped-only`
    did the same.
  - The file was restored byte-for-byte (sha256 `104547fc…`).
- **The incident never reached a commit.** The file has 162 versions across
  all refs, and none of them fails a module parse, so CI's history cannot
  show whether CI has the hole.
- **CI's Node 22.23.2 has the same hole**, read from the `v22.23.2` source
  (no Node 22 is installed on this machine):
  - `lib/internal/main/check_syntax.js`: `--check <file>` resolves the format
    with `defaultGetFormat(url)`, which is called without the source.
  - `lib/internal/modules/esm/get_format.js`: for a typeless `.js`,
    `detectModuleFormat()` returns `null` when there is no source and
    detection is on.
  - `lib/internal/modules/cjs/loader.js` `wrapSafe()`: when the format is not
    `'commonjs'`, it compiles with `shouldDetectModule =
    --experimental-require-module`.
  - `src/node_options.h`: `detect_module = true` and `require_module = true`.
  - `src/node_contextify.cc`: `ShouldRetryAsESM()` answers "Cannot use import
    statement outside a module" with `true` **without compiling the module**,
    and with detection on, `CompileFunctionForCJSLoader` returns instead of
    throwing. `checkSyntax` ignores the result, so the exit code is 0.
  - `v24.14.0` has the identical path.
  - On Node 24.14, `--no-experimental-detect-module` and
    `--no-experimental-require-module` each close the hole. Those flags are
    experimental and version-specific. #1778's explicit `--input-type` on
    stdin is the portable fix, because detection never applies once a grammar
    is named.

## The second hole: docs/ was held to Node's grammar

#1778 accepts a file that parses as **CommonJS or** as an ES module. CommonJS
is Node's grammar, not the browser's:

- **CommonJS wraps the file in a function**, so a top-level `return` parses.
  A classic `<script>` rejects it with `Illegal return statement`, and the
  whole file dies.
- **"Either grammar" ignores how the page loads the file.** An `import` in a
  file that pages load with a plain `<script src>` passes the module parse,
  and the browser rejects it.
- **A module is strict mode.** A file loaded with `type="module"` that uses
  sloppy-only syntax, such as a legacy octal, passes the CommonJS parse, and
  the browser rejects it.

## What changed

- **docs/ files parse under browser grammars only.**
  - A file a docs/ page loads with `<script src>` must parse as a classic
    script. With `<script type="module" src>`, it must parse as an ES module.
    When pages disagree, it must parse as both.
  - A docs/ file that no page loads directly must parse as one of the two.
    This covers module imports, workers, service workers and scripts
    injected at runtime.
  - functions/ and tests/ run in Node and keep "CommonJS or module".
- **Classic script = in-process `vm.Script`.** Node has no
  `--input-type=script`, and compiling a `vm.Script` is V8 parsing a classic
  script with no wrapper. It catches errors inside lazily compiled function
  bodies too: redeclarations, bad regexes and strict-mode octals were all
  checked.
- **`scriptLoads()` reads every `<script src>` in `docs/**.html`.**
  - It drops HTML comments first.
  - The goal follows the HTML spec: no type, an empty type or a JavaScript
    MIME essence means classic, and `module` means module. Any other type is
    a data block that the browser never runs.
  - An absolute `src` is rooted at `docs/`, and a relative one resolves
    against the page's folder. External URLs, `data:`, and paths that leave
    `docs/` are skipped.
  - A page scan that finds no classic loads or no module loads exits 1, the
    same rule as the empty-root guard.
- **Reports name the rule that failed**, for example `loaded as a classic
  script by docs/about.html and 233 other page(s), but does not parse as
  one:`, followed by `file:LINE`, the source line, the caret and the error.
  Stack frames are dropped.
- **Self-test:** three broken browser samples and two clean ones. Each broken
  sample parses under "CommonJS or module", so only the browser goal can
  reject it. The unit test pins that.
- **`tests/check-js-syntax.test.js`**, in the manifest's `node` bucket, with
  FLOORS raised to 193/68/283. It covers the page scan, the per-file
  requirement, the 2026-09-25 hole and the report format.
- **`tests/smoke/functions.test.js` §E2b**: the builtins-only pin allows `vm`.
  It is also anchored on the closing quote now. The old
  `(?!child_process|fs|os|path)` was a *prefix* match, so
  `require('fs-extra')`, `require('path-to-regexp')` and `require('os-name')`
  all passed it. Each was checked against #1778's checker text.

## Whole-tree scan (main fff5a32c)

An independent in-process scan parsed all 1,018 tracked `.js`/`.mjs`/`.cjs`
files under three grammars: `vm.Script`, `vm.compileFunction` with the
CommonJS wrapper, and `vm.SourceTextModule`.

- **0 files** parse under none of the three.
- **0 docs/ files** parse under neither browser goal.
- The 354 docs/ pages hold 298 distinct `<script src>` targets. **None**
  fails the goal it is loaded with. The gate's summary counts 257 classic and
  40 module loads, which are the targets it actually checks; vendor bundles
  are excluded.
- **55 files parse only as ES modules**: 47 under docs/ (#1778's count),
  3 vendor bundles, and 5 under `scripts/`, which the gate does not scan.
  All of them parse.

No real syntax error is hiding. The new rules are green on main.

## Break-tests (each file restored byte-for-byte, checked by sha256)

All run with `--shipped-only`, against #1778's checker ("old") and this
branch's ("new").

| Break | old | new |
|---|---|---|
| B1: apostrophe in a string, `dashboard-bootstrap.module.js:86` | exit 1 | exit 1: `loaded as an ES module by docs/pro/dashboard.html` … `:86 Unexpected identifier 's'` |
| B2: `if (!document.body) return;` at the top of `docs/assets/js/ann-bar.js` (classic, 234 pages) | **530 parsed cleanly, exit 0** | exit 1: `loaded as a classic script by docs/about.html and 233 other page(s)` … `:6 Illegal return statement` |
| B3: `import './nbd-nav.js';` at the top of `ann-bar.js` | **exit 0** | exit 1: `:6 Cannot use import statement outside a module` |
| B4: top-level `return` in `docs/pro/js/academy-admin.js` (no page loads it) | **exit 0** | exit 1: `parses as neither a classic script nor an ES module` … `:1` |
| B5: `const legacyOctal = 010;` in `docs/pro/js/pages/invoice-success.js` (module-loaded) | **exit 0** | exit 1: `loaded as an ES module by docs/pro/invoice-success.html` … `Octal literals are not allowed in strict mode.` |
| B6: top-level `return` in `functions/adjuster-board-logic.js` | exit 0 | exit 0, by design: legal in Node's CommonJS |
| S1: `parseAsScript` stubbed to always succeed | — | self-test: `browser-return.js` and `classic-export.js` "got a clean parse", exit 1 |
| S2: `scriptLoads` stubbed to find nothing | — | "354 docs/ pages load 0 … as classic scripts and 0 as modules", exit 1 |

Each mutation of the checker turns only its own unit tests red:

| Mutation | Red tests |
|---|---|
| U1: `requirementFor` returns Node grammars for everything (#1778's rule) | Node-vs-browser requirement; pages impose every goal; report format |
| U2: every `type` counts as classic | data blocks … impose nothing |
| U3: HTML comments not stripped | data blocks … impose nothing |
| U4: classic scripts parsed with the CommonJS wrapper | browser samples pass under Node grammars; report format |
| U5: a file with `import` passes unparsed (simulated detection) | the 2026-09-25 hole |
| U6: stack frames kept | report format |
| U7: a relative `src` resolved from docs/ instead of the page folder | src resolution; the live-pages scan |

## Timings (local, 16 cores, shared with parallel sessions)

Three back-to-back runs of each checker on the same tree, with `--quiet`:

| Scope | #1778 | this branch |
|---|---|---|
| Full: 874 files | 8.4–8.6 s | 5.5–5.8 s |
| `--shipped-only`: 530 files | 5.5 s | 2.4–2.7 s |

It is faster because docs/ files now parse in-process. Only module files
still spawn a child process.

## Still open

- **Imports are not followed.** A file that only a module imports is held
  to "either browser goal", not specifically the module goal. The same goes
  for workers, service workers and injected scripts.
- **V8 only.** Firefox and Safari implement the same grammar, but no second
  engine runs in this gate.
- **`scripts/**` is still unscanned**, by design; #1778's note has the
  reasoning. Its 5 module-only files parse today.
- **Merge order:** #1778 first, then this PR (rebase onto main after #1778
  merges). Both edit `scripts/check-js-syntax.js`. FLOORS in
  `run-test-manifest.js` is a ratchet, so whichever suite-adding PR merges
  last must re-measure it.
