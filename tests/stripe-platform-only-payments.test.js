/**
 * tests/stripe-platform-only-payments.test.js — where a homeowner's money is
 * allowed to land, and what must be true before it moves.
 *
 * THE PROBLEM. Stripe serves two different money flows here through ONE client
 * on the platform's secret key:
 *   1. subscription billing — a contractor paying US. Ours. Correct.
 *   2. invoice payment links — a contractor's HOMEOWNER paying the CONTRACTOR.
 *      Theirs. Was settling into OUR balance.
 *
 * getStripe() memoizes one client on STRIPE_SECRET_KEY. That was fine while we
 * were the only tenant and became wrong the moment anyone else could sign up —
 * chargebacks against our account for work we did not do, a 1099-K reporting
 * their revenue as ours, and collecting funds on behalf of other businesses
 * (which is why Connect exists).
 *
 * STATUS 2026-07-3x: Connect Express PHASE 3 is LIVE — destination charges
 * route tenant mints to connected accounts, gated by mayCollectOnline(); the
 * platform tenant's own mints are unchanged (no routing, no platform fee). The
 * blanket "no tenant may ever collect online" premise this file was born with
 * is therefore RETIRED, exactly as the phase-1 rewrite note below predicted.
 * What replaces it is CONFINEMENT plus a GATE — that is what the parts pin now.
 *
 * So this pins:
 *   Part 1 — the MONEY primitives are CONFINED, not absent: they may appear in
 *            functions/stripe.js and nowhere else under functions/ — never
 *            inside the four subscription-billing exports, and never in the two
 *            Connect files (which stay accounts-only). Connect ACCOUNT plumbing
 *            stays confined to those same two Connect files.
 *   Part 2 — the three-way gate in createStripePaymentLink: platform tenant →
 *            mint as before; a capable tenant with a live subscription →
 *            destination mint with the platform fee; everyone else → 403
 *            ONLINE_PAYMENTS_UNAVAILABLE, returned BEFORE any Stripe call.
 *   Part 3 — the client capability mirror fails closed, caches only definitive
 *            answers, and an invoice is never lost because a link failed.
 *   Part 4 — the OTHER homeowner→contractor path (esign C5 auto-invoices) is
 *            GONE: it lived in the BoldSign webhook, retired 2026-10-04.
 *
 * Zero deps.  Run: node tests/stripe-platform-only-payments.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const decomment = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('STRIPE — where homeowner money lands: confinement + the three-way gate');

// ── Part 1: the money primitives are CONFINED, not absent ─────────────
//
// REWRITTEN 2026-07-29 (Connect phase 1), exactly as the original assertion
// instructed: it asserted "no Connect plumbing anywhere in functions/", which
// was the gate's premise while Connect did not exist. Phase 1 added connected
// ACCOUNTS + onboarding, so that assertion fired — the documented signal to
// rewrite it deliberately, never to delete it.
//
// The premise the gate actually rests on is narrower and still true: no code
// path can route a homeowner's payment to a tenant's account. So this now pins
// two things instead:
//   (a) the MONEY primitives are absent everywhere — that is what makes the
//       platform-only gate still necessary. When phase 3 lifts the gate, THIS
//       is the assertion to rewrite (again, deliberately), and the gate checks
//       in Parts 2-4 are what must be replaced by mayCollectOnline().
//   (b) the ACCOUNT primitives are confined to the two Connect files, so
//       account plumbing cannot quietly appear inside the subscription or
//       invoice paths.
//
// REWRITTEN AGAIN 2026-07-3x (Connect phase 3), on the instruction the previous
// rewrite left behind: phase 3 mints DESTINATION charges, so (a) fired — the
// money primitives now exist, deliberately. The premise that replaces
// "absent everywhere" is CONFINEMENT, which is the property that actually
// protects the two flows from each other:
//   (a') the money primitives live in functions/stripe.js and NOWHERE else
//        under functions/. The allowlist is deliberately ONE file — not the two
//        Connect files, which stay accounts-only so that reading either of them
//        can never leave you wondering whether it moves money (their own
//        containment loop, tests/stripe-connect.test.js:197-201, says the same
//        thing from the other side).
//   (a'') within stripe.js, the four SUBSCRIPTION-billing exports must stay
//        money-primitive-free and connected-account-free: contractors paying us
//        is a different flow from homeowners paying contractors, and the whole
//        point of the confinement is that neither leaks into the other.
//        (functions/handlers/seats.js needs no slice — it is covered by the
//        directory walk above, which allows it zero money primitives at all.)
//   (b) is UNCHANGED and still true: stripe.js gains no ACCOUNT primitive —
//        the mint only reads connectState.accountId strings out of Firestore.
//        (Note `transfers.createReversal` matches MONEY, not ACCOUNT.)
// Phase 4 rewrites these premises again — deliberately. Never deletes them.
{
  const fnDir = path.join(ROOT, 'functions');
  // Routing money on someone else's behalf, plus the phase-3 recovery lever
  // (a chargeback under destination routing debits the PLATFORM, so the mint's
  // transfer is reversed). Allowed, but only in MONEY_FILES.
  const MONEY = /on_behalf_of|transfer_data|application_fee|createReversal|transfers\.create/;
  // Creating/holding a connected account. Allowed, but only in the Connect files.
  const ACCOUNT = /stripeAccount|accounts\.create|accountLinks\.create|createLoginLink/;
  const CONNECT_FILES = new Set([
    path.join('functions', 'handlers', 'stripe-connect.js'),
    path.join('functions', 'stripe-connect-logic.js'),
  ]);
  // The ONE file allowed to name a money primitive. If this set ever grows,
  // that is a design change to argue about in review, not a test to widen.
  const MONEY_FILES = new Set([
    path.join('functions', 'stripe.js'),
  ]);

  const moneyHits = [];
  const accountHits = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '_archive') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.endsWith('.js')) continue;
      const rel = path.relative(ROOT, full);
      const src = decomment(fs.readFileSync(full, 'utf8'));
      if (MONEY.test(src) && !MONEY_FILES.has(rel)) moneyHits.push(rel);
      if (ACCOUNT.test(src) && !CONNECT_FILES.has(rel)) accountHits.push(rel);
    }
  })(fnDir);

  ok('money routing is CONFINED to functions/stripe.js',
    moneyHits.length === 0,
    moneyHits.length
      ? 'on_behalf_of / transfer_data / application_fee / createReversal / transfers.create appeared in '
        + moneyHits.join(', ')
        + ' — the mint and the dispute reversal are the only sanctioned homes. Move it back, or'
        + ' change MONEY_FILES deliberately with a comment saying why.'
      : '');

  ok('Connect ACCOUNT plumbing stays inside the two Connect files',
    accountHits.length === 0,
    accountHits.length
      ? 'account primitives leaked into ' + accountHits.join(', ')
        + ' — the subscription and invoice paths must not grow Connect plumbing sideways'
      : '');

  // ── The four subscription-billing exports stay a separate flow ──────────
  // Sliced by export boundary rather than regexed whole-file: stripe.js is the
  // allowlisted money file now, so a whole-file assertion here would say
  // nothing. Each slice runs from `exports.<name>` to the next `exports.`.
  {
    const s = decomment(read('functions/stripe.js'));
    for (const name of ['createCheckoutSession', 'stripeWebhook', 'createCustomerPortalSession', 'getSubscriptionStatus']) {
      const start = s.indexOf('exports.' + name);
      const next = start === -1 ? -1 : s.indexOf('exports.', start + 8);
      const slice = start === -1 ? '' : s.slice(start, next === -1 ? s.length : next);
      ok('the ' + name + ' slice was located (this sweep is not vacuous)',
        start !== -1 && slice.length > 200,
        'export renamed or removed — re-anchor this slice before trusting the sweep below');
      ok(name + ' routes no money and names no connected account',
        slice !== '' && !MONEY.test(slice) && slice.indexOf('stripeAccount') === -1,
        'subscription billing is contractors paying US — it must never gain destination routing,'
          + ' a platform fee, or a stripeAccount header');
    }
  }

  // The Connect files themselves must exist and the phase-3 fee primitive must
  // be exported, or the checks above are vacuously true and this test would
  // silently stop meaning anything.
  ok('the Connect files are present (these checks are not vacuous)',
    fs.existsSync(path.join(ROOT, 'functions/handlers/stripe-connect.js'))
    && fs.existsSync(path.join(ROOT, 'functions/stripe-connect-logic.js')));
  ok('the phase-3 fee primitive really exists (confinement is about something)',
    typeof require('../functions/stripe-connect-logic.js').platformFeeCents === 'function',
    'if platformFeeCents is gone there is no fee to confine and Part 2 pin 10 is theatre');
}

// ── Part 2: the three-way gate in createStripePaymentLink ─────────────
//
// REWRITTEN 2026-07-3x (Connect phase 3). The old premise was binary — platform
// tenant or refusal — and it fired the moment the gate grew a middle branch.
// The new premise is the three-way gate itself: (1) platform tenant mints
// exactly as before, (2) a tenant whose connectAccounts mirror satisfies
// mayCollectOnline() AND who holds a live subscription mints a DESTINATION
// charge on their own account, (3) everyone else still gets 403
// ONLINE_PAYMENTS_UNAVAILABLE — same error code, same before-any-Stripe-call
// ordering, and the refusal branch still RETURNS rather than warning and
// continuing. Every pin below is scoped to the handler slice: stripe.js is now
// the allowlisted money file, so a whole-file regex would pass on text from the
// subscription exports and prove nothing about the mint.
{
  const s = read('functions/stripe.js');
  const code = decomment(s);

  ok('a platform-tenant predicate exists', /function isPlatformTenant\(decoded\)/.test(code));
  ok('it accepts either the companyId claim or the raw owner uid',
    /decoded\.uid === NBD_OWNER_UID \|\| companyId === NBD_OWNER_UID/.test(code),
    'solo convention is companyId == uid; a platform admin without the claim must not be locked out');
  ok('the owner uid is env-overridable', /process\.env\.NBD_OWNER_UID/.test(code));

  // Handler slice: exports.createStripePaymentLink → exports.invoiceWebhook.
  const hsStart = code.indexOf('exports.createStripePaymentLink');
  const hsEnd = code.indexOf('exports.invoiceWebhook');
  const hs = (hsStart > -1 && hsEnd > hsStart) ? code.slice(hsStart, hsEnd) : '';
  ok('the createStripePaymentLink slice was located (every pin below is scoped to it)',
    hs.length > 500, 'handler renamed/moved — re-anchor before trusting anything below');

  // 1. The gate delegates to the shared pure predicates rather than re-deciding.
  ok('stripe.js requires the Connect logic module',
    /require\('\.\/stripe-connect-logic'\)/.test(code),
    'the gate must reuse mayCollectOnline/platformFeeCents, not grow a second opinion');

  // 2. Ordering is still the whole point: a capability check after the Stripe
  //    call has already minted the link.
  const platformAt = hs.indexOf('isPlatformTenant(decoded)');
  const capAt = hs.indexOf('mayCollectOnline(');
  const refuseAt = hs.indexOf('ONLINE_PAYMENTS_UNAVAILABLE');
  const mintAt = hs.indexOf('paymentLinks.create');
  ok('platform check → capability check → mint, in that order',
    platformAt > -1 && capAt > platformAt && mintAt > capAt,
    `isPlatformTenant@${platformAt} mayCollectOnline@${capAt} paymentLinks.create@${mintAt}`);
  ok('the refusal happens BEFORE any Stripe call',
    refuseAt > -1 && mintAt > refuseAt,
    'a gate after paymentLinks.create has already taken the money');

  // 3. Same refusal code as #1123 — it now means "capability absent", not
  //    "platform-only" — and still 403, never 402.
  ok('it refuses with 403, not 402',
    /res\.status\(403\)[\s\S]{0,200}ONLINE_PAYMENTS_UNAVAILABLE/.test(hs),
    '402 reads as an upsell; this is a capability we must not exercise on their behalf');

  // 4. The refusal must RETURN. "Warn and continue" is the forbidden shape:
  //    logging and then minting anyway routes the money regardless. Brace-match
  //    the gate's OWN block — a loose window matches an unrelated later
  //    `return;` and passes over a deleted one (the esign lesson, Part 4).
  {
    const gateAt = hs.indexOf('if (!capable || !liveSub) {');
    let block = '';
    if (gateAt !== -1) {
      const open = hs.indexOf('{', gateAt);
      let depth = 0;
      for (let i = open; i < hs.length; i++) {
        if (hs[i] === '{') depth++;
        else if (hs[i] === '}') { depth--; if (depth === 0) { block = hs.slice(open, i + 1); break; } }
      }
    }
    ok('the refusal branch RETURNS (never warn-and-continue)',
      gateAt !== -1 && block !== '' && /\breturn;/.test(block),
      'the `if (!capable || !liveSub)` block must return before the mint');
  }

  // 5. Test-mode is opt-in through the ONE sanctioned helper. The strict
  //    `=== '1'` itself is pinned + unit-tested against the logic module
  //    (tests/stripe-connect.test.js) — that is where the string lives.
  ok('allowTestMode comes from connectTestModeAllowed(process.env)',
    /connectTestModeAllowed\(process\.env\)/.test(hs),
    'an inline truthy env read would let any non-empty value enable test-mode charging');

  // 6. D6: a Connect mint additionally requires a LIVE subscription — the same
  //    status set as the checkout double-bill guard, INCLUDING past_due. A
  //    dunning tenant still holds a chargeable sub and must keep collecting
  //    from homeowners (rule: checkout-gate-live-sub-not-entitlement), which is
  //    why this is NOT shared.js requirePaidSubscription.
  ok('the mint reads the tenant subscription doc',
    /subscriptions\//.test(hs) && /hasLiveSubscription\(/.test(hs));
  ok('the live-sub status set includes past_due (dunning is not a charge block)',
    /CONNECT_MINT_LIVE_SUB = \{[\s\S]{0,200}past_due/.test(code),
    'requirePaidSubscription excludes past_due/unpaid/incomplete — using it here would cut off'
      + ' a tenant mid-dunning from collecting their own money');

  // 7. D5: ownership is TENANCY, not authorship — an owner regenerating a rep's
  //    link is not an intruder. Legacy invoices with no companyId stamp fall
  //    back to the creator's uid.
  const ownAt = hs.indexOf('invoice.companyId');
  ok('ownership is checked by tenancy with a legacy uid fallback',
    ownAt > -1 && /invoice\.createdBy === decoded\.uid/.test(hs));
  ok('the ownership check precedes the mint', ownAt > -1 && mintAt > ownAt);

  // 8. D5: companyId rides in BOTH metadata sets so the webhook tamper check
  //    can key on tenancy. The shared const is the point — two hand-written
  //    literals drift. The payment_intent_data literal ALSO proves that link
  //    payment_intent_data carries metadata and nothing else.
  ok('linkMetadata carries companyId',
    /linkMetadata = \{[\s\S]{0,220}companyId/.test(hs));
  ok('the same object is used for the link metadata',
    /metadata:\s*linkMetadata/.test(hs));
  ok('payment_intent_data carries ONLY that metadata',
    /payment_intent_data:\s*\{\s*metadata:\s*linkMetadata\s*\}/.test(hs),
    'on a PaymentLink, payment_intent_data accepts metadata/statement_descriptor/transfer_group'
      + ' only — routing params are TOP-LEVEL, so anything else here silently does nothing');

  // 9. D1: the destination-charge params themselves, at the mint.
  const mintTail = mintAt > -1 ? hs.slice(mintAt) : '';
  ok('the mint routes on behalf of the connected account',
    /on_behalf_of:\s*connectState\.accountId/.test(mintTail));
  ok('the mint sets the transfer destination to the connected account',
    /transfer_data:\s*\{\s*destination:\s*connectState\.accountId\s*\}/.test(mintTail));
  ok('the mint carries the computed platform fee',
    /application_fee_amount:\s*feeCents/.test(mintTail));

  // 10. D2: the fee can only be reached through the gate. A fee computed above
  //     the capability check would be a fee on an unrouted platform mint.
  ok('the platform fee sits AFTER the capability check',
    hs.indexOf('application_fee_amount') > capAt && capAt > -1,
    `application_fee_amount@${hs.indexOf('application_fee_amount')} mayCollectOnline@${capAt}`);
}

// ── Part 3: the client capability MIRROR (and no lost invoices) ───────
//
// REWRITTEN 2026-07-3x (Connect phase 3). The old check pinned a synchronous
// platform-uid comparison, which was the whole client story while the gate was
// binary. Phase 3 makes the answer per-tenant and asynchronous (a Firestore
// read of the connectAccounts mirror), so the pins move to the properties that
// still matter: the SAME four conditions the server predicate uses, fail-closed
// on anything unresolved, a cache that only ever stores a definitive answer,
// and an awaited short-circuit before the call. It is a MIRROR, never the
// authority — the server re-checks and 403s.
{
  const c = decomment(read('docs/pro/js/invoice-pipeline.js'));

  ok('client has a matching capability check', /async function _canCollectOnline\(/.test(c),
    'it must be async now: the answer comes from a Firestore read, not a uid comparison');

  // Brace-match the function body. Every condition pin below is scoped to it —
  // whole-file regexes would match the render paths that merely consume the
  // answer, and would pass over a deleted condition.
  let body = '';
  {
    const at = c.indexOf('async function _canCollectOnline(');
    if (at !== -1) {
      const open = c.indexOf('{', at);
      let depth = 0;
      for (let i = open; i < c.length; i++) {
        if (c[i] === '{') depth++;
        else if (c[i] === '}') { depth--; if (depth === 0) { body = c.slice(open, i + 1); break; } }
      }
    }
  }
  ok('the capability function body was located (the pins below are scoped)', body.length > 300);

  // The four conditions of mayCollectOnline(), mirrored verbatim in intent.
  ok('it requires an acct_ id, live charges, finished onboarding and livemode',
    /startsWith\('acct_'\)/.test(body)
    && /chargesEnabled === true/.test(body)
    && /detailsSubmitted === true/.test(body)
    && /livemode === true/.test(body),
    'any missing condition lets the client offer a link the server will refuse — or worse, mint'
      + ' against a test-mode account');
  ok('the platform tenant still short-circuits to allowed',
    /__NBD_OWNER_UID/.test(body),
    'the platform mint is unchanged by phase 3 and must not depend on a connectAccounts doc');
  ok('it reads the connectAccounts mirror, not the rate-limited callable',
    /'connectAccounts'/.test(body) && !/getConnectStatus/.test(body),
    'getConnectStatus is per-uid rate-limited and is not safe to call per render');
  ok('it fails CLOSED on an unresolved identity or a failed read',
    /catch \(e\) \{\s*return false;/.test(body),
    'an unknown identity must not be treated as a capable tenant');
  // REWRITTEN 2026-07-30. The previous single assertion here claimed — in its
  // own comment — to defend against an `if (false) { … }` wrapper around the
  // cache read. Mutation M12 proved it did not: it was a bare statement-presence
  // regex, so wrapping the statement in a disabled block preserved the substring
  // and the suite stayed green with the cache never consulted. The same
  // assertion's other half ("only a definitive answer is cached") was pinned by
  // nothing at all — caching a false on the unresolved-identity path, the exact
  // #1139 late-claims trap, also stayed green. Split into two assertions that
  // each bite:
  //   (a) ADJACENCY, not presence — the read must be the first statement of the
  //       try, so any wrapper or relocation breaks the match.
  //   (b) a NEGATIVE pin on the early-return path — it must not write the cache.
  ok('the cache read is the first thing the mirror does',
    /try \{\s*if \(_collectOnlineCache !== null\) return _collectOnlineCache;/.test(body),
    'a wrapped or relocated read leaves the identifiers in place while disabling the cache');
  // (b) PREMISE REWRITTEN 2026-07-30 (second pass). (b) shipped as
  //     `!/if \(!companyId\)[^\n]*_collectOnlineCache/` — SAME-LINE only, because
  //     of the [^\n]. It was hand-verified against exactly one mutation shape (a
  //     one-line early return) and passed; reformatting the same mutation into a
  //     multi-line block sails through with the suite green. Formatting was never
  //     the invariant. The invariant is a COUNT, and it holds in any formatting:
  //     exactly TWO statements may write this cache — the platform-owner
  //     short-circuit and the definitive answer computed after the mirror read —
  //     plus the module-level declaration. Both scopes are pinned, because each
  //     alone is escapable: body-only misses a write moved out to a helper,
  //     file-only misses a write moved in.
  const cacheWriteRe = /_collectOnlineCache\s*=[^=]/g;           // assignment, not `!==`/`===`
  const declRe = /(?:let|var|const)\s+_collectOnlineCache\s*=[^=]/g;
  const bodyWrites = (body.match(cacheWriteRe) || []).length;
  const fileWrites = (c.match(cacheWriteRe) || []).length - (c.match(declRe) || []).length;
  ok('exactly two statements cache the capability, and both are inside _canCollectOnline',
    bodyWrites === 2 && fileWrites === 2,
    'found ' + bodyWrites + ' cache write(s) in _canCollectOnline and ' + fileWrites
      + ' outside the declaration; expected 2 and 2 (the __NBD_OWNER_UID short-circuit and the'
      + ' post-read definitive answer). A THIRD write is a path that caches a NON-definitive'
      + ' answer: claims hydrate late, so a "false" cached before the identity resolves wedges'
      + ' online payments OFF for that tenant for the whole page load — the #1139 trap, and the'
      + ' unresolved-identity early return is where it keeps reappearing. A count that drops'
      + ' means a write moved out of this function, where none of these pins can see it.'
      + ' If a new cache point is genuinely legitimate, prove it can only run on a RESOLVED'
      + ' identity, then update this count deliberately.');
  ok('the unresolved-identity path still returns early, uncached',
    /if \(!companyId\)\s*\{?\s*return false;/.test(body),
    'anti-vacuity for the count above: delete the early return and the count stays 2 while an'
      + ' unresolved identity falls straight through into the mirror read');

  ok('generateStripePaymentLink AWAITS the mirror before calling the server',
    /if \(!\(await _canCollectOnline\(\)\)\) \{[\s\S]{0,300}ONLINE_PAYMENTS_UNAVAILABLE/.test(c),
    'a missing await makes the Promise truthy and every tenant passes the client gate');
  ok('a server refusal is normalised back onto error.code',
    /\/ONLINE_PAYMENTS_UNAVAILABLE\/\.test\(String\(error\.message/.test(c),
    'markPaid regen and the create-invoice path both branch on error.code — an un-normalised'
      + ' server 403 falls through to the generic warning and leaves a stale link in place');

  // The duplicate-invoice bug: link generation must not sit inside the same
  // try as invoice creation, or a link failure reads as a creation failure.
  // 2026-10-03: createInvoiceUI asks createOrOpenJobInvoice (one live
  // invoice per job); the ordering rule below is unchanged.
  const createAt = c.indexOf('const made = await createOrOpenJobInvoice(estimateId);');
  const toastAt = c.indexOf("showToast('Invoice created successfully', 'success')");
  const linkAt = c.indexOf('await generateStripePaymentLink(invoiceId);', createAt);
  ok('invoice creation is reported BEFORE the payment link is attempted',
    createAt > -1 && toastAt > createAt && linkAt > toastAt,
    'a link failure used to skip the success toast AND the detail modal -> rep clicks Create again -> two invoices');
  ok('the link attempt has its own catch',
    /catch \(linkErr\)/.test(c));
  ok('a tenant is told to use Mark Paid rather than shown an error',
    /Mark Paid/.test(c));

  // An invoice SMS with no link must not send a dangling "Payment link: ".
  // 2026-10-03: the opener varies (a balance send names the balance); the
  // link line is still only added when there is a link.
  ok('the invoice SMS drops the link line when there is no link',
    /const message = link\s*\n?\s*\? `\$\{opener\} Payment link: \$\{link\}`\s*\n?\s*: `\$\{opener\.replace\(/.test(c));

  // D12: the customer-tasks Pay button read `inv.paymentUrl`, a field nothing
  // has ever written — so the one place a homeowner-facing surface offered to
  // take a card payment was dead markup. Now that tenants can actually collect,
  // it must key on the field the pipeline really writes.
  const ct = decomment(read('docs/pro/js/customer-tasks-ui.js'));
  // 2026-10-03: through ky-insurance-law.js payUrlUnlessHeld, which reads
  // stripePaymentLink OR stripeHostedUrl and holds a Kentucky job's link.
  ok('the customer Pay anchor keys on the field the pipeline writes',
    /_J\.payUrlUnlessHeld\(_payLead, inv, /.test(ct));
  ok('no reference to the phantom paymentUrl field survives',
    !/inv\.paymentUrl/.test(ct),
    'a field nobody writes renders a button nobody can click');
}

// ── Part 4: the OTHER homeowner→contractor path — retired (2026-10-04) ──
// C5 (createStripeInvoiceForEstimate) drafted a Stripe invoice on the PLATFORM
// account from the BoldSign signature webhook, gated platform-only by this
// suite since 2026-07-29. The webhook never had a secret, so C5 never ran; it
// was deleted with BoldSign rather than ported to in-house signing (no
// idempotency key, its only guard written last — STABILITY-AUDIT-2026-09-04 —
// and the invoice pipeline already bills a signed estimate). Pinned here so a
// signing path cannot quietly start minting platform-account Stripe objects for
// another tenant's homeowner again.
{
  const fnDir = path.join(__dirname, '..', 'functions');
  const files = fs.readdirSync(fnDir).filter((f) => f.endsWith('.js'));
  const c5 = files.filter((f) => /createStripeInvoiceForEstimate/.test(fs.readFileSync(path.join(fnDir, f), 'utf8')));
  ok('no function still defines or calls createStripeInvoiceForEstimate (C5)', c5.length === 0, c5.join(', '));
  ok('the BoldSign webhook module that ran C5 is gone',
    !fs.existsSync(path.join(fnDir, 'integrations', 'esign.js')));
  for (const f of ['esign-envelope.js', 'esign-io.js', 'esign-reminders.js']) {
    const s = decomment(read('functions/' + f));
    ok(f + ' touches no Stripe API (signing never mints platform customers or invoices)',
      !/require\(['"]stripe['"]\)/.test(s) && !/stripe\.(customers|invoices|invoiceItems)\./.test(s));
  }
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
