
// ── Gallery Share Panel Functions ──
// Drives the Customer Sharing panel on customer.html. Every link this
// panel hands out is minted by the one canonical path
// (PortalLinkHelpers.resolveUrl → CustomerPortal.mintUrl →
// createPortalToken), so it is short-lived and revocable.
//
// The panel used to advertise two products — a photos-only "Photo
// Gallery" and a "Full Project Portal" — but both minted the identical
// full-portal token URL (there is no photos-only server view). The
// markup collapsed to one row; generatePhotoPortalLink went with it.

function openGallerySharePanel() {
  const panel = document.getElementById('gallerySharePanel');
  if (!panel) return;
  panel.style.display = 'block';
  // No prefill from the lead doc. lead.portalUrl / lead.photoPortalUrl
  // were the legacy PERMANENT Firebase Storage links that #698/#702
  // retired and scripts/purge-legacy-storage-portals.js deletes — reading
  // them back would put an unrevocable URL in front of the rep again.
  // The input fills in on Generate / 📋, both of which mint a fresh token.
}

async function generateFullPortalLink() {
  const input = document.getElementById('fullPortalUrl');
  if (input) input.value = 'Generating...';
  try {
    if (typeof CustomerPortal === 'undefined') throw new Error('Portal module not loaded');
    const url = await CustomerPortal.generate(window._customerId);
    if (url && input) input.value = url;
    else if (input) input.value = 'Failed — try again';
  } catch (e) {
    if (input) input.value = 'Error: ' + (e.message || '').substring(0, 50);
  }
}

// The 📋 button beside the portal-link input. This used to bare-return
// whenever the input held anything that wasn't already a link — which,
// now that openGallerySharePanel no longer prefills, is EVERY fresh panel
// open. A button labelled "copy" that silently does nothing reads as a
// broken page. Generate-on-demand instead, mirroring quickCopyPortalLink
// below, and echo the URL into the input so the rep can see exactly what
// landed on the clipboard.
async function copyPortalUrl(inputId) {
  const input = document.getElementById(inputId);
  // The generate* handlers park status strings ('Generating...',
  // 'Error: …', 'Failed — try again') in this same input, and the markup
  // ships a 'Click Generate to create link' placeholder. Only an http(s)
  // value is a real link; everything else means "no link yet".
  const current = input ? String(input.value || '') : '';
  let url = /^https?:\/\//.test(current) ? current : null;

  if (!url) {
    if (input) input.value = 'Generating...';
    try {
      url = await _resolvePortalUrl();
      if (input) input.value = url;
    } catch (e) {
      if (input) input.value = 'Error: ' + (e.message || '').substring(0, 50);
      if (typeof showToast === 'function') showToast('Couldn\'t create link: ' + (e.message || 'unknown'), 'error');
      return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    if (typeof showToast === 'function') showToast('Link copied to clipboard', 'success');
    // The share panel's own copy button is a share too. It was the third
    // unrecorded path in this file; quickEmailPortalLink is not, because it
    // delegates wholly to PortalLinkHelpers.emailForLead, which records.
    _recordPortalShare('copy');
  } catch (_) {
    // Safari / insecure context / focus loss. The link is already visible
    // in the input, so select it and let the rep press Ctrl+C.
    if (input) { input.focus(); input.select(); }
    if (typeof showToast === 'function') showToast('Press Ctrl+C to copy', 'info');
  }
}

// Wave 40 + 41 + 42: portal link helpers.
//
// Wave 42 extracted the resolve / copy / SMS logic into a shared
// portal-link-helpers.js module so the same flow works from any
// surface (kanban context menu, recent dropdown, etc.) — not just
// the customer.html buttons. The Wave 40 + 41 button handlers below
// now delegate to that shared API; the button-specific UI bits
// (label restoration, "⏳ Preparing…" state) stay here.
//
// _resolvePortalUrl is the thin local wrapper over that shared API —
// the single entry point every link-producing control on this page
// goes through (copyPortalUrl above, quickCopyPortalLink and
// quickSmsPortalLink below), so there is exactly one minter.
async function _resolvePortalUrl() {
  if (!window._customerId) throw new Error('No customer selected');
  if (window.PortalLinkHelpers) {
    return window.PortalLinkHelpers.resolveUrl(window._customerId);
  }
  // Defensive fallback if the shared module hasn't loaded yet.
  //
  // The original Wave 40 implementation preferred a persisted
  // lead.portalUrl over minting. That is no longer a valid link to hand a
  // homeowner: those are the legacy, permanent, UNREVOCABLE Firebase
  // Storage URLs the token migration retired, and revokePortalToken has
  // never been able to touch one — see the note on
  // PortalLinkHelpers.resolveUrl. Reading it here meant this fallback
  // could still put one in front of a customer, and revoking the lead's
  // access would silently do nothing. Mint, like every other path.
  if (typeof CustomerPortal === 'undefined') throw new Error('Portal module not loaded');
  const url = await CustomerPortal.generate(window._customerId);
  if (!url) throw new Error('Generation failed');
  return url;
}

// Every share entry point must reach PortalLinkHelpers.recordShare, or the
// features downstream of it silently see zero signal: the W44 "last shared"
// chip, W57 fresh pulse, W58 viewed badge, W92 engagement tier, W112 smart
// followup, and the stale-shares / never-shared filters.
//
// The two buttons in this file — the customer page's PRIMARY Copy Portal
// Link and Text Portal Link — never did. They resolve a URL through
// PortalLinkHelpers.resolveUrl, which deliberately does not record (only
// copyForLead / smsForLead do, and these handlers reimplement those rather
// than calling them, to keep their own button-label states). So a rep could
// work the whole deal from the customer page, text the homeowner a working
// link, and the CRM would go on insisting the link had never been sent.
// Every OTHER surface records: dashboard-api.js:517, dashboard-actions.js:1518,
// job-templates-ui.js:1983.
function _recordPortalShare(via) {
  try {
    if (window.PortalLinkHelpers
        && typeof window.PortalLinkHelpers.recordShare === 'function') {
      window.PortalLinkHelpers.recordShare(window._customerId, via);
    }
  } catch (e) {
    // Tracking must never break a share that already succeeded.
    console.warn('[customer-gallery-share] recordShare failed', e && e.message);
  }
}
window.quickCopyPortalLink = async function () {
  const button = document.getElementById('quickCopyPortalBtn');
  const restoreLabel = button ? button.innerHTML : null;
  if (button) {
    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'wait';
    button.innerHTML = '⏳ Copying…';
  }
  try {
    const url = await _resolvePortalUrl();

    // Copy. The async clipboard API requires a user-gesture
    // origin; this function IS called from a click handler so it
    // qualifies. On failure (Safari permission, etc.) we fall back
    // to the share panel so the rep has a visible URL to copy
    // manually.
    let copied = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        copied = true;
      } catch (_) { /* fall through */ }
    }
    if (!copied) {
      // execCommand fallback for older WebKit / non-secure contexts.
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch (_) {}
    }

    if (copied) {
      if (typeof showToast === 'function') showToast('Portal link copied — paste anywhere', 'success');
      // Matches PortalLinkHelpers.copyForLead: record on a confirmed copy
      // only. The manual-select fallback below is not a share — the rep has
      // not been handed the link yet, they are being asked to press Ctrl+C.
      _recordPortalShare('copy');
    } else {
      // Last resort: open the share panel so the rep can copy
      // manually + see exactly what was generated.
      if (typeof openGallerySharePanel === 'function') {
        await openGallerySharePanel();
        const input = document.getElementById('fullPortalUrl');
        if (input) {
          input.value = url;
          input.select();
        }
      }
      if (typeof showToast === 'function') showToast('Couldn\'t auto-copy — link is selected, press Ctrl/Cmd+C', 'info');
    }
  } catch (e) {
    console.warn('[quickCopyPortalLink] failed', e);
    if (typeof showToast === 'function') showToast('Couldn\'t copy link: ' + (e.message || 'unknown'), 'error');
    // Open the share panel so the rep can troubleshoot manually.
    if (typeof openGallerySharePanel === 'function') {
      try { openGallerySharePanel(); } catch (_) {}
    }
  } finally {
    if (button) {
      button.disabled = false;
      button.style.opacity = '';
      button.style.cursor = '';
      if (restoreLabel != null) button.innerHTML = restoreLabel;
    }
  }
};

// Wave 56: open the portal in an iframe modal so the rep can
// preview exactly what the customer will see before sharing.
// Delegates to PortalLinkHelpers.previewForLead.
window.quickPreviewPortalLink = async function () {
  const button = document.getElementById('quickPreviewPortalBtn');
  const restoreLabel = button ? button.innerHTML : null;
  if (button) {
    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'wait';
    button.innerHTML = '⏳ Loading…';
  }
  try {
    if (!window.PortalLinkHelpers) {
      if (typeof showToast === 'function') showToast('Portal helpers not loaded', 'error');
      return;
    }
    await window.PortalLinkHelpers.previewForLead(window._currentLead || { id: window._customerId });
  } finally {
    if (button) {
      button.disabled = false;
      button.style.opacity = '';
      button.style.cursor = '';
      if (restoreLabel != null) button.innerHTML = restoreLabel;
    }
  }
};

// Wave 43: same flow on the email channel. Delegates to
// PortalLinkHelpers.emailForLead for the resolve + mailto: build.
// The button-specific UI bits (label restoration, "⏳ Preparing…"
// state) stay here so the click still feels responsive even when
// the Firestore round-trip takes a beat.
window.quickEmailPortalLink = async function () {
  const button = document.getElementById('quickEmailPortalBtn');
  const restoreLabel = button ? button.innerHTML : null;
  if (button) {
    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'wait';
    button.innerHTML = '⏳ Preparing…';
  }
  try {
    if (!window.PortalLinkHelpers) {
      if (typeof showToast === 'function') showToast('Portal helpers not loaded', 'error');
      return;
    }
    await window.PortalLinkHelpers.emailForLead(window._currentLead || { id: window._customerId });
  } finally {
    if (button) {
      button.disabled = false;
      button.style.opacity = '';
      button.style.cursor = '';
      if (restoreLabel != null) button.innerHTML = restoreLabel;
    }
  }
};

// Wave 41: same generate-or-fetch flow but hand off to the device
// SMS composer with prefilled body. Mid-customer-call use case:
// rep wants to text the portal link to the homeowner with one tap.
window.quickSmsPortalLink = async function () {
  const button = document.getElementById('quickSmsPortalBtn');
  const restoreLabel = button ? button.innerHTML : null;
  if (button) {
    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'wait';
    button.innerHTML = '⏳ Preparing…';
  }
  try {
    const lead = window._currentLead || {};
    const phone = String(lead.phone || '').replace(/\D+/g, '');
    if (!phone) {
      if (typeof showToast === 'function') showToast('No phone number on this customer', 'error');
      return;
    }

    // R6-3-2 (2026-10-07): the server's "ok to text?" (phone-share.js
    // checkText → phoneTextAction: STOP register, Do Not Text list, consent,
    // texting switch, 8am–9pm homeowner time) BEFORE Messages opens with the
    // portal link written in. Started first so it runs while the link
    // resolves; a "no" — or a check that can't run — says why, opens nothing
    // and records no share.
    const PS = window.NBDPhoneShare;
    const leadId = lead.id || window._customerId || '';
    const textCheck = (PS && typeof PS.checkText === 'function')
      ? PS.checkText({ phone: lead.phone, leadId })
      : Promise.resolve(null);

    const url = await _resolvePortalUrl();

    const chk = await textCheck;
    if (!chk || chk.ok !== true) {
      if (typeof showToast === 'function') {
        showToast((chk && chk.reason) || 'Couldn’t check whether this customer can be texted — nothing was sent. Reload and try again.', 'error');
      }
      return;
    }

    // Friendly prefilled body — uses the customer's first name
    // when available so the SMS feels personal. Encoded for the
    // sms: URI scheme. Both ?body= and &body= work depending on
    // platform; we use the more universal ?body= format.
    const firstName = String(lead.firstName || '').trim();
    const greeting = firstName ? `Hi ${firstName}, ` : 'Hi, ';
    const body = `${greeting}here's your project portal — photos, status updates, and what's coming next: ${url}`;

    // Build the sms: URL. Per spec the body parameter goes after
    // the phone, separated by ?body= on iOS and &body= on Android.
    // The platforms tolerate both reasonably; ?body= is the safer
    // default. encodeURIComponent handles spaces + special chars.
    const smsUrl = `sms:${phone}?body=${encodeURIComponent(body)}`;

    // Hand off to the OS. On desktop browsers without an SMS
    // handler this no-ops or prompts the user — the toast
    // confirms what we tried so the rep isn't confused by silent
    // failure.
    window.location.href = smsUrl;
    if (typeof showToast === 'function') {
      showToast(firstName
        ? `Opening SMS to ${firstName}…`
        : 'Opening SMS…', 'success');
    }
    // Matches PortalLinkHelpers.smsForLead: record once the composer has
    // been handed the message. Whether the rep presses send is not
    // observable from here, and the shared helper draws the line in the
    // same place.
    _recordPortalShare('sms');
  } catch (e) {
    console.warn('[quickSmsPortalLink] failed', e);
    if (typeof showToast === 'function') showToast('Couldn\'t prepare SMS: ' + (e.message || 'unknown'), 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.style.opacity = '';
      button.style.cursor = '';
      if (restoreLabel != null) button.innerHTML = restoreLabel;
    }
  }
};
