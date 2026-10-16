// tests/e2e/fixtures/axe.js — automated accessibility checks (axe-core) for
// the pages that book inspections and the pages a homeowner or Jo uses most
// (repos report 2026-10-16 item 3).
//
// expectNoSeriousA11y(page, testInfo, opts) runs axe-core over the page (or
// opts.include) with the WCAG 2.0/2.1 A + AA rule tags and FAILS on any
// violation whose impact is "serious" or "critical". Moderate and minor
// findings are attached to the test report (axe-results.json) and printed,
// so they stay visible without blocking a merge.
//
// axe is injected as a script, which a strict CSP (no inline script, no
// eval) refuses. Every spec that calls this sets `bypassCSP: true` on ITS OWN
// context (test.use in that describe block only); nothing else changes.
//
// opts.disableRules: rule ids to skip, each with a dated reason at the call
// site. Never use it to hide a real failure: fix the page or quarantine
// with a reason in the PR.
const AxeBuilder = require('@axe-core/playwright').default;

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const BLOCKING = new Set(['serious', 'critical']);

function summarize(v) {
  return v.map((x) => '[' + x.impact + '] ' + x.id + ': ' + x.help + ' (' + x.nodes.length + ' node' + (x.nodes.length === 1 ? '' : 's') + ')\n' +
    x.nodes.slice(0, 12).map((n) => '      ' + n.target.join(' ') + (n.failureSummary ? '  :: ' + n.failureSummary.replace(/\s+/g, ' ').slice(0, 220) : '')).join('\n')).join('\n');
}

async function expectNoSeriousA11y(page, testInfo, opts = {}) {
  // Let entrance animations finish first: mid-fade text is measured against a
  // half-transparent background and reads as a false contrast failure.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect && a.effect.getTiming && a.effect.getTiming().iterations === Infinity),
    null, { timeout: 5000 }).catch(() => {});
  let b = new AxeBuilder({ page }).withTags(TAGS);
  for (const sel of [].concat(opts.include || [])) b = b.include(sel);
  for (const sel of [].concat(opts.exclude || [])) b = b.exclude(sel);
  if (opts.disableRules && opts.disableRules.length) b = b.disableRules(opts.disableRules);
  const res = await b.analyze();
  const blocking = res.violations.filter((v) => BLOCKING.has(v.impact));
  const other = res.violations.filter((v) => !BLOCKING.has(v.impact));
  if (testInfo) {
    await testInfo.attach('axe-results' + (opts.label ? '-' + opts.label : '') + '.json', { body: JSON.stringify(res.violations, null, 2), contentType: 'application/json' });
  }
  if (other.length) console.log('[axe ' + (opts.label || page.url()) + '] moderate/minor (not blocking):\n' + summarize(other));
  if (blocking.length) {
    throw new Error('axe found ' + blocking.length + ' serious/critical accessibility violation(s) on ' + (opts.label || page.url()) + ':\n' + summarize(blocking));
  }
  return { blocking, other, passes: res.passes.length };
}

module.exports = { expectNoSeriousA11y, AXE_TAGS: TAGS };
