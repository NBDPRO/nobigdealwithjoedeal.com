/**
 * followup-deck.js — overdue follow-ups, one at a time (Jo, 2026-10-02:
 * "make things addressable one thing at a time … save that, so if I only
 * have time to do a few I can").
 *
 * Opens the triage deck (triage-deck.js) over the "N Follow-ups Due" list:
 *   right  = "Followed up" — the next follow-up moves 7 days out (saved now);
 *   left   = Later (nothing written; back of the line, remembered);
 *   ⋯      = Call · Text (your phone's own apps) · Tomorrow · In 3 days ·
 *            In 2 weeks · Clear follow-up · Open customer.
 * Undo puts the previous follow-up date back. Writes only `followUp` +
 * `updatedAt` on the lead, the same field the card's date picker writes
 * ('YYYY-MM-DD', local).
 */
(function () {
  'use strict';
  if (window.NBDFollowUpDeck) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function inDays(n) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + n); return ymd(d); }
  function name(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'Customer'; }
  function digits(p) { return String(p || '').replace(/\D/g, '').slice(-10); }
  function dueText(v) {
    const day = typeof window.nbdFollowUpDay === 'function' ? window.nbdFollowUpDay(v) : new Date(v);
    if (isNaN(day)) return '';
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const n = Math.round((t - day) / 86400000);
    return n === 0 ? 'Due today' : n > 0 ? n + (n === 1 ? ' day' : ' days') + ' overdue' : 'Due ' + day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function stageText(l) {
    const key = typeof window.normalizeStage === 'function' ? window.normalizeStage(l.stage || 'new') : (l.stage || 'new');
    const M = window.STAGE_META || {};
    return (M[key] && M[key].label) || key;
  }

  async function setFollowUp(lead, val) {
    if (!window.updateDoc || !window.db || !window.doc || !window.serverTimestamp) throw new Error('The database is not loaded. Refresh and try again.');
    const prior = lead.followUp == null ? '' : lead.followUp;
    await window.updateDoc(window.doc(window.db, 'leads', lead.id), { followUp: val, updatedAt: window.serverTimestamp() });
    lead.followUp = val;
    return {
      undo: async function () {
        await window.updateDoc(window.doc(window.db, 'leads', lead.id), { followUp: prior, updatedAt: window.serverTimestamp() });
        lead.followUp = prior;
      },
    };
  }

  function card(l) {
    const note = typeof l.notes === 'string' ? l.notes.trim().slice(0, 220) : '';
    return '<div class="deck-name">' + esc(name(l)) + '</div>' +
      '<div><span class="deck-tag">' + esc(dueText(l.followUp)) + '</span></div>' +
      '<div class="deck-sub">' + esc(stageText(l)) + (l.address ? ' · ' + esc(String(l.address).split(',')[0]) : '') + '</div>' +
      (l.phone ? '<div class="deck-sub">' + esc(l.phone) + '</div>' : '') +
      (note ? '<div class="deck-why">' + esc(note) + (l.notes.length > 220 ? '…' : '') + '</div>' : '') +
      '<a class="deck-link" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '" target="_blank" rel="noopener">Open customer ↗</a>';
  }

  function open(overdue) {
    if (!window.NBDTriageDeck) return;
    const items = (overdue || []).filter((l) => l && l.id).slice()
      .sort((a, b) => String(a.followUp).localeCompare(String(b.followUp)))   // most overdue first
      .map((l) => Object.assign({ id: l.id, lead: l }));
    window.NBDTriageDeck.open({
      id: 'followups',
      title: 'Follow-ups due',
      items,
      card: (it) => card(it.lead),
      right: (it) => ({ label: 'Followed up · +7 days', act: () => setFollowUp(it.lead, inDays(7)) }),
      left: { label: 'Later' },
      more: (it) => {
        const l = it.lead, d = digits(l.phone);
        return [].concat(
          d ? [{ label: '📞 Call', href: 'tel:' + d }, { label: '💬 Text', href: 'sms:' + d }] : [],
          [
            { label: 'Tomorrow', act: () => setFollowUp(l, inDays(1)) },
            { label: 'In 3 days', act: () => setFollowUp(l, inDays(3)) },
            { label: 'In 2 weeks', act: () => setFollowUp(l, inDays(14)) },
            { label: 'Clear follow-up', act: () => setFollowUp(l, '') },
            { label: 'Open customer ↗', href: '/pro/customer.html?id=' + encodeURIComponent(l.id) },
          ]
        );
      },
      doneText: 'No follow-ups due. Nice.',
      onClose: (done) => {
        if (done && typeof window.renderLeads === 'function') {
          try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
        }
      },
    });
  }

  // setFollowUp is shared with no-next-step.js — one writer for `followUp`.
  window.NBDFollowUpDeck = { open, setFollowUp, _inDays: inDays };
})();
