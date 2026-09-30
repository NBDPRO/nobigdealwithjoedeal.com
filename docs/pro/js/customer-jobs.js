/**
 * customer-jobs.js — the "Jobs" panel on the customer page + "＋ Add job"
 * (multi-job stage 2b, Jo's live-CRM handoff #1, 2026-09-30).
 *
 * Lists this customer's jobs (leads/{id}/jobs via NBDJobs.loadLead): title,
 * stage, value, and where it stands:
 *   On card     the active job, which the lead's own fields describe
 *   Open        another open job; it has its own pipeline card (Jo, J3)
 *   Done        closed out AND paid in full
 *   Lost
 * "＋ Add job" writes a new job (stage New) through NBDJobs.add. The pipeline
 * shows it as its own card; once the current job is closed and paid in full
 * the server (functions/jobs-mirror.js) moves it onto the customer's card.
 *
 * customer.html?id=X#addJob opens the add sheet on load (the duplicate-lead
 * prompt's "Add a job to them" link lands here).
 */
(function () {
  'use strict';
  if (window.__nbdCustomerJobs) return;
  window.__nbdCustomerJobs = true;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const J = () => window.NBDJobs;
  const TYPES = [['', 'Not set'], ['insurance', 'Insurance'], ['cash', 'Cash'], ['finance', 'Finance'], ['warranty', 'Warranty'], ['service', 'Service']];

  function leadId() { return new URLSearchParams(location.search).get('id') || null; }
  function lead() { const l = window._currentLead; return l && l.id === leadId() ? l : null; }
  function canWrite() { return ((window._userClaims || {}).role || '') !== 'viewer'; }
  function money(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : ''; }
  function stageText(s) { const t = String(s || 'new').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); }

  /** PURE: where a job stands, for its badge. */
  function standing(l, job) {
    const eff = job.id === l.activeJobId ? Object.assign({}, job, pickLead(l)) : job;
    if (eff.stageRole === 'lost') return { key: 'lost', text: 'Lost', color: 'var(--m,#9ca3af)' };
    if (!J().isOpen(eff)) return { key: 'done', text: 'Done · paid in full', color: '#16a34a' };
    if (job.id === l.activeJobId) return { key: 'card', text: 'On card', color: 'var(--orange,#A14A22)' };
    return { key: 'open', text: 'Open · own card', color: '#2563eb' };
  }
  function pickLead(l) { const o = {}; J().JOB_FIELDS.forEach((f) => { if (l[f] !== undefined) o[f] = l[f]; }); return o; }

  function panel() {
    let p = document.getElementById('jobsPanel');
    if (p) return p;
    const anchor = document.getElementById('checklistPanel');
    if (!anchor || !anchor.parentNode) return null;
    p = document.createElement('div');
    p.className = 'panel';
    p.id = 'jobsPanel';
    anchor.parentNode.insertBefore(p, anchor);
    p.addEventListener('click', (e) => { if (e.target.closest('[data-cj-add]')) openAdd(); });
    return p;
  }

  function render(l, jobs) {
    const p = panel();
    if (!p) return;
    const rows = jobs.map((j) => {
      const eff = j.id === l.activeJobId ? Object.assign({}, j, pickLead(l)) : j;
      const st = standing(l, j);
      const addr = j.property && j.property.address && j.property.address !== l.address ? '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:2px;">📍 ' + esc(j.property.address) + '</div>' : '';
      return '<div class="cj-row" data-cj-job="' + esc(j.id) + '" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 0;border-top:1px solid var(--br,rgba(255,255,255,.08));">'
        + '<div style="min-width:0;"><div style="font-weight:700;font-size:13px;">' + esc(j.title || 'Job') + '</div>'
        + '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:2px;">' + esc(stageText(eff.stage)) + (money(eff.jobValue) ? ' · ' + esc(money(eff.jobValue)) : '') + '</div>' + addr + '</div>'
        + '<span class="cj-badge" data-cj-standing="' + st.key + '" style="flex:none;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;border:1px solid ' + st.color + ';color:' + st.color + ';white-space:nowrap;">' + esc(st.text) + '</span>'
        + '</div>';
    }).join('');
    const addBtn = canWrite() && l.activeJobId
      ? '<button type="button" class="btn btn-orange" data-cj-add style="font-size:11px;padding:6px 12px;">＋ Add job</button>' : '';
    p.innerHTML = '<div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
      + '<div class="panel-title" style="margin:0;">Jobs' + (jobs.length > 1 ? ' <span style="color:var(--m,#9ca3af);font-weight:500;">(' + jobs.length + ')</span>' : '') + '</div>' + addBtn + '</div>'
      + (rows || '<div style="font-size:12px;color:var(--m,#9ca3af);padding:6px 0;">No jobs yet.</div>');
  }

  // ── Add job sheet ───────────────────────────────────────────────────────
  function properties(l) {
    const list = [];
    if (l.address) list.push(l.address);
    (Array.isArray(l.serviceAddresses) ? l.serviceAddresses : []).forEach((a) => { if (a && list.indexOf(a) < 0) list.push(String(a)); });
    return list;
  }

  function openAdd() {
    const l = lead();
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
    ov.querySelector('#cjAddForm').addEventListener('submit', (e) => { e.preventDefault(); save(l, props); });
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
  async function save(l, props) {
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
      render(l, J().forLead(l.id));
    } catch (e) {
      if (err) err.textContent = 'Could not add the job: ' + ((e && e.message) || 'try again');
      if (btn) { btn.disabled = false; btn.textContent = 'Add job'; }
    } finally { saving = false; }
  }

  // ── boot: wait for the signed-in user + the lead, once ─────────────────
  let _done = false;
  async function load() {
    if (_done) return true;
    const l = lead();
    if (!l || !J() || !window._user || !window.db || !window.getDocs || !window.collection) return false;
    _done = true;
    let jobs = [];
    try { jobs = await J().loadLead(l.id); } catch (_) { return true; }
    render(l, jobs);
    if (location.hash === '#addJob') openAdd();
    return true;
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    load().then((ok) => { if (ok || tries > 30) clearInterval(timer); });
  }, 1000);

  window.NBDCustomerJobs = { _standing: standing, _buildJob: buildJob, _render: render, openAdd };
})();
