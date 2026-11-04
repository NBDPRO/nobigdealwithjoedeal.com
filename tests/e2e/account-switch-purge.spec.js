/**
 * tests/e2e/account-switch-purge.spec.js — a shared-device account switch purges the previous account's
 * local data (2026-10-25, the browser repro the 10-23 pass-2 audit left open after #2695).
 *
 * The leak it guards: A signs in on a shared phone, A's leads / photos / texts land in localStorage and
 * IndexedDB, A signs out the PLAIN way (auth.signOut(), not NBDAuth.logout()), B signs in through the login
 * page. Before #2695 the dashboard's purge could be skipped silently when nbd-auth.js had not assigned
 * window.NBDAuth yet, nbd_last_uid was already recorded as B, and the second defence never fired: B read
 * A's cached data. Now the purge is awaited (bounded) and nbd_last_uid is recorded only after it ran, else
 * it fails closed. This spec drives exactly that path on the emulators with a second, admin-created tenant.
 *
 * @audit — runs in the Authed E2E (emulators) job.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, logout, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const B = { email: 'playwright-e2e-b@nbd.test', password: 'nbd-e2e-password-2' };

async function ensureTenantB() {
  const { initializeApp, getApps } = require('firebase-admin/app');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  const auth = require('firebase-admin/auth').getAuth();
  const { getFirestore, FieldValue } = require('firebase-admin/firestore');
  let user;
  try { user = await auth.getUserByEmail(B.email); }
  catch (_) { user = await auth.createUser({ email: B.email, password: B.password, emailVerified: true, displayName: 'Playwright B' }); }
  const uid = user.uid;
  await auth.setCustomUserClaims(uid, { companyId: uid, role: 'company_admin' });
  const db = getFirestore(), now = FieldValue.serverTimestamp(), batch = db.batch();
  batch.set(db.doc('users/' + uid), { firstName: 'Playwright', lastName: 'B', company: 'B Test Roofing', email: B.email, onboarded: true, onboardedAt: now, createdAt: now }, { merge: true });
  batch.set(db.doc('companies/' + uid), { name: 'B Test Roofing', ownerId: uid, status: 'active', plan: 'growth', source: 'e2e-spec', createdAt: now }, { merge: true });
  batch.set(db.doc('companyProfile/' + uid), { brand: { legalName: 'B Test Roofing', contact: { alertEmail: B.email } }, provisionedBy: 'account-switch-purge.spec', createdAt: now }, { merge: true });
  batch.set(db.doc('subscriptions/' + uid), { plan: 'growth', status: 'active', source: 'e2e-spec', createdAt: now, updatedAt: now }, { merge: true });
  await batch.commit();
  return uid;
}

test.describe.serial('Account switch purge @audit', () => {
  test('plain signOut, then B signs in through the login page: A\'s local data is gone and nbd_last_uid is B', async ({ page }) => {
    test.setTimeout(120_000);
    const credsA = requireTestUser();
    const uidB = await ensureTenantB();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());

    // ── A: a settled session with local data ──
    await loginAs(page, credsA);
    await safeWaitForFunction(page, () => Array.isArray(window._leads) && typeof window.goTo === 'function' && !!(window._user && window._user.uid), null, { timeout: 30_000 });
    const uidA = await safeEvaluate(page, () => window._user.uid);
    expect(uidA).not.toBe(uidB);
    await safeWaitForFunction(page, (uid) => localStorage.getItem('nbd_last_uid') === uid, uidA, { timeout: 15_000 });
    // Marker keys shaped like the app's own caches (the purge clears nbd_* / nbd-* / nav-* keys).
    await safeEvaluate(page, () => { localStorage.setItem('nbd_e2e_marker_from_a', 'A'); localStorage.setItem('nbd-e2e-marker2', 'A'); localStorage.setItem('nav-e2e-marker', 'A'); });

    // ── the plain sign-out: auth.signOut(), never NBDAuth.logout() ──
    await logout(page);
    await page.waitForTimeout(500);
    const afterSignOut = await safeEvaluate(page, () => ({ marker: localStorage.getItem('nbd_e2e_marker_from_a'), last: localStorage.getItem('nbd_last_uid') }));
    expect(afterSignOut.last).toBe(uidA); // signOut alone purges nothing: the leak the next login must close

    // ── B signs in through the login page on the same browser profile ──
    await loginAs(page, B);
    await safeWaitForFunction(page, () => Array.isArray(window._leads) && !!(window._user && window._user.uid), null, { timeout: 30_000 });
    expect(await safeEvaluate(page, () => window._user.uid)).toBe(uidB);
    // The purge is awaited (bounded, 5 s) and only then is nbd_last_uid recorded as B.
    await safeWaitForFunction(page, (uid) => localStorage.getItem('nbd_last_uid') === uid, uidB, { timeout: 20_000 });
    const afterB = await safeEvaluate(page, () => ({
      m1: localStorage.getItem('nbd_e2e_marker_from_a'), m2: localStorage.getItem('nbd-e2e-marker2'), m3: localStorage.getItem('nav-e2e-marker'),
      last: localStorage.getItem('nbd_last_uid'),
      leaks: Object.keys(localStorage).filter((k) => /^(nbd[_-]|nav-)/.test(k) && /marker/.test(k)),
    }));
    expect(afterB.last).toBe(uidB);
    expect(afterB.m1).toBeNull();
    expect(afterB.m2).toBeNull();
    expect(afterB.m3).toBeNull();
    expect(afterB.leaks).toEqual([]);
    // And A's lead book is not what B sees: every loaded lead belongs to B's company (none of A's seeded rows).
    const foreign = await safeEvaluate(page, (uid) => (window._leads || []).filter((l) => l && l.companyId && l.companyId !== uid).length, uidB);
    expect(foreign).toBe(0);
  });
});
