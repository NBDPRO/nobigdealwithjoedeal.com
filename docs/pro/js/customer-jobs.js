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
 *
 * The add sheet itself is js/customer-jobs-add.js, loaded on the first
 * "＋ Add job" tap or #addJob (boot-weight lane, 2026-11-08); this file keeps
 * the panel, which paints at boot.
 */
(function () {
  'use strict';
  if (window.__nbdCustomerJobs) return;
  window.__nbdCustomerJobs = true;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const J = () => window.NBDJobs;

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

  /**
   * PURE. Direct costs per job, in cents (multi-job, 2026-09-30). An expense
   * carries the job it was logged against (#1932); one logged before that, or
   * naming a job this customer no longer has, counts toward the FIRST job.
   * Same basis as the Analytics margin: DIRECT costs only, amountCents.
   * jobs: oldest first (jobs-store forLead order).
   */
  function costsByJob(jobs, expenses) {
    const out = {};
    const list = jobs || [];
    if (!list.length) return out;
    const ids = new Set(list.map((j) => j.id));
    const first = list[0].id;
    for (const e of expenses || []) {
      if (!e || e.costType !== 'direct') continue;
      // A credit / refund row (flag costCredits, stored positive) nets the job's cost down.
      const raw = parseInt(e.amountCents, 10) || 0;
      const c = e.entryType === 'credit' ? -raw : raw;
      if (!c) continue;
      const jid = e.jobId && ids.has(e.jobId) ? e.jobId : first;
      out[jid] = (out[jid] || 0) + c;
    }
    return out;
  }
  let _costs = null;   // { jobId: cents } once the customer's expenses load

  /** "costs $1,200 · 38% margin" for one job, or '' when it has no costs. */
  function costLine(valueDollars, cents) {
    // Credits bigger than the costs: say so, never show nothing (or a flattering margin).
    if (cents < 0) return 'credits exceed costs (-$' + (Math.abs(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 }) + ')';
    if (!(cents > 0)) return '';
    const v = Number(valueDollars) || 0;
    const parts = ['costs $' + (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })];
    if (v > 0) parts.push(Math.round(((v * 100 - cents) / (v * 100)) * 100) + '% margin');
    return parts.join(' · ');
  }

  function render(l, jobs) {
    const p = panel();
    if (!p) return;
    const rows = jobs.map((j) => {
      const eff = j.id === l.activeJobId ? Object.assign({}, j, pickLead(l)) : j;
      const st = standing(l, j);
      const addr = j.property && j.property.address && j.property.address !== l.address ? '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:2px;">📍 ' + esc(j.property.address) + '</div>' : '';
      const cost = _costs ? costLine(eff.jobValue, _costs[j.id]) : '';
      return '<div class="cj-row" data-cj-job="' + esc(j.id) + '" style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:9px 0;border-top:1px solid var(--br,rgba(255,255,255,.08));">'
        + '<div style="min-width:0;"><div style="font-weight:700;font-size:13px;">' + esc(j.title || 'Job') + '</div>'
        + '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:2px;">' + esc(stageText(eff.stage)) + (money(eff.jobValue) ? ' · ' + esc(money(eff.jobValue)) : '') + '</div>'
        + (cost ? '<div class="cj-cost" style="font-size:11px;color:var(--m,#9ca3af);margin-top:2px;">' + esc(cost) + '</div>' : '')
        + addr + '</div>'
        + '<span class="cj-badge" data-cj-standing="' + st.key + '" style="flex:none;font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;border:1px solid ' + st.color + ';color:' + st.color + ';white-space:nowrap;">' + esc(st.text) + '</span>'
        + '</div>';
    }).join('');
    const addBtn = canWrite() && l.activeJobId
      ? '<button type="button" class="btn btn-orange" data-cj-add style="font-size:11px;padding:6px 12px;">＋ Add job</button>' : '';
    p.innerHTML = '<div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">'
      + '<div class="panel-title" style="margin:0;">Jobs' + (jobs.length > 1 ? ' <span style="color:var(--m,#9ca3af);font-weight:500;">(' + jobs.length + ')</span>' : '') + '</div>' + addBtn + '</div>'
      + (rows || '<div style="font-size:12px;color:var(--m,#9ca3af);padding:6px 0;">No jobs yet.</div>');
  }

  // ── Add job sheet: loads on first use (boot-weight lane, 2026-11-08) ──
  // The sheet, its form check and the save live in js/customer-jobs-add.js,
  // which nothing needs before a tap on "＋ Add job" or the #addJob deep link.
  // It is the ScriptLoader bundle `customerjobsadd`, registered here at
  // runtime so the blocking script-loader.js does not grow. ScriptLoader never
  // rejects and drops a dead tag, so a failed fetch is said here and the next
  // tap fetches again.
  const ADD_BUNDLE = 'customerjobsadd';
  const ADD_FILES = ['js/customer-jobs-add.js?v=1'];
  function loader() {
    const sl = window.ScriptLoader;
    if (!sl || typeof sl.loadBundle !== 'function') return null;
    if (sl.bundles && !sl.bundles[ADD_BUNDLE]) sl.bundles[ADD_BUNDLE] = ADD_FILES;
    return sl;
  }
  function toast(m) { if (typeof window.showToast === 'function') window.showToast(m, 'error'); }
  function sheet() { const f = (window.NBDCustomerJobs || {})._openSheet; return typeof f === 'function' ? f : null; }

  let _opening = null;
  function openAdd() {
    const l = lead();
    if (!l || !J() || !canWrite()) return;
    if (sheet()) return sheet()(l, render);
    if (_opening) return _opening;
    const sl = loader();
    if (!sl) { toast('The add-job form is unavailable — refresh the page'); return; }
    _opening = Promise.resolve(sl.loadBundle(ADD_BUNDLE)).catch(() => {}).then(() => {
      _opening = null;
      if (!sheet()) { toast('Could not load the add-job form — check your connection and tap again'); return; }
      const now = lead();
      if (now) sheet()(now, render);
    });
    return _opening;
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
    loadCosts(l, jobs);
    return true;
  }

  // The customer's expenses, role-scoped like the cost panel (profit-tracker
  // _fetchLeadExpenses): staff read the tenant's, everyone else their own.
  // Best-effort — the panel renders without costs if this fails.
  async function loadCosts(l, jobs) {
    try {
      const c = window._userClaims || {};
      const staff = ['company_admin', 'manager', 'admin'].includes(c.role || '') && !!c.companyId;
      const scope = staff ? window.where('companyId', '==', c.companyId) : window.where('userId', '==', window._user.uid);
      const snap = await window.getDocs(window.query(window.collection(window.db, 'expenses'), scope, window.where('leadId', '==', l.id)));
      _costs = costsByJob(jobs, snap.docs.map((d) => d.data()));
      render(l, J().forLead(l.id));
    } catch (_) { /* no costs line */ }
  }
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    load().then((ok) => { if (ok || tries > 30) clearInterval(timer); });
  }, 1000);

  window.NBDCustomerJobs = { _standing: standing, _render: render, _costsByJob: costsByJob, _costLine: costLine, openAdd };
  loader();
})();
