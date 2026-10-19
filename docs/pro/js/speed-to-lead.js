/**
 * speed-to-lead.js — measure and improve first-response time to new leads (2026-10-19).
 *
 * Jo answers most leads OUTSIDE the CRM (texting or calling from his phone,
 * replying inside Thumbtack or Yelp), so the CRM never learns when he
 * responded and the inbox timer chips are wrong. Thumbtack bills when the
 * customer replies, so fast first response matters. This adds:
 *
 *   1. a one-tap "Replied" per new lead that stamps leads/{id}.firstRespondedAt
 *      (+ firstRespondedChannel: text | call | thumbtack | yelp | other,
 *      firstRespondedSource: 'manual'), only if not already set, with Undo;
 *   2. automatic call matching: an OUTBOUND row in phone_calls (filed by
 *      functions/call-center.js, already matched to a lead by phone, grouped by
 *      customer) stamps firstRespondedAt from the call's own start time, only
 *      when firstRespondedAt is unset (source 'call-match');
 *   3. a summary: median and p90 minutes to first response by lead source for
 *      leads created in the last 30 days. Only STAMPED leads are counted;
 *      unstamped ones are shown as their own "not recorded" column, never as slow.
 *
 * It never sends anything: no text, no email, no call, no messaging code.
 * Ships DARK behind the `speedToLead` feature flag (feature_flags/_default).
 * Absent / false = the toolbar button stays hidden and nothing is read or written.
 *
 * Time is epoch milliseconds; minutes are (stamp - createdAt) / 60000, never
 * below 0. firstRespondedAt is written as a Date (Firestore Timestamp).
 *
 * Pure logic is exported for tests (module.exports under Node).
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  var MIN = 60000, DAY = 86400000;
  var FLAG = 'speedToLead';
  var CHANNELS = ['text', 'call', 'thumbtack', 'yelp', 'other'];
  var CHANNEL_LABEL = { text: 'Text', call: 'Call', thumbtack: 'Thumbtack', yelp: 'Yelp', other: 'Other' };
  var WAITING_DAYS = 7;          // the inbox's "new lead" window
  var SUMMARY_DAYS = 30;
  var MATCH_WINDOW_DAYS = 14;    // an outbound call later than this is not the first response to that lead
  var MATCH_BATCH = 50;          // call-match writes per run

  function toMs(t) {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.toDate === 'function') return t.toDate().getTime();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    var v = Date.parse(t); return isFinite(v) ? v : 0;
  }
  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function sourceLabel(lead) {
    var s = String((lead && lead.source) == null ? '' : lead.source).trim();
    return s || 'Unknown';
  }
  function nameOf(lead) {
    var n = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || String(lead.name || '').trim();
    return n || String(lead.address || '').split(',')[0] || 'Customer';
  }
  function stageKeyOf(lead) { return String(lead._stageKey || lead.stage || 'new').toLowerCase(); }

  /** A stamp counts only when it is a real moment. null / absent / 0 = unstamped. */
  function stampMs(lead) { return toMs(lead && lead.firstRespondedAt); }

  /** Default channel for the one-tap button, from where the lead came from. */
  function guessChannel(lead) {
    var s = String((lead && lead.source) || '').toLowerCase();
    if (s.indexOf('thumbtack') >= 0) return 'thumbtack';
    if (s.indexOf('yelp') >= 0) return 'yelp';
    return 'text';
  }

  function isLive(lead) { return !!(lead && lead.id && lead.deleted !== true && !lead.isProspect); }

  /**
   * New leads still waiting for a recorded reply: stage new, created in the last
   * 7 days, no stamp. Newest first (the one most at risk of going cold).
   */
  function waitingLeads(leads, opts, env) {
    opts = opts || {}; env = env || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var out = [];
    (leads || []).forEach(function (l) {
      if (!isLive(l) || stageKeyOf(l) !== 'new') return;
      var made = toMs(l.createdAt);
      if (!made || now - made > WAITING_DAYS * DAY || made > now) return;
      if (stampMs(l)) return;
      if (typeof env.canChange === 'function' && !env.canChange(l)) return;
      out.push({ id: l.id, lead: l, name: nameOf(l), source: sourceLabel(l), createdMs: made, ageMin: Math.max(0, Math.floor((now - made) / MIN)), channel: guessChannel(l) });
    });
    out.sort(function (a, b) { return b.createdMs - a.createdMs || (a.id < b.id ? -1 : 1); });
    return out;
  }

  /** Nearest-rank percentile of a numeric list (p in 0..1). null when empty. */
  function percentile(vals, p) {
    if (!vals || !vals.length) return null;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    return s[Math.max(0, Math.ceil(p * s.length) - 1)];
  }
  function median(vals) {
    if (!vals || !vals.length) return null;
    var s = vals.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Median and p90 minutes to first response, by source, for leads created in the
   * last 30 days. Leads with no stamp are counted in `unstamped` only; they never
   * enter the median or p90. A stamp before createdAt reads as 0 minutes.
   * @returns {{rows:Array<{source,stamped,unstamped,total,medianMin,p90Min}>, all:Object}}
   *   rows biggest-total first; `all` is the same shape across every source.
   */
  function summarize(leads, opts) {
    opts = opts || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var days = opts.days > 0 ? opts.days : SUMMARY_DAYS;
    var by = {}, order = [];
    function bucket(label) {
      var k = label.toLowerCase();
      if (!by[k]) { by[k] = { source: label, mins: [], unstamped: 0 }; order.push(k); }
      return by[k];
    }
    var all = { source: 'All sources', mins: [], unstamped: 0 };
    (leads || []).forEach(function (l) {
      if (!isLive(l)) return;
      var made = toMs(l.createdAt);
      if (!made || made > now || now - made > days * DAY) return;
      var b = bucket(sourceLabel(l)), st = stampMs(l);
      if (st) { var m = Math.max(0, (st - made) / MIN); b.mins.push(m); all.mins.push(m); }
      else { b.unstamped++; all.unstamped++; }
    });
    function fin(b) {
      return {
        source: b.source, stamped: b.mins.length, unstamped: b.unstamped, total: b.mins.length + b.unstamped,
        medianMin: median(b.mins), p90Min: percentile(b.mins, 0.9),
      };
    }
    var rows = order.map(function (k) { return fin(by[k]); });
    rows.sort(function (a, b) { return b.total - a.total || (a.source < b.source ? -1 : 1); });
    return { rows: rows, all: fin(all) };
  }

  /** "12 min", "1h 5m", "2d 3h"; '—' when there is no number. */
  function fmtMin(m) {
    if (m == null || !isFinite(m)) return '—';
    var r = Math.round(m);
    if (r < 60) return r + ' min';
    var h = Math.floor(r / 60);
    if (h < 24) return h + 'h' + (r % 60 ? ' ' + (r % 60) + 'm' : '');
    return Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
  }

  /** What the one-tap writes. `at` is a Firestore server timestamp in the browser. */
  function stampPatch(channel, at) {
    var ch = CHANNELS.indexOf(channel) >= 0 ? channel : 'other';
    return { firstRespondedAt: at, firstRespondedChannel: ch, firstRespondedSource: 'manual' };
  }
  /** Only an unstamped lead may be stamped (null / absent / 0 all mean unstamped). */
  function canStamp(cur) { return !!cur && !stampMs(cur); }
  /** Undo clears only a MANUAL stamp, never a call-match one, and never a lead changed since. */
  function undoPatch(cur, channel) {
    if (!cur || !stampMs(cur) || cur.firstRespondedSource !== 'manual' || cur.firstRespondedChannel !== channel) return null;
    return { firstRespondedAt: null, firstRespondedChannel: null, firstRespondedSource: null };
  }

  // ── call matching ────────────────────────────────────────────────────
  function leadPhones(l) {
    var out = [];
    [l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].forEach(function (p) {
      var d = digits10(p); if (d && out.indexOf(d) < 0) out.push(d);
    });
    return out;
  }
  function isOutbound(c) { return !!c && c.direction === 'outbound' && c.channel !== 'text'; }

  /**
   * The earliest OUTBOUND call that answers this lead: same customer (the call's
   * own leadId, else the phone number), started at or after the lead was created
   * and within 14 days of it. null when there is none.
   * @returns {{id, startedAtMs}|null}
   */
  function matchCall(lead, calls) {
    var made = toMs(lead && lead.createdAt);
    if (!made) return null;
    var phones = leadPhones(lead), best = null;
    (calls || []).forEach(function (c) {
      if (!isOutbound(c)) return;
      var at = toMs(c.startedAtMs);
      if (!at || at < made || at - made > MATCH_WINDOW_DAYS * DAY) return;
      var same = (c.leadId != null && String(c.leadId) === String(lead.id)) ||
        (!c.leadId && phones.indexOf(digits10(c.phoneDigits)) >= 0);
      if (!same) return;
      if (!best || at < best.startedAtMs) best = { id: c.id || null, startedAtMs: at };
    });
    return best;
  }

  /** Unstamped live leads from the last 30 days that have a matching outbound call. */
  function planCallMatches(leads, calls, opts) {
    opts = opts || {};
    var now = opts.now == null ? Date.now() : opts.now;
    var out = [];
    (leads || []).forEach(function (l) {
      if (!isLive(l) || stampMs(l)) return;
      var made = toMs(l.createdAt);
      if (!made || made > now || now - made > SUMMARY_DAYS * DAY) return;
      var m = matchCall(l, calls);
      if (m) out.push({ id: l.id, startedAtMs: m.startedAtMs, callId: m.id });
    });
    return out.slice(0, MATCH_BATCH);
  }
  function matchPatch(m) {
    return { firstRespondedAt: new Date(m.startedAtMs), firstRespondedChannel: 'call', firstRespondedSource: 'call-match', firstRespondedCallId: m.callId || null };
  }

  var pure = {
    summarize: summarize, waitingLeads: waitingLeads, percentile: percentile, median: median, fmtMin: fmtMin,
    stampPatch: stampPatch, undoPatch: undoPatch, canStamp: canStamp, stampMs: stampMs, guessChannel: guessChannel,
    matchCall: matchCall, planCallMatches: planCallMatches, matchPatch: matchPatch,
    CHANNELS: CHANNELS, FLAG: FLAG, WAITING_DAYS: WAITING_DAYS, SUMMARY_DAYS: SUMMARY_DAYS, MATCH_WINDOW_DAYS: MATCH_WINDOW_DAYS,
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (!root || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  if (w.NBDSpeedToLead) return;

  var overlay = null;
  var st = { busy: false, result: '', chosen: {}, undo: null, calls: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function isViewer() { return (claims().role || '') === 'viewer'; }
  // Same mutable-lead rule as commitBulkLeadOp / the stale-leads cleanup.
  function canChange(l) {
    var c = claims(), role = c.role || '', uid = (w._user && w._user.uid) || null;
    if (role === 'viewer') return false;
    if (role === 'admin' || !l.userId || !uid || l.userId === uid) return true;
    return (role === 'company_admin' || role === 'manager') && !!c.companyId && l.companyId === c.companyId;
  }
  function flagOn() {
    return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG));
  }
  function available() { return flagOn() && !isViewer(); }
  function leadById(id) { return (w._leads || []).filter(function (l) { return l && l.id === id; })[0] || null; }
  function fbReady() { return typeof w.runTransaction === 'function' && !!w.db && typeof w.doc === 'function'; }

  function waiting() { return waitingLeads(w._leads || [], {}, { canChange: canChange }); }

  function syncButton() {
    var b = doc.getElementById('speedToLeadBtn');
    if (!b) return;
    var on = available();
    b.hidden = !on;
    var badge = doc.getElementById('speedToLeadBadge');
    if (badge) {
      var n = on ? waiting().length : 0;
      badge.textContent = String(n);
      badge.hidden = !n;
    }
  }

  // ── writes: one lead at a time, in a transaction, only while unstamped ─
  async function stampOne(id, channel) {
    if (!fbReady()) { toast('Not signed in yet — reload the board', 'error'); return false; }
    var ref = w.doc(w.db, 'leads', id), applied = false;
    await w.runTransaction(w.db, async function (tx) {
      applied = false;
      var s = await tx.get(ref);
      if (!s.exists() || !canStamp(s.data())) return;
      tx.update(ref, stampPatch(channel, w.serverTimestamp()));
      applied = true;
    });
    if (applied) {
      var l = leadById(id);
      if (l) { l.firstRespondedAt = new Date(); l.firstRespondedChannel = channel; l.firstRespondedSource = 'manual'; }
    }
    return applied;
  }
  async function undoOne(id, channel) {
    if (!fbReady()) return false;
    var ref = w.doc(w.db, 'leads', id), applied = false;
    await w.runTransaction(w.db, async function (tx) {
      applied = false;
      var s = await tx.get(ref);
      if (!s.exists()) return;
      var p = undoPatch(s.data(), channel);
      if (!p) return;
      tx.update(ref, p);
      applied = true;
    });
    if (applied) {
      var l = leadById(id);
      if (l) { l.firstRespondedAt = null; l.firstRespondedChannel = null; l.firstRespondedSource = null; }
    }
    return applied;
  }

  async function onReplied(id) {
    if (st.busy || !available()) return;
    var ch = st.chosen[id] || guessChannel(leadById(id));
    st.busy = true; st.result = ''; paint();
    try {
      var done = await stampOne(id, ch);
      if (done) { st.undo = { id: id, channel: ch }; st.result = 'Marked replied by ' + CHANNEL_LABEL[ch] + '.'; }
      else st.result = 'Already has a recorded reply, left alone.';
    } catch (e) { st.result = 'Could not save: ' + (e && (e.code || e.message) || 'unknown error'); }
    st.busy = false;
    syncButton(); w.dispatchEvent(new CustomEvent('nbd:data-refreshed')); paint();
  }
  async function onUndo() {
    var u = st.undo;
    if (!u || st.busy) return;
    st.busy = true; st.undo = null; paint();
    try { st.result = (await undoOne(u.id, u.channel)) ? 'Undone.' : 'Left alone (it changed since).'; }
    catch (e) { st.result = 'Undo failed: ' + (e && (e.code || e.message) || 'unknown error'); }
    st.busy = false;
    syncButton(); w.dispatchEvent(new CustomEvent('nbd:data-refreshed')); paint();
  }

  // ── call matching (read phone_calls, stamp only unstamped leads) ──────
  var matching = false;
  async function matchCalls() {
    if (matching || !available() || !fbReady() || typeof w.getDocs !== 'function' || !w._user) return 0;
    matching = true;
    var n = 0;
    try {
      var snap = await w.getDocs(w.query(w.collection(w.db, 'phone_calls'), w.where('userId', '==', w._user.uid), w.orderBy('startedAtMs', 'desc'), w.limit(300)));
      st.calls = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      var plan = planCallMatches((w._leads || []).filter(canChange), st.calls, {});
      for (var i = 0; i < plan.length; i++) {
        var m = plan[i], ref = w.doc(w.db, 'leads', m.id), applied = false;
        try {
          await w.runTransaction(w.db, async function (tx) {
            applied = false;
            var s = await tx.get(ref);
            if (!s.exists() || !canStamp(s.data())) return;   // never overwrite a stamp
            tx.update(ref, matchPatch(m));
            applied = true;
          });
        } catch (e) { console.warn('[speed-to-lead] call match failed', m.id, e && (e.code || e.message)); continue; }
        if (applied) {
          n++;
          var l = leadById(m.id);
          if (l) { l.firstRespondedAt = new Date(m.startedAtMs); l.firstRespondedChannel = 'call'; l.firstRespondedSource = 'call-match'; }
        }
      }
    } catch (e) { console.warn('[speed-to-lead] call match read failed', e && (e.code || e.message)); }
    matching = false;
    if (n) { syncButton(); try { w.dispatchEvent(new CustomEvent('nbd:data-refreshed')); } catch (_) {} }
    return n;
  }

  // ── modal ────────────────────────────────────────────────────────────
  function summaryHtml() {
    var s = summarize(w._leads || [], {});
    var h = '<h3 class="stl-h">Last ' + SUMMARY_DAYS + ' days, by source</h3>';
    if (!s.all.total) return h + '<p class="stl-empty">No leads created in the last ' + SUMMARY_DAYS + ' days.</p>';
    function tr(r, strong) {
      return '<tr' + (strong ? ' class="stl-all"' : '') + '><td data-label="Source">' + esc(r.source) + '</td>' +
        '<td data-label="Median">' + esc(fmtMin(r.medianMin)) + '</td>' +
        '<td data-label="Slowest 1 in 10 (p90)">' + esc(fmtMin(r.p90Min)) + '</td>' +
        '<td data-label="Replied (recorded)">' + r.stamped + '</td>' +
        '<td data-label="Not recorded">' + r.unstamped + '</td></tr>';
    }
    h += '<table class="stl-table"><thead><tr><th>Source</th><th>Median</th><th>p90</th><th>Recorded</th><th>Not recorded</th></tr></thead><tbody>' +
      tr(s.all, true) + s.rows.map(function (r) { return tr(r, false); }).join('') + '</tbody></table>' +
      '<p class="stl-note">Only leads with a recorded reply are timed. "Not recorded" leads are not counted as slow; they just have no reply on file yet.</p>';
    return h;
  }
  function waitingHtml() {
    var list = waiting();
    var h = '<h3 class="stl-h">New leads waiting for a recorded reply (' + list.length + ')</h3>';
    if (!list.length) return h + '<p class="stl-empty">Nothing waiting. Every new lead from the last ' + WAITING_DAYS + ' days has a reply on file.</p>';
    h += '<ul class="stl-list">';
    list.forEach(function (r) {
      var ch = st.chosen[r.id] || r.channel;
      h += '<li class="stl-item"><div class="stl-who"><b>' + esc(r.name) + '</b><span class="stl-meta">' + esc(r.source) + ' · ' + esc(fmtMin(r.ageMin)) + ' ago</span></div>' +
        '<label class="stl-ch"><span class="stl-sr">How you replied to ' + esc(r.name) + '</span><select class="stl-sel" data-stl-ch="' + esc(r.id) + '"' + (st.busy ? ' disabled' : '') + '>' +
        CHANNELS.map(function (c) { return '<option value="' + c + '"' + (c === ch ? ' selected' : '') + '>' + CHANNEL_LABEL[c] + '</option>'; }).join('') + '</select></label>' +
        '<button type="button" class="stl-btn stl-go" data-stl-act="replied" data-stl-id="' + esc(r.id) + '"' + (st.busy ? ' disabled' : '') + '>Replied</button></li>';
    });
    return h + '</ul>';
  }
  function bodyHtml() {
    var h = '<div class="stl-head"><h2 class="stl-title" id="stlTitle">Speed to lead</h2>' +
      '<button type="button" class="stl-x" data-stl-act="close" aria-label="Close">×</button></div>' +
      '<p class="stl-sub">Tap <b>Replied</b> after you answer a lead on your phone, in Thumbtack or in Yelp. Calls you make from your phone are matched automatically. This only records the time; nothing is sent to anyone.</p>';
    if (st.result) {
      h += '<div class="stl-result" role="status"><span>' + esc(st.result) + '</span>' +
        (st.undo ? '<button type="button" class="stl-btn" data-stl-act="undo"' + (st.busy ? ' disabled' : '') + '>Undo</button>' : '') + '</div>';
    }
    return h + waitingHtml() + summaryHtml();
  }
  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;
    overlay.innerHTML = '<div class="stl-box" role="dialog" aria-modal="true" aria-labelledby="stlTitle">' + bodyHtml() + '</div>';
    overlay.scrollTop = keep;
  }
  function open() {
    if (!available()) return false;           // flag off / viewer: nothing renders
    if (overlay) { paint(); return true; }
    st.result = ''; st.undo = null; st.busy = false;
    overlay = doc.createElement('div');
    overlay.className = 'stl-overlay';
    overlay.setAttribute('data-stl-overlay', '1');
    doc.body.appendChild(overlay);
    paint();
    matchCalls().then(function (n) { if (n && overlay) { st.result = 'Matched ' + n + ' lead' + (n === 1 ? '' : 's') + ' to your outbound calls.'; paint(); } });
    return true;
  }
  function close() {
    if (st.busy) return;
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    else if (overlay && typeof overlay.remove === 'function') overlay.remove();
    overlay = null;
  }

  // ── events (delegated, no inline handlers) ───────────────────────────
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-stl-act],#speedToLeadBtn');
    if (!t) return;
    if (t.id === 'speedToLeadBtn') { ev.preventDefault(); open(); return; }
    if (!overlay || !available()) return;
    var act = t.getAttribute('data-stl-act');
    if (act === 'close') close();
    else if (act === 'replied') onReplied(t.getAttribute('data-stl-id'));
    else if (act === 'undo') onUndo();
  });
  doc.addEventListener('change', function (ev) {
    var el = ev.target, id = el && el.getAttribute && el.getAttribute('data-stl-ch');
    if (!overlay || !id) return;
    if (CHANNELS.indexOf(el.value) >= 0) st.chosen[id] = el.value;
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  function init() {
    syncButton();
    if (w.NBDFlags && typeof w.NBDFlags.load === 'function') {
      Promise.resolve(w.NBDFlags.load()).then(function () { syncButton(); matchCalls(); }, function () {});
    }
  }
  w.addEventListener('nbd:data-refreshed', syncButton);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 2000); });
  else setTimeout(init, 2000);
  setInterval(syncButton, 60000);

  w.NBDSpeedToLead = { open: open, close: close, sync: syncButton, available: available, matchCalls: matchCalls, _pure: pure };
})(typeof window !== 'undefined' ? window : this);
