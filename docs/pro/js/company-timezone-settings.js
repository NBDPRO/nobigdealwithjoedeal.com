/**
 * company-timezone-settings.js — Settings › Company Profile › "Time zone"
 * (NBD OS P2 Team, 2026-11-09; documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P2).
 *
 * companyProfile.timeZone: the company's IANA zone. The team leaderboard
 * (functions/leaderboard-aggregate.js) counts "today" and "this week" in it.
 * The owner or a company_admin picks it from a native <select>; everyone else
 * sees it read only. A zone is valid when Intl.supportedValuesOf('timeZone')
 * lists it (plus UTC), or, in a browser without that, when it is on the fixed
 * list below. firestore.rules bounds the field to a string of at most 64 chars.
 *
 * Saves through the existing writer (window._saveCompanyProfile, a merge) and
 * keeps the older lowercase `timezone` (written by Bots & API) in step when the
 * doc already has one, so every reader of either field agrees.
 *
 * The panel is built here, under the Letterhead panel (found by
 * #cp_businessLicense), so dashboard.html carries no new markup. Loaded in the
 * lazy `tenantsettings` ScriptLoader bundle (goTo('settings')); repaints when a
 * Settings tab opens and when the company profile lands. No inline handlers,
 * no style attributes; every value escaped.
 *
 * Pure half (zones / valid / current / saveFields) is require()-able for
 * tests/nbd-os-team-timezone-2026-11-09.test.js.
 */
(function (root) {
  'use strict';

  var FIXED = ['America/New_York', 'America/Detroit', 'America/Kentucky/Louisville', 'America/Indiana/Indianapolis',
    'America/Chicago', 'America/Denver', 'America/Boise', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
    'America/Adak', 'Pacific/Honolulu', 'America/Puerto_Rico', 'UTC'];
  var US_FIRST = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles',
    'America/Anchorage', 'Pacific/Honolulu'];

  /** Every zone this browser can name (supportedValuesOf + UTC), else the fixed list. */
  function zones(intl) {
    var I = intl || {};
    if (typeof I.supportedValuesOf === 'function') {
      try {
        var all = I.supportedValuesOf('timeZone');
        if (all && all.length) return all.indexOf('UTC') === -1 ? all.concat(['UTC']) : all.slice();
      } catch (e) { /* fall through */ }
    }
    return FIXED.slice();
  }
  /** On the list, or a spelling the list names otherwise (Asia/Kolkata is listed as Asia/Calcutta in some browsers). */
  function valid(z, intl) {
    if (typeof z !== 'string' || !z || z.length > 64) return false;
    var list = zones(intl);
    if (list.indexOf(z) !== -1) return true;
    if (!intl || typeof intl.supportedValuesOf !== 'function' || typeof intl.DateTimeFormat !== 'function') return false;
    // a case slip ('america/denver') is not another spelling: Intl would accept it, the list would not
    try {
      var r = new intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone;
      return list.indexOf(r) !== -1 && r.toLowerCase() !== z.toLowerCase();
    } catch (e) { return false; }
  }
  /** The saved zone (timeZone, else the older timezone), or '' when none is saved. */
  function current(profile, intl) {
    var p = profile || {};
    if (valid(p.timeZone, intl)) return p.timeZone;
    if (valid(p.timezone, intl)) return p.timezone;
    return '';
  }
  function saveFields(profile, z) {
    var out = { timeZone: z };
    if (profile && typeof profile.timezone === 'string' && profile.timezone) out.timezone = z;
    return out;
  }
  var api = { FIXED: FIXED, zones: zones, valid: valid, current: current, saveFields: saveFields };
  if (typeof module === 'object' && module.exports) module.exports = api;

  var W = root;
  var doc = W && W.document;
  if (!W || !doc || W.NBDCompanyTimeZone) return;
  W.NBDCompanyTimeZone = api;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, k) { if (typeof W.showToast === 'function') W.showToast(m, k); }
  /** The owner (solo, or the company keyed by their uid) or a company_admin: the companyProfile writers. */
  function canEdit() {
    var c = W._userClaims || {}, uid = (W._user && W._user.uid) || '';
    var r = String(c.role || '').toLowerCase();
    if (r === 'company_admin' || r === 'admin') return true;
    if (r === 'viewer' || r === 'sales_rep' || r === 'manager') return false;
    return !!uid && (!c.companyId || c.companyId === uid);
  }
  function label(z) { return z.replace(/_/g, ' '); }
  function options(cur) {
    var all = zones(W.Intl);
    if (cur && all.indexOf(cur) === -1) all = [cur].concat(all);   // saved under another spelling of a listed zone
    var first = US_FIRST.filter(function (z) { return all.indexOf(z) !== -1; });
    var opt = function (z) { return '<option value="' + esc(z) + '"' + (z === cur ? ' selected' : '') + '>' + esc(label(z)) + '</option>'; };
    return (cur ? '' : '<option value="">Choose a time zone</option>') +
      '<optgroup label="United States">' + first.map(opt).join('') + '</optgroup>' +
      '<optgroup label="All time zones">' + all.filter(function (z) { return first.indexOf(z) === -1; }).map(opt).join('') + '</optgroup>';
  }

  var panel = null, cssAsked = false;
  function render() {
    var anchor = doc.getElementById('cp_businessLicense');
    var host = anchor && anchor.closest ? anchor.closest('.panel') : null;
    if (!host || !host.parentNode) return;
    if (!cssAsked && W.ScriptLoader && typeof W.ScriptLoader.load === 'function') {
      cssAsked = true;
      try { W.ScriptLoader.load('css/company-timezone-settings.css?v=1'); } catch (e) { /* unstyled still works */ }
    }
    if (!panel || !panel.parentNode) {
      panel = doc.createElement('div');
      panel.className = 'panel mb-md';
      panel.setAttribute('data-cotz', 'panel');
      host.parentNode.insertBefore(panel, host.nextElementSibling || null);
      panel.addEventListener('click', onClick);
    }
    var cur = current(W._companyProfile, W.Intl);
    var edit = canEdit();
    panel.innerHTML =
      '<div class="panel-hdr"><div><div class="panel-label">The day and week your team\'s numbers count in: Today and This week on the leaderboard and the Team widget.</div>' +
        '<div class="panel-title">Time zone</div></div></div>' +
      '<div class="panel-body"><div class="sf"><label for="cp_timeZone">Company time zone</label>' +
        '<select id="cp_timeZone" class="cotz-select"' + (edit ? '' : ' disabled') + '>' + options(cur) + '</select></div>' +
        (cur ? '' : '<p class="cotz-note">Not set yet. Until it is, the team numbers count in Eastern time.</p>') +
        (edit ? '<div class="cotz-row"><button type="button" class="btn btn-ghost cotz-save" data-cotz="save">Save time zone</button></div>'
          : '<p class="cotz-note">Only the owner or an admin can change this.</p>') +
      '</div>';
  }
  function onClick(e) {
    var t = e && e.target && e.target.closest ? e.target.closest('[data-cotz="save"]') : null;
    if (!t || !canEdit()) return;
    var sel = doc.getElementById('cp_timeZone');
    var z = sel ? sel.value : '';
    if (!valid(z, W.Intl)) { toast('Pick a time zone from the list', 'error'); return; }
    if (typeof W._saveCompanyProfile !== 'function') { toast('Time zone not saved: the company profile is still loading', 'error'); return; }
    Promise.resolve().then(function () { return W._saveCompanyProfile(saveFields(W._companyProfile, z)); }).then(function () {
      toast('Time zone saved: ' + label(z), 'success');
      render();
    }, function (err) {
      toast('Time zone not saved: ' + ((err && err.message) || 'error'), 'error');
    });
  }

  function hook() {
    var prev = W.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__cotzWrapped) return true;
    var wrapped = function () {
      var out = prev.apply(this, arguments);
      try { render(); } catch (e) { /* never break the tab switch */ }
      return out;
    };
    Object.keys(prev).forEach(function (k) { try { wrapped[k] = prev[k]; } catch (_) { /* read-only flag */ } });
    wrapped.__cotzWrapped = true;
    W.switchSettingsTab = wrapped;
    return true;
  }
  if (typeof W.addEventListener === 'function') W.addEventListener('nbd:company-profile-loaded', function () { try { render(); } catch (e) {} });
  hook();
  try { render(); } catch (e) { /* the tab hook paints it later */ }
})(typeof window !== 'undefined' ? window : null);
