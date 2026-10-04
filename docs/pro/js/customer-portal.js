/**
 * NBD Pro — Customer Portal Link Minting + Share
 * Mints a short-lived, revocable homeowner-portal token URL
 * (createPortalToken → /pro/portal.html?token=…) and drives the
 * share flows (copy / SMS / email / preview).
 *
 * 2026-07-20 (CRM visual-audit batch 2/3): the legacy static-HTML
 * portal builders (buildPortalHTML + buildNextSteps + formatTimestamp +
 * STAGE_DISPLAY + the per-portal photo/estimate/note/task loads and the
 * photo-gallery HTML in generatePhotoPortal) were DELETED. They had been
 * dead since the #698 token migration — generatePortal built the HTML and
 * never used it (the Storage upload was removed; see
 * scripts/purge-legacy-storage-portals.js and functions/portal.js). Grep
 * evidence at deletion time: no references to buildPortalHTML /
 * STAGE_DISPLAY / data-cp-action outside this file in docs/, tests/, or
 * scripts/; all external callers go through window.CustomerPortal.*,
 * which is unchanged.
 *
 * Exposes: window.CustomerPortal
 */

(function() {
  'use strict';

  const PORTAL_COLLECTION = 'portals';

  // Brand resolver — mirrors review-engine.js. window._brand() (TenantContext /
  // company-profile.js) drives the customer-facing name/phone/email/website/
  // tagline so a tenant's portal + share messages carry THEIR identity, never
  // Joe's. NBD (no brand, or the canonical NBD legalName) resolves to the
  // literals below → the portal renders byte-identical for NBD. Resolved lazily
  // (per property access, all at user-action time) because this IIFE can run
  // before company-profile.js registers window._brand.
  function _brandRaw() {
    try { if (typeof window._brand === 'function') return window._brand() || {}; } catch (e) { /* fall through */ }
    return {};
  }
  function _isNbdBrand(b) { return !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions'; }
  const BRAND = {
    get name()    { const b = _brandRaw(); return _isNbdBrand(b) ? 'No Big Deal Home Solutions'        : (b.legalName || 'No Big Deal Home Solutions'); },
    // Non-NBD branch falls back to '' (NOT the NBD literal): _resolveBrand()
    // blanks an unset tenant contact/tagline field to '', so `|| NBD-literal`
    // would re-leak Joe's number/email/site/tagline into a stranger's homeowner
    // portal + share email. NBD keeps the exact literals (byte-identical).
    get phone()   { const b = _brandRaw(); return _isNbdBrand(b) ? '(859) 420-7382'                    : ((b.contact && b.contact.phone)   || ''); },
    get email()   { const b = _brandRaw(); return _isNbdBrand(b) ? 'info@nobigdealwithjoedeal.com'     : ((b.contact && b.contact.email)   || ''); },
    get website() { const b = _brandRaw(); return _isNbdBrand(b) ? 'nobigdealwithjoedeal.com'          : ((b.contact && b.contact.website) || ''); },
    get tagline() { const b = _brandRaw(); return _isNbdBrand(b) ? 'No Big Deal — We\'ve Got You Covered' : (b.tagline || ''); }
  };

  // ─── Token-based portal URL (the secure, revocable path) ──────────────
  // The module used to bake a lead's data into a static HTML file, upload it
  // to Firebase Storage, and share the getDownloadURL — a permanent,
  // non-expiring, UNREVOCABLE link (revokePortalToken never touched it). The
  // live portal is token-based: mint a short-lived, revocable token
  // (createPortalToken) and share /pro/portal.html?token=…, which the
  // getHomeownerPortalView Cloud Function resolves to a redacted homeowner
  // view server-side. The legacy dead builders were pruned 2026-07-20 (see
  // header note).
  async function mintTokenUrl(leadId) {
    if (!leadId) throw new Error('leadId required');
    const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
    const fns = mod.getFunctions();
    const call = mod.httpsCallable(fns, 'createPortalToken');
    const res = await call({ leadId: leadId, ttlDays: 30 });
    const token = res && res.data && res.data.token;
    if (!token) throw new Error('No token returned');
    return location.origin + '/pro/portal.html?token=' + encodeURIComponent(token);
  }

  /**
   * Generate and share the customer portal for a lead
   * @param {string} leadId
   */
  async function generatePortal(leadId) {
    if (!leadId || !window._user) {
      if (typeof showToast === 'function') showToast('Must be logged in', 'error');
      return null;
    }

    if (typeof showToast === 'function') showToast('Generating customer portal...', 'ok');

    try {
      // The lead-exists guard is behavior: reps get a clear error toast for a
      // stale/foreign id instead of a token minted against nothing.
      const lead = (window._leads || []).find(l => l.id === leadId);
      if (!lead) throw new Error('Lead not found');

      // Token-based + revocable (createPortalToken → /pro/portal.html?token=).
      // The portal view is resolved server-side by getHomeownerPortalView, so
      // no client-side data loads or HTML generation happen here anymore.
      const shareUrl = await mintTokenUrl(leadId);

      // Clipboard write before the toast — Safari, focus-loss, and
      // insecure-context all silently fail. Tell the user whether the
      // copy actually happened so they don't paste an empty string into
      // a text to the homeowner.
      let copied = false;
      try {
        await navigator.clipboard.writeText(shareUrl);
        copied = true;
      } catch (clipErr) {
        console.warn('Portal share clipboard write failed:', clipErr && clipErr.message);
      }
      if (typeof showToast === 'function') {
        showToast(copied
          ? 'Portal ready! Link copied to clipboard'
          : 'Portal ready — long-press the URL below to copy', copied ? 'ok' : 'warning');
      }

      return shareUrl;
    } catch(e) {
      console.error('Portal generation failed:', e);
      if (typeof showToast === 'function') showToast('Portal generation failed: ' + e.message, 'error');
      return null;
    }
  }

  /**
   * Share portal via SMS
   */
  async function sharePortalSMS(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return;
    let url;
    try { url = await mintTokenUrl(leadId); }
    catch (e) { if (typeof showToast === 'function') showToast('Could not create link: ' + (e.message || 'error'), 'error'); return; }
    if (!url) return;

    const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
    const phone = (lead.phone || '').replace(/\D/g, '');
    const body = encodeURIComponent(
      `Hi${name ? ' ' + name.split(' ')[0] : ''}, here's your project portal from ${BRAND.name}! Track your progress, view photos, and more: ${url}`
    );
    window.open(`sms:${phone}?body=${body}`, '_self');
  }

  /**
   * Share portal via Email
   */
  async function sharePortalEmail(leadId) {
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return;
    let url;
    try { url = await mintTokenUrl(leadId); }
    catch (e) { if (typeof showToast === 'function') showToast('Could not create link: ' + (e.message || 'error'), 'error'); return; }
    if (!url) return;

    const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
    const subject = encodeURIComponent('Your Project Portal — ' + BRAND.name);
    // Only include the "call us at <phone>" sentence when a phone is actually
    // set — BRAND.phone is '' for a non-NBD tenant that hasn't set contact, and
    // we must not fall back to Joe's number.
    const callLine = BRAND.phone ? `\n\nIf you have any questions, don't hesitate to call us at ${BRAND.phone}.` : '';
    const body = encodeURIComponent(
      `Hi ${name || 'there'},\n\nHere's your personal project portal where you can track progress, view photos, and see project details:\n\n${url}${callLine}\n\nBest,\n${BRAND.name}`
    );
    window.location.href = `mailto:${lead.email || ''}?subject=${subject}&body=${body}`;
  }

  // ════════════════════════════════════════════════════════
  // 2026-07-27: generatePhotoPortal was DELETED, and previewPortal's
  // `type` parameter with it.
  //
  // Both were the client half of a product that does not exist. They
  // called the same mintTokenUrl as generatePortal and returned the same
  // /pro/portal.html?token=… URL, differing only in their toast copy —
  // there is no photos-only view to mint: createPortalToken has no
  // view-type field and getHomeownerPortalView unconditionally returns
  // grandTotal + pipeline status. So the customer.html panel that offered
  // "Photo Gallery: just photos" alongside "Full Project Portal" sent the
  // full portal — pricing included — to a rep who chose the first option
  // specifically to keep pricing off the screen at the homeowner's door.
  // The panel is now a single honest "Project Portal" row; no callers left.
  // Reinstating a real photos-only link needs a backend view-type first.
  // ════════════════════════════════════════════════════════

  // ── Preview portal (opens in a new tab) ──
  async function previewPortal(leadId) {
    if (!leadId) return;
    try {
      const url = await mintTokenUrl(leadId);
      // Tag it as a rep view. Unframed and untagged, this opens the real
      // portal as if the homeowner had: portal.js emits portal_open and
      // estimate_view, the latter pushing the rep a "your customer is
      // viewing the estimate" alert about themselves and de-duping the
      // genuine open away for the length of that window. Mirrors
      // PortalLinkHelpers._asPreviewUrl.
      const previewUrl = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'preview=1';
      window.open(previewUrl, '_blank', 'noopener');
    } catch (e) {
      if (typeof showToast === 'function') showToast('Could not open preview: ' + (e.message || 'error'), 'error');
    }
  }

  // Expose to window
  window.CustomerPortal = {
    generate: generatePortal,
    preview: previewPortal,
    shareSMS: sharePortalSMS,
    shareEmail: sharePortalEmail,
    mintUrl: mintTokenUrl
  };

})();
// (The data-cp-action="toggleImgFullscreen" delegate was deleted with the dead
// photo-gallery builder — no rendered markup carries that attribute anymore.)
