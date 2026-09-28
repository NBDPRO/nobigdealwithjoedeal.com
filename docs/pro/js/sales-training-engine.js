/**
 * sales-training-engine.js — scenario / objection data + session logic
 *
 * Step 4f (2026-05-17): the 2382-line sales-training.js IIFE got split
 * into an ENGINE module (this file) and a UI module
 * (sales-training-ui.js). The original filename
 * (sales-training.js) became a thin shim that publishes
 * window.SalesTraining. Behavior unchanged — public API is identical.
 *
 * Engine owns:
 *   - SKILL_TAGS constants
 *   - SCENARIOS array (decision-tree content, ~1300 lines)
 *   - OBJECTIONS array (rapid-fire flashcards, ~300 lines)
 *   - Shared mutable state on window._SalesTrainingState
 *   - Firestore session save / history load
 *   - Scoring helpers (getStarRating, starsHTML, aggregateScenarioTags)
 *   - Scenario mode: startScenario, chooseOption, advanceAfterFeedback,
 *     finishScenario
 *   - Rapid-fire mode: startRapidFire, rapidAnswer, rapidNext,
 *     finishRapidFire
 *   - buildSkillProfile aggregation
 *   - Navigation: backToMenu, showProfile
 *   - init() entry point
 *
 * UI module (sales-training-ui.js) reads everything via
 * window._SalesTrainingState and provides the render() pipeline.
 */
(function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // CONSTANTS & CONFIG
  // ════════════════════════════════════════════════════════════

  const SKILL_TAGS = {
    empathy:    { label: 'Empathy',            icon: '💛', color: '#F59E0B' },
    technical:  { label: 'Technical Knowledge', icon: '🔧', color: '#3B82F6' },
    objection:  { label: 'Objection Handling',  icon: '🛡️', color: '#8B5CF6' },
    closing:    { label: 'Closing',            icon: '🎯', color: '#10B981' },
    rapport:    { label: 'Rapport Building',    icon: '🤝', color: '#EC4899' },
    authority:  { label: 'Authority',          icon: '👔', color: '#BD5728' }
  };

  // ════════════════════════════════════════════════════════════
  // SCENARIO DATA — 5 Core Roofing Door-Knock Scenarios
  // ════════════════════════════════════════════════════════════

  const SCENARIOS = [

    // ── SCENARIO 1: THE COLD OPEN ──────────────────────────
    {
      id: 'cold_open',
      title: 'The Cold Open',
      subtitle: 'First contact — nobody knows who you are',
      icon: '🚪',
      difficulty: 'Beginner',
      diffColor: '#10B981',
      description: 'You\'re canvassing a neighborhood that just got hit by a hail storm 3 days ago. You walk up to a nice ranch-style home. The doorbell works. A middle-aged woman answers, arms crossed, clearly suspicious of the stranger on her porch.',
      estimatedTime: '3-4 min',
      skillFocus: ['rapport', 'empathy', 'authority'],
      nodes: {
        start: {
          id: 'start',
          prompt: 'The door opens. A woman in her 40s stands behind the screen door, not opening it. She looks at your clipboard and company shirt. "Whatever you\'re selling, I\'m not interested." She starts to close the door.',
          options: [
            {
              text: '"I totally understand, ma\'am. I\'m not here to sell anything today. My name is [Name] with No Big Deal Home Solutions. We\'re just in the neighborhood because of the storm that came through Tuesday — letting folks know what to look for on their roof before it becomes a bigger problem. Have you noticed any shingle pieces in your yard?"',
              nextNode: 'engaged',
              score: 25,
              tags: { empathy: 30, rapport: 25, authority: 20, technical: 10 },
              feedback: 'Excellent. You validated her concern, removed the sales pressure with "not here to sell," established authority with your company name, created urgency with the storm reference, and ended with a question that\'s easy to answer. This is textbook.'
            },
            {
              text: '"Hey there! We\'re a local roofing company and we\'re doing free inspections in the neighborhood. Can I take a look at your roof real quick? It\'ll only take 10 minutes."',
              nextNode: 'skeptic',
              score: 12,
              tags: { empathy: 5, rapport: 10, authority: 10, technical: 5 },
              feedback: 'Too transactional. "Free inspection" sounds like a pitch because it IS a pitch. You didn\'t acknowledge her resistance, jumped straight to asking for something, and "only 10 minutes" is a time commitment she didn\'t ask for. She\'s more guarded now.'
            },
            {
              text: '"Ma\'am, I\'m with No Big Deal Home Solutions. Your neighbors at [address] just filed a claim and got a full roof replacement covered by insurance. You\'ve probably got the same damage. If you don\'t get it checked, you could void your insurance coverage."',
              nextNode: 'fear_fail',
              score: 8,
              tags: { empathy: 0, rapport: 0, authority: 15, technical: 10, closing: 5 },
              feedback: 'Fear tactics and name-dropping neighbors is aggressive. While technically there may be truth about insurance timelines, leading with pressure and implied threats makes you sound like every storm chaser she\'s been warned about on the news. Trust destroyed.'
            }
          ]
        },
        engaged: {
          id: 'engaged',
          prompt: 'She pauses. Opens the screen door slightly. "Actually... yeah, I did see some dark pieces in the gutter. I thought it was just normal wear. Is that from the storm?" She\'s curious now but still cautious.',
          options: [
            {
              text: '"That\'s actually really common with hail damage — the granules get knocked off the shingles and wash into the gutters. It doesn\'t always look dramatic from the ground, but up close it can be significant. Would you mind if I just grab a few of those granules from the gutter and show you what I mean? I\'ll stay right here in the yard — no ladder, no commitment."',
              nextNode: 'demo',
              score: 25,
              tags: { technical: 30, empathy: 20, rapport: 20, authority: 15 },
              feedback: 'Perfect progression. You educated her (granules = damage), validated what she saw, made a tiny ask (grab granules) with clear boundaries (stay in yard, no ladder), and removed pressure (no commitment). Each micro-commitment builds trust.'
            },
            {
              text: '"Yeah that\'s storm damage for sure. Listen, I can get up on the roof right now and tell you exactly what\'s going on. If there\'s damage, your insurance will probably cover the whole thing — new roof, zero out of pocket. What do you say?"',
              nextNode: 'too_fast',
              score: 10,
              tags: { closing: 15, technical: 5, empathy: 0, rapport: 0 },
              feedback: 'You jumped from "she\'s curious" to "let me get on your roof" in one breath. That\'s like asking someone to marry you on the first date. The insurance promise sounds too good to be true — because to her, it is. Slow down.'
            },
            {
              text: '"It could be. Hard to say without looking closer. Every roof is different. I\'ve seen some in this neighborhood that are totally fine and some that need full replacement. The only way to know is an inspection. Here\'s my card — think about it and call us when you\'re ready."',
              nextNode: 'card_drop',
              score: 14,
              tags: { empathy: 10, rapport: 10, authority: 10, technical: 5 },
              feedback: 'Safe but passive. You had momentum and killed it. Leaving a card with someone who was actively engaged is leaving money on the table. She\'ll lose the card in the junk drawer and forget your name by tomorrow. The storm damage won\'t wait.'
            }
          ]
        },
        demo: {
          id: 'demo',
          prompt: 'She nods. "Sure, go ahead." You grab a handful of granules from the gutter — they\'re heavy. You show her. She seems genuinely concerned now. "So what does this mean? Is my roof ruined? How much is this going to cost me?"',
          options: [
            {
              text: '"Great question. Your roof isn\'t ruined — but this amount of granule loss means the shingles are compromised and won\'t protect you as long as they should. The good news is this is exactly what homeowner\'s insurance covers. I can do a full documented inspection — photos of every issue — that you can use when you file your claim. No charge for the inspection. If I don\'t find real damage, I\'ll tell you straight up and save you the hassle. Fair enough?"',
              nextNode: 'close_win',
              score: 30,
              tags: { technical: 25, empathy: 25, closing: 25, authority: 20, rapport: 15 },
              feedback: 'Masterclass close. You reassured her (not ruined), explained the risk (compromised), provided the solution (insurance), offered value (documented photos), set honest expectations (if no damage I\'ll say so), and made the ask easy (fair enough?). This is how deals start.'
            },
            {
              text: '"Well, a full roof replacement in this area runs about $8,000 to $15,000 depending on the size. But don\'t worry — insurance covers storm damage. I document the damage and write the estimate, and you file with that in hand. I just need to get up there, take photos, and we can get the ball rolling today."',
              nextNode: 'price_shock',
              score: 12,
              tags: { technical: 15, closing: 10, empathy: 0, rapport: 0 },
              feedback: 'You answered a question she didn\'t really ask by quoting dollar amounts. "$15,000" is all she heard. Now she\'s scared, not motivated. And "get the ball rolling today" after she just learned about the problem 60 seconds ago is pushy. Let the urgency come from the situation, not from you.'
            },
            {
              text: '"This means your roof has sustained hail damage. The granules are the protective coating on your shingles. Without them, you\'re looking at UV degradation, water penetration, and eventually leaks. I deal with this every day in neighborhoods like yours after storms. The standard process is: I inspect, document everything, you file a claim, adjuster comes out, and typically the insurance pays for a full replacement. Would you like me to get started with the inspection?"',
              nextNode: 'close_win',
              score: 22,
              tags: { technical: 30, authority: 25, closing: 15, empathy: 10, rapport: 5 },
              feedback: 'Technically strong and authoritative. You explained the science and the process clearly. Loses some points because the tone is a bit clinical — she\'s a worried homeowner, not an insurance adjuster. A little more warmth and reassurance would take this from good to great.'
            }
          ]
        },
        skeptic: {
          id: 'skeptic',
          prompt: 'She shakes her head. "Look, I\'ve had three guys from different companies knock this week. My neighbor said they\'re all scammers. How do I know you\'re any different?"',
          options: [
            {
              text: '"Your neighbor isn\'t wrong to be cautious — after every storm, out-of-state companies flood the area, do bad work, and disappear. We\'re based right here in Cincinnati. We\'ve been here before the storm and we\'ll be here after. I can give you our Ohio license number to verify, or you can look us up on Google right now — No Big Deal Home Solutions. I\'d rather earn your trust than pressure you."',
              nextNode: 'trust_earned',
              score: 22,
              tags: { authority: 30, rapport: 25, empathy: 20, objection: 20 },
              feedback: 'Outstanding. You validated the concern, differentiated yourself with facts (local, licensed, searchable), and gave her the tools to verify your credibility on the spot. "Earn your trust" is the key phrase — it reframes the whole dynamic.'
            },
            {
              text: '"I understand the concern. Here\'s my card — we\'re fully licensed, bonded, and insured. We\'ve done over 200 roofs in the Greater Cincinnati area. I can provide references from your actual neighborhood if you want."',
              nextNode: 'card_drop',
              score: 14,
              tags: { authority: 20, rapport: 10, empathy: 10, objection: 10 },
              feedback: 'Decent credentials dump but it sounds rehearsed. Every company claims to be "licensed, bonded, and insured." References are good but she\'s not going to call them. You needed to make the credibility tangible and immediate — like telling her to Google you right now.'
            },
            {
              text: '"Well ma\'am, I can promise you we\'re not scammers. We do quality work. If you\'re not interested though, no problem — have a great day!"',
              nextNode: 'walk_away',
              score: 5,
              tags: { empathy: 5, rapport: 5, objection: 0, authority: 0 },
              feedback: 'Terrible. "I promise we\'re not scammers" is literally what a scammer would say. You gave up at the first sign of resistance. This was a test — she wanted to see if you\'d back up your claims. Instead you folded. Objection handling is a muscle. Build it.'
            }
          ]
        },
        trust_earned: {
          id: 'trust_earned',
          prompt: 'She pulls out her phone and Googles you. Sees the reviews. "Okay... you guys have good reviews. But I still don\'t know if I actually have damage. And I don\'t want to file a claim for nothing — won\'t that raise my rates?"',
          options: [
            {
              text: '"That\'s a really smart question. In Ohio, insurance companies cannot raise your rates for filing a weather-related claim — it\'s a no-fault event, like a tree falling. It\'s actually different from an at-fault claim like a kitchen fire. And as for whether you have damage — that\'s exactly what the free inspection tells us. If I get up there and it\'s clean, I\'ll shake your hand and move on. No claim, no hassle. But if there IS damage and you don\'t file within a certain window, you could lose that coverage entirely."',
              nextNode: 'close_win',
              score: 28,
              tags: { technical: 30, objection: 30, empathy: 20, closing: 20, authority: 15 },
              feedback: 'Nailed it. You knew the actual insurance law (no-fault weather claims), addressed her real fear directly, removed the downside risk (if clean, no hassle), and introduced legitimate urgency (filing window). This is expert-level objection handling backed by real knowledge.'
            },
            {
              text: '"No no, it won\'t raise your rates. Insurance claims for storm damage are totally separate. That\'s a common misconception. Let me just do the inspection and we\'ll see what\'s there."',
              nextNode: 'close_mid',
              score: 15,
              tags: { technical: 10, objection: 15, empathy: 5, closing: 10 },
              feedback: 'Right direction, weak execution. "No no" sounds dismissive. You stated the fact but didn\'t explain WHY — the no-fault distinction is the key insight that builds confidence. And "let me just do the inspection" breezes past her concern without fully resolving it.'
            },
            {
              text: '"I\'m actually not sure about the rates question — you\'d have to ask your insurance company. But I can tell you that most people in this neighborhood are filing claims and getting new roofs. You don\'t want to be the only house on the block with a damaged roof, right?"',
              nextNode: 'fear_fail',
              score: 6,
              tags: { empathy: 0, objection: 0, technical: 0, closing: 5 },
              feedback: 'Admitting you don\'t know the answer to one of the most common homeowner questions is disqualifying. She just verified your company is legit — now you can\'t answer a basic insurance question? And the peer pressure close ("only house on the block") is manipulative. Trust evaporated.'
            }
          ]
        },
        too_fast: {
          id: 'too_fast',
          prompt: 'She steps back. "Whoa, slow down. I didn\'t say you could get on my roof. I don\'t even know your name. And \'zero out of pocket\' sounds too good to be true. I think I need to talk to my husband first."',
          options: [
            {
              text: '"You\'re absolutely right, and I apologize for getting ahead of myself. I\'m [Name] with No Big Deal Home Solutions — we\'re a local company based right here in Cincinnati. And you\'re smart to be cautious about the \'zero out of pocket\' thing — let me explain what that actually means. When you have storm damage, your homeowner\'s insurance covers the repair minus your deductible. So there IS a cost — your deductible. But the insurance pays the rest directly. Would it help if I just showed you what storm damage looks like on the shingles? I can do that right here from the ground."',
              nextNode: 'demo',
              score: 22,
              tags: { empathy: 25, rapport: 20, technical: 20, objection: 20, authority: 15 },
              feedback: 'Great recovery. You acknowledged the mistake, reintroduced yourself properly, corrected the misleading claim with honesty (deductible exists), and de-escalated the ask from "get on your roof" to "show you from the ground." This is how you rebuild trust after pushing too hard.'
            },
            {
              text: '"Sure, talk to your husband. Here\'s my card. Just know that the longer you wait, the worse the damage gets, and there\'s a deadline on storm claims. Give us a call when you\'re ready."',
              nextNode: 'walk_away',
              score: 8,
              tags: { closing: 5, empathy: 0, rapport: 0, objection: 5 },
              feedback: 'You accepted the "husband" objection at face value — which is almost always a polite way to say "I want you to leave." The urgency threat at the end contradicts the casual "give us a call" energy. You\'re sending mixed signals and losing the deal.'
            },
            {
              text: '"Is your husband home? I can explain everything to both of you right now. This is actually a conversation that\'s great to have together since it involves your home and your insurance."',
              nextNode: 'close_mid',
              score: 16,
              tags: { closing: 15, objection: 15, rapport: 10, empathy: 10 },
              feedback: 'Not bad — asking if the husband is home is the right instinct because it tests whether the objection is real. If he IS home, great, you get both decision-makers. But the phrasing feels a little aggressive after she just told you to slow down. Lead with more empathy before the pivot.'
            }
          ]
        },
        fear_fail: {
          id: 'fear_fail',
          prompt: 'She frowns and crosses her arms again. "You know what, I\'ve heard enough. My brother-in-law does construction and I\'ll just have him look at it. Thanks." She starts closing the door.',
          options: [
            {
              text: '"That\'s completely fair — having someone you trust look at it is a great idea. If he finds anything and you want a second opinion or need help with the insurance documentation, we\'re always available. Here\'s my card. No pressure at all. Have a great evening."',
              nextNode: 'graceful_exit',
              score: 18,
              tags: { empathy: 25, rapport: 20, authority: 10, objection: 10 },
              feedback: 'The best possible save from a failing scenario. You respected her decision, validated her plan, planted a seed for future contact, and left with dignity. She may call in two weeks when her brother-in-law says "yeah, you need a pro." The door isn\'t closed forever.'
            },
            {
              text: '"With all due respect, a general contractor and a roofing specialist are very different things. Does he know how to document damage for an insurance claim? Because if the documentation isn\'t done right, they\'ll deny the whole thing."',
              nextNode: 'door_closed',
              score: 4,
              tags: { technical: 10, empathy: 0, rapport: 0, objection: 0, authority: 5 },
              feedback: 'You just insulted her family member to her face. Even if you\'re technically correct, the relationship is over. She\'s now going to tell her brother-in-law AND her neighbors about the rude roofing guy. This is how companies get bad reviews.'
            },
            {
              text: '"Okay, no problem. But just so you know, most construction guys don\'t do insurance work and you could end up paying out of pocket for something that should be free. Just something to think about."',
              nextNode: 'door_closed',
              score: 6,
              tags: { technical: 5, objection: 5, empathy: 0, rapport: 0 },
              feedback: 'Still trying to undercut her brother-in-law on the way out the door. She made her decision — respect it. These parting-shot scare tactics never convert and always damage your reputation. Leave gracefully.'
            }
          ]
        },
        price_shock: {
          id: 'price_shock',
          prompt: 'Her eyes go wide. "$15,000?! I can\'t afford that! And I\'m not making an insurance claim — last time we filed a claim our rates went up." She looks panicked.',
          options: [
            {
              text: '"I totally hear you — $15,000 is a lot of money, and nobody wants to file claims unnecessarily. But here\'s the important distinction: what happened last time was probably an at-fault claim, like a pipe burst or something inside the house. Storm damage is classified as a no-fault weather event under Ohio law — they can\'t penalize you for it. It\'s like the difference between causing an accident and having a tree fall on your car. Would it help if I showed you where that\'s spelled out in your policy?"',
              nextNode: 'close_mid',
              score: 22,
              tags: { objection: 30, technical: 25, empathy: 20, authority: 15 },
              feedback: 'Strong recovery. You acknowledged the fear, identified the source of her misconception (previous at-fault claim), used a relatable analogy (car vs tree), and offered proof. The dollar amount shock is still lingering but you\'ve addressed the real objection — her fear of rate increases.'
            },
            {
              text: '"That\'s actually a myth about rates going up for storm claims. And the $15,000 wouldn\'t be out of your pocket — insurance covers it. You\'d only pay your deductible, probably $1,000 or so."',
              nextNode: 'close_mid',
              score: 14,
              tags: { technical: 10, objection: 10, empathy: 5, closing: 5 },
              feedback: 'Calling her lived experience a "myth" is dismissive — her rates DID go up last time, so to her it\'s not a myth. The deductible mention is good but came too late after she\'s already in panic mode. You needed to slow down and acknowledge her emotion before jumping to facts.'
            },
            {
              text: '"Don\'t worry about the price — that\'s what insurance is for! Let me get up there, document everything, and we\'ll get your claim approved. You won\'t pay a dime except your deductible."',
              nextNode: 'fear_fail',
              score: 6,
              tags: { closing: 10, empathy: 0, objection: 0, technical: 0 },
              feedback: '"Don\'t worry about the price" to someone who just said she can\'t afford it is tone-deaf. You completely ignored her insurance claim fear. And "we\'ll get your claim approved" is a promise nobody but the insurer can keep — the homeowner files, the carrier decides. Read the room.'
            }
          ]
        },
        card_drop: {
          id: 'card_drop',
          prompt: 'She takes your card politely. "Okay, thanks. I\'ll think about it." She gives a half-smile and starts closing the door. You know this card is going in a drawer.',
          options: [
            {
              text: '"Before you go — can I ask one quick thing? If you see any more of those granules or notice any spots on your ceiling after the next rain, give us a call right away. That means water is already getting in. I\'d rather you catch it early than deal with drywall damage later. My cell is on the card."',
              nextNode: 'card_save',
              score: 18,
              tags: { empathy: 20, technical: 20, rapport: 15, closing: 10 },
              feedback: 'Smart salvage. You gave her a specific, actionable reason to keep the card (ceiling spots after rain). You reframed calling you from "getting sold to" to "protecting her home." The personal cell reference makes it feel less corporate. Not a win today, but you planted a real seed.'
            },
            {
              text: '"Sounds good! We\'re in the area all week if you change your mind. Have a great day!"',
              nextNode: 'walk_away',
              score: 8,
              tags: { rapport: 10, empathy: 5 },
              feedback: 'Pleasant but forgettable. You gave her zero reason to remember you or the conversation. "In the area all week" isn\'t a reason to act — it\'s a fact she doesn\'t care about. She needed a specific trigger to pick up that card. You didn\'t give her one.'
            },
            {
              text: '"I hear that a lot, and honestly most people don\'t end up calling. So let me save you the trouble — what day works better for you this week, Tuesday or Thursday? I can come back for 10 minutes when it\'s convenient."',
              nextNode: 'close_mid',
              score: 15,
              tags: { closing: 25, objection: 15, rapport: 5, empathy: 5 },
              feedback: 'The alternative close (Tuesday or Thursday) is a classic technique and it CAN work here. Acknowledging that people don\'t call shows self-awareness. But the energy is a bit presumptuous after she clearly wanted to end the conversation. It\'s a coin flip — sometimes this lands, sometimes it pushes too hard.'
            }
          ]
        },
        // Terminal nodes
        close_win: {
          id: 'close_win',
          prompt: '✅ She nods. "Okay, that sounds fair. Go ahead and take a look." She opens the screen door all the way and steps out onto the porch with you. You\'ve earned the inspection.\n\nYou pull out your tablet to start documenting. This is how it starts — one honest conversation at a time.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'You earned the inspection through trust, education, and genuine care.'
        },
        close_mid: {
          id: 'close_mid',
          prompt: '🟡 She pauses. "Let me talk to my husband tonight and we\'ll call you tomorrow." She takes your card and actually looks at it — reads the name. There\'s a decent chance she calls.\n\nNot a closed deal today, but you planted a real seed. Follow up in 48 hours.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Strong engagement but didn\'t close. Follow-up opportunity is real.'
        },
        graceful_exit: {
          id: 'graceful_exit',
          prompt: '🟠 She takes the card. "Thanks for being understanding." She actually smiles as she closes the door. Your professionalism left a better impression than you think.\n\nThe brother-in-law will probably miss half the damage. She\'ll call in 2-3 weeks.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Lost the immediate opportunity but preserved the relationship. Future callback likely.'
        },
        card_save: {
          id: 'card_save',
          prompt: '🟡 She pauses at the door. "Ceiling spots... okay, I\'ll keep an eye out. Thanks for the heads up." She puts your card on the counter instead of in the junk drawer.\n\nWhen it rains Thursday, she\'ll remember this conversation.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Turned a dead-end card drop into a future callback trigger.'
        },
        walk_away: {
          id: 'walk_away',
          prompt: '❌ She closes the door. Your card goes in the recycling bin before you\'re off the porch. No inspection, no contact info, no future.\n\nThere was an opportunity here. Let\'s talk about where it went off track.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Lost the opportunity entirely. No follow-up path.'
        },
        door_closed: {
          id: 'door_closed',
          prompt: '❌ The door shuts firmly. You hear the deadbolt turn. Not only did you lose this house — she\'s going to warn the neighbors.\n\nAggressive tactics create negative ripple effects across the whole neighborhood.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Burned the contact and potentially poisoned the neighborhood.'
        }
      }
    },

    // ── SCENARIO 2: THE SKEPTIC ────────────────────────────
    {
      id: 'the_skeptic',
      title: 'The Skeptic',
      subtitle: '"I already have a roofer" and other trust walls',
      icon: '🤨',
      difficulty: 'Intermediate',
      diffColor: '#F59E0B',
      description: 'You knock on a well-maintained home in an established neighborhood. A man in his 50s opens the door. He\'s polite but immediately tells you he already has a contractor he trusts. This is the most common objection in roofing — how you handle it separates amateurs from closers.',
      estimatedTime: '3-5 min',
      skillFocus: ['objection', 'rapport', 'authority'],
      nodes: {
        start: {
          id: 'start',
          prompt: 'A man in his 50s opens the door. He\'s in a polo shirt, got a firm handshake energy. Before you finish introducing yourself, he says: "Hey, thanks for stopping by but I already have a guy. My buddy does roofing — been using him for 20 years. Appreciate it though." He gives a polite nod.',
          options: [
            {
              text: '"Hey I respect that — loyalty to a good contractor is rare these days and it says a lot about both of you. I\'m not here to replace your guy. Quick question though — has he been by since Tuesday\'s storm to check on you? Because I\'ve found damage on about 7 out of 10 houses on this street so far."',
              nextNode: 'crack_opened',
              score: 25,
              tags: { rapport: 30, objection: 30, empathy: 20, authority: 15 },
              feedback: 'Textbook. You complimented his loyalty (rapport), took yourself out of the competitive frame ("not here to replace your guy"), then planted a seed of doubt with a soft question plus a credibility stat (7 out of 10). He has to mentally reconcile "my guy hasn\'t checked on me" with "this stranger cared enough to knock."'
            },
            {
              text: '"No problem! If you ever need a second opinion, here\'s my card. Have a great day, sir."',
              nextNode: 'dead_end',
              score: 5,
              tags: { rapport: 5, empathy: 5, objection: 0, closing: 0 },
              feedback: 'You surrendered instantly. "I already have a guy" is the most common objection in the industry — if you fold every time you hear it, you\'ll never close a deal. This wasn\'t rude or aggressive; he was open to a brief conversation. You just didn\'t try.'
            },
            {
              text: '"That\'s great that you have someone. But does he do storm-damage documentation? Photos of every hit, a line-item estimate in Xactimate, meeting the adjuster on the roof after you file — that\'s different work from a regular re-roof, and if it\'s thin, items get missed."',
              nextNode: 'technical_push',
              score: 16,
              tags: { technical: 25, authority: 20, objection: 15, empathy: 0, rapport: 0 },
              feedback: 'You went straight to undermining his trusted contractor with technical jargon. While the information is valid, the delivery feels like you\'re attacking his judgment. He didn\'t ask for an education — he told you he\'s handled. Lead with curiosity, not superiority.'
            }
          ]
        },
        crack_opened: {
          id: 'crack_opened',
          prompt: 'He pauses. Looks at his roof, then back at you. "Huh. No, he hasn\'t been by. But I mean, he\'s busy — I\'m sure he\'ll get to it. 7 out of 10, really?" You can see the wheels turning.',
          options: [
            {
              text: '"Yeah, this storm hit harder than most people realize from the ground. And look — I\'m sure your guy IS good. But sometimes the guys who\'ve been doing it forever get so backed up after a storm that their existing customers end up at the back of the line. No fault of his. What I can do — and I mean this genuinely — is take 5 minutes, do a quick ground-level assessment, and if I see anything concerning I\'ll take photos you can send to YOUR guy. No sales pitch. Just intel for you."',
              nextNode: 'trust_built',
              score: 28,
              tags: { rapport: 25, empathy: 25, objection: 25, authority: 20, closing: 15 },
              feedback: 'Brilliant. You defended his contractor ("I\'m sure he IS good"), introduced a logical reason for the gap (backlog), and then offered something extraordinary — free intel to help HIS guy. This completely disarms the competitive dynamic. You\'re now an ally, not a rival. And once you\'re on that roof with photos in hand, the conversation shifts naturally.'
            },
            {
              text: '"Yeah, and the window for filing claims is shorter than people think. Some policies have a 12-month limit from the date of the storm. If your buddy doesn\'t get out here soon, you might miss it. Want me to take a quick look?"',
              nextNode: 'pressure_mid',
              score: 14,
              tags: { closing: 15, technical: 10, objection: 10, empathy: 5 },
              feedback: 'The urgency is real but the delivery feels like pressure. He\'s still loyal to his contractor and you\'re implicitly saying his buddy is going to cost him money by being slow. Tread carefully — you\'re close to triggering his defensive instinct. The pivot to "want me to take a look" was decent though.'
            },
            {
              text: '"Tell you what — here\'s my number. When your guy gets around to it and tells you everything\'s fine, call me for a free second opinion. I find damage that other contractors miss every single week. No offense to your buddy."',
              nextNode: 'seed_planted',
              score: 16,
              tags: { authority: 20, objection: 15, rapport: 10, closing: 5, empathy: 5 },
              feedback: 'Not bad — the "second opinion" angle is smart and non-threatening. But "I find damage other contractors miss" combined with "no offense" IS offensive, even if you don\'t mean it. And you\'re betting everything on him remembering to call you later. Most won\'t. You had momentum right now.'
            }
          ]
        },
        trust_built: {
          id: 'trust_built',
          prompt: 'He laughs. "You\'d take photos for my other guy? That\'s a first." He steps out onto the porch. "Alright, you seem like a straight shooter. Take a look. But I\'m warning you — if you try to hard-sell me, I\'m shutting it down."',
          options: [
            {
              text: '"Fair deal — and I appreciate you being direct. Give me about 10 minutes. I\'ll come down with photos and we\'ll go through everything together. If your guy can handle it, fantastic. If you want us to quote it too, that\'s your call. No pressure either way." You shake his hand and head to the ladder.',
              nextNode: 'scenario_win',
              score: 25,
              tags: { rapport: 25, closing: 20, empathy: 20, authority: 20 },
              feedback: 'Perfect close. You matched his direct energy, set clear expectations, kept the "your guy" door open (which paradoxically makes him more likely to go with you), and sealed it with a handshake. Once you\'re up there with photos showing real damage, the "my buddy" loyalty fades fast because now it\'s about who\'s actually there getting it done.'
            },
            {
              text: '"You got it. And just so you know — if I find damage, we can usually get your insurance to cover a full replacement. Most homeowners only pay their deductible. I\'ll explain the whole process when I come down."',
              nextNode: 'scenario_win',
              score: 18,
              tags: { closing: 20, technical: 15, authority: 15, rapport: 10 },
              feedback: 'Good but you couldn\'t resist sneaking in the sales pitch right after he explicitly said "don\'t hard-sell me." The insurance information is relevant but the timing is wrong — he literally just warned you. Save it for after the inspection when you have evidence in hand.'
            },
            {
              text: '"Awesome. Before I go up — what insurance company are you with? Just so I know what to document and how they like their reports formatted."',
              nextNode: 'scenario_win',
              score: 20,
              tags: { technical: 25, authority: 20, closing: 15, rapport: 10 },
              feedback: 'Smart tactical question that demonstrates expertise and starts the insurance conversation naturally. It shows you know what you\'re doing because different carriers have different documentation standards. Slight risk that he sees it as premature since he hasn\'t decided to file a claim yet.'
            }
          ]
        },
        technical_push: {
          id: 'technical_push',
          prompt: 'He stiffens. "My buddy does good work. He\'s done three roofs on this street. I don\'t need some kid telling me he doesn\'t know what he\'s doing." You\'re losing him.',
          options: [
            {
              text: '"Hey, you\'re absolutely right and I didn\'t mean to come across that way. Three roofs on this street is solid — that tells me he knows what he\'s doing. I was just thinking about the insurance side specifically. Different skill set, that\'s all. Look — when your guy comes by, if he finds damage, have him give you an Xactimate estimate. If the numbers look right, you\'re golden. If something feels off, I\'m happy to take a second look. Fair?"',
              nextNode: 'seed_planted',
              score: 18,
              tags: { empathy: 20, rapport: 15, objection: 20, technical: 10, authority: 10 },
              feedback: 'Solid recovery. You apologized without being weak, complimented his contractor specifically (three roofs = credible), and pivoted the Xactimate reference from an attack to a helpful tip. The "if something feels off" seed is smart — it\'ll stick.'
            },
            {
              text: '"I hear you. Have a great day, sir." You leave the card and walk away.',
              nextNode: 'dead_end',
              score: 6,
              tags: { rapport: 5, empathy: 5 },
              feedback: 'You folded the moment he pushed back. This was recoverable — he was irritated, not hostile. A genuine apology and a pivot would have saved it. Walking away after offending someone just leaves a bad impression with no redemption.'
            },
            {
              text: '"I wasn\'t saying he doesn\'t know what he\'s doing. I\'m saying insurance restoration is specialized. It requires specific certifications, specific software, and specific processes that general roofers don\'t always have. I deal with adjusters every day — it\'s all I do."',
              nextNode: 'double_down_fail',
              score: 8,
              tags: { technical: 15, authority: 10, empathy: 0, rapport: 0, objection: 5 },
              feedback: 'You doubled down. Even though the information is accurate, he\'s not in learning mode — he\'s in defensive mode. You\'re now arguing with a prospect on his own porch about his friend\'s competence. This never ends well. Recognize emotional state before delivering technical content.'
            }
          ]
        },
        pressure_mid: {
          id: 'pressure_mid',
          prompt: 'He folds his arms. "I\'ll mention it to him. Thanks for the heads up." He\'s being polite but wrapping up the conversation. You\'ve got about 10 seconds before the door closes.',
          options: [
            {
              text: '"Sounds good. One last thing — I took this photo yesterday two houses down." You show him a photo on your phone of damaged shingles on a similar roof. "Same age home, same shingle brand. Just wanted you to see what we\'re finding out here. Your guy will probably find the same thing. My card\'s got my cell — anytime."',
              nextNode: 'seed_planted',
              score: 20,
              tags: { authority: 25, technical: 20, closing: 15, rapport: 10, empathy: 5 },
              feedback: 'Strong visual close. A photo from a neighboring house makes the damage tangible and real without touching his roof. "Your guy will probably find the same thing" keeps his loyalty intact while planting serious doubt. The cell number makes future contact feel personal, not corporate.'
            },
            {
              text: '"Before you go — I noticed from the street that your ridge cap looks lifted on the east side. That\'s a classic hail indicator. You might want to have someone check that sooner rather than later."',
              nextNode: 'seed_planted',
              score: 17,
              tags: { technical: 25, authority: 20, empathy: 10, closing: 10 },
              feedback: 'Specific observation from the ground is powerful — it shows you actually looked at HIS roof, not just delivering a generic pitch. The urgency feels earned because it\'s based on something visible. Slightly clinical but effective.'
            },
            {
              text: '"Alright man, have a good one. If you ever need anything, we\'re No Big Deal Home Solutions."',
              nextNode: 'dead_end',
              score: 6,
              tags: { rapport: 5, empathy: 5 },
              feedback: 'Another generic exit. You had one last shot and you wasted it on a company name drop. He won\'t remember it. A specific, visual piece of evidence would have been 10x more memorable.'
            }
          ]
        },
        // Terminal nodes
        scenario_win: {
          id: 'scenario_win',
          prompt: '✅ You\'re on the roof. His "buddy" just lost this job and he doesn\'t even know it yet. Within 15 minutes, you\'ll have documented evidence of real hail damage. When you show him the photos, the "I have a guy" objection will dissolve — because now YOU\'RE the guy who showed up.\n\nThe best way to beat a competitor is to be the one who\'s actually there.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Overcame the strongest objection in roofing by positioning yourself as an ally, not a competitor.'
        },
        seed_planted: {
          id: 'seed_planted',
          prompt: '🟡 He takes your card and this time, he actually puts it in his wallet instead of his pocket. "Yeah, I\'ll check with my guy." He might. But the seed is planted.\n\nWhen his contractor doesn\'t call for 3 weeks and it rains again, your card will resurface.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Didn\'t get the inspection today but planted a strong enough seed for a future callback.'
        },
        dead_end: {
          id: 'dead_end',
          prompt: '❌ He closes the door. Your card\'s already in his back pocket where it\'ll go through the wash on Saturday. Another "I have a guy" that didn\'t have to end this way.\n\nThe objection was beatable. You just didn\'t have the tools to beat it.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Surrendered to a common objection without attempting to overcome it.'
        },
        double_down_fail: {
          id: 'double_down_fail',
          prompt: '❌ "Hey, I think we\'re done here." He closes the door firmly. You argued with a homeowner about his friend\'s competence. That\'s a reputation hit on the whole block.\n\nNever attack a prospect\'s existing relationships. Elevate yourself instead.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Alienated the homeowner by undermining his trusted contractor.'
        }
      }
    },

    // ── SCENARIO 3: THE INSURANCE OBJECTION ────────────────
    {
      id: 'insurance_fear',
      title: 'The Insurance Objection',
      subtitle: '"My rates will go up" and the claims maze',
      icon: '📋',
      difficulty: 'Intermediate',
      diffColor: '#F59E0B',
      description: 'A couple in their 30s answers together. They can see the storm damage from their kitchen window — shingle pieces all over the driveway. They KNOW they need help. But they\'re terrified of filing an insurance claim because their neighbor told them rates will skyrocket.',
      estimatedTime: '4-5 min',
      skillFocus: ['technical', 'objection', 'empathy'],
      nodes: {
        start: {
          id: 'start',
          prompt: 'Young couple at the door. He\'s holding a toddler. She says: "We actually need to talk to someone. We can see pieces of our roof in the yard. But our neighbor filed a claim two years ago for a pipe burst and their rates went up $400 a year. We just can\'t afford that."',
          options: [
            {
              text: '"I totally get the concern — nobody wants a surprise rate increase. Here\'s the thing that your neighbor probably doesn\'t realize: his claim was for a pipe burst, which insurance companies classify as an \'at-fault\' or \'maintenance\' event. Storm damage is completely different — it\'s classified as a \'catastrophic\' or \'Act of God\' event under Ohio law. Insurance companies cannot penalize you for weather events because you didn\'t cause them. It\'s like the difference between rear-ending someone versus getting hit by a deer."',
              nextNode: 'education_works',
              score: 28,
              tags: { technical: 30, objection: 30, empathy: 25, authority: 20 },
              feedback: 'Excellent. You acknowledged the fear, identified exactly where the misconception came from (the neighbor\'s pipe burst), explained the legal distinction clearly, and used an everyday analogy (car accident vs deer) that makes it click instantly. The couple went from scared to educated in 30 seconds.'
            },
            {
              text: '"Don\'t worry about rates — storm claims won\'t affect your premiums. We deal with this every day. Let me just take a look at the roof and we\'ll get you taken care of."',
              nextNode: 'not_convinced',
              score: 10,
              tags: { technical: 5, objection: 5, empathy: 0, closing: 10 },
              feedback: '"Don\'t worry about it" dismisses the concern they clearly spent time thinking about. And "we deal with this every day" is about YOU, not them. They needed education and reassurance — you gave them a brush-off and a pitch. The fear is still there.'
            },
            {
              text: '"That\'s actually a really common concern and I hear it every week. The short answer is no, storm claims don\'t raise your rates. But instead of just taking my word for it — I can show you on your own policy where it says that. Do you have your homeowner\'s policy number handy?"',
              nextNode: 'policy_review',
              score: 22,
              tags: { objection: 25, technical: 20, authority: 20, empathy: 15, rapport: 10 },
              feedback: 'Good approach — acknowledging it\'s common normalizes their fear, and offering to look at THEIR actual policy is concrete and credible. Slight risk that they don\'t have the policy handy and the conversation stalls, but the instinct to provide proof over promises is excellent.'
            }
          ]
        },
        education_works: {
          id: 'education_works',
          prompt: 'They look at each other. He nods slowly. She says: "Okay, that actually makes sense. But what about the deductible? I think ours is like $1,500 or $2,000. We don\'t have that kind of cash right now either."',
          options: [
            {
              text: '"That\'s a fair point. The deductible IS real — I\'m not going to tell you it\'s free because it\'s not. Depending on your policy, it\'s usually between $1,000 and $2,500. But here\'s how most of our customers handle it: the insurance payout for a full roof replacement on a home this size is typically $12,000 to $18,000. Your deductible is a fraction of that. Some people save up over the few weeks while the claim processes, and most contractors — us included — don\'t collect the deductible until the work is complete. So you have time."',
              nextNode: 'close_setup',
              score: 26,
              tags: { technical: 25, empathy: 25, objection: 25, closing: 20, rapport: 10 },
              feedback: 'Honest and strategic. You didn\'t lie about the cost (critical for trust), contextualized it against the total job value, offered a practical solution (time to save), and mentioned the payment timing without being slimy about it. They went from "we can\'t afford it" to "okay, we have time."'
            },
            {
              text: '"We actually have a program where we can work with you on the deductible. We\'ll make sure you\'re taken care of."',
              nextNode: 'sketchy_territory',
              score: 6,
              tags: { closing: 10, empathy: 5, objection: 0, technical: 0, authority: 0 },
              feedback: 'Danger zone. "Work with you on the deductible" is a red flag phrase in the insurance industry. Waiving or discounting the deductible is insurance fraud in most states. Even if you didn\'t mean it that way, the implication damages your credibility with anyone who knows the rules — including adjusters.'
            },
            {
              text: '"The deductible depends on your policy. Usually $1,000 to $2,500. But think of it this way — you\'re paying $2,000 to get a $15,000 roof. That\'s like finding a Rolex for $20 at a garage sale. It\'s a no-brainer."',
              nextNode: 'close_setup',
              score: 16,
              tags: { closing: 15, technical: 10, objection: 10, empathy: 5, rapport: 10 },
              feedback: 'The analogy is fun and memorable, but it trivializes a real financial concern for a young couple with a toddler. $2,000 might be their emergency fund. The underlying point is valid — the ROI is incredible — but the delivery needs more empathy and less salesmanship.'
            }
          ]
        },
        not_convinced: {
          id: 'not_convinced',
          prompt: 'She looks at him, then back at you. "I appreciate you coming by, but we\'re going to do some more research first. Can you leave us something with your info?"',
          options: [
            {
              text: '"Absolutely. Here\'s my card. And actually — let me also leave you this." You hand them a one-page FAQ you keep in your clipboard about storm damage claims, with the Ohio Department of Insurance phone number at the bottom. "That has answers to all the questions you\'re probably going to Google tonight. And the state insurance hotline is free — they can confirm everything I said. No pressure at all."',
              nextNode: 'research_save',
              score: 22,
              tags: { authority: 25, empathy: 20, objection: 15, rapport: 15, technical: 15 },
              feedback: 'Excellent pivot. The FAQ sheet is a professional move that most roofers don\'t have. Including the state insurance number shows supreme confidence — you\'re inviting them to fact-check you. This is trust-building at its highest level. They WILL call you back.'
            },
            {
              text: '"Sure, here\'s my card. Just know that the damage doesn\'t get better with time — every rain makes it worse. Don\'t wait too long."',
              nextNode: 'dead_end_ins',
              score: 8,
              tags: { closing: 5, technical: 5, empathy: 0, rapport: 0 },
              feedback: 'The parting scare tactic ("every rain makes it worse") on people who are already anxious just adds to their stress without giving them a reason to choose you. You\'re now associated with fear, not solutions. Leave them with value, not threats.'
            },
            {
              text: '"Of course. And hey — if it helps, I can put you in touch with Mrs. Henderson three doors down. She just went through the whole process with us last month. She can tell you exactly how it went from a homeowner\'s perspective."',
              nextNode: 'research_save',
              score: 18,
              tags: { rapport: 20, authority: 20, empathy: 15, closing: 10, objection: 10 },
              feedback: 'Social proof from an actual neighbor is powerful. It\'s one thing for you to say "it\'s easy" — it\'s another for their neighbor to say "it was easy." Make sure you actually have that customer\'s permission to refer people, though. Good move that keeps the door open.'
            }
          ]
        },
        policy_review: {
          id: 'policy_review',
          prompt: 'He goes inside and comes back with their insurance binder. She says: "Okay, show us. We have State Farm." They\'re cautiously engaged — this is your chance to be the expert, not the salesman.',
          options: [
            {
              text: '"Perfect — State Farm is one of the best for storm claims actually. Okay, see this section here..." You walk them through the peril coverage section, pointing out the wind/hail coverage, the replacement cost valuation, and the claims process timeline. "This is what protects you. And see this — \'catastrophic weather event\' — that\'s what our claim would fall under. Different category than your neighbor\'s pipe burst."',
              nextNode: 'close_setup',
              score: 26,
              tags: { technical: 30, authority: 30, empathy: 15, objection: 20, rapport: 15 },
              feedback: 'This is mastery. You took their own policy — the document they trust — and used it to prove your point. You didn\'t ask them to trust you. You showed them the truth in their own paperwork. Complimenting State Farm was smart (people identify with their insurance company). This couple is yours.'
            },
            {
              text: '"State Farm, great. They\'re usually easy to work with. I can\'t get into the specifics of your policy because I\'m not a licensed adjuster, but I can tell you that in my experience, State Farm covers storm damage on every claim I\'ve seen. Let\'s just get the inspection done and we\'ll go from there."',
              nextNode: 'close_setup',
              score: 16,
              tags: { authority: 15, empathy: 10, closing: 15, technical: 10, objection: 10 },
              feedback: 'Honest and safe — you correctly noted you\'re not an adjuster. But you also just punted on the exact opportunity you created. They got their policy out for YOU. If you can\'t walk them through the relevant sections, you\'ve just proven you don\'t know enough to help them with the claims process.'
            },
            {
              text: '"Oh nice, State Farm. Actually, let me just take a photo of your policy number and coverage page — I\'ll have our office research it and call you with exactly what you\'re covered for."',
              nextNode: 'sketchy_territory',
              score: 6,
              tags: { closing: 5, authority: 5, empathy: 0, rapport: 0 },
              feedback: 'Asking to photograph someone\'s insurance policy on a first visit is a massive red flag. You just went from trusted advisor to data collector. Even if your intentions are good, this feels invasive. Handle the education right here on the porch or don\'t offer.'
            }
          ]
        },
        close_setup: {
          id: 'close_setup',
          prompt: 'They\'re both nodding. He puts the policy binder down and looks at you. "Okay. What\'s the actual next step? What do you need from us?" She\'s already pulling up your Google reviews on her phone.',
          options: [
            {
              text: '"Here\'s how it works: Step one, I do a thorough inspection — roof, gutters, siding, any exterior damage. I document everything with photos and a detailed report. Step two, you file a claim with State Farm and reference my report. Step three, the adjuster comes out — I\'ll actually meet them here so we can walk the roof together and make sure nothing gets missed. You don\'t pay us anything until the insurance approves and the work is done. Want me to get started with the inspection?"',
              nextNode: 'scenario_win_ins',
              score: 28,
              tags: { closing: 30, technical: 25, authority: 25, empathy: 15, rapport: 10 },
              feedback: 'Perfect process close. You laid out every step (no surprises), offered to meet the adjuster (massive differentiator), clarified payment timing (they don\'t pay upfront), and ended with a simple yes/no ask. The fact that she\'s Googling your reviews while you\'re talking means you\'ve already won. This is a textbook deal.'
            },
            {
              text: '"Simple — I just need about 30 minutes to inspect and document everything, then I\'ll write it up and email you the report. You can use it however you want — file a claim, get other quotes, show it to your buddy. The inspection is free."',
              nextNode: 'scenario_win_ins',
              score: 22,
              tags: { closing: 20, authority: 20, empathy: 15, rapport: 15, technical: 10 },
              feedback: 'Good low-pressure close. Giving them the report to use "however you want" removes the commitment fear. Mentioning competing quotes actually builds trust because a confident company welcomes comparison. Lost some points by not mentioning the adjuster meeting — that\'s a key differentiator.'
            },
            {
              text: '"Let me go ahead and get the inspection done while the weather is good. I just need you to sign this authorization form — it just says you\'re giving me permission to be on the property. Standard liability stuff."',
              nextNode: 'scenario_win_ins',
              score: 16,
              tags: { closing: 20, authority: 15, technical: 10, empathy: 5, rapport: 5 },
              feedback: 'The authorization form is real and necessary, but introducing paperwork before you\'ve fully explained the process creates friction. "Sign this" makes people\'s defenses go up. Better to explain the full process first, get verbal agreement, THEN introduce the form as a formality.'
            }
          ]
        },
        sketchy_territory: {
          id: 'sketchy_territory',
          prompt: '🟠 They exchange an uncomfortable glance. "Actually... we need to think about this. Can you just leave your info?" The trust is damaged. They\'ll probably call a competitor.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Lost momentum through questionable practices. The couple will likely call someone else.'
        },
        research_save: {
          id: 'research_save',
          prompt: '🟡 They take your materials and shake your hand. "Thanks, this is really helpful. We\'re going to look into it tonight." He walks you to the driveway and asks one more question about the timeline. This will convert.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Built strong credibility through education. High probability of callback within 48 hours.'
        },
        scenario_win_ins: {
          id: 'scenario_win_ins',
          prompt: '✅ He extends his hand. "Let\'s do it." She says "Thank God someone finally explained this to us." You grab your ladder and documentation tablet.\n\nThis couple was READY to buy — they just needed someone to take the fear away. Education closes more deals than pressure ever will.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Closed by educating, not pressuring. Turned insurance fear into informed action.'
        },
        dead_end_ins: {
          id: 'dead_end_ins',
          prompt: '❌ She drops your card in the bowl by the door with 6 other roofing cards. You\'re just another storm chaser to them.\n\nThey\'ll file a claim in 6 months when their ceiling leaks, pay emergency prices, and wish they\'d acted sooner.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Failed to differentiate from competitors. Lost to inaction.'
        }
      }
    },

    // ── SCENARIO 4: THE SPOUSE DEFLECTION ──────────────────
    {
      id: 'spouse_deflect',
      title: 'The Spouse Deflection',
      subtitle: '"I need to talk to my husband/wife first"',
      icon: '💑',
      difficulty: 'Advanced',
      diffColor: '#EF4444',
      description: 'A woman in her late 30s answers the door. She\'s friendly, engaged, even looks at the storm damage you point out. Everything is going great — until you ask about the inspection. Suddenly: "I need to talk to my husband first. He handles all the house stuff."',
      estimatedTime: '3-4 min',
      skillFocus: ['objection', 'empathy', 'closing'],
      nodes: {
        start: {
          id: 'start',
          prompt: 'You\'ve been talking for 3 minutes. She\'s seen the granules, understands the storm damage, even said "wow, that\'s a lot." Then you ask about doing the inspection. Her body language shifts. "I mean... this all makes sense. But I really need to run it by my husband first. He\'s at work. Can you come back later?"',
          options: [
            {
              text: '"Absolutely — and honestly, it\'s a smart move to make this decision together. This is your home, it\'s a big deal. What time does he usually get home? I\'m in the neighborhood all week, so I can stop back when you\'re both here. That way I can answer his questions too and you don\'t have to play telephone."',
              nextNode: 'callback_set',
              score: 25,
              tags: { empathy: 30, rapport: 25, closing: 20, objection: 20 },
              feedback: 'Excellent. You validated the decision-making process, complimented the partnership, and turned "come back later" into a specific scheduled callback. "You don\'t have to play telephone" is the key insight — you\'re making her life easier, not harder. She doesn\'t have to convince him; you will.'
            },
            {
              text: '"I totally understand. Is there any chance you could give him a quick call right now? Sometimes it helps to have everyone on the same page while the information is fresh. I\'m happy to answer any questions he has right over the phone."',
              nextNode: 'phone_attempt',
              score: 20,
              tags: { closing: 25, objection: 20, empathy: 15, rapport: 10 },
              feedback: 'Solid attempt. The phone call approach works about 30% of the time — if the husband answers and is open to it, you can close on the spot. But it puts her in an awkward position of calling her spouse at work for a roofer. The phrasing is respectful enough that it doesn\'t feel pushy.'
            },
            {
              text: '"Sure, no problem. Here\'s my card. Have him give me a call when he\'s free and I\'ll come back out."',
              nextNode: 'dead_end_sp',
              score: 5,
              tags: { empathy: 5, rapport: 5, closing: 0, objection: 0 },
              feedback: 'You just handed control of the deal to someone who doesn\'t know you exist. Her husband will say "just toss the card" and that\'s the end. Never leave a deal in the hands of a third party who hasn\'t experienced your pitch. This was avoidable.'
            }
          ]
        },
        callback_set: {
          id: 'callback_set',
          prompt: '"He\'s usually home by 5:30. Yeah, that would actually be great — he\'d probably have a ton of questions." She looks relieved. Then she adds: "But honestly? He\'s really skeptical about contractors. He got burned by a plumber last year and now he doesn\'t trust anyone."',
          options: [
            {
              text: '"Got it — and I don\'t blame him. Getting burned by a contractor is one of the worst feelings because it\'s your home. Here\'s what I\'d suggest: before I come back, look us up together — No Big Deal Home Solutions on Google. Read the reviews, see the photos. That way when I show up, he\'s already done his homework and we can skip the trust-building and get straight to the facts about your roof. Sound good?"',
              nextNode: 'scenario_win_sp',
              score: 26,
              tags: { empathy: 25, rapport: 25, objection: 25, authority: 20, closing: 15 },
              feedback: 'Masterful. You acknowledged the pain (plumber burn), gave them a homework assignment that builds YOUR credibility before you even show up (Google reviews), and reframed the callback from "salesman returns" to "informed discussion." When you arrive at 5:30, the husband will have already seen your reviews. Half the battle is won before you knock.'
            },
            {
              text: '"No worries — I deal with skeptical husbands every day. By the time I\'m done showing him the damage photos and the insurance process, he\'ll be on board. I\'m pretty persuasive." You give a confident grin.',
              nextNode: 'overconfidence',
              score: 10,
              tags: { closing: 10, rapport: 5, empathy: 0, objection: 5 },
              feedback: '"Skeptical husbands" is dismissive and gendered. "I\'m pretty persuasive" is the last thing a burned homeowner wants to hear — they don\'t want to be persuaded, they want to be informed. Your confidence reads as arrogance here. The grin doesn\'t help.'
            },
            {
              text: '"Tell you what — I\'ll leave you this folder with photos of damage I found on your neighbors\' roofs, plus my company info, license number, and insurance certificate. Give him all of it tonight. If he wants to meet, great. If not, no pressure."',
              nextNode: 'strong_leave_behind',
              score: 20,
              tags: { authority: 25, rapport: 15, empathy: 15, objection: 15, technical: 10 },
              feedback: 'The leave-behind folder is professional and thorough — license, insurance cert, neighbor photos. This gives the husband tangible material to review instead of secondhand information. Slight miss on not scheduling a specific callback time, but the quality of the material compensates.'
            }
          ]
        },
        phone_attempt: {
          id: 'phone_attempt',
          prompt: 'She hesitates. "Uh... I can try." She calls him. He answers. She puts it on speaker: "Hey babe, there\'s a roofing guy here about the storm damage..." You hear him sigh. "ANOTHER one? Tell him we\'re fine. I\'ll look at it this weekend."',
          options: [
            {
              text: 'You speak up calmly: "Hey sir, totally understand the frustration — I know you\'re at work and this isn\'t ideal timing. I\'m [Name] with No Big Deal Home Solutions, local company here in Cincinnati. Your wife showed me some granule loss in the gutters that\'s consistent with what I\'m seeing on 7 out of 10 houses on your street. I don\'t need an answer right now — but if you can look at your south-facing slope this weekend, check for any dark spots or missing pieces, you\'ll know pretty quick if it\'s worth a call. We\'re around all week."',
              nextNode: 'phone_save',
              score: 24,
              tags: { empathy: 25, rapport: 20, authority: 20, objection: 20, technical: 15 },
              feedback: 'Perfect phone pivot. You acknowledged his frustration, introduced yourself properly, gave him a specific thing to check (south-facing slope), and removed pressure (no answer needed now). He\'ll check this weekend because you gave him a task. When he sees the damage, he\'ll feel your credibility.'
            },
            {
              text: '"Sir, I understand you\'re busy. But your wife has seen the damage and she\'s concerned. The storm hit hard and you\'re looking at possible leaks if this isn\'t addressed. Can I at least do a quick inspection while I\'m here so you have the information?"',
              nextNode: 'phone_backfire',
              score: 10,
              tags: { closing: 15, empathy: 5, rapport: 0, objection: 5 },
              feedback: 'Using "your wife is concerned" as leverage against the husband is manipulative and puts her in an uncomfortable position between you and her spouse. He\'ll feel pressured and she\'ll feel used. This poisons the entire dynamic. Never triangulate family members.'
            },
            {
              text: 'You stay quiet and let her handle the conversation. She tries: "Honey, it actually looks pretty bad..." He cuts her off: "We\'ll talk about it this weekend. I gotta go." Click.',
              nextNode: 'callback_recover',
              score: 14,
              tags: { empathy: 15, rapport: 10, objection: 5 },
              feedback: 'Staying quiet wasn\'t wrong — but it was a missed opportunity. You had 20 seconds of his attention and you let it go. Her attempting to sell it for you was never going to work because she\'s relaying secondhand info. You needed to speak up with a brief, credible statement that earned his attention.'
            }
          ]
        },
        callback_recover: {
          id: 'callback_recover',
          prompt: 'She hangs up, looking embarrassed. "Sorry about that. He\'s been really stressed with work." She\'s deflated and the energy of the conversation has dropped.',
          options: [
            {
              text: '"Hey, please don\'t apologize — I get it. Work stress plus house stuff is a lot. Listen, here\'s what I\'d recommend: take a few photos of those granules in the gutter and the shingle pieces in the yard, and text them to him tonight. Pictures are worth a thousand words. And I\'ll leave my card with my cell — if he wants to ask questions or set something up, I\'m one text away. No rush."',
              nextNode: 'strong_leave_behind',
              score: 22,
              tags: { empathy: 30, rapport: 25, closing: 15, objection: 10, authority: 10 },
              feedback: 'Emotionally intelligent recovery. You removed her embarrassment, empathized with the work stress, and gave her an action item that SHE controls (take photos). The phone photo approach is brilliant because he can\'t dismiss photographic evidence the way he can dismiss a secondhand description. You\'ve armed her with ammunition.'
            },
            {
              text: '"No worries. Look, the bottom line is your roof has damage and it\'s not going to fix itself. I can come back Saturday morning when he\'s home — would 10am work?"',
              nextNode: 'callback_set_mid',
              score: 14,
              tags: { closing: 20, objection: 10, empathy: 5, rapport: 5 },
              feedback: 'Functional but tone-deaf to the emotional moment. She just felt embarrassed by her husband shutting down the conversation, and you responded with a bottom-line statement and a schedule push. The Saturday callback is a good tactical move, but the delivery needed more warmth.'
            },
            {
              text: '"That happens a lot. Wives see the damage, husbands think it can wait. But you\'re right to be concerned — waiting usually makes it worse and more expensive."',
              nextNode: 'dead_end_sp',
              score: 4,
              tags: { empathy: 0, rapport: 0, objection: 0 },
              feedback: '"Wives see the damage, husbands think it can wait" is a gendered stereotype that insults both of them. You just reduced their partnership to a cliché. Regardless of whether there\'s a pattern, saying it out loud is unprofessional and condescending. This is deal-ending language.'
            }
          ]
        },
        // Terminal nodes
        scenario_win_sp: {
          id: 'scenario_win_sp',
          prompt: '✅ She\'s genuinely smiling. "Yeah, we\'ll look you up tonight. Come back around 5:30 tomorrow?" She shakes your hand and waves as you walk to the next house.\n\nWhen you return tomorrow, the husband will already have read your reviews. The hardest part is done.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Turned a spouse deflection into a scheduled two-person callback with pre-built credibility.'
        },
        strong_leave_behind: {
          id: 'strong_leave_behind',
          prompt: '🟡 She takes the materials and looks through them on the spot. "This is really professional. I\'ll show him tonight." She means it — this isn\'t a brush-off.\n\nThe photos of neighbor damage and your credentials folder will do the selling for you overnight.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Armed the decision-maker with professional materials. Strong callback probability.'
        },
        phone_save: {
          id: 'phone_save',
          prompt: '🟡 Brief silence on the phone. Then: "...south-facing slope. Okay, I\'ll look this weekend. What was the company name?" He\'s engaged now. She mouths "thank you" to you as you hand over your card.\n\nYou gave a skeptic a specific action item. When he checks Saturday morning, he\'ll find exactly what you described.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Turned a hostile phone call into an informed prospect. Weekend callback likely.'
        },
        phone_backfire: {
          id: 'phone_backfire',
          prompt: '❌ He hangs up. She looks uncomfortable. "I don\'t think this is a good time. Thanks for coming by." She closes the door.\n\nYou turned a cooperative homeowner into an embarrassed one by using her as leverage against her spouse.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Alienated both homeowners by triangulating the couple.'
        },
        overconfidence: {
          id: 'overconfidence',
          prompt: '🟠 She forces a smile. "Right... okay. We\'ll see." The energy is off. She gives you a polite wave but the vibe has shifted. She\'s not going to sell you to her husband because you just made her uncomfortable.\n\nConfidence is good. Cockiness is poison.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Overconfidence undermined the rapport you built. Callback unlikely.'
        },
        callback_set_mid: {
          id: 'callback_set_mid',
          prompt: '🟡 "I guess Saturday could work. Let me check with him." It\'s soft — about 50/50 whether she follows through.\n\nA scheduled callback without emotional buy-in is just a calendar entry that gets cancelled.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Got a tentative callback but without strong emotional engagement.'
        },
        dead_end_sp: {
          id: 'dead_end_sp',
          prompt: '❌ "Thanks. I\'ll let him know." She gives a flat smile and closes the door. She won\'t let him know.\n\nThe spouse deflection is a skill check. You didn\'t pass.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Failed to navigate the spouse objection. Deal is dead.'
        }
      }
    },

    // ── SCENARIO 5: THE SOFT CLOSE ─────────────────────────
    {
      id: 'soft_close',
      title: 'The Soft Close',
      subtitle: 'They\'re interested but won\'t commit',
      icon: '🎯',
      difficulty: 'Advanced',
      diffColor: '#EF4444',
      description: 'Everything went right. The homeowner is friendly, sees the damage, understands the insurance process, even said "this sounds great." But when it\'s time to commit to the inspection, they hesitate. They\'re not saying no — they\'re just not saying yes. This is the hardest close in door-to-door.',
      estimatedTime: '3-4 min',
      skillFocus: ['closing', 'empathy', 'rapport'],
      nodes: {
        start: {
          id: 'start',
          prompt: 'He\'s a retired guy, early 60s. Super friendly. Loved your explanation of the insurance process. Has visible damage. Even said "Man, I should really get this taken care of." But now he\'s rocking on his heels. "Let me think about it over the weekend. I don\'t like making quick decisions. I want to do my due diligence."',
          options: [
            {
              text: '"I completely respect that — my dad\'s the same way. Never rushes into anything. Tell you what: the inspection itself isn\'t a decision about anything. It\'s literally just gathering information. No paperwork, no commitment, no payment. It\'s like going to the doctor for a checkup — doesn\'t mean you\'re getting surgery. But at least you\'ll know what you\'re dealing with. Want me to just get the information for you so you have it when you DO make your decision?"',
              nextNode: 'reframed',
              score: 28,
              tags: { closing: 30, empathy: 25, rapport: 25, objection: 20 },
              feedback: 'Masterclass soft close. The dad reference creates instant relatability. The doctor analogy perfectly reframes the inspection from "commitment" to "information gathering." And the close ("want me to get the information") is framed as helping his decision process, not pushing him into one. This is elite-level reframing.'
            },
            {
              text: '"Sure, take your time. I\'ll be in the area next week too. Here\'s my card — call me whenever you\'re ready."',
              nextNode: 'dead_end_soft',
              score: 5,
              tags: { rapport: 10, empathy: 5 },
              feedback: 'He literally said "I should really get this taken care of" and you just... left? This man was 80% of the way to yes. He didn\'t need pressure — he needed a reason to say yes TODAY instead of "someday." You gave him permission to procrastinate forever.'
            },
            {
              text: '"I totally get it. But here\'s the thing — I\'m only in this neighborhood today and tomorrow. After that, I\'ve got another subdivision booked. If you want the free inspection, this is the best window. I\'d hate for you to miss out."',
              nextNode: 'scarcity_play',
              score: 14,
              tags: { closing: 20, objection: 10, empathy: 0, rapport: 0 },
              feedback: 'Artificial scarcity with a friendly retiree who values due diligence. He\'s not going to be pressured by your schedule — he\'s retired, his whole thing is patience. This technique works on impulse buyers, not methodical thinkers. Read the personality type and match your approach.'
            }
          ]
        },
        reframed: {
          id: 'reframed',
          prompt: 'He chuckles. "Ha — the doctor analogy. That\'s good." He looks at his roof, then at you. "I mean... I DO want to know what\'s up there. But what happens if you find damage? Am I locked into anything?"',
          options: [
            {
              text: '"Zero. I\'ll come down, show you every photo on my tablet, and give you the full report. Then it\'s 100% your decision. You can file a claim, you can get three more opinions, you can frame the photos and put them on your wall — totally your call. Most of my customers take a day or two to think about it after the inspection. That\'s the smart move."',
              nextNode: 'scenario_win_soft',
              score: 26,
              tags: { closing: 25, empathy: 25, rapport: 20, objection: 20, authority: 10 },
              feedback: 'Perfect. Zero pressure, total control in his hands, humor that matches his energy (frame the photos), and the social proof that "most customers take a day or two" makes his cautious nature feel validated, not criticized. He\'s going to say yes because you made yes feel safe.'
            },
            {
              text: '"Nope, no commitment at all. And honestly, if I DON\'T find damage, I\'ll tell you straight up. I\'m not going to make up problems to get a sale. That\'s not how we operate. Your roof might be perfectly fine — let\'s find out."',
              nextNode: 'scenario_win_soft',
              score: 24,
              tags: { authority: 25, empathy: 20, rapport: 20, closing: 20, objection: 15 },
              feedback: 'Strong honesty play. Saying "I might find nothing" is counterintuitive but incredibly powerful with analytical types. It signals that your assessment is trustworthy because you\'re willing to walk away empty-handed. For a "due diligence" person, this is exactly the credibility signal he needed.'
            },
            {
              text: '"Not locked into anything. But I will say — if there IS damage and you decide to file a claim, we should move on it within the next couple months. Insurance companies have timelines on storm claims. So getting the inspection done now gives you the most runway to make your decision."',
              nextNode: 'scenario_win_soft',
              score: 20,
              tags: { closing: 20, technical: 20, objection: 15, empathy: 10, authority: 10 },
              feedback: 'Good answer that introduces real urgency (claim timelines) without being pushy about it. The "most runway" framing is smart — it positions the inspection as giving him MORE time to decide, not less. Loses a few points because the timeline mention slightly undercuts the "no pressure" energy.'
            }
          ]
        },
        scarcity_play: {
          id: 'scarcity_play',
          prompt: 'He smiles but shakes his head. "Son, I\'m retired. I\'ve got nothing but time. If you can\'t come back, someone else will." He\'s not being rude — he\'s just immune to urgency tactics. You need to shift strategy.',
          options: [
            {
              text: '"Ha — fair enough. You know what, you\'re right. Let me take a different approach. The inspection isn\'t about my schedule — it\'s about your roof. How about this: I\'ll do the inspection right now, free, no obligation. If I find damage, I\'ll leave you the report and you can take as long as you want to decide. If I find nothing, I\'ll save you the headache of wondering. Either way, you win."',
              nextNode: 'reframed',
              score: 22,
              tags: { empathy: 20, closing: 20, rapport: 20, objection: 15, authority: 10 },
              feedback: 'Great recovery. You acknowledged your failed tactic ("fair enough"), showed humility, and pivoted to a no-lose frame. "Either way, you win" is exactly what a due-diligence person wants to hear. You adapted to his personality instead of forcing your approach. That\'s professional growth in real-time.'
            },
            {
              text: '"You know what, you\'re absolutely right. I apologize for the pressure. Look — here\'s what I CAN do. I\'ll take some photos from the ground right now, just of the visible damage. No ladder, takes 2 minutes. I\'ll text them to you. That way when you DO your due diligence, you\'ve got evidence to start with."',
              nextNode: 'ground_photos',
              score: 20,
              tags: { empathy: 20, rapport: 20, authority: 15, closing: 10, technical: 10 },
              feedback: 'Humble and smart. The apology for pressure builds respect with this personality type. Ground-level photos are a tiny ask that provides genuine value. And texting them to him means you now have his phone number — which is worth more than the inspection appointment today. Well played.'
            },
            {
              text: '"Haha, alright, I hear you. I\'ll be around the rest of the week though. So when you\'re ready, call me and I\'ll come right over. Here\'s my card."',
              nextNode: 'dead_end_soft',
              score: 8,
              tags: { rapport: 10, empathy: 10 },
              feedback: 'You laughed it off and defaulted to the card drop. His "someone else will" should have been a wake-up call — he just told you he has no loyalty to you. Without a specific next step, you\'re just another card in a stack. A retired homeowner with visible damage is a guaranteed close for whoever gets the inspection. Don\'t let it be your competitor.'
            }
          ]
        },
        ground_photos: {
          id: 'ground_photos',
          prompt: '🟡 He gives you his number. "Yeah, text me the photos. That\'s fair." You snap shots of the lifted ridge cap and the missing shingles from the ground. You text them while standing in his driveway. "Got em," he says, checking his phone.\n\nYou now have his phone number, he has photographic evidence, and he knows your name. Call him Wednesday.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Traded a failed scarcity play for his phone number and photo evidence. Strong follow-up position.'
        },
        scenario_win_soft: {
          id: 'scenario_win_soft',
          prompt: '✅ He rocks forward on his toes. Long pause. Then: "Alright. What the heck — go ahead and take a look. But I\'m watching from down here." He points at a lawn chair and grins.\n\nHe was always going to say yes. He just needed to feel like it was HIS decision on HIS timeline. You let him feel that.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Closed a methodical thinker by reframing the inspection as information, not commitment.'
        },
        dead_end_soft: {
          id: 'dead_end_soft',
          prompt: '❌ He waves and goes inside. The door closes gently. He\'s not mad — he just wasn\'t convinced to act today. And "someday" is where deals go to die.\n\nA competitor will knock tomorrow, adapt to his personality, and get the inspection.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Failed to close a warm prospect. Gave a competitor the opening.'
        }
      }
    },

    // ── SCENARIO 6: THE CALLBACK ─────────────────────────────
    {
      id: 'the_callback',
      title: 'The Callback',
      subtitle: 'Following up on a lead that went cold',
      icon: '📞',
      difficulty: 'Intermediate',
      diffColor: '#F59E0B',
      description: 'You inspected this property 2 weeks ago. The homeowner was interested but said "let me think about it." They stopped returning texts. You\'re driving by and notice they\'re home. Time to knock again.',
      estimatedTime: '3-4 min',
      skillFocus: ['closing', 'rapport', 'objection'],
      nodes: {
        start: {
          id: 'start',
          prompt: 'He opens the door and recognizes you. "Oh hey... yeah, sorry I haven\'t called back. Things have been crazy." He looks uncomfortable — classic avoidance.',
          options: [
            {
              text: '"No worries at all, I totally get it — life gets busy. I was in the neighborhood and just wanted to drop off the updated scope from your insurance company. Good news is everything got approved. Mind if I walk you through the numbers real quick? Won\'t take 5 minutes."',
              nextNode: 'reengaged',
              score: 25,
              tags: { closing: 25, rapport: 20, authority: 15, empathy: 15 },
              feedback: 'Perfect callback technique. You relieved the guilt ("no worries"), gave a REASON for the visit (updated scope), dropped good news (approved), and made the ask low-commitment ("5 minutes"). This is how you resurrect dead leads.'
            },
            {
              text: '"Hey! Just checking in — have you made a decision yet?"',
              nextNode: 'deflect',
              score: 8,
              tags: { closing: 5, rapport: 5, empathy: 5 },
              feedback: 'This is a yes/no question where "no" is the easy answer. Never ask if they\'ve decided — give them NEW information that moves them forward.'
            },
            {
              text: '"I noticed you haven\'t signed the contract yet. The crew has availability next week but I need to know today."',
              nextNode: 'pressure_fail',
              score: 5,
              tags: { closing: 10, empathy: 0, rapport: 0 },
              feedback: 'Artificial urgency on a cold lead reads as desperation. He ghosted you for a reason — pressure won\'t fix that. You just confirmed why he was avoiding you.'
            }
          ]
        },
        reengaged: {
          id: 'reengaged',
          prompt: 'He relaxes a bit. "Yeah okay, show me what you\'ve got." You walk through the scope. He nods along. Then: "This all looks good, but I got another quote that came in lower."',
          options: [
            {
              text: '"That makes sense — you should shop around. Can I see their quote? I\'ve found most lower bids leave out items that your insurance already approved. If they match, I\'ll shake your hand and wish you well. But if they\'re cutting corners, you\'d want to know."',
              nextNode: 'callback_win',
              score: 25,
              tags: { objection: 30, authority: 20, empathy: 15, closing: 15 },
              feedback: 'Brilliant. You validated shopping around, offered to compare instead of compete, and positioned yourself as the expert who catches what others miss. The "shake your hand" line shows confidence, not desperation.'
            },
            {
              text: '"Price isn\'t everything — you get what you pay for."',
              nextNode: 'callback_mid',
              score: 10,
              tags: { authority: 10, objection: 5 },
              feedback: 'True but cliché. Everyone says this. It doesn\'t differentiate you or help him understand the SPECIFIC differences. Show, don\'t tell.'
            },
            {
              text: '"I can match their price. What number do I need to beat?"',
              nextNode: 'callback_loss',
              score: 5,
              tags: { closing: 10, authority: 0 },
              feedback: 'Racing to the bottom on price kills your margin and your authority. If you can "match any price," what does your price even mean? You just told him your quote was inflated.'
            }
          ]
        },
        deflect: {
          id: 'deflect',
          prompt: '"Still thinking about it. I\'ll call you when I\'m ready." He starts closing the door.',
          options: [
            {
              text: '"Totally fair. One thing I should mention — your insurance has a 12-month window from the storm date to file supplementals if needed. We\'re at month 5 now. I\'d hate for you to lose that coverage. Want me to put a reminder in for month 10 so we don\'t miss the deadline?"',
              nextNode: 'callback_mid',
              score: 20,
              tags: { technical: 20, closing: 15, empathy: 10 },
              feedback: 'Good recovery. You added real urgency (deadline) without being pushy, and offered a service (reminder) that keeps you in the conversation. He now has a reason to stay engaged.'
            },
            {
              text: '"Okay, sounds good. Just call me when you\'re ready."',
              nextNode: 'callback_loss',
              score: 3,
              tags: { rapport: 5 },
              feedback: 'He won\'t call. "Call me when you\'re ready" is the salesperson\'s way of giving up while pretending they didn\'t. Set a specific follow-up or lose the deal.'
            }
          ]
        },
        pressure_fail: {
          id: 'pressure_fail',
          prompt: '"Yeah... I\'m going to pass. Thanks though." He closes the door firmly. Your pressure confirmed his instinct to avoid you.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Pushed a cold lead further away with urgency tactics. This one is gone for good.'
        },
        callback_win: {
          id: 'callback_win',
          prompt: '✅ He pulls up the competing quote on his phone. You spot 3 line items his insurance approved that the competitor left out — $4,200 worth. His eyes go wide. "So they were going to skip that stuff?" He signs your contract that afternoon.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Resurrected a dead lead by adding value, not pressure. Expertise closed the deal.'
        },
        callback_mid: {
          id: 'callback_mid',
          prompt: '🔸 He appreciates the info but isn\'t ready to commit today. However, he saves your number, agrees to a specific follow-up date, and you leave with the relationship intact. Solid position.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Didn\'t close today but maintained the relationship and created a reason to follow up. Still alive.'
        },
        callback_loss: {
          id: 'callback_loss',
          prompt: '❌ Two months pass. You drive by and see a competitor\'s crew on his roof. He went with the lower bid. You never got the chance to show why your scope was better because you didn\'t create urgency or differentiate.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Lost a qualified lead to a competitor because you didn\'t control the follow-up.'
        }
      }
    },

    // ── SCENARIO 7: THE ANGRY NEIGHBOR ──────────────────────
    {
      id: 'angry_neighbor',
      title: 'The Angry Neighbor',
      subtitle: 'Dealing with hostility and turning it around',
      icon: '😤',
      difficulty: 'Advanced',
      diffColor: '#EF4444',
      description: 'You\'re halfway through an inspection on the Johnsons\' property when their next-door neighbor storms over. He\'s had a bad experience with a storm chaser 2 years ago and is convinced you\'re running a scam. He\'s loud enough for the whole block to hear.',
      estimatedTime: '3-4 min',
      skillFocus: ['empathy', 'authority', 'rapport'],
      nodes: {
        start: {
          id: 'start',
          prompt: '"HEY! Are you one of those roofing guys going door to door? My last roofer took my deposit and disappeared. You guys are all the same!" He\'s standing in the Johnsons\' driveway, arms crossed, voice raised. Mrs. Johnson looks nervous.',
          options: [
            {
              text: '"I hear you, sir, and I\'m sorry that happened to you — that\'s exactly the kind of thing that gives our industry a bad name. I\'m [Name] with No Big Deal Home Solutions. We\'re licensed and bonded in [state] — here\'s my card with our license number. If you want to verify us right now, Google our name. I\'d actually love to hear what happened with your situation."',
              nextNode: 'calming_down',
              score: 25,
              tags: { empathy: 30, authority: 25, rapport: 20 },
              feedback: 'Masterclass in de-escalation. You: validated his anger, acknowledged the industry problem, provided verifiable credentials, and expressed genuine interest in his story. The neighbor is now a potential customer, not a threat.'
            },
            {
              text: '"Sir, I\'m working with the Johnsons right now. This is their property. If you have concerns, I\'d be happy to talk to you at your house."',
              nextNode: 'still_angry',
              score: 12,
              tags: { authority: 15, rapport: 5 },
              feedback: 'Technically correct but feels dismissive. You redirected rather than engaged. He doesn\'t feel heard, and Mrs. Johnson just watched you tell her neighbor to go away. Not great optics.'
            },
            {
              text: '"I\'m sorry you had a bad experience, but we\'re nothing like that. We\'re a legitimate company."',
              nextNode: 'still_angry',
              score: 8,
              tags: { empathy: 10, rapport: 5 },
              feedback: '"We\'re nothing like that" is what every scammer says. You offered zero proof and no real acknowledgment of his pain. Words without evidence are worthless here.'
            }
          ]
        },
        calming_down: {
          id: 'calming_down',
          prompt: 'His body language softens slightly. "Well... this guy said he was licensed too. Took $3,000 up front and never came back. I reported him but nothing happened." Mrs. Johnson is listening intently. The neighbor adds: "You know, my roof\'s been leaking since that storm too..."',
          options: [
            {
              // 2026-09-25 (deposit rule): this line taught reps to promise
              // "zero deposit — insurance pays us after completion". On a
              // claim the deductible is due at signing and the ACV check up
              // front (deposit-rule.js); the deductible is never waived.
              text: '"That\'s infuriating. Listen — here\'s how we\'re different. Nothing is due until you\'ve signed a written contract that spells out every payment. On an insurance claim the only money out of your own pocket is your deductible — the rest is your insurance company\'s money, paid as the claim pays out. I know trust is earned, not given. How about I swing by your place after I finish here and take a look at that leak? No charge, no commitment — just an honest assessment."',
              nextNode: 'neighbor_win',
              score: 25,
              tags: { empathy: 20, closing: 20, authority: 20, rapport: 15 },
              feedback: 'Turned an angry neighbor into your next customer. A clear, written payment schedule — nothing before a signed contract, only the deductible out of pocket on a claim — directly addresses his trauma. Offering to help the leak makes you the solution to his problem, not the source of another one. Two deals from one doorstep.'
            },
            {
              text: '"I\'d be happy to help. Let me finish with the Johnsons and I can look at your roof after."',
              nextNode: 'neighbor_mid',
              score: 15,
              tags: { rapport: 15, closing: 10 },
              feedback: 'Good — you didn\'t miss the opportunity. But you didn\'t address his specific fear (deposits/payment). Explaining your payment structure would have sealed it.'
            }
          ]
        },
        still_angry: {
          id: 'still_angry',
          prompt: 'He\'s not satisfied. "Yeah, that\'s what the last guy said too." He turns to Mrs. Johnson: "Be careful with these guys." He walks away. Mrs. Johnson\'s confidence in you just took a hit.',
          options: [
            {
              text: '"Mrs. Johnson, I totally understand his frustration. Scam roofers are a real problem after storms. Here\'s what separates us — we don\'t collect payment until the job is complete and inspected. Your insurance company pays us, not you. Want to call our office right now so you can verify everything?"',
              nextNode: 'neighbor_mid',
              score: 18,
              tags: { authority: 20, empathy: 15, closing: 10, rapport: 10 },
              feedback: 'Good recovery. You addressed the elephant in the room instead of pretending it didn\'t happen. Offering real-time verification rebuilds the trust the neighbor damaged.'
            },
            {
              text: 'Ignore the situation and continue the inspection as if nothing happened.',
              nextNode: 'neighbor_loss',
              score: 3,
              tags: {},
              feedback: 'Mrs. Johnson just heard a scary story about roofers. Pretending it didn\'t happen tells her you don\'t care about her concerns. She\'s second-guessing everything now.'
            }
          ]
        },
        neighbor_win: {
          id: 'neighbor_win',
          prompt: '✅ You finish Mrs. Johnson\'s inspection, then walk next door. The neighbor — Tom — shows you the leak. It\'s a cracked boot vent, easy fix but also storm damage on the north slope. He files his claim with your photo report in hand. Two signed contracts from one hostile encounter. Tom becomes your biggest referral source on the block.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Turned hostility into trust. Two deals from one confrontation. Tom now vouches for you to every neighbor.'
        },
        neighbor_mid: {
          id: 'neighbor_mid',
          prompt: '🔸 Mrs. Johnson proceeds cautiously. You complete the inspection and she agrees to file the claim. The neighbor situation created some friction but didn\'t kill the deal. You didn\'t win Tom over today though — that\'s a missed second deal.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Saved the primary deal but missed the opportunity to convert the angry neighbor into a customer.'
        },
        neighbor_loss: {
          id: 'neighbor_loss',
          prompt: '❌ Mrs. Johnson calls you the next day and cancels. "I talked to my neighbor and we decided to wait." Tom\'s story planted enough doubt that she walked. Two lost deals.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Failed to address the trust damage from the neighbor encounter. Lost both deals.'
        }
      }
    },

    // ── SCENARIO 8: THE PRICE NEGOTIATOR ────────────────────
    {
      id: 'price_negotiator',
      title: 'The Price Negotiator',
      subtitle: 'When they want you to beat the other guy\'s number',
      icon: '💰',
      difficulty: 'Advanced',
      diffColor: '#EF4444',
      description: 'You\'ve done the inspection, the claim is filed, insurance approved the scope. The homeowner calls you in and shows you a competitor\'s quote that\'s $2,800 lower. He likes you but says he can\'t justify paying more. The other company is a legitimate local roofer — not a storm chaser.',
      estimatedTime: '3-4 min',
      skillFocus: ['closing', 'technical', 'authority'],
      nodes: {
        start: {
          id: 'start',
          prompt: '"Look, I like you guys, but $2,800 is $2,800. This other company is local, they\'ve been around 10 years. Why should I pay more?" He\'s sitting at his kitchen table with both quotes side by side.',
          options: [
            {
              text: '"Fair question. May I see their scope? Because if your insurance approved $X, and they\'re coming in $2,800 under that, it means either they\'re using cheaper materials, fewer layers, or skipping line items your insurance is paying for. Let me show you exactly where the difference is."',
              nextNode: 'line_by_line',
              score: 25,
              tags: { technical: 30, authority: 25, closing: 15, objection: 10 },
              feedback: 'The scope comparison is the ultimate weapon. Insurance approved a specific amount for specific work. If the competitor is cheaper, they\'re either cutting scope or pocketing the difference. Showing this item by item turns price objection into a quality conversation.'
            },
            {
              text: '"I totally understand. Let me see if I can work with my team to get closer to that number."',
              nextNode: 'race_bottom',
              score: 8,
              tags: { rapport: 10, closing: 5 },
              feedback: 'You just told him your price was negotiable, which means it was inflated. Now he\'ll always wonder what YOUR real price is. Never race to the bottom — differentiate on value.'
            },
            {
              text: '"You get what you pay for. Our materials are premium and our crew is the best in the area."',
              nextNode: 'generic_push',
              score: 10,
              tags: { authority: 10, technical: 5 },
              feedback: 'Generic and unverifiable. Every roofer claims premium materials and the best crew. Show the SPECIFIC differences in the scope instead of making claims.'
            }
          ]
        },
        line_by_line: {
          id: 'line_by_line',
          prompt: 'You compare the scopes. You find the competitor left out ice & water shield on the eaves, downgraded the underlayment from synthetic to felt, and didn\'t include starter strips. Total value of shortcuts: about $2,400. His eyes widen. "So my insurance is paying for that stuff and they\'re just... not doing it?"',
          options: [
            {
              text: '"Exactly. Your insurance approved and is paying for those items. You\'re entitled to that level of work. If a contractor doesn\'t install what\'s on the scope, and you have a leak in 3 years, the insurance company can deny the next claim because the work wasn\'t done to spec. That $2,800 savings could cost you a $15,000 denial."',
              nextNode: 'price_win',
              score: 25,
              tags: { technical: 25, closing: 25, authority: 20, empathy: 10 },
              feedback: 'You connected the shortcuts to a real financial risk. The $2,800 savings vs. $15,000 denial math does the closing for you. This is consultative selling at its finest.'
            },
            {
              text: '"Yeah, they\'re cutting corners. You should go with us."',
              nextNode: 'price_mid',
              score: 12,
              tags: { closing: 10, authority: 5 },
              feedback: 'You identified the problem but didn\'t explain the CONSEQUENCE. "Cutting corners" is vague. Tell him what happens when those items are missing — leaks, claim denials, warranty voids.'
            }
          ]
        },
        race_bottom: {
          id: 'race_bottom',
          prompt: 'You drop your price by $2,000. He signs, but your margin is destroyed. You made less than $800 on a full roof replacement. Your crew notices the thin margins and quality starts to slip. The homeowner calls 6 months later with a leak.',
          options: [],
          terminal: true,
          outcome: 'loss',
          summary: 'Won the job but lost the profit. Thin margins lead to corners cut and callbacks. This is how companies go under.'
        },
        generic_push: {
          id: 'generic_push',
          prompt: '"That\'s what they all say. Can you give me a specific reason?" He\'s not convinced by marketing talk.',
          options: [
            {
              text: '"You\'re right — let me show you specifically. Can I see their quote? I\'ll compare it line by line against what your insurance approved."',
              nextNode: 'line_by_line',
              score: 18,
              tags: { technical: 15, authority: 10, empathy: 10, objection: 10 },
              feedback: 'Good recovery — you acknowledged his point and pivoted to specifics. Should have led with this.'
            },
            {
              text: '"I understand. If price is the most important factor, I respect that. But I want you to have all the information before you decide."',
              nextNode: 'price_mid',
              score: 12,
              tags: { rapport: 10, empathy: 10 },
              feedback: 'Professional but doesn\'t provide the information you say he should have. Follow through with the scope comparison.'
            }
          ]
        },
        price_win: {
          id: 'price_win',
          prompt: '✅ He calls the competitor and cancels. "I\'m going with the company that actually does the full scope." He signs your contract, full price. He also refers his brother-in-law two weeks later. Premium positioning creates premium referrals.',
          options: [],
          terminal: true,
          outcome: 'win',
          summary: 'Won on value, not price. Full margin preserved. Scope comparison was the deciding factor.'
        },
        price_mid: {
          id: 'price_mid',
          prompt: '🔸 He\'s leaning your way but still on the fence. He asks for a day to think about it. You schedule a follow-up. The deal is alive but not closed.',
          options: [],
          terminal: true,
          outcome: 'partial',
          summary: 'Good positioning but didn\'t close today. The scope comparison would have been the knockout punch.'
        }
      }
    }
  ];

  // ════════════════════════════════════════════════════════════
  // OBJECTION FLASHCARDS — Rapid-Fire Mode
  // ════════════════════════════════════════════════════════════

  const OBJECTIONS = [
    {
      id: 'obj_01',
      objection: '"I\'m not interested."',
      context: 'Cold open — they haven\'t heard your pitch yet',
      options: [
        { text: '"Totally understand. I\'m not here to sell anything — just letting folks know about the storm damage we\'re finding. Have you noticed any shingle pieces in your yard?"', score: 3, correct: true, explanation: 'Removes sales pressure, pivots to a question that engages curiosity. Classic redirect.' },
        { text: '"Can I just have 30 seconds to explain?"', score: 1, correct: false, explanation: 'Begging for time is weak. They said they\'re not interested — give them a reason to BE interested instead of asking for permission.' },
        { text: '"Okay, no problem! Have a great day."', score: 0, correct: false, explanation: 'Zero effort. They said "not interested" which means they haven\'t heard enough to decide. You quit before starting.' },
        { text: '"Are you the homeowner? Because this is actually about protecting your home from storm damage."', score: 2, correct: false, explanation: 'Decent — asking about ownership qualifies the prospect. But "protecting your home" sounds like a pitch. Softer approach works better.' }
      ],
      tags: { objection: 30, empathy: 20, rapport: 10 }
    },
    {
      id: 'obj_02',
      objection: '"I already have a roofer."',
      context: 'They have a trusted contractor relationship',
      options: [
        { text: '"That\'s great — loyalty to a good contractor is rare. Has he been by since the storm to check on you?"', score: 3, correct: true, explanation: 'Validates loyalty, plants doubt with a question they probably haven\'t thought about.' },
        { text: '"We\'re probably better. Want a free second opinion?"', score: 0, correct: false, explanation: 'Insulting their contractor is insulting their judgment. Never attack the competition — elevate yourself.' },
        { text: '"Does he document storm damage for insurance? General roofers often miss line items."', score: 2, correct: false, explanation: 'Valid point but delivered as an attack on their guy. Better to ask the question without the follow-up dig. (And never pitch NBD as the insurance-claims pro — Kentucky law (KRS 367.628) bars a contractor from representing or negotiating on a homeowner\'s claim or marketing itself as a claims or insurance expert, and in Ohio negotiating a claim for pay takes a public adjuster license.)' },
        { text: '"No problem. Here\'s my card if you ever need another option."', score: 1, correct: false, explanation: 'Passive surrender. The card goes in the trash. You didn\'t even try to differentiate yourself.' }
      ],
      tags: { objection: 30, rapport: 20, authority: 10 }
    },
    {
      id: 'obj_03',
      objection: '"Won\'t filing a claim raise my rates?"',
      context: 'They\'re interested but fear insurance consequences',
      options: [
        { text: '"Storm damage is classified as a no-fault event — by law, they can\'t raise your rates for weather claims. It\'s different from an at-fault claim like a pipe burst."', score: 3, correct: true, explanation: 'Direct, factual, and distinguishes weather vs at-fault claims. This is the education that closes.' },
        { text: '"No, it won\'t. Don\'t worry about that."', score: 1, correct: false, explanation: 'Dismissive. They asked a legitimate question and you waved it off. Explain WHY, not just "don\'t worry."' },
        { text: '"That\'s a myth. Insurance claims don\'t affect your rates."', score: 1, correct: false, explanation: 'Calling their concern a "myth" is condescending. And it\'s not entirely true — at-fault claims CAN raise rates. You need to distinguish.' },
        { text: '"I honestly don\'t know — you\'d need to check with your agent."', score: 0, correct: false, explanation: 'This is one of the top 3 questions in storm restoration. Not knowing the answer is disqualifying.' }
      ],
      tags: { technical: 30, objection: 20, empathy: 10 }
    },
    {
      id: 'obj_04',
      objection: '"I need to talk to my husband/wife first."',
      context: 'Decision requires both spouses',
      options: [
        { text: '"Smart move — this is a big decision for your home. When does he/she get home? I can come back so you both hear it together."', score: 3, correct: true, explanation: 'Validates the partnership, schedules a specific callback. You\'ll pitch to both decision-makers together.' },
        { text: '"Is there any way we could call them right now? That way the information is fresh."', score: 2, correct: false, explanation: 'Works sometimes but puts them in an awkward position. Better as a secondary move if the callback doesn\'t work.' },
        { text: '"Sure — here\'s my card. Have them call me."', score: 0, correct: false, explanation: 'You just handed control of the deal to someone who\'s never met you. They won\'t call.' },
        { text: '"What questions do you think they\'ll have? I can address them right now so you have the answers."', score: 2, correct: false, explanation: 'Good attempt at equipping her to pitch for you. But she\'s not a salesperson — set the callback instead.' }
      ],
      tags: { objection: 25, empathy: 20, closing: 15 }
    },
    {
      id: 'obj_05',
      objection: '"How do I know you\'re not a scammer?"',
      context: 'Trust barrier — especially after storms',
      options: [
        { text: '"Your concern is valid — storm chasers are a real problem. We\'re based right here in [city]. Google us right now — [company name]. Our license number is [X]. I\'d rather earn your trust than pressure you."', score: 3, correct: true, explanation: 'Validates the concern, provides instant verification, and the "earn your trust" line reframes the dynamic.' },
        { text: '"I promise we\'re not scammers. Here\'s my card and our website."', score: 1, correct: false, explanation: '"I promise we\'re not scammers" is literally what a scammer would say. Provide proof, not promises.' },
        { text: '"We\'ve been in business for [X] years with a 4.9 star Google rating."', score: 2, correct: false, explanation: 'Stats are good but sound rehearsed. Give them a way to VERIFY rather than just claiming.' },
        { text: '"That\'s understandable. Want to see my contractor\'s license and insurance?"', score: 2, correct: false, explanation: 'Offering to show documents is solid, but they don\'t know what a valid license looks like. Google verification is faster and more credible.' }
      ],
      tags: { authority: 30, rapport: 15, objection: 15 }
    },
    {
      id: 'obj_06',
      objection: '"I\'m renting — I don\'t own this house."',
      context: 'Tenant vs owner situation',
      options: [
        { text: '"Got it. Do you happen to have your landlord\'s contact info? They\'d definitely want to know about storm damage — it\'s their investment. Plus, your lease probably requires them to maintain the roof."', score: 3, correct: true, explanation: 'Pivots to the actual decision-maker, provides value to the tenant (leak-free home), and references lease obligations.' },
        { text: '"Oh okay, sorry to bother you then."', score: 0, correct: false, explanation: 'The tenant is your BEST lead source — they have direct access to the landlord and live under the damaged roof. Don\'t walk away.' },
        { text: '"Okay. Do you know which houses on this street are owner-occupied?"', score: 1, correct: false, explanation: 'Treating the tenant as an information source instead of a person is rude. Help them first, then ask for intel naturally.' },
        { text: '"Even as a renter, you want to make sure the roof is good — leaks damage your belongings too. Can you get me in touch with the owner?"', score: 2, correct: false, explanation: 'Good instinct to show the tenant\'s stake but the pivot to "get me in touch with the owner" is too direct. Lead with their benefit.' }
      ],
      tags: { objection: 25, rapport: 15, empathy: 15, closing: 5 }
    },
    {
      id: 'obj_07',
      objection: '"We just got a new roof two years ago."',
      context: 'Homeowner believes new roof = no damage',
      options: [
        { text: '"That\'s actually more reason to check — a 2-year-old roof is 100% covered under both manufacturer warranty and insurance. And hail doesn\'t care how new the roof is. A quick inspection could save your warranty."', score: 3, correct: true, explanation: 'Reframes new roof as an ADVANTAGE (full warranty coverage), introduces the non-obvious truth that hail damages new roofs too.' },
        { text: '"New roofs still get damaged by hail. Let me take a look."', score: 1, correct: false, explanation: 'True but unpersuasive. You didn\'t explain WHY a new roof matters for their situation specifically.' },
        { text: '"Two years ago? That was before this storm. The storm is what causes the damage, not age."', score: 2, correct: false, explanation: 'Correct information but delivered with a slight "well actually" energy. Lead with their benefit, not your correction.' },
        { text: '"Okay, great — you\'re probably fine then. Have a good one."', score: 0, correct: false, explanation: 'New roofs get hail damage constantly. Walking away from a home with a 2-year-old roof after a major storm is leaving money on the table.' }
      ],
      tags: { technical: 25, objection: 20, closing: 10, authority: 5 }
    },
    {
      id: 'obj_08',
      objection: '"I don\'t want to deal with the hassle."',
      context: 'The process seems overwhelming',
      options: [
        { text: '"Totally get it. Here\'s what comes off your plate: I photograph every bit of damage, write the line-item estimate, and after you call in the claim I meet your adjuster on the roof and walk them through it. Your part is one phone call — you stay in charge of the claim. Most homeowners say it was way easier than they expected."', score: 3, correct: true, explanation: 'Acknowledges the concern, then shows how little is on their plate — using only what a contractor may do: document, estimate, meet the adjuster after the homeowner files. Kentucky law (KRS 367.628) bars a contractor from representing or negotiating on a homeowner\'s claim or marketing itself as a claims or insurance expert, and in Ohio negotiating a claim for pay takes a public adjuster license, so the homeowner files and owns the claim. Social proof at the end seals it.' },
        { text: '"It\'s actually not that much hassle. Just a quick inspection and then we handle the claim."', score: 0, correct: false, explanation: 'Minimizing their concern doesn\'t resolve it — and "we handle the claim" is a promise you can\'t make: Kentucky law (KRS 367.628) bars a contractor from representing or negotiating on a homeowner\'s claim or marketing itself as a claims or insurance expert, and in Ohio negotiating a claim for pay takes a public adjuster license. Tell them what you DO do: the documentation, the estimate, the adjuster meeting.' },
        { text: '"The only hassle is dealing with a leaking roof when it rains. Trust me, this is easier."', score: 1, correct: false, explanation: 'Scare tactic. Comparing hassles doesn\'t make the process hassle feel better. Reframe instead of threaten.' },
        { text: '"Would it help if I walked you through the exact process step by step? It\'s simpler than you think."', score: 2, correct: false, explanation: 'Offering to explain is polite but "simpler than you think" is mildly condescending. Better to describe what YOU handle so they see how little THEY have to do.' }
      ],
      tags: { empathy: 20, closing: 20, objection: 15, rapport: 5 }
    },
    {
      id: 'obj_09',
      objection: '"My deductible is too high — I can\'t afford it."',
      context: 'Financial concern about out-of-pocket costs',
      options: [
        { text: '"I hear you. The deductible IS real money. But consider this — your insurance is about to pay $12-18K for a new roof. Your deductible is a fraction of that, and you don\'t pay it until the work is complete. Most people use the processing time to budget for it."', score: 3, correct: true, explanation: 'Validates the concern, contextualizes the cost vs value, and reveals the payment timing (end of job, not upfront). Practical and honest.' },
        { text: '"We can work with you on the deductible."', score: 0, correct: false, explanation: 'Waiving or reducing the deductible is insurance fraud in most states. Never say this, even as a favor.' },
        { text: '"What\'s your deductible? Because on most policies it\'s only $1,000."', score: 1, correct: false, explanation: 'Asking is fine but assuming it\'s "only $1,000" minimizes their financial reality. $1,000 is a lot to many families.' },
        { text: '"Think of it as an investment. You\'re paying $2,000 for a $15,000 roof."', score: 2, correct: false, explanation: 'The math is compelling but "investment" language sounds like a sales pitch. And they\'re telling you they don\'t have the money — the math doesn\'t change their bank balance.' }
      ],
      tags: { objection: 25, empathy: 20, technical: 10, closing: 5 }
    },
    {
      id: 'obj_10',
      objection: '"I want to get three quotes first."',
      context: 'Comparison shopping instinct',
      options: [
        { text: '"That\'s smart — I\'d do the same thing. Tell you what: let me do the inspection and give you a full report. You can use that report to get accurate quotes from anyone. It actually helps your other quotes be more accurate too."', score: 3, correct: true, explanation: 'Validates their process, positions your inspection as helpful to ALL their quotes, and gets you on the roof first. Whoever inspects first has the advantage.' },
        { text: '"We\'ll beat any competitor\'s price. Guaranteed."', score: 0, correct: false, explanation: 'Race-to-the-bottom pricing screams desperation and low quality. You\'re competing on value, not price.' },
        { text: '"Sure. But just know that our quality speaks for itself. Check our reviews."', score: 1, correct: false, explanation: 'Passive and doesn\'t address their underlying need. Help them comparison shop THROUGH you, not away from you.' },
        { text: '"No problem. Most of our customers get multiple quotes and still go with us. Here\'s my card."', score: 1, correct: false, explanation: 'The humble brag isn\'t compelling without proof. And the card drop gives you no advantage. Get the inspection first.' }
      ],
      tags: { objection: 25, closing: 20, rapport: 10, authority: 5 }
    },
    {
      id: 'obj_11',
      objection: '"No soliciting — can\'t you read the sign?"',
      context: 'They have a "no soliciting" sign',
      options: [
        { text: '"You\'re right, I saw the sign and I apologize. I normally wouldn\'t knock — but there\'s active storm damage on your roof that I can see from the street. I\'d feel terrible driving away without at least mentioning it. I\'ll leave you my card and get out of your hair."', score: 3, correct: true, explanation: 'Acknowledges the violation, provides a legitimate reason (visible damage), shows genuine concern, and retreats gracefully with the card. The honesty often disarms the anger.' },
        { text: '"I\'m not soliciting — I\'m doing storm damage notifications for the community."', score: 1, correct: false, explanation: 'Semantic games with someone who\'s already annoyed. You ARE soliciting, just under a different name. Be honest.' },
        { text: '"Sorry about that! Have a great day!" and walk away immediately.', score: 1, correct: false, explanation: 'At least you\'re respectful, but if they genuinely have damage, you just left a homeowner in the dark. Quick apology + the reason you knocked is worth the 10-second interaction.' },
        { text: '"I understand — but this is actually important. Your roof has damage from Tuesday\'s storm and if you don\'t act soon, your insurance might not cover it."', score: 1, correct: false, explanation: 'The information is relevant but the delivery ignores that they explicitly asked to be left alone. Lead with the apology, then the reason. Order matters.' }
      ],
      tags: { empathy: 25, rapport: 20, objection: 10, authority: 5 }
    },
    {
      id: 'obj_12',
      objection: '"My roof looks fine from down here."',
      context: 'Damage not visible from ground level',
      options: [
        { text: '"It usually does — hail damage is almost invisible from the ground. That\'s actually what makes it dangerous. Here, look at this..." Show them a close-up photo from a neighbor\'s roof on your tablet. "This is what it looks like up close. From the street, that roof looked perfect too."', score: 3, correct: true, explanation: 'Validates their observation, explains why it\'s misleading, and uses visual proof from a nearby home. Photos convert skeptics.' },
        { text: '"Trust me, it\'s not fine. I\'ve been doing this for years."', score: 0, correct: false, explanation: '"Trust me" is never convincing. You\'re asking them to override their own eyes based on your word. Show, don\'t tell.' },
        { text: '"Would you be open to me taking a quick look? I can have an answer in 5 minutes."', score: 2, correct: false, explanation: 'Reasonable ask but doesn\'t address their underlying belief. They think it\'s fine — you need to explain why the ground view is deceptive before asking to inspect.' },
        { text: '"Check your gutters — if you see dark sandy granules, that\'s your shingles breaking down from the hail."', score: 2, correct: false, explanation: 'Good technical tip that gives them something to verify themselves. But without showing them what to look for, they might not know what granule loss looks like vs normal dirt.' }
      ],
      tags: { technical: 25, authority: 15, objection: 15, empathy: 5 }
    },
    {
      id: 'obj_13',
      objection: '"I\'ll just wait and see if it leaks."',
      context: 'Reactive vs proactive mindset',
      options: [
        { text: '"I get the logic — if it ain\'t leaking, why fix it? The tricky thing is, by the time water gets through your roof deck, through the attic insulation, and shows up on your ceiling, the damage is way more than just shingles. You\'re talking drywall, insulation, maybe mold. And insurance covers the shingles NOW — they won\'t cover the water damage you could have prevented."', score: 3, correct: true, explanation: 'Acknowledges the logic, explains the hidden progression (deck → insulation → ceiling), and reveals the insurance coverage distinction. You educated without lecturing.' },
        { text: '"If you wait until it leaks, you\'ll be paying emergency prices for a problem insurance would have covered today."', score: 2, correct: false, explanation: 'True but comes across as a threat. The tone implies "you\'re being dumb" instead of "let me show you what happens next."' },
        { text: '"That\'s a really expensive gamble. New roof: $15K covered by insurance. Water damage repair: $30K+ out of pocket."', score: 1, correct: false, explanation: 'Dollar figures can overwhelm rather than persuade. And "$30K+" sounds made up even if it\'s real. Walk them through the progression instead.' },
        { text: '"I wouldn\'t recommend that. Storm damage gets worse over time."', score: 1, correct: false, explanation: 'Vague and generic. "Gets worse" doesn\'t paint a picture. Be specific about what "worse" looks like.' }
      ],
      tags: { technical: 25, objection: 20, empathy: 10, closing: 5 }
    },
    {
      id: 'obj_14',
      objection: '"I don\'t believe in insurance — I\'ll pay out of pocket if needed."',
      context: 'Anti-insurance mindset or high deductible plan',
      options: [
        { text: '"I respect that. Either way, knowing what\'s up there puts you in control. If I do a free inspection and find damage, at least you\'ll know the scope and cost. Then you can decide how you want to handle it — insurance, out of pocket, or not at all. Knowledge is free."', score: 3, correct: true, explanation: 'Removes the insurance argument entirely and refocuses on information and control. Works with any belief system because you\'re offering value regardless of their payment preference.' },
        { text: '"But you\'re already paying for insurance. Might as well use it."', score: 1, correct: false, explanation: 'Arguing with someone\'s belief system is always a losing move. They know they\'re paying for insurance. Their position is philosophical, not financial.' },
        { text: '"A full roof replacement out of pocket is $12-18K. Are you sure?"', score: 1, correct: false, explanation: 'Challenging their financial decision-making is offensive. Whether they can afford it or not isn\'t your business to question.' },
        { text: '"That\'s unusual but okay. I can still give you a quote if you want."', score: 1, correct: false, explanation: '"That\'s unusual" is judgmental. And jumping straight to a quote skips the inspection and relationship-building.' }
      ],
      tags: { empathy: 25, objection: 20, rapport: 10, closing: 5 }
    },
    {
      id: 'obj_15',
      objection: '"My neighbor said you guys did bad work on his house."',
      context: 'Negative word of mouth — real or fabricated',
      options: [
        { text: '"Really? I\'d actually like to know about that — which neighbor? Because if there\'s an issue with one of our jobs, I want to make it right. We stand behind every roof we do. Can you point me to the house?"', score: 3, correct: true, explanation: 'Instead of getting defensive, you leaned INTO the complaint. Asking to fix it demonstrates accountability. Most of the time, the "neighbor" is fabricated or it was a different company. Either way, you look professional.' },
        { text: '"That\'s not possible — we have a 4.9 star rating and zero complaints."', score: 0, correct: false, explanation: 'Calling them a liar is the worst possible response. Even if it\'s not true, you look defensive and arrogant.' },
        { text: '"I\'m sorry to hear that. Every project is different and we always aim to do our best. Would you like to see some of our recent completed projects?"', score: 2, correct: false, explanation: 'Polite but generic. "We always aim to do our best" is corporate-speak that doesn\'t address the specific allegation. Offer to investigate, not redirect.' },
        { text: '"There must be a misunderstanding. We\'ve done great work in this neighborhood."', score: 1, correct: false, explanation: 'Dismissing their claim as a "misunderstanding" without investigating is dismissive. Take the feedback seriously even if you think it\'s wrong.' }
      ],
      tags: { authority: 25, empathy: 20, rapport: 15, objection: 15 }
    },
    {
      id: 'obj_16',
      objection: '"Can you just leave me some information?"',
      context: 'Polite brush-off disguised as interest',
      options: [
        { text: '"Absolutely — I have a packet in the truck. While I grab it, quick question: have you noticed any granules in your gutters since the storm? Just so I know what info is most relevant for you."', score: 3, correct: true, explanation: 'You agreed to their request but used the transition to re-engage with a qualifying question. Now you\'re having a conversation, not just dropping paper.' },
        { text: '"Sure, here\'s my card."', score: 0, correct: false, explanation: 'The card is in the trash before your truck leaves the driveway. You had a live homeowner and traded them for a business card.' },
        { text: '"I could, but honestly a lot gets lost in paper. Can I give you a 2-minute walkthrough instead?"', score: 2, correct: false, explanation: 'Good instinct to keep the conversation going, but you just refused their request, which feels pushy. Accept first, then redirect.' },
        { text: '"Of course. I\'ll also text you some before-and-after photos from your neighbor\'s roof so you can see the difference."', score: 2, correct: false, explanation: 'Better — you\'re creating a reason to follow up. But you need their number to text, so you\'re still making an ask without engaging them first.' }
      ],
      tags: { objection: 25, rapport: 20, closing: 15 }
    },
    {
      id: 'obj_17',
      objection: '"We just had our roof inspected last month."',
      context: 'They believe their roof is fine',
      options: [
        { text: '"That\'s great — who did the inspection? The reason I ask is we\'ve been finding damage that general inspectors miss because hail damage doesn\'t always look obvious from the ground. Was it a ground inspection or did they actually get on the roof?"', score: 3, correct: true, explanation: 'You validated, asked a qualifying question, and differentiated your inspection method. If it was a ground inspection, you just created doubt. If someone was on the roof, you can ask about specifics.' },
        { text: '"Oh okay, you\'re all set then. Have a good day."', score: 0, correct: false, explanation: 'You took their word for it without any follow-up. A "general inspection" and a "storm damage inspection" are completely different things.' },
        { text: '"Was that a storm damage inspection or a general maintenance check? Because they look for very different things."', score: 2, correct: false, explanation: 'Good question but a bit confrontational. Lead with validation before questioning their previous inspector.' },
        { text: '"Mind if I take a quick look anyway? Second opinions are free."', score: 1, correct: false, explanation: '"Free second opinion" sounds like you\'re dismissing their previous inspection. Build the case for WHY a second look matters first.' }
      ],
      tags: { technical: 25, objection: 20, authority: 15 }
    },
    {
      id: 'obj_18',
      objection: '"I don\'t want to file a claim for something small."',
      context: 'They think the damage is minor',
      options: [
        { text: '"That\'s a really common concern. Here\'s the thing — what looks small from the ground is often significant up close. And storm damage gets worse over time, not better. A $12,000 roof now could be a $25,000 interior damage claim in 2 years if it\'s left alone. The inspection is free — wouldn\'t you rather know for sure?"', score: 3, correct: true, explanation: 'You reframed "small" as potentially significant, quantified the risk of inaction, and made the ask zero-risk. Education selling at its best.' },
        { text: '"It might not be as small as you think. Let me take a look."', score: 1, correct: false, explanation: 'Vague and slightly condescending. Give them a reason to believe the damage might be bigger, don\'t just tell them.' },
        { text: '"Even small claims are worth filing. Your insurance covers it either way."', score: 1, correct: false, explanation: 'This might not even be true depending on their deductible and policy. Don\'t make blanket claims about insurance coverage.' },
        { text: '"Most of our customers thought the same thing until they saw the inspection photos. Want me to show you what hail damage actually looks like?"', score: 2, correct: false, explanation: 'Using other customers as proof is decent social proof. But the inspection photos pitch is better saved for after you\'re on the roof, not before.' }
      ],
      tags: { technical: 25, empathy: 20, closing: 15 }
    },
    {
      id: 'obj_19',
      objection: '"I\'m renting — I don\'t own this house."',
      context: 'Non-decision-maker at the door',
      options: [
        { text: '"No problem at all. Do you happen to have the landlord\'s number? I\'d love to let them know about the storm damage we\'re finding in the area. It protects you too — roof damage can lead to leaks that affect your living space."', score: 3, correct: true, explanation: 'Perfect pivot. You turned a dead end into a lead. The renter becomes your ally by framing it as protecting their living space, and you get the decision-maker\'s contact.' },
        { text: '"Oh okay, sorry to bother you."', score: 0, correct: false, explanation: 'A renter just gave you a direct line to a property owner who has a roof that needs inspection. You walked away from a lead.' },
        { text: '"Who\'s the property owner? I should talk to them."', score: 1, correct: false, explanation: 'Correct impulse, wrong delivery. Demanding the owner\'s info without giving them a reason feels like you\'re talking past them.' },
        { text: '"Would you mind asking your landlord to call me? Here\'s my card."', score: 1, correct: false, explanation: 'You\'re asking the renter to do your sales job for you. They have zero incentive. Get the number and make the call yourself.' }
      ],
      tags: { rapport: 20, closing: 20, objection: 20 }
    },
    {
      id: 'obj_20',
      objection: '"My deductible is too high — it\'s not worth it."',
      context: 'Financial barrier to filing a claim',
      options: [
        { text: '"What\'s your deductible? ... Okay, $2,500 — I understand that feels like a lot. But here\'s the math: your insurance approved a $14,000 replacement. You pay $2,500, they pay $11,500. That\'s an 82% discount on a brand new roof. If your roof is 15+ years old, this is actually the best deal you\'ll ever get on a replacement."', score: 3, correct: true, explanation: 'You turned the deductible from a cost into an investment. The percentage math makes the value undeniable. Reframing the deductible as a "discount" flips the entire psychology.' },
        { text: '"We can work with you on that."', score: 0, correct: false, explanation: 'Implying you\'ll cover their deductible is illegal in most states — it\'s insurance fraud. Never go there, even vaguely.' },
        { text: '"$2,500 is a lot less than a new roof out of pocket."', score: 2, correct: false, explanation: 'True but blunt. The math is right but the delivery needs more context — show them the full numbers, not just a comparison.' },
        { text: '"Think of it as an investment in your home\'s value."', score: 1, correct: false, explanation: 'Generic financial advice that doesn\'t address the real concern — they don\'t want to spend $2,500 right now. Show them the specific ROI.' }
      ],
      tags: { technical: 20, closing: 25, objection: 20, empathy: 10 }
    },
    {
      id: 'obj_21',
      objection: '"I had a bad experience with my insurance company before."',
      context: 'Past claim trauma creating resistance',
      options: [
        { text: '"I hear that a lot, and it\'s frustrating. What happened? ... The difference this time is you won\'t go in empty-handed. I photograph every hit and write a line-item estimate before you call it in, and once you\'ve filed I meet the adjuster on the roof and walk them through it. If their scope misses items, I send my updated estimate with the photos. It\'s your claim — you\'ll just have the record to back it."', score: 3, correct: true, explanation: 'You listened first, empathized, then showed what changes: documentation, an estimate, and the adjuster meeting — the work a contractor may do. You did NOT promise to handle or fight the claim: Kentucky law (KRS 367.628) bars a contractor from representing or negotiating on a homeowner\'s claim or marketing itself as a claims or insurance expert, and in Ohio negotiating a claim for pay takes a public adjuster license.' },
        { text: '"That won\'t happen this time — insurance always covers storm damage."', score: 0, correct: false, explanation: 'Dismissive of their experience and not even accurate. Insurance doesn\'t "always" cover everything. This response kills trust.' },
        { text: '"Which company are you with? Some are harder than others."', score: 2, correct: false, explanation: 'Not bad — knowing their carrier helps you tailor the approach. But you skipped over their emotional concern entirely. Listen first.' },
        { text: '"I can refer you to a public adjuster who will fight for you."', score: 1, correct: false, explanation: 'A public adjuster is the right call if a claim ends up disputed — they are licensed to negotiate it, and you are not. But leading with a referral skips what you CAN offer: the documentation, the estimate, and meeting the adjuster after they file.' }
      ],
      tags: { empathy: 30, authority: 20, objection: 15, rapport: 10 }
    },
    {
      id: 'obj_22',
      objection: '"How long will this take? I work from home and can\'t have noise all day."',
      context: 'Practical concern about disruption',
      options: [
        { text: '"Great question. A typical roof takes 1-2 days depending on size. Most of the noise is the first morning during tear-off — by afternoon it quiets down significantly. We start at 7am and we\'re usually off the roof by 4. I\'d recommend scheduling your most important calls before 7 or after lunch. Want me to check what day works best for your schedule?"', score: 3, correct: true, explanation: 'Specific, honest, and solution-oriented. You gave real timelines, acknowledged the noise concern, and offered scheduling flexibility. This is a buying signal — they\'re thinking about WHEN, not IF.' },
        { text: '"It\'ll be quick — you won\'t even notice us."', score: 0, correct: false, explanation: 'Blatant lie. A roof tear-off sounds like a war zone. Dishonesty here will destroy trust on day one of the job.' },
        { text: '"Usually 1-2 days. We try to be quick."', score: 1, correct: false, explanation: 'Accurate but didn\'t address their specific concern about noise and working from home. Tailor the answer to their situation.' },
        { text: '"We can do weekends if that works better."', score: 2, correct: false, explanation: 'Flexible, but you skipped the part where you address the noise reality. Set honest expectations AND offer solutions.' }
      ],
      tags: { rapport: 20, empathy: 20, closing: 15, technical: 10 }
    },
    {
      id: 'obj_23',
      objection: '"I\'m going to wait and see if any more storms hit this year."',
      context: 'Procrastination masked as strategy',
      options: [
        { text: '"I understand the logic, but here\'s the risk: insurance companies date their claims from the FIRST storm. If you wait and another storm hits, they can argue the original damage was pre-existing and unclaimed — which actually weakens your case. Filing now protects you AND covers future damage. It\'s one claim, not two."', score: 3, correct: true, explanation: 'You addressed the underlying logic with specific insurance knowledge. The "pre-existing damage" risk is real and powerful. You turned their reason to wait into a reason to act.' },
        { text: '"Why wait? Let\'s just get it done now."', score: 0, correct: false, explanation: 'You just told them their strategy is wrong without explaining why. People don\'t like being told what to do.' },
        { text: '"More storms could make it worse. Better to fix it now."', score: 1, correct: false, explanation: 'True but sounds like fear-mongering without the insurance logic to back it up. Give them the WHY.' },
        { text: '"That\'s a valid approach. Just know that most policies have a 12-month window for storm claims."', score: 2, correct: false, explanation: 'Good information drop. But you validated procrastination when you should have shown why waiting is actually riskier than acting.' }
      ],
      tags: { technical: 30, objection: 25, closing: 15 }
    },
    {
      id: 'obj_24',
      objection: '"My roof is only 5 years old — there\'s no way it\'s damaged."',
      context: 'Age bias — newer roof assumed to be fine',
      options: [
        { text: '"A 5-year-old roof can actually show MORE damage than an older one because the granules are still well-bonded — when hail hits, it creates cleaner impact marks that adjusters can easily identify. Age doesn\'t make a roof hail-proof. Want me to check a few shingles? If it\'s clean, I\'ll tell you and you\'ll have peace of mind."', score: 3, correct: true, explanation: 'You educated them with a counterintuitive fact (newer roofs show clearer damage), removed the bias, and made the ask zero-risk ("if it\'s clean I\'ll tell you"). The "peace of mind" frame is powerful.' },
        { text: '"Even new roofs get damaged by hail. It doesn\'t matter how old it is."', score: 1, correct: false, explanation: 'Correct but sounds like a generic pitch. EXPLAIN why new roofs are still vulnerable — give them something they didn\'t know.' },
        { text: '"Your manufacturer warranty might actually be voided if you have unreported storm damage."', score: 2, correct: false, explanation: 'True for some warranties, but this feels like a threat. Lead with education, not fear.' },
        { text: '"Okay, that makes sense. If you change your mind, here\'s my number."', score: 0, correct: false, explanation: 'You accepted a false premise. Their logic is wrong — new roofs absolutely get storm damage. You owed them the truth.' }
      ],
      tags: { technical: 30, objection: 20, authority: 15 }
    },
    {
      id: 'obj_25',
      objection: '"I\'ll just file the claim myself — I don\'t need a contractor for that."',
      context: 'DIY mentality with insurance claims',
      options: [
        { text: '"You should — it\'s your policy and your claim, and you file it. Where I come in is the documentation. Here\'s what usually happens: the adjuster comes out, does a quick ground inspection, and approves a $3,000 repair. When we\'re there WITH the adjuster, pointing out every damaged shingle, vent boot, and flashing — that same claim comes back at $12,000+. Our presence at the meeting typically triples the approved scope. And it costs you nothing extra."', score: 3, correct: true, explanation: 'You respected their autonomy (they file and own the claim — Kentucky law (KRS 367.628) bars a contractor from representing or negotiating on a homeowner\'s claim or marketing itself as a claims or insurance expert, and in Ohio negotiating a claim for pay takes a public adjuster license), then showed the dollar difference documentation and an adjuster meeting make. The "triples the scope" line backed by specifics makes the value undeniable.' },
        { text: '"Trust me, you want a contractor there. Insurance companies lowball everyone."', score: 1, correct: false, explanation: '"Trust me" and "lowball" are alarm words. Show the math, don\'t make claims about insurance companies being adversarial.' },
        { text: '"That\'s fine. Let me know if you need help."', score: 0, correct: false, explanation: 'You just let a qualified lead walk because they didn\'t understand the process. It\'s your job to educate, not surrender.' },
        { text: '"Most homeowners who file alone end up getting about a third of what they\'re entitled to."', score: 2, correct: false, explanation: 'Good stat but sounds made up without context. Show the specific example of HOW the dollar difference happens — adjuster meeting, scope detail, line items.' }
      ],
      tags: { technical: 25, closing: 20, authority: 20, objection: 10 }
    }
  ];

  // ════════════════════════════════════════════════════════════
  // SHARED STATE (mirrored on window._SalesTrainingState so UI module
  // can read/write)
  // ════════════════════════════════════════════════════════════
  // Step 4f rationale: the UI module (render funcs, navigation) needs
  // access to the same mode / scenario / rapid-fire counters that the
  // engine owns. Rather than thread arguments through every render call,
  // we publish a single state object that both modules close over via
  // window._SalesTrainingState. Mirrors the dashboard-state.js pattern
  // from Step 4a and _D2DState from Step 4f.
  const state = window._SalesTrainingState = window._SalesTrainingState || {};
  state.currentMode = 'menu';          // 'menu' | 'scenario' | 'rapid' | 'results' | 'profile' | 'feedback' | 'rapid_results'
  state.currentScenario = null;        // active scenario object
  state.currentNodeId = null;          // current node in scenario tree
  state.scenarioPath = [];             // [{nodeId, optionIdx, score, tags}]
  state.scenarioStartTime = 0;

  // Rapid fire state
  state.rapidQueue = [];               // shuffled objection indices
  state.rapidIndex = 0;
  state.rapidScore = 0;
  state.rapidCorrect = 0;
  state.rapidStreak = 0;
  state.rapidBestStreak = 0;
  state.rapidStartTime = 0;
  state.rapidAnswered = false;

  // Profile / history
  state.trainingHistory = [];          // loaded from Firestore
  state.skillProfile = {};             // aggregated skill scores

  // Constants the UI module also needs
  state.SCENARIOS = SCENARIOS;
  state.OBJECTIONS = OBJECTIONS;
  state.SKILL_TAGS = SKILL_TAGS;

  // ════════════════════════════════════════════════════════════
  // PERSISTENCE (Firestore)
  // ════════════════════════════════════════════════════════════

  async function saveSession(type, data) {
    try {
      if (!window._db || !window._user) return;
      const payload = {
        userId: window._user.uid,
        companyId: window._userClaims?.companyId || window._user.uid,
        type, // 'scenario' or 'rapid'
        ...data,
        completedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
      };
      await window.addDoc(window.collection(window._db, 'training_sessions'), payload);
    } catch (e) {
      console.error('Training session save error:', e);
    }
  }

  async function loadHistory() {
    try {
      if (!window._db || !window._user) { state.trainingHistory = []; return; }
      const snap = await window.getDocs(
        window.query(
          window.collection(window._db, 'training_sessions'),
          window.where('userId', '==', window._user.uid)
        )
      );
      state.trainingHistory = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => {
          const ta = a.completedAt?.toDate?.()?.getTime?.() || 0;
          const tb = b.completedAt?.toDate?.()?.getTime?.() || 0;
          return tb - ta;
        });
      buildSkillProfile();
    } catch (e) {
      console.error('Training history load error:', e);
      state.trainingHistory = [];
    }
  }

  function buildSkillProfile() {
    state.skillProfile = {};
    Object.keys(SKILL_TAGS).forEach(tag => { state.skillProfile[tag] = { total: 0, count: 0, avg: 0 }; });

    state.trainingHistory.forEach(session => {
      if (session.skillScores) {
        Object.entries(session.skillScores).forEach(([tag, val]) => {
          if (state.skillProfile[tag]) {
            state.skillProfile[tag].total += val;
            state.skillProfile[tag].count += 1;
            state.skillProfile[tag].avg = Math.round(state.skillProfile[tag].total / state.skillProfile[tag].count);
          }
        });
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // SCORING ENGINE
  // ════════════════════════════════════════════════════════════

  function getStarRating(scorePercent) {
    if (scorePercent >= 90) return 5;
    if (scorePercent >= 70) return 4;
    if (scorePercent >= 50) return 3;
    if (scorePercent >= 30) return 2;
    return 1;
  }

  function starsHTML(count, size) {
    const sz = size || 20;
    let html = '';
    for (let i = 0; i < 5; i++) {
      html += `<span style="font-size:${sz}px;${i < count ? '' : 'opacity:.2;'}">${i < count ? '⭐' : '☆'}</span>`;
    }
    return html;
  }

  function aggregateScenarioTags(path) {
    const totals = {};
    Object.keys(SKILL_TAGS).forEach(t => { totals[t] = 0; });
    path.forEach(step => {
      if (step.tags) {
        Object.entries(step.tags).forEach(([tag, val]) => {
          if (totals[tag] !== undefined) totals[tag] += val;
        });
      }
    });
    return totals;
  }

  // ════════════════════════════════════════════════════════════
  // SCENARIO MODE
  // ════════════════════════════════════════════════════════════

  function startScenario(scenarioId) {
    state.currentScenario = SCENARIOS.find(s => s.id === scenarioId);
    if (!state.currentScenario) return;
    state.currentNodeId = 'start';
    state.scenarioPath = [];
    state.scenarioStartTime = Date.now();
    state.currentMode = 'scenario';
    state.render && state.render();
  }

  function chooseOption(optIdx) {
    const node = state.currentScenario.nodes[state.currentNodeId];
    if (!node || !node.options[optIdx]) return;
    const opt = node.options[optIdx];

    state.scenarioPath.push({
      nodeId: state.currentNodeId,
      optionIdx: optIdx,
      choiceText: opt.text,
      score: opt.score,
      tags: opt.tags || {},
      feedback: opt.feedback
    });

    // Show feedback before advancing
    state.currentMode = 'feedback';
    state.render && state.render();
  }

  function advanceAfterFeedback() {
    const lastStep = state.scenarioPath[state.scenarioPath.length - 1];
    const node = state.currentScenario.nodes[state.currentNodeId];
    const opt = node.options[lastStep.optionIdx];

    if (opt.nextNode && state.currentScenario.nodes[opt.nextNode]) {
      const nextNode = state.currentScenario.nodes[opt.nextNode];
      if (nextNode.terminal) {
        // Show terminal node then results
        state.scenarioPath.push({
          nodeId: opt.nextNode,
          terminal: true,
          outcome: nextNode.outcome,
          prompt: nextNode.prompt,
          summary: nextNode.summary
        });
        state.currentNodeId = opt.nextNode;
        finishScenario();
      } else {
        state.currentNodeId = opt.nextNode;
        state.currentMode = 'scenario';
        state.render && state.render();
      }
    } else {
      finishScenario();
    }
  }

  function finishScenario() {
    const totalPossible = state.scenarioPath
      .filter(s => s.score !== undefined && !s.terminal)
      .reduce((sum, step) => {
        const nodeOpts = state.currentScenario.nodes[step.nodeId]?.options || [];
        const maxNodeScore = nodeOpts.length ? Math.max(...nodeOpts.map(o => o.score)) : 0;
        return sum + maxNodeScore;
      }, 0);
    const totalEarned = state.scenarioPath.filter(s => !s.terminal).reduce((s, step) => s + (step.score || 0), 0);
    const pct = totalPossible > 0 ? Math.round((totalEarned / totalPossible) * 100) : 0;
    const stars = getStarRating(pct);
    const skillScores = aggregateScenarioTags(state.scenarioPath.filter(s => !s.terminal));
    const terminalStep = state.scenarioPath.find(s => s.terminal);
    const outcome = terminalStep ? terminalStep.outcome : 'loss';
    const duration = Math.round((Date.now() - state.scenarioStartTime) / 1000);

    // Save to Firestore
    saveSession('scenario', {
      scenarioId: state.currentScenario.id,
      scenarioTitle: state.currentScenario.title,
      score: totalEarned,
      maxScore: totalPossible,
      pct,
      stars,
      outcome,
      skillScores,
      duration,
      steps: state.scenarioPath.length
    });

    // Store for results display
    window._lastTrainingResult = { totalEarned, totalPossible, pct, stars, skillScores, outcome, duration, path: state.scenarioPath, scenario: state.currentScenario };
    state.currentMode = 'results';
    state.render && state.render();
  }

  // ════════════════════════════════════════════════════════════
  // RAPID FIRE MODE
  // ════════════════════════════════════════════════════════════

  function startRapidFire() {
    // Shuffle objection indices
    state.rapidQueue = OBJECTIONS.map((_, i) => i);
    for (let i = state.rapidQueue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.rapidQueue[i], state.rapidQueue[j]] = [state.rapidQueue[j], state.rapidQueue[i]];
    }
    state.rapidIndex = 0;
    state.rapidScore = 0;
    state.rapidCorrect = 0;
    state.rapidStreak = 0;
    state.rapidBestStreak = 0;
    state.rapidStartTime = Date.now();
    state.rapidAnswered = false;
    state.rapidSelectedIdx = -1;
    state.currentMode = 'rapid';
    state.render && state.render();
  }

  function rapidAnswer(optIdx) {
    if (state.rapidAnswered) return;
    state.rapidAnswered = true;
    state.rapidSelectedIdx = optIdx;
    const objection = OBJECTIONS[state.rapidQueue[state.rapidIndex]];
    const opt = objection.options[optIdx];
    state.rapidScore += opt.score;
    if (opt.correct) {
      state.rapidCorrect++;
      state.rapidStreak++;
      if (state.rapidStreak > state.rapidBestStreak) state.rapidBestStreak = state.rapidStreak;
    } else {
      state.rapidStreak = 0;
    }
    // Re-render to show feedback
    state.render && state.render();
  }

  function rapidNext() {
    state.rapidIndex++;
    state.rapidAnswered = false;
    state.rapidSelectedIdx = -1;
    if (state.rapidIndex >= state.rapidQueue.length) {
      finishRapidFire();
    } else {
      state.render && state.render();
    }
  }

  function finishRapidFire() {
    const maxScore = OBJECTIONS.length * 3;
    const pct = Math.round((state.rapidScore / maxScore) * 100);
    const stars = getStarRating(pct);
    const duration = Math.round((Date.now() - state.rapidStartTime) / 1000);

    // Aggregate skill tags from all answered
    const skillScores = {};
    Object.keys(SKILL_TAGS).forEach(t => { skillScores[t] = 0; });
    state.rapidQueue.slice(0, state.rapidIndex + 1).forEach(qi => {
      const obj = OBJECTIONS[qi];
      if (obj.tags) {
        Object.entries(obj.tags).forEach(([tag, val]) => {
          if (skillScores[tag] !== undefined) skillScores[tag] += val;
        });
      }
    });

    saveSession('rapid', {
      score: state.rapidScore,
      maxScore,
      pct,
      stars,
      correct: state.rapidCorrect,
      total: OBJECTIONS.length,
      bestStreak: state.rapidBestStreak,
      skillScores,
      duration
    });

    window._lastTrainingResult = { rapidScore: state.rapidScore, maxScore, pct, stars, correct: state.rapidCorrect, total: OBJECTIONS.length, bestStreak: state.rapidBestStreak, duration, skillScores };
    state.currentMode = 'rapid_results';
    state.render && state.render();
  }
  // ════════════════════════════════════════════════════════════
  // NAVIGATION
  // ════════════════════════════════════════════════════════════

  function backToMenu() {
    state.currentMode = 'menu';
    state.currentScenario = null;
    state.currentNodeId = null;
    state.scenarioPath = [];
    state.render && state.render();
  }

  function showProfile() {
    state.currentMode = 'profile';
    state.render && state.render();
  }

  // ════════════════════════════════════════════════════════════
  // INIT
  // ════════════════════════════════════════════════════════════

  async function init() {
    await loadHistory();
    state.currentMode = 'menu';
    state.render && state.render();
  }

  // ════════════════════════════════════════════════════════════
  // EXPORT TO STATE OBJECT (shim composes these into window.SalesTraining)
  // ════════════════════════════════════════════════════════════
  state.saveSession = saveSession;
  state.loadHistory = loadHistory;
  state.buildSkillProfile = buildSkillProfile;
  state.getStarRating = getStarRating;
  state.starsHTML = starsHTML;
  state.aggregateScenarioTags = aggregateScenarioTags;
  state.startScenario = startScenario;
  state.chooseOption = chooseOption;
  state.advanceAfterFeedback = advanceAfterFeedback;
  state.finishScenario = finishScenario;
  state.startRapidFire = startRapidFire;
  state.rapidAnswer = rapidAnswer;
  state.rapidNext = rapidNext;
  state.finishRapidFire = finishRapidFire;
  state.backToMenu = backToMenu;
  state.showProfile = showProfile;
  state.init = init;

})();
