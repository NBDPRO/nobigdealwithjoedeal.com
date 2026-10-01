/**
 * tests/security-checklist-2026-10-01.test.js
 *
 * Jo ran an outside security checklist past the repo (2026-10-01). Four
 * read-only audits plus spot checks; the confirmed gaps were fixed together.
 * One check per fix, behaviour where it can run in Node, source pins where
 * the code lives inside a Cloud Function handler. Write-up:
 * documentation/audit/SECURITY-CHECKLIST-2026-10-01.md
 *
 * Run: node tests/security-checklist-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Comments stripped, so a note naming the old code can't satisfy a check.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('\n1. owner powers need a VERIFIED owner email (or the owner claim)');
{
  const { isOwnerCaller } = require(path.join(ROOT, 'functions', 'handlers', '_shared.js'));
  ok('the owner claim admits (Jo\'s real account carries it)', isOwnerCaller({ owner: true }) === true);
  ok('an owner email that Google has verified admits', isOwnerCaller({ email: 'jd@nobigdealwithjoedeal.com', email_verified: true }) === true);
  ok('the SAME email unverified is refused (anyone could self-register it)', isOwnerCaller({ email: 'jonathandeal459@gmail.com', email_verified: false }) === false
    && isOwnerCaller({ email: 'jonathandeal459@gmail.com' }) === false);
  ok('a verified non-owner email is refused', isOwnerCaller({ email: 'someone@example.com', email_verified: true }) === false);
}

console.log('\n2. the generic email sender needs a verified address');
{
  const src = code('functions/email-functions.js');
  const gate = src.indexOf("if (decoded.email_verified !== true) {");
  const send = src.indexOf('resend.emails.send(');
  ok('unverified senders get 403 email_unverified, before any send', gate > 0 && send > gate && /code: 'email_unverified'/.test(src));
}

console.log('\n3. Cal.com bookings match the organizer email before the self-set username');
{
  const src = code('functions/integrations/calcom.js');
  const byEmail = src.indexOf('getAuth().getUserByEmail(organizerEmail)');
  const byUser = src.indexOf("where('calcomUsername', '==', organizerUsername)");
  ok('email first, username only as the fallback', byEmail > 0 && byUser > byEmail && /if \(!repUid && organizerUsername\)/.test(src));
  ok('a username claimed by more than one account assigns nobody', /\.limit\(2\)\.get\(\);\s*if \(q\.size === 1\)/.test(src));
}

console.log('\n4. the public AI endpoints have a whole-endpoint daily cap');
{
  const src = code('functions/handlers/ai.js');
  ok('publicFunnelAI and publicVisualizerAI both call publicAiDailyCap after their per-IP cap',
    /'publicFunnelAI:ip', 10, 3_600_000\)\)\) return;\s*if \(!\(await publicAiDailyCap\(res, 'publicFunnelAI'\)\)\) return;/.test(src)
    && /'publicVisualizerAI:ip', 5, 3_600_000\)\)\) return;\s*if \(!\(await publicAiDailyCap\(res, 'publicVisualizerAI'\)\)\) return;/.test(src));
  ok('one counter for everyone (fixed key), 300/day default, refuses when the store fails',
    /enforceRateLimit\(name \+ ':global', 'GLOBAL_DAILY', cap, 86_400_000\)/.test(src) && /: 300;/.test(src) && /res\.status\(503\)/.test(src));
}

console.log('\n5. .gitignore keeps every env / key / credential shape out of the public repo');
{
  const probe = ['.env.staging', 'functions/.env.dev', 'functions/.runtimeconfig.json', 'key.pem', 'functions/service-account.json', 'x/gcp-credentials.json', 'a.p12'];
  const ignored = (p) => { try { execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: ROOT, stdio: 'ignore' }); return true; } catch (_) { return false; } };
  const miss = probe.filter((p) => !ignored(p));
  ok('all ignored: ' + probe.join(', '), miss.length === 0, 'not ignored: ' + miss.join(', '));
  ok('the one tracked, non-secret env file stays tracked', !ignored('functions/.env.nobigdeal-pro'));
}

console.log('\n6. no customer email / phone in function logs');
{
  const fr = code('functions/funnel-recovery.js');
  const logCalls = fr.match(/logger\.\w+\('funnel_recovery_[a-z_]+', \{[\s\S]*?\}\);/g) || [];
  ok('funnel recovery logs a masked email (both sites), and no log call carries the raw one',
    (fr.match(/email: require\('\.\/email-suppression'\)\.maskEmail\(data\.email\)/g) || []).length === 2
    && logCalls.length > 0 && !logCalls.some((c) => /email: data\.email/.test(c)), logCalls.filter((c) => /email: data\.email/.test(c)).join('\n'));
  ok('claimInvite logs a masked email', /email: require\('\.\.\/email-suppression'\)\.maskEmail\(email\)/.test(code('functions/handlers/invites.js')));
  ok('the Thursday webhook logs the last 4 digits only', /toLast4: String\(call\.to \|\| ''\)/.test(code('functions/integrations/thursday.js')) && !/to: call\.to/.test(code('functions/integrations/thursday.js')));
  const M = require(path.join(ROOT, 'functions', 'email-suppression.js'));
  ok('maskEmail hides the mailbox and domain', M.maskEmail('jane.doe@example.com') === 'ja***@e***.com');
}

console.log('\n7. the referral form strips and caps public input');
{
  const src = code('functions/referrals.js');
  ok('every stored field goes through noAngle and a length cap', /const phone\s+= noAngle\(body\.phone\)\.slice\(0, 40\);/.test(src)
    && /const email\s+= String\(body\.email \|\| ''\)\.trim\(\)\.slice\(0, 254\);/.test(src) && /const notes\s+= noAngle\(body\.notes\)\.slice\(0, 600\);/.test(src));
  const vm = require('vm');
  const sb = {}; vm.createContext(sb);
  vm.runInContext(src.match(/function validEmail\(s\) \{[^\n]*\}/)[0] + '\nthis.v = validEmail;', sb);
  ok('the email check refuses < > and quotes', sb.v('a@b.co') && !sb.v('<x>@b.co') && !sb.v('a@b.co"><img') && !sb.v("a'@b.co"));
}

console.log('\n8. document uploads take raster images only (no SVG)');
{
  const rules = read('storage.rules');
  const m = rules.match(/function isDocType\(\) \{[\s\S]*?\}/);
  ok('isDocType lists the raster types and no longer image/.+', m && /image\/\(jpeg\|png\|webp\|heic\|heif\|avif\|gif\)/.test(m[0]) && !/image\/\.\+/.test(m[0]));
}

console.log('\n9. the homeowner-view token is cached for the session only');
{
  const src = code('docs/pro/js/customer-bootstrap.module.js');
  ok('read + write go to sessionStorage; the old localStorage copies are removed',
    /const raw = sessionStorage\.getItem\(cacheKey\);/.test(src) && /sessionStorage\.setItem\(cacheKey, JSON\.stringify\(\{ token, expiresAt \}\)\)/.test(src)
    && !/localStorage\.setItem\(cacheKey/.test(src) && /for \(const k of \[legacyKey, cacheKey\]\)/.test(src));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
