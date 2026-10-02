# NEXT_SESSION — 2026-10-02 part 2 (the 10-02 day, Jo saying "keep building")

Follows [NEXT_SESSION-2026-10-02](NEXT_SESSION-2026-10-02.md), which covers
everything up to #2000.

## §0 Read first

- **Five tiers are live.**
  - Rates per SQ: Economy $440, Good $550, Better $660, Best $770,
    Beyond $880 (#2010).
  - The single source of truth is `docs/pro/js/estimate-config.js`:
    `TIER_RATES`, `TIER_ORDER`, `PRODUCT_TIER` (economy→good material
    column, beyond→best), `TIER_SHINGLE_RULES` and `TIER_DISPLAY`.
  - **Beyond is TAMKO HailGuard ONLY.** TAMKO is the only shingle with a
    manufacturer hail warranty.
  - **Economy never uses a 3-tab.** Its warranty is 1-year labor plus the
    shingle maker's limited warranty, with no system warranty.
  - Economy and Beyond are **CRM-only**: in-person sales options, never on
    the public site (Jo).
  - Device-saved tier rates apply only when `tierRatesVersion` matches
    `_ratesVersion`, so a rate change reaches every device.
- **The shingle lock runs in `render()` now (#2011).** It used to run only
  on a tier switch or a single add. Picking Beyond and *then* loading a
  preset brought a GAF line back. Any new path that writes `state.scope`
  is covered automatically, as long as it re-renders.
- **Estimate Builder V3 (#2011) is a layer over the V2 modal, not a second
  builder.**
  - `estimate-v3-wizard.js` tags real V2 rows with `data-v3="step …"` and
    hides the rest.
  - V2's `open()` and `render()` call `EstimateV3.onOpen` and
    `EstimateV3.onRender`.
  - Tier cards click the real `#v2tier*` buttons.
  - **New V2 controls must be tagged in V3's `TAGS` list, or they are
    invisible in V3** (only "Full editor" shows them). The unit test checks
    that every tagged id exists in V2, but not the reverse.
- **Two PRs that each add a suite bump FLOORS identically and merge "clean
  but wrong".** It happened again here: #2011 and #2012 both set 295/389.
  `run-test-manifest.js --check` catches it. The fix is 296/390.

## §1 What shipped (#2001–#2012)

- **Reskin of JS-built screens:**
  - Product editor fields (#2001).
  - Close Board CRM surfaces (#2002).
- **Homepage hero re-encode (#2003):** mobile LCP 3.24 s → 2.76 s.
- **Call Center fixes:**
  - A Groq rate limit stops the run instead of counting as a strike
    against the call (#2004).
  - Call history (#2007) and texts (#2008) never go earlier than
    2026-01-01. Jo: "don't bloat the CRM."
- **Cloud Run invoker:**
  - `cspReport`, `sendEmail` and `sendSMS` declare `invoker:'public'`
    (#2005).
  - A weekly public-invoker watch was added (#2009).
  - Production was verified: all 137 functions are public.
  - Gen2 onCall functions ignore `invoker`. A lost binding needs
    `gcloud run services add-iam-policy-binding`.
  - Read IAM with `--format=json`; `value(...)` prints nothing for nested
    lists.
- **Pipeline search (#2006):** the search box no longer sticks across a
  refresh.
- **Five tiers (#2010):**
  - Covers the CRM, deal room, portal, paperwork and public price bands.
  - Public bands: Standard [615,690], Preferred [740,825], Elite [860,965];
    ballpark $14,800–$20,600.
  - Deal acceptance refuses an unpriced package with a 400.
  - Local E2E at 390 px: a Beyond save priced all five tiers.
  - Hosting and functions were deployed and checked live on 10-02.
- **V3 one-thumb wizard (#2011, merging by watcher):**
  - Full roof, 10–11 steps: Customer & job → Measure → Roof lines →
    Roof details → Penetrations & flashing → Package (5 cards, live
    prices) → Shingle & add-ons → Insurance (insurance only) → Photos →
    Review → Finish.
  - **Repair** (Jo let Claude decide), 7–8 steps: Customer & job → Repair
    type → Repair size → Items → Insurance → Photos → Review → Finish.
  - V2 is shelved behind "Full editor" (Jo).
  - Proof: local E2E at 390 px, every control ≥ 44 px, no horizontal
    overflow.
- **Google busy blocks on the Schedule's Today timeline (#2012):**
  - Calendar hub Phase 3 is done.
  - Shows Jo's own free/busy blocks that no NBD Jobs event and no timeline
    entry explain.
  - Owner/admin only, added after first paint, guarded against stale
    paints.
  - It shows nothing until Jo's main calendar is shared free/busy with the
    service account. The Google Calendar panel says so.

## §2 Jo's open items

- **Thursday 0.7.0** is still on STAGING, waiting on Jo's test call. Then
  run `node scripts/thursday-agent-lookup.js --promote --yes`.
- **Beyond warranty wording.** The assumption is Elite's terms (fully
  transferable, annual inspection) plus TAMKO's HailGuard hail warranty.
  Jo has not confirmed it.
- **V3 on Jo's iPhone:** one real estimate in daylight once #2011 is live.
- **Google Calendar:** share the main calendar free/busy with the service
  account, so the busy blocks and the double-booking warning see personal
  time.
- **Carried from the 10-02 note §2:**
  - SMS Backup & Restore setup.
  - Sort my customers.
  - Gary's stale task.
  - The Clarity project ID.
  - Roof-diagram CODE wording.

## §3 Next lanes

- **Reskin, the JS-built screens.** `vault-page.js` (208 inline styles),
  `expenses.js` (143), `invoice-pipeline.js` / `widgets.js` (140 each),
  `storm-center.js` (111). Use the in-context computed-style proof (see
  the 10-02 note §2b).
- **V3 follow-ups once Jo has used it:**
  - Whether the presentation step belongs inside V3.
  - Whether the review screen needs per-section "Edit" links. The jump
    sheet covers it today.
- **Search Console re-read** around 2026-10-30.
