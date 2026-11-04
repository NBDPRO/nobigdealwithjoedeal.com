# Shared-partials system — decision record

The homeowner site's build step. Introduced 2026-08-02 (#1169) to close the root
cause behind roughly a third of the
[homeowner site audit](../audit/SITE-AUDIT-LOOSE-ENDS-2026-08-10.md) findings:
there was no shared-partial mechanism, so ~200 pages each hand-duplicated their
own nav, footer and chrome, and **23 of the scripts in `scripts/` existed only
to regex-patch that duplication back into sync after it drifted.**

The "— Goshen, OH" footer that shipped to 139 pages was that failure mode, not a
typo.

`site-src/README.md` is the **how-to** (edit workflow, commands, coverage table).
This note is the **why** — read it before proposing a different approach.

Related: [../../site-src/README.md](../../site-src/README.md) ·
[CRM-SECURITY-AUDIT-2026-08-02](../audit/CRM-SECURITY-AUDIT-2026-08-02.md)

---

## Why not a static-site generator

An SSG was considered and rejected on this repo's specific constraints:

- **`docs/` IS the hosting root.** Firebase serves these files as authored, and
  the deploy workflow validates the tree it is about to ship. An SSG either
  commits its output anyway — which is this design with an inverted source of
  truth — or builds in CI, which breaks the "validate what actually ships"
  invariant and forces every local preview through a build.
- **Concurrent worktrees push `main` together.** Whole-tree generated output
  would conflict on every parallel change. Marker regions localise conflicts to
  the block that actually changed.
- **No root `package.json`, no bundler.** The entire script culture is
  Node-builtins-only one-shots.
- **The failure modes are asymmetric.** A broken SSG build blocks *all* deploys.
  A broken partial fails the drift gate while the committed HTML still ships
  exactly as-is. For a repo that deploys to production on merge, the second is
  strictly safer.

It is also not a new invention here: it generalises two mechanisms already
running in production — `build-blog-index.mjs` stamps generated HTML between
`BLOG-STATIC` markers in a committed page, and `build-sitemap.js` dry-runs as a
CI drift gate.

## The contract

```html
<!-- nbd:partial footer-standard crumb_city_name="Mason" ... -->
  ...generated — hand edits here are overwritten...
<!-- /nbd:partial footer-standard -->
```

`scripts/apply-partials.js` renders `site-src/partials/<name>.html` into every
region, substituting `{{key}}` from the marker attributes.

**Per-page values live on the marker, not in a side manifest.** Location pages
are authored by copying a sibling and renaming it; a manifest key silently
orphans on rename, an attribute travels with the file, and
`grep -rl 'crumb_city_name="Mason"' docs/` answers "which pages claim Mason".

## Enforcement — the scheme is only real because of this

- `ci.yml` → **Site integrity** job, every PR.
- `firebase-deploy.yml` → pre-hosting gate, against the tree that actually ships.
  `--check` there **on purpose**: restamping at deploy time would publish content
  that is not in the repo.
- The renderer asserts structural contracts *before* stamping — a `nav-*` partial
  must still contain `id="mainNav"` / `id="navLinks"` / `id="hamburger"`, a footer
  must still contain `<footer>`. Losing one of those IDs ships pages whose
  controls are **silently** dead rather than visibly broken.

## ⚠️ CRLF — the rule that cost an hour

The homeowner pages are **CRLF**. The first implementation normalised to LF for
comparison *and used that LF string as the `String.replace` needle*. It matched
nothing, `replace` returned the input unchanged, and the script reported
**"APPLIED 101"** while writing zero bytes — a silent no-op that looked exactly
like success.

Both scripts now render in LF internally and re-emit with each file's own ending.
**Never normalise the tree to LF** — it rewrites every line of every page and
makes diffs unreviewable. Any future codemod here must splice using the RAW
matched text and assert `out !== src`.

## How to review a migration diff

The footer codemod classifies every page and proves the safe bucket rather than
asserting it:

- **EXACT** — rendering the partial reproduces the page's footer byte-for-byte.
  The codemod refuses to run unless stripping its own two marker lines
  reproduces the original file exactly, and `git diff --numstat` shows **+2/−0**.
  Skip these in review.
- **NEAR** — a handful of changed lines, printed in full. **This is the only set
  a human needs to read.** In the first migration all 6 were pages that had never
  received the #1153 footer-city fix.
- **UNMATCHED** — left untouched and listed. Partial coverage is a first-class
  state: the gate only governs regions that exist.

## Status and remaining phases

| Phase | Scope | State |
|---|---|---|
| 0+1 | renderer + `footer-standard` + CI gates | shipped #1169 |
| 1b | `footer-blog` (23 posts + index) | shipped |
| **2** | **shared CSS core + font preloads** | **NOT DONE** |
| 3 | nav partials | not started |
| 4 | `scripts/new-page.js` scaffold | not started |

**Phase 2 is the biggest remaining win and is fully designed but unbuilt.**
`docs/assets/css/nbd-core.css` does not exist. The inline `<style>` chrome is
32–47% of every page's bytes across ~70 distinct blobs sharing an ~18.3 KB
byte-identical core; extracting it strips roughly **3.5 MB of duplicated
uncached CSS** site-wide and stops the codemod-induced forking (the near-miss
sizes 18,270–18,370 B are the fingerprint of successive regex passes landing on
slightly different page subsets).

Design: `scripts/extract-css-core.js` replaces only a **contiguous byte run**,
never rule-level surgery, and asserts `prefix + coreFileContents + suffix ===
originalBlob` per page before writing. The extracted link, the existing
`nbd-fonts.css` link and the **2 woff2 font preloads** go in a `head-assets`
partial region — which also fixes the "1 of 213 pages preloads fonts" finding at
a single edit point. Hero-image preloads stay per-page, outside the region.
*Update 2026-10-26:* the two font preloads shipped ahead of this phase as the `scripts/add-font-preloads.js` codemod (stamped on every public page that links `nbd-fonts.css`; `build-projects.mjs` emits them; the perf-watch test guards them), so the `head-assets` region only has to absorb them.
No FOUC: a render-blocking `<link>` replaces inline bytes at the same cascade
position.

Remaining footer cohorts, easiest first: 26 area pages, 28 service hub/plain
pages, 5 root pages, `the-pledge`. (`sites/free-guide` was removed from this
list 2026-09-13: it is the contractor lead magnet and now carries contractor
chrome, so no homeowner footer partial should ever own it — the two exemption
registries in `scripts/check-chrome-governance.js` and
`scripts/migrate-nav-to-partial.js` already said so.)
