/**
 * tests/appcheck-onrequest-contract.test.js
 *
 * WHY THIS EXISTS
 * `enforceAppCheck: true` is honoured by firebase-functions on `onCall` ONLY.
 * On `onRequest` it is silently ignored: HttpsOptions is declared
 * `Omit<GlobalOptions, 'region'|'enforceAppCheck'>`, the onRequest wrapper
 * never reads the field, and it is not serialized into the deployed endpoint,
 * so there is no platform-side fallback either.
 *
 * That made it worse than useless. 16 onRequest handlers carried it, two of
 * them — publicVisualizerAI and publicFunnelAI — completely unauthenticated
 * relays to the Anthropic API on the platform key, whose own comments named it
 * as the primary abuse control. A reviewer reading the options object would
 * conclude the endpoint was attested when nothing was checking.
 *
 * The repo had already learned this once (handlers/integrations.js documents
 * removing the same dead option from submitPublicLead) and it grew back
 * elsewhere. Hence a tripwire rather than a one-time cleanup.
 *
 * Zero deps. Run: node tests/appcheck-onrequest-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name); }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(FUNCTIONS);

console.log('APP CHECK / onRequest CONTRACT');

// Non-vacuity: the scan must actually be reading the backend.
ok(`scan set is non-empty (${files.length} .js files under functions/)`, files.length > 50);

// ── 1. No onRequest declaration may carry enforceAppCheck ────────────────
// Match the OPTION line only (`enforceAppCheck: true,`), never prose in a
// comment — several comments deliberately discuss the option's absence, and
// flagging those would make the guard un-silenceable and get it switched off.
const offenders = [];
let onCallSites = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*enforceAppCheck\s*:\s*true\s*,?\s*$/.test(lines[i])) continue;
    let kind = null;
    for (let j = i; j >= 0 && j > i - 60; j--) {
      const m = lines[j].match(/\b(onCall|onRequest|onSchedule|onDocument\w*|onObject\w*|beforeUser\w*)\s*\(/);
      if (m) { kind = m[1]; break; }
    }
    if (kind === 'onCall') { onCallSites++; continue; }
    offenders.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${i + 1}${kind ? ` (${kind})` : ' (unclassified)'}`);
  }
}
ok(`no enforceAppCheck option on a non-onCall trigger (found: ${offenders.slice(0, 6).join(', ') || 'none'})`,
  offenders.length === 0);

// Non-vacuity for the check above: onCall sites DO still carry it, so a
// refactor that strips the option everywhere (removing real protection from
// the callables) fails here instead of passing quietly.
ok(`onCall handlers still declare enforceAppCheck (${onCallSites} sites) — check above is not vacuous`,
  onCallSites > 30);

// ── 2. Per-IP limiting must collapse IPv6 to /64 ─────────────────────────
// A raw-address key turns an hourly cap into no cap for anyone on an ordinary
// residential IPv6 allocation (2^64 addresses = 2^64 buckets).
const rl = require(path.join(FUNCTIONS, 'rate-limit.js'));
ok('rate-limit.js exports rateLimitIpKey', typeof rl.rateLimitIpKey === 'function');

if (typeof rl.rateLimitIpKey === 'function') {
  const k = rl.rateLimitIpKey;
  ok('IPv4 passes through unchanged', k('203.0.113.7') === '203.0.113.7');
  ok('two addresses in one /64 collapse to the same bucket',
    k('2001:db8:1234:5678:0:0:0:1') === k('2001:db8:1234:5678:ffff:ffff:ffff:ffff'));
  ok('different /64s stay in different buckets',
    k('2001:db8:1234:5678::1') !== k('2001:db8:1234:9999::1'));
  ok('compressed :: form is expanded before slicing',
    k('2001:db8::1') === k('2001:db8:0:0:abcd::9'));
  ok('zone id is stripped', k('fe80::1%eth0') === k('fe80::2'));
  ok('empty / unknown input does not throw and stays stable',
    k('') === '' && k(undefined) === '');
}

// The shared HTTP limiter must apply it, so a new endpoint cannot be added
// without the protection by simply forgetting to call the helper.
const rlSrc = fs.readFileSync(path.join(FUNCTIONS, 'rate-limit.js'), 'utf8');
const httpBody = rlSrc.slice(rlSrc.indexOf('async function httpRateLimit'));
ok('httpRateLimit keys on rateLimitIpKey(clientIp(req)), not raw clientIp',
  /enforceRateLimit\(\s*namespace\s*,\s*rateLimitIpKey\(\s*clientIp\(req\)\s*\)/.test(httpBody));

const upstashSrc = fs.readFileSync(path.join(FUNCTIONS, 'integrations', 'upstash-ratelimit.js'), 'utf8');
// The Upstash backend was removed 2026-10-04; the entry point now hands every
// HTTP call to rate-limit.js's httpRateLimit (checked above), so it inherits
// the /64 keying instead of re-deriving the key itself.
ok('the limiter entry point delegates HTTP limiting to rate-limit.js (inherits /64)',
  /firestoreLimiter\.httpRateLimit\(\s*req\s*,/.test(upstashSrc)
  && !/clientIp\(req\)/.test(upstashSrc.replace(/^\s*(\/\/|\*).*$/gm, '')));

// ── 3. The two unauthenticated AI relays must stay documented as such ────
// Their headers previously asserted a control that did not exist. If someone
// reinstates that claim, a future reviewer is misled again.
const aiSrc = fs.readFileSync(path.join(FUNCTIONS, 'handlers', 'ai.js'), 'utf8');
ok('ai.js no longer claims enforceAppCheck blocks curl replay',
  !/enforceAppCheck:\s*true\s*\(blocks curl/i.test(aiSrc));
ok('ai.js states plainly that the public endpoints are unauthenticated',
  /UNAUTHENTICATED/.test(aiSrc));

console.log('\n' + '─'.repeat(50));
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  for (const f of fails) console.log('  - ' + f);
  console.log(`
enforceAppCheck is honoured on onCall ONLY. If you added it to an onRequest
handler, it is doing nothing — gate that endpoint with a signature check, an
ID token, or a per-IP limit instead, and say so in the handler's header.`);
  process.exit(1);
}
process.exit(0);
