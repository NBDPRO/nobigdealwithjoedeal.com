/**
 * ai-texting-stats-card.js — T-3: AI texting analytics card
 *
 * Renders a compact "AI Texting" stats card on the analytics ('board')
 * view, summarizing how the rep acts on the AI reply drafts that
 * incomingSMS generates. Pulls a server-side rollup from the
 * getAiTextingStats callable (collectionGroup scan over the rep's own
 * ai_drafts, last 90 days) — so the browser never reads every draft.
 *
 * Mounted by dashboard-actions.js when the board view opens. Result is
 * cached for the session so re-opening the view is instant.
 */
(function () {
  'use strict';
  if (window.AiTextingStatsCard
      && window.AiTextingStatsCard.__sentinel === 'nbd-ai-texting-stats-card-v1') return;

  let _cache = null;     // last stats payload (session cache)
  let _inflight = null;  // de-dupe concurrent calls

  function callable(name) {
    if (!window._functions || !window._httpsCallable) return null;
    return window._httpsCallable(window._functions, name);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
  }
  function pct(n) { return n == null ? '—' : Math.round(n * 100) + '%'; }

  async function fetchStats() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    const fn = callable('getAiTextingStats');
    if (!fn) return null;
    _inflight = fn({ windowDays: 90 })
      .then(res => { _cache = (res && res.data) || null; _inflight = null; return _cache; })
      .catch(e => { _inflight = null; console.warn('[AiTextingStatsCard] failed:', e && e.message); return { _failed: true }; }); // CRM audit 2026-11-06 (VW-F165): not cached; the card says it failed
    return _inflight;
  }

  function host() {
    const c = document.getElementById('analyticsContainer');
    if (!c) return null;
    let h = document.getElementById('aiTextingStatsCard');
    if (!h) {
      h = document.createElement('div');
      h.id = 'aiTextingStatsCard';
      c.appendChild(h);
    }
    return h;
  }

  function stat(label, value, sub) {
    return `<div style="flex:1;min-width:108px;">
      <div style="font-size:22px;font-weight:800;color:var(--t,#e8eaf0);line-height:1;">${esc(value)}</div>
      <div style="font-size:11px;color:var(--m,#9aa3b2);margin-top:4px;text-transform:uppercase;letter-spacing:.04em;">${esc(label)}</div>
      ${sub ? `<div style="font-size:10px;color:var(--m,#9aa3b2);opacity:.85;margin-top:2px;">${esc(sub)}</div>` : ''}
    </div>`;
  }

  const WRAP = 'background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.30);border-radius:12px;padding:16px;margin:12px 0;';
  const HEAD = '<span style="font-size:17px;">🤖</span><span style="font-weight:700;font-size:13px;color:var(--t,#e8eaf0);">AI Texting</span>';

  function renderInto(h, s) {
    if (!s || !s.total || s._failed) {
      // CRM audit 2026-11-06 (VW-F165): a failed read is not "no drafts yet".
      const msg = (s && s._failed)
        ? 'Couldn\'t load AI texting stats. Check your connection and open this page again.'
        : 'No AI reply drafts yet — they appear here once homeowners start texting your business line.';
      h.innerHTML = `<div style="${WRAP}">
        <div style="display:flex;align-items:center;gap:8px;">${HEAD}</div>
        <div style="font-size:12px;color:var(--m,#9aa3b2);margin-top:8px;">${msg}</div>
      </div>`;
      return;
    }
    const avg = s.avgMinutesToAction;
    const avgStr = avg == null ? '—' : (avg < 60 ? Math.round(avg) + 'm' : (Math.round(avg / 6) / 10) + 'h');
    h.innerHTML = `<div style="${WRAP}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">${HEAD}
        <span style="font-size:11px;color:var(--m,#9aa3b2);">· last ${esc(s.windowDays)} days · ${esc(s.total)} drafts</span>
      </div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        ${stat('Accept rate', pct(s.acceptRate), `${esc(s.sent)} sent / ${esc(s.acted)} acted`)}
        ${stat('Edited first', pct(s.editRate), 'of sent replies')}
        ${stat('Dismissed', pct(s.dismissRate), `${esc(s.dismissed)} dropped`)}
        ${stat('Avg response', avgStr, 'draft → sent')}
        ${stat('Pending', String(s.pending), 'awaiting you')}
        ${stat('Failed', String(s.failed || 0), 'sends that errored')}
      </div>
    </div>`;
  }

  async function render() {
    const h = host();
    if (!h) return; // analytics view not mounted
    if (!_cache) {
      h.innerHTML = `<div style="font-size:12px;color:var(--m,#9aa3b2);padding:12px 2px;">Loading AI texting stats…</div>`;
    }
    const s = await fetchStats();
    const h2 = host();
    if (h2) renderInto(h2, s);
  }

  window.AiTextingStatsCard = {
    __sentinel: 'nbd-ai-texting-stats-card-v1',
    render,
    _clearCache: () => { _cache = null; }
  };
})();
