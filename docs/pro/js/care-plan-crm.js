/**
 * care-plan-crm.js — the Roof Care Plan in the CRM (2026-10-05): the member
 * badge, the customer-page chip + "Add to Care Plan" / "Billing link", the
 * dialog that hands Jo the link to send HIMSELF, and the nav entry for the
 * members view. Loaded (defer) by dashboard.html and customer.html.
 *
 * Membership truth is the server-written mirror leads/{id}.carePlan
 * (functions/care-plan.js webhook; firestore.rules refuse client writes to
 * it). Actions go through the carePlanAdmin callable (App Check — both
 * pages initialise it), which only the platform tenant's owner / company
 * admin may use, and which says whether the plan is switched on
 * (CARE_PLAN_MODE). While it is off, nothing here shows except a badge on
 * a real member.
 *
 * NEVER sends anything. "Text it" / "Email it" open Jo's own Messages /
 * mail app with the text filled in; he presses send there.
 *
 * Design note: documentation/projects/ROOF-CARE-PLAN-2026-10-05.md
 */
(function () {
  'use strict';
  if (window.NBDCarePlan && window.NBDCarePlan.__v === 1) return;

  const FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  const MEMBER_STATUSES = ['active', 'past_due'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, t) => { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); };

  function isMember(lead) {
    const c = lead && lead.carePlan;
    return !!(c && typeof c === 'object' && c.member === true && MEMBER_STATUSES.indexOf(String(c.status || '')) !== -1);
  }
  // Static markup only — no lead text is interpolated.
  function badgeHtml(lead) {
    return isMember(lead) ? '<span class="kc-tag cp-tag" title="Roof Care Plan member">\u{1F6E1} Care Plan</span>' : '';
  }
  function fmtDate(iso) {
    const t = iso ? new Date(iso) : null;
    return t && !isNaN(t.getTime()) ? t.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  }

  // Only the platform tenant's owner / company admin manage the plan (the
  // callable enforces the same); everyone else never even calls it.
  function mayManage() {
    const TR = window.NBDTenantRules;
    if (!TR || typeof TR.isPlatformTenant !== 'function' || !TR.isPlatformTenant()) return false;
    const c = window._userClaims || {};
    const u = (window._user && window._user.uid) || '';
    return c.owner === true || c.role === 'admin' || c.role === 'company_admin' || (!c.role && !!u && (!c.companyId || c.companyId === u));
  }

  async function callable(name, data) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import(FUNCTIONS_SDK);
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    const res = await window._httpsCallable(window._functions, name)(data || {});
    return res && res.data;
  }

  let _statusP = null;
  /** → Promise<'off'|'test'|'live'>; 'off' for anyone who may not manage it. */
  function mode() {
    if (!mayManage()) return Promise.resolve('off');
    if (!_statusP) {
      _statusP = callable('carePlanAdmin', { action: 'status' })
        .then((r) => (r && (r.mode === 'test' || r.mode === 'live')) ? r.mode : 'off')
        .catch(() => { _statusP = null; return 'off'; });
    }
    return _statusP;
  }

  // ── the dialog: a link for Jo to send himself ───────────────────────
  function smsHref(phone, body) {
    const p = String(phone || '').replace(/[^\d+]/g, '');
    return 'sms:' + p + '?&body=' + encodeURIComponent(body);
  }
  function mailHref(email, subject, body) {
    return 'mailto:' + encodeURIComponent(String(email || '')) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  }
  function openLinkDialog(o) {
    let dlg = document.getElementById('cpDialog');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'cpDialog';
      dlg.className = 'cp-dialog';
      dlg.addEventListener('click', (ev) => {
        const b = ev.target.closest && ev.target.closest('[data-cp-dlg]');
        if (!b) { if (ev.target === dlg) dlg.close(); return; }
        const act = b.getAttribute('data-cp-dlg');
        if (act === 'close') dlg.close();
        if (act === 'copy') {
          const input = dlg.querySelector('.cp-link');
          const v = input ? input.value : '';
          (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(v) : Promise.reject(new Error('no clipboard')))
            .then(() => toast('Link copied', 'success'))
            .catch(() => { if (input) { input.select(); } toast('Select the link and copy it', 'info'); });
        }
      });
      document.body.appendChild(dlg);
    }
    const first = String(o.name || '').trim().split(/\s+/)[0] || 'there';
    const text = o.kind === 'portal'
      ? 'Hi ' + first + ', here is the link to manage or cancel your NBD Roof Care Plan: ' + o.url + ' — Joe'
      : 'Hi ' + first + ', here is the link to join the NBD Roof Care Plan — $199 a year or $19 a month, no lock-in, cancel anytime: ' + o.url + ' — Joe';
    const subject = o.kind === 'portal' ? 'Your Roof Care Plan billing link' : 'Your Roof Care Plan sign-up link';
    dlg.innerHTML =
      '<h2>' + esc(o.kind === 'portal' ? 'Billing link for ' + (o.name || 'this member') : 'Roof Care Plan link for ' + (o.name || 'this customer')) + '</h2>' +
      '<p>' + esc(o.kind === 'portal'
        ? 'Opens their Stripe page to update the card or cancel. Nothing is sent until you send it.'
        : 'They pick yearly or monthly and pay on Stripe. The link works for 30 days. Nothing is sent until you send it.') + '</p>' +
      '<input class="cp-link" type="text" readonly aria-label="Link" value="' + esc(o.url) + '">' +
      '<div class="cp-actions">' +
        '<button type="button" class="btn btn-orange" data-cp-dlg="copy">Copy link</button>' +
        (o.phone ? '<a class="btn btn-ghost" href="' + esc(smsHref(o.phone, text)) + '">Text it</a>' : '') +
        (o.email ? '<a class="btn btn-ghost" href="' + esc(mailHref(o.email, subject, text)) + '">Email it</a>' : '') +
        '<button type="button" class="ui-btn-quiet" data-cp-dlg="close">Close</button>' +
      '</div>' +
      '<p class="cp-fine">' + esc('Text it / Email it open your own Messages or mail app with this filled in — you press send.') + '</p>';
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  async function invite(lead) {
    try {
      const r = await callable('carePlanAdmin', { action: 'invite', leadId: lead.id });
      openLinkDialog({ kind: 'invite', url: r.url, name: r.name, phone: r.phone, email: r.email });
    } catch (e) {
      toast(String((e && e.message) || 'Could not make the link').replace(/^.*?:\s*/, ''), 'error');
    }
  }
  async function billingLink(lead) {
    try {
      const r = await callable('carePlanAdmin', { action: 'portal', carePlanId: lead.carePlan.carePlanId });
      const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
      openLinkDialog({ kind: 'portal', url: r.url, name, phone: lead.phone, email: lead.email });
    } catch (e) {
      toast(String((e && e.message) || 'Could not open billing').replace(/^.*?:\s*/, ''), 'error');
    }
  }

  // ── customer page: chip + action ────────────────────────────────────
  function pageLeadId() {
    try { return new URLSearchParams(location.search).get('id') || null; } catch (_) { return null; }
  }
  function currentLead() {
    const id = pageLeadId();
    const d = window._leadDoc;
    return (d && id && d.id === id) ? d : null;
  }
  function renderCustomer(lead, currentMode) {
    const anchor = document.getElementById('daysInStageBadge') || document.getElementById('customerStage');
    if (!anchor || !anchor.parentNode) return;
    let chip = document.getElementById('cpChip');
    let btn = document.getElementById('cpAction');
    const cp = lead.carePlan || null;
    const member = isMember(lead);
    if (member || (cp && cp.status === 'cancelled')) {
      if (!chip) { chip = document.createElement('span'); chip.id = 'cpChip'; anchor.parentNode.insertBefore(chip, anchor.nextSibling); }
      chip.className = 'cp-chip' + (member ? '' : ' is-ended');
      const when = member ? (cp.endsAt ? 'ends ' + fmtDate(cp.endsAt) : (cp.renewsAt ? 'renews ' + fmtDate(cp.renewsAt) : '')) : 'ended';
      chip.textContent = '\u{1F6E1} Care Plan' + (member ? ' member' : '') + (when ? ' · ' + when : '') + (cp.status === 'past_due' ? ' · card failed' : '');
      chip.title = member ? 'Roof Care Plan member — 10% off repairs is applied to repair estimates' : 'Roof Care Plan ended';
    } else if (chip) { chip.remove(); chip = null; }

    const showBtn = mayManage() && (member ? !!(cp && cp.carePlanId) : currentMode !== 'off');
    if (!showBtn) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'cpAction';
      btn.className = 'ui-btn-quiet cp-action';
      btn.addEventListener('click', () => {
        const l = currentLead();
        if (!l) return;
        if (isMember(l)) billingLink(l); else invite(l);
      });
      const after = chip || anchor;
      after.parentNode.insertBefore(btn, after.nextSibling);
    }
    btn.textContent = member ? 'Care Plan billing link' : 'Add to Care Plan';
  }

  // ── dashboard: reveal the members view only when it is on ───────────
  function revealNav(currentMode) {
    if (currentMode === 'off') return;
    document.querySelectorAll('[data-careplan-nav]').forEach((el) => { el.hidden = false; });
  }

  let _lastKey = '';
  function tick() {
    if (document.getElementById('customerName')) {
      const lead = currentLead();
      if (!lead) return false;
      return mode().then((m) => {
        const key = lead.id + '|' + JSON.stringify(lead.carePlan || null) + '|' + m;
        if (key !== _lastKey) { _lastKey = key; renderCustomer(lead, m); }
        return true;
      });
    }
    if (document.querySelector('[data-careplan-nav]')) {
      if (!window._user) return false;
      return mode().then((m) => { revealNav(m); return true; });
    }
    return true;
  }
  // Both pages sign in and load asynchronously; check once a second for up
  // to ~30 s, then keep the customer chip in step with lead refreshes.
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    Promise.resolve(tick()).then((done) => {
      if ((done && !document.getElementById('customerName')) || tries > 30) clearInterval(timer);
    }).catch(() => {});
  }, 1000);

  window.NBDCarePlan = { __v: 1, isMember, badgeHtml, mayManage, mode, invite, billingLink, openLinkDialog, _renderCustomer: renderCustomer, _callable: callable };
})();
