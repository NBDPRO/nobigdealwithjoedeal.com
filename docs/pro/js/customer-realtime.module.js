
  import {
    collection, query, where, orderBy, onSnapshot, limit
  } from '/assets/vendor/firebase/12.19.0/firebase-firestore.js';
  import {
    getFunctions, httpsCallable
  } from '/assets/vendor/firebase/12.19.0/firebase-functions.js';

  function escMsg(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const opts = sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleString(undefined, opts);
  }

  /**
   * Mount the portal-messages thread for ONE lead.
   *
   * 2026-09-17: extracted from what used to be a bare top-level
   * whenReady().then(...) that ran exactly once per page load, so this
   * feature could also mount inside the mobile job-detail overlay
   * (dashboard.html), which opens/closes the SAME markup for a DIFFERENT
   * lead repeatedly on one page load — a bare "run once" module can't do
   * that. This file is now pure export, no top-level side effects (same
   * split as voice-intelligence.js) — customer.html's auto-mount-once
   * behavior moved to customer-realtime-bootstrap.module.js, which calls
   * this same function; that keeps importing mountMessages elsewhere (e.g.
   * dashboard.html's bridge) from re-triggering an unrelated auto-mount.
   *
   * Callable more than once on one page. cleanup() unsubscribes the
   * snapshot listener AND removes the exact listener functions this mount
   * bound to the compose textarea/button — without that, re-mounting for a
   * second lead without unmounting the first would double-bind Send and
   * fire replyToPortalMessage twice per click.
   *
   * DOM lookups stay global document.getElementById() calls (not scoped to
   * a passed-in container) — deliberately: customer.html and dashboard.html
   * are different pages, so there is no id collision risk, and keeping the
   * lookups unscoped means the mobile job-detail panel just needs to carry
   * the SAME element ids, no querySelector-scoping rewrite of the render
   * logic that customer.html depends on today.
   */
  export function mountMessages({ leadId, db }) {
    let allMessages = [];
    let unsubscribeMessages = null;

    function renderThread() {
      const threadEl = document.getElementById('repMsgThread');
      const emptyEl = document.getElementById('repMsgEmpty');
      if (!threadEl) return;
      if (allMessages.length === 0) {
        Array.from(threadEl.querySelectorAll('.rep-bubble')).forEach(n => n.remove());
        if (emptyEl) emptyEl.style.display = 'block';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      Array.from(threadEl.querySelectorAll('.rep-bubble')).forEach(n => n.remove());

      // Sort oldest-first for natural conversation flow.
      const sorted = [...allMessages].sort((a, b) => {
        const ta = a.createdAt?.toMillis?.() || 0;
        const tb = b.createdAt?.toMillis?.() || 0;
        return ta - tb;
      });
      sorted.forEach(m => {
        const bubble = document.createElement('div');
        bubble.className = 'rep-bubble';
        const isRep = m.source === 'rep';
        // Rep messages on the right (you, the rep, viewing this page).
        bubble.style.cssText =
          'max-width:80%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.45;' +
          'word-wrap:break-word;align-self:' + (isRep ? 'flex-end' : 'flex-start') + ';' +
          'background:' + (isRep ? 'var(--orange, #A14A22)' : 'rgba(255,255,255,0.08)') + ';' +
          'color:' + (isRep ? 'var(--accent-fg)' : 'inherit') + ';' +
          'border-bottom-' + (isRep ? 'right' : 'left') + '-radius:4px;';
        const senderLabel = isRep ? 'You' : 'Homeowner';
        bubble.innerHTML =
          '<div>' + escMsg(m.text) + '</div>' +
          '<div style="font-size:10px;opacity:0.75;margin-top:4px;text-align:' +
            (isRep ? 'right' : 'left') + ';">' +
            escMsg(senderLabel) + ' · ' + escMsg(fmtTime(m.createdAt)) +
          '</div>';
        threadEl.appendChild(bubble);
      });
      // Auto-scroll to latest
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    function updateUnreadBadge() {
      const unread = allMessages.filter(m => m.source === 'homeowner' && !m.readByRecipient).length;
      // Two possible badge ids: customer.html's desktop nav (#msgUnreadBadge)
      // and the mobile job-detail Messages tab (#mJdMsgBadge) — only one of
      // the two exists on any given page, update whichever is present.
      ['msgUnreadBadge', 'mJdMsgBadge'].forEach((id) => {
        const badge = document.getElementById(id);
        if (!badge) return;
        if (unread > 0) {
          badge.textContent = String(unread);
          badge.style.display = 'inline-block';
        } else {
          badge.style.display = 'none';
        }
      });
    }

    const q = query(
      collection(db, 'leads', leadId, 'portal_messages'),
      orderBy('createdAt', 'asc'),
      limit(200)
    );
    unsubscribeMessages = onSnapshot(q,
      (snap) => {
        allMessages = [];
        snap.forEach(d => allMessages.push({ id: d.id, ...d.data() }));
        renderThread();
        updateUnreadBadge();
      },
      (err) => {
        console.warn('[rep-msg] snapshot error:', err.message);
        const threadEl = document.getElementById('repMsgThread');
        if (threadEl) {
          threadEl.innerHTML =
            '<div style="color:#fca5a5;font-size:13px;text-align:center;padding:24px 12px;">' +
            'Could not load messages: ' + escMsg(err.message || err) + '</div>';
        }
      }
    );

    // Wire up compose + send.
    const textEl = document.getElementById('repMsgText');
    const sendBtn = document.getElementById('repMsgSend');
    const statusEl = document.getElementById('repMsgStatus');

    function onInput() {
      const has = textEl.value.trim().length > 0;
      sendBtn.disabled = !has;
      sendBtn.style.opacity = has ? '1' : '0.55';
    }

    async function onSend() {
      const text = textEl.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      const origLabel = sendBtn.textContent;
      sendBtn.textContent = 'Sending…';
      if (statusEl) statusEl.textContent = '';
      try {
        const fn = httpsCallable(getFunctions(), 'replyToPortalMessage');
        const res = await fn({ leadId, text });
        if (res.data && res.data.success) {
          textEl.value = '';
          sendBtn.textContent = origLabel;
          sendBtn.style.opacity = '0.55';
          if (statusEl) statusEl.textContent = 'Sent ✓';
          setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
        } else {
          if (statusEl) statusEl.textContent = 'Send failed.';
          sendBtn.disabled = false;
          sendBtn.textContent = origLabel;
        }
      } catch (err) {
        if (statusEl) {
          statusEl.textContent = 'Error: ' + (err.message || 'try again');
          statusEl.style.color = '#fca5a5';
        }
        sendBtn.disabled = false;
        sendBtn.textContent = origLabel;
      }
    }

    // Bind both-or-neither (matches the pre-refactor `if (!textEl ||
    // !sendBtn) return` guard exactly — one present without the other is a
    // markup bug, not a state either handler can operate in alone: onInput
    // reads sendBtn, onSend reads textEl).
    const composeBound = !!(textEl && sendBtn);
    if (composeBound) {
      textEl.addEventListener('input', onInput);
      sendBtn.addEventListener('click', onSend);
    }

    return {
      cleanup() {
        try { unsubscribeMessages && unsubscribeMessages(); } catch (_) {}
        if (composeBound) {
          textEl.removeEventListener('input', onInput);
          sendBtn.removeEventListener('click', onSend);
        }
      }
    };
  }
