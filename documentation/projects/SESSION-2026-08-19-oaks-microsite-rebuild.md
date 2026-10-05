# Session 2026-08-19 — Oaks Roofing & Construction microsite, rebuilt as a hand-off deliverable

**Ask (Jo):** "oaks roofing and construction microsite full build out — I want to make it
ready and fully built so I can ship it over to him whenever he's ready to host it — I have
his whole site in this folder from what it used to look like, I want to almost mirror it
identically."

**Source material:** ten print-to-PDF captures of the retired
oaksroofingandconstruction.com, in `G:\My Drive\COMPANIES\ORC\ORC SITE\`.

**Outcome:** an 11-page, self-contained, portable static site at `docs/sites/oaks/`,
rebuilt from the archived pages — real copy, real photography, real logo. All gates green.

> **Update 2026-10-04 — the form-destination notes in §7 item 1 are superseded.** The quote
> form now posts through our own lead intake (`submitPublicLead`, via
> `/assets/js/public-lead-submit.js`) tagged `siteKey: 'oaks'`, so leads land in the Oaks
> company's CRM (companies/oaks) and the alert follows `companyProfile/oaks`'s alert
> routing. Turnstile + honeypot + rate limit as on NBD's forms. The `formEmail` mail-app
> route is now only the fallback when the intake fails; the FormSubmit relay option was
> removed from `site.js` and the README, and `privacy.html`'s "Third parties" section was
> rewritten to match. Guards: `tests/oaks-own-intake-2026-10-04.test.js` and
> `tests/e2e/phone-oaks-intake.spec.js`.

---

## 1. The two decisions Jo made up front

| Question | Decision |
|---|---|
| Where does it live? | `docs/sites/oaks/`, **kept portable** — relative paths throughout so the same folder serves from `/sites/oaks` here AND from the domain root on Scott's own host. Stays `noindex` until he launches. |
| What does the quote form do? | **Static-host-safe, no backend.** It validates, then tells the visitor to call. A clearly-marked config block at the top of `assets/js/site.js` turns on either a POST endpoint or a `mailto:` fallback in one edit. It never pretends to have sent something. |

## 2. What was recovered, and how

The live site is **gone** — `oaksroofingandconstruction.com` is a Squarespace *"Coming
Soon"* parking page as of today. The PDFs are the only record. Two recovery lanes:

**Copy** — `pdftotext -layout` over all ten PDFs → `orc-txt/*.txt`. Print capture
interleaves columns, so reading order is scrambled but the sentences are intact. Every
heading, paragraph and CTA label on the rebuilt site comes from these files.

**Assets** — no `pdftoppm`/`pdfimages` in this environment and the PDF-Tools MCP is
sandboxed to `Documents/Downloads/Desktop` *and* has no page renderer. So: a hand-written
Node extractor walking the PDF object table for `/Subtype /Image` XObjects, inflating
`/FlateDecode` streams and re-wrapping the samples as PNG, plus a second pass that
resolves each image's `/SMask` and composites it into true RGBA.

That produced **82 unique images**, including:
- the **real ORC logo** (900×366, orange wordmark + white tagline, transparent) — the
  repo's `logo-orange.svg` is a hand-drawn approximation in `#e8720c`; the real brand
  orange sampled from the artwork is **`#fa6404`**;
- the **service-area map** with all 15 city pins and the dashed coverage boundary;
- ~19 genuine job photos (drone tear-offs, crews on underlayment, Owens Corning Oakridge
  and Atlas Pinnacle Pristine packaging, finished roofs, siding walls).

`sharp` (from `functions/node_modules`) resized these into **60 files / 6.8 MB** of
WebP + JPEG pairs under `docs/sites/oaks/assets/img/`.

> **Reusable:** the extractor and the compositor are in the session scratchpad pattern —
> if another client hands over PDFs instead of a site, this is a ~30-minute recovery.

## 3. What shipped

```
docs/sites/oaks/
  index.html  about.html  service-areas.html  gallery.html  contact.html  privacy.html
  services/{roof-replacement,roof-repair,siding-replacement,siding-repair,gutter-replacement}.html
  assets/css/site.css      one stylesheet, no NBD dependency, no icon font (icons are inline SVG)
  assets/js/site.js        one script, no dependencies, no inline handlers
  assets/img/              60 files
  logo-orange.svg          UNCHANGED — companyProfile/oaks brand.logoUrl points here
  README.md                hand-off instructions for Scott (docs/ ignores **/*.md, so it never serves)
```

Design system is the company's own, in an `orc-*` class namespace so nothing collides with
NBD CSS: `#fa6404` orange, `#16181b` ink, Montserrat + Open Sans.

## 4. Three things that were genuinely wrong, and what fixed them

### 4a. The relative-path / `cleanUrls` trap — a real production bug, caught by a gate

`check-site-integrity.js` failed the homepage with 60+ dead refs. It was **right**.

With `cleanUrls: true` + `trailingSlash: false`, a directory index is served at its
**slash-less** URL: `docs/sites/oaks/index.html` → `/sites/oaks`. The browser then resolves
that page's relative links against `/sites/` — one segment too shallow — so `about.html`
became `/sites/about.html` and every asset 404'd. **Subpages are unaffected**
(`/sites/oaks/about` keeps the `/sites/oaks/` base), so only the directory index breaks.
This is the same defect class as the `/admin` relative-src bug recorded in that checker's
own header comment.

Fix: a 301 `/sites/oaks → /sites/oaks/index`, which restores the correct base without
making the folder non-portable.

The checker then still failed, because it models a page's base as `cleanUrlOf(file)` and
knew nothing about the redirect. That is a **general gap**, not an Oaks quirk: redirects
outrank static files in Hosting priority, so any page whose clean URL is a redirect
`source` never serves there, and checking its relative refs against that URL is checking
against a URL that returns a 301. Added `servedUrlOf()` to
`scripts/check-site-integrity.js` — it follows a matching redirect and uses the
destination as the base. No other page's result changed (213 pages, still 0 failures
elsewhere).

> **Do not "simplify" this away.** Deleting `servedUrlOf()` silently reintroduces a
> 60-broken-link homepage that the gate will report as clean.

### 4b. An invented service promise — caught by the fidelity pass

I wrote "Call **or text** (513) 827-5297" into the shared form block, and it propagated to
four pages plus three JS messages plus the privacy policy. **No source page anywhere says
the line accepts SMS.** For a contractor's published contact route that is a real claim,
not a copy nit. Removed everywhere; the wording is now just "Call".

### 4c. Heading-level jump on the contact page

`contact.html` went `h1` → `h3` (the three contact cards had no section heading above
them), so screen-reader heading navigation skipped a level on the site's primary contact
page. Added a `Reach Us Directly` `h2`, matching how `service-areas.html` already did it.

## 4d. The tenant placeholder, retired (Jo, 2026-08-19)

Jo's follow-up: *"I want the microsite to hold the full site clone we just built. We can
remove the old placeholder."*

**`/sites/t/oaks` was never dark.** `companies/oaks` already carried `status:'active'` in
prod and the URL answered 200 — the publication gate in
`functions/handlers/public-site.js` was already satisfied. Only the `X-Robots-Tag` noindex
held it back. What was actually live was the universal tenant template rendering a
**one-page, 96-word, 5-link stub**: emoji service icons (🏠🧱🌧️) because
`services` was `[]`, an **empty "Where we work"** section because `serviceArea` was `""`,
accent `#C2410C` instead of the real `#fa6404`, and no photography at all.

`/sites/t/oaks` now **301s to `/sites/oaks`**, and the stub no longer renders for this
tenant.

> **Done as a redirect, NOT by moving the 11 pages under `/sites/t/oaks`.** `/sites/t/` is
> the *universal* multi-tenant template — one template, N tenants, rendered from Firestore.
> Dropping per-tenant hand-authored files into it would fork that design at its first real
> use and re-create precisely what the 2026-07-04 Pillar 5 decision retired. `/sites/oaks`
> is already the correct home for a single-tenant hand-authored site.
> `companies/oaks` **keeps `status:'active'`** — that flag also drives tenant tagging, and
> the redirect fires ahead of the `/sites/t/**` rewrite, so the template is simply never
> reached for oaks. No prod write was needed.

Two things this surfaced that had gone unnoticed:

- **`scripts/verify-deploy.sh` was still asserting the 2026-07-04 arrangement** — that
  `/sites/oaks/` 301s *to* `/sites/t/oaks`. Those 301s were deleted earlier in this same
  session, so the first post-deploy verification after the rebuild would have failed on a
  stale assertion. Rewritten for the new direction, plus a new assertion that
  `/sites/oaks` still 301s to `/sites/oaks/index` — if that ever stops, every link and
  asset on the Oaks homepage silently 404s (§4a).
- **`docs/robots.txt` carries `Disallow: /sites/oaks/`**, which stops crawlers *fetching*
  the pages at all — so the `noindex` on them could never be seen. Harmless while
  unlaunched (both hide it), but it means **three things must drop together at launch**:
  the `X-Robots-Tag` rules, the `<meta name=robots>` in all 11 pages, and the robots.txt
  Disallow. Any one alone does nothing. This is the same failure mode the `/pro/blog` and
  `/tools` comments in `firebase.json` already record.

## 4e. Adversarial verification over live production — and what it found

After the site was live, a six-lens adversarial pass (routing, rendering, content
fidelity, SEO/privacy, a11y/CSP, portability) plus a coverage critic ran against
**production**, not against the repo. **0 blockers, 9 major, 9 minor.** Own checks had
already passed cleanly on a site that was in an infinite redirect loop, which is exactly
why this pass existed.

The findings worth remembering:

1. **A THIRD instance of the relative-path trap, live.** `/sites/oaks/home/` (trailing
   slash) answered 200 with the full homepage while every relative asset resolved one
   directory too deep and 404'd. `trailingSlash:false` strips the slash off a *real file*
   — but the homepage is served by a **rewrite**, and a rewrite source matches the slashed
   form *and* bypasses that normalisation. See [[cleanurls-directory-index-relative-paths]];
   all three variants are now recorded there.
2. **A fabricated rating claim.** The JSON-LD carried `aggregateRating reviewCount:13`.
   The archive says "Over 13 Happy **Customers**" — a customer count, not reviews — and the
   page shows exactly one review. `noindex` masked it, and §7's launch checklist removes
   `noindex`. Removed. *Written by me, in the same session in which I stripped an invented
   SMS claim from an agent's work; the check has to point inward too.*
3. **PII in the URL.** The quote form declared no `method`, so with JS unavailable it GETs
   and serialises name, email, phone, ZIP and message into the query string — into server
   logs, history and `Referer`. Now `method="post"` with an honest `<noscript>`.
4. **Contrast.** White on the brand orange was 3.05:1 on every CTA; the current-item marker
   in the service sidebar was 2.66:1. Dark ink on the *same* orange is 5.84:1, so Scott's
   colour is kept and only the text changed (Jo confirmed: "make it the right orange").
   `--orange-ink #b84a02` added for orange-as-text on light. Hover now BRIGHTENS — with
   dark text a darker hover *lowers* contrast.
5. **The lightbox** claimed `aria-modal` without inert, so Tab reached content behind an
   opaque overlay.
6. **Reflow at 320px** (WCAG 1.4.10) — the gallery's fixed 300px track overflowed below ~344px.
7. **The footer logo was stretched 2×** — 264×54 against a natural 900×366.
   `.orc-footer-brand` is a column flexbox, and `align-items:stretch` overrode the img's
   `width:auto`. **Spotted by Jo by eye.** An earlier probe of mine had printed
   `boxW 264 boxH 54` and never divided the two — instrumentation is not observation.
8. A mistyped `/sites/oaks/` url rendered the **NBD-branded 404**, the only cross-brand
   surface in the client's url space. Now an Oaks 404 via a `/sites/oaks/**` rewrite.
9. `/api/site-config` carried no `X-Robots-Tag` — a tenant-branded surface outside every
   protection applied to the pages it feeds. Fixed for all tenants.

> **Measuring contrast: composite the alpha.** A naive reader treats
> `rgba(250,100,4,.12)` as solid orange and reports both false failures (a passing 4.55:1
> as 1.71:1) and false passes. Resolve the stack to an opaque base first.

## 4f. Standing rule earned the hard way

**Never validate Firebase URL semantics by reasoning — deploy to a preview channel.**

```
npx firebase-tools hosting:channel:deploy <name> --project nobigdeal-pro --expires 1d
curl -sIL --max-redirs 5 <channel-url>/<path>          # FOLLOW, do not just read headers
npx firebase-tools hosting:channel:delete <name> --project nobigdeal-pro --force
```

Nothing local reproduces it: `npx http-server` normalises a directory URL the *opposite*
way, `firebase serve` ignores redirects, and `check-site-integrity.js` models redirects
rather than following them. Header checks pass on a looping site because headers only ever
show **one hop**. `scripts/verify-deploy.sh` now follows redirects and asserts a 200, and
covers the trailing-slash form and the Oaks 404.

## 4g. Three more regressions found AFTER it went live — two by Jo, by eye

Everything above was written while the site was believed correct. It then shipped, and
three further defects surfaced. All are fixed and live; recorded here because the pattern
matters more than the individual bugs.

1. **`/sites/oaks/home/` (trailing slash) served an asset-less page.** The THIRD instance
   of the `cleanUrls` trap — `trailingSlash:false` strips the slash off a real file, but
   the homepage is served by a **rewrite**, and a rewrite source matches the slashed form
   *and* bypasses that normalisation. Fixed with a `301 /sites/oaks/home/ → /sites/oaks/home`.
   All three variants are in [[cleanurls-directory-index-relative-paths]].
2. **The header controls bunched left below 1040px** (161px dead space at 390px, 386px at
   768px). `margin-left:auto` lived on `.orc-nav`, which is `display:none` at that
   breakpoint, so nothing claimed the slack. Moved to `.orc-header-cta`. **Reported by Jo
   from a phone screenshot.** With the space reclaimed the phone *number* now stays visible
   on phones instead of collapsing to a bare icon.
3. **The gallery lightbox controls were dead** — my own regression from the `aria-modal`
   fix in 4e. `setBackground` inerted every direct child of `<body>` filtering on
   `el !== box`, which is only correct if the dialog IS a body child. It sat inside
   `<main>`, so `<main>` went inert and took Close/Prev/Next with it; only Escape worked.
   Dialog moved to body level AND the filter changed to `!el.contains(box)`.
   **Reported by Jo.**

> ### The real lesson: three false greens in my own tooling
>
> Each of these was *already visible* in output I had generated and not read properly:
>
> | tooling | what it claimed | what was true |
> |---|---|---|
> | contrast harness | "all measured pairs pass" | every selector was `NOT FOUND` |
> | screenshot probe | 2 images broken | probe ran after `fullPage` reset lazy state |
> | lightbox test | "background made inert" ✓ | `<main>` inert, every button dead |
> | header probe | printed `boxW 264 boxH 54` | ratio 4.886 vs natural 2.459 — never divided |
>
> The common fault is **asserting a precondition instead of an outcome.** "The background
> is inert" is not "the buttons work". "The selector matched" is not "the contrast passes".
> Every one of these tests now performs the user's action — clicks next, clicks close,
> follows the redirect — and fails when the outcome is wrong. Each new assertion was
> verified to FAIL against the broken build before being trusted.

## 5. Deliberate deviations from the original (all recorded)

- **Gallery has 9 photos, the original was paginated (1 2 3 4).** Nine is all the archived
  PDFs contain. Rendered as one grid with a keyboard-navigable lightbox rather than faking
  pagination over a short set.
- **Section eyebrows** ("What We Do", "Get Started", …) are added design furniture, not
  source copy. They carry no claims.
- **Zip placeholder is `45122`** (Goshen) where the original said `12345`.
- **`privacy.html` has no source page** — the archived footer linked to one we do not
  have. Written fresh and **verified against the actual build**: no analytics, no ad
  pixels, no cookies; one `sessionStorage` flag for the dismissed banner; Google Fonts is
  the only third-party request, and the policy discloses it. Still flagged for Scott's
  review in the README before launch.
- ~~**`logo-orange.svg` left alone**~~ — **DONE later the same day** (§7 item 2): rebuilt
  against the real artwork. Path unchanged, so generated documents picked it up.

## 6. Verification

- Gates: site-integrity **223 pages / 0 failures**; chrome-governance clean (11 Oaks pages
  added to `EXEMPT` — client brand, own namespace, portable by design); js-syntax 467 clean;
  inline-html-scripts 0; image-privacy 144 scanned / 0 failures; `apply-partials --check` clean.
- **`qc-render-sweep` (the CI-only rendered gate added 2026-08-18): 229 pages at 1280px and
  390px, 0 findings.** This one is not in CLAUDE.md's pre-push list and was nearly missed —
  it is the only gate that can compute a style, and it checks exactly what these pages are
  full of: oversized inline SVG, icon ink matching its own chip background, dropdowns open
  at rest, horizontal overflow, duplicated `<style>` blocks. All 11 Oaks pages are in its
  scope (`sites/` is not in its `SKIP_DIRS`) — verified by replicating its walk, not assumed
  from the clean result. Run it for any new page-heavy surface:
  `npx http-server docs -p 5000 -c-1 --silent &` then
  `node scripts/qc-render-sweep.js --base http://localhost:5000` (~4 min for the full set).
- CSP: zero `<script>` blocks and zero `on*=` handlers across all 11 pages (only a
  JSON-LD block, which is not executable).
- Playwright: **35/35** interaction assertions — lightbox open/next/wrap/Escape/focus
  restore, Load More 5→15, service jump menu, mobile drawer + `aria-expanded` + Escape,
  form refusing to claim a false success, banner dismissal persisting across pages, and a
  **JavaScript-disabled** pass confirming chrome, copy and phone links all still render.
- Screenshots at 1440 and 390 px on every page; no horizontal overflow anywhere.

## 7. Open items for Jo

1. ~~**Form destination.**~~ **DONE (Jo, 2026-08-19).** Wired to
   `scott@oaksroofingandconstruction.com` via the `formEmail` route: submitting composes a
   pre-filled email in the visitor's own mail client, addressed to Scott, and they press
   send. No account, no relay, and — importantly — **the details never pass through any
   third party**, which is what `privacy.html` already told visitors, so the policy stayed
   true. Known weak spot: a desktop visitor with no mail client configured sees nothing
   happen; the form says so and points at the phone. If that shows up in practice, one
   commented line in `assets/js/site.js` switches to a FormSubmit relay —
   **and that change requires editing privacy.html's "Third parties" section**, which
   currently states submissions are not routed through an outside service. `formEndpoint`
   wins over `formEmail` when both are set.
   The address is deliberately NOT printed as visible page copy (spam harvesting); the
   privacy policy routes deletion requests through the phone number instead. It *is*
   readable in `assets/js/site.js`, so this reduces exposure rather than eliminating it —
   offered to Jo to surface on /contact if he'd rather.
1b. **`companyProfile/oaks` `contact.email` is `joe@oaksrfc.com` — UNRESOLVED, and it is
   not just a website field.** Jo gave Scott's address as
   `scott@oaksroofingandconstruction.com`, which disagrees. `contact.email` is read by
   `document-generator.js`, `estimate-finalization.js`, `estimate-supplement.js`,
   `inspection-report-engine.js`, `photo-report.js`, `customer-portal.js` and
   `customer-tasks-ui.js` — so whatever is in that field is printing on **Scott's
   estimates, inspection reports and photo reports**, not only on a web page. If
   `joe@oaksrfc.com` is dead, his customers have a bad contact on real paperwork. Left
   alone deliberately: it could be an intentional ops alias, and guessing between two
   plausible addresses on customer-facing documents is not a call to make unasked.
   **Needs one word from Jo, then a one-field prod write.**
1c. **`companyProfile/oaks` brand data is thin and off-brand** — `colors.accent` is
   `#C2410C` (real brand orange is `#fa6404`), `services` is `[]` and `serviceArea` is
   `""`. These only fed the retired stub, so nothing renders them today, but the same
   record drives tenant-branded documents. Worth a cleanup pass; the real values (5
   services, 15 cities) are in §2 of this note and in the rebuilt site.
2. ~~**`logo-orange.svg` is the wrong orange.**~~ **DONE (Jo, 2026-08-19).** Rebuilt
   against the real artwork: `#e8720c` → `#fa6404`, the hammer changed from solid black to
   a knockout (negative space, as in the real mark), portrait 200×232 → the real landscape
   900×366, and the missing "ROOFING, SIDING, GUTTERS" tagline added. Path unchanged, so
   `companyProfile/oaks` `brand.logoUrl` and the generated documents pick the correction up
   with no data change.
   **Trap worth keeping:** the wordmark was first fitted with `textLength` +
   `lengthAdjust`. **librsvg does not honour those** — and librsvg renders the generated
   PDFs — so it looked correct in a browser and clipped at both ends in a document. Type is
   now sized for the widest fallback (Arial Black) instead. Verified by rendering the SVG,
   not by reading it.
   Favicons across the 11 pages were repointed to a new square `assets/img/icon.svg`: at
   16–32px the landscape lockup collapses into unreadable mush. Checked at 32px.
3. ~~**Scott has no published email address.**~~ **RESOLVED (Jo, 2026-08-19):**
   `scott@oaksroofingandconstruction.com`. The archived site never published one, so this
   came from Jo directly — it is not in any source page.
4. **At launch:** delete the `<meta name="robots">` from all 11 pages, uncomment
   `canonical`/`og:url` and point them at the real domain, and drop the two
   `/sites/oaks` `X-Robots-Tag` rules in `firebase.json` together.
5. **Photos.** Nine gallery images is thin for a roofer. Scott almost certainly has more on
   his phone; the README explains how to add them.

## 8. Files touched outside `docs/sites/oaks/`

- `firebase.json` — removed the eight `/sites/oaks* → /sites/t/oaks` 301s from the
  2026-07-04 cutover (they would have shadowed every rebuilt page); added the
  `/sites/oaks → /sites/oaks/index` base fix and a `/sites/oaks/services` convenience
  301; expanded the `/sites/oaks` noindex rule's comment with the keep-until-launch rationale.
- `scripts/check-site-integrity.js` — new `servedUrlOf()` (§4a).
- `scripts/check-chrome-governance.js` — 11 `EXEMPT` entries with a stated reason.
- `documentation/architecture/PILLAR5-DOMAINS-SITES-PLAN.md` — dated correction on the
  now-partly-reversed 2026-07-04 cutover decision.
- `documentation/architecture/MULTI-TENANT-ARCHITECTURE.md` — Pillar 5 "Now" section
  corrected to describe both Oaks surfaces.

## 8b. FINAL STATE — everything below is live and verified on production

Merged and deployed in this order, each with 19/19 CI and its own deploy:

| PR | what |
|---|---|
| #1265 | the 11-page rebuild, split out of #1263 so it could ship alone |
| #1266 | homepage redirect **loop** hotfix (`/index` → `/home` + rewrite) |
| #1268 | nine adversarial-pass findings + logo mark + trailing-slash form |
| #1263 | the 83-finding design sweep (merged after resolving 19 Oaks conflicts to main) |
| #1270 | header controls bunched left below 1040px |
| #1271 | gallery lightbox controls dead — regression from #1268's focus trap |

Verified against **production**, not a model of it:

- `/sites/oaks`, `/sites/oaks/home/`, `/sites/t/oaks`, `/sites/oaks/about/` — all resolve
  200 in at most two hops, no loops.
- All 11 pages 200; the Oaks 404 fires at shallow and deep paths with **zero** NBD strings.
- Gallery: all nine photos walked one at a time at desktop and mobile, each decoding at
  full resolution, counter wrapping 9→1, prev and close working, dialog not inert.
- Header at 320/360/390/430/768/1040/1400: dead space 22px (the wrap padding) at every
  width, no overlap, no overflow.
- Contrast: all nine measured pairs pass AA. Footer logo ratio 2.459 = natural 2.459.
- The NBD marketing surface after the sweep: 12 pages checked, all 200, nav + footer
  rendering, **no font 404s** after the 594KB duplicate dedup, zero non-GA HTTP errors.

Prod data on `companyProfile/oaks`, each written and read back:
`brand.contact.email` and `brand.contact.alertEmail` → `scott@oaksroofingandconstruction.com`
(both were `joe@oaksrfc.com`, a domain Jo confirmed wrong — and `contact.email` prints on
Scott's estimates, inspection reports and photo reports, not just a web page);
`brand.colors.accent` `#C2410C` → `#fa6404`.

**Only remaining action is Jo's:** send Scott the current zip. An earlier build was handed
over before the fixes and must not be the one that ships — it has the stretched footer
logo, the fabricated `reviewCount`, the form that leaks PII into the URL, and no 404 page.

## 9. Related

- [PILLAR5-DOMAINS-SITES-PLAN](../architecture/PILLAR5-DOMAINS-SITES-PLAN.md)
- [MULTI-TENANT-ARCHITECTURE](../architecture/MULTI-TENANT-ARCHITECTURE.md)
- [TENANT-CUSTOM-DOMAINS](../runbooks/TENANT-CUSTOM-DOMAINS.md)
