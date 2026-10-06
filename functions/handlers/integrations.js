/**
 * functions/handlers/integrations.js — integration-facing endpoints.
 *
 * Step 4c extraction. Moved verbatim from functions/index.js:
 *   - integrationStatus (onCall, admin-visible secret + provider readout)
 *   - submitPublicLead  (onRequest, C-3 gated public form ingest)
 *
 * No behavioral changes; pure structural move. The integrationStatus
 * + submitPublicLead helpers still live in functions/integrations/*.js
 * (turnstile, _shared) and are imported here verbatim.
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
// Modular FieldValue import — FieldValue is undefined under the
// emulator runtime, so submitPublicLead 500'd on a valid write (see
// tests/public-intake.test.js). The modular path works in both prod and
// emulator. Same pattern as lead-bridge.js.
const { FieldValue } = require('firebase-admin/firestore');

const { httpRateLimit, enforceRateLimit, clientIp } = require('../integrations/upstash-ratelimit');
const { CORS_ORIGINS } = require('./_shared');
const { resolveCompanyByKey } = require('./public-site');
// Consent coercion lives in one dependency-free module shared with
// lead-alert's send-time gate, so "what counts as consent" cannot drift
// between the code that STORES it and the code that ACTS on it.
const TCPA = require('../tcpa-consent');

// ═══════════════════════════════════════════════════════════════
// integrationStatus — client-facing readout of which adapters are
// configured in this deploy. Lets the UI disable a button for an
// unconfigured provider instead of showing a cryptic error.
// ═══════════════════════════════════════════════════════════════
const {
  hasSecret: _hasInt,
  getSecret: _getInt,
  PROVIDERS: _intProviders,
  SECRETS: _intSecrets
} = require('../integrations/_shared');

exports.integrationStatus = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 10,
    memory: '256MiB', // was 128MiB — 128MiB intermittently misses the Gen2 startup healthcheck loading the full index.js graph (see cspReport in handlers/monitoring.js)
    secrets: Object.values(_intSecrets)
  },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required');
    }
    // H-06: gate to admin / company_admin. The previous "any authed
    // user" rule let a free-tier caller enumerate the full security
    // posture — specifically, whether Turnstile, Upstash, Sentry, and
    // Slack were configured. That's a reconnaissance amplifier: a
    // `turnstile:false` response turns submitPublicLead into an
    // IP-rate-limit-only surface. Keep the enumeration restricted
    // to people who already have a legitimate business-integration
    // UI to grey-out buttons on.
    const callerRole = (request.auth.token && request.auth.token.role) || '';
    if (!['admin', 'company_admin'].includes(callerRole)) {
      throw new HttpsError('permission-denied', 'Admin access required');
    }
    // R-01: the RUNTIME-active rate-limit provider. Always 'firestore'
    // since the never-provisioned Upstash adapter was removed 2026-10-04
    // (VENDOR-COST-LOCKIN Lane C); kept in the payload so existing admin
    // readouts and post-deploy checks keep their field.
    const { provider: rateLimitProvider } = require('../integrations/upstash-ratelimit');
    return {
      providers: _intProviders,
      configured: {
        sentry:             _hasInt('SENTRY_DSN_FUNCTIONS'),
        slack:              _hasInt('SLACK_WEBHOOK_URL'),
        turnstile:          _hasInt('TURNSTILE_SECRET'),
        // Webhook secrets are tracked separately so admin can see when
        // the inbound webhook auth is missing without conflating it
        // with the API-key state.
        // Instant Roofer — coordinates-in AI measure (the default provider) and
        // the bearer token its human-report webhook presents
        // (integrations/measurement.js; runbooks/INSTANTROOFER-SETUP.md).
        instantroofer:      _hasInt('INSTANTROOFER_API_KEY'),
        instantrooferWebhook: _hasInt('INSTANTROOFER_WEBHOOK_SECRET'),
        // Google Solar API measure (integrations/solar-measure.js). 'auto' is
        // usable when either provider is, since it falls back to Instant Roofer.
        solar:              _hasInt('SOLAR_API_KEY'),
        auto:               _hasInt('SOLAR_API_KEY') || _hasInt('INSTANTROOFER_API_KEY'),
        regrid:             _hasInt('REGRID_API_TOKEN'),
        calcom:             _hasInt('CALCOM_WEBHOOK_SECRET'),
        // Thumbtack lead/message/review webhook — Custom Header shared
        // token (no HMAC offered); receiver fails closed without it
        // (integrations/thumbtack.js).
        thumbtackWebhook:   _hasInt('THUMBTACK_WEBHOOK_SECRET'),
        // Thursday — the Bland AI receptionist (integrations/thursday.js):
        // API key (hydrate calls, copy recordings, SMS), the webhook signing
        // secret, and the bearer the pathway's caller lookup presents.
        bland:              _hasInt('BLAND_API_KEY'),
        blandWebhook:       _hasInt('BLAND_WEBHOOK_SECRET'),
        thursdayLookup:     _hasInt('THURSDAY_LOOKUP_TOKEN'),
        // Voice transcription — Groq Whisper (dictate, Voice Intelligence,
        // call center); Deepgram backs only transcribeVoiceMemo.
        deepgram:           _hasInt('DEEPGRAM_API_KEY'),
        groq:               _hasInt('GROQ_API_KEY'),
        // Healthchecks.io dead-man's-switch for every scheduled function
        // (integrations/heartbeat.js; runbooks/HEALTHCHECKS-SETUP.md).
        healthchecks:       _hasInt('HEALTHCHECKS_PING_KEY')
      },
      rateLimitProvider: rateLimitProvider(),
      // D.3 — runbook reference so the admin readout points at the
      // rotation procedure instead of requiring the rep to dig through
      // the repo.
      rotationRunbook: 'https://github.com/jdealtia-sys/nobigdealwithjoedeal.com/blob/main/documentation/runbooks/SECRET_ROTATION.md'
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// integrationAvailability — the non-admin-safe subset of integrationStatus.
//
// requestMeasurement / lookupParcel (the callers of requireConfigured() in
// docs/pro/js/integrations-client.js; e-sign left it with BoldSign on
// 2026-10-04 — in-house signing needs no vendor key) need
// to know whether their own gating provider is configured, but they run for
// EVERY rep, not just admin/company_admin. integrationStatus is deliberately
// admin-gated (H-06, above) to stop a free-tier caller from enumerating the
// full security posture (Turnstile/Upstash/Sentry/Slack/webhook secrets).
// This callable is the fix for the client-side short-circuit that used to
// fake an empty status for non-admins instead of ever calling the server:
// it exposes ONLY the handful of booleans those three callers actually gate
// on, to any signed-in caller, and nothing H-06 restricts.
// ═══════════════════════════════════════════════════════════════
exports.integrationAvailability = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 10,
    memory: '256MiB',
    secrets: [
      _intSecrets.INSTANTROOFER_API_KEY,
      _intSecrets.SOLAR_API_KEY,
      _intSecrets.REGRID_API_TOKEN
    ]
  },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Sign in required');
    }
    // No role check by design — this is the point of the callable: every
    // authenticated rep, not just admin/company_admin, needs this to light
    // up their own Auto-measure / parcel-lookup buttons.
    return {
      // Which named provider is active per category — an env-var selection
      // (functions/integrations/_shared.js PROVIDERS), not a secret.
      // requestMeasurement() reads providers.measurement to know which of
      // the `configured` keys below gates its own call.
      providers: {
        measurement: _intProviders.measurement,
        parcel: _intProviders.parcel
      },
      configured: {
        instantroofer: _hasInt('INSTANTROOFER_API_KEY'),
        // requestMeasurement() gates on configured[providers.measurement], so
        // the solar|auto values need their own keys here or the button refuses.
        solar:         _hasInt('SOLAR_API_KEY'),
        auto:          _hasInt('SOLAR_API_KEY') || _hasInt('INSTANTROOFER_API_KEY'),
        regrid:        _hasInt('REGRID_API_TOKEN')
      }
    };
  }
);

// ═════════════════════════════════════════════════════════════
// submitPublicLead — C-3 gated write path for the four public forms
// (guide, contact, estimate, storm_alert). Replaces the previous
// unauthenticated direct-Firestore-create, which had no rate limit
// and could be mass-fired at Firestore's list price for ~$2/M writes.
//
// Defenses:
//   - (NOT App Check — see the option block below for why it is absent and
//     why it never worked here. This line used to claim it rejected calls
//     without an attestation token; it did not.)
//   - httpRateLimit: per-IP 20/min — plenty for a human on a form,
//     enough to stop a single-box 1000 rps attack cold.
//   - Origin allowlist via CORS_ORIGINS matches only the two public
//     domains. Browsers refuse to send the request otherwise.
//   - Honeypot field 'nbd_hp' (legacy 'website' still checked): bots
//     fill every field; real forms leave it empty. Non-empty → silent
//     200 with no Firestore write. Renamed 2026-08-05 — a honeypot
//     NAMED 'website' matches browser URL-autofill heuristics, which
//     could fill it on a real form and silently drop the lead.
//   - Per-shape validation + hard size caps.
//   - Generic 200 response with opaque id so enumerating invalid
//     payloads gives no side-channel.
// ═════════════════════════════════════════════════════════════
// M-04: explicit per-kind allowlist for optional fields. The previous
// pass-through loop accepted ANY string field ≤500 chars from the
// request body and wrote it into Firestore under that key, which
// let an attacker stuff arbitrary keys (e.g. `leadScore`, `qualified`,
// `assignedTo`) into a guide_leads doc. Default posture is strict —
// only marketing-attribution UTMs + HTTP referrer pass through; add
// to the allowlist deliberately when a real need appears.
const PUBLIC_LEAD_OPTIONAL_DEFAULTS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'referrer',
  // Referral-code self-redemption: a friend who was texted a customer's
  // personal code (e.g. JOHN-AB12) can enter it on any public form. It flows
  // through lead-bridge onto the CRM lead as `redeemReferralCode`, where the
  // onReferralLeadWrite trigger resolves it and credits the $100 bonus on
  // close. Capped short below (maxLen.referralCode) on every kind.
  'referralCode'
];

// Intake answers every SERVICE-REQUEST form now asks (2026-09-30, Jo: "make
// sure we do capture all info needed"). Enum-checked after the optional loop
// (see INTAKE_ENUMS); free-text ones are length-capped like any optional.
// The lists live in public-lead-intake-spec.js since 2026-10-03, shared with
// updatePublicLeadIntake (the /estimate thank-you screen saves them AFTER the
// lead) so both paths accept exactly the same answers.
const { INTAKE_OPTIONAL, INTAKE_MAXLEN, INTAKE_ENUMS } = require('../public-lead-intake-spec');
// Kinds that are a homeowner asking for work (not a list signup): these carry
// the intake answers, may attach photos (public-lead-photos.js), and are
// flagged when they arrive without an address.
const SERVICE_KINDS = ['contact', 'estimate', 'inspect', 'free_roof'];

const PUBLIC_LEAD_KINDS = {
  guide: {
    collection: 'guide_leads',
    required: ['name', 'email', 'source'],
    maxLen:   { name: 200, email: 200, source: 200 },
    optional: [...PUBLIC_LEAD_OPTIONAL_DEFAULTS]
  },
  contact: {
    collection: 'contact_leads',
    required: ['firstName', 'phone', 'source'],
    // The NBD homepage contact form AND tenant microsite quote forms (e.g. Oaks
    // /sites/oaks) post lastName/email/address/zip/service/message alongside the
    // required fields. They're optional (older callers may omit them) and
    // allowlisted below so they persist and flow into the CRM lead via
    // lead-bridge — incl. `address`, so a bridged contact lead isn't blank in
    // the pipeline. (M-04: deliberate, bounded expansion.)
    maxLen:   { firstName: 200, lastName: 200, phone: 30, email: 200, address: 500, zip: 10, service: 200, message: 1500, source: 200 },
    optional: [...PUBLIC_LEAD_OPTIONAL_DEFAULTS, 'lastName', 'email', 'address', 'zip', 'service', 'message'],
    // TCPA consent (2026-10-03): the homepage form and the on-page quick form
    // (quick-lead-form.js) gate submit on the consent checkbox and post it.
    // Tenant microsites that post nothing simply store no record.
    boolOptional: ['tcpaConsent']
  },
  estimate: {
    collection: 'estimate_leads',
    required: ['address', 'source'],
    // The /estimate instant-estimator funnel posts its own contact +
    // selection fields (firstName/lastName/phone/email, service/roofType/
    // timeline), event tags (type/requestType — e.g. 'email_estimate_request',
    // which estimate-email.js sends on), and the preformatted plain-text
    // estimateSummary that gets emailed back to the homeowner. Previously
    // these were silently stripped by the strict allowlist.
    // (M-04: deliberate, bounded expansion.)
    maxLen:   {
      address: 500, source: 200, firstName: 200, lastName: 200, phone: 30,
      email: 200, service: 200, roofType: 50, timeline: 50, type: 50,
      requestType: 50, estimateSummary: 2000
    },
    optional: [...PUBLIC_LEAD_OPTIONAL_DEFAULTS, 'firstName', 'lastName', 'phone', 'email', 'service', 'roofType', 'timeline', 'type', 'requestType', 'estimateSummary'],
    // TCPA consent (2026-09-04). The funnel has always POSTED this — see the
    // comment at docs/assets/js/inline/4053149b2f.js:772 promising the record
    // is "audit-ready and the SMS-ack trigger can rely on it" — but it is a
    // BOOLEAN, and the optional loop below drops every non-string. It was
    // therefore silently discarded on every submission and no estimate lead
    // has ever carried it. Declared here as a boolean so the express-written-
    // consent record actually persists and lead-alert's SMS ack can gate on
    // it instead of inferring consent from the collection name.
    boolOptional: ['tcpaConsent'],
    // Coordinates (2026-09-06). The funnel has ALWAYS posted these — the
    // wizard geocodes the address at step 1 and puts `lat`/`lon` in the
    // submitted leadData — but they are NUMBERS, and the optional loop below
    // drops every non-string, so no estimate lead has ever carried them. They
    // are what the roof measurement is keyed on (Instant Roofer locates the
    // building from a point, not an address), so without them every web lead
    // would need a second, worse geocode server-side.
    numOptional: { lat: { min: -90, max: 90 }, lon: { min: -180, max: 180 } }
  },
  storm: {
    collection: 'storm_alert_subscribers',
    required: ['name', 'phone', 'zip', 'source'],
    maxLen:   { name: 200, phone: 30, zip: 10, source: 200, concern: 80 },
    exact:    { zip: 5 },
    // `concern` = the homeowner's qualification answer (e.g. "already have
    // damage — waiting on insurance") — persisted so that hot signal isn't
    // silently dropped. `active` is set server-side via serverDefaults (never
    // trusted from the client): the storm-alert cron in sms-functions.js
    // queries .where('active','==',true), so a subscriber created without it
    // would be invisible to every alert send.
    optional: [...PUBLIC_LEAD_OPTIONAL_DEFAULTS, 'concern'],
    // TCPA consent (2026-10-03): /storm-alerts now gates signup on the same
    // express-written-consent checkbox as /storm-check and posts its value.
    boolOptional: ['tcpaConsent'],
    serverDefaults: { active: true }
  },
  // "One Free Roof a Year" giveaway entries. Nominator can be the
  // homeowner themselves or a neighbor / family member. Story is the
  // free-text pitch for why this homeowner should win.
  free_roof: {
    collection: 'free_roof_entries',
    required: ['nomineeName', 'phone', 'address', 'story', 'source'],
    maxLen:   {
      nomineeName: 200, phone: 30, email: 200, address: 500,
      story: 1500, source: 200, nominatorName: 200, nominatorRelation: 100,
      category: 50
    },
    optional: [...PUBLIC_LEAD_OPTIONAL_DEFAULTS, 'email', 'nominatorName', 'nominatorRelation', 'category']
  },
  // /inspect public form (printed QR pieces → free inspection request).
  // Photos themselves aren't uploaded through this gateway — the form
  // submits photo metadata (count + filenames) so Joe knows to ask the
  // homeowner for them at the call.
  inspect: {
    collection: 'inspect_leads',
    required: ['name', 'phone', 'address', 'source'],
    maxLen:   {
      name: 200, phone: 30, address: 500, email: 200,
      story: 1500, source: 200, photoNames: 2000
    },
    optional: [...PUBLIC_LEAD_OPTIONAL_DEFAULTS, 'email', 'story', 'photoCount', 'photoNames'],
    // TCPA consent (2026-09-04, handoff item 6). Three of the four forms that
    // post this kind — /storm-check, /roof-score, /storm-report — gate their
    // submit on an express-written-consent checkbox and now POST its value;
    // /inspect has no checkbox and posts nothing, so its documents carry no
    // field and the send-time gate refuses to text them (no_stored_consent).
    // Declared as a boolean here for the same reason as `estimate`: the
    // string-only optional loop dropped it silently.
    boolOptional: ['tcpaConsent'],
    // Coordinates (2026-10-06). /storm-report already geocodes the address to
    // build the report; it now posts that point so stormReportEmail can find
    // the SAME server-built report (public_cache/storm_*) for the measured-
    // gust line, and lead-bridge carries it onto the CRM lead (lat/lng) like
    // estimate leads. Range-checked; 0/0 dropped by the shared loop below.
    numOptional: { lat: { min: -90, max: 90 }, lon: { min: -180, max: 180 } }
  }
};

// Bound the shared `referralCode` optional to a short cap on every kind (codes
// are ~12 chars; the redemption trigger validates + uppercases). Without a
// per-key maxLen the optional-field loop would fall back to the generic 500.
for (const spec of Object.values(PUBLIC_LEAD_KINDS)) { spec.maxLen.referralCode = 32; }
for (const k of SERVICE_KINDS) {
  const spec = PUBLIC_LEAD_KINDS[k];
  spec.optional = spec.optional.concat(INTAKE_OPTIONAL.filter((f) => !spec.optional.includes(f)));
  Object.assign(spec.maxLen, INTAKE_MAXLEN);
  spec.numOptional = Object.assign({}, spec.numOptional || {}, { photoCount: { min: 0, max: 10 } });
}

const { verifyTurnstile } = require('../integrations/turnstile');
const { SECRETS: INT_SECRETS } = require('../integrations/_shared');

// Collapse an IPv6 address to its /64 prefix for rate-limiting, so a single
// IPv6 allocation can't rotate through its 2^64 addresses to bypass the per-IP
// cap. IPv4 (no ':') and anything unparseable pass through unchanged — exact
// canonicalisation isn't needed, only a stable per-customer bucket.
// Public form text never carries markup (names, addresses, messages, UTMs).
// Drop < and > at the door so a web-form lead can't smuggle HTML into the
// CRM — defence in depth behind the client-side escaping (security audit
// 2026-09-29 found the Cmd-K palette rendering web-form names raw).
function noAngle(s) { return String(s).replace(/[<>]/g, ''); }

function rateLimitIpKey(ip) {
  const s = String(ip || '');
  if (s.indexOf(':') === -1) return s; // IPv4 / empty — unchanged
  const head = s.split('%')[0];        // strip any zone id
  const sides = head.split('::');
  let groups;
  if (sides.length === 2) {
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const fill = Array(Math.max(0, 8 - left.length - right.length)).fill('0');
    groups = left.concat(fill, right);
  } else {
    groups = head.split(':');
  }
  return groups.slice(0, 4).join(':') + '::/64';
}

exports.submitPublicLead = onRequest(
  {
    cors: CORS_ORIGINS,        // same origin allowlist used by claudeProxy
    // NO enforceAppCheck here — deliberately, twice over. (1) It would be
    // dead config: firebase-functions v2 `onRequest` IGNORES the option
    // (it's onCall-only; verified in the SDK source — HttpsOptions carries
    // it but only the callable wrapper reads it). A previous revision set
    // `enforceAppCheck: true` with a comment claiming App Check "sits in
    // front", which was never true and misled security review. (2) Even
    // done manually it would be wrong: this is the PUBLIC homeowner quote
    // form on tenant microsites — anonymous browsers with no App Check
    // provider. The real protections, all below in the handler body:
    // per-IP rate limit (IPv6 /64-keyed), Turnstile when configured
    // (fail-closed on verifier error), honeypot, strict field validation
    // (M-04 allowlist), and the CORS origin allowlist above.
    secrets: [INT_SECRETS.TURNSTILE_SECRET],
    maxInstances: 20,
    concurrency: 80,
    timeoutSeconds: 15,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }

    // Per-IP rate limit — the single most important gate. 20/min/IP.
    // A human filling a form takes >10s; a spam script fires faster.
    // Key on the IPv6 /64 prefix (IPv4 unchanged) so one IPv6 allocation can't
    // rotate addresses to bypass the cap. This gate is currently load-bearing:
    // App Check isn't enforcing and Turnstile passes through unless both
    // TURNSTILE_SECRET and TURNSTILE_REQUIRED=true are set (integrations/turnstile.js).
    try {
      await enforceRateLimit('publicLead:ip', rateLimitIpKey(clientIp(req)), 20, 60_000);
    } catch (e) {
      if (e && e.rateLimited) {
        res.set('Retry-After', '60');
        res.status(429).json({ error: 'Rate limit exceeded' });
        return;
      }
      // Limiter backend error → fall back to the original helper, which fails
      // open to the Firestore limiter rather than dropping a legitimate lead.
      if (!(await httpRateLimit(req, res, 'publicLead:ip', 20, 60_000))) return;
    }

    // Turnstile verification (if configured). Fail closed on verifier
    // error. No-op passthrough when TURNSTILE_SECRET is unset so dev
    // environments still work.
    const turnstile = await verifyTurnstile(
      (req.body && req.body.turnstileToken) || '',
      clientIp(req)
    );
    if (!turnstile.ok) {
      res.status(403).json({ error: 'Verification failed', reason: turnstile.reason });
      return;
    }

    const body = req.body || {};
    const kind = typeof body.kind === 'string' ? body.kind : '';
    const spec = PUBLIC_LEAD_KINDS[kind];
    if (!spec) {
      // Opaque error: same shape as success so an attacker can't
      // enumerate valid kinds without also fetching a real response.
      res.status(400).json({ error: 'Invalid submission' });
      return;
    }

    // Honeypot — real humans never fill this. Pretend success. Trip on ANY
    // truthy value, not just a non-empty STRING: a bot sending website:true or
    // website:["x"] (non-string) slipped past the old `typeof === 'string'`
    // check and submitted as if legitimate.
    // 2026-08-05 (audit P6): the live field is now `nbd_hp` — a field NAMED
    // `website` matches Chromium's URL-autofill heuristic, so browser autofill
    // could fill the honeypot on a real homeowner's form and silently drop the
    // lead. The legacy `website` key stays checked indefinitely: new pages no
    // longer render an input by that name (autofill can't populate what isn't
    // there), so any request still carrying a non-empty `website` is a stale
    // cached page (HTML max-age≤300, decaying) or a bot replaying the old shape.
    const hpKey = ['nbd_hp', 'website'].find(
      (k) => body[k] != null && String(body[k]).length > 0
    );
    if (hpKey) {
      // No raw IP in logs (PII, security batch 2026-10-03): the network
      // prefix (/24 for IPv4, /64 for IPv6) is enough to spot a bot wave.
      const _ipRaw = String(clientIp(req) || '');
      const ipPrefix = _ipRaw.indexOf(':') === -1
        ? _ipRaw.split('.').slice(0, 3).join('.') + (_ipRaw ? '.0/24' : '')
        : rateLimitIpKey(_ipRaw);
      logger.info('submitPublicLead: honeypot tripped', { kind, key: hpKey, ipPrefix });
      res.status(200).json({ success: true });
      return;
    }

    // Per-shape validation.
    const data = {};
    for (const key of spec.required) {
      const val = body[key];
      if (typeof val !== 'string') { res.status(400).json({ error: 'Invalid submission' }); return; }
      const max = spec.maxLen[key] || 200;
      if (val.length === 0 || val.length > max) { res.status(400).json({ error: 'Invalid submission' }); return; }
      if (spec.exact && spec.exact[key] != null && val.length !== spec.exact[key]) {
        res.status(400).json({ error: 'Invalid submission' }); return;
      }
      data[key] = noAngle(val);
    }

    // M-04: optional fields are a per-kind allowlist (UTMs + referrer
    // today). Keys outside the allowlist are silently dropped — we
    // do NOT 400 on extras because benign callers paste the whole
    // query string from a landing page.
    for (const key of (spec.optional || [])) {
      const v = body[key];
      if (typeof v !== 'string') continue;
      // Per-field cap when the kind declares one (e.g. a 1500-char message),
      // else a conservative 500-char default. Over-cap → drop (not 400):
      // an optional field should never fail an otherwise-valid submission.
      const max = (spec.maxLen && spec.maxLen[key]) || 500;
      if (v.length === 0 || v.length > max) continue;
      data[key] = noAngle(v);
    }

    // M-04 addendum (2026-09-04): boolean consent fields. Kept as its own
    // strict loop rather than loosening the string loop above — that loop's
    // `typeof v !== 'string'` guard IS the M-04 hardening and must stay.
    // Only keys the kind declares in boolOptional are considered, only real
    // booleans (or their exact string forms, for form-encoded callers) are
    // accepted, and an ABSENT key writes nothing: no record must ever be
    // stamped `false` merely because a caller did not mention the field.
    // A missing consent field and a stored `false` mean different things and
    // the send-time gate treats both as "do not text", so this stays honest
    // in either direction.
    for (const key of (spec.boolOptional || [])) {
      const parsed = TCPA.parseSubmittedConsent(body[key]);
      if (parsed !== undefined) data[key] = parsed;
    }

    // Numeric optionals (2026-09-06), same shape as boolOptional and for the
    // same reason: the string loop's `typeof v !== 'string'` guard is the M-04
    // hardening and must stay. Only keys the kind declares are considered,
    // each is range-checked, and 0/0 (the classic "geocode failed" value) is
    // rejected rather than stored as a real point in the Gulf of Guinea.
    for (const key of Object.keys(spec.numOptional || {})) {
      const raw = body[key];
      if (raw === null || raw === undefined || raw === '') continue;
      const n = Number(raw);
      if (!isFinite(n)) continue;
      const range = spec.numOptional[key];
      if (n < range.min || n > range.max) continue;
      data[key] = n;
    }
    if (data.lat === 0 && data.lon === 0) { delete data.lat; delete data.lon; }
    // Enum-valued intake answers: anything off-list is dropped, never stored.
    for (const [k, allowed] of Object.entries(INTAKE_ENUMS)) {
      if (data[k] != null && !allowed.includes(data[k])) delete data[k];
    }
    // Address is required on every service form (2026-09-30). The pages
    // enforce it; the server FLAGS a missing one instead of refusing, so a
    // stale cached page (or a tenant microsite not yet updated) never loses a
    // homeowner's lead. Tighten to a hard requirement once caches have turned.
    if (SERVICE_KINDS.includes(kind) && !data.address) data.missingAddress = true;

    // Trust-but-tag: server-only fields the client can't spoof.
    data.ip = clientIp(req);
    data.userAgent = String(req.headers['user-agent'] || '').slice(0, 200);
    data.createdAt = FieldValue.serverTimestamp();
    // TCPA consent RECORD (2026-10-03): when, which disclosure version, which
    // page, which IP — server-stamped, so the browser cannot backdate it.
    // Empty unless tcpaConsent is exactly true (tcpa-consent.consentRecord).
    Object.assign(data, TCPA.consentRecord({
      consent: data.tcpaConsent,
      kind,
      referer: req.headers && (req.headers.referer || req.headers.referrer),
      source: data.source,
      ip: data.ip,
      at: FieldValue.serverTimestamp(),
    }));
    // Per-kind server-set defaults (never trusted from the client). storm sets
    // active:true so the storm-alert cron's .where('active','==',true) actually
    // matches form signups — the client `active` field is intentionally dropped.
    Object.assign(data, spec.serverDefaults || {});

    // Multi-tenant tag (Phase C support): a tenant microsite declares which
    // tenant a public lead belongs to via `companyId`. lead-alert.js routes
    // the alert to that tenant. NBD's main forms pass none → undefined →
    // lead-alert falls back to Joe (byte-identical to today). The id is
    // sanitised AND validated against the companies registry, so a lead can
    // only be tagged to a REAL tenant (the registry read runs only when a
    // companyId was supplied — NBD's path is unchanged, no extra read).
    // Follow-on: migrate the Oaks microsite off the separate marketing
    // project so its leads flow through here too.
    // Case-PRESERVING validation. companies/{id} is keyed by the Firebase
    // Auth uid (createCompany/provisioning.js), which is case-sensitive
    // mixed-case alphanumerics — lowercasing here mangled every real tenant
    // id so the registry read below missed, the tag was dropped, and the
    // lead misrouted to Joe instead of the tenant. Match the same charset
    // as public-site.js KEY_RE; the legacy 'oaks' slug is already lowercase
    // so it still matches. Reject (clear) anything with disallowed chars
    // rather than silently stripping them into a different, wrong id.
    let _cid = String((body.companyId != null ? body.companyId : '') || '').trim();
    if (_cid && !/^[A-Za-z0-9_-]{1,64}$/.test(_cid)) _cid = '';
    if (_cid) {
      try {
        const known = await getFirestore().collection('companies').doc(_cid).get();
        if (!known.exists) _cid = '';
      } catch (_) { _cid = ''; }
    }
    if (_cid) data.companyId = _cid;

    // P5 indirection (tenant-lifecycle audit, resolved 2026-08-06): the
    // tenant microsite now tags leads with its public `siteKey` — the slug
    // when one is configured — instead of round-tripping the tenant's
    // Firebase uid through the client. Resolved with the SAME resolver the
    // site-config endpoint uses (doc id OR siteSlug, active-status check),
    // and the RESOLVED id — never the client's string — is what persists.
    // This is strictly harder to abuse than the legacy companyId tag above:
    // an inactive tenant stops resolving here. When both keys arrive (the
    // ≤5-min cache-skew window between an old template and the new API),
    // the server-resolved siteKey wins. siteKey itself is not in any field
    // allowlist, so it never persists raw. Resolution failure only drops
    // the tag (lead still lands, routed to the default pipeline) — a
    // tagging problem must never lose a homeowner's lead.
    let _skey = String((body.siteKey != null ? body.siteKey : '') || '').trim();
    if (_skey && !/^[A-Za-z0-9_-]{1,64}$/.test(_skey)) _skey = '';
    if (_skey) {
      try {
        const hit = await resolveCompanyByKey(getFirestore(), _skey);
        if (hit) data.companyId = hit.companyId;
      } catch (_) { /* tag drop only */ }
    }

    try {
      const ref = await getFirestore().collection(spec.collection).add(data);
      // turnstileTokenPresent (2026-09-06): the ONLY way to know, before
      // TURNSTILE_SECRET is set, that real visitors are actually producing
      // tokens. Setting the secret while the client is silently tokenless
      // 403s 100% of public leads, so the rollout is: deploy the site key →
      // watch this field go true on live traffic → only then set the secret.
      // Boolean only — a token is a credential and never gets logged.
      logger.info('submitPublicLead', {
        kind, id: ref.id,
        turnstileTokenPresent: !!(body && body.turnstileToken),
        turnstileConfigured: turnstile.configured === true
      });
      // Photos (2026-09-30): a one-time upload grant for this submission, only
      // when the page says the homeowner picked photos. Never blocks the lead.
      // wantsFollowUp (2026-10-03): the /estimate funnel asks its optional
      // "help Joe prepare" questions on the thank-you screen, AFTER the lead
      // exists; the same 60-minute grant authorises that one follow-up
      // (updatePublicLeadIntake) and any photos picked there.
      let photoToken = null;
      const _wants = (v) => v === true || v === 'true';
      if (SERVICE_KINDS.includes(kind) && (_wants(body.wantsPhotos) || _wants(body.wantsFollowUp))) {
        try {
          photoToken = await require('../public-lead-photos')._internal.mintPhotoGrant(getFirestore(), {
            collection: spec.collection, publicId: ref.id, companyId: data.companyId || null,
          });
        } catch (e) { logger.warn('submitPublicLead: photo grant failed', { kind, err: e.message }); }
      }
      res.status(200).json(Object.assign({ success: true, id: ref.id }, photoToken ? { photoToken } : {}));
    } catch (e) {
      logger.error('submitPublicLead error', { kind, err: e.message });
      res.status(500).json({ error: 'Submission failed' });
    }
  }
);

// Test seam (2026-09-30): the per-kind field specs, read-only use in tests.
exports._publicLeadSpec = { PUBLIC_LEAD_KINDS, SERVICE_KINDS, INTAKE_OPTIONAL, INTAKE_ENUMS };
