// @ts-check
// ─────────────────────────────────────────────────────────────────────
// GAUNTLET LIFECYCLE @gauntlet — the e2e-debt specs (follow-up to Batch 3).
//
// Four multi-tenant guarantees that had only unit / source-regex coverage:
//   1. persona     — per-rep AI persona resolution precedence + the non-NBD
//                    synthesis that keeps "Joe"/NBD out of a stranger's SMS.
//   2. lapse       — a cancelled tenant's seats pause reversibly; the OWNER is
//                    never paused; re-subscribe restores exactly the lapse seats.
//   3. access-code — redeeming a code lands the paid plan + provisions a tenant.
//   4. multi-rep   — a sales_rep sees only their own leads; a manager sees all;
//                    the seat cap refuses over-plan invites.
//
// Kept in a SEPARATE file + tag from @stranger so the newly-required stranger
// gate stays stable. persona + lapse are pure Node/admin (require the functions
// modules directly — the onSchedule cron + Stripe webhooks aren't emulable);
// access-code + multi-rep drive the browser through the App-Check-shimmed SDK.
//
// Requires the FUNCTIONS emulator (NBD_EMU_FUNCTIONS=1) — createTeamInvite /
// validateAccessCode are enforceAppCheck:true callables.
// ─────────────────────────────────────────────────────────────────────

const path = require('path');
const { test, expect } = require('@playwright/test');
const { loginAs } = require('./fixtures/auth');
const { installLocalSdkShim } = require('./fixtures/local-sdk');

const EMULATOR_MODE = /localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')
  && !!process.env.FIRESTORE_EMULATOR_HOST
  && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;

// Lazy firebase-admin handle against the emulators (same pattern as stranger.spec.js).
let _admin = null;
function admin() {
  if (_admin) return _admin;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getAuth } = require('firebase-admin/auth');
  const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _admin = { auth: getAuth(), db: getFirestore(), FieldValue, Timestamp };
  return _admin;
}

/**
 * firebase-admin handle resolved from the FUNCTIONS package's node_modules, so
 * it is the SAME module instance the required functions modules use. Required
 * when a test passes a `db` into a functions module that WRITES with
 * FieldValue.serverTimestamp(): a `db` + FieldValue from two different
 * firebase-admin copies (tests/ vs functions/, distinct in CI and via the local
 * junction) can't serialize each other's ServerTimestampTransform. Reads are
 * cross-instance-safe (they return plain field values), so read-only calls like
 * resolvePersona can use admin(); only the lapse writes need this.
 */
let _fnAdmin = null;
function fnAdmin() {
  if (_fnAdmin) return _fnAdmin;
  const fdir = path.join(__dirname, '..', '..', 'functions');
  const appMod = require(require.resolve('firebase-admin/app', { paths: [fdir] }));
  const authMod = require(require.resolve('firebase-admin/auth', { paths: [fdir] }));
  const fsMod = require(require.resolve('firebase-admin/firestore', { paths: [fdir] }));
  if (!appMod.getApps().length) appMod.initializeApp({ projectId: 'nobigdeal-pro' });
  _fnAdmin = { auth: authMod.getAuth(), db: fsMod.getFirestore(), FieldValue: fsMod.FieldValue, Timestamp: fsMod.Timestamp };
  return _fnAdmin;
}

/** Poll an async predicate until truthy or timeout. Returns the value. */
async function eventually(fn, { timeout = 30_000, interval = 1_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`eventually: ${label} not met within ${timeout}ms`);
}

/** In-page callable through the app's own (emulator-connected, App-Check-shimmed) SDK. */
async function callFromPageOnce(page, fnName, payload) {
  return page.evaluate(async ({ name, data }) => {
    const m = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
    const emu = await import('/pro/js/nbd-emulator-connect.js');
    const fns = m.getFunctions();
    await emu.connectEmulatorsIfLocal({ functions: fns });
    try {
      const r = await m.httpsCallable(fns, name)(data || {});
      return { ok: true, data: r && r.data };
    } catch (e) {
      return { ok: false, code: (e && e.code) || '', message: (e && e.message) || String(e) };
    }
  }, { name: fnName, data: payload || {} });
}

/** callFromPageOnce + retry of the emulator transient signatures (see stranger.spec.js). */
async function callFromPage(page, fnName, payload) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 20_000 });
      last = await callFromPageOnce(page, fnName, payload);
    } catch (e) {
      if (!/No Firebase App|app\/no-app|Execution context was destroyed|navigation/i.test(String(e))) throw e;
      last = { ok: false, code: 'transient/navigation', message: String(e) };
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    const internal = (!last.ok && /(^|\/)internal$/.test(last.code || '')) ||
      (!last.ok && String(last.message).trim().toLowerCase() === 'internal');
    if (!internal) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last;
}

/**
 * Read a lead doc from an in-page (signed-in) client, retrying the emulator's
 * "client is offline" flake on non-permission errors so a dropped read never
 * masquerades as a rules verdict. Mirrors stranger.spec.js probeRead.
 */
async function probeRead(page, leadId) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 20_000 });
      last = await page.evaluate(async (id) => {
        const fs = await import('/assets/vendor/firebase/10.12.2/firebase-firestore.js');
        try {
          const snap = await fs.getDoc(fs.doc(window.db || window._db, 'leads', id));
          return { denied: false, exists: snap.exists() };
        } catch (e) {
          const err = String((e && (e.code || e.message)) || e);
          return { denied: /permission|insufficient/i.test(err), err };
        }
      }, leadId);
    } catch (e) {
      if (!/Execution context was destroyed|navigation|No Firebase App|app\/no-app/i.test(String(e))) throw e;
      last = { denied: false, err: 'transient/navigation' };
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }
    if (last.denied || last.exists !== undefined) return last;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return last;
}

const stamp = Date.now();

test.describe.serial('Gauntlet lifecycle — persona / lapse / access-code / multi-rep @gauntlet', () => {
  test.beforeEach(async ({ context }, testInfo) => {
    if (!EMULATOR_MODE) {
      testInfo.skip(true, 'gauntlet lifecycle runs in emulator mode only (functions+auth+firestore emulators required)');
    }
    testInfo.setTimeout(240_000);
    await installLocalSdkShim(context); // sandbox-only; no-op in CI
  });

  // ── 1. PERSONA — pure Node/admin (no browser) ──────────────────────
  test('persona: per-rep resolution precedence + non-NBD synthesis (no Joe/NBD leak)', async () => {
    const { db } = admin();
    const A = require(path.join(__dirname, '..', '..', 'functions', 'handlers', 'ai-texting.js'));
    const P = require(path.join(__dirname, '..', '..', 'functions', 'handlers', 'ai-persona.js'));
    expect(typeof A.resolvePersona, 'resolvePersona exported').toBe('function');
    expect(typeof P.buildPersonaPrompt, 'buildPersonaPrompt exported').toBe('function');

    const coAcme = `e2e-gaunt-persona-acme-${stamp}`;   // non-NBD, has a company default persona
    const coBravo = `e2e-gaunt-persona-bravo-${stamp}`;  // non-NBD, NO company persona → synthesis path
    const coNbd = `e2e-gaunt-persona-nbd-${stamp}`;      // NBD legalName → null (locked prompt)
    await db.doc(`companyProfile/${coAcme}`).set({
      brand: { legalName: 'Acme Roofing E2E' },
      aiTexting: { defaultPersona: { enabled: true, identityName: 'Acme Bot', presetId: 'polished-pro' } },
    });
    await db.doc(`companyProfile/${coBravo}`).set({ brand: { legalName: 'Bravo Builders E2E' } });
    await db.doc(`companyProfile/${coNbd}`).set({ brand: { legalName: 'No Big Deal Home Solutions' } });

    const repWithPersona = `e2e-gaunt-persona-rep1-${stamp}`;
    await db.doc(`users/${repWithPersona}/settings/aiPersona`).set({
      enabled: true, identityName: 'Maria', presetId: 'friendly-neighbor',
    });

    // (1) user aiPersona WINS over the company default persona.
    const p1 = await A.resolvePersona(db, repWithPersona, coAcme, 'Ignored Name');
    expect(p1, 'user persona resolves').toBeTruthy();
    expect(p1.identityName, 'user identityName wins over company default').toBe('Maria');
    const prompt1 = P.buildPersonaPrompt(p1);
    expect(prompt1).toContain('Maria');
    expect(prompt1, 'prompt keeps the locked guardrails').toMatch(/HARD RULES — NEVER VIOLATE/);

    // (2) no user persona → company default persona is used, companyName gap-filled.
    const p2 = await A.resolvePersona(db, `e2e-gaunt-persona-owner-${stamp}`, coAcme, 'Owner Name');
    expect(p2, 'company default persona resolves').toBeTruthy();
    expect(p2.identityName, 'company default identityName').toBe('Acme Bot');
    expect(p2.companyName, 'companyName gap-filled from brand.legalName').toBe('Acme Roofing E2E');

    // (3) non-NBD tenant, no persona ANYWHERE → SYNTHESIZED branded config (Batch-3 fix:
    //     names the tenant + rep, never Joe / No Big Deal).
    const p3 = await A.resolvePersona(db, `e2e-gaunt-persona-rep3-${stamp}`, coBravo, 'Dana Rep');
    expect(p3, 'non-NBD no-persona synthesizes a config (not null)').toBeTruthy();
    expect(p3.companyName).toBe('Bravo Builders E2E');
    expect(p3.identityName).toBe('Dana Rep');
    const lc3 = P.buildPersonaPrompt(p3).toLowerCase();
    for (const bleed of ['joe deal', 'no big deal', 'cincinnati']) {
      expect(lc3, `synthesized prompt carries no NBD bleed ("${bleed}")`).not.toContain(bleed);
    }

    // (3b) non-NBD, no persona, EMPTY repName → identityName falls back to legalName,
    //      NEVER 'Joe' (the exact adversarial-review fix from Batch 3).
    const p3b = await A.resolvePersona(db, `e2e-gaunt-persona-rep3b-${stamp}`, coBravo, '');
    expect(p3b.identityName, 'empty repName → legalName, not Joe').toBe('Bravo Builders E2E');
    expect(P.buildPersonaPrompt(p3b), 'no Joe leak with empty repName').not.toContain('Joe');

    // (3c) CONFIGURED persona that omits identityName, non-NBD, empty repName →
    //      gap-filled to legalName (also the review fix), not 'Joe'.
    const repPartial = `e2e-gaunt-persona-rep3c-${stamp}`;
    await db.doc(`users/${repPartial}/settings/aiPersona`).set({ enabled: true, presetId: 'straight-shooter' });
    const p3c = await A.resolvePersona(db, repPartial, coBravo, '');
    expect(p3c.identityName, 'configured-but-unnamed persona → legalName, not Joe').toBe('Bravo Builders E2E');

    // (4) NBD tenant, no persona → null → caller uses the locked PERSONA_PROMPT (byte-identical).
    const p4 = await A.resolvePersona(db, `e2e-gaunt-persona-nbdrep-${stamp}`, coNbd, 'Whoever');
    expect(p4, 'NBD + no persona → null (locked PERSONA_PROMPT)').toBeNull();
  });

  // ── 2. LAPSE — pure Node/admin (no browser) ────────────────────────
  test('lapse: cancelled tenant pauses seats reversibly; owner untouched', async () => {
    // Use the FUNCTIONS' firebase-admin instance — enforceLapseForCompany writes
    // FieldValue.serverTimestamp() from that copy, so the db we hand it must be
    // from the same copy or the transform won't serialize (fails in CI too).
    const { db, auth, FieldValue, Timestamp } = fnAdmin();
    const { _test } = require(path.join(__dirname, '..', '..', 'functions', 'lapse-enforcement.js'));
    const { enforceLapseForCompany, reactivateLapsedSeats, LAPSE_GRACE_DAYS } = _test;
    expect(LAPSE_GRACE_DAYS, 'grace window is 14 days').toBe(14);

    const ownerUid = `e2e-gaunt-lapse-owner-${stamp}`;
    const repUid = `e2e-gaunt-lapse-rep-${stamp}`;
    const repEmail = `e2e-gaunt-lapse-rep-${stamp}@nbd.test`;
    await auth.createUser({ uid: ownerUid, email: `owner-lapse-${stamp}@nbd.test`, password: 'nbd-e2e-x' }).catch(() => {});
    await auth.createUser({ uid: repUid, email: repEmail, password: 'nbd-e2e-x' }).catch(() => {});
    // A claimed, active seat.
    await db.doc(`companies/${ownerUid}/members/${repEmail}`).set({
      email: repEmail, role: 'sales_rep', uid: repUid, status: 'active', active: true,
      invitedAt: FieldValue.serverTimestamp(),
    });
    // Cancelled + past-grace subscription (owner-keyed) — the customer.subscription.deleted shape.
    await db.doc(`subscriptions/${ownerUid}`).set({
      plan: 'free', status: 'cancelled',
      cancelledAt: Timestamp.fromDate(new Date(Date.now() - 15 * 24 * 3600 * 1000)),
      lapseEnforced: false, updatedAt: FieldValue.serverTimestamp(),
    });

    // Enforce directly (the onSchedule cron can't be time-triggered in the emulator).
    const subDoc = await db.doc(`subscriptions/${ownerUid}`).get();
    const paused = await enforceLapseForCompany(db, subDoc);
    expect(paused, 'one seat paused').toBe(1);
    expect((await auth.getUser(repUid)).disabled, 'rep Auth account disabled').toBe(true);
    const m = (await db.doc(`companies/${ownerUid}/members/${repEmail}`).get()).data();
    expect(m.status, 'member deactivated').toBe('deactivated');
    expect(m.deactivatedReason, 'reason recorded as lapse').toBe('lapse');
    expect((await auth.getUser(ownerUid)).disabled, 'OWNER is never paused').toBe(false);
    expect((await db.doc(`subscriptions/${ownerUid}`).get()).data().lapseEnforced, 'sub marked enforced').toBe(true);

    // Re-subscribe → the lapse-paused seat is restored.
    const restored = await reactivateLapsedSeats(db, ownerUid);
    expect(restored, 'one seat restored').toBe(1);
    expect((await auth.getUser(repUid)).disabled, 'rep re-enabled').toBe(false);
    const m2 = (await db.doc(`companies/${ownerUid}/members/${repEmail}`).get()).data();
    expect(m2.status, 'member active again').toBe('active');
    expect(m2.deactivatedReason == null, 'lapse reason cleared').toBe(true);

    // Negative: a member deactivated for a NON-lapse reason is NOT reactivated.
    const otherUid = `e2e-gaunt-lapse-other-${stamp}`;
    const otherEmail = `e2e-gaunt-lapse-other-${stamp}@nbd.test`;
    await auth.createUser({ uid: otherUid, email: otherEmail, password: 'nbd-e2e-x' }).catch(() => {});
    await auth.updateUser(otherUid, { disabled: true });
    await db.doc(`companies/${ownerUid}/members/${otherEmail}`).set({
      email: otherEmail, role: 'sales_rep', uid: otherUid, status: 'deactivated', active: false,
      deactivatedReason: 'owner-removed',
    });
    await reactivateLapsedSeats(db, ownerUid);
    expect((await auth.getUser(otherUid)).disabled, 'non-lapse deactivation is NOT reactivated').toBe(true);
  });

  // ── 3. ACCESS-CODE — browser (register UI + validateAccessCode) ────
  test('access-code: redeeming a paid code lands the plan + provisions the tenant', async ({ page }) => {
    const { db, auth } = admin();
    // Doc id must be the already-NORMALIZED code (uppercase, [A-Z0-9-]).
    const code = `E2E-GAUNT-${String(stamp).slice(-8)}`;
    const codeEmail = `e2e-gaunt-code-${stamp}@nbd.test`;
    const codePw = 'nbd-e2e-code-pw-1';
    await db.doc(`access_codes/${code}`).set({
      active: true, email: codeEmail, role: 'manager', plan: 'growth', maxUses: 1, useCount: 0,
    });

    // Register through the real UI WITH the access code (regEmail == code.email).
    await page.goto('/pro/register.html');
    await page.waitForLoadState('load');
    await page.fill('#regFirst', '[E2E] Code');
    await page.fill('#regLast', String(stamp));
    await page.fill('#regEmail', codeEmail);
    await page.fill('#regPass', codePw);
    await page.fill('#regConfirm', codePw);
    await page.fill('#regCode', code);
    await page.check('#regTerms'); // clickwrap (2026-10-03)
    await page.click('#regBtn');
    try {
      await page.waitForURL(/\/pro\/onboarding(\.html)?([?#]|$)/, { timeout: 30_000 });
    } catch (e) {
      const regErr = await page.locator('#regErr').textContent().catch(() => '');
      throw new Error('access-code register never reached onboarding'
        + (regErr ? ` — #regErr: "${regErr.trim()}"` : ' — #regErr empty'));
    }

    // Server truth: the paid plan landed via access_code, the code was consumed,
    // and the tenant was provisioned (createCompany ran after redemption).
    const uid = (await auth.getUserByEmail(codeEmail)).uid;
    const sub = await eventually(async () => {
      const s = (await db.doc(`subscriptions/${uid}`).get()).data();
      return s && s.source === 'access_code' ? s : null;
    }, { label: 'access_code subscription', timeout: 30_000 });
    expect(sub.plan, 'growth-tier code → growth plan').toBe('growth');
    expect(sub.status).toBe('active');
    expect(sub.accessCode).toBe(code);
    const codeDoc = (await db.doc(`access_codes/${code}`).get()).data();
    expect(codeDoc.useCount, 'code use consumed exactly once').toBe(1);
    const co = await eventually(async () => {
      const c = (await db.doc(`companies/${uid}`).get()).data();
      return c || null;
    }, { label: 'companies/{uid} provisioned', timeout: 30_000 });
    expect(co.ownerId, 'tenant owned by the redeemer').toBe(uid);
  });

  // ── 4. MULTI-REP — browser (own-only visibility) + seat cap ────────
  test('multi-rep: sales_rep sees only own leads; manager sees all; seat cap refuses over-plan', async ({ page, browser }) => {
    const { db, auth, FieldValue } = admin();
    const ownerUid = `e2e-gaunt-mr-owner-${stamp}`;
    const ownerEmail = `owner-mr-${stamp}@nbd.test`;
    const mgrUid = `e2e-gaunt-mr-mgr-${stamp}`;
    const mgrEmail = `e2e-gaunt-mr-mgr-${stamp}@nbd.test`;
    const repUid = `e2e-gaunt-mr-rep-${stamp}`;
    const repEmail = `e2e-gaunt-mr-rep-${stamp}@nbd.test`;
    const pw = 'nbd-e2e-mr-pw-1';

    // Owner (company_admin) + a manager + a sales_rep, all in ONE company, growth plan.
    async function seedUser(uid, email, role) {
      await auth.createUser({ uid, email, password: pw, emailVerified: true }).catch(() => {});
      await auth.setCustomUserClaims(uid, { companyId: ownerUid, role });
      // onboarded:true so a dashboard load doesn't bounce to the wizard mid-test.
      await db.doc(`users/${uid}`).set({ email, role, companyId: ownerUid, onboarded: true }, { merge: true });
    }
    await seedUser(ownerUid, ownerEmail, 'company_admin');
    await seedUser(mgrUid, mgrEmail, 'manager');
    await seedUser(repUid, repEmail, 'sales_rep');
    await db.doc(`companies/${ownerUid}`).set({ ownerId: ownerUid, status: 'active', plan: 'growth', name: `[E2E] MultiRep ${stamp}` });
    await db.doc(`companyProfile/${ownerUid}`).set({ brand: { legalName: `[E2E] MultiRep ${stamp}` } });
    await db.doc(`subscriptions/${ownerUid}`).set({ plan: 'growth', status: 'active', source: 'e2e-gaunt' });
    await db.doc(`companies/${ownerUid}/members/${mgrEmail}`).set({ email: mgrEmail, role: 'manager', uid: mgrUid, status: 'active', active: true });
    await db.doc(`companies/${ownerUid}/members/${repEmail}`).set({ email: repEmail, role: 'sales_rep', uid: repUid, status: 'active', active: true });

    // A lead owned by the MANAGER — a peer of the sales_rep, same company.
    const peerLeadId = `e2e-gaunt-mr-peerlead-${stamp}`;
    await db.doc(`leads/${peerLeadId}`).set({
      firstName: '[E2E] Peer', lastName: `MR${stamp}`, userId: mgrUid, companyId: ownerUid,
      stage: 'new', e2eTestData: true, createdAt: FieldValue.serverTimestamp(),
    });

    // sales_rep is DENIED reading a peer's lead (own-only — firestore.rules excludes
    // sales_rep from the company-reader clause).
    await loginAs(page, { email: repEmail, password: pw });
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 20_000 });
    const repProbe = await probeRead(page, peerLeadId);
    expect(repProbe.denied, `sales_rep blocked from a peer's lead (err: ${repProbe.err || 'none'})`).toBe(true);

    // manager CAN read it (company reader).
    const mgrCtx = await browser.newContext();
    await installLocalSdkShim(mgrCtx);
    const mgrPage = await mgrCtx.newPage();
    try {
      await loginAs(mgrPage, { email: mgrEmail, password: pw });
      await mgrPage.waitForFunction(() => window._user && window._user.uid, null, { timeout: 20_000 });
      const mgrProbe = await probeRead(mgrPage, peerLeadId);
      expect(mgrProbe.denied, `manager can read a peer lead (err: ${mgrProbe.err || 'none'})`).toBe(false);
      expect(mgrProbe.exists, 'manager actually read the peer lead').toBe(true);
    } finally {
      await mgrCtx.close();
    }

    // Seat cap: fill the growth plan (5 seats) with active members, then the owner's
    // 6th invite is refused with resource-exhausted.
    for (let i = 0; i < 5; i++) {
      const e = `e2e-gaunt-mr-seat${i}-${stamp}@nbd.test`;
      await db.doc(`companies/${ownerUid}/members/${e}`).set({
        email: e, role: 'sales_rep', uid: `e2e-gaunt-mr-seatuid${i}-${stamp}`, status: 'active', active: true,
      });
    }
    const ownerCtx = await browser.newContext();
    await installLocalSdkShim(ownerCtx);
    const ownerPage = await ownerCtx.newPage();
    try {
      await loginAs(ownerPage, { email: ownerEmail, password: pw });
      await ownerPage.waitForFunction(() => window._user && window._user.uid, null, { timeout: 20_000 });
      const over = await callFromPage(ownerPage, 'createTeamInvite', { email: `e2e-gaunt-mr-6th-${stamp}@nbd.test`, role: 'sales_rep' });
      expect(over.ok, 'over-cap invite refused').toBe(false);
      expect(over.message, `refusal names the seat cap (got: ${over.message || ''})`).toMatch(/taken|seat|team plan/i);
    } finally {
      await ownerCtx.close();
    }
  });
});
