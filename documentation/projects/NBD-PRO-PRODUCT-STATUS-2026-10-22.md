# NBD Pro as a product: status by pillar (2026-10-22)

Recon only. Nothing here changed billing, rules, auth, App Check or tenancy.
Sources: the three pillar plans ([1](../architecture/PILLAR1-PROVISIONING-PLAN.md),
[4](../architecture/PILLAR4-BILLING-PLAN.md), [5](../architecture/PILLAR5-DOMAINS-SITES-PLAN.md)),
the BILLING section of [ARCHITECTURE.md](../ARCHITECTURE.md), `functions/index.js`,
the code named below, `origin/main` at 4536ddc8, and live HTTP status checks of the
public pages. Test results are marked as run here; everything else is a code read.

The pillar plans were last refreshed 2026-07-05 and are partly stale. This note is
the newer picture.

## 1. Tenant onboarding / provisioning (Pillar 1)

**Built and live**
- `createCompany` (`functions/handlers/provisioning.js`): neutral seed, `company_admin` claim, `companyId == uid`, `status:'active'`, `sitePublished:false`. Called by `register.js`, `onboarding.js` (self-heal retry) and `provisioning-retry.js`.
- Team invites without GCIP: `createTeamInvite`, `teamInviteEmail`, `claimInvite`, `assignSeats` (`handlers/invites.js`, `handlers/seats.js`). `invite-join.js` and `dashboard-team-tab.js` call them; dashboard boot runs `claimInvite`.
- Onboarding wizard `docs/pro/onboarding.html` (3 steps, skippable).
- `functions/tenant-ops.js`: `onCompanyCreated` (signup alert + welcome email), `exportCompanyData`, `uploadCompanyLogo`, `adminListTenants`, with a read-only platform view in `docs/admin/js/pages/tenants.js`.
- Decided: open self-serve, free tier, no paywall at signup (Jo 2026-07-04).

**Built but unmounted:** none found. `onRepSignup` stays in the deploy skip list on purpose.

**Missing / unverified**
- `tests/invite-claim-path.integration.test.js` needs emulators; the invite claim path was not re-run here.
- Phase 0 IAM grant (`serviceAccountTokenCreator`) for access-code login is a Jo console task in the plan. Status not confirmed here.
- No tenant-facing "delete my company" flow beyond the R3/R4 decision (suspend, keep data).

**Smallest next PR (low risk):** add `onboarded`, `siteSlug`, `sitePublished` columns to the read-only admin tenants view. Provisioning itself needs nothing.

## 2. Billing / Stripe (Pillar 4)

**Built and live**
- Company-level key: `subscriptions/{companyId || uid}` read by `nbd-auth`, `billing-gate`, dashboard boot. Same-company members can read it; usage pools on the company doc.
- `createCheckoutSession` (`functions/stripe.js:244`) sets `client_reference_id` to the billing key. Plans: starter $99 (`STRIPE_PRICE_FOUNDATION`), team $149 (`STRIPE_PRICE_TEAM`), growth $299 (`STRIPE_PRICE_PROFESSIONAL`). `stripeWebhook` derives plan and purchased seats from line items. A billing-portal session callable exists (`stripe.js:1100`).
- Seat cap enforced in `createTeamInvite` via `PLAN_LIMITS[plan].reps`.
- Run here: `tests/billing-gate.test.js` 59 passed.

**Built but dark:** `setCompanySeatCount` (per-seat add-on, `handlers/seats.js`) stays dark until the `STRIPE_PRICE_SEAT` secret holds a real price id.

**Missing / still open**
- `success_url` is hardcoded to `nobigdealwithjoedeal.com/pro/stripe-success.html` (`stripe.js:360`). Fine while Pro lives on the NBD domain; it blocks a separate Pro domain.
- Server-side `isOwnerCaller` still carries the deprecated `OWNER_EMAILS` email fallback (`functions/handlers/_shared.js`, used by `billing.js`, `auth.js`). The client `billing-gate.js` is claim-only. The plan's "retire the owner-email bypass" is half done.
- Per-seat price, the `STRIPE_PRICE_SEAT` secret and live-vs-test mode are Jo's calls.
- Signup paywall: off the table (Jo 2026-07-04).

**Smallest next PR:** none that is safe to build unasked. Retiring the server `OWNER_EMAILS` fallback, parameterising `success_url` and turning on seats all change billing or auth behaviour, so each is a write-up for Jo first.

## 3. Tenant microsites and the release flow (Pillar 5)

**Built and live**
- Runtime renderer: one static template `docs/sites/t/` plus `getPublicSiteConfig` (whitelisted read; `/sites/t/**` rewrite at `firebase.json:92`). Live check: `/sites/t/nbd` answers 200.
- Private by default, two gates: `status:'active'` AND `sitePublished` (`isPublishedCompany` in `functions/handlers/public-site.js`). New tenants get `sitePublished:false`; client writes of `status` / `sitePublished` are rules-denied.
- Release flow exists end to end: `setSiteSlug`, then `publishTenantSite` (publish / unpublish; needs brand name, phone and service area via `sitePublishReadiness`; rate limited). It is mounted in Settings (`dashboard-bootstrap.module.js` around line 6400: slug box, status line, Publish / Unpublish buttons) and the setup checklist.
- Run here: `tests/tenant-site-publish-2026-10-04.test.js` 31 passed.

**Built but unmounted:** none. The Settings panel has callers.

**Missing**
- Custom domains: deferred by Jo; multi-site Hosting stays the recommended path.
- Oaks redirect chain today: `/sites/t/oaks` 301 to `/sites/oaks` (`firebase.json:61-63`), which 301s to `/sites/oaks/home` (live check). The 2026-08-19 session note says the `/sites/t/oaks` 301s were deleted, while `firebase.json` has them with a "placeholder retired" comment. The note is stale on that point; the chain itself works.
- No owner-facing preview of an unpublished site (the public config refuses unpublished tenants), so an owner cannot see the page before releasing it.
- Tenants that predate the flag (absent `sitePublished`) are published by status alone. A report listing them would make the release story auditable.

**Update 2026-10-23:** the admin tenants view already showed "Site published" with a "yes (legacy)" marker (this note first missed that); a Site address column is added in the follow-up PR. Left:  A preview-before-release changes the public endpoint's behaviour, so it goes to the security reviewer first.

## 4. Pro demo

**Built and live:** `/pro/sandbox` (guided story) 200; `/pro/demo` 301s to it; `/pro/explore` (browser-only sample account, service worker, `connect-src 'self'`) and `/pro/explore/demo-sw.js` 200.

**Run here:** `pro-demo-sdk` 204 passed, `pro-demo-story` 91 passed, `pro-demo-wave2` 76 passed. `pro-demo-zero-network` was SKIPPED (Playwright unavailable in this worktree), so the Chromium zero-network walk was not re-run here; CI runs it.

**Built but unlinked, on purpose:** nothing on `/pro/sandbox` links to `/pro/explore`. The "Explore the whole sample account" card is a disabled placeholder and a test pins it (`pro-demo-sdk` section G). The sample account is reachable only by typing the URL.

**Smallest next PR:** replace the placeholder with a real link and flip the pin. That is a public marketing decision for Jo; waiting on his OK.

## Hard stops hit (written up, not built)
Retiring server `OWNER_EMAILS`; parameterising `success_url`; enabling seats / `STRIPE_PRICE_SEAT`; any `getPublicSiteConfig` or rules change; flag flips; anything that creates a real tenant. The security reviewer was not run because no design touching those was produced.

## Decisions for Jo
1. Link the sample account (`/pro/explore`) from the demo story now? It flips one test pin.
2. Retire the server-side `OWNER_EMAILS` fallback? Needs confirmation that the owner claim is set on every owner account you use.
3. Per-seat price and creating `STRIPE_PRICE_SEAT` (turns seats on). Should Pro get its own domain (`success_url`)?
4. Is the Phase 0 IAM grant for access-code login done?
5. Want an owner-side "preview my site before publishing"? It needs a security review first.

## Finding for Jo (2026-10-23, security review of the Site address column)
`firestore.rules` (companies update, around line 3007) does not freeze `siteSlug`, so an owner can write any string to their own `companies/{id}.siteSlug` straight from the client. That skips `setSiteSlug`'s format check, reserved-name list and the `siteSlugs/{slug}` uniqueness claim, so two tenants could hold the same slug and the public lookup (`limit(1)`) would serve one of them. The admin view now shows a malformed slug as blank. The real fix is a rules change (add `siteSlug` and `siteSlugUpdatedAt` to the `didNotChange` list, with a rules test that an owner UPDATE is denied). That is a Firestore rules change, so it waits for your OK.
