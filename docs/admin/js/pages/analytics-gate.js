/**
 * NBD Admin — /admin/analytics.html auth gate.
 * Extracted from an inline <script type="module"> for strict CSP.
 * Uses Firebase custom claims, not a Firestore role field.
 */
import { initializeApp } from '/assets/vendor/firebase/10.12.2/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from '/assets/vendor/firebase/10.12.2/firebase-app-check.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/10.12.2/firebase-auth.js';

const firebaseConfig = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

const app = initializeApp(firebaseConfig);
// getAiUsageAnalytics declares enforceAppCheck:true, matching every other
// admin-only callable's config — but nothing under docs/admin/ bootstrapped
// App Check until now, so that config was never actually exercised from
// this page. window.__NBD_APP_CHECK_KEY is set by dashboard-appcheck-config.js,
// loaded before this module in analytics.html's <head>.
try {
  if (typeof window.__NBD_APP_CHECK_KEY === 'string' && window.__NBD_APP_CHECK_KEY) {
    initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(window.__NBD_APP_CHECK_KEY),
      isTokenAutoRefreshEnabled: true,
    });
  }
} catch (_) {}
const auth = getAuth(app);

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.replace('/pro/login.html?redirect=/admin/analytics.html');
    return;
  }
  try {
    const result = await user.getIdTokenResult(true);
    if (result.claims.role !== 'admin') {
      window.location.replace('/pro/dashboard.html');
      return;
    }
  } catch (e) {
    window.location.replace('/pro/login.html?redirect=/admin/analytics.html');
    return;
  }
  window._currentUser = user;
  window.dispatchEvent(new Event('auth-ready'));
});
