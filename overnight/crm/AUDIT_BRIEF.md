# Audit slice brief (read fully before starting)

You are auditing one slice of the NBD Pro CRM (vanilla JS, no framework) in the git worktree
`C:\Users\jonat\nbd-wt-crm`. The CRM is `docs/pro/`. **Read-only on everything except your one output file**
`overnight/crm/inventory/<SLICE>.md`. Do not edit code, do not run git commands that change state, do not
start servers, do not call any network service. Read `CLAUDE.md` first (house rules).

## Output file format (markdown, write it incrementally — create it early and append as you go)

### Section 1 — Inventory + scorecard rows
One table. One row per user-facing item: page, view, tab/section, panel, modal/dialog, drawer, bulk action,
tool, settings field group, document type, estimate path, Cloud Function, Firestore collection — whatever
your slice owns. IDs: `<PREFIX>-001`, `<PREFIX>-002`, … (prefix given in your prompt). Be exhaustive: a
missing row is worse than a terse row. Seed lists in your prompt are from memory — VERIFY each exists.

| ID | Item | Kind | Entry (route / selector / file:line) | Files | Daily path Y/N | Ledger ids | 7 Theme | 8 Tenant | 9 Hygiene | 10 Integrity | 11 Perf | 12 Tests | 2 Works | 3 States | 5 Kbd | Findings (ids) |

Score each of columns 7-12, 2, 3, 5 with one of: ✅ ⚠️ ❌ `?` (could not tell) `N/A:<reason>`.
Columns 1 Reach, 4 Mobile, 6 A11y are filled later by the browser harness — omit them.
Criteria (judge from code; cite file:line in findings):
- 2 Works: the happy path is wired end to end (handler exists, is reachable from the control, writes/reads the
  right thing) AND/OR a passing unit test covers it. ✅ only if you traced it.
- 3 States: loading / empty / error / failed-request each produce a visible message; no spinner-forever, no
  silent `catch {}` that leaves a blank panel.
- 5 Kbd: modals trap focus, Esc closes, focus returns to the trigger; controls are real buttons/links.
- 7 Theme: colors come from CSS variables/tokens; no bare brand hexes. Locked palette: navy #1A3057, navy-deep
  #12223D, orange #BD5728 (must be `var(--orange, #BD5728)` in docs/pro JS), grey #4C4C4D, ink #14181F/#141A25,
  rule #DFE2E7, wash #F6F7F8, orange-light #DD875F (dark backgrounds only), orange-deep #A14A22. RETIRED (❌ if
  found in code, not comments): #E8720C #DA6A05 #B85400 #A64B00 #C45E08 #F08030 #FFAF66 #1E3A6E #1A3A5C #1A1A2E
  #142A52 #1F3A6D #F36F21 (case-insensitive, also their rgb()/rgba() triplets).
- 8 Tenant: every Firestore read/write is scoped (where companyId / where userId / tenant path) — flag every
  unscoped query; customer-facing output (documents, emails, portal, estimate view, invoices) resolves company
  name/logo/colors/phone/credentials from the tenant profile (`window._tenant()`, `_resolveBrand`,
  `_brandLogoSrc`), never hard-coded NBD values ("No Big Deal", nobigdealwithjoedeal.com, NBD phone, GAF
  #1162011, TAMKO, NBD logo data URI); the word "PRO"/"NBD Pro" never appears on customer paper.
- 9 Hygiene: no inline <script>/on*= handlers/javascript: URLs; no native alert/confirm/prompt (exactly three
  alert() calls are allowed: pricing-page.module.js already_subscribed, email_system.js ~309, one commented in
  place); no `textContent =` / `innerText =` on an element whose children are needed; no swallowed catch that
  hides a user-visible failure; no duplicate function definitions; every onSnapshot has an unsubscribe path
  that runs when the view/page changes.
- 10 Integrity: no action can target a stale/wrong record (ids resolved at click time from the clicked
  element, not by index into an array that a filter changes); destructive actions confirm; saves use
  merge/update and don't clobber unrelated fields; a select can't render blank for a valid stored value; money
  math in cents where the subsystem uses cents (expenses), dollars on lead docs — never mixed.
- 11 Perf: unbounded queries (no limit) on growing collections, N+1 reads in loops, duplicate script
  includes, heavy data URIs loaded where unused.
- 12 Tests: name the test file(s) that cover it (tests/*.test.js, tests/smoke/*, tests/e2e/*.spec.js); ❌ if none.

### Section 2 — Findings
One row per defect: `| ID | Severity | Tier | Item ids | Finding (one line) | Evidence file:line | Repro / why it matters | Suggested fix (smallest) |`
IDs `<PREFIX>-F01`… Severity: P0 data loss/corruption or wrong money on customer paper · P1 blocks a daily-path
workflow · P2 wrong/confusing behaviour · P3 cosmetic. Tier: A (UI/states/a11y/theme/brand-resolution/hygiene/
perf/tests — safe to fix), B (a number/quantity/pricing formula or lead logic with a located root cause), C
(auth, security rules, Stripe/billing, Cloud Function behaviour, sending email/SMS, schema changes, pricing
policy — propose only). Only report what you verified in code; say "suspected" if not. No real customer data
in the file (the repo is public).

### Section 3 — Notes
Anything the orchestrator must know: dead settings (a field saved but never read), duplicate engines,
surprising architecture, items you couldn't assess and why.

Keep the file under ~600 lines. Finish with a one-paragraph summary at the top of the file
(row count, ✅/⚠️/❌ counts, worst findings).

## Coverage ledger
`documentation/qa/exhaustive-sweep/COVERAGE-LEDGER.json` — `{meta, rows:[{id,page,route,selector,label,type,
status,...}]}` (1.1 MB; don't read it whole — use `node -e` to filter rows by page/route/selector for your
slice). Put matching ledger ids (or "none") in the Ledger column; count your slice's ledger rows by status in
Section 3.
