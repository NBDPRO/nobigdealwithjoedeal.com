/**
 * /admin/tenants.html — the platform admin's list of every company
 * (2026-10-04, tenant-ready). Data: the adminListTenants callable
 * (functions/tenant-ops.js), which refuses anyone who is not a platform
 * admin. Classic script; the gate module (tenants-gate.js) initializes the
 * Firebase app first and fires 'auth-ready'. Every value is escaped.
 */
(function () {
  'use strict';

  async function callable(name) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    return window._httpsCallable(window._functions, name);
  }

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const cls = (v, good, bad) => (good.indexOf(v) !== -1 ? 'ok' : bad.indexOf(v) !== -1 ? 'bad' : 'warn');

  function card(t) {
    return '<div class="t-card">' +
      '<div class="t-name">' + esc(t.name || '(no name)') + '</div>' +
      '<div class="t-sub">' + esc(t.ownerEmail || 'no owner email') + ' · ' + esc(t.companyId) + '</div>' +
      '<div class="t-grid">' +
        '<div><div class="t-k">Plan</div><div class="t-v">' + esc(t.plan) + '</div></div>' +
        '<div><div class="t-k">Status</div><div class="t-v ' + cls(t.status, ['active', 'trialing'], ['past_due', 'cancelled', 'unpaid']) + '">' + esc(t.status) + '</div></div>' +
        '<div><div class="t-k">Leads</div><div class="t-v">' + num(t.leads) + '</div></div>' +
        '<div><div class="t-k">Estimates</div><div class="t-v">' + num(t.estimates) + '</div></div>' +
        '<div><div class="t-k">Invoices</div><div class="t-v">' + num(t.invoices) + '</div></div>' +
        '<div><div class="t-k">Stripe Connect</div><div class="t-v ' + cls(t.connect, ['ready'], ['not started']) + '">' + esc(t.connect) + '</div></div>' +
        '<div><div class="t-k">Last active</div><div class="t-v">' + esc(fmtDate(t.lastActive)) + '</div></div>' +
        '<div><div class="t-k">Site published</div><div class="t-v ' + cls(t.sitePublished, ['yes', 'yes (legacy)'], []) + '">' + esc(t.sitePublished) + '</div></div>' +
        '<div><div class="t-k">Signed up</div><div class="t-v">' + esc(fmtDate(t.createdAt)) + '</div></div>' +
        (t.readOnlyUntil ? '<div><div class="t-k">Read-only until</div><div class="t-v warn">' + esc(fmtDate(t.readOnlyUntil)) + '</div></div>' : '') +
      '</div></div>';
  }

  async function load() {
    const list = document.getElementById('tenantsList');
    const meta = document.getElementById('tenantsMeta');
    if (meta) meta.textContent = 'Loading…';
    try {
      const fn = await callable('adminListTenants');
      const { data } = await fn();
      const rows = (data && data.tenants) || [];
      if (meta) meta.textContent = rows.length + ' compan' + (rows.length === 1 ? 'y' : 'ies') + ' · ' + new Date(data.generatedAt || Date.now()).toLocaleString();
      list.innerHTML = rows.length ? rows.map(card).join('') : '<div class="empty">No companies yet.</div>';
    } catch (e) {
      if (meta) meta.textContent = '';
      list.innerHTML = '<div class="error">Could not load companies: ' + esc((e && e.message) || 'error') + '</div>';
    }
  }

  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('#tenantsRefresh')) load();
  });
  window.addEventListener('auth-ready', load);
})();
