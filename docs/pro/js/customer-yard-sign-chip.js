/**
 * customer-yard-sign-chip.js — "🪧 Sign out · pickup in 3 days" in the
 * customer page header when a yard sign is placed at this customer's house
 * (yardSigns/{id}.leadId). Tap → the Yard Signs view in the dashboard.
 *
 * Same query shape as yard-signs.js (owner, or company staff by companyId)
 * narrowed by leadId — equality-only, no composite index. Status and wording
 * come from yard-signs-logic.js (window.NBDYardSignLogic) so the chip and the
 * Yard Signs view never disagree. A picked-up sign shows nothing; a sign
 * marked missing stays visible so it is not forgotten.
 */
(function () {
  'use strict';
  if (window.__nbdYardSignChip) return;
  window.__nbdYardSignChip = true;

  const L = () => window.NBDYardSignLogic;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let _done = false;

  function leadId() { return new URLSearchParams(location.search).get('id') || null; }

  async function load() {
    const u = window._user && window._user.uid;
    const id = leadId();
    if (_done) return true;
    if (!u || !id || !L() || !window.db || !window.getDocs || !window.query || !window.where || !window.collection) return false;
    _done = true;
    const c = window._userClaims || {};
    const staff = ['company_admin', 'manager', 'viewer', 'admin'].includes(c.role || '') && !!c.companyId;
    const col = window.collection(window.db, 'yardSigns');
    const q = staff
      ? window.query(col, window.where('companyId', '==', c.companyId), window.where('leadId', '==', id))
      : window.query(col, window.where('userId', '==', u), window.where('leadId', '==', id));
    let signs = [];
    try { signs = (await window.getDocs(q)).docs.map((d) => Object.assign({ id: d.id }, d.data())); } catch (_) { return true; }
    render(signs);
    return true;
  }

  function render(signs) {
    const lg = L();
    const now = Date.now();
    // A removed sign (deleted, 2026-09-30) is not this customer's sign.
    const live = signs.filter((s) => s && !s.deleted && lg.statusOf(s, now) !== 'picked_up')
      .sort((a, b) => lg.ms(b.placedAt) - lg.ms(a.placedAt));
    const s = live[0];
    const old = document.getElementById('yardSignChip');
    if (!s) { if (old) old.remove(); return; }
    const st = lg.statusOf(s, now);
    const color = lg.COLOR[st] || '#16a34a';
    const chip = old || document.createElement('a');
    chip.id = 'yardSignChip';
    chip.href = '/pro/dashboard.html#/signs';
    chip.className = 'ys-chip';
    chip.style.cssText = 'display:inline-flex;align-items:center;font-size:11px;font-weight:600;padding:3px 9px;border-radius:12px;letter-spacing:.02em;text-decoration:none;border:1px solid ' + color + ';color:' + color + ';';
    chip.title = 'Yard sign placed ' + new Date(lg.ms(s.placedAt)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    chip.innerHTML = '🪧 ' + esc(st === 'missing' ? 'Sign missing' : st === 'scheduled' ? 'Sign scheduled · ' + lg.dueText(s, now) : 'Sign out · ' + lg.dueText(s, now));
    if (!old) {
      const anchor = document.getElementById('daysInStageBadge') || document.getElementById('customerStage');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(chip, anchor.nextSibling);
    }
  }

  // The customer page signs in and loads the lead asynchronously; try until
  // the SDK globals and the user are there (at most ~30 s), once.
  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    load().then((ok) => { if (ok || tries > 30) clearInterval(timer); });
  }, 1000);

  window.NBDYardSignChip = { _render: render };
})();
