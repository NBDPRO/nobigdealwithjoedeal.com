/**
 * away-mode-settings.js — Settings → Notifications → "Away mode & backup"
 * (never-forget lane, 2026-10-12). Owner / company_admin only; everyone else
 * sees nothing. Every write is the manageAway callable (the server re-checks
 * the role, verifies the backup is an active teammate and binds the wording
 * approval to a hash of the exact text) — this file only collects the choices.
 *
 * Renders into #awayModeMount when the 'notifications' Settings tab opens
 * (switchSettingsTab is wrapped, the sms-compliance-settings.js pattern).
 * No inline handlers: delegated listeners scoped to the mount.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.NBDAwaySettings && window.NBDAwaySettings.__v === 1) return;

  var seq = 0;
  var S = null;   // { status, config, members, handBack, error }

  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]); }); };
  var toast = function (m, k) { if (typeof window.showToast === 'function') window.showToast(m, k || 'info'); };
  function claims() { return window._userClaims || {}; }
  function uid() { return (window._user && window._user.uid) || null; }
  function isOwnerish() {
    var r = String(claims().role || '').toLowerCase(), c = claims();
    if (r === 'company_admin' || r === 'admin') return true;
    return !r && (!c.companyId || c.companyId === uid());
  }
  function call(payload) {
    if (window.NBDAway && typeof window.NBDAway.callable === 'function') return window.NBDAway.callable(payload);
    return Promise.reject(new Error('Away mode is still loading — try again'));
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function localInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function render() {
    var mount = document.getElementById('awayModeMount');
    if (!mount) return;
    if (!isOwnerish()) { mount.innerHTML = ''; return; }
    if (!S) { mount.innerHTML = '<div class="meta-10">Loading away mode…</div>'; return; }
    if (S.error) {
      mount.innerHTML = '<div class="panel mb-md"><div class="panel-body"><div class="body-13">Could not load away mode (' + esc(S.error) + ').</div>' +
        '<button type="button" class="btn btn-ghost" data-away-set="reload">Try again</button></div></div>';
      return;
    }
    var cfg = S.config || {}, st = S.status || {}, away = (st.away && st.away.on) ? st.away : null;
    var members = S.members || [];
    var cur = (cfg.backup && cfg.backup.memberEmail) || '';
    var opts = '<option value="">No backup</option>' + members.map(function (m) {
      return '<option value="' + esc(m.email) + '"' + (m.email === cur ? ' selected' : '') + '>' + esc(m.name) + '</option>';
    }).join('');
    if (cur && !members.some(function (m) { return m.email === cur; })) {
      opts += '<option value="' + esc(cur) + '" selected>' + esc(cur) + ' (no longer active)</option>';
    }
    var d = S.defaults || {};
    var ack = cfg.ackWindowMin || d.ackWindowMin || 120;
    var backupPanel = '<div class="panel mb-md">' +
      '<div class="panel-hdr"><div><div class="panel-label">Backup person</div><div class="panel-title">If you have not got to it, tell…</div></div></div>' +
      '<div class="panel-body">' +
      '<div class="meta-10 mb-md">They see a name, a call-back number and why — never an address, an amount or a note. What they do is shown to you when you are back; nothing is closed in the CRM for you.</div>' +
      '<div class="fwgap-8 mb-md">' +
      '<select id="awayBackup" class="ui-input-lg" aria-label="Backup person">' + opts + '</select>' +
      '<label class="meta-10" for="awayAck">after</label>' +
      '<input id="awayAck" type="number" class="ui-input-lg" min="15" max="480" step="15" value="' + esc(ack) + '" aria-label="Minutes before your backup is told">' +
      '<span class="meta-10">minutes</span>' +
      '<button type="button" class="btn btn-orange" data-away-set="save">Save</button></div>' +
      '<div class="meta-10">While away mode is on, urgent items go to them right away and the rest after ' + esc(cfg.awayWindowMin || d.awayWindowMin || 30) + ' minutes. Nothing is pushed to anyone between 9 PM and 8 AM except urgent items to a teammate.</div>' +
      '</div></div>';

    var until = away && away.untilMs ? localInput(away.untilMs) : localInput(Date.now() + 24 * 3600000);
    var awayPanel = '<div class="panel mb-md">' +
      '<div class="panel-hdr"><div><div class="panel-label">Away mode</div><div class="panel-title">' + (away ? 'You are away' : 'Heading out?') + '</div></div></div>' +
      '<div class="panel-body">' +
      (away
        ? '<div class="body-13 mb-md">' + esc((window.NBDAway && window.NBDAway.statusLine(st, Date.now()) || {}).text || 'Away mode is on') + '</div>' +
          '<div class="fwgap-8"><label class="meta-10" for="awayUntil">Until</label><input id="awayUntil" type="datetime-local" class="ui-input-lg" value="' + esc(until) + '">' +
          '<button type="button" class="btn btn-ghost" data-away-set="until">Change end time</button>' +
          '<button type="button" class="btn btn-orange" data-away-set="off">I’m back</button></div>'
        : '<div class="fwgap-8"><label class="meta-10" for="awayUntil">Back by</label><input id="awayUntil" type="datetime-local" class="ui-input-lg" value="' + esc(until) + '">' +
          '<button type="button" class="btn btn-orange" data-away-set="on">Turn on away mode</button></div>' +
          '<div class="meta-10 mt-8">Leave the time as is for a day, or pick when you are back. Away mode ends itself and hands everything back to you; an open-ended one ends after 21 days.</div>') +
      (st.backupState === 'none' || !cfg.backup || !cfg.backup.memberEmail ? '<div class="meta-10 mt-8"><b>No backup set</b> — your reminders will still arrive, but nobody else is told.</div>' : '') +
      '</div></div>';

    var pb = cfg.playbook || {};
    var approvedChip = pb.approved
      ? '<span class="tp-count">Approved ' + esc(pb.approvedAtMs ? new Date(pb.approvedAtMs).toLocaleDateString() : '') + '</span>'
      : '<span class="tp-count">Not approved — Thursday says nothing about you being away</span>';
    var wording = '<div class="panel mb-md">' +
      '<div class="panel-hdr"><div><div class="panel-label">What callers hear</div><div class="panel-title">Away wording ' + approvedChip + '</div></div></div>' +
      '<div class="panel-body">' +
      '<div class="meta-10 mb-md">Thursday uses this only while away mode is on, and only after you approve this exact text. Editing it clears the approval. It never promises who will call or when unless you write it here. Texting back to callers stays off until your number is registered.</div>' +
      '<textarea id="awayWording" class="ui-input-lg" style="width:100%;box-sizing:border-box;padding:10px;" rows="5" maxlength="800" aria-label="Away wording">' + esc(pb.draft || '') + '</textarea>' +
      '<div class="fwgap-8 mt-8">' +
      '<button type="button" class="btn btn-ghost" data-away-set="draft">Write me a draft</button>' +
      '<button type="button" class="btn btn-ghost" data-away-set="saveWording">Save wording</button>' +
      '<button type="button" class="btn btn-orange" data-away-set="approve"' + (pb.draft ? '' : ' disabled') + '>Approve this wording</button></div>' +
      '</div></div>';

    mount.innerHTML = '<h3 class="panel-title mb-md">🛟 Away mode &amp; backup</h3>' + backupPanel + awayPanel + wording;
  }

  function load() {
    var my = ++seq;
    if (!document.getElementById('awayModeMount') || !isOwnerish()) return;
    if (!S) render();
    return call({ action: 'get' }).then(function (r) {
      if (my !== seq) return;
      S = { status: r.status, config: r.config, members: r.members, handBack: r.handBack, defaults: r.defaults };
      render();
    }, function (e) {
      if (my !== seq) return;
      S = { error: (e && e.message) || 'error' };
      render();
    });
  }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  function after(p, ok) {
    return p.then(function (r) { if (ok) toast(ok, 'success'); return load(); },
      function (e) { toast((e && e.message) || 'Could not save', 'error'); });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('#awayModeMount [data-away-set]') : null;
    if (!t) return;
    var a = t.getAttribute('data-away-set');
    if (a === 'reload') { S = null; load(); return; }
    t.disabled = true;
    var re = function () { t.disabled = false; };
    var run = function (p, ok) { return after(p, ok).then(re, re); };
    if (a === 'save') {
      var email = val('awayBackup');
      var payload = { action: 'save', ackWindowMin: Number(val('awayAck')) || undefined, backup: email ? { kind: 'member', memberEmail: email } : { kind: 'none' } };
      run(call(payload), 'Saved'); return;
    }
    if (a === 'on' || a === 'until') {
      var ms = new Date(val('awayUntil')).getTime();
      if (!isFinite(ms)) { toast('Pick when you are back', 'error'); re(); return; }
      run(call({ action: 'setAway', on: true, untilMs: ms }), a === 'on' ? 'Away mode is on' : 'End time changed'); return;
    }
    if (a === 'off') {
      var go = typeof window.nbdConfirm === 'function' ? window.nbdConfirm('Mark yourself back? Your backup stops being told and what they touched comes back to you.') : Promise.resolve(window.confirm('Mark yourself back?'));
      Promise.resolve(go).then(function (yes) { if (!yes) { re(); return; } run(call({ action: 'imBack' }), 'Welcome back'); });
      return;
    }
    if (a === 'draft') {
      call({ action: 'playbookDraft' }).then(function (r) {
        var el = document.getElementById('awayWording');
        if (el && r && r.draft) el.value = r.draft;
        toast('Draft written — read it, then save and approve', 'info'); re();
      }, function (e) { toast((e && e.message) || 'Could not write a draft', 'error'); re(); });
      return;
    }
    if (a === 'saveWording') { run(call({ action: 'playbookSave', text: val('awayWording') }), 'Wording saved — approve it to use it'); return; }
    if (a === 'approve') {
      // Save what is on screen first, then approve the hash the server computed for it.
      call({ action: 'playbookSave', text: val('awayWording') }).then(function (saved) {
        var h = saved && saved.config && saved.config.playbook && saved.config.playbook.hash;
        return call({ action: 'playbookApprove', hash: h });
      }).then(function () { toast('Approved. Thursday will use this while you are away.', 'success'); return load(); },
        function (e) { toast((e && e.message) || 'Could not approve', 'error'); }).then(re, re);
    }
  });

  function installTabHook() {
    var prev = window.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__awayWrapped) return true;
    var wrapped = function (tab) {
      var out = prev.apply(this, arguments);
      if (tab === 'notifications') load();
      return out;
    };
    Object.keys(prev).forEach(function (k) { try { wrapped[k] = prev[k]; } catch (_) { /* read-only flag */ } });
    wrapped.__awayWrapped = true;
    window.switchSettingsTab = wrapped;
    var panel = document.getElementById('stab-panel-notifications');
    if (panel && panel.style && panel.style.display === 'block' && !seq) load();
    return true;
  }
  function boot() {
    if (installTabHook()) return;
    var tries = 0;
    var iv = setInterval(function () { if (installTabHook() || ++tries > 120) clearInterval(iv); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDAwaySettings = { __v: 1, load: load, render: render, _set: function (s) { S = s; render(); } };
})();
