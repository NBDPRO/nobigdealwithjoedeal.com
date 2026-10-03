/**
 * crm-snooze.js — notifications subsystem + follow-up engines.
 *
 * Extracted from crm.js (Step 4b — 2026-05-16) as one of four
 * sibling modules. Load order is critical and locked in
 * dashboard.html:
 *
 *   leads → pipeline → snooze → portal-bridge → crm (shim)
 *
 * This file holds:
 *   - the Firestore notifications FEED: the onSnapshot subscription that
 *     hydrates window._notifications + fires 'nbd:notifs-updated'.
 *     Rendering the bell (badge, dropdown, dismissed drawer, mark-read/
 *     dismiss/restore/clear) now lives in notif-bell.js — the single
 *     owner. crm-snooze only exposes window.NBDServerNotifs so notif-bell
 *     can persist server-notification read/dismiss/restore to Firestore.
 *   - the follow-up notification engine
 *     (checkAndCreateFollowUpNotifications)
 *   - the missing-required-field auto-notifier
 *     (checkAndCreateNeedsFieldNotifications)
 *   - the tel:/sms:/mailto: comm-log click delegate
 *   - the user-gesture-gated browser notification permission
 *     request + waitForNotifAuth poll
 *   - sign-out / pagehide tear-down for the poll + onSnapshot
 *
 * Naming note: "snooze" in the module name follows the cleanup-plan
 * grouping (notifications + follow-ups + the user-controllable
 * pause-the-noise surface live together). The LeadSnooze module
 * itself lives in lead-snooze.js — this file just consumes it from
 * the buildCard render path in crm-pipeline.js.
 *
 * It references the Firebase shim consts (col, _addDoc,
 * _serverTimestamp, …) declared in crm-leads.js — visible as
 * outer-scope globals in classic-script sibling scope.
 */


// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════════════════

let __NBD_COMM_LOG_DELEGATE, _notifUnsub; // module-local (globals Tranche 1 — was window.*)
window._notifications = [];
_notifUnsub = null; // onSnapshot unsubscribe handle

// Single-owner refactor (2026-07-07): notif-bell.js is now the sole
// renderer of the header bell (it loads last and owns the window.*
// bindings + the dropdown open state). crm-snooze no longer touches
// #notifBadge / #notifList — doing so was the source of three bugs:
// server notifications never showed in the opened dropdown, couldn't
// be cleared, and the badge raced between the two systems.
//
// This function now only HYDRATES the Firestore feed. It publishes the
// FULL list (including dismissed docs) on window._notifications so
// notif-bell can render the active list + the dismissed drawer + a
// correct union badge, then fires 'nbd:notifs-updated' so notif-bell
// re-renders in real time. The follow-up / needs-field / review-engine
// dedup readers of window._notifications keep working — seeing a
// dismissed same-day notification just (correctly) suppresses a
// duplicate re-create.
function _renderNotifBadgeAndList(allNotifs) {
  window._notifications = allNotifs; // full list, incl. dismissed
  try {
    window.dispatchEvent(new Event('nbd:notifs-updated'));
  } catch (_) {
    // Extremely old engines without the Event constructor: notif-bell's
    // own 60s poll / focus / open-render still picks up the new feed
    // from window._notifications on the next tick.
  }
}

async function loadNotifications() {
  try {
    const _auth = window._auth;
    const _db   = window._db;
    if (!_auth || !_db) return;
    const user  = _auth.currentUser;
    if (!user) return;

    const {getDocs: _getDocs, onSnapshot: _onSnap, query: _query, collection: _col, where: _where, orderBy: _order, limit: _limit} =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");

    const q = _query(
      _col(_db, 'notifications'),
      _where('userId', '==', user.uid),
      _order('createdAt', 'desc'),
      _limit(50)
    );

    // ── Live listener ──
    // Previously this was a one-shot getDocs, so the bell badge was a
    // snapshot — push messages, server-issued notifications, and peer
    // activity never appeared until a hard reload. Subscribe via
    // onSnapshot so the badge + list update in real time. We keep a
    // single subscription per session (re-arming bails the old one)
    // and tear down on sign-out.
    if (typeof _notifUnsub === 'function') {
      try { _notifUnsub(); } catch(_) {}
      _notifUnsub = null;
    }
    if (typeof _onSnap === 'function') {
      _notifUnsub = _onSnap(q, (snap) => {
        const allNotifs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        _renderNotifBadgeAndList(allNotifs);
      }, (err) => {
        // Listener errored — fall back to a one-shot read so the
        // user at least sees something instead of a broken badge.
        console.warn('notifications onSnapshot error:', err && err.message);
        // …and bring the poll back, because the live path is no longer
        // delivering. This is the ONLY state in which polling earns its keep.
        _notifLive = false;
        _startNotifPoll();
        _getDocs(q).then(s => {
          _renderNotifBadgeAndList(s.docs.map(d => ({ id: d.id, ...d.data() })));
        }).catch(() => {});
      });
      // A live subscription makes the 120-second poll not just redundant but
      // actively harmful: each tick tore this listener down and re-subscribed,
      // which re-reads the whole 50-document query from the server. That is a
      // billed read set and a radio wake every two minutes, forever, on a
      // phone in a truck — to learn what the listener had already pushed.
      _notifLive = true;
      _stopNotifPoll();
    } else {
      // SDK shape changed — last-resort one-shot.
      const snap = await _getDocs(q);
      _renderNotifBadgeAndList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }
  } catch (error) {
    console.error('Error loading notifications:', error);
  }
}

// ══════════════════════════════════════════════════════════════════════
// FOLLOW-UP NOTIFICATION ENGINE
// ══════════════════════════════════════════════════════════════════════
//
// AT MOST ONE notification per (kind, lead, local day) — 2026-10-03.
//
// The owner tenant had 18,169 follow_up docs (17,562 unread) across 89
// leads: up to 31 for one lead in one day, 2,557 lead-days duplicated
// despite the dateKey field. Root cause: the engine wrote with addDoc (a
// random id every time) and deduped against window._notifications — the
// bell feed, which is the newest 50 docs of ANY type. With ~89 leads due,
// most of today's follow_ups were never in that window, so every
// loadLeads (boot, every refresh, every tab, every device) re-created them;
// at boot the feed was often still empty when the 1.2s timer fired, which
// re-created all of them. The dedupe was a check-then-write over a list
// that could not hold the answer.
//
// Now: the doc id is deterministic — <kind>_<uid>_<leadId>_<YYYY-MM-DD,
// local> — and written with setDoc. firestore.rules makes a notification's
// identity fields immutable, so a second setDoc onto an existing id is a
// refused overwrite: create semantics, enforced by the server, across tabs
// and devices. The day's existing rows (including legacy random-id ones)
// are read ONCE per tab per day by an equality-only query (no composite
// index) so the common case writes nothing at all.
function _nbdLocalDayKey(d) {
  const x = d instanceof Date ? d : new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function _nbdNotifDocId(kind, uid, leadId, dayKey) {
  const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return safe(kind) + '_' + safe(uid) + '_' + safe(leadId) + '_' + dayKey;
}
// Deterministic ids this tab has created, or knows exist (server read / feed).
const _nbdNotifSeen = new Set();
// uid|day → Promise of the one server read of that day's rows.
const _nbdNotifDayLoads = new Map();
function _nbdSeedSeenFromFeed(uid, dayKey) {
  (window._notifications || []).forEach((n) => {
    if (n && n.leadId && n.type && n.dateKey === dayKey) _nbdNotifSeen.add(_nbdNotifDocId(n.type, uid, n.leadId, dayKey));
  });
}
function _nbdLoadDayRows(fs, db, uid, dayKey) {
  const k = uid + '|' + dayKey;
  if (!_nbdNotifDayLoads.has(k)) {
    const p = fs.getDocs(fs.query(fs.collection(db, 'notifications'),
      fs.where('userId', '==', uid), fs.where('dateKey', '==', dayKey)))
      .then((snap) => {
        snap.forEach((d) => {
          const x = (d && typeof d.data === 'function' ? d.data() : null) || {};
          if (x.leadId && x.type) _nbdNotifSeen.add(_nbdNotifDocId(x.type, uid, x.leadId, dayKey));
        });
      })
      .catch((e) => { _nbdNotifDayLoads.delete(k); throw e; });
    _nbdNotifDayLoads.set(k, p);
  }
  return _nbdNotifDayLoads.get(k);
}
// Create-once. Marks the id BEFORE the await so a second engine run in this
// tab (loadLeads fires often) skips it; another tab/device is stopped by the
// rule. A refused write (it already exists) is the expected race outcome.
async function _nbdCreateNotifOnce(fs, db, id, data) {
  if (_nbdNotifSeen.has(id)) return false;
  _nbdNotifSeen.add(id);
  try {
    await fs.setDoc(fs.doc(db, 'notifications', id), data);
    return true;
  } catch (e) {
    if (!(e && e.code === 'permission-denied')) console.warn('[notif] create skipped:', id, e && e.message);
    return false;
  }
}
function _nbdFollowUpEligible(l) {
  if (!l || !l.id || l.deleted === true) return false;
  const sk = l._stageKey || l.stage || '';
  const role = l._stageRole || (typeof window.stageRole === 'function' ? window.stageRole(sk) : 'active');
  if (role === 'won' || role === 'lost' || role === 'job') return false;
  if (/^(closed|lost|complete)$/i.test(String(sk))) return false;
  if (window.LeadSnooze && typeof window.LeadSnooze.isSnoozed === 'function' && window.LeadSnooze.isSnoozed(l)) return false;
  return true;
}
// Everything the engines need from the SDK, in one place.
function _nbdFirestoreMod() {
  return import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
}

async function checkAndCreateFollowUpNotifications(leads) {
  if (!window._user || !leads || !leads.length) return;
  // Respect the user's notif settings — if they turned the
  // "Overdue Follow-Ups" trigger off (or set mode=digest in
  // critical-only state), skip both the Firestore write AND
  // the browser Notification ping.
  // 'firestore' isn't a user-facing channel, so we just check
  // the trigger gate via 'follow_up' type with high priority.
  if (typeof window.shouldFireNotif === 'function' &&
      !window.shouldFireNotif('follow_up', null, 'high')) {
    return;
  }
  const userId = window._user.uid;
  // Stage KEYS are lowercase ('lost', 'closed') — the ['Complete','Lost']
  // name check below never matched them, so lost/won/in-production leads
  // with an old follow-up date kept generating a notice a day. Same role
  // rule as the pipeline's "Follow-ups Due"; deleted + snoozed leads too.
  leads = leads.filter(_nbdFollowUpEligible);

  const today = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  // Categorize leads
  const overdue = [];
  const dueToday = [];
  const dueTomorrow = [];

  leads.forEach(l => {
    if (!l.followUp || ['Complete','Lost'].includes(l.stage||'')) return;
    // Local day, not UTC (window.nbdFollowUpDay) — these became "Overdue"
    // notifications a day early.
    const d = (typeof window.nbdFollowUpDay === 'function') ? window.nbdFollowUpDay(l.followUp) : new Date(l.followUp); d.setHours(0,0,0,0);
    if (d < today) overdue.push(l);
    else if (d.getTime() === today.getTime()) dueToday.push(l);
    else if (d.getTime() === tomorrow.getTime()) dueTomorrow.push(l);
  });

  if (!overdue.length && !dueToday.length && !dueTomorrow.length) return;

  // One per lead per LOCAL day (toISOString of local midnight is the UTC
  // date — the previous day east of Greenwich). Deterministic ids + the
  // day's server rows; the bell feed is only an extra hint now.
  const todayKey = _nbdLocalDayKey(today);
  const _db = window._db || window.db;
  if (!_db) return;
  let fs;
  try {
    fs = await _nbdFirestoreMod();
    _nbdSeedSeenFromFeed(userId, todayKey);
    await _nbdLoadDayRows(fs, _db, userId, todayKey);
  } catch (e) {
    // Can't tell what already exists → write nothing this run (the next
    // loadLeads retries). Never guess on the side of a duplicate.
    console.warn('Follow-up notifications skipped:', e && e.message);
    return;
  }
  const _fuId = (l) => _nbdNotifDocId('follow_up', userId, l.id, todayKey);
  const existingKeys = { has: (leadId) => _nbdNotifSeen.has(_nbdNotifDocId('follow_up', userId, leadId, todayKey)) };

  // Wave 110: sanitize user-controlled fields BEFORE writing to
  // Firestore. The render path uses escHtml at display time so the
  // notification dropdown is XSS-safe today, but writing
  // unsanitized data into Firestore is a latent issue for any
  // future consumer that doesn't escape (admin panel, email
  // template, audit log, third-party integration). Sanitize at
  // write time so the data is clean at rest. Strips control
  // characters + caps length to avoid pathological inputs.
  const _sanitize = (s, max) => {
    if (typeof s !== 'string') return s;
    // Drop control characters + zero-width chars; keep newlines/tabs.
    const cleaned = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏﻿]/g, '');
    return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
  };
  const _safeName = (l) =>
    _sanitize(`${l.firstName||''} ${l.lastName||''}`.trim() || (l.address||'').split(',')[0] || 'Lead', 80);
  const _safeAddr = (l) => _sanitize((l.address||'').split(',')[0] || '', 80);
  // Label, not the raw key ("estimate_submitted") — this text lands in the bell.
  const _safeStage = (l) => _sanitize((typeof window.stageLabel === 'function' && l.stage && window.stageLabel(l.stage)) || l.stage || '', 40);
  const _safeCarrier = (l) => _sanitize(l.insCarrier || '', 40);

  const toCreate = [];

  overdue.forEach(l => {
    if (existingKeys.has(l.id)) return;
    const name = _safeName(l);
    const addr = _safeAddr(l);
    const stage = _safeStage(l);
    const daysLate = Math.round((today - ((typeof window.nbdFollowUpDay === 'function') ? window.nbdFollowUpDay(l.followUp) : new Date(l.followUp))) / 86400000);
    toCreate.push({
      userId, type: 'follow_up', leadId: l.id, dateKey: todayKey,
      title: `Overdue Follow-Up — ${name}`,
      message: `${daysLate} day${daysLate!==1?'s':''} overdue${addr ? ' · ' + addr : ''}. ${stage ? 'Stage: ' + stage : ''}`,
      priority: 'high', read: false
    });
  });

  dueToday.forEach(l => {
    if (existingKeys.has(l.id)) return;
    const name = _safeName(l);
    const addr = _safeAddr(l);
    const stage = _safeStage(l);
    const carrier = _safeCarrier(l);
    toCreate.push({
      userId, type: 'follow_up', leadId: l.id, dateKey: todayKey,
      title: `Follow-Up Today — ${name}`,
      message: `${addr ? addr + ' · ' : ''}${stage ? 'Stage: ' + stage : ''}${carrier ? ' · ' + carrier : ''}`,
      priority: 'normal', read: false
    });
  });

  dueTomorrow.forEach(l => {
    if (existingKeys.has(l.id)) return;
    const name = _safeName(l);
    const addr = _safeAddr(l);
    const stage = _safeStage(l);
    toCreate.push({
      userId, type: 'follow_up', leadId: l.id, dateKey: todayKey,
      title: `Follow-Up Tomorrow — ${name}`,
      message: `${addr ? addr + ' · ' : ''}${stage ? 'Stage: ' + stage : ''}`,
      priority: 'low', read: false
    });
  });

  if (!toCreate.length) return;

  // Write to Firestore — create-once per deterministic id.
  try {
    const results = await Promise.all(toCreate.map(n =>
      _nbdCreateNotifOnce(fs, _db, _fuId({ id: n.leadId }), {
        ...n,
        createdAt: fs.serverTimestamp()
      }).then(created => (created ? n.leadId : null))
    ));
    const createdIds = new Set(results.filter(Boolean));
    if (!createdIds.size) return;
    // The live onSnapshot already delivers new docs; only the no-listener
    // fallback needs a manual refresh.
    if (!_notifLive) await loadNotifications();

    // Browser notification if permitted AND push channel enabled in settings
    const pushAllowed = typeof window.shouldFireNotif === 'function'
      ? window.shouldFireNotif('follow_up', 'push', 'high')
      : true;
    if (pushAllowed && 'Notification' in window && Notification.permission === 'granted') {
      const overdueCount = overdue.filter(l => createdIds.has(l.id)).length;
      const todayCount = dueToday.filter(l => createdIds.has(l.id)).length;
      let body = '';
      if (overdueCount) body += `${overdueCount} overdue follow-up${overdueCount!==1?'s':''}. `;
      if (todayCount) body += `${todayCount} due today.`;
      if (body) new Notification('NBD Pro — Follow-Ups', { body: body.trim(), icon: '/favicon.ico' });
    }
  } catch(e) {
    console.error('Follow-up notification error:', e);
  }
}
window.checkAndCreateFollowUpNotifications = checkAndCreateFollowUpNotifications;

// ─────────────────────────────────────────────────────────
// Needs-field auto-notifier
// ─────────────────────────────────────────────────────────
// Walks the current lead cache and creates ONE notification per
// lead per day for any lead that:
//   - is non-terminal (not closed/lost)
//   - has been in its current stage > 1 day
//   - is missing one or more required fields for its current stage
//     (per missingRequiredFields() from crm-stages.js)
//
// Gated by the 'notifNeedsField' trigger in user settings. Dedupes
// against existing same-day notifications using the same dateKey
// pattern as checkAndCreateFollowUpNotifications.
//
// Fired alongside the follow-up check from the dashboard loadLeads
// success path (and the legacy bundle).
async function checkAndCreateNeedsFieldNotifications(leads) {
  if (!window._user || !leads || !leads.length) return;
  if (typeof window.missingRequiredFields !== 'function') return;
  // Trigger gate
  if (typeof window.shouldFireNotif === 'function' &&
      !window.shouldFireNotif('needs_field', null, 'normal')) {
    return;
  }
  const userId = window._user.uid;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayKey = _nbdLocalDayKey(today);
  const _db = window._db || window.db;
  if (!_db) return;
  // Same one-per-(lead, day) machinery as the follow-up engine above (it
  // had the same addDoc + 50-doc-feed dedupe, so the same flood shape).
  let fs;
  try {
    fs = await _nbdFirestoreMod();
    _nbdSeedSeenFromFeed(userId, todayKey);
    await _nbdLoadDayRows(fs, _db, userId, todayKey);
  } catch (e) {
    console.warn('Needs-field notifications skipped:', e && e.message);
    return;
  }

  // Existing keys: don't notify twice for the same lead today.
  // Match across both follow_up and needs_field types since the rep
  // sees the same physical card — a needs-field nudge on top of a
  // follow-up nudge for the same lead is noise.
  const existingKeys = { has: (leadId) =>
    _nbdNotifSeen.has(_nbdNotifDocId('needs_field', userId, leadId, todayKey))
    || _nbdNotifSeen.has(_nbdNotifDocId('follow_up', userId, leadId, todayKey)) };

  const FIELD_LABELS = {
    insCarrier: 'carrier', claimNumber: 'claim #', policyNumber: 'policy #',
    dateOfLoss: 'date of loss', estimateAmount: 'estimate amount',
    deductibleOrOwedByHO: 'deductible', jobValue: 'job value',
    financeCompany: 'lender', loanAmount: 'loan amount',
    scheduledDate: 'install date', jobType: 'job type',
    contractFiledAt: 'contract filed', permitFiledAt: 'permit filed',
    warrantyCertFiledAt: 'warranty cert filed', cocFiledAt: 'COC filed'
  };

  const toCreate = [];
  for (const l of leads) {
    if (!l || !l.id) continue;
    if (existingKeys.has(l.id)) continue;
    const stage = (l._stageKey || l.stage || '').toString().toLowerCase();
    if (stage === 'closed' || stage === 'lost' || stage === 'complete') continue;

    // Only nudge after a lead has been in its current stage for 1+ day.
    // Fresh moves are noisy and the rep is actively working the lead.
    if (l.stageStartedAt) {
      let stageMs = 0;
      const s = l.stageStartedAt;
      if (s && typeof s.toMillis === 'function')      stageMs = s.toMillis();
      else if (s && typeof s.toDate === 'function')   stageMs = s.toDate().getTime();
      else if (s instanceof Date)                     stageMs = s.getTime();
      else if (typeof s === 'number')                 stageMs = s;
      if (stageMs && (Date.now() - stageMs) < 24 * 60 * 60 * 1000) continue;
    }

    let missing = [];
    try { missing = window.missingRequiredFields(l) || []; } catch (_) { continue; }
    if (missing.length === 0) continue;

    const niceList = missing.map(f => FIELD_LABELS[f] || f);
    const first = niceList[0];
    const more = niceList.length - 1;
    const name = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || (l.address || '').split(',')[0] || 'Lead';
    const stageLabel = (window.STAGE_META && window.STAGE_META[stage] && window.STAGE_META[stage].label) || stage || 'current stage';

    toCreate.push({
      userId,
      type: 'needs_field',
      leadId: l.id,
      dateKey: todayKey,
      title: `Needs ${first}${more > 0 ? ` +${more}` : ''} — ${name}`,
      message: `Stuck in ${stageLabel}. Add ${niceList.join(', ')} to advance.`,
      priority: 'normal',
      read: false
    });
  }

  if (!toCreate.length) return;

  try {
    const made = await Promise.all(toCreate.map(n =>
      _nbdCreateNotifOnce(fs, _db, _nbdNotifDocId('needs_field', userId, n.leadId, todayKey), Object.assign({}, n, {
        createdAt: fs.serverTimestamp()
      }))
    ));
    if (made.some(Boolean) && !_notifLive && typeof loadNotifications === 'function') await loadNotifications();
  } catch (e) {
    console.warn('Needs-field notification error:', e && e.message);
  }
}
window.checkAndCreateNeedsFieldNotifications = checkAndCreateNeedsFieldNotifications;

// ── Server-notification persistence API for notif-bell.js ──────────
// notif-bell owns the render; when the rep marks read / dismisses a
// SERVER notification (a real Firestore `notifications` doc), it calls
// these to persist the change. Explicit doc-id arguments keep the
// writes independent of any window._notifications snapshot timing, so
// notif-bell can optimistically patch local state without racing what
// gets written. The live onSnapshot then confirms the change (or, on a
// failed write, self-corrects on the next snapshot).
async function _updateNotifDocs(ids, patch) {
  const _db = window._db || window.db;
  const list = Array.isArray(ids) ? ids.filter(Boolean) : (ids ? [ids] : []);
  if (!_db || !list.length) return;
  try {
    const { updateDoc, doc, serverTimestamp } =
      await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
    const ts = serverTimestamp();
    const stamped = Object.assign({}, patch);
    if (patch.read)      stamped.readAt = ts;
    if (patch.dismissed) stamped.dismissedAt = ts;
    await Promise.all(list.map(id =>
      updateDoc(doc(_db, 'notifications', id), stamped)
        .catch(err => console.warn('[NBDServerNotifs] write failed:', id, err && err.message))
    ));
  } catch (e) {
    console.error('[NBDServerNotifs] update error:', e && e.message);
  }
}
window.NBDServerNotifs = {
  markRead:     (id)  => _updateNotifDocs(id,  { read: true }),
  dismiss:      (id)  => _updateNotifDocs(id,  { dismissed: true, read: true }),
  restore:      (id)  => _updateNotifDocs(id,  { dismissed: false, read: false }),
  markReadMany: (ids) => _updateNotifDocs(ids, { read: true }),
  dismissMany:  (ids) => _updateNotifDocs(ids, { dismissed: true, read: true }),
};

// ═══════════════════════════════════════════════════════════
// Auto-log communications from tel:/sms:/mailto: clicks
// ═══════════════════════════════════════════════════════════
// Critical Finding: "Communication not auto-logged — trust/memory hole."
// customer.html already logs on its own Call/Text/Email buttons, but
// every other surface (pipeline kanban cards, contact drawer rows,
// map popups, dashboard quick-contacts) just renders a plain
// <a href="tel:..."> with no logging. Reps tap those daily and nothing
// hits the timeline, so weeks later nobody can remember whether the
// customer was actually contacted.
//
// This delegated click handler catches EVERY tel:/sms:/mailto: anchor
// anywhere on the authed app and posts a lightweight `communications`
// doc if we can resolve a leadId from the surrounding DOM context.
// It deliberately doesn't block navigation — the protocol handler fires
// as normal; we just fire-and-forget the Firestore write alongside.
(function setupCommLogDelegate() {
  if (__NBD_COMM_LOG_DELEGATE) return;
  __NBD_COMM_LOG_DELEGATE = true;

  function resolveLeadId(anchor) {
    // Walk up from the clicked anchor looking for a data-lead-id,
    // data-id on a pipeline card, or the globally-current customer.
    let el = anchor;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.leadId) return el.dataset.leadId;
      if (el.dataset && el.dataset.id && el.classList && el.classList.contains('kc-card')) return el.dataset.id;
      el = el.parentElement;
    }
    return window._customerId || window._cardDetailLeadId || null;
  }

  function typeFromHref(href) {
    if (!href) return null;
    if (href.startsWith('tel:'))    return 'call';
    if (href.startsWith('sms:'))    return 'sms';
    if (href.startsWith('mailto:')) return 'email';
    return null;
  }

  document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const type = typeFromHref(a.getAttribute('href') || '');
    if (!type) return;
    const leadId = resolveLeadId(a);
    if (!leadId) return;
    // Skip if this anchor opted out (flag = data-nbd-log-skip="1").
    // Two cases: it already has a dedicated handler that logs (so we'd
    // duplicate), OR it isn't a customer contact at all — customer.html's
    // Contact panel dials the contractor's own number, and logging that as
    // an outbound customer call is how the timeline used to fill with
    // conversations that never happened.
    if (a.dataset && a.dataset.nbdLogSkip === '1') return;

    try {
      const uid = (window._user && window._user.uid) || null;
      if (!uid || !_db || !_addDoc || !_serverTimestamp) return;
      const descByType = { call: 'Tapped call link', sms: 'Tapped SMS link', email: 'Tapped email link' };
      _addDoc(col(_db, 'communications'), {
        leadId, userId: uid, type,
        direction: 'outbound',
        content: descByType[type] || 'Contacted customer',
        timestamp: _serverTimestamp(),
        source: 'crm_link_click'
      }).catch(err => console.warn('[comm-log] write failed:', err.message));
    } catch (err) {
      // Never break navigation because of a logging hiccup.
      console.warn('[comm-log] delegate threw:', err.message);
    }
  }, true);  // capture-phase so we fire before any stopPropagation handlers
})();

// Request browser notification permission.
// Must be called from a user-gesture handler (click/tap) per Chrome 80+,
// Firefox 72+, and Safari. Calling on page load gets silently denied on
// every modern browser and poisons the permission state until the user
// manually resets it. We now defer until the user clicks "Enable
// notifications" — wired via enableNotifCTA below.
async function requestNotifPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch (e) {
    console.warn('[notif] permission request threw:', e);
    return 'denied';
  }
}
// Attach to any element tagged data-action="enable-notifications" so the
// call happens inside the click handler. Safe to call multiple times.
window.addEventListener('click', (e) => {
  const el = e.target && e.target.closest && e.target.closest('[data-action="enable-notifications"]');
  if (!el) return;
  requestNotifPermission().then(state => {
    if (typeof showToast === 'function') {
      if (state === 'granted') showToast('Notifications enabled', 'success');
      else if (state === 'denied') showToast('Notifications blocked — check browser settings', 'error');
    }
  });
});
// ══ END FOLLOW-UP NOTIFICATION ENGINE ═════════════════════════════════

// Load notifications on auth - poll for window._user set by main auth callback
let _notifInterval = null;

// Whether a live onSnapshot subscription is currently delivering. When it is,
// the poll is stopped: re-running loadNotifications only unsubscribes and
// re-subscribes, re-reading the whole query for data the listener already
// pushed. The poll exists purely as the fallback for the two states where
// there is no live listener — an SDK without onSnapshot, and a listener that
// errored — and both of those turn it back on.
let _notifLive = false;

function _startNotifPoll() {
  if (_notifInterval || _notifLive) return;   // a live listener needs no poll
  _notifInterval = setInterval(loadNotifications, 120000);
}
function _stopNotifPoll() {
  if (!_notifInterval) return;
  clearInterval(_notifInterval);
  _notifInterval = null;
}

(function waitForNotifAuth() {
  if (window._user) {
    // Start the poll first; loadNotifications stops it the moment a live
    // subscription is established, so a failure to reach that point still
    // leaves the badge refreshing.
    _startNotifPoll();
    loadNotifications();
  } else {
    setTimeout(waitForNotifAuth, 300);
  }
})();

// Wave 103: tear down the notification poll on sign-out + on
// pagehide so a re-auth as a different user doesn't leak the
// previous user's interval. Without this, every sign-out left the
// 2-min poll running with a now-stale auth context — calls would
// briefly hit `window._user` from the previous session before the
// auth state propagation cleared it. The onSnapshot listener was
// already torn down via _notifUnsub; the polling fallback
// was the asymmetric leak.
window.addEventListener('nbd:auth-signed-out', () => {
  _stopNotifPoll();
  _notifLive = false;   // next sign-in re-arms the poll until a listener lands
  if (typeof _notifUnsub === 'function') {
    try { _notifUnsub(); } catch(_) {}
    _notifUnsub = null;
  }
});
window.addEventListener('pagehide', () => {
  _stopNotifPoll();
});
