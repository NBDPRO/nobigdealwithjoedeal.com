'use strict';
/**
 * leaderboard-aggregate-logic.js — the pure half of leaderboardAggregate
 * (NBD OS P2 "Team", 2026-11-09; documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §8 P2).
 *
 * One row per company member at leaderboard/{uid} (firestore.rules: readable by
 * the member and their own company, never written by a client) with today's and
 * this week's COUNTED numbers, in the company's time zone, weeks from Monday:
 *   doors      the member's knocks (knocks.userId, createdAt)
 *   appts      those knocks with disposition 'appointment' (D2D "Appointment set";
 *              pages/leaderboard.js counts the same)
 *   estimates  leads the member moved into an estimate-sent stage (estimate_sent_cash,
 *              estimate_submitted), read from stageHistory { to, timestamp, by }
 *              (stage-write.js); each lead once per window, credited to the mover
 *   deals      the member's sales (stage-roles.js isSale), dated by the sale date
 *              (closedAt, else the first move into a sale stage; numbers-logic.js
 *              saleDateMs), over every job (jobs-logic.js jobRecords); never updatedAt
 * Nothing else: no money, no customer, no lead id. Every number is a count of
 * records; a member with no records gets zeros (nothing happened), and a row is
 * written only for a member the run actually counted.
 *
 * No clock, no network: tested in tests/nbd-os-team-aggregate-2026-11-09.test.js.
 */
const stageRoles = require('./stage-roles');
const jobsLogic = require('./jobs-logic');

const DEFAULT_TZ = 'America/New_York';   // the house default every server day rule uses (owner-weekly-digest, ky-insurance-law)
const DAY = 86400000;
const ESTIMATE_SENT = new Set(['estimate_sent_cash', 'estimate_submitted']);
const SALE_KEYS = new Set(['contract_signed'].concat(stageRoles.WON_STAGES, ['job_created', 'permit_pulled', 'materials_ordered',
  'materials_delivered', 'crew_scheduled', 'install_in_progress']));
const NAME_MAX = 60;

const _ok = {};
function validTimeZone(z) {
  if (!z || typeof z !== 'string' || z.length > 64) return false;
  if (_ok[z] !== undefined) return _ok[z];
  let v;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }).format(0); v = true; } catch (_) { v = false; }
  _ok[z] = v;
  return v;
}

/**
 * The company's zone, else Eastern, set:false. The house order, on purpose (one source of
 * truth with ky-insurance-law.js, agent-mcp-logic.js companyTimeZone and the Settings panel's
 * current() in company-timezone-settings.js): the older timezone (Bots & API), then timeZone
 * (the Settings panel, which writes both when the older one exists), then the brand's.
 */
function companyZone(profile) {
  const p = profile || {};
  const b = p.brand || {};
  const c = [p.timezone, p.timeZone, b.timezone, b.timeZone].find(validTimeZone);
  return c ? { tz: c, set: true } : { tz: DEFAULT_TZ, set: false };
}

const _fmt = {};
function parts(ms, tz) {
  const f = _fmt[tz] || (_fmt[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const o = {};
  f.formatToParts(new Date(ms)).forEach((x) => { if (x.type !== 'literal') o[x.type] = Number(x.value); });
  return o;
}
const pad = (n) => (n < 10 ? '0' : '') + n;
/** 'YYYY-MM-DD' of an instant in a zone. */
function ymdInZone(ms, tz) {
  const p = parts(ms, validTimeZone(tz) ? tz : DEFAULT_TZ);
  return p.year + '-' + pad(p.month) + '-' + pad(p.day);
}
function ymdUtc(t) { const d = new Date(t); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
function utcOf(ymd) { const a = String(ymd).split('-').map(Number); return Date.UTC(a[0], a[1] - 1, a[2]); }
/** The Monday on or before a 'YYYY-MM-DD'. */
function mondayOf(ymd) {
  const t = utcOf(ymd);
  return ymdUtc(t - ((new Date(t).getUTCDay() + 6) % 7) * DAY);
}
/** The zone's offset from UTC at an instant, in ms (local wall clock minus UTC). */
function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/**
 * The first instant of a local calendar day. Local midnight, found from the
 * offset (twice, so a switch between the guess and midnight settles); where a
 * zone skips midnight (Santiago, a few others) the day starts at its first
 * real instant, found by stepping in 15-minute steps.
 */
function dayStartMs(ymd, tz) {
  const zone = validTimeZone(tz) ? tz : DEFAULT_TZ;
  const wall = utcOf(ymd);
  let t = wall - offsetMs(wall, zone);
  t = wall - offsetMs(t, zone);
  for (let i = 0; i < 12 && ymdInZone(t, zone) < ymd; i++) t += 15 * 60000;
  while (ymdInZone(t - 15 * 60000, zone) === ymd) t -= 15 * 60000;
  return t;
}
/** Today's and this week's window for a company at nowMs. */
function bounds(nowMs, tz) {
  const zone = validTimeZone(tz) ? tz : DEFAULT_TZ;
  const dayKey = ymdInZone(nowMs, zone);
  const weekKey = mondayOf(dayKey);
  return { tz: zone, dayKey, weekKey, dayStartMs: dayStartMs(dayKey, zone), weekStartMs: dayStartMs(weekKey, zone), nowMs };
}

function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; }
  return 0;
}
/** The sale date (numbers-logic.js saleDateMs): closedAt, else the first move into a sale stage. */
function saleDateMs(rec) {
  const c = toMs(rec && rec.closedAt);
  if (c) return c;
  const hist = rec && Array.isArray(rec.stageHistory) ? rec.stageHistory : [];
  for (const h of hist) {
    if (h && SALE_KEYS.has(stageRoles.canonicalStageKey(h.to))) { const t = toMs(h.timestamp || h.at); if (t) return t; }
  }
  return 0;
}

const zero = () => ({ doors: 0, appts: 0, estimates: 0, deals: 0 });
/**
 * { [uid]: { name, today:{doors,appts,estimates,deals}, week:{…} } } for these members.
 * inp: { members:[{uid,name}], knocks, leads, jobsByLead (null = not read), bounds }
 */
function memberRows(inp) {
  const b = inp.bounds;
  const out = {};
  (inp.members || []).forEach((m) => { if (m && m.uid) out[m.uid] = { name: m.name || '', today: zero(), week: zero() }; });
  const inWeek = (t) => t >= b.weekStartMs;
  const inDay = (t) => t >= b.dayStartMs;
  (inp.knocks || []).forEach((k) => {
    const r = k && out[k.userId];
    const t = toMs(k && k.createdAt);
    if (!r || !t || !inWeek(t)) return;
    const appt = k.disposition === 'appointment';
    r.week.doors++; if (appt) r.week.appts++;
    if (inDay(t)) { r.today.doors++; if (appt) r.today.appts++; }
  });
  const leads = (inp.leads || []).filter((l) => l && !l.deleted);
  // estimates: each lead once per window, to whoever moved it
  leads.forEach((l) => {
    const seenWeek = {}, seenDay = {};
    (Array.isArray(l.stageHistory) ? l.stageHistory : []).forEach((h) => {
      if (!h || !ESTIMATE_SENT.has(stageRoles.canonicalStageKey(h.to))) return;
      const r = out[h.by];
      const t = toMs(h.timestamp || h.at);
      if (!r || !t || !inWeek(t)) return;
      if (!seenWeek[h.by]) { seenWeek[h.by] = 1; r.week.estimates++; }
      if (inDay(t) && !seenDay[h.by]) { seenDay[h.by] = 1; r.today.estimates++; }
    });
  });
  // deals: every job of the member's customers, dated by its sale date
  jobsLogic.jobRecords(leads, inp.jobsByLead || null).forEach((rec) => {
    const r = rec && out[rec.userId];
    if (!r || !stageRoles.isSale(rec)) return;
    const t = saleDateMs(rec);
    if (!t || !inWeek(t)) return;
    r.week.deals++;
    if (inDay(t)) r.today.deals++;
  });
  return out;
}

function cleanName(n) { return String(n == null ? '' : n).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, NAME_MAX); }
/** The leaderboard/{uid} document. */
function rowDoc(a) {
  return {
    companyId: String(a.companyId), uid: String(a.uid), name: cleanName(a.name || (a.metrics && a.metrics.name)),
    tz: a.zone.tz, tzSet: !!a.zone.set, dayKey: a.bounds.dayKey, weekKey: a.bounds.weekKey,
    today: Object.assign(zero(), a.metrics.today), week: Object.assign(zero(), a.metrics.week), asOfMs: a.nowMs,
  };
}
/** Same row apart from when it was computed (the run logs how many rows' numbers did not change). */
function sameRow(a, b) {
  if (!a || !b) return false;
  const k = ['companyId', 'uid', 'name', 'tz', 'tzSet', 'dayKey', 'weekKey', 'today', 'week'];
  return k.every((f) => JSON.stringify(a[f]) === JSON.stringify(b[f]))
    && Object.keys(b).every((f) => f === 'asOfMs' || f === 'updatedAt' || k.indexOf(f) !== -1);
}

module.exports = { DEFAULT_TZ, ESTIMATE_SENT, validTimeZone, companyZone, ymdInZone, mondayOf, dayStartMs, bounds, toMs, saleDateMs, memberRows, rowDoc, sameRow };
