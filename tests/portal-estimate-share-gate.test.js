/* portal-estimate-share-gate.test.js
 *
 * The homeowner portal must never publish an estimate the rep did not
 * deliberately share.
 *
 * getHomeownerPortalView used to take `estimates[0]` after a createdAt-desc
 * sort with NO filter. Estimates are created with only
 * {createdAt, userId, companyId} — no status, no sentAt, no share flag — so
 * every save was portal-eligible within seconds. A rep pricing three tiers
 * side by side published the scratch one, labelled "Draft" beside a real
 * dollar figure; a null total rendered as a 36px orange em-dash under the
 * word TOTAL.
 *
 * This suite lifts the REAL predicate out of functions/portal.js and runs it
 * in a vm, rather than regex-matching the source — so editing the predicate
 * re-runs these cases against the edit instead of matching a string that
 * happens to still be there.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Normalise EOLs: the working tree is CRLF on Windows and LF in the index,
// so any multi-line pattern below would match on CI and miss locally (or the
// reverse) if this read raw.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PORTAL_FN = read('functions/portal.js');
const PORTAL_JS = read('docs/pro/js/portal.js');
const BOOT = read('docs/pro/js/customer-bootstrap.module.js');
const RULES = read('firestore.rules');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── lift the real predicate ── */
const block = PORTAL_FN.match(
  /const SHARED_SIG = \[[^\]]*\];[\s\S]{0,400}?const isSharedEstimate = \([\s\S]*?;\n/
);

group('The predicate is present and liftable', () => {
  assert('found SHARED_SIG + isSharedEstimate in functions/portal.js', !!block,
    'if this moved, update the extractor — do NOT delete the suite');
});
if (!block) { console.log('\ncannot continue without the predicate'); process.exit(1); }

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block[0] + '\nthis.__p = isSharedEstimate;', sandbox);
const isShared = sandbox.__p;

group('Only a deliberately-shared estimate qualifies', () => {
  assert('a bare freshly-created estimate is NOT shared',
    isShared({ createdAt: 1, userId: 'u', companyId: 'c' }) === false);
  assert('grandTotal alone does not make it shared (the scratch-tier case)',
    isShared({ grandTotal: 24500 }) === false);
  assert('signatureStatus "none" is NOT shared',
    isShared({ signatureStatus: 'none' }) === false);
  assert('an explicitly shared estimate qualifies',
    isShared({ sharedWithHomeowner: true }) === true);
  assert('sharedWithHomeowner must be a real true, not truthy junk',
    isShared({ sharedWithHomeowner: 'yes' }) === false);
  for (const s of ['sent', 'viewed', 'signed', 'declined', 'expired']) {
    assert('signatureStatus "' + s + '" qualifies', isShared({ signatureStatus: s }) === true);
  }
  assert('sentAt qualifies', isShared({ sentAt: 1699999999 }) === true);
  assert('empty sentAt does not', isShared({ sentAt: '' }) === false);
});

group('The selection uses the predicate, not the newest doc', () => {
  // 2026-11-14 (finding 6): the pick moved into portal-after-signing.js
  // pickPortalEstimate (prefer the signed estimate), still behind the predicate.
  assert('picks through the share predicate (pickPortalEstimate(estimates, isSharedEstimate, …))',
    /const latest = PAS\.pickPortalEstimate\(estimates, isSharedEstimate, _deals\);/.test(PORTAL_FN),
    'reverting to estimates[0] re-opens the leak');
  {
    const PAS = require(path.join(ROOT, 'functions', 'portal-after-signing.js'));
    const shared = (e) => e.sharedWithHomeowner === true;
    const signedUnshared = { id: 'a', signatureStatus: 'signed', signedPrice: { totalCents: 100 } };
    assert('pickPortalEstimate never returns an unshared estimate, even a signed one',
      PAS.pickPortalEstimate([signedUnshared], shared, []) === null);
    assert('…and returns the newest shared one when none is signed',
      (PAS.pickPortalEstimate([{ id: 'x' }, { id: 'y', sharedWithHomeowner: true }, { id: 'z', sharedWithHomeowner: true }], shared, []) || {}).id === 'y');
  }
  assert('no bare estimates[0] selection remains',
    !/const latest = estimates\[0\]/.test(PORTAL_FN));

  // The ordering still has to be newest-first, or "latest shared" is a lie.
  assert('still sorted createdAt desc before the find',
    /estimates\.sort\(\(a, b\) => \{[\s\S]{0,200}return tb - ta;/.test(PORTAL_FN));
});

group('Nothing is grandfathered (the deliberate choice, 2026-09-07)', () => {
  // A pre-existing estimate has none of the three signals.
  assert('a legacy estimate stays hidden until re-shared',
    isShared({ createdAt: 1, grandTotal: 18000, tierName: 'Reroof Plus', userId: 'u' }) === false);
});

group('Rep side: the Share button persists the decision', () => {
  // Anchor on the DEFINITION, not the first mention — the .nbd-est-share
  // click wiring names it ~30 lines earlier, and a window from there stopped
  // short of the stamp.
  const i = BOOT.indexOf('window.shareEstimateViewLink = async function');
  const region = i === -1 ? '' : BOOT.slice(i, i + 6000);
  assert('shareEstimateViewLink is defined', i !== -1);
  assert('it stamps sharedWithHomeowner: true', /sharedWithHomeowner: true/.test(region));
  assert('and a sharedAt timestamp', /sharedAt: serverTimestamp\(\)/.test(region));
  assert('the stamp is best-effort — a failure must not cost the rep the link',
    /catch \(e\) \{[\s\S]{0,160}estimate-share/.test(region));
});

group('Firestore lets the owner write the flag, and still protects provenance', () => {
  const upd = RULES.match(/allow update: if \(isOwner\(resource\.data\.userId\)[\s\S]{0,400}?didNotChange\(\[([^\]]*)\]\)/);
  assert('estimates update rule found', !!upd);
  if (upd) {
    assert('sharedWithHomeowner is NOT frozen (the rep must be able to set it)',
      !/sharedWithHomeowner/.test(upd[1]));
    assert('server-stamped view counters are still frozen',
      /viewCount/.test(upd[1]) && /viewedAt/.test(upd[1]));
  }
});

group('Portal client stops rendering a broken/alarming card', () => {
  assert('no em-dash money block — a missing total says so in words',
    /Your rep is still putting the numbers together/.test(PORTAL_JS));
  assert('the total is gated on hasTotal', /const hasTotal = e\.grandTotal != null/.test(PORTAL_JS));
  // Strip comments first: the change note deliberately quotes the old markup,
  // and the first draft of this assertion matched its own comment.
  const portalCode = PORTAL_JS
    // Line-wise: a /\*...\*/ regex swallows real code in these files (they
    // contain comment-looking sequences inside regex literals and strings —
    // measured 10-48% of the file destroyed), which makes ABSENCE assertions
    // pass against a corpus that no longer holds the region they guard.
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
  assert('the homeowner is never told their contract is a "Draft"',
    !/<span class="pill">Draft<\/span>/.test(portalCode));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
