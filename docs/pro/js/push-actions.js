/**
 * push-actions.js — the page half of a push-notification tap.
 *
 * docs/pro/firebase-messaging-sw.js cannot do either of the things a tapped
 * notification needs. It is registered at '/pro/firebase-cloud-messaging-push-scope',
 * NOT '/pro/' (sw.js owns that), so it controls none of the app's windows:
 * client.navigate() always rejects from there — which is why, until 2026-09-05,
 * tapping a push while the CRM was open did nothing at all. And it holds no
 * Firebase auth session, so it cannot write a snooze itself.
 *
 * So the worker decides and posts; this file, running in the page with the
 * session, acts. Messages arrive as
 *   { type:'NBD_PUSH_ACTION', action:'navigate'|'snooze', url, leadId }
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['push-actions']) return;
  __NBD_LOADED['push-actions'] = true;

  const SNOOZE_MS = 60 * 60 * 1000;   // "Snooze 1h", matching the button title

  function toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
    else console.log('[PushActions]', msg);
  }

  /**
   * Only ever navigate within this app. The URL originates in a notification
   * payload, which is server-built today — but a same-origin check costs
   * nothing and means a future payload change can never turn a notification
   * tap into an open redirect.
   */
  function safePath(url) {
    const s = String(url || '');
    if (s.indexOf('/pro/') === 0) return s;          // already app-relative
    try {
      const u = new URL(s, window.location.origin);
      if (u.origin === window.location.origin && u.pathname.indexOf('/pro/') === 0) {
        return u.pathname + u.search + u.hash;
      }
    } catch (e) { /* not a URL */ }
    return null;
  }

  function navigate(url) {
    const target = safePath(url);
    if (!target) return;
    // Same page, different view: let the router handle it rather than
    // reloading the whole CRM.
    const here = window.location.pathname;
    const [pathPart] = target.split('?');
    if (pathPart === here) {
      const params = new URLSearchParams(target.split('?')[1] || '');
      const leadId = params.get('leadId');
      if (leadId && typeof window.openCardDetailModal === 'function') {
        window.openCardDetailModal(leadId);
        return;
      }
    }
    window.location.assign(target);
  }

  // Resolves window.LeadSnooze once it and its Firestore handle (window.db)
  // exist, or null after the timeout. Immediate when both are already there.
  function waitForLeadSnooze(timeoutMs) {
    const ready = () => {
      const LS = window.LeadSnooze;
      return (LS && typeof LS.snooze === 'function' && window.db) ? LS : null;
    };
    const now = ready();
    if (now || typeof setTimeout !== 'function') return Promise.resolve(now);
    const deadline = Date.now() + (timeoutMs == null ? 15000 : timeoutMs);
    return new Promise((resolve) => {
      (function poll() {
        const LS = ready();
        if (LS || Date.now() >= deadline) { resolve(LS); return; }
        setTimeout(poll, 250);
      })();
    });
  }

  async function snooze(leadId) {
    if (!leadId) { toast('Nothing to snooze', 'info'); return; }
    // Prefer whatever the app already uses, so a snooze from a notification is
    // indistinguishable from one made in the UI: LeadSnooze.snooze
    // (lead-snooze.js) writes snoozeCount + snoozedReason and patches the
    // in-memory lead cache. (This used to test window.snoozeLead, which never
    // existed, so every push snooze took the bare fallback write below.)
    // lead-snooze.js and the Firestore bootstrap load AFTER this file, and the
    // ?pushAction=snooze URL is consumed at load — so wait for them briefly.
    const LS = await waitForLeadSnooze();
    if (LS) {
      try {
        await LS.snooze(leadId, new Date(Date.now() + SNOOZE_MS));
        toast('Snoozed for an hour', 'success');
        return;
      } catch (e) { console.warn('[PushActions] LeadSnooze.snooze failed', e); }
    }
    if (!window._db || !window.doc || !window.updateDoc) {
      toast('Could not snooze — open the lead to act on it', 'error');
      return;
    }
    try {
      await window.updateDoc(window.doc(window._db, 'leads', leadId), {
        snoozedUntil: new Date(Date.now() + SNOOZE_MS).toISOString(),
      });
      toast('Snoozed for an hour', 'success');
      if (typeof window.loadLeads === 'function') window.loadLeads();
    } catch (e) {
      console.warn('[PushActions] snooze write failed', e);
      toast('Could not snooze that lead', 'error');
    }
  }

  function handle(msg) {
    if (!msg || msg.type !== 'NBD_PUSH_ACTION') return;
    if (msg.action === 'snooze') snooze(String(msg.leadId || ''));
    else navigate(msg.url);
  }

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      handle(event && event.data);
    });
  }

  // The worker falls back to opening a URL when no window was available; the
  // intent rides in the query string. Consume it once, then strip it so a
  // refresh does not snooze again.
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('pushAction') === 'snooze') {
      const leadId = params.get('leadId') || '';
      params.delete('pushAction');
      const rest = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
      snooze(leadId);
    }
  } catch (e) { /* URLSearchParams unavailable — nothing to consume */ }

  window.NBDPushActions = { handle, safePath };
})();
