/**
 * NBD Pro — /pro/register.html controller.
 *
 * Extracted from inline <script type="module"> + inline event handlers so
 * strict CSP can drop 'unsafe-inline' on this page. The register and
 * googleRegister flows are identical to the previous implementation —
 * only the binding changed (addEventListener instead of onclick=/onsubmit=).
 */
import { initializeApp }                                         from "/assets/vendor/firebase/10.12.2/firebase-app.js";
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken as getAppCheckToken }
                                                                from "/assets/vendor/firebase/10.12.2/firebase-app-check.js";
import { getAuth, createUserWithEmailAndPassword, updateProfile, GoogleAuthProvider, signInWithPopup, signInWithCustomToken, sendEmailVerification }
                                                                from "/assets/vendor/firebase/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, getDoc, serverTimestamp }   from "/assets/vendor/firebase/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable }                           from "/assets/vendor/firebase/10.12.2/firebase-functions.js";
import { connectEmulatorsIfLocal, emulatorAppCheckIfLocal }      from "../nbd-emulator-connect.js"; // Audit #3: localhost-only, no-op in prod
import { ensureProvisioned }                                     from "../provisioning-retry.js"; // retry + pending-marker (first-run audit 2026-07-28)

const firebaseConfig = {
  apiKey:            "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain:        "nobigdeal-pro.firebaseapp.com",
  projectId:         "nobigdeal-pro",
  storageBucket:     "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId:             "1:717435841570:web:c2338e11052c96fde02e7b"
};

const app = initializeApp(firebaseConfig);
// App Check must be live before any callable runs — createCompany
// (enforceAppCheck:true) is invoked right after signup. Key comes from
// js/dashboard-appcheck-config.js loaded in <head> (photo-review.js pattern).
// On localhost the emulator shim replaces reCAPTCHA (which can't mint tokens
// off the registered origin) so the same enforced callable path works in the
// emulator rig.
//
// appCheckWarm — the Google popup needs an App Check token IN MEMORY before
// the click. firebase-auth 10.12.2's signInWithPopup builds the popup URL in
// _getRedirectUrl, which does `await auth._getAppCheckToken()` BEFORE
// _open() calls window.open (verified in the gstatic build this file
// imports). On a cold page that await is an IndexedDB read, a reCAPTCHA
// Enterprise execute and a token-exchange round trip, all between the click
// and window.open — long enough to spend the click's user activation, so
// Safari/iOS (and any slow network) blocks the popup: auth/popup-blocked.
// Fetching the token at load puts it in memory; after that the SDK's await
// resolves in microtasks and window.open stays inside the gesture. Settles
// either way (errors swallowed): it only gates the button, never sign-in.
// Null in the emulator/no-key paths, where nothing slow sits in that await.
let appCheckWarm = null;
try {
  if (!(await emulatorAppCheckIfLocal(app))
      && typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    const appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckWarm = getAppCheckToken(appCheck, false).then(() => {}, () => {});
  }
} catch (_) {}
const auth = getAuth(app);
const db = getFirestore(app);
const functions = getFunctions(app);
await connectEmulatorsIfLocal({ auth, db, functions }); // Audit #3: localhost-only, no-op in prod
const validateAccessCodeFn = httpsCallable(functions, 'validateAccessCode');
const createCompanyFn = httpsCallable(functions, 'createCompany');

// ─────────────────────────────────────────────────
// PLAN INTENT (?plan=starter|team|growth)
// Landing/pricing CTAs link here with the plan the visitor clicked. Stash it
// so the intent survives register → onboarding → pricing, where
// pricing-page.module.js auto-resumes checkout. Without this the "Start with
// Growth" click dies at signup and the visitor lands on a free dashboard with
// no path back to paying (product audit 2026-07, funnel break).
// 'team' MUST be here: it's a live sellable plan ($149) and pricing-page's
// resume already accepts it — omitting it silently dropped every signed-out
// Team checkout at signup.
// ─────────────────────────────────────────────────
const PLAN_INTENTS = ['starter', 'team', 'growth'];
try {
  const planParam = new URLSearchParams(window.location.search).get('plan');
  if (PLAN_INTENTS.includes(planParam)) sessionStorage.setItem('nbd_plan_intent', planParam);
} catch (_) { /* sessionStorage unavailable — intent is best-effort */ }

// Display metadata for the selected plan — kept in sync with pricing.html /
// billing-gate.js PLANS. Shown on the register form so a visitor who clicked a
// paid CTA sees "you selected Team — $149/mo · continue to checkout" instead of
// a form that looks like a plain free signup (funnel: buying intent made visible).
const PLAN_DISPLAY = {
  starter: { label: 'Starter', price: '$99/mo' },
  team:    { label: 'Team',    price: '$149/mo' },
  growth:  { label: 'Growth',  price: '$299/mo' },
};

// The freshly-provisioned owner's next stop. Paid intent → pricing FIRST so
// checkout happens before the brand-setup wizard (the buying moment isn't
// deferred behind onboarding); stripe-success routes them into onboarding
// after the subscription activates. No intent → straight to the wizard.
// Access-code and invited flows never call this (they route explicitly).
function ownerDest() {
  let hasIntent = false;
  try { hasIntent = PLAN_INTENTS.includes(sessionStorage.getItem('nbd_plan_intent')); } catch (_) {}
  return hasIntent ? '/pro/pricing.html' : '/pro/onboarding.html';
}

// Populate the selected-plan banner on the register form, if a paid plan was
// carried in. Reads ?plan first (deep link), then the stashed intent.
function renderPlanBanner() {
  const host = document.getElementById('regPlanBanner');
  if (!host) return;
  // An invitee (?invite=1) is joining a team, not buying a plan — never show
  // them a "you selected the X plan" banner, even if a stale intent lingers in
  // sessionStorage from an earlier visit. (inviteIntent is module-scoped and
  // set before this runs from wireRegisterDom.)
  if (inviteIntent) { host.style.display = 'none'; return; }
  let plan = null;
  try {
    plan = new URLSearchParams(window.location.search).get('plan');
    if (!PLAN_INTENTS.includes(plan)) plan = sessionStorage.getItem('nbd_plan_intent');
  } catch (_) {}
  const meta = plan && PLAN_DISPLAY[plan];
  if (!meta) { host.style.display = 'none'; return; }
  host.textContent = 'You selected the ' + meta.label + ' plan (' + meta.price
    + ') — create your account and we’ll take you straight to checkout.';
  host.style.display = 'block';
}

// ─────────────────────────────────────────────────
// INVITE INTENT (?invite=1)
// The team-invite email links here with invite=1. An invitee must NOT be
// provisioned as a solo tenant owner: the old flow ran createCompany + the
// owner-branding wizard for them, which burned a globally-unique docPrefix on
// a tenant claimInvite supersedes minutes later, dead-ended on the wizard's
// seal-collision check when they typed their employer's company name, and
// contradicted the email's "3 steps and you're in" (gauntlet gap). Invitees
// skip straight to the dashboard, where claimInvite joins them after email
// verification.
// ─────────────────────────────────────────────────
let inviteIntent = false;
try {
  inviteIntent = new URLSearchParams(window.location.search).get('invite') === '1';
} catch (_) { /* best-effort */ }

// Access-code failures split into two classes: the visitor's problem (typo,
// expired, fully redeemed — fixable by re-entering) vs the server's problem
// (e.g. the known prod IAM gap minting custom tokens). Only the first should
// bounce back to the form; the second must NOT strand an already-created
// account — degrade to the free tier instead.
const CODE_USER_ERRORS = [
  'functions/not-found', 'functions/permission-denied',
  'functions/invalid-argument', 'functions/resource-exhausted',
];

// ─────────────────────────────────────────────────
// PASSWORD STRENGTH METER
// ─────────────────────────────────────────────────
function updateStrength(val) {
  const bar = document.getElementById('strengthBar');
  if (!bar) return;
  let score = 0;
  if (val.length >= 8) score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const pct = [0, 25, 50, 75, 100][score];
  const color = ['', '#E05252', '#EAB308', '#4A9EFF', '#2ECC8A'][score];
  bar.style.width = pct + '%';
  bar.style.background = color;
}

// ─────────────────────────────────────────────────
// PASSWORD VISIBILITY TOGGLE
// ─────────────────────────────────────────────────
function togglePass(id, btn) {
  const inp = document.getElementById(id);
  if (!inp) return;
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  if (btn) {
    btn.textContent = show ? '🙈' : '👁';
    // a11y: keep the accessible name/state in sync with the visual glyph.
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    btn.setAttribute('aria-pressed', String(show));
  }
}

// ─────────────────────────────────────────────────
// REGISTER FLOW
// ─────────────────────────────────────────────────
// Clickwrap (2026-10-03, legal-checklist audit). The account is a contract
// with the Terms; "by creating an account you agree" (browsewrap) is the
// weakest form of assent there is. Both sign-up paths require the box.
const TERMS_VERSION = '2026-10-03';
function termsAccepted(errEl) {
  const box = document.getElementById('regTerms');
  if (box && box.checked) return true;
  if (errEl) errEl.textContent = 'Please check the box to agree to the Terms of Service and Privacy Policy.';
  try { if (box) box.focus(); } catch (_) { /* ignore */ }
  return false;
}
// Stamped on the users doc at creation: when, and which Terms revision.
function termsRecord() {
  return { termsAcceptedAt: serverTimestamp(), termsVersion: TERMS_VERSION };
}

async function register(e) {
  e.preventDefault();
  const btn   = document.getElementById('regBtn');
  const errEl = document.getElementById('regErr');
  const okEl  = document.getElementById('regOk');
  errEl.textContent = ''; okEl.textContent = '';
  if (!termsAccepted(errEl)) return;

  const firstName = document.getElementById('regFirst').value.trim();
  const lastName  = document.getElementById('regLast').value.trim();
  const company   = document.getElementById('regCompany').value.trim();
  const email     = document.getElementById('regEmail').value.trim();
  const password  = document.getElementById('regPass').value;
  const confirm   = document.getElementById('regConfirm').value;
  const code      = document.getElementById('regCode').value.trim();

  if (!firstName || !email || !password) { errEl.textContent = 'First name, email and password are required.'; return; }
  if (password.length < 8)                { errEl.textContent = 'Password must be at least 8 characters.'; return; }
  if (password !== confirm)               { errEl.textContent = 'Passwords do not match.'; return; }

  if (!code) {
    // No access code — free account; Stripe Checkout upgrades via webhook.
    btn.disabled = true;
    btn.textContent = 'Creating free account...';
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: `${firstName} ${lastName}`.trim() });
      try { await sendEmailVerification(cred.user); } catch (_) { /* non-fatal */ }
      await setDoc(doc(db, 'users', cred.user.uid), {
        firstName, lastName, company: company || '', email,
        createdAt: serverTimestamp(), onboarded: false, ...termsRecord()
      });
      // Invitees (?invite=1 from the team-invite email) skip solo tenant
      // provisioning AND the owner wizard entirely: the dashboard's
      // claimInvite joins them to their team once the email is verified.
      if (inviteIntent) {
        window.location.replace('/pro/dashboard.html');
        return;
      }
      // PILLAR1 Phase 2: turn the account into a real tenant (companies/{uid}
      // + companyProfile seed + owner claims) so lead routing and per-tenant
      // branding work without hand-seeding. Non-fatal: retried with backoff;
      // a final failure marks the account pending so the onboarding wizard
      // (blocking) and the dashboard login-heal finish the job.
      await ensureProvisioned(cred.user, () => createCompanyFn({ name: company || `${firstName} ${lastName}`.trim() }));
      // New owners: paid intent → pricing (checkout first, ownerDest), else
      // the setup wizard. A brief note so the redirect isn't a blank flash.
      const dest = ownerDest();
      const okEl = document.getElementById('regOk');
      if (okEl) {
        okEl.textContent = dest === '/pro/pricing.html'
          ? 'Account created — taking you to checkout…'
          : 'Account created — setting up your workspace…';
      }
      window.location.replace(dest);
      return;
    } catch (e2) {
      errEl.textContent = e2.code === 'auth/email-already-in-use'
        ? 'This email is already registered. Try logging in.'
        : (e2.message || 'Registration failed');
      btn.disabled = false; btn.textContent = 'Create Account';
      return;
    }
  }

  btn.disabled = true;
  btn.textContent = 'Creating account...';
  try {
    // A failed code attempt leaves the visitor signed in to the account this
    // form already created; a blind re-create would die on
    // auth/email-already-in-use and strand them. Reuse the signed-in account
    // when the email matches instead of creating again.
    let cred;
    if (auth.currentUser && auth.currentUser.email === email) {
      cred = { user: auth.currentUser };
    } else {
      cred = await createUserWithEmailAndPassword(auth, email, password);
      await updateProfile(cred.user, { displayName: `${firstName} ${lastName}`.trim() });
      try { await sendEmailVerification(cred.user); } catch (_) {}
      await setDoc(doc(db, 'users', cred.user.uid), {
        firstName, lastName, company: company || '', email,
        createdAt: serverTimestamp(), onboarded: false, ...termsRecord()
      });
    }

    let result;
    try {
      result = await validateAccessCodeFn({ code });
    } catch (codeErr) {
      if (CODE_USER_ERRORS.includes(codeErr.code)) {
        errEl.textContent = 'That access code is not valid. Your account is saved — fix the code and press Create Account again, or clear the code field to continue on the free tier.';
        btn.disabled = false; btn.textContent = 'Create Account';
        return;
      }
      // Server-side failure — not the visitor's fault. Their account already
      // exists; give them a working free-tier tenant instead of a dead end.
      console.warn('validateAccessCode failed server-side, continuing on free tier:', codeErr);
      await ensureProvisioned(cred.user, () => createCompanyFn({ name: company || `${firstName} ${lastName}`.trim() }));
      okEl.textContent = 'Account created on the free tier — your access code could not be applied right now. Email jd@nobigdealwithjoedeal.com and Joe will upgrade you.';
      btn.textContent = '✓ Done';
      setTimeout(() => { window.location.replace('/pro/onboarding.html'); }, 3000);
      return;
    }
    if (!result?.data?.success) {
      errEl.textContent = (result?.data?.error) || 'That access code is not valid. Your account is saved — fix the code and press Create Account again.';
      btn.disabled = false; btn.textContent = 'Create Account';
      return;
    }
    if (result.data.customToken) {
      await signInWithCustomToken(auth, result.data.customToken);
    }
    // Code redemptions used to jump STRAIGHT to the dashboard, skipping tenant
    // provisioning entirely — a paid (starter/growth) user landed with no
    // companies/{uid} doc, no companyId claim, no doc prefix: public lead
    // intake and per-tenant branding silently broken. Provision like the free
    // path (createCompany is idempotent and refuses invited reps); a failure
    // marks pending and the onboarding wizard blocks until it lands.
    await ensureProvisioned(auth.currentUser, () => createCompanyFn({ name: company || `${firstName} ${lastName}`.trim() }));
    okEl.textContent = 'Account created! Setting up your workspace...';
    btn.textContent = '✓ Done';
    setTimeout(() => { window.location.replace('/pro/onboarding.html'); }, 1200);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Create Account';
    const msg = err.code === 'auth/email-already-in-use' ? 'That email already has an account. Try logging in instead.'
              : err.code === 'auth/invalid-email'        ? 'That email address is not valid.'
              : err.code === 'auth/weak-password'        ? 'Password is too weak. Use at least 8 characters.'
              : 'Something went wrong: ' + (err.message || err.code);
    errEl.textContent = msg;
  }
}

// ─────────────────────────────────────────────────
// GOOGLE REGISTER FLOW
// ─────────────────────────────────────────────────

// What a visitor reads in #regErr when the Google path fails. The old copy
// said "Sign-in cancelled." for auth/popup-closed-by-user — which is also
// what a COOP-severed popup produces, so people who cancelled nothing were
// told they had — and dumped raw Firebase text ("Firebase: Error
// (auth/operation-not-allowed).") for everything else. Every message offers
// the email form as the way forward. Returns '' when there is nothing to
// say: auth/cancelled-popup-request means a newer click replaced this popup,
// and that newer attempt reports for itself.
function googleSignInErrorMessage(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/operation-not-allowed':
      return "Google sign-in isn't available yet — please sign up with email.";
    case 'auth/popup-closed-by-user':
      return 'Sign-in window closed before finishing. Try again, or sign up with email.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window — allow pop-ups for this site or sign up with email.';
    case 'auth/account-exists-with-different-credential':
      return 'This email already has an account that uses a password. Log in with your email and password instead.';
    case 'auth/cancelled-popup-request':
      return '';
    case 'auth/network-request-failed':
      return 'Network problem — check your connection and try again, or sign up with email.';
    case 'auth/web-storage-unsupported':
    case 'auth/operation-not-supported-in-this-environment':
      return "Google sign-in doesn't work in this browser. Open this page in Safari or Chrome, or sign up with email.";
    default:
      return 'Google sign-in failed' + (code ? ' (' + code + ')' : '') + '. Try again, or sign up with email.';
  }
}

// Hold the Google button until the App Check token is in memory (see
// appCheckWarm at the top of this file) so the click opens the popup inside
// the user gesture. A timeout re-enables it regardless: a slow or blocked
// reCAPTCHA must never leave a dead button, and the worst case after that is
// the auth/popup-blocked copy above plus a second click that works (the
// token is warm by then). No warm-up in flight (emulator, no key) → no hold.
const APP_CHECK_WARM_TIMEOUT_MS = 4000;
function holdUntilAppCheckWarm(btn, warm, timeoutMs) {
  if (!btn || !warm) return;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  };
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  Promise.resolve(warm).then(release, release);
  setTimeout(release, timeoutMs);
}

async function googleRegister() {
  const errEl = document.getElementById('regErr');
  const code  = document.getElementById('regCode').value.trim();
  errEl.textContent = '';
  const termsErr = document.getElementById('regTermsErr');
  if (termsErr) termsErr.textContent = '';
  if (!termsAccepted(termsErr || errEl)) return;

  try {
    const provider = new GoogleAuthProvider();
    const cred = await signInWithPopup(auth, provider);
    const user = cred.user;

    const existing = await getDoc(doc(db, 'users', user.uid));
    const isNewUser = !existing.exists();
    if (isNewUser) {
      const nameParts = (user.displayName || '').split(' ');
      await setDoc(doc(db, 'users', user.uid), {
        firstName: nameParts[0] || '',
        lastName:  nameParts.slice(1).join(' ') || '',
        company:   '',
        email:     user.email,
        createdAt: serverTimestamp(),
        onboarded: false,
        ...termsRecord()
      });
    }

    if (code) {
      let result;
      try {
        result = await validateAccessCodeFn({ code });
      } catch (codeErr) {
        if (CODE_USER_ERRORS.includes(codeErr.code)) {
          errEl.textContent = 'That access code is not valid. You are signed in — fix the code and press the Google button again, or clear the code field to continue on the free tier.';
          return;
        }
        // Server-side failure — degrade to the free tier rather than strand
        // the signed-in account (mirrors the email/password path).
        console.warn('validateAccessCode failed server-side, continuing on free tier:', codeErr);
        if (isNewUser) {
          await ensureProvisioned(user, () => createCompanyFn({ name: user.displayName || (user.email || '').split('@')[0] }));
        }
        document.getElementById('regOk').textContent = 'Signed in on the free tier — your access code could not be applied right now. Email jd@nobigdealwithjoedeal.com and Joe will upgrade you.';
        setTimeout(() => { window.location.href = isNewUser ? '/pro/onboarding.html' : '/pro/dashboard.html'; }, 3000);
        return;
      }
      if (!result?.data?.success) {
        errEl.textContent = (result?.data?.error) || 'That access code is not valid.';
        return;
      }
      if (result.data.customToken) {
        await signInWithCustomToken(auth, result.data.customToken);
      }
      // Code redemptions must provision a tenant too (#945 fixed the
      // email/password code path; this is the same gap in the Google branch —
      // a paid code-holder landed with no companies doc / companyId claim).
      // createCompany is idempotent and refuses invited reps.
      await ensureProvisioned(auth.currentUser, () => createCompanyFn({ name: user.displayName || (user.email || '').split('@')[0] }));
    } else if (isNewUser && !inviteIntent) {
      // PILLAR1 Phase 2 parity: Google free signups get provisioned too
      // (the email/password path already does this). Idempotent; server
      // refuses invited reps. Non-fatal — account works either way; a
      // failure marks pending and the wizard/dashboard heals finish it.
      // Invitees (?invite=1) are NOT provisioned — claimInvite joins them
      // to their team on first dashboard load instead.
      await ensureProvisioned(user, () => createCompanyFn({ name: user.displayName || (user.email || '').split('@')[0] }));
    }

    // New free owners route via ownerDest (paid intent → pricing/checkout
    // first, else the setup wizard); code-holders, invitees, and returning
    // users go straight to the dashboard.
    const isNewOwner = !code && isNewUser && !inviteIntent;
    const dest = isNewOwner ? ownerDest() : '/pro/dashboard.html';
    document.getElementById('regOk').textContent = (isNewOwner && dest === '/pro/pricing.html')
      ? 'Signed in! Taking you to checkout…'
      : 'Signed in! Taking you to your workspace…';
    setTimeout(() => { window.location.href = dest; }, 1200);
  } catch (err) {
    console.warn('[register] Google sign-in failed:', (err && err.code) || err);
    errEl.textContent = googleSignInErrorMessage(err);
  }
}

// ─────────────────────────────────────────────────
// WIRE DOM EVENTS
// ─────────────────────────────────────────────────
// readyState guard, NOT a bare DOMContentLoaded listener: this module has a
// top-level `await connectEmulatorsIfLocal(...)` above, and a module
// suspended on top-level await does NOT hold back DOMContentLoaded. In
// emulator mode the await dynamically imports three SDK chunks — slow
// enough that the event fires BEFORE this line runs, the listener never
// fires, and the Create Account button is silently dead (caught by the
// signup-funnel E2E journey, 2026-07-05). Prod won the race only because
// the connect is a no-op there. Same pattern as tpl-view-draw's bootstrap.
function wireRegisterDom() {
  renderPlanBanner();

  const form = document.getElementById('regForm');
  if (form) form.addEventListener('submit', register);

  const gbtn = document.getElementById('googleRegBtn');
  if (gbtn) {
    gbtn.addEventListener('click', googleRegister);
    holdUntilAppCheckWarm(gbtn, appCheckWarm, APP_CHECK_WARM_TIMEOUT_MS);
  }

  const codeInput = document.getElementById('regCode');
  if (codeInput) codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase(); });

  const passInput = document.getElementById('regPass');
  if (passInput) passInput.addEventListener('input', () => updateStrength(passInput.value));

  document.querySelectorAll('.pass-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      if (target) togglePass(target, btn);
    });
  });
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireRegisterDom, { once: true });
} else {
  wireRegisterDom();
}
