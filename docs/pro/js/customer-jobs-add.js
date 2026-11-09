/**
 * customer-jobs-add.js — the customer page's "＋ Add job" sheet, loaded on
 * first use (boot-weight lane, batch 4b, 2026-11-08).
 *
 * Split out of customer-jobs.js, which keeps the Jobs panel on the boot path
 * (it paints in the default Overview tab on every card). Nothing here runs
 * before a rep taps "＋ Add job" or lands on customer.html?id=X#addJob (the
 * duplicate-lead prompt's "Add a job to them" link). customer-jobs.js
 * registers this file as the ScriptLoader bundle `customerjobsadd` and its
 * openAdd loads it, then calls NBDCustomerJobs._openSheet(lead, render).
 *
 * "＋ Add job" writes a new job (stage New) through NBDJobs.add. The pipeline
 * shows it as its own card; once the current job is closed and paid in full
 * the server (functions/jobs-mirror.js) moves it onto the customer's card.
 */
(function () {
  'use strict';
  if (window.__nbdCustomerJobsAdd) return;
  window.__nbdCustomerJobsAdd = true;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const J = () => window.NBDJobs;
  const TYPES = [['', 'Not set'], ['insurance', 'Insurance'], ['cash', 'Cash'], ['finance', 'Finance'], ['warranty', 'Warranty'], ['service', 'Service']];

  function canWrite() { return ((window._userClaims || {}).role || '') !== 'viewer'; }

  // ── Add job sheet ───────────────────────────────────────────────────────
  function properties(l) {
    const list = [];
    if (l.address) list.push(l.address);
    (Array.isArray(l.serviceAddresses) ? l.serviceAddresses : []).forEach((a) => { if (a && list.indexOf(a) < 0) list.push(String(a)); });
    return list;
  }

  // l: the lead on the page; render: customer-jobs.js's panel render, which
  // repaints the Jobs panel after a save.
  function openAdd(l, render) {
    if (!l || !J() || !canWrite()) return;
    closeAdd();
    const props = properties(l);
    const ov = document.createElement('div');
    ov.id = 'cjAddSheet';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Add a job');
    ov.style.cssText = 'position:fixed;inset:0;z-index:10050;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const field = 'width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid var(--br,#333);background:var(--s2,#1a1a1a);color:inherit;font-size:16px;';
    const label = 'display:block;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--m,#9ca3af);margin:12px 0 5px;';
    // novalidate: buildJob's message (which also catches a blank-spaces
    // title) is the one the user sees, not the browser bubble.
    ov.innerHTML = '<form id="cjAddForm" novalidate style="width:100%;max-width:440px;max-height:90vh;overflow:auto;background:var(--s,#111);color:var(--t,#eee);border:1px solid var(--br,#333);border-radius:14px;padding:18px;">'
      + '<div style="font-weight:800;font-size:16px;">＋ Add a job for ' + esc([l.firstName, l.lastName].filter(Boolean).join(' ') || 'this customer') + '</div>'
      + '<div style="font-size:12px;color:var(--m,#9ca3af);margin-top:4px;">It gets its own pipeline card. It moves onto the customer\'s card once the current job is closed and paid in full.</div>'
      + '<label style="' + label + '" for="cjTitle">What\'s the job?</label><input id="cjTitle" maxlength="120" required placeholder="e.g. Gutter guards" style="' + field + '">'
      + '<label style="' + label + '" for="cjType">Job type</label><select id="cjType" style="' + field + '">' + TYPES.map((t) => '<option value="' + t[0] + '">' + t[1] + '</option>').join('') + '</select>'
      + '<label style="' + label + '" for="cjValue">Value ($)</label><input id="cjValue" type="number" inputmode="decimal" min="0" step="1" placeholder="Optional" style="' + field + '">'
      + (props.length > 1 ? '<label style="' + label + '" for="cjProp">Property</label><select id="cjProp" style="' + field + '">' + props.map((a, i) => '<option value="' + i + '">' + esc(a) + '</option>').join('') + '</select>' : '')
      + '<label style="' + label + '" for="cjScope">Scope (optional)</label><textarea id="cjScope" rows="3" maxlength="2000" style="' + field + 'resize:vertical;"></textarea>'
      + '<div id="cjErr" role="alert" style="color:#ef4444;font-size:12px;margin-top:8px;min-height:1em;"></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px;">'
      + '<button type="button" class="btn" data-cj-cancel style="padding:10px 16px;">Cancel</button>'
      + '<button type="submit" class="btn btn-orange" id="cjSave" style="padding:10px 16px;">Add job</button></div></form>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-cj-cancel]')) closeAdd(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAdd(); });
    ov.querySelector('#cjAddForm').addEventListener('submit', (e) => { e.preventDefault(); save(l, props, render); });
    setTimeout(() => { const t = document.getElementById('cjTitle'); if (t) t.focus(); }, 0);
  }

  function closeAdd() { const o = document.getElementById('cjAddSheet'); if (o) o.remove(); }

  /** PURE: the new job's fields from the form values. → { fields } | { error }. */
  function buildJob(l, props, v) {
    const title = String(v.title || '').trim().slice(0, 120);
    if (!title) return { error: 'Say what the job is.' };
    const fields = { title };
    if (v.jobType) fields.jobType = v.jobType;
    if (String(v.value || '').trim() !== '') {
      const n = Math.round(Number(v.value));
      if (!Number.isFinite(n) || n < 0 || n >= 100000000) return { error: 'Value must be a dollar amount.' };
      fields.jobValue = n;
    }
    const scope = String(v.scope || '').trim();
    if (scope) fields.scopeOfWork = scope.slice(0, 2000);
    const idx = Number(v.prop || 0);
    const addr = props[idx] || l.address || '';
    // The house's pin only belongs to the main address.
    const main = addr === l.address;
    fields.property = { address: addr, lat: main && Number.isFinite(l.lat) ? l.lat : null, lng: main && Number.isFinite(l.lng) ? l.lng : null };
    return { fields };
  }

  let saving = false;
  async function save(l, props, render) {
    if (saving) return;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const b = buildJob(l, props, { title: val('cjTitle'), jobType: val('cjType'), value: val('cjValue'), scope: val('cjScope'), prop: val('cjProp') });
    const err = document.getElementById('cjErr');
    if (b.error) { if (err) err.textContent = b.error; return; }
    saving = true;
    const btn = document.getElementById('cjSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
      await J().add(l, b.fields);
      closeAdd();
      if (typeof window.showToast === 'function') window.showToast('Job added: ' + b.fields.title, 'success');
      if (typeof render === 'function') render(l, J().forLead(l.id));
    } catch (e) {
      if (err) err.textContent = 'Could not add the job: ' + ((e && e.message) || 'try again');
      if (btn) { btn.disabled = false; btn.textContent = 'Add job'; }
    } finally { saving = false; }
  }

  const NS = window.NBDCustomerJobs || (window.NBDCustomerJobs = {});
  NS._openSheet = openAdd;
  NS._buildJob = buildJob;
})();
