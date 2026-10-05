/**
 * NBD Admin — /admin/tenants.html auth gate (2026-10-04, tenant-ready).
 * Same shape as analytics-gate.js. Platform admin only: the role 'admin'
 * custom claim, or the NBD owner account (functions/tenant-ops.js
 * adminListTenants applies the same test server-side).
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

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
// loaded before this module in tenants.html's <head>.
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
    window.location.replace('/pro/login.html?redirect=/admin/tenants.html');
    return;
  }
  try {
    const result = await user.getIdTokenResult(true);
    if (result.claims.role !== 'admin' && user.uid !== '1phDvAVXHSg82wDLegAbQFq14Ci1') {
      window.location.replace('/pro/dashboard.html');
      return;
    }
  } catch (e) {
    window.location.replace('/pro/login.html?redirect=/admin/tenants.html');
    return;
  }
  window._currentUser = user;
  window.dispatchEvent(new Event('auth-ready'));
});
