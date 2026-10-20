/**
 * reputation.js — "Reputation" screen (2026-10-19, plan 4, flag reputationLoop).
 *
 * After a job is finished and paid the CRM already asks the customer once for a
 * Google review (functions/review-ask-auto.js, the rep nudge, the one-tap
 * review deck). This screen answers the owner's question: who was asked, who
 * answered, and is anything public that needs a reply.
 *
 *   Ask status  is READ from the stamps that already exist on the lead
 *               (reviewRequested / reviewRequestedAt / reviewRequestSource /
 *               reviewAutoAsk). Nothing duplicated, nothing written.
 *   review_log  one small doc per lead, review_log/{leadId}, written only by the
 *               owner's tap ("Got a review", "I replied"):
 *                 { companyId, leadId, reviewSeen, platform, rating, responded,
 *                   updatedAt, updatedBy }
 *               firestore.rules (match /review_log) keeps it owner-only and
 *               well-formed. It is a separate collection, not a field on the lead,
 *               because the lead update rule has no spare evaluation budget (an
 *               extra clause there pushed denied writes past Firestore's
 *               1000-expression limit, 2026-10-19).
 *
 * RULES THIS SCREEN LIVES BY (shown in the UI copy; FTC 16 CFR 465 and Google's
 * review policy):
 *   - Ask every paid customer the same way. Never ask only the happy ones,
 *     never route unhappy ones away from the public review.
 *   - Never offer or imply anything in return for a review.
 *   - A low rating alerts the OWNER only, inside the CRM. Nothing here sends
 *     anything to a customer or posts anything public. No automated send.
 *
 * Reply templates are drafts for Joe to paste into Google / Yelp / Thumbtack
 * himself: no claim, coverage or insurance wording, no promises, no job details.
 *
 * Ships DARK behind the `reputationLoop` feature flag (feature_flags/_default).
 * Absent / false = no button, nothing renders, nothing reads, nothing writes.
 * No boot-time reads: invoices and the Google summary load when the screen opens.
 *
 * Pure logic is exported for tests (module.exports under Node).
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  var FLAG = 'reputationLoop';
  var LOW_MAX = 3;                       // 1-3 stars need a reply from the owner
  var PLATFORMS = [
    { key: 'google', label: 'Google' },
    { key: 'yelp', label: 'Yelp' },
    { key: 'thumbtack', label: 'Thumbtack' },
    { key: 'other', label: 'Other' },
  ];
  var PLATFORM_KEYS = PLATFORMS.map(function (p) { return p.key; });
  var DAY_MS = 24 * 60 * 60 * 1000;

  // Three drafts in Joe's voice. {first} is the reviewer's first name as it
  // appears on the review. Any edit must keep the claim-wording check green
  // (tests/reputation-2026-10-19.test.js).
  var TEMPLATES = [
    { key: 'five', label: '5 stars', text: 'Thank you, {first}. It was a pleasure working on your home. If anything ever comes up with the roof, call me. - Joe' },
    { key: 'mid', label: '3-4 stars', text: "Thanks for the honest review, {first}. I'd like to hear what we could have done better. Call or text me at the number on our profile and I'll make time. - Joe" },
    { key: 'low', label: '1-2 stars', text: "I'm sorry this wasn't what you expected, {first}. I want to understand what happened. Please call me directly so we can talk it through. - Joe" },
  ];
  var RULES_COPY = [
    'Ask every paid customer the same way. Never skip the unhappy ones.',
    'Never offer anything for a review, and never ask someone to change or remove one.',
    'A low rating alerts you here only. Nothing is sent to the customer from this screen.',
  ];

  function isPlatform(v) { return typeof v === 'string' && PLATFORM_KEYS.indexOf(v) >= 0; }
  function platformLabel(k) {
    for (var i = 0; i < PLATFORMS.length; i++) if (PLATFORMS[i].key === k) return PLATFORMS[i].label;
    return String(k || '');
  }
  function isRating(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 1 && v <= 5; }

  /** Owner / company_admin / platform admin; a solo operator (no role, own uid) is the owner. Viewers and reps never. */
  function canSee(claims, uid) {
    var c = claims || {}, role = c.role || '';
    if (role === 'admin' || role === 'company_admin') return true;
    if (role) return false;
    return !!uid && (!c.companyId || c.companyId === uid);
  }

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return isFinite(t) ? t : 0;
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
  function firstNameOf(lead) {
    var f = String((lead && (lead.firstName || lead.name)) || '').trim().split(/\s+/)[0];
    return f.slice(0, 40);
  }
  function countsAsCustomer(lead) { return !!lead && !!lead.id && lead.deleted !== true && !lead.isProspect; }

  /**
   * Leads that are finished AND paid: at least one live invoice, money actually
   * collected (payments minus refunds, > 0), and no live invoice still owed.
   * A lead with no payment is never listed, so it can never read "asked".
   * @param {Array} invoices
   * @param {Function} paymentsOf  NBDRevenue.paymentsOf
   * @param {Function} isOwed      NBDRevenue.isOwedInvoice
   * @returns {Object} leadId -> { collectedCents, lastPaidMs }
   */
  function paidLeads(invoices, paymentsOf, isOwed) {
    var by = {};
    (invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true || !inv.leadId) return;
      var st = String(inv.status || '').toLowerCase();
      if (st === 'void' || st === 'voided' || st === 'cancelled' || st === 'canceled' || st === 'draft') return;
      var e = by[inv.leadId] || (by[inv.leadId] = { cents: 0, last: 0, owed: false });
      if (isOwed(inv)) e.owed = true;
      paymentsOf(inv).forEach(function (p) {
        e.cents += Math.round((parseFloat(p.amount) || 0) * 100);
        var ms = toMs(p.at); if (!p.refund && ms > e.last) e.last = ms;
      });
    });
    var out = {};
    Object.keys(by).forEach(function (id) {
      if (by[id].cents > 0 && !by[id].owed) out[id] = { collectedCents: by[id].cents, lastPaidMs: by[id].last };
    });
    return out;
  }

  /**
   * Was this customer asked? Read from the existing stamps only.
   *   asked    reviewRequested true, or reviewAutoAsk.status 'sent'
   *   sending  an automatic ask is in flight
   *   failed   an automatic ask was tried and did not send (reviewAutoAsk.status other)
   *   skipped  a rep pressed "Don't ask this one" (reviewAskDeclined) and nothing went out
   *   not_yet  nothing recorded
   */
  function askInfo(lead) {
    var l = lead || {}, a = (l.reviewAutoAsk && typeof l.reviewAutoAsk === 'object') ? l.reviewAutoAsk : null;
    var src = String(l.reviewRequestSource || '');
    var channel = (a && a.channel) || (/text|sms/i.test(src) ? 'text' : src ? (/email/i.test(src) ? 'email' : 'manual') : '');
    var at = toMs(l.reviewRequestedAt) || (a && Number(a.sentAtMs)) || 0;
    if (l.reviewRequested === true || (a && a.status === 'sent')) return { status: 'asked', askedAtMs: at, channel: channel, source: src };
    if (a && a.status === 'sending') return { status: 'sending', askedAtMs: 0, channel: channel, source: src };
    if (a && a.status) return { status: 'failed', askedAtMs: 0, channel: channel, source: src, reason: String(a.status) };
    if (l.reviewAskDeclined === true) return { status: 'skipped', askedAtMs: 0, channel: '', source: '' };
    return { status: 'not_yet', askedAtMs: 0, channel: '', source: '' };
  }

  /** The owner's own log for this lead (never inferred). */
  function seenInfo(entry) {
    var r = (entry && typeof entry === 'object') ? entry : {};
    var seen = r.reviewSeen === true;
    return {
      seen: seen,
      platform: seen && isPlatform(r.platform) ? r.platform : '',
      rating: seen && isRating(r.rating) ? r.rating : 0,
      responded: seen && r.responded === true,
      updatedMs: toMs(r.updatedAt),
    };
  }

  /** One row per finished+paid customer, newest payment first. */
  function buildRows(leads, paid, log) {
    var rows = [];
    (leads || []).forEach(function (l) {
      if (!countsAsCustomer(l) || !paid || !paid[l.id]) return;
      var a = askInfo(l), s = seenInfo(log && log[l.id]);
      var priv = Number(l.customerRating);
      rows.push({
        id: l.id, name: nameOf(l), first: firstNameOf(l), ask: a, seen: s,
        privateRating: isRating(priv) ? priv : 0,
        lastPaidMs: paid[l.id].lastPaidMs || 0, collectedCents: paid[l.id].collectedCents,
      });
    });
    rows.sort(function (a, b) { return b.lastPaidMs - a.lastPaidMs || (a.id < b.id ? -1 : 1); });
    return rows;
  }

  /** Header counts. "This month" = calendar month of `nowMs` (local). */
  function counts(rows, nowMs) {
    var d = new Date(nowMs == null ? Date.now() : nowMs);
    var m0 = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    var c = { paid: 0, asked: 0, askedThisMonth: 0, notYet: 0, skipped: 0, seen: 0, responded: 0, rated: 0, avg: null };
    var sum = 0;
    (rows || []).forEach(function (r) {
      c.paid++;
      if (r.ask.status === 'asked') { c.asked++; if (r.ask.askedAtMs >= m0) c.askedThisMonth++; }
      else if (r.ask.status === 'skipped') c.skipped++;
      else if (r.ask.status === 'not_yet') c.notYet++;
      if (r.seen.seen) {
        c.seen++;
        if (r.seen.responded) c.responded++;
        if (r.seen.rating) { c.rated++; sum += r.seen.rating; }
      }
    });
    c.avg = c.rated ? Math.round(sum / c.rated * 10) / 10 : null;
    return c;
  }

  /** Public reviews of 1-3 stars the owner has not replied to. Owner only: anyone else gets []. */
  function lowAlerts(rows, claims, uid) {
    if (!canSee(claims, uid)) return [];
    return (rows || []).filter(function (r) { return r.seen.seen && r.seen.rating >= 1 && r.seen.rating <= LOW_MAX && !r.seen.responded; });
  }

  /** The banner text. Deliberately carries no name, address or job detail. */
  function alertText(n) {
    return n === 1 ? '1 review needs your reply' : n + ' reviews need your reply';
  }

  /** Paid, asked a while ago, nothing logged: a list for the owner to check by hand (no resend). */
  function silentAsks(rows, nowMs, days) {
    var cut = (nowMs == null ? Date.now() : nowMs) - (days || 14) * DAY_MS;
    return (rows || []).filter(function (r) { return r.ask.status === 'asked' && r.ask.askedAtMs && r.ask.askedAtMs <= cut && !r.seen.seen; });
  }

  /**
   * The review_log/{leadId} doc for "Got a review" (seen true) or its undo (seen false).
   * `ts` is serverTimestamp() in the browser; `ids` = { companyId, leadId }. Returns null when invalid.
   */
  function seenPatch(seen, platform, rating, uid, ts, prev, ids) {
    ids = ids || {};
    if (!uid || !ids.companyId || !ids.leadId) return null;
    var base = { companyId: String(ids.companyId), leadId: String(ids.leadId) };
    if (seen === false) return Object.assign(base, { reviewSeen: false, platform: null, rating: null, responded: false, updatedAt: ts, updatedBy: uid });
    if (!isPlatform(platform) || !isRating(rating)) return null;
    var keepResp = !!prev && prev.responded === true && prev.reviewSeen === true && prev.platform === platform && prev.rating === rating;
    return Object.assign(base, { reviewSeen: true, platform: platform, rating: rating, responded: keepResp, updatedAt: ts, updatedBy: uid });
  }
  function respondedPatch(responded, entry, uid, ts, ids) {
    var s = seenInfo(entry);
    ids = ids || {};
    if (!uid || !ids.companyId || !ids.leadId || !s.seen || !s.platform || !s.rating) return null;
    return { companyId: String(ids.companyId), leadId: String(ids.leadId), reviewSeen: true, platform: s.platform, rating: s.rating, responded: !!responded, updatedAt: ts, updatedBy: uid };
  }
  /** Reply draft with the reviewer's first name filled in; the name is cleaned to letters, spaces, . - '. */
  function fillTemplate(key, first) {
    var t = null;
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].key === key) t = TEMPLATES[i];
    if (!t) return '';
    var f = String(first == null ? '' : first).replace(/[^A-Za-z .'\-]/g, '').trim().slice(0, 40);
    return f ? t.text.replace(/\{first\}/g, f) : t.text.replace(/, \{first\}/g, '').replace(/\{first\}/g, '');
  }
  /** Which template fits a star rating. */
  function templateFor(rating) { return rating >= 5 ? 'five' : rating >= 3 ? 'mid' : 'low'; }

  /** Google's own aggregate from /api/google-reviews. null when the answer is not usable. */
  function googleSummary(body) {
    if (!body || typeof body !== 'object' || body.empty === true) return null;
    var rating = Number(body.rating), total = Number(body.total);
    if (!(rating > 0 && rating <= 5) || !(total >= 0)) return null;
    var shown = Array.isArray(body.reviews) ? body.reviews.length : 0;
    return { rating: Math.round(rating * 10) / 10, total: Math.floor(total), shown: shown, partial: shown < total };
  }

  function fmtDate(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
  }

  var pure = {
    isPlatform: isPlatform, platformLabel: platformLabel, isRating: isRating, canSee: canSee, paidLeads: paidLeads,
    askInfo: askInfo, seenInfo: seenInfo, buildRows: buildRows, counts: counts, lowAlerts: lowAlerts, alertText: alertText,
    silentAsks: silentAsks, seenPatch: seenPatch, respondedPatch: respondedPatch, fillTemplate: fillTemplate,
    templateFor: templateFor, googleSummary: googleSummary, fmtDate: fmtDate,
    PLATFORMS: PLATFORMS, TEMPLATES: TEMPLATES, RULES_COPY: RULES_COPY, FLAG: FLAG, LOW_MAX: LOW_MAX,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (!root || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  if (w.NBDReputation) return;

  var overlay = null;
  var st = { loading: false, error: '', invoices: null, log: null, logLoading: false, google: undefined, saving: false, filter: 'all', logId: '', pick: '', stars: 0, tplKey: 'five', tplFirst: '', last: null };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || (w.auth && w.auth.currentUser && w.auth.currentUser.uid) || null; }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function available() { return flagOn() && canSee(claims(), uid()); }
  function leads() { return w._leads || []; }
  function cid() { return claims().companyId || uid(); }
  function leadById(id) { return leads().filter(function (l) { return l && l.id === id; })[0] || null; }

  function rows() {
    if (!st.invoices || !w.NBDRevenue) return [];
    return buildRows(leads(), paidLeads(st.invoices, w.NBDRevenue.paymentsOf, w.NBDRevenue.isOwedInvoice), st.log);
  }

  /** The owner's review log: one tenant-scoped query, only for an owner with the flag on. */
  async function loadLog() {
    if (!available() || st.logLoading) return;
    if (!w.getDocs || !w.query || !w.where || !w.collection || !(w.db || w._db)) return;
    st.logLoading = true;
    try {
      var snap = await w.getDocs(w.query(w.collection(w.db || w._db, 'review_log'), w.where('companyId', '==', cid())));
      var m = {}; snap.docs.forEach(function (d) { m[d.id] = d.data(); });
      st.log = m;
    } catch (e) { if (!st.log) st.log = null; }
    st.logLoading = false;
  }

  function syncButton() {
    var b = doc.getElementById('reputationBtn');
    if (!b) return;
    var on = available();
    b.hidden = !on;
    var badge = doc.getElementById('reputationBadge');
    if (!badge) return;
    var n = 0;
    if (on && !st.log) loadLog().then(syncButton, function () {});
    if (on && st.log && w.NBDRevenue && typeof w.NBDRevenue.cached === 'function' && w.NBDRevenue.cached()) {
      n = lowAlerts(buildRows(leads(), paidLeads(w.NBDRevenue.cached(), w.NBDRevenue.paymentsOf, w.NBDRevenue.isOwedInvoice), st.log), claims(), uid()).length;
    }
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
  }

  async function loadData() {
    st.loading = true; st.error = ''; paint();
    try {
      if (!w.NBDRevenue || typeof w.NBDRevenue.loadInvoices !== 'function') throw new Error('Money data is not loaded on this page');
      st.invoices = await w.NBDRevenue.loadInvoices({ force: true });
      if (w.NBDRevenue.status && w.NBDRevenue.status() === 'failed') throw new Error('Payments could not be read');
      await loadLog();
    } catch (e) {
      st.invoices = null; st.error = (e && e.message) || 'Could not load payments';
    }
    st.loading = false; paint();
    if (st.google === undefined) {
      try {
        var res = await w.fetch('/api/google-reviews', { credentials: 'omit' });
        st.google = googleSummary(res.ok ? await res.json() : null);
      } catch (e) { st.google = null; }
      paint();
    }
  }

  // ── views ────────────────────────────────────────────────────────────
  function statusChip(r) {
    var a = r.ask;
    if (r.seen.seen) {
      return '<span class="rep-chip rep-seen">' + esc(platformLabel(r.seen.platform)) + ' ' + r.seen.rating + '★' + (r.seen.responded ? ' · replied' : '') + '</span>';
    }
    if (a.status === 'asked') return '<span class="rep-chip rep-asked">Asked' + (a.askedAtMs ? ' ' + esc(fmtDate(a.askedAtMs)) : '') + (a.channel ? ' · ' + esc(a.channel) : '') + '</span>';
    if (a.status === 'sending') return '<span class="rep-chip rep-asked">Sending</span>';
    if (a.status === 'failed') return '<span class="rep-chip rep-warn">Ask did not send (' + esc(a.reason) + ')</span>';
    if (a.status === 'skipped') return '<span class="rep-chip rep-warn" title="Only the manual review-ask prompts honour this. The daily automatic ask does not read it, so it can still send.">Marked "don\'t ask" (daily auto-ask may still send)</span>';
    return '<span class="rep-chip">Not asked yet</span>';
  }

  function logHtml(r) {
    var dis = st.saving ? ' disabled' : '';
    var h = '<div class="rep-log" role="group" aria-label="Log a review for ' + esc(r.name) + '"><div class="rep-q">Where was it posted?</div><div class="rep-pills">';
    PLATFORMS.forEach(function (p) {
      h += '<button type="button" class="rep-pill' + (st.pick === p.key ? ' on' : '') + '" data-rep-plat="' + esc(p.key) + '"' + dis + '>' + esc(p.label) + '</button>';
    });
    h += '</div><div class="rep-q">How many stars?</div><div class="rep-pills">';
    for (var n = 1; n <= 5; n++) h += '<button type="button" class="rep-pill' + (st.stars === n ? ' on' : '') + '" data-rep-star="' + n + '" aria-label="' + n + ' star' + (n === 1 ? '' : 's') + '"' + dis + '>' + n + '★</button>';
    h += '</div><div class="rep-foot"><button type="button" class="rep-btn" data-rep-act="cancel-log"' + dis + '>Cancel</button>' +
      '<button type="button" class="rep-btn rep-go" data-rep-act="save-log"' + ((st.pick && st.stars && !st.saving) ? '' : ' disabled') + '>Save</button></div></div>';
    return h;
  }

  function rowHtml(r) {
    var h = '<li class="rep-row"><div class="rep-top"><span class="rep-name">' + esc(r.name) + '</span>' + statusChip(r) + '</div>';
    if (r.privateRating) h += '<div class="rep-sub">Private rating in the customer portal: ' + r.privateRating + '★</div>';
    if (st.logId === r.id) return h + logHtml(r) + '</li>';
    h += '<div class="rep-acts">';
    if (!r.seen.seen) h += '<button type="button" class="rep-btn" data-rep-log="' + esc(r.id) + '">Got a review</button>';
    else {
      h += '<button type="button" class="rep-btn" data-rep-reply="' + esc(r.id) + '">Reply draft</button>';
      h += '<button type="button" class="rep-btn" data-rep-act="toggle-replied" data-rep-id="' + esc(r.id) + '">' + (r.seen.responded ? 'Not replied yet' : 'I replied') + '</button>';
      h += '<button type="button" class="rep-btn" data-rep-act="unlog" data-rep-id="' + esc(r.id) + '">Undo log</button>';
    }
    return h + '</div></li>';
  }

  function summaryHtml() {
    var g = st.google;
    if (g === undefined) return '<p class="rep-sub" role="status">Loading Google…</p>';
    if (!g) return '<p class="rep-sub">Google summary is not available right now.</p>';
    return '<p class="rep-sub">Google: ' + g.rating.toFixed(1) + '★ across ' + g.total + ' reviews. ' +
      (g.partial ? 'The CRM can read only the newest ' + g.shown + ' until Google approves full Business Profile access. ' : '') +
      'Yelp and Thumbtack: log by hand with Got a review.</p>';
  }

  function templatesHtml() {
    var h = '<section class="rep-sec"><h3 class="rep-h">Reply drafts</h3><p class="rep-sub">Paste into the review reply yourself. Nothing here posts or sends.</p>' +
      '<div class="rep-pills">';
    TEMPLATES.forEach(function (t) { h += '<button type="button" class="rep-pill' + (st.tplKey === t.key ? ' on' : '') + '" data-rep-tpl="' + esc(t.key) + '">' + esc(t.label) + '</button>'; });
    h += '</div><label class="rep-f">Reviewer first name<input type="text" class="rep-in" maxlength="40" value="' + esc(st.tplFirst) + '" data-rep-first="1"></label>' +
      '<textarea class="rep-ta" readonly rows="4" aria-label="Reply draft">' + esc(fillTemplate(st.tplKey, st.tplFirst)) + '</textarea>' +
      '<div class="rep-foot"><button type="button" class="rep-btn rep-go" data-rep-act="copy">Copy reply</button></div></section>';
    return h;
  }

  function bodyHtml() {
    var h = '<div class="rep-head"><h2 class="rep-title" id="repTitle">Reputation</h2>' +
      '<button type="button" class="rep-x" data-rep-act="close" aria-label="Close">×</button></div>';
    if (st.loading) return h + '<p class="rep-empty" role="status">Loading…</p>';
    if (st.error) return h + '<p class="rep-empty" role="alert">' + esc(st.error) + '</p><div class="rep-foot"><button type="button" class="rep-btn" data-rep-act="retry">Try again</button></div>';
    var all = rows(), c = counts(all, Date.now()), low = lowAlerts(all, claims(), uid()), silent = silentAsks(all, Date.now(), 14);
    if (low.length) {
      h += '<div class="rep-alert" role="alert"><strong>' + esc(alertText(low.length)) + '</strong><ul>' +
        low.map(function (r) { return '<li>' + esc(r.name) + ' · ' + esc(platformLabel(r.seen.platform)) + ' ' + r.seen.rating + '★ <button type="button" class="rep-btn" data-rep-reply="' + esc(r.id) + '">Reply draft</button></li>'; }).join('') +
        '</ul></div>';
    }
    h += '<div class="rep-counts">' +
      '<div class="rep-count"><b>' + c.askedThisMonth + '</b><span>asked this month</span></div>' +
      '<div class="rep-count"><b>' + c.asked + ' / ' + c.paid + '</b><span>paid jobs asked</span></div>' +
      '<div class="rep-count"><b>' + c.seen + '</b><span>reviews logged</span></div>' +
      '<div class="rep-count"><b>' + (c.avg == null ? '—' : c.avg.toFixed(1) + '★') + '</b><span>your logged average</span></div></div>';
    h += summaryHtml();
    h += '<ul class="rep-rules">' + RULES_COPY.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>';
    if (silent.length) h += '<p class="rep-sub">' + silent.length + ' asked more than 14 days ago with no review logged. Check Google, Yelp and Thumbtack by hand; do not re-send.</p>';
    var shown = all.filter(function (r) {
      return st.filter === 'asked' ? r.ask.status === 'asked' : st.filter === 'notyet' ? (r.ask.status === 'not_yet' || r.ask.status === 'skipped' || r.ask.status === 'failed') : st.filter === 'seen' ? r.seen.seen : true;
    });
    h += '<div class="rep-pills rep-filters">' + [['all', 'All'], ['asked', 'Asked'], ['notyet', 'Not asked'], ['seen', 'Reviewed']].map(function (f) {
      return '<button type="button" class="rep-pill' + (st.filter === f[0] ? ' on' : '') + '" data-rep-filter="' + f[0] + '">' + f[1] + '</button>';
    }).join('') + '</div>';
    h += all.length ? (shown.length ? '<ul class="rep-list">' + shown.map(rowHtml).join('') + '</ul>' : '<p class="rep-empty">Nothing in this view.</p>')
      : '<p class="rep-empty">No finished and paid jobs yet.</p>';
    return h + templatesHtml();
  }

  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;
    overlay.innerHTML = '<div class="rep-box" role="dialog" aria-modal="true" aria-labelledby="repTitle">' + bodyHtml() + '</div>';
    overlay.scrollTop = keep;
  }

  function open() {
    if (!available()) return false;
    if (overlay) { paint(); return true; }
    st.error = ''; st.saving = false; st.logId = ''; st.pick = ''; st.stars = 0; st.filter = 'all';
    overlay = doc.createElement('div');
    overlay.className = 'rep-overlay';
    overlay.setAttribute('data-rep-overlay', '1');
    doc.body.appendChild(overlay);
    loadData();
    return true;
  }
  function close() {
    if (st.saving) return;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    else if (overlay && typeof overlay.remove === 'function') overlay.remove();
    overlay = null;
    syncButton();
  }

  // ── the write (owner taps only) ──────────────────────────────────────
  async function write(id, data) {
    if (!available() || !data) return false;
    var db = w.db || w._db;
    if (!db || typeof w.setDoc !== 'function' || typeof w.doc !== 'function') { toast('Could not save: the CRM is not ready, reload and try again', 'error'); return false; }
    try { await w.setDoc(w.doc(db, 'review_log', id), data); } catch (e) {
      toast('Could not save: ' + ((e && e.code) || (e && e.message) || 'unknown error'), 'error');
      return false;
    }
    if (!st.log) st.log = {};                                // keep this screen and the badge in step
    st.log[id] = Object.assign({}, data, { updatedAt: Date.now() });
    return true;
  }
  function ids(id) { return { companyId: cid(), leadId: id }; }
  function stamp() { return typeof w.serverTimestamp === 'function' ? w.serverTimestamp() : new Date(); }

  async function saveLog() {
    if (st.saving || !st.logId) return;
    if (!leadById(st.logId)) return;
    st.saving = true; paint();
    var ok = await write(st.logId, seenPatch(true, st.pick, st.stars, uid(), stamp(), st.log && st.log[st.logId], ids(st.logId)));
    st.saving = false;
    if (ok) {
      var low = st.stars <= LOW_MAX;
      st.logId = ''; st.pick = ''; st.stars = 0;
      if (low) toast('Logged. This one needs your reply.', 'info');
    }
    syncButton(); paint();
  }

  function pickReply(id) {
    var l = leadById(id); if (!l) return;
    var s = seenInfo(st.log && st.log[id]);
    st.tplKey = templateFor(s.rating || 5); st.tplFirst = firstNameOf(l);
    paint();
    var ta = overlay && overlay.querySelector && overlay.querySelector('.rep-ta');
    if (ta && ta.scrollIntoView) ta.scrollIntoView({ block: 'center' });
  }

  async function copyReply() {
    var text = fillTemplate(st.tplKey, st.tplFirst);
    try {
      if (w.navigator && w.navigator.clipboard) { await w.navigator.clipboard.writeText(text); toast('Reply copied', 'success'); return; }
    } catch (e) { /* fall through */ }
    var ta = overlay && overlay.querySelector && overlay.querySelector('.rep-ta');
    if (ta) { ta.select(); toast('Press and hold to copy the selected reply', 'info'); }
  }

  // ── events ───────────────────────────────────────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-rep-act],[data-rep-log],[data-rep-plat],[data-rep-star],[data-rep-reply],[data-rep-tpl],[data-rep-filter],#reputationBtn');
    if (!t) return;
    if (t.id === 'reputationBtn') { ev.preventDefault(); open(); return; }
    if (!overlay || !available()) return;
    var a = t.getAttribute('data-rep-act'), id = t.getAttribute('data-rep-id');
    if (t.getAttribute('data-rep-log')) { st.logId = t.getAttribute('data-rep-log'); st.pick = ''; st.stars = 0; paint(); return; }
    if (t.getAttribute('data-rep-plat')) { st.pick = t.getAttribute('data-rep-plat'); paint(); return; }
    if (t.getAttribute('data-rep-star')) { st.stars = Number(t.getAttribute('data-rep-star')); paint(); return; }
    if (t.getAttribute('data-rep-reply')) { pickReply(t.getAttribute('data-rep-reply')); return; }
    if (t.getAttribute('data-rep-tpl')) { st.tplKey = t.getAttribute('data-rep-tpl'); paint(); return; }
    if (t.getAttribute('data-rep-filter')) { st.filter = t.getAttribute('data-rep-filter'); paint(); return; }
    if (a === 'close') close();
    else if (a === 'retry') loadData();
    else if (a === 'cancel-log') { st.logId = ''; paint(); }
    else if (a === 'copy') copyReply();
    else if (a === 'save-log') saveLog().catch(function (e) { st.saving = false; toast('Could not save: ' + (e && e.message || 'unknown error'), 'error'); paint(); });
    else if (a === 'toggle-replied' || a === 'unlog') {
      var entry = st.log && st.log[id]; if (!entry || st.saving) return;
      var patch = a === 'unlog' ? seenPatch(false, null, null, uid(), stamp(), null, ids(id)) : respondedPatch(!seenInfo(entry).responded, entry, uid(), stamp(), ids(id));
      st.saving = true; paint();
      write(id, patch).then(function () { st.saving = false; syncButton(); paint(); }, function () { st.saving = false; paint(); });
    }
  });
  doc.addEventListener('input', function (ev) {
    var el = ev.target;
    if (overlay && el && el.getAttribute && el.getAttribute('data-rep-first')) {
      st.tplFirst = String(el.value || '').slice(0, 40);
      var ta = overlay.querySelector('.rep-ta'); if (ta) ta.value = fillTemplate(st.tplKey, st.tplFirst);
    }
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  function init() {
    syncButton();
    if (w.NBDFlags && typeof w.NBDFlags.load === 'function') {
      Promise.resolve(w.NBDFlags.load()).then(syncButton, function () {});
    }
  }
  w.addEventListener('nbd:data-refreshed', syncButton);
  w.addEventListener('nbd:invoices-loaded', syncButton);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 1500); });
  else setTimeout(init, 1500);
  setInterval(syncButton, 60000);

  w.NBDReputation = { open: open, close: close, sync: syncButton, available: available, _pure: pure };
})(typeof window !== 'undefined' ? window : this);
