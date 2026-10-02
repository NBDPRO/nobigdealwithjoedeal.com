/**
 * notif-bell.js — Wave 13 (Notification Bell)
 *
 * The dashboard.html header has had a notification bell UI sitting
 * unwired since the kanban refactor: a button with an empty badge,
 * a dropdown panel, "Mark all read" / "Clear all" buttons that
 * referenced functions that didn't exist. This module wires it all
 * up using the in-memory data already loaded by tasks.js and the
 * estimates loader in dashboard.html.
 *
 * Sources of truth:
 *   - Overdue tasks       — window._taskCache (loaded by tasks.js)
 *   - Tasks due today     — window._taskCache
 *   - Stale estimates     — window._estimates (sent ≥3 days ago, no
 *                           viewedAt or no respondedAt)
 *   - Stale active leads  — window._leads at contacted/inspected
 *                           stages with no activity in 7+ days
 *
 * Dismissed state persists in localStorage keyed by item ID, so a
 * rep doesn't see the same nag twice.
 *
 * Re-renders on:
 *   - Module init (after auth)
 *   - 60-second polling interval
 *   - Custom 'nbd:data-refreshed' event (dashboard fires this after
 *     loadLeads / loadEstimates / loadAllTasks)
 *
 * Exposes:
 *   __NBD_CALL_REGISTRY.toggleNotificationDropdown — _NBD_TOGGLE_FNS
 *     'notifications' dispatch via _nbdResolveMapped (registry-only,
 *     Tranche 3 2026-09-02; same for .toggleDismissedNotifications)
 *   window.markAllNotificationsRead()
 *   window.clearAllNotifications()
 *   NotifBell.render()        — force re-render
 *   NotifBell.getCount()      — current badge count
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['notif-bell']) return;
  __NBD_LOADED['notif-bell'] = true;

  // ─── Constants ───────────────────────────────────────────────────
  const STALE_ESTIMATE_DAYS = 3;
  const STALE_LEAD_DAYS = 7;
  const ACTIVE_LEAD_STAGES = new Set(['contacted', 'inspected', 'estimate_sent_cash', 'negotiating']);
  const DISMISS_KEY = 'nbd_notif_dismissed_v1';
  const READ_KEY    = 'nbd_notif_read_v1';

  // ─── Dismissed / read state (localStorage) ───────────────────────
  function _readSet(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (e) { return new Set(); }
  }
  function _writeSet(key, set) {
    try {
      // Cap at 500 entries to bound storage growth.
      const arr = Array.from(set).slice(-500);
      localStorage.setItem(key, JSON.stringify(arr));
    } catch (e) { /* quota / private mode — silent */ }
  }
  let dismissed = _readSet(DISMISS_KEY);
  let read      = _readSet(READ_KEY);

  function isDismissed(id) { return dismissed.has(id); }
  function isRead(id)      { return read.has(id); }
  function dismiss(id)     { dismissed.add(id); _writeSet(DISMISS_KEY, dismissed); /* W108: cache invalidation runs at top via invalidateNotifCache when needed; the read/dismissed sets are cheap and the cache holds the unfiltered build, so cache-stale-but-set-fresh is fine. */ }
  function markRead(id)    { read.add(id);      _writeSet(READ_KEY, read); }

  // ─── Helpers ─────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function leadName(lead) {
    if (!lead) return 'Unknown';
    const n = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
    return n || lead.address || 'Unnamed lead';
  }

  function relativeTime(date) {
    if (!date) return '';
    const ms = Date.now() - date.getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.floor(hr / 24);
    if (d < 7) return `${d}d ago`;
    const w = Math.floor(d / 7);
    return `${w}w ago`;
  }

  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return v;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.toMillis === 'function') return new Date(v.toMillis());
    if (typeof v === 'number') return new Date(v);
    if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? null : d; }
    return null;
  }

  // ─── Server-notification bridge (2026-07-07 single-owner merge) ───
  // Before this, two systems drove the same bell: notif-bell (derived
  // in-memory nags, localStorage read/dismiss) and crm-snooze (the
  // Firestore `notifications` feed — portal / referral / deal-accept /
  // remote-sign / follow-up engine writes). notif-bell won both window
  // bindings (loads last) but never read the Firestore feed, so every
  // server-written notification was invisible AND unclearable.
  //
  // Fix: notif-bell is the single renderer and now UNIONs the two
  // sources. crm-snooze hydrates the full feed (incl. dismissed) into
  // window._notifications and fires 'nbd:notifs-updated'; notif-bell
  // adapts each doc into an item and routes its read/dismiss/clear back
  // to Firestore via window.NBDServerNotifs (see crm-snooze.js).
  //
  // State lives in two places by source:
  //   - derived items  → localStorage Sets (isRead/isDismissed by id)
  //   - server items   → the Firestore doc's read/dismissed fields,
  //                      mirrored on the adapted item as _read/_dismissed
  // so itemIsRead/itemIsDismissed dispatch on n._source below.
  const SERVER_NOTIF_ICONS = {
    follow_up: '📅', needs_field: '📝', task_due: '⏰', task_overdue: '🔴',
    estimate_approved: '✅', estimate_viewed: '👀', review_request: '⭐',
    stage_change: '🔄', new_lead: '👤', referral_received: '🎁',
    deal_accepted: '🎉', remote_signature: '✍️', homeowner_upload: '📎',
    callback_request: '📞', homeowner_callback: '📞', customer_rating: '⭐',
    portal_message_in: '💬', portal_message: '💬', portal_message_out: '💬',
    agent_inbox: '🤖', call_watch: '📞',
  };
  function serverIcon(type) { return SERVER_NOTIF_ICONS[type] || '🔔'; }
  function serverSeverity(n) {
    const p = String(n && n.priority || '').toLowerCase();
    if (p === 'high') return 'high';
    if (p === 'low')  return 'low';
    return 'medium';
  }
  // Adapt one Firestore notification doc → notif-bell item shape.
  // Returns null for malformed docs. Demo/placeholder leadIds (d-…)
  // are treated as "no lead" (matching crm-snooze) so we don't render
  // dead action buttons / lead links that resolve nowhere.
  function adaptServerNotif(n) {
    if (!n || !n.id) return null;
    const leadOk = n.leadId && !String(n.leadId).startsWith('d-');
    const ts = toDate(n.createdAt);
    return {
      id:         'server:' + n.id,
      _source:    'server',
      _docId:     n.id,
      _read:      !!n.read,
      _dismissed: !!n.dismissed,
      leadId:     leadOk ? n.leadId : null,
      type:       n.type || 'default',
      severity:   serverSeverity(n),
      icon:       serverIcon(n.type),
      title:      n.title || 'Notification',
      text:       n.message || '',
      sub:        ts ? relativeTime(ts) : '',
      ts:         ts,
      // The bot team's filings open the Agent inbox (agent-inbox.js).
      // The every-2-hours call check opens the Call Center (call-watch.js).
      href:       n.type === 'agent_inbox' ? '/pro/dashboard.html?agentInbox=1'
        : n.type === 'call_watch' ? '/pro/dashboard.html#/calls'
        : (leadOk ? `/pro/dashboard.html?tab=crm&lead=${encodeURIComponent(n.leadId)}` : null),
    };
  }
  // Optimistically patch the underlying Firestore doc object in
  // window._notifications so the next re-render reflects the mutation
  // immediately. crm-snooze's onSnapshot replaces the whole array with
  // server truth shortly after, which confirms (or, on write failure,
  // self-corrects) the optimistic state.
  function _patchServerDoc(docId, patch) {
    const arr = window._notifications;
    if (!Array.isArray(arr)) return;
    const d = arr.find(x => x && x.id === docId);
    if (d) Object.assign(d, patch);
  }

  // ─── Source-aware read / dismissed predicates ────────────────────
  function itemIsRead(n)      { return n._source === 'server' ? !!n._read      : isRead(n.id); }
  function itemIsDismissed(n) { return n._source === 'server' ? !!n._dismissed : isDismissed(n.id); }

  // ─── Source-aware mutations ──────────────────────────────────────
  function markReadItem(n) {
    if (n._source === 'server') {
      _patchServerDoc(n._docId, { read: true });
      invalidateNotifCache();
      if (window.NBDServerNotifs && typeof window.NBDServerNotifs.markRead === 'function') {
        Promise.resolve(window.NBDServerNotifs.markRead(n._docId)).catch(() => {});
      }
    } else {
      markRead(n.id);
    }
  }
  function dismissItem(n) {
    if (n._source === 'server') {
      _patchServerDoc(n._docId, { dismissed: true, read: true });
      invalidateNotifCache();
      if (window.NBDServerNotifs && typeof window.NBDServerNotifs.dismiss === 'function') {
        Promise.resolve(window.NBDServerNotifs.dismiss(n._docId)).catch(() => {});
      }
    } else {
      dismiss(n.id);
    }
  }

  // ─── Aggregation: build the notification list from in-memory data ─
  // Wave 108: cache the result of buildNotifications() for a short
  // window so handleClick/markAllRead/clearAll don't re-iterate the
  // entire leads + tasks + estimates space twice per click. Cache
  // invalidates on:
  //   - 'nbd:data-refreshed' (W14 pattern — the data underneath
  //     just changed, so the previous result is stale)
  //   - 'focus' (rep tabbed back, want a fresh check)
  //   - explicit dismiss/snooze/mark-read calls below
  // 5s TTL is the safety net so a rep clicking around for many
  // seconds doesn't see a frozen list.
  let _notifCache = null;
  let _notifCacheStamp = 0;
  function invalidateNotifCache() {
    _notifCache = null;
    _notifCacheStamp = 0;
  }
  window.addEventListener('nbd:data-refreshed', invalidateNotifCache);
  window.addEventListener('focus', invalidateNotifCache);

  function buildNotificationsCached() {
    if (_notifCache && (Date.now() - _notifCacheStamp) < 5_000) {
      return _notifCache;
    }
    _notifCache = _buildNotificationsImpl();
    _notifCacheStamp = Date.now();
    return _notifCache;
  }
  // Keep the public name as buildNotifications() so existing call
  // sites stay unchanged. Rename the original to _buildNotificationsImpl.
  function buildNotifications() {
    return buildNotificationsCached();
  }

  function _buildNotificationsImpl() {
    const now = new Date();
    const sod = new Date(); sod.setHours(0, 0, 0, 0);
    const eod = new Date(); eod.setHours(23, 59, 59, 999);
    const items = [];
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const taskCache = window._taskCache || {};
    const estimates = Array.isArray(window._estimates) ? window._estimates : [];

    // ── Overdue + due-today tasks ──
    // Wave 35: skip task signals on snoozed leads — the rep
    // explicitly deferred this lead, no point pinging them about
    // its tasks until the snooze expires.
    leads.forEach(lead => {
      if (window.LeadSnooze && window.LeadSnooze.isSnoozed(lead)) return;
      const tasks = taskCache[lead.id] || [];
      tasks.forEach(t => {
        if (t.done) return;
        const due = t.dueDate ? new Date(t.dueDate + 'T23:59:59') : null;
        if (!due) return;
        if (due > eod) return;
        const isOverdue = due < sod;
        const id = `task:${lead.id}:${t.id}`;
        items.push({
          id,
          // Wave 82: leadId is the gate for the W48/W68/W76 inline
          // action-row block in renderItem (`if (n.leadId && ...)`).
          // Every push-shape that ties to a real lead MUST include
          // leadId or the action buttons silently won't render —
          // a regression that hid the share/preview/snooze trio
          // on every bell row from W48 onward until this fix.
          leadId:  lead.id,
          type:    isOverdue ? 'overdue-task' : 'task-today',
          severity: isOverdue ? 'high' : 'medium',
          icon:    isOverdue ? '🔴' : '⏰',
          title:   isOverdue ? 'Overdue task' : 'Task due today',
          text:    `"${t.text}"`,
          sub:     leadName(lead),
          ts:      due,
          href:    `/pro/dashboard.html?tab=crm&lead=${encodeURIComponent(lead.id)}`,
          onClick: () => window.openTaskModal && window.openTaskModal(lead.id, null),
        });
      });
    });

    // ── Storm / insurance jobs with no date of loss (dol-fill.js, 2026-10-02) ──
    // One quiet row with the count; tapping it opens "Fill dates of loss".
    // The id carries the count, so a dismissed row comes back only when the
    // number changes.
    if (window.NBDDolFill && typeof window.NBDDolFill.needsDol === 'function') {
      const missing = leads.filter(window.NBDDolFill.needsDol).length;
      if (missing) {
        items.push({
          id: 'dol-missing:' + missing,
          type: 'dol-missing',
          severity: 'low',
          icon: '🌩',
          title: 'Dates of loss missing',
          text: missing + ' storm / insurance job' + (missing === 1 ? ' has' : 's have') + ' no date of loss — tap to fill from storm reports',
          sub: '',
          ts: sod,
          href: null,
          onClick: () => window.NBDDolFill.open(),
        });
      }
    }

    // ── Stale estimates (sent but no response) ──
    const staleCutoff = new Date(now.getTime() - STALE_ESTIMATE_DAYS * 24 * 60 * 60 * 1000);
    estimates.forEach(est => {
      const status = (est.status || '').toLowerCase();
      // Skip estimates the customer already responded to.
      if (status === 'signed' || status === 'rejected' || status === 'expired') return;
      if (est.respondedAt) return;
      // A never-sent draft isn't "awaiting reply" — same draft test as the
      // Estimates page (estimate-analytics.js). The createdAt fallback below
      // stays for legacy sent docs that predate sentAt stamping.
      // "Sent" evidence: sentAt, an e-sign send (signatureStatus /
      // signatureSentAt, functions/integrations/esign.js) or a homeowner view.
      const _wasSent = est.sentAt || est.signatureSentAt || est.viewedAt
        || (est.signatureStatus && est.signatureStatus !== 'none');
      if ((status === '' || status === 'draft') && !_wasSent) return;
      const sentAt = toDate(est.sentAt) || toDate(est.signatureSentAt) || toDate(est.createdAt);
      if (!sentAt || sentAt > staleCutoff) return;
      const lead = leads.find(l => l.id === est.leadId);
      const id = `estimate:${est.id}`;
      items.push({
        id,
        // W82: estimate items also need leadId so the rep can hit
        // 📞 / 💬 / 📧 / 🔍 / 💤 inline on a stale-estimate alert.
        // Use est.leadId directly (always set on estimate docs)
        // even if `lead` resolution failed in the cache.
        leadId:  est.leadId,
        type:    'stale-estimate',
        severity: 'medium',
        icon:    '📄',
        title:   est.viewedAt ? 'Estimate viewed, no response' : 'Estimate awaiting reply',
        // grandTotal first — estimates store it there, so this read "$0 estimate".
        text:    `$${Number(est.grandTotal || est.total || est.amount || 0).toLocaleString()} estimate`,
        sub:     leadName(lead) + ' · sent ' + relativeTime(sentAt),
        ts:      sentAt,
        href:    `/pro/dashboard.html?tab=estimates&est=${encodeURIComponent(est.id)}`,
      });
    });

    // ── Stale active leads (no activity in 7+ days) ──
    const leadStaleCutoff = new Date(now.getTime() - STALE_LEAD_DAYS * 24 * 60 * 60 * 1000);
    leads.forEach(lead => {
      // Wave 35: skip stale-stage signal on snoozed leads.
      if (window.LeadSnooze && window.LeadSnooze.isSnoozed(lead)) return;
      const stage = (lead.stage || '').toLowerCase();
      if (!ACTIVE_LEAD_STAGES.has(stage)) return;
      const lastActivity = toDate(lead.updatedAt) || toDate(lead.createdAt);
      if (!lastActivity || lastActivity > leadStaleCutoff) return;
      const id = `stale-lead:${lead.id}`;
      items.push({
        id,
        leadId:  lead.id, // W82: gate for the W48/W68 action row
        type:    'stale-lead',
        severity: 'low',
        icon:    '💤',
        title:   `Lead going cold (${stage.replace(/_/g, ' ')})`,
        text:    leadName(lead),
        sub:     'No activity in ' + relativeTime(lastActivity),
        ts:      lastActivity,
        href:    `/pro/dashboard.html?tab=crm&lead=${encodeURIComponent(lead.id)}`,
      });
    });

    // ── Wave 76: snooze-expired signal ──
    // Closes the W35 snooze lifecycle loop. When a snooze expires,
    // the W35 filter starts treating the lead as "active" again
    // but no proactive signal fires — the rep has to remember to
    // check the kanban. This signal raises a "Lead came back from
    // snooze" notification within the SNOOZE_EXPIRY_WINDOW (3
    // days post-expiry) so the rep gets a passive heads-up.
    //
    // After 3 days the signal self-clears; if the rep takes no
    // action by then it'll show up via the existing stale-lead
    // signal instead.
    const SNOOZE_EXPIRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
    leads.forEach(lead => {
      if (!lead || !lead.snoozedUntil) return;
      // Skip leads still snoozed (W35 isSnoozed handles the cutoff).
      if (window.LeadSnooze && window.LeadSnooze.isSnoozed(lead)) return;
      const expired = toDate(lead.snoozedUntil);
      if (!expired) return;
      const sinceExpiryMs = now.getTime() - expired.getTime();
      // Only signal during the post-expiry window. After that
      // the stale-lead signal takes over.
      if (sinceExpiryMs <= 0 || sinceExpiryMs > SNOOZE_EXPIRY_WINDOW_MS) return;
      // Skip terminal stages — already done, no action needed.
      const stage = (lead.stage || '').toLowerCase();
      if (stage === 'closed' || stage === 'lost' || stage === 'complete') return;

      const reason = (typeof lead.snoozedReason === 'string' && lead.snoozedReason.trim())
        ? lead.snoozedReason.trim()
        : '';
      const id = `snooze-expired:${lead.id}`;
      items.push({
        id,
        leadId:   lead.id, // W82: gate for the W48/W68 action row
        type:     'snooze-expired',
        severity: 'medium',
        icon:     '⏰',
        title:    'Snooze expired — lead is back',
        text:     leadName(lead),
        // Subtitle: either "Was: Insurance · 2d ago" or just "2d ago"
        sub:      (reason ? `Was: ${reason} · ` : '') + relativeTime(expired),
        ts:       expired,
        href:     `/pro/customer.html?id=${encodeURIComponent(lead.id)}`,
      });
    });

    // ── Wave 95: fresh-viewing engagement signal ──
    // Closes the engagement loop. W76 fires when a snooze
    // expires; W95 fires when a customer actively views the
    // portal in the last 6 hours. The rep gets a heads-up
    // RIGHT when the customer is engaged and most likely to
    // pick up the phone.
    //
    // Self-clearing 6-hour window so the bell doesn't accumulate
    // every view in history. After 6h, the W92 viewed badge on
    // the kanban card still shows the engagement state for
    // long-tail context — the bell signal is just for the
    // fresh-window action prompt.
    //
    // Skipped when:
    //   - Estimate already responded (signed/declined)
    //   - Lead in terminal stage
    //   - No estimates at all
    const FRESH_VIEW_WINDOW_MS = 6 * 60 * 60 * 1000;
    estimates.forEach(est => {
      if (!est || est.respondedAt) return;
      const viewedAt = toDate(est.viewedAt);
      if (!viewedAt) return;
      const ageMs = now.getTime() - viewedAt.getTime();
      if (ageMs <= 0 || ageMs > FRESH_VIEW_WINDOW_MS) return;
      // Resolve the parent lead. Skip when terminal stage —
      // a "viewing your estimate" signal on a closed deal is
      // just noise.
      const lead = leads.find(l => l && l.id === est.leadId);
      if (!lead) return;
      const stage = (lead.stage || '').toLowerCase();
      if (stage === 'closed' || stage === 'lost' || stage === 'complete') return;

      const amount = Number(est.total || est.grandTotal || est.amount || 0);
      const id = `fresh-view:${est.id}`;
      items.push({
        id,
        leadId:   lead.id, // W82: gate for the W48/W68 action row
        type:     'fresh-view',
        // High severity so the rep sees this BEFORE stale
        // signals — the customer is engaged right now.
        severity: 'high',
        icon:     '🔥',
        title:    'Customer viewing your estimate',
        text:     leadName(lead),
        sub:      (amount > 0 ? `$${amount.toLocaleString()} · ` : '') + 'opened ' + relativeTime(viewedAt),
        ts:       viewedAt,
        href:     `/pro/customer.html?id=${encodeURIComponent(lead.id)}`,
      });
    });

    // ── Portal-open fresh-viewing signal (2026-09-16) ──
    // estimate.viewedAt only fires from the standalone estimate-view.html
    // link. A homeowner who opens the MAIN portal instead (functions/
    // portal.js's getHomeownerPortalView, which stamps lead.lastPortalOpenAt
    // on a genuine open — same signal customer-viewed-chip.js and
    // customer-engagement-score.js were extended to read) never lit this
    // bell before, even though it is the same "customer is engaged right
    // now" moment the estimate-view signal above exists to catch.
    // Skips a lead that already got a fresh-view item above from an
    // estimate view — one bell per lead per fresh window, not one per
    // signal source, and the estimate-specific item is the more precise one
    // to show when both fired.
    const freshViewLeadIds = new Set(
      items.filter(it => it.type === 'fresh-view').map(it => it.leadId)
    );
    leads.forEach(lead => {
      if (!lead || freshViewLeadIds.has(lead.id)) return;
      const stage = (lead.stage || '').toLowerCase();
      if (stage === 'closed' || stage === 'lost' || stage === 'complete') return;
      // Same "already responded" skip as the estimate loop above — a portal
      // open after the customer already signed/declined is stale, not a
      // fresh engagement cue.
      if (estimates.some(e => e && e.leadId === lead.id && e.respondedAt)) return;
      const openedAt = toDate(lead.lastPortalOpenAt);
      if (!openedAt) return;
      const ageMs = now.getTime() - openedAt.getTime();
      if (ageMs <= 0 || ageMs > FRESH_VIEW_WINDOW_MS) return;
      items.push({
        id:       `fresh-view:portal:${lead.id}`,
        leadId:   lead.id,
        type:     'fresh-view',
        severity: 'high',
        icon:     '🔥',
        title:    'Customer viewing your portal',
        text:     leadName(lead),
        sub:      'opened ' + relativeTime(openedAt),
        ts:       openedAt,
        href:     `/pro/customer.html?id=${encodeURIComponent(lead.id)}`,
      });
    });

    // ── Server-persisted notifications (2026-07-07 single-owner merge) ──
    // Union the Firestore `notifications` feed (hydrated into
    // window._notifications by crm-snooze.js) into the derived list.
    // Adapted items carry _source:'server' + _docId so the render/
    // read/dismiss paths route their state back to Firestore. Dismissed
    // docs are kept (they surface in the dismissed drawer, not the
    // active list). This is the fix for server notifications being
    // invisible + unclearable — they now appear and clear.
    const serverNotifs = Array.isArray(window._notifications) ? window._notifications : [];
    serverNotifs.forEach(sn => {
      const it = adaptServerNotif(sn);
      if (it) items.push(it);
    });

    // ── Same-lead dedupe: follow_up vs derived overdue/stale (2026-07-07) ──
    // A lead with an active (non-dismissed) server `follow_up` notice
    // ("Overdue Follow-Up — Name", written by crm-snooze's engine) already
    // tells the rep "this lead is overdue, go work it". The DERIVED
    // overdue-task / task-today / stale-lead rows for that SAME lead say
    // the same thing from a different data source, so showing both is the
    // bell-doubling noise. Drop the derived rows and keep the server one —
    // it's the clearable, persistent nudge, and clicking it lands the rep
    // on the lead where the specific tasks live.
    //
    // Deliberately NOT suppressed: fresh-view (customer engaged right now),
    // snooze-expired (state transition), stale-estimate (estimate-specific)
    // — distinct, non-redundant signals. Dedupe only keys off follow_up
    // (not needs_field, which names the exact missing fields).
    const followUpLeadIds = new Set(
      items
        .filter(it => it._source === 'server' && it.type === 'follow_up' && !it._dismissed && it.leadId)
        .map(it => it.leadId)
    );
    if (followUpLeadIds.size) {
      const REDUNDANT_WITH_FOLLOWUP = new Set(['overdue-task', 'task-today', 'stale-lead']);
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it._source !== 'server'
            && REDUNDANT_WITH_FOLLOWUP.has(it.type)
            && it.leadId && followUpLeadIds.has(it.leadId)) {
          items.splice(i, 1);
        }
      }
    }

    // Wave 138: enrich each item with the lead's W135 unified score
    // before sorting. Items tied to a leadId inherit that lead's
    // score so the bell tracks the same priority signal as the
    // kanban badge (W136), customer-page panel (W137), and Cmd+K
    // (W138). Items without a leadId (e.g. global system messages)
    // get score 0 and fall to the bottom within their severity tier.
    const _scoreCache = new Map();
    function _scoreFor(leadId) {
      if (!leadId) return 0;
      if (_scoreCache.has(leadId)) return _scoreCache.get(leadId);
      let s = 0;
      try {
        const lead = (window._leads || []).find(l => l && l.id === leadId);
        if (lead && window.NBDLeadScore && window.NBDLeadScore.score) {
          s = window.NBDLeadScore.score(lead) || 0;
        }
      } catch (_) {}
      _scoreCache.set(leadId, s);
      return s;
    }
    items.forEach(it => { it._leadScore = _scoreFor(it.leadId); });

    // Sort: severity first (high → medium → low), then by W135 lead
    // score descending, then most recent ts first as final
    // tiebreaker. This means a 'medium'-severity bell row tied to
    // a 🔥 Hot lead doesn't outrank a 'high'-severity row, but two
    // medium rows are now ordered by which lead the rep should
    // actually call first.
    const sevOrder = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => {
      const s = (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3);
      if (s !== 0) return s;
      const sc = (b._leadScore || 0) - (a._leadScore || 0);
      if (sc !== 0) return sc;
      return (b.ts?.getTime?.() || 0) - (a.ts?.getTime?.() || 0);
    });
    return items;
  }

  // ─── Render ──────────────────────────────────────────────────────
  function render() {
    const list      = document.getElementById('notifList');
    const dismissedList = document.getElementById('notifDismissedList');
    const dismissedToggle = document.getElementById('notifDismissedToggle');
    const dismissedCount = document.getElementById('dismissedCount');
    const badge     = document.getElementById('notifBadge');
    const clearBtn  = document.getElementById('clearAllNotifBtn');
    if (!list || !badge) return;

    const all = buildNotifications();
    const active    = all.filter(n => !itemIsDismissed(n));
    const dismissedItems = all.filter(n =>  itemIsDismissed(n));
    const unread    = active.filter(n => !itemIsRead(n));

    // Badge — only un-read, un-dismissed items count.
    if (unread.length > 0) {
      badge.style.display = 'block';
      badge.textContent = unread.length > 99 ? '99+' : String(unread.length);
    } else {
      badge.style.display = 'none';
    }

    // Active list — canonical empty-state pattern (.nbd-empty).
    if (active.length === 0) {
      list.innerHTML = `
        <div class="nbd-empty" style="padding:32px 20px;">
          <div class="ne-icon">✓</div>
          <div class="ne-msg">All caught up</div>
          <div class="ne-sub">No pending alerts.</div>
        </div>`;
    } else {
      list.innerHTML = active.map(n => renderItem(n)).join('');
    }

    // Dismissed toggle
    if (dismissedItems.length > 0) {
      if (dismissedToggle) dismissedToggle.style.display = 'block';
      if (dismissedCount)  dismissedCount.textContent = `(${dismissedItems.length})`;
      if (dismissedList)   dismissedList.innerHTML = dismissedItems.map(n => renderItem(n, true)).join('');
    } else {
      if (dismissedToggle) dismissedToggle.style.display = 'none';
      if (dismissedList)   dismissedList.innerHTML = '';
    }

    if (clearBtn) clearBtn.style.display = active.length > 0 ? '' : 'none';
  }

  function renderItem(n, isDismissedView) {
    const sevColor = n.severity === 'high'   ? 'var(--red)'
                   : n.severity === 'medium' ? 'var(--gold)'
                                             : 'var(--m)';
    const opacity = (isDismissedView || itemIsRead(n)) ? '0.55' : '1';

    // Wave 48: inline reshare buttons. Mirrors the W46/W47 pattern
    // from Almost There + Hot Leads: a notification about a lead
    // with phone/email gets one-tap Call/Text/Email actions next
    // to the dismiss button. Only renders for leads that exist in
    // the in-memory cache (otherwise we can't resolve the contact
    // info). stopPropagation on each so an action click doesn't
    // ALSO fire the row's _handleClick navigation.
    let actionButtonsHTML = '';
    if (n.leadId && Array.isArray(window._leads)) {
      const lead = window._leads.find(l => l && l.id === n.leadId);
      if (lead) {
        const phoneDigits = String(lead.phone || '').replace(/\D+/g, '');
        const email = String(lead.email || '').trim();
        const buttons = [];
        if (phoneDigits) {
          buttons.push(`
            <a class="notif-action" href="tel:${escapeHtml(phoneDigits)}"
              title="Call ${escapeHtml(lead.phone)}"
              style="
                display:flex; align-items:center; justify-content:center;
                width:26px; height:26px; border-radius:5px;
                background:color-mix(in srgb, var(--green) 14%, transparent); color:var(--green);
                text-decoration:none; font-size:12px;
                -webkit-tap-highlight-color:transparent;
                transition:transform var(--t-fast);"
              data-nb-stop-self="1"
            >📞</a>`);
          buttons.push(`
            <button class="notif-action" type="button"
              title="Text portal link to ${escapeHtml(lead.phone)}"
              style="
                display:flex; align-items:center; justify-content:center;
                width:26px; height:26px; border-radius:5px;
                background:color-mix(in srgb, var(--blue) 14%, transparent); color:var(--blue);
                border:none; font-size:12px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                transition:transform var(--t-fast);"
              data-nb-action="actionSms" data-nb-id="${escapeHtml(lead.id)}" data-nb-stop="1"
            >💬</button>`);
        }
        if (email) {
          buttons.push(`
            <button class="notif-action" type="button"
              title="Email portal link to ${escapeHtml(email)}"
              style="
                display:flex; align-items:center; justify-content:center;
                width:26px; height:26px; border-radius:5px;
                background:color-mix(in srgb, var(--purple) 14%, transparent); color:var(--purple);
                border:none; font-size:12px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                transition:transform var(--t-fast);"
              data-nb-action="actionEmail" data-nb-id="${escapeHtml(lead.id)}" data-nb-stop="1"
            >📧</button>`);
        }
        // Wave 68: portal preview action — always available, no
        // contact gate. Brings the bell to feature parity with the
        // home widgets (W64/W65/W66) and cmd+K (W63). Especially
        // valuable here: a bell alert means "the customer just did
        // X" — before responding, the rep peeks at the portal to
        // see exactly what state the customer is looking at.
        if (window.PortalLinkHelpers
            && typeof window.PortalLinkHelpers.previewForLead === 'function') {
          buttons.push(`
            <button class="notif-action" type="button"
              title="Preview the portal — see what the customer just saw"
              style="
                display:flex; align-items:center; justify-content:center;
                width:26px; height:26px; border-radius:5px;
                background:color-mix(in srgb, var(--gold) 14%, transparent); color:var(--gold);
                border:none; font-size:12px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                transition:transform var(--t-fast);"
              data-nb-action="actionPreview" data-nb-id="${escapeHtml(lead.id)}" data-nb-stop="1"
            >🔍</button>`);
        }
        // Wave 68: state-aware snooze/unsnooze. Bell rows can
        // show customer-side alerts even on snoozed leads (the
        // line-123 / line-175 filters apply only to rep-side task/
        // stale signals), so we honor the actual lead state.
        // Snoozed → ⏰ unsnooze; fresh → 💤 snooze.
        if (window.LeadSnooze) {
          const isSnoozed = window.LeadSnooze.isSnoozed(lead);
          if (isSnoozed) {
            const untilLabel = window.LeadSnooze.formatSnoozeLabel(
              window.LeadSnooze.snoozedUntilDate(lead));
            buttons.push(`
              <button class="notif-action" type="button"
                title="Unsnooze (was until ${escapeHtml(untilLabel)})"
                style="
                  display:flex; align-items:center; justify-content:center;
                  width:26px; height:26px; border-radius:5px;
                  background:color-mix(in srgb, var(--purple) 14%, transparent); color:var(--purple);
                  border:none; font-size:12px; cursor:pointer;
                  -webkit-tap-highlight-color:transparent;
                  transition:transform var(--t-fast);"
                data-nb-action="actionUnsnooze" data-nb-id="${escapeHtml(lead.id)}" data-nb-stop="1"
              >⏰</button>`);
          } else {
            buttons.push(`
              <button class="notif-action" type="button"
                title="Snooze this lead"
                style="
                  display:flex; align-items:center; justify-content:center;
                  width:26px; height:26px; border-radius:5px;
                  background:color-mix(in srgb, var(--purple) 10%, transparent); color:var(--purple);
                  border:none; font-size:12px; cursor:pointer;
                  -webkit-tap-highlight-color:transparent;
                  transition:transform var(--t-fast);"
                data-nb-action="actionSnooze" data-nb-id="${escapeHtml(lead.id)}" data-nb-stop="1"
              >💤</button>`);
          }
        }
        // .notif-actions / .notif-dismiss are the phone hooks: at <=600px
        // dashboard-app.css wraps the action strip onto its own line under
        // the text and gives × / ↩ a 36px target, because five 36px touch
        // actions beside the text left the title a 98px column (46px at
        // 360) — "Overdue Follow-Up — Todd Heffner" ran 3-6 lines and the
        // detail cut to "0 days …" (phone audit views#8, 2026-09-25).
        if (buttons.length > 0) {
          actionButtonsHTML = `
            <div class="notif-actions" style="display:flex; gap:3px; align-self:center; flex-shrink:0;">
              ${buttons.join('')}
            </div>`;
        }
      }
    }

    return `
      <div class="notif-item" data-notif-id="${escapeHtml(n.id)}"
        style="
          padding:10px 14px; border-bottom:1px solid var(--br);
          display:flex; gap:10px; cursor:pointer; opacity:${opacity};
          transition:background var(--t-mid);"
        data-nb-action="handleClick" data-nb-id="${escapeHtml(n.id)}">
        <div style="font-size:16px; flex-shrink:0; line-height:1.2;">${n.icon}</div>
        <div style="flex:1; min-width:0;">
          <div style="font-size:12px; font-weight:600; color:var(--t); margin-bottom:2px;">
            <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${sevColor};margin-right:6px;vertical-align:middle;"></span>
            ${escapeHtml(n.title)}
          </div>
          <div style="font-size:11px; color:var(--t); margin-bottom:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            ${escapeHtml(n.text)}
          </div>
          <div style="font-size:10px; color:var(--m);">
            ${escapeHtml(n.sub)}
          </div>
        </div>
        ${actionButtonsHTML}
        ${isDismissedView ? `
        <button class="notif-dismiss" title="Restore"
          style="
            background:transparent; border:none; color:var(--m);
            cursor:pointer; padding:4px 8px; font-size:13px; line-height:1;
            opacity:0.7; align-self:flex-start;"
          data-nb-action="restore" data-nb-id="${escapeHtml(n.id)}" data-nb-stop="1">
          ↩
        </button>` : `
        <button class="notif-dismiss" title="Dismiss"
          style="
            background:transparent; border:none; color:var(--m);
            cursor:pointer; padding:4px 8px; font-size:14px; line-height:1;
            opacity:0.6; align-self:flex-start;"
          data-nb-action="dismiss" data-nb-id="${escapeHtml(n.id)}" data-nb-stop="1">
          ×
        </button>`}
      </div>`;
  }

  // ─── Click handlers ──────────────────────────────────────────────
  function handleClick(id) {
    const all = buildNotifications();
    const item = all.find(n => n.id === id);
    if (!item) return;
    markReadItem(item);
    closeDropdown();
    if (typeof item.onClick === 'function') {
      try { item.onClick(); } catch (e) { console.warn('[NotifBell]', e); }
    } else if (item.href) {
      window.location.href = item.href;
    }
    render();
  }

  function dismissOne(id) {
    const item = buildNotifications().find(n => n.id === id);
    if (item) dismissItem(item);
    render();
  }

  // Restore a dismissed item from the "Show dismissed" drawer. Source-
  // aware, mirroring dismissItem: server items un-dismiss in Firestore
  // (via NBDServerNotifs.restore) and come back UNREAD; derived nags
  // drop out of the localStorage dismissed set (and read set, so the
  // signal re-nags).
  function restoreItem(n) {
    if (n._source === 'server') {
      _patchServerDoc(n._docId, { dismissed: false, read: false });
      invalidateNotifCache();
      if (window.NBDServerNotifs && typeof window.NBDServerNotifs.restore === 'function') {
        Promise.resolve(window.NBDServerNotifs.restore(n._docId)).catch(() => {});
      }
    } else {
      dismissed.delete(n.id); _writeSet(DISMISS_KEY, dismissed);
      read.delete(n.id);      _writeSet(READ_KEY, read);
      invalidateNotifCache();
    }
  }
  function restoreOne(id) {
    const item = buildNotifications().find(n => n.id === id);
    if (item) restoreItem(item);
    render();
  }

  function markAllRead() {
    const items = buildNotifications().filter(n => !itemIsDismissed(n));
    // Derived items → localStorage read set.
    items.filter(n => n._source !== 'server').forEach(n => read.add(n.id));
    _writeSet(READ_KEY, read);
    // Server items → Firestore, by explicit doc id (order-independent).
    const serverIds = items
      .filter(n => n._source === 'server' && !n._read)
      .map(n => n._docId);
    serverIds.forEach(docId => _patchServerDoc(docId, { read: true }));
    invalidateNotifCache();
    if (serverIds.length && window.NBDServerNotifs
        && typeof window.NBDServerNotifs.markReadMany === 'function') {
      Promise.resolve(window.NBDServerNotifs.markReadMany(serverIds)).catch(() => {});
    }
    render();
  }

  function clearAll() {
    const items = buildNotifications().filter(n => !itemIsDismissed(n));
    // Derived items → localStorage dismissed set.
    items.filter(n => n._source !== 'server').forEach(n => dismissed.add(n.id));
    _writeSet(DISMISS_KEY, dismissed);
    // Server items → Firestore, by explicit doc id.
    const serverIds = items
      .filter(n => n._source === 'server')
      .map(n => n._docId);
    serverIds.forEach(docId => _patchServerDoc(docId, { dismissed: true, read: true }));
    invalidateNotifCache();
    if (serverIds.length && window.NBDServerNotifs
        && typeof window.NBDServerNotifs.dismissMany === 'function') {
      Promise.resolve(window.NBDServerNotifs.dismissMany(serverIds)).catch(() => {});
    }
    render();
  }

  // ─── Dropdown open/close ─────────────────────────────────────────
  function toggleDropdown() {
    const dd = document.getElementById('notifDropdown');
    if (!dd) return;
    if (dd.style.display === 'none' || !dd.style.display) {
      dd.style.display = 'flex';
      render();
      // Close on outside click.
      setTimeout(() => {
        document.addEventListener('click', _outsideClick, { once: true });
      }, 0);
    } else {
      closeDropdown();
    }
  }
  function closeDropdown() {
    const dd = document.getElementById('notifDropdown');
    if (dd) dd.style.display = 'none';
  }
  function _outsideClick(ev) {
    const dd = document.getElementById('notifDropdown');
    const btn = document.getElementById('notifBtn');
    if (!dd || !btn) return;
    if (dd.contains(ev.target) || btn.contains(ev.target)) {
      // Re-arm for the next outside click.
      setTimeout(() => {
        document.addEventListener('click', _outsideClick, { once: true });
      }, 0);
      return;
    }
    closeDropdown();
  }

  function toggleDismissedView() {
    const list = document.getElementById('notifDismissedList');
    const label = document.getElementById('dismissedToggleLabel');
    if (!list) return;
    if (list.style.display === 'none' || !list.style.display) {
      list.style.display = 'block';
      if (label) label.textContent = 'Hide dismissed';
    } else {
      list.style.display = 'none';
      if (label) label.textContent = 'Show dismissed';
    }
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    render();
    // Re-render every 60s so time-based items (overdue, stale) update
    // even if the underlying data hasn't changed.
    setInterval(render, 60_000);
    // Re-render whenever dashboard publishes a data refresh.
    window.addEventListener('nbd:data-refreshed', render);
    // Re-render when the Firestore notifications feed changes.
    // crm-snooze.js fires this from its onSnapshot after hydrating
    // window._notifications, so server-written notifications (portal,
    // referral, deal-accept, remote-sign, follow-up engine) appear +
    // update the badge in real time. Invalidate the 5s build cache
    // first so the rebuild picks up the new feed.
    window.addEventListener('nbd:notifs-updated', () => { invalidateNotifCache(); render(); });
    // Also react to focus — reps tabbing back to the dashboard.
    window.addEventListener('focus', render);
  }

  // Wave 48: bell-row reshare action helpers. Mirrors the W42
  // PortalLinkHelpers entry points but resolves the lead by id from
  // the in-memory cache so the inline onclick handlers on the
  // rendered HTML can fire by id alone.
  function _actionSms(leadId) {
    const lead = (Array.isArray(window._leads) ? window._leads : [])
      .find(l => l && l.id === leadId);
    if (!lead) return;
    if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.smsForLead === 'function') {
      window.PortalLinkHelpers.smsForLead(lead);
    }
  }
  function _actionEmail(leadId) {
    const lead = (Array.isArray(window._leads) ? window._leads : [])
      .find(l => l && l.id === leadId);
    if (!lead) return;
    if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.emailForLead === 'function') {
      window.PortalLinkHelpers.emailForLead(lead);
    }
  }
  // Wave 68: bell-row preview + snooze/unsnooze helpers. Same
  // resolve-by-id pattern as W48 share helpers above so the
  // inline onclick handlers can fire by lead id alone.
  function _actionPreview(leadId) {
    const lead = (Array.isArray(window._leads) ? window._leads : [])
      .find(l => l && l.id === leadId);
    if (!lead) return;
    if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.previewForLead === 'function') {
      // Don't close the bell dropdown — preview opens at z-index
      // 99997 over the dropdown so the rep can dismiss preview
      // and keep triaging the alert list.
      window.PortalLinkHelpers.previewForLead(lead);
    }
  }
  function _actionSnooze(leadId) {
    const lead = (Array.isArray(window._leads) ? window._leads : [])
      .find(l => l && l.id === leadId);
    if (!lead) return;
    if (window.LeadSnooze && typeof window.LeadSnooze.prompt === 'function') {
      const fullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
      window.LeadSnooze.prompt(leadId, fullName);
    }
  }
  function _actionUnsnooze(leadId) {
    if (window.LeadSnooze && typeof window.LeadSnooze.promptUnsnooze === 'function') {
      // Re-render after unsnooze so the button flips ⏰ → 💤 in
      // place. nbd:data-refreshed already triggers re-render but
      // call render() directly so the flip happens immediately.
      window.LeadSnooze.promptUnsnooze(leadId).then(() => render());
    }
  }

  // Expose API
  const NotifBell = {
    render,
    getCount: () => buildNotifications().filter(n => !itemIsDismissed(n) && !itemIsRead(n)).length,
    _handleClick: handleClick,
    _dismiss: dismissOne,
    _restore: restoreOne,
    _actionSms,
    _actionEmail,
    _actionPreview,
    _actionSnooze,
    _actionUnsnooze,
  };

  // The two map-dispatched toggles are registry-only (Tranche 3 map-graduate
  // follow-on, 2026-09-02): reached solely through _NBD_TOGGLE_FNS keys
  // 'notifications' / 'dismissedNotifications' via _nbdResolveMapped
  // (registry-first since T3-M). Keys are the DISPATCHED name strings; the
  // values are the IIFE-local functions, lexically in scope here.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    toggleNotificationDropdown: toggleDropdown,
    toggleDismissedNotifications: toggleDismissedView
  });
  // The two data-fn markup handlers keep their window exposure (allowlisted).
  window.markAllNotificationsRead = markAllRead;
  window.clearAllNotifications = clearAll;

  // Defer init until after other modules have populated their caches.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 2500));
  } else {
    setTimeout(init, 2500);
  }

  // ── CSP-safe delegation for the 8 data-nb-action attrs (notif bell) ──
  // Registered INSIDE this IIFE so the click handler closes over the
  // `NotifBell` const above. It previously lived in a SEPARATE sibling
  // IIFE where `NotifBell` was out of scope, so `const NB = NotifBell`
  // threw "ReferenceError: NotifBell is not defined" on every click —
  // the row-click nav, × dismiss, and inline call/text/email/preview/
  // snooze buttons were all dead. Keeping NotifBell a closure (not on
  // window) also satisfies the globals Tranche-0 guard.
  if (!window._NBD_NB_DELEGATE_BOUND) {
    window._NBD_NB_DELEGATE_BOUND = true;
    document.addEventListener('click', function (ev) {
      // data-nb-stop-self on a wrapper element prevents bubbling from the wrapper itself
      const stopSelf = ev.target.closest && ev.target.closest('[data-nb-stop-self="1"]');
      if (stopSelf && ev.target === stopSelf) ev.stopPropagation();
      const t = ev.target.closest && ev.target.closest('[data-nb-action]');
      if (!t) return;
      if (t.dataset.nbStop === '1') ev.stopPropagation();
      const action = t.dataset.nbAction;
      const id = t.dataset.nbId;
      const NB = NotifBell || {};
      const internal = '_' + action; // _actionSms, _handleClick, _dismiss, etc.
      const fn = NB[internal];
      if (typeof fn !== 'function') { console.warn('[notif-bell] no dispatch for', action); return; }
      try { id !== undefined ? fn(id) : fn(); }
      catch (e) { console.error('[notif-bell] dispatch ' + action + ' failed:', e); }
    });
  }
})();
