/**
 * customer-estimate-hub.js — the embedded per-customer estimate sub-system.
 *
 * RoofLink-style editor rebuild, Phase 1c (2026-07-27).
 *
 * THE PROBLEM: the ESTIMATE quick action inside a customer was a link, not a
 * feature. Tapping it closed the customer overlay and dropped the rep on the
 * GENERIC estimates view — every estimate in the tenant, no customer context,
 * and no way back except the browser. There has never been a per-customer
 * estimate surface: `_mJdAct` guessed at "the most recent estimate for this
 * lead" and opened the full-screen V2 builder on top of it.
 *
 * THE FIX: this module is a MINI PAGE, not a page. It mounts INSIDE a
 * container the host page already owns (today: the Estimates tab of the mobile
 * job-detail overlay), so the customer's hero, name, address and quick-action
 * ring stay directly above it in the same scroll. Scrolling up from an estimate
 * lands you back on the customer — you never leave their record.
 *
 *   window.CustomerEstimateHub.mount(containerOrId, leadId, opts)
 *   window.CustomerEstimateHub.refresh()      — re-render in place
 *   window.CustomerEstimateHub.unmount()
 *
 * What it renders, top to bottom (all one scroll):
 *   1. Money strip     — # of estimates, primary $, lifetime $ across all.
 *   2. Customer card   — phone / email / address / carrier / claim, each a
 *                        WORKING control (tel:, sms:, mailto:, maps) so the
 *                        rep can act on the customer without leaving here.
 *   3. Estimate cards  — tap to EXPAND INLINE: line items, subtotal, tax,
 *                        total, attached photos. No navigation, no modal.
 *   4. Row actions     — Edit, ★ Primary, Copy, Assign, Archive. Every one
 *                        wired to the real handler, not a stub.
 *   5. + New Estimate  — opens the V2 builder PREFILLED for this lead.
 *
 * Data comes from caches the host already holds (window._estimates,
 * window._leads) — mounting costs zero Firestore reads. The one write this
 * module owns is "make primary" (leads/{id}.jobValue + primaryEstimateId),
 * which mirrors the contract in customer-bootstrap.module.js setPrimaryEstimate:
 * money fields only, NEVER stage/stageRole — switching primary is not a funnel
 * event. Everything else delegates to the canonical estimate actions in
 * estimates.js so there is exactly one implementation of each.
 *
 * CSP: zero inline handlers. One delegated click listener on the container,
 * keyed on data-ceh-act; every interpolated value escaped.
 */
(function () {
  'use strict';
  if (window.CustomerEstimateHub && window.CustomerEstimateHub.__sentinel === 'nbd-ceh-v1') return;

  var SENTINEL = 'nbd-ceh-v1';

  // ── Small helpers ────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return '$' + Math.round(v).toLocaleString('en-US');
  }
  function ms(v) {
    if (!v) return 0;
    try {
      if (v.toDate) return v.toDate().getTime() || 0;
      var t = new Date(v).getTime();
      return isFinite(t) ? t : 0;
    } catch (e) { return 0; }
  }
  function fmtWhen(v) {
    var t = ms(v);
    if (!t) return '';
    var days = Math.floor((Date.now() - t) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return days + 'd ago';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function digits(s) { return String(s || '').replace(/[^0-9+]/g, ''); }
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }

  // Estimate totals live under different keys in the two builders
  // (V2 grandTotal / Classic total|amount) — one reader for both.
  //
  // Defer to the canonical reader (customer-estimate-rows.js) rather than
  // keeping a private copy. This matters because totalOf feeds the ★ Primary
  // WRITE below, which stamps lead.jobValue — and per the pipeline wiring,
  // lead.jobValue is what the kanban $, the KPIs and the leaderboard all read.
  // A total this function reads low doesn't just render wrong, it can be
  // committed over a live deal's value.
  //
  // The local fallback mirrors numFrom(): match the first numeric run and
  // strip commas, instead of Number(v) || 0. Number('$14,500') is NaN and
  // collapses to 0 — the shape the canonical reader has an explicit test for
  // ('display-string amount'). No in-app producer writes a formatted total
  // today (they all coerce with Number()), so this is defence against legacy
  // and imported docs, not a live defect — but it is a money path, and the
  // two readers disagreeing is exactly how the last $0-over-a-live-deal bug
  // happened.
  function totalOf(est) {
    if (!est) return 0;
    var api = window.NBDCustomerEstimateRows;
    if (api && typeof api.estimateValue === 'function') return api.estimateValue(est);
    var v = est.grandTotal != null ? est.grandTotal
      : est.total != null ? est.total
      : est.amount != null ? est.amount : 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    var m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
    var n = m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
    return isFinite(n) ? n : 0;
  }
  function isV2(est) {
    return !!(est && (est.builder === 'v2' || est.estimateVersion === 'v2'));
  }
  // A Log Estimate record (amount only). Its ✎ Edit opens the amount editor,
  // never Classic (dashboard-widgets.js viewEstimate, phone audit 2026-09-25),
  // so it is labelled Logged, like the dashboard list's LOGGED chip.
  function isLogged(est) {
    return typeof window._isLoggedEstimate === 'function' && !!window._isLoggedEstimate(est);
  }
  function kindLabel(est) {
    return isV2(est) ? 'V2' : isLogged(est) ? 'Logged' : 'Classic';
  }
  function titleOf(est) {
    return (est && (est.name || est.title || est.addr)) || 'Untitled estimate';
  }

  // V2 rows[] and Classic lineItems[] normalized to one line shape.
  function linesOf(est) {
    if (!est) return [];
    if (Array.isArray(est.rows) && est.rows.length) {
      return est.rows.map(function (r) {
        return {
          desc: r.desc || r.code || 'Item',
          qty: r.qty || (r.quantity != null ? r.quantity + ' ' + (r.unit || '') : ''),
          total: (r.total != null ? r.total : r.retailTotal)
        };
      });
    }
    if (Array.isArray(est.lineItems) && est.lineItems.length) {
      return est.lineItems.map(function (i) {
        return {
          desc: i.description || i.name || 'Item',
          qty: i.quantity != null ? i.quantity + ' ' + (i.unit || '') : '',
          total: i.amount
        };
      });
    }
    return [];
  }

  // ── Mount state ──────────────────────────────────────────────────────
  var _root = null;      // container element
  var _leadId = null;
  var _opts = {};
  var _expanded = Object.create(null);   // estimateId -> true
  var _clickBound = false;

  function getLead() {
    if (typeof _opts.getLead === 'function') return _opts.getLead(_leadId) || {};
    var arr = window._leads || [];
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === _leadId) return arr[i];
    return {};
  }

  // A lead's estimates: leadId match, plus a stamped primaryEstimateId that may
  // predate the leadId-attach fix (same rule the Activity tab uses — an orphaned
  // primary must still be reachable from the customer it drives).
  function getEstimates() {
    if (typeof _opts.getEstimates === 'function') return _opts.getEstimates(_leadId) || [];
    var lead = getLead();
    return (window._estimates || []).filter(function (e) {
      return e && (e.leadId === _leadId || (lead.primaryEstimateId && e.id === lead.primaryEstimateId));
    }).sort(function (a, b) { return ms(b.createdAt) - ms(a.createdAt); });
  }

  // ── Styles ───────────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById('nbd-ceh-style')) return;
    var st = document.createElement('style');
    st.id = 'nbd-ceh-style';
    st.textContent = [
      '.ceh{display:flex;flex-direction:column;gap:14px;}',
      // Money strip
      '.ceh-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;}',
      '.ceh-stat{background:var(--s2,#181c22);border:1px solid var(--br,#2a2f37);border-radius:10px;padding:10px 8px;text-align:center;min-width:0;}',
      '.ceh-stat-v{font-family:\'Barlow Condensed\',sans-serif;font-size:20px;font-weight:800;color:var(--t,#eee);line-height:1.1;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;}',
      '.ceh-stat-v.is-money{color:var(--green,#2ecc8a);}',
      '.ceh-stat-k{font-family:\'Barlow Condensed\',sans-serif;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--m,#98a0ab);margin-top:2px;}',
      // Section heading
      '.ceh-h{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.ceh-h-t{font-family:\'Barlow Condensed\',sans-serif;font-size:13px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--m,#98a0ab);}',
      // Customer context card
      '.ceh-cust{background:var(--s2,#181c22);border:1px solid var(--br,#2a2f37);border-radius:10px;overflow:hidden;}',
      '.ceh-cust-hd{display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;background:none;border:none;color:var(--t,#eee);cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent;}',
      '.ceh-cust-nm{flex:1;min-width:0;font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ceh-cust-bd{padding:0 14px 12px;}',
      '.ceh-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--br,#232830);font-size:13px;}',
      '.ceh-row:last-child{border-bottom:none;}',
      '.ceh-row-k{font-family:\'Barlow Condensed\',sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--m,#98a0ab);flex:none;}',
      '.ceh-row-v{color:var(--t,#eee);text-align:right;word-break:break-word;min-width:0;}',
      '.ceh-row-v a{color:var(--orange,#BD5728);text-decoration:none;}',
      // Estimate card
      '.ceh-card{background:var(--s2,#181c22);border:1px solid var(--br,#2a2f37);border-radius:10px;overflow:hidden;}',
      '.ceh-card.is-primary{border-color:color-mix(in srgb, var(--orange,#BD5728) 55%, var(--br,#2a2f37));}',
      '.ceh-card-hd{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;background:none;border:none;color:var(--t,#eee);cursor:pointer;text-align:left;-webkit-tap-highlight-color:transparent;}',
      '.ceh-card-hd:active{background:color-mix(in srgb, var(--orange,#BD5728) 10%, transparent);}',
      '.ceh-card-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;}',
      '.ceh-card-t{font-size:13px;font-weight:700;color:var(--t,#eee);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ceh-card-s{font-size:11px;color:var(--m,#98a0ab);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ceh-card-amt{flex:none;font-family:\'Barlow Condensed\',sans-serif;font-size:19px;font-weight:800;color:var(--green,#2ecc8a);font-variant-numeric:tabular-nums;}',
      '.ceh-card-chev{flex:none;color:var(--m,#98a0ab);font-size:15px;transition:transform .16s ease;}',
      '.ceh-card.is-open .ceh-card-chev{transform:rotate(90deg);}',
      '.ceh-card-detail{padding:0 14px 12px;border-top:1px solid var(--br,#232830);}',
      // Chips
      '.ceh-chips{display:flex;flex-wrap:wrap;gap:5px;margin:10px 0 2px;}',
      '.ceh-chip{display:inline-block;padding:3px 8px;border-radius:20px;font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;border:1px solid var(--br,#2a2f37);color:var(--m,#98a0ab);}',
      '.ceh-chip.is-primary{color:var(--orange,#BD5728);border-color:var(--orange,#BD5728);}',
      '.ceh-chip.is-good{color:var(--green,#2ecc8a);border-color:var(--green,#2ecc8a);}',
      '.ceh-chip.is-warn{color:var(--orange,#BD5728);border-color:var(--orange,#BD5728);}',
      '.ceh-chip.is-bad{color:var(--red,#e5484d);border-color:var(--red,#e5484d);}',
      // Line items
      '.ceh-line{display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--br,#232830);}',
      '.ceh-line-d{min-width:0;font-size:12px;font-weight:600;color:var(--t,#eee);}',
      '.ceh-line-q{font-size:10px;color:var(--m,#98a0ab);margin-top:1px;}',
      '.ceh-line-t{flex:none;font-size:12px;font-weight:700;color:var(--t,#eee);white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.ceh-tot{display:flex;justify-content:space-between;align-items:baseline;padding-top:9px;}',
      '.ceh-tot-k{font-family:\'Barlow Condensed\',sans-serif;font-size:13px;font-weight:800;letter-spacing:.08em;color:var(--m,#98a0ab);}',
      '.ceh-tot-v{font-family:\'Barlow Condensed\',sans-serif;font-size:24px;font-weight:800;color:var(--green,#2ecc8a);font-variant-numeric:tabular-nums;}',
      '.ceh-sub{display:flex;justify-content:space-between;padding:3px 0;font-size:11px;color:var(--m,#98a0ab);}',
      // Signed, then re-priced (review R6-2-2): the bills follow the signed price.
      '.ceh-signed-note{margin-top:10px;padding:9px 11px;border-radius:8px;border:1px solid var(--orange,#BD5728);background:color-mix(in srgb, var(--orange,#BD5728) 9%, transparent);font-size:12px;line-height:1.45;color:var(--t,#eee);}',
      '.ceh-photos{display:flex;gap:6px;overflow-x:auto;margin-top:10px;-webkit-overflow-scrolling:touch;}',
      '.ceh-photos img{height:58px;border-radius:6px;flex:none;border:1px solid var(--br,#2a2f37);}',
      // Actions
      '.ceh-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px;}',
      '.ceh-btn{flex:1 1 auto;min-width:84px;padding:10px 8px;border-radius:8px;border:1px solid var(--br,#2a2f37);background:var(--s,#14181f);color:var(--t,#eee);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:12px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;-webkit-tap-highlight-color:transparent;}',
      '.ceh-btn:active{background:color-mix(in srgb, var(--orange,#BD5728) 14%, transparent);}',
      '.ceh-btn.primary{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);color:var(--accent-fg,#fff);}',
      '.ceh-btn.danger{color:var(--red,#e5484d);}',
      '.ceh-btn[disabled]{opacity:.45;cursor:not-allowed;}',
      '.ceh-new{width:100%;padding:14px;border-radius:10px;border:1px dashed color-mix(in srgb, var(--orange,#BD5728) 55%, var(--br,#2a2f37));background:color-mix(in srgb, var(--orange,#BD5728) 8%, transparent);color:var(--orange,#BD5728);font-family:\'Barlow Condensed\',sans-serif;font-weight:800;font-size:14px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;-webkit-tap-highlight-color:transparent;}',
      '.ceh-empty{padding:26px 14px;text-align:center;color:var(--m,#98a0ab);font-size:13px;}'
    ].join('');
    document.head.appendChild(st);
  }

  // ── Render ───────────────────────────────────────────────────────────
  function statusChips(est, isPrimary) {
    var out = '';
    if (isPrimary) out += '<span class="ceh-chip is-primary">★ Primary</span>';
    out += '<span class="ceh-chip">' + kindLabel(est) + '</span>';
    // No tier chip when no tier applies — a Job Template estimate's saved
    // tier was a silent default before 2026-09-25 (shared rule).
    var rowsApi = window.NBDCustomerEstimateRows;
    var tierOk = !(rowsApi && typeof rowsApi.tierApplies === 'function' && rowsApi.tierApplies(est) === false);
    if (est.tier && tierOk) out += '<span class="ceh-chip">' + esc(String(est.tier)) + '</span>';
    if (est.sq != null && Number(est.sq)) out += '<span class="ceh-chip">' + esc(Number(est.sq).toFixed(2)) + ' SQ</span>';
    var sig = est.signatureStatus || '';
    // Re-priced after signing (review R6-2-2): this version is NOT signed.
    var resigned = unsignedChanges(est);
    if (resigned) out += '<span class="ceh-chip is-warn">✎ Changed — not signed</span>';
    if (sig === 'signed' && !resigned) out += '<span class="ceh-chip is-good">✓ Signed</span>';
    else if (sig === 'sent' || sig === 'viewed') out += '<span class="ceh-chip is-warn">✍ Awaiting sign</span>';
    else if (sig === 'declined') out += '<span class="ceh-chip is-bad">✗ Declined</span>';
    if (!est.leadId) out += '<span class="ceh-chip is-warn">Not attached</span>';
    var when = fmtWhen(est.createdAt);
    if (when) out += '<span class="ceh-chip">' + esc(when) + '</span>';
    return '<div class="ceh-chips">' + out + '</div>';
  }

  // Jo's rule (review R6-2-2, 2026-10-07): a signed estimate stays editable,
  // but every bill — invoices, the deposit and final drafts, the portal,
  // Stripe — charges the SIGNED price until the homeowner re-signs
  // (customer-estimate-rows.js signedView). Say so where the rep edits it.
  function unsignedChanges(est) {
    var api = window.NBDCustomerEstimateRows;
    return !!(api && typeof api.hasUnsignedChanges === 'function' && api.hasUnsignedChanges(est));
  }
  function signedNote(est) {
    if (!unsignedChanges(est)) return '';
    var api = window.NBDCustomerEstimateRows;
    var c = api.signedTotalCents(est);
    return '<div class="ceh-signed-note"><strong>Signed at ' + (c != null ? money(c / 100) : 'the earlier price') + '.</strong> '
      + 'This version (' + money(totalOf(est)) + ') is not signed yet — the homeowner must re-sign it. '
      + 'Until then every bill (invoice, deposit and final drafts, portal, pay link) follows the signed price.</div>';
  }

  function cardDetail(est, isPrimary) {
    var lines = linesOf(est);
    var html = statusChips(est, isPrimary);

    html += lines.length
      ? lines.map(function (l) {
          return '<div class="ceh-line"><div class="ceh-line-d">' + esc(l.desc) +
            (l.qty ? '<div class="ceh-line-q">' + esc(l.qty) + '</div>' : '') + '</div>' +
            '<div class="ceh-line-t">' + (l.total != null ? money(l.total) : '—') + '</div></div>';
        }).join('')
      : '<div style="padding:12px 0;color:var(--m,#98a0ab);font-size:12px;">No line items on this estimate yet — open the builder to add scope.</div>';

    if (est.subtotal != null && Number(est.subtotal) !== totalOf(est)) {
      html += '<div class="ceh-sub"><span>Subtotal</span><span>' + money(est.subtotal) + '</span></div>';
    }
    if (est.tax != null && Number(est.tax) > 0) {
      html += '<div class="ceh-sub"><span>Tax</span><span>' + money(est.tax) + '</span></div>';
    }
    html += '<div class="ceh-tot"><span class="ceh-tot-k">TOTAL</span><span class="ceh-tot-v">' + money(totalOf(est)) + '</span></div>';
    html += signedNote(est);

    if (Array.isArray(est.photos) && est.photos.length) {
      html += '<div class="ceh-photos">' + est.photos.map(function (p) {
        return '<img src="' + esc(p && p.url) + '" alt="" loading="lazy">';
      }).join('') + '</div>';
    }

    var id = esc(est.id);
    html += '<div class="ceh-acts">' +
      '<button type="button" class="ceh-btn primary" data-ceh-act="edit" data-ceh-id="' + id + '">✎ Edit</button>' +
      (isPrimary
        ? '<button type="button" class="ceh-btn" disabled>★ Primary</button>'
        : '<button type="button" class="ceh-btn" data-ceh-act="primary" data-ceh-id="' + id + '">☆ Make primary</button>') +
      '<button type="button" class="ceh-btn" data-ceh-act="duplicate" data-ceh-id="' + id + '">⎘ Copy</button>' +
      // Recommended buy list from this estimate (materials-list.js, 2026-10-02).
      (Array.isArray(est.rows) && est.rows.length && window.NBDMaterials ? '<button type="button" class="ceh-btn" data-ceh-act="materials" data-ceh-id="' + id + '">🧾 Materials</button>' : '') +
      '<button type="button" class="ceh-btn" data-ceh-act="assign" data-ceh-id="' + id + '">👤 Assign</button>' +
      // Labelled for what it DOES. This button was once relabelled "🗑 Delete"
      // because deleteEstimateAction called deleteDoc() and destroyed the
      // document. Since R5-8-2 (#2286) it is a SOFT delete: the estimate gets
      // the deleted flag, the dashboard/portal readers drop it, and the lead's
      // primary + jobValue are re-synced. So it is an archive again, and the
      // confirm says so (estimate-crm-ops.js deleteEstimateAction).
      '<button type="button" class="ceh-btn danger" data-ceh-act="archive" data-ceh-id="' + id + '">🗄 Archive</button>' +
      '</div>';
    return html;
  }

  function render() {
    if (!_root) return;
    var lead = getLead();
    var ests = getEstimates();
    var primaryId = lead.primaryEstimateId || null;

    // ── 1. Money strip ──
    var lifetime = ests.reduce(function (s, e) { return s + totalOf(e); }, 0);
    var primaryEst = null;
    for (var i = 0; i < ests.length; i++) if (ests[i].id === primaryId) primaryEst = ests[i];
    // Job value is the lead's denormalized number (what the pipeline / KPIs
    // actually read). Show it, not a recomputed sum, so this panel can never
    // disagree with the kanban card for the same customer.
    var jobValue = Number(lead.jobValue) || (primaryEst ? totalOf(primaryEst) : 0);

    var html = '<div class="ceh">';
    html += '<div class="ceh-strip">' +
      '<div class="ceh-stat"><div class="ceh-stat-v">' + ests.length + '</div><div class="ceh-stat-k">Estimates</div></div>' +
      '<div class="ceh-stat"><div class="ceh-stat-v is-money">' + money(jobValue) + '</div><div class="ceh-stat-k">Job value</div></div>' +
      '<div class="ceh-stat"><div class="ceh-stat-v">' + money(lifetime) + '</div><div class="ceh-stat-k">All quoted</div></div>' +
      '</div>';

    // ── 2. Customer context (collapsible; the point of an EMBEDDED hub is
    //       that the customer's own data stays reachable from inside it) ──
    var phone = digits(lead.phone);
    var email = (lead.email || '').trim();
    var addr = (lead.address || '').trim();
    var custRows = '';
    if (phone) {
      custRows += '<div class="ceh-row"><span class="ceh-row-k">Phone</span><span class="ceh-row-v">' +
        '<a href="tel:' + esc(phone) + '">' + esc(lead.phone) + '</a>' +
        ' &nbsp;·&nbsp; <a href="sms:' + esc(phone) + '">Text</a></span></div>';
    }
    if (email) {
      custRows += '<div class="ceh-row"><span class="ceh-row-k">Email</span><span class="ceh-row-v">' +
        '<a href="mailto:' + esc(email) + '">' + esc(email) + '</a></span></div>';
    }
    if (addr) {
      custRows += '<div class="ceh-row"><span class="ceh-row-k">Address</span><span class="ceh-row-v">' +
        '<a href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr) + '" target="_blank" rel="noopener noreferrer">' + esc(addr) + '</a></span></div>';
    }
    // insCarrier / deductibleOrOwedByHO are what the lead form writes; the
    // other names are legacy. Reading only those left both rows blank.
    var carrier = lead.insCarrier || lead.carrier || lead.insuranceCarrier || '';
    var _ded = lead.deductibleOrOwedByHO || lead.deductible;
    var claim = lead.claimNumber || lead.claim || '';
    if (carrier) custRows += '<div class="ceh-row"><span class="ceh-row-k">Carrier</span><span class="ceh-row-v">' + esc(carrier) + '</span></div>';
    if (claim) custRows += '<div class="ceh-row"><span class="ceh-row-k">Claim #</span><span class="ceh-row-v">' + esc(claim) + '</span></div>';
    if (_ded) custRows += '<div class="ceh-row"><span class="ceh-row-k">Deductible</span><span class="ceh-row-v">' + money(_ded) + '</span></div>';
    if (!custRows) custRows = '<div class="ceh-row"><span class="ceh-row-v" style="color:var(--m,#98a0ab);">No contact details on file yet — use Edit on the customer to add them.</span></div>';

    var custName = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.name || 'Customer';
    var custOpen = _expanded.__cust === true;
    html += '<div class="ceh-cust">' +
      '<button type="button" class="ceh-cust-hd" data-ceh-act="toggle-cust" aria-expanded="' + (custOpen ? 'true' : 'false') + '">' +
        '<span class="ceh-cust-nm">👤 ' + esc(custName) + '</span>' +
        '<span class="ceh-card-chev">' + (custOpen ? '▾' : '›') + '</span>' +
      '</button>' +
      (custOpen ? '<div class="ceh-cust-bd">' + custRows + '</div>' : '') +
      '</div>';

    // ── 3. Estimate cards ──
    html += '<div class="ceh-h"><span class="ceh-h-t">Estimates</span></div>';
    if (!ests.length) {
      html += '<div class="ceh-empty">No estimates for this customer yet.<br>Build the first one below — it stamps the job value onto the pipeline automatically.</div>';
    } else {
      html += ests.map(function (est) {
        var isPrimary = !!(primaryId && est.id === primaryId);
        var open = _expanded[est.id] === true;
        var sub = [fmtWhen(est.createdAt), isV2(est) ? 'V2 builder' : kindLabel(est)].filter(Boolean).join(' · ');
        return '<div class="ceh-card' + (isPrimary ? ' is-primary' : '') + (open ? ' is-open' : '') + '">' +
          '<button type="button" class="ceh-card-hd" data-ceh-act="toggle" data-ceh-id="' + esc(est.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
            '<span class="ceh-card-body">' +
              '<span class="ceh-card-t">' + (isPrimary ? '★ ' : '') + esc(titleOf(est)) + '</span>' +
              '<span class="ceh-card-s">' + esc(sub) + '</span>' +
            '</span>' +
            '<span class="ceh-card-amt">' + money(totalOf(est)) + '</span>' +
            '<span class="ceh-card-chev">›</span>' +
          '</button>' +
          (open ? '<div class="ceh-card-detail">' + cardDetail(est, isPrimary) + '</div>' : '') +
          '</div>';
      }).join('');
    }

    // ── 4. New estimate, prefilled for this customer ──
    html += '<button type="button" class="ceh-new" data-ceh-act="new">＋ New estimate for ' + esc(custName) + '</button>';
    html += '</div>';

    _root.innerHTML = html;
  }

  // ── Actions ──────────────────────────────────────────────────────────
  // The estimate engine is lazy (ScriptLoader 'estimates' bundle). Every action
  // that needs it loads first, then runs — a tap before the bundle lands must
  // still work rather than silently no-op.
  function withEstimates(fnName, args) {
    var fn = window[fnName];
    if (typeof fn === 'function' && !fn.__nbdLazyEstimateStub) { fn.apply(null, args || []); return; }
    if (!(window.ScriptLoader && window.ScriptLoader.loadBundle)) {
      toast('Estimate tools are still loading — try again in a moment', 'warning');
      return;
    }
    window.ScriptLoader.loadBundle('estimates').then(function () {
      var f = window[fnName];
      if (typeof f === 'function' && !f.__nbdLazyEstimateStub) f.apply(null, args || []);
      else toast('Estimate tools are still loading — try again in a moment', 'warning');
    });
  }

  function openBuilder(estId) {
    var ests = getEstimates();
    var est = null;
    for (var i = 0; i < ests.length; i++) if (ests[i].id === estId) est = ests[i];
    if (!est) { toast('Estimate not found — it may still be loading', 'error'); return; }
    // V2 opens its own full-screen modal ON TOP of the host overlay, so the
    // customer context is still underneath when the rep closes it. Classic's
    // builder is DOM inside the `est` view, so that path has to navigate —
    // it's the one case where leaving is unavoidable.
    if (isV2(est)) {
      withEstimates('openEstimateV2Builder', [{ estimateId: estId }]);
      return;
    }
    // A logged record never opens Classic: viewEstimate routes it to a small
    // amount editor, a fixed sheet that sits above this overlay. So, like V2,
    // it stays in the customer's context. The editor's save repaints the
    // estimates list, which refreshes this hub.
    if (isLogged(est) && typeof window.viewEstimate === 'function') {
      window.viewEstimate(estId);
      return;
    }
    if (typeof _opts.onLeaveForClassic === 'function') _opts.onLeaveForClassic();
    if (typeof window.goTo === 'function') window.goTo('est');
    withEstimates('viewEstimate', [estId]);
  }

  function newEstimate() {
    // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
    if (window.NBDRole && !window.NBDRole.guard()) return;
    withEstimates('openEstimateV2Builder', [{ leadId: _leadId }]);
  }

  // Make-primary write. Mirrors customer-bootstrap.module.js setPrimaryEstimate
  // EXACTLY: money fields only (jobValue + primaryEstimateId + lastEstimateAt),
  // never stage/stageRole — switching which estimate counts is not a funnel
  // event. Leads have no snapshot listener on the dashboard either, so the
  // in-memory lead + kanban are refreshed by hand.
  function makePrimary(estId) {
    // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
    if (window.NBDRole && !window.NBDRole.guard()) return;
    var ests = getEstimates();
    var est = null;
    for (var i = 0; i < ests.length; i++) if (ests[i].id === estId) est = ests[i];
    var lead = getLead();
    if (!est || !_leadId) return;
    if (String(lead.primaryEstimateId || '') === String(estId)) {
      toast('That estimate is already primary', 'info');
      return;
    }
    if (!(window.db && window.doc && window.updateDoc && window.serverTimestamp)) {
      toast('Not connected — reload the page and try again', 'error');
      return;
    }
    var newVal = totalOf(est);
    var oldVal = Number(lead.jobValue) || 0;
    var ask = window.nbdConfirm || function (m) { return Promise.resolve(window.confirm(m)); };

    // A draft/$0 estimate would zero out a live deal's job value. Confirm —
    // then allow, because a draft CAN legitimately be the one you're going with.
    var gate = newVal <= 0
      ? ask('This estimate has no dollar value yet — set it as primary and make the job value $0?')
      : Promise.resolve(true);

    gate.then(function (ok) {
      if (!ok) return;
      return window.updateDoc(window.doc(window.db, 'leads', _leadId), {
        jobValue: newVal,
        primaryEstimateId: estId,
        lastEstimateAt: window.serverTimestamp()
      }).then(function () {
        // Audit row on the customer timeline (the shared `communications`
        // note convention — type:'note' + explicit title renders as an
        // activity entry on the customer page).
        if (window.addDoc && window.collection && window.auth) {
          try {
            window.addDoc(window.collection(window.db, 'communications'), {
              leadId: _leadId,
              userId: window.auth.currentUser && window.auth.currentUser.uid,
              type: 'note',
              title: 'Job value updated',
              content: 'Primary estimate set to "' + titleOf(est) + '" — job value ' + money(oldVal) + ' → ' + money(newVal),
              timestamp: window.serverTimestamp(),
              source: 'primary_switch'
            }).catch(function (e) { console.warn('[ceh] audit log failed:', e && e.message); });
          } catch (e) { console.warn('[ceh] audit log failed:', e && e.message); }
        }
        // Refresh in memory — no leads listener exists on this page.
        var arr = window._leads || [];
        for (var j = 0; j < arr.length; j++) {
          if (arr[j] && arr[j].id === _leadId) {
            arr[j].primaryEstimateId = estId;
            arr[j].jobValue = newVal;
          }
        }
        if (window._currentLead && window._currentLead.id === _leadId) {
          window._currentLead.primaryEstimateId = estId;
          window._currentLead.jobValue = newVal;
        }
        // Kanban $ reads lead.jobValue — repaint so the card matches.
        if (typeof window.renderLeads === 'function' && Array.isArray(window._leads)) {
          try { window.renderLeads(window._leads, window._filteredLeads); } catch (e) {}
        }
        // Host header ($ pill on the job-detail overlay) gets a chance to update.
        if (typeof _opts.onLeadChanged === 'function') {
          try { _opts.onLeadChanged(_leadId, { jobValue: newVal, primaryEstimateId: estId }); } catch (e) {}
        }
        render();
        toast('Primary estimate set — job value updated', 'success');
      });
    }).catch(function (e) {
      console.error('[ceh] makePrimary failed:', e);
      toast('Failed to set primary: ' + ((e && e.message) || 'unknown error'), 'error');
    });
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-ceh-act]');
    if (!t || !_root.contains(t)) return;
    var act = t.getAttribute('data-ceh-act');
    var id = t.getAttribute('data-ceh-id');
    // Row headers live inside the host's own click surfaces; keep our taps ours.
    ev.preventDefault();
    ev.stopPropagation();
    switch (act) {
      case 'toggle':
        if (!id) return;
        if (_expanded[id]) delete _expanded[id]; else _expanded[id] = true;
        render();
        break;
      case 'toggle-cust':
        if (_expanded.__cust) delete _expanded.__cust; else _expanded.__cust = true;
        render();
        break;
      case 'edit':      openBuilder(id); break;
      case 'primary':   makePrimary(id); break;
      case 'duplicate': doDuplicate(id); break;
      case 'materials': {
        const est = getEstimates().find(function (e) { return e && e.id === id; });
        if (est && window.NBDMaterials) window.NBDMaterials.open(est, getLead());
        break;
      }
      case 'assign':    withEstimates('assignEstimateAction', [id]); break;
      case 'archive':   withEstimates('deleteEstimateAction', [id]); break;
      case 'new':       newEstimate(); break;
    }
  }

  // Duplicating from a per-customer hub means "another estimate for THIS
  // customer" — the surrounding UI is that customer's job.
  //
  // The generic duplicateEstimateAction cannot mean that: window._duplicateEstimate
  // deliberately sets `leadId = null` on the copy so the rep can assign it from
  // the dashboard estimates list, which is the right default THERE. Routed
  // through it, this button toasted "✓ Estimate duplicated" and the copy never
  // appeared — the hub lists by leadId, so an unassigned copy is filtered out.
  // The rep saw a success message, an unchanged list and an unchanged count,
  // which reads as a failed action rather than a misfiled one.
  //
  // _duplicateEstimate is eager (dashboard-bootstrap), so unlike the other
  // actions here this needs no lazy-bundle hop.
  function doDuplicate(id) {
    // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
    if (window.NBDRole && !window.NBDRole.guard()) return;
    if (typeof window._duplicateEstimate !== 'function') {
      toast('Duplicate not available — reload the page', 'error');
      return;
    }
    var lead = _leadId;
    Promise.resolve(window._duplicateEstimate(id)).then(function (newId) {
      if (!newId) { toast('Failed to duplicate', 'error'); return; }
      if (!lead || !(window.db && window.doc && window.updateDoc)) {
        // Copy exists but we cannot attach it. Say so plainly rather than
        // claiming success for something the rep will not find here.
        toast('Estimate duplicated, but not attached to this customer', 'warning');
        refresh();
        return;
      }
      return window.updateDoc(window.doc(window.db, 'estimates', newId), { leadId: lead })
        .then(function () {
          // Patch the in-memory copy too — the hub renders from window._estimates
          // and _duplicateEstimate's reload raced this attach.
          var arr = window._estimates || [];
          for (var i = 0; i < arr.length; i++) {
            if (arr[i] && arr[i].id === newId) arr[i].leadId = lead;
          }
          if (_leadId === lead) refresh();
          toast('✓ Estimate duplicated', 'success');
        })
        .catch(function (e) {
          console.warn('[ceh] duplicate attach failed:', e && e.message);
          toast('Estimate duplicated, but not attached to this customer', 'warning');
        });
    }).catch(function (e) {
      console.warn('[ceh] duplicate failed:', e && e.message);
      toast('Failed to duplicate', 'error');
    });
  }

  // ── Public API ───────────────────────────────────────────────────────
  function mount(containerOrId, leadId, opts) {
    var el = typeof containerOrId === 'string'
      ? document.getElementById(containerOrId)
      : containerOrId;
    if (!el || !leadId) return false;
    ensureStyle();
    // A different customer gets a clean expand state; re-mounting the SAME
    // customer (tab switch, live estimate update) keeps whatever they opened.
    if (_leadId !== leadId) _expanded = Object.create(null);
    _root = el;
    _leadId = leadId;
    _opts = opts || {};
    if (!_clickBound) {
      document.addEventListener('click', function (ev) {
        if (!_root || !_root.isConnected) return;
        if (!_root.contains(ev.target)) return;
        onClick(ev);
      }, true);
      _clickBound = true;
    }
    render();
    return true;
  }

  function refresh() {
    if (!_root || !_root.isConnected || !_leadId) return;
    render();
  }

  function unmount() {
    if (_root) _root.innerHTML = '';
    _root = null;
    _leadId = null;
    _opts = {};
  }

  window.CustomerEstimateHub = {
    __sentinel: SENTINEL,
    mount: mount,
    refresh: refresh,
    unmount: unmount,
    isMounted: function () { return !!(_root && _root.isConnected); },
    leadId: function () { return _leadId; }
  };
})();
