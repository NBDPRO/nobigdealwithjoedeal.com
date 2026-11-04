/**
 * opp-approval.js — the Thumbtack Opportunities approval section of the Follow-up board (2026-11-04).
 *
 * The Follow-up board (follow-up-board.js) asks this module for a section while its overlay is open.
 * The cards come from the owner-only oppDraftList callable; Approve / Edit / Skip / Snooze go to the
 * owner-only oppDraftDecide callable. The browser never touches opp_drafts or opp_seen directly
 * (firestore.rules deny every client).
 *
 * NOTHING SENDS FROM HERE. Approve only marks one draft `approved` on the server. There is no sender,
 * no Thumbtack access, no browser step, and no "approve all": every button acts on the one card it sits on.
 * The reserved flag thumbtackOppSend is not read.
 *
 * Ships DARK behind the `thumbtackOpportunities` feature flag (feature_flags per user, default off), on
 * top of the Follow-up board's own `followUpBoard` flag. Flag off = renders nothing, reads nothing,
 * writes nothing. Every string from the server goes through esc() (opp-approval-logic.js). Strict CSP:
 * no inline handler, no inline style; one delegated click listener and one input listener.
 */
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  var w = root, doc = root.document;
  if (w.NBDOppApproval) return;

  var FLAG = 'thumbtackOpportunities';
  var st = { data: null, loading: false, error: '', msg: '', ui: {}, off: false, repaint: null, active: false };
  var busy = false;

  function claims() { return w._userClaims || {}; }
  function role() { return String(claims().role || '').toLowerCase(); }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function L() { return w.NBDOppApprovalLogic || null; }
  // The callables are owner-only; the section is simply not offered to the roles that can never use it.
  function available() { return flagOn() && !!L() && !st.off && role() !== 'viewer' && role() !== 'member' && role() !== 'sales_rep'; }
  function ui(id) { return st.ui[id] || (st.ui[id] = {}); }
  function repaint() { if (typeof st.repaint === 'function') st.repaint(); }
  async function call(name, data) {
    var ef = w.NBDEstimateFollowups;
    if (!ef || typeof ef.callable !== 'function') throw new Error('Still loading, try again');
    return ef.callable(name, data);
  }

  // A refusal from the server for the whole section (flag off, kill switch, not the owner) hides the section;
  // it is not an error the owner needs to read about.
  function sectionOff(out) { return !!out && out.status === 'not_allowed' && (out.code === 'feature_off' || out.code === 'kill_switch'); }
  function isPermission(e) { return !!e && (e.code === 'functions/permission-denied' || e.code === 'permission-denied'); }

  async function load() {
    if (!available()) return false;
    st.loading = true; st.error = '';
    repaint();
    try {
      var out = await call('oppDraftList', {});
      if (sectionOff(out)) { st.off = true; st.data = null; }
      else if (out && out.status === 'done' && Array.isArray(out.cards)) st.data = out;
      else st.error = 'Could not read the drafts just now.';
    } catch (e) {
      if (isPermission(e)) { st.off = true; st.data = null; }
      else st.error = 'Could not read the drafts: ' + ((e && e.message) || 'unknown error');
    }
    st.loading = false;
    repaint();
    return true;
  }

  function html() {
    if (!available() || !L()) return '';
    return L().sectionHtml({ data: st.data, loading: st.loading, error: st.error, msg: st.msg, ui: st.ui }, Date.now());
  }

  // What is in the edit box right now, read from the page, so Approve sends exactly what Jo sees.
  function liveText(id) {
    var boxes = doc.querySelectorAll ? doc.querySelectorAll('[data-opp-text]') : [];
    for (var i = 0; i < boxes.length; i++) if (boxes[i].getAttribute('data-opp-text') === id) return String(boxes[i].value);
    return null;
  }
  function cardOf(id) {
    var cards = (st.data && st.data.cards) || [];
    for (var i = 0; i < cards.length; i++) if (cards[i].oppId === id) return cards[i];
    return null;
  }

  async function decide(id, action, extra) {
    if (busy || !available()) return;
    var card = cardOf(id), u = ui(id);
    if (!card) return;
    busy = true; u.busy = true; u.msg = ''; st.msg = '';
    repaint();
    var reload = false;
    try {
      var payload = { oppId: id, action: action };
      if (action === 'approve' || action === 'edit') {
        var t = u.editing ? (liveText(id) != null ? liveText(id) : u.text) : card.text;
        payload.text = String(t == null ? '' : t);
      }
      if (action === 'skip') payload.reason = extra;
      var out = await call('oppDraftDecide', payload);
      if (sectionOff(out)) { st.off = true; }
      else if (out.status === 'approved' || out.status === 'already_approved') { delete st.ui[id]; st.msg = String(out.message || 'Approved.') + (out.sendLabel ? ' (' + out.sendLabel + ')' : ''); reload = true; }
      else if (out.status === 'skipped' || out.status === 'already_skipped') { delete st.ui[id]; st.msg = String(out.message || 'Skipped.'); reload = true; }
      else if (out.status === 'snoozed') { delete st.ui[id]; st.msg = String(out.message || 'Snoozed.'); reload = true; }
      else if (out.status === 'edited') { u.editing = false; u.msg = String(out.message || 'Saved.'); reload = true; }
      else { u.msg = String(out.message || 'Not done. Nothing was changed.'); if (out.code === 'not_pending' || out.code === 'not_found' || out.code === 'expired') reload = true; }
    } catch (e) {
      u.msg = 'Could not save: ' + ((e && e.message) || 'unknown error') + ' Nothing was changed.';
    }
    busy = false;
    var still = st.ui[id]; if (still) still.busy = false;
    if (reload) await load(); else repaint();
  }

  function onClick(ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('[data-opp-act]');
    if (!t || !st.active || !available()) return;
    var a = t.getAttribute('data-opp-act'), id = t.getAttribute('data-opp-id'), card = cardOf(id);
    if (!card) return;
    var u = ui(id);
    if (a === 'approve') decide(id, 'approve');
    else if (a === 'snooze') decide(id, 'snooze');
    else if (a === 'skip') decide(id, 'skip', t.getAttribute('data-opp-reason'));
    else if (a === 'saveedit') decide(id, 'edit');
    else if (a === 'edit') { u.editing = true; u.text = card.text; u.msg = ''; repaint(); }
    else if (a === 'canceledit') { u.editing = false; u.msg = ''; delete u.text; repaint(); }
    else if (a === 'skipopen') { u.skipping = !u.skipping; repaint(); }
    else if (a === 'skipclose') { u.skipping = false; repaint(); }
  }
  doc.addEventListener('click', onClick);
  doc.addEventListener('input', function (ev) {
    var t = ev.target, id = t && t.getAttribute && t.getAttribute('data-opp-text');
    if (id && st.active) ui(id).text = String(t.value);   // remembered so a repaint never loses what Jo typed
  });

  // open(repaintFn): the board calls this when its overlay opens; close() when it closes.
  async function open(repaintFn) {
    st.repaint = repaintFn; st.active = true; st.msg = ''; st.error = '';
    if (!available()) return false;
    return load();
  }
  function close() { st.active = false; st.repaint = null; st.ui = {}; st.msg = ''; }

  w.NBDOppApproval = { open: open, close: close, html: html, available: available, reload: load };
})(typeof window !== 'undefined' ? window : null);
