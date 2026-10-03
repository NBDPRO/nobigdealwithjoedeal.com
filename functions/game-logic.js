/**
 * game-logic.js — the OPTIONAL game layer's XP, computed from real work
 * (Jo, 2026-10-03: "the gamey side encourages interaction and makes it feel
 * more personal … I just don't know how far to take it before we distract or
 * overwhelm users").
 *
 * The rules that keep it a work system:
 *   - XP comes ONLY from work that already happened, read from the records
 *     the CRM already keeps (tasks ticked, calls handled / filed, leads,
 *     review asks, jobs won, money COLLECTED). Nothing is earned for opening
 *     the app, and nothing is stored: getGameCard derives it on request, so
 *     it can't be edited or farmed from the client.
 *   - Grindable actions are capped per day (marking calls handled, adding
 *     leads) so the number tracks the job, not tapping.
 *   - Competition is with yourself: this week vs last week ("your ghost").
 *
 * Pure: no Firestore. functions/game.js feeds it plain records.
 */
'use strict';

// One place to tune. Points per event; dailyCap = max points per ET day.
const RULES = {
  task:     { pts: 10, label: 'Follow-ups done' },
  promise:  { pts: 5,  label: 'Promises kept (from calls)' },          // bonus on a call / text task
  handled:  { pts: 3,  label: 'Calls handled', dailyCap: 30 },
  filed:    { pts: 10, label: 'Calls filed on a customer' },
  lead:     { pts: 10, label: 'New leads', dailyCap: 60 },
  review:   { pts: 15, label: 'Review asks sent' },
  won:      { pts: 50, label: 'Jobs won' },
  collected:{ per: 100, pts: 1, label: 'Money collected' },             // 1 XP per $100 collected
};

const TITLES = ['Apprentice', 'Laborer', 'Installer', 'Crew lead', 'Foreman', 'Estimator', 'Roof boss', 'Master roofer', 'Legend'];

// Level L needs 50·L·(L+1) total XP: 100, 300, 600, 1000, 1500 …
function xpForLevel(level) { return 50 * level * (level + 1); }
function levelFor(totalXp) {
  let L = 0;
  while (xpForLevel(L + 1) <= totalXp) L++;
  return {
    level: L + 1,
    title: TITLES[Math.min(Math.floor(L / 2), TITLES.length - 1)],
    floor: L === 0 ? 0 : xpForLevel(L),
    next: xpForLevel(L + 1),
  };
}

function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** ET calendar day for a timestamp. */
function etDay(msv) { return new Date(msv).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }

/** This week = Monday 00:00 ET → now; last week = the 7 days before that. */
function weekBounds(nowMs) {
  const today = etDay(nowMs);
  const [y, m, d] = today.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(Date.UTC(y, m - 1, d - dow)).toISOString().slice(0, 10);
  const lastMonday = new Date(Date.UTC(y, m - 1, d - dow - 7)).toISOString().slice(0, 10);
  return { thisStart: monday, lastStart: lastMonday, today };
}

/**
 * Every XP event from the records: [{ kind, atMs, units }].
 * records: { tasks, calls, leads, invoices, paymentsOf }
 *   tasks    leads/{id}/tasks docs of this user (done / completedAt / source)
 *   calls    phone_calls + phone_text_days docs of this user
 *   leads    this user's leads
 *   invoices this user's invoices; paymentsOf(inv) → [{ amount, at }]
 */
function eventsFrom({ uid, tasks, calls, leads, invoices, paymentsOf }) {
  const ev = [];
  for (const t of tasks || []) {
    if (!t || t.done !== true) continue;
    const at = toMs(t.completedAt) || toMs(t.updatedAt);
    if (!at) continue;
    ev.push({ kind: 'task', atMs: at });
    if (t.source === 'cube-acr' || t.source === 'sms-inbox' || /^(cube|sms)-/.test(String(t.id || ''))) ev.push({ kind: 'promise', atMs: at });
  }
  for (const c of calls || []) {
    if (!c) continue;
    if (c.handledAtMs && (!c.handledBy || c.handledBy === uid)) ev.push({ kind: 'handled', atMs: Number(c.handledAtMs) });
    if (c.attachedAtMs && (!c.attachedBy || c.attachedBy === uid)) ev.push({ kind: 'filed', atMs: Number(c.attachedAtMs) });
  }
  for (const l of leads || []) {
    if (!l || l.deleted === true) continue;
    const created = toMs(l.createdAt);
    // A lead counts when it's a real contact (a phone or an address), so
    // empty placeholder leads earn nothing.
    if (created && (l.phone || l.address)) ev.push({ kind: 'lead', atMs: created });
    if (l.reviewRequested === true && toMs(l.reviewRequestedAt)) ev.push({ kind: 'review', atMs: toMs(l.reviewRequestedAt) });
    if (l.stageRole === 'won' && toMs(l.stageStartedAt)) ev.push({ kind: 'won', atMs: toMs(l.stageStartedAt) });
  }
  for (const inv of invoices || []) {
    if (!inv || inv.deleted === true || typeof paymentsOf !== 'function') continue;
    for (const p of paymentsOf(inv) || []) {
      const at = toMs(p.at);
      const amt = Number(p.amount) || 0;
      if (at && amt) ev.push({ kind: 'collected', atMs: at, units: amt });   // refunds are negative
    }
  }
  return ev;
}

/** Score events in [fromYmd, toYmd] (inclusive, ET days); caps per day. */
function score(events, fromYmd, toYmd) {
  const byKind = {}; const dayTotals = {};
  let dollars = 0;
  for (const e of events) {
    const day = etDay(e.atMs);
    if ((fromYmd && day < fromYmd) || (toYmd && day > toYmd)) continue;
    if (e.kind === 'collected') { dollars += e.units; continue; }
    const r = RULES[e.kind];
    if (!r) continue;
    const key = e.kind + '|' + day;
    const before = dayTotals[key] || 0;
    const add = r.dailyCap ? Math.max(0, Math.min(r.pts, r.dailyCap - before)) : r.pts;
    dayTotals[key] = before + add;
    const k = byKind[e.kind] || (byKind[e.kind] = { count: 0, xp: 0 });
    k.count++; k.xp += add;
  }
  const collectedXp = Math.max(0, Math.floor(dollars / RULES.collected.per) * RULES.collected.pts);
  if (dollars) byKind.collected = { count: Math.round(dollars), xp: collectedXp };
  const xp = Object.values(byKind).reduce((s, k) => s + k.xp, 0);
  return { xp, byKind };
}

function dayBefore(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** The card: level from all-time XP, this week vs last week, and why. */
function buildCard({ uid, nowMs, tasks, calls, leads, invoices, paymentsOf }) {
  const events = eventsFrom({ uid, tasks, calls, leads, invoices, paymentsOf });
  const wb = weekBounds(nowMs);
  const total = score(events, null, wb.today);
  const thisWeek = score(events, wb.thisStart, wb.today);
  const lastWeek = score(events, wb.lastStart, dayBefore(wb.thisStart));
  const lv = levelFor(total.xp);
  const order = ['task', 'promise', 'filed', 'handled', 'lead', 'review', 'won', 'collected'];
  const breakdown = order.filter((k) => thisWeek.byKind[k]).map((k) => ({
    kind: k, label: RULES[k].label, count: thisWeek.byKind[k].count, xp: thisWeek.byKind[k].xp,
  }));
  return {
    totalXp: total.xp, level: lv.level, title: lv.title, levelFloor: lv.floor, levelNext: lv.next,
    week: { start: wb.thisStart, xp: thisWeek.xp }, lastWeek: { start: wb.lastStart, xp: lastWeek.xp },
    breakdown,
  };
}

module.exports = { RULES, TITLES, xpForLevel, levelFor, weekBounds, eventsFrom, score, buildCard, etDay, toMs };
