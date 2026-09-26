# Upgrades & Add-ons: design decision (2026-09-25)

**Status (updated 2026-09-26):** stages 1 and 2 are built and merged. That covers #1756 (the core library and pricing helper), #1758 (slice 0, honest paperwork), #1762 (Settings → Upgrade prices) and #1763 (the builder card, Show homeowner, and V2 keeping upgrade rows). Jo answered the pricing questions: Amerimax Lock-In $6/LF, LeafBlaster $12, Reinforced $15, Alu-Rex $18. Warranties are 5 years on systems, 2 on guards, and a repair gets 1 year only when that box is ticked. Still owed by Jo: Loper's name in Settings, Loper's written 5-year backing, and the optional K5/K6 pre-tick call. The original status line follows.
**Original status:** designed, not built. The first build slice waits on Jo's pricing answers (see *Decisions Jo still owes*).
**Came from:** Jo's question, "our job templates have Good/Better/Best, but on gutters the tiers don't do anything. Make tiers meaningful, or build an upgrades tool?"
**Method:** a design workflow with six research lanes (a code map, four trade groups covering all 11 template categories, and a UX study), three competing designs, three judges (Jo / homeowner / engineer lenses), and one synthesis. The headline code claims below were then re-verified by hand.

## The decision

**Upgrades & Add-ons is its own feature, for every category. It never rides the Good/Better/Best buttons.**

Jo made the key call himself. On roofing, the tier buttons already mean "which shingle line", so they can't also carry upgrades; that would be two features on one trigger.

- **Tier:** picks ONE base material (radio buttons). It shows only where a real ladder exists and actually changes the price.
- **Upgrades:** pick any number of extras (checkboxes). An upgrade costs the same on every rung and sits on top of whatever base was chosen.

## Code facts (verified 2026-09-25)

- **Tiers do nothing on any job template.** All **107** default job templates, run through the real resolver (`JobTemplates.resolveSelection`), give identical totals and identical per-line retail at good, better and best. Tier only reaches price through `EstimateLogic.resolveMaterial(materialId, tier)`, and none of the 277 catalog items or template lines carries a `materialId`.
  - The only working tier pricing is V2 per-SQ cash (545/595/660) and its copy in the classic builder.
  - The roof "ladder" is really three separate templates (`jt_fr_asphalt_good/better/best`).
- **Silent pre-ticks.** `seedChoices` (job-templates-ui.js) sets `included:true` on every line, including lines marked `optional`. That means:
  - The K6 template's $6,050 includes about $850 of gutter apron.
  - The Guards Package ticks an underground drain.
  - The asphalt "Best" template bundles about 11 extras (full-deck ice & water, SmartVent, System Plus, …) on top of the Class 4 shingle.
- **A hidden tier still prints.** The saved tier defaults to `better`. The portal maps it to "Preferred" (functions/portal.js), and the document generator prints that tier's lifetime-workmanship sentence on gutter paperwork. That contradicts NBD's written 2-year workmanship warranty.
- **Upgrade machinery already exists, but none of it is homeowner-priced.** There are 101 `optional` items (the engine ignores the flag) and 70 rep-only "Upsell:" notes.
  - The V2 Add-Ons boxes are silently ignored in line-item mode.
  - `TIER_MATERIAL_MAP` is unmounted.
  - Close Board's "Best" card promises gutters and a full deck that aren't in the price.
- **How to print upgrades.** Upgrade lines should be **face-value retail rows, added after the engine** (like V2's pass-through fees). Routing them through markup, O&P and $25 rounding would print a different number than the one quoted, because the customer paper prints lines before O&P plus one separate O&P row.
- **V2 reopen drops unknown codes.** An estimate reopened in V2 drops any code the catalog doesn't know, so V2 needs a small change to keep upgrade rows.

## How it works (the chosen design: "builder upgrades panel")

**Rep side, in the Job Templates build screen:**
- The tier row hides wherever it prices nothing.
- An **Upgrades** card lists about 3 curated upgrades per job type, at most 5 behind "More". A "pick one" group, such as leaf protection, counts as one.
- Nothing is pre-ticked, and at most 2 are starred "Recommended". A star needs a reason from THIS house.
- **"Make required"** moves an item into the base scope, for code work.
- A **"Show homeowner"** button turns the same list into one clean full-screen page: Add / No thanks, a running total, and a warranty line only where the warranty is real.

**Saving and printing:** picks save as ordinary retail lines ("Upgrade — Alu-Rex leaf protection, 125 ft"). Estimate-view, the portal, the proposal, the contract and the invoice already print lines like that.

**Pricing rules:**
- Upgrade prices are exact cents on top of the base: no O&P re-division and no rounding.
- **No research-guess price ever reaches a homeowner**, only prices Jo has saved (Settings → Upgrade prices).

## Gutter guards, from Jo's real lineup

This matches how Jo already sells. His hand-built proposals say "same gutter, same downspouts — the only variable is what goes on top".

| Leaf protection (pick one) | Retail | Warranty wording allowed |
|---|---|---|
| Amerimax Lock-In steel mesh (Jo installs) | **$6/LF** (Jo's price) | manufacturer limited warranty only |
| LeafBlaster PRO micromesh (Jo installs) | **$12/LF** (Jo's price) | "40-year limited parts warranty". **Never** "lifetime" or "no-clog" |
| LeafBlaster PRO Frame-Reinforced | price needed (suggest about $15/LF) | same; its warranty excludes excessive snowfall |
| Alu-Rex (installed by a certified sub): Gutter Clean Pro for existing gutters, DoublePro/HoverPro for new ones | price needed | "lifetime clog-free limited warranty" (one transfer; DoublePro/HoverPro include pine areas) |

Jo's base gutter pricing, for context:
- seamless gutter: $12/LF, plus a $5/LF two-story adder;
- downspouts: $250 per drop, with elbows and extensions;
- fascia repair: $25/LF, first 10 LF included.

**Not offered:** Leaf Sentry (dropped by Jo), and dealer-locked systems (LeafFilter, LeafGuard, Gutter Helmet).

## Build order

0. **Honest paperwork, about half a day.**
   - Hide the tier row on templates where it prices nothing, and save "no tier applies".
   - Stop printing "Preferred" and the tier's lifetime-workmanship sentence when that is set.
   - Remove the Close Board copy that promises unpriced gutters, full deck and ice & water.
1. **Gutter installs, cash jobs.**
   - A public upgrade library (retail only, in cents).
   - A small pricing helper covering eligibility, quantities that follow gutter footage, one-per-group, and exact-cent totals.
   - The Upgrades card and the "Show homeowner" page.
   - The V2 reopen fix.
   - Settings → Upgrade prices.
   - Turn the silent apron and drain pre-ticks into upgrades.
   - Tests where the card price equals the printed line equals the change in the total, each break-tested.
2. **Roofing.**
   - A real asphalt ladder, where the tier swaps only shingle, ridge and starter.
   - The Best bundle's extras become upgrades.
   - GAF System Plus and TAMKOShield only when certification allows.
3. **Remaining trades:** ventilation, soffit/fascia, specialty, exterior, and care plans.
4. **Homeowner picks upgrades on the texted estimate link.** The picks lock at signature.
5. **Insurance.** A separate signed homeowner-upgrade addendum. Never inside a claim, and nothing free or discounted on claim jobs (KY KRS 367.628).

## What NOT to do

- Don't put upgrades on the tier buttons, and never make Class 4 an upgrade card.
- No pre-ticks, and no "free", "today only", "limited time" or crossed-out prices.
- Don't sell required or code work (the first ice & water course, drip edge, kickout flashing) as optional; use "Make required".
- Don't give per-square roofs upgrades until their customer paper prints lines. It hides every line today.
- Never publish a cost or margin figure under `docs/`.

## Decisions Jo still owes

1. The Alu-Rex retail price (from the sub's price to NBD).
2. A LeafBlaster PRO Frame-Reinforced price.
3. ~~The workmanship warranty split.~~ **Decided by Jo, 2026-09-25:** 5 years on new gutter systems, 2 years on guard-only installs, 2 years on every other install. Repairs get a per-estimate 1-year box that starts off, because "some repairs won't get any depending on severity". Roofing keeps its current wording. Built in slice 0 ([PR #1758](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1758)).
4. Later: OK to make the asphalt "Best" template = Class 4 shingle only, with its other extras as upgrades? (Its default price drops a lot.)
5. **Added 2026-09-25 (slice 0 review).** Should a roof plus a **new gutter system** on one estimate also print the gutter's own sentence ("5-year workmanship warranty on Seamless K5…")? Today the roofing wording covers the whole estimate, so the gutters read as lifetime. The roofing sentence itself stays byte-identical either way. (A roof plus a **repair** no longer shows the 1-year box, because it changed nothing there.)
6. **Added 2026-09-25 (slice 0 review, for slice 2).** A new roofing *template* estimate saves no tier. So the portal, the estimate chips and the customer PDF "Tier:" line show none. Its proposal, contract and certificates still print "Preferred: Lifetime Workmanship", because roofing wording stays byte-identical. Nothing false prints, but the two surfaces disagree. The asphalt ladder in slice 2 should settle which label a roof template gets.
7. **Added 2026-09-25 (review of the card lane, [PR #1763](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1763)).** On a job lifted to its **minimum charge**, the pricing core re-applies the floor to the whole job, so an upgrade first fills the gap up to the minimum. Example: a $400-minimum reseal plus 10 ft of Amerimax ($60) stays at $400. The card and the homeowner page now say so. Should upgrades instead stack on top of the floored figure, so the total always moves by the quoted price? No default template is floored today; a rep gets there by unticking lines.

## Rules settled in review (2026-09-25, PR #1763)

- **"Make required" on a pick-one option makes the whole group base scope.** The homeowner page offers none of that group, the same rule the pricing core applies when a template's own scope already carries a guard. Before this, a homeowner's "Add" on a sibling guard silently swapped the rep's required guard out, and the total moved by the price difference instead of the card price. On the rep's card a sibling tap, None, or un-ticking the required item is refused on that row; only its own "✓ Required" button releases it. The saved log leaves the group's other options out, because they were never the homeowner's choice.
- **Totals print their cents.** Upgrade tax lands in exact cents on top of the $25-rounded engine total. So the V2 Retail Quote (PROJECT TOTAL, Deposit, Balance), the V2 running total, the portal total and the estimate view now print cents when a total has them. Whole dollars print as before.
- **V2 says when upgrades are out of the price.** That happens on an insurance claim, on a per-SQ quote the per-SQ pricing really applies to, and when the scope is empty. The scope list and the Selected list say so. A save logs such items as `removed` (with `removedFrom`) instead of leaving `chosen` for a line the estimate lacks.
- **Refusals show where the rep is looking.** The toast layer sits under the Job Templates modal, so refusals appear inline instead: Create estimate, the third star, and Show homeowner.

## Update 2026-09-25: Settings → Upgrade prices (stage 2, lane "prices")

Built. Owners and company admins price upgrades in **Settings → Estimates → Upgrade prices**.

- **Where prices live.** `companyProfile/{companyId}.pricing.upgradePrices`, next to `addonPrices`. There is one entry per library item: `{ cents, enabled, installerName }`. `installerName` is kept on certified-sub items only. Writes go through `_saveCompanyProfile`, and the existing firestore.rules gate covers them (owner or company_admin), so no rules change was needed.
- **Dollars to cents.** The panel converts the typed digits, never `parseFloat × 100`. It refuses $0, more than two decimals, a comma used as a decimal point ("6,50"), a space inside the number ("6 50" used to save as $650.00) and anything over `NBDUpgrades.MAX_UNIT_CENTS`.
- **Only what changed is written** (review of PR #1762). The panel is painted from `window._companyProfile`, which loads once at boot with no live listener. So both its Save and Save All write only the entries edited on this device since the paint (`changedEntries`), each as a whole entry through the merge write. A desktop painted at 9:00 can no longer put back, at 11:00, a price the phone saved at 10:00. An untouched panel adds nothing to Save All, and pressing Save with nothing changed says "No changes to save."
- **Off keeps the price.** "Set a price" marks a needs_price item. That item is offered only once it has a saved price.
- **Reaching the builder.** `NBDUpgrades.offeredFor` and `price` read the saved map when `tenantOverrides` is **undefined or null**. Pass `{}` to price from the library alone. A per-item installer name saved here wins over `ctx.tenant.certifiedInstallerName`.
- **Hydration guard.** Before the company profile loads, the panel shows a loading line and its Save refuses. Save All leaves upgrade prices out until then. After that it carries this device's edits, so an edit is never silently dropped. The panel also *asks* for the profile read (`_loadCompanyProfile`) instead of only waiting for it. On desktop 1280 the boot read gave up on a cold Firestore channel ("client is offline") and nothing retried it, on main too, so the panel sat on "Loading…". My Jurisdictions and the county inputs share that boot read and, outside this panel, still have no retry of their own.
- **Late bundle.** The upgrade files are the last entries of the lazy estimates bundle. If the tab paints before they arrive, the panel keeps its static loading line and paints once the bundle lands. If the module never arrives, it says "Upgrade prices could not load" and Save stays off.
- **Card lane contract.** A `null` `tenantOverrides` means "the saved Settings", not "the library alone". The card lane's current branch passes `null` from a `companyProfile.upgrades.prices` read that nothing writes. It should pass `window._companyProfile.pricing.upgradePrices` explicitly and drop that dead read. **Done 2026-09-25 in [PR #1763](https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/pull/1763):** `JobTemplates` `tenantUpgradeSettings()` now passes that map explicitly (`{}` when none is saved), and the per-item `installerName` names the installer.
- **Tests.** Unit: `tests/upgrade-price-settings.test.js`. E2E: `tests/e2e/phone-views.spec.js` "Settings upgrade prices". The E2E runs at 412 and 360 plus the forced installed-app cascade, does a real save, reloads, and checks the Firestore doc.

## Related

- [NEXT_SESSION-2026-09-25](NEXT_SESSION-2026-09-25.md): the session this came from.
- [phone-audit-2026-09-25](../qa/phone-audit-2026-09-25.md): the same session's phone audit.
