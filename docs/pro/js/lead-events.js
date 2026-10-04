/**
 * lead-events.js — the ONE writer for a lead's dated appointments/events.
 *
 * An "event" is a leads/{leadId}/tasks doc with type:'event' (the customer
 * page's Add Event, RoofLink-style): the customer timeline shows it as a 📅
 * milestone, the dashboard task list shows it read-only with its date, and
 * the Schedule view's Today list picks it up (smart-calendar.js). The
 * top-level /appointments collection is Cal.com-webhook-only (rules: write
 * false), so this IS the CRM's appointment writer.
 *
 * Extracted 2026-10-03 (stage-flow lane) from customer-tasks-ui.js saveEvent
 * so the door-knock "Appointment Set" flow (d2d-tracker-core-2026b.js) books
 * its appointment through the same shape instead of a copy.
 *
 * window.NBDLeadEvents + module.exports (tests).
 */
(function (root) {
  'use strict';

  /**
   * The event doc. `when` is a Date, an ISO string, or a datetime-local value
   * ('2026-10-06T14:30', read as LOCAL time). Returns null when it can't be one.
   */
  function build(leadId, ev, ctx) {
    const e = ev || {};
    const c = ctx || {};
    const title = String(e.title || '').trim().slice(0, 140);
    if (!leadId || !title) return null;
    const at = e.when instanceof Date ? e.when : new Date(String(e.when || ''));
    if (!(at instanceof Date) || isNaN(at.getTime())) return null;
    return {
      type: 'event',
      leadId: leadId,
      userId: c.uid || null,
      title: title,
      text: title,
      eventAt: at.toISOString(),
      notes: String(e.notes || '').slice(0, 2000),
      done: false,
      source: e.source || 'manual',
      createdAt: c.serverTimestamp ? c.serverTimestamp() : new Date(),
      createdBy: c.email || 'Unknown',
    };
  }

  /** Write it. Resolves to the new doc id; throws on a bad event or a write failure. */
  async function add(leadId, ev) {
    const w = root || {};
    const db = w.db || w._db;
    if (!(db && w.addDoc && w.collection)) throw new Error('Not connected yet — try again in a moment.');
    const user = (w.auth && w.auth.currentUser) || (w._auth && w._auth.currentUser) || w._user || {};
    const doc = build(leadId, ev, { uid: user.uid || null, email: user.email || 'Unknown', serverTimestamp: w.serverTimestamp });
    if (!doc) throw new Error('An event needs a title and a date/time.');
    const ref = await w.addDoc(w.collection(db, 'leads', leadId, 'tasks'), doc);
    return ref && ref.id;
  }

  const api = { build, add };
  if (root) root.NBDLeadEvents = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
