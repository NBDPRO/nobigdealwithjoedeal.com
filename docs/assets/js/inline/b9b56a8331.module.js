/* @generated — extracted from inline <script type="module"> by audit-homeowner-2026-05-22.
   Hash: b9b56a8331.  Do not edit by hand. */
import { initializeApp } from '/assets/vendor/firebase/12.19.0/firebase-app.js';
  import { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken } from '/assets/vendor/firebase/12.19.0/firebase-app-check.js';
  try {
    const app = initializeApp({
      apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
      authDomain: "nobigdeal-pro.firebaseapp.com",
      projectId: "nobigdeal-pro",
      storageBucket: "nobigdeal-pro.firebasestorage.app",
      messagingSenderId: "717435841570",
      appId: "1:717435841570:web:c2338e11052c96fde02e7b"
    });
    // Site key is the reCAPTCHA Enterprise site key registered for App Check.
    // Set window.__NBD_RECAPTCHA_KEY__ in a separate script before this loads,
    // or hard-code here after Joe registers the key in the Firebase Console.
    const siteKey = window.__NBD_RECAPTCHA_KEY__ || '';
    if (siteKey) {
      window._nbdAppCheck = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(siteKey),
        isTokenAutoRefreshEnabled: true,
      });
      window._nbdGetAppCheckToken = getToken;
    }
  } catch (e) {
    console.warn('App Check init failed:', e);
  }
