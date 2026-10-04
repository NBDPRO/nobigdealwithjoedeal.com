/**
 * NBD Admin — /admin/index.html redirect logic.
 * Extracted from an inline <script type="module"> for strict CSP.
 * Reads the admin custom claim and routes to the vault or the dashboard.
 */
import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/12.19.0/firebase-auth.js';

const app = initializeApp({
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
});
const auth = getAuth(app);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = '/pro/login.html?redirect=/admin/vault.html';
    return;
  }
  try {
    const result = await user.getIdTokenResult(true);
    if (result.claims.role === 'admin') {
      window.location.href = 'vault.html';
    } else {
      window.location.href = '/pro/dashboard.html';
    }
  } catch (e) {
    window.location.href = '/pro/login.html?redirect=/admin/vault.html';
  }
});
