# Ice & water variants billed the whole roof deck — 2026-11-06 (MONEY/LOGIC)

From the 2026-11-06 full CRM audit (OR-F06 / ED-F03, brief seed #7).

## Root cause
`docs/pro/js/estimate-logic-engine.js` `QTY_BY_CODE` had an eave-band formula for `RFG IWS`
(`max(sq * 0.10, eaveLf * 3 / 100)`) and full coverage for `RFG IWS-FC`, but nothing for `RFG IWS-HT`,
`RFG IWS-TAMKO` or `RFG RNB-MEM`. `inferQtyFormula` then fell through to `QTY_BY_SUB['underlayment'] = 'sq'` —
the whole deck. The Best asphalt template (`jt_fr_asphalt_best`) has a separate whole-deck underlayment slot AND
an ice & water slot that defaults to `RFG IWS-HT` (brand option `RFG IWS`), so the default double-covered the
deck, and toggling that slot's brand moved the quantity ~10x. Also affected (formula-driven lines, each beside a
separate whole-deck underlayment): `jt_fr_tamko_hailguard`, `jt_sp_standing_seam_full`, `jt_sp_exposed_fastener_metal`
and the line-item TAMKO preset (estimate-v2-ui.js). Templates that give these codes a fixed `qty`
(`jt_sp_porch_metal_accent`, `jt_se_ice_dam_retrofit`) use the override and are unaffected. The catalog's own reason text for IWS-HT: valleys and penetrations.

## Fix
Explicit `QTY_BY_CODE` entries for the three codes with the `RFG IWS` formula. `RFG IWS-FC` stays `sq`.
On a synthetic 20.3 SQ roof with 120 LF of eave: 20.3 SQ → 3.6 SQ for each of the three.

## Guard
`tests/estimate-iws-qty-2026-11-06.test.js` (written first; red on main) also asserts that every catalog ice &
water / ice barrier code that is not full coverage has an explicit entry, so a new variant can't fall through.

## Verifier (fresh eyes, 2026-11-06): APPROVE WITH NOTES
Reproduced 20.3 → 3.6 SQ on main vs fix; parsed all 107 templates — no template uses these codes as its only
underlayment (so no under-billing); nothing else consumes QTY_BY_CODE. Notes acted on: template list corrected
above; the guard now also keys on the catalog tags. Notes left for Jo: the legacy tier estimator
(estimates.js) uses a 6 ft eave band while this engine uses 3 ft — the RFG IWS reason text (24 in inside the
wall) suggests ~6 ft with an overhang; and RFG IWS-TAMKO has no LABOR_BY_CODE entry. Both predate this PR.

## Not changed (deliberately)
Brief seed #6 (tear-off × layers): TO1 / TO2 / TO3 are separately priced codes, so `sq * tearOffLayers` would
double-charge; the Layers select doing nothing on the line-item path is a NEEDS_JOE item. Other mismatched
fall-throughs (gutter end caps / hangers per LF, interior drywall / paint by roof area) are separate items.
