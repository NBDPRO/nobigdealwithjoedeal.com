/**
 * NBD Pro — Buying-Intent Strike Alert (Phase 1)
 *
 * customerAuditEvents / estimate.viewedAt already capture the single highest-
 * intent buying signal the product has: the homeowner is looking at their
 * quote RIGHT NOW. notif-bell surfaces it passively (Wave 95, inside the bell
 * dropdown). This escalates it into a can't-miss strike card with a one-tap
 * CALL — "Sarah is viewing your $18k estimate, call while it's hot" — reusing
 * the same window._estimates / window._leads caches and the same
 * nbd:data-refreshed / focus refresh triggers the bell listens to. It does NOT
 * touch the load-bearing single-owner notif-bell.
 *
 * Phase 1 = client-side, driven by the existing refresh cadence (not a true
 * server push — that's Phase 2's customerAuditEvents trigger). Debounced once
 * per estimate per tab session so a refresh/refocus doesn't re-nag.
 *
 * detectFreshViews() is a pure function (dual browser/node export) so the
 * signal logic is unit-tested; the DOM/card layer only renders what it returns.
 */
(function (root) {
  'use strict';

  var FRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // mirror notif-bell Wave 95

  function toMs(v) {
    if (v == null) return NaN;
    if (typeof v === 'object' && typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return NaN; } }
    if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
    var t = Date.parse(v);
    return Number.isFinite(t) ? t : NaN;
  }
  function leadName(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
    return n || lead.address || 'Customer';
  }

  /**
   * Pure: which estimates are being viewed RIGHT NOW and deserve a strike.
   * Same predicate as notif-bell Wave 95 — fresh view (≤ window), not yet
   * responded, parent lead not terminal — returned newest-first.
   *
   * Also strikes on a fresh lead.lastPortalOpenAt (2026-09-16, extends the
   * 2026-09-16 view-tracking fix here too — estimate.viewedAt only fires
   * from the standalone estimate-view.html link, never from the homeowner
   * opening the main portal). Skips a lead already matched by an estimate
   * view above — one strike per lead per fresh window — and uses a
   * synthetic `'portal:' + leadId` estId (mirrors pickFreshViewNotifs'
   * `'lead:' + leadId` fallback below) so fire()'s struck-set dedupe still
   * works with no real estimate id to key on.
   */
  function detectFreshViews(estimates, leads, nowMs, windowMs) {
    windowMs = windowMs > 0 ? windowMs : FRESH_WINDOW_MS;
    var byId = new Map();
    (Array.isArray(leads) ? leads : []).forEach(function (l) { if (l && l.id) byId.set(l.id, l); });
    var ests = Array.isArray(estimates) ? estimates : [];
    var out = [];
    var matchedLeadIds = new Set();
    ests.forEach(function (est) {
      if (!est || est.respondedAt) return;
      var v = toMs(est.viewedAt);
      if (!Number.isFinite(v)) return;
      var age = nowMs - v;
      if (age <= 0 || age > windowMs) return;
      var lead = byId.get(est.leadId);
      if (!lead || lead.deleted) return;
      var stage = String(lead.stage || '').toLowerCase();
      if (stage === 'closed' || stage === 'lost' || stage === 'complete') return;
      matchedLeadIds.add(lead.id);
      out.push({
        estId: est.id,
        leadId: lead.id,
        name: leadName(lead),
        phone: String(lead.phone || ''),
        amount: Number(est.total || est.grandTotal || est.amount || 0) || 0,
        viewedAtMs: v,
        source: 'estimate',
      });
    });
    byId.forEach(function (lead) {
      if (!lead || lead.deleted || matchedLeadIds.has(lead.id)) return;
      var stage = String(lead.stage || '').toLowerCase();
      if (stage === 'closed' || stage === 'lost' || stage === 'complete') return;
      if (ests.some(function (e) { return e && e.leadId === lead.id && e.respondedAt; })) return;
      var v = toMs(lead.lastPortalOpenAt);
      if (!Number.isFinite(v)) return;
      var age = nowMs - v;
      if (age <= 0 || age > windowMs) return;
      out.push({
        estId: 'portal:' + lead.id,
        leadId: lead.id,
        name: leadName(lead),
        phone: String(lead.phone || ''),
        amount: 0,
        viewedAtMs: v,
        source: 'portal',
      });
    });
    out.sort(function (a, b) { return b.viewedAtMs - a.viewedAtMs; });
    return out;
  }

  /**
   * Pure: which entries on the live `notifications` feed are real-time
   * fresh-view strikes (idea #3 Phase 2). The onEstimateViewedStrike trigger
   * pushes a `type:'estimate_viewed'` notification onto the owner's feed the
   * moment the homeowner opens their estimate; this maps the fresh ones (≤
   * window) to the same match shape detectFreshViews returns, keyed by
   * estimateId so a notif-driven strike and a cache-driven strike for the same
   * estimate dedupe against one another. Newest-first.
   */
  function pickFreshViewNotifs(notifs, nowMs, windowMs) {
    windowMs = windowMs > 0 ? windowMs : FRESH_WINDOW_MS;
    var out = [];
    (Array.isArray(notifs) ? notifs : []).forEach(function (n) {
      if (!n || n.type !== 'estimate_viewed' || !n.leadId) return;
      var v = toMs(n.createdAt);
      if (!Number.isFinite(v)) return;
      var age = nowMs - v;
      if (age <= 0 || age > windowMs) return;
      out.push({
        estId: n.estimateId || ('lead:' + n.leadId),
        leadId: n.leadId,
        name: (n.customerName && String(n.customerName)) || 'A customer',
        phone: String(n.customerPhone || ''),
        amount: Number(n.estimateAmount || 0) || 0,
        viewedAtMs: v,
      });
    });
    out.sort(function (a, b) { return b.viewedAtMs - a.viewedAtMs; });
    return out;
  }

  var api = { detectFreshViews: detectFreshViews, pickFreshViewNotifs: pickFreshViewNotifs, FRESH_WINDOW_MS: FRESH_WINDOW_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || typeof root !== 'object') return;
  root.BuyingIntentStrike = api;

  // ── DOM layer (browser only) ─────────────────────────────────────────────
  if (typeof document === 'undefined') return;

  var STRUCK_KEY = 'nbd_bis_struck';
  function struckSet() {
    try { return new Set(JSON.parse(sessionStorage.getItem(STRUCK_KEY) || '[]')); } catch (_) { return new Set(); }
  }
  function markStruck(set) {
    try { sessionStorage.setItem(STRUCK_KEY, JSON.stringify(Array.from(set)).slice(0, 5000)); } catch (_) {}
  }
  function digits(p) { return String(p || '').replace(/\D/g, ''); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return n >= 1000 ? '$' + Math.round(n / 1000) + 'K' : '$' + Math.round(n); }

  function stackEl() {
    var id = 'nbd-buying-intent-stack';
    var s = document.getElementById(id);
    if (!s) {
      s = document.createElement('div');
      s.id = id;
      // Top-center strike band — deliberately clear of the crowded bottom-right
      // (lead-score-alert / whisper / map FAB). z sits above toasts (10002),
      // below the never-demote status strips (10006/10007).
      s.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);' +
        'z-index:10003;display:flex;flex-direction:column;gap:8px;align-items:center;' +
        'pointer-events:none;max-width:94vw;';
      document.body.appendChild(s);
    }
    return s;
  }

  function dismiss(card) {
    if (!card || !card.parentNode) return;
    card.style.transition = 'opacity .2s ease, transform .2s ease';
    card.style.opacity = '0';
    card.style.transform = 'translateY(-8px)';
    setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 220);
  }

  function renderStrike(match) {
    var stack = stackEl();
    var card = document.createElement('div');
    card.style.cssText = 'pointer-events:auto;display:flex;align-items:center;gap:10px;' +
      'background:var(--s2,#151a24);border:1px solid var(--green,#2ECC8A);' +
      'border-left:4px solid var(--green,#2ECC8A);border-radius:10px;padding:9px 12px;' +
      'box-shadow:0 8px 26px rgba(0,0,0,.32);color:var(--t,#e8eaf0);font-size:13px;' +
      'max-width:420px;animation:nbd-bis-in .24s ease-out;';
    var amt = match.amount > 0 ? ' ' + money(match.amount) : '';
    // A portal-open match (no specific estimate — the homeowner may be
    // looking at photos, documents, or the timeline) says "portal" rather
    // than claiming they're on the estimate specifically.
    var whatText = match.source === 'portal' ? 'is viewing your portal' : ('is viewing your' + amt + ' estimate');
    card.innerHTML =
      '<span style="font-size:18px;line-height:1;flex-shrink:0;" aria-hidden="true">🔥</span>' +
      '<div style="flex:1;min-width:0;line-height:1.35;">' +
        '<div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
          esc(match.name) + ' ' + esc(whatText) + '</div>' +
        '<div style="font-size:11px;color:var(--m,#9aa3b2);">Call now — they\'re on the page</div>' +
      '</div>';

    var callBtn = document.createElement('button');
    callBtn.type = 'button';
    callBtn.textContent = '📞 Call';
    callBtn.style.cssText = 'flex-shrink:0;background:var(--green,#2ECC8A);color:#04150d;border:none;' +
      'border-radius:7px;padding:7px 12px;font-weight:700;font-size:13px;cursor:pointer;';
    callBtn.addEventListener('click', function () {
      var d = digits(match.phone);
      if (d) { window.location.href = 'tel:' + d; }
      else if (window.showToast) { window.showToast('No phone number on this lead', 'info'); }
      dismiss(card);
    });

    var viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.textContent = 'View';
    viewBtn.setAttribute('aria-label', 'Open ' + match.name);
    viewBtn.style.cssText = 'flex-shrink:0;background:transparent;color:var(--m,#9aa3b2);border:1px solid var(--br,#2a3344);' +
      'border-radius:7px;padding:7px 10px;font-size:12px;cursor:pointer;';
    viewBtn.addEventListener('click', function () {
      // openCardDetailModal is the real global (window.openCardDetail never existed).
      if (typeof window.openCardDetailModal === 'function') { try { window.openCardDetailModal(match.leadId); dismiss(card); return; } catch (_) {} }
      window.location.href = '/pro/customer.html?id=' + encodeURIComponent(match.leadId);
    });

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'flex-shrink:0;background:none;border:none;color:var(--m,#9aa3b2);font-size:15px;cursor:pointer;padding:2px 4px;';
    closeBtn.addEventListener('click', function () { dismiss(card); });

    card.appendChild(callBtn);
    card.appendChild(viewBtn);
    card.appendChild(closeBtn);
    stack.appendChild(card);
    // Auto-retire after 45s so a card the rep ignored doesn't pin forever.
    setTimeout(function () { dismiss(card); }, 45000);
  }

  // Render a batch of strike matches, sharing the sessionStorage struck-set so
  // the estimates-cache path and the real-time notif path never double-fire the
  // same estimate (both key on estId = the estimate id).
  function fire(matches) {
    if (!matches.length) return;
    var struck = struckSet();
    var fired = 0;
    matches.forEach(function (m) {
      if (struck.has(m.estId) || fired >= 3) return; // cap the burst
      struck.add(m.estId);
      fired++;
      renderStrike(m);
    });
    if (fired) markStruck(struck);
  }

  // Client-refresh path: scan the estimates cache (the pre-#3-Phase-2 cadence).
  function scan() {
    if (document.hidden) return;
    fire(detectFreshViews(window._estimates, window._leads, Date.now()));
  }

  // Real-time path (idea #3 Phase 2): scan the live notifications feed. The
  // onEstimateViewedStrike trigger pushes a strike the moment the homeowner
  // opens the estimate; crm-snooze's onSnapshot updates window._notifications
  // and fires 'nbd:notifs-updated', which drives this — no refresh needed.
  function scanNotifs() {
    if (document.hidden) return;
    fire(pickFreshViewNotifs(window._notifications, Date.now()));
  }

  if (!document.getElementById('nbd-bis-css')) {
    var st = document.createElement('style');
    st.id = 'nbd-bis-css';
    st.textContent = '@keyframes nbd-bis-in{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}' +
      '@media (prefers-reduced-motion: reduce){#nbd-buying-intent-stack *{animation:none !important}}';
    document.head.appendChild(st);
  }

  var _t = null;
  function scheduleScan() { clearTimeout(_t); _t = setTimeout(function () { scan(); scanNotifs(); }, 400); }
  window.addEventListener('nbd:data-refreshed', scheduleScan);
  window.addEventListener('focus', scheduleScan);
  // Real-time: the live notifications feed pushed a new doc (idea #3 Phase 2).
  window.addEventListener('nbd:notifs-updated', scheduleScan);
  document.addEventListener('DOMContentLoaded', function () { setTimeout(function () { scan(); scanNotifs(); }, 3000); });

  root.BuyingIntentStrike.scan = scan; // exposed for manual/testing triggers
  root.BuyingIntentStrike.scanNotifs = scanNotifs;
})(typeof window !== 'undefined' ? window : this);
