# Field-to-estimate queue: recon (2026-10-22)

Recon only, no product change. Three items were handed over as "inert stub / built but untested / needs an audit". Each shrank on contact with `origin/main`. Read this before building any of them.

## 1. Measurement adapter: it is not an inert stub

The brief said `NBD_MEASUREMENT_PROVIDER` is inert with stub secrets. That was true in April and fixed in September; the memory note and several docs still carry the old state.

**What is wired (verified in code, 2026-10-22):**

| Piece | Where | State |
|---|---|---|
| Default provider | `functions/integrations/_shared.js:95` | `instantroofer` when the env var is unset; any unknown value throws instead of billing |
| Instant Roofer AI measure | `measurement.js` → `requestInstantRoofer`; logic in `instantroofer-logic.js` | live since 2026-09-06 (PRs 1420/1424/1425), key set |
| Google Solar adapter | `solar-measure.js`, `NBD_MEASUREMENT_PROVIDER=solar\|auto` | built (#2164), **off**; needs `SOLAR_API_KEY` and the env value |
| Rep path | V2 "Auto-measure" → `NBDIntegrations.requestMeasurement` → `applyMeasurementResult` (`estimate-v2-ui.js:2037`, `:2164`) | fills area, pitch, storeys (only while untouched), LF where the vendor supplies it; adds the $75 pass-through line |
| V3 wizard | tags the same `#v2measureBtn` / `#v2rawSqft` / `#v2pitch` rows onto the Measure step | works through V2's code |
| D2D | "Order precise roof report" → `orderRoofReport` | wired |
| Public leads | `measureNewWebLead` (`public-measure.js`), 25/day cap, off-switch `feature_flags/global.webLeadMeasureDisabled` | live |
| Auto-order on appointment/Inspected | `measure-auto-order.js` (FIELD-PHOTOS-2026-10-04) | live, capped |
| Cross-check | Draw tool `draw-measure-check.js` compares drawn area to the vendor number | live |
| Compare harness | `scripts/measure-compare.js` | exists; **spends** (runs both providers on known roofs) |

So a measurement already feeds an estimate end to end. The remaining gap is a decision, not plumbing.

**Per-call cost (vendor numbers, none of them called by this session):**

- Instant Roofer AI: about $3 per address; Human Certified Report about $10 and ~1 h. Sandbox credits: 10 AI + 1 human (see [INSTANTROOFER-SETUP](../runbooks/INSTANTROOFER-SETUP.md)). Account limit 5 req/min, 100/day.
- Google Solar `buildingInsights:findClosest`: Google's pricing page lists Building Insights under Essentials, first 10,000 requests a month free, then $10 per 1,000 ([pricing page](https://developers.google.com/maps/billing-and-pricing/pricing)). That is about $0.01 a call against $3. **Verify the live SKU before relying on it** (the code comment says the same). Solar returns plane geometry, not ridge/hip/valley LF, and flags complex roofs for a manual check.
- Spend at today's volume (20+ rep measures a month plus one per public estimate lead, capped 25/day): Instant Roofer is the whole bill. `auto` mode would cut it by roughly the share of roofs Solar answers with HIGH imagery.

**Risk if `auto` is switched on:** a satellite number becomes a price. Solar can pick the neighbour's house (guarded by a centre-distance flag), and LOW or old imagery gets flagged but still returned in `solar` mode. `auto` falls back to Instant Roofer on LOW, which is the safer value. The accuracy guard and the 40/day cap are in `solar-measure.js`.

**What Jo decides (nothing here spends):**

1. Whether to create `SOLAR_API_KEY` (restricted to `solar.googleapis.com`) and run `scripts/measure-compare.js` on about ten known roofs. That run costs about $30 of Instant Roofer calls plus pennies of Solar.
2. If the comparison is good, set `NBD_MEASUREMENT_PROVIDER=auto` in `functions/.env.nobigdeal-pro`.

**What this session will not do:** enable a provider, make a paid call, write a secret. Free plumbing candidates, only if a gap shows up when tested: none found yet. The honest result is "nothing to build" until Jo picks.

## 2. Draw tool: built, shipped dark, waiting on one test

State: `docs/pro/js/draw-reticle.js` (1049 lines) ships behind "Crosshair drawing (beta)" in Draw → ☰ Tools. `CROSSHAIR_DEFAULT_ON = false`. Phones only (`pointer: coarse`); desktop keeps click-to-place. Go-live is one line. The money fixes (double facet, chained gutters, rake/valley mapping, drawn gutter LF) shipped in #1818 and earlier.

Tests that exist: `draw-geom.test.js`, `draw-reticle-css-scope.test.js`. Nothing in the repo is a checklist for the daylight test, so here is one.

### Daylight iPhone test (about 30 minutes, outside, on the installed home-screen app)

Set up (2 min): update the app (pull to refresh, then close and reopen it). Draw → ☰ Tools → below Controls → switch on **Crosshair drawing (beta)**. Signing out resets the switch. Pick a real house you can see from where you stand. Brightness at full, in direct sun, with the case you normally use.

Run each of these and write pass or fail, plus a note:

1. **Aim.** Outline mode. Can you see the crosshair and the snap ring in full sun? Can you read the Add / Confirm buttons?
2. **Place, move, confirm.** Add a corner, drag it to the true corner, watch the magnifier. Does the magnifier clear your thumb? Is 4x enough to see the roof edge? Confirm.
3. **Double tap.** Tap Add twice fast. You should get one point, not two.
4. **Close a facet.** Draw a whole roof plane and close it. Is the area what you expect (rough check: length x width)?
5. **Second facet.** Draw a second plane. The first must not double (this was the 1,075 → 2,150 bug). Read the combined total.
6. **Lines.** Add a ridge, a hip, a valley, an eave. Does each type colour correctly and show its feet?
7. **Gutters.** Draw one gutter run, then a second run. The second must start fresh, not chain from the first.
8. **Edit.** Switch to Edit, move a corner. Undo, redo.
9. **Structures.** Add a garage tab, draw it, go back to the house. The house drawing must still be there.
10. **Cross-check.** If a vendor measure exists for the lead, does the Draw tool's cross-check agree within reason?
11. **Generate Estimate.** Do it. Rake lines should land as rake, valleys as valley, drawn gutter feet should price gutters once.
12. **Interruptions.** Lock the phone mid-drawing, switch to another app and back, rotate. Is the drawing still there?
13. **Glare and gloves.** Anything unreadable? Any tap that missed or hit the wrong button?
14. **Fatigue.** After the 30 minutes: would you rather draw this way or tap to place?

Go-live: if items 1 to 9 and 11 pass, set `CROSSHAIR_DEFAULT_ON = true` in `draw-reticle.js` (anyone who explicitly chose Off stays off). Anything that fails goes back as a note with the item number.

Free desktop and phone-viewport checks this session can do are listed in section 4.

## 3. V3 one-thumb estimate wizard: audit still to do

`docs/pro/js/estimate-v3-wizard.js` (764 lines) is a layer over the V2 modal: it tags V2 rows with `data-v3="<step>"` and hides the rest. The Measure step carries the Auto-measure button, the square-footage and pitch fields, and a "Draw it" link into the Draw tool. Full roof: Customer → Measure → Roof lines → Roof details → Penetrations → Package → Shingle & add-ons → Insurance (if insurance) → Photos → Review → Finish. Repairs skip Lines/Details/Package.

Existing coverage: `estimate-v3-wizard-2026-10-02.test.js` (logic only, no layout). The 2026-10-07 [CRM phone audit](../qa/crm-phone-audit-2026-10-07/README.md) covers "Estimate from a lead" (finding 5: full page hop, 10 steps, 13+ taps, the preset asked twice, closing the wizard leaves Jo on the dashboard, not the lead) but not the wizard's inside at 360 and 412.

Audit plan, `step → verify`:

- Emulator harness from the phone-audit README, no functions emulator, callables stubbed (a measurement call is stubbed, never real).
- Walk Customer → Finish at 360×740, 390×844, 412×915 on a full roof and on a repair. For each step record: tap count, taps under 44px, whether the primary action stays above the keyboard when a field has focus, scroll traps (a scrollable region inside the modal that swallows the page scroll), and horizontal overflow.
- Fix what is small and local; each fix gets a test that fails without it.

Status: **walked 2026-10-22, no product fix needed.** `tests/e2e/phone-v3-wizard.spec.js` already drives every step (header counts, a real control on each step, no sideways scroll, Next/Back hit-tested, every control at least 44px, packages priced, Save writes the on-screen total) but only at 390×844. Run on the local emulators with the viewport overridden:

| Viewport | Result |
|---|---|
| 360×740 | 3/3 pass (full roof insurance, full roof cash Per-SQ, repair) |
| 390×844 | 3/3 pass |
| 412×915 | 3/3 pass, after one test fix: the spec hard-coded `844` as the bottom of the screen, which fails any taller phone (a test bug, not a layout bug) |
| 360×560 (keyboard-open height) | the spec's "pitch chip is reachable" hit-test fails because the chip sits below the fold and the test does not scroll; the bar is a flex row under a scrolling body, not `position:fixed`, so it cannot cover a field. Not a product finding |

Change: the spec reads `PHONE_W` / `PHONE_H` (default 390×844) and checks Next against the real viewport height. Not covered: the real iOS keyboard (Chromium cannot show it), so a field being covered while typing is still a Jo-on-iPhone check. Add to the daylight session: on the Measure step tap the area field and confirm it stays visible above the keyboard.

Local-run trap for the next person: `docs/pro/js/nbd-emulator-connect.js` hard-codes the emulator ports (auth 9099, firestore 8080, storage 9199). Sibling sessions hold those ports; a second suite on one machine fails with "Port 8080 is not open". Temporarily point the file and a `--config` copy of `firebase.json` at other ports and revert both before committing.

## 4. Order of work

CI is backed up (queued runs; PRs #2662 to #2668 open and unmerged at 2026-10-23T01:20Z), so no feature PR opens until those drain or CI is clearly healthy. This note is docs-only and is the first PR.

1. This note (docs only).
2. V3 audit and small fixes, one PR per fix.
3. Draw tool: desktop and 360/390 viewport checks with the reticle forced on (a test may fake `pointer: coarse`), fixes if found.
4. Measurement: nothing to build; Jo decides on Solar.
