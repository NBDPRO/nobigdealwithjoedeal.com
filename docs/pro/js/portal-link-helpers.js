/**
 * portal-link-helpers.js — Wave 42 (Shared portal-link helpers)
 *
 * Waves 40 + 41 introduced one-click "Copy Portal Link" and one-tap
 * "Text Portal Link" buttons on the customer detail page. This wave
 * extracts the resolve / copy / SMS logic into a shared module so
 * the same helpers can be invoked from any surface that has a lead
 * — most importantly the kanban context menu (Wave 26), where reps
 * want to grab the link without opening the customer page.
 *
 * The customer.html buttons (W40/W41) keep their existing handlers
 * but delegate here for the actual work — single source of truth
 * for the resolve flow + clipboard fallbacks + SMS body template.
 *
 * Exposes: window.PortalLinkHelpers
 *   .resolveUrl(leadId)         → Promise<string>
 *   .copyForLead(lead)          → Promise<void>  (toast on success/fail)
 *   .smsForLead(lead)           → Promise<void>  (platform SMS, handoff fallback)
 *   .emailForLead(lead)         → Promise<void>  (platform email, handoff fallback)
 */
(function () {
  'use strict';

  if (window.PortalLinkHelpers
      && window.PortalLinkHelpers.__sentinel === 'nbd-portal-link-helpers-v2') return;

  // ─── Helpers ─────────────────────────────────────────────────────
  function _toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  function leadFromIdOrObj(leadOrId) {
    if (!leadOrId) return null;
    if (typeof leadOrId === 'string') {
      if (Array.isArray(window._leads)) {
        return window._leads.find(l => l && l.id === leadOrId) || { id: leadOrId };
      }
      return { id: leadOrId };
    }
    return leadOrId;
  }

  // ─── Share tracking ──────────────────────────────────────────────
  // Wave 44: stamp lead.lastSharedAt + lastSharedVia after each
  // share. Best-effort — fires AFTER the share itself succeeds so a
  // tracking failure can't block the rep from sharing. The in-memory
  // cache is patched first (immediate visual feedback on the kanban
  // + customer page) and the Firestore write is fire-and-forget.
  function _recordShare(leadId, via) {
    if (!leadId || !via) return;
    const now = new Date();

    // Patch in-memory caches so widgets see fresh state without
    // waiting on the Firestore round-trip.
    if (Array.isArray(window._leads)) {
      const i = window._leads.findIndex(l => l && l.id === leadId);
      if (i >= 0) {
        window._leads[i] = {
          ...window._leads[i],
          lastSharedAt: now,
          lastSharedVia: via,
        };
      }
    }
    if (window._currentLead && window._currentLead.id === leadId) {
      window._currentLead = {
        ...window._currentLead,
        lastSharedAt: now,
        lastSharedVia: via,
      };
    }
    try {
      window.dispatchEvent(new CustomEvent('nbd:data-refreshed', {
        detail: { source: 'share-recorded', leadId, via },
      }));
    } catch (_) {}

    // Best-effort Firestore write. Failures are logged but never
    // surface to the user — the share itself already succeeded.
    if (!window.db || !window.doc || !window.updateDoc) return;
    const ref = window.doc(window.db, 'leads', leadId);
    const ts = window.serverTimestamp ? window.serverTimestamp() : now;
    window.updateDoc(ref, { lastSharedAt: ts, lastSharedVia: via })
      .catch(e => console.warn('[PortalLinkHelpers._recordShare] write failed', e.message));
  }

  // ─── Resolve URL ────────────────────────────────────────────────
  // Firestore-first / generate-on-demand. Same flow Waves 40 + 41
  // already implemented inline in customer.html — extracted here so
  // the kanban context menu can reuse it without duplicating.
  // Two minters exist, one per page family, and this module is loaded on BOTH:
  //
  //   customer.html            → window.CustomerPortal.mintUrl  (customer-portal.js)
  //   dashboard(.legacy).html  → window._mintPortalUrl          (dashboard-api.js)
  //
  // Identical contract: async, takes a leadId, returns a fresh token URL,
  // throws on failure. customer-portal.js is loaded on customer.html ONLY, so
  // requiring CustomerPortal here made every portal affordance on both
  // dashboards throw 'Portal module not loaded' — a visible error toast, from
  // ten modules: the kanban context menu, activity feed, global search,
  // notification bell, hot-leads / almost-there / stale-shares widgets,
  // smart-followup (+ briefing) and the dashboard bootstrap.
  //
  // dashboard-api.js already had the right idea — its _mintPortalUrl comment
  // says "anything on the dashboard that needs a portal URL must come through
  // here or it dies at runtime" — but only _sharePortalLink and _mJdShare were
  // ever routed through it. Everything reaching this function still died.
  //
  // Resolving the minter here rather than at each of the ten call sites keeps
  // one resolve flow (clipboard fallbacks, SMS body template, recordShare) and
  // means a future surface can't reintroduce this by picking the wrong minter.
  function _minter() {
    if (window.CustomerPortal && typeof window.CustomerPortal.mintUrl === 'function') {
      return window.CustomerPortal.mintUrl.bind(window.CustomerPortal);
    }
    if (typeof window._mintPortalUrl === 'function') return window._mintPortalUrl;
    return null;
  }

  async function resolveUrl(leadId) {
    if (!leadId) throw new Error('leadId required');
    const mint = _minter();
    if (!mint) throw new Error('Portal module not loaded');
    // Always mint a fresh, revocable token URL (/pro/portal.html?token=…).
    // We deliberately no longer return a persisted lead.portalUrl — those were
    // the legacy, permanent, UNREVOCABLE Firebase Storage links this sweep
    // is retiring. Tokens are cheap (30-day TTL) and revoked together by
    // revokePortalToken({leadId}).
    const url = await mint(leadId);
    if (!url) throw new Error('Could not create portal link');
    return url;
  }

  // shareSSR wiring (2026-09-16): SMS/email bodies want the rich-preview
  // card at /share/<token> (functions/share-ssr.js — validates the same
  // portal_tokens/{token} doc this mints, renders branded OG/Twitter-card
  // meta so iMessage/WhatsApp/etc. show a real preview instead of a bare
  // URL, then hands off to the real /pro/portal.html?token=<token> via its
  // own "View full project →" button). Deliberately scoped to just this
  // helper's two callers (smsForLead, emailForLead) — copyForLead and
  // previewForLead keep resolveUrl's direct portal.html link: an ambiguous-
  // destination copy shouldn't force the extra hop, and the rep's own
  // preview should show the real page, not the preview card.
  function _asShareUrl(portalUrl) {
    try {
      const u = new URL(portalUrl);
      const token = u.searchParams.get('token');
      return token ? u.origin + '/share/' + encodeURIComponent(token) : portalUrl;
    } catch (_) {
      return portalUrl;
    }
  }

  // ─── Copy ───────────────────────────────────────────────────────
  // Mirror of Wave 40's clipboard-with-fallbacks logic. Three layers:
  //   1. navigator.clipboard.writeText (modern, requires user gesture)
  //   2. document.execCommand('copy') via temp textarea (legacy)
  //   3. Open share panel + select URL (only available on customer.html)
  async function copyForLead(leadOrId) {
    const lead = leadFromIdOrObj(leadOrId);
    if (!lead || !lead.id) {
      _toast('No customer selected', 'error');
      return;
    }
    try {
      const url = await resolveUrl(lead.id);

      // Try modern clipboard API.
      let copied = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try {
          await navigator.clipboard.writeText(url);
          copied = true;
        } catch (_) { /* fall through */ }
      }
      // execCommand fallback for older WebKit / non-secure contexts.
      if (!copied) {
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
        _toast('Portal link copied — paste anywhere', 'success');
        _recordShare(lead.id, 'copy');
      } else {
        // On the customer page we can fall back to opening the
        // share panel + selecting the URL. From the kanban context
        // we don't have a panel; just surface the URL in the toast
        // so the rep at least sees what was generated.
        if (typeof window.openGallerySharePanel === 'function') {
          await window.openGallerySharePanel();
          const input = document.getElementById('fullPortalUrl');
          if (input) {
            input.value = url;
            input.select();
          }
          _toast('Couldn\'t auto-copy — link is selected, press Ctrl/Cmd+C', 'info');
        } else {
          _toast('Couldn\'t copy — URL: ' + url, 'info');
        }
      }
    } catch (e) {
      console.warn('[PortalLinkHelpers.copyForLead] failed', e);
      _toast('Couldn\'t copy link: ' + (e.message || 'unknown'), 'error');
    }
  }

  // ─── In-flight guard ────────────────────────────────────────────
  // smsForLead / emailForLead SEND (NBDComms → Twilio / Resend). There
  // is no review step after the template pick, and on the one-template
  // and ⭐-default paths there is no picker at all — so a double-tap on
  // a share button (the caller surfaces don't disable themselves while
  // a share is in flight) landing inside the async portal-token mint
  // sent the homeowner the same text or email twice. Keyed per channel + lead so different
  // leads / channels stay independent; cleared in `finally` so a throw
  // or an early return can never wedge a lead's share button shut.
  const _shareInFlight = new Set();
  function _claimShare(key) {
    if (_shareInFlight.has(key)) {
      _toast('Already sending — one moment', 'info');
      return false;
    }
    _shareInFlight.add(key);
    return true;
  }

  // A portal-link text queued offline (sms-outbox.js) becomes a share when
  // the outbox actually sends it — never at queue time. The send can happen
  // in another tab or on a later page load, so the outbox keeps a receipt and
  // hands it over through onSent(). This file loads BEFORE sms-outbox.js on
  // dashboard.html, hence the ready-event fallback.
  const PORTAL_SMS_SOURCE = 'portal-share-sms';
  function _applyPortalSmsReceipt(d) {
    if (!d || typeof d.sourceRef !== 'string' || !d.sourceRef) return false;
    // _recordShare's Firestore write is best-effort and silently skipped
    // while the page's Firestore globals are not up; keep the receipt until
    // they are (a throw leaves it for the next drain).
    if (!window.db || !window.doc || !window.updateDoc) throw new Error('Firestore not ready');
    _recordShare(d.sourceRef, 'sms');
    return true;
  }
  function _registerPortalSmsReceipts() {
    const ob = window.NBDSmsOutbox;
    if (!ob || typeof ob.onSent !== 'function') return false;
    ob.onSent(PORTAL_SMS_SOURCE, _applyPortalSmsReceipt);
    return true;
  }
  if (!_registerPortalSmsReceipts() && typeof window.addEventListener === 'function') {
    window.addEventListener('nbd:sms-outbox-ready', _registerPortalSmsReceipts, { once: true });
  }

  // ─── SMS ────────────────────────────────────────────────────────
  // Mirror of Wave 41's prefilled-body + sms: handoff. Bails with a
  // toast when the lead has no phone (since there's no phone on the
  // kanban context call site to fall back to).
  async function smsForLead(leadOrId) {
    const lead = leadFromIdOrObj(leadOrId);
    if (!lead || !lead.id) {
      _toast('No customer selected', 'error');
      return;
    }
    const phone = String(lead.phone || '').replace(/\D+/g, '');
    if (!phone) {
      _toast('No phone number on this customer', 'error');
      return;
    }
    const flightKey = 'sms:' + lead.id;
    if (!_claimShare(flightKey)) return;
    try {
      const url = _asShareUrl(await resolveUrl(lead.id));
      const firstName = String(lead.firstName || '').trim();
      const greeting = firstName ? `Hi ${firstName}, ` : 'Hi, ';

      // Wave 98: template picker integration. When the rep has 2+
      // SMS templates saved, open the picker. With 1 template,
      // apply it directly. With 0 templates or "Use built-in
      // default" pick, fall through to the W41 hardcoded body.
      // Cancelled picker (Esc / × / outside click) returns
      // undefined and aborts the send.
      let body;
      if (window.TemplatesLibrary && typeof window.TemplatesLibrary.pickAndRender === 'function') {
        const picked = await window.TemplatesLibrary.pickAndRender('sms', { lead, url });
        if (picked === undefined) {
          // Rep cancelled — abort silently.
          return;
        }
        if (picked && picked.body) {
          body = picked.body;
        }
      }
      if (!body) {
        body = `${greeting}here's your project portal — photos, status updates, and what's coming next: ${url}`;
      }

      // Platform-first (NBDComms → Twilio); falls back to sms: handoff.
      if (window.NBDComms && typeof window.NBDComms.sendSMS === 'function') {
        const result = await window.NBDComms.sendSMS({
          to: lead.phone || phone,
          message: body,
          leadId: lead.id,
          leadStage: typeof lead.stage === 'string' ? lead.stage : undefined,
          source: PORTAL_SMS_SOURCE,
          sourceRef: lead.id,
        });
        // Offline: stored in the outbox, NOT sent — not a share yet. The
        // outbox receipt (_applyPortalSmsReceipt) records it when the text goes.
        if (result && result.success && result.mode === 'queued') {
          return;
        }
        if (result && result.success) {
          _recordShare(lead.id, 'sms');
          return;
        }
        // Hard failure (opt-out / auth) — NBDComms already toasted.
        if (result && result.success === false && result.mode === 'platform') {
          return;
        }
      } else {
        const smsUrl = `sms:${phone}?&body=${encodeURIComponent(body)}`;
        window.location.href = smsUrl;
        _toast(firstName ? `Opening SMS to ${firstName}…` : 'Opening SMS…', 'success');
        _recordShare(lead.id, 'sms');
      }
    } catch (e) {
      console.warn('[PortalLinkHelpers.smsForLead] failed', e);
      _toast('Couldn\'t prepare SMS: ' + (e.message || 'unknown'), 'error');
    } finally {
      _shareInFlight.delete(flightKey);
    }
  }

  // ─── Email ──────────────────────────────────────────────────────
  // Wave 43: mailto: composer with prefilled subject + body. Same
  // shape as smsForLead but on the email channel. Common ask: rep
  // wants to email the portal link to a homeowner who prefers
  // email over text, or who's sharing with their spouse.
  //
  // mailto: line breaks: per RFC 6068 use %0D%0A (CRLF). encodeURI
  // doesn't escape %0A but encodeURIComponent does, so we
  // pre-encode the body manually as a multi-line plaintext.
  async function emailForLead(leadOrId) {
    const lead = leadFromIdOrObj(leadOrId);
    if (!lead || !lead.id) {
      _toast('No customer selected', 'error');
      return;
    }
    const email = String(lead.email || '').trim();
    if (!email) {
      _toast('No email on this customer', 'error');
      return;
    }
    const flightKey = 'email:' + lead.id;
    if (!_claimShare(flightKey)) return;
    try {
      const url = _asShareUrl(await resolveUrl(lead.id));
      const firstName = String(lead.firstName || '').trim();
      const greeting = firstName ? `Hi ${firstName},` : 'Hi,';

      // Wave 98: same template picker integration as smsForLead.
      // Returns { body, subject } when picked, null on "Use
      // default", undefined on cancel.
      let subject;
      let body;
      if (window.TemplatesLibrary && typeof window.TemplatesLibrary.pickAndRender === 'function') {
        const picked = await window.TemplatesLibrary.pickAndRender('email', { lead, url });
        if (picked === undefined) return; // cancelled
        if (picked) {
          if (picked.subject) subject = picked.subject;
          if (picked.body)    body    = picked.body;
        }
      }
      if (!subject) subject = 'Your project portal — photos, status, and next steps';
      // Brand signature: prefer tenant company name when available.
      let brand = 'your contractor';
      try {
        if (window.emailSystem && typeof window.emailSystem._brandFields === 'function') {
          const bf = window.emailSystem._brandFields() || {};
          brand = bf.companyName || bf.companyNameShort || brand;
        } else if (window._companyProfile && window._companyProfile.name) {
          brand = window._companyProfile.name;
        }
      } catch (_) {}
      if (!body) body =
`${greeting}

Here's your project portal — photos from your inspection / install, status updates, and what's coming next:

${url}

Bookmark it; the link stays live as we work through the project.

— ${brand}`;

      if (window.NBDComms && typeof window.NBDComms.sendEmail === 'function') {
        const result = await window.NBDComms.sendEmail({
          to: email,
          subject: subject,
          body: body,
          leadId: lead.id,
          kind: 'portal_link', // transactional: the portal for this customer's job
        });
        if (result && result.success) {
          _recordShare(lead.id, 'email');
          return;
        }
        if (result && result.success === false && result.mode === 'platform') {
          return;
        }
      } else {
        const mailUrl =
          'mailto:' + encodeURIComponent(email) +
          '?subject=' + encodeURIComponent(subject) +
          '&body=' + encodeURIComponent(body);
        window.location.href = mailUrl;
        _toast(firstName ? `Opening email to ${firstName}…` : 'Opening email…', 'success');
        _recordShare(lead.id, 'email');
      }
    } catch (e) {
      console.warn('[PortalLinkHelpers.emailForLead] failed', e);
      _toast('Couldn\'t prepare email: ' + (e.message || 'unknown'), 'error');
    } finally {
      _shareInFlight.delete(flightKey);
    }
  }

  // ─── Preview ────────────────────────────────────────────────────
  // Wave 56: open the portal in an iframe modal so the rep sees
  // exactly what the homeowner will see before sharing the link.
  // Real concern from the field: reps wonder "did I update that
  // photo gallery yet?" or "does the timeline show the right
  // status?" before they fire off an SMS. Preview gives them a
  // quick visual check.
  //
  // Modal pattern matches the W36 customer-snooze-banner overlay
  // and W23 data-import dialog — fixed inset overlay with one
  // dismissable backdrop click + Esc key + X button.
  async function previewForLead(leadOrId) {
    const lead = leadFromIdOrObj(leadOrId);
    if (!lead || !lead.id) {
      _toast('No customer selected', 'error');
      return;
    }
    let url;
    try {
      url = await resolveUrl(lead.id);
    } catch (e) {
      _toast('Couldn\'t prepare preview: ' + (e.message || 'unknown'), 'error');
      return;
    }
    _openPreviewModal(url, lead);
  }

  // ─── Did the real portal actually render in there? ──────────────
  // portal.html ships <main id="mainWrap"> in its STATIC markup, so the
  // element exists the moment `load` fires — before any callable
  // resolves. Its presence is positive proof that our document is what
  // rendered, and it is the only signal that separates all four
  // outcomes:
  //
  //   real portal             → #mainWrap present           → success
  //   X-Frame-Options refusal → opaque frame, OR a readable
  //                             empty one, depending on the
  //                             engine (measured against
  //                             production 2026-09-08: Chrome
  //                             leaves it opaque and throws
  //                             SecurityError on access)     → blocked
  //   privacy-shield block    → shield's injected page       → blocked
  //   redirect elsewhere      → some other document          → blocked
  //
  // The refusal case is exactly what the old probe scored as SUCCESS:
  // it threw, the throw was read as a healthy cross-origin load, and
  // the overlay was HIDDEN over an empty frame. That is why the symptom
  // was a blank white panel rather than the warning this modal ships —
  // the detector dismissed its own explanation.
  //
  // An expired or revoked token still renders #mainWrap and the
  // portal's own error state. That counts as SUCCESS on purpose: the
  // preview did load, and a rep previewing a dead link needs to see
  // exactly what the homeowner would see.
  //
  // Exported on the namespace so tests can drive it against fake
  // frames rather than regex-matching this file.
  var PORTAL_FRAME_SENTINEL = 'mainWrap';
  function _portalRenderedInFrame(frame) {
    try {
      if (!frame) return false;
      var doc = frame.contentDocument;
      if (!doc) return false;
      return !!doc.getElementById(PORTAL_FRAME_SENTINEL);
    } catch (_) {
      // The portal URL is same-origin, so a readable document is the
      // norm and a SecurityError means something we did not navigate
      // to is sitting in the frame. Treat it as blocked.
      return false;
    }
  }

  // A rep looking at the portal is not a customer visit. portal.js suppresses
  // its audit events when it detects it is framed, which covers this modal —
  // but "Open ↗" and the customer page's 👁 button open the REAL portal in a
  // tab, unframed, and have done since they shipped. Untagged, those emit
  // portal_open and estimate_view as the homeowner: the latter fires the
  // rep's own "customer is viewing your estimate" push and then de-dupes the
  // genuine open away. Tag every rep-initiated open.
  function _asPreviewUrl(url) {
    const s = String(url == null ? '' : url);
    if (!s) return s;
    if (/[?&]preview=1(&|$)/.test(s)) return s;
    const hash = s.indexOf('#');
    const base = hash >= 0 ? s.slice(0, hash) : s;
    const frag = hash >= 0 ? s.slice(hash) : '';
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'preview=1' + frag;
  }

  function _openPreviewModal(url, lead) {
    _closePreviewModal(); // be defensive about double-opens
    url = _asPreviewUrl(url);
    const overlay = document.createElement('div');
    overlay.id = 'nbd-portal-preview-overlay';
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:99997;
      background:rgba(0,0,0,0.65);
      display:flex; align-items:center; justify-content:center;
      padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;
    const name = leadFromIdOrObj(lead) ?
      (`${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'customer') : 'customer';
    overlay.innerHTML = `
      <div style="
        background:var(--s,#1a1f2a); color:var(--t,#e8eaf0);
        border:1px solid var(--br,#2a3344); border-radius:14px;
        width:100%; max-width:500px; height:min(85vh, 800px);
        display:flex; flex-direction:column;
        box-shadow:0 12px 40px rgba(0,0,0,0.5);
        overflow:hidden;">
        <div style="
          display:flex; align-items:center; justify-content:space-between;
          gap:8px; padding:14px 18px;
          border-bottom:1px solid var(--br,#2a3344);">
          <div style="min-width:0;">
            <div style="font-size:14px; font-weight:700; color:var(--t,#e8eaf0); line-height:1.2;">
              🔍 Portal preview
            </div>
            <div style="font-size:11px; color:var(--m,#9aa3b2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
              What ${escapeText(name)} will see
            </div>
          </div>
          <div style="display:flex; gap:6px; flex-shrink:0;">
            <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
              title="Open in a new tab"
              style="
                display:flex; align-items:center; justify-content:center;
                width:32px; height:32px; border-radius:7px;
                background:var(--s2,#0f1419); color:var(--t,#e8eaf0);
                text-decoration:none; font-size:14px;
                border:1px solid var(--br,#2a3344);
                -webkit-tap-highlight-color:transparent;">↗</a>
            <button id="nbd-portal-preview-close" type="button" aria-label="Close"
              style="
                display:flex; align-items:center; justify-content:center;
                width:32px; height:32px; border-radius:7px;
                background:var(--s2,#0f1419); color:var(--t,#e8eaf0);
                border:1px solid var(--br,#2a3344); cursor:pointer;
                font-size:16px; line-height:1;
                -webkit-tap-highlight-color:transparent;">×</button>
          </div>
        </div>
        <div style="position:relative; flex:1; min-height:0; background:#fff;">
          <iframe id="nbd-portal-preview-iframe"
            src="${escapeAttr(url)}"
            style="position:absolute; inset:0; width:100%; height:100%; border:none; background:#fff;"
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
          ></iframe>
          <!-- Overlay sits ON TOP of the iframe with two states.
               "loading" shows while we wait for the iframe to load
               and our cross-origin probe to confirm a real portal
               loaded (vs Brave shields injecting a same-origin
               block page). "blocked" replaces it when the probe
               sees a non-cross-origin response OR the load times
               out. On confirmed real load the overlay is hidden,
               revealing the iframe underneath. -->
          <div id="nbd-portal-preview-overlay-state"
            data-state="loading"
            style="
              position:absolute; inset:0;
              display:flex;
              flex-direction:column; align-items:center; justify-content:center;
              gap:14px; padding:24px;
              background:#f7f8fb; color:#1a1f2a; text-align:center;
              font-family:'Barlow',-apple-system,system-ui,sans-serif;">
            <div data-state-loading style="display:flex; flex-direction:column; align-items:center; gap:14px;">
              <div style="
                width:36px; height:36px; border-radius:50%;
                border:3px solid #e1e5ec; border-top-color:var(--orange,#BD5728);
                animation:nbdPortalPreviewSpin 0.9s linear infinite;"></div>
              <div style="font-size:13px; color:#5a6478;">Loading preview…</div>
            </div>
            <div data-state-blocked style="display:none; flex-direction:column; align-items:center; gap:14px;">
              <div style="font-size:32px; line-height:1;">🛡️</div>
              <div style="font-size:14px; font-weight:700; max-width:340px;">
                This preview couldn't be embedded
              </div>
              <div style="font-size:12px; color:#5a6478; max-width:340px; line-height:1.45;">
                A privacy shield or extension may be blocking it.
                <strong>Open in new tab</strong> below shows the live portal,
                exactly as the homeowner sees it.
              </div>
            </div>
          </div>
          <style>@keyframes nbdPortalPreviewSpin { to { transform: rotate(360deg); } }</style>
        </div>
        <div style="
          display:flex; align-items:center; justify-content:space-between;
          gap:12px; padding:12px 18px;
          border-top:1px solid var(--br,#2a3344);
          background:var(--s2,#0f1419); flex-shrink:0;">
          <div style="font-size:11px; color:var(--m,#9aa3b2); line-height:1.4; min-width:0;">
            This is the live portal, exactly as the homeowner sees it. Open in a new tab for the full-width view.
          </div>
          <a href="${escapeAttr(url)}" target="_blank" rel="noopener"
            style="
              flex-shrink:0;
              display:inline-flex; align-items:center; gap:6px;
              padding:8px 14px; border-radius:7px;
              background:var(--orange,#BD5728); color:#fff;
              text-decoration:none; font-size:12px; font-weight:700;
              letter-spacing:.04em; text-transform:uppercase;
              -webkit-tap-highlight-color:transparent;">Open ↗</a>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Backdrop click dismisses (but not clicks inside the modal).
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) _closePreviewModal();
    });
    overlay.querySelector('#nbd-portal-preview-close')
      .addEventListener('click', _closePreviewModal);

    // Esc key dismisses. Single-use listener removed on close.
    document.addEventListener('keydown', _onPreviewKeydown);

    // ─── Block detection ────────────────────────────────────────
    // 2026-09-08: this probe was inverted, and had been since the
    // portal URL stopped being cross-origin.
    //
    // It was written when resolveUrl returned a Firebase Storage
    // getDownloadURL, so it reasoned: a cross-origin frame throws on
    // contentWindow access, therefore a THROW means success and a
    // successful READ means a privacy shield injected a same-origin
    // block page. resolveUrl now mints /pro/portal.html?token=… —
    // same origin, by design, and it returns nothing else. So a
    // perfectly good load reads fine and the modal declared it
    // blocked, telling the rep their browser was at fault.
    //
    // It was wrong in the other direction too, on the very failure it
    // existed to catch. Measured against production on 2026-09-08: a
    // refused frame is OPAQUE in Chrome, so contentWindow access threw,
    // the throw scored as a healthy cross-origin load, and the overlay
    // was hidden over an empty frame. The rep got a blank white panel
    // and no explanation — which is the symptom that was reported.
    //
    // It could not have been right either way: /pro/portal inherited
    // the global ** rule's X-Frame-Options: DENY and
    // frame-ancestors 'none', so the embed was refused in every
    // browser from this modal's first day. firebase.json now carries
    // a /pro/portal framing override (same-origin only) alongside
    // this change — BOTH are required; neither works alone.
    //
    // Detection is positive now: see _portalRenderedInFrame above.
    // 3.5s timeout safety net for browsers that fully cancel the
    // navigation (no load + no error events).
    const iframe = overlay.querySelector('#nbd-portal-preview-iframe');
    const stateEl = overlay.querySelector('#nbd-portal-preview-overlay-state');
    let resolved = false;
    function _showBlocked() {
      if (resolved) return;
      resolved = true;
      if (!stateEl) return;
      stateEl.setAttribute('data-state', 'blocked');
      const loadingPanel = stateEl.querySelector('[data-state-loading]');
      const blockedPanel = stateEl.querySelector('[data-state-blocked]');
      if (loadingPanel) loadingPanel.style.display = 'none';
      if (blockedPanel) blockedPanel.style.display = 'flex';
    }
    function _hideOverlay() {
      if (resolved) return;
      resolved = true;
      if (stateEl) stateEl.style.display = 'none';
    }
    if (iframe) {
      iframe.addEventListener('load', () => {
        if (_portalRenderedInFrame(iframe)) _hideOverlay();
        else _showBlocked();
      });
      iframe.addEventListener('error', _showBlocked);
    }
    setTimeout(_showBlocked, 3500);
  }

  function _onPreviewKeydown(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      _closePreviewModal();
    }
  }

  function _closePreviewModal() {
    const el = document.getElementById('nbd-portal-preview-overlay');
    if (el) el.remove();
    document.removeEventListener('keydown', _onPreviewKeydown);
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function escapeAttr(s) { return escapeText(s); }

  window.PortalLinkHelpers = {
    __sentinel: 'nbd-portal-link-helpers-v2',
    resolveUrl,
    copyForLead,
    smsForLead,
    emailForLead,
    previewForLead,
    // Exposed for tests/portal-preview-framing.test.js, which drives the
    // real detection against fake frames (about:blank, a shield's block
    // page, the portal itself) instead of asserting on this file's text.
    _portalRenderedInFrame,
    // Audit E: exposed so dashboard.html's _sharePortalLink (which uses
    // a different URL scheme via the createPortalToken callable) can
    // still participate in W44 share tracking. Every share entry point
    // must reach this function or downstream features (W57 fresh
    // pulse, W58 viewed badge, W92 engagement tier, W112 smart
    // followup, stale-shares filter) silently see zero signal.
    recordShare: _recordShare,
  };
})();
