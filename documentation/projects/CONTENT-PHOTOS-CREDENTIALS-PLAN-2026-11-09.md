# Plan 2026-11-09: job photos into the CRM, a content and blog schedule, and credentials

Planned after the 11-09 build day. Recon was read-only, on the integrated NBD OS P3 branch. Jo's answers are recorded at the end of this note. Nothing here is built yet.

## 1. Job photos from iCloud / Google Photos into the CRM

**What exists to reuse**
- Street matching: `addrKey()` and `addrKeysInFilename()` in `scripts/audit-imported-docs-placement.js`, and `parseStreetName()` in `docs/pro/js/d2d-tracker-core-2026b.js`.
- Photo date and GPS: `docs/pro/js/photo-smart-ingest.js` reads them with the vendored `exifr`, which also handles HEIC.
- Script conventions: `scripts/import-drive-docs-to-crm.js` and `scripts/prod-switches.js` (dry run by default, token mode through `scripts/_firestore-rest.js`).
- The photo record shape: `/photos/{id}` as `docs/pro/js/photo-engine.js` writes it. Files go under `photos/{uid}/{leadId}/…`, and `functions/image-pipeline.js` makes the variants.
- Job dates: the lead's `stageHistory` (`install_complete`), with the fallbacks used by `functions/social-studio.js`.

**What is missing**
- Nothing reads iCloud or Google Photos. iCloud has no server API, and the Google Photos API only reads photos the app uploaded itself.
- There is no CRM job folder: photos belong to a lead (`leadId`, set once), not to a job.
- The address is one free-text string.
- A normal move to install-complete does not set a completion date.
- Two of the three upload paths do not read photo date or GPS.

**Steps (Jo chose: run on his computer, all 2026 NBD jobs)**
1. **`scripts/match-job-photos.js`.** It reads a local folder (the iCloud Photos / Google Photos sync folders, or an export) and runs dry by default. Each photo is scored against each 2026 lead by:
   - the street key from the lead's address,
   - its date against the lead's stage dates, giving a before / during / after window,
   - its GPS distance from the lead's `lat`/`lng` when both exist.

   Output is a review sheet (CSV plus a local HTML contact sheet) that stays on Jo's computer.
2. **Jo reviews and approves.** `--apply` then uploads each approved photo to `photos/{uid}/{leadId}/…` and writes the `/photos` row in the `photo-engine.js` shape, with `source: 'photo-match'`, `capturedAt` from EXIF and `phase` from the date window. It needs Jo's OK for each run (CLAUDE.md rule f).
3. **Close the gaps so this stays easier:**
   - `stage-write.js` records the install-complete date.
   - Every upload path reads EXIF date and GPS into `capturedAt` / `geoLocation`.

**Risks**
- Street names repeat across towns, and personal photos can match a customer. The matcher never files a photo on the street key alone, and every photo goes through Jo's review.

## 2. Content schedule from jobs, and blogs

**What exists to reuse**
- Project pages: `docs/assets/data/projects.json`, `scripts/build-projects.mjs` and `scripts/prepare-project-images.mjs`, following `documentation/runbooks/PUBLISH-PROJECT.md`. There are 48 jobs (25 NBD); none has been added since 2026-09-21, and none uses the case-study fields.
- Social Studio: `functions/social-studio.js` and `functions/social-logic.js`.
  - Its weekly slots are Tuesday showcase, Thursday tip and Saturday review.
  - `socialApprovePost` is the only approval path, and `socialPublisher` runs every 5 minutes.
  - Meta auto-publish needs its secrets and the switch on; whether that is on in production is unknown from the repo.
- Blog: the `POSTS` array in `docs/assets/js/inline/c00f1acac9.js`, plus `scripts/rebuild-blog-index.js`, `build-blog-index.mjs` and `build-feed.mjs`. The last post was 2026-11-04, and nothing is queued.

**Steps (Jo chose: he confirms consent per job)**
1. **A consent tick on the job that only Jo can set.** It is a CRM field; only an owner or admin can write it. It is the only way a job can become a project page, and maps to `consentOnFile: true`.
2. **"Draft project page" from a consented job.**
   - It opens a PR with the `projects.json` entry: town only, rounded retail price range, the case-study fields filled from the job, fresh alt text never copied from CRM captions, and EXIF-stripped copies made by `prepare-project-images.mjs`.
   - Joint or subcontracted jobs still go to Jo first (runbook hard rule 3).
3. **Social:**
   - New consented jobs feed Social Studio's weekly plan.
   - Add a "new blog post" social post type.
   - Check Meta auto-publish in production with Jo.
   **Built 2026-11-09 (steps 1-2):** the owner-only consent tick `leads/{id}.projectConsent` (rules plus a lazy "Project Page" control on the customer page) and `scripts/draft-project-page.mjs` (dry run by default; `--write` appends to the local projects.json only, and the CRM shows the command instead of opening a PR). See [SESSION-2026-11-09-project-consent-draft](SESSION-2026-11-09-project-consent-draft.md).
4. **Blog:** a 12-week calendar, one post every Tuesday, never backdated (`tests/blog-dates-not-backdated-2026-11-04.test.js`).
   - The mix: job case studies, seasonal posts (ice dams, spring storm season), and reader questions.
   - Each post is drafted as a PR with a future `published` date.
5. **Infrastructure the schedule needs:**
   - A weekly scheduled deploy, so future-dated posts and projects reach the static index and the feed on their date. Today the deploy runs on push only.
   - Make the `docs/llms.txt` blog list generated; it is hand-kept and already one post behind.
   - Enforce Tuesday and one post per week in the dates test for new posts.

## 3. Credentials and certifications

**What exists**
- `docs/assets/data/credentials.json` feeds `scripts/build-credentials.mjs`, which writes `/credentials`, the homepage and `/about` strips, and the JSON-LD. The procedure is `documentation/runbooks/ADD-A-CREDENTIAL.md`.
- Active: GAF Certified #1162011, TAMKO Pro Gold #181382, Fully insured, James Hardie Alliance, American Operator.
- Pending: IKO.
- The CRM's private store for certificates is `companies/{cid}/companyDocs` (`gl_coi`, `workers_comp`, `license`, `manufacturer_cert`).

**Fix now (no decision needed)**
1. `functions/agent-mcp-logic.js` gives the AI "IKO ROOFPRO Advantage" while the site holds IKO as pending. Align it with `credentials.json`.
2. `docs/llms.txt` line 22 disagrees with the data file. Generate it from `credentials.json`.
3. Add James Hardie to the footer disclaimer, which `/credentials` already names.
4. Replace the generic verify links (TAMKO's locator, American Operator's homepage) with profile links where the issuer has them.

**Jo chose to pursue** (each is added only once held and confirmed with the issuer)
- **Insurance:**
  - Name the carrier on `/credentials`.
  - Add a "Request our certificate of insurance" option.
  - Keep the certificate (COI) in `companyDocs` with an expiry reminder.
- **Haag Certified Inspector:** fits storm and insurance-claim work.
- **BBB accreditation.**
- **OSHA 10/30** for Jo and the crews.

**Built 2026-11-09 (Fix now, items 1-4):** see [SESSION-2026-11-09-credentials-fix-now](SESSION-2026-11-09-credentials-fix-now.md). Items 1-3 are done and pinned by `tests/credentials-surfaces-2026-11-09.test.js`. Item 4 was left as is, because no NBD-specific TAMKO or American Operator profile URL is recorded anywhere.

Each new credential goes through `ADD-A-CREDENTIAL.md`, then the site strip and schema. Manufacturer and inspector certifications also get a CRM document badge (`company-profile.js` / `nbd-badge-assets.js`), with NBD's documents changing only by the added badge.

## Jo's answers (2026-11-09)

| Question | Answer |
|---|---|
| Photo source | Run on his own computer (Claude Desktop or `claude remote-control`) |
| Sweep range | All 2026 NBD jobs |
| Consent | Jo confirms each job himself |
| Credentials to plan | Insurance carrier + COI on request, Haag Certified Inspector, BBB accreditation, OSHA 10/30 |

## Order

1. The credentials fix-now items, the install-complete date, EXIF on every upload path, the scheduled deploy, and the generated llms blog list. These need nothing from Jo.
2. The consent tick and "Draft project page".
3. The photo matcher, which Jo runs on his computer.
4. The 12-week blog calendar and the Social Studio feed.
5. Each new credential as Jo obtains it.

## Built (2026-11-09): §2 step 5, the weekly scheduled deploy

Branch `sched-deploy`. A weekly Tuesday run (09:17 UTC) of `.github/workflows/firebase-deploy.yml` deploys
hosting only when a post or project date passed since the last hosting deploy, never commits, and refuses to run
when the live site is behind `main` on a deploy path. The `docs/llms.txt` blog list is now the generated
`LLMS:BLOG` region, and posts dated from 2026-11-10 must fall on a Tuesday, one per ISO week. Details and the
review round: [SCHEDULED-DEPLOY-AND-BLOG-CADENCE-2026-11-09](SCHEDULED-DEPLOY-AND-BLOG-CADENCE-2026-11-09.md).
Runbook: [BLOG-SCHEDULE](../runbooks/BLOG-SCHEDULE.md).
