/* portal-preview-framing.test.js
 *
 * The CRM's "Portal preview" modal embeds the homeowner portal in a
 * same-origin iframe so a rep can check what the homeowner will see before
 * texting them the link. It is reached from eleven surfaces (kanban context
 * menu, activity feed, global search, notification bell, hot-leads /
 * almost-there / stale-shares widgets, smart-followup briefing, dashboard
 * bootstrap, customer-gallery-share).
 *
 * It had never worked. Two independent faults, and fixing either alone still
 * leaves a broken preview:
 *
 *   1. /pro/portal inherited the global "**" rule's X-Frame-Options: DENY and
 *      CSP frame-ancestors 'none', so the embed was refused in every browser.
 *      Confirmed against production on 2026-09-08 by fetching the real
 *      headers, not by reading firebase.json.
 *
 *   2. The modal's block-detection was written when resolveUrl returned a
 *      cross-origin Firebase Storage getDownloadURL, and reasoned "a readable
 *      contentWindow means a privacy shield injected a block page". resolveUrl
 *      now mints a SAME-ORIGIN /pro/portal.html?token=… and returns nothing
 *      else, so a perfectly good load reads fine and was declared blocked —
 *      under a message telling the rep their own browser was at fault.
 *
 * So this suite guards BOTH halves, plus the coupling between them: detection
 * keys on #mainWrap in portal.html's static markup, and renaming that element
 * would silently make every preview report itself blocked again.
 *
 * The detection half runs the REAL function in a vm against fake frames rather
 * than regex-matching this file — editing the predicate re-runs these cases
 * against the edit.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Normalise EOLs: the working tree is CRLF on Windows and LF in the index, so
// any multi-line pattern below would match on CI and miss locally (or the
// reverse) if this read raw.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const HELPERS = read('docs/pro/js/portal-link-helpers.js');
const PORTAL_HTML = read('docs/pro/portal.html');
const FIREBASE = JSON.parse(read('firebase.json'));

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── helpers ── */
const rules = FIREBASE.hosting.headers;
const headerVal = (rule, key) => {
  const h = ((rule && rule.headers) || []).find((x) => x.key === key);
  return h && h.value;
};
// Parse a CSP value into {directive: [tokens]}.
const parseCsp = (v) => {
  const out = {};
  String(v || '').split(';').forEach((part) => {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length) out[bits[0]] = bits.slice(1);
  });
  return out;
};

const globalRule = rules.find((r) => r.source === '**');
const portalRules = rules.filter((r) => r.source === '/pro/portal');
const portalRule = portalRules[0];

/* ══════════════════════════════════════════════════════════════════
   1. Hosting grants same-origin framing to /pro/portal — and only that
   ══════════════════════════════════════════════════════════════════ */
group('firebase.json: /pro/portal is frameable by our own origin', () => {
  assert('a global "**" header rule still exists', !!globalRule);
  assert('exactly one /pro/portal header rule exists', portalRules.length === 1,
    'found ' + portalRules.length + ' — two rules for one path is how a framing '
    + 'override silently loses to, or masks, another');
});
if (!portalRule || !globalRule) {
  console.log('\ncannot continue without both rules');
  console.log(passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
}

group('The override is last-match-wins and narrow', () => {
  const iPortal = rules.findIndex((r) => r.source === '/pro/portal');
  const iGlobal = rules.findIndex((r) => r.source === '**');
  // firebase.json's own comment above the /assets/css/** block records that
  // header matching is last-match-wins per key. An override placed BEFORE the
  // global rule is inert.
  assert('the /pro/portal rule comes AFTER the global "**" rule', iPortal > iGlobal,
    'index ' + iPortal + ' vs global ' + iGlobal + ' — last-match-wins, so an '
    + 'earlier override is silently overwritten by DENY');

  assert('X-Frame-Options is SAMEORIGIN', headerVal(portalRule, 'X-Frame-Options') === 'SAMEORIGIN',
    'got ' + JSON.stringify(headerVal(portalRule, 'X-Frame-Options')));

  const csp = parseCsp(headerVal(portalRule, 'Content-Security-Policy'));
  assert("CSP frame-ancestors is exactly 'self'",
    JSON.stringify(csp['frame-ancestors']) === JSON.stringify(["'self'"]),
    'got ' + JSON.stringify(csp['frame-ancestors']));

  const cspRo = parseCsp(headerVal(portalRule, 'Content-Security-Policy-Report-Only'));
  // Leaving Report-Only at 'none' contradicts the enforced policy on every
  // embed. /pro/ai-tree still does exactly that.
  assert("Report-Only frame-ancestors is exactly 'self' (agrees with enforced)",
    JSON.stringify(cspRo['frame-ancestors']) === JSON.stringify(["'self'"]),
    'got ' + JSON.stringify(cspRo['frame-ancestors']));

  // Clickjacking guard: same-origin only. A wildcard or an external origin
  // here would let any site frame a homeowner's portal.
  const fa = (csp['frame-ancestors'] || []).join(' ');
  assert('frame-ancestors admits no wildcard and no external origin',
    !/\*/.test(fa) && !/https?:/i.test(fa), 'got ' + JSON.stringify(fa));
});

group('The rest of the site is NOT loosened', () => {
  assert('the global rule still sends X-Frame-Options: DENY',
    headerVal(globalRule, 'X-Frame-Options') === 'DENY');
  const g = parseCsp(headerVal(globalRule, 'Content-Security-Policy'));
  assert("the global rule still sends frame-ancestors 'none'",
    JSON.stringify(g['frame-ancestors']) === JSON.stringify(["'none'"]));
});

group('The portal policy is the global policy, differing only in framing', () => {
  // Drift guard. The portal's CSP was DERIVED from the global one rather than
  // copied off the AI TOOLS block, whose img-src/connect-src lists are
  // narrower and would silently drop the portal's imagery hosts. If someone
  // later tightens or extends the global policy, this reddens instead of
  // leaving the portal on a stale copy.
  const pair = [
    ['Content-Security-Policy', 'enforced'],
    ['Content-Security-Policy-Report-Only', 'report-only'],
  ];
  pair.forEach(([key, label]) => {
    const g = headerVal(globalRule, key);
    const p = headerVal(portalRule, key);
    assert('the ' + label + ' policy exists on both rules', !!g && !!p);
    if (!g || !p) return;
    const normalised = String(p).replace("frame-ancestors 'self'", "frame-ancestors 'none'");
    // Second deliberate difference (2026-10-01): the global rule admits
    // Microsoft Clarity for the public marketing pages; the homeowner portal
    // shows customer details and must never be session-recorded, so its CSP
    // deliberately does NOT admit the Clarity hosts. Compare with them removed
    // from the global side.
    const CLARITY = / https:\/\/(www|scripts|\*)\.clarity\.ms| https:\/\/c\.bing\.com/g;
    assert('the ' + label + ' portal policy never admits Microsoft Clarity', !/clarity\.ms|c\.bing\.com/.test(String(p)));
    assert('the ' + label + ' policy matches the global one once framing is normalised',
      normalised === String(g).replace(CLARITY, ''),
      'the portal policy has drifted from the global one in more than '
      + 'frame-ancestors (and the deliberate Clarity exclusion) — re-derive it rather than hand-editing');
  });
});

/* ══════════════════════════════════════════════════════════════════
   2. The detection predicate — the real function, against fake frames
   ══════════════════════════════════════════════════════════════════ */
const block = HELPERS.match(
  /var PORTAL_FRAME_SENTINEL = [\s\S]*?\n {2}}\n/
);

group('The detection predicate is present and liftable', () => {
  assert('found PORTAL_FRAME_SENTINEL + _portalRenderedInFrame in portal-link-helpers.js',
    !!block, 'if this moved, update the extractor — do NOT delete the suite');
});
if (!block) {
  console.log('\ncannot continue without the predicate');
  console.log(passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block[0] + '\nthis.__p = _portalRenderedInFrame;\nthis.__s = PORTAL_FRAME_SENTINEL;', sandbox);
const rendered = sandbox.__p;
const SENTINEL = sandbox.__s;

// A frame whose contentDocument exposes just enough of the DOM API.
const frameWithIds = (ids) => ({
  contentDocument: { getElementById: (id) => (ids.indexOf(id) >= 0 ? { id: id } : null) },
});

group('It says YES only to a document that is actually the portal', () => {
  assert('the real portal (its sentinel present) → rendered',
    rendered(frameWithIds([SENTINEL, 'heroWrap', 'loadingState'])) === true);

  // A refused frame is engine-dependent: measured against production on
  // 2026-09-08, Chrome leaves it OPAQUE (covered below, in the fail-closed
  // group); other engines leave a readable but empty document. Both must
  // score as blocked, which is the whole reason detection is positive rather
  // than inferred from readability.
  assert('a readable but empty frame (refusal, engine leaves about:blank) → NOT rendered',
    rendered(frameWithIds([])) === false);

  // A privacy shield injects its own page rather than ours.
  assert("a shield's injected block page → NOT rendered",
    rendered(frameWithIds(['brave-shields-blocked-root'])) === false);

  assert('a redirect to some other same-origin page → NOT rendered',
    rendered(frameWithIds(['loginForm', 'app'])) === false);
});

group('It fails closed on every way the frame can be unreadable', () => {
  // These two ARE the X-Frame-Options refusal as Chrome actually renders it,
  // measured against production: the frame goes opaque, contentDocument is
  // null and touching contentWindow.location throws. The old probe scored
  // precisely this as success and hid the overlay over an empty frame — which
  // is why the reported symptom was a blank panel, not a warning.
  assert('an opaque refused frame (contentDocument null) → NOT rendered',
    rendered({ contentDocument: null }) === false);
  assert('contentDocument absent → NOT rendered', rendered({}) === false);
  assert('a SecurityError thrown on access → NOT rendered', rendered({
    get contentDocument() { throw new Error('SecurityError: Blocked a frame'); },
  }) === false);
  assert('getElementById throwing → NOT rendered', rendered({
    contentDocument: { getElementById: () => { throw new Error('boom'); } },
  }) === false);
  assert('a null frame → NOT rendered', rendered(null) === false);
  assert('an undefined frame → NOT rendered', rendered(undefined) === false);
});

/* ══════════════════════════════════════════════════════════════════
   3. The coupling: the sentinel must exist in portal.html
   ══════════════════════════════════════════════════════════════════ */
group('The sentinel is real, and static', () => {
  // Detection runs on the iframe's `load` event, so the element has to be in
  // the served markup — an element the portal's JS injects after a callable
  // resolves would make every preview report itself blocked.
  const tag = new RegExp('<[a-z]+[^>]*\\bid="' + SENTINEL + '"', 'i');
  assert('portal.html ships id="' + SENTINEL + '" in its static markup',
    tag.test(PORTAL_HTML),
    'renaming this element silently breaks every portal preview — update both '
    + 'sides together');

  // And it must be exactly one element: getElementById would still find the
  // first, but a duplicate id is the kind of drift that precedes a rename.
  const count = (PORTAL_HTML.match(new RegExp('id="' + SENTINEL + '"', 'g')) || []).length;
  assert('exactly one element carries that id', count === 1, 'found ' + count);
});

/* ══════════════════════════════════════════════════════════════════
   4. The modal wires the predicate up, and no longer blames the visitor
   ══════════════════════════════════════════════════════════════════ */
group('The modal uses the predicate and states the truth', () => {
  assert("the iframe's load handler routes through _portalRenderedInFrame",
    /addEventListener\('load',[\s\S]{0,200}?_portalRenderedInFrame\(iframe\)/.test(HELPERS),
    'detection exists but nothing calls it — the exact shape of the '
    + 'renderPanel/renderScorePanel and PhotoEngine.getPhotosForLead defects');

  assert('the predicate is exported for this suite to lift',
    /_portalRenderedInFrame,/.test(HELPERS.slice(HELPERS.indexOf('window.PortalLinkHelpers'))));

  // The old copy asserted something false about the visitor's browser on a
  // failure our own headers caused. Strip comments LINE-WISE first: a future
  // comment quoting the retired string would otherwise make this assertion
  // fail on correct code (it did, in the sibling suite), and a block-comment
  // stripper eats regex literals in these files, which would make an absence
  // assertion pass vacuously.
  const strippedHelpers = HELPERS.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert('the stripper did not eat the code it guards',
    strippedHelpers.indexOf('_openPreviewModal') > -1
      && strippedHelpers.length > HELPERS.length * 0.5);
  assert('the modal no longer claims "Your browser blocked the embedded preview"',
    strippedHelpers.indexOf('Your browser blocked the embedded preview') === -1);

  assert('the sandboxed iframe still keeps same-origin access (detection needs it)',
    /sandbox="[^"]*allow-same-origin[^"]*"/.test(HELPERS),
    'without allow-same-origin the frame is opaque and every preview reports blocked');
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
