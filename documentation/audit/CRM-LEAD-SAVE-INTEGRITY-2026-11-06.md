# Edit Lead save no longer erases stored data — 2026-11-06

From the 2026-11-06 full CRM audit (findings PL-F01, PL-F02, PL-F06; scorecard on the
`crm/2026-11-06-tooling` branch, `overnight/crm/SCORECARD.md`).

## What was wrong
- **PL-F01 (P0).** `saveLead()` in `docs/pro/js/crm-leads.js` always sent `yearBuilt`, `marketValue`,
  `lastSaleDate`, `lastSaleAmt`, `propertyType`, `parcelId` (null), `isLLC` / `homestead` (false), `parcel`
  (null) and `d2dKnockId` (null). They come from `window._modalIntel` / `window._pendingD2DConvertId`, which are
  only set by a Pull Property Intel lookup or a D2D conversion in the same modal session. `_saveLead` spreads the
  payload into `updateDoc`, so every ordinary edit wiped the stored property intel, the parcel polygon (photo
  slope inference) and the door-knock link (rep revenue credit in `analytics-kpi.js`).
- **PL-F02 (P0).** Sources written by the server or other flows (`Website — Contact form`,
  `Website — Inspection / Storm tool`, `Website — Instant Estimate`, `Phone call`) are not options in the
  `#lSource` select. Edit Lead showed it blank and saved `source: ''`, which also drops the lead out of its
  funnel in Lead Source ROI.
- **PL-F06 (P1).** Dismissing the lead modal after a D2D "Edit First" left `_pendingD2DConvertId` armed; the next
  lead saved got that knock and the knock was marked converted to the wrong lead.

## The fix
- Omit-when-unknown for the intel, parcel and knock keys (the rule `trades` and `stage` already follow).
- `editLead` adds the lead's own stored source as an extra option (marked `data-nbd-stored`) when the select has
  none for it; `_leadModalReset` removes it. The source vocabulary is unchanged.
- `_leadModalReset` clears `_pendingD2DConvertId`, like the pending map pin.

## Proof
- `tests/edit-lead-keeps-stored-fields-2026-11-06.test.js` runs the real `crm-leads.js` in a vm: 12/12 on the
  fix; against main the five data-loss / stale-knock assertions fail and the positive controls pass.
- Local harness (`scripts/audit/harness.js`, two synthetic tenants): stored source "Website — Contact form" +
  yearBuilt / parcelId / parcel / d2dKnockId on a seeded lead, open Edit Lead, Save with no changes, read back.
  main: source `""`, all four fields null. Fix: all kept.
