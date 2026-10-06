/**
 * customer-smart-followup-panel.js — Wave 113 (suggestion panel on customer page)
 *
 * Full UI for the W111 SmartFollowup engine. Where the W112
 * kanban pill is a glance-level signal, this panel is where the
 * rep ACTS: see the headline, the reasoning, the draft, and
 * one-click execute.
 *
 * Layout (rendered into a host div near the customer page action
 * bar — or auto-injected if the host is missing):
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ ⚡ Urgent · 90% confident                        │
 *   │ Call Sarah — they viewed your estimate 3× today  │
 *   │ Engaged customer (multi-view) but no rep activity│
 *   │ in 24h+. Engaged customers go cold fast — this is│
 *   │ the highest-leverage moment.                     │
 *   │                                                  │
 *   │ Draft (SMS):                                     │
 *   │ ┌──────────────────────────────────────────────┐ │
 *   │ │ Hi Sarah, saw you were just looking at the   │ │
 *   │ │ estimate — happy to walk through any         │ │
 *   │ │ questions. Got a minute?                     │ │
 *   │ └──────────────────────────────────────────────┘ │
 *   │                                                  │
 *   │  [📞 Call]  [💬 Send SMS]  [📧 Email]  [✕ Dismiss]│
 *   └──────────────────────────────────────────────────┘
 *
 * Action buttons:
 *   - Channel-primary action (📞/💬/📧 based on suggestion.channel)
 *     fires PortalLinkHelpers.smsForLead/emailForLead with the
 *     draft pre-filled. The W98 picker integration means the rep
 *     can still swap to a different template — the SmartFollowup
 *     draft becomes one option among the rep's saved templates.
 *   - Other channels render but are de-emphasized
 *   - Dismiss → hides the panel for this lead this session
 *     (W116 will track these dismissals to inform pattern learning)
 *
 * Path-gated to /pro/customer.html. Updates on:
 *   - DOMContentLoaded + 1.5s defer (so caches populate)
 *   - 'nbd:data-refreshed' event
 *
 * Compounds W111 (computeSuggestion), W41/W43/W98 (action
 * helpers + template picker), W85 (modal a11y patterns).
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['customer-smart-followup-panel']) return;
  __NBD_LOADED['customer-smart-followup-panel'] = true;

  const PATH = window.location.pathname || '';
  if (!/\/pro\/customer(?:\.html)?$/.test(PATH)) return;

  // Per-session dismissed set so a rep doesn't see the same
  // suggestion repeatedly after acknowledging it. Cleared on
  // page reload — W116 will persist this to Firestore for
  // pattern learning.
  const _dismissedThisSession = new Set();

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  // ─── Render ──────────────────────────────────────────────────────
  // W114: render-once-then-enrich pattern. The heuristic suggestion
  // appears instantly (no waiting on the network), then we kick off
  // an AI enrichment in the background and re-render with the
  // improved headline/reasoning/draft when it returns. Failures
  // degrade silently — the heuristic version stays visible.
  function update() {
    const host = ensureHost();
    if (!host) return;
    const lead = window._currentLead;
    if (!lead || _dismissedThisSession.has(lead.id)) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    if (!window.SmartFollowup
        || typeof window.SmartFollowup.computeSuggestion !== 'function') {
      host.style.display = 'none';
      return;
    }
    const sug = window.SmartFollowup.computeSuggestion(lead);
    if (!sug || sug.priority === 'wait' || sug.priority === 'monitor') {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    // Render the heuristic version immediately, then enrich.
    _renderSuggestion(host, lead, sug);
    if (typeof window.SmartFollowup.enrichSuggestionAI === 'function') {
      window.SmartFollowup.enrichSuggestionAI(lead).then(enriched => {
        // Defensive: skip if rep navigated to a different lead or
        // dismissed during the API call.
        if (!enriched || _dismissedThisSession.has(lead.id)) return;
        if (!window._currentLead || window._currentLead.id !== lead.id) return;
        // Skip the re-render if AI returned the same heuristic
        // (no enrichment happened — failure or API unavailable).
        if (!enriched._aiEnriched) return;
        _renderSuggestion(host, lead, enriched);
      }).catch(() => { /* silent — heuristic stays visible */ });
    }
  }

  function _renderSuggestion(host, lead, sug) {

    // Color register matches W112 kanban pill so cross-surface
    // priorities read identically. A4 (2026-10-05): the look lives in
    // css/customer-header.css (.csf-*), painted from theme tokens, so it
    // reads on light themes too (the old #fca5a5-style label inks were
    // pale-on-white there). Only the priority picks a class here.
    let tone, icon, label;
    if (sug.priority === 'urgent') {
      tone = 'urgent'; icon = '⚡'; label = 'Urgent';
    } else if (sug.priority === 'today') {
      tone = 'today'; icon = '💡'; label = 'Today';
    } else { // this-week
      tone = 'week'; icon = '👁'; label = 'This week';
    }

    const phone = String(lead.phone || '').replace(/\D+/g, '');
    const email = String(lead.email || '').trim();
    const channel = sug.channel || 'sms';
    const draft = sug.draft || '';

    // Determine which channel button is the primary.
    // Primary = the suggestion's channel (tinted in the priority tone);
    // the others are quiet. Disabled = no contact info on file.
    const callPrimary  = channel === 'call';
    const smsPrimary   = channel === 'sms';
    const emailPrimary = channel === 'email';
    const cls = (primary, on) => 'csf-btn' + (primary ? ' is-primary' : '') + (on ? '' : ' is-off');

    const callBtnHtml = `
      <a class="${cls(callPrimary, phone)}" href="tel:${escapeHtml(phone)}"
        title="Call ${escapeHtml(lead.phone || '')}"
        ${phone ? "" : "data-csfp-stop-self=\"1\""}>📞 Call</a>`;

    const smsBtnHtml = `
      <button class="${cls(smsPrimary, phone)}" type="button" data-csf-action="sms"
        title="Send SMS with the draft below">💬 SMS</button>`;

    const emailBtnHtml = `
      <button class="${cls(emailPrimary, email)}" type="button" data-csf-action="email"
        title="Compose email with the draft below">📧 Email</button>`;

    const dismissBtnHtml = `
      <button class="csf-btn csf-dismiss" type="button" data-csf-action="dismiss"
        title="Dismiss this suggestion (this session only)"
        aria-label="Dismiss suggestion">✕ Dismiss</button>`;

    const draftHtml = draft ? `
      <div class="csf-draft">
        <div class="csf-draft-label">
          Suggested ${escapeHtml(channel === 'email' ? 'email' : 'SMS')} · SMS/Email buttons send this draft
        </div>
        <div data-csf-draft class="csf-draft-text">${escapeHtml(draft)}</div>
      </div>` : '';

    host.innerHTML = `
      <div role="region" aria-label="Smart follow-up suggestion" class="csf-card csf-${tone}">
        <div class="csf-head">
          <span aria-hidden="true" class="csf-icon">${icon}</span>
          <span class="csf-label">${escapeHtml(label)}</span>
          <span class="csf-conf">· ${escapeHtml(String(sug.confidence))}% confident</span>
          ${sug._aiEnriched ? '<span title="AI-enriched suggestion" class="csf-ai">✨ AI</span>' : ''}
        </div>
        <div class="csf-headline">
          ${escapeHtml(sug.headline)}
        </div>
        <div class="csf-why">
          ${escapeHtml(sug.reasoning)}
        </div>
        ${draftHtml}
        <div class="csf-acts">
          ${phone ? callBtnHtml + smsBtnHtml : ''}
          ${email ? emailBtnHtml : ''}
          ${dismissBtnHtml}
        </div>
      </div>`;
    host.style.display = '';
    wireActions(host, lead);
  }

  function wireActions(host, lead) {
    host.querySelectorAll('[data-csf-action]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-csf-action');
        // Prefer the AI-enriched suggestion when the panel already has one
        // (draft text the rep is looking at). Fall back to fresh heuristic.
        const liveSug = (window.SmartFollowup && typeof window.SmartFollowup.computeSuggestion === 'function')
          ? window.SmartFollowup.computeSuggestion(lead) : null;
        // Draft currently rendered in the panel (escape-safe textContent).
        const draftEl = host.querySelector('[data-csf-draft]');
        const draftText = draftEl ? (draftEl.textContent || '').trim() : (liveSug && liveSug.draft) || '';

        if (action === 'sms' || action === 'email') {
          btn.disabled = true;
          try {
            if (window.SmartFollowup && typeof window.SmartFollowup.executeSuggestion === 'function') {
              const channel = action === 'email' ? 'email' : 'sms';
              const result = await window.SmartFollowup.executeSuggestion(lead, liveSug, {
                channel: channel,
                draft: draftText || null,
              });
              // A platform REFUSAL (success:false, mode 'platform') is final on
              // BOTH channels — NBDComms owns the whole outcome and has already
              // told the rep why (SMS: opted out, opt-out status unknown,
              // signed out; email: 401 signed out, 403 role not allowed to
              // send). Falling back to smsForLead/emailForLead re-posted a
              // DIFFERENT message (the portal-link text/email, sent with no
              // further prompt unless the rep has 2+ templates, after minting
              // a portal token) straight after the refusal — a second send
              // attempt the rep never asked for. Refusals are per-channel: an
              // SMS refusal never switches to email here; the Email button
              // stays available for the rep to choose deliberately. Only
              // local pre-flight failures (comms not loaded, a missing
              // contact field, no result) keep the helper fallback — nothing
              // was refused there.
              const refused = !!result && result.success === false && result.mode === 'platform';
              if ((!result || result.success === false) && !refused) {
                // Fallback: portal-link helpers (prefilled native client).
                if (action === 'sms' && window.PortalLinkHelpers
                    && typeof window.PortalLinkHelpers.smsForLead === 'function') {
                  window.PortalLinkHelpers.smsForLead(lead);
                } else if (action === 'email' && window.PortalLinkHelpers
                    && typeof window.PortalLinkHelpers.emailForLead === 'function') {
                  window.PortalLinkHelpers.emailForLead(lead);
                }
              }
            } else if (action === 'sms' && window.PortalLinkHelpers
                && typeof window.PortalLinkHelpers.smsForLead === 'function') {
              if (window.SmartFollowup && window.SmartFollowup.recordOutcome) {
                window.SmartFollowup.recordOutcome(lead.id, 'acted', liveSug);
              }
              window.PortalLinkHelpers.smsForLead(lead);
            } else if (action === 'email' && window.PortalLinkHelpers
                && typeof window.PortalLinkHelpers.emailForLead === 'function') {
              if (window.SmartFollowup && window.SmartFollowup.recordOutcome) {
                window.SmartFollowup.recordOutcome(lead.id, 'acted', liveSug);
              }
              window.PortalLinkHelpers.emailForLead(lead);
            }
          } finally {
            btn.disabled = false;
          }
        } else if (action === 'dismiss') {
          if (window.SmartFollowup && window.SmartFollowup.recordOutcome) {
            window.SmartFollowup.recordOutcome(lead.id, 'dismissed', liveSug);
          }
          _dismissedThisSession.add(lead.id);
          update();
        }
      });
    });
    // W116: also record the call action when the rep clicks the
    // tel: anchor — captures the most-frequent action type in
    // the field.
    host.querySelectorAll('a[href^="tel:"]').forEach(a => {
      a.addEventListener('click', () => {
        if (!window.SmartFollowup || !window.SmartFollowup.recordOutcome) return;
        const sug = (typeof window.SmartFollowup.computeSuggestion === 'function')
          ? window.SmartFollowup.computeSuggestion(lead) : null;
        window.SmartFollowup.recordOutcome(lead.id, 'acted', sug);
      });
    });
  }

  // ─── Host injection ──────────────────────────────────────────────
  // The customer page doesn't have a stable "smart-followup-panel"
  // div by default. Inject one above the action bar (#quick-action-bar
  // or .quick-actions), or fall back to right after the meta-row.
  function ensureHost() {
    let host = document.getElementById('smartFollowupPanel');
    if (host) return host;
    const anchor =
      document.querySelector('.quick-actions') ||
      document.getElementById('customerIdBadge') ||
      document.querySelector('.meta-row');
    if (!anchor || !anchor.parentNode) return null;
    host = document.createElement('div');
    host.id = 'smartFollowupPanel';
    host.style.display = 'none';
    anchor.parentNode.insertBefore(host, anchor);
    return host;
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    setTimeout(update, 1500);
    window.addEventListener('nbd:data-refreshed', update);
  }

  const CustomerSmartFollowupPanel = {
    update,
    dismiss: (id) => { _dismissedThisSession.add(id); update(); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


(function(){if(window._NBD_CSFP_DELEGATE)return;window._NBD_CSFP_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-csfp-stop-self="1"]');if(t&&ev.target===t)ev.preventDefault();});})();
