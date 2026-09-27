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
 * until 2027. No year, or no price, means no line: nothing is guessed.
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

/**
 * priceContext(p, asOf) -> null | {
 *   year, href,
 *   lead:     'Priced in 2023. Materials and labor have gone up since, and tier and scope move a price by thousands —',
 *   linkText: 'see what this kind of job runs today →',
 *   short:    'Priced in 2023. Materials and labor have gone up since.'   (cards that are themselves links)
 * }
 * Plain text — the caller escapes it.
 */
export function priceContext(p, asOf) {
  if (!isPriceDated(p, asOf)) return null;
  const year = Number(p.year);
  return {
    year,
    href: todayHref(p),
    lead: `Priced in ${year}. Materials and labor have gone up since, and tier and scope move a price by thousands —`,
    linkText: 'see what this kind of job runs today →',
    short: `Priced in ${year}. Materials and labor have gone up since.`,
  };
}
