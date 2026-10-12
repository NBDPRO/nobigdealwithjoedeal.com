/**
 * invite-join.js — the explicit "Join team / Not now" step for a team invite
 * (2026-09-29, the 09-26 handoff's "inviteaccept" lane).
 *
 * claimInvite (functions/handlers/invites.js) no longer claims for someone who
 * owns a company of their own: it answers { reason:'confirm_required',
 * companyId, companyName, role } and only joins on { confirm:true }. This file
 * is the prompt both callers use (dashboard-bootstrap at boot, and the Team
 * tab's "Check my invite now"):
 *
 *   NBDInviteJoin.handle(result, callFn) → 'joined' | 'declined' | 'later' | 'skipped'
 *
 *   - A company Jo already said "Not now" to is skipped at boot. The decline
 *     is stored on userSettings/{uid}.inviteDeclined — NOT nbd_ localStorage,
 *     which sign-out wipes (the reason the old boot flag re-armed).
 *   - Joining asks twice: the second step says plainly that this account
 *     stops working inside its own company.
 *
 * Classic script; Firestore helpers come from dashboard-bootstrap
 * (window.db / doc / getDoc / setDoc). Every value into innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDInviteJoin) return;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ROLE_LABEL = { company_admin: 'an admin', manager: 'a manager', sales_rep: 'a sales rep', viewer: 'a viewer' };
  const uid = () => (window._user && window._user.uid) || null;
  const settingsRef = () => (window.db && window.doc && uid() ? window.doc(window.db, 'userSettings', uid()) : null);

  async function declinedAlready(companyId) {
    const ref = settingsRef();
    if (!ref || !window.getDoc) return false;
    try {
      const snap = await window.getDoc(ref);
      const d = snap.exists() ? (snap.data() || {}) : {};
      return !!(d.inviteDeclined && d.inviteDeclined[companyId]);
    } catch (_) { return false; }
  }
  async function rememberDecline(companyId) {
    const ref = settingsRef();
    if (!ref || !window.setDoc) return;
    try { await window.setDoc(ref, { inviteDeclined: { [companyId]: Date.now() } }, { merge: true }); }
    catch (e) { console.warn('[invite-join] could not save the decline', e && e.code); }
  }

  // One modal, built on demand, using the dashboard's .modal-bg / .modal.
  function ask(html, buttons) {
    return new Promise((resolve) => {
      let bg = document.getElementById('inviteJoinModal');
      if (!bg) {
        bg = document.createElement('div');
        bg.className = 'modal-bg';
        bg.id = 'inviteJoinModal';
        bg.setAttribute('role', 'dialog');
        bg.setAttribute('aria-modal', 'true');
        document.body.appendChild(bg);
      }
      bg.innerHTML = '<div class="modal" style="max-width:440px;">' + html +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;margin-top:18px;">' +
        buttons.map((b) => '<button type="button" class="btn ' + (b.primary ? 'btn-orange' : 'btn-ghost') + '" data-ij="' + b.value + '">' + esc(b.label) + '</button>').join('') +
        '</div></div>';
      bg.classList.add('open');
      const onClick = (ev) => {
        const t = ev.target.closest && ev.target.closest('[data-ij]');
        if (!t) return;
        bg.removeEventListener('click', onClick);
        bg.classList.remove('open');
        resolve(t.dataset.ij);
      };
      bg.addEventListener('click', onClick);
    });
  }

  /**
   * result: a claimInvite answer with reason 'confirm_required'.
   * callFn(payload) → Promise<claimInvite result> (the caller's callable).
   * opts.fromBoot: skip a company this account already declined.
   */
  async function handle(result, callFn, opts) {
    const r = result || {};
    if (r.reason !== 'confirm_required' || !r.companyId) return 'skipped';
    if (opts && opts.fromBoot && await declinedAlready(r.companyId)) return 'skipped';
    const co = esc(r.companyName || 'A team');
    const role = esc(ROLE_LABEL[r.role] || 'a member');

    const first = await ask(
      '<div class="m-modal-bar-eyebrow" style="margin-bottom:6px;">Team invite</div>' +
      '<h3 style="margin:0 0 10px;">' + co + ' invited you to join their team</h3>' +
      '<p style="margin:0;color:var(--m);line-height:1.5;">You would join as ' + role + '. Nothing changes unless you choose Join.</p>',
      [{ value: 'later', label: 'Not now' }, { value: 'join', label: 'Join ' + (r.companyName || 'team'), primary: true }]
    );
    if (first !== 'join') { await rememberDecline(r.companyId); return 'declined'; }

    const second = await ask(
      '<h3 style="margin:0 0 10px;">Switch this account to ' + co + '?</h3>' +
      '<p style="margin:0 0 8px;line-height:1.5;">This account runs its own company in NBD Pro. After joining, you will work inside ' + co +
      '\'s workspace instead: their leads, their pipeline, their settings.</p>' +
      '<p style="margin:0;color:var(--m);line-height:1.5;">Your own company\'s records stay saved, but they will not be what you see. Going back means ' + co + ' removing you from their team.</p>',
      [{ value: 'cancel', label: 'Cancel' }, { value: 'confirm', label: 'Yes, join ' + (r.companyName || 'team'), primary: true }]
    );
    if (second !== 'confirm') return 'later';

    const res = await callFn({ confirm: true });
    const out = (res && res.data) || {};
    return out.claimed ? 'joined' : 'later';
  }

  window.NBDInviteJoin = { handle, _declinedAlready: declinedAlready };
})();
