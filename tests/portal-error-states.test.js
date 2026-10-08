/* portal-error-states.test.js
 *
 * The homeowner portal must not tell a customer to wait when waiting can
 * never work.
 *
 * getHomeownerPortalView has five distinct terminal outcomes. portal.js used
 * to render specific copy for two (410 expired, 404 not-found) and route the
 * rest to "Couldn't load your project — Please try again in a moment."
 * Two of those can never succeed on a retry, and both are reachable in
 * ordinary use:
 *
 *   400  the link arrived truncated — SMS and email clients wrap and clip
 *        long URLs, and functions/portal.js rejects the remainder against
 *        /^[A-Za-z0-9]{10,64}$/
 *   429  the replay cap. Tokens are minted with maxUses:100 against a 30-day
 *        TTL and only genuine opens count (polls are exempt), so a homeowner
 *        checking progress a few times a day during an active job reaches it
 *        inside a month.
 *
 * Verified against the live endpoint on 2026-09-08: a 19-character token
 * returns 400, a 64-character unknown one returns 404.
 *
 * The suite lifts the REAL mapping out of docs/pro/js/portal.js and runs it in
 * a vm, so editing the copy or the branching re-runs these cases against the
 * edit rather than matching a string that happens to still be there. It also
 * asserts the CONTRACT between the two files: every `code` the backend emits
 * from that endpoint must have a client case, or it silently degrades to the
 * generic transient message this suite exists to prevent.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
// Normalise EOLs: the working tree is CRLF on Windows and LF in the index.
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PORTAL_JS = read('docs/pro/js/portal.js');
const PORTAL_FN = read('functions/portal.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* ── lift the real mapping ── */
const block = PORTAL_JS.match(/function _errorStateFor\(status, code\) \{[\s\S]*?\n {2}\}\n/);

group('The mapping is present and liftable', () => {
  assert('found _errorStateFor in docs/pro/js/portal.js', !!block,
    'if this moved, update the extractor — do NOT delete the suite');
});
if (!block) {
  console.log('\ncannot continue without the mapping');
  console.log(passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(block[0] + '\nthis.__f = _errorStateFor;', sandbox);
const stateFor = sandbox.__f;

// Phrases that promise a retry will help. Any of these on a terminal state is
// the defect this suite guards.
const RETRY_PROMISE = /try again in a moment|try again later|please try again|in a moment/i;
// Every state must point somewhere the customer can actually go.
const NAMES_A_NEXT_STEP = /\brep\b|refresh|connection/i;

/* ══════════════════════════════════════════════════════════════════
   1. The two states that used to lie
   ══════════════════════════════════════════════════════════════════ */
group('A truncated link (400) is terminal and says so', () => {
  const s = stateFor(400, 'bad_token');
  assert('not marked transient', s.transient === false);
  assert('does not promise that retrying helps', !RETRY_PROMISE.test(s.title + ' ' + s.body),
    JSON.stringify(s));
  assert('tells the customer to ask their rep to re-send', /rep/i.test(s.body), JSON.stringify(s));
  assert('names the cause a homeowner can recognise (a clipped text link)',
    /cut short|text message|incomplete/i.test(s.title + ' ' + s.body), JSON.stringify(s));
});

group('The replay cap (429 too_many_opens) is terminal and says so', () => {
  const s = stateFor(429, 'too_many_opens');
  assert('not marked transient', s.transient === false);
  assert('does not promise that retrying helps', !RETRY_PROMISE.test(s.title + ' ' + s.body),
    JSON.stringify(s));
  assert('tells the customer to ask their rep for a fresh link', /rep/i.test(s.body),
    JSON.stringify(s));
  // The distinction that matters: the OTHER 429 (per-IP limiter, 30/min) does
  // clear on its own, so a code-less 429 must not be called terminal.
  const bare = stateFor(429, null);
  assert('a 429 with no code stays transient (it may be the per-IP limiter)',
    bare.transient === true, JSON.stringify(bare));
  assert('...and still names the escalation', /rep/i.test(bare.body), JSON.stringify(bare));
});

/* ══════════════════════════════════════════════════════════════════
   2. The states that already worked must not regress
   ══════════════════════════════════════════════════════════════════ */
group('Expired and not-found keep their specific copy', () => {
  const exp = stateFor(410, 'expired');
  assert('410 is terminal', exp.transient === false);
  assert('410 says expired', /expired/i.test(exp.title), JSON.stringify(exp));
  assert('410 does not promise a retry', !RETRY_PROMISE.test(exp.title + ' ' + exp.body));

  const nf = stateFor(404, 'unknown_link');
  assert('404 is terminal', nf.transient === false);
  assert("404 says we can't find it", /can't find|cannot find/i.test(nf.title), JSON.stringify(nf));
  assert('404 does not promise a retry', !RETRY_PROMISE.test(nf.title + ' ' + nf.body));

  const pm = stateFor(404, 'project_missing');
  assert('a missing lead reads as not-found too, not as a network blip',
    pm.transient === false, JSON.stringify(pm));
});

/* ══════════════════════════════════════════════════════════════════
   3. Genuinely transient states are ALLOWED to say so
   ══════════════════════════════════════════════════════════════════ */
group('Only genuinely transient states invite a refresh', () => {
  const net = stateFor(0, null);   // fetch threw: offline, DNS, CORS
  assert('a thrown fetch is transient', net.transient === true);
  assert('...and names a next step', NAMES_A_NEXT_STEP.test(net.body), JSON.stringify(net));

  const five = stateFor(500, null);
  assert('a 500 is transient', five.transient === true);
  assert('a 503 is transient', stateFor(503, null).transient === true);
});

/* ══════════════════════════════════════════════════════════════════
   4. Fallback: the page stays correct against an un-redeployed backend
   ══════════════════════════════════════════════════════════════════ */
group('Status-only fallback matches the coded behaviour', () => {
  [[400, 'bad_token'], [404, 'unknown_link'], [410, 'expired']].forEach(([status, code]) => {
    const withCode = stateFor(status, code);
    const without = stateFor(status, null);
    assert('a bare ' + status + ' renders the same copy as ' + code,
      without.title === withCode.title && without.body === withCode.body
        && without.transient === withCode.transient,
      JSON.stringify({ withCode, without }));
  });
  assert('an unrecognised code does not crash and falls back to the status',
    stateFor(410, 'some_future_code').transient === false);
});

/* ══════════════════════════════════════════════════════════════════
   5. Every state is well-formed
   ══════════════════════════════════════════════════════════════════ */
group('Every state is renderable and useful', () => {
  const cases = [
    [400, 'bad_token'], [404, 'unknown_link'], [404, 'project_missing'],
    [410, 'expired'], [429, 'too_many_opens'], [429, null], [500, null], [0, null],
  ];
  let ok = true, badNext = [], badShape = [];
  cases.forEach(([s, c]) => {
    const r = stateFor(s, c);
    if (!r || typeof r.title !== 'string' || typeof r.body !== 'string'
      || typeof r.transient !== 'boolean' || !r.title || !r.body) {
      ok = false; badShape.push(s + '/' + c);
    } else if (!NAMES_A_NEXT_STEP.test(r.body)) {
      badNext.push(s + '/' + c + ': ' + r.body);
    }
  });
  assert('every case returns {title, body, transient} fully populated', ok, badShape.join('; '));
  assert('every case tells the customer where to go next', badNext.length === 0, badNext.join('; '));

  const terminal = cases.filter(([s, c]) => stateFor(s, c).transient === false);
  assert('no terminal state promises a retry will help',
    terminal.every(([s, c]) => {
      const r = stateFor(s, c);
      return !RETRY_PROMISE.test(r.title + ' ' + r.body);
    }),
    'this is the whole point of the suite');
  assert('at least five distinct terminal states exist', terminal.length >= 5,
    'found ' + terminal.length);
});

/* ══════════════════════════════════════════════════════════════════
   6. The contract with the backend
   ══════════════════════════════════════════════════════════════════ */
group('Backend codes and client cases agree', () => {
  // Scope to getHomeownerPortalView. Since 2026-10-08 (review R3 item 3) its
  // link refusals (unknown link / expired / replay cap / lead mismatch) come
  // from the ONE shared check in functions/portal-authz.js, which the six
  // homeowner action endpoints now use too — so the codes are the view's own
  // literals PLUS whatever that real check returns, driven below.
  const start = PORTAL_FN.indexOf('exports.getHomeownerPortalView');
  const after = PORTAL_FN.indexOf('exports.getPortalDocumentHtml');
  assert('both endpoint boundaries were found', start > 0 && after > start);
  const body = PORTAL_FN.slice(start, after);
  const AUTHZ = require(path.join(ROOT, 'functions/portal-authz.js'));
  const NOW = Date.now();
  const ts = (ms) => ({ toMillis: () => ms });
  const live = { leadId: 'L1', ownerUid: 'r', companyId: 'coA', expiresAt: ts(NOW + 86400e3), uses: 0, maxUses: 100 };
  const refusals = {
    unknown: AUTHZ.portalTokenRefusal(null, NOW),
    expired: AUTHZ.portalTokenRefusal(Object.assign({}, live, { expiresAt: ts(NOW - 1) }), NOW),
    cap: AUTHZ.portalTokenRefusal(Object.assign({}, live, { uses: 100 }), NOW),
    otherTenant: AUTHZ.portalLinkRefusal(live, { companyId: 'coB' }, NOW),
    noLead: AUTHZ.portalLinkRefusal(live, null, NOW),
  };
  assert('the view routes its link refusals through the shared check (token half, then lead half)',
    /portalTokenRefusal\(tok, Date\.now\(\)\)[\s\S]{0,120}res\.status\(tokRefusal\.status\)\.json\(\{ error: tokRefusal\.error, code: tokRefusal\.code \}\)/.test(body)
      && /portalLinkRefusal\(tok, lead, Date\.now\(\)\)[\s\S]{0,120}res\.status\(linkRefusal\.status\)\.json\(\{ error: linkRefusal\.error, code: linkRefusal\.code \}\)/.test(body));

  // Digits belong in the character class. Written as [a-z_]+ this silently
  // failed to match a code like 'project_missing_v2' at all, so a break-test
  // that introduced exactly that code was scored as "count too low" instead of
  // "unhandled code" — the contract assertion below never saw it and passed
  // vacuously. Caught by checking WHICH assertion reddened.
  const emitted = [...new Set(
    [...body.matchAll(/code:\s*'([a-z0-9_]+)'/g)].map((m) => m[1])
      .concat(Object.values(refusals).map((r) => r && r.code).filter(Boolean))
  )].sort();

  assert('the endpoint emits a code on every error it returns',
    emitted.length >= 5, 'found: ' + emitted.join(', '));

  // The real coupling test: an emitted code with no client case falls through
  // to the generic transient message — silently re-creating the defect.
  const unhandled = emitted.filter((c) => {
    const viaCode = stateFor(599, c);          // a status with no fallback
    const generic = stateFor(599, null);
    return viaCode.title === generic.title;
  });
  assert('every emitted code has its own client case', unhandled.length === 0,
    'unhandled: ' + unhandled.join(', ') + ' — these render the generic '
    + '"check your connection" message, which is what this suite exists to stop');

  // And the statuses were not quietly changed out from under the fallback.
  assert('the truncated-token guard still answers 400',
    /res\.status\(400\)\.json\(\{ error: 'Invalid token', code: 'bad_token' \}\)/.test(body));
  assert('the replay cap still answers 429',
    !!refusals.cap && refusals.cap.status === 429 && refusals.cap.code === 'too_many_opens', JSON.stringify(refusals.cap));
  assert('expiry still answers 410',
    !!refusals.expired && refusals.expired.status === 410 && refusals.expired.code === 'expired', JSON.stringify(refusals.expired));
  assert('an unknown link still answers 404 unknown_link, a lead mismatch 404 project_missing',
    refusals.unknown.status === 404 && refusals.unknown.code === 'unknown_link'
      && refusals.otherTenant.status === 404 && refusals.otherTenant.code === 'project_missing'
      && refusals.noLead.status === 404 && refusals.noLead.code === 'project_missing');
});

/* ══════════════════════════════════════════════════════════════════
   7. The page is actually wired to it
   ══════════════════════════════════════════════════════════════════ */
group('loadView routes every failure through the mapping', () => {
  assert('the non-ok branch reads the body code and renders through _renderError',
    /if \(!res\.ok\) \{[\s\S]{0,420}?_renderError\(main, _errorStateFor\(res\.status, code\)\)/.test(PORTAL_JS),
    'the status branches must not render their own inline copy again');

  assert('the catch renders through the mapping too',
    /catch \(e\) \{[\s\S]{0,300}?_renderError\(main, _errorStateFor\(0, null\)\)/.test(PORTAL_JS));

  assert('reading the error body cannot break a valid status (it is guarded)',
    /try \{ code = \(await res\.clone\(\)\.json\(\)\)\.code \|\| null; \} catch \(_\) \{\}/.test(PORTAL_JS),
    'a non-JSON body must not turn a clean 410 into the network message');

  // The old inline copy must be gone from every branch, not just one.
  //
  // Strip comments first, LINE-WISE. Two traps, both already paid for in this
  // repo: (a) the comment above _errorStateFor quotes the retired string to
  // explain why it went, so a raw search matches the explanation and this
  // assertion fails on correct code — which is exactly how it failed when
  // first written; (b) a /\*[\s\S]*?\*\// stripper cannot be used on these
  // files, because comment-looking sequences inside regex literals and
  // strings make it eat 10-48% of the source, and an ABSENCE assertion over a
  // corpus missing the region it guards passes vacuously.
  const stripped = PORTAL_JS.split('\n').filter((l) => {
    const t = l.trim();
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
  }).join('\n');
  assert('the stripper did not eat the code it guards',
    stripped.length > PORTAL_JS.length * 0.6
      && stripped.indexOf('function _errorStateFor') > -1,
    'kept ' + Math.round((stripped.length / PORTAL_JS.length) * 100) + '% — '
    + 'if this drops, the absence assertion below is vacuous');
  assert('no branch still hardcodes "Please try again in a moment."',
    stripped.indexOf('Please try again in a moment.') === -1);

  // _renderError writes into #mainWrap, which the portal-preview detection
  // keys on. Replacing innerHTML keeps the element; replacing the element
  // would break the preview modal silently.
  assert('_renderError writes into the element, not over it',
    /function _renderError\(main, state\) \{[\s\S]{0,400}?main\.innerHTML =/.test(PORTAL_JS),
    'see tests/portal-preview-framing.test.js — #mainWrap must survive');

  assert('the error copy is escaped before it reaches innerHTML',
    /esc\(state\.title\)[\s\S]{0,200}esc\(state\.body\)/.test(PORTAL_JS));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
