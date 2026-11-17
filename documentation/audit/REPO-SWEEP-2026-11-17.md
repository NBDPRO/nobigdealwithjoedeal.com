# Repo sweep, 2026-11-17

## Update, later on 2026-11-17: what was fixed, and what is still open

Jo answered the fix questions the same day (Q1-Q17). The answers are recorded in each PR body. Every fix below was built red-test-first and went through an independent review with two skeptics per finding. Confirmed review findings were fixed in the same PR.

| Finding | PR | State at writing |
|---|---|---|
| M1 tenant deposit on re-tier, M2 custom-stage roles on the customer page | [#3127](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3127) | merged |
| M3 "Email My Estimate" abuse: server-built email, passed-Turnstile gate, 3 per IP per day | [#3128](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3128) | merged |
| M6, L14, L15, L16 operator scripts: dry run unless `--apply`, provision refusals, DEMO kept, admin claim merge, photo upload/sweep | [#3129](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3129) | merged |
| M4, M5, L6, L7 pricing (Job Templates use Settings rates and Round to, cents rollup, pass-through cents) + supplement invoices use the tenant's deposit rule (found by the M1 review) | [#3131](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3131) | open |
| The six CRLF-only call-to-close test failures (baseline below) | [#3132](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3132) | merged |
| L1 Stripe webhooks share one idempotency marker (invoiceWebhook now has its own) | [#3135](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3135) | open |
| L2, L3, L4, L5 (Thursday kill switch, admin analytics fail-closed, ET due date, /inspect answers incl. the bridge carrying late answers + referral code) | [#3135](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3135) | open |
| L8 e-sign source create-only + hash check, L9 tenant warranty picker, L10 stage label as text | [#3136](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3136) | open |
| L11, L12, L13 site (breadcrumb JSON-LD + redirect-URL guard, /sites canonical + dead orange, visualizer label) | [#3137](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3137) | open |
| L17 vacuous test, L18-L21 service worker and caching (API allowlist incl. the storm layer, capped; dead write queue removed; tile hosts only; no-store never-cache pages) | [#3138](https://github.com/NBDPRO/nobigdealwithjoedeal.com/pull/3138) | open |

**Decisions not to re-ask:**
- Admin scripts write only with `--apply`.
- `provision-tenant.js` needs `--force` to move an account, demote a platform admin, or reassign an owned company.
- DEMO stays public.
- Template prices follow Settings, with a one-time note.
- The 1¢ rounding items were OK'd to change.

**Also found during the fixes and left alone:**
- The admin "Rotate access codes" prompt (`docs/pro/js/admin-manager.js`) still names the seed script without `--apply`. Running it that way now prints the dry run, which tells you to add `--apply`.
- Archived runbooks that name these scripts were not changed.

---

This was a read-only sweep across eight risk areas:
- Firestore and Storage rules
- Cloud Functions correctness
- Pricing and money math
- CRM client silent failures
- Public lead intake
- The marketing site
- Scripts, CI and tests
- Service worker, caching and headers

There were 8 finder agents and 44 skeptic verifiers, 52 agents in total. Each finding was argued against by skeptics: high and critical claims needed 2 of 3 skeptics to agree, and the rest needed 1 of 1. Of 32 findings, 29 survived. One of those (`docPrefixes` list, P2) was already fixed on main by #3040, which leaves **28 open**.

**How each finding was checked.** The sweep read `feat/match-job-photos`, which is 48 commits behind main. Every medium finding was then re-checked by grep on `origin/main` at `f3fb34385`. Lows in files that changed since were also re-checked. Line numbers below are from main where they differ. Nothing was edited and no prod script was run.

**Baseline.** All 12 pre-push gates pass on the branch. The node test bucket passed 762 of 762 suites before it hit the runner's 8-minute wall-clock cap after 762 of 1,050 suites. The cap is `BUCKET_BUDGET_MS` in `scripts/run-test-manifest.js:768`. The runner's message says "a suite is hanging", but the last suites each finished in under 3 s. On this Windows machine the bucket is simply slower than the cap: the runner is serial and Windows has a slow process spawn.

**Rerun with a 40-minute cap (scratch copy of the runner): 1,118 of 1,124 suites passed.** The run started on the photo branch and finished on main. The 6 failures reproduce on main one at a time, and they fail **only on a Windows CRLF checkout**. CI on Linux is green.
- **The six suites:** `call-brief-buttons`, `call-to-close-transcribe-now`, `-rescue-queue`, `-split-merge`, `-p1-leftovers` and `-viewers`, all dated 2026-11-09.
- **Why they fail:** each one slices functions out of `customer-calls.js`, `call-center-view.js` or the inbox source with regexes ending in a literal `\n` (for example `/function briefGate\(c\) \{[\s\S]*?\n  \}\n/`). With `core.autocrlf=true` the working copy is CRLF (`i/lf w/crlf`), so nothing matches. The same class of bug was fixed for the photo EXIF test in 9bb6d78ca.
- **Fix:** read the source with `.replace(/\r\n/g, '\n')` in each suite.
- **Two follow-ups:**
  - A cheap guard: a test that fails on `\n`-anchored source regexes without that normalisation.
  - Raising `BUCKET_BUDGET_MS`, or saying "slow machine" instead of "hanging", for local runs.

Severity is the verifiers' corrected severity, not the finder's claim. Several high claims were lowered after verification.

## Medium (6 open)

| # | Finding | Where (main) | Fix sketch |
|---|---|---|---|
| M1 | **Server re-tier on acceptance writes NBD's 50% deposit for every tenant.** When a homeowner accepts a tier (or the rep taps "Use it"), the server calls `R.fromEstimate` with no tenant `config`, so it falls back to NBD's defaults. The deposit draft (`deposit-draft.js`) uses the tenant's rule, so the portal/contract and the draft invoice disagree. The browser twin `accepted-tier-chip.js` is correct. 3/3 confirmed. | `functions/deal-accepted-tier.js:91`, `:364` | Read `companyProfile/{companyId}` the way `deposit-draft.js` does, then pass `TenantOps.depositConfigFor(...)` through as `opts.depositConfig`. Add a test for a non-NBD tenant at 0% and at 30%. |
| M2 | **Customer page saves `stageRole:'new'` for a tenant's custom won/lost/job stage.** It uses the static `crm-stages.js` stageRole. As a result there is no `closedAt`, no `soldTier`, and no lost reason, and the deal drops out of close rate, closes-this-week and server reports. The kanban does it correctly. 3/3 confirmed. | `docs/pro/js/customer-bootstrap.module.js:217`, `:2539` | Resolve the tenant pipeline the way `dashboard-bootstrap.module.js:147-191` does once `_companyProfile` loads. Add a test: a custom won stage writes `stageRole:'won'` and `closedAt`. |
| M3 | **"Email My Estimate" sends visitor-written text, signed by Joe, to any address.** `estimateSummary` (2,000 chars) and `firstName` come straight from the public gateway and go out from jd@ under Joe's signature. HTML is escaped but the content is not checked. The 100/day global cap can also be used up deliberately, which blocks real homeowners. 3/3 confirmed. | `functions/estimate-email.js:197` | Build the summary on the server from structured fields (ballpark min/max, service, roof type). Run `firstName` through `PLG.safeGreetingName`. Consider requiring Turnstile or `phoneVerified` before sending. |
| M4 | **Job Template estimates ignore the shop's saved markup / overhead / profit.** The same scope prices at the engine's defaults instead of the shop's settings, and the template estimate records the wrong O&P. 1/1 confirmed. | `docs/pro/js/job-templates.js:~1100` (settings built), `:1311` | Merge `EstimateBuilderV2.loadSettings()` rates, using the same rule as `shopLineItemRates`, ideally through one shared helper. Add a parity test with non-default O&P. |
| M5 | **The line-item engine hard-codes $25 rounding.** The shop's "Round to" setting only reaches per-SQ quotes. 1/1 confirmed. | `docs/pro/js/estimate-logic-engine.js:965`; `estimate-v2-ui.js` passes the literal `roundTo: 25` (`:2797`) | Forward `roundTo` in `shopLineItemRates` and in the template settings. Add a parity case with a value other than 25. |
| M6 | **Prod-writing scripts with no dry-run default (CLAUDE.md rule f).** `provision-tenant.js` writes Auth claims and `companies/{id}` unless `--check` is passed, overwrites an existing companyId/role (including `admin`) without asking, and can move company ownership. `seed-access-codes.js` and `seed-demo-access.js` write prod immediately, and rotation sets `access_codes/DEMO` inactive, which breaks the public "Try Demo" button with no warning. 3/3 and 1/1 confirmed. | `scripts/provision-tenant.js:171-184`, `scripts/seed-access-codes.js:70`, `scripts/seed-demo-access.js:65` | Dry run unless `--yes`. Refuse a claim or ownership change unless `--force`. Drop `'DEMO'` from `LEGACY_IDS`. Fix the dead `set-jd-claims.js` reference. |

## Low (22 open)

**Payments and server**
- L1. `stripeWebhook` and `invoiceWebhook` share the `stripe_events/{event.id}` idempotency marker. When both endpoints receive the same `invoice.paid`, only the first one to arrive runs, and the other returns 200 "duplicate" so Stripe never retries. This was claimed high and lowered after 3/3 verification: whether it bites depends on which event types each endpoint subscribes to in the Stripe dashboard. Fix: namespace the marker per endpoint and update both catch-block deletes. `functions/stripe.js:480`, `:1957`.
- L2. Thursday call extraction spends Anthropic tokens with no kill switch, honouring neither `aiDisabled` nor a flag of its own. `functions/integrations/thursday.js` `extract()`.
- L3. `getAdminAnalytics` fails open to global data when a company_admin token has no companyId. Fix: refuse when the caller is not a platform admin and has no companyId. `functions/handlers/admin.js:85`.
- L4. The measurement-ready task's `dueDate` is a UTC date, so results that arrive in the evening are due "tomorrow". Use the ET day. `functions/integrations/measurement.js:371`.
- L5. The public lead-photo thank-you screen says details were saved even when they never reached the CRM lead. `functions/public-lead-photos.js:334`.

**Money rounding**
- L6. `resolveEstimate` rolls up O&P and tax as unrounded floats, so the insurance scope's line total + O + P misses the printed subtotal by 1¢. `estimate-logic-engine.js:1006`.
- L7. Pass-through fees are added to the saved subtotal and total in float dollars. `estimate-v2-ui.js` (pass-through block).

**Rules and Storage**
- L8. The e-sign `source.pdf` can be overwritten after sending (the rule is `write`, not create-only), and `getEsignEnvelope` serves it without checking `sourceSha256`. Signing then fails with 409, so no forgery is possible. Only the rep's own Storage SDK can trigger it, because the UI mints a fresh envelope id each time. `storage.rules:207`, `functions/esign-envelope.js:~856`.

**CRM client**
- L9. The doc pre-flight warranty picker shows NBD's ladder and TAMKO HailGuard to every tenant. `doc-preflight.js:2375`.
- L10. The customer-page stage button puts the tenant's stage label into `innerHTML` unescaped. Use `textContent`. `customer-bootstrap.module.js:~1071`.

**Marketing site**
- L11. The BreadcrumbList JSON-LD on 12 town hail/storm pages points position 2 at `/services/hail-damage` (a 301 to `/services/hail-damage-insurance-claim`, `firebase.json:27`) and doesn't match the visible breadcrumb. Example: `docs/services/hail-damage-goshen-oh.html:40`. These pages are generated, so fix the source and restamp rather than hand-editing.
- L12. `/sites` has a dead `.frame-cta` rule using the retired `#e8720c`, and its canonical points at a 301 URL. `docs/sites/index.html:273`.
- L13. The visualizer's "Anything Else" `<label>` has no `for="additionalNotes"`. `docs/visualizer.html:735`.

**Scripts and tests**
- L14. `grant-admin-claim.js` replaces the whole claim set with `{role:'admin'}`, which drops companyId, owner and plan, and its verify step only checks the role. This was claimed high; it is low because `isAdmin()` still grants lead access, but it goes against the repo's read-merge-write rule. `scripts/grant-admin-claim.js:45`.
- L15. The photo sweep's token mode reads every tenant's leads, drops legacy leads that have no companyId, and keeps soft-deleted leads as candidates. `scripts/match-job-photos-sweep-2026-11-10.js:95`.
- L16. `upload-job-photos.js --apply` has three problems: it skips legacy NBD leads that have no companyId, it exits 0 when uploads fail, and it can overwrite an existing Storage object. Use `ifGenerationMatch: 0`. `scripts/upload-job-photos.js:94`. **Read this before the photo upload `--apply` run.**
- L17. A vacuous check: `|| true` makes the "#nbd-pro-nav left alone" assertion impossible to fail. `tests/ds-flow-batch-2-2026-11-09.test.js:321`.

**Service worker and caching**
- L18. The `/pro` service worker caches every same-origin `/api/` GET in an unbounded cache that is never cleared, including reel videos and 206 responses. `docs/pro/sw.js` (`/api/` match near `:390`).
- L19. The offline write queue and background-sync replay can never run, because non-GET requests return early. This is dead code; Firestore persistence already covers it. `docs/pro/sw.js:185`, `:596`.
- L20. Pages the service worker lists as never-cache still get `public, max-age=300`, because navigations bypass the SW. `firebase.json:141`.
- L21. `isMapTile` treats any same-origin path containing `/tile` as a never-revalidated tile. `docs/pro/sw.js:378`.

## Refuted (3)

- Review-request notifications ignoring notification settings: the only caller already gates on them.
- A lead-alert `reply_to` typo blocking the alert email: refuted.
- A missing CSP `report-uri`: refuted, and not a defect as framed.

## Suggested fix order

1. **M1 + M2.** Wrong money and wrong pipeline data for any tenant that isn't NBD. Each needs a red test first.
2. **M3.** Abuse of a public endpoint under Joe's name.
3. **M6 + L14 + L16.** Make the operator scripts follow rule f. L16 matters before the photo upload `--apply` run.
4. **M4 + M5 + L6 + L7.** One pricing PR with parity tests, run through the pricing suites listed in CLAUDE.md rule e.
5. **L1.** Check the Stripe dashboard subscriptions, then namespace the marker.
6. Batch the rest: service worker cleanup, the site JSON-LD and label fixes, the vacuous test.
