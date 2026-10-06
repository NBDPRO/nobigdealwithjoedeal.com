/**
 * tests/pro-claims-honesty-2026-09-13.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * A 2026-09-13 evaluation of an outside audit (jdealtia-sys/nbd-audits-2026)
 * found roughly fifteen /pro marketing and in-app strings that claimed
 * something the code does not do — the same class of bug #1501 fixed on
 * 2026-09-08 with no regression test, which is why several of these (the
 * Starter "exact setup" line, the Growth-only trial FAQ, "9 e-sign ready")
 * had drifted back to false since. This pins both directions: the corrected
 * string is present, and the false string it replaced does not reappear
 * anywhere in the shipped tree. Absence-only would pass vacuously if a
 * rewrite dropped the sentence instead of fixing it; presence-only would
 * miss a partial revert. Both, on every published file, catches both.
 *
 * Pure-Node, zero-dep. Run: node tests/pro-claims-honesty-2026-09-13.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Walk every published file once so "does the false string appear ANYWHERE
// under docs/" is a real sweep, not a per-file spot check.
function walk(dir, out) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walk(p, out);
    else if (/\.(html|js)$/.test(name.name)) out.push(p);
  }
}
const PUBLISHED = [];
walk(DOCS, PUBLISHED);
function countAcross(needle) {
  let n = 0;
  for (const f of PUBLISHED) {
    const src = fs.readFileSync(f, 'utf8');
    if (src.includes(needle)) n += src.split(needle).length - 1;
  }
  return n;
}

console.log('\nSTARTER exact-setup claim — Joe is structurally never on Starter (owner claim bypasses every cap)');
{
  ok('pricing.html no longer claims Starter is literally the setup Joe runs on',
     countAcross('The exact setup I run my business on every day') === 0);
  ok('index.html no longer claims it in the third person either',
     countAcross('The exact setup Joe runs his business on every day') === 0);
  ok('pricing.html carries the honest replacement', read('docs/pro/pricing.html').includes('The same tools I run NBD on every day.'));
  ok('index.html carries the honest replacement', read('docs/pro/index.html').includes('The same tools Joe runs NBD on every day.'));
}

console.log('\nTRIAL — Team AND Growth get 14 days (functions/stripe.js grants both); Starter has none');
{
  const stripe = read('functions/stripe.js');
  const idx = stripe.indexOf('trial_period_days');
  ok('code truth: trial_period_days:14 is still gated on team/growth',
     idx >= 0 && /trial_period_days:\s*14/.test(stripe) && /team/i.test(stripe.slice(Math.max(0, idx - 400), idx)) && /growth/i.test(stripe.slice(Math.max(0, idx - 400), idx)));
  ok('pricing.html FAQ no longer says only Growth gets the trial',
     countAcross('Start the Growth plan and your first 14 days are free') === 0);
  ok('pricing.html FAQ names both tiers and the card-up-front truth', /Team and Growth both start with 14 free days/.test(read('docs/pro/pricing.html')));
  ok('demo.html no longer says "14-day free trial on Growth" alone',
     countAcross('14-day free trial on Growth</div>') === 0);
}

console.log('\nE-SIGN — 3 of 25 doc types ship a default signer block; links expire in 14 days (functions/esign-envelope.js TTL_DAYS)');
{
  // TTL_DAYS moved to esign-io.js (2026-10-04) — shared by the envelope
  // functions and the reminder sweep.
  const ttl = read('functions/esign-io.js');
  const m = ttl.match(/const TTL_DAYS\s*=\s*(\d+)/);
  ok('code truth: TTL_DAYS is still 14 (this test needs updating if that ever changes)', m && m[1] === '14');
  ok('demo.html no longer says 9 are e-sign ready', countAcross('9 e-sign ready with homeowner') === 0);
  ok('demo.html no longer says links expire after 7 days', countAcross('expire after 7 days') === 0);
  ok("demo.html matches index.html's already-corrected count", read('docs/pro/demo.html').includes('3 e-sign ready out of the box'));
  ok('demo.html states the real TTL', read('docs/pro/demo.html').includes('expire after 14 days'));
}

// 2026-10-04: the 09-13 fix said texts "send and receive on a shared NBD Pro
// number today". Also false — Twilio is a trial account with no A2P
// registration and delivered zero texts in 45 days. Texting is "coming soon".
console.log('\nA2P — texting is coming soon: no A2P registration, so no texts deliver today (shared number included)');
{
  ok('demo.html mockup no longer implies A2P is a one-time, already-available toggle',
     !/SMS delivery activates with one-time carrier \(A2P\) registration\.<\/div>/.test(read('docs/pro/demo.html')));
  ok('no public page claims texts send on a shared NBD Pro number today',
     countAcross('shared NBD Pro number') === 0);
  ok('demo.html says texting is coming soon', /Texting: coming soon/.test(read('docs/pro/demo.html')));
  ok('index.html says texting is coming soon', /Texting: coming soon/.test(read('docs/pro/index.html')));
}

console.log('\nLEGAL (2026-10-04) — no AOB on the public Pro pages; the FAQ never manages claims or coordinates adjusters');
{
  const PUB = ['index', 'pricing', 'register', 'how-to', 'demo'].map((p) => read('docs/pro/' + p + '.html'));
  ok('no "AOBs" in a public Pro page feature list', PUB.every((s) => !/\bAOBs\b/.test(s)));
  ok('how-to no longer lists AOB as a document', !/AOB, contracts, supplement letters/.test(PUB[3]));
  ok('the "claims management, adjuster coordination" FAQ answer is gone', countAcross('claims management, adjuster coordination') === 0);
  const idx = PUB[0];
  const faq = "line-item estimates that document the damage and the paperwork for the homeowner's own claim, which the homeowner files and decides";
  ok('the reworded FAQ is in BOTH the visible answer and the JSON-LD mirror', idx.split(faq).length - 1 === 2);
  // 2026-10-05: the document COUNT is pinned by the LANDING docs check (the
  // three generator files VM-loaded, 33 types after #2141). This one keeps AOB
  // out of the base generator and the stale "25" claim off the page.
  ok('no AOB document type, and the stale "25 branded document types" claim is gone',
     (() => {
       const g = read('docs/pro/js/document-generator.js');
       const a = g.indexOf('DOCUMENT_TYPES: {');
       const body = g.slice(a, g.indexOf('\n  },', a));
       const n = (body.match(/^\s{4}[a-zA-Z_]+:\s+\{ name:/gm) || []).length;
       return n > 0 && !/assignment_of_benefits:\s+\{/.test(body) && !/25 branded document types/.test(idx);
     })());
  // 2026-10-04: the hand-drawn storm mockup is gone with the rebuild; every
  // screen is a real capture. 2026-10-05: every capture sits inside a
  // <figure> whose caption says sample data (the hero's computer + phone
  // share one caption).
  const imgs = (idx.match(/<img\b[^>]*>/g) || []).length;
  const figs = idx.match(/<figure\b[\s\S]*?<\/figure>/g) || [];
  const inFigs = figs.reduce((n, fg) => n + (fg.match(/<img\b/g) || []).length, 0);
  ok('every capture on /pro is in a figure captioned "sample data"',
     imgs >= 8 && inFigs === imgs && figs.every((fg) => /<figcaption class="pl-cap">[^<]*sample data<\/figcaption>/.test(fg)),
     figs.length + ' figures, ' + inFigs + '/' + imgs + ' images');
  ok('pricing.html has no dashboard link for logged-out visitors', !/>Back to Dashboard</.test(PUB[1]));
}

console.log("\nDEMO ACCOUNT — login.html no longer calls seeded sample data 'real'");
{
  ok('false claim gone', countAcross('Live lead pipeline with real data') === 0);
  ok('honest replacement present', read('docs/pro/login.html').includes('Live lead pipeline with sample data'));
}

console.log('\nSIGNING — how-to.html no longer promises an auto-advance + push that no handler performs');
{
  const howto = read('docs/pro/how-to.html');
  ok('no longer claims the stage auto-advances on signature', !/stage auto-advances to <strong>Contract Signed/.test(howto));
  ok('no longer claims a push notification fires', !/You get a push notification and a toast\.<\/li>/.test(howto));
}

console.log('\nPROPERTY INTEL — in-app spinners no longer claim a live county-records lookup (Regrid is stubbed for non-owners)');
{
  ok('no "Looking up county records" strings remain anywhere under docs/',
     countAcross('Looking up county records...') === 0);
  ok('no "Fetching county records" strings remain anywhere under docs/',
     countAcross('Fetching county records...') === 0);
  ok('register.html Property Intel tile no longer promises a live pull "from county records"',
     !/from county records at any address\.<\/div>/.test(read('docs/pro/register.html')));
  ok('D2D verify tooltip no longer claims a county-records check',
     !read('docs/pro/js/d2d-tracker-ui-2026b.js').includes('against Google + county records'));
}

console.log("\nCAP MODAL — enforceGate hard-blocks new leads at 100%; the modal must say so, not promise no lockout");
{
  const bg = read('docs/pro/js/billing-gate.js');
  ok('module header documents the real gate behaviour', bg.includes('Leads: warns at 80%; at 100% new-lead creation is blocked client-side'));
  ok("the \"we won't lock you out mid-cycle\" promise is gone", !bg.includes("we won't lock you out mid-cycle"));
  ok('the cap modal states leads pause, not "no lockout"', bg.includes('New leads pause until you upgrade or your cycle resets'));
}

console.log('\nSANDBOX TIERS — relabeled to the live Standard/Preferred/Elite lifetime model (#1529), not the retired 10/15/25-yr one');
{
  const sb = read('docs/pro/sandbox.html');
  ok('no 10-yr/15-yr/25-yr workmanship chips remain', !/\d+-yr workmanship|ridge vent · 15-yr|full ice &amp; water · 25-yr/.test(sb));
  ok('chips now read Standard/Preferred/Elite', sb.includes('<h4>Standard</h4>') && sb.includes('<h4>Preferred</h4>') && sb.includes('<h4>Elite</h4>'));
  ok("chips claim lifetime workmanship, matching how-to.html's tier table", (sb.match(/lifetime/gi) || []).length >= 3);
}

console.log('\nESX EXPORT — the fake "Xactimate Export (ESX)" button is gone; the drawing tool no longer implies it produces a real ESX file');
{
  const dash = read('docs/pro/dashboard.html');
  ok('the ESX button is removed from the drawing-tool panel', !dash.includes('data-fn="exportXactimateESX"'));
  ok('an honest disclosure line replaces it', dash.includes('Carrier estimates stay in Xactimate'));
  const maps = read('docs/pro/js/maps-routing.js');
  ok('the underlying function is left in place (frozen, not deleted — no JS file churn)', maps.includes('function exportXactimateESX()'));
}

console.log('\nPRICING META — the search/share description matches the Team+Growth-only trial (2026-09-24)');
{
  // functions/stripe.js grants trial_period_days:14 to team and growth only,
  // and the FAQ + Terms say so. The <meta> description and og:description
  // listed Starter with them "each with a 14-day free trial" — the one line
  // Google and link previews show, promising Starter a trial checkout never gives.
  const pr = read('docs/pro/pricing.html');
  const metas = (pr.match(/<meta (?:name="description"|property="og:description") content="[^"]*"/g) || []);
  ok('both pricing descriptions are present', metas.length === 2);
  ok('neither description says every plan gets the trial',
    metas.every(m => !/each with a 14-day/i.test(m)));
  ok('both descriptions scope the trial to Team and Growth',
    metas.every(m => /14-day free trial on Team and Growth/.test(m)));
  ok('the checkout code still limits the trial to team + growth (the fact the copy tracks)',
    /normalizedPlan === 'growth' \|\| normalizedPlan === 'team'\) \? \{\s*subscription_data: \{ trial_period_days: 14 \}/.test(read('functions/stripe.js')));
}

// ── LANDING 2026-10-04 ─────────────────────────────────────────────────
// The /pro rebuild makes one claim per section. Each check below pins the
// sentence on the page AND the code that makes it true, so a refactor that
// removes the feature (or a copy edit that inflates it) goes red here.
console.log('\nLANDING (2026-10-04) — every /pro section claim is tied to the code behind it');
{
  const idx = read('docs/pro/index.html');
  const pricing = read('docs/pro/pricing.html');
  const register = read('docs/pro/register.html');
  const has = (re) => re.test(idx);
  const code = (rel, needle) => fs.existsSync(path.join(ROOT, rel)) && read(rel).includes(needle);
  const tie = (label, claimRe, rel, needle) => ok(label, has(claimRe) && code(rel, needle),
    (has(claimRe) ? '' : 'claim missing on /pro; ') + (code(rel, needle) ? '' : 'code anchor missing: ' + rel + ' → ' + needle));

  // 01 the job moves itself — the job spine's event table moves the card.
  const spine = read('functions/job-spine-logic.js');
  ok('01 job moves itself: the claimed events all move a stage in EVENT_TABLE',
    has(/The job moves itself\./) && ['booked:', 'estimate_shared:', 'contract_signed:', 'deposit_paid:', 'paid_in_full:']
      .every((k) => new RegExp('\\n  ' + k + '\\s+row\\(\'').test(spine)));
  ok('01 does not claim the events nothing sends yet (inspected / scheduled / installed)',
    !/(inspection is done|crew is scheduled|install is complete) moves/i.test(idx));
  // 02 follow-ups
  tie('02 who needs you: estimate follow-up buckets (2, 5, 10+ days)', /out 2, 5 or 10\+ days/, 'docs/pro/js/estimate-followups.js', 'function bucketFor');
  tie('02 who needs you: "no next step" list', /no next step at all/, 'docs/pro/js/no-next-step.js', 'Counts PEOPLE, not docs');
  // 03 estimates
  tie('03 the V3 wizard is the default estimate builder', /estimate wizard asks one thing per screen/, 'docs/pro/js/estimate-v3-wizard.js', 'V3 is what opens by default');
  tie('03 five packages, Economy to Beyond', /Five packages, Economy to Beyond/, 'docs/pro/js/estimate-config.js', "TIER_ORDER: Object.freeze(['economy', 'good', 'better', 'best', 'beyond'])");
  tie('03 open alert covers estimate, portal and signing link', /alert when the homeowner opens the estimate, portal or signing link/, 'functions/estimate-view-alert.js', "const SOURCES = ['portal', 'review_link', 'deal_room', 'remote_sign'];");
  tie('03 signing links expire after 14 days', /Signing links expire after 14 days/, 'functions/esign-io.js', 'const TTL_DAYS = 14');
  // 04 getting paid
  ok('04 every recorded-payment method named on /pro exists in the Record Payment sheet',
    has(/Log a check, cash, Zelle or a bank transfer/) && ["key: 'check'", "key: 'zelle'", "key: 'cash'", "key: 'ach'"].every((k) => code('docs/pro/js/invoice-pipeline.js', k)));
  ok('04 the deposit rule on /pro is the one in deposit-rule.js ($2,000 / 50%)',
    has(/none on cash jobs under \$2,000, 50% at signing from \$2,000 up/)
      && code('docs/pro/js/deposit-rule.js', 'CASH_NO_DEPOSIT_UNDER_CENTS: 200000') && code('docs/pro/js/deposit-rule.js', 'CASH_DEPOSIT_PCT: 50'));
  ok('04 online ACH is not claimed (only "once activated" in Stripe)', !/pay (by|with) ACH online|online ACH/i.test(idx));
  ok('04 receipts are not claimed as emailed (the receipt PDF is NBD-only and not emailed)', !/receipt[s]? (is |are )?emailed|emails? (a |the )?receipt/i.test(idx));
  // 05 portal — the 9-step tracker (#2130). Step names come from the ONE
  // copy constant, loaded (not regexed), so a renamed step goes red here.
  {
    const HP = require(path.join(ROOT, 'functions/homeowner-progress.js'));
    const labels = HP.HOMEOWNER_PROGRESS_COPY.steps.map((x) => x.label);
    const want = 'a ' + labels.length + '-step tracker (' + labels.join(', ') + ')';
    ok('05 the portal tracker on /pro names every HOMEOWNER_PROGRESS_COPY step, in order', idx.includes(want), want);
    ok('05 the rating/referral ask waits for paid in full (canRate is paidInFull)',
      has(/rating and refer-a-friend asks wait until the job is paid in full/) && code('functions/portal.js', 'canRate: hp.paidInFull'));
  }
  // Today (#2137) — the six sections Home renders
  tie('02 Today lists the sections today-home.js renders (appointments … estimates)', /appointments, calls you owe, promised follow-ups, estimates to follow up, money to collect and stalled leads/,
    'docs/pro/js/today-home.js', "section('appts', 'Appointments', a) + section('calls', 'Calls owed', c) + section('promised', 'Promised follow-ups', pr) + section('estimates', 'Estimates to follow up', e)");
  tie('02 Today: money to collect + stalled leads sections', /money to collect and stalled leads/, 'docs/pro/js/today-home.js', "section('money', 'Money to collect', m) + section('stalled', 'Stalled leads', s, deck)");
  // E-sign (#2166) + cancel forms (#2149)
  tie('03 every in-app contract carries the right-to-cancel notice + forms', /Notice of Right to Cancel and two Notice of Cancellation forms/, 'functions/cancel-notice-pdf.js', ".text('NOTICE OF CANCELLATION'");
  tie('03 up to 4 signers', /Up to 4 signers/, 'functions/esign-logic.js', 'const MAX_SIGNERS = 4;');
  ok('03 reminders every 2 days, 3 at most', has(/Reminders go out every 2 days, 3 at most/)
    && code('functions/esign-logic.js', 'const REMINDER_EVERY_MS = 2 * 86_400_000;') && code('functions/esign-logic.js', 'const REMINDER_MAX = 3;'));
  // Production (#2147) — the strip's five labels; weather / calendar sync are Jo-only and not claimed
  ok('04 the production strip names the five steps production-logic.js builds',
    has(/Permit, Ordered, Delivery, Sub, Start/) && ['Permit', 'Ordered', 'Delivery', 'Sub', 'Start'].every((k) => code('docs/pro/js/production-logic.js', "label: '" + k + "'")));
  ok('04 Jo-only production pieces are not claimed (job weather, Google Calendar sync)', !/weather forecast|calendar sync|syncs? to google calendar/i.test(idx));
  // Numbers (#2150)
  tie('numbers: one close rate, won ÷ (won + lost)', /won ÷ \(won \+ lost\)/, 'docs/pro/js/numbers-logic.js', 'rate: decided ? won / decided : null');
  ok('numbers: the six lost reasons on /pro are LOST_REASONS', has(/Six lost reasons/)
    && ["label: 'Price'", "label: 'Went with someone else'", "label: 'No damage'", "label: 'No response'", "label: 'Insurance denied'", "label: 'Other'"].every((k) => code('docs/pro/js/numbers-logic.js', k)));
  // Photos (#2153) — on-site radius
  tie('07 photos: on-site within 75 m', /within 75 m of the address/, 'docs/pro/js/photo-engine.js', 'const ON_SITE_RADIUS_M = 75;');
  // Documents (#2141) — the count is what the three generator files register,
  // loaded in a VM (a regex count of the source would miss Object.assign).
  {
    const vm = require('vm');
    const noop = () => {};
    const el = { style: {}, appendChild: noop, setAttribute: noop, addEventListener: noop, classList: { add: noop, remove: noop } };
    const ctx = { console: { log: noop, warn: noop, error: noop }, setTimeout, clearTimeout, navigator: {}, location: { href: '', hostname: 'x' },
      document: { createElement: () => el, addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, head: el, body: el },
      localStorage: { getItem: () => null, setItem: noop } };
    ctx.window = ctx; ctx.self = ctx; vm.createContext(ctx);
    ['document-generator.js', 'document-generator-templates.js', 'document-generator-library.js']
      .forEach((n) => vm.runInContext(read('docs/pro/js/' + n), ctx, { filename: n }));
    const types = ctx.NBDDocGen.DOCUMENT_TYPES;
    const n = Object.keys(types).length;
    const listed = (idx.match(/<ul class="pl-doclist"[\s\S]*?<\/ul>/) || [''])[0];
    const pills = (listed.match(/<li>([^<]+)<\/li>/g) || []).map((x) => x.replace(/<\/?li>/g, ''));
    ok('docs: the document count on /pro is NBDDocGen.DOCUMENT_TYPES', has(new RegExp('<h2 id="docs-h">' + n + ' documents')) && listed.includes('and ' + (n - pills.length) + ' more'), n + ' types, ' + pills.length + ' listed');
    const names = Object.values(types).map((t) => String(t.name).replace(/&/g, '&amp;'));
    const bare = pills.map((p) => p.replace(/ \(signable\)$|, Ohio or Kentucky$/, ''));
    ok('docs: every document named on /pro is a registered type', bare.length > 0 && bare.every((p) => names.includes(p)), bare.filter((p) => !names.includes(p)).join(', '));
    ok('docs: the attorney-review drafts are disclosed', has(/marked as drafts for your attorney to review/)
      && code('docs/pro/js/document-generator-library.js', "var ATTORNEY_REVIEW_TYPES = ['lien_waiver', 'change_order', 'right_to_cancel'];"));
  }
  // Social Studio (#2162) — owner/admin, town only. Meta publishing runs on ONE
  // global page token (Jo's page), so auto-publishing is not sold.
  tie('social: owner or admin only', /The owner or an admin runs it/, 'functions/social-studio.js', "'Social Studio is for the owner or a company admin.'");
  ok('social: auto-publishing to Facebook/Instagram is not claimed', !/auto-?publish|posts? (it )?(straight|directly|automatically) to (facebook|instagram)/i.test(idx));
  ok('not claimed: Solar roof measurement (off for every tenant) or offline-safe field work (#2145 not merged)', !/solar|works offline|offline-safe|no signal/i.test(idx));
  ok('not claimed: #2135 getting-paid features (not merged); its spot is marked',
    !/Send balance|without an invoice|payment timeline/i.test(idx.replace(/<!--[\s\S]*?-->/g, '')) && /PENDING #2135/.test(idx));
  // 06 storm + D2D
  tie('06 Storm Watch reads live NWS alerts', /Storm Watch pulls live National Weather Service alerts/, 'docs/pro/js/storm-center.js', 'api.weather.gov/alerts/active');
  {
    const d2d = read('docs/pro/js/d2d-tracker-core-2026b.js');
    const a = d2d.indexOf('const DISPOSITIONS = {');
    const n = (d2d.slice(a, d2d.indexOf('\n  };', a)).match(/^\s{4}[a-z_]+:\s+\{ label:/gm) || []).length;
    ok('06 the door-outcome count on /pro matches DISPOSITIONS', has(new RegExp('one of ' + n + ' outcomes')), 'DISPOSITIONS has ' + n);
  }
  tie('06 the walking-route optimizer exists', /route optimizer/, 'docs/pro/js/d2d-tracker-2026b.js', 'calculateWalkingRoute');
  // 07 reports
  ok('07 four report templates, named as the engine names them',
    has(/four templates: Full Roof Inspection, Storm Damage, Supplement and Completion/)
      && ["id: 'full-inspection'", "id: 'storm-damage'", "id: 'supplement'", "id: 'completion'"].every((k) => code('docs/pro/js/inspection-report-engine.js', k)));
  // 08 Ask Joe — actions wait for a tap; texting is not live
  tie('08 Ask Joe actions show a confirm card first', /nothing happens until you tap the button/, 'docs/pro/js/ask-joe-actions.js', "const ACTION_TOOLS = ['send_text', 'add_reminder', 'add_note', 'move_stage'];");
  // 09 crew
  tie('09 the four invite roles', /company admin, manager, sales rep or viewer/, 'functions/handlers/_shared.js', "INVITE_ALLOWED_ROLES = new Set(['company_admin', 'manager', 'sales_rep', 'viewer'])");
  tie('09 per-person calendar feed', /private calendar feed/, 'functions/calendar-feed.js', 'createCalendarFeedToken');
  tie('09 installs to the home screen', /opens full screen, like an app/, 'docs/pro/manifest.json', '"display": "standalone"');
  // 10 Kentucky
  tie('10 no assignment of benefits — the document is retired', /The document is retired/, 'docs/pro/js/document-generator.js', 'aobRetired');
  tie('10 KY insurance: nothing due at signing (KRS 367.626)', /Kentucky insurance job, the deductible and the first insurance payment come due only after/, 'docs/pro/js/deposit-rule.js', 'KRS 367.626');
  tie('10 KY insurance: the online pay link is refused until then', /online pay link is refused until then/, 'functions/stripe.js', "error: 'KY_CANCELLATION_WINDOW'");
  // 11 running in my shop — labelled as Jo's own business, not self-serve.
  ok('11 the shop section says these are not self-serve yet', has(/They are not self-serve for your account yet/));
  tie('11 the morning email is Jo-only, so it sits in the shop section', /<dt>The morning email<\/dt>/, 'functions/morning-brief.js', 'process.env.NBD_OWNER_UID');
  // Bring your own bot went self-serve in #2158 (Settings → Bots & API, any
  // active/trialing paid plan): the copy says live on paid plans, and the
  // plan gate + the free-plan card back it.
  ok('11 bring-your-own-bot is live on paid plans (Settings → Bots & API), not "coming soon"',
    has(/<p class="pl-tag">Live on paid plans<\/p>\s*<h3>Connect your own AI bots/) && has(/Settings → Bots &amp; API/)
      && code('functions/agent-mcp-logic.js', "sub.plan && sub.plan !== 'free'") && code('docs/pro/js/agent-bots-settings.js', 'Bots need a paid plan')
      && !/coming soon for your account/i.test(idx));
  tie('11 the bot team cannot text anyone', /None of them can text anyone/, 'functions/agent-mcp.js', 'There is no tool that texts');
  tie('11 Call Center transcribes calls', /Calls from my phone are transcribed/, 'functions/call-center.js', 'transcribeGroqBuffer');
  tie('11 Thursday answers the line and files to an inbox', /AI phone receptionist answers my line/, 'functions/integrations/thursday.js', 'thursdayWebhook');
  // 12 proof — only numbers checkable from NBD's own published records
  {
    const projects = JSON.parse(read('docs/assets/data/projects.json')).projects;
    const towns = new Set(projects.map((p) => p.city)).size;
    ok('12 the published-jobs count matches projects.json', has(new RegExp('<strong>' + projects.length + ' jobs</strong>')), projects.length + ' projects');
    ok('12 the towns count matches projects.json', has(new RegExp('<strong>' + towns + ' towns</strong>')), towns + ' towns');
    ok('12 no testimonials or star ratings', !/<blockquote|★|testimonial">/i.test(idx));
  }
  // 13 plans — the numbers are billing.js PLAN_LIMITS
  {
    const billing = read('functions/billing.js');
    const lim = (plan, k) => (billing.match(new RegExp('\\n  ' + plan + ':\\s+\\{[^}]*' + k + ':\\s+(\\w+)')) || [])[1];
    const want = [['free', '10'], ['starter', '50'], ['team', '150'], ['growth', '500']];
    ok('13 lead caps on /pro and pricing.html match PLAN_LIMITS',
      want.every(([p, n]) => lim(p, 'leads') === n) && want.every(([, n]) => idx.includes(n + ' new leads a month') && pricing.includes(n + ' new leads a month')));
    ok('13 AI calls on /pro match PLAN_LIMITS (free 0, starter 20, team 100, growth unlimited)',
      lim('free', 'aiCalls') === '0' && lim('starter', 'aiCalls') === '20' && lim('team', 'aiCalls') === '100' && lim('growth', 'aiCalls') === 'Infinity'
        && has(/No AI features/) && has(/20 AI calls a month/) && has(/100 AI calls a month/) && has(/Unlimited AI calls/));
    ok('13 reps on /pro match PLAN_LIMITS (team 2, growth 5)', lim('team', 'reps') === '2' && lim('growth', 'reps') === '5' && has(/You \+ 2 reps/) && has(/You \+ 5 reps/));
    ok('13 the free tier has no AI server-side (claudeProxy needs a paid plan)', code('functions/handlers/ai.js', "sub.plan !== 'free'"));
    ok('13 no plan lists a reports cap nothing meters (no trackUsage(\'reports\') caller)',
      !/reports? (per|a) month/i.test(idx) && !/reports? (per|a) month/i.test(pricing));
    ok('13 no plan claims "most popular" or white-label', ![idx, pricing].some((s) => /most popular|white-label/i.test(s)));
  }
  // 14 FAQ — the JSON-LD mirror says exactly what the page says
  {
    const ld = (idx.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [])
      .map((s) => JSON.parse(s.replace(/^<script[^>]*>|<\/script>$/g, ''))).find((o) => o['@type'] === 'FAQPage');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const visible = (idx.match(/<div class="pl-faq-a">[^<]*<\/div>/g) || []).map((s) => s.replace(/^<div class="pl-faq-a">|<\/div>$/g, ''));
    ok('14 every FAQPage answer is byte-identical to a visible answer, and vice versa',
      !!ld && ld.mainEntity.length === visible.length && ld.mainEntity.every((q, i) => esc(q.acceptedAnswer.text) === visible[i]));
  }
  // CTA — one demo constant
  {
    const js = read('docs/pro/js/landing-page.js');
    const demo = 'cal.com/nobigdeal/nbd-pro-demo';
    const buttons = idx.match(/<a [^>]*>Book a demo<\/a>/g) || [];
    ok('CTA: the demo URL lives in ONE constant (landing-page.js), nowhere in the HTML',
      js.split(demo).length === 2 && /var DEMO_URL = 'https:\/\/cal\.com\/nobigdeal\/nbd-pro-demo';/.test(js) && !idx.includes(demo));
    ok('CTA: every Book a demo button is wired to that constant', buttons.length >= 3 && buttons.every((b) => /data-demo-link/.test(b)));
    ok('CTA: Try the sandbox goes to the sandbox', has(/<a class="pl-btn pl-btn-ghost" href="\/pro\/sandbox\.html">Try the sandbox<\/a>/));
    ok('CTA: paid plan buttons keep the data-plan wiring', ['starter', 'team', 'growth'].every((p) => idx.includes('data-pl-action="goRegister" data-plan="' + p + '"')));
  }
  // Story — Jo's figures; NBD uses independent subcontractor crews
  ok('story: leads with "built by a roofer on his own roofs" and Jo-confirmed figures',
    has(/Built by a roofer, on his own roofs/) && has(/7 years/) && has(/\$10M\+/));
  ok('story: no "solo", "employees" or "in-house" on /pro, pricing or register',
    [idx, pricing, register].every((s) => !/\bsolo\b|\bemployees?\b|in-house/i.test(s.replace(/<!--[\s\S]*?-->/g, ''))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
