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
 *                  sets:[{ reps, weight, rpe, done, warm? }] }], notes }
 * A set with warm:true is a warm-up. It is never a "working set": every
 * number below (volume, est. 1RM, PRs, targets, variety, the old-page rows)
 * goes through workingSets(), which drops it.
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
  // The primary muscle group each pattern trains — a static tag on every
  // exercise (e.muscle). Drives the weekly balance nudge.
  const MUSCLE_OF_PATTERN = {
    h_push: 'chest', incline_push: 'chest', chest_iso: 'chest', v_push: 'shoulders', lateral: 'shoulders', rear_delt: 'shoulders',
    triceps: 'triceps', v_pull: 'back', h_pull: 'back', biceps: 'biceps', squat: 'quads', lunge: 'quads', quad_iso: 'quads',
    hinge: 'hams', ham_iso: 'hams', calves: 'calves', core: 'core',
  };
  const MUSCLES = ['chest', 'shoulders', 'back', 'biceps', 'triceps', 'quads', 'hams', 'calves', 'core'];
  const MUSCLE_LABELS = { chest: 'Chest', shoulders: 'Shoulders', back: 'Back', biceps: 'Biceps', triceps: 'Triceps', quads: 'Quads', hams: 'Hams & glutes', calves: 'Calves', core: 'Core' };
  const BY_ID = Object.create(null);
  EXERCISES.forEach((e) => { e.muscle = MUSCLE_OF_PATTERN[e.pattern]; BY_ID[e.id] = e; });
  const EQUIP = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight'];

  // Plain-English names for the movement patterns (the "Avoid" chips).
  const PATTERN_LABELS = {
    h_push: 'Bench / chest press', incline_push: 'Incline press', v_push: 'Overhead press', chest_iso: 'Chest fly',
    lateral: 'Lateral raise', rear_delt: 'Rear delts', triceps: 'Triceps', v_pull: 'Pull-ups / pulldowns',
    h_pull: 'Rows', biceps: 'Biceps', squat: 'Squats', hinge: 'Hinge / deadlift', lunge: 'Lunges / step-ups',
    quad_iso: 'Quad isolation', ham_iso: 'Hamstring curls', calves: 'Calves', core: 'Core',
  };

  // ── plate calculator ──────────────────────────────────────────────────
  // Set once in the coach settings: the bar and which plate sizes are in the
  // rack. Pure arithmetic — greedy, biggest plate first.
  const DEFAULT_PLATES = { bar: 45, plates: [45, 35, 25, 10, 5, 2.5] };
  const PLATE_SIZES = [100, 55, 45, 35, 25, 15, 10, 5, 2.5, 1.25];
  function normPlates(p) {
    const bar = num(p && p.bar);
    const list = Array.isArray(p && p.plates) ? p.plates.map(num).filter((v) => PLATE_SIZES.includes(v)) : [];
    return {
      bar: bar >= 10 && bar <= 100 ? bar : DEFAULT_PLATES.bar,
      plates: list.length ? [...new Set(list)].sort((a, b) => b - a) : DEFAULT_PLATES.plates.slice(),
    };
  }
  const fmtLb = (x) => String(Math.round(x * 100) / 100);
  /**
   * What goes on each side for a target weight. Returns null for no weight;
   * { perSide:[45,25,10], achieved, remainder, text }. A weight the plates
   * cannot make exactly loads what it can and reports the remainder (lb,
   * both sides together) — it never rounds the target silently.
   */
  function platesPerSide(weight, cfg) {
    const w = num(weight);
    if (w <= 0) return null;
    const c = normPlates(cfg);
    if (w < c.bar) return { bar: c.bar, perSide: [], achieved: c.bar, remainder: 0, underBar: true, text: 'Lighter than the ' + fmtLb(c.bar) + ' lb bar' };
    const q = (x) => Math.round(x * 100);        // hundredths of a lb: no float drift
    let side = q((w - c.bar) / 2);
    const perSide = [];
    for (const p of c.plates) { while (side >= q(p)) { perSide.push(p); side -= q(p); } }
    const remainder = (side * 2) / 100;
    const achieved = Math.round((w - remainder) * 100) / 100;
    let text = perSide.length ? perSide.map(fmtLb).join(' / ') + ' per side' : 'Just the bar';
    if (remainder > 0) text += ' — plates make ' + fmtLb(achieved) + ' (' + fmtLb(remainder) + ' lb short)';
    return { bar: c.bar, perSide, achieved, remainder, underBar: false, text };
  }

  /**
   * The "avoiding for now" list (sore shoulder, bad knee…): whole movement
   * patterns and/or single exercises the coach must not offer. Unknown ids
   * and junk are dropped so a stale synced setting can't break a build.
   */
  function normAvoid(a) {
    const pats = Array.isArray(a && a.patterns) ? a.patterns : [];
    const exs = Array.isArray(a && a.exercises) ? a.exercises : [];
    const knownPat = new Set(EXERCISES.map((e) => e.pattern));
    return {
      patterns: [...new Set(pats.filter((p) => knownPat.has(p)))],
      exercises: [...new Set(exs.filter((id) => BY_ID[id]))],
    };
  }
  function isAvoided(ex, avoid) {
    const a = normAvoid(avoid);
    return !!ex && (a.patterns.includes(ex.pattern) || a.exercises.includes(ex.id));
  }

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
    return ((ex && ex.sets) || []).filter((s) => s && !s.warm && s.done !== false && num(s.reps) > 0);
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
    const keepAvoided = !!(opts && opts.includeAvoided);
    return EXERCISES.filter((e) => pats.includes(e.pattern) && equip.has(e.equip) && !((opts && opts.exclude) || []).includes(e.id)
      && (keepAvoided || !isAvoided(e, opts && opts.avoid)));
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
        if (others.length) return leastRecent(others, sessions, today, o.rng, true, o.bias);
      }
    }
    // An anchor with nothing to go on starts on a staple (the library lists
    // each pattern's staple first) — a first Push day opens on bench press,
    // not a random pick. "Switch it up" (reroll) stays random.
    return leastRecent(cands, sessions, today, o.rng, slot.anchor && !o.reroll, o.bias);
  }

  // bias (optional): muscle groups that are behind this week. A candidate in
  // one of them goes first; with no bias every candidate ties and the order is
  // exactly the least-recent / seeded order it always was.
  function leastRecent(cands, sessions, today, rng, staplesFirst, bias) {
    const r = rng || Math.random;
    const want = Array.isArray(bias) && bias.length ? bias : null;
    const scored = cands.map((c, idx) => ({ c, age: daysSince(c.id, sessions, today), tie: staplesFirst ? idx : r(), pref: want && want.includes(c.muscle) ? 0 : 1 }));
    scored.sort((a, b) => (a.pref - b.pref) || (b.age - a.age) || (a.tie - b.tie));
    return scored[0].c;
  }

  /**
   * The target for one exercise from its last appearance (double progression).
   *   never done           → pick a working weight at RPE 7
   *   every working set hit the top of the range, avg RPE ≤ 8.5 → add weight
   *   any set under the bottom, or a set at RPE ≥ 9.5            → hold weight
   *   otherwise            → same weight, one more rep than the best set
   */
  function baseTarget(exId, repRange, sessions) {
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

  // ── stall detection ───────────────────────────────────────────────────
  // If an exercise's best (est. 1RM, or reps for a bodyweight lift) has not
  // beaten the first of its last 3 sessions, it is stalled. targetFor() only
  // REPORTS this (target.stall); nothing about the weight or reps is changed
  // until Jo taps Deload. A session saved with deload:true resets the count
  // (the deload and everything older is ignored), so a deload is not nagged
  // as another stall. Reads through historyOf(), so warm-ups never count.
  const STALL_SESSIONS = 3;
  const DELOAD_PCT = 0.10;
  const setScore = (s) => (num(s.weight) > 0 ? e1rm(s.weight, s.reps) : Math.round(num(s.reps)));
  function bestSetOf(ex) {
    let best = null, score = 0;
    for (const s of workingSets(ex)) { const v = setScore(s); if (v > score) { score = v; best = s; } }
    return best ? { score, weight: num(best.weight), reps: Math.round(num(best.reps)) } : null;
  }
  function deloadWeightFor(exId, top, platesCfg) {
    const ex = BY_ID[exId];
    if (!ex || !(top > 0)) return null;
    const raw = top * (1 - DELOAD_PCT);
    let w;
    if (ex.equip === 'barbell') w = platesPerSide(raw, platesCfg).achieved;   // rounds down to a loadable weight
    else { const step = ex.inc >= 5 ? 5 : 2.5; w = roundTo(raw, step); if (w >= top) w -= step; }
    return w > 0 && w < top ? w : null;
  }
  function stallFor(exId, sessions, platesCfg) {
    let hist = historyOf(exId, sessions);                       // newest first, working sets only
    const cut = hist.findIndex((h) => h.ex.deload);
    if (cut >= 0) hist = hist.slice(0, cut);
    if (hist.length < STALL_SESSIONS) return null;
    const recent = hist.slice(0, STALL_SESSIONS).map((h) => bestSetOf(h.ex));
    if (recent.some((r) => !r)) return null;
    const oldest = recent[STALL_SESSIONS - 1].score;
    if (!(oldest > 0) || !recent.slice(0, STALL_SESSIONS - 1).every((r) => r.score <= oldest)) return null;
    const best = recent.reduce((a, b) => (b.score > a.score ? b : a));
    return {
      sessions: STALL_SESSIONS,
      best: { weight: best.weight, reps: best.reps },
      label: best.weight > 0 ? best.weight + ' × ' + best.reps : best.reps + ' reps',
      deloadWeight: deloadWeightFor(exId, topWeight(hist[0].ex), platesCfg),
    };
  }
  const topWeight = (ex) => Math.max.apply(null, workingSets(ex).map((s) => num(s.weight)).concat([0]));

  /** The target, plus target.stall when the lift has stalled (informational only). opts: { plates }. */
  function targetFor(exId, repRange, sessions, opts) {
    const t = baseTarget(exId, repRange, sessions);
    const st = stallFor(exId, sessions, opts && opts.plates);
    if (st) t.stall = st;
    return t;
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
      const target = targetFor(pick.id, slot.reps, sessions, { plates: o.plates });
      exercises.push({
        exId: pick.id, name: pick.name, slot: i, repRange: slot.reps.slice(), target,
        sets: setsFor(slot, pick.id, target, slot.sets, o),
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

  // ── warm-up sets ──────────────────────────────────────────────────────
  // The first heavy compound of a day (the anchor slot) gets warm-up rows
  // ahead of its working sets: the bar, then 40 / 60 / 80% of the first
  // working weight, each rounded DOWN to a weight the plates can make. Each
  // row carries warm:true so nothing that measures work ever counts it.
  const WARM_STEPS = [{ pct: 0.4, reps: 5 }, { pct: 0.6, reps: 3 }, { pct: 0.8, reps: 2 }];
  function warmupSets(exId, workWeight, platesCfg) {
    const ex = BY_ID[exId];
    const w = num(workWeight);
    if (!ex || !ex.compound || w <= 0) return [];
    const barbell = ex.equip === 'barbell';
    const bar = normPlates(platesCfg).bar;
    if (barbell ? w <= bar : w < 20) return [];
    const makeable = (x) => (barbell ? platesPerSide(x, platesCfg).achieved : Math.floor(x / 5) * 5);
    const plan = [];
    if (barbell) plan.push({ weight: bar, reps: 8 });
    for (const st of WARM_STEPS) plan.push({ weight: makeable(w * st.pct), reps: st.reps });
    const rows = [];
    let prev = 0;
    for (const r of plan) {                       // strictly rising, always lighter than the work
      if (r.weight > prev && r.weight < w) { rows.push({ weight: r.weight, reps: r.reps }); prev = r.weight; }
    }
    return rows;
  }

  /** The set rows for one exercise: warm-ups (first compound only) then `count` working sets. */
  function setsFor(slot, exId, target, count, opts) {
    const o = opts || {};
    const w = target && target.weight;
    const work = Array.from({ length: count }, () => ({ reps: '', weight: w == null ? '' : w, rpe: '', done: false }));
    if (!o.warmups || !slot || !slot.anchor || !(num(w) > 0)) return work;
    const warm = warmupSets(exId, w, o.plates).map((r) => ({ reps: '', weight: r.weight, rpe: '', done: false, warm: true, plan: r.reps }));
    return warm.concat(work);
  }

  /**
   * Exercises that fit this slot but are on the avoid list — only ever shown
   * behind an explicit "show anyway" with a warning, never offered by default.
   */
  function avoidedOptions(split, slotIdx, currentIds, opts) {
    const def = SPLITS[split];
    const slot = def && def.slots[slotIdx];
    if (!slot) return [];
    const o = opts || {};
    return candidatesFor(slot, Object.assign({}, o, { exclude: currentIds || [], includeAvoided: true }))
      .filter((e) => isAvoided(e, o.avoid));
  }

  /** Above this many reps the Epley estimate is too rough to call a strength PR. */
  const HIGH_REP = 12;
  const SAME_WEIGHT = 2.5;                       // lb: "the same weight" (plate rounding)

  /**
   * Volume PR: more reps than you have ever done at this weight or heavier — but only
   * where you HAVE done roughly this weight before (a lighter back-off set on a lift you
   * never trained there is not a record). -> { prev, weight } | null
   */
  function repPRCheck(exId, weight, reps, priorSessions) {
    const w = num(weight), r = Math.round(num(reps));
    if (!(r > 0)) return null;
    let seen = false, best = 0;
    for (const h of historyOf(exId, priorSessions)) {
      for (const s of workingSets(h.ex)) {
        const sw = num(s.weight);
        if (sw < w - SAME_WEIGHT) continue;
        if (Math.abs(sw - w) <= SAME_WEIGHT) seen = true;
        best = Math.max(best, Math.round(num(s.reps)));
      }
    }
    return seen && r > best ? { prev: best, weight: w } : null;
  }

  /** New bests in a finished session vs everything before it (est. 1RM up to HIGH_REP reps, plus rep records). */
  function detectPRs(session, priorSessions) {
    const prs = [];
    for (const ex of (session && session.exercises) || []) {
      let best = 0, bestSet = null, repSet = null, repHit = null;
      for (const set of workingSets(ex)) {
        if (Math.round(num(set.reps)) <= HIGH_REP) { const v = e1rm(set.weight, set.reps); if (v > best) { best = v; bestSet = set; } }
        const hit = repPRCheck(ex.exId, set.weight, set.reps, priorSessions);
        if (hit && (!repSet || Math.round(num(set.reps)) > Math.round(num(repSet.reps)))) { repSet = set; repHit = hit; }
      }
      const prev = bestE1rm(ex.exId, priorSessions);
      if (best && prev > 0 && best > prev) prs.push({ kind: 'e1rm', exId: ex.exId, name: ex.name, e1rm: best, prev, set: bestSet });
      else if (repSet) prs.push({ kind: 'reps', exId: ex.exId, name: ex.name, reps: Math.round(num(repSet.reps)), weight: repHit.weight, prev: repHit.prev, set: repSet });
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

  // ── readiness check-in ───────────────────────────────────────────────
  // Three taps at the start of a session — sleep, soreness, energy — each
  // 1 (rough) to 3 (great; "Fresh" is 3 for soreness). A total of 4 or less is
  // a rough day: every lift with 3+ untouched working sets drops one set, and a
  // lift that was about to GO UP in weight holds last time's weight instead.
  // It never blocks anything, always shows what it did (and can be undone),
  // and good days change nothing — it never pushes the load up.
  const READY_LOW = 4, READY_GOOD = 8;
  function readiness(rec) {
    const v = (k) => { const n = Math.round(num(rec && rec[k])); return n >= 1 && n <= 3 ? n : 0; };
    const sleep = v('sleep'), sore = v('sore'), energy = v('energy');
    if (!(sleep && sore && energy)) return { complete: false, total: 0, level: null };
    const total = sleep + sore + energy;
    return { complete: true, total, level: total <= READY_LOW ? 'low' : total >= READY_GOOD ? 'good' : 'ok' };
  }

  /**
   * Apply a rough-day check-in to a list of live exercises. Returns copies:
   * { exercises, trimmed, held, changed }. Only touches lifts with nothing
   * logged or typed yet, skips ones already adjusted (x.ready), and marks what
   * it changed so undoReadiness() can put it back exactly. Warm-ups are not
   * working sets: they are never trimmed (and are re-made under a held weight).
   */
  function applyReadiness(exercises, level, sessions, opts) {
    const o = opts || {};
    const list = exercises || [];
    if (level !== 'low') return { exercises: list, trimmed: 0, held: 0, changed: false };
    let trimmed = 0, held = 0;
    const out = list.map((x) => {
      const sets = x.sets || [];
      if (x.ready || sets.some((s) => s.done || num(s.reps) > 0)) return x;
      const work = sets.filter((s) => !s.warm);
      const h = historyOf(x.exId, sessions)[0];
      const lastTop = h ? Math.max.apply(null, workingSets(h.ex).map((s) => num(s.weight)).concat([0])) : 0;
      const tw = num(x.target && x.target.weight);
      const earned = lastTop > 0 && tw > lastTop;
      const trim = work.length >= 3;
      if (!earned && !trim) return x;
      const mark = { trimmed: trim, held: earned, setsWas: work.length, weightWas: x.target ? x.target.weight : null, targetWas: x.target || null };
      let target = x.target;
      let next = sets.map((s) => Object.assign({}, s));
      if (earned) {
        held++;
        target = Object.assign({}, x.target, { weight: lastTop, note: 'Hold ' + lastTop + ' lb today (rough-day check-in) — the bump waits for a better day' });
        next = next.map((s) => (!s.warm && String(s.weight) === String(x.target.weight) ? Object.assign(s, { weight: lastTop }) : s));
        if (next.some((s) => s.warm)) {
          const warm = warmupSets(x.exId, lastTop, o.plates).map((r) => ({ reps: '', weight: r.weight, rpe: '', done: false, warm: true, plan: r.reps }));
          next = warm.concat(next.filter((s) => !s.warm));
        }
      }
      if (trim) {
        trimmed++;
        for (let k = next.length - 1; k >= 0; k--) if (!next[k].warm) { next.splice(k, 1); break; }
      }
      return Object.assign({}, x, { target, sets: next, ready: mark });
    });
    return { exercises: out, trimmed, held, changed: trimmed + held > 0 };
  }

  /** Put back what applyReadiness changed (sets, held weight, target). */
  function undoReadiness(exercises, opts) {
    const o = opts || {};
    return (exercises || []).map((x) => {
      if (!x.ready) return x;
      const m = x.ready;
      let next = (x.sets || []).map((s) => Object.assign({}, s));
      if (m.held) {
        const cur = x.target ? x.target.weight : null;
        next = next.map((s) => (!s.warm && String(s.weight) === String(cur) ? Object.assign(s, { weight: m.weightWas == null ? '' : m.weightWas }) : s));
        if (next.some((s) => s.warm)) {
          const warm = warmupSets(x.exId, m.weightWas, o.plates).map((r) => ({ reps: '', weight: r.weight, rpe: '', done: false, warm: true, plan: r.reps }));
          next = warm.concat(next.filter((s) => !s.warm));
        }
      }
      let work = next.filter((s) => !s.warm).length;
      while (work < m.setsWas) {
        const last = next.filter((s) => !s.warm).slice(-1)[0] || {};
        next.push({ reps: '', weight: last.weight == null ? '' : last.weight, rpe: '', done: false });
        work++;
      }
      const back = Object.assign({}, x, { target: m.targetWas || x.target, sets: next });
      delete back.ready;
      return back;
    });
  }

  // ── weekly balance ────────────────────────────────────────────────────
  // Hard sets (= working sets; warm-ups never count) per muscle group over the
  // last 7 days, plus push : pull. It only speaks up once there is something to
  // read (a session this week and at least 6 sets) — no data, no nagging.
  const LOW_SETS = 4;
  const PUSH_PATTERNS = ['h_push', 'incline_push', 'v_push', 'chest_iso', 'triceps'];
  const PULL_PATTERNS = ['v_pull', 'h_pull', 'rear_delt', 'biceps'];
  const ageDays = (ymd, todayYmd) => {
    const [y1, m1, d1] = String(ymd).split('-').map(Number);
    const [y2, m2, d2] = String(todayYmd).split('-').map(Number);
    return Math.round((new Date(y2, m2 - 1, d2) - new Date(y1, m1 - 1, d1)) / 86400000);
  };
  function balance(sessions, todayYmd, opts) {
    const o = opts || {};
    const days = o.days || 7;
    const by = {}; MUSCLES.forEach((m) => { by[m] = 0; });
    let push = 0, pull = 0, total = 0, count = 0;
    for (const s of finished(sessions)) {
      const age = ageDays(s.date, todayYmd);
      if (!(age >= 0 && age < days)) continue;
      count++;
      for (const ex of s.exercises || []) {
        const lib = BY_ID[ex.exId];
        if (!lib) continue;
        const n = workingSets(ex).length;
        by[lib.muscle] += n; total += n;
        if (PUSH_PATTERNS.includes(lib.pattern)) push += n; else if (PULL_PATTERNS.includes(lib.pattern)) pull += n;
      }
    }
    // A group Jo can't train (equipment, or everything in it is on the avoid list) is never flagged.
    const equip = new Set((o.equip && o.equip.length) ? o.equip : EQUIP);
    const trainable = MUSCLES.filter((m) => EXERCISES.some((e) => e.muscle === m && equip.has(e.equip) && !isAvoided(e, o.avoid)));
    const enough = count > 0 && total >= 6;
    const zero = trainable.filter((m) => by[m] === 0);
    const low = trainable.filter((m) => by[m] > 0 && by[m] < LOW_SETS).sort((a, b) => by[a] - by[b]);
    let tilt = null;
    if (enough && push + pull >= 6) {
      if (pull === 0 || push / pull > 1.5) tilt = 'push';
      else if (push === 0 || pull / push > 1.5) tilt = 'pull';
    }
    return { days, sessions: count, total, byMuscle: by, push, pull, enough, zero: enough ? zero : [], low: enough ? low : [],
      neglected: enough ? zero.concat(low) : [], tilt };
  }

  /** Split days that train a muscle group (for "Legs day covers that"). */
  function splitsFor(muscle) {
    return Object.keys(SPLITS).filter((k) => SPLITS[k].slots.some((sl) => patternsOf(sl).some((p) => MUSCLE_OF_PATTERN[p] === muscle)));
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

  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtW = (w) => String(Math.round(num(w) * 10) / 10);

  /**
   * "Last time (Oct 14): 135×8, 135×8, 135×7" for one lift — the working sets of its
   * most recent finished appearance. null when it was never logged.
   */
  function lastTime(exId, sessions) {
    const h = historyOf(exId, sessions)[0];
    if (!h) return null;
    const sets = workingSets(h.ex).map((s) => ({ weight: num(s.weight), reps: Math.round(num(s.reps)) }));
    const [, m, d] = String(h.date).split('-').map(Number);
    const when = m >= 1 && m <= 12 && d ? MON[m - 1] + ' ' + d : String(h.date);
    const text = sets.map((s) => (s.weight > 0 ? fmtW(s.weight) + '\u00d7' + s.reps : s.reps + ' reps')).join(', ');
    return { date: h.date, sets, text: 'Last time (' + when + '): ' + text };
  }

  /**
   * Live PR check while a workout is open. Two kinds, one trophy per lift (strength wins):
   *   'e1rm' - a ticked set of up to HIGH_REP reps beats the best estimated 1RM from earlier
   *            finished sessions;
   *   'reps' - a ticked set beats the most reps ever done at that weight or heavier
   *            (so a 20-rep volume set can earn a trophy without a bogus 1RM).
   * Nothing counts until the lift has history to beat.
   * -> { kind, index, prev, e1rm? | reps?, weight? } | null
   */
  function livePR(ex, priorSessions) {
    if (!ex) return null;
    const prevE = bestE1rm(ex.exId, priorSessions);
    // "history" is not "a best 1RM above zero": a bodyweight lift logged at 0 lb has history but no e1RM, and its rep PR must still fire live
    if (!historyOf(ex.exId, priorSessions).length) return null;
    let e = null, r = null;
    (ex.sets || []).forEach((s, j) => {
      if (!s || s.warm || s.done !== true || !(num(s.reps) > 0)) return;
      const reps = Math.round(num(s.reps));
      if (prevE > 0 && reps <= HIGH_REP) {
        const v = e1rm(s.weight, s.reps);
        if (v > (e ? e.e1rm : prevE)) e = { kind: 'e1rm', index: j, e1rm: v, prev: prevE };
      }
      const hit = repPRCheck(ex.exId, s.weight, s.reps, priorSessions);
      if (hit && (!r || reps > r.reps)) r = { kind: 'reps', index: j, reps, weight: hit.weight, prev: hit.prev };
    });
    return e || r;
  }

  /**
   * "Previous" for each working set of a lift: the sets of its most recent finished session, in order (warm-ups out).
   * The screen shows set N next to the previous session's set N, like Strong's Previous column.
   * -> [{ weight, reps }] ([] when the lift was never logged)
   */
  function previousSets(exId, sessions) {
    const h = historyOf(exId, sessions)[0];
    if (!h) return [];
    return workingSets(h.ex).map((s) => ({ weight: num(s.weight), reps: Math.round(num(s.reps)) }));
  }
  /** "185 × 5" (bodyweight: "8 reps"). */
  function prevText(p) { return p ? (p.weight > 0 ? fmtW(p.weight) + '\u00d7' + p.reps : p.reps + ' reps') : ''; }

  /** What the rest timer does when it hits zero. iPhone Safari has no navigator.vibrate, so sound is the default. */
  const REST_ALERTS = ['both', 'sound', 'vibrate', 'off'];
  function normRestAlert(v) { return REST_ALERTS.indexOf(v) > -1 ? v : 'both'; }
  function restAlertPlan(mode) { const m = normRestAlert(mode); return { sound: m === 'both' || m === 'sound', vibrate: m === 'both' || m === 'vibrate' }; }

  /** A timer length (s) after a set: compounds rest longer. */
  function restFor(exId) { const e = BY_ID[exId]; return e && e.compound ? 150 : 75; }

  const api = {
    EXERCISES, BY_ID, EQUIP, SPLITS, ROTATIONS, FRESHNESS, PATTERN_LABELS,
    MUSCLES, MUSCLE_LABELS, LOW_SETS, balance, splitsFor, READY_LOW, READY_GOOD, readiness, applyReadiness, undoReadiness,
    DEFAULT_PLATES, PLATE_SIZES, normPlates, platesPerSide, warmupSets, setsFor, stallFor, STALL_SESSIONS, normAvoid, isAvoided, avoidedOptions, rngFrom, e1rm, historyOf, bestE1rm, lastTime, livePR, repPRCheck, HIGH_REP, previousSets, prevText, REST_ALERTS, normRestAlert, restAlertPlan, daysSince, candidatesFor, pickForSlot, targetFor,
    nextSplit, buildSession, swapOptions, detectPRs, variety, volume, toPageRows, restFor, mergeSessions,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDCoach = api;
})(typeof window !== 'undefined' ? window : null);
