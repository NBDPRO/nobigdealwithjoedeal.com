/**
 * business-tile-ui.js — the "Today's business" card on today's day page
 * (rules: business-tile-logic.js). Three counts the CRM's Today screen
 * published, with how old they are, or one line saying to open the CRM.
 * Classic script after app.js; storage reads are try/catch and the card
 * renders without them; every value that reaches innerHTML is a number or
 * escaped.
 */
(function () {
  'use strict';
  if (window.NBDBusinessTileUI) return;
  /* global pages, cur */
  const B = () => window.NBDBusinessTile;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : '');

  const store = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  function pageDk() {
    try { const p = typeof pages !== 'undefined' && typeof cur === 'number' ? pages[cur] : null; return p && p.dk ? p.dk : null; } catch (_) { return null; }
  }

  function cardHtml() {
    // nbd_last_uid is what the tracker's sign-in records; a summary for any other uid is ignored.
    const r = B().read(store(B().KEY), store('nbd_last_uid') || '', Date.now());
    const stat = (n, l) => '<div class="bt-stat"><b>' + esc(n) + '</b><span>' + esc(l) + '</span></div>';
    const body = r.ok
      ? '<div class="bt-stats">' + stat(r.calls, r.calls === 1 ? 'person to call back' : 'people to call back') + stat(r.followUps, r.followUps === 1 ? 'follow-up due' : 'follow-ups due') + stat(r.jobs, r.jobs === 1 ? 'job today' : 'jobs today') + '</div>' +
        '<div class="bt-age">' + esc(r.label) + '</div>'
      : '<div class="bt-age">' + esc(B().refreshText(r.reason)) + '</div>';
    return '<div class="wc-card bt-card' + (r.ok ? '' : ' bt-stale') + '"><div class="wc-card-h">🏢 Today\'s business</div>' + body +
      '<a class="wc-link bt-open" href="/pro/dashboard.html">Open the CRM</a></div>';
  }
  function mount() {
    const dk = pageDk();
    document.querySelectorAll('.bt-wrap').forEach((n) => n.remove());
    const bar = document.getElementById('today-bar');
    if (!dk || dk !== today() || !bar || !B()) return;
    const box = document.createElement('div');
    box.className = 'bt-wrap';
    box.innerHTML = cardHtml();
    bar.parentNode.insertBefore(box, bar.nextSibling);
  }

  function hook() {
    const orig = window.renderPage;
    if (typeof orig !== 'function' || orig.__bt) return;
    const wrapped = function () { const r = orig.apply(this, arguments); try { mount(); } catch (_) { /* the day page renders without it */ } return r; };
    Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
    wrapped.__bt = true;
    window.renderPage = wrapped;
  }
  function boot() {
    if (!B()) return;
    hook();
    try { if (document.getElementById('today-bar')) mount(); } catch (_) { /* optional */ }
    // The CRM tab publishes while this one is open: repaint when it does.
    try { window.addEventListener('storage', (e) => { if (e && e.key === B().KEY) { try { mount(); } catch (_) { /* optional */ } } }); } catch (_) { /* optional */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDBusinessTileUI = { cardHtml, mount };
})();
