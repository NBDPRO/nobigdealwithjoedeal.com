// tools-canned.js: sample answers for the three AI tool pages in the sample
// account (2026-10-24). Decision Engine (/pro/ai-tree.html), Understand
// (/pro/understand.html) and Project Codex (/pro/project-codex.html) call
// window.callClaude. In the sample account offline.js hands their requests
// here, and no model is called.
//
// Jo's decisions (2026-10-24):
//   - canned sample answers, each one labelled as a sample, with no AI model
//   - insurance topics stay out: Decision Engine's Insurance vs Cash and
//     Supplement Strategy, Understand's Insurance Deep Dive, and Codex's
//     Supplement Strategy card. demo-mode.js hides them; this file refuses
//     them too, in case one is reached anyway.
//   - Codex answers are built from the selected sample job's own data, which
//     the page puts in the request. Never a number the request did not carry.
//
// Recognised by each page's own system prompt, so the real pages are unchanged.

const FOOT = {
  decision: 'Sample answer: no AI model was called. In your real account the Decision Engine weighs your exact inputs.',
  understand: 'Sample answer: no AI model was called. In your real account Understand answers any question you type, for your market.',
  codex: 'Sample answer, built from this sample job\'s record: no AI model was called. In your real account Project Codex answers anything about your own jobs.'
};
const NOT_HERE = 'Insurance topics are not in the sample account. In your real account this tool covers them.';

function reply(text) {
  return {
    id: 'sample-' + Date.now().toString(36), type: 'message', role: 'assistant', model: 'sample-canned-answer',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, sample: true
  };
}

function lastUser(req) {
  const msgs = (req && Array.isArray(req.messages)) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user') return typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ') : '');
  }
  return '';
}

// ── Decision Engine ─────────────────────────────────────────────────────
// The page sends "Category: <label>" and "- <question label>: <chosen option>".
function inputs(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^- ([^:]+): (.+)$/.exec(line.trim());
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}
const has = (v, re) => re.test(String(v || ''));

function pricing(a) {
  const budget = a['Customer Budget'], material = a['Material Preference'], comp = a['Competitive Situation'], job = a['Job Type'];
  let tier = 'Better';
  if (has(budget, /^Price-sensitive/) || has(material, /^3-tab/)) tier = 'Good';
  if (has(budget, /^(Quality|Premium)/) || has(material, /^(Premium|Metal)/)) tier = 'Best';
  const repair = has(job, /^Roof repair/);
  const decision = repair
    ? 'Price the repair as its own line from your cost book, and show the replacement options beside it so the homeowner sees both.'
    : 'Lead with the ' + tier + ' option, and show the tier above and below it so the homeowner chooses between your options, not between contractors.';
  const crowded = has(comp, /3\+|Storm chaser/);
  return [
    'DECISION: ' + decision,
    '',
    'CONFIDENCE: ' + (has(budget, /^Unknown/) || has(comp, /^Not sure/) ? 'Medium' : 'High'),
    '',
    'KEY REASONING:',
    '- Budget: ' + (budget || 'not given') + '. ' + (tier === 'Good' ? 'Start where they are comfortable and make the upgrade easy to say yes to.' : tier === 'Best' ? 'They are telling you they value the result; do not talk them down.' : 'Most homeowners pick the middle option when they can see all three.'),
    '- Material: ' + (material || 'not given') + '. Match the tier to what they asked for before suggesting anything else.',
    '- Competition: ' + (comp || 'not given') + '. ' + (crowded ? 'In a crowded field, win on clarity: a written scope, a clear warranty and a start date.' : 'With little competition, hold your margin and explain what is included.'),
    '',
    'TALKING POINTS FOR HOMEOWNER:',
    '- "Here are three ways to do your roof. Each one is a complete job; the difference is materials and warranty."',
    '- "Everything we do is in writing on this page, so you can compare it line by line with any other bid."',
    '',
    'NEXT STEPS:',
    '1. Build the estimate from your own cost book so every tier keeps your margin.',
    '2. Walk the homeowner through the options on the estimate, top to bottom.',
    '3. Book a follow-up within two days if they want to think it over.',
    '4. ' + FOOT.decision
  ].join('\n');
}

function damage(a) {
  const signs = a['Visual Signs'], metal = a['Soft Metal Test'], inside = a['Interior Evidence'], weather = a['Recent Weather'], gran = a['Granule Condition'];
  const storm = (has(signs, /dents|bruises|torn|flipped/) ? 1 : 0) + (has(metal, /^Clear dents/) ? 1 : 0) + (has(weather, /^Yes/) ? 1 : 0) + (has(gran, /impact patterns/) ? 1 : 0);
  const age = (has(signs, /Cracking|curling|streaks|moss/) ? 1 : 0) + (has(weather, /^No recent storm/) ? 1 : 0) + (has(gran, /Light, even|Heavy granule loss/) ? 1 : 0);
  const leak = has(inside, /^Active leak/);
  const decision = storm > age
    ? 'This reads as storm damage: document it fully before anything else.'
    : age > storm ? 'This reads as age and wear, not a storm: talk replacement timing, not damage.'
      : 'The signs are mixed: inspect up close and photograph before you tell the homeowner anything.';
  return [
    'DECISION: ' + decision,
    '',
    'CONFIDENCE: ' + (Math.abs(storm - age) >= 2 ? 'High' : Math.abs(storm - age) === 1 ? 'Medium' : 'Low'),
    '',
    'KEY REASONING:',
    '- What you saw on the roof: ' + (signs || 'not given') + '.',
    '- Soft metals: ' + (metal || 'not given') + '. Dents on vents, gutters and downspouts are the easiest storm evidence to photograph.',
    '- Weather: ' + (weather || 'not given') + '. Granules: ' + (gran || 'not given') + '.',
    '',
    'TALKING POINTS FOR HOMEOWNER:',
    '- "I am going to show you every photo I take, so you see exactly what I see."',
    leak ? '- "You have an active leak, so the first job is stopping water getting in."' : '- "Nothing here needs a decision today. Let me show you the photos first."',
    '',
    'NEXT STEPS:',
    '1. Photograph every slope, the soft metals and any interior stains, with something for scale.',
    '2. Mark and photograph a test area on each slope.',
    leak ? '3. Tarp or temporarily repair the leak today.' : '3. Note the roof\'s age and layers for the estimate.',
    '4. ' + FOOT.decision
  ].join('\n');
}

function decisionEngine(req) {
  const text = lastUser(req);
  const cat = (/^Category: (.+)$/m.exec(text) || [])[1] || '';
  const a = inputs(text);
  if (/Pricing/i.test(cat)) return pricing(a);
  if (/Damage/i.test(cat)) return damage(a);
  return 'DECISION: ' + NOT_HERE + '\n\nCONFIDENCE: Low\n\nNEXT STEPS:\n1. Try Pricing Strategy or Damage Assessment.\n2. ' + FOOT.decision;
}

// ── Understand ──────────────────────────────────────────────────────────
// Short, general answers to the starter topics: no code section numbers, no
// dollar figures. Jo reviews the wording.
const UNDERSTAND = {
  'GAF vs Owens Corning vs CertainTeed: which is best?':
    'All three make good architectural shingles. The bigger difference is usually the installer, not the brand.\n\n- **Pick by program:** choose the maker whose certified-contractor program you hold, so the homeowner can get its stronger warranty.\n- **Supply:** stock what your supplier keeps on hand in the colors your market buys.\n- **Install to the book:** every warranty depends on following that maker\'s instructions, including their own starter, ridge and ventilation parts.\n- **Tell the homeowner:** "The brands are close. What matters is a crew that installs it the way the manufacturer requires, and a warranty in writing."',
  'What building codes apply to reroofing in Ohio?':
    'Ohio homes fall under the **Residential Code of Ohio**, which is based on the International Residential Code (IRC). Local building departments enforce it and set their own permit rules.\n\n- **Check the city or county** before every job: some require a permit for a reroof and some do not.\n- **Key reroof topics:** how many layers may stay, ice barrier at the eaves, drip edge, underlayment, and attic ventilation.\n- **Kentucky jobs** follow Kentucky\'s own residential code, so check those separately.\n- **Manufacturer instructions** sit on top of code. Follow both.',
  'How to calculate proper attic ventilation (NFA)?':
    'NFA is **net free area**: the open area a vent actually lets air through. Each vent product lists its NFA.\n\n- **Common rule of thumb:** 1 square foot of NFA for every 150 square feet of attic floor, or 1 per 300 when the intake and exhaust are balanced.\n- **Split it** about evenly between intake (soffit) and exhaust (ridge), with no more exhaust than intake.\n- **Do not mix exhaust types** on one attic, such as ridge vent plus box vents. They short-circuit each other.\n- **Check the shingle maker\'s spec and your local code**, since the warranty can depend on it.',
  'Ice and water shield requirements by code':
    '- **Code:** where ice dams are a known problem, the IRC requires an ice barrier from the eave edge to at least 24 inches inside the exterior wall line. Your local building department says whether your area is one of them.\n- **Valleys and penetrations:** many manufacturers call for it there for the warranty, even where code does not.\n- **Low slopes** often need more coverage. Read the maker\'s low-slope instructions.\n- **Tell the homeowner** where it goes and why, and put it in the written scope.',
  'When should I recommend a full tear-off vs overlay?':
    '- **Tear-off when:** there are already two layers, the decking is soft or damaged, the old roof is wet, or the existing roof is wood shake, slate or tile.\n- **Overlay can work when:** there is one sound layer and local code allows it.\n- **Warranty:** many manufacturers limit their warranty on overlays. Check before you offer one.\n- **The honest pitch:** a tear-off lets you see and fix the decking, and it is the option most homeowners will not regret.',
  'Best underlayment options and when to use synthetic':
    '- **Synthetic underlayment** is lighter, stronger, safer to walk on and holds up better if the roof is open for a few days. It is the default on most reroofs now.\n- **Felt** still works and costs less, but it tears more easily and wrinkles when wet.\n- **Ice and water shield** goes where code or the manufacturer calls for it: eaves, valleys and around penetrations.\n- **Use the shingle maker\'s own underlayment** when you want their strongest warranty.',
  'How to properly flash a chimney on a shingle roof':
    '- **Apron flashing** across the low side.\n- **Step flashing** up each side, one piece per shingle course.\n- **Counter flashing** set into a cut in the mortar joint and lapped over the step flashing, so the brick sheds water over it.\n- **A cricket** behind wider chimneys sends water around instead of letting it pond.\n- **Seal with the right product** for masonry, and never rely on sealant alone in place of metal.',
  'Metal roofing vs asphalt shingles: cost-benefit analysis':
    '- **Metal** costs more up front, lasts longer, handles wind well and sheds snow. Standing seam is the premium choice.\n- **Asphalt** costs less, is quicker to install and is easier to repair. Most homeowners and most neighborhoods choose it.\n- **Compare cost per year of life**, using your own quotes and the warranties offered.\n- **Ask the homeowner** how long they plan to stay. That usually decides it.',
  'How should I price my roofing jobs to stay competitive?':
    '- **Start from your real costs:** materials, labor, dump fees, permits, and your overhead. Then add the margin you need, not the margin the cheapest bid uses.\n- **Offer options** (good, better, best) so the homeowner compares your tiers instead of comparing you to another contractor.\n- **Win on clarity:** a written scope, a warranty in writing and a start date beat a lower number with nothing behind it.\n- **Track your close rate by tier** and adjust from your own numbers.',
  'Best marketing strategies for roofing contractors':
    '- **Reviews first:** ask every finished customer, and make it one tap for them.\n- **Your Google Business Profile:** keep it current, with real job photos and quick replies to every review.\n- **Neighbors of finished jobs:** knock and leave a door hanger around every job you complete.\n- **Referrals:** thank every referral, every time.\n- **Track where each lead came from** so you spend on what works.',
  'How to build and manage a roofing crew':
    '- **Hire for reliability and attitude.** Skills can be taught; showing up cannot.\n- **Write down your standard:** how you tear off, protect the property, install and clean up. Then check jobs against it.\n- **Pay on time, every time.**\n- **Run a short meeting before each job** on the scope, the safety plan and anything special about the house.\n- **Inspect every finished roof** before the crew leaves.',
  'Territory planning: how many leads do I need per month?':
    'Work backward from your own numbers:\n\n- **Jobs you want per month** divided by **your close rate** gives the appointments you need.\n- **Appointments needed** divided by **how many leads turn into appointments** gives the leads you need.\n- **Doors to knock** comes from how many doors it takes you to get one lead.\n\nUse your real rates from your pipeline. The Success Tracker and your dashboard keep them for you.',
  'Should I focus on insurance work or retail/cash jobs?':
    'Insurance topics are not in the sample account.\n\nOn the retail side: retail jobs give you control of the schedule, the scope and the price, and they come in all year, not only after storms. Build a retail base you can count on, whatever else you take on.',
  'How to get more Google reviews and rank higher':
    '- **Ask at the right moment:** the day the job is finished and the yard is clean.\n- **Make it one tap:** send your direct review link by text.\n- **Reply to every review**, good or bad, within a day or two.\n- **Keep your profile current:** hours, service area and real photos from recent jobs.\n- **Never buy or offer anything for reviews.** It breaks Google\'s rules.',
  'When should I hire a project manager vs do it myself?':
    '- **Hire when** you are the bottleneck: jobs wait on you, you cannot get back to selling, or quality slips because you cannot be on every roof.\n- **Before you hire,** write down how a job runs from signed contract to final payment. That document is the new hire\'s training.\n- **Start with the tasks** that take your time but not your judgment: scheduling, material orders and homeowner updates.',
  'How to scale from $500K to $2M annual revenue':
    '- **Systems before people:** a written process for selling, producing and collecting, so the work does not depend on you.\n- **A steady lead flow** you can predict: referrals, reviews and canvassing tracked by source.\n- **Crews you can trust** without you on site, with a quality check on every job.\n- **Cash flow:** collect deposits and final payments on time, and know your margin on every job.\n- **Add one role at a time**, usually sales or production first.'
};

function understand(req) {
  const sys = String(req.system || '');
  if (/insurance claims consultant/i.test(sys)) return NOT_HERE;
  const q = lastUser(req).trim();
  const hit = UNDERSTAND[q];
  if (hit) return hit + '\n\n' + FOOT.understand;
  return 'In the sample account Understand answers its starter topics (the buttons above). Pick one to see a sample answer.\n\n' + FOOT.understand;
}

// ── Project Codex ───────────────────────────────────────────────────────
// The page puts the selected job's record in the request as "KEY: value"
// lines (buildProjectContext). Every answer below uses only those lines.
function ctxOf(text) {
  const out = { tasks: [], history: [] };
  let section = '';
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = /^([A-Z][A-Z #]+): ?(.*)$/.exec(line);
    if (m) { section = m[1]; if (m[2]) out[m[1]] = m[2].trim(); continue; }
    const item = /^\s+- (.+)$/.exec(line);
    if (item && section === 'TASKS') out.tasks.push(item[1]);
    else if (item && section === 'STAGE HISTORY') out.history.push(item[1]);
  }
  return out;
}
const stageText = (c) => String(c.STAGE || 'new').replace(/_/g, ' ');
const first = (c) => String(c.PROJECT || 'the homeowner').trim().split(/\s+/)[0] || 'there';

function codexStatus(c) {
  return '**' + (c.PROJECT || 'This project') + '**\n\n' +
    '- **Stage:** ' + stageText(c) + '\n' +
    '- **Address:** ' + (c.ADDRESS || 'not set') + '\n' +
    (c['ESTIMATE VALUE'] ? '- **Estimate:** ' + c['ESTIMATE VALUE'] + '\n' : '') +
    (c.CREATED ? '- **Created:** ' + c.CREATED + '\n' : '') +
    (c.history.length ? '- **Latest step:** ' + c.history[c.history.length - 1] + '\n' : '');
}
function codexLeft(c) {
  const open = c.tasks.filter((t) => /^\[OPEN\]/.test(t)).map((t) => t.replace(/^\[OPEN\]\s*/, ''));
  if (open.length) return '**Open tasks on this job:**\n\n' + open.map((t) => '- ' + t).join('\n');
  return 'No open tasks are on this job\'s record. It is at **' + stageText(c) + '**; the usual next step from there is to move it to the next stage on your pipeline and add a task for whoever owns it.';
}
function codexEmail(c) {
  return '**Subject:** Your roof at ' + (c.ADDRESS || 'your home') + '\n\n' +
    'Hi ' + first(c) + ',\n\n' +
    'Thank you for your time on your roof project. Your job is currently at the **' + stageText(c) + '** stage' +
    (c['ESTIMATE VALUE'] ? ', and your estimate is ' + c['ESTIMATE VALUE'] : '') + '.\n\n' +
    'I will follow up with the next step shortly. If you have any questions in the meantime, just reply to this email or give me a call.\n\nThank you,\n[Your name]';
}
function codexSummary(c) {
  return codexStatus(c) + (c['DAMAGE TYPE'] && c['DAMAGE TYPE'] !== 'Not specified' ? '- **Damage type:** ' + c['DAMAGE TYPE'] + '\n' : '') +
    (c.history.length ? '\n\n**History:**\n' + c.history.map((h) => '- ' + h).join('\n') : '') +
    (c.NOTES ? '\n\n**Notes:** ' + c.NOTES : '');
}
const CODEX_CHIPS = {
  'What\'s the current status of this project?': codexStatus,
  'What steps are left to complete this project?': codexLeft,
  'Draft a professional follow-up email to the homeowner.': codexEmail,
  'Summarize everything that\'s happened on this project.': codexSummary
};
const CODEX_ACTIONS = [
  [/^Based on this roofing project data, generate a professional Scope of Work/, (c) =>
    '## Scope of Work\n\n**Project:** ' + (c.PROJECT || '') + '\n**Address:** ' + (c.ADDRESS || 'not set') + '\n\n' +
    '### Work Description\n- Remove the existing roofing down to the deck and inspect the decking.\n- Install underlayment, ice barrier where required, drip edge, and new shingles to the manufacturer\'s instructions.\n- Replace pipe boots and flashing as needed, and install ventilation as specified.\n- Clean up and haul away all debris; magnet-sweep the property.\n\n' +
    (c['ESTIMATE VALUE'] ? '### Price\n' + c['ESTIMATE VALUE'] + ', per the signed estimate.\n\n' : '') +
    '### Terms\nAs written in your signed contract.'],
  [/^Draft a professional follow-up email/, codexEmail],
  [/^Generate a pre-build checklist/, (c) =>
    '## Pre-Build Checklist: ' + (c.PROJECT || '') + '\n\n- [ ] Materials ordered and delivery date confirmed\n- [ ] Permit filed, if the city or county requires one\n- [ ] Crew scheduled, with a backup day for weather\n- [ ] Homeowner told the start date, what to move, and where the dumpster goes\n- [ ] Driveway, landscaping and attic protection planned\n- [ ] Fall protection and safety gear checked'],
  [/^Analyze this roofing project and suggest potential insurance supplement/, () => NOT_HERE],
  [/^Generate a complete job close-out summary/, (c) =>
    '## Close-Out Summary\n\n' + codexSummary(c) + '\n\n**For the homeowner:** keep this summary with your warranty paperwork, and call us after any major storm so we can take a look.'],
  [/^Generate a personalized review request/, (c) =>
    'Hi ' + first(c) + ', thank you for trusting us with your roof at ' + (c.ADDRESS || 'your home') + '! If you were happy with the work, would you leave us a quick review on Google or Facebook? It really helps a small local business. Thank you!']
];

function codexChat(req) {
  const c = ctxOf(req.system);
  if (!c.PROJECT && !c.STAGE) return 'Select a project above first.\n\n' + FOOT.codex;
  const fn = CODEX_CHIPS[lastUser(req).trim()];
  if (fn) return fn(c) + '\n\n' + FOOT.codex;
  return 'In the sample account Project Codex answers the four quick questions (the buttons below the chat) from this job\'s record.\n\n' + FOOT.codex;
}
function codexAction(req) {
  const text = lastUser(req);
  const hit = CODEX_ACTIONS.find(([re]) => re.test(text));
  if (!hit) return null;
  const c = ctxOf(text.split('Project data:\n')[1] || '');
  return hit[1](c) + '\n\n' + FOOT.codex;
}

/** The tool page's request, answered from sample content; null if it is not one of the three tools. */
export function answerTool(req) {
  const sys = String((req && req.system) || '');
  let text = null;
  if (/AI decision engine for roofing contractors/.test(sys)) text = decisionEngine(req);
  else if (/Project Codex AI assistant/.test(sys)) text = codexChat(req);
  else if (/expert roofing contractor assistant for NBD Pro/.test(sys)) text = codexAction(req);
  else if (/^You are an expert (insurance claims consultant|roofing technical consultant|roofing business consultant)\b/.test(sys)) text = understand(req);
  return text == null ? null : reply(text);
}

export const __test = { inputs, ctxOf, UNDERSTAND, CODEX_CHIPS };
