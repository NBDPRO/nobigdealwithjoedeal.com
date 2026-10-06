/**
 * tests/pro-demo-story-2026-10-06.test.js — the guided NBD Pro demo at
 * /pro/sandbox (docs/pro/sandbox.html + docs/pro/js/sandbox-story.js).
 *
 * WHY: Jo (2026-10-06) replaced the drag-the-pipeline sandbox and the long
 * /pro/demo tool tour with one sample job told in nine steps. The old pages
 * carried three false or unsafe things: "Due at signing" money on an
 * insurance job (Kentucky: nothing is due at signing, KRS 367.626), a
 * "lifetime workmanship" chip on every tier, and tiers with no GAF System
 * Plus (Jo 10/05: System Plus on Standard and up). This pins each step's key
 * facts by RENDERING every screen from the real script with the real rule
 * files loaded (ky-insurance-law.js + deposit-rule.js), plus:
 *   - no network: every screen renders with fetch/XHR/beacon/WebSocket
 *     trapped, and the script source (comments stripped) names none of them
 *     nor Firebase;
 *   - CSP-safe: no inline <script>/<style>/style=/on*= in the page, and no
 *     on*= / javascript: in anything a screen renders;
 *   - the end screen, the redirect from /pro/demo, the links and SEO.
 *
 * Pure Node. Run: node tests/pro-demo-story-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const text = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([;,{}()])\s*\/\/.*$/gm, '$1');

const HTML = read('docs/pro/sandbox.html');
const JS = read('docs/pro/js/sandbox-story.js');
const CSS = read('docs/pro/css/sandbox-story.css');
const JS_CODE = stripJsComments(JS);

// ── Load the demo exactly as the page does, with the network trapped ──────
const calls = [];
const trap = (name) => function () { calls.push(name); throw new Error('network call: ' + name); };
const sb = {
  console: { log() {}, warn() {}, error() {} },
  fetch: trap('fetch'), XMLHttpRequest: trap('XMLHttpRequest'), WebSocket: trap('WebSocket'), EventSource: trap('EventSource'),
  navigator: { sendBeacon: trap('sendBeacon') }, importScripts: trap('importScripts')
};
sb.window = sb;
vm.createContext(sb);
let loadErr = null;
try {
  vm.runInContext(read('docs/pro/js/ky-insurance-law.js'), sb, { filename: 'ky-insurance-law.js' });
  vm.runInContext(read('docs/pro/js/deposit-rule.js'), sb, { filename: 'deposit-rule.js' });
  vm.runInContext(JS, sb, { filename: 'sandbox-story.js' });
} catch (e) { loadErr = e; }
const D = sb.NBDProDemo;
ok('the story script loads after the real rule files and exposes NBDProDemo', !loadErr && !!D && typeof D.renderScreen === 'function', loadErr && loadErr.message);
if (!D) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }

const fresh = () => D.freshState();
const with_ = (o) => Object.assign(fresh(), o);
// Every screen in every state a visitor can reach.
const VARIANTS = [];
D.STEP_IDS.forEach((id) => {
  VARIANTS.push([id, fresh()]);
  ['ky', 'retail'].forEach((mode) => ['held', 'decision', 'released', 'acvpaid'].forEach((inv) => [false, true].forEach((paid) =>
    VARIANTS.push([id, with_({ mode, inv, paid, signed: paid, door: paid, tag: paid, report: paid ? 'home' : 'roof', sheet: paid, rain: paid ? 2 : 0 })]))));
  ['good', 'better', 'best'].forEach((tier) => VARIANTS.push([id, with_({ tier })]));
  ['sent', 'tossed'].forEach((inbox) => VARIANTS.push([id, with_({ inbox, reminder: 'added' })]));
});
let renderErr = null;
const RENDERED = VARIANTS.map(([id, st]) => {
  try { return [id, st, D.renderScreen(id, st)]; } catch (e) { renderErr = renderErr || (id + ': ' + e.message); return [id, st, '']; }
});
ok('every screen renders in every state without throwing (' + RENDERED.length + ' renders)', !renderErr, renderErr);
ok('every step id has a screen and a <section> on the page', D.STEP_IDS.length === 9 && D.STEP_IDS.every((id) =>
  D.renderScreen(id, fresh()).length > 200 && HTML.includes('data-sx-step="' + id + '"') && HTML.includes('data-sx-screen="' + id + '"')));

console.log('\nNO NETWORK — no Firebase, no fetch, no analytics, nothing sent');
ok('rendering every screen made zero network calls', calls.length === 0, calls.join(', '));
ok('the script source (comments stripped) names no network API',
  !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|\bimport\s*\(/.test(JS_CODE));
ok('the script names no Firebase / Firestore / analytics', !/firebase|firestore|gtag|dataLayer|httpsCallable|getFirestore/i.test(JS_CODE));
ok('the script writes no storage (sample data resets on reload)', !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(JS_CODE));
ok('the script schedules nothing (no timer could ever "send" a draft)', !/setTimeout|setInterval/.test(JS_CODE));
const scriptSrcs = (HTML.match(/<script\b[^>]*\ssrc="([^"]+)"/g) || []).map((s) => s.match(/src="([^"]+)"/)[1]);
ok('the page loads exactly four same-origin scripts: the KY law, the deposit rule, the landing wiring, the story',
  JSON.stringify(scriptSrcs.map((s) => s.replace(/\?.*$/, ''))) === JSON.stringify(['/pro/js/ky-insurance-law.js', '/pro/js/deposit-rule.js', '/pro/js/landing-page.js', '/pro/js/sandbox-story.js']), scriptSrcs.join(', '));
ok('…every script deferred', (HTML.match(/<script\b[^>]*>/g) || []).every((t) => /\sdefer\b/.test(t)));
ok('the page loads no third-party stylesheet or font (fonts are self-hosted)', !/fonts\.googleapis|gstatic|cdn\./.test(HTML));
const assetRefs = RENDERED.map((r) => r[2]).join('').match(/\s(?:src|href)="([^"]+)"/g) || [];
ok('screens reference only same-origin static assets', assetRefs.every((a) => /="\/assets\//.test(a)), assetRefs.filter((a) => !/="\/assets\//.test(a)).join(', '));
ok('screens carry no sms:/tel:/mailto: link (Text from my phone is a demo button, nothing opens)',
  RENDERED.every((r) => !/(sms|tel|mailto):/i.test(r[2])));

console.log('\nCSP-SAFE — no inline scripts, styles or handlers');
const htmlNoComments = HTML.replace(/<!--[\s\S]*?-->/g, '');
ok('no inline <script> body', (htmlNoComments.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) || []).every((s) => /\ssrc="/.test(s) && /><\/script>$/.test(s)));
ok('no inline <style> block and no style= attribute in the page', !/<style[\s>]/i.test(htmlNoComments) && !/\sstyle\s*=/i.test(htmlNoComments));
ok('no on*= handler in the page', !/\son[a-z]+\s*=/i.test(htmlNoComments));
ok('no on*= handler, style= or javascript: in any rendered screen',
  RENDERED.every((r) => !/\son[a-z]+\s*=|\sstyle\s*=|javascript:/i.test(r[2])));
ok('the script wires ONE click delegate (no per-element listeners)', (JS_CODE.match(/addEventListener\('click'/g) || []).length === 1);

console.log('\nSTEP 1 STORM — storm alert, zone, D2D map with the real outcome labels');
{
  const s = text(D.renderScreen('storm', fresh()));
  ok('names the weather source and the storm zone', /National Weather Service/.test(s) && /Storm zone/.test(s) && /of your customers/.test(s));
  ok('the map is an inline SVG (no map tiles fetched)', /<svg class="sx-map"/.test(D.renderScreen('storm', fresh())));
  const core = read('docs/pro/js/d2d-tracker-core-2026b.js');
  ok('every outcome label + colour is the real D2D disposition', Object.keys(D.OUTCOMES).every((k) =>
    new RegExp(k + ':\\s*\\{ label: \'' + D.OUTCOMES[k].label + '\',\\s*color: \'' + D.OUTCOMES[k].color + '\'').test(core)));
  ok('opening the door shows the Appointment Set sheet', /Appointment Set/.test(text(D.renderScreen('storm', with_({ door: true })))) && /See the lead/.test(D.renderScreen('storm', with_({ door: true }))));
}

console.log('\nSTEP 2 LEAD — the knock lands as a lead');
{
  const s = text(D.renderScreen('lead', fresh()));
  ok('the lead card names the customer, the Kentucky address and the door-knock source', /Jordan Avery/.test(s) && /KY 41075/.test(s) && /Door knock/.test(s));
  ok('the pipeline chain is the landing page\'s auto-move chain (a KY insurance job pays a deductible, not a deposit)',
    ['Meeting booked', 'Estimate shared', 'Contract signed', 'Deductible paid', 'Paid in full'].every((x) => s.includes(x))
    && text(D.renderScreen('lead', with_({ mode: 'retail' }))).includes('Deposit paid'));
}

console.log('\nSTEP 3 REPORT — photos to a homeowner report, no claim-outcome promise');
{
  const roof = D.renderScreen('report', fresh());
  const home = text(D.renderScreen('report', with_({ report: 'home' })));
  ok('the roof view shows tagged photos with width+height', (roof.match(/<img [^>]*width="800" height="600"/g) || []).length === 3);
  ok('every photo is an EXIF-stripped public asset under /assets/', (roof.match(/src="([^"]+)"/g) || []).every((m) => /src="\/assets\/images\//.test(m)));
  ok('the photos exist on disk', (roof.match(/src="([^"]+)"/g) || []).every((m) => fs.existsSync(path.join(ROOT, 'docs', m.slice(5, -1)))));
  ok('the homeowner report leaves the claim with the homeowner and the insurer', /your decision/.test(home) && /your insurance company decides what is covered/.test(home));
  ok('no outcome promise ("approved", "guarantee", "we handle/negotiate")', !/approv|guarantee|we (handle|negotiate|manage)|get you a (new )?roof/i.test(home));
}

console.log('\nSTEP 4 ESTIMATE — Standard/Preferred/Elite, GAF System Plus on every tier, sample prices');
{
  const html = D.renderScreen('estimate', fresh());
  const cards = html.split('class="sx-tier"').slice(1);
  ok('three tiers: Standard, Preferred, Elite (GAF Timberline NS / HDZ / UHDZ)', cards.length === 3
    && ['Standard', 'Preferred', 'Elite'].every((l, i) => cards[i].includes('>' + l + '<'))
    && ['GAF Timberline NS', 'GAF Timberline HDZ', 'GAF Timberline UHDZ'].every((l, i) => cards[i].includes(l)));
  ok('GAF System Plus on Standard and up (every tier shown)', cards.every((c) => /GAF System Plus Limited Warranty included/.test(c)));
  ok('every price is labelled a sample', cards.every((c) => /sample price/.test(c)) && /Prices are samples/.test(text(html)));
  ok('prices are whole cents in the data (money stays in cents)', D.SAMPLE.tiers.every((t) => Number.isInteger(t.priceCents)));
  const best = D.renderScreen('estimate', with_({ tier: 'best' })).split('class="sx-tier"').slice(1);
  ok('picking a tier moves the Picked badge', best[2].includes('aria-pressed="true"') && best[2].includes('>Picked<') && best[0].includes('aria-pressed="false"') && !best[0].includes('>Picked<'));
}

console.log('\nSTEP 5 AI FOLLOW-UP — a bot drafts, the owner taps, nothing auto-sends');
{
  const s = D.renderScreen('follow-up', fresh());
  ok('uses the real Agent inbox item markup (agent-inbox.css)', /class="ai-item"/.test(s) && /class="ai-kind"/.test(s) && /class="ai-btn is-primary"/.test(s));
  ok('the draft\'s send control is "Text from my phone", and a Toss beside it', /Text from my phone/.test(s) && />Toss</.test(s));
  ok('the inbox says nothing reaches a customer until the owner taps', /Nothing here reaches a customer until you tap/.test(s));
  const sent = text(D.renderScreen('follow-up', with_({ inbox: 'sent' })));
  ok('after the tap: the owner\'s own phone sends it, and the demo says nothing was sent', /you press send/.test(sent) && /nothing was sent/.test(sent));
  ok('the page says texting from NBD Pro itself is coming soon (A2P not live)', /Texting from NBD Pro itself: coming soon/.test(HTML));
  ok('the page says bots cannot text, email or charge anyone', /None of them can text, email or charge anyone/.test(HTML));
}

console.log('\nSTEP 6 SIGN — Kentucky insurance: NOTHING due at signing; retail: the normal deposit');
{
  const kyStates = RENDERED.filter((r) => r[1].mode === 'ky').map((r) => r[2]);
  const moneyAtSigning = (h) => {
    const t = text(h).replace(/Nothing is due at signing\.?/g, '');
    return /due at signing|at signing[^.]{0,40}\$\s?[1-9]|\$\s?[1-9][\d,]*[^.]{0,30}at signing|deposit/i.test(t);
  };
  ok('no Kentucky-insurance render of ANY step shows money due at signing (or a deposit)', kyStates.every((h) => !moneyAtSigning(h)),
    text(kyStates.find(moneyAtSigning) || '').slice(0, 200));
  const ky = text(D.renderScreen('sign', fresh()));
  ok('the KY contract leads with "Nothing is due at signing."', /Nothing is due at signing\./.test(ky));
  ok('…the deductible and ACV are due after the written decision + the 5-business-day window (the rule\'s own words)',
    /Your deductible After your insurer’s written coverage decision and the 5-business-day cancellation window \$1,000/.test(ky));
  ok('…the pay link is shown locked', /pay link locked until the insurer’s written decision plus 5 business days/.test(ky));
  const J = sb.NBDJurisdiction;
  ok('…the KY cancellation notice and the no-assignment notice are the statute\'s text from ky-insurance-law.js',
    ky.includes(text(J.KY_NOTICE_CANCEL).trim()) && ky.includes(text(J.KY_NOTICE_NO_ASSIGNMENT).trim()));
  ok('…no assignment of benefits / direction to pay is offered', !/sign (the|an) (AOB|assignment)|direction to pay/i.test(ky) && /No assignment of benefits/.test(ky));
  const retail = text(D.renderScreen('sign', with_({ mode: 'retail' })));
  const plan = sb.NBDDepositRule.compute({ total: 17160, mode: 'cash' });
  ok('the retail toggle shows the rule\'s normal deposit at signing (' + plan.valueText + ')', retail.includes('Due at signing: ' + plan.valueText) && /50% deposit/.test(retail));
  ok('…and the FTC 3-day cancel statement', retail.includes(text(J.FTC_STATEMENT).trim()));
  ok('the page copy for the KY step says nothing is due at signing', /A Kentucky insurance job: nothing is due at signing/.test(HTML));
  ok('signing records consent, IP, browser and time', /Consent, IP, browser and time recorded/.test(D.renderScreen('sign', with_({ signed: true }))));
}

console.log('\nSTEP 7 CREW — production strip, job sheet without prices or phone, rain day');
{
  const s = text(D.renderScreen('crew', with_({ sheet: true })));
  ok('the five production steps', ['Permit', 'Ordered', 'Delivery', 'Sub', 'Start'].every((x) => s.includes(x)));
  ok('the job sheet says prices and the homeowner\'s phone are NOT on it', /Not on it Your prices and the homeowner’s phone/.test(s));
  ok('the job sheet itself carries no dollar figure', !/\$\d/.test(s.split('Job sheet sent')[1] || 'x$1'));
  const rain = text(D.renderScreen('crew', with_({ rain: 1 })));
  ok('a rain day pushes the start one weekday (Wed Oct 28 → Thu Oct 29)', /Start Thu Oct 29/.test(rain) && /Start Wed Oct 28/.test(text(D.renderScreen('crew', fresh()))));
  ok('three rain days skip the weekend (→ Mon Nov 2)', /Start Mon Nov 2/.test(text(D.renderScreen('crew', with_({ rain: 3 })))));
}

console.log('\nSTEP 8 INVOICE — the Kentucky pay link waits for the decision + 5 business days (the real payLinkHold)');
{
  ok('KY, no decision yet: held', D.payHold(with_({ inv: 'held' })).held === true);
  ok('KY, decision recorded, inside the window: held, unlocking October 22, 2026', D.payHold(with_({ inv: 'decision' })).held === true
    && D.payHold(with_({ inv: 'decision' })).releaseDate === 'October 22, 2026');
  ok('KY, window over: released', D.payHold(with_({ inv: 'released' })).held === false);
  ok('retail: never held', D.payHold(with_({ mode: 'retail' })).held === false);
  ok('the held invoice disables the pay button', /<button[^>]*sx-paybtn[^>]*disabled>Pay online: locked/.test(D.renderScreen('invoice', fresh())));
  ok('the release date on screen is the rule\'s', /Pay link unlocks October 22, 2026/.test(text(D.renderScreen('invoice', with_({ inv: 'decision' })))));
  ok('card fees state the landing page\'s figure', /3\.4% \+ 30¢ each/.test(HTML));
}

console.log('\nSTEP 9 PAID — the last payment closes the job');
{
  const before = text(D.renderScreen('paid', fresh()));
  const after = text(D.renderScreen('paid', with_({ paid: true })));
  const plan = D.payPlan(fresh());
  ok('the payment recorded is the plan\'s balance row', before.includes(plan.rows[plan.rows.length - 1].amountText + ' (the balance)'));
  ok('then: Paid in full, balance $0, and only now the review ask', /Paid in full/.test(after) && /Balance \$0\./.test(after) && /asks for a review/.test(after));
}

console.log('\nHONESTY — sample labels, no lifetime claim, no invented proof');
{
  const all = HTML.replace(/<!--[\s\S]*?-->/g, '') + JS_CODE + RENDERED.map((r) => r[2]).join('');
  ok('no "lifetime" anywhere in the demo (page, script, every screen)', !/lifetime/i.test(all));
  ok('no testimonial, star rating or "most popular"', !/testimonial|★|\b5-star\b|most popular|best-selling/i.test(all));
  ok('every app/doc screen is labelled Sample', RENDERED.every((r) => /class="sx-tag">Sample<|nbd-pill-neutral">Sample</.test(r[2])));
  ok('the page says it is sample data and nothing saves', /Nothing you tap is saved or sent/.test(HTML) && /nothing you do here is stored or sent/.test(HTML));
  ok('no TAMKO "certified"/"Pro Gold" claim (the sample uses GAF only)', !/TAMKO|Pro Gold/i.test(all));
}

console.log('\nEND SCREEN — Start free (primary), Book a demo (secondary), phase-2 placeholder');
{
  const end = HTML.slice(HTML.indexOf('data-sx-step="end"'));
  const primary = (end.match(/<a class="pl-btn pl-btn-primary[^"]*"[^>]*>[^<]*<\/a>/) || [''])[0];
  ok('the primary CTA is "Start free — no card" to /pro/register.html via the landing goRegister wiring',
    /href="\/pro\/register\.html" data-pl-action="goRegister">Start free — no card</.test(primary));
  ok('the secondary CTA is Book a demo through the one demo-link constant', /class="pl-btn pl-btn-ghost[^"]*" href="https:\/\/cal\.com\/nobigdeal" data-demo-link[^>]*>Book a demo</.test(end)
    && /var DEMO_URL = 'https:\/\/cal\.com\/nobigdeal\/nbd-pro-demo';/.test(read('docs/pro/js/landing-page.js')) && !HTML.includes('nbd-pro-demo'));
  const ph = (end.match(/<div class="sx-next-phase"[\s\S]*?<\/div>/) || [''])[0];
  ok('"Explore the whole sample account" is a disabled-looking placeholder, not a link', /aria-disabled="true"/.test(ph) && /coming next/i.test(ph) && !/<a\b|href=/.test(ph));
  const free = (read('docs/pro/js/billing-gate.js').match(/free:\s*\{ label: 'Free',\s*leads: (\d+),[^}]*reps: (\d+)/) || []);
  ok('the Free-plan line matches billing-gate.js PLANS.free (' + free[1] + ' leads, ' + free[2] + ' user)',
    free[1] && end.includes('The Free plan: ' + free[1] + ' new leads a month, ' + free[2] + ' user. No card, no timer.'));
  ok('no email gate: the page has no form or email field', !/<form\b|type="email"/i.test(HTML));
}

console.log('\nPHONE + MOTION — one thumb, reduced motion respected');
{
  ok('the Back/Next pager is fixed to the bottom with the safe-area inset', /\.sx-pager \{[^}]*position: fixed;[^}]*bottom: 0;[^}]*safe-area-inset-bottom/.test(CSS));
  ok('step chips and screen buttons are at least 44px tall', /\.sx-chip \{[^}]*min-height: 44px/.test(CSS) && /\.sx-btn \{[^}]*min-height: 48px/.test(CSS) && /\.sx-seg-btn \{[^}]*min-height: 44px/.test(CSS));
  ok('prefers-reduced-motion stops the step and signature animations', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.sx-sig-path \{ animation: none; \}/.test(CSS));
  ok('the signature stays visible with animation off (resting dashoffset 0)', /\.sx-sig-path \{[^}]*stroke-dashoffset: 0;/.test(CSS));
  ok('the script reads prefers-reduced-motion for its scrolling', /prefers-reduced-motion: reduce/.test(JS_CODE) && /behavior: still \? 'auto' : 'smooth'/.test(JS_CODE));
  const theme = (read('docs/pro/css/theme-system.css').match(/:root\[data-theme="nbd-original"\] \{([^}]*)\}/) || [])[1] || '';
  const appBlock = (CSS.match(/\.sx-app \{([^}]*)\}/) || [])[1] || '';
  const tok = (src, k) => ((src.match(new RegExp('--' + k + ':\\s*([^;]+);')) || [])[1] || '').trim().toLowerCase();
  ok('the rep-app screens use the nbd-original theme values (held equal to theme-system.css)',
    ['orange', 'og', 's', 's2', 's3', 'br', 't', 'm'].every((k) => tok(theme, k) && tok(theme, k) === tok(appBlock, k)),
    ['orange', 'og', 's', 's2', 's3', 'br', 't', 'm'].filter((k) => tok(theme, k) !== tok(appBlock, k)).join(','));
}

console.log('\nROUTES, LINKS, SEO');
{
  const fb = JSON.parse(read('firebase.json'));
  const red = fb.hosting.redirects || [];
  ok('/pro/demo 301s to /pro/sandbox (both the bare and the .html / cleanUrls forms)',
    red.some((r) => r.source === '/pro/demo' && r.destination === '/pro/sandbox' && r.type === 301)
    && red.some((r) => r.source === '/pro/demo*' && r.destination === '/pro/sandbox' && r.type === 301));
  ok('demo.html and the old sandbox engine are gone', !fs.existsSync(path.join(ROOT, 'docs/pro/demo.html')) && !fs.existsSync(path.join(ROOT, 'docs/pro/js/sandbox-demo.js')));
  ok('the dashboard\'s seed script demo.js is kept (seedDemoLeads still uses it)', fs.existsSync(path.join(ROOT, 'docs/pro/js/demo.js')));
  const noindex = (fb.hosting.headers || []).find((h) => /^\/pro\/@\(/.test(h.source));
  ok('/pro/sandbox is no longer in the noindex app-page list', !!noindex && !/\|sandbox\||\(sandbox\||\|sandbox\)/.test(noindex.source));
  ok('canonical + og:url are the extensionless /pro/sandbox', /<link rel="canonical" href="https:\/\/nobigdealwithjoedeal\.com\/pro\/sandbox">/.test(HTML)
    && /<meta property="og:url" content="https:\/\/nobigdealwithjoedeal\.com\/pro\/sandbox">/.test(HTML));
  ok('one h1, a title and a meta description', (HTML.match(/<h1\b/g) || []).length === 1 && /<title>[^<]{10,70}<\/title>/.test(HTML)
    && /<meta name="description" content="[^"]{50,160}">/.test(HTML));
  ok('sitemap-pro.xml lists /pro/sandbox', /<loc>https:\/\/nobigdealwithjoedeal\.com\/pro\/sandbox<\/loc>/.test(read('docs/sitemap-pro.xml')));
  const idx = read('docs/pro/index.html');
  ok('the landing\'s Try the sandbox button and footer link go to /pro/sandbox',
    idx.includes('href="/pro/sandbox">Try the sandbox</a>') && idx.includes('<li><a href="/pro/sandbox">Sandbox</a></li>'));
  const pages = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); } else if (/\.html$/.test(e.name)) pages.push(p); } })(path.join(ROOT, 'docs'));
  const stale = pages.filter((p) => /href="\/pro\/(demo|demo\.html|sandbox\.html)"/.test(fs.readFileSync(p, 'utf8')));
  ok('no published page links to /pro/demo or /pro/sandbox.html any more', stale.length === 0, stale.map((p) => path.relative(ROOT, p)).join(', '));
  ok('every asset the page references is absolute (bare-path pages break relative refs)',
    !/(src|href)="(?!https?:|\/|#|mailto:|tel:|data:)/.test(htmlNoComments));
  ok('every stylesheet and script the page loads exists', (HTML.match(/(?:href|src)="(\/(?:pro|assets)\/[^"?]+)/g) || [])
    .every((m) => fs.existsSync(path.join(ROOT, 'docs', m.replace(/^(?:href|src)="/, '')))));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
