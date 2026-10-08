/**
 * tests/stripe-connect-ui.test.js — Connect phase 2: the Settings → Billing
 * payouts card.
 *
 * Phase 1 (#1143) shipped five callables with NO caller. This is the caller, so
 * these are the first assertions that anything user-facing touches Connect.
 *
 * Four things are load-bearing here, and each has burned this repo before:
 *
 *  1. CAPABILITY TRUTH. REWRITTEN 2026-07-3x: phase 3 lifted the #1123 gate, so
 *     the honesty problem inverted. Finishing onboarding now grants a real
 *     capability, which means the card must (a) be reachable by the people the
 *     server lets act — owner OR company_admin, mirroring requireTeamAdmin —
 *     and (b) say which state the account is actually in: "Online card payments
 *     are ON" when Stripe says so, "not switched on" when it doesn't, and the
 *     price (3.4% + 30…) in BOTH, because a fee the contractor first learns
 *     about from a payout is a fee we hid. Part 8 couples the card to the
 *     server gate in both directions so neither can move alone: a widened card
 *     over a closed gate is asking for an SSN for nothing; a lifted gate behind
 *     an owner-only card charges tenants for something they cannot see.
 *
 *  2. TEMPLATE RE-EXECUTION. The module ships inside the lazily-hydrated
 *     tpl-view-settings template and runs AGAIN at hydration, after DCL. A bare
 *     top-level `const` throws on the second run; a bare DCL listener never
 *     installs; an unguarded delegate double-fires — and a double-fired
 *     "create my Stripe account" is the exact race phase 1's idempotency key
 *     exists to survive.
 *
 *  3. THE BLANK-SETTINGS HAZARD. switchSettingsTab() hides EVERY .stab-panel and
 *     shows one only `if (panel)`, so a URL-supplied tab name that doesn't exist
 *     leaves the user on an empty Settings screen. The deep link must allowlist.
 *
 *  4. APP CHECK. All five callables set enforceAppCheck:true, so they must be
 *     invoked via the callable SDK (which attaches the token) from a page that
 *     initialises App Check. A raw fetch() 401s — silently, in a catch.
 *
 * Zero deps.  Run: node tests/stripe-connect-ui.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// Negative assertions MUST run against this, not the raw source: the comments in
// these files legitimately mention fetch(), localStorage, onclick and
// companyProfile while explaining why they are absent. (Learned the hard way in
// tests/stripe-connect.test.js.)
const decomment = (s) => s.split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

// Brace-match the block that OPENS at the first `{` at or after `from`.
// Scoping matters more in phase 3 than it did in phase 2: the card now carries
// two mutually exclusive copies (ON and OFF) in one function, and a whole-file
// regex cannot tell "the ON copy is inside the enabled branch" from "the ON
// copy is printed unconditionally". Same trap as the esign `return;` window.
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (from < 0 || open === -1) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('STRIPE CONNECT phase 2 — Settings → Billing payouts card');

const MOD_PATH = 'docs/pro/js/dashboard-connect-tab.js';
const SRC = read(MOD_PATH);
const CODE = decomment(SRC);
const HTML = read('docs/pro/dashboard.html');
const BOOT = read('docs/pro/js/dashboard-bootstrap.module.js');
const BOOT_CODE = decomment(BOOT);

// ── Part 1: it is actually wired into the page ────────────────────────
{
  ok('the module exists', fs.existsSync(path.join(ROOT, MOD_PATH)));
  ok('dashboard.html loads it', /<script src="js\/dashboard-connect-tab\.js/.test(HTML));
  ok('the card container exists', /id="connectPayoutsCard"/.test(HTML));
  ok('the card body exists', /id="connectPayoutsBody"/.test(HTML));

  // Both must sit inside the settings template, or the module never runs at all
  // (and this whole suite would be testing dead code).
  const tplAt = HTML.indexOf('id="tpl-view-settings"');
  const tplEnd = tplAt > -1 ? HTML.indexOf('</template>', tplAt) : -1;
  const cardAt = HTML.indexOf('id="connectPayoutsCard"');
  const scriptAt = HTML.indexOf('<script src="js/dashboard-connect-tab.js');
  ok('card + script live inside tpl-view-settings',
    tplAt > -1 && tplEnd > tplAt && cardAt > tplAt && cardAt < tplEnd
      && scriptAt > tplAt && scriptAt < tplEnd,
    'if they moved out of the template the re-execution guards below stop being about anything');

  // It must ship hidden: renderConnectCard() is what reveals it, and only for
  // the owner. A card that starts visible is visible to every tenant for the
  // moment before JS runs.
  const cardTag = HTML.slice(cardAt - 200, cardAt + 200);
  ok('the card starts display:none', /style="display:none;?"/.test(cardTag),
    'must not flash for non-owners before render');
}

// ── Part 2: capability truth (who sees it, and what it says) ───────────
{
  // REWRITTEN 2026-07-3x (silently-stale). The old pin was `owner === true`
  // alone — and that substring SURVIVES a widening, so the assertion would have
  // kept passing while the card quietly served a second role. Phase 3 pins the
  // WHOLE predicate: owner OR company_admin, which is exactly who the server's
  // requireTeamAdmin (functions/handlers/_shared.js:209) lets create the
  // account and mint the onboarding link. Strict === on both sides; the
  // predicate wraps lines, hence \s*.
  ok('visibility is owner OR company_admin (mirrors server requireTeamAdmin)',
    /owner === true\s*\|\|\s*window\._userClaims\.role === 'company_admin'/.test(CODE),
    'strict === on both: a truthy string must not reveal it, and a role the server would refuse'
      + ' must not be shown a button that 403s');
  // Brace-scoped: a whole-file negative would be satisfied by any unrelated
  // mention. No other role may open this card — the server refuses them.
  ok('no other role can open the card',
    !/manager|sales_rep|viewer/.test(braceBlock(CODE, CODE.indexOf('function _nbdConnectVisible'))),
    'onboarding hands over SSN + bank details; only the people the server will actually let act');

  // Three independent places must respect it, because each is a separate way in.
  ok('render hides the card for non-owners',
    /if \(!_nbdConnectVisible\(\)\) \{ card\.style\.display = 'none'; return; \}/.test(CODE));
  ok('status loading refuses to run for non-owners',
    /async function loadConnectStatus[\s\S]{0,260}?if \(!_nbdConnectVisible\(\)\)[\s\S]{0,80}?return;/.test(CODE),
    'a non-owner must never even call getConnectStatus');

  // "Claims absent" and "claims not loaded yet" are different answers. Deciding
  // on the unloaded state hides the card from the owner with no error — the
  // profile-hydration trap that wiped company pricing in #1139.
  ok('the visibility decision waits for claims to load',
    /async function _nbdConnectAwaitClaims/.test(CODE)
    && /await _nbdConnectAwaitClaims\(\);/.test(CODE),
    'an unpopulated _userClaims must not read as "not the owner"');
  ok('the claims wait is bounded',
    /_nbdConnectAwaitClaims[\s\S]{0,240}?for \(var i = 0; i < [1-9]\d*; i\+\+\)/.test(CODE));

  // REWRITTEN (fired): phase 2's note said "payments are still switched off for
  // every account", which was true and is now a lie. The note becomes a
  // CAPABILITY note with two branches — and both of them are load-bearing copy,
  // so each is pinned by its canonical substring rather than by the function
  // name (a renamed-but-gutted note would pass a name-only pin).
  ok('a capability note exists', /_nbdConnectCapabilityNote/.test(CODE));

  const noteAt = CODE.indexOf('function _nbdConnectCapabilityNote');
  const NOTE = braceBlock(CODE, noteAt);
  ok('the capability note body was located (the branch pins below are scoped)',
    noteAt > -1 && NOTE.length > 200);
  // The ON branch: the first `if (…)` inside the note. Its block is where the
  // enabled copy is allowed to live and nowhere else.
  const ON_BRANCH = braceBlock(NOTE, NOTE.indexOf('if ('));
  const ON_COPY = 'Online card payments are ON';

  ok('the enabled state says so in plain words', CODE.indexOf(ON_COPY) !== -1);
  ok('the disabled state says so in plain words', /not switched on/i.test(CODE),
    'silence reads as "it works" — a contractor sending an invoice needs to know it will not collect');

  // The branch invariant. This REPLACES phase 2's "the card never claims card
  // payments are enabled" — a blanket negative that fired the moment the claim
  // became true and legitimate. What survives of it is the part that still
  // matters: the claim must be CONDITIONAL. The ON copy must sit INSIDE the
  // enabled branch and appear nowhere else in the file; printed unconditionally
  // it is the same lie the phase-2 assertion was written to catch. (M17.)
  ok('the note branches on the real capability field',
    /onlinePaymentsEnabled === true/.test(NOTE),
    'branching on truthiness or on `connected` would call a verifying account ON');
  ok('the ON copy renders ONLY inside the enabled branch',
    ON_BRANCH.indexOf(ON_COPY) !== -1
    && (CODE.split(ON_COPY).length - 1) === 1,
    'found ' + (CODE.split(ON_COPY).length - 1) + ' occurrence(s); it must appear exactly once,'
      + ' inside the onlinePaymentsEnabled branch');

  // The price is disclosed in BOTH branches: ON because they are paying it now,
  // OFF because they are about to decide whether to turn it on. Encoding-robust
  // substring — the copy carries a cent sign this file deliberately never types.
  const FEE = /3\.4% \+ 30/;
  ok('the ON branch discloses the fee', FEE.test(ON_BRANCH));
  ok('the OFF branch discloses the fee too',
    ON_BRANCH !== '' && FEE.test(NOTE.split(ON_BRANCH).join('')),
    'someone deciding whether to onboard is exactly who needs the price');

  // It must appear in EVERY state that could read as "you're done". Count CALL
  // sites — `function _nbdConnectCapabilityNote(` matches a naive /name\(/ too,
  // so the definition inflates the count and a deleted call still "passes".
  // (Same trap as the adjuster-board test regex.)
  const noteCalls = (CODE.match(/(?:^|[^\w])_nbdConnectCapabilityNote\(/g) || [])
    .filter((m) => !/function/.test(m)).length
    - (/function _nbdConnectCapabilityNote\(/.test(CODE) ? 1 : 0);
  ok('the note is used by all three connected-ish states', noteCalls >= 3,
    'found ' + noteCalls + ' CALL sites (definition excluded); ready + verifying + payouts_paused each need it');

  ok('Mark Paid is still named as the actual way to get paid',
    /Mark Paid/.test(SRC),
    'check and cash are free and always will be — the card must not read as "card or nothing"');

  // INVERTED (fired): phase 2 FORBADE branching on onlinePaymentsEnabled,
  // because the server hard-coded it false and a branch would have invented a
  // state. Phase 3 computes it from mayCollectOnline(), so the field is the
  // only honest source of the card's headline — and NOT branching on it is now
  // the bug. Two branches minimum: the capability note and the ready blurb.
  //
  // PREMISE REWRITTEN 2026-07-30 (second pass). This used to be a whole-file
  // COUNT — `(CODE.match(/onlinePaymentsEnabled === true/g)).length >= 2` — on
  // the theory that two occurrences meant two branches. A count cannot say
  // WHERE: adding any third occurrence anywhere in the file (a log line, a
  // helper, a second note) buys a licence to delete the ready blurb's branch
  // with the suite fully green, which is exactly how M19a got through. The
  // note's branch is already brace-scoped above (NOTE); scope the blurb's
  // branch the same way, to the `st.status === 'ready'` arm itself, so the pin
  // is about that arm and nothing else can satisfy it. Behavioural backstop in
  // Part 9: two fixtures differing ONLY in onlinePaymentsEnabled must render
  // DIFFERENT blurbs, which no rewording can satisfy once the branch is gone.
  const readyArm = braceBlock(CODE, CODE.indexOf("st.status === 'ready'"));
  ok('the ready arm was located (the branch pin below is scoped)',
    readyArm.length > 200 && /blurb =/.test(readyArm),
    'the status arms were restructured — re-anchor this scope, the pin below is vacuous without it');
  ok('the ready BLURB itself branches on the real capability field',
    /onlinePaymentsEnabled === true/.test(readyArm),
    'a ready arm that never consults the capability tells a TEST-mode owner that a homeowner\'s'
      + ' card payment settles into their bank: the Stripe account is ready, the CRM is not');
}

// ── Part 3: template re-execution safety ──────────────────────────────
{
  // A top-level let/const throws SyntaxError on the second execution, killing
  // the whole script — including the tab hook.
  const topLevelDecl = CODE.split('\n').filter((l) => /^\s{0,8}(let|const)\s/.test(l));
  ok('no top-level let/const (script re-executes at hydration)',
    topLevelDecl.length === 0,
    topLevelDecl.length ? 'found: ' + topLevelDecl.slice(0, 3).map((s) => s.trim()).join(' | ') : '');

  ok('readyState guard installs the hook post-DCL',
    /document\.readyState === 'loading'/.test(CODE)
    && /document\.addEventListener\('DOMContentLoaded', _nbdInstallConnectHook\)/.test(CODE)
    && /\} else \{\s*_nbdInstallConnectHook\(\);/.test(CODE),
    'a bare DCL listener never fires for a template hydrated after DCL');

  ok('the click delegate is flag-guarded',
    /if \(!window\._NBD_CONNECT_DELEGATE\) \{\s*window\._NBD_CONNECT_DELEGATE = true;/.test(CODE),
    'double-install fires every action twice, including account creation');
  ok('the tab hook is flag-guarded',
    /window\._NBD_CONNECT_TAB_HOOK/.test(CODE));

  // Six other modules wrap switchSettingsTab. Replacing instead of chaining
  // silently kills the Appearance/Team/Billing tab renderers.
  ok('the tab hook CHAINS the previous switchSettingsTab',
    /var _prevSwitch = window\.switchSettingsTab/.test(CODE)
    && /_prevSwitch\(tab\)/.test(CODE),
    'must call the previous implementation, not replace it');

  // Re-entrancy on the button itself: the delegate disables before dispatch.
  ok('a clicked action button is disabled before dispatch',
    /if \(t\.disabled\) return;\s*t\.disabled = true;/.test(CODE));

  // _nbdInstallConnectHook bails without claiming the guard when
  // switchSettingsTab isn't defined yet. Without a retry that's a permanent
  // "Loading payout status…" and no console error.
  ok('the hook bails BEFORE claiming its guard (so a retry can still install)',
    /if \(typeof _prevSwitch !== 'function'\) return;\s*if \(window\._NBD_CONNECT_TAB_HOOK\) return;\s*window\._NBD_CONNECT_TAB_HOOK = true;/.test(CODE),
    'claiming the guard before the readiness check would wedge it forever');
  // Pin the CONDITION, not just the flag name: `if (false) { … _HOOK_RETRY = true
  // … }` leaves every identifier in place while disabling the whole retry.
  ok('a bounded, single-instance install retry exists',
    /if \(!window\._NBD_CONNECT_TAB_HOOK && !window\._NBD_CONNECT_HOOK_RETRY\) \{\s*window\._NBD_CONNECT_HOOK_RETRY = true;/.test(CODE)
    && /setInterval\(/.test(CODE)
    && /clearInterval\(_nbdConnectHookIv\)/.test(CODE)
    && /_nbdConnectHookTries > [1-9]\d*/.test(CODE)
    && /_nbdInstallConnectHook\(\);\s*if \(window\._NBD_CONNECT_TAB_HOOK/.test(CODE),
    'must actually retry (live guard), must stop, and must not stack one interval per hydration');
}

// ── Part 4: CSP + App Check ───────────────────────────────────────────
{
  ok('no inline event handlers are generated',
    !/\son[a-z]+=/.test(CODE),
    '/pro forbids inline handlers; actions go through data-connect-action');
  ok('actions are dispatched by data-connect-action',
    /data-connect-action="/.test(CODE)
    && /closest\('\[data-connect-action\]'\)/.test(CODE));

  // enforceAppCheck:true on all five callables => callable SDK, not fetch.
  ok('calls go through the callable SDK',
    /window\._httpsCallable\(window\._functions, name\)/.test(CODE));
  ok('the module never raw-fetches a cloudfunctions URL',
    !/fetch\(\s*['"]https:\/\/us-central1/.test(CODE),
    'a raw fetch to an onCall+enforceAppCheck function 401s');
  ok('it self-provisions the functions SDK when absent',
    /import\('\/assets\/vendor\/firebase\/[\d.]+\/firebase-functions\.js'\)/.test(CODE),
    'the globals are set lazily and may be missing at click time');

  // Per-page App Check rule: an enforceAppCheck callable page that never inits
  // App Check gets a 401 on every call.
  ok('dashboard.html initialises App Check',
    /dashboard-appcheck-config\.js/.test(HTML));

  // All four callables actually referenced by name.
  ['getConnectStatus', 'createConnectAccount', 'createConnectOnboardingLink', 'createConnectDashboardLink']
    .forEach((fn) => {
      ok('calls ' + fn, new RegExp("_nbdConnectCallable\\('" + fn + "'\\)").test(CODE));
    });
}

// ── Part 5: the onboarding link is treated as a credential ────────────
{
  // AccountLinks authenticate the account holder. Persisting, emailing or
  // sharing one hands over the Stripe account.
  ok('the onboarding link is redirected to, not stored',
    /window\.location\.href = url;/.test(CODE));
  ok('the module never persists anything to storage',
    !/localStorage|sessionStorage|setItem/.test(CODE),
    'a stored AccountLink is a stored credential');
}

// ── Part 6: the deep link (?settings=…&connect=…) ─────────────────────
{
  ok('bootstrap handles the settings deep link',
    /urlParams\.get\('settings'\)/.test(BOOT_CODE));

  // The blank-Settings hazard.
  ok('the tab name is ALLOWLISTED, not passed through',
    /SETTINGS_TABS\s*=\s*\[/.test(BOOT_CODE)
    && /SETTINGS_TABS\.indexOf\(wantTab\) !== -1/.test(BOOT_CODE),
    'switchSettingsTab hides every panel then shows one only if it exists — an unknown tab = blank screen');

  // And the allowlist must match reality, or a legitimate deep link silently
  // does nothing.
  const realTabs = Array.from(new Set(
    (HTML.match(/id="stab-panel-([a-z0-9-]+)"/g) || [])
      .map((m) => m.replace(/.*stab-panel-/, '').replace('"', ''))
  )).sort();
  const listed = (BOOT_CODE.match(/SETTINGS_TABS\s*=\s*\[([\s\S]*?)\]/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort();
  ok('the allowlist matches the real stab-panel ids',
    realTabs.length > 0 && JSON.stringify(realTabs) === JSON.stringify(listed),
    'real: ' + realTabs.join(',') + ' | listed: ' + listed.join(','));
  ok('billing is deep-linkable (the Connect return URL depends on it)',
    listed.indexOf('billing') !== -1);

  // The return/refresh contract with the module.
  ok('connect=return|refresh forces a live status re-read',
    /connectParam === 'return' \|\| connectParam === 'refresh'/.test(BOOT_CODE)
    && /window\._nbdConnectPendingRefresh = true/.test(BOOT_CODE),
    'the account.updated webhook may not have landed when Stripe redirects back');
  ok('the module CONSUMES that flag on billing-tab open',
    /window\._nbdConnectPendingRefresh/.test(CODE)
    && /window\._nbdConnectPendingRefresh = false/.test(CODE),
    'flag not call: bootstrap runs before the hydrated template script exists');
  ok('connect=refresh is surfaced as an expired link',
    /connectParam === 'refresh'\) window\._nbdConnectLinkExpired = true/.test(BOOT_CODE)
    && /_nbdConnectLinkExpired/.test(CODE));

  // An auto-minted replacement link on ?connect=refresh is an infinite bounce
  // if minting keeps failing.
  ok('bootstrap does NOT auto-mint a replacement onboarding link',
    !/createConnectOnboardingLink/.test(BOOT_CODE),
    'refresh must show a button, not redirect in a loop');

  // Lazy hydration means a fixed delay is a race. Assert INSIDE the deep-link
  // branch only: bootstrap is 2000+ lines and contains plenty of unrelated
  // `for (let i = 0; …)` loops, so a whole-file regex passes even after the poll
  // is deleted. (Same loose-window trap as the esign `return;` check.)
  const branchAt = BOOT_CODE.indexOf("urlParams.get('settings')");
  const BRANCH = branchAt > -1 ? BOOT_CODE.slice(branchAt, branchAt + 2600) : '';
  ok('the deep-link branch was located for scoped assertions', BRANCH.length > 500);
  ok('it polls for switchSettingsTab instead of guessing a delay',
    /for \(let i = 0; i < [1-9]\d*; i\+\+\)/.test(BRANCH)
    && /typeof window\.switchSettingsTab === 'function'[\s\S]{0,140}?getElementById\('stab-panel-' \+ wantTab\)/.test(BRANCH)
    && /await new Promise\(\(r\) => setTimeout\(r, \d+\)\)/.test(BRANCH),
    'openSettingsTab()\'s fixed 200ms is exactly this bug');
  ok('the poll bound is a real number of attempts (not zero)',
    /i < ([1-9]\d*);/.test(BRANCH) && Number((BRANCH.match(/i < (\d+);/) || [, 0])[1]) >= 10,
    'a zero/one-iteration loop is a fixed delay wearing a loop costume');
}

// ── Part 7: escaping ──────────────────────────────────────────────────
{
  ok('an escaper exists',
    /function _nbdConnectEsc/.test(CODE)
    && /replace\(\/&\/g, '&amp;'\)/.test(CODE));
  // Stripe-supplied strings that reach innerHTML.
  ['disabledReason', 'accountId'].forEach((f) => {
    ok(f + ' is escaped before innerHTML',
      new RegExp('_nbdConnectEsc\\(st\\.' + f + '\\)').test(CODE));
  });
  ok('requirement names are escaped',
    /_nbdConnectEsc\(_nbdConnectPrettyReq\(r\)\)/.test(CODE));
  ok('the status label is escaped',
    /_nbdConnectEsc\(st\.label/.test(CODE));
}

// ── Part 8: server↔card couplings (things that must move together) ────
{
  // REWRITTEN 2026-07-3x. The phase-2 coupling used
  // `gateStillClosed = /ONLINE_PAYMENTS_UNAVAILABLE/` as its signal, and phase 3
  // KEEPS that error code (it now means "capability absent" rather than
  // "platform-only"). So the old signal is permanently true — a dead assertion
  // that would have passed forever without ever being consulted again. It is
  // replaced, not deleted, by three live couplings. Phase 4 rewrites these
  // premises again — never deletes them.
  const STRIPE_CODE = decomment(read('functions/stripe.js'));

  // (a) THE GATE AND THE CARD MOVE TOGETHER. Either both are open or both are
  //     shut; the two failure modes are opposite and both bad.
  const gateLifted = /mayCollectOnline\(/.test(STRIPE_CODE);
  const teamVisible = /role === 'company_admin'/.test(CODE);
  ok('the server gate and the card audience agree',
    gateLifted === teamVisible,
    gateLifted
      ? 'the mint is gated by mayCollectOnline (tenants CAN collect) but this card is still'
        + ' owner-only: tenants are charged for a capability they can neither see nor manage,'
        + ' and their company_admin cannot even start onboarding'
      : 'the card was widened past the owner while the mint still refuses tenants: that asks'
        + ' people for SSN + bank details for a capability they will not get');

  // (b) IF WE TAKE A FEE, THE CARD SAYS SO. A fee a contractor first discovers
  //     from a payout is a fee we hid; copy promising a fee we do not take is a
  //     false pricing claim. Anti-vacuity for this pair is anchored elsewhere:
  //     platform-only Part 1 pins that platformFeeCents is exported, and
  //     stripe-connect.test.js pins PLATFORM_FEE_BPS = 340.
  const feeCharged = /application_fee_amount/.test(STRIPE_CODE);
  const feeDisclosed = /3\.4% \+ 30/.test(CODE);
  ok('charging the platform fee and disclosing it on the card agree',
    feeCharged === feeDisclosed,
    feeCharged
      ? 'the mint charges a platform fee that this card never mentions — undisclosed pricing'
      : 'the card quotes a platform fee the mint does not charge — a false pricing claim');

  // (c) AND THE PUBLIC SURFACES SAY SO TOO. Ownership of this used to fall
  //     between the UI and the docs slices; it lands here. Terms is the
  //     contract, pricing/index are what a contractor reads before signing up.
  //     2026-08-18: docs/pro/landing.html was dropped from this list because
  //     the file is gone — it was a byte-identical duplicate of index.html
  //     serving a second indexed URL, now deleted and 301'd to /pro. The old
  //     comment here noted the two were byte-copies; that is exactly why only
  //     index.html needs checking now.
  if (feeCharged) {
    ['docs/pro/terms.html', 'docs/pro/pricing.html', 'docs/pro/index.html']
      .forEach((p) => {
        ok('the platform fee is disclosed in ' + p, /3\.4%/.test(read(p)),
          'we take a cut of a homeowner payment; every surface a contractor reads before'
            + ' turning it on must say so');
      });
  } else {
    ok('no platform fee is charged, so no public disclosure is required', true);
  }
}

// ── Part 9: BEHAVIOUR — actually run the renderer ─────────────────────
// Everything above is a source-pattern assertion, which proves the code was
// written a certain way, not that it does the right thing. This part executes
// the module in a sandbox with a fake DOM and inspects the HTML it produces for
// each status the server can return.
{
  const vm = require('vm');

  function mkEnv(claims, state) {
    const els = {};
    function el(id) {
      if (!els[id]) els[id] = { id: id, style: {}, innerHTML: '', disabled: false };
      return els[id];
    }
    el('connectPayoutsCard');
    el('connectPayoutsBody');
    const sandbox = {
      console: { log() {}, warn() {}, error() {} },
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      Promise,
      document: {
        readyState: 'complete',
        getElementById: (id) => (els[id] || null),
        addEventListener: () => {},
      },
      _els: els,
    };
    sandbox.window = sandbox;          // window.x and bare x are the same binding
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    sandbox.window._userClaims = claims;
    sandbox.window._nbdConnectState = state;
    return sandbox;
  }
  function renderWith(claims, state) {
    const s = mkEnv(claims, state);
    s.__NBD_CALL_REGISTRY.renderConnectCard();
    return {
      card: s._els.connectPayoutsCard,
      html: s._els.connectPayoutsBody.innerHTML,
    };
  }

  const OWNER = { owner: true };

  // Sanity: the module even loads and exposes its renderer. Globals Tranche 3
  // (T3-A, 2026-09-18): the whole module is now IIFE-wrapped, so
  // renderConnectCard/loadConnectStatus are reachable only via the call
  // registry, not as bare sandbox properties.
  let loaded = true;
  try { mkEnv(OWNER, null); } catch (e) { loaded = false; console.log('    (load error: ' + e.message + ')'); }
  ok('the module executes standalone and exposes renderConnectCard', loaded
    && typeof mkEnv(OWNER, null).__NBD_CALL_REGISTRY.renderConnectCard === 'function');
  ok('loadConnectStatus is also registered',
    typeof mkEnv(OWNER, null).__NBD_CALL_REGISTRY.loadConnectStatus === 'function');

  // Audience, rendered rather than regexed. UPDATED 2026-07-3x: the card now
  // serves owner OR company_admin — the same two the server's requireTeamAdmin
  // accepts — and nobody else. A role that can see the button but gets a 403
  // from every callable is worse than no button.
  const READY = { status: 'ready', label: 'Connected', connected: true };
  const nonOwner = renderWith({ owner: false }, READY);
  ok('BEHAVIOUR: a plain member gets the card hidden', nonOwner.card.style.display === 'none');
  ok('BEHAVIOUR: a plain member gets no card content', nonOwner.html === '');

  const rep = renderWith({ owner: false, role: 'sales_rep' }, READY);
  ok('BEHAVIOUR: a sales_rep gets the card hidden', rep.card.style.display === 'none',
    'the server refuses createConnectAccount for them — showing the button teaches a 403');
  ok('BEHAVIOUR: a sales_rep gets no card content', rep.html === '');

  const admin = renderWith({ owner: false, role: 'company_admin' }, READY);
  ok('BEHAVIOUR: a company_admin CAN see the card', admin.card.style.display === '',
    'requireTeamAdmin lets them act; phase 3 lets them see');
  ok('BEHAVIOUR: a company_admin gets real card content', admin.html.length > 0);

  const noClaims = renderWith(undefined, READY);
  ok('BEHAVIOUR: missing claims also hide the card', noClaims.card.style.display === 'none');

  // Owner + each status.
  const r1 = renderWith(OWNER, { status: 'not_started', label: 'Not connected', connected: false });
  ok('BEHAVIOUR: not_started offers "Set up payouts"',
    /data-connect-action="start"/.test(r1.html) && /Set up payouts/.test(r1.html));
  ok('BEHAVIOUR: not_started is revealed to the owner', r1.card.style.display === '');
  // Added 2026-07-30 after mutation M20 proved this was UNGUARDED: deleting the
  // not_started blurb's fee sentence left the whole suite green. Part 8's
  // coupling (b) is a whole-file regex, so the other two fee mentions satisfied
  // it, and the brace-scoped ON/OFF pins only ever look inside
  // _nbdConnectCapabilityNote — never the blurb. not_started is the ONE screen
  // that must carry the price: it is what a contractor reads immediately before
  // clicking through to hand Stripe their SSN and bank details. Undisclosed-fee
  // risk, not a copy nitpick — assert on the rendered output, per status.
  ok('BEHAVIOUR: not_started discloses the fee BEFORE onboarding',
    /3\.4% \+ 30/.test(r1.html));

  const r2 = renderWith(OWNER, {
    status: 'onboarding_incomplete', label: 'Finish setup', connected: true, accountId: 'acct_x',
    requirementsCurrentlyDue: ['individual.ssn_last_4', 'external_account'],
  });
  ok('BEHAVIOUR: onboarding_incomplete offers "Finish setup"',
    /data-connect-action="link"/.test(r2.html) && /Finish setup/.test(r2.html));
  ok('BEHAVIOUR: requirement field NAMES are listed, humanised',
    /ssn last 4/.test(r2.html) && /External account/.test(r2.html));

  // r3-r6 REWRITTEN 2026-07-3x. Phase 2 asserted every connected state said
  // "still switched off", because that was true of every account. Phase 3
  // renders the CAPABILITY the server reports, so each fixture now carries an
  // explicit onlinePaymentsEnabled and asserts the matching copy — including
  // the negative direction, which is the one that catches a note that lost its
  // branch and prints ON unconditionally.
  const ON_COPY_RE = /Online card payments are ON/;
  const FEE_RE = /3\.4% \+ 30/;

  const r3 = renderWith(OWNER, {
    status: 'verifying', label: 'Verification in progress', connected: true, accountId: 'acct_x',
    onlinePaymentsEnabled: false,
  });
  ok('BEHAVIOUR: verifying says payments are not switched on yet',
    /not switched on/i.test(r3.html));
  ok('BEHAVIOUR: verifying must NOT read as enabled', !ON_COPY_RE.test(r3.html),
    'Stripe has not enabled charges on this account — saying otherwise sends an invoice nobody can pay');
  ok('BEHAVIOUR: verifying does NOT push another onboarding link',
    !/data-connect-action="link"/.test(r3.html),
    'the fix-it path for a verifying account is the Express dashboard, not a new link');

  // payouts_paused is the subtle one: a payout hold is NOT a charge block
  // (stripe-connect-logic.js mayCollectOnline deliberately ignores
  // payoutsEnabled), so the capability really is ON while the money piles up in
  // Stripe. The card must say BOTH things at once.
  const r4 = renderWith(OWNER, {
    status: 'payouts_paused', label: 'Connected — payouts on hold', connected: true,
    accountId: 'acct_x', disabledReason: 'requirements.past_due',
    requirementsPastDue: ['individual.verification.document'],
    onlinePaymentsEnabled: true, chargesEnabled: true, payoutsEnabled: false,
  });
  ok('BEHAVIOUR: payouts_paused shows Stripe\'s reason', /requirements\.past_due/.test(r4.html));
  ok('BEHAVIOUR: payouts_paused still reports payments ON (a payout hold is not a charge block)',
    ON_COPY_RE.test(r4.html));
  ok('BEHAVIOUR: payouts_paused discloses the fee', FEE_RE.test(r4.html));
  ok('BEHAVIOUR: payouts_paused still says payouts are held',
    /payouts.*(hold|paused)/i.test(r4.html),
    'charges work but the money is stuck in Stripe — both facts, or the card is misleading');

  const r5 = renderWith(OWNER, {
    status: 'ready', label: 'Connected', connected: true, accountId: 'acct_live1',
    livemode: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true,
    onlinePaymentsEnabled: true,
  });
  ok('BEHAVIOUR: a live, capable account reads as ON', ON_COPY_RE.test(r5.html),
    'this is the state the whole phase exists to reach — it must say so');
  ok('BEHAVIOUR: the ON state discloses the price', FEE_RE.test(r5.html),
    'the first time a contractor sees 3.4% must not be on a payout statement');
  ok('BEHAVIOUR: the retired "still switched off" copy is gone',
    !/still switched off/i.test(r5.html),
    'phase 2 copy on a phase 3 account tells a working tenant their payments do not work');
  ok('BEHAVIOUR: ready offers the Express dashboard',
    /data-connect-action="dashboard"/.test(r5.html));
  ok('BEHAVIOUR: livemode renders a LIVE badge', />LIVE</.test(r5.html));

  const r6 = renderWith(OWNER, {
    status: 'ready', label: 'Connected', connected: true, accountId: 'acct_test1', livemode: false,
    onlinePaymentsEnabled: false,
  });
  ok('BEHAVIOUR: test-mode renders a TEST badge', />TEST</.test(r6.html),
    'the runbook is test-mode-first; the owner must be able to tell which account this is');
  ok('BEHAVIOUR: a test-mode account never reads as live-enabled', !ON_COPY_RE.test(r6.html),
    'fully onboarded in TEST mode is fully onboarded for nobody — mayCollectOnline says false');
  // Added 2026-07-30 after mutation M19a: the 'ready' BLURB's capability branch
  // was pinned only by a whole-file COUNT of `onlinePaymentsEnabled === true`
  // occurrences. Collapsing that if/else to the unconditional ON blurb told a
  // TEST-mode owner "a homeowner's card payment settles into this account's
  // bank" — a false capability claim — while r5/r6 stayed green, because they
  // only ever inspect copy emitted by _nbdConnectCapabilityNote, never the
  // blurb. Assert the blurb itself, on the fixture that can expose it.
  ok('BEHAVIOUR: a not-yet-enabled ready account never claims links or settlement',
    !/can carry an online/.test(r6.html) && !/settles into this account/.test(r6.html),
    'the blurb must branch on onlinePaymentsEnabled, not just describe the Stripe account');

  // STRENGTHENED 2026-07-30 (second pass). The pin above is copy-shaped: both
  // literals are lifted from today's ON blurb, so REWORDING that blurb while
  // collapsing the branch passes it, and its companion guard in Part 2 was a
  // whole-file occurrence COUNT (now brace-scoped, see there). What is true
  // regardless of wording is that the ready blurb must DIFFER between an account
  // this CRM will charge a card on and one it won't. These two fixtures are
  // identical in every field except onlinePaymentsEnabled, so identical blurbs
  // can only mean the branch is gone — whatever the new copy says.
  const READY_BASE = {
    status: 'ready', label: 'Connected', connected: true, accountId: 'acct_same',
    livemode: true, chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true,
  };
  // Extract the blurb rather than diffing whole cards: the capability NOTE also
  // branches on this field, so a whole-HTML diff would stay green with the blurb
  // collapsed — the same vacuity M19a exploited. The blurb is the div the
  // renderer emits between the head and `extra`.
  const blurbOf = (html) => {
    const m = /<div style="font-size:12px;color:var\(--m\);line-height:1\.5;">([\s\S]*?)<\/div>/.exec(html);
    return m ? m[1] : '';
  };
  const onBlurb = blurbOf(renderWith(OWNER,
    Object.assign({}, READY_BASE, { onlinePaymentsEnabled: true })).html);
  const offBlurb = blurbOf(renderWith(OWNER,
    Object.assign({}, READY_BASE, { onlinePaymentsEnabled: false })).html);
  ok('BEHAVIOUR: the ready blurb is extractable from both renders',
    onBlurb.length > 40 && offBlurb.length > 40,
    'anti-vacuity for the comparison below — re-anchor blurbOf() on the renderer\'s markup');
  ok('BEHAVIOUR: the ready blurb DIFFERS on onlinePaymentsEnabled alone',
    onBlurb !== offBlurb,
    'two accounts identical except the capability got the same sentence, so the blurb no longer'
      + ' branches: one of those two owners is being told something untrue about whether a'
      + ' homeowner can pay them. Copy-independent — rewording cannot silence this');

  // An unrecognised status from a newer server must not be silently rendered as
  // one of the good states.
  const r7 = renderWith(OWNER, { status: 'brand_new_code', label: 'Whatever', connected: true });
  ok('BEHAVIOUR: an unknown status degrades to "could not interpret"',
    /could not be interpreted/i.test(r7.html)
    && !/data-connect-action="start"/.test(r7.html),
    'never guess a state that governs money');

  // XSS: Stripe strings are not user input today, but they land in innerHTML.
  const r8 = renderWith(OWNER, {
    status: 'payouts_paused', label: '<img src=x onerror=alert(1)>', connected: true,
    accountId: '"><script>alert(2)</script>', disabledReason: '<svg onload=alert(3)>',
    requirementsPastDue: ['<b>boom</b>'],
  });
  ok('BEHAVIOUR: hostile label/accountId/reason/requirements are all escaped',
    !/<img/.test(r8.html) && !/<script/.test(r8.html) && !/<svg/.test(r8.html) && !/<b>/.test(r8.html)
    && /&lt;img/.test(r8.html) && /&lt;svg/.test(r8.html),
    'raw markup reached innerHTML');

  // Busy + error states render instead of a stale card.
  const sBusy = mkEnv(OWNER, { status: 'ready', label: 'Connected', connected: true });
  sBusy.window._nbdConnectBusy = 'Creating your Stripe account…';
  sBusy.__NBD_CALL_REGISTRY.renderConnectCard();
  ok('BEHAVIOUR: a busy state replaces the card body',
    /Creating your Stripe account/.test(sBusy._els.connectPayoutsBody.innerHTML)
    && !/data-connect-action="dashboard"/.test(sBusy._els.connectPayoutsBody.innerHTML),
    'leaving live buttons under a busy message invites a double submit');

  const sErr = mkEnv(OWNER, null);
  sErr.window._nbdConnectError = 'Could not read payout status: boom';
  sErr.__NBD_CALL_REGISTRY.renderConnectCard();
  ok('BEHAVIOUR: an error state is shown with a retry',
    /boom/.test(sErr._els.connectPayoutsBody.innerHTML)
    && /data-connect-action="refresh"/.test(sErr._els.connectPayoutsBody.innerHTML));

  // The expired-link banner from ?connect=refresh.
  const sExp = mkEnv(OWNER, { status: 'onboarding_incomplete', label: 'Finish setup', connected: true });
  sExp.window._nbdConnectLinkExpired = true;
  sExp.__NBD_CALL_REGISTRY.renderConnectCard();
  ok('BEHAVIOUR: connect=refresh surfaces an expired-link notice',
    /expired/i.test(sExp._els.connectPayoutsBody.innerHTML));
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
