/**
 * dashboard-team-owner.js — Team tab owner hand-off (client half).
 *
 * Lazy-loaded by dashboard-team-tab.js through ScriptLoader.load() the first
 * time the Team roster renders. It lives outside dashboard-team-tab.js on
 * purpose: that file is a render-blocking script on dashboard.html and the boot
 * budget (tests/dashboard-boot-budget-2026-10-03.test.js) has no headroom.
 *
 * What it owns (Jo's ruling 2026-10-08, server: transferCompanyOwnership):
 *   - isOwner(): the company keeps its id after a hand-off, so "tenant key ==
 *     my uid" no longer proves ownership. companies/{id}.ownerId decides when
 *     it is readable; the uid comparison stays the fallback.
 *   - decorate(): after the roster renders, adds "Make owner" to an ACTIVE
 *     company_admin (owner viewer only) and flags the former owner's Remove
 *     button. Buttons are built with createElement/textContent and carry
 *     data-team-action, so the existing click delegate in dashboard-team-tab.js
 *     handles them (strict CSP: no inline handlers).
 *   - makeOwner(): confirm, then transferCompanyOwnership { email, confirm:true }
 *     (the server refuses a hand-off without confirm), then a forced token
 *     refresh so this session stops presenting owner controls.
 *   - removeText() / billingNote(): the former-owner remove confirmation and
 *     the "billing is still on their card" toast note.
 *
 * Authority is entirely server-side; nothing here widens what a caller can do.
 */
(function () {
  'use strict';
  var W = window;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function toast(msg, kind) {
    if (typeof showToast === 'function') showToast(msg, kind);
  }
  function findBtn(list, action, email) {
    var bs = list.querySelectorAll('button[data-team-action="' + action + '"]');
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].getAttribute('data-email') === email) return bs[i];
    }
    return null;
  }

  async function isOwner(tenantKey, fallback) {
    try {
      if (W.getDoc && W.doc) {
        var snap = await W.getDoc(W.doc(W.db, 'companies', tenantKey));
        var ownerId = snap && snap.exists() ? ((snap.data() || {}).ownerId || null) : null;
        if (ownerId) return ownerId === W._user.uid;
      }
    } catch (_) { /* keep the uid fallback */ }
    return fallback;
  }

  function decorate(list, docs, tenantKey, isOwnerViewer) {
    docs.forEach(function (d) {
      var m = d.data() || {};
      var status = m.status || 'invited';
      var email = String(m.email || d.id || '');
      if (status === 'active') {
        // Only the owner sees it, only on an active admin with a claimed login.
        if (!(isOwnerViewer && m.role === 'company_admin' && m.uid)) return;
        var dis = findBtn(list, 'disable', email);
        if (!dis || !dis.parentNode || findBtn(list, 'makeowner', email)) return;
        var b = document.createElement('button');
        b.className = 'team-makeowner-btn';
        b.setAttribute('data-team-action', 'makeowner');
        b.setAttribute('data-email', email);
        b.textContent = 'Make owner';
        dis.parentNode.appendChild(b);
      } else if (status !== 'invited' && m.uid && m.uid === tenantKey) {
        // The former owner is the one member whose login is the company id.
        var rm = findBtn(list, 'remove', email);
        if (rm) rm.setAttribute('data-former-owner', '1');
      }
    });
  }

  // Returns true when something was attempted (so the roster should reload),
  // false when the owner cancelled the dialog.
  async function makeOwner(email, btn, call) {
    var ask = W.nbdConfirm || function (m) { return Promise.resolve(W.confirm(m)); };
    var q = 'Make ' + email + ' the owner of this company? They get full owner control: team, billing settings and publishing. You stay on the team as an admin, and only they can hand it back. Billing does not move: the card on file keeps paying until they change it in Settings, Billing. Nothing is charged by this change. Bot keys and calendar links you made are switched off, and if online payments are connected to your payout account the hand-off is refused.';
    if (!(await ask(q))) return false;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
      // transferCompanyOwnership (server): owner-only, same company, the target
      // must be an active, enabled company_admin. Audited.
      await call('transferCompanyOwnership', { email: email, confirm: true });
      try {
        if (W._user) {
          var tr = await W._user.getIdTokenResult(true);
          W._userClaims = (tr && tr.claims) || W._userClaims;
        }
      } catch (_) { /* the next token refresh picks it up */ }
      toast('✓ ' + esc(email) + ' is now the owner. You stay on the team as an admin.', 'success');
    } catch (e) {
      console.warn('team action failed:', e);
      toast('Failed: ' + esc((e && e.message) || 'unknown error'), 'error');
    }
    return true;
  }

  // Former-owner Remove confirmation (the server turns their login off), or ''.
  function removeText(email, btn) {
    if (btn && btn.getAttribute('data-former-owner') === '1') {
      return 'Remove ' + email + '? They are the former owner of this company. Their login for this account is turned off for good, their bot keys and calendar link stop working, and their customers and files move to you.';
    }
    return '';
  }

  // Toast suffix for a removeMember result, or ''.
  function billingNote(res) {
    return res && res.data && res.data.billingOnFormerOwner
      ? '. Billing is still on their card: change it in Settings, Billing.'
      : '';
  }

  W.NBDTeamOwner = {
    isOwner: isOwner,
    decorate: decorate,
    makeOwner: makeOwner,
    removeText: removeText,
    billingNote: billingNote
  };
})();
