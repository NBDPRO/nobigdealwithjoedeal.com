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

  // ── Next-Up (audit M1, 2026-11-09): the same engine, aware of the time of day and of more things ─────────────────────────────
  // dayPhase(hour): morning before 11, field from 11, evening from 17 (the hour the wrap-up prompt starts, eod-logic.js PROMPT_HOUR).
  function dayPhase(hour) {
    const h = Number(hour);
    if (hour == null || !isFinite(h) || h < 0 || h > 24) return 'field';
    return h < 11 ? 'morning' : h < 17 ? 'field' : 'evening';
  }
  const WORKOUT_FLOOR = /work\s*-?out|train|lift|gym|exercise/i;
  // what each part of the day puts first (lower = earlier); the same kind keeps its candidate order
  const RANK = {
    morning: { checkin: 0, carry: 1, weigh: 2, floor: 3, workout: 4, food: 5, review: 6, eod: 7 },
    field: { checkin: 0, floor: 1, workout: 2, food: 3, review: 4, weigh: 5, eod: 6, carry: 7 },
    evening: { eod: 0, review: 1, food: 2, floor: 3, workout: 4, checkin: 5, weigh: 6, carry: 7 },
  };

  /**
   * nextUp(o): o is nextThing's input plus
   *   hour, protein { have, target } (grams; offered only while under a real target), weighed (false = not weighed yet; offered mornings only),
   *   carry (last night's non-negotiable text, offered before 11), reviewDue (the Sunday review).
   * A floor that is a workout ("Workout complete") swallows the separate "workout" candidate, so the same task is not listed twice.
   * Nothing today-only (check-in, wrap-up, last night's line) is offered on a past day.
   * -> { thing, left, queue, phase }
   */
  function nextUp(o) {
    const opt = o || {};
    const phase = dayPhase(opt.hour);
    const floors = Array.isArray(opt.floors) ? opt.floors.filter((f) => f && f.id != null) : [];
    let list = candidates(opt);
    if (floors.some((f) => WORKOUT_FLOOR.test(String(f.label || '')))) list = list.filter((t) => t.kind !== 'workout');
    const pr = opt.protein;
    if (pr && Number(pr.target) > 0 && Number(pr.have) < Number(pr.target)) {
      const left = Math.round(Number(pr.target) - Number(pr.have));
      list.push({ id: 'food', kind: 'food', title: 'Protein: ' + Math.round(Number(pr.have) || 0) + ' of ' + Math.round(Number(pr.target)) + ' g', sub: left + ' g to go. Log what you ate.', button: 'Log food' });
    }
    if (opt.isToday && opt.weighed === false && phase === 'morning') list.push({ id: 'weigh', kind: 'weigh', title: 'Weigh in', sub: 'Before food, after the bathroom.', button: 'Log weight' });
    if (opt.isToday && opt.carry && phase === 'morning') list.push({ id: 'carry', kind: 'carry', title: 'From last night: ' + String(opt.carry), sub: 'The non-negotiable you set before bed.', button: 'Use it' });
    if (opt.reviewDue) list.push({ id: 'review', kind: 'review', title: 'Sunday review', sub: 'Five minutes: the week, one change for next.', button: 'Open the review' });
    const rank = RANK[phase];
    const rk = (t) => (rank[t.kind] != null ? rank[t.kind] : 9);
    list = list.map((t, i) => ({ t, i })).sort((a, b) => (rk(a.t) - rk(b.t)) || a.i - b.i).map((x) => x.t);
    const skipped = Array.isArray(opt.skipped) ? opt.skipped.map(String) : [];
    const ordered = list.filter((t) => skipped.indexOf(t.id) < 0).concat(list.filter((t) => skipped.indexOf(t.id) >= 0));
    const thing = ordered[0] || { id: 'done', kind: 'done', title: 'That\'s everything for now.', sub: 'Every floor met, the workout is in. Rest is part of the plan.', button: '' };
    return { thing, left: list.length, queue: ordered.map((t) => t.id), items: ordered, phase };
  }

  const api = { candidates, nextThing, dayPhase, nextUp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDOneThing = api;
})(typeof window !== 'undefined' ? window : null);
