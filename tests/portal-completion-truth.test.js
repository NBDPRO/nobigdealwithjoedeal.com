/* portal-completion-truth.test.js
 *
 * Two things the portal told a homeowner that were not true.
 *
 * ── 1. "You can rate once the job is complete", on a complete job ──
 *
 * The rating card's RENDER gate was `progressKey === 'complete'`, computed
 * from STAGE_TO_PROGRESS with a fallback to the lead's semantic stage role.
 * Its SUBMIT gate was a hardcoded literal list —
 * ['final_photos','deductible_collected','final_payment','closed'] — under a
 * comment claiming those were "exactly the stages that map to the 'complete'
 * progress milestone". They were not, in two ways, and both reach a real
 * customer:
 *
 *   - A legacy raw display stage ('Complete', 'Closed Won', 'Won', 'Closed')
 *     is not a key in STAGE_TO_PROGRESS, so the view fell through to the role
 *     fallback, stage-roles ALIASed it to 'closed', the role came back 'won',
 *     progressKey became 'complete', and the card rendered. The submit gate
 *     then compared the RAW stage against its list, missed, and answered 409.
 *   - A tenant CUSTOM stage carrying stageRole 'won' does the same.
 *
 * So the homeowner tapped five stars on a finished roof and was told it wasn't
 * finished. Both gates now resolve through one resolver — since 2026-10-03
 * functions/homeowner-progress.js, whose gate is "paid in full".
 *
 * ── 2. The homeowner's own photo, as a broken tile ──
 *
 * uploadHomeownerPhoto bakes a 7-day signed URL into the photo doc. Its own
 * comment predicted the consequence and deferred it. After 7 days the URL
 * 403s, and the first person to see it die is the homeowner looking at the
 * gallery they uploaded to. The same doc feeds the rep's customer-page
 * gallery, so it breaks on both sides at once.
 *
 * Both halves run the REAL lifted functions rather than matching source text.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SRC = read('functions/portal.js');
const stageRoles = require(path.join(ROOT, 'functions', 'stage-roles.js'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── The resolver: functions/homeowner-progress.js (2026-10-03 rebuild).
   Required and RUN, not lifted — it is a pure module. Since the rebuild
   "complete enough to rate" means PAID IN FULL (paidInFullFor), not "final
   photos taken"; the defect below is still the thing guarded: one gate. ── */
const HP = require(path.join(ROOT, 'functions', 'homeowner-progress.js'));
const paid = (lead, invoices) => HP.paidInFullFor(lead, invoices || []);
const keyFor = (lead, invoices) => HP.resolveHomeownerProgress(lead, { invoices: invoices || [] }).currentKey;

group('The resolver is present', () => {
  assert('homeowner-progress.js exports resolveHomeownerProgress + paidInFullFor',
    typeof HP.resolveHomeownerProgress === 'function' && typeof HP.paidInFullFor === 'function');
});

/* ══════════════════════════════════════════════════════════════════
   1. The resolver agrees with itself across every stage shape
   ══════════════════════════════════════════════════════════════════ */
group('The legacy display stages that broke it are still rateable', () => {
  // These are NOT keys in STAGE_TO_STEP; they resolve through the legacy
  // map. A legacy "Complete" with nothing owed is a finished, paid job.
  ['Complete', 'Closed Won', 'Won', 'Closed', 'closed_won', 'closed-won'].forEach((stage) => {
    assert('"' + stage + '" with nothing owed is paid in full (rateable)', paid({ stage }) === true,
      'got key ' + keyFor({ stage }));
  });
  // ...and the OLD submit gate's literal list would have refused every one.
  const oldList = ['final_photos', 'deductible_collected', 'final_payment', 'closed'];
  const wouldHaveBeenRefused = ['Complete', 'Closed Won', 'Won', 'Closed']
    .filter((s) => oldList.indexOf(s) === -1);
  assert('the old literal list would have refused all four (this is the defect)',
    wouldHaveBeenRefused.length === 4, JSON.stringify(wouldHaveBeenRefused));
});

group('Tenant custom stages resolve by their persisted role', () => {
  assert("a custom stage with stageRole 'won' and nothing owed is rateable",
    paid({ stage: 'Roof On & Invoiced', stageRole: 'won' }) === true);
  assert("a custom stage with stageRole 'won' and money owed is NOT",
    paid({ stage: 'Roof On & Invoiced', stageRole: 'won' }, [{ balanceDue: 1200 }]) === false);
  assert("a custom stage with stageRole 'job' claims only 'signed'",
    keyFor({ stage: 'Crew Dispatched', stageRole: 'job' }) === 'signed');
  assert("a custom stage with stageRole 'active' is inspection",
    keyFor({ stage: 'Chasing Adjuster', stageRole: 'active' }) === 'inspection');
  assert('an unknown stage with no role is inspection, not paid',
    keyFor({ stage: 'Whatever The Tenant Typed' }) === 'inspection' && paid({ stage: 'Whatever The Tenant Typed' }) === false,
    'defaulting an unknown stage to complete would be the worst possible failure');
  assert('a lost lead is not rateable', paid({ stage: 'lost', stageRole: 'lost' }) === false);
});

group('It does not throw on the degenerate inputs a real lead can have', () => {
  assert('no stage at all → inspection', keyFor({}) === 'inspection');
  assert('null lead does not throw', keyFor(null) === 'inspection');
  assert('_stageKey wins over stage, as the rest of the file assumes',
    keyFor({ _stageKey: 'closed', stage: 'new' }) === 'review');
});

/* ══════════════════════════════════════════════════════════════════
   2. Both gates go through it — the coupling
   ══════════════════════════════════════════════════════════════════ */
group('One owner, two call sites', () => {
  assert('the portal view resolves progress through the module',
    /const hp = resolveHomeownerProgress\(lead, \{/.test(SRC));
  assert('canRate is derived from that same resolution',
    /canRate: hp\.paidInFull,/.test(SRC));
  assert('the rating submit gate resolves through it too',
    /if \(!paidInFullFor\(lead, ratingInvoices\)\) \{/.test(SRC));
  assert('both read the SAME tenant-filtered invoice list builder',
    /const tenantInvoices = _tenantInvoices\(invSnap\.docs, tenant\);/.test(SRC)
      && /const ratingInvoices = _tenantInvoices\(invDocs, portalTenant\(tok, lead\)\);/.test(SRC));

  // The literal list must be gone, not merely bypassed — and the comment
  // explaining its removal quotes it, so a raw whole-file search matches the
  // explanation. Slice the region out of RAW source FIRST, then strip comments
  // from the slice only: a 40-line window can be reasoned about, and it cannot
  // be satisfied by an unrelated match 2,000 lines away.
  const from = SRC.indexOf('exports.submitCustomerRating');
  const to = SRC.indexOf('exports.', from + 10);
  assert('the submitCustomerRating region was located',
    from > -1 && to > from, 'markers moved — fix the extractor, not the assertion');
  const gate = SRC.slice(from, to).split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert('the sliced gate still contains its own code',
    gate.indexOf('paidInFullFor(lead') > -1 && gate.indexOf('not-complete') > -1);
  assert('no hardcoded completeness list survives in the submit gate',
    gate.indexOf('final_photos') === -1 && gate.indexOf("'closed'") === -1,
    'the gate must not carry its own copy of what "complete" means');
  const defs = (SRC.match(/STAGE_TO_STEP\s*=|STAGE_TO_PROGRESS\s*=/g) || []).length;
  assert('portal.js carries no stage map of its own (the module owns it)', defs === 0,
    'found ' + defs);
});

/* ══════════════════════════════════════════════════════════════════
   3. The 7-day signed URL
   ══════════════════════════════════════════════════════════════════ */
const staleBlock = SRC.slice(
  SRC.indexOf('const HOMEOWNER_URL_TTL_MS'),
  SRC.indexOf('\n}\n', SRC.indexOf('function _homeownerUrlIsStale')) + 3
);
group('The staleness rule is present and liftable', () => {
  assert('found _homeownerUrlIsStale', staleBlock.indexOf('function _homeownerUrlIsStale') > -1);
});
const c2 = {};
vm.createContext(c2);
vm.runInContext(staleBlock + '\nthis.__s = _homeownerUrlIsStale;\nthis.__ttl = HOMEOWNER_URL_TTL_MS;', c2);
const isStale = c2.__s;
const TTL = c2.__ttl;
const NOW = 1_760_000_000_000; // fixed clock; Date.now() is not used by the rule
const days = (n) => n * 24 * 60 * 60 * 1000;

group('It re-signs only when it needs to', () => {
  assert('a URL good for another 6 days is NOT stale',
    isStale({ urlExpiresAt: NOW + days(6) }, NOW) === false);
  assert('a URL with 25 hours left is NOT stale (the 30s poll must not re-sign every tick)',
    isStale({ urlExpiresAt: NOW + days(1) + 3600_000 }, NOW) === false);
  assert('a URL inside the 24h renewal window IS stale',
    isStale({ urlExpiresAt: NOW + 3600_000 }, NOW) === true);
  assert('an already-expired URL IS stale',
    isStale({ urlExpiresAt: NOW - days(1) }, NOW) === true);
  assert('the TTL is the 7-day per-request maximum', TTL === days(7), String(TTL));
});

group('Docs written before urlExpiresAt existed still resolve', () => {
  // Every photo uploaded before this change has no urlExpiresAt. Falling back
  // to uploadedAt is what stops them all being treated as fresh forever.
  const uploadedAt = (ms) => ({ toMillis: () => ms });
  assert('uploaded 8 days ago, no expiry field → stale',
    isStale({ uploadedAt: uploadedAt(NOW - days(8)) }, NOW) === true);
  assert('uploaded 1 day ago, no expiry field → not stale',
    isStale({ uploadedAt: uploadedAt(NOW - days(1)) }, NOW) === false);
  assert('uploaded 6.5 days ago → stale (inside the renewal window)',
    isStale({ uploadedAt: uploadedAt(NOW - days(6.5)) }, NOW) === true);
  assert('neither field → stale, so it gets re-signed rather than left broken',
    isStale({}, NOW) === true);
});

group('Only homeowner uploads with a storage path are touched', () => {
  // Rep photos carry permanent variant URLs in `urls` and no `path` here;
  // re-signing them would be wrong and would cost an IAM call per photo.
  assert('the refresh filters on source === homeowner AND a path',
    /p\.source === 'homeowner' && typeof p\.path === 'string' && p\.path/.test(SRC));
  assert('a failed re-sign keeps the old URL instead of blanking the gallery',
    /catch \(e\) \{[\s\S]{0,260}?logger\.warn\('homeowner photo url refresh failed'/.test(SRC),
    'getSignedUrl needs the IAM token-creator grant; losing it must not blank photos');
  assert('the fresh URL is written back so the REP gallery sees it too',
    /d\.ref\.update\(\{ url, urlExpiresAt: expires \}\)/.test(SRC),
    'the rep customer-page gallery reads the same doc and does not call this');
  assert('the view prefers a freshly-signed URL over the stored one',
    /url:\s+_freshUrls\.get\(d\.id\) \|\| p\.url \|\| null/.test(SRC));
  assert('upload now stamps urlExpiresAt so staleness is knowable',
    /urlExpiresAt: expiresAt,/.test(SRC));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
