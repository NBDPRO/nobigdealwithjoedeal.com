/**
 * onething-logic.js — the pure half of the One Thing layout (roadmap: DAILY-SUCCESS-INTERFACES, 2026-10-25).
 *
 * "One big card: do this next, nothing else." For days when everything feels like too much. The card picks the single next
 * thing from what the tracker already knows, in this order: the morning check-in (today, still asking), the first floor not
 * yet met, the workout, the evening wrap-up (today, after the prompt hour), then "that's everything". A thing the user skips
 * for now moves to the back of the line for this visit only. No DOM, no storage: onething-ui.js renders.
 *
 * nextThing(o): o = { isToday, checkin ('ask'|'partial'|'done'|'skipped'|'hidden'), floors: [{ id, label, met }], workout (bool),
 *   eod ('prompt'|'link'|'saved'|'skipped'), skipped: [ids skipped this visit] }
 * -> { thing: { id, kind, title, sub, button, floorId? } | done card, left (things still open today), queue (every open id in order) }
 */
(function (root) {
  'use strict';

  function candidates(o) {
    const opt = o || {};
    const floors = Array.isArray(opt.floors) ? opt.floors.filter((f) => f && f.id != null) : [];
    const open = floors.filter((f) => !f.met), total = floors.length;
    const list = [];
    if (opt.isToday && (opt.checkin === 'ask' || opt.checkin === 'partial')) list.push({ id: 'checkin', kind: 'checkin', title: 'Morning check-in', sub: 'Ten seconds: sleep, soreness, energy. The coach sizes today to it.', button: 'Check in' });
    open.forEach((f, i) => list.push({ id: 'floor:' + f.id, kind: 'floor', floorId: String(f.id), title: String(f.label || f.id), sub: 'Floor ' + (total - open.length + i + 1) + ' of ' + total + (open.length > 1 ? ' · ' + (open.length - 1) + ' more after this' : ' · the last one'), button: 'Done' }));
    if (!opt.workout) list.push({ id: 'workout', kind: 'workout', title: 'Train', sub: 'Open the coach. It already knows what today should be.', button: 'Start the workout' });
    if (opt.isToday && opt.eod === 'prompt') list.push({ id: 'eod', kind: 'eod', title: 'Wrap up the day', sub: 'Sixty seconds: how the body felt, one win, tomorrow\'s non-negotiable.', button: 'Wrap up' });
    return list;
  }

  function nextThing(o) {
    const opt = o || {};
    const all = candidates(opt);
    const skipped = Array.isArray(opt.skipped) ? opt.skipped.map(String) : [];
    const ordered = all.filter((t) => skipped.indexOf(t.id) < 0).concat(all.filter((t) => skipped.indexOf(t.id) >= 0));
    const thing = ordered[0] || { id: 'done', kind: 'done', title: 'That\'s everything for today.', sub: 'Every floor met, the workout is in. Rest is part of the plan.', button: '' };
    return { thing, left: all.length, queue: ordered.map((t) => t.id) };
  }

  const api = { candidates, nextThing };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOneThing = api;
})(typeof window !== 'undefined' ? window : null);
