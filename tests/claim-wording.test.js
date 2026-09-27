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

// Claim / insurance context — most rules only fire inside it.
const CTX = /\b(claims?|insur\w*|adjusters?|carriers?|supplements?|scope|line items?)\b/i;
// Third parties who MAY lawfully negotiate for the insured.
const THIRD_PARTY = /\b(public adjusters?|attorneys?|lawyers?)\b/i;

const RULES = [
  { id: 'claims-specialist', why: '(1)(a)2.a claims specialist/expert',
    re: /\bclaims? (specialist|expert|expertise)s?\b/i },
  { id: 'insurance-specialist', why: '(1)(a)2.b insurance specialist/expert',
    re: /\binsurance(-| )(restoration |claims? |adjuster |)(specialist|specialty|expert|expertise)s?\b/i },
  { id: 'storm-specialist', why: '(1)(a)2 specialist framing next to insurance',
    re: /\b(storm|hail|restoration) specialists?\b/i, ctx: true },
  { id: 'handles-claim', why: '(1)(a)1 represent on the claim',
    re: /\b(I|we|Joe|he)( will|'ll| can)? (handle|handles|manage|manages|navigate|navigates|run|runs|take care of)( the| your| their| all the| the whole| the entire| your entire| the full)? (insurance( claims?| side| process)?|claims?( process)?)\b/i },
  { id: 'claim-handled', why: '(1)(a)1 represent on the claim',
    re: /\b(insurance|claims?) (claims? )?(handled|managed|navigated)\b/i },
  { id: 'handled-the-claim', why: '(1)(a)1 represent on the claim',
    re: /\b(handled|managed|navigated) (the|your|their) (insurance )?claim\b/i },
  { id: 'claim-for-you', why: '(1)(a)1 represent on the claim',
    re: /\b(handle|manage|navigate|file|files)\b[^.]{0,40}\bclaim\b[^.]{0,20}\bfor you\b/i },
  { id: 'negotiate', why: '(1)(a)1 negotiate on behalf of the insured',
    re: /\bnegotiat\w*/i, ctx: true, unless: THIRD_PARTY },
  { id: 'advocate', why: '(1)(a)1 represent on the claim',
    re: /\badvoca(te|tes|ting|cy)\b/i, ctx: true, unless: THIRD_PARTY },
  { id: 'on-your-behalf', why: '(1)(a)1 on behalf of the insured',
    // Narrower context than CTX: "guessing on your behalf" about a permit
    // scope is fine; "on your behalf" next to the carrier is not.
    re: /\bon (your|the homeowner'?s?|their) behalf\b/i, ctx: /\b(claims?|insur\w*|adjusters?|carriers?)\b/i, unless: THIRD_PARTY },
  { id: 'fight', why: '(1)(a)1 represent/negotiate against the insurer',
    re: /\b(I|we|Joe|he)( will|'ll| can)?\b[^.]{0,50}\b(fight|fights|push back|pushing back)\b/i, ctx: true },
  { id: 'files-claim', why: '(1)(a)1 contractor files the claim for the insured',
    re: /\b(I|we|Joe)( will|'ll)? (file|files) (the|your|a) (insurance )?claim\b|\b(I|we|Joe) (file|files) with your (carrier|insurer|insurance)/i },
  { id: 'work-with-insurer', why: '(1)(a)1 deals with the insurer for the insured',
    re: /\b(work|works|coordinate|coordinates|deal|deals)( directly)? with your (insurance company|carrier|insurer)\b/i },
  { id: 'claim-communication', why: '(1)(a)1 represent on the claim',
    re: /\b(handle|handles|handling) (all )?(the )?(communication|back-and-forth|adjuster communication)\b/i },
  // "advocate" above needs the claim word in the SAME sentence. "Homeowners
  // file without professional advocacy" (2026-09-27, hail-damage-wilmington)
  // had it one sentence earlier and passed. `near: true` checks the context
  // against the sentence plus its neighbours; third-party advice still passes.
  { id: 'advocacy-near-claim', why: '(1)(a)1 represent on the claim (claim context in an adjacent sentence)',
    re: /\badvoca(te|tes|ting|cy)\b/i, ctx: /\b(claims?|insur\w*|adjusters?)\b/i, near: true, unless: THIRD_PARTY },
  // Measuring the contractor's work against a public adjuster's frames it as
  // claim representation ("the same level of detail a public adjuster would
  // prepare", storm-damage-lebanon, 2026-09-27). Advice to HIRE one ("hire a
  // public adjuster to negotiate on your behalf") does not match this.
  { id: 'public-adjuster-would', why: '(1)(a)1 represent "as a public adjuster or otherwise"',
    re: /\bpublic adjusters? would\b/i },
  // Claim-filing help offered as a service (2026-09-27: 41 pages still read
  // "Insurance claim filing assistance — start through final payment",
  // "claim filing support", "Insurance claim assistance included"). Offering
  // to help file or run the claim is advertising to represent the insured;
  // the allowed line is "I document the damage and write the estimate; you
  // file, and I can meet the adjuster". A manufacturer WARRANTY claim is not
  // an insurance claim, so it passes.
  { id: 'claim-assistance', why: '(1)(a)1 advertise to represent (claim-filing help as a service)',
    re: /\bclaims?(-| )(filing )?(assistance|help|support|guidance)\b/i, unless: /\bwarranty\b/i },
  // "help you file", "help filing your claim", "assist with your insurance
  // claim", "Does Joe help with the insurance claim?". "An inspection helps
  // you decide whether to file" is advice and passes (the verb must be the
  // filing itself). "We file the claim" is files-claim above.
  { id: 'help-file-claim', why: '(1)(a)1 contractor helps file / assists with the claim',
    re: /\b(help|helps|helping|assist|assists|assisting)( you| homeowners| them| the homeowner)?( to)? (file|filing)\b|\b(help|helps|helping|assist|assists|assisting|assistance) (with|in) (filing|(your|the|a|their) (insurance )?claims?)\b/i,
    ctx: true, unless: THIRD_PARTY },
];

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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
