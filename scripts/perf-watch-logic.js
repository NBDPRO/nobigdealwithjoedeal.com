/**
 * scripts/perf-watch-logic.js — pure decisions for the weekly page-speed
 * watch (.github/workflows/perf-watch.yml → scripts/perf-watch.mjs).
 *
 * WHY: page speed feeds Google ranking and AI-assistant recommendations,
 * and every perf check so far was a one-off sweep
 * (documentation/qa/homeowner-sweep-2026-06-11/PHASE4-SEO-PERF.md). Jo's
 * idea triage (2026-10-01, "frontend performance dashboard") asked for a
 * trend that catches regressions. This module holds every judgement so the
 * runner stays thin and the rules are unit-tested
 * (tests/perf-watch-2026-10-02.test.js).
 *
 * Lighthouse varies run to run, so each page is measured RUNS times and the
 * MEDIAN of each metric is judged. A page that could not be measured at all
 * (network, Chrome crash) is an infra note, never a red: an alarm that cries
 * wolf stops being read (same rule as copycat-watch.yml).
 */
'use strict';

// PERF_BASE overrides for a local check (e.g. the hosting emulator).
const BASE = process.env.PERF_BASE || 'https://nobigdealwithjoedeal.com';

// The money pages: the home page, booking, the estimate tool, the proof
// gallery, and the storm checker that most storm traffic lands on.
const PAGES = ['/', '/book', '/estimate', '/our-work', '/storm-check'];

const RUNS = 3;

// Mobile Lighthouse budgets. Lenient on purpose for the first weeks: the
// job is to catch a REGRESSION (a new heavy script, an unsized hero image),
// not to grade the site. Tighten once the trend is known.
const BUDGETS = {
  score: { min: 0.70, label: 'Performance score' },
  lcpMs: { max: 4000, label: 'Largest Contentful Paint' },
  cls: { max: 0.10, label: 'Cumulative Layout Shift' },
  tbtMs: { max: 600, label: 'Total Blocking Time' },
};

function median(nums) {
  const v = (nums || []).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** One Lighthouse JSON result → the four numbers we judge (null if missing). */
function metricsFromLhr(lhr) {
  if (!lhr || !lhr.audits || !lhr.categories) return null;
  const a = lhr.audits;
  const num = (id) => (a[id] && Number.isFinite(a[id].numericValue) ? a[id].numericValue : null);
  const score = lhr.categories.performance && Number.isFinite(lhr.categories.performance.score) ? lhr.categories.performance.score : null;
  return {
    score,
    lcpMs: num('largest-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbtMs: num('total-blocking-time'),
  };
}

/** Several runs of one page → medians. */
function summarisePage(path, runs) {
  const ok = (runs || []).filter(Boolean);
  if (!ok.length) return { path, measured: false, runs: 0 };
  return {
    path,
    measured: true,
    runs: ok.length,
    score: median(ok.map((r) => r.score)),
    lcpMs: median(ok.map((r) => r.lcpMs)),
    cls: median(ok.map((r) => r.cls)),
    tbtMs: median(ok.map((r) => r.tbtMs)),
  };
}

/** A page's breaches against the budgets (empty = within budget). */
function breaches(page, budgets = BUDGETS) {
  if (!page || !page.measured) return [];
  const out = [];
  for (const [k, b] of Object.entries(budgets)) {
    const v = page[k];
    if (v == null) continue;
    if (b.min != null && v < b.min) out.push({ metric: k, label: b.label, value: v, limit: b.min, kind: 'below' });
    if (b.max != null && v > b.max) out.push({ metric: k, label: b.label, value: v, limit: b.max, kind: 'above' });
  }
  return out;
}

function fmt(metric, v) {
  if (v == null) return '—';
  if (metric === 'score') return String(Math.round(v * 100));
  if (metric === 'cls') return v.toFixed(3);
  return (v / 1000).toFixed(2) + ' s';
}

/**
 * The run's verdict + a Markdown summary for $GITHUB_STEP_SUMMARY.
 * red = at least one MEASURED page over budget. Unmeasured pages are notes.
 */
function verdict(pages, budgets = BUDGETS, runs = RUNS) {
  const rows = pages.map((p) => ({ page: p, over: breaches(p, budgets) }));
  const red = rows.some((r) => r.over.length);
  const unmeasured = rows.filter((r) => !r.page.measured).map((r) => r.page.path);
  const lines = [
    '## Page-speed watch (mobile Lighthouse, median of ' + runs + ' run' + (runs === 1 ? '' : 's') + ')',
    '',
    '| Page | Score | LCP | CLS | TBT | Status |',
    '|---|---|---|---|---|---|',
    ...rows.map(({ page: p, over }) => '| `' + p.path + '` | ' +
      (p.measured ? [fmt('score', p.score), fmt('lcpMs', p.lcpMs), fmt('cls', p.cls), fmt('tbtMs', p.tbtMs)].join(' | ') : '— | — | — | —') +
      ' | ' + (!p.measured ? 'not measured (infra)' : over.length ? '🔴 ' + over.map((b) => b.label).join(', ') : '✅') + ' |'),
    '',
    'Budgets: score ≥ ' + Math.round(budgets.score.min * 100) + ', LCP ≤ ' + (budgets.lcpMs.max / 1000) + ' s, CLS ≤ ' + budgets.cls.max + ', TBT ≤ ' + budgets.tbtMs.max + ' ms.',
  ];
  if (unmeasured.length) lines.push('', 'Not measured (network or Chrome failure, not a regression): ' + unmeasured.map((p) => '`' + p + '`').join(', ') + '.');
  return { red, unmeasured, summary: lines.join('\n') };
}

module.exports = { BASE, PAGES, RUNS, BUDGETS, median, metricsFromLhr, summarisePage, breaches, verdict };
