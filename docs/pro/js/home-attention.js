/**
 * home-attention.js — the "needs you" strip on Home (#homeAttention, under the
 * KPI row). Two counts, each shown only when it is not zero, each a tap to
 * the view that clears it:
 *
 *   💳 Stripe payments that need a customer   → Money (the Stripe panel's
 *      review list, stripeLedger needsReview:true)
 *   🪧 Yard signs due for pickup today / late  → Yard Signs
 *   📞 Phone calls (and days of texts) that need you (2026-10-02) → Call Center
 *
 * callNeedsYou() is THE "needs attention" rule — call-center-view.js uses
 * this same function for its default tab, so Home and the Call Center can
 * never disagree. Recent calls only (14 days, the task window): the 90-day
 * backlog holds hundreds of saved-contact calls that would otherwise read
 * "300 calls need you". A call needs you when it is not handled / personal
 * and is urgent, carries a promise Jo made, has a follow-up date that has
 * come, or is an insurance line / unknown number with no customer on file
 * (a missed call from an unknown number counts: it may be a lead). A saved
 * contact with no customer only counts through a promise — or a missed call
 * (2026-10-03, as for customers). Done follow-up task, spam: never.
 *
 * Both lists already exist on their own views; Jo asked for the Stripe one
 * to surface on Home (2026-09-29) so a payment never sits unassigned because
 * nobody opened Money. Reads only — nothing here writes.
 *
 * The Stripe count uses the ledger's read rule (stripe-ledger-ui-logic.js
 * canRead: not a sales rep or viewer — tests pin the parity) and the tenant
 * the panel uses. Yard signs use the same owner / company query as
 * yard-signs.js. Both are equality-only queries (no composite index).
 * Rendered after data refreshes, throttled to one read per minute.
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  const DAY = 86400000;
  const toMs = (t) => {
    if (t == null) return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const v = Date.parse(t); return isFinite(v) ? v : 0;
  };
  const startOfDay = (ms) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };

  function canSeeStripe(claims, uid) {
    if (!uid) return false;
    const r = (claims || {}).role || '';
    return r !== 'sales_rep' && r !== 'viewer';
  }
  function tenantOf(claims, uid) { return (claims && claims.companyId) || uid || null; }

  /** Signs still out whose pickup day is today or already past. */
  function signsDue(signs, now) {
    const today = startOfDay(now == null ? Date.now() : now);
    return (signs || []).filter((s) => {
      if (!s || s.deleted || s.status === 'picked_up' || s.status === 'missing') return false;
      const due = toMs(s.dueAt);
      return due > 0 && startOfDay(due) <= today;
    }).length;
  }
  function reviewCount(rows) {
    return (rows || []).filter((r) => r && r.needsReview === true && r.kind !== 'platform_subscription').length;
  }

  const CALL_WINDOW = 14 * DAY;
  const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // A missed call: they rang, it was under 15 s (Cube ACR keeps no real audio).
  const isMissedCall = (c) => !!c && c.channel !== 'text' && c.status === 'short' && c.direction === 'inbound';
  /**
   * When each person was last REACHED by phone: any later call that isn't
   * itself a missed one (Jo rang back, or they got through). A missed call
   * with a reach after it is dealt with. Texts don't count. ctx for
   * callNeedsYou, built from the same rows.
   */
  function reachIndex(rows) {
    const m = new Map();
    (rows || []).forEach((r) => {
      if (!r || r.channel === 'text' || isMissedCall(r) || (r.direction !== 'inbound' && r.direction !== 'outbound')) return;
      const k = callerKey(r), at = toMs(r.startedAtMs) || 0;
      if (at > (m.get(k) || 0)) m.set(k, at);
    });
    return { reachedAt: m };
  }
  /**
   * 2026-10-03 ("the CRM knows I called"):
   *   - the call's follow-up task is done (taskDone, mirrored server-side by
   *     onCallTaskWrite) → the promise is kept, it no longer needs you;
   *   - spam never counts; a sub / supplier counts only through a promise;
   *   - a MISSED call counts for customers and saved contacts too (it used
   *     to count only from unknown numbers), until Jo reaches them.
   */
  // 2026-10-12 — per-number labels (contact-labels-logic.js; documentation/
  // projects/CONTACT-ROUTING-TREE-2026-10-12.md). ctx.labels = { digits10:
  // { kind, policy } } (or a Map). An explicit label beats the AI's callType
  // and bucket: policy 'hide' never counts, 'quiet' counts only through a
  // promise Jo made (what sub / supplier always did), 'surface' = as before.
  // Absent / unknown labels change nothing, so every caller that passes no
  // labels (callWatch's mirror, old tests) behaves exactly as it did.
  function labelOf(ctx, c) {
    const L = ctx && ctx.labels;
    if (!L || !c) return null;
    const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
    if (d.length !== 10) return null;
    return (typeof L.get === 'function' ? L.get(d) : L[d]) || null;
  }
  function callNeedsYou(c, now, ctx) {
    const t = now == null ? Date.now() : now;
    if (!c || c.handledAtMs || c.status === 'personal') return false;
    if (c.callType === 'spam' || c.taskDone === true) return false;
    if ((toMs(c.startedAtMs) || 0) < t - CALL_WINDOW) return false;
    const promised = (c.promises || []).some((p) => p && p.who === 'jo');
    const lb = labelOf(ctx, c);
    const pol = lb && (lb.policy === 'hide' || lb.policy === 'quiet' || lb.policy === 'surface') ? lb.policy : '';
    // Jo, 2026-10-12: "a promise ALWAYS surfaces" — hide / quiet drop missed
    // and unknown-number noise, never a commitment Jo made on the call (his
    // promise, or a follow-up date that has come). A HIDDEN number's urgent
    // call also breaks through (an urgent flag is a real emergency until Jo
    // says otherwise); a quiet number's does not (sub / supplier rule).
    const dueFu = !!(c.followUpDate && c.followUpDate <= etYmd(t));
    // (A number Jo labeled SPAM never breaks through on urgency: robocalls
    // claim to be urgent. A personal number can — a family emergency.)
    if (pol === 'hide') return promised || dueFu || (c.urgent === true && lb.kind !== 'spam');
    if (pol === 'quiet') return promised || dueFu;
    if (!pol && (c.callType === 'sub' || c.callType === 'supplier')) return promised;
    if (c.urgent === true) return true;
    if (promised) return true;
    if (c.followUpDate && c.followUpDate <= etYmd(t)) return true;
    if (isMissedCall(c)) {
      const reached = ctx && ctx.reachedAt ? (ctx.reachedAt.get(callerKey(c)) || 0) : 0;
      return reached <= (toMs(c.startedAtMs) || 0);
    }
    if (c.leadId) return false;
    // A number Jo labeled an adjuster is an insurance call even when the
    // phone contact carries no carrier name.
    if (c.bucket === 'insurance' || (lb && lb.kind === 'insurance')) return true;
    if (c.bucket === 'unknown') return c.status !== 'short';
    return false;
  }
  function callsNeedingYou(rows, now, labels) { const ctx = reachIndex(rows); if (labels) ctx.labels = labels; return (rows || []).filter((c) => callNeedsYou(c, now, ctx)).length; }

  // Who a call / text day is with: the customer it is filed on, else the
  // number. Jo, 2026-10-02: "group them by customer" — 78 open calls were
  // 46 people (one customer had five), and an older call's promise was often
  // kept on a later one, so Home, the Call Center and the 2-hourly alert
  // count PEOPLE and a person's open calls clear together.
  function callerKey(c) {
    if (!c) return '';
    if (c.leadId) return 'lead:' + c.leadId;
    const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
    return d ? 'num:' + d : 'id:' + (c.id || '');
  }
  /** Open calls grouped by caller, newest caller first; calls newest first. */
  function groupNeeds(rows, now, labels) {
    const by = new Map();
    const ctx = reachIndex(rows);
    if (labels) ctx.labels = labels;
    (rows || []).filter((c) => callNeedsYou(c, now, ctx)).forEach((c) => {
      const k = callerKey(c);
      if (!by.has(k)) by.set(k, { key: k, calls: [] });
      by.get(k).calls.push(c);
    });
    const groups = Array.from(by.values());
    groups.forEach((g) => {
      g.calls.sort((a, b) => (toMs(b.startedAtMs) || 0) - (toMs(a.startedAtMs) || 0));
      g.latestMs = toMs(g.calls[0].startedAtMs) || 0;
    });
    return groups.sort((a, b) => b.latestMs - a.latestMs);
  }
  function callersNeedingYou(rows, now, labels) { return groupNeeds(rows, now, labels).length; }
  /** People a label took OFF the list: who needed you by the old rule and no longer do. */
  function hiddenPeople(rows, now, labels) {
    if (!labels) return 0;
    const shown = new Set(groupNeeds(rows, now, labels).map((g) => g.key));
    return groupNeeds(rows, now).filter((g) => !shown.has(g.key)).length;
  }

  function stripHtml(counts) {
    const c = counts || {};
    const items = [];
    if (c.stripe > 0) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="money">💳 ' + c.stripe + ' Stripe payment' + (c.stripe === 1 ? '' : 's') + ' need' + (c.stripe === 1 ? 's' : '') + ' a customer</button>');
    if (c.signs > 0) items.push('<button type="button" class="ha-item" data-action="goTo" data-target="signs">🪧 ' + c.signs + ' yard sign' + (c.signs === 1 ? '' : 's') + ' to pick up</button>');
    if (c.callsFailed) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">⚠ Could not check your calls just now' + (c.calls > 0 ? ' — ' + c.calls + (c.calls === 1 ? ' person needs' : ' people need') + ' you so far' : ' — this is NOT an all-clear') + '. Tap to open the Call Center</button>');
    else if (c.calls > 0) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">📞 ' + c.calls + (c.calls === 1 ? ' person needs' : ' people need') + ' you</button>');
    // Review asks, one at a time (review-deck.js opens the deck on data-review-deck).
    if (c.reviews > 0) items.push('<button type="button" class="ha-item" data-review-deck="1">⭐ ' + c.reviews + ' review ask' + (c.reviews === 1 ? '' : 's') + ' waiting</button>');
    return items.join('');
  }

  const api = { canSeeStripe, tenantOf, signsDue, reviewCount, stripHtml, callNeedsYou, callsNeedingYou, callerKey, groupNeeds, callersNeedingYou, hiddenPeople, reachIndex, isMissedCall };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.NBDHomeAttention = api;

  // ── DOM ──────────────────────────────────────────────────────────────
  const w = root;
  let _last = 0, _busy = false;
  const uid = () => (w._user && w._user.uid) || null;
  const claims = () => w._userClaims || {};
  const fbReady = () => !!(w.db && w.getDocs && w.query && w.where && w.collection);

  async function count() {
    const u = uid(), c = claims();
    const out = { stripe: 0, signs: 0, calls: 0, reviews: 0 };
    // Review asks wait for PAID IN FULL (2026-10-03), judged from the
    // invoices — load the shared cache first (one query, reused).
    try {
      if (w.NBDReviewDeck) {
        if (w.NBDRevenue && typeof w.NBDRevenue.loadInvoices === 'function') await w.NBDRevenue.loadInvoices().catch(() => null);
        out.reviews = w.NBDReviewDeck.candidates(w._leads).length;
      }
    } catch (_) { /* never block the strip */ }
    const tenant = tenantOf(c, u);
    const jobs = [];
    if (canSeeStripe(c, u) && tenant) {
      jobs.push(w.getDocs(w.query(w.collection(w.db, 'stripeLedger'), w.where('companyId', '==', tenant), w.where('needsReview', '==', true)))
        .then((snap) => { out.stripe = reviewCount(snap.docs.map((d) => d.data())); }).catch(() => {}));
    }
    const staff = ['company_admin', 'manager', 'viewer', 'admin'].includes(c.role || '') && !!c.companyId;
    const col = w.collection(w.db, 'yardSigns');
    jobs.push(w.getDocs(staff ? w.query(col, w.where('companyId', '==', c.companyId)) : w.query(col, w.where('userId', '==', u)))
      .then((snap) => { out.signs = signsDue(snap.docs.map((d) => d.data()), Date.now()); }).catch(() => {}));
    // Calls: the owner's own (phone_calls rules: owner always reads own).
    // Days of texts (phone_text_days) count by the same rule — a texted
    // promise is a promise — and pool with the calls, so a customer who
    // called AND texted is one person.
    const callRows = [];
    if (u && w.orderBy && w.limit) {
      // A failed read must NOT render as "nobody needs you" (2026-10-12 audit
      // R5): a missing index, a rules / App Check denial or being offline all
      // land here, and an empty list is exactly what a healthy quiet day looks
      // like. callsFailed turns the strip into a visible warning instead.
      jobs.push(w.getDocs(w.query(w.collection(w.db, 'phone_calls'), w.where('userId', '==', u), w.orderBy('startedAtMs', 'desc'), w.limit(200)))
        .then((snap) => { snap.docs.forEach((d) => callRows.push(Object.assign({ id: d.id }, d.data()))); }).catch(() => { out.callsFailed = true; }));
      jobs.push(w.getDocs(w.query(w.collection(w.db, 'phone_text_days'), w.where('userId', '==', u), w.orderBy('startedAtMs', 'desc'), w.limit(100)))
        .then((snap) => { snap.docs.forEach((d) => callRows.push(Object.assign({ id: 'text:' + d.id }, d.data()))); }).catch(() => { out.callsFailed = true; }));
    }
    await Promise.all(jobs);
    // Per-number labels (2026-10-12): a lazy bundle, read after the calls so
    // it never delays the strip; any failure = no labels = the old rule.
    let labels = null;
    try {
      if (w.ScriptLoader && typeof w.ScriptLoader.loadBundle === 'function') await w.ScriptLoader.loadBundle('contactlabels');
      if (w.NBDContactLabels) labels = await w.NBDContactLabels.load(false);
    } catch (_) { labels = null; }
    out.calls = callersNeedingYou(callRows, Date.now(), labels);
    out.hidden = hiddenPeople(callRows, Date.now(), labels);
    // Today (today-home.js) lists these same people from these same rows —
    // shared, not re-read (2026-10-03).
    api.lastRows = callRows; api.lastCounts = out; api.lastLabels = labels;
    try { w.dispatchEvent(new CustomEvent('nbd:attention-loaded')); } catch (_) { /* old browser */ }
    return out;
  }

  async function render(force) {
    const el = document.getElementById('homeAttention');
    if (!el || !uid() || !fbReady() || _busy) return;
    if (!force && Date.now() - _last < 60000) return;
    _busy = true; _last = Date.now();
    try {
      const html = stripHtml(await count());
      el.innerHTML = html;
      el.hidden = !html;
    } finally { _busy = false; }
  }

  // The 'contactlabels' lazy bundle is registered HERE, not in script-loader.js:
  // that file is a blocking script and its budget has ~300 B of headroom
  // (dashboard-boot-budget). today-home.js and call-center-view.js load it by
  // name; this deferred file always runs first.
  if (w.ScriptLoader && w.ScriptLoader.bundles && !w.ScriptLoader.bundles.contactlabels) {
    w.ScriptLoader.bundles.contactlabels = ['css/contact-labels.css?v=1', 'js/contact-labels-logic.js?v=2', 'js/contact-labels.js?v=1'];
  }
  // A label changed (optimistic apply, undo or rollback): recount from the
  // rows already held — no Firestore read — and repaint the strip.
  w.addEventListener('nbd:labels-changed', () => {
    const el = document.getElementById('homeAttention');
    if (!api.lastRows || !api.lastCounts) return;
    api.lastCounts.calls = callersNeedingYou(api.lastRows, Date.now(), api.lastLabels);
    api.lastCounts.hidden = hiddenPeople(api.lastRows, Date.now(), api.lastLabels);
    if (el) { const html = stripHtml(api.lastCounts); el.innerHTML = html; el.hidden = !html; }
  });
  w.addEventListener('nbd:data-refreshed', () => { render(false); });
  w.addEventListener('hashchange', () => { if (/^#?\/?(home|dash)?$/.test(location.hash || '')) setTimeout(() => render(false), 300); });
  const boot = () => setTimeout(() => render(true), 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  api.render = render;
})(typeof window !== 'undefined' ? window : null);
