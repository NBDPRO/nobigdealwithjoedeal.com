/**
 * arcade-logic.js — the pure half of the Arcade layout (roadmap: DAILY-SUCCESS-INTERFACES, 2026-10-25).
 *
 * The same data as Quest (xp-logic.js), louder: SCORE is total XP, 1UP is the level, COMBO is the streak, TODAY is today's
 * XP, and HI-SCORES are personal records: the best estimated one-rep max per lift from finished sessions (Epley: weight x
 * (1 + reps/30), reps capped at 12), top three. No DOM, no storage: arcade-ui.js renders.
 */
(function (root) {
  'use strict';
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const e1rm = (w, r) => { const reps = Math.min(12, Math.max(0, Math.round(num(r)))); return reps > 0 && num(w) > 0 ? num(w) * (1 + reps / 30) : 0; };

  /** -> [{ exId, name, weight, reps, e1rm, date }] best per lift, highest first, at most `n`. */
  function hiScores(sessions, n, library) {
    const best = Object.create(null), libName = Object.create(null);
    for (const lib of Array.isArray(library) ? library : []) if (lib && lib.id && lib.name) libName[lib.id] = String(lib.name);
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!s || s.deleted || !s.finishedAt) continue;
      for (const ex of s.exercises || []) {
        if (!ex || !ex.exId) continue;
        for (const st of ex.sets || []) {
          if (!st || st.warm || st.done === false) continue;
          const v = e1rm(st.weight, st.reps);
          if (v <= 0) continue;
          const cur = best[ex.exId];
          if (!cur || v > cur.e1rm) best[ex.exId] = { exId: ex.exId, name: libName[ex.exId] || String(ex.name || ex.exId), weight: num(st.weight), reps: Math.round(num(st.reps)), e1rm: Math.round(v), date: s.date };
        }
      }
    }
    return Object.keys(best).map((k) => best[k]).sort((a, b) => b.e1rm - a.e1rm).slice(0, Math.max(1, Math.floor(num(n)) || 3));
  }

  /** o = Quest's questBoard input plus { quest: NBDQuest }. -> { score, level, combo, bestCombo, todayXp, pct, quests, hi, cleared } */
  function arcade(o) {
    const opt = o || {};
    const Q = opt.quest;
    const b = Q ? Q.questBoard(opt) : { totalXp: 0, level: { level: 1, pct: 0, into: 0, need: 100 }, streak: { current: 0, best: 0 }, quests: [], todayXp: 0, allDone: false };
    return { score: b.totalXp, level: b.level.level, pct: b.level.pct, into: b.level.into, need: b.level.need, combo: b.streak.current, bestCombo: b.streak.best, todayXp: b.todayXp, quests: b.quests, hi: hiScores(opt.sessions, 3, opt.coach && opt.coach.EXERCISES), cleared: b.allDone };
  }

  const api = { e1rm, hiScores, arcade };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDArcade = api;
})(typeof window !== 'undefined' ? window : null);
