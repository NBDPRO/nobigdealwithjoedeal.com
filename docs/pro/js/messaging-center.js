/**
 * messaging-center.js - the read-only Messaging Control Center view (2026-10-19).
 *
 * Why: Twilio's console shows carrier delivery. It does not show which CRM
 * automation sent a text and why, the consent behind it, what a gate refused,
 * email, queue backlogs or a send to someone who never agreed. This view does,
 * from the CRM's own ledgers, through the `messagingCenter` callable
 * (functions/messaging-center.js). The server masks everything: this file only
 * ever receives a last-4 phone, a masked e-mail, a name, a template id and a
 * first line of at most 80 characters, and scrub() masks a stray number or
 * address again before anything reaches innerHTML.
 *
 * READ-ONLY: no write path, no send button, no toggle. Owner / admin /
 * company_admin only (viewer and sales_rep never see the entry or the data;
 * the callable re-checks). Dark behind the Firestore flag
 * `messagingControlCenter` (feature_flags/_default, absent = off).
 *
 * CSP: no inline script, no inline handler, no style attribute. One delegated
 * listener on the mount. Every server string goes through esc().
 */
(function (root) {
  'use strict';

  var FLAG = 'messagingControlCenter';
  var VIEW_ROLES = ['owner', 'admin', 'company_admin'];
  var TWILIO_LOGS = 'https://console.twilio.com/us1/monitor/logs/sms';
  var CHANNELS = ['sms', 'email', 'push', 'voice'];

  // ── pure ─────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Same rule as functions/messaging-center-logic.js canView (a test keeps them in step).
  function canView(claims, uid) {
    if (!uid) return false;
    var c = claims || {};
    var role = String(c.role || '').toLowerCase();
    if (VIEW_ROLES.indexOf(role) !== -1) return true;
    if (!role) return !c.companyId || c.companyId === uid;
    return false;
  }

  /** Mask a phone-looking or e-mail-looking run again (defence in depth; the server already did). */
  function scrub(t) {
    return String(t == null ? '' : t)
      .replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, function (m) { return m.charAt(0) + '•••@•••'; })
      .replace(/\+?\d[\d\s().-]{5,}\d/g, function (m) {
        var d = m.replace(/\D/g, '');
        return d.length >= 7 && !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) ? '(•••) •••-' + d.slice(-4) : m;
      });
  }
  function clip(t, n) {
    var s = scrub(t).split('\n')[0];
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function ago(ms, now) {
    if (!ms) return 'never';
    var s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' d ago';
  }
  function age(ms) {
    var m = Math.round((ms || 0) / 60000);
    if (m < 90) return m + ' min';
    if (m < 2160) return Math.round(m / 60) + ' h';
    return Math.round(m / 1440) + ' d';
  }
  function when(ms, tz) {
    if (!ms) return '';
    try {
      return new Date(ms).toLocaleString('en-US', { timeZone: tz || 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return new Date(ms).toLocaleString(); }
  }

  function chip(text, cls) { return '<span class="mc-chip ' + (cls || '') + '">' + esc(text) + '</span>'; }
  function stateChip(v) {
    var s = String(v || 'unknown').toLowerCase();
    var cls = s === 'on' || s === 'yes' ? 'mc-ok' : (s === 'off' || s === 'no' || s === 'paused' ? 'mc-off' : 'mc-unk');
    return chip(String(v || 'unknown').toUpperCase(), cls);
  }
  // The kill switch reads in plain words, never a bare ON/OFF whose colour means the opposite.
  function sendChip(v, reason) {
    if (v === 'on') return chip('SENDING ALLOWED', 'mc-ok');
    if (v === 'not_enforced') return chip('NOT ENFORCED YET', 'mc-warn');
    var why = reason === 'unreadable' ? ' (could not read the controls)' : (reason === 'absent' ? ' (no controls document)' : '');
    return chip('CUSTOMER SENDS OFF' + why, 'mc-bad');
  }
  function channelChip(v) { return v === 'on' ? chip('on', 'mc-ok') : (v === 'not_enforced' ? chip('not enforced', 'mc-warn') : chip('OFF', 'mc-bad')); }
  function canaryChip(v) { return v === 'on' ? chip('CANARY: sends go to you, not customers', 'mc-warn') : (v === 'off' ? chip('off (real customers)', 'mc-ok') : chip('unknown', 'mc-unk')); }
  // 'sent' = the provider accepted it, NOT that it arrived: amber, never the green of 'delivered'.
  var OUTCOME_CLS = { sent: 'mc-warn', delivered: 'mc-ok', failed: 'mc-bad', undelivered: 'mc-bad', blocked: 'mc-warn', unknown: 'mc-unk' };
  var OUTCOME_LABEL = { sent: 'accepted, not confirmed' };
  function outcomeLabel(k) { return OUTCOME_LABEL[k] || k; }
  var GATE_CLS = { pass: 'mc-ok', warn: 'mc-warn', fail: 'mc-bad', blocked: 'mc-warn' };
  var RISK_CLS = { HIGH: 'mc-bad', MED: 'mc-warn', LOW: 'mc-unk' };

  function incompleteHtml(o) {
    var un = (o && o.unreadable) || [];
    if (!un.length) return '';
    return '<div class="mc-banner" role="alert"><b>Some data could not be read</b><span class="mc-sub">Not read: ' + esc(un.join(', ')) +
      '. Nothing below can be trusted as complete (a missing Firestore index or a permissions problem is the usual cause).</span></div>';
  }
  function canaryHtml(o) {
    return o && o.canaryOn ? '<div class="mc-note" role="status"><b>Canary is on.</b> Customer messages are being redirected to you, so rows below may show the original customer as the recipient.</div>' : '';
  }
  function bannerHtml(alerts) {
    if (!alerts || !alerts.length) return '';
    return '<div class="mc-banner" role="alert"><b>' + alerts.length + (alerts.length === 1 ? ' alert' : ' alerts') + ' need a look</b><ul>' +
      alerts.map(function (a) {
        return '<li><b>' + esc(scrub(a.title)) + '</b><span class="mc-sub">' + esc(scrub(a.detail)) + '</span></li>';
      }).join('') + '</ul></div>';
  }

  function statusHtml(o) {
    var s = o.status || {};
    var t = s.texting || {};
    var c = s.controls || {};
    var texting = t.enabled === true ? 'on' : (t.enabled === false ? 'off' : 'unknown');
    var rows = (s.automations || []).filter(function (a) { return a.customer || a.flag; }).map(function (a) {
      var eff = a.effective || a.state;
      return '<li><span class="mc-aname">' + esc(a.label) + (a.reason ? '<span class="mc-sub">' + esc(a.reason) + '</span>' : '') + '</span>' + chip(a.risk, RISK_CLS[a.risk]) + stateChip(eff) + '</li>';
    }).join('');
    return '<section class="mc-card"><h3>Status</h3><div class="mc-chips">' +
      '<div class="mc-wide"><span class="mc-lab">Master kill switch</span>' + sendChip(c.customerSends, c.reason) + '</div>' +
      '<div><span class="mc-lab">SMS</span>' + channelChip(c.sms) + '</div>' +
      '<div><span class="mc-lab">Email</span>' + channelChip(c.email) + '</div>' +
      '<div><span class="mc-lab">Verification codes</span>' + channelChip(c.otp) + '</div>' +
      '<div class="mc-wide"><span class="mc-lab">Canary mode</span>' + canaryChip(c.canary) + '</div>' +
      '<div><span class="mc-lab">Texting master switch</span>' + stateChip(texting) + '</div>' +
      '<div><span class="mc-lab">A2P campaign registered</span>' + stateChip(s.a2pRegistered) + '</div>' +
      '<div><span class="mc-lab">Last customer send</span><b>' + esc(ago(s.lastSendAtMs, o.generatedAtMs)) + '</b></div></div>' +
      (c.enforced === false ? '<p class="mc-sub">The master kill switch is not in this deployment yet, so each automation still runs on its own switch below.</p>' : '') +
      '<h4>Automations (effective state)</h4><ul class="mc-list">' + rows + '</ul></section>';
  }

  function countsHtml(o) {
    var c = o.counts || {};
    var names = {};
    (o.status && o.status.automations || []).forEach(function (a) { names[a.key] = a.label; });
    var KEYS = ['today', 'd7', 'd30'];
    var head = '<tr><th></th><th>Today</th><th>7 days</th><th>30 days</th></tr>';
    function cell(k, fn) { return '<td>' + (fn(c[k] || {}) || 0) + '</td>'; }
    var chRows = ['sms', 'email', 'push'].map(function (ch) {
      return '<tr><th>' + esc(ch.toUpperCase()) + '</th>' + KEYS.map(function (k) { return cell(k, function (w) { return (w.byChannel || {})[ch]; }); }).join('') + '</tr>';
    }).join('');
    var keys = {};
    KEYS.forEach(function (k) { Object.keys((c[k] && c[k].byAutomation) || {}).forEach(function (a) { keys[a] = 1; }); });
    var autoRows = Object.keys(keys).sort().map(function (a) {
      return '<tr><th>' + esc(names[a] || a) + '</th>' + KEYS.map(function (k) { return cell(k, function (w) { return (w.byAutomation || {})[a]; }); }).join('') + '</tr>';
    }).join('');
    return '<section class="mc-card"><h3>Customer messages sent</h3><table class="mc-table">' + head + chRows +
      '<tr class="mc-total"><th>Total</th>' + KEYS.map(function (k) { return cell(k, function (w) { return w.total; }); }).join('') + '</tr></table>' +
      '<h4>Internal alerts to you (not customers)</h4><table class="mc-table">' + head +
      '<tr><th>All channels</th>' + KEYS.map(function (k) { return cell(k, function (w) { return w.internal && w.internal.total; }); }).join('') + '</tr></table>' +
      '<h4>By automation</h4>' + (autoRows ? '<table class="mc-table">' + head + autoRows + '</table>' : '<p class="mc-sub">No customer messages in the last 30 days.</p>') +
      '<p class="mc-sub">Counts only what this page can read. Voice is not tracked, and some email senders are not visible: see Coverage.</p></section>';
  }

  function outcomesHtml(o) {
    var oc = o.outcomes || {};
    function line(ch) {
      var b = oc[ch] || {};
      return '<li><b>' + ch.toUpperCase() + '</b> ' + ['sent', 'delivered', 'failed', 'undelivered', 'unknown'].map(function (k) {
        return chip(outcomeLabel(k) + ' ' + (b[k] || 0), OUTCOME_CLS[k]);
      }).join('') + '</li>';
    }
    var codes = Object.keys(oc.errorCodes || {}).map(function (k) { return chip('error ' + k + ' × ' + oc.errorCodes[k], 'mc-bad'); }).join('');
    return '<section class="mc-card"><h3>Delivery outcomes (7 days)</h3><ul class="mc-list">' + line('sms') + line('email') + line('push') + '</ul>' +
      (codes ? '<h4>Carrier error codes</h4><div class="mc-chips-wrap">' + codes + '</div>' : '') +
      '<p class="mc-sub">&ldquo;Accepted, not confirmed&rdquo; means the provider took the message, which does not prove it arrived. Only &ldquo;delivered&rdquo; (green) does; the carrier verdict is stamped later when the delivery callback is on.</p></section>';
  }

  function blockedHtml(o) {
    var b = o.blocked || { total: 0, byReason: {} };
    var labels = o.blockedLabels || {};
    var rec = o.blockedRecorded || {};
    var rows = Object.keys(b.byReason || {}).map(function (k) {
      var shown = rec[k] === false ? '<span class="mc-sub">not recorded</span>' : (b.byReason[k] || 0);
      return '<tr><th>' + esc(labels[k] || k) + '</th><td>' + shown + '</td></tr>';
    }).join('');
    return '<section class="mc-card"><h3>Blocked by a gate (30 days)</h3><p class="mc-big">' + (b.total || 0) + '<span class="mc-sub"> that left a row</span></p><table class="mc-table">' + rows + '</table>' +
      '<p class="mc-sub">Counts only refusals that left a row. STOP, do-not-text, quiet-hours, master-switch and daily-cap refusals are returned to the caller without writing anything today, so a low number here is not proof nothing was blocked. See Coverage.</p></section>';
  }

  function optOutsHtml(o) {
    var p = o.optOuts || { total: 0, recent: [] };
    var rows = (p.recent || []).map(function (r) {
      return '<li><span>••• ' + esc(String(r.last4 || '').slice(-4)) + '</span><span class="mc-sub">' + esc(when(r.atMs, o.tz)) + ' · ' + esc(r.source) + '</span></li>';
    }).join('');
    return '<section class="mc-card"><h3>STOP / opt-outs</h3><p class="mc-big">' + (p.total || 0) + '</p>' +
      (rows ? '<ul class="mc-list">' + rows + '</ul>' : '<p class="mc-sub">No one has replied STOP to this company yet.</p>') +
      '<p class="mc-sub">Last 4 digits only.</p></section>';
  }

  function queuesHtml(o) {
    var q = o.queues || { items: [], pending: 0, failed: 0 };
    var rows = (q.items || []).slice(0, 25).map(function (i) {
      return '<li><span>' + esc(i.queue) + ' · ' + esc(clip(i.label, 50)) + '</span>' + chip(i.status, i.status === 'failed' ? 'mc-bad' : 'mc-warn') +
        '<span class="mc-sub">waiting ' + esc(age(i.ageMs)) + (i.attempts ? ' · ' + i.attempts + ' tries' : '') + '</span></li>';
    }).join('');
    return '<section class="mc-card"><h3>Queue backlog</h3><div class="mc-chips-wrap">' + chip('pending ' + (q.pending || 0), 'mc-warn') + chip('failed ' + (q.failed || 0), q.failed ? 'mc-bad' : 'mc-unk') + '</div>' +
      (rows ? '<ul class="mc-list">' + rows + '</ul>' : '<p class="mc-sub">Nothing is waiting.</p>') +
      '<p class="mc-sub">Oldest first. Email queue (platform email) and drafts waiting for a human tap in the Agent inbox.</p></section>';
  }

  function eventHtml(e, tz) {
    return '<li class="mc-row"><div class="mc-row-top"><b>' + esc(e.automationLabel || e.automation) + '</b>' +
      chip(String(e.channel || '').toUpperCase(), 'mc-unk') + (e.canary ? chip('CANARY (went to you)', 'mc-warn') : '') + chip(outcomeLabel(e.outcome), OUTCOME_CLS[e.outcome]) + (e.errorCode ? chip('err ' + e.errorCode, 'mc-bad') : '') + '</div>' +
      '<div class="mc-row-who">' + esc(scrub(e.name || '')) + (e.name ? ' · ' : '') + esc(scrub(e.recipient || '')) + '</div>' +
      '<div class="mc-sub">' + esc(e.templateId || '') + ' · ' + esc(when(e.atMs, tz)) + '</div>' +
      (e.firstLine ? '<div class="mc-line">“' + esc(clip(e.firstLine, 80)) + '”</div>' : '') +
      '<div class="mc-gate">' + chip('gate ' + (e.gate || 'pass'), GATE_CLS[e.gate]) + '<span class="mc-sub">' + esc((e.gateNotes || []).join(' · ')) + '</span>' +
      (e.errorLabel ? '<span class="mc-sub"> · ' + esc(e.errorLabel) + '</span>' : '') + '</div></li>';
  }

  function needsLookHtml(o) {
    var items = o.needsLook || [];
    if (!items.length && (o.unreadable || []).length) return '<section class="mc-card"><h3>Needs a look</h3><p class="mc-bad-text">Cannot say: some data could not be read (see the red banner).</p></section>';
    if (!items.length) return '<section class="mc-card"><h3>Needs a look</h3><p class="mc-ok-text">Nothing to look at in the last 7 days' + ((o.truncated || []).length ? ', in the rows that were read (some sources were capped, see Coverage)' : '') + '.</p></section>';
    return '<section class="mc-card"><h3>Needs a look <span class="mc-count">' + items.length + '</span></h3><ul class="mc-rows">' + items.slice(0, 40).map(function (i) {
      return '<li class="mc-look mc-sev-' + esc(i.severity) + '"><div class="mc-row-top"><b>' + esc(scrub(i.title)) + '</b>' + chip(i.kind.replace(/_/g, ' '), i.severity === 'high' ? 'mc-bad' : 'mc-warn') + '</div>' +
        '<div class="mc-sub">' + esc(when(i.atMs, o.tz)) + '</div>' + (i.event ? '<ul class="mc-rows">' + eventHtml(i.event, o.tz) + '</ul>' : '') + '</li>';
    }).join('') + '</ul></section>';
  }

  function eventsHtml(o, filter) {
    var ev = (o.events || []).filter(function (e) { return !filter || filter === 'all' || e.channel === filter; });
    var chips = ['all'].concat(CHANNELS.slice(0, 3)).map(function (c) {
      return '<button type="button" class="mc-filter' + ((filter || 'all') === c ? ' mc-on' : '') + '" data-mc-filter="' + c + '">' + c + '</button>';
    }).join('');
    return '<section class="mc-card"><h3>Recent messages</h3><div class="mc-filters">' + chips + '</div>' +
      (ev.length ? '<ul class="mc-rows">' + ev.slice(0, 60).map(function (e) { return eventHtml(e, o.tz); }).join('') + '</ul>' : '<p class="mc-sub">No messages in this view.</p>') + '</section>';
  }

  function coverageHtml(o) {
    var cv = o.coverage || { sources: {}, inventory: [] };
    var trunc = cv.truncated || {};
    var src = Object.keys(cv.sources || {}).map(function (k) {
      var st = cv.sources[k];
      return '<li><span>' + esc(k) + (trunc[k] ? '<span class="mc-sub"> capped: oldest rows not shown</span>' : '') + '</span>' + chip(st, st === 'ok' ? 'mc-ok' : (st === 'absent' || st === 'not deployed' ? 'mc-unk' : 'mc-bad')) + '</li>';
    }).join('');
    var inv = (cv.inventory || []).map(function (b) {
      return '<li><span><b>' + esc(b.id) + '</b> ' + esc(b.label) + '<span class="mc-sub">' + esc(b.via) + '</span></span>' +
        chip(b.seen === 'yes' ? 'seen' : (b.seen === 'partly' ? 'partly' : 'NOT SEEN'), b.seen === 'yes' ? 'mc-ok' : (b.seen === 'partly' ? 'mc-warn' : 'mc-bad')) + '</li>';
    }).join('');
    return '<section class="mc-card"><h3>Coverage</h3>' +
      (o.emailPartlyUnseen ? '<p class="mc-bad-text">Customer email is only partly visible: several email senders have no ledger this page can read.</p>' : '') +
      '<h4>Ledgers read</h4><ul class="mc-list">' + src + '</ul><h4>Every sender in the inventory</h4><ul class="mc-list mc-stack">' + inv + '</ul>' +
      '<p class="mc-sub">Refusals that write no row (STOP, do-not-text, quiet hours, master switch, daily cap) are returned to the caller and stored nowhere, so the Blocked table cannot count them.</p></section>';
  }

  function howHtml() {
    return '<details class="mc-card mc-how"><summary>How to read this</summary>' +
      '<ul><li><b>Sent</b> = the provider accepted the message. <b>Delivered</b> = the carrier confirmed it reached the phone.</li>' +
      '<li><b>Gate</b> shows the checks that held when it went out: consent record, 8am-9pm in the recipient’s time zone, not on the STOP list.</li>' +
      '<li><b>Rep-initiated</b> texts need no stored consent; automated ones must have a form tick or a storm signup.</li>' +
      '<li><b>Needs a look</b> is the page to read daily. Red = act now. Zero in &ldquo;no consent record&rdquo; is the goal.</li>' +
      '<li>Twilio’s own logs show carrier delivery only. This page adds which automation sent it, why, and what a gate refused.</li>' +
      '<li>Nothing here sends or changes anything. To stop texting: Settings &gt; Texting.</li></ul>' +
      '<p><a class="mc-link" href="' + TWILIO_LOGS + '" target="_blank" rel="noopener noreferrer">Open Twilio Messaging logs</a></p></details>';
  }

  function viewHtml(o, filter) {
    if (!o) return '<p class="mc-sub">Loading…</p>';
    if (o.enabled === false) return '<section class="mc-card"><h3>Messaging</h3><p class="' + (o.flagsUnread ? 'mc-bad-text' : 'mc-sub') + '">' + (o.flagsUnread ? 'The feature flags could not be read yet, so this page cannot tell whether Messaging is on. Reload in a moment.' : 'The Messaging Control Center is switched off for this account.') + '</p></section>';
    return incompleteHtml(o) + canaryHtml(o) + bannerHtml(o.alerts) +
      '<div class="mc-head"><h2>Messaging</h2><div class="mc-head-act"><button type="button" class="btn mc-refresh" data-mc-refresh>Refresh</button>' +
      '<a class="btn mc-twilio" href="' + TWILIO_LOGS + '" target="_blank" rel="noopener noreferrer">Twilio logs</a></div></div>' +
      '<p class="mc-sub">Updated ' + esc(when(o.generatedAtMs, o.tz)) + '. Read-only. Phone numbers show the last 4 digits only.</p>' +
      needsLookHtml(o) + statusHtml(o) + countsHtml(o) + outcomesHtml(o) + blockedHtml(o) + optOutsHtml(o) + queuesHtml(o) + eventsHtml(o, filter) + coverageHtml(o) + howHtml();
  }

  var pure = { sendChip: sendChip, canaryChip: canaryChip, incompleteHtml: incompleteHtml, canaryHtml: canaryHtml, esc: esc, canView: canView, scrub: scrub, clip: clip, ago: ago, age: age, bannerHtml: bannerHtml, statusHtml: statusHtml, countsHtml: countsHtml,
    outcomesHtml: outcomesHtml, blockedHtml: blockedHtml, optOutsHtml: optOutsHtml, queuesHtml: queuesHtml, eventHtml: eventHtml, needsLookHtml: needsLookHtml,
    eventsHtml: eventsHtml, coverageHtml: coverageHtml, howHtml: howHtml, viewHtml: viewHtml, FLAG: FLAG, VIEW_ROLES: VIEW_ROLES, TWILIO_LOGS: TWILIO_LOGS };

  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (typeof window === 'undefined' || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = window;
  var state = { data: null, filter: 'all', loading: false, error: '' };
  var seq = 0;

  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function allowed() { return canView(claims(), uid()); }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function flagsLoaded() { return !!(w.NBDFlags && typeof w.NBDFlags.isLoaded === 'function' && w.NBDFlags.isLoaded()); }
  function mount() { var v = document.getElementById('view-messaging'); return v && (v.querySelector('.view-scroll') || v); }

  function paint() {
    var m = mount();
    if (!m) return;
    if (!allowed()) { m.innerHTML = '<p class="mc-sub">Messaging is for the owner and admins.</p>'; return; }
    if (state.error) { m.innerHTML = '<section class="mc-card"><h3>Messaging</h3><p class="mc-bad-text">' + esc(state.error) + '</p><button type="button" class="btn mc-refresh" data-mc-refresh>Try again</button></section>'; return; }
    m.innerHTML = '<div class="mc-root">' + viewHtml(state.data, state.filter) + '</div>';
  }

  function callable() {
    if (w._functions && w._httpsCallable) return w._httpsCallable(w._functions, 'messagingCenter');
    return import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (mod) {
      w._functions = w._functions || mod.getFunctions();
      w._httpsCallable = w._httpsCallable || mod.httpsCallable;
      return mod.httpsCallable(w._functions, 'messagingCenter');
    });
  }

  function load() {
    var mine = ++seq;
    if (!allowed()) { state.data = { enabled: false }; paint(); return Promise.resolve(); }
    if (!flagOn()) {
      // "Off" and "could not read the flags" are different answers: say which.
      state.data = flagsLoaded() ? { enabled: false } : { enabled: false, flagsUnread: true };
      paint();
      return Promise.resolve();
    }
    state.error = '';
    if (!state.data) paint();
    return Promise.resolve(callable()).then(function (fn) { return fn({}); }).then(function (res) {
      if (mine !== seq) return;
      state.data = (res && res.data) || { enabled: false };
      paint();
    }, function (e) {
      if (mine !== seq) return;
      state.error = (e && e.code === 'functions/permission-denied') ? 'Messaging is for the owner and admins.' : 'Could not load Messaging. Try again in a moment.';
      paint();
    });
  }

  function init() {
    var m = mount();
    if (m && !m.__mcBound) {
      m.__mcBound = true;
      m.addEventListener('click', function (ev) {
        var t = ev.target && ev.target.closest ? ev.target.closest('[data-mc-refresh],[data-mc-filter]') : null;
        if (!t) return;
        if (t.hasAttribute('data-mc-refresh')) { state.data = null; load(); return; }
        state.filter = t.getAttribute('data-mc-filter') || 'all';
        paint();
      });
    }
    return load();
  }

  w.NBDMessaging = Object.assign({ init: init, load: load, allowed: allowed }, pure);
})(typeof window !== 'undefined' ? window : this);
