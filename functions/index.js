/**
 * Firebase Cloud Functions — NBD Pro API Proxy (thin aggregator).
 *
 * Step 4c (2026-05-16): inline handlers extracted to functions/handlers/
 * to keep this file tractable. The single export contract that Firebase
 * deploy reads from `exports.*` is preserved — every Cloud Function name
 * that used to live in this file is still exported by name, either via
 * an explicit re-export of a handler module property, or via
 * `Object.assign(exports, require(...))` for sibling modules that
 * already owned their own exports.
 *
 * Where the inline handlers went:
 *   handlers/ai.js          — claudeProxy, publicVisualizerAI
 *   handlers/photo.js       — analyzeRoofPhoto, signImageUrl, imageProxy, setStorageCors
 *   handlers/admin.js       — getAdminAnalytics,
 *                             createTeamMember,
 *                             updateUserRole, deactivateUser, listTeamMembers,
 *                             rotateAccessCodes
 *   handlers/auth.js        — onRepSignup, activateInvitedRep,
 *                             provisionE2ETestUser, cleanupE2ETestData,
 *                             mintOwnerClaims, revokeMySessions
 *   handlers/migrations.js  — backfillAnalytics
 *   handlers/integrations.js— integrationStatus, submitPublicLead
 *   handlers/portal.js      — validateAccessCode (the inline access-code
 *                             callable; NOT the sibling functions/portal.js)
 *   handlers/monitoring.js  — cspReport, clientError
 *   handlers/_shared.js     — CORS_ORIGINS, Claude budget consts +
 *                             helpers, requireTeamAdmin, normalizeRole,
 *                             normalizeEmail, parseAddress, reverseGeocode,
 *                             _generateE2EPassword, E2E_TEST_USER_EMAIL,
 *                             OWNER_EMAILS, isOwnerCaller, INVITE_ALLOWED_ROLES,
 *                             TEAM_ROLES, LEGACY_ACCESS_CODES
 *
 * Sibling modules that already lived in their own files (portal.js,
 * stripe.js, push-functions.js, integrations/*, etc.) were NOT touched.
 *
 * SETUP:
 *   1. cd functions && npm install
 *   2. firebase functions:secrets:set ANTHROPIC_API_KEY
 *      (paste your sk-ant-... key when prompted)
 *   3. firebase deploy --only functions
 *
 * CLIENT USAGE:
 *   const result = await fetch('https://us-central1-nobigdeal-pro.cloudfunctions.net/claudeProxy', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer <firebase-id-token>' },
 *     body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1000, messages: [...] })
 *   });
 */

'use strict';

const admin = require('firebase-admin');
admin.initializeApp();

// Rate limiter: adapter module picks Upstash vs Firestore at call time
// based on NBD_RATE_LIMIT_PROVIDER + whether Upstash secrets are set.
// Falls back to the Firestore limiter automatically.
require('./integrations/upstash-ratelimit');
require('./integrations/sentry');

// B2: callableRateLimit + requirePaidSubscription + requireAuth
// live in functions/shared.js so every module gets the same
// implementation. Inlined copies across this file + portal.js +
// sms-functions.js have been removed.
require('./shared');

// ═══════════════════════════════════════════════════════════════
// LAZY FAST PATH (2026-10-04) — a running instance loads ONE module.
//
// Every Gen2 function is its own Cloud Run service, yet each cold start ran
// this whole file: ~116 module requires for 237 exports, to serve one of them
// (and needed 256MiB+ to hold them all). The runtime names the function it is
// serving in FUNCTION_TARGET (Cloud Run's Functions Framework and the
// emulator's per-function workers both set it to the export name), so when it
// is set and functions/function-map.json knows the name, export just that
// function from just its module and stop.
//
// Deploy discovery (firebase-tools' manifest pass) and the emulator's
// discovery pass run WITHOUT FUNCTION_TARGET and take the full path below, so
// the deployed surface is unchanged — tests/functions-lazy-load-2026-10-04
// .test.js runs the real discovery loader both ways and requires identical
// endpoint lists, and re-proves every map entry by object identity. An
// unmapped or stale name falls through to the full load: slower, never broken.
// Regenerate the map after adding/moving an export:
//   node scripts/gen-function-map.js        (CI: --check)
// Memory settings are deliberately unchanged in this PR (follow-up: measure
// cold-start RSS per function now that each loads one module, then trim).
// ═══════════════════════════════════════════════════════════════
{
  const target = process.env.FUNCTION_TARGET;
  if (target) {
    let map = null;
    try { map = require('./function-map.json'); } catch (_) { map = null; }
    const rel = map && Object.prototype.hasOwnProperty.call(map, target) ? map[target] : null;
    const fn = rel ? require(rel)[target] : undefined;
    if (typeof fn === 'function') {
      exports[target] = fn;
      return; // CommonJS module scope: skip the full load below.
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// STEP 4c — inline handlers re-exported from functions/handlers/*.
//
// Order doesn't matter for the export contract; we group thematically
// so audits like grep'ing for an export name land on a single line.
// ═══════════════════════════════════════════════════════════════

// AI proxies (Claude proxy + public homeowner visualizer)
const aiHandlers = require('./handlers/ai');
exports.claudeProxy        = aiHandlers.claudeProxy;
exports.publicVisualizerAI = aiHandlers.publicVisualizerAI;
exports.publicFunnelAI     = aiHandlers.publicFunnelAI;
exports.adminAI            = aiHandlers.adminAI;

// Photo / image (signed URLs, vision analysis, CORS bootstrap)
const photoHandlers = require('./handlers/photo');
exports.setStorageCors  = photoHandlers.setStorageCors;
exports.signImageUrl    = photoHandlers.signImageUrl;
exports.imageProxy      = photoHandlers.imageProxy;
exports.analyzeRoofPhoto = photoHandlers.analyzeRoofPhoto;

// D2D door-number resolver — Google (ROOFTOP) + Regrid (parcel) cross-check
const geocodeHandlers = require('./handlers/geocode');
exports.resolveAddress = geocodeHandlers.resolveAddress;

// Team-scale bulk re-verify — owner/admin re-scores the whole company's knocks
const reverifyKnocksHandlers = require('./handlers/reverify-knocks');
exports.reverifyCompanyKnocks = reverifyKnocksHandlers.reverifyCompanyKnocks;

// idea #1 Phase 2: server-verified, immutable storm proof for a lead — looks up
// verified hail near the address and writes an adjuster-grade record to the
// frozen leads/{id}/storm_proofs subcollection.
const stormProofHandlers = require('./handlers/storm-proof');
exports.attachStormProof = stormProofHandlers.attachStormProof;

// Admin / team-management callables
const adminHandlers = require('./handlers/admin');
exports.getAdminAnalytics          = adminHandlers.getAdminAnalytics;
exports.rotateAccessCodes          = adminHandlers.rotateAccessCodes;
exports.createTeamMember           = adminHandlers.createTeamMember;
exports.updateUserRole             = adminHandlers.updateUserRole;
exports.deactivateUser             = adminHandlers.deactivateUser;
exports.removeMember               = adminHandlers.removeMember;
exports.listTeamMembers            = adminHandlers.listTeamMembers;

// T-3: per-rep AI texting analytics (collectionGroup scan over ai_drafts).
const aiTextingStatsHandlers = require('./handlers/ai-texting-stats');
exports.getAiTextingStats          = aiTextingStatsHandlers.getAiTextingStats;

// Real claudeProxy usage aggregation for /admin/analytics.html (replaces
// the page's SAMPLE DATA mock).
const aiUsageAnalyticsHandlers = require('./handlers/ai-usage-analytics');
exports.getAiUsageAnalytics        = aiUsageAnalyticsHandlers.getAiUsageAnalytics;

// idea #2 follow-up: company-wide adjuster-tactic board (collectionGroup scan
// over recordings, bucketed by carrier/adjuster from the call summaries).
const adjusterBoardHandlers = require('./handlers/adjuster-board');
exports.getAdjusterTacticBoard     = adjusterBoardHandlers.getAdjusterTacticBoard;

// Stripe Connect Express — PHASE 1 ONLY: accounts + onboarding + account state.
// Moves no money and mints no payment links; the #1123 platform-only gate in
// stripe.js is untouched. See the header of handlers/stripe-connect.js.
const stripeConnectHandlers = require('./handlers/stripe-connect');
exports.createConnectAccount        = stripeConnectHandlers.createConnectAccount;
exports.createConnectOnboardingLink = stripeConnectHandlers.createConnectOnboardingLink;
exports.getConnectStatus            = stripeConnectHandlers.getConnectStatus;
exports.createConnectDashboardLink  = stripeConnectHandlers.createConnectDashboardLink;
exports.stripeConnectWebhook        = stripeConnectHandlers.stripeConnectWebhook;

// T-4: live persona preview for Settings → AI Texting.
const aiTextingPreviewHandlers = require('./handlers/ai-texting-preview');
exports.previewAiPersona           = aiTextingPreviewHandlers.previewAiPersona;

// Idea #7 Phase 2: convert an unmatched-SMS inbox row → lead (server dedup)
// + auto-drafted AI reply. Admin-only (unmatched_sms is a global admin inbox).
const inboundSmsConvertHandlers = require('./handlers/inbound-sms-convert');
exports.convertUnmatchedSms        = inboundSmsConvertHandlers.convertUnmatchedSms;

// Auth / identity triggers + callables
// NOTE: onRepSignup is in NBD_DEPLOY_SKIP_LIST per
// .github/workflows/firebase-deploy.yml — DO NOT remove its export.
// The skip-list is applied at deploy time, not at code time. (Do NOT try
// to gate the export on env either: the emulator runs trigger DISCOVERY
// with a scrubbed env, so a conditional export half-registers the blocking
// trigger — registered with the Auth emulator, missing from the runtime —
// and every signup dies on a 500. The emulator-rig skip lives INSIDE the
// handler instead; see handlers/auth.js.)
const authHandlers = require('./handlers/auth');
exports.onRepSignup          = authHandlers.onRepSignup;
exports.activateInvitedRep   = authHandlers.activateInvitedRep;
exports.provisionE2ETestUser = authHandlers.provisionE2ETestUser;
exports.cleanupE2ETestData   = authHandlers.cleanupE2ETestData;
// Owner-role claim minting (claims-based root — see handlers/auth.js).
// Deployed via the strict pass (NOT skip-listed); this re-export is
// load-bearing for deploy-by-name, same as every handler above.
exports.mintOwnerClaims      = authHandlers.mintOwnerClaims;
// Self-service session revocation — the "Sign Out Everywhere" button's
// backing callable (2026-09-08). Caller-scoped: revokes the CALLER's own
// refresh tokens and takes no target parameter.
exports.revokeMySessions     = authHandlers.revokeMySessions;

// Owner-callable migrations (NOT the versioned admin runner — that
// stays in functions/migrations/runner.js, re-exported below).
const migrationsHandlers = require('./handlers/migrations');
exports.backfillAnalytics   = migrationsHandlers.backfillAnalytics;

// Integration-facing endpoints (status readout + public lead ingest)
const integrationsHandlers = require('./handlers/integrations');
exports.integrationStatus = integrationsHandlers.integrationStatus;
// Non-admin-safe availability readout — see the H-06 comment on
// integrationStatus in handlers/integrations.js for why that one stays
// admin-gated and this one deliberately does not.
exports.integrationAvailability = integrationsHandlers.integrationAvailability;
exports.submitPublicLead  = integrationsHandlers.submitPublicLead;
// Photos attached to a website request (2026-09-30) — one-time grant from submitPublicLead.
exports.uploadPublicLeadPhoto = require('./public-lead-photos').uploadPublicLeadPhoto;
// The /estimate thank-you screen's optional answers, saved onto the same lead (2026-10-03).
exports.updatePublicLeadIntake = require('./public-lead-photos').updatePublicLeadIntake;

// Inline access-code callable. Distinct from functions/portal.js
// (which owns createPortalToken / revokePortalToken /
// getHomeownerPortalView and is loaded below via Object.assign).
const portalHandlersInline = require('./handlers/portal');
exports.validateAccessCode = portalHandlersInline.validateAccessCode;

// PILLAR1 Phase 2 — self-serve tenant provisioning (companies/{uid} +
// companyProfile seed + owner claims). See handlers/provisioning.js.
const provisioningHandlers = require('./handlers/provisioning');
exports.createCompany = provisioningHandlers.createCompany;
// Global customer-ID prefix reservation (docPrefixes/{PREFIX}). The only writer
// of brand.docPrefix/seal + the registry; closes the cross-tenant referral
// misroute. See handlers/provisioning.js:reserveCompanyPrefix.
exports.reserveCompanyPrefix = provisioningHandlers.reserveCompanyPrefix;

// PILLAR1 Phase 3 — team invites, de-GCIP'd (claim on first dashboard
// load instead of the never-deployable onRepSignup blocking trigger).
const inviteHandlers = require('./handlers/invites');
exports.claimInvite = inviteHandlers.claimInvite;
exports.teamInviteEmail = inviteHandlers.teamInviteEmail;
// Pillar 4 — invites create server-side so plan seat limits hold.
exports.createTeamInvite = inviteHandlers.createTeamInvite;
// Seat picker — owner/admin chooses which reps hold the plan's limited seats
// when over-capacity (cap-enforced; benches the rest).
exports.assignSeats = inviteHandlers.assignSeats;
// Route 1b — per-seat add-on purchase. DARK until the STRIPE_PRICE_SEAT
// secret carries a real price id; the deploy itself requires the secret to
// EXIST (see handlers/seats.js header — merge gate).
const seatHandlers = require('./handlers/seats');
exports.setCompanySeatCount = seatHandlers.setCompanySeatCount;

// Pillar 5 phase 1 — data-driven tenant microsite (/sites/t/) config read.
const publicSiteHandlers = require('./handlers/public-site');
exports.getPublicSiteConfig = publicSiteHandlers.getPublicSiteConfig;
exports.setSiteSlug = publicSiteHandlers.setSiteSlug;
exports.publishTenantSite = publicSiteHandlers.publishTenantSite;

// Browser monitoring (CSP violation report sink + CRM client error reports)
const monitoringHandlers = require('./handlers/monitoring');
exports.cspReport = monitoringHandlers.cspReport;
exports.clientError = monitoringHandlers.clientError;

// ═══════════════════════════════════════════════════════════════
// PUSH NOTIFICATION FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const pushFunctions = require('./push-functions');
Object.assign(exports, pushFunctions);

// ═══════════════════════════════════════════════════════════════
// EMAIL FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const emailFunctions = require('./email-functions');
Object.assign(exports, emailFunctions);

// Public storm-history proxy for the /storm-report page (additive; no CRM coupling).
const stormReportFn = require('./storm-report');
Object.assign(exports, stormReportFn);

// Homeowner follow-up email when a /storm-report lead is captured (additive trigger).
const stormReportEmailFn = require('./storm-report-email');
Object.assign(exports, stormReportEmailFn);

// Text + email Joe the moment any public marketing lead lands (additive triggers).
const leadAlertFns = require('./lead-alert');
Object.assign(exports, leadAlertFns);

// Mirror each high-intent public lead into the tenant's CRM `leads` pipeline
// (Phase C, H-1 fix). Additive triggers; tenant-aware routing; idempotent.
const leadBridgeFns = require('./lead-bridge');
Object.assign(exports, leadBridgeFns);

// ═══════════════════════════════════════════════════════════════
// SMS FUNCTIONS
// ═══════════════════════════════════════════════════════════════
const smsFunctions = require('./sms-functions');
Object.assign(exports, smsFunctions);

// ═══════════════════════════════════════════════════════════════
// AUDIT LOG TRIGGERS (H-4)
// Loaded from a sibling module to keep index.js tractable.
// ═══════════════════════════════════════════════════════════════
const auditTriggers = require('./audit-triggers');
Object.assign(exports, auditTriggers);

// voiceConsumer — turns a completed call recording's structured summary into
// CRM actions (tasks / insurance backfill / red-flag denormalization). Idea #2.
const voiceConsumer = require('./voice-consumer');
Object.assign(exports, voiceConsumer);

// ═══════════════════════════════════════════════════════════════
// INTEGRATIONS — every adapter is a no-op when its secret is unset.
// Add more to functions/integrations/ and register them here.
// ═══════════════════════════════════════════════════════════════
const slackIntegration       = require('./integrations/slack');
const measurementIntegration = require('./integrations/measurement');
// Public estimate leads get their roof measured when the CRM lead is created
// (measureNewWebLead), and the anonymous wizard reads the homeowner-safe
// subset back (publicRoofMeasure — read-only, never spends).
const publicMeasureIntegration = require('./integrations/public-measure');
const parcelIntegration      = require('./integrations/parcel');
const hailIntegration        = require('./integrations/hail');
const calcomIntegration      = require('./integrations/calcom');
const hailCron               = require('./integrations/hail-cron');
const complianceIntegration  = require('./integrations/compliance');
const deviceAlertIntegration = require('./integrations/device-alert');
const emailQueueWorker       = require('./integrations/email-queue-worker');
const voiceMemoIntegration   = require('./integrations/voice-memo');
const voiceIntelligenceIntegration = require('./integrations/voice-intelligence');
// W129: NBD Whisper unified dictate (transcribe + clean/summarize/extract-tasks)
const dictateIntegration     = require('./dictate');
// Phase B.2 — Storm Briefing automation (rep-facing companion to the
// customer SMS pipeline). Fires once per unique alertId via Firestore
// trigger + atomic sentinel dedup. See functions/integrations/storm-
// briefing.js for the call-order scoring formula.
const stormBriefingIntegration = require('./integrations/storm-briefing');
// Thumbtack webhook receiver (leads / messages / reviews). One-way ingest —
// Thumbtack pushes, we cannot push back. Lead events land in thumbtack_leads
// and are mirrored into the CRM pipeline by leadBridgeThumbtack (lead-bridge.js).
const thumbtackIntegration   = require('./integrations/thumbtack');
// Thursday — the Bland AI receptionist on (513) 940-5589. Post-call webhook,
// the call-processing trigger (lead / task / notify), the live caller lookup
// her pathway calls, and the Thursday-inbox callables. See
// documentation/architecture/THURSDAY-BLAND-2026-09-26.md.
const thursdayIntegration    = require('./integrations/thursday');
Object.assign(exports, slackIntegration);
Object.assign(exports, measurementIntegration);
exports.measureNewWebLead = publicMeasureIntegration.measureNewWebLead;
exports.publicRoofMeasure = publicMeasureIntegration.publicRoofMeasure;
// 2026-10-04: auto-order the Instant Roofer measure when a CRM lead gets an
// appointment or reaches Inspected — once per lead, daily + monthly capped,
// feature_flags/global.autoMeasureDisabled stops it (integrations/measure-auto-order.js).
const measureAutoOrder = require('./integrations/measure-auto-order');
exports.autoMeasureOnStage = measureAutoOrder.autoMeasureOnStage;
exports.autoMeasureOnAppointment = measureAutoOrder.autoMeasureOnAppointment;
Object.assign(exports, parcelIntegration);
Object.assign(exports, hailIntegration);
Object.assign(exports, calcomIntegration);
Object.assign(exports, hailCron);
Object.assign(exports, complianceIntegration);
Object.assign(exports, deviceAlertIntegration);
Object.assign(exports, emailQueueWorker);
Object.assign(exports, voiceMemoIntegration);
Object.assign(exports, voiceIntelligenceIntegration);
Object.assign(exports, dictateIntegration);
Object.assign(exports, stormBriefingIntegration);
Object.assign(exports, thumbtackIntegration);
Object.assign(exports, thursdayIntegration);

// Swath (getSwathReport, getSwathUsage, swathWebhook) was removed
// 2026-10-04 — its key was never set (VENDOR-COST-LOCKIN Lane C).
// Retiring an export does NOT undeploy it: the three functions must be
// deleted by hand (gcloud functions delete … --region=us-central1).

// ═══════════════════════════════════════════════════════════════
// HOMEOWNER PORTAL (createPortalToken, revokePortalToken,
// getHomeownerPortalView) — extracted to functions/portal.js
// (L-03). portal.js is self-contained: it imports admin, secrets,
// and the rate-limit adapter directly. Loading + Object.assign here
// preserves the existing Firebase-deploy export shape, so no CI
// workflow change is needed.
// ═══════════════════════════════════════════════════════════════
const portalFunctions = require('./portal');
Object.assign(exports, portalFunctions);

// Signatures PR4/5: canvas remote signing (doc_sign_tokens + public
// homeowner endpoints). Same token-auth model as portal.js.
const remoteSigningFunctions = require('./remote-signing');
Object.assign(exports, remoteSigningFunctions);

// In-person signing (2026-10-03): the rep's doc viewer saves the signed
// contract from the browser, then calls this so the job spine moves the card
// to Contract Signed (and #2131 drafts the deposit invoice) — the same
// contract_signed path remote / e-sign / deal-room signing already take. The
// server re-reads the lead + document and refuses viewers, other companies'
// leads and unsigned documents. By name only: in-person-signing.js also
// exports _test. See functions/in-person-signing.js.
exports.recordInPersonSignature = require('./in-person-signing').recordInPersonSignature;

// PDF-native envelope signing: a rep uploads ANY PDF (supplier form,
// insurance scope, manufacturer warranty), places typed fields on it, and the
// homeowner completes it from a single-use link — pan/zoom on a real PDF, out
// comes a FLATTENED signed PDF. Same token model as remote-signing.js above,
// which it sits alongside rather than replaces: that path signs generated
// HTML and is the one the doc generator is wired to. See functions/
// esign-envelope.js and the pure stamping engine in functions/esign-stamp.js.
const esignEnvelopeFunctions = require('./esign-envelope');
Object.assign(exports, esignEnvelopeFunctions);
// 2026-10-04: BoldSign (integrations/esign.js — sendEstimateForSignature +
// esignWebhook) is retired. The estimate builder's "Send for signature" is
// sendEstimateEnvelope above; reminders + link expiry run here, daily.
exports.esignReminderSweep = require('./esign-reminders').esignReminderSweep;

// Close Board deal acceptance (1a): no-login remote accept of a shared deal
// room (deal_accept_tokens + /deal/<token> + /api/deal-accept). Same
// single-use token model as remote-signing.js. See functions/deal-acceptance.js.
const dealAcceptanceFunctions = require('./deal-acceptance');
Object.assign(exports, dealAcceptanceFunctions);

// Send for review / record the share / Fresh link (2026-10-03): the CRM mints
// the tracked link for an attached estimate PDF and Jo sends it from his own
// phone (share sheet). Nothing here texts or emails. See functions/estimate-send.js.
const estimateSend = require('./estimate-send');
exports.createEstimateReviewLink = estimateSend.createEstimateReviewLink;
exports.recordEstimateShared = estimateSend.recordEstimateShared;
exports.freshEstimateLink = estimateSend.freshEstimateLink;

// NBD CRM connection for the Grok Bot team (2026-10-02): MCP at /api/mcp with
// per-bot keys; bots read minimized CRM data and FILE notes / reminders /
// reports into the Agent inbox. See functions/agent-mcp.js.
const agentMcp = require('./agent-mcp');
exports.crmMcp = agentMcp.crmMcp;
exports.createAgentKey = agentMcp.createAgentKey;
exports.listAgentKeys = agentMcp.listAgentKeys;
exports.revokeAgentKey = agentMcp.revokeAgentKey;
// Settings → Bots & API (2026-10-04): any company on a paid plan makes its
// own bots; per-company on/off switch, timezone and house rules.
exports.saveAgentBot = agentMcp.saveAgentBot;
exports.deleteAgentBot = agentMcp.deleteAgentBot;
exports.saveAgentSettings = agentMcp.saveAgentSettings;

// Inspection report sharing: no-login homeowner view of a saved report
// (report_share_tokens + /report/<token>). View-only, reusable token model;
// reads the report HTML inline from /reports/<id> via admin SDK. See
// functions/report-sharing.js.
const reportSharingFunctions = require('./report-sharing');
Object.assign(exports, reportSharingFunctions);

// Read-only .ics calendar feed: one secret URL per rep
// (calendar_feed_tokens + /calendar/<token>.ics), subscribed once from the
// iPhone Calendar app and refreshed by iOS thereafter. No vendor, no secret.
// See functions/calendar-feed.js.
const calendarFeedFunctions = require('./calendar-feed');
Object.assign(exports, calendarFeedFunctions);

// Email unsubscribe (CAN-SPAM, 2026-09-22): public /unsubscribe/<token> page +
// RFC 8058 one-click POST (emailUnsubscribe), and the rep's "Mark
// unsubscribed" callable. Register + commercial-send gate live in
// functions/email-suppression.js. See functions/email-unsubscribe.js.
const emailUnsubscribeFunctions = require('./email-unsubscribe');
Object.assign(exports, emailUnsubscribeFunctions);

// Resend's own bounce / spam-complaint signal, folded into the same register
// (sources 'bounce' and 'complaint'). DARK until the owner adds the endpoint
// in the Resend dashboard and sets RESEND_WEBHOOK_SECRET — unconfigured, it
// refuses every request 503 before parsing anything.
const resendWebhookFunctions = require('./resend-webhook');
Object.assign(exports, resendWebhookFunctions);

// Generated-document read-back. Replaces the permanent getDownloadURL that
// document-generator.js used to persist as documents/{id}.htmlUrl — an
// unrevocable no-auth URL for a signed contract. Authed callable + admin-SDK
// read; see functions/document-view.js for why a signed URL is not the fix.
const documentViewFunctions = require('./document-view');
Object.assign(exports, documentViewFunctions);

// Lead-delete artifact reaping: hard-deleting a lead removed the Firestore doc
// and left its baked HTML live in Storage under a permanent download token
// (found 2026-08-18 — 10 orphans across portals/, documents/, galleries/).
// onDocumentDeleted sweeps every leadId-keyed prefix. See
// functions/lead-artifact-cleanup.js.
const leadArtifactCleanup = require('./lead-artifact-cleanup');
Object.assign(exports, leadArtifactCleanup);

// Same leak class, different prefix: `pdf-renders/{uid}/` accumulated every
// server-rendered invoice, contract and warranty forever, with no rule block
// and no reaper. 19 of 21 prod objects carried a permanent download token on
// 2026-09-08 and answered an unauthenticated GET. Deleting the object is the
// only real revocation, so retention IS the fix. See
// functions/pdf-render-retention.js for why this is a scheduled job rather
// than a bucket lifecycle rule.
const pdfRenderRetention = require('./pdf-render-retention');
exports.pdfRenderRetention = pdfRenderRetention.pdfRenderRetention;

// L-03 cont.: Stripe handlers (createCheckoutSession, stripeWebhook,
// createCustomerPortalSession, getSubscriptionStatus,
// createStripePaymentLink, invoiceWebhook) live in functions/stripe.js.
// Extracted verbatim; see `git log --follow functions/stripe.js`.
const stripeFunctions = require('./stripe');
Object.assign(exports, stripeFunctions);

// Stripe ledger (2026-09-29): every Stripe money movement recorded under the
// CRM customer it belongs to. Named exports only — the module also exports
// plain helpers (onEvent, used by invoiceWebhook) that are not functions.
const stripeLedger = require('./stripe-ledger');
exports.stripeLedgerSync        = stripeLedger.stripeLedgerSync;
exports.stripeLedgerReconcile   = stripeLedger.stripeLedgerReconcile;
exports.assignStripeTransaction = stripeLedger.assignStripeTransaction;
exports.getStripeOverview       = stripeLedger.getStripeOverview;

// Every charge gets a filed document (Jo's live-CRM handoff 2026-09-30 #7):
// NBD-500 invoice / NBD-510 receipt PDFs filed on the lead, and a Mark-Paid
// payoff marks the open Stripe invoice paid out of band. See money-paper.js.
exports.moneyPaperOnInvoice = require('./money-paper').moneyPaperOnInvoice;

// A customer can have more than one job (handoff 2026-09-30 #1), phase 1:
// mirror each lead's job fields into leads/{id}/jobs/{activeJobId}.
exports.jobsMirrorOnLead = require('./jobs-mirror').jobsMirrorOnLead;
// Stage 2b: a job changed → promote the next open job when the active one is done.
exports.jobsOnJobWrite = require('./jobs-mirror').jobsOnJobWrite;
// Today home (2026-10-03): a new lead task gets its lead's userId/companyId
// (the one collection-group task load filters on them).
exports.tasksStampOwner = require('./tasks-stamp').tasksStampOwner;

// Google Calendar sync (2026-09-29, calendar hub Phase 2): CRM jobs + adjuster
// meetings → an "NBD Jobs" calendar the service account owns and shares with
// Jo; free/busy for the double-booking warning. Inert until set up.
const googleCalendar = require('./google-calendar');
exports.setupGoogleCalendar     = googleCalendar.setupGoogleCalendar;
exports.getGoogleCalendarStatus = googleCalendar.getGoogleCalendarStatus;
exports.getBusyTimes            = googleCalendar.getBusyTimes;
exports.onLeadCalendarWrite     = googleCalendar.onLeadCalendarWrite;
exports.onJobCalendarWrite      = googleCalendar.onJobCalendarWrite;
exports.onYardSignCalendarWrite = googleCalendar.onYardSignCalendarWrite;
exports.onKnockCalendarWrite    = googleCalendar.onKnockCalendarWrite;
exports.googleCalendarReconcile = googleCalendar.googleCalendarReconcile;
// Production flow (2026-10-04): CRM-booked appointments + material deliveries
// → NBD Jobs; the weather.gov forecast for scheduled job days.
exports.onLeadEventCalendarWrite = googleCalendar.onLeadEventCalendarWrite;
exports.onOrderCalendarWrite     = googleCalendar.onOrderCalendarWrite;
exports.getJobWeather            = require('./job-weather').getJobWeather;

// Automated Firestore daily backup + retention. Needs a one-time bucket + IAM
// setup documented in functions/firestore-backup.js. Both are scheduled-only.
//
// 2026-09-03: that one-time setup had NEVER been done, so all three backup
// functions failed every night from the day they shipped — the bucket did not
// exist, and the runtime SA holds roles/editor, which deliberately excludes
// datastore.databases.export. Fixed (bucket created US multi-region to match
// the nam5 database; roles/datastore.importExportAdmin granted), and the first
// real export landed the same day.
const firestoreBackup = require('./firestore-backup');
Object.assign(exports, firestoreBackup);

// The alarm for the above. Deliberately a separate module rather than a
// section of healthDigestCron: the digest is gated on HEALTH_DIGEST_ENABLED,
// and an alarm a config flag can silently switch off is the bug, not the fix.
// It checks the `overall_export_metadata` ARTIFACT — the one
// firestore-backup.js's own comment says an operator should check, and none
// ever did — so it stays independent of whatever breaks next.
const backupFreshness = require('./backup-freshness');
Object.assign(exports, backupFreshness);

// Weekly backup of the config that lives only at a vendor (Bland "Thursday",
// Cal.com, BoldSign, Stripe catalog) into the private vendor-backups bucket.
// Vendor audit 2026-10-04 Lane B; runbook documentation/runbooks/BACKUP-RESTORE.md.
const vendorConfigExport = require('./vendor-config-export');
Object.assign(exports, vendorConfigExport);

// ── Verification Functions (SMS OTP + Lead Notifications) ──
const verifyFunctions = require('./verify-functions');
Object.assign(exports, verifyFunctions);

// ── Audit log triggers ──
const auditLog = require('./audit-log');
Object.assign(exports, auditLog);

// ═══════════════════════════════════════════════════════════════
// MIGRATIONS — versioned runner + scheduled tick
// see functions/migrations/runner.js
// ═══════════════════════════════════════════════════════════════
const _migrations = require('./migrations/runner');
exports.runMigrations  = _migrations.runMigrations;
exports.migrationsTick = _migrations.migrationsTick;

// ═══════════════════════════════════════════════════════════════
// IMAGE PIPELINE — Storage onObjectFinalized trigger that writes
// 200 / 600 / 1600 px WebP variants for every photo upload, then
// stamps the photo doc with `urls: { thumb, med, full }` so the
// CRM render code can switch on `<img srcset>`.
// see functions/image-pipeline.js
// ═══════════════════════════════════════════════════════════════
const _imagePipeline = require('./image-pipeline');
exports.onPhotoUploaded = _imagePipeline.onPhotoUploaded;
exports.onKnockCreated = _imagePipeline.onKnockCreated;

// ═══════════════════════════════════════════════════════════════
// SHARE SSR — server-rendered preview at /share/:token. Renders
// a static HTML page with og: + twitter: meta so iMessage /
// Messenger / WhatsApp / Facebook show a real preview card when
// Joe SMSes the link to a homeowner. Hands off to
// /pro/portal.html for the rich client-side full view.
// see functions/share-ssr.js
// ═══════════════════════════════════════════════════════════════
const _shareSSR = require('./share-ssr');
exports.shareSSR = _shareSSR.shareSSR;

// ═══════════════════════════════════════════════════════════════
// ABANDONED FUNNEL RECOVERY — /estimate partial-state + hourly sender
// ═══════════════════════════════════════════════════════════════
//
// Re-exports from functions/funnel-recovery.js:
//   - saveFunnelProgress (onRequest) — client saves partial state
//   - runAbandonRecovery (onSchedule) — hourly recovery email sender
//
// Ships DRY-RUN by default. Set FUNNEL_RECOVERY_ENABLED=true on the
// runAbandonRecovery Cloud Run revision to go live.
const funnelRecovery = require('./funnel-recovery');
exports.saveFunnelProgress = funnelRecovery.saveFunnelProgress;
exports.runAbandonRecovery = funnelRecovery.runAbandonRecovery;

// Daily 7am ET summary of the last 24h of public leads (functions/lead-digest.js).
exports.dailyLeadDigest = require('./lead-digest').dailyLeadDigest;

// Every-3h sweep: one follow-up email to 20-48h-old leads whose bridged CRM
// card is still untouched (functions/lead-followup.js).
exports.leadFollowUpSweep = require('./lead-followup').leadFollowUpSweep;

// ONE every-30-minutes storm poller (2026-10-04): the NWS storm-REPORTS watcher
// (storm-watch.js runStormWatch — alerts Joe; subscriber texts gated by
// STORM_TEXT_ENABLED) and the NWS ALERTS texter (sms-functions.js
// runCheckStormAlerts), back to back, same TCPA guards (storm-sms-guard.js).
// Replaces the separate stormWatch + checkStormAlerts crons.
exports.stormPoller = require('./storm-poller').stormPoller;

// A new lead created within 14 days of a stored storm report within 10 mi of
// its pin gets stormId 'storm-YYYY-MM-DD' (functions/storm-tag.js) — Reports'
// results per storm.
exports.stormTagOnLeadCreate = require('./storm-tag').stormTagOnLeadCreate;

// 1st-of-month 7am ET marketing rollup (functions/marketing-report.js).
exports.monthlyMarketingReport = require('./marketing-report').monthlyMarketingReport;

// ═══════════════════════════════════════════════════════════════
// ESTIMATE EMAIL — "Email My Estimate" homeowner copy
// ═══════════════════════════════════════════════════════════════
//
// Firestore trigger on estimate_leads: when the /estimate funnel saves
// a doc with type === 'email_estimate_request', emails the homeowner
// their estimate summary + a free-inspection CTA via Resend. NBD-only
// (non-NBD tenant leads are skipped); idempotent via a transactional
// estimateEmailedAt claim.
//
// LIVE by default (2026-07-18, after the #987 global daily cap).
// ESTIMATE_EMAIL_ENABLED=false forces DRY-RUN (emergency stop only —
// env vars on the revision are wiped by the next deploy).
const estimateEmailFn = require('./estimate-email');
exports.estimateEmail = estimateEmailFn.estimateEmail;

// ═══════════════════════════════════════════════════════════════
// WEEKLY DIGEST EMAIL — Wave 16
// ═══════════════════════════════════════════════════════════════
// Scheduled Mon 7am ET. Sends each rep a recap of the previous 7
// days (new leads, won deals + revenue, lost deals, active pipeline,
// top 5 new leads). Per-user opt-out via users/{uid}.
// weeklyDigestEnabled === false. E2E test accounts always skipped.
//
// Ships DRY-RUN by default. Set WEEKLY_DIGEST_ENABLED=true on the
// weeklyDigest Cloud Run revision to go live.
const weeklyDigest = require('./weekly-digest');
exports.weeklyDigest = weeklyDigest.weeklyDigest;

// ═══════════════════════════════════════════════════════════════
// DORMANT LEAD NUDGE — Wave 27
// ═══════════════════════════════════════════════════════════════
// Scheduled Wednesday 8am ET. Companion to weeklyDigest. Finds
// leads stuck >30 days at non-terminal stages and emails the rep
// a focused list with click-through links to each customer's page.
// Wednesday timing gives the rep two business days to act before
// the week's gone.
//
// Per-user opt-out via users/{uid}.dormantNudgeEnabled === false.
// E2E test accounts always skipped. Skipped when user has nothing
// dormant — empty inbox is not the goal.
//
// Ships DRY-RUN by default. Set DORMANT_NUDGE_ENABLED=true on the
// dormantLeadNudge Cloud Run revision to go live.
const dormantLeads = require('./dormant-leads');
exports.dormantLeadNudge = dormantLeads.dormantLeadNudge;

// ═══════════════════════════════════════════════════════════════
// PRINT RENDER ENGINE — server-side Puppeteer PDF generation
// ═══════════════════════════════════════════════════════════════
//
// D-1: Replaces every html2canvas+jsPDF "screenshot" PDF in the
// platform with real Chromium-rendered vector PDFs. One template
// registry, one shared design system, real PDF fonts, native page
// breaks, multi-page running headers/footers.
//
// Client calls `renderPdf({ template, payload, filename })` →
// returns `{ url, path, filename, bytes, timing }`. The URL is a
// signed Storage read URL good for 7 days.
//
// Templates whitelisted in functions/render-pdf.js TEMPLATES map.
// Pilot ships warranty; D-2..D-5 add inspection, estimate, photo
// report, invoice, contract, change order, receipt.
//
// Memory: 2GiB (Chromium needs real headroom for multi-page docs
// with photo galleries). This kept minInstances:1 to spare reps a
// cold start end-of-job; dropped to 0 on 2026-09-05 because that one
// warm 2GiB instance cost ~$17.92/mo. First render after an idle
// window is now ~10-20s instead of ~1.5s.
const renderPdfMod = require('./render-pdf');
exports.renderPdf = renderPdfMod.renderPdf;

// ═══════════════════════════════════════════════════════════════
// ANNIVERSARY AUTO-TOUCH — daily 1-year customer touch nudge
// ═══════════════════════════════════════════════════════════════
//
// Daily 8am Eastern scan for customers whose install anniversary
// falls in the 360-380 day window. Writes an `anniversary_due`
// activity row on each match (the CRM bell catches it regardless
// of email mode) and emails the owning rep a morning digest with
// a drop-in SMS script + deep links to each customer record.
//
// We don't auto-send to the homeowner — TCPA / CAN-SPAM compliance
// on a 1-year-later message is outside the original transaction's
// consent. Rep stays in the loop and taps one button in the CRM
// to send the touch.
//
// Idempotent: writes lead.anniversaryTouchedAt after each successful
// email send so manual re-runs don't double-touch.
//
// Per-user opt-out: users/{uid}.anniversaryTouchEnabled === false.
// Ships DRY-RUN by default. Set ANNIVERSARY_TOUCH_ENABLED=true
// on the anniversaryAutoTouch Cloud Run revision to go live.
const anniversaryTouch = require('./anniversary-touch');
exports.anniversaryAutoTouch = anniversaryTouch.anniversaryAutoTouch;

// ═══════════════════════════════════════════════════════════════
// LAPSE ENFORCEMENT — grace period → reversible seat pause
// ═══════════════════════════════════════════════════════════════
// Gauntlet batch 2 (2026-07-16): a cancelled subscription keeps the
// whole team working for LAPSE_GRACE_DAYS, then this daily cron pauses
// non-owner seats (Auth disabled + tokens revoked, member docs flagged
// deactivatedReason:'lapse'). Reactivation via a fresh checkout
// auto-restores exactly those seats (stripe.js webhook). Never deletes
// anything; the owner and all tenant data are untouched.
const lapseEnforcement = require('./lapse-enforcement');
exports.enforceLapsedSeats = lapseEnforcement.enforceLapsedSeats;

// ═══════════════════════════════════════════════════════════════
// REVIEW REQUEST NUDGE — daily post-win review-ask sweep
// ═══════════════════════════════════════════════════════════════
//
// Daily 8:15am Eastern scan (anniversary-touch skeleton) for jobs
// that entered a WON-role stage 3-21 days ago without a review
// request. Won detection is role-based (persisted stageRole → shared
// key map), so tenant custom stages count. Writes a
// `review_request_due` activity row + the same bell notification the
// client engine creates (deduped both ways), and emails the owning
// rep a morning digest with deep links.
//
// We don't auto-send to the homeowner — the rep taps the CRM's
// one-tap prefilled SMS/email (ReviewEngine), same human-in-the-loop
// posture as anniversaryAutoTouch.
//
// Idempotent: stamps lead.reviewNudgedAt in every mode (one nudge per
// lead, ever); skips leads the rep already asked (reviewRequested).
//
// Per-user opt-out: users/{uid}.reviewNudgeEnabled === false.
// Ships DRY-RUN by default. Set REVIEW_NUDGE_ENABLED=true on the
// reviewRequestNudge Cloud Run revision to go live.
exports.reviewRequestNudge = require('./review-request-nudge').reviewRequestNudge;

// ═══════════════════════════════════════════════════════════════
// MORNING BRIEF — 06:45 ET appointment brief for the owner
// ═══════════════════════════════════════════════════════════════
//
// One email to the platform owner (NBD_OWNER_UID) — never a homeowner —
// listing today's appointments (Cal.com bookings, job days incl. the middle
// days of multi-day projects, other jobs, adjuster meetings) with the CRM's
// property history: stage, job type, other jobs, last activity, open
// balance, storm history already on file. Nothing today → nothing sent.
//
// Per-user opt-out: users/{owner}.morningBriefEnabled === false.
// Ships DRY-RUN by default. Set MORNING_BRIEF_ENABLED=true on the
// morningBrief Cloud Run revision to go live.
exports.morningBrief = require('./morning-brief').morningBrief;

// "Brief me" (2026-10-04): one-tap pre-visit summary on the customer page —
// calls, promises, estimates, owed, photos, next appointment. Claude Haiku 4.5
// server-side only, cached per lead for 4 h (functions/lead-brief.js).
exports.leadBrief = require('./lead-brief').leadBrief;

// Nightly 02:30 ET: Haiku marks a call/text promise kept only on explicit,
// quoted later evidence; every change logged (functions/promise-cleanup.js).
// DRY-RUN unless PROMISE_CLEANUP_ENABLED=true.
exports.promiseCleanup = require('./promise-cleanup').promiseCleanup;

// ═══════════════════════════════════════════════════════════════
// CALL CENTER — Cube ACR recordings (Drive) → phone_calls, every 30 min
// ═══════════════════════════════════════════════════════════════
// Lists the "Cube ACR" folder Jo shared with the functions' service account,
// files each new recording on the owner tenant (lead matched by phone,
// bucketed customer / insurance / contact / unknown), audio into private
// Storage calls/{owner}/cube-acr/. Ships DRY-RUN (counts only) until
// CALL_CENTER_INGEST_ENABLED=true on the callCenterIngest revision.
exports.callCenterIngest = require('./call-center').callCenterIngest;
// Stage 2: Groq Whisper transcript + Claude Haiku notes (summary, promises,
// follow-up date) → customer timeline + one follow-up task. OFF unless
// CALL_CENTER_TRANSCRIBE_ENABLED=true, except the ids Jo lists on
// integrations/callCenter.transcribeOnly (the one-call test).
exports.callCenterTranscribe = require('./call-center').callCenterTranscribe;
// Stage 3: "you said you'd…" email to the owner at 07:15 + 15:15 ET (open
// promises from calls). DRY-RUN unless CALL_CENTER_SWEEP_ENABLED=true.
exports.callCenterSweep = require('./call-center').callCenterSweep;
// Every 2 hours, 8 AM-8 PM ET: anything new on the phone that needs Jo, and
// whether calls/transcripts/Thursday are keeping up (bell + push to Jo only).
// CALL_WATCH_ENABLED=true sends; otherwise it computes and logs.
exports.callWatch = require('./call-watch').callWatch;
// The Call Center screen's writes (handled / attach) — phone_calls is
// server-written only. Owner, admin, same-company admin/manager.
exports.callCenterAction = require('./call-center').callCenterAction;
// A call's follow-up task ticked anywhere → taskDone on the call, so a kept
// promise drops off "needs you" (Home, the Call Center, callWatch).
exports.onCallTaskWrite = require('./call-center').onCallTaskWrite;
// The Call Center "Said you'd do" deck: every open item the sweep email is
// built from, uncapped (owner / platform admin only).
exports.callPromisesList = require('./call-center').callPromisesList;
// "Match my tagged contacts": preview calls to "NBD Customer" phone contacts
// on no lead, then file only the rows the owner confirms (owner/admin only).
exports.callTaggedMatch = require('./call-center').callTaggedMatch;
// Optional game card (2026-10-03): level, XP and this week vs last week,
// derived on request from the caller's own records — nothing stored.
exports.getGameCard = require('./game').getGameCard;
// Text Inbox (Call Center stage 4): Jo's texts from the SMS Backup & Restore
// Drive backup → phone_texts (lead matched by phone, short codes never
// stored). DRY-RUN (counts) unless TEXT_INBOX_ENABLED=true.
exports.textInboxIngest = require('./text-inbox').textInboxIngest;
// Text notes: one AI note per settled conversation-day → phone_text_days,
// the customer timeline and a follow-up task; the sweep reads them too.
// DRY-RUN unless TEXT_NOTES_ENABLED=true.
exports.textInboxNotes = require('./text-inbox').textInboxNotes;

// ═══════════════════════════════════════════════════════════════
// REFERRAL CAPTURE — public POST from /refer.html
// ═══════════════════════════════════════════════════════════════
//
// Past customer shares a link (?ref=NBD-0001) with a friend; friend
// fills out /refer.html; this endpoint creates a new lead on the
// source customer's rep's book with referredByLeadId / customerId /
// Name fields populated, writes a `referral_sent` activity on the
// source customer's lead, and notifies the rep via /notifications.
//
// Anti-spam: per-IP rate limit (5/10min) and per-source-customer cap
// (10 referrals/24h). Phone+email validation; at least one required.
// No portal token needed — customerId is public and the friend self-
// identifies in the form.
const referrals = require('./referrals');
exports.submitReferral = referrals.submitReferral;

// Referral-link opens, counted per month for the owner's numbers (2026-10-04,
// functions/referral-clicks.js). POST { ref } from /pro/refer.html once per
// session; counter only — no lead lookup result is ever returned.
exports.referralLinkOpened = require('./referral-clicks').referralLinkOpened;

// Referral-CODE redemption + $100 bonus crediting on close. A single
// leads/{leadId} onWrite trigger: attributes a redeemed code to its referrer,
// then records the bonus as OWED when the referred project closes. Self-
// exports its trigger (literal onDocumentWritten for the CI allowlist), so
// merge the whole module — same pattern as lead-bridge above.
const referralRewards = require('./referral-rewards');
// Explicit (2026-09-30): the module now also exports `_internal` for tests,
// which must never become a deployed function group.
exports.onReferralLeadWrite = referralRewards.onReferralLeadWrite;
exports.onReferralJobWrite  = referralRewards.onReferralJobWrite;

// ═══════════════════════════════════════════════════════════════
// VISUALIZER IMAGE GENERATION — FLUX.1 Kontext via Replicate
// ═══════════════════════════════════════════════════════════════
//
// Real AI-edited image of the user's home (replaces the old canvas
// color-filter fake "visualization"). ~$0.04/img on flux-kontext-pro,
// ~$0.08 on flux-kontext-max (the default for shingle edits).
//
// Ships DISABLED by default. Set VISUALIZER_IMAGEGEN_ENABLED=true to go
// live; it needs the REPLICATE_API_TOKEN secret populated. (The kie.ai
// alternate provider was removed 2026-10-04.)
//
// CORRECTED 2026-09-05 — this block was wrong on all three counts. It
// named Gemini 2.5 Flash Image as the model, quoted ~$0.02-$0.04, and
// said the feature "requires the GOOGLE_AI_API_KEY secret populated
// first". Gemini was tried and abandoned the same day it was added
// (2026-04-18): it would not commit to material swaps, returning tinted
// asphalt for asphalt→metal. Nothing in functions/ declares
// GOOGLE_AI_API_KEY — no defineSecret() references it — and the
// only provider in visualizer-image-gen.js is Replicate, with no Gemini
// path at all. See that file's header for the full swap
// history; it is the source of truth for this feature.
const visualizerImageGen = require('./visualizer-image-gen');
exports.visualizerImageGen = visualizerImageGen.visualizerImageGen;

// ═══════════════════════════════════════════════════════════════
// GOOGLE REVIEWS — Places API proxy with 6-hour Firestore cache
// ═══════════════════════════════════════════════════════════════
//
// Public onRequest endpoint. Keeps the Places API key server-side,
// serves cached review data to /review and any embedded widgets.
// See functions/google-reviews.README.md for setup.
const googleReviews = require('./google-reviews');
exports.getGoogleReviews = googleReviews.getGoogleReviews;

// Daily all-reviews sync via the Business Profile API (dormant until the
// GBP_* secrets get real values — see google-reviews.README.md).
const gbpReviewsSync = require('./gbp-reviews-sync');
exports.syncGbpReviews = gbpReviewsSync.syncGbpReviews;

// Social Studio (2026-10-04) — the CRM's own social media system (replaces
// Metricool): drafts from finished jobs, Plan N weeks, approval through the
// privacy + Kentucky caption filter, the every-5-min publisher (Facebook /
// Instagram via Meta Graph; GBP stub behind SOCIAL_GBP_ENABLED; manual
// queue for the rest) and the public re-encoded media endpoint.
const socialStudio = require('./social-studio');
exports.socialEligibleJobs = socialStudio.socialEligibleJobs;
exports.socialDraftFromJob = socialStudio.socialDraftFromJob;
exports.socialPlanWeeks = socialStudio.socialPlanWeeks;
exports.socialApprovePost = socialStudio.socialApprovePost;
exports.socialPublisher = socialStudio.socialPublisher;
exports.socialMedia = socialStudio.socialMedia;

// Reel Studio (2026-10-04) — Social Studio's short-form video pipeline:
// phone/drone clip uploads (metadata-stripped transcode), data-driven
// templates rendered with ffmpeg-static on 2nd-gen functions, Whisper
// captions, the Claude-vision privacy frame check with confirm / auto-blur
// gating, rendered reels → Social Studio drafts, AI-graphic posts (tip /
// storm PSA only). functions/reel-studio.js.
const reelStudio = require('./reel-studio');
exports.reelStartUpload = reelStudio.reelStartUpload;
exports.reelJobMedia = reelStudio.reelJobMedia;
exports.reelCreate = reelStudio.reelCreate;
exports.reelConfirmPrivacy = reelStudio.reelConfirmPrivacy;
exports.reelApplyBlur = reelStudio.reelApplyBlur;
exports.reelRetry = reelStudio.reelRetry;
exports.reelToPosts = reelStudio.reelToPosts;
exports.reelAiImagePost = reelStudio.reelAiImagePost;
exports.reelRenderWorker = reelStudio.reelRenderWorker;
exports.reelIngestUpload = reelStudio.reelIngestUpload;
exports.reelCleanup = reelStudio.reelCleanup;

// Photo-vision classifier (Phase 3 of the photo system rebuild).
// Single-photo Claude Vision call with $10/lead + $50/uid-month caps
// and sha256(url) cache. Surfaces suggestions in photo.aiSuggestion
// for the Review UI (Phase 4) to render as 1-tap-accept chips.
const photoVision = require('./photo-vision');
exports.analyzePhotoVision = photoVision.analyzePhotoVision;
// 2026-10-04: the same classifier on EVERY created /photos doc (imported,
// drag-dropped, customer page) — not just the in-app camera's callable.
exports.onPhotoCreatedClassify = photoVision.onPhotoCreatedClassify;

// Receipt OCR (Phase 2 expense subsystem) — Claude-vision extraction of a
// receipt/invoice into structured fields the expense form pre-fills.
const receiptVision = require('./receipt-vision');
exports.extractReceiptData = receiptVision.extractReceiptData;

// Server-side plan-usage tracking (Audit A follow-up, Batch 3 of the
// audit-driven rollups). Closes the KNOWN GAP where client-side
// trackUsage in billing-gate.js silently 403'd because rules block
// client writes to subscriptions/{uid}. Now atomic + cross-device.
const billing = require('./billing');
exports.trackUsage = billing.trackUsage;

// Customer-side audit log (audit batch 7). Token-validated event
// capture so the rep can see exactly which photos / estimates the
// homeowner opened and when — useful at adjuster-dispute time.
const customerAudit = require('./customer-audit');
exports.recordCustomerEvent = customerAudit.recordCustomerEvent;
// idea #3 Phase 2: estimate_view audit event → real-time buying-intent strike
// pushed onto the owner's live notifications feed.
exports.onEstimateViewedStrike = customerAudit.onEstimateViewedStrike;

// Daily health digest email (audit batch 12). Aggregates Vision spend,
// Stripe webhook activity, Anthropic token usage, and homeowner-portal
// engagement; drops into email_queue → emailQueueWorker delivers.
// Gated on HEALTH_DIGEST_ENABLED env var ('true' to enable).
const healthDigest = require('./health-digest');
exports.healthDigestCron = healthDigest.healthDigestCron;

// Monthly per-tenant overhead spend digest — sums the prior month's
// OVERHEAD-type expenses per company and emails each owner a category
// breakdown via email_queue → emailQueueWorker. Enabled by default;
// MONTHLY_OVERHEAD_ALERT_DISABLED=true pauses without a rollback.
const monthlyOverheadAlert = require('./monthly-overhead-alert');
exports.monthlyOverheadAlertCron = monthlyOverheadAlert.monthlyOverheadAlertCron;

// Tenant-ready (2026-10-04): NBD Pro works for a new contractor without Jo.
// Server lead meter behind the plan lead cap (firestore.rules leadMeterOk).
const leadCap = require('./lead-cap');
exports.meterLeadCreate = leadCap.meterLeadCreate;
// Admin Tenants page, signup alert + welcome email, full company export,
// logo upload + its public first-party route (/tenant-logo/**).
const tenantOps = require('./tenant-ops');
exports.adminListTenants = tenantOps.adminListTenants;
exports.onCompanyCreated = tenantOps.onCompanyCreated;
exports.exportCompanyData = tenantOps.exportCompanyData;
exports.uploadCompanyLogo = tenantOps.uploadCompanyLogo;
exports.tenantLogo = tenantOps.tenantLogo;
