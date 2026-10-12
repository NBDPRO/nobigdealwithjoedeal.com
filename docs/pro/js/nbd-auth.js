/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
/**
 * NBD Pro — Centralized Auth & Access Control Module
 * ===================================================
 * Single source of truth for Firebase config, authentication,
 * subscription checking, and plan-based feature gating.
 *
 * USAGE (in any page):
 *   <script type="module">
 *     import { NBDAuth } from '/pro/js/nbd-auth.js';
 *     NBDAuth.init({ requiredPlan: 'starter' });
 *   </script>
 *
 * Plan hierarchy: free < starter < growth < enterprise
 * - free:    Daily Success (no login required), CRM Dashboard (free tier)
 * - starter: Daily Success (cloud), Project Codex, analytics
 * - growth:  AI Tree, AI Selection Codex, Understanding Tool, Ask Joe, Vault
 * Legacy keys (foundation/blueprint/professional) still exist in production
 * Firestore docs + Stripe metadata FOREVER; they resolve to the canonical
 * keys via PLAN_ALIASES at this read boundary.
 */

// ── Firebase SDK Imports ──────────────────────────────────
let __NBD_SENTRY_BOOTSTRAPPED; // module-local (globals Tranche 1 — was window.*)
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, initializeFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
// Audit #3: localhost-only emulator wiring. No-op in production.
import { connectEmulatorsIfLocal, isLocalEmulatorEnv, emulatorAppCheckFakeToken } from "./nbd-emulator-connect.js";

// ── Firebase Config (single source of truth) ─────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain:        "nobigdeal-pro.firebaseapp.com",
  projectId:         "nobigdeal-pro",
  storageBucket:     "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId:             "1:717435841570:web:c2338e11052c96fde02e7b"
};

// ── Sentry DSN (single source of truth) ──────────────────
// Shared across every page that imports this module, so observability
// is automatic instead of requiring a <script> tag on each HTML file.
// DSN is public per Sentry (origin identifier, not a secret). Set this
// once and every page auto-loads the browser SDK via sentry-init.js.
// Empty = no-op; __NBD_SENTRY_DSN on the window overrides for dev.
const DEFAULT_SENTRY_DSN = "";

// Bootstrap Sentry early — BEFORE Firebase init — so any error during
// config or auth also reaches Sentry. Load once per page; guarded.
(function _bootstrapSentry() {
  if (typeof window === 'undefined') return;
  if (__NBD_SENTRY_BOOTSTRAPPED) return;
  __NBD_SENTRY_BOOTSTRAPPED = true;
  if (!window.__NBD_SENTRY_DSN) window.__NBD_SENTRY_DSN = DEFAULT_SENTRY_DSN;
  // Idempotency: if the page already loaded sentry-init.js via a <script>
  // tag, NBDSentry exists and we skip re-loading.
  if (window.NBDSentry && window.NBDSentry.__sentinel === 'nbd-sentry-v1') return;
  try {
    const s = document.createElement('script');
    s.src = '/pro/js/sentry-init.js?v=2';
    s.async = true;
    document.head.appendChild(s);
  } catch (e) { /* non-fatal — error reporter failing to load is not an app-breaking event */ }
})();

// ── Plan Hierarchy ────────────────────────────────────────
// Internal plan-level keys are the CANONICAL pricing tiers: free ($0),
// starter ($99), growth ($299), enterprise (custom) — matching
// functions/stripe.js VALID_PLANS + functions/billing.js PLAN_LIMITS.
// 'lite' is a distinct internal state meaning "free because an
// access-code trial expired" — it is never written to Firestore; the
// trial-expiry branch below sets it in-memory so the dashboard can key
// trial-lapsed UX (banner, lead cap, pro-view gates) on it.
//
// Legacy keys — foundation (=starter), blueprint (=starter),
// professional (=growth) — live in production Firestore subscription
// docs and Stripe metadata FOREVER (access-code grants wrote them for
// years). They resolve to canonical exactly once, here, via
// PLAN_ALIASES. Without normalization a legacy "professional" doc would
// look up as PLAN_LEVELS['professional'] = undefined → 0 → gated at
// free tier — the exact upgrade-wall bug Joe kept seeing on his own
// admin account (historically with 'growth', same failure mode).
const PLAN_LEVELS = { free: 0, lite: 1, starter: 2, team: 3, growth: 4, enterprise: 5 };
const PLAN_ALIASES = {
  foundation:   'starter',
  blueprint:    'starter',
  professional: 'growth',
  // 'enterprise' stays itself — above growth in PLAN_LEVELS.
};
function _normalizePlan(raw) {
  const k = (raw || '').toLowerCase().trim();
  if (PLAN_ALIASES[k]) return PLAN_ALIASES[k];
  if (PLAN_LEVELS[k] !== undefined) return k;
  return 'free';
}

// ── Owner bypass ──────────────────────────────────────────
// Owner (root) status is claims-based: the { owner: true, role: 'admin' }
// custom claims minted server-side by the mintOwnerClaims callable
// (functions/handlers/auth.js) from the single server-side email list in
// functions/handlers/_shared.js OWNER_EMAILS.
//
// MINT TRIGGER ONLY — this list NEVER authorizes anything (2026-07-06,
// OWNER_EMAILS retirement; Jo's call: safe demotion). It exists solely
// to decide "should this session ask the server to mint the owner
// claim?" — mirroring the server's own security posture on
// mintOwnerClaims ("the email list never authorizes anything by itself
// here, it only selects who gets the claim"). Every access decision in
// this module (and in billing-gate.js / onboarding.js /
// real-deal-academy.js / dashboard-bootstrap, whose email fallbacks are
// deleted) keys on claims.owner === true. A founder account that
// somehow lacks the claim self-heals here: email match → mint → token
// refresh → claims re-read, all within this login (see the owner-mint
// block in the auth handler below). This is the LAST client copy of the
// founder emails; the authoritative list lives in
// functions/handlers/_shared.js OWNER_EMAILS (the mint source).
//
// PUBLIC-FILE HYGIENE (2026-07-30): this file is served unauthenticated at
// /pro/js/nbd-auth.js, so every address listed here is world-readable. The
// founder's PERSONAL gmail was removed for that reason; jd@ stays because it
// is already published in the sitewide schema.org JSON-LD, so it discloses
// nothing new. Tradeoff, deliberately accepted: the client-side self-heal
// (claim missing → ask server to mint) now only fires for the address below.
// The SERVER list in functions/handlers/_shared.js still contains BOTH, so a
// founder signing in with the personal gmail is still granted the claim once
// minted — they just can't trigger the mint from the browser. Recovery if the
// claim is ever lost on that account: mint it with the admin script runner.
// Do NOT re-add a personal address here to restore convenience.
const OWNER_EMAILS = new Set([
  'jd@nobigdealwithjoedeal.com'
]);

// ── Page → Required Plan Mapping ──────────────────────────
const PAGE_PLANS = {
  // Free — no auth required
  'daily-success':    'free',
  'demo':             'free',
  'landing':          'free',
  'login':            'free',
  'register':         'free',

  // Free — the dashboard IS the free-tier product (see the 2026-07-05
  // requiredPlan note in dashboard-auth-gate.module.js). This table is
  // currently only reachable via getPagePlan(), which has no callers —
  // kept accurate so a future caller doesn't resurrect the upgrade-wall
  // bug from a stale lookup.
  'dashboard':        'free',

  // Starter — requires login + active subscription
  'project-codex':    'starter',

  // Growth — requires login + growth plan
  'ai-tree':          'growth',
  'ai-tool-finder':   'growth',
  'understand':       'growth',
  'ask-joe':          'growth',
  'vault':            'growth',
  'analytics':        'starter',
  'leaderboard':      'starter',
  'diagnostic':       'starter',
  'features':         'starter',
};

// ── Feature Names (for upgrade wall) ──────────────────────
// Keys are the canonical PLAN_LEVELS identifiers; values are the
// customer-facing plan names from pricing.html. Legacy alias keys are
// kept so a raw legacy value that slips past normalization still
// displays as its canonical equivalent.
const PLAN_NAMES = {
  free:         'Free',
  lite:         'Free',
  starter:      'Starter',
  team:         'Team',
  growth:       'Growth',
  enterprise:   'Enterprise',
  // Legacy aliases (read-boundary defense — see PLAN_ALIASES):
  foundation:   'Starter',
  blueprint:    'Starter',
  professional: 'Growth'
};

const PLAN_FEATURES = {
  starter: [
    'CRM Dashboard with full pipeline management',
    'Daily Success with cloud sync & leaderboard',
    'Project Codex build tracking',
    'Storm intel map & estimate builder',
    'Analytics & diagnostic tools'
  ],
  growth: [
    'Everything in Starter, plus:',
    'AI Usability Tree — score & compare your tool stack',
    'AI Selection Codex — decision engine for AI tools',
    'Understanding Tool — deep-dive any software',
    'Ask Joe — AI-powered contractor coaching',
    'Priority support & early access to new features'
  ]
};

// ── Singleton State ───────────────────────────────────────
let _app = null;
let _auth = null;
let _db = null;
let _user = null;
let _subscription = null;
let _userPlan = 'free';
let _role = 'member';
let _claims = {}; // ID-token custom claims (owner/demo/role/companyId); {} when unread
let _initPromise = null;
let _options = {};
let _trialDaysLeft = -1; // -1 = no trial, 0+ = days remaining
let _isTrialUser = false;
// True only when we resolved a REAL trial end date (trialEndsAt, or
// currentPeriodEnd for a Stripe 'trialing' sub). Without this,
// isTrialExpired's `daysLeft <= 0` treated the -1 "unknown" sentinel as
// expired — a Stripe sub in an ACTIVE trial (status 'trialing', which the
// webhook writes verbatim, with no trialEndsAt) showed the "your trial has
// ended, you're on Free" banner to a card-backed paying trialer.
let _trialEndKnown = false;

// ── Core Module ───────────────────────────────────────────
export const NBDAuth = {

  // Expose Firebase instances for pages that need direct access
  get app()          { return _app; },
  get auth()         { return _auth; },
  get db()           { return _db; },
  get user()         { return _user; },
  get subscription() { return _subscription; },
  get userPlan()     { return _userPlan; },
  get role()         { return _role; },
  get isAdmin()      { return _role === 'admin'; },
  get isOwner()      {
    // Claim-only since the OWNER_EMAILS retirement (2026-07-06) — the
    // auth handler's owner-mint block already healed a missing claim
    // (mint + token re-read) before anything can call this getter.
    return _claims.owner === true;
  },
  get planLevel()    { return PLAN_LEVELS[_userPlan] || 0; },
  get trialDaysLeft(){ return _trialDaysLeft; },
  get isTrialUser()  { return _isTrialUser; },
  get isTrialExpired(){ return _isTrialUser && _trialEndKnown && _trialDaysLeft <= 0; },
  PLAN_LEVELS,
  PAGE_PLANS,
  PLAN_NAMES,
  PLAN_FEATURES,

  /**
   * Initialize auth system.
   * @param {Object} opts
   * @param {string} opts.requiredPlan - 'free' | 'starter' | 'growth' (legacy 'foundation'/'professional' accepted via PLAN_ALIASES)
   * @param {boolean} opts.requireAdmin - if true, also check for admin role
   * @param {string} opts.redirectLogin - where to redirect if not logged in (default: /pro/login.html)
   * @param {string} opts.redirectUpgrade - where to redirect for upgrades (default: shows wall)
   * @param {Function} opts.onReady - callback when auth resolves successfully
   * @param {Function} opts.onUpgradeNeeded - custom handler instead of default wall
   * @param {boolean} opts.showUpgradeWall - show built-in upgrade wall (default: true)
   */
  init(opts = {}) {
    if (_initPromise) return _initPromise;

    _options = {
      requiredPlan:    opts.requiredPlan || 'free',
      requireAdmin:    opts.requireAdmin || false,
      redirectLogin:   opts.redirectLogin || '/pro/login.html',
      redirectUpgrade: opts.redirectUpgrade || null,
      onReady:         opts.onReady || null,
      onUpgradeNeeded: opts.onUpgradeNeeded || null,
      showUpgradeWall: opts.showUpgradeWall !== false,
    };

    // Wave 120: ensure any error inside _initPromise un-hides the page.
    // The very first line of dashboard.html sets visibility:hidden, and
    // _showPage() (called inside the success branches below) is the only
    // path that sets it visible again. If a network glitch or thrown
    // error inside the auth callback leaves the promise rejected, the
    // page stays invisible forever — user reads it as "stuck loading."
    // Stash the inner promise so we can attach a fail-safe .catch() that
    // forces visibility:visible regardless of what threw.
    _initPromise = new Promise((resolve, reject) => {
      // Initialize Firebase
      _app = initializeApp(FIREBASE_CONFIG);
      _auth = getAuth(_app);
      // W159 P1: experimentalAutoDetectLongPolling didn't unblock the
      // user's mobile devices — health badge still pinned yellow.
      // experimentalForceLongPolling skips the WebChannel handshake
      // entirely and always uses HTTP long-polling, which works on
      // any network that can do plain HTTPS POST. Slightly higher
      // latency in steady state, but reliable across iOS Safari
      // background-tab throttling, Android battery optimisations,
      // restrictive corporate / school WiFi, and mobile-carrier MITM
      // proxies that drop long-lived sockets.
      // Must run BEFORE the first getFirestore(app) call on this app —
      // NBDAuth.init() runs synchronously from dashboard.html's first
      // module script, before the second module script's
      // getFirestore(app) at line ~359, so this is the right place.
      try {
        _db = initializeFirestore(_app, { experimentalForceLongPolling: true });
      } catch (e) {
        // initializeFirestore throws if Firestore was already
        // initialized on this app (e.g. a hot-reload). Fall back to
        // the existing instance so we don't crash the auth gate.
        console.warn('[nbd-auth] initializeFirestore failed, using existing:', e && e.message);
        _db = getFirestore(_app);
      }

      // Audit #3: when served from localhost, point auth+firestore at the
      // local emulators BEFORE the first read (which only happens inside the
      // async onAuthStateChanged callback below — strictly later than this
      // microtask). No-op on any non-localhost host. Promise is parked on
      // window so other modules can await emulator-readiness if they need to.
      window.__NBD_EMU_READY = connectEmulatorsIfLocal({ auth: _auth, db: _db });

      // ── App Check (reCAPTCHA v3) ────────────────────────
      // The site key is set by the host page via a top-of-<head>
      // <script> that assigns window.__NBD_APP_CHECK_KEY. The key is
      // per-origin and safe to ship in HTML; reCAPTCHA validates it
      // against the registered domain list. When the key is empty we
      // skip init so dev/local still works — but every Cloud Function
      // with `enforceAppCheck: true` will reject those calls in prod,
      // so this warning is load-bearing. Only initialize once per
      // page; initializeAppCheck throws on repeat calls.
      try {
        const appCheckKey = (typeof window !== 'undefined' && window.__NBD_APP_CHECK_KEY || '').trim();
        if (isLocalEmulatorEnv() && !window.__NBD_APP_CHECK_INITIALIZED) {
          // Emulator rig: enforced callables still demand a decodable App
          // Check JWT; reCAPTCHA can't mint one off the registered origin.
          // Sync init so no callable races ahead of the shim.
          // Expose instance so NBDComms / claude-proxy can attach App Check headers.
          window.__NBD_APP_CHECK = initializeAppCheck(_app, {
            provider: new CustomProvider({ getToken: async () => emulatorAppCheckFakeToken() }),
            isTokenAutoRefreshEnabled: false
          });
          window.__NBD_APP_CHECK_INITIALIZED = true;
        } else if (appCheckKey && !window.__NBD_APP_CHECK_INITIALIZED) {
          window.__NBD_APP_CHECK = initializeAppCheck(_app, {
            provider: new ReCaptchaEnterpriseProvider(appCheckKey),
            isTokenAutoRefreshEnabled: true
          });
          window.__NBD_APP_CHECK_INITIALIZED = true;
        } else if (!appCheckKey) {
          console.warn('[nbd-auth] App Check not configured — window.__NBD_APP_CHECK_KEY empty. Cloud Functions with enforceAppCheck:true WILL reject these calls once enforcement is live.');
        }
      } catch (e) {
        console.error('[nbd-auth] App Check init failed:', e);
      }

      // Expose on window for legacy pages
      window._auth = _auth;
      window._db = _db;
      window._firebaseApp = _app;

      // iOS Safari (and Firefox in some configurations) restore the
      // Firebase auth session from IndexedDB asynchronously. The very
      // first onAuthStateChanged callback can fire with user=null
      // BEFORE the cached session is restored — typically within
      // 200–1500 ms the second callback arrives with the real user.
      // Without a grace window, nbd-auth was redirecting to login on
      // the first null tick, kicking already-signed-in users out of
      // the CRM (e.g. tapping "Back to Dashboard" from customer.html
      // landed on the login screen). Skip the redirect for the first
      // null tick if Firebase tells us a restore is in progress, and
      // give the SDK up to ~2.5 s to settle before deciding the user
      // really isn't logged in.
      let _firstNullSeenAt = 0;
      const REDIRECT_GRACE_MS = 2500;
      onAuthStateChanged(_auth, async (user) => {
        if (!user) {
          // No user logged in
          if (_options.requiredPlan === 'free') {
            // Free pages don't need login
            _user = null;
            _claims = {};
            _userPlan = 'free';
            _exposeGlobals();
            if (_options.onReady) _options.onReady(null);
            resolve(null);
            return;
          }
          // Grace-period defense against the iOS auth-restore race.
          const now = Date.now();
          if (!_firstNullSeenAt) {
            _firstNullSeenAt = now;
            // Wait the grace window. If the SDK then reports a real
            // user via a second callback, that callback wins (this
            // branch will simply not fire again with null). If the
            // null persists past the grace window, then truly logged
            // out — redirect.
            setTimeout(() => {
              if (!_auth.currentUser) {
                window.location.replace(_options.redirectLogin);
              }
            }, REDIRECT_GRACE_MS);
            return;
          }
          // Subsequent null callbacks after the grace window: redirect.
          if (now - _firstNullSeenAt >= REDIRECT_GRACE_MS) {
            window.location.replace(_options.redirectLogin);
          }
          return;
        }
        // Reset the grace tracker once we've seen a real user — covers
        // the rare case of sign-out during an active session.
        _firstNullSeenAt = 0;

        _user = user;
        window._user = user;

        // ── Token claims (single read for owner/demo/role/companyId) ──
        // 4-second timeout: getIdTokenResult() makes a network round-trip
        // to refresh the ID token. On iOS Safari with poor connectivity
        // this call can hang indefinitely, keeping the page invisible
        // (visibility:hidden) until the network stack times out (~60s).
        // Racing against a 4s resolve (not reject) means we proceed with
        // empty claims on timeout — for founder accounts the owner-mint
        // block below re-reads the claims (time-bounded) so a timed-out
        // first read still resolves to the owner claim; everyone else
        // proceeds to the subscription check, which grants the correct
        // plan from Firestore.
        _claims = {};
        try {
          const tokenResult = await Promise.race([
            user.getIdTokenResult(),
            new Promise(resolve => setTimeout(resolve, 4000))
          ]);
          _claims = (tokenResult && tokenResult.claims) || {};
        } catch (e) {
          // Claims read failure → fall back to the email checks below.
          console.warn('Could not read ID token claims:', e.message);
        }

        // ── Owner bypass ──
        // Short-circuit plan/role resolution for the founder/staff
        // accounts. Keyed on the { owner: true } custom claim (minted
        // server-side by mintOwnerClaims) — the claim is the ONLY
        // authorizer since the OWNER_EMAILS retirement (2026-07-06).
        // This fixes the case where Joe signs in as admin but the UI
        // says "upgrade to use some features" because the
        // subscriptions/ doc is missing, stale, or unreadable. No
        // Firestore round-trip = no fail-closed to 'free' for the only
        // account that can never be on a plan.
        //
        // Self-heal (the no-lockout half of the retirement): when the
        // email matches the mint-trigger list but the claim isn't on
        // the token — first login before minting, or the 4s claims-read
        // timeout above left _claims empty — ask the server to mint,
        // then re-read the claims ONCE, all time-bounded so a slow
        // network can't hang the page. The re-read turns both cases
        // into claims.owner === true within this same login; if it
        // still isn't (mint refused/failed), this session resolves like
        // any other user and heals on the next login instead.
        const emailLower = (user.email || '').trim().toLowerCase();
        let _ownerClaim = _claims.owner === true;
        if (!_ownerClaim && emailLower && OWNER_EMAILS.has(emailLower)) {
          try {
            await Promise.race([
              _requestOwnerClaimMint(user),
              new Promise(resolve => setTimeout(resolve, 6000))
            ]);
            const reread = await Promise.race([
              user.getIdTokenResult(),
              new Promise(resolve => setTimeout(resolve, 4000))
            ]);
            if (reread && reread.claims) _claims = reread.claims;
          } catch (_) { /* claim absent this session — heals next login */ }
          _ownerClaim = _claims.owner === true;
        }
        if (_ownerClaim) {
          // Note: assignment order is deliberate — the H-02 smoke test
          // guards against `_role = 'admin'` being followed immediately
          // by a `_subscription = { plan: ...` assignment, which was
          // the signature of the old email-literal demo-admin bypass.
          // Setting the subscription (and plan) before the role keeps
          // this owner path structurally distinct from that footgun.
          _subscription = { plan: 'growth', status: 'active', _owner: true };
          _userPlan = 'growth';
          _role = 'admin';
          _exposeGlobals();
          _showPage();
          if (_options.onReady) _options.onReady(user);
          resolve(user);
          return;
        }

        // H-02: demo bypass is keyed on a `demo:true` custom claim,
        // not a hardcoded email literal. The old code let anyone who
        // compromised the hardcoded demo inbox (or ever gains
        // control of that address) appear to the client as
        // `_role === 'admin'`, unlocking admin-only UI. The new
        // behaviour:
        //   - demo:true claim holders get growth-tier features
        //   - _role is fixed at 'demo_viewer' — NEVER 'admin', so no
        //     admin screens render even if an admin-only page is
        //     visited directly
        //   - provisioning is one-off via scripts/grant-demo-claim.js
        const demoClaim = _claims.demo === true;
        const _claimRole = _claims.role || null; // F4: team-role from custom claim (fallback for client _role)
        const _claimCompanyId = _claims.companyId || null; // Pillar 4: billing resolves from the company's subscription

        if (demoClaim) {
          _userPlan = 'growth';
          _role = 'demo_viewer';
          _subscription = { plan: 'growth', status: 'active', _demo: true };
          _exposeGlobals();
          _showPage();
          if (_options.onReady) _options.onReady(user);
          resolve(user);
          return;
        }

        // Fetch user doc for role — 5s timeout so a Firestore hang
        // doesn't keep the page invisible (visibility:hidden) indefinitely.
        try {
          const userSnap = await Promise.race([
            getDoc(doc(_db, 'users', user.uid)),
            new Promise(resolve => setTimeout(resolve, 5000))
          ]);
          if (userSnap.exists()) {
            const userData = userSnap.data();
            _role = userData.role || _claimRole || 'member';
          } else if (_claimRole) {
            // F4: team members provisioned via createTeamMember get a custom-claim
            // role but no users/{uid}.role doc; fall back to the claim so window._role
            // reflects company_admin/manager/sales_rep/viewer for client UI gates.
            _role = _claimRole;
          }
        } catch (e) {
          console.warn('Could not fetch user doc:', e.message);
        }

        // Admin check
        if (_options.requireAdmin && _role !== 'admin') {
          window.location.replace(_options.redirectLogin + '?error=admin_required');
          return;
        }

        // Fetch subscription — 5s timeout (same rationale as user doc above).
        // Pillar 4: billing is company-level. The sub doc is keyed by the
        // OWNER's uid (== the companyId claim a team member carries), so a
        // rep resolves their company's plan instead of a phantom 'free'
        // under their own uid. Solo owners: companyId == uid, no change.
        // If the claims read above timed out, fall back to uid (old path).
        try {
          const subSnap = await Promise.race([
            getDoc(doc(_db, 'subscriptions', _claimCompanyId || user.uid)),
            new Promise(resolve => setTimeout(resolve, 5000))
          ]);
          if (subSnap.exists()) {
            _subscription = subSnap.data();
            // Stripe's standard "active" states are 'active' AND 'trialing'.
            // Previously only 'active' was honoured — every user inside
            // their 14-day trial window (the typical Stripe state during
            // trial) silently downgraded to 'free' the moment they
            // logged in. Trial users got locked out of Pro features
            // with no upgrade-flow surfacing. Now both states resolve
            // to the paid plan; the trialEndsAt check below still
            // downgrades to lite once the trial actually expires.
            const _isActiveStatus = _subscription.status === 'active'
              || _subscription.status === 'trialing';
            if (_isActiveStatus) {
              _userPlan = _normalizePlan(_subscription.plan || 'starter');

              // ── Trial expiration check ──
              // Mark trial users explicitly when status === 'trialing'
              // even if no trialEndsAt is set — billing-gate.js reads
              // _isTrialUser to drive the trial banner / countdown UI,
              // and we don't want to lose that signal just because a
              // trialing-state doc happens not to carry the timestamp.
              if (_subscription.status === 'trialing') {
                _isTrialUser = true;
              }
              // trialEndsAt has exactly ONE writer: validateAccessCode
              // (functions/handlers/portal.js) — Stripe trials never carry
              // it (the webhook writes status 'trialing' + currentPeriodEnd
              // instead). So the downgrade below only ever fires for
              // access-code trials, matching the read-time expiry gates in
              // functions/billing.js and billing-gate.js. If the Stripe
              // webhook ever starts writing trialEndsAt, scope this to
              // source === 'access_code' or converted subs will downgrade.
              if (_subscription.trialEndsAt) {
                const trialEnd = _subscription.trialEndsAt.toDate ? _subscription.trialEndsAt.toDate() : new Date(_subscription.trialEndsAt);
                const now = new Date();
                const msLeft = trialEnd.getTime() - now.getTime();
                _trialDaysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
                _isTrialUser = true;
                _trialEndKnown = true;

                if (_trialDaysLeft <= 0) {
                  // Trial expired — downgrade to 'lite', the internal
                  // "free because the trial ended" state (see the
                  // PLAN_LEVELS comment). Kept distinct from 'free' so
                  // dashboard-bootstrap / dashboard-actions can key
                  // trial-lapsed UX on it. Never persisted to Firestore.
                  _userPlan = 'lite';
                  _subscription = { ..._subscription, _trialExpired: true };
                  console.info('Trial expired — downgraded to lite');
                }
              } else if (_subscription.status === 'trialing' && _subscription.currentPeriodEnd) {
                // Stripe trial: the trial end IS the current period end
                // (Stripe reports trial_end == current_period_end while
                // trialing). Gives the countdown banner a real number —
                // without this, trialDaysLeft stayed at the -1 sentinel and
                // the banner either showed nothing or (pre-_trialEndKnown)
                // falsely said the trial had ended. NO plan downgrade here:
                // Stripe owns that lifecycle via webhook status changes.
                const periodEnd = new Date(_subscription.currentPeriodEnd);
                if (!Number.isNaN(periodEnd.getTime())) {
                  _trialDaysLeft = Math.ceil((periodEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                  _trialEndKnown = true;
                }
              }
            } else {
              _userPlan = 'free';
              _subscription = { ..._subscription, _inactive: true };
            }
          } else {
            // No subscription doc — treat as free
            _userPlan = 'free';
            _subscription = null;
          }
        } catch (e) {
          // H-03: fail CLOSED on network error. Previously the catch
          // branch honored a `localStorage.nbd_user_plan` cache and
          // flipped _failOpen:true — which meant any user who ever
          // had a paid plan (or who manually set the key) kept
          // premium-tier UI when the subscription read failed. That's
          // the definition of fail-open; renaming the flag didn't
          // change the behaviour. Network errors now hard-drop to
          // 'free' every time.
          console.warn('Subscription check failed — failing closed to free:', e.message);
          _userPlan = 'free';
          _subscription = { plan: 'free', status: 'network_error', _failOpen: false };
        }

        // H-03: do NOT persist plan in localStorage. The value is
        // derived on every auth-state change from the server-owned
        // subscriptions doc; caching it only re-creates the fail-open
        // attack surface above. logout() clears any stale entry.

        // Plan check. requiredPlan is normalized so pages that still
        // pass a legacy key ('foundation'/'professional') gate at the
        // correct canonical level instead of undefined → 0 → open.
        const requiredLevel = PLAN_LEVELS[_normalizePlan(_options.requiredPlan)] || 0;
        const userLevel = PLAN_LEVELS[_userPlan] || 0;

        if (userLevel < requiredLevel) {
          // User doesn't have sufficient plan
          if (_options.onUpgradeNeeded) {
            _options.onUpgradeNeeded(_userPlan, _options.requiredPlan);
          } else if (_options.redirectUpgrade) {
            window.location.replace(_options.redirectUpgrade);
          } else if (_options.showUpgradeWall) {
            NBDAuth.showUpgradeWall(_options.requiredPlan);
          }
          resolve(user); // still resolve — page can handle the wall
          return;
        }

        // All checks passed
        _exposeGlobals();
        _showPage();
        if (_options.onReady) _options.onReady(user);
        resolve(user);
      });
    });

    // Wave 120: fail-safe catch — any unhandled throw inside the auth
    // promise (App Check init throw, getDoc rejection, etc.) MUST still
    // un-hide the page. Without this, the page stays at
    // visibility:hidden forever and the user sees a permanent blank
    // screen — the "stuck loading" pattern they reported.
    //
    // v159.6: also push the rejection reason to window.__nbdLoadErrors
    // so it surfaces in the dashboard's diagnostic banner. Up to v159.5
    // this rejection only logged to console — invisible to users on
    // mobile without a dev-tools attachment, which is the only place
    // we've been able to reproduce the bug. The user-visible banner is
    // currently our only ground-truth channel.
    _initPromise.catch((err) => {
      console.error('[nbd-auth] init promise rejected:', err);
      try {
        if (typeof window !== 'undefined' && window.__nbdLoadErrors) {
          var msg = (err && (err.message || err.code)) || String(err);
          if (window.__nbdLoadErrors.length < 8) {
            window.__nbdLoadErrors.push('NBDAuth-reject: ' + msg);
          }
        }
      } catch (_) {}
      try { _showPage(); } catch (_) {}
    });

    return _initPromise;
  },

  /**
   * Check if user has access to a specific plan level.
   * Owner accounts always return true — they bypass plan gates.
   * Owner = { owner: true } claim only (OWNER_EMAILS retired 2026-07-06;
   * the list survives solely as the mint trigger — see its comment).
   */
  hasAccess(plan) {
    if (_claims.owner === true) return true;
    // Normalize the requested plan so legacy callers (e.g. academy
    // course tiers passing 'foundation') resolve to the canonical
    // level. Unknown values normalize to 'free' (level 0) — same
    // permissive fallback as the old `PLAN_LEVELS[plan] || 0`.
    return (PLAN_LEVELS[_userPlan] || 0) >= (PLAN_LEVELS[_normalizePlan(plan)] || 0);
  },

  /**
   * Get the required plan for a page slug
   */
  getPagePlan(slug) {
    return PAGE_PLANS[slug] || 'starter';
  },

  /**
   * Clear NBD app/account data from localStorage so a shared device doesn't
   * leave the previous rep's cached config, filters, company profile, or usage
   * tallies for the next user. Device-level UI prefs (theme/font/motion/
   * onboarding/kanban) are deliberately preserved. Exposed as a method so the
   * auth observer can also run it on an ACCOUNT SWITCH — historically every
   * sign-out control called the raw signOut() and never logout(), so this purge
   * never ran (prior rep's customer PII lingered for the next user).
   */
  purgeAccountStorage() {
    try {
      const KEEP = new Set([
        'nbd-theme', 'nbd_theme', 'nbd_custom_theme', 'nbd-theme-sound',
        'nbd-font', 'nbd_font', 'nbd_motion', 'nbd_auto_theme', 'ds-theme',
        'nbd_ds_config', 'nbd-crm-autocollapse', 'nbd_kanban_view',
        'nbd-onboarding-complete', 'nbd_maps_redirect_seen',
        'nbd_draw_hint_shown', 'nbd_notif_settings', 'cmd-recents',
        'nbd_last_uid',
      ]);
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && !KEEP.has(k) && /^(nbd[_-]|nav-)/.test(k)) drop.push(k);
      }
      drop.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* best-effort; never block on a storage error */ }
    // The offline SMS outbox holds homeowner phone numbers and message text
    // in IndexedDB until they are sent (docs/pro/js/sms-outbox.js). Same
    // shared-device rule as the keys above: gone on sign-out and on account
    // switch. Returned so logout() can wait for it; other callers need not.
    return NBDAuth.purgeSmsOutbox();
  },

  /**
   * Delete every queued text on this device (all accounts) — every phone
   * number and message. Uses the outbox module when this page loaded it (it
   * also clears the tray), otherwise opens its database directly — a page
   * that never loaded the outbox can still be holding one from an earlier
   * page. Either way RECEIPTS of texts that already went (ids only: no
   * number, no message) are kept, so the same rep's invoice / deal / share is
   * still stamped after they sign back in (sms-outbox.js purgeAll — the same
   * rule, _isPiiFreeReceipt). Resolves true/false, never rejects, and gives
   * up after 2s so a blocked purge cannot stall sign-out.
   */
  purgeSmsOutbox() {
    const keep = (x) => !!x && typeof x.source === 'string' && !!x.source
      && typeof x.sourceRef === 'string' && !!x.sourceRef
      && (x.status === 'sent' || x.status === 'acking') && !x.to && !x.toDigits && !x.body;
    const work = new Promise((resolve) => {
      try {
        const ob = window.NBDSmsOutbox;
        if (ob && typeof ob.purgeAll === 'function') {
          Promise.resolve(ob.purgeAll()).then((ok) => resolve(!!ok), () => resolve(false));
          return;
        }
        const idb = window.indexedDB;
        if (!idb || typeof idb.open !== 'function') { resolve(true); return; }
        let created = false;
        const req = idb.open('nbd-sms-outbox-db', 1);
        req.onupgradeneeded = (e) => {
          // No outbox database on this device: nothing to purge. Abort the
          // upgrade so looking does not leave an empty database behind.
          created = true;
          try { e.target.transaction.abort(); } catch (_) {}
        };
        req.onsuccess = () => {
          const db = req.result;
          const close = () => { try { db.close(); } catch (_) {} };
          if (created || !db.objectStoreNames.contains('outbox')) { close(); resolve(true); return; }
          let tx;
          try { tx = db.transaction('outbox', 'readwrite'); } catch (_) { close(); resolve(false); return; }
          const store = tx.objectStore('outbox');
          const all = store.getAll();
          all.onsuccess = () => {
            (Array.isArray(all.result) ? all.result : []).forEach((x) => {
              if (x && x.id != null && !keep(x)) store.delete(x.id);
            });
          };
          tx.oncomplete = () => { close(); resolve(true); };
          tx.onabort = () => { close(); resolve(false); };
        };
        // An aborted first-time open (nothing existed) lands here too.
        req.onerror = () => resolve(created);
        req.onblocked = () => resolve(false);
      } catch (_) { resolve(false); }
    });
    const cap = new Promise((resolve) => setTimeout(() => resolve(false), 2000));
    return Promise.race([work, cap]);
  },

  /**
   * Sign out and redirect
   */
  async logout(redirect = '/pro/login.html') {
    // Awaited (bounded inside) so the queued-text purge finishes before the
    // navigation below can cut its IndexedDB transaction off.
    try { await this.purgeAccountStorage(); } catch (_) {}
    try {
      await signOut(_auth);
    } catch(e) { console.warn('Logout error:', e.message); }
    window.location.replace(redirect);
  },

  /**
   * Show the upgrade wall overlay
   */
  showUpgradeWall(requiredPlan) {
    // Don't double-inject
    if (document.getElementById('nbd-upgrade-wall')) return;

    // Resolve legacy aliases so the wall (and the checkout button's
    // data-na-id, which feeds StripeBilling.checkout) always carries a
    // canonical plan key.
    requiredPlan = _normalizePlan(requiredPlan);
    const planName = PLAN_NAMES[requiredPlan] || requiredPlan;
    const features = PLAN_FEATURES[requiredPlan] || [];
    const currentName = PLAN_NAMES[_userPlan] || 'Free';

    const wall = document.createElement('div');
    wall.id = 'nbd-upgrade-wall';
    wall.innerHTML = `
      <style>
        #nbd-upgrade-wall {
          position: fixed; top:0;right:0;bottom:0;left:0; z-index: 99999;
          background: rgba(5,6,8,0.92);
          -webkit-backdrop-filter:blur(20px);backdrop-filter: blur(12px);
          display: flex; align-items: center; justify-content: center;
          font-family: 'Barlow', 'DM Sans', -apple-system, sans-serif;
          animation: nbdWallIn .3s ease both;
        }
        @keyframes nbdWallIn { from { opacity:0 } to { opacity:1 } }
        .nbd-wall-card {
          background: #0D1117;
          border: 1px solid rgba(189,87,40,0.3);
          border-radius: 16px;
          padding: 48px 44px;
          max-width: 520px; width: 90%;
          text-align: center;
          box-shadow: 0 32px 80px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.04);
          position: relative;
          overflow: hidden;
        }
        .nbd-wall-card::before {
          content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
          background: linear-gradient(90deg, transparent, #BD5728, transparent);
        }
        .nbd-wall-badge {
          display: inline-flex; align-items: center; gap: 8px;
          background: rgba(189,87,40,0.1); border: 1px solid rgba(189,87,40,0.25);
          color: var(--orange,#BD5728); font-size: 10px; font-weight: 700;
          letter-spacing: 3px; text-transform: uppercase;
          padding: 7px 18px; border-radius: 20px; margin-bottom: 20px;
        }
        .nbd-wall-title {
          font-family: 'Bebas Neue', 'Barlow Condensed', sans-serif;
          font-size: 42px; letter-spacing: 2px; line-height: .95;
          color: #f0f6fc; margin-bottom: 12px;
        }
        .nbd-wall-sub {
          font-size: 15px; color: #8b9bb4; line-height: 1.7; margin-bottom: 28px;
        }
        .nbd-wall-features {
          text-align: left; margin-bottom: 32px; padding: 0 16px;
        }
        .nbd-wall-features li {
          display: flex; align-items: flex-start; gap: 10px;
          font-size: 13px; color: #c8d3e0; line-height: 1.6;
          margin-bottom: 8px; list-style: none;
        }
        .nbd-wall-features li::before {
          content: '›'; color: var(--orange,#BD5728); font-weight: 700; font-size: 16px;
          flex-shrink: 0; line-height: 1.3;
        }
        .nbd-wall-btns { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
        .nbd-wall-btn {
          padding: 14px 28px; border-radius: 6px; font-weight: 800;
          font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase;
          text-decoration: none; cursor: pointer; border: none; transition: .2s;
          font-family: 'Barlow', sans-serif;
        }
        .nbd-wall-btn.primary {
          background: var(--orange,#BD5728); color: #fff;
        }
        .nbd-wall-btn.primary:hover { background: #a14a22; transform: translateY(-1px); }
        .nbd-wall-btn.secondary {
          background: transparent; color: #8b9bb4;
          border: 1px solid rgba(255,255,255,.15);
        }
        .nbd-wall-btn.secondary:hover { border-color: rgba(255,255,255,.4); color: #f0f6fc; }
        .nbd-wall-current {
          font-size: 11px; color: #4a5568; margin-top: 16px;
          font-family: 'DM Mono', monospace; letter-spacing: .5px;
        }
      </style>
      <div class="nbd-wall-card">
        <div class="nbd-wall-badge">🔒 ${planName} Feature</div>
        <div class="nbd-wall-title">UPGRADE TO<br>UNLOCK THIS TOOL</div>
        <div class="nbd-wall-sub">
          This tool requires the <strong style="color:var(--orange,#BD5728)">${planName}</strong> plan.
          Upgrade to get full access to everything NBD Pro has to offer.
        </div>
        <ul class="nbd-wall-features">
          ${features.map(f => `<li>${f}</li>`).join('')}
        </ul>
        <div class="nbd-wall-btns">
          <button data-na-action="upgradeCheckout" data-na-id="${requiredPlan}" class="nbd-wall-btn primary">Upgrade to ${planName} →</button>
          <a href="/pro/" class="nbd-wall-btn secondary">← Back to Home</a>
        </div>
        <div class="nbd-wall-current">
          Your current plan: <strong style="color:#8b9bb4">${currentName}</strong>
        </div>
      </div>
    `;

    document.body.appendChild(wall);
    // Hide the page content behind the wall
    document.documentElement.style.visibility = 'visible';
  },

  /**
   * Inject a small "plan badge" into any element
   */
  renderPlanBadge(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const name = PLAN_NAMES[_userPlan] || 'Free';
    const color = _userPlan === 'growth' ? '#BD5728' :
                  _userPlan === 'starter' ? '#3fb950' : '#4a5568';
    el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;
      padding:3px 10px;border-radius:20px;font-size:9px;font-weight:700;
      letter-spacing:1.5px;text-transform:uppercase;
      background:${color}15;border:1px solid ${color}40;color:${color};
      font-family:'DM Mono',monospace">${name}</span>`;
  },
};

// ── Internal Helpers ──────────────────────────────────────
// Ask the server to stamp { owner: true, role: 'admin' } on this account
// (mintOwnerClaims callable — see functions/handlers/auth.js). Called only
// when the signed-in email matched the OWNER_EMAILS mint-trigger list but
// the token has no owner claim yet. Since the retirement (2026-07-06) the
// caller AWAITS this (time-bounded) and re-reads the claims right after —
// the claim, not the email, is what authorizes the session. Idempotent
// server-side; the per-page guard just avoids repeat calls.
async function _requestOwnerClaimMint(user) {
  if (window.__NBD_OWNER_MINT_ATTEMPTED) return;
  window.__NBD_OWNER_MINT_ATTEMPTED = true;
  try {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    const fns = mod.getFunctions(_app);
    await connectEmulatorsIfLocal({ functions: fns }); // no-op in prod
    const res = await mod.httpsCallable(fns, 'mintOwnerClaims')({});
    const out = (res && res.data) || {};
    if (out.owner === true && (out.minted || out.refresh)) {
      // Claims changed (or the token predates them) — force-refresh so
      // the caller's claims re-read (and every later read) carries
      // owner:true. Deliberately no reload: the caller re-reads in place.
      await user.getIdToken(true);
      console.info('[nbd-auth] owner claim minted — token refreshed');
    }
  } catch (e) {
    // Never fatal: the caller degrades to a normal (non-owner) session
    // for this login and retries the mint on the next one.
    console.warn('[nbd-auth] owner-claim mint skipped:', e && e.message);
  }
}

function _exposeGlobals() {
  window._user = _user;
  window._userPlan = _userPlan;
  window._subscription = _subscription;
  window._db = _db;
  window._auth = _auth;
  window._firebaseApp = _app;
  window._firebaseReady = true;
  window._role = _role;
  window._trialDaysLeft = _trialDaysLeft;
  window._isTrialUser = _isTrialUser;
  // Owner-claim transition: expose the token claims so sibling modules
  // (billing-gate.js, real-deal-academy.js) can key their owner checks
  // on claims.owner === true without their own token read. dashboard-
  // bootstrap refreshes this later with its own (fresher) read.
  window._userClaims = window._userClaims || _claims;
  window.NBDAuth = NBDAuth;
}

function _showPage() {
  document.documentElement.style.visibility = 'visible';
}


// Upgrade-wall CTA → the checkout-capable pricing page. window.StripeBilling
// never shipped anywhere in the codebase, and the old landing.html#pricing
// fallback dead-ended signed-in users on a signup form ("email already has an
// account"). Seed nbd_plan_intent so pricing-page.module.js auto-resumes
// checkout for the clicked plan (same one-shot mechanism the register funnel
// uses).
(function(){if(window._NBD_NA_DELEGATE)return;window._NBD_NA_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-na-action]');if(!t)return;if(t.dataset.naAction==='upgradeCheckout'){var plan=t.dataset.naId;if(window.StripeBilling&&window.StripeBilling.checkout){window.StripeBilling.checkout(plan);return;}try{if(plan)sessionStorage.setItem('nbd_plan_intent',plan);}catch(_){}window.location.href='/pro/pricing.html';}});})();
