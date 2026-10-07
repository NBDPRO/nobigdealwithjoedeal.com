/**
 * scripts/count-anonymous-auth-users.js — READ-ONLY.
 *
 * R3-7 (review round 3, 2026-10-06). The Anonymous auth provider was enabled
 * in prod and no page used it. It was turned off in the Firebase console on
 * 2026-10-06, and firestore.rules / storage.rules / functions now refuse an
 * anonymous token. An account created before that still exists and can keep
 * refreshing its ID token, so this script counts them and shows what each one
 * left behind. Deleting them is Jo's call; this script never writes.
 *
 * An account is counted as anonymous when it has no email, no phone number
 * and no linked provider. Every account the app creates (signup, Google,
 * validateAccessCode, createTeamMember, the E2E user) has an email, so a
 * custom-token login is never miscounted.
 *
 * For each one it also reads (get / count only):
 *   - companies/{uid}             : a squatted company doc
 *   - leads where userId == uid   : leads it wrote
 *   - its custom claims           : e.g. company_admin from createCompany
 *
 * RUN (ADC credential; see memory admin-script-runner-windows):
 *   node scripts/count-anonymous-auth-users.js
 *   NBD_PROJECT=<project> node scripts/count-anonymous-auth-users.js
 */
'use strict';

const { initAdmin, getAuth, getFirestore } = require('./_admin');

const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

function isAnonymous(u) {
  return !u.email && !u.phoneNumber && (!u.providerData || u.providerData.length === 0);
}

async function main() {
  initAdmin({ projectId: PROJECT });
  const auth = getAuth();
  const db = getFirestore();

  let total = 0;
  const anon = [];
  let pageToken;
  do {
    const page = await auth.listUsers(1000, pageToken);
    for (const u of page.users) {
      total++;
      if (isAnonymous(u)) anon.push(u);
    }
    pageToken = page.pageToken;
  } while (pageToken);

  console.log(`project ${PROJECT}: ${total} auth users, ${anon.length} anonymous`);
  for (const u of anon) {
    const company = await db.doc(`companies/${u.uid}`).get();
    const leads = await db.collection('leads').where('userId', '==', u.uid).count().get();
    const claims = Object.keys(u.customClaims || {});
    console.log([
      '  ' + u.uid,
      'created ' + (u.metadata.creationTime || '?'),
      'last sign-in ' + (u.metadata.lastSignInTime || 'never'),
      'last refresh ' + (u.metadata.lastRefreshTime || 'never'),
      u.disabled ? 'DISABLED' : 'enabled',
      'claims [' + claims.join(',') + ']',
      'companies doc ' + (company.exists ? 'YES' : 'no'),
      'leads ' + leads.data().count,
    ].join(' | '));
  }
  if (anon.length) {
    console.log('\nRead-only: nothing was changed. Deleting or disabling these accounts is Jo\'s call.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
