// ============================================================
// NBD Pro — Decision Engine v2
//
// Category-organized scenarios with pre-loaded Ask Joe AI
// prompts. Locked spec from site_wide_spec_20260410.md §AI Tools:
//
//   Categories: Insurance Claims · Sales & Objections ·
//               Crew & Ops · Pricing
//   Each category: 5-10 specific scenarios with pre-loaded prompts
//
// Each scenario includes:
//   id              — unique slug
//   title           — short name ("Adjuster denied my scope")
//   tagline         — one-line situation description
//   situation       — full paragraph describing the problem
//   priority        — high / medium / low
//   timeToResolve   — minutes / hours / days
//   prompt          — pre-written Ask Joe AI prompt (Joe just
//                     fills in the customer/deal specifics)
//   playbook[]      — numbered step-by-step action checklist
//   codeRefs[]      — building code references where relevant
//   relatedScenarios — other scenarios likely to follow
//
// Exposes window.DecisionEngine with query + render helpers.
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ═════════════════════════════════════════════════════════
  // 1. INSURANCE CLAIMS (10 scenarios)
  // ═════════════════════════════════════════════════════════
  const INSURANCE_CLAIMS = [
    {
      id: 'adjuster-denied-scope',
      title: 'Adjuster denied my scope',
      tagline: 'Full scope denied or flagged as overstated',
      situation: 'Adjuster looked at the damage and denied most or all of the scope. They may be claiming the damage is cosmetic, pre-existing, or below policy threshold.',
      priority: 'high',
      timeToResolve: 'hours',
      prompt: `I have an insurance claim where the adjuster just denied [most/all] of my scope at [property address]. The carrier is [carrier name], claim number [claim #], adjuster is [name]. Their stated reason is: [adjuster reason]. I've already [attached photos/measurements/what you have]. Help me draft a professional reinspection request with:

1. Why their reasoning is factually or procedurally wrong (IICRC / NRCA / OH or KY residential code citations)
2. Specific photo documentation I should reference
3. The exact paragraph I should copy-paste into the reinspection email
4. A suggested timeline with the "squeaky wheel" escalation pattern if they don't respond in 3 business days`,
      playbook: [
        'Document everything: take 40+ photos of every damaged slope with close-ups',
        'Get an independent estimator or HAAG-certified inspector opinion in writing',
        'Write a formal reinspection request citing specific policy language + code',
        'CC the state insurance commissioner on the email (creates paper trail)',
        'Request the adjuster\'s supervisor or a second adjuster if stonewalled',
        'If denied again, escalate to public adjuster or attorney referral'
      ],
      codeRefs: ['OBC R905.2', 'IRC R905.2.4', 'NRCA Damage Assessment Guidelines'],
      relatedScenarios: ['partial-approval', 'supplement-denied', 'reinspection-request']
    },
    {
      id: 'partial-approval',
      title: 'Partial approval — need to supplement',
      tagline: 'Adjuster approved some items, denied others',
      situation: 'Adjuster approved part of the scope but denied specific line items. Classic negotiation setup — most adjusters expect you to push back.',
      priority: 'high',
      timeToResolve: 'hours',
      prompt: `I got a partial approval on an insurance claim. Approved: [list items]. Denied or underbilled: [list items]. Adjuster is [name] at [carrier]. Help me build a supplement package that:

1. Lists each denied/underbilled item with the exact code reference that requires it
2. Provides photo justification for each item
3. Shows the cost delta with OH&P calculations
4. Drafts a professional cover letter for the supplement submission`,
      playbook: [
        'Open the NBD Pro Supplement Builder (from V2 Estimate Builder)',
        'Add denied items one by one with photos + code refs + reasoning',
        'For under-billed items, use "Modify Quantity" to show original vs new qty',
        'Generate the formal Supplement Letter PDF',
        'Submit to adjuster via email (keep email trail)',
        'Mark supplement as "submitted" in the CRM for follow-up tracking'
      ],
      codeRefs: ['OBC R905', 'OBC R903'],
      relatedScenarios: ['adjuster-denied-scope', 'supplement-denied', 'discovered-damage']
    },
    {
      id: 'supplement-denied',
      title: 'Supplement got denied',
      tagline: 'Supplement request came back denied or partial',
      situation: 'You submitted a supplement and the carrier came back denying it or partially approving it. You need to decide whether to push back, accept, or escalate.',
      priority: 'high',
      timeToResolve: 'hours',
      prompt: `My supplement for claim [claim #] with [carrier] came back [denied/partially approved]. Denied items: [list]. Their stated reason: [reason]. Help me:

1. Evaluate whether their denial reason is defensible under OH/KY code + policy
2. Draft a rebuttal email with specific code citations
3. Decide if this is worth escalating to the carrier's supervisor or state insurance commissioner
4. Suggest the exact next step with ROI analysis`,
      playbook: [
        'Review denial reason against OH residential code (OBC) + policy language',
        'Gather additional photo evidence if available',
        'Write a formal rebuttal citing the specific code section',
        'If escalating: email supervisor + CC state insurance commissioner',
        'Track approval rate over time — if a carrier consistently denies fair scopes, consider filing a bad-faith claim'
      ],
      codeRefs: ['OBC R905', 'OBC R903.2', 'OBC R1003.20 (crickets)', 'OBC R806 (ventilation)'],
      relatedScenarios: ['partial-approval', 'bad-faith-claim', 'adjuster-escalation']
    },
    {
      id: 'discovered-damage',
      title: 'Discovered damage during tear-off',
      tagline: 'Crew found damage not visible during inspection',
      situation: 'During the tear-off phase, crew discovered additional damage (rotted decking, failing framing, hidden water damage) that wasn\'t visible during the adjuster inspection.',
      priority: 'high',
      timeToResolve: 'same-day',
      prompt: `My crew just discovered [type of damage] at [property] that wasn\'t visible during the adjuster inspection. I need to file a supplement immediately before we cover it back up. Help me:

1. Write justification text showing this damage was not accessible during original inspection
2. Identify the code reference that requires repair
3. Calculate the supplement cost (material + labor + OH&P)
4. Generate a short urgent email to the adjuster asking for same-day approval with photos attached`,
      playbook: [
        'STOP work on that area — do not cover up the damage',
        'Take 20+ photos from multiple angles with measurements visible',
        'Mark the damage with chalk or tape for scale in photos',
        'Open NBD Pro Supplement Builder, add the item with photos',
        'Email adjuster with photos + supplement letter marked URGENT',
        'Follow up by phone within 2 hours if no email response',
        'Document all attempts to contact in the customer timeline'
      ],
      codeRefs: ['OBC R802 (framing)', 'OBC R803 (sheathing)', 'OBC R905.1 (substrate)'],
      relatedScenarios: ['partial-approval', 'supplement-letter', 'structural-repair']
    },
    {
      id: 'acv-vs-rcv',
      title: 'Customer confused about ACV vs RCV',
      tagline: 'Customer doesn\'t understand the two-check process',
      situation: 'Customer received the ACV check and thinks that\'s all the insurance is paying. They don\'t understand the recoverable depreciation / RCV process.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: `Help me explain ACV vs RCV to a customer named [name] in plain English. Their policy: [carrier, claim #]. ACV amount: [$]. Depreciation: [$]. RCV: [$]. Draft:

1. A simple 3-paragraph explanation they can understand
2. A visual breakdown of the math showing "You get the ACV now, the depreciation after we complete the work"
3. A reassurance paragraph about why this is normal and how NBD handles it`,
      playbook: [
        'Sit down with the customer and the policy declaration',
        'Show them: "You paid for RCV coverage, so insurance owes you full replacement value"',
        'Explain: "ACV is what the roof is worth TODAY. RCV is new. Depreciation is the difference."',
        'Reassure: "We get ACV now to start work. After completion, we submit final invoice and you get depreciation check."',
        // 2026-09-25 (deposit rule, deposit-rule.js): was "the 50/50 deposit
        // structure" — not the insurance rule.
        'Walk them through the signed agreement so they see the payment schedule: deductible at signing, the ACV check as soon as it is released, the balance on completion',
        'Set expectation: "You\'ll get 2 checks from insurance and need to endorse both to us"'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-deductible-waiver', 'two-check-process']
    },
    {
      id: 'customer-deductible-waiver',
      title: 'Customer wants deductible waived',
      tagline: 'Customer asks NBD to "absorb" the deductible',
      situation: 'Customer wants us to waive, discount, or absorb their insurance deductible. This is illegal insurance fraud in most states.',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: `A customer is asking me to waive or absorb their deductible on claim [claim #]. Help me:

1. Explain clearly why this is insurance fraud (OH Revised Code + KY equivalent)
2. Draft a polite but firm response I can text or email
3. Suggest a legitimate alternative (financing or a payment plan for the deductible — never a discount, credit or rebate on an insurance job; KRS 367.628(2) bars them in Kentucky)
4. Document this interaction in the customer record so it\'s traceable`,
      playbook: [
        'Politely but firmly say NO to waiving the deductible',
        'Explain: "That would be insurance fraud and I can lose my license"',
        'Offer alternatives: a payment plan or financing. On an insurance job, no discount, credit, rebate or referral credit against the price — KRS 367.628(2) bars them in Kentucky',
        'Document the conversation in the customer timeline',
        'If they insist, walk away — the risk is not worth it'
      ],
      codeRefs: ['OH Revised Code 2913.47 (Insurance Fraud)', 'KY Revised Statutes 304.47'],
      relatedScenarios: ['customer-wants-to-walk', 'legal-risks']
    },
    {
      id: 'two-check-process',
      title: 'Explaining the two-check process',
      tagline: 'Customer needs to endorse both insurance checks',
      situation: 'Customer is getting 2 checks from insurance (ACV + depreciation) and is confused about why they need to endorse both to NBD.',
      priority: 'low',
      timeToResolve: 'minutes',
      prompt: 'Help me explain the two-check insurance process to a customer in simple terms. Include: why they get 2 checks, why they endorse both to NBD, what happens if the mortgage company is on the check, and what to do if the second check is delayed.',
      playbook: [
        'First check (ACV) comes when adjuster approves scope',
        'Customer endorses to NBD — deposits into our account for material + labor',
        'Second check (depreciation / RCV) comes after we submit final invoice to insurance',
        'If mortgage company is on the check: send to mortgage company, they inspect + release funds',
        'Our signed work order already authorizes this — reference section 4'
      ],
      codeRefs: [],
      relatedScenarios: ['acv-vs-rcv', 'customer-deductible-waiver']
    },
    {
      id: 'mortgage-company-on-check',
      title: 'Mortgage company is on the check',
      tagline: 'Insurance check has mortgage lender as co-payee',
      situation: 'Insurance check is made out to customer AND mortgage lender. Lender has to endorse before we can deposit.',
      priority: 'medium',
      timeToResolve: 'days',
      prompt: 'Help me handle an insurance claim where the mortgage company is on the check. The mortgage lender is [lender name], loan number [#]. Draft a cover letter to the lender explaining the claim, requesting endorsement, and listing the documentation they typically require (W-9, lien waiver, proof of completion, etc.).',
      playbook: [
        'Call the mortgage company\'s loss draft department (ask customer for number)',
        'Request their "claim packet requirements" — usually W-9, lien waiver, proof of completion',
        'Customer signs the check and sends it to the lender with the packet',
        'Lender inspects the work (they may send their own inspector)',
        'Lender releases funds in installments: 1/3 at start, 1/3 mid-work, 1/3 completion',
        'Track each release in the customer timeline',
        'Expect delays of 2-4 weeks per release'
      ],
      codeRefs: [],
      relatedScenarios: ['two-check-process', 'delayed-payment']
    },
    {
      id: 'reinspection-request',
      title: 'Requesting a reinspection',
      tagline: 'Need a second look from the adjuster',
      situation: 'First adjuster inspection missed obvious damage or the adjuster was in a rush. Need to formally request a reinspection.',
      priority: 'medium',
      timeToResolve: 'days',
      prompt: 'Help me draft a formal reinspection request for claim [claim #] with [carrier]. Original adjuster was [name]. Reason for reinspection: [missed damage / inadequate scope / new evidence]. Include: professional tone, specific damage list with photo evidence, citation of code requirements, and request for a different adjuster if possible.',
      playbook: [
        'Gather all photo evidence the original adjuster may have missed',
        'Organize photos by slope with captions describing damage',
        'Write a 1-page reinspection request referencing specific issues',
        'Submit via email with read receipt requested',
        'Follow up in 5 business days if no response',
        'Escalate to carrier supervisor if second adjuster is denied'
      ],
      codeRefs: [],
      relatedScenarios: ['adjuster-denied-scope', 'adjuster-escalation']
    },
    {
      id: 'adjuster-escalation',
      title: 'Escalating past the adjuster',
      tagline: 'Adjuster won\'t budge — need to go over their head',
      situation: 'Adjuster is being unreasonable or unresponsive. Need to escalate to their supervisor, the carrier\'s claim manager, or the state insurance commissioner.',
      priority: 'high',
      timeToResolve: 'days',
      prompt: 'Help me escalate an insurance claim past an unresponsive adjuster. Carrier [name], claim [#], adjuster [name]. Attempts so far: [list]. Draft:\n\n1. Professional escalation email to supervisor\n2. State insurance commissioner complaint template\n3. Decision framework for when to involve a public adjuster or attorney',
      playbook: [
        'Document every attempt to contact the original adjuster (dates, times, methods)',
        'Email the carrier\'s claim manager with the full timeline',
        'If no response in 5 business days, file complaint with state insurance commissioner',
        'OH: insurance.ohio.gov/complaint · KY: insurance.ky.gov/complaint',
        'If claim is significant ($10K+), refer customer to a public adjuster',
        'Keep the customer informed at every step — they need to see you fighting for them'
      ],
      codeRefs: ['OH Revised Code 3901 (Insurance Code)', 'KY Revised Statutes 304'],
      relatedScenarios: ['adjuster-denied-scope', 'bad-faith-claim']
    }
  ];

  // ═════════════════════════════════════════════════════════
  // 2. SALES & OBJECTIONS (10 scenarios)
  // ═════════════════════════════════════════════════════════
  const SALES_OBJECTIONS = [
    {
      id: 'customer-wants-to-wait',
      title: 'Customer wants to wait until spring',
      tagline: 'Roof is damaged but customer wants to delay',
      situation: 'Customer has obvious damage but keeps pushing the decision. Common objection: "Let\'s wait until spring" or "We\'ll deal with it when it rains again."',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: `A customer with [damage type] at [property] is saying they want to wait until spring. They're probably worried about money or are shopping around. Help me:

1. Draft a 3-part conversation script: acknowledge → educate → offer
2. List 5 specific reasons waiting will cost them more (insurance expiration, code changes, material inflation, interior damage, claim denial risk)
3. Offer a specific incentive that creates urgency without feeling pushy
4. Include the "insurance clock" angle — most policies require timely repair`,
      playbook: [
        'Acknowledge their concern: "I understand, that makes sense"',
        'Educate on the risks: hail events have a claim filing deadline (usually 1 year in OH)',
        'Show weather data: "Here\'s the hail event — you have until [date] to file"',
        'Offer financing: "We have zero-down financing for 6 months to bridge you to tax refund"',
        'Mention the manufacturer warranty clock: "Shingle warranty starts today, not when the storm hit"',
        'Final ask: "Can we at least get the claim filed so you preserve your right to act?"',
        'If they still say no: book a follow-up call in 2 weeks'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-shopping-around', 'financing-objection', 'insurance-claim-deadline']
    },
    {
      id: 'customer-shopping-around',
      title: 'Customer is shopping around',
      tagline: '"I want to get a couple more quotes"',
      situation: 'Customer wants to get multiple quotes before deciding. This is normal, but it\'s your chance to pre-emptively handle the comparison.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: `A customer said they want to get more quotes. Help me draft a respectful "shopping around" conversation that:

1. Validates their decision
2. Gives them a framework for evaluating contractors (not just price)
3. Pre-emptively handles the "lowest bid" objection
4. Offers to be the FIRST or LAST quote (both have advantages)
5. Leaves them with a concrete follow-up plan`,
      playbook: [
        'Say: "That\'s smart, I\'d do the same thing. Here\'s what to look for:"',
        'Give them a 5-point checklist: license #, insurance, manufacturer certs, reviews, warranty',
        'Warn about storm chasers: "Out-of-state contractors disappear after the job"',
        'Offer to be LAST quote: "Come back to me after you\'ve seen others — I\'ll match or beat in writing"',
        'If they\'re price-focused: offer a "price match within 10%" guarantee',
        'Close with a specific follow-up date: "I\'ll call you Tuesday — what time works?"'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-wants-to-wait', 'price-objection', 'bid-matching']
    },
    {
      id: 'price-objection',
      title: '"Your price is too high"',
      tagline: 'Direct price pushback',
      situation: 'Customer says the price is too high, often after seeing a competing quote.',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: `A customer said my price is too high compared to [competitor/amount]. Help me:

1. Ask questions to isolate whether it's the overall cost, scope difference, or comparing apples to oranges
2. Draft a scope comparison script showing WHERE the difference is (material tier, labor, warranty, code upgrades)
3. Offer tier alternatives (Good / Better / Best) so they feel in control
4. Handle the "I saw the same work for half the price" objection without bashing the competitor`,
      playbook: [
        'Ask: "Can I see the other estimate so I can make sure we\'re comparing apples to apples?"',
        'Look for gaps: missing ice & water shield, cheaper shingles, no permit, no warranty',
        'Say: "Let me show you exactly what you\'re getting for the difference"',
        'Offer to drop to the "Good" tier to match the competing price (same profit for you)',
        'Warn about too-good-to-be-true prices: "If it sounds too cheap, there\'s a reason"',
        'Use the "3 quotes" rule: "If our number is in the middle of 3 real quotes, we\'re fair"',
        'If they won\'t budge, walk away — don\'t damage your brand chasing low margins'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-shopping-around', 'tier-downsell', 'price-match']
    },
    {
      id: 'spouse-decision',
      title: '"I need to talk to my spouse"',
      tagline: 'Decision-maker stall tactic',
      situation: 'Customer says they need to talk to their spouse before deciding. This is either legitimate or a polite way to decline.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'A customer says they need to talk to their spouse. Help me handle this without being pushy. Draft:\n\n1. A 2-sentence acknowledgment\n2. Questions to understand if the spouse is truly involved or if this is a stall\n3. An offer to explain the work to the spouse directly (phone, text with photos, or second visit)\n4. A specific follow-up commitment',
      playbook: [
        'Acknowledge: "Of course, this is a big decision"',
        'Ask: "Is there anything I can send them right now to help — photos, video, the estimate?"',
        'Offer a spouse call: "I\'d be happy to explain directly if they have questions"',
        'Book the follow-up NOW: "What\'s the best time for me to follow up — tomorrow at 6?"',
        'Send a photo recap text immediately after you leave',
        'If the spouse says no: ask for 5 minutes on the phone to address their specific concern'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-wants-to-wait', 'follow-up-timing']
    },
    {
      id: 'financing-objection',
      title: '"I can\'t afford it right now"',
      tagline: 'Affordability objection',
      situation: 'Customer can\'t afford the out-of-pocket cost or is worried about financing.',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: 'A customer can\'t afford an out-of-pocket roof replacement of [$amount]. Help me walk them through the options: checking real offers through our lending-marketplace partner (soft credit pull, rates and terms set by the lender), tax refund timing, home equity line, or insurance-only path if applicable. Never promise a specific rate or 0% — offers vary by credit profile and lender.',
      playbook: [
        'Understand which scenario: cash job vs insurance with deductible issue',
        'Run the financing pre-qual together — soft pull, real offers from multiple lenders in about a minute (good for cash jobs)',
        'Tax refund timing: "If we start in February, you get most of your refund before final payment"',
        'HELOC: lower interest than financing, 30+ year term',
        'For insurance claims: the deductible is always the homeowner\'s to pay — never absorb, waive, rebate or discount any of it, for referrals or anything else (insurance fraud in OH and KY; KRS 367.628(2)(b)). Offer financing or a payment plan instead',
        'Walk them through the math in writing so they can show their family',
        'Never pressure — "Take your time, here are the options"'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-wants-to-wait', 'deductible-waiver', 'payment-plans']
    },
    {
      id: 'new-roof-not-needed',
      title: '"I don\'t need a new roof"',
      tagline: 'Customer denies the damage exists',
      situation: 'Customer looks at the damage you pointed out and says it\'s not that bad, or denies it exists.',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: 'A customer is refusing to acknowledge damage on their roof. I saw [specific damage]. Help me:\n\n1. Draft an educational script explaining how hail damage progresses over time\n2. Suggest non-pushy ways to help them see the damage (photos, video, drone footage)\n3. Handle the "my roof looks fine from the ground" objection\n4. Use the insurance claim as leverage: "If the damage isn\'t there, the adjuster will say no — what do you have to lose?"',
      playbook: [
        'Don\'t argue. Say: "You\'re right to be skeptical, let me show you"',
        'Walk them to a ladder spot where they can see close-up',
        'Show them the difference between hail hits and normal wear',
        'Use the "get a free inspection from insurance" framing: "You have nothing to lose"',
        'If they still deny: "OK, I respect that. Call me if you change your mind"',
        'Leave them a business card with your photo and warranty info'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-wants-to-wait', 'insurance-denial-risk']
    },
    {
      id: 'customer-is-handy',
      title: '"I\'ll DIY it"',
      tagline: 'Customer thinks they can replace it themselves',
      situation: 'Customer wants to replace the roof themselves to save money.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'A customer is considering DIY-ing their own roof replacement. Help me respectfully walk them through the risks: warranty voids, insurance policy exclusions, code compliance, safety, time commitment, tool costs. Be honest — don\'t scare them, but give them real data.',
      playbook: [
        'Respect their ambition: "That takes real skills, I\'ve seen people do it"',
        'Walk through the real costs: permit, dumpster, materials, tool rental, own time',
        'Warranty: manufacturers void shingle warranty if not installed by a certified pro',
        'Insurance: most homeowners policies EXCLUDE DIY-caused damage (water intrusion during DIY)',
        'Code: pulling a permit requires an inspection — most DIY fails first inspection',
        'Time: 2 people full-time for 5-7 days plus planning + disposal',
        'Offer compromise: "Hire us for the critical parts (underlayment, flashing, ridge) and save on labor"'
      ],
      codeRefs: ['OBC R105 (Permits)', 'OBC R109 (Inspection)'],
      relatedScenarios: ['financing-objection', 'warranty-importance']
    },
    {
      id: 'door-knock-first-impression',
      title: 'First impression at the door',
      tagline: 'Opening line for cold door-knock',
      situation: 'Cold door-knock after a storm. First 10 seconds determine if you get inside.',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: 'Help me craft the perfect 30-second door-knock opener for post-storm canvassing in [neighborhood]. Include: name + company, specific reason I\'m at their door (not "pitching" — specific damage/event), what I\'m asking for (2 minutes), no-pressure close.',
      playbook: [
        'Step back from the door after knocking (non-threatening)',
        'Name + company: "Hi, I\'m Joe with No Big Deal, we\'re local in Goshen"',
        'Reason: "I\'m walking the street because we got hit with [storm type] on [date]"',
        'Specific: "I noticed [specific thing about their roof] from the street"',
        'Ask: "Can I do a free 10-minute roof inspection and show you what I see?"',
        'No-pressure close: "No obligation, no pressure — I just want to give you peace of mind"',
        'If no answer, leave a door hanger + photo business card'
      ],
      codeRefs: [],
      relatedScenarios: ['d2d-territory-plan', 'storm-canvassing']
    },
    {
      id: 'referral-ask',
      title: 'Asking for a referral after the job',
      tagline: 'Turning a happy customer into 3 more',
      situation: 'Just finished a job and the customer is thrilled. This is the moment for the referral ask — most contractors miss it.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'I just finished a job for [customer]. They\'re happy. Help me craft a natural referral ask that: (1) thanks them first, (2) asks for a specific number (3 neighbors, not "anyone"), (3) offers a concrete incentive that is lawful for this job (on an insurance job, never a credit against their price — KRS 367.628(2) in Kentucky), (4) makes it easy (I\'ll give them a card to hand out, or they can introduce me).',
      playbook: [
        'Wait until they\'ve seen the finished job and said something positive',
        'Thank them: "Thanks for trusting us with this"',
        'Referral ask: "I\'d love to help 3 more families on your street — who do you know?"',
        'Offer (cash jobs): "$100 referral credit for every neighbor who signs" — never a credit against an insurance job\'s price (KRS 367.628(2)(c)-(d) in Kentucky)',
        'Make it easy: "Here are 5 cards with my photo and direct line"',
        'Ask permission to mention them: "Can I say \'Jennifer sent me\' when I knock?"',
        'Leave a small thank-you (cookies, a card) within a week — Kentucky bars giving an insured anything worth more than $100 (KRS 367.628(2)(d))'
      ],
      codeRefs: [],
      relatedScenarios: ['review-request', 'referral-program']
    },
    {
      id: 'review-request',
      title: 'Getting a Google review',
      tagline: 'Asking for a review the right way',
      situation: 'Customer finished the job and you need a Google review. Most contractors ask wrong and get 20% conversion. Good ask = 60%.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'Help me write a Google review request text message that a customer will actually respond to. Include: personal tone, specific job detail, 1-tap link, frictionless ask, and a fallback if they say no (email?).',
      playbook: [
        'Wait 24-48 hours after job completion (fresh but not pushy)',
        'Text first — higher response than email',
        'Personal opener: "Hey [name], Joe here from NBD"',
        'Specific: "Thank you again for trusting us with your [color] shingles"',
        'Ask: "Would you mind leaving us a quick Google review? Here\'s the 1-tap link: [link]"',
        'Make it easy: pre-fill stars if possible, link direct to your Google review page',
        'If they say no: "No worries! Is there anything I could have done better?"',
        'Track conversion — if under 50%, tweak the message'
      ],
      codeRefs: [],
      relatedScenarios: ['referral-ask', 'reputation-management']
    }
  ];

  // ═════════════════════════════════════════════════════════
  // 3. CREW & OPS (8 scenarios)
  // ═════════════════════════════════════════════════════════
  const CREW_OPS = [
    {
      id: 'crew-no-show',
      title: 'Crew no-show day of install',
      tagline: 'Crew didn\'t show up, customer is at home waiting',
      situation: 'You have a scheduled install, crew was supposed to be onsite at 7am, it\'s 8:30 and they\'re not there and not answering.',
      priority: 'high',
      timeToResolve: 'same-day',
      prompt: `My crew didn't show up for an install at [property] today. Customer is at home expecting us. Help me:

1. Draft an urgent but professional message to the customer
2. Create a quick decision tree: can I get a backup crew in 2 hours? If not, how do I reschedule without losing the customer?
3. Calculate the impact (material on truck, customer trust, schedule cascade)
4. Write a recovery plan I can execute in the next 60 minutes`,
      playbook: [
        'Call the customer IMMEDIATELY — do not text, call personally',
        'Say: "I wanted to be the first to tell you we\'ve had a crew issue this morning"',
        'Never blame the crew publicly — "my team" owns the problem',
        'Have a backup plan ready: reschedule tomorrow, or Plan B crew if you have one',
        'Offer specific compensation on a cash job: 5% off or an upgraded ridge vent. On an insurance job, no discount or credit against the price (KRS 367.628(2) in Kentucky) — offer schedule priority instead',
        'Follow up with a text summary of the call',
        'Address the crew issue separately — never in front of the customer',
        'Document everything in the customer timeline'
      ],
      codeRefs: [],
      relatedScenarios: ['weather-delay', 'customer-trust-recovery']
    },
    {
      id: 'weather-delay',
      title: 'Weather forced a delay',
      tagline: 'Rain or storm mid-install, need to dry in',
      situation: 'Storm rolling in during a tear-off. Need to dry in the roof to protect the interior.',
      priority: 'high',
      timeToResolve: 'minutes',
      prompt: 'A storm is rolling in during a roof tear-off at [property]. Help me: (1) Decide when to stop work and dry in, (2) Draft a short text to the customer explaining the delay, (3) Calculate the additional cost (tarp, extra day labor, wasted underlayment), (4) Set expectations for the reschedule.',
      playbook: [
        'Check radar continuously — know when to stop',
        'Stop with enough time to fully dry-in before rain hits (allow 45 min minimum)',
        'Cover every open area with heavy-duty tarps, weighted with 2x4s',
        'Seal all penetrations with peel-and-stick as you go',
        'Text customer: "Weather is moving in. We\'re stopping at [time] and will be back [date]. Your roof is fully protected."',
        'Send photo of the tarped roof so they feel confident',
        'Reschedule the next weather-clear day — move other jobs if necessary',
        'Document the delay in the customer timeline with photos'
      ],
      codeRefs: ['NRCA Wet Weather Guidelines'],
      relatedScenarios: ['crew-no-show', 'schedule-cascade']
    },
    {
      id: 'material-damaged',
      title: 'Material damaged or wrong delivery',
      tagline: 'Supplier delivered wrong/damaged materials',
      situation: 'Supplier dropped off materials but the color is wrong, or bundles are water-damaged, or the order is short.',
      priority: 'high',
      timeToResolve: 'same-day',
      prompt: 'My supplier delivered [wrong color / damaged / short count] materials for a job at [property]. Help me: (1) Document the problem with photos, (2) Call the supplier with a firm but professional script, (3) Decide whether to proceed with partial material or wait for correct delivery, (4) Update the customer on the delay impact.',
      playbook: [
        'Take photos IMMEDIATELY before any materials are moved',
        'Call the supplier, not the delivery driver: "I need a manager"',
        'Specific ask: "Can you deliver the correct material today, and what\'s your ETA?"',
        'If they can\'t deliver same-day, ask for a credit + rush delivery tomorrow',
        'Decide: proceed with corrected partial, or tarp and restart tomorrow',
        'Never install wrong color or water-damaged materials — warranty voids',
        'Update customer proactively — short text with next steps'
      ],
      codeRefs: ['Manufacturer installation requirements'],
      relatedScenarios: ['weather-delay', 'supplier-issues']
    },
    {
      id: 'underwater-job',
      title: 'Underwater on a job',
      tagline: 'Job is losing money — bid too low',
      situation: 'You realized mid-job that you bid the project too low and are losing money on it. Have to decide whether to cut corners, eat the loss, or negotiate with the customer.',
      priority: 'high',
      timeToResolve: 'hours',
      prompt: `I'm underwater on a job at [property]. Original bid was [$amount], actual cost is tracking toward [$amount]. Help me:

1. Figure out where the overrun came from (material, labor, hidden damage, scope creep)
2. Decide if I should go back to the customer for a change order
3. Draft a respectful change order request if applicable
4. Calculate what I need to recover at minimum to not lose money
5. Lessons learned for the next estimate`,
      playbook: [
        'Never cut corners to make up margin — you\'ll eat it on warranty or reputation',
        'Identify the cause: scope creep (customer added work), hidden damage (discovery), bid error',
        'If scope creep: justify change order with original scope comparison',
        'If hidden damage: supplement the insurance claim if applicable',
        'If bid error: eat the loss, learn from it, update your rates in Settings',
        'Never go back to customer with a vague "we need more money" — specific justification only',
        'After the job, review what went wrong and document in your estimate template'
      ],
      codeRefs: [],
      relatedScenarios: ['discovered-damage', 'pricing-audit', 'change-order']
    },
    {
      id: 'crew-quality-issue',
      title: 'Crew did sloppy work',
      tagline: 'Quality problem on a finished job',
      situation: 'Customer (or your walk-through) identified quality issues on a finished job — bad ridge, wrong nail pattern, leaky flashing.',
      priority: 'high',
      timeToResolve: 'days',
      prompt: 'My crew did sloppy work on a job at [property]. Customer noticed [specific issue]. Help me: (1) Write a same-day apology message, (2) Schedule a fix without blaming the crew publicly, (3) Decide who eats the cost, (4) Document the repair for warranty purposes, (5) Address the crew issue internally.',
      playbook: [
        'Acknowledge the issue immediately — never deflect or make excuses',
        'Apologize specifically: "That\'s not our standard, I\'m going to fix it"',
        'Schedule the fix within 48 hours — no "I\'ll look at it next week"',
        'Send the best crew to do the fix, not the same one who messed up',
        'Photograph the fix for warranty documentation',
        'Offer something extra as goodwill: gutter cleaning or touchup paint (no price credit on an insurance job — KRS 367.628(2) in Kentucky)',
        'Address the crew internally after — training, rebuke, or replacement',
        'Update your QC process so it doesn\'t happen again'
      ],
      codeRefs: ['NBD Labor Warranty Standards'],
      relatedScenarios: ['customer-trust-recovery', 'warranty-claim']
    },
    {
      id: 'schedule-cascade',
      title: 'Schedule cascade from delay',
      tagline: 'One delay is pushing everything back',
      situation: 'A weather or crew delay is cascading — the job that was delayed pushes the next job, which pushes the next.',
      priority: 'high',
      timeToResolve: 'hours',
      prompt: 'I have a schedule cascade from a [reason] delay. Jobs affected: [list]. Help me: (1) Prioritize which customer to reschedule first, (2) Draft a template message I can send to each affected customer, (3) Decide if I need to hire a second crew temporarily, (4) Prevent this from happening again.',
      playbook: [
        'Sort affected customers by urgency (leaks, insurance deadlines, closings)',
        'Call the highest-priority customer first — not email or text',
        'Offer specific new dates — not "next week"',
        'Consider subcontracting to a trusted peer crew for 1-2 jobs',
        'Send a unified update to all affected customers so they know you\'re handling it',
        'Build 20% buffer into your schedule going forward',
        'Document the cause — was it preventable?'
      ],
      codeRefs: [],
      relatedScenarios: ['weather-delay', 'crew-no-show']
    },
    {
      id: 'inspection-fail',
      title: 'Failed a city inspection',
      tagline: 'Inspector failed the roof',
      situation: 'City inspector showed up and failed the installation. Need to fix before passing.',
      priority: 'high',
      timeToResolve: 'days',
      prompt: 'I failed a roof inspection at [property]. Inspector noted: [issue]. Help me: (1) Understand the code reference they cited, (2) Decide if the fix is easy or structural, (3) Schedule the re-inspection ASAP, (4) Inform the customer without damaging trust.',
      playbook: [
        'Get the specific code reference from the inspection report',
        'Look up the code in OBC or KRC to confirm the inspector\'s interpretation',
        'If the inspector is wrong: politely request a supervisor review (rare but happens)',
        'If the inspector is right: schedule the fix immediately',
        'Call the customer: "We\'re addressing one small item the inspector flagged"',
        'Don\'t over-apologize — inspections are normal',
        'Request the re-inspection within 3 business days',
        'Update your QC checklist to catch this issue going forward'
      ],
      codeRefs: ['OBC R109', 'KRC R109'],
      relatedScenarios: ['crew-quality-issue', 'warranty-claim']
    },
    {
      id: 'dumpster-issue',
      title: 'Dumpster problem',
      tagline: 'Dumpster didn\'t arrive or wrong size',
      situation: 'Scheduled dumpster didn\'t arrive, or arrived in the wrong size, blocking the job.',
      priority: 'medium',
      timeToResolve: 'same-day',
      prompt: 'My dumpster [didn\'t arrive / is wrong size] for a job at [property]. Help me: (1) Call the dumpster company with a firm script, (2) Decide if we proceed with manual debris piles, (3) Update the customer on impact.',
      playbook: [
        'Call the dumpster company manager, not dispatch',
        'Specific ask: "I need a 30-yard at [address] within 2 hours"',
        'If they can\'t: have a backup vendor in your contacts (always keep 2)',
        'If you have to proceed: pile debris on a tarp in the driveway, then haul',
        'Tell the customer: "We\'re working around a vendor issue, no impact to your roof"',
        'Never leave debris on the customer\'s lawn overnight',
        'Document the vendor failure and consider switching suppliers if recurrent'
      ],
      codeRefs: [],
      relatedScenarios: ['material-damaged', 'schedule-cascade']
    }
  ];

  // ═════════════════════════════════════════════════════════
  // 4. PRICING (8 scenarios)
  // ═════════════════════════════════════════════════════════
  const PRICING = [
    {
      id: 'price-match',
      title: 'Price matching a competitor',
      tagline: 'Customer wants us to match a lower bid',
      situation: 'Customer brings us a competing quote that\'s lower and asks us to match it.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'A customer is asking me to match a competitor\'s bid of [$amount] on their [property] roof. My bid is [$amount]. Help me: (1) Compare scope line by line, (2) Identify where the competitor is cutting corners, (3) Decide if I can match safely or if I should walk, (4) Draft a respectful response either way.',
      playbook: [
        'Ask to see the competitor\'s estimate in writing',
        'Compare scope line by line: shingle brand/tier, underlayment, ice & water, flashing, ventilation, warranty',
        'Red flags: 3-tab shingles, felt underlayment only, no kickout flashing, no permit, no warranty',
        'If the competitor is cutting real scope: refuse to match, educate the customer instead',
        'If the competitor is legit and just priced tight: match or meet in the middle',
        'Never match below your cost basis (see Settings → Estimates for your floor)',
        'If matching: get a written acknowledgment that you\'re dropping to Good tier'
      ],
      codeRefs: [],
      relatedScenarios: ['price-objection', 'tier-downsell']
    },
    {
      id: 'tier-downsell',
      title: 'Customer wants cheaper option',
      tagline: 'Budget-conscious customer — downsell to Good tier',
      situation: 'Customer can\'t afford Better/Best tier. Need to downsell to Good without losing the sale.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'A customer is interested but can\'t afford my Better tier. Help me present the Good tier as a respectable option without bashing the Better tier, and explain exactly what they\'re giving up (warranty length, impact rating, brand).',
      playbook: [
        'Never say "cheap" — say "Good tier" or "Standard tier"',
        'Explain what they get: 30-year shingle, standard warranty, full code compliance',
        'Explain what they\'re giving up: impact rating, extended warranty, designer look',
        'Show the total price difference in absolute dollars, not %',
        'Offer to upgrade specific items: "We can do Good tier shingles but upgrade the underlayment"',
        'Never pressure — the Good tier is still a professional installation'
      ],
      codeRefs: [],
      relatedScenarios: ['price-match', 'financing-objection']
    },
    {
      id: 'pricing-audit',
      title: 'Pricing audit — am I charging enough?',
      tagline: 'Review pricing against margin targets',
      situation: 'You suspect you\'re leaving money on the table — not charging enough for certain line items or tiers.',
      priority: 'low',
      timeToResolve: 'hours',
      prompt: 'Help me audit my pricing against industry benchmarks and my margin targets. Current rates: Good [$]/SQ, Better [$]/SQ, Best [$]/SQ. Target margin: [%]. Review: (1) Am I at or above market for Cincinnati? (2) Where am I under-priced? (3) Recommend specific rate changes with expected revenue impact.',
      playbook: [
        'Pull last 10 completed jobs: total revenue, total cost, actual margin',
        'Compare actual margin to target (aim for 30%+ gross margin)',
        'Check per-SQ rates against local benchmarks ($500-$700 range in Cincinnati)',
        'Identify under-priced line items: pipe boots, flashing details, labor adders',
        'Update Settings → Estimates with new rates',
        'Re-run your most recent estimate to see new total',
        'Communicate rate change to crew and any channel partners'
      ],
      codeRefs: [],
      relatedScenarios: ['underwater-job', 'cost-basis-update']
    },
    {
      id: 'change-order',
      title: 'Change order request',
      tagline: 'Customer added scope mid-job',
      situation: 'Customer asked for additional work mid-job that wasn\'t in the original estimate.',
      priority: 'medium',
      timeToResolve: 'hours',
      prompt: 'A customer added scope mid-job: [description]. Original contract was [$]. Help me: (1) Price the change order at retail rates (not wholesale), (2) Draft a formal change order the customer signs before we do the work, (3) Update the total contract amount.',
      playbook: [
        'NEVER do additional work without a signed change order',
        'Price the change at full retail (no discount for mid-job)',
        'Write a 1-page change order: describes the work, new price, signature line',
        'Customer must sign BEFORE the work starts',
        'Take photos of the area before/during/after the change work',
        'Update the estimate total and email the updated version',
        'Track the change in the customer timeline'
      ],
      codeRefs: [],
      relatedScenarios: ['underwater-job', 'customer-trust']
    },
    {
      id: 'cost-basis-update',
      title: 'Supplier raised prices',
      tagline: 'Material cost went up — need to adjust',
      situation: 'Your supplier increased prices on shingles/materials. You need to update your cost basis and potentially your rates.',
      priority: 'medium',
      timeToResolve: 'hours',
      prompt: 'My supplier raised shingle prices by [$] per bundle. Help me: (1) Calculate the new per-SQ cost, (2) Decide how much of the increase to pass through to customers, (3) Update my Estimates settings, (4) Notify the crew about the new pricing.',
      playbook: [
        'Calculate the new per-SQ material cost (bundle price × 3 bundles/SQ)',
        'Update Settings → Estimates → Cost Basis for each tier',
        'Decide pass-through: usually 50-75% in a competitive market',
        'Update the per-SQ tier rates to reflect the new margin target',
        'Re-price any open estimates — let customers know it\'s locked at their current price if signed before [date]',
        'Update the material catalog in the Products view',
        'Send crew an update so they know cost basis changed'
      ],
      codeRefs: [],
      relatedScenarios: ['pricing-audit', 'customer-price-lock']
    },
    {
      id: 'insurance-vs-cash-pricing',
      title: 'Insurance vs cash pricing',
      tagline: 'Different rates for insurance vs cash customers',
      situation: 'Cash customers often get a better rate than insurance customers. Legal question: is this discriminatory?',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'Help me understand the legality and ethics of charging different rates for insurance vs cash customers in OH/KY. Specifically: (1) Is it legal? (2) If so, what\'s the proper structure? (3) How do I explain the difference to a customer without seeming fraudulent?',
      playbook: [
        'Insurance pricing uses Xactimate-style line-item breakdowns with OH&P',
        'Cash pricing uses per-SQ tier rates without OH&P (customer isn\'t paying for overhead separately)',
        'Both are legal as long as the actual work performed matches the scope',
        'Never inflate an insurance scope just because insurance is paying',
        'Never give a cash discount that\'s less than the insurance bid if same scope',
        'Document pricing methodology in your company SOP',
        'Consult a local insurance attorney if you\'re unsure'
      ],
      codeRefs: ['OH Revised Code 2913.47', 'KY Revised Statutes 304.47'],
      relatedScenarios: ['deductible-waiver', 'pricing-audit']
    },
    {
      id: 'minimum-job-charge',
      title: 'Small repair — minimum job charge',
      tagline: 'Customer wants a $150 repair but min job is $2,500',
      situation: 'Customer wants a small repair that\'s below your minimum job charge ($2,500 in the locked spec).',
      priority: 'low',
      timeToResolve: 'minutes',
      prompt: 'A customer wants a small repair at [property] that\'s below my minimum job charge of [$]. Help me: (1) Explain why the minimum exists (mobilization, permit, dump fee all fixed costs), (2) Offer alternatives (combine with a future larger job, refer to a handyman), (3) Decide if there\'s a scenario where I\'d waive the minimum.',
      playbook: [
        'Explain: "We have a minimum because of fixed costs — permit, dumpster, crew mobilization"',
        'Show them the breakdown: $550 dump + $185 permit + $250 mobilization = $985 before any actual work',
        'Offer to bundle: "If you have other projects, we can combine them to hit the minimum"',
        'Refer to a handyman for truly small jobs: "For something this small, I\'d actually recommend [name]"',
        'NEVER waive the minimum below your breakeven — you\'ll lose money',
        'Exception: free repair on a previous job under warranty'
      ],
      codeRefs: [],
      relatedScenarios: ['customer-wants-cheap', 'warranty-claim']
    },
    {
      id: 'customer-price-lock',
      title: 'Customer wants to lock a price',
      tagline: 'Customer wants to sign now but do the work later',
      situation: 'Customer wants to sign the contract now to lock in today\'s price but postpone the actual work 2-3 months.',
      priority: 'medium',
      timeToResolve: 'minutes',
      prompt: 'A customer wants to lock in my quoted price but delay work for [time period]. Help me: (1) Write a clause that protects me from material cost increases, (2) Require a deposit to lock the price, (3) Set expectations on lead time when they\'re ready.',
      playbook: [
        'Accept the lock with conditions: 15% deposit required to lock price',
        'Price lock term: 60 days standard, 90 days with 25% deposit',
        'Include a material escalation clause: "If supplier costs rise more than 10%, contract is renegotiated"',
        'Put the job on the "price-locked" list in your CRM',
        'Reach out 30 days before lock expires to schedule',
        'Never lock a price indefinitely — put an expiration date in writing'
      ],
      codeRefs: [],
      relatedScenarios: ['cost-basis-update', 'customer-shopping-around']
    }
  ];

  // ═════════════════════════════════════════════════════════
  // Combine into categories
  // ═════════════════════════════════════════════════════════

  const CATEGORIES = [
    {
      key: 'insurance',
      label: 'Insurance Claims',
      icon: '📋',
      description: 'Adjuster disputes, supplements, claim navigation, and denial handling',
      color: '#BD5728',
      scenarios: INSURANCE_CLAIMS
    },
    {
      key: 'sales',
      label: 'Sales & Objections',
      icon: '🤝',
      description: 'Closing techniques, objection handling, and referral generation',
      color: '#2ECC8A',
      scenarios: SALES_OBJECTIONS
    },
    {
      key: 'crew',
      label: 'Crew & Ops',
      icon: '👷',
      description: 'No-shows, weather delays, quality issues, and jobsite problems',
      color: '#4A9EFF',
      scenarios: CREW_OPS
    },
    {
      key: 'pricing',
      label: 'Pricing',
      icon: '💰',
      description: 'Rate reviews, price matching, change orders, and cost basis updates',
      color: '#D4A017',
      scenarios: PRICING
    }
  ];

  // ═════════════════════════════════════════════════════════
  // Query helpers
  // ═════════════════════════════════════════════════════════

  function getAllScenarios() {
    return CATEGORIES.flatMap(c => c.scenarios.map(s => Object.assign({ category: c.key, categoryLabel: c.label }, s)));
  }

  function getCategoryScenarios(categoryKey) {
    const cat = CATEGORIES.find(c => c.key === categoryKey);
    return cat ? cat.scenarios : [];
  }

  function findScenario(id) {
    const all = getAllScenarios();
    return all.find(s => s.id === id) || null;
  }

  function searchScenarios(query) {
    query = (query || '').toLowerCase();
    if (!query) return getAllScenarios();
    return getAllScenarios().filter(s =>
      (s.title || '').toLowerCase().includes(query) ||
      (s.tagline || '').toLowerCase().includes(query) ||
      (s.situation || '').toLowerCase().includes(query) ||
      (s.id || '').toLowerCase().includes(query)
    );
  }

  function getHighPriority() {
    return getAllScenarios().filter(s => s.priority === 'high');
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════

  // ═════════════════════════════════════════════════════════
  // UI: scenario picker modal
  // ═════════════════════════════════════════════════════════
  // The data + query layer was loaded but never bound to UI — the
  // entire feature was inert. This minimal renderer surfaces the
  // 30+ scenarios as a category-tabbed picker, drops the chosen
  // prompt into Ask Joe (or onto the clipboard as a fallback), and
  // shows the playbook + code refs alongside.

  const _esc = (s) => String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  let _selectedCategoryKey = CATEGORIES[0].key;

  function _modalShell() {
    const existing = document.getElementById('nbd-decision-modal');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'nbd-decision-modal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);' +
      'z-index:var(--z-modal,9000);display:flex;align-items:center;justify-content:center;padding:20px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    return overlay;
  }

  function _renderPicker() {
    const overlay = _modalShell();
    const cat = CATEGORIES.find(c => c.key === _selectedCategoryKey) || CATEGORIES[0];
    overlay.innerHTML = `
      <div role="dialog" aria-label="Decision Engine — Pick a scenario"
           style="background:var(--s,#181C22);border:1px solid var(--br,rgba(255,255,255,.1));
                  border-radius:14px;max-width:780px;width:100%;max-height:90vh;max-height:90dvh;
                  overflow:hidden;display:flex;flex-direction:column;color:var(--t,#E8EAF0);
                  font-family:'Barlow',sans-serif;box-shadow:0 30px 80px rgba(0,0,0,.5);">
        <div style="padding:18px 20px;border-bottom:1px solid var(--br,rgba(255,255,255,.1));
                    display:flex;align-items:center;gap:12px;flex-shrink:0;">
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:22px;font-weight:800;letter-spacing:.04em;">
            DECISION ENGINE
          </div>
          <div style="font-size:11px;color:var(--m,#6B7280);flex:1;">
            ${getAllScenarios().length} scenarios across ${CATEGORIES.length} categories
          </div>
          <button data-action="close" style="background:transparent;border:0;color:var(--m,#6B7280);
                  font-size:22px;cursor:pointer;padding:4px 10px;">×</button>
        </div>

        <div style="padding:14px 20px 8px;display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;">
          ${CATEGORIES.map(c => {
            const active = c.key === _selectedCategoryKey;
            return `<button data-cat="${_esc(c.key)}"
              style="padding:8px 14px;border-radius:8px;border:1px solid ${active ? c.color : 'var(--br,rgba(255,255,255,.1))'};
                     background:${active ? c.color + '22' : 'transparent'};color:${active ? c.color : 'var(--t,#E8EAF0)'};
                     font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;letter-spacing:.04em;">
              ${_esc(c.icon || '')} ${_esc(c.label)} <span style="opacity:.6;">(${c.scenarios.length})</span>
            </button>`;
          }).join('')}
        </div>

        <div style="padding:0 20px 8px;flex-shrink:0;">
          <input type="search" id="nbd-decision-search" placeholder="Search scenarios…" autocomplete="off"
                 style="width:100%;padding:10px 12px;background:var(--s2,#1F232A);
                        border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;
                        color:var(--t,#E8EAF0);font-size:14px;font-family:inherit;">
        </div>

        <div style="padding:12px 20px 4px;font-size:11px;color:var(--m,#6B7280);font-style:italic;flex-shrink:0;">
          ${_esc(cat.description || '')}
        </div>

        <div id="nbd-decision-list" style="flex:1;overflow-y:auto;padding:8px 14px 16px;-webkit-overflow-scrolling:touch;">
          ${_renderScenarioList(cat.scenarios)}
        </div>
      </div>
    `;
    overlay.querySelector('[data-action="close"]').onclick = () => overlay.remove();
    overlay.querySelectorAll('[data-cat]').forEach(b => {
      b.onclick = () => {
        _selectedCategoryKey = b.getAttribute('data-cat');
        _renderPicker();
      };
    });
    const search = overlay.querySelector('#nbd-decision-search');
    if (search) {
      search.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        const list = overlay.querySelector('#nbd-decision-list');
        if (!list) return;
        const scens = q
          ? searchScenarios(q)
          : getCategoryScenarios(_selectedCategoryKey);
        list.innerHTML = _renderScenarioList(scens);
        _bindScenarioClicks(overlay);
      });
    }
    _bindScenarioClicks(overlay);
    document.body.appendChild(overlay);
    return overlay;
  }

  function _renderScenarioList(scens) {
    if (!scens || !scens.length) {
      return '<div style="padding:30px;text-align:center;color:var(--m,#6B7280);font-size:13px;">No scenarios match.</div>';
    }
    return scens.map(s => {
      const priColor = s.priority === 'high' ? '#E05252' : s.priority === 'medium' ? '#D4A017' : '#4A9EFF';
      return `<button data-scenario="${_esc(s.id)}" style="display:block;width:100%;text-align:left;
        padding:12px 14px;margin-bottom:8px;border:1px solid var(--br,rgba(255,255,255,.08));
        background:var(--s2,#1F232A);border-radius:10px;cursor:pointer;font-family:inherit;
        color:var(--t,#E8EAF0);transition:border-color .15s,transform .1s;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
          <strong style="font-size:13px;">${_esc(s.title)}</strong>
          ${s.priority ? `<span style="font-size:9px;padding:1px 6px;border-radius:8px;
              background:${priColor}22;color:${priColor};font-weight:700;letter-spacing:.05em;
              text-transform:uppercase;">${_esc(s.priority)}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--m,#6B7280);">${_esc(s.tagline || '')}</div>
      </button>`;
    }).join('');
  }

  function _bindScenarioClicks(overlay) {
    overlay.querySelectorAll('[data-scenario]').forEach(b => {
      b.onclick = () => _renderScenarioDetail(b.getAttribute('data-scenario'));
    });
  }

  function _renderScenarioDetail(id) {
    const s = findScenario(id);
    if (!s) return;
    const overlay = _modalShell();
    const playbookHtml = (s.playbook || []).map(p => `<li style="margin-bottom:6px;">${_esc(p)}</li>`).join('');
    const codesHtml = (s.codeRefs || []).map(c => `<span style="display:inline-block;padding:2px 7px;
      margin:2px 4px 2px 0;border-radius:6px;font-size:10px;background:var(--s,#181C22);
      border:1px solid var(--br,rgba(255,255,255,.1));font-family:monospace;color:var(--orange,#BD5728);">
      ${_esc(c)}</span>`).join('');
    overlay.innerHTML = `
      <div role="dialog" aria-label="Scenario detail"
           style="background:var(--s,#181C22);border:1px solid var(--br,rgba(255,255,255,.1));
                  border-radius:14px;max-width:780px;width:100%;max-height:90vh;max-height:90dvh;
                  overflow:hidden;display:flex;flex-direction:column;color:var(--t,#E8EAF0);
                  font-family:'Barlow',sans-serif;box-shadow:0 30px 80px rgba(0,0,0,.5);">
        <div style="padding:16px 20px;border-bottom:1px solid var(--br,rgba(255,255,255,.1));
                    display:flex;align-items:center;gap:10px;flex-shrink:0;">
          <button data-action="back" style="background:transparent;border:0;color:var(--m,#6B7280);
                  font-size:16px;cursor:pointer;padding:4px 8px;">←</button>
          <div style="font-family:'Barlow Condensed',sans-serif;font-size:18px;font-weight:800;flex:1;">
            ${_esc(s.title)}
          </div>
          <button data-action="close" style="background:transparent;border:0;color:var(--m,#6B7280);
                  font-size:22px;cursor:pointer;padding:4px 10px;">×</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:18px 22px;-webkit-overflow-scrolling:touch;">
          <div style="font-size:12px;color:var(--m,#6B7280);margin-bottom:14px;">${_esc(s.situation || s.tagline || '')}</div>
          ${playbookHtml ? `<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--orange,#BD5728);margin:14px 0 8px;">Playbook</h3>
            <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.55;">${playbookHtml}</ol>` : ''}
          ${codesHtml ? `<div style="margin-top:14px;"><span style="font-size:11px;color:var(--m,#6B7280);text-transform:uppercase;letter-spacing:.06em;margin-right:6px;">Code refs:</span>${codesHtml}</div>` : ''}
        </div>
        <div style="padding:14px 20px;border-top:1px solid var(--br,rgba(255,255,255,.1));display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;">
          <button data-action="ask-joe" style="flex:1;min-width:160px;padding:11px 16px;
                  background:var(--orange,#BD5728);border:0;color:#fff;border-radius:8px;
                  font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;letter-spacing:.04em;">
            Send to Ask Joe →
          </button>
          <button data-action="copy" style="padding:11px 16px;background:transparent;
                  border:1px solid var(--br,rgba(255,255,255,.1));color:var(--t,#E8EAF0);
                  border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;font-family:inherit;letter-spacing:.04em;">
            Copy prompt
          </button>
        </div>
      </div>
    `;
    overlay.querySelector('[data-action="close"]').onclick = () => overlay.remove();
    overlay.querySelector('[data-action="back"]').onclick = () => { overlay.remove(); _renderPicker(); };
    overlay.querySelector('[data-action="ask-joe"]').onclick = () => {
      overlay.remove();
      // If joe view exists, navigate and drop the prompt into the input.
      // We do NOT auto-send: scenario prompts contain mandatory [bracketed]
      // placeholders the rep must fill in before sending.
      const inp = document.getElementById('joeInput');
      if (typeof window.goTo === 'function' && inp) {
        window.goTo('joe');
        setTimeout(() => {
          const i2 = document.getElementById('joeInput');
          if (i2) {
            i2.value = s.prompt || s.tagline || s.title;
            i2.focus();
          }
        }, 120);
        return;
      }
      // Standalone fallback — copy + open ask-joe.html.
      try {
        if (navigator.clipboard?.writeText) navigator.clipboard.writeText(s.prompt || s.title);
      } catch (_) {}
      window.location.href = '/pro/ask-joe.html?prompt=' + encodeURIComponent((s.prompt || s.title).slice(0, 1500));
    };
    overlay.querySelector('[data-action="copy"]').onclick = () => {
      try {
        navigator.clipboard.writeText(s.prompt || s.title).then(() => {
          if (typeof window.showToast === 'function') window.showToast('Prompt copied to clipboard', 'success');
        });
      } catch (e) {
        console.warn('clipboard write failed:', e && e.message);
      }
    };
    document.body.appendChild(overlay);
  }

  function openPicker() { _renderPicker(); }
  function openScenario(id) { _renderScenarioDetail(id); }

  window.DecisionEngine = {
    CATEGORIES,
    count: getAllScenarios().length,
    getAllScenarios,
    getCategoryScenarios,
    findScenario,
    searchScenarios,
    getHighPriority,
    openPicker,
    openScenario,

    // Stats
    stats: {
      totalScenarios: getAllScenarios().length,
      byCategory: CATEGORIES.map(c => ({ key: c.key, label: c.label, count: c.scenarios.length })),
      highPriority: getAllScenarios().filter(s => s.priority === 'high').length
    }
  };

  console.log(`[DecisionEngine] ${window.DecisionEngine.count} scenarios loaded across ${CATEGORIES.length} categories.`);
})();
