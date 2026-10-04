/**
 * tenant-rules-settings.js — Settings → Estimates → "Business rules" editor
 * (2026-10-04, tenant-ready).
 *
 * Edits companyProfile/{companyId}.businessRules (see tenant-rules.js for the
 * shape and the NBD-only defaults): which tiers the company offers, their
 * customer-facing names and rep notes, each tier's warranty sentence, shingle
 * locks, and the cash deposit rule. Package PRICES, the fallback tax rate and
 * permit costs are the existing company pricing fields above this panel
 * (Save All Estimate Settings writes them to the company since 2026-10-04).
 *
 * Kentucky insurance holds are NOT here and never will be: they follow the
 * property's state (ky-insurance-law.js), for every company.
 *
 * Writes only after the company profile has loaded from the server (the same
 * hydration rule every company-wide panel follows) — a panel painted from
 * defaults must never be saved over a company's real rules. No inline styles
 * or handlers (CSP): classes live in css/tenant-ready.css.
 */
(function () {
  'use strict';
  if (window.NBDTenantRulesSettings) return;

  var TIER_KEYS = ['economy', 'good', 'better', 'best', 'beyond'];
  var _paintedKey = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); }
  function loadedKey() {
    return (typeof window._companyProfileLoadedKey === 'function') ? window._companyProfileLoadedKey() : null;
  }

  function render() {
    var host = $('tenantRulesPanel');
    if (!host) return false;
    var TR = window.NBDTenantRules;
    if (!TR || typeof TR.resolved !== 'function') return false;
    if (window._companyProfileLoaded !== true) {
      host.innerHTML = '<p class="tr-muted">Loading your company settings…</p>';
      host.setAttribute('data-state', 'loading');
      _paintedKey = null;
      return false;
    }
    var r = TR.resolved();
    var rows = TIER_KEYS.map(function (t) {
      var x = r.tiers[t] || {};
      var on = r.enabled.indexOf(t) !== -1;
      return '<div class="tr-tier" data-tier="' + t + '">' +
        '<label class="tr-check"><input type="checkbox" data-tr="enabled" data-tier="' + t + '"' + (on ? ' checked' : '') + '> Offer the <b>' + esc(t) + '</b> tier</label>' +
        '<div class="tr-grid">' +
          '<label class="tr-field"><span>Name customers see</span><input type="text" maxlength="40" data-tr="label" data-tier="' + t + '" value="' + esc(x.label) + '"></label>' +
          '<label class="tr-field"><span>Card note (reps)</span><input type="text" maxlength="80" data-tr="note" data-tier="' + t + '" value="' + esc(x.note) + '"></label>' +
          '<label class="tr-field tr-wide"><span>Warranty sentence on documents</span><textarea rows="2" maxlength="400" data-tr="warranty" data-tier="' + t + '">' + esc(x.warranty) + '</textarea></label>' +
          '<label class="tr-field"><span>Only this shingle (catalog code)</span><input type="text" maxlength="60" data-tr="onlyCodes" data-tier="' + t + '" value="' + esc((x.onlyCodes || []).join(', ')) + '" placeholder="e.g. RFG 240-TAMKO-HAIL"></label>' +
          '<label class="tr-field"><span>Shingle name for that lock</span><input type="text" maxlength="60" data-tr="onlyName" data-tier="' + t + '" value="' + esc(x.onlyName) + '"></label>' +
          '<label class="tr-check"><input type="checkbox" data-tr="no3Tab" data-tier="' + t + '"' + (x.no3Tab ? ' checked' : '') + '> Never a 3-tab shingle</label>' +
        '</div></div>';
    }).join('');
    var d = r.deposit || {};
    host.innerHTML =
      '<p class="tr-muted">Your company’s own rules. Every estimate, deal, contract and invoice reads them. ' +
      'Kentucky insurance jobs always follow Kentucky law (nothing due at signing), whatever is set here.</p>' +
      rows +
      '<div class="tr-deposit">' +
        '<div class="tr-h">Cash deposit rule</div>' +
        '<div class="tr-grid">' +
          '<label class="tr-field"><span>No deposit under ($)</span><input type="number" min="0" step="50" data-tr="depUnder" value="' + esc(Math.round((Number(d.CASH_NO_DEPOSIT_UNDER_CENTS) || 0) / 100)) + '"></label>' +
          '<label class="tr-field"><span>Deposit at signing (%)</span><input type="number" min="0" max="100" step="5" data-tr="depPct" value="' + esc(Number(d.CASH_DEPOSIT_PCT) || 0) + '"></label>' +
          '<label class="tr-field"><span>Round deposit to ($)</span><input type="number" min="1" step="1" data-tr="depRound" value="' + esc(Math.round((Number(d.CASH_DEPOSIT_ROUND_TO_CENTS) || 2500) / 100)) + '"></label>' +
        '</div>' +
        '<p class="tr-muted">Insurance jobs: the homeowner’s deductible plus the insurance ACV payment, as always.</p>' +
      '</div>' +
      '<div class="tr-actions"><button type="button" class="btn btn-orange" id="tenantRulesSave">Save business rules</button>' +
      '<span id="tenantRulesMsg" class="tr-msg" role="status"></span></div>';
    host.setAttribute('data-state', 'ready');
    _paintedKey = loadedKey();
    return true;
  }

  // Read the panel into a businessRules object (pure DOM read, no write).
  function collect() {
    var host = $('tenantRulesPanel');
    if (!host) return null;
    var q = function (sel) { return Array.prototype.slice.call(host.querySelectorAll(sel)); };
    var enabled = q('input[data-tr="enabled"]').filter(function (i) { return i.checked; }).map(function (i) { return i.getAttribute('data-tier'); });
    if (!enabled.length) return { error: 'Offer at least one tier.' };
    var labels = {}, notes = {}, warranty = {}, shingleLocks = {};
    TIER_KEYS.forEach(function (t) {
      var v = function (k) { var el = host.querySelector('[data-tr="' + k + '"][data-tier="' + t + '"]'); return el ? el : null; };
      labels[t] = String((v('label') || {}).value || '').trim().slice(0, 40);
      notes[t] = String((v('note') || {}).value || '').trim().slice(0, 80);
      warranty[t] = String((v('warranty') || {}).value || '').trim().slice(0, 400);
      var codes = String((v('onlyCodes') || {}).value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10);
      var no3 = !!(v('no3Tab') && v('no3Tab').checked);
      shingleLocks[t] = (codes.length || no3)
        ? { onlyCodes: codes, onlyName: String((v('onlyName') || {}).value || '').trim().slice(0, 60), no3Tab: no3 }
        : null;
    });
    var num = function (k) { var el = host.querySelector('[data-tr="' + k + '"]'); var n = el ? Number(el.value) : NaN; return isFinite(n) ? n : null; };
    var under = num('depUnder'), pct = num('depPct'), round = num('depRound');
    if (pct != null && (pct < 0 || pct > 100)) return { error: 'Deposit percent must be 0–100.' };
    if (under != null && under < 0) return { error: 'The no-deposit threshold cannot be negative.' };
    return {
      rules: {
        tiers: { enabled: enabled, labels: labels, notes: notes, warranty: warranty, shingleLocks: shingleLocks },
        deposit: {
          noDepositUnderCents: Math.round((under || 0) * 100),
          depositPct: Math.round(pct || 0),
          roundToCents: Math.max(100, Math.round((round || 25) * 100))
        }
      }
    };
  }

  async function save(btn) {
    var msg = $('tenantRulesMsg');
    var say = function (t, cls) { if (msg) { msg.textContent = t; msg.className = 'tr-msg ' + (cls || ''); } };
    if (window._companyProfileLoaded !== true || _paintedKey == null || _paintedKey !== loadedKey()) {
      say('Your company settings have not loaded yet — reopen this tab, then save.', 'is-warn');
      render();
      return;
    }
    var out = collect();
    if (!out || out.error) { say((out && out.error) || 'Nothing to save.', 'is-warn'); return; }
    if (btn) btn.disabled = true;
    try {
      // businessRules is replaced as one map under a merge write: every key
      // the panel shows is written, so a cleared field really clears.
      await window._saveCompanyProfile({ businessRules: out.rules });
      say('✓ Saved for your whole company', 'is-ok');
      toast('Business rules saved', 'success');
    } catch (e) {
      var denied = /permission/i.test(String((e && (e.code || e.message)) || ''));
      say(denied ? 'Only an owner or company admin can change business rules.' : 'Could not save — check your connection and try again.', 'is-warn');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('#tenantRulesSave')) { save(t.closest('#tenantRulesSave')); return; }
    // Opening Settings → Estimates (the panel lives in a lazily hydrated template).
    if (t.closest('#stab-estimates')) setTimeout(render, 0);
  });
  try { window.addEventListener('nbd:company-profile-loaded', function () { render(); }); } catch (_) { /* no event target */ }
  // ui.js switchSettingsTab is how every route opens a settings tab.
  try {
    var orig = window.switchSettingsTab;
    if (typeof orig === 'function' && !orig.__nbdTenantRules) {
      var wrapped = function (tab) {
        var r = orig.apply(this, arguments);
        if (tab === 'estimates') setTimeout(render, 0);
        return r;
      };
      wrapped.__nbdTenantRules = true;
      window.switchSettingsTab = wrapped;
    }
  } catch (_) { /* never block boot */ }

  window.NBDTenantRulesSettings = { render: render, collect: collect, save: save };
})();
