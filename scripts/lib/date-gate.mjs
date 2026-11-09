/**
 * scripts/lib/date-gate.mjs — the one "is this dated item live yet?" rule for the generators that read a
 * `published` date (build-feed.mjs, build-projects.mjs, build-llms.mjs), and the lag rule their --check modes share.
 *
 * LIVE: an item is live on day L when its published day is on or before L. Both sides go through dayStart(), the
 * exact transform the generators have always used (new Date(x), then local midnight), so the default output is
 * byte-identical to what they rendered before this module existed.
 *
 * LAG (2026-11-09): future-dated posts and projects go live on the first deploy after their date, and the weekly
 * scheduled deploy (.github/workflows/firebase-deploy.yml) rebuilds them inside the job without committing. So the
 * committed generated files can lag the live site by exactly the items whose date passed since the last restamp.
 * A --check therefore passes when the committed output equals the render for TODAY or for an earlier cut day —
 * "stamped before item X's date". Each cut is the day before a distinct published date that is not after today,
 * newest first, with NO cap (review 2026-11-09): nothing forces a restamp, so a repo copy left alone for months must
 * still read as lag, never as red CI on an unrelated PR. Each cut is one in-process render (feed, llms) or one ~0.2 s
 * child run (projects), and only on the failing path. --strict turns the lag allowance off (exact-today only).
 * What lag cannot tell apart: a NEW post dated on or after the newest live date and added without --write passes too,
 * because "stamped the day before it" explains it exactly. The deploy still regenerates it, so the live site is right.
 *
 * Runbook: documentation/runbooks/BLOG-SCHEDULE.md. Test: tests/date-gated-checks-2026-11-09.test.js.
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The generators' day: new Date(v), then local midnight. */
export function dayStart(v) {
  const d = new Date(v);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** True when `published` is on or before the day `liveOn` (a dayStart() Date). */
export function isLiveOn(published, liveOn) {
  return dayStart(published) <= liveOn;
}

/** 'YYYY-MM-DD' of the calendar day before `isoDay`. */
export function dayBefore(isoDay) {
  return new Date(Date.parse(String(isoDay).slice(0, 10) + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

/**
 * Reads --live-on=YYYY-MM-DD. Returns { date, iso, given }; without it the day is today. A flag only, never an env
 * var, so a stray variable in CI can never move what a gate compares against.
 * Throws on a malformed or impossible date so the caller can exit 2.
 */
export function readLiveOn(argv = process.argv.slice(2)) {
  const flag = argv.find((a) => a.startsWith('--live-on='));
  const raw = flag ? flag.slice('--live-on='.length) : '';
  if (!raw) return { date: dayStart(Date.now()), iso: null, given: false };
  const t = Date.parse(raw + 'T00:00:00Z');
  if (!ISO_RE.test(raw) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== raw) {
    throw new Error(`--live-on must be a real YYYY-MM-DD date, got "${raw}"`);
  }
  return { date: dayStart(raw), iso: raw, given: true };
}

/**
 * The earlier days a lagging committed tree may have been stamped on, newest first: the day before each distinct
 * published date that is live on `liveOn`, every one of them (no cap, see LAG above). Each entry: { iso: cut day,
 * wentLive: [published days after the cut] }.
 */
export function lagCuts(publishedDates, liveOn) {
  const days = [...new Set(publishedDates.map((d) => String(d).slice(0, 10)))]
    .filter((d) => ISO_RE.test(d) && isLiveOn(d, liveOn))
    .sort()
    .reverse();
  return days.map((d, i) => ({ iso: dayBefore(d), wentLive: days.slice(0, i + 1).reverse() }));
}

/** One line for a check that passed on a lagging stamp. */
export function lagNotice(label, cut, fixCmd) {
  return `OK (lags the live site): ${label} matches the render as of ${cut.iso}; item(s) dated ${cut.wentLive.join(', ')} `
    + `went live since. The deploy (push or the weekly schedule) rebuilds them, so the live site is current. `
    + `To catch the repo copy up, run: ${fixCmd}`;
}
