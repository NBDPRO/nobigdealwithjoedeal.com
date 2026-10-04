/**
 * tests/secret-stub-guard.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * The deploy stubs every declared secret with the literal `__unset__` so the
 * Firebase CLI can bind it. `'__unset__'` is a truthy nine-character string.
 * The registry's hasSecret() knows that; a BARE defineSecret() param guarded
 * with plain truthiness does not. On 2026-09-04 the stability audit found
 * four deployed functions believing they were configured when they were not:
 * the Places widget asked Google for `places/__unset__` on every refresh, the
 * lead alert would text the phone number "__unset__" instead of Jo's fallback,
 * and every `EMAIL_FROM.value() || 'noreply@…'` would have sent from
 * "__unset__" had that secret ever been stubbed.
 *
 * functions/integrations/_shared.js now exports secretValue()/secretOr() for
 * bare params. This pins their semantics and — the part that matters for the
 * future — fails CI when a `.value() ||` / `.value() ??` fallback reappears
 * anywhere under functions/ outside a small allowlist of sites that validate
 * the value's PREFIX (`price_`, `whsec_`) and are therefore stub-safe.
 *
 * Pure-Node. Run: node tests/secret-stub-guard.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const shared = require(path.join(FUNCTIONS, 'integrations', '_shared.js'));
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '').replace(/\s\/\/[^\n]*$/mg, '');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out); else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const param = (v) => ({ value: () => v });

console.log('\nsecretValue() — the stub is unset, whitespace is trimmed, nothing throws');
{
  ok('a real value is returned trimmed', shared.secretValue(param('  AIza-real-key \n')) === 'AIza-real-key');
  ok("the deploy stub '__unset__' → null", shared.secretValue(param('__unset__')) === null);
  ok("'  __unset__  ' (stub with whitespace) → null", shared.secretValue(param('  __unset__  ')) === null);
  ok('empty string → null', shared.secretValue(param('')) === null);
  ok('whitespace only → null', shared.secretValue(param('   ')) === null);
  ok('non-string (undefined, the unbound-param case) → null', shared.secretValue(param(undefined)) === null);
  ok('a param whose .value() throws (not bound to this function) → null, no throw', shared.secretValue({ value: () => { throw new Error('not bound'); } }) === null);
  ok('null / garbage param → null', shared.secretValue(null) === null && shared.secretValue({}) === null);
  ok('SECRET_STUB_VALUE is exported and is the literal the deploy writes', shared.SECRET_STUB_VALUE === '__unset__');
}

console.log('\nsecretOr() — the fallback beats the stub, a real value beats the fallback');
{
  ok('stub → fallback', shared.secretOr(param('__unset__'), '+18594207382') === '+18594207382');
  ok('empty → fallback', shared.secretOr(param(''), 'noreply@x') === 'noreply@x');
  ok('real → real (trimmed)', shared.secretOr(param(' jd@x '), 'noreply@x') === 'jd@x');
  ok('throwing param → fallback', shared.secretOr({ value: () => { throw new Error('x'); } }, 'fb') === 'fb');
  ok("the bug this replaces: '__unset__' || fallback would have kept the stub", ('__unset__' || 'fb') === '__unset__');
}

console.log('\nSOURCE CONTRACT — no bare truthiness fallback on a secret outside the prefix-validated allowlist');
{
  // Sites allowed to keep `.value() ||`: each validates the value's prefix on
  // the same or an adjacent line, so the stub can never pass.
  const ALLOW = {
    'handlers/seats.js': { count: 4, mustMatch: /startsWith\('price_'\)/ },
    'handlers/stripe-connect.js': { count: 1, mustMatch: /startsWith\('whsec_'\)/ },
  };
  const offenders = [];
  const seen = {};
  for (const f of walk(FUNCTIONS)) {
    const rel = path.relative(FUNCTIONS, f).replace(/\\/g, '/');
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    const hits = (src.match(/\.value\(\)\s*(\|\||\?\?)/g) || []).length;
    if (!hits) continue;
    seen[rel] = hits;
    const rule = ALLOW[rel];
    if (!rule) { offenders.push(rel + ' ×' + hits); continue; }
    if (hits > rule.count) offenders.push(rel + ' ×' + hits + ' (allowed ' + rule.count + ')');
    if (!rule.mustMatch.test(src)) offenders.push(rel + ' lost its prefix check');
  }
  ok('zero `.value() ||` / `.value() ??` fallbacks outside the allowlist', offenders.length === 0, offenders.join('; '));
  ok('the allowlisted files still exist and still use the pattern (else prune the allowlist)',
     Object.keys(ALLOW).every((k) => seen[k] > 0), JSON.stringify(seen));

  // The other spelling of the same bug: `try { x = X.value(); } catch {}` then
  // `if (!x)`. Four sites had it (three Anthropic keys, one Geocoding key that
  // IS the stub in prod). None may come back.
  const tryCatchReads = [];
  for (const f of walk(FUNCTIONS)) {
    const rel = path.relative(FUNCTIONS, f).replace(/\\/g, '/');
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    const n = (src.match(/=\s*[A-Z][A-Z0-9_]*\.value\(\);\s*\}\s*catch/g) || []).length;
    if (n) tryCatchReads.push(rel + ' ×' + n);
  }
  ok('zero `try { x = SECRET.value(); } catch` bare reads', tryCatchReads.length === 0, tryCatchReads.join('; '));

  // Whoever calls secretValue/secretOr must import it from the REGISTRY
  // (integrations/_shared). functions/handlers/_shared.js is a different
  // module with the same basename and does not export them — a handler that
  // adds `secretValue` to its `require('./_shared')` destructuring loads fine
  // and throws TypeError at call time. (Caught in review on 2026-09-04.)
  const badImports = [];
  for (const f of walk(FUNCTIONS)) {
    const rel = path.relative(FUNCTIONS, f).replace(/\\/g, '/');
    if (rel === 'integrations/_shared.js') continue;
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    if (!/\bsecret(Value|Or)\(/.test(src)) continue;
    const inIntegrations = rel.startsWith('integrations/');
    const fromRegistry = inIntegrations
      ? /\bsecret(Value|Or)\b[^\n]*require\(\s*['"]\.\/_shared['"]\s*\)/.test(src)
      : /\bsecret(Value|Or)\b[^\n]*require\(\s*['"](\.\/|\.\.\/)integrations\/_shared['"]\s*\)/.test(src);
    if (!fromRegistry) badImports.push(rel);
  }
  ok('every secretValue/secretOr caller imports it from integrations/_shared (not handlers/_shared)', badImports.length === 0, badImports.join(', '));

  // Bare `if (!X.value())` / `try { x = X.value() } catch {}; if (!x)` guards
  // on the four audited functions are gone.
  const gr = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'google-reviews.js'), 'utf8'));
  ok('google-reviews reads both Places secrets via secretValue', /secretValue\(NBD_PLACE_ID\)/.test(gr) && /secretValue\(GOOGLE_PLACES_API_KEY\)/.test(gr));
  ok('google-reviews has no bare .value() read left', !/\.value\(\)/.test(gr));
  const vm = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'integrations', 'voice-memo.js'), 'utf8'));
  // 2026-10-04: voice-memo moved from Deepgram to Groq. It gates on the
  // registry hasSecret() like dictate and binds no Deepgram secret at all.
  ok('voice-memo gates on the registry hasSecret(GROQ_API_KEY), no Deepgram left', /hasSecret\(\s*'GROQ_API_KEY'\s*\)/.test(vm) && !/DEEPGRAM/.test(vm) && !/GROQ_API_KEY\.value\(\)/.test(vm));
  const vf = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'verify-functions.js'), 'utf8'));
  ok("notifyNewLead: Jo's phone falls back through secretOr", /secretOr\(JOE_PHONE_SECRET,\s*JOE_PHONE_FALLBACK\)/.test(vf));
  ok("notifyNewLead: Jo's email falls back through secretOr", /secretOr\(JOE_EMAIL_SECRET,\s*JOE_EMAIL_FALLBACK\)/.test(vf));
  ok('notifyNewLead: EMAIL_FROM falls back through secretOr', /secretOr\(EMAIL_FROM,/.test(vf));
  const di = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'dictate.js'), 'utf8'));
  ok('dictate (fixed in #1385) still gates on the registry hasSecret()', /hasSecret\(\s*'GROQ_API_KEY'\s*\)/.test(di) && !/DEEPGRAM_API_KEY\.value\(\)/.test(di));

  // ── Bare .value() on a webhook/signing secret (2026-09-14) ──
  // The two checks above catch a `.value() ||` / `.value() ??` fallback and a
  // `try { x = X.value() } catch` spelling. Neither catches the plain
  // `const webhookSecret = STRIPE_WEBHOOK_SECRET.value();` spelling — no
  // fallback operator, no try/catch, nothing for either regex to match —
  // which is exactly how stripeWebhook handed '__unset__' straight to
  // stripe.webhooks.constructEvent() as the HMAC key: anyone who signs a
  // payload with that public, documented stub literal would have verified.
  // Any secret named *_WEBHOOK_SECRET / *_SIGNING_SECRET exists to verify a
  // signature, so a bare read on one is ALWAYS wrong regardless of spelling —
  // the caller must route it through secretValue()/secretOr() (or an
  // already-validated `?? '' ` + prefix check, the one stripe-connect.js
  // case the rule above already allows).
  const WEBHOOK_SECRET_NAME = /^[A-Z][A-Z0-9_]*_(WEBHOOK|SIGNING)_SECRET$/;
  const bareWebhookSecretReads = [];
  for (const f of walk(FUNCTIONS)) {
    const rel = path.relative(FUNCTIONS, f).replace(/\\/g, '/');
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    const re = /\b([A-Z][A-Z0-9_]*)\.value\(\)/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (!WEBHOOK_SECRET_NAME.test(name)) continue;
      const after = src.slice(re.lastIndex, re.lastIndex + 6);
      if (/^\s*(\|\||\?\?)/.test(after)) continue; // already-validated fallback, covered above
      bareWebhookSecretReads.push(rel + ': ' + name + '.value()');
    }
  }
  ok('zero bare .value() reads on a *_WEBHOOK_SECRET / *_SIGNING_SECRET param (no fallback, no secretValue())',
    bareWebhookSecretReads.length === 0, bareWebhookSecretReads.join('; '));

  // Every EMAIL_FROM sender goes through secretOr.
  let emailFromBare = 0, emailFromSafe = 0;
  for (const f of walk(FUNCTIONS)) {
    const src = codeOnly(fs.readFileSync(f, 'utf8'));
    emailFromBare += (src.match(/EMAIL_FROM\.value\(\)/g) || []).length;
    emailFromSafe += (src.match(/secretOr\(EMAIL_FROM,/g) || []).length;
  }
  ok('no bare EMAIL_FROM.value() remains', emailFromBare === 0, String(emailFromBare));
  ok('at least the seven known EMAIL_FROM senders use secretOr', emailFromSafe >= 7, String(emailFromSafe));

  const sharedSrc = codeOnly(fs.readFileSync(path.join(FUNCTIONS, 'integrations', '_shared.js'), 'utf8'));
  ok('_shared exports secretValue and secretOr', /secretValue,\s*\n\s*secretOr,/.test(sharedSrc) || (/\bsecretValue\b/.test(sharedSrc.slice(sharedSrc.indexOf('module.exports'))) && /\bsecretOr\b/.test(sharedSrc.slice(sharedSrc.indexOf('module.exports')))));
  ok('hasSecret and secretValue agree on the stub', shared.hasSecret('THIS_SECRET_DOES_NOT_EXIST') === false && shared.secretValue(param(shared.SECRET_STUB_VALUE)) === null);

  // ── hasSecret must not call .value() on an UNBOUND secret (2026-09-06) ──
  // SecretParam.value() logs a WARNING whenever the secret is not bound to the
  // calling function. Because this registry is module scope, that fired 500+
  // times in 24h across 12+ services for UPSTASH_REDIS_REST_URL alone, which
  // would have buried rate_limit_provider_drift — the warning that exists to
  // catch a REAL Upstash misconfiguration. hasSecret now reads process.env,
  // which is the SAME source .value() reads (params/types.js runtimeValue()).
  // Scope to hasSecret's own body: getSecret() still calls .value() and SHOULD,
  // because it only runs after hasSecret confirmed the secret is bound — so it
  // can never be the unbound case that warns.
  const hasSecretBody = (sharedSrc.match(/function hasSecret\(name\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  ok('hasSecret reads process.env, not .value(), so unbound secrets stay quiet',
    /process\.env\[name\]/.test(hasSecretBody) && !/\.value\(\)/.test(hasSecretBody),
    hasSecretBody ? 'body found, assertion failed' : 'hasSecret body not matched');

  // Behaviour is genuinely unchanged — pin all four cases against the env.
  const PROBE = 'NBD_TEST_PROBE_SECRET';
  const restore = process.env[PROBE];
  shared.SECRETS[PROBE] = param('ignored — hasSecret must consult the env');
  try {
    delete process.env[PROBE];
    ok('unbound (env absent) reads as not configured', shared.hasSecret(PROBE) === false);
    process.env[PROBE] = shared.SECRET_STUB_VALUE;
    ok('the deploy __unset__ stub still reads as not configured', shared.hasSecret(PROBE) === false);
    process.env[PROBE] = '   ';
    ok('whitespace-only still reads as not configured', shared.hasSecret(PROBE) === false);
    process.env[PROBE] = '  real-value  ';
    ok('a real value reads as configured (and is trimmed)', shared.hasSecret(PROBE) === true);
  } finally {
    delete shared.SECRETS[PROBE];
    if (restore === undefined) delete process.env[PROBE]; else process.env[PROBE] = restore;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
