/**
 * yard-signs-logic.js — pure rules for the yard-sign tracker (no DOM, no
 * Firestore). Used by yard-signs.js (the view) and pinned by
 * tests/yard-signs-2026-09-29.test.js.
 *
 * Jo (2026-09-29): track every yard sign — where it is, a photo, when it
 * went out, and a reminder to go get it when the agreed time is up ("I
 * normally agree to one or two weeks with homeowners"). Homeowners text
 * him if he DOESN'T show up on time, so the reminders to Jo carry it.
 *
 * A sign doc (yardSigns/{id}):
 *   { userId, companyId, leadId, address, lat, lng, photoPath,
 *     placedAt, dueAt, durationDays, status: 'out'|'picked_up'|'missing',
 *     pickedUpAt, pickupPhotoPath, extensions, note, createdAt, updatedAt,
 *     deleted, deletedAt }
 *
 * 'scheduled' (2026-09-30) is DERIVED, never stored: a sign logged ahead of
 * time keeps status 'out' with a future placedAt. That way the Firestore
 * rules and the server's daily pickup push (status == 'out', keyed on dueAt)
 * need no change, and the sign turns into an ordinary 'out' sign on the
 * morning it goes in the yard. A removed sign is soft-deleted
 * (deleted: true); every reader skips it.
 */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const DURATIONS = [7, 14];            // the two Jo agrees to
  const DUE_SOON_DAYS = 2;              // amber window

  function ms(t) {
    if (t == null) return 0;
    if (typeof t === 'number') return t;
    if (t instanceof Date) return t.getTime();
    if (typeof t.toMillis === 'function') return t.toMillis();
    if (typeof t.seconds === 'number') return t.seconds * 1000;
    const p = Date.parse(t);
    return isNaN(p) ? 0 : p;
  }

  // Does this object carry a real map pin? isFinite(null) is TRUE in JS (null
  // coerces to 0), so a sign saved with lat/lng null used to pass as a pin at
  // 0,0 — and Leaflet THROWS on [null, null], which stopped the whole map from
  // drawing any pin at all (2026-09-30, Jo: "no yard sign markers").
  function hasPin(o) {
    return !!o && typeof o.lat === 'number' && typeof o.lng === 'number' && Number.isFinite(o.lat) && Number.isFinite(o.lng);
  }

  // Local-midnight of a day (pickup is a DAY, not a minute).
  function startOfDay(t) { const d = new Date(ms(t)); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

  // Due = placed day + N days (end of that day counts as on time).
  function dueFrom(placedAt, days) {
    const n = Math.max(1, Math.min(365, parseInt(days, 10) || 14));
    return startOfDay(placedAt) + n * DAY;
  }

  // 'picked_up' | 'missing' | 'scheduled' | 'overdue' | 'due_today' | 'due_soon' | 'out'
  function statusOf(sign, now) {
    if (!sign) return 'out';
    if (sign.status === 'picked_up' || sign.status === 'missing') return sign.status;
    const today = startOfDay(now == null ? Date.now() : now);
    const placed = ms(sign.placedAt) ? startOfDay(sign.placedAt) : 0;
    if (placed && placed > today) return 'scheduled';
    const due = startOfDay(sign.dueAt);
    if (!due) return 'out';
    if (due < today) return 'overdue';
    if (due === today) return 'due_today';
    if (due - today <= DUE_SOON_DAYS * DAY) return 'due_soon';
    return 'out';
  }

  const COLOR = { overdue: '#dc2626', due_today: '#ea580c', due_soon: '#d97706', out: '#16a34a', scheduled: '#3b82f6', picked_up: '#6b7280', missing: '#6b7280' };
  const LABEL = { overdue: 'Overdue', due_today: 'Due today', due_soon: 'Due soon', out: 'Out', scheduled: 'Scheduled', picked_up: 'Picked up', missing: 'Missing' };

  function daysBetween(a, b) { return Math.round((startOfDay(b) - startOfDay(a)) / DAY); }

  // "Due in 3 days" / "Due today" / "2 days overdue".
  function dueText(sign, now) {
    const s = statusOf(sign, now);
    if (s === 'picked_up') return 'Picked up';
    if (s === 'missing') return 'Marked missing';
    if (s === 'scheduled') {
      const g = daysBetween(now == null ? Date.now() : now, sign.placedAt);
      return 'Goes out ' + (g === 1 ? 'tomorrow' : 'in ' + g + ' days');
    }
    const d = daysBetween(now == null ? Date.now() : now, sign.dueAt);
    if (d === 0) return 'Pickup due today';
    if (d < 0) return (-d) + ' day' + (d === -1 ? '' : 's') + ' overdue';
    return 'Pickup in ' + d + ' day' + (d === 1 ? '' : 's');
  }

  function haversineMi(a, b) {
    if (!hasPin(a) || !hasPin(b)) return Infinity;
    const R = 3958.8, toR = (x) => x * Math.PI / 180;
    const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Today's pickup list: overdue first, then due today, ordered as a
  // nearest-next drive from `start` (Jo's position) when known.
  function pickupList(signs, now, start) {
    const due = (signs || []).filter((s) => { if (!s || s.deleted) return false; const st = statusOf(s, now); return st === 'overdue' || st === 'due_today'; });
    if (!hasPin(start)) return due.sort((a, b) => ms(a.dueAt) - ms(b.dueAt));
    const out = [], left = due.slice();
    let here = start;
    while (left.length) {
      let bi = 0, bd = Infinity;
      left.forEach((s, i) => { const d = haversineMi(here, s); if (d < bd) { bd = d; bi = i; } });
      const next = left.splice(bi, 1)[0];
      out.push(next);
      if (hasPin(next)) here = next;
    }
    return out;
  }

  // Extend by N days from the LATER of today or the current due date.
  function extendedDue(sign, days, now) {
    const base = Math.max(startOfDay(sign && sign.dueAt), startOfDay(now == null ? Date.now() : now));
    return base + Math.max(1, parseInt(days, 10) || 7) * DAY;
  }

  // Credit a yard-sign-sourced lead to the nearest sign that was OUT on the
  // day the lead arrived, within `maxMi` (a sign pulls in neighbours). All
  // signs share one QR code, so distance + timing is the attribution.
  function attributeLead(lead, signs, maxMi) {
    const limit = maxMi == null ? 1.5 : maxMi;
    const at = ms(lead && lead.createdAt);
    const here = hasPin(lead) ? { lat: lead.lat, lng: lead.lng } : null;
    if (!here || !at) return null;
    let best = null, bd = Infinity;
    (signs || []).forEach((s) => {
      if (!s || s.deleted) return;
      const placed = ms(s.placedAt);
      const ended = s.status === 'picked_up' ? ms(s.pickedUpAt) : Infinity;
      if (!placed || at < placed || at > ended + 3 * DAY) return; // a scan can lag the pickup a little
      const d = haversineMi(here, s);
      if (d <= limit && d < bd) { bd = d; best = s; }
    });
    return best ? { signId: best.id, miles: Math.round(bd * 100) / 100 } : null;
  }

  function isYardSignSource(lead) {
    const v = [lead && lead.source, lead && lead.utmSource, lead && lead.utm_source, lead && lead.utmMedium].join(' ').toLowerCase();
    return /yard[\s_-]?sign/.test(v);
  }

  function summary(signs, now) {
    const c = { out: 0, dueSoon: 0, dueToday: 0, overdue: 0, pickedUp: 0, missing: 0, scheduled: 0 };
    (signs || []).forEach((s) => {
      if (!s || s.deleted) return;
      const st = statusOf(s, now);
      if (st === 'picked_up') c.pickedUp++;
      else if (st === 'missing') c.missing++;
      else if (st === 'scheduled') c.scheduled++;
      else {
        c.out++;
        if (st === 'overdue') c.overdue++;
        else if (st === 'due_today') c.dueToday++;
        else if (st === 'due_soon') c.dueSoon++;
      }
    });
    return c;
  }

  const api = { DAY, DURATIONS, DUE_SOON_DAYS, COLOR, LABEL, hasPin, ms, startOfDay, dueFrom, statusOf, dueText, daysBetween, haversineMi, pickupList, extendedDue, attributeLead, isYardSignSource, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDYardSignLogic = api;
})(typeof window !== 'undefined' ? window : null);
