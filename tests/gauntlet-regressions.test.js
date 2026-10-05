/**
 * tests/gauntlet-regressions.test.js — locks in the 2026-07-16 stranger-
 * gauntlet Fix Batch 1 (invite-claim flag, seat/billing gates, tenant-zero
 * brand leaks, invitee register bypass, CI gate).
 *
 * Part A imports the real seatLimitForPlan via functions/handlers/invites.js
 * _test export (needs functions/node_modules installed — same requirement as
 * the smoke suite). Part B is source-contract regex guards in the repo's
 * smoke idiom: they pin the FIX SHAPES so a refactor can't silently revert
 * the gauntlet blockers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function assert(name, cond, hint) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (hint ? ' — ' + hint : '')); console.log('  ✗ ' + name); }
}

// ── Part A: seatLimitForPlan matrix (real import) ─────────────────────
console.log('seatLimitForPlan — plan → invited-seat matrix');
{
  const { _test } = require(path.join(ROOT, 'functions/handlers/invites.js'));
  const f = _test.seatLimitForPlan;
  assert('free → 0 invite seats', f('free') === 0);
  assert('starter → 0 invite seats (solo: 1 user total)', f('starter') === 0);
  assert('team → 2 invite seats (mid-tier; makes the seat-picker reachable)', f('team') === 2);
  assert('growth → 5 invite seats', f('growth') === 5);
  assert('enterprise → Infinity', f('enterprise') === Infinity);
  assert('unknown plan falls back to free (0)', f('definitely-not-a-plan') === 0);
  assert('undefined plan falls back to free (0)', f(undefined) === 0);
}

console.log('\nTeam plan ($149, 2 seats) — wired server + client + stripe + pricing');
{
  const { _test } = require(path.join(ROOT, 'functions/billing.js'));
  const t = _test.PLAN_LIMITS.team;
  assert('server PLAN_LIMITS.team = 150 leads / 2 reps / 100 aiCalls / unlimited reports',
    !!t && t.leads === 150 && t.reps === 2 && t.aiCalls === 100 && t.reports === Infinity);
  const bg = read('docs/pro/js/billing-gate.js');
  assert('client PLANS.team = Team $149, 2 reps, matching caps',
    /team:\s*\{ label: 'Team',\s*leads: 150,[\s\S]{0,90}reps: 2,[\s\S]{0,40}price: 149/.test(bg));
  assert('client upgrade ladder is free→starter→team→growth',
    /_plan === 'starter' \? 'team'[\s\S]{0,60}_plan === 'team' \? 'growth'/.test(bg));
  const st = read('functions/stripe.js');
  assert('stripe: team accepted + price mapped + trial granted + metadata-allowed',
    /VALID_PLANS = \[[^\]]*'team'/.test(st)
    && /\[STRIPE_PRICE_TEAM\.value\(\)\]:\s*'team'/.test(st)
    && /normalizedPlan === 'growth' \|\| normalizedPlan === 'team'/.test(st)
    && /ALLOWED_FROM_METADATA = new Set\(\['starter', 'team', 'growth'\]\)/.test(st));
  assert('STRIPE_PRICE_TEAM secret declared + bound (checkout + webhook + price map)',
    /STRIPE_PRICE_TEAM\s*=\s*defineSecret\('STRIPE_PRICE_TEAM'\)/.test(st)
    && (st.match(/STRIPE_PRICE_TEAM/g) || []).length >= 5);
  const pr = read('docs/pro/pricing.html');
  assert('pricing page has a Team card (data-plan="team", $149)',
    /data-plan="team"/.test(pr) && /tier-name">Team</.test(pr) && /\$149/.test(pr));
  const pp = read('docs/pro/js/pricing-page.module.js');
  assert('pricing-page resume-checkout allows team',
    /plan !== 'starter' && plan !== 'team' && plan !== 'growth'/.test(pp));
  // Funnel intent: a signed-out Team click must survive register + login so
  // pricing-page can resume checkout. Both allowlists dropped 'team' — a live
  // sellable plan — silently killing every signed-out Team purchase at signup.
  const reg = read('docs/pro/js/pages/register.js');
  assert('register.js plan-intent allowlist includes team',
    /PLAN_INTENTS = \['starter', 'team', 'growth'\]/.test(reg),
    'a signed-out Team CTA click must stash nbd_plan_intent, not drop it');
  const lg = read('docs/pro/js/pages/login.js');
  assert('login.js pricing-redirect allowlist includes team',
    /PLAN_INTENTS\s*=\s*\[[^\]]*['"]team['"]/.test(lg)
      || /plan === 'starter' \|\| plan === 'team' \|\| plan === 'growth'/.test(lg),
    'login?redirect=pricing&plan=team must carry the intent through');
  assert('login.js resumes nbd_plan_intent after login (not only redirect=pricing)',
    /sessionStorage\.getItem\(\s*['"]nbd_plan_intent['"]\s*\)/.test(lg)
    && /\/pro\/pricing\.html/.test(lg),
    'returning visitors with a stashed plan intent must not land on dashboard and drop the upsell');
  // 2026-07-28 first-run audit: the zero-seat invite refusal recommended the
  // Growth plan ($299) when Team ($149) is the cheapest sufficient plan.
  const invSrc = read('functions/handlers/invites.js');
  assert('seat-gate copy recommends the cheapest sufficient plan (Team, not Growth)',
    !/Team invites need the Growth plan/.test(invSrc) && /Team plan \(\$149\/mo\)/.test(invSrc));
  assert('seat-gate refusal copy is single-sourced at BOTH throw sites (pre-check + txn re-check)',
    (invSrc.match(/seatCapMessage\(/g) || []).length >= 3,
    'the duplicated ternary is how the Growth copy survived at the race-path site');
  assert('createTeamMember seat copy does not point at the wrong plan',
    !/Team seats need a paid plan/.test(read('functions/handlers/admin.js')));
}

// 2026-09-14: the checks above cover billing-gate.js, stripe.js, invites.js
// and the pricing/register/login funnel, but NOT nbd-auth.js's PLAN_LEVELS —
// the auth gate init() actually reads. _normalizePlan('team') fell through
// to 'free' there (team was absent from both PLAN_LEVELS and its alias map),
// walling a paying Team tenant off every requiredPlan:'starter'/'growth'
// page (pro-analytics-gate.js, project-codex-auth.module.js, vault, ask-joe,
// ai-tree, understand, ai-tool-finder) and showing them the free-tier
// upgrade banner. Grok CRM audit evaluation, 2026-09-13.
console.log('\nTeam plan — nbd-auth.js PLAN_LEVELS (the auth GATE, not just billing-gate.js)');
{
  const na = read('docs/pro/js/nbd-auth.js');
  assert('PLAN_LEVELS includes team, ordered between starter and growth',
    /PLAN_LEVELS = \{[^}]*starter:\s*2,\s*team:\s*3,\s*growth:\s*4,\s*enterprise:\s*5/.test(na),
    "a plan:'team' subscription doc must not normalize to level 0 (free) in the requiredPlan gate");
  assert('PLAN_NAMES includes Team',
    /PLAN_NAMES = \{[\s\S]{0,200}team:\s*'Team'/.test(na));
}

console.log('\nTeam plan — server AI/voice/vision budget maps (all four had no team row)');
{
  const shared = read('functions/handlers/_shared.js');
  assert('CLAUDE_COMPANY_BUDGET.team is set and above starter, below growth',
    /team:\s*100_000/.test(shared),
    'a Team company must not fall through to CLAUDE_COMPANY_BUDGET_DEFAULT (the free-tier allowance)');
  const voice = read('functions/integrations/voice-intelligence.js');
  assert('VOICE_COMPANY_BUDGET_SEC.team is set and above starter, below growth',
    /team:\s*126000/.test(voice));
  const pv = read('functions/photo-vision.js');
  assert('photo-vision PER_USER_MONTHLY_USD_CAP_BY_PLAN.team is set and above starter, below growth',
    /team:\s*50\.00/.test(pv));
  const rv = read('functions/receipt-vision.js');
  assert('receipt-vision PER_USER_MONTHLY_USD_CAP_BY_PLAN.team is set',
    /team:\s*50\.00/.test(rv));
}

console.log('\nCap-blocked D2D convert — _saveLead\'s return must not be discarded');
{
  const d2d = read('docs/pro/js/d2d-tracker-core-2026b.js');
  const fnStart = d2d.indexOf('async function convertToLead(knockId)');
  // To the next function, not a fixed 12000-char window: the body outgrew it
  // (2026-10-04, appointment booking + #2118's follow-up rule).
  const fnEnd = d2d.indexOf('function convertToLeadWithEdit(', fnStart);
  const fnBody = fnStart >= 0 ? d2d.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 20000) : '';
  assert('convertToLead captures _saveLead\'s return value',
    /const leadId = await window\._saveLead\(leadData\)/.test(fnBody));
  assert('convertToLead bails before marking the knock converted when _saveLead short-circuits',
    // Since 2026-09-28 the bail also releases the transaction's lock (behaviour
    // pinned in tests/d2d-convert-lock-release-2026-09-28.test.js).
    /if \(!leadId\) \{ await _release\(\); return; \}/.test(fnBody)
      && fnBody.indexOf('if (!leadId) { await _release(); return; }') < fnBody.indexOf('updateKnock(knockId'),
    'a capped tenant must not see "Converted to CRM Lead" with no lead actually created');
}

console.log('\nAccess-code grant — must not silently overwrite a live, card-billed subscription');
{
  const portal = read('functions/handlers/portal.js');
  assert('validateAccessCode checks the existing sub for a live Stripe subscription before writing',
    /existingData\.stripeSubscriptionId && LIVE_SUB_STATUS\[String\(existingData\.status\)\]/.test(portal));
  assert('…and refuses the grant (throws) rather than merging over it',
    /access_code_blocked_live_sub/.test(portal) && /throw new HttpsError\('failed-precondition'/.test(portal.slice(portal.indexOf('access_code_blocked_live_sub'), portal.indexOf('access_code_blocked_live_sub') + 400)));
}

// ── Part B: source-contract guards ────────────────────────────────────
console.log('\nInvite lifecycle — past_due entitlement + invitee email link');
{
  const src = read('functions/handlers/invites.js');
  assert('past_due keeps seat entitlement during dunning',
    /subData\.status === 'active' \|\| subData\.status === 'trialing'\s*\|\| subData\.status === 'past_due'/.test(src),
    'a paying owner mid-dunning must not get the free-tier "solo" refusal');
  assert('invite email (HTML) links register.html?invite=1',
    /register\.html\?invite=1/.test(src) && src.indexOf('register.html?invite=1') !== src.lastIndexOf('register.html?invite=1'),
    'both the HTML button and the text fallback must carry the invite marker');
}

console.log('\nInvite/claim hardening (Phase-3 QA sweep)');
{
  const src = read('functions/handlers/invites.js');
  // Cross-tenant ambiguous claim: read more than one hit + refuse when two
  // companies match, instead of limit(1) silently claiming the smallest-path
  // companyId. 2026-09-25: the lookup moved to functions/handlers/invite-lookup.js
  // (shared with onRepSignup), which drops docs that are not real invites
  // BEFORE counting companies and reads a page of INVITE_SCAN_LIMIT so the
  // dropped ones cannot use up the page. The behaviour is exercised against
  // the emulator in tests/invite-claim-path.integration.test.js; these pin
  // the wiring.
  const lookupSrc = read('functions/handlers/invite-lookup.js');
  const lookupCode = lookupSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  const { INVITE_SCAN_LIMIT, INVITE_MAX_PAGES } = require(path.join(ROOT, 'functions/handlers/invite-lookup.js'));
  // 2026-09-25 review fixup: one page is not the whole answer. The lookup
  // pages (startAfter the last doc) until a short page, and a scan that hits
  // INVITE_MAX_PAGES answers 'ambiguous' instead of 'found'/'none'. Cases 10
  // and 11 of the emulator suite exercise both; these pin the wiring.
  assert('invite lookup pages through every hit, not one limit(n) page',
    /collectionGroup\('members'\)/.test(lookupCode)
    && /opts\.pageSize\) \|\| INVITE_SCAN_LIMIT;/.test(lookupCode)
    && /\.limit\(pageSize\)/.test(lookupCode)
    && /\.startAfter\(last\)/.test(lookupCode)
    && INVITE_SCAN_LIMIT >= 2 && INVITE_MAX_PAGES >= 2,
    'limit(1) silently claims the lexicographically-smallest companyId on a same-email collision; one page hides hits past it');
  assert('invite lookup fails closed when it hits its page cap',
    /if \(truncated\) return Object\.assign\(base, \{ status: 'ambiguous'/.test(lookupCode),
    'a capped scan cannot rule out a second invite, so it must not answer found or none');
  // Comments stripped for the absence check: invites.js explains the old
  // inline query by quoting it.
  const invCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  assert('claimInvite resolves its invite through findPendingInvite, not its own query',
    /await findPendingInvite\(db, email\)/.test(invCode) && !/collectionGroup\(/.test(invCode),
    'a second inline query would bring back the parent-path trust the shared lookup removes');
  assert('claimInvite refuses an ambiguous cross-tenant invite',
    /tenantIds\.length > 1\) return Object\.assign\(base, \{ status: 'ambiguous'/.test(lookupSrc)
    && /lookup\.status === 'ambiguous'[\s\S]{0,320}reason: 'ambiguous_invite'/.test(src),   // 320: the log line masks the email since 2026-10-01
    'two tenants inviting the same email must not silently claim one — cross-tenant leak + lockout');
  // Email-verify wall reads the authoritative Auth record, not just the token,
  // so a just-verified rep with a stale ID token is not stranded.
  assert('claimInvite rechecks emailVerified on the Auth record',
    /getAuth\(\)\.getUser\(uid\)[\s\S]{0,120}rec\.emailVerified === true/.test(src),
    'a stale ID token (verified in another tab) must not strand a rep behind the verify wall');
  // Expired-invite seat-cap: re-inviting an EXPIRED pending invite must take a
  // fresh seat (occupied[] already freed it), not be credited a reused seat.
  assert('seat reuse credited only for a NON-expired existing invite',
    /reusesSeat = existingStatus === 'invited' && !isInviteExpired\(existing\.data\(\)\)/.test(src)
    && /seatsAfter = occupied\.length \+ \(reusesSeat \? 0 : 1\)/.test(src),
    're-inviting an expired invite must not bypass the seat cap by one');
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('client keeps ambiguous_invite non-terminal (self-heals on resolution)',
    /out\.reason === 'ambiguous_invite'/.test(boot),
    'a terminal flag would strand the rep after the owner cancels the stray invite');
}

console.log('\nremoveMember — pending-invite cancel frees the seat');
{
  const src = read('functions/handlers/admin.js');
  assert('pending-invite state detected (status invited, no uid)',
    /isPendingInvite = member\.status === 'invited' && !lookupUid/.test(src));
  assert('foreign-claim guard exempts pending invites from the throw',
    /if \(!managesTarget && !isPendingInvite\)/.test(src),
    'cancelling an invite whose recipient registered elsewhere must not throw');
  assert('claim mutation still gated on managesTarget',
    /if \(managesTarget\) \{[\s\S]{0,400}setCustomUserClaims/.test(src),
    'never strip claims of an account scoped to another company');
}

console.log('\nSeat picker — assignSeats (over-capacity cap-enforced choice)');
{
  const inv = read('functions/handlers/invites.js');
  assert('assignSeats callable is defined + App Check enforced',
    /exports\.assignSeats = onCall\(/.test(inv)
    && /assignSeats[\s\S]{0,300}enforceAppCheck: true/.test(inv));
  assert('assignSeats hard-caps chosen-active at seatLimitForPlan(plan)',
    /targetActive = claimed\.filter[\s\S]{0,200}cap !== Infinity && targetActive\.length > cap[\s\S]{0,160}resource-exhausted/.test(inv),
    'the picker must not activate more reps than the plan allows');
  assert('assignSeats benches with a NON-lapse reason (checkout must not un-bench)',
    /deactivatedReason: 'seat-unassigned'/.test(inv)
    && !/deactivatedReason: 'lapse'[\s\S]{0,200}assignSeats/.test(inv),
    "seat-unassigned (not 'lapse') so reactivateLapsedSeats leaves an owner's choice intact");
  assert('assignSeats never touches the owner or pending invites',
    /md\.uid && md\.uid !== ownerId/.test(inv));
  const idx = read('functions/index.js');
  assert('assignSeats exported from functions/index.js',
    /exports\.assignSeats = inviteHandlers\.assignSeats/.test(idx));
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  assert('team tab renders the seat picker + calls assignSeats',
    /_renderSeatPanel\(/.test(tab) && /_teamCallable\('assignSeats'/.test(tab));
  assert('seat picker cap mirrors server seatLimitForPlan (reps<=1 => 0)',
    /reps <= 1 \? 0 : reps/.test(tab));
}

console.log('\nCompany-keyed billing reads (AI surfaces)');
{
  const ai = read('functions/handlers/ai.js');
  assert('ai.js resolves billingKey = companyId || uid',
    /billingKey = decoded\.companyId \|\| decoded\.uid/.test(ai)
    && /subscriptions\/\$\{billingKey\}/.test(ai));
  assert('ai.js accepts trialing as paid',
    /sub\.status === 'active' \|\| sub\.status === 'trialing'/.test(ai),
    'a Growth trial is the conversion window — AI must work during it');
  const pv = read('functions/photo-vision.js');
  // photo-vision's spend path is one classifyPhoto() shared by the callable
  // and the onCreate trigger door; each door passes the billing key in. The
  // callable keys on the companyId claim, the trigger on the photo doc's
  // companyId, and classifyPhoto reads subscriptions/{billingKey}.
  assert('photo-vision.js plan read keyed by companyId claim',
    /billingKey: \(request\.auth\.token && request\.auth\.token\.companyId\) \|\| uid/.test(pv)
    && /billingKey: photo\.companyId \|\| photo\.userId/.test(pv)
    && /subscriptions\/\$\{billingKey \|\| uid\}/.test(pv));
  const rv = read('functions/receipt-vision.js');
  assert('receipt-vision.js plan read keyed by companyId claim',
    /billingKey = \(request\.auth\.token && request\.auth\.token\.companyId\) \|\| uid/.test(rv)
    && /subscriptions\/\$\{billingKey\}/.test(rv));
  // requirePaidSubscription gates sendSMS + sendD2DSMS. It was the last
  // billable gate still uid-keyed + active-only, so every rep of a paying
  // tenant (no subscriptions/{repUid} doc) and every trialing owner got 402.
  const shared = read('functions/shared.js');
  assert('shared.js requirePaidSubscription keys on companyId || uid',
    /billingKey = decoded\.companyId \|\| uid/.test(shared)
    && /subscriptions\/'\s*\+\s*billingKey/.test(shared),
    'a rep of a paying tenant must not be gated as free on SMS');
  assert('shared.js requirePaidSubscription accepts trialing as paid',
    /sub\.status === 'active' \|\| sub\.status === 'trialing'/.test(shared),
    'SMS must work during the Growth trial (parity with the AI gate)');
}

console.log('\nInvite-claim flag — uid-keyed, sign-out cleared, young-account grace');
{
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('invite-checked flag is keyed by uid',
    /'nbd_invite_checked_' \+ user\.uid/.test(boot),
    'device-global flag bricked shared devices + out-of-order signups');
  assert('rep-activated flag is keyed by uid',
    /'nbd_rep_activated_' \+ user\.uid/.test(boot));
  assert('sign-out clears both flag families',
    /_signOut[\s\S]{0,700}nbd_invite_checked[\s\S]{0,200}nbd_rep_activated[\s\S]{0,200}removeItem/.test(boot));
  assert("young accounts keep re-checking on 'no_invite'",
    /out\.reason === 'no_invite' && _youngAccount/.test(boot),
    'a fresh signup often precedes the invite — no_invite must not be terminal for 14 days');
  assert('unverified-email invite failure renders the banner + resend',
    /nbdVerifyBanner/.test(boot) && /sendEmailVerification\(user\)/.test(boot),
    'console-only failure left reps believing they had joined');
}

console.log('\nManual invite-claim recovery (Team tab)');
{
  const html = read('docs/pro/dashboard.html');
  assert('dashboard has the "Check my invite now" action',
    /data-team-action="checkMyInvite"/.test(html) && /id="inviteCheckResult"/.test(html));
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  assert('checkMyInvite delegate calls claimInvite directly',
    /checkMyInvite/.test(tab) && /_teamCallable\('claimInvite'/.test(tab));
  assert('recovery delegate guarded against re-hydration double-wiring',
    /_NBD_INVITE_CHECK_DELEGATE/.test(tab));
}

console.log('\nExplicit Join for company owners (2026-09-29)');
{
  // The server previews for an owner (confirm_required) and joins only on
  // { confirm: true } — tests/invite-claim-path.integration.test.js §12 drives
  // it. These pin the client half: both callers prompt, the boot never waits
  // on a person, and a decline survives sign-out.
  const html = read('docs/pro/dashboard.html');
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  const ij = read('docs/pro/js/invite-join.js');
  assert('invite-join.js loads (deferred) before the bootstrap that calls it',
    html.indexOf('js/invite-join.js') > 0 && html.indexOf('js/invite-join.js') < html.indexOf('js/dashboard-bootstrap.module.js'));
  assert('boot prompts on confirm_required without awaiting it (the claim await gates loadLeads)',
    /out\.reason === 'confirm_required'/.test(boot) && /window\.NBDInviteJoin\.handle\(out, \(p\) => fn\(p\), \{ fromBoot: true \}\)\.then\(/.test(boot));
  assert('confirm_required is NOT terminal at boot (no checked flag set)',
    /\|\| out\.reason === 'confirm_required'\) \{/.test(boot));
  assert('Team tab "Check my invite now" prompts too, even after a boot decline',
    /data\.reason === 'confirm_required' && window\.NBDInviteJoin/.test(tab) && /fromBoot: false/.test(tab));
  assert('a decline is stored on userSettings (survives sign-out), not nbd_ localStorage',
    /inviteDeclined: \{ \[companyId\]: Date\.now\(\) \}/.test(ij) && /'userSettings'/.test(ij) && !/localStorage/.test(ij.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert('joining asks twice and sends confirm: true only after the second yes',
    /second !== 'confirm'\) return 'later'/.test(ij) && /callFn\(\{ confirm: true \}\)/.test(ij)
      && ij.indexOf("second !== 'confirm'") < ij.indexOf('callFn({ confirm: true })'));
  assert('company name escaped before innerHTML', /const co = esc\(r\.companyName/.test(ij));
}

console.log('\nInvitee register bypass (?invite=1)');
{
  const reg = read('docs/pro/js/pages/register.js');
  assert('invite intent parsed from ?invite=1',
    /get\('invite'\) === '1'/.test(reg));
  assert('email path: invitees skip solo provisioning + owner wizard',
    /if \(inviteIntent\) \{\s*window\.location\.replace\('\/pro\/dashboard\.html'\);/.test(reg));
  assert('google path: invitees not provisioned, routed to dashboard (via ownerDest reorder)',
    /isNewUser && !inviteIntent/.test(reg)
    && /isNewOwner = !code && isNewUser && !inviteIntent/.test(reg)
    && /dest = isNewOwner \? ownerDest\(\) : '\/pro\/dashboard\.html'/.test(reg),
    'invitees (inviteIntent) are excluded from isNewOwner so they still go to dashboard, not the funnel');
  assert('google + access-code path provisions a tenant (#945 parity)',
    /signInWithCustomToken\(auth, result\.data\.customToken\);[\s\S]{0,700}createCompanyFn\(/.test(reg),
    'paid code-holders on the Google branch landed with no companies doc/claims');
}

console.log('\nTenant-zero brand leak — letterhead tagline');
{
  const dg = read('docs/pro/js/document-generator.js');
  assert('_letterhead tagline gated on NBD identity (non-NBD: C.tagline only)',
    /tagline: esc\(\(C\.name === 'No Big Deal Home Solutions'\)[\s\S]{0,120}: \(C\.tagline \|\| ''\)\)/.test(dg),
    "cp.tagline falls through merged defaults to NBD's tagline on stranger paper");
}

console.log('\nClient billing gate — primed at boot + no silent hard-block');
{
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('billing gate is primed once at login (loadSubscription at boot)',
    /window\.NBDBilling\.loadSubscription\(\)/.test(boot),
    'without a boot load _loaded stays false and enforceGate/softGate fail open all session (free = unlimited leads)');
  const bg = read('docs/pro/js/billing-gate.js');
  assert('growth-cap hard-block surfaces a toast instead of a silent no-op',
    /if \(!nextPlan\) \{/.test(bg)
    && /showToast\(/.test(bg)
    && /reached your monthly limit/.test(bg),
    'a Growth tenant at the lead cap had Add-Lead silently do nothing (no modal, no toast)');
}

console.log('\nCI gate — @stranger shard is required');
{
  const ci = read('.github/workflows/ci.yml');
  // Asserted by INTENT, not by the shape of the expression. This originally
  // pinned the literal `continue-on-error: ${{ matrix.shard != '@stranger' }}`,
  // which was the only way to keep @stranger blocking while the other four
  // shards were advisory. All five are blocking now (they earned it on a
  // 60-run green record), so that literal is gone — but the requirement it
  // encoded is strictly better satisfied, and a test that fails on a change
  // which over-satisfies it is testing the wrong thing.
  //
  // What must stay true: no PROMOTED shard, and specifically not @stranger,
  // is exempt from blocking. 2026-08-07: the matrix gained an @engines leg
  // on the introduction runway (the same advisory→required path @gauntlet
  // took), gated by an expression — so the check is now that the matrix
  // exemption names ONLY @engines (never @stranger or the other four), and
  // that bare `continue-on-error: true` literals are confined to the named
  // runway jobs. Promoting a runway job means flipping its literal AND this
  // count.
  //
  // 2026-08-19: FOUR, not three. qc-render-sweep (the rendered docs/ gate that
  // shipped with the site-QC lane) joined the runway and neither copy of this
  // count was updated with it — this suite and tests/smoke/functions.test.js
  // both pin the same invariant, and both were red on the qc branch before the
  // cost-migration branch forked off it. The runway is now public-e2e,
  // qc-render-sweep, visual-brand-tokens and visual-regression.
  //
  // Two suites pinning one invariant is deliberate redundancy, not an
  // accident — but it does mean a change here needs the same change there.
  // 2026-08-26: the runway is EMPTY. @engines reached 10/10 on the
  // WEEKLY_CADENCE ledger and its matrix expression is gone; the four runway
  // literals (public-e2e, qc-render-sweep, visual-brand-tokens,
  // visual-regression) were promoted the same day on the same evidence. The
  // two assertions this block used to carry (matrix exemption names ONLY
  // @engines; exactly 4 runway literals) collapsed into one strictly
  // stronger pin, same reasoning as the 2026-07-28 note above: no
  // continue-on-error of ANY shape, anywhere in ci.yml — which subsumes
  // "@stranger is never exempt". Re-parking a flaking job stays legitimate,
  // at the price every promotion paid: a dated WHY note in ci.yml plus this
  // pin and its functions.test.js twin.
  // Line-anchored: count the YAML KEY, not the substring — doctrine comments
  // are allowed to say "continue-on-error:" (the smoke-runner note does).
  assert('every ci.yml job gates merges — no continue-on-error key of any shape',
    (ci.match(/^\s*continue-on-error:/gm) || []).length === 0,
    'a job regaining continue-on-error (literal or expression) is the hole this guards');
  // 2026-08-23: this used to grep ci.yml for the suite's own filename, which
  // stopped being the truth when the smoke job's 65 hand-written steps
  // collapsed into one aggregated `--bucket smoke` runner. The invariant is
  // unchanged — "this suite gates merges" — but it now takes two facts: the
  // suite is classified into a RUNNABLE bucket, and ci.yml still has a step
  // that executes that bucket. Grepping ci.yml alone would now be satisfied by
  // a comment; grepping the manifest alone would be satisfied by a bucket
  // nothing runs.
  const mf = JSON.parse(read('tests/ci-manifest.json'));
  assert('this suite is classified into a runnable manifest bucket',
    Object.prototype.hasOwnProperty.call(mf.smoke || {}, 'gauntlet-regressions.test.js'),
    'add gauntlet-regressions.test.js to the "smoke" bucket of tests/ci-manifest.json');
  assert('ci.yml executes the runnable bucket this suite is in',
    /^\s*run:\s*node scripts\/run-test-manifest\.js --bucket smoke\s*$/m.test(ci),
    'restore the "Run smoke bucket" step in ci.yml — without it 65 suites gate nothing');
}

console.log('\nStripe webhook idempotency — marker cleared on failure so retries recover');
{
  const stripe = read('functions/stripe.js');
  assert('processing-error path deletes the stripe_events marker so Stripe retries re-process',
    /stripeWebhook processing error/.test(stripe)
    && /getFirestore\(\)\.doc\(`stripe_events\/\$\{event\.id\}`\)\.delete\(\)/.test(stripe),
    'marker written before processing + kept on error => Stripe retry short-circuits as duplicate, paid tenant never activated');
}

console.log('\nMembers roster rules — same-company claim read');
{
  const rules = read('firestore.rules');
  assert('members read grants same-company claim holders',
    /allow read: if isAdmin\(\)[\s\S]{0,400}request\.auth\.token\.companyId == companyId/.test(rules));
  const rulesCode = rules.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert('dead uid==memberId grant removed (docs are keyed by email)',
    !/request\.auth\.uid == memberId/.test(rulesCode));
}

// ═══════════════════════════════════════════════════════════════════
// BATCH 2 (2026-07-16 product decisions): enforced caps + nudges,
// lapse grace → reversible seat pause, 30-day invite expiry.
// ═══════════════════════════════════════════════════════════════════

console.log('\nInvite expiry — 30-day TTL (real import)');
{
  const { _test } = require(path.join(ROOT, 'functions/handlers/invites.js'));
  assert('INVITE_TTL_DAYS is 30', _test.INVITE_TTL_DAYS === 30);
  const day = 24 * 3600 * 1000;
  const now = Date.now();
  const inv = (ageDays, status = 'invited') => ({ status, invitedAt: { toMillis: () => now - ageDays * day } });
  assert('fresh invite valid', _test.isInviteExpired(inv(1), now) === false);
  assert('29-day invite still valid', _test.isInviteExpired(inv(29), now) === false);
  assert('31-day invite expired', _test.isInviteExpired(inv(31), now) === true);
  assert('active member never expires', _test.isInviteExpired(inv(90, 'active'), now) === false);
  assert('legacy invite without invitedAt never expires',
    _test.isInviteExpired({ status: 'invited' }, now) === false);
  const src = read('functions/handlers/invites.js');
  assert('claimInvite returns terminal invite_expired reason',
    /isInviteExpired\(memberData\)[\s\S]{0,120}reason: 'invite_expired'/.test(src));
  assert('expired invites stop consuming a seat',
    /md\.status === 'invited'\) return !isInviteExpired\(md\)/.test(src));
}

console.log('\nLapse lifecycle — grace, pause, reactivation');
{
  const { _test } = require(path.join(ROOT, 'functions/lapse-enforcement.js'));
  assert('LAPSE_GRACE_DAYS is 14', _test.LAPSE_GRACE_DAYS === 14);
  const src = read('functions/lapse-enforcement.js');
  assert('cron scans cancelled + unenforced + past-grace subscriptions',
    /where\('status', '==', 'cancelled'\)[\s\S]{0,120}where\('lapseEnforced', '==', false\)[\s\S]{0,120}where\('cancelledAt', '<=', cutoff\)/.test(src));
  assert('pause disables Auth + revokes tokens + flags deactivatedReason lapse',
    /disabled: true[\s\S]{0,300}revokeRefreshTokens[\s\S]{0,600}deactivatedReason: 'lapse'/.test(src));
  assert('pause only touches ACTIVE member docs (owner has no member doc)',
    /\.status === 'active'\)/.test(src));
  assert('reactivation restores ONLY lapse-paused members',
    /where\('deactivatedReason', '==', 'lapse'\)/.test(src));
  // deactivateUser MUST stamp a non-lapse deactivatedReason on manual disable
  // (and clear it on reactivate). Otherwise a member the cron paused
  // (reason:'lapse'), then owner-reactivated, then owner-deactivated, keeps a
  // stale 'lapse' reason and a later re-checkout silently un-disables an
  // intentionally removed rep — breaking "owner-deactivated members stay off".
  const admin = read('functions/handlers/admin.js');
  assert('deactivateUser stamps deactivatedReason (owner-removed / null)',
    /deactivatedReason: reactivate \? null : 'owner-removed'/.test(admin),
    'manual deactivate must not leave a stale lapse reason that re-checkout auto-restores');
  const stripe = read('functions/stripe.js');
  assert('subscription.deleted stamps cancelledAt + lapseEnforced:false',
    /status: 'cancelled',[\s\S]{0,700}cancelledAt: FieldValue\.serverTimestamp\(\),\s*lapseEnforced: false/.test(stripe));
  assert('checkout reactivates lapse-paused seats + clears lapse state',
    /reactivateLapsedSeats\(db, uid, plan, purchasedSeats\)/.test(stripe)
    && /cancelledAt: FieldValue\.delete\(\)/.test(stripe));
  // Downgrade-on-return: reactivateLapsedSeats must cap restorations at the new
  // plan's seat limit (oldest-activated first), not restore every paused rep —
  // otherwise a Growth→Starter return keeps reps over the new cap (billing
  // under-enforcement). Legacy 2-arg callers (plan omitted) restore all.
  assert('reactivateLapsedSeats caps restorations at the new plan seat limit',
    /reactivateLapsedSeats\(db, companyId, plan, purchasedSeats\)/.test(src)
    && /cap = plan == null \? Infinity : seatLimitForPlan\(plan\) \+ extraSeats/.test(src)
    && /if \(restored >= cap\) break/.test(src),
    'a downgrade-on-return must not restore reps over the new plan cap');
  const idx = read('firestore.indexes.json');
  assert('composite index for the lapse-cron query exists',
    /"subscriptions"[\s\S]{0,300}"status"[\s\S]{0,120}"lapseEnforced"[\s\S]{0,120}"cancelledAt"/.test(idx),
    'equality+equality+range needs a composite or the cron silently FAILED_PRECONDITIONs');
  const fnIdx = read('functions/index.js');
  assert('enforceLapsedSeats exported from functions/index.js',
    /exports\.enforceLapsedSeats = lapseEnforcement\.enforceLapsedSeats/.test(fnIdx));
}

console.log('\nUsage caps — enforced with nudges (metering wired)');
{
  const { _test } = require(path.join(ROOT, 'functions/billing.js'));
  assert('free plan caps 10 leads/mo (server truth)', _test.PLAN_LIMITS.free.leads === 10);
  const billing = read('functions/billing.js');
  assert('trackUsage rolls the cycle when the month changes (free tenants have no invoices)',
    /cycleMonth !== nowMonth/.test(billing) && /rolled/.test(billing));
  assert('rollover zeroes every metered feature explicitly (merge:true merges map fields)',
    /resetZeros/.test(billing) && /ALLOWED_FEATURES\]\.map\(\(f\) => \[f, 0\]\)/.test(billing));
  const gate = read('docs/pro/js/billing-gate.js');
  assert('enforceGate exists and blocks at the cap',
    /function enforceGate\(feature, featureLabel\)/.test(gate)
    && /if \(!canUse\(feature\)\) \{[\s\S]{0,200}return false/.test(gate));
  assert('enforceGate fails open before plan load + for owners',
    /function enforceGate[\s\S]{0,200}if \(!_loaded\) return true;[\s\S]{0,80}_isOwner\(\)\) return true/.test(gate));
  assert('enforceGate exported on NBDBilling', /enforceGate,/.test(gate));
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('_saveLead gates new leads through enforceGate',
    /NBDBilling\.enforceGate === 'function'[\s\S]{0,120}enforceGate\('leads', 'leads'\)/.test(boot));
  assert('both create branches meter via trackUsage',
    (boot.match(/NBDBilling\.trackUsage\('leads'\)/g) || []).length >= 2,
    'geocoded AND no-address fallback paths must both count');
  // CSV bulk import (first-run audit 2026-07-28): the import path must
  // mirror _saveLead — pre-gate, per-create meter, and a partial-import
  // stop at the cap — or a free tenant bulk-loads around the 10/mo cap
  // AND the imported leads never count against subsequent single adds.
  const imp = read('docs/pro/js/data-import.js');
  assert('CSV import pre-gates through enforceGate (mirrors _saveLead)',
    /NBDBilling\.enforceGate === 'function'[\s\S]{0,160}enforceGate\('leads', 'leads'\)/.test(imp));
  assert('CSV import meters each created lead via trackUsage',
    /NBDBilling\.trackUsage\('leads'\)/.test(imp),
    'unmetered imports leave the server counter low — later adds under-gate');
  assert('CSV import stops at the cap and surfaces it on the done screen',
    /skippedCap/.test(imp) && /plan limit/i.test(imp),
    'partial import up to the allowance + a clear "plan limit" message');
  assert('lapse banner renders for cancelled subscriptions',
    /lapseBanner/.test(boot) && /lapseEnforced === true/.test(boot));
  assert("invite_expired is non-terminal in the claim check",
    /out\.reason === 'invite_expired'/.test(boot));
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  assert('roster shows expired-invite state (30d mirror)',
    /inviteExpired/.test(tab) && /30 \* 24 \* 3600 \* 1000/.test(tab));
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE 1a (2026-07-17): per-seat add-on READ PATH. Plan derivation
// scans ALL subscription line items (a seat item at data[0] must never
// downgrade a payer); purchasedSeats is persisted by the webhook and
// honored at every seat-cap site. Money-free: inert until seats exist.
// ═══════════════════════════════════════════════════════════════════

console.log('\nPer-seat read path — derivePlanAndSeats (real import)');
{
  const { _test } = require(path.join(ROOT, 'functions/stripe.js'));
  const f = _test.derivePlanAndSeats;
  const MAP = { price_growth: 'growth', price_starter: 'starter' };
  const item = (id, qty) => ({ price: { id }, quantity: qty });
  let r = f({ data: [item('price_growth', 1)] }, MAP);
  assert('plan-only sub → plan derived, 0 purchased seats',
    r.plan === 'growth' && r.purchasedSeats === 0);
  r = f({ data: [item('price_growth', 1), item('price_seat', 3)] }, MAP);
  assert('plan + seat item → plan + 3 purchased seats',
    r.plan === 'growth' && r.purchasedSeats === 3);
  r = f({ data: [item('price_seat', 3), item('price_growth', 1)] }, MAP);
  assert('seat item FIRST still derives the plan (the data[0] downgrade bug)',
    r.plan === 'growth' && r.purchasedSeats === 3);
  r = f({ data: [item('price_starter', 1), item('price_growth', 1)] }, MAP);
  assert('duplicate plan-price items: first wins, never counted as seats',
    r.plan === 'starter' && r.purchasedSeats === 0);
  r = f({ data: [item('price_mystery', 4)] }, MAP);
  assert('no recognizable plan price → plan null (caller falls back safely)',
    r.plan === null);
  r = f({ data: [item('price_growth', 1), { price: { id: 'price_seat' } }] }, MAP);
  assert('seat item with missing quantity adds 0 seats', r.purchasedSeats === 0);
  r = f({ data: [item('price_growth', 1), item('price_seat', -2), item('price_seat2', 2.7)] }, MAP);
  assert('negative qty ignored, fractional qty floors', r.purchasedSeats === 2);
  r = f(undefined, MAP);
  assert('missing items object → {null, 0}', r.plan === null && r.purchasedSeats === 0);
}

console.log('\nPer-seat read path — persisted + honored at every cap site');
{
  const st = read('functions/stripe.js');
  assert('both webhook cases derive via the all-items scan',
    /derivePlanAndSeats\(sub\.items, PRICE_TO_PLAN\)/.test(st)
    && /derivePlanAndSeats\(subscription\.items, PRICE_TO_PLAN\)/.test(st)
    && !/PRICE_TO_PLAN\[priceId\]/.test(st),
    'items.data[0]-only derivation silently downgrades a payer once a 2nd line item exists');
  assert('purchasedSeats persisted by checkout.session.completed AND subscription.updated',
    /status: subStatus,\s*purchasedSeats,/.test(st)
    && /plan,\s*purchasedSeats,\s*status: subscription\.status/.test(st));
  assert('subscription.updated keeps the STORED seat count when plan underivable',
    /derived\.plan\s*\?\s*derived\.purchasedSeats\s*:\s*Math\.max\(0, Number\(stored\.purchasedSeats\) \|\| 0\)/.test(st),
    'ambiguous items must not zero a paid-for entitlement');
  assert('subscription.deleted clears purchasedSeats (seat items die with the sub)',
    /status: 'cancelled',[\s\S]{0,400}purchasedSeats: 0,/.test(st),
    'a stale seat count on a cancelled sub makes the client cap mirror lie');
  assert("stripe.js _test export is non-enumerable (index.js Object.assign must not deploy it)",
    /Object\.defineProperty\(exports, '_test'/.test(st) && /enumerable: false/.test(st));
  const inv = read('functions/handlers/invites.js');
  assert('createTeamInvite effective cap = seatLimitForPlan + purchasedSeats',
    /seats = seatLimitForPlan\(plan\) \+ purchasedSeats/.test(inv));
  assert('assignSeats effective cap = seatLimitForPlan + purchasedSeats',
    /cap = seatLimitForPlan\(plan\) \+ purchasedSeats/.test(inv));
  assert('purchased seats only count while the sub is ENTITLED (both cap sites)',
    (inv.match(/purchasedSeats = Math\.max\(0, Number\(subData\.purchasedSeats\) \|\| 0\)/g) || []).length >= 2,
    'a lapsed sub must not keep granting its purchased seats');
  const lapse = read('functions/lapse-enforcement.js');
  assert('lapse restore cap widens by sanitized purchasedSeats',
    /extraSeats = Math\.max\(0, Number\(purchasedSeats\) \|\| 0\)/.test(lapse));
  const bg = read('docs/pro/js/billing-gate.js');
  assert('client billing-gate captures + exposes purchasedSeats',
    /Math\.max\(0, Number\(data\.purchasedSeats\) \|\| 0\)/.test(bg)
    && /purchasedSeats: _purchasedSeats/.test(bg));
  assert('client seat mirror is entitled-status gated (matches server cap sites)',
    /entitledForSeats = _status === 'active' \|\| _status === 'trialing'\s*\|\| _status === 'past_due'/.test(bg)
    && /_purchasedSeats = entitledForSeats/.test(bg),
    "an 'unpaid'/'cancelled'/'trial_expired' doc's stale seats must not inflate the UI cap the server refuses");
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  assert('team-tab seat cap mirrors base + purchased',
    /pl\.purchasedSeats > 0 \? pl\.purchasedSeats : 0/.test(tab)
    && /return base \+ extra/.test(tab));
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE 1b (2026-07-17): per-seat CHARGING path — setCompanySeatCount
// updates the Stripe subscription's seat line item. DARK until
// STRIPE_PRICE_SEAT carries a real price id; deploy requires the secret
// to EXIST (merge gate — see handlers/seats.js header).
// ═══════════════════════════════════════════════════════════════════

console.log('\nPer-seat charging — buildSeatItemsUpdate (real import)');
{
  const { _test } = require(path.join(ROOT, 'functions/handlers/seats.js'));
  const f = _test.buildSeatItemsUpdate;
  const SEAT = 'price_seat';
  const PLANS_SET = new Set(['price_growth', 'price_team', 'price_starter']);
  const items = (...arr) => ({ data: arr });
  const plan = { id: 'si_plan', price: { id: 'price_growth' }, quantity: 1 };
  const seat = (qty) => ({ id: 'si_seat', price: { id: SEAT }, quantity: qty });
  assert('MAX_EXTRA_SEATS sanity ceiling is 50', _test.MAX_EXTRA_SEATS === 50);
  let r = f(items(plan), SEAT, 3, PLANS_SET);
  assert('no seat item yet + target 3 → create {price, quantity:3}',
    Array.isArray(r) && r.length === 1 && r[0].price === SEAT && r[0].quantity === 3 && !r[0].id);
  r = f(items(plan, seat(3)), SEAT, 5, PLANS_SET);
  assert('existing seat item 3 → 5 → update {id, quantity:5}',
    Array.isArray(r) && r.length === 1 && r[0].id === 'si_seat' && r[0].quantity === 5);
  r = f(items(plan, seat(3)), SEAT, 0, PLANS_SET);
  assert('existing seat item → 0 → delete {id, deleted:true}',
    Array.isArray(r) && r.length === 1 && r[0].id === 'si_seat' && r[0].deleted === true);
  assert('no seat item + target 0 → null (no API call)', f(items(plan), SEAT, 0, PLANS_SET) === null);
  assert('already at target → null (idempotent)', f(items(plan, seat(4)), SEAT, 4, PLANS_SET) === null);
  r = f(items(plan, { id: 'si_seat', price: { id: SEAT } }), SEAT, 2, PLANS_SET);
  assert('seat item with missing quantity treated as 0 → update to 2',
    Array.isArray(r) && r.length === 1 && r[0].quantity === 2);
  assert('missing items object + target 2 → create', Array.isArray(f(undefined, SEAT, 2, PLANS_SET)));
  // Stale seat item on a ROTATED-AWAY price id must be deleted, not orphaned
  // to bill forever (review finding: rotating STRIPE_PRICE_SEAT double-bills).
  const stray = { id: 'si_old', price: { id: 'price_seat_OLD' }, quantity: 2 };
  r = f(items(plan, stray, seat(1)), SEAT, 3, PLANS_SET);
  assert('stray seat item on old price id is deleted; current re-quantified',
    Array.isArray(r)
    && r.some((op) => op.id === 'si_old' && op.deleted === true)
    && r.some((op) => op.id === 'si_seat' && op.quantity === 3));
  r = f(items(plan, stray), SEAT, 0, PLANS_SET);
  assert('target 0 with only a stray old-price seat item → delete the stray',
    Array.isArray(r) && r.length === 1 && r[0].id === 'si_old' && r[0].deleted === true);
  // A plan item must NEVER be touched by seat reconciliation.
  r = f(items(plan, seat(2)), SEAT, 5, PLANS_SET);
  assert('plan line item never appears in the update payload',
    Array.isArray(r) && !r.some((op) => op.id === 'si_plan'));
}

console.log('\nPer-seat charging — gates + wiring');
{
  const st = read('functions/handlers/seats.js');
  assert('binds STRIPE_PRICE_SEAT + plan-price secrets (deploy merge-gate documented)',
    /secrets: \[STRIPE_SECRET_KEY, STRIPE_PRICE_SEAT,/.test(st)
    && /MERGE GATE/.test(st),
    'the seat secret must exist in Secret Manager before this ever merges to main');
  assert('dark gate: refuses unless the secret looks like a real price id',
    /seatPriceId\.startsWith\('price_'\)/.test(st)
    && /not available yet/.test(st));
  assert('refuses if the seat secret is accidentally a PLAN price id',
    /planPriceIds\.has\(seatPriceId\)/.test(st) && /misconfigured/.test(st),
    'a copy-paste of a plan price into STRIPE_PRICE_SEAT would re-quantity the plan line');
  assert('owner/admin gate + App Check + rate limit',
    // ownerOnly is load-bearing (2026-08-05): requireTeamAdmin now accepts
    // same-company company_admins by default; seat money stays the
    // bill-payer's call alone via this opt.
    /requireTeamAdmin\(request, null, \{ ownerOnly: true \}\)/.test(st)
    && /enforceAppCheck: true/.test(st)
    && /callableRateLimit\(request, 'setCompanySeatCount'/.test(st));
  assert('extraSeats requires an actual integer (no Number() 0-coercion of null/""/[])',
    /typeof raw !== 'number' \|\| !Number\.isInteger\(raw\)/.test(st),
    'Number(null|""|[]|false) === 0 would silently delete all seat billing');
  assert('requires a card-billed sub; past_due may only REDUCE',
    /stripeSubscriptionId \|\| !subData\.stripeCustomerId/.test(st)
    && /pastDueReduction = subData\.status === 'past_due' && extraSeats < storedSeats/.test(st));
  assert('reduction never strands occupied seats (createTeamInvite occupied filter)',
    /occupied > newCap/.test(st) && /isInviteExpired\(md\)/.test(st));
  assert('reduction reserves the lower cap BEFORE Stripe (write-skew race)',
    /isReduction = extraSeats < storedSeats/.test(st)
    && /if \(isReduction\) \{\s*await subRef\.set\(\{ purchasedSeats: extraSeats/.test(st),
    'a concurrent invite must read the reduced cap, not race the old one into an unpaid seat');
  assert('cross-checks the sub belongs to the stored Stripe customer',
    /subCustomer !== subData\.stripeCustomerId/.test(st));
  assert('prorations invoiced immediately AND must clear (no seats before money)',
    /proration_behavior: 'always_invoice'/.test(st)
    && /payment_behavior: 'error_if_incomplete'/.test(st),
    'default allow_incomplete grants seats then leaves the charge to dunning');
  assert('card decline → honest failed-precondition (no seats changed)',
    /e\.type === 'StripeCardError'/.test(st) && /no seats were changed/.test(st));
  assert('indeterminate failure copy promises idempotence, never "not charged"',
    /retrying will NOT charge you again/.test(st)
    && !/you were not charged differently/.test(st),
    'a timeout after Stripe applied the change must not assert the opposite');
  assert('no-op path still repairs a diverged mirror (self-healing, $0)',
    /if \(!itemsUpdate\) \{[\s\S]{0,400}subRef\.set\(\{ purchasedSeats: extraSeats/.test(st));
  const idx = read('functions/index.js');
  assert('setCompanySeatCount exported from functions/index.js',
    /exports\.setCompanySeatCount = seatHandlers\.setCompanySeatCount/.test(idx));
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  assert('team tab renders the buy-seats control + calls setCompanySeatCount',
    /_renderSeatBuy\(/.test(tab) && /_teamCallable\('setCompanySeatCount'/.test(tab));
  assert('buy-seats UI hidden for free/enterprise/non-entitled plans',
    /pl\.plan === 'free' \|\| reps === Infinity \|\| reps == null/.test(tab));
  assert('empty roster still renders the seat controls (Starter first-seat buy)',
    /if \(snap\.empty\) \{\s*list\.innerHTML = '';\s*try \{ _renderSeatPanel\(\[\], list\);[\s\S]{0,120}_renderSeatBuy\(list\)/.test(tab),
    'base cap 0 ⇒ empty roster ⇒ the buy panel must still show or Route 1b is dead for Starter');
  assert('confirm copy is trial-aware (no false "charged now" during a trial)',
    /isTrialing = !!pl && pl\.status === 'trialing'/.test(tab)
    && /no charge; seats are billed with your plan when the trial ends/.test(tab));
  assert('stepper hidden for non-card-billed comps (source must be checkout)',
    /cardBilled = !!pl && pl\.source === 'checkout'/.test(tab)
    && /!entitled \|\| !cardBilled/.test(tab),
    'an access-code comp would otherwise see a stepper whose Apply always errors');
  const bg = read('docs/pro/js/billing-gate.js');
  assert('billing-gate exposes sub source for the card-billed gate',
    /_source = typeof data\.source === 'string'/.test(bg) && /source: _source/.test(bg));
}

console.log('\nPer-seat charging — webhook event-ordering guard (out-of-order safety)');
{
  const st = read('functions/stripe.js');
  assert('subscription.updated skips events older than the applied high-water mark',
    /lastApplied = typeof stored\.lastSubEventAt === 'number'/.test(st)
    && /eventCreated < lastApplied/.test(st) && /stale_event_skipped/.test(st),
    'out-of-order seat updates would otherwise persist a stale purchasedSeats');
  assert('the high-water mark advances (and is preserved on malformed events)',
    /lastSubEventAt: eventCreated \|\| lastApplied \|\| FieldValue\.delete\(\)/.test(st));
  assert('checkout seeds the ordering watermark so a stale updated cannot clobber activation (non-rewinding — see below)',
    /subData\.lastSubEventAt = Math\.max\(priorLastEvent, thisEventCreated\) \|\| FieldValue\.delete\(\)/.test(st));
}

// ═══════════════════════════════════════════════════════════════════
// ROUTE 3 (2026-07-17): self-serve funnel — pay-before-onboarding
// reorder + safe polish (plan banner, token refresh, buy-first tenant).
// ═══════════════════════════════════════════════════════════════════

console.log('\nRoute 3 — funnel reorder + polish');
{
  const reg = read('docs/pro/js/pages/register.js');
  assert('ownerDest routes paid intent → pricing (checkout first), else onboarding',
    /function ownerDest\(\)[\s\S]{0,260}hasIntent \? '\/pro\/pricing\.html' : '\/pro\/onboarding\.html'/.test(reg),
    'paid intent must hit Stripe before the setup wizard');
  assert('both register branches route new owners via ownerDest (not hardcoded onboarding)',
    (reg.match(/ownerDest\(\)/g) || []).length >= 2,
    'email + Google new-owner paths must both use the reorder helper');
  assert('renderPlanBanner + PLAN_DISPLAY (team included) surface the selected plan',
    /function renderPlanBanner\(\)/.test(reg)
    && /PLAN_DISPLAY = \{[\s\S]{0,160}team:\s*\{ label: 'Team',\s*price: '\$149\/mo' \}/.test(reg)
    && /renderPlanBanner\(\)/.test(reg.split('function wireRegisterDom')[1] || ''),
    'a paid-CTA visitor must see their selected plan, wired in wireRegisterDom');
  const regHtml = read('docs/pro/register.html');
  assert('register.html has the (default-hidden) plan banner element',
    /id="regPlanBanner"[\s\S]{0,120}display:none/.test(regHtml));

  const ss = read('docs/pro/js/pages/stripe-success.js');
  assert('post-activation token refresh (fresh plan claim for rules/callables)',
    /await waitForSubscriptionActive\(billingKey\);[\s\S]{0,600}getIdToken\(true\)/.test(ss),
    'token.plan must be fresh this session, not stale ~1h after purchase');
  assert('un-onboarded payer routed to onboarding after activation (reorder)',
    /function wireDoneDestination/.test(ss)
    && /onboarded = !\(snap\.exists\(\) && snap\.data\(\)\.onboarded === false\)/.test(ss)
    && /setAttribute\('href', '\/pro\/onboarding\.html'\)/.test(ss),
    'a buyer who paid before the wizard still needs onboarding; returning subs go to dashboard');
  assert('buy-first path provisions a real tenant (createCompany) — closes the #945-class hole',
    /createCompanyFn = httpsCallable\(functions, 'createCompany'\)/.test(ss)
    && /await setDoc\(doc\(db, 'users'[\s\S]{0,900}createCompanyFn\(\{ name:/.test(ss),
    'a direct-to-checkout account must get a company/companyId, not a tenant-less paid doc');
  assert('stripe-success imports getDoc + getFunctions for the new reads/provisioning',
    /getFirestore, doc, getDoc, setDoc/.test(ss) && /getFunctions, httpsCallable/.test(ss));
  // Review finding (3 lenses): createCompany is enforceAppCheck:true; without
  // App Check init on stripe-success the buy-first provisioning call is
  // REJECTED in prod and the #945 hole stays open. Must set up App Check like
  // register.js does.
  assert('stripe-success initializes App Check so the createCompany call is not rejected in prod',
    /initializeAppCheck, ReCaptchaEnterpriseProvider/.test(ss)
    && /emulatorAppCheckIfLocal\(app\)/.test(ss)
    && /initializeAppCheck\(app, \{/.test(ss),
    'the buy-first createCompany would 401 on App Check without this — the fix would be dead code');
  const ssHtml = read('docs/pro/stripe-success.html');
  assert('stripe-success done button is addressable for onboarding routing',
    /id="doneContinueBtn"/.test(ssHtml));
  assert('stripe-success.html loads the App Check key config script',
    /dashboard-appcheck-config\.js/.test(ssHtml));

  assert('plan banner is suppressed for invitees (?invite=1)',
    /function renderPlanBanner[\s\S]{0,600}if \(inviteIntent\) \{ host\.style\.display = 'none'; return; \}/.test(reg),
    'an invitee is joining a team, not buying a plan — a stale intent must not show them a plan banner');

  const pp = read('docs/pro/js/pricing-page.module.js');
  assert('cancel-recovery: an un-onboarded owner who cancels checkout is routed to onboarding',
    /checkoutCancelled = new URLSearchParams/.test(pp)
    && /if \(checkoutCancelled\) \{[\s\S]{0,260}snap\.data\(\)\.onboarded === false[\s\S]{0,80}onboarding\.html/.test(pp),
    'the reorder must not leave an abandoned paid signup un-onboarded/un-branded (worse than pre-reorder)');
}

console.log('\nRoute 3 gap #4 — one-click in-dashboard upgrade');
{
  const bt = read('docs/pro/js/dashboard-billing-tab.js');
  assert('billing-tab renders a one-click checkout button + delegate → createCheckoutSession',
    /data-billing-action="checkout"/.test(bt)
    && /startBillingCheckout/.test(bt)
    && /createCheckoutSession/.test(bt),
    'a free/cancelled owner should reach Stripe in one click, not bounce to pricing.html');
  assert('DOUBLE-BILL GUARD: checkout offered only when there is NO live Stripe sub',
    /hasLiveSub = !!\(info\.status && LIVE_SUB_STATUS\[info\.status\]\)/.test(bt)
    && /PAID\[key\] && !hasLiveSub[\s\S]{0,120}data-billing-action="checkout"/.test(bt)
    && /PAID\[key\] && hasLiveSub[\s\S]{0,120}data-billing-action="managePortal"/.test(bt),
    'createCheckoutSession mints a NEW subscription — anyone who already has a Stripe sub must use the portal, never a fresh checkout');
  assert('DOUBLE-BILL GUARD covers dunning statuses (past_due/unpaid/incomplete), not just active/trialing',
    /LIVE_SUB_STATUS = \{ active: 1, trialing: 1, past_due: 1, unpaid: 1, incomplete: 1 \}/.test(bt),
    'a past_due/unpaid/incomplete tenant STILL has a live chargeable Stripe sub — offering them checkout double-bills + orphans the original');
  assert('checkout callable is plan-allowlisted + owner sees no per-card action',
    /plan !== 'starter' && plan !== 'team' && plan !== 'growth'\) return/.test(bt)
    && /isOwner = !!\(window\._userClaims && window\._userClaims\.owner === true\)/.test(bt),
    'guard the callable to real paid plans; owners are uncapped and never self-checkout');
  assert('checkout delegate is guarded against template re-hydration double-wiring',
    /_NBD_BILLING_CHECKOUT_DELEGATE/.test(bt));
}

console.log('\nRoute 3 gap #3 — signed-out Subscribe → register (not the login wall)');
{
  const pp = read('docs/pro/js/pricing-page.module.js');
  assert('signed-out subscribe routes to register.html?plan= (carrying a validated plan)',
    /window\.location\.href = '\/pro\/register\.html' \+ \(safePlan \? '\?plan=' \+ safePlan/.test(pp)
    && /safePlan = \(plan === 'starter' \|\| plan === 'team' \|\| plan === 'growth'\)/.test(pp),
    'a stranger on pricing has no account — sending them to the login wall is a conversion leak');
  assert('signed-out subscribe no longer dead-ends at login.html',
    !/window\.location\.href = '\/pro\/login\.html\?redirect=pricing/.test(pp),
    'the old login-wall redirect must be gone');
}

console.log('\nRoute 3 gap #6 — canonical free-tenant subscriptions doc');
{
  const prov = read('functions/handlers/provisioning.js');
  assert('createCompany seeds a free subscriptions doc (plan:free, status:none)',
    /db\.doc\(`subscriptions\/\$\{uid\}`\)\.create\(\{[\s\S]{0,120}plan: 'free',\s*status: 'none'/.test(prov),
    'status:none + plan:free reads identically to an absent doc everywhere');
  assert('free-doc seed is a NO-CLOBBER atomic create() (never downgrades a paid/comp doc)',
    /\.create\(\{/.test(prov)
    && /e\.code === 6 \|\| \/already exists\/i\.test/.test(prov),
    'a buy-first checkout or access-code grant can write a PAID doc first — create() must fail-safe, not overwrite');
  const st = read('functions/stripe.js');
  assert('portal folds customer-less free doc into the same 404 as an absent doc (no 400 regression)',
    /customerId = subscriptionSnap\.exists \? subscriptionSnap\.data\(\)\.stripeCustomerId : null/.test(st)
    && /if \(!customerId\) \{\s*res\.status\(404\)/.test(st),
    'seeding the free doc must not flip free users from 404→pricing to a 400 error toast');
  // Review CONFIRMED (3/3): the seeded plan:'free' doc made photo-vision fall
  // through its 'lite'-keyed cap map to the $50 default — DOUBLING the free-tier
  // AI-vision spend cap ($25→$50). All three vision cost-cap maps must key
  // 'free' explicitly so a seeded free doc caps identically to the old absent
  // default, not by coincidence.
  const pv = read('functions/photo-vision.js');
  assert('photo-vision cost cap keys free = $25 (no $50 doubling from the seeded doc)',
    /PER_USER_MONTHLY_USD_CAP_BY_PLAN = \{[\s\S]{0,400}free:\s*25\.00/.test(pv),
    'gap #6 seeds plan:free; without a free key it falls through to the $50 default and doubles the cap');
  const rv = read('functions/receipt-vision.js');
  assert('receipt-vision cost cap keys free = $25 explicitly',
    /PER_USER_MONTHLY_USD_CAP_BY_PLAN = \{[\s\S]{0,200}free:\s*25\.00/.test(rv));
  const vi = read('functions/integrations/voice-intelligence.js');
  assert('voice-intelligence budget keys free = 3600s explicitly',
    /VOICE_COMPANY_BUDGET_SEC = \{[\s\S]{0,200}free:\s*3600/.test(vi));
}

console.log('\nDeposit / partial-payment money correctness (money-out sweep)');
{
  const st = read('functions/stripe.js');
  assert('payment link charges the OUTSTANDING BALANCE, not the full face value',
    /balanceDueCents = expectedTotalCents - amountPaidCents/.test(st)
    && /balanceDueCents < MIN_CENTS[\s\S]{0,120}already paid in full/.test(st),
    'charging invoice.total after a deposit overcharges the homeowner by the deposit');
  assert('payment link is single-use (completed_sessions limit 1)',
    /restrictions: \{ completed_sessions: \{ limit: 1 \} \}/.test(st),
    'a reusable link can be paid repeatedly, each a fresh un-deduped payment_intent');
  assert('webhook credits ACTUAL amount_received cumulatively (never hard-sets to total)',
    /paymentIntent\.amount_received/.test(st)
    && /newPaid = Math\.round\(\(priorPaid \+ received\)/.test(st)
    && !/amountPaid: Number\(inv\.total\) \|\| 0/.test(st),
    'hard-setting amountPaid=inv.total erases a prior deposit and assumes full payment');
  assert('webhook flips paid/paidAt only when fully paid + stamps lastPaymentAt',
    /status: fullyPaid \? 'paid' : \(inv\.status/.test(st)
    && /lastPaymentAt: FieldValue\.serverTimestamp\(\)/.test(st));
  // Since 2026-10-03 (job spine) the payoff advance is no longer in the
  // webhook: the webhook flips the invoice to 'paid' only when fully paid
  // (asserted above), and the invoice trigger (money-paper.js ->
  // job-spine.js) turns THAT flip into paid_in_full. A deposit-sized
  // payment leaves status open -> no paid_in_full (behaviour, not regex).
  const _spineL = require(path.join(__dirname, '..', 'functions', 'job-spine-logic.js'));
  assert('kanban auto-advance gated on fullyPaid (a deposit must not advance to final_payment)',
    JSON.stringify(_spineL.invoiceEvents({ status: 'sent' }, { leadId: 'L', status: 'sent', amountPaid: 500, depositAmount: 0, depositPaid: true })) === '[]'
    && JSON.stringify(_spineL.invoiceEvents({ status: 'sent' }, { leadId: 'L', status: 'paid', amountPaid: 1000 })) === '["paid_in_full"]'
    && !/stage: 'final_payment'/.test(st));
  // 2026-07-18 post-sprint certification (pre-existing, not sprint-caused):
  // invoiceWebhook's auto-advance stamped stage:'final_payment' with NO
  // stageRole. functions/stage-roles.js's roleFor() prefers the PERSISTED
  // stageRole over deriving it from the stage key (#981's contract, so a
  // tenant's custom stages classify correctly) — so a custom-pipeline lead
  // kept its STALE pre-payoff role (e.g. 'active') after a Stripe payoff,
  // and review-request-nudge.js + referral-rewards.js both key off roleFor(),
  // silently skipping the review ask and the $100 referral payout on every
  // automated Stripe-payoff loop.
  // The advance now lives in job-spine-logic.js movePayload — it stamps
  // stageRole from stage-roles.js on every automatic move.
  const _mp = _spineL.movePayload({ stage: 'contract_signed', jobType: 'cash' },
    _spineL.planJobEvent({ stage: 'contract_signed', jobType: 'cash' }, 'paid_in_full'),
    { actor: 't', atIso: 'T', event: 'paid_in_full' }, { serverTimestamp: () => 'TS', arrayUnion: (x) => [x] }).payload;
  assert('invoiceWebhook stamps stageRole alongside the final_payment auto-advance',
    _mp.stage === 'final_payment' && _mp.stageRole === 'won',
    "an unstamped write leaves roleFor() returning the STALE persisted role (persisted wins over the key map), so a custom-pipeline tenant's Stripe-paid job never classifies as won");
  assert('stripe.js requires functions/stage-roles.js',
    /require\('\.\/stage-roles'\)/.test(read('functions/job-spine-logic.js')));
  const ip = read('docs/pro/js/invoice-pipeline.js');
  assert('markPaid stamps lastPaymentAt on every payment (incl. partials)',
    /lastPaymentAt:\s*paidAtNow/.test(ip) || /lastPaymentAt:\s*new Date\(\)/.test(ip));
  // Since 2026-09-28 (R14) the advance goes through stage-write.js's
  // commitStageChange, which stamps stageRole (plus stageStartedAt / history);
  // behaviour pinned in invoice-markpaid-stage.test.js.
  // Since 2026-10-03 markPaid writes no stage at all — the server's invoice
  // trigger does, through job-spine.js (which stamps stageRole, above).
  assert('markPaid stamps stageRole alongside the contract_signed full-payoff advance (client, window.stageRole)',
    !/commitStageChange\(invoice\.leadId/.test(ip)
      && /stageRole: window\.stageRole\(newStage\)/.test(read('docs/pro/js/stage-write.js')),
    'consequence-neutral today (contract_signed already derives to role active) but keeps this write conforming to the persisted-stageRole-wins invariant every other stage-change path upholds');
  const md = read('docs/pro/js/money-dashboard.js');
  assert('money dashboard attributes Collected per payment date (payments[] ledger + legacy lastPaymentAt lump)',
    /function paymentsOf\(inv\)/.test(md)
    && /paymentsOf\(inv\)\.forEach/.test(md)
    && /inv\.lastPaymentAt != null \? inv\.lastPaymentAt : inv\.paidAt/.test(md),
    'paidAt-only / lastPaymentAt-overwrite hid deposits or moved them to later periods');
  assert('markPaid + invoiceWebhook append payments[] ledger entries',
    /payments: priorPayments/.test(ip)
    && /payments: priorPayments/.test(st),
    'without payments[] multi-payment cash dating cannot split deposit vs balance months');
  const mdt = read('tests/money-dashboard.test.js');
  assert('money-dashboard test uses the REAL partial shape (no fabricated status:partial+paidAt)',
    !/status: 'partial', paidAt:/.test(mdt)
    && /status: 'sent', total: 1000, balanceDue: 400, amountPaid: 600, lastPaymentAt:/.test(mdt),
    'the old fixture false-greened the paidAt-gated Collected bug');
  // Review follow-ups: the link is minted at invoice-CREATION (amountPaid=0),
  // so the common overcharge is "deposit recorded AFTER the link exists". The
  // link must be regenerated to the new balance + the stale one deactivated,
  // and the webhook must recover the idempotency marker on a transient failure.
  assert('createStripePaymentLink deactivates a prior link before minting a new one',
    /priorLinkId = invoice\.stripeInvoiceId/.test(st)
    && /stripe\.paymentLinks\.update\(priorLinkId, \{ active: false \}\)/.test(st),
    'a regenerated link must kill the stale full-amount link or it overcharges/double-collects');
  assert('markPaid regenerates the payment link to the new balance on a partial payment',
    /invoice\.stripePaymentLink && newBalanceDue > 0[\s\S]{0,120}generateStripePaymentLink\(invoiceId\)/.test(ip),
    'the link minted at invoice creation is stale after a deposit — regenerate to (total − amountPaid)');
  assert('invoiceWebhook deletes the idempotency marker on failure so a retry re-processes',
    /invoiceWebhook error[\s\S]{0,1200}getFirestore\(\)\.doc\(`stripe_events\/\$\{event\.id\}`\)\.delete\(\)/.test(st),
    'a transient write failure after the marker was written would otherwise silently drop the captured payment');
  assert('invoiceWebhook credit is idempotent at the DATA level — txn keyed on paymentIntent.id (no double-credit)',
    /const creditResult = await db\.runTransaction/.test(st)
    && /applied\.includes\(paymentIntent\.id\)[\s\S]{0,80}already_applied/.test(st)
    && /paidIntentIds: FieldValue\.arrayUnion\(paymentIntent\.id\)/.test(st),
    'additive credit (prior+received) is NOT re-run-safe; without a PI-id ledger the marker-delete recovery double-credits a committed-but-unacked write');
}

console.log('\nSeat-cap enforcement — both member-add paths + no TOCTOU (billing sweep 2026-07-18)');
{
  const adm = read('functions/handlers/admin.js');
  // CRITICAL: createTeamMember was the parallel path with NO cap check.
  assert('createTeamMember enforces the plan seat cap (imports seatLimitForPlan from the single source)',
    /require\('\.\/invites'\)/.test(adm)
    && /seatLimitForPlan, isInviteExpired/.test(adm)
    && /const seatLimit = seatLimitForPlan\(plan\) \+ purchasedSeats/.test(adm),
    'without a cap check a Free/solo owner could mint unlimited active team seats for $0');
  assert('createTeamMember re-checks the cap INSIDE the member-write transaction (no TOCTOU) + rolls back a new member on failure',
    /runTransaction\(async \(tx\) =>[\s\S]{0,400}!reuses && occupied \+ 1 > seatLimit\) throw overCapError/.test(adm)
    && /if \(created\) \{[\s\S]{0,200}memberRef\.delete\(\)[\s\S]{0,200}deleteUser\(userRecord\.uid\)/.test(adm),
    'a non-atomic count-then-write lets concurrent adds overshoot; a rejected/failed new-user add must not leave an orphan account or claimless row');
  assert('createTeamMember skips the cap for a re-add of an existing seat-holder (matches createTeamInvite; no over-cap-downgrade false reject)',
    /if \(!reuses && occupied \+ 1 > seatLimit\) throw overCapError/.test(adm),
    'counting an already-active target as a new seat wrongly blocks a no-delta edit while a tenant is temporarily over cap');
  assert('createTeamMember exempts only platform admin / NBD founder from the cap',
    /if \(isGlobalAdmin \|\| isOwnerCaller\(request\.auth\.token\)\) \{\s*plan = 'enterprise'/.test(adm),
    'the enterprise (uncapped) bypass must be narrow — tenant owners are capped by their plan');
  const inv = read('functions/handlers/invites.js');
  // MAJOR: createTeamInvite cap check was a non-atomic read-check-write.
  assert('createTeamInvite re-checks the cap INSIDE the invite-write transaction (closes concurrent-overshoot TOCTOU)',
    /await db\.runTransaction\(async \(tx\) => \{\s*if \(!reusesSeat && seats !== Infinity\)[\s\S]{0,400}occ \+ 1 > seats\)/.test(inv),
    'the roster read + cap check + invite write must be atomic or N concurrent invites each read a stale count and overshoot');
  assert('createTeamInvite still writes via tx.set so teamInviteEmail onDocumentCreated fires (resend preserved)',
    /tx\.set\(memberRef, \{\s*email,\s*role,\s*status: 'invited'/.test(inv));
  assert('seat helpers are single-source (exported from invites.js, not re-copied in admin.js)',
    /exports\.seatLimitForPlan = seatLimitForPlan/.test(inv)
    && !/function seatLimitForPlan/.test(adm),
    'a duplicated plan→seat table drifts — admin.js must import the one createTeamInvite uses');
}

console.log('\nCRM custom-pipeline + kanban correctness (lead-lifecycle sweep)');
{
  const ls = read('docs/pro/js/lead-score.js');
  assert('lead-score engagement calls window.CustomerEngagementScore.computeTier (not the undefined window.computeTier)',
    /window\.CustomerEngagementScore/.test(ls) && /_ces\.computeTier\(lead/.test(ls)
    && !/typeof window\.computeTier !== 'function'/.test(ls),
    'window.computeTier was never assigned — the 0-30 engagement signal (largest weight) always returned 0');
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('loadLeads stamps _stageRole via TENANT-AWARE window.stageRole (not the built-in module import)',
    /l\._stageRole = \(window\.stageRole \|\| stageRole\)\(l\._stageKey\)/.test(boot),
    'the module-local built-in returns active for custom stages, clobbering won/lost roles on every refresh');
  const cp = read('docs/pro/js/crm-pipeline.js');
  // 2026-09-15: the transactional write + column-collapse NOOP guard moved
  // out of moveCard's own body and into stage-write.js's commitStageChange()
  // — the same guard, shared with customer.html's progressStage() so BOTH
  // stage-change paths get the race protection, not just the kanban. moveCard
  // itself still computes + passes isDrag (asserted below); the guard logic
  // that CONSUMES it now lives in the shared module.
  const sw = read('docs/pro/js/stage-write.js');
  assert('commitStageChange NOOPs a same-COLUMN re-drop using the stages ARRAY (window._stageKeys, not the view-key string)',
    /window\.resolveColumn\(cur\.stage, _keys\)/.test(sw)
    && /Array\.isArray\(_keys\) && _keys\.length/.test(sw)
    && /cur\.stage === newStage \|\| _curCol === newStage/.test(sw),
    'resolveColumn arg2 is the stages array; a view-key string makes .includes() a substring test → blocks legit moves');
  assert('per-column drop handler stopPropagation (no double moveCard via the board handler)',
    /const dropHandler = e => \{[\s\S]{0,400}e\.stopPropagation\(\)/.test(cp));
  // 2026-07-18 post-sprint certification: the column-collapse NOOP guard
  // above is correct ONLY for drag-and-drop (newStage = an ambiguous column
  // key). #985 made install_complete…final_payment render in the "Closed"
  // column in Simple/Service views, so an EXPLICIT distinct-stage action
  // (Close Job, stage picker, list view, bulk move) landing on a stage that
  // shares a column with the current one was being silently discarded as a
  // false NOOP. Fixed via an opts.isDrag flag, true ONLY at the 3 genuine
  // drag-drop call sites.
  assert('moveCard computes isDrag and passes it through to the shared commit',
    /const isDrag = !!\(opts && opts\.isDrag\)/.test(cp)
    && /commitStageChange\(id, newStage, oldStage, \{[\s\S]{0,80}isDrag,/.test(cp),
    'without isDrag reaching commitStageChange, an explicit Close-Job/stage-picker/list-view/bulk-move to a stage sharing a column with the current stage would silently no-op instead of actually changing stage');
  assert('commitStageChange only applies the column-collapse comparison when isDrag is true',
    /const isDrag = !!opts\.isDrag/.test(sw)
    && /const _curCol = \(isDrag && typeof window\.resolveColumn/.test(sw),
    'the column-collapse comparison must be gated on isDrag or an explicit distinct-stage move sharing a column with the current stage would silently no-op');
  // 2026-09-30 (multi-job stage 2a): each drop may also carry the dragged
  // card's jobId; isDrag:true must still be passed at BOTH drop sites.
  assert('both kanban drop handlers (new-system + legacy) pass isDrag:true',
    (cp.match(/moveCard\(draggedId,\s*\w+,\s*\{\s*isDrag:\s*true(,\s*jobId:\s*[\w.|\s]+)?\s*\}\)/g) || []).length === 2,
    'a drag call site missing isDrag:true would wrongly apply exact-match comparison and rewrite the real stage on a same-column re-drop');
  const dbm = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('global window.drop (board-level delegated drop) passes isDrag:true',
    /moveCard\(dragId, stageKey, \{ isDrag: true \}\)/.test(dbm));
  assert('the retry closure carries the original isDrag flag forward (not a bare re-call)',
    /moveCard\(id, newStage, \{ isDrag \}\)/.test(cp),
    'a retried drag must stay column-NOOP-safe and a retried explicit move must stay exact-match');
  // Explicit-stage call sites must NOT pass isDrag — verify the delegate,
  // list-view select, context-menu submenu, and Close-Job chip all default.
  // 2026-09-30 (multi-job stage 2a): these may pass a third argument that
  // carries ONLY the card's jobId — never isDrag.
  const onlyJobArg = '(,\\s*[\\w.]+\\s*\\?\\s*\\{\\s*jobId:\\s*[\\w.]+\\s*\\}\\s*:\\s*undefined)?\\)';
  assert('the move-card delegate (prev/next arrows) does not pass isDrag',
    new RegExp("'move-card':\\s*\\(el\\)\\s*=>\\s*typeof moveCard === 'function' && moveCard\\(el\\.dataset\\.id, el\\.dataset\\.targetStage" + onlyJobArg).test(cp)
    && !/'move-card':[^\n]*isDrag/.test(cp));
  const clv = read('docs/pro/js/crm-list-view.js');
  assert('list-view stage-select does not pass isDrag',
    new RegExp('window\\.moveCard\\(sel\\.dataset\\.id, sel\\.value' + onlyJobArg).test(clv)
    && !/window\.moveCard\(sel\.dataset\.id[^\n]*isDrag/.test(clv));
  const kcm = read('docs/pro/js/kanban-context-menu.js');
  assert('right-click "Move to stage…" submenu does not pass isDrag',
    new RegExp('window\\.moveCard\\(lead\\.id, opt\\.value' + onlyJobArg).test(kcm)
    && !/window\.moveCard\(lead\.id, opt\.value[^\n]*isDrag/.test(kcm));
  assert('CRM revenue buckets are ROLE-aware (custom won/lost stages count correctly)',
    /isLost = _lostKeys\.includes\(sk\) \|\| role === 'lost'/.test(cp)
    && /isClosed = \(window\.isJobStage && window\.isJobStage\(sk\)\) \|\| role === 'won' \|\| role === 'job'/.test(cp),
    'hardcoded key lists excluded custom won from closed revenue and let custom lost inflate pipeline (2026-09-15: _closedKeys folded into the canonical window.isJobStage classifier)');
  // 2026-10-03: the hand-copied 6-bucket map this used to pin is gone — every
  // stage now counts once via crm-stages.js dashboardTileFor (role first, so a
  // custom WON/LOST stage still lands in Won/Lost). Behaviour, incl. a fixture
  // of every stage key: tests/dashboard-stage-tiles-2026-10-03.test.js.
  assert('dashboard stage tiles count through the canonical role-aware dashboardTileFor',
    /const _stageCounts = _dashboardTileCounts\(all\);/.test(cp) && /window\.dashboardTileFor\(sk,/.test(cp) && !/_stageMap/.test(cp),
    'the old _stageMap counted signed contracts as Estimate Sent and never counted Inspected or insurance stages');
  const cl = read('docs/pro/js/crm-leads.js');
  assert('Edit-modal save syncs stageRole with the edited stage (no stale denormalized role)',
    /_editStageRole = _editStageVal[\s\S]{0,200}window\.stageRole\(/.test(cl)
    && /\(_editStageRole \? \{ stageRole: _editStageRole \} : \{\}\)/.test(cl),
    'the modal wrote stage without stageRole → server won/lost classification stayed stale (missed referral payouts)');
}

console.log('\nHomeowner surface — post-payment landing + render-safety sweep (2026-07-17)');
{
  // (1) Post-payment 404 fix: createStripePaymentLink redirects the paying
  // homeowner to /pro/invoice-success.html — that file was ABSENT in prod, so a
  // homeowner who paid an invoice via the Stripe link landed on a 404.
  assert('invoice-success.html exists (Stripe payment-link after_completion redirect target)',
    fs.existsSync(path.join(ROOT, 'docs/pro/invoice-success.html')),
    'createStripePaymentLink redirects to /pro/invoice-success.html — a missing file 404s the homeowner right after they pay');
  const st = read('functions/stripe.js');
  assert('createStripePaymentLink redirects to the invoice-success page',
    /invoice-success\.html\?invoiceId=/.test(st));

  // (2) IDOR-safety: the landing page must NOT fetch invoice data by the
  // client-supplied invoiceId — an unauthenticated read-by-id would leak another
  // customer's invoice. The URL param is display-only.
  const invJs = read('docs/pro/js/pages/invoice-success.js');
  assert('invoice-success.js fetches NOTHING (no client-trusted invoiceId lookup → no IDOR)',
    !/\bfetch\s*\(/.test(invJs) && !/httpsCallable|getFirestore|firestore|getDoc|collection\s*\(/.test(invJs),
    'the invoiceId in the URL must stay display-only; fetching invoice details by it would expose other customers invoices');
  assert('invoice-success.js echoes the reference via textContent + charset guard (no reflected XSS)',
    /\.textContent\s*=/.test(invJs) && /\[A-Za-z0-9_-\]\{1,64\}/.test(invJs) && !/\.innerHTML\s*=/.test(invJs),
    'the URL param is attacker-influenced; it must be charset-validated and set via textContent, never innerHTML');

  // (3) Render-safety sweep: every `window.nbdEsc || (fallback)` MUST escape. An
  // identity fallback (s => String(s)) is a stored-XSS sink if dom-safe.js ever
  // fails to define window.nbdEsc before a widget renders homeowner-authored data.
  const escFiles = [
    'docs/pro/js/customer-bootstrap.module.js',
    'docs/pro/js/dashboard-widgets.js',
    'docs/pro/js/dashboard-actions.js',
    'docs/pro/js/dashboard-ui.js',
    'docs/pro/js/dashboard-bootstrap.module.js',
  ];
  for (const f of escFiles) {
    const idFallbacks = read(f).split('\n')
      .filter((l) => /nbdEsc\s*\|\|\s*\(s\s*=>/.test(l) && !/\.replace\(/.test(l));
    assert(`no identity nbdEsc fallback in ${path.basename(f)} (every fallback HTML-escapes)`,
      idFallbacks.length === 0,
      'an escape-function fallback that returns the raw string is a stored-XSS sink when window.nbdEsc is absent');
  }
}

// ═══════════════════════════════════════════════════════════════════
// CHECKOUT DOUBLE-BILL GUARD (2026-07-18 post-sprint certification): the
// #977 guard is client-side in the billing tab only; the pricing-page
// plan-intent auto-resume reaches createCheckoutSession without it. The
// server chokepoint must refuse a fresh Checkout for any tenant holding a
// live Stripe sub, or the webhook merge-set orphans the first sub.
// ═══════════════════════════════════════════════════════════════════

console.log('\nCheckout — server-side live-sub guard (double-bill)');
{
  const st = read('functions/stripe.js');
  const cc = (st.match(/exports\.createCheckoutSession = onRequest\([\s\S]*?\n\);/) || [''])[0];
  assert('createCheckoutSession declares the LIVE_SUB_STATUS set (dunning included)',
    /LIVE_SUB_STATUS = \{ active: 1, trialing: 1, past_due: 1, unpaid: 1, incomplete: 1 \}/.test(cc),
    'past_due/unpaid/incomplete still hold a chargeable sub — a fresh Checkout double-bills');
  assert('guard reads subscriptions/{billingKey} and 409s BEFORE sessions.create',
    /'subscriptions\/' \+ billingKey[\s\S]{0,900}status\(409\)[\s\S]{0,200}already_subscribed[\s\S]{0,2500}sessions\.create/.test(cc),
    'the refusal must precede session creation or the orphaned-sub overwrite still happens');
  assert('guard requires BOTH a stripeSubscriptionId and a live status',
    /guardSub\.stripeSubscriptionId && LIVE_SUB_STATUS\[String\(guardSub\.status\)\]/.test(cc),
    "free-seed {status:'none'} docs and access-code comps have no Stripe sub id — buying is their legitimate path in and must stay open");
  const pp = read('docs/pro/js/pricing-page.module.js');
  assert('pricing page handles already_subscribed (portal message, no checkout retry)',
    /data\.error === 'already_subscribed'/.test(pp) && /dashboard\.html/.test(pp));
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK ORDERING HARDENING (2026-07-18, post-sprint cross-PR certification):
// #974's lastSubEventAt ordering protocol only covered subscription.updated.
// Two gaps: (1) subscription.deleted sat outside the protocol entirely — a
// late-retried stale .updated could resurrect a cancelled sub; (2)
// checkout.session.completed wrote its own event.created unconditionally,
// which could REWIND the watermark below an already-applied later .updated.
// ═══════════════════════════════════════════════════════════════════

console.log('\nWebhook — subscription.deleted joins the event-ordering protocol');
{
  const st = read('functions/stripe.js');
  const del = (st.match(/case 'customer\.subscription\.deleted': \{[\s\S]*?break;\r?\n {8}\}/) || [''])[0];
  assert('subscription.deleted found and non-trivial', del.length > 200);
  assert('deleted case skips events older than the applied high-water mark (same guard as updated)',
    /eventCreated < lastApplied/.test(del) && /stale_event_skipped/.test(del),
    'a stale .updated retry after cancellation would otherwise resurrect the cancelled plan/status/purchasedSeats');
  assert('deleted case ADVANCES lastSubEventAt (closes the ordering gap for subsequent stale retries)',
    /lastSubEventAt: eventCreated \|\| lastApplied \|\| FieldValue\.delete\(\)/.test(del),
    'without stamping the mark here, deletion sat outside the protocol entirely');
}

console.log('\nWebhook — checkout.session.completed cannot rewind the ordering watermark');
{
  const st = read('functions/stripe.js');
  const chk = (st.match(/case 'checkout\.session\.completed': \{[\s\S]*?\r?\n {8}\}(?=\r?\n\r?\n {8}case 'customer\.subscription\.updated')/) || [''])[0];
  assert('checkout case found and non-trivial', chk.length > 500);
  assert('checkout reads the PRIOR stored lastSubEventAt before writing',
    /priorSnap = await db\.doc\(`subscriptions\/\$\{uid\}`\)\.get\(\)/.test(chk)
    && /priorLastEvent = typeof priorSnap\.get\('lastSubEventAt'\) === 'number'/.test(chk));
  assert('checkout takes Math.max(prior, this event) — never writes backwards',
    /Math\.max\(priorLastEvent, thisEventCreated\)/.test(chk),
    'a retried checkout event delivered after a later subscription.updated must not rewind the watermark and reopen the stale-clobber race #974 closed');
}

// ═══════════════════════════════════════════════════════════════════
// SEAT PRICE ROTATION SAFETY (2026-07-18): buildSeatItemsUpdate identifies
// seat line items BY EXCLUSION (anything not a known plan price). If a plan
// price is rotated (STRIPE_PRICE_TEAM etc. repointed), an existing sub's
// plan item still carries the OLD id — invisible to the current
// planPriceIds set — and would be misclassified as a stray seat item and
// DELETED, silently converting the tenant to seat-only billing.
// ═══════════════════════════════════════════════════════════════════

console.log('\nPer-seat charging — rotated-plan-price guard (setCompanySeatCount)');
{
  const seats = read('functions/handlers/seats.js');
  assert('setCompanySeatCount requires a recognized CURRENT plan item before reconciling seats',
    /hasRecognizedPlanItem = items\.some\(\(it\) => it && it\.price && it\.price\.id && planPriceIds\.has\(it\.price\.id\)\)/.test(seats));
  assert('refuses (not act on ambiguous data) when no line item matches a current plan price',
    /if \(!hasRecognizedPlanItem\)[\s\S]{0,300}no_recognized_plan_item[\s\S]{0,200}could not be verified/.test(seats),
    'without this, a rotated plan price item gets misclassified as a stray seat item and deleted from the live subscription');
  assert('the guard runs BEFORE buildSeatItemsUpdate is called',
    seats.indexOf('hasRecognizedPlanItem') < seats.indexOf('buildSeatItemsUpdate(sub.items'));
}

console.log('\nPer-seat charging — buy-seats stepper reachable during past_due (reduction escape hatch)');
{
  const tab = read('docs/pro/js/dashboard-team-tab.js');
  assert('stepper treats past_due as entitled-to-render (server allows past_due REDUCTIONS)',
    /isPastDue = !!pl && pl\.status === 'past_due'/.test(tab)
    && /entitled = !!pl && \(pl\.status === 'active' \|\| pl\.status === 'trialing' \|\| isPastDue\)/.test(tab),
    "excluding past_due made setCompanySeatCount's pastDueReduction allowance unreachable — no UI ever showed the stepper to use it");
  assert('the "+" control is disabled (not the whole panel hidden) while past_due',
    /plusAttrs = isPastDue \? \('disabled/.test(tab),
    'past_due may only reduce seats server-side; a live "+" would let the owner submit an increase the server just rejects');
  assert('click handler honors the disabled "+"/"-" buttons (no client-side bypass of the past_due cap)',
    /if \(t\.disabled\) return;/.test(tab));
}

// ═══════════════════════════════════════════════════════════════════
// PROVISIONING RELIABILITY (first-run audit 2026-07-28, root cause):
// createCompany used to be single-shot + swallowed at SEVEN call sites
// (register ×6, stripe-success ×1); the wizard's own self-heal swallowed
// too and then wrote onboarded:true, and skip() never attempted it — a
// transient failure at signup left the account PERMANENTLY tenant-less
// (misrouted public leads, phantom-company team ops, no branding). Three
// layers now: bounded-retry helper, blocking wizard finish, marker-gated
// login-time self-heal on dashboard load.
// ═══════════════════════════════════════════════════════════════════

console.log('\nProvisioning reliability — retry + block + login heal');
{
  // (1) the shared retry helper — a static ES module, deliberately NOT a
  // window.X helper (the page-scoped-helper silent-failure class).
  assert('provisioning-retry.js exists',
    fs.existsSync(path.join(ROOT, 'docs/pro/js/provisioning-retry.js')),
    'the shared ensureProvisioned helper is the root-cause fix vehicle');
  const pr = read('docs/pro/js/provisioning-retry.js');
  assert('ensureProvisioned is an exported async fn taking (user, callThunk)',
    /export async function ensureProvisioned\(user, callThunk/.test(pr));
  assert('retry loop is BOUNDED (attempts-capped, no while(true))',
    /attempts = 3/.test(pr) && /attempt < attempts/.test(pr) && !/while\s*\(\s*true/.test(pr),
    'createCompany is rate-limited 5/hr — an unbounded loop burns the whole quota');
  assert('permanent codes are never retried (failed-precondition + resource-exhausted)',
    /'functions\/failed-precondition'/.test(pr)
    && /'functions\/resource-exhausted'/.test(pr)
    && /PERMANENT_CODES\.includes\(code\)\) break;/.test(pr),
    'invited-rep refusals are permanent; retrying the rate limit burns the quota the heals need');
  assert('success path refreshes the token and CLEARS the per-uid pending marker',
    /getIdToken\(true\)/.test(pr)
    && /localStorage\.removeItem\('nbd_provision_pending_' \+ user\.uid\)/.test(pr));
  assert('final failure SETS the per-uid pending marker (login-heal handoff) and returns false',
    /localStorage\.setItem\('nbd_provision_pending_' \+ user\.uid, '1'\)/.test(pr)
    && /return false;/.test(pr));

  // (2) register.js — all six call sites routed through the helper, statically
  // imported; zero remaining single-shot swallows.
  const reg = read('docs/pro/js/pages/register.js');
  assert('register.js statically imports ensureProvisioned (no window.X guard)',
    /import \{ ensureProvisioned \}\s+from "\.\.\/provisioning-retry\.js"/.test(reg));
  assert('all 6 register createCompany sites route through ensureProvisioned',
    (reg.match(/await ensureProvisioned\(/g) || []).length >= 6,
    'email free, code server-fallback, code success, Google code-fallback, Google code success, Google free');
  assert('no remaining single-shot createCompany swallow in register.js',
    !reg.includes("console.warn('createCompany failed (account still usable)"),
    'the swallow pattern is what made a transient signup failure permanent');

  // (3) onboarding wizard — finish() BLOCKS un-provisioned completion
  // (before the onboarded:true write), skip() attempts best-effort.
  const ob = read('docs/pro/js/pages/onboarding.js');
  assert('onboarding.js statically imports ensureProvisioned',
    /import \{ ensureProvisioned \}\s+from "\.\.\/provisioning-retry\.js"/.test(ob));
  assert('finish() blocks on failed provisioning: showErr + re-enable + return',
    /const ok = await ensureProvisioned\(state\.user[\s\S]{0,300}if \(!ok\) \{[\s\S]{0,300}showErr\('Could not finish setting up your workspace[\s\S]{0,200}return;/.test(ob),
    'swallow-then-onboarded:true made the tenant-less state permanent (wizard never reappears)');
  assert('the provisioning gate runs BEFORE the onboarded:true write (order-pinned)',
    ob.indexOf('const ok = await ensureProvisioned') !== -1
    && ob.indexOf('const ok = await ensureProvisioned') < ob.indexOf('onboarded: true'),
    'writing onboarded first would close the only guaranteed repair surface');
  assert('skip() attempts best-effort provisioning (never blocks the skip)',
    /async function skip\(\) \{[\s\S]{0,1000}await ensureProvisioned\(state\.user/.test(ob)
    && /async function skip\(\) \{[\s\S]{0,500}state\.claims\.owner !== true/.test(ob),
    'a skipper used to be marked onboarded with NO provisioning attempt at all');

  // (4) stripe-success buy-first path — a PAYING tenant gets the same retry
  // + marker handoff.
  const ss = read('docs/pro/js/pages/stripe-success.js');
  assert('stripe-success statically imports ensureProvisioned',
    /import \{ ensureProvisioned \} from '\.\.\/provisioning-retry\.js'/.test(ss));
  assert('buy-first provisioning routed through ensureProvisioned',
    /await ensureProvisioned\(cred\.user, \(\) => createCompanyFn\(\{ name:/.test(ss));

  // (5) dashboard-bootstrap login-time self-heal — marker-gated so invitee
  // flows (?invite=1 → claimInvite) are untouched.
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  assert('login heal gated on missing companyId AND non-owner AND the pending marker',
    /_provisionPendingKey = 'nbd_provision_pending_' \+ user\.uid/.test(boot)
    && /!window\._userClaims\.companyId && window\._userClaims\.owner !== true\s*\r?\n\s*&& localStorage\.getItem\(_provisionPendingKey\)/.test(boot),
    'without the marker gate the heal would auto-provision solo tenants for pending invitees');
  assert('heal success: token refresh → marker removal → reload (in that order); failure keeps the marker',
    /createCompany'\);[\s\S]{0,800}getIdToken\(true\);[\s\S]{0,300}localStorage\.removeItem\(_provisionPendingKey\);[\s\S]{0,100}window\.location\.reload\(\);/.test(boot),
    'reload only after SUCCESS + marker removal = no reload loop; kept marker = next load retries');
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
