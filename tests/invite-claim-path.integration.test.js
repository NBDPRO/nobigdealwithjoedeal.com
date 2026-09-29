/**
 * tests/invite-claim-path.integration.test.js: claimInvite and onRepSignup
 * accept only a REAL team invite (2026-09-25, invite-claim path check).
 *
 * THE DEFECT
 * ──────────
 * Both handlers found an invite with collectionGroup('members'), which matches
 * a `members` collection under ANY parent, and took the tenant from
 * ref.parent.parent.id without checking that parent. firestore.rules let a
 * signed-in user write any subcollection under their own users/{uid}, so a
 * users/{uid}/members/{email} doc was accepted as a team invite for that
 * email: the tenant was the writer's uid and the role was whatever the doc
 * said, with none of createTeamInvite's checks (seat cap, role allowlist, who
 * may invite). The same doc also made a REAL invite for that email come back
 * as ambiguous_invite, so the real one could not be claimed.
 *
 * THE FIX (defence in depth)
 *   - functions/handlers/invite-lookup.js: one resolver for both handlers. A
 *     hit is an invite only at exactly companies/{companyId}/members/{email},
 *     with an issuable role and an existing company doc; everything else is
 *     dropped BEFORE the ambiguity check, and the lookup reads every page
 *     (up to a cap, past which it refuses), so dropped docs cannot crowd a
 *     real invite out or hide a second one (cases 10-11).
 *   - firestore.rules: users/{uid} subcollection WRITES are an allowlist
 *     (pinned by tests/firestore-rules.test.js section 35).
 * This file drives the REAL handlers in-process (claimInvite.run /
 * onRepSignup.run) against the Firestore + Auth emulators. Stray docs are
 * seeded with the admin SDK on purpose: the handler must hold even if one
 * exists (a leftover, or a path some future rule opens).
 *
 * RUN (CI, throwaway emulators):
 *   cd tests && firebase emulators:exec --only auth,firestore --project demo-nbd-invite \
 *     'node ./invite-claim-path.integration.test.js'
 * RUN (a shared local emulator on 127.0.0.1): give it its own project id:
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
 *   INVITE_TEST_PROJECT_ID=demo-invite-<n> node tests/invite-claim-path.integration.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.join(__dirname, '..');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('✗ FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must both be set (emulators only)');
  process.exit(1);
}
const PROJECT = process.env.INVITE_TEST_PROJECT_ID || process.env.GCLOUD_PROJECT || 'demo-nbd-invite';
{
  const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
  if (Object.values(rc.projects || {}).includes(PROJECT)) {
    console.error('✗ refusing to run against the app project "' + PROJECT + '"');
    process.exit(1);
  }
}
process.env.GCLOUD_PROJECT = PROJECT;
// onRepSignup no-ops when the emulator rig skip-lists it; this suite calls it.
delete process.env.NBD_DEPLOY_SKIP_LIST;

// The handlers resolve firebase-admin from functions/node_modules; initialise
// THAT copy so getFirestore()/getAuth() inside them see this app.
const freq = createRequire(path.join(ROOT, 'functions', 'package.json'));
freq('firebase-admin/app').initializeApp({ projectId: PROJECT });
const db = freq('firebase-admin/firestore').getFirestore();
const auth = freq('firebase-admin/auth').getAuth();
const { FieldValue } = freq('firebase-admin/firestore');

const { claimInvite } = require(path.join(ROOT, 'functions/handlers/invites.js'));
const { onRepSignup } = require(path.join(ROOT, 'functions/handlers/auth.js'));
const { findPendingInvite, INVITE_SCAN_LIMIT } = require(path.join(ROOT, 'functions/handlers/invite-lookup.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

const RUN = 'zzinv' + Date.now().toString(36);
const createdUids = [];
let seq = 0;

async function makeUser(tag, extraClaims) {
  seq++;
  const uid = `${RUN}-${tag}-${seq}`;
  const email = `${RUN}-${tag}-${seq}@invite.test`;
  await auth.createUser({ uid, email, emailVerified: true });
  if (extraClaims) await auth.setCustomUserClaims(uid, extraClaims);
  createdUids.push(uid);
  return { uid, email };
}
async function makeCompany(tag) {
  const owner = await makeUser(tag);
  await db.doc(`companies/${owner.uid}`).set({ ownerId: owner.uid, name: 'Co ' + tag, status: 'active', plan: 'growth' });
  return owner.uid;
}
function inviteDoc(email, role, invitedBy) {
  return { email, role, status: 'invited', invitedAt: FieldValue.serverTimestamp(), invitedBy: invitedBy || 'x' };
}
// Exactly the request shape the callable wrapper hands the handler.
async function claim(user, tokenExtra, data) {
  const token = Object.assign({ email: user.email, email_verified: true }, tokenExtra || {});
  try {
    return await claimInvite.run({ auth: { uid: user.uid, token }, data: data || {} });
  } catch (e) {
    return { threw: e.code || e.message };
  }
}
async function signup(user) {
  return onRepSignup.run({ data: { uid: user.uid, email: user.email } });
}
async function claimsOf(uid) { return (await auth.getUser(uid)).customClaims || {}; }
async function statusOf(p) { const s = await db.doc(p).get(); return s.exists ? s.data().status : null; }

async function run() {
  console.log('INVITE-CLAIM PATH CHECK — project ' + PROJECT + ', run ' + RUN);

  // ── 1. A members doc under users/{uid} is not an invite ─────────────────
  section('1. a users/{uid}/members doc is ignored');
  {
    // The writer is an ordinary self-serve account WITH its own
    // companies/{uid} doc (createCompany gives every signup one), so the
    // company-exists check cannot be what stops this; the path check must.
    const writer = { uid: await makeCompany('writer') };
    const victim = await makeUser('victim');
    const stray = `users/${writer.uid}/members/${victim.email}`;
    await db.doc(stray).set(inviteDoc(victim.email, 'company_admin', writer.uid));

    const out = await claim(victim);
    ok('claimInvite: users/{uid}/members doc → no_invite', out.claimed === false && out.reason === 'no_invite',
      JSON.stringify(out));
    const c = await claimsOf(victim.uid);
    ok('claimInvite: no companyId/role claim stamped from it', !c.companyId && !c.role, JSON.stringify(c));
    ok('claimInvite: the stray doc is not activated', (await statusOf(stray)) === 'invited');
    const prof = await db.doc(`users/${victim.uid}`).get();
    ok('claimInvite: no users/{victim} profile pointing at the writer', !prof.exists || prof.data().companyId !== writer.uid);

    // A solo owner (companyId claim == own uid) is allowed to claim a real
    // invite, so the guard must hold on that branch too.
    const solo = await makeUser('solo');
    await auth.setCustomUserClaims(solo.uid, { companyId: solo.uid });
    await db.doc(`users/${writer.uid}/members/${solo.email}`).set(inviteDoc(solo.email, 'manager', writer.uid));
    const outSolo = await claim(solo, { companyId: solo.uid });
    ok('claimInvite: solo owner (companyId == uid) → no_invite for a users/{uid}/members doc',
      outSolo.claimed === false && outSolo.reason === 'no_invite', JSON.stringify(outSolo));
    ok('claimInvite: solo owner keeps companyId == own uid', (await claimsOf(solo.uid)).companyId === solo.uid);

    // Every onRepSignup leg gets its OWN address and docs: a claim leg that
    // wrongly succeeds flips its doc to active, which would hide a signup
    // failure on the same doc.
    const victim2 = await makeUser('victim1b');
    await db.doc(`users/${writer.uid}/members/${victim2.email}`).set(inviteDoc(victim2.email, 'company_admin', writer.uid));
    const sOut = await signup(victim2);
    ok('onRepSignup: users/{uid}/members doc → no claims', !sOut || !sOut.customClaims, JSON.stringify(sOut));
  }

  // ── 2. A real invite still claims ────────────────────────────────────────
  section('2. a real companies/{id}/members invite still claims');
  {
    const co = await makeCompany('owner2');
    const rep = await makeUser('rep2');
    const real = `companies/${co}/members/${rep.email}`;
    await db.doc(real).set(inviteDoc(rep.email, 'manager', co));

    const out = await claim(rep);
    ok('claimInvite: claimed into the inviting company', out.claimed === true && out.companyId === co, JSON.stringify(out));
    ok('claimInvite: role from the invite', out.role === 'manager');
    ok('claimInvite: companyName from the company doc', out.companyName === 'Co owner2');
    const c = await claimsOf(rep.uid);
    ok('claimInvite: claims stamped { companyId, role }', c.companyId === co && c.role === 'manager', JSON.stringify(c));
    const m = (await db.doc(real).get()).data();
    ok('claimInvite: member doc activated with the rep uid', m.status === 'active' && m.uid === rep.uid);

    const rep2 = await makeUser('rep2b');
    await db.doc(`companies/${co}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'sales_rep', co));
    const sOut = await signup(rep2);
    ok('onRepSignup: real invite → { companyId, role } claims',
      sOut && sOut.customClaims && sOut.customClaims.companyId === co && sOut.customClaims.role === 'sales_rep',
      JSON.stringify(sOut));
  }

  // ── 3. A stray doc next to a real invite no longer blocks it ────────────
  section('3. a stray doc alongside a real invite: real one claims, no ambiguous_invite');
  {
    const co = await makeCompany('owner3');
    const writer = { uid: await makeCompany('writer3') }; // has its own company doc, as in 1
    const rep = await makeUser('rep3');
    const stray = `users/${writer.uid}/members/${rep.email}`;
    await db.doc(`companies/${co}/members/${rep.email}`).set(inviteDoc(rep.email, 'sales_rep', co));
    await db.doc(stray).set(inviteDoc(rep.email, 'company_admin', writer.uid));

    const out = await claim(rep);
    ok('claimInvite: not ambiguous_invite', out.reason !== 'ambiguous_invite', JSON.stringify(out));
    ok('claimInvite: claims the REAL company', out.claimed === true && out.companyId === co, JSON.stringify(out));
    ok('claimInvite: role from the real invite, not the stray doc', out.role === 'sales_rep');
    ok('claimInvite: the stray doc is left untouched', (await statusOf(stray)) === 'invited');

    const rep2 = await makeUser('rep3b');
    await db.doc(`companies/${co}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'viewer', co));
    await db.doc(`users/${writer.uid}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'company_admin', writer.uid));
    const sOut = await signup(rep2);
    ok('onRepSignup: stray doc + real invite → the real company and role',
      sOut && sOut.customClaims && sOut.customClaims.companyId === co && sOut.customClaims.role === 'viewer',
      JSON.stringify(sOut));
  }

  // ── 4. Stray docs that sort AHEAD of companies/ cannot crowd it out ──────
  // Results come back in full-path order; 'aaa…' sorts before 'companies'.
  // The old reads (claimInvite limit(2), onRepSignup limit(1)) only ever saw
  // the stray docs here.
  section('4. stray docs sorting ahead of the real invite do not use up the page');
  {
    const co = await makeCompany('owner4');
    const rep = await makeUser('rep4');
    await db.doc(`companies/${co}/members/${rep.email}`).set(inviteDoc(rep.email, 'manager', co));
    for (let i = 0; i < 5; i++) {
      await db.doc(`aaa_${RUN}/s${i}/members/${rep.email}`).set(inviteDoc(rep.email, 'company_admin', 'x'));
    }
    const out = await claim(rep);
    ok('claimInvite: 5 stray docs ahead of the real invite → still claims the real company',
      out.claimed === true && out.companyId === co, JSON.stringify(out));

    const rep2 = await makeUser('rep4b');
    await db.doc(`companies/${co}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'sales_rep', co));
    for (let i = 0; i < 5; i++) {
      await db.doc(`aaa_${RUN}/t${i}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'company_admin', 'x'));
    }
    const sOut = await signup(rep2);
    ok('onRepSignup: 5 stray docs ahead of the real invite → still the real company',
      sOut && sOut.customClaims && sOut.customClaims.companyId === co, JSON.stringify(sOut));
  }

  // ── 5. Two REAL invites are still ambiguous (control) ────────────────────
  section('5. two real invites from different companies stay ambiguous');
  {
    const coA = await makeCompany('owner5a');
    const coB = await makeCompany('owner5b');
    const rep = await makeUser('rep5');
    await db.doc(`companies/${coA}/members/${rep.email}`).set(inviteDoc(rep.email, 'sales_rep', coA));
    await db.doc(`companies/${coB}/members/${rep.email}`).set(inviteDoc(rep.email, 'sales_rep', coB));
    const out = await claim(rep);
    ok('claimInvite: two real companies → ambiguous_invite', out.claimed === false && out.reason === 'ambiguous_invite',
      JSON.stringify(out));
    ok('claimInvite: nothing stamped on ambiguity', !(await claimsOf(rep.uid)).companyId);
    const rep2 = await makeUser('rep5b');
    await db.doc(`companies/${coA}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'sales_rep', coA));
    await db.doc(`companies/${coB}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'sales_rep', coB));
    const sOut = await signup(rep2);
    ok('onRepSignup: two real companies → no claims (claimInvite reports it later)', !sOut || !sOut.customClaims,
      JSON.stringify(sOut));
  }

  // ── 6-9. Right collection name, wrong shape or content ────────────────────
  section('6-9. docs that are not something createTeamInvite could have written');
  {
    // 6. company doc missing
    const rep6 = await makeUser('rep6');
    const ghost = `${RUN}-nocompany`;
    await db.doc(`companies/${ghost}/members/${rep6.email}`).set(inviteDoc(rep6.email, 'sales_rep', ghost));
    const o6 = await claim(rep6);
    ok('6 claimInvite: invite under a companies/{id} with no company doc → no_invite',
      o6.claimed === false && o6.reason === 'no_invite', JSON.stringify(o6));
    const rep6b = await makeUser('rep6b');
    await db.doc(`companies/${ghost}/members/${rep6b.email}`).set(inviteDoc(rep6b.email, 'sales_rep', ghost));
    const s6 = await signup(rep6b);
    ok('6 onRepSignup: no company doc → no claims', !s6 || !s6.customClaims, JSON.stringify(s6));

    // 7. role createTeamInvite never issues
    const co7 = await makeCompany('owner7');
    const rep7 = await makeUser('rep7');
    await db.doc(`companies/${co7}/members/${rep7.email}`).set(inviteDoc(rep7.email, 'admin', co7));
    const o7 = await claim(rep7);
    ok('7 claimInvite: role outside the invite allowlist → no_invite',
      o7.claimed === false && o7.reason === 'no_invite', JSON.stringify(o7));
    ok('7 claimInvite: no claims stamped', !(await claimsOf(rep7.uid)).companyId);
    const rep7b = await makeUser('rep7b');
    await db.doc(`companies/${co7}/members/${rep7b.email}`).set(inviteDoc(rep7b.email, 'admin', co7));
    const s7 = await signup(rep7b);
    ok('7 onRepSignup: role outside the invite allowlist → no claims', !s7 || !s7.customClaims, JSON.stringify(s7));

    // 8. doc id is not the email it carries
    const co8 = await makeCompany('owner8');
    const rep8 = await makeUser('rep8');
    await db.doc(`companies/${co8}/members/someone-else-${RUN}@invite.test`).set(inviteDoc(rep8.email, 'sales_rep', co8));
    const o8 = await claim(rep8);
    ok('8 claimInvite: member doc id != its email → no_invite',
      o8.claimed === false && o8.reason === 'no_invite', JSON.stringify(o8));
    const rep8b = await makeUser('rep8b');
    await db.doc(`companies/${co8}/members/someone-else-b-${RUN}@invite.test`).set(inviteDoc(rep8b.email, 'sales_rep', co8));
    const s8 = await signup(rep8b);
    ok('8 onRepSignup: member doc id != its email → no claims', !s8 || !s8.customClaims, JSON.stringify(s8));

    // 9. a members collection nested deeper under a company. The middle id is
    //    itself a real company id, so reading the tenant off
    //    ref.parent.parent.id would land on an EXISTING company here; only the
    //    exact-shape path check refuses it.
    const co9 = await makeCompany('owner9');
    const rep9 = await makeUser('rep9');
    await db.doc(`companies/${co9}/teams/${co9}/members/${rep9.email}`).set(inviteDoc(rep9.email, 'sales_rep', co9));
    const o9 = await claim(rep9);
    ok('9 claimInvite: companies/{id}/teams/{t}/members doc → no_invite',
      o9.claimed === false && o9.reason === 'no_invite', JSON.stringify(o9));
    const rep9b = await makeUser('rep9b');
    await db.doc(`companies/${co9}/teams/${co9}/members/${rep9b.email}`).set(inviteDoc(rep9b.email, 'sales_rep', co9));
    const s9 = await signup(rep9b);
    ok('9 onRepSignup: nested members doc → no claims', !s9 || !s9.customClaims, JSON.stringify(s9));
  }

  // ── 10. More stray hits than one page (2026-09-25 review fixup) ──────────
  // The first version read ONE page of INVITE_SCAN_LIMIT hits. More stray
  // docs than that, sorting ahead of the real invite, left 'none'; stray docs
  // sorting between two real invites hid the second one, so the first was
  // claimed where the answer is ambiguous_invite. The lookup now reads every
  // page. Strays are admin-seeded (no client path can write one).
  section('10. more stray hits than one page: every page is read');
  {
    const over = INVITE_SCAN_LIMIT + 5;
    async function seedStrays(prefixFor, email) {
      const batch = db.batch();
      for (let i = 0; i < over; i++) batch.set(db.doc(`${prefixFor(i)}/members/${email}`), inviteDoc(email, 'company_admin', 'x'));
      await batch.commit();
    }

    // 10a. A full page of strays ahead of the only real invite.
    const co = await makeCompany('owner10');
    const rep = await makeUser('rep10');
    await seedStrays((i) => `aaa_${RUN}/p${i}`, rep.email);
    await db.doc(`companies/${co}/members/${rep.email}`).set(inviteDoc(rep.email, 'manager', co));
    const out = await claim(rep);
    ok('10a claimInvite: a full page of strays ahead → still claims the real company',
      out.claimed === true && out.companyId === co, JSON.stringify(out));
    const repS = await makeUser('rep10s');
    await seedStrays((i) => `aaa_${RUN}/q${i}`, repS.email);
    await db.doc(`companies/${co}/members/${repS.email}`).set(inviteDoc(repS.email, 'sales_rep', co));
    const sOut = await signup(repS);
    ok('10a onRepSignup: a full page of strays ahead → still the real company',
      sOut && sOut.customClaims && sOut.customClaims.companyId === co, JSON.stringify(sOut));

    // 10b. Two real invites with a full page of strays between them. Paths
    // order segment by segment, so companies/{A}/teams/... sits after
    // companies/{A}/members/... and before companies/{B}/... (A < B).
    const coA = await makeCompany('owner10a');
    const coB = await makeCompany('owner10b');
    ok('10b fixture: company A sorts before company B', coA < coB, coA + ' / ' + coB);
    const rep2 = await makeUser('rep10b');
    await db.doc(`companies/${coA}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'sales_rep', coA));
    await seedStrays((i) => `companies/${coA}/teams/t${i}`, rep2.email);
    await db.doc(`companies/${coB}/members/${rep2.email}`).set(inviteDoc(rep2.email, 'sales_rep', coB));
    const o2 = await claim(rep2);
    ok('10b claimInvite: second real invite past a full page → ambiguous_invite, not the first company',
      o2.claimed === false && o2.reason === 'ambiguous_invite', JSON.stringify(o2));
    ok('10b claimInvite: nothing stamped', !(await claimsOf(rep2.uid)).companyId);
    const rep2s = await makeUser('rep10bs');
    await db.doc(`companies/${coA}/members/${rep2s.email}`).set(inviteDoc(rep2s.email, 'sales_rep', coA));
    await seedStrays((i) => `companies/${coA}/teams/u${i}`, rep2s.email);
    await db.doc(`companies/${coB}/members/${rep2s.email}`).set(inviteDoc(rep2s.email, 'sales_rep', coB));
    const s2 = await signup(rep2s);
    ok('10b onRepSignup: second real invite past a full page → no claims', !s2 || !s2.customClaims, JSON.stringify(s2));
  }

  // ── 11. The page ceiling fails closed ─────────────────────────────────────
  // The read stops after maxPages pages. Past that it cannot know there is
  // no second invite, so it never answers 'found' (callers refuse, as for two
  // real invites). Small pages via the test-only options keep this quick.
  section('11. a scan that hits its page ceiling never answers found');
  {
    const opts = { pageSize: 5, maxPages: 2 };
    const co = await makeCompany('owner11');

    // Control: fewer hits than the ceiling, spread over two pages → found.
    const e1 = `${RUN}-lookup11a@invite.test`;
    for (let i = 0; i < 6; i++) await db.doc(`aaa_${RUN}/c${i}/members/${e1}`).set(inviteDoc(e1, 'company_admin', 'x'));
    await db.doc(`companies/${co}/members/${e1}`).set(inviteDoc(e1, 'sales_rep', co));
    const l1 = await findPendingInvite(db, e1, opts);
    ok('11 control: 7 hits over two 5-hit pages → found, not truncated',
      l1.status === 'found' && l1.companyId === co && l1.truncated === false,
      JSON.stringify({ s: l1.status, t: l1.truncated, n: l1.nonCanonical }));

    // Real invite first, then more strays than the ceiling can read.
    const e2 = `${RUN}-lookup11b@invite.test`;
    await db.doc(`companies/${co}/members/${e2}`).set(inviteDoc(e2, 'sales_rep', co));
    for (let i = 0; i < 12; i++) await db.doc(`companies/${co}/teams/c${i}/members/${e2}`).set(inviteDoc(e2, 'company_admin', 'x'));
    const l2 = await findPendingInvite(db, e2, opts);
    ok('11 real invite seen, ceiling hit → ambiguous (fails closed), truncated',
      l2.status === 'ambiguous' && l2.truncated === true, JSON.stringify({ s: l2.status, t: l2.truncated }));

    // Only strays inside the ceiling, real invite past it → still not 'none'.
    const e3 = `${RUN}-lookup11c@invite.test`;
    for (let i = 0; i < 12; i++) await db.doc(`aaa_${RUN}/d${i}/members/${e3}`).set(inviteDoc(e3, 'company_admin', 'x'));
    await db.doc(`companies/${co}/members/${e3}`).set(inviteDoc(e3, 'sales_rep', co));
    const l3 = await findPendingInvite(db, e3, opts);
    ok('11 real invite past the ceiling → ambiguous, not none',
      l3.status === 'ambiguous' && l3.truncated === true, JSON.stringify({ s: l3.status, t: l3.truncated }));
  }

  // ── 12. An owner of their own company must choose to join (2026-09-29) ──
  // The dashboard calls claimInvite at boot. It used to claim on the spot, so
  // any tenant's invite to an owner's email silently moved that owner into the
  // other team. Now the server previews unless { confirm: true }.
  section('12. explicit Join for anyone who owns a company');
  {
    const co = await makeCompany('owner12');
    const soloUid = await makeCompany('solo12');                  // owns companies/{uid}
    const solo = { uid: soloUid, email: (await auth.getUser(soloUid)).email };
    await auth.setCustomUserClaims(soloUid, { companyId: soloUid, role: 'company_admin' });
    const inv = `companies/${co}/members/${solo.email}`;
    await db.doc(inv).set(inviteDoc(solo.email, 'sales_rep', co));

    const preview = await claim(solo, { companyId: soloUid, role: 'company_admin' });
    ok('12 owner + real invite, no confirm → confirm_required with who/what, nothing claimed',
      preview.claimed === false && preview.reason === 'confirm_required' && preview.companyId === co
        && preview.companyName === 'Co owner12' && preview.role === 'sales_rep', JSON.stringify(preview));
    ok('12 ...claims untouched (still their own company, still company_admin)',
      (await claimsOf(soloUid)).companyId === soloUid && (await claimsOf(soloUid)).role === 'company_admin');
    ok('12 ...invite still pending', (await statusOf(inv)) === 'invited');
    ok('12 ...own company not superseded', !(await db.doc(`companies/${soloUid}`).get()).data().status || (await db.doc(`companies/${soloUid}`).get()).data().status === 'active');

    const truthy = await claim(solo, { companyId: soloUid, role: 'company_admin' }, { confirm: 'yes' });
    ok('12 confirm must be exactly true (a truthy string is still a preview)', truthy.reason === 'confirm_required', JSON.stringify(truthy));

    const joined = await claim(solo, { companyId: soloUid, role: 'company_admin' }, { confirm: true });
    ok('12 { confirm: true } → joins', joined.claimed === true && joined.companyId === co, JSON.stringify(joined));
    ok('12 ...claims now the team', (await claimsOf(soloUid)).companyId === co);
    ok('12 ...own company marked superseded (records kept)', (await db.doc(`companies/${soloUid}`).get()).data().status === 'superseded-by-invite');

    // No companyId claim yet but a companies/{uid} doc it owns (a legacy or
    // mid-provisioning owner) is still an owner — no silent claim.
    const co2 = await makeCompany('owner12b');
    const legacyUid = await makeCompany('legacy12');
    const legacy = { uid: legacyUid, email: (await auth.getUser(legacyUid)).email };
    await db.doc(`companies/${co2}/members/${legacy.email}`).set(inviteDoc(legacy.email, 'manager', co2));
    const lp = await claim(legacy);
    ok('12 owner with no companyId claim (owns companies/{uid}) → still confirm_required', lp.reason === 'confirm_required', JSON.stringify(lp));

    // Positive control: an account with no company of its own (signed up
    // through the invite link) still joins at once — section 2 covers the
    // full shape; this pins that the new gate did not catch it.
    const co3 = await makeCompany('owner12c');
    const invitee = await makeUser('invitee12');
    await db.doc(`companies/${co3}/members/${invitee.email}`).set(inviteDoc(invitee.email, 'sales_rep', co3));
    const direct = await claim(invitee);
    ok('12 invite-link signup (no company of its own) → joins without a prompt', direct.claimed === true && direct.companyId === co3, JSON.stringify(direct));
  }
}

run()
  .catch((e) => { failed++; fails.push('uncaught: ' + (e && e.stack || e)); console.error(e); })
  .finally(async () => {
    // Best-effort tidy of this run's Auth users; Firestore rows live under a
    // dedicated project id and unique RUN-prefixed ids.
    try { if (createdUids.length) await auth.deleteUsers(createdUids); } catch (_) { /* ignore */ }
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed) {
      console.log('FAILED:\n  ' + fails.join('\n  '));
      process.exit(1);
    }
    process.exit(0);
  });
