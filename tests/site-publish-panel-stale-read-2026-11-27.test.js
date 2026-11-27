/**
 * Settings > Company Profile > "Your website" — after Publish, the panel must
 * say published (2026-11-27).
 *
 * The @stranger E2E shard went red on 2026-11-26 across five unrelated PRs:
 * publishTenantSite wrote companies/{id}.sitePublished:true (the spec's admin
 * poll saw it), yet #cp-site-status kept "Your site is private" for 15 s.
 * After the callable, the panel re-read the companies doc and painted
 * whatever that read said. Two ways it painted the stale "private":
 *   1. the re-read is this device's cached copy (getDoc resolves fromCache
 *      when the SDK thinks it is offline; the company-profile loader already
 *      refuses such reads for the same reason), and the callable's own
 *      answer, { published: true }, was thrown away;
 *   2. an EARLIER load (opening the tab starts one behind a slow
 *      _loadCompanyProfile) resolves after the publish's load and paints its
 *      older read over the newer one.
 * The serial retry then re-ran the whole journey, and provision hit a second
 * wall (the reused "ESR1" seal; fixed in tests/e2e/stranger.spec.js).
 *
 * Runs the real panel code, extracted verbatim from
 * docs/pro/js/dashboard-bootstrap.module.js by indexOf anchors, against a
 * fake DOM and Firestore. Pure Node. Run: node tests/site-publish-panel-stale-read-2026-11-27.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'js', 'dashboard-bootstrap.module.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const START = '  function _siteCompanyKey() {';
const END_ANCHOR = '  const _unpublishSite = function () { return _callPublishTenantSite(false); };';
const a = SRC.indexOf(START);
const b = SRC.indexOf(END_ANCHOR);
ok('panel code located (anchors found, in order)', a > 0 && b > a, 'start ' + a + ', end ' + b);
if (!(a > 0 && b > a)) { console.log('\n' + passed + ' passed, ' + failed + ' failed'); process.exit(1); }
const BLOCK = SRC.slice(a, b + END_ANCHOR.length);

function el() { return { textContent: '', hidden: false, value: '', href: '', classList: { toggle() {} } }; }

/**
 * Build one panel instance. `reads` is a queue of controllers: each getDoc
 * call takes the next one and waits for it to be resolved by the test.
 * `callable` is what publishTenantSite resolves with.
 */
function makePanel(callable) {
  const els = { 'cp-site-status': el(), 'cp-site-publish-btn': el(), 'cp-site-unpublish-btn': el(), 'cp-site-link': el(), cp_siteSlug: el() };
  const pending = [];
  const getDoc = () => new Promise((resolve) => {
    // data() hands back a fresh object each call, as the real SDK does.
    pending.push((data) => resolve({ exists: () => !!data, data: () => (data ? Object.assign({}, data) : data) }));
  });
  const window = {
    location: { origin: 'http://127.0.0.1:5000' },
    _user: { uid: 'U1' },
    _userClaims: { companyId: 'U1' },
    _functions: {},
    _httpsCallable: () => async () => ({ data: callable }),
  };
  const document = { getElementById: (id) => els[id] || null };
  const factory = new Function('window', 'document', 'db', 'getDoc', 'doc', 'connectEmulatorsIfLocal', 'showToast',
    BLOCK + '\nreturn { _loadSiteSlug, _publishSite, _unpublishSite };');
  const api = factory(window, document, {}, getDoc, () => ({}), async () => {}, () => {});
  return { api, els, pending };
}

const tick = () => new Promise((r) => setImmediate(r));
const PRIVATE = { status: 'active', sitePublished: false };
const LIVE = { status: 'active', sitePublished: true };

(async () => {
  console.log('\nSITE PUBLISH PANEL — after Publish the panel says published');

  // 1. The re-read after a successful publish returns this device's cached
  //    copy (still private). The callable already said published: true.
  {
    const { api, els, pending } = makePanel({ ok: true, published: true });
    const done = api._publishSite();
    for (let i = 0; i < 5 && !pending.length; i++) await tick();
    pending.shift()(PRIVATE); // stale cached read
    await done;
    ok('cached re-read after Publish: status says published (callable verdict wins)',
      /published/i.test(els['cp-site-status'].textContent), JSON.stringify(els['cp-site-status'].textContent));
    ok('cached re-read after Publish: Unpublish offered, Publish hidden',
      els['cp-site-unpublish-btn'].hidden === false && els['cp-site-publish-btn'].hidden === true);
  }

  // 2. Same, the other direction: Unpublish answered published:false, a cached
  //    read still says live.
  {
    const { api, els, pending } = makePanel({ ok: true, published: false });
    const done = api._unpublishSite();
    for (let i = 0; i < 5 && !pending.length; i++) await tick();
    pending.shift()(LIVE);
    await done;
    ok('cached re-read after Unpublish: status says private', /private/i.test(els['cp-site-status'].textContent),
      JSON.stringify(els['cp-site-status'].textContent));
  }

  // 3. Out of order: the tab-open load starts first, the publish load second;
  //    the publish load lands, THEN the older one resolves with its older read.
  {
    const { api, els, pending } = makePanel({ ok: true, published: true });
    const older = api._loadSiteSlug();
    await tick();
    const pub = api._publishSite();
    for (let i = 0; i < 5 && pending.length < 2; i++) await tick();
    ok('two reads in flight', pending.length === 2, 'pending ' + pending.length);
    const [resolveOlder, resolveNewer] = pending.splice(0, 2);
    resolveNewer(LIVE);
    await pub;
    resolveOlder(PRIVATE);
    await older;
    ok('an older load resolving last does not repaint "private" over "published"',
      /published/i.test(els['cp-site-status'].textContent), JSON.stringify(els['cp-site-status'].textContent));
  }

  // 4. Control: a plain load still paints exactly what the doc says.
  {
    const { api, els, pending } = makePanel({ ok: true, published: true });
    const p = api._loadSiteSlug();
    await tick();
    pending.shift()(PRIVATE);
    await p;
    ok('control: a plain load of an unpublished site says private', /private/i.test(els['cp-site-status'].textContent));
    const q = api._loadSiteSlug();
    await tick();
    pending.shift()(LIVE);
    await q;
    ok('control: a plain load of a published site says published', /published/i.test(els['cp-site-status'].textContent));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
