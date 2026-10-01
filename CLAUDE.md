# CLAUDE.md — session ground rules for this repo

## What this is

A hand-authored static marketing site (`docs/` **is** the Firebase Hosting
root — what's committed is what ships) plus a multi-tenant contractor CRM
(`docs/pro/`), Cloud Functions (`functions/`), and a heavy test/CI gate
suite. Strict CSP: no inline scripts, no inline handlers
(`script-src-attr 'none'`).

## Read first

- `documentation/INDEX.md` — the knowledge-base home note (Obsidian vault)
- `documentation/QUICK_START.md` — orientation
- `DESIGN.md` — the visual system (three surfaces, tokens, components, the
  UI rules CI enforces); read it before any page or screen change
- The current `documentation/projects/NEXT_SESSION-*.md` — the standing
  handoff brief; check INDEX.md's "Session handoffs" line for which is current

## Obsidian vault logging (standing rule, per Jo 2026-08-06)

The repo root opens as an Obsidian vault (setup instructions at the top of
`documentation/INDEX.md`). Every deep audit, system-mechanics investigation,
or recon-heavy session **writes its findings back**:

- **Dated note** under `documentation/` — session logs and handoffs in
  `projects/`, audits in `audit/`, QA sweeps in `qa/<campaign>/`.
- **Link it from `INDEX.md` in the same PR** — an unlinked note is invisible.
  Reaching it via a folder's entry doc counts; being linked from *nothing*
  does not. Now CI-enforced (`check-vault-index.js`).
- **Adding a handoff? Edit the one list — never add a second
  `- Session handoffs:` line.** INDEX once carried three of them with five
  competing "current — start here" claims, so sessions started from stale
  briefs. Exactly one list, and exactly one `**Current handoff:` pointer
  names the live brief; older ones become `Prior handoff:`. CI-enforced.
- **Correct stale docs in place** when your recon contradicts them (dated
  update section at the top or bottom) — append-only rot is how the
  2026-07 audit doc cost a session hours of re-verification.
- Plain relative markdown links only (they work in Obsidian AND on GitHub) —
  a sibling named in backticks is not reachable and will fail the gate.
- End multi-lane sessions with a fresh `NEXT_SESSION-<date>.md` handoff.

## Hard invariants (each is CI-enforced — don't fight the gates)

- New client JS = external file under `docs/assets/js/` (or `docs/pro/js/`),
  loaded with `defer`. Never inline `<script>`, never `on*=` attributes.
- Marker regions are **generator-owned** — never hand-edit between
  `<!-- nbd:partial ... -->`, `BLOG-*`, `OURWORK-*`, or `TOWN*:START/END`
  markers. Edit the source (`site-src/partials/`, the POSTS array,
  `docs/assets/data/projects.json`, `site-src/data/towns.json`) and restamp
  with the matching script.
- Never publish cost/contractor/margin keys or figures anywhere under
  `docs/` — retail prices are fine and deliberate
  (`tests/catalog-cost-privacy.test.js` is the guard).
- Never put CRM Storage URLs (`?token=` links) or un-re-encoded photos on a
  public page; photos ship as EXIF-stripped copies under `docs/assets/`
  (see `documentation/runbooks/PUBLISH-PROJECT.md`).
- Money math stays in cents; estimates read `window.NBD_ESTIMATE_CONFIG`.

## Editing files on Windows (not CI-enforced — the gate is you)

- **Never `sed -i` across a glob of repo files.** Git Bash's GNU sed
  rewrites every file it touches LF-only, match or no match. With
  `core.autocrlf=true` that leaves byte-identical files flagged ` M` in
  `git status` while `git diff` stays empty — 78 of them on 2026-09-05,
  blamed on the test bucket for a session
  (`documentation/audit/GIT-PHANTOM-MODIFICATIONS-2026-09-05.md`). Edit with a
  Node script that detects each file's EOL, or the Edit tool.
- Diagnose: `git ls-files --eol | grep -E '^i/lf\s+w/lf'`. Clear by naming
  those paths to `git checkout --`. `git checkout -- $(git diff --name-only)`
  never lists them, because `git diff` drops stat-changed-but-identical
  files.
- **Never let a `\n` → `\r\n` pass run twice over the same string.** A Node edit
  script that pre-joins its inserted block with `\r\n` and then re-converts
  emits `\r\r\n`. Those **lone CR** bytes make git call the file binary
  (`git ls-files --eol` shows `w/-text`, not `w/crlf`), which turns off EOL
  normalisation and reports every line as rewritten — 2429/2402 on
  `customer-tasks-ui.js` for a six-site edit, 2026-09-08. Opposite symptom to
  the `sed -i` case above (huge diff, not phantom-clean), same class of cause.
  Build inserted blocks with plain `\n`, convert once at write time, and assert
  no byte `0x0D` lacks a following `0x0A` before exiting.

## Pre-push gates (run what your change touches; all cheap)

```bash
node scripts/check-js-syntax.js
node scripts/check-site-integrity.js --quiet
node scripts/apply-partials.js --check --diff
node scripts/build-sitemap.js          # dry-run drift check
node scripts/build-projects.mjs --check
node scripts/build-town-pages.mjs --check  # area/town pages vs site-src/data/towns.json
node scripts/build-llms.mjs --check-regions  # llms.txt lists (llms-full.txt regenerates at deploy)
node scripts/check-inline-html-scripts.js
node scripts/check-image-privacy.js       # EXIF/GPS strip invariant (images)
node scripts/check-vault-index.js         # documentation/ edits (see logging rule above)
node tests/smoke.test.js               # CRM changes (needs functions/ deps)
node tests/marketing-polish-contract.test.js
```

Emulator suites in this sandbox need the proxy env scrubbed:
`env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy npx firebase-tools emulators:exec …`
Don't commit `proxy-agent-negotiate` lockfile drift from a local
`npm install` in `tests/`.
