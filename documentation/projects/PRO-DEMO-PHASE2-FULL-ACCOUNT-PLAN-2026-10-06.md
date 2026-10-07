# Pro demo, phase 2: explore the whole sample account (plan only)

> **Update 2026-10-07 — wave 4 built (draft PR stacked on wave 3, awaiting Jo).**
>
> **Invoices and payments.** Seed v4 adds seven invoices (paid, part paid, draft; Ohio cash and Kentucky insurance). Every deposit comes from the real `deposit-rule.js`; the seed builder fails if a Kentucky insurance invoice asks for anything at signing or takes a payment before the carrier's written decision plus the 5-business-day window (the real `ky-insurance-law.js`). Record Payment, Mark Paid and the payment timeline run unchanged on the fake store.
>
> **Pay links are samples.** The sample company has a test-mode payout account, and `demo-mode.js` turns on the CRM's own Stripe test-mode switch for it. The CRM's three direct function POSTs (`createStripePaymentLink`, `sendEmail`, `sendSMS`) are answered by `docs/pro/demo-sdk/endpoints.js` before any request is made:
> - a pay link is a page in the sample account (`/pro/explore/sample-pay`) that says it is a sample and takes no card;
> - a held Kentucky insurance invoice is refused with the CRM's own `KY_CANCELLATION_WINDOW` message;
> - an email or text shows the "Nothing was sent" sheet and is refused (403), so `nbd-comms.js` never hands off to `sms:` / `mailto:`.
>
> **Production strip.** A sample sub roster (independent subcontractors), permits, start windows and material orders (quantities only). "Send to sub" shows the job sheet in "Nothing was sent": `navigator.share` is guarded in the sample account.
>
> **Settings.** `docs/pro/demo-sdk/real-account.js` puts an "Available in your real account" card over billing, team, sign-in methods, Bots & API keys and AI texting (their own controls hidden), a push note over notifications (push switched off), and in place of data import. The rest of Settings saves in this browser only.
>
> **Ask Joe overlap (wave 3 known issue): fixed.** While Ask Joe is open its input bar reserves room at the bottom for the strip (`demo-mode.css`), on desktop and phone.
>
> **Real-CRM fix found by the sample data.** On the customer page `invoice-pipeline.js` read `window._auth`, which only the photo engine ever set, so pay-link mints from that page threw "Not authenticated" ("Send balance" went out without its link). `customer-tasks-ui.js` now aliases it like `window._db`. Also a fake-store fidelity fix: a top-level `Date` field was stored as `{}` (invoice "Invalid Date").
>
> **Next:** turn on the `/pro/sandbox` Explore button, then "save as my real account".

> **Update 2026-10-06 — wave 3 built (draft PR stacked on wave 2, awaiting Jo).**
>
> **Door-to-Door and Storm Center** run on an offline SVG sample map, `docs/pro/demo-sdk/basemap.js`.
> - The map is drawn in the browser: invented "Fort Thomas north" streets and houses, a park, the river and the sample towns.
> - `demo-mode.js` swaps `L.tileLayer` the moment Leaflet sets `window.L`, so no tile is ever requested.
>
> **Seed v3** adds:
> - ~70 knocks on the map's houses (Jordan's door is the appointment that became the lead);
> - the story's hail swath, as a D2D territory in [lng, lat] and a Storm Center zone in [lat, lng];
> - sample hail and storm reports, and one sample alert labelled "not a real warning";
> - six Agent inbox items from the sample company's own bots.
>
> **Offline answers.** `docs/pro/demo-sdk/offline.js` answers the maps' Nominatim, NWS, SPC (an empty outlook) and `/api/storm-report` reads before they could leave the browser. It also gives the sample location to `navigator.geolocation`.
>
> **Agent inbox.** `agentDraftAction` is canned. One tap on "Text from my phone" shows the "Nothing was sent" sheet and files the draft with a note. `sms:`, `mailto:` and `tel:` links never open the visitor's apps.
>
> **Ask Joe.** The demo worker swaps `js/claude-proxy.js` for `docs/pro/demo-sdk/claude-proxy.js`. Ask Joe answers set questions from the sample data, each labelled "No AI model was called"; any other AI feature says AI is not in the sample account. A `window.callClaude` trap was tried and dropped: the real file's function declaration redefines the global.
>
> **Tests.** The zero-network walk gained steps 13–16 and now fails on any `img-src` refusal. `pro-demo-sdk` gained section H. Six mutations each turned the walk red.
>
> **Known (wave 1 strip):** on desktop the Sample account strip sits over the left part of the Ask Joe input.
>
> **Next: wave 4** (invoices, payments, production strip, Settings).

> **Update 2026-10-06 — wave 2 built (draft PR stacked on wave 1, awaiting Jo).** The estimate builder (V3 wizard over V2), the document generator + viewer and a read-only e-sign preview run on the sample company. No new page and no new route: the builder and the generator already run client-side on `dashboard.html` / `customer.html`. What changed: the seed (v2) gives the sample company its **own brand** (before, company-profile.js deep-merged NBD's, so every sample document would have worn NBD's name and GAF/TAMKO numbers), its packages through the real `tenant-rules.js` (Standard / Preferred / Elite, GAF System Plus on Standard and up, every card "sample price", per-square rates = the story's prices over 26 squares), the 50%-at-$2,000 cash deposit (Kentucky insurance jobs still take nothing at signing: deposit-rule.js keys that to the property), retail line items and a scope of work on Jordan's estimate, and 11 sample photos (seven small hand-drawn SVGs in `docs/pro/demo-sdk/media/`, labelled SAMPLE DRAWING). `docs/pro/demo-sdk/send-preview.js` answers the three send-to-sign callables (`sendEstimateEnvelope`, `createSignRequest`, `createDealAcceptToken`) with a "Nothing was sent" sheet: recipients, subject, message and the page the homeowner would open in a sandboxed frame with no permissions, then the callable still rejects honestly. Two real-CRM bugs the sample data surfaced are fixed in the same PR (proposal photos printed `src="[object Object]"`; a non-NBD company's contract/proposal promised "Lifetime Workmanship"). The `/pro/sandbox` Explore button stays disabled (the plan turns it on after wave 4). Next: **wave 3** (D2D + Storm Center on an SVG basemap, Agent inbox + Ask Joe with canned answers).

> **Update 2026-10-06 — wave 1 built (draft PR, awaiting Jo).** The spike settled on the **service worker route**: `/pro/explore` (entry, `docs/pro/explore/index.html`) registers `docs/pro/explore/demo-sw.js` (scope `/pro/explore/` only), which answers every `www.gstatic.com/firebasejs/*/firebase-*.js` import with a one-line re-export of the same-origin fake in `docs/pro/demo-sdk/`, maps `/pro/explore/<asset>` to `/pro/<asset>`, blanks the App Check / FCM / Sentry config scripts, and never intercepts a navigation. `firebase.json` rewrites `/pro/explore/dashboard` and `/pro/explore/customer` to the real page files (one copy of each page) and gives `/pro/explore` + `/pro/explore/**` a last-in-list CSP with `connect-src 'self'` only and no report endpoint. `docs/pro/js/demo-mode.js` (first, synchronous, inert on the real pages) refuses to run without the demo worker, trips on any non-static request (fetch/XHR/beacon/WebSocket/EventSource), namespaces localStorage/sessionStorage (`nbd_demo:`), keeps navigation inside the demo, and shows the "Sample account" strip with Reset and Start free. The seed (`docs/pro/demo-sdk/sample-company.json`) is generated by `scripts/build-demo-seed.js` from the story's `SAMPLE` (25 leads, tasks, notes, estimates; wave-1 collections only). The real dashboard (Today, pipeline/kanban moves) and customer card run on it. Proof: `tests/pro-demo-sdk-2026-10-06.test.js` (CSP contract, rewrites, SDK export parity, fake behaviour, seed honesty) and `tests/pro-demo-zero-network-2026-10-06.test.js` (Chromium walk with the worker running; fails on any off-origin request, function-rewrite hit, tripwire block or connect-src refusal; proves both guards on purpose). The `/pro/sandbox` "Explore" placeholder stays disabled. Open from the plan: photos on the customer card (no sample media yet), Q2 is answered provisionally as "survives reload, Reset clears".

2026-10-06. Plan, nothing built. Phase 1 (the guided job story at `/pro/sandbox`) shipped in the same PR as this note; its end screen carries a disabled "Explore the whole sample account — coming next" placeholder that this plan fills.

Jo's decision (2026-10-06): the full account is a **browser-only sample company**. Nothing touches the live database, it resets anytime, and it is NOT a real throwaway Firebase tenant. A "save this as my real account" path starts the Free plan.

## Goal

A prospect taps "Explore the whole sample account" and lands in the real CRM (Today, pipeline, customer card, estimates, documents, D2D map, Storm Center, Agent inbox, invoices, Settings) filled with the same sample company the story used. Every button works against sample data in their own browser. Nothing they do reaches Firebase, Stripe, Twilio, email, or any other production service.

## The approach: swap the SDK, not the pages

The CRM pages do not talk to Firestore through one data layer. They import the Firebase SDK straight from `https://www.gstatic.com/firebasejs/10.12.2/firebase-*.js` (82 files), and most code then reaches it through window globals the bootstraps set (`window.db` ~490 uses, `window._db` ~200, `window._leads` ~515, `window.auth` ~260, plus `window.collection/doc/getDocs/setDoc/addDoc/updateDoc/onSnapshot` from `customer-bootstrap.module.js` and `dashboard-bootstrap.module.js`). Rewriting that to a repository layer is months of churn across ~350 files.

Instead, serve the **same pages** under a demo path with **fake SDK modules** in place of the gstatic ones:

1. **Fake SDK modules** under `docs/pro/demo-sdk/` with the same export names the pages import: `firebase-app.js`, `firebase-auth.js` (a signed-in sample owner with a `companyId` claim and `getIdTokenResult()`), `firebase-firestore.js` (an in-memory document store: `collection`, `doc`, `getDoc(s)`, `setDoc`, `addDoc`, `updateDoc`, `deleteDoc`, `query`/`where`/`orderBy`/`limit`, `onSnapshot`, `writeBatch`, `runTransaction`, `serverTimestamp`, `Timestamp`, `increment`, `arrayUnion`/`arrayRemove`), `firebase-functions.js` (`httpsCallable` returns canned, honest responses per callable name: "In the sample account this would send/charge/text…"), `firebase-storage.js` (object URLs over sample images), `firebase-app-check.js` (no-op).
2. **Route the imports to them.** Two candidates, to settle with a spike:
   - **Service worker scope** `/pro/explore/` that answers `www.gstatic.com/firebasejs/*` with the fake modules. Cross-origin module requests do reach a SW `fetch` handler. It must still never intercept `navigate` requests (the 2026 SW navigation-stall rule).
   - **Import map** on demo copies of the page shells. Import maps can remap full-URL specifiers, but an inline `<script type="importmap">` needs a CSP hash, so the copies would need their own CSP block in `firebase.json`.
   The SW route keeps one copy of every page. The import map route avoids a second service worker on `/pro`. A day-one spike decides.
3. **Seed data**: one JSON file (`docs/pro/demo-sdk/sample-company.json`) with the story's company, about 25 leads across every pipeline stage (OH and KY, insurance and retail, one lost), estimates in all five tiers, one signed contract, invoices partly paid, D2D knocks, a storm zone, Agent inbox drafts, Sunday Review numbers. It is generated from the same `SAMPLE` object `sandbox-story.js` uses so the story and the account never disagree. All names and addresses are invented; `tests/catalog-cost-privacy.test.js` must still pass, so no cost or margin fields.
4. **Persistence**: the store lives in memory and mirrors to IndexedDB per browser so a reload keeps the prospect's changes. A visible "Reset sample account" control clears it. Every screen shows a fixed "Sample account: nothing here is real or saved to NBD Pro" strip.

## Guaranteeing zero writes to production

Layered, so no single slip can leak a write:

1. **CSP on the demo path** (`firebase.json` header block for `/pro/explore/**`): `connect-src 'self'` only. No `firestore.googleapis.com`, `*.cloudfunctions.net`, `identitytoolkit`, `securetoken`, Stripe or Twilio hosts. Even if a page loads the real SDK by mistake, the browser refuses every network call. This is the guarantee; the rest is defense in depth.
2. **No real config**: the demo shell never loads `firebase-config` or the App Check key; the fake `initializeApp` ignores whatever config it is handed and returns a demo app tagged `__nbdDemo: true`.
3. **Runtime tripwire**: the fake SDK installs a `fetch`/`XMLHttpRequest`/`sendBeacon` wrapper that throws on any non-same-origin URL and shows a visible "blocked" toast, so a bug is loud in QA instead of silent.
4. **CI tests**: (a) a Playwright spec loads every demo page with `page.route('**/*')` failing anything that is not same-origin static, clicks through the main flows, and asserts zero blocked requests; (b) a Node test asserts the demo CSP block exists, has `connect-src 'self'`, and sits after `**` in the header order (same check style as `tests/google-signin-popup.test.js`); (c) the fake SDK's export list is compared with every name the CRM imports, so a newly used SDK function fails CI rather than silently doing nothing (the page-scoped-helper silent-failure rule).
5. **Separate origin later, if wanted**: serving the demo from its own subdomain would also isolate cookies, IndexedDB and the production service worker. That needs DNS and a second hosting target, so it is optional.

## Pages and modules, in rollout order

| Wave | Pages | Notes |
|---|---|---|
| 1 | `dashboard.html` (Today, pipeline/kanban, Sunday Review), `customer.html` (card, notes, tasks, photos, estimates tab) | The core. Exercises `window._leads`, kanban stage moves, the stage-gate sheet. |
| 2 | Estimate builder (V2/V3 wizard), document generator + doc viewer, e-sign preview (`esign.html` read-only, no envelope send) | Builders run client-side already; e-sign "send" becomes a canned callable. |
| 3 | D2D tracker + Storm Center (sample zone, knocks), Agent inbox + Ask Joe (canned answers, never the real `claudeProxy`) | Map tiles: Esri/OSM are third-party, blocked by the CSP. Use a static sample tile image or an SVG basemap. |
| 4 | Invoices + payments (record a payment works; Stripe links are canned and say so), production strip, Settings (read-mostly) | Kentucky pay-link hold runs on the real `ky-insurance-law.js`. |
| Out | Billing/checkout, team invites, Bots & API keys, data import, Google sign-in, push notifications | Shown as "available in your real account" cards, never wired. |

## Effort (one developer, with the test gates this repo needs)

- Spike (SW versus import map), demo CSP, tripwire: 2 days.
- Fake Firestore/Auth/Functions/Storage with the used API surface + seed generator: 4–5 days.
- Wave 1: 3–4 days (most risk is the bootstraps' assumptions about real auth tokens, claims and App Check).
- Waves 2–4: 2–3 days each.
- "Save as my real account" (Free plan sign-up carrying the prospect's company name, NOT their sample data): 1 day.
- Tests (no-network Playwright walk, CSP contract, export-surface parity, honesty copy): 2–3 days.

Total: roughly 4 to 5 weeks. Wave 1 alone (dashboard + customer card) is a demo-able milestone at about 2 weeks.

## Risks

- **API-surface drift**: a CRM change starts using an SDK function the fake does not have. Mitigation: the export-parity test in CI.
- **Pages that assume a real server**: callables that return data the UI needs (getEsignEnvelope, pricing, claim helpers). Each needs a canned answer; an unknown callable returns a clear "not in the sample account" error instead of hanging.
- **Service worker collisions** with `/pro/sw.js`: a demo SW must not shadow or unregister the app's SW, and must not intercept navigations.
- **Honesty**: the sample account must not show invented statistics or testimonials as real; every number is sample data and labelled.
- **Cost privacy**: the seed must carry retail prices only (`tests/catalog-cost-privacy.test.js`).
- **Kentucky rules**: the real deposit rule and KY hold run in the demo too; tests assert no KY insurance sample shows money due at signing, no AOB, no claim-outcome copy (same checks as phase 1, `tests/pro-demo-story-2026-10-06.test.js`).
- **Perf**: dashboard.html is heavy. The demo should not ship a second copy of it; the SW/import-map route keeps one.

## Open questions for Jo

1. Keep the demo on `/pro/explore` (same origin), or put it on its own subdomain later for full isolation?
2. Should prospects' changes survive a reload (IndexedDB) or reset on every visit?
3. "Save as my real account": carry over only the company name and logo, or also let them import their own pasted leads on sign-up?

## Related

- Phase 1: `docs/pro/sandbox.html`, `docs/pro/js/sandbox-story.js`, `tests/pro-demo-story-2026-10-06.test.js`.
- [TENANT-READY-2026-10-04](TENANT-READY-2026-10-04.md): NBD-only defaults must not leak into another company; the sample company is "another company".
- [TENANT-BOTS-SELF-SERVE-2026-10-04](TENANT-BOTS-SELF-SERVE-2026-10-04.md): the Agent inbox the demo shows.
