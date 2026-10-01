// ============================================================
// NBD Pro — Ask Joe Proactive Behaviors
//
// Locked spec from site_wide_spec_20260410.md §AI Tools:
//
//   Proactive behaviors:
//     - Daily 7am morning briefing (overdue, estimates
//       pending, storm alerts, priorities)
//     - Event-triggered alerts (hail alert + affected leads,
//       5-day no-reply, supplement approved)
//   User configurable
//
// This module coordinates three things:
//   1. Morning briefing aggregator — at 7am (or on demand)
//      pulls from every data source and builds a prioritized
//      summary card
//   2. Event watcher — runs on a timer, scans for new signals
//      (overdue follow-ups, storm alerts, inbox responses)
//      and fires notifications
//   3. Notification queue — unified queue for both proactive
//      briefings and reactive alerts, surfaced by the UI
//
// Exposes AskJoeProactive.
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ═════════════════════════════════════════════════════════
  // Field-name resolvers
  // ═════════════════════════════════════════════════════════
  // The proactive scans were written against fields that no save
  // path actually writes — `lead.lastContactedAt`, `lead.stageUpdatedAt`.
  // Result: every scan returned zero hits. These helpers pull from
  // the fields the rest of the codebase actually maintains:
  //
  //   _lastTouch(lead)    — most recent contact/activity moment.
  //                          Tries lastContactedAt → lastActivityAt →
  //                          updatedAt → createdAt → null.
  //   _stageStarted(lead) — when the lead entered its current stage.
  //                          Tries stageStartedAt (PR #31) → updatedAt →
  //                          createdAt → null.
  //   _stageKey(lead)     — normalized stage key for comparison.
  //                          Uses window.normalizeStage when available.
  //   _isEstimateSent(lead) — covers all four real "estimate sent"
  //                            stage keys (legacy + insurance + cash + finance).
  function _toDate(v) {
    if (!v) return null;
    if (v.toDate) return v.toDate();
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }
  function _lastTouch(lead) {
    return _toDate(lead && (lead.lastContactedAt || lead.lastActivityAt || lead.updatedAt || lead.createdAt));
  }
  function _stageStarted(lead) {
    return _toDate(lead && (lead.stageStartedAt || lead.updatedAt || lead.createdAt));
  }
  function _stageKey(lead) {
    if (!lead) return '';
    if (lead._stageKey) return lead._stageKey;
    if (typeof window.normalizeStage === 'function') {
      try { return window.normalizeStage(lead.stage || ''); } catch (_) {}
    }
    return String(lead.stage || '').toLowerCase().replace(/\s+/g, '_');
  }
  const _ESTIMATE_SENT_KEYS = new Set([
    'estimate_sent', 'Estimate Sent', 'estimate_submitted', 'estimate_sent_cash'
  ]);
  function _isEstimateSent(lead) {
    if (!lead) return false;
    if (_ESTIMATE_SENT_KEYS.has(lead.stage)) return true;
    const k = _stageKey(lead);
    return k === 'estimate_sent' || k === 'estimate_submitted' || k === 'estimate_sent_cash';
  }
  // 'won' has no LEGACY_MAP entry (unlike 'Complete'/'Lost'/etc, which
  // normalizeStage's case-insensitive alias search already resolves) — kept
  // as an explicit fast-path so a bare legacy 'won' string doesn't fall
  // through to window.isTerminalStage's normalization and read as ACTIVE.
  const _TERMINAL_STAGE_KEYS = new Set(['won']);
  // 2026-09-15 (Kanban filter unification): the built-in-key fast path +
  // role-aware fallback used to be duplicated inline here; now calls the
  // one canonical isTerminalStage() (crm-stages.js) — same pattern as
  // functions/portal.js's progressKeyFor. Without the fallback, a tenant's
  // own custom stage tagged role won/lost via Settings > Pipelines is
  // invisible here — Ask Joe would keep treating an already-decided
  // custom-pipeline lead as still active, nudging the rep about a lead
  // that's actually finished.
  function _isTerminal(lead) {
    if (!lead) return false;
    if (_TERMINAL_STAGE_KEYS.has(lead.stage)) return true;
    const k = _stageKey(lead);
    if (_TERMINAL_STAGE_KEYS.has(k)) return true;
    return typeof window.isTerminalStage === 'function' && window.isTerminalStage(k);
  }

  // ═════════════════════════════════════════════════════════
  // Preferences — user-configurable
  // ═════════════════════════════════════════════════════════

  const DEFAULT_PREFS = {
    enabled: true,
    morningBriefingTime: '07:00',          // HH:MM, local time
    eventWatcherInterval: 5 * 60 * 1000,    // 5 minutes
    maxAlertsPerDay: 10,
    triggers: {
      overdueFollowUps: true,               // 3+ days no touch
      overdueThresholdDays: 3,
      estimatesPending: true,                // estimates sent, no reply
      estimatePendingThresholdDays: 5,
      stormAlerts: true,
      stormMinSeverity: 'Severe',            // Severe or Extreme
      hotLeads: true,                        // high score + recent activity
      supplementResponses: true,             // adjuster approved/denied/partial
      reviewOpportunities: true,             // job completed 48h ago
      referralFollowUps: true                // previous customer referred someone
    },
    channels: {
      inApp: true,
      push: false,
      email: true,
      morningDigest: true
    }
  };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem('nbd_ask_joe_proactive_prefs');
      if (!raw) return Object.assign({}, DEFAULT_PREFS);
      const saved = JSON.parse(raw);
      return Object.assign({}, DEFAULT_PREFS, saved, {
        triggers: Object.assign({}, DEFAULT_PREFS.triggers, saved.triggers || {}),
        channels: Object.assign({}, DEFAULT_PREFS.channels, saved.channels || {})
      });
    } catch (e) {
      return Object.assign({}, DEFAULT_PREFS);
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem('nbd_ask_joe_proactive_prefs', JSON.stringify(prefs));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════
  // Notification queue
  // ═════════════════════════════════════════════════════════

  const QUEUE_KEY = 'nbd_notification_queue';
  const MAX_QUEUE = 50;

  function getQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function pushToQueue(alert) {
    const queue = getQueue();
    // Dedupe by id if provided
    if (alert.id && queue.find(a => a.id === alert.id)) return false;
    const entry = Object.assign({
      id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6),
      createdAt: new Date().toISOString(),
      read: false,
      dismissed: false
    }, alert);
    queue.unshift(entry);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(0, MAX_QUEUE))); }
    catch (e) {}
    // Fire UI toast if available
    if (typeof window.showToast === 'function' && alert.priority === 'high') {
      window.showToast(alert.title + ' — ' + (alert.body || ''), 'warning');
    }
    return entry;
  }

  function markAlertRead(id) {
    const queue = getQueue();
    const entry = queue.find(a => a.id === id);
    if (entry) {
      entry.read = true;
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
    }
  }

  function dismissAlert(id) {
    const queue = getQueue().filter(a => a.id !== id);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue)); } catch (e) {}
  }

  function getUnreadCount() {
    return getQueue().filter(a => !a.read && !a.dismissed).length;
  }

  // ═════════════════════════════════════════════════════════
  // Morning Briefing — the big one
  // ═════════════════════════════════════════════════════════

  /**
   * Aggregate every data source into a single morning briefing.
   * Returns a structured object the UI can render as a card.
   */
  function buildMorningBriefing() {
    const prefs = loadPrefs();
    const now = new Date();
    const briefing = {
      generatedAt: now.toISOString(),
      date: now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
      greeting: getGreeting(now),

      // Top-line summary stats
      stats: {
        activeLeads: 0,
        hotLeads: 0,
        overdueFollowUps: 0,
        pendingEstimates: 0,
        openClaims: 0,
        activeJobs: 0,
        pipelineValue: 0
      },

      // Prioritized action items
      actions: [],

      // Storm & weather alerts
      storms: [],

      // Revenue opportunities
      opportunities: [],

      // Reminders
      reminders: []
    };

    // ── Pull from CRM leads ──
    // Timing guard: if window._leads is empty AND _leadsLoaded is
    // falsy (set to true by the CRM module once Firestore returns),
    // the lead cache hasn't finished loading yet. Flag the briefing
    // so the UI knows to retry, and return early-with-incomplete
    // data rather than falsely reporting "quiet morning" with
    // 0 overdue leads.
    const leads = window._leads || [];
    const leadsLoaded = !!window._leadsLoaded || leads.length > 0;
    briefing.stats.activeLeads = leads.length;
    briefing.leadsLoaded = leadsLoaded;
    if (!leadsLoaded) {
      briefing.incomplete = true;
      briefing.summary = 'Leads still loading — briefing will refresh once CRM data is ready.';
      // Return early with the minimum so the UI can still render
      return briefing;
    }

    // Overdue follow-ups (no touch in N days)
    const overdueMs = prefs.triggers.overdueThresholdDays * 24 * 60 * 60 * 1000;
    const overdue = leads.filter(lead => {
      const last = _lastTouch(lead);
      if (!last) return false;
      const ageMs = now - last;
      return ageMs > overdueMs && !_isTerminal(lead);
    });
    briefing.stats.overdueFollowUps = overdue.length;

    overdue.slice(0, 5).forEach(lead => {
      const last = _lastTouch(lead);
      const ageDays = last ? Math.floor((now - last) / (24 * 60 * 60 * 1000)) : '?';
      briefing.actions.push({
        type: 'overdue',
        priority: 'high',
        icon: '⏰',
        title: `Overdue: ${lead.name || lead.firstName || 'Unknown'}`,
        body: `No touch in ${ageDays} days · ${lead.stage || 'unknown stage'}`,
        leadId: lead.id,
        action: 'call'
      });
    });

    // Hot leads (high score + recent activity)
    const hot = leads.filter(lead => {
      const score = Number(lead.leadScore) || 0;
      return score >= 75 && lead.lastActivityAt;
    }).sort((a, b) => (Number(b.leadScore) || 0) - (Number(a.leadScore) || 0));
    briefing.stats.hotLeads = hot.length;

    hot.slice(0, 3).forEach(lead => {
      briefing.actions.push({
        type: 'hot_lead',
        priority: 'high',
        icon: '🔥',
        title: `Hot lead: ${lead.name || lead.firstName || 'Unknown'}`,
        body: `Score ${lead.leadScore} · ${lead.stage}`,
        leadId: lead.id,
        action: 'view'
      });
    });

    // Pending estimates (sent, no response)
    const estPendingMs = prefs.triggers.estimatePendingThresholdDays * 24 * 60 * 60 * 1000;
    const pending = leads.filter(lead => {
      if (!_isEstimateSent(lead)) return false;
      const started = _stageStarted(lead);
      if (!started) return false;
      const ageMs = now - started;
      return ageMs > estPendingMs;
    });
    briefing.stats.pendingEstimates = pending.length;

    pending.slice(0, 3).forEach(lead => {
      const started = _stageStarted(lead);
      const ageDays = started ? Math.floor((now - started) / (24 * 60 * 60 * 1000)) : '?';
      briefing.actions.push({
        type: 'pending_estimate',
        priority: 'medium',
        icon: '📋',
        title: `Estimate pending: ${lead.name || lead.firstName || 'Unknown'}`,
        body: `Sent ${ageDays} days ago · ${lead.jobValue ? '$' + Number(lead.jobValue).toLocaleString() : ''}`,
        leadId: lead.id,
        action: 'follow_up'
      });
    });

    // Open insurance claims — match on normalized stage keys so the
    // canonical insurance pipeline names (claim_filed,
    // adjuster_meeting_scheduled, scope_received, supplement_requested,
    // supplement_approved) all count, not just the original four-key list.
    const _OPEN_CLAIM_KEYS = new Set([
      'claim_filed', 'adjuster_meeting', 'adjuster_meeting_scheduled',
      'adjuster_inspection_done', 'scope_approved', 'scope_received',
      'supplement_pending', 'supplement_requested', 'supplement_approved'
    ]);
    const openClaims = leads.filter(lead => {
      if (lead.jobType !== 'insurance') return false;
      return _OPEN_CLAIM_KEYS.has(_stageKey(lead));
    });
    briefing.stats.openClaims = openClaims.length;

    // Active jobs — deliberately NARROWER than window.isJobStage()
    // (crm-stages.js): "still in production," not "is this a job at all" —
    // final_payment/collections/closed are real jobs but represent
    // money-collection, not physical work, so they stay excluded here on
    // purpose (same boundary this list already drew before 2026-09-15).
    const _ACTIVE_JOB_KEYS = new Set([
      'crew_scheduled', 'install_in_progress', 'install_complete',
      'final_photos', 'job_created', 'permit_pulled',
      'materials_ordered', 'materials_delivered', 'deductible_collected'
    ]);
    // Jobs in production and pipeline money count every JOB — a customer's
    // second job is its own (jobs-store.js recordsFor).
    const recs = (window.NBDJobs && typeof window.NBDJobs.recordsFor === 'function') ? window.NBDJobs.recordsFor(leads) : leads;
    const activeJobs = recs.filter(lead => {
      const k = _stageKey(lead);
      if (_ACTIVE_JOB_KEYS.has(k)) return true;
      // 2026-09-15 (Kanban filter unification) — role-aware safety net, same
      // pattern as _isTerminal's fallback above: this literal had ZERO
      // fallback until now (the one list in the audit's drift table with no
      // safety net at all), so the next new in-production stage added to
      // crm-stages.js's _ROLE_JOB would silently undercount here again.
      // Deliberately role==='job' only (not 'won') — that's what keeps
      // final_payment/collections/closed correctly excluded rather than
      // quietly redefining what "active" means.
      return typeof window.stageRole === 'function' && window.stageRole(k) === 'job';
    });
    briefing.stats.activeJobs = activeJobs.length;

    // Pipeline value
    briefing.stats.pipelineValue = recs.reduce((sum, lead) => {
      if (_isTerminal(lead)) return sum;
      return sum + (Number(lead.jobValue) || 0);
    }, 0);

    // ── Pull from Storm Center ──
    if (window.StormCenter && window.StormCenter.getZones) {
      const zones = window.StormCenter.getZones() || [];
      const activeZones = zones.filter(z => {
        if (!z.expiresAt) return true;
        return new Date(z.expiresAt) > now;
      });
      briefing.storms = activeZones.slice(0, 3).map(zone => ({
        id: zone.id,
        name: zone.name || 'Unknown zone',
        severity: zone.severity || 'Unknown',
        alertType: zone.alertType || zone.type,
        affectedLeadCount: window.StormIntegration
          ? window.StormIntegration.findLeadsInZone(zone).length
          : 0
      }));

      // High-severity storms become action items
      activeZones.filter(z => ['Extreme', 'Severe'].includes(z.severity)).forEach(zone => {
        briefing.actions.push({
          type: 'storm',
          priority: 'high',
          icon: '⛈️',
          title: `${zone.severity} storm: ${zone.name || 'Service area'}`,
          body: `${zone.alertType || 'Severe weather'} · Check affected leads`,
          zoneId: zone.id,
          action: 'view_storm'
        });
      });
    }

    // ── Revenue opportunities ──
    // Recently completed jobs → review request opportunity
    const recentlyCompleted = leads.filter(lead => {
      if (!['closed', 'complete'].includes(lead.stage)) return false;
      if (!lead.completedAt) return false;
      const daysSince = (now - new Date(lead.completedAt)) / (24 * 60 * 60 * 1000);
      return daysSince >= 2 && daysSince <= 7;
    });
    recentlyCompleted.slice(0, 3).forEach(lead => {
      briefing.opportunities.push({
        type: 'review_request',
        icon: '⭐',
        title: `Ask for review: ${lead.name || lead.firstName || 'Unknown'}`,
        body: `Completed ${Math.floor((now - new Date(lead.completedAt)) / (24 * 60 * 60 * 1000))} days ago`,
        leadId: lead.id,
        action: 'send_review_request'
      });
    });

    // ── Smart follow-up top actions (heuristic; AI enrich top 5 async) ──
    // Prepend highest-leverage SmartFollowup suggestions so the morning
    // digest answers "what do I do first?" with the same engine as the
    // kanban pills / customer panel.
    briefing.smartFollowups = [];
    if (window.SmartFollowup && typeof window.SmartFollowup.computeSuggestion === 'function'
        && typeof window.SmartFollowup.score === 'function') {
      try {
        const scored = leads
          .filter(l => l && l.id && !_isTerminal(l))
          .map(l => {
            const sug = window.SmartFollowup.computeSuggestion(l);
            return sug ? { lead: l, sug, score: window.SmartFollowup.score(sug) } : null;
          })
          .filter(x => x && x.score >= 200) // today / urgent / this-week only
          .sort((a, b) => b.score - a.score)
          .slice(0, 8);
        scored.forEach(({ lead, sug }) => {
          const name = lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || 'Lead';
          const item = {
            type: 'smart_followup',
            priority: sug.priority === 'urgent' ? 'high' : (sug.priority === 'today' ? 'high' : 'medium'),
            icon: sug.channel === 'email' ? '📧' : (sug.channel === 'sms' || sug.action === 'text' ? '💬' : '📞'),
            title: sug.headline || `Follow up: ${name}`,
            body: sug.reasoning || '',
            leadId: lead.id,
            action: 'smart_followup',
            channel: sug.channel,
            draft: sug.draft || null,
            confidence: sug.confidence,
            _aiEnriched: !!sug._aiEnriched,
          };
          briefing.actions.unshift(item);
          briefing.smartFollowups.push(item);
        });
        // Async: enrich top 5 with Claude (bounded spend). Callers that
        // re-render on nbd:data-refreshed will pick up _aiEnriched text.
        if (typeof window.SmartFollowup.enrichSuggestionAI === 'function') {
          scored.slice(0, 5).forEach(({ lead }) => {
            window.SmartFollowup.enrichSuggestionAI(lead).catch(() => {});
          });
        }
      } catch (e) {
        console.warn('[AskJoeProactive] smart followup slice failed', e && e.message);
      }
    }

    // ── Sort actions by priority ──
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    briefing.actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    // Cap action list so the digest stays scannable.
    briefing.actions = briefing.actions.slice(0, 12);

    // ── Top-line summary sentence ──
    briefing.summary = buildSummarySentence(briefing);

    return briefing;
  }

  function getGreeting(date) {
    const hour = date.getHours();
    if (hour < 12) return 'Good morning, Joe';
    if (hour < 17) return 'Good afternoon, Joe';
    return 'Good evening, Joe';
  }

  function buildSummarySentence(briefing) {
    const parts = [];
    const s = briefing.stats;
    if (s.overdueFollowUps > 0) {
      parts.push(`${s.overdueFollowUps} overdue follow-up${s.overdueFollowUps > 1 ? 's' : ''}`);
    }
    if (s.hotLeads > 0) {
      parts.push(`${s.hotLeads} hot lead${s.hotLeads > 1 ? 's' : ''}`);
    }
    if (s.pendingEstimates > 0) {
      parts.push(`${s.pendingEstimates} estimate${s.pendingEstimates > 1 ? 's' : ''} waiting`);
    }
    if (briefing.storms.length > 0) {
      parts.push(`${briefing.storms.length} active storm alert${briefing.storms.length > 1 ? 's' : ''}`);
    }
    if (parts.length === 0) {
      return 'Quiet morning. Pipeline is healthy — nothing urgent on the board.';
    }
    return parts.slice(0, 3).join(' · ');
  }

  // ═════════════════════════════════════════════════════════
  // Event watcher — scans for new signals on a timer
  // ═════════════════════════════════════════════════════════

  let watcherTimer = null;
  let lastScan = null;

  function startWatcher() {
    const prefs = loadPrefs();
    if (!prefs.enabled) return;
    if (watcherTimer) clearInterval(watcherTimer);
    // Run immediately, then on interval
    runWatcherScan();
    watcherTimer = setInterval(runWatcherScan, prefs.eventWatcherInterval);
    console.log('[AskJoeProactive] Event watcher started (interval:', prefs.eventWatcherInterval / 1000, 'sec)');
  }

  function stopWatcher() {
    if (watcherTimer) {
      clearInterval(watcherTimer);
      watcherTimer = null;
    }
  }

  function runWatcherScan() {
    const prefs = loadPrefs();
    if (!prefs.enabled) return;
    lastScan = new Date().toISOString();

    // Scan storms
    if (prefs.triggers.stormAlerts && window.StormIntegration) {
      try {
        window.StormIntegration.scanForNewAlerts();
      } catch (e) {}
    }

    // Scan for overdue follow-ups (only once per day)
    if (prefs.triggers.overdueFollowUps && shouldFireOnceToday('overdue_scan')) {
      scanOverdueFollowUps(prefs);
    }

    // Scan for pending estimates (once per day)
    if (prefs.triggers.estimatesPending && shouldFireOnceToday('pending_estimate_scan')) {
      scanPendingEstimates(prefs);
    }
  }

  function shouldFireOnceToday(key) {
    const today = new Date().toISOString().split('T')[0];
    const last = localStorage.getItem('nbd_proactive_' + key);
    if (last === today) return false;
    try { localStorage.setItem('nbd_proactive_' + key, today); } catch (e) {}
    return true;
  }

  function scanOverdueFollowUps(prefs) {
    const leads = window._leads || [];
    const now = new Date();
    const overdueMs = prefs.triggers.overdueThresholdDays * 24 * 60 * 60 * 1000;
    const overdue = leads.filter(lead => {
      const last = _lastTouch(lead);
      if (!last) return false;
      const ageMs = now - last;
      return ageMs > overdueMs && !_isTerminal(lead);
    });
    if (overdue.length === 0) return;
    pushToQueue({
      id: 'overdue_scan_' + now.toISOString().split('T')[0],
      type: 'overdue_batch',
      priority: 'high',
      title: `${overdue.length} overdue follow-up${overdue.length > 1 ? 's' : ''}`,
      body: `Leads that haven't been contacted in ${prefs.triggers.overdueThresholdDays}+ days`,
      leadIds: overdue.map(l => l.id),
      action: 'view_overdue'
    });
  }

  function scanPendingEstimates(prefs) {
    const leads = window._leads || [];
    const now = new Date();
    const pendingMs = prefs.triggers.estimatePendingThresholdDays * 24 * 60 * 60 * 1000;
    const pending = leads.filter(lead => {
      if (!_isEstimateSent(lead)) return false;
      const started = _stageStarted(lead);
      if (!started) return false;
      const ageMs = now - started;
      return ageMs > pendingMs;
    });
    if (pending.length === 0) return;
    pushToQueue({
      id: 'pending_estimate_scan_' + now.toISOString().split('T')[0],
      type: 'pending_estimates',
      priority: 'medium',
      title: `${pending.length} estimate${pending.length > 1 ? 's' : ''} awaiting response`,
      body: `Sent ${prefs.triggers.estimatePendingThresholdDays}+ days ago, no reply`,
      leadIds: pending.map(l => l.id),
      action: 'follow_up_pending'
    });
  }

  // ═════════════════════════════════════════════════════════
  // Morning briefing trigger (daily at 7am or on demand)
  // ═════════════════════════════════════════════════════════

  function triggerMorningBriefing() {
    const prefs = loadPrefs();
    if (!prefs.enabled) return null;

    const briefing = buildMorningBriefing();

    // Save as notification
    pushToQueue({
      id: 'morning_briefing_' + new Date().toISOString().split('T')[0],
      type: 'morning_briefing',
      priority: 'medium',
      title: briefing.greeting + ' — ' + briefing.date,
      body: briefing.summary,
      briefing: briefing,
      action: 'view_briefing'
    });

    return briefing;
  }

  /**
   * Schedule the morning briefing for the next 7am (or user-preferred time).
   * Runs on a timer that fires at the configured time every day.
   */
  let briefingTimer = null;
  function scheduleMorningBriefing() {
    if (briefingTimer) clearTimeout(briefingTimer);
    const prefs = loadPrefs();
    if (!prefs.enabled || !prefs.channels.morningDigest) return;

    const [hh, mm] = (prefs.morningBriefingTime || '07:00').split(':').map(Number);
    const now = new Date();
    const next = new Date();
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;

    briefingTimer = setTimeout(() => {
      // Don't fire if already fired today
      if (shouldFireOnceToday('morning_briefing')) {
        triggerMorningBriefing();
      }
      scheduleMorningBriefing();  // Schedule next day
    }, delay);
    console.log('[AskJoeProactive] Morning briefing scheduled for', next.toLocaleString());
  }

  // ═════════════════════════════════════════════════════════
  // Event trigger helpers — call these from other modules
  // ═════════════════════════════════════════════════════════

  function triggerSupplementApproved(supplement) {
    pushToQueue({
      type: 'supplement_approved',
      priority: 'high',
      title: `✓ Supplement approved: $${supplement.supplementTotal.toLocaleString()}`,
      body: `Supplement #${supplement.version} for claim ${supplement.parentEstimateId}`,
      supplementId: supplement.id,
      action: 'view_supplement'
    });
  }

  function triggerSupplementDenied(supplement) {
    pushToQueue({
      type: 'supplement_denied',
      priority: 'high',
      title: `✗ Supplement denied`,
      body: `Supplement #${supplement.version} — ${supplement.submission.responseNotes || 'No reason given'}`,
      supplementId: supplement.id,
      action: 'rebuttal_playbook'
    });
  }

  // Form-created leads carry firstName/lastName, not `name`.
  function leadName(lead) {
    return ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.name || 'Unknown';
  }

  function triggerHotLeadAlert(lead) {
    pushToQueue({
      type: 'hot_lead',
      priority: 'high',
      title: `🔥 Hot lead: ${leadName(lead)}`,
      body: `Score ${lead.leadScore} · ${lead.stage}`,
      leadId: lead.id,
      action: 'view_lead'
    });
  }

  function triggerInboundMessage(lead, channel) {
    pushToQueue({
      type: 'inbound_message',
      priority: 'medium',
      title: `${channel === 'sms' ? '💬' : channel === 'email' ? '📧' : '📞'} ${leadName(lead)} replied`,
      body: `${channel} · ${lead.stage}`,
      leadId: lead.id,
      action: 'view_lead'
    });
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════

  const AskJoeProactive = {
    // Preferences
    loadPrefs,
    savePrefs,
    DEFAULT_PREFS,

    // Morning briefing
    buildMorningBriefing,
    triggerMorningBriefing,
    scheduleMorningBriefing,

    // Event watcher
    startWatcher,
    stopWatcher,
    runWatcherScan,

    // Notification queue
    getQueue,
    pushToQueue,
    markAlertRead,
    dismissAlert,
    getUnreadCount,

    // Event triggers (call from other modules)
    triggerSupplementApproved,
    triggerSupplementDenied,
    triggerHotLeadAlert,
    triggerInboundMessage,

    // Internal state
    getLastScan: () => lastScan,
    isWatcherRunning: () => !!watcherTimer
  };

  // Auto-start on page load if enabled
  if (typeof window !== 'undefined' && document.readyState !== 'loading') {
    setTimeout(() => {
      const prefs = loadPrefs();
      if (prefs.enabled) {
        startWatcher();
        scheduleMorningBriefing();
      }
    }, 2000);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const prefs = loadPrefs();
        if (prefs.enabled) {
          startWatcher();
          scheduleMorningBriefing();
        }
      }, 2000);
    });
  }

  console.log('[AskJoeProactive] Ready — morning briefing + event watcher + notification queue.');
})();
