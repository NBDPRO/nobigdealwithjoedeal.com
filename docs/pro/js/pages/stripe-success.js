/**
 * NBD Pro — /pro/stripe-success.html controller.
 *
 * Post-phase-1 rewrite. The previous implementation tried to write
 * `subscriptions/{uid}` and `users/{uid}.role` directly from the client, but
 * the hardened firestore.rules now reject both of those writes. The correct
 * flow is: Stripe → stripeWebhook Cloud Function (admin SDK) → writes the
 * subscription doc → this page polls until the document flips to active.
 *
 * Flow:
 *   1. If the user is already signed in, poll getSubscriptionStatus until
 *      the Stripe webhook has activated their subscription.
 *   2. If the user is NOT signed in, collect email + password, create the
 *      account, then wait for the Stripe webhook (keyed off session_id →
 *      client_reference_id = uid) to write the subscription doc.
 *
 * Nothing privileged is ever written by this page.
 */
import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from '/assets/vendor/firebase/12.19.0/firebase-app-check.js';
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, updateProfile } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp } from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from '/assets/vendor/firebase/12.19.0/firebase-functions.js';
import { connectEmulatorsIfLocal, emulatorAppCheckIfLocal } from '../nbd-emulator-connect.js'; // Audit #3: localhost-only, no-op in prod
import { ensureProvisioned } from '../provisioning-retry.js'; // retry + pending-marker (first-run audit 2026-07-28)

const app = initializeApp({
  apiKey:            "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain:        "nobigdeal-pro.firebaseapp.com",
  projectId:         "nobigdeal-pro",
  storageBucket:     "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId:             "1:717435841570:web:c2338e11052c96fde02e7b"
});
// App Check must be live before the createCompany callable
// (enforceAppCheck:true) runs on the buy-first path — same setup as
// register.js. Key from js/dashboard-appcheck-config.js (loaded in <head>).
// On localhost the emulator shim replaces reCAPTCHA. Without this the
// provisioning call is rejected in prod and the buy-first account never
// becomes a tenant (the exact hole this page's createCompany call closes).
try {
  if (!(await emulatorAppCheckIfLocal(app))
      && typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (_) { /* App Check init best-effort — createCompany may then be rejected */ }
const auth = getAuth(app);
const db   = getFirestore(app);
const functions = getFunctions(app);
await connectEmulatorsIfLocal({ auth, db, functions }); // Audit #3: localhost-only, no-op in prod
const createCompanyFn = httpsCallable(functions, 'createCompany');

const params  = new URLSearchParams(window.location.search);
const session = params.get('session_id') || '';
const plan    = params.get('plan') || 'growth';

const show = id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; };
const hide = id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };
const err  = msg => { const e = document.getElementById('errorBox');  if (e) { e.textContent = msg; e.style.display = 'block'; } };
const err2 = msg => { const e = document.getElementById('errorBox2'); if (e) { e.textContent = msg; e.style.display = 'block'; } };

// Subscribe to subscriptions/{companyId||uid} and resolve once the plan is
// live. The Stripe webhook writes this doc server-side via admin SDK, keyed to
// the COMPANY (client_reference_id = companyId claim || uid), so watch the
// same key — for solo owners they're identical, and for a company_admin
// purchaser the owner-keyed doc is the one that actually gets written.
// 'trialing' counts as live: Growth checkout starts a 14-day trial and the
// webhook now records the real Stripe status. Times out after ~60s so a user
// sitting on a stuck webhook doesn't spin forever.
function waitForSubscriptionActive(billingKey, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('timeout'));
    }, timeoutMs);
    const unsub = onSnapshot(doc(db, 'subscriptions', billingKey), snap => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.status === 'active' || data.status === 'trialing') {
        clearTimeout(timer);
        unsub();
        resolve(data);
      }
    }, e => {
      clearTimeout(timer);
      unsub();
      reject(e);
    });
  });
}

// Point the "done" CTA at the right next step. A brand-new owner who paid
// BEFORE the setup wizard (funnel reorder) still needs onboarding; a returning
// subscriber (upgrade/renew) is already set up and goes to the dashboard.
async function wireDoneDestination(user) {
  let onboarded = true; // default to dashboard on any read failure — never trap
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    onboarded = !(snap.exists() && snap.data().onboarded === false);
  } catch (_) { /* keep dashboard default */ }
  const btn  = document.getElementById('doneContinueBtn');
  const note = document.getElementById('doneNote');
  if (!onboarded) {
    if (btn)  { btn.setAttribute('href', '/pro/onboarding.html'); btn.textContent = 'Finish setup →'; }
    if (note) note.textContent = 'One quick step — set up your brand, then your workspace is ready.';
  }
}

async function handleSignedInUser(user) {
  show('stepActivate');
  try {
    let billingKey = user.uid;
    try {
      const tok = await user.getIdTokenResult();
      if (tok.claims && tok.claims.companyId) billingKey = tok.claims.companyId;
    } catch (_) { /* claims unavailable → uid (solo convention) */ }
    await waitForSubscriptionActive(billingKey);
    // Force a token refresh so the plan/subscriptionStatus claims the webhook
    // just merged are live in THIS session — any Firestore rule or callable
    // that gates on token.plan would otherwise read a stale/absent claim for
    // up to ~1h after purchase (display already reads the sub doc directly).
    try { await user.getIdToken(true); } catch (_) { /* non-fatal */ }
    // The buying intent is spent — clear it so a later pricing visit doesn't
    // auto-relaunch checkout (pricing-page clears it too; belt and braces).
    try { sessionStorage.removeItem('nbd_plan_intent'); } catch (_) {}
    await wireDoneDestination(user);
    hide('stepActivate');
    show('stepDone');
  } catch (e) {
    hide('stepActivate');
    if (e && e.message === 'timeout') {
      err('Your payment was received but the subscription is still activating. ' +
          'It usually takes under a minute. Reload this page in a moment, or ' +
          'contact jd@nobigdealwithjoedeal.com if it does not activate.');
    } else {
      err('Activation error: ' + (e.message || 'unknown') + '. ' +
          'Contact jd@nobigdealwithjoedeal.com with your session id: ' + session);
    }
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    await handleSignedInUser(user);
  } else {
    show('stepCreate');
    setTimeout(() => {
      const el = document.getElementById('newEmail');
      if (el) el.focus();
    }, 200);
  }
});

async function createAndActivate() {
  const email = document.getElementById('newEmail').value.trim();
  const pass  = document.getElementById('newPass').value;
  const name  = document.getElementById('newName').value.trim();

  if (!email || !pass) { err2('Email and password are required.'); return; }
  if (pass.length < 8)  { err2('Password must be at least 8 characters.'); return; }

  const btn = document.querySelector('#stepCreate .btn');
  if (btn) { btn.textContent = 'Creating account...'; btn.disabled = true; }

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    if (name) await updateProfile(cred.user, { displayName: name });

    // Minimal profile doc — NO plan, NO role, NO accessCode. Rules reject
    // privileged fields; the Stripe webhook writes subscriptions/{uid}.
    const nameParts = name.split(' ');
    await setDoc(doc(db, 'users', cred.user.uid), {
      firstName: nameParts[0] || '',
      lastName:  nameParts.slice(1).join(' ') || '',
      email,
      onboarded: false,
      createdAt: serverTimestamp()
    });

    // Provision a real tenant (companies/{uid} + companyProfile seed + owner
    // claims), same as register.js. Without this, a buy-first account (created
    // here rather than at register) gets a paid subscriptions doc but NO
    // company/companyId claim — the exact tenant-less-payer hole #945 fixed on
    // the register path. Idempotent; retried with backoff, and a final
    // failure marks pending so the onboarding wizard (blocking) and the
    // dashboard login-heal finish the job — a PAYING tenant must never stay
    // tenant-less.
    await ensureProvisioned(cred.user, () => createCompanyFn({ name: (name || email.split('@')[0]) }));

    hide('stepCreate');
    await handleSignedInUser(cred.user);
  } catch (e) {
    if (btn) { btn.textContent = 'Create Account & Activate →'; btn.disabled = false; }
    if (e.code === 'auth/email-already-in-use') {
      err2('That email already has an account. Sign in here: /pro/login.html');
    } else {
      err2(e.message || 'Account creation failed.');
    }
  }
}

// readyState guard, NOT a bare DOMContentLoaded listener: this module has a
// top-level await above, and a module suspended on top-level await does not
// hold back DOMContentLoaded — the event can fire before this line runs and
// the activate button would be silently dead (register.js had exactly this
// bug, caught by the signup-funnel E2E journey 2026-07-05).
function wireStripeSuccessDom() {
  const btn = document.getElementById('createAndActivateBtn');
  if (btn) btn.addEventListener('click', createAndActivate);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireStripeSuccessDom, { once: true });
} else {
  wireStripeSuccessDom();
}
