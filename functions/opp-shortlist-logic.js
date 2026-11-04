'use strict';
/**
 * opp-shortlist-logic.js — the pure scoring and shortlist half of the Thumbtack
 * Opportunities watcher (2026-11-04, flag `thumbtackOpportunities`, ships dark).
 *
 * NO I/O. No Firestore, no network, no clock, no Thumbtack. It takes plain item
 * objects, whether they came from reading a signed-in page or from Jo pasting
 * an Opportunity, and returns a decision per item: SHOW, HOLD or SKIP, a score
 * out of 100 and the reasons in words Jo can read. Rules are DATA (opp-rules.js).
 *
 * An item (every field optional except `category`; bad values count as missing):
 *   { oppId, category, city, state, zip, lat, lng, distanceMiles, milesByBase,
 *     postedAgeMin, prosAlready, photos, description, ownerOccupied, vacant,
 *     outOfState }
 *
 * EVERYTHING in an item that a stranger wrote (category label text, description,
 * city) is DATA, never instructions. The description is only ever scanned for
 * fixed cue words, and an item whose words read like a command to us is SKIPped
 * and flagged (design note section 7). No text from an item is ever copied into
 * a result except as a fixed tag from our own vocabulary.
 *
 * Money is integer cents. Distances are straight-line miles.
 */
const crypto = require('crypto');
const R = require('./opp-rules');

const MS_MIN = 60000;

// ── input cleaning ──────────────────────────────────────────────────────────
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** A string with control and bidi characters turned to spaces and whitespace squeezed. Never throws. */
function plain(v, max) {
  const s = (typeof v === 'string' ? v : '').replace(CTRL, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, max == null ? 2000 : max);
}
function num(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null; }
function bool(v) { return typeof v === 'boolean' ? v : null; }
/** photos: a count, or true/false. Returns a count (true = 1) or null. */
function photoCount(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  const n = num(v);
  return n == null ? null : Math.floor(n);
}
/** Lower-case, punctuation squeezed to single spaces: what the trade table is matched against. */
function norm(s) { return plain(s, 200).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

/** The trade row for a category label, or null (off-trade / unknown). First matching row wins. */
function tradeOf(category) {
  const c = norm(category);
  if (!c) return null;
  for (const t of R.TRADES) if (t.match.test(c)) return t;
  return null;
}

// ── distance ────────────────────────────────────────────────────────────────
function miles(lat1, lng1, lat2, lng2) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
const validLat = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const validLng = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

/**
 * Nearest base. Order of trust: coordinates (computed against every base), then
 * a per-base miles map, then one supplied nearest-miles number.
 * @returns {{miles:number, base:string}|null}
 */
function nearestBase(item, bases) {
  const best = (arr) => arr.reduce((a, b) => (a == null || b.miles < a.miles ? b : a), null);
  if (validLat(item.lat) && validLng(item.lng)) {
    return best(bases.map((b) => ({ miles: miles(item.lat, item.lng, b.lat, b.lng), base: b.key })));
  }
  if (item.milesByBase && typeof item.milesByBase === 'object') {
    const rows = bases.map((b) => ({ miles: num(item.milesByBase[b.key]), base: b.key })).filter((r) => r.miles != null);
    if (rows.length) return best(rows);
  }
  const d = num(item.distanceMiles);
  return d == null ? null : { miles: d, base: 'supplied' };
}

// ── words: size, replacement, instruction-shaped text, tags ─────────────────
function lowerText(s) { return plain(s, 4000).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

/** 'small' | 'big' | 'normal' | 'unknown' from the customer's words. A small cue wins ("one panel"). */
function jobSize(description) {
  const t = lowerText(description);
  if (!t) return 'unknown';
  if (R.SIZE_CUES.small.test(t)) return 'small';
  if (R.SIZE_CUES.big.test(t)) return 'big';
  if (R.SIZE_CUES.normal.test(t)) return 'normal';
  return 'unknown';
}
/** Does an install request read like a real replacement? (description only: the category label always says "replacement".) */
function looksLikeReplacement(description) {
  return R.REPLACEMENT_CUES.test(lowerText(description));
}
/** Does the text read like an instruction to us? (checked on the raw description and the category label) */
function looksLikeInstruction(text) {
  const raw = plain(text, 4000);
  return R.INSTRUCTION_CUES.test(raw) || R.INSTRUCTION_CUES.test(lowerText(raw));
}

// The only words that ever leave an item's description into a result: our own tags.
const TAG_CUES = Object.freeze([
  ['leak', /\bleak\w*|\bdrip\w*|\bwater (stain|damage|coming)/],
  ['missing shingles', /\bmissing (shingles?|tiles?)|\bshingles? (missing|blown|fell|fallen|off)/],
  ['storm damage', /\bstorm|\bhail|\bwind (damage|storm)|\bblown off/],
  ['flashing', /\bflash\w*|\bchimney|\bvent boot|\bpipe boot/],
  ['sagging', /\bsag\w*/],
  ['inspection', /\binspect\w*|\bcertif\w*|\bcheck (the |my )?roof/],
  ['replacement', /\breplac\w*|\bnew roof|\btear[- ]?off|\bre[- ]?roof/],
  ['gutter', /\bgutters?|\bdownspouts?|\bfascia|\bsoffit/],
  ['siding', /\bsiding|\bclapboard|\bvinyl/],
  ['photos mentioned', /\bphotos?|\bpictures?|\bpics?/],
]);
/** Fixed tags found in the words; never the words themselves (no names or numbers can ride along). */
function problemTags(description) {
  const t = lowerText(description);
  return TAG_CUES.filter(([, re]) => re.test(t)).map(([tag]) => tag);
}

// ── ids ─────────────────────────────────────────────────────────────────────
const OPP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
function safeOppId(v) { return typeof v === 'string' && OPP_ID_RE.test(v) ? v : null; }
/**
 * Thumbtack's id when the page shows one, else a short hash of category + place +
 * the posted time rounded to 30 minutes. MAY BE WRONG: a posted time that
 * straddles a half-hour edge between two scans gives two ids for one item.
 */
function oppIdFor(item, firstSeenMs) {
  const given = safeOppId(item && item.oppId);
  if (given) return given;
  const age = num(item && item.postedAgeMin);
  const posted = Math.floor(((Number(firstSeenMs) || 0) - (age == null ? 0 : age) * MS_MIN) / (30 * MS_MIN));
  const key = [norm(item && item.category), norm(item && (item.zip || item.city)), posted].join('|');
  return 'h' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 20);
}
/** opp_seen/{companyId}_{oppId}: the doc id. Null when either part is unsafe. */
function docIdFor(companyId, oppId) {
  return safeOppId(companyId) && safeOppId(oppId) ? companyId + '_' + oppId : null;
}

// ── expected value ──────────────────────────────────────────────────────────
/**
 * The expected-value test (design 3b item 7). From SUPPLIED history numbers:
 *   expected collected per reply = (hires / leads) x collected per hire
 *   shown only if expected >= multiple x price per reply.
 * Not applied (pass = null) when there is no history for the trade, fewer than
 * minLeads leads, or no price per reply: the caller learns why in `note`.
 * Integer maths: hires x collected >= multiple x price x leads.
 */
function expectedValue(tradeKey, history, rules) {
  const h = history && history[tradeKey];
  const ev = rules.ev;
  if (!h || typeof h !== 'object') return { applies: false, pass: null, note: 'No history supplied for this trade, so the expected-value test was not applied.' };
  const leads = num(h.leads), hires = num(h.hires), per = num(h.collectedPerHireCents), price = num(h.pricePerReplyCents);
  if (leads == null || leads < ev.minLeads) return { applies: false, pass: null, note: 'Fewer than ' + ev.minLeads + ' leads of history, so the expected-value test was not applied.' };
  if (hires == null || hires > leads || per == null) return { applies: false, pass: null, note: 'History for this trade is incomplete, so the expected-value test was not applied.' };
  if (price == null || price <= 0) return { applies: false, pass: null, note: 'Price per reply is not known yet, so the expected-value test was not applied.' };
  const expectedCents = Math.round((hires * per) / leads);
  const pass = hires * per >= ev.multiple * price * leads;
  return {
    applies: true, pass, closeRatePct: Math.round((hires / leads) * 1000) / 10, expectedCents, priceCents: price,
    ratio: Math.round((expectedCents / price) * 100) / 100, multiple: ev.multiple, n: leads,
    note: 'Expected ' + cents(expectedCents) + ' per reply vs ' + cents(price) + ' price (need ' + ev.multiple + 'x), n=' + leads + '.',
  };
}
function cents(c) { return '$' + (Math.round(c) / 100).toFixed(2); }

// ── scoring pieces (all pure, all tested at their boundaries) ───────────────
const TRADE_POINTS = Object.freeze({ roof_repair: 15, roof_inspection: 15, siding_repair: 11, gutter_repair: 8, roof_install: 12, siding_install: 10 });
const SIZE_POINTS = Object.freeze({ big: 20, normal: 14, unknown: 8, small: 3 });

function distancePoints(milesN, zone) { return zone === 'near' ? Math.round((20 - 8 * (milesN / 25)) * 10) / 10 : 6; }
function crowdPoints(pros, crowdedAt) {
  if (pros == null) return 7;
  if (pros < crowdedAt) return Math.max(0, 15 - 2 * pros);
  return Math.max(0, 4 - (pros - crowdedAt));
}
/** Posted under topMinutes: 25. Then 20 sliding to 10 at staleMinutes. Past that: 2. */
function freshnessPoints(ageMin, f) {
  if (ageMin == null) return 0;
  if (ageMin < f.topMinutes) return 25;
  if (ageMin <= f.staleMinutes) return Math.round((20 - 10 * ((ageMin - f.topMinutes) / (f.staleMinutes - f.topMinutes))) * 100) / 100;
  return 2;
}

/**
 * Score ONE item. Never throws; a malformed item is a SKIP or HOLD with a reason.
 * @param {object} item see the header
 * @param {{rules?:object, history?:object}} [opts] rules from opp-rules.withOverride().rules (default: the defaults);
 *        history: { roof_repair:{leads,hires,collectedPerHireCents,pricePerReplyCents}, ... } or omitted
 */
function scoreOpportunity(item, opts) {
  const o = opts || {};
  const rules = o.rules || R.withOverride({}).rules;
  const it = item && typeof item === 'object' ? item : {};
  const out = {
    oppId: safeOppId(it.oppId), tradeKey: null, tradeLabel: null, decision: 'SKIP', score: 0, reason: '', reasons: [], flags: [],
    zone: null, miles: null, baseUsed: null, size: 'unknown', ageMin: null, pros: null, photos: null, tags: [], ev: null, rulesVersion: rules.rulesVersion,
  };
  const why = (s) => { out.reasons.push(s); };
  const finish = (decision, score) => {
    out.decision = decision; out.score = Math.max(0, Math.min(100, Math.round(score * 100) / 100));
    out.reason = out.reasons.slice(0, 3).join(' ');
    return out;
  };

  const description = plain(it.description, 4000);
  const categoryRaw = plain(it.category, 200);

  // 0. Words that read like a command to us: flagged, never obeyed, never scored.
  if (looksLikeInstruction(description) || looksLikeInstruction(categoryRaw) || looksLikeInstruction(plain(it.city, 100))) {
    out.flags.push('instruction_text');
    why('The text reads like instructions to us, so it was skipped and ignored.');
    return finish('SKIP', 0);
  }

  // 1. Trade (hard filter).
  const trade = tradeOf(categoryRaw);
  if (!trade) { why(OFF_WHY(categoryRaw)); return finish('SKIP', 0); }
  out.tradeKey = trade.key; out.tradeLabel = trade.label;
  if (trade.kind === 'off') { why(trade.why); return finish('SKIP', 0); }

  const size = jobSize(description);
  out.size = size;
  out.tags = problemTags(description);
  const pros = num(it.prosAlready), age = num(it.postedAgeMin), photos = photoCount(it.photos);
  out.pros = pros == null ? null : Math.floor(pros); out.ageMin = age == null ? null : Math.floor(age); out.photos = photos;
  if (it.vacant === true) out.flags.push('vacant');
  if (it.outOfState === true) out.flags.push('out_of_state_owner');
  if (it.ownerOccupied === false) out.flags.push('not_owner_occupied');

  // 2. Distance from the nearer base.
  const near = nearestBase(it, rules.bases);
  const d = rules.distance;
  let zone = null;
  if (near) {
    out.miles = Math.round(near.miles * 10) / 10; out.baseUsed = near.base;
    zone = near.miles <= d.nearMiles ? 'near' : (near.miles <= d.farMiles ? 'far' : 'out');
    out.zone = zone;
  }
  if (zone === 'out') { why('Too far: ' + out.miles + ' miles from the nearer base (limit ' + d.farMiles + ').'); return finish('SKIP', 0); }

  // 3. Installs: a real replacement, owner-occupied, in the near zone only.
  if (trade.kind === 'install') {
    if (!looksLikeReplacement(description)) { why('An install request that does not read like a real replacement.'); return finish('SKIP', 0); }
    if (it.ownerOccupied === false) { why('A replacement on a property that is not owner-occupied.'); return finish('SKIP', 0); }
    if (zone === 'far') { why('Replacements only in the near zone (' + out.miles + ' miles).'); return finish('SKIP', 0); }
  }
  // 4. Far zone: only a job bigger than a small repair.
  if (zone === 'far' && R.SIZE_ORDER[size] < R.SIZE_ORDER[d.farMinSize]) {
    why('Far zone (' + out.miles + ' miles) and the job does not look big enough.'); return finish('SKIP', 0);
  }

  // 5. Score.
  let score = 0;
  const parts = {};
  parts.trade = TRADE_POINTS[trade.key] || 8;
  parts.distance = zone ? distancePoints(near.miles, zone) : 0;
  parts.size = SIZE_POINTS[size];
  parts.competition = crowdPoints(out.pros, rules.competition.crowdedAt);
  parts.freshness = freshnessPoints(out.ageMin, rules.freshness);
  parts.photos = photos != null && photos > 0 ? 3 : 0;
  parts.place = /^\d{5}$/.test(plain(it.zip, 10)) || plain(it.city, 80) ? 2 : 0;
  for (const k of Object.keys(parts)) score += parts[k];
  out.parts = parts;

  // 6. Reasons in plain words.
  why(trade.label + '.');
  if (zone === 'near') why(out.miles + ' miles from ' + baseLabel(rules, near.base) + '.');
  else if (zone === 'far') why('Far zone: ' + out.miles + ' miles, job looks ' + size + '.');
  else why('No distance given.');
  if (out.pros == null) why('Number of pros already in not given.');
  else if (out.pros >= rules.competition.crowdedAt) why(out.pros + ' pros already in: crowded.');
  else why(out.pros + (out.pros === 1 ? ' pro' : ' pros') + ' already in.');
  if (out.ageMin == null) why('Posted time not given.');
  else if (out.ageMin < rules.freshness.topMinutes) why('Posted ' + out.ageMin + ' min ago: fresh.');
  else if (out.ageMin > rules.freshness.holdMinutes) why('Posted over 24 hours ago.');
  else if (out.ageMin > rules.freshness.staleMinutes) why('Posted over ' + Math.round(rules.freshness.staleMinutes / 60) + ' hours ago: stale.');
  else why('Posted ' + out.ageMin + ' min ago.');
  if (photos === 0) why('No photos.');

  // 7. Expected-value test on supplied history.
  const history = o.history || rules.history || null;
  out.ev = expectedValue(trade.key, history, rules);

  // 8. Decision: bands first, then the things that can only hold a SHOW back.
  let decision = score >= rules.scoring.showMin ? 'SHOW' : (score >= rules.scoring.holdMin ? 'HOLD' : 'SKIP');
  const lead = (s) => { out.reasons.unshift(s); };   // the reason that decided it goes first
  const hold = (reason) => { if (decision === 'SHOW') decision = 'HOLD'; lead(reason); };
  if (zone === null) hold('Held: no distance to check.');
  if (out.ageMin == null) hold('Held: posted time unknown.');
  else if (out.ageMin > rules.freshness.holdMinutes) { if (decision !== 'SKIP') decision = 'HOLD'; lead('Held: older than 24 hours, check it is still open.'); }
  if (out.ev && out.ev.pass === false) hold('Held: ' + out.ev.note);
  if (decision === 'SKIP') lead('Score ' + score + ' is below the ' + rules.scoring.holdMin + ' line.');
  return finish(decision, score);
}
function OFF_WHY(cat) { return cat ? R.OFF_TRADE_WHY : 'No category given.'; }
function baseLabel(rules, key) { const b = rules.bases.filter((x) => x.key === key)[0]; return b ? b.label : 'the nearest base'; }

/**
 * Score a batch and apply the per-run cap: best score first, at most
 * rules.scoring.perRunShowCap SHOW, the rest become HOLD with a reason.
 * Order is stable (score desc, then fresher, then input order).
 * @returns {{results:object[], counts:{SHOW:number,HOLD:number,SKIP:number}}}
 */
function shortlist(items, opts) {
  const o = opts || {};
  const rules = o.rules || R.withOverride({}).rules;
  const list = Array.isArray(items) ? items.slice(0, 200) : [];
  const scored = list.map((it, i) => ({ r: Object.assign(scoreOpportunity(it, o), { index: i }), i }));   // index = where the item sat in the input
  scored.sort((a, b) => (b.r.score - a.r.score) || ((a.r.ageMin == null ? 1e9 : a.r.ageMin) - (b.r.ageMin == null ? 1e9 : b.r.ageMin)) || (a.i - b.i));
  let shown = 0;
  for (const s of scored) {
    if (s.r.decision !== 'SHOW') continue;
    if (shown >= rules.scoring.perRunShowCap) {
      s.r.decision = 'HOLD'; s.r.reasons.unshift('Held: over the ' + rules.scoring.perRunShowCap + ' per run limit.'); s.r.reason = s.r.reasons.slice(0, 3).join(' ');
    } else shown++;
  }
  const counts = { SHOW: 0, HOLD: 0, SKIP: 0 };
  for (const s of scored) counts[s.r.decision]++;
  return { results: scored.map((s) => s.r), counts };
}

// ── hours and caps (pure; the approve and send steps are later PRs) ─────────
/** Hour of day (0-23) at `nowMs` in the IANA zone. */
function hourIn(nowMs, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(nowMs));
  const h = parts.filter((p) => p.type === 'hour')[0];
  return h ? Number(h.value) % 24 : 0;
}
/** start <= hour < end. 8 pm end means 7:59 pm is in and 8:00 pm is out. */
function withinHours(nowMs, startHour, endHour, tz) { const h = hourIn(nowMs, tz); return h >= startHour && h < endHour; }
const inWatcherHours = (nowMs, rules) => withinHours(nowMs, rules.hours.watcherStart, rules.hours.watcherEnd, rules.hours.tz);
const inSendHours = (nowMs, rules) => withinHours(nowMs, rules.hours.sendStart, rules.hours.sendEnd, rules.hours.tz);
/** Can one more approved send go out? Counts are what was already sent today and this week. */
function capStatus(counts, rules) {
  const c = counts || {};
  const day = num(c.sentToday), week = num(c.sentThisWeek);
  if (day == null || week == null) return { allowed: false, reason: 'Counts unknown: fail closed.' };
  if (day >= rules.caps.sendsPerDay) return { allowed: false, reason: 'Daily cap of ' + rules.caps.sendsPerDay + ' reached.' };
  if (week >= rules.caps.sendsPerWeek) return { allowed: false, reason: 'Weekly cap of ' + rules.caps.sendsPerWeek + ' reached.' };
  return { allowed: true, reason: '' };
}

module.exports = {
  plain, norm, tradeOf, miles, nearestBase, jobSize, looksLikeReplacement, looksLikeInstruction, problemTags,
  safeOppId, oppIdFor, docIdFor, expectedValue, distancePoints, crowdPoints, freshnessPoints, TRADE_POINTS, SIZE_POINTS,
  scoreOpportunity, shortlist, hourIn, withinHours, inWatcherHours, inSendHours, capStatus,
};
