# Dependabot review — Stripe 23 and the functions/ bump batch (2026-10-12)

Read-only review of the open Dependabot PRs for `functions/` (#2174-#2178),
done at Jo's request ("a separate look" at #2175). Nothing was merged,
pushed to, or edited; no prod setting was touched. Evidence was gathered from
the PR check rollups, the failing job logs, the Stripe SDK changelog, and a
throwaway worktree running the Stripe test suites against v23.

## Verdicts

| PR | Change | Verdict | Why |
| --- | --- | --- | --- |
| #2175 | `stripe` 22.6.2 -> 23.0.0 (major) | **SAFE TO MERGE** | Every `new Stripe(` pins `apiVersion: '2023-10-16'`; every `constructEvent` passes an explicit 300 s tolerance; no removed API is used; 20 Stripe-touching suites + `tests/smoke.test.js` pass on v23. The one red CI check (`@stranger` phone-bots-api) is a Bots & API UI spec with no Stripe path. |
| #2176 | `browserslist` 4.29.1 -> 4.29.3 (+ `caniuse-lite`) | **MERGE NOW** | Lockfile only, 12/12 lines, all 22 checks green, merges clean into main. |
| #2177 | `baseline-browser-mapping` 2.11.26 -> 2.11.27 | **MERGE NOW** | Lockfile only, 6/6 lines, all checks green. |
| #2178 | `electron-to-chromium` 1.5.439 -> 1.5.444 | **MERGE NOW** | Lockfile only, 6/6 lines, all checks green. |
| #2174 | non-major group, 40 updates | **HOLD — do not merge; split** | Two red required checks, one of them a deterministic guard (ffmpeg-static pin). Details below. |

## 1. Stripe 23 (#2175)

### What v23.0.0 changes

Sources: GitHub release page
<https://github.com/stripe/stripe-node/releases/tag/v23.0.0> (just points to the
changelog) and `CHANGELOG.md` section 23.0.0 (2026-09-30),
<https://github.com/stripe/stripe-node/blob/master/CHANGELOG.md>.

- Default pinned API version becomes `2026-09-30.endive`. Node 18 dropped, Node 20 minimum.
- `Stripe.V2List<T>` loses the never-populated `object` / `has_more` / `url` fields.
- A response that stalls or is cut off mid-body now throws `StripeConnectionError` instead of `StripeAPIError`.
- `ErrorType` top-level export removed (use `.errors`).
- `Stripe.constructEventWithoutVerification` removed (added by mistake in 22.5.0); use `stripe.webhooks.constructEventWithoutVerification`.
- **Webhook tolerance:** `verifyHeader()` / `verifyHeaderAsync()` now apply `Webhook.DEFAULT_TOLERANCE` when `tolerance` is omitted (previously no timestamp check). Passing `0` to `constructEvent` now skips the tolerance check (previously used the default).
- V2 request address params use operation-specific V2 interfaces.
- Generated API typing changes (reserves, `Charge...card.mandate` string -> expandable, `payment_method_types` removed from several param *types*, `billing_cycle_anchor_param`, `igic` removed from tax-registration countries, etc.). These are type-level; the runtime still forwards whatever object is passed.

### Call-site check (`functions/`)

| Call site | Exposure | Result |
| --- | --- | --- |
| `new Stripe(` in `functions/stripe.js:186`, `handlers/seats.js:81`, `handlers/stripe-connect.js:74`, `integrations/esign.js:334` | New default API version | **Not affected.** All four set `apiVersion: '2023-10-16'`. Verified at runtime on v23: `getApiField('version') === '2023-10-16'`. The Stripe account's own API-version setting only governs webhook payload shape for endpoints that did not pin one; the SDK bump does not change it. Prod untouched. |
| `webhooks.constructEvent(..., 300)` in `stripe.js:451`, `stripe.js:1627`, `stripe-connect.js:417` | Tolerance default change / `0` meaning | **Not affected.** Explicit 300 s everywhere (the comment at `stripe.js:449` already anticipates this). Round trip on v23: valid sig accepted, 1000 s stale timestamp rejected, tampered sig and wrong secret rejected (`StripeSignatureVerificationError`). |
| `e.type === 'StripeCardError'` in `handlers/seats.js:308` | Error classes | **Not affected.** `StripeCardError`, `StripeAPIError`, `StripeConnectionError` all still exported. No code branches on `StripeAPIError` vs `StripeConnectionError`. |
| `checkout.sessions`, `paymentLinks`, `invoices`, `invoiceItems`, `customers`, `subscriptions`, `transfers`, `charges`, `paymentIntents`, `accounts`, `billingPortal` | Generated param/response type changes | **Not affected at runtime** (JS, no TypeScript; the one `payment_method_types: ['card']` at `stripe.js:342` is still sent as before). |
| `constructEventWithoutVerification`, `verifyHeader`, `ErrorType`, `V2List` | Removed/changed | **Not used** anywhere in `functions/`. |
| Runtime | Node >= 20 | Functions engine is Node 22. |

### Tests run against v23 (throwaway worktree, not committed)

Worktree `nbd-wt-stripe23` off `origin/main`, with stripe 23.0.0 installed in a
scratch dir and junctioned in; every other module from main's tree.

All pass: `stripe-connect`, `stripe-dispute-branches` (15/15), `stripe-payment-link-tax`,
`stripe-payoff-advance-guard-2026-09-28`, `stripe-platform-only-payments`, `webhook-signatures`,
`invoice-payment-webhook`, `billing-gate`, `stripe-connect-ui`, `secret-stub-guard`,
`deal-acceptance-atomicity`, `estimate-email-cap`, `referral-tenant-scope`,
`ky-insurance-contracts`, `gauntlet-regressions`, `health-digest-usage-signals`,
`viewer-callables`, `docgen-paypanel`, `portal-timeline-docs-balance-2026-09-16`,
plus `node tests/smoke.test.js` (exit 0, 4422 check lines, no failures).

### The one red check on #2175

`Authed E2E (emulators, @stranger)` failed on `phone-bots-api` ("Bots & API"
card / `#agentBotsMount .ab-h2` not found). That is the agent-bots UI and has
no Stripe path; the other 21 checks, including `Unit suites (manifest)`,
`Smoke tests`, `Functions parse + dep install` and the other six E2E shards,
are green. The run was on a branch cut 166 commits behind main (created
2026-10-05), and `@stranger` is the documented flaky shard. Main's `@stranger` shard was green in the two
most recent main runs I checked.

The PR diff is exactly `functions/package.json` (1 line) and the `stripe`
lockfile entry (10/10 lines); a merge-tree against current main is clean and
leaves `handlebars` at main's 4.7.10 and all 17 `"glibc"` constraints intact.

**Action:** `@dependabot rebase` (or just enqueue — the merge queue re-runs
CI on the merged tree). If `@stranger` is red again after that, look at the
spec, not Stripe.

## 2. #2174 — 40 "non-major" updates

Dependabot's grouping is misleading: the branch contains real majors on
transitives. The package.json changes are `@sentry/node` ^11.3.0, `resend`
^6.32.0, `twilio` ^6.1.2, and `ffmpeg-static` 5.2.0 -> 5.3.0.

### Why it must not merge as-is

1. **`Unit suites (manifest)` — deterministic failure.** 364/365 pass; the one
   red is the guard `ffmpeg-static pinned to exactly 5.2.0 (5.3.0 Linux binary
   lacks drawtext) — package.json + lock`. This is a deliberate pin
   (the 5.3.0 Linux binary lacks the `drawtext` filter); Dependabot will keep
   re-proposing 5.3.0 until it is ignored.
2. **`Referral trigger tests` — red** in `lead-artifact-cleanup.integration.test.js`,
   section B ("the row written after the delete survives", "an object uploaded
   there after the trigger started survives"). These are timing-sensitive
   assertions; the same job was green on every recent main/PR run I sampled
   (30 runs). I could **not** confirm or refute it locally: this Windows box's
   storage emulator crashed the same suite on plain main + stripe 23 too
   (control run), and the Firestore emulator refused to start on alternate
   runs. Treat as **unverified, not refuted** — `@google-cloud/firestore`
   9.2.0 -> 9.3.1 is the only runtime Firestore-client change in the batch, so
   rerun it on a rebased branch before trusting it.
3. **Stale base.** Branch is 166 commits behind main; the lockfile it carries
   is resolved against the old tree (e.g. handlebars 4.7.9 vs main 4.7.10).
   A text merge keeps main's value, but the resolution is not one anyone has
   tested.

### The 40 updates, by runtime exposure

| Group | Updates | Loaded at runtime? | Risk |
| --- | --- | --- | --- |
| `@sentry/node` + core/opentelemetry/server-* | 11.0.0 -> 11.3.0 | Yes, lazily (`integrations/sentry.js:37`). Loads fine on 11.3 (562 modules, no babel/magic-string/oxc pulled in). | Low |
| `resend` | 6.30.0 -> 6.32.0 | Yes, ~12 files (every email path). Loads fine. | Low–medium (email is the money path of lead alerts); no major |
| `twilio` | 6.1.1 -> 6.1.2 | Yes. Loads fine. | Low |
| `@google-cloud/firestore` | 9.2.0 -> 9.3.1 | Yes, through firebase-admin. | Medium — see failing integration test above |
| `fast-xml-parser`, `@nodable/entities`, `follow-redirects` | patch/minor | Transitives, runtime | Low |
| `ffmpeg-static` | 5.2.0 -> 5.3.0 | Yes (Reel Studio worker) | **Blocked by the pin guard** |
| `magic-string` | 0.30.21 -> **1.4.2** (major) | **No** — only `@sentry/bundler-plugins`, a build-time plugin that `@sentry/node` does not load | Low; Sentry's own choice |
| `semver` 6.3.1 -> 7.8.5, `lru-cache` 5.1.1 -> 10.4.3 | shown in PR table | In the actual lockfile these *disappear*: they were only nested under `@babel/*`, and Sentry 11.3 drops the whole `@babel/*` + `browserslist` + `caniuse-lite` + `electron-to-chromium` subtree (36 lockfile entries removed) | None |
| `oxc-parser` + 24 `@oxc-parser/binding-*`, `@oxc-project/types`, `sentry` CLI, `typed-query-selector`, `@sentry/conventions`, `@sentry/bundler-plugins` | minor | Build-time / not loaded | Low |

Not in the batch: `firebase-admin`, `firebase-functions`, `googleapis`, PDF
libs (`pdf-lib`), `puppeteer-core`, `sharp`.

### Recommendation

Split. Do not merge #2174. Close it and let Dependabot regroup after adding
`ffmpeg-static` to the `ignore:` list for `/functions` in
`.github/dependabot.yml` (keeps the pin guard from re-reddening every batch).
The Sentry/resend/twilio/firestore bumps should land from a rebased PR whose
`Referral trigger tests` job is green.

Interaction: if #2174 (or a successor) lands, Sentry 11.3 removes the `@babel`
subtree, so #2176/#2177/#2178 become moot. Merging them first is harmless —
they are textually independent of each other and of #2175 — but Dependabot
will auto-close them afterward.

## 3. #2176 / #2177 / #2178

Each is `functions/package-lock.json` only (no `package.json` change), all 22
checks green, `mergeStateStatus: CLEAN`, and each merges cleanly into current
main and with each other (pairwise `merge-tree`). They touch only
transitive build-time packages reachable via `@babel/helper-compilation-targets`
(browserslist/caniuse-lite/baseline-browser-mapping/electron-to-chromium);
none is imported by function code. Merge now; no further evidence needed.

## 4. Context for whoever merges

- Main's own CI is red as of 2026-10-12 08:19Z on `Authed E2E (emulators,
  @shard2)` and `Pro demo zero-network walk (Chromium)`, independent of any
  dependency. Queue entries run the same checks, so a dependency PR can be
  ejected for that reason; read the queue removal reason before blaming the
  bump (see the merge-queue gotchas memory).
- The `backup/wt-dep2174|2175|2176-lockfile-2026-10-12` branches the earlier
  session pushed are only the Dependabot heads on an older base (+ a
  snapshot); nothing in them is better than the Dependabot branches.
- Local reproduction of storage-emulator integration suites is unreliable on
  the shared Windows checkout (leftover `java.exe` from parallel sessions);
  prefer CI for those.
