/**
 * tests/smoke/auth.test.js — auth, access codes, App Check, GDPR,
 * webhook signing, rate-limit provider, admin gates.
 *
 * Domain bucket: signup / auth bypass / SMS+email+budget gates / admin
 * MFA / lead allowlist / rate-limit provider / signature verification /
 * payload caps / signImageUrl strip / Turnstile / GDPR cascade + export
 * / clientIp / deploy bundle hygiene.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, PRO_JS, FUNCTIONS, read, readDashboard, readFunctionsIndex, readPortal, syntaxCheck } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

// ── C-1: invite role allowlist ──────────────────────────────
section('C-1: onRepSignup allowlist');
{
  const src = readFunctionsIndex();
  assert('INVITE_ALLOWED_ROLES set defined',
    /INVITE_ALLOWED_ROLES = new Set\(\[/.test(src));
  assert("INVITE_ALLOWED_ROLES excludes 'admin'",
    /INVITE_ALLOWED_ROLES = new Set\(\['company_admin', 'manager', 'sales_rep', 'viewer'\]\)/.test(src));
  assert('onRepSignup clamps unknown role to sales_rep',
    /INVITE_ALLOWED_ROLES\.has\(requested\)[\s\S]{0,200}role = 'sales_rep'/.test(src));
  assert('onRepSignup fails closed on error (C-5)',
    /onRepSignup error — blocking signup[\s\S]{0,200}throw new HttpsError/.test(src));
}

// ── C-2: NBD-2026 and siblings stripped from shipped HTML ───
section('C-2: access-code hardcodes removed');
{
  const dashboard = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  const login     = read(path.join(ROOT, 'docs/pro/login.html'));
  assert('dashboard.html contains no NBD-2026', !dashboard.includes('NBD-2026'));
  assert('login.html contains no NBD-2026',      !login.includes('NBD-2026'));
  const seed = read(path.join(ROOT, 'scripts/seed-access-codes.js'));
  assert('seed script no longer hardcodes NBD-2026 entry',
    !/['"]NBD-2026['"]\s*:\s*\{/.test(seed));
  assert('seed script auto-deactivates legacy codes',
    /LEGACY_IDS\s*=\s*\[[^\]]*'NBD-2026'/.test(seed));
}

// ── C-3: public lead collections locked + gateway present ───
section('C-3: public form gate');
{
  const rules = read(path.join(ROOT, 'firestore.rules'));
  for (const col of ['guide_leads', 'contact_leads', 'estimate_leads', 'storm_alert_subscribers']) {
    assert('rules deny client writes to ' + col,
      new RegExp('match /' + col + '/\\{[^}]+\\}\\s*\\{[\\s\\S]{0,200}allow create, update, delete: if false').test(rules));
  }
  const fn = readFunctionsIndex();
  // Window widened 2000→3500 (2026-07-06): the truth-telling comment on
  // the config block (why enforceAppCheck is deliberately absent) sits
  // between the export and the rate-limit call.
  assert('submitPublicLead uses httpRateLimit',
    /submitPublicLead[\s\S]{0,3500}httpRateLimit\(req, res, 'publicLead:ip'/.test(fn));
  assert('submitPublicLead has honeypot field',
    /honeypot tripped/.test(fn));
  // Truth-telling contract (2026-07-06 punch item 2): the endpoint must
  // NOT carry enforceAppCheck — v2 onRequest IGNORES the option, so its
  // presence is dead config that reads as a protection which isn't there.
  // The real gates (rate limit, Turnstile, honeypot, M-04 allowlist) are
  // asserted above/below; this pins that the false claim can't return.
  {
    const m = fn.match(/exports\.submitPublicLead\s*=\s*onRequest\(([\s\S]{0,2500}?)async \(req, res\)/);
    assert('submitPublicLead does NOT claim enforceAppCheck (dead config on onRequest)',
      !!m && !/enforceAppCheck\s*:/.test(m[1].replace(/\/\/[^\n]*/g, '')));
  }
}

// ── C-4: App Check init in dashboard ────────────────────────
section('C-4: App Check initialization');
{
  const src = readDashboard();
  // Either provider is acceptable. Joe's prod key is reCAPTCHA Enterprise
  // (registered in Google Cloud Console, not the classic v3 admin), so the
  // import + provider must use ReCaptchaEnterpriseProvider, not the v3 one.
  // Test allows either to keep the suite tolerant if the project ever
  // switches back to a classic v3 site key.
  assert('imports initializeAppCheck + reCAPTCHA provider',
    /initializeAppCheck[\s\S]{0,120}ReCaptcha(V3|Enterprise)Provider/.test(src));
  assert('App Check init runs before getAuth',
    /initializeAppCheck[\s\S]{0,2000}getAuth\(app\)/.test(src));
  assert('Configurable via window.__NBD_APP_CHECK_KEY',
    /window\.__NBD_APP_CHECK_KEY/.test(src));
}

// ── H-3: tenant-scoped Storage access (now lives on signImageUrl) ──
// R-03 retired imageProxy. The same tenant-scoping matrix moved
// onto signImageUrl — caller must be the path's owner, a platform
// admin, or a manager/company_admin sharing the file-owner's
// companyId. The assertions below pin that behaviour on the
// successor endpoint.
section('H-3: signImageUrl tenant scoping (successor to imageProxy)');
{
  const src = readFunctionsIndex();
  assert('signImageUrl checks caller role is company_admin or manager',
    /\['manager', 'company_admin'\]\.includes\(callerRole\)/.test(src));
  assert('signImageUrl falls back to Firestore lookup if companyId claim missing',
    /signImageUrl[\s\S]{0,3000}users\/\$\{ownerUid\}/.test(src));
}

// ── H-4: audit triggers wired ───────────────────────────────
section('H-4: audit_log triggers');
{
  assert('audit-triggers.js exists',
    fs.existsSync(path.join(FUNCTIONS, 'audit-triggers.js')));
  const src = read(path.join(FUNCTIONS, 'audit-triggers.js'));
  for (const name of ['audit_users','audit_leads','audit_companies',
                       'audit_company_members','audit_access_codes','audit_subscriptions']) {
    assert('exports ' + name, new RegExp('exports\\.' + name + '\\s*=').test(src));
  }
  assert('redacts PII fields before logging',
    /PII_KEYS\s*=\s*\/[^/]*email[^/]*\//.test(src));
  assert('dedicated alert on invite doc setting role=admin',
    /security_admin_grant_attempt/.test(src));
  const idx = readFunctionsIndex();
  assert('index.js loads audit-triggers module',
    /require\(['"]\.\/audit-triggers['"]\)/.test(idx));
}

// ── H-5: per-company Claude budget ──────────────────────────
section('H-5: per-company Claude budget');
{
  const src = readFunctionsIndex();
  assert('CLAUDE_COMPANY_BUDGET table exists',
    /CLAUDE_COMPANY_BUDGET\s*=\s*\{/.test(src));
  // M2: per-company budget enforcement moved off the range-scan of
  // api_usage onto a materialized counter (api_usage_daily). The
  // per-call audit write still stamps companyId so drill-downs work.
  assert('claudeProxy uses per-company materialized daily counter (M2)',
    /doc\(`api_usage_daily\/\$\{dayKey\}__co__\$\{callerCompanyId\}`\)/.test(src));
  assert('claudeProxy uses per-uid materialized daily counter (M2)',
    /doc\(`api_usage_daily\/\$\{dayKey\}__uid__\$\{decoded\.uid\}`\)/.test(src));
  assert('claudeProxy stamps companyId on api_usage writes',
    /api_usage[\s\S]{0,400}companyId: callerCompanyId/.test(src));
  assert('api_usage_daily locked to admin SDK in rules (M2)',
    /match \/api_usage_daily\/\{docId\}[\s\S]{0,200}allow read: if isAdmin\(\)[\s\S]{0,80}allow write: if false/
      .test(read(path.join(ROOT, 'firestore.rules'))));
  const idx = read(path.join(ROOT, 'firestore.indexes.json'));
  assert('firestore index for (companyId, timestamp DESC) on api_usage',
    /"collectionGroup":\s*"api_usage"[\s\S]{0,200}"fieldPath":\s*"companyId"[\s\S]{0,200}"fieldPath":\s*"timestamp"[\s\S]{0,100}"order":\s*"DESCENDING"/.test(idx));
}

// ── M-1: email verification gate ────────────────────────────
section('M-1: email verification');
{
  const src = readFunctionsIndex();
  assert('claudeProxy requires email_verified before AI',
    /email_verified !== true[\s\S]{0,200}Verify your email/.test(src));
}

section('D6: GDPR export-my-data');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  assert('exportMyData callable defined', /exports\.exportMyData\s*=/.test(src));
  assert('limited to 2 exports per 24h', /exportMyData:uid[\s\S]{0,100}2,\s*24 \* 3_600_000/.test(src));
  assert('writes signed URL to docs/{uid}/', /docs\/\$\{uid\}\/gdpr-export/.test(src));
}

section('D7: GDPR two-step erasure');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  assert('requestAccountErasure + confirmAccountErasure exported',
    /exports\.requestAccountErasure\s*=/.test(src) && /exports\.confirmAccountErasure\s*=/.test(src));
  assert('confirmation token hashed before storage',
    /createHash\('sha256'\)\.update\(token\)\.digest\('hex'\)/.test(src));
  assert('cascade deletes user-owned docs',
    // M-01: query shape is now split across lines in the
    // registry-driven loop; allow whitespace/newlines between tokens.
    /where\(\s*ownerField,\s*'==',\s*uid\s*\)[\s\S]{0,40}\.limit\(500\)/.test(src)
    || /where\('userId',\s*'==',\s*uid\)[\s\S]{0,40}\.limit\(500\)/.test(src));
  assert('disables Auth account + revokes refresh tokens',
    /updateUser\(uid, \{ disabled: true \}\)[\s\S]{0,60}revokeRefreshTokens/.test(src));
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('account_erasures collection locked to admin SDK',
    /match \/account_erasures\/\{uid\}[\s\S]{0,120}allow read, write: if false/.test(rules));
  // F-01: confirmAccountErasure GET must be a static page (no state
  // change), POST must be gated behind a per-uid rate limit. Regression
  // would let enterprise mail scanners trigger irreversible deletion.
  // This was `GET … within 2000 chars … res.status(200).send`, and it reddened
  // on 2026-09-08 because the consent page gained a paragraph — a LENGTH change,
  // not a behaviour change (measured distance went 1.9k → 2.2k). Worse, the
  // window never tested the property the name claims: character distance says
  // nothing about whether the branch mutates state, so the assertion would have
  // stayed green if someone had added a delete inside it and removed a comment
  // to stay under budget. Slice the branch and check it for writes instead.
  {
    const gIdx = src.indexOf("if (req.method === 'GET')");
    const sIdx = src.indexOf('res.status(200).send', gIdx);
    const getBranch = gIdx >= 0 && sIdx > gIdx ? src.slice(gIdx, sIdx) : '';
    assert('F-01: confirmAccountErasure GET ends in a static send',
      getBranch.length > 0);
    const writes = ['.set(', '.update(', '.delete(', '.add(', 'deleteFiles',
      'updateUser', 'revokeRefreshTokens', 'recursiveDelete'];
    const found = writes.filter(w => getBranch.includes(w));
    assert('F-01: confirmAccountErasure GET does not trigger deletion',
      getBranch.length > 0 && found.length === 0,
      found.length ? 'state-changing calls in GET branch: ' + found.join(', ') : '');
  }
  assert('F-01: confirmAccountErasure rejects non-POST/GET',
    /if \(req\.method !== 'POST'\)[\s\S]{0,100}res\.status\(405\)/.test(src));
  assert('F-01: confirmAccountErasure per-uid rate limit',
    /enforceRateLimit\('confirmErasure:uid'/.test(src));
  assert('F-01: confirmAccountErasure per-ip rate limit',
    /httpRateLimit\([^)]*'confirmErasure:ip'/.test(src));
  assert('F-01: confirmAccountErasure CORS restricted to allowlist',
    /cors: CORS_ORIGINS[\s\S]{0,400}confirmAccountErasure/.test(src) ||
    /confirmAccountErasure[\s\S]{0,400}cors: CORS_ORIGINS/.test(src));
}

section('F-02: measurementWebhook signature verification');
{
  const src = read(path.join(FUNCTIONS, 'integrations/measurement.js'));
  assert('verifyWebhookHmac helper present',
    /function verifyWebhookHmac/.test(src));
  assert('timingSafeEqual compare of hmacs',
    /crypto\.timingSafeEqual/.test(src));
  assert('fails closed on unconfigured secret',
    /reason: 'secret-not-configured'/.test(src) &&
    /secret-not-configured' \? 503/.test(src));
  assert('rejects missing X-Hover-Signature',
    /x-hover-signature/.test(src));
  assert('rejects missing X-EV-Signature',
    /x-ev-signature/.test(src));
  const shared = read(path.join(FUNCTIONS, 'integrations/_shared.js'));
  assert('HOVER_WEBHOOK_SECRET registered',
    /HOVER_WEBHOOK_SECRET:\s*defineSecret\('HOVER_WEBHOOK_SECRET'\)/.test(shared));
  assert('EAGLEVIEW_WEBHOOK_SECRET registered',
    /EAGLEVIEW_WEBHOOK_SECRET:\s*defineSecret\('EAGLEVIEW_WEBHOOK_SECRET'\)/.test(shared));
}

section('F-03/F-04: admin analytics uses custom-claim gate');
{
  const src = read(path.join(ROOT, 'docs/admin/js/pages/analytics.js'));
  assert('F-03: analytics gate uses claims.role === admin',
    /claims\.role !== 'admin'/.test(src));
  assert('F-03: no email equality check survived',
    !/user\.email !==\s*'/.test(src));
  // F-04: the hardcoded admin emails must not appear in executable
  // code. Strip comments first so we don't flag the historical note
  // that explains the old bad pattern.
  const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert('F-04: hardcoded admin emails removed from code',
    !/jdeal@nobigdealsolutions\.com/.test(codeOnly) &&
    !/demo@nbdpro\.com/.test(codeOnly));
}

section('F-06: getHomeownerPortalView is POST-only');
{
  // L-03: moved to portal.js.
  const src = read(path.join(FUNCTIONS, 'portal.js'));
  // Grab the function block and assert GET is not accepted. Window
  // sized to tolerate the R-05 sizing-rationale comment that was
  // added inside the config object.
  const block = src.match(/exports\.getHomeownerPortalView[\s\S]{0,2000}/);
  assert('F-06: function block found', !!block);
  if (block) {
    assert('F-06: rejects non-POST',
      /if \(req\.method !== 'POST'\)[\s\S]{0,80}res\.status\(405\)/.test(block[0]));
    assert('F-06: token sourced from body, not query',
      /const token = \(req\.body && req\.body\.token\)/.test(block[0]));
  }
  const portal = readPortal();
  assert('F-06: portal.html uses POST + JSON body',
    /method:\s*'POST'[\s\S]{0,400}body:\s*JSON\.stringify\(\{\s*token\b[\s\S]{0,40}\}\)/.test(portal));
}

section('F-09: CSP report-uri + cspReport function');
{
  const src = readFunctionsIndex();
  assert('F-09: cspReport function exported',
    /exports\.cspReport\s*=\s*onRequest/.test(src));
  const fb = read(path.join(ROOT, 'firebase.json'));
  assert('F-09: report-uri directive wired',
    /report-uri \/cspReport/.test(fb));
  assert('F-09: /cspReport rewrite routes to function',
    /"source":\s*"\/cspReport"[\s\S]{0,200}"functionId":\s*"cspReport"/.test(fb));
}

section('C0: GDPR erasure cascade covers Storage + collectionGroups (registry-driven)');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  // The original C0 assertions pinned inline constants
  // (OWNED_COLLECTIONS / OWNED_COLLECTION_GROUPS / OWNED_STORAGE_PREFIXES).
  // Those moved to the single-source-of-truth registry in M-01/M-02.
  // Forward-looking checks that the cascade STILL reaches each class:
  assert('C0: erasure still runs collectionGroup query for userId==uid',
    /collectionGroup\(groupName\)[\s\S]{0,200}where\('userId', '==', uid\)/.test(src));
  assert('C0: erasure still calls bucket.deleteFiles with uid-keyed prefix',
    /bucket\.deleteFiles\(\s*\{[\s\S]{0,200}prefix:[\s\S]{0,80}uid[\s\S]{0,80}force: true/.test(src));
  // exportMyData now uses the same registry collectionGroup list
  // (COLLECTION_GROUPS_WITH_USERID), exercised in the M-02 section.
  assert('C0: exportMyData covers collectionGroup rows via the registry',
    /for \(const group of COLLECTION_GROUPS_WITH_USERID\)[\s\S]{0,400}collectionGroup\(group\)\.where\('userId', '==', uid\)/.test(src));
}

section('Q1: clientIp XFF parsing (F-13 follow-up)');
{
  // Live-load the function and actually exercise it. This is the one
  // place in smoke.test.js we run real code — clientIp is too
  // security-critical to trust regex on.
  const orig = process.env.NBD_TRUSTED_PROXY_HOPS;
  try {
    // Force the module to evaluate with the default 1-hop config.
    // (Node caches module state, so delete from require cache first.)
    delete process.env.NBD_TRUSTED_PROXY_HOPS;
    delete require.cache[require.resolve(path.join(FUNCTIONS, 'rate-limit.js'))];
    const { clientIp } = require(path.join(FUNCTIONS, 'rate-limit.js'));

    // Google External HTTPS LB appends `<client-ip>,<gfr-ip>` to any
    // inbound XFF. The real client is therefore always at index
    // `length - 2` (TRUSTED_PROXY_HOPS=1 default). Tests model the
    // production shape, not test-harness shapes.
    assert('Q1: two-entry XFF → client is left entry',
      clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' } }) === '1.2.3.4');
    assert('Q1: 3-entry XFF (attacker spoofed 1 value) → real client wins',
      clientIp({ headers: { 'x-forwarded-for': 'fake-spoof, 9.9.9.9, 10.0.0.1' } }) === '9.9.9.9');
    assert('Q1: deep spoof attempt still pins real client at LB-appended slot',
      clientIp({ headers: { 'x-forwarded-for': 'a,b,c,d, 5.5.5.5, 10.0.0.1' } }) === '5.5.5.5');
    assert('Q1: short chain (no LB append) falls back to socket IP',
      clientIp({ headers: { 'x-forwarded-for': '1.2.3.4' }, ip: '7.7.7.7' }) === '7.7.7.7');
    assert('Q1: missing XFF falls back to socket IP',
      clientIp({ ip: '7.7.7.7' }) === '7.7.7.7');
    assert('Q1: empty XFF falls back to socket IP',
      clientIp({ headers: { 'x-forwarded-for': '' }, ip: '8.8.8.8' }) === '8.8.8.8');
    assert('Q1: whitespace-only XFF falls back to socket IP',
      clientIp({ headers: { 'x-forwarded-for': '   ' }, ip: '8.8.8.8' }) === '8.8.8.8');

    // Source-level checks — the hop config must be bounded + overridable.
    const rlSrc = read(path.join(FUNCTIONS, 'rate-limit.js'));
    assert('Q1: trusted-hop count is configurable via env',
      /NBD_TRUSTED_PROXY_HOPS/.test(rlSrc));
    assert('Q1: trusted-hop count is clamped to a safe range',
      /v >= 0 && v <= 10/.test(rlSrc));
    assert('Q1: fallback chain reaches socket.remoteAddress',
      /socket\?\.remoteAddress/.test(rlSrc));
  } finally {
    if (orig === undefined) delete process.env.NBD_TRUSTED_PROXY_HOPS;
    else process.env.NBD_TRUSTED_PROXY_HOPS = orig;
  }
}

section('Q4: Turnstile fetch is aborted before handler budget expires');
{
  const src = read(path.join(FUNCTIONS, 'integrations/turnstile.js'));
  assert('Q4: verifyTurnstile passes an AbortSignal to fetch',
    /AbortSignal\.timeout\(\s*5000\s*\)/.test(src));
  assert('Q4: fail-closed on verifier error path preserved',
    /verify-error[\s\S]{0,60}fail CLOSED/i.test(src) ||
    /Fail CLOSED on verifier error/i.test(src));
}

section('Q3: admin MFA enforcement (feature-flag gated)');
{
  const src = readFunctionsIndex();
  assert('Q3: beforeUserSignedIn imported',
    /beforeUserSignedIn\s*[,}]/.test(src));
  // Q3 trigger body is present but NOT exported. Corrected 2026-08-17:
  // this is NOT a "one-time console/IAM action" away. Blocking functions
  // are GCIP-only and nobigdeal-pro is subtype FIREBASE_AUTH, so the
  // registration call fails with OPERATION_NOT_ALLOWED on every deploy —
  // for the already-shipped beforeUserCreated trigger too. See
  // documentation/audit/BLOCKING-TRIGGERS-NOT-GCIP-2026-08-17.md.
  // The body is preserved as a private const so re-enablement (after a
  // GCIP upgrade) is a one-line diff.
  assert('Q3: trigger body preserved as private const (not exported)',
    /_beforeAdminSignInHandler\s*=\s*beforeUserSignedIn/.test(src));
  // Strip comments before checking — the runbook text mentions
  // "Uncomment the `exports.beforeAdminSignIn = ...` line below"
  // and we don't want that comment reference to match.
  const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert('Q3: trigger NOT on exports (deploy-unblocking)',
    !/exports\.beforeAdminSignIn\s*=/.test(codeOnly));
  // Window widened 2026-08-17: the header now carries the GCIP
  // correction between the DISABLED marker and the runbook.
  assert('Q3: re-enablement runbook documented in-file',
    /Q3: beforeAdminSignIn — DISABLED[\s\S]{0,4000}Re-enablement runbook/.test(src));
  // The runbook must lead with the GCIP upgrade, not the IAM grant —
  // the old "grant roles/identityplatform.admin" step was a dead end
  // and cost two sessions. Guard against it regressing.
  // Comment prose wraps across `//` lines, so collapse before matching.
  const prose = src.replace(/\n\s*\/\/\s?/g, ' ').replace(/\s+/g, ' ');
  assert('Q3: runbook names the real blocker (GCIP upgrade, not IAM)',
    /Blocking Functions may only be configured for GCIP projects/.test(prose) &&
    /Upgrade `nobigdeal-pro` to Google Cloud Identity Platform/.test(prose));
  assert('Q3: trigger body early-returns for non-admin sessions',
    /_beforeAdminSignInHandler[\s\S]{0,1500}claims\.role !== 'admin'[\s\S]{0,60}return/.test(src));
  assert('Q3: feature-flag gate via feature_flags/_default doc',
    /feature_flags\/_default[\s\S]{0,200}admin_mfa_required/.test(src));
  assert('Q3: fails SAFE (allow) on feature-flag read error',
    /feature-flag read failed[\s\S]{0,60}return/.test(src));
  assert('Q3: rejects admin with no enrolled MFA factor',
    /factors\.length\s*>\s*0[\s\S]{0,800}throw new HttpsError\(\s*\n?\s*'permission-denied'/.test(src));

  const login = read(path.join(ROOT, 'docs/admin/js/pages/login.js'));
  assert('Q3: login page surfaces MFA-enrolment prompt on block',
    /Admin access requires a second factor/.test(login) &&
    /\/admin\/mfa-enroll\.html/.test(login));
  assert('Q3: login page handles auth/multi-factor-auth-required',
    /auth\/multi-factor-auth-required/.test(login));

  // mfa-enroll surface present + uses TOTP (not SMS — SIM-swap resistant).
  const mfa = read(path.join(ROOT, 'docs/admin/js/pages/mfa-enroll.js'));
  assert('Q3: mfa-enroll uses TotpMultiFactorGenerator',
    /TotpMultiFactorGenerator\.generateSecret/.test(mfa) &&
    /TotpMultiFactorGenerator\.assertionForEnrollment/.test(mfa));
  assert('Q3: mfa-enroll only admits callers with role: admin',
    /claims\.role !== 'admin'/.test(mfa));
  assert('Q3: mfa-enroll generates recovery codes + stores hashes only',
    /crypto\.subtle\.digest\('SHA-256'/.test(mfa) &&
    /mfaRecoveryHashes/.test(mfa));

  const html = read(path.join(ROOT, 'docs/admin/mfa-enroll.html'));
  assert('Q3: mfa-enroll.html noindex + loads the enroll module',
    /noindex, nofollow/.test(html) &&
    /\/admin\/js\/pages\/mfa-enroll\.js/.test(html));
}

section('Q6: deploy bundle excludes seed / find-secrets helpers');
{
  const fb = JSON.parse(read(path.join(ROOT, 'firebase.json')));
  const ignore = (fb.functions && fb.functions[0] && fb.functions[0].ignore) || [];
  // These files are standalone dev helpers — never require()'d by
  // index.js — so excluding them from the deploy bundle is pure
  // hygiene. (verify-functions.js was mistakenly included in this
  // list in commit 0ed6274, which broke the whole deploy batch;
  // it IS require()'d by index.js:1901 and must remain in source.)
  for (const name of ['seed-demo.js', 'find-secrets.js',
                      'verify-functions-company-enhancement.js']) {
    assert('Q6: functions.ignore contains ' + name, ignore.includes(name));
  }
  // Guard against the original bug: verify-functions.js must NOT
  // be in the ignore list.
  assert('Q6: verify-functions.js NOT in ignore (required by index.js)',
    !ignore.includes('verify-functions.js'));

  // Broader invariant: NOTHING in the ignore list can be require()'d
  // by functions/index.js or the files it loads. Firebase Hosting
  // packages the source with these patterns excluded; a missing
  // file at container startup causes every function in the
  // container to fail with "Failed to update function". Hard to
  // diagnose without the per-function Cloud Build log.
  // Scope to index.js only — Step 4c extracted handlers to
  // functions/handlers/ which use relative paths (../shared,
  // ./_shared) that would false-fail this walker if we concat'd
  // their bodies in via readFunctionsIndex().
  const idx = read(path.join(FUNCTIONS, 'index.js'));
  const requires = Array.from(idx.matchAll(/require\(\s*['"]\.\/([^'"]+)['"]\s*\)/g))
    .map(m => m[1])
    .map(r => /\.(js|json)$/.test(r) ? r : r + '.js'); // ./function-map.json (2026-10-04) is a data require
  for (const rel of requires) {
    // Match against the ignore glob: simple equality is enough for
    // our single-file ignore patterns. If ignore grows to globs
    // like "scripts/**/*.js" this needs upgrading.
    if (ignore.includes(rel)) {
      assert('Q6: required module ' + rel + ' must not be in deploy-ignore', false);
    }
    // Also sanity: every require()'d module must actually exist
    // relative to functions/.
    if (!fs.existsSync(path.join(FUNCTIONS, rel))) {
      // Sub-path requires like './integrations/foo' are handled
      // by the require walker in index.js; we only scan top-level
      // flat-file requires here. Ignore missing-file results that
      // start with 'integrations/' — those are directories.
      if (!/^integrations\//.test(rel)) {
        assert('Q6: ./' + rel + ' exists in functions/', false);
      }
    }
  }
  assert('Q6: all flat-file requires from index.js resolve + are not ignored', true);
}

// ─────────────────────────────────────────────────────────────
// 2026-04-15 invulnerability roadmap — regression locks for the
// 10-item 72-hour fix plan. Each assertion either pins the fix
// in place or catches the old vulnerable shape reappearing.
// ─────────────────────────────────────────────────────────────
section('C-01: sendD2DSMS IDOR + collection rename + .exists property fix');
{
  const src = read(path.join(FUNCTIONS, 'sms-functions.js'));
  assert('C-01: sms-functions.js no longer references the dead `d2d_knocks` collection',
    !/d2d_knocks/.test(src));
  assert('C-01: sendD2DSMS now reads from `knocks/`',
    /db\.doc\(`knocks\/\$\{knockId\}`\)\.get\(\)/.test(src));
  assert('C-01: knockSnap.exists is used as a property, not a method',
    /knockSnap\.exists\b(?!\()/.test(src) && !/knockSnap\.exists\(\)/.test(src));
  assert('C-01: handler enforces knock.userId ownership check',
    /knock\.userId\s*===\s*decoded\.uid/.test(src)
    && /isOwnKnock/.test(src)
    && /!isPlatformAdmin\s*&&\s*!isOwnKnock/.test(src));
  assert('C-01: handler returns 403 "Not your knock" on IDOR attempt',
    /403[^\n]*Not your knock/.test(src));
  assert('C-01: handler logs the attempt for detection',
    /sendD2DSMS IDOR attempt/.test(src));
  assert('C-01: handler allows same-company manager/company_admin cross-rep access',
    /isManagerInSameCompany/.test(src));
}

section('C-02: SMS subscription + email-verify gate');
{
  const src = read(path.join(FUNCTIONS, 'sms-functions.js'));
  // B2: requirePaidSubscription lives in functions/shared.js now,
  // imported by sms-functions.js. Scan shared.js for the helper
  // shape; scan sms-functions.js for the call sites.
  const shared = read(path.join(FUNCTIONS, 'shared.js'));
  assert('C-02: requirePaidSubscription helper is defined (in shared.js)',
    /async function requirePaidSubscription\s*\(/.test(shared));
  assert('C-02: helper allows admin bypass',
    /decoded\.role\s*===\s*'admin'[\s\S]{0,80}ok:\s*true/.test(shared));
  assert('C-02: helper gates on email_verified',
    /decoded\.email_verified\s*!==\s*true/.test(shared));
  assert('C-02: helper rejects free / missing subscriptions',
    /sub\.plan\s*!==\s*'free'/.test(shared));
  assert('C-02: sms-functions.js imports the helper from shared',
    /require\(['"]\.\/shared['"]\)/.test(src) && /requirePaidSubscription/.test(src));
  // Both handlers must call the gate before the per-uid rate-limit burn.
  // Heuristic: each handler block contains the call at least once.
  const sendSmsCallCount   = (src.match(/exports\.sendSMS\s*=\s*onRequest/g) || []).length;
  const sendD2dCallCount   = (src.match(/exports\.sendD2DSMS\s*=\s*onRequest/g) || []).length;
  const subGateCallCount   = (src.match(/await requirePaidSubscription\(/g) || []).length;
  assert('C-02: both SMS handlers invoke the subscription gate',
    sendSmsCallCount === 1 && sendD2dCallCount === 1 && subGateCallCount >= 2,
    'sendSMS=' + sendSmsCallCount + ' sendD2DSMS=' + sendD2dCallCount + ' gateCalls=' + subGateCallCount);
}

section('C-03 + M-03: claudeProxy transactional budget + starter plan entry');
{
  const src = readFunctionsIndex();
  assert('C-03: reserveClaudeBudget helper defined',
    /async function reserveClaudeBudget\s*\(/.test(src));
  assert('C-03: reserveClaudeBudget uses a Firestore transaction',
    /db\.runTransaction\b/.test(src));
  assert('C-03: adjustClaudeBudget helper defined',
    /async function adjustClaudeBudget\s*\(/.test(src));
  assert('C-03: estimateInputTokens helper defined',
    /function estimateInputTokens\s*\(/.test(src));
  assert('C-03: reservation ceiling is bounded (CLAUDE_RESERVATION_MAX)',
    /const CLAUDE_RESERVATION_MAX\s*=\s*4\s*\*\s*CLAUDE_MAX_TOKENS_CAP/.test(src));
  assert('C-03: claudeProxy reserves before calling Anthropic',
    // Order-sensitive: the reserve call must appear BEFORE the
    // Anthropic fetch in source order. Use index comparison rather
    // than a greedy regex distance (the span between the two can
    // include a long comment block).
    (() => {
      const r = src.indexOf('await reserveClaudeBudget(');
      const a = src.indexOf("api.anthropic.com/v1/messages");
      return r > 0 && a > r;
    })());
  assert('C-03: refunds reservation on Anthropic fetch failure',
    /adjustClaudeBudget\([^)]*-reservation\)/.test(src));
  assert('C-03: reconciles actual vs reservation after success',
    /const delta\s*=\s*total\s*-\s*reservation/.test(src));
  assert('C-03: old read-then-check branch removed',
    !/consumedUid\s*>=\s*CLAUDE_DAILY_TOKEN_BUDGET/.test(src));
  // M-03: canonical `starter` plan name has an explicit budget entry.
  assert('M-03: CLAUDE_COMPANY_BUDGET includes starter plan (normalized from foundation)',
    /CLAUDE_COMPANY_BUDGET\s*=\s*\{[\s\S]{0,400}starter:\s*50_000/.test(src));
}

section('H-07: claudeProxy message-array + payload-size caps');
{
  const src = readFunctionsIndex();
  assert('H-07: CLAUDE_MAX_MESSAGES constant defined',
    /const CLAUDE_MAX_MESSAGES\s*=\s*40\b/.test(src));
  assert('H-07: CLAUDE_MAX_PAYLOAD_BYTES constant defined',
    /const CLAUDE_MAX_PAYLOAD_BYTES\s*=\s*200_000/.test(src));
  assert('H-07: messages.length > cap returns 400',
    /messages\.length\s*>\s*CLAUDE_MAX_MESSAGES[\s\S]{0,200}status\(400\)/.test(src));
  assert('H-07: oversize serialized payload returns 413',
    /serializedMessages\.length\s*>\s*CLAUDE_MAX_PAYLOAD_BYTES[\s\S]{0,200}status\(413\)/.test(src));
}

section('H-01 + R-03: signImageUrl portals/ strip (imageProxy retired)');
{
  const src = readFunctionsIndex();
  // Only signImageUrl still runs path-allowlist regex now that
  // imageProxy is a 410 stub. Assertion guards against portal paths
  // being reintroduced to the signer's alternation.
  const matchRegexes = src.match(/\(photos\|[^)]+\)/g) || [];
  assert('H-01: signImageUrl regex does not include portals',
    matchRegexes.length > 0 && matchRegexes.every(r => !/portals/.test(r)),
    'found ' + matchRegexes.length + ' alternation(s): ' + matchRegexes.join(' | '));
}

section('H-06: integrationStatus admin-only gate');
{
  const src = readFunctionsIndex();
  // The role check sits inside the integrationStatus handler block.
  const m = src.match(/exports\.integrationStatus\s*=\s*onCall\s*\([\s\S]+?\}\s*\);/);
  assert('H-06: integrationStatus handler block located', !!m);
  if (m) {
    assert('H-06: handler rejects non-admin / non-company_admin callers',
      /\['admin',\s*'company_admin'\]\.includes\(callerRole\)/.test(m[0])
      && /permission-denied/.test(m[0]));
  }
  // Companion assertion (integration-availability-non-admin fix): a new
  // integrationAvailability callable was added alongside integrationStatus
  // so non-admin reps can get an availability readout without going through
  // the admin gate above. Prove that addition did NOT touch — let alone
  // weaken — integrationStatus itself: its matched block must still be the
  // admin-gated one above, and must not have absorbed the new callable.
  if (m) {
    assert('H-06 companion: integrationStatus block is unchanged — still admin-gated, and did not merge with the new integrationAvailability callable',
      /\['admin',\s*'company_admin'\]\.includes\(callerRole\)/.test(m[0])
      && /permission-denied/.test(m[0])
      && !/integrationAvailability/.test(m[0]));
  }
  // And the new sibling callable is a genuinely distinct, deliberately
  // non-admin endpoint — not integrationStatus renamed or aliased, and not
  // itself carrying a role check that would defeat its own purpose.
  const m2 = src.match(/exports\.integrationAvailability\s*=\s*onCall\s*\([\s\S]+?\}\s*\);/);
  assert('H-06 companion: integrationAvailability handler block located', !!m2);
  if (m2) {
    assert('H-06 companion: integrationAvailability has no admin/company_admin role check (any authenticated caller may use it)',
      !/callerRole/.test(m2[0]) && !/permission-denied/.test(m2[0]));
    assert('H-06 companion: integrationAvailability still requires authentication',
      /!request\.auth \|\| !request\.auth\.uid/.test(m2[0]) && /unauthenticated/.test(m2[0]));
  }
}

section('M-04: submitPublicLead optional-field allowlist');
{
  const src = readFunctionsIndex();
  assert('M-04: PUBLIC_LEAD_OPTIONAL_DEFAULTS defined (utm + referrer)',
    /PUBLIC_LEAD_OPTIONAL_DEFAULTS\s*=\s*\[[^\]]*utm_source[^\]]*utm_medium[^\]]*utm_campaign[^\]]*referrer/.test(src));
  assert('M-04: guide kind carries an explicit optional list',
    /guide:\s*\{[\s\S]{0,300}optional:\s*\[/.test(src));
  assert('M-04: submitPublicLead iterates spec.optional, not Object.keys(body)',
    /for\s*\(const key of \(spec\.optional \|\| \[\]\)\)/.test(src));
  assert('M-04: old passthrough loop over Object.keys(body) is gone',
    !/for\s*\(const key of Object\.keys\(body\)\)\s*\{[\s\S]{0,160}spec\.required\.includes/.test(src));
}

section('H-02: nbd-auth demo bypass keyed on custom claim, not email');
{
  const src = read(path.join(ROOT, 'docs/pro/js/nbd-auth.js'));
  assert('H-02: demo@nobigdeal.pro literal removed',
    !/demo@nobigdeal\.pro/.test(src));
  // Owner-claims transition (2026-07): the token read was hoisted into a
  // single `_claims` object shared by the owner/demo/role checks — accept
  // either shape, the invariant is "demo keyed on the claim, not an email".
  assert('H-02: demo bypass now reads token.claims.demo',
    /(_claims|tokenResult\.claims)\.demo\s*===\s*true/.test(src));
  assert('H-02: demo accounts never receive admin role client-side',
    /_role\s*=\s*'demo_viewer'/.test(src) && !/_role\s*=\s*'admin';\s*\n\s*_subscription\s*=\s*\{\s*plan:\s*'professional'/.test(src));
}

section('H-02 ops: scripts/grant-demo-claim.js provisioner');
{
  const p = path.join(ROOT, 'scripts/grant-demo-claim.js');
  assert('H-02: grant-demo-claim.js exists', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const src = read(p);
    assert('H-02: provisioner sets demo:true custom claim',
      /setCustomUserClaims\([^)]+,\s*next\)/.test(src) && /next\.demo\s*=\s*true/.test(src));
    assert('H-02: provisioner supports --remove flag for claim revocation',
      /--remove/.test(src) && /delete next\.demo/.test(src));
    assert('H-02: provisioner revokes refresh tokens so the claim takes effect',
      /revokeRefreshTokens\(/.test(src));
    assert('H-02: provisioner parses cleanly',
      syntaxCheck(p).ok);
  }
}

section('H-03: nbd-auth fails closed to free on network error');
{
  const src = read(path.join(ROOT, 'docs/pro/js/nbd-auth.js'));
  assert('H-03: localStorage plan cache read removed',
    !/localStorage\.getItem\('nbd_user_plan'\)/.test(src));
  // The setter call survives only in logout() for cleanup of stale keys.
  const setterMatches = (src.match(/localStorage\.setItem\('nbd_user_plan'/g) || []).length;
  assert('H-03: localStorage plan cache write removed (no setItem calls)',
    setterMatches === 0,
    'found ' + setterMatches + ' setItem(nbd_user_plan) call(s)');
  assert('H-03: network-error branch hard-drops to free with _failOpen:false',
    /_userPlan\s*=\s*'free';[\s\S]{0,160}_failOpen:\s*false/.test(src));
}

section('Free tier + trial-state integrity (2026-07-05)');
{
  // 1. The dashboard IS the free-tier product. requiredPlan 'foundation'
  //    put every free signup (no subscriptions doc) and every expired
  //    code-trial behind a full-screen upgrade wall with no continue-free
  //    path — the funnel sold a product nobody could reach.
  const gate = read(path.join(ROOT, 'docs/pro/js/dashboard-auth-gate.module.js'));
  assert('dashboard auth gate requires free, not a paid tier',
    /requiredPlan:\s*'free'/.test(gate) && !/requiredPlan:\s*'foundation'/.test(gate));

  // 2. isTrialExpired must require a KNOWN trial end. The webhook writes
  //    status 'trialing' verbatim with NO trialEndsAt, so the bare
  //    `daysLeft <= 0` check read the -1 sentinel as "expired" and told
  //    active card-backed Stripe trialers their trial had ended.
  const auth = read(path.join(ROOT, 'docs/pro/js/nbd-auth.js'));
  assert('isTrialExpired gated on _trialEndKnown (no -1 sentinel misread)',
    /isTrialExpired\(\)\s*\{\s*return\s+_isTrialUser\s*&&\s*_trialEndKnown\s*&&\s*_trialDaysLeft\s*<=\s*0/.test(auth));
  assert('Stripe trialing subs derive countdown from currentPeriodEnd',
    /status === 'trialing' && _subscription\.currentPeriodEnd/.test(auth));

  // 3. trialEndsAt single-writer invariant: only validateAccessCode
  //    (portal.js) writes it. nbd-auth's trialEndsAt downgrade and the
  //    read-time expiry gates in billing.js/billing-gate.js all assume
  //    this — a second writer (e.g. the Stripe webhook) would make
  //    converted paid subs downgrade. Scan every functions/ source for
  //    trialEndsAt ASSIGNMENTS (key or property writes), not reads.
  const fnFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) fnFiles.push(p);
    }
  })(FUNCTIONS);
  const writers = fnFiles.filter((p) =>
    /(?:\btrialEndsAt\s*[:=](?!==))/.test(
      // strip line comments so documentation mentions don't count
      read(p).split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n')
    ));
  assert('trialEndsAt has exactly one functions-side writer (portal.js)',
    writers.length === 1 && /handlers[\\/]portal\.js$/.test(writers[0]),
    'writers found: ' + writers.map((w) => path.relative(ROOT, w)).join(', '));
}

section('M-01 + M-02: GDPR completeness — canonical user-owned registry');
{
  const regPath = path.join(FUNCTIONS, 'integrations/user-owned.js');
  assert('M-01/M-02: registry module exists', fs.existsSync(regPath));
  if (fs.existsSync(regPath)) {
    assert('M-01/M-02: registry parses cleanly', syntaxCheck(regPath).ok);
    // Load the module and assert the shape — smoke test already uses
    // zero deps other than Node stdlib, and this module is pure
    // constants + a helper fn, so require() is safe.
    const reg = require(regPath);
    assert('M-01/M-02: FLAT_USER_COLLECTIONS has at least 22 entries',
      Array.isArray(reg.FLAT_USER_COLLECTIONS) && reg.FLAT_USER_COLLECTIONS.length >= 22,
      'count=' + (reg.FLAT_USER_COLLECTIONS || []).length);
    assert('M-01/M-02: every flat-collection entry has a name',
      reg.FLAT_USER_COLLECTIONS.every(s => typeof s.name === 'string' && s.name.length > 0));
    // Invoices is the only collection with a non-default ownerField.
    const invoices = reg.FLAT_USER_COLLECTIONS.find(s => s.name === 'invoices');
    assert('M-01/M-02: invoices is registered with ownerField=createdBy',
      invoices && invoices.ownerField === 'createdBy');
    assert('M-01/M-02: COLLECTION_GROUPS_WITH_USERID includes recordings + activity',
      Array.isArray(reg.COLLECTION_GROUPS_WITH_USERID)
      && reg.COLLECTION_GROUPS_WITH_USERID.includes('recordings')
      && reg.COLLECTION_GROUPS_WITH_USERID.includes('activity'));
    // DERIVED, not restated. This used to compare STORAGE_PREFIXES against a
    // hand-maintained array labelled "all 8 storage.rules prefixes" while
    // storage.rules defined eleven — and because it only checked that the
    // registry was a SUPERSET of that array, a prefix missing from BOTH was
    // invisible to it. Four were (documents, esign, homeowner-uploads,
    // pdf-renders), each absent from the GDPR export and the erasure sweep.
    // The list of truth now comes from storage.rules + the write sites in
    // code; see scripts/check-storage-prefix-registry.js for why neither
    // source is sufficient alone.
    const { deriveOwnerKeyedPrefixes } =
      require(path.join(ROOT, 'scripts/check-storage-prefix-registry.js'));
    const derived = deriveOwnerKeyedPrefixes(ROOT);
    const unregistered = [...derived.union].filter(p => !reg.STORAGE_PREFIXES.includes(p));
    assert('M-01/M-02: STORAGE_PREFIXES covers every derived owner-keyed prefix',
      Array.isArray(reg.STORAGE_PREFIXES) && unregistered.length === 0,
      unregistered.length ? 'unregistered: ' + unregistered.join(', ') : '');
    // Sanity on the deriver itself: if it ever returns an empty set (a moved
    // storage.rules, a renamed scan dir), the check above passes vacuously.
    assert('M-01/M-02: prefix derivation actually found prefixes',
      derived.union.size >= 11 && derived.rules.size >= 11,
      `union=${derived.union.size} rules=${derived.rules.size}`);

    // Erasure scope is the export scope minus documented retention holds.
    assert('M-01: ERASURE_STORAGE_PREFIXES is derived, not hand-maintained',
      Array.isArray(reg.ERASURE_STORAGE_PREFIXES)
      && reg.ERASURE_STORAGE_PREFIXES.join('|')
         === reg.STORAGE_PREFIXES.filter(p => !reg.ERASURE_RETAINED_PREFIXES.includes(p)).join('|'));
    // A prefix we refuse to delete must at minimum be one the user can obtain.
    assert('M-01: every retained prefix is still exportable',
      Array.isArray(reg.ERASURE_RETAINED_PREFIXES)
      && reg.ERASURE_RETAINED_PREFIXES.every(p => reg.STORAGE_PREFIXES.includes(p)));
    // esign/ holds counter-signed contracts — retained under GDPR Art. 17(3)
    // by Jo's decision on 2026-09-08. Pinned so removing the hold is a
    // deliberate edit to a red test, not a quiet one-line deletion.
    assert('M-01: esign is exported but held back from erasure',
      reg.STORAGE_PREFIXES.includes('esign')
      && !reg.ERASURE_STORAGE_PREFIXES.includes('esign'));
    assert('M-01/M-02: OWNER_KEYED_DOCS covers the user/sub/settings doc set',
      Array.isArray(reg.OWNER_KEYED_DOCS)
      && ['users','subscriptions','userSettings','leaderboard','reps','estimate_drafts','feature_flags']
          .every(c => reg.OWNER_KEYED_DOCS.includes(c)));
    assert('M-01/M-02: NESTED_LEADS_PATH(uid) returns leads/{uid}',
      typeof reg.NESTED_LEADS_PATH === 'function'
      && reg.NESTED_LEADS_PATH('abc') === 'leads/abc');
    // Audit trails intentionally excluded — prevents a future
    // caller from wiring account_erasures into the cascade and
    // obliterating the very audit record of the operation.
    assert('M-01/M-02: audit trails NOT in owner-keyed erasure scope',
      !reg.OWNER_KEYED_DOCS.includes('account_erasures')
      && !reg.OWNER_KEYED_DOCS.includes('audit_log'));
  }
}

section('M-01: confirmAccountErasure uses the registry + recursiveDelete');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  assert('M-01: compliance.js imports the registry module',
    /require\(['"]\.\/user-owned['"]\)/.test(src));
  assert('M-01: cascade iterates FLAT_USER_COLLECTIONS (not an inline list)',
    /for \(const spec of FLAT_USER_COLLECTIONS\)/.test(src));
  assert('M-01: cascade honors per-collection ownerField',
    /spec\.ownerField\s*\|\|\s*'userId'/.test(src));
  assert('M-01: cascade iterates COLLECTION_GROUPS_WITH_USERID',
    /for \(const groupName of COLLECTION_GROUPS_WITH_USERID\)/.test(src));
  // ERASURE_STORAGE_PREFIXES, not STORAGE_PREFIXES: the erasure sweep and the
  // Art. 15 export deliberately have different scopes now.
  assert('M-01: cascade sweeps ERASURE_STORAGE_PREFIXES',
    /for \(const prefix of ERASURE_STORAGE_PREFIXES\)/.test(src));
  // The retention hold must be disclosed, not just honoured. An erasure that
  // quietly keeps signed contracts while the page promises to remove
  // everything is the failure Art. 17(3) does not license.
  assert('M-01: erasure receipt records what was retained',
    /retained: ERASURE_RETAINED_PREFIXES/.test(src));
  assert('M-01: consent page discloses the retention hold before the button',
    /const retainedSentence = describeRetained\(\)/.test(src)
    && /retainedHtml \+$/m.test(src));
  assert('M-01: cascade deletes every OWNER_KEYED_DOCS entry',
    /for \(const coll of OWNER_KEYED_DOCS\)/.test(src));
  assert('M-01: nested-leads subtree scrubbed via recursiveDelete',
    /db\.recursiveDelete\(db\.doc\(NESTED_LEADS_PATH\(uid\)\)\)/.test(src));
  // The old inline OWNED_COLLECTIONS constant must be gone.
  assert('M-01: old inline OWNED_COLLECTIONS list removed',
    !/const OWNED_COLLECTIONS\s*=\s*\[/.test(src));
}

section('M-02: exportMyData uses the registry + Storage enumeration');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  assert('M-02: export iterates FLAT_USER_COLLECTIONS',
    /exports\.exportMyData[\s\S]{0,5000}for \(const spec of FLAT_USER_COLLECTIONS\)/.test(src));
  assert('M-02: export iterates COLLECTION_GROUPS_WITH_USERID',
    /for \(const group of COLLECTION_GROUPS_WITH_USERID\)/.test(src));
  assert('M-02: export enumerates Storage prefixes (getFiles)',
    /bucket\.getFiles\(\s*\{\s*prefix:/.test(src));
  assert('M-02: export signs 24h download URLs per Storage object',
    /f\.getSignedUrl\([\s\S]{0,160}24\s*\*\s*3_600_000/.test(src));
  assert('M-02: export reads every OWNER_KEYED_DOCS entry',
    /for \(const coll of OWNER_KEYED_DOCS\)/.test(src));
  assert('M-02: export walks nested-leads subtree via listCollections()',
    /NESTED_LEADS_PATH\(uid\)[\s\S]{0,300}listCollections\(\)/.test(src));
  // Backwards compat — clients reading the old shape see the same keys.
  assert('M-02: legacy `profile` + `subscription` aliases preserved',
    /out\.profile\s*=\s*out\.ownerDocs\.users/.test(src)
    && /out\.subscription\s*=\s*out\.ownerDocs\.subscriptions/.test(src));
  // The old inline OWNED constant must be gone.
  assert('M-02: old inline OWNED list removed from export path',
    !/const OWNED\s*=\s*\['leads'/.test(src));
}

section('R-01: rate-limit provider visibility + cold-start misconfig warning');
{
  const adapterPath = path.join(FUNCTIONS, 'integrations/upstash-ratelimit.js');
  const src = read(adapterPath);

  assert('R-01: adapter exports a `provider()` function',
    /^\s*(module\.exports\s*=\s*\{[\s\S]*?\bprovider[\s\S]*?\};?|exports\.provider\s*=)/m.test(src));
  assert('R-01: provider() returns upstash only when env=upstash AND secrets configured',
    /PROVIDERS\.rateLimit\s*===\s*'upstash'\s*&&\s*upstashConfigured\(\)/.test(src));
  assert('R-01: cold-start misconfig logs a structured `rate_limit_provider_drift` WARN',
    /logger\(\)\.warn\(\s*'rate_limit_provider_drift'/.test(src));
  assert('R-01: cold-start drift message cites envPref + active fields',
    /rate_limit_provider_drift[\s\S]{0,400}envPref[\s\S]{0,120}active/.test(src));
  // Live-load the adapter and verify provider() resolves without
  // secrets available (expected: 'firestore' — the test env is
  // unconfigured by design).
  const adapter = require(adapterPath);
  assert('R-01: provider() is a callable function',
    typeof adapter.provider === 'function');
  assert('R-01: provider() returns a string in {upstash, firestore}',
    ['upstash', 'firestore'].includes(adapter.provider()));

  const idx = readFunctionsIndex();
  assert('R-01: integrationStatus surfaces rateLimitProvider to admin callers',
    /rateLimitProvider:\s*rateLimitProvider\(\)/.test(idx)
    && /require\(['"]\.\/integrations\/upstash-ratelimit['"]\)/.test(idx));

  const runbook = read(path.join(ROOT, 'documentation', 'archive', 'legacy', 'POST_DEPLOY_CHECKLIST.md'));
  assert('R-01: POST_DEPLOY_CHECKLIST has an Upstash runbook section',
    /##\s*18\.\s*Rate-limit provider/i.test(runbook));
  assert('R-01: runbook walks through secret provisioning',
    /functions:secrets:set UPSTASH_REDIS_REST_URL/.test(runbook)
    && /functions:secrets:set UPSTASH_REDIS_REST_TOKEN/.test(runbook));
  assert('R-01: runbook documents the NBD_RATE_LIMIT_PROVIDER=upstash flip',
    /NBD_RATE_LIMIT_PROVIDER.{0,10}upstash/.test(runbook)
    || /nbd\.rate_limit_provider.{0,10}upstash/.test(runbook));
  assert('R-01: runbook tells ops how to verify the flip post-deploy',
    /integrationStatus[\s\S]{0,400}rateLimitProvider/.test(runbook));
}

section('L-04: confirmAccountErasure GET is rate-limited');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  // The GET branch must call httpRateLimit BEFORE emitting the HTML
  // so a bandwidth-DoS hits the 429 path, not the 3KB body.
  assert('L-04: GET branch invokes httpRateLimit on confirmErasureGet:ip',
    // Window sized to tolerate the explanatory comment block added
    // with this fix.
    /if\s*\(req\.method\s*===\s*'GET'\)[\s\S]{0,1200}httpRateLimit\([^)]*confirmErasureGet:ip/.test(src));
  assert('L-04: rate-limit uses per-IP key (60/min)',
    /confirmErasureGet:ip[^)]*,\s*60,\s*60_000/.test(src));
}

section('login + register pages are autofill / password-manager friendly');
{
  const login = read(path.join(ROOT, 'docs/pro/login.html'));
  const register = read(path.join(ROOT, 'docs/pro/register.html'));
  const loginJs = read(path.join(ROOT, 'docs/pro/js/pages/login.js'));
  const regJs = read(path.join(ROOT, 'docs/pro/js/pages/register.js'));

  // ── login.html ──
  // Password managers need: real <form>, type="email"+name="email"+autocomplete="email",
  // type="password"+name="password"+autocomplete="current-password",
  // <button type="submit">, and a real `submit` event handler (not
  // just click on the button — the manager hooks the submit event
  // to detect a successful login and prompt "Save password?").
  assert('login.html wraps fields in a real <form>',
    /<form[^>]*id="loginForm"[^>]*action="#"[^>]*method="post"/.test(login));
  assert('login.html email input has type=email, name=email, autocomplete=email',
    /<input[^>]*type="email"[^>]*name="email"[^>]*autocomplete="email"/.test(login)
    || /<input[^>]*name="email"[^>]*type="email"[^>]*autocomplete="email"/.test(login)
    || /<input[^>]*type="email"[^>]*autocomplete="email"[^>]*name="email"/.test(login));
  assert('login.html password input has type=password, name=password, autocomplete=current-password',
    /<input[^>]*type="password"[^>]*name="password"[^>]*autocomplete="current-password"/.test(login)
    || /<input[^>]*name="password"[^>]*type="password"[^>]*autocomplete="current-password"/.test(login));
  assert('login.html has <button type="submit"> for the loginBtn',
    /<button[^>]*id="loginBtn"[^>]*type="submit"/.test(login)
    || /<button[^>]*type="submit"[^>]*id="loginBtn"/.test(login));
  assert('login.js binds form.addEventListener("submit", ...)',
    /loginForm\.addEventListener\(\s*['"]submit['"]/.test(loginJs));

  // ── register.html ──
  // Same shape but with autocomplete="new-password" (signals "saving
  // a new credential" so the manager offers a generated password
  // instead of autofilling an existing one).
  assert('register.html form has action=# method=post',
    /<form[^>]*id="regForm"[^>]*action="#"[^>]*method="post"/.test(register));
  assert('register.html email input has name=email + autocomplete=email + type=email',
    /<input[^>]*id="regEmail"[^>]*name="email"[\s\S]{0,300}autocomplete="email"/.test(register));
  assert('register.html password input has name + type=password + autocomplete=new-password',
    /<input[^>]*id="regPass"[^>]*name="[^"]+"[^>]*type="password"[\s\S]{0,400}autocomplete="new-password"/.test(register));
  assert('register.html confirm-password input has autocomplete=new-password',
    /<input[^>]*id="regConfirm"[\s\S]{0,400}autocomplete="new-password"/.test(register));
  assert('register.html given-name + family-name + organization have name= attrs',
    /<input[^>]*id="regFirst"[^>]*name="given-name"/.test(register)
    && /<input[^>]*id="regLast"[^>]*name="family-name"/.test(register)
    && /<input[^>]*id="regCompany"[^>]*name="organization"/.test(register));
  assert('register.html has <button type="submit"> for the regBtn',
    /<button[^>]*id="regBtn"[^>]*type="submit"/.test(register)
    || /<button[^>]*type="submit"[^>]*id="regBtn"/.test(register));
  assert('register.js binds form.addEventListener("submit", register)',
    /form\.addEventListener\(\s*['"]submit['"]\s*,\s*register\s*\)/.test(regJs));
}

// ── OWNER-ROLE: claims-based owner (root) — single server list + client
// claim checks. The { owner: true, role: 'admin' } claims are minted by
// the mintOwnerClaims callable from the ONE server-side email list in
// functions/handlers/_shared.js; every other owner check (server + client)
// keys on the claim, keeping the email literals only as the DEPRECATED
// transition fallback. These assertions lock:
//   (a) the email list exists in exactly one server-side location,
//   (b) the minting callable exists AND actually deploys (not skip-listed,
//       discoverable by the deploy grep, re-exported from index.js),
//   (c) client + server checks key on the owner claim.
section('OWNER-ROLE: single server-side email list (_shared.js only)');
{
  const OWNER_EMAIL_RE = /jonathandeal459@gmail\.com|jd@nobigdealwithjoedeal\.com/;
  // A "definition" is an assignment of an owner-email list literal
  // (Set or array). Imports/destructures of OWNER_EMAILS don't match.
  const DEF_RE = /OWNER_EMAILS\s*=\s*(new Set\(|\[)/;

  // Sweep every functions/ .js file (top level + one level of subdirs).
  const fnFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(p);
      } else if (entry.name.endsWith('.js')) fnFiles.push(p);
    }
  };
  walk(FUNCTIONS);

  const defFiles = fnFiles.filter((f) => {
    const src = read(f);
    return DEF_RE.test(src) && OWNER_EMAIL_RE.test(src);
  }).map((f) => path.relative(FUNCTIONS, f));
  assert('exactly one OWNER_EMAILS definition under functions/ (handlers/_shared.js), got: '
      + JSON.stringify(defFiles),
    defFiles.length === 1 && defFiles[0] === path.join('handlers', '_shared.js'));

  const shared = read(path.join(FUNCTIONS, 'handlers/_shared.js'));
  assert('_shared.js OWNER_EMAILS carries both founder emails',
    /OWNER_EMAILS = new Set\(\[[\s\S]{0,120}'jd@nobigdealwithjoedeal\.com',[\s\S]{0,80}'jonathandeal459@gmail\.com'/.test(shared));
  assert('_shared.js exports isOwnerCaller with claim-first check (token.owner === true)',
    /function isOwnerCaller\(token\)[\s\S]{0,200}token\.owner === true/.test(shared));
  assert('old PROVISION_OWNER_EMAILS name is gone from _shared.js exports',
    !/PROVISION_OWNER_EMAILS\s*[,:]/.test(shared));

  // No other server-side authorization file re-hardcodes the emails.
  for (const f of ['billing.js', 'handlers/auth.js', 'handlers/invites.js',
                   'migrate-companyprofile-per-tenant.js']) {
    assert(f + ' contains no owner-email literals (imports from _shared.js)',
      !OWNER_EMAIL_RE.test(read(path.join(FUNCTIONS, f))));
  }
}

section('OWNER-ROLE: mintOwnerClaims exists and DEPLOYS');
{
  const authSrc = read(path.join(FUNCTIONS, 'handlers/auth.js'));
  // Must be a line-start `exports.mintOwnerClaims = onCall` — that exact
  // shape is what the deploy workflow's discovery grep matches
  // (.github/workflows/firebase-deploy.yml, Deploy Cloud Functions step).
  assert('handlers/auth.js exports mintOwnerClaims as a line-start onCall (deploy-grep shape)',
    /^exports\.mintOwnerClaims *= *onCall\(/m.test(authSrc));
  assert('mintOwnerClaims requires a verified email before minting',
    /mintOwnerClaims[\s\S]{0,4000}emailVerified !== true/.test(authSrc));
  assert('mintOwnerClaims mints owner + admin role via merged setCustomUserClaims',
    /setCustomUserClaims\(uid, \{ \.\.\.existing, owner: true, role: 'admin' \}\)/.test(authSrc));
  assert('provisionE2ETestUser gate is claim-first via isOwnerCaller',
    /const isOwner = isOwnerCaller\(request\.auth\.token\)/.test(authSrc));

  const idx = read(path.join(FUNCTIONS, 'index.js'));
  assert('index.js re-exports mintOwnerClaims (required for deploy-by-name)',
    /^exports\.mintOwnerClaims\s*=\s*authHandlers\.mintOwnerClaims;/m.test(idx));

  // The deploy skip-list must NOT grow to include mintOwnerClaims — if it
  // did, owner-claim minting would silently stop shipping (the exact trap
  // that killed the blocking-trigger approach).
  const wf = read(path.join(ROOT, '.github/workflows/firebase-deploy.yml'));
  const skipLists = wf.match(/NBD_DEPLOY_SKIP_LIST:\s*"([^"]*)"/g) || [];
  assert('firebase-deploy.yml has NBD_DEPLOY_SKIP_LIST entries to inspect', skipLists.length > 0);
  assert('mintOwnerClaims is NOT in any NBD_DEPLOY_SKIP_LIST',
    skipLists.every((s) => !s.includes('mintOwnerClaims')));

  const billing = read(path.join(FUNCTIONS, 'billing.js'));
  assert('billing.js cap bypass keys on isOwnerCaller (claim-first)',
    /const isOwner = isOwnerCaller\(request\.auth\.token\)/.test(billing));
  const invites = read(path.join(FUNCTIONS, 'handlers/invites.js'));
  assert('invites.js seat-cap bypass keys on isOwnerCaller (claim-first)',
    /isGlobalAdmin \|\| isOwnerCaller\(request\.auth\.token\)/.test(invites));
}

section('OWNER-ROLE: client authorization is claim-ONLY (emails = mint trigger in ONE file)');
{
  // OWNER_EMAILS retirement (2026-07-06, Jo's call: safe demotion).
  // Client-side, the founder emails may exist in EXACTLY ONE file —
  // nbd-auth.js — and only as the mintOwnerClaims trigger, never as an
  // authorization input. Every access decision keys on claims.owner.
  const OWNER_EMAIL_RE = /jonathandeal459@gmail\.com|jd@nobigdealwithjoedeal\.com/;

  const nbdAuth = read(path.join(PRO_JS, 'nbd-auth.js'));
  assert('nbd-auth.js owner bypass keys on claims.owner === true',
    /_ownerClaim = _claims\.owner === true/.test(nbdAuth)
    && /if \(_ownerClaim\) \{/.test(nbdAuth));
  assert('nbd-auth.js keeps the mint-trigger list (documented as trigger-only)',
    /OWNER_EMAILS = new Set\(\[[\s\S]{0,120}'jd@nobigdealwithjoedeal\.com'/.test(nbdAuth)
    && /MINT TRIGGER ONLY/.test(nbdAuth));
  assert('nbd-auth.js self-heal: mint is awaited then claims are re-read',
    /_requestOwnerClaimMint\(user\)/.test(nbdAuth)
    && /httpsCallable\(fns, 'mintOwnerClaims'\)/.test(nbdAuth)
    && /reread = await Promise\.race/.test(nbdAuth));
  assert('nbd-auth.js isOwner getter is claim-only (no email read)',
    /get isOwner\(\)\s*\{[\s\S]{0,400}return _claims\.owner === true;\s*\}/.test(nbdAuth));
  {
    const m = nbdAuth.match(/hasAccess\(plan\)\s*\{[\s\S]{0,600}?\n  \}/);
    assert('nbd-auth.js hasAccess() honors the owner claim, no email fallback',
      !!m && /_claims\.owner === true/.test(m[0]) && !/OWNER_EMAILS/.test(m[0]));
  }

  const gate = read(path.join(PRO_JS, 'billing-gate.js'));
  assert('billing-gate.js _isOwner is claim-only',
    /_isOwner\(\)\s*\{[\s\S]{0,400}window\._userClaims\.owner === true/.test(gate));
  assert('billing-gate.js contains no founder-email literals',
    !OWNER_EMAIL_RE.test(gate));

  const boot = read(path.join(PRO_JS, 'dashboard-bootstrap.module.js'));
  assert('dashboard-bootstrap owner check is claim-only',
    /isOwnerAccount = \(_bootClaims && _bootClaims\.owner === true\);/.test(boot));
  assert('dashboard-bootstrap contains no founder-email AUTH literals',
    !/=== 'jd@nobigdealwithjoedeal\.com'|=== 'jonathandeal459@gmail\.com'/.test(boot));

  const onboarding = read(path.join(PRO_JS, 'pages/onboarding.js'));
  assert('onboarding.js owner redirect is claim-only',
    /if \(state\.claims\.owner === true\) \{ toDashboard\(\); return; \}/.test(onboarding));
  assert('onboarding.js contains no founder-email literals',
    !OWNER_EMAIL_RE.test(onboarding));

  const academy = read(path.join(PRO_JS, 'real-deal-academy.js'));
  assert('real-deal-academy.js tier unlock honors the owner claim',
    /window\._userClaims\?\.owner === true/.test(academy));
  assert('real-deal-academy.js contains no founder-email literals',
    !OWNER_EMAIL_RE.test(academy));
}

};
