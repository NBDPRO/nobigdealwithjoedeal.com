/**
 * lead-source-fixer.js — "Confirmed source" (2026-10-19).
 *
 * The source stamped on a lead at intake misattributes badly (a Thumbtack lead
 * that was a referral, a Yelp job tagged "Website"). Jo judges marketing by
 * collected dollars per ad dollar, so the OWNER records, customer by customer,
 * where the money really came from:
 *
 *   leads/{id}.confirmedSource      yelp | thumbtack_paid | thumbtack_direct |
 *                                   referral | repeat | door_knock | google |
 *                                   manufacturer_locator | other
 *   leads/{id}.confirmedSourceNote  optional free text (<= 300 chars)
 *   leads/{id}.confirmedSourceBy    uid of the owner who answered
 *   leads/{id}.confirmedSourceAt    server timestamp
 *
 * Written only by the owner / company_admin (firestore.rules
 * confirmedSourceWriteOk), by hand, one tap per customer. Never inferred: the
 * intake source is shown as a hint and is NEVER copied into the answer.
 *
 * Three screens in one modal (button on the CRM board toolbar):
 *   Review  one customer at a time, collected customers still missing an
 *           answer, biggest collected dollars first, nine big tap targets.
 *   Report  per confirmed source: customers paid, collected dollars, ad spend
 *           where entered, collected dollars per ad dollar.
 *   Website pages (2026-11-26) per website page: leads, inspected, sold and
 *           COLLECTED dollars, last month and the last 12 months (wpBuild,
 *           the same rules as the monthly marketing report).
 *
 * Money rules: "collected" = invoice payments minus refunds, dated by when the
 * payment arrived (NBDRevenue.paymentsOf, the one definition in
 * collected-revenue.js). All arithmetic is in integer cents. Ad spend is the
 * owner's monthly spend (NBDNumbersData.loadSpend, owner-only): Yelp spend
 * belongs to yelp, Thumbtack spend to thumbtack_paid; the other sources have no
 * ad spend, so they show "—", never 0 dollars per dollar.
 *
 * Ships DARK behind the `leadSourceFixer` feature flag (feature_flags/_default).
 * Absent / false = no button, nothing renders, nothing reads, nothing writes.
 * No boot-time reads: invoices and spend load only when the modal opens.
 *
 * Pure logic is exported for tests (module.exports under Node).
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  var FLAG = 'leadSourceFixer';
  var NOTE_MAX = 300;
  var SOURCES = [
    { key: 'yelp', label: 'Yelp' },
    { key: 'thumbtack_paid', label: 'Thumbtack (paid lead)' },
    { key: 'thumbtack_direct', label: 'Thumbtack (hired me directly)' },
    { key: 'referral', label: 'Referral' },
    { key: 'repeat', label: 'Repeat customer' },
    { key: 'door_knock', label: 'Door knock' },
    { key: 'google', label: 'Google' },
    { key: 'manufacturer_locator', label: 'Manufacturer locator' },
    { key: 'other', label: 'Other' },
  ];
  var SOURCE_KEYS = SOURCES.map(function (s) { return s.key; });
  // confirmedSource -> the key its ad spend is entered under (numbers-logic spendKey).
  var SPEND_KEY = { yelp: 'yelp', thumbtack_paid: 'thumbtack' };
  var RANGES = [
    { key: 'all', label: 'All time' },
    { key: 'l12', label: 'Last 12 months' },
    { key: 'ytd', label: 'This year' },
    { key: 'l3', label: 'Last 3 months' },
  ];

  function isValidSource(v) { return typeof v === 'string' && SOURCE_KEYS.indexOf(v) >= 0; }
  function labelOf(key) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].key === key) return SOURCES[i].label;
    return key === 'unconfirmed' ? 'Not confirmed yet' : key === 'unlinked' ? 'Not linked to a customer' : String(key || '');
  }
  function cleanNote(n) {
    var s = String(n == null ? '' : n).replace(/\s+/g, ' ').trim();
    return s.length > NOTE_MAX ? s.slice(0, NOTE_MAX) : s;
  }

  /** Owner / company_admin / platform admin; a solo operator (no role, own uid) is the owner. Viewers and reps never. */
  function canConfirm(claims, uid) {
    var c = claims || {}, role = c.role || '';
    if (role === 'admin' || role === 'company_admin') return true;
    if (role) return false;
    return !!uid && (!c.companyId || c.companyId === uid);
  }

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function nameOf(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '').trim();
    return n || String(lead.address || '').split(',')[0] || 'Customer';
  }
  function intakeSource(lead) { var s = String(lead && lead.source == null ? '' : lead.source).trim(); return s || 'Unknown'; }
  function countsAsCustomer(lead) { return !!lead && !!lead.id && lead.deleted !== true && !lead.isProspect; }

  /** { start, end } ms for a preset (local calendar months), null bounds = open. Also the 'YYYY-MM' span for spend. */
  function rangeFor(preset, now) {
    var d = new Date(now == null ? Date.now() : now), y = d.getFullYear(), m = d.getMonth();
    var firstMonth;
    if (preset === 'ytd') firstMonth = new Date(y, 0, 1);
    else if (preset === 'l12') firstMonth = new Date(y, m - 11, 1);
    else if (preset === 'l3') firstMonth = new Date(y, m - 2, 1);
    else return { key: 'all', startMs: null, endMs: null, fromMonth: null, toMonth: null };
    var end = new Date(y, m + 1, 1).getTime() - 1;
    return { key: preset, startMs: firstMonth.getTime(), endMs: end, fromMonth: monthKey(firstMonth.getTime()), toMonth: monthKey(end) };
  }
  function monthKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /**
   * Collected cents per lead id, plus money on invoices with no lead.
   * @param {Array} invoices
   * @param {Function} paymentsOf  NBDRevenue.paymentsOf (payments dated, refunds negative)
   */
  function collectedCents(invoices, paymentsOf, startMs, endMs) {
    var byLead = {}, unlinked = 0, total = 0;
    (invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true) return;
      paymentsOf(inv).forEach(function (p) {
        var ms = toMs(p.at);
        if (!ms) return;
        if (startMs != null && ms < startMs) return;
        if (endMs != null && ms > endMs) return;
        var c = Math.round((parseFloat(p.amount) || 0) * 100);
        total += c;
        if (inv.leadId) byLead[inv.leadId] = (byLead[inv.leadId] || 0) + c; else unlinked += c;
      });
    });
    return { byLead: byLead, unlinkedCents: unlinked, totalCents: total };
  }

  /**
   * The review queue: customers with collected money (all time, > 0) and no valid
   * confirmedSource. Biggest collected dollars first (they move the answer most).
   */
  function reviewQueue(leads, allTimeByLead, skipped) {
    var skip = skipped instanceof Set ? skipped : new Set(skipped || []);
    var out = [];
    (leads || []).forEach(function (l) {
      if (!countsAsCustomer(l) || isValidSource(l.confirmedSource) || skip.has(l.id)) return;
      var c = (allTimeByLead || {})[l.id] || 0;
      if (c <= 0) return;
      out.push({ id: l.id, lead: l, name: nameOf(l), intake: intakeSource(l), collectedCents: c });
    });
    out.sort(function (a, b) { return b.collectedCents - a.collectedCents || (a.id < b.id ? -1 : 1); });
    return out;
  }

  /** How many collected customers are confirmed vs total (for the progress line). */
  function coverage(leads, allTimeByLead) {
    var total = 0, done = 0;
    (leads || []).forEach(function (l) {
      if (!countsAsCustomer(l) || ((allTimeByLead || {})[l.id] || 0) <= 0) return;
      total++; if (isValidSource(l.confirmedSource)) done++;
    });
    return { total: total, done: done };
  }

  /** Ad spend cents for one spend key over the range's months; null when nothing was entered. */
  function spendCentsFor(spendMonths, spendKey, fromMonth, toMonth) {
    if (!spendMonths || !spendKey) return null;
    var sum = 0, any = false;
    Object.keys(spendMonths).forEach(function (mo) {
      if (fromMonth && mo < fromMonth) return;
      if (toMonth && mo > toMonth) return;
      var v = Number((spendMonths[mo] || {})[spendKey]);
      if (v > 0) { sum += Math.round(v); any = true; }
    });
    return any ? sum : null;
  }

  /**
   * The report. One row per confirmed source (fixed order), then "not confirmed
   * yet", then money on invoices with no customer, so the rows add up to the
   * collected total.
   * @param {Array} leads
   * @param {{byLead:Object, unlinkedCents:number}} coll  collectedCents() for the range
   * @param {Object|null} spendMonths  { 'YYYY-MM': { spendKey: cents } } or null (no access / none)
   * @param {{fromMonth:?string,toMonth:?string}} range
   */
  function buildReport(leads, coll, spendMonths, range) {
    range = range || {};
    var rows = {};
    SOURCE_KEYS.concat(['unconfirmed']).forEach(function (k) { rows[k] = { key: k, label: labelOf(k), customers: 0, collectedCents: 0 }; });
    var seen = {};
    (leads || []).forEach(function (l) {
      if (!l || !l.id) return;
      var c = (coll.byLead || {})[l.id];
      if (!c) return;
      seen[l.id] = true;
      var k = isValidSource(l.confirmedSource) ? l.confirmedSource : 'unconfirmed';
      rows[k].collectedCents += c;
      if (c > 0) rows[k].customers++;
    });
    // Payments on a lead id we do not hold (deleted / other tenant's id) stay visible, not dropped.
    var orphan = 0;
    Object.keys(coll.byLead || {}).forEach(function (id) { if (!seen[id]) orphan += coll.byLead[id]; });
    var list = SOURCE_KEYS.concat(['unconfirmed']).map(function (k) { return rows[k]; });
    var unlinked = (coll.unlinkedCents || 0) + orphan;
    if (unlinked) list.push({ key: 'unlinked', label: labelOf('unlinked'), customers: 0, collectedCents: unlinked });
    var total = list.reduce(function (s, r) { return s + r.collectedCents; }, 0);
    list.forEach(function (r) {
      r.sharePct = total > 0 ? Math.round(r.collectedCents / total * 100) : null;
      var sk = SPEND_KEY[r.key];
      r.spendCents = sk ? spendCentsFor(spendMonths, sk, range.fromMonth, range.toMonth) : null;
      r.perAdDollar = r.spendCents > 0 ? Math.round(r.collectedCents / r.spendCents * 100) / 100 : null;
    });
    return { rows: list, totalCents: total, customers: list.reduce(function (s, r) { return s + r.customers; }, 0) };
  }

  /** Firestore patch for an answer. `ts` is serverTimestamp() in the browser. null source clears it. */
  function answerPatch(sourceKey, note, uid, ts) {
    if (sourceKey !== null && !isValidSource(sourceKey)) return null;
    if (!uid) return null;
    var n = cleanNote(note);
    return { confirmedSource: sourceKey, confirmedSourceNote: sourceKey && n ? n : null, confirmedSourceBy: uid, confirmedSourceAt: ts };
  }

  function fmtMoney(cents) {
    var neg = cents < 0, c = Math.abs(Math.round(cents || 0));
    var d = Math.floor(c / 100), r = String(c % 100).padStart(2, '0');
    return (neg ? '-$' : '$') + String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + r;
  }

  // ── Website pages (2026-11-26) ───────────────────────────────────────
  // Per website page: leads -> inspected -> sold -> COLLECTED dollars, last
  // calendar month and the trailing 12 months. The same rules as the monthly
  // marketing report (functions/website-page-revenue.js, PR #3275; kept in
  // step by tests/lead-source-fixer-2026-10-19.test.js): the page a web lead
  // was sent from (lead.sourcePage), redirected URLs folded into their new
  // home; Inspected = an inspected-or-later stage now or in stageHistory, or
  // an inspection date already passed; Sold = numbers-logic isSale; Collected
  // = payments minus refunds dated by arrival (NBDRevenue.paymentsOf) from any
  // customer who came off that page, whenever they came in. Integer cents.
  var WP_ALIAS = {
    '/storm-check': '/roof-check', '/roof-score': '/roof-check', '/storm-report': '/roof-check',
    '/book': '/inspect', '/index': '/', 'homepage': '/',
    'estimate-funnel-v2': '/estimate', 'storm-alerts-page': '/storm-alerts',
  };
  var WP_COLLECTION = {
    estimate_leads: 'Instant Estimate', inspect_leads: 'Inspection / Storm tool', contact_leads: 'Contact form',
    free_roof_entries: 'Free Roof entry', storm_alert_subscribers: 'Storm signup',
  };
  // Built-in stage keys (functions/stage-roles.js BUILTIN_KEYS) and legacy names.
  var WP_STAGES = ('new contacted inspected claim_filed adjuster_meeting_scheduled adjuster_inspection_done scope_received ' +
    'estimate_submitted supplement_requested supplement_approved estimate_sent_cash negotiating prequal_sent loan_approved ' +
    'contract_signed job_created permit_pulled materials_ordered materials_delivered crew_scheduled install_in_progress ' +
    'install_complete final_photos deductible_collected final_payment collections closed warranty_claim warranty_scheduled ' +
    'warranty_repaired service_quoted service_approved lost').split(' ');
  var WP_LEGACY = {
    'new lead': 'new', 'estimate sent': 'estimate_submitted', 'approved': 'contract_signed', 'in progress': 'install_in_progress',
    'complete': 'closed', 'closed won': 'closed', 'closed lost': 'lost', 'won': 'closed', 'closed_won': 'closed', 'closed-won': 'closed',
  };

  function wpPageKey(lead) {
    var s = String((lead && lead.sourcePage) || '').trim();
    if (/^calcom:/i.test(s)) return 'Cal.com booking';
    s = s.replace(/^page-form:/i, '');
    if (!s) {
      var col = WP_COLLECTION[lead && lead.publicLeadCollection];
      return '(page not recorded)' + (col ? ' · ' + col : '');
    }
    s = s.replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0].toLowerCase();
    if (s.charAt(0) === '/') {
      s = s.replace(/\/index\.html$/, '/').replace(/\.html$/, '');
      if (s.length > 1) s = s.replace(/\/+$/, '');
      if (!s) s = '/';
    }
    return WP_ALIAS[s] || s;
  }
  /** Built-in stage key, or null for a tenant custom stage ('' = 'new'). */
  function wpStageKey(stage) {
    var s = String(stage == null ? '' : stage).trim();
    if (!s) return 'new';
    if (WP_STAGES.indexOf(s) >= 0) return s;
    var lower = s.toLowerCase();
    if (WP_LEGACY[lower]) return WP_LEGACY[lower];
    var snake = lower.replace(/[\s-]+/g, '_');
    return WP_STAGES.indexOf(snake) >= 0 ? snake : null;
  }
  function wpInspectedStage(stage) {
    var k = wpStageKey(stage);
    return !!k && k !== 'new' && k !== 'contacted' && k !== 'lost';
  }
  function wpReachedInspection(lead, nowMs, isSale) {
    if (!lead) return false;
    if (isSale(lead) || wpInspectedStage(lead.stage)) return true;
    var hist = Array.isArray(lead.stageHistory) ? lead.stageHistory : [];
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i];
      if (h && (wpInspectedStage(h.to) || (h.from && wpInspectedStage(h.from)))) return true;
    }
    var insp = toMs(lead.inspectionDate);
    return insp > 0 && insp <= nowMs;
  }
  function wpAddMonths(ym, n) {
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + n;
    var yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
    return yy + '-' + String(mm + 1).padStart(2, '0');
  }
  /** Last calendar month and the 12 months ending with it; from inclusive, to exclusive, YYYY-MM-DD. */
  function wpWindows(todayYmd) {
    var thisMonth = String(todayYmd).slice(0, 7), last = wpAddMonths(thisMonth, -1), to = thisMonth + '-01';
    return {
      month: { from: last + '-01', to: to, label: last },
      year: { from: wpAddMonths(last, -11) + '-01', to: to, label: wpAddMonths(last, -11) + ' to ' + last },
    };
  }
  function wpDay(ms, tz) {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
    } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
  }
  function wpEmpty(page) {
    return { page: page, month: { leads: 0, inspected: 0, sold: 0, collectedCents: 0 }, year: { leads: 0, inspected: 0, sold: 0, collectedCents: 0 } };
  }
  /**
   * @param {{leads:Array, invoices:Array, paymentsOf:Function, isSale:Function, nowMs:number, tz:string}} o
   * @returns {{windows, rows, total}} rows biggest 12-month collected first
   */
  function wpBuild(o) {
    var tz = o.tz || 'America/New_York', now = o.nowMs || Date.now();
    var win = wpWindows(wpDay(now, tz)), rows = {}, pageOf = {}, KEYS = ['month', 'year'];
    function row(p) { return rows[p] || (rows[p] = wpEmpty(p)); }
    function inWin(day, k) { return day >= win[k].from && day < win[k].to; }
    (o.leads || []).forEach(function (l) {
      if (!l || l.webLead !== true || l.deleted === true || l.e2eTestData || l.isProspect) return;
      var p = wpPageKey(l);
      if (l.id) pageOf[l.id] = p;
      var t = toMs(l.createdAt);
      if (!t) return;
      var day = wpDay(t, tz), insp = wpReachedInspection(l, now, o.isSale), sold = !!o.isSale(l);
      KEYS.forEach(function (k) {
        if (!inWin(day, k)) return;
        var r = row(p)[k];
        r.leads++; if (insp) r.inspected++; if (sold) r.sold++;
      });
    });
    (o.invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true || inv.e2eTestData) return;
      var p = inv.leadId ? pageOf[inv.leadId] : null;
      if (!p) return;                                     // not a website customer
      o.paymentsOf(inv).forEach(function (pay) {
        var t = toMs(pay.at);
        if (!t) return;
        var day = wpDay(t, tz), c = Math.round((parseFloat(pay.amount) || 0) * 100);
        KEYS.forEach(function (k) { if (inWin(day, k)) row(p)[k].collectedCents += c; });
      });
    });
    var list = Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) {
      return b.year.collectedCents - a.year.collectedCents || b.year.sold - a.year.sold || b.year.leads - a.year.leads || (a.page < b.page ? -1 : 1);
    });
    var total = wpEmpty('All website pages');
    list.forEach(function (r) { KEYS.forEach(function (k) { ['leads', 'inspected', 'sold', 'collectedCents'].forEach(function (f) { total[k][f] += r[k][f]; }); }); });
    return { windows: win, rows: list, total: total };
  }

  var pure = {
    isValidSource: isValidSource, labelOf: labelOf, cleanNote: cleanNote, canConfirm: canConfirm, rangeFor: rangeFor,
    collectedCents: collectedCents, reviewQueue: reviewQueue, coverage: coverage, spendCentsFor: spendCentsFor,
    buildReport: buildReport, answerPatch: answerPatch, fmtMoney: fmtMoney,
    wpPageKey: wpPageKey, wpStageKey: wpStageKey, wpReachedInspection: wpReachedInspection, wpWindows: wpWindows, wpBuild: wpBuild, WP_ALIAS: WP_ALIAS,
    SOURCES: SOURCES, SOURCE_KEYS: SOURCE_KEYS, SPEND_KEY: SPEND_KEY, RANGES: RANGES, NOTE_MAX: NOTE_MAX, FLAG: FLAG,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (!root || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  if (w.NBDLeadSourceFixer) return;

  var overlay = null;
  var st = { tab: 'review', range: 'all', loading: false, error: '', invoices: null, spend: null, skipped: new Set(), last: null, saving: false, note: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || (w.auth && w.auth.currentUser && w.auth.currentUser.uid) || null; }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function available() { return flagOn() && canConfirm(claims(), uid()); }
  function leads() { return w._leads || []; }
  function leadById(id) { return leads().filter(function (l) { return l && l.id === id; })[0] || null; }

  function allTime() { return collectedCents(st.invoices || [], w.NBDRevenue.paymentsOf, null, null); }
  function queue() { return reviewQueue(leads(), allTime().byLead, st.skipped); }

  function syncButton() {
    var b = doc.getElementById('leadSourceFixerBtn');
    if (b) b.hidden = !available();
  }

  async function loadData() {
    st.loading = true; st.error = ''; paint();
    try {
      if (!w.NBDRevenue || typeof w.NBDRevenue.loadInvoices !== 'function') throw new Error('Money data is not loaded on this page');
      st.invoices = await w.NBDRevenue.loadInvoices({ force: true });
      if (w.NBDRevenue.status && w.NBDRevenue.status() === 'failed') throw new Error('Payments could not be read');
      st.spend = null;
      if (w.NBDNumbersData && typeof w.NBDNumbersData.loadSpend === 'function') {
        var sp = await w.NBDNumbersData.loadSpend();
        st.spend = sp && sp.months ? sp.months : null;
      }
    } catch (e) {
      st.invoices = null; st.error = (e && e.message) || 'Could not load payments';
    }
    st.loading = false; paint();
  }

  // ── views ────────────────────────────────────────────────────────────
  function reviewHtml() {
    var q = queue(), cov = coverage(leads(), allTime().byLead);
    var h = '<p class="lsf-prog" role="status">' + cov.done + ' of ' + cov.total + ' paying customers confirmed' + (st.skipped.size ? ' · ' + st.skipped.size + ' skipped for now' : '') + '</p>';
    if (st.last) h += '<div class="lsf-undo"><span>Saved ' + esc(st.last.name) + ' as ' + esc(labelOf(st.last.key)) + '.</span><button type="button" class="lsf-btn" data-lsf-act="undo"' + (st.saving ? ' disabled' : '') + '>Undo</button></div>';
    if (!q.length) return h + '<p class="lsf-empty">' + (cov.total ? 'Every paying customer has a confirmed source. Open the Report.' : 'No customers with collected money yet.') + '</p>';
    var c = q[0], dis = st.saving ? ' disabled' : '';
    h += '<div class="lsf-card"><div class="lsf-name">' + esc(c.name) + '</div>' +
      '<div class="lsf-money">' + esc(fmtMoney(c.collectedCents)) + ' collected</div>' +
      '<div class="lsf-hint">Intake said: ' + esc(c.intake) + ' (a hint only, often wrong)</div>' +
      '<div class="lsf-q">Where did this customer really come from?</div>' +
      '<div class="lsf-opts">' + SOURCES.map(function (s) {
        return '<button type="button" class="lsf-opt" data-lsf-pick="' + esc(s.key) + '"' + dis + '>' + esc(s.label) + '</button>';
      }).join('') + '</div>' +
      '<label class="lsf-f">Note (optional, saved with your tap)<input type="text" class="lsf-note" maxlength="' + NOTE_MAX + '" value="' + esc(st.note) + '" data-lsf-note="1"' + dis + '></label>' +
      '<div class="lsf-foot"><button type="button" class="lsf-btn" data-lsf-act="skip"' + dis + '>Skip for now</button></div></div>';
    return h;
  }

  function reportHtml() {
    var rg = rangeFor(st.range, Date.now());
    var rep = buildReport(leads(), collectedCents(st.invoices || [], w.NBDRevenue.paymentsOf, rg.startMs, rg.endMs), st.spend, rg);
    var h = '<div class="lsf-filters"><label class="lsf-f">Period<select class="lsf-sel" data-lsf-f="range">' +
      RANGES.map(function (r) { return '<option value="' + r.key + '"' + (r.key === st.range ? ' selected' : '') + '>' + esc(r.label) + '</option>'; }).join('') + '</select></label></div>' +
      '<p class="lsf-prog">Collected ' + esc(fmtMoney(rep.totalCents)) + ' from ' + rep.customers + ' paying customer' + (rep.customers === 1 ? '' : 's') + '. Money in, refunds out, by the day the payment arrived.</p>';
    h += '<table class="lsf-table"><thead><tr><th>Source</th><th>Customers</th><th>Collected</th><th>Share</th><th>Ad spend</th><th>Per ad $</th></tr></thead><tbody>' +
      rep.rows.map(function (r) {
        if (!r.customers && !r.collectedCents && r.key !== 'unconfirmed') return '';
        return '<tr class="lsf-row"><td class="lsf-c-name" data-label="Source">' + esc(r.label) + '</td>' +
          '<td data-label="Customers">' + r.customers + '</td>' +
          '<td data-label="Collected">' + esc(fmtMoney(r.collectedCents)) + '</td>' +
          '<td data-label="Share">' + (r.sharePct == null ? '—' : r.sharePct + '%') + '</td>' +
          '<td data-label="Ad spend">' + (r.spendCents == null ? '—' : esc(fmtMoney(r.spendCents))) + '</td>' +
          '<td data-label="Per ad $">' + (r.perAdDollar == null ? '—' : esc(fmtMoney(Math.round(r.perAdDollar * 100)))) + '</td></tr>';
      }).join('') + '</tbody></table>' +
      '<p class="lsf-foot-note">Per ad $ = collected dollars for each dollar of ad spend. Ad spend is the monthly amount entered for Yelp and Thumbtack (paid leads); "—" means none entered or not for this source. ' + (st.spend ? '' : 'Ad spend is visible to the account owner only. ') + 'Customers not yet confirmed sit in their own row, so nothing is guessed.</p>';
    return h;
  }

  function companyTz() {
    var z = w.NBDCompanyTimeZone && typeof w.NBDCompanyTimeZone.current === 'function' ? w.NBDCompanyTimeZone.current(w._companyProfile) : '';
    if (z) return z;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; } catch (e) { return 'America/New_York'; }
  }
  function pagesHtml() {
    var N = w.NBDNumbers;
    if (!N || typeof N.isSale !== 'function') return '<p class="lsf-empty" role="alert">Sales data is not loaded on this page. Reload and try again.</p>';
    var rep = wpBuild({ leads: leads(), invoices: st.invoices || [], paymentsOf: w.NBDRevenue.paymentsOf, isSale: function (l) { return N.isSale(l); }, nowMs: Date.now(), tz: companyTz() });
    var cells = function (r, k) {
      return '<td data-label="Leads">' + r[k].leads + '</td><td data-label="Inspected">' + r[k].inspected + '</td>' +
        '<td data-label="Sold">' + r[k].sold + '</td><td data-label="Collected">' + esc(fmtMoney(r[k].collectedCents)) + '</td>';
    };
    var table = function (k, title) {
      var list = rep.rows.filter(function (r) { return r[k].leads || r[k].collectedCents; });
      var h = '<h3 class="lsf-q">' + esc(title) + '</h3>';
      if (!list.length) return h + '<p class="lsf-empty">No website leads or website money in this period.</p>';
      return h + '<table class="lsf-table"><thead><tr><th>Page</th><th>Leads</th><th>Inspected</th><th>Sold</th><th>Collected</th></tr></thead><tbody>' +
        list.map(function (r) { return '<tr class="lsf-row"><td class="lsf-c-name" data-label="Page">' + esc(r.page) + '</td>' + cells(r, k) + '</tr>'; }).join('') +
        '<tr class="lsf-row"><td class="lsf-c-name" data-label="Page"><strong>' + esc(rep.total.page) + '</strong></td>' + cells(rep.total, k) + '</tr></tbody></table>';
    };
    return table('month', 'Last month (' + rep.windows.month.label + ')') + table('year', 'Last 12 months (' + rep.windows.year.label + ')') +
      '<p class="lsf-foot-note">Leads, inspected and sold count website leads that came in during the period, by the page they were sent from (old addresses that now redirect count as their new page). Collected is money actually received in the period, payments minus refunds, from any customer who came off that page, whenever they first came in. Estimates, contracts and pipeline are never counted as collected.</p>';
  }

  function bodyHtml() {
    var h = '<div class="lsf-head"><h2 class="lsf-title" id="lsfTitle">Where customers came from</h2>' +
      '<button type="button" class="lsf-x" data-lsf-act="close" aria-label="Close">×</button></div>' +
      '<div class="lsf-tabs" role="tablist">' +
      '<button type="button" role="tab" class="lsf-tab' + (st.tab === 'review' ? ' on' : '') + '" aria-selected="' + (st.tab === 'review') + '" data-lsf-tab="review">Review</button>' +
      '<button type="button" role="tab" class="lsf-tab' + (st.tab === 'report' ? ' on' : '') + '" aria-selected="' + (st.tab === 'report') + '" data-lsf-tab="report">Report</button>' +
      '<button type="button" role="tab" class="lsf-tab' + (st.tab === 'pages' ? ' on' : '') + '" aria-selected="' + (st.tab === 'pages') + '" data-lsf-tab="pages">Website pages</button></div>';
    if (st.loading) return h + '<p class="lsf-empty" role="status">Loading payments…</p>';
    if (st.error) return h + '<p class="lsf-empty" role="alert">' + esc(st.error) + '</p><div class="lsf-foot"><button type="button" class="lsf-btn" data-lsf-act="retry">Try again</button></div>';
    return h + (st.tab === 'report' ? reportHtml() : st.tab === 'pages' ? pagesHtml() : reviewHtml());
  }

  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;
    overlay.innerHTML = '<div class="lsf-box" role="dialog" aria-modal="true" aria-labelledby="lsfTitle">' + bodyHtml() + '</div>';
    overlay.scrollTop = keep;
  }

  function open() {
    if (!available()) return false;
    if (overlay) { paint(); return true; }
    st.tab = 'review'; st.error = ''; st.last = null; st.saving = false; st.note = ''; st.skipped = new Set();
    overlay = doc.createElement('div');
    overlay.className = 'lsf-overlay';
    overlay.setAttribute('data-lsf-overlay', '1');
    doc.body.appendChild(overlay);
    loadData();
    return true;
  }
  function close() {
    if (st.saving) return;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    else if (overlay && typeof overlay.remove === 'function') overlay.remove();
    overlay = null;
  }

  // ── the write ────────────────────────────────────────────────────────
  async function write(id, key, note) {
    if (!available()) return false;
    var db = w.db || w._db;
    if (!db || typeof w.updateDoc !== 'function' || typeof w.doc !== 'function') { toast('Could not save: the CRM is not ready, reload and try again', 'error'); return false; }
    var patch = answerPatch(key, note, uid(), typeof w.serverTimestamp === 'function' ? w.serverTimestamp() : new Date());
    if (!patch) return false;
    try { await w.updateDoc(w.doc(db, 'leads', id), patch); } catch (e) {
      toast('Could not save: ' + ((e && e.code) || (e && e.message) || 'unknown error'), 'error');
      return false;
    }
    var l = leadById(id);                                  // keep the in-memory board and the report in step
    if (l) { l.confirmedSource = patch.confirmedSource; l.confirmedSourceNote = patch.confirmedSourceNote; l.confirmedSourceBy = patch.confirmedSourceBy; }
    return true;
  }

  async function pick(key) {
    if (st.saving || !isValidSource(key)) return;
    var q = queue(); if (!q.length) return;
    var c = q[0];
    st.saving = true; paint();
    var ok = await write(c.id, key, st.note);
    st.saving = false;
    if (ok) { st.last = { id: c.id, name: c.name, key: key }; st.note = ''; }
    paint();
  }
  async function undo() {
    if (st.saving || !st.last) return;
    var last = st.last;
    st.saving = true; paint();
    var ok = await write(last.id, null, '');
    st.saving = false;
    if (ok) st.last = null;
    paint();
  }

  // ── events ───────────────────────────────────────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-lsf-act],[data-lsf-pick],[data-lsf-tab],#leadSourceFixerBtn');
    if (!t) return;
    if (t.id === 'leadSourceFixerBtn') { ev.preventDefault(); open(); return; }
    if (!overlay || !available()) return;
    var act = t.getAttribute('data-lsf-act'), p = t.getAttribute('data-lsf-pick'), tab = t.getAttribute('data-lsf-tab');
    if (p) { pick(p).catch(function (e) { st.saving = false; toast('Could not save: ' + (e && e.message || 'unknown error'), 'error'); paint(); }); return; }
    if (tab) { st.tab = tab === 'report' || tab === 'pages' ? tab : 'review'; paint(); return; }
    if (act === 'close') close();
    else if (act === 'retry') loadData();
    else if (act === 'skip') { var q = queue(); if (q.length) { st.skipped.add(q[0].id); st.note = ''; paint(); } }
    else if (act === 'undo') undo().catch(function (e) { st.saving = false; toast('Undo failed: ' + (e && e.message || 'unknown error'), 'error'); paint(); });
  });
  doc.addEventListener('input', function (ev) {
    var el = ev.target;
    if (overlay && el && el.getAttribute && el.getAttribute('data-lsf-note')) st.note = String(el.value || '').slice(0, NOTE_MAX);
  });
  doc.addEventListener('change', function (ev) {
    var el = ev.target, f = el && el.getAttribute && el.getAttribute('data-lsf-f');
    if (overlay && f === 'range') { st.range = RANGES.some(function (r) { return r.key === el.value; }) ? el.value : 'all'; paint(); }
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  function init() {
    syncButton();
    if (w.NBDFlags && typeof w.NBDFlags.load === 'function') {
      Promise.resolve(w.NBDFlags.load()).then(syncButton, function () {});
    }
  }
  w.addEventListener('nbd:data-refreshed', syncButton);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1500); });
  else setTimeout(init, 1500);
  setInterval(syncButton, 60000);

  w.NBDLeadSourceFixer = { open: open, close: close, sync: syncButton, available: available, _pure: pure };
})(typeof window !== 'undefined' ? window : this);
