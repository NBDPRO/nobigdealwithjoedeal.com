/**
 * tests/adminai-paid-gate-2026-11-14.test.js
 *
 * adminAI (functions/handlers/ai.js) admits company_admin and manager, and
 * createCompany makes every self-serve signup company_admin of its own
 * company. Before 2026-11-14 it had no email-verified or paid-plan gate, so
 * any free account was a 60-call/hour Anthropic proxy on the platform key.
 * It must apply claudeProxy's gates (verified email + a paid plan on the
 * caller's company, platform admin exempt) BEFORE the vendor fetch.
 *
 * Run: node tests/adminai-paid-gate-2026-11-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const raw = fs.readFileSync(path.join(ROOT, 'functions', 'handlers', 'ai.js'), 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const start = src.indexOf('exports.adminAI');
const end = src.indexOf('\nexports.', start + 10);
const body = start === -1 ? '' : src.slice(start, end === -1 ? undefined : end);

console.log('\nadminAI gates');
ok('adminAI found', body.length > 500);
const roleGate = body.indexOf('ADMIN_AI_ROLES.has(role)');
const emailGate = body.search(/decoded\.email_verified !== true/);
const subRead = body.search(/doc\(`subscriptions\/\$\{decoded\.companyId \|\| decoded\.uid\}`\)\.get\(\)/);
const paidCheck = body.search(/sub\.plan !== 'free' && \(sub\.status === 'active' \|\| sub\.status === 'trialing'\)/);
const vendor = body.indexOf("fetch('https://api.anthropic.com/v1/messages'");
ok('role gate still present', roleGate !== -1);
ok('email-verified gate present', emailGate !== -1);
ok('reads the COMPANY subscription (companyId claim, uid for a solo owner)', subRead !== -1);
ok('requires a paid, active or trialing plan', paidCheck !== -1);
ok('gates run before the vendor fetch', vendor !== -1 && emailGate !== -1 && subRead !== -1 && paidCheck !== -1
  && emailGate < vendor && subRead < vendor && paidCheck < vendor);
ok('…and after the role gate', roleGate !== -1 && emailGate > roleGate && subRead > roleGate);
const exempt = body.slice(roleGate, emailGate === -1 ? roleGate : emailGate);
ok('only the platform admin and the platform tenant are exempt', /if \(role !== 'admin' && !isPlatformTenant\) \{/.test(exempt));
ok('the platform tenant is NBD\'s own uid / company only (never a role)',
  /const isPlatformTenant = decoded\.uid === PLATFORM_UID \|\| decoded\.companyId === PLATFORM_UID;/.test(exempt)
  && /const PLATFORM_UID = process\.env\.NBD_OWNER_UID \|\| '[A-Za-z0-9]{20,}';/.test(exempt));
// Each refusal returns before anything else runs.
ok('an unverified email is refused with 403 and returns', /email_verified !== true\) \{\s*res\.status\(403\)[\s\S]{0,120}?return;/.test(body));
ok('a failed plan read fails closed (503) and returns', /subscriptions\/\$\{decoded\.companyId \|\| decoded\.uid\}`\)\.get\(\);\s*\} catch \(e\) \{[\s\S]{0,200}?res\.status\(503\)[\s\S]{0,120}?return;/.test(body));
ok('a free / lapsed plan is refused with 403 and returns', /if \(!paid\) \{\s*res\.status\(403\)[\s\S]{0,120}?return;/.test(body));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
