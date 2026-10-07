// Decision-tree DATA for the insurance branch of the Real Deal Academy.
// Extracted from academy-insurance-tree.js (step-4e cleanup).
// Engine logic lives in real-deal-academy.js; the engine shim in
// academy-insurance-tree.js exposes this as window._academyInsuranceTree.
(function() {
  window.NBD_INSURANCE_TREE = [
    // ============================================================================
    // PHASE 1: PROSPECTING & FIRST CONTACT (6 nodes)
    // ============================================================================

    {
      id: 'ins_01_storm_territory',
      branch: 'insurance',
      phase: 'prospecting',
      phaseLabel: 'Prospecting & First Contact',
      phaseNumber: 1,
      title: 'Storm Event & Territory Selection',
      subtitle: 'Identifying neighborhoods hit by hail/wind and targeting your efforts',
      icon: '🌪️',
      content: `<div class="rda-content">
        <p>The foundation of insurance restoration work is knowing where the storms are hitting. You can't knock doors in neighborhoods that didn't experience storm damage—you'll face rejection, skepticism, and waste time. This is about being systematic and data-driven in your territory selection.</p>

        <p><strong>Weather Intelligence:</strong> Storm season changes by region. In Texas, hail season peaks April through June. In other areas, it's different. Subscribe to hail tracking services (Hail Report, Storm Shield, others) and set up alerts for your service area. When a storm hits, you'll get notifications within hours. Check the path, intensity, and estimated damage radius.</p>

        <p><strong>Hail Maps & Damage Prediction:</strong> Use tools that show historical hail paths and intensity. High-impact hail (golf ball size or larger) guarantees roof damage. Quarter-to-half-inch hail may not show cosmetic damage but often leaves structural vulnerability. Wind damage is trickier—straight-line winds of 60+ mph cause obvious damage; lower speeds may be subtle.</p>

        <p><strong>The Street Walk:</strong> Before you knock a single door, do a windshield survey. Drive slowly through the affected area and look for visible signs: missing shingles, dark streaks (hail hits), roof patches, or obvious repair activity. This tells you the damage was real and significant. Take photos of affected houses—this becomes your proof when you talk to skeptical homeowners.</p>

        <p><strong>Information Gaps:</strong> Some neighborhoods will have obvious damage on a few houses but not others. This is normal—hail is spotty. Some homes are hit hard; others a block away are untouched. Use the ones you can see to open conversations with neighbors: "I noticed your neighbor's roof took a hit. Have you looked at yours lately?"</p>

        <p><strong>Territory Exclusions:</strong> Stay away from areas you've already worked unless significant time has passed. Avoid homeowners who've explicitly said no (do-not-knock lists). Respect recent denials—if someone filed and got denied 2 weeks ago, they're not going to be receptive yet.</p>
      </div>`,
      checklist: [
        'Set up storm alert subscriptions for your service area',
        'Analyze historical hail paths and frequency maps',
        'Identify storm-impacted neighborhoods within 48 hours of event',
        'Do a windshield survey: drive affected areas and document visible damage',
        'Take geotagged photos of damaged roofs for reference',
        'Cross-reference with your do-not-knock list',
        'Prioritize neighborhoods with highest visible damage concentration',
        'Create a territory map with storm impact zones'
      ],
      proTips: [
        `The first 5-7 days after a storm is your goldilocks zone—damage is fresh and homeowners haven\'t been hammered by other contractors yet`,
        'Hail damage is cumulative: a roof with existing wear plus new hail damage is suddenly a problem',
        'Large hail (golf ball+) often comes with wind damage too—look for both types',
        `Use the visible damage on one house as your conversation opener: "I was working two houses down, saw your neighbor's damage..."`
      ],
      commonMistakes: [
        `Knocking in areas where there was minimal/no damage—you'll get slammed with objections`,
        'Waiting too long after a storm; homeowners talk to dozens of contractors by day 10',
        `Not doing the windshield survey; you look foolish asking about storm damage when there's no evidence`,
        'Ignoring the do-not-knock list and harassing people who already said no'
      ],
      nextNodes: ['ins_02_door_knock'],
      prevNodes: [],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-3 hours',
      difficulty: 'beginner'
    },

    {
      id: 'ins_02_door_knock',
      branch: 'insurance',
      phase: 'prospecting',
      phaseLabel: 'Prospecting & First Contact',
      phaseNumber: 1,
      title: 'The Door Knock',
      subtitle: 'Opening the conversation and establishing credibility without sounding like a salesman',
      icon: '🚪',
      content: `<div class="rda-content">
        <p>The door knock is where most new reps fail. They come across as pushy, salesy, or insincere. Homeowners have been burned before. Your job is to be helpful, non-threatening, and genuinely interested in them—not in closing a deal.</p>

        <p><strong>The Approach & Timing:</strong> Walk up slowly, confidently. Dress professionally but not like a suit—polo with your company name is ideal. Show you work here, you're not some random dude. Don't sprint to the door; give them time to notice you and not be startled. Smile. Stand slightly back from the door—not intimidating, but not inside their space either.</p>

        <p><strong>The Opening (Not a Script, a Framework):</strong> Your goal is to be conversational and sincere. Something like: "Hi there, I'm [name] with [company]. We've been working on a couple of houses right down the street—they took some damage from that recent hail storm. I'm just stopping by to see if you guys got hit at all. Have you had a chance to get up and check your roof?" This isn't a canned pitch. It's genuine. You're already working nearby (true), and you're asking a real question.</p>

        <p><strong>Body Language Matters:</strong> Keep your hands visible. Don't point at their roof or look threatening. Make eye contact. Nod when they talk. If they seem closed off, don't push—offer your card and leave. The ones who are interested will keep talking.</p>

        <p><strong>The Neighbor Approach:</strong> This is gold. "I just finished helping your neighbor two doors down. They had some significant damage from that storm. Have you looked at yours?" This immediately establishes you're working in their area (social proof), and you're not a random storm chaser. It disarms a lot of skepticism.</p>

        <p><strong>Reading the Door:</strong> Some people will open the door and listen. Some will be cautious. Some will ask you to leave. Honor that. If someone says "not interested," don't argue. Say "No problem—if you change your mind, give us a call" and leave. Fast. Don't hover, don't try one more pitch.</p>
      </div>`,
      checklist: [
        'Dress professionally with company branding visible',
        'Arrive at door slowly and confidently',
        'Lead with the neighbor approach when possible',
        'Ask open-ended questions: "Have you had a chance to check your roof?"',
        'Listen more than you talk',
        `Offer a business card if they\'re not interested`,
        'Document doors where you got meetings scheduled',
        'Have your phone ready to note homeowner contact info'
      ],
      proTips: [
        `The best pitch isn't really a pitch—it's a genuine question with real interest in their answer`,
        `Timing: Weekday evenings or Saturday mornings are best; don't knock on Sunday mornings or very late at night`,
        `If someone is skeptical, don't sell—just offer: "I'll do a free inspection, take 20 minutes, and you'll know for sure if there's damage"`,
        'The neighbor who just signed with you is your best referral for the next house over'
      ],
      commonMistakes: [
        'Coming across as pushy or salesy—people smell desperation',
        'Launching into your full pitch instead of having a conversation',
        'Not respecting "no"—the person who says no today might say yes in 6 months if you left them alone',
        'Dressing inappropriately or looking unprofessional—first impression matters',
        'Knocking on doors where people have explicitly said no (checking do-not-knock list)'
      ],
      nextNodes: ['ins_03_reading_homeowner'],
      prevNodes: ['ins_01_storm_territory'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '5-10 min per door',
      difficulty: 'beginner'
    },

    {
      id: 'ins_03_reading_homeowner',
      branch: 'insurance',
      phase: 'prospecting',
      phaseLabel: 'Prospecting & First Contact',
      phaseNumber: 1,
      title: 'Reading the Homeowner',
      subtitle: 'Identifying personality types and adjusting your approach accordingly',
      icon: '🎭',
      content: `<div class="rda-content">
        <p>Every homeowner is different. Some are excited about a new roof. Some are overwhelmed by the process. Some are hostile to contractors. Your job is to read the room in the first 30 seconds and adjust your approach. This skill separates good reps from great ones.</p>

        <p><strong>The Skeptic:</strong> They've heard pitches before. They're guarded. Don't oversell. Be factual: "You had a hail storm come through. I can check the damage and you'll know for sure. Takes 20 minutes, no obligation." They respect directness and respect that you're not wasting their time. Offer specifics: "I'll look at the roof, take photos, and write down what I see. You can share that with your insurance company if you decide to file."</p>

        <p><strong>The Eager Homeowner:</strong> They're excited about getting their roof done. They may have already looked and seen damage themselves. With these folks, you can be enthusiastic too, but temper expectations: "Great—we're going to do a thorough inspection, and then we'll talk you through the insurance process step by step." They need to know you'll guide them, not just push them.</p>

        <p><strong>The Overwhelmed One:</strong> They're dealing with a lot—maybe their roof is just one of many problems from the storm. They're stressed. Don't add to it. Be calm, clear, and reassuring: "Here's what we'll do: I'll inspect today, write a detailed report, and we'll go through it together before you talk to insurance. You won't be alone in this process."</p>

        <p><strong>The Hostile One:</strong> Some people have had a bad experience before. They're defensive. Don't take it personally. Keep your voice calm and your demeanor respectful. "I get it—not all contractors are created equal. I'm here to help you do this right. Let me show you what the damage looks like, and you decide if you want to move forward." Sometimes they'll come around; sometimes they won't. That's okay.</p>

        <p><strong>The Do-Not-Knock Decision:</strong> Some homeowners will be rude, dismissive, or explicitly say they never want to see you again. Honor that. Add them to your do-not-knock list immediately. Harassing someone who's said no is a lawsuit waiting to happen and damages your reputation. Move on.</p>
      </div>`,
      checklist: [
        'Observe body language in first 30 seconds',
        'Listen to how they respond to your opening',
        'Identify which personality type they seem to be',
        'Adjust your pitch accordingly (direct, enthusiastic, calm, or respectful)',
        'Ask clarifying questions about their situation',
        'Note any red flags or signs of hostility',
        'Add hostile/no-interest people to do-not-knock list immediately',
        `Document the homeowner's personality type for follow-up strategy`
      ],
      proTips: [
        `The best homeowners are usually curious and open—they're already thinking about their roof`,
        'If someone is very stressed, sometimes the best thing you can do is listen and be calm. That builds trust',
        'Skeptics often become your best customers once they trust you—earn it by being straightforward',
        `Hostile people often stem from a bad experience. You can't fix that instantly. Sometimes walking away is the right move`
      ],
      commonMistakes: [
        `Treating all homeowners the same; one-size-fits-all pitch doesn't work`,
        'Ignoring hostile signals and pushing harder; this escalates the situation',
        `Not respecting boundaries; if someone says no, don't keep knocking`,
        `Assuming skepticism means they're not a good prospect; skeptics can be your best customers`
      ],
      nextNodes: ['ins_04_free_inspection_pitch'],
      prevNodes: ['ins_02_door_knock'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-3 min at door',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_04_free_inspection_pitch',
      branch: 'insurance',
      phase: 'prospecting',
      phaseLabel: 'Prospecting & First Contact',
      phaseNumber: 1,
      title: 'The Free Inspection Pitch',
      subtitle: 'Offering value without being pushy and reframing as a diagnostic, not a sales tool',
      icon: '🔍',
      content: `<div class="rda-content">
        <p>The free inspection is your gateway. It gets you on the roof, it positions you as the expert, and it starts a relationship. But you have to frame it right. This isn't a sales pitch—it's a diagnostic. You're answering a question for them: "Is there damage or not?"</p>

        <p><strong>The Framing:</strong> "Here's what I'd suggest: let me do a free inspection. It takes about 20 minutes, and I'll go through the whole roof systematically. I'll take photos, write down what I find, and give you a detailed report. Then you'll know for sure if there's damage. You can share that with your insurance company if you decide to file, use another contractor, or file it in your records. Either way, you'll have the information. Sound fair?" This positions you as helpful, not salesy.</p>

        <p><strong>Handling "I Already Have a Roofer":</strong> This is one of the most common objections. Don't argue. Say: "That's great—you're in good hands then. If you ever want a second opinion or they're backed up, feel free to reach out. Here's my card." Sometimes that person will call you back in 2 weeks when they're still waiting. Sometimes they won't. Either way, you didn't burn a bridge.</p>

        <p><strong>No Money Down:**</strong> You're not asking for a deposit, a signature, or a credit card to schedule. This isn't a sales call. It's a free service. The only ask is their time and permission to be on the roof. That's it. This removes all friction and resistance.</p>

        <p><strong>Documentation of Permission:</strong> You still need a simple inspection agreement that says you have permission to inspect the property. Keep it one page. It doesn't obligate them to anything—it just covers you legally. "This inspection agreement simply documents that you authorized me to inspect your roof and property on [date]." Most people sign without hesitation.</p>

        <p><strong>Setting Expectations:</strong> Be clear: "I'll inspect today and get you a report within 48 hours. If there is damage and you decide to move forward, then we'll talk about next steps. But right now, we're just fact-finding. You're not committing to anything." This reduces psychological pressure and makes people more likely to say yes.</p>
      </div>`,
      checklist: [
        'Lead with the diagnostic framing, not the sale',
        'Explain the inspection clearly: 20 minutes, photos, detailed report',
        'Emphasize "you own the report"—they can use it however they want',
        'Have a simple one-page inspection agreement ready',
        'Get verbal permission for roof access clearly on record',
        `Explain there's no obligation and no cost`,
        'Schedule the inspection within 48 hours',
        'Confirm their contact info (phone, email, best time to reach them)'
      ],
      proTips: [
        'The best inspections happen when homeowners are home and can walk the roof with you; they see the damage firsthand',
        'If they say "Let me think about it," get their contact info and follow up the same day: "Just wanted to check in—did you have any questions?"',
        `The inspection agreement builds goodwill; it shows you're professional and above-board`,
        'Take the inspection seriously. If you find damage, your thorough report is already a sales tool. If you find minimal damage, be honest—it builds trust'
      ],
      commonMistakes: [
        'Overselling the benefits of an inspection; keep it simple and factual',
        'Not having an inspection agreement ready; this looks unprepared',
        `Pushing for a signature before they've agreed to the inspection`,
        'Staying too long at the door explaining; get to the point, offer the value, and close'
      ],
      nextNodes: ['ins_05_objections_door'],
      prevNodes: ['ins_03_reading_homeowner'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '3-5 min at door',
      difficulty: 'beginner'
    },

    {
      id: 'ins_05_objections_door',
      branch: 'insurance',
      phase: 'prospecting',
      phaseLabel: 'Prospecting & First Contact',
      phaseNumber: 1,
      title: 'Handling Objections at the Door',
      subtitle: 'Top 10 objections and professional responses that don\'t sound defensive',
      icon: '⚡',
      content: `<div class="rda-content">
        <p>Objections are normal. They're not rejections—they're just hesitations or concerns. Your job is to acknowledge them, answer them directly, and move forward. Don't argue. Don't get defensive. Stay calm and helpful.</p>

        <p><strong>Objection #1: "I'm not interested."</strong> Response: "No problem. Have you looked at your roof recently since the storm?" If no: "That's what I'm offering—a fresh look to see if there's damage. If there isn't, great, you'll know for sure. If there is, you'll have all the information. How about next Tuesday?"</p>

        <p><strong>Objection #2: "We already have a roofer / contractor."</strong> Response: "That's great—sounds like you're being proactive. If you ever want a second opinion or they're backed up, give us a call. Here's my card." Don't push. Some will call back.</p>

        <p><strong>Objection #3: "We already filed a claim."</strong> Response: "Perfect. Well, once the adjuster comes out and they scope the damage, if there are items they missed, we can help submit supplements. Also, when you're ready to do the work, we'd love to be your contractor. Want me to check our work in—worst case, you'll have my number if you need anything."</p>

        <p><strong>Objection #4: "I don't trust contractors."</strong> Response: "I respect that. A lot of people have had bad experiences. Here's what I suggest: let me inspect the roof, give you a detailed report, and you can check our reviews, ask your neighbors, whatever you need to do. You won't make any decisions today. Deal?" Respect their skepticism. Earn trust by being patient and transparent.</p>

        <p><strong>Objection #5: "This sounds like a sales pitch."</strong> Response: "I get it. Here's the deal: I don't benefit from inspecting your roof unless you decide to move forward. I'm just checking if there's damage. If there isn't, I move on. If there is, then we talk about next steps. Fair?"</p>

        <p><strong>Objection #6: "How do I know you're legit?"</strong> Response: "Great question. You can check us out: [website], [license number], [reviews]. Here's a card. Or, ask your neighbors—we've been working in this area since [date/reference]. I can also give you references if you want."</p>

        <p><strong>Objection #7: "I can't afford a new roof."</strong> Response: "I understand. That's actually why insurance is so important. If there's damage from the storm, your insurance might cover it. We just need to find out if there's damage first. And the inspection is free—no cost, no obligation."</p>

        <p><strong>Objection #8: "The roof looks fine to me."</strong> Response: "That's actually really common. Hail damage isn't always obvious from the ground. A lot of damage is on the back side of shingles or on the ridges. Takes an expert eye up close. Let me take a look—might surprise you either way."</p>

        <p><strong>Objection #9: "I need to talk to my spouse / family first."</strong> Response: "Totally understand. When would be a good time to do the inspection when you can both be home? Or I can do it whenever and just provide the report, and you two can go through it together." Make it easy.</p>

        <p><strong>Objection #10: "I'll call you if I need you."</strong> Response: "Great. I'll leave you my card. Just so you know, the sooner we inspect, the sooner we can file, and the sooner you get your roof done. Storms like this create a backlog pretty quick. You available Tuesday or Wednesday?" Try for commitment; if you don't get it, leave the card and follow up in a few days.</p>
      </div>`,
      checklist: [
        'Stay calm and not defensive with any objection',
        'Repeat back what they said to show you understand',
        'Provide a direct answer that addresses their concern',
        `Don't oversell; offer the free inspection as the solution`,
        'Always try to move toward scheduling, not away',
        'If they refuse, leave a card and follow up in 3-5 days',
        'Track objections to identify patterns in your territory',
        'Document their specific concern for future outreach'
      ],
      proTips: [
        `The best response to an objection is often just to listen, then ask a clarifying question: "What's your main concern?"`,
        `Don't over-explain. Answer the objection and move forward. If they're still not interested, move on`,
        `Objections often hide real concerns. "I need to talk to my spouse" might mean "I need to think about this" or "I'm not convinced yet"`,
        `If you get the same objection from 10 people in a row, maybe it's how you're opening, not how you're closing`
      ],
      commonMistakes: [
        'Getting defensive or argumentative; this kills the deal and ruins your reputation',
        `Not listening to the actual objection; you launch into a prepared response that doesn't fit`,
        `Continuing to push after they've said no multiple times; this annoys people`,
        'Not tracking your success rate with objections; you should be measuring what works'
      ],
      nextNodes: ['ins_06_schedule_inspection'],
      prevNodes: ['ins_04_free_inspection_pitch'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-5 min per objection',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_06_schedule_inspection',
      branch: 'insurance',
      phase: 'prospecting',
      phaseLabel: 'Prospecting & First Contact',
      phaseNumber: 1,
      title: 'Getting on the Roof / Scheduling the Inspection',
      subtitle: 'Signing the inspection agreement and coordinating logistics',
      icon: '📋',
      content: `<div class="rda-content">
        <p>You've cleared the objections and they're interested in an inspection. Now you need to lock in a time and get legal protection. This is straightforward but important.</p>

        <p><strong>The Inspection Agreement:</strong> This is a one-page document that documents their permission for you to inspect the property. It should include: property address, date of inspection, homeowner name and contact info, and a simple statement like "I authorize [Company Name] to conduct a roof inspection and take photographs of my property on [date] for damage assessment purposes." That's it. Not complicated. Keep it simple and non-threatening. Most people sign without hesitation once they understand it's just permission, not an obligation.</p>

        <p><strong>Scheduling the Appointment:</strong> Be specific. "How about Tuesday at 2 PM?" Give them options—don't make them work too hard. "I'm available Tuesday at 1 or 3, or Wednesday morning at 10. Which works best?" Write down the time, the address, and their phone number. Confirm it back to them: "So I'll see you Tuesday at 2 PM at [address]. My number is [phone]—if anything changes, just text or call."</p>

        <p><strong>Roof Access Logistics:</strong> Find out how you'll access the roof. Do they have a ladder? Is there a gate? Any dogs? Are there delicate plants you need to avoid? This shows you're thoughtful and careful, and it prevents problems on inspection day. "Do you have a ladder, or should I bring mine?" Most people will say they have one; some will appreciate you offering.</p>

        <p><strong>Weather & Timing:</strong> Don't schedule an inspection on a day when it's supposed to rain or when the roof will be wet. Wet roofs are slippery and harder to inspect properly. Clear days are best. If the weather is bad, reschedule: "Weather doesn't look good for Tuesday—how about we move to Wednesday when it clears up?"</p>

        <p><strong>Communication Before the Appointment:</strong> The day before, send a text or call to confirm: "Hi [name], just confirming our inspection tomorrow at 2 PM. Looking forward to it." This reduces no-shows and keeps you top of mind. If they cancel, offer to reschedule immediately rather than let the lead go cold.</p>

        <p><strong>Showing Up On Time:**</strong> Be early. Not crazy early (like 30 minutes), but 5-10 minutes early shows respect for their time. Bring your tools, camera, measuring tape, and clipboard. Look professional. This is their first time seeing you as a professional, and you want to make a good impression.</p>
      </div>`,
      checklist: [
        'Have inspection agreement form ready to sign',
        'Use specific times: "Tuesday at 2 PM" not "sometime Tuesday"',
        'Confirm address, phone number, and best way to reach them',
        'Ask about ladder access and roof entry points',
        'Ask about any hazards (dogs, plants, structures)',
        `Check weather forecast; don't schedule on rain days`,
        'Enter appointment into your CRM/calendar immediately',
        'Send a text or call the day before to confirm',
        'Arrive 5-10 minutes early on inspection day'
      ],
      proTips: [
        'Early morning or late afternoon inspections are best—sun position helps you see damage better',
        `If they don't have a ladder, bring yours; showing up prepared builds confidence`,
        `The inspection agreement builds trust; it shows you're professional and operating above-board`,
        `Inspections take longer than you think; pad your schedule. Don't rush from one to the next`
      ],
      commonMistakes: [
        'Not confirming the day before; no-shows are painful',
        `Scheduling too close together; you'll be late and stressed`,
        'Not having the inspection agreement ready; this looks unprofessional',
        'Trying to inspect in bad light or wet conditions; your photos will be poor'
      ],
      nextNodes: ['ins_07_roof_inspection_fundamentals'],
      prevNodes: ['ins_05_objections_door'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '3-5 min',
      difficulty: 'beginner'
    },

    // ============================================================================
    // PHASE 2: INSPECTION & DAMAGE ASSESSMENT (5 nodes)
    // ============================================================================

    {
      id: 'ins_07_roof_inspection_fundamentals',
      branch: 'insurance',
      phase: 'inspection',
      phaseLabel: 'Inspection & Damage Assessment',
      phaseNumber: 2,
      title: 'Roof Inspection Fundamentals',
      subtitle: 'Safety, tools, and systematic inspection methodology',
      icon: '🏠',
      content: `<div class="rda-content">
        <p>An inspection is more than just looking at a roof. It's a systematic, documented assessment that will be presented to an insurance adjuster and potentially used in a legal process. You need to be thorough, methodical, and safe.</p>

        <p><strong>Safety First:</strong> Never cut corners on safety. If a roof is steep or wet, use fall protection. If it's icy or covered in moss, wait for better conditions or take extra precautions. One injury ends your career. Your safety is not negotiable. Tell the homeowner: "This looks steep/slippery—I'm going to take my time and be careful." They'll respect that. If conditions are genuinely unsafe, reschedule.</p>

        <p><strong>Tools You Need:</strong> A measuring tape (at least 25 feet), a piece of chalk (white or yellow), a good camera (phone is fine, but consider a backup), binoculars (for details you can't reach), a clip board, paper, and a pen. Consider bringing a small hammer or hail spike to demonstrate impact marks. These are your toolkit. Use them consistently on every inspection.</p>

        <p><strong>Systematic Inspection Pattern:</strong> Don't wander randomly. Start at the ridge and work down one slope methodically, section by section. Go up, over, and down. Check all four sides if it's a pitched roof. Check every valley. Check where the roof meets walls, dormers, or structures. Check all transitions and flashings. This ensures you don't miss anything. Take notes on your clipboard as you go: "South slope: multiple hail hits, ridge cap damaged, valley shows granule loss."</p>

        <p><strong>The Ridge & Hips:</strong> These are the most exposed areas. They take the first hit in a hail storm. Spend time here. Look for cracking in ridge caps, tears, splits, or granule loss. Document carefully. Hip ridges often get missed by adjusters, but they're critical to document.</p>

        <p><strong>Valleys & Transitions:</strong> Valleys are where water flows. Damage here is serious. Look for splits, tears, or loosening in valley flashing. Any gap here is a future leak. Document with close-up photos and measurements.</p>

        <p><strong>Field Shingles:</strong> Walk the entire roof and look at shingle surfaces. Hail hits create dimples, bruises, or punctures. Wind damage creates lifted tabs, exposed nails, or missing shingles. Use your chalk to circle hail hits—this helps you count and document them. Take photos of each area with and without chalk circles.</p>

        <p><strong>Timing & Efficiency:</strong> A typical inspection takes 20-45 minutes depending on roof size and complexity. Don't rush; don't linger. You're being thorough but efficient. The homeowner should see you working seriously, not wasting time.</p>
      </div>`,
      checklist: [
        'Assess roof safety before going up (angle, weather, condition)',
        'Bring all necessary tools: tape, chalk, camera, binoculars, clipboard',
        `Brief the homeowner on what you'll be looking for`,
        'Start at ridge, work systematically down each slope',
        'Inspect all four sides if applicable',
        'Check every valley, transition, and flashing carefully',
        'Use chalk to circle and count hail hits',
        'Take photos during inspection (before you leave)',
        'Document dimensions: ridge length, roof area, slope angle',
        'Maintain safety throughout—no shortcuts'
      ],
      proTips: [
        'The ridge and hips are your money areas—hail and wind damage shows up there first and worst',
        'Binoculars let you see details from the ground; use them to verify before climbing',
        'Chalk circles serve two purposes: they help you count and they make damage obvious in photos',
        'If the homeowner is interested and safe, invite them to walk the roof with you; seeing damage firsthand makes them invested'
      ],
      commonMistakes: [
        'Rushing the inspection; you miss damage and look unprofessional',
        `Not being systematic; you get confused about which slope you've checked`,
        'Not documenting as you go; you rely on memory and miss details',
        'Ignoring safety; one slip ruins your business'
      ],
      nextNodes: ['ins_08_storm_vs_wear'],
      prevNodes: ['ins_06_schedule_inspection'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '30-45 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_08_storm_vs_wear',
      branch: 'insurance',
      phase: 'inspection',
      phaseLabel: 'Inspection & Damage Assessment',
      phaseNumber: 2,
      title: 'Identifying Storm Damage vs. Wear',
      subtitle: 'How to tell recent hail/wind damage from age-related wear, and what adjusters want to see',
      icon: '🔍',
      content: `<div class="rda-content">
        <p>This is the critical skill that separates amateur inspectors from professionals. Adjusters are trained to spot the difference between legitimate storm damage and wear-and-tear. You need to be able to distinguish as well—and articulate it clearly in your documentation.</p>

        <p><strong>Hail Damage Indicators:</strong> Fresh hail hits create impact marks on shingles. Look for: dimples or bruises (shingles show a depressed mark without necessarily tearing), cracks emanating from the impact point, or punctures through the shingle. The key: hail damage is usually concentrated in an area (the hail path) and sudden. You'll see damaged shingles next to pristine ones. The damage also looks recent—the underlying wood or base is exposed and hasn't oxidized yet.</p>

        <p><strong>Old Damage vs. New Damage:</strong> If a shingle has been broken/missing for months, the area around it shows weathering. Exposed wood oxidizes, gets darker, or shows moss/algae growth. If it's fresh hail damage, the exposed areas are light-colored and bright. This is a key tell. Adjusters use this. Take photos that clearly show the freshness of the damage.</p>

        <p><strong>Granule Loss from Hail vs. Age:</strong> Every roof loses granules with age. But hail-caused granule loss has a pattern. It's concentrated where hail hit. Old granule loss from age is more uniform across the roof. In your report, you'll note: "Granule loss concentrated on south ridge and east slope where hail hit; rest of roof shows normal age-related granule loss." This distinction matters.</p>

        <p><strong>Wind Damage Patterns:</strong> Wind damage often lifts shingle tabs, exposes nails, or tears shingles away from the roof. You'll see a directional pattern—wind usually comes from one direction and affects that side more. Hail is non-directional. Documentation: "South and west-facing slopes show lifted tabs consistent with wind damage from the reported southwest storm direction."</p>

        <p><strong>Roof Age & Context:</strong> A 12-year-old roof will have more wear than a 3-year-old roof. Adjusters know this. In your report, note the roof age and material type. "Architectural asphalt shingles, approximately 10 years old, showing normal wear plus fresh storm damage." This contextualizes the damage and builds credibility.</p>

        <p><strong>Secondary Damage Indicators:</strong> If a roof has been leaking from an old damage point, you'll see water staining, mold, or moss growth around that area. Fresh storm damage won't show these signs yet. Use this to explain why something looks old versus new: "This missing shingle on the west slope (old damage) shows algae and discoloration. The hail-hit shingles on the south slope (new damage) are exposed but fresh, no oxidation yet."</p>

        <p><strong>Photographic Proof:</strong> Your photos need to show the freshness and pattern. Take photos with a reference object (a coin, ruler, or your hand) near damage so scale is clear. Take wide shots showing the damage pattern. Take close-ups showing the impact marks or fresh breaks. Adjusters will scrutinize these.</p>
      </div>`,
      checklist: [
        'Document roof age and material type in your notes',
        'Look for impact marks, cracks, punctures from hail',
        'Assess color of exposed areas (bright=fresh, dark=old)',
        'Look for directional patterns (wind vs. non-directional hail)',
        'Check for granule loss concentration vs. uniform wear',
        'Note secondary damage indicators (water stains, algae, etc.)',
        'Take reference photos showing damage scale',
        'Photograph wide shots of damage patterns',
        'Take close-ups of impact marks and fresh breaks',
        'Document the date of inspection and date of reported storm'
      ],
      proTips: [
        `Adjusters are experts at spotting age-related wear; don't try to pass off old damage as storm damage—it will backfire`,
        'Fresh damage has bright, exposed areas. Old damage shows oxidation and discoloration. Use lighting to your advantage in photos',
        'Take photos at different angles and times of day; sun position affects how damage shows up',
        'When in doubt, document what you see objectively: "Multiple hail impacts on south slope, concentrated in 30-foot section, consistent with hail path pattern"'
      ],
      commonMistakes: [
        'Trying to document old damage as storm damage; this kills your credibility',
        'Not noting roof age and material; context matters to adjusters',
        `Taking photos that don't show freshness or impact clarity`,
        'Making assumptions about damage age without visual evidence'
      ],
      nextNodes: ['ins_09_documenting_everything'],
      prevNodes: ['ins_07_roof_inspection_fundamentals'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '15-20 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_09_documenting_everything',
      branch: 'insurance',
      phase: 'inspection',
      phaseLabel: 'Inspection & Damage Assessment',
      phaseNumber: 2,
      title: 'Documenting Everything',
      subtitle: 'Photo protocol, chalk marking, damage reporting, and GPS tagging',
      icon: '📸',
      content: `<div class="rda-content">
        <p>Documentation is everything. Your inspection is only valuable if it's documented professionally and thoroughly. An adjuster will rely heavily on your photos and written report. Get this right.</p>

        <p><strong>Photo Structure:</strong> Take three types of photos: (1) Wide shots showing overall damage pattern and roof area, (2) Medium shots showing sections with damage and context, (3) Close-ups showing specific damage marks. For a typical roof, you might take 50-100 photos. This sounds like a lot, but you're covering every side, every section, and every damage type. Better to have too many than too few.</p>

        <p><strong>Photo Sequence:</strong> Start with a wide overview of the house. Then work systematically: south slope wide, south slope sections, north slope wide, north slope sections, east/west slopes, valleys, flashing, and ridge. Keep it logical so anyone reading your report can follow along. Number your photos or note them in a list so you can reference "Photo 23: South ridge cap damage" in your report.</p>

        <p><strong>Lighting & Angles:</strong> Take photos from multiple angles. Sun position matters—sometimes shadow shows damage better, sometimes direct sun does. Take photos both with and without chalk marks so the adjuster can see raw damage and documented damage. Time of day affects how details show. If possible, shoot early morning or late afternoon when sun is lower and shadows help show damage relief.</p>

        <p><strong>Chalk Marking Protocol:</strong> Use white or bright yellow chalk to circle or mark hail hits. This serves multiple purposes: (1) it helps you count, (2) it makes damage obvious in photos, (3) it shows the adjuster and homeowner exactly what you're documenting. Don't go crazy—mark significant damage clusters, not every single minor hit. Typically, mark 10-50 impact areas depending on damage extent.</p>

        <p><strong>Reference Objects:</strong> In close-up photos, place a common object for scale: a coin, a ruler, your hand, or a business card. This shows the adjuster the actual size of damage. A 1-inch hail hit looks different from a quarter-inch hit, and scale matters. "South ridge cap: 1-inch hail impact, 3 feet west of the peak" is specific and credible.</p>

        <p><strong>GPS Tagging:</strong> Modern phones automatically tag photos with location and time. Make sure this is enabled. This metadata is part of your professional documentation. It proves when and where the photos were taken. Some software will also note the GPS coordinates in your report, which builds credibility.</p>

        <p><strong>Written Damage Report:</strong> Accompany photos with written notes. Not a full novel—clear, concise descriptions: "South slope: multiple hail impacts concentrated in 40-foot section, ranging from 0.75 to 1 inch diameter, concentrated along ridge and upper third of slope. Ridge cap shows cracking and displacement. Underlying deck appears sound." This is professional and specific.</p>

        <p><strong>Roof Dimensions & Coverage Area:</strong> Measure or estimate roof dimensions. Count the ridge length. Get an approximate square footage (you can calculate from house dimensions). This helps with insurance claims and ensures you're calculating material costs correctly later. Note: "Roof dimensions approximately 35 feet x 50 feet (1,750 sq ft), 7/12 pitch, 4 slopes."</p>
      </div>`,
      checklist: [
        'Take 50-100 photos per typical inspection (more for large/complex roofs)',
        'Include wide shots, medium shots, and close-ups',
        'Use chalk to mark and circle damage areas',
        'Include reference objects (coin, ruler, hand) in close-up photos',
        'Take photos from multiple angles and in good lighting',
        'Enable GPS tagging on your camera/phone',
        'Document roof dimensions: ridge length, estimated square footage, pitch',
        'Write clear, concise descriptions of damage by area',
        'Number or reference photos in your written report',
        'Include date and storm information in header of report'
      ],
      proTips: [
        `Take way more photos than you think you need; you can always delete later, but you can't retake them after you leave the roof`,
        `Chalk marks in photos are visual proof to the homeowner and adjuster; they're not cheating—they're professional documentation`,
        'Late afternoon sun (2-4 PM) often shows damage detail better than midday sun',
        'Save all photos with consistent naming: "Address_Date_SlideLocation_01.jpg"—this keeps things organized'
      ],
      commonMistakes: [
        'Taking too few photos and missing damage; better to have extras',
        `Not including reference objects; the adjuster can't judge scale`,
        'Unclear photo order; the adjuster wastes time trying to understand your documentation',
        'Not writing corresponding notes; great photos with no context are less valuable'
      ],
      nextNodes: ['ins_10_interior_inspection'],
      prevNodes: ['ins_08_storm_vs_wear'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '20-30 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_10_interior_inspection',
      branch: 'insurance',
      phase: 'inspection',
      phaseLabel: 'Inspection & Damage Assessment',
      phaseNumber: 2,
      title: 'Interior Inspection',
      subtitle: 'Checking attics, ceilings, and walls for water intrusion and secondary damage',
      icon: '🏘️',
      content: `<div class="rda-content">
        <p>The interior tells the story of water intrusion. Even if the roof looks relatively okay, water may have found its way inside. Interior damage often justifies larger claims and more extensive repairs. This part of the inspection is critical—and many new reps skip it or do it superficially.</p>

        <p><strong>The Attic Inspection:</strong> Go up into the attic with a flashlight. Look at the underside of the roof deck. Are there water stains? Discoloration? Soft spots in insulation? Recent rain or moisture? This is proof of water intrusion. Even small stains can be significant. Document with photos. Note the location relative to roof damage: "Water stains on south slope deck, approximately 8 feet from east gable, consistent with location of hail damage on exterior."</p>

        <p><strong>Mold Indicators:</strong> If you see mold (dark, fuzzy growth), document it but don't diagnose it. Say: "I see discoloration that may indicate mold. You should have a mold specialist inspect." Mold can significantly increase claim value and repair scope. It also creates insurance and liability concerns for you. Report it, document it, move on.</p>

        <p><strong>Wood Rot & Structural Damage:</strong> Look at the wood framing. Is it soft? Discolored? Deteriorating? Press gently with a tool—sound wood resists, rotten wood gives. Document any concerns. This feeds into scope later (new decking, structural repair). Note: "Rafter near hail impact area shows soft spots, consistent with prior water intrusion."</p>

        <p><strong>Insulation Damage:</strong> If insulation is wet, compressed, or contaminated, it may need replacement. Document the area. "Fiberglass insulation below south slope shows compression and water damage, approximately 15 sq ft." This is often an add-on to roof jobs.</p>

        <p><strong>Ceiling & Wall Inspection (Downstairs):</strong> Walk the house and look at ceilings and walls for water stains, paint bubbling, or drywall damage. Take photos. Even old stains can be documented as evidence of prior water intrusion from the roof. "Master bedroom: water stain on ceiling near northeast wall, suggests roof water intrusion into that area." These stains justify interior repair costs.</p>

        <p><strong>Getting Permission & Safety:</strong> Ask permission before going into the attic. It can be hot, dusty, and dangerous if you're not careful. Use a flashlight and watch for nails. Don't step on insulation—step on joists. If it's too cramped or unsafe, document what you can see from the attic opening and move on.</p>

        <p><strong>Connecting Interior to Exterior:**</strong> This is important for your documentation. Interior damage didn't happen randomly—it corresponds to exterior damage. Your job is to connect the dots: "South slope exterior shows hail damage with cracked shingles. Interior attic space below shows recent water staining on deck. This suggests water intrusion from the roof damage." This narrative is powerful in a claim.</p>
      </div>`,
      checklist: [
        'Ask permission before accessing attic',
        'Use flashlight and inspect carefully',
        'Look for water stains, discoloration, soft spots',
        'Check insulation condition (wet, compressed, moldy?)',
        'Document wood framing condition',
        'Photo document any concerning findings',
        'Walk entire house checking ceilings and walls for stains',
        'Note locations relative to roof damage',
        'Connect interior findings to exterior damage',
        'If mold suspected, recommend specialist inspection'
      ],
      proTips: [
        'Water stains on the underside of a roof deck are gold—they prove water intrusion and justify the claim',
        `Interior damage often doesn't show until after water has been there a while; document what you see and suggest homeowner monitor for further damage`,
        'Mold should be flagged but not diagnosed by you; let the adjuster or a specialist assess',
        'Older water stains are still valuable evidence; they show the roof has been vulnerable for some time'
      ],
      commonMistakes: [
        'Skipping the interior inspection; you miss critical damage that would increase claim value',
        'Not connecting interior to exterior damage; the adjuster has to guess the relationship',
        `Diagnosing mold; you're not qualified—just document and recommend specialist`,
        'Taking poor interior photos; use flash and multiple angles'
      ],
      nextNodes: ['ins_11_inspection_report'],
      prevNodes: ['ins_09_documenting_everything'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '15-20 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_11_inspection_report',
      branch: 'insurance',
      phase: 'inspection',
      phaseLabel: 'Inspection & Damage Assessment',
      phaseNumber: 2,
      title: 'The Inspection Report',
      subtitle: 'Building a professional damage assessment document for insurance review',
      icon: '📄',
      content: `<div class="rda-content">
        <p>The inspection report is your flagship document. The homeowner will show it to their insurance company. The adjuster will review it. It might end up in an appraisal or legal proceeding. This needs to be professional, thorough, and credible.</p>

        <p><strong>Report Structure:</strong> (1) Header with company name, contact info, date, property address, (2) Executive Summary (1-2 paragraphs describing the storm, damage, and scope), (3) Property Information (roof age, materials, dimensions, condition prior to storm), (4) Damage Assessment (detailed by roof area), (5) Interior Findings, (6) Attached Photos with captions, (7) Recommendations. This structure is professional and easy to follow.</p>

        <p><strong>The Executive Summary:</strong> "On [date], a hail storm impacted [address] with hail up to [size] and winds of approximately [speed]. Inspection on [date] identified multiple areas of roof damage. Estimated scope: [brief description]." Keep it factual, not sensational. The adjuster will verify your claims.</p>

        <p><strong>Property Information Section:</strong> "Roof material: Architectural asphalt shingles by [manufacturer if identifiable]. Age: approximately 10 years. Roof dimensions: approximately 1,800 sq ft, 7/12 pitch. Prior condition: [good/fair/poor]." This contextualizes everything. A 2-year-old roof with storm damage has a different story than a 15-year-old roof with storm damage.</p>

        <p><strong>Damage Assessment by Area:</strong> Break down by roof section: "South Slope (40% of roof): Multiple hail impacts ranging from 0.75 to 1.25 inches diameter, concentrated along ridge and upper third. Ridge cap shows cracking and separation. Approximately [number] square feet affected. Repair required: full slope replacement." Do this for each roof area. Be specific on square footage.</p>

        <p><strong>Interior Findings:</strong> "Attic inspection revealed water staining on underside of south slope deck, consistent with roof damage location. No active moisture detected. Insulation below damage area shows compression and staining. Recommend insulation replacement for affected area." Factual, professional, tied to exterior damage.</p>

        <p><strong>Photo Captions:**</strong> Each photo needs a caption. "Photo 12: South ridge cap—1-inch hail impact with cracking visible." "Photo 34: Attic underside below south slope—water staining on deck." Captions make your photos meaningful instead of just visual content.</p>

        <p><strong>Tone & Language:</strong> Write professionally but conversationally. "The roof sustained significant damage from hail" is better than "The roof evidenced damage" or "The roof got totally wrecked." Be credible, not sensational. Adjusters are trained to spot exaggeration. Stick to facts and evidence.</p>

        <p><strong>Recommendations Section:</strong> "Based on findings, recommend: (1) Complete re-roof of affected slopes due to extent of damage and age of roof, (2) Insulation replacement in affected attic area, (3) Deck repair/replacement if damage exists underneath shingles (to be confirmed during tear-off)." This gives direction without making promises.</p>

        <p><strong>Professional Presentation:</strong> Use a template if you have one. Include your company logo. Number pages. Proofread. Bad spelling and grammar makes you look unprofessional. If the homeowner is taking this to an adjuster, you want it to represent your company well.</p>
      </div>`,
      checklist: [
        'Create report within 48 hours of inspection',
        'Include company header with contact information',
        'Write executive summary (1-2 paragraphs)',
        'Document property information: materials, age, dimensions',
        'Break down damage assessment by roof section',
        'Include square footage for each damaged area',
        'Document interior findings with connection to exterior damage',
        'Caption every photo with specific location and damage type',
        'Maintain professional, factual tone throughout',
        'Proofread before delivery',
        'Include clear recommendations for next steps'
      ],
      proTips: [
        `Include photos on the same pages as descriptions; don't dump all photos at the end`,
        'Be specific on square footage; "some damage" is vague; "324 sq ft of south slope" is credible',
        'Connect interior to exterior: this narrative shows cause-and-effect and justifies scope',
        'Frame recommendations as guidance, not final quotes; the adjuster and homeowner will make final decisions'
      ],
      commonMistakes: [
        'Over-selling damage; stick to facts or lose credibility',
        'Poor photo captions; great photos without context are less valuable',
        `Not documenting square footage; the adjuster can't estimate cost without specifics`,
        'Sloppy presentation; spelling errors and poor formatting make you look unprofessional'
      ],
      nextNodes: ['ins_12_educate_homeowner'],
      prevNodes: ['ins_10_interior_inspection'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '45-60 min',
      difficulty: 'intermediate'
    },

    // ============================================================================
    // PHASE 3: FILING THE CLAIM (4 nodes)
    // ============================================================================

    {
      id: 'ins_12_educate_homeowner',
      branch: 'insurance',
      phase: 'filing',
      phaseLabel: 'Filing the Claim',
      phaseNumber: 3,
      title: 'Educating the Homeowner',
      subtitle: 'Explaining insurance process, deductibles, and realistic timelines',
      icon: '📚',
      content: `<div class="rda-content">
        <p>Most homeowners have never filed an insurance claim. They don't understand the process, they're confused about deductibles, and they expect everything to happen in a week. Your job is to educate them—calmly and clearly—so they have realistic expectations and aren't surprised later.</p>

        <p><strong>How Insurance Works (Simple Version):</strong> "Here's how this works. You pay your insurance premium to protect your home. When damage happens from a covered event—like the hail storm we documented—you file a claim. Insurance sends an adjuster to inspect the damage. They decide what's covered, calculate the damage cost, and issue a payment. We get paid after the work is done. You own the process—it's your insurance, your roof. We're here to guide you through it."</p>

        <p><strong>Deductibles Explained:</strong> "Your insurance policy has a deductible. This is what you pay out of pocket before insurance covers the rest. For example, if you have a $1,000 deductible and the damage is $8,000, insurance pays $7,000 and you pay $1,000. Most homeowners have deductibles between $500 and $2,000. You should check your policy to see yours. It affects whether the claim is worth filing." This is honest and helps them make informed decisions.</p>

        <p><strong>ACV vs. RCV:</strong> "Most policies pay 'actual cash value' (ACV), which means insurance covers the cost to fix the damage minus depreciation for roof age. Older roofs get less coverage. Some policies have 'replacement cost value' (RCV), which is better—it covers the full cost to fix, no depreciation penalty. Check your policy to see which you have." This is important because it affects their financial outcome.</p>

        <p><strong>Depreciation & Holdback:**</strong> "Insurance usually holds back a percentage of the payout (often 20-30%) until the work is completed and inspected. Here's how it works: (1) Adjuster approves claim, insurance pays the ACV portion, (2) We do the work, (3) We submit proof of completion and final invoice, (4) Insurance releases the holdback. This usually takes 2-4 weeks after the work is finished. It's a normal process."</p>

        <p><strong>Timeline Expectations:**</strong> "This process typically takes 4-8 weeks from filing to final payment, depending on how busy the insurance company is. Here's the typical timeline: (1) File the claim—24-48 hours, (2) Adjuster schedules inspection—could be 5-14 days depending on their workload, (3) Adjuster inspects and issues estimate—1-2 weeks, (4) We schedule and complete work—1-2 weeks depending on weather and crew schedule, (5) We submit completion documentation—1-2 weeks for insurance to process. Some claims are faster, some slower. Don't panic if it takes a while."</p>

        <p><strong>Coverage Questions:**</strong> "Your insurance policy covers damage from covered events—usually hail, wind, and ice. It may NOT cover damage from poor maintenance, age-related wear, or events not covered by your policy (like earthquake or flood). We document what we see, the adjuster decides what's covered. Sometimes they cover things we think they won't—sometimes they don't cover things we think they will. That's the adjuster's job."</p>

        <p><strong>Setting Realistic Expectations:**</strong> "Here's what to expect: your insurance may not cover 100% of the cost. You may need to upgrade materials or pay for extras beyond what insurance covers. We'll talk through all that. But the main thing: we're here to help you through this process. We'll prepare all the documentation, meet with the adjuster, handle permits, do the work, and get final payment. You're not alone in this."</p>
      </div>`,
      checklist: [
        'Explain basic insurance claim process clearly',
        'Discuss their deductible (ask them to verify on their policy)',
        'Explain ACV vs. RCV and depreciation',
        'Walk through timeline: filing through final payment',
        'Address common concerns: Will it be covered? How long? What do I pay?',
        'Discuss policy coverage limits and potential exclusions',
        'Explain your role: guide, advocate, professional advisor',
        'Set expectations: some damage may not be covered, timeline may vary',
        'Provide written summary if possible (email or printed sheet)'
      ],
      proTips: [
        'Most homeowners appreciate honesty over false promises; set realistic expectations and you build trust',
        'If they have a policy they can share with you, review it together; this helps you understand their coverage',
        'The word "depreciation" confuses people; explain it as "insurance reduces the payout based on roof age"',
        `Timeline varies; don't promise a specific date, but give them a realistic range`
      ],
      commonMistakes: [
        'Overpromising coverage or outcomes; this creates liability for you',
        'Not explaining deductibles; they find out later and blame you',
        `Making it sound simple when it's complex; be honest about the process`,
        'Not discussing timeline; homeowners expect results in a week and get frustrated'
      ],
      nextNodes: ['ins_13_should_they_file'],
      prevNodes: ['ins_11_inspection_report'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '15-20 min',
      difficulty: 'beginner'
    },

    {
      id: 'ins_13_should_they_file',
      branch: 'insurance',
      phase: 'filing',
      phaseLabel: 'Filing the Claim',
      phaseNumber: 3,
      title: 'Should They File? The Decision Tree',
      subtitle: 'Helping homeowners decide if filing a claim makes financial sense',
      icon: '🤔',
      content: `<div class="rda-content">
        <p>Not every roof damage scenario warrants filing a claim. Sometimes the damage is minor and not worth the deductible. Sometimes the roof is so old that depreciation eats the payout. Your job is to help the homeowner think through the decision objectively.</p>

        <p><strong>The Math:</strong> Here's the framework. (1) Estimated damage cost: What will the repair actually cost? (2) Their deductible: What will they pay out of pocket? (3) Insurance payout (ACV): Estimated cost minus depreciation. (4) Net benefit: Insurance payout minus deductible. Is it worth it? Example: "Damage is approximately $8,000. Your deductible is $1,000. Insurance pays $7,000 ACV (minus depreciation on a 12-year-old roof). You pay $1,000. Net benefit to you: $6,000. That's worth filing." Another example: "Damage is approximately $2,500. Your deductible is $1,500. Insurance would pay maybe $1,000 ACV. You pay $1,500. Net benefit: negative. May not be worth filing."</p>

        <p><strong>Roof Age Consideration:**</strong> "A newer roof (under 5 years) will have minimal depreciation. Insurance might cover 80-90% of the cost. An older roof (15+ years) might only get 30-40% coverage due to age depreciation. This dramatically affects whether a claim is worth filing. If your roof is very old anyway, maybe the claim plus depreciation isn't attractive. But if your roof is relatively new, it's almost always worth filing."</p>

        <p><strong>Coverage Uncertainty:</strong> "Sometimes we can't predict exactly what insurance will cover until the adjuster inspects. That's okay. My job is to document damage thoroughly so the adjuster has everything they need to make a decision. Your insurance company sets coverage. I present the facts."</p>

        <p><strong>Other Damage Factors:**</strong> "If the damage extends beyond the roof—into ceilings, walls, insulation—it increases the claim value significantly. Interior damage often justifies filing even if roof damage alone is borderline."</p>

        <p><strong>Multiple Claims History:**</strong> "One thing to know: filing a claim becomes part of your claim history. Multiple claims might affect your premium or insurability in the future. This isn't something I decide—it's an insurance company decision. But it's worth considering. One claim from a major storm is normal. Multiple claims for different events might affect your rates. That's a conversation to have with your insurance agent."</p>

        <p><strong>The 'Wait and See' Approach:**</strong> "Some homeowners say, 'I'll wait and see if the roof leaks before filing a claim.' That's risky. Once damage happens and you notice it, you have a limited time window to file. If you wait 6 months and then file, the insurance company will investigate why you waited and might deny the claim. My recommendation: document damage now while it's fresh, file if it makes financial sense, and address it. Better to be proactive than reactive."</p>

        <p><strong>Your Role:**</strong> "I'm not an insurance agent. I can't tell you 'you should definitely file' or 'don't file.' What I can do is give you all the information: the damage, the estimated cost, what insurance typically covers for roof age, and let you decide. Call your insurance agent, discuss it, and let me know what you want to do. I'm here to support whatever decision you make."</p>
      </div>`,
      checklist: [
        'Calculate estimated repair cost from your inspection',
        'Ask homeowner to verify their deductible on policy',
        'Estimate insurance payout (ACV minus depreciation)',
        'Calculate net financial benefit to homeowner',
        'Assess roof age and depreciation impact',
        'Consider if interior damage increases claim value',
        'Discuss claim history and future rate implications',
        'Explain timeline and process implications',
        'Let homeowner decide; document their choice',
        'If they decide not to file, note this and close gracefully'
      ],
      proTips: [
        `Be honest: sometimes filing isn't worth the effort. If you tell them this, they'll trust you on claims that ARE worth filing`,
        `Newer roofs have less depreciation and are almost always worth claiming; older roofs often aren't`,
        'Interior damage significantly increases claim value; emphasize this if you found water stains or other issues',
        `Multiple claims history is a real concern for homeowners; mention it so they're aware`
      ],
      commonMistakes: [
        'Pushing people to file when it might not benefit them; this creates liability if they get a low payout',
        'Not calculating the actual financial impact; homeowners will feel misled if the payout is lower than expected',
        'Ignoring roof age and depreciation; this is critical to realistic expectations',
        'Not explaining the trade-offs; people need to understand the full picture'
      ],
      nextNodes: ['ins_14_filing_claim_together'],
      prevNodes: ['ins_12_educate_homeowner'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '10-15 min',
      difficulty: 'beginner'
    },

    {
      id: 'ins_14_filing_claim_together',
      branch: 'insurance',
      phase: 'filing',
      phaseLabel: 'Filing the Claim',
      phaseNumber: 3,
      title: 'Filing the Claim Together',
      subtitle: 'Guiding the homeowner through the claim filing process and securing the contract',
      icon: '📞',
      content: `<div class="rda-content">
        <p>After the inspection and education, the homeowner has decided to file. Now you guide them through calling their insurance company. You're not calling for them—they are the policyholder and must initiate the claim. But you're coaching them on what to say and making sure they get accurate information.</p>

        <p><strong>Before the Call:**</strong> Brief them: "Here's what to say when you call. Let them know you had hail/wind damage on [date], you've had a professional inspection, and you want to file a claim. Have your policy number ready. The insurance company will ask for details about the damage, your address, and whether anyone is hurt. Keep it simple. Tell them you'll email or mail your inspection report. Got all that?"</p>

        <p><strong>What to Say (Framework, Not Script):</strong> "Hi, I had hail storm damage to my roof on [date]. I've had it inspected by a professional contractor, and I want to file a claim. My address is [address], and my policy number is [number]. Can you walk me through the next steps?" This is clear, concise, and gets the process started.</p>

        <p><strong>What NOT to Say:**</strong> Coach them on this: "Don't say 'I want a new roof' or 'The damage is terrible and needs immediate attention.' Don't overstate the damage. Don't commit to a contractor before the adjuster inspects. Don't say you're getting multiple bids. Just state the facts: damage occurred, you want to file. Let the adjuster assess from there."</p>

        <p><strong>Important: The Date of Loss:**</strong> "Tell them the exact date the storm occurred. This is crucial. Your claim is filed based on that date. If you get the date wrong, it could affect coverage. So check the news or weather records to confirm the exact date, and tell them that date."</p>

        <p><strong>Assignment of Benefits (AOB) vs. Contingency:**</strong> "Some insurance companies will ask if you want to assign benefits to the contractor. This is a legal question, and it varies by state. My recommendation: don't sign anything the insurance company suggests without reading it carefully or having a lawyer review it. When the adjuster comes out, they'll explain the terms. You decide what you're comfortable with. I'll explain my role either way—I'm here to do the work and get paid, but the legal terms are between you and your insurance."</p>

        <p><strong>What Happens Next:**</strong> "After you file, insurance will schedule an adjuster inspection. You'll get a call or email with a date and time. Write it down. Call me after the inspection is scheduled so I can coordinate. For the adjuster inspection, have your inspection report ready. Have my contact info ready. The adjuster will want to talk to me on the roof about the damage and my assessment."</p>

        <p><strong>Getting a Claim Number:**</strong> "Insurance will give you a claim number. This is important. Write it down. You'll use this number for all future communication with insurance. I'll also note it in our file so I can reference it when I call insurance or submit supplements."</p>

        <p><strong>The Contingency Agreement / Contract:**</strong> "After you've filed and decided to move forward with us, I'll have you sign a work agreement. This documents that we'll be your contractor for this roof project. It explains our pricing, timeline, warranty, and other terms. Read it carefully and ask questions. This is a contract between you and us. Don't sign it if you don't understand something."</p>
      </div>`,
      checklist: [
        'Help homeowner locate insurance policy and policy number',
        'Confirm exact date of storm damage',
        'Coach on what to say when calling insurance',
        'Warn against overstatement or making commitments',
        'Explain AOB vs. contingency agreement concept',
        'Advise having inspection report ready for adjuster',
        'Make sure they note claim number after filing',
        'Coordinate scheduling of adjuster inspection',
        'Prepare contingency agreement/work contract',
        'Get work agreement signed before proceeding with estimates'
      ],
      proTips: [
        `Have them call insurance while you're present or nearby (but not on the phone); this ensures accuracy and you can answer questions`,
        `Write down the claim number for them; it's critical for all future communication`,
        'The inspection report you prepared is valuable for this call; the homeowner can reference it and give the insurance company specific information',
        'Some homeowners will be nervous about filing; reassure them: "Thousands of homeowners file claims every day. This is what insurance is for"'
      ],
      commonMistakes: [
        'Calling insurance yourself as the contractor; this puts you in a bad position legally',
        `Letting homeowners overstate damage or make commitments they can't keep`,
        'Not getting a claim number in writing; this causes confusion later',
        'Signing work agreements before the homeowner has filed; you need the insurance claim to proceed'
      ],
      nextNodes: ['ins_16_preparing_for_adjuster'],
      prevNodes: ['ins_13_should_they_file'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '15-20 min',
      difficulty: 'beginner'
    },

    // ============================================================================
    // PHASE 4: ADJUSTER MEETING (6 nodes)
    // ============================================================================

    {
      id: 'ins_16_preparing_for_adjuster',
      branch: 'insurance',
      phase: 'adjuster',
      phaseLabel: 'Adjuster Meeting',
      phaseNumber: 4,
      title: 'Preparing for the Adjuster',
      subtitle: 'Organizing documentation, knowing roof specs, and understanding expectations',
      icon: '📋',
      content: `<div class="rda-content">
        <p>The adjuster inspection is a critical moment. This is where insurance formally assesses the damage and decides what they'll cover. You want to be prepared and professional. A good adjuster meeting sets the tone for the entire claim.</p>

        <p><strong>Before the Adjuster Arrives:</strong> Pull together everything: your inspection report, all photos (organized by roof section), roof measurements, material specifications, any written notes you took. Have these ready to show. Organization matters. An adjuster can tell within 5 minutes if you're thorough or sloppy.</p>

        <p><strong>Roof Specifications:**</strong> Know your facts cold. "This roof is approximately 1,800 square feet, 7/12 pitch, 4 slopes. Material is architectural asphalt shingles, [brand] if identifiable, approximately 10 years old." You should be able to state these without fumbling. Adjusters use these specs to calculate scope and pricing.</p>

        <p><strong>Material Identification:</strong> Try to identify the shingle brand and style from what's visible or by asking the homeowner if they have documentation. "These are Owens Corning Duration shingles, likely in the Driftwood or Charcoal color." This helps the adjuster spec the replacement materials. If you can't identify it, say so: "Unable to identify shingle brand from current condition; recommend checking with existing installer or homeowner records."</p>

        <p><strong>Xactimate Familiarity:**</strong> Many adjusters use Xactimate software to generate estimates. You don't need to be an expert, but understand the basics. Xactimate breaks down roofs by measurement, material, and scope. Know what "square" means (100 sq ft of roofing). Know what "RSF" (roof square feet) means. If the adjuster mentions "Xactimate estimate," you understand what they're talking about.</p>

        <p><strong>Damage Documentation Protocol:**</strong> Have your photos organized in the same order you documented them. "South slope overview, then south slope sections 1-5 with close-ups. North slope overview, sections, etc." This makes it easy for the adjuster to follow along as you walk the roof. You're telling a story with your documentation.</p>

        <p><strong>Notes for the Homeowner:**</strong> Coach the homeowner: "The adjuster is going to be on the roof for 30-60 minutes. I'll be there showing them the damage. You don't need to be on the roof—that's my job. But have water and snacks available, be friendly if they come inside, and answer any questions they have. You're not arguing with them; you're cooperating."</p>

        <p><strong>Timing & Logistics:**</strong> Schedule the adjuster meeting for a day when the roof will be dry and the light will be good. Early morning or mid-afternoon is better than late afternoon when shadows obscure damage. Weather-dependent: don't schedule the day after a heavy rain.</p>
      </div>`,
      checklist: [
        'Organize all inspection documents and photos by roof section',
        'Know roof specifications: dimensions, pitch, material, age',
        'Prepare your inspection report for sharing with adjuster',
        'Identify shingle brand and style if possible',
        'Understand basic Xactimate terminology (square, RSF, etc.)',
        'Plan roof access and confirm ladder availability',
        'Schedule for clear, dry weather conditions',
        'Confirm adjuster appointment time with homeowner',
        'Brief homeowner on their role during inspection',
        'Charge your camera/phone and bring backup battery'
      ],
      proTips: [
        `Your inspection report is your credibility document; make sure it's thorough and professional`,
        `Photos organized by sequence beat photos in a random order; show you're systematic`,
        'Adjusters are evaluating both the damage AND you; be professional, punctual, and prepared',
        `If you're unsure about something, say so: "Let me check that measurement" is better than guessing`
      ],
      commonMistakes: [
        'Showing up unprepared; you look unprofessional',
        'Not having documentation organized; the adjuster wastes time sorting through your photos',
        'Not knowing basic specs; you lose credibility',
        `Scheduling in bad weather or poor lighting; damage won't show well`
      ],
      nextNodes: ['ins_17_meeting_adjuster_roof'],
      prevNodes: ['ins_14_filing_claim_together'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours prep',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_17_meeting_adjuster_roof',
      branch: 'insurance',
      phase: 'adjuster',
      phaseLabel: 'Adjuster Meeting',
      phaseNumber: 4,
      title: 'Meeting the Adjuster on the Roof',
      subtitle: 'Professional protocol, positioning as advocate (not combatant), and strategic communication',
      icon: '🤝',
      content: `<div class="rda-content">
        <p>This is your moment. How you interact with the adjuster will influence their perception of the damage and their estimate. You're not adversarial. You're a professional advocate. There's a difference.</p>

        <p><strong>The Tone:</strong> Be respectful, professional, and collaborative. "Hi, I'm [name]. I've inspected this roof thoroughly and documented the damage. I want to walk through what I found and show you what concerns me." This is professional. You're not confrontational. You're showing expertise and concern for the property.</p>

        <p><strong>The Role Distinction:</strong> You're not arguing with the adjuster. They're the authority on what their insurance company will cover. Your job is to show them the damage clearly and explain why you believe certain items need repair. Then they decide. "I believe the ridge cap is damaged here because of this hail impact and this cracking. It will need replacement. Does that match what you're seeing?"</p>

        <p><strong>Walking the Roof:**</strong> Lead them systematically through the damage just as you inspected it. Start at one point and walk the entire roof methodically. Point out major damage areas. Use your chalk marks if they're still visible. "See these chalk circles? These are the hail impacts I documented. This area has approximately 45 impacts in a 30-foot section." Let them see and photograph as you go.</p>

        <p><strong>Showing Without Telling:**</strong> This is crucial. Don't say "this shingle needs to be replaced." Instead: "Here's a hail impact. The shingle has a crack here and here. Water will get in at these points. What do you recommend for this area?" Let the adjuster do their job. When you tell them what to write, you put them in a defensive position. When you show them damage and ask their opinion, they're more likely to agree.</p>

        <p><strong>Taking Notes:**</strong> Bring a clipboard and take notes on what the adjuster includes and excludes. "South slope ridge cap—approved for replacement. South slope field shingles—partial damage, 200 sq ft approved." Later, you'll compare their estimate to your findings. If they missed something significant, that's where you submit a supplement.</p>

        <p><strong>Questions to Ask (Strategically):</strong> "Do you see this damage the same way I do?" "What's your recommendation for this area?" "Are you including the ridge cap in your estimate?" These are genuine questions that show you're engaged and seeking their expert opinion. They're not adversarial.</p>

        <p><strong>What to Avoid:</strong> Don't argue. Don't say "that's not what I found" if they disagree. Don't become emotional or defensive. If you disagree with their assessment, say: "I see it differently, but I understand your decision. Can you walk me through your reasoning?" This is respectful and shows professionalism. Disagreement doesn't mean confrontation.</p>
      </div>`,
      checklist: [
        'Introduce yourself professionally when adjuster arrives',
        'Walk the roof systematically, starting at one area',
        'Point out major damage clusters and patterns',
        'Reference your chalk marks if visible',
        'Ask questions that invite their analysis, not that assume conclusions',
        'Let them take their own photos and measurements',
        'Take notes on what they approve and exclude',
        `Show them damage but don't tell them what to write`,
        'Be respectful of their authority and expertise',
        'Avoid arguing or becoming defensive if they disagree'
      ],
      proTips: [
        `The best adjusters want to be thorough; if you show them damage clearly, they'll usually include it`,
        `Adjusters are trained to catch exaggeration; stick to facts and they'll trust you`,
        `If the adjuster is taking extensive notes, that's good—it means they're documenting thoroughly`,
        `Some adjusters will miss things; that's where supplements come in. Don't expect perfection on the first inspection`
      ],
      commonMistakes: [
        'Being aggressive or confrontational; this makes adjusters defensive',
        'Telling the adjuster what to include instead of showing damage and asking their opinion',
        `Not taking notes; you won't remember what they approved`,
        'Arguing about their assessment; this kills the relationship'
      ],
      nextNodes: ['ins_18_during_inspection'],
      prevNodes: ['ins_16_preparing_for_adjuster'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '30-60 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_18_during_inspection',
      branch: 'insurance',
      phase: 'adjuster',
      phaseLabel: 'Adjuster Meeting',
      phaseNumber: 4,
      title: 'During the Inspection',
      subtitle: 'Real-time engagement, counting test squares, noting exclusions, and staying alert',
      icon: '📸',
      content: `<div class="rda-content">
        <p>While the adjuster is on the roof, you're actively engaged. You're taking notes, you're watching what they're measuring and photographing, and you're staying alert for missed damage or disagreements.</p>

        <p><strong>Test Squares:**</strong> Adjusters often count "test squares"—a predetermined area (usually a 10x10 ft section or less) to count damage and extrapolate to the whole roof. You should be counting along with them. "I count 23 hail impacts in this test square" is an objective fact. If you count 23 and they count 15, that's a material difference. Note this and be ready to discuss. "I counted 23 impacts in this area. What number are you using for your estimate?"</p>

        <p><strong>Exclusions & Denials on the Spot:**</strong> Listen carefully. If the adjuster says something like "I'm not including the drip edge because it's pre-existing," note it. "So you're not approving drip edge replacement on the east slope. I have it listed as damaged in my report. Can you explain your reasoning?" They may have a valid reason, or they may have missed it. Either way, you know to address it in a supplement later.</p>

        <p><strong>Materials & Specs:**</strong> Watch what materials they're specifying. If you identified the shingles as brand X and they're using brand Y in their estimate, that's a difference. Different shingles have different costs and lifespans. Note it. "I documented these as Owens Corning shingles. Your estimate shows GAF. Is that correct?" They may adjust it.</p>

        <p><strong>Roof Measurements:**</strong> They're likely getting their own measurements with a laser or measuring wheel. Let them. If they're getting different dimensions than you, don't argue. They have tools. Your dimensions were estimates; theirs are more accurate. Their measured dimensions will be what the estimate is based on.</p>

        <p><strong>The Professional Photographer:**</strong> You're also documenting the adjuster inspection. Take photos of them on the roof, of test squares, of areas of disagreement. These photos are valuable if you need to appeal or submit a supplement. "Here's a photo of the test square we counted together—adjuster estimate did not include replacement of this area despite visible hail damage."</p>

        <p><strong>Keeping Notes Organized:**</strong> Your clipboard should have columns: Roof Section | Your Finding | Adjuster Approval | Items Excluded | Notes. As you walk the roof, fill this in. This creates a comparison document. Later, you'll use this to identify what was missed and what needs a supplement.</p>

        <p><strong>Tone During Differences:**</strong> If you disagree on damage assessment, stay calm and factual. "I'm seeing hail damage here on the east slope field shingles. You're not including it. Help me understand the reason." Genuinely listen to their explanation. Maybe they're right. Maybe they'll reconsider. Either way, you're documenting the discussion for later reference.</p>
      </div>`,
      checklist: [
        'Count test squares along with the adjuster',
        'Note exact number of hail impacts in test area',
        'Listen for exclusions and reasons for denial',
        'Verify material specifications in their assessment',
        'Note roof measurements and compare to yours',
        'Take photos of adjuster inspection process',
        'Document test square locations and counts',
        'Create a comparison sheet: what you found vs. what they approve',
        'Note any items they exclude and their stated reason',
        'Ask clarifying questions about material specs and measurements'
      ],
      proTips: [
        `Test square counts are objective facts; if numbers differ significantly, that's a data point for a supplement`,
        'Adjusters usually spend more time on the most damaged areas; less time on minor damage. Stay alert for what they might skip',
        'Photos of the adjuster inspection are valuable documentation, especially if you disagree on findings',
        'Be collaborative during the inspection; save disagreement for supplements and appeals'
      ],
      commonMistakes: [
        'Arguing about test square counts on the roof; you look defensive',
        `Not taking notes; you'll forget what was approved and excluded`,
        'Not taking photos; you have no evidence of the inspection later',
        'Pointing out things the adjuster missed without tact; they feel criticized'
      ],
      nextNodes: ['ins_19_adjuster_decision'],
      prevNodes: ['ins_17_meeting_adjuster_roof'],
      isFork: true,
      forkLabel: 'What was the adjuster\'s decision?',
      forkOptions: [
        { label: 'Full Approval', nodeId: 'ins_20_full_approval' },
        { label: 'Partial Approval', nodeId: 'ins_24_partial_approval' },
        { label: 'Denied', nodeId: 'ins_28_denied' },
        { label: 'Needs Re-inspection', nodeId: 'ins_17_meeting_adjuster_roof' }
      ],
      estimatedTime: '30-60 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_19_adjuster_decision',
      branch: 'insurance',
      phase: 'adjuster',
      phaseLabel: 'Adjuster Meeting',
      phaseNumber: 4,
      title: 'FORK: Adjuster\'s Decision',
      subtitle: 'Major decision point: Full Approval, Partial, Denied, or Re-inspection',
      icon: '⚖️',
      content: `<div class="rda-content">
        <p>After the roof inspection, the adjuster will issue an estimate. This is the critical moment. The adjuster's decision determines your path forward.</p>

        <p><strong>What to Expect:</strong> The adjuster will either (1) Fully approve your damage assessment and issue an estimate matching your scope, (2) Partially approve—some items approved, some excluded, (3) Deny the entire claim, or (4) Request a re-inspection with additional information.</p>

        <p><strong>Timeline for Estimate:**</strong> You might get the estimate within 24-48 hours, or it might take 1-2 weeks depending on the insurance company's workload. Ask the adjuster: "What's your timeline for issuing the estimate?" and "How will you send it to the homeowner?"</p>

        <p><strong>Your Next Steps Depend on the Outcome:</strong> Each path (Approval, Partial, Denied) has a different strategy and timeline. We'll walk through each one.</p>
      </div>`,
      checklist: [
        'Ask adjuster for timeline on estimate delivery',
        'Ask how estimate will be communicated (email, mail, phone)',
        'Get adjuster contact info for follow-up questions',
        'Plan to review estimate within 24 hours of receipt',
        'Prepare analysis comparing estimate to your findings',
        'Decide on strategy: accept, supplement, or appeal'
      ],
      proTips: [
        `Don't expect the estimate the same day; adjusters have multiple inspections and it takes time to process`,
        `Get the adjuster's phone number in case you need clarification on the estimate`,
        'The estimate will likely be lower than your findings; this is normal—supplements handle the gaps'
      ],
      commonMistakes: [
        'Expecting an estimate immediately after the inspection',
        `Not getting the adjuster's contact info; you may need to follow up`
      ],
      nextNodes: ['ins_20_full_approval', 'ins_24_partial_approval', 'ins_28_denied'],
      prevNodes: ['ins_18_during_inspection'],
      isFork: true,
      forkLabel: 'What was the adjuster\'s decision?',
      forkOptions: [
        { label: 'Full Approval', nodeId: 'ins_20_full_approval' },
        { label: 'Partial Approval', nodeId: 'ins_24_partial_approval' },
        { label: 'Denied', nodeId: 'ins_28_denied' }
      ],
      estimatedTime: '1-2 weeks',
      difficulty: 'intermediate'
    },

    // ============================================================================
    // PHASE 5A: APPROVED — MOVING FORWARD (4 nodes)
    // ============================================================================

    {
      id: 'ins_20_full_approval',
      branch: 'insurance',
      phase: 'approved',
      phaseLabel: 'Approved — Moving Forward',
      phaseNumber: 5,
      title: 'Full Approval: Reading the Insurance Scope',
      subtitle: 'Understanding line items, O&P, depreciation holdback, and code upgrades',
      icon: '✅',
      content: `<div class="rda-content">
        <p>Great news: the adjuster approved the claim. Now you need to carefully read the insurance estimate to understand what's covered and what's not. This is where many claims go wrong—contractors and homeowners misunderstand the scope and end up in disputes.</p>

        <p><strong>Estimate Breakdown:</strong> The insurance estimate will have line items. Typical lines: "Asphalt shingle tearoff: 1,800 sq ft @ $X per sq ft." "Drip edge installation: 350 LF @ $X per LF." "Roof replacement: 1,800 sq ft @ $X per sq ft." Each line has a quantity and a unit price. Make sure the quantities match the roof you inspected. "Is 1,800 sq ft correct? I measured approximately 1,850 sq ft. Where's the discrepancy?"</p>

        <p><strong>Material Specs:**</strong> Check the shingle specification. Does it match the replacement shingles the homeowner selected? Is it the same brand/quality as the old roof? Sometimes insurance specifies a lower-grade shingle than what was there. You may need to upsell to match or upgrade. "Insurance is specifying a standard 3-tab shingle. The old roof was architectural. I can upgrade the material at a cost difference, or use what insurance approved."</p>

        <p><strong>O&P (Overhead & Profit):**</strong> Insurance estimates include an "overhead and profit" percentage (usually 10-15%). This is meant to cover your business costs and profit margin. The line item might say "O&P on labor: $2,500." This is your operational cost. Make sure it's reasonable for the job size. If the overall estimate feels low on O&P, note it.</p>

        <p><strong>Depreciation Holdback:**</strong> The estimate will show "Initial Payment" (what they're paying now) and "Holdback" (what they'll pay after completion). Typical split: 80% initial, 20% holdback. If the estimate is $10,000, you get $8,000 now and $2,000 after. Confirm this breakdown with the homeowner so there's no surprise later.</p>

        <p><strong>What's Included/Excluded:**</strong> Carefully review what insurance included. Common items sometimes excluded: ice & water shield (upgrades), drip edge (sometimes), flashing upgrades, pipe jacks, attic ventilation, gutters (usually not covered). If these are excluded but needed, you'll submit a supplement or ask the homeowner to pay for them.</p>

        <p><strong>Code Upgrades:**</strong> Building codes change. If the old roof was 15 years old, code may now require updated materials or installation methods. Some insurance companies will cover code upgrades; some won't. "The estimate doesn't include ice & water shield on the entire roof, but current code requires it. We'll need to supplement this or you'll need to pay the difference." This is a conversation with the homeowner.</p>

        <p><strong>Contingency for Deck Damage:**</strong> The estimate may say "deck damage contingent upon inspection during tear-off." This means: once you tear off old shingles, if there's rotted decking or other damage, the homeowner will pay for repairs (or insurance may supplement if it's storm-related). Communicate this clearly: "If we find structural damage under the shingles, that could increase the cost. We'll document it and submit to insurance if it's storm-related."</p>
      </div>`,
      checklist: [
        'Review estimate line-by-line for accuracy of quantities',
        'Verify roof square footage matches your measurement',
        'Check shingle specification matches material selected',
        'Understand O&P calculation and reasonableness',
        'Identify initial payment vs. holdback amounts',
        'List items included and excluded from estimate',
        'Identify potential code upgrades not covered',
        'Note contingencies (like deck damage discovery)',
        'Create comparison: estimate vs. your inspection findings',
        'Prepare explanation for homeowner on excluded items'
      ],
      proTips: [
        'Insurance estimates are often conservative; most jobs end up needing supplements for items the adjuster missed',
        'Code upgrades are standard on re-roofs; budget these in your estimates to the homeowner',
        `The holdback percentage matters; if it's too high, the homeowner may not have cash to pay it and you won't get paid`,
        'Ice & water shield is a common missed item; many adjusters exclude it, forcing you to supplement'
      ],
      commonMistakes: [
        'Not reading the estimate carefully; you miss important details',
        `Not understanding the holdback; you think you're getting paid more than you are`,
        'Not communicating excluded items to homeowner; they find out later and blame you',
        'Assuming the estimate is complete; most claims need supplements'
      ],
      nextNodes: ['ins_21_supplement_strategy'],
      prevNodes: ['ins_19_adjuster_decision'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '30-45 min',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_21_supplement_strategy',
      branch: 'insurance',
      phase: 'approved',
      phaseLabel: 'Approved — Moving Forward',
      phaseNumber: 5,
      title: 'Supplement Strategy',
      subtitle: 'Identifying missed items and preparing documentation for supplement submission',
      icon: '📝',
      content: `<div class="rda-content">
        <p>Even on "approved" claims, insurance almost always misses items. Your job is to identify what's missing, document it professionally, and submit supplements to get additional coverage. This is a critical skill that separates average contractors from top performers.</p>

        <p><strong>Common Missed Items:</strong> Drip edge (often excluded), ice & water shield (frequently missed), starter strip, flashing upgrades (valleys, penetrations), pipe jacks, vent boot replacements, satellite dish reset, gutter damage or replacement, fascia/soffits (if damaged), ridge vent installation or upgrade, attic ventilation upgrades. These items are often code-required or necessary for a quality job, but adjusters overlook them.</p>

        <p><strong>The Supplement Workflow:</strong> (1) Identify items in your inspection report that weren't in the adjuster's estimate, (2) Document why each item is necessary (code requirement, damage, quality standard), (3) Get pricing for each item, (4) Create a supplement proposal, (5) Submit with supporting documentation, (6) Follow up until approved.</p>

        <p><strong>Building Your Case:**</strong> For each supplement item, explain: what it is, why it's necessary, what code or standard requires it, what the cost is. Example: "Ice & water shield (IWS): Installing IWS on all valleys and roof perimeter is required by current building code (per IRC Section R905). The original roof did not have IWS. Code-compliant replacement requires IWS installation. Cost: $0.25 per sq ft × 800 sq ft = $200." This is professional and defensible.</p>

        <p><strong>Photo Documentation:**</strong> Use photos from your inspection and adjuster meeting to support supplements. "See photo 23: South valley. Original roof shows no ice & water shield. Replacement must include IWS per code."</p>

        <p><strong>Pricing Strategy:**</strong> Price supplements using industry-standard materials and labor. Use Xactimate pricing if you have access, or quotes from your suppliers. Don't over-inflate—be reasonable. Insurance reviews supplements for reasonableness. "Drip edge replacement: 350 LF @ $1.50/LF (installed) = $525." This is straightforward and defensible.</p>

        <p><strong>The Submission Package:</strong> When you submit a supplement, include: (1) Cover letter explaining the scope additions, (2) Line-item breakdown with quantities and pricing, (3) Supporting documentation (code sections, manufacturer specs, photos), (4) Your professional estimate. Be organized and professional.</p>

        <p><strong>Timing:**</strong> Submit supplements after the adjuster estimate is issued but before you start the job. Some contractors submit during the job ("discovered damage") but this can cause problems. Better to anticipate supplements upfront. "Based on our damage assessment, I'm anticipating these code-required upgrades won't be in the initial estimate. Let me submit them now so we can get approval."</p>

        <p><strong>When Supplements Get Denied:**</strong> Sometimes insurance denies a supplement. They say "ice & water shield is not storm-related, it's a code upgrade, you have to absorb it." This is where you have a conversation with the homeowner: "Insurance didn't approve the IWS supplement. It costs $200. Do you want me to include it anyway for code compliance, or do you want to skip it?" Most homeowners will agree to code-required items once they understand.</p>
      </div>`,
      checklist: [
        'Compare inspection report to adjuster estimate line-by-line',
        `Identify items in your report that weren't approved`,
        `For each item, determine if it's code-required, damage-related, or quality standard`,
        'Document with photos from your inspection',
        'Get pricing for each supplement item',
        'Create supplement proposal with clear breakdown',
        'Include supporting documentation (code references, specs)',
        'Prepare cover letter explaining rationale',
        'Submit supplements within 7-14 days of adjuster estimate',
        'Follow up on submitted supplements'
      ],
      proTips: [
        'Code requirements are your strongest supplement argument; if something is code-required, insurance is more likely to approve',
        'Ice & water shield is almost always a supplement; expect to need this on every job',
        'Build relationships with adjusters who approve supplements readily; they make your job easier',
        'Document every supplement attempt; if insurance denies reasonable supplements, you have evidence for a complaint or appeal'
      ],
      commonMistakes: [
        'Not submitting supplements; you end up absorbing costs the insurance should cover',
        'Submitting poor-quality supplements with no supporting documentation; these get denied',
        'Being argumentative in supplement submission; stay professional and factual',
        'Waiting too long to submit supplements; by then the adjuster has moved on to other claims'
      ],
      nextNodes: ['ins_22_material_selection'],
      prevNodes: ['ins_20_full_approval'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_22_material_selection',
      branch: 'insurance',
      phase: 'approved',
      phaseLabel: 'Approved — Moving Forward',
      phaseNumber: 5,
      title: 'Material Selection & Ordering',
      subtitle: 'Working with homeowner on color/style and managing upgrade upsells',
      icon: '🏗️',
      content: `<div class="rda-content">
        <p>Once the claim is approved and supplemented, it's time to select materials. This is where you discuss options, upsells, and finalize what's going on the roof. You want the homeowner happy with their choice and you want to have materials ordered in advance.</p>

        <p><strong>Shingle Selection:</strong> Insurance approved a specific shingle (usually basic 3-tab or standard architectural). Now you discuss options. "Insurance approved standard asphalt shingles. If you want to stay with basic coverage, we can use what insurance specified. But I recommend upgrading to impact-resistant shingles. They're more durable, look better, and some insurers give premium discounts. Here are the options and costs." This is an upsell, but it's presented as value, not pressure.</p>

        <p><strong>Color & Style:**</strong> Have samples. Let the homeowner see shingle colors and styles in different light. "Let me bring samples to your house so you can see them in natural light. What color is closest to what you'd like?" Color matters—it affects curb appeal and resale value. Take time with this decision. Don't rush it.</p>

        <p><strong>Upgrade Options:**</strong> Beyond shingles, discuss: ice & water shield (higher coverage percentage), premium underlayment, ridge vent upgrades, hip and ridge starter strips (vs. cut shingles). These are legitimate upgrades that add value. "The base estimate includes standard underlayment. Upgrading to synthetic underlayment adds $400 but lasts significantly longer and is more water-resistant. Worth considering." Present options, let them decide.</p>

        <p><strong>Code Compliance:**</strong> Be clear: "Current building code requires ice & water shield on all valleys and 3 feet up from the eaves. Your insurance estimate doesn't include this. You can either pay the difference ($X), or we can include it in the supplement we're submitting to insurance." Give them options and let them choose.</p>

        <p><strong>Ordering & Lead Times:**</strong> Once materials are selected, order quickly. Shingles have lead times—sometimes 2-4 weeks depending on color and availability. Order early so materials are on site before the work starts. Talk to your supplier: "I need [X] bundles of [specific shingle] in [color], plus underlayment, drip edge, and flashing. What's your lead time?" Build lead time into your scheduling.</p>

        <p><strong>Material Holding & Inventory:**</strong> Some suppliers will hold material for a short time. Some charge storage fees. Know your supplier's policies. Don't order materials weeks in advance if you're not ready; they may not hold them. Coordinate material delivery with your work schedule: "Materials should arrive 2-3 days before we start work."</p>

        <p><strong>The Upgrade Conversation:**</strong> When discussing upgrades, present them as value propositions, not upsells. "The basic estimate covers a standard roof. For an additional $600, you can get impact-resistant shingles with a 30-year warranty and potential insurance discount. Many homeowners make this upgrade for peace of mind." Present it factually and let them decide. Don't pressure.</p>
      </div>`,
      checklist: [
        'Get insurance-approved material specification',
        'Prepare shingle samples in multiple colors',
        'Discuss basic vs. premium shingle options',
        'Present upgrade options (underlayment, ventilation, etc.)',
        'Explain code requirements vs. insurance coverage',
        'Get homeowner material selection in writing',
        'Confirm upgrade costs and get approval',
        'Order materials 2-3 weeks before scheduled work',
        'Confirm lead times with supplier',
        'Schedule material delivery for start of work'
      ],
      proTips: [
        'Impact-resistant shingles are a smart upsell; many homeowners opt for them once they understand the benefits',
        'Color selection in person beats color selection online; samples in natural light look different than on a computer',
        'Material lead times can kill schedules; order early and confirm delivery dates',
        'Premium materials often justify themselves with better warranty and durability; position as value, not expense'
      ],
      commonMistakes: [
        'Ordering materials too early; they may be damaged or misplaced before the job starts',
        'Not discussing upgrades; homeowners are often willing to pay for quality but you have to present it',
        'Ordering wrong material; verify color and specification before placing large orders',
        'Not getting homeowner approval on upgrades before ordering; you eat the cost if they say no'
      ],
      nextNodes: ['ins_23_schedule_install'],
      prevNodes: ['ins_21_supplement_strategy'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'beginner'
    },

    {
      id: 'ins_23_schedule_install',
      branch: 'insurance',
      phase: 'approved',
      phaseLabel: 'Approved — Moving Forward',
      phaseNumber: 5,
      title: 'Scheduling the Install',
      subtitle: 'Crew coordination, permits, material delivery, weather windows, and homeowner communication',
      icon: '📅',
      content: `<div class="rda-content">
        <p>Material is ordered. Insurance estimate is in place. Now you need to coordinate all the moving parts: crew availability, permit requirements, material delivery, weather, and homeowner expectations. This requires logistics planning.</p>

        <p><strong>Permit Requirements:</strong> Check with your local municipality. Some areas require permits for roof replacement; some don't. If required, pull the permit before scheduling the job. Permit timelines vary—could be 1-2 weeks or could be same-day. Find out the timeline and get it done. "Permit is required for this job. Estimated time: 5-7 days. I'll pull it this week, and we can schedule the work once it's approved."</p>

        <p><strong>Crew Coordination:**</strong> Do you have a crew available? For an insurance job, you likely need 3-4 roofers plus a crew lead. That's 2-3 days of work depending on roof size and complexity. Block the dates on your calendar. "I need a crew of 4 roofers available [date range]. Is that possible?" Confirm availability before committing to the homeowner.</p>

        <p><strong>Material Delivery Timing:**</strong> Coordinate with your supplier. "Can you deliver materials on [date]? I need everything on site before the crew starts the next morning." Material sitting on the roof for a week isn't ideal—it can get damaged or accessed by scavengers. Deliver 1-2 days before work starts.</p>

        <p><strong>Weather Windows:**</strong> Check the 10-day forecast. You need 2-3 consecutive dry days for a roofing job. Rain stops work, extends timeline, and creates safety issues. "I can schedule you for [date], but let me confirm the forecast. I want to make sure we have good weather."</p>

        <p><strong>Dumpster & Logistics:**</strong> You'll need a dumpster for the old roof tear-off and debris. Coordinate this: size, delivery date, pickup date. "I'll arrange a 20-yard dumpster to be delivered the morning of work. We'll load it as we go and have it picked up after cleanup."</p>

        <p><strong>Homeowner Notification:**</strong> Schedule a pre-work meeting with the homeowner. "Here's when we're starting: [date]. The work will take approximately 2-3 days. Here's what to expect: noise, activity, potentially some small debris in the yard despite cleanup efforts. Here's my cell phone if anything comes up. We'll do our best to work efficiently and keep disruption minimal." Set expectations clearly.</p>

        <p><strong>Neighbors & HOAs:**</strong> If there's an HOA or close neighbors, consider a courtesy notice. "We'll be doing roofing work on [date] at [address]. Work will run from 8 AM to 4 PM approximately. Apologies for any inconvenience." This prevents complaints to the HOA or police.</p>

        <p><strong>Confirming Everything:**</strong> A week before the job, confirm: (1) Crew availability, (2) Material delivery, (3) Permit (if needed), (4) Dumpster order, (5) Weather forecast, (6) Homeowner confirmation. "Everything is confirmed for your roof replacement on [date]. Crew arrives at 7 AM. Materials are delivering the day before. Should be done in 2-3 days weather permitting. Any questions?"</p>
      </div>`,
      checklist: [
        'Verify permit requirements with local municipality',
        'Apply for permit if required',
        'Confirm crew availability for scheduled dates',
        'Coordinate material delivery for 1-2 days before work',
        'Order dumpster for old roof debris',
        'Check 10-day weather forecast',
        'Schedule pre-work meeting with homeowner',
        'Provide homeowner with start date and timeline',
        'Give homeowner your contact info for issues',
        'Confirm everything (crew, materials, permits) one week before'
      ],
      proTips: [
        'Never schedule a roof without confirming crew first; double bookings are disasters',
        'Material delivery timing is critical; arrive too early and it sits, too late and you delay the crew',
        'Weather is unpredictable; always have a backup date in mind',
        'Homeowner communication reduces complaints; set expectations clearly'
      ],
      commonMistakes: [
        `Scheduling without confirming crew; you commit to homeowner but can't fulfill`,
        'Not checking permit requirements; you start work and get shut down',
        'Ordering dumpster wrong size; it fills up or is too small',
        `Not checking weather; you schedule in the middle of a rain forecast and waste the crew's time`
      ],
      nextNodes: ['ins_32_pre_production_checklist'],
      prevNodes: ['ins_22_material_selection'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-3 hours',
      difficulty: 'intermediate'
    },

    // ============================================================================
    // PHASE 5B: PARTIAL APPROVAL — SUPPLEMENT PROCESS (4 nodes)
    // ============================================================================

    {
      id: 'ins_24_partial_approval',
      branch: 'insurance',
      phase: 'supplement',
      phaseLabel: 'Partial Approval — Supplement Process',
      phaseNumber: 5,
      title: 'Analyzing the Adjuster\'s Scope',
      subtitle: 'Line-by-line comparison of what they approved vs. what\'s needed',
      icon: '🔍',
      content: `<div class="rda-content">
        <p>The adjuster approved some items but not others. This is actually the most common outcome. The approval isn't full—it's partial. Your job is to understand exactly what they approved and what's missing, then build a strategy to get the missing items approved or manage the homeowner's expectations.</p>

        <p><strong>The Comparison Sheet:</strong> Create a side-by-side comparison: Your Inspection Finding | Adjuster's Estimate | Approved? | Notes. For example: "South slope ridge cap damage (12 linear feet)" | "Ridge cap replacement: 12 LF" | "Yes, approved" | "Included in estimate." Another example: "Ice & water shield on valleys (80 sq ft)" | "Not included" | "No" | "Need to supplement or homeowner pays."</p>

        <p><strong>Understanding Exclusions:**</strong> Ask the adjuster or review the estimate for the reason items were excluded. Common reasons: "Pre-existing condition," "Not storm damage," "Maintenance item," "Code upgrade (not storm-related)," "Outside damage area." If you disagree with their reasoning, note it. You'll address it in a supplement.</p>

        <p><strong>Damage vs. Code Upgrades:**</strong> Distinguishing this is critical. If hail damaged the ridge cap, insurance covers replacement—this is storm damage. If the existing roof had no ice & water shield (because it wasn't required when built) and now code requires it, insurance may not cover it—this is a code upgrade. However, if hail damage to a valley was the reason water is entering, and ice & water shield would prevent this, you might argue it's storm-related repair. This is nuanced.</p>

        <p><strong>Common Partial Approvals:**</strong> "South slope approved for full replacement (1,200 sq ft). North slope approved for partial replacement (300 sq ft). Ridge cap approved (80 LF). Ice & water shield: not approved (homeowner responsibility). Drip edge: approved (350 LF). Flashing: approved (replaced as needed). O&P: 12% of labor cost." Adjuster approved the primary repair but excluded upgrades and some materials.</p>

        <p><strong>The Coverage Gap:**</strong> Between what they approved and what you need for a complete, code-compliant job, there's a gap. This is where supplements come in. The gap might be 10-20% of the total project cost. You need to close this gap through supplements, homeowner payment, or combination.</p>

        <p><strong>Strategic Questions for the Adjuster:**</strong> Before you give up on excluded items, call the adjuster. "I see you didn't include ice & water shield. Can you explain the reasoning? If we can show it's damage-related rather than just code upgrade, would you reconsider?" Sometimes you can negotiate without a formal supplement. Other times the answer is no, and you move to supplement.</p>
      </div>`,
      checklist: [
        'Create detailed comparison: your findings vs. adjuster estimate',
        'List all items excluded and understand why',
        'Distinguish between storm damage and code upgrades',
        'Identify items worth supplementing vs. items homeowner should pay for',
        'Call adjuster to question exclusions (tactfully)',
        `Note adjuster's reasoning for future supplement preparation`,
        'Calculate total gap between estimate and complete repair',
        'Prepare homeowner for likely out-of-pocket costs',
        'Plan supplement strategy for most important items'
      ],
      proTips: [
        'Adjusters sometimes exclude items by mistake, not policy; a friendly call may fix it without a formal supplement',
        'Ice & water shield and code upgrades are almost always partial exclusions; expect to supplement these',
        'Some homeowners will pay for excluded items if you frame them as necessary for code compliance or longevity',
        `Document every exclusion; if you supplement later, you have the adjuster's original reasoning on file`
      ],
      commonMistakes: [
        'Not understanding the exclusion reason; you submit a weak supplement that gets denied',
        'Assuming all excluded items are unapprovable; some can be negotiated',
        `Not explaining exclusions to homeowner; they think you're trying to upsell them`,
        `Not planning for the gap; you start work and realize you don't have approval or payment for critical items`
      ],
      nextNodes: ['ins_25_writing_supplement'],
      prevNodes: ['ins_19_adjuster_decision'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_25_writing_supplement',
      branch: 'insurance',
      phase: 'supplement',
      phaseLabel: 'Partial Approval — Supplement Process',
      phaseNumber: 5,
      title: 'Writing the Supplement',
      subtitle: 'Format, documentation, pricing, and professional presentation',
      icon: '📋',
      content: `<div class="rda-content">
        <p>A supplement is a formal request for additional coverage beyond the initial adjuster estimate. It needs to be professional, well-documented, and compelling. A poorly written supplement gets denied quickly. A well-written one has a much better chance.</p>

        <p><strong>Supplement Structure:</strong> (1) Cover letter explaining the scope additions, (2) Itemized breakdown with quantities and pricing, (3) Supporting documentation (photos, code references, manufacturer specs, original inspection report), (4) Professional layout.</p>

        <p><strong>The Cover Letter:</strong> "Based on our comprehensive roof inspection and comparison with the adjuster's estimate, we have identified the following items necessary for a complete, code-compliant repair. These items were not included in the initial estimate and require supplemental coverage." Then list the items and brief explanation for each. Professional, factual, not emotional.</p>

        <p><strong>Itemization & Pricing:</strong> For each item, show: Description | Quantity | Unit | Unit Price | Total. Example: "Ice and water shield, 36-inch width, asphalt | 800 | sq ft | $0.25 | $200." Use realistic, industry-standard pricing. If you're using Xactimate pricing, reference it: "Pricing based on Xactimate standard rates for [region]."</p>

        <p><strong>Supporting Documentation:**</strong> For each item, include why it's necessary. For code items: "Per IRC Section R905.2.8.1, ice and water shield installation required in all valleys and 3 feet up from roof eave." For damage items: "Photo 23 from original inspection shows valley damage requiring ice and water shield replacement for water-tightness." For safety items: "OSHA compliance requires appropriate fall protection anchoring on roof edge—ridge vent modification supports safety equipment installation."</p>

        <p><strong>Photo References:**</strong> Use photos from your original inspection to show damage justifying the supplement. "See original inspection photo 12: South ridge cap—cracking and separation visible. Replacement of ridge cap extends the supplemental scope to include new ridge vent installation (standard practice in re-roofing)."</p>

        <p><strong>Manufacturer Specifications:</strong> If upgrading materials, include specs showing why the upgrade is necessary. "Impact-resistant shingles recommended per [manufacturer] standards for hail-prone regions. Original roof used standard asphalt; upgrade provides superior performance and 30-year warranty vs. 20-year on standard material."</p>

        <p><strong>Presentation & Professionalism:**</strong> Use a template if you have one. Include your company letterhead. Number pages. Proofread meticulously. Poor spelling and grammar undermines your credibility. This is a formal document going to an insurance company.</p>

        <p><strong>Justification Tone:**</strong> You're not arguing—you're explaining and justifying. "We discovered the original roof lacked ice and water shield in the valleys. Current code requires this for water tightness. Supplemental coverage is requested to address this code compliance issue." This is professional and factual.</p>
      </div>`,
      checklist: [
        'Create professional supplement document',
        'Write clear, factual cover letter',
        'Itemize each supplemental item with quantity and pricing',
        'Use realistic, industry-standard pricing',
        'Include code section references for code-required items',
        'Attach supporting photos from original inspection',
        'Include manufacturer or industry standards documentation',
        'Reference original adjuster estimate for context',
        'Proofread for grammar and spelling',
        'Package professionally for submission'
      ],
      proTips: [
        'Code references are your strongest argument; if something is code-required, insurance is more likely to approve',
        `Pricing consistency matters; if you bid $0.25 per sq ft for IWS in the supplement, make sure it's consistent with what you quoted the homeowner`,
        'Photos are powerful; a photo showing the specific damage or code issue is more persuasive than written description',
        'Organize supplements by roof area or by category; make it easy for the adjuster to understand and approve'
      ],
      commonMistakes: [
        'Writing an emotional or argumentative tone; this alienates the adjuster',
        'Inflated pricing; adjusters have tools to check reasonableness',
        `Vague justification; "this is necessary" isn't as strong as "code requires this per IRC Section X"`,
        'Poor presentation; sloppy supplements suggest sloppy work'
      ],
      nextNodes: ['ins_26_submitting_supplement'],
      prevNodes: ['ins_24_partial_approval'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_26_submitting_supplement',
      branch: 'insurance',
      phase: 'supplement',
      phaseLabel: 'Partial Approval — Supplement Process',
      phaseNumber: 5,
      title: 'Submitting & Following Up on Supplements',
      subtitle: 'Routing, expected response times, escalation paths, and persistent follow-up',
      icon: '📬',
      content: `<div class="rda-content">
        <p>Writing the supplement is one thing; getting it approved is another. Submission and follow-up are critical. Many supplements sit in queue and never get reviewed unless you actively manage them.</p>

        <p><strong>Who to Send It To:</strong> The adjuster who inspected the property is the first choice. If you have their email, send it directly to them with a note: "I've attached a supplement request based on our inspection and comparison with your estimate. Please let me know if you need any additional information." If you don't have the adjuster's direct contact, send it through the insurance company's online claim portal or to the claims office with the claim number and property address.</p>

        <p><strong>Expected Response Time:</strong> Most insurance companies have SLAs (service level agreements) for supplements. Typical timeline: 5-10 business days. Some companies are faster; some slower. Ask when you submit: "What's the typical timeline for supplement review?" This sets expectations.</p>

        <p><strong>Follow-Up Protocol:**</strong> If you haven't heard anything in 7 days, send a courtesy follow-up email: "I submitted a supplement request on [date] for [address] regarding ice and water shield and drip edge replacement. Claim number: [number]. Could you give me an update on status?" This is professional and keeps the supplement top-of-mind.</p>

        <p><strong>Escalation Paths:</strong> If the supplement is denied or stalls, you have options: (1) Ask the adjuster for specific reason for denial and submit a rebuttal supplement addressing their concerns, (2) Request supervisor review, (3) File a complaint with the state insurance commissioner (nuclear option, but it exists), (4) Hire a public adjuster (if the claim is large enough to justify cost).</p>

        <p><strong>Rebuttal Supplements:**</strong> Sometimes the adjuster rejects a supplement with a reason like "ice and water shield is code upgrade, not storm damage." You can respond: "We respectfully disagree. The original roof lacked IWS in the valley where the adjuster documented hail damage (Photo 23). The hail damage to the valley creates a water intrusion path. Proper repair requires IWS per manufacturer installation standards for damage prevention. We're requesting reconsideration." This is a professional rebuttal, not an argument.</p>

        <p><strong>Multiple Supplements:**</strong> Some jobs require multiple supplement rounds. First round gets ice & water shield approved. Second round (discovered during tear-off) gets decking damage approved. This is normal. Build it into your timeline and budget.</p>

        <p><strong>Homeowner Communication During Process:**</strong> Keep the homeowner informed. "I submitted a supplement request for materials not included in the initial estimate. We're waiting for insurance to review—should hear back in 7-10 days. I'll update you as soon as I hear something." Transparency prevents frustration and keeps them engaged.</p>
      </div>`,
      checklist: [
        'Identify correct contact (adjuster or claims office) for submission',
        'Submit supplement via email or online portal',
        'Include claim number and property address clearly',
        'Ask about expected response timeline',
        'Document submission date for follow-up tracking',
        'Follow up after 7 days if no response',
        'Monitor for approval, denial, or request for more information',
        'Prepare rebuttal if supplement is denied',
        'Keep homeowner informed of supplement status',
        'Plan for multiple supplements if needed'
      ],
      proTips: [
        'Direct email to the adjuster is best; they have personal investment in the claim',
        'Supplements sometimes get lost in queue; following up brings attention',
        'Approval rate depends on strength of documentation; well-documented supplements have higher approval rates',
        'Some adjusters will negotiate; a friendly call can sometimes resolve disputes faster than formal supplements'
      ],
      commonMistakes: [
        'Submitting and forgetting; no follow-up means supplements sit in queue',
        'Submitting poor supplements and expecting approval; documentation quality matters',
        `Getting angry or emotional in follow-ups; this hardens the adjuster's position`,
        `Not keeping homeowner informed; they wonder what's happening`
      ],
      nextNodes: ['ins_27_negotiation_tactics'],
      prevNodes: ['ins_25_writing_supplement'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-3 hours (over multiple days)',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_27_negotiation_tactics',
      branch: 'insurance',
      phase: 'supplement',
      phaseLabel: 'Partial Approval — Supplement Process',
      phaseNumber: 5,
      title: 'Negotiation Tactics',
      subtitle: 'When to push, when to compromise, leveraging code requirements, and appraisal clause',
      icon: '🤝',
      content: `<div class="rda-content">
        <p>Sometimes supplements get rejected. Sometimes the adjuster and you disagree on scope. This is where negotiation skills matter. You need to know when to push, when to compromise, and when to pull out the heavy tools.</p>

        <p><strong>The Direct Conversation:**</strong> Don't rely entirely on written supplements. Call the adjuster. "Hi, I sent a supplement for ice and water shield. You denied it as code upgrade, not storm damage. I want to understand your reasoning and see if we can find common ground." Have a conversation. Many disagreements resolve in a single call.</p>

        <p><strong>Leverage Code Requirements:**</strong> If something is code-required, you have leverage. "I need to tell you upfront: I can't install a roof that violates building code. Code requires ice and water shield in all valleys. If insurance doesn't cover it, my options are: (1) homeowner pays the cost, or (2) I include it in my price. But we need to resolve this before I start work." This is professional and factual. You're not threatening—you're explaining constraints.</p>

        <p><strong>The Compromise Play:**</strong> Sometimes you split the difference. "Insurance won't approve full ice and water shield coverage. I'll cover the valleys (most critical areas) and homeowner covers the perimeter strip. This is a compromise that satisfies code while reducing insurance's exposure." This solves the problem and keeps things moving.</p>

        <p><strong>The Appraisal Clause:**</strong> Many insurance policies include an appraisal clause: if the contractor and adjuster disagree on scope/cost, either party can invoke appraisal. An independent appraiser reviews both positions and makes a binding decision. This is a last resort, but it's powerful. "If we can't agree on scope through supplements, I can invoke the appraisal clause per your policy. An appraiser will review and make a binding decision. I'm confident in our documentation, but let's try to resolve this ourselves first." Sometimes just mentioning appraisal causes the adjuster to reconsider.</p>

        <p><strong>When to Walk Away:**</strong> Not every item is worth fighting for. If ice and water shield gets denied and the homeowner doesn't want to pay, and the gap isn't code-required for that area, maybe you include it in your margin and move on. "I wanted ice & water shield on the entire roof, but insurance will only cover the valleys. That's what we'll do. It's not ideal, but it's workable."</p>

        <p><strong>Documentation of Disagreement:**</strong> Keep written record of disagreements. "Adjuster stated in phone call [date] that ice and water shield is code upgrade, not storm damage. Contractor respectfully disagrees based on manufacturer standards and code interpretation. This difference noted for potential appraisal if needed." Having documentation protects you if the dispute escalates.</p>

        <p><strong>Know Your Limits:**</strong> Some claims are just damaged beyond what insurance will cover. Some homeowners don't want to pay for upgrades. At some point, you negotiate to a deal both sides can live with. "Here's what I can do within the insurance approval and homeowner's budget. It's not perfect, but it's a solid repair. Is this acceptable?" Get agreement and move forward.</p>
      </div>`,
      checklist: [
        'Have direct phone conversation with adjuster before escalating',
        'Explain code requirements and your constraints',
        'Identify areas for compromise',
        'Explore split-cost solutions',
        'Document adjuster responses and positions',
        'Understand appraisal clause in the policy',
        'Prepare appraisal argument if needed',
        'Know when to concede and move forward',
        'Get final scope agreement from homeowner and adjuster',
        'Document final agreement before starting work'
      ],
      proTips: [
        'Adjusters often respond better to direct conversation than formal letters; pick up the phone',
        'Code requirements are your strongest argument; use them',
        `Compromise preserves relationships; you'll work with this adjuster again`,
        'Appraisal clause is powerful but expensive; use as last resort'
      ],
      commonMistakes: [
        `Being too aggressive; this hardens the adjuster's position`,
        `Not understanding your own constraints; you commit to things you can't do`,
        `Trying to fight every exclusion; some battles aren't worth it`,
        'Not documenting agreements; disputes arise about what was decided'
      ],
      nextNodes: ['ins_32_pre_production_checklist'],
      prevNodes: ['ins_26_submitting_supplement'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-4 hours (over multiple contacts)',
      difficulty: 'advanced'
    },

    // ============================================================================
    // PHASE 5C: DENIED — APPEAL PROCESS (4 nodes)
    // ============================================================================

    {
      id: 'ins_28_denied',
      branch: 'insurance',
      phase: 'appeal',
      phaseLabel: 'Denied — Appeal Process',
      phaseNumber: 5,
      title: 'Understanding the Denial',
      subtitle: 'Common denial reasons, getting denial in writing, and assessing appeal viability',
      icon: '❌',
      content: `<div class="rda-content">
        <p>The worst-case scenario: insurance denies the claim. This can happen for various reasons, and your response depends on understanding why they denied it and whether the denial is legitimate or defensible.</p>

        <p><strong>Common Denial Reasons:</strong> (1) Pre-existing damage—adjuster found damage that predates the storm, (2) Maintenance neglect—roof was in poor condition before the storm, (3) Policy exclusion—event isn't covered by the policy (earthquake, flood, intentional damage), (4) Insufficient damage—adjuster found damage but decided it doesn't meet deductible threshold, (5) Excluded peril—damage isn't covered under their specific policy language, (6) Fraud concern—insurance suspects misrepresentation on the claim.</p>

        <p><strong>Getting it in Writing:**</strong> Never accept a verbal denial. "The adjuster said they're denying the claim." That's not official. Ask for a written denial letter. "Can you please send me a formal denial letter explaining the reasons?" A written denial gives you specifics to address and appeal against. Without it, you can't build a rebuttal.</p>

        <p><strong>Denial Letter Analysis:**</strong> Read the denial carefully. Identify the specific reason. "The adjuster's investigation determined that damage to the south slope is consistent with weathering and age, not storm damage. Claim is denied based on pre-existing condition exclusion." That's the reason. Now you know what to argue.</p>

        <p><strong>Legitimacy Check:**</strong> Ask yourself: is this denial legitimate or defensible? If the roof was genuinely in terrible condition before the storm, maybe the denial has merit. If the adjuster misidentified damage or ignored evidence of the storm, the denial is probably defensible and worth fighting. Be honest with yourself. Not every denial is wrong.</p>

        <p><strong>Communicating to the Homeowner:**</strong> This is tough. "I have some difficult news. Insurance denied the claim. Here's the reason they gave: [reason]. This is disappointing, and I believe we can appeal this decision. Here's what I recommend..." Be honest about the situation while remaining hopeful about options. Don't hide bad news.</p>

        <p><strong>Is It Worth Fighting?:**</strong> This depends on claim size and likelihood of success. A $3,000 claim with a weak appeal probably isn't worth the time and legal cost. A $15,000 claim with a strong appeal probably is. You need to assess: (1) How strong is our position? (2) How likely is the appeal to succeed? (3) What's the cost of appealing (your time, potential legal fees)? (4) Is the benefit worth the cost?</p>

        <p><strong>Denial Reason Categories:</strong> Some denials are easier to appeal than others. "Pre-existing damage" you might argue against with photos showing fresh damage. "Policy exclusion" is harder—if the policy doesn't cover it, you need to prove it's covered or you're stuck. "Fraud concern" is nuclear—if insurance suspects dishonesty, the appeal becomes adversarial and potentially legal.</p>
      </div>`,
      checklist: [
        'Request written denial letter from insurance',
        'Read denial carefully and identify specific reason',
        'Document denial reason and any supporting detail from adjuster',
        'Review original inspection findings against denial reason',
        'Assess legitimacy: is the denial justified or defensible?',
        'Evaluate cost-benefit of appealing',
        'Gather additional documentation supporting your position',
        'Consider independent engineer report or public adjuster',
        'Communicate openly with homeowner about options',
        'Make decision: appeal, accept, or refer to attorney'
      ],
      proTips: [
        'Written denial is your starting point; use it to build specific rebuttal',
        'Some denials are legitimate; not every denial is wrong. Be objective',
        'Pre-existing damage denials are hardest to overcome; you need evidence of freshness',
        'Policy exclusion denials are often final; unless you can prove the damage is covered, appealing is futile'
      ],
      commonMistakes: [
        'Accepting verbal denial without written explanation; you have no specifics to address',
        'Appealing everything on principle without assessing viability; some denials are correct',
        'Not analyzing the denial reason carefully; your rebuttal misses the key point',
        `Not communicating honestly with homeowner; they find out later you didn't pursue options`
      ],
      nextNodes: ['ins_29_building_appeal'],
      prevNodes: ['ins_19_adjuster_decision'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_29_building_appeal',
      branch: 'insurance',
      phase: 'appeal',
      phaseLabel: 'Denied — Appeal Process',
      phaseNumber: 5,
      title: 'Building Your Appeal',
      subtitle: 'Independent inspection, engineering reports, additional documentation, and re-inspection requests',
      icon: '📑',
      content: `<div class="rda-content">
        <p>A denial doesn't have to be final. You can appeal—but the appeal needs to be strong. You need additional evidence or expert opinion to counter the denial reason.</p>

        <p><strong>Independent Inspection:**</strong> Get a second opinion from another contractor or engineer. Have them inspect and document their findings independently (don't tell them what you found first). "This roof shows fresh hail damage consistent with [date] storm. Evidence: impact bruising on shingles is not oxidized, indicating recent damage. Damage pattern is consistent with hail impact, not age-related wear." An independent professional opinion carries weight with insurance.</p>

        <p><strong>Engineering Report:**</strong> For higher-value claims or complex denials, consider hiring a structural engineer or professional engineer specializing in roofing. They inspect and provide an expert report. "Engineer Certification: I have inspected the roof at [address] and determined that damage is consistent with hail impact from [date] storm. Damage characteristics rule out pre-existing wear or maintenance issues." This is professional-grade documentation that insurance takes seriously.</p>

        <p><strong>Historical Data:**</strong> If the adjuster said "no hail in this area on that date," you can counter with weather records. "National Weather Service records show hail up to 1 inch in the [zip code] area on [date]. This documentation supports the homeowner's claim of hail damage." Use objective data.</p>

        <p><strong>Photographic Comparison:**</strong> If you have "before" photos (from your inspection) showing fresh damage and the adjuster's photos showing wear, create a comparison document. Side-by-side photos showing your finding (fresh, bright impact marks) versus the adjuster's claim (oxidation, age) tell a powerful story. "Photo 12 (our inspection): bright, fresh hail impact. Adjuster claims this is pre-existing wear. Fresh damage does not show oxidation present in other areas of roof."</p>

        <p><strong>Material Specification Analysis:</strong> If the denial was based on roof age/depreciation, provide documentation of actual roof age. "Homeowner provided roofing receipt from [date] showing installation was [X] years ago, not [Y] years as adjuster estimated. This affects depreciation calculation."</p>

        <p><strong>Requesting Re-inspection:**</strong> You can formally request a re-inspection with a different adjuster. "Based on our disagreement with the initial assessment, we request a re-inspection by a different adjuster per the homeowner's policy rights. We believe additional expert review will identify damage initially missed." Some insurance companies will do this. It costs them, so they're not eager, but it's an option.</p>

        <p><strong>The Appeal Submission:**</strong> Prepare a formal appeal letter: "We respectfully appeal the denial dated [date]. The initial assessment concluded [denial reason]. We have obtained additional independent inspection, documentation, and expert analysis that contradicts this conclusion. Details attached." Then attach your evidence: independent report, photos, engineering analysis, etc.</p>
      </div>`,
      checklist: [
        'Obtain independent inspection from another contractor/engineer',
        'Get written report from independent inspector',
        'Consider engineering report for significant claims',
        'Gather supporting documentation: weather records, installation dates, etc.',
        'Create photo comparison showing fresh vs. old damage',
        'Document material specifications and roof age',
        'Request re-inspection with different adjuster if applicable',
        'Prepare formal written appeal with all supporting documents',
        'Submit appeal through proper channels (claims office, online portal)',
        'Keep copies of everything for your records'
      ],
      proTips: [
        'Independent professional opinions carry weight; adjuster vs. adjuster is a wash, but contractor + engineer + photos is compelling',
        'Weather data is objective and powerful; if it shows the hail/storm occurred, use it',
        'Photo comparison tells a story better than written argument; organize before/after photos clearly',
        `Engineering reports cost money, but they're worth it for large claims (over $10,000)`
      ],
      commonMistakes: [
        `Getting a second opinion from your buddy who also does roofing; insurance knows it's biased. Get a truly independent expert`,
        'Not having photos to support your position; photos are critical evidence',
        'Submitting weak appeals with generic arguments; insurance expects data and specifics',
        'Giving up after first appeal; sometimes you need two appeals or escalation'
      ],
      nextNodes: ['ins_30_escalation_options'],
      prevNodes: ['ins_28_denied'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '3-5 hours',
      difficulty: 'advanced'
    },

    {
      id: 'ins_30_escalation_options',
      branch: 'insurance',
      phase: 'appeal',
      phaseLabel: 'Denied — Appeal Process',
      phaseNumber: 5,
      title: 'Escalation Options',
      subtitle: 'Supervisor complaints, state insurance commissioner, public adjusters, appraisal, attorneys',
      icon: '📞',
      content: `<div class="rda-content">
        <p>If appeals to the adjuster fail, you have escalation options. Each is more aggressive and more costly, but each brings more leverage.</p>

        <p><strong>Supervisor Review:</strong> Request a supervisor/management review of the denial. "We've submitted appeals with additional documentation. We request a supervisor review of this decision given the conflicting evidence." A supervisor may override the adjuster if the appeal is strong. This costs the insurance company little, so it's worth requesting.</p>

        <p><strong>State Insurance Commissioner Complaint:</strong> Every state has an insurance commissioner. You can file a formal complaint alleging the insurance company made an unfair or wrongful denial. "Insurance Company X wrongfully denied claim [number] despite clear evidence of storm damage. Request commissioner investigation." This creates regulatory pressure on the insurance company. They hate regulatory complaints. Sometimes a complaint prompt quick resolution.</p>

        <p><strong>Public Adjuster:**</strong> A public adjuster is a third-party licensed professional who negotiates with insurance on your behalf. They're paid as a percentage of recovered claim value (typically 5-10%). If you have a $20,000 denied claim and a public adjuster recovers $15,000, they take $1,500. Worth it if they succeed, expensive if they don't. Use for significant claims only.</p>

        <p><strong>Appraisal Clause (Policy Right):</strong> Many policies include appraisal clauses: if policyholder and insurance disagree on damage/value, either can invoke appraisal. Independent appraiser reviews both positions and makes binding decision. Cost: typically $500-1,500 for the appraisal fee. If you're confident in your evidence, appraisal is powerful. "We invoke the appraisal clause per your policy. An independent appraiser will make the final determination."</p>

        <p><strong>Attorney Involvement:</strong> If the claim is large and the denial appears wrongful, consulting an attorney is warranted. Insurance bad faith (wrongfully denying a valid claim) is illegal. An attorney can send a demand letter, file suit, or negotiate settlement. Attorneys typically work on contingency (payment from recovery). Cost: 30-40% of recovered amount. Use for significant claims with strong legal merit.</p>

        <p><strong>The Escalation Decision Tree:</strong> (1) Start with supervisor review—low cost, reasonable chance. (2) If that fails, file state insurance commissioner complaint—free, regulatory pressure. (3) If significant claim (over $10,000) and strong evidence, consider public adjuster or attorney. (4) If claim is marginal or evidence is weak, accept and move on. Not every battle is worth fighting.</p>

        <p><strong>Communicating with Homeowner:**</strong> "We've exhausted initial appeals. Here are your remaining options: (1) File complaint with state insurance commissioner (free, could pressure insurance), (2) Hire public adjuster (costs 5-10% of recovery), (3) Consult attorney (could pursue legal action). Each option has cost and timeline implications. You decide what you're comfortable with." Let them choose.</p>
      </div>`,
      checklist: [
        'Request supervisor review if initial appeal fails',
        'Prepare supervisor review request letter',
        'Investigate state insurance commissioner process',
        'File complaint if appropriate',
        'Research public adjusters in your area',
        'Understand public adjuster fee structure',
        'Consult attorney for significant claims',
        'Understand appraisal clause mechanics',
        'Communicate all options clearly to homeowner',
        'Document all escalation attempts'
      ],
      proTips: [
        'Supervisor review is free and effective; always request it before going nuclear',
        'State insurance commissioners take complaints seriously; insurance companies fear regulatory action',
        'Public adjusters are effective but expensive; use for claims worth $10,000+',
        `Appraisal clause is binding but fair; if you have solid evidence, it's a powerful tool`
      ],
      commonMistakes: [
        'Jumping to attorney immediately; supervisors and commissioners are cheaper first',
        `Not explaining options clearly to homeowner; they don't understand cost/benefit`,
        'Escalating claims that are actually correctly denied; know when to accept',
        'Hiring bad attorney; get a good insurance law specialist, not your cousin'
      ],
      nextNodes: ['ins_31_when_to_walk_away'],
      prevNodes: ['ins_29_building_appeal'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-4 hours initial, ongoing depending on path',
      difficulty: 'advanced'
    },

    {
      id: 'ins_31_when_to_walk_away',
      branch: 'insurance',
      phase: 'appeal',
      phaseLabel: 'Denied — Appeal Process',
      phaseNumber: 5,
      title: 'When to Walk Away',
      subtitle: 'Knowing the difference between a defensible denial and one worth fighting, maintaining relationships',
      icon: '🚪',
      content: `<div class="rda-content">
        <p>At some point, you need to decide: is this worth fighting for? Not every denial is wrong. Not every appeal succeeds. Knowing when to walk away is as important as knowing when to fight.</p>

        <p><strong>Legitimacy Assessment:</strong> Be honest. Did the adjuster find legitimate damage that's covered? If the roof was genuinely falling apart before the storm, maybe the denial has merit. If the policy clearly excludes the peril, you're fighting an uphill battle. Be objective about whether the denial is defensible.</p>

        <p><strong>Evidence Quality:</strong> Do you have strong evidence to win an appeal? If your inspection shows clear fresh damage and the adjuster disagrees, you have a case. If your evidence is marginal and the adjuster's photos show degradation, you're probably going to lose. Assess realistically.</p>

        <p><strong>Financial Math:</strong> Is the claim size worth the effort? A $2,000 claim that requires an engineer report ($1,500) and attorney consultation ($3,000) to recover doesn't make sense. A $25,000 claim where you have good evidence makes sense to fight. Do the math.</p>

        <p><strong>Time Investment:</strong> Appealing takes time. Months of back-and-forth with insurance, attorneys, engineers. Is your time worth it? If you could spend that time on new sales and new jobs, maybe walking away and moving forward is smarter.</p>

        <p><strong>Relationship Implications:**</strong> The world is small. If you fight the same insurance company too hard on questionable claims, they may flag you as "difficult." This affects your reputation with other adjusters and homeowners working with that company. Pick your battles. Fight the legitimate ones, let go of the questionable ones.</p>

        <p><strong>The Walk-Away Conversation:**</strong> "I've reviewed this denial carefully, and while I disagree with the adjuster's assessment, I think fighting this claim could cost more than we'd recover. You'd be better off accepting this denial and moving on. I'm sorry this didn't work out, and I'd like to maintain a good relationship for future opportunities."</p>

        <p><strong>Graceful Exit:**</strong> Walking away doesn't mean you were wrong or failed. It means you made a business decision. Let the homeowner know: "The adjuster's position is different from ours. I've analyzed appeal options, and the cost and timeline don't justify the benefit. This is a business decision based on realistic assessment."</p>

        <p><strong>Future Referrals:**</strong> Even if you don't win this claim, if you handle the rejection professionally and gracefully, the homeowner may refer neighbors to you anyway. "I'm sorry insurance denied this claim. I still think we could have worked together on a future project. Please let me know if anything changes, or if you know someone else I can help."</p>
      </div>`,
      checklist: [
        'Honestly assess if denial is legitimate or defensible',
        'Evaluate strength of your evidence for appeal',
        'Calculate cost-benefit of appealing',
        'Consider time investment vs. potential return',
        'Think about relationship implications',
        'Decide: fight, compromise, or accept',
        'Have transparent conversation with homeowner',
        'Document final decision',
        'Maintain professional relationship regardless',
        'Move forward to next opportunity'
      ],
      proTips: [
        `Sometimes the right business decision is to walk away; you'll have other opportunities`,
        'Accepting a loss gracefully is better than fighting a losing battle and burning out',
        'Homeowners remember how you handle bad news; professional handling builds loyalty for next time',
        'Not every claim is winnable; knowing the difference separates experienced pros from burnt-out fighters'
      ],
      commonMistakes: [
        'Fighting every claim on principle; some denials are legitimate',
        `Sinking time into appeals that won't succeed; know when to cut losses`,
        'Letting frustration drive decisions; step back, be objective',
        'Burning bridges with insurance companies; your reputation matters'
      ],
      nextNodes: [],
      prevNodes: ['ins_30_escalation_options'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours decision time',
      difficulty: 'advanced'
    },

    // ============================================================================
    // PHASE 6: PRODUCTION & INSTALLATION (5 nodes)
    // ============================================================================

    {
      id: 'ins_32_pre_production_checklist',
      branch: 'insurance',
      phase: 'production',
      phaseLabel: 'Production & Installation',
      phaseNumber: 6,
      title: 'Pre-Production Checklist',
      subtitle: 'Permits, materials, crew assignments, dumpster, homeowner prep, neighbor notification',
      icon: '✅',
      content: `<div class="rda-content">
        <p>You're 24-48 hours from starting the job. This is the final preparation phase. Everything needs to be locked in: permits, materials on site, crew briefed, dumpster ready, homeowner prepared, and neighbors notified if needed.</p>

        <p><strong>Permit Status:</strong> Confirm permit is approved and posted (if required). "Permit #12345 is approved and will be posted by the city. Work can proceed." If permit isn't ready, delay the job rather than work without it. Working without permits creates liability and potential stop-work orders.</p>

        <p><strong>Materials on Site:**</strong> Confirm materials arrived and are in good condition. Walk through the delivery: shingles count correct, underlayment present, drip edge, flashing, fasteners, ice & water shield (if approved/supplemented). "Material delivery confirmed: 18 bundles of Owens Corning architectural in Driftwood, 400 sq ft underlayment, drip edge, flashing, 2 cases of roofing nails."</p>

        <p><strong>Crew Assignment & Briefing:**</strong> Confirm crew is available and brief them on the job. "Crew: 4 roofers + 1 lead assigned to [address], [start date]. This is an insurance job—quality is critical. Scope is [description]. We'll be here 2-3 days. Safety first, quality throughout, clean up as you go." Get crew buy-in.</p>

        <p><strong>Dumpster Status:</strong> Confirm dumpster is on order for pickup date. "20-yard dumpster ordered for delivery [date] morning, pickup [date] after cleanup. Placement in [driveway/street]."</p>

        <p><strong>Homeowner Confirmation:**</strong> Call or visit homeowner 24 hours before start. "Hi [name], confirming we're starting on your roof tomorrow at 7 AM. Crew will be here until around 4 PM. It'll be loud and busy. We'll do our best to minimize mess. Any last-minute questions?" Confirm they're ready.</p>

        <p><strong>Neighbor Notification (if needed):</strong> If you're in a residential area with close neighbors, consider a courtesy note or visit. "We'll be doing roofing work on [address] tomorrow and the next day. Work runs 7 AM to 4 PM. Apologies for any inconvenience. Questions? Call [number]."</p>

        <p><strong>Safety Equipment Check:</strong> Make sure all crew has necessary safety gear: fall protection, hard hats, gloves, safety glasses. Check ladders, scaffolding, and equipment. "Safety briefing: we use fall protection on all roofs over 6/12 pitch. Harnesses checked and secure. No exceptions."</p>

        <p><strong>Weather Final Check:</strong> Check 24-hour forecast. If rain is predicted, confirm it won't stop the job. "Forecast shows 10% chance of rain—should be fine. If conditions change, we'll move dates."</p>
      </div>`,
      checklist: [
        'Confirm permit approval and posting status',
        'Verify all materials arrived and are undamaged',
        'Count and inspect all material shipments',
        'Brief crew on job details and expectations',
        'Confirm dumpster is ordered and scheduled',
        'Call homeowner 24 hours before start',
        'Notify neighbors if appropriate',
        'Check all safety equipment',
        'Run safety briefing for crew',
        'Final weather check 24 hours before'
      ],
      proTips: [
        'Material arrival day-before is ideal; not too early, not too late',
        'A 15-minute crew briefing prevents misunderstandings and safety issues',
        'Homeowner confirmation call shows professionalism; it also prevents them from scheduling something else that interferes',
        'Neighbor notification prevents complaints to HOA or police about the noise'
      ],
      commonMistakes: [
        'Starting without permits; this is a legal liability',
        'Materials arriving too early or too late; timing matters',
        'Not briefing crew; they show up confused about scope',
        'Not confirming with homeowner; they schedule something that interferes'
      ],
      nextNodes: ['ins_33_installation_day'],
      prevNodes: ['ins_23_schedule_install', 'ins_27_negotiation_tactics'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'beginner'
    },

    {
      id: 'ins_33_installation_day',
      branch: 'insurance',
      phase: 'production',
      phaseLabel: 'Production & Installation',
      phaseNumber: 6,
      title: 'Installation Day',
      subtitle: 'Quality control, step-by-step execution, tear-off through ridge cap completion',
      icon: '🏗️',
      content: `<div class="rda-content">
        <p>This is the actual work. You're tearing off an old roof and installing a new one. This is where your inspection knowledge becomes production knowledge. Quality matters—insurance is watching, homeowner is watching, and your reputation is on the line.</p>

        <p><strong>Tear-Off Phase:</strong> Crew starts by removing old roof materials. This is loud, dusty, and physically demanding. Proper tear-off exposes the deck so you can assess for damage. Key points: (1) Use tarps to protect landscaping, (2) Ensure all old material is removed completely, (3) Inspect deck during tear-off—you may find rot or damage not visible from above, (4) Document any new damage discovered with photos, (5) Have materials ready to start new installation same day (don't leave deck exposed overnight if possible).</p>

        <p><strong>Deck Inspection During Tear-Off:</strong> This is when you discover issues. Soft spots, rot, water damage, prior repairs—all become visible when the old roof is off. Document with photos and notes. "South slope, 8 feet from east end: 3x4 foot area of soft decking, consistent with prior water damage from the hail-damaged area identified in inspection." This becomes a supplement request if it's storm-related and wasn't in the original scope.</p>

        <p><strong>Deck Repair/Replacement:</strong> If damage is found, repair or replace decking as needed. If it was pre-existing and not storm-related, homeowner pays. If it's connected to the storm damage, you supplement. Either way, get approval before proceeding. "Found soft decking—appears to be prior water damage, possibly from the hail impact area. Recommend replacement of damaged section. I'm submitting this to insurance as a storm-related supplement."</p>

        <p><strong>Installation Sequence:</strong> (1) Deck preparation and sweeping, (2) Drip edge installation (if applicable), (3) Ice & water shield installation on valleys and high-risk areas, (4) Underlayment installation (felt or synthetic), (5) Field shingle installation—start at eaves, work up, ensuring proper nail placement and overlap, (6) Valley flashing (if new valleys), (7) Ridge cap installation, (8) Pipe jacks and vents, (9) Cleanup and final inspection.</p>

        <p><strong>Quality Control During Installation:</strong> You're overseeing the work. Check: (1) Proper nail placement—4 nails per shingle in the manufacturer's nail zone, not too high or low, (2) Proper overlap and alignment—shingles line up, rows are straight, (3) No buckling or waviness—indicates improper installation or deck issues, (4) Flashing installed correctly—sealant applied, overlaps correct, no gaps, (5) Ridge cap properly sealed—ensures water shedding at peak, (6) No exposed nails or fasteners—everything covered.</p>

        <p><strong>Common Installation Mistakes to Catch:**</strong> Nails driven too deep (splits shingle), not enough nails (shingle lifts in wind), improper overlap (water finds way in), flashing not sealed (leaks), ridge cap loosely installed (fails in wind). Your role is to catch these before they become problems.</p>

        <p><strong>Photography During Installation:**</strong> Take photos as you go. "Day 1: tear-off complete, deck visible, soft spot identified south slope." "Day 2: ice & water shield and underlayment installed, beginning field shingles." "Day 3: ridge cap complete, final cleanup." These photos document the work and provide before/after evidence.</p>
      </div>`,
      checklist: [
        'Arrive early to set up staging area and protect landscaping',
        'Oversee tear-off—ensure complete removal of old material',
        'Inspect deck during tear-off for damage/rot',
        'Document any new damage found with photos and notes',
        'Approve or supplement deck repairs',
        'Oversee installation sequence: drip edge, underlayment, shingles, flashing, ridge',
        'Check nail placement and fastener specifications',
        'Verify shingle overlap and alignment throughout',
        'Inspect flashing installation and sealing',
        'Photograph work progress daily',
        'Address any quality issues immediately'
      ],
      proTips: [
        'Deck inspection during tear-off is critical; soft spots or rot become visible and must be addressed',
        'Proper nail placement is THE most common quality issue; check constantly',
        'Photos during installation document the work and provide proof of quality for insurance if needed',
        'Crew will try to cut corners to speed up; your oversight prevents this'
      ],
      commonMistakes: [
        'Not inspecting deck carefully; you miss damage that could be supplemented',
        'Not catching nail placement issues; shingles fail prematurely in wind',
        'Leaving deck exposed overnight; rain can cause additional damage',
        'Not photographing work; you have no documentation of quality later'
      ],
      nextNodes: ['ins_34_managing_crew'],
      prevNodes: ['ins_32_pre_production_checklist'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '16-24 hours (2-3 days)',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_34_managing_crew',
      branch: 'insurance',
      phase: 'production',
      phaseLabel: 'Production & Installation',
      phaseNumber: 6,
      title: 'Managing the Crew',
      subtitle: 'Communication, quality checks, problem-solving, change orders, and handling surprises',
      icon: '👥',
      content: `<div class="rda-content">
        <p>Managing the crew is as important as doing the work. You need to keep them motivated, on schedule, and producing quality. You also need to handle problems that arise—and problems always arise.</p>

        <p><strong>Daily Briefing:</strong> Start each day with a 10-minute crew briefing. "Here's the plan for today: finish underlayment on south slope, install field shingles on north slope, start ridge cap. Safety reminder: we're using fall protection on everything over 6/12. Lunch at noon. We'll wrap by 4 PM. Any questions?" A clear plan prevents confusion.</p>

        <p><strong>Quality Checks:</strong> Watch the work. Every couple hours, walk the roof and spot-check quality. "Let me verify nail placement on this section... good, that looks right. But this area—the overlap seems short. Let me re-check the spec... yes, needs more overlap. Can you redo this section?" Catch issues early before they become bigger problems.</p>

        <p><strong>Communication:**</strong> Keep your crew informed. "Weather looks okay but we're going to push hard today to get ahead of the forecast. Tomorrow might be a lighter day." "I discovered soft decking—we're replacing that section. Will add 4-6 hours to the timeline. Budget accordingly." Transparency keeps crew engaged.</p>

        <p><strong>Problem-Solving During Work:**</strong> Issues arise. Old roof has additional rot. Weather window closes sooner. Crew member gets sick. Address these as they happen. "Found more deck rot than expected—we'll need to budget X more hours. That could extend timeline to 4 days instead of 3. The homeowner has approved the supplemental scope, so we have green light."</p>

        <p><strong>Change Orders:</strong> If scope changes mid-job, get approval before expanding work. "During tear-off, we found that the fascia is rotted and needs replacement. That's not in the current scope. I'll submit that to insurance as a supplement. In the meantime, should we proceed assuming we'll get approval, or wait?" Document every change and who approved it.</p>

        <p><strong>Safety Management:</strong> You're responsible for crew safety. No shortcuts on fall protection, no rushing on dangerous slopes, no working in unsafe conditions. "We're not working in rain—it's too slippery and risky. We'll wait for conditions to improve." Crew might grumble, but safety is non-negotiable.</p>

        <p><strong>Homeowner Interaction:**</strong> Crew members represent your company. Brief them: "Be professional with the homeowner. Answer reasonable questions. If they have concerns, let me know. Don't make promises or commitments—I handle that." Set expectations for professional behavior.</p>

        <p><strong>End-of-Day Debrief:**</strong> At the end of each day, briefly review progress. "We got X done today. Tomorrow we're starting Y. On track for completion on schedule." This keeps everyone aligned and accountable.</p>
      </div>`,
      checklist: [
        'Conduct daily morning briefing',
        'Clearly communicate daily plan and expectations',
        'Check quality every 1-2 hours',
        'Address quality issues immediately',
        'Document any problems or deviations',
        'Keep homeowner informed of progress',
        'Handle crew members professionally',
        'Address safety issues immediately',
        'Process change orders with approval',
        'Debrief daily on progress and next day'
      ],
      proTips: [
        'Crew responds better to clear direction and recognition; praise good work',
        'Address quality issues immediately; delaying makes them worse',
        'Document everything—photos of problems, notes on changes, homeowner approval',
        `Crew safety is your responsibility; don't let schedule pressure override safety`
      ],
      commonMistakes: [
        'Unclear briefing; crew is confused about what to do',
        'Not checking quality; problems compound throughout the day',
        'Not addressing crew issues; morale suffers',
        'Not handling changes properly; scope creep and disputes later'
      ],
      nextNodes: ['ins_35_final_inspection'],
      prevNodes: ['ins_33_installation_day'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: 'ongoing during installation',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_35_final_inspection',
      branch: 'insurance',
      phase: 'production',
      phaseLabel: 'Production & Installation',
      phaseNumber: 6,
      title: 'Final Inspection',
      subtitle: 'Your inspection, code inspection if required, homeowner walkthrough, photo documentation',
      icon: '✓',
      content: `<div class="rda-content">
        <p>Installation is complete. Now you need to verify quality, ensure code compliance, and get final approval. This is the handoff moment.</p>

        <p><strong>Your Professional Inspection:</strong> Walk the entire roof systematically. Check: (1) All field shingles properly nailed and overlapped, (2) Ridge cap properly installed and sealed, (3) Valleys clean and flashing properly sealed, (4) All drip edge and flashing installed correctly, (5) Penetrations (vent pipes, etc.) properly sealed, (6) No debris on roof or in gutters, (7) Chimney flashing sealed, (8) Soffit and fascia in good condition. Take photos of completed work—this is your quality proof.</p>

        <p><strong>Code Inspection (if Required):</strong> Some jurisdictions require final code inspection before the job is complete. Schedule this before crew leaves. The inspector verifies: proper materials, proper installation method, code-compliant spacing and overlap. If required, don't skip it—it's part of your permit. "Code inspection is scheduled for [date]. Inspector will verify everything meets code. Should pass without issues."</p>

        <p><strong>Homeowner Walkthrough:**</strong> Walk the job with the homeowner. "Here's the new roof. Let me show you the key points: new ridge cap here, valleys properly sealed, ice and water shield installed for additional protection, drip edge all around the perimeter. Everything is code-compliant and manufacturer-approved. Do you have any questions?" Let them see the quality work. Address any concerns they have.</p>

        <p><strong>Before/After Photos:**</strong> Document the completed work with professional photos: wide shots showing the entire roof, medium shots of major sections, close-ups of key details (ridge cap, valley flashing, etc.). These photos are your portfolio and your proof of quality.</p>

        <p><strong>Warranty Documentation:**</strong> Prepare manufacturer warranty documentation for the new shingles. Most shingles come with 20-30 year warranties. Provide homeowner with: warranty certificate, details of what's covered, how to file a warranty claim, contact information for manufacturer. "Your new shingles come with a 30-year warranty against manufacturing defects. Here's the paperwork."</p>

        <p><strong>Workmanship Warranty:**</strong> Provide your own workmanship warranty. NBD backs every job with the NBD Pledge (for as long as you own the home, we'll come back and make it right) plus a written labor warranty by package — Standard 5 years (non-transferable), Preferred 10 years (transfers to one subsequent owner), Elite 20 years (fully transferable with an annual courtesy inspection). "Your written labor warranty is on your paperwork. And for as long as you own the home, we'll come back and make it right."</p>

        <p><strong>Final Signoff:**</strong> Have homeowner sign a completion form. "Work completed on [date]. Quality inspected and approved. Homeowner accepts the work as completed per the work agreement." This is your final documentation.</p>
      </div>`,
      checklist: [
        'Conduct your own professional final inspection',
        'Verify all shingles, flashing, and materials properly installed',
        'Schedule code inspection if required',
        'Pass code inspection (address any issues)',
        'Conduct walkthrough with homeowner',
        'Address any homeowner concerns',
        'Take before/after photos for documentation',
        'Provide warranty documentation from manufacturer',
        'Provide your workmanship warranty',
        'Get homeowner sign-off on completion'
      ],
      proTips: [
        'Final inspection catches issues before homeowner moves in; better to fix now than fight later',
        'Code inspection can be stressful, but proper installation passes easily',
        'Photo documentation is valuable for your portfolio and for any future disputes',
        'Warranty documentation shows professionalism and protects both you and homeowner'
      ],
      commonMistakes: [
        `Skipping code inspection if required; you're liable if found later`,
        'Not walking through with homeowner; they feel excluded from the process',
        'Not taking final photos; you have no documentation of quality',
        'Not providing warranty documentation; homeowner feels abandoned'
      ],
      nextNodes: ['ins_36_cleanup_professionalism'],
      prevNodes: ['ins_34_managing_crew'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-3 hours',
      difficulty: 'beginner'
    },

    {
      id: 'ins_36_cleanup_professionalism',
      branch: 'insurance',
      phase: 'production',
      phaseLabel: 'Production & Installation',
      phaseNumber: 6,
      title: 'Cleanup & Professionalism',
      subtitle: 'Magnetic sweeping, gutter cleaning, yard inspection, leaving better than you found it',
      icon: '🧹',
      content: `<div class="rda-content">
        <p>Installation is done and inspected. Now comes cleanup—the part that separates professional contractors from amateur operations. Cleanup is where homeowners notice you, and it's the last impression you leave.</p>

        <p><strong>Magnetic Sweep:</strong> Use a magnet to sweep the entire yard and driveway for nails and fasteners. This is mandatory, not optional. One nail in a tire is a disaster. Do multiple passes. You're looking for stray nails, screws, and metal debris. "Magnetic sweep complete—entire yard and driveway scanned twice. No fasteners visible."</p>

        <p><strong>Gutter Cleaning:</strong> Remove all debris from gutters, fascia, and downspouts. Roof installation creates granule debris and other material. Clean it all out. "Gutters cleaned, downspouts clear, no debris in flow."</p>

        <p><strong>Yard Inspection:</strong> Walk the perimeter of the property. Check: (1) All old roofing material removed and hauled away, (2) Landscaping undamaged (or documented if damaged by unavoidable accident), (3) Driveway clean, (4) Deck/patio clean, (5) No nails or debris visible. Document the cleanup with photos.</p>

        <p><strong>Dumpster Removal:</strong> Ensure dumpster is picked up on schedule. Don't leave a dumpster sitting in the homeowner's driveway longer than necessary. "Dumpster pickup scheduled for [date]. Will be removed by end of day."</p>

        <p><strong>Landscaping Restoration:**</strong> If you damaged any plants or landscaping, restore or replace it. This is part of cleanup. "We damaged the ornamental grasses near the west corner. We're replacing them with equivalent plants. Should be done by [date]."</p>

        <p><strong>Final Homeowner Inspection with You:**</strong> Walk the property one more time with the homeowner. "Let me show you the cleanup. We've swept for nails—no fasteners should be left. Gutters are clean. Everything has been removed. If you find anything we missed, just let me know and we'll fix it immediately."</p>

        <p><strong>The Lasting Impression:</strong> This is your final moment with the homeowner. A clean job and professional handoff leaves them feeling like they made a great decision. A messy job with debris everywhere leaves them wondering if the work on the roof is any good. Cleanup matters more than people think.</p>
      </div>`,
      checklist: [
        'Conduct magnetic sweep of entire yard (multiple passes)',
        'Remove all debris from gutters and downspouts',
        'Walk property perimeter checking for damage/debris',
        'Photograph cleanup for documentation',
        'Schedule dumpster pickup on time',
        'Address any landscaping damage immediately',
        'Final walkthrough with homeowner',
        'Document cleanup completion',
        'Leave property in better condition than found'
      ],
      proTips: [
        'Magnetic sweep is boring but essential; one nail in a tire ruins your reputation',
        'Gutter cleaning prevents clogging issues that homeowner will blame on your installation',
        'Photo documentation of cleanup proves professionalism',
        'Going above and beyond on cleanup (planting new flowers, power washing, etc.) creates wow moments'
      ],
      commonMistakes: [
        'Skipping magnetic sweep; nails left behind create liability and bad reputation',
        'Not cleaning gutters; debris clogs and homeowner blames you',
        'Leaving dumpster too long; homeowner gets frustrated',
        'Not addressing landscaping damage; homeowner feels disrespected'
      ],
      nextNodes: ['ins_37_completion_packet'],
      prevNodes: ['ins_35_final_inspection'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-4 hours',
      difficulty: 'beginner'
    },

    // ============================================================================
    // PHASE 7: CLOSE-OUT & COLLECTION (4 nodes)
    // ============================================================================

    {
      id: 'ins_37_completion_packet',
      branch: 'insurance',
      phase: 'closeout',
      phaseLabel: 'Close-Out & Collection',
      phaseNumber: 7,
      title: 'Certificate of Completion',
      subtitle: 'Building the completion packet with photos, warranty, material specs, final invoice',
      icon: '🏆',
      content: `<div class="rda-content">
        <p>Installation is done. Cleanup is complete. Now you need to close out the job officially. This means building a completion packet that you submit to insurance to collect final payment and provide to homeowner for their records.</p>

        <p><strong>Completion Packet Contents:</strong> (1) Completion certificate from your company, (2) Before/after photos (roof during tear-off, completed roof), (3) Material specifications document (what was installed), (4) Manufacturer warranty information, (5) Your workmanship warranty, (6) Final invoice showing line items and total cost, (7) Proof of permits and code inspection (if applicable), (8) Homeowner sign-off on completion.</p>

        <p><strong>The Completion Certificate:</strong> A simple document: "[Company Name] certifies that roofing work at [address] has been completed on [date] per the approved insurance estimate and work agreement. Work includes: [brief scope]. All work performed by licensed contractors per applicable building code. Quality inspected and approved. Signed: [your name/title], [date]." Professional, factual, official.</p>

        <p><strong>Before/After Photos:</strong> Select 5-10 key photos: (1) House exterior before tear-off, (2) Tear-off in progress showing old material, (3) Deck exposed (showing inspection), (4) New underlayment/ice & water shield, (5) Field shingles installation, (6) Ridge cap complete, (7) Final completed roof (wide shot), (8) Final completed roof (detail shots), (9) Cleanup complete. Organize chronologically. These photos tell the story of the job.</p>

        <p><strong>Material Specifications:</strong> Document what was actually installed. "Roof covering: 18 bundles architectural asphalt shingles, Owens Corning Duration, Driftwood color. Underlayment: 400 sq ft synthetic, 30-pound. Ice & water shield: 800 sq ft, 36-inch width. Drip edge: 350 linear feet. Fasteners: #1 roofing nails, per manufacturer spec. Ridge cap: Owens Corning matching bundle." Be specific. This proves you installed what you promised.</p>

        <p><strong>Final Invoice Breakdown:</strong> Show line-item costs that match the insurance estimate and supplements. Example: "Roof tear-off (1,800 sq ft): $3,600. New roof installation (1,800 sq ft): $7,200. Drip edge (350 LF): $525. Ice & water shield (800 sq ft): $200. Labor (8 days × $400): $3,200. Total: $14,725." This matches insurance approval + supplements. If homeowner paid for upgrades, show those separately: "Ice & water shield perimeter (homeowner upgrade): $300."</p>

        <p><strong>Warranty Documents:**</strong> Include original manufacturer warranty for the shingles (you got this in the bundle or from supplier). Also include your workmanship warranty. "Installation warranty: lifetime. Covers repair or replacement of any materials if installation defect is discovered."</p>

        <p><strong>Permits & Code Inspection:**</strong> Include copies of permit approval and final code inspection (if applicable). This documents compliance.</p>

        <p><strong>Homeowner Sign-Off:**</strong> A simple form: "I, [homeowner name], accept the roofing work as completed per the work agreement. Work completed on [date]. Homeowner signature: _________________ Date: _______"</p>
      </div>`,
      checklist: [
        'Prepare completion certificate from your company',
        'Organize before/after photos chronologically',
        'Document material specifications in detail',
        'Prepare final invoice with line-item breakdown',
        'Include manufacturer warranty documents',
        'Include your workmanship warranty',
        'Gather permit and code inspection copies',
        'Prepare homeowner sign-off form',
        'Package everything professionally',
        'Submit to homeowner and insurance'
      ],
      proTips: [
        'Photo organization is powerful; chronological sequence tells the job story',
        'Material specs show quality; being specific builds confidence',
        'Warranty documentation shows you stand behind your work',
        `Professional presentation matters; this is homeowner's permanent record`
      ],
      commonMistakes: [
        'Incomplete documentation; you miss something homeowner or insurance asks for later',
        `Poor quality photos; they don't show the work well`,
        'No warranty information; homeowner feels unsupported',
        'Disorganized packet; looks unprofessional'
      ],
      nextNodes: ['ins_38_collecting_holdback'],
      prevNodes: ['ins_36_cleanup_professionalism'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-3 hours',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_38_collecting_holdback',
      branch: 'insurance',
      phase: 'closeout',
      phaseLabel: 'Close-Out & Collection',
      phaseNumber: 7,
      title: 'Collecting Depreciation Holdback',
      subtitle: 'How RCV policies work, submitting completion documentation, and getting final payment',
      icon: '💰',
      content: `<div class="rda-content">
        <p>On RCV (Replacement Cost Value) policies, insurance pays in two stages: (1) initial payment at time of estimate (ACV—Actual Cash Value, accounting for depreciation), (2) final payment after work is complete (the depreciation holdback). You need to understand this and manage it professionally.</p>

        <p><strong>How RCV Works:</strong> Let's say total damage is $10,000. Roof is 10 years old, 15% depreciation. ACV payment = $10,000 - (10,000 × 0.15) = $8,500. Insurance sends $8,500 when they approve the claim. You complete work. Homeowner submits final invoice and proof of completion. Insurance then releases the holdback: $10,000 - $8,500 = $1,500. That's the final payment.</p>

        <p><strong>The Submission Process:**</strong> (1) You complete the work, (2) You prepare completion packet with photos and final invoice, (3) Homeowner submits completion packet to insurance, (4) Insurance reviews and issues holdback check, (5) You collect from homeowner. Timeline: typically 1-4 weeks depending on insurance company's workload.</p>

        <p><strong>Managing Homeowner Expectations:**</strong> Many homeowners don't understand holdbacks. They think they're getting the full amount now. "Your insurance will pay the holdback after we finish and submit completion documentation. This typically takes 2-4 weeks. I'll help prepare all the paperwork so the process moves smoothly."</p>

        <p><strong>Your Role in Submission:**</strong> You can submit completion documents directly to insurance, or homeowner can. Best practice: you prepare everything (photos, invoice, completion certificate) and homeowner submits. Or you submit on their behalf if they authorize it. "I have all the completion documentation ready. Would you like me to submit to insurance, or do you prefer to do it? Either way, let's get it submitted ASAP to start the clock on the final payment."</p>

        <p><strong>What Insurance Reviews:**</strong> They verify: (1) Work is complete—photos confirm, (2) Cost matches estimate—final invoice is itemized, (3) Materials match spec—documentation provided, (4) No additional damage claims—make sure no new issues are being claimed, (5) Code inspection passed (if required). If all checks pass, they issue holdback.</p>

        <p><strong>Collection Issues:**</strong> Sometimes insurance delays releasing holdback. "We submitted your completion documentation 3 weeks ago. I'm following up with insurance on the holdback release. Should hear back in a few days." Keep pressure on insurance but stay professional. If insurance is dragging feet, escalate: "Can you give me an update on the holdback release? We've been waiting 4 weeks and I want to make sure we're not missing anything."</p>

        <p><strong>Getting Paid from Homeowner:**</strong> Once insurance releases the holdback, it goes to the homeowner (usually). You need to collect from them. Have the conversation: "Insurance just released your holdback check for $1,500. When would be a good time for me to come collect it, or would you prefer to mail it?" Make it easy but get paid.</p>
      </div>`,
      checklist: [
        `Understand homeowner's policy (ACV vs. RCV)`,
        'Calculate expected holdback amount',
        'Prepare completion documentation',
        'Submit to insurance or have homeowner submit',
        'Track submission with insurance',
        'Follow up if insurance delays',
        'Communicate progress to homeowner',
        'Collect holdback check from homeowner',
        'Document payment received'
      ],
      proTips: [
        `RCV policies require two payments; explain this to homeowner upfront so there's no surprise`,
        `Holdback timing varies; don't promise "2 weeks"—say "typically 2-4 weeks"`,
        'Submitting documentation yourself speeds the process; if homeowner submits, it may sit',
        `Follow up with insurance after 2 weeks if you haven't heard anything`
      ],
      commonMistakes: [
        `Not explaining holdback to homeowner; they get angry when they don't get full amount immediately`,
        'Not submitting completion documents promptly; you delay your own payment',
        'Not following up with insurance; holdbacks can sit in queue for months',
        `Not collecting from homeowner; you do the work but don't get paid in full`
      ],
      nextNodes: ['ins_39_final_payment_warranty'],
      prevNodes: ['ins_37_completion_packet'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '2-4 weeks',
      difficulty: 'beginner'
    },

    {
      id: 'ins_39_final_payment_warranty',
      branch: 'insurance',
      phase: 'closeout',
      phaseLabel: 'Close-Out & Collection',
      phaseNumber: 7,
      title: 'Final Payment & Warranty Delivery',
      subtitle: 'Collecting remaining balance, warranty registration, lien waiver, and professional closure',
      icon: '✔️',
      content: `<div class="rda-content">
        <p>You've completed the work, insurance has paid, now you're collecting final payment and delivering warranties. This is the administrative close-out.</p>

        <p><strong>Collecting Remaining Balance:**</strong> Once insurance pays the holdback (or if you were paid in full on non-RCV claims), you need to collect any homeowner-responsible amounts. "Insurance approved $10,000 and paid the holdback. Your deductible and upgrade selections total $1,500. I'll email you an invoice. When would be convenient to collect that?"</p>

        <p><strong>Payment Methods:</strong> Offer multiple options: check, credit card, bank transfer, cash. "You can mail a check, or I can pick it up. Whatever is most convenient for you." Make collection easy.</p>

        <p><strong>Lien Waiver:**</strong> In many states, contractors are required to provide a lien waiver—a document stating you've been paid and you're not claiming a lien against the property. Once homeowner pays in full, you provide this: "Lien waiver for [property address]: I hereby certify that I have been paid in full for all labor and materials provided for the roofing work at [address], and I waive any right to file a lien against the property. Signed: [your name/company], [date]." This protects homeowner and releases your claim on the property.</p>

        <p><strong>Warranty Registration:</strong> Some manufacturers require warranty registration for extended coverage. "Your shingles come with a 30-year warranty from the manufacturer. To maximize coverage, I'll register the warranty on your behalf. This requires your address and the shingle color/model—I have that. Warranty should be activated within 30 days."</p>

        <p><strong>Warranty Documentation Handoff:**</strong> (1) Original manufacturer warranty certificate, (2) Your company's workmanship warranty, (3) Care & maintenance guidelines (provided by manufacturer), (4) Emergency contact info (yours and manufacturer's), (5) Claim procedures if warranty work is needed. Package these professionally. "Here's your warranty packet. It includes the manufacturer warranty, our workmanship warranty, and contact information if you ever need warranty service. Keep this somewhere safe."</p>

        <p><strong>Final Invoice & Receipt:**</strong> Provide a final invoice showing all amounts paid. "Total work value: $12,000. Insurance payment: $10,000. Homeowner payment: $1,500. Your responsibility paid: $500. Total paid: $12,000. PAID IN FULL." This is your final record.</p>

        <p><strong>Professional Closure:**</strong> A final conversation: "Your roof project is complete. Insurance has paid, you've paid your responsibility, and everything is documented. You have the written labor warranty for your package, the NBD Pledge, and the manufacturer's warranty on the materials. If anything comes up, give me a call. And please don't hesitate to refer us to neighbors or friends—we appreciate your business."</p>
      </div>`,
      checklist: [
        `Calculate homeowner's remaining balance`,
        'Present final invoice clearly',
        'Collect remaining payment',
        'Obtain signed lien waiver if required',
        'Register manufacturer warranty if applicable',
        'Prepare warranty documentation packet',
        'Provide emergency contact information',
        'Deliver all documentation to homeowner',
        'Final walkthrough if needed',
        'Document job closure in CRM'
      ],
      proTips: [
        `Lien waivers protect homeowner and show you're professional; always provide these`,
        'Warranty registration ensures homeowner gets extended coverage; do this proactively',
        'Final documentation packet is impressive; it shows you care about long-term satisfaction',
        'Professional closure conversation sets up referral request'
      ],
      commonMistakes: [
        'Not collecting remaining homeowner balance; you absorb the cost',
        'Not providing lien waiver; creates legal uncertainty',
        'Not registering warranty; homeowner loses extended coverage',
        'Not delivering warranty documentation; homeowner feels abandoned'
      ],
      nextNodes: ['ins_40_asking_referral'],
      prevNodes: ['ins_38_collecting_holdback'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours',
      difficulty: 'beginner'
    },

    {
      id: 'ins_40_asking_referral',
      branch: 'insurance',
      phase: 'closeout',
      phaseLabel: 'Close-Out & Collection',
      phaseNumber: 7,
      title: 'The Handoff',
      subtitle: 'Warranty delivery, maintenance tips, and setting up for referrals',
      icon: '🤝',
      content: `<div class="rda-content">
        <p>The work is done, payment is collected, but your relationship with the homeowner doesn't have to end. A graceful handoff sets up future referrals and positions you for repeat business.</p>

        <p><strong>Maintenance Tips Document:**</strong> Provide a simple maintenance guide. "Your new roof requires minimal maintenance. Here are recommendations: (1) Inspect roof annually after major storms, (2) Clear gutters twice per year, (3) Trim overhanging branches to prevent debris, (4) Do not pressure wash—can damage shingles, (5) Contact us if you notice any missing shingles or damage." This positions you as helpful and forward-thinking.</p>

        <p><strong>Seasonal Inspection Offer:**</strong> "I'd like to check on your roof annually after storm season—just to make sure everything is holding up well. No cost, just a quick inspection to catch any issues early. Sound good?" This stays in touch and catches problems before they become big.</p>

        <p><strong>Emergency Contact:**</strong> Make sure homeowner has your contact info and knows how to reach you. "If anything comes up—a leak, missing shingle, or any concern—just call. I'm here for you. Here's my cell number." Accessible support builds loyalty.</p>

        <p><strong>The Referral Ask:**</strong> This is the moment. You've delivered quality work, the homeowner is satisfied. Now ask for the referral. "I really appreciate the opportunity to work on your home. If you know neighbors or friends who need roofing work, I'd love to help them too. Feel free to give them my contact info or have them reach out directly. I take great care of all my customers." This is direct and respectful. Not pushy—just clear about what you'd like.</p>

        <p><strong>Referral Program Option:**</strong> Some contractors offer referral incentives. "If you refer someone who becomes a customer, I'll give you $100 off any future service or donate $100 to your favorite charity. Referrals are the best form of compliment I can get." This incentivizes referrals while staying professional.</p>

        <p><strong>Google Review Request:**</strong> "I'd also appreciate an honest review on Google. It helps other homeowners find us and decide if we're the right fit. Here's the link—takes just a minute. Whatever you say, I appreciate your business." Make it easy with a direct link. Most satisfied customers will leave a review if you ask.</p>

        <p><strong>Final Moment:**</strong> The handoff is your last face-to-face moment with the homeowner. Make it count. "Thank you for trusting us with your home. We take pride in our work and our relationships with customers. You're not just a job to us—you're part of our network. Stay safe and enjoy your new roof."</p>
      </div>`,
      checklist: [
        'Provide maintenance tips document',
        'Offer seasonal inspection service',
        'Confirm homeowner has your emergency contact',
        'Make the referral ask directly and respectfully',
        'Explain referral program if you have one',
        'Request Google review with direct link',
        'Leave professional impression at final moment',
        'Note homeowner in CRM for follow-up contact'
      ],
      proTips: [
        'Referral request is most effective right after delivery when satisfaction is high',
        'Simple, respectful ask works better than pushy sales pitch',
        'Google reviews are powerful; ask for them and most satisfied customers will comply',
        'Annual check-in maintains relationship and positions you for future work'
      ],
      commonMistakes: [
        'Not asking for referral; you leave money on the table',
        'Asking for referral too early (before trust is built) or too late (after homeowner has moved on)',
        'Not making it easy for homeowners to refer; give them language and links',
        'Not following up; referral relationships need maintenance'
      ],
      nextNodes: ['ins_41_asking_referral_strategy'],
      prevNodes: ['ins_39_final_payment_warranty'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '30-45 min',
      difficulty: 'beginner'
    },

    // ============================================================================
    // PHASE 8: POST-JOB GROWTH (4 nodes)
    // ============================================================================

    {
      id: 'ins_41_asking_referral_strategy',
      branch: 'insurance',
      phase: 'growth',
      phaseLabel: 'Post-Job Growth',
      phaseNumber: 8,
      title: 'Asking for the Referral',
      subtitle: 'Timing, approach, and the "neighbor strategy" for systematic referrals',
      icon: '📱',
      content: `<div class="rda-content">
        <p>The referral is your most valuable lead source. Insurance jobs create cascading referrals—one neighbor sees the work, tells another, who tells another. You need a system for capturing these.</p>

        <p><strong>Timing the Ask:**</strong> The best time to ask for referral is right after delivery, while satisfaction is highest. Not during the job (they're stressed), not a week later (they've moved on). During final walkthrough or completion conversation: "I'm really glad with how this turned out. I'd love to help your neighbors too. Know anyone who needs roofing work?" This is while you're in the conversation and momentum is high.</p>

        <p><strong>The Neighbor Strategy (Most Powerful):</strong> "I've been working in this neighborhood and have done 3-4 roofs on your street. If you notice neighbors discussing roof damage or repairs, would you mind mentioning my name? Or, if you're comfortable, I can stop by a couple of houses and offer a free inspection—no pressure. I've already helped some of your neighbors and they're happy with the work." This leverages proximity and social proof. Most homeowners will grant permission for you to knock nearby.</p>

        <p><strong>Direct Referral Ask:**</strong> "Do you have any neighbors or friends you think I should talk to about roofing? I'm doing great work in this area and I'd like to help more people. Here's my card—feel free to give my info to anyone you think could benefit." Direct and clear.</p>

        <p><strong>Incentive-Based Referral:**</strong> "For every referral that becomes a customer, I'll send you a $50 Amazon gift card. Just have them mention your name when they call, and once they sign with me, you get the gift card." This incentivizes referrals without feeling cheap. Most contractors do some version of this.</p>

        <p><strong>The "Cooling Off" Follow-Up:**</strong> Don't rely on single ask. Put homeowner in your CRM for follow-up. 3-6 months later: "Hi [name], I was in your neighborhood last week doing another roof and thought of you. Everything holding up well? Just checking in. Also, if you've had a chance to chat with neighbors, I'd appreciate any referrals you think would be a good fit." Stay top of mind.</p>

        <p><strong>Making Referral Easy:**</strong> Provide homeowner with language and tools. "Here's what you can say to your neighbors: '[Name] just did our roof and did a great job. If you need work, here's his number: [number].' Feel free to text that to anyone you think needs help." Make it word-for-word easy.</p>

        <p><strong>Systematic Territory Building:**</strong> In a neighborhood with 5 completed jobs, you have 5 referral sources. That's powerful. "I'm focusing on [neighborhood] because I've built relationships there and homeowners are happy with my work. Those happy customers often refer neighbors. It's how I build my business."</p>
      </div>`,
      checklist: [
        'Ask for referral during final walkthrough or completion',
        'Explain neighbor strategy clearly',
        'Provide homeowner with referral language/script',
        'If offering incentive, explain program clearly',
        'Get permission to approach nearby neighbors',
        'Add homeowner to CRM for follow-up',
        'Create system for tracking referrals',
        'Follow up in 3-6 months with "checking in" message',
        'Reward referrals (thank you note, gift, discount on future service)'
      ],
      proTips: [
        'Neighbor strategy compounds—one house in a neighborhood becomes 3-5 houses as referrals build',
        'Most homeowners are happy to refer if asked directly',
        'Incentive programs work; people respond to clear rewards',
        `Follow-up is key; don't do single ask and forget`
      ],
      commonMistakes: [
        'Not asking at all; you leave money on the table',
        'Asking too late; homeowner has moved on mentally',
        'Making referral too complicated; simplify the ask',
        `Not tracking referrals; you don't know which sources work`
      ],
      nextNodes: ['ins_42_review_request'],
      prevNodes: ['ins_40_asking_referral'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '15-30 min',
      difficulty: 'beginner'
    },

    {
      id: 'ins_42_review_request',
      branch: 'insurance',
      phase: 'growth',
      phaseLabel: 'Post-Job Growth',
      phaseNumber: 8,
      title: 'Review Request',
      subtitle: 'Timing the Google review ask, making it easy, and responding professionally',
      icon: '⭐',
      content: `<div class="rda-content">
        <p>Google reviews are the modern referral source. Potential customers check reviews before calling. You need to systematically ask for reviews from satisfied customers.</p>

        <p><strong>Timing the Ask:**</strong> Similar to referrals: ask during or right after completion when satisfaction is highest. "Before I leave, I'd love an honest review on Google. It takes just a minute and really helps other homeowners find us. Here's the link—super easy." Ask once, make it easy, move on.</p>

        <p><strong>Making It Ridiculously Easy:**</strong> Don't say "search for us on Google and leave a review." Instead, provide a direct link. "Here's the link to our review page: [link]. Just click, write a sentence or two about your experience, and submit. That's it." Text them the link. Email them the link. Some contractors put it on a card. Whatever makes it easiest.</p>

        <p><strong>What to Ask For:**</strong> "I'd love an honest review of your experience. What did we do well? What could we improve? Honesty is appreciated—it helps us get better." This invites authentic feedback, not just 5-star worship. Honest positive reviews are more credible than all 5-stars.</p>

        <p><strong>The Ask Itself:**</strong> "Google reviews mean a lot to us and help other homeowners decide if we're the right fit. Would you be willing to leave us a review? Takes about a minute. Here's the link." Direct, simple, respectful.</p>

        <p><strong>Response Strategy:**</strong> (1) Monitor your reviews regularly. (2) When you get a 5-star review, thank them: "Thank you for the review! We appreciate your business." (3) When you get a critical review, respond professionally: "We appreciate your feedback. This isn't our standard and we'd like to make it right. Can you reach out so we can discuss?" Show that you take feedback seriously. (4) Never argue with a reviewer. Respond with grace and offer to resolve.</p>

        <p><strong>Review Targets:**</strong> Aim for 1 review per job. That might be ambitious, but it's the goal. 10 reviews is 10 jobs. 30 reviews is 30 jobs of positive proof. Reviews compound over time and become a major marketing asset.</p>

        <p><strong>What Good Reviews Say:**</strong> "Professional crew, high quality, on time, clean." "[Contractor name] guided us through the insurance process. Transparent and honest." "Would recommend without hesitation." These are gold because they address what potential customers care about: professionalism, process, recommendation.</p>

        <p><strong>Follow-Up for Non-Reviews:**</strong> If you don't get a review right away, follow up once: "Hi [name], just checking—were you able to leave that review? Happy to help if you had any questions." But don't be pushy. If someone doesn't want to review, respect that.</p>
      </div>`,
      checklist: [
        'Ask for review at completion/walkthrough',
        'Provide direct link (not generic "Google us")',
        'Keep link in email signature and cards',
        'Send follow-up email with link if not asked verbally',
        'Monitor reviews regularly',
        'Thank positive reviews professionally',
        'Respond to critical reviews with grace and offer to resolve',
        'Track review count as KPI',
        'Aim for 1 review per job',
        'Never argue with reviewer'
      ],
      proTips: [
        'Direct link increases review rate 5-10x over generic ask',
        'Most satisfied customers will review if you ask directly and make it easy',
        'Professional response to critical reviews shows character; many potential customers appreciate this',
        `Reviews are your best marketing; they're authentic and trustworthy`
      ],
      commonMistakes: [
        'Not asking for reviews; you miss easy credibility building',
        'Asking but not making it easy; generic "Google us" gets ignored',
        'Arguing with negative reviewers; this makes you look bad',
        'Not monitoring reviews; you miss opportunities to respond'
      ],
      nextNodes: ['ins_43_repeat_customer_pipeline'],
      prevNodes: ['ins_41_asking_referral_strategy'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '15-30 min',
      difficulty: 'beginner'
    },

    {
      id: 'ins_43_repeat_customer_pipeline',
      branch: 'insurance',
      phase: 'growth',
      phaseLabel: 'Post-Job Growth',
      phaseNumber: 8,
      title: 'Repeat Customer Pipeline',
      subtitle: 'Adding to CRM for annual check-ins, storm season outreach, and maintenance programs',
      icon: '🔄',
      content: `<div class="rda-content">
        <p>The homeowner you just completed a roof for is your best future customer. They trust you, they know your quality, and they might need future work. Build a system for staying in touch and capturing repeat business.</p>

        <p><strong>CRM Setup:**</strong> Add every completed customer to your CRM with key info: name, address, phone, email, completion date, roof type, materials, special notes. "John Smith, 123 Main Street, completed full roof 7/15/2024, Owens Corning architectural, customer satisfied, has referral leads." This becomes your customer database.</p>

        <p><strong>Annual Check-In:**</strong> Every year on the anniversary of their roof completion, reach out. "Hi [name], it's been a year since we finished your roof. Just checking in—everything holding up well? Any concerns or questions? I'd love to do a free inspection if you want peace of mind." This stays top-of-mind and catches issues early.</p>

        <p><strong>Storm Season Re-Contact:**</strong> When major storms hit, reach out to your database. "A big storm came through the area last night. I wanted to check if you got hit at all and offer a free inspection. Better to check now than wait for problems to show up." This positions you as helpful and proactive. Some will have damage and hire you; all will appreciate the concern.</p>

        <p><strong>Maintenance Programs:**</strong> Some contractors offer maintenance plans: annual gutter cleaning, inspections, small repairs. "We offer a maintenance program: $200/year includes annual roof inspection, gutter cleaning, and 10% discount on repairs. Keeps your roof in top shape. Interested?" This creates recurring revenue and ongoing customer contact.</p>

        <p><strong>New Roof Estimate Calls:**</strong> When homeowners ask about new roofs or repairs (not just insurance), you already have their trust. Conversion rate is much higher than cold calls. This is your gold mine.</p>

        <p><strong>Lifetime Customer Value:**</strong> Think long-term. One roof job today could lead to: gutters next year, maintenance program, fascia repair, new roof in 15 years, referrals. The lifetime value of a satisfied customer is significant.</p>

        <p><strong>Segmentation:**</strong> In your CRM, segment customers: (1) Recent customers (0-2 years): reach out for maintenance/upgrades, (2) Medium customers (2-5 years): annual check-ins, (3) Long-term customers (5+ years): they're soon due for re-roofing, maintenance programs, (4) Referral customers: top tier, highest value.</p>

        <p><strong>Communication Cadence:**</strong> Don't overwhelm them, but stay in touch. Suggested: annual check-in on roof anniversary, storm-triggered outreach if applicable, seasonal maintenance reminders (gutters in fall), occasional newsletter or update. 2-4 contacts per year is right.</p>
      </div>`,
      checklist: [
        'Set up CRM system with customer database',
        'Input all completed customers with key information',
        'Schedule annual check-in reminder for each customer',
        'Create storm season outreach template',
        'Develop maintenance program offering (if applicable)',
        'Set up segmentation by customer age/value',
        'Create communication cadence plan',
        'Automate reminders for outreach (or calendar)',
        'Track repeat customer conversion rate',
        'Use data to optimize outreach strategy'
      ],
      proTips: [
        'Repeat customers are 5-10x easier to sell to than cold prospects; invest in retention',
        'Annual check-ins cost almost nothing but show care and maintain relationship',
        'Storm-triggered outreach is timely and helpful; customers appreciate proactive concern',
        'Maintenance programs create recurring revenue and customer touchpoints'
      ],
      commonMistakes: [
        'Not systematizing repeat customer outreach; you rely on memory',
        'Not staying in touch; customer forgets you and calls competitor when they need work',
        'Over-communicating or being pushy; you annoy customers',
        `Not tracking repeat customer success; you don't know if the system works`
      ],
      nextNodes: ['ins_44_building_business'],
      prevNodes: ['ins_42_review_request'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: '1-2 hours setup, ongoing management',
      difficulty: 'intermediate'
    },

    {
      id: 'ins_44_building_business',
      branch: 'insurance',
      phase: 'growth',
      phaseLabel: 'Post-Job Growth',
      phaseNumber: 8,
      title: 'Building the Business',
      subtitle: 'Leveraging completed jobs for marketing, portfolio, case studies, and growth',
      icon: '📈',
      content: `<div class="rda-content">
        <p>Each completed job is a marketing asset. Professional contractors turn their work into portfolio, case studies, marketing content, and business growth. Don't let your work sit behind closed doors—leverage it.</p>

        <p><strong>Yard Signs & Curb Appeal:**</strong> Get permission from homeowner to put a yard sign while the work is fresh. "Would you be okay with a 'Real Deal Roofing' yard sign in your front yard for a week or two? Helps us generate leads and I'll come take it down." Most homeowners say yes. The sign is free marketing to every neighbor who drives by.</p>

        <p><strong>Before/After Portfolio:**</strong> Create a before/after portfolio on your website showing completed work. "See our recent projects." Include 3-5 before/after photos per project, address, completion date, testimonial if available. This is your visual proof of quality. Professional portfolio converts more than promises.</p>

        <p><strong>Case Study Development:**</strong> For significant or interesting jobs, write a brief case study. "Customer had hail damage to 10-year-old roof. Insurance initially denied. We appealed with engineer report. Won the appeal and completed full roof replacement. Customer very satisfied." Case studies tell your story better than generic descriptions.</p>

        <p><strong>Testimonial Requests:**</strong> Ask satisfied customers for written testimonials. "Would you be willing to write a brief review of your experience? Something like: 'What was the biggest challenge and how did we solve it? Would you recommend us?' We use these on our website and marketing." Most will comply and it's more powerful than a Google review.</p>

        <p><strong>Social Media Content:**</strong> Share before/after photos on Facebook/Instagram. "Hail damage roof replacement in [neighborhood]. Customer satisfied! If you need roof repair or replacement, DM us." Keep it professional but present your work. Social media content doesn't need to be fancy—real work is more authentic than stock photos.</p>

        <p><strong>Video Content:**</strong> Consider short videos: roof inspection walkthrough, installation process, homeowner testimonial. Videos humanize your business and show actual work (not just sales pitch). "Here's a time-lapse of our roof replacement process." People engage with video more than photos.</p>

        <p><strong>Local Marketing Leverage:**</strong> Completed jobs in a neighborhood are your local proof. "I've completed 6 roofs in [neighborhood] in the last year. Ask your neighbors—they'll tell you about our quality." This builds reputation in territory and generates referrals.</p>

        <p><strong>Growth Metrics:**</strong> Track: (1) Referral percentage (% of jobs from referrals), (2) Review rate (reviews per job), (3) Repeat customer rate (% of customers who do repeat business), (4) Average job value (growing over time as skills improve), (5) Crew efficiency (time per square foot improving), (6) Profit margin (improving with experience). These metrics show your business growth.</p>
      </div>`,
      checklist: [
        'Get permission for yard signs',
        'Photograph before/after professionally',
        'Create website portfolio section',
        'Write 1-2 case studies per quarter',
        'Request testimonials from satisfied customers',
        'Share content on social media monthly',
        'Develop video content strategy',
        'Track referral source data',
        'Monitor and improve conversion metrics',
        'Build reputation in key territories'
      ],
      proTips: [
        'Yard signs are free marketing; permission is easy to ask and most say yes',
        'Before/after photos are your strongest marketing tool; invest in professional photography',
        'Case studies show not just the work but your process and problem-solving',
        'Referrals compound as reputation grows; each job creates 2-3 referral leads on average'
      ],
      commonMistakes: [
        'Not documenting work; you complete jobs but leave no marketing record',
        `Not asking for testimonials or reviews; these are goldmines you're leaving on table`,
        `Not leveraging social media; it's free and authentic marketing`,
        'Not building local reputation; you treat each job as isolated instead of territory building'
      ],
      nextNodes: [],
      prevNodes: ['ins_43_repeat_customer_pipeline'],
      isFork: false,
      forkLabel: '',
      forkOptions: [],
      estimatedTime: 'ongoing',
      difficulty: 'intermediate'
    }
  ];
})();
