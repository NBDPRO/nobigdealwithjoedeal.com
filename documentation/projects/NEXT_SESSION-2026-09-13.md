# NEXT SESSION — 2026-09-13

Supersedes [NEXT_SESSION-2026-09-09](NEXT_SESSION-2026-09-09.md) as the live
brief. That note's §0 queue and §1 Turnstile warning still stand; nothing
below contradicts them. *(Update 2026-09-13, late: §1's coverage half — six of
ten forms unkeyed — is fixed by Lane B PR D, see its STATUS in §B; its
"do not set `TURNSTILE_SECRET`" half still stands.)* This brief is the execution plan that came out of
checking Grokbot's outside-in site audit against the repo — the evidence is
in [GROKBOT-BRIEF-VERIFICATION-2026-09-13](../audit/GROKBOT-BRIEF-VERIFICATION-2026-09-13.md);
read its §2–§3 before trusting any claim from the Grokbot brief itself.

**How this was built.** Read-only recon on `fix/gbb-tier-followups` @
`4def98a6` (main unchanged): inline checks plus a 16-agent workflow (8
fact-checkers, 5 skeptics, 3 planners). Skeptics overturned 0 verdicts and
narrowed 1. Every line number below was read on that tree; re-grep before
editing, because `main` moves. Jo approved the plan and made four decisions
(§0) on 2026-09-13; Jo intends to execute in a fresh session.

---

## §0 — Decisions already made (do not relitigate)

1. **Favicons:** two marks only. Homeowner pair = `/favicon.svg` +
   `/assets/images/apple-touch-icon.png`. Pro pair = `/pro/favicon.svg` +
   `/pro/img/nbd-icon-192.png`. Path rule: `docs/pro/**`, `docs/admin/**`,
   `docs/tools/**` → pro; `docs/sites/oaks/**`, `docs/sites/t/**` →
   excluded (other brands); everything else → homeowner. Overrides:
   `sites/index.html` and `sites/free-guide/index.html` → pro (contractor
   audience); **`pro/portal.html`, `pro/estimate-view.html`,
   `pro/photo-review.html`, `pro/sign.html`, `pro/esign.html`,
   `pro/refer.html` → homeowner** (Jo: a homeowner signing a contract sees
   the roof mark).
2. **Pro door:** keep exactly one silent "Are you a contractor? → NBD Pro"
   per footer. Delete only the louder "NBD Pro ↗" item at
   `site-src/partials/footer-extended.html:43` and restamp the 18-page
   cohort. The homepage footer (`docs/index.html:1990`) is untouched.
3. **Cal.com flip** (Phone booking question → Required on all six event
   types) is done in a **live session where Claude drives Jo's logged-in
   Chrome (claude-in-chrome MCP) and Jo approves every Save**. Write the
   runbook first; record before/after per event type.
4. **Homepage cut: the full cut** (§C below), in the order PR1 copy → PR3
   isolation → PR2 structural cut.
5. Carried from 09-09: **do NOT set `TURNSTILE_SECRET`.** Still true after PR D
   shipped: the next step is measuring live tokens (§B, PR D STATUS), and
   enforcement stays Jo's separate decision.

## §1 — Jo's queue (only Jo can do these)

1. Cal.com session (decision 3) — after Lane B PR A is deployed, so the
   resolver is already reading `responses.attendeePhoneNumber`.
2. Places secrets: Place ID Finder → `ChIJ…`; GCP project `nobigdeal-pro` →
   enable **Places API (New)** (not the legacy library
   `functions/google-reviews.README.md` links); API key restricted to it;
   `firebase functions:secrets:set GOOGLE_PLACES_API_KEY` and `NBD_PLACE_ID`.
   The deploy leaves real values intact (`firebase-deploy.yml:405-447`).
3. Supply: **one true crew sentence** (reconciles "don't subcontract" on
   ~20 pages, "My crew" on 4, "It's Just Me. That's the Point." at
   `docs/index.html:1395`); the **11-character YouTube ID** for
   `#intro-video`; confirm the **three featured reviews** (default:
   Customer AR, Alin Roșu, George Hills from `docs/review.html:35-144`).
4. Optional: `grok login`, for the refuter pilot in §E.

## §2 — Execution order

1. **Lane A** favicons — one PR, mechanical, proves the EOL discipline.
2. **Lane B PR A** (Cal.com resolver + fixture test + attribution +
   runbook), then Jo's Cal.com session.
3. **Lane D** — Jo sets the Places secrets; rebase PR #1518.
   **Done 2026-09-13, same day (#1545) — both Places secrets are live,
   `/api/google-reviews` returns 29 reviews at 5.0. Superseded by this
   line's own execution order; kept for history.**
4. **Lane C PR1** copy fixes (tiny, same day).
5. **Lane C PR3** isolation (free-guide chrome, X-Robots header, footer door).
6. **Lane C PR2** structural cut + reviews rebuild + visual re-bless.
7. **Lane B PR C** (form parity), **PR B** (phone-less alert), **PR D**
   (Turnstile hoist — **shipped 2026-09-13**, see its STATUS in §B).
8. **§E** Grok refuter pilot on the next review workflow.

**Ground rules for every PR:** branch from `origin/main`, never from
`fix/gbb-tier-followups` (PR #1533). Never `sed -i`; build inserted blocks
with `\n`, convert to the file's EOL once, assert no lone `0x0D`
(CLAUDE.md). `docs/**` merges deploy production; `documentation/**` does
not. `tests/_tmp-lanef-probe.test.js` is untracked and not ours — leave it,
and expect `run-test-manifest.js --check` to be red locally until it is
moved aside. Open PRs that touch adjacent ground: #1518 (reviews function,
CONFLICTING on two doc hunks), #1519 (`/our-work` rebuild), #1499 and #1518
both append to the `node` array in `tests/ci-manifest.json` — re-measure
`FLOORS.node` in `scripts/run-test-manifest.js:141` on the rebased tree,
never add +1 blindly.

---

## §A — Lane A: favicons and manifest (1 PR)

> **STATUS 2026-09-13 — BUILT, on branch `fix/favicon-normalization`** (not
> merged; merging deploys production). Do not rebuild it. Full record:
> [FAVICON-NORMALIZATION-2026-09-13](../audit/FAVICON-NORMALIZATION-2026-09-13.md).
> Two departures from the plan below, both recorded there: **`pro/invoice-success.html`
> joined the homeowner overrides** (a homeowner lands on it after paying an
> invoice; it was not in the list Jo was shown — one line to flip), and **the
> homeowner `apple-touch-icon.png` turned out to be a malformed PNG since #1467**
> (navy band over black in every browser), now rebuilt from `favicon.svg` by
> `scripts/render-apple-touch-icon.js` with a chunk-level assertion in the
> contract test. The plan's step 6 "eyeball the PNG" is obsolete.

1. **`scripts/normalize-favicons.js`.** Skeleton from
   `scripts/ensure-nav-css.js:45-94` (walk with dir skip list, assert-only
   default, `--write`, the no-`</head>` bail at `:79-81`, EOL detection at
   `:83-85`); shape from `scripts/add-ga4-tag.js:82-131` (pure exported
   transform with a single-`</head>` guard, `--check` / `--list`, a
   reasoned scope carve-out comment, `module.exports`). **Do not clone
   `scripts/ensure-icon-css.js`** — it hardcodes `\n` at `:60`. Exports
   `classify(rel)` → `{audience: homeowner|pro|excluded|skip, reason}`
   (skip = `googlee5b8f461f0f8e74b.html`, which has no `<head>` and must
   never be edited) and `normalizeIcons(html, audience)` → `{html, changed,
   refused}`: refuse unless exactly one `</head>`; collect every `<link>`
   whose rel tokens intersect {icon, shortcut icon, apple-touch-icon,
   apple-touch-icon-precomposed, mask-icon}; no-op if they are exactly the
   canonical pair (order-agnostic — `pro/daily-success/index.html:13-14`
   puts apple-touch first); else remove them all and insert the pair at the
   first removed tag's position with its indentation, or before `</head>`.
   `--check` exits 1 naming offenders and also fails if an excluded page
   carries any of the four NBD hrefs (cross-brand leak guard) or if an
   exclusion pattern matches zero files. `--root <dir>` for fixtures.
2. **Run.** `--list` first (expect ~226 homeowner / 45 pro / 13 excluded /
   1 skip), then the write (~62 files: 17 homeowner pages gain apple-touch,
   36 pro pages flip, 6 admin + `tools/index` + `sites/index` stamped from
   nothing, `sites/free-guide/index.html:16-17` flipped to pro, the six
   override pages keep the homeowner pair). Then `--check` = 0 and
   `git ls-files --eol -- 'docs/**/*.html'` shows only `i/lf w/crlf` plus
   the stub's `i/none w/none`.
3. **Delete `docs/manifest.json`** (Pro-branded orphan, scope `/`,
   `start_url /pro/dashboard.html`, linked by no page; `docs/pro/sw.js:86`
   precaches only `/pro/manifest.json`). **Same commit:** remove
   `tests/pwa-manifest.test.js:52` (line 30 is an unguarded `readFileSync`,
   so the node bucket crashes otherwise), add an assertion that the root
   manifest does not exist, update the docblock at `:5`; fix the stale
   comment at `docs/pro/leaderboard.html:10-11`. A homeowner rewrite is
   rejected: no homeowner 192/512/maskable PNG exists and the test's
   `fs.existsSync`-only check would pass a lied size.
4. **`tests/favicon-contract.test.js`** (node bucket, zero-dep, in the
   `tests/ga4-landing-coverage.test.js:36-49` style): transform can change
   / is idempotent / CRLF-safe / refuses malformed head; classification incl.
   a synthetic never-existing homeowner path and every override; tree walk
   of ≥280 pages (own walker, no skip list — `docs/admin/**` is guarded by
   no other HTML gate) asserting exactly two canonical tags per page by
   audience and no NBD href on excluded pages; PNG magic + IHDR dims
   (apple-touch 180×180, pro icon 192×192); `spawnSync` of `--check` exits 0
   on the tree and 1 on a scratch fixture under `--root` (the
   `tests/crm-audit.test.js:26-30` technique); every `rel="manifest"` →
   `/pro/manifest.json`. Register in `tests/ci-manifest.json`; re-measure
   FLOORS.
5. **CI:** add `node scripts/normalize-favicons.js --check` to `ci.yml`'s
   `site-integrity` job after the nav-CSS step (`:233`). Not the deploy
   pre-flight (`ci.yml:196-206` green-streak rule).
6. **Vault:** `documentation/audit/FAVICON-NORMALIZATION-2026-09-13.md`
   linked from INDEX; mark `DESIGN-CONSISTENCY-SWEEP-2026-08-19.md` row 64
   superseded.

**Traps.** `docs/sites/oaks/404.html` stays iconless (a site-absolute NBD
href is the cross-brand leak `firebase.json:57-58` exists to stop; a
relative href resolves against the bogus URL typed). `/pro/favicon.svg`
draws its mark with `<text font-family="Arial Black">`, so it can render
differently on Linux tab strips — follow-up, not this PR.
`tests/marketing-polish-contract.test.js:216-219` requires
`data-nbd-freeguide` in `docs/pro/index.html` — the head rewrite must not
disturb `:1957`. Verify the `/favicon.ico → /favicon.svg` rewrite and the
Oaks 404 on a **preview channel** with a Node probe, not the hosting
emulator.

## §B — Lane B: a phone on every lead request (4 PRs)

> **STATUS 2026-09-13 — PR A MERGED as #1535** (`954e7331`, deploy running
> at the time of writing; confirm it succeeded). PR C, PR D and PR B not
> started. A read-only Cal.com recon (PR #1537) settled the payload questions
> this lane was built around: `attendeePhoneNumber` is the live identifier,
> the two call types carry the number in the location prompt, the webhook
> sends the default payload — and **only `gutter-siding-estimate` and
> `adjuster-meeting` need the Required flip**. The live session now follows
> [CALCOM-PHONE-REQUIRED](../runbooks/CALCOM-PHONE-REQUIRED.md), which
> supersedes step 1 below (the old "Advanced tab" path and "all six" scope).

**PR A — Cal.com resolver, fixture test, attribution, runbook.**

1. `documentation/runbooks/CALCOM-PHONE-REQUIRED.md`: per event type
   (roof-inspection, gutter-siding-estimate, roof-inspection-lexington,
   roof-question-call, adjuster-meeting, estimate-walkthrough): Event Types
   → Advanced → Booking questions → Phone (`attendeePhoneNumber`) →
   Required ON, Hidden OFF, label "Mobile phone". Note the double-ask on
   roof-question-call (its phone field was deliberately hidden per
   [CALCOM-INTEGRATION-2026-08-25](../audit/CALCOM-INTEGRATION-2026-08-25.md):41);
   recommend required on all six anyway. Fix the stale line ref in
   `WAVE2-IMPLEMENTATION-MAPS-2026-09-05.md:716` (`_shared.js:62`, not 57).
2. **`functions/integrations/calcom-logic.js`**, pure and firebase-free,
   modelled on `functions/integrations/thumbtack-logic.js`.
   `resolveAttendeePhone(payload)` reads in order `attendees[0].phoneNumber`
   → `responses.attendeePhoneNumber` (object `.value` or bare string) →
   `responses.phone` → `responses.location` when `value.value` is a phone
   type (`phone`/`attendeePhone`/`userPhone`, read `optionValue`) →
   `attendees[0].phone`; takes the first whose `phoneDigits10()` is exactly
   10 digits; returns `{phone, phoneDigits, phoneSource}` or `phoneSource:
   'none'`. `resolveBookingAddress(payload)` prefers
   `responses.location.value.optionValue` for `attendeeInPerson` /
   `attendeeAddress`, and never writes a type token into `address`
   (`calcom.js:183` may be doing exactly that today — unverifiable without a
   captured payload). `buildCalcomLead({payload, bookingId, repUid,
   repCompanyId})` returns today's M-2 doc shape plus `phoneSource`,
   `addressSource`, `needsPhone`, `calcomEventSlug`, `calcomEventTypeId`,
   `sourcePage: 'calcom:<slug>'`, and a "NO PHONE on this booking" notes line
   when `needsPhone`. `matchExistingLead(leadDocs, {email, phoneDigits})`
   shared by the webhook's M-1 block and
   `scripts/backfill-calcom-dropped-leads.js:30-42`.
3. **Wire `functions/integrations/calcom.js`** at `:151-152` (M-1) and
   `:173-197` (M-2). Keep a local `phone` variable and the literal
   `phoneDigits: phoneDigits10(phone)` — `tests/smoke/functions.test.js:650-652`
   pins it, and `:646-647` pins the M-2 create within 600 chars of
   `if (!leadId) {`. **Do not touch the HMAC block `:60-81`**
   (`tests/smoke/security-guards.test.js:43-46`,
   `functions.test.js:1580-1584`). Appointments doc: `attendeePhone` from
   the resolver, `location` → resolved address, keep raw `payload.location`
   as `calcomLocationRaw`. Add boolean-only breadcrumbs `{phonePresent,
   phoneSource, addressSource}` to the `:199` log (the
   `integrations.js:512-516` pattern) so the first real booking proves which
   field Cal.com populates. Backfill script builds leads through the same
   module; extend `functions.test.js:669-674` no-drift assert with
   `/calcom-logic/`.
4. **`tests/calcom-webhook-payload.test.js`** (node bucket, zero-dep, the
   `tests/thumbtack-webhook.test.js` shape, 513-555-01xx numbers): F1
   documented shape (phone in `responses.attendeePhoneNumber`, address in
   `responses.location.value.optionValue`, top-level `location:
   'attendeeInPerson'`), F2 legacy `attendees[0].phoneNumber`, F3 bare
   string, F4 phone-call location (address stays `''`), F5 no phone →
   `needsPhone:true` + notes line, F6 garbage `{value:'call me'}` rejected,
   F7 slug/eventTypeId extraction; M-1 parity (hits on phoneDigits and
   email, misses on 9 digits); wiring regexes over `calcom.js`
   (`require('./calcom-logic')`, `resolveAttendeePhone(payload)` before
   M-1, `buildCalcomLead(` inside M-2, `phoneSource` in the logger) — these
   make the suite **red on the current tree**. Register + FLOORS.
5. **Attribution:** `functions/lead-bridge-logic.js mapPublicLeadToLead
   (:183-206)` adds `sourcePage: String(data.source || '')` — the forms
   already post `/inspect`, `/storm-report`, `page-form:/areas/…`,
   `tenant-site:…`, today collapsed into one label and dropped. Leave
   `source` alone (lead-alert `KIND_LABEL` and the scorecard key on it).
   Extend `tests/lead-bridge.test.js`. Confirm what
   `inline/72f02d79d0.js:93` posts as `source` for the homepage form. Next
   month's trust math = one Firestore query on leads grouped by
   `publicLeadKind, sourcePage, calcomEventSlug, needsPhone, phoneSource`.

**PR B — catch phone-less bookings that still arrive.** Nothing alerts Joe
when `calcom.js` creates `leads/{calcom__<id>}` today (`lead-alert.js:454-458`
fires only on the five public collections). Add `exports.leadAlertCalcom =
onDocumentCreated({...TRIGGER_OPTS, document: 'leads/{leadId}'},
onCalcomLeadAlert())` — literal factory RHS per `lead-alert.js:447-453`
(deploy allowlist grep at `firebase-deploy.yml:854`). **Early-return unless
`publicLeadKind === 'calcom_booking' && webLead === true`**, or every web
lead double-fires. Reuse `alertJoe/summarize/emailHtml/smsBody`; add
`KIND_LABEL.leads = 'Cal.com booking'`; when `needsPhone`, a highlighted
"No phone on this booking — reply to the Cal.com confirmation email" row
with a mailto, and an SMS first line "⚠ NO PHONE". Homeowner "reply with
your best mobile" ack only for the no-phone case (it would be a third
email; Jo's call). Calcom leads carry no `tcpaConsent`, so the SMS ack
correctly stays suppressed — do not widen `smsAckGate`.

**PR C — first-party form parity.** `docs/assets/js/inspect-form.js`:
validate name, address, 10-digit phone before disabling the button (`:96-97`),
using the `functions/phone-utils.js:36` expression byte-identical (a smoke
guard checks browser copies do not drift); field-level errors via the
`inline/72f02d79d0.js:142-148` `_formShowError` pattern; map the server's
"Invalid submission" to field copy. `docs/inspect.html:200-206`: "Mobile
phone" label/aria/placeholder; add the TCPA consent checkbox + copy verbatim
from `docs/storm-check.html:316` and post `tcpaConsent` — **first verify the
`inspect` spec at `functions/handlers/integrations.js:254-269` accepts it**
(`boolOptional`), or it is silently dropped (the 2026-09-04 estimate bug).
Homepage contact `:1745-1746`: `Phone *` → `Mobile phone *`, and upgrade the
truthiness check to the 10-digit rule. Storm tools (`storm-report-page.js:87`,
`storm-check.js:259`, `roof-score.js:306`): `< 10` → the normalized `=== 10`
so an 11-digit paste behaves like `/estimate`. Optional `nbd_hp` honeypot on
`/inspect` (extend `tests/honeypot-autofill-contract.test.js` §2 if done).
New `tests/lead-form-phone-contract.test.js`: for each form JS file the
10-digit expression precedes `submitPublicLead(`; each HTML page has a
`type=tel` input labelled "Mobile phone" and an email input labelled optional.

> **STATUS 2026-09-13 — PR D SHIPPED as #1542, plus the timeout follow-up on
> branch `fix/turnstile-timeout-6s`.** Do not rebuild. `TURNSTILE_SECRET` was
> not touched by either. Full record, with every measurement:
> [TURNSTILE-SETUP](../runbooks/TURNSTILE-SETUP.md) (updated in place).
>
> - **The real surface count is 181, not ~178.** 10 pages load
>   `public-lead-submit.js` directly; **170** inject it through
>   `quick-lead-form.js` — 31 `/areas/*` **and 139 `/services/*`** (the plan
>   below says "171 /areas"); `sites/index.html` reaches it through
>   `marketing-firebase-init.js` → `marketing-firebase.js`. 177 were unkeyed.
>   `tests/turnstile-contract.test.js` now derives this list by walking
>   `docs/` (transitively, through any loader script) and was RED on the
>   pre-fix tree with "unkeyed 177".
> - **Three defects, not two.** (1) the hoist; (2) render→reset, which was
>   worse than the plan says: on a retry real `api.js` either handed back the
>   *spent* token or waited the full timeout with none; (3) **new:** the
>   Turnstile script load was awaited *before* the safety timeout was armed,
>   so a network that stalls `challenges.cloudflare.com` never POSTed the
>   lead at all (measured: no POST in 45 s). The timeout now covers load +
>   challenge. The client also renders with `execution: 'execute'`.
> - **The timeout is 6 s, not 8 s** (Jo, 2026-09-13). 4 s was built, measured
>   and rejected: it cut off 1 of 10 always-pass test-key first submits.
>   Pinned as `TURNSTILE_TIMEOUT_MS = 6000` in the contract test.
> - **What a submit costs now** (click → POST, Playwright Chromium, local
>   `docs/`, only Cloudflare reachable, nothing reaching production):
>   always-pass test key first submit median 1,904 ms / p90 2,237 / max 2,613
>   (n=40), retry median 1,650 ms; Cloudflare refused ~15 ms; Cloudflare
>   stalled = the 6 s timeout, lead still sent. Before PR D these pages
>   POSTed in 0–14 ms. The real key refuses automation (600010), so **no
>   human timing exists** — do not try to get one from a bot.
> - **Deploy:** #1542 merged as `7121d512`. Its own deploy run (34787955298) was cancelled by the next merge, as queued runs are; it shipped inside run **34788131516** (head `00d0465b`, #1518, which descends from `7121d512`), which succeeded. The live `/assets/js/public-lead-submit.js` was then fetched and confirmed to contain `DEFAULT_TURNSTILE_SITEKEY` (2026-09-13).
>
> **Next (in order; nothing here needs code):**
> 1. Confirm the follow-up's own `firebase-deploy` run succeeded and that the
>    live `/assets/js/public-lead-submit.js` contains
>    `TURNSTILE_TIMEOUT_MS = 6000` (a queued deploy can be cancelled by a
>    later merge — check the surviving run contains the commit).
> 2. Wait for `turnstileTokenPresent:true`. **A standing alert is live**
>    (Cloud Monitoring `alertPolicies/15802792625691337472`, from
>    `monitoring/alert-turnstile-token-present.json`; email + SMS to Joe, at
>    most daily), so no scheduled check is needed. It was the project's first
>    live alert policy; eight more went live the same evening (#1547, after
>    a 7-day replay fixed two of them). When it fires, read the lead doc's
>    `source`: the rollout wants trues from `/inspect` **and** at least one
>    `page-form:/areas/…` or `page-form:/services/…`. At ~2 leads/month this
>    takes weeks.
> 3. Only then does the enforcement question reopen — Jo's call. The
>    runbook's §"The safety timeout is 6 s" says how to read a low token rate.

**PR D — Turnstile coverage (own PR; NEVER set `TURNSTILE_SECRET`).** Hoist
the key: `docs/assets/js/public-lead-submit.js` gets
`DEFAULT_TURNSTILE_SITEKEY` and `siteKey() = window.__NBD_TURNSTILE_SITEKEY
=== undefined ? DEFAULT : String(…).trim()` (an explicit `''` stays an
opt-out), which keys the 6 unkeyed direct pages, the 171 `/areas/*`
injections via `quick-lead-form.js:21-30`, and `sites/js/marketing-firebase.js`
with zero HTML edits. Keep the literal lines the contract test pins (`:56`,
`:77-78`, `:91`, `:117`). Fix `render()`→`reset()`: module-level
`_widgetId`, render once, then `turnstile.reset(_widgetId)` +
`execute(_widgetId)`, re-binding the pending resolver; keep the 8 s timeout
but clear it on callback. Rewrite `tests/turnstile-contract.test.js`: fix the
false docblock (`:8-10` says the key ships EMPTY — populated since 09-06),
replace the hardcoded `FORM_PAGES` (`:51-56`) with a walk (reuse `:71-83`)
over every page referencing `public-lead-submit.js`, `quick-lead-form.js`
or `marketing-firebase.js`, assert stub-before-client OR client default ===
stub key, plus a no-drift assert between the two. Verify after deploy via
Cloud Logging `turnstileTokenPresent:true` from `/inspect` and one `/areas`
page. `firebase.json:89` already allows `challenges.cloudflare.com`; confirm
the header rule covers `/areas/**`.

## §C — Lane C: homepage cut and audience isolation (3 PRs)

**PR1 — copy fixes only** (`docs/index.html`, `docs/privacy.html`; both
edits are outside partial markers — the homepage has none). `:1264` "I come
out personally, get on the roof, check everything, and give you"; `:1274`
"Every job backed by the NBD Guarantee and The Lifetime Pledge — call me
about anything I worked on and I come look, free, for as long as I'm in
business and you own the home." (mirrors `the-pledge/index.html:40`);
`privacy.html:633` "backed by the NBD Guarantee and The Lifetime Pledge.";
`:1305` H2 → "Big Brand Doesn't Mean Better Work." (the section dies in PR2,
but the claim must not outlive PR1); `:1402` "5yr" → "Life"; `:1411` "who
answer the phone"; `:1467` "See All 31 Service Areas →"; `:1818` drop "&
Facebook" (unverifiable); `:1395` → Jo's crew sentence (carry to PR2 if not
supplied; proposed default "You Deal With Joe. Joe's Crew Does the Work.").
Leave the FAQ `:1620-1651` alone — its JSON-LD mirror must stay in sync.
Expected inside the 2% visual budget.

**PR2 — structural cut, reviews block, video slot, re-bless.**

- Verdicts (current anchors): hero `:887` KEEP, drop only the TAMKO box
  `:963-968`; nbd-system `:1037` TRIM to the tier card `:1046-1058` + the
  NBD Build card `:1061-1067`, delete LumaNail/Roofivent/Pivot Boot cards
  `:1068-1088` (all three service pages exist); storm-band `:1118-1156`
  DELETE (lives at `/services/tamko-storm-series`; no `#storm-series`
  deep-links anywhere); services `:1159` KEEP; process `:1248` KEEP;
  free-tools-band `:1285` KEEP; compare `:1301-1362` DELETE
  (`about.html:687-712` carries it; no `#compare` deep-links); intro-video
  `:1364` KEEP hidden; about `:1380` KEEP; areas `:1421` TRIM — H2 "Serving
  Greater Cincinnati & Northern Kentucky", one sentence keeping "and the
  Lexington area on scheduled trips" (true per FAQ `:1631`), ONE grid of 8
  anchor cities (Cincinnati, Milford, Loveland, Mason, West Chester,
  Batavia, Florence KY, Covington KY) + the `/areas` button, delete the 4
  contact tiles `:1469-1498`; keep `areaServed` JSON-LD `:495`;
  homeowner-wall `:1505` KEEP (it renders 12 cards at runtime despite
  `hidden`); reviews `:1513` REBUILD; partners band `:1541` KEEP; faq
  `:1620` KEEP untouched; book-band `:1655` KEEP; contact `:1669` KEEP form,
  TRIM the aside `:1784-1856` (drop the 17-link services list `:1795-1811`
  and the 5 "Why Joe?" items `:1813-1822`); brands-strip `:1863` DELETE.
- New order: hero → services → process → free-tools → nbd-system → about →
  intro-video (hidden) → homeowner-wall → reviews → areas → partners → faq →
  book-band → contact. Move blocks with a Node script that slices by section
  markers and writes back with the file's own EOL
  (`scripts/apply-partials.js:203-206` pattern). Delete orphaned page-local
  CSS (`.compare-*`, `.storm-*`, `.brands-*`, `.nbd-component`; keep `.iv-*`).
- Reviews block: replace the static row `:1519-1526` with the `/review`
  hook markup (`docs/review.html:510,:513`: `data-nbd-gr-rating`,
  `data-nbd-gr-count`), which `google-reviews-widget.js:145-155
  hydrateStaticHooks()` already rewrites when `total>0` — live the day the
  secrets land, zero JS. Never hardcode "28"; cite POSTING-LOG in a source
  comment. Beneath it `<div data-nbd-gr-static>` with three `<blockquote>`
  cards from the eight real Review objects at `docs/review.html:35-144`; one
  widget edit after the `renderAll()` empty guard (`:97-100`) hides the
  static three when live cards render. Hero badge `:908` →
  `<span data-nbd-gr-rating>5.0</span>★ on Google`. No AggregateRating /
  Review JSON-LD on the homepage (`review.html:531-534` rule).
- Video: nothing to build; the 11-char ID into `data-yt` at `:1364`.
- Re-bless `landing` (`tests/e2e/visual-regression.spec.js:43-47`, 2%
  fullPage): two-push procedure per `ci.yml:974-992` — push 1 deletes the
  snapshots dir (the `tests/smoke/dashboard.test.js:1010-1020` pin goes red,
  expected), download the CI-rendered artifact, push 2 commits it. Never
  bless from Windows. Do not rename dropdown labels
  (`marketing-polish-contract.test.js:405-415`, `nav-contract.test.js:274-283`).

**PR3 — isolation.**

- `docs/sites/free-guide/index.html`: replace ann-bar `:845-847`, nav
  `:849-882`, drawer `:885-917`, footer `:1078-1086` with the contractor
  chrome from `docs/pro/blog/index.html:65-90,:141-148` and its CSS
  `:15-62`; CTAs → `#hero` "Get the Free Guide". Keep `nbd-nav.css/js`
  (`:880-881`), honeypot fields `:938/:1057`, stub-before-client order
  `:1094-1095`, noindex meta `:6`, `inline/3117b8ac17.js` (its
  `closeMobileNav` is in `nbd-nav.js:125-131`'s lock contract). **Trap:**
  `scripts/ensure-nav-css.js:68-72` exempts this page only while a
  `.dropdown-menu{display:none}` rule and a 768/900/1024 media query exist —
  keep a stub rule or CI injects marketing nav CSS. Update exemption reasons
  in `scripts/check-chrome-governance.js:56` and
  `scripts/migrate-nav-to-partial.js:57`; remove free-guide from the
  "remaining footer cohorts" in
  `documentation/architecture/SHARED-PARTIALS-SYSTEM.md:127-128` and
  `site-src/README.md:82`.
- `firebase.json`: add `{"source": "/sites/free-guide", "headers": [{"key":
  "X-Robots-Tag", "value": "noindex, nofollow"}]}` (the `:204-208` shape; no
  robots.txt Disallow — the page must stay crawlable so the noindex is seen).
- `site-src/partials/footer-extended.html:43`: delete the "NBD Pro ↗" item,
  `node scripts/apply-partials.js` (restamps 18 pages in place), then
  `--check --diff` = 0. Oaks and `/sites`: verified complete, nothing to do.

## §D — Lane D: reviews infrastructure

1. Jo sets the two secrets (§1.2).
2. Rebase PR #1518 — conflict is two doc hunks (`INDEX.md`, the 09-09
   handoff); its `functions/google-reviews.js` rewrite and tests apply
   cleanly. Branch is checked out at
   `.claude/worktrees/awesome-bouman-0746fc`. Preserve both `secretValue()`
   reads (`tests/secret-stub-guard.test.js:130-132`).
3. Fix `functions/google-reviews.README.md` in the same PR (legacy Places
   link; the "503 / widget hides itself" claim — the code returns 200
   `empty:true` and the widget renders a fallback card).
4. Verify `curl /api/google-reviews` returns real reviews; after C-PR2 the
   homepage row and hero badge hydrate.

## §E — Grok refuter pilot (one hour, then keep or drop)

`grok login`; then in the verify stage of the next review workflow, a
`refute-grok` step: a Node wrapper writes the finding to a temp file and
runs `grok -p @file --tools read_file,grep,list_dir --permission-mode plan
--output-format json --json-schema '<verdict schema>' --max-turns 12
--cwd <repo>`. Keep it only if it flips at least one verdict Claude's own
refuters missed in the first two runs. Never as a builder subagent; never
with write tools. Full reasoning in the audit note §4.

## §F — Gates and verification (every PR)

CLAUDE.md pre-push list: `check-js-syntax`, `check-site-integrity --quiet`,
`apply-partials --check --diff`, `build-sitemap` dry run, `build-projects
--check`, `check-inline-html-scripts`, `check-vault-index` (documentation
edits), `node tests/smoke.test.js`, `marketing-polish-contract`,
`run-test-manifest --bucket node` and `--bucket smoke`. Lane-specific:
`check-chrome-governance`, `ensure-nav-css`, `ensure-icon-css`, `crm-audit`,
`check-seo-surface --quiet`, `nav-contract`, `turnstile-contract`,
`honeypot-autofill-contract`, `tcpa-consent`, `pwa-manifest`. Anything that
depends on headers, redirects or rewrites is proven on a Firebase preview
channel with a Node probe, never on the hosting emulator. **Every new test
is proven able to fail against the pre-fix tree before it is trusted, and
the reddened assertion is the intended one.** CI's site-integrity and
marketing-polish jobs are not a `needs:` of the deploy — a red contract test
still ships, so run the gates locally before pushing.
