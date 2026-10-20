/**
 * estimate-follow-board.js — Open Estimates Follow-Up Board (2026-10-19).
 *
 * A read-only phone-fit list of OPEN estimates that have gone quiet, grouped by
 * job type (cash / insurance / finance), biggest value first, with the next
 * cadence step (day 3, 7, 14, 30 after the estimate went out) and a one-tap
 * DRAFT. It is a layer over what already exists:
 *   - the lead / estimate rules and sent / opened facts come from
 *     estimate-followups.js (window.NBDEstimateFollowups, loaded first);
 *   - "Draft" calls the EXISTING callable fileLeadTextDraft with a template KEY
 *     (est_follow_d3 / _d7 / _d14 / _d30, functions/estimate-follow-templates.js);
 *     the server files one draft_text into the Agent inbox after the STOP /
 *     Do-Not-Text / consent / Kentucky-wording checks. Jo edits it and sends it
 *     himself; the Agent inbox re-checks STOP, Do Not Text, consent, the
 *     messaging kill switch and texting hours at send;
 *   - "I sent it" stamps lastEstimateNudgeAt through the Home card's own
 *     stampNudge, so the board and the Home card share ONE stamp and never
 *     prompt twice for the same touch.
 *
 * NOTHING SENDS FROM HERE. No text, no email, no sms_log, no messaging code, no
 * new send path. Customers with no text consent get a copy-only email wording
 * (never sent) or a "call" row.
 *
 * Money: the customer-facing job value only (leads.jobValue). It is PROJECTED,
 * and labelled so. Only COLLECTED dollars (NBDRevenue, payments dated, refunds
 * off) are called revenue, in the Results tab. No cost, margin or contractor
 * figure is read.
 *
 * Ships DARK behind the `estimateFollowBoard` feature flag
 * (feature_flags/_default). Absent / false = the toolbar button stays hidden and
 * nothing is read or written.
 *
 * Pure logic is exported for tests (module.exports under Node).
 */
(function (root) {
  'use strict';

  // ── pure ─────────────────────────────────────────────────────────────
  var DAY = 86400000;
  var FLAG = 'estimateFollowBoard';
  var MIN_DAYS = 3;                        // N: the board starts here (the Home card starts at 2)
  var CADENCE = [3, 7, 14, 30];            // days since the estimate went out
  var TEMPLATE_KEYS = ['est_follow_d3', 'est_follow_d7', 'est_follow_d14', 'est_follow_d30'];
  var STEP_LABEL = ['Day 3 check-in', 'Day 7 check-in', 'Day 14 check-in', 'Day 30, closing the file'];
  var TRACKS = ['cash', 'insurance', 'finance'];
  var TRACK_LABEL = { cash: 'Cash / retail', insurance: 'Insurance', finance: 'Finance' };
  var RESULT_DAYS = 90;
  // Same words as functions/estimate-follow-templates.js (a test pins them equal).
  var LINES = [
    'I wanted to make sure your roof estimate came through okay. If you have any questions, I am happy to walk through it with you.',
    'I am checking in on your roof estimate. If anything is unclear or you would like to talk it over, just reply and I will go through it with you.',
    'I wanted to check in one more time on your roof estimate. If you went another direction, no hard feelings, just let me know either way.',
    'I will close out your estimate for now. If your plans change, just reply and I will pick it back up.'
  ];
  var FINANCE_LINE = 'If it would help, I can go over payment options with you.';
  var EMAIL_REMINDER = 'Add your mailing address and an unsubscribe line before you send.';
  var SIGNED_STAGES = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered',
    'crew_scheduled', 'install_in_progress', 'install_complete', 'final_photos', 'deductible_collected', 'final_payment',
    'collections', 'closed', 'warranty_claim', 'approved', 'in progress', 'complete', 'closed won'];

  var EF = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./estimate-followups.js') : (root && root.NBDEstimateFollowups) || null;
  // Resolved lazily: in the browser estimate-followups.js may finish loading after this file runs.
  function ef() { if (!EF && root) EF = root.NBDEstimateFollowups || null; return EF; }

  function toMs(t) { return ef() ? ef().toMs(t) : 0; }
  function stageKeyOf(l) { return String((l && (l.stage || l.status)) || '').trim().toLowerCase(); }
  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function firstNameOf(l) {
    var f = String((l && l.firstName) || '').trim();
    if (f) return f.split(/\s+/)[0];
    var n = String((l && (l.name || l.customerName)) || '').trim();
    return n ? n.split(/\s+/)[0] : '';
  }
  function nameOf(l) {
    var n = (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim();
    return n || String(l.name || l.customerName || '').trim() || String(l.address || '').split(',')[0] || 'Customer';
  }

  /** Customer-facing job value in cents. jobValue only: never a cost or margin field. */
  function valueCents(l) {
    var v = Number(l && l.jobValue);
    return isFinite(v) && v > 0 ? Math.round(v * 100) : 0;
  }
  function fmtMoney(cents) {
    var d = Math.round((Number(cents) || 0) / 100);
    return '$' + String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** cash / insurance / finance. The lead's own jobType wins; stage is the fallback. */
  function trackOf(l) {
    var jt = String((l && (l.jobType || l.workType)) || '').toLowerCase();
    if (jt.indexOf('insur') !== -1) return 'insurance';
    if (jt.indexOf('financ') !== -1) return 'finance';
    if (jt.indexOf('cash') !== -1 || jt.indexOf('retail') !== -1) return 'cash';
    var s = stageKeyOf(l);
    if (s === 'estimate_sent_cash') return 'cash';
    if (l && l.claimStatus) return 'insurance';
    return 'cash';
  }

  /** The newest contact Jo made, as a moment. Not updatedAt: that moves on every save. */
  function touchMs(l) {
    return Math.max(toMs(l && l.lastEstimateNudgeAt), toMs(l && l.lastContactedAt));
  }

  /** No contact at all for this person: they asked us to stop. */
  function isHardStop(l) { return !!l && (l.doNotContact === true || l.dnc === true); }

  /** May a text DRAFT be offered? Mirrors the cheap client-side half of the server's textGate; the server stays the judge. */
  function canText(l) {
    if (!l) return false;
    if (digits10(l.phone).length !== 10) return false;
    if (l.tcpaConsent === false) return false;
    if (l.smsOptedOut === true || l.smsOptOut === true || l.doNotText === true) return false;
    return true;
  }
  function canEmail(l) {
    return !!l && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(String(l.email || '').trim()) && l.unsubscribed !== true && l.emailUnsubscribed !== true;
  }
  /** text | email | call */
  function channelOf(l) { return canText(l) ? 'text' : (canEmail(l) ? 'email' : 'call'); }

  /**
   * The next cadence step for an estimate, or null once the day-30 closing
   * message has gone out. done = touches since it was sent; the step is the
   * later of "the next one in line" and "the latest day already passed", so a
   * 46-day-old estimate nobody touched gets the closing wording, not "making
   * sure it came through".
   */
  function nextStep(l, nowMs, sent) {
    var nudge = toMs(l && l.lastEstimateNudgeAt);
    var done = nudge && nudge >= sent ? Math.max(1, Number(l.estimateNudgeCount) || 1) : 0;
    if (done >= CADENCE.length) return null;
    var daysOut = Math.floor((nowMs - sent) / DAY), target = -1, i;
    for (i = 0; i < CADENCE.length; i++) if (CADENCE[i] <= daysOut) target = i;
    var idx = Math.min(CADENCE.length - 1, Math.max(done, target));
    return { index: idx, day: CADENCE[idx], key: TEMPLATE_KEYS[idx], label: STEP_LABEL[idx] };
  }

  /** Copy-only email wording (never sent from here). */
  function emailCopy(stepIndex, track, firstName, business, owner) {
    var i = Math.max(0, Math.min(CADENCE.length - 1, stepIndex | 0));
    var body = 'Hi' + (firstName ? ' ' + firstName : '') + ',\n\n' + LINES[i];
    if (track === 'finance' && i < 3) body += ' ' + FINANCE_LINE;
    body += '\n\n' + (owner ? owner + ', ' : '') + (business || '[your business name]');
    return { subject: 'Your roof estimate', body: body, reminder: EMAIL_REMINDER };
  }

  function lastTouchLabel(l, sent, nowMs) {
    var t = touchMs(l);
    if (t && t >= sent) {
      var d = Math.floor((nowMs - t) / DAY);
      return 'Last touch ' + d + 'd ago';
    }
    return 'No touch since it went out';
  }

  /**
   * The board. Returns { groups, total, valueCents, held, done, waiting, notYet }.
   * A lead is on the board when it is an open estimate, not snoozed, sent at
   * least `minDays` ago, not touched in `minDays`, past its next cadence day,
   * and not marked do-not-contact. Everything else is counted, never shown.
   */
  function buildBoard(leads, nowMs, opts) {
    var o = opts || {};
    var now = nowMs == null ? Date.now() : nowMs;
    var minDays = Math.max(1, Math.min(30, Math.floor(Number(o.minDays)) || MIN_DAYS));
    var waitingIds = o.waitingDraftIds || {};
    var byTrack = { cash: [], insurance: [], finance: [] };
    var out = { groups: [], total: 0, valueCents: 0, held: 0, done: 0, waiting: 0, notYet: 0, minDays: minDays };
    (leads || []).forEach(function (l) {
      if (!l || !l.id || !ef() || !ef().isEstimateLead(l) || ef().isSnoozed(l, now)) return;
      var sent = ef().sentAtMs(l);
      if (!sent || sent > now) return;
      var daysOut = Math.floor((now - sent) / DAY);
      if (daysOut < minDays) { out.notYet++; return; }
      if (isHardStop(l)) { out.held++; return; }
      var step = nextStep(l, now, sent);
      if (!step) { out.done++; return; }
      var quiet = Math.floor((now - Math.max(sent, touchMs(l))) / DAY);
      if (daysOut < step.day || quiet < minDays) { out.waiting++; return; }
      var opened = ef().openedAtMs(l);
      var track = trackOf(l);
      var row = {
        leadId: l.id, name: nameOf(l), firstName: firstNameOf(l), track: track,
        valueCents: valueCents(l), daysOut: daysOut, daysQuiet: quiet, sentAtMs: sent,
        lastTouch: lastTouchLabel(l, sent, now),
        opened: !!opened, openedLabel: ef().openedLabel(opened, now),
        step: step, channel: channelOf(l), draftWaiting: !!waitingIds[l.id]
      };
      byTrack[track].push(row);
      out.total++; out.valueCents += row.valueCents;
    });
    TRACKS.forEach(function (t) {
      var rows = byTrack[t];
      if (!rows.length) return;
      // Opened-but-silent first (they looked and said nothing), then biggest value, then longest quiet.
      rows.sort(function (a, b) {
        return (Number(b.opened) - Number(a.opened)) || (b.valueCents - a.valueCents) || (b.daysQuiet - a.daysQuiet);
      });
      out.groups.push({ track: t, label: TRACK_LABEL[t], rows: rows, valueCents: rows.reduce(function (s, r) { return s + r.valueCents; }, 0) });
    });
    return out;
  }

  function isSigned(l) {
    if (!l) return false;
    if (l.stageRole === 'won' || l.stageRole === 'job') return true;
    return SIGNED_STAGES.indexOf(stageKeyOf(l)) !== -1;
  }
  function median(a) {
    if (!a.length) return null;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  }

  /**
   * Results for follow-ups Jo SENT (lastEstimateNudgeAt, stamped only when he
   * taps "I sent it" or shares from the Home card) in the last `days` days.
   * Counts are counts. Signed value is PROJECTED (jobValue). Collected is the
   * real ledger sum per lead (collectedByLead: leadId -> dollars), the only
   * thing here called revenue; null when the money data has not loaded.
   */
  function metrics(leads, nowMs, collectedByLead, days) {
    var now = nowMs == null ? Date.now() : nowMs;
    var win = Math.max(1, Number(days) || RESULT_DAYS) * DAY;
    var r = { days: Math.round(win / DAY), sent: 0, touches: 0, replied: 0, openedAfter: 0, signed: 0, signedProjectedCents: 0,
      collectedCents: collectedByLead ? 0 : null, medianDaysToSign: null, openProjectedCents: 0, openCount: 0 };
    var toSign = [];
    (leads || []).forEach(function (l) {
      if (!l || !l.id) return;
      if (ef() && ef().isEstimateLead(l)) { r.openCount++; r.openProjectedCents += valueCents(l); }
      var n = toMs(l.lastEstimateNudgeAt);
      if (!n || n > now || now - n > win) return;
      r.sent++;
      r.touches += Math.max(1, Number(l.estimateNudgeCount) || 1);
      if (Math.max(toMs(l.lastInboundAt), toMs(l.lastReplyAt)) > n) r.replied++;
      if (Math.max(toMs(l.lastViewedAt), toMs(l.lastPortalOpenAt)) > n) r.openedAfter++;
      if (isSigned(l)) {
        r.signed++;
        r.signedProjectedCents += valueCents(l);
        if (collectedByLead) r.collectedCents += Math.round((Number(collectedByLead[l.id]) || 0) * 100);
        var signedAt = toMs(l.contractSignedAt), sent = ef() ? ef().sentAtMs(l) : 0;
        if (signedAt && sent && signedAt >= sent) toSign.push(Math.round((signedAt - sent) / DAY));
      }
    });
    r.medianDaysToSign = median(toSign);
    return r;
  }

  var pure = {
    FLAG: FLAG, MIN_DAYS: MIN_DAYS, CADENCE: CADENCE, TEMPLATE_KEYS: TEMPLATE_KEYS, STEP_LABEL: STEP_LABEL, LINES: LINES,
    TRACKS: TRACKS, FINANCE_LINE: FINANCE_LINE, EMAIL_REMINDER: EMAIL_REMINDER, RESULT_DAYS: RESULT_DAYS,
    valueCents: valueCents, fmtMoney: fmtMoney, trackOf: trackOf, touchMs: touchMs, isHardStop: isHardStop, canText: canText,
    canEmail: canEmail, channelOf: channelOf, nextStep: nextStep, emailCopy: emailCopy, buildBoard: buildBoard,
    isSigned: isSigned, metrics: metrics
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (!root || !root.document) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  if (w.NBDEstimateFollowBoard) return;

  var overlay = null;
  var st = { tab: 'board', busy: {}, drafted: {}, waitingIds: {}, msg: '', copyOpen: '', invoices: null, collected: null, loadingMoney: false, moneyTried: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function role() { return String(claims().role || '').toLowerCase(); }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  // The callable refuses viewer / member; a rep may only draft their own leads, so the list is theirs only.
  function available() { return flagOn() && !!ef() && !!w.NBDEstimateFollowups && role() !== 'viewer' && role() !== 'member'; }
  function myLeads() {
    var all = Array.isArray(w._leads) ? w._leads : [], uid = w._user && w._user.uid;
    return role() === 'sales_rep' ? all.filter(function (l) { return l && l.userId === uid; }) : all;
  }
  function brandName() {
    try { var b = typeof w._brand === 'function' ? w._brand() : null; return (b && (b.shortName || b.name)) || ''; } catch (_) { return ''; }
  }
  function ownerFirst() {
    var dn = String((w._user && w._user.displayName) || '').trim().split(/\s+/)[0];
    return dn || '';
  }
  function board() { return buildBoard(myLeads(), Date.now(), { waitingDraftIds: st.waitingIds }); }

  function syncButton() {
    var b = doc.getElementById('estimateFollowBoardBtn');
    if (!b) return;
    var on = available();
    b.hidden = !on;
    var badge = doc.getElementById('estimateFollowBoardBadge');
    if (badge) {
      var n = on ? board().total : 0;
      badge.textContent = String(n);
      badge.hidden = !n;
    }
  }

  // Drafts already waiting in the Agent inbox (owner / company admin can read it; anyone else just sees none).
  async function loadWaiting() {
    st.waitingIds = {};
    try {
      var key = claims().companyId || (w._user && w._user.uid);
      if (!key || !w.getDocs || !w.query || !w.where || !w.collection || !(w.db || w._db)) return;
      var snap = await w.getDocs(w.query(w.collection(w.db || w._db, 'agent_inbox'), w.where('companyId', '==', key), w.where('status', '==', 'pending')));
      snap.docs.forEach(function (d) {
        var x = d.data() || {};
        if ((x.kind === 'draft_text' || x.kind === 'draft_email') && x.leadId) st.waitingIds[x.leadId] = true;
      });
    } catch (e) { /* not readable for this role: the callable's own once-a-day idempotency still holds */ }
  }

  async function loadMoney() {
    if (st.collected || st.loadingMoney || st.moneyTried) return;
    st.loadingMoney = true; st.moneyTried = true;
    try {
      if (!w.NBDRevenue || typeof w.NBDRevenue.loadInvoices !== 'function') throw new Error('money data not loaded on this page');
      st.invoices = await w.NBDRevenue.loadInvoices({});
      st.collected = w.NBDRevenue.collectedByLead(st.invoices || [], null, null);
    } catch (e) { st.collected = null; }
    st.loadingMoney = false;
    paint();
  }

  // ── drafts: the EXISTING callable, a template key, nothing else ─────
  async function callFn(name, data) {
    var ef = w.NBDEstimateFollowups;
    if (ef && typeof ef.callable === 'function') return ef.callable(name, data);
    throw new Error('Drafting is still loading, try again');
  }
  async function draft(leadId, key) {
    if (st.busy[leadId] || !available()) return;
    st.busy[leadId] = true; st.msg = ''; paint();
    try {
      var out = await callFn('fileLeadTextDraft', { leadId: leadId, template: key });
      if (out.status === 'filed' || out.status === 'already_filed') { st.drafted[leadId] = key; st.waitingIds[leadId] = true; }
      st.msg = String(out.message || (out.status === 'filed' ? 'Draft filed.' : 'Not drafted.'));
    } catch (e) { st.msg = 'Could not draft: ' + ((e && e.message) || 'unknown error'); }
    st.busy[leadId] = false; paint();
  }
  async function markSent(leadId, channel) {
    if (st.busy[leadId] || !available()) return;
    var ef = w.NBDEstimateFollowups;
    if (!ef || typeof ef.stampNudge !== 'function') { toast('Still loading, try again', 'error'); return; }
    st.busy[leadId] = true; paint();
    try {
      var saved = await ef.stampNudge(leadId, 'board_' + channel);
      if (saved === true) {
        delete st.waitingIds[leadId]; delete st.drafted[leadId];
        st.msg = 'Marked. The next step comes back on schedule.';
      } else st.msg = 'Could not save that. Nothing was marked; try again.';
    } catch (e) { st.msg = 'Could not save: ' + ((e && e.message) || 'unknown error'); }
    st.busy[leadId] = false; syncButton(); paint();
  }
  function copyEmail(leadId) {
    var el = doc.querySelector('[data-efb-copytext="' + String(leadId).replace(/["\\]/g, '') + '"]');
    if (!el) return;
    var text = el.value;
    var done = function () { st.msg = 'Email wording copied. Nothing was sent.'; paint(); };
    if (w.navigator && w.navigator.clipboard && w.navigator.clipboard.writeText) {
      w.navigator.clipboard.writeText(text).then(done, function () { el.select(); st.msg = 'Select the text and copy it.'; paint(); });
    } else { el.select(); st.msg = 'Select the text and copy it.'; paint(); }
  }

  // ── rendering (every CRM string goes through esc) ───────────────────
  function rowHtml(r) {
    var busy = !!st.busy[r.leadId], dis = busy ? ' disabled' : '';
    var h = '<li class="efb-row" data-efb-id="' + esc(r.leadId) + '"><div class="efb-top">'
      + '<a class="efb-name" href="/pro/customer.html?id=' + encodeURIComponent(r.leadId) + '">' + esc(r.name) + '</a>'
      + '<span class="efb-val">' + (r.valueCents ? esc(fmtMoney(r.valueCents)) : 'No amount') + '</span></div>'
      + '<div class="efb-meta"><span>Out ' + r.daysOut + 'd</span><span>Quiet ' + r.daysQuiet + 'd</span>'
      + '<span class="' + (r.opened ? 'efb-opened' : 'efb-unopened') + '">' + esc(r.openedLabel) + '</span></div>'
      + '<div class="efb-meta"><span>' + esc(r.lastTouch) + '</span><span class="efb-step">Next: ' + esc(r.step.label) + '</span></div>';
    var waiting = r.draftWaiting || st.drafted[r.leadId];
    if (waiting) h += '<div class="efb-note">Draft waiting in your Agent inbox. Edit it there and send it from your phone.</div>';
    h += '<div class="efb-acts">';
    if (r.channel === 'text' && !waiting) {
      h += '<button type="button" class="efb-btn efb-go" data-efb-act="draft" data-efb-id="' + esc(r.leadId) + '" data-efb-key="' + esc(r.step.key) + '"' + dis + '>Draft text</button>';
    } else if (r.channel !== 'text') {
      h += '<span class="efb-chan">' + (r.channel === 'email' ? 'No text consent on file: email or call' : 'No text or email on file: call') + '</span>';
      if (r.channel === 'email') h += '<button type="button" class="efb-btn" data-efb-act="emailpanel" data-efb-id="' + esc(r.leadId) + '">Email wording</button>';
    }
    h += '<button type="button" class="efb-btn" data-efb-act="sent" data-efb-id="' + esc(r.leadId) + '" data-efb-chan="' + esc(r.channel) + '"' + dis + '>' + (r.channel === 'call' ? 'I called' : 'I sent it') + '</button></div>';
    if (st.copyOpen === r.leadId) {
      var e = emailCopy(r.step.index, r.track, r.firstName, brandName(), ownerFirst());
      h += '<div class="efb-copy"><label class="efb-sr" for="efbc_' + esc(r.leadId) + '">Email wording for ' + esc(r.name) + '</label>'
        + '<textarea id="efbc_' + esc(r.leadId) + '" class="efb-ta" readonly rows="8" data-efb-copytext="' + esc(r.leadId) + '">' + esc('Subject: ' + e.subject + '\n\n' + e.body) + '</textarea>'
        + '<p class="efb-hint">' + esc(e.reminder) + '</p>'
        + '<button type="button" class="efb-btn" data-efb-act="copy" data-efb-id="' + esc(r.leadId) + '">Copy</button></div>';
    }
    return h + '</li>';
  }
  function boardHtml() {
    var b = board();
    var h = '<p class="efb-sub">Open estimates that have gone quiet (' + b.minDays + '+ days out, nothing from you in ' + b.minDays + '). <b>Draft text</b> files a draft in your Agent inbox. Nothing sends from here; you send it from your phone, between 10am and 8pm the customer\'s time.</p>';
    if (st.msg) h += '<div class="efb-result" role="status">' + esc(st.msg) + '</div>';
    if (!b.total) {
      return h + '<p class="efb-empty">Nothing needs a follow-up right now.</p>' + countsHtml(b);
    }
    h += '<div class="efb-total">' + b.total + ' estimates · ' + esc(fmtMoney(b.valueCents)) + ' <span class="efb-proj">projected, not revenue</span></div>';
    b.groups.forEach(function (g) {
      h += '<section class="efb-group"><h3 class="efb-gh">' + esc(g.label) + ' <span class="efb-gv">' + g.rows.length + ' · ' + esc(fmtMoney(g.valueCents)) + ' projected</span></h3><ul class="efb-list">'
        + g.rows.map(rowHtml).join('') + '</ul></section>';
    });
    return h + countsHtml(b);
  }
  function countsHtml(b) {
    var bits = [];
    if (b.waiting) bits.push(b.waiting + ' not due yet');
    if (b.done) bits.push(b.done + ' finished the cadence');
    if (b.held) bits.push(b.held + ' marked do-not-contact');
    return bits.length ? '<p class="efb-foot">Not shown: ' + esc(bits.join(' · ')) + '.</p>' : '';
  }
  function resultsHtml() {
    if (!st.collected && !st.loadingMoney && !st.moneyTried) loadMoney();
    var m = metrics(myLeads(), Date.now(), st.collected, RESULT_DAYS);
    var h = '<p class="efb-sub">Follow-ups you sent in the last ' + m.days + ' days (stamped when you tap <b>I sent it</b> or share from the Home card).</p>';
    h += '<div class="efb-stats">'
      + stat('Follow-ups sent', m.sent) + stat('Replied', m.replied) + stat('Opened after', m.openedAfter) + stat('Signed since', m.signed) + '</div>';
    h += '<table class="efb-table"><tbody>'
      + tr('Signed since a follow-up (projected)', fmtMoney(m.signedProjectedCents))
      + tr('Collected from those jobs', m.collectedCents == null ? (st.loadingMoney ? 'Loading…' : 'Not loaded') : fmtMoney(m.collectedCents))
      + tr('Median days from sent to signed', m.medianDaysToSign == null ? 'Not enough data' : m.medianDaysToSign + ' days')
      + tr('Still open (projected)', m.openCount + ' · ' + fmtMoney(m.openProjectedCents))
      + '</tbody></table>'
      + '<p class="efb-foot">Only collected money is revenue. Signed and open values are the job totals on the estimates, projected. A reply counts when the customer\'s last reply is after your last follow-up.</p>';
    return h;
  }
  function stat(label, n) { return '<div class="efb-stat"><b>' + n + '</b><span>' + esc(label) + '</span></div>'; }
  function tr(a, b) { return '<tr><th scope="row">' + esc(a) + '</th><td>' + esc(b) + '</td></tr>'; }

  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;
    overlay.innerHTML = '<div class="efb-box" role="dialog" aria-modal="true" aria-labelledby="efbTitle">'
      + '<div class="efb-head"><h2 class="efb-title" id="efbTitle">Estimate follow-ups</h2><button type="button" class="efb-x" data-efb-act="close" aria-label="Close">×</button></div>'
      + '<div class="efb-tabs"><button type="button" class="efb-tab' + (st.tab === 'board' ? ' on' : '') + '" data-efb-tab="board">Board</button>'
      + '<button type="button" class="efb-tab' + (st.tab === 'results' ? ' on' : '') + '" data-efb-tab="results">Results</button></div>'
      + (st.tab === 'board' ? boardHtml() : resultsHtml()) + '</div>';
    overlay.scrollTop = keep;
  }
  async function open() {
    if (!available()) return false;
    if (overlay) { paint(); return true; }
    st.tab = 'board'; st.msg = ''; st.copyOpen = '';
    overlay = doc.createElement('div');
    overlay.className = 'efb-overlay';
    overlay.setAttribute('data-efb-overlay', '1');
    doc.body.appendChild(overlay);
    paint();
    await loadWaiting();
    paint();
    return true;
  }
  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-efb-act],[data-efb-tab],#estimateFollowBoardBtn');
    if (!t) return;
    if (t.id === 'estimateFollowBoardBtn') { ev.preventDefault(); open(); return; }
    if (!overlay || !available()) return;
    var act = t.getAttribute('data-efb-act'), tab = t.getAttribute('data-efb-tab'), id = t.getAttribute('data-efb-id');
    if (tab) { st.tab = tab === 'results' ? 'results' : 'board'; paint(); return; }
    if (act === 'close') close();
    else if (act === 'draft') draft(id, t.getAttribute('data-efb-key'));
    else if (act === 'sent') markSent(id, t.getAttribute('data-efb-chan') || 'manual');
    else if (act === 'emailpanel') { st.copyOpen = st.copyOpen === id ? '' : id; paint(); }
    else if (act === 'copy') copyEmail(id);
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  function init() {
    syncButton();
    if (w.NBDFlags && typeof w.NBDFlags.load === 'function') {
      Promise.resolve(w.NBDFlags.load()).then(syncButton, function () {});
    }
  }
  w.addEventListener('nbd:data-refreshed', function () { syncButton(); if (overlay) paint(); });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 2000); });
  else setTimeout(init, 2000);
  setInterval(syncButton, 60000);

  w.NBDEstimateFollowBoard = { open: open, close: close, sync: syncButton, available: available, _pure: pure };
})(typeof window !== 'undefined' ? window : this);
