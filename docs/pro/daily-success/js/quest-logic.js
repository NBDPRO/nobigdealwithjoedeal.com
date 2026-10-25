/**
 * quest-logic.js — the pure half of the Quest layout (roadmap: DAILY-SUCCESS-INTERFACES, 2026-10-25).
 *
 * Today's quests are the things the tracker already scores: each daily floor (+10 XP), all floors (+25), a finished workout
 * (+100 plus sets and PRs). The numbers come from xp-logic.js so the board can never disagree with the level. Jo's rule: the
 * streak can break; XP never drops (highWater). No DOM, no storage: quest-ui.js renders, tests drive this.
 *
 * questBoard(o): o = { floors: [{ id, label, met }], workout (bool), sessions, days: [{ date, met, total }], today, xp: NBDXp,
 *   coach: NBDCoach (optional, for PRs), highXp (the best total shown before) }
 * -> { level: { level, into, need, pct, next }, totalXp, streak: { current, best, atRisk, activeToday }, quests: [{ id, kind,
 *      label, xp, done, floorId? }], todayXp, doneCount, allDone, bonus }
 */
(function (root) {
  'use strict';

  function questBoard(o) {
    const opt = o || {};
    const X = opt.xp;
    const floors = Array.isArray(opt.floors) ? opt.floors.filter((f) => f && f.id != null) : [];
    const metCount = floors.filter((f) => f.met).length, total = floors.length;
    const quests = floors.map((f) => ({ id: 'floor:' + f.id, kind: 'floor', floorId: String(f.id), label: String(f.label || f.id), xp: X ? X.FLOOR_XP : 10, done: !!f.met }));
    if (total > 0) quests.push({ id: 'all-floors', kind: 'bonus', label: 'Every floor met', xp: X ? X.ALL_FLOORS_XP : 25, done: metCount === total });
    quests.push({ id: 'workout', kind: 'workout', label: 'Finish a workout', xp: X ? X.WORKOUT_XP : 100, done: !!opt.workout });
    const doneCount = quests.filter((q) => q.done).length;
    let level = { level: 1, into: 0, need: 100, pct: 0, next: 100 }, totalXp = 0, todayXp = 0, streak = { current: 0, best: 0, atRisk: false, activeToday: false };
    if (X) {
      const t = X.xpTotals(opt.sessions || [], { coach: opt.coach, days: opt.days || [] });
      totalXp = X.highWater(opt.highXp, t.total);
      level = X.levelFor(totalXp);
      todayXp = (opt.today && t.byDate[opt.today]) || 0;
      streak = X.streak(X.activeDays(opt.sessions || [], opt.days || []), opt.today);
    }
    return { level, totalXp, streak, quests, todayXp, doneCount, allDone: quests.length > 0 && doneCount === quests.length, bonus: total > 0 && metCount === total };
  }

  /** The day rows xpTotals wants, from the tracker's pages and the current floors list. */
  function daysFrom(pages, floors) {
    const ids = (Array.isArray(floors) ? floors : []).map((f) => String(f.id));
    return (Array.isArray(pages) ? pages : []).filter((p) => p && /^\d{4}-\d{2}-\d{2}$/.test(String(p.dk || ''))).map((p) => {
      const d = p.data || {};
      return { date: p.dk, met: ids.filter((id) => d['floormet-' + id] === '1').length, total: ids.length };
    });
  }

  const api = { questBoard, daysFrom };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDQuest = api;
})(typeof window !== 'undefined' ? window : null);
