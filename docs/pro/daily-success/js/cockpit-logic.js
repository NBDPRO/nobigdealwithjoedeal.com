/**
 * cockpit-logic.js — the numbers for the Cockpit layout's tile row (roadmap: DAILY-SUCCESS-INTERFACES): the training week at a glance.
 *
 * Pure: no DOM, no storage. It only combines two logic modules that already exist (workout-coach-logic.js for the week's sessions,
 * sets and what is behind, xp-logic.js for streak and level), passed in so tests can drive the real ones.
 *
 * Streak here is a TRAINING streak (finished workouts only): the coach screen does not see the day page's floors. Level counts workout
 * XP only for the same reason; the floors XP joins in when the Quest screen (which can read the pages) is built.
 */
(function (root) {
  'use strict';

  const sign = (n) => (n > 0 ? '+' + n : String(n));

  /**
   * -> { tiles: [{ id, label, value, sub }], behind: [muscle ids that are zero or low this week], enough }
   * o = { coach: NBDCoach, xp: NBDXp, equip, avoid }
   */
  function cockpit(sessions, todayYmd, o) {
    const opt = o || {};
    const C = opt.coach, X = opt.xp;
    if (!C || !X) return { tiles: [], behind: [], enough: false };
    const bal = C.balance(sessions, todayYmd, { equip: opt.equip, avoid: opt.avoid });
    const vol = C.volumeMap(sessions, todayYmd, { equip: opt.equip, avoid: opt.avoid });
    const st = X.streak(X.activeDays(sessions, []), todayYmd);
    const totals = X.xpTotals(sessions, { coach: C });
    const lv = X.levelFor(totals.total);
    const delta = bal.total - vol.prevTotal;
    const tiles = [
      { id: 'sessions', label: 'Workouts', value: String(bal.sessions), sub: 'last 7 days' },
      { id: 'sets', label: 'Hard sets', value: String(bal.total), sub: vol.prevTotal || bal.total ? sign(delta) + ' vs last week' : 'last 7 days' },
      { id: 'streak', label: 'Training streak', value: String(st.current), sub: st.best > st.current ? 'best ' + st.best : (st.atRisk ? 'train soon' : st.current ? 'on a roll' : 'start one today') },
      { id: 'level', label: 'Level', value: 'Lv ' + lv.level, sub: lv.into + ' / ' + lv.need + ' XP' },
    ];
    return { tiles, behind: bal.neglected || [], enough: bal.enough };
  }

  const api = { cockpit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCockpit = api;
})(typeof window !== 'undefined' ? window : null);
