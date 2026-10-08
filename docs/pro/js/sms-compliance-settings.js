/**
 * sms-compliance-settings.js — Settings → 🤖 AI Texting → "Texting rules"
 * (texting compliance, 2026-10-05).
 *
 * Two things a company controls about outbound texting, both enforced on the
 * server (functions/sms-dnc.js manageSmsCompliance):
 *
 *   Texting on/off   the company's master switch (sms_settings). Owner /
 *                    company_admin flip it. A company without its own
 *                    texting registration sees "Texting needs registration —
 *                    coming soon" and no switch: the server refuses every
 *                    text from it until registration exists.
 *   Do Not Text      the company's internal list (sms_dnc). Anyone but a
 *                    viewer adds a number; owner / company_admin remove a
 *                    manual entry. A homeowner's STOP reply shows here too
 *                    and can't be removed — only their START reply lifts it.
 *
 * Renders into #smsComplianceMount when the 'ai-texting' Settings tab opens
 * (switchSettingsTab is wrapped, the ai-texting-persona.js /
 * agent-bots-settings.js pattern). No inline handlers: one delegated
 * listener scoped to the mount.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.NBDSmsCompliance && window.NBDSmsCompliance.__v === 1) return;

  let _loadSeq = 0;
  let _state = null;   // { settings, entries, error }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof window.showToast === 'function') window.showToast(m, k || 'info'); };
  const ask = async (m) => (typeof window.nbdConfirm === 'function' ? !!(await window.nbdConfirm(m)) : window.confirm(m));

  async function callable(payload) {
    if (!window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._httpsCallable = mod.httpsCallable;
    }
    if (!window._functions) throw new Error('Functions SDK unavailable');
    const res = await window._httpsCallable(window._functions, 'manageSmsCompliance')(payload || {});
    return res && res.data;
  }

  function claims() { return window._userClaims || {}; }
  function uid() {
    return (window._user && window._user.uid) || (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
  }
  /** Owner or company_admin — the roles the server lets flip the switch / remove a number. */
  function isAdmin() {
    const c = claims();
    const role = String(c.role || '').toLowerCase();
    if (role === 'company_admin' || role === 'admin') return true;
    // A solo owner carries no role claim and no companyId (tenant = own uid).
    return !role && (!c.companyId || c.companyId === uid());
  }
  function isViewOnly() {
    const role = String(claims().role || '').toLowerCase();
    return role === 'viewer' || role === 'member';
  }

  /** "(859) 555-0134" for a 10-digit key; the stored copy otherwise. */
  function prettyPhone(e) {
    const k = String((e && e.key) || '');
    if (/^\d{10}$/.test(k)) return '(' + k.slice(0, 3) + ') ' + k.slice(3, 6) + '-' + k.slice(6);
    return String((e && e.phone) || k);
  }

  function switchHtml(s) {
    if (!s) return '';
    if (s.needsRegistration) {
      return `<div class="panel mb-md">
        <div class="panel-hdr"><div><div class="panel-label">Texting</div><div class="panel-title">Texting needs registration — coming soon</div></div></div>
        <div class="panel-body"><div class="body-13">Texts from the CRM are paused for your company until your own texting registration is set up. Calls and email still work.</div></div>
      </div>`;
    }
    const on = s.enabled !== false;
    const admin = isAdmin();
    return `<div class="panel mb-md">
      <div class="panel-hdr"><div><div class="panel-label">Texting</div><div class="panel-title">Outbound texting</div></div></div>
      <div class="panel-body">
        <label class="row-card" for="sccEnabled">
          <div>
            <div class="body-13">Send texts from the CRM</div>
            <div class="meta-10">Turning this off stops every text your company sends: rep texts, door-knock texts, AI replies and storm alerts. Texts go out 8am–9pm in the homeowner's time zone.</div>
          </div>
          <input type="checkbox" id="sccEnabled" data-scc-change="enabled" ${on ? 'checked' : ''} ${admin ? '' : 'disabled'}>
        </label>
        ${admin ? '' : '<div class="meta-10">Only the owner or a company admin can change this.</div>'}
      </div>
    </div>`;
  }

  function listHtml(entries) {
    const admin = isAdmin();
    const rows = (entries || []).map((e) => {
      const stop = e.source === 'stop_reply';
      const label = stop ? 'Replied STOP — only their START reply lifts it' : ('Added by your team' + (e.note ? ' · ' + e.note : ''));
      const when = e.addedAtMs ? new Date(e.addedAtMs).toLocaleDateString() : '';
      return `<div class="row-card mb-12">
        <div>
          <div class="body-13">${esc(prettyPhone(e))}</div>
          <div class="meta-10">${esc(label)}${when ? ' · ' + esc(when) : ''}</div>
        </div>
        ${!stop && admin ? `<button type="button" class="btn btn-ghost" data-scc-action="remove" data-scc-phone="${esc(e.key)}" aria-label="Take ${esc(prettyPhone(e))} off the Do Not Text list">Remove</button>` : ''}
      </div>`;
    }).join('');
    const add = isViewOnly() ? '' : `<div class="fwgap-8 mb-md">
        <input type="tel" id="sccPhone" class="ui-input-lg" placeholder="Phone number" autocomplete="off" aria-label="Phone number to add to the Do Not Text list">
        <input type="text" id="sccNote" class="ui-input-lg" placeholder="Note (optional)" maxlength="200" aria-label="Note">
        <button type="button" class="btn btn-orange" data-scc-action="add">Add</button>
      </div>`;
    return `<div class="panel mb-md">
      <div class="panel-hdr"><div><div class="panel-label">Do Not Text</div><div class="panel-title">Numbers your company never texts</div></div></div>
      <div class="panel-body">
        <div class="meta-10 mb-md">Every text checks this list first. Homeowners who reply STOP are added automatically.</div>
        ${add}
        <div>${rows || '<div class="body-13">No numbers on the list yet. Add one when a homeowner asks not to be texted.</div>'}</div>
      </div>
    </div>`;
  }

  function render() {
    const mount = document.getElementById('smsComplianceMount');
    if (!mount) return;
    if (!_state) { mount.innerHTML = '<div class="meta-10">Loading texting rules…</div>'; return; }
    if (_state.error) {
      mount.innerHTML = `<div class="panel mb-md"><div class="panel-body"><div class="body-13">Could not load texting rules (${esc(_state.error)}).</div>
        <button type="button" class="btn btn-ghost" data-scc-action="reload">Try again</button></div></div>`;
      return;
    }
    mount.innerHTML = '<h3 class="panel-title mb-md">📵 Texting rules</h3>' + switchHtml(_state.settings) + listHtml(_state.entries);
  }

  async function load() {
    const seq = ++_loadSeq;
    if (!document.getElementById('smsComplianceMount')) return;
    if (!_state) render();
    try {
      const [settings, list] = await Promise.all([
        callable({ action: 'getSettings' }),
        callable({ action: 'listDnc' }),
      ]);
      if (seq !== _loadSeq) return;
      _state = { settings: settings || null, entries: (list && list.entries) || [] };
    } catch (e) {
      if (seq !== _loadSeq) return;
      _state = { error: (e && e.message) || 'error' };
    }
    render();
  }

  async function act(t) {
    const action = t.getAttribute('data-scc-action');
    if (action === 'reload') { _state = null; load(); return; }
    if (action === 'add') {
      const phoneEl = document.getElementById('sccPhone');
      const noteEl = document.getElementById('sccNote');
      const phone = String((phoneEl && phoneEl.value) || '').trim();
      if (String(phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length !== 10) {
        toast('Enter a 10-digit US phone number', 'error');
        if (phoneEl) phoneEl.focus();
        return;
      }
      t.disabled = true;
      try {
        const r = await callable({ action: 'addDnc', phone, note: String((noteEl && noteEl.value) || '').trim() });
        toast(r && r.created ? 'Added to the Do Not Text list' : 'That number is already on the list', 'success');
        await load();
      } catch (e) { toast((e && e.message) || 'Could not add', 'error'); t.disabled = false; }
      return;
    }
    if (action === 'remove') {
      const phone = t.getAttribute('data-scc-phone') || '';
      if (!(await ask('Take this number off the Do Not Text list? Your team will be able to text it again.'))) return;
      t.disabled = true;
      try {
        const r = await callable({ action: 'removeDnc', phone });
        if (r && r.result === 'stop_reply') toast('That homeowner replied STOP — only their START reply can lift it.', 'error');
        else toast('Removed from the Do Not Text list', 'success');
        await load();
      } catch (e) { toast((e && e.message) || 'Could not remove', 'error'); t.disabled = false; }
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest && ev.target.closest('#smsComplianceMount [data-scc-action]');
    if (t) act(t);
  });
  document.addEventListener('change', async (ev) => {
    const t = ev.target;
    if (!t || !t.matches || !t.matches('#smsComplianceMount [data-scc-change="enabled"]')) return;
    const on = !!t.checked;
    if (!on && !(await ask('Turn texting off for your company? No text will go out until you turn it back on.'))) { t.checked = true; return; }
    t.disabled = true;
    try {
      await callable({ action: 'setEnabled', enabled: on });
      toast(on ? 'Texting is on' : 'Texting is off', 'success');
      await load();
    } catch (e) { t.checked = !on; t.disabled = false; toast((e && e.message) || 'Could not save', 'error'); }
  });

  function installTabHook() {
    const prev = window.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__sccWrapped) return true;
    const wrapped = function (tab) {
      const out = prev.apply(this, arguments);
      if (tab === 'ai-texting') load();
      return out;
    };
    // Keep any flags earlier wrappers set (ai-texting-persona.js, agent-bots).
    Object.keys(prev).forEach((k) => { try { wrapped[k] = prev[k]; } catch (_) {} });
    wrapped.__sccWrapped = true;
    window.switchSettingsTab = wrapped;
    // The tab can already be open (deep link) before the hook lands.
    const panel = document.getElementById('stab-panel-ai-texting');
    if (panel && panel.style && panel.style.display === 'block' && !_loadSeq) load();
    return true;
  }
  function boot() {
    if (installTabHook()) return;
    let tries = 0;
    const iv = setInterval(() => { if (installTabHook() || ++tries > 120) clearInterval(iv); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDSmsCompliance = { __v: 1, load, render, prettyPhone, _switchHtml: switchHtml, _listHtml: listHtml };
})();
