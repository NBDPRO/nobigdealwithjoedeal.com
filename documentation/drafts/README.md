# Blog drafts awaiting Jo's review — 2026-07 (status updated 2026-08-17)

Three complete drafts were written from the outlines in
`documentation/qa/seo-hardening-2026-07/BLOG-OUTLINES-FOR-JO.md`. They live
here — **not** in `docs/` — on purpose: nothing in this folder deploys.

**2026-08-17 update:** the financing post is **PUBLISHED** (PR #1224 — its two
optional markers were resolved per their own instructions, merge = approval
under the convention Jo set for the Reader Questions posts). The two remaining
drafts are genuinely blocked on Jo-only inputs — the published Featured
Projects gallery was checked and covers only the chalk-square figure:

| File | Target URL (after publish) | Needs from Jo (~10 min each) |
|---|---|---|
| `what-hail-damage-looks-like-cincinnati.html` | `/blog/what-hail-damage-looks-like-cincinnati` | **3 photos** from his inspection archive: (1) close-up hail bruise on a shingle, (2) granules collecting in a gutter/downspout, (3) dents on soft metal (gutter lip, AC fins, or window capping). The chalk-square figure can be filled from the published gallery (`damage-chalk-marked.jpg`). Photos must go through the EXIF-strip pipeline before use. Plus: real storm anecdote (date, town, what he found) or approve de-specifying it. |
| `what-a-real-roof-inspection-report-looks-like.html` | `/blog/what-a-real-roof-inspection-report-looks-like` | 3 redacted report screenshots (cover, photo page, measurements page) + confirm section names/order, cover-page fields, and condition-rating codes |
| `color-matching-paint-why-it-takes-so-long.html` (new 2026-10-22) | `/blog/color-matching-paint-why-it-takes-so-long` | Jo's own lines for "What I Do While I Wait" (the one `[JO:]` fill), and a read of the five tips (one `JO:` comment). Written from his words: ten minutes for a good match, thirty to forty-five for a bad one, take a sample however small. No store named. |
| ~~`roof-financing-cincinnati-explained.html`~~ | `/blog/roof-financing-cincinnati-explained` | ✅ **Published 2026-08-17** (PR #1224) |

## How Jo reviews these

1. **Open the file in a browser.** Double-click it, or run a local server from
   the repo (`npx serve docs` won't show these — just open the file directly).
   Nav/footer/CSS links point at `/assets/...`, so styling is only fully
   correct when previewed against the live site or a local `docs/` server;
   the *text* reads fine either way.
2. **Search the file for `JO:`** (case-sensitive). Every one is a decision:
   - `<!-- JO: photo of X here -->` + orange dashed placeholder box → replace
     the whole `.ph-block` div with a real `<figure><img src="/assets/images/blog/..." alt="..."><figcaption>...</figcaption></figure>`.
     Redact customer names/addresses on report screenshots.
   - Yellow highlighted `[JO: ...]` spans (`.jo-fill`) → visible fill-in-the-blank
     text. Replace with the real detail and delete the `<span class="jo-fill">` wrapper.
   - `<!-- JO: confirm ... -->` → read the nearby paragraph and confirm it's
     true (dates, report section names, payment-mix numbers). Fix or delete.
3. **Voice check.** Everything is written first-person as Joe. Edit anything
   that doesn't sound like him — these are drafts, not gospel.
4. **Hard rules already enforced** (keep them enforced while editing):
   - Only real phone number: (859) 420-7382.
   - No invented statistics, prices, interest rates, lender names, or warranty
     claims. The financing post states **zero** dollar figures/rates beyond the
     "$3,000+" threshold already published on `/services/financing`.
   - Every financing fact traces to `docs/services/financing.html` (Acorn Finance
     lending marketplace, soft pull first, no home equity, deductible financing).
5. When a post is approved, tell the next Claude session "publish
   `<filename>`" and point it at this README.

## Publish steps (for a future session — one post at a time)

1. **Final content check**: confirm zero remaining `JO:` markers and no
   `.ph-block` / `.jo-fill` elements left in the file. Remove the
   `<!-- DRAFT — NOT PUBLISHED -->` banner comment at the top of the file and
   the "DRAFT-ONLY" CSS comment lines. Update the publish date in **four**
   places: `article:published_time` meta, `datePublished`/`dateModified` in the
   BlogPosting JSON-LD, and the visible date in the `.article-meta` block.
2. **Move the file** to `docs/blog/<same-filename>` (`git mv` from
   `documentation/drafts/`). The slug/filename must not change — canonical,
   og:url, and breadcrumb JSON-LD already point at
   `https://nobigdealwithjoedeal.com/blog/<slug>`.
3. **Add to the blog index.** The index at `docs/blog/index.html` renders its
   grid from the `POSTS` array in `docs/assets/js/inline/c00f1acac9.js`
   (`@generated` header, but it *is* the publish schedule — the array is the
   editing surface; follow the instructions in its header comment). Add an
   object at the top of the array:
   ```js
   {
     url: "/blog/what-hail-damage-looks-like-cincinnati",
     tag: "Hail Damage",
     title: "What Hail Actually Does to a Roof (Photos From My Inspections)",
     meta: "By Joe Deal · July 2026 · 7 min read",
     excerpt: "One or two sentences pulled from the post's lede.",
     published: "2026-07-XX",   // article goes live on the index at midnight this date
   },
   ```
4. **Sitemap.** `scripts/build-sitemap.js` auto-discovers `docs/blog/*.html`,
   so no curated-list edit is needed for a normal post (curated pinning in
   `PREMIUM_BLOG_POSTS` is only for the premium-components series). Run:
   ```
   node scripts/build-sitemap.js          # dry-run: verify the ONLY new URL is this post
   node scripts/build-sitemap.js --write  # then write
   ```
   The new URL gets `priority 0.6` in the main blog section and today's
   lastmod; existing URLs keep theirs.
5. **Interlink from location pages.** The `/areas/` location pages carry
   internal-link "guide blocks" (this was the point of the hail post —
   the 30-page hail cluster links to insurance guides but nothing visual).
   Add the new post's link to the relevant guide blocks:
   - hail post → hail-cluster location pages and `/services/hail-damage-insurance-claim`
   - inspection-report post → `/inspect` and `/services/roof-inspection` funnels
   - financing post → `/services/financing` and `/estimate` funnels
   Grep for an existing blog link (e.g. `how-to-file-storm-damage-insurance-claim-ohio`)
   inside `docs/areas/` to find the guide-block markup pattern, and follow it.
6. **Cross-link from sibling posts** (optional but recommended): add the new
   post to the "Keep Reading" grids of the 2–3 most related existing posts.
7. **Verify before deploy**: extract and `JSON.parse` every
   `<script type="application/ld+json">` block; check title ≤62 chars and
   meta description ≤155; click every internal link against `docs/`.
8. Commit only when Jo has approved, and never mix multiple post publishes
   into one commit.

## What was verified at draft time (2026-07-03)

- All JSON-LD blocks (BlogPosting, BreadcrumbList, FAQPage) parse as valid JSON.
- Titles ≤62 chars, meta descriptions ≤155 chars.
- Internal links target existing pages: `/storm-check`, `/estimate`, `/inspect`,
  `/services/financing`, `/services/roof-inspection`, `/services/roof-cleaning-soft-wash`,
  and existing posts in `docs/blog/`.
- Only phone number present: (859) 420-7382.
- Word counts in the ~1,200–1,800 target range (article body text).
