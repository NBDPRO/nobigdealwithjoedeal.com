(function () {
  'use strict';
  // Localhost-only emulator switch (same Audit #3 rule as
  // nbd-emulator-connect.js): the rep-side pages already point their SDK at
  // the emulators when served from localhost, but the public token pages
  // hardcoded prod — leaving the homeowner surface untestable in the
  // hermetic e2e harness. Any hostname other than localhost/127.0.0.1
  // keeps prod.
  const FUNCTIONS_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
  const params = new URLSearchParams(window.location.search);
  const token = (params.get('token') || '').trim();
  const estimateId = (params.get('estimateId') || params.get('id') || '').trim();
  const root = document.getElementById('evRoot');

  // Customer-facing tier name (GBB audit, 2026-09-09). This page is a
  // minimal standalone homeowner viewer and does not load estimate-config.js
  // (no rep bundle), so it can't call window.NBD_ESTIMATE_CONFIG.tierLabel()
  // directly — falls back to the same canonical labels by hand.
  function tierLabel(key) {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    if (cfg && typeof cfg.tierLabel === 'function') return cfg.tierLabel(key);
    return ({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[key] || key;
  }
  // Every tier, cheapest first (five since 2026-10-02) — same config-or-copy
  // rule as tierLabel above.
  function tierOrder() {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    if (cfg && Array.isArray(cfg.TIER_ORDER)) return cfg.TIER_ORDER.slice();
    return ['economy', 'good', 'better', 'best', 'beyond'];
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // Whole dollars as before; cents when the amount has them. Review of #1763
  // (2026-09-25): an upgraded estimate's total carries exact upgrade tax, so
  // a whole-dollar Project Total disagreed with the proposal and invoice.
  function money(n) {
    const v = Number(n);
    if (!isFinite(v)) return '$0';
    const c = Math.round(v * 100);
    const d = (c % 100 === 0) ? 0 : 2;
    // Sign before the $ — a Rounding line can be negative ('−$0.80', not '$-0.80').
    return (c < 0 ? '−' : '') + '$' + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // ─── "Back to your project" (phone audit, 2026-09-25) ───────────
  // The Back button used to be a bare history.back(). That only works when
  // this page was reached in the SAME tab, and it almost never is: the
  // portal's "See what's included →" opens it with target=_blank, and the
  // rep's share builders (customer-bootstrap.module.js shareEstimateViewLink,
  // job-templates-ui.js) text or email this URL straight to the homeowner,
  // who opens it in a fresh tab. Both land with history.length === 1, where
  // history.back() does nothing at all — a labelled button that silently
  // ignores the tap, measured at 412 and 360.
  //
  // So Back is now a real link to the homeowner's portal. The token in this
  // URL IS a portal token (getEstimateForView validates it against
  // portal_tokens and refuses an estimate on any other lead), so the link
  // grants nothing the homeowner does not already hold — the same argument
  // portal.js makes for the link in the other direction. Relative on
  // purpose: both pages live under /pro/, so it resolves whether this page
  // was reached as /pro/estimate-view or /pro/estimate-view.html.
  function portalHref() {
    return 'portal.html?token=' + encodeURIComponent(token);
  }
  // The one case history.back() is still right: the portal opened this page
  // in the same tab (a long-press "open here", or a future same-tab link).
  // Going back restores the portal where the homeowner left it instead of
  // stacking a second copy of it on top.
  function cameFromPortalInThisTab() {
    try {
      if (history.length < 2 || !document.referrer) return false;
      var ref = new URL(document.referrer);
      return ref.origin === location.origin && /\/pro\/portal(\.html)?$/.test(ref.pathname);
    } catch (e) { return false; }
  }
  function backLinkHtml() {
    return '<a class="ghost" data-ev-action="back" href="' + escHtml(portalHref()) + '">Back to your project</a>';
  }

  // ─── Error states (phone audit, 2026-09-25) ─────────────────────
  // The .catch used to print err.message first, so a dropped connection —
  // the everyday case on a phone — showed the browser's own TypeError text,
  // "Failed to fetch", as one small red line on a blank page with nothing
  // to tap. The server's own strings were not much better ("Invalid token").
  // Copy is now keyed on WHAT failed, mirroring portal.js _errorStateFor so
  // both homeowner pages say the same thing about the same link, and each
  // state only offers the actions that can actually help:
  //   retry — only where trying again can succeed (network, 5xx, the
  //           per-IP rate limiter);
  //   back  — only where the portal itself can still open, i.e. not for a
  //           truncated (400) or expired (410) token, which the portal
  //           would refuse with the same message.
  // Deliberately no brand header here: company identity arrives with the
  // estimate payload, and a tenant's homeowner must never see NBD's.
  function errorStateFor(status) {
    switch (status) {
      case 400:
        return { title: 'This link looks incomplete', retry: false, back: false,
          body: 'Links sometimes get cut short in a text message. Ask your rep to send it again.' };
      case 403:
      case 404:
        return { title: 'We can’t find this estimate', retry: false, back: true,
          body: 'It may have been replaced by a newer one. Your project page always has the latest.' };
      case 410:
        return { title: 'This link has expired', retry: false, back: false,
          body: 'Ask your rep for a new one — they can send a fresh link right away.' };
      case 429:
        return { title: 'Too many requests right now', retry: true, back: true,
          body: 'Give it a minute and try again. If it keeps happening, ask your rep for a fresh link.' };
      case 0:
        return { title: 'Couldn’t load your estimate', retry: true, back: true,
          body: 'Check your connection and try again. If it keeps happening, contact your rep.' };
      default:
        return { title: 'Couldn’t load your estimate', retry: true, back: true,
          body: 'Something went wrong on our end. Try again in a moment — if it keeps happening, contact your rep.' };
    }
  }
  function showError(state) {
    var actions = '';
    if (state.retry) actions += '<button type="button" data-ev-action="retry">Try again</button>';
    if (state.back && token) actions += backLinkHtml();
    root.innerHTML = '<div class="ev-error" role="alert">'
      + '<h1 class="ev-error-title">' + escHtml(state.title) + '</h1>'
      + '<p class="ev-error-body">' + escHtml(state.body) + '</p>'
      + (actions ? '<div class="ev-cta-row">' + actions + '</div>' : '')
      + '</div>';
  }

  // One delegate for every state this page renders (the estimate, and the
  // error card's Try again / Back). Was bound inside renderEstimate, so the
  // error state had no handler at all — and a retry that re-rendered would
  // have bound a second one.
  // Wave 28: button delegates (replaces inline onclick="window.print()" etc.)
  root.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-ev-action]');
    if (!t) return;
    var act = t.getAttribute('data-ev-action');
    if (act === 'print') { window.print(); }
    else if (act === 'retry') { load(); }
    else if (act === 'back' && cameFromPortalInThisTab()) {
      // Otherwise the anchor's own href navigates to the portal.
      ev.preventDefault();
      history.back();
    }
  });

  if (!token || !estimateId) {
    showError({ title: 'This link looks incomplete', retry: false, back: true,
      body: 'It’s missing some information. Please ask your rep to send it again.' });
    return;
  }

  function load() {
    root.innerHTML = '<div class="ev-loading">Loading your estimate…</div>';
    fetch(FUNCTIONS_BASE + '/getEstimateForView', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, estimateId: estimateId }),
    })
      .then(function (res) {
        if (!res.ok) { showError(errorStateFor(res.status)); return; }
        return res.json().then(function (data) {
          renderEstimate(data.estimate || {}, data.company || null);
        });
      })
      // Only a request that never got a response lands here (offline, DNS,
      // CORS, a body that is not JSON) — never a server-chosen message.
      .catch(function () { showError(errorStateFor(0)); });
  }
  load();

  function renderEstimate(est, company) {
    // Full white-label (2026-07-19): tenant estimates rendered under NBD's
    // identity. company comes from getEstimateForView (server-guarded:
    // tenant-set https logo / hex colors only; null-ish name for NBD).
    var coName = (company && company.name) || 'No Big Deal Home Solutions';
    var isNbd = coName === 'No Big Deal Home Solutions';
    // The page ships a neutral "Your Estimate" title — it used to say
    // "— No Big Deal" until this ran, so another contractor's homeowner saw
    // NBD's name while the estimate loaded. Set it for every company here.
    document.title = 'Your Estimate — ' + coName;
    if (!isNbd) {
      try {
        if (company.colors && company.colors.accent) {
          // Certification: body carries .nbd-brand, whose token block SHADOWS
          // an html-only override — set on BOTH roots, override the derived
          // ramp, and pick a readable foreground for accent fills (a light
          // tenant accent would render white-on-light otherwise).
          var acc = company.colors.accent;
          var lum = (function (h) {
            h = h.replace('#', '');
            if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
            var r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
            var f = function (v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
            return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
          })(acc);
          var fg = lum > 0.45 ? '#12223D' : '#ffffff';
          var applyAccent = function (st) {
            st.setProperty('--nbd-orange', acc);
            st.setProperty('--nbd-orange-deep', 'color-mix(in srgb, ' + acc + ' 78%, #000)');
            st.setProperty('--nbd-orange-medium', 'color-mix(in srgb, ' + acc + ' 88%, #000)');
            st.setProperty('--nbd-orange-ink', 'color-mix(in srgb, ' + acc + ' 60%, #000)');
            st.setProperty('--nbd-orange-soft', 'color-mix(in srgb, ' + acc + ' 12%, transparent)');
            st.setProperty('--nbd-orange-glow', 'color-mix(in srgb, ' + acc + ' 30%, transparent)');
            st.setProperty('--nbd-ink-on-orange', fg);
          };
          applyAccent(document.documentElement.style);
          if (document.body) applyAccent(document.body.style);
        }
      } catch (e) { /* chrome is best-effort */ }
    }

    const total = est.grandTotal || est.total || 0;
    const lines = Array.isArray(est.lines) ? est.lines : [];
    const tiers = est.tiers || null;

    let html = '';
    html += '<div class="ev-header">';
    html +=   '<div>';
    if (isNbd) {
      html +=   '<div class="ev-brand"><span>NBD</span> · No Big Deal</div>';
      html +=   '<div class="ev-badge">Roofing &amp; Restoration</div>';
    } else if (company && company.logoUrl) {
      html +=   '<img class="ev-brand-logo" src="' + escHtml(company.logoUrl) + '" alt="' + escHtml(coName) + '" style="max-height:44px;max-width:220px;display:block;">';
    } else {
      html +=   '<div class="ev-brand">' + escHtml(coName) + '</div>';
    }
    html +=   '</div>';
    html +=   '<div>';
    html +=     '<div class="ev-doc-title">Estimate</div>';
    html +=     '<div class="ev-doc-meta">' + escHtml(est.number || '') + '</div>';
    html +=   '</div>';
    html += '</div>';

    if (est.owner || est.addr) {
      html += '<div class="ev-customer">';
      if (est.owner) html += '<dt>Prepared for</dt><dd>' + escHtml(est.owner) + '</dd>';
      if (est.addr)  html += '<dt>Property</dt><dd>' + escHtml(est.addr) + '</dd>';
      html += '</div>';
    }

    // Tier comparison cards if the estimate carries a tiers object
    // Five tiers (2026-10-02): every tier in TIER_ORDER the estimate carries.
    if (tiers && tierOrder().some(function (k) { return tiers[k]; })) {
      html += '<div class="ev-section-title">Choose your tier</div>';
      tierOrder().forEach(function (k) {
        const t = tiers[k];
        if (!t) return;
        const featured = (k === est.tier);
        const tName = tierLabel(k);
        html += '<div class="ev-tier-card' + (featured ? ' featured' : '') + '">';
        html +=   '<div class="ev-tier-name">' + escHtml(tName) + '</div>';
        html +=   '<div class="ev-tier-total">' + money(t.grandTotal || t.total || 0) + '</div>';
        html += '</div>';
      });
    } else {
      // Single-tier line-item view
      html += '<div class="ev-section-title">Scope of work</div>';
      if (lines.length) {
        html += '<ul class="ev-line-list">';
        lines.forEach(function (l) {
          html += '<li class="ev-line">';
          html +=   '<span class="ev-line-name">' + escHtml(l.name || l.description || l.code || 'Line item') + '</span>';
          if (l.quantity != null) {
            html += '<span class="ev-line-qty">' + escHtml(String(l.quantity)) + ' ' + escHtml(l.unit || '') + '</span>';
          }
          html +=   '<span class="ev-line-amt">' + money(l.lineTotal || l.amount || 0) + '</span>';
          html += '</li>';
        });
        html += '</ul>';
      } else {
        html += '<p style="color:var(--nbd-ink-muted);font-style:italic;">Detailed line items will be reviewed in person.</p>';
      }
    }

    // Photo embeds (2026-07): the rep-selected job photos ride the shared
    // view — "here's YOUR roof" right above the number. URL-only entries
    // from the server whitelist; print-safe grid.
    if (Array.isArray(est.photos) && est.photos.length) {
      html += '<div class="ev-section-title">Your Property</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin:10px 0 4px;">';
      est.photos.forEach(function (p) {
        if (!p || !p.url) return;
        html += '<img src="' + escHtml(p.url) + '" alt="Job site photo" loading="lazy" '
          + 'style="width:100%;border-radius:8px;display:block;break-inside:avoid;page-break-inside:avoid;'
          + '-webkit-print-color-adjust:exact;print-color-adjust:exact;">';
      });
      html += '</div>';
    }

    html += '<div class="ev-grand">';
    html +=   '<span class="ev-grand-lbl">Project Total</span>';
    html +=   '<span class="ev-grand-val">' + money(total) + '</span>';
    html += '</div>';

    // Payment terms (2026-09-25): the deposit rule's plan as the rep's builder
    // stamped it (docs/pro/js/deposit-rule.js), validated server-side by
    // functions/deposit-plan-view.js — the same stages and sentence the quote,
    // contract and invoice print. Older estimates carry none: nothing prints.
    var dp = est.depositPlan;
    if (dp && dp.summary) {
      html += '<div class="ev-section-title">Payment terms</div>';
      if (Array.isArray(dp.rows) && dp.rows.length) {
        html += '<ul class="ev-line-list ev-pay-list">';
        dp.rows.forEach(function (r) {
          html += '<li class="ev-line">';
          html +=   '<span class="ev-line-name">' + escHtml(r.label || '') + '</span>';
          html +=   '<span class="ev-line-qty">' + escHtml(r.due || '') + '</span>';
          html +=   '<span class="ev-line-amt">' + (r.amountCents != null ? money(r.amountCents / 100) : escHtml(r.amountText || '')) + '</span>';
          html += '</li>';
        });
        html += '</ul>';
      }
      html += '<p class="ev-pay-terms">' + escHtml(dp.summary) + '</p>';
    }

    html += '<div class="ev-cta-row">';
    html +=   '<button type="button" class="ghost" data-ev-action="print">Print / Save PDF</button>';
    html +=   backLinkHtml();
    html += '</div>';

    html += '<div class="ev-foot">';
    html +=   'This estimate is good for 30 days from the date issued. ';
    html +=   'Questions? Reply to your rep&#39;s message or call them directly.';
    html += '</div>';

    root.innerHTML = html;

    // ev-brand-logo error → hide (CSP-blocked/404 tenant logos must not
    // paint the broken-image icon). Property listener, not inline attr (CSP).
    var _bl = root.querySelector('.ev-brand-logo');
    if (_bl) _bl.addEventListener('error', function () { _bl.style.display = 'none'; });
  }
})();
