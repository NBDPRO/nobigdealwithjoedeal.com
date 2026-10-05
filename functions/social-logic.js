/**
 * functions/social-logic.js — the pure half of Social Studio (2026-10-04).
 *
 * Social Studio is the CRM's own social media system, built to replace
 * Metricool: drafts from finished jobs, a content calendar, bulk "Plan N
 * weeks", and a publisher that posts approved items (Facebook Page +
 * Instagram via the Meta Graph API; Google Business Profile behind a flag;
 * everything else through a "Ready to post" manual queue).
 *
 * Everything in this file is pure (no firebase imports) so the privacy and
 * Kentucky-wording guarantees unit-test without emulators:
 *
 *   - A public post never carries the customer's name, street, house number,
 *     ZIP, phone, email or GPS. The town is the finest location it names.
 *     townFromLead() refuses anything that looks like a street; cleanCaption()
 *     drops any sentence that names a private term of the source lead or
 *     looks like a street address / coordinate pair.
 *   - Every caption runs through the Kentucky claim-wording filter
 *     (social-claim-wording.js, ported from PR #2142) PLUS the social rule
 *     "nothing about deductibles" — sentences that trip a rule are dropped,
 *     never rewritten.
 *
 * Data model (companies/{companyId}/social_posts/{postId}), one doc per
 * platform:
 *   platform, kind, format, caption, hashtags[], media[{ key, role }],
 *   town, state, packageLabel, sourceLeadId (internal), groupId,
 *   status: draft → approved → scheduled → (publishing) → posted | failed,
 *           plus 'ready' (due, waiting for Jo to post by hand) and
 *           'cancelled'.
 *   scheduledAt, postedAt, postUrl, platformPostId,
 *   publish { attempts, nextAttemptAt, lastError, claimId, claimedAt }.
 */
'use strict';

const CW = require('./social-claim-wording');

// ── Platforms ───────────────────────────────────────────────────────────
// auto: the publisher can post it through an API adapter. Manual platforms
// always go to the "Ready to post" queue when due.
const PLATFORMS = Object.freeze({
  facebook:  { label: 'Facebook',  auto: true,  maxCaption: 5000, needsMedia: false },
  instagram: { label: 'Instagram', auto: true,  maxCaption: 2200, needsMedia: true, maxHashtags: 30 },
  gbp:       { label: 'Google Business', auto: true, maxCaption: 1500, needsMedia: false },
  tiktok:    { label: 'TikTok',    auto: false, maxCaption: 2200, needsMedia: true },
  nextdoor:  { label: 'Nextdoor',  auto: false, maxCaption: 3000, needsMedia: false },
  linkedin:  { label: 'LinkedIn',  auto: false, maxCaption: 3000, needsMedia: false },
  x:         { label: 'X',         auto: false, maxCaption: 280,  needsMedia: false },
});
const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORMS));

const KINDS = Object.freeze({
  job_showcase:  'Job showcase',
  tip:           'Roof tip',
  storm_psa:     'Storm-season PSA',
  review:        'Customer review',
  behind_scenes: 'Behind the scenes',
});

const STATUSES = Object.freeze(['draft', 'approved', 'scheduled', 'publishing', 'ready', 'posted', 'failed', 'cancelled']);

// Retry policy for API publishing.
const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 5 * 60 * 1000;     // 5 min, doubling
const BACKOFF_CAP_MS = 6 * 60 * 60 * 1000; // 6 h
// A claim older than this with status still 'publishing' means the run died
// mid-publish: the outcome is UNKNOWN (the platform may have posted), so the
// item fails and Jo is told to look before re-approving — never auto-retried.
const STALE_CLAIM_MS = 15 * 60 * 1000;

function backoffMs(attempt) {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, n - 1));
}

// ── Location: the town, never finer ─────────────────────────────────────
const STREET_WORDS = /\b(st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|blvd|boulevard|way|pike|hwy|highway|pl|place|cir|circle|ter|terrace|trl|trail|pkwy|parkway|run|loop|row|sq|square|apt|unit|suite|ste|box|po|route|rte)\b\.?/i;
const TOWN_RE = /^[A-Za-z][A-Za-z .'-]{1,38}[A-Za-z.]$/;
const STATE_RE = /^[A-Z]{2}$/;

function titleCase(s) {
  return String(s).toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ').trim();
}

/** A string is usable as a public town name only if it cannot be a street. */
function safeTown(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (!t || /\d/.test(t)) return '';
  if (!TOWN_RE.test(t)) return '';
  if (STREET_WORDS.test(t)) return '';
  return titleCase(t);
}

/**
 * Town + state for a lead: lead.city when present, else parsed out of
 * "street, Town, ST 41042". Returns { town, state } with '' for anything
 * that fails the safety check — a draft with no town is fine; a draft
 * with a street is not.
 */
function townFromLead(lead) {
  const l = lead || {};
  let town = safeTown(l.city || l.town);
  let state = String(l.state || '').trim().toUpperCase();
  if (!town && l.address) {
    const parts = String(l.address).split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 3) {
      town = safeTown(parts[parts.length - 2]);
      const m = /^([A-Za-z]{2})\b/.exec(parts[parts.length - 1]);
      if (!state && m) state = m[1].toUpperCase();
    } else if (parts.length === 2) {
      // "123 Main St, Florence KY 41042" → strip state + zip off the tail.
      const m = /^(.*?)[\s,]+([A-Za-z]{2})\s*(\d{5}(-\d{4})?)?$/.exec(parts[1]);
      if (m) { town = safeTown(m[1]); if (!state) state = m[2].toUpperCase(); }
      else town = safeTown(parts[1]);
    }
  }
  if (!STATE_RE.test(state)) state = '';
  return { town, state };
}

// ── Package / shingle (public-safe labels only) ─────────────────────────
const TIER_LABELS = { economy: 'Economy', good: 'Good', better: 'Better', best: 'Best', beyond: 'Beyond' };

function cleanLabel(s, max) {
  const t = String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /[<>{}$]/.test(t)) return '';
  return t.slice(0, max || 60);
}

function packageFromLead(lead) {
  const l = lead || {};
  const tierKey = String(l.acceptedTier || l.soldTier || l.tier || '').toLowerCase().trim();
  const tier = TIER_LABELS[tierKey] || '';
  const shingle = cleanLabel(l.shingleLine || l.shingle || l.productLine || l.soldProduct || '', 60);
  const packageLabel = tier ? tier + ' package' : '';
  return { tier, packageLabel, shingle };
}

// ── Privacy scrub ───────────────────────────────────────────────────────
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * The words that must never appear in a public post made from this lead:
 * every name part (2+ letters), the street line, the house number, the ZIP,
 * email and phone digits.
 */
function privateTerms(lead) {
  const l = lead || {};
  const terms = new Set();
  const add = (v) => { const s = String(v == null ? '' : v).trim(); if (s.length >= 2) terms.add(s); };
  const names = [l.firstName, l.lastName, l.name, l.customerName, l.fullName, l.spouseName, l.secondaryName];
  for (const n of names) {
    if (!n) continue;
    add(n);
    String(n).split(/[\s,&]+/).forEach((p) => { if (/^[A-Za-z'.-]{2,}$/.test(p) && !/^(and|mr|mrs|ms|dr|jr|sr)\.?$/i.test(p)) add(p.replace(/\.$/, '')); });
  }
  if (l.address) {
    const first = String(l.address).split(',')[0].trim();
    add(first);
    const num = /^\s*(\d{1,6})\b/.exec(first);
    if (num) add(num[1]);
    const street = first.replace(/^\s*\d+[A-Za-z]?\s+/, '').trim();
    if (street && street !== first) add(street);
    const zip = /\b(\d{5})(-\d{4})?\b/.exec(String(l.address));
    if (zip) add(zip[1]);
  }
  for (const k of ['street', 'address1', 'zip', 'postalCode', 'email', 'phone', 'phone2']) add(l[k]);
  return Array.from(terms);
}

const STREET_ADDRESS_RE = new RegExp('\\b\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?[A-Za-z][A-Za-z.\'-]*(?:\\s+[A-Za-z][A-Za-z.\'-]*){0,3}\\s+' + STREET_WORDS.source, 'i');
const GPS_RE = /-?\d{1,3}\.\d{3,}\s*[,/ ]\s*-?\d{1,3}\.\d{3,}|\b\d{1,3}°\s*\d{1,2}['′]|\b(lat|latitude|lng|longitude|gps)\b/i;
const PHONE_RE = /\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

function sentenceChunks(text) {
  // A '.' followed by a digit is a decimal (38.99871), not a sentence end —
  // otherwise a coordinate is split across chunks and slips past GPS_RE.
  return String(text).match(/(?:[^.!?\n]|\.(?=\d))*(?:[.!?]+|\n|$)[ \t\r\n]*/g).filter((c) => c !== '');
}

function privacyHit(sentence, termRes) {
  if (STREET_ADDRESS_RE.test(sentence)) return 'street';
  if (GPS_RE.test(sentence)) return 'gps';
  if (EMAIL_RE.test(sentence)) return 'email';
  for (const t of termRes) if (t.re.test(sentence)) return 'private:' + t.kind;
  return null;
}

function termRegexes(terms, opts) {
  const out = [];
  for (const t of terms || []) {
    const s = String(t).trim();
    if (!s) continue;
    const digits = s.replace(/\D/g, '');
    if (/^[\d\s().+-]+$/.test(s) && digits.length >= 7) {
      // phone: match the digits with any separators
      out.push({ kind: 'phone', re: new RegExp(digits.split('').map(escRe).join('[\\s().-]*')) });
    } else if (/^\d+$/.test(s)) {
      out.push({ kind: 'number', re: new RegExp('\\b' + escRe(s) + '\\b') });
    } else {
      out.push({ kind: 'name', re: new RegExp('(^|[^A-Za-z])' + escRe(s) + '($|[^A-Za-z])', 'i') });
    }
  }
  // Jo's own business phone is allowed in a caption ("call or text me").
  if (opts && opts.allowPhone === false) out.push({ kind: 'phone', re: PHONE_RE });
  return out;
}

const SOCIAL_RULES = [
  // Social rule (Jo, 2026-10-04): nothing about deductibles, in any framing.
  { id: 'deductible-any', re: /\bdeductibles?\b/i },
  // A post never invites claim talk: "insurance claim" anywhere is out.
  { id: 'claim-talk', re: /\b(insurance|storm|hail|wind)\s+claims?\b|\bclaims?\s+(process|help|approved|paid)\b/i },
];

/**
 * The one caption cleaner. Drops (never rewrites) every sentence that
 *   - names a private term of the source lead, or looks like a street
 *     address, GPS coordinate or email; or
 *   - trips the Kentucky claim-wording rules (RULES + REPORT_RULES); or
 *   - trips a social rule (deductibles, claim talk).
 * → { text, dropped: [{ rule, sentence }] }
 */
function cleanCaption(text, opts) {
  const o = opts || {};
  const src = String(text == null ? '' : text);
  if (!src.trim()) return { text: '', dropped: [] };
  const termRes = termRegexes(o.privateTerms || [], o);
  const chunks = sentenceChunks(src);
  const flat = chunks.map((c) => c.replace(/\s+/g, ' ').trim());
  const kept = [];
  const dropped = [];
  for (let i = 0; i < chunks.length; i++) {
    const s = flat[i];
    if (!s) { kept.push(chunks[i]); continue; }
    const win = [flat[i - 1], s, flat[i + 1]].filter(Boolean).join(' ');
    const priv = privacyHit(s, termRes);
    if (priv) { dropped.push({ rule: priv, sentence: s }); continue; }
    const ky = CW.checkSentence(s, win, CW.ALL_RULES);
    if (ky.length) { dropped.push({ rule: 'ky:' + ky[0], sentence: s }); continue; }
    const soc = SOCIAL_RULES.find((r) => r.re.test(s));
    if (soc) { dropped.push({ rule: 'social:' + soc.id, sentence: s }); continue; }
    kept.push(chunks[i]);
  }
  const out = dropped.length ? kept.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : src.trim();
  return { text: out, dropped };
}

/** Hashtags that name a private term, a digit-led street or GPS are dropped. */
function cleanHashtags(tags, opts) {
  const termRes = termRegexes((opts && opts.privateTerms) || [], {});
  const seen = new Set();
  const out = [];
  for (const raw of tags || []) {
    let t = String(raw || '').trim().replace(/^#+/, '').replace(/[^A-Za-z0-9_]/g, '');
    if (!t || t.length > 40 || /^\d/.test(t)) continue;
    // A tag is one glued word: also test the de-glued form against names.
    const spaced = t.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (termRes.some((x) => x.kind === 'name' && (x.re.test(t) || x.re.test(spaced)))) continue;
    if (termRes.some((x) => x.kind !== 'name' && x.re.test(t))) continue;
    if (/deductible|claim/i.test(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push('#' + t);
  }
  return out;
}

// ── Hashtags + captions ─────────────────────────────────────────────────
const ROOFING_TAGS = ['roofing', 'roofer', 'newroof', 'roofreplacement'];
const KIND_TAGS = {
  job_showcase: ['beforeandafter'],
  tip: ['rooftips', 'homeowners'],
  storm_psa: ['stormseason', 'hailseason'],
  review: ['customerreview', 'shoplocal'],
  behind_scenes: ['behindthescenes', 'smallbusiness'],
};
const REGION_TAGS = { KY: ['NKY', 'NorthernKentucky'], OH: ['Cincinnati', 'CincyHomes'] };

function hashtagsFor(facts, kind) {
  const f = facts || {};
  const glued = f.town ? String(f.town).replace(/[^A-Za-z]/g, '') : '';
  const tags = [];
  if (glued) { tags.push(glued); if (f.state) tags.push(glued + f.state); }
  (REGION_TAGS[f.state] || []).forEach((t) => tags.push(t));
  ROOFING_TAGS.forEach((t) => tags.push(t));
  (KIND_TAGS[kind] || []).forEach((t) => tags.push(t));
  return cleanHashtags(tags.slice(0, 12), {});
}

function pick(list, seed) {
  const n = Math.abs(Number(seed) || 0);
  return list[n % list.length];
}

// Jo's plain voice: short, first person, no hype, no claim talk.
const TIPS = [
  'Look up at your roof after a big wind. Lifted or missing shingles are easy to spot from the yard, and catching them early keeps water out.',
  'Clean gutters matter more than most people think. When they back up, water sits at the roof edge and rots the decking.',
  'Granules in your downspouts are a sign your shingles are wearing out. If you see a lot of them, have someone take a look.',
  'Attic ventilation keeps a roof living longer. A hot, stuffy attic in summer cooks shingles from underneath.',
  'Dark streaks on a roof are usually algae, not damage. It looks rough, but it is not a leak waiting to happen.',
  'Check the flashing around chimneys and vents. Most leaks I find start there, not in the middle of the roof.',
];
const STORM_PSAS = [
  'Storm season is here. After hail or high wind, walk around the house and look for dents in gutters, siding and downspouts.',
  'If a storm rolls through, take photos of anything that looks off before you clean it up. Good photos help you later.',
  'Be careful with storm chasers knocking doors after a big storm. Work with someone local who will still be here next year.',
  'After a storm, stay off the roof. If you are worried, call a roofer to come look. It is not worth the fall.',
];
const BEHIND = [
  'Early start today. Tear-off, new underlayment, new shingles, and the yard cleaned up before we leave.',
  'Every job gets a magnet sweep for nails before we call it done. Your driveway should look like we were never there.',
  'Material drop this morning. Getting everything staged so the crew can move fast tomorrow.',
  'I am on the roof on every job. That is how I know it was done right.',
];

function jobCaption(facts, seed) {
  const f = facts || {};
  const where = f.town ? ' in ' + f.town + (f.state ? ', ' + f.state : '') : '';
  const pkg = f.shingle ? f.shingle + (f.packageLabel ? ' (' + f.packageLabel + ')' : '') : (f.packageLabel || '');
  const openers = [
    'New roof' + where + '.',
    'Another one done' + where + '.',
    'Before and after' + where + '.',
    'Finished this roof' + where + ' this week.',
  ];
  const lines = [pick(openers, seed)];
  if (pkg) lines.push(pkg + '.');
  lines.push(pick([
    'Tear-off to clean-up, and I am on the roof the whole way.',
    'Old roof off, new roof on, yard cleaned up.',
    'Clean lines, clean yard, happy homeowner.',
  ], seed + 1));
  lines.push('Thinking about your roof? Call or text me.');
  return lines.join(' ');
}

function templateCaption(kind, facts, seed) {
  const s = Number(seed) || 0;
  if (kind === 'job_showcase') return jobCaption(facts, s);
  if (kind === 'tip') return pick(TIPS, s) + ' Questions? Call or text me.';
  if (kind === 'storm_psa') return pick(STORM_PSAS, s);
  if (kind === 'review') {
    const quote = facts && facts.reviewText ? cleanLabel(facts.reviewText, 400) : '';
    return quote ? '"' + quote + '" Thank you for trusting me with your roof.' : 'Thank you to everyone who has left me a review. It means a lot to a small local business.';
  }
  return pick(BEHIND, s);
}

// ── Job eligibility + photo selection ───────────────────────────────────
function phaseOf(p) {
  const v = String((p && (p.phase || (p.aiSuggestion && p.aiSuggestion.phase))) || '').toLowerCase();
  if (v === 'before') return 'before';
  if (v === 'after') return 'after';
  if (v === 'during') return 'during';
  return '';
}

function ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/**
 * Pick the photos for a job post. Only photos with a storagePath (the
 * server re-encodes from it) and not marked hidden.
 *   before+after → 'before_after' [before, after] (or a carousel when 3+)
 *   only one     → 'single'
 * → { format, photos: [{ id, storagePath, role }] }
 */
function choosePhotos(photos, maxCount) {
  const max = Math.min(10, Math.max(1, Number(maxCount) || 10));
  const usable = (photos || []).map((p) => (p && !p.storagePath && typeof p.path === 'string' ? Object.assign({}, p, { storagePath: p.path }) : p))
    .filter((p) => p && typeof p.storagePath === 'string' && p.storagePath && !p.deleted && !p.hidden)
    .sort((a, b) => ms(a.createdAt || a.uploadedAt) - ms(b.createdAt || b.uploadedAt));
  const before = usable.filter((p) => phaseOf(p) === 'before');
  const after = usable.filter((p) => phaseOf(p) === 'after');
  const rest = usable.filter((p) => !phaseOf(p) || phaseOf(p) === 'during');
  let chosen;
  if (before.length && after.length) {
    chosen = [{ p: before[0], role: 'before' }, { p: after[after.length - 1], role: 'after' }];
    const extra = after.slice(0, -1).concat(before.slice(1)).slice(0, max - 2);
    extra.forEach((p) => chosen.push({ p, role: phaseOf(p) }));
  } else {
    chosen = after.concat(rest, before).slice(0, max).map((p) => ({ p, role: phaseOf(p) || 'photo' }));
  }
  const format = chosen.length === 0 ? 'text' : chosen.length === 1 ? 'single'
    : (chosen.length === 2 && chosen[0].role === 'before' && chosen[1].role === 'after') ? 'before_after' : 'carousel';
  return { format, photos: chosen.map((c) => ({ id: c.p.id, storagePath: c.p.storagePath, role: c.role })) };
}

/**
 * Facts for a job draft — the ONLY lead-derived values a post may carry.
 * Deliberately a whitelist: town, state, package, shingle. Never the name,
 * address, phone, email, coordinates, money or claim fields.
 */
function jobFacts(lead) {
  const loc = townFromLead(lead);
  const pkg = packageFromLead(lead);
  return { town: loc.town, state: loc.state, packageLabel: pkg.packageLabel, shingle: pkg.shingle };
}

/**
 * The complete draft body for a job post on one platform, already cleaned.
 * `media` = [{ key, role }] from the server's re-encode step.
 */
function buildJobDraft(opts) {
  const o = opts || {};
  const facts = jobFacts(o.lead);
  const terms = privateTerms(o.lead);
  const raw = o.caption || templateCaption('job_showcase', facts, o.seed);
  const cleaned = cleanCaption(raw, { privateTerms: terms });
  const hashtags = cleanHashtags(hashtagsFor(facts, 'job_showcase'), { privateTerms: terms });
  return {
    kind: 'job_showcase',
    platform: o.platform,
    format: o.format || 'single',
    caption: limitCaption(cleaned.text, o.platform),
    hashtags: limitHashtags(hashtags, o.platform),
    media: (o.media || []).map((m) => ({ key: m.key, role: m.role || 'photo' })),
    town: facts.town,
    state: facts.state,
    packageLabel: facts.packageLabel,
    shingle: facts.shingle,
    sourceLeadId: o.leadId || null,
    status: 'draft',
    captionFilter: { dropped: cleaned.dropped.length },
  };
}

function limitCaption(text, platform) {
  const max = (PLATFORMS[platform] && PLATFORMS[platform].maxCaption) || 2200;
  const t = String(text || '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > max * 0.5 ? cut.slice(0, end + 1) : cut).trim();
}

function limitHashtags(tags, platform) {
  const p = PLATFORMS[platform] || {};
  const max = p.maxHashtags || (platform === 'x' ? 2 : 12);
  return (tags || []).slice(0, max);
}

/** Final text the platform receives: caption + hashtags (space-joined). */
function composeMessage(post) {
  const cap = String((post && post.caption) || '').trim();
  const tags = ((post && post.hashtags) || []).join(' ');
  const msg = tags ? (cap ? cap + '\n\n' + tags : tags) : cap;
  return limitCaption(msg, post && post.platform);
}

// ── "Plan N weeks" ──────────────────────────────────────────────────────
const TZ = 'America/New_York';

function tzOffsetMinutes(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz || TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const parts = {};
  dtf.formatToParts(new Date(utcMs)).forEach((p) => { parts[p.type] = p.value; });
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/** UTC ms for a wall-clock time in `tz` on y-m-d (m 1-12). */
function zonedMs(y, m, d, hour, minute, tz) {
  const guess = Date.UTC(y, m - 1, d, hour, minute || 0);
  const off1 = tzOffsetMinutes(guess, tz);
  const t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(t, tz);
  return off2 === off1 ? t : guess - off2 * 60000;
}

function zonedYmd(utcMs, tz) {
  const s = new Intl.DateTimeFormat('en-CA', { timeZone: tz || TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utcMs));
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d, dow: new Date(Date.UTC(y, m - 1, d)).getUTCDay() };
}

function isStormSeason(utcMs) {
  const m = zonedYmd(utcMs).m;
  return m >= 3 && m <= 7;
}

// Weekly rhythm: Tue 9:00 job showcase, Thu 12:00 tip or storm PSA,
// Sat 10:00 review or behind-the-scenes. Each slot goes to every chosen
// platform (one doc per platform) unless the platform cannot carry it
// (Instagram/TikTok need media; a text-only slot skips them).
const SLOTS = [
  { dow: 2, hour: 9,  minute: 0, kinds: ['job_showcase', 'behind_scenes'] },
  { dow: 4, hour: 12, minute: 0, kinds: ['tip', 'storm_psa'] },
  { dow: 6, hour: 10, minute: 0, kinds: ['review', 'behind_scenes'] },
];

/**
 * Proposals for `weeks` weeks starting the day after startMs.
 *   jobs:     [{ leadId, facts, format, mediaReady }] — showcases, used once
 *   reviews:  [{ text }] — public review text (already public), used once
 * → [{ kind, platform, scheduledAtMs, caption, hashtags, leadId?, format }]
 * Text-only proposals skip media-only platforms.
 */
function planWeeks(opts) {
  const o = opts || {};
  const weeks = Math.min(8, Math.max(1, Math.floor(Number(o.weeks) || 1)));
  const platforms = (o.platforms || ['facebook']).filter((p) => PLATFORMS[p]);
  const startMs = Number(o.startMs) || Date.now();
  const jobs = (o.jobs || []).slice();
  const reviews = (o.reviews || []).slice();
  const out = [];
  let seed = Number(o.seed) || 0;
  const first = zonedYmd(startMs + 86400000);
  let dayIdx = 0;
  for (let day = 0; day < weeks * 7; day++) {
    const base = Date.UTC(first.y, first.m - 1, first.d) + day * 86400000;
    const dd = new Date(base);
    const dow = dd.getUTCDay();
    const slot = SLOTS.find((s) => s.dow === dow);
    if (!slot) continue;
    const at = zonedMs(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate(), slot.hour, slot.minute);
    let kind, facts = {}, leadId = null, format = 'text';
    if (slot.kinds[0] === 'job_showcase' && jobs.length) {
      const j = jobs.shift();
      kind = 'job_showcase'; facts = j.facts || {}; leadId = j.leadId || null; format = j.format || 'single';
    } else if (slot.kinds[0] === 'tip') {
      kind = (isStormSeason(at) && (dayIdx % 2 === 1)) ? 'storm_psa' : 'tip';
    } else if (slot.kinds[0] === 'review' && reviews.length) {
      kind = 'review'; facts = { reviewText: reviews.shift().text };
    } else {
      kind = 'behind_scenes';
    }
    dayIdx++;
    seed++;
    const caption = cleanCaption(templateCaption(kind, facts, seed), {}).text;
    const hashtags = hashtagsFor(facts, kind);
    for (const p of platforms) {
      if (format === 'text' && PLATFORMS[p].needsMedia) continue;
      out.push({ kind, platform: p, scheduledAtMs: at, caption: limitCaption(caption, p), hashtags: limitHashtags(hashtags, p), leadId, format });
    }
  }
  return out;
}

// ── Status transitions ──────────────────────────────────────────────────
/** Which statuses may the approve callable act on. */
function canApprove(status) { return status === 'draft' || status === 'failed' || status === 'cancelled'; }
/** Statuses a reschedule may move. */
function canReschedule(status) { return ['draft', 'approved', 'scheduled', 'failed', 'ready', 'cancelled'].includes(status); }

module.exports = {
  PLATFORMS, PLATFORM_IDS, KINDS, STATUSES, MAX_ATTEMPTS, STALE_CLAIM_MS, TZ,
  backoffMs, safeTown, townFromLead, packageFromLead, privateTerms, cleanCaption, cleanHashtags,
  hashtagsFor, templateCaption, choosePhotos, jobFacts, buildJobDraft, composeMessage,
  limitCaption, limitHashtags, planWeeks, zonedMs, zonedYmd, isStormSeason, canApprove, canReschedule,
  SOCIAL_RULES, ms,
};
