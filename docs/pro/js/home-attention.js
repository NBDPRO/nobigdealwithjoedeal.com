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

  /**
   * A snapshot that is EMPTY and came from the local cache (the device is
   * offline / the server never answered) says nothing about the server. A
   * non-empty cached snapshot is real data; a server-confirmed empty one is a
   * true "none". Snapshots without metadata (old fakes) count as confirmed.
   */
  function unconfirmedEmpty(snap) {
    return !!(snap && snap.metadata && snap.metadata.fromCache === true && (!snap.docs || snap.docs.length === 0));
  }

  const CALL_WINDOW = 14 * DAY;
  const PROMISE_WINDOW = 45 * DAY;
  // What Home READS (QA 2026-10-13): by DATE, the same 45-day window the server
  // reads (callWatch / ledger / away mode, #2407) - a row cap alone let 200
  // newer saved-contact calls push a 20-day-old promise out of sight. The caps
  // are only a safety bound; hitting one is said on the strip, never silent.
  // Rows before the window are read separately, for the "old promises" row.
  const READ = { recentCalls: 600, recentTexts: 300, oldCalls: 300 };
  const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  // A promise riding on the call doc itself (callCenterAction 'promise' on an
  // unfiled call): open once its date has come. Mirror of call-watch-logic.js
  // ridingPromiseOpen (QA 2026-10-13 H3: invisible to the rule past day 14).
  function ridingPromiseOpen(c, now) {
    const p = c && c.promise;
    if (!p || p.kind !== 'promise' || p.done === true || p.keptAtMs) return false;
    const due = String(p.dueDate || c.followUpDate || '');
    return !due || due <= etYmd(now == null ? Date.now() : now);
  }
  /** A promise Jo made that nothing has marked kept (promise-cleanup stamps keptAtMs). */
  const openJoPromise = (c, now) => (c.promises || []).some((p) => p && p.who === 'jo' && !p.keptAtMs) || ridingPromiseOpen(c, now);
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
  const BURST_N = 3, BURST_MS = DAY;
  // Mirror of call-watch-logic.js saneStampMs (QA 2026-10-13): a label's ackAtMs /
  // updatedAtMs is a client clock. A stamp more than a day in the future (a bad
  // phone clock, a hostile write) is ignored, so it can never park a hidden
  // number forever; the server ignores it the same way.
  const LABEL_FUTURE_SKEW_MS = DAY;
  const saneStampMs = (v, now) => {
    const ms = toMs(v);
    return isFinite(ms) && ms > 0 && ms <= now + LABEL_FUTURE_SKEW_MS ? ms : 0;
  };
  /**
   * Hidden numbers that should come back ONCE: a call since the label was
   * applied / last acknowledged that is filed on a customer ('lead'), or 3+
   * inbound calls in the last 24 h ('burst'). Returns [{ digits, reason,
   * calls, base }] — base (max of ackAtMs, updatedAtMs) makes the id of a
   * once-only alert. Handled / done / personal / spam calls never trigger it.
   */
  function resurfacedNumbers(rows, labels, now) {
    const out = [];
    if (!labels) return out;
    const t = now == null ? Date.now() : now;
    const by = new Map();
    (rows || []).forEach((c) => {
      if (!c || c.channel === 'text' || c.handledAtMs || c.taskDone === true || c.status === 'personal' || c.callType === 'spam') return;
      const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
      if (d.length !== 10) return;
      const lb = typeof labels.get === 'function' ? labels.get(d) : labels[d];
      // quiet joins the lead rule only (2026-10-13, audit C-4): never a burst.
      if (!lb || (lb.policy !== 'hide' && lb.policy !== 'quiet')) return;
      const base = Math.max(saneStampMs(lb.ackAtMs, t), saneStampMs(lb.updatedAtMs, t));
      if ((toMs(c.startedAtMs) || 0) <= base) return;
      if (!by.has(d)) by.set(d, { digits: d, base, quiet: lb.policy === 'quiet', calls: [] });
      by.get(d).calls.push(c);
    });
    by.forEach((v) => {
      const recent = v.calls.filter((c) => c.direction !== 'outbound' && (toMs(c.startedAtMs) || 0) >= t - BURST_MS);
      const onLead = v.calls.some((c) => c.leadId);
      const reason = onLead ? 'lead' : (!v.quiet && recent.length >= BURST_N ? 'burst' : '');
      if (reason) out.push({ digits: v.digits, reason, calls: v.calls, base: v.base });
    });
    return out;
  }
  function callNeedsYou(c, now, ctx) {
    const t = now == null ? Date.now() : now;
    if (!c || c.handledAtMs || c.status === 'personal') return false;
    if (c.callType === 'spam' || c.taskDone === true) return false;
    // Jo, 2026-10-12: a promise he made stays on the list past the 14-day
    // window, up to 45 days, then rolls into ONE "old promises" review row
    // (oldPromiseCount) instead of silently dropping off.
    if ((toMs(c.startedAtMs) || 0) < t - CALL_WINDOW) {
      if ((toMs(c.startedAtMs) || 0) < t - PROMISE_WINDOW) return false;
      return openJoPromise(c, t);
    }
    // A promise stamped kept stops counting at once (it used to nag to day 14).
    const promised = openJoPromise(c, t);
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
    // Safety valve (Jo, 2026-10-12): a HIDDEN number that matches a customer
    // or rings 3+ times in 24 h comes back once, as a row of its own; "Keep
    // hidden" (label ackAtMs) or ✓ Handled quiets it until it happens again.
    // (Rows before the window are on the page only for the old-promise row; the
    // server never feeds them to this rule, so neither does Home.)
    const inWindow = (rows || []).filter((c) => (toMs(c && c.startedAtMs) || 0) >= (now == null ? Date.now() : now) - PROMISE_WINDOW);
    resurfacedNumbers(inWindow, labels, now).forEach((v) => {
      v.calls.forEach((c) => {
        const k = callerKey(c);
        if (!by.has(k)) by.set(k, { key: k, calls: [] });
        const g = by.get(k);
        if (!g.calls.some((x) => x.id === c.id)) g.calls.push(c);
        g.resurfaced = v.reason; g.resurfacedDigits = v.digits;
      });
    });
    const groups = Array.from(by.values());
    groups.forEach((g) => {
      g.calls.sort((a, b) => (toMs(b.startedAtMs) || 0) - (toMs(a.startedAtMs) || 0));
      g.latestMs = toMs(g.calls[0].startedAtMs) || 0;
    });
    return groups.sort((a, b) => b.latestMs - a.latestMs);
  }
  /**
   * Calls past the 45-day promise window that still carry an open promise of
   * Jo's: ONE review row, never a silent drop. Not counted in "people need you".
   */
  function isOldPromise(c, now) {
    const t = now == null ? Date.now() : now;
    // A texted promise counts too (QA 2026-10-13: it appeared nowhere past 45 days).
    if (!c || c.handledAtMs || c.status === 'personal' || c.callType === 'spam' || c.taskDone === true) return false;
    return (toMs(c.startedAtMs) || 0) < t - PROMISE_WINDOW && openJoPromise(c, t);
  }
  function oldPromiseCount(rows, now) {
    const people = new Set();
    (rows || []).forEach((c) => { if (isOldPromise(c, now)) people.add(callerKey(c)); });
    return people.size;
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
    // A read that failed is never the same as a zero: the item says so and the
    // tap re-reads (data-ha-retry, delegated below), it does not navigate.
    const retry = (msg) => '<button type="button" class="ha-item ha-warn" data-ha-retry="1">⚠ ' + msg + ' — this is NOT an all-clear. Tap to try again</button>';
    if (c.stripeFailed) items.push(retry('Could not check Stripe payments just now'));
    if (c.signsFailed) items.push(retry('Could not check your yard signs just now'));
    if (c.reviewsFailed) items.push(retry('Could not check which review asks are waiting (your invoices did not load)'));
    if (c.stripe > 0) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="money">💳 ' + c.stripe + ' Stripe payment' + (c.stripe === 1 ? '' : 's') + ' need' + (c.stripe === 1 ? 's' : '') + ' a customer</button>');
    if (c.signs > 0) items.push('<button type="button" class="ha-item" data-action="goTo" data-target="signs">🪧 ' + c.signs + ' yard sign' + (c.signs === 1 ? '' : 's') + ' to pick up</button>');
    if (c.callsCapped) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">⚠ Showing only your newest ' + (c.callsCap || '') + ' calls — older ones in the last 45 days were not checked. Tap to open the Call Center</button>');
    if (c.textsCapped) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">⚠ Showing only your newest ' + (c.textsCap || '') + ' days of texts — older ones in the last 45 days were not checked</button>');
    if (c.oldCapped) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">⚠ Showing only the newest ' + (c.oldCap || '') + ' calls from before the 45-day window — an older open promise may not be listed</button>');
    if (c.oldFailed) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">⚠ Could not check old promises (past 45 days) just now — this is NOT an all-clear for them</button>');
    if (c.callsFailed) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">⚠ Could not check your calls just now' + (c.calls > 0 ? ' — ' + c.calls + (c.calls === 1 ? ' person needs' : ' people need') + ' you so far' : ' — this is NOT an all-clear') + '. Tap to open the Call Center</button>');
    else if (c.calls > 0) items.push('<button type="button" class="ha-item ha-warn" data-action="goTo" data-target="calls">📞 ' + c.calls + (c.calls === 1 ? ' person needs' : ' people need') + ' you</button>');
    // Review asks, one at a time (review-deck.js opens the deck on data-review-deck).
    if (c.oldPromises > 0) items.push('<button type="button" class="ha-item" data-action="goTo" data-target="calls">🗂 ' + c.oldPromises + (c.oldPromises === 1 ? ' old promise' : ' old promises') + ' to review</button>');
    if (c.reviews > 0) items.push('<button type="button" class="ha-item" data-review-deck="1">⭐ ' + c.reviews + ' review ask' + (c.reviews === 1 ? '' : 's') + ' waiting</button>');
    return items.join('');
  }

  const api = { READ, PROMISE_WINDOW, CALL_WINDOW, canSeeStripe, tenantOf, signsDue, reviewCount, stripHtml, callNeedsYou, callsNeedingYou, callerKey, groupNeeds, callersNeedingYou, oldPromiseCount, isOldPromise, hiddenPeople, resurfacedNumbers, reachIndex, isMissedCall };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.NBDHomeAttention = api;

  // ── DOM ──────────────────────────────────────────────────────────────
  const w = root;
  let _last = 0, _busy = false, _again = false;
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
        if (w.NBDRevenue && typeof w.NBDRevenue.loadInvoices === 'function') {
          await w.NBDRevenue.loadInvoices().catch(() => null);
          // loadInvoices never rejects: a failed query resolves [] and leaves
          // cached() null (a real empty list is cached as []). "Paid in full"
          // is judged from these invoices, so no invoices = review asks that
          // may be missing, not "none waiting".
          if (typeof w.NBDRevenue.cached === 'function' && !w.NBDRevenue.cached()) out.reviewsFailed = true;
        }
        out.reviews = w.NBDReviewDeck.candidates(w._leads).length;
      }
    } catch (_) { out.reviewsFailed = true; /* never block the strip - but say so */ }
    const tenant = tenantOf(c, u);
    const jobs = [];
    if (canSeeStripe(c, u) && tenant) {
      jobs.push(w.getDocs(w.query(w.collection(w.db, 'stripeLedger'), w.where('companyId', '==', tenant), w.where('needsReview', '==', true)))
        .then((snap) => {
          // An empty answer served from the local cache (offline) is not "no
          // payments need a customer": it is a read that never reached the server.
          if (unconfirmedEmpty(snap)) { out.stripeFailed = true; return; }
          out.stripe = reviewCount(snap.docs.map((d) => d.data()));
        }).catch(() => { out.stripeFailed = true; }));
    }
    const staff = ['company_admin', 'manager', 'viewer', 'admin'].includes(c.role || '') && !!c.companyId;
    const col = w.collection(w.db, 'yardSigns');
    jobs.push(w.getDocs(staff ? w.query(col, w.where('companyId', '==', c.companyId)) : w.query(col, w.where('userId', '==', u)))
      .then((snap) => {
        if (unconfirmedEmpty(snap)) { out.signsFailed = true; return; }
        out.signs = signsDue(snap.docs.map((d) => d.data()), Date.now());
      }).catch(() => { out.signsFailed = true; }));
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
      // Same (userId, startedAtMs DESC) index as before: an equality + a range
      // on the ordered field. (The emulator never enforces indexes - the
      // server reads these exact shapes in prod.)
      const sinceWin = Date.now() - PROMISE_WINDOW;
      const qWin = (name, cap) => w.getDocs(w.query(w.collection(w.db, name), w.where('userId', '==', u), w.where('startedAtMs', '>=', sinceWin), w.orderBy('startedAtMs', 'desc'), w.limit(cap)));
      jobs.push(qWin('phone_calls', READ.recentCalls)
        .then((snap) => {
          if (unconfirmedEmpty(snap)) { out.callsFailed = true; return; }
          snap.docs.forEach((d) => callRows.push(Object.assign({ id: d.id }, d.data())));
          if (snap.docs.length >= READ.recentCalls) { out.callsCapped = true; out.callsCap = READ.recentCalls; }
        }).catch(() => { out.callsFailed = true; }));
      jobs.push(qWin('phone_text_days', READ.recentTexts)
        .then((snap) => {
          if (unconfirmedEmpty(snap)) { out.callsFailed = true; return; }
          snap.docs.forEach((d) => callRows.push(Object.assign({ id: 'text:' + d.id }, d.data())));
          if (snap.docs.length >= READ.recentTexts) { out.textsCapped = true; out.textsCap = READ.recentTexts; }
        }).catch(() => { out.callsFailed = true; }));
      // Open promises older than the window roll into one review row: their own
      // bounded read. A failed one is a warning (oldFailed), not "no old promises".
      jobs.push(w.getDocs(w.query(w.collection(w.db, 'phone_calls'), w.where('userId', '==', u), w.where('startedAtMs', '<', sinceWin), w.orderBy('startedAtMs', 'desc'), w.limit(READ.oldCalls)))
        .then((snap) => {
          if (unconfirmedEmpty(snap)) { out.oldFailed = true; return; }
          snap.docs.forEach((d) => callRows.push(Object.assign({ id: d.id }, d.data())));
          if (snap.docs.length >= READ.oldCalls) { out.oldCapped = true; out.oldCap = READ.oldCalls; }
        }).catch(() => { out.oldFailed = true; }));
    } else if (u) {
      // The query helpers are missing: that is a read that could not happen,
      // not "nobody needs you".
      out.callsFailed = true;
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
    out.oldPromises = oldPromiseCount(callRows, Date.now());
    // Today (today-home.js) lists these same people from these same rows —
    // shared, not re-read (2026-10-03).
    api.lastRows = callRows; api.lastCounts = out; api.lastLabels = labels;
    try { w.dispatchEvent(new CustomEvent('nbd:attention-loaded')); } catch (_) { /* old browser */ }
    return out;
  }

  async function render(force) {
    const el = document.getElementById('homeAttention');
    if (!el || !uid() || !fbReady()) return;
    // A FORCED refresh asked for while one is in flight (a promise saved / a
    // call handled mid-read) used to be dropped, leaving the strip and Today on
    // the stale rows for a minute: remember it and run it once this one ends.
    if (_busy) { if (force) _again = true; return; }
    if (!force && Date.now() - _last < 60000) return;
    _busy = true; _last = Date.now();
    try {
      let counts;
      try { counts = await count(); } catch (e) {
        // count() itself threw (not one of its per-read catches): every source is
        // unconfirmed. Say so; keep the rows already held.
        try { console.warn('[home-attention] count failed:', e && (e.code || e.message)); } catch (_) { /* no console */ }
        counts = { stripe: 0, signs: 0, calls: 0, reviews: 0, callsFailed: true, stripeFailed: true, signsFailed: true };
        api.lastCounts = counts;
        try { w.dispatchEvent(new CustomEvent('nbd:attention-loaded')); } catch (_) { /* old browser */ }
      }
      let html;
      try { html = stripHtml(counts); } catch (e) {
        // The paint itself threw: never leave the previous (possibly all-clear) strip up.
        try { console.warn('[home-attention] strip paint failed:', e && (e.code || e.message)); } catch (_) { /* no console */ }
        html = '<button type="button" class="ha-item ha-warn" data-ha-retry="1">⚠ Could not show your attention list — this is NOT an all-clear. Tap to try again</button>';
      }
      el.innerHTML = html;
      el.hidden = !html;
    } finally {
      _busy = false;
      if (_again) { _again = false; setTimeout(() => { render(true); }, 0); }
    }
  }

  // The 'contactlabels' lazy bundle is registered HERE, not in script-loader.js:
  // that file is a blocking script and its budget has ~300 B of headroom
  // (dashboard-boot-budget). today-home.js and call-center-view.js load it by
  // name; this deferred file always runs first.
  if (w.ScriptLoader && w.ScriptLoader.bundles && !w.ScriptLoader.bundles.contactlabels) {
    w.ScriptLoader.bundles.contactlabels = ['css/contact-labels.css?v=4', 'js/contact-labels-logic.js?v=7', 'js/contact-labels.js?v=7', 'js/contact-suggest-logic.js?v=3', 'js/contact-suggest.js?v=3'];
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
  // "Tap to try again" on a failed Stripe / yard-sign / review-ask read (CSP:
  // no inline handler - one delegate on the document).
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-ha-retry]') : null;
    if (t) render(true);
  });
  w.addEventListener('nbd:data-refreshed', () => { render(false); });
  w.addEventListener('hashchange', () => { if (/^#?\/?(home|dash)?$/.test(location.hash || '')) setTimeout(() => render(false), 300); });
  const boot = () => setTimeout(() => render(true), 1500);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  api.render = render;
})(typeof window !== 'undefined' ? window : null);
