/* @generated — extracted from inline <script type="module"> by audit-homeowner-2026-05-22.
   Hash: f95015cb84.  Do not edit by hand. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const app = initializeApp({
  apiKey:"AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain:"nobigdeal-pro.firebaseapp.com",
  projectId:"nobigdeal-pro",
  storageBucket:"nobigdeal-pro.firebasestorage.app",
  messagingSenderId:"717435841570",
  appId:"1:717435841570:web:c2338e11052c96fde02e7b"
});
const functions = getFunctions(app);

// UTM attribution — read once at load (same pattern as inspect-form.js
// readUtms) and merged into every _saveLead payload so print/QR and ad
// campaigns attribute. Empty params are omitted.
const _utms = (() => {
  let params;
  try { params = new URLSearchParams(window.location.search); }
  catch (e) { return {}; }
  const out = {};
  ['utm_source', 'utm_medium', 'utm_campaign'].forEach((k) => {
    const v = (params.get(k) || '').slice(0, 80);
    if (v) out[k] = v;
  });
  return out;
})();

// Expose to global scope for inline handlers
window._saveLead = async (data) => {
  const res = await window.submitPublicLead('estimate', {
    ..._utms,
    ...data,
    source: 'estimate-funnel-v2'
  });
  if (!res.ok) {
    console.warn('Lead save failed:', res.reason);
    return null;
  }
  // One-time grant for this submission's follow-up answers + photos (the
  // thank-you screen). Only a save that ASKED for one gets one back, so a
  // later CTA-click / email-request save must not wipe it (2026-10-03).
  if (res.photoToken) window._lastPhotoToken = res.photoToken;
  return res.id;
};

// Twilio Verify via Cloud Functions
window._sendOTP = async (phone) => {
  try {
    const sendOtp = httpsCallable(functions, 'sendVerificationCode');
    const result = await sendOtp({ phone });
    return result.data;
  } catch(e) {
    console.error('OTP send failed:', e);
    return { success: false, error: e.message };
  }
};

window._verifyOTP = async (phone, code) => {
  try {
    const verifyOtp = httpsCallable(functions, 'verifyCode');
    const result = await verifyOtp({ phone, code });
    return result.data;
  } catch(e) {
    console.error('OTP verify failed:', e);
    return { success: false, error: e.message };
  }
};

// Notify Joe (email + SMS)
window._notifyJoe = async (leadData) => {
  try {
    const notify = httpsCallable(functions, 'notifyNewLead');
    await notify(leadData);
  } catch(e) {
    console.warn('Joe notification failed:', e);
  }
};

// Abandoned funnel recovery — silently save partial state so we can
// send a warm recovery email an hour later if they don't complete.
// Single-fire-per-value debouncing handled at the call site.
window._saveFunnelProgress = async (payload) => {
  try {
    const base = 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
    await fetch(base + '/saveFunnelProgress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      // `keepalive:true` so the request still fires if the user navigates
      // away immediately after typing their email.
      keepalive: true
    });
  } catch (e) {
    // Fire-and-forget — abandonment capture is a nice-to-have, never
    // block the funnel UX on it.
  }
};
