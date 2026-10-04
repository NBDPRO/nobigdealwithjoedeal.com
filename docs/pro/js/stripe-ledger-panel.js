/**
 * stripe-ledger-panel.js — the Money view's "Stripe" panel.
 *
 * Jo (2026-09-29): "Every transaction from Stripe makes its way back to the
 * CRM, recorded, linked to the customers in the CRM under their names."
 * functions/stripe-ledger.js records every movement in stripeLedger/{id};
 * this panel shows it:
 *   - Stripe balance (available / pending) and payouts   getStripeOverview
 *   - this month's Stripe collected: gross, fees, net     ledger charge rows
 *   - Needs review: payments the ledger could not place   needsReview:true
 *     with "Assign to <name>" + a customer search          assignStripeTransaction
 *   - recent transactions, each under the customer's name
 *   - Sync from Stripe: a DRY-RUN preview first, then Apply  stripeLedgerSync
 *
 * Who sees it: firestore.rules lets the owner, same-company company_admin /
 * manager and a platform admin read stripeLedger — never a sales rep or a
 * viewer, so for them the panel does not render at all. The write buttons
 * (assign / sync / apply) are for the owner and company_admin only (the
 * callables' requireOwner) and are listed in role-gate.js WRITE_SELECTORS.
 *
 * Mounted by money-dashboard.js render() into #nbd-stripe-panel. Pure rules
 * live in stripe-ledger-ui-logic.js (window.NBDStripeLedgerLogic). CSP: no
 * inline handlers — one delegated listener on document for data-sl-action.
 * Every Stripe-supplied string is escaped (names/emails are public input).
 */
(function () {
  'use strict';
  if (window.StripeLedgerPanel) return;

  var L = window.NBDStripeLedgerLogic;
  var esc = L.esc;

  var state = {
    rows: [], review: [], overview: null, overviewErr: null, ledgerErr: null,
    loading: false, showAll: false, hostId: null,
  };
  var armed = {};          // ledgerId|leadId → timestamp of the first tap
  var inflight = {};       // ledgerId → true while an assign runs
  var sync = { phase: 'idle', res: null, err: null, days: '0' };

  function uid() { return (window._user && window._user.uid) || (window._auth && window._auth.currentUser && window._auth.currentUser.uid) || null; }
  function claims() { return window._userClaims || {}; }
  function tenant() { return L.tenantOf(claims(), uid()); }
  function readable() { return L.canRead(claims(), uid()); }
  function writable() { return L.canWrite(claims(), uid()); }
  function toast(msg, type) { if (typeof window.showToast === 'function') window.showToast(msg, type || 'info'); }
  function leadsById() { return L.leadsIndex(window._leads || []); }

  // ── callables: same lazy pattern as close-board.js, INCLUDING the
  // emulator connect (a local run that skipped it would call PRODUCTION).
  // enforceAppCheck callables: the SDK attaches the App Check token itself.
  async function callable(name, payload, timeoutMs) {
    if (!window._httpsCallable || !window._functions) {
      var mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      try {
        var emu = await import('./nbd-emulator-connect.js');
        await emu.connectEmulatorsIfLocal({ functions: window._functions }); // no-op in prod
      } catch (_) { /* prod path */ }
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
    }
    var fn = window._httpsCallable(window._functions, name, timeoutMs ? { timeout: timeoutMs } : undefined);
    var res = await fn(payload || {});
    return res && res.data;
  }
  function errText(e) {
    var code = String((e && e.code) || '').replace(/^functions\//, '');
    if (code === 'permission-denied') return 'Only the account owner or a company admin can do this.';
    if (code === 'unauthenticated') return 'Sign in again to reach Stripe.';
    if (code === 'failed-precondition') return (e && e.message) || 'Stripe refused that.';
    if (code === 'not-found') return (e && e.message && !/^not[- ]found$/i.test(e.message)) ? e.message : 'The Stripe service is not available here.';
    if (code === 'deadline-exceeded') return 'Stripe took too long — try again.';
    return 'Could not reach Stripe right now.';
  }

  // ── styles (injected once; style-src allows it, like invoice-pipeline) ─
  function ensureStyles() {
    if (document.getElementById('nbd-sl-styles')) return;
    var st = document.createElement('style');
    st.id = 'nbd-sl-styles';
    st.textContent = [
      '.sl-wrap{background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:14px;margin-bottom:20px;min-width:0;}',
      '.sl-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:12px;}',
      '.sl-title{margin:0;font-size:15px;font-weight:800;color:var(--t,#fff);display:flex;align-items:center;gap:8px;}',
      '.sl-badge{background:var(--gold,#eab308);color:#111;font-size:11px;font-weight:800;border-radius:999px;padding:1px 8px;}',
      '.sl-btns{display:flex;gap:6px;flex-wrap:wrap;}',
      '.sl-btn{border:1px solid var(--br,rgba(255,255,255,.12));background:var(--s2,rgba(255,255,255,.06));color:var(--t,#fff);border-radius:8px;padding:7px 11px;font-size:12px;font-weight:700;cursor:pointer;min-height:34px;}',
      '.sl-btn.pri{background:var(--orange,#BD5728);border-color:transparent;color:#fff;}',
      '.sl-btn.arm{background:var(--gold,#eab308);color:#111;border-color:transparent;}',
      '.sl-btn[disabled]{opacity:.55;cursor:default;}',
      '.sl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:12px;}',
      '.sl-tile{background:var(--s2,rgba(255,255,255,.04));border-radius:10px;padding:10px;min-width:0;}',
      '.sl-lbl{font-size:10px;font-weight:700;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;}',
      '.sl-val{font-size:18px;font-weight:800;color:var(--t,#fff);margin-top:2px;overflow-wrap:anywhere;}',
      '.sl-sub{font-size:11px;color:var(--m,#9ca3af);margin-top:2px;overflow-wrap:anywhere;}',
      '.sl-sec{font-size:11px;font-weight:800;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px;}',
      '.sl-err{font-size:12px;color:var(--m,#9ca3af);background:var(--s2,rgba(255,255,255,.04));border-radius:10px;padding:10px;margin-bottom:12px;}',
      '.sl-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 10px;padding:9px 0;border-bottom:1px solid var(--br,rgba(255,255,255,.06));}',
      '.sl-row:last-child{border-bottom:none;}',
      '.sl-name{font-size:13px;font-weight:700;color:var(--t,#fff);overflow-wrap:anywhere;min-width:0;}',
      '.sl-name a{color:var(--t,#fff);text-decoration:none;}',
      '.sl-amt{font-size:13px;font-weight:800;color:var(--t,#fff);text-align:right;white-space:nowrap;}',
      '.sl-amt.neg{color:var(--red,#dc2626);}',
      '.sl-meta{font-size:11px;color:var(--m,#9ca3af);overflow-wrap:anywhere;min-width:0;}',
      '.sl-links{display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end;}',
      '.sl-links a{font-size:11px;font-weight:700;color:var(--blue,#3b82f6);text-decoration:none;white-space:nowrap;}',
      '.sl-un{font-size:10px;font-weight:800;color:var(--gold,#eab308);margin-left:4px;white-space:nowrap;}',
      '.sl-chip{display:inline-block;font-size:10px;font-weight:800;border-radius:999px;padding:1px 7px;white-space:nowrap;}',
      '.sl-chip.good{background:color-mix(in srgb,var(--green,#16a34a) 18%,transparent);color:var(--green,#16a34a);}',
      '.sl-chip.bad{background:color-mix(in srgb,var(--red,#dc2626) 18%,transparent);color:var(--red,#dc2626);}',
      '.sl-chip.warn{background:color-mix(in srgb,var(--gold,#eab308) 20%,transparent);color:var(--gold,#eab308);}',
      '.sl-chip.info{background:color-mix(in srgb,var(--blue,#3b82f6) 18%,transparent);color:var(--blue,#3b82f6);}',
      '.sl-chip.muted{background:var(--s2,rgba(255,255,255,.06));color:var(--m,#9ca3af);}',
      '.sl-card{background:var(--s2,rgba(255,255,255,.04));border:1px solid color-mix(in srgb,var(--gold,#eab308) 35%,transparent);border-radius:10px;padding:11px;margin-bottom:8px;min-width:0;}',
      '.sl-card .sl-top{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}',
      '.sl-party{font-size:12px;color:var(--m,#9ca3af);margin-top:4px;line-height:1.45;overflow-wrap:anywhere;}',
      '.sl-sugg{display:flex;flex-direction:column;gap:6px;margin-top:9px;}',
      '.sl-sugg .sl-btn{text-align:left;width:100%;overflow-wrap:anywhere;}',
      '.sl-search{width:100%;box-sizing:border-box;margin-top:8px;padding:9px 10px;border-radius:8px;border:1px solid var(--br,rgba(255,255,255,.12));background:var(--s,#12223D);color:var(--t,#fff);font-size:16px;}',
      '.sl-note{font-size:11px;color:var(--m,#9ca3af);margin-top:6px;}',
      '.sl-more{margin-top:10px;}',
      // sync modal
      '.sl-ov{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10050;display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;box-sizing:border-box;}',
      '.sl-modal{background:var(--s,#12223D);color:var(--t,#fff);border:1px solid var(--br,rgba(255,255,255,.12));border-radius:14px;padding:16px;width:100%;max-width:760px;box-sizing:border-box;min-width:0;margin:auto 0;}',
      '.sl-modal h3{margin:0 0 6px;font-size:17px;}',
      '.sl-modal p{font-size:13px;color:var(--m,#9ca3af);margin:6px 0;line-height:1.45;}',
      '.sl-modal select{font-size:16px;padding:7px;border-radius:8px;background:var(--s2,#1b2d4d);color:var(--t,#fff);border:1px solid var(--br,rgba(255,255,255,.12));max-width:100%;}',
      '.sl-mfoot{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px;}',
      '.sl-grp{margin-top:12px;}',
      '.sl-grp h4{margin:0 0 6px;font-size:12px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;}',
      '.sl-prow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1px 10px;padding:7px 0;border-bottom:1px solid var(--br,rgba(255,255,255,.06));font-size:12px;}',
      '.sl-act{text-align:right;}',
      // Phone: the action takes its own line so the name keeps the width.
      '@media (max-width:520px){.sl-prow .sl-act{grid-column:1/-1;text-align:left;}}',
      '.sl-spin{padding:22px;text-align:center;color:var(--m,#9ca3af);font-size:13px;}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // ── data ─────────────────────────────────────────────────────────────
  function fb() {
    return { db: window.db || window._db, collection: window.collection, query: window.query, where: window.where,
      orderBy: window.orderBy, limit: window.limit };
  }
  async function loadLedger() {
    var t = tenant();
    var f = fb();
    if (!t || !f.db || !window.getDocs) throw new Error('not ready');
    var toRows = function (s) { return s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); };
    var out = await Promise.all([
      window.getDocs(L.applyQuery(L.ledgerQuery(t, 300), f)).then(toRows),
      window.getDocs(L.applyQuery(L.reviewQuery(t), f)).then(toRows),
    ]);
    return { rows: out[0], review: L.reviewRows(out[1]) };
  }
  async function loadOverview() {
    try { state.overview = await callable('getStripeOverview', {}, 30000); state.overviewErr = null; }
    catch (e) { state.overview = null; state.overviewErr = e || {}; console.warn('[stripe-ledger] overview', e && (e.code || e.message)); }
  }

  async function refresh() {
    var host = state.hostId && document.getElementById(state.hostId);
    if (!host) return;
    if (!readable()) { host.innerHTML = ''; host.hidden = true; return; }
    state.loading = true;
    render();
    var ov = loadOverview();
    try {
      var d = await loadLedger();
      state.rows = d.rows; state.review = d.review; state.ledgerErr = null;
    } catch (e) {
      state.ledgerErr = e || {};
      console.warn('[stripe-ledger] ledger read', e && (e.code || e.message));
    }
    await ov;
    state.loading = false;
    render();
  }

  // ── render ───────────────────────────────────────────────────────────
  function chipHtml(c) { return '<span class="sl-chip ' + esc(c.tone) + '">' + esc(c.label) + '</span>'; }

  function overviewHtml() {
    if (state.loading && !state.overview && !state.overviewErr) return '<div class="sl-err">Loading your Stripe balance…</div>';
    if (state.overviewErr) {
      return '<div class="sl-err">⚠️ Stripe balance unavailable — ' + esc(errText(state.overviewErr)) +
        ' The ledger below still shows every recorded transaction.</div>';
    }
    var o = state.overview || {};
    var cents = function (d) { return Math.round((parseFloat(d) || 0) * 100); };
    var payouts = Array.isArray(o.payouts) ? o.payouts : [];
    var next = payouts.filter(function (p) { return p && (p.status === 'pending' || p.status === 'in_transit'); })
      .sort(function (a, b) { return String(a.arrival).localeCompare(String(b.arrival)); })[0] || null;
    var recent = payouts.filter(function (p) { return p && p.status === 'paid'; }).slice(0, 3);
    var h = '<div class="sl-grid">' +
      '<div class="sl-tile"><div class="sl-lbl">Available</div><div class="sl-val">' + esc(L.fmtMoney(cents(o.available))) + '</div><div class="sl-sub">ready to pay out</div></div>' +
      '<div class="sl-tile"><div class="sl-lbl">Pending</div><div class="sl-val">' + esc(L.fmtMoney(cents(o.pending))) + '</div><div class="sl-sub">still settling</div></div>' +
      '<div class="sl-tile"><div class="sl-lbl">Next payout</div><div class="sl-val">' + (next ? esc(L.fmtMoney(cents(next.amount))) : '—') + '</div><div class="sl-sub">' +
        (next ? 'arrives ' + esc(next.arrival) + ' · ' + esc(String(next.status).replace(/_/g, ' ')) : 'none scheduled') + '</div></div>' +
      '</div>';
    if (recent.length) {
      h += '<div class="sl-sub" style="margin:-4px 0 10px;">Recent payouts: ' + recent.map(function (p) {
        return esc(L.fmtMoney(cents(p.amount))) + ' on ' + esc(p.arrival);
      }).join(' · ') + '</div>';
    }
    var failed = payouts.filter(function (p) { return p && (p.status === 'failed' || p.status === 'canceled'); });
    if (failed.length) h += '<div class="sl-err" style="color:var(--red,#dc2626);">⚠️ ' + failed.length + ' payout' + (failed.length === 1 ? '' : 's') + ' failed — check the bank account in Stripe.</div>';
    return h;
  }

  function monthHtml() {
    var t = L.monthTotals(state.rows, Date.now());
    var partial = state.rows.length >= 300 && state.rows.length && L.monthKey(state.rows[state.rows.length - 1].atMs) === t.month;
    return '<div class="sl-sec">Collected through Stripe — this month</div><div class="sl-grid">' +
      '<div class="sl-tile"><div class="sl-lbl">Gross</div><div class="sl-val" style="color:var(--green,#16a34a);">' + esc(L.fmtMoney(t.grossCents)) + '</div><div class="sl-sub">' + t.count + ' payment' + (t.count === 1 ? '' : 's') + '</div></div>' +
      '<div class="sl-tile"><div class="sl-lbl">Stripe fees</div><div class="sl-val" style="color:var(--orange,#BD5728);">' + esc(L.fmtMoney(t.feeCents)) + '</div><div class="sl-sub">' +
        (t.grossCents ? ((t.feeCents / t.grossCents) * 100).toFixed(1) + '% of gross' : 'no fees yet') + '</div></div>' +
      '<div class="sl-tile"><div class="sl-lbl">Net</div><div class="sl-val">' + esc(L.fmtMoney(t.netCents)) + '</div><div class="sl-sub">' +
        (t.refundCount ? esc(L.fmtMoney(-t.refundCents)) + ' refunded' : 'after fees') + '</div></div>' +
      '</div>' + (partial ? '<div class="sl-note">Showing the latest 300 transactions — older ones this month are not in this total.</div>' : '');
  }

  function reviewCardHtml(r, byId, canW) {
    var d = L.displayRow(r, byId);
    var p = r.party || {};
    var party = [];
    if (p.email) party.push('✉️ ' + esc(p.email));
    if (p.phone) party.push('📞 ' + esc(p.phone));
    if (p.address) party.push('📍 ' + esc(p.address));
    var h = '<div class="sl-card" data-sl-card="' + esc(r.id) + '">' +
      '<div class="sl-top"><div class="sl-name">' + esc(p.name || p.email || 'Unknown payer') + '</div>' +
        '<div class="sl-amt' + (d.negative ? ' neg' : '') + '">' + esc(d.amountText) + '</div></div>' +
      '<div class="sl-meta">' + esc(d.dateText) + (d.chip.label.indexOf(d.kindLabel) === 0 ? '' : ' · ' + esc(d.kindLabel)) + (d.method ? ' · ' + esc(d.method) : '') +
        (d.invoiceNumber ? ' · ' + esc(d.invoiceNumber) : '') + ' ' + chipHtml(d.chip) + '</div>' +
      (party.length ? '<div class="sl-party">' + party.join('<br>') + '</div>' : '<div class="sl-party">No contact details on the Stripe customer.</div>');
    if (d.receiptUrl || d.stripeUrl) {
      h += '<div class="sl-links" style="justify-content:flex-start;margin-top:4px;">' +
        (d.receiptUrl ? '<a href="' + esc(d.receiptUrl) + '" target="_blank" rel="noopener noreferrer">Receipt ↗</a>' : '') +
        (d.stripeUrl ? '<a href="' + esc(d.stripeUrl) + '" target="_blank" rel="noopener noreferrer">Stripe invoice ↗</a>' : '') + '</div>';
    }
    if (!L.canAssign(r)) {
      h += '<div class="sl-note">' + (r.kind === 'dispute'
        ? 'A dispute — respond to it in the Stripe dashboard. It stays here until Stripe closes it.'
        : 'Not a completed payment, so there is nothing to assign.') + '</div></div>';
      return h;
    }
    if (!canW) return h + '<div class="sl-note">The account owner or a company admin assigns this to a customer.</div></div>';
    var sugg = L.suggestionsFor(r, byId);
    h += '<div class="sl-sugg">';
    sugg.forEach(function (s) { h += assignBtnHtml(r.id, s); });
    h += '</div>' +
      '<input type="search" class="sl-search" data-sl-search="' + esc(r.id) + '" placeholder="Search customer… (name, address or phone)" autocomplete="off" aria-label="Search customers to assign this payment">' +
      '<div class="sl-sugg" data-sl-results="' + esc(r.id) + '"></div>' +
      (sugg.length ? '' : '<div class="sl-note">No suggested match — search for the customer above.</div>') +
      '</div>';
    return h;
  }
  function assignBtnHtml(ledgerId, s) {
    var key = ledgerId + '|' + s.leadId;
    var isArmed = armed[key] && (Date.now() - armed[key] < 5000);
    var busy = !!inflight[ledgerId];
    return '<button type="button" class="sl-btn' + (isArmed ? ' arm' : '') + '" data-sl-action="assign" data-ledger="' + esc(ledgerId) +
      '" data-lead="' + esc(s.leadId) + '" data-name="' + esc(s.name) + '"' + (busy ? ' disabled' : '') + '>' +
      (busy ? 'Assigning…' : isArmed ? 'Tap again to assign to ' + esc(s.name) : 'Assign to ' + esc(s.name)) +
      (s.address && !isArmed && !busy ? ' <span class="sl-meta">— ' + esc(s.address) + '</span>' : '') + '</button>';
  }

  function txRowHtml(r, byId) {
    var d = L.displayRow(r, byId);
    var name = d.leadId
      ? '<a href="/pro/customer.html?id=' + encodeURIComponent(d.leadId) + '">' + esc(d.name) + '</a>'
      : esc(d.name) + (d.unmatched ? '<span class="sl-un">unmatched</span>' : '');
    var meta = [d.dateText, d.method || d.kindLabel];
    if (d.feeCents) meta.push('fee ' + d.feeText);
    if (d.invoiceNumber) meta.push(d.invoiceNumber);
    var links = (d.receiptUrl ? '<a href="' + esc(d.receiptUrl) + '" target="_blank" rel="noopener noreferrer">Receipt ↗</a>' : '') +
      (d.stripeUrl ? '<a href="' + esc(d.stripeUrl) + '" target="_blank" rel="noopener noreferrer">Invoice ↗</a>' : '');
    return '<div class="sl-row">' +
      '<div class="sl-name">' + name + '</div>' +
      '<div class="sl-amt' + (d.negative ? ' neg' : '') + '">' + esc(d.amountText) + '</div>' +
      '<div class="sl-meta">' + meta.filter(Boolean).map(esc).join(' · ') + (d.failure ? ' · ' + esc(d.failure) : '') + '</div>' +
      '<div style="text-align:right;">' + chipHtml(d.chip) + '</div>' +
      (links ? '<div></div><div class="sl-links">' + links + '</div>' : '') +
      '</div>';
  }

  function render() {
    var host = state.hostId && document.getElementById(state.hostId);
    if (!host) return;
    if (!readable()) { host.innerHTML = ''; host.hidden = true; return; }
    ensureStyles();
    var denied = state.ledgerErr && /permission/i.test(String(state.ledgerErr.code || state.ledgerErr.message || ''));
    var ovDenied = state.overviewErr && /permission/.test(String(state.overviewErr.code || ''));
    // A tenant with no Stripe ledger at all (every CRM account but the
    // platform owner's today) and no Stripe access: no panel, no noise.
    if (!state.loading && (denied || (!state.rows.length && !state.review.length && ovDenied))) {
      host.innerHTML = ''; host.hidden = true; return;
    }
    host.hidden = false;
    var canW = writable();
    var byId = leadsById();
    var nReview = state.review.length;
    var h = '<div class="sl-wrap" id="nbd-stripe-panel-inner">' +
      '<div class="sl-head"><h3 class="sl-title">💳 Stripe' +
        (nReview ? ' <span class="sl-badge" title="Payments waiting for you to pick the customer">' + nReview + ' to review</span>' : '') + '</h3>' +
      '<div class="sl-btns"><button type="button" class="sl-btn" data-sl-action="refresh"' + (state.loading ? ' disabled' : '') + '>' + (state.loading ? 'Loading…' : '↻ Refresh') + '</button>' +
        (canW ? '<button type="button" class="sl-btn pri" data-sl-action="open-sync">Sync from Stripe</button>' : '') +
      '</div></div>';
    h += overviewHtml();
    if (state.ledgerErr) {
      h += '<div class="sl-err">⚠️ Could not load the Stripe ledger — ' + esc(state.ledgerErr.message || 'try Refresh') + '</div></div>';
      host.innerHTML = h; return;
    }
    h += monthHtml();

    if (nReview) {
      h += '<div class="sl-sec">Needs review (' + nReview + ')</div>' +
        '<div class="sl-note" style="margin:-4px 0 8px;">Money that reached Stripe but could not be matched to one customer with certainty. Nothing is booked until you pick.</div>';
      state.review.forEach(function (r) { h += reviewCardHtml(r, byId, canW); });
    }

    var list = state.rows;
    var shown = state.showAll ? list.slice(0, 100) : list.slice(0, 15);
    h += '<div class="sl-sec">Recent transactions</div>';
    if (!list.length) {
      h += '<div class="nbd-empty" style="padding:14px"><div class="ne-icon">💳</div><div class="ne-msg">' + (state.loading ? 'Loading…' : 'No Stripe transactions recorded yet') + '</div>' +
        (state.loading ? '' : '<div class="ne-sub">' + (canW ? 'Run “Sync from Stripe” to bring in the history.' : 'New payments appear here as Stripe reports them.') + '</div>') + '</div>';
    } else {
      h += '<div>' + shown.map(function (r) { return txRowHtml(r, byId); }).join('') + '</div>';
      if (list.length > shown.length) {
        h += '<button type="button" class="sl-btn sl-more" data-sl-action="more">Show ' + (state.showAll ? 'fewer' : 'more (' + Math.min(list.length, 100) + ')') + '</button>';
      } else if (state.showAll) {
        h += '<button type="button" class="sl-btn sl-more" data-sl-action="more">Show fewer</button>';
      }
    }
    h += '</div>';
    host.innerHTML = h;
  }

  // ── assign ───────────────────────────────────────────────────────────
  async function assign(btn) {
    var ledgerId = btn.getAttribute('data-ledger');
    var leadId = btn.getAttribute('data-lead');
    var name = btn.getAttribute('data-name') || 'this customer';
    if (!ledgerId || !leadId || inflight[ledgerId]) return;
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
    var key = ledgerId + '|' + leadId;
    // Two taps: booking money on the wrong customer is the one mistake this
    // screen can make, and a phone mis-tap is easy.
    if (!(armed[key] && Date.now() - armed[key] < 5000)) {
      armed = {}; armed[key] = Date.now();
      btn.classList.add('arm');
      btn.textContent = 'Tap again to assign to ' + name;
      setTimeout(function () { if (armed[key]) { delete armed[key]; if (btn.isConnected) { btn.classList.remove('arm'); btn.textContent = 'Assign to ' + name; } } }, 5000);
      return;
    }
    armed = {};
    inflight[ledgerId] = true;
    btn.disabled = true; btn.textContent = 'Assigning…';
    try {
      var r = await callable('assignStripeTransaction', { ledgerId: ledgerId, leadId: leadId }, 60000);
      var msg = r && r.credited
        ? (r.created ? 'Created a CRM invoice for ' + name + ' and recorded the payment.' : 'Payment recorded on ' + name + '’s invoice.')
        : 'Linked to ' + name + ' (it was already recorded — not counted twice).';
      toast(msg, 'success');
      delete inflight[ledgerId];
      await refresh();
    } catch (e) {
      delete inflight[ledgerId];
      console.warn('[stripe-ledger] assign', e && (e.code || e.message));
      toast('Could not assign: ' + errText(e), 'error');
      render();
    }
  }

  function onSearch(input) {
    var ledgerId = input.getAttribute('data-sl-search');
    var box = document.querySelector('[data-sl-results="' + (window.CSS && CSS.escape ? CSS.escape(ledgerId) : ledgerId) + '"]');
    if (!box) return;
    var hits = L.searchLeads(window._leads || [], input.value, 6);
    if (!input.value || input.value.trim().length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = hits.length
      ? hits.map(function (s) { return assignBtnHtml(ledgerId, s); }).join('')
      : '<div class="sl-note">No customer matches “' + esc(input.value.trim()) + '”.</div>';
  }

  // ── Sync from Stripe: preview (dry run) → Apply ──────────────────────
  function modalEl() { return document.getElementById('nbd-sl-sync'); }
  function closeSync() {
    if (sync.phase === 'previewing' || sync.phase === 'applying') return;   // a run in flight finishes first
    var m = modalEl(); if (m) m.remove();
    sync = { phase: 'idle', res: null, err: null, days: sync.days };
    document.removeEventListener('keydown', onKey, true);
  }
  function onKey(e) { if (e.key === 'Escape') closeSync(); }
  function openSync() {
    if (!writable()) return;
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
    ensureStyles();
    sync = { phase: 'choose', res: null, err: null, days: sync.days || '0' };
    var ov = modalEl();
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'nbd-sl-sync';
      ov.className = 'sl-ov';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.setAttribute('aria-label', 'Sync from Stripe');
      document.body.appendChild(ov);
      document.addEventListener('keydown', onKey, true);
    }
    renderSync();
  }
  function rangeLabel(d) {
    return d === '0' ? 'all of your Stripe history' : 'the last ' + d + ' days';
  }
  function renderSync() {
    var ov = modalEl(); if (!ov) return;
    var h = '<div class="sl-modal">';
    h += '<h3>Sync from Stripe</h3>';
    if (sync.phase === 'choose' || sync.phase === 'error') {
      h += '<p>This reads every charge, invoice, refund, dispute and payout in Stripe and shows you <strong>what it would record where</strong>. Nothing is written until you review the preview and press <strong>Apply</strong>.</p>' +
        '<p><label>Look back over <select data-sl-days aria-label="How far back to sync">' +
        [['0', 'All history'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last 12 months']].map(function (o) {
          return '<option value="' + o[0] + '"' + (sync.days === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
        }).join('') + '</select></label></p>';
      if (sync.phase === 'error') h += '<div class="sl-err" style="color:var(--red,#dc2626);">⚠️ ' + esc(sync.err) + '</div>';
      h += '<div class="sl-mfoot"><button type="button" class="sl-btn" data-sl-action="sync-close">Cancel</button>' +
        '<button type="button" class="sl-btn pri" data-sl-action="sync-preview">Preview (changes nothing)</button></div>';
    } else if (sync.phase === 'previewing') {
      h += '<div class="sl-spin">Reading ' + esc(rangeLabel(sync.days)) + ' from Stripe… this can take a minute. Nothing is being written.</div>';
    } else if (sync.phase === 'preview') {
      h += previewHtml(sync.res);
      h += '<div class="sl-mfoot"><button type="button" class="sl-btn" data-sl-action="sync-close">Cancel — change nothing</button>' +
        '<button type="button" class="sl-btn pri" data-sl-action="sync-apply">Apply — record all of this</button></div>';
    } else if (sync.phase === 'applying') {
      h += '<div class="sl-spin">Recording ' + esc(rangeLabel(sync.days)) + ' in the CRM… keep this open.</div>';
    } else if (sync.phase === 'done') {
      var m = L.previewModel(sync.res, leadsById());
      h += '<p>✅ Done. ' + (m.records + m.creates) + ' payment' + (m.records + m.creates === 1 ? '' : 's') + ' recorded on customers (' + m.creates +
        ' new CRM invoice' + (m.creates === 1 ? '' : 's') + '), ' + m.review + ' waiting in <strong>Needs review</strong>.</p>' +
        '<div class="sl-mfoot"><button type="button" class="sl-btn pri" data-sl-action="sync-close">Close</button></div>';
    }
    h += '</div>';
    ov.innerHTML = h;
  }
  function previewHtml(res) {
    var m = L.previewModel(res, leadsById());
    var h = '<p>Preview of ' + esc(rangeLabel(sync.days)) + ' — <strong>nothing has been written yet.</strong></p>' +
      '<div class="sl-grid" style="margin-top:10px;">' +
      '<div class="sl-tile"><div class="sl-lbl">Collected</div><div class="sl-val">' + esc(L.fmtMoney(m.collectedCents)) + '</div><div class="sl-sub">in this range</div></div>' +
      '<div class="sl-tile"><div class="sl-lbl">Will record</div><div class="sl-val" style="color:var(--green,#16a34a);">' + (m.records + m.creates) + '</div><div class="sl-sub">' + m.creates + ' new CRM invoice' + (m.creates === 1 ? '' : 's') + '</div></div>' +
      '<div class="sl-tile"><div class="sl-lbl">Needs review</div><div class="sl-val" style="color:var(--gold,#eab308);">' + m.review + '</div><div class="sl-sub">you pick the customer</div></div>' +
      '</div>';
    if (!m.total) return h + '<p>Stripe has nothing in this range.</p>';
    m.groups.forEach(function (g) {
      if (!g.count) return;
      h += '<div class="sl-grp"><h4><span>' + esc(g.label) + ' (' + g.count + ')</span><span>' + (g.showTotal ? esc(L.fmtMoney(g.cents)) : '') + '</span></h4>';
      g.rows.slice(0, 150).forEach(function (r) {
        var who = r.customer || r.kindLabel;
        var showWhere = r.where && r.where !== '—' && r.where.toLowerCase() !== String(who).toLowerCase();
        h += '<div class="sl-prow"><div class="sl-name" style="font-size:12px;">' + esc(who) +
          (showWhere ? ' <span class="sl-meta">→ ' + esc(r.where) + '</span>' : '') + '</div>' +
          '<div class="sl-amt' + (r.amountCents < 0 ? ' neg' : '') + '" style="font-size:12px;">' + esc(r.amountText) + '</div>' +
          '<div class="sl-meta">' + esc([r.date, r.kindLabel, r.status].filter(Boolean).join(' · ')) + '</div>' +
          '<div class="sl-meta sl-act">' + esc(r.action) + '</div></div>';
      });
      if (g.count > 150) h += '<div class="sl-note">+' + (g.count - 150) + ' more</div>';
      h += '</div>';
    });
    return h;
  }
  async function runSync(dryRun) {
    if (!writable()) return;
    if (window.NBDRole && typeof window.NBDRole.guard === 'function' && !window.NBDRole.guard()) return;
    var sel = document.querySelector('#nbd-sl-sync [data-sl-days]');
    if (sel && dryRun) sync.days = sel.value;
    sync.phase = dryRun ? 'previewing' : 'applying';
    renderSync();
    var payload = { dryRun: dryRun };
    if (sync.days !== '0') payload.sinceDays = Number(sync.days);
    try {
      var res = await callable('stripeLedgerSync', payload, 540000);
      sync.res = res;
      sync.phase = dryRun ? 'preview' : 'done';
      renderSync();
      if (!dryRun) { toast('Stripe sync applied.', 'success'); refresh(); }
    } catch (e) {
      console.warn('[stripe-ledger] sync', e && (e.code || e.message));
      sync.err = (dryRun ? 'Preview failed: ' : 'Apply failed: ') + errText(e) + (dryRun ? '' : ' Anything already recorded stays recorded, and running it again never counts a payment twice.');
      sync.phase = 'error';
      renderSync();
    }
  }

  // ── one delegated listener (CSP: no inline handlers) ─────────────────
  function onClick(e) {
    var el = e.target && e.target.closest && e.target.closest('[data-sl-action]');
    if (!el) {
      // Click on the dim backdrop closes the preview (not mid-run).
      if (e.target && e.target.id === 'nbd-sl-sync') closeSync();
      return;
    }
    var a = el.getAttribute('data-sl-action');
    if (a === 'refresh') { refresh(); }
    else if (a === 'more') { state.showAll = !state.showAll; render(); }
    else if (a === 'assign') { assign(el); }
    else if (a === 'open-sync') { openSync(); }
    else if (a === 'sync-close') { closeSync(); }
    else if (a === 'sync-preview') { runSync(true); }
    else if (a === 'sync-apply') { runSync(false); }
  }
  function onInput(e) {
    var t = e.target;
    if (t && t.getAttribute && t.hasAttribute('data-sl-search')) onSearch(t);
  }
  document.addEventListener('click', onClick);
  document.addEventListener('input', onInput);

  /** Called by money-dashboard.js after each render. */
  function mount(hostId) {
    state.hostId = hostId;
    var host = document.getElementById(hostId);
    if (!host) return;
    if (!readable()) { host.hidden = true; host.innerHTML = ''; return; }
    if (state.rows.length || state.ledgerErr || state.overview || state.overviewErr) render();   // repaint instantly, then refresh
    refresh();
  }

  window.StripeLedgerPanel = { mount: mount, refresh: refresh, _state: state };
})();
