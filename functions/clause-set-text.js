/**
 * clause-set-text.js: the WORDING of the clause set v1 (phase 2, 2026-11-18). Draft text for attorney review,
 * copied verbatim from documentation/projects/ATTORNEY-REVIEW-PACKET-2026-11-18.md section 3; this file is the
 * one place it lives, so an edit is a one-file change (then copy it to functions/, byte-identical). Numbers are
 * {{cfg:field}} tokens (company profile paymentTerms), money is {{cfg$:field}}; job facts keep the packet names.
 * Text only: the logic is clause-set.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NBDClauseText = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  var CLAUSES = {
    "PARTY-1": {
      "version": 1,
      "title": "Parties",
      "prints": "all",
      "parts": [
        {
          "text": "**Parties.** This contract is between **No Big Deal Solutions LLC, a Kentucky limited liability company, doing business as No Big Deal Home Solutions** (\"NBD\" or \"Contractor\"), and {{owner name(s)}} (\"you\" or \"Homeowner\"), the owner(s) of the property at {{property address}}. Contract date: {{date}}. NBD accepts this contract by signing it or by starting the work.",
          "only": "nbd"
        },
        {
          "only": "tenant",
          "text": "**Parties.** This contract is between **{{entity}}** (\"Contractor\"), and {{owner name(s)}} (\"you\" or \"Homeowner\"), the owner(s) of the property at {{property address}}. Contract date: {{date}}. Contractor accepts this contract by signing it or by starting the work."
        }
      ]
    },
    "LIEN-1": {
      "version": 1,
      "title": "Mechanic's lien",
      "prints": "non_ky",
      "parts": [
        {
          "text": "**Mechanic's lien.** Ohio law lets a contractor, subcontractor or material supplier who has not been paid file a mechanic's lien against the property where the work was done. Nothing in this contract gives up NBD's right to do that. NBD will pay the subcontractors and suppliers it uses on your job. On your written request, NBD will give you (or your lender) a written statement of who has furnished labor or materials and that they have been paid or will be paid from your payments."
        }
      ]
    },
    "LIEN-2": {
      "version": 1,
      "title": "Mechanic's lien",
      "prints": "ky_noins",
      "parts": [
        {
          "text": "**Mechanic's lien.** Kentucky law lets a contractor who has not been paid file a lien statement with the county clerk where the property is located, and requires NBD to mail you a copy. Nothing in this contract gives up that right. NBD will pay its subcontractors and suppliers for work on your job and, on your written request, will tell you in writing who has furnished labor or materials."
        }
      ]
    },
    "LIEN-4": {
      "version": 1,
      "title": "About the property",
      "prints": "all",
      "parts": [
        {
          "text": "**About the property.** You confirm that you are the owner of the property (or have the owner's written permission), that the address on this contract is correct, and that you will tell NBD if a mortgage lender requires a notice of commencement or any other notice before work starts. You will tell NBD in writing if the property is sold or refinanced before the work is paid for."
        }
      ]
    },
    "LIEN-5": {
      "version": 1,
      "title": "Release after payment",
      "prints": "all",
      "parts": [
        {
          "text": "After NBD has been paid in full, NBD will release any lien it filed within the time the law requires."
        }
      ]
    },
    "PAY-1": {
      "version": 1,
      "title": "Price",
      "prints": "all",
      "parts": [
        {
          "text": "**Price.** The contract price is the price on the signed estimate for the work listed on it. It includes the labor, materials, permits and disposal listed there. Anything not listed is not included, and a written change order is needed to add it."
        }
      ]
    },
    "PAY-3": {
      "version": 1,
      "title": "Progress payments",
      "prints": "milestones",
      "parts": [
        {
          "text": "Payments are due at these milestones: {{milestone 1 label and percent}}, {{milestone 2}}, {{milestone 3}}. Each milestone is invoiced when it is reached and is due {{cfg:finalPaymentDays}} days after the invoice."
        }
      ]
    },
    "PAY-4": {
      "version": 1,
      "title": "Completion and final payment",
      "prints": "all",
      "parts": [
        {
          "text": "**Completion and final payment.** The work is complete when the work in the contract is finished and NBD has offered you a walkthrough. The final payment is due within {{cfg:finalPaymentDays}} days after NBD sends you the final invoice. If you find items that still need attention, tell NBD in writing within {{cfg:punchListDays}} days of the walkthrough; NBD will fix them, and the amount for those listed items, and only those, may be held back until they are done. The rest is due."
        },
        {
          "text": "Any amount your insurer has not yet released is due when the insurer releases it and is not overdue before then.",
          "only": "ky_ins"
        }
      ]
    },
    "PAY-5": {
      "version": 1,
      "title": "Disputed amounts",
      "prints": "all",
      "parts": [
        {
          "text": "If you dispute part of an invoice, tell NBD in writing within {{cfg:disputeDays}} days of the invoice date and say what you dispute and why. The part you do not dispute is still due on time."
        }
      ]
    },
    "PAY-6": {
      "version": 1,
      "title": "Payment source and shortfalls",
      "prints": "ins_or_fin",
      "parts": [
        {
          "text": "You may pay from insurance proceeds, your own funds, financing, or a combination. Your insurer's payment schedule does not change what is due under this contract. Amounts your insurer does not pay remain your responsibility, as the law allows."
        },
        {
          "text": "Your lender's terms control your loan. NBD is not your lender.",
          "only": "fin"
        }
      ]
    },
    "PAY-7": {
      "version": 1,
      "title": "Ways to pay",
      "prints": "all",
      "parts": [
        {
          "text": "**Ways to pay with no added fee.** Zelle, check, ACH bank transfer, wire transfer and cash. NBD gives a written receipt for cash. NBD gives wire instructions only when you ask for them, never by text; call NBD at {{company phone}} to verify before sending a wire, because NBD never changes bank details by email or text."
        },
        {
          "text": "**Credit card fee.** If you pay by **credit card** (including a credit card used through Apple Pay, Google Pay or another mobile wallet), NBD adds a credit card fee of {{cfg:cardFeePct}}% of the amount you pay by card, or NBD's actual cost of accepting that payment if that is less. The fee is shown as its own line, with the card total, before you pay, and on your receipt. **Debit and prepaid cards are not charged this fee.** The fee is not charged on a payment made by a method listed above, and is not charged on a Kentucky insurance-paid job. This fee applies only to contracts signed after it was added.",
          "only": "cardfee"
        },
        {
          "text": "**Refunds of card fees.** If a payment you made by card is refunded, the card fee on the refunded part is refunded too.",
          "only": "cardfee"
        },
        {
          "text": "**Returned payments.** If a check, ACH or card payment is returned or reversed, NBD may charge the actual fee its bank charged it, not more than the law allows."
        }
      ]
    },
    "LATE-1": {
      "version": 1,
      "title": "Late payments",
      "prints": "all",
      "parts": [
        {
          "text": "**Late payments.** If an amount is not paid within {{cfg:lateGraceDays}} days after its due date, simple interest at {{cfg:lateInterestPct}}% per year (not compounded) applies to the unpaid amount until it is paid, or at the highest rate the law allows if that is lower. Interest does not apply to an amount you dispute in good faith in writing under PAY-5 until the dispute is resolved, or to an amount your insurer or lender is not yet required to pay."
        }
      ]
    },
    "LATE-3": {
      "version": 1,
      "title": "Costs of enforcing this contract",
      "prints": "all",
      "parts": [
        {
          "text": "**Costs of enforcing this contract.** If either side has to go to court to enforce this contract, the side that prevails recovers its reasonable attorney fees and court costs from the other, as the court decides. If NBD refers an overdue amount to an attorney or collection agency, you will also owe the reasonable fees and costs NBD actually incurred in collecting it."
        },
        {
          "text": "Fees are limited to amounts actually paid or agreed to be paid to an attorney who is not an employee of NBD.",
          "only": "ky"
        }
      ]
    },
    "LATE-4": {
      "version": 1,
      "title": "Contract controls over invoice",
      "prints": "all",
      "parts": [
        {
          "text": "Invoices, reminders and payment links are for convenience. They refer to this contract and do not change it. The late-payment and cost terms that apply to your job are the ones in this contract."
        }
      ]
    },
    "LATE-5": {
      "version": 1,
      "title": "No discounts or rebates",
      "prints": "ins",
      "parts": [
        {
          "text": "NBD does not give any discount, rebate, credit or allowance on your insurance deductible or on any other part of the price because the job is paid by insurance. You pay the full deductible."
        }
      ]
    },
    "LATE-6": {
      "version": 1,
      "title": "Right to pause work",
      "prints": "all",
      "parts": [
        {
          "text": "If a payment that is due is not made within {{cfg:pauseNoticeDays}} days after NBD's written notice, NBD may pause work until it is made. NBD will first make the roof weather-tight. Pausing is not a breach by NBD, and the schedule moves by the length of the pause."
        }
      ]
    },
    "CO-1": {
      "version": 1,
      "title": "Change orders",
      "prints": "all",
      "parts": [
        {
          "text": "Changes to the scope or price are made only by a change order that describes the work, the price change and any effect on the schedule, and that you approve in writing (signature, or an email or text from you that NBD keeps). NBD does not start changed work before approval, except as CO-2 allows to keep the home weather-tight."
        }
      ]
    },
    "CO-2": {
      "version": 1,
      "title": "Hidden conditions and decking",
      "prints": "all",
      "parts": [
        {
          "text": "**Hidden conditions.** Some conditions cannot be seen until the old roof is removed, for example rotted or damaged decking or framing. NBD will photograph what it finds and tell you before replacing anything. Damaged roof decking that needs replacing is charged at {{cfg$:deckingPerSheetCents}} per sheet, like for like, for up to {{cfg:deckingSheetsBeforeChangeOrder}} sheets. If more than {{cfg:deckingSheetsBeforeChangeOrder}} sheets are needed, or other repairs are needed (for example framing), NBD will give you a written change order before doing that work. If the roof would otherwise be left open to the weather and NBD cannot reach you, NBD may do only the minimum needed to make the home weather-tight and will bill that work at the same rate. Code-required upgrades that were not visible before tear-off are handled the same way."
        }
      ]
    },
    "CO-3": {
      "version": 1,
      "title": "Insurance supplements",
      "prints": "ins",
      "parts": [
        {
          "text": "If your insurer approves additional amounts for this job, NBD will send you the supplement and the contract price changes by the approved amount only after you approve it in writing."
        }
      ]
    },
    "SCH-1": {
      "version": 1,
      "title": "Schedule and weather",
      "prints": "all",
      "parts": [
        {
          "text": "Start and finish dates are estimates. Weather, material delivery and conditions found during the work can move them. A delay for these reasons is not a breach, and time is not of the essence. NBD will tell you about material changes to the schedule. NBD will not begin work before the cancellation period ends unless you sign a separate emergency request (CANC-1)."
        }
      ]
    },
    "SCH-2": {
      "version": 1,
      "title": "Access, utilities, interior",
      "prints": "all",
      "parts": [
        {
          "text": "You will give NBD access to the work area, including driveways, attic and utilities (power and water), and will remove vehicles, pets and valuables from areas the work can reach, including items hanging on interior walls and stored in the attic. NBD is not responsible for loose items that were not removed."
        }
      ]
    },
    "SCH-3": {
      "version": 1,
      "title": "Permits and HOA",
      "prints": "all",
      "parts": [
        {
          "text": "NBD will obtain the building permit where one is required. Your estimate shows whether the permit fee is included in the price or billed separately at cost. If your property is in a homeowners' association, getting any required approval is your responsibility, and NBD is not responsible for fines or removal costs if work was done to an approved design."
        }
      ]
    },
    "MAT-1": {
      "version": 1,
      "title": "Materials, special orders and restocking",
      "prints": "all",
      "parts": [
        {
          "text": "**Materials, special orders and restocking**"
        },
        {
          "text": "**a. Standard materials.** NBD orders materials for your job after the cancellation period has passed and, on Kentucky insurance jobs, after the insurer's coverage decision."
        },
        {
          "text": "**b. Special-order and custom items.** Items made or ordered to your selections (custom-color metal, specialty shingles, skylights, windows, doors, custom flashing) are listed on your estimate. Once ordered, they cannot be returned to the supplier."
        },
        {
          "text": "**c. If you cancel after the cancellation period** and NBD has already ordered or received materials for your job, you owe NBD: (1) the actual cost of special-order items that cannot be returned; (2) for standard stock that NBD returns, a restocking fee equal to the lesser of {{cfg:restockPct}}% of the price NBD paid for the materials returned or the supplier's actual restocking charge, plus the actual delivery and pickup cost NBD pays to send them back; and (3) the cost of work already done, at the contract rate. NBD will give you the supplier invoices on request and will credit you for anything it can return or reuse without a fee."
        },
        {
          "text": "**d. Cancellation inside the cancellation period.** If you cancel within the cancellation period shown in your Notice of Right to Cancel, none of (c) applies and your deposit is refunded as the notice says."
        },
        {
          "text": "**e. Leftover materials.** Leftover materials from your job belong to NBD, except special-order items you have paid for in full, which belong to you."
        },
        {
          "text": "**f. Delivery and storage.** If materials are delivered and the job is delayed more than 14 days because you are not ready (access, association approval, payment due), NBD may bill the actual storage or re-delivery cost."
        }
      ]
    },
    "INS-2": {
      "version": 1,
      "title": "Deductible",
      "prints": "ins",
      "parts": [
        {
          "text": "The insurance deductible is your responsibility. NBD does not waive, reduce or absorb it."
        }
      ]
    },
    "INS-5": {
      "version": 1,
      "title": "No assignment of benefits",
      "prints": "ky_ins",
      "parts": [
        {
          "text": "You are not assigning any part of your insurance policy or claim to NBD. You may ask your insurer to include NBD as a payee; that is a direction to pay, not an assignment."
        }
      ]
    },
    "WAR-1": {
      "version": 1,
      "title": "Warranty scope",
      "prints": "all",
      "parts": [
        {
          "text": "NBD's written workmanship warranty covers defects in installation labor for the period shown for your package. It does not cover materials; the manufacturer's warranty does."
        }
      ]
    },
    "WAR-2": {
      "version": 1,
      "title": "Warranty exclusions",
      "prints": "all",
      "parts": [
        {
          "text": "The warranty does not cover damage caused by: storms, hail, wind or other acts of nature; ice or water from causes outside the work NBD did; lack of normal maintenance; changes, repairs or installations by anyone other than NBD (including solar, satellite, antenna or HVAC work); pre-existing conditions or structure outside the contract scope; foot traffic or impact; materials you supplied; or non-payment of the contract price."
        }
      ]
    },
    "WAR-3": {
      "version": 1,
      "title": "Warranty conditions and claims",
      "prints": "all",
      "parts": [
        {
          "text": "To make a claim, tell NBD in writing (email, text or the customer portal) within {{cfg:claimNoticeDays}} days of finding the problem, protect the home from further damage (for example with a tarp), and give NBD access to inspect. NBD will inspect and, if the problem is covered, repair it or replace the defective work at its option. This warranty is in effect only when the contract price has been paid in full."
        }
      ]
    },
    "WAR-5": {
      "version": 1,
      "title": "Manufacturer warranty",
      "prints": "all",
      "parts": [
        {
          "text": "Manufacturer warranties are provided by the manufacturer on its own terms and are separate from NBD's workmanship warranty."
        }
      ]
    },
    "WAR-6": {
      "version": 1,
      "title": "NBD Pledge",
      "prints": "all",
      "parts": [
        {
          "text": "**NBD Pledge.** Separate from the written warranty above, NBD will come back and diagnose any roofing problem you tell it about for as long as you own the home and NBD is in business, and will quote the fix fairly. The Pledge is a service commitment, not a warranty, and it does not promise free repairs."
        }
      ]
    },
    "WAR-7": {
      "version": 1,
      "title": "Other warranties",
      "prints": "all",
      "parts": [
        {
          "text": "Except as stated in this contract, NBD gives no other written warranty. This does not take away any warranty or duty that the law does not allow to be disclaimed."
        }
      ]
    },
    "DISP-1": {
      "version": 1,
      "title": "Governing law",
      "prints": "all",
      "parts": [
        {
          "text": "The law of the state where the property is located governs this contract."
        }
      ]
    },
    "DISP-3": {
      "version": 1,
      "title": "Resolution path",
      "prints": "all",
      "parts": [
        {
          "text": "If a dispute is not resolved by negotiation, we will try mediation before filing suit, sharing the mediator's fee equally. Either side may file in court to protect a deadline, to record or enforce a lien, or in small claims court."
        }
      ]
    },
    "DISP-4": {
      "version": 1,
      "title": "Venue",
      "prints": "all",
      "parts": [
        {
          "text": "Any court case will be filed in the county where the property is located (or in small claims there)."
        }
      ]
    },
    "DISP-6": {
      "version": 1,
      "title": "Specific limits",
      "prints": "all",
      "parts": [
        {
          "text": "**Specific limits.** NBD is not responsible for loose items, valuables or wall hangings that were not removed after the notice in SCH-2, for materials you supply, or for delay caused by weather, access, association approval or late payment. This does not limit responsibility for personal injury, fraud, a defect in NBD's own work, or anything the law does not allow to be limited."
        }
      ]
    },
    "DISP-8": {
      "version": 1,
      "title": "General",
      "prints": "all",
      "parts": [
        {
          "text": "**General.** This contract is the entire agreement between us and replaces all earlier negotiations, representations or agreements. Changes must be in writing and signed by both of us, or approved under CO-1. If any part of this contract is not enforceable, the rest stays in effect. NBD may assign amounts owed to it; you may not assign this contract without NBD's written consent. A signed change order controls over this contract for the work it describes. Notices to NBD go to the mailing address, email and phone printed on this contract; notices to you go to the address and email on it. This contract may be signed in counterparts and electronically."
        }
      ]
    },
    "SUB-1": {
      "version": 1,
      "title": "Independent subcontractors",
      "prints": "all",
      "parts": [
        {
          "text": "NBD performs this work using independent subcontractors that NBD selects, schedules and pays, with NBD's owner supervising the work. NBD is responsible to you under this contract for the work, including work done by its subcontractors. Subcontractors are not NBD employees. NBD will provide a certificate of insurance on request."
        }
      ]
    },
    "ESIGN-1": {
      "version": 1,
      "title": "Electronic signature and records",
      "prints": "all",
      "parts": [
        {
          "text": "You agree to sign this contract and receive related documents electronically. Your electronic signature has the same effect as a handwritten one. You may ask for a paper copy at no charge, and you may withdraw this consent before signing by telling NBD, in which case NBD will give you paper documents. NBD will give you a signed copy."
        }
      ]
    },
    "ESIGN-2": {
      "version": 1,
      "title": "Job communications",
      "prints": "all",
      "parts": [
        {
          "text": "NBD may contact you by phone, text and email about this job (scheduling, access, invoices). Message and data rates may apply. Reply STOP to opt out."
        }
      ]
    },
    "MEDIA-1": {
      "version": 1,
      "title": "Photos",
      "prints": "all",
      "parts": [
        {
          "text": "NBD takes photos and video of your property for the work record, warranty and any insurance documentation, and uses them for that purpose. [ ] You agree that NBD may publish photos of the finished work without your name or address (optional; check to allow)."
        }
      ]
    }
  };
  // The packet's three milestone placeholders, replaced as one run by the real milestones.
  var MILESTONES = '{{milestone 1 label and percent}}, {{milestone 2}}, {{milestone 3}}';
  return { CLAUSES: CLAUSES, MILESTONES: MILESTONES };
});
