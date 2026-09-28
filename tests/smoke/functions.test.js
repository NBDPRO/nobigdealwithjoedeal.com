/**
 * tests/smoke/functions.test.js — Cloud Functions exports, all
 * integrations (Slack, Turnstile, Upstash, measurement, BoldSign, parcel,
 * hail, Cal.com), Stripe webhook hardening, GDPR cron/backup/retention,
 * CI workflow, CODEOWNERS, service-worker kill switch, email queue,
 * TCPA, deploy runbook, Voice Intel pipeline (C1–C5), per-route rate
 * limit policy, registry drift, migration framework, Push-3/Push-5,
 * Phase D.3, L-01/L-02/L-03/B2 module extractions, M1 admin CSP,
 * SEO sitemap, service worker stub, R-05 hot-path sizing.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { ROOT, PRO_JS, FUNCTIONS, read, readDashboard, readCustomer, readCrm, readFunctionsIndex, syntaxCheck } = require('./_shared');

module.exports.run = function run(ctx) {
  const { assert, section } = ctx;

// ── Cloud Functions contract ─────────────────────────────────
section('Alert outbox ledger (2026-07-06, punch item 6)');
{
  const la = read(path.join(FUNCTIONS, 'lead-alert.js'));
  assert('recordAlertOutbox writes the routing decision to alert_outbox',
    /async function recordAlertOutbox/.test(la)
    && /collection\('alert_outbox'\)\.add\(/.test(la)
    && /companyId: \(d && d\.companyId\) \|\| null/.test(la));
  assert('alertJoe records per-channel outcomes into the ledger',
    /const outcomes = \{ email: 'skipped:no-target', sms: 'skipped:no-target' \}/.test(la)
    && /await recordAlertOutbox\(collection, leadId, d, target, outcomes\)/.test(la));
  assert('outbox write is best-effort (never blocks the alert path)',
    /outbox write failed/.test(la));

  // NBD-leak audit 2026-07-29: the homeowner acks must gate on WHOSE lead it
  // is (companyId → isNbd), never on the resolved seal — the old seal check
  // also matched an UNRESOLVED tenant's fallback target, sending Joe-branded
  // acks to another company's customer. The unresolved-tenant arm keeps Joe's
  // ROUTING as backstop but carries an empty-string brand.
  assert('resolveAlertTarget keys isNbd on the platform owner uid',
    /NBD_OWNER_UID/.test(la)
    && /const isNbd = !companyId \|\| String\(companyId\) === NBD_OWNER_UID/.test(la));
  assert('unresolved NON-NBD tenant gets Joe routing but an empty-string brand',
    /name: '', seal: '', isNbd: false/.test(la));
  // 2026-09-04: the SMS ack's copy of this check moved into tcpa-consent.js
  // when the ack started reading stored consent instead of inferring it from
  // the collection name. The invariant is unchanged and still has exactly two
  // enforcement points — the email ack inline, the SMS ack via smsAckGate —
  // so both are pinned here rather than counting occurrences in one file.
  assert('homeowner EMAIL ack gates on target.isNbd, not seal',
    (la.match(/target\.isNbd !== true\) return/g) || []).length === 1
    && !/target\.seal !== 'NBD'\) return/.test(la));
  assert('homeowner SMS ack gates through smsAckGate, and passes it the target',
    /C\.smsAckGate\(\{[\s\S]{0,200}target,/.test(la)
    && !/collection !== 'estimate_leads'\) return/.test(la));
  {
    const tcpa = read(path.join(FUNCTIONS, 'tcpa-consent.js'));
    assert('smsAckGate enforces the same isNbd rule the email ack does',
      /a\.target\.isNbd !== true\) return \{ allowed: false, reason: 'not_nbd_lead' \}/.test(tcpa)
      && !/seal/.test(tcpa));
    assert('smsAckGate refuses a lead with no stored consent',
      /!hasWrittenConsent\(a\.doc\)\) return \{ allowed: false, reason: 'no_stored_consent' \}/.test(tcpa));
  }
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('alert_outbox rules: tenant readers + admin only, zero client writes',
    /match \/alert_outbox\/\{outboxId\}[\s\S]{0,600}allow create, update, delete: if false/.test(rules));

  // Delivery-health seam (2026-07-07): invites ledger too, and the
  // dashboard banner is the consumer that makes failed:* statuses visible.
  const inv = read(path.join(FUNCTIONS, 'handlers/invites.js'));
  assert('teamInviteEmail ledgers every send attempt to alert_outbox',
    /kind: 'team-invite'/.test(inv)
    && /collection\('alert_outbox'\)\.add\(/.test(inv)
    && /emailStatus,/.test(inv));
  assert('teamInviteEmail records failures with the failed: prefix the banner scans for',
    /emailStatus = 'failed:' \+ String\(/.test(inv));
  const idx = JSON.parse(read(path.join(ROOT, 'firestore.indexes.json')));
  assert('composite index {companyId, createdAt} exists for tenant-scoped outbox reads',
    idx.indexes.some(i => i.collectionGroup === 'alert_outbox'
      && i.fields.length === 2
      && i.fields[0].fieldPath === 'companyId'
      && i.fields[1].fieldPath === 'createdAt'));
}

section('Review request nudge (post-win sweep, 2026-07-14)');
{
  const nudge = read(path.join(FUNCTIONS, 'review-request-nudge.js'));
  const fnIndex = readFunctionsIndex();

  assert('reviewRequestNudge is exported from functions/index.js',
    /exports\.reviewRequestNudge = require\('\.\/review-request-nudge'\)\.reviewRequestNudge/.test(fnIndex));

  // Won detection is role-based: both query lanes feed the shared role
  // map — a hardcoded stage list alone must never decide "won" again.
  assert('nudge queries persisted stageRole AND re-verifies via stage-roles.roleFor',
    /where\('stageRole', '==', 'won'\)/.test(nudge)
    && /roles\.roleFor\(lead\) !== roles\.ROLE\.WON/.test(nudge)
    && /require\('\.\/stage-roles'\)/.test(nudge));

  // The anniversary-touch idempotency lesson, pinned: the mark fires in
  // every mode (incl. dry-run), and both "already asked" lanes skip.
  assert('nudge marks reviewNudgedAt in every mode and skips asked/nudged leads',
    /markReviewNudged/.test(nudge)
    && /lead\.reviewRequested\) continue/.test(nudge)
    && /timestampMillis\(lead\.reviewNudgedAt\)\) continue/.test(nudge));

  // Rep-in-the-loop: the sweep must never email/SMS the homeowner —
  // the only Resend send goes to the rep's own user.email digest.
  assert('nudge emails only the rep digest, never the homeowner',
    /to: user\.email,/.test(nudge)
    && !/to: lead\.email/.test(nudge)
    && /REVIEW_NUDGE_ENABLED/.test(nudge));

  // Bell notification matches the client engine's doc shape so the two
  // lanes dedupe against each other (review-engine.js createReviewNotification).
  assert('nudge notification doc shape matches the client engine + dedupes',
    /type: 'review_request',/.test(nudge)
    && /title: '⭐ Request a Review',/.test(nudge)
    && /where\('type', '==', 'review_request'\)/.test(nudge));

  const idx2 = JSON.parse(read(path.join(ROOT, 'firestore.indexes.json')));
  assert('composite index {userId, stageRole} exists for the persisted-role lane',
    idx2.indexes.some(i => i.collectionGroup === 'leads'
      && i.fields.length === 2
      && i.fields[0].fieldPath === 'userId'
      && i.fields[1].fieldPath === 'stageRole'));
}

section('Alert-health banner (delivery-failure surfacing)');
{
  const banner = read(path.join(PRO_JS, 'alert-health-banner.js'));
  assert('banner uses the __NBD_LOADED idempotency registry',
    /__NBD_LOADED\['alert-health-banner'\]/.test(banner));
  assert('banner scans both channels for failed: statuses',
    /isFailed\(d\.emailStatus\)/.test(banner) && /isFailed\(d\.smsStatus\)/.test(banner)
    && /indexOf\('failed:'\) === 0/.test(banner));
  assert('tenant branch pins companyId (rules provability + the composite index)',
    /where\('companyId', '==', claims\.companyId/.test(banner));
  assert('gated to owner / platform admin / company_admin',
    /claims\.admin === true \|\| claims\.owner === true \|\| role === 'company_admin'/.test(banner));
  assert('banner generates NO inline handler attributes (CSP script-src-attr none)',
    !/on(click|load|change|error)\s*=\s*"/.test(banner) && /addEventListener\('click'/.test(banner));
  assert('dashboard.html loads alert-health-banner.js',
    /alert-health-banner\.js/.test(readDashboard()));
}

section('Cloud Functions exports');
{
  const src = readFunctionsIndex();
  for (const fn of ['createTeamMember', 'updateUserRole', 'deactivateUser',
                    'listTeamMembers', 'rotateAccessCodes', 'submitPublicLead']) {
    assert('exports ' + fn, new RegExp('exports\\.' + fn + '\\s*=').test(src));
  }
  assert('requireTeamAdmin helper defined', /function requireTeamAdmin\s*\(/.test(src));
  // Audit 2026-08-02: the authority decision is the pure exported
  // teamAdminDecision (second company_admins accepted); seat-money keeps its
  // deliberate owner-only carve-out at the call site.
  assert('teamAdminDecision extracted + exported (pure, test-covered)',
    /function teamAdminDecision\s*\(/.test(src) && /teamAdminDecision,/.test(src));
  assert('requireTeamAdmin routes through teamAdminDecision',
    /const \{ allow, isOwner \} = teamAdminDecision\(\{/.test(src));
  assert('setCompanySeatCount stays owner-only via ownerOnly opt',
    /requireTeamAdmin\(request, null, \{ ownerOnly: true \}\)/.test(
      read(path.join(FUNCTIONS, 'handlers', 'seats.js'))));
  assert('normalizeRole rejects platform admin unconditionally',
    /if \(r === 'admin'\) return null/.test(src));
  assert('TEAM_ROLES excludes platform admin',
    /TEAM_ROLES = \['company_admin'[^\]]*\]/.test(src));
}

// ── firebase-admin v14 readiness: no legacy namespace accessors ──
// v14 removed the service accessors from require('firebase-admin')
// (admin.firestore / admin.auth() / admin.storage() / FieldValue via
// the namespace). Only initializeApp/getApps/cert survive there. These
// break at RUNTIME, not import time, so a grep guard is the only cheap
// tripwire. Modular imports (firebase-admin/firestore etc.) are the rule.
section('firebase-admin v14: legacy namespace is dead');
{
  const LEGACY = /\badmin\s*\.\s*(firestore|auth|storage|messaging|database|credential|appCheck|remoteConfig|instanceId|projectManagement|securityRules|machineLearning)\b/;
  // Files allowed to keep `const admin = require('firebase-admin')` —
  // they only call admin.initializeApp(), which v14 still exports.
  const REQUIRE_ALLOWLIST = new Set([
    'index.js', 'seed-demo.js', 'rate-limit-policy.js',
    'migrations/runner.js', 'migrate-companyprofile-per-tenant.js',
    'migrate-companyid-backfill.js', 'migrate-docprefixes.js',
  ]);
  const offendersLegacy = [];
  const offendersRequire = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.js')) continue;
      const rel = path.relative(FUNCTIONS, p).replace(/\\/g, '/');
      const src = fs.readFileSync(p, 'utf8');
      // Strip line comments so prose like "platform admin. The..." can't trip it.
      const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (LEGACY.test(code)) offendersLegacy.push(rel);
      if (/require\(['"]firebase-admin['"]\)/.test(code) && !REQUIRE_ALLOWLIST.has(rel)) {
        offendersRequire.push(rel);
      }
    }
  };
  walk(FUNCTIONS);
  assert('no legacy admin.<service> accessors anywhere under functions/ — ' +
    (offendersLegacy.join(', ') || 'clean'), offendersLegacy.length === 0);
  assert('bare require(firebase-admin) only in initializeApp allowlist — ' +
    (offendersRequire.join(', ') || 'clean'), offendersRequire.length === 0);

  // ── the same tripwire over scripts/, which had none until 2026-09-01 ──
  //
  // This guard walked functions/ ONLY, and that is exactly how scripts/
  // drifted: nineteen scripts copy-pasted a dead init block, four earlier
  // migration tranches fixed them a few at a time, and the last two
  // (import-cost-rotation.js, import-job-template-costs.js) survived every
  // sweep because they FAILED DIFFERENTLY. They carried their own
  // createRequire fallback, so they resolved firebase-admin fine and never
  // threw MODULE_NOT_FOUND — the break was three v14-removed namespace
  // spellings that only fire at write time, past the dry-run exit, on the
  // most sensitive collection in the repo (catalogCosts/{companyId}).
  //
  // A grep is the only cheap tripwire for a runtime-only break, and scripts/
  // is now clean, so pin it. `admin.apps` / `admin.app` are in this pattern
  // and not in the functions/ one because the scripts' dead init guard was
  // `if (!admin.apps.length)`.
  //
  // NOT applied to scripts/: the bare-require allowlist. scripts/ has no
  // node_modules of its own, so resolving firebase-admin out of functions/
  // — whether via scripts/_admin.js or an inline createRequire — is correct
  // there and must not be flagged.
  const SCRIPTS = path.join(ROOT, 'scripts');
  const LEGACY_SCRIPTS = /\badmin\s*\.\s*(firestore|auth|storage|messaging|database|credential|appCheck|remoteConfig|instanceId|projectManagement|securityRules|machineLearning|apps|app)\b/;
  const offendersScripts = [];
  for (const name of fs.readdirSync(SCRIPTS)) {
    if (!name.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(SCRIPTS, name), 'utf8');
    // Strip comments — every remaining mention in scripts/ is prose EXPLAINING
    // the dead pattern, and that prose is worth keeping.
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const m = code.match(LEGACY_SCRIPTS);
    if (m) offendersScripts.push(name + ' (' + m[0] + ')');
  }
  assert('no legacy admin.<service>/admin.apps accessors anywhere under scripts/ — ' +
    (offendersScripts.join(', ') || 'clean'), offendersScripts.length === 0);

  // The two scripts the 2026-09-01 tranche ported, pinned by name. Division of
  // labour with the sweep above: the sweep catches a bad SPELLING coming back,
  // this catches the resolver being reintroduced — a script could go back to
  // its own createRequire fallback while still using modular calls, and the
  // sweep would not notice.
  for (const s of ['import-cost-rotation.js', 'import-job-template-costs.js']) {
    const src = read(path.join(SCRIPTS, s));
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert('F5: ' + s + ' takes firebase-admin through scripts/_admin.js',
      /require\(['"]\.\/_admin['"]\)/.test(code)
      && !/createRequire\(/.test(code));
  }
}

// ── rotateAccessCodes: opt-in revocation cascade (2026-07 audit) ──
// Deactivating a code only blocks FUTURE redemptions; accounts that
// already redeemed keep their subscriptions/{uid} plan forever unless
// { revokeGrants: true } cascades the rotation to those grants. The
// cascade must stay OPT-IN (default false) — rotating to stop new
// signups must never silently downgrade existing customers.
section('rotateAccessCodes: access-code revocation cascade');
{
  const adminSrc = read(path.join(FUNCTIONS, 'handlers/admin.js'));
  const bodyMatch = adminSrc.match(/exports\.rotateAccessCodes\s*=\s*onCall\([\s\S]*?\n\);/);
  assert('rotateAccessCodes export body found', !!bodyMatch);
  const body = bodyMatch ? bodyMatch[0] : '';

  // Auth guards unchanged: signed-in + platform admin only.
  assert('still requires auth (unauthenticated guard)',
    /unauthenticated/.test(body));
  assert('still platform-admin only (role !== admin → permission-denied)',
    /request\.auth\.token\.role !== 'admin'[\s\S]{0,120}permission-denied/.test(body));

  // Opt-in contract: strict-boolean true, defaults false.
  assert('revokeGrants parsed as strict === true (opt-in, default false)',
    /revokeGrants\s*=\s*!!\(request\.data && request\.data\.revokeGrants === true\)/.test(body));
  assert('cascade only runs behind the revokeGrants flag',
    /if \(revokeGrants\) \{[\s\S]*?where\('source', '==', 'access_code'\)/.test(body));

  // Query shape: source == access_code AND accessCode in <legacy codes>,
  // chunked to the Firestore 'in' cap of 30.
  assert('cascade queries subscriptions by source + accessCode-in',
    /collection\('subscriptions'\)[\s\S]{0,120}where\('source', '==', 'access_code'\)[\s\S]{0,80}where\('accessCode', 'in', chunk\)/.test(body));
  assert("chunks the 'in' filter at Firestore's cap of 30",
    /IN_CAP = 30/.test(body) && /LEGACY_ACCESS_CODES\.slice\(i, i \+ IN_CAP\)/.test(body));

  // Downgrade contract: plan free + status revoked + audit trail on the doc.
  assert('downgrade writes plan:free + status:revoked',
    /plan:\s*'free',\s*\n\s*status:\s*'revoked'/.test(body));
  assert('audit trail fields kept on the subscription doc',
    /revokedAt: FieldValue\.serverTimestamp\(\)/.test(body)
    && /revokedBy: uid/.test(body)
    && /revokedFromCode:/.test(body));
  assert('idempotent: already-revoked grants are skipped',
    /status === 'revoked' && sub\.plan === 'free'\) continue/.test(body));

  // Counts surface in the response + audit_log entry.
  assert('response returns cascade counts',
    /return \{ success: true, deactivated, revokeGrants, revokedGrants \}/.test(body));
  assert('audit_log entry records revokeGrants + revokedGrants',
    /audit_log[\s\S]{0,400}revokeGrants,\s*\n\s*revokedGrants/.test(body));

  // Client safety: the admin-manager button must NOT opt in — rotating
  // from the UI stays deactivate-only unless someone deliberately wires
  // (and confirms) the cascade.
  const adminUi = read(path.join(PRO_JS, 'admin-manager.js'));
  assert('admin-manager UI does not pass revokeGrants (default-false path)',
    !/revokeGrants/.test(adminUi));

  // The cascade's premise: plan is doc-resolved, not claim-resolved —
  // validateAccessCode never MINTS a plan/companyId claim (plan lives in the
  // subscriptions doc), so a doc downgrade is sufficient on revoke. It now
  // read-MERGES the role claim (…existingClaims) rather than replacing the whole
  // set, so redeeming a code on an already-provisioned account can't wipe that
  // owner's companyId/owner claims (Settings sweep).
  const portalSrc = read(path.join(FUNCTIONS, 'handlers/portal.js'));
  assert('validateAccessCode merges the role claim (preserves existing) without replacing the set',
    /setCustomUserClaims\(userRecord\.uid, \{ \.\.\.existingClaims, role \}\)/.test(portalSrc));
  assert('validateAccessCode does NOT mint a plan/companyId claim (doc-resolved)',
    !/setCustomUserClaims\([^)]*\b(plan|companyId)\s*:/.test(portalSrc));
}

// ── Phase C: public-lead → CRM pipeline bridge (H-1) ─────────
section('Phase C: lead-bridge (H-1 intake → CRM)');
{
  const bridge = read(path.join(FUNCTIONS, 'lead-bridge.js'));
  // C-1: the triggers MUST assign onDocumentCreated DIRECTLY (not via a
  // makeTrigger wrapper), or the CI deploy enumeration omits them and the
  // bridge never reaches prod. This guard replicates the exact factory regex
  // from .github/workflows/firebase-deploy.yml so the gap can't recur.
  const CI_FACTORY = '(onRequest|onCall|beforeUserCreated|beforeUserSignedIn|onSchedule|onDocumentCreated|onDocumentUpdated|onDocumentWritten|onDocumentDeleted)';
  for (const fn of ['leadBridgeContact', 'leadBridgeEstimate', 'leadBridgeInspect', 'leadBridgeFreeRoof', 'leadBridgeStorm']) {
    assert('lead-bridge exports ' + fn + ' as a direct factory call (CI-deployable)',
      new RegExp('^exports\\.' + fn + ' *= *' + CI_FACTORY, 'm').test(bridge));
  }
  assert('lead-bridge fires onDocumentCreated', /onDocumentCreated/.test(bridge));
  assert('lead-bridge mirrors into the leads collection', /collection\('leads'\)\.doc\(/.test(bridge));
  assert('lead-bridge idempotent via create() (not set)', /\.create\(leadDoc\)/.test(bridge));
  assert('lead-bridge uses modular FieldValue (emulator-safe)',
    /require\('firebase-admin\/firestore'\)/.test(bridge) && /FieldValue\.serverTimestamp/.test(bridge));

  const logic = read(path.join(FUNCTIONS, 'lead-bridge-logic.js'));
  assert('lead-bridge-logic exports the pure helpers',
    /resolveBridgeTarget/.test(logic) && /mapPublicLeadToLead/.test(logic) && /bridgeDocId/.test(logic));
  assert('lead-bridge bridges the 4 unconditional kinds + conditional storm (not guide)',
    /contact_leads:/.test(logic) && /inspect_leads:/.test(logic) &&
    !/guide_leads:/.test(logic));
  assert('lead-bridge storm is concern-gated (shouldBridgeStorm) + shares the alert concern set',
    /shouldBridgeStorm/.test(logic) && /HIGH_INTENT_STORM_CONCERNS/.test(logic) &&
    /shouldBridgeStorm/.test(bridge));

  const idx = readFunctionsIndex();
  assert('index.js wires lead-bridge', /require\('\.\/lead-bridge'\)/.test(idx));
}

// ── H-6: Stripe webhook hardening ───────────────────────────
section('H-6: Stripe webhook raw body + replay');
{
  // L-03 cont.: Stripe handlers moved to functions/stripe.js.
  const src = read(path.join(FUNCTIONS, 'stripe.js'));
  assert('stripeWebhook rejects when rawBody is not a Buffer',
    /stripeWebhook missing rawBody[\s\S]{0,200}Buffer\.isBuffer/.test(src) ||
    /!Buffer\.isBuffer\(req\.rawBody\)[\s\S]{0,100}stripeWebhook/.test(src) ||
    // robust form: look for both the guard and the explicit tolerance
    (/!Buffer\.isBuffer\(req\.rawBody\)/.test(src) &&
     /constructEvent\(req\.rawBody,\s*sig,\s*webhookSecret,\s*300\)/.test(src)));
  // invoiceWebhook verifies against its OWN endpoint secret first (Stripe
  // issues a distinct whsec per endpoint), falling back to the legacy shared
  // secret during rotation — still with the explicit 300s tolerance.
  assert('invoiceWebhook passes explicit 300s tolerance',
    /constructEvent\(req\.rawBody,\s*signature,\s*secret,\s*300\)/.test(src));
  // 2026-09-04: both reads go through secretValue() so the deploy's
  // '__unset__' stub is never pushed as a signing candidate (it used to be —
  // a truthy string passed the `if (legacy)` guard). Same order, same guard.
  assert('invoiceWebhook prefers its dedicated endpoint secret with legacy fallback',
    /secretValue\(STRIPE_INVOICE_WEBHOOK_SECRET\)[\s\S]{0,120}startsWith\('whsec_'\)/.test(src)
    && /secretValue\(STRIPE_WEBHOOK_SECRET\)[\s\S]{0,80}candidates\.push\(legacy\)/.test(src));
  {
    // Scope to the candidates block: the platform stripeWebhook has its own
    // legitimate STRIPE_WEBHOOK_SECRET read elsewhere in the file.
    const start = src.indexOf('const candidates = [];');
    const end = src.indexOf('for (const secret of candidates)', start);
    const block = start >= 0 && end > start ? src.slice(start, end) : '';
    assert('invoiceWebhook builds its candidate list without a bare .value() read (stub-unsafe)',
      block.length > 0 && !/\.value\(\)/.test(block));
  }

  // Shared Stripe client: one trimmed, retrying instance for all handlers.
  // A trailing newline in the stored secret key caused ERR_INVALID_CHAR →
  // opaque "connection to Stripe" 500s; getStripe() .trim()s it once.
  assert('stripe.js exposes a shared getStripe() helper',
    /function getStripe\(\)/.test(src));
  assert('getStripe trims the secret key (kills the tainted-newline 500)',
    /getStripe[\s\S]{0,200}STRIPE_SECRET_KEY\.value\(\)[\s\S]{0,80}\.trim\(\)/.test(src));
  assert('getStripe sets maxNetworkRetries + timeout',
    /getStripe[\s\S]{0,400}maxNetworkRetries[\s\S]{0,80}timeout/.test(src));
  assert('no per-handler raw new Stripe(SECRET.value()) — all go through getStripe()',
    !/new Stripe\(STRIPE_SECRET_KEY\.value\(\)/.test(src) &&
    (src.match(/= getStripe\(\);/g) || []).length >= 5);
}

// ────────────────────────────────────────────────────────────
//  INTEGRATIONS
// ────────────────────────────────────────────────────────────

section('Integration module skeleton');
{
  const dir = path.join(FUNCTIONS, 'integrations');
  for (const f of ['_shared.js','sentry.js','slack.js','turnstile.js',
                    'upstash-ratelimit.js','measurement.js','esign.js',
                    'parcel.js','hail.js','calcom.js']) {
    assert('integrations/' + f + ' present', fs.existsSync(path.join(dir, f)));
  }
  const shared = read(path.join(dir, '_shared.js'));
  assert('_shared exposes SECRETS registry', /const SECRETS\s*=\s*\{/.test(shared));
  assert('_shared exposes PROVIDERS map', /const PROVIDERS\s*=\s*\{/.test(shared));
  assert('_shared has hasSecret + notConfigured helpers',
    /function hasSecret\(/.test(shared) && /function notConfigured\(/.test(shared));
}

section('Sentry');
{
  const srv = read(path.join(FUNCTIONS, 'integrations/sentry.js'));
  assert('withSentry helper exported', /module\.exports\s*=\s*\{[\s\S]*withSentry/.test(srv));
  assert('PII redaction in beforeSend',
    /beforeSend[\s\S]{0,500}email\|phone\|address/.test(srv));
  const cli = read(path.join(PRO_JS, 'sentry-init.js'));
  assert('client registers window.NBDSentry', /window\.NBDSentry\s*=/.test(cli));
  assert('client redacts email + phone + Bearer tokens',
    /\[email\]/.test(cli) && /\[phone\]/.test(cli) && /\[token\]/.test(cli));
  const idx = readFunctionsIndex();
  assert('index.js imports withSentry', /require\(['"]\.\/integrations\/sentry['"]\)/.test(idx));
  const dash = read(path.join(ROOT, 'docs/pro/dashboard.html'));
  assert('dashboard loads sentry-init.js', /sentry-init\.js/.test(dash));
  // DSN slot moved out of inline <script> and into js/sentry-config.js
  // (single source of truth across pages — see "Sentry — DSN config
  // wired across high-value pages" section below).
  assert('dashboard loads sentry-config.js (DSN slot)',
    /sentry-config\.js/.test(dash));
}

section('Slack alerts');
{
  const src = read(path.join(FUNCTIONS, 'integrations/slack.js'));
  for (const name of ['slack_onLeadWon','slack_onAdminGrantAttempt','slack_onStormAlert']) {
    assert('exports ' + name, new RegExp('exports\\.' + name + '\\s*=').test(src));
  }
  // PREMISE REWRITTEN 2026-07-30 (#1146 audit, findings 1 + 11). This
  // assertion is KEPT — silent-fail on a missing webhook is still the
  // contract — but it was never the guard it was read as. It checks the
  // helper's own internal guard and nothing else, so it passed happily while
  // BOTH Stripe webhooks called postSlack without declaring
  // SLACK_WEBHOOK_URL in their secrets arrays: Gen2 mounts only a function's
  // DECLARED secrets, so the param read '', hasSecret() was false, and every
  // dispute + dunning alert returned {posted:false, reason:'unconfigured'}
  // and was discarded. The binding check below is the part that would have
  // caught it.
  assert('Slack helper fails silent on missing webhook',
    /hasSecret\('SLACK_WEBHOOK_URL'\)[\s\S]{0,120}return \{ posted: false/.test(src));

  // ── Anti-rot: postSlack caller ⇒ SLACK_WEBHOOK_URL bound ──────────────
  // Every DEPLOYED function under functions/ that can reach a postSlack call
  // — directly, or through a module-level helper in the same file — must
  // declare SLACK_WEBHOOK_URL in its own secrets array. Undeclared = the
  // alert is dropped in silence, which is invisible in every other test we
  // have (they assert on source text, and the source looks correct).
  {
    const POST_SLACK = /postSlack\s*\(/;              // NOT postSlackSummary(
    const TOP_LEVEL = /^(?:async\s+)?function\s+[\w$]+|^exports\.[\w$]+\s*=|^module\.exports/gm;

    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.js')) files.push(p);
      }
    })(FUNCTIONS);

    const posters = [];   // deployed functions that can reach postSlack
    const unbound = [];   // …of those, the ones not declaring the secret
    for (const file of files) {
      const body = read(file);
      if (!POST_SLACK.test(body)) continue;

      // Split on column-0 definitions. A deployed function's own body is
      // always indented, so a top-level `function`/`exports.` reliably ends
      // the previous region — which is what keeps a module-level helper
      // (e.g. stripe.js alertInvoicePaymentEvent) from being mis-attributed
      // to whichever handler happens to sit above it.
      const starts = [];
      let m;
      TOP_LEVEL.lastIndex = 0;
      while ((m = TOP_LEVEL.exec(body)) !== null) starts.push(m.index);
      const regions = starts.map((start, i) => ({
        text: body.slice(start, i + 1 < starts.length ? starts[i + 1] : body.length),
      }));

      // Pass 1: module-level helpers that post to Slack on a caller's behalf.
      const slackHelpers = [];
      for (const r of regions) {
        const h = /^(?:async\s+)?function\s+([\w$]+)/.exec(r.text);
        if (h && POST_SLACK.test(r.text)) slackHelpers.push(h[1]);
      }

      // Pass 2: deployed functions, direct callers or helper callers.
      for (const r of regions) {
        const d = /^exports\.([\w$]+)\s*=/.exec(r.text);
        if (!d || !/\bon[A-Z]\w*\s*\(/.test(r.text.slice(0, 400))) continue;
        const reaches = POST_SLACK.test(r.text)
          || slackHelpers.some(h => new RegExp('\\b' + h + '\\s*\\(').test(r.text));
        if (!reaches) continue;
        const label = path.relative(FUNCTIONS, file).replace(/\\/g, '/') + ':' + d[1];
        posters.push(label);
        const arr = /secrets:\s*\[[\s\S]*?\]/.exec(r.text);
        if (!arr || !/SLACK_WEBHOOK_URL/.test(arr[0])) unbound.push(label);
      }
    }

    // The scan finding nothing is itself the failure mode this guard is most
    // likely to rot into, so pin a floor: slack.js's 3 triggers, device-alert,
    // storm-briefing, and both Stripe webhooks.
    assert('postSlack-caller scan found the known Slack-posting functions',
      posters.length >= 7
        && posters.includes('stripe.js:invoiceWebhook')
        && posters.includes('stripe.js:stripeWebhook'),
      'found: ' + (posters.join(', ') || 'NONE'));
    assert('every postSlack caller declares SLACK_WEBHOOK_URL in its secrets array',
      unbound.length === 0,
      unbound.length ? 'unbound (alerts silently dropped): ' + unbound.join(', ') : '');
  }

  // Binding the secret is necessary but NOT sufficient: prod's
  // SLACK_WEBHOOK_URL still holds only the deploy workflow's '__unset__' stub,
  // so Slack stays unconfigured until the owner sets it. The owner-only,
  // action-required chargeback copy therefore needs a channel that works
  // today — an email_queue CC to NBD_OWNER_UID (#1146 finding 1, half b).
  {
    const st = read(path.join(FUNCTIONS, 'stripe.js'));
    assert('alertInvoicePaymentEvent can CC the platform owner via email_queue',
      /if \(opts\.ownerUid\)[\s\S]{0,1600}collection\('email_queue'\)\.add\(\{[\s\S]{0,500}audience: 'platform_owner'/.test(st));
    assert('a requested owner alert that resolves no email is an ERROR, not silence',
      /logger\.error\('payment_event_owner_alert_undeliverable'/.test(st));
    assert('postSlack result is no longer discarded by alertInvoicePaymentEvent',
      /payment_event_slack_not_delivered/.test(st));
  }
}

section('Turnstile');
{
  const src = read(path.join(FUNCTIONS, 'integrations/turnstile.js'));
  assert('verifyTurnstile exported', /module\.exports\s*=\s*\{\s*verifyTurnstile\s*\}/.test(src));
  assert('fails closed on verifier error',
    /Fail CLOSED/i.test(src) && /'verify-error'/.test(src));
  const idx = readFunctionsIndex();
  assert('submitPublicLead invokes verifyTurnstile',
    /verifyTurnstile\(\s*\(req\.body && req\.body\.turnstileToken\)/.test(idx));
}

section('Upstash rate limiter adapter');
{
  const src = read(path.join(FUNCTIONS, 'integrations/upstash-ratelimit.js'));
  assert('exports enforceRateLimit + httpRateLimit',
    /module\.exports\s*=\s*\{[\s\S]*enforceRateLimit[\s\S]*httpRateLimit/.test(src));
  assert('falls back to Firestore limiter when not configured',
    /firestoreLimiter\.enforceRateLimit/.test(src));
  assert('uses pipeline INCR + EXPIRE NX',
    /\['INCR', key\][\s\S]{0,100}\['EXPIRE', key/.test(src));
  const idx = readFunctionsIndex();
  assert('index.js now requires the adapter',
    /require\(['"]\.\/integrations\/upstash-ratelimit['"]\)/.test(idx));
}

section('Measurement adapter');
{
  const src = read(path.join(FUNCTIONS, 'integrations/measurement.js'));
  for (const name of ['requestMeasurement','measurementWebhook']) {
    assert('exports ' + name, new RegExp('exports\\.' + name + '\\s*=').test(src));
  }
  assert('supports hover + eagleview + nearmap',
    /requestHOVER/.test(src) && /requestEagleView/.test(src) && /requestNearmap/.test(src));
  assert('supports instantroofer (coordinates-in, synchronous — the default since 2026-09-06)',
    /requestInstantRoofer/.test(src) && /instantroofer-logic/.test(src));
  assert('requestMeasurement binds INSTANTROOFER_API_KEY (Gen2 mounts only declared secrets)',
    /secrets:\s*\[[^\]]*SECRETS\.INSTANTROOFER_API_KEY/.test(src));
  assert('measurementWebhook binds INSTANTROOFER_WEBHOOK_SECRET',
    /secrets:\s*\[[^\]]*SECRETS\.INSTANTROOFER_WEBHOOK_SECRET/.test(src));
  assert('provider selection driven by PROVIDERS.measurement',
    /PROVIDERS\.measurement/.test(src));
}

section('E-sign (BoldSign)');
{
  const src = read(path.join(FUNCTIONS, 'integrations/esign.js'));
  for (const name of ['sendEstimateForSignature','esignWebhook']) {
    assert('exports ' + name, new RegExp('exports\\.' + name + '\\s*=').test(src));
  }
  assert('HMAC-verifies BoldSign webhook signature',
    /createHmac\('sha256', getSecret\('BOLDSIGN_WEBHOOK_SECRET'\)\)/.test(src));
  assert('verifies caller owns the estimate before sending',
    /est\.userId !== uid[\s\S]{0,100}'admin'/.test(src));
}

section('Parcel (Regrid)');
{
  const src = read(path.join(FUNCTIONS, 'integrations/parcel.js'));
  assert('exports lookupParcel', /exports\.lookupParcel\s*=/.test(src));
  assert('caches lookups in parcel_cache',
    /parcel_cache\/\$\{key\}/.test(src));
  assert('90-day TTL constant', /CACHE_TTL_MS\s*=\s*90/.test(src));
}

section('Hail (HailTrace + NOAA SPC)');
{
  const src = read(path.join(FUNCTIONS, 'integrations/hail.js'));
  assert('exports getHailHistory', /exports\.getHailHistory\s*=/.test(src));
  assert('uses NOAA/IEM JSON endpoint',
    /mesonet\.agron\.iastate\.edu/.test(src));
  assert('falls back to NOAA if HailTrace fails',
    /noaa-fallback/.test(src));
}

section('Cal.com webhook');
{
  const src = read(path.join(FUNCTIONS, 'integrations/calcom.js'));
  assert('exports calcomWebhook', /exports\.calcomWebhook\s*=/.test(src));
  assert('HMAC-verifies X-Cal-Signature-256',
    /x-cal-signature-256[\s\S]{0,300}createHmac\('sha256'/.test(src));
  // The cal.com webhook creates the appointments doc; the appointment-reminder
  // cron (push-functions.js) reminds off it. The old "remind 1hr before"
  // tasks/{id} write was removed as dead code (dueAt had zero readers), so we
  // no longer assert it.
  assert('creates appointments doc',
    /appointments\/\$\{bookingId\}/.test(src));
  // M-2: a cold organic booking (no pre-existing lead to match against) was
  // silently dropped — appointments/{id} got written but nothing appeared in
  // Pipeline. Regression guard so this doesn't quietly regress back to that.
  assert('creates a CRM lead when no existing lead matches the booking',
    /if \(!leadId\) \{[\s\S]{0,600}collection\('leads'\)\.doc\(newLeadId\)\.create\(/.test(src));
  assert('new-lead id is deterministic (idempotent against retried webhook delivery)',
    /bridgeDocId\('calcom', bookingId\)/.test(src));
  // 2026-09-13: the contact fields (phone, phoneDigits, address) moved into
  // integrations/calcom-logic.js, which tests/calcom-webhook-payload.test.js
  // EXECUTES against documented payloads. This regex used to pin
  // `phoneDigits: phoneDigits10(phone)` in calcom.js — and passed while every
  // booking lost its phone, because `phone` came from a field Cal.com never
  // sends. Rep scoping stays in calcom.js and is still pinned here.
  const logic = read(path.join(FUNCTIONS, 'integrations/calcom-logic.js'));
  assert('new lead is scoped to the rep and built by the shared resolver',
    /companyId:\s*repCompanyId \|\| repUid/.test(src) &&
    /CL\.buildCalcomLeadFields\(\{ payload, bookingId \}\)/.test(src));
  assert('calcom-logic stamps phoneDigits via the canonical transform',
    /require\('\.\.\/phone-utils'\)/.test(logic) && /phoneDigits:\s*phoneDigits10\(/.test(logic));
}

section('backfill — dropped Cal.com bookings repair tool');
{
  // scripts/** is deliberately outside check-js-syntax's ROOTS, so these
  // asserts are the only CI guard on this tool. They pin the properties that
  // make it safe to point at PROD: dry-run default, and a lead id derived by
  // the SAME helper the webhook uses (an invented id would silently defeat
  // reschedule idempotency and mint a duplicate pipeline card).
  const fs = require('fs');
  const p = path.join(ROOT, 'scripts/backfill-calcom-dropped-leads.js');
  assert('scripts/backfill-calcom-dropped-leads.js exists', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const bf = read(p);
    assert('backfill is dry-run-by-default + --apply needs --yes',
      /APPLY && !YES/.test(bf) && /--apply --yes/.test(bf));
    assert('backfill derives the lead id via the shared bridgeDocId (no drift vs webhook)',
      /require\(['"]\.\.\/functions\/lead-bridge-logic['"]\)/.test(bf) &&
      /bridgeDocId\('calcom', b\.uid\)/.test(bf));
    assert('backfill stamps phoneDigits via the shared transform',
      /require\(['"]\.\.\/functions\/phone-utils['"]\)/.test(bf) &&
      /phoneDigits:\s*phoneDigits10\(phone\)/.test(bf));
    assert('backfill uses .create() so a concurrent webhook delivery is not clobbered',
      /leadRef\.create\(/.test(bf));
    assert('backfill links an already-known attendee instead of duplicating',
      /findExistingLead/.test(bf) && /linked to existing/.test(bf));
    assert('backfill omits credentials against the emulator (never presents real ADC)',
      /FIRESTORE_EMULATOR_HOST/.test(bf) && /credential:\s*null/.test(bf));
    assert('backfill hardcodes no customer PII',
      !/seiya256|8594663151|Moock/i.test(bf));
  }
}

section('Unified client + status endpoint');
{
  const src = read(path.join(PRO_JS, 'integrations-client.js'));
  assert('exposes window.NBDIntegrations', /window\.NBDIntegrations\s*=/.test(src));
  for (const fn of ['requestMeasurement','sendForSignature','lookupParcel','getHailHistory']) {
    assert('NBDIntegrations.' + fn, new RegExp('async function ' + fn + '\\(').test(src));
  }
  const idx = readFunctionsIndex();
  assert('integrationStatus callable exported', /exports\.integrationStatus\s*=/.test(idx));

  // integration-availability-non-admin fix: status() used to short-circuit
  // for any non-admin caller (via a client-side _isAdminCaller() check) and
  // fake a permanently-empty { configured: {} } without ever calling the
  // server — which made requireConfigured() unconditionally false for every
  // ordinary rep's Auto-measure / e-sign / parcel-lookup buttons. status()
  // must now call the non-admin-safe integrationAvailability callable for
  // everyone, and the short-circuit helper must be gone entirely.
  // (Regression check: this assertion fails against the pre-fix source,
  // which called callable('integrationStatus') from inside status() and
  // still defined _isAdminCaller.)
  const statusFnBody = (src.match(/async function status\(force\) \{[\s\S]+?\n  \}/) || [''])[0];
  assert('status() found in integrations-client.js', statusFnBody.length > 0);
  assert("status() calls the integrationAvailability callable, not integrationStatus",
    /callable\('integrationAvailability'\)/.test(statusFnBody)
    && !/callable\('integrationStatus'\)/.test(statusFnBody));
  assert('_isAdminCaller no longer exists anywhere in integrations-client.js',
    !/_isAdminCaller/.test(src));
}

section('Push-3: booking-link SMS uses calcomUsername');
{
  // Step 4b: _repBookingUrl + sendBookingSMS + sendFollowUpSMS moved
  // to crm-portal-bridge.js — concat via readCrm() so the assertions
  // find them.
  const src = readCrm();
  assert('_repBookingUrl helper defined',
    /window\._repBookingUrl\s*=\s*function/.test(src));
  assert('sendBookingSMS uses _repBookingUrl',
    /sendBookingSMS[\s\S]{0,300}window\._repBookingUrl\(\)/.test(src));
  assert('sendFollowUpSMS uses _repBookingUrl',
    /sendFollowUpSMS[\s\S]{0,500}window\._repBookingUrl\(\)/.test(src));
  const dash = readDashboard();
  assert('dashboard hydrates _currentRep.calcomUsername on auth',
    /window\._currentRep[\s\S]{0,500}calcomUsername: calVal/.test(dash));
}

section('Push-5: measurement webhook auto-attaches to lead');
{
  const src = read(path.join(FUNCTIONS, 'integrations/measurement.js'));
  assert('webhook writes task on ready transition',
    /measurement_ready[\s\S]{0,5}|collection\('tasks'\)\.add/.test(src));
  // Written with a deterministic doc id + merge since 2026-09-06 so a
  // re-measure updates the entry instead of stacking duplicates.
  assert('webhook writes activity entry on the lead',
    /doc\(`leads\/\$\{leadId\}\/activity\/\$\{taskId\}`\)\.set\(/.test(src));
  assert('...and the task on leads/{id}/tasks, the collection every task UI reads',
    /doc\(`leads\/\$\{leadId\}\/tasks\/\$\{taskId\}`\)\.set\(/.test(src)
    && !/collection\('tasks'\)\.add/.test(src));
  assert('webhook sets lead.measurementReady flag',
    /measurementReady: true/.test(src));
  assert('idempotency guard: checks previous status before writing',
    /wasReadyAlready = measurementData\.status === 'ready'/.test(src));
  // Step 4b: buildCard (which renders the measurement chip) lives in
  // crm-pipeline.js post-split — concat via readCrm() so the
  // assertion finds it.
  const crm = readCrm();
  assert('kanban card renders measurement chip when l.measurementReady',
    /l\.measurementReady \?/.test(crm));
}

section('Wave A1: deploy runbook');
{
  assert('scripts/deploy-runbook.sh exists',
    fs.existsSync(path.join(ROOT, 'scripts/deploy-runbook.sh')));
  const src = read(path.join(ROOT, 'scripts/deploy-runbook.sh'));
  assert('runbook preflights firebase login',
    /firebase projects:list/.test(src));
  assert('runbook deploys rules + indexes before functions',
    /firestore:rules,firestore:indexes[\s\S]{0,400}firebase deploy --only functions/.test(src));
  assert('runbook runs smoke tests before deploy',
    /Running smoke tests/i.test(src));
  assert('runbook lists required + optional secrets',
    /SECRETS_REQUIRED_FOR_CORE/.test(src) && /SECRETS_RECOMMENDED/.test(src));
}

section('Wave A2: Turnstile widgets');
{
  const helper = read(path.join(ROOT, 'docs/assets/js/public-lead-submit.js'));
  assert('helper loads Turnstile API on demand',
    /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(helper));
  assert('helper attaches turnstileToken to payload',
    /turnstileToken/.test(helper));
  assert('nbdTurnstileExecute exposed on window', /window\.nbdTurnstileExecute/.test(helper));
  const pages = ['docs/index.html','docs/estimate.html','docs/storm-alerts.html','docs/sites/free-guide/index.html'];
  for (const p of pages) {
    const html = read(path.join(ROOT, p));
    // After the 2026-05-22 CSP inline-script sweep, the slot may be inline OR
    // extracted to docs/assets/js/inline/<hash>.js (referenced via <script src>).
    // Accept both: scan the HTML, and if absent, follow any inline-extracted
    // script refs and scan those bodies too.
    let exposed = /window\.__NBD_TURNSTILE_SITEKEY/.test(html);
    if (!exposed) {
      const inlineRefs = [...html.matchAll(/<script[^>]*src="\/assets\/js\/inline\/([a-z0-9.]+\.js)"/gi)].map(m => m[1]);
      for (const f of inlineRefs) {
        try {
          if (/window\.__NBD_TURNSTILE_SITEKEY/.test(read(path.join(ROOT, 'docs/assets/js/inline', f)))) {
            exposed = true;
            break;
          }
        } catch {}
      }
    }
    assert(p + ' exposes __NBD_TURNSTILE_SITEKEY slot (inline or in extracted /assets/js/inline/)', exposed);
  }
}

section('Wave A3: privacy sub-processor disclosure');
{
  const pv = read(path.join(ROOT, 'docs/privacy.html'));
  for (const vendor of ['Resend','Twilio','Anthropic','BoldSign','Instant Roofer','HOVER','EagleView','Nearmap','Regrid','HailTrace','Cal.com','Sentry','Cloudflare Turnstile']) {
    assert('privacy lists ' + vendor, new RegExp(vendor.replace('.','\\.'), 'i').test(pv));
  }
}

section('Wave A5: firestore rules tests cover new collections');
{
  const t = read(path.join(ROOT, 'tests/firestore-rules.test.js'));
  for (const coll of ['portal_tokens','parcel_cache','measurements','appointments','audit_log']) {
    assert('rules test covers ' + coll, new RegExp(coll).test(t));
  }
  assert('negative test on public lead direct writes',
    /assertFails\(setDoc\(doc\(anon, 'contact_leads/.test(t));
  assert('company_admin alone cannot write members without ownerId match',
    /Carol has role: company_admin[\s\S]{0,300}assertFails/.test(t));
}

section('Wave C1: signImageUrl replaces imageProxy streaming');
{
  const idx = readFunctionsIndex();
  assert('signImageUrl onRequest exported', /exports\.signImageUrl\s*=/.test(idx));
  assert('signImageUrl issues 15-min signed URL',
    /getSignedUrl[\s\S]{0,200}Date\.now\(\) \+ 15 \* 60_000/.test(idx));
  assert('signImageUrl reuses tenant scoping logic',
    /exports\.signImageUrl[\s\S]*?\['manager', 'company_admin'\]\.includes\(callerRole\)/.test(idx));
  const client = read(path.join(PRO_JS, 'signed-image-url.js'));
  assert('client helper exposes window.NBDSignedUrl', /window\.NBDSignedUrl/.test(client));
  assert('client helper caches signed URLs', /CACHE_TTL_MS/.test(client));
}

section('Wave C2: hail cron');
{
  const src = read(path.join(FUNCTIONS, 'integrations/hail-cron.js'));
  assert('onSchedule declared', /onSchedule\(/.test(src));
  assert('daily schedule', /schedule:\s*'every day/.test(src));
  assert('slack summary posted when newHits > 0',
    /newHits\.length > 0[\s\S]{0,400}postSlackSummary/.test(src));
  const idx = readFunctionsIndex();
  assert('index.js registers hail-cron', /require\(['"]\.\/integrations\/hail-cron['"]\)/.test(idx));
}

section('Wave C4: SMS rate limits');
{
  const src = read(path.join(FUNCTIONS, 'sms-functions.js'));
  assert('sms-functions.js uses Upstash-first adapter',
    /require\(['"]\.\/integrations\/upstash-ratelimit['"]\)/.test(src));
  assert('sendSMS enforces per-recipient cap',
    /sendSMS:to[\s\S]{0,200}toDigits/.test(src));
  assert('sendD2DSMS enforces per-recipient cap',
    /sendD2DSMS[\s\S]{0,2500}sendSMS:to/.test(src));
}

section('T-2: AI draft send-on-approve');
{
  const src = read(path.join(FUNCTIONS, 'sms-functions.js'));
  assert('exports onAiDraftApproved trigger',
    /exports\.onAiDraftApproved\s*=\s*onDocumentUpdated/.test(src));
  assert('trigger bound to ai_drafts doc path',
    /document:\s*['"]leads\/\{leadId\}\/ai_drafts\/\{draftId\}['"]/.test(src));
  assert('trigger fires only on pending->approved (idempotent)',
    /before\.status === 'approved'[\s\S]{0,120}after\.status !== 'approved'/.test(src));
  // 2026-09-04: the register is reached through functions/sms-optout.js now,
  // because this file used to write it under an 11-digit key and read it under
  // a 10-digit one. Same invariant, pinned at the new call.
  assert('trigger honors STOP opt-out before sending',
    /OptOut\.isOptedOut\([\s\S]{0,300}fail\('opted_out'\)/.test(src));
  assert('trigger logs outbound note as direction:outgoing for thread+AI coherence',
    /direction:\s*'outgoing'[\s\S]{0,200}source:\s*'ai_draft'/.test(src));
  assert('trigger flips draft to sent with twilioSid',
    /status:\s*'sent'[\s\S]{0,120}twilioSid:\s*message\.sid/.test(src));
  assert('trigger uses modular FieldValue (emulator-safe)',
    /const \{ FieldValue \} = require\(['"]firebase-admin\/firestore['"]\)/.test(src));

  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('rules expose ai_drafts subcollection',
    /match \/ai_drafts\/\{draftId\}/.test(rules));
  assert('rules: rep update constrained to approve/dismiss only',
    /ai_drafts\/\{draftId\}[\s\S]{0,400}status in \['approved', 'dismissed'\]/.test(rules));
  assert('rules: ai_drafts create/delete admin-SDK only',
    /ai_drafts\/\{draftId\}[\s\S]{0,500}allow create, delete: if false/.test(rules));

  const panel = read(path.join(PRO_JS, 'customer-ai-drafts-panel.js'));
  // QA 2026-06-21 #5: the gate must match the canonical no-.html URL too
  // (/pro/customer.html redirects to /pro/customer), so the regex is now
  // /\/pro\/customer(?:\.html)?$/. The old assertion required the bare
  // .html$ form and would have re-flagged the (correct) relaxed gate.
  assert('panel path-gated to /pro/customer (optional .html)',
    panel.includes('/pro\\/customer(?:\\.html)?$'));
  assert('panel reads pending drafts',
    /where\(['"]status['"],\s*['"]==['"],\s*['"]pending['"]\)/.test(panel));
  assert('panel approve writes status:approved via updateDoc',
    /updateDoc[\s\S]{0,200}status:\s*'approved'/.test(panel));
  assert('panel uses delegated data-aidp-action (no inline onclick)',
    /data-aidp-action/.test(panel) && !/onclick=/.test(panel));

  const customerHtml = readCustomer();
  assert('customer.html loads the AI drafts panel',
    /customer-ai-drafts-panel\.js/.test(customerHtml));
}

section('T-3: AI texting analytics (getAiTextingStats)');
{
  const fn = read(path.join(FUNCTIONS, 'handlers/ai-texting-stats.js'));
  assert('getAiTextingStats is an onCall callable',
    /exports\.getAiTextingStats\s*=\s*onCall/.test(fn));
  assert('requires auth (uid)',
    /request\.auth[\s\S]{0,80}unauthenticated/.test(fn));
  assert('rate-limited',
    /callableRateLimit\(request,\s*'getAiTextingStats'/.test(fn));
  assert('aggregates via collectionGroup ai_drafts scoped to caller uid',
    /collectionGroup\('ai_drafts'\)[\s\S]{0,120}where\('userId',\s*'==',\s*uid\)/.test(fn));
  assert('enforces App Check',
    /enforceAppCheck:\s*true/.test(fn));

  const idx = readFunctionsIndex();
  assert('index.js exports getAiTextingStats',
    /exports\.getAiTextingStats\s*=/.test(idx));

  const indexes = read(path.join(ROOT, 'firestore.indexes.json'));
  assert('ai_drafts collectionGroup index present (userId + generatedAt)',
    /"collectionGroup":\s*"ai_drafts"[\s\S]{0,200}"userId"[\s\S]{0,120}"generatedAt"/.test(indexes));

  const card = read(path.join(PRO_JS, 'ai-texting-stats-card.js'));
  assert('card calls the getAiTextingStats callable',
    /callable\('getAiTextingStats'\)/.test(card));
  assert('card renders into #analyticsContainer',
    /getElementById\('analyticsContainer'\)/.test(card));

  const dash = read(path.join(PRO_JS, '..', 'dashboard.html'));
  assert('dashboard.html loads the AI texting stats card',
    /ai-texting-stats-card\.js/.test(dash));
  const actions = read(path.join(PRO_JS, 'dashboard-actions.js'));
  assert('board view triggers the card render',
    /name==='board'[\s\S]{0,160}AiTextingStatsCard\.render\(\)/.test(actions));
}

section('T-4: AI texting persona (per-rep customization + live preview)');
{
  // Pure prompt builder (no firebase imports → unit-tested separately).
  const persona = read(path.join(FUNCTIONS, 'handlers/ai-persona.js'));
  assert('ai-persona exports buildPersonaPrompt + presets + traits',
    /buildPersonaPrompt/.test(persona) && /PERSONA_PRESETS/.test(persona) && /PERSONA_TRAITS/.test(persona));
  assert('ai-persona has NO firebase imports (stays unit-testable + reusable)',
    !/require\(['"]firebase/.test(persona));
  assert('locked guardrails are appended and declared to override style',
    /HARD RULES — NEVER VIOLATE/.test(persona) && /override every style preference/.test(persona));

  // Draft path uses the builder + resolves persona by lead owner → company.
  const ai = read(path.join(FUNCTIONS, 'handlers/ai-texting.js'));
  assert('ai-texting requires the pure persona module',
    /require\(['"]\.\/ai-persona['"]\)/.test(ai));
  assert('generateAIDraft resolves a persona then builds the prompt',
    /resolvePersona\(/.test(ai) && /buildPersonaPrompt\(/.test(ai));
  assert('resolvePersona precedence: per-rep users doc → company default',
    /users['"]\)\.doc\(String\(userId\)\)[\s\S]{0,160}aiPersona/.test(ai) &&
    /companyProfile['"]\)\.doc\(String\(cid\)\)[\s\S]{0,160}defaultPersona/.test(ai));
  assert('draft doc records which persona produced it',
    /personaPreset/.test(ai));
  assert('falls back to the original locked PERSONA_PROMPT when none configured',
    /let systemPrompt = PERSONA_PROMPT/.test(ai));

  // Live-preview callable.
  const prev = read(path.join(FUNCTIONS, 'handlers/ai-texting-preview.js'));
  assert('previewAiPersona is an authed, App-Check, rate-limited onCall',
    /exports\.previewAiPersona\s*=\s*onCall/.test(prev) &&
    /enforceAppCheck:\s*true/.test(prev) &&
    /unauthenticated/.test(prev) &&
    /callableRateLimit\(request,\s*'previewAiPersona'/.test(prev));
  assert('preview builds the prompt via the shared (guardrail-locked) builder',
    /buildPersonaPrompt\(/.test(prev));

  const idx = readFunctionsIndex();
  assert('index.js exports previewAiPersona',
    /exports\.previewAiPersona\s*=/.test(idx));

  // Client editor (Settings → AI Texting): persists to the exact doc the
  // server reads, calls the preview callable, and escapes dynamic text.
  const ui = read(path.join(PRO_JS, 'ai-texting-persona.js'));
  assert('persona editor saves to users/{uid}/settings/aiPersona (matches resolvePersona)',
    /'users',\s*id,\s*'settings',\s*'aiPersona'/.test(ui));
  assert('persona editor calls the previewAiPersona callable',
    /_httpsCallable\(window\._functions,\s*'previewAiPersona'\)/.test(ui));
  assert('persona editor escapes the Claude preview output (no XSS)',
    /esc\(draft\)/.test(ui));
  assert('persona editor wires controls via addEventListener (CSP-safe)',
    /addEventListener\(/.test(ui) && !/onclick=/.test(ui));
  const dashUi = read(path.join(PRO_JS, '..', 'dashboard.html'));
  assert('dashboard loads the persona editor + exposes the AI Texting tab/mount',
    /ai-texting-persona\.js/.test(dashUi) &&
    /data-target="ai-texting"/.test(dashUi) &&
    /id="aiPersonaMount"/.test(dashUi));
}

section('Signatures PR4/5: remote canvas signing');
{
  const rs = read(path.join(FUNCTIONS, 'remote-signing.js'));
  assert('createSignRequest is an authed onCall (App Check)',
    /exports\.createSignRequest\s*=\s*onCall/.test(rs) && /enforceAppCheck:\s*true/.test(rs));
  assert('createSignRequest owner-scopes the lead',
    /lead\.userId !== uid && !isAdmin/.test(rs));
  assert('createSignRequest is rate-limited + emails via Resend',
    /callableRateLimit\(request,\s*'createSignRequest'/.test(rs) && /new Resend\(/.test(rs));
  assert('getSignDocument + submitSignature are public onRequest (POST-only, IP-limited)',
    /exports\.getSignDocument\s*=\s*onRequest/.test(rs) && /exports\.submitSignature\s*=\s*onRequest/.test(rs)
      && /docsign-get:ip/.test(rs) && /docsign-submit:ip/.test(rs));
  assert('ONLY the rep callable enforces App Check (homeowner endpoints open by design)',
    (rs.match(/enforceAppCheck:\s*true/g) || []).length === 1);
  assert('getSignDocument refuses expired / already-signed tokens',
    /getSignDocument[\s\S]*?expiresAt[\s\S]{0,200}status !== 'pending'/.test(rs));
  assert('submitSignature burns the token atomically (pending->signed in a txn)',
    /exports\.submitSignature[\s\S]*?runTransaction[\s\S]*?tx\.update\([\s\S]{0,40}status:\s*'signed'/.test(rs));
  assert('submitSignature caps signed-HTML size',
    /signedHtml\.length > 6 \* 1024 \* 1024/.test(rs));
  assert('token minted from crypto.randomBytes (no-confusable alphabet)',
    /crypto'\)\.randomBytes\(24\)/.test(rs));

  assert('index.js exports the remote-signing functions',
    /require\('\.\/remote-signing'\)/.test(readFunctionsIndex()));

  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('doc_sign_tokens is admin-SDK only',
    /match \/doc_sign_tokens\/\{token\}[\s\S]{0,90}allow read, write: if false/.test(rules));

  const signHtml = read(path.join(PRO_JS, '..', 'sign.html'));
  assert('sign.html loads sign-page.js + has the signing iframe',
    /sign-page\.js/.test(signHtml) && /id="spFrame"/.test(signHtml));
  const sp = read(path.join(PRO_JS, 'sign-page.js'));
  assert('sign-page.js posts to getSignDocument + submitSignature',
    /getSignDocument/.test(sp) && /submitSignature/.test(sp));
  assert('sign-page.js drives the widget finalize bridge',
    /__nbd_sig:\s*'finalize'/.test(sp) && /'finalized'/.test(sp));

  const viewer = read(path.join(PRO_JS, 'nbd-doc-viewer.js'));
  assert('doc viewer has the Send-for-Signature button + handler',
    /nbdv-sign-btn/.test(viewer) && /function handleSendForSignature/.test(viewer));
  assert('generator passes onSendForSignature for signable docs',
    /onSendForSignature:[\s\S]{0,120}hasSigners && _leadIdEarly/.test(read(path.join(PRO_JS, 'document-generator.js'))));
}

section('Wave C5: Stripe invoice auto-generation');
{
  const src = read(path.join(FUNCTIONS, 'integrations/esign.js'));
  assert('createStripeInvoiceForEstimate defined',
    /async function createStripeInvoiceForEstimate/.test(src));
  assert('webhook calls invoice helper on signed transition',
    /justSigned[\s\S]{0,200}createStripeInvoiceForEstimate/.test(src));
  assert('invoice created as draft (no auto_advance)',
    /auto_advance: false/.test(src));
  assert('idempotent: skips when stripeInvoiceId already set',
    /est\.stripeInvoiceId/.test(src));
}

section('Wave C6: per-lead Claude cost attribution');
{
  const idx = readFunctionsIndex();
  assert('api_usage writes now include leadId', /leadId,\s*\/\/ C6/.test(idx));
  assert('api_usage writes now include feature',
    /feature,\s*\/\/ e\.g\. 'ask-joe'/.test(idx));
  const cp = read(path.join(PRO_JS, 'claude-proxy.js'));
  assert('client auto-attaches leadId from card detail / V2',
    /window\._cardDetailLeadId/.test(cp));
  const ix = read(path.join(ROOT, 'firestore.indexes.json'));
  assert('index for (leadId, timestamp) on api_usage',
    /"collectionGroup":\s*"api_usage"[\s\S]{0,400}"fieldPath":\s*"leadId"[\s\S]{0,200}"fieldPath":\s*"timestamp"[\s\S]{0,100}"order":\s*"DESCENDING"/.test(ix));
}

section('D1: mutation callables rate-limited');
{
  const idx = readFunctionsIndex();
  // B2: callableRateLimit is defined in functions/shared.js and
  // imported by index.js + portal.js. Check both: the helper lives
  // in shared.js, and index.js imports it.
  const shared = read(path.join(FUNCTIONS, 'shared.js'));
  assert('callableRateLimit helper defined (in shared.js)',
    /async function callableRateLimit/.test(shared));
  assert('callableRateLimit imported by index.js',
    /require\(['"]\.\/shared['"]\)/.test(idx) && /callableRateLimit/.test(idx));
  // L-03: portal handlers moved to portal.js (which has its own
  // inlined callableRateLimit). Resolve each function's rate-limit
  // site by searching BOTH files.
  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  for (const name of ['createPortalToken','revokePortalToken','createTeamMember','updateUserRole','deactivateUser']) {
    const re = new RegExp("callableRateLimit\\(request, '" + name + "'");
    assert(name + ' rate-limited', re.test(idx) || re.test(psrc));
  }
  const meas = read(path.join(FUNCTIONS, 'integrations/measurement.js'));
  assert('requestMeasurement rate-limited',
    /callable:requestMeasurement:uid/.test(meas));
  const es = read(path.join(FUNCTIONS, 'integrations/esign.js'));
  assert('sendEstimateForSignature rate-limited',
    /callable:sendEstimateForSignature:uid/.test(es));
}

section('D2: Storage rules — content-type + size guards');
{
  const src = read(path.join(ROOT, 'storage.rules'));
  assert('isImage helper rejects null content-type',
    /contentType != null[\s\S]{0,200}image\/\(jpeg\|png/.test(src));
  assert('isDocType allowlist covers PDF + Office + text',
    /application\/pdf/.test(src) && /openxmlformats-officedocument/.test(src));
  assert('isHtmlOnly applied to portals path',
    /match \/portals\/\{uid\}\/\{allPaths=\*\*\}[\s\S]{0,300}isHtmlOnly\(\)/.test(src));
  // 2026-09-25 (Jo's decision B): owner writes go through ownerWrites(), the
  // owner check plus "not a viewer"; pin both halves.
  assert('delete rule requires owner (not a viewer) or admin on photos',
    /match \/photos\/\{uid\}\/\{allPaths=\*\*\}[\s\S]{0,400}allow delete: if ownerWrites\(uid\) \|\| isAdmin\(\)/.test(src)
    && /function ownerWrites\(uid\) \{\s*return isOwner\(uid\) && request\.auth\.token\.get\('role', ''\) != 'viewer';/.test(src));
}

section('D3: leads/*/activity subcollection rules');
{
  const src = read(path.join(ROOT, 'firestore.rules'));
  // Window widened 400→700 (2026-07-06): the activity READ rule gained the
  // team-visibility parentLeadInMyCompany clause, pushing `allow create`
  // further into the block — same reason the update/delete window below
  // sits at 2000 (F-05 growth).
  assert('flat-path activity subcollection rule present',
    /match \/activity\/\{activityId\}[\s\S]{0,700}allow create: if isAuth\(\)/.test(src));
  // F-05: rule body grew to include type allowlist + financial-field
  // reject list, so the window widened. `allow update, delete: if false`
  // is still the terminal statement of the match block.
  assert('activity writes restrict update/delete',
    /match \/activity\/\{activityId\}[\s\S]{0,2600}allow update, delete: if false/.test(src));
  assert('activity type allowlist enforced (F-05)',
    /request\.resource\.data\.type in \[[\s\S]*?'note'[\s\S]*?\]/.test(src));
  assert('activity rejects financial webhook fields (F-05)',
    /hasAny\(\[[\s\S]*?'stripeInvoiceId'[\s\S]*?'amountCents'[\s\S]*?\]\)/.test(src));
}

section('D4: audit_log retention cron');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  assert('auditLogRetentionCron on a schedule', /exports\.auditLogRetentionCron/.test(src) && /onSchedule/.test(src));
  assert('retention default is 7 years', /7 \* 365/.test(src));
  assert('pages in 500-doc batches', /limit\(500\)/.test(src));
}

section('Push schedulers read shapes that are actually written (2026-09-05)');
{
  // Both scheduled push readers in push-functions.js were once written
  // against nested shapes NOTHING writes — onAppointmentReminder walked
  // leads.appointments[], onFollowUpDue walked leads.d2dKnocks[] looking for
  // knock.autoFollowUp. Each therefore notified ZERO users for its whole
  // life, silently, because "query returns nothing" and "feature is quiet"
  // look identical in logs. The header schema block asserted both phantom
  // shapes, which is how they got coded that way twice.
  //
  // These assertions pin the readers to the collections real writers use:
  //   knocks       ← docs/pro/js/d2d-tracker-core-2026b.js addDoc(...,'knocks')
  //   appointments ← functions/integrations/calcom.js
  // Comments are stripped first so the retirement notes (which necessarily
  // name the dead fields) cannot satisfy or trip these checks.
  const rawPush = read(path.join(FUNCTIONS, 'push-functions.js'));
  const push = rawPush.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');

  assert('onFollowUpDue queries the top-level knocks collection',
    /collection\(\s*['"]knocks['"]\s*\)/.test(push));
  assert('onFollowUpDue filters on followUpDate, the field the tracker writes',
    /['"]followUpDate['"]/.test(push));
  assert('the phantom leads.d2dKnocks[] model is gone from executable code',
    !/d2dKnocks/.test(push));
  assert('the phantom knock.autoFollowUp field is gone from executable code',
    !/autoFollowUp/.test(push));

  assert('onAppointmentReminder still queries the top-level appointments collection',
    /collection\(\s*['"]appointments['"]\s*\)/.test(push));
  assert('onAppointmentReminder still filters on startTime',
    /['"]startTime['"]/.test(push));

  // The writer side of the contract — if the tracker ever renames these,
  // the reader above goes quiet again and this is the tripwire.
  const tracker = read(path.join(ROOT, 'docs/pro/js/d2d-tracker-core-2026b.js'));
  assert('the D2D tracker still writes knocks into the knocks collection',
    /collection\(\s*window\._db\s*,\s*['"]knocks['"]\s*\)/.test(tracker));
  assert('the D2D tracker still stamps followUpDate on the knock',
    /knockDoc\.followUpDate\s*=/.test(tracker));
  assert('a date-only follow-up is parsed as LOCAL midnight, not UTC (ET off-by-one-day)',
    /T00:00:00/.test(tracker));
}

section('D5: nightly Firestore backup cron — RETIRED 2026-09-05');
{
  // This used to assert nightlyFirestoreBackup existed and exported to a
  // bucket. It was retired because it duplicated firestore-backup.js
  // against gs://nobigdeal-pro-backups, a bucket deliberately never
  // created, so it failed every night it ever ran. The assertions are
  // INVERTED rather than deleted: a future refactor that reintroduces a
  // second export path should have to argue with a test, not slip past
  // an absence. The surviving pipeline is asserted just below.
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  assert('nightlyFirestoreBackup is gone from compliance.js',
    !/exports\.nightlyFirestoreBackup\s*=/.test(src));
  assert('its duplicate-export machinery is gone with it',
    !/:exportDocuments/.test(src) && !/const BACKUP_BUCKET/.test(src));

  // The one that actually works, and must keep working.
  const live = read(path.join(FUNCTIONS, 'firestore-backup.js'));
  assert('dailyFirestoreBackup still exports on a schedule',
    /exports\.dailyFirestoreBackup/.test(live) && /exportDocuments/.test(live));
  assert('firestoreBackupRetention still prunes',
    /exports\.firestoreBackupRetention/.test(live));
}

section('D6: GDPR export ↔ erasure symmetry for users/{uid} subcollections');
{
  const src = read(path.join(FUNCTIONS, 'integrations/compliance.js'));
  // Erasure recursiveDeletes users/{uid} (subcollections included), so the
  // Article-20 export must also list users/{uid} subcollections — otherwise
  // captures / notificationLogs / fcmTokens are deleted but never exported.
  assert('export lists users/{uid} subcollections (captures et al.)',
    /db\.doc\('users\/' \+ uid\)\.listCollections\(\)/.test(src) &&
    /user_subcollections/.test(src));
  assert('erasure recursiveDeletes the owner-keyed docs (subcollection-safe)',
    /recursiveDelete\(db\.doc\(coll \+ '\/' \+ uid\)\)/.test(src));
}

section('F-07: Stripe webhook idempotency is atomic');
{
  // L-03 cont.: Stripe handlers moved to functions/stripe.js.
  const src = read(path.join(FUNCTIONS, 'stripe.js'));
  assert('F-07: eventRef.create used for idempotency',
    /eventRef\.create\(\{[\s\S]{0,200}processedAt:/.test(src));
  assert('F-07: ALREADY_EXISTS code handled',
    /e\.code === 6[\s\S]{0,200}duplicate_event/.test(src));
}

section('F-08: Stripe plan derived from price id, not metadata');
{
  // L-03 cont.: Stripe handlers moved to functions/stripe.js.
  const src = read(path.join(FUNCTIONS, 'stripe.js'));
  assert('F-08: in-code PRICE_TO_PLAN map exists',
    /PRICE_TO_PLAN\s*=\s*\{[\s\S]{0,400}STRIPE_PRICE_FOUNDATION[\s\S]{0,200}STRIPE_PRICE_PROFESSIONAL/.test(src));
  assert('F-08: price.metadata.plan no longer trusted for tier',
    !/plan = subscription\.items\.data\[0\]\.price\.metadata\.plan/.test(src));
  assert('F-08: stripeWebhook declares price secrets',
    // window widened 400→900 (2026-07-16): the invoker:'public' option +
    // its incident comment now sit between the export and the secrets array.
    /stripeWebhook[\s\S]{0,900}secrets:[\s\S]{0,200}STRIPE_PRICE_FOUNDATION[\s\S]{0,100}STRIPE_PRICE_PROFESSIONAL/.test(src));
}

section('F-10: deploy workflow fails loudly on rules/functions errors');
{
  const wf = read(path.join(ROOT, '.github/workflows/firebase-deploy.yml'));
  // Functions deploy must no longer wrap in set +e + exit 0.
  const funcBlock = wf.match(/Deploy Cloud Functions[\s\S]{0,2000}/);
  assert('F-10: functions block found', !!funcBlock);
  if (funcBlock) {
    assert('F-10: functions deploy is NOT wrapped in set +e',
      !/set \+e[\s\S]{0,200}deploy --only functions[\s\S]{0,300}exit 0/.test(funcBlock[0]));
  }
  const storageBlock = wf.match(/Deploy Storage rules[\s\S]{0,1500}/);
  assert('F-10: storage-rules block found', !!storageBlock);
  if (storageBlock) {
    assert('F-10: storage-rules deploy fails loudly',
      !/set \+e[\s\S]{0,200}deploy --only storage[\s\S]{0,300}exit 0/.test(storageBlock[0]));
  }
}

section('F-10b: strict functions deploy — all three false-green guards');
{
  // This step has now shipped THREE distinct ways to report success while
  // functions did not deploy. Each guard is pinned here because each one is a
  // few lines of shell that a future edit could quietly drop, and the failure
  // mode is invisible by construction — the job goes GREEN.
  // Full inventory: documentation/audit/DEPLOY-FALSE-GREEN-MODES-2026-08-17.md
  const wf = read(path.join(ROOT, '.github/workflows/firebase-deploy.yml'));
  const m = wf.match(/name: Deploy Cloud Functions \(strict[\s\S]*?\n      - name: /);
  const strict = m ? m[0] : '';
  assert('F-10b: strict step block found', strict.length > 2000);

  // ── Mode 1 (2026-08-17, PR #1210): DISCOVERY-LIST DRIFT ──
  // The --only list is built by grepping exports for a hand-maintained
  // alternation of trigger wrappers. Storage triggers were missing from it for
  // ~4 months, so onPhotoUploaded/onAudioUploaded never auto-deployed at all.
  assert('F-10b mode 1: discovery alternation covers Storage triggers',
    /onObjectFinalized/.test(strict));
  assert('F-10b mode 1: discovery alternation covers Firestore triggers',
    /onDocumentCreated/.test(strict) && /onDocumentWritten/.test(strict));

  // ── Mode 2 (2026-08-10 audit): WHOLESALE FAILURE ──
  // Nonzero exit with zero parsed per-function failures (no "Failed to ..."
  // lines AND no error-summary block — see mode 1b) produced an empty failure
  // set and printed success while deploying nothing.
  assert('F-10b mode 2: wholesale-failure guard present',
    /WHOLESALE_FILE/.test(strict) && /wholesale deploy failure/.test(strict));
  assert('F-10b mode 2: wholesale failure is fatal',
    /failed WHOLESALE/.test(strict));

  // ── Mode 1b (run 32925767669, 2026-08-26): OPERATION-POLL TIMEOUT ──
  // A "Could not get operation details ... Deadline Exceeded." failure prints
  // NO "Failed to ..." line — the only per-function record is the trailing
  // "Functions deploy had errors with the following functions:" block. Until
  // this parse existed, that shape was recorded as WHOLESALE ("nothing or
  // almost nothing was deployed") while 166/167 functions were live, and the
  // one real straggler was never retried (accounting is skipped on the
  // wholesale path). This is the inverse defect of the false-greens: a false
  // RED that hides a single real straggler behind a wrong diagnosis.
  assert('F-10b mode 1b: the trailing error-summary block is parsed',
    strict.includes('Functions deploy had errors with the following functions:'));
  assert('F-10b mode 1b: summary names merge into the parsed failure set',
    /parsed=\$\(printf '%s\\n%s\\n' "\$parsed" "\$summary"/.test(strict));
  assert('F-10b mode 1b: the merge happens BEFORE the wholesale check',
    /"\$summary"[\s\S]*wholesale deploy failure: exit/.test(strict));

  // ── Mode 3 (run 32074172766, 2026-08-17): QUOTA-DROPPED UPDATE ──
  // ~17 of 167 functions got an "updating..." line and NO terminal line — no
  // success, no failure, exit 0. Both guards above passed. The fix reconciles
  // the set we ASKED to deploy against the set that reported a terminal result.
  assert('F-10b mode 3: completion lines are parsed',
    strict.includes('Successful (create|update) operation'));
  assert('F-10b mode 3: the Skipped line counts as terminal',
    strict.includes('Skipped \\(No changes detected\\)'));
  // A delete line must never account for a targeted function, or orphan
  // cleanup could paper over a missing update.
  assert('F-10b mode 3: delete lines do NOT account for a target',
    !/Successful \(create\|update\|delete\)/.test(strict)
    && !/Successful \[a-z\]\+ operation/.test(strict));
  // firebase-tools colorizes whenever CI is set, so the parse MUST strip ANSI.
  // Without this every line misses and all 167 look unaccounted-for.
  assert('F-10b mode 3: ANSI is stripped before parsing',
    /_strip_ansi/.test(strict) && /ESC=\$\(printf/.test(strict));
  assert('F-10b mode 3: the gap feeds the existing straggler retry',
    /"\$silent" >> "\$FAILED_FILE"/.test(strict));
  // Regression from run 32079768048, the first prod deploy to carry this step:
  // `targeted − accounted` ALSO contains every function that reported a failure
  // (a failed function has no success line either), so all 22 ordinary
  // stragglers were announced as "printed NO completion line" — flatly untrue.
  // Retry behavior was correct; the diagnosis was not. On a step whose whole
  // job is telling failure modes apart, a warning that fires on the ~5-10% that
  // fail loudly every deploy is worse than no warning at all.
  assert('F-10b mode 3: the silent set subtracts functions that REPORTED a failure',
    /grep -F -x -v -f "\$PARSED_FILE"/.test(strict)
    && /grep -F -x -v -f "\$ACCOUNTED_FILE"/.test(strict));
  assert('F-10b mode 3: the gap is surfaced distinctly from a reported failure',
    /printed NO completion line/.test(strict));
  // Each retry round must start from a clean slate or the final summary
  // reports stragglers that an earlier round already fixed.
  assert('F-10b mode 3: the missing set resets between retry rounds',
    /: > "\$MISSING_FILE"/.test(strict));
  // Wholesale must NOT feed the retry rounds — otherwise an auth failure burns
  // three batched re-deploys of all 167 functions before failing.
  assert('F-10b mode 3: a wholesale failure short-circuits before accounting',
    /wholesale deploy failure[\s\S]{0,400}return 0/.test(strict));

  // A gap that survives the retries must still fail the job — the whole point.
  assert('F-10b: an unresolved gap fails the job',
    /::error::Cloud Functions still failing/.test(strict)
    && /exit 1/.test(strict));
  // Success is reported in terms of what was VERIFIED, not what was attempted.
  assert('F-10b: the success line reports functions accounted for',
    /accounted for by a completion line/.test(strict));

  // The burst that tripped the 429 was 167 simultaneous mutations. There is no
  // firebase-tools concurrency flag (v15 hardcodes concurrency: 40 with no env
  // override), so the only lever is chunking our own --only list.
  assert('F-10b: a wave-1 burst cap exists',
    /NBD_DEPLOY_WAVE1_MAX/.test(strict) && /mutation-burst cap/.test(strict));
}

section('D9: new-device sign-in alert');
{
  const src = read(path.join(FUNCTIONS, 'integrations/device-alert.js'));
  assert('registerDeviceFingerprint callable defined',
    /exports\.registerDeviceFingerprint\s*=/.test(src));
  assert('fingerprint is salted hash (uid included)',
    /uid \+ '::' \+ String/.test(src));
  assert('writes audit_log on new device',
    /type: 'new_device_sign_in'/.test(src));
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('user_devices locked to admin SDK',
    /match \/user_devices\/\{uid\}[\s\S]{0,200}allow read, write: if false/.test(rules));
  const dash = readDashboard();
  assert('dashboard invokes registerDeviceFingerprint on auth',
    /registerDeviceFingerprint/.test(dash));
}

section('E1: Stripe dunning on payment failed');
{
  // L-03 cont.: Stripe handlers moved to functions/stripe.js.
  const src = read(path.join(FUNCTIONS, 'stripe.js'));
  assert('dunning enqueues email on payment_failed',
    /invoice\.payment_failed[\s\S]{0,3000}email_queue/.test(src));
  assert('dunning writes activity entry when leadId present',
    /invoice\.payment_failed[\s\S]{0,3500}stripe_payment_failed/.test(src));
  assert('dunning posts to Slack',
    /invoice\.payment_failed[\s\S]{0,4000}postSlack/.test(src));
}

section('E2: CI workflow present');
{
  const ci = read(path.join(ROOT, '.github/workflows/ci.yml'));
  assert('CI runs smoke tests',           /node tests\/smoke\.test\.js/.test(ci));
  assert('CI runs firestore rules tests', /firestore-rules\.test\.js/.test(ci));
  assert('CI does a syntax pass',         /check-js-syntax\.js/.test(ci));
  // 2026-09-25: the syntax pass covers tests/** too — a merge left a duplicate
  // declaration in tests/e2e/phone-views.spec.js that every Node gate passed.
  // The deploy gate opts out with --shipped-only; this CI step must not.
  assert('CI syntax pass runs the full scope, tests/ included (no --shipped-only)',
    /^\s*run: node scripts\/check-js-syntax\.js\s*$/m.test(ci));
  assert('CI secret-scans for private keys',
    /PRIVATE KEY/.test(ci) && /sk-ant-/.test(ci) && /sk_live_/.test(ci));

  // The E2E shards exist to catch regressions the unit suites structurally
  // cannot. Left advisory forever they burn runners while regressions merge
  // green — the five promoted shards must STAY blocking. Advisory is legal
  // only for jobs on their introduction runway (the same path @gauntlet
  // took: advisory 2026-07-17 → required 2026-07-28). 2026-08-07: the matrix
  // gained an @engines leg gated by an expression that keeps the five
  // required shards blocking; three new standalone jobs (public-e2e,
  // visual-brand-tokens, visual-regression) are on that runway — promoting
  // one means flipping its literal AND updating this allowlist.
  //
  // 2026-08-19: FOUR, not three. qc-render-sweep (the rendered docs/ gate that
  // shipped with the site-QC lane) joined the runway and this count was not
  // updated with it — so the guard was red on the qc branch before this PR
  // branched off it. Working exactly as designed: it noticed the list changed.
  // The four on the runway are public-e2e, qc-render-sweep,
  // visual-brand-tokens and visual-regression.
  // 2026-08-26: the runway is EMPTY — @engines and all four runway jobs
  // promoted on the WEEKLY_CADENCE 10/10 ledger. The exemption-shape and
  // count-of-4 assertions collapsed into the strictly stronger zero pin,
  // twin of gauntlet-regressions' (a change here needs the same change
  // there). Re-parking requires a dated WHY in ci.yml plus both pins.
  const requiredShards = ['@shard1', '@shard2', '@audit', '@stranger', '@gauntlet', '@engines'];
  assert('all six promoted E2E shards are in the matrix',
    requiredShards.every((s) => ci.includes("'" + s + "'")));
  // Line-anchored: the YAML key, not the substring — comments may name it.
  assert('no continue-on-error key of any shape anywhere in ci.yml',
    (ci.match(/^\s*continue-on-error:/gm) || []).length === 0);
}

section('E2b: hosting deploy is gated');
{
  // firebase-deploy.yml does NOT depend on the CI workflow — both fire on the
  // same push to main and run in parallel. The rules and functions deploys
  // carry their own inline gates; Hosting (which deploys FIRST, and is the
  // surface every user touches) had none, so a push that broke every test
  // still shipped the whole frontend. These assertions keep that closed.
  const dep = read(path.join(ROOT, '.github/workflows/firebase-deploy.yml'));
  assert('deploy gates hosting on shipped-JS parse', /check-js-syntax\.js/.test(dep));
  assert('deploy gates hosting on site integrity',   /check-site-integrity\.js/.test(dep));

  // Ordering is the whole point: a gate that runs AFTER the deploy it guards
  // is decoration. Assert the gate step precedes the Deploy Hosting step.
  const gateAt = dep.indexOf('check-js-syntax.js');
  const hostAt = dep.indexOf('name: Deploy Hosting');
  assert('the gate runs BEFORE hosting deploys', gateAt > -1 && hostAt > -1 && gateAt < hostAt);

  // The gate must stay dependency-free. Hosting-first exists to protect
  // content delivery from deploy-step auth flakes, so a gate that needed a
  // network/emulator/npm-install round-trip would hand that guarantee back.
  const checker = read(path.join(ROOT, 'scripts/check-js-syntax.js'));
  assert('the syntax checker uses only Node builtins',
    !/require\(['"](?!child_process|fs|os|path)[^'"]+['"]\)/.test(checker));
  assert('the syntax checker parses tests/ unless --shipped-only',
    /const TEST_ROOTS = \['tests'\];/.test(checker) &&
    /SHIPPED_ONLY \? SHIPPED_ROOTS : \[\.\.\.SHIPPED_ROOTS, \.\.\.TEST_ROOTS\]/.test(checker));
}

section('E3: CODEOWNERS + PR template + Dependabot');
{
  assert('CODEOWNERS exists',      fs.existsSync(path.join(ROOT, '.github/CODEOWNERS')));
  assert('PR template exists',     fs.existsSync(path.join(ROOT, '.github/pull_request_template.md')));
  assert('Dependabot config exists', fs.existsSync(path.join(ROOT, '.github/dependabot.yml')));
  const co = read(path.join(ROOT, '.github/CODEOWNERS'));
  assert('CODEOWNERS covers firestore.rules + storage.rules',
    /firestore\.rules/.test(co) && /storage\.rules/.test(co));
  assert('CODEOWNERS covers functions/integrations/',
    /functions\/integrations\//.test(co));
  const pr = read(path.join(ROOT, '.github/pull_request_template.md'));
  assert('PR template has security self-check',
    /Security self-check/i.test(pr) && /enforceAppCheck/.test(pr));
}

section('E4: service-worker kill switch');
{
  // CSP hotfix: SW bootstrap was inline; now lives in
  // dashboard-sw-bootstrap.js. Use readDashboard() so the regex
  // matches whichever file the kill-switch logic lives in.
  const dash = readDashboard();
  assert('SW bootstrap honors ?nosw=1',  /urlKill = params\.has\('nosw'\)/.test(dash));
  assert('SW bootstrap checks /pro/nosw.txt', /fetch\('\/pro\/nosw\.txt'/.test(dash));
  assert('SW kill unregisters + flushes caches',
    /unregister\(\)[\s\S]{0,200}caches\.delete/.test(dash));
  assert('README-killswitch.md documents the feature',
    fs.existsSync(path.join(ROOT, 'docs/pro/README-killswitch.md')));
}

section('AUTHZ: email-send callables gate role + rate-limit + escape');
{
  const src = read(path.join(FUNCTIONS, 'email-functions.js'));
  // sendDripEmail + sendEstimateEmail were RETIRED 2026-08-11 (dead-surface
  // lane: zero callers anywhere; both were branded-mail relays that had
  // needed hardening once already). Pin them GONE so a revert can't quietly
  // resurrect billable dead surface — mirrors the sendTeamInviteEmail (CL8)
  // retirement pattern. Restore-from-git note lives at the removal site.
  assert('sendDripEmail stays retired (no export)',
    !/exports\.sendDripEmail\s*=/.test(src));
  assert('sendEstimateEmail stays retired (no export)',
    !/exports\.sendEstimateEmail\s*=/.test(src));
  // The escape helper survives the retirement — sendEmail's template path
  // still uses it.
  assert('populateTemplate HTML-escapes variable values',
    /function escapeTemplateValue/.test(src) &&
    /const value = escapeTemplateValue\(variables\[key\]\)/.test(src));
}

section('F1: email queue worker');
{
  const src = read(path.join(FUNCTIONS, 'integrations/email-queue-worker.js'));
  assert('emailQueueWorker on a schedule',
    /exports\.emailQueueWorker[\s\S]{0,200}schedule:\s*'every 1 minutes'/.test(src));
  assert('claims rows transactionally',
    /runTransaction[\s\S]{0,400}status:\s*'sending'/.test(src));
  assert('retries up to MAX_ATTEMPTS then marks failed',
    /MAX_ATTEMPTS\s*=\s*5/.test(src) && /'failed'/.test(src));
  const ix = read(path.join(ROOT, 'firestore.indexes.json'));
  assert('index covers email_queue (status, createdAt)',
    /"collectionGroup":\s*"email_queue"[\s\S]{0,300}"fieldPath":\s*"status"[\s\S]{0,200}"fieldPath":\s*"createdAt"/.test(ix));
}

section('F1b: monthly overhead alert cron');
{
  const CI_FACTORY = '(onRequest|onCall|beforeUserCreated|beforeUserSignedIn|onSchedule|onDocumentCreated|onDocumentUpdated|onDocumentWritten|onDocumentDeleted)';
  const src = read(path.join(FUNCTIONS, 'monthly-overhead-alert.js'));
  // Must be a DIRECT factory call at line start or the CI deploy grep skips it.
  assert('monthlyOverheadAlertCron is a direct onSchedule factory (CI-deployable)',
    new RegExp('^exports\\.monthlyOverheadAlertCron *= *' + CI_FACTORY, 'm').test(src));
  assert('runs monthly (1st of month)', /schedule:\s*'0 9 1 \* \*'/.test(src));
  // email_queue producer contract: status:'pending' is mandatory or the worker
  // (where status==pending) never sends it — the health-digest.js trap.
  assert('queued email carries status:pending (worker contract)',
    /collection\('email_queue'\)\.add\([\s\S]{0,400}status:\s*'pending'/.test(src));
  const logicSrc = read(path.join(FUNCTIONS, 'monthly-overhead-logic.js'));
  assert('only overhead-type expenses counted (logic module)', /costType !== 'overhead'/.test(logicSrc));
  assert('resolves owner via companies/{cid}.ownerId then getUser',
    /ownerId/.test(src) && /getAuth\(\)\.getUser/.test(src));
  assert('uses modular FieldValue (v14-safe)',
    /require\('firebase-admin\/firestore'\)/.test(src) && /FieldValue\.serverTimestamp/.test(src));
  assert('exposes pure helpers for unit tests', /exports\._test\s*=/.test(src));
  const idx = readFunctionsIndex();
  assert('index.js wires monthly-overhead-alert', /require\('\.\/monthly-overhead-alert'\)/.test(idx));
  // Single-field range on `date` → automatic index; assert NO new composite
  // was needed (the query intentionally buckets costType/company in code).
  const ix = read(path.join(ROOT, 'firestore.indexes.json'));
  assert('no per-company overhead composite index was added (in-code bucketing)',
    !/"fieldPath":\s*"costType"/.test(ix));

  // ── gbp-reviews-sync.js — dormant all-reviews sync (brief 3/C step 3) ──
  const gbpSrc = read(path.join(FUNCTIONS, 'gbp-reviews-sync.js'));
  assert('syncGbpReviews is a direct onSchedule factory (CI-deployable)',
    new RegExp('^exports\\.syncGbpReviews *= *' + CI_FACTORY, 'm').test(gbpSrc));
  assert('gbp sync runs daily at 6am ET', /schedule:\s*'0 6 \* \* \*'/.test(gbpSrc) && /America\/New_York/.test(gbpSrc));
  assert('gbp sync no-ops on the __unset__ secret sentinel (dormant until configured)',
    /__unset__/.test(gbpSrc) && /\.every\(configured\)/.test(gbpSrc));
  assert('gbp sync refuses to overwrite the doc with zero reviews',
    /refusing to overwrite last-known-good doc/.test(gbpSrc));
  assert('gbp sync exposes pure helpers for unit tests', /exports\._test\s*=/.test(gbpSrc));
  assert('index.js wires gbp-reviews-sync', /require\('\.\/gbp-reviews-sync'\)/.test(readFunctionsIndex()));
  assert('gbp-reviews-sync.js loads without throwing', (() => {
    try { require(path.join(FUNCTIONS, 'gbp-reviews-sync.js')); return true; } catch (e) { return false; }
  })());
  const gbpMod = (() => { try { return require(path.join(FUNCTIONS, 'gbp-reviews-sync.js')); } catch (e) { return null; } })();
  assert('star enum maps FIVE→5 / ONE→1 / unknown→5',
    !!gbpMod && gbpMod._test.starRatingToNumber('FIVE') === 5 &&
    gbpMod._test.starRatingToNumber('ONE') === 1 && gbpMod._test.starRatingToNumber('NOPE') === 5);
  assert('mapGbpReview maps reviewer/rating/comment/createTime to the widget shape', (() => {
    if (!gbpMod) return false;
    const m = gbpMod._test.mapGbpReview(
      { reviewer: { displayName: 'A' }, starRating: 'FOUR', comment: 'hi', createTime: '2026-07-01T00:00:00Z' },
      Date.parse('2026-07-12T00:00:00Z'));
    return m.author === 'A' && m.rating === 4 && m.text === 'hi' &&
      m.time === Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000) && /ago|today|week/.test(m.relativeTime);
  })());
  // Endpoint contract: GBP full-set doc is served fresh-first and as the
  // stale last resort, with the response shape/source flag intact.
  const grSrc = read(path.join(FUNCTIONS, 'google-reviews.js'));
  assert('getGoogleReviews serves siteContent/googleReviews fresh-first',
    /GBP_DOC_PATH = 'siteContent\/googleReviews'/.test(grSrc) && /source:\s*'gbp'/.test(grSrc));
  assert('getGoogleReviews keeps the stale-GBP fallback before the empty payload',
    /stale GBP full-set doc still beats an empty payload/i.test(grSrc));

  // Contract guard for EVERY email_queue producer: the worker claims only
  // status=='pending' docs, so a producer that omits it silently drops the
  // mail (health-digest.js shipped this bug — fixed here). Each add() call
  // to email_queue must include status:'pending' within the object literal.
  const PRODUCERS = ['monthly-overhead-alert.js', 'health-digest.js', 'stripe.js', 'integrations/compliance.js'];
  for (const p of PRODUCERS) {
    const psrc = read(path.join(FUNCTIONS, p));
    const adds = psrc.match(/collection\(['"]email_queue['"]\)\.add\(\{[\s\S]*?\}\)/g) || [];
    let allHaveStatus = adds.length > 0;
    for (const a of adds) if (!/status:\s*'pending'/.test(a)) allHaveStatus = false;
    assert(p + ' email_queue producer sets status:pending on every add', allHaveStatus);
  }
}

section('F2 / M3: webhooks fail closed (every HTTP webhook signed)');
{
  const es = read(path.join(FUNCTIONS, 'integrations/esign.js'));
  assert('esignWebhook rejects unsigned requests when secret unset',
    /BOLDSIGN_WEBHOOK_SECRET not set[\s\S]{0,200}res\.status\(503\)/.test(es));
  assert('esignWebhook uses timingSafeEqual',
    /crypto\.timingSafeEqual/.test(es));

  const cal = read(path.join(FUNCTIONS, 'integrations/calcom.js'));
  assert('calcomWebhook rejects unsigned requests when secret unset',
    /CALCOM_WEBHOOK_SECRET not set[\s\S]{0,200}res\.status\(503\)/.test(cal));
  assert('calcomWebhook uses timingSafeEqual',
    /crypto\.timingSafeEqual/.test(cal));

  const sms = read(path.join(FUNCTIONS, 'sms-functions.js'));
  assert('incomingSMS verifies Twilio signature via validateRequest',
    /_twilio\(\)\.validateRequest\(authToken,\s*twilioSignature/.test(sms));
  assert('incomingSMS 403s on signature failure',
    /signature verification failed[\s\S]{0,200}res\.status\(403\)/.test(sms));

  // T-1 step 2: AI-texting draft generation is wired into incomingSMS.
  // Regression guard so future edits to the webhook don't accidentally
  // drop the call. The module's own internals are exercised when T-2
  // ships the rep UI; this only asserts wiring is in place.
  assert('incomingSMS imports generateAIDraft from handlers/ai-texting',
    /require\(['"]\.\/handlers\/ai-texting['"]\)/.test(sms) &&
    /generateAIDraft/.test(sms));
  assert('incomingSMS declares ANTHROPIC_API_KEY in secrets array',
    /secrets:\s*\[[^\]]*AI_ANTHROPIC_KEY[^\]]*\]/.test(sms));
  assert('incomingSMS calls generateAIDraft after lead match',
    /await\s+generateAIDraft\(\{[\s\S]{0,300}leadId[\s\S]{0,300}incomingNoteId/.test(sms));
  // Inbound-SMS rep push was gated on lead.assignedTo, which no lead-write
  // path ever sets → the notification was dead. It must fall back to the
  // lead's owner (userId) so a rep actually hears their customer replied.
  assert('incomingSMS push falls back to lead.userId when assignedTo is unset',
    /lead\.assignedTo \|\| lead\.userId/.test(sms) && /notifyUid/.test(sms));

  // M3: measurementWebhook completed the sweep — ensure the fix sticks.
  const m = read(path.join(FUNCTIONS, 'integrations/measurement.js'));
  assert('measurementWebhook verifies HMAC (F-02 + M3 regression guard)',
    /verifyWebhookHmac\(provider,\s*req\.rawBody/.test(m));

  // Stripe webhooks: both stripeWebhook and invoiceWebhook must verify.
  // L-03 cont.: Stripe handlers moved to functions/stripe.js.
  const stripeSrc = read(path.join(FUNCTIONS, 'stripe.js'));
  assert('stripeWebhook calls stripe.webhooks.constructEvent',
    /exports\.stripeWebhook[\s\S]{0,4000}stripe\.webhooks\.constructEvent/.test(stripeSrc));
  assert('invoiceWebhook calls stripe.webhooks.constructEvent',
    /exports\.invoiceWebhook[\s\S]{0,4000}stripe\.webhooks\.constructEvent/.test(stripeSrc));
  assert('stripeWebhook requires rawBody Buffer',
    /stripeWebhook[\s\S]{0,2000}!Buffer\.isBuffer\(req\.rawBody\)/.test(stripeSrc));
  assert('invoiceWebhook requires rawBody Buffer',
    /invoiceWebhook[\s\S]{0,2000}!Buffer\.isBuffer\(req\.rawBody\)/.test(stripeSrc));
}

// A Firestore equality filter SKIPS documents that lack the field entirely, so
// `.where('deleted','==',false)` silently excludes every lead written by the
// live create paths — none of which write `deleted`. hailMatchCron carried that
// clause and had therefore never scored one of Jo's leads: measured in prod,
// 68 of 216 docs matched and every one belonged to the seed-demo tenant, while
// all 81 geocoded live leads were invisible. The three sibling lead-sweeping
// crons all use an in-memory `if (lead.deleted) continue;` instead, which is
// the correct default. This pins that convention repo-wide.
section('Deleted-lead filtering uses the in-memory guard, never a Firestore equality');
{
  // Strip comments first. The fix for this very bug documents the old
  // `.where('deleted', ...)` clause in a comment, so a naive source grep flags
  // the file that was just repaired — the same code-vs-comment confusion that
  // let two security-guard assertions pass on prose earlier today.
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const files = ['integrations/hail-cron.js', 'dormant-leads.js', 'anniversary-touch.js', 'review-request-nudge.js'];
  for (const rel of files) {
    const src = stripComments(read(path.join(FUNCTIONS, rel)));
    assert(rel + ' filters deleted leads in memory',
      /if \(lead\.deleted\)/.test(src));
    assert(rel + ' does NOT use a Firestore deleted-equality filter',
      !/\.where\(\s*['"]deleted['"]/.test(src));
  }
}

section('F3: TCPA STOP/HELP + opt-out list');
{
  const sms = read(path.join(FUNCTIONS, 'sms-functions.js'));
  // 2026-09-04 re-point: every one of these used to match a literal
  // `sms_opt_outs/` + hand-derived key in this file. That hand derivation WAS
  // the bug — the write kept Twilio's country code, the reads did not, and no
  // STOP was ever honoured on an outbound send. The register now has one owner
  // (functions/sms-optout.js), so these pin the invariants at the new calls
  // rather than at a string that must never come back.
  assert('STOP keyword records an opt-out',
    /STOP_WORDS[\s\S]{0,400}OptOut\.recordOptOut\(/.test(sms));
  assert('HELP keyword replies with compliance message',
    /HELP_WORDS[\s\S]{0,500}Msg & data rates may apply/.test(sms));
  assert('START keyword resumes (clears the opt-out, both keys)',
    /START_WORDS[\s\S]{0,400}OptOut\.clearOptOut\(/.test(sms));
  assert('sendSMS checks the opt-out register before sending',
    /OptOut\.isOptedOut\([\s\S]{0,400}replied STOP/.test(sms));
  assert('no send path hand-derives an opt-out key any more',
    (sms.match(/doc\((['"`])sms_opt_outs\//g) || []).length === 0);
  const rules = read(path.join(ROOT, 'firestore.rules'));
  assert('sms_opt_outs rules deny client access',
    /match \/sms_opt_outs\/\{phone\}[\s\S]{0,200}allow read, write: if false/.test(rules));
}

section('F4: deploy runbook checks browser keys');
{
  const src = read(path.join(ROOT, 'scripts/deploy-runbook.sh'));
  assert('runbook inspects __NBD_APP_CHECK_KEY',
    /check_browser_key "__NBD_APP_CHECK_KEY"/.test(src));
  assert('runbook inspects __NBD_SENTRY_DSN',
    /check_browser_key "__NBD_SENTRY_DSN"/.test(src));
  assert('runbook inspects __NBD_TURNSTILE_SITEKEY on all public pages',
    /check_browser_key "__NBD_TURNSTILE_SITEKEY"/.test(src));
}

section('F5: Storage rules tests');
{
  assert('storage-rules.test.js exists',
    fs.existsSync(path.join(ROOT, 'tests/storage-rules.test.js')));
  const src = read(path.join(ROOT, 'tests/storage-rules.test.js'));
  assert('tests reject non-image uploads to photos/',
    /assertFails\(uploadBytes[\s\S]{0,200}application\/octet-stream/.test(src));
  assert('tests cross-owner photo reads fail',
    /bob.*photos\/alice|assertFails.*getBytes.*photos\/alice/.test(src));
  const pkg = read(path.join(ROOT, 'tests/package.json'));
  assert('npm run test:storage wired', /test:storage/.test(pkg));
  const ci = read(path.join(ROOT, '.github/workflows/ci.yml'));
  assert('CI runs storage rules tests',
    /storage-rules\.test\.js/.test(ci));
}

section('F6: SECURITY.md');
{
  assert('SECURITY.md exists',
    fs.existsSync(path.join(ROOT, 'SECURITY.md')));
  const src = read(path.join(ROOT, 'SECURITY.md'));
  assert('SECURITY.md has reporting SLA', /First response/i.test(src));
  assert('SECURITY.md documents in-scope surfaces',
    /In scope/i.test(src) && /nobigdeal-pro/.test(src));
  assert('SECURITY.md has key-rotation procedure',
    /Key rotation/i.test(src) && /functions:secrets:set/.test(src));
}

section('C5: Voice Intel retention cron + monitoring + feature flag');
{
  const src = read(path.join(FUNCTIONS, 'integrations/voice-intelligence.js'));
  const client = read(path.join(ROOT, 'docs/pro/js/voice-intelligence.js'));
  const indexes = JSON.parse(read(path.join(ROOT, 'firestore.indexes.json')));

  // Scheduled function
  assert('C5: recordingRetentionCron exported as onSchedule',
    /exports\.recordingRetentionCron\s*=\s*onSchedule/.test(src));
  assert('C5: schedule runs daily at 05:00 (1h after backup cron)',
    /schedule:\s*'every day 05:00'/.test(src));
  assert('C5: two-phase retention — soft-delete then hard-delete',
    /Phase 1: soft-delete[\s\S]{0,3000}Phase 2: hard-delete/.test(src));
  assert('C5: default retention is 90 days',
    /RETENTION_DEFAULT_DAYS = 90/.test(src));
  assert('C5: 30-day grace between soft + hard delete',
    /HARD_DELETE_GRACE_DAYS = 30/.test(src));
  assert('C5: per-company recordingRetentionDays override (bounded 7-3650)',
    /recordingRetentionDays[\s\S]{0,400}d >= 7 && d <= 3650/.test(src));
  // 2026-09-25: the deleted object is the path-checked audioPath from
  // retentionAudioPathFor (a collectionGroup hit outside
  // leads/{id}/recordings, or naming another recording's audio, deletes no
  // Storage object); behaviour is pinned in tests/collection-group-paths.test.js.
  assert('C5: hard-delete removes Storage payload BEFORE deleting Firestore doc',
    /const audioPath = retentionAudioPathFor\(d\.ref\.path, rec\.audioPath\)[\s\S]{0,120}bucket\.file\(audioPath\)\.delete[\s\S]{0,400}d\.ref\.delete\(\)/.test(src));
  assert('C5: hard-delete tolerates missing Storage files (ignoreNotFound)',
    /ignoreNotFound: true/.test(src));

  // Composite indexes for the retention queries
  const byStatusRecordedAt = indexes.indexes.find(i =>
    i.collectionGroup === 'recordings' &&
    i.fields.length === 2 &&
    i.fields[0].fieldPath === 'status' &&
    i.fields[1].fieldPath === 'recordedAt');
  const byStatusHardDeleteAt = indexes.indexes.find(i =>
    i.collectionGroup === 'recordings' &&
    i.fields.length === 2 &&
    i.fields[0].fieldPath === 'status' &&
    i.fields[1].fieldPath === 'hardDeleteAt');
  assert('C5: index (status ASC, recordedAt ASC) for soft-delete sweep', !!byStatusRecordedAt);
  assert('C5: index (status ASC, hardDeleteAt ASC) for hard-delete sweep', !!byStatusHardDeleteAt);

  // Feature flag gate (client module)
  assert('C5: client checks feature_flags/_default.voice_intelligence_enabled',
    /feature_flags[\s\S]{0,200}voice_intelligence_enabled/.test(client));
  assert('C5: per-uid feature_flags override takes precedence',
    /getDoc\(doc\(db, 'feature_flags', uid\)\)[\s\S]{0,400}getDoc\(doc\(db, 'feature_flags', '_default'\)\)/.test(client));
  assert('C5: feature flag fails CLOSED on read error',
    /Fail-CLOSED[\s\S]{0,400}Could not check feature availability/.test(client));
  assert('C5: cleanup plumbs through async mount (mutable closure)',
    /let realCleanup = null;[\s\S]{0,800}realCleanup = instance && instance\.cleanup/.test(client));

  // Monitoring alert
  const alertPath = path.join(ROOT, 'monitoring/alert-voice-processing-failures.json');
  const alert = JSON.parse(read(alertPath));
  assert('C5: monitoring alert policy file valid JSON + displayName',
    alert.displayName && /Voice Intel/.test(alert.displayName));
  // 2026-09-04: this policy was a conditionThreshold whose filter named
  // jsonPayload fields. Log-entry fields have no meaning in a metric filter and
  // it carried no metric.type, so Google REJECTED it — the policy could never be
  // created. It is now a conditionMatchedLog, which is what a "this error line
  // appeared" alert actually is, and the service name is lowercase because that
  // is what Cloud Run services are actually called.
  assert('C5: alert is a matched-log condition (a metric filter cannot read jsonPayload)',
    !!(alert.conditions[0].conditionMatchedLog || {}).filter);
  assert('C5: alert filter targets the onaudiouploaded service (lowercase, as deployed)',
    ((alert.conditions[0].conditionMatchedLog || {}).filter || '').includes('onaudiouploaded'));
  // This used to assert the PLACEHOLDER was present — i.e. it pinned the policy
  // in a state that could never notify anyone. Assert a real channel instead.
  assert('C5: alert routes to real notification channels, not the placeholder',
    Array.isArray(alert.notificationChannels)
    && alert.notificationChannels.length > 0
    && alert.notificationChannels.every((c) => /notificationChannels\/\d+$/.test(c)));
}

section('C4: Voice Intel tab mounted in customer.html');
{
  const html = readCustomer();
  const css  = read(path.join(ROOT, 'docs/pro/css/voice-intelligence.css'));

  // Jump nav includes the tab
  assert('C4: Voice Intel link in jump-nav',
    /href="#voiceTab"[\s\S]{0,40}Voice Intel/.test(html));
  // Tab content block exists
  assert('C4: voiceTab content div present',
    /id="voiceTab"[\s\S]{0,200}data-label="Voice Intel"/.test(html));
  assert('C4: mount point voiceIntelRoot present',
    /id="voiceIntelRoot"/.test(html));

  // Module script block (ES module import)
  assert('C4: ES module imports initVoiceIntel',
    /import\s*\{\s*initVoiceIntel\s*\}\s*from\s*'\/pro\/js\/voice-intelligence\.js'/.test(html));
  assert('C4: whenReady polls for auth + db + storage + _customerId',
    /window\._customerId[\s\S]{0,200}window\.auth[\s\S]{0,200}window\.db[\s\S]{0,200}window\.storage[\s\S]{0,200}auth\.currentUser/.test(html));
  assert('C4: cleanup wired to beforeunload',
    /beforeunload[\s\S]{0,80}cleanup && cleanup\(\)/.test(html));

  // Stylesheet linked
  assert('C4: voice-intelligence.css linked',
    /css\/voice-intelligence\.css/.test(html));

  // CSS contains the per-status class hooks the module emits
  assert('C4: CSS defines nbd-voice-status-complete',
    /\.nbd-voice-status-complete\s*\{/.test(css));
  assert('C4: CSS defines quarantined_consent status class',
    /\.nbd-voice-status-quarantined_consent\s*\{/.test(css));
  assert('C4: CSS defines consent modal overlay',
    /\.nbd-voice-modal-overlay\s*\{[\s\S]{0,600}position:\s*fixed/.test(css));
  assert('C4: CSS consent modal uses role=dialog compatible z-index',
    /\.nbd-voice-modal-overlay[\s\S]{0,400}z-index:\s*10000/.test(css));
}

section('C3b: Voice Intel client module — UI layer');
{
  const src = read(path.join(ROOT, 'docs/pro/js/voice-intelligence.js'));

  // Recorder state machine
  assert('C3b: createRecorder wraps MediaRecorder',
    /function createRecorder\([\s\S]{0,100}onEvent[\s\S]{0,2000}new MediaRecorder\(/.test(src));
  assert('C3b: recorder releases microphone tracks on stop',
    /releaseStream\(\)[\s\S]{0,200}stream\.getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(src));
  assert('C3b: recorder emits typed events (state, tick, error, done)',
    /type: 'state'/.test(src) &&
    /type: 'tick'/.test(src) &&
    /type: 'error'/.test(src) &&
    /type: 'done'/.test(src));
  assert('C3b: recorder checks isTypeSupported before picking MIME',
    /MediaRecorder\.isTypeSupported\(t\)/.test(src));
  assert('C3b: recorder handles NotAllowedError with actionable message',
    /NotAllowedError[\s\S]{0,200}Microphone access was denied/.test(src));
  assert('C3b: recorder requests dataavailable every 1s (no data loss on crash)',
    /rec\.start\(1000\)/.test(src));

  // Consent modal
  assert('C3b: showConsentModal skips for one_party',
    /CONSENT_MODES\.ONE_PARTY[\s\S]{0,100}resolve\(true\)/.test(src));
  assert('C3b: two_party_attested shows checkbox',
    /CONSENT_MODES\.TWO_PARTY_ATTESTED[\s\S]{0,400}nbd-voice-consent-check/.test(src));
  assert('C3b: two_party_verbal shows instruction (not just checkbox)',
    /verbal[\s\S]{0,400}first 20 seconds/i.test(src));
  assert('C3b: modal supports keyboard cancel via click-outside',
    /e\.target === overlay[\s\S]{0,100}close\(false\)/.test(src));

  // DOM / accessibility
  assert('C3b: modal sets role=dialog + aria-modal',
    /role[\s\S]{0,40}dialog[\s\S]{0,100}aria-modal[\s\S]{0,40}true/.test(src));
  assert('C3b: all HTML output escaped via escHtml',
    /function escHtml\(s\)[\s\S]{0,300}&amp;/.test(src));
  assert('C3b: file input accepts audio only',
    /accept="audio\/\*"/.test(src));

  // Main factory
  assert('C3b: initVoiceIntel validates required args',
    /client-init-bad-args[\s\S]{0,200}initVoiceIntel requires/.test(src));
  assert('C3b: initVoiceIntel returns cleanup + getCurrentCallType',
    /cleanup\(\)[\s\S]{0,400}getCurrentCallType\(\)/.test(src));
  assert('C3b: cleanup unsubscribes Firestore listener + cancels active recorder',
    /cleanup\(\)[\s\S]{0,400}unsubscribe && unsubscribe\(\)[\s\S]{0,300}activeRecorder && activeRecorder\.cancel\(\)/.test(src));

  // Recording list render — key fields present
  assert('C3b: list renderer shows status badge + cost + duration',
    /nbd-voice-status[\s\S]{0,2000}fmtSec\(d\.audioDurationSec\)[\s\S]{0,800}fmtCost\(d\.costCents\)/.test(src));
  assert('C3b: complete recordings show summary + transcript details',
    /status === 'complete'[\s\S]{0,4000}nbd-voice-transcript/.test(src));
  assert('C3b: quarantined_consent status is shown with label',
    /quarantined_consent:\s*'Quarantined[\s\S]{0,50}consent/.test(src));
  assert('C3b: insurance details render all four fields when present',
    /insuranceBlock[\s\S]{0,600}carrier[\s\S]{0,200}claimNumber[\s\S]{0,200}adjuster[\s\S]{0,200}deductible/.test(src));
  assert('C3b: red flags rendered with dedicated class (visual distinction)',
    /fieldList\('Red flags',[\s\S]{0,40}'red'\)/.test(src));

  // No window.* pollution, all events addEventListener
  assert('C3b: no inline onclick/onchange in rendered HTML',
    !/onclick=|onchange=|onsubmit=/.test(src));
  assert('C3b: no window.* globals assigned',
    !/window\.[a-zA-Z_]+\s*=/.test(src));
}

section('C3a: Voice Intel client module — data layer');
{
  const src = read(path.join(ROOT, 'docs/pro/js/voice-intelligence.js'));
  // ES module — imports Firebase v10.12.2 modular SDK
  assert('C3a: module imports modular Firestore SDK (not compat)',
    /from 'https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-firestore\.js'/.test(src));
  assert('C3a: module imports modular Storage SDK',
    /from 'https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.2\/firebase-storage\.js'/.test(src));

  // Consent mode constants match the server-side rule + pipeline
  assert('C3a: CONSENT_MODES exports all three modes',
    /ONE_PARTY:\s*'one_party'/.test(src) &&
    /TWO_PARTY_ATTESTED:\s*'two_party_attested'/.test(src) &&
    /TWO_PARTY_VERBAL:\s*'two_party_verbal'/.test(src));
  assert('C3a: default consent mode is the SAFE two_party_attested',
    /CONSENT_MODES\.TWO_PARTY_ATTESTED;\s*\/\/\s*safest default/.test(src));
  assert('C3a: unknown consentMode values fall back (no blind trust)',
    /Accept only known values; unknown string → fall back/.test(src));

  // Path shape matches storage.rules
  assert('C3a: uploader builds audio/{uid}/{leadId}/{recordingId}.{ext} path',
    /'audio\/' \+ uid \+ '\/' \+ leadId \+ '\/' \+ recordingId \+ '\.' \+ ext/.test(src));
  assert('C3a: uploader uses uploadBytesResumable (mobile-flake tolerant)',
    /uploadBytesResumable\(/.test(src));

  // Client-side caps mirror server + rule caps
  assert('C3a: MAX_AUDIO_BYTES = 200MB matches server cap',
    /MAX_AUDIO_BYTES = 200 \* 1024 \* 1024/.test(src));
  assert('C3a: MIME allowlist matches isAudioType() in storage.rules',
    /ALLOWED_AUDIO_MIME[\s\S]{0,400}'audio\/webm'[\s\S]{0,400}'audio\/mp4'[\s\S]{0,200}'audio\/m4a'/.test(src));
  assert('C3a: client rejects oversize blob BEFORE upload (fail fast)',
    /blob\.size > MAX_AUDIO_BYTES/.test(src));
  assert('C3a: client rejects non-audio MIME BEFORE upload',
    /ALLOWED_AUDIO_MIME\.some\(/.test(src));

  // Live subscription — order by recordedAt DESC + onSnapshot.
  assert('C3a: recordings query ordered by recordedAt desc',
    /orderBy\('recordedAt', 'desc'\)/.test(src));
  assert('C3a: subscribeToRecordings uses onSnapshot',
    /export function subscribeToRecordings[\s\S]{0,600}onSnapshot\(/.test(src));

  // Server-authoritative note documented
  assert('C3a: code documents that server is still authoritative on consent',
    /SERVER is still authoritative/.test(src));

  // Typed error class
  assert('C3a: VoiceClientError class exported with code field',
    /class VoiceClientError extends Error[\s\S]{0,200}this\.code = code/.test(src));

  // Random ID generator uses crypto
  assert('C3a: newRecordingId uses crypto.getRandomValues',
    /newRecordingId[\s\S]{0,400}crypto\.getRandomValues/.test(src));
}

section('C2: Recording rules + Storage audio path + composite index');
{
  const rules = read(path.join(ROOT, 'firestore.rules'));
  const storage = read(path.join(ROOT, 'storage.rules'));
  const indexes = JSON.parse(read(path.join(ROOT, 'firestore.indexes.json')));

  // Firestore: flat-path recordings subcollection, admin-SDK-only writes.
  assert('C2: /leads/{leadId}/recordings/{recordingId} rule present',
    /match \/recordings\/\{recordingId\}/.test(rules));
  // PREMISE WIDENED 2026-08-02 — this pinned isManager() specifically, which
  // excluded company_admin: the TENANT OWNER, strictly more privileged
  // everywhere else in firestore.rules. The owner could not read their own
  // team's call recordings, and the panel rendered empty rather than
  // erroring. Now isCompanyStaff() (= isCompanyAdmin() || isManager()).
  // The same-company clause below is the part that must never relax — it is
  // what keeps a role claim from crossing the companyId wall.
  assert('C2: recordings allow read scoped to owner + admin + same-company staff',
    /match \/recordings\/\{recordingId\}[\s\S]{0,500}resource\.data\.userId[\s\S]{0,300}isCompanyStaff\(\)[\s\S]{0,300}resource\.data\.companyId == myCompanyId\(\)/.test(rules));
  assert('C2: recordings writes blocked at the rule layer (admin SDK only)',
    /match \/recordings\/\{recordingId\}[\s\S]{0,800}allow write: if false/.test(rules));

  // Storage: audio/{uid}/** with mime + size caps.
  assert('C2: audio Storage path owner-keyed',
    /match \/audio\/\{uid\}\/\{allPaths=\*\*\}[\s\S]{0,400}allow read: if isOwner\(uid\)/.test(storage));
  assert('C2: audio upload size capped at 200MB',
    /audio\/\{uid\}\/\{allPaths=\*\*\}[\s\S]{0,500}request\.resource\.size\s*<\s*200\s*\*\s*1024\s*\*\s*1024/.test(storage));
  assert('C2: audio content-type allowlist rejects non-audio uploads',
    /function isAudioType\(\)[\s\S]{0,400}audio\/\(webm\|mpeg\|mp3\|mp4\|m4a\|ogg\|wav\|x-m4a\|aac\)/.test(storage));

  // Composite index: collectionGroup on recordings.
  const recIdx = indexes.indexes.find(i =>
    i.collectionGroup === 'recordings' && i.queryScope === 'COLLECTION_GROUP');
  assert('C2: recordings collectionGroup composite index present',
    !!recIdx);
  if (recIdx) {
    const fieldPaths = recIdx.fields.map(f => f.fieldPath).join(',');
    assert('C2: collectionGroup index is (userId ASC, recordedAt DESC)',
      fieldPaths === 'userId,recordedAt' &&
      recIdx.fields[0].order === 'ASCENDING' &&
      recIdx.fields[1].order === 'DESCENDING');
  }
  // Make sure we didn't re-introduce the single-field COLLECTION index
  // that failed portal_tokens deploy in commit 0c589e5.
  const singleFieldRecIdx = indexes.indexes.find(i =>
    i.collectionGroup === 'recordings' &&
    i.queryScope === 'COLLECTION' &&
    i.fields.length === 1);
  assert('C2: no single-field COLLECTION index on recordings (auto-indexed)',
    !singleFieldRecIdx);
}

section('C1: Voice Intelligence backend pipeline');
{
  const src = read(path.join(FUNCTIONS, 'integrations/voice-intelligence.js'));
  const idx = readFunctionsIndex();
  const shared = read(path.join(FUNCTIONS, 'integrations/_shared.js'));

  // Secrets + provider registry
  assert('C1: GROQ_API_KEY registered in _shared SECRETS',
    /GROQ_API_KEY:\s*defineSecret\('GROQ_API_KEY'\)/.test(shared));
  assert('C1: PROVIDERS.voiceTranscription defaults to groq',
    /voiceTranscription[\s\S]{0,200}NBD_VOICE_TRANSCRIPTION_PROVIDER[\s\S]{0,40}'groq'/.test(shared));

  // State-machine + handlers
  assert('C1: processRecording state machine present',
    /async function processRecording\(/.test(src));
  assert('C1: onAudioUploaded Storage trigger exported',
    /exports\.onAudioUploaded\s*=\s*onObjectFinalized/.test(src));
  // The manual admin kicks were RETIRED 2026-08-11 (their UI never shipped;
  // the automatic pipeline below is untouched). Pin them gone.
  assert('C1: triggerProcessRecording stays retired (no export)',
    !/exports\.triggerProcessRecording\s*=/.test(src));
  assert('C1: reprocessRecording stays retired (no export)',
    !/exports\.reprocessRecording\s*=/.test(src));

  // Critical idempotency + fail-closed behaviour
  assert('C1: idempotent on already-complete recording',
    /status === 'complete' && !forceReanalyze[\s\S]{0,120}skipped: 'already_complete'/.test(src));
  assert('C1: consent-check failure quarantines the recording',
    /catch \(e\)[\s\S]{0,600}status: 'quarantined_consent'[\s\S]{0,400}quarantined: true/.test(src));
  assert('C1: Storage trigger swallows uncaught errors (no retry storm)',
    /swallowing to prevent retry storm/.test(src));

  // Cost + budget plumbing
  assert('C1: budget gate writes status:failed with actionable message',
    /overBudget[\s\S]{0,400}status: 'failed'[\s\S]{0,200}voice budget exhausted/.test(src));
  assert('C1: usage counters bumped on complete (M2 pattern)',
    /incrementVoiceUsage\(db,\s*\{[\s\S]{0,200}audioSec[\s\S]{0,200}analysisTokens[\s\S]{0,200}costCents/.test(src));
  assert('C1: Claude model pinned to haiku (no Opus drift)',
    /VOICE_ANALYSIS_MODEL\s*=\s*'claude-haiku-4-5-20251001'/.test(src));

  // Wire-up
  assert('C1: voice-intelligence required in index.js',
    /require\('\.\/integrations\/voice-intelligence'\)/.test(idx));
  assert('C1: voice-intelligence exports Object.assign\'d into exports',
    /Object\.assign\(exports,\s*voiceIntelligenceIntegration\)/.test(idx));
}

section('R-05: hot-path Cloud Function sizing for 10k-user spike');
{
  // L-03 cont.: Stripe handlers moved to functions/stripe.js. Scan
  // both files so hot-path sizing asserts work no matter which
  // module owns the handler today.
  const src = readFunctionsIndex()
    + '\n' + read(path.join(FUNCTIONS, 'stripe.js'));

  // Helper: extract the {…} config-object immediately following
  // `exports.FNAME = onRequest(` in source order. We match the
  // literal lines rather than invoking the function so this stays
  // dependency-free.
  function configOf(fnName) {
    const re = new RegExp(
      'exports\\.' + fnName
      + '\\s*=\\s*onRequest\\(\\s*\\{([\\s\\S]*?)\\}\\s*,',
      'm'
    );
    const m = src.match(re);
    return m ? m[1] : null;
  }
  function intField(block, field) {
    if (!block) return null;
    // Strip line comments so we don't match commentary numbers
    // like "Old 100×80 = 8k".
    const clean = block.replace(/\/\/[^\n]*/g, '');
    const m = clean.match(new RegExp('\\b' + field + ':\\s*(\\d+)'));
    return m ? Number(m[1]) : null;
  }

  const claude = configOf('claudeProxy');
  assert('R-05: claudeProxy maxInstances >= 200 (quota cap: us-central1 200k mCPU; request quota increase to raise)',
    intField(claude, 'maxInstances') >= 200,
    'got ' + intField(claude, 'maxInstances'));
  // R-05 originally required minInstances >= 3 here for cold-start
  // absorption. REVERSED 2026-09-05 on cost grounds: warm instances
  // across four functions were 84% of the entire GCP bill (~$70/mo)
  // against ~$8/mo of actual request serving, and this function alone
  // was ~$22.40/mo to hold 240 permanently-idle concurrent slots.
  // The assertion is inverted rather than deleted so the cost cannot
  // creep back silently — a warm instance here is ~$8.10/mo. If you
  // genuinely need one, change this line deliberately and say why.
  // Note this does NOT weaken R-05's surge protection: maxInstances
  // and concurrency are ceilings and cost nothing while idle.
  assert('COST: claudeProxy minInstances pinned to 0 (was 3; ~$22.40/mo)',
    intField(claude, 'minInstances') === 0,
    'got ' + intField(claude, 'minInstances'));
  assert('R-05: claudeProxy concurrency still 80',
    intField(claude, 'concurrency') === 80);

  const sign = configOf('signImageUrl');
  assert('R-05: signImageUrl maxInstances >= 200 (photo-render spike)',
    intField(sign, 'maxInstances') >= 200,
    'got ' + intField(sign, 'maxInstances'));
  // R-05 required >= 2; reversed 2026-09-05 on cost (~$14.94/mo).
  assert('COST: signImageUrl minInstances pinned to 0 (was 2; ~$14.94/mo)',
    intField(sign, 'minInstances') === 0,
    'got ' + intField(sign, 'minInstances'));
  assert('R-05: signImageUrl concurrency >= 80',
    intField(sign, 'concurrency') >= 80);

  const subStatus = configOf('getSubscriptionStatus');
  assert('R-05: getSubscriptionStatus maxInstances >= 200 (page-load spike)',
    intField(subStatus, 'maxInstances') >= 200,
    'got ' + intField(subStatus, 'maxInstances'));
  // R-05 required >= 2; reversed 2026-09-05 on cost (~$14.94/mo).
  assert('COST: getSubscriptionStatus minInstances pinned to 0 (was 2; ~$14.94/mo)',
    intField(subStatus, 'minInstances') === 0,
    'got ' + intField(subStatus, 'minInstances'));

  // L-03: getHomeownerPortalView moved to portal.js. Look there
  // first; fall back to the index.js helper if a future refactor
  // moves it back.
  const portalSrc = read(path.join(FUNCTIONS, 'portal.js'));
  const portalRe = /exports\.getHomeownerPortalView\s*=\s*onRequest\(\s*\{([\s\S]*?)\}\s*,/m;
  const portalMatch = portalSrc.match(portalRe);
  const portal = portalMatch ? portalMatch[1] : configOf('getHomeownerPortalView');
  assert('R-05: getHomeownerPortalView maxInstances >= 80 (email-blast burst)',
    intField(portal, 'maxInstances') >= 80);

  const checkout = configOf('createCheckoutSession');
  assert('R-05: createCheckoutSession maxInstances >= 50 (conversion funnel)',
    intField(checkout, 'maxInstances') >= 50);

  const stripe = configOf('stripeWebhook');
  assert('R-05: stripeWebhook maxInstances >= 20 (bulk billing / retries)',
    intField(stripe, 'maxInstances') >= 20);

  // Anti-brute endpoints must STAY tight — bumping these defeats
  // the rate-limit floor they enforce.
  const vcode = configOf('validateAccessCode');
  if (vcode) {
    assert('R-05: validateAccessCode stays tight (maxInstances <= 10)',
      intField(vcode, 'maxInstances') <= 10,
      'got ' + intField(vcode, 'maxInstances') + ' — loosening defeats anti-brute');
  }
}

section('L-01: admin/index.html markup no longer advertises an admin surface');
{
  const src = read(path.join(ROOT, 'docs/admin/index.html'));
  assert('L-01: title is generic (not "NBD Admin")',
    !/<title>\s*NBD Admin\s*<\/title>/i.test(src));
  assert('L-01: og:url admin path removed',
    !/<meta property="og:url"[^>]*\/admin/i.test(src));
  // The noindex signal still has to be present at the markup level
  // (Firebase Hosting also sets X-Robots-Tag but the meta survives
  // if someone views-source in devtools).
  assert('L-01: noindex,nofollow meta preserved',
    /<meta name="robots" content="noindex,\s*nofollow"/i.test(src));
}

section('L-02: retired Cloudflare Worker stub removed from repo');
{
  assert('L-02: workers/nbd-ai-proxy.js is gone',
    !fs.existsSync(path.join(ROOT, 'workers/nbd-ai-proxy.js')));
  assert('L-02: workers/wrangler.toml is gone',
    !fs.existsSync(path.join(ROOT, 'workers/wrangler.toml')));
  assert('L-02: workers/ directory is gone (no stray files)',
    !fs.existsSync(path.join(ROOT, 'workers')));
  const sec = read(path.join(ROOT, 'SECURITY.md'));
  assert('L-02: SECURITY.md documents the retirement + CF-dashboard ops step',
    /Retired surfaces[\s\S]{0,600}nbd-ai-proxy[\s\S]{0,600}Cloudflare dashboard/.test(sec));
}

section('L-03: portal handlers extracted to functions/portal.js');
{
  const portalPath = path.join(FUNCTIONS, 'portal.js');
  assert('L-03: functions/portal.js exists', fs.existsSync(portalPath));
  if (fs.existsSync(portalPath)) {
    assert('L-03: portal.js parses cleanly', syntaxCheck(portalPath).ok);
    const psrc = read(portalPath);
    assert('L-03: portal.js exports createPortalToken',
      /exports\.createPortalToken\s*=\s*onCall/.test(psrc));
    assert('L-03: portal.js exports revokePortalToken',
      /exports\.revokePortalToken\s*=\s*onCall/.test(psrc));
    assert('L-03: portal.js exports getHomeownerPortalView',
      /exports\.getHomeownerPortalView\s*=\s*onRequest/.test(psrc));
    assert('L-03: portal.js is self-contained (does not require ../index)',
      !/require\(['"]\.\.\/index['"]\)/.test(psrc));
  }
  const idx = readFunctionsIndex();
  assert('L-03: index.js loads portal.js via require + Object.assign',
    /require\(['"]\.\/portal['"]\)/.test(idx)
    && /Object\.assign\(exports,\s*portalFunctions\)/.test(idx));
  // The portal handlers must NOT be defined inline in index.js any
  // more — duplicate exports would cause Firebase deploy to collide.
  assert('L-03: createPortalToken no longer defined inline in index.js',
    !/exports\.createPortalToken\s*=\s*onCall/.test(idx));
  assert('L-03: revokePortalToken no longer defined inline in index.js',
    !/exports\.revokePortalToken\s*=\s*onCall/.test(idx));
  assert('L-03: getHomeownerPortalView no longer defined inline in index.js',
    !/exports\.getHomeownerPortalView\s*=\s*onRequest/.test(idx));
}

section('B2: shared authz + rate-limit helpers');
{
  const sharedPath = path.join(FUNCTIONS, 'shared.js');
  assert('B2: functions/shared.js exists', fs.existsSync(sharedPath));
  if (fs.existsSync(sharedPath)) {
    const ssrc = read(sharedPath);
    assert('B2: shared.js parses cleanly', syntaxCheck(sharedPath).ok);
    assert('B2: shared.js exports callableRateLimit',
      /exports\.callableRateLimit\s*=|module\.exports\s*=\s*\{[\s\S]*?callableRateLimit/.test(ssrc));
    assert('B2: shared.js exports requirePaidSubscription',
      /exports\.requirePaidSubscription\s*=|module\.exports\s*=\s*\{[\s\S]*?requirePaidSubscription/.test(ssrc));
    // Live-load the module and verify the functions are callable.
    const s = require(sharedPath);
    assert('B2: callableRateLimit is a function', typeof s.callableRateLimit === 'function');
    assert('B2: requirePaidSubscription is a function', typeof s.requirePaidSubscription === 'function');
    // callableRateLimit on an unauthenticated request should no-op
    // (uid is missing → early return, no throw). Exercises the guard.
    (async () => {
      try {
        await s.callableRateLimit({ auth: null }, 'test', 1, 1000);
      } catch (e) {
        assert('B2: callableRateLimit is a no-op on unauth', false, 'threw ' + e.message);
      }
    })();
    // requirePaidSubscription on an unauthenticated caller returns
    // {ok:false, 401} without touching Firestore.
    (async () => {
      const stubDb = { doc: () => { throw new Error('Firestore should not be touched for unauth'); } };
      const res = await s.requirePaidSubscription(stubDb, null);
      assert('B2: requirePaidSubscription rejects unauth before Firestore',
        res && res.ok === false && res.status === 401);
    })();
  }

  // Migration: the three callers (index.js, portal.js, sms-functions.js)
  // must now import from shared, NOT define their own inline copies.
  // Step 4c: index.js itself only `require()`s shared for side effects;
  // the destructured imports live in handlers/admin.js et al., which
  // use the relative path '../shared' (resolves to the same file).
  // readFunctionsIndex() concats index.js + handlers/*, so accept
  // either path shape.
  const idx = readFunctionsIndex();
  assert('B2: index.js imports callableRateLimit from ./shared',
    /require\(['"]\.{1,2}\/shared['"]\)[\s\S]{0,200}callableRateLimit/.test(idx)
    || /\{[^}]*callableRateLimit[^}]*\}\s*=\s*require\(['"]\.{1,2}\/shared['"]\)/.test(idx));
  assert('B2: index.js no longer defines callableRateLimit inline',
    !/async function callableRateLimit\s*\(/.test(idx));

  const psrc = read(path.join(FUNCTIONS, 'portal.js'));
  assert('B2: portal.js imports callableRateLimit from ./shared',
    /require\(['"]\.\/shared['"]\)/.test(psrc)
    && /callableRateLimit/.test(psrc));
  assert('B2: portal.js no longer defines callableRateLimit inline',
    !/async function callableRateLimit\s*\(/.test(psrc));

  const sms = read(path.join(FUNCTIONS, 'sms-functions.js'));
  assert('B2: sms-functions.js imports requirePaidSubscription from ./shared',
    /require\(['"]\.\/shared['"]\)[\s\S]{0,200}requirePaidSubscription/.test(sms)
    || /\{[^}]*requirePaidSubscription[^}]*\}\s*=\s*require\(['"]\.\/shared['"]\)/.test(sms));
  assert('B2: sms-functions.js no longer defines requirePaidSubscription inline',
    !/async function requirePaidSubscription\s*\(/.test(sms));
}

section('L-03 cont.: Stripe handlers extracted to functions/stripe.js');
{
  const stripePath = path.join(FUNCTIONS, 'stripe.js');
  assert('Stripe: functions/stripe.js exists', fs.existsSync(stripePath));
  if (fs.existsSync(stripePath)) {
    assert('Stripe: stripe.js parses cleanly', syntaxCheck(stripePath).ok);
    const s = read(stripePath);
    for (const name of [
      'createCheckoutSession', 'stripeWebhook', 'createCustomerPortalSession',
      'getSubscriptionStatus', 'createStripePaymentLink', 'invoiceWebhook',
    ]) {
      assert('Stripe: stripe.js exports ' + name,
        new RegExp('exports\\.' + name + '\\s*=\\s*onRequest').test(s));
    }
    assert('Stripe: stripe.js is self-contained (no require("../index"))',
      !/require\(['"]\.\.\/index['"]\)/.test(s));
    assert('Stripe: stripe.js imports requireAuth from ./shared',
      /require\(['"]\.\/shared['"]\)/.test(s) && /requireAuth/.test(s));
    assert('Stripe: stripe.js imports httpRateLimit from the upstash adapter',
      /require\(['"]\.\/integrations\/upstash-ratelimit['"]\)/.test(s));
  }
  const idx = readFunctionsIndex();
  assert('Stripe: index.js loads stripe.js via require + Object.assign',
    /require\(['"]\.\/stripe['"]\)/.test(idx)
    && /Object\.assign\(exports,\s*stripeFunctions\)/.test(idx));
  // None of the six handlers may be defined inline in index.js any
  // more — duplicate exports would make Firebase deploy collide.
  for (const name of [
    'createCheckoutSession', 'stripeWebhook', 'createCustomerPortalSession',
    'getSubscriptionStatus', 'createStripePaymentLink', 'invoiceWebhook',
  ]) {
    assert('Stripe: ' + name + ' no longer defined inline in index.js',
      !new RegExp('exports\\.' + name + '\\s*=\\s*onRequest').test(idx));
  }
}

section('M1 pilot: /admin drops unsafe-inline (script-src + style-src)');
{
  const fb = JSON.parse(read(path.join(ROOT, 'firebase.json')));
  // Find the per-page CSP header for the admin index. Keyed to the
  // CANONICAL extensionless source: cleanUrls strips .html before
  // header matching, so a '/admin/index.html' source never fires
  // (re-keyed 2026-07-16). Header matching is last-match-wins per
  // key, so this CSP-only rule coexists with the /admin
  // cache/robots rule earlier in the array.
  const entry = (fb.hosting.headers || [])
    .find(h => h.source === '/admin'
      && (h.headers || []).some(x => x.key === 'Content-Security-Policy'));
  assert('M1: per-page CSP entry exists for /admin', !!entry);
  if (entry) {
    const csp = (entry.headers || [])
      .find(h => h.key === 'Content-Security-Policy');
    assert('M1: /admin has a Content-Security-Policy header', !!csp);
    if (csp) {
      // Parse out the directives so a future header reorder doesn't
      // false-pass the assertions.
      const directives = Object.fromEntries(csp.value
        .split(';')
        .map(s => s.trim())
        .filter(Boolean)
        .map(d => {
          const [name, ...vals] = d.split(/\s+/);
          return [name, vals];
        }));
      assert('M1: script-src has no \'unsafe-inline\'',
        Array.isArray(directives['script-src'])
        && !directives['script-src'].includes("'unsafe-inline'"));
      assert('M1: style-src has no \'unsafe-inline\'',
        Array.isArray(directives['style-src'])
        && !directives['style-src'].includes("'unsafe-inline'"));
      assert('M1: object-src is locked to none',
        Array.isArray(directives['object-src'])
        && directives['object-src'].includes("'none'"));
      assert('M1: base-uri is locked to none',
        Array.isArray(directives['base-uri'])
        && directives['base-uri'].includes("'none'"));
    }
  }
  // The page itself must not regress to inline-script / inline-style
  // usage — those would silently break under the strict CSP.
  const page = read(path.join(ROOT, 'docs/admin/index.html'));
  assert('M1: /admin/index.html still has zero inline <script> bodies',
    !/<script[^>]*>[^\s<]/.test(page));
  assert('M1: /admin/index.html still has zero on*= event handlers',
    !/\bon[a-z]+=/.test(page));
  assert('M1: /admin/index.html still has zero style="..." attrs',
    !/style="/.test(page));
  assert('M1: /admin/index.html still has zero <style> blocks',
    !/<style[ >]/.test(page));
}

section('Registry drift: every owner-keyed rule has a FLAT_USER_COLLECTIONS entry');
{
  // M-01/M-02 follow-up. The canonical user-owned registry at
  // functions/integrations/user-owned.js is consumed by both the
  // erasure cascade and the GDPR export. Any new top-level Firestore
  // collection added with `isOwner(resource.data.userId)` (or
  // .createdBy) authorization must also land in the registry — or
  // erasure leaves the user's data behind, and Article-20 export
  // misses it entirely.
  //
  // This sweep fails CI if any owner-keyed top-level match block in
  // firestore.rules names a collection that isn't in either the
  // registry's FLAT_USER_COLLECTIONS or the explicit exclusion list
  // below. Adding an exclusion is a deliberate design decision —
  // document the reason inline so a future reader sees the intent.

  const rules = read(path.join(ROOT, 'firestore.rules'));
  const registry = require(path.join(FUNCTIONS, 'integrations/user-owned.js'));
  const registered = new Set(registry.FLAT_USER_COLLECTIONS.map(s => s.name));

  // Top-level match blocks live at indent depth 4 (the
  // `match /databases/.../documents {` block opens at depth 2).
  // Capture each `    match /COLL/{<id>} {` line and its body, where
  // the body runs until the matching close-brace at the same indent.
  const lines = rules.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^    match \/([a-zA-Z_]+)\/\{[a-zA-Z]+\}\s*\{?\s*$/);
    if (!m) continue;
    const coll = m[1];
    // Walk forward to find the closing brace at the same indent.
    let depth = 1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const opens = (lines[j].match(/\{/g) || []).length;
      const closes = (lines[j].match(/\}/g) || []).length;
      depth += opens - closes;
      if (depth <= 0) break;
    }
    blocks.push({ coll, body: lines.slice(i, j + 1).join('\n') });
  }

  // Every top-level rule whose authz consults resource.data.userId
  // or resource.data.createdBy belongs to a user-owned collection.
  const ownerKeyedColls = blocks
    .filter(b => /isOwner\(resource\.data\.(userId|createdBy)\)/.test(b.body))
    .map(b => b.coll);

  // Intentional exclusions: collections whose authz uses owner-keyed
  // shape but that we deliberately do NOT include in the GDPR registry.
  // Audit trails + admin-only writes survive erasure on purpose.
  // None today; placeholder list documents the exclusion mechanism for
  // future schema additions.
  const REGISTRY_EXCLUSIONS = new Set([
    // Example shape (uncomment and document if a real exclusion appears):
    // 'audit_log_writes', // append-only audit trail; survives erasure by design
  ]);

  const missing = ownerKeyedColls.filter(c =>
    !registered.has(c) && !REGISTRY_EXCLUSIONS.has(c));

  assert('Registry: every owner-keyed top-level rule has a FLAT_USER_COLLECTIONS entry',
    missing.length === 0,
    missing.length
      ? 'missing from registry: ' + missing.join(', ')
        + '. Add to FLAT_USER_COLLECTIONS in functions/integrations/user-owned.js'
        + ' OR add to REGISTRY_EXCLUSIONS in this test with a documented reason.'
      : '');

  // Sanity: our sweep should be finding SOMETHING. If the regex breaks
  // or rules.txt format changes, this catches a silently-empty result.
  assert('Registry: sweep observed at least 15 owner-keyed collections',
    ownerKeyedColls.length >= 15,
    'observed ' + ownerKeyedColls.length + ' (regex may be broken)');

  // Inverse direction (informational only — does not fail CI):
  // collections in the registry that no longer have a matching rule.
  // A registry entry without a rule isn't dangerous (erasure just
  // queries an empty/non-existent collection), but it's a stale-list
  // signal worth surfacing for a future cleanup.
  const stale = registry.FLAT_USER_COLLECTIONS
    .map(s => s.name)
    .filter(name => !blocks.some(b => b.coll === name));
  if (stale.length > 0) {
    console.log('  ℹ  Registry has ' + stale.length
      + ' entries with no matching rule (informational): '
      + stale.join(', '));
  }
}

// ── SEO: every blog post appears in sitemap.xml ─────────────
// Blog posts are the top-of-funnel SEO engine — a new post that
// doesn't land in the sitemap stays uncrawled by Google until
// someone notices (weeks later). This check keeps sitemap.xml
// honest against docs/blog/*.html and fails loud the moment a
// post lands in one without the other.
section('SEO: every /docs/blog/*.html has a sitemap entry');
{
  const sitemapPath = path.join(ROOT, 'docs/sitemap.xml');
  if (fs.existsSync(sitemapPath)) {
    const sitemap = fs.readFileSync(sitemapPath, 'utf8');
    const blogDir = path.join(ROOT, 'docs/blog');
    const posts = fs.readdirSync(blogDir)
      .filter(f => f.endsWith('.html') && f !== 'index.html');
    for (const file of posts) {
      const slug = file.replace(/\.html$/, '');
      const html = fs.readFileSync(path.join(blogDir, file), 'utf8');
      // A noindexed post (e.g. the field-notes placeholder) must be OUT of
      // the sitemap — listing a page you tell crawlers not to index is a
      // mixed signal Search Console flags. build-sitemap.js enforces the
      // same rule via isNoindexed().
      if (/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(html)) {
        assert('sitemap EXCLUDES noindexed /blog/' + slug, !sitemap.includes('/blog/' + slug));
      } else {
        assert('sitemap has /blog/' + slug, sitemap.includes('/blog/' + slug));
      }
    }
  } else {
    assert('sitemap.xml exists at docs/sitemap.xml', false);
  }
}

section('Service worker — root /sw.js is a self-unregistering stub');
{
  // /sw.js (root scope `/`) is INTENTIONALLY a stub that unregisters
  // itself on activate. Devices that registered the old broken SW back
  // when it was a full caching SW are evicted here; the only SW we
  // maintain now is /pro/sw.js (scope `/pro/`). The previous version of
  // these tests checked for CACHE_VERSION + a cross-origin fetch bypass,
  // but those patterns belong to the OLD architecture and were removed
  // deliberately when /sw.js was stubbed out (see the comment at the
  // top of the file). These tests now verify the stub is intact.
  const sw = read(path.join(ROOT, 'docs/sw.js'));
  assert('root /sw.js skipWaiting() on install (so the new stub takes over fast)',
    /addEventListener\(['"]install['"][\s\S]{0,200}skipWaiting/.test(sw),
    'install handler must call self.skipWaiting()');
  assert('root /sw.js clears caches + unregisters on activate',
    /addEventListener\(['"]activate['"][\s\S]*caches\.delete[\s\S]*registration\.unregister/.test(sw),
    'activate handler must delete all caches and unregister this SW');
  assert('root /sw.js has NO fetch handler (passthrough by design)',
    !/addEventListener\(['"]fetch['"]/.test(sw),
    'a fetch handler would defeat the purpose of the unregister stub');
}

section('Per-route rate-limit policy');
{
  const policy = read(path.join(ROOT, 'functions/rate-limit-policy.js'));
  // Public surface: declarative ROUTES table + two wrappers.
  assert('rate-limit-policy exports ROUTES + guardCallable + guardHttp',
    /module\.exports\s*=\s*\{[\s\S]*ROUTES,[\s\S]*guardCallable,[\s\S]*guardHttp/.test(policy));
  // Default policy: when a route name isn't in ROUTES, the wrapper
  // applies a safe default AND emits a structured warning so the gap
  // shows up in Cloud Logging instead of going unenforced.
  assert('policyFor falls back to DEFAULT_POLICY + emits structured warning',
    /logger\(\)\.warn\(['"]rate_limit_no_policy['"]/.test(policy)
    && /DEFAULT_POLICY/.test(policy));
  // Both ceilings are enforced — per-IP first (cheaper denial), then
  // per-uid. Specifically: the wrapper must NOT skip uid enforcement
  // when an IP check passes. The :ip enforce call must precede :uid.
  {
    const guardBody = (policy.match(/function guardCallable[\s\S]+?\n\}/) || ['',''])[0];
    const ipPos  = guardBody.indexOf("enforceRateLimit(name + ':ip'");
    const uidPos = guardBody.indexOf("enforceRateLimit(name + ':uid'");
    assert('guardCallable enforces per-IP THEN per-uid (both, not either-or)',
      ipPos > -1 && uidPos > -1 && ipPos < uidPos,
      'expected ip enforce to appear before uid enforce in guardCallable');
  }
  // 429 path on the HTTP wrapper sets Retry-After honestly.
  assert('guardHttp 429 path sets Retry-After header',
    /Retry-After[\s\S]{0,200}retryAfterMs/.test(policy));
  // High-risk routes have explicit ceilings (claudeProxy +
  // submitPublicLead must never silently fall to the default).
  assert('high-risk routes have explicit policy entries',
    /claudeProxy:\s*\{/.test(policy)
    && /submitPublicLead:\s*\{/.test(policy)
    && /publicVisualizerAI:\s*\{/.test(policy)
    && /validateAccessCode:\s*\{/.test(policy));
  // Anonymous CSP report sink must not be uid-locked (uidLimit:0 →
  // bypass the uid branch since unauthenticated browsers POST it).
  assert('cspReport policy is per-IP only (uidLimit:0)',
    /cspReport:\s*\{[^}]*uidLimit:\s*0/.test(policy));
  // The matrix accessor returns a frozen snapshot — caller can't
  // mutate live policy at runtime.
  assert('getRateLimitMatrix returns Object.freeze snapshot',
    /function getRateLimitMatrix[\s\S]{0,300}Object\.freeze/.test(policy));

  // ── Wiring pilot (2026-08-10): the module is no longer dead code. ──
  // Policy must ride the SAME provider adapter the handlers use, or a
  // NBD_RATE_LIMIT_PROVIDER=upstash flip would silently pin the
  // policy-guarded routes to the Firestore limiter.
  assert('policy enforces through the provider-aware upstash adapter',
    /require\(['"]\.\/integrations\/upstash-ratelimit['"]\)/.test(policy));
  // Both wrappers key IP limits on the IPv6 /64 prefix — parity with the
  // hand-rolled gates (one v6 allocation must not rotate past the cap).
  assert('guardCallable + guardHttp bucket IPs via rateLimitIpKey',
    (policy.match(/rateLimitIpKey\(clientIp\(/g) || []).length >= 2);

  const aiH = read(path.join(ROOT, 'functions/handlers/ai.js'));
  const portalH = read(path.join(ROOT, 'functions/handlers/portal.js'));
  const intH = read(path.join(ROOT, 'functions/handlers/integrations.js'));
  // claudeProxy rides guardHttp; the old inline uid call must STAY GONE —
  // wrapper + inline share the 'claudeProxy:uid' namespace, so reintroducing
  // the inline call would double-count every request (halved effective limit).
  assert('claudeProxy is wrapped in guardHttp and has no inline uid limiter',
    /guardHttp\(\s*['"]claudeProxy['"]/.test(aiH)
    && !/enforceRateLimit\(\s*['"]claudeProxy:uid['"]/.test(aiH));
  // claudeProxy's uid ceiling in ROUTES is the prod limit the inline call
  // used to enforce (CLAUDE_PER_MIN_LIMIT was 20) — the wiring was
  // behavior-preserving, and tightening/loosening it is a deliberate act.
  assert('ROUTES.claudeProxy keeps the prod uid ceiling (20/min)',
    /claudeProxy:\s*\{[^}]*uidLimit:\s*20\b[^}]*uidWindow:\s*MINUTE/.test(policy));
  // validateAccessCode rides guardCallable; same no-double-count rule.
  assert('validateAccessCode is wrapped in guardCallable and has no inline ip limiter',
    /guardCallable\(\s*['"]validateAccessCode['"]/.test(portalH)
    && !/enforceRateLimit\(\s*['"]validateAccessCode:ip['"]/.test(portalH));
  assert('ROUTES.validateAccessCode keeps the prod ip gate (5 / 5 min)',
    /validateAccessCode:\s*\{[^}]*ipLimit:\s*5\b[^}]*ipWindow:\s*5\*MINUTE/.test(policy));
  // submitPublicLead stays hand-rolled ON PURPOSE (fail-open-to-Firestore
  // semantics + Turnstile/honeypot interleave that guardHttp doesn't have) —
  // but the ROUTES record must MATCH the handler's real gate, or the ops
  // matrix lies. Cross-pin both sides.
  assert('submitPublicLead handler gate is 20/min per-IP (hand-rolled)',
    /enforceRateLimit\(\s*['"]publicLead:ip['"][\s\S]{0,80}?,\s*20,\s*60_000\)/.test(intH));
  assert('ROUTES.submitPublicLead records that same 20/min per-IP gate',
    /submitPublicLead:\s*\{[^}]*ipLimit:\s*20\b[^}]*ipWindow:\s*MINUTE/.test(policy));

  // ── Wave 2 (2026-08-10 audit): more wiring + record-vs-reality sync. ──
  const monH = read(path.join(ROOT, 'functions/handlers/monitoring.js'));
  const revH = read(path.join(ROOT, 'functions/google-reviews.js'));
  const photoH = read(path.join(ROOT, 'functions/handlers/photo.js'));
  // cspReport: httpRateLimit sends the 429 and returns FALSE — the handler
  // must honor the boolean or the limit is advisory (the pre-2026-08-10 bug:
  // limited IPs still got their full report logged + a double response).
  assert('cspReport honors the httpRateLimit boolean (limit is enforcing, not advisory)',
    /allowed\s*=\s*await httpRateLimit\(req,\s*res,\s*['"]cspReport:ip['"],\s*60,\s*60_000\)/.test(monH)
    && /if\s*\(!allowed\)\s*return;/.test(monH));
  assert('ROUTES.cspReport records the real 60/min gate',
    /cspReport:\s*\{[^}]*ipLimit:\s*60\b[^}]*ipWindow:\s*MINUTE/.test(policy));
  // getGoogleReviews: was the ONLY public onRequest endpoint with zero rate
  // limiting (billable Places API behind the 6h cache). Now guardHttp-wired.
  assert('getGoogleReviews is wrapped in guardHttp (was fully unlimited)',
    /guardHttp\(\s*['"]getGoogleReviews['"]/.test(revH));
  // adminAI: same wiring + no-double-count rule as claudeProxy.
  assert('adminAI is wrapped in guardHttp and has no inline uid limiter',
    /guardHttp\(\s*['"]adminAI['"]/.test(aiH)
    && !/httpRateLimit\(req,\s*res,\s*['"]adminAI:/.test(aiH));
  assert('ROUTES.adminAI keeps the prod uid ceiling (60/hr)',
    /adminAI:\s*\{[^}]*uidLimit:\s*60\b[^}]*uidWindow:\s*HOUR/.test(policy));
  // Record-only entries must match the hand-rolled gates they describe.
  assert('publicVisualizerAI: handler gate is 5/hr and ROUTES agrees (was 3/min — ~36x looser/hr)',
    /httpRateLimit\(req,\s*res,\s*['"]publicVisualizerAI:ip['"],\s*5,\s*3_600_000\)/.test(aiH)
    && /publicVisualizerAI:\s*\{[^}]*ipLimit:\s*5\b[^}]*ipWindow:\s*HOUR/.test(policy));
  assert('signImageUrl: handler gates are 300/min uid+ip and ROUTES agrees',
    /httpRateLimit\(req,\s*res,\s*['"]signImageUrl:ip['"],\s*300,\s*60_000\)/.test(photoH)
    && /enforceRateLimit\(\s*['"]signImageUrl:uid['"][\s\S]{0,60}?,\s*300,\s*60_000\)/.test(photoH)
    && /signImageUrl:\s*\{[^}]*uidLimit:\s*300\b[^}]*ipLimit:\s*300\b/.test(policy));
  // Phantom/retired routes stay deleted: a ROUTES entry for a function that
  // doesn't exist (resetSubscriptionByEmail) or is a 410 stub (imageProxy)
  // makes the ops matrix lie about the fleet.
  assert('ROUTES carries no phantom resetSubscriptionByEmail or retired imageProxy entries',
    !/resetSubscriptionByEmail:\s*\{/.test(policy) && !/imageProxy:\s*\{/.test(policy));
}

section('Migration framework — versioned runner');
{
  const runner = read(path.join(ROOT, 'functions/migrations/runner.js'));
  const idx = read(FUNCTIONS + '/index.js');
  const m001 = read(path.join(ROOT, 'functions/migrations/scripts/001-noop-init.js'));

  // Public Cloud Function exports — manual + scheduled.
  assert('runner exposes runMigrations onCall + migrationsTick onSchedule',
    /exports\.runMigrations\s*=\s*onCall/.test(runner)
    && /exports\.migrationsTick\s*=\s*onSchedule/.test(runner));
  // index.js wires them up so they actually deploy.
  assert('functions/index.js wires runMigrations + migrationsTick',
    /exports\.runMigrations\s*=\s*_migrations\.runMigrations/.test(idx)
    && /exports\.migrationsTick\s*=\s*_migrations\.migrationsTick/.test(idx));
  // The state doc + history collection paths are stable — migrations
  // depend on them. Pinning here so a typo in runner gets caught.
  assert('runner uses /system/migrations as the state doc',
    /STATE_DOC_PATH\s*=\s*['"]system\/migrations['"]/.test(runner));
  // 001 must be the seed migration so the first deploy doesn't fail
  // trying to run real-data migrations against an empty state doc.
  assert('001 noop-init scaffolds the migration framework',
    /exports\.version\s*=\s*1[\s\S]{0,100}exports\.name\s*=\s*['"]noop-init['"]/.test(m001));
  // Loader rejects duplicates + bad shape — defensive against a
  // future migration committed without all three required fields.
  assert('runner rejects duplicate versions + bad shape',
    /Duplicate migration version/.test(runner)
    && /must export \{ version:/.test(runner));
  // backfillField helper is the canonical "for every doc in coll X,
  // set Y if missing" pattern (the PR #56 companyId backfill shape).
  assert('runner exposes idempotent backfillField helper',
    /async function backfillField\(db, collectionPath, fieldName/.test(runner)
    && /data\[fieldName\] !== undefined && data\[fieldName\] !== null/.test(runner));
  // Failure path: stops the chain, persists lastError for ops review,
  // does NOT advance appliedVersion — next tick retries from the
  // failed migration.
  assert('runner stops on first failure + records lastError',
    /lastFailedVersion:\s*m\.version/.test(runner)
    && /break;/.test(runner));
  // 003 closes the 002 blind spot: leads with NO timestamps at all were
  // skipped (backfillField drops null values), leaving them permanently
  // outside every stageStartedAt range window — never re-engaged. The
  // Timestamp.now() terminal fallback guarantees the field always lands.
  const m003 = read(path.join(ROOT, 'functions/migrations/scripts/003-stamp-timestampless-leads.js'));
  assert('003 stamps timestamp-less leads (Timestamp.now() terminal fallback)',
    /exports\.version\s*=\s*3/.test(m003)
    && /d\.updatedAt \|\| d\.createdAt \|\| Timestamp\.now\(\)/.test(m003));
}

section('Migration 005: orphan-estimate relink — conservative, tenant-scoped, audited');
{
  // CRM-audit backlog heal: the V2-builder + job-templates leadId:null bugs
  // (fixed client-side) left estimates invisible to their customer pages.
  // 005 relinks them — but a WRONG link is worse than a reported skip, so
  // every one of these guardrails must hold.
  const m005 = read(path.join(ROOT, 'functions/migrations/scripts/005-relink-orphan-estimates.js'));
  assert('005 exists as version 5 (relink-orphan-estimates)',
    /exports\.version\s*=\s*5/.test(m005)
    && /exports\.name\s*=\s*'relink-orphan-estimates'/.test(m005));
  // Same normalization the classic builder's save-time resolver uses —
  // one canonical definition of "same address" across the app.
  assert('005 normalizes like estimates.js (lowercase, strip non-alphanumeric)',
    /toLowerCase\(\)\.replace\(\/\[\^a-z0-9\]\/g/.test(m005));
  // Unique-match-only on every tier: exact, addr+name narrow, prefix, name.
  assert('005 links only on UNIQUE matches (never guesses among candidates)',
    /exact\.length === 1/.test(m005)
    && /narrowed\.length === 1/.test(m005)
    && /prefix\.length === 1/.test(m005)
    && /byName\.length === 1/.test(m005));
  // Candidate pool is same-tenant only — companyId key + userId key. A
  // cross-tenant relink would leak a customer into another company's book.
  assert('005 candidate pool is tenant-scoped (companyId/userId keys only)',
    /'c:' \+ e\.companyId/.test(m005) && /'u:' \+ e\.userId/.test(m005)
    && /skip\('no-tenant'\)/.test(m005));
  // An estimate WITH an address that matched nothing must NOT fall through
  // to name-matching — same owner name on a different address is likely a
  // different property.
  assert('005 never name-matches an estimate that has an address',
    /skip\('no-match'\); continue; \} \/\/ has an addr, nothing matched/.test(m005));
  // Stamp-back safety: rep-confirmed primaries are sacred; jobValue only
  // stamps a positive number (never zeroes a KPI); funnel position untouched.
  assert('005 stamp-back skips leads that already have a primaryEstimateId',
    /if \(!info \|\| info\.primaryEstimateId\) continue;/.test(m005));
  assert('005 stamps jobValue only when grandTotal is positive',
    /if \(primary\.grandTotal > 0\) update\.jobValue/.test(m005));
  assert('005 never writes stage or stageRole onto a lead',
    !/stage:/.test(m005) && !/stageRole/.test(m005));
  // Every decision lands in the audit report doc so skips are hand-fixable
  // and links are reversible per-row.
  assert('005 writes the audit report to /system/migrations/reports',
    /system\/migrations\/reports\/005-relink-orphan-estimates/.test(m005)
    && /skipped: skippedRows/.test(m005) && /linked: linkedRows/.test(m005));
}

section('Phase D.3 — integrationStatus secret-readout completeness');
{
  // Step 4c: integrationStatus body moved to handlers/integrations.js.
  // readFunctionsIndex() concatenates index.js + handlers/*.js so the
  // assertions below still find the configured{} block + rotationRunbook
  // regardless of which file the handler lives in.
  const idx = readFunctionsIndex();
  const sh = read(path.join(ROOT, 'functions/integrations/_shared.js'));
  // Every secret declared in _shared.js SECRETS should appear in the
  // integrationStatus.configured map (or be intentionally aggregated
  // into a parent key like upstash). Lists every secret name + the
  // rule.
  const declared = (sh.match(/[A-Z_]+:\s*defineSecret\('([A-Z_]+)'\)/g) || [])
    .map(s => s.match(/'([A-Z_]+)'/)[1]);
  const configuredBlock = (idx.match(/configured:\s*\{[\s\S]*?\},?\s*rateLimitProvider/) || [''])[0];
  // These are intentionally aggregated under a single key.
  const AGGREGATED = new Set(['UPSTASH_REDIS_REST_URL','UPSTASH_REDIS_REST_TOKEN']);
  const missing = declared.filter(name => {
    if (AGGREGATED.has(name)) return false;
    return !configuredBlock.includes("'" + name + "'");
  });
  assert('integrationStatus.configured covers every declared secret',
    missing.length === 0,
    'expected every secret in _shared.js to appear in the configured readout; missing: ' + missing.join(', '));
  // Spot-check the new D.3 additions
  for (const k of ['hoverWebhook','eagleviewWebhook','boldsignWebhook','groq']) {
    assert('configured.' + k + ' present in integrationStatus',
      new RegExp('\\b' + k + ':\\s+_hasInt').test(idx),
      'expected configured.' + k);
  }
  assert('integrationStatus exposes rotationRunbook URL',
    /rotationRunbook:\s*'https:\/\/github\.com\/jdealtia-sys\/nobigdealwithjoedeal\.com\/blob\/main\/documentation\/runbooks\/SECRET_ROTATION\.md'/.test(idx),
    'expected rotationRunbook URL in the response so admin UI can deep-link');
}

section('Phase D.3 — integrationAvailability (non-admin-safe availability readout)');
{
  // integrationStatus is deliberately admin-gated (H-06). requestMeasurement /
  // sendForSignature / lookupParcel need a status readout for EVERY signed-in
  // rep, so integrationAvailability exists alongside it in the same file
  // with no role check — see tests/smoke/auth.test.js's H-06 section for the
  // proof that integrationStatus itself stays unchanged.
  const idx = readFunctionsIndex();
  assert('integrationAvailability callable is exported from functions/index.js',
    /exports\.integrationAvailability\s*=\s*integrationsHandlers\.integrationAvailability/.test(idx));
  assert('integrationAvailability handler is defined with onCall in handlers/integrations.js',
    /exports\.integrationAvailability\s*=\s*onCall\s*\(/.test(idx));

  const m = idx.match(/exports\.integrationAvailability\s*=\s*onCall\s*\([\s\S]+?\}\s*\);/);
  assert('integrationAvailability handler block located', !!m);
  if (m) {
    assert('integrationAvailability requires authentication (unauthenticated on missing uid)',
      /!request\.auth \|\| !request\.auth\.uid/.test(m[0]) && /unauthenticated/.test(m[0]));
    assert('integrationAvailability does NOT contain a role/permission-denied check in its body',
      !/callerRole/.test(m[0]) && !/permission-denied/.test(m[0]) && !/admin/.test(m[0].replace(/\/\/.*$/gm, '')));
    // Only the booleans that actually gate requestMeasurement / sendForSignature /
    // lookupParcel — never the H-06-restricted fields (Turnstile, Upstash,
    // Sentry, Slack, webhook secrets, rateLimitProvider, rotationRunbook).
    for (const key of ['hover', 'eagleview', 'nearmap', 'instantroofer', 'boldsign', 'regrid']) {
      assert('integrationAvailability.configured exposes ' + key,
        new RegExp('\\b' + key + ':\\s+_hasInt').test(m[0]));
    }
    for (const restricted of ['sentry', 'slack', 'turnstile', 'upstash', 'hoverWebhook',
      'eagleviewWebhook', 'instantrooferWebhook', 'boldsignWebhook', 'hailtrace', 'swath',
      'calcom', 'thumbtackWebhook', 'deepgram', 'groq', 'kie', 'healthchecks',
      'rateLimitProvider', 'rotationRunbook']) {
      assert('integrationAvailability does NOT expose H-06-restricted field ' + restricted,
        !new RegExp('\\b' + restricted + '[:\\s]').test(m[0]));
    }
  }
}

section('Visualizer image-gen provider seam (kie.ai, ships dark)');
{
  const vig = read(path.join(FUNCTIONS, 'visualizer-image-gen.js'));
  assert('provider seam defaults to replicate',
    /process\.env\.IMAGEGEN_PROVIDER \|\| 'replicate'/.test(vig),
    'flipping providers must be an explicit env change, never a silent default');
  assert('KIE_API_KEY declared and registered on the endpoint',
    /defineSecret\('KIE_API_KEY'\)/.test(vig)
    && /secrets: \[REPLICATE_API_TOKEN, KIE_API_KEY\]/.test(vig));
  assert('kie path refuses loudly when the key is unset (no silent fallback)',
    /provider_not_configured/.test(vig));
  assert('both providers exist behind one response contract',
    /async function generateViaReplicate\(/.test(vig)
    && /async function generateViaKie\(/.test(vig)
    && /result\.imgBuf\.toString\('base64'\)/.test(vig));
  assert('kie staged input (homeowner PII) is deleted in a finally block',
    /finally \{[\s\S]{0,400}file\.delete\(\{ ignoreNotFound: true \}\)/.test(vig));
  assert('kie polling is bounded (no infinite loop inside the function timeout)',
    /attempt < 30/.test(vig) && /sleep\(3000\)/.test(vig));
  assert('integrationStatus surfaces the kie key',
    /kie:\s+_hasInt\('KIE_API_KEY'\)/.test(readFunctionsIndex().includes('KIE_API_KEY')
      ? readFunctionsIndex()
      : read(path.join(FUNCTIONS, 'handlers', 'integrations.js'))));
}

};
