/**
 * follow-up-board.js — the Follow-up board screen (2026-11-03).
 *
 * The DOM half of the Follow-up board; the ranking is in follow-up-board-logic.js
 * (loaded first, with estimate-follow-board.js and estimate-followups.js).
 * Four sections in Jo's order: customers waiting on your reply, estimates you
 * promised, estimates sent with no answer, new leads nobody has touched.
 *
 * NOTHING SENDS FROM HERE. "Draft text" calls the EXISTING fileLeadTextDraft
 * callable with a template KEY (never words); the server files one draft_text
 * into the Agent inbox after its STOP / Do-Not-Text / consent / Kentucky-wording
 * gates, and Jo edits and sends it himself. The other buttons only stamp a
 * lead field ("I replied" = lastOutboundAt, "I promised an estimate" =
 * estimatePromisedAt) or snooze the lead.
 *
 * The Thumbtack Opportunities approval cards (flag thumbtackOpportunities, opp-approval.js) render as
 * one more section at the top of this overlay when that second flag is on; this file only asks for
 * the section and repaints. Approving there only marks a draft approved: nothing sends.
 *
 * Ships DARK behind the `followUpBoard` feature flag (feature_flags/_default).
 * Absent / false = the toolbar button stays hidden and nothing is read or
 * written. Strict CSP: no inline handlers, one delegated listener.
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var w = root, doc = root.document;
  if (w.NBDFollowUpBoard) return;

  var DAY = 86400000;
  var FLAG = 'followUpBoard';
  var overlay = null;
  var st = { busy: {}, waitingIds: {}, drafted: {}, msg: '', picking: false, q: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function claims() { return w._userClaims || {}; }
  function role() { return String(claims().role || '').toLowerCase(); }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function L() { return w.NBDFollowUpLogic || null; }
  function EB() { return (w.NBDEstimateFollowBoard && w.NBDEstimateFollowBoard._pure) || null; }
  // The callable refuses viewer / member; a rep may only draft their own leads, so the list is theirs only.
  function available() { return flagOn() && !!L() && !!EB() && !!w.NBDEstimateFollowups && role() !== 'viewer' && role() !== 'member'; }
  function myLeads() {
    var all = Array.isArray(w._leads) ? w._leads : [], uid = w._user && w._user.uid;
    return role() === 'sales_rep' ? all.filter(function (l) { return l && l.userId === uid; }) : all;
  }
  function data() { return L().buildFollowUps(myLeads(), Date.now(), { waitingDraftIds: st.waitingIds }); }
  function fmt(c) { return EB().fmtMoney(c); }

  function syncButton() {
    var b = doc.getElementById('followUpBoardBtn');
    if (!b) return;
    var on = available();
    b.hidden = !on;
    var badge = doc.getElementById('followUpBoardBadge');
    if (badge) {
      var n = on ? data().total : 0;
      badge.textContent = String(n);
      badge.hidden = !n;
    }
  }

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

  // ── writes: one lead field at a time, the lead rules already allow them ──
  function patchLocal(leadId, patch) {
    if (!Array.isArray(w._leads)) return;
    var i = w._leads.findIndex(function (l) { return l && l.id === leadId; });
    if (i >= 0) w._leads[i] = Object.assign({}, w._leads[i], patch);
  }
  async function writeLead(leadId, remote, local) {
    if (!(w.db && w.doc && w.updateDoc)) return false;
    try { await w.updateDoc(w.doc(w.db, 'leads', leadId), remote); } catch (e) { console.warn('[follow-up-board] write failed', e && e.message); return false; }
    patchLocal(leadId, local);
    return true;
  }
  async function act(leadId, fn, okMsg) {
    if (st.busy[leadId] || !available()) return;
    st.busy[leadId] = true; st.msg = ''; paint();
    try { st.msg = (await fn()) ? okMsg : 'Could not save that. Nothing was changed; try again.'; }
    catch (e) { st.msg = 'Could not save: ' + ((e && e.message) || 'unknown error'); }
    st.busy[leadId] = false; syncButton(); paint();
  }
  function replied(leadId) {
    return act(leadId, function () {
      var now = new Date();
      return writeLead(leadId, { lastOutboundAt: w.serverTimestamp ? w.serverTimestamp() : now }, { lastOutboundAt: now });
    }, 'Marked as answered. It comes back only if the customer writes again.');
  }
  function promised(leadId) {
    return act(leadId, function () {
      var p = L().promisePatch(Date.now());
      return writeLead(leadId, p, p);
    }, 'Saved. If the estimate has not gone out in 4 hours it shows up here.');
  }
  function clearPromise(leadId) {
    return act(leadId, function () { return writeLead(leadId, { estimatePromisedAt: null }, { estimatePromisedAt: null }); }, 'Promise cleared.');
  }
  function sentIt(leadId, channel) {
    var ef = w.NBDEstimateFollowups;
    if (!ef || typeof ef.stampNudge !== 'function') { toast('Still loading, try again', 'error'); return; }
    return act(leadId, async function () { return (await ef.stampNudge(leadId, 'followup_' + channel)) === true; }, 'Marked. The next step comes back on schedule.');
  }
  function snooze(leadId) {
    var LS = w.LeadSnooze;
    if (!LS || typeof LS.snooze !== 'function') { toast('Snooze is still loading, try again', 'error'); return; }
    return act(leadId, async function () { await LS.snooze(leadId, new Date(Date.now() + 3 * DAY), 'follow_up_board'); return true; }, 'Snoozed for 3 days.');
  }
  async function draft(leadId, key) {
    if (st.busy[leadId] || !available()) return;
    var ef = w.NBDEstimateFollowups;
    st.busy[leadId] = true; st.msg = ''; paint();
    try {
      if (!ef || typeof ef.callable !== 'function') throw new Error('Drafting is still loading, try again');
      var out = await ef.callable('fileLeadTextDraft', { leadId: leadId, template: key });
      if (out.status === 'filed' || out.status === 'already_filed') { st.drafted[leadId] = key; st.waitingIds[leadId] = true; }
      st.msg = String(out.message || (out.status === 'filed' ? 'Draft filed.' : 'Not drafted.'));
    } catch (e) { st.msg = 'Could not draft: ' + ((e && e.message) || 'unknown error'); }
    st.busy[leadId] = false; paint();
  }

  // ── rendering (every CRM string goes through esc) ──
  function rowHtml(r) {
    var dis = st.busy[r.leadId] ? ' disabled' : '', id = esc(r.leadId);
    var h = '<li class="fub-row" data-fub-id="' + id + '"><div class="fub-top">'
      + '<a class="fub-name" href="/pro/customer.html?id=' + encodeURIComponent(r.leadId) + '">' + esc(r.name) + '</a>'
      + '<span class="fub-val">' + (r.valueCents ? esc(fmt(r.valueCents)) : 'No amount') + '</span></div>'
      + '<div class="fub-meta">' + (r.source ? '<span class="fub-chip">' + esc(r.source) + '</span>' : '')
      + '<span>' + esc(r.age) + '</span><span>' + esc(r.lastAction) + '</span>' + (r.step ? '<span class="fub-step">Next: ' + esc(r.step) + '</span>' : '') + '</div>';
    var waiting = r.draftWaiting || st.drafted[r.leadId];
    if (waiting) h += '<div class="fub-note">Draft waiting in your Agent inbox. Edit it there and send it from your phone.</div>';
    h += '<div class="fub-acts">';
    if (r.canDraft && !waiting) h += '<button type="button" class="fub-btn fub-go" data-fub-act="draft" data-fub-id="' + id + '" data-fub-key="' + esc(r.templateKey) + '"' + dis + '>Draft text</button>';
    if (!r.canDraft) h += '<span class="fub-chan">' + (r.channel === 'email' ? 'No text consent on file: email or call' : 'No text on file: call') + '</span>';
    if (r.section === 'waiting' || r.section === 'stale') h += '<button type="button" class="fub-btn" data-fub-act="replied" data-fub-id="' + id + '"' + dis + '>' + (r.section === 'waiting' ? 'I replied' : 'I reached out') + '</button>';
    if (r.section === 'promised') h += '<button type="button" class="fub-btn" data-fub-act="clearpromise" data-fub-id="' + id + '"' + dis + '>Clear promise</button>';
    if (r.section === 'quiet') h += '<button type="button" class="fub-btn" data-fub-act="sent" data-fub-id="' + id + '" data-fub-chan="' + esc(r.channel) + '"' + dis + '>' + (r.channel === 'call' ? 'I called' : 'I sent it') + '</button>';
    h += '<button type="button" class="fub-btn" data-fub-act="snooze" data-fub-id="' + id + '"' + dis + '>Snooze 3 days</button></div></li>';
    return h;
  }
  function pickerHtml() {
    var q = st.q.trim().toLowerCase(), E = w.NBDEstimateFollowups;
    var hits = myLeads().filter(function (l) {
      if (!l || !l.id || E.isClosedLead(l)) return false;
      var n = (String(l.firstName || '') + ' ' + String(l.lastName || '') + ' ' + String(l.name || '')).toLowerCase();
      return q && n.indexOf(q) !== -1;
    }).slice(0, 6);
    var h = '<div class="fub-pick"><label class="fub-sr" for="fubQ">Search customers</label>'
      + '<input id="fubQ" class="fub-in" type="search" autocomplete="off" placeholder="Customer name" value="' + esc(st.q) + '" data-fub-q="1">';
    if (q && !hits.length) h += '<p class="fub-hint">No match.</p>';
    h += '<ul class="fub-list">' + hits.map(function (l) {
      return '<li><button type="button" class="fub-btn fub-pickbtn" data-fub-act="promisedpick" data-fub-id="' + esc(l.id) + '">'
        + esc((String(l.firstName || '') + ' ' + String(l.lastName || '')).trim() || l.name || 'Customer') + '</button></li>';
    }).join('') + '</ul></div>';
    return h;
  }
  function boardHtml() {
    var d = data();
    var h = '<p class="fub-sub">Who needs you next, in order. <b>Draft text</b> files a draft in your Agent inbox. Nothing sends from here; you send it from your phone, between 10am and 8pm the customer\'s time.</p>';
    h += '<button type="button" class="fub-btn fub-promise" data-fub-act="promisepanel">I promised an estimate</button>';
    if (st.picking) h += pickerHtml();
    if (st.msg) h += '<div class="fub-result" role="status">' + esc(st.msg) + '</div>';
    var opp = w.NBDOppApproval;
    if (opp && typeof opp.html === 'function') h += opp.html();   // '' unless thumbtackOpportunities is on
    if (!d.total) h += '<p class="fub-empty">Nobody needs a follow-up right now.</p>';
    else h += '<div class="fub-total">' + d.total + ' to follow up · ' + esc(fmt(d.valueCents)) + ' <span class="fub-proj">projected, not revenue</span></div>';
    d.sections.forEach(function (s) {
      if (!s.rows.length) return;
      h += '<section class="fub-group"><h3 class="fub-gh">' + esc(s.label) + ' <span class="fub-gv">' + s.rows.length + ' · ' + esc(fmt(s.valueCents)) + ' projected</span></h3><ul class="fub-list">'
        + s.rows.map(rowHtml).join('') + '</ul></section>';
    });
    var held = [];
    if (d.held.dnc) held.push(d.held.dnc + ' marked do-not-contact');
    if (d.held.snoozed) held.push(d.held.snoozed + ' snoozed');
    if (held.length) h += '<p class="fub-foot">Not shown: ' + esc(held.join(' · ')) + '.</p>';
    return h;
  }
  function paint() {
    if (!overlay) return;
    var keep = overlay.scrollTop || 0;
    var q = overlay.querySelector('[data-fub-q]'), hadFocus = q && doc.activeElement === q;
    overlay.innerHTML = '<div class="fub-box" role="dialog" aria-modal="true" aria-labelledby="fubTitle">'
      + '<div class="fub-head"><h2 class="fub-title" id="fubTitle">Follow-ups</h2><button type="button" class="fub-x" data-fub-act="close" aria-label="Close">×</button></div>'
      + boardHtml() + '</div>';
    overlay.scrollTop = keep;
    if (hadFocus) { var nq = overlay.querySelector('[data-fub-q]'); if (nq) { nq.focus(); try { nq.setSelectionRange(nq.value.length, nq.value.length); } catch (_) { /* search inputs may refuse */ } } }
  }
  async function open() {
    if (!available()) return false;
    if (overlay) { paint(); return true; }
    st.msg = ''; st.picking = false; st.q = '';
    overlay = doc.createElement('div');
    overlay.className = 'fub-overlay';
    overlay.setAttribute('data-fub-overlay', '1');
    doc.body.appendChild(overlay);
    paint();
    if (w.NBDOppApproval && typeof w.NBDOppApproval.open === 'function') w.NBDOppApproval.open(paint);   // loads its own cards, repaints when they land
    await loadWaiting();
    paint();
    return true;
  }
  function close() {
    if (w.NBDOppApproval && typeof w.NBDOppApproval.close === 'function') w.NBDOppApproval.close();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-fub-act],#followUpBoardBtn');
    if (!t) return;
    if (t.id === 'followUpBoardBtn') { ev.preventDefault(); open(); return; }
    if (!overlay || !available()) return;
    var a = t.getAttribute('data-fub-act'), id = t.getAttribute('data-fub-id');
    if (a === 'close') close();
    else if (a === 'draft') draft(id, t.getAttribute('data-fub-key'));
    else if (a === 'replied') replied(id);
    else if (a === 'clearpromise') clearPromise(id);
    else if (a === 'sent') sentIt(id, t.getAttribute('data-fub-chan') || 'manual');
    else if (a === 'snooze') snooze(id);
    else if (a === 'promisepanel') { st.picking = !st.picking; st.q = ''; paint(); }
    else if (a === 'promisedpick') { st.picking = false; st.q = ''; promised(id); }
  });
  doc.addEventListener('input', function (ev) {
    var t = ev.target;
    if (overlay && t && t.getAttribute && t.getAttribute('data-fub-q')) { st.q = t.value; paint(); }
  });
  doc.addEventListener('keydown', function (ev) { if (overlay && ev.key === 'Escape') close(); });

  function init() {
    syncButton();
    if (w.NBDFlags && typeof w.NBDFlags.load === 'function') {
      Promise.resolve(w.NBDFlags.load()).then(syncButton, function () {});
    }
  }
  w.addEventListener('nbd:data-refreshed', function () { syncButton(); if (overlay) paint(); });
  // The button lives in the lazily-mounted CRM view template, and the flags can land after the first
  // sync, so a sync that ran before either found no button or no flag and nothing re-ran it (2026-11-04).
  // 'nbd:flags-loaded' = flags arrived; 'nbd:view-entered' (goTo, after the template is hydrated) = the
  // Pipeline view just mounted. Leads loading/changing already arrive as 'nbd:data-refreshed' above.
  w.addEventListener('nbd:flags-loaded', function () { syncButton(); });
  w.addEventListener('nbd:view-entered', function (ev) {
    var n = ev && ev.detail && ev.detail.name;
    if (n === 'crm') syncButton();
  });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { setTimeout(init, 2200); });
  else setTimeout(init, 2200);
  setInterval(syncButton, 60000);

  // markPromised is public so a customer-card button can call it later.
  w.NBDFollowUpBoard = { open: open, close: close, sync: syncButton, available: available, markPromised: promised };
})(typeof window !== 'undefined' ? window : null);
