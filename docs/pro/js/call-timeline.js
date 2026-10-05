/**
 * call-timeline.js — phone calls and texts on the customer timeline
 * (2026-10-03, "the CRM knows I called").
 *
 * The Call Center files each noted call on the customer as
 * leads/{id}/activity/cube-<callId> (functions/call-center-logic.js
 * buildCallActivity) and each day of texts as leads/{id}/activity/sms-<dayId>
 * (functions/text-inbox.js). Nothing read them, so the summary Jo's phone
 * call produced never showed on the customer page. fromActivity() turns one
 * such doc into a timeline row; customer-bootstrap.module.js loadTimeline and
 * the PDF report gather call it.
 *
 * Only cube- / sms- docs, plus voice memos: the other writers to that
 * subcollection (thursday-<id>, measurement, rep notes) are already shown
 * from their own sources, and showing them here would list them twice.
 *
 * Voice memos (2026-10-04): transcribeVoiceMemo (the card-detail Voice Memo
 * button) files { type: 'voice_memo', transcript } under an auto id. Nothing
 * else shows them, so without this row a saved memo was invisible.
 *
 * The summary and promises are AI output from what a CUSTOMER said — treat
 * them as untrusted. This returns plain strings; the timeline escapes every
 * field before it reaches innerHTML.
 */
(function (root) {
  'use strict';

  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.toMillis === 'function') return new Date(v.toMillis());
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    if (typeof v === 'number') return new Date(v);
    const t = Date.parse(v);
    return isFinite(t) ? new Date(t) : null;
  }
  const str = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);

  /** One activity doc → { time, kind, title, desc, type } or null. */
  function fromActivity(id, a) {
    if (a && typeof a === 'object' && a.type === 'voice_memo') return fromVoiceMemo(a);
    const m = /^(cube|sms)-/.exec(String(id || ''));
    if (!m || !a || typeof a !== 'object') return null;
    const text = m[1] === 'sms';
    const mine = (Array.isArray(a.promises) ? a.promises : [])
      .filter((p) => p && p.who === 'jo' && typeof p.text === 'string' && p.text.trim())
      .map((p) => str(p.text, 160));
    const dur = Math.round(Number(a.durationSec) || 0);
    const parts = [str(a.summary, 700)];
    if (mine.length) parts.push('You said you would: ' + mine.join('; '));
    if (a.followUpDate && /^\d{4}-\d{2}-\d{2}$/.test(String(a.followUpDate))) parts.push('Follow up ' + a.followUpDate);
    return {
      // When the call happened (startedAtMs, since 2026-10-03); older entries
      // only carry when they were filed.
      time: toDate(a.startedAtMs) || toDate(a.createdAt) || new Date(0),
      kind: text ? 'text' : 'call',
      title: (str(a.label, 120) || (text ? 'Texts' : 'Phone call')) + (!text && dur ? ' · ' + Math.floor(dur / 60) + 'm ' + String(dur % 60).padStart(2, '0') + 's' : ''),
      desc: parts.filter(Boolean).join(' — '),
      type: 'communication',
    };
  }

  // A voice memo is the rep's own spoken note: Notes filter, mic icon. The
  // transcript is speech-to-text, so it is untrusted text like the rest.
  function fromVoiceMemo(a) {
    const dur = Math.round(Number(a.durationSec) || 0);
    return {
      time: toDate(a.createdAt) || new Date(0),
      kind: 'memo',
      icon: '🎙',
      title: (str(a.label, 120) || 'Voice memo') + (dur ? ' · ' + Math.floor(dur / 60) + 'm ' + String(dur % 60).padStart(2, '0') + 's' : ''),
      desc: str(a.transcript, 1500),
      type: 'note',
    };
  }

  const api = { fromActivity };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCallTimeline = api;
})(typeof window !== 'undefined' ? window : null);
