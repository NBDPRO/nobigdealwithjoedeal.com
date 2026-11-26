/**
 * tests/r12-google-review-link-2026-11-26.test.js
 *
 * R12 of the review-ask guardrail plan (Jo, 2026-11-26: "Yes, fix it now").
 * users/{uid}.googleReviewUrl is written by each user on their own doc, and the
 * server used ANY https link from it: in NBD's live review-ask email from jd@
 * (review-ask-auto-logic.js reviewUrlFor), on the customer portal's review
 * button (portal.js portalReviewUrl) and in the agent review sprint
 * (agent-mcp.js). Now a saved link is used only when it is one of Google's own
 * review / Maps pages (functions/google-review-url.js); otherwise NBD falls
 * back to its own review link and another company shows no link.
 *
 * Run: node tests/r12-google-review-link-2026-11-26.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const FN = path.join(__dirname, '..', 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let G = null;
try { G = require(path.join(FN, 'google-review-url.js')); } catch (e) { ok('functions/google-review-url.js exists', false, e.message); }
const RA = require(path.join(FN, 'review-ask-auto-logic.js'));
const NBD_LEAD = { companyId: RA.NBD_OWNER_UID, userId: RA.NBD_OWNER_UID };
const OTHER_LEAD = { companyId: 'co-x', userId: 'rep-x' };

console.log('A. the allowlist');
{
  const good = [
    'https://g.page/r/CXzIjLwvtRPdEBM/review',
    'https://g.page/r/rep/review',
    'https://g.page/r/CXzIjLwvtRPdEBM',
    'https://search.google.com/local/writereview?placeid=ChIJacme1234567',
    'https://maps.app.goo.gl/AbCd1234',
    'https://www.google.com/maps/place/Acme+Roofing/@39.1,-84.5,17z',
  ];
  const bad = [
    'https://evil.example/review', 'https://bit.ly/abc123', 'http://g.page/r/CXzIjLwvtRPdEBM/review', 'javascript:alert(1)',
    'https://g.page.evil.example/r/x/review', 'https://evil.example/?u=https://g.page/r/x/review', 'https://g.page/r/x/review"><script>',
    'https://search.google.com/local/writereview?placeid=ChIJacme1234567&redirect=https://evil.example', 'https://google.com.evil.example/maps/place/x',
    'https://www.google.com/url?q=https://evil.example', ' ', '', null, 42,
  ];
  if (G) {
    ok('Google review / Maps pages pass', good.every((u) => G.isGoogleReviewUrl(u)), good.filter((u) => !G.isGoogleReviewUrl(u)).join(' , '));
    for (const u of bad) ok('refused: ' + JSON.stringify(u).slice(0, 70), !G.isGoogleReviewUrl(u));
    ok('surrounding spaces are trimmed, not a reason to refuse', G.cleanReviewUrl('  https://g.page/r/CXzIjLwvtRPdEBM/review  ') === 'https://g.page/r/CXzIjLwvtRPdEBM/review');
    ok('cleanReviewUrl answers "" for anything else', G.cleanReviewUrl('https://evil.example/x') === '');
  }
}

console.log('B. the live review-ask email (review-ask-auto-logic.js reviewUrlFor)');
{
  ok('NBD: a rep\'s non-Google https link → NBD\'s own review link, never the saved one',
    RA.reviewUrlFor(NBD_LEAD, 'https://evil.example/review') === RA.NBD_REVIEW_URL, RA.reviewUrlFor(NBD_LEAD, 'https://evil.example/review'));
  ok('NBD: a rep\'s Google review link is used', RA.reviewUrlFor(NBD_LEAD, 'https://g.page/r/rep/review') === 'https://g.page/r/rep/review');
  ok('another company: a non-Google link → no link at all', RA.reviewUrlFor(OTHER_LEAD, 'https://evil.example/review') === '');
  ok('another company: its Google link is used', RA.reviewUrlFor(OTHER_LEAD, 'https://search.google.com/local/writereview?placeid=ChIJacme1234567') === 'https://search.google.com/local/writereview?placeid=ChIJacme1234567');
}

console.log('C. the portal review button and the agent review sprint use the same allowlist');
{
  const portal = strip(fs.readFileSync(path.join(FN, 'portal.js'), 'utf8'));
  const fnBody = (portal.match(/function portalReviewUrl\([^)]*\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  ok('control: found portalReviewUrl', fnBody.length > 40);
  ok('portalReviewUrl checks the Google allowlist', /isGoogleReviewUrl|cleanReviewUrl/.test(fnBody), fnBody.slice(0, 200));
  ok('portalReviewUrl no longer accepts any http(s) link', !/\^https\?:/.test(fnBody), fnBody.slice(0, 200));
  const agent = strip(fs.readFileSync(path.join(FN, 'agent-mcp.js'), 'utf8'));
  ok('the agent review sprint resolves the link through RA.reviewUrlFor (covered by B)', /RA\.reviewUrlFor\(/.test(agent));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
