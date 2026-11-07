# OSS tools deep dive: what the awesome-lists add (2026-11-06)

> **Update 2026-11-07: two corrections and one item done.**
> - **Top-10 #1 (OSRM `/trip`) was overstated.** The day route *is* already reordered. `docs/pro/js/layouts/routeplan.js` runs nearest-neighbour plus 2-opt from a fixed first stop, but on straight-line miles. `/trip` would only switch that ordering to real road times, which matters most around the Ohio River crossings.
>   - It also needs a new `/v1/trip` route in `routing/osrm/proxy.py`, a rebuilt image and a Cloud Run redeploy. `routing/osrm/deploy.sh` is Joe's to run.
>   - So it is **parked until Joe wants that redeploy**. It is no longer the first thing to build.
> - **Top-10 #2 (fast-check) is done:** `tests/deposit-rule-properties-2026-11-07.test.js`, eight properties over the deposit rule, each break-tested.

Jo asked for a deep dive into GitHub and the permissively licensed
"awesome-*" lists. The goal: tools, libraries, features and functions the
homeowner site or the NBD Pro CRM is missing, or could do better.
This is research only. Nothing was installed, vendored or run against prod.

**How this differs from the two earlier sweeps.** [REPO-LAB-2026-10-01](REPO-LAB-2026-10-01.md)
triaged Jo's screenshots. [GITHUB-REPO-SWEEP-2026-11-04](GITHUB-REPO-SWEEP-2026-11-04.md)
covered five lanes (local server, CRM libraries, site perf, CI security, bots)
and shipped or started actionlint/zizmor, SHA pins, trufflehog, osv-scanner,
speculation rules, lychee, html-validate, MESH hail swaths and the
EventCalendar trial. This pass does not repeat those picks. It works from the
curated lists instead and checks each candidate against `origin/main` at
`26b9e5bc`.

**Lists read (README pulled through the GitHub API, 2026-11-06):**
- [awesome-selfhosted](https://github.com/awesome-selfhosted/awesome-selfhosted), 334k stars. Sections: CRM, Booking and Scheduling, Document Management, Maps and GPS, Money/Budgeting, Resource Planning, Time Tracking.
- [hemanth/awesome-pwa](https://github.com/hemanth/awesome-pwa), 4.9k stars.
- [brunopulis/awesome-a11y](https://github.com/brunopulis/awesome-a11y), CC0, 2.0k stars.
- [agarrharr/awesome-static-website-services](https://github.com/agarrharr/awesome-static-website-services), CC0, 2.0k stars.
- [jthegedus/awesome-firebase](https://github.com/jthegedus/awesome-firebase), 797 stars, last push 2024-04, so it is stale. Firebase picks were checked against the live [firebase/extensions](https://github.com/firebase/extensions) repo instead.
- [sacridini/Awesome-Geospatial](https://github.com/sacridini/Awesome-Geospatial), CC0, 5.4k stars.
- There is **no credible "awesome-crm" list**. The top GitHub hits have 3–21 stars. The awesome-selfhosted CRM section stands in for it.
- **Field-service and roofing projects:** GitHub search for "field service management" and "roofing", sorted by stars. Nothing roofing-specific is credible. The best hit is [rrios4/roofing-webapp](https://github.com/rrios4/roofing-webapp) (14 stars, no license).

**Stats:** stars, license and last push come from `gh api repos/<owner>/<repo>`
on 2026-11-06. "NOASSERTION" licenses were resolved by reading the LICENSE
file.

**Constraints every candidate was judged against:**
- Strict CSP: no CDN scripts, no inline scripts or handlers. Anything adopted is vendored under `docs/`.
- Firebase only (Firestore, Functions gen2, Hosting).
- Multi-tenant by `companyId`.
- Money in cents.
- Any new paid SaaS is flagged with its cost.
- Licenses must be MIT, BSD, Apache-2.0 or similar. GPL/AGPL projects count as **idea only**.

**Verdicts:**
- **Adopt** means add it: vendored, or as a dev or Functions dependency.
- **Borrow** means take the idea or the pattern, not the code.
- **Skip** means not worth it, or we already have it.

---

## Already on main: drop these from future sweeps

The lists suggest these, and main already has them. Each line was checked in
this pass.

| List suggestion | What main has |
|---|---|
| PapaParse (CSV import) | `docs/pro/js/data-import.js:70` `parseCsv` already handles the BOM, quoted cells and `""` escapes |
| DOMPurify | AI replies are escaped *before* markdown formatting (`docs/pro/js/ai.js:265-278`), and `docs/pro/js/dom-safe.js` covers template-literal sinks. DOMPurify only ships inside the vendored html2pdf and jsPDF bundles |
| Paged.js (print CSS) | Server PDFs already use Chromium `displayHeaderFooter` with a running-footer contract (`functions/render-pdf.js:431`, `:759`, `:979`) |
| Gotenberg / Stirling-PDF | `functions/render-pdf.js` (puppeteer-core + @sparticuz/chromium) and `pdf-lib` already cover HTML→PDF and stamping |
| Self-hosted OSRM | Already running: a private Cloud Run service (`routing/osrm`, `functions/route-drive.js`) |
| Fuzzy search (Fuse, uFuzzy) | MiniSearch 7.2.0 is already vendored (`docs/assets/vendor/minisearch/`). Use it before adding Fuse (the 11-04 sweep's CRM pick 3) |
| Cloud Tasks for delayed jobs | `onTaskDispatched` is already used in Functions |
| Firestore TTL | `firestore.indexes.json` `fieldOverrides` already sets `ttl: true` fields |
| Font subsetting | Fonts already ship as latin / latin-ext split `woff2` (`docs/assets/fonts/`) |
| SVG optimisation | `scripts/illustrations/svgo.config.cjs` |
| Prose/claim linter (Vale) | Our own claim scans already do this job: `tests/claim-wording.test.js`, `ky-claims-wording-scan.test.js`, `homeowner-claims-honesty-2026-10-05.test.js` and siblings. Vale ([vale-cli/vale](https://github.com/vale-cli/vale), MIT, 6.3k stars) would be a second copy of the same rules |
| pa11y-ci | axe-core/playwright is already in `tests/`. pa11y-ci is also LGPL-3.0 |

---

## 1. CRM features

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit with our constraints | Effort | Verdict |
|---|---|---|---|---|---|---|
| **fast-check** (property-based tests) | [dubzzz/fast-check](https://github.com/dubzzz/fast-check) · MIT · 5.2k · 2026-11-06 (v4.10.2) | Generates thousands of random estimates, square counts, tier and deposit inputs, then checks invariants: cents stay integers, deposit ≤ total, tier prices are ordered (Good < Better < Best < Beyond), job minimum ≤ price, and the client and server agree on deposits | `tests/estimate-pricing-paths-2026-10-05.test.js`, `deposit-rule`, `estimate-engine-parity` (client `docs/pro/js/deposit-rule.js` vs `functions/deposit-rule.js`) | Dev dependency in `tests/` only; nothing ships. Directly targets the "a test that cannot fail" problem in the memory notes | S–M | **Adopt** |
| **Dinero.js** (money objects) | [dinerojs/dinero.js](https://github.com/dinerojs/dinero.js) · MIT · 6.8k · 2026-11-06 | Immutable integer money with allocation (e.g. a 50% deposit split with no lost cent) | Would replace hand-rolled cents math in `estimate-logic-engine.js` and `deposit-rule.js` | We already do cents everywhere. Swapping libraries in the money path is a big, risky diff for little gain | L | **Borrow** its `allocate()` rule (remainders go to the first share) as a test invariant, inside the fast-check work |
| **Frappe Gantt** | [frappe/gantt](https://github.com/frappe/gantt) · MIT · 6.2k · 2026-06-18 | A drag-to-reschedule bar timeline for a crew's week of jobs (tear-off → dry-in → gutters) | The production board (`docs/pro/js/production.js`) | Standalone ES build plus a separate CSS file; check that it doesn't inject `<style>`. Overlaps with the EventCalendar resource timeline (11-04 sweep, PR #2835) | M | **Skip** for now. Pick one timeline engine; EventCalendar is already proven CSP-clean |
| **rrule.js** | [jkbrzt/rrule](https://github.com/jkbrzt/rrule) · BSD-3 · 3.8k · 2024-06 (quiet) | RFC 5545 recurrence ("every April and October") | Roof Care Plan visit schedule (`care-plan-crm.js`, `functions/care-plan*.js`), ICS feed (`functions/calendar-feed*.js`) | The repo is quiet since mid-2024. Care Plan visits are 1–2 fixed dates a year, so a plain `{month, day}` list is simpler | S | **Skip**. Revisit only if recurring rules get user-defined |
| **Krayin CRM** | [krayin/laravel-crm](https://github.com/krayin/laravel-crm) · MIT · 24.1k · 2026-11-06 | Laravel CRM. Worth studying: **email → lead parsing** (an inbound mailbox turns into leads with the thread attached) and drag-built web forms | Ideas for `receipt-inbox` (which already parses inbound mail) and for lead intake (`functions/public-lead-*.js`) | PHP/MySQL, so no code reuse | — | **Borrow**: "forward a homeowner's email to leads@ and it becomes a lead with the thread attached" is a real gap. Reuse the receipt-inbox pipeline |
| **Twenty** | [twentyhq/twenty](https://github.com/twentyhq/twenty) · AGPL-3.0 + commercial files · 60.6k · 2026-11-07 | Record pages, a views/filters model, a workflow builder | UI study only | AGPL | — | **Borrow (idea only)**. Already logged in Repo Lab |
| **Relaticle** | [relaticle/relaticle](https://github.com/relaticle/relaticle) · AGPL-3.0 · 1.8k · 2026-11-07 | A CRM with an MCP server and "AI changes need a human's approval" | — | AGPL. We already ship this pattern: the role-scoped `/api/mcp` with draft-only bots and the Agent inbox | — | **Skip**. A useful sign that the Agent-inbox design matches where open-source CRMs are heading |
| **EspoCRM / SuiteCRM / Django-CRM** | [espocrm/espocrm](https://github.com/espocrm/espocrm) · AGPL-3.0 · 3.6k · 2026-11-06 | Mature CRMs. The one idea worth a look is EspoCRM's per-role **field-level** permissions | `docs/pro/js/role-gate.js`, `firestore.rules` | AGPL, PHP | — | **Borrow (idea only)**. Hide cost and margin fields from the viewer role in the UI. The rules already gate the data |
| **InvoicePlane** | [InvoicePlane/InvoicePlane](https://github.com/InvoicePlane/InvoicePlane) · MIT code + trademark notice · 3.3k · 2026-11-06 | Quote → invoice → payment, with **partial-payment ledgers** per invoice | `functions/invoice-*.js`, `payment-timeline.js` | PHP. Our Stripe ledger and payment timeline already cover this | — | **Skip** |
| **SheetJS** (xlsx import) | [SheetJS/sheetjs](https://github.com/SheetJS/sheetjs) · Apache-2.0 · 36k · GitHub mirror stale since 2024-04 | Excel import for `data-import.js` (today it accepts CSV only) | `docs/pro/js/data-import.js:249` | Current builds ship from `cdn.sheetjs.com`, not npm. It's about 1 MB to vendor | M | **Skip**. "Export as CSV" covers it |

## 2. Field and mobile

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit | Effort | Verdict |
|---|---|---|---|---|---|---|
| **OSRM `/trip` service** (on the OSRM we already run) | [Project-OSRM/osrm-backend](https://github.com/Project-OSRM/osrm-backend) · BSD-2 · 8.2k · 2026-11-02 | Orders a day's stops for the shortest drive (a TSP solve). Today `route-drive` only scores stops **in the order given** (`docs/pro/js/route-drive.js:6`). Nothing reorders them | `functions/route-drive.js` / `route-drive-logic.js` (add a `/trip/v1/driving/` call next to the existing `/route` call), Mission Control's day route | No new service, dependency or cost: it's an endpoint on the private Cloud Run OSRM we already run. Keep `source=first` (start at home or the office) | S | **Adopt** |
| **VROOM** (vehicle routing with time windows) | [VROOM-Project/vroom](https://github.com/VROOM-Project/vroom) · BSD-2 · 1.9k · 2026-11-05 (v1.15.0) | Route planning that respects **appointment windows** (Cal.com 60/60/90-minute slots), service time per stop, and several reps | A second Cloud Run container beside OSRM, called from `route-drive.js` | It's a C++ binary that uses our OSRM as its matrix source. Cloud Run cost stays in the free tier at our volume (still to be confirmed with real traffic) | M | **Adopt after** `/trip`, once more than one rep runs routes |
| **US Census Geocoder** (public API, not a repo) | geocoding.geo.census.gov · public domain · free, no key | A free third source for door-number checks, alongside Google (paid) and Regrid (paid) | `functions/handlers/geocode.js`. Its header notes that the Census geocoder is CORS-blocked in the browser, which is fine from Functions | Free. US addresses only (all we need). Batch endpoint up to 10k rows | S | **Adopt** as the first, free pass. Call Google and Regrid only when Census and Nominatim disagree |
| **Nominatim usage policy** (finding, not a tool) | [osm-search/Nominatim](https://github.com/osm-search/Nominatim) · GPL-2.0 | — | The browser calls `nominatim.openstreetmap.org` directly (`docs/pro/js/d2d-tracker-core-2026b.js:219-220`), and so do Functions (`functions/integrations/measurement.js:238`) | The public OSMF server allows **at most 1 request per second, no heavy use**, and requires an identifying Referer/UA. One rep is fine; a storm-day canvass team is not | S | **Borrow**: add a client-side 1 req/s throttle and lean on the server cross-check. Self-hosting is GPL and overkill (the 11-04 sweep agrees) |
| **Capacitor** (wrap the CRM PWA as a native iOS/Android app) | [ionic-team/capacitor](https://github.com/ionic-team/capacitor) · MIT · 17k · 2026-11-06 | **Background photo upload after the app closes** (iOS PWAs can't do it; see the 11-04 offline-queue note), reliable push, native camera, and App Store presence for NBD Pro tenants | Shell around `docs/pro/` | Apple developer account $99/yr (**paid, flag**). The App Check provider changes to App Attest. Needs review builds. It's a product decision, not a library | L | **Decision for Jo**. Do the IndexedDB upload queue first. Choose Capacitor only if reps still lose photos |
| **Workbox** | [GoogleChrome/workbox](https://github.com/GoogleChrome/workbox) · MIT · 13k · 2026-10-29 | Precache manifests, runtime caching strategies, `BackgroundSyncPlugin` | `docs/pro/sw.js`, `docs/sw.js` (hand-written, 42 lines) | Background Sync **doesn't exist on iOS Safari**, which is where reps are. The rest is a build step for something small that already works | M | **Skip**. Borrow its "retry on `online` / `visibilitychange` / launch" pattern for the photo queue |
| **geofire-common** (geohash queries) | [firebase/geofire-js](https://github.com/firebase/geofire-js) · MIT · 1.4k · 2026-11-04 | "Leads and customers within X miles" as an indexed Firestore query, not a client-side scan | `storm_near_customers`, D2D "nearby", `storm-outreach` | Pure JS, tiny, Firestore-native. Needs a `geohash` field written on lead create plus a backfill, so the stamp must be per `companyId`. No geohash exists on main today | M | **Borrow later**. Worth it only when a tenant has thousands of leads |
| **H3** (hex grid) | [uber/h3-js](https://github.com/uber/h3-js) · Apache-2.0 · 1.1k · 2026-11-04 | Hex binning for "doors knocked per block" heatmaps | `d2d-tracker-*`, `maps-overlays.js` | A large library for one heatmap view. leaflet-heat is already vendored | M | **Skip** |
| **RoofSense** | [DimitrisMantas/RoofSense](https://github.com/DimitrisMantas/RoofSense) · MIT · 14 · 2025-07 | Roof-material classification from aerial imagery plus LiDAR (Netherlands data) | — | A research code base, trained on Dutch data | L | **Skip** (idea only). It confirms the 11-04 finding: no usable open roof-measurement model exists |

## 3. Documents and e-sign

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit | Effort | Verdict |
|---|---|---|---|---|---|---|
| **@signpdf** (PAdES digital seal) | [vbuch/node-signpdf](https://github.com/vbuch/node-signpdf) · MIT · 942 · 2026-11-06 (v4.0.0, 2026-10-19) | A **cryptographic seal** on every signed contract. Adobe Reader shows "signed, not modified since", so any later edit breaks the seal visibly. Today `functions/esign-stamp.js` burns the values in and appends a certificate page with a digest. That's evidence, but nothing is sealed | `functions/esign-stamp.js`, after the stamp and before storage | Pure Node, works with `pdf-lib`. Needs a signing certificate held in Secret Manager. A self-signed cert works but shows "unknown signer". An Adobe AATL document-signing cert is **paid** (usually a few hundred dollars a year; **flag, Jo's call**). One NBD cert for all tenants or one cert per tenant is a multi-tenant decision. Contract language still goes through the attorney | M | **Adopt (self-signed first)**. The AATL cert is Jo's decision |
| **DocuSeal / Documenso / OpenSign** | [docusealco/docuseal](https://github.com/docusealco/docuseal) etc. · AGPL-3.0 | Field auto-placement, signing order, audit trail | — | AGPL. We have our own e-sign (`esign-autodetect.js`, `esign-envelope.js`, `esign-reminders.js`, in-person signing) | — | **Skip** (idea only; already rejected on 11-04) |
| **Signature PDF** | [24eme/signaturepdf](https://github.com/24eme/signaturepdf) · AGPL-3.0 | Multi-party signing of an uploaded PDF | Uploaded third-party PDFs (an insurer's form, an HOA approval) | AGPL | — | **Borrow (idea only)**: "sign an uploaded PDF" is a real gap next to our template-generated docs |

## 4. Scheduling

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit | Effort | Verdict |
|---|---|---|---|---|---|---|
| **Cal.diy** | [calcom/cal.diy](https://github.com/calcom/cal.diy) · MIT · 49.8k · 2026-11-03 | The MIT community edition of Cal.com, so we could self-host booking and drop the Cal.com SaaS | Would replace the Cal.com webhook flow (`functions/portal-booking.js` and the booking pages) | Needs Postgres plus a Next.js server, so **not Firebase-only**. Its README recommends it for personal self-hosting and points commercial users to Cal.com | L | **Skip**. Stay on Cal.com. The 11-04 "routing form before booking" idea is the better next step |
| **temporal-polyfill** | [fullcalendar/temporal-polyfill](https://github.com/fullcalendar/temporal-polyfill) · MIT (per its package.json; the API shows no license file) · 786 · 2026-11-04 | `Temporal.ZonedDateTime` for America/New_York job windows: the standard successor to `Date`, where Day.js (11-04 pick) is a library | Same places as the Day.js pick: schedule windows, `storm-time.js`, the clock-edge bugs | When browsers ship Temporal natively the polyfill can be deleted, which Day.js can't | S per screen | **Adopt instead of Day.js**, screen by screen. Check Safari's native Temporal status before each screen |
| **date-holidays** | [commenthol/date-holidays](https://github.com/commenthol/date-holidays) · ISC code + **CC BY-SA 3.0 data** · 1.1k · 2026-10-25 | Skips US holidays in follow-up and invoice-reminder ladders and booking suggestions | `functions/invoice-overdue*.js`, `lead-followup.js`, `sms-send-window.js` | The data license is share-alike and needs attribution. We need ~11 federal holidays, a 20-line table | S | **Skip**. Hand-write the US federal list in `sms-send-window.js` if wanted |

## 5. Marketing site and SEO

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit | Effort | Verdict |
|---|---|---|---|---|---|---|
| **Satori + resvg-js** (build-time Open Graph cards) | [vercel/satori](https://github.com/vercel/satori) · MPL-2.0 · 14.2k · 2026-11-06; [thx/resvg-js](https://github.com/thx/resvg-js) · MPL-2.0 · 2.0k · 2026-06-30 | A share card per page: town name, service, a real job photo, the brand bar. **229 of 328 pages share `joe-hero.jpg`** as their `og:image`, so every town and blog link looks the same in texts and Facebook | A new `scripts/build-og-images.mjs` run beside `build-town-pages.mjs` and the blog POSTS restamp, writing to `docs/assets/og/`; the partials stamp `og:image` | Build-time only (Node), so nothing new ships to the browser and the CSP is untouched. MPL-2.0 is file-level copyleft, fine for an unmodified build tool. Must use EXIF-stripped photos from `docs/assets/` only, never CRM Storage URLs | M | **Adopt** |
| **capo.js** (`<head>` order audit) | [rviscomi/capo.js](https://github.com/rviscomi/capo.js) · Apache-2.0 · 1.1k · 2026-09-19 | Flags `<head>` elements in an order that slows first paint (e.g. a stylesheet before a preload) | Run over the built pages as a report-only check next to `perf-watch` | A Node/CLI mode exists. Report only | S | **Adopt** (report-only) |
| **Unlighthouse** (whole-site Lighthouse) | [harlan-zw/unlighthouse](https://github.com/harlan-zw/unlighthouse) · MIT · 4.9k · 2026-10-27 | Lighthouse on **every** page (300+ area, service and blog pages), not just the money pages `perf-watch.yml` samples | A monthly manual workflow, not a required check | Long runtime. The runner backlog is already heavy, so keep it manual or monthly | S | **Borrow**: run it locally once a month and log the worst 20 pages to a vault note |
| **Partytown** (GA off the main thread) | [QwikDev/partytown](https://github.com/QwikDev/partytown) · MIT · 13.8k · 2026-11-05 | Moves GA and Clarity work into a worker | `docs/assets/js/ga-loader.js`, `clarity-loader.js` | It runs third-party code through a service-worker proxy, which would fight `docs/sw.js`. It also needs `connect-src` and worker CSP changes, and GA isn't a measured bottleneck (the 11-05 Lighthouse baseline is A11y/SEO 100) | M | **Skip** |
| **schema / OG validation** | — | — | — | Covered by the 11-04 pick (schema-dts) | — | — |

## 6. Accessibility and performance

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit | Effort | Verdict |
|---|---|---|---|---|---|---|
| **IBM Equal Access checker** | [IBMa/equal-access](https://github.com/IBMa/equal-access) · Apache-2.0 · 786 · 2026-10-30 | A **second a11y engine** with rules axe doesn't have (some ARIA misuse and reading-order checks), via `accessibility-checker` in Playwright | `tests/e2e/fixtures/` beside `axe.js` | Dev dependency only. Report-only first; two engines disagree, so triage before blocking | S | **Adopt** (report-only, money pages plus the CRM login and portal) |
| **Leonardo / culori** (accessible tenant palettes) | [adobe/leonardo](https://github.com/adobe/leonardo) · Apache-2.0 · 2.2k · 2026-07-08; [danburzo/culori](https://github.com/danburzo/culori) · MIT · 1.3k · 2026-11-04 | When a tenant picks a brand color, **generate** the hover, light and on-color shades at a target contrast ratio instead of only testing them afterwards (`tests/portal-tenant-cta-contrast-2026-09-16.test.js` checks; nothing generates) | `docs/pro/js/company-profile.js` brand-color save, `docs/pro/js/customer-presentation-theme.js`, tenant overrides in the document generator | culori is plain ESM with no eval. NBD's own palette must stay byte-identical (`tests/docgen-brand.test.js`), so derive shades **only for non-NBD tenants** | M | **Borrow** the algorithm (lightness search to a WCAG ratio, about 40 lines) rather than vendoring. culori if the math grows |
| **a11y-dialog** | [KittyGiraudel/a11y-dialog](https://github.com/KittyGiraudel/a11y-dialog) · MIT · 2.5k · 2026-11-02 | Focus trap, Esc, `inert` background for modals | `docs/pro/js/nbd-modal.js`, `overlay-a11y.js` | Native `<dialog>.showModal()` (already used in 4 places) gives the same thing with no library | — | **Skip**. Migrate modals to native `<dialog>` as they are touched |
| **Guidepup** (real screen-reader automation) | [guidepup/guidepup](https://github.com/guidepup/guidepup) · MIT · 592 · 2026-11-01 | Drives VoiceOver and NVDA from Playwright and records what is actually announced | A one-off audit of `/inspect` and the booking flow | Needs a macOS or Windows runner with the screen reader, so not cheap in CI | M | **Borrow**: one manual NVDA pass on Jo's Windows machine per quarter, not CI |
| **pwa-asset-generator** | [elegantapp/pwa-asset-generator](https://github.com/elegantapp/pwa-asset-generator) · MIT · 3.0k · 2026-10-12 | iOS **splash screens** (`apple-touch-startup-image`). The CRM home-screen app currently opens on a blank white screen. There are no startup images on main; `dashboard.html` has only a 192 px `apple-touch-icon` | `docs/pro/dashboard.html` head, `docs/pro/img/` | Run once (puppeteer, already in `tests/`); commit the PNGs; static `<link>` tags. CSP-neutral. A tenant-branded splash would need per-tenant files, so ship a neutral NBD Pro splash | S | **Adopt** |
| **size-limit** | [ai/size-limit](https://github.com/ai/size-limit) · MIT · 7.0k · 2026-11-02 | Byte budgets per page bundle (e.g. the dashboard's JS) that fail when a change bloats them | `tests/` or a report-only CI step | No bundler here, so use the file-list mode. A 20-line Node script over `dashboard.html`'s `<script src>` list does the same | S | **Borrow**: write that script |

## 7. Dev tooling and CI

| Candidate | Repo · license · stars · last push | What it would add | Where it plugs in | Fit | Effort | Verdict |
|---|---|---|---|---|---|---|
| **typos** | [crate-ci/typos](https://github.com/crate-ci/typos) · Apache-2.0 · 4.2k · 2026-11-04 | Catches misspellings in site copy, code and vault notes. Low false positives because it uses a known-typo list, not a dictionary | Report-only CI step plus `_typos.toml` (allow "NBD", "Hardie", "TAMKO", "HailGuard"…) | Single binary with a checksum download, the same pattern as gitleaks. Report-only first | S | **Adopt** |
| **lefthook** (local git hooks) | [evilmartians/lefthook](https://github.com/evilmartians/lefthook) · MIT · 9.0k · 2026-11-06 | Runs the cheap pre-push gates from CLAUDE.md automatically, only for the files a push touches (e.g. `check-vault-index` when `documentation/` changed) | `lefthook.yml` at the root. Local only; CI is unchanged | Single binary, no network at run time. Opt-in per clone, so parallel worktrees aren't surprised | S | **Adopt** (opt-in) |
| **eslint-plugin-compat** | [amilajack/eslint-plugin-compat](https://github.com/amilajack/eslint-plugin-compat) · MIT · 3.2k · 2026-07-23 | Flags browser APIs our oldest supported iPhone Safari lacks (e.g. `Array.prototype.at`, `structuredClone`, View Transitions) before reps hit them | Report-only lint over `docs/**/*.js` with a `browserslist` of "iOS ≥ 16" | No ESLint in the repo today, so this adds ESLint as a dev dependency in `tests/` | S–M | **Borrow**: run it once, fix the hits, keep the config for occasional use |
| **markdownlint-cli2** | [DavidAnson/markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) · MIT · 973 · 2026-11-04 | Consistent vault notes (heading levels, broken tables) | `documentation/**` | `check-vault-index.js` already covers what matters (links). Style lint on 1,000+ notes would be noise | S | **Skip** |
| **zod** | [colinhacks/zod](https://github.com/colinhacks/zod) · MIT · 44.3k · 2026-11-06 | One declared schema per callable's input | `functions/handlers/*.js`, `public-lead-intake-spec.js` | Validation is hand-written and well tested (`public-lead-guard.js`). The Ponytail rule says a dependency has to earn its place | M | **Skip**. Revisit for brand-new callables only |
| **firebase/extensions** | [firebase/extensions](https://github.com/firebase/extensions) · Apache-2.0 · 979 · 2026-11-05 | `firestore-bigquery-export` (stream collections to BigQuery for reports); `delete-user-data` | Reports (`server-aggregates.js`, `reports-*.js`); tenant erasure | BigQuery has a free tier but is still a **new billed GCP service (flag)**. Exported rows must keep `companyId`, and BigQuery access is not gated by Firestore rules. Erasure is "suspend" by decision (role-permission memory), so delete-user-data doesn't fit | M | **Skip** until reports outgrow client-side aggregation |

## 8. Field-service and roofing open source (idea mining)

- **[OCA/field-service](https://github.com/OCA/field-service)** (Odoo, AGPL-3.0, 204 stars, 2026-11-06). Idea only. Worth borrowing:
  - A **"location" record that outlives the customer.** A house keeps its roof age, prior jobs and photos when it sells. `property-intel.js` is the natural home: key the history by normalised address, not by lead.
  - **Equipment per location**: shingle line, install date, warranty registration number. That feeds the Care Plan and the warranty certificate (`warranty-cert.js`).
- **[rseroter/roofing-agent-app](https://github.com/rseroter/roofing-agent-app)** (Apache-2.0, 17 stars, 2025-07). A Google Cloud sample, not a product. Skip.
- **[dicktracey909/awesome-construction-calculators](https://github.com/dicktracey909/awesome-construction-calculators)** (19 stars, no license). Skip. Our estimate engine is ahead of anything listed.
- Every credible field-service suite (Odoo FSM, ERPNext, Dolibarr, Ever Gauzy) is GPL or AGPL, so all of it is **idea only**.

---

## Ranked top 10

Ranked by payoff ÷ effort, with nothing that breaks a constraint. None of
these is approved work; each needs Jo's OK and its own PR.

1. **OSRM `/trip` stop ordering** on the private OSRM we already run. **S.** This is the "plan my day" button reps don't have: today the route scores the order you typed. `functions/route-drive.js`.
2. **fast-check property tests on the money path.** **S–M.** It puts invariants on cents, deposits, tier order and client/server parity, with Dinero's remainder rule as one of them. Tests only, nothing ships. Pins can't go silently green.
3. **Per-page Open Graph cards (Satori + resvg, build time).** **M.** 229 of 328 pages share one share image. Town and blog links would finally look distinct in texts and Facebook. No browser code, no CSP change.
4. **Census geocoder as the free first pass** in `functions/handlers/geocode.js`, plus a 1 req/s throttle on the browser's Nominatim calls. **S.** Fewer paid Google and Regrid lookups, and we stay inside OSM's usage policy on storm days.
5. **iOS splash screens for the CRM home-screen app** (pwa-asset-generator, run once). **S.** It ends the blank white launch screen on the phone.
6. **PAdES seal on signed contracts** (@signpdf, self-signed cert first). **M.** Tampering becomes visible in any PDF reader. The paid AATL cert, and one cert vs per-tenant certs, are **Jo's decisions**. The attorney review rule is unchanged.
7. **typos in CI, report-only.** **S.** It catches copy typos across 300+ pages before homeowners see them.
8. **IBM Equal Access as a second a11y engine, report-only.** **S.** It covers rules axe misses on the money pages, portal and login.
9. **lefthook, opt-in local pre-push gates.** **S.** The CLAUDE.md gate list runs itself, scoped to what changed.
10. **Accessible tenant palette generation** (the Leonardo idea, hand-written). **M.** When a tenant picks a brand color, generate the shades at a WCAG ratio instead of only testing them afterwards. NBD's own palette stays byte-identical.

**Next in line:**
- VROOM time-window routing, after #1 and once a second rep routes.
- temporal-polyfill instead of Day.js for the ET-window screens.
- "Forward an email → lead" on the receipt-inbox pipeline (Krayin idea).
- A property-level history keyed by address (OCA field-service idea).

## Decisions for Jo

- **Capacitor native wrapper** ($99/yr Apple developer account). It is the only way to get background photo upload on iOS. Try the IndexedDB queue first.
- **AATL document-signing certificate** for the PAdES seal (paid, usually a few hundred dollars a year), and one NBD cert vs per-tenant certs.
- **BigQuery export** for reporting: a new billed GCP service. Skipped for now.
