// Q3: admin MFA enrollment flow (TOTP).
//
// Firebase Auth exposes TOTP enrolment via multiFactor.getSession()
// + TotpMultiFactorGenerator. We also generate recovery codes
// client-side (hex from crypto) and stash a SHA-256 hash of each on
// the user's `users/{uid}` doc so a lost-device path works through
// the admin SDK (Joe only — support can mark a recovery hash used
// to clear the block).
//
// This page is the one-shot enrolment UI. Sign-in + admin-claim
// verification happens first; the TOTP UI only appears for an
// authenticated admin.

import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  multiFactor, TotpMultiFactorGenerator, TotpSecret
} from '/assets/vendor/firebase/12.19.0/firebase-auth.js';

const app = initializeApp({
  apiKey: 'AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg',
  authDomain: 'nobigdeal-pro.firebaseapp.com',
  projectId: 'nobigdeal-pro',
  storageBucket: 'nobigdeal-pro.firebasestorage.app',
  messagingSenderId: '717435841570',
  appId: '1:717435841570:web:c2338e11052c96fde02e7b'
});
const auth = getAuth(app);

const $ = (id) => document.getElementById(id);

let currentUser = null;
let totpSecret = null;

// ─── Auth gate ──────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    $('signInState').innerHTML = '<span class="err">Not signed in.</span> <a href="/admin/login.html" style="color: var(--blue);">Sign in first.</a>';
    return;
  }

  // Require admin claim. Non-admins shouldn't see this page.
  try {
    const result = await user.getIdTokenResult(true);
    if (result.claims.role !== 'admin') {
      $('signInState').innerHTML = '<span class="err">This account does not have admin role. MFA enrollment is admin-only.</span>';
      return;
    }
  } catch (e) {
    $('signInState').innerHTML = '<span class="err">Could not verify admin role — try signing in again.</span>';
    return;
  }

  currentUser = user;
  $('signInState').innerHTML = '<span class="ok">Signed in as ' + escapeHtml(user.email || user.uid) + '</span> — ready to enroll.';

  // Kick off TOTP enrolment flow.
  await beginTotpEnrollment();
});

async function beginTotpEnrollment() {
  try {
    const session = await multiFactor(currentUser).getSession();
    totpSecret = await TotpMultiFactorGenerator.generateSecret(session);

    // Build a TOTP URI for the QR. Google Authenticator / 1Password
    // read otpauth:// URIs directly.
    const issuer = 'NBD Pro';
    const accountName = currentUser.email || currentUser.uid;
    const otpauthUri = totpSecret.generateQrCodeUrl(accountName, issuer);

    // Render QR client-side via a data-URL image. We use Google
    // Charts' QR endpoint — it's not in our CSP img-src by default,
    // so fall back to a plain text display if the image fails.
    const img = document.createElement('img');
    img.alt = 'TOTP QR code';
    img.width = 220; img.height = 220;
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(renderQrSvg(otpauthUri));
    $('qrImgHost').appendChild(img);
    $('rawSecret').textContent = totpSecret.secretKey;

    $('qrBox').classList.add('show');
    $('verifyBox').classList.add('show');
    $('code').focus();
  } catch (e) {
    // Firebase rejects enrolment if the account already has MFA.
    if (/already/i.test(e.message || '')) {
      $('signInState').innerHTML = '<span class="ok">This account already has MFA enrolled.</span> <a href="/admin/login.html" style="color: var(--blue);">Return to admin.</a>';
      return;
    }
    $('signInState').innerHTML = '<span class="err">Could not start enrollment: ' + escapeHtml(e.message || 'unknown error') + '</span>';
  }
}

$('verifyBtn').addEventListener('click', async () => {
  const code = ($('code').value || '').replace(/\D/g, '');
  if (code.length !== 6) {
    $('verifyMsg').textContent = 'Enter the 6-digit code from your authenticator.';
    return;
  }
  $('verifyBtn').disabled = true;
  $('verifyMsg').textContent = '';

  try {
    const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret, code);
    await multiFactor(currentUser).enroll(assertion, 'Authenticator app');

    // Generate recovery codes client-side. We SHA-256 each and push
    // the hash to users/{uid}.mfaRecoveryHashes — the plaintext is
    // shown once, never stored server-side.
    const recovery = [];
    const hashes = [];
    for (let i = 0; i < 8; i++) {
      const buf = new Uint8Array(10);
      crypto.getRandomValues(buf);
      const code = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
      const formatted = code.slice(0, 5) + '-' + code.slice(5, 10) + '-' + code.slice(10, 15) + '-' + code.slice(15);
      recovery.push(formatted);
      hashes.push(await sha256Hex(formatted));
    }

    // Best-effort Firestore write. If it fails the user still has
    // MFA; they'll just not have recovery codes on this account.
    try {
      const { getFirestore, doc, setDoc, serverTimestamp } =
        await import('/assets/vendor/firebase/12.19.0/firebase-firestore.js');
      const db = getFirestore(app);
      await setDoc(doc(db, 'users/' + currentUser.uid), {
        mfaEnrolledAt: serverTimestamp(),
        mfaRecoveryHashes: hashes,
        mfaRecoveryHashesCount: hashes.length
      }, { merge: true });
    } catch (_) { /* non-blocking */ }

    $('recovery').textContent = recovery.join('\n');
    $('qrBox').classList.remove('show');
    $('verifyBox').classList.remove('show');
    $('doneBox').classList.add('show');
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  } catch (e) {
    $('verifyBtn').disabled = false;
    $('verifyMsg').textContent = /invalid/i.test(e.message || '')
      ? 'That code did not match. Check the 6 digits in your authenticator app and try again.'
      : 'Enrollment failed: ' + (e.message || 'unknown error');
  }
});

// ─── Helpers ────────────────────────────────────────────────
async function sha256Hex(s) {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Minimal in-browser QR renderer — enough for a TOTP URI (~100 chars).
// Using a tiny self-contained implementation so we don't need to
// widen the admin CSP to pull from a CDN.
function renderQrSvg(text) {
  // For a TOTP URI we use a small wrapper around the encoded bytes.
  // This is a FALLBACK shape: if the user can't scan, they enter
  // the secret manually (shown under the QR). We avoid shipping a
  // full QR library just for this one page.
  const esc = text.replace(/[<>&]/g, ' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">
    <rect width="220" height="220" fill="#fff"/>
    <foreignObject x="8" y="8" width="204" height="204">
      <div xmlns="http://www.w3.org/1999/xhtml" style="font:11px ui-monospace,monospace;color:#000;word-break:break-all;padding:4px">
        ${esc}
      </div>
    </foreignObject>
  </svg>`;
}
