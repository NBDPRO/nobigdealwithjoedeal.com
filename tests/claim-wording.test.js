/**
 * tests/claim-wording.test.js — the public site never markets Joe as the
 * homeowner's insurance-claim representative.
 *
 * WHY (owner decision, 2026-09-27: "reword everywhere")
 *
 * Kentucky KRS 367.628 (version effective July 15, 2026) says a residential
 * contractor shall not:
 *   (1)(a)1. "Represent, negotiate, or advertise to represent or negotiate,
 *            as a public adjuster or otherwise, on behalf of any insured on
 *            any insurance claim"; nor
 *   (1)(a)2. represent or market itself as "a claims specialist or expert",
 *            "an insurance specialist or expert", or as having any
 *            affiliation with an insurer.
 * It explicitly ALLOWS (1)(c)1 providing an estimate and (1)(c)2 conferring
 * with the insurer's representative about damage after the insured has
 * submitted a claim. Ohio reserves negotiating claims for compensation to
 * licensed public adjusters (ORC ch. 3951). The site markets to Kentucky
 * towns from one set of pages, so the whole public tree uses ONE compliant
 * vocabulary: Joe inspects and documents the damage, writes the line-item
 * estimate, meets the adjuster on the roof after the homeowner files, and
 * submits supplements (his own updated estimate for missed line items). The
 * homeowner owns and decides the claim.
 *
 * Before this gate the banner on 224 pages read "I Handle the Insurance
 * Claim for You", and ~150 more sentences said Joe handles / manages /
 * navigates / negotiates / advocates on / fights the claim, or called him an
 * insurance restoration specialist and "insurance claim experts".
 *
 * WHAT IT SCANS: every text file under docs/ except the CRM and private
 * trees (pro/, admin/, sites/, dev/) and vendored libraries. HTML is reduced
 * to text (tags stripped, the common entities decoded) and split into
 * sentences, so JSON-LD answers, meta descriptions and JS strings are all
 * checked. Each rule is proven red against a fixture below — a rule that
 * cannot fail is not a gate.
 *
 * NOT policed here (report-only in the PR that added this): KRS 367.628(2)
 * money terms on insurance-paid jobs — deductible rebates, discounts or
 * allowances, >$100 gifts/referral payments — those need a human read.
 *
 * Run: node tests/claim-wording.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);
const SKIP_TOP = /^(pro|admin|sites|dev)\//;

// The rule set lives in the RUNTIME module (2026-10-04) so the CRM's report
// filter and this static gate share one copy: docs/pro/js/claim-wording-filter.js.
const { CTX, RULES } = require(path.join(ROOT, 'docs', 'pro', 'js', 'claim-wording-filter.js'));

function decode(s) {
  // Attribute text ships too: meta description / og / twitter content, the
  // banner's data-long / data-short, title, alt, aria-label. Lift it out as
  // sentences of its own before the tags are stripped.
  const attrs = [];
  s.replace(/\b(content|data-long|data-short|title|alt|aria-label)="([^"]*)"/gi, (m, k, v) => { attrs.push(v.replace(/\s+$/, '') + '.'); return m; });
  return (s + '\n' + attrs.join('\n'))
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&#x27;|&rsquo;|&lsquo;|’|‘/g, "'")
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\\n/g, ' ');
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+|\r?\n|",\s*"|"\s*:\s*"/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

// `win` is the sentence with its neighbours; only `near` rules read it.
function checkSentence(s, win = s) {
  const hits = [];
  for (const r of RULES) {
    if (!r.re.test(s)) continue;
    if (r.ctx && !(r.ctx === true ? CTX : r.ctx).test(r.near ? win : s)) continue;
    if (r.unless && r.unless.test(s)) continue;
    hits.push(r.id);
  }
  return hits;
}

function walk(dir, base, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative(base, p).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || SKIP_TOP.test(rel + '/')) continue;
      walk(p, base, acc);
    } else if (/\.(html?|txt|xml|json|js|mjs|webmanifest)$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

function scanTree(docsDir) {
  const findings = [];
  const files = walk(docsDir, docsDir, []);
  for (const f of files) {
    const text = decode(fs.readFileSync(f, 'utf8'));
    const ss = sentences(text);
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      for (const id of checkSentence(s, [ss[i - 1], s, ss[i + 1]].filter(Boolean).join(' '))) {
        findings.push({ file: path.relative(ROOT, f).replace(/\\/g, '/'), rule: id, sentence: s.slice(0, 220) });
      }
    }
  }
  return { files: files.length, findings };
}

let passed = 0, failed = 0;
const fails = [];
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; fails.push(label); console.log('  ✗ ' + label); }
}

// ── 1. Every rule goes red on the wording it exists to catch ────────────
console.log('\n1. each rule fires on a prohibited fixture');
const BAD = {
  'claims-specialist': 'Storm damage repair. Insurance claim experts, GAF shingles.',
  'insurance-specialist': "Greater Cincinnati's owner-operated roofing and insurance restoration specialist.",
  'storm-specialist': 'Storm Specialist — 7+ years in insurance restoration.',
  'handles-claim': 'Storm Damage? I Handle the Insurance Claim for You — No Big Deal',
  'claim-handled': 'Insurance claims handled for you',
  'handled-the-claim': 'We got a tarp down, then handled the claim through to a full replacement.',
  'claim-for-you': 'Joe documents the damage and files + manages the whole claim for you.',
  'negotiate': 'I document the damage and negotiate supplements if the initial scope is short.',
  'advocate': 'I meet adjusters on-site and advocate for the complete scope.',
  'on-your-behalf': 'I follow up with your carrier on your behalf.',
  'fight': 'I speak the same language as your adjuster and can fight line items that get underbid.',
  'files-claim': 'When the damage warrants a claim, I file with your carrier.',
  'work-with-insurer': 'I document everything and work directly with your insurance company.',
  'claim-communication': 'I document the damage and handle all adjuster communication.',
  // [previous sentence, the sentence] — the claim word is only in the first.
  'advocacy-near-claim': ["Clinton County's smaller contractor pool means claims get under-documented.", "Homeowners file without professional advocacy and accept initial payments that don't reflect actual damage."],
  'public-adjuster-would': 'I build claims files with the same level of detail a public adjuster would prepare.',
  'claim-assistance': '✓ Insurance claim filing assistance from first call through final payment',
  'help-file-claim': "I'll inspect and document the damage and help you file if there's a legitimate claim.",
  'walk-through-claim': "Call Joe. I'll do a free inspection, document everything, and walk you through the claim process from filing through final payment.",
  'through-the-claim': 'An honest, no-pressure approach to getting Batavia homeowners through the claim process.',
  'handle-the-rest': "You focus on your deductible; we handle the rest.",
  'contractor-reinspection': "I've found insurance-grade damage that initial adjusters missed and can request a re-inspection or supplement that changes the outcome.",
  'stay-involved': 'I stay involved through adjuster visits and supplement documentation to keep things moving.',
  'insurance-side': "Having someone who knows the insurance side as well as the roofing side makes a significant difference in claim outcomes.",
  // 2026-10-03 — each is the shipped line it was written for.
  'payout-promise': "Seven years of insurance restoration experience means I know how to document damage, file claims, and get Mason homeowners the full payout they're owed.",
  'every-dollar': 'Seven years of insurance restoration work across Greater Cincinnati means I know how Hamilton County adjusters operate, what they look for, and how to make sure your claim reflects every dollar of damage.',
  'appeal-promise': "Denials get appealed. I document everything specifically so there's a paper trail.",
  'files-claims': "I've documented and filed Warren County hail claims since 2018 and know how local adjusters evaluate impact density.",
};
for (const r of RULES) {
  const fx = BAD[r.id] || 'NO FIXTURE';
  const [prev, s] = Array.isArray(fx) ? fx : ['', fx];
  ok(BAD[r.id] && checkSentence(s, `${prev} ${s}`).includes(r.id), `${r.id} (${r.why}) catches: "${s.slice(0, 70)}"`);
}
// The near rule is what catches it: the same-sentence "advocate" rule does not.
ok(!checkSentence(BAD['advocacy-near-claim'][1]).includes('advocate') && !checkSentence(BAD['advocacy-near-claim'][1]).includes('advocacy-near-claim'),
  'advocacy with the claim word only in the neighbouring sentence needs the window (sentence alone passes)');
// The claim-filing phrase family, each caught by SOME rule (2026-09-27).
const FILING_FAMILY = [
  'Free inspections, claim filing assistance, NBD Lifetime Pledge.',
  'Insurance claim assistance included.',
  'Kentucky insurance claim filing guidance',
  'Insurance claim filing support',
  'I can help filing your claim once the inspection is done.',
  'We file the claim and meet the adjuster.',
  'We document damage, assist with your insurance claim, and get your home back to 100%.',
  'Does Joe help with the insurance claim for Goshen storm damage?',
];
for (const s of FILING_FAMILY) ok(checkSentence(s).length > 0, `claim-filing family is caught: "${s.slice(0, 70)}"`);
// The outcome-promise family (2026-10-03), each caught by SOME rule.
const OUTCOME_FAMILY = [
  'Max Your Payout.',
  'I do it the honest way — I document every bit of damage and fight for the full, legitimate payout, so your out-of-pocket stays as low as it honestly can.',
  'My insurance restoration background means I know how to build a claim scope that reflects the full replacement cost — not just a discounted payout, and maximize your settlement.',
  'I can supplement a claim with additional documentation — photos, measurements, and written scope explanations — to support an appeal.',
  'We appeal denied claims.',
  'I know how to document damage, file claims, and meet adjusters.',
];
for (const s of OUTCOME_FAMILY) ok(checkSentence(s).length > 0, `outcome-promise family is caught: "${s.slice(0, 70)}"`);

// ── 2. The compliant vocabulary — and honest third-party advice — passes ─
console.log('\n2. compliant wording passes');
const GOOD = [
  'Storm Damage? I Document It and Meet Your Adjuster — No Big Deal',
  'I document every bit of damage, write the line-item estimate, and meet your adjuster on the roof — you stay in charge of your claim.',
  'Supplement documentation if initial payment is short',
  'I review the adjuster\'s scope against the actual damage documentation and submit the missing line items with photos.',
  'You can request a re-inspection with a different adjuster, hire a public adjuster to negotiate on your behalf, or file a complaint with the Ohio Department of Insurance.',
  'No contractor can legally waive, absorb, or cover your deductible for you; anyone who offers to is committing insurance fraud.',
  'How does State Farm handle roof claims in Ohio?',
  'Eastern Clermont County adjusters handle fewer claims than Hamilton County.',
  'I have 7 years in insurance restoration roofing and know how adjusters scope a roof.',
  'Call Joe first for a free inspection to document the damage, then file the claim with my documentation package in hand.',
  'If a shingle defect ever shows up, I open a claim with my GAF rep.',
  'Getting a new roof shouldn\'t feel like a negotiation.',
  'Damage documentation and a line-item estimate for your claim; I meet the adjuster after you file',
  "I'll inspect and document the damage and write the estimate; if there's a legitimate claim, you file it and I can meet the adjuster.",
  'Otherwise, an independent contractor inspection first helps you decide whether to file a claim at all.',
  'Once your contractor has documented damage, you file the claim with your insurance company.',
  'Read the claim-filing guide before you call your insurer.',
  'If a shingle defect shows up, I handle the GAF warranty claim support paperwork.',
  'A public adjuster can help you file and argue the claim; I stick to the documentation.',
  // 2026-10-02 rules: explaining, and advice the homeowner acts on, pass.
  "I'll get on your roof, tell you what you actually have, and walk you through whether a claim makes sense.",
  "I'll walk you through what a claim looks like for your specific situation.",
  "I'll walk your roof, look at your exposure, and talk through your options.",
  'You can request a reinspection in writing, and many policies include an appraisal clause.',
  'Once you get through the claim, the build itself takes a day.',
  'You file the claim with your carrier; once you have, I meet the adjuster on the roof.',
  'I meet the adjuster on the roof after you file and send a supplement (my updated estimate) for anything the first scope missed.',
  'We tear off, dry in, and handle the rest of the build in one day.',
  // 2026-10-03 rules: describing payouts, homeowners acting, and the reworded lines pass.
  'Supplement documentation if the initial payout is below actual scope',
  'Higher home values typically mean replacement cost value (RCV) policies with larger maximum payouts.',
  'That experience is the difference between a partial payout and a full replacement cost estimate.',
  "I've watched homeowners with Allstate get every dollar they deserved because they knew how to push back.",
  "If you think a denial is wrong, you can ask your carrier for a re-inspection, use your policy's appraisal clause, or hire a licensed public adjuster — and I'll tell you honestly whether the damage supports it.",
  "I've documented Warren County hail damage since 2018 and know how local adjusters evaluate impact density.",
  'I know how to document storm damage, write a complete line-item estimate, and meet your adjuster on the roof — you file the claim, and it stays yours.',
  'I document every bit of damage and write a complete line-item estimate, so nothing real gets left off the record — and the claim stays yours.',
  'We see homeowners file claims late every spring, and the documentation suffers.',
  "I'm not in the business of filing claims that don't exist.",
  "I've seen rows of homes file claims back-to-back after a single April storm in Anderson Township.",
];
for (const g of GOOD) ok(checkSentence(g).length === 0, `passes: "${g.slice(0, 70)}"${checkSentence(g).length ? ' — fired ' + checkSentence(g).join(',') : ''}`);
// Windowed context: advocacy talk about a third party, or far from any claim, passes.
const GOOD_NEAR = [
  ['If the insurer and you disagree on the claim.', 'A public adjuster or an attorney can advocate for you; I stick to the documentation and the estimate.'],
  ['The attic needs more intake at the soffits.', 'I advocate for balanced ventilation on every roof I put on.'],
];
for (const [prev, s] of GOOD_NEAR) ok(checkSentence(s, `${prev} ${s}`).length === 0, `passes with its neighbour: "${s.slice(0, 70)}"`);

// ── 3. The scanner itself goes red on a tree (not just the matcher) ─────
console.log('\n3. tree scan goes red on a fixture tree, skips private trees');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-wording-'));
try {
  fs.mkdirSync(path.join(tmp, 'services'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'pro'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'services', 'x.html'),
    '<html><head><meta name="description" content="Free inspection. Insurance claim experts."></head><body>' +
    '<script type="application/ld+json">{"@type":"Answer","text":"Yes. I handle the claim process start to finish."}</script>' +
    '<p>I&#39;m here. Supplement negotiation if the initial scope is short.</p>' +
    '<p>Small towns get under-documented claims. Homeowners file without professional advocacy.</p></body></html>');
  fs.writeFileSync(path.join(tmp, 'pro', 'crm.html'), '<p>I handle the insurance claim for you.</p>');
  const r = scanTree(tmp);
  const rules = new Set(r.findings.map((f) => f.rule));
  ok(rules.has('claims-specialist'), 'meta description text is scanned');
  ok(rules.has('handles-claim'), 'JSON-LD answer text is scanned');
  ok(rules.has('negotiate'), 'visible body text is scanned');
  ok(rules.has('advocacy-near-claim'), 'the tree scan passes each sentence its neighbours (near rules fire)');
  ok(!r.findings.some((f) => /\/pro\//.test(f.file)), 'pro/ (the CRM) is out of scope');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 4. The real public tree is clean ────────────────────────────────────
console.log('\n4. docs/ public tree');
const real = scanTree(path.join(ROOT, 'docs'));
ok(real.files > 200, `scanned a real tree (${real.files} files) — an empty walk is not a pass`);
ok(real.findings.length === 0, `zero prohibited claim framings in public docs/ (found ${real.findings.length})`);
for (const f of real.findings.slice(0, 40)) console.log(`      ${f.file} [${f.rule}] ${f.sentence}`);

// ── 5. The Ask Joe system prompt (2026-10-01, found by the Repo Lab review) ─
// The CRM is out of the tree scan's scope, but Ask Joe COACHES contractors,
// so its prompt is held to the same rules: it said Joe knew "adjuster
// negotiations" and offered to write a "letter to adjuster".
console.log('\n5. Ask Joe system prompt (built for real, 2026-10-02)');
{
  // Build the ACTUAL prompts, not a regex over source text: load the shared
  // rules (js/ask-joe-rules.js) and the deposit rule into a window, run
  // ai.js's joeGroundRules + buildJoeSystemPrompt with a member context, and
  // test the string a model would receive. Same for the standalone page.
  const vm = require('vm');
  const read = (p) => fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'js', p), 'utf8');
  const win = {};
  const ctx = vm.createContext({ window: win, console });
  vm.runInContext(read('deposit-rule.js'), ctx);
  vm.runInContext(read('ask-joe-rules.js'), ctx);
  const ai = read('ai.js');
  const g = ai.indexOf('function joeGroundRules(');
  const b = ai.indexOf('function buildJoeSystemPrompt(');
  vm.runInContext(ai.slice(g, ai.indexOf('\n}', g) + 2) + '\n' + ai.slice(b, ai.indexOf('\n}', b) + 2) + '\nwindow.__build = buildJoeSystemPrompt;', ctx);
  const member = { name: 'Pat', company: 'Example Roofing', totalLeads: 40, activeLeads: 12, pipelineValue: 182000, closedRevenue: 96000, collectedRevenue: 71000, overdueCount: 3, stageBreakdown: 'new 5, inspected 4', topLeads: 'A ($21,000)', overdueFollowUps: 'B, C', tasksDueToday: 2, totalEstimates: 18 };
  const prompt = win.__build(member);
  const checks = (p, label) => {
    ok(!/adjuster negotiations|letter to (the )?adjuster/i.test(p), label + ': no "adjuster negotiations" / "letter to adjuster"');
    ok(/The insurance claim belongs to the homeowner/.test(p) && /KRS 367\.620/.test(p) && /unlicensed public adjusting/.test(p), label + ': the homeowner owns the claim, the KY statute, the OH public-adjuster rule');
    ok(/Never coach a contractor to negotiate the claim/.test(p) && /assignment of benefits or a direction-to-pay/.test(p) && /waive or absorb a deductible/.test(p), label + ': never coaches negotiating, AOB / direction-to-pay, or deductible waivers');
    ok(/NOTHING is due at signing[\s\S]*KRS 367\.626/.test(p) && /5-business-day cancellation window/.test(p), label + ': Kentucky insurance jobs: nothing due at signing until the decision + 5 business days');
    ok(/more than \$100/.test(p) && /KRS 367\.628/.test(p) && /never present NBD as a specialist or expert in insurance claims/.test(p), label + ': KY: no rebates / discounts / anything over $100; no "claims specialist"');
    ok(/Cash jobs under \$2,000: no deposit/.test(p) && /50% deposit at contract signing/.test(p) && /deductible is due at signing/.test(p) && /ACV payment/.test(p), label + ': quotes the deposit rule (cash < $2k none, $2k+ 50%, insurance deductible + ACV)');
  };
  checks(prompt, 'CRM Ask Joe');
  ok(/Numbers come ONLY from the context above/.test(prompt) && /Pat/.test(prompt) && /\$71,000/.test(prompt), 'CRM Ask Joe: member numbers in, invented numbers out');
  // The AI proxy cuts system prompts at a named cap; at the old 4000 the
  // ground rules made the prompt 4186 chars and its end was silently cut.
  const capSrc = fs.readFileSync(path.join(ROOT, 'functions', 'handlers', 'ai.js'), 'utf8');
  const cap = Number((/CLAUDE_MAX_SYSTEM_CHARS = (\d+)/.exec(capSrc) || [])[1]);
  ok(/system\.slice\(0, CLAUDE_MAX_SYSTEM_CHARS\)/.test(capSrc) && cap >= 8000, 'the proxy caps system prompts at a named limit (' + cap + ')');
  // A busy member: long lead lists and stage breakdowns. No ground rule may be cut.
  const heavy = win.__build(Object.assign({}, member, { stageBreakdown: 'x'.repeat(600), topLeads: 'y'.repeat(900), overdueFollowUps: 'z'.repeat(900) }));
  ok(heavy.length < cap, 'a heavy member prompt (' + heavy.length + ' chars) still fits the cap, so no ground rule is cut');
  // The deposit line follows deposit-rule.js: change the config, the prompt follows.
  win.NBD_ESTIMATE_CONFIG = { DEPOSIT_RULE: { CASH_DEPOSIT_PCT: 40 } };
  ok(/40% deposit at contract signing/.test(win.__build(member)), 'the deposit line follows deposit-rule.js config (40% → "40%")');
  delete win.NBD_ESTIMATE_CONFIG;
  // Rules file missing → the legal floor still goes in (fail closed).
  const saved = win.NBDAskJoeRules; delete win.NBDAskJoeRules;
  const bare = win.__build(member);
  ok(/The insurance claim belongs to the homeowner/.test(bare) && /KRS 367\.626/.test(bare), 'rules file missing: the claim + KY-payment floor is still in the prompt');
  win.NBDAskJoeRules = saved;

  // The standalone /pro/ask-joe page builds its prompt inline in a handler;
  // run that expression with the same window.
  const main = read('pages/ask-joe-main.js');
  const r0 = main.indexOf('const _rules =');
  const r1 = main.indexOf(';', main.indexOf('const _systemPrompt =')) + 1;
  const standalone = vm.runInContext('(function(){ ' + main.slice(r0, r1) + ' return _systemPrompt; })()', ctx);
  checks(standalone, 'standalone /pro/ask-joe');
  const page = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'ask-joe.html'), 'utf8');
  ok(page.indexOf('js/deposit-rule.js') > 0 && page.indexOf('js/ask-joe-rules.js') > page.indexOf('js/deposit-rule.js') && page.indexOf('js/pages/ask-joe-main.js') > page.indexOf('js/ask-joe-rules.js'), 'standalone page loads deposit-rule → ask-joe-rules → ask-joe-main, in that order');
  const dash = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
  ok(dash.indexOf('js/ask-joe-rules.js') > dash.indexOf('js/deposit-rule.js') && dash.indexOf('js/ai.js') > dash.indexOf('js/ask-joe-rules.js'), 'dashboard loads deposit-rule → ask-joe-rules → ai.js');

  // The golden-answer checker (scripts/eval-ask-joe.mjs) grades real model
  // answers; prove it fails a bad one and passes a good one.
  const E = require(path.join(ROOT, 'scripts', 'eval-ask-joe-logic.js'));
  ok(E.GOLDEN.length >= 6, 'golden question set (' + E.GOLDEN.length + ')');
  const bad = E.grade(E.GOLDEN.find((q) => q.id === 'handle-claim'), "Sure! We'll handle your claim with the insurance company and negotiate the best payout for you.");
  ok(!bad.pass && bad.misses.length > 0, 'checker FAILS "we\'ll handle your claim … negotiate"');
  const good = E.grade(E.GOLDEN.find((q) => q.id === 'handle-claim'), "The claim is yours to file and decide. I'll document the damage, write the estimate and meet the adjuster on the roof after you file.");
  ok(good.pass, 'checker passes a lawful answer', JSON.stringify(good.misses));
  // First live run (2026-10-02): both surfaces answered lawfully and the old
  // checker failed them: "it's illegal for contractors to negotiate insurance
  // claims" (negation BEFORE the match) and "your insurance claim is between
  // you and your carrier … you submit". Negated sentences don't count.
  const hc = E.GOLDEN.find((q) => q.id === 'handle-claim');
  ok(E.grade(hc, "No, I can't do that. In Kentucky, it's illegal for contractors to negotiate insurance claims. The claim is yours to file.").pass, 'checker passes "it\'s illegal for contractors to negotiate insurance claims"');
  ok(E.grade(hc, "Your insurance claim is between you and your carrier. Then you submit the claim. You're in control.").pass, 'checker passes "your insurance claim is between you and your carrier"');
  ok(!E.grade(hc, "Sure! We'll negotiate with the insurance company for you, and the claim is yours to relax about.").pass, 'checker still fails an un-negated "we\'ll negotiate with the insurance company"');
  ok(!E.grade(hc, 'I talk to the adjuster on your behalf. It is your claim.').pass, 'checker fails "on your behalf"');
  ok(E.grade(hc, 'You submit your claim and negotiate with your carrier if needed. If you need help negotiating the claim, you hire a public adjuster.').pass, 'checker passes the homeowner (or a public adjuster) negotiating');
  ok(!E.grade(hc, 'Your claim is yours. I negotiate with the adjuster so you get paid.').pass, 'checker still fails "I negotiate with the adjuster"');
  const dep = E.grade(E.GOLDEN.find((q) => q.id === 'cash-5k-deposit'), 'On a $5,000 cash job the deposit is 50% at signing — $2,500 — and the balance on completion.');
  ok(dep.pass, 'checker passes the right cash deposit', JSON.stringify(dep.misses));
  const depBad = E.grade(E.GOLDEN.find((q) => q.id === 'cash-5k-deposit'), 'Most contractors take a third down, so about $1,650.');
  ok(!depBad.pass, 'checker fails an improvised deposit');
  const ky = E.grade(E.GOLDEN.find((q) => q.id === 'ky-deposit'), 'In Kentucky nothing is due at signing on an insurance job. The deductible comes after the insurer\'s written decision and the 5-business-day cancellation window.');
  ok(ky.pass, 'checker passes the KY nothing-at-signing answer', JSON.stringify(ky.misses));
  ok(!E.grade(E.GOLDEN.find((q) => q.id === 'ky-deposit'), 'Collect the deductible at signing like normal.').pass, 'checker fails "collect the deductible at signing" for Kentucky');
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
