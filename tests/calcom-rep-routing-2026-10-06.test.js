/**
 * tests/calcom-rep-routing-2026-10-06.test.js — review finding R5-8-1.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Since #1945 (2026-10-01) the Cal.com webhook matched the organizer's Auth
 * EMAIL first and used users/{uid}.calcomUsername only when that email
 * matched nobody. The email-first order is a security fix (any user can write
 * their own calcomUsername, so username-first let one tenant claim another's
 * bookings). But an email match WON EVEN WHEN that account belongs to no
 * company — so a tenant whose Cal.com organizer email is an old, company-less
 * login had every booking created as a lead/appointment in that dead account,
 * while the account that actually owns the company (and carries the username)
 * got nothing.
 *
 * The decision now lives in calcom-logic.resolveCalcomRep (pure), fed by the
 * handler's lookups. This suite EXECUTES it:
 *   - company-less email + unique company-owning username claimant → claimant
 *   - a username claimed twice (spoof) → nobody via the username
 *   - email account WITH a company always beats the username (security)
 *   - a claimant with no company never gets a booking through the username
 *   - an optional server-only routing doc (system/calcomRouting) wins first
 * and pins that calcom.js routes through it.
 *
 * Zero deps. Run: node tests/calcom-rep-routing-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'functions', 'integrations', 'calcom-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + JSON.stringify(detail) : '')); }
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at + anchor.length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

const resolve = typeof C.resolveCalcomRep === 'function' ? C.resolveCalcomRep : () => ({});
const companyOf = typeof C.accountCompanyId === 'function' ? C.accountCompanyId : () => undefined;
const pickCfg = typeof C.pickConfiguredCompanyId === 'function' ? C.pickConfiguredCompanyId : () => undefined;

console.log('\nexports');
ok('calcom-logic exports resolveCalcomRep, accountCompanyId, pickConfiguredCompanyId',
  typeof C.resolveCalcomRep === 'function' && typeof C.accountCompanyId === 'function' && typeof C.pickConfiguredCompanyId === 'function');

console.log('\naccountCompanyId — what makes an account a real CRM tenant account');
{
  ok('companyId custom claim counts', companyOf({ uid: 'u1', claims: { companyId: 'co1' } }) === 'co1');
  ok('server-set users/{uid}.companyId counts', companyOf({ uid: 'u1', claims: {}, userData: { companyId: 'co2' } }) === 'co2');
  ok('owning companies/{uid} (ownerId == uid) counts as company uid', companyOf({ uid: 'u1', companyData: { ownerId: 'u1' } }) === 'u1');
  ok('a companies/{uid} doc owned by someone else does not count', companyOf({ uid: 'u1', companyData: { ownerId: 'u9' } }) === null);
  ok('no claim, no users companyId, no company doc → null (legacy login)', companyOf({ uid: 'u1', claims: null, userData: { calcomUsername: 'x' }, companyData: null }) === null);
  ok('claim wins over users doc', companyOf({ uid: 'u1', claims: { companyId: 'coA' }, userData: { companyId: 'coB' } }) === 'coA');
  ok('non-string / empty companyId values are ignored', companyOf({ uid: 'u1', claims: { companyId: '' }, userData: { companyId: 7 } }) === null);
}

console.log('\nresolveCalcomRep — the finding (company-less email vs company-owning username)');
{
  const legacy = { uid: 'legacyUid', companyId: null };
  const owner = { uid: 'ownerUid', companyId: 'ownerUid' };
  const r = resolve({ emailAccount: legacy, usernameClaimants: [owner] });
  ok('company-less email + unique company-owning claimant → the claimant (company owner)',
    r.repUid === 'ownerUid' && r.repCompanyId === 'ownerUid', r);
  ok('…with a username reason', typeof r.reason === 'string' && /username/.test(r.reason), r.reason);
}

console.log('\nresolveCalcomRep — the security fix is NOT reverted');
{
  const victim = { uid: 'victimUid', companyId: 'victimCo' };
  const attacker = { uid: 'attackerUid', companyId: 'attackerCo' };
  const r1 = resolve({ emailAccount: null, usernameClaimants: [victim, attacker] });
  ok('username claimed by two accounts (spoof) and no email match → unassigned', !r1.repUid && r1.repCompanyId == null, r1);
  ok('…reason says ambiguous', /ambig/.test(String(r1.reason)), r1.reason);

  const r2 = resolve({ emailAccount: { uid: 'legacyUid', companyId: null }, usernameClaimants: [victim, attacker] });
  ok('spoofed duplicate username never routes to either claimant', r2.repUid !== 'attackerUid' && r2.repUid !== 'victimUid', r2);

  const r3 = resolve({ emailAccount: victim, usernameClaimants: [attacker] });
  ok('email account WITH a company beats a different company-owning username claimant', r3.repUid === 'victimUid' && r3.repCompanyId === 'victimCo', r3);
  ok('…and flags the conflict for a warn log', r3.conflict === true && /email/.test(String(r3.reason)), r3);

  const r4 = resolve({ emailAccount: victim, usernameClaimants: [] });
  ok('email with company, no username → email', r4.repUid === 'victimUid' && r4.repCompanyId === 'victimCo' && r4.reason === 'email', r4);

  const r5 = resolve({ emailAccount: victim, usernameClaimants: [victim] });
  ok('email and username are the same account → email, no conflict', r5.repUid === 'victimUid' && !r5.conflict, r5);

  const r6 = resolve({ emailAccount: null, usernameClaimants: [{ uid: 'squatter', companyId: null }] });
  ok('a unique claimant with NO company never gets a booking via the username', !r6.repUid, r6);

  const r7 = resolve({ emailAccount: null, usernameClaimants: [owner2()] });
  ok('no email match + unique company-owning claimant → claimant', r7.repUid === 'o2' && r7.repCompanyId === 'co2', r7);

  const r8 = resolve({ emailAccount: { uid: 'legacyUid', companyId: null }, usernameClaimants: [] });
  ok('company-less email with no competing claimant still lands (legacy solo fallback companyId = uid)',
    r8.repUid === 'legacyUid' && r8.repCompanyId === 'legacyUid', r8);

  const r9 = resolve({ emailAccount: null, usernameClaimants: [] });
  ok('nothing matches → unassigned', !r9.repUid && r9.reason === 'no_match', r9);

  const r10 = resolve({});
  ok('tolerates missing inputs', !r10.repUid);
}
function owner2() { return { uid: 'o2', companyId: 'co2' }; }

console.log('\nresolveCalcomRep — optional server-only routing config');
{
  const cfg = { uid: 'cfgOwner', companyId: 'cfgCo' };
  const r = resolve({ configured: cfg, emailAccount: { uid: 'e', companyId: 'eco' }, usernameClaimants: [{ uid: 'x', companyId: 'xco' }] });
  ok('a configured mapping wins first', r.repUid === 'cfgOwner' && r.repCompanyId === 'cfgCo' && r.reason === 'configured', r);
  const r2 = resolve({ configured: { uid: '', companyId: 'cfgCo' }, emailAccount: { uid: 'e', companyId: 'eco' } });
  ok('an incomplete configured mapping is ignored (falls through)', r2.repUid === 'e', r2);

  ok('pick by event slug', pickCfg({ byEventSlug: { 'roof-inspection': 'coSlug' }, byUsername: { jo: 'coUser' } }, { eventSlug: 'roof-inspection', organizerUsername: 'jo' }) === 'coSlug');
  ok('pick by organizer username (case-insensitive)', pickCfg({ byUsername: { jo: 'coUser' } }, { eventSlug: 'x', organizerUsername: 'Jo' }) === 'coUser');
  ok('absent config → null', pickCfg(null, { eventSlug: 'a', organizerUsername: 'b' }) === null && pickCfg({}, { organizerUsername: 'b' }) === null);
  ok('a non-id value (path separator) is rejected', pickCfg({ byUsername: { jo: 'companies/x' } }, { organizerUsername: 'jo' }) === null);
  ok('inherited keys are not lookups', pickCfg({ byUsername: {} }, { organizerUsername: 'constructor' }) === null);
}

console.log('\nWIRING — calcom.js routes through the resolver');
{
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'functions', 'integrations', 'calcom.js'), 'utf8'));
  const handler = bodyAfter(src, 'async (req, res) =>') || '';
  const callAt = handler.indexOf('CL.resolveCalcomRep(');
  const byEmail = handler.indexOf('getAuth().getUserByEmail(organizerEmail)');
  const byUser = handler.indexOf("where('calcomUsername', '==', organizerUsername)");
  ok('the handler calls CL.resolveCalcomRep', callAt > -1);
  ok('both lookups happen before the decision', byEmail > -1 && byUser > -1 && byEmail < callAt && byUser < callAt, { byEmail, byUser, callAt });
  ok('the username lookup still reads at most two claimants (ambiguity detection)', /where\('calcomUsername', '==', organizerUsername\)\.limit\(2\)\.get\(\)/.test(handler));
  ok('the email account no longer short-circuits the username lookup', !/if \(!repUid && organizerUsername\)/.test(handler));
  ok('company status comes from accountCompanyId', /CL\.accountCompanyId\(/.test(handler));
  ok('the optional routing doc is server-only system/ (clients denied by rules)', /db\.doc\('system\/calcomRouting'\)/.test(handler));
  const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
  ok('firestore.rules denies all client access to system/{docId}', /match \/system\/\{docId\} \{\s*allow read, write: if false;/.test(rules));
  ok('the chosen reason is logged', /reason:\s*route\.reason/.test(handler));
  ok('no hard-coded uid or email in the routing code', !/@nobigdeal|jonathandeal|@gmail\.com/i.test(handler));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
