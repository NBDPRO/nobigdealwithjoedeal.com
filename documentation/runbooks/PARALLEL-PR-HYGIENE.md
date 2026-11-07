# Parallel PRs: preflight and shared-list anchoring

*Written 2026-11-06 by the PR steward session. Companions: [MERGE-QUEUE](MERGE-QUEUE.md),
[VISUAL-BASELINE-REBLESS](VISUAL-BASELINE-REBLESS.md), [INDEX](../INDEX.md).*

## Why
When several sessions open PRs at once, the merge queue knocks PRs out for reasons that have nothing
to do with their code:
- **Adjacency conflicts on shared one-line lists.** Every PR adds one line to `documentation/INDEX.md`
  (the vault rule) and one to `tests/ci-manifest.json` (its new suite). Sessions append at the same
  "latest" spot. Git treats two inserts at the same or adjacent line as a conflict, so each merge
  knocks the next PR out. 2026-11-05: 4 PRs. 2026-11-06: 11 CRM PRs all inserted after manifest
  line 715 and INDEX line ~541.
- Review blockers found by eye that a script can find first: retired hexes, inline handlers, CRLF
  damage, a committed `functions/package-lock.json`, a screenshot over 200 KB.

## Before you push: `node scripts/pr-preflight.js`
- Read-only. It diffs against `origin/main` and runs the CLAUDE.md pre-push gates the changed files
  need: syntax, site integrity, partials, sitemap dry run, projects / towns / llms checks, image
  privacy, vault index, marketing contract, smoke for `docs/pro` / `functions`, and every changed
  `tests/*.test.js`.
- It also runs these scans:
  - retired palette values in added lines under `docs/`, `site-src/`, `functions/`
  - inline `<script>`, `on*=`, `javascript:` and off-site scripts in added HTML
  - EOL-only rewrites and lone-CR files
  - junk files: node_modules, function lock drift, `.env`, service-account JSON, emulator dumps,
    screenshots over 200 KB
  - `.only` / `.skip` in tests
  - removed `KNOWN BUG` lines
  - shared-list inserts next to a line added in the last 48 h
- `--open-prs` (needs `gh`) also compares your INDEX and manifest insert spots with every open PR and
  names the ones you'd collide with.
- `--no-gates` runs the scans only. `--worktree` includes uncommitted edits. Exit 1 on any FAIL.

## Adding your INDEX / manifest line: `node scripts/index-anchor.js`
```bash
node scripts/index-anchor.js index --section "Audits" --line "<your whole INDEX line, starting with '- [' >"
node scripts/index-anchor.js manifest --test my-suite-2026-11-06.test.js
```
- The slot is derived from a hash of the line itself, so two PRs land at different places in the list
  instead of at its end. Replaying tonight's 11 CRM lines left one adjacent pair in each file instead
  of eleven on one spot.
- It is idempotent: an existing line is left alone. It keeps the file's own line endings, refuses to
  write a lone CR, and re-parses the manifest as JSON before writing.
- `--check` prints the slot without writing.
- If two PRs still conflict, resolve by keeping both lines. Never drop the other PR's line.

## Proposed, not built (owner decisions)
- A required `pr-preflight` CI check (scans only, `--no-gates`; the gates already run in CI).
- PR template fields: risk label (low / med / high); a "touches money / rules / functions / workflows"
  checkbox; "screenshots ≤ 200 KB, synthetic data only".
