/**
 * NBD Pro — /pro/login.html controller.
 *
 * Extracted from an inline <script type="module"> block so strict CSP can
 * drop 'unsafe-inline' on this page. All previous inline onclick="..."
 * handlers are now wired via addEventListener.
 */
import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken as getAppCheckToken }
  from '/assets/vendor/firebase/12.19.0/firebase-app-check.js';
import {
  getAuth, signInWithEmailAndPassword, signInWithCustomToken, sendPasswordResetEmail,
  setPersistence, browserLocalPersistence, browserSessionPersistence,
  GoogleAuthProvider, signInWithPopup, signOut
} from '/assets/vendor/firebase/12.19.0/firebase-auth.js';
import { getFirestore, doc, getDoc } from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from '/assets/vendor/firebase/12.19.0/firebase-functions.js';
import { connectEmulatorsIfLocal, emulatorAppCheckIfLocal } from '../nbd-emulator-connect.js'; // Audit #3: localhost-only, no-op in prod

const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  databaseURL: "https://nobigdeal-pro-default-rtdb.firebaseio.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

const app = initializeApp(firebaseConfig);
// App Check — only here so "Continue with Google" can open its popup inside
// the click (same reasoning as pages/register.js, which this mirrors).
// firebase-auth 10.12.2's signInWithPopup does `await auth._getAppCheckToken()`
// between the click and window.open; cold, that await is IndexedDB +
// reCAPTCHA Enterprise + a token exchange, long enough to spend the user
// activation so Safari/iOS blocks the popup (auth/popup-blocked). Fetching
// the token at load puts it in memory and the Google button is held until it
// lands (or a short timeout — see holdUntilAppCheckWarm). Key comes from
// js/dashboard-appcheck-config.js, loaded before this module in login.html.
// Initialised before getAuth (C-4 ordering). On localhost the emulator shim
// replaces reCAPTCHA. appCheckWarm settles either way (errors swallowed): it
// only gates the button, never sign-in. Null when nothing slow is awaited.
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

// ─────────────────────────────────────────────────
// POST-LOGIN DESTINATION
// pricing-page.module.js sends signed-out subscribers here with
// ?redirect=pricing&plan=starter|growth|team. Honor it: stash the plan so
// pricing resumes checkout (same sessionStorage contract as pages/register.js)
// and land back on pricing instead of silently dropping the purchase on the
// dashboard.
//
// Also honor a bare ?plan=… query and any nbd_plan_intent already stashed
// earlier in the funnel (landing → register → abandon → login). Register +
// onboarding already resume intent; login used to only check redirect=pricing
// and otherwise dumped the user on the dashboard — losing the upsell.
// ─────────────────────────────────────────────────
const PLAN_INTENTS = ['starter', 'team', 'growth'];
const POST_LOGIN_DEST = (() => {
  try {
    const params = new URLSearchParams(window.location.search);
    const qPlan = params.get('plan');
    if (PLAN_INTENTS.includes(qPlan)) {
      sessionStorage.setItem('nbd_plan_intent', qPlan);
    }
    if (params.get('redirect') === 'pricing') {
      return '/pro/pricing.html';
    }
    // Bare ?plan= on login (shared link / recovery) → resume checkout.
    if (PLAN_INTENTS.includes(qPlan)) {
      return '/pro/pricing.html';
    }
    // Returning visitor: intent already set from register/landing this tab.
    const existing = sessionStorage.getItem('nbd_plan_intent');
    if (PLAN_INTENTS.includes(existing)) {
      return '/pro/pricing.html';
    }
  } catch (_) {}
  return '/pro/dashboard.html';
})();

// ─────────────────────────────────────────────────
// TAB SWITCHING (wired via addEventListener instead of inline onclick)
// ─────────────────────────────────────────────────
function switchTab(tab) {
  ['member', 'code', 'demo'].forEach(t => {
    document.getElementById('view-' + t).classList.toggle('active', t === tab);
    document.getElementById('tab-' + t).classList.toggle('active', t === tab);
  });
  if (tab === 'code') setTimeout(() => document.getElementById('codeInput').focus(), 50);
}
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.id; // tab-member | tab-code | tab-demo
    if (id && id.startsWith('tab-')) switchTab(id.slice(4));
  });
});

// ─────────────────────────────────────────────────
// MEMBER LOGIN
// ─────────────────────────────────────────────────
const emailInput    = document.getElementById('emailInput');
const passwordInput = document.getElementById('passwordInput');
const loginBtn      = document.getElementById('loginBtn');
const loginError    = document.getElementById('loginError');
const loginErrorMsg = document.getElementById('loginErrorMsg');
const rememberMe    = document.getElementById('rememberMe');
const togglePw      = document.getElementById('togglePw');
const mainView      = document.getElementById('mainView');
const resetView     = document.getElementById('resetView');

togglePw.addEventListener('click', () => {
  const isText = passwordInput.type === 'text';
  passwordInput.type = isText ? 'password' : 'text';
  togglePw.textContent = isText ? '👁' : '🙈';
});
// Route everything through the form's submit event. Browsers detect a
// real email+password form submission and offer to save the password,
// and saved credentials autofill the inputs on subsequent visits.
// Enter-key on either input now triggers form submission natively, so
// we no longer need keydown listeners. The button is type="submit", so
// click + touchend both fire submit too — handled here in one place.
const loginForm = document.getElementById('loginForm');
loginForm.addEventListener('submit', e => {
  e.preventDefault();
  doLogin();
});
// iOS Safari sometimes drops the synthetic click event after a focus
// transition from the password input (autofill, keyboard dismiss, etc.).
// touchend on the submit button calls requestSubmit() so the same code
// path runs as a normal submit — preventDefault stops the synthetic
// click from double-firing on browsers where click works normally.
loginBtn.addEventListener('touchend', e => {
  e.preventDefault();
  if (typeof loginForm.requestSubmit === 'function') {
    loginForm.requestSubmit();
  } else {
    doLogin();
  }
});
// HTML ships the button disabled so Playwright's
// `#loginBtn:not([disabled])` wait — and any human who taps before the
// dynamic Firebase imports above resolve — both wait until handlers
// are actually wired. Remove the gate now that listeners are bound.
loginBtn.removeAttribute('disabled');

async function doLogin() {
  const email = emailInput.value.trim();
  const pass  = passwordInput.value;
  loginError.classList.remove('show');
  if (!email || !pass) {
    loginErrorMsg.textContent = 'Please enter your email and password.';
    loginError.classList.add('show');
    return;
  }
  setLoading(loginBtn, true);
  try {
    // NEW-D25: sign in FIRST, then set persistence. setPersistence mutates
    // the live Auth instance immediately, so calling it before signIn means a
    // wrong-password attempt by someone who already holds a durable
    // (Remember-me) session silently downgrades that session to session-only —
    // it then evaporates on the next browser close. Applying persistence only
    // after a successful sign-in confines the change to the freshly
    // authenticated user and never touches an existing session on failure.
    await signInWithEmailAndPassword(auth, email, pass);
    await setPersistence(auth, rememberMe.checked ? browserLocalPersistence : browserSessionPersistence);
    // Explicit Credential Management API hint. Chrome / Edge / Safari
    // already prompt to save on form submission, but storing the
    // credential here gives the browser a stable name/id to associate
    // with the saved password and works reliably across hash-router /
    // SPA flows where the navigation right after login might otherwise
    // suppress the prompt.
    if (window.PasswordCredential) {
      try {
        const cred = new window.PasswordCredential({
          id: email,
          password: pass,
          name: email,
        });
        await navigator.credentials.store(cred);
      } catch (_) { /* silent — fallback is the form-submit save prompt */ }
    }
    window.location.replace(POST_LOGIN_DEST);
  } catch (err) {
    loginErrorMsg.textContent = friendlyError(err.code);
    loginError.classList.add('show');
    passwordInput.focus();
  } finally {
    setLoading(loginBtn, false);
  }
}

// ─────────────────────────────────────────────────
// CONTINUE WITH GOOGLE — sign-in only, never provisioning
// ─────────────────────────────────────────────────
// This page signs EXISTING members in. Creating an account (users/{uid},
// createCompany, plan intent, invites, access codes) is /pro/register's job,
// so a Google identity with no NBD Pro account is signed back out and sent
// there instead of getting a half-built workspace from the login page.
//
// Note: by the time signInWithPopup resolves, Firebase Auth has ALREADY
// created an Auth user record for a first-time Google identity. That is
// accepted: the record owns no Firestore data, gets no claims, and is the
// same uid register.js picks up if that person signs up with Google later.
// No Auth-triggered function provisions on that path — onRepSignup
// (beforeUserCreated, functions/handlers/auth.js) is in the deploy
// workflow's NBD_DEPLOY_SKIP_LIST and has never been registered in prod
// (blocking functions need GCIP), and there is no auth.user().onCreate.
//
// One account per email: a password account whose email is VERIFIED gets
// google.com linked to the same uid by Firebase itself, so it lands on the
// existing users/{uid} and goes straight in. No linking UI here.
const googleLoginBtn = document.getElementById('googleLoginBtn');

const LOGIN_FALLBACK = 'sign in with your email and password';
// Mirrors googleSignInErrorMessage in pages/register.js (kept separate so
// each page's copy points at ITS email form). '' = say nothing:
// auth/cancelled-popup-request means a newer click replaced this popup, and
// that attempt reports for itself.
function googleSignInErrorMessage(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/operation-not-allowed':
      return "Google sign-in isn't available yet — please " + LOGIN_FALLBACK + '.';
    case 'auth/popup-closed-by-user':
      return 'Sign-in window closed before finishing. Try again, or ' + LOGIN_FALLBACK + '.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the Google window — allow pop-ups for this site or ' + LOGIN_FALLBACK + '.';
    case 'auth/account-exists-with-different-credential':
      return 'This email already has an account that uses a password. Sign in with your email and password instead.';
    case 'auth/cancelled-popup-request':
      return '';
    case 'auth/user-disabled':
      return 'Account disabled. Contact Joe for help.';
    case 'auth/network-request-failed':
      return 'Network problem — check your connection and try again, or ' + LOGIN_FALLBACK + '.';
    case 'auth/web-storage-unsupported':
    case 'auth/operation-not-supported-in-this-environment':
      return "Google sign-in doesn't work in this browser. Open this page in Safari or Chrome, or " + LOGIN_FALLBACK + '.';
    default:
      return 'Google sign-in failed' + (code ? ' (' + code + ')' : '') + '. Try again, or ' + LOGIN_FALLBACK + '.';
  }
}

// Hold the Google button until the App Check token is in memory (see
// appCheckWarm above) so the click opens the popup inside the user gesture.
// The timeout re-enables it regardless — a slow or blocked reCAPTCHA must
// never leave a dead button. No warm-up in flight (emulator, no key) → no hold.
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

function showLoginError(text) {
  loginErrorMsg.textContent = text;
  loginError.classList.add('show');
}

// "No account" message + a real link to /pro/register, built with DOM APIs
// (no innerHTML). The next showLoginError's textContent clears the link.
function showNoAccountError() {
  loginErrorMsg.textContent = 'No NBD Pro account is linked to that Google account yet. ';
  const a = document.createElement('a');
  a.href = '/pro/register';
  a.id = 'googleNoAccountRegister';
  a.textContent = 'Create a free account →';
  loginErrorMsg.appendChild(a);
  loginError.classList.add('show');
}

async function doGoogleLogin() {
  loginError.classList.remove('show');
  googleLoginBtn.disabled = true;
  let signedIn = false;
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    signedIn = true;
    const profile = await getDoc(doc(db, 'users', cred.user.uid));
    if (!profile.exists()) {
      // No NBD Pro account behind this Google identity. Do NOT write
      // users/{uid} or call createCompany here — sign out and point at signup.
      await signOut(auth);
      signedIn = false;
      showNoAccountError();
      return;
    }
    await setPersistence(auth, rememberMe.checked ? browserLocalPersistence : browserSessionPersistence);
    window.location.replace(POST_LOGIN_DEST);
  } catch (err) {
    console.warn('[login] Google sign-in failed:', (err && err.code) || err);
    // Signed in but the profile check (or persistence) failed: we cannot
    // tell a member from a stranger, so fail closed — sign out, ask to retry.
    if (signedIn) {
      try { await signOut(auth); } catch (_) {}
      showLoginError("Couldn't check your NBD Pro account — try again, or " + LOGIN_FALLBACK + '.');
      return;
    }
    const msg = googleSignInErrorMessage(err);
    if (msg) showLoginError(msg);
  } finally {
    googleLoginBtn.disabled = false;
  }
}

if (googleLoginBtn) {
  googleLoginBtn.addEventListener('click', doGoogleLogin);
  // Ships disabled in the HTML (like #loginBtn) so a tap before this module
  // has loaded is not a silent no-op; the warm-up hold may re-disable it.
  googleLoginBtn.removeAttribute('disabled');
  holdUntilAppCheckWarm(googleLoginBtn, appCheckWarm, APP_CHECK_WARM_TIMEOUT_MS);
}

// RESET PASSWORD
document.getElementById('showResetBtn').addEventListener('click', () => {
  mainView.classList.add('hidden');
  resetView.classList.add('active');
  document.getElementById('resetEmail').value = emailInput.value;
  document.getElementById('resetEmail').focus();
});
document.getElementById('backToLogin').addEventListener('click', () => {
  resetView.classList.remove('active');
  mainView.classList.remove('hidden');
  document.getElementById('resetError').classList.remove('show');
  document.getElementById('resetSuccess').classList.remove('show');
});
document.getElementById('resetForm').addEventListener('submit', e => {
  e.preventDefault();
  doReset();
});

async function doReset() {
  const email = document.getElementById('resetEmail').value.trim();
  const resetBtn = document.getElementById('resetBtn');
  document.getElementById('resetError').classList.remove('show');
  document.getElementById('resetSuccess').classList.remove('show');
  if (!email) {
    document.getElementById('resetErrorMsg').textContent = 'Please enter your email.';
    document.getElementById('resetError').classList.add('show');
    return;
  }
  setLoading(resetBtn, true);
  try {
    await sendPasswordResetEmail(auth, email);
    document.getElementById('resetSuccess').classList.add('show');
  } catch (err) {
    document.getElementById('resetErrorMsg').textContent = friendlyError(err.code);
    document.getElementById('resetError').classList.add('show');
  } finally {
    setLoading(resetBtn, false);
  }
}

// ─────────────────────────────────────────────────
// ACCESS CODE LOGIN
// ─────────────────────────────────────────────────
const codeInput = document.getElementById('codeInput');
const codeBtn   = document.getElementById('codeBtn');
const codeError = document.getElementById('codeError');
const codeErrorMsg = document.getElementById('codeErrorMsg');

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
});
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') doCodeLogin(); });
codeBtn.addEventListener('click', doCodeLogin);
codeBtn.removeAttribute('disabled');

async function doCodeLogin() {
  const raw = codeInput.value.trim().toUpperCase();
  codeError.classList.remove('show');
  if (!raw) {
    codeErrorMsg.textContent = 'Please enter your access code.';
    codeError.classList.add('show');
    return;
  }
  setLoading(codeBtn, true);
  try {
    const result = await validateAccessCodeFn({ code: raw });
    const data = result.data;
    if (!data?.success) {
      codeErrorMsg.textContent = data?.error || 'Code not recognized. Check with Joe at (859) 420-7382.';
      codeError.classList.add('show');
      codeInput.focus();
      return;
    }
    // Hardened path: the new validateAccessCode returns a server-minted
    // custom token. Exchange it for a Firebase session — no password
    // ever leaves the server.
    if (data.customToken) {
      await signInWithCustomToken(auth, data.customToken);
      window.location.replace(POST_LOGIN_DEST);
      return;
    }
    // Transitional compat shim — DELETE after `firebase deploy --only functions`
    // has shipped the hardened validateAccessCode to production. The OLD Cloud
    // Function (still live until Joe deploys) returns {success, email, password}.
    // Without this shim, access code login would break in the window between
    // the moment this HTML ships via GitHub Pages and the moment the hardened
    // Cloud Function is deployed. The old function is the vulnerability we're
    // fixing — this fallback path MUST be removed once the new function is live.
    if (data.email && data.password) {
      console.warn('[login] Using legacy email/password path — deploy the hardened validateAccessCode and remove this shim.');
      await signInWithEmailAndPassword(auth, data.email, data.password);
      window.location.replace(POST_LOGIN_DEST);
      return;
    }
    codeErrorMsg.textContent = 'Server returned an unexpected response. Contact Joe.';
    codeError.classList.add('show');
  } catch (err) {
    codeErrorMsg.textContent = 'Authentication error. Contact Joe at (859) 420-7382.';
    codeError.classList.add('show');
  } finally {
    setLoading(codeBtn, false);
  }
}

// ─────────────────────────────────────────────────
// DEMO LOGIN
// ─────────────────────────────────────────────────
const demoBtn   = document.getElementById('demoBtn');
const demoError = document.getElementById('demoError');
const demoErrorMsg = document.getElementById('demoErrorMsg');

demoBtn.addEventListener('click', doDemoLogin);
demoBtn.removeAttribute('disabled');

async function doDemoLogin() {
  demoError.classList.remove('show');
  setLoading(demoBtn, true);
  try {
    const result = await validateAccessCodeFn({ code: 'DEMO' });
    const data = result.data;
    if (!data?.success) throw new Error(data?.error || 'demo unavailable');
    // Hardened path
    if (data.customToken) {
      await signInWithCustomToken(auth, data.customToken);
      window.location.replace(POST_LOGIN_DEST);
      return;
    }
    // Transitional compat shim — DELETE after hardened validateAccessCode ships.
    if (data.email && data.password) {
      await signInWithEmailAndPassword(auth, data.email, data.password);
      window.location.replace(POST_LOGIN_DEST);
      return;
    }
    throw new Error('unexpected server response');
  } catch (err) {
    demoErrorMsg.textContent = 'Demo account unavailable right now. Try the Access Code tab or contact Joe.';
    demoError.classList.add('show');
  } finally {
    setLoading(demoBtn, false);
  }
}

// ─────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────
function setLoading(btn, loading) {
  btn.disabled = loading;
  btn.classList.toggle('loading', loading);
}

function friendlyError(code) {
  const map = {
    'auth/user-not-found'        : 'No account with that email. Check or contact Joe.',
    'auth/wrong-password'        : 'Incorrect password. Try again or reset it.',
    'auth/invalid-email'         : 'Please enter a valid email address.',
    'auth/too-many-requests'     : 'Too many attempts. Wait a few minutes and try again.',
    'auth/user-disabled'         : 'Account disabled. Contact Joe for help.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/invalid-credential'    : 'Invalid email or password.',
  };
  return map[code] || 'Something went wrong. Contact Joe at (859) 420-7382.';
}
