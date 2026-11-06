# Ice & water variants billed the whole roof deck — 2026-11-06 (MONEY/LOGIC)

From the 2026-11-06 full CRM audit (OR-F06 / ED-F03, brief seed #7).

## Root cause
`docs/pro/js/estimate-logic-engine.js` `QTY_BY_CODE` had an eave-band formula for `RFG IWS`
(`max(sq * 0.10, eaveLf * 3 / 100)`) and full coverage for `RFG IWS-FC`, but nothing for `RFG IWS-HT`,
`RFG IWS-TAMKO` or `RFG RNB-MEM`. `inferQtyFormula` then fell through to `QTY_BY_SUB['underlayment'] = 'sq'` —
the whole deck. The Best asphalt template (`jt_fr_asphalt_best`) has a separate whole-deck underlayment slot AND
an ice & water slot that defaults to `RFG IWS-HT` (brand option `RFG IWS`), so the default double-covered the
deck, and toggling that slot's brand moved the quantity ~10x. Also in `jt_sp_standing_seam_full` and
`jt_se_ice_dam_retrofit`. The catalog's own reason text for IWS-HT: valleys and penetrations.

## Fix
Explicit `QTY_BY_CODE` entries for the three codes with the `RFG IWS` formula. `RFG IWS-FC` stays `sq`.
On a synthetic 20.3 SQ roof with 120 LF of eave: 20.3 SQ → 3.6 SQ for each of the three.

## Guard
`tests/estimate-iws-qty-2026-11-06.test.js` (written first; red on main) also asserts that every catalog ice &
water / ice barrier code that is not full coverage has an explicit entry, so a new variant can't fall through.

## Not changed (deliberately)
Brief seed #6 (tear-off × layers): TO1 / TO2 / TO3 are separately priced codes, so `sq * tearOffLayers` would
double-charge; the Layers select doing nothing on the line-item path is a NEEDS_JOE item. Other mismatched
fall-throughs (gutter end caps / hangers per LF, interior drywall / paint by roof area) are separate items.
