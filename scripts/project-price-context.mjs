/**
 * project-price-context.mjs — the honest "priced in <year>" line for older
 * job prices on /our-work cards, hub/area/town strips and case-study pages.
 *
 * WHY (Joe, 2026-09-27): "we need to price validate everything — some jobs are
 * years old and unrealistic to match today's pricing scale." A 2023 insurance
 * re-roof that landed near $400 a square sits on the same page as today's
 * $610–$825 a square tiers, and a homeowner reading both gets sticker shock
 * from the NEW number. The old price and its year stay on the page (they are
 * true); this adds one sentence of context next to them and a link to what
 * that kind of job runs today.
 *
 * THE RULE: a job with a published price range whose `year` is more than 12
 * months before the as-of date gets the line. Only the year is known, so the
 * job is dated generously to Dec 31 of that year — a 2025 job is not "old"
 * until 2027. No price means no line.
 *
 * UNDATED JOBS (Jo, 2026-09-27): a priced job with NO `year` is one of the
 * legacy jobs carried over from the old gallery, all priced before 2025
 * (West Liberty is "2024 or earlier"). They get "Priced before 2025." plus
 * the same prices-rise note and link. The year itself is still never
 * guessed; the label names the bound Jo gave. Those jobs are named one by
 * one in LEGACY_UNDATED_PRICED, and only they get the label: a NEW priced job
 * without `year` fails the build (yearRuleErrors, run by build-projects.mjs).
 *
 * AS-OF DATE: injectable (tests pass their own). build-projects.mjs passes
 * --as-of=YYYY-MM-DD / NBD_PROJECTS_AS_OF when given, else the newest
 * `published` date in projects.json — NOT the wall clock, because every
 * stamped surface is CI-gated by `build-projects.mjs --check` and a wall-clock
 * rule would turn that gate red on untouched code every New Year's Day (the
 * same trap the generated-comment date fell into until 2026-08-07). Every new
 * job Joe publishes moves the as-of date forward.
 *
 * Pure: no fs, no clock. Imported by scripts/build-projects.mjs and
 * tests/project-price-context.test.js.
 */

export const STALE_AFTER_MONTHS = 12;
export const ROOF_COST_GUIDE = '/blog/how-much-does-roof-cost-cincinnati-2026';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// 'YYYY-MM-DD' -> UTC midnight Date, or null.
export function parseAsOf(s) {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return isNaN(d.getTime()) ? null : d;
}

// The date a job's price is treated as being from: Dec 31 of its year.
export function pricedOn(p) {
  const y = Number(p && p.year);
  if (!Number.isInteger(y) || y < 1990 || y > 9999) return null;
  return new Date(Date.UTC(y, 11, 31));
}

export function isPriceDated(p, asOf) {
  if (!p || p.priceLow == null || p.priceHigh == null) return false;
  if (!(asOf instanceof Date) || isNaN(asOf.getTime())) throw new Error('isPriceDated: asOf must be a valid Date');
  const priced = pricedOn(p);
  if (!priced) return false;
  const cutoff = new Date(asOf.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - STALE_AFTER_MONTHS);
  return priced < cutoff;
}

// Where "what this kind of job runs today" points: the roof cost guide for a
// residential re-roof, else the job's own /services/ hub page (commercial,
// repair, siding, gutters … carry their recent priced jobs there).
export function todayHref(p) {
  const services = Array.isArray(p.services) ? p.services : [];
  if (services[0] !== 'commercial-roofing' && services.includes('roof-replacement')) return ROOF_COST_GUIDE;
  return services[0] ? `/services/${services[0]}` : ROOF_COST_GUIDE;
}

// The data-price-context value and wording for a priced job with no year.
export const UNDATED_KEY = 'before-2025';
export const UNDATED_LABEL = 'before 2025';

// Priced before 2025 — dates unknown (Jo 2026-09-27); do not add new entries.
// These are the only jobs that may be published with a price and no `year`,
// and the only ones labelled "Priced before 2025." Every other priced live
// job must carry `year` — build-projects.mjs fails the build naming the slug
// (yearRuleErrors below). If a real year turns up for one of these, add it to
// projects.json and delete the slug here (the build insists).
export const LEGACY_UNDATED_PRICED = Object.freeze([
  'brick-colonial-full-reroof',
  'brick-two-story-drone-verified',
  'multi-section-complex-roof',
  'wind-damage-lifted-shingles',
  'cul-de-sac-full-crew-tearoff',
  'two-properties-one-day',
  'apartment-complex-tearoff',
]);
const LEGACY_SET = new Set(LEGACY_UNDATED_PRICED);

// A priced legacy job with no usable year (see UNDATED JOBS above). Only the
// allowlist qualifies: an undated priced job outside it is a data error the
// build refuses, never a job that quietly inherits the "before 2025" label.
export function isUndatedPriced(p) {
  return !!p && p.priceLow != null && p.priceHigh != null && pricedOn(p) === null && LEGACY_SET.has(p.slug);
}

/**
 * yearRuleErrors(projects, today, legacy = LEGACY_UNDATED_PRICED) -> string[]
 * One message per violation (empty = pass). `today` is a Date; a project is
 * live when its `published` date is on or before it (the build's own filter).
 *   - a `year` that is present must be a real 4-digit year
 *   - a live, priced project needs `year` unless its slug is in `legacy`
 *   - a `legacy` slug must still exist, and must still lack a year (a found
 *     year retires the entry, so the list only shrinks)
 * Pure; `legacy` is injectable for tests.
 */
export function yearRuleErrors(projects, today, legacy = LEGACY_UNDATED_PRICED) {
  if (!(today instanceof Date) || isNaN(today.getTime())) throw new Error('yearRuleErrors: today must be a valid Date');
  const allow = new Set(legacy);
  const errs = [];
  const bySlug = new Map((projects || []).map((p) => [p && p.slug, p]));
  for (const p of projects || []) {
    if (!p) continue;
    const at = `project "${p.slug || p.title || '?'}"`;
    if (p.year != null && pricedOn(p) === null) {
      errs.push(`${at}: year must be a 4-digit year (e.g. 2026), got ${JSON.stringify(p.year)}`);
      continue;
    }
    const pub = new Date(p.published);
    const live = !isNaN(pub.getTime()) && pub <= today;
    const priced = p.priceLow != null || p.priceHigh != null;
    if (live && priced && p.year == null && !allow.has(p.slug)) {
      errs.push(`${at}: a priced project needs "year" (the year the job was priced) — "${p.slug}" has priceLow/priceHigh and no year. `
        + 'Only the legacy jobs in LEGACY_UNDATED_PRICED (scripts/project-price-context.mjs) may omit it; do not add to that list.');
    }
  }
  for (const slug of allow) {
    const p = bySlug.get(slug);
    if (!p) errs.push(`LEGACY_UNDATED_PRICED lists "${slug}", which is not in projects.json — delete the entry`);
    else if (p.year != null) errs.push(`project "${slug}" now has a year — delete it from LEGACY_UNDATED_PRICED (scripts/project-price-context.mjs)`);
  }
  return errs;
}

/**
 * priceContext(p, asOf) -> null | {
 *   year,     2023 | 'before-2025'   (the data-price-context value)
 *   when,     'in 2023' | 'before 2025'
 *   href,
 *   lead:     'Priced in 2023. Materials and labor have gone up since, and tier and scope move a price by thousands —',
 *   linkText: 'see what this kind of job runs today →',
 *   short:    'Priced in 2023. Materials and labor have gone up since.'   (cards that are themselves links)
 * }
 * Plain text — the caller escapes it.
 */
export function priceContext(p, asOf) {
  let year, when;
  if (isUndatedPriced(p)) {
    if (!(asOf instanceof Date) || isNaN(asOf.getTime())) throw new Error('priceContext: asOf must be a valid Date');
    year = UNDATED_KEY; when = UNDATED_LABEL;
  } else {
    if (!isPriceDated(p, asOf)) return null;
    year = Number(p.year); when = `in ${year}`;
  }
  return {
    year,
    when,
    href: todayHref(p),
    lead: `Priced ${when}. Materials and labor have gone up since, and tier and scope move a price by thousands —`,
    linkText: 'see what this kind of job runs today →',
    short: `Priced ${when}. Materials and labor have gone up since.`,
  };
}
