# GitHub repo sweep — 2026-11-04

Jo asked for a wide sweep of open-source projects worth pulling into the
ecosystem: the local server (the 1080 Ti desktop), the CRM, the homeowner
site, NBD Pro, CI, and the bots. Five research lanes looked at a few hundred
repos and short-listed about 75. Each pick was then checked against what
`origin/main` already has.

**Ground rules for every pick:** maintained (release or push in 2026), and the
license is noted (AGPL / fair-code / source-available flagged). CRM and site
code must work with **no bundler** and the **strict CSP** (no eval, no inline
scripts or handlers). Nothing private (call audio, receipts with cost figures,
GPS originals) goes under `docs/`. Star counts and dates came from the GitHub
API on 2026-11-04. Items marked *(unverified)* were not confirmed from a
primary source.

## Already have it — drop from future sweeps

The vetting pass removed these before they became work:

| Suggested | What main already has |
|---|---|
| `@axe-core/playwright` | `tests/package.json` pins 4.14.0; `tests/e2e/fixtures/axe.js` is used by the marketing and nav specs |
| Lighthouse CI | `.github/workflows/perf-watch.yml`, a weekly mobile Lighthouse run (3 runs per money page) |
| Pagefind | Our own `scripts/build-site-search.mjs` + `docs/assets/js/site-search.js` (no WASM, so no CSP change) |
| gitleaks | Already in `ci.yml`. Note that gitleaks is now "feature complete" (security patches only); see trufflehog below |
| IndexNow | Already wired (24 references) |
| signature_pad | `docs/pro/js/signature-widget.js`, our own canvas pad inside the sandboxed doc viewer |
| Turf for roof area | `docs/pro/js/draw-geom.js` does the geometry; Turf would be a second copy of the same math |
| Call transcription | `phone_calls.transcript` already exists (the Call Center data note, still on the unmerged docs branch `docs/calendar-tracker-plans`). What's missing is **speaker labels**; see WhisperX |
| GPS photo-to-lead matching | The CRM's `match_photo_location` tool plus EXIF haversine already cover it |

## Shipped in this PR

- **`.github/workflows/workflow-lint.yml`** runs [actionlint](https://github.com/rhysd/actionlint) 1.7.12 and [zizmor](https://github.com/zizmorcore/zizmor) 1.32.0 on any PR that touches workflows. It is **report-only**: `continue-on-error`, not a required check, and findings go to the job summary. Once the baseline is triaged, make it blocking. Recon findings it should confirm:
  - every action is pinned to a moving tag (`@v7`), not a commit SHA
  - no `actions/checkout` sets `persist-credentials: false`

  The org default token is already `read`, which is good.

  **First-run baseline (run 41888874562):**
  - zizmor found 58 *unpinned action reference* errors. The SHA pinning PR NBDPRO/nobigdealwithjoedeal.com#2833 fixes these.
  - zizmor also flagged 2 *overly broad permissions* warnings: `firebase-deploy.yml` has no `permissions:` block. The org default is `read`, so this is low risk, but the deploy workflow should still declare its own block.
  - actionlint reported only shellcheck info/style notes (SC2086 quoting, SC2001, SC2016) in `copycat-watch.yml` and `firebase-deploy.yml`. No syntax or expression errors.

## Follow-ups started the same day
- **CI hardening:** SHA pins, `persist-credentials: false`, and trufflehog + osv-scanner in report-only mode. PR NBDPRO/nobigdealwithjoedeal.com#2833.
- **Site:** `Speculation-Rules` header + view transitions, plus a weekly lychee job. In progress in its own session.
- **CRM calendar engine trial:** EventCalendar, draft PR NBDPRO/nobigdealwithjoedeal.com#2835 (`documentation/projects/CALENDAR-ENGINE-TRIAL-2026-11-04.md` on that branch).
  - It passed both the enforced and the stricter Report-Only `/pro` CSP with zero violations.
  - Recommendation: a read-only Month/Week/List Schedule panel. Keep `crew.js`.

## Adopt next, ranked

### CI and security (cheapest first)
1. **Pin actions to SHAs** with [pinact](https://github.com/suzuki-shunsuke/pinact) (v5.0.2). Dependabot's `github-actions` ecosystem keeps SHA pins updated. Add `persist-credentials: false` to checkouts that never push. S.
2. **[trufflehog](https://github.com/trufflesecurity/trufflehog)** with `--results=verified,unknown` (v3.99.8, AGPL; fine to run in CI). It checks Stripe, Twilio and Resend keys against the live services, which complements gitleaks. S.
3. **[osv-scanner](https://github.com/google/osv-scanner)** (v2.7.0, Apache-2.0) as a PR-diff scan over the root, `functions/` and `tests/` lockfiles, plus a license allowlist. S.
4. **[StrykerJS](https://github.com/stryker-mutator/stryker-js)** (v10.1.1), run nightly, not required. Point it at the estimate money math, the claim-wording gate and `check-vault-index`. A surviving mutant is a test that cannot fail, which is the "silently green gate" problem measured directly. M.
5. **[semgrep](https://github.com/semgrep/semgrep) CE with our own rules**, e.g. no `getDownloadURL` or `?token=` reaching `docs/` and no unescaped `innerHTML` sinks. Optionally [eslint-plugin-no-unsanitized](https://github.com/mozilla/eslint-plugin-no-unsanitized) scoped to `docs/**/*.js`. M.
6. **[harden-runner](https://github.com/step-security/harden-runner)** in `egress-policy: audit` on the deploy job (it holds the Firebase service account). S.
7. Weekly **[OpenSSF Scorecard](https://github.com/ossf/scorecard-action)** for drift. S.

No tool exists for: the emulator not enforcing indexes ([firebase-tools#2027](https://github.com/firebase/firebase-tools/issues/2027) is still open), Firestore rules linting, or CRLF. Keep our own gates. Stay on Dependabot rather than Renovate (Renovate is an AGPL App and a config migration).

### CRM (NBD Pro app)
1. **[EventCalendar (vkurko)](https://github.com/vkurko/calendar)** v5.18.1, MIT, about 35 KB, standalone build, CSS shipped as a separate file. It includes **free resource timeline views** for crew scheduling, so it's the engine to evaluate for the calendar hub plan. M. *Rejected:* FullCalendar (injects `<style>`, needs a nonce; resource views are paid) and Toast UI (archived).
2. **[SortableJS](https://github.com/SortableJS/Sortable)** 1.15.7: touch-friendly drag for the kanban, estimate line order and drag-to-schedule. HTML5 drag-and-drop is poor on iOS. S.
3. **[Fuse.js](https://github.com/krisk/Fuse)** 7.5.0: fuzzy lead/customer search and Call Center "who called" lookup. S.
4. **[Day.js](https://github.com/iamkun/dayjs)** with the timezone plugin, for ET job windows. The midnight-to-3am ET clock bugs came from raw `Date`. S, but it touches many files, so adopt it per screen.
5. **[libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js)**: E.164 normalisation (+1 format) in intake and Functions, so Twilio, Bland and `phone_calls.phoneDigits` agree. S.
6. **[browser-image-compression](https://github.com/Donaldcwl/browser-image-compression)**: shrink 4–12 MB iPhone photos before upload. Use `useWebWorker:false` or self-host the worker, because the default loads from jsDelivr and the CSP would block it. S.
7. Later: [idb](https://github.com/jakearchibald/idb) or Dexie for an offline field-photo queue, [Tabulator](https://github.com/olifolkerd/tabulator) for the money tables, [Konva](https://github.com/konvajs/konva) for photo markup, and the [cantoo pdf-lib fork](https://github.com/cantoo-scribe/pdf-lib) for stamping signatures onto PDFs. (Upstream pdf-lib, which `functions/` uses, has been quiet since 2024-07.)
8. **Roofing specific:** no credible open-source ESX parser or roof-measurement library exists. Google Solar API `buildingInsights` gives pitch and area per roof segment and could feed the inert measurement adapter. It costs per call, so it's **Jo's decision**.

*Rejected:* DocuSeal, Documenso and OpenSign (AGPL), marker.js (linkware/deprecated), heic2any, ninja-keys and notyf (abandoned).

### Homeowner site and NBD Pro marketing pages
1. **Speculation rules via the `Speculation-Rules` response header** (served from `firebase.json`, points at a JSON file, no inline script) plus `@view-transition { navigation: auto; }` CSS. This gives near-instant page loads with no new JS. **Check first:** prerendered pages must not double-count analytics or fire form/booking scripts. Exclude `/pro`, `/inspect` submit paths and Cal.com pages. S.
2. **[lychee](https://github.com/lycheeverse/lychee)** on a weekly cron for *outbound* links (GAF, TAMKO, Yelp, Cal.com, Google reviews). Our integrity check only covers internal links. S.
3. **[html-validate](https://gitlab.com/html-validate/html-validate)** in CI. It is pure Node, and its no-inline-handler and no-inline-style rules double as a CSP guard. S.
4. **sharp + `@11ty/eleventy-img`** (works without Eleventy) for an AVIF/WebP `srcset` image build. sharp strips EXIF unless `withMetadata()` is called, which fits `check-image-privacy`. M.
5. **[beasties](https://github.com/danielroe/beasties)** (the critters successor) for the homepage and blog critical CSS. **Its `media=print` onload swap is an inline handler**, which `script-src-attr 'none'` blocks, so use the no-preload mode. M.
6. **[schema-dts](https://github.com/google/schema-dts)** types (via JSDoc) on the JSON-LD build objects, to catch misspelled properties. S. (Google doesn't show review stars for self-served LocalBusiness reviews, so don't expect them.)
7. Analytics on the home server, if ever: **Umami** (MIT) or **GoatCounter** (single binary). Search Console remains the SEO source of truth.

### Local server (GTX 1080 Ti desktop)
**Hardware facts:** Pascal, compute 6.1. Ollama supports it (driver **570+**). **vLLM does not** (needs 7.0+). CUDA 13 dropped pre-Turing cards, so pin the driver and CUDA-12 builds and treat the card as a 2–3 year card. FP16 is slow on this card, so use int8/GGUF. 11 GB fits about one 7–8B model at Q4–Q6 plus Whisper; run heavy jobs one at a time overnight.

Phased build order:
1. **Weekend 1, foundation:**
   - NVIDIA driver 570+ (pinned)
   - WSL2 + Docker Desktop with a GPU smoke test
   - [Ollama](https://github.com/ollama/ollama) native, with nbd-agents moved off the laptop
   - [Tailscale](https://github.com/tailscale/tailscale) (no port forwards)
   - [Uptime Kuma](https://github.com/louislam/uptime-kuma) watching the site, `/api/mcp`, Ollama and an "agents ran today" push
   - [restic](https://github.com/restic/restic) or [Kopia](https://github.com/kopia/kopia) backups, with one test restore
2. **Calls:** [WhisperX](https://github.com/m-bain/whisperX) + pyannote **speaker labels** on the existing `phone_calls` audio (Jo vs. homeowner vs. adjuster). Output goes to a summary note in the Agent inbox. pyannote's model is gated on Hugging Face, so Jo creates that token.
3. **Receipts:** [paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) (GPL, fine internally) plus [paperless-gpt](https://github.com/icereed/paperless-gpt) on Ollama for vendor, date and total. Reconcile against the Home Depot Pro Xtra import before any write-back.
4. **Photos:** [Immich](https://github.com/immich-app/immich) (AGPL, fine self-hosted) on a separate disk, originals read-only, CLIP search. The public EXIF-stripped pipeline stays unchanged.
5. **Knowledge:** [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm) (MIT) or Open WebUI (branding clause; OK at 50 or fewer users) plus [Docling](https://github.com/docling-project/docling) over Drive exports. Add [n8n](https://github.com/n8n-io/n8n) (fair-code; internal use OK) only once there are three or more cross-system flows; start with small Node scripts.

The server is an enrichment layer: Firebase stays the system of record, and bots fall back to the capped Claude backup when the server is down. Keys live in an env file on the server, never in exported n8n flows.

### Bots and AI
1. **[MCP Inspector](https://github.com/modelcontextprotocol/inspector)** for contract tests per role key: each key sees only its tools, and forbidden calls are refused. Localhost only. S.
2. **[promptfoo](https://github.com/promptfoo/promptfoo)** (MIT) golden-set evals per bot (KY claim wording, TCPA, extraction accuracy) plus prompt-injection red-teaming of Tucker and Marcus, who read customer text. S.
3. **Docling + [instructor](https://github.com/567-labs/instructor)** (or Pydantic AI) to turn Xactimate **PDF** exports and receipts into validated line items in cents. ESX's format isn't public, so parse the PDF. Build a golden set of about 10 real scopes first. M.
4. **`qwen3-vl:4b`/`8b` on Ollama** for photo sorting and caption drafts. **Never as damage evidence**: no maintained hail-damage model exists, and the Roboflow sets are only 111–469 images. S.
5. Later: [Langfuse](https://github.com/langfuse/langfuse) self-hosted traces (MIT core, avoid `ee/`), and [garak](https://github.com/NVIDIA/garak) before any bot reads email or the web.

*Rejected:* llm-guard (archived), smolagents (executes code, which goes against draft-only), LangGraph (too heavy), Arize Phoenix (Elastic License).

## Second sweep, different angles (same day)

Jo asked for a second pass from a different angle, plus Grok's own research. It
ran three ways:
1. **Feature mining:** what the best open-source CRM, field-service and booking apps do that we don't (features, not libraries).
2. **Problem-first:** ten concrete NBD problems, the best repo, dataset or API for each.
3. **Grok** (grok.com, Expert mode): a fresh chat with no repo access and no private data in the prompt. Its answer is treated as leads.

Every claim below was checked against `origin/main` or GitHub before it went
in.

### The strongest new finding: radar hail-size swaths (MRMS MESH)
All three sources picked this independently.

**Today** the storm layers use point and track sources:
- IEM local storm reports (`mesonet.agron.iastate.edu/geojson/lsr`)
- NCEI SWDI `nx3hail` radar hail detections
- NWS alerts
- NEXRAD reflectivity tiles

**Missing:** NOAA MRMS **MESH** (Maximum Estimated Size of Hail), a continuous gridded hail-size field. `s3://noaa-mrms-pds/CONUS/MESH_Max_1440min_00.50/YYYYMMDD/` is public with no key, and its GRIB2 files are about 350 KB.

**Plan:** a nightly GitHub Action (Linux, GDAL), not a Cloud Function.
1. Fetch the 23:30Z daily max.
2. Clip it to the OH/KY service area.
3. Run `gdal_contour -p` at 0.75 / 1 / 1.5 / 2 in.
4. Commit or upload the GeoJSON for the existing Leaflet hail layer.

Effort M. **Caveat:** MESH underestimates hail in some storms. Overlay the storm-report points, never claim a size to a homeowner, and keep the Kentucky claim-wording rules.

### Already built (the sweep proposed them, `origin/main` has them)
| Proposed | What exists |
|---|---|
| Speed-to-lead clock | Speed-to-lead feature (PR #2575), merged **dark**, flag `speedToLead` off. Jo's flag to flip. |
| Merge duplicate leads | `docs/pro/js/dup-review.js` duplicate review screen |
| Invoice reminder ladder | `docs/pro/js/invoice-reminder.js` |
| Roof maintenance schedule | Roof Care Plan (`care-plan-crm.js`, `functions/care-plan*.js`) |
| No-show handling | `smart-calendar.js` flags past bookings with no outcome. Cal.com's own no-show webhook is unverified. |

### New feature ideas worth a build card (ranked)
1. **Cal.com routing form before booking.** Storm/insurance vs. retail vs. leak vs. gutters, each routing to the right event type and length. It's mostly Cal.com setup plus mapping in the existing webhook. Insurance wording must pass the KY claim gate. S.
2. **Completion worksheet with homeowner sign-off.** A checklist with required photo slots (ice and water, flashing, nailing), then the homeowner signs on the existing e-sign and a PDF is saved to the job. It's warranty evidence and the trigger for the review ask. M.
3. **Expiring photo-share links.** View-only or upload, with an expiry, so a homeowner can send leak photos or an adjuster can see a set. Never a Storage `?token=` URL; serve EXIF-stripped copies. M.
4. **Parcel lookup on a lead.**
   - Ohio has one statewide parcel FeatureServer (`gis.ohiodnr.gov/.../Statewide_Parcels_ODNR_WebMerc/FeatureServer`, checked: it responds, max 2,000 records per query).
   - Boone County has its own REST server; Kenton and Campbell go through LINK-GIS, which may charge for bulk data.
   - Read-only, through a Cloud Function proxy so the CSP stays tight. M.
5. **Saved replies with `/shortcode`** in the Call Center and Agent-inbox drafts. Insert only, never send. S.
6. **Job timer with pause** for Jo's own hours per job, so margin includes the owner's time. Cost data stays out of `docs/`. S–M.
7. **Offline photo queue on iPhone.** Firestore's offline cache covers documents but **not** Storage uploads. Queue the blob in IndexedDB (Dexie) and retry on `online`, `visibilitychange` and launch. iOS gives no background upload once the app is closed. M.

### Data and tools worth knowing (lower priority)
- **Lead de-dup at NBD volume:** block on the exact E.164 phone or normalized address, then fuzzy-match names in Node with [talisman](https://github.com/Yomguithereal/talisman) (MIT). [Splink](https://github.com/moj-analytical-services/splink) (MIT, v5.0.0 2026-09-18) only if volume grows; it's Python.
- **Footprints:** [Overture Maps buildings](https://github.com/OvertureMaps/overturemaps-py) (MIT). Microsoft USBuildingFootprints is archived. Neither has year built.
- **Roof pitch from LiDAR:** KyFromAbove (KY statewide, STAC on S3) and USGS 3DEP + [PDAL](https://github.com/PDAL/PDAL) for Ohio. [3DBAG/roofer](https://github.com/3DBAG/roofer) (GPL-3, run as a separate tool) fits roof planes. Effort L; a research spike, not a build.
- **Call → CRM fields:** NuExtract 2.0 (2B/4B, MIT) or GLiNER as a cheap first pass. No public eval set exists, so label 30–50 of our own transcripts and score them with promptfoo.
- **Dead code:** `c8` on node tests, plus Playwright V8 coverage merged with monocart. Don't use knip on `docs/`: `window.X` globals make everything look unused.
- **Google reviews:** the official v4 reviews API (list + reply) can draft replies into the Agent inbox once the GBP API case is approved.
- **Weather:** keep weather.gov. Its gridpoints endpoint has hourly rain chance and gusts for rain-day warnings. **Open-Meteo's free tier bans commercial use.**

### Rejected in the second pass
- MRMS-browser (1 star, no license)
- node-spc-storm-reports (2017)
- recordlinkage (stale)
- Pelias / self-hosted Nominatim (overkill)
- Cincinnati permits data for roof age: 0 permits mention "roof", so re-roofs don't show up
- MapLibre GL: it's real and active, but we already run Leaflet everywhere

Grok also named the site "qdeal.com". That's a hallucination, and a reminder that its lists are leads, not facts.

## Decisions for Jo
- Google Solar API for roof measurements (costs per call).
- Whether the local server ever hosts anything public (a webhook receiver would need Cloudflare Tunnel; the default is Tailscale-only).
- The Hugging Face token for pyannote speaker labels, if Phase 2 goes ahead.
