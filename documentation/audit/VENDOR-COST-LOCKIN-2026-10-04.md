# Vendor cost and lock-in map (2026-10-04)

**Ask (Jo):** *"I don't want to be tied to software or companies or tools
that we could replace one day but be stuck with the cost of regardless or be
inseparable."* Final scope, after the coordinator's refinements: replace the
services that **cost money**, especially where the vendor costs far more than
building and running our own. Free or near-free services can stay outsourced,
as long as each has an exit note.

**Method:** read-only recon of `origin/main` @ `24e3e980`, covering:
`functions/` (every `defineSecret`, `fetch` host and `require`), `functions/.env.nobigdeal-pro`,
`firebase.json` CSP, `docs/` (every external script, font, tile, iframe and
form target), `.github/workflows/`, all three `package.json` files, and the
audit and runbook notes. No dashboards, bills or prod reads.

> **Every dollar figure here is an estimate from public pricing at our likely
> usage. None is Jo's bill.** The ranking can only be finished with real
> numbers from: GCP Billing → Reports (group by SKU, last 3 months); the
> Stripe dashboard (card vs ACH volume and fees); Bland billing (minutes and
> plan); Instant Roofer invoices; Anthropic console usage; and a card-statement
> sweep for subscriptions (Semrush, Calendly, Metricool, xAI/SuperGrok,
> Cube ACR).

## Bottom line

1. **Most of the stack is already free-tier or pay-per-use.** The code has
   no big monthly SaaS bill hiding in it. The largest *possible* money
   leaks sit outside the code: **card fees on big roofing tickets**, and
   **subscriptions Jo may pay for but the system never calls**.
2. **About 14 integrations are wired but dark.** Their secrets hold the
   deploy's `__unset__` stub, so they cost nearly nothing, but each still
   carries code, a secret, a CSP hole or a privacy leak.
3. **Some of our IP lives only at a vendor.** Thursday's Bland agent and
   pathway are the worst case: their only backup is in `%TEMP%` on Jo's PC.
   Cal.com event types, Metricool post history and Grok Bot prompts are the
   others. Exporting them pays back right away, because losing them would
   cost a rebuild.

## 1. Ranked replace list (by payback)

Payback = one-off build effort ÷ (yearly vendor cost − our yearly run cost).
Build sizes: S ≈ ≤1 day, M ≈ 2–5 days, L ≈ 2+ weeks of agent-lane work plus
Jo QA.

| # | Item | Vendor cost (est.) | Our run cost (est.) | Build | Payback | Verdict |
|---|---|---|---|---|---|---|
| 1 | **Stripe card fees → ACH / Zelle / check first** | Card 2.9% + 30¢. A $12k roof = **~$348**. ACH 0.8% capped at $5 | $0 (Zelle and check); ACH ≤ $5 | S (ACH and Zelle UI already in PR #2143) | **Immediate** | SWITCH (payment mix). Needs Stripe volume |
| 2 | **Subscriptions the code never calls**: Semrush (public Pro ≈ $140/mo), Calendly (≈ $10–16/mo, duplicates Cal.com), paid Metricool tier, xAI/SuperGrok (≈ $30/mo) | Up to ≈ $2.3k/yr if all are paid | $0 | None | **Immediate** | CUT whatever Jo confirms is paid. Search Console replaces Semrush (Jo 10-02: "always use console") |
| 3 | **Vendor-held IP export** (Bland agent and pathway, Cal.com event types, Metricool history, Grok Bot prompts) | Cost of a rebuild if the account is lost | ≈ $0 (private bucket) | S | **Immediate** (insurance) | OWN the config |
| 4 | **Dead-integration removal** (Upstash, Swath, HailTrace, Hover, EagleView, Nearmap, Regrid, Google Geocoding, Deepgram, Kie/Replicate duplicate, BoldSign, Slack if unset) | ≈ 25 stub secrets × $0.06/mo ≈ **$18/yr** plus upkeep | $0 | S–M | < 1 yr once upkeep counts | CUT |
| 5 | **Instant Roofer** (public `/estimate` auto-measure, ~$3/lead per `SPEND_KILLSWITCH.md`) | 30 leads/mo ≈ **$1,080/yr** (estimate) | Google Solar API building insights, ≈ cents per call (**pricing to verify**), or $0 with the in-house draw tool | M | ≈ 2–4 mo **if** volume is near 30/mo | SWITCH-CHEAPER, conditional on the invoice count |
| 6 | **Metricool → self-hosted Postiz** | Paid tiers ≈ $20–55/mo (estimate) | Small VPS ≈ $5–7/mo plus upkeep | M | ≈ 3–6 mo if on a paid tier; never if free | Conditional |
| 7 | **Bland (Thursday) → own voice receptionist** (Twilio Voice + streaming STT + Claude Haiku + TTS) | ≈ $0.09–0.14/min plus any plan fee (estimate) | ≈ $0.03–0.05/min | **L** (low latency, barge-in, call transfer) | At 500 min/mo, ≈ $40/mo saved → **years**. Pays back only above ≈ $250/mo spend | Not yet. Do #3 now, revisit with the bill |
| 8 | **Twilio Verify → own OTP over Twilio SMS** | $0.05 per verification | ≈ $0.01 (SMS segment) | S | Only at volume | Low. Bundle with other Twilio work |
| 9 | **GCP hygiene** (38 schedules, Cloud Logging volume) | Scheduler $0.10/job/mo beyond 3 free ≈ $42/yr; log ingest beyond 50 GiB | — | S | Unknown until billing is read | WATCH. Read GCP Billing → Reports |

Not on the list: **Anthropic** (Haiku, usage-billed). Running our own model
costs more: a GPU runs ≈ $300+/mo before any work gets done. `claudeProxy`
is already an adapter, and the kill switches in `SPEND_KILLSWITCH.md` cap it.

## 2. Fine to keep (free or cheap), each with an exit

| Service | What it does / where | Cost (public) | Data ours and exportable? | Exit note |
|---|---|---|---|---|
| Firebase / GCP (Firestore, Functions, Storage, Hosting, Secret Manager, Logging) | Everything | Blaze, usage-based. `renderPdf` dropped warm instance 2026-09-05 (was $17.92/mo) | Yes. Daily `firestore-backup.js` export | Postgres + Cloud Run or any VPS. A large rewrite (rules, triggers). Backups are the real exit |
| Google Workspace | jd@ / info@ mail | ≈ $7–14/user/mo | Yes (Takeout) | Fastmail / Zoho. MX swap is about a day |
| Resend | 22 call sites, transactional mail | Free 3k/mo, 100/day. Pro $20/mo | Logs only; content is ours | SES / Postmark. Calls are spread over 22 files, so a `sendMail()` adapter (S) makes this a one-file swap |
| Twilio | SMS, Verify (`sms-functions.js`, `lead-alert.js`, `storm-watch.js`, `verify-functions.js`) | Number ≈ $1.15/mo + per-segment + A2P fees. **Trial; 0 of 23 delivered** (memory 10-02) | Messages mirrored in Firestore | Telnyx / Plivo, about 1–2 days plus A2P re-registration |
| Stripe (platform) | Pay links, Connect, seats (`stripe*.js`, `handlers/seats.js`) | Per transaction only | Ledger mirrored (`stripe-ledger.js`) | Square / Adyen. See never-self-host |
| Groq | Whisper call and voice-memo transcription | ≈ $0.04/audio-hr | Transcripts stored by us | Deepgram, OpenAI, self-hosted whisper.cpp |
| Cal.com | Booking embed, 383 links in `docs/`; webhook `integrations/calcom.js` | Free individual plan (verify) | Bookings mirrored by webhook; **event types are not** | Own booking page on Google free/busy (Calendar hub plan) |
| GA4 + Search Console | Site analytics, `G-8PG7N9Q3DL` on 214 pages | Free | GA4 → BigQuery export (free tier) | Own first-party beacon. `cspReport` is the pattern |
| Microsoft Clarity | `clarity-loader.js` | Free. **Inert: `PROJECT_ID = ''`** | n/a | Leave inert or delete. Duplicates GA4 |
| Healthchecks.io | Cron heartbeats (`integrations/heartbeat.js`) | Free hobby tier | n/a | Firestore heartbeat doc + Cloud Monitoring alert |
| Sentry | `sentry-init.js`, `integrations/sentry.js` | Free tier. **Client DSN is `""`** (`nbd-auth.js:48`) | n/a | Own `clientError` reporter (PR #2140). Cut once it lands |
| Cloudflare Turnstile + reCAPTCHA (App Check) | Public forms; App Check | Free to high volume | n/a | hCaptcha. Keep |
| weather.gov, NOAA SWDI/NCEI, SPC, IEM mesonet, KY GIS, Nominatim, OSM / Esri tiles | Weather, hail, radar, geocode, maps | Free | Public data | Already the cheap path. **Check OSM and Esri tile terms at our volume** |
| Google Places / GBP API | Reviews widget and sync | Places free monthly cap; GBP free | Reviews are Google's | Manual import |
| GitHub (NBDPRO org, **public** repo) | Code, CI (24 `ubuntu-latest` jobs), merge queue | Free (public repo minutes) | Yes (git) | GitLab / Forgejo. A mirror is an S job |
| Cube ACR | Call recorder → Jo's Drive → `call-center.js` | App premium ≈ a few $/mo (verify) | Yes (Drive) | Any recorder that writes to Drive |
| Thumbtack, Acorn Finance | Lead marketplace (webhook); financing link-out | Per lead / free to us | Leads mirrored | Business decision, not software. Track ROI in the lead-source table (#2150) |
| npm packages | `functions/`: firebase-admin/functions (core), stripe, twilio, resend (thin SDKs, each could become `fetch`), sharp, pdf-lib, puppeteer-core + @sparticuz/chromium, heic-convert, handlebars, qrcode, google-auth-library, @sentry/node (cut with Sentry). `tests/`: playwright, firebase-tools, rules-unit-testing | Free OSS | Pinned in lockfiles | Only @sentry/node is worth removing. Replacing the SDKs saves no money |
| Frontend libraries | Already **vendored** under `docs/assets/vendor/` (leaflet + 4 plugins, pdfjs, jspdf, html2pdf, chartjs, apexcharts, exifr, fontawesome) | Free | — | Done. Firebase JS SDK self-hosting is in flight (PR #2155). **Stripe.js and Turnstile must load from the vendor** (PCI and bot-detection rules) |

## 3. Dead, duplicate, or "secret set but feature off"

- **Stubbed and dark** (each secret holds `__unset__`; the code no-ops):
  - Regrid and `GOOGLE_GEOCODING_API_KEY`: never provisioned (STABILITY-AUDIT-2026-09-04).
  - BoldSign: dark, and `PROVIDERS.esign` has no readers.
  - Hover, EagleView, Nearmap: stub since April (`_shared.js:98-100`).
  - Upstash: `NBD_RATE_LIMIT_PROVIDER` is unset, so the Firestore limiter
    runs. Swath and HailTrace: hail defaults to `noaa`.
  - Deepgram: fallback only. Voice defaults to `groq`.
  - Kie: flag-gated alternate. Replicate and the image visualizer: off by
    default (`VISUALIZER_IMAGEGEN_ENABLED`).
  - **Confirm in Secret Manager** before deleting anything. Slack, Sentry
    (functions), Healthchecks and Twilio Verify may also be stubs.
- **Dead client code** (blocked by our own CSP, so it can never have
  worked): OpenWeatherMap (`d2d-tracker-core-2026b.js:1365`, `rep-os.js`)
  and the RainViewer radar tiles (`d2d-tracker-core-2026b.js:4473`,
  `maps-overlays.js`). Neither host is in `connect-src` or `img-src`.
- **EmailJS:** vendored library plus config in `email_system.js`. The
  provider defaults to `mailto`, so it is dormant.
- **FormSubmit.co:** the homepage contact form still copies every lead
  (name, phone, address) to a free third party as a "backup"
  (`docs/assets/js/inline/72f02d79d0.js:199`). So does the Oaks tenant
  site. Our own lead intake and alerts already do this job. **Cut it, for
  privacy as much as cost.**
- **Duplicates:**
  - E-sign: BoldSign vs in-house `esign-envelope.js` and `remote-signing.js`.
    The STABILITY audit notes they are not fully interchangeable yet.
  - Analytics: GA4, Clarity and Search Console.
  - Error tracking: Sentry vs the PR #2140 reporter.
  - Scheduling: Cal.com vs Calendly (a connector is enabled in Jo's
    workspace).
  - Image generation: Replicate vs Kie.
  - Transcription: Groq vs Deepgram.
  - Assistant AI: Grok Bots vs Claude.
- **ToS risk:** the D2D tracker loads raw Google tiles from
  `mt{s}.google.com/vt/…` (`d2d-tracker-core-2026b.js:187-199`). That is
  an undocumented endpoint Google can block or bill. Swap it for Esri World
  Imagery (already in the CSP) or USGS NAIP (public domain).
- **Google Fonts:** the main marketing site already self-hosts Barlow
  (`docs/assets/fonts/`). Still on fonts.googleapis.com: 27 `docs/pro`
  pages, 6 in `docs/pro/blog`, 12 in `docs/sites/oaks`, 5 in `docs/admin`,
  plus tools and other sites. Vendoring them costs nothing and removes a
  third-party request (privacy and performance, not money).

## 4. IP and ownership: what lives only at a vendor

| Asset | Where now | Risk | Export plan |
|---|---|---|---|
| Thursday: Bland agent `4c2b2b93…`, pathway `771a3ea4…`, persona, prompt, number config | Bland. Backup is only in `%TEMP%/thursday-bland-backups` on Jo's PC | **High.** A temp dir gets wiped; the account can be lost | `scripts/export-bland.js` (reuses `scripts/_bland.js`) pulls agent and pathway JSON nightly or on demand into a **private** Storage bucket or a private repo. **Never the public repo**: prompts and the lookup token config |
| Cal.com event types, questions, routing | Cal.com | Medium | API export to JSON in the same private store. Bookings are already mirrored |
| Metricool post history and schedule | Metricool | Medium | CSV/API export monthly. Postiz import if migrating |
| Grok Bot roles and prompts (8 bots) | xAI app | Medium | Copy into a private doc. Agent-inbox output already lands in the CRM |
| GBP reviews | Google | Low | `gbp-reviews-sync.js` once API access is granted (case 8-9748000042165) |
| BoldSign templates | BoldSign (dark) | Low | Nothing to export if unused. Confirm in the dashboard |
| Stripe customers and invoices | Stripe | Low | `stripe-ledger.js` mirror plus the Stripe data export |
| Call recordings / SMS backups | Jo's Drive | None | Already ours |

## 5. Never self-host (and why)

- **Card processing.** PCI-DSS scope, network membership, fraud and
  chargebacks. The exit is a second processor, not our own.
- **SMS and voice carrier delivery.** Carriers require A2P 10DLC
  registration through a licensed aggregator. Nobody self-owns the rail.
- **Inbox deliverability** (sending IPs, DKIM reputation, mailbox hosting).
  A self-run SMTP server lands in spam. Keep Workspace and Resend.
- **The cloud, DNS and TLS edge.** Physical servers and anycast. Our exit is
  portable data (backups), not our own hardware.
- **LLM inference.** GPUs cost more than our whole Haiku bill.
- **Bot detection and CAPTCHA.** It works only with network-scale
  telemetry.
- **Aerial imagery capture.** Buy or use public imagery; measure in-house
  if it pays.

## 6. Build lanes (paying items only, no shared files)

Before launching any lane: `gh pr list` and `git worktree list`. **#2135,
#2143, #2155 and #2140 are open** and overlap Lanes A, C and E. Each card
lists what Jo must do.

**Lane A: Payment mix (#1).** Files: the pay-link UI in `docs/pro/js`, the
customer pay page and `functions/stripe-crm-invoice.js`.
- **Build (S):** after #2135/#2143 merge, make ACH and Zelle the default
  options on the customer pay page. Show the card fee in dollars beside the
  card option.
- **Risk:** low. KY insurance-job pay gating must stay intact.
- **Stays external:** Stripe, the bank rails.
- **Jo:** decide whether to pass card fees through. Surcharging has
  disclosure rules and a cap; check Ohio and Kentucky rules and Stripe's
  terms first.

**Lane B: Vendor IP export (#3).** New `scripts/export-vendor-config.js`
plus a runbook only.
- **Build (S):** export Bland agent and pathway, then Cal.com event types,
  to a private bucket (`gs://<private>/vendor-config/YYYY-MM-DD/`). Add a
  weekly scheduled run later.
- **Risk:** leaking a prompt or token into a public place. Write only to
  a private bucket, with a gitleaks check on the script.
- **Jo:** create the private bucket, or say which one to use. Export
  Metricool history and Grok Bot prompts by hand.

**Lane C: Server dead-integration removal (#4).** Files:
`functions/integrations/{upstash-ratelimit,swath,measurement,hail,parcel,_shared}.js`,
`handlers/integrations.js`, the related tests.
- **Build (M):**
  - Delete the Upstash adapter, Swath, HailTrace, and the Hover, EagleView
    and Nearmap branches. Keep Instant Roofer and NOAA/SWDI.
  - Delete Deepgram and the Kie/Replicate duplicate (keep one image
    provider, still flag-off).
  - Remove each `defineSecret`.
- **Order:** code first. The deploy's stub step recreates any secret still
  referenced in code. After the deploy, Jo deletes the secrets.
- **Risk:** a hidden caller. Grep every exported name and run smoke and
  unit tests.
- **Jo:** confirm none of these accounts is paid, then cancel any that are.
  Run `gcloud secrets delete` on the listed secrets, or approve doing it.

**Lane D: Client dead vendors + CSP (#4).** Files:
`docs/assets/js/inline/72f02d79d0.js`, `docs/sites/oaks/assets/js/site.js`,
`docs/privacy.html`, `docs/pro/js/email_system.js`,
`docs/assets/vendor/emailjs/`, `docs/pro/js/{d2d-tracker-core-2026b,maps-overlays,rep-os}.js`,
`firebase.json`.
- **Build (S–M):**
  - Remove the FormSubmit relay on both sites and the matching privacy
    line.
  - Remove EmailJS.
  - Remove the OpenWeatherMap and RainViewer code. Swap the Google `mt*`
    tiles for Esri or NAIP.
  - Drop `formsubmit.co` from the CSP.
- **Risk:** the Oaks tenant form needs a working path first (our intake
  endpoint). The D2D map needs a phone QA pass.
- **Jo:** tell Scott (Oaks) that the form backup is changing.

**Lane E: Google Fonts vendoring.** Files: `docs/pro/**/*.html`,
`docs/admin/*.html`, `docs/sites/**`, `docs/tools/*.html`, and new files
under `docs/assets/fonts/`. Do not touch `firebase.json`. Lane D or a
follow-up drops `fonts.googleapis.com` from the CSP once this lane merges.
- **Build (S):** self-host the families in use with `@font-face` and
  preloads, as the marketing site already does.
- **Risk:** CLS. Run the perf-watch afterward.
- **Jo:** nothing.

**Lane F: BoldSign retirement (#4).** Files:
`functions/integrations/esign.js`, `functions/portal.js`, and the BoldSign
branch of `docs/pro/js/estimate-v2-ui.js`.
- **Build (M):** route "Send for signature" to `esign-envelope.js` or
  `remote-signing.js`, then delete the BoldSign path.
- **Risk:** the two in-house paths are not yet equivalent (STABILITY-AUDIT
  §641). Estimate signing must keep ESIGN Act evidence.
- **Jo:** confirm BoldSign is unpaid and unused.

**Lane G (conditional): Instant Roofer swap (#5).** Start only if the
invoices show more than about 20 measures a month. Files: new
`functions/integrations/solar-measure.js`, plus a provider switch in
`measurement.js`. Run Lane C first, since it shares `measurement.js`.
- **Build (M):** a Google Solar API roof-segment adapter behind
  `NBD_MEASUREMENT_PROVIDER`. Test it side by side on 10 known roofs.
- **Risk:** accuracy on complex roofs. A wrong measurement becomes a wrong
  price, so keep a rep confirm step.
- **Jo:** enable the Solar API and check the price.

**Lane H (conditional): Metricool → Postiz (#6).** Start only if Metricool
is on a paid tier. Infra only; no repo files beyond a runbook.
- **Build (M):** a small VPS or Cloud Run deploy of Postiz, then reconnect
  the social accounts.
- **Risk:** upkeep, and social API token churn.
- **Jo:** connect the social accounts himself (OAuth), then cancel
  Metricool.

**Not laned:** Bland → own voice (#7). Revisit when the Bland bill passes
about $250/mo. Lane B secures the IP now.

## 7. What Jo needs to pull (10 minutes)

1. GCP Billing → Reports, last 90 days, grouped by SKU.
2. Stripe → Balance → fees by payment method, last 12 months.
3. Bland → Billing: minutes per month and the plan.
4. Instant Roofer: invoice count per month.
5. Card statement: Semrush, Calendly, Metricool, xAI/SuperGrok, Cube ACR,
   Resend, Twilio, Anthropic.

Give these to the next session; it re-ranks section 1 with real numbers.
