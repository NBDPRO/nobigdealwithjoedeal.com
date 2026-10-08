import { initializeApp } from '/assets/vendor/firebase/10.12.2/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from '/assets/vendor/firebase/10.12.2/firebase-auth.js';

const app = initializeApp({
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
});
const auth = getAuth(app);

// Custom-claims admin gate — no Firestore role field, no email whitelist.
onAuthStateChanged(auth, async (user) => {
  if (user) {
    try {
      const result = await user.getIdTokenResult(true);
      if (result.claims.role === 'admin') {
        window.location.href = 'vault.html';
        return;
      }
    } catch (e) { /* fall through to the form */ }
  }
  document.getElementById('loginForm').style.display = 'block';
});

// Real email + password form. The previous implementation read a non-existent
// `#passfield` and sent an empty password, which is how it bypassed password checks.
window.handleLogin = async function(event) {
  event.preventDefault();
  const emailEl = document.getElementById('adminEmail');
  const passEl  = document.getElementById('adminPassword');
  const errorDiv = document.getElementById('errorMsg');
  const btn = document.getElementById('loginBtn');
  const email = (emailEl?.value || '').trim();
  const password = passEl?.value || '';

  errorDiv.textContent = '';
  if (!email || !password) {
    errorDiv.textContent = 'Email and password required.';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Verifying...';

  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const result = await cred.user.getIdTokenResult(true);
    if (result.claims.role === 'admin') {
      window.location.href = 'vault.html';
    } else {
      errorDiv.textContent = 'Account does not have admin access.';
      btn.disabled = false;
      btn.textContent = 'Unlock Admin Access';
    }
  } catch (e) {
    // Q3: the beforeAdminSignIn blocking trigger throws
    // permission-denied with an MFA-enrolment message when an admin
    // account lacks a second factor. Surface that message as
    // guidance rather than a generic "invalid credentials" — the
    // user DID authenticate; they just need to enroll MFA.
    const msg = (e && e.message) || '';
    const code = (e && e.code) || '';
    const looksLikeMfaBlock =
      code === 'auth/internal-error' &&
      /Admin access requires a second factor/.test(msg);
    const looksLikeMfaRequired =
      code === 'auth/multi-factor-auth-required';

    if (looksLikeMfaBlock) {
      errorDiv.innerHTML =
        'Admin access requires a second factor. ' +
        '<a href="/admin/mfa-enroll.html" style="color:var(--blue);text-decoration:underline">' +
        'Enroll a TOTP authenticator</a> (1Password, Authy, Google Authenticator) ' +
        'before signing in again.';
    } else if (looksLikeMfaRequired) {
      // Firebase returns a resolver on this path; the MFA
      // verification page handles it. Until we build that UI,
      // point the admin at the enrolment runbook.
      errorDiv.textContent = 'Second factor required. Complete MFA on your authenticator app.';
    } else {
      errorDiv.textContent = 'Invalid credentials. Please try again.';
    }
    btn.disabled = false;
    btn.textContent = 'Unlock Admin Access';
    passEl && (passEl.value = '');
    emailEl && emailEl.focus();
  }
};

// Admin logout — sign out and reload so the login form shows again.
window.logout = async function() {
  try { await signOut(auth); } catch (_) {}
  window.location.reload();
};

// Wire form submit + logout via addEventListener instead of inline onsubmit/onclick.
document.addEventListener('DOMContentLoaded', () => {
  const form = document.querySelector('form');
  if (form) form.addEventListener('submit', (ev) => window.handleLogin(ev));
  document.querySelectorAll('.logout-btn').forEach(btn => {
    btn.addEventListener('click', () => window.logout());
  });
});
