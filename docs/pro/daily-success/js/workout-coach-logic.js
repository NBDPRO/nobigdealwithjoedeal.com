/**
 * workout-coach-logic.js — the pure brain of the Workout Coach (Daily
 * Success, tracker revamp Phase 1: documentation/projects/
 * DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md).
 *
 * Jo (2026-09-29): "i normally do the same a lot but thats why im here to
 * you… help me keep up diversity as well as tracking reps / weight /
 * intensity etc to keep it fresh and switch it up for me easily when i dont
 * follow a plan i get very repetitious."
 *
 * So the coach does three things, all here and all testable without a DOM:
 *   1. VARIETY — a day is a list of movement-pattern SLOTS (horizontal push,
 *      hinge, …), not fixed exercises. Each slot is filled with the exercise
 *      of that pattern Jo has done LEAST recently. The first compound slot of
 *      a day ("anchor") is held for a few sessions so it can actually
 *      progress, then rotates too. "Switch it up" re-rolls with a new seed.
 *   2. TRACKING — sessions hold per-set reps / weight / RPE (intensity).
 *   3. PROGRESSION — each exercise gets a target from its last session:
 *      double progression (earn the top of the rep range at a sane RPE →
 *      add weight; miss the bottom or grind → hold).
 *
 * Session shape (stored per user in users/{uid}/ds_workouts/{id}):
 *   { id, date:'YYYY-MM-DD', split, startedAt, finishedAt, mt,
 *     exercises:[{ exId, name, slot, repRange:[lo,hi],
 *                  sets:[{ reps, weight, rpe, done }] }], notes }
 *
 * Exposed as window.NBDCoach and module.exports (tests).
 */
(function (root) {
  'use strict';

  // ── library ───────────────────────────────────────────────────────────
  // pattern: the slot it can fill. equip: what it needs. c: compound.
  // inc: default weight jump in lb when a target is earned.
  const X = (id, name, pattern, equip, c, inc) => ({ id, name, pattern, equip, compound: !!c, inc: inc || (c ? 5 : 2.5) });
  const EXERCISES = [
    // horizontal push
    X('bb_bench', 'Barbell Bench Press', 'h_push', 'barbell', 1, 5),
    X('db_bench', 'Dumbbell Bench Press', 'h_push', 'dumbbell', 1, 5),
    X('machine_chest', 'Machine Chest Press', 'h_push', 'machine', 1, 10),
    X('dips', 'Weighted Dips', 'h_push', 'bodyweight', 1, 5),
    X('pushup', 'Deficit Push-Ups', 'h_push', 'bodyweight', 1, 0),
    // incline push
    X('incline_bb', 'Incline Barbell Press', 'incline_push', 'barbell', 1, 5),
    X('incline_db', 'Incline Dumbbell Press', 'incline_push', 'dumbbell', 1, 5),
    X('incline_machine', 'Incline Machine Press', 'incline_push', 'machine', 1, 10),
    X('landmine_press', 'Landmine Press', 'incline_push', 'barbell', 1, 5),
    // vertical push
    X('ohp', 'Overhead Press', 'v_push', 'barbell', 1, 5),
    X('db_shoulder', 'Seated Dumbbell Shoulder Press', 'v_push', 'dumbbell', 1, 5),
    X('arnold', 'Arnold Press', 'v_push', 'dumbbell', 1, 5),
    X('machine_shoulder', 'Machine Shoulder Press', 'v_push', 'machine', 1, 10),
    // chest isolation
    X('cable_fly', 'Cable Fly', 'chest_iso', 'cable', 0, 5),
    X('pec_deck', 'Pec Deck', 'chest_iso', 'machine', 0, 10),
    X('db_fly', 'Dumbbell Fly', 'chest_iso', 'dumbbell', 0, 5),
    // lateral / rear delts
    X('db_lateral', 'Dumbbell Lateral Raise', 'lateral', 'dumbbell', 0, 5),
    X('cable_lateral', 'Cable Lateral Raise', 'lateral', 'cable', 0, 2.5),
    X('machine_lateral', 'Machine Lateral Raise', 'lateral', 'machine', 0, 10),
    X('face_pull', 'Face Pull', 'rear_delt', 'cable', 0, 5),
    X('reverse_fly', 'Reverse Pec Deck', 'rear_delt', 'machine', 0, 10),
    X('db_rear_fly', 'Bent-Over Dumbbell Reverse Fly', 'rear_delt', 'dumbbell', 0, 5),
    // triceps
    X('pushdown', 'Rope Pushdown', 'triceps', 'cable', 0, 5),
    X('skullcrusher', 'EZ-Bar Skullcrusher', 'triceps', 'barbell', 0, 5),
    X('oh_ext', 'Overhead Cable Extension', 'triceps', 'cable', 0, 5),
    X('cgbp', 'Close-Grip Bench Press', 'triceps', 'barbell', 1, 5),
    // vertical pull
    X('pullup', 'Pull-Ups (weighted if easy)', 'v_pull', 'bodyweight', 1, 5),
    X('chinup', 'Chin-Ups', 'v_pull', 'bodyweight', 1, 5),
    X('lat_pulldown', 'Lat Pulldown', 'v_pull', 'cable', 1, 10),
    X('ng_pulldown', 'Neutral-Grip Pulldown', 'v_pull', 'cable', 1, 10),
    // horizontal pull
    X('bb_row', 'Barbell Row', 'h_pull', 'barbell', 1, 5),
    X('db_row', 'One-Arm Dumbbell Row', 'h_pull', 'dumbbell', 1, 5),
    X('cable_row', 'Seated Cable Row', 'h_pull', 'cable', 1, 10),
    X('chest_supported', 'Chest-Supported Row', 'h_pull', 'machine', 1, 10),
    X('tbar', 'T-Bar Row', 'h_pull', 'barbell', 1, 10),
    // biceps
    X('bb_curl', 'Barbell Curl', 'biceps', 'barbell', 0, 5),
    X('db_curl', 'Incline Dumbbell Curl', 'biceps', 'dumbbell', 0, 5),
    X('hammer', 'Hammer Curl', 'biceps', 'dumbbell', 0, 5),
    X('cable_curl', 'Cable Curl', 'biceps', 'cable', 0, 5),
    X('preacher', 'Preacher Curl', 'biceps', 'machine', 0, 5),
    // squat
    X('back_squat', 'Back Squat', 'squat', 'barbell', 1, 10),
    X('front_squat', 'Front Squat', 'squat', 'barbell', 1, 5),
    X('hack_squat', 'Hack Squat', 'squat', 'machine', 1, 10),
    X('leg_press', 'Leg Press', 'squat', 'machine', 1, 20),
    X('goblet', 'Goblet Squat', 'squat', 'dumbbell', 1, 5),
    // hinge
    X('deadlift', 'Deadlift', 'hinge', 'barbell', 1, 10),
    X('rdl', 'Romanian Deadlift', 'hinge', 'barbell', 1, 10),
    X('db_rdl', 'Dumbbell RDL', 'hinge', 'dumbbell', 1, 5),
    X('hip_thrust', 'Hip Thrust', 'hinge', 'barbell', 1, 10),
    X('trap_bar', 'Trap-Bar Deadlift', 'hinge', 'barbell', 1, 10),
    // single leg
    X('bss', 'Bulgarian Split Squat', 'lunge', 'dumbbell', 1, 5),
    X('walking_lunge', 'Walking Lunge', 'lunge', 'dumbbell', 1, 5),
    X('step_up', 'Step-Up', 'lunge', 'dumbbell', 1, 5),
    X('reverse_lunge', 'Reverse Lunge', 'lunge', 'barbell', 1, 5),
    // leg isolation
    X('leg_ext', 'Leg Extension', 'quad_iso', 'machine', 0, 10),
    X('sissy', 'Cyclist Squat (heels up)', 'quad_iso', 'dumbbell', 0, 5),
    X('spanish_squat', 'Spanish Squat (band)', 'quad_iso', 'bodyweight', 0, 0),
    X('leg_curl', 'Lying Leg Curl', 'ham_iso', 'machine', 0, 10),
    X('seated_curl', 'Seated Leg Curl', 'ham_iso', 'machine', 0, 10),
    X('nordic', 'Nordic Curl (assisted)', 'ham_iso', 'bodyweight', 0, 0),
    X('calf_standing', 'Standing Calf Raise', 'calves', 'machine', 0, 10),
    X('calf_seated', 'Seated Calf Raise', 'calves', 'machine', 0, 10),
    X('calf_press', 'Leg-Press Calf Raise', 'calves', 'machine', 0, 20),
    // core
    X('hanging_raise', 'Hanging Leg Raise', 'core', 'bodyweight', 0, 0),
    X('cable_crunch', 'Cable Crunch', 'core', 'cable', 0, 5),
    X('ab_wheel', 'Ab Wheel Rollout', 'core', 'bodyweight', 0, 0),
    X('pallof', 'Pallof Press', 'core', 'cable', 0, 5),
    X('farmer', 'Farmer Carry (40 yd)', 'core', 'dumbbell', 0, 10),
  ];
  const BY_ID = Object.create(null);
  EXERCISES.forEach((e) => { BY_ID[e.id] = e; });
  const EQUIP = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight'];

  // ── splits: a day is slots, each slot a pattern (or a choice of patterns) ─
  const S = (pattern, reps, sets, anchor) => ({ pattern, reps, sets: sets || 3, anchor: !!anchor });
  const SPLITS = {
    push:  { label: 'Push',  slots: [S('h_push', [5, 8], 4, true), S('incline_push', [8, 12]), S('v_push', [8, 12]), S('lateral', [12, 20]), S(['triceps'], [10, 15]), S('chest_iso', [12, 15], 2)] },
    pull:  { label: 'Pull',  slots: [S('v_pull', [6, 10], 4, true), S('h_pull', [8, 12]), S('h_pull', [10, 15]), S('rear_delt', [12, 20]), S('biceps', [10, 15]), S('biceps', [10, 15], 2)] },
    legs:  { label: 'Legs',  slots: [S('squat', [5, 8], 4, true), S('hinge', [6, 10]), S('lunge', [8, 12]), S('quad_iso', [10, 15]), S('ham_iso', [10, 15]), S('calves', [10, 20])] },
    upper: { label: 'Upper', slots: [S('h_push', [5, 8], 4, true), S('h_pull', [6, 10], 4), S('v_push', [8, 12]), S('v_pull', [8, 12]), S('biceps', [10, 15]), S('triceps', [10, 15])] },
    lower: { label: 'Lower', slots: [S('squat', [5, 8], 4, true), S('hinge', [6, 10]), S('lunge', [8, 12]), S('ham_iso', [10, 15]), S('calves', [10, 20]), S('core', [10, 15])] },
    full:  { label: 'Full Body', slots: [S(['squat', 'hinge'], [5, 8], 4, true), S('h_push', [6, 10]), S('h_pull', [6, 10]), S(['lunge', 'hinge'], [8, 12]), S('v_push', [8, 12]), S('core', [10, 15])] },
  };
  const ROTATIONS = {
    ppl: ['push', 'pull', 'legs'],
    ul: ['upper', 'lower'],
    full: ['full'],
  };
  // How many sessions of the same day the anchor lift is held before it
  // rotates. Enough to progress it; short enough that Jo never sees the same
  // main lift for a month.
  const FRESHNESS = { steady: 6, mixed: 3, fresh: 1 };

  // ── small helpers ─────────────────────────────────────────────────────
  function rngFrom(seed) {             // mulberry32 — deterministic for tests
    let a = (Number(seed) >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const patternsOf = (slot) => [].concat(slot.pattern);
  const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (num(b.finishedAt) - num(a.finishedAt)));
  const finished = (sessions) => (sessions || []).filter((s) => s && !s.deleted && s.finishedAt).sort(byDateDesc);
  const roundTo = (w, step) => Math.round(w / step) * step;

  /** Epley estimated one-rep max. 0 for nothing lifted. */
  function e1rm(weight, reps) {
    const w = num(weight), r = Math.round(num(reps));
    if (w <= 0 || r <= 0) return 0;
    if (r === 1) return w;
    return Math.round(w * (1 + r / 30) * 10) / 10;
  }

  function workingSets(ex) {
    return ((ex && ex.sets) || []).filter((s) => s && s.done !== false && num(s.reps) > 0);
  }

  /** Every logged appearance of an exercise, newest first. */
  function historyOf(exId, sessions) {
    const out = [];
    for (const s of finished(sessions)) {
      for (const ex of s.exercises || []) {
        if (ex.exId === exId && workingSets(ex).length) out.push({ date: s.date, split: s.split, ex });
      }
    }
    return out;
  }

  function bestE1rm(exId, sessions) {
    let best = 0;
    for (const h of historyOf(exId, sessions)) for (const set of workingSets(h.ex)) best = Math.max(best, e1rm(set.weight, set.reps));
    return best;
  }

  /** Days since the exercise was last done (Infinity if never). */
  function daysSince(exId, sessions, todayYmd) {
    const h = historyOf(exId, sessions)[0];
    if (!h) return Infinity;
    const [y1, m1, d1] = h.date.split('-').map(Number);
    const [y2, m2, d2] = todayYmd.split('-').map(Number);
    return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
  }

  function candidatesFor(slot, opts) {
    const equip = new Set((opts && opts.equip && opts.equip.length) ? opts.equip : EQUIP);
    const pats = patternsOf(slot);
    return EXERCISES.filter((e) => pats.includes(e.pattern) && equip.has(e.equip) && !((opts && opts.exclude) || []).includes(e.id));
  }

  /**
   * Fill one slot. Least-recently-done wins (never-done counts as oldest);
   * ties are broken by the seeded rng so "Switch it up" gives a new answer.
   * An anchor slot keeps the exercise it had last time for this split while
   * it has been used fewer than `hold` sessions in a row.
   */
  function pickForSlot(slot, slotIdx, split, sessions, opts) {
    const o = opts || {};
    const cands = candidatesFor(slot, o);
    if (!cands.length) return null;
    const today = o.today;
    if (slot.anchor && !o.reroll) {
      const hold = FRESHNESS[o.freshness] || FRESHNESS.mixed;
      const same = finished(sessions).filter((s) => s.split === split);
      const last = same[0] && (same[0].exercises || []).find((x) => x.slot === slotIdx);
      if (last && cands.some((c) => c.id === last.exId)) {
        let run = 0;
        for (const s of same) {
          const x = (s.exercises || []).find((e) => e.slot === slotIdx);
          if (x && x.exId === last.exId) run++; else break;
        }
        if (run < hold) return BY_ID[last.exId];
        // Held long enough — rotate to anything else.
        const others = cands.filter((c) => c.id !== last.exId);
        if (others.length) return leastRecent(others, sessions, today, o.rng, true);
      }
    }
    // An anchor with nothing to go on starts on a staple (the library lists
    // each pattern's staple first) — a first Push day opens on bench press,
    // not a random pick. "Switch it up" (reroll) stays random.
    return leastRecent(cands, sessions, today, o.rng, slot.anchor && !o.reroll);
  }

  function leastRecent(cands, sessions, today, rng, staplesFirst) {
    const r = rng || Math.random;
    const scored = cands.map((c, idx) => ({ c, age: daysSince(c.id, sessions, today), tie: staplesFirst ? idx : r() }));
    scored.sort((a, b) => (b.age - a.age) || (a.tie - b.tie));
    return scored[0].c;
  }

  /**
   * The target for one exercise from its last appearance (double progression).
   *   never done           → pick a working weight at RPE 7
   *   every working set hit the top of the range, avg RPE ≤ 8.5 → add weight
   *   any set under the bottom, or a set at RPE ≥ 9.5            → hold weight
   *   otherwise            → same weight, one more rep than the best set
   */
  function targetFor(exId, repRange, sessions) {
    const ex = BY_ID[exId];
    const [lo, hi] = repRange || [8, 12];
    const h = historyOf(exId, sessions)[0];
    if (!h) return { weight: null, reps: lo, note: 'New — find a weight you could do ' + (hi + 2) + ' times (RPE 7)' };
    const sets = workingSets(h.ex);
    const weights = sets.map((s) => num(s.weight));
    const top = Math.max.apply(null, weights);
    const atTop = sets.filter((s) => num(s.weight) === top);
    const minReps = Math.min.apply(null, atTop.map((s) => num(s.reps)));
    const maxReps = Math.max.apply(null, atTop.map((s) => num(s.reps)));
    const rpes = atTop.map((s) => num(s.rpe)).filter((v) => v > 0);
    const avgRpe = rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : 8;
    const grind = rpes.some((v) => v >= 9.5);
    const inc = ex ? ex.inc : 5;
    const repsList = atTop.map((s) => num(s.reps)).join('/');
    const last = top > 0 ? top + ' × ' + repsList : repsList + ' reps';
    if (minReps >= hi && avgRpe <= 8.5 && !grind) {
      if (inc > 0 && top > 0) return { weight: roundTo(top + inc, inc >= 5 ? 5 : 2.5), reps: lo, note: 'Earned it: +' + inc + ' lb (last ' + last + ')' };
      return { weight: top || null, reps: hi + 1, note: 'Top of the range — add reps or slow the tempo (last ' + last + ')' };
    }
    if (minReps < lo || grind) return { weight: top || null, reps: lo, note: 'Hold ' + (top ? top + ' lb' : 'the weight') + ' — own the bottom of the range (last ' + last + ')' };
    // The best set already reached the top: the job now is every set there.
    if (maxReps >= hi) return { weight: top || null, reps: hi, note: 'Every set to ' + hi + (top ? ' at ' + top + ' lb' : '') + ', then the weight goes up (last ' + last + ')' };
    return { weight: top || null, reps: maxReps + 1, note: 'Beat last time: ' + (top ? top + ' × ' : '') + (maxReps + 1) + ' (last ' + last + ')' };
  }

  /** Next day in the rotation after the last finished session. */
  function nextSplit(sessions, rotation) {
    const rot = ROTATIONS[rotation] || ROTATIONS.ppl;
    const last = finished(sessions).find((s) => rot.includes(s.split));
    if (!last) return rot[0];
    return rot[(rot.indexOf(last.split) + 1) % rot.length];
  }

  /**
   * Build a day. opts: { today:'YYYY-MM-DD', equip:[...], freshness,
   * seed, reroll (true = ignore anchor holds — "Switch it up") }.
   * The same exercise is never used twice in one day.
   */
  function buildSession(split, sessions, opts) {
    const o = Object.assign({ freshness: 'mixed' }, opts || {});
    const def = SPLITS[split] || SPLITS.push;
    const rng = rngFrom(o.seed || 1);
    const used = [];
    const exercises = [];
    def.slots.forEach((slot, i) => {
      const pick = pickForSlot(slot, i, split, sessions, Object.assign({}, o, { rng, exclude: used.concat(o.exclude || []) }));
      if (!pick) return;
      used.push(pick.id);
      const target = targetFor(pick.id, slot.reps, sessions);
      exercises.push({
        exId: pick.id, name: pick.name, slot: i, repRange: slot.reps.slice(), target,
        sets: Array.from({ length: slot.sets }, () => ({ reps: '', weight: target.weight == null ? '' : target.weight, rpe: '', done: false })),
      });
    });
    return { split, label: def.label, date: o.today, exercises };
  }

  /** Other exercises that could fill this slot today, least-recent first. */
  function swapOptions(split, slotIdx, currentIds, sessions, opts) {
    const def = SPLITS[split];
    const slot = def && def.slots[slotIdx];
    if (!slot) return [];
    const o = opts || {};
    const cands = candidatesFor(slot, Object.assign({}, o, { exclude: currentIds || [] }));
    return cands
      .map((c) => ({ c, age: daysSince(c.id, sessions, o.today) }))
      .sort((a, b) => b.age - a.age || a.c.name.localeCompare(b.c.name))
      .slice(0, o.limit || 5)
      .map((x) => x.c);
  }

  /** New bests in a finished session vs everything before it. */
  function detectPRs(session, priorSessions) {
    const prs = [];
    for (const ex of (session && session.exercises) || []) {
      let best = 0, bestSet = null;
      for (const set of workingSets(ex)) { const v = e1rm(set.weight, set.reps); if (v > best) { best = v; bestSet = set; } }
      if (!best) continue;
      const prev = bestE1rm(ex.exId, priorSessions);
      if (prev > 0 && best > prev) prs.push({ exId: ex.exId, name: ex.name, e1rm: best, prev, set: bestSet });
    }
    return prs;
  }

  /**
   * Share of distinct exercises across the last `days` of training — 100%
   * means nothing repeated. Jo's "am I getting repetitive?" number.
   */
  function variety(sessions, todayYmd, days) {
    const win = days || 28;
    let total = 0; const ids = new Set();
    for (const s of finished(sessions)) {
      const [y1, m1, d1] = s.date.split('-').map(Number);
      const [y2, m2, d2] = todayYmd.split('-').map(Number);
      const age = Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
      if (age < 0 || age >= win) continue;
      for (const ex of s.exercises || []) if (workingSets(ex).length) { total++; ids.add(ex.exId); }
    }
    return { total, distinct: ids.size, pct: total ? Math.round(ids.size / total * 100) : 0 };
  }

  function volume(session) {
    let sets = 0, lbs = 0;
    for (const ex of (session && session.exercises) || []) for (const s of workingSets(ex)) { sets++; lbs += num(s.weight) * num(s.reps); }
    return { sets, lbs: Math.round(lbs) };
  }

  /** Rows for the day page's old free-text Exercise Log table. */
  function toPageRows(session) {
    return ((session && session.exercises) || []).map((ex) => {
      const ws = workingSets(ex);
      if (!ws.length) return null;
      const top = Math.max.apply(null, ws.map((s) => num(s.weight)));
      const rpes = ws.map((s) => num(s.rpe)).filter((v) => v > 0);
      return {
        name: ex.name,
        sets: String(ws.length),
        reps: ws.map((s) => s.reps).join('/'),
        weight: top ? String(top) : '',
        notes: rpes.length ? 'RPE ' + Math.max.apply(null, rpes) : '',
      };
    }).filter(Boolean);
  }

  /**
   * Local cache ∪ cloud sessions. Same id: the higher `mt` wins (a tie goes
   * to the cloud); a deleted copy on either side removes it. Newest first.
   */
  function mergeSessions(local, cloud) {
    const map = new Map();
    const dead = new Set();
    for (const s of cloud || []) if (s && s.deleted) dead.add(String(s.id));
    for (const s of local || []) if (s && s.deleted) dead.add(String(s.id));
    for (const s of local || []) if (s && !dead.has(String(s.id))) map.set(String(s.id), s);
    for (const s of cloud || []) {
      if (!s || dead.has(String(s.id))) continue;
      const l = map.get(String(s.id));
      if (!l || num(s.mt) >= num(l.mt)) map.set(String(s.id), s);
    }
    return [...map.values()].sort(byDateDesc);
  }

  /** A timer length (s) after a set: compounds rest longer. */
  function restFor(exId) { const e = BY_ID[exId]; return e && e.compound ? 150 : 75; }

  const api = {
    EXERCISES, BY_ID, EQUIP, SPLITS, ROTATIONS, FRESHNESS,
    rngFrom, e1rm, historyOf, bestE1rm, daysSince, candidatesFor, pickForSlot, targetFor,
    nextSplit, buildSession, swapOptions, detectPRs, variety, volume, toPageRows, restFor, mergeSessions,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCoach = api;
})(typeof window !== 'undefined' ? window : null);
