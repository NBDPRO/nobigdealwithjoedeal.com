/**
 * layouts/inbox.js — L05 "Triage Inbox" (2026-10-12, D6 of the style integration).
 *
 * One keyboard-driven inbox: list | thread | the customer's facts and quick
 * actions. It MERGES feeds the CRM already has — it builds none of its own:
 *
 *   texts, calls, carrier    phone_calls + phone_text_days (the same rows and
 *                            the same "needs you" rule as Home / Call Center:
 *                            NBDHomeAttention.groupNeeds, one row per PERSON)
 *   new web leads            window._leads (stage "new", last 7 days)
 *   opened estimates, quiet  NBDEstimateFollowups.computeFollowups (#2136)
 *   nudges                   NBDToday.compute(): promised / overdue tasks and
 *                            stalled follow-ups
 *   drafts                   leads/*\/ai_drafts (status pending, the rep's own)
 *                            and the Agent inbox's pending draft_text/email
 *
 * Every row carries a reply-by timer (a rule table, SLA below): green while
 * there is time, gold once half the window is gone, red when it is past.
 *
 * The composer is DRAFT-ONLY. Nothing is sent by typing, by a suggestion, or
 * by a keystroke. Send hands the words to NBDPhoneShare.share — the CRM's one
 * existing path, which first asks the server (phoneTextAction 'check': STOP
 * register, Do Not Text, consent, texting switch, quiet hours) and then opens
 * the phone's / computer's own Messages with the text written; the rep
 * presses Send there. This file builds no send path of its own.
 *
 * Reads are bounded (200 calls + 100 text days, 15 customers x 10 AI drafts, 30 thread rows)
 * and every feed reports its own failure: a failed read is a banner with a
 * Retry, never an empty list. "Nothing needs a reply" is shown only when every
 * feed answered.
 *
 * Keys (ignored while typing, with a modifier, or while a dialog is open; handled
 * keys stop here so the dashboard's global E = New Estimate does not also fire):
 *   J / K move   R reply   E done   S snooze   Esc back
 *
 * Pure part (NBDInboxLogic) is require()-able for tests.
 */
(function (root) {
  'use strict';

  // ── pure: the reply-by rule table ────────────────────────────────────
  var MIN = 60000, HOUR = 3600000, DAY = 86400000;
  // kind -> { label, window (ms the rep has to answer), rank (tie-break) }
  var KINDS = {
    webLead:  { label: 'New lead',     folder: 'leads',     windowMs: 30 * MIN, rank: 10 },
    text:     { label: 'Text',         folder: 'texts',     windowMs: 2 * HOUR, rank: 20 },
    missed:   { label: 'Missed call',  folder: 'calls',     windowMs: 1 * HOUR, rank: 15 },
    call:     { label: 'Call',         folder: 'calls',     windowMs: 4 * HOUR, rank: 30 },
    carrier:  { label: 'Carrier',      folder: 'carrier',   windowMs: 4 * HOUR, rank: 25 },
    estimate: { label: 'Estimate',     folder: 'estimates', windowMs: 24 * HOUR, rank: 40 },
    nudge:    { label: 'Follow-up',    folder: 'nudges',    windowMs: 24 * HOUR, rank: 50 },
    draft:    { label: 'Draft',        folder: 'drafts',    windowMs: 2 * HOUR, rank: 35 },
    agent:    { label: 'Agent draft',  folder: 'drafts',    windowMs: 24 * HOUR, rank: 36 },
  };
  var FOLDERS = [
    ['all', 'All'], ['texts', 'Texts'], ['calls', 'Calls'], ['leads', 'New leads'],
    ['estimates', 'Estimates'], ['carrier', 'Carrier'], ['nudges', 'Follow-ups'], ['drafts', 'Drafts'],
  ];

  function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
  function toMs(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var p = Date.parse(v);
    return isFinite(p) ? p : 0;
  }
  function digits10(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; }
  function endOfDay(ms) { var d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime(); }
  function ymdEnd(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999).getTime() : 0;
  }
  function dur(ms) {
    var m = Math.max(1, Math.round(ms / MIN));
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 && h < 6 ? ' ' + (m % 60) + 'm' : '');
    return Math.floor(h / 24) + 'd';
  }

  /** The timer chip: state is red / gold / green; label is plain words. */
  function timer(replyByMs, windowMs, now) {
    var n = now == null ? Date.now() : now;
    var left = replyByMs - n;
    if (left <= 0) return { state: 'red', label: 'Overdue ' + dur(-left), leftMs: left };
    if (left <= (windowMs || HOUR) / 2) return { state: 'gold', label: dur(left) + ' left', leftMs: left };
    return { state: 'green', label: dur(left) + ' left', leftMs: left };
  }

  // The suggested reply, by rule. Plain; no claims, prices, coverage or outcome
  // words (claim-wording-filter.js is run over every string in the test).
  function suggestFor(kind, name, draftText) {
    var f = firstName(name);
    var hi = f ? 'Hi ' + f + ', ' : 'Hi, ';
    if (kind === 'draft' && draftText) return String(draftText);
    if (kind === 'webLead') return hi + 'thanks for reaching out about your roof. When is a good time for a quick call?';
    if (kind === 'missed') return hi + 'sorry I missed you. What\'s a good time to talk?';
    if (kind === 'text' || kind === 'call' || kind === 'carrier') return hi + 'got your message. When is a good time to talk?';
    if (kind === 'estimate') return hi + 'just checking that you got the estimate, and whether you have any questions.';
    return hi + 'following up on your roof. Is now a good time to talk?';
  }

  function personKeyOfCall(c) {
    if (c.leadId) return 'lead:' + c.leadId;
    var d = digits10(c.phoneDigits);
    return d ? 'num:' + d : 'id:' + (c.id || '');
  }

  /**
   * Feeds -> one list, one row per PERSON, most urgent reply-by first.
   * o: { now, groups, leads, estimateRows, plan, aiDrafts, agentDrafts,
   *      isSnoozed(lead), skip(key) }
   *   groups  NBDHomeAttention.groupNeeds(rows) output ([{ key, calls[] }])
   */
  function buildItems(o) {
    var now = o.now == null ? Date.now() : o.now;
    var leads = o.leads || [];
    var byId = {};
    leads.forEach(function (l) { if (l && l.id != null) byId[String(l.id)] = l; });
    var people = {}, order = [];
    function person(key, leadId) {
      if (!people[key]) { people[key] = { key: key, leadId: leadId || '', reasons: [], callIds: [], taskRefs: [], draftRefs: [], agentIds: [] }; order.push(key); }
      return people[key];
    }
    function leadSnoozed(id) {
      var l = byId[String(id)];
      if (!l) return false;
      try { return typeof o.isSnoozed === 'function' && !!o.isSnoozed(l); } catch (e) { return false; }
    }
    function add(p, kind, replyBy, why, extra) {
      var k = KINDS[kind];
      var r = { kind: kind, label: k.label, folder: k.folder, replyByMs: replyBy, windowMs: k.windowMs, why: clip(why, 140), rank: k.rank };
      r.timer = timer(replyBy, k.windowMs, now);
      if (extra) for (var x in extra) r[x] = extra[x];
      p.reasons.push(r);
      return r;
    }

    // calls + text days (already grouped by person and filtered by the shared rule)
    (o.groups || []).forEach(function (g) {
      var calls = g.calls || [];
      if (!calls.length) return;
      var latest = calls[0];
      var lead = latest.leadId ? byId[String(latest.leadId)] : null;
      if (latest.leadId && leadSnoozed(latest.leadId)) return;
      var p = person(g.key || personKeyOfCall(latest), latest.leadId || '');
      if (!p.name) p.name = (lead && ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()) || latest.contactName || latest.callerName || '';
      if (!p.phone) p.phone = digits10((lead && (lead.phone || lead.phoneDigits)) || latest.phoneDigits);
      var at = toMs(latest.startedAtMs) || now;
      var carrier = calls.some(function (c) { return c.bucket === 'insurance' || c.callType === 'insurance'; });
      var missed = calls.some(function (c) { return c.channel !== 'text' && c.status === 'short' && c.direction === 'inbound'; });
      var isText = latest.channel === 'text';
      var kind = carrier ? 'carrier' : missed ? 'missed' : isText ? 'text' : 'call';
      var why = latest.summary || (kind === 'missed' ? 'They called and nobody picked up.' : isText ? 'Texted you.' : 'A call that needs a reply.');
      var urgent = calls.some(function (c) { return c.urgent === true; });
      var promised = calls.some(function (c) { return (c.promises || []).some(function (q) { return q && q.who === 'jo'; }); });
      var replyBy = at + KINDS[kind].windowMs;
      if (urgent) replyBy = Math.min(replyBy, at + 30 * MIN);
      add(p, kind, replyBy, (urgent ? 'Marked urgent. ' : promised ? 'You promised something. ' : '') + why, {
        atMs: at, count: calls.length, urgent: urgent,
      });
      calls.forEach(function (c) { if (c.id) p.callIds.push(c.id); });
      p.snippet = p.snippet || clip(latest.summary || '', 120);
      p.lastAt = Math.max(p.lastAt || 0, at);
    });

    // new web leads: stage "new", created in the last 7 days, not snoozed
    leads.forEach(function (l) {
      if (!l || l.deleted === true || l.id == null) return;
      var sk = String(l._stageKey || l.stage || '').toLowerCase();
      if (sk !== 'new') return;
      var made = toMs(l.createdAt);
      if (!made || now - made > 7 * DAY) return;
      if (leadSnoozed(l.id)) return;
      var p = person('lead:' + l.id, String(l.id));
      if (!p.name) p.name = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'New lead';
      if (!p.phone) p.phone = digits10(l.phone || l.phoneDigits);
      add(p, 'webLead', made + KINDS.webLead.windowMs, (l.source ? 'New lead from ' + clip(l.source, 30) + '. ' : 'New lead. ') + 'Nobody has been in touch yet.', { atMs: made });
      p.lastAt = Math.max(p.lastAt || 0, made);
    });

    // estimates the customer opened (24 h to answer) or that have gone quiet
    var DAYS = { d2: 2, d5: 5, d10: 10 };
    (o.estimateRows || []).forEach(function (r) {
      if (!r || r.leadId == null) return;
      var id = String(r.leadId);
      if (!byId[id] || leadSnoozed(id)) return;
      var p = person('lead:' + id, id);
      if (!p.name) p.name = r.name || '';
      if (r.opened && r.openedAtMs) {
        add(p, 'estimate', r.openedAtMs + KINDS.estimate.windowMs, 'Opened your estimate' + (r.openedLabel ? ' (' + clip(r.openedLabel, 30) + ')' : '') + '.', { atMs: r.openedAtMs });
        p.lastAt = Math.max(p.lastAt || 0, r.openedAtMs);
      } else {
        var due = now - Math.max(0, (r.daysOut || 0) - (DAYS[r.bucket] || 0)) * DAY;
        add(p, 'nudge', due, 'Estimate went out ' + (r.daysOut || 0) + ' day' + (r.daysOut === 1 ? '' : 's') + ' ago; no answer yet.', { atMs: due });
      }
    });

    // nudges from the Today plan: overdue / due tasks, stalled follow-ups
    var plan = o.plan || {};
    (plan.promised || []).forEach(function (r) {
      if (!r || !r.leadId) return;
      var id = String(r.leadId);
      if (!byId[id] || leadSnoozed(id)) return;
      var p = person('lead:' + id, id);
      if (!p.name) p.name = r.name || '';
      if (!p.phone) p.phone = digits10(r.phone);
      var by = ymdEnd(r.dueYmd) || endOfDay(now);
      var t = (r.tasks || [])[0];
      var why = (r.promises && r.promises.length) ? 'You promised: ' + clip(r.promises[0], 90) : (r.overdue ? 'Overdue: ' : 'Due today: ') + clip((t && (t.text || t.title)) || 'a task you set', 90);
      add(p, 'nudge', by, why, { atMs: by });
      (r.tasks || []).forEach(function (tk) { if (tk && tk.id) p.taskRefs.push({ leadId: id, taskId: tk.id }); });
    });
    (plan.stalled || []).forEach(function (r) {
      if (!r || !r.leadId) return;
      var id = String(r.leadId);
      if (!byId[id] || leadSnoozed(id)) return;
      var p = person('lead:' + id, id);
      if (!p.name) p.name = r.name || '';
      if (!p.phone) p.phone = digits10(r.phone);
      var late = r.daysLate || 0;
      var by = late > 0 ? endOfDay(now) - late * DAY : endOfDay(now);
      add(p, 'nudge', by, late > 0 ? 'Follow-up was due ' + late + ' day' + (late === 1 ? '' : 's') + ' ago.' : 'Follow-up is due today.', { atMs: by });
    });

    // AI reply drafts waiting on the rep (never sent until the rep sends)
    (o.aiDrafts || []).forEach(function (d) {
      if (!d || !d.leadId || d.status !== 'pending') return;
      var id = String(d.leadId);
      var p = person('lead:' + id, id);
      var lead = byId[id];
      if (!p.name) p.name = (lead && ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()) || '';
      if (!p.phone) p.phone = digits10(lead && (lead.phone || lead.phoneDigits));
      var at = toMs(d.generatedAt) || now;
      add(p, 'draft', at + KINDS.draft.windowMs, 'A drafted reply is waiting' + (d.inboundText ? ': they texted "' + clip(d.inboundText, 70) + '"' : '.'), {
        atMs: at, draftId: d.id, draftText: String(d.draftText || ''),
      });
      p.draftRefs.push({ leadId: id, draftId: d.id });
      p.lastAt = Math.max(p.lastAt || 0, at);
    });
    (o.agentDrafts || []).forEach(function (d) {
      if (!d || !d.leadId || (d.kind !== 'draft_text' && d.kind !== 'draft_email')) return;
      var id = String(d.leadId);
      var p = person('lead:' + id, id);
      var lead = byId[id];
      if (!p.name) p.name = (lead && ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()) || '';
      var at = toMs(d.createdAt) || now;
      add(p, 'agent', at + KINDS.agent.windowMs, 'A team bot drafted a ' + (d.kind === 'draft_email' ? 'email' : 'text') + ' for you to review.', { atMs: at, agentId: d.id, draftText: String(d.text || d.body || '') });
      p.agentIds.push(d.id);
    });

    var out = [];
    order.forEach(function (key) {
      var p = people[key];
      if (typeof o.skip === 'function' && o.skip(key)) return;
      if (!p.reasons.length) return;
      p.reasons.sort(function (a, b) { return a.replyByMs - b.replyByMs || a.rank - b.rank; });
      var main = p.reasons[0];
      p.primary = main.kind;
      p.why = main.why;
      p.replyByMs = main.replyByMs;
      p.timer = main.timer;
      p.folders = p.reasons.map(function (r) { return r.folder; });
      p.kinds = p.reasons.map(function (r) { return r.kind; });
      var withDraft = p.reasons.filter(function (r) { return r.draftText; })[0];
      p.suggested = suggestFor(withDraft ? withDraft.kind : main.kind, p.name, withDraft && withDraft.draftText);
      p.name = p.name || (p.phone ? fmtPhone(p.phone) : 'Unknown caller');
      out.push(p);
    });
    out.sort(function (a, b) { return a.replyByMs - b.replyByMs || String(a.name).localeCompare(String(b.name)); });
    return out;
  }

  function fmtPhone(d) { var s = digits10(d); return s ? '(' + s.slice(0, 3) + ') ' + s.slice(3, 6) + '-' + s.slice(6) : String(d || ''); }

  function folderCounts(items) {
    var c = { all: items.length };
    FOLDERS.forEach(function (f) { if (f[0] !== 'all') c[f[0]] = 0; });
    items.forEach(function (it) {
      var seen = {};
      it.folders.forEach(function (f) { if (!seen[f]) { seen[f] = 1; c[f] = (c[f] || 0) + 1; } });
    });
    return c;
  }
  function inFolder(it, folder) { return folder === 'all' || it.folders.indexOf(folder) !== -1; }

  /** Thread rows from sms_log / email_log docs + call summaries, oldest first. */
  function threadRows(sms, emails, calls) {
    var rows = [];
    (sms || []).forEach(function (d) {
      var inb = d.direction === 'inbound' || d.status === 'received';
      // A text the server REFUSED (declined consent, C-7) was never sent: say so
      // instead of drawing it as an ordinary outbound bubble.
      var refused = d.refused === true ? 'Not sent — consent declined: ' : '';
      rows.push({ dir: inb ? 'in' : 'out', channel: 'text', at: toMs(d.date || d.sentAt), body: refused + String(d.body || d.message || '') });
    });
    (emails || []).forEach(function (d) {
      rows.push({ dir: d.direction === 'inbound' ? 'in' : 'out', channel: 'email', at: toMs(d.date || d.sentAt), body: String(d.subject || 'Email') });
    });
    (calls || []).forEach(function (c) {
      var isText = c.channel === 'text';
      var body = c.summary ? String(c.summary) : (isText ? (c.messageCount || 0) + ' text(s) that day' : 'Phone call');
      rows.push({ dir: 'note', channel: isText ? 'text-day' : 'call', at: toMs(c.startedAtMs), body: body });
    });
    return rows.filter(function (r) { return r.at || r.body; }).sort(function (a, b) { return a.at - b.at; });
  }

  /** Pipeline pane: leads grouped by stage, in the board's stage order. */
  function groupByStage(leads, stageOrder, labelOf, perStage) {
    var by = {}, seen = [];
    (leads || []).forEach(function (l) {
      if (!l || l.deleted === true || l.id == null) return;
      var k = String(l._stageKey || l.stage || 'new');
      if (!by[k]) { by[k] = []; seen.push(k); }
      by[k].push(l);
    });
    var keys = (stageOrder || []).filter(function (k) { return by[k]; });
    seen.forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k); });
    var cap = perStage || 25;
    return keys.map(function (k) {
      return { key: k, label: (typeof labelOf === 'function' && labelOf(k)) || k, total: by[k].length, leads: by[k].slice(0, cap) };
    });
  }

  var logic = {
    KINDS: KINDS, FOLDERS: FOLDERS, timer: timer, suggestFor: suggestFor, buildItems: buildItems,
    folderCounts: folderCounts, inFolder: inFolder, threadRows: threadRows, groupByStage: groupByStage,
    personKeyOfCall: personKeyOfCall, dur: dur,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = logic;
  if (!root) return;
  root.NBDInboxLogic = logic;

  // ── browser: the layout ──────────────────────────────────────────────
  var W = root, doc = root.document;
  var K = W.NBDLayoutKit, E = W.LayoutEngine;
  if (!K || !E) return;
  var esc = K.esc;
  var DAY_KEY = 'nbd_inbox_day';
  var CALL_LIMIT = 200, TEXT_LIMIT = 100, DRAFT_LIMIT = 10, DRAFT_LEADS = 15, THREAD_LIMIT = 30;
  var rootEl = null, mounted = false, mo = null, timerId = null, unbind = [], clock = null;
  var S = { pane: 'inbox', folder: 'all', sel: '', mobile: 'list', menu: false };
  var feeds = {
    calls: { state: 'loading', rows: [], err: '' },
    drafts: { state: 'loading', rows: [], err: '' },
    agent: { state: 'idle', rows: [], err: '' },
  };
  var threads = {};                 // person key -> { state, rows, err }
  var composer = {};                // person key -> typed text (kept while you move around)
  var sending = {};
  var itemsCache = [];
  var lastHtml = '';

  function ls(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function ymd() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function day() {
    var d = null; try { d = JSON.parse(ls(DAY_KEY) || 'null'); } catch (e) {}
    if (!d || d.ymd !== ymd()) d = { ymd: ymd(), aside: {} };
    return d;
  }
  function saveDay(d) { try { localStorage.setItem(DAY_KEY, JSON.stringify(d)); } catch (e) {} }
  function toast(m, t) { if (typeof W.showToast === 'function') W.showToast(m, t || 'info'); }
  function claims() { return W._userClaims || {}; }
  function uid() { return (W._user && W._user.uid) || null; }
  function leads() { return Array.isArray(W._leads) ? W._leads : []; }
  function leadById(id) {
    var l = leads();
    for (var i = 0; i < l.length; i++) if (l[i] && String(l[i].id) === String(id)) return l[i];
    return null;
  }
  function fbReady() { return !!(W.db && W.getDocs && W.query && W.where && W.collection && W.orderBy && W.limit); }
  function plan() {
    try { if (W.NBDToday && W.NBDToday.compute && W._leadsLoaded === true) return W.NBDToday.compute(); } catch (e) {}
    return null;
  }
  function activeView() { var v = doc.querySelector('.view.active'); return v && v.id ? v.id.replace(/^view-/, '') : ''; }
  function homeActive() { var a = activeView(); return !a || a === 'home'; }

  // ── reads: bounded, each with its own honest failure ─────────────────
  function codeOf(e) { return (e && (e.code || e.message)) || 'error'; }
  function loadCalls() {
    feeds.calls.state = 'loading';
    var u = uid();
    if (!u || !fbReady()) { feeds.calls.state = 'error'; feeds.calls.err = 'Not signed in yet.'; return Promise.resolve(); }
    var rows = [];
    var a = W.getDocs(W.query(W.collection(W.db, 'phone_calls'), W.where('userId', '==', u), W.orderBy('startedAtMs', 'desc'), W.limit(CALL_LIMIT)))
      .then(function (snap) { snap.docs.forEach(function (d) { rows.push(Object.assign({ id: d.id, channel: 'call' }, d.data())); }); });
    var b = W.getDocs(W.query(W.collection(W.db, 'phone_text_days'), W.where('userId', '==', u), W.orderBy('startedAtMs', 'desc'), W.limit(TEXT_LIMIT)))
      .then(function (snap) { snap.docs.forEach(function (d) { rows.push(Object.assign({ id: d.id, channel: 'text' }, d.data())); }); });
    return Promise.all([a, b]).then(function () {
      var HA = W.NBDHomeAttention;
      if (!HA || typeof HA.groupNeeds !== 'function') {
        // without the shared "needs you" rule the list would silently drop every call
        feeds.calls.rows = []; feeds.calls.state = 'error'; feeds.calls.err = 'needs-you rule not loaded';
        return;
      }
      feeds.calls.rows = rows; feeds.calls.state = 'ok'; feeds.calls.err = '';
    }, function (e) {
      feeds.calls.state = 'error'; feeds.calls.err = codeOf(e);
    });
  }
  // ai_drafts is readable only per lead (its rule is per-document and there is
  // no collection-group rule, so a collectionGroup query is permission-denied).
  // So: the customers who texted in the last 14 days, newest first, at most
  // DRAFT_LEADS of them, each asked with the panel's own two-equality query.
  function loadDrafts() {
    feeds.drafts.state = 'loading';
    var u = uid();
    if (!u || !fbReady()) { feeds.drafts.state = 'error'; feeds.drafts.err = 'Not signed in yet.'; return Promise.resolve(); }
    var cutoff = Date.now() - 14 * DAY;
    var seen = {}, ids = [];
    feeds.calls.rows.slice().sort(function (x, y) { return toMs(y.startedAtMs) - toMs(x.startedAtMs); }).forEach(function (r) {
      if (r.channel !== 'text' || !r.leadId || toMs(r.startedAtMs) < cutoff || seen[r.leadId] || ids.length >= DRAFT_LEADS) return;
      seen[r.leadId] = 1; ids.push(String(r.leadId));
    });
    var rows = [], failed = [];
    var jobs = ids.map(function (id) {
      return W.getDocs(W.query(W.collection(W.db, 'leads', id, 'ai_drafts'), W.where('userId', '==', u), W.where('status', '==', 'pending'), W.limit(DRAFT_LIMIT)))
        .then(function (snap) { snap.docs.forEach(function (d) { rows.push(Object.assign({ id: d.id, leadId: id }, d.data())); }); },
          function (e) { failed.push(codeOf(e)); });
    });
    return Promise.all(jobs).then(function () {
      feeds.drafts.rows = rows;
      if (failed.length) { feeds.drafts.state = 'error'; feeds.drafts.err = failed.length + ' of ' + ids.length + ' customers: ' + failed[0]; }
      else { feeds.drafts.state = 'ok'; feeds.drafts.err = ''; }
    });
  }
  function agentAllowed() {
    var c = claims();
    return c.role === 'company_admin' || c.role === 'admin' || c.owner === true || !c.companyId;
  }
  function loadAgent() {
    if (!agentAllowed() || !fbReady()) { feeds.agent.state = 'idle'; feeds.agent.rows = []; return Promise.resolve(); }
    feeds.agent.state = 'loading';
    var c = claims();
    var key = c.companyId || uid();
    return W.getDocs(W.query(W.collection(W.db, 'agent_inbox'), W.where('companyId', '==', key), W.where('status', '==', 'pending'), W.limit(50)))
      .then(function (snap) {
        feeds.agent.rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        feeds.agent.state = 'ok'; feeds.agent.err = '';
      }, function (e) { feeds.agent.state = 'error'; feeds.agent.err = codeOf(e); });
  }
  function loadAll() {
    render();
    return Promise.all([loadCalls().then(loadDrafts), loadAgent()]).then(function () { render(); });
  }

  // ── the list ─────────────────────────────────────────────────────────
  function groupsOf(rows) {
    var HA = W.NBDHomeAttention;
    if (HA && typeof HA.groupNeeds === 'function') { try { return HA.groupNeeds(rows, Date.now()); } catch (e) {} }
    return [];
  }
  function compute() {
    var d = day();
    var EF = W.NBDEstimateFollowups, est = [];
    if (EF && typeof EF.computeFollowups === 'function') { try { est = EF.computeFollowups(leads(), Date.now()).rows || []; } catch (e) { est = []; } }
    itemsCache = buildItems({
      now: Date.now(), groups: groupsOf(feeds.calls.rows), leads: leads(), estimateRows: est, plan: plan(),
      aiDrafts: feeds.drafts.rows, agentDrafts: feeds.agent.rows,
      isSnoozed: W.LeadSnooze && typeof W.LeadSnooze.isSnoozed === 'function' ? W.LeadSnooze.isSnoozed : null,
      skip: function (key) { return !!d.aside[key]; },
    });
    return itemsCache;
  }
  function itemByKey(key) {
    for (var i = 0; i < itemsCache.length; i++) if (itemsCache[i].key === key) return itemsCache[i];
    return null;
  }
  function pipelineLeads() {
    var order = Array.isArray(W._stageKeys) ? W._stageKeys : [];
    var meta = W.STAGE_META || {};
    return groupByStage(leads(), order, function (k) { return meta[k] && meta[k].label; }, 25);
  }
  function pseudoItem(l) {
    var name = K.leadName(l);
    return {
      key: 'lead:' + l.id, leadId: String(l.id), name: name, phone: digits10(l.phone || l.phoneDigits),
      reasons: [], kinds: [], folders: [], callIds: [], taskRefs: [], draftRefs: [], agentIds: [],
      why: 'On your pipeline', suggested: suggestFor('', name), timer: null, primary: '', pipeline: true,
    };
  }
  function selectedItem() {
    if (!S.sel) return null;
    var it = itemByKey(S.sel);
    if (it) return it;
    var m = /^lead:(.+)$/.exec(S.sel);
    if (m) { var l = leadById(m[1]); if (l) return pseudoItem(l); }
    return null;
  }
  function visibleKeys() {
    if (S.pane === 'pipeline') {
      var ks = [];
      pipelineLeads().forEach(function (g) { g.leads.forEach(function (l) { ks.push('lead:' + l.id); }); });
      return ks;
    }
    return itemsCache.filter(function (it) { return inFolder(it, S.folder); }).map(function (it) { return it.key; });
  }

  // ── thread ───────────────────────────────────────────────────────────
  function loadThread(it, force) {
    var t = threads[it.key];
    if (t && t.state !== 'error' && !force) return;
    var lead = it.leadId;
    var callRows = feeds.calls.rows.filter(function (c) { return personKeyOfCall(c) === it.key; });
    if (!lead) {
      threads[it.key] = { state: 'ok', rows: threadRows([], [], callRows), err: '', noLead: true };
      return;
    }
    if (!fbReady()) { threads[it.key] = { state: 'error', rows: [], err: 'Not signed in yet.' }; return; }
    threads[it.key] = { state: 'loading', rows: [], err: '' };
    var c = claims(), u = uid();
    var team = !!(c.companyId && (c.role === 'company_admin' || c.role === 'manager' || c.role === 'viewer' || c.owner === true));
    var scope = team ? W.where('companyId', '==', c.companyId) : W.where('uid', '==', u);
    var smsQ = W.query(W.collection(W.db, 'sms_log'), W.where('leadId', '==', lead), scope, W.orderBy('date', 'desc'), W.limit(THREAD_LIMIT));
    var emQ = W.query(W.collection(W.db, 'email_log'), W.where('leadId', '==', lead), scope, W.orderBy('date', 'desc'), W.limit(THREAD_LIMIT));
    Promise.all([W.getDocs(smsQ), W.getDocs(emQ)]).then(function (res) {
      var sms = res[0].docs.map(function (d) { return d.data(); });
      var em = res[1].docs.map(function (d) { return d.data(); });
      threads[it.key] = { state: 'ok', rows: threadRows(sms, em, callRows), err: '' };
      render();
    }, function (e) {
      threads[it.key] = { state: 'error', rows: [], err: codeOf(e) };
      render();
    });
  }

  // ── render ───────────────────────────────────────────────────────────
  function fmtAt(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    var same = d.toDateString() === now.toDateString();
    return same ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function chipHtml(t) {
    if (!t) return '';
    return '<span class="ib-timer ib-timer-' + esc(t.state) + '" data-ib-timer>' + esc(t.label) + '</span>';
  }
  function bannerHtml() {
    var bad = [];
    if (feeds.calls.state === 'error') bad.push('calls and texts (' + feeds.calls.err + ')');
    if (feeds.drafts.state === 'error') bad.push('reply drafts (' + feeds.drafts.err + ')');
    if (feeds.agent.state === 'error') bad.push('team drafts (' + feeds.agent.err + ')');
    if (W._leadsLoaded !== true && leads().length === 0) return '';
    if (!bad.length) return '';
    return '<div class="ib-banner" role="alert">Some feeds did not load: ' + esc(bad.join('; ')) +
      '. What you see below may be missing items. <button type="button" class="ib-linkbtn" data-ib="reload">Try again</button></div>';
  }
  function loadingAny() {
    return feeds.calls.state === 'loading' || feeds.drafts.state === 'loading' || feeds.agent.state === 'loading' || W._leadsLoaded !== true;
  }
  function allFeedsOk() {
    return feeds.calls.state === 'ok' && feeds.drafts.state === 'ok' && feeds.agent.state !== 'error' && W._leadsLoaded === true;
  }

  function railHtml(counts) {
    var h = '<nav class="ib-rail" aria-label="Folders">';
    h += '<div class="ib-switch" role="tablist">' +
      '<button type="button" role="tab" class="ib-tab' + (S.pane === 'inbox' ? ' is-on' : '') + '" data-ib="pane" data-pane="inbox" aria-selected="' + (S.pane === 'inbox') + '">Inbox</button>' +
      '<button type="button" role="tab" class="ib-tab' + (S.pane === 'pipeline' ? ' is-on' : '') + '" data-ib="pane" data-pane="pipeline" aria-selected="' + (S.pane === 'pipeline') + '">Pipeline</button></div>';
    if (S.pane === 'inbox') {
      FOLDERS.forEach(function (f) {
        h += '<button type="button" class="ib-folder' + (S.folder === f[0] ? ' is-on' : '') + '" data-ib="folder" data-folder="' + f[0] + '">' +
          '<span>' + esc(f[1]) + '</span><span class="ib-count">' + (counts[f[0]] || 0) + '</span></button>';
      });
    }
    h += '<button type="button" class="ib-folder ib-menu-btn" data-ib="menu" aria-expanded="' + S.menu + '"><span>Menu</span></button>';
    if (S.menu) {
      h += '<div class="ib-sheet" role="menu">' + K.menuItems('ib') + '</div>';
    }
    return h + '</nav>';
  }

  function rowHtml(it) {
    var on = it.key === S.sel;
    var kinds = it.kinds.slice(0, 3).map(function (k) { return KINDS[k] ? KINDS[k].label : k; });
    var uniq = kinds.filter(function (k, i) { return kinds.indexOf(k) === i; });
    return '<button type="button" class="ib-row' + (on ? ' is-on' : '') + '" data-ib="select" data-key="' + esc(it.key) + '" aria-current="' + on + '">' +
      '<span class="ib-row-top"><span class="ib-dot" aria-hidden="true"></span><span class="ib-name">' + esc(it.name) + '</span>' + chipHtml(it.timer) + '</span>' +
      '<span class="ib-row-why">' + esc(it.why) + '</span>' +
      '<span class="ib-row-kinds">' + uniq.map(function (k) { return '<span class="ib-kind">' + esc(k) + '</span>'; }).join('') +
      (it.callIds.length > 1 ? '<span class="ib-kind">' + it.callIds.length + ' calls</span>' : '') + '</span></button>';
  }
  function listHtml() {
    var h = '';
    if (S.pane === 'pipeline') {
      if (W._leadsLoaded !== true && leads().length === 0) return '<div class="ib-state" role="status">Loading your pipeline&hellip;</div>';
      var groups = pipelineLeads();
      if (!groups.length) return '<div class="ib-state">No leads yet.</div>';
      groups.forEach(function (g) {
        h += '<div class="ib-stage"><span>' + esc(g.label) + '</span><span class="ib-count">' + g.total + '</span></div>';
        g.leads.forEach(function (l) {
          var it = K.fromLead(l, {});
          h += '<div role="button" tabindex="0" class="ib-row ib-row-lead' + (S.sel === 'lead:' + l.id ? ' is-on' : '') + '" data-ib="select" data-key="lead:' + esc(l.id) + '">' +
            K.card(it, { density: 'row' }) + '</div>';
        });
        if (g.total > g.leads.length) h += '<div class="ib-more">+' + (g.total - g.leads.length) + ' more in this stage (open the Classic pipeline)</div>';
      });
      return h;
    }
    var items = itemsCache.filter(function (it) { return inFolder(it, S.folder); });
    if (!items.length) {
      if (loadingAny()) return '<div class="ib-state" role="status">Loading your inbox&hellip;</div>';
      if (!allFeedsOk()) return '<div class="ib-state ib-state-warn" role="alert">Could not show this list because a feed failed to load. Use Try again above.</div>';
      return '<div class="ib-state"><b>Nothing needs a reply.</b><br>' + (S.folder === 'all' ? 'New texts, calls and leads will land here.' : 'Nothing in this folder right now.') + '</div>';
    }
    items.forEach(function (it) { h += rowHtml(it); });
    return h;
  }

  function threadHtml(it) {
    if (!it) return '<div class="ib-state">Pick someone from the list. <span class="ib-hint">J / K to move, R to reply.</span></div>';
    var t = threads[it.key];
    var h = '<div class="ib-thread-head"><button type="button" class="ib-back" data-ib="back">&larr; List</button><h2 class="ib-title">' + esc(it.name) + '</h2>' +
      (it.timer ? chipHtml(it.timer) : '') +
      K.recordEntry({ source: 'inbox', leadId: it.leadId || '', cls: 'ib-rec' }) + '</div>';
    if (it.why && !it.pipeline) h += '<p class="ib-why"><span class="ib-why-k">Why it is here</span> ' + esc(it.why) + '</p>';
    h += '<div class="ib-msgs" aria-live="polite">';
    if (!t || t.state === 'loading') h += '<div class="ib-state" role="status">Loading messages&hellip;</div>';
    else if (t.state === 'error') h += '<div class="ib-state ib-state-warn" role="alert">Could not load this thread (' + esc(t.err) + '). <button type="button" class="ib-linkbtn" data-ib="retry">Try again</button></div>';
    else if (!t.rows.length) h += '<div class="ib-state">No messages on file for ' + (t.noLead ? 'this number. It is not filed on a customer yet.' : 'this customer yet.') + '</div>';
    else {
      t.rows.forEach(function (r) {
        h += '<div class="ib-msg ib-msg-' + r.dir + '"><div class="ib-bubble">' + esc(clip(r.body, 600)) + '</div><div class="ib-msg-at">' +
          esc(r.channel === 'text-day' ? 'Texts' : r.channel === 'call' ? 'Call' : r.channel === 'email' ? 'Email' : 'Text') + ' &middot; ' + esc(fmtAt(r.at)) + '</div></div>';
      });
    }
    h += '</div>';
    h += composerHtml(it);
    return h;
  }
  function composerHtml(it) {
    var val = composer[it.key] != null ? composer[it.key] : it.suggested;
    var agentOnly = it.reasons.some(function (r) { return r.kind === 'agent'; }) && !it.reasons.some(function (r) { return r.kind === 'draft'; });
    var canText = !!(it.phone || (it.leadId && leadById(it.leadId) && leadById(it.leadId).email));
    var h = '<div class="ib-composer"><label class="ib-comp-k" for="ibComposer">Drafted reply &middot; nothing is sent until you press Send, and then it opens in your messages</label>' +
      '<textarea id="ibComposer" class="ib-text" rows="4" data-key="' + esc(it.key) + '" spellcheck="true">' + esc(val) + '</textarea>' +
      '<div class="ib-comp-row">';
    if (agentOnly) {
      h += '<button type="button" class="ib-btn ib-btn-primary" data-ib="agent">Review in Agent inbox</button>';
    } else {
      h += '<button type="button" class="ib-btn ib-btn-primary" data-ib="send"' + (canText && !sending[it.key] ? '' : ' disabled') + '>' + (sending[it.key] ? 'Checking&hellip;' : 'Send') + '</button>';
    }
    h += '<button type="button" class="ib-btn" data-ib="reset">Reset to suggestion</button>';
    if (!canText && !agentOnly) h += '<span class="ib-hint">No phone or email on file.</span>';
    return h + '</div></div>';
  }

  function factsHtml(it) {
    if (!it) return '<div class="ib-state ib-facts-empty">Facts and quick actions show here.</div>';
    var lead = it.leadId ? leadById(it.leadId) : null;
    var base = K.fromLead(lead || { id: it.leadId || '' }, { name: it.name, phone: it.phone, why: it.why });
    var meta = W.STAGE_META || {};
    var sk = lead && (lead._stageKey || lead.stage);
    var rows = [];
    if (K.fmtPhone(base.phone)) rows.push(['Phone', K.fmtPhone(base.phone)]);
    if (base.address) rows.push(['Address', base.address]);
    if (sk) rows.push(['Stage', (meta[sk] && meta[sk].label) || sk]);
    if (lead && lead.source) rows.push(['Source', String(lead.source)]);
    var h = '<h3 class="ib-facts-name">' + esc(it.name) + '</h3>';
    if (rows.length) h += '<dl class="ib-facts">' + rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>';
    else h += '<p class="ib-hint">Not filed on a customer yet. Attach this number in the Call Center.</p>';
    if (it.reasons.length) {
      h += '<div class="ib-facts-k">Waiting on you</div><ul class="ib-reasons">' + it.reasons.map(function (r) {
        return '<li>' + chipHtml(r.timer) + ' <b>' + esc(r.label) + '</b> ' + esc(r.why) + '</li>';
      }).join('') + '</ul>';
    }
    h += K.actionBar(base, ['call', 'navigate', 'open', 'snooze', 'done'], { size: 'sm', labels: { done: it.pipeline ? 'Set aside' : 'Done' } });
    h += '<p class="ib-hint">Done marks calls handled and ticks tasks you set. Anything else is set aside on this device until tomorrow; the CRM record is not changed.</p>';
    return h;
  }

  function legendHtml() {
    return '<div class="ib-legend" role="note"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>R</kbd> reply</span><span><kbd>E</kbd> done</span><span><kbd>S</kbd> snooze</span><span><kbd>Esc</kbd> back</span></div>';
  }

  function render() {
    if (!rootEl) return;
    var active = doc.activeElement;
    var typing = active && active.id === 'ibComposer';
    var typed = typing ? { start: active.selectionStart, end: active.selectionEnd, key: active.getAttribute('data-key') } : null;
    var items = compute();
    var counts = folderCounts(items);
    if (S.sel && !selectedItem()) S.sel = '';
    var it = selectedItem();
    if (it && !threads[it.key]) loadThread(it);
    rootEl.setAttribute('data-pane', S.pane);
    rootEl.setAttribute('data-mobile', S.mobile);
    // Record visit: on the thread (with that customer) when one is open, on the
    // list otherwise. inbox.css hides the list's copy beside an open thread on
    // a wide screen, so there is one Record button in view, never two.
    rootEl.setAttribute('data-sel', it ? '1' : '0');
    var listRec = K.recordEntry({ source: 'inbox', cls: 'ib-rec ib-rec-list' });
    var head = S.pane === 'inbox'
      ? '<div class="ib-headline"><span><b>' + items.length + '</b> ' + (items.length === 1 ? 'person needs' : 'people need') + ' a reply</span>' + listRec + '</div>'
      : '<div class="ib-headline"><span><b>' + leads().length + '</b> leads on your pipeline</span>' + listRec + '</div>';
    // data-cwk-slot: "What closes this week" (js/closes-week.js) as ONE line
    // above the list that opens the card, so the replies stay in view (audit D4).
    var html = '<div class="ib-wrap">' + railHtml(counts) +
      '<section class="ib-list" aria-label="' + (S.pane === 'inbox' ? 'Inbox' : 'Pipeline by stage') + '">' + head + bannerHtml() + '<div data-ns-slot="inbox" data-ns-variant="compact"></div><div data-cwk-slot="inbox" data-cwk-compact="1"></div><div class="ib-scroll">' + listHtml() + '</div></section>' +
      '<section class="ib-thread" aria-label="Thread">' + threadHtml(it) + '</section>' +
      '<aside class="ib-side" aria-label="Customer facts">' + factsHtml(it) + '</aside>' +
      legendHtml() + '</div>';
    K.setOverlay(rootEl, homeActive());
    // Same markup as last time (a refresh event with nothing new, a minute tick
    // with no chip change): leave the DOM alone. Replacing it under a press
    // loses the click, and a scroll position / caret with it.
    if (html === lastHtml) return;
    lastHtml = html;
    var scrollEl = rootEl.querySelector('.ib-scroll');
    var keepScroll = scrollEl ? scrollEl.scrollTop : 0;
    rootEl.innerHTML = html;
    var scrollNew = rootEl.querySelector('.ib-scroll');
    if (scrollNew && keepScroll) scrollNew.scrollTop = keepScroll;
    if (typed) {
      var ta = doc.getElementById('ibComposer');
      if (ta && ta.getAttribute('data-key') === typed.key) { ta.focus(); try { ta.setSelectionRange(typed.start, typed.end); } catch (e) {} }
    }
    var cur = rootEl.querySelector('.ib-row.is-on');
    if (cur && cur.scrollIntoView && !typing) { try { cur.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
  }

  // ── actions ──────────────────────────────────────────────────────────
  function callable(name, data) {
    var go = function () { return W._httpsCallable(W._functions, name)(data).then(function (r) { return r && r.data; }); };
    if (W._functions && W._httpsCallable) return go();
    return import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (mod) {
      W._functions = W._functions || mod.getFunctions();
      W._httpsCallable = W._httpsCallable || mod.httpsCallable;
      return go();
    });
  }
  function move(delta) {
    var ks = visibleKeys();
    if (!ks.length) return;
    var i = ks.indexOf(S.sel);
    i = i === -1 ? (delta > 0 ? 0 : ks.length - 1) : Math.max(0, Math.min(ks.length - 1, i + delta));
    S.sel = ks[i];
    S.mobile = 'thread';
    render();
  }
  function select(key) { S.sel = key; S.mobile = 'thread'; render(); }
  function focusComposer() {
    S.mobile = 'thread';
    var ta = doc.getElementById('ibComposer');
    if (!ta) { render(); ta = doc.getElementById('ibComposer'); }
    if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} }
  }
  function asideKey(key) { var d = day(); d.aside[key] = Date.now(); saveDay(d); }
  function doDone() {
    var it = selectedItem();
    if (!it) return;
    var ks = visibleKeys(), i = ks.indexOf(it.key);
    var jobs = [];
    var wrote = false;
    if (it.callIds.length) {
      it.callIds.forEach(function (id) { jobs.push(callable('callCenterAction', { id: id, action: 'handled' })); });
      wrote = true;
    }
    var T = W.NBDTasks;
    if (it.taskRefs.length && T && typeof T.setDone === 'function') {
      it.taskRefs.forEach(function (r) { jobs.push(Promise.resolve(T.setDone(r.leadId, r.taskId)).then(function (ok) { if (!ok) throw new Error('task'); })); });
      wrote = true;
    }
    Promise.all(jobs).then(function () {
      asideKey(it.key);
      if (it.callIds.length) loadCalls().then(render);
      toast(wrote ? 'Done. Marked handled for ' + (it.name || 'this person') + '.' : 'Set aside on this device until tomorrow. The CRM record was not changed.', 'info');
      var after = visibleKeys();
      S.sel = after[Math.min(i, after.length - 1)] || '';
      render();
    }, function () {
      toast('Could not save that. Check your connection and try again. Nothing was changed.', 'error');
    });
  }
  function doSnooze() {
    var it = selectedItem();
    if (!it) return;
    if (it.leadId && W.LeadSnooze && typeof W.LeadSnooze.prompt === 'function') { W.LeadSnooze.prompt(it.leadId, it.name || ''); return; }
    toast(it.leadId ? 'Snooze is still loading. Try again in a moment.' : 'Snooze needs a customer on file. Attach this number in the Call Center first.', 'info');
  }
  function doSend() {
    var it = selectedItem();
    var ta = doc.getElementById('ibComposer');
    if (!it || !ta || sending[it.key]) return;
    var text = String(ta.value || '').trim();
    if (!text) { toast('Write something first. Nothing was sent.', 'info'); return; }
    var PS = W.NBDPhoneShare;
    if (!PS || typeof PS.share !== 'function') { toast('Texting is still loading. Nothing was sent.', 'info'); return; }
    var lead = it.leadId ? leadById(it.leadId) : null;
    composer[it.key] = text;
    sending[it.key] = true;
    render();
    PS.share({
      text: text, phone: it.phone || '', email: lead && lead.email || '', subject: 'Following up', leadId: it.leadId || undefined,
      recipient: it.leadId ? 'homeowner' : 'number', preferSms: true, source: 'triage_inbox',
    }).then(function (r) {
      sending[it.key] = false;
      if (r && r.shared) {
        toast('Logged as sent from your phone.', 'info');
        delete composer[it.key];
        delete threads[it.key];
        var dis = it.draftRefs.map(function (ref) {
          return W.updateDoc(W.doc(W.db, 'leads', ref.leadId, 'ai_drafts', ref.draftId), { status: 'dismissed', dismissedAt: W.serverTimestamp ? W.serverTimestamp() : new Date() }).catch(function () {});
        });
        Promise.all(dis).then(function () { return loadDrafts(); }).then(render);
      }
      render();
    }, function () {
      sending[it.key] = false;
      toast('Could not start the text. Nothing was sent.', 'error');
      render();
    });
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-ib]') : null;
    if (!t || !rootEl.contains(t)) return;
    var a = t.getAttribute('data-ib');
    // a real link inside a row (the card's Open arrow) keeps its own job
    var link = ev.target.closest('a[href]');
    if (link && t.contains(link)) return;
    ev.preventDefault();
    if (a === 'select') { select(t.getAttribute('data-key')); return; }
    if (a === 'folder') { S.folder = t.getAttribute('data-folder'); S.sel = ''; S.mobile = 'list'; render(); return; }
    if (a === 'pane') { S.pane = t.getAttribute('data-pane'); S.sel = ''; S.mobile = 'list'; render(); return; }
    if (a === 'menu') { S.menu = !S.menu; render(); return; }
    if (a === 'goto') { S.menu = false; if (typeof W.goTo === 'function') W.goTo(t.getAttribute('data-to')); setTimeout(render, 80); return; }
    if (a === 'back') { S.mobile = 'list'; render(); return; }
    if (a === 'reload') { loadAll(); return; }
    if (a === 'retry') { var it = selectedItem(); if (it) { loadThread(it, true); render(); } return; }
    if (a === 'send') { doSend(); return; }
    if (a === 'reset') { var s = selectedItem(); if (s) { delete composer[s.key]; render(); } return; }
    if (a === 'agent') { if (W.NBDAgentInbox && typeof W.NBDAgentInbox.open === 'function') W.NBDAgentInbox.open(); return; }
  }
  function onInput(ev) {
    var ta = ev.target;
    if (ta && ta.id === 'ibComposer') composer[ta.getAttribute('data-key')] = ta.value;
  }
  function typingTarget(el) {
    var tag = el && el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!(el && el.isContentEditable);
  }
  // The dashboard marks its modals aria-modal="true" in the markup whether or
  // not they are open, so that attribute is no signal; nbdModal.anyOpen() is.
  function dialogOpen() {
    if (doc.getElementById('nbd-snooze-overlay')) return true;
    try { if (W.nbdModal && typeof W.nbdModal.anyOpen === 'function' && W.nbdModal.anyOpen()) return true; } catch (e) {}
    return false;
  }
  function onKey(ev) {
    if (!rootEl || rootEl.hidden) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var k = String(ev.key || '').toLowerCase();
    if (typingTarget(ev.target)) {
      if (k === 'escape' && ev.target.id === 'ibComposer') { ev.target.blur(); ev.preventDefault(); }
      return;
    }
    if (dialogOpen()) return;
    // Captured, and stopped when handled: the dashboard's own global hotkeys
    // (dashboard-bootstrap.module.js: E = New Estimate, N = New Lead) are
    // bubble-phase listeners on document, so without this E here would ALSO
    // open a new estimate.
    var own = function () { ev.preventDefault(); ev.stopPropagation(); };
    if (k === 'j') { own(); move(1); }
    else if (k === 'k') { own(); move(-1); }
    else if (k === 'r') { if (selectedItem()) { own(); focusComposer(); } }
    else if (k === 'e') { if (selectedItem()) { own(); doDone(); } }
    else if (k === 's') { if (selectedItem()) { own(); doSnooze(); } }
    else if (k === 'escape') { if (S.mobile === 'thread') { S.mobile = 'list'; render(); } else if (S.menu) { S.menu = false; render(); } }
  }

  // The facts pane's Snooze / Done buttons come from the kit's ActionBar.
  function lookup(id) { var it = S.sel ? selectedItem() : null; return it && String(it.leadId) === String(id) ? { id: id, name: it.name } : { id: id }; }
  function mount() {
    if (mounted) return;
    mounted = true;
    rootEl = doc.createElement('div');
    rootEl.id = 'nbdInboxRoot';
    rootEl.className = 'ib-root';
    doc.body.appendChild(rootEl);
    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('input', onInput);
    doc.addEventListener('keydown', onKey, true);
    W.NBDInbox = { reload: function () { return loadAll(); } };
    unbind.push(K.bind(rootEl, { done: function () { doDone(); }, snooze: function () { doSnooze(); } }, lookup));
    var refresh = function () { render(); };
    var events = ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:estimate-followups'];
    events.forEach(function (n) { W.addEventListener(n, refresh); });
    unbind.push(function () {
      doc.removeEventListener('keydown', onKey, true);
      events.forEach(function (n) { W.removeEventListener(n, refresh); });
    });
    try {
      var raf = null;
      mo = new MutationObserver(function () { if (raf) return; raf = setTimeout(function () { raf = null; if (rootEl) K.setOverlay(rootEl, homeActive()); }, 60); });
      mo.observe(doc.body, { attributes: true, subtree: true, attributeFilter: ['class'] });
    } catch (e) {}
    if (W.NBDToday && typeof W.NBDToday.refreshAppointments === 'function') { try { W.NBDToday.refreshAppointments(); } catch (e) {} }
    loadAll();
    // timers age on their own: re-render each minute (not while typing)
    clock = setInterval(function () { if (rootEl && !rootEl.hidden && !typingTarget(doc.activeElement)) render(); }, 60000);
    var tries = 0;
    timerId = setInterval(function () { tries++; if ((plan() && W._leadsLoaded === true) || tries > 40) { render(); clearInterval(timerId); timerId = null; } }, 1500);
  }
  function unmount() {
    mounted = false;
    if (timerId) clearInterval(timerId);
    if (clock) clearInterval(clock);
    timerId = clock = null;
    try { delete W.NBDInbox; } catch (e) { W.NBDInbox = undefined; }
    rootEl && rootEl.removeEventListener('click', onClick);
    rootEl && rootEl.removeEventListener('input', onInput);
    unbind.forEach(function (f) { try { f(); } catch (e) {} });
    unbind = [];
    if (mo) { mo.disconnect(); mo = null; }
    if (rootEl && rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    rootEl = null;
    K.clearOverlay();
    lastHtml = '';
    S.pane = 'inbox'; S.folder = 'all'; S.sel = ''; S.mobile = 'list'; S.menu = false;
  }

  E.implement('inbox', { mount: mount, unmount: unmount });
})(typeof window !== 'undefined' ? window : null);
