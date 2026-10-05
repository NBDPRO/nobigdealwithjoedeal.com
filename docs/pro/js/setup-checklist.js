/**
 * setup-checklist.js — the new-owner setup checklist on Home (2026-10-04,
 * tenant-ready). A contractor who signs up should get from "empty account" to
 * "sending a real estimate" without Jo on the phone:
 *
 *   1. Brand          — company name + phone (Settings → Company Profile)
 *   2. Import leads   — CSV import (one-time allowance, not the monthly cap)
 *   3. Set prices     — package prices saved for the company
 *   4. Invite team    — or "I work solo" (skip)
 *   5. Connect Stripe — card payments need a ready Connect account
 *   6. Publish site   — the owner's "Publish my site" action, ONLY when this
 *                       build has it (feature-detected: the
 *                       __NBD_CALL_REGISTRY._publishSite handler, PR #2142)
 *   7. First estimate
 *
 * Who sees it: the company's owner / company_admin, never NBD's own company
 * (tenant-rules.js isPlatformTenant) and never a rep. It hides itself once
 * every step is done, or when the owner taps "Hide" (stored on
 * companyProfile.setupChecklist.hidden so it stays hidden on every device).
 *
 * Every read is the company's own: companyProfile/{cid}, companies/{cid},
 * companies/{cid}/members, connectAccounts/{cid} — the same tenant-scoped
 * docs firestore.rules already let an owner read. No inline styles or
 * handlers (CSP): css/tenant-ready.css.
 */
(function () {
  'use strict';
  if (window.NBDSetupChecklist) return;

  var STATE = { company: null, membersCount: null, connectReady: null, loadedFor: null, loading: false };

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function claims() { try { return window._userClaims || {}; } catch (_) { return {}; } }
  function uid() { try { return (window._user && window._user.uid) || null; } catch (_) { return null; } }
  function companyId() { var c = claims(); return c.companyId || uid(); }

  // Owner of a non-NBD company (role company_admin, or a solo owner whose
  // company key IS their uid and who carries no subordinate role).
  function eligible() {
    var TR = window.NBDTenantRules;
    if (!TR || typeof TR.isPlatformTenant !== 'function') return false;
    if (!uid()) return false;
    if (TR.isPlatformTenant()) return false;
    var c = claims();
    if (c.role === 'company_admin') return true;
    return !c.role && companyId() === uid();
  }

  function profile() { return window._companyProfile || {}; }
  function prefs() { var p = profile(); return (p.setupChecklist && typeof p.setupChecklist === 'object') ? p.setupChecklist : {}; }

  function publishAvailable() {
    var reg = window.__NBD_CALL_REGISTRY;
    return !!(reg && typeof reg._publishSite === 'function');
  }

  // ── Step model (pure: tests drive it with a fake window) ──────────────
  function steps() {
    var raw = (typeof window._brandOverride === 'function') ? (window._brandOverride() || {}) : {};
    var contact = raw.contact || {};
    var leads = Array.isArray(window._leads) ? window._leads : [];
    var realLeads = leads.filter(function (l) { return l && !l.isSample && l.deleted !== true; });
    var ests = Array.isArray(window._estimates) ? window._estimates : [];
    var TR = window.NBDTenantRules;
    var co = STATE.company || {};
    var skipped = prefs().skipped || {};
    var list = [
      { id: 'brand', title: 'Add your brand', why: 'Your company name and phone go on every estimate, contract and text.',
        done: !!((raw.displayName || raw.legalName) && String(contact.phone || '').replace(/\D/g, '').length >= 10),
        action: 'brand', cta: 'Open brand settings' },
      { id: 'import', title: 'Import your leads', why: 'Bring your customer list over from a CSV. Imports don’t count against your monthly lead limit.',
        done: realLeads.length > 0, action: 'import', cta: 'Import a CSV' },
      { id: 'prices', title: 'Set your prices', why: 'Your package prices per square, used by every estimate and every rep.',
        done: !!(TR && typeof TR.ratesSet === 'function' && TR.ratesSet()), action: 'prices', cta: 'Set prices' },
      { id: 'team', title: 'Invite your team', why: 'Add your reps, or skip this if you work solo.',
        done: (STATE.membersCount || 0) > 0 || skipped.team === true, action: 'team', cta: 'Invite a rep', skip: 'I work solo' },
      { id: 'stripe', title: 'Connect Stripe', why: 'Card payments on your invoices need a connected Stripe account. Checks, cash and Zelle work without it.',
        done: STATE.connectReady === true, action: 'stripe', cta: 'Connect Stripe' }
    ];
    if (publishAvailable()) {
      list.push({ id: 'site', title: 'Publish your website', why: 'Your free contractor page. It stays private until you publish it.',
        done: co.sitePublished === true, action: 'site', cta: 'Publish my site' });
    }
    list.push({ id: 'estimate', title: 'Send your first estimate', why: 'Build a quote in a couple of minutes from a lead.',
      done: ests.length > 0, action: 'estimate', cta: 'Start an estimate' });
    return list;
  }

  async function refreshRemote() {
    var cid = companyId();
    if (!cid || STATE.loading || !window.db || typeof window.getDoc !== 'function' || typeof window.doc !== 'function') return;
    STATE.loading = true;
    try {
      try {
        var cs = await window.getDoc(window.doc(window.db, 'companies', cid));
        STATE.company = (cs && cs.exists && cs.exists()) ? (cs.data() || {}) : {};
      } catch (_) { STATE.company = STATE.company || {}; }
      try {
        if (typeof window.getDocs === 'function' && typeof window.collection === 'function' && typeof window.query === 'function' && typeof window.limit === 'function') {
          var ms = await window.getDocs(window.query(window.collection(window.db, 'companies', cid, 'members'), window.limit(1)));
          STATE.membersCount = ms ? ms.size || (ms.docs ? ms.docs.length : 0) : 0;
        }
      } catch (_) { /* unknown — the step simply stays open */ }
      try {
        var ss = await window.getDoc(window.doc(window.db, 'connectAccounts', cid));
        var s = (ss && ss.exists && ss.exists()) ? (ss.data() || {}) : {};
        STATE.connectReady = String(s.accountId || '').indexOf('acct_') === 0 && s.chargesEnabled === true && s.detailsSubmitted === true;
      } catch (_) { STATE.connectReady = false; }
      STATE.loadedFor = cid;
    } finally {
      STATE.loading = false;
    }
  }

  function render() {
    var home = $('view-home');
    var existing = $('nbdSetupChecklist');
    if (!eligible() || window._companyProfileLoaded !== true || prefs().hidden === true) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return null;
    }
    var list = steps();
    var doneCount = list.filter(function (s) { return s.done; }).length;
    if (doneCount === list.length) {
      if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
      return list;
    }
    if (!home) return list;
    var card = existing;
    if (!card) {
      card = document.createElement('section');
      card.id = 'nbdSetupChecklist';
      card.className = 'sc-card';
      card.setAttribute('aria-label', 'Set up your company');
    }
    if (card.parentNode !== home) home.insertBefore(card, home.firstChild);
    else if (home.firstChild !== card) home.insertBefore(card, home.firstChild);
    var next = list.filter(function (s) { return !s.done; })[0];
    card.innerHTML =
      '<div class="sc-head"><div><div class="sc-kicker">Get set up</div>' +
      '<div class="sc-title">' + doneCount + ' of ' + list.length + ' done</div></div>' +
      '<button type="button" class="sc-hide" data-sc-act="hide">Hide</button></div>' +
      '<div class="sc-bar"><i class="sc-bar-fill sc-w' + Math.round((doneCount / list.length) * 10) + '"></i></div>' +
      '<ol class="sc-list">' + list.map(function (s) {
        return '<li class="sc-step' + (s.done ? ' is-done' : '') + (next && next.id === s.id ? ' is-next' : '') + '" data-sc-step="' + s.id + '">' +
          '<span class="sc-dot" aria-hidden="true">' + (s.done ? '✓' : '') + '</span>' +
          '<span class="sc-body"><span class="sc-name">' + esc(s.title) + '</span>' +
          (s.done ? '' : '<span class="sc-why">' + esc(s.why) + '</span>') + '</span>' +
          (s.done ? '' : '<span class="sc-acts"><button type="button" class="btn btn-orange sc-go" data-sc-act="' + s.action + '">' + esc(s.cta) + '</button>' +
            (s.skip ? '<button type="button" class="btn btn-ghost sc-skip" data-sc-act="skip-' + s.id + '">' + esc(s.skip) + '</button>' : '') + '</span>') +
        '</li>';
      }).join('') + '</ol>';
    return list;
  }

  // Settings hydrates from a template and opens on Profile, so switch to the
  // wanted tab once its panel exists — and again if Profile wins the race.
  function openSettings(tab) {
    if (typeof window.goTo === 'function') window.goTo('settings');
    var tries = 0;
    (function attempt() {
      var panel = document.getElementById('stab-panel-' + tab);
      if (panel && typeof window.switchSettingsTab === 'function') {
        window.switchSettingsTab(tab);
        if (panel.style.display === 'block' && tries > 2) return;
      }
      if (++tries < 25) setTimeout(attempt, 120);
    })();
  }

  async function savePrefs(patch) {
    var cur = prefs();
    var next = Object.assign({}, cur, patch, { skipped: Object.assign({}, cur.skipped || {}, patch.skipped || {}) });
    try {
      if (typeof window._saveCompanyProfile === 'function') await window._saveCompanyProfile({ setupChecklist: next });
    } catch (_) {
      if (typeof window.showToast === 'function') window.showToast('Could not save that — check your connection.', 'error');
    }
    render();
  }

  function act(name) {
    var reg = window.__NBD_CALL_REGISTRY || {};
    switch (name) {
      case 'brand': openSettings('company-profile'); break;
      case 'import':
        if (typeof window.openLeadImport === 'function') window.openLeadImport();
        break;
      case 'prices': openSettings('estimates'); break;
      case 'team': openSettings('team'); break;
      case 'stripe': openSettings('billing'); break;
      case 'site':
        if (typeof reg._publishSite === 'function') {
          Promise.resolve(reg._publishSite()).then(function () { STATE.loadedFor = null; refreshRemote().then(render); });
        } else { openSettings('company-profile'); }
        break;
      case 'estimate':
        if (typeof reg.openEstimateV2Builder === 'function') reg.openEstimateV2Builder();
        else if (typeof window.openEstimateV2Builder === 'function') window.openEstimateV2Builder();
        else if (typeof window.goTo === 'function') window.goTo('est');
        break;
      case 'hide': savePrefs({ hidden: true }); break;
      case 'skip-team': savePrefs({ skipped: { team: true } }); break;
      default: break;
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-sc-act]') : null;
    if (!t || !t.closest('#nbdSetupChecklist')) return;
    e.preventDefault();
    act(t.getAttribute('data-sc-act'));
  });

  var _queued = false;
  function schedule() {
    if (_queued) return;
    _queued = true;
    setTimeout(function () {
      _queued = false;
      if (!eligible()) { render(); return; }
      if (STATE.loadedFor !== companyId()) refreshRemote().then(render, render);
      else render();
    }, 50);
  }
  ['nbd:company-profile-loaded', 'nbd:data-refreshed', 'focus'].forEach(function (ev) {
    try { window.addEventListener(ev, function () { if (ev === 'focus') STATE.loadedFor = null; schedule(); }); } catch (_) { /* ignore */ }
  });
  // Home re-renders from its template; put the card back when it does.
  try {
    var mo = new MutationObserver(function () { if (!$('nbdSetupChecklist')) schedule(); });
    var startObs = function () { var h = $('view-home'); if (h) mo.observe(h, { childList: true }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startObs); else startObs();
  } catch (_) { /* no MutationObserver */ }
  // Leads / estimates land a few seconds after boot.
  var _ticks = 0;
  var _iv = setInterval(function () { schedule(); if (++_ticks > 20) clearInterval(_iv); }, 3000);

  window.NBDSetupChecklist = { steps: steps, render: render, eligible: eligible, refresh: function () { STATE.loadedFor = null; schedule(); }, _state: STATE, _act: act };
  // Lazy (ScriptLoader 'setup', loaded after 'nbd:company-profile-loaded'):
  // that event has already fired by the time this runs, so paint now.
  schedule();
})();
