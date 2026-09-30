/* @generated — extracted from inline <script> by audit-homeowner-2026-05-22.
   Hash: 0214ed5eea.  Do not edit by hand. */
window._captureContactLead = async (data) => {
  const res = await window.submitPublicLead('contact', Object.assign({
    source: 'homepage'
  }, data || {}));
  if (!res.ok) console.warn('Lead capture failed:', res.reason);
  // Full result for the photo step (res.photoToken — intake-extras.js).
  window._lastLeadResult = res;
  return !!res.ok;
};
