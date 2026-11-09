/**
 * project-consent.js — the project-page consent tick on the customer page
 * (2026-11-09, content plan §2 step 1).
 *
 * leads/{id}.projectConsent = { on: true|false, by: <uid>, at: <server time> }.
 * on === true is the only way a job can become a public project page: it is
 * what scripts/draft-project-page.mjs checks before it drafts a
 * docs/assets/data/projects.json entry (consentOnFile: true). Jo confirms each
 * job himself, so only the owner side may set or clear it: a platform admin,
 * the lead's company_admin, or a solo operator who owns the lead. That is
 * enforced by firestore.rules (projectConsentWriteOk); canSet() below only
 * mirrors it so a manager or rep sees the state with no live checkbox.
 *
 * LAZY. Nothing here runs at boot. The #projectConsentBtn button dispatches
 * ScriptLoader.load('js/project-consent.js?v=1') through the page's
 * data-action delegate (customer-tasks-ui.js); when this file runs it
 * re-points the button at NBDProjectConsent.open and opens the panel once.
 *
 * Opening a GitHub PR from the CRM is out of scope (no GitHub credentials on
 * the server). For a consented job the panel shows the dry-run command to run
 * from the repo, with a Copy button.
 *
 * CSP: no inline handlers or style attributes; the checkbox and Copy button
 * dispatch through the same delegate (data-change-action / data-action).
 * Tested by tests/project-consent-ui-2026-11-09.test.js.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var w = window;
  if (w.NBDProjectConsent) { w.NBDProjectConsent.open(); return; }

  var BTN = 'projectConsentBtn';
  var PANEL = 'projectConsentPanel';

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function lead() { return w._currentLead || {}; }

  // The rules' writer set (firestore.rules confirmedSourceRoleOk): platform
  // admin; company_admin of the lead's own company; a solo operator (no role,
  // no foreign companyId) who owns the lead.
  function canSet(c, u, l) {
    c = c || {}; l = l || {};
    if (!u) return false;
    var role = c.role || '';
    if (role === 'admin') return true;
    if (role === 'company_admin') return !!c.companyId && l.companyId === c.companyId;
    if (role) return false;
    return l.userId === u && (!c.companyId || c.companyId === u);
  }

  function isOn(l) { return !!(l && l.projectConsent && l.projectConsent.on === true); }

  // Project pages go on ONE website, NBD's. The tick (and the draft command)
  // is only for an NBD job seen by NBD: the signed-in identity is the NBD
  // platform tenant (company-profile.js _isNbdPlatformTenant, keyed on the
  // companyId claim) AND the lead is that same tenant's (companyId, or userId
  // on a legacy lead). Another tenant's homeowner never agreed to NBD's site,
  // and a platform admin opening another tenant's lead gets no tick either.
  // scripts/draft-project-page.mjs refuses any other tenant's lead as well.
  function siteJob(c, u, l) {
    c = c || {}; l = l || {};
    var nbd = false;
    try { nbd = typeof w._isNbdPlatformTenant === 'function' && w._isNbdPlatformTenant() === true; } catch (_) { nbd = false; }
    if (!nbd || !u) return false;
    var mine = String(c.companyId || u);
    var theirs = String(l.companyId || l.userId || '');
    return !!theirs && theirs === mine;
  }

  function patchFor(on, u, ts) { return { projectConsent: { on: on === true, by: u, at: ts } }; }

  // The dry-run command for a consented job. Lead ids are Firestore ids; anything
  // outside [A-Za-z0-9_-] is refused rather than quoted into a shell line.
  function commandFor(leadId) {
    var id = String(leadId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return '';
    return 'node scripts/draft-project-page.mjs --lead ' + id;
  }

  function stampText(pc) {
    if (!pc || !pc.at) return '';
    var d = pc.at && typeof pc.at.toDate === 'function' ? pc.at.toDate() : new Date(pc.at);
    if (isNaN(d.getTime())) return '';
    var who = pc.by && pc.by === uid() ? 'you' : 'the owner';
    return (pc.on === true ? 'Ticked' : 'Cleared') + ' by ' + who + ' on '
      + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + '.';
  }

  function render() {
    var el = document.getElementById(PANEL);
    if (!el) return;
    var l = lead();
    if (!siteJob(claims(), uid(), l)) {
      el.innerHTML = '<div class="pc-title"><strong>Project page consent</strong></div>'
        + '<div class="pc-meta">Project pages are published on the No Big Deal website, for No Big Deal jobs only. '
        + 'There is nothing to tick for this job.</div>';
      el.hidden = false;
      return;
    }
    var on = isOn(l);
    var can = canSet(claims(), uid(), l);
    var cmd = on ? commandFor(w._customerId) : '';
    el.innerHTML =
      '<div class="pc-title"><strong>Project page consent</strong></div>'
      + '<label class="pc-tick"><input type="checkbox" id="pcTick" data-change-action="NBDProjectConsent.toggle" data-pass-el="true"'
      + (on ? ' checked' : '') + (can ? '' : ' disabled') + '> '
      + 'The homeowner agreed this job can be shown as a project page on the website (photos of the house, town only, never the address).</label>'
      + '<div class="pc-meta">' + esc(stampText(l.projectConsent))
      + (can ? '' : ' Only the owner can change this.') + '</div>'
      + (cmd
        ? '<div class="pc-cmd">Draft the page from the repo (dry run; add --write to add it to projects.json):'
          + ' <code id="pcCmd">' + esc(cmd) + '</code>'
          + ' <button type="button" class="btn btn-ghost" data-action="NBDProjectConsent.copyCommand">Copy</button></div>'
        : '');
    el.hidden = false;
  }

  function open() {
    var el = document.getElementById(PANEL);
    if (!el) return;
    if (!el.hidden && el.innerHTML) { el.hidden = true; return; }
    render();
  }

  async function setConsent(on) {
    var l = lead();
    var u = uid();
    var leadId = w._customerId;
    if (!siteJob(claims(), u, l)) { toast('Project pages are for No Big Deal jobs only', 'error'); render(); return; }
    if (!canSet(claims(), u, l)) { toast('Only the owner can set project page consent', 'error'); render(); return; }
    if (!leadId || !w.db || typeof w.updateDoc !== 'function' || typeof w.doc !== 'function') { toast('Customer not loaded yet', 'error'); return; }
    var ts = typeof w.serverTimestamp === 'function' ? w.serverTimestamp() : new Date();
    var patch = patchFor(on, u, ts);
    patch.updatedAt = ts;
    try {
      await w.updateDoc(w.doc(w.db, 'leads', leadId), patch);
      if (w._currentLead) w._currentLead.projectConsent = { on: on === true, by: u, at: new Date() };
      toast(on ? 'Consent on file for a project page' : 'Project page consent cleared', 'success');
    } catch (e) {
      console.warn('[project-consent]', e && e.message);
      toast('Could not save consent', 'error');
    }
    render();
  }

  function toggle(el) { return setConsent(!!(el && el.checked)); }

  function copyCommand() {
    var cmd = commandFor(w._customerId);
    if (!cmd) return;
    var nav = w.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(cmd).then(function () { toast('Command copied', 'success'); }, function () { toast('Copy failed: select the command and copy it', 'error'); });
    } else {
      toast('Select the command and copy it', 'info');
    }
  }

  w.NBDProjectConsent = { canSet: canSet, siteJob: siteJob, isOn: isOn, patchFor: patchFor, commandFor: commandFor,
    open: open, render: render, setConsent: setConsent, toggle: toggle, copyCommand: copyCommand };

  // First tap: the button loaded this file. Point it at open() from now on, then open.
  var btn = document.getElementById(BTN);
  if (btn) {
    btn.setAttribute('data-action', 'NBDProjectConsent.open');
    btn.removeAttribute('data-arg');
  }
  open();
})();
