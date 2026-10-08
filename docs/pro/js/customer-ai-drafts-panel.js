/**
 * customer-ai-drafts-panel.js — T-2: AI texting rep UI
 * ═══════════════════════════════════════════════════════════════
 *
 * Surfaces the AI-suggested SMS replies that the incomingSMS webhook
 * generates (handlers/ai-texting.js → /leads/{leadId}/ai_drafts with
 * status:'pending'). Before T-2 those drafts were written to Firestore
 * but nothing displayed them — the AI pipeline was dead-ended. This
 * panel is the rep's review surface:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │ 🤖 AI reply draft · 2m ago                            │
 *   │ They texted: "How much for a new roof?"               │
 *   │ ┌──────────────────────────────────────────────────┐ │
 *   │ │ Joe handles all pricing personally — he'll come  │ │  ← editable
 *   │ │ out, take a look, and put a real number on it.   │ │
 *   │ │ Want to set up a free inspection?                │ │
 *   │ └──────────────────────────────────────────────────┘ │
 *   │             [ ✅ Approve & Send ]   [ ✕ Dismiss ]     │
 *   └──────────────────────────────────────────────────────┘
 *
 * "Approve & Send" writes status:'approved' (+ any edits the rep made
 * to the text). It does NOT send from the browser — the server trigger
 * onAiDraftApproved (functions/sms-functions.js) sends through the
 * Twilio business line so the reply goes out the SAME number the
 * homeowner texted, then flips the draft to 'sent' (or 'failed').
 * "Dismiss" writes status:'dismissed' and the trigger ignores it.
 *
 * The rep never gets a draft sent without tapping approve — there is
 * no autonomous customer-facing send in v1.
 *
 * Path-gated to /pro/customer.html. Refreshes on DOMContentLoaded
 * (+1.5s defer so window._currentLead + the Firestore shims populate)
 * and on the 'nbd:data-refreshed' event. CSP-safe: all actions are
 * delegated off data-* attributes, no inline onclick / no inline
 * <script> (see [[csp-onclick-sweep-shipped]]).
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['customer-ai-drafts-panel']) return;
  __NBD_LOADED['customer-ai-drafts-panel'] = true;

  const PATH = window.location.pathname || '';
  if (!/\/pro\/customer(?:\.html)?$/.test(PATH)) return;

  // Guards against a card whose action is mid-flight, so a double-tap
  // can't fire two approves (which the server trigger would dedupe
  // anyway, but belt-and-suspenders on the client).
  const _busy = new Set();

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function relTime(ts) {
    try {
      const d = ts && typeof ts.toDate === 'function' ? ts.toDate()
        : (ts && ts.seconds ? new Date(ts.seconds * 1000) : null);
      if (!d) return '';
      const secs = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
      if (secs < 60) return 'just now';
      const mins = Math.round(secs / 60);
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.round(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      return Math.round(hrs / 24) + 'd ago';
    } catch (_) { return ''; }
  }

  function currentUserRef() {
    const u = (window._auth && window._auth.currentUser)
      || (window.auth && window.auth.currentUser) || null;
    return u ? (u.uid || u.email || null) : null;
  }

  // ─── Host injection (above the action bar, mirrors W113 panel) ───
  function ensureHost() {
    let host = document.getElementById('aiDraftsPanel');
    if (host) return host;
    const anchor =
      document.querySelector('.quick-actions') ||
      document.getElementById('customerIdBadge') ||
      document.querySelector('.meta-row');
    if (!anchor || !anchor.parentNode) return null;
    host = document.createElement('div');
    host.id = 'aiDraftsPanel';
    host.style.display = 'none';
    anchor.parentNode.insertBefore(host, anchor);
    return host;
  }

  function fsReady() {
    return window.db && window.collection && window.query
      && window.where && window.getDocs && window.doc && window.updateDoc;
  }

  // ─── Fetch pending drafts for the open lead ──────────────────────
  async function fetchPending(leadId) {
    const col = window.collection(window.db, 'leads', leadId, 'ai_drafts');
    // The ai_drafts read rule is PER-DOCUMENT (isOwner(resource.data.userId),
    // firestore.rules). Under Firestore's rules-as-filters model, a LIST query
    // whose constraints don't prove userId==uid is rejected outright with
    // PERMISSION_DENIED — so the query MUST carry where('userId','==',uid).
    // Without it, fetchPending threw for every non-founder (isAdmin is
    // NBD-only), and the approve/send draft cards never rendered for any
    // stranger rep/owner — the AI-texting reply pipeline was dead-ended.
    const uid = (window._auth && window._auth.currentUser && window._auth.currentUser.uid)
      || (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
    if (!uid) return [];
    // Prefer newest-first; fall back to the two-equality query if the
    // [userId,status,generatedAt] composite isn't deployed yet (two equality
    // filters need no composite — Firestore serves them via a zig-zag merge).
    let snap;
    try {
      snap = await window.getDocs(window.query(col,
        window.where('userId', '==', uid),
        window.where('status', '==', 'pending'),
        window.orderBy('generatedAt', 'desc')));
    } catch (_) {
      snap = await window.getDocs(window.query(col,
        window.where('userId', '==', uid),
        window.where('status', '==', 'pending')));
    }
    const out = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Review R6-3-3 (2026-10-07): replies whose send outcome is unknown stay
    // on the card list (with "check before re-sending"), so the rep sees them
    // after a reload too. Two equality filters — no composite needed. A
    // failure here only hides those cards; the pending list still shows.
    try {
      const unsure = await window.getDocs(window.query(col,
        window.where('userId', '==', uid),
        window.where('status', '==', 'send_uncertain')));
      unsure.docs.forEach(d => out.push({ id: d.id, ...d.data() }));
    } catch (_) {}
    return out;
  }

  const UNCERTAIN_MSG = '⚠️ Send outcome unknown — this reply may already have reached the homeowner. '
    + 'Check their text thread before sending it again. It will not be re-sent by itself.';

  // Friendly label for the persona that produced a draft (T-4). Falls back
  // to the rep's identity name, then nothing, for pre-T-4 drafts.
  const PRESET_LABELS = {
    'joe-classic': 'Joe Classic', 'straight-shooter': 'Straight Shooter',
    'friendly-neighbor': 'Friendly Neighbor', 'polished-pro': 'Polished Pro',
    'custom': 'custom persona',
  };
  function personaLabel(draft) {
    if (draft.personaPreset) return PRESET_LABELS[draft.personaPreset] || draft.personaPreset;
    return draft.personaName || '';
  }

  // Which channel will onAiDraftApproved deliver this on? Mirrors
  // functions/ai-draft-routing.js isPortalDraft (channel first, then
  // triggerType) — the rep is the human in the loop and was previously told
  // every draft "sends from the business line", including portal replies that
  // are never texted. Read-only mirror: the client never writes these fields
  // (the ai_drafts update rule allows only status/draftText/edit metadata).
  function isPortalDraft(draft) {
    if (!draft) return false;
    if (draft.channel === 'portal') return true;
    return draft.triggerType === 'portal_message_in';
  }

  // ─── Render ──────────────────────────────────────────────────────
  function cardHtml(draft) {
    // A send_uncertain draft can't be approved (firestore.rules); its main
    // button re-queues it to pending, after the rep has checked the thread.
    const unsure = draft.status === 'send_uncertain';
    const mainAction = unsure ? 'requeue' : 'approve';
    const mainLabel = unsure ? '↩ Not received — back to drafts' : '✅ Approve &amp; Send';
    const statusLine = unsure ? UNCERTAIN_MSG
      : (draft.heldReason === 'quiet_hours' ? '⏸ ' + (draft.heldMessage || 'Held: outside texting hours in the homeowner\'s time zone.') : '');
    const incoming = String(draft.incomingBody || '').trim();
    const draftText = String(draft.draftText || '');
    const when = relTime(draft.generatedAt);
    const incomingHtml = incoming ? `
      <div style="font-size:12px; color:var(--m,#9aa3b2); margin:2px 0 10px;">
        ${isPortalDraft(draft) ? 'They wrote in the portal:' : 'They texted:'}
        <span style="color:var(--t,#e8eaf0);">"${escapeHtml(incoming.slice(0, 280))}"</span>
      </div>` : '';

    return `
      <div class="aidp-card" data-aidp-id="${escapeHtml(draft.id)}"
        data-aidp-original="${escapeHtml(draftText)}"
        data-aidp-portal="${isPortalDraft(draft) ? '1' : '0'}"
        style="background:rgba(99,102,241,0.08); border:1px solid rgba(99,102,241,0.40);
               border-radius:10px; padding:14px 16px; margin:12px 0;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
          <span aria-hidden="true" style="font-size:17px;">🤖</span>
          <span style="font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--purple,#a78bfa);">AI reply draft</span>
          ${when ? `<span style="font-size:11px; color:var(--m,#9aa3b2); font-weight:500;">· ${escapeHtml(when)}</span>` : ''}
          ${personaLabel(draft) ? `<span style="font-size:11px; color:var(--m,#9aa3b2); font-weight:500;" title="The AI persona that drafted this reply">· via ${escapeHtml(personaLabel(draft))}</span>` : ''}
        </div>
        ${incomingHtml}
        <label style="display:block; font-size:10px; font-weight:600; color:var(--m,#9aa3b2);
                      text-transform:uppercase; letter-spacing:0.05em; margin-bottom:5px;">
          Draft (editable) — ${isPortalDraft(draft) ? 'posts to the homeowner portal thread' : 'sends from the business line'}
        </label>
        <textarea class="aidp-text" rows="3"
          aria-label="AI draft reply text (editable)"
          style="width:100%; box-sizing:border-box; resize:vertical; min-height:64px;
                 background:rgba(255,255,255,0.03); color:var(--t,#e8eaf0);
                 border:1px solid var(--br,#2a3344); border-radius:8px;
                 padding:9px 11px; font:inherit; font-size:13px; line-height:1.5;">${escapeHtml(draftText)}</textarea>
        <div style="display:flex; align-items:center; gap:8px; margin-top:11px;">
          <button type="button" data-aidp-action="${mainAction}" class="aidp-btn"
            style="display:inline-flex; align-items:center; gap:6px; padding:9px 16px; border-radius:7px;
                   background:#6366f1; color:#fff; border:1px solid #6366f1;
                   font:inherit; font-size:12px; font-weight:700; cursor:pointer;
                   -webkit-tap-highlight-color:transparent;">${mainLabel}</button>
          <button type="button" data-aidp-action="dismiss" class="aidp-btn"
            title="Discard this draft (won't be sent)"
            style="margin-left:auto; padding:9px 12px; border-radius:7px;
                   background:transparent; color:var(--m,#9aa3b2); border:1px solid var(--br,#2a3344);
                   font:inherit; font-size:12px; font-weight:600; cursor:pointer;
                   -webkit-tap-highlight-color:transparent;">✕ Dismiss</button>
        </div>
        <div class="aidp-status" role="status" aria-live="polite"
          style="font-size:11px; color:var(--m,#9aa3b2); margin-top:8px; min-height:14px;">${escapeHtml(statusLine)}</div>
      </div>`;
  }

  async function update() {
    const host = ensureHost();
    if (!host) return;
    const lead = window._currentLead;
    if (!lead || !lead.id || !fsReady()) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }

    let drafts = [];
    try {
      drafts = await fetchPending(lead.id);
    } catch (e) {
      // Permission or network error — don't surface a broken panel.
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }
    // Guard against a late return after the rep navigated to another lead.
    if (!window._currentLead || window._currentLead.id !== lead.id) return;

    if (!drafts.length) {
      host.style.display = 'none';
      host.innerHTML = '';
      return;
    }

    host.style.display = '';
    host.innerHTML = drafts.map(cardHtml).join('');
  }

  // ─── Actions ─────────────────────────────────────────────────────
  async function handleAction(action, card) {
    const lead = window._currentLead;
    if (!lead || !lead.id) return;
    const draftId = card.getAttribute('data-aidp-id');
    if (!draftId || _busy.has(draftId)) return;

    const statusEl = card.querySelector('.aidp-status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };
    const setBusy = (on) => {
      _busy[on ? 'add' : 'delete'](draftId);
      card.querySelectorAll('.aidp-btn').forEach(b => { b.disabled = on; b.style.opacity = on ? '0.55' : '1'; });
    };

    const ref = window.doc(window.db, 'leads', lead.id, 'ai_drafts', draftId);
    const stamp = window.serverTimestamp ? window.serverTimestamp() : new Date();

    if (action === 'dismiss') {
      setBusy(true); setStatus('Dismissing…');
      try {
        await window.updateDoc(ref, { status: 'dismissed', dismissedAt: stamp });
        card.remove();
        if (window.showToast) window.showToast('Draft dismissed', 'info');
        if (!document.querySelector('#aiDraftsPanel .aidp-card')) {
          const host = document.getElementById('aiDraftsPanel');
          if (host) { host.style.display = 'none'; host.innerHTML = ''; }
        }
      } catch (e) {
        setBusy(false); setStatus('Could not dismiss — try again.');
        if (window.showToast) window.showToast('Dismiss failed: ' + (e && e.message || 'error'), 'error');
      }
      return;
    }

    if (action === 'requeue') {
      // send_uncertain → pending, ONLY on the rep's tap after they checked
      // the thread (R6-3-3). It is not sent here: the card comes back as a
      // normal draft and still needs Approve & Send.
      setBusy(true); setStatus('Putting it back in your drafts…');
      try {
        await window.updateDoc(ref, { status: 'pending' });
        if (window.showToast) window.showToast('Back in your drafts — approve it to send', 'info');
        await update();
      } catch (e) {
        setBusy(false); setStatus('Could not put it back — try again.');
      }
      return;
    }

    if (action === 'approve') {
      const ta = card.querySelector('.aidp-text');
      const edited = (ta ? ta.value : '').trim();
      if (!edited) { setStatus('Add some text before sending.'); if (ta) ta.focus(); return; }
      const original = card.getAttribute('data-aidp-original') || '';
      setBusy(true);
      // Review R2-3-3 (2026-10-06): the list is a one-time getDocs, so this
      // card can be stale — another tab or device may have sent it already.
      // Approve only a draft that is STILL pending (the rules and the trigger
      // refuse anything else too; this tells the rep why).
      try {
        const cur = window.getDoc ? await window.getDoc(ref) : null;
        const st = cur && cur.exists() ? ((cur.data() || {}).status || '') : (cur ? 'gone' : 'pending');
        if (st !== 'pending') {
          setBusy(false);
          setStatus(st === 'sent' ? 'Already sent — this reply went out from another tab or device.' : 'This draft was already handled (' + st + ').');
          if (window.showToast) window.showToast(st === 'sent' ? 'That reply was already sent — not sending it again' : 'That draft was already handled', 'info');
          return;
        }
      } catch (e) {
        setBusy(false); setStatus('Could not check this draft — try again.');
        return;
      }
      setStatus(card.getAttribute('data-aidp-portal') === '1'
        ? 'Approving — posting to the portal thread…'
        : 'Approving — sending from the business line…');
      try {
        await window.updateDoc(ref, {
          status: 'approved',
          draftText: edited,
          editedByRep: edited !== original,
          approvedBy: currentUserRef(),
          approvedAt: stamp,
        });
      } catch (e) {
        setBusy(false); setStatus('Could not send — try again.');
        if (window.showToast) window.showToast('Send failed: ' + (e && e.message || 'error'), 'error');
        return;
      }

      // The write succeeded, but the actual SEND happens server-side
      // (onAiDraftApproved flips status → 'sent' or 'failed'). Previously the
      // card was removed here with an optimistic "sending 📤" toast, so a FAILED
      // send was invisible to the rep — they'd think the customer got a reply
      // that never went out. Poll for the real outcome instead (onSnapshot
      // isn't exposed to this module) and keep the card until we know.
      const hideHostIfEmpty = () => {
        if (!document.querySelector('#aiDraftsPanel .aidp-card')) {
          const host = document.getElementById('aiDraftsPanel');
          if (host) { host.style.display = 'none'; host.innerHTML = ''; }
        }
      };
      setStatus('Sending… 📤');
      let settled = false;
      for (let i = 0; i < 9 && !settled; i++) {
        await new Promise(r => setTimeout(r, 2000));
        let snap;
        try { snap = await window.getDoc(ref); } catch (_) { continue; }
        const d = snap && snap.exists() ? (snap.data() || {}) : null;
        const st = d ? (d.status || 'approved') : null;
        if (st === 'sent') {
          settled = true;
          card.remove();
          if (window.showToast) window.showToast('Reply sent ✅', 'success');
          hideHostIfEmpty();
          // Handshake: refresh Comm Log + smart-followup (same lead thread).
          // Smart-followup panel listens for nbd:data-refreshed (no window export).
          try {
            // loadCommunicationLog: customer-tasks-ui.js, registry-only (Globals
            // Tranche 3 T3-C, 2026-09-18) — absent → skip the refresh.
            const _nbdReg = window.__NBD_CALL_REGISTRY;
            if (_nbdReg && typeof _nbdReg.loadCommunicationLog === 'function' && window._customerId) {
              _nbdReg.loadCommunicationLog(window._customerId);
            }
            window.dispatchEvent(new CustomEvent('nbd:data-refreshed', {
              detail: { source: 'ai-draft-sent', leadId: window._customerId || null },
            }));
          } catch (_) {}
        } else if (st === 'pending' && d.heldReason === 'quiet_hours') {
          // onAiDraftApproved put it back: outside texting hours in the
          // homeowner's time zone (2026-10-05). Nothing was sent; the card
          // stays so the rep can approve it again inside the hours.
          settled = true;
          setBusy(false);
          setStatus('⏸ ' + (d.heldMessage || 'Not sent: it is outside texting hours in the homeowner\'s time zone.'));
          if (window.showToast) window.showToast('AI reply held: outside texting hours', 'warning');
        } else if (st === 'send_uncertain') {
          // Review R6-3-3: Twilio may have taken it (the connection dropped
          // mid-send). NOT reverted to pending — re-approving could text the
          // homeowner twice. The rep checks the thread; the card's button
          // re-queues it only on their tap.
          settled = true;
          setBusy(false);
          setStatus(UNCERTAIN_MSG);
          const mainBtn = card.querySelector('[data-aidp-action="approve"]');
          if (mainBtn) { mainBtn.setAttribute('data-aidp-action', 'requeue'); mainBtn.textContent = '↩ Not received — back to drafts'; }
          if (window.showToast) window.showToast('AI reply: send outcome unknown — check the thread before re-sending', 'warning');
        } else if (st === 'failed') {
          settled = true;
          setBusy(false);
          const reason = d.failureReason || 'unknown error';
          // Surface Twilio/A2P-ish failures clearly (ops dependency).
          const a2pHint = /30034|A2P|unverified|trial/i.test(String(reason))
            ? ' — Twilio/A2P may need setup (Settings or Twilio console).'
            : '';
          setStatus('⚠️ Did NOT send (' + reason + ')' + a2pHint + ' — edit and try again.');
          // Revert to pending so the rep can re-approve after editing. Safe:
          // since R6-3-3 'failed' means Twilio REFUSED it (nothing went out);
          // an unknown outcome is 'send_uncertain' above and is not reverted.
          try { await window.updateDoc(ref, { status: 'pending' }); } catch (_) {}
          if (window.showToast) window.showToast('AI reply did NOT send: ' + reason, 'error');
        }
      }
      if (!settled) {
        // Server trigger slow/down — never claim success; keep the card so the
        // draft isn't silently lost.
        setBusy(false);
        setStatus('Still sending — verify in the lead\'s text thread.');
        if (window.showToast) window.showToast('Send is taking longer than usual — check the thread', 'warning');
      }
    }
  }

  // Delegated click handler scoped to the panel host.
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest && ev.target.closest('#aiDraftsPanel [data-aidp-action]');
    if (!btn) return;
    const card = btn.closest('.aidp-card');
    if (!card) return;
    ev.preventDefault();
    handleAction(btn.getAttribute('data-aidp-action'), card);
  });

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    setTimeout(update, 1500);
    window.addEventListener('nbd:data-refreshed', update);
  }

  const CustomerAiDraftsPanel = {
    update,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
