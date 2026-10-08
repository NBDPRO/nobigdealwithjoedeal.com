/* portal-view-tracking-2026-09-16.test.js
 *
 * A 2026-09-08 recon flagged: "portal views never recorded (CRM
 * permanently shows 'waiting for customer to open it')." Re-verified:
 * mixed. A raw "Opened portal" line WAS already wired into the activity
 * feed (customerAuditEvents, via recordCustomerEvent) — but the three
 * headline-level indicators a rep actually watches
 * (customer-engagement-score.js's tier chip — the literal source of the
 * "waiting for the customer to open it" string the recon quoted,
 * customer-viewed-chip.js, and crm-pipeline.js's kanban badge) were all
 * wired to estimate.viewedAt only. That field is stamped by a SEPARATE
 * flow (getEstimateForView, the standalone /pro/estimate-view.html link)
 * that never fires just because a homeowner opened the main portal — so a
 * rep could watch a chip say "waiting" forever on a lead whose homeowner
 * had genuinely opened the portal, just never clicked a separate
 * estimate-preview link.
 *
 * Fix: functions/portal.js's getHomeownerPortalView now stamps
 * lead.lastPortalOpenAt on a genuine (non-poll) open — free to read
 * wherever the lead doc is already loaded, no new query. All three
 * consumers now fold that field into their existing "viewed" computation
 * as an equal signal alongside estimate.viewedAt.
 *
 * Same house style as this session's other portal-*-2026-09-16 suites:
 * vm-lift the pure functions and run direct scenario assertions.
 * crm-pipeline.js's badge is an anonymous IIFE (not a named function, by
 * design — it assigns into an outer `viewedBadge` closure variable), so
 * it's covered by source-shape assertions instead of a vm lift, mirroring
 * the same fallback this repo's portal-scheduled-date.test.js already
 * uses for CSS shape checks.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const ENGAGEMENT = read('docs/pro/js/customer-engagement-score.js');
const VIEWED_CHIP = read('docs/pro/js/customer-viewed-chip.js');
const KANBAN = read('docs/pro/js/crm-pipeline.js');
const PORTAL_FN = read('functions/portal.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

function liftFunction(src, name) {
  const sig = 'function ' + name + '(';
  const start = src.indexOf(sig);
  if (start < 0) return null;
  const bodyStart = src.indexOf('{', start);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return i < src.length ? src.slice(start, i + 1) : null;
}

/* ══════════════════════════════════════════════════════════════════
   1. Server: the stamp exists, is genuine-open-only, and writes the LEAD
      doc (not just the orphaned portal_tokens doc the original bug lived in)
   ══════════════════════════════════════════════════════════════════ */
group('getHomeownerPortalView stamps lead.lastPortalOpenAt on a genuine open', () => {
  const block = PORTAL_FN.slice(
    PORTAL_FN.indexOf('tokRef.update(!countsAsOpen'),
    PORTAL_FN.indexOf('tokRef.update(!countsAsOpen') + 1200
  );
  assert('found the open-tracking block', block.length > 0);
  assert('writes leads/{tok.leadId}.lastPortalOpenAt', /leads\/\$\{tok\.leadId\}.*update\(\{\s*lastPortalOpenAt/.test(block), block);
  assert('gated on !isPoll — a background poll must not count as a fresh "just opened" signal',
    /if \(!isPoll\)\s*\{[\s\S]*?lastPortalOpenAt/.test(block), block);
});

/* ══════════════════════════════════════════════════════════════════
   2. customer-engagement-score.js's computeTier
   ══════════════════════════════════════════════════════════════════ */
const toMillisSrc = ENGAGEMENT.slice(ENGAGEMENT.indexOf('function toMillis('), ENGAGEMENT.indexOf('function toMillis(') + 400);
const tierSrc = liftFunction(ENGAGEMENT, 'computeTier');
group('computeTier is present and liftable', () => {
  assert('found computeTier in customer-engagement-score.js', !!tierSrc,
    'if it moved, update the extractor — do NOT delete the suite');
});
if (tierSrc) {
  const ctx = { Date };
  vm.createContext(ctx);
  vm.runInContext(
    'const FRESH_SHARE_MS = 24 * 60 * 60 * 1000;\n'
    + toMillisSrc.slice(0, toMillisSrc.indexOf('\n  }\n') + 4) + '\n' + tierSrc + '\nthis.__t = computeTier;',
    ctx
  );
  const computeTier = ctx.__t;

  group('A portal open with zero estimates now shows Viewed instead of "waiting"', () => {
    const lead = { id: 'L1', lastPortalOpenAt: new Date(), lastSharedAt: new Date(Date.now() - 2 * 86400000) };
    const tier = computeTier(lead, []);
    assert('tier is 2 (Viewed) or 3 (Hot), not 1 (Sent, "waiting for the customer to open it")',
      tier && (tier.tier === 2 || tier.tier === 3), JSON.stringify(tier));
    assert('title no longer says "waiting for the customer to open it"',
      tier && !/waiting for the customer/i.test(tier.title), JSON.stringify(tier));
  });

  group('A recent portal open reaches Hot (tier 3), same as a recent estimate view would', () => {
    const lead = { id: 'L1', lastPortalOpenAt: new Date(), lastSharedAt: new Date() };
    const tier = computeTier(lead, []);
    assert('tier 3 Hot on a fresh open', tier && tier.tier === 3, JSON.stringify(tier));
  });

  group('No signals at all still falls through to Tier 0/1 correctly (fix is additive, not a regression)', () => {
    const noSignals = computeTier({ id: 'L1' }, []);
    assert('no lastPortalOpenAt, no share, no estimates -> Tier 0 New', noSignals && noSignals.tier === 0, JSON.stringify(noSignals));
    const sentOnly = computeTier({ id: 'L1', lastSharedAt: new Date() }, []);
    assert('share sent, no portal open, no estimate view -> still Tier 1 Sent (the real "waiting" case)',
      sentOnly && sentOnly.tier === 1, JSON.stringify(sentOnly));
  });

  group('An estimate view alone (no portal open) still works exactly as before', () => {
    const lead = { id: 'L1' };
    const tier = computeTier(lead, [{ leadId: 'L1', viewedAt: new Date() }]);
    assert('tier 2/3 from an estimate view alone, unaffected by this fix', tier && (tier.tier === 2 || tier.tier === 3), JSON.stringify(tier));
  });

  group('respondedAt still wins over everything, portal-open included', () => {
    const lead = { id: 'L1', lastPortalOpenAt: new Date() };
    const tier = computeTier(lead, [{ leadId: 'L1', respondedAt: new Date() }]);
    assert('tier 4 Responded', tier && tier.tier === 4, JSON.stringify(tier));
  });
}

/* ══════════════════════════════════════════════════════════════════
   3. customer-viewed-chip.js's computeViewSignal
   ══════════════════════════════════════════════════════════════════ */
const chipToMillisSrc = VIEWED_CHIP.slice(VIEWED_CHIP.indexOf('function toMillis('), VIEWED_CHIP.indexOf('function toMillis(') + 400);
const chipSrc = liftFunction(VIEWED_CHIP, 'computeViewSignal');
group('computeViewSignal is present and liftable', () => {
  assert('found computeViewSignal in customer-viewed-chip.js', !!chipSrc);
});
if (chipSrc) {
  const ctx2 = { window: {}, Date };
  vm.createContext(ctx2);
  vm.runInContext(chipToMillisSrc.slice(0, chipToMillisSrc.indexOf('\n  }\n') + 4) + '\n' + chipSrc + '\nthis.__c = computeViewSignal;', ctx2);
  const computeViewSignal = ctx2.__c;

  group('Fires on a portal open even with ZERO estimates loaded (previously hard-gated out)', () => {
    ctx2.window._currentLead = { id: 'L1', stage: 'new', lastPortalOpenAt: new Date() };
    ctx2.window._estimates = [];
    const ms = computeViewSignal();
    assert('returns a truthy timestamp, not null', !!ms, String(ms));
  });

  group('Terminal stage still suppresses it, portal-open included', () => {
    ctx2.window._currentLead = { id: 'L1', stage: 'closed', lastPortalOpenAt: new Date() };
    ctx2.window._estimates = [];
    assert('null on a closed lead', computeViewSignal() === null);
  });

  group('A responded estimate still suppresses it even with a later portal open', () => {
    ctx2.window._currentLead = { id: 'L1', stage: 'new', lastPortalOpenAt: new Date() };
    ctx2.window._estimates = [{ leadId: 'L1', respondedAt: new Date() }];
    assert('null when responded', computeViewSignal() === null);
  });

  group('No signals at all still returns null (not a regression)', () => {
    ctx2.window._currentLead = { id: 'L1', stage: 'new' };
    ctx2.window._estimates = [];
    assert('null with nothing to show', computeViewSignal() === null);
  });
}

/* ══════════════════════════════════════════════════════════════════
   4. crm-pipeline.js's kanban badge — source-shape assertions
      (anonymous IIFE, not a named function; see file header above)
   ══════════════════════════════════════════════════════════════════ */
group('crm-pipeline.js\'s viewedBadge IIFE is kept in lockstep with the fix above', () => {
  const block = KANBAN.slice(KANBAN.indexOf('let viewedBadge = \'\';'), KANBAN.indexOf('let viewedBadge = \'\';') + 2200);
  assert('found the buildViewedBadge block', block.length > 0);
  assert('the old "no estimates -> bail immediately" gate is gone (a portal-only open must still render)',
    !/if \(estimates\.length === 0\) return;/.test(block), block);
  assert('reads l.lastPortalOpenAt as a view signal', /l\.lastPortalOpenAt/.test(block), block);
  assert('portal-open time still participates in the same latestViewMs the estimate loop already built',
    /if \(portalMs > latestViewMs\) latestViewMs = portalMs;/.test(block), block);
  assert('anyResponded still suppresses the badge (unchanged business rule)',
    /if \(anyResponded\) return;/.test(block), block);
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
