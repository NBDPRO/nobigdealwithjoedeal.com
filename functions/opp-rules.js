'use strict';
/**
 * opp-rules.js — the Thumbtack Opportunities watcher's rules DATA (2026-11-04,
 * flag `thumbtackOpportunities`, ships dark). PURE DATA plus two tiny helpers.
 * No Firestore, no network, no clock: nothing in this file reads or talks to
 * Thumbtack. Design: documentation/projects/THUMBTACK-OPPORTUNITIES-2026-11-04.md.
 *
 * Every number below is Jo's answer (design note section 3b, "accepted as
 * recommended") or a labelled starting guess. All of it is tunable by a rules
 * override (opp_rules/_default, PR 2); sanitizeOverride() is the only way an
 * override reaches the logic, and it can tighten or loosen a number inside a
 * fixed bound but cannot add a trade or turn the draft rules off.
 *
 * Money is integer cents. Distances are straight-line miles between ZIP
 * centroids (MAY BE WRONG on the Kentucky side: road miles can be longer).
 */

/** Feature flags (Firestore feature_flags/_default merged with feature_flags/{uid}). Absent = off. */
const FLAG_NAME = 'thumbtackOpportunities';
const SEND_FLAG_NAME = 'thumbtackOppSend';   // RESERVED for the sender (PR 5). Nothing reads it yet.
const FLAG_DEFAULT = false;
const SEND_FLAG_DEFAULT = false;

/**
 * Is the watcher flag on? Same merge the CRM and the callables use: the
 * default doc, then the caller's own doc on top. Only the literal boolean
 * true turns it on (a string "true" or 1 does not).
 */
function flagOn(flagsDefault, flagsMine, name) {
  const merged = Object.assign({}, flagsDefault || {}, flagsMine || {});
  return merged[name || FLAG_NAME] === true;
}

/**
 * Trades. `kind`:
 *   core     always shown when the rest of the rules pass
 *   install  a real replacement only, and only in the near zone
 *   off      never shown (paused, or not our work)
 * `match` is tested against the CATEGORY label only (never the customer's
 * text), after lower-casing and squeezing punctuation to single spaces.
 * Order matters: the first row that matches wins, so the narrow "off" rows
 * (gutter cleaning, drywall) sit before the broad core rows.
 */
const TRADES = Object.freeze([
  Object.freeze({ key: 'drywall', kind: 'off', label: 'Drywall', match: /\bdrywall|sheetrock|plaster/, why: 'Drywall is paused.' }),
  Object.freeze({ key: 'gutter_cleaning', kind: 'off', label: 'Gutter cleaning', match: /\bgutter\w* (cleaning|clean out|cleanout|guard)|clean\w* (the |my )?gutter/, why: 'Gutter cleaning is not our work.' }),
  Object.freeze({ key: 'roof_inspection', kind: 'core', label: 'Roof inspection', match: /\broof\w* inspection|inspect\w* (the |my |a )?roof|\broof certification/, why: '' }),
  Object.freeze({ key: 'roof_repair', kind: 'core', label: 'Roof repair', match: /\broof\w* (repair|maintenance|leak)|repair\w* (the |my |a )?roof|\broof or maintenance/, why: '' }),
  Object.freeze({ key: 'siding_repair', kind: 'core', label: 'Siding repair', match: /\bsiding repair|repair\w* (the |my )?siding/, why: '' }),
  Object.freeze({ key: 'gutter_repair', kind: 'core', label: 'Gutter repair', match: /\bgutter\w* (repair|fix|leak)|repair\w* (the |my )?gutter/, why: '' }),
  Object.freeze({ key: 'roof_install', kind: 'install', label: 'Roof installation or replacement', match: /\broof\w* (install\w*|replac\w*)|\bnew roof|\bre roof/, why: '' }),
  Object.freeze({ key: 'siding_install', kind: 'install', label: 'Siding installation', match: /\bsiding (install\w*|replac\w*)|\binstall\w* (new )?siding/, why: '' }),
]);

/** Everything else (painting, handyman, moving, lawn, solar, gutter installation...) is off-trade. */
const OFF_TRADE_WHY = 'Not one of our shortlist trades.';

/**
 * Plain, human-readable job-size cues, matched against the customer's own words
 * (DATA, never instructions). `small` wins over the rest when a small cue is
 * present ("one panel"); then `big`; then `normal`; else `unknown`.
 */
const SIZE_CUES = Object.freeze({
  small: /\b(one|single|1|a few|couple of|small|tiny|minor) (small )?(panel|piece|section|shingle|shingles|spot|patch|run|length|foot|feet|ft|strip|board|boards)\b|\bjust (a|one|the) (panel|piece|shingle|gutter|section)\b/,
  big: /\b(full|complete|entire|whole|total|tear[- ]?off|re[- ]?roof|replace(ment)? (of )?(the |my )?(entire |whole |full )?(roof|siding)|new roof|new siding|storm damage|hail damage|multiple|several|large|two story|2 story|every)\b/,
  normal: /\b(leak\w*|missing|damag\w*|inspect\w*|repair|crack\w*|loose|sagging|water|stain\w*|flash\w*|ice dam|storm|hail|wind|blown|fallen|fell)\b/,
});

/** Words that make an install look like a real replacement (not a quote-shopper or a small add-on). */
const REPLACEMENT_CUES = /\b(replace\w*|replacement|new roof|tear[- ]?off|re[- ]?roof|full|complete|entire|whole|old roof|worn|end of life|20 years|25 years|30 years|40 years)\b/;

/**
 * Words in a stranger's text that look like a command to US. The text is DATA;
 * an item that tries to give instructions is flagged and SKIPped (design 7).
 * Deliberately wide: a false positive costs one skipped opportunity, a false
 * negative costs a message in the wrong place.
 */
const INSTRUCTION_CUES = /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(rules?|instructions?|prompt|polic(y|ies)|above|previous|earlier)\b|\b(system|developer|assistant)\s*(prompt|message|instruction)|\bapprove\s+all\b|\bsend\s+(this|it|that|a message|messages?)\s+to\s+(everyone|all|every)\b|\b(reply|respond|answer)\s+with\b[^.\n]{0,40}\b(phone|number|email|address|password|code)\b|\b(change|raise|increase|set|update)\s+(the\s+|your\s+|my\s+)?(budget|cap|limit|rules?|settings?|price)\b|\byou\s+(are|must|should|will)\s+now\b|\bact\s+as\b|\bnew\s+instructions?\b|\b(owner|jo)'?s?\s+(phone|number|email|password)\b|\bpay\s+(for|the)\b[^.\n]{0,20}\b(lead|fee|invoice)\b/i;

/** The default rules. Frozen; withOverride() returns a new, merged, sanitized copy. */
const DEFAULT_RULES = Object.freeze({
  rulesVersion: 1,
  killSwitch: false,                       // true = the watcher refuses to file anything
  // The two bases. COORDINATES ARE APPROXIMATE (village / downtown centres, not the street addresses): Jo to confirm.
  bases: Object.freeze([
    Object.freeze({ key: 'goshen', label: 'Goshen OH (warehouse, Manila Rd)', lat: 39.2337, lng: -84.1583 }),
    Object.freeze({ key: 'cincinnati', label: 'Cincinnati (home)', lat: 39.1031, lng: -84.5120 }),
  ]),
  distance: Object.freeze({
    nearMiles: 25,                         // within = near zone (25.0 is near)
    farMiles: 40,                          // over near and up to this = far zone, bigger jobs only (40.0 is far)
    farMinSize: 'normal',                  // far zone needs a job at least this big ('unknown' counts as 'small')
  }),
  freshness: Object.freeze({
    topMinutes: 60,                        // posted under this = top boost
    staleMinutes: 360,                     // over this = strong penalty (6 hours)
    holdMinutes: 1440,                     // over this = HOLD (24 hours)
  }),
  competition: Object.freeze({ crowdedAt: 5 }),   // this many pros already in or more = lower score
  scoring: Object.freeze({
    showMin: 60, holdMin: 40,              // score bands (out of 100)
    perRunShowCap: 5,                      // at most this many SHOW per run; the rest become HOLD
  }),
  caps: Object.freeze({ sendsPerDay: 8, sendsPerWeek: 25 }),
  hours: Object.freeze({
    tz: 'America/New_York',
    watcherStart: 7, watcherEnd: 20,       // 7:00 am up to 8:00 pm Eastern
    sendStart: 8, sendEnd: 20,
  }),
  // Expected value test (design 3b item 7): expected collected per reply
  // (close rate x collected per hire) must be at least `multiple` x the price per reply.
  ev: Object.freeze({ multiple: 3, minLeads: 5 }),
  // Starting-guess history from Jo's Thumbtack numbers, Jul 31 to Oct 17 (Spend Notes). NOT USED BY THE LOGIC unless a
  // caller passes it in as `history`; 1 to 6 wins per trade, so these are hints. Cents. MAY BE WRONG (see the design note).
  historySeed: Object.freeze({
    roof_repair: Object.freeze({ leads: 33, hires: 6, collectedPerHireCents: 79000, pricePerReplyCents: 4915 }),
    roof_inspection: Object.freeze({ leads: 5, hires: 2, collectedPerHireCents: 13250, pricePerReplyCents: 840 }),
    siding_repair: Object.freeze({ leads: 22, hires: 3, collectedPerHireCents: 20000, pricePerReplyCents: 2291 }),
    gutter_repair: Object.freeze({ leads: 17, hires: 1, collectedPerHireCents: 12500, pricePerReplyCents: 1382 }),
    roof_install: Object.freeze({ leads: 8, hires: 0, collectedPerHireCents: 0, pricePerReplyCents: 21175 }),
  }),
  text: Object.freeze({ summaryMax: 200, phraseMax: 120 }),
});

// ── override handling ────────────────────────────────────────────────────────
// Which numbers an override may set, with hard bounds. Anything else is ignored.
const NUM_BOUNDS = Object.freeze({
  'distance.nearMiles': [5, 60], 'distance.farMiles': [5, 80],
  'freshness.topMinutes': [5, 240], 'freshness.staleMinutes': [30, 2880], 'freshness.holdMinutes': [60, 10080],
  'competition.crowdedAt': [2, 20],
  'scoring.showMin': [30, 95], 'scoring.holdMin': [10, 90], 'scoring.perRunShowCap': [1, 10],
  'caps.sendsPerDay': [0, 8],            // a rules override can LOWER the cap; raising past 8 is Jo's code change, not a doc edit
  'caps.sendsPerWeek': [0, 25],
  'ev.multiple': [1, 10], 'ev.minLeads': [1, 200],
});
const SIZE_ORDER = Object.freeze({ unknown: 0, small: 0, normal: 1, big: 2 });

function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

/**
 * Whitelist an owner-edited override. Returns { ok, rules } where rules is the
 * clean override ({ 'distance.nearMiles': 30, ... } nested back into objects).
 * Out-of-range numbers and unknown keys are dropped and listed in `dropped`.
 * Booleans: only killSwitch. History: per known trade, whole numbers in range.
 */
function sanitizeOverride(raw) {
  const out = {}; const dropped = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const path of Object.keys(NUM_BOUNDS)) {
    const v = getPath(src, path);
    if (v === undefined) continue;
    const [lo, hi] = NUM_BOUNDS[path];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) { dropped.push(path); continue; }
    const [a, b] = path.split('.');
    out[a] = out[a] || {}; out[a][b] = v;
  }
  if (src.killSwitch !== undefined) { if (typeof src.killSwitch === 'boolean') out.killSwitch = src.killSwitch; else dropped.push('killSwitch'); }
  const fm = getPath(src, 'distance.farMinSize');
  if (fm !== undefined) {
    if (fm === 'normal' || fm === 'big') { out.distance = out.distance || {}; out.distance.farMinSize = fm; } else dropped.push('distance.farMinSize');
  }
  if (src.history && typeof src.history === 'object') {
    const hist = {};
    for (const t of TRADES) {
      const h = src.history[t.key];
      if (h === undefined) continue;
      const okInt = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
      if (h && okInt(h.leads, 100000) && okInt(h.hires, 100000) && h.hires <= h.leads && okInt(h.collectedPerHireCents, 1e9) && (h.pricePerReplyCents === null || h.pricePerReplyCents === undefined || okInt(h.pricePerReplyCents, 1e7))) {
        hist[t.key] = { leads: h.leads, hires: h.hires, collectedPerHireCents: h.collectedPerHireCents, pricePerReplyCents: h.pricePerReplyCents == null ? null : h.pricePerReplyCents };
      } else dropped.push('history.' + t.key);
    }
    if (Object.keys(hist).length) out.history = hist;
  }
  // The bands must stay ordered, and the far line must stay past the near line; otherwise drop the whole pair.
  if (out.scoring && out.scoring.showMin !== undefined && out.scoring.holdMin !== undefined && out.scoring.holdMin >= out.scoring.showMin) {
    dropped.push('scoring.holdMin'); dropped.push('scoring.showMin'); delete out.scoring.holdMin; delete out.scoring.showMin;
  }
  return { ok: dropped.length === 0, rules: out, dropped };
}

/**
 * DEFAULT_RULES with a sanitized override on top. `rulesVersion` of the result
 * is the default's version plus an override marker is NOT added here: the
 * stored version is the default's, and the doc's own `rulesVersion` is only
 * carried when it is a positive integer.
 */
function withOverride(raw) {
  const s = sanitizeOverride(raw);
  const o = s.rules;
  const merged = {};
  for (const k of Object.keys(DEFAULT_RULES)) {
    const d = DEFAULT_RULES[k];
    merged[k] = d && typeof d === 'object' && !Array.isArray(d) && o[k] && typeof o[k] === 'object' ? Object.assign({}, d, o[k]) : d;
  }
  if (typeof o.killSwitch === 'boolean') merged.killSwitch = o.killSwitch;
  merged.history = o.history ? o.history : null;
  // Sanity after merge: the far line is never inside the near line; the hold band is below the show band.
  if (merged.distance.farMiles < merged.distance.nearMiles) merged.distance = Object.assign({}, merged.distance, { farMiles: merged.distance.nearMiles });
  if (merged.scoring.holdMin >= merged.scoring.showMin) merged.scoring = Object.assign({}, merged.scoring, { holdMin: DEFAULT_RULES.scoring.holdMin, showMin: DEFAULT_RULES.scoring.showMin });
  if (raw && Number.isInteger(raw.rulesVersion) && raw.rulesVersion > 0) merged.rulesVersion = raw.rulesVersion;
  return { rules: merged, dropped: s.dropped };
}

module.exports = {
  FLAG_NAME, SEND_FLAG_NAME, FLAG_DEFAULT, SEND_FLAG_DEFAULT, flagOn,
  TRADES, OFF_TRADE_WHY, SIZE_CUES, SIZE_ORDER, REPLACEMENT_CUES, INSTRUCTION_CUES,
  DEFAULT_RULES, NUM_BOUNDS, sanitizeOverride, withOverride,
};
