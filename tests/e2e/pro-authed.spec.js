// @ts-check
// Authenticated /pro/ surface tests. Path A (BIG_ROCKS Rock 3):
// a dedicated test user logs in to the live site so we catch
// regressions in the actual post-auth shell — kanban load,
// auth-state plumbing, plan-tier gating, etc.
//
// Provisioning + secret setup: tests/e2e/README.md
//
// Without PLAYWRIGHT_TEST_USER_EMAIL + PLAYWRIGHT_TEST_USER_PASSWORD
// set, every test in this file skips (no failure, no pass) so
// running the suite locally without secrets stays clean.

const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, callCallableInPage, cleanupE2EData, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

// Canonical customerId shape — mirrors functions/customer-id.js formatCustomerId():
//   • NBD platform tenant → un-salted legacy 'NBD-####' (never changed).
//   • any other tenant    → per-tenant '<PREFIX>-####-<SALT>': PREFIX is 2–4
//     upper-alnum chars (prefix-reservation.js validateSeal); SALT is 4 base36-
//     UPPER chars (custIdSalt — [0-9A-Z], NOT hex, e.g. 'OAK-0002-K3P9'). The
//     seeded E2E tenant ('E2E Test Roofing', no reserved docPrefix) derives
//     prefix 'ETR' → mints 'ETR-0001-<salt>'. Assert BOTH shapes from ONE place:
//     hard-coding /^NBD-\d{4,}$/ in two spots flaked seed-dependently once
//     tenants got per-tenant prefixes (and the two copies drifted).
const CUSTOMER_ID_RE = /^(NBD-\d{4,}|[A-Z0-9]{2,4}-\d{4,}-[0-9A-Z]{4})$/;

/**
 * Navigate to the CRM/Pipeline view. Post-login the dashboard shows
 * view-home; the kanban view is template-stamped on first goTo('crm').
 * Click the sidebar nav item (#nav-crm) like a real user, falling back
 * to the global goTo() when the sidebar is hidden (narrow viewports).
 */
async function openCrmView(page) {
  // Wait for the nav plumbing itself (dashboard-ui.js defines window.goTo)
  // rather than clicking #nav-crm — the click delegate binds asynchronously
  // and a fast retry can click before it listens, silently going nowhere.
  // Retry through context teardowns: login lands via a 301 hop
  // (dashboard.html → cleanUrls → dashboard), and a wait that latched onto
  // the provisional document dies with "Execution context was destroyed".
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForLoadState('load');
      await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 15_000 });
      await page.evaluate(() => window.goTo('crm'));
      return;
    } catch (e) {
      if (!/Execution context was destroyed|navigation|not a function/i.test(String(e))) throw e;
    }
  }
  throw new Error('openCrmView: dashboard never settled with a working goTo()');
}

test.describe('Authenticated /pro/ shell — read-only @shard1', () => {
  let creds;
  test.beforeAll(() => {
    try { creds = requireTestUser(); }
    catch (e) {
      // Surface a single notice, not an error per spec, so the CI
      // logs make it obvious why the authed suite skipped.
      // eslint-disable-next-line no-console
      console.warn('[pro-authed] ' + e.message);
    }
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('login redirects to dashboard and kanban container renders', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    await loginAs(page, creds);

    // Post-redirect URL is dashboard.html; the auth gate (nbd-auth.js)
    // would bounce us back to /pro/login if auth state didn't stick.
    expect(page.url()).toMatch(/\/pro\/dashboard(\.html)?([?#]|$)/); // cleanUrls strips .html

    // Post-login the dashboard lands on view-home (re-audited 2026-07-04:
    // boot only auto-opens CRM for ?edit=/?tasks= deep links). The kanban
    // exists after navigating to the Pipeline view, which stamps
    // <template id="tpl-view-crm"> into #view-crm; crm.js binds
    // #kanbanBoard (dashboard.html:2398). Navigate like a user: the
    // sidebar nav item.
    await openCrmView(page);
    const kanban = page.locator('#kanbanBoard, #view-crm .kanban-board').first();
    await expect(kanban).toBeVisible({ timeout: 15_000 });

    // Sanity: no hard runtime errors during the dashboard's first paint.
    // Allow CSP Report-Only + Service Worker registration warnings — those
    // are expected on first visit and don't break the app. Emulator mode
    // additionally runs without the functions emulator, so callable fetches
    // to 127.0.0.1:5001 log connection-refused errors that aren't app bugs.
    const emulatorMode = /127\.0\.0\.1|localhost/.test(process.env.PLAYWRIGHT_BASE_URL || '');
    const hard = consoleErrors.filter(e =>
      !/Report Only|favicon|Service Worker registration|chrome-extension/i.test(e)
      && !(emulatorMode && /127\.0\.0\.1:5001|ERR_CONNECTION_REFUSED|Failed to load resource|app-?check|ReCAPTCHA|cloudfunctions\.net|CORS policy/i.test(e))
    );
    expect(hard, 'unexpected console errors during dashboard load').toEqual([]);
  });

  test('auth state persists across page reload (no kick to login)', async ({ page }) => {
    // The auth-restore race that kicked iOS users to /login was the
    // motivating bug for PRs #34 and #37. This test locks in that fix:
    // after a reload the user must stay on dashboard.html, not bounce.
    await loginAs(page, creds);
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    // Give the 2.5-second nbd-auth.js grace window from PR #37 enough
    // headroom to settle; if we're going to bounce we'd see /login by now.
    await page.waitForTimeout(3_500);
    expect(page.url(), 'auth-restore must keep us on dashboard, not /login').toMatch(/\/pro\/dashboard(\.html)?([?#]|$)/);
  });
});

// ───────────────────────────────────────────────────────────────
// Signup funnel — the acquisition path itself (register → onboarding
// → dashboard as a FREE user). Every other journey starts from the
// pre-seeded logged-in account; nothing guarded registration until
// the 2026-07-05 free-tier bug: dashboard-auth-gate required plan
// 'foundation', so every free signup hit a full-screen upgrade wall
// with no continue-free path — the funnel sold a product nobody
// could reach. This journey locks the whole path end-to-end.
//
// Hermetic: the account is created fresh in the AUTH EMULATOR each
// run (unique email per attempt) and evaporates with it. Since the
// Stranger Test (2026-07-06) the rig boots the FUNCTIONS emulator
// too, so createCompany now genuinely provisions the tenant here —
// the skip path stays covered because this journey uses the
// onboarding SKIP link (the full-wizard path is stranger.spec.js's).
// ───────────────────────────────────────────────────────────────
// Destructive flows (Rock 3 PR 4)
//
// Every test in this block creates real Firestore docs tagged with
// `e2eTestData: true` so the afterAll hook can call the
// cleanupE2ETestData callable to delete them. All seeded names use
// an `[E2E]` prefix so even if cleanup misses one, it's visually
// obvious in the kanban and easy to delete by hand.
//
// These tests run sequentially (not parallel) because they share
// the test user account and would race on document writes otherwise.
// ───────────────────────────────────────────────────────────────
test.describe.serial('Authenticated destructive flows @shard1', () => {
  let creds;
  test.beforeAll(() => {
    try { creds = requireTestUser(); }
    catch (e) { console.warn('[pro-authed-destructive] ' + e.message); }
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test.afterAll(async ({ browser }) => {
    if (!creds) return;
    // Emulator mode (test:e2e:authed:emu): all state lives in the Firestore
    // emulator and evaporates when emulators:exec exits, and the functions
    // emulator (which would host the cleanup callable) isn't running. Skip.
    if (/localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')) return;
    // Spin up a fresh page so afterAll has its own auth context
    // independent of any test that may have navigated mid-flight.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginAs(page, creds);
      const result = await cleanupE2EData(page);
      // eslint-disable-next-line no-console
      console.log('[pro-authed-cleanup]', JSON.stringify(result));
    } finally {
      await context.close();
    }
  });

  test('save lead writes companyId + customerId, lead appears in kanban', async ({ page }) => {
    // _saveLead geocodes new-lead addresses via nominatim.openstreetmap.org,
    // which has no client timeout and rate-limits CI egress IPs — the save
    // then hangs the full test timeout. E2E must not depend on OSM: answer
    // the geocode with an empty result so the save proceeds without lat/lng.
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    await loginAs(page, creds);

    // Wait for the kanban to render before opening a modal — opening
    // before the page is hydrated can race against module load order.
    await openCrmView(page);
    await expect(page.locator('#kanbanBoard, #view-crm .kanban-board').first()).toBeVisible({ timeout: 15_000 });

    // Tag with a fixed prefix per session so cleanup can reliably
    // find every test lead even if a test crashes mid-write.
    const stamp = Date.now();
    const leadName = `[E2E] Smith ${stamp}`;
    // Unique per attempt: a retry re-runs against the same emulator session,
    // and a same-phone/same-address payload trips LeadDedup.checkAndPrompt's
    // modal, which awaits a human click forever.
    const leadPhone = '513' + String(stamp).slice(-7);
    const leadAddress = `${String(stamp).slice(-3)} E2E Test Lane, Cincinnati, OH`;

    // _saveLead stamps userId from window._user, which the auth listener
    // sets asynchronously after boot — calling before it lands writes
    // userId: undefined (addDoc rejects). A human can't click Save that
    // fast; the test can.
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // Open the new-lead modal via the canonical button. Selector
    // audited 2026-04-25: dashboard.html:8411 has the orange button
    // with onclick="openLeadModal()".
    await page.evaluate(() => { window.openLeadModal && window.openLeadModal(); });

    await page.fill('#lFname', '[E2E] Smith');
    await page.fill('#lLname', String(stamp));
    await page.fill('#lAddr', leadAddress);
    await page.fill('#lPhone', leadPhone);
    await page.fill('#lEmail', `e2e-${stamp}@nbd.test`);

    // Bypass the UI's `saveLead()` so we can stamp e2eTestData:true
    // (the modal has no field for it). We still go through
    // window._saveLead, which is the same code path the UI uses,
    // so the companyId/customerId/userId stamping is exercised end
    // to end. Cleanup callable filters on this flag.
    await page.evaluate(async (args) => {
      // ALREADY_EXISTS tolerance: emulator commit-retry bug — the lead
      // landed; the kanban render + read-back below find it.
      try {
        await window._saveLead({
          firstName: '[E2E] Smith',
          lastName: String(args.stamp),
          address: args.leadAddress,
          phone: args.leadPhone,
          email: `e2e-${args.stamp}@nbd.test`,
          stage: 'new',
          e2eTestData: true
        });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
    }, { stamp, leadAddress, leadPhone });

    // Give the optimistic insert + Firestore round-trip a moment to
    // settle. The kanban refresh is debounced; 4s is generous.
    await page.waitForTimeout(4_000);

    // Lead card should now show in some column with our [E2E] prefix.
    // We don't bind to a specific stage column because crm.js is free
    // to bucket new leads in different stages depending on view config.
    // Scoped to the CRM view: since 2026-09-28 the (hidden) Home widgets name
    // form-created leads too, so an unscoped .first() matched a Recent
    // Activity row under display:none instead of the kanban card.
    const card = page.locator('#view-crm').locator(`text=/\\[E2E\\] Smith.*${stamp}/i`).first();
    await expect(card, 'new [E2E] lead card visible in kanban').toBeVisible({ timeout: 8_000 });

    // Read the saved doc back via Firestore SDK to lock in companyId
    // + customerId stamping (Rock 3 PR 2 contract).
    const dbCheck = await page.evaluate(async (n) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      // The leads read rule is isOwner(resource.data.userId) — a query
      // must carry the userId filter or Firestore can't prove it complies
      // and rejects it outright (empty-message FirebaseError).
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fsMod.getDocs(
        fsMod.query(
          fsMod.collection(db, 'leads'),
          fsMod.where('userId', '==', uid),
          fsMod.where('e2eTestData', '==', true),
          fsMod.where('lastName', '==', String(n))
        )
      );
      const docs = [];
      snap.forEach(d => docs.push(Object.assign({ id: d.id }, d.data())));
      return docs;
    }, stamp);

    expect(dbCheck.length, 'exactly one [E2E] lead matches lastName').toBe(1);
    const lead = dbCheck[0];
    expect(lead.companyId, 'companyId stamped').toBeTruthy();
    expect(lead.userId, 'userId stamped').toBe(creds.email ? lead.userId : lead.userId); // userId existence check
    expect(lead.userId, 'userId is set').toBeTruthy();
    expect(lead.customerId, 'customerId follows the canonical mint shape (NBD-#### or <PREFIX>-####-<SALT>)').toMatch(CUSTOMER_ID_RE);
  });

  test('move stage logs timeline activity + updates stageStartedAt', async ({ page }) => {
    // Same nominatim stub as the save-lead test — _saveLead geocodes new
    // addresses and OSM rate-limits CI IPs with no client timeout.
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    await loginAs(page, creds);
    await openCrmView(page);
    await expect(page.locator('#kanbanBoard, #view-crm .kanban-board').first()).toBeVisible({ timeout: 15_000 });

    const stamp = Date.now();

    // Same auth-resolved gate as the save-lead test (userId stamping).
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // Seed a fresh lead in stage 'new', tagged for cleanup.
    const leadId = await page.evaluate(async (args) => {
      // ALREADY_EXISTS = the emulator commit-retry bug (see the addDoc
      // patch in fixtures/auth.js — _saveLead holds a closure addDoc the
      // patch can't reach). The lead LANDED; the re-fetch below finds it.
      try {
        await window._saveLead({
        firstName: '[E2E] Move',
        lastName: String(args.stamp),
        // Unique per attempt so LeadDedup's blocking prompt never fires
        // against leftovers from an earlier attempt in the same session.
        address: `${String(args.stamp).slice(-3)} Stage-Move Way, Cincinnati, OH`,
        phone: '513' + String(args.stamp).slice(-7),
        email: `e2e-move-${args.stamp}@nbd.test`,
        stage: 'new',
        e2eTestData: true
      });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      // _saveLead returns null on the geocoded path (it does its own
      // loadLeads refresh), so re-fetch by lastName to grab the id.
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      // userId filter keeps the query provable under the leads read rule
      // (isOwner(resource.data.userId)) — see the save-lead test.
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fsMod.getDocs(
        fsMod.query(
          fsMod.collection(db, 'leads'),
          fsMod.where('userId', '==', uid),
          fsMod.where('lastName', '==', String(args.stamp)),
          fsMod.where('e2eTestData', '==', true)
        )
      );
      let id = null;
      snap.forEach(d => { if (!id) id = d.id; });
      return id;
    }, { stamp });

    expect(leadId, 'seeded [E2E] Move lead has an id').toBeTruthy();

    // Capture stageStartedAt BEFORE the move so we can assert it
    // updates rather than just being equal-by-coincidence.
    const beforeMove = await page.evaluate(async (id) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const snap = await fsMod.getDoc(fsMod.doc(db, 'leads', id));
      const d = snap.data();
      return { stage: d.stage, stageStartedAt: d.stageStartedAt && d.stageStartedAt.seconds };
    }, leadId);

    // Tiny wait so the new stageStartedAt timestamp can differ from
    // beforeMove's. Server timestamps have second-level resolution.
    await page.waitForTimeout(1_500);

    // Drive the stage transition through the same code path the UI
    // uses on drag/drop. moveCard() handles the firestore transaction,
    // optimistic UI, and timeline-note creation.
    await page.evaluate(async (id) => {
      return window.moveCard && window.moveCard(id, 'contacted');
    }, leadId);

    await page.waitForTimeout(2_500);

    // Assert: stage advanced, stageStartedAt advanced, timeline note
    // created. Location re-audited 2026-07-04 against moveCard
    // (crm-pipeline.js:1661): stage-change notes live in the TOP-LEVEL
    // `notes` collection keyed by a leadId field — not a leads/{id}
    // subcollection. The userId filter keeps the query provable under
    // the notes read rule (isOwner(resource.data.userId)).
    const afterMove = await page.evaluate(async (id) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const leadSnap = await fsMod.getDoc(fsMod.doc(db, 'leads', id));
      const lead = leadSnap.data();
      const uid = (window._auth || window.auth).currentUser.uid;
      const notesSnap = await fsMod.getDocs(fsMod.query(
        fsMod.collection(db, 'notes'),
        fsMod.where('userId', '==', uid),
        fsMod.where('leadId', '==', id)
      ));
      const notes = []; notesSnap.forEach(n => notes.push(n.data()));
      return {
        stage: lead.stage,
        stageStartedAt: lead.stageStartedAt && lead.stageStartedAt.seconds,
        notesCount: notes.length,
        notesShapes: notes.map(n => ({ type: n.type || null, text: (n.text || '').slice(0, 60) }))
      };
    }, leadId);

    expect(afterMove.stage, 'stage moved to contacted').toBe('contacted');
    expect(afterMove.stageStartedAt, 'stageStartedAt is set').toBeTruthy();
    if (beforeMove.stageStartedAt && afterMove.stageStartedAt) {
      expect(afterMove.stageStartedAt, 'stageStartedAt updated').toBeGreaterThan(beforeMove.stageStartedAt);
    }
    expect(afterMove.notesCount, 'at least one timeline note created on move').toBeGreaterThan(0);
  });
  test('estimate: browser V2 math matches the Node engine, doc persists with stamping + deposit', async ({ page }) => {
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // The estimate engine is lazy (ScriptLoader PR 2c bundle) — pull it in
    // exactly the way goTo('est') would, then wait for the engine + the
    // shared persist path.
    await page.waitForFunction(() => window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function', null, { timeout: 15_000 });
    await page.evaluate(() => window.ScriptLoader.loadBundle('estimates'));
    await page.waitForFunction(() =>
      window.EstimateBuilderV2 && typeof window.EstimateBuilderV2.calculateEstimate === 'function'
      && typeof window._saveEstimate === 'function', null, { timeout: 20_000 });

    // Same locked scenario shape as tests/estimate-pricing.test.js — the
    // Node engine is the spec reference; the browser engine must agree to
    // the penny, and the persisted doc must carry the same numbers.
    const INPUT = {
      method: 'per-sq', tier: 'better', mode: 'cash',
      rawSqft: 3900, pitch: '6/12', county: 'hamilton-oh', wasteFactorOverride: 1.0,
    };
    // eslint-disable-next-line global-require
    const EBv2 = require('../../docs/pro/js/estimate-builder-v2.js');
    const expected = EBv2.calculateEstimate(INPUT);
    const expectedDeposit = EBv2.calcDeposit(expected.total, INPUT.mode, {});

    const saved = await page.evaluate(async (input) => {
      const r = window.EstimateBuilderV2.calculateEstimate(input);
      const dep = window.EstimateBuilderV2.calcDeposit(r.total, input.mode, {});
      // ALREADY_EXISTS tolerance for _saveEstimate (closure-held addDoc —
      // the fixtures/auth.js window.addDoc patch can't reach it; bit the
      // invoice journey on CI 2026-07-05). The estimate LANDED but the id
      // was lost — recover it via the unique name (userId filter keeps the
      // query provable under the estimates read rule).
      async function saveEstimateTolerant(payload) {
        try { return await window._saveEstimate(payload); }
        catch (e) {
          if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e;
          const fsMod2 = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
          const db2 = window.db || window._db;
          const uid2 = (window._auth || window.auth).currentUser.uid;
          const snap2 = await fsMod2.getDocs(fsMod2.query(
            fsMod2.collection(db2, 'estimates'),
            fsMod2.where('userId', '==', uid2),
            fsMod2.where('name', '==', payload.name)
          ));
          let rid = null; snap2.forEach(d => { if (!rid) rid = d.id; });
          if (!rid) throw e;
          return rid;
        }
      }
      const id = await saveEstimateTolerant({
        name: '[E2E] V2 parity ' + Date.now(),
        addr: '999 E2E Test Lane, Cincinnati, OH',
        mode: input.mode, tier: input.tier, engine: 'v2',
        grandTotal: r.total, deposit: dep,
        e2eTestData: true,
      });
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const snap = await fsMod.getDoc(fsMod.doc(db, 'estimates', id));
      return { id, browserTotal: r.total, browserDeposit: dep, doc: snap.data() };
    }, INPUT);

    expect(saved.browserTotal, 'browser V2 total == Node V2 total (engine parity across runtimes)').toBe(expected.total);
    expect(saved.doc.grandTotal, 'persisted grandTotal matches the engine').toBe(expected.total);
    expect(saved.doc.userId, '_saveEstimate stamps userId').toBeTruthy();
    expect(saved.browserDeposit.amount, 'deposit follows spec (cash 50%, $25-rounded — D-5)').toBe(expectedDeposit.amount);
    expect(saved.doc.deposit && saved.doc.deposit.amount, 'persisted deposit matches').toBe(expectedDeposit.amount);
    expect(saved.doc.deposit && saved.doc.deposit.remainder, 'deposit + remainder reconstructs the total')
      .toBeCloseTo(expected.total - expectedDeposit.amount, 2);
  });

  test('invoice: createInvoiceFromEstimate carries totals + deposit, balanceDue is the FULL total', async ({ page }) => {
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // InvoicePipeline is an EAGER <script defer> (dashboard.html) but it runs
    // on the window Firestore globals (_db/doc/getDoc/addDoc/collection) that
    // dashboard-bootstrap exposes asynchronously — wait for both ends of that
    // contract, plus the shared estimate persist path.
    await page.waitForFunction(() =>
      window.InvoicePipeline && typeof window.InvoicePipeline.createInvoiceFromEstimate === 'function'
      && window._db && typeof window.addDoc === 'function'
      && typeof window._saveEstimate === 'function', null, { timeout: 20_000 });

    const stamp = Date.now();
    // Classic row-shaped estimate with NO locked grandTotal: exercises the
    // row-sum branch of createInvoiceFromEstimate (per-sq V2 estimates take
    // the single-summary-line branch instead, covered by unit tests).
    // taxRate 0 is the insurance-scope contract: an explicit 0 must be
    // HONORED, not silently defaulted to 7.5% (Audit #3 F-3).
    const EST = {
      name: `[E2E] Invoice source ${stamp}`,
      addr: '742 Invoice Test Ct, Cincinnati, OH',
      // Linkage is copied verbatim onto the invoice; the pipeline's
      // enrichment read of this (nonexistent) lead is best-effort and
      // swallows the permission error.
      leadId: `e2e-missing-lead-${stamp}`,
      rows: [
        { desc: 'Tear-off + disposal', qty: 20, rate: 100, total: 2000 },
        { desc: 'Shingles (architectural)', qty: 1, rate: 1500, total: 1500 },
      ],
      taxRate: 0,
      // Classic builder saves deposit as an OBJECT — the pipeline must
      // coerce .amount, not Number() the object into NaN (review blocker).
      deposit: { pct: 50, amount: 1750, remainder: 1750 },
      e2eTestData: true,
    };

    const out = await page.evaluate(async (est) => {
      // Re-check auth IN this execution context right before the write:
      // the outer waitForFunction gate can pass against a pre-navigation
      // document, after which _saveEstimate stamps userId from a _user the
      // fresh dashboard context hasn't re-populated yet (CI retry flake:
      // "Unsupported field value: undefined in field userId").
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // ALREADY_EXISTS tolerance for _saveEstimate (closure-held addDoc —
      // the fixtures/auth.js window.addDoc patch can't reach it; bit the
      // invoice journey on CI 2026-07-05). The estimate LANDED but the id
      // was lost — recover it via the unique name (userId filter keeps the
      // query provable under the estimates read rule).
      async function saveEstimateTolerant(payload) {
        try { return await window._saveEstimate(payload); }
        catch (e) {
          if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e;
          const fsMod2 = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
          const db2 = window.db || window._db;
          const uid2 = (window._auth || window.auth).currentUser.uid;
          const snap2 = await fsMod2.getDocs(fsMod2.query(
            fsMod2.collection(db2, 'estimates'),
            fsMod2.where('userId', '==', uid2),
            fsMod2.where('name', '==', payload.name)
          ));
          let rid = null; snap2.forEach(d => { if (!rid) rid = d.id; });
          if (!rid) throw e;
          return rid;
        }
      }
      const estimateId = await saveEstimateTolerant(est);
      const invoiceId = await window.InvoicePipeline.createInvoiceFromEstimate(estimateId);
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      // Tag the invoice for the cleanupE2ETestData callable — the pipeline
      // writes a fixed shape with no room for test flags. Owner update is
      // allowed while createdBy/companyId/estimateId/createdAt stay frozen.
      await fsMod.updateDoc(fsMod.doc(db, 'invoices', invoiceId), { e2eTestData: true });
      const snap = await fsMod.getDoc(fsMod.doc(db, 'invoices', invoiceId));
      return { estimateId, invoiceId, inv: snap.data() };
    }, EST);

    const inv = out.inv;
    const expectedSubtotal = EST.rows.reduce((s, r) => s + r.total, 0);
    expect(inv.subtotal, 'subtotal = Σ row totals').toBe(expectedSubtotal);
    expect(inv.taxRate, 'estimate taxRate 0 honored (not defaulted to 7.5%)').toBe(0);
    expect(inv.tax, 'tax is 0 at a 0% rate').toBe(0);
    expect(inv.total, 'total = subtotal at 0% tax').toBe(expectedSubtotal);
    // Deposit rule (2026-09-25): the invoice asks deposit-rule.js — a $3,500
    // cash job is 50% = $1,750, which is also this fixture's saved classic
    // {amount}; the object is never Number()'d into NaN either way.
    expect(inv.depositAmount, 'deposit follows the rule (cash $3,500 → 50% = $1,750)').toBe(EST.deposit.amount);
    // The locked AR contract: balanceDue tracks genuinely-owed money — the
    // FULL total at create time. It was `total - depositAmount`, which booked
    // the deposit as collected before any payment arrived, under-reporting AR.
    expect(inv.balanceDue, 'balanceDue = full total at create').toBe(inv.total);
    expect(inv.status, 'new invoice starts as draft').toBe('draft');
    expect(inv.depositPaid, 'deposit not marked paid at create').toBe(false);
    expect(inv.amountPaid, 'nothing collected at create').toBe(0);
    expect(inv.estimateId, 'invoice → estimate linkage').toBe(out.estimateId);
    expect(inv.leadId, 'invoice inherits the estimate leadId').toBe(EST.leadId);
    expect(inv.createdBy, 'createdBy stamped').toBeTruthy();
    expect(inv.companyId, 'companyId stamped (solo convention: uid)').toBeTruthy();
    expect(inv.items.length, 'row-shaped estimate keeps its line items').toBe(EST.rows.length);
  });

  test('photo: uploadFromFile stores original + thumb, derives phase; dashboard _uploadPhoto pins the nested storagePath shape', async ({ page }) => {
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // PhotoEngine lives in the lazy 'photos' bundle (ScriptLoader PR 2c);
    // the upload path additionally needs the Storage handle that bootstrap
    // exposes as window._storage (emulator-wired on localhost, line 809).
    await page.waitForFunction(() => window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function', null, { timeout: 15_000 });
    await page.evaluate(() => window.ScriptLoader.loadBundle('photos'));
    // CRITICAL: exclude the lazy stub. dashboard-actions.js installs a
    // PhotoEngine placeholder whose uploadFromFile is a fire-and-forget
    // bundle loader that resolves undefined — it satisfies a bare typeof
    // check, and on a slow run the evaluate below wins the race against
    // photo-engine.js overwriting the global ('photo.id of undefined',
    // CI 2026-07-05). Gate on the REAL engine only.
    await page.waitForFunction(() =>
      window.PhotoEngine && !window.PhotoEngine.__nbdLazyPhotosStub
      && typeof window.PhotoEngine.uploadFromFile === 'function'
      // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
      && window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY._uploadPhoto === 'function'
      && window._storage && window._db, null, { timeout: 20_000 });

    const stamp = Date.now();
    const out = await page.evaluate(async (args) => {
      // Same in-context auth re-check as the invoice journey —
      // uploadPhotoToFirebase throws without window._user.
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // A REAL image via canvas export: generateThumbnail() re-decodes the
      // blob as an <img>, so a hand-rolled Blob of junk bytes fails there,
      // and storage.rules requires an image/* content type (isImage()).
      const canvas = document.createElement('canvas');
      canvas.width = 80; canvas.height = 60;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#d2691e'; ctx.fillRect(0, 0, 80, 60);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));

      const leadId = 'e2e-photo-lead-' + args.stamp;
      const photo = await window.PhotoEngine.uploadFromFile(
        leadId, blob, ['before'], '[E2E] photo journey ' + args.stamp);

      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      // Tag for the cleanup callable (the upload writes a fixed doc shape).
      // NOTE: cleanup deletes the Firestore doc; the Storage originals under
      // photos/<uid>/<leadId>/ are only reclaimed in emulator runs (state
      // evaporates) — a prod run leaves two tiny orphaned JPEGs per run.
      await fsMod.updateDoc(fsMod.doc(db, 'photos', photo.id), { e2eTestData: true });
      const snap = await fsMod.getDoc(fsMod.doc(db, 'photos', photo.id));
      return { id: photo.id, doc: snap.data(), uid: window._user.uid, leadId };
    }, { stamp });

    const doc = out.doc;
    expect(doc, 'photo doc persisted to Firestore').toBeTruthy();
    // share-gallery.js buckets on photo.phase — without the derived field
    // every photo landed in 'During' and Before/After stayed empty.
    expect(doc.phase, "tag 'before' derives phase 'Before'").toBe('Before');
    expect(doc.userId, 'userId stamped from window._user').toBe(out.uid);
    expect(doc.leadId, 'photo keyed to its lead').toBe(out.leadId);
    expect(doc.tags, 'user tags persisted').toContain('before');
    expect(doc.url, 'download URL for the original').toBeTruthy();
    expect(doc.thumbUrl, 'thumbnail generated + uploaded').toBeTruthy();
    // storagePath is the future-proof deletion key — must be rooted under
    // the owner-scoped prefix that storage.rules enforces.
    expect(doc.storagePath, 'original rooted under photos/<uid>/<leadId>/')
      .toMatch(new RegExp('^photos/' + out.uid + '/' + out.leadId + '/'));
    expect(doc.thumbStoragePath, 'thumb rooted under .../thumbs/')
      .toMatch(new RegExp('^photos/' + out.uid + '/' + out.leadId + '/thumbs/'));
    expect(doc.createdAt, 'createdAt serverTimestamp (canonical ordering field)').toBeTruthy();

    // ── Dashboard quick-upload leg ──────────────────────────────
    // _uploadPhoto (dashboard-bootstrap.module.js, registry-only as of
    // Globals Tranche 3 T3-C, 2026-09-18) writes the
    // NESTED shape photos/{uid}/{leadId}/{ts}_{name} — one of the
    // shapes the image pipeline silently skipped until 2026-08-16
    // (its trigger required exactly 3 path segments). Pin two things
    // through the real Storage emulator + storage.rules:
    //   1. the nested write is accepted by the rules, and
    //   2. the doc stamps storagePath in the exact nested shape the
    //      pipeline's equality lookup keys on.
    const dash = await page.evaluate(async (args) => {
      const canvas = document.createElement('canvas');
      canvas.width = 60; canvas.height = 40;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e6fd2'; ctx.fillRect(0, 0, 60, 40);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
      const file = new File([blob], 'e2e_dash.jpg', { type: 'image/jpeg' });

      const leadId = 'e2e-dash-photo-lead-' + args.stamp;
      // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
      const url = await window.__NBD_CALL_REGISTRY._uploadPhoto(leadId, file);

      // _uploadPhoto returns only the download URL — re-query for the
      // doc to tag it for cleanup + read back its persisted shape.
      // Two equality filters (leadId + userId) → merge join, no
      // composite index needed.
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const snap = await fsMod.getDocs(fsMod.query(
        fsMod.collection(db, 'photos'),
        fsMod.where('leadId', '==', leadId),
        fsMod.where('userId', '==', window._user.uid)));
      let id = null, data = null;
      snap.forEach(d => { if (!id) { id = d.id; data = d.data(); } });
      if (id) await fsMod.updateDoc(fsMod.doc(db, 'photos', id), { e2eTestData: true });
      return { url, doc: data, leadId, uid: window._user.uid };
    }, { stamp });

    expect(dash.url, 'dashboard _uploadPhoto returns a download URL').toBeTruthy();
    expect(dash.doc, 'dashboard upload persisted a photos doc').toBeTruthy();
    expect(dash.doc.storagePath, 'nested shape pinned: photos/<uid>/<leadId>/<ts>_<name>')
      .toMatch(new RegExp('^photos/' + dash.uid + '/' + dash.leadId + '/\\d+_e2e_dash\\.jpg$'));
    expect(dash.doc.userId, 'userId stamped').toBe(dash.uid);
    expect(dash.doc.companyId, 'tenant key stamped (solo convention: uid)').toBeTruthy();
  });

});

// ───────────────────────────────────────────────────────────────
// Destructive flows, second emulator shard. Same account, same
// serial discipline — split from @shard1 so CI runs each half in its
// OWN emulator session (the Java Firestore emulator degrades under a
// 16-journey single-session load and a rotating test lost its retries
// each run — see the KNOWN FLAKE CLASS note in .github/workflows/
// ci.yml). Scaffolding (creds gate + prod-mode cleanup) is duplicated
// deliberately: each shard must be self-sufficient.
// ───────────────────────────────────────────────────────────────
test.describe.serial('Authenticated destructive flows @shard2', () => {
  let creds;
  test.beforeAll(() => {
    try { creds = requireTestUser(); }
    catch (e) { console.warn('[pro-authed-destructive-2] ' + e.message); }
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test.afterAll(async ({ browser }) => {
    if (!creds) return;
    // Emulator mode: state evaporates with the emulator session and the
    // cleanup callable's functions emulator isn't running. Skip (same as
    // shard 1 — the callable is idempotent if both shards ever run it).
    if (/localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginAs(page, creds);
      const result = await cleanupE2EData(page);
      // eslint-disable-next-line no-console
      console.log('[pro-authed-cleanup-2]', JSON.stringify(result));
    } finally {
      await context.close();
    }
  });

  test('docgen: generate persists metadata under the lead + uploads rendered HTML', async ({ page }) => {
    // The doc-generation persist path is fully client-side (Firestore
    // subcollection + Storage HTML upload) — the functions emulator is only
    // involved for server PDF render (contract/invoice/change_order/receipt,
    // which FALLS BACK to client render) and remote signing. 'thank_you' is
    // not in SERVER_TYPE_MAP, so this journey is hermetic without functions.
    //
    // Capture the page's console: the docgen persist path SWALLOWS write
    // failures ('Document metadata persist failed: …' console.warn), so an
    // empty read-back can only be explained by what the page logged.
    const pageLog = [];
    page.on('console', msg => pageLog.push(`[${msg.type()}] ${msg.text()}`));
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    const stamp = Date.now();
    // The documents subcollection rule does get(leads/{leadId}).data.userId —
    // the PARENT LEAD MUST EXIST and be ours, so seed one first (same
    // re-fetch-by-lastName pattern as the move-stage journey; _saveLead
    // returns null on the geocoded path).
    const leadId = await page.evaluate(async (args) => {
      // Same in-context auth re-check as the invoice journey — _saveLead
      // stamps userId from window._user.
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // ALREADY_EXISTS tolerance (emulator commit-retry; see fixtures/auth.js
      // addDoc patch note) — the lead landed; the re-fetch below finds it.
      try {
      await window._saveLead({
        firstName: '[E2E] DocGen',
        lastName: String(args.stamp),
        address: `${String(args.stamp).slice(-3)} DocGen Drive, Cincinnati, OH`,
        phone: '513' + String(args.stamp).slice(-7),
        email: `e2e-docgen-${args.stamp}@nbd.test`,
        stage: 'new',
        e2eTestData: true
      });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fsMod.getDocs(fsMod.query(
        fsMod.collection(db, 'leads'),
        fsMod.where('userId', '==', uid),
        fsMod.where('lastName', '==', String(args.stamp)),
        fsMod.where('e2eTestData', '==', true)
      ));
      let id = null;
      snap.forEach(d => { if (!id) id = d.id; });
      return id;
    }, { stamp });
    expect(leadId, 'seeded [E2E] DocGen lead has an id').toBeTruthy();

    // NBDDocGen is in the lazy 'docgen' bundle; NBDDocViewer is an EAGER
    // <script defer> (dashboard.html) — generate() only persists when the
    // viewer path is available, so gate on both.
    await page.waitForFunction(() => window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function', null, { timeout: 15_000 });
    await page.evaluate(() => window.ScriptLoader.loadBundle('docgen'));
    await page.waitForFunction(() =>
      window.NBDDocGen && typeof window.NBDDocGen.generate === 'function'
      && window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function'
      && window.storage && typeof window.uploadBytes === 'function', null, { timeout: 20_000 });

    await page.evaluate(async (args) => {
      await window.NBDDocGen.generate('thank_you', {
        leadId: args.leadId,
        customer: { name: '[E2E] DocGen ' + args.stamp, address: '1 DocGen Drive', email: `e2e-docgen-${args.stamp}@nbd.test` },
        homeownerName: '[E2E] DocGen ' + args.stamp,
        projectType: 'Roof Replacement',
        completionDate: '2026-07-04',
      });
    }, { leadId, stamp });

    // generate() kicks persistence off in the background (_persistPromise);
    // poll the subcollection from the TEST side. Not waitForFunction: its
    // async-predicate result comes back as a JSHandle whose jsonValue
    // doesn't round-trip a stringified array reliably (CI: "docs.find is
    // not a function") — page.evaluate deserializes arrays natively.
    let docs = [];
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      docs = await page.evaluate(async (id) => {
        const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const db = window.db || window._db;
        // The emulator under serial-suite load intermittently reports
        // 'client is offline' — treat any read error as "not yet" and let
        // the outer poll retry instead of failing the whole journey.
        let snap;
        try {
          snap = await fsMod.getDocs(fsMod.collection(db, 'leads', id, 'documents'));
        } catch (_) { return []; }
        const list = [];
        snap.forEach(d => {
          const data = d.data();
          list.push({
            id: d.id, type: data.type, typeName: data.typeName,
            userId: data.userId, filename: data.filename,
            htmlPath: data.htmlPath, htmlUrl: data.htmlUrl,
          });
        });
        return list;
      }, leadId);
      if (docs.length) break;
      await page.waitForTimeout(1_000);
    }

    const meta = docs.find(d => d.type === 'thank_you');
    if (!meta) {
      // Self-describing failure: surface what the page itself said —
      // 'Document metadata persist failed' / 'Document HTML upload failed'
      // console.warns are the only trace when the swallowed persist dies.
      const interesting = pageLog.filter(l =>
        /docgen|document|persist|upload|firestore|storage|offline|denied/i.test(l)).slice(-12);
      throw new Error('thank_you metadata never appeared under leads/' + leadId
        + '/documents after 20s. Page console (filtered):\n' + (interesting.join('\n') || '(nothing relevant logged)'));
    }
    expect(meta.userId, 'userId stamped on the metadata').toBeTruthy();
    expect(meta.typeName, 'human-readable type name recorded').toBeTruthy();
    expect(meta.filename, 'filename recorded for the PDF flow').toMatch(/\.pdf$/);
    // Storage leg: the rendered HTML must land under the owner-scoped
    // documents/ prefix (storage.rules isHtmlOnly path). htmlPath is the only
    // pointer recorded — the customer-page documents tab reopens it through
    // the authed getDocumentHtml callable.
    expect(meta.htmlPath, 'HTML uploaded under documents/<uid>/<leadId>/')
      .toMatch(new RegExp('^documents/[^/]+/' + leadId + '/'));
    // Regression guard: htmlUrl was a getDownloadURL — a permanent, no-auth,
    // unrevocable URL for a document carrying the homeowner's name, address
    // and signature, persisted into Firestore where it leaked into every
    // export of the lead. It must never come back. See functions/document-view.js.
    expect(meta.htmlUrl, 'no permanent Storage download token persisted').toBeFalsy();

    // Tag the metadata doc for prod-run cleanup (subcollection docs don't
    // cascade-delete with the lead). Owner write allowed via the parent-get
    // rule. Emulator runs don't need it — state evaporates.
    await page.evaluate(async (args) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      await fsMod.updateDoc(fsMod.doc(db, 'leads', args.leadId, 'documents', args.docId), { e2eTestData: true });
    }, { leadId, docId: meta.id });
  });

  test('d2d: appointment knock persists the disposition contract + auto-converts to exactly one linked lead', async ({ page }) => {
    // The hot-disposition auto-convert funnels into _saveLead, which geocodes
    // new addresses via nominatim — same OSM stub as the save-lead journey so
    // the knock→lead promotion never depends on OSM rate limits.
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // The D2D tracker is the lazy 'd2d' bundle (ScriptLoader PR 2e): core
    // publishes the data layer on window._D2DState (submitKnock is the exact
    // write path the QuickKnock modal's handleSubmitKnock funnels into —
    // d2d-tracker-core-2026b.js:1051, exported at :2599), ui + shim compose
    // window.D2D on top. The write additionally needs the Firestore globals
    // bootstrap exposes asynchronously, plus _saveLead for the auto-convert.
    // renderD2D/refreshMapMarkers/updateNavBadge all guard on their DOM/map
    // hosts, so calling submitKnock without ever opening the D2D view is safe.
    await page.waitForFunction(() => window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function', null, { timeout: 15_000 });
    await page.evaluate(() => window.ScriptLoader.loadBundle('d2d'));
    await page.waitForFunction(() =>
      window._D2DState && typeof window._D2DState.submitKnock === 'function'
      && window._db && typeof window.addDoc === 'function'
      && typeof window.serverTimestamp === 'function'
      && typeof window._saveLead === 'function', null, { timeout: 20_000 });

    const stamp = Date.now();
    const knockId = await page.evaluate(async (args) => {
      // Re-check auth IN this execution context right before the write:
      // the outer waitForFunction gate can pass against a pre-navigation
      // document, after which _saveLead stamps userId from a _user the
      // fresh dashboard context hasn't re-populated yet (CI retry flake:
      // "Unsupported field value: undefined in field userId").
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // Unique per attempt on BOTH axes: address drives getAttemptCount
      // (attemptNumber would exceed 1 against leftovers — knocks have no
      // cleanup sweep, so prod runs accumulate) and phone/address drive
      // LeadDedup's blocking modal inside the auto-convert's _saveLead.
      return window._D2DState.submitKnock({
        address: `${String(args.stamp).slice(-6)} D2D Knock Way, Cincinnati, OH`,
        homeowner: '[E2E] Knock ' + args.stamp,
        phone: '513' + String(args.stamp).slice(-7),
        email: `e2e-knock-${args.stamp}@nbd.test`,
        disposition: 'appointment',
        notes: '[E2E] d2d journey',
        lat: null,
        lng: null
      });
    }, { stamp });
    expect(knockId, 'submitKnock persisted the knock and returned its id').toBeTruthy();

    // submitKnock fires convertToLead NON-blocking (a .catch()ed background
    // promise), so poll from the TEST side for the promoted lead + the
    // convertedToLead flip. page.evaluate, not waitForFunction — see the
    // docgen journey's note on async-predicate JSHandle round-tripping.
    let out = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      out = await page.evaluate(async (id) => {
        const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const db = window.db || window._db;
        const uid = (window._auth || window.auth).currentUser.uid;
        const knockSnap = await fsMod.getDoc(fsMod.doc(db, 'knocks', id));
        const knock = knockSnap.exists() ? knockSnap.data() : null;
        // The knocks/leads read rules are isOwner(resource.data.userId) —
        // the query must carry the userId filter or Firestore can't prove
        // compliance and rejects it (see the save-lead journey).
        const leadsSnap = await fsMod.getDocs(fsMod.query(
          fsMod.collection(db, 'leads'),
          fsMod.where('userId', '==', uid),
          fsMod.where('d2dKnockId', '==', id)
        ));
        const leads = [];
        leadsSnap.forEach(d => leads.push(Object.assign({ id: d.id }, d.data())));
        return {
          uid,
          knock: knock && {
            userId: knock.userId, companyId: knock.companyId,
            disposition: knock.disposition, stage: knock.stage,
            attemptNumber: knock.attemptNumber,
            convertedToLead: knock.convertedToLead, leadId: knock.leadId || null
          },
          leads: leads.map(l => ({
            id: l.id, userId: l.userId, source: l.source, stage: l.stage,
            isProspect: l.isProspect, disposition: l.disposition
          }))
        };
      }, knockId);
      // Wait for the leadId back-link too, not just convertedToLead: the
      // convert transaction flips convertedToLead + creates the lead, but
      // _saveLead stamps knock.leadId in a SEPARATE write. Breaking on
      // convertedToLead alone can read the knock before the back-link lands
      // (leadId null) under a slow emulator, spuriously failing the
      // "knock → lead back-link" assertion below. Poll until it's stamped
      // (or time out and let that assertion report the real gap).
      if (out && out.knock && out.knock.convertedToLead === true && out.knock.leadId && out.leads.length) break;
      await page.waitForTimeout(1_000);
    }

    // Knock-side contract (submitKnock, d2d-tracker-core-2026b.js:1082):
    // owner stamping + the disposition→stage derivation the D2D metrics,
    // heat map and follow-up engine all bucket on.
    expect(out && out.knock, 'knock doc readable after write').toBeTruthy();
    expect(out.knock.userId, 'knock userId stamped from window._user').toBe(out.uid);
    expect(out.knock.companyId, 'knock companyId stamped (solo convention: uid)').toBeTruthy();
    expect(out.knock.disposition, 'disposition persisted').toBe('appointment');
    expect(out.knock.stage, "disposition 'appointment' derives knock stage 'appointment'").toBe('appointment');
    expect(out.knock.attemptNumber, 'first knock at a fresh address is attempt #1').toBe(1);

    // Promotion contract (convertToLead): an appointment is a QUALIFIED
    // customer — it lands in the kanban immediately (isProspect false, stage
    // 'contacted'), tagged with the D2D source + structured disposition key,
    // and the runTransaction double-convert guard means EXACTLY ONE lead per
    // knock (the two-pins/two-customer-IDs regression).
    expect(out.knock.convertedToLead, 'knock flagged convertedToLead after auto-promote').toBe(true);
    expect(out.leads.length, 'exactly ONE lead per hot knock (transaction dedup guard)').toBe(1);
    const lead = out.leads[0];
    expect(out.knock.leadId, 'knock → lead back-link stamped by _saveLead').toBe(lead.id);
    expect(lead.userId, 'lead userId stamped').toBe(out.uid);
    // 'Door Knock' is the canonical source string (Joe, 2026-09-06). This
    // asserted 'Door-to-Door' while maps-overlays.js wrote 'Door Knock' for
    // the same act, so the two halves of door-knocking lived in separate
    // buckets and prospects.js — which counted only 'Door-to-Door' — reported
    // a 0% conversion rate that was never real. Pin the canonical value here:
    // this assertion is what stops the fork reopening.
    expect(lead.source, 'lead source attributed to the canonical Door Knock').toBe('Door Knock');
    // 2026-10-03: an appointment is booked, not an inspection done — Contacted
    // (d2d-knock-lead-logic.js stageForDisposition).
    expect(lead.stage, "appointment knock maps to CRM stage 'contacted'").toBe('contacted');
    expect(lead.isProspect, 'appointment lead is a full customer, NOT a hidden prospect').toBe(false);
    expect(lead.disposition, 'structured disposition key persisted for the Prospects bucketer').toBe('appointment');

    // Tag both docs for prod-run cleanup — submitKnock/convertToLead write
    // fixed shapes with no room for the flag (post-hoc owner update, same as
    // the invoice journey). NOTE: the cleanup callable currently sweeps only
    // leads/estimates, so the [E2E] prefix keeps any stragglers obvious.
    await page.evaluate(async (args) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      await fsMod.updateDoc(fsMod.doc(db, 'knocks', args.knockId), { e2eTestData: true });
      await fsMod.updateDoc(fsMod.doc(db, 'leads', args.leadId), { e2eTestData: true });
    }, { knockId, leadId: lead.id });
  });

  test('scheduling: rep-typed scheduledDate persists date-only and surfaces on the Smart Calendar', async ({ page }) => {
    // Same nominatim stub as the save-lead test — _saveLead geocodes new
    // addresses and OSM rate-limits CI IPs with no client timeout.
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // smart-calendar.js is EAGER (<script defer>, dashboard.html:5941) —
    // no bundle to load — but it renders into #calUpcoming, which lives in
    // <template id="tpl-view-schedule"> and only exists after goTo('schedule')
    // stamps it. Its appointment reads run on the window Firestore globals
    // bootstrap exposes asynchronously; /appointments itself is webhook-
    // written (rules: write false), so the client-writable scheduling path —
    // and the one this journey locks in — is the lead's date-only
    // scheduledDate, which historically reached NO calendar (the motivating
    // bug in smart-calendar.js's manual-scheduled block).
    await page.waitForFunction(() =>
      typeof window.goTo === 'function'
      // Registry-only since Globals Tranche 3 T3-C (smart-calendar.js).
      && window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.loadSmartCalendar === 'function'
      && window._db && typeof window.getDocs === 'function'
      && typeof window.orderBy === 'function'
      && typeof window._saveLead === 'function', null, { timeout: 20_000 });

    const stamp = Date.now();
    // safeEvaluate: this test was tonight's most frequent SW-reload
    // victim (failed 3 CI runs at these evaluates before the fixture
    // hardening existed).
    const seeded = await safeEvaluate(page, async (args) => {
      // Same in-context auth re-check as the invoice journey — _saveLead
      // stamps userId from window._user.
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // "Today" must be computed in PAGE-LOCAL time: smart-calendar buckets
      // manual jobs by comparing lead.scheduledDate to the browser's local
      // yyyy-mm-dd, and a UTC-derived date in the TEST process can be a
      // different calendar day around midnight.
      const t = new Date();
      const todayStr = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      // ALREADY_EXISTS tolerance (emulator commit-retry; see fixtures/auth.js
      // addDoc patch note): the lead landed but the returned id is lost —
      // fall back to the same re-fetch-by-lastName the other journeys use.
      let leadId = null;
      try {
        leadId = await window._saveLead({
        firstName: '[E2E] Sched',
        lastName: String(args.stamp),
        // Unique per attempt so LeadDedup's blocking prompt never fires.
        address: `${String(args.stamp).slice(-3)} Schedule Street, Cincinnati, OH`,
        phone: '513' + String(args.stamp).slice(-7),
        email: `e2e-sched-${args.stamp}@nbd.test`,
        stage: 'new',
        scheduledDate: todayStr,
        e2eTestData: true
      });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      if (!leadId) {
        const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const db = window.db || window._db;
        const uid = (window._auth || window.auth).currentUser.uid;
        const snap = await fsMod.getDocs(fsMod.query(
          fsMod.collection(db, 'leads'),
          fsMod.where('userId', '==', uid),
          fsMod.where('lastName', '==', String(args.stamp)),
          fsMod.where('e2eTestData', '==', true)
        ));
        snap.forEach(d => { if (!leadId) leadId = d.id; });
      }
      return { leadId, todayStr };
    }, { stamp });
    // With the OSM stub answering [], _saveLead takes the no-geocode fallback
    // branch, which returns the new lead id (the null return the move-stage
    // journey works around is the geocoded branch only).
    expect(seeded.leadId, 'seeded [E2E] Sched lead has an id').toBeTruthy();

    // Persistence contract: scheduledDate is a DATE-ONLY string that must
    // round-trip verbatim — not be coerced to a Timestamp or shifted a day
    // by a UTC conversion (customer portal + smart calendar + docgen all
    // read it as yyyy-mm-dd).
    const persisted = await safeEvaluate(page, async (id) => {
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      const snap = await fsMod.getDoc(fsMod.doc(db, 'leads', id));
      const d = snap.data() || {};
      return { scheduledDate: d.scheduledDate, type: typeof d.scheduledDate, userId: d.userId };
    }, seeded.leadId);
    expect(persisted.type, 'scheduledDate stored as a string').toBe('string');
    expect(persisted.scheduledDate, 'date-only value round-trips verbatim').toBe(seeded.todayStr);

    // Surface contract: navigate to the Schedule view (stamps the template)
    // and render. The rep-typed date never reaches /appointments, so it must
    // appear via the "Scheduled today · no set time" block, wired to open
    // the lead card. _leads should already hold the lead (_saveLead awaits
    // loadLeads), but poll briefly to absorb a slow refresh.
    await page.evaluate(() => window.goTo('schedule'));
    await expect(page.locator('#calUpcoming')).toBeAttached({ timeout: 10_000 });
    const inLeads = await page.waitForFunction(
      (id) => (window._leads || []).some(l => l && l.id === id), seeded.leadId, { timeout: 15_000 });
    expect(inLeads).toBeTruthy();
    await page.evaluate(async () => { await window.__NBD_CALL_REGISTRY.loadSmartCalendar(); });

    const host = page.locator('#calUpcoming');
    await expect(host, 'manual-scheduled block rendered').toContainText('Scheduled today', { timeout: 10_000 });
    await expect(host, 'the scheduled lead is listed by name').toContainText(`[E2E] Sched ${stamp}`);
    // The Open → button must carry the REAL lead id — that's what the
    // openCardDetail click delegate dispatches on.
    await expect(
      page.locator(`#calUpcoming [data-sc-action="openCardDetail"][data-sc-id="${seeded.leadId}"]`),
      'Open → button wired to the lead id'
    ).toHaveCount(1);
  });

  test('expense: ledger stores integer cents + config-derived costType; mileage amount computed from the IRS rate', async ({ page }) => {
    // createExpense swallows write failures to a bare `false` (toast +
    // return) — the page console is the only witness to WHAT failed.
    const pageLog = [];
    page.on('console', msg => pageLog.push(`[${msg.type()}] ${msg.text()}`));
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    // Expenses ship in the lazy 'expenses' bundle (expense-config first —
    // the category→costType source of truth expenses.js reads at save time).
    // createExpense is the exact write path the Log Expense modal's Save
    // button funnels into (saveFromForm → createExpense). It runs on
    // window.db (bootstrap line 812), not _db — gate on both ends.
    await page.waitForFunction(() => window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function', null, { timeout: 15_000 });
    await page.evaluate(() => window.ScriptLoader.loadBundle('expenses'));
    await page.waitForFunction(() =>
      window.Expenses && typeof window.Expenses.createExpense === 'function'
      && window.ExpenseConfig && typeof window.ExpenseConfig.costTypeFor === 'function'
      && window.db && typeof window.addDoc === 'function', null, { timeout: 20_000 });

    const stamp = Date.now();
    // Fixed 2026 entry date: the mileage amount is COMPUTED (miles × the IRS
    // rate snapshotted by the entry's tax YEAR — expense-config.js table:
    // 2026 = 72.5¢/mi), so pinning the year keeps the expected cents stable
    // when the table gains future years.
    const DATE_STR = '2026-07-01';
    const out = await page.evaluate(async (args) => {
      // Same in-context auth re-check as the invoice journey —
      // createExpense stamps userId/createdBy from window._user.
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // Unique supplier per doc per attempt: it's the read-back key, and
      // createExpense itself has no duplicate guard to trip (that lives in
      // the form layer), so a retry never collides or blocks.
      const supplierMat = '[E2E] Supply Co ' + args.stamp;
      const supplierMi = '[E2E] Mileage ' + args.stamp;

      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const dbEarly = window.db || window._db;
      const uidEarly = (window._auth || window.auth).currentUser.uid;
      // Rapid back-to-back addDocs trip the emulator's commit-retry bug
      // (ALREADY_EXISTS / transient rejection — the same class docgen's
      // lead-create flakes on), and createExpense swallows that to `false`.
      // 2026-07-05 shard2 run: the SECOND create (mileage) failed 4/4 while
      // the first succeeded 4/4. Retry once after a beat — but probe the
      // unique supplier first: a retry-ambiguous failure may have actually
      // landed the doc, and blind re-create would break the exactly-one
      // assertion.
      async function createOnce(payload, supplier) {
        let ok = await window.Expenses.createExpense(payload);
        if (!ok) {
          await new Promise(r => setTimeout(r, 1500));
          const probe = await fsMod.getDocs(fsMod.query(
            fsMod.collection(dbEarly, 'expenses'),
            fsMod.where('userId', '==', uidEarly),
            fsMod.where('supplier', '==', supplier)
          ));
          ok = probe.empty ? await window.Expenses.createExpense(payload) : true;
        }
        return ok;
      }
      const okMat = await createOnce({
        amount: '1234.56', tax: '7.89', date: args.dateStr,
        supplier: supplierMat, category: 'materials', leadId: '',
        note: '[E2E] expenses journey', source: 'manual'
      }, supplierMat);
      const okMi = await createOnce({
        category: 'mileage', miles: '10.5', date: args.dateStr,
        supplier: supplierMi, leadId: '',
        note: '[E2E] expenses journey (mileage)', source: 'manual'
      }, supplierMi);
      const db = window.db || window._db;
      const uid = (window._auth || window.auth).currentUser.uid;
      // The expenses read rule is isOwner(resource.data.userId) — the query
      // must carry the userId filter or rules reject it as unprovable.
      async function fetchAndTag(supplier) {
        const snap = await fsMod.getDocs(fsMod.query(
          fsMod.collection(db, 'expenses'),
          fsMod.where('userId', '==', uid),
          fsMod.where('supplier', '==', supplier)
        ));
        const docs = [];
        snap.forEach(d => docs.push(Object.assign({ id: d.id }, d.data())));
        // Tag for cleanup — createExpense writes a fixed schema with no room
        // for the flag. Owner update is allowed while userId/companyId/
        // createdAt/createdBy stay frozen (didNotChange rule).
        for (const dc of docs) {
          await fsMod.updateDoc(fsMod.doc(db, 'expenses', dc.id), { e2eTestData: true });
        }
        return docs;
      }
      const mats = await fetchAndTag(supplierMat);
      const mis = await fetchAndTag(supplierMi);
      // Page-local yyyy-mm-dd of the persisted Timestamp — createExpense
      // parses form.date as LOCAL midnight, so comparing in-page avoids any
      // test-process timezone skew (and Timestamp doesn't serialize anyway).
      const ymd = (t) => {
        const d = t && typeof t.toDate === 'function' ? t.toDate() : new Date(t);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      };
      const pick = (e) => e && {
        userId: e.userId, companyId: e.companyId, createdBy: e.createdBy,
        category: e.category, costType: e.costType,
        amountCents: e.amountCents, taxCents: e.taxCents, currency: e.currency,
        leadId: e.leadId, source: e.source, needsReview: e.needsReview,
        miles: e.miles, mileageRateCents: e.mileageRateCents,
        dateYmd: e.date ? ymd(e.date) : null,
        hasCreatedAt: !!e.createdAt
      };
      return {
        uid, okMat, okMi,
        matCount: mats.length, miCount: mis.length,
        mat: pick(mats[0]), mi: pick(mis[0]),
        configRate: window.ExpenseConfig.mileageRateCents(new Date(args.dateStr + 'T00:00:00'))
      };
    }, { stamp, dateStr: DATE_STR });

    if (!out.okMat || !out.okMi) {
      const interesting = pageLog.filter(l =>
        /expenses|expense|firestore|offline|denied|ALREADY_EXISTS|failed/i.test(l)).slice(-10);
      throw new Error(`createExpense failed (materials ok=${out.okMat}, mileage ok=${out.okMi}) even after the probe-retry. Page console (filtered):\n`
        + (interesting.join('\n') || '(nothing relevant logged)'));
    }
    expect(out.matCount, 'exactly one materials expense for the unique supplier').toBe(1);
    expect(out.miCount, 'exactly one mileage expense for the unique supplier').toBe(1);

    // Money contract: amounts live as INTEGER CENTS (never float dollars) —
    // the drift-proofing rule the whole subsystem is built on.
    const mat = out.mat;
    expect(mat.amountCents, "'1234.56' → 123456 integer cents").toBe(123456);
    expect(mat.taxCents, "tax '7.89' → 789 cents").toBe(789);
    expect(mat.currency, 'currency clamped to USD').toBe('USD');
    // Category taxonomy contract: materials is a DIRECT job cost — this
    // single field is what aggregate()/jobMargin() bucket COGS on, so a
    // wrong costType silently corrupts every margin readout.
    expect(mat.category).toBe('materials');
    expect(mat.costType, "category 'materials' stamps costType 'direct'").toBe('direct');
    expect(mat.leadId, "empty job select persists leadId null (overhead-style unassigned)").toBeNull();
    expect(mat.userId, 'userId stamped').toBe(out.uid);
    expect(mat.createdBy, 'createdBy stamped').toBe(out.uid);
    expect(mat.companyId, 'companyId stamped (solo convention: uid)').toBeTruthy();
    expect(mat.source, 'manual entry recorded as manual').toBe('manual');
    expect(mat.needsReview, 'manual entry needs no OCR review').toBe(false);
    expect(mat.dateYmd, 'entry date round-trips to the same LOCAL day').toBe(DATE_STR);
    expect(mat.hasCreatedAt, 'createdAt serverTimestamp present').toBe(true);

    // Mileage contract: the amount is COMPUTED, not typed — miles × the IRS
    // business rate for the entry's tax year (2026 = 72.5¢/mi), rounded to
    // the cent, and the rate is SNAPSHOTTED on the doc so a future table
    // change can't rewrite history. costType overhead (vehicle cost, not a
    // single job's COGS).
    const mi = out.mi;
    expect(out.configRate, '2026 IRS business rate is 72.5¢/mi').toBe(72.5);
    expect(mi.mileageRateCents, 'rate snapshotted on the doc').toBe(72.5);
    expect(mi.miles, 'miles persisted').toBe(10.5);
    expect(mi.amountCents, '10.5 mi × 72.5¢ = 761 cents (rounded)').toBe(Math.round(10.5 * 72.5));
    expect(mi.costType, 'mileage is overhead, never a job cost').toBe('overhead');
  });

  test('customer page: /pro/customer?id= hydrates the lead detail surface', async ({ page }) => {
    // Same nominatim stub as the save-lead journey — _saveLead geocodes new
    // addresses and OSM rate-limits CI IPs with no client timeout.
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    await loginAs(page, creds);
    await page.waitForFunction(() => window._user && window._user.uid, null, { timeout: 15_000 });

    const stamp = Date.now();
    // Seed on the dashboard (the only surface exposing _saveLead), then
    // open the detail page. Same re-fetch-by-lastName pattern as the
    // docgen journey (_saveLead returns null on the geocoded path); the
    // read-back also hands us the address the page must render.
    const seeded = await page.evaluate(async (args) => {
      // Same in-context auth re-check as the invoice journey — _saveLead
      // stamps userId from window._user.
      for (let i = 0; i < 75 && !(window._user && window._user.uid); i++) {
        await new Promise(r => setTimeout(r, 200));
      }
      // ALREADY_EXISTS tolerance (emulator commit-retry; see fixtures/auth.js
      // addDoc patch note) — the lead landed; the re-fetch below finds it.
      try {
      await window._saveLead({
        firstName: '[E2E] Cust',
        lastName: String(args.stamp),
        // Unique per attempt so LeadDedup's blocking prompt never fires.
        address: `${String(args.stamp).slice(-3)} Customer Detail Ct, Cincinnati, OH`,
        phone: '513' + String(args.stamp).slice(-7),
        email: `e2e-cust-${args.stamp}@nbd.test`,
        stage: 'new',
        e2eTestData: true
      });
      } catch (e) { if (!/ALREADY_EXISTS/.test(String(e && e.message || e))) throw e; }
      const fsMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const db = window.db || window._db;
      // userId filter keeps the query provable under the leads read rule
      // (isOwner(resource.data.userId)) — see the save-lead journey.
      const uid = (window._auth || window.auth).currentUser.uid;
      const snap = await fsMod.getDocs(fsMod.query(
        fsMod.collection(db, 'leads'),
        fsMod.where('userId', '==', uid),
        fsMod.where('lastName', '==', String(args.stamp)),
        fsMod.where('e2eTestData', '==', true)
      ));
      let out = null;
      snap.forEach(d => { if (!out) out = { id: d.id, address: d.data().address }; });
      return out;
    }, { stamp });
    expect(seeded && seeded.id, 'seeded [E2E] Cust lead has an id').toBeTruthy();

    // Navigate to the per-lead detail surface. Console cleanliness is
    // deliberately NOT asserted: customer.html defers ~60 companion
    // modules, several of which may hit callables that connection-refuse
    // without the functions emulator. customer-bootstrap itself is
    // Firestore-only on the load path (every sub-loader — timeline/
    // photos/documents/estimates/notes — is individually try/caught and
    // non-fatal), so hydration of the header + data bridge is the signal.
    // Retries for the cold-goto race: an in-page redirect (SW
    // registration reload / auth-restore) can cancel or interrupt the
    // navigation — observed as ERR_ABORTED (CI 2026-07-05) and as
    // "interrupted by another navigation to /pro/dashboard" (the SW
    // controllerchange reload; CI 2026-07-06, where it outlived the
    // single retry). Both signatures settle within a beat — retry them,
    // rethrow anything else.
    {
      let _navved = false;
      for (let attempt = 0; attempt < 3 && !_navved; attempt++) {
        try {
          await page.goto(`/pro/customer.html?id=${seeded.id}`);
          _navved = true;
        } catch (e) {
          if (!/ERR_ABORTED|interrupted by another navigation/.test(String(e))) throw e;
          await page.waitForTimeout(1_500);
        }
      }
      if (!_navved) await page.goto(`/pro/customer.html?id=${seeded.id}`);
    }

    // Hydration: loadCustomerData writes #customerName, then the auth
    // handler flips documentElement opacity to '1'. The failure paths are
    // an auth bounce to /pro/login (onAuthStateChanged without a user) or
    // showError replacing .container ("Customer not found") — surface
    // WHICH ONE happened instead of an opaque timeout.
    const expectedName = `[E2E] Cust ${stamp}`;
    try {
      await page.waitForFunction((n) => {
        const el = document.getElementById('customerName');
        return !!el && el.textContent === n;
      }, expectedName, { timeout: 20_000 });
    } catch (e) {
      const state = await page.evaluate(() => ({
        url: location.href,
        opacity: document.documentElement.style.opacity || '(unset)',
        nameEl: (document.getElementById('customerName') || { textContent: '(el missing — showError nuked .container?)' }).textContent,
        containerText: ((document.querySelector('.container') || {}).innerText || '(no .container)').slice(0, 200),
      })).catch(() => ({ note: 'evaluate failed — page context gone (auth bounce mid-wait?)', url: page.url() }));
      throw new Error('customer page never hydrated lead ' + seeded.id + ' — ' + JSON.stringify(state));
    }

    // No auth bounce: still on the customer page, not kicked to /login.
    expect(page.url(), 'stayed on the customer detail page (no auth bounce)')
      .toMatch(/\/pro\/customer(\.html)?\?/);
    // No upgrade wall. customer.html ships no billing gate today — this
    // locks in that the detail surface stays reachable if one is added.
    await expect(page.locator('#nbd-upgrade-wall'), 'customer page must not be upgrade-walled')
      .toHaveCount(0);

    // Header contract: the seeded values render verbatim, and the boot
    // module reports hydration complete (the opacity flip happens only
    // after loadCustomerData resolves without throwing).
    await expect(page.locator('#customerName')).toHaveText(expectedName);
    await expect(page.locator('#customerAddress')).toHaveText(seeded.address);
    // The opacity flip is the LAST line of loadCustomerData — the header
    // fields above render mid-function, so a one-shot check here raced the
    // function's tail (CI 2026-07-05: name+address green, opacity still
    // '0'). Wait for it like any other async completion signal.
    await page.waitForFunction(() => document.documentElement.style.opacity === '1',
      null, { timeout: 15_000 });

    // THE contract: stage key → display label mapping plus the external-
    // module data bridge. Every companion module on this page (photo-
    // report, profit-tracker, document-generator, customer-portal) reads
    // window._leads/_currentLead instead of re-fetching — a hydration
    // regression here breaks all of them at once.
    const bridge = await page.evaluate(() => ({
      currentLeadId: (window._currentLead && window._currentLead.id) || null,
      leadsBridge: (Array.isArray(window._leads) && window._leads.length === 1 && window._leads[0].id) || null,
      customerIdOnLead: (window._currentLead && window._currentLead.customerId) || null,
      stageBadge: (document.getElementById('customerStage') || {}).textContent,
      stageClass: (document.getElementById('customerStage') || {}).className,
      customerIdBadge: (document.getElementById('customerIdDisplay') || {}).textContent,
    }));
    expect(bridge.currentLeadId, 'window._currentLead hydrated with this lead').toBe(seeded.id);
    expect(bridge.leadsBridge, 'window._leads bridge holds exactly this lead').toBe(seeded.id);
    expect(bridge.stageBadge, "stage key 'new' renders its display label").toBe('New Lead');
    expect(bridge.stageClass, 'stage badge carries the stage-keyed class').toContain('stage-new');
    // Cross-surface contract: the NBD-#### customerId minted at save time
    // (dashboard counter transaction; auto-assigned by the page itself
    // for pre-counter legacy leads) is what the detail header badges.
    expect(bridge.customerIdOnLead, 'customerId on the hydrated lead follows the canonical mint shape').toMatch(CUSTOMER_ID_RE);
    expect(bridge.customerIdBadge, 'customer ID badge renders the minted id').toBe(bridge.customerIdOnLead);
  });
});


// ───────────────────────────────────────────────────────────────
test.describe('Signup funnel — free tier reaches the dashboard @shard2', () => {
  test.beforeEach(async ({}, testInfo) => {
    // Only meaningful against the emulator: prod runs must not mint accounts.
    if (!/localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')) {
      testInfo.skip(true, 'signup journey runs in emulator mode only');
    }
  });

  test('register (no code) → onboarding skip → dashboard, unwalled, plan free', async ({ page }) => {
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

    const stamp = Date.now();
    const email = `e2e-signup-${stamp}@nbd.test`;

    await page.goto('/pro/register.html');
    await page.waitForLoadState('load');
    await page.fill('#regFirst', '[E2E] Signup');
    await page.fill('#regLast', String(stamp));
    await page.fill('#regEmail', email);
    await page.fill('#regPass', 'nbd-e2e-signup-pw-1');
    await page.fill('#regConfirm', 'nbd-e2e-signup-pw-1');
    // #regCode deliberately left blank — the free path.
    await page.check('#regTerms'); // clickwrap (2026-10-03)
    await page.click('#regBtn');

    // Free path: createUser → users/{uid} (onboarded:false) → createCompany
    // (fails silently in emulator — non-fatal by design) → onboarding.
    // A validation/auth failure writes to #regErr and never navigates —
    // surface THAT text instead of an opaque waitForURL timeout.
    try {
      await page.waitForURL(/\/pro\/onboarding(\.html)?([?#]|$)/, { timeout: 20_000 });
    } catch (e) {
      const regErr = await page.locator('#regErr').textContent().catch(() => '');
      throw new Error('register never navigated to onboarding'
        + (regErr ? ` — #regErr: "${regErr.trim()}"` : ' — #regErr empty (silent hang)'));
    }

    // The skip link is STATIC markup — visible before onboarding.js binds
    // its click delegate (inside onAuthStateChanged, after prefill), and
    // skip() also needs state.user. A too-fast click silently no-ops (the
    // openCrmView race class; this exact race failed CI 2026-07-05).
    // prefill() stamps #obEmail with the signed-in user's email right
    // around delegate binding — wait for it as the module-ready signal,
    // then retry-click until the URL actually moves.
    try {
      await page.waitForFunction((expected) => {
        const el = document.getElementById('obEmail');
        return !!el && el.value === expected;
      }, email, { timeout: 20_000 });
    } catch (e) {
      const state = await page.evaluate(() => ({
        url: location.href,
        obEmail: (document.getElementById('obEmail') || { value: '(el missing)' }).value,
        ready: document.readyState,
      })).catch(() => ({ note: 'evaluate failed (context gone?)' }));
      throw new Error('onboarding module never became ready — ' + JSON.stringify(state));
    }
    const skipBtn = page.locator('[data-action="skip"]').first();
    let onDashboard = false;
    for (let attempt = 0; attempt < 5 && !onDashboard; attempt++) {
      await skipBtn.click();
      // skip() writes onboarded:true (+ onboardingSkipped) then toDashboard().
      onDashboard = await page
        .waitForURL(/\/pro\/dashboard(\.html)?([?#]|$)/, { timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!onDashboard) {
      throw new Error('onboarding skip never handed off — stuck at ' + page.url());
    }

    // Let the auth gate fully resolve (goTo is defined by dashboard-ui after
    // the gate's onReady path un-hides the page).
    await page.waitForFunction(() => typeof window.goTo === 'function', null, { timeout: 20_000 });

    // THE regression lock: a free account (no subscriptions doc at all)
    // must NOT hit the full-screen upgrade wall — the dashboard IS the
    // free product. Before the fix this selector was present for every
    // free signup, with no continue-free path.
    await expect(page.locator('#nbd-upgrade-wall'), 'free account must not be upgrade-walled')
      .toHaveCount(0);
    // And the page must actually be visible (the gate un-hides it only on
    // the success path).
    const visible = await page.evaluate(() => document.documentElement.style.visibility !== 'hidden');
    expect(visible, 'gate un-hid the page (onReady path ran)').toBe(true);

    // Plan resolved as canonical free for a brand-new account. Bootstrap
    // sets window._userPlan ASYNCHRONOUSLY (token-claims read + a
    // 4s-timeout subscription getDoc) — round 4 read it before it landed
    // (null). Wait for it, then assert the value.
    await page.waitForFunction(() => !!window._userPlan, null, { timeout: 20_000 });
    const authState = await page.evaluate(() => ({
      plan: window._userPlan || null,
      email: (window._user && window._user.email) || null,
    }));
    expect(authState.plan, 'no subscription doc resolves to the free plan').toBe('free');
    expect(authState.email, 'dashboard session belongs to the new signup').toBe(email);

    // The free product works: navigate to the pipeline like a user.
    await page.evaluate(() => window.goTo('crm'));
    await expect(page.locator('#kanbanBoard, #view-crm .kanban-board').first())
      .toBeVisible({ timeout: 15_000 });

    // Console hygiene, with the standard emulator-mode exclusions. The
    // createCompany connection-refused IS expected here (no functions
    // emulator) and register.js handles it non-fatally.
    const hard = consoleErrors.filter(e =>
      !/Report Only|favicon|Service Worker registration|chrome-extension/i.test(e)
      && !/127\.0\.0\.1:5001|ERR_CONNECTION_REFUSED|Failed to load resource|app-?check|ReCAPTCHA|cloudfunctions\.net|CORS policy|createCompany/i.test(e)
    );
    expect(hard, 'no unexpected console errors across the funnel').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// CSP-fix regressions (2026-07-05). Every fix in PRs #847/#850
// shipped because NO journey exercised the surface: the shards were
// green while quick-add save crashed, kanban drop was inert, the nav
// customizer couldn't respond, and the theme fonts never applied
// (all victims of script-src-attr 'none' / stale selectors). These
// journeys close each blind spot so the next regression fails CI
// instead of shipping silently.
test.describe.serial('CSP-fix regressions @shard2', () => {
  let creds;
  test.beforeAll(() => {
    try { creds = requireTestUser(); }
    catch (e) { console.warn('[csp-regressions] ' + e.message); }
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });

  test('theme-font link flips to rel=stylesheet via script-loader (was a CSP-dead inline onload)', async ({ page }) => {
    await loginAs(page, creds);
    // script-loader.js flips on the link load event, with a 3s failsafe —
    // either path must land well inside this timeout.
    await page.waitForFunction(() => {
      const l = document.querySelector('link[data-nbd-font-swap]');
      return !!l && l.rel === 'stylesheet';
    }, null, { timeout: 15_000 });
  });

  test('kanban board delegation: a synthetic column drop reaches moveCard', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await page.waitForFunction(() => {
      const b = document.getElementById('kanbanBoard');
      return !!b && b.dataset.nbdDndBound === '1' && !!b.querySelector('.kcol-body');
    }, null, { timeout: 15_000 });
    // End-to-end wiring check without mutating data: spy moveCard, set the
    // drag id the real dragstart would set, dispatch a bubbling drop on a
    // column body, and confirm the board-level delegate routed it through.
    const calls = await page.evaluate(() => {
      const board = document.getElementById('kanbanBoard');
      const body = board.querySelector('.kcol-body');
      const stage = body.id.replace(/^kbody-/, '');
      const orig = window.moveCard;
      const seen = [];
      window.moveCard = (id, st) => { seen.push([id, st]); };
      try {
        window._dragId = 'e2e-synthetic-drag';
        body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true }));
      } finally {
        window.moveCard = orig;
        window._dragId = null;
      }
      return { seen, stage };
    });
    expect(calls.seen).toEqual([['e2e-synthetic-drag', calls.stage]]);
  });

  // Driven-UX foundation (2026-09-15): the kanban card's next-best-action
  // chip used to be display-only (the real action list lived only inside
  // the edit modal's Next Actions panel). Same style as the drag test
  // above — spy the registered dispatcher, synthesize a click on a chip
  // with the real markup shape, confirm the delegated click handler in
  // wireKanbanCardListeners() routes it through with the card's own
  // lead id as the explicit 3rd arg (the thing that makes this work
  // outside the edit modal at all).
  test('kanban next-action chip: a click reaches runLeadAction via __NBD_CALL_REGISTRY', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await page.waitForFunction(() => {
      const b = document.getElementById('kanbanBoard');
      return !!b && b.dataset.nbdDndBound === '1';
    }, null, { timeout: 15_000 });

    const result = await page.evaluate(() => {
      const registry = window.__NBD_CALL_REGISTRY;
      if (!registry || typeof registry.runLeadAction !== 'function') {
        return { error: 'registry.runLeadAction not found' };
      }
      if (typeof window.wireKanbanCardListeners !== 'function') {
        return { error: 'wireKanbanCardListeners not found on window' };
      }
      // wireKanbanCardListeners only ever runs on a column body that
      // renderLeads actually painted at least one card into (an empty
      // column short-circuits to a "Drop leads here" placeholder before
      // wiring anything) — the seeded tenant here carries no leads at
      // all, so this wires a container of its own rather than depending
      // on real board data. Same delegated-click function real columns
      // use; this tests the wiring, not any particular tenant's leads.
      const body = document.createElement('div');
      body.className = 'kcol-body';
      document.body.appendChild(body);
      window.wireKanbanCardListeners(body);

      // Real chip markup shape (crm-pipeline.js buildCard).
      const chip = document.createElement('span');
      chip.className = 'kc-tag kct-action-stage';
      chip.setAttribute('data-action', 'run-next-action');
      chip.setAttribute('data-id', 'e2e-synthetic-lead');
      chip.setAttribute('data-action-id', 'mark_adj_done');
      chip.setAttribute('data-action-kind', 'stage');
      chip.setAttribute('role', 'button');
      chip.setAttribute('tabindex', '0');
      body.appendChild(chip);

      const orig = registry.runLeadAction;
      const seen = [];
      registry.runLeadAction = (...args) => { seen.push(args); };
      try {
        chip.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } finally {
        registry.runLeadAction = orig;
        body.remove();
      }
      return { seen };
    });

    expect(result.error).toBeUndefined();
    expect(result.seen).toEqual([['mark_adj_done', 'stage', 'e2e-synthetic-lead']]);
  });

  // Add Lead revival (2026-07-06): the pipeline's FAB was silently dead
  // for months — setupAddLeadFab ran before goTo existed and bailed on a
  // guard, and the 2026-05-14 header cleanup had already removed the
  // inline button on the premise the FAB covered it. This locks in BOTH
  // affordances so neither can silently vanish again.
  test('pipeline add-lead: header button + FAB visible on CRM view; FAB opens the lead modal', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    // The boot-order fix polls for goTo at 100ms — the class lands right
    // after the view flip.
    await safeWaitForFunction(page, () => document.body.classList.contains('show-add-lead-fab'),
      { timeout: 15_000 });
    const vis = await safeEvaluate(page, () => {
      const fab = document.getElementById('addLeadFab');
      const hdr = document.getElementById('crmAddLeadBtn');
      return {
        fabDisplay: fab ? getComputedStyle(fab).display : 'missing',
        hdrPresent: !!hdr && hdr.dataset.fn === 'openLeadModal',
      };
    });
    expect(vis.fabDisplay, 'FAB rendered (display:flex under body.show-add-lead-fab)').toBe('flex');
    expect(vis.hdrPresent, 'header ＋ Add Lead button present and wired to openLeadModal').toBe(true);
    await safeEvaluate(page, () => document.getElementById('addLeadFab').click());
    await expect(page.locator('#leadModal'), 'FAB click opens the Add Lead modal').toHaveClass(/open/, { timeout: 5_000 });
    // fab-stack-coordinator: the open modal must hide the FAB stack
    // (leadModal is class-toggled at z-index 2000, below the FABs' 9999).
    await safeWaitForFunction(page, () => {
      const fab = document.getElementById('addLeadFab');
      return fab && fab.style.opacity === '0' && fab.style.pointerEvents === 'none';
    }, { timeout: 5_000 });
    // Close it again so later tests in the serial group see a clean view.
    await safeEvaluate(page, () => document.getElementById('leadModal').classList.remove('open'));
    await safeWaitForFunction(page, () => {
      const fab = document.getElementById('addLeadFab');
      return fab && fab.style.opacity !== '0';
    }, { timeout: 5_000 });
  });

  // 2026-09-25: _leadModalReset never cleared six fields editLead fills, so
  // dismissing an edit and opening Add Lead handed the NEXT homeowner the
  // last one's damage type, claim status, source, sub-type, policy number and
  // date of loss (reproduced at 412px before the fix). Same day, Date of Loss
  // moved out of #insuranceFieldsBlock — hidden on every non-insurance job —
  // to sit beside Damage Type, where it has to stay visible on a phone.
  test('lead modal: dismiss resets every field editLead fills; Date of Loss shows beside Damage Type on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 860 });
    await loginAs(page, creds);
    await openCrmView(page);
    await safeEvaluate(page, () => window.openLeadModal());
    await expect(page.locator('#leadModal')).toHaveClass(/open/, { timeout: 5_000 });
    // What editLead (crm-portal-bridge.js) writes for a real lead.
    const EDITED = {
      lDamageType: 'Full Exterior', lClaimStatus: 'Claim Filed', lSource: 'Referral',
      lPolicyNumber: 'POL-E2E-CARRY', lDateOfLoss: '2026-05-01',
    };
    await safeEvaluate(page, (vals) => {
      for (const [id, v] of Object.entries(vals)) document.getElementById(id).value = v;
      document.getElementById('lEditId').value = 'e2e-synthetic-lead';
    }, EDITED);
    const filled = await safeEvaluate(page, (ids) => ids.map((id) => document.getElementById(id).value), Object.keys(EDITED));
    expect(filled, 'precondition: every select accepted the edited value').toEqual(Object.values(EDITED));
    await safeEvaluate(page, () => window.closeLeadModal());
    await expect(page.locator('#leadModal')).not.toHaveClass(/open/, { timeout: 5_000 });

    await safeEvaluate(page, () => window.openLeadModal());
    await expect(page.locator('#leadModal')).toHaveClass(/open/, { timeout: 5_000 });
    const after = await safeEvaluate(page, () => Object.fromEntries(
      ['lDamageType', 'lClaimStatus', 'lSource', 'lSubType', 'lPolicyNumber', 'lDateOfLoss', 'lEditId']
        .map((id) => [id, document.getElementById(id).value])));
    expect(after, 'Add Lead after an edit opens with defaults, not the last lead').toEqual({
      lDamageType: '', lClaimStatus: 'No Claim', lSource: 'Door Knock', lSubType: '',
      lPolicyNumber: '', lDateOfLoss: '', lEditId: '',
    });

    // A cash job hides #insuranceFieldsBlock; Date of Loss must not go with it.
    await safeEvaluate(page, () => {
      const jt = document.getElementById('lJobType');
      jt.value = 'cash';
      jt.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const geo = await safeEvaluate(page, () => {
      const box = (id) => {
        const el = document.getElementById(id);
        const r = el.getBoundingClientRect();
        return { visible: !!el.offsetParent && r.width > 0, top: Math.round(r.top), right: Math.round(r.right) };
      };
      return { vw: document.documentElement.clientWidth, damage: box('lDamageType'), dol: box('lDateOfLoss') };
    });
    expect(geo.dol.visible, 'Date of Loss visible on a cash job').toBe(true);
    expect(geo.dol.top, 'Date of Loss shares the Damage Type row').toBe(geo.damage.top);
    expect(geo.dol.right, 'Date of Loss fits the phone width').toBeLessThanOrEqual(geo.vw);
    await safeEvaluate(page, () => window.closeLeadModal());
  });

  // Mobile FAB speed-dial (2026-07-06, Jo's pick): phones collapse the
  // field-tool FABs behind one ⋯ launcher. This runs the whole open /
  // dismiss / recording-guard lifecycle at a real phone viewport — the
  // interim display:none slimming shipped same-day, so without this the
  // fan-out could regress to either extreme (four-button pile-up or
  // permanently hidden tools) with every desktop test still green.
  test('mobile speed-dial: launcher fans the field tools out; dismiss is recording-safe', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await openCrmView(page);
    // Launcher is built by fab-speed-dial.js at DOM-ready; the mic FAB
    // needs MediaRecorder (present in headless Chromium).
    await safeWaitForFunction(page, () => {
      const dial = document.getElementById('nbd-fab-dial');
      const mic = document.getElementById('nbd-whisper-fab');
      return !!dial && !!mic && getComputedStyle(dial).display === 'flex';
    }, { timeout: 15_000 });
    const parked = await safeEvaluate(page, () => {
      const mic = getComputedStyle(document.getElementById('nbd-whisper-fab'));
      const lead = document.getElementById('addLeadFab');
      return {
        micOpacity: mic.opacity,
        micPointer: mic.pointerEvents,
        leadBottom: lead ? getComputedStyle(lead).bottom : 'missing',
      };
    });
    expect(parked.micOpacity, 'closed dial parks the mic faded').toBe('0');
    expect(parked.micPointer, 'parked mic is untappable').toBe('none');
    expect(parked.leadBottom, '＋ Add Lead floats above the launcher slot').toBe('138px');

    // Open: click-until-open with the class checked BEFORE clicking so
    // an already-open dial is never toggled shut (same pattern as the
    // Filters-menu test).
    await safeWaitForFunction(page, () => {
      if (document.body.classList.contains('nbd-dial-open')) return true;
      document.getElementById('nbd-fab-dial').click();
      return document.body.classList.contains('nbd-dial-open');
    }, { timeout: 10_000 });
    // Fan-out: opacity transitions over 160ms — poll to the settled state.
    await safeWaitForFunction(page, () => {
      const s = getComputedStyle(document.getElementById('nbd-whisper-fab'));
      return s.opacity === '1' && s.pointerEvents === 'auto';
    }, { timeout: 5_000 });
    const open = await safeEvaluate(page, () => ({
      expanded: document.getElementById('nbd-fab-dial').getAttribute('aria-expanded'),
      glyph: document.getElementById('nbd-fab-dial').textContent,
    }));
    expect(open.expanded, 'launcher reports expanded').toBe('true');
    expect(open.glyph, 'launcher glyph flips to close').toBe('✕');

    // Recording guard: while the mic shows ⏹ (recording), an outside
    // tap must NOT fold the dial — folding would strand a recording
    // the rep can't stop. Simulate the glyph state directly; the guard
    // reads the DOM, not the recorder.
    await safeEvaluate(page, () => {
      document.getElementById('nbd-whisper-fab').innerHTML = '⏹';
      document.body.click();
    });
    const dialState = await safeEvaluate(page, () => document.body.classList.contains('nbd-dial-open'));
    expect(dialState, 'outside tap ignored while recording').toBe(true);

    // Restore the idle glyph — now the same outside tap folds the dial
    // and the tools park again.
    await safeEvaluate(page, () => {
      document.getElementById('nbd-whisper-fab').innerHTML = '🎤';
      document.body.click();
    });
    await safeWaitForFunction(page, () => !document.body.classList.contains('nbd-dial-open'), { timeout: 5_000 });
    await safeWaitForFunction(page, () => {
      const s = getComputedStyle(document.getElementById('nbd-whisper-fab'));
      return s.opacity === '0' && s.pointerEvents === 'none';
    }, { timeout: 5_000 });
  });

  // One-row toolbar (2026-07-06): the filter pills moved into the
  // Filters dropdown; this locks the menu lifecycle + the active-count
  // badge so a collapsed filter can never silently hide leads again.
  test('pipeline one-row toolbar: Filters menu toggles a filter and badges the count', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    // Gate on the delegate's module actually executing (not just the
    // markup existing): a click during the SW-reload storm can land
    // before dashboard-ui.js binds, silently doing nothing — the exact
    // 2026-07-06 first-CI-run failure. Then click-until-open: the
    // predicate re-clicks each poll until the class appears, checking
    // BEFORE clicking so an already-open menu is never toggled shut.
    await safeWaitForFunction(page, () => typeof window.toggleCrmFiltersMenu === 'function'
      && !!document.getElementById('crmFiltersBtn'), { timeout: 15_000 });
    await safeWaitForFunction(page, () => {
      const menu = document.getElementById('crmFiltersMenu');
      if (!menu) return false;
      if (menu.classList.contains('open')) return true;
      document.getElementById('crmFiltersBtn').click();
      return menu.classList.contains('open');
    }, { timeout: 10_000 });
    // toggleNeedsAttention ships with needs-attention-filter.js (a plain
    // <script defer>, not a ScriptLoader bundle) — a click before it runs
    // silently no-ops in the toggle delegate (the 1e47f2b CI failure, one
    // step past the menu-open race). Since the Tranche 3 map-graduate slice
    // (2026-09-02) the handler is registry-only, so gate on the REGISTRY
    // entry, then click-until-active: the predicate clicks only while
    // INACTIVE so it can never toggle the filter back off.
    await safeWaitForFunction(page,
      () => !!(window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.toggleNeedsAttention === 'function'),
      { timeout: 15_000 });
    // Click-until-active with a COOLDOWN. The filter module stamps
    // .active synchronously inside its toggle, so one landed click is
    // enough — but a click during the SW storm can no-op before the
    // delegate binds, so retry at most every 1.2s. Never flap: the
    // class flips in the same tick as a landed click, so the next poll
    // stops clicking.
    await safeWaitForFunction(page, () => {
      const b = document.getElementById('needsAttentionBtn');
      const badge = document.getElementById('crmFiltersActiveBadge');
      if (b && b.classList.contains('active')
          && badge && badge.textContent === '1' && badge.style.display !== 'none') return true;
      const now = Date.now();
      if (b && !b.classList.contains('active')
          && (!window.__nbdE2eTglAt || now - window.__nbdE2eTglAt > 1200)) {
        window.__nbdE2eTglAt = now; b.click();
      }
      return false;
    }, { timeout: 15_000 });
    // Selecting a filter closes the menu (220ms delegate close)
    await safeWaitForFunction(page, () => !document.getElementById('crmFiltersMenu').classList.contains('open'), { timeout: 5_000 });
    // Toggle back off — badge empties, kanban unfiltered for later tests.
    await safeWaitForFunction(page, () => {
      const b = document.getElementById('needsAttentionBtn');
      const badge = document.getElementById('crmFiltersActiveBadge');
      if (b && !b.classList.contains('active')
          && badge && badge.style.display === 'none') return true;
      const now = Date.now();
      if (b && b.classList.contains('active')
          && (!window.__nbdE2eTglAt2 || now - window.__nbdE2eTglAt2 > 1200)) {
        window.__nbdE2eTglAt2 = now; b.click();
      }
      return false;
    }, { timeout: 15_000 });
  });

  // Lean triage list (2026-07-06): Board/List toggle over the same
  // filtered lead set; stage select rides moveCard. Spy-based like the
  // kanban drop test — no data mutated.
  test('pipeline list view: toggle renders sortable rows; stage select routes through moveCard', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await safeWaitForFunction(page, () => typeof window.crmViewList === 'function'
      && !!document.getElementById('crmListWrap'), { timeout: 15_000 });
    await safeEvaluate(page, () => window.crmViewList());
    await safeWaitForFunction(page, () => document.body.classList.contains('crm-list-mode')
      && document.querySelectorAll('#crmListWrap .crm-list-row').length > 0, { timeout: 10_000 });
    const spy = await safeEvaluate(page, () => {
      const sel = document.querySelector('#crmListWrap .cl-stage-select');
      if (!sel) return { ok: false, reason: 'no stage select' };
      const orig = window.moveCard;
      const seen = [];
      window.moveCard = (id, st) => { seen.push([id, st]); };
      try {
        const other = Array.from(sel.options).map(o => o.value).find(v => v !== sel.value);
        sel.value = other;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      } finally { window.moveCard = orig; }
      return { ok: true, seen, id: sel.dataset.id };
    });
    expect(spy.ok, 'list rendered a stage select').toBe(true);
    expect(spy.seen.length, 'stage change routed through moveCard exactly once').toBe(1);
    expect(spy.seen[0][0], 'moveCard called with the row lead id').toBe(spy.id);
    // Back to board so later serial tests see the kanban
    await safeEvaluate(page, () => window.crmViewBoard());
    await safeWaitForFunction(page, () => !document.body.classList.contains('crm-list-mode'), { timeout: 5_000 });
  });

  test('nav customizer opens and addTab responds through the delegate (no inline handlers)', async ({ page }) => {
    // Full console capture: when this journey fails in CI the modal is
    // simply absent, which means the module-tail delegate never bound —
    // i.e. init() threw somewhere after assigning window.mobileNav. The
    // console trail is the only way to see WHERE from a CI log.
    const consoleMsgs = [];
    page.on('console', m => consoleMsgs.push(m.type() + ': ' + m.text()));
    page.on('pageerror', e => consoleMsgs.push('pageerror: ' + e.message));
    await loginAs(page, creds);
    // The customizer entry points are mobile-menu / settings items; drive
    // the document-level data-mnc-action delegate directly with a temp
    // trigger — exactly the dispatch path real entry points use.
    // Readiness gate: window.mobileNav is assigned by mobile-nav-
    // customizer.js's init(), which runs strictly after the module (and
    // therefore its click delegate) loaded — clicking before that is a
    // race the first CI run won and the second lost.
    // Binary probe with one reload retry: the instrumented CI run showed
    // that on flaky attempts the delegate genuinely is not bound and the
    // console carries a resource 404 — an emulator/service-worker load
    // race, not a module bug (no pageerror). Same medicine as
    // openCrmView: retry through the unstable load once.
    let delegateBound = false;
    for (let attempt = 0; attempt < 2 && !delegateBound; attempt++) {
      if (attempt > 0) await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.mobileNav === 'function',
        null, { timeout: 20_000 }).catch(() => {});
      const marker = 'e2eDelegateProbe' + attempt;
      await page.evaluate((m) => {
        const probe = document.createElement('button');
        probe.dataset.mncAction = m;
        document.body.appendChild(probe);
        probe.click();
        probe.remove();
      }, marker);
      const t0 = Date.now();
      while (Date.now() - t0 < 10_000) {
        if (consoleMsgs.some(x => x.includes('no dispatch for ' + marker))) { delegateBound = true; break; }
        await page.waitForTimeout(250);
      }
    }
    expect(delegateBound, 'data-mnc-action delegate never answered the probe (2 loads) — '
      + 'console: ' + consoleMsgs.filter(m => /error|warn|pageerror/.test(m)).slice(-15).join(' | '))
      .toBe(true);
    // safeEvaluate: the SW controllerchange reload can strike here too
    // (rotating shard2 victim, 2026-07-06 runs) — retry on the one-shot
    // navigation instead of failing the whole serial group.
    await safeEvaluate(page, () => {
      const b = document.createElement('button');
      b.id = 'e2e-open-customizer';
      b.dataset.mncAction = 'openCustomizer';
      document.body.appendChild(b);
      b.click();
    });
    const modal = page.locator('#navCustomizeModal');
    try {
      await expect(modal).toBeVisible({ timeout: 15_000 });
    } catch (e) {
      console.log('[customizer-diag] console trail:\n' + consoleMsgs.slice(-40).join('\n'));
      throw e;
    }
    await expect(modal.locator('#ncm-slots .ncm-slot').first()).toBeVisible();
    // Click a pool item not already in the bar — the addTab delegate must
    // mark it in-bar (renderModal re-render), proving the whole
    // data-mnc-action path works with the module-scoped handlers.
    const pool = modal.locator('.ncm-pool-item:not(.in-bar)').first();
    const tabId = await pool.getAttribute('data-tab-id');
    await pool.click();
    await expect(modal.locator(`.ncm-pool-item[data-tab-id="${tabId}"].in-bar`))
      .toBeVisible({ timeout: 5_000 });
    // Close WITHOUT saving — zero persisted state, journey stays read-only.
    await modal.locator('[data-mnc-action="close"]').first().click();
    await expect(modal).toBeHidden({ timeout: 5_000 });
    await page.evaluate(() => document.getElementById('e2e-open-customizer')?.remove());
  });

  test('quick-add lead saves without throwing (was: null-selector TypeError before the write)', async ({ page }, testInfo) => {
    // Emulator storms make _saveLead crawl (ALREADY_EXISTS retry loops);
    // triple the budget rather than rotate into the flake statistics.
    testInfo.setTimeout(testInfo.timeout * 3);
    // Creates a real (untagged) lead — emulator-only so prod-mode manual
    // runs never orphan data. Emulator state evaporates with emulators:exec.
    if (!/localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')) {
      testInfo.skip(true, 'creates an untagged lead — emulator runs only');
    }
    await page.route('**/nominatim.openstreetmap.org/**', route =>
      route.fulfill({ contentType: 'application/json', body: '[]' }));
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    await loginAs(page, creds);
    await page.waitForFunction(() => typeof window.openQuickAddLead === 'function'
      && typeof window._saveLead === 'function', null, { timeout: 15_000 });
    // safeEvaluate: the SW reload can land right at the modal-open call
    // (rotating shard2 victim, 2026-07-06).
    await safeEvaluate(page, () => window.openQuickAddLead());
    const modal = page.locator('#quickAddModal');
    await expect(modal).toHaveClass(/open/, { timeout: 5_000 });
    await page.fill('#qaAddr', '123 E2E Quick Add St, Lexington, KY');
    await page.fill('#qaPhone', '8595550123');
    await page.click('#quickAddModal button[data-fn="saveQuickLead"]');
    // The old bug: btn lookup returned null and btn.textContent THREW before
    // _saveLead ran — the modal stayed open forever. Fixed = modal closes.
    await expect(modal).not.toHaveClass(/open/, { timeout: 45_000 });
    const saveErrors = consoleErrors.filter(e => /saveQuickLead|TypeError.*textContent/i.test(e));
    expect(saveErrors, 'no saveQuickLead dispatch errors').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// Mobile layout geometry (2026-07 CRM mobile pass). These assert the
// FOUR structural fixes objectively, by measuring bounding boxes at a
// real phone viewport — no eyeballing. They are the regression guard
// so the header collision, stat-bleed, card clip, and column overflow
// can't silently come back. iPhone-13 logical width = 390px.
// ─────────────────────────────────────────────────────────────
// Phase 2 foundation (2026-07): run the geometry guard at BOTH canonical
// phone widths — 390 (iPhone 13) and 480 (the canonical phone breakpoint) —
// so the eventual breakpoint consolidation is verifiable at two points, not
// one. A regression that only shows at one width can't slip through.
for (const VW of [390, 480]) {
test.describe(`CRM mobile layout geometry @${VW}px @shard1`, () => {
  test.use({ viewport: { width: VW, height: 844 } });

  let creds;
  test.beforeAll(() => {
    try { creds = requireTestUser(); }
    catch (e) { console.warn('[mobile-geometry] ' + e.message); }
  });
  test.beforeEach(async ({}, testInfo) => {
    if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  });
  // Phones default to List since 2026-09-24 (crm-list-view.js: no saved
  // choice + <=768px → list). These assertions are about the BOARD's
  // geometry, so pin Board explicitly; phone-fit.spec.js covers the default.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      try { localStorage.setItem('nbd-crm-view-mode', 'board'); } catch (_) {}
    });
  });

  // Small helper: two rects overlap iff they intersect on both axes.
  const overlaps = (a, b) =>
    a && b && a.x < b.x + b.width && a.x + a.width > b.x &&
    a.y < b.y + b.height && a.y + a.height > b.y;

  test('header: NBD square and PRO wordmark do not overlap', async ({ page }) => {
    await loginAs(page, creds);
    await page.waitForSelector('header .logo-mark', { timeout: 15_000 });
    const mark = await page.locator('header .logo-mark').boundingBox();
    const word = await page.locator('header .logo').boundingBox();
    expect(mark, 'logo mark rendered').toBeTruthy();
    expect(word, 'wordmark rendered').toBeTruthy();
    // The square must sit fully left of the wordmark with a real gap.
    expect(overlaps(mark, word),
      `logo-mark ${JSON.stringify(mark)} overlaps wordmark ${JSON.stringify(word)}`).toBe(false);
    expect(word.x, 'wordmark starts after the mark').toBeGreaterThanOrEqual(mark.x + mark.width - 0.5);
  });

  test('pipeline header: title and stat share a row without overlapping', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await page.waitForSelector('.crm-hdr-title', { timeout: 15_000 });
    const title = await page.locator('.crm-hdr-title').boundingBox();
    const stat = await page.locator('#crmSubLine').boundingBox();
    // Stat may be display:none while scrolling; only assert when both show.
    if (title && stat && stat.width > 0 && stat.height > 0) {
      expect(overlaps(title, stat),
        `title ${JSON.stringify(title)} overlaps stat ${JSON.stringify(stat)}`).toBe(false);
    }
  });

  test('kanban cards: phone row stays within its card (no bottom clip)', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await page.waitForFunction(() => {
      const b = document.getElementById('kanbanBoard');
      return b && b.querySelector('.k-card');
    }, null, { timeout: 15_000 });
    // Check every card that has a phone row: its bottom edge must sit at
    // or above the card's bottom edge (the flex-shrink:0 fix). A 1px
    // sub-pixel tolerance absorbs rounding.
    const clipped = await page.evaluate(() => {
      const bad = [];
      document.querySelectorAll('.k-card').forEach((card, i) => {
        const phone = card.querySelector('.kc-phone-row, .kc-footer');
        if (!phone) return;
        const c = card.getBoundingClientRect();
        const p = phone.getBoundingClientRect();
        if (p.bottom > c.bottom + 1) bad.push({ i, cardBottom: c.bottom, rowBottom: p.bottom });
      });
      return bad;
    });
    expect(clipped, 'no card has its phone/footer row spilling past its own bottom edge').toEqual([]);
  });

  test('kanban board: columns do not overflow the viewport width unclipped', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await page.waitForSelector('#kanbanBoard .kanban-col', { timeout: 15_000 });
    // The board must be the horizontal scroller (overflow-x:auto), so its
    // scrollWidth can exceed clientWidth — that's correct. What must NOT
    // happen: the board itself pushing the document wider than the viewport
    // (a card/column escaping its scroll container → ragged body overflow).
    const docOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(docOverflow, 'document does not scroll horizontally past the viewport').toBeLessThanOrEqual(1);
  });
  test('pipeline header: title and stat stay inside the crm-header box', async ({ page }) => {
    await loginAs(page, creds);
    await openCrmView(page);
    await page.waitForSelector('.crm-header .crm-hdr-title', { timeout: 15_000 });
    // Both the title and the stat must render WITHIN the crm-header's own
    // rectangle — neither escaping above (into the global header) nor below.
    // This is the containment guard the eventual file-merge consolidation
    // needs: move rules between files all you like, these must stay boxed.
    const box = await page.locator('.crm-header').boundingBox();
    const title = await page.locator('.crm-header .crm-hdr-title').boundingBox();
    const stat = await page.locator('#crmSubLine').boundingBox();
    expect(box, 'crm-header rendered').toBeTruthy();
    const within = (r) => !r || (r.y >= box.y - 1 && r.y + r.height <= box.y + box.height + 1);
    expect(within(title), `title ${JSON.stringify(title)} escapes crm-header ${JSON.stringify(box)}`).toBe(true);
    if (stat && stat.width > 0 && stat.height > 0) {
      expect(within(stat), `stat ${JSON.stringify(stat)} escapes crm-header ${JSON.stringify(box)}`).toBe(true);
    }
  });
});
}

// ─────────────────────────────────────────────────────────────────────
// VIEWER IS READ-ONLY (2026-09-25, Jo's decision B, final):
//   "The 'viewer' role is READ-ONLY everywhere: a viewer can read what their
//    company role allows but cannot create, update or delete any tenant data
//    — including rows under leads they own."
// The rules side is proven by the rules suites (firestore-rules.test.js 34,
// the cross-tenant suite I, storage-rules.test.js 29). This pins the CLIENT
// side, docs/pro/js/role-gate.js, in a real browser on a real viewer
// session: the write controls are not offered, a blocked control explains
// itself instead of toggling anything, and a write the rules refuse surfaces
// "Your role is view-only" instead of failing silently.
//
// The viewer is seeded through the admin SDK in a TAGGED throwaway company
// (emulator mode only; prod runs must never mint accounts) and everything
// the seed made is deleted in afterAll, by tag as well as by id.
//
// Every write this block attempts is one BOTH main's and this branch's rules
// refuse (a viewer-owner updating their own lead doc, Audit #3 F-1), so it
// behaves the same on a shared local rig whose rules are main's.
// ─────────────────────────────────────────────────────────────────────
test.describe.serial("Viewer role is read-only (Jo's decision B) @shard2", () => {
  const EMU = /localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')
    && !!process.env.FIRESTORE_EMULATOR_HOST && !!process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const TAG = 'e2e-viewer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const CO = 'co-' + TAG;
  const EMAIL = TAG + '@nbd.test';
  const PASSWORD = 'nbd-e2e-viewer-pw-1';
  const LEAD_V = 'lead-' + TAG + '-own';     // owned by the viewer
  const LEAD_T = 'lead-' + TAG + '-team';    // a teammate's, same tenant
  const EST_V = 'est-' + TAG + '-own';       // an unassigned estimate the viewer owns
  const made = [];
  let uid = null;
  let adm = null;
  const VIEW_ONLY_RE = /Your role is view-only/;

  function admin() {
    if (adm) return adm;
    const { initializeApp, getApps } = require('firebase-admin/app');
    const { getAuth } = require('firebase-admin/auth');
    const { getFirestore } = require('firebase-admin/firestore');
    if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
    adm = { auth: getAuth(), db: getFirestore() };
    return adm;
  }

  test.beforeAll(async () => {
    if (!EMU) return;
    const { auth, db } = admin();
    const u = await auth.createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: 'E2E Viewer' });
    uid = u.uid;
    await auth.setCustomUserClaims(uid, { role: 'viewer', companyId: CO });
    const put = async (p, d) => {
      made.push(p);
      await db.doc(p).set(Object.assign({ e2eTestData: true, e2eRun: TAG }, d));
    };
    await put('users/' + uid, { firstName: 'E2E', lastName: 'Viewer', email: EMAIL, onboarded: true });
    await put('subscriptions/' + CO, { plan: 'growth', status: 'active' });
    await put('companies/' + CO, { name: 'E2E Viewer Roofing', ownerId: 'owner-' + TAG, plan: 'growth', status: 'active' });
    await put('companyProfile/' + CO, { brand: { legalName: 'E2E Viewer Roofing' } });
    await put('leads/' + LEAD_V, { userId: uid, companyId: CO, firstName: 'Owned', lastName: 'ByViewer',
      stage: 'new', jobType: 'insurance', customerId: 'EVR-0001', address: '1 Viewer St' });
    await put('leads/' + LEAD_T, { userId: 'rep-' + TAG, companyId: CO, firstName: 'Team', lastName: 'Mate',
      stage: 'new', jobType: 'insurance', customerId: 'EVR-0002', address: '2 Viewer St' });
    await put('leads/' + LEAD_V + '/tasks/t1', { title: 'Call the adjuster', done: false, userId: uid });
    await put('estimates/' + EST_V, { userId: uid, companyId: CO, leadId: null, builder: 'classic',
      name: 'Viewer Owned Estimate', addr: '1 Viewer St', grandTotal: 12000, createdAt: new Date() });
  });

  test.afterAll(async () => {
    if (!EMU) return;
    const { auth, db } = admin();
    for (const p of made.slice().reverse()) await db.doc(p).delete().catch(() => {});
    // Anything else stamped with this run's tag, and what the app itself
    // writes for a signed-in user (settings, rep profile, notifications).
    for (const coll of ['leads', 'estimates', 'photos', 'notifications']) {
      const snap = await db.collection(coll).where('e2eRun', '==', TAG).get().catch(() => null);
      if (snap) for (const d of snap.docs) await d.ref.delete().catch(() => {});
    }
    if (uid) {
      for (const p of ['userSettings/' + uid, 'reps/' + uid]) await db.doc(p).delete().catch(() => {});
      const n = await db.collection('notifications').where('userId', '==', uid).get().catch(() => null);
      if (n) for (const d of n.docs) await d.ref.delete().catch(() => {});
      for (const sub of ['settings', 'preferences', 'fcmTokens']) {
        const s = await db.collection('users/' + uid + '/' + sub).get().catch(() => null);
        if (s) for (const d of s.docs) await d.ref.delete().catch(() => {});
      }
      await auth.deleteUser(uid).catch(() => {});
    }
  });

  test.beforeEach(async ({}, testInfo) => {
    if (!EMU) testInfo.skip(true, 'viewer journey seeds through the admin SDK: emulator mode only');
  });

  test('dashboard: no Add Lead, and a write the rules refuse says "view-only"', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await loginAs(page, { email: EMAIL, password: PASSWORD });
    await safeWaitForFunction(page, () => !!(window._userClaims && window._userClaims.role === 'viewer'), { timeout: 30_000 });
    await openCrmView(page);
    await page.waitForSelector('#kanbanBoard .kanban-col', { timeout: 20_000 });

    expect(await safeEvaluate(page, () => document.documentElement.classList.contains('nbd-role-viewer')),
      '<html> carries the viewer class once claims resolve').toBe(true);
    await expect(page.locator('#crmAddLeadBtn'), 'Add Lead is not offered to a viewer').toBeHidden();
    // Both of the viewer's tenant's leads are still READABLE on the board.
    await expect(page.locator('#kanbanBoard').getByText('ByViewer').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#kanbanBoard').getByText('Mate').first()).toBeVisible();

    // Layer 3, for real: the write reaches the rules, is refused, the caller
    // still sees the rejection, and the user is told why.
    const code = await safeEvaluate(page, async (leadId) => {
      try {
        await window.updateDoc(window.doc(window.db, 'leads', leadId), { stage: 'contacted' });
        return 'resolved';
      } catch (e) { return (e && e.code) || String(e); }
    }, LEAD_V);
    expect(code, 'viewer-owner lead update is refused by the rules').toBe('permission-denied');
    await expect(page.getByText(VIEW_ONLY_RE).first(), 'the refusal is explained').toBeVisible({ timeout: 5_000 });
    expect(pageErrors, 'role-gate.js and the page load without a thrown error').toEqual([]);
  });

  test('customer page: write controls hidden; a task click explains and changes nothing', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await loginAs(page, { email: EMAIL, password: PASSWORD });
    await page.goto('/pro/customer.html?id=' + encodeURIComponent(LEAD_V));
    await page.waitForFunction(() => {
      const el = document.getElementById('customerName');
      return !!el && /ByViewer/.test(el.textContent || '');
    }, null, { timeout: 45_000 });

    await expect(page.locator('#nbdReadOnlyBanner')).toContainText('Read-only');
    for (const sel of [
      '[data-action="openEditCustomerModal"]', '[data-action="openTaskModal"]', '[data-action="openUploadModal"]',
      '[data-action="openDocCreateModal"]', '[data-action="openEstimateModal"]', '[data-action="openNotesModal"]',
      '#quickNoteWrap',
    ]) {
      const loc = page.locator(sel);
      const n = await loc.count();
      for (let i = 0; i < n; i++) await expect(loc.nth(i), sel + ' is not offered to a viewer').toBeHidden();
    }
    // Read-only actions stay.
    await expect(page.locator('[data-action="exportCustomerPDF"]').first()).toBeVisible();

    // The task row stays visible (it is information) but clicking it must
    // not toggle the task: the capture guard explains instead.
    const row = page.locator('.nbd-tl-task').first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    await expect(page.getByText(VIEW_ONLY_RE).first()).toBeVisible({ timeout: 5_000 });
    await page.waitForTimeout(1_500);
    const t = await admin().db.doc('leads/' + LEAD_V + '/tasks/t1').get();
    expect(t.exists && t.data().done, 'the task is still open').toBe(false);
    expect(pageErrors, 'role-gate.js and the page load without a thrown error').toEqual([]);
  });

  // Review of #1776 (2026-09-25): the estimates-list card and the
  // EstimatePreview sheet still offered Duplicate / Rename / Assign / Delete to
  // a viewer who owns the estimate. Those write through module-local Firestore
  // functions, so the refusal surfaced as "Failed to rename" instead of the
  // view-only notice. And hiding every Templates row left "4 docs" headers
  // over empty accordions; the rows now stay, and a click explains.
  test('estimates list + Templates: no write buttons, read actions stay, a click explains', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await loginAs(page, { email: EMAIL, password: PASSWORD });
    await safeWaitForFunction(page, () => !!(window._userClaims && window._userClaims.role === 'viewer'), { timeout: 30_000 });
    await safeWaitForFunction(page, () => typeof window.goTo === 'function', { timeout: 30_000 });
    await page.evaluate(() => window.goTo('est'));
    const card = page.locator(`#estListWrap .nbd-est-card[data-id="${EST_V}"]`);
    await expect(card, 'the viewer can still read their estimate').toBeVisible({ timeout: 30_000 });
    await expect(card.locator('[data-act="open"]'), 'Edit (open to read) stays').toBeVisible();
    for (const act of ['duplicate', 'rename', 'assign', 'delete']) {
      await expect(card.locator(`.est-act-btn[data-act="${act}"]`), act + ' is not offered to a viewer').toBeHidden();
    }
    // The "➕ Unassigned" chip is state, so it stays; its click (= assign) explains.
    const chip = card.locator('.est-lead-chip.unassigned');
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByText(VIEW_ONLY_RE).first(), 'the assign click is explained').toBeVisible({ timeout: 5_000 });
    await expect(page.locator('#assign-lead-picker'), 'no lead picker opened').toHaveCount(0);

    // The preview sheet: read it, but no Attach/Assign or Copy.
    await card.locator('.est-card-main').click();
    const sheet = page.locator('[data-ep-action="close"]').first();
    await expect(sheet, 'the EstimatePreview sheet opens for reading').toBeVisible({ timeout: 10_000 });
    for (const act of ['assign', 'duplicate', 'archive']) {
      const loc = page.locator(`[data-ep-action="${act}"]`);
      const n = await loc.count();
      for (let i = 0; i < n; i++) await expect(loc.nth(i), 'preview ' + act + ' is not offered').toBeHidden();
    }
    await sheet.click();

    // Nothing was written: the estimate is unchanged and there is no copy.
    const e = await admin().db.doc('estimates/' + EST_V).get();
    expect(e.data().leadId, 'still unassigned').toBeNull();
    expect(e.data().name, 'not renamed').toBe('Viewer Owned Estimate');
    const mine = await admin().db.collection('estimates').where('userId', '==', uid).get();
    expect(mine.size, 'no duplicate was created').toBe(1);

    // Templates: the rows are listed (their headers count them); a click on
    // one explains instead of opening the generator.
    await page.evaluate(() => window.goTo('docs'));
    const row = page.locator('#view-docs .tl-doc-row[data-action="docgen"]').first();
    await expect(row, 'Templates rows stay listed for a viewer').toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => { const n = document.getElementById('nbdRoleViewOnlyNotice'); if (n) n.remove(); });
    await page.waitForTimeout(2_700);   // past role-gate's one-notice-per-burst window
    await row.click();
    await expect(page.getByText(VIEW_ONLY_RE).first(), 'the generate click is explained').toBeVisible({ timeout: 5_000 });
    expect(pageErrors, 'no thrown error on the estimates or Templates views').toEqual([]);
  });
});
