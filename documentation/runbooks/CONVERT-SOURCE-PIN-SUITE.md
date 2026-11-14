# Converting a source-pin suite with src-kit

*Added 2026-11-14 (fragile-test plan, PR 0).*

About 11,400 checks in `tests/` match a regex or a substring against a file's
**text** instead of running the code or reading its structure. They go red on
harmless edits (a reflow, a renamed local, attribute order) and, written as
"must NOT contain", they keep passing after the code they guard is deleted.
This page is how to turn one suite into checks that fail only when the
behaviour breaks.

## The tools

| Tool | What it is |
|---|---|
| `tests/lib/src-kit.js` | Shared helpers: `read` (LF-normalised), `stripJsComments`, `sliceFn` (one function by brace matching, string/regex-aware, CRLF-safe), `matchBrace`, `parseTags` (tolerant HTML parser with a small selector engine), `cssRules` / `cssRule`, `esmImports`, `loadInVm`, `fakeClock`, `spy`, `suite`, plus `makeDom` / `fire` / `click` from `tests/lib/nbd-os-home-harness.js`. Its own behaviour suite: `tests/src-kit-2026-11-14.test.js`. |
| `tests/source-pin-ratchet.test.js` | Counts source-text assertions per suite against `tests/source-pin-baseline.json`. An existing suite may only go **down**; a new suite may have at most **5**. `--explain <suite>` shows what counts and why; `--lower` writes the lower counts you earned. |
| `tests/csp-inline-lint-2026-11-14.test.js` | One repo-wide CSP lint: no inline handlers, inline scripts or `javascript:` URLs in any `docs/` HTML, and none emitted by any `docs/` JS. Replaces per-suite `!/\son[a-z]+=/.test(src)` copies. |
| `tests/asset-version-consistency-2026-11-14.test.js` | One asset, one `?v=` everywhere it is loaded (pages and `script-loader.js` bundles); locally it also checks a changed file was re-versioned. Replaces per-suite "cache-buster bumped past v=N" pins. |

## The loop

1. `node tests/source-pin-ratchet.test.js --explain <suite>.test.js` to list the counted pins.
2. For each pin, find the class below and apply the recipe. If another suite already
   **executes** the same behaviour, drop the pin and cite that check in a comment.
3. Prove every converted check can fail (below). Every absence check gets a positive control.
4. `node tests/source-pin-ratchet.test.js --lower`, commit the lowered baseline with the suite.

## Recipes, by pin class

**Wiring (script tag, id, `data-*`, order in a template)**

```js
// before
ok('no tag', !/estimate-call-prefill/.test(read('docs/pro/dashboard.html')));
ok('A before B', tpl.indexOf('id="homeAttention"') < tpl.indexOf('id="todayPlan"'));
// after
const page = K.parseTags(K.read('docs/pro/dashboard.html'));
const names = page.$$('script[src]').map((s) => s.attrs.src.split('?')[0].split('/').pop());
ok('no tag (and the query sees script-loader.js)', !names.includes('estimate-call-prefill.js') && names.includes('script-loader.js'));
const tpl = page.byId('tpl-view-home');
ok('A before B', tpl.$('#homeAttention').start < tpl.$('#todayPlan').start);
ok('inside the body', tpl.$('.home-more-body').contains(tpl.$('#widgetGrid')));
```

A lazy-loader registration: run the real loader and read its live map
(`K.loadInVm('docs/pro/js/script-loader.js', {document: …}).ScriptLoader.bundles`).
An ES-module import: `K.esmImports(src)` gives `{ from, names: { local: imported } }`.

**`?v=` cache busters** — delete the pin; `asset-version-consistency` covers every asset.

**CSS rule shape**

```js
// before
ok('phone hides it', /\.home-more-chk:not\(:checked\) ~ \.home-more-body\{display:none;\}/.test(phone));
// after
const css = K.cssRules(K.read('docs/pro/css/today-home.css'));
ok('phone hides it', K.cssRule(css, '.home-more-chk:not(:checked) ~ .home-more-body', { media: '(max-width:768px)' }).display === 'none');
ok('44px target', parseFloat(K.cssRule(css, '.home-more-toggle', { media: '(max-width:768px)' })['min-height']) >= 44);
```

`cssRule` returns `null` for no match, so `.prop` throws on a typo rather than
comparing `undefined`. CSS a script injects (a `<style>` in `innerHTML`, a
`textContent` stylesheet): run the injecting function with `sliceFn` +
`loadInVm` and a fake `document.createElement` that records what was made, then
`cssRules(made[0].textContent)`. A contrast pin: compute the ratio from the
resolved colours, as `crm-layouts-audit-fixes-2026-10-15` §D5 does.

**Code shape (behaviour that can be executed)**

```js
// before
ok('Undo goes through the guarded writer', /await _commitStageChange\(window\._customerId, fromStage, movedTo,/.test(undo));
// after: the real functions, sliced out, run over spies
const cb = K.read('docs/pro/js/customer-bootstrap.module.js');
const commits = [];
K.loadInVm(['docs/pro/js/stage-write.js', 'progress'], {
  window: w, _commitStageChange: async (...a) => { commits.push(a); }, _applyStageOnPage() {}, /* … */
}, { esm: true, src: { progress: 'var _stageMoveNeedsConfirm = stageMoveNeedsConfirm;\n'
  + K.sliceFn(cb, 'progressStage') + ';\n' + K.sliceFn(cb, '_undoStageMove') } });
await w.progressStage('contacted');
await toasts.find((t) => t.undoAction).undoAction();   // w.showToast pushed into `toasts`
ok('Undo writes back, from ↔ to swapped', commits[1][1] === 'inspected' && commits[1][2] === 'contacted');
```

Use `fakeClock(now)` for anything time-based (frozen `Date`, timers that fire on
`tick(ms)`), `spy()` for callbacks, and `{ dom: true }` for the shared fake DOM
(selector matching, `innerHTML` parsing, `click(dom, el)`).

**Regression marker / absence check ("never calls X")** — the dangerous one.
Run the code where X is a trap, and prove the trap works:

```js
const touched = [];
const trap = (n) => new Proxy(function () {}, { get(_t, k) { touched.push(n + '.' + String(k)); return trap(n); }, apply() { touched.push(n + '()'); return trap(n); } });
const ctx = K.loadInVm('docs/pro/js/estimate-call-prefill.js', { document: trap('document'), fetch: trap('fetch'), /* … */ });
[BRIEF, HOSTILE, null].forEach((b) => ctx.NBDEstimateCallPrefill.fromBrief(b));
ok('touches no DOM or network', touched.length === 0, touched);
trap('document').body;
ok('…the trap would have seen one (control)', touched.length === 1);
```

For "escapes what it shows": render with hostile input and assert on the parse
(`K.parseTags(html).$$('img').length === 0`, the text sits in an attribute), with
a control that the parser does find an injected element.

**Wording / compliance** — assert on rendered output, not the template source;
banned-phrase scans belong in one shared scan (the `tests/lib/outbound-template-scan.js` style).

**CSP (inline handler / style)** — delete the per-suite copy once
`csp-inline-lint` covers the file (it walks every `docs/` HTML and JS file).

**Firestore rules text** — emulator rules tests; keep a text pin only for an `if false` lockout.

## Proving a converted check can fail

In a throwaway worktree (`git worktree add --detach ../nbd-wt-mut-x HEAD`), for
each converted check, three mutations, one at a time, restoring between runs
(the `vacuous-test-auditor` agent does exactly this):

1. **Neuter** the guarded code.
2. **Reword / reformat** while still broken: other whitespace, quote style or
   attribute order, renamed locals, or the original token left in a comment.
3. **Break the real site and add a benign extra occurrence** (a decoy with the
   same id/class/text in a comment, another template or an unrelated rule).

All three must go red, and on the check you expect (read the ✗ line, not just the
exit code). `docs/` files are CRLF: keep the EOL and assert each mutation applied.
Record the table in the PR description.

## What a rate looks like

Measured on PR 0's two worked examples (2026-11-14): a wiring/CSS-heavy suite
(34 pins) and a code-shape section (17 pins) each took a few hours including the
mutation proof; with the kit in place, expect roughly 3-5 mixed suites a day and
8-10 a day for wiring- or CSS-only suites. `gauntlet-regressions` (365 pins) needs
splitting by area first.
