/**
 * attic-ack-text.js - the wording of the Attic, Ventilation & Moisture Acknowledgment (ATTIC_ACK_V1), phase 3.
 *
 * COPIED BY SCRIPT from the attorney packet (documentation/projects/ATTORNEY-REVIEW-PACKET-2026-11-18.md,
 * section 3, ATTIC-1 to ATTIC-5), never retyped; tests/attic-ack-v1-2026-11-18.test.js compares every
 * string to tests/fixtures/attorney-packet-2026-11-18.md. DRAFT TEXT, attorney review pending: nothing is
 * in use with customers. {{...}} are the packet's own fill-in slots; numbers come from Company Profile
 * paymentTerms (attic-ack.js). ONE MODULE, TWO COPIES: docs/pro/js/attic-ack-text.js and functions/attic-ack-text.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDAtticAckText = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  return {
    "VERSION": "ATTIC_ACK_V1",
    "WHY": [
      "**Why we check your attic before a new roof.** Your attic needs air moving through it all year. Air comes in low (at the soffits or eaves, called **intake**) and goes out high (at the ridge or roof vents, called **exhaust**). When that air flow is short, heat builds up in summer and moisture from the house condenses on the underside of the roof in winter. Over time that can lead to damp insulation, rotted roof decking, mold or mildew, ice dams, and shingles that wear out early. Moisture from inside the house (showers, cooking, laundry, breathing) rises into the attic, so bathroom, kitchen and dryer fans should vent outside the house, not into the attic.",
      "Common guidance is about 1 square foot of vent opening for every 300 square feet of attic floor, split about half intake and half exhaust, with exhaust at least 3 feet higher than intake. Some codes and attics call for 1 per 150. Intake should be at least as much as exhaust. A new roof does not fix moisture that comes from inside the house. If there is a moisture source (an unvented fan, a plumbing leak, air leaks from the living space, a humidifier), the problem can return under a new roof."
    ],
    "PICK_ONE": "Representative completes one box:",
    "INSPECTED": "**We inspected the attic** on {{date}} from {{access point: hatch / pull-down stair / other}}. This was a visual check from the access point and walkable areas only. We did not move insulation or stored items, open walls or ceilings, or test anything.",
    "NOT_INSPECTED": "**We did not inspect the attic.** Complete ATTIC-5.",
    "SAW_INTRO": "**What we saw** (each checked box has a photo):",
    "CONDITIONS": [
      "No visible concerns from the access point.",
      "Dark staining or growth on the roof decking or framing **that may be mold or mildew**. We did not test it and cannot tell you what it is.",
      "Water staining on decking, framing or insulation (active or old: [ ] can't tell).",
      "Frost, condensation or damp insulation.",
      "Soft, delaminated, sagging or rotted decking or framing (visible areas only).",
      "Daylight through the roof deck.",
      "Bathroom, kitchen or dryer fan venting into the attic, or a disconnected duct.",
      "Soffit or eave intake blocked by insulation, paint or solid soffit; no baffles.",
      "Little or no intake ventilation.",
      "Mixed exhaust types on the same attic (for example ridge vent plus box vents, turbines or a power fan).",
      "Signs of animals, insects or nests.",
      "Damaged or exposed wiring, HVAC equipment or ductwork in the attic (noted, not inspected).",
      "Other: {{text}}. Notes: {{text}}"
    ],
    "NUMBERS": "**Ventilation numbers (approximate, from what was visible).** Attic floor area {{sq ft}}; rule used [ ] 1/300 [ ] 1/150 [ ] code official's requirement; vent area needed {{sq in net free area}} (intake {{ }} / exhaust {{ }}); estimated vent area now: intake {{ }} / exhaust {{ }}. Shingle manufacturer: {{GAF / TAMKO / other}}. Its warranty conditions on ventilation apply to your roof.",
    "RECS_INTRO": "**Our recommendations and your choices.** Each recommended item prints with its price from your estimate and two initial boxes, **Yes, add it** and **No, leave it out**. Nothing is added to the price without a \"Yes\" initial. Lines with no price in the catalog do not print.",
    "RECS_THIRD_PARTY": [
      "Have a qualified mold or indoor-air professional look at the attic before work starts (you arrange and pay them)",
      "Have an HVAC or insulation contractor check moisture sources and air sealing (you arrange and pay them)"
    ],
    "ACKS": [
      "**What we saw and recommended.** NBD showed me or sent me what it saw (with photos) and what it recommends, and I had the chance to ask questions.",
      "**Items I declined.** I chose not to add the items marked \"No\". I understand that leaving them out may allow heat or moisture problems to continue or come back, may shorten the life of the new roof, and **may affect the shingle manufacturer's warranty**, which has its own ventilation conditions. NBD's workmanship warranty does not cover damage caused by a condition I chose not to correct.",
      "**Existing conditions.** Mold, mildew, moisture damage, rot, and ventilation or moisture problems that existed before NBD started work, including in areas no one could see, are not part of this contract and are not caused by NBD's work. Correcting them is not included in the price unless it is listed in my contract or a signed change order.",
      "**Not a mold, HVAC or home inspection.** NBD's check was a visual look by a roofing contractor. NBD does not test for, identify, or remove mold, and it does not inspect HVAC, electrical, plumbing or insulation systems. If I want those checked, I will hire a qualified professional.",
      "**Moisture from inside the house.** A new roof and vents do not fix moisture coming from inside the house. Keeping fans vented outside, and fixing leaks and indoor humidity, is my responsibility.",
      "**If more is found at tear-off.** If NBD finds rotted decking, framing damage, staining that may be mold, or other hidden conditions after removing the old roof, NBD will photograph them and tell me before doing extra work, as my contract's hidden-conditions section (CO-2) describes. The only exception is the minimum needed to make the home weather-tight that day."
    ],
    "SAVINGS": "**What this form does not do.** Nothing in this form limits NBD's responsibility for the work NBD does, or any right I have that the law does not allow to be given up. If NBD's own work causes a leak or damage, NBD remains responsible under my contract and warranty.",
    "REASONS": [
      "**You chose not to have the attic checked.** NBD offered to look at the attic before your roof is replaced. You declined.",
      "**We could not schedule it.** The attic check did not fit the schedule before the work date. (Whose schedule: [ ] yours [ ] NBD's)",
      "**No access.** There is no attic opening, or it is blocked or sealed (stored items, finished space, locked).",
      "**Not safe to enter.** (for example no flooring, extreme heat, exposed wiring, pests)",
      "**No attic space.** (cathedral or finished ceiling)",
      "Other: {{text}}"
    ],
    "STATEMENTS_HEAD": "**Homeowner initials each:**",
    "STATEMENTS": [
      "**The attic was not checked.** NBD did not inspect my attic before this work, for the reason marked above. The condition of my attic, including its ventilation, insulation, moisture, mold or mildew, and the roof decking from below, is **unknown to NBD and to me**.",
      "**Offered and optional.** I understand a check was available (or would have been scheduled if I had asked) and that I can still ask for one before the work starts, at no charge, by telling NBD at least 3 days before the start date.",
      "**Unseen conditions.** I understand that problems that were not checked may exist, including mold or mildew, moisture damage, rotted decking, or poor ventilation, and that NBD is not responsible for conditions that were already there. If NBD sees any of these when the old roof is removed, NBD will photograph it and tell me before extra work, as my contract's hidden-conditions section explains. The manufacturer's warranty has its own ventilation conditions that I am responsible for knowing.",
      "**What this does not change.** NBD remains responsible for its own work and warranty. This form does not give up any right the law does not allow to be given up."
    ],
    "WARRANTY_LINE": "The warranty does not cover damage caused by moisture, mold, mildew, rot or ventilation conditions that existed before the work, that came from moisture inside the home, or that the homeowner chose on {{form date}} not to correct, as recorded in the signed Attic, Ventilation & Moisture Acknowledgment.",
    "REC_LABELS": [
      "{{ridge vent, N ft}}",
      "{{soffit intake vents / baffles}}",
      "{{remove and cover box vents (no mixed exhaust)}}",
      "{{re-route bath fan duct to a roof or wall cap}}",
      "{{replace decking in visible damaged area, about N sheets}}"
    ]
  };
});
