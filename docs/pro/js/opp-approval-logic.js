/**
 * opp-approval-logic.js — the pure half of the Thumbtack Opportunities approval cards (2026-11-04).
 *
 * The cards live INSIDE the Follow-up board (follow-up-board.js asks opp-approval.js for a section).
 * This file turns the cards the oppDraftList callable returns into HTML strings and small labels.
 * No DOM, no network, no clock (the caller passes `nowMs`): it is run unchanged under node in
 * tests/opp-approval-ui-2026-11-04.test.js.
 *
 * Every string that came from the server goes through esc(), including the draft text: it holds a
 * short quote of what a stranger wrote on Thumbtack, and an Opportunity's words are DATA, never markup.
 * There is no innerHTML of anything unescaped, no inline handler and no inline style here.
 *
 * Approving only MARKS a draft approved. Nothing is sent from here and no sender exists; the screen says so.
 */
(function (root) {
  'use strict';

  var SKIP_REASONS = [
    { key: 'wrong_trade', label: 'Wrong trade' },
    { key: 'too_far', label: 'Too far' },
    { key: 'too_small', label: 'Too small' },
    { key: 'too_crowded', label: 'Too crowded' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ageLabel(min) {
    if (typeof min !== 'number' || !isFinite(min) || min < 0) return 'posted time unknown';
    if (min < 1) return 'posted just now';
    if (min < 60) return 'posted ' + Math.round(min) + ' min ago';
    var h = Math.floor(min / 60), m = Math.round(min % 60);
    return 'posted ' + h + ' h' + (m ? ' ' + m + ' min' : '') + ' ago';
  }
  function milesLabel(c) {
    if (typeof c.milesNearestBase !== 'number') return 'distance unknown';
    var base = c.baseUsed === 'goshen' ? 'Goshen' : c.baseUsed === 'cincinnati' ? 'Cincinnati' : 'nearest base';
    return (Math.round(c.milesNearestBase * 10) / 10) + ' mi from ' + base;
  }
  function prosLabel(n) {
    if (typeof n !== 'number') return 'pros already in: unknown';
    return n + (n === 1 ? ' pro already in' : ' pros already in');
  }
  function photosLabel(n) { return typeof n === 'number' && n > 0 ? 'photos: yes' : 'photos: no'; }

  /** "Approved today 3 of 8 · this week 9 of 25", or a plain "unknown" when the counts did not come back. */
  function capLine(caps) {
    if (!caps) return 'Approval counts unknown.';
    var d = typeof caps.approvedToday === 'number' ? caps.approvedToday : null;
    var w = typeof caps.approvedThisWeek === 'number' ? caps.approvedThisWeek : null;
    if (d === null || w === null) return 'Approval counts unknown.';
    return 'Approved today ' + d + ' of ' + caps.perDay + ' · this week ' + w + ' of ' + caps.perWeek;
  }
  /** True when one more approval would be refused. Unknown counts count as full (the server fails closed the same way). */
  function capsFull(caps) {
    if (!caps || typeof caps.approvedToday !== 'number' || typeof caps.approvedThisWeek !== 'number') return true;
    return caps.approvedToday >= caps.perDay || caps.approvedThisWeek >= caps.perWeek;
  }

  /** Split the server's cards: waiting now, snoozed (hidden until the hour is up), approved. */
  function partition(cards, nowMs) {
    var out = { active: [], snoozed: [], approved: [] };
    (Array.isArray(cards) ? cards : []).forEach(function (c) {
      if (!c || typeof c.oppId !== 'string') return;
      if (c.status === 'approved') out.approved.push(c);
      else if (c.status === 'pending') {
        if (typeof c.snoozedUntilMs === 'number' && c.snoozedUntilMs > nowMs) out.snoozed.push(c);
        else out.active.push(c);
      }
    });
    return out;
  }

  function titleOf(c) {
    var place = [c.city, c.zip].filter(Boolean).join(' ');
    return (c.category || 'Opportunity') + (place ? ' · ' + place : '');
  }

  /**
   * One pending card.
   * ui = { editing, text (what the box holds), skipping, busy, msg }; data = the list response (caps, inSendHours, sendLabel).
   */
  function pendingHtml(c, ui, data) {
    ui = ui || {};
    var id = esc(c.oppId), dis = ui.busy ? ' disabled' : '';
    var h = '<li class="fub-row opp-card" data-opp-id="' + id + '"><div class="fub-top"><span class="fub-name">' + esc(titleOf(c)) + '</span>'
      + (typeof c.score === 'number' ? '<span class="fub-val">' + esc(Math.round(c.score)) + '/100</span>' : '') + '</div>';
    h += '<div class="fub-meta"><span>' + esc(ageLabel(c.ageNowMin)) + '</span><span>' + esc(milesLabel(c)) + '</span><span>' + esc(prosLabel(c.prosAlready))
      + '</span><span>' + esc(photosLabel(c.photos)) + '</span></div>';
    if (c.flags && c.flags.length) h += '<div class="opp-flag" role="note">Flagged: ' + esc(c.flags.join(', ')) + '</div>';
    if (c.reasons && c.reasons.length) {
      h += '<div class="opp-why"><b>Why it was shortlisted</b><ul>' + c.reasons.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul></div>';
    }
    h += '<div class="opp-label" id="oppL-' + id + '">Message to send' + (c.editedByJo ? ' (edited by you)' : '') + '</div>';
    if (ui.editing) {
      h += '<textarea class="fub-in opp-ta" rows="6" maxlength="2000" data-opp-text="' + id + '" aria-labelledby="oppL-' + id + '">' + esc(ui.text) + '</textarea>';
    } else {
      h += '<p class="opp-text" aria-labelledby="oppL-' + id + '">' + esc(c.text) + '</p>';
    }
    if (ui.msg) h += '<div class="fub-result" role="status">' + esc(ui.msg) + '</div>';
    var full = capsFull(data && data.caps);
    var willSend = data && data.inSendHours === false ? ' (' + esc(data.sendLabel || 'will send 8am') + ')' : '';
    h += '<div class="fub-acts">';
    h += '<button type="button" class="fub-btn fub-go" data-opp-act="approve" data-opp-id="' + id + '"' + (dis || (full ? ' disabled' : '')) + '>Approve' + willSend + '</button>';
    if (ui.editing) {
      h += '<button type="button" class="fub-btn" data-opp-act="saveedit" data-opp-id="' + id + '"' + dis + '>Save edit</button>'
        + '<button type="button" class="fub-btn" data-opp-act="canceledit" data-opp-id="' + id + '"' + dis + '>Cancel edit</button>';
    } else {
      h += '<button type="button" class="fub-btn" data-opp-act="edit" data-opp-id="' + id + '"' + dis + '>Edit</button>';
    }
    h += '<button type="button" class="fub-btn" data-opp-act="snooze" data-opp-id="' + id + '"' + dis + '>Snooze 1h</button>';
    h += '<button type="button" class="fub-btn" data-opp-act="skipopen" data-opp-id="' + id + '" aria-expanded="' + (ui.skipping ? 'true' : 'false') + '"' + dis + '>Skip</button>';
    h += '</div>';
    if (full) h += '<div class="fub-note">' + esc(capLine(data && data.caps)) + '. The cap is reached, so nothing more can be approved.</div>';
    if (ui.skipping) {
      h += '<div class="opp-skip" role="group" aria-label="Why skip this one"><span class="fub-hint">Why skip?</span>'
        + SKIP_REASONS.map(function (r) {
          return '<button type="button" class="fub-btn" data-opp-act="skip" data-opp-reason="' + esc(r.key) + '" data-opp-id="' + id + '"' + dis + '>' + esc(r.label) + '</button>';
        }).join('')
        + '<button type="button" class="fub-btn" data-opp-act="skipclose" data-opp-id="' + id + '">Never mind</button></div>';
    }
    return h + '</li>';
  }

  /** An approved card: read-only. It says plainly that nothing has been sent. */
  function approvedHtml(c) {
    return '<li class="fub-row opp-card opp-done" data-opp-id="' + esc(c.oppId) + '"><div class="fub-top"><span class="fub-name">' + esc(titleOf(c)) + '</span>'
      + '<span class="fub-chip">Approved' + (c.sendLabel ? ' · ' + esc(c.sendLabel) : '') + '</span></div>'
      + '<p class="opp-text">' + esc(c.text) + '</p>'
      + '<div class="fub-note">Marked approved. Nothing has been sent: the sender is not built yet.</div></li>';
  }

  /**
   * The whole section. state = { data, loading, error, msg, ui: { [oppId]: ui } }.
   * Returns '' when there is nothing to say (the caller decides whether the section is available).
   */
  function sectionHtml(state, nowMs) {
    state = state || {};
    var d = state.data;
    var h = '<section class="fub-group opp-section" aria-labelledby="oppTitle"><h3 class="fub-gh" id="oppTitle">Thumbtack Opportunities to approve</h3>'
      + '<p class="fub-sub">One tap approves one draft. Approving only marks it approved: <b>nothing is sent from here</b>, and there is no sender yet. '
      + 'Sends are planned for 8am to 8pm Eastern only; you can approve any time.</p>';
    if (state.msg) h += '<div class="fub-result" role="status">' + esc(state.msg) + '</div>';
    if (state.error) h += '<div class="fub-result" role="alert">' + esc(state.error) + '</div>';
    if (!d) {
      h += state.loading ? '<p class="fub-hint">Loading drafts…</p>' : '';
      return h + '</section>';
    }
    h += '<div class="opp-caps" role="status">' + esc(capLine(d.caps)) + '</div>';
    var p = partition(d.cards, nowMs);
    if (!p.active.length && !p.approved.length && !p.snoozed.length) h += '<p class="fub-empty">No Thumbtack drafts waiting.</p>';
    if (p.active.length) {
      h += '<ul class="fub-list">' + p.active.map(function (c) { return pendingHtml(c, (state.ui || {})[c.oppId], d); }).join('') + '</ul>';
    } else if (p.snoozed.length || p.approved.length) {
      h += '<p class="fub-hint">Nothing waiting for a decision right now.</p>';
    }
    if (p.snoozed.length) h += '<p class="fub-foot">' + p.snoozed.length + ' snoozed for an hour.</p>';
    if (p.approved.length) {
      h += '<h4 class="opp-sub">Approved</h4><ul class="fub-list">' + p.approved.map(approvedHtml).join('') + '</ul>';
    }
    return h + '</section>';
  }

  var api = {
    SKIP_REASONS: SKIP_REASONS, esc: esc, ageLabel: ageLabel, milesLabel: milesLabel, prosLabel: prosLabel, photosLabel: photosLabel,
    capLine: capLine, capsFull: capsFull, partition: partition, titleOf: titleOf, pendingHtml: pendingHtml, approvedHtml: approvedHtml, sectionHtml: sectionHtml
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else if (root) root.NBDOppApprovalLogic = api;
})(typeof window !== 'undefined' ? window : null);
