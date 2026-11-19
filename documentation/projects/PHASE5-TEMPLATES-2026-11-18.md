# Phase 5 templates (2026-11-18/19): five new forms behind `docClauseSetV1`

Plan: [TEMPLATE-DEEP-SWEEP-2026-11-17](TEMPLATE-DEEP-SWEEP-2026-11-17.md) Part 4 (missing templates), Part 5, decisions Q23 and Q73. Wording source: the attorney packet, [ATTORNEY-REVIEW-PACKET-2026-11-18](ATTORNEY-REVIEW-PACKET-2026-11-18.md) section 3, through the clause registry. Builds on [CLAUSE-SET-V1-2026-11-18](CLAUSE-SET-V1-2026-11-18.md) and [ATTIC-ACK-V1-2026-11-18](ATTIC-ACK-V1-2026-11-18.md). Draft text, **attorney review pending**; nothing is in use with customers.

## The flag

`docClauseSetV1` (per person, default OFF, already in `functions/flags-registry.js`). No new flag. With it off: `NBDDocGen.DOCUMENT_TYPES`, the pre-flight schemas (`DocPreflight.DOC_SCHEMAS`) and the Create Document picker are exactly what they were (the picker catalog entries carry `flag:'docClauseSetV1'` and `_orderedDocTemplates` filters on it); the phase 2 golden fixtures pass untouched. `NBDDocGen.syncPhase5Types()` adds or removes the types (at load, on `nbd:flags-loaded`, and when the pre-flight opens), so a person whose flag flips off loses them again.

## What shipped (all five DONE, one commit each)

| Type | Name | Signers | Registry wording printed verbatim | Required recorded ticks |
|---|---|---|---|---|
| `property_condition` | Property Condition & Access Acknowledgment | homeowner + contractor | SCH-2, DISP-6, MEDIA-1 (its first sentence; the optional publish box is left out) | notice + 12 checklist items |
| `decking_authorization` | Hidden Conditions / Decking Authorization | homeowner + contractor | CO-2 (price per sheet from `paymentTerms.deckingPerSheetCents`) | 1 tick + an Approve/Decline pair |
| `emergency_services_request` | Emergency Services Request | **homeowner only** | SCH-1 (names the separate emergency request; CANC-1 by reference) | request + notice received |
| `final_walkthrough` | Final Walkthrough & Punch List | homeowner + contractor | PAY-4 (window = `paymentTerms.punchListDays`) | walked + (items listed OR none), two variants |
| `ohio_insurance_ack` | Ohio Insurance Job Acknowledgment | homeowner + contractor | INS-1 (the shipped payment clause from its no-representation sentence), INS-2, CO-3, INS-5 | one per statement (4) |

All five: NBD document standard styling (the page's own brand block, `h1`, `.section`; the form adds one layout-only `<style>` block with no colours), party block "No Big Deal Solutions LLC d/b/a No Big Deal Home Solutions" for NBD and the tenant's own entity name otherwise (`NBDClauseSet.partyFor`), signature caption "By: Joe Deal, Manager" only for NBD and only where there is a contractor signature, "Contractor" for the tenant in registry text, ticks instead of initials (the phase 3 `data-nbd-ack` controls), photos by id (a thumbnail when a URL is known, else "Photo on file (id)"), money in cents.

**Decking:** unset or $0 `deckingPerSheetCents` prints `{{deckingPerSheetCents}}` and the send check refuses (a tenant never inherits NBD's number). More sheets than `deckingSheetsBeforeChangeOrder` prints `[Needs A Change Order]` and refuses: CO-2 itself says that case needs a written change order. **Emergency:** Ohio (and an unreadable state, the stricter reading) prints the by-hand-and-date instruction, Kentucky its own line; a blank date line is printed for a paper copy. Nothing is stated beyond the law memo ([KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13](../audit/KY-OH-CONTRACTOR-LAW-RESEARCH-2026-10-13.md): Ohio, separate handwritten dated signed request, ORC 1345.21; Kentucky, KRS 367.420). **Ohio insurance:** a Kentucky or unreadable-state property is refused (`ohioOnly` gap, client and server) with a message pointing to the Kentucky notices and forms; no statutory text is retyped.

## How each is used

Customer page, Create Document (flag on) picks the card, the pre-flight collects the fields (property: date and a note per item, photo ids; decking: sheets, where, photo ids; emergency: the work; walkthrough: dates and one open item per line, `text | 150` for the dollar amount held, blank = none; Ohio: carrier and claim number), the homeowner signs in person on the canvas or by the remote link, ticking each box. A blank name or address, a leftover `[Placeholder]` or `{{token}}`, or an unset Company Profile number refuses the send (client in `_docSendGate`, server in `createSignRequest` and the in-person path, from `functions/doc-send-checks.js`).

## Server

`functions/p5-forms.js` (twin of `docs/pro/js/p5-forms.js`) holds each form's spec; `functions/attic-gate.js` `verifyManifest` judges a stored copy against it (marker names the type and variant, exact required ticks, Yes/No lines, registry fragments and the form's own text present, nothing hidden, no pre-ticked box, the form's style block equals `FORM_CSS`). The remote link (`submitSignature`) and the in-person read-back use it; the result is written to the server-owned `atticAckResult` field with `version: P5_FORMS_V1` and `formType` (so it never counts as an attic form; a dedicated field is a follow-up). `NBDClauseSet.textV1(id, opts)` is new (twin in `functions/`): one clause's text as a form quotes it, no wording changed (`CLAUSE_SET_VERSION` unchanged).

## Drafter wording: attorney to confirm

Every string below is new text in `p5-forms.js` `TEXT` (marked `// DRAFTER WORDING: attorney to confirm`), plain and neutral, no "licensed", no claim-outcome or "we handle your claim" wording, no personal guarantee. The registry wording above is NOT drafter wording.

- `PARTY`: {{contractor}} ("Contractor") and {{owner}} ("Homeowner"), the owner(s) of the property at {{address}}, sign this form.
- `TICK_NOTE`: Tick each box. Your ticks are saved with your signature. (the attic form's line)
- `TICK_NOTE_LINE`: Tick the box and choose Approve or Decline. Your answers are saved with your signature.
- Titles (`NAMES`): the five names in the table above.
- Property condition: `PC_INTRO` Before work starts, we walked the items below with you. Your representative noted what was there. Tick each item to confirm the note is right. `PC_NOTICE` I have read the notice above about access, utilities, and items inside and outside the home. `PC_NOTE_NONE` No note. `PC_PHOTOS` Photos on file:. Twelve item labels: Driveway and walkways; Landscaping, plants and fences near the house; Gutters and downspouts; Satellite dish or antenna; Solar panels; Skylights; Items hanging on interior walls; Items stored in the attic; Interior ceilings (existing cracks and nail pops); Pets; Power and water; Parking for the crew and the dumpster.
- Decking: `DK_INTRO` This form records what was found when the old roof came off, and whether you approve replacing it. `DK_READ` I have read the notice above and seen the photos listed. Labels: Found on; Where; Sheets to replace; Price per sheet; Total for these sheets; Photos on file:. `DK_YES` Approve replacing these sheets at the price shown. `DK_NO` Decline.
- Emergency: `EM_INTRO` This is a separate request. It is not part of your contract or your Notice of Right to Cancel. `EM_WORK_H` Work I am asking for. `EM_REQUEST` I am asking the Contractor to start the work described above now, before the cancellation period ends, to protect my home from the weather. `EM_NOTICE` I received the Notice of Right to Cancel. `EM_OH` Ohio property: sign this request by hand and write the date yourself. `EM_KY` Kentucky property: sign and date this request. `EM_PAPER` If you sign on paper, write the date here:
- Walkthrough: `FW_INTRO` We walked the finished job with you. This form records the dates and any open items. Labels: Completion date; Walkthrough date; Open items; Amount held for the listed items. `FW_WALKED` I walked the finished job with the Contractor's representative. `FW_NO_ITEMS` There are no open items. `FW_ITEMS_LISTED` The items listed above are all of the open items.
- Ohio insurance: `OI_INTRO` Your roof work may be paid by your insurance company. Read each statement below and tick it. Labels: Your insurance company; Your claim number.
- Rep-facing only (never on the customer's copy): the pre-flight titles, subtitles and field labels in `doc-preflight.js`, the picker card names and descriptions, and the send-check message for `ohioOnly`.

## What the attorney must confirm

1. Ticks plus signature instead of the packet's "initials" (the phase 3 deviation, same mechanism).
2. Emergency request (packet question 9): is a separate request acceptable for tarp or dry-in; does a drawn signature on a phone or tablet satisfy Ohio's "handwritten"; what else the request must say (the form says only what is listed above); whether the paper date line is enough where the signature is on screen. Kentucky: whether KRS 367.420(5) needs anything more than the dated request. The Kentucky variant adds no "by hand" line because the memo does not say Kentucky requires it. Unresearched, so "attorney to confirm".
3. INS-1 as printed here is the payment clause's last sentence ("This contract does not transfer ... on any insurance claim"); the first sentence ("according to the payment schedule above") is left out because there is no schedule on this form. Is quoting the sentence alone acceptable, and does "This contract" read correctly on a separate acknowledgment?
4. Decking: what happens if the homeowner declines (the form records the answer and prints nothing about consequences); whether a text-message approval is wanted (not built; the plan mentioned "approve-by-text").
5. Final walkthrough: the amount held back is rep-entered per item and shown; PAY-4's "only those" limit is the registry's.
6. MEDIA-1: only its first sentence prints on the property form.
7. Every drafter string above.

## Limits and not verified

- **No browser check.** The renderers, signing flows and server paths are tested through the real generator and the real `submitSignature` and in-person code with fakes. Not looked at: the phone layout of the viewer (the forms use flex rows and a media query, no wide tables), print output, the signature widget refusing an unticked box in a real browser, the picker cards, the pre-flight modal.
- **Photo ids are typed** (comma separated) in the pre-flight; there is no photo picker. Photos on file are by id only.
- **The in-person path proves the rep's device and time**, as for the attic form (`attests: rep_device_and_time_only`); the remote link is where the homeowner's own device signs.
- **Result field:** phase 5 results share `atticAckResult` (rules already make it server-owned). A dedicated field needs a rules change.
- **No signing-packet inclusion** (Q73's default packet order is not changed), no booking text, no estimate-bound gate: these forms gate nothing.
- Tests: [phase5-templates-2026-11-19](../../tests/phase5-templates-2026-11-19.test.js) (client: flag, registry wording, party, ticks, refusals, tenant) and [phase5-templates-server-2026-11-19](../../tests/phase5-templates-server-2026-11-19.test.js) (twins, manifest, tampering, remote link, in-person, server send check).
