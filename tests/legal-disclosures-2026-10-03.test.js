/**
 * tests/legal-disclosures-2026-10-03.test.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Legal-checklist audit (2026-10-03) — the page-level disclosures:
 *
 *   1. docs/privacy.html names every vendor the code actually sends personal
 *      data to (Bland AI, Groq + Anthropic for recorded calls, Replicate /
 *      Kie.ai for the PUBLIC visualizer, xAI for the CRM bots), and its Do
 *      Not Track text agrees with what the analytics loaders DO — derived
 *      from the loader source, so the policy and the code cannot drift.
 *   2. /pro/register is clickwrap: a required "I agree" checkbox, not a
 *      passive "by creating an account" line.
 *   3. /pro/pricing shows an automatic-renewal line under each paid button,
 *      at the SAME price as that card.
 *   4. The CRM (dashboard Settings) and /pro/login link the Terms + Privacy.
 *
 * Run: node tests/legal-disclosures-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const priv = read('docs/privacy.html');
const text = priv.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, ' ');

console.log('1. privacy policy — vendors the code uses');
{
  // Each row: [what the code does (proved from source), what the policy must say].
  const thursday = read('functions/integrations/thursday.js');
  ok('code: Thursday calls run on Bland AI (precondition)', /bland\.ai/i.test(thursday));
  ok('policy names Bland AI for the phone assistant, with recording + transcript',
    /Bland AI/.test(text) && /Thursday/.test(text) && /recorded and transcribed/.test(text));

  const cc = read('functions/call-center.js');
  ok('code: recorded calls are summarized by Claude (precondition)', /claude-/.test(cc));
  const callPara = (text.match(/Recorded Business Calls(.*?)(?:Roof Visualizer)/) || [])[1] || '';
  ok('policy: recorded business calls are transcribed by Groq and summarized by Anthropic',
    /transcribed by Groq/.test(callPara) && /summarized by Anthropic/.test(callPara), callPara.slice(0, 160));

  const viz = read('functions/visualizer-image-gen.js');
  ok('code: the visualizer image endpoint calls Replicate and (alternate) kie.ai (precondition)',
    /replicate\.com/.test(viz) && /api\.kie\.ai/.test(viz));
  ok('policy: the PUBLIC visualizer discloses Replicate and Kie.ai',
    /Roof Visualizer/.test(text) && /Replicate/.test(text) && /Kie\.ai/.test(text) && /do not need an account/.test(text));
  ok('policy no longer claims Replicate is used only for Pro accounts with an image feature enabled',
    !/only if a contractor's account has the optional AI image feature/.test(text));

  const mcp = read('functions/agent-mcp-logic.js');
  ok('code: the CRM bot connection strips phone + email (precondition)', /phone/.test(mcp) && /email/.test(mcp));
  ok('policy discloses xAI Grok bots, what they read, and that phones/emails are withheld',
    /xAI's Grok/.test(text) && /phone numbers, email addresses, and insurance claim and policy numbers are never provided/.test(text)
    && /cannot send messages/.test(text));

  // Bumped to October 4 by the BoldSign retirement (2026-10-04: the
  // E-Signature section now describes the in-house system). Any later date
  // still means this section's disclosures are in.
  ok('"Last Updated" is October 3, 2026 or later',
    /Last Updated: (October ([3-9]|[12][0-9]|3[01])|November [0-9]+|December [0-9]+), 2026/.test(priv));
}

console.log('2. privacy policy — Do Not Track says what the code does');
{
  const clarity = read('docs/assets/js/clarity-loader.js');
  const ga = read('docs/assets/js/inline/2a90205f1b.js');
  const clarityHonours = /globalPrivacyControl/.test(clarity) && /doNotTrack/.test(clarity);
  const gaHonours = /doNotTrack|globalPrivacyControl/.test(ga);
  const dnt = (text.match(/Do Not Track Some browsers(.*?)California Privacy Rights/) || [])[1] || '';
  ok('found the Do Not Track paragraph', dnt.length > 0);
  ok('Clarity: the policy says it honours DNT/GPC exactly when the loader does',
    clarityHonours === /Clarity, where we use it, does not load when your browser sends either signal/.test(dnt), dnt);
  ok('Google Analytics: the policy says it does not respond exactly when the GA init ignores them',
    !gaHonours === /Google Analytics on our Website does not currently respond/.test(dnt), dnt);
  ok('no blanket "our Website does not respond to Do Not Track" contradicting the Clarity paragraph',
    !/Our Website does not currently respond to Do Not Track signals/.test(text));
}

console.log('3. /pro/register — clickwrap');
{
  const reg = read('docs/pro/register.html');
  ok('a required checkbox #regTerms exists', /<input type="checkbox" id="regTerms"[^>]*required/.test(reg));
  const label = (reg.match(/<label class="terms-check"[\s\S]*?<\/label>/) || [''])[0];
  ok('its label reads "I agree to the Terms of Service and Privacy Policy" with both links',
    /I agree to the <a href="\/pro\/terms\.html"[^>]*>Terms of Service<\/a> and <a href="\/privacy\.html"[^>]*>Privacy Policy<\/a>/.test(label), label);
  ok('the box sits ABOVE the Google button, so it gates both sign-up paths',
    reg.indexOf('id="regTerms"') > 0 && reg.indexOf('id="regTerms"') < reg.indexOf('id="googleRegBtn"'));
  ok('the passive "By creating an account you agree" line is gone', !/By creating an account you agree/.test(reg));
  const js = read('docs/pro/js/pages/register.js');
  ok('register.js stamps termsAcceptedAt + termsVersion on every users-doc create (3 paths)',
    (js.match(/\.\.\.termsRecord\(\)/g) || []).length === 3);
}

console.log('4. /pro/pricing — automatic-renewal disclosure');
{
  const pr = read('docs/pro/pricing.html');
  for (const plan of ['starter', 'team', 'growth']) {
    const btn = pr.indexOf('data-plan="' + plan + '"');
    const cardStart = pr.lastIndexOf('<div class="card', btn);
    const price = (pr.slice(cardStart, btn).match(/<div class="tier-price">\$(\d+) <span class="mo">\/mo<\/span><\/div>/) || [])[1];
    const note = (pr.slice(btn, pr.indexOf('</div>', btn)).match(/<p class="renew-note" data-renew-plan="(\w+)">([^<]*)<\/p>/) || []);
    ok(plan + ': a renewal note follows its button', note[1] === plan, note[0]);
    ok(plan + ': the note states the card\'s own price ($' + price + '/mo) and "until you cancel"',
      !!price && new RegExp('renews at \\$' + price + '/mo until you cancel', 'i').test(note[2] || ''), note[2]);
  }
}

console.log('5. Terms + Privacy links inside the app');
{
  const dash = read('docs/pro/dashboard.html');
  const s = dash.slice(dash.indexOf('id="settingsLegalLinks"'), dash.indexOf('</div>', dash.indexOf('id="settingsLegalLinks"')));
  ok('dashboard Settings links Terms of Service and Privacy Policy',
    /href="\/pro\/terms\.html"[^>]*>Terms of Service/.test(s) && /href="\/privacy\.html"[^>]*>Privacy Policy/.test(s), s);
  const login = read('docs/pro/login.html');
  const l = login.slice(login.indexOf('id="loginLegalLinks"'), login.indexOf('</div>', login.indexOf('id="loginLegalLinks"')));
  ok('/pro/login links Terms of Service and Privacy Policy',
    /href="\/pro\/terms\.html">Terms of Service/.test(l) && /href="\/privacy\.html">Privacy Policy/.test(l), l);
}

console.log('');
console.log(failed ? 'FAILED — ' + passed + ' passed, ' + failed + ' failed' : 'PASSED — ' + passed + ' assertions');
process.exit(failed ? 1 : 0);
