/**
 * tracker-history-logic.js — tracker revamp Phase 3 + 4 (documentation/
 * projects/DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md), the pure half.
 *
 *   Weight (Jo, 2026-09-29: "not much, I use Hume for scale weight"): the
 *   day pages already carry a weight box (data['bm-wt']). A scale reading
 *   bounces a pound or two day to day, so the number that means something is
 *   the 7-day average and how it moved — weightTrend().
 *
 *   Old workouts (Jo left it to us; decision: migrate): every day page's
 *   free-typed Exercise Log rows become Workout Coach sessions, so the
 *   coach's "last time" targets, PRs and variety start from real history.
 *   planImport() is a dry run by design — the screen shows what it found
 *   before anything is written.
 *
 * window.NBDTrackerHistory + module.exports (tests).
 */
(function (root) {
  'use strict';

  // ── weight ─────────────────────────────────────────────────────────────
  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return isFinite(n) ? n : NaN; };
  const dkMs = (dk) => { const [y, m, d] = String(dk).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };
  const DAY = 86400000;

  /** [{dk, lbs}] one per day (the last page of a day wins), sane scale range only. */
  function weightSeries(pages) {
    const byDay = new Map();
    for (const p of pages || []) {
      if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.dk || '')) continue;
      const lbs = num(p.data && p.data['bm-wt']);
      if (!(lbs >= 60 && lbs <= 700)) continue;         // a typo is not a weigh-in
      byDay.set(p.dk, Math.round(lbs * 10) / 10);
    }
    return [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([dk, lbs]) => ({ dk, lbs }));
  }

  function avgBetween(series, fromMs, toMs) {
    const pts = series.filter((s) => { const t = dkMs(s.dk); return t > fromMs && t <= toMs; });
    if (!pts.length) return null;
    return Math.round(pts.reduce((a, s) => a + s.lbs, 0) / pts.length * 10) / 10;
  }

  /**
   * { latest, latestDk, avg7, change7, change30, points:[{dk,lbs,avg7}], count }
   * change7 = this week's average − last week's; change30 = this week's
   * average − the week ending 30 days ago. null where there is not enough.
   */
  function weightTrend(series, todayDk) {
    const s = series || [];
    if (!s.length) return { latest: null, latestDk: null, avg7: null, change7: null, change30: null, points: [], count: 0 };
    const today = dkMs(todayDk);
    const avg7 = avgBetween(s, today - 7 * DAY, today);
    const prev7 = avgBetween(s, today - 14 * DAY, today - 7 * DAY);
    const back30 = avgBetween(s, today - 37 * DAY, today - 30 * DAY);
    const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
    const points = s.filter((p) => dkMs(p.dk) > today - 90 * DAY && dkMs(p.dk) <= today).map((p) => ({
      dk: p.dk, lbs: p.lbs, avg7: avgBetween(s, dkMs(p.dk) - 7 * DAY, dkMs(p.dk)),
    }));
    const last = s[s.length - 1];
    return {
      latest: last.lbs, latestDk: last.dk, avg7,
      change7: avg7 != null && prev7 != null ? round1(avg7 - prev7) : null,
      change30: avg7 != null && back30 != null ? round1(avg7 - back30) : null,
      points, count: s.length,
    };
  }

  /** A tiny inline SVG polyline of the 7-day average (no library). */
  function sparkline(points, w, h) {
    const W = w || 160, H = h || 36;
    const vals = (points || []).map((p) => p.avg7 != null ? p.avg7 : p.lbs).filter((v) => isFinite(v));
    if (vals.length < 2) return '';
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    const span = hi - lo || 1;
    const pts = vals.map((v, i) => (i / (vals.length - 1) * (W - 4) + 2).toFixed(1) + ',' + (H - 2 - (v - lo) / span * (H - 4)).toFixed(1)).join(' ');
    return '<svg class="wt-spark" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="2" points="' + pts + '"/></svg>';
  }

  // ── old Exercise Log rows → coach sessions ─────────────────────────────
  const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const singular = (w) => (w.length > 3 && /s$/.test(w) && !/ss$/.test(w) ? w.slice(0, -1) : w);
  const words = (s) => norm(s).split(' ').filter(Boolean).map(singular);

  // What people actually type in a gym log → the coach's library id.
  const ALIASES = {
    'bench': 'bb_bench', 'bench press': 'bb_bench', 'bb bench': 'bb_bench', 'flat bench': 'bb_bench', 'barbell bench': 'bb_bench',
    'db bench': 'db_bench', 'dumbbell bench': 'db_bench', 'incline': 'incline_bb', 'incline bench': 'incline_bb', 'incline db': 'incline_db',
    'incline dumbbell': 'incline_db', 'ohp': 'ohp', 'overhead press': 'ohp', 'military press': 'ohp', 'shoulder press': 'db_shoulder',
    'squat': 'back_squat', 'back squat': 'back_squat', 'front squat': 'front_squat', 'leg press': 'leg_press', 'hack squat': 'hack_squat',
    'deadlift': 'deadlift', 'dl': 'deadlift', 'rdl': 'rdl', 'romanian deadlift': 'rdl', 'trap bar': 'trap_bar', 'hip thrust': 'hip_thrust',
    'pull up': 'pullup', 'pullup': 'pullup', 'chin up': 'chinup', 'chinup': 'chinup', 'lat pulldown': 'lat_pulldown', 'pulldown': 'lat_pulldown',
    'barbell row': 'bb_row', 'bb row': 'bb_row', 'bent over row': 'bb_row', 'row': 'bb_row', 'db row': 'db_row', 'dumbbell row': 'db_row',
    'cable row': 'cable_row', 'seated row': 'cable_row', 't bar row': 'tbar', 'curl': 'bb_curl', 'bicep curl': 'bb_curl', 'barbell curl': 'bb_curl',
    'hammer curl': 'hammer', 'tricep pushdown': 'pushdown', 'pushdown': 'pushdown', 'rope pushdown': 'pushdown', 'skull crusher': 'skullcrusher',
    'dip': 'dips', 'lateral raise': 'db_lateral', 'side raise': 'db_lateral', 'face pull': 'face_pull', 'leg extension': 'leg_ext',
    'leg curl': 'leg_curl', 'calf raise': 'calf_standing', 'lunge': 'walking_lunge', 'bulgarian split squat': 'bss', 'split squat': 'bss',
    'push up': 'pushup', 'pushup': 'pushup', 'fly': 'cable_fly', 'cable fly': 'cable_fly', 'pec deck': 'pec_deck',
  };

  /**
   * Free text → { exId, how } or { exId: null }. Order: alias → exact library
   * name → the library name sharing the most words (≥ 2 words, or all of a
   * one-word name). Never guesses between two equally good matches.
   */
  function matchExercise(name, library) {
    const n = norm(name);
    if (!n) return { exId: null, how: 'empty' };
    const nw = words(name).join(' ');
    if (ALIASES[n]) return { exId: ALIASES[n], how: 'alias' };
    if (ALIASES[nw]) return { exId: ALIASES[nw], how: 'alias' };
    const lib = library || [];
    const exact = lib.find((e) => norm(e.name) === n);
    if (exact) return { exId: exact.id, how: 'name' };
    const mine = new Set(words(name));
    let best = null, bestScore = 0, tie = false;
    for (const e of lib) {
      const theirs = words(e.name.replace(/\(.*?\)/g, ''));
      const shared = theirs.filter((w) => mine.has(w)).length;
      const need = Math.min(2, theirs.length);
      if (shared < need) continue;
      const score = shared / theirs.length;
      if (score > bestScore) { best = e; bestScore = score; tie = false; }
      else if (score === bestScore) tie = true;
    }
    if (best && !tie && bestScore >= 0.5) return { exId: best.id, how: 'words' };
    return { exId: null, how: tie ? 'ambiguous' : 'none' };
  }

  /** "10", "8-10", "10/8/6", "3x10" → per-set reps (length = setCount when given). */
  function parseReps(reps, setCount) {
    const s = String(reps || '').toLowerCase().trim();
    const n = Math.max(0, parseInt(setCount, 10) || 0);
    const x = /^(\d+)\s*x\s*(\d+)$/.exec(s);
    if (x) return Array.from({ length: +x[1] }, () => +x[2]);
    if (/[/,]/.test(s)) return s.split(/[/,]/).map((v) => parseInt(v, 10)).filter((v) => v > 0);
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(s);
    const one = range ? Math.round((+range[1] + +range[2]) / 2) : parseInt(s, 10);
    if (!(one > 0)) return [];
    return Array.from({ length: n || 1 }, () => one);
  }

  /**
   * The dry run. Returns { sessions, days, lifts, matched, unmatched:[{name,count}], skipped }.
   * A page already imported (its session id exists) is skipped, so running it
   * twice imports nothing new. Rows without a name are ignored; a row whose
   * name matches nothing is still imported under its own name (exId null) so
   * the history is not lost — it just does not drive targets.
   */
  function planImport(pages, existingSessions, library, nowMs) {
    const have = new Set((existingSessions || []).map((s) => String(s && s.id)));
    const sessions = [];
    const unmatched = new Map();
    let lifts = 0, matched = 0, skipped = 0;
    for (const p of pages || []) {
      if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(p.dk || '')) continue;
      const rows = (p.exercises || []).filter((r) => r && String(r.name || '').trim());
      if (!rows.length) continue;
      const id = 'imp_' + String(p.id).replace(/[^A-Za-z0-9]/g, '');
      if (have.has(id)) { skipped++; continue; }
      const at = dkMs(p.dk) + 12 * 3600000;
      const exercises = rows.map((r, i) => {
        const m = matchExercise(r.name, library);
        lifts++;
        if (m.exId) matched++;
        else { const k = String(r.name).trim(); unmatched.set(k, (unmatched.get(k) || 0) + 1); }
        const weight = num(r.weight);
        const reps = parseReps(r.reps, r.sets);
        const sets = (reps.length ? reps : [0]).map((rp) => ({ reps: rp, weight: isFinite(weight) ? weight : '', rpe: '', done: rp > 0 }));
        const lib = m.exId && (library || []).find((e) => e.id === m.exId);
        return { exId: m.exId, name: lib ? lib.name : String(r.name).trim(), slot: -1, repRange: [0, 0], sets: sets.filter((st) => st.done), note: r.notes || '' };
      }).filter((x) => x.sets.length);
      if (!exercises.length) continue;
      sessions.push({ id, date: p.dk, split: 'imported', label: 'Imported', imported: true, startedAt: at, finishedAt: at, mt: nowMs || Date.now(), exercises });
    }
    return {
      sessions, days: sessions.length, lifts, matched, skipped,
      unmatched: [...unmatched.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    };
  }

  const api = { weightSeries, weightTrend, sparkline, matchExercise, parseReps, planImport, ALIASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDTrackerHistory = api;
})(typeof window !== 'undefined' ? window : null);
