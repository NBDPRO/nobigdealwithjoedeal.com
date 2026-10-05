# CLAUDE.md — session ground rules for this repo

## What this is

A hand-authored static marketing site (`docs/` **is** the Firebase Hosting
root — what's committed is what ships) plus a multi-tenant contractor CRM
(`docs/pro/`), Cloud Functions (`functions/`), and a heavy test/CI gate
suite. Strict CSP: no inline scripts, no inline handlers
(`script-src-attr 'none'`).

## Stack

- **Backend: Firebase.** Firestore (`firestore.rules`, `firestore.indexes.json`),
  Cloud Functions gen2 in `functions/` (exports in `functions/index.js`, catalog
  in `functions/FUNCTIONS_INDEX.md`), Storage (`storage.rules`), Auth + App Check.
- **Hosting: Firebase Hosting.** `firebase.json` serves `docs/`; a push to `main`
  deploys (`.github/workflows/firebase-deploy.yml`). Cloudflare appears only as
  Turnstile (`challenges.cloudflare.com`) in the CSP. It is not the host.
- **Anthropic API: server-side only.** The browser calls `claudeProxy`
  (`functions/handlers/ai.js`); server callers include `call-center.js`,
  `dictate.js`, `handlers/ai-texting.js`, `handlers/photo.js`. The key is the
  `ANTHROPIC_API_KEY` secret, never shipped to a client. Transcription is Groq.
- **Multi-tenant.** Every tenant is keyed by `companyId` (an auth claim; a solo
  owner's own uid). Company data lives in `companies/{companyId}` and
  `companyProfile/{companyId}`; rules gate it through `myCompanyId()` in
  `firestore.rules`. NBD is one tenant: read tenant values, never hard-code NBD's.

## Where key logic lives

- **Estimate engine** (`docs/pro/js/`): `estimate-config.js`
  (`window.NBD_ESTIMATE_CONFIG`), `estimate-logic-engine.js`,
  `estimate-builder-v2.js` / `estimate-v2-ui.js` / `estimate-v3-wizard.js`,
  `estimates.js`, `estimate-finalization.js`, `deposit-rule.js`; job templates in
  `job-templates.js` / `job-templates-data.js` / `job-templates-ui.js`. Server
  mirrors: `functions/deposit-rule.js`, `functions/customer-estimate-rows.js`,
  `functions/deal-accepted-tier.js`.
- **Document templates**: `docs/pro/js/document-generator.js`,
  `document-generator-templates.js`, `document-generator-library.js` (OH/KY
  template library), `doc-preflight.js`; server PDFs in `functions/render-pdf.js`.
- **Importers**:
  - `docs/pro/js/data-import.js`: CSV lead import (from another CRM or a spreadsheet)
  - `docs/pro/js/hd-import.js`: Home Depot Pro Xtra purchases as job expenses
  - `functions/call-center.js` + `call-center-logic.js`: call recordings (Cube ACR,
    a shared Drive folder) filed as `phone_calls`, matched to leads, every 30 min
  - `scripts/import-catalog-costs.js`, `import-cost-rotation.js`,
    `import-job-template-costs.js`: one company's cost book / cost basis /
    job-template costs (admin, run by hand)
  - `scripts/import-drive-docs-to-crm.js`: Drive documents into the CRM
    (admin; `scripts/audit-imported-docs-placement.js` checks placement)

## Brand palette and the NBD Document Standard

- **Brand palette (locked): `DESIGN.md` → "Color" is the source.** Brand orange
  `#BD5728` (hover `#A14A22`, light `#DD875F`); navy `#1a3057` / `#12223d`.
  `#E8720C` and `#F08030` are the old oranges. Never reintroduce them. CRM
  customer-facing tokens: `docs/pro/css/nbd-brand.css`.
- **NBD Document Standard (locked 2026-09-07)** is defined in the palette block
  at the top of `docs/pro/js/document-generator-templates.js`: navy `#1A3057`,
  navy-deep `#12223D`, orange `#BD5728`, grey `#4C4C4D`, rule `#DFE2E7`, wash
  `#F6F7F8`, ink `#14181F`; Montserrat display / Lato body with mandatory
  fallback stacks; numbered sections (e.g. §5 credential badges, §7 how-to-pay).
  Mirrored in `document-generator.js` and `functions/render-pdf.js`; guarded by
  `tests/docgen-brand.test.js`. Tenants override through their companyProfile
  brand colors; NBD must stay byte-identical.

## Standing rules (Jo)

a. Ask clarifying questions before building anything non-trivial.
b. Only touch files relevant to the task. No unrequested refactors.
c. Commit after every working change with a clear, descriptive message, on a
   feature branch or worktree. `main` only changes through a PR and the merge
   queue (a push to `main` deploys to production).
d. Never commit secrets or API keys. Fake keys in tests are built at runtime
   (`'sk-' + 'ant-…'`); CI runs gitleaks and GitHub push protection.
e. Run the tests before calling any change to pricing logic done:
   `node scripts/run-test-manifest.js --bucket node` and `node tests/smoke.test.js`
   (task 2 will name the exact estimate suites here).

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

## Code taste (not CI-enforced — borrowed from Ponytail, 2026-10-01 Repo Lab)

- Native element or the standard library before any library
  (`<input type="date">` over a picker, CSS transitions over an animation
  library). A new dependency has to earn its place — and the CSP blocks CDNs,
  so anything added gets vendored under `docs/` anyway.
- No abstraction nobody asked for; the smallest change that fully solves it.
- "Less code" never means cutting validation, accessibility, escaping or
  security checks.
- AI prompts treat customer/caller/web text as **data**, never instructions,
  and never invent numbers the context didn't supply.

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
