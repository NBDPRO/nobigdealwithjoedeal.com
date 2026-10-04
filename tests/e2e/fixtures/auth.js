// @ts-check
// Reusable Firebase Auth login helper for Playwright authed tests.
//
// Path A (BIG_ROCKS Rock 3): a dedicated test user lives in real
// Firebase Auth. Tests log in to the live site (or any base URL set
// via PLAYWRIGHT_BASE_URL) and exercise the post-auth surface.
//
// Required env (or GitHub Secrets in CI):
//   PLAYWRIGHT_TEST_USER_EMAIL
//   PLAYWRIGHT_TEST_USER_PASSWORD
//
// Tests should call requireTestUser() at the top of any spec that
// needs auth — it returns { email, password } or throws a skip-able
// error if either env is missing. That way the suite is safe to run
// locally without secrets (it just skips authed specs).

/**
 * @returns {{ email: string, password: string }}
 * @throws {Error} when either env var is missing — caller should
 *                 wrap the throw in test.skip() when appropriate.
 */
function requireTestUser() {
  const email    = process.env.PLAYWRIGHT_TEST_USER_EMAIL;
  const password = process.env.PLAYWRIGHT_TEST_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'PLAYWRIGHT_TEST_USER_EMAIL and PLAYWRIGHT_TEST_USER_PASSWORD must be set. ' +
      'See tests/e2e/README.md for the test-user provisioning runbook.'
    );
  }
  return { email, password };
}

/**
 * Log in via the email/password form on /pro/login.html and wait
 * for the redirect to /pro/dashboard.html to settle.
 *
 * The login page selectors are stable (audited 2026-04-25):
 *   #emailInput     — email field
 *   #passwordInput  — password field
 *   #loginBtn       — submit button
 * On success the page calls window.location.replace('/pro/dashboard.html')
 * (see docs/pro/js/pages/login.js:84,169,182,214,220).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ email: string, password: string }} creds
 */
async function loginAs(page, creds) {
  await page.goto('/pro/login.html');
  // Login.js wires the form once the Firebase SDK has loaded; wait
  // for the button to be enabled rather than time-boxing. The page
  // ships #loginBtn with the `disabled` attribute set; login.js
  // calls removeAttribute('disabled') only after the dynamic Firebase
  // imports + addEventListener('click', doLogin) lines complete, so
  // this wait now genuinely synchronises the click with handler
  // attachment instead of completing on the first paint.
  await page.waitForSelector('#loginBtn:not([disabled])', { timeout: 15_000 });
  await page.fill('#emailInput', creds.email);
  await page.fill('#passwordInput', creds.password);
  // Hosting has cleanUrls:true, so the replace('/pro/dashboard.html') the
  // login page issues gets 301'd to /pro/dashboard — match both forms or
  // this wait can never resolve (bit the emulator run on CI, 2026-07-04).
  await Promise.all([
    page.waitForURL(/\/pro\/dashboard(\.html)?([?#]|$)/, { timeout: 30_000 }),
    page.click('#loginBtn'),
  ]);

  // ── Emulator-only: absorb the Java Firestore emulator's commit-retry
  // bug. Under load the SDK retries a commit whose FIRST attempt actually
  // landed, and the emulator (unlike prod) doesn't dedupe — the retry
  // rejects with ALREADY_EXISTS naming the doc that DID get written
  // (firebase-tools long-standing issue; bit docgen/expense/d2d as a
  // rotating victim across #842-#843 CI runs, each module swallowing the
  // rejection differently). Since the write SUCCEEDED, the correct
  // handling is to return a reference to the doc the error names.
  // Patched on window.addDoc after every login (fresh page per test), so
  // every consumer of the exposed global (submitKnock, createExpense,
  // createInvoiceFromEstimate, ...) is covered in one place.
  // dashboard-bootstrap's closure-held addDoc (_saveLead/_saveEstimate)
  // can't be patched from here — those call sites in the spec tolerate
  // ALREADY_EXISTS locally and re-fetch by lastName.
  if (/localhost|127\.0\.0\.1/.test(process.env.PLAYWRIGHT_BASE_URL || '')) {
    // safeEvaluate, not page.evaluate: the SW-update controllerchange
    // reload lands RIGHT here on runs where the deploy changed cached
    // files — the single most common shard-CI failure signature
    // ("Execution context was destroyed" at this line, rotating through
    // whichever test logs in first). The reload is one-shot; retrying
    // the evaluate lands on the settled page.
    await safeEvaluate(page, () => {
      const install = () => {
        if (window.__nbdAddDocPatched || typeof window.addDoc !== 'function'
            || typeof window.doc !== 'function') return false;
        const orig = window.addDoc;
        window.addDoc = async (collRef, data) => {
          try { return await orig(collRef, data); }
          catch (e) {
            const m = /ALREADY_EXISTS[^\n]*path=\/(?:[^/]+)\/([A-Za-z0-9_-]+)/.exec(String(e && e.message || e));
            if (!m) throw e;
            return window.doc(collRef, m[1]); // the write landed at this id
          }
        };
        window.__nbdAddDocPatched = true;
        return true;
      };
      // window.addDoc is exposed asynchronously by dashboard-bootstrap —
      // poll briefly; journeys that need it also gate on it themselves.
      if (!install()) {
        let tries = 0;
        const t = setInterval(() => { if (install() || ++tries > 100) clearInterval(t); }, 100);
      }
    });
  }
}

/**
 * page.evaluate that tolerates the one-shot navigation races this rig
 * documents (SW controllerchange reload after a deploy changed cached
 * files; the login 301 hop): on "Execution context was destroyed" /
 * navigation-interrupted errors it waits for the page to settle and
 * retries, up to 5 attempts. Any other error — and the final attempt —
 * throws through untouched, so real failures still fail loudly.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Function} fn      — function to run in the page
 * @param {*} [arg]          — optional argument forwarded to fn
 */
async function safeEvaluate(page, fn, arg) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (attempt < 4
          && /Execution context was destroyed|interrupted by another navigation|navigating and changing|Target closed/i.test(msg)) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      throw e;
    }
  }
}

/**
 * waitForFunction with the same navigation-race tolerance as
 * safeEvaluate: a mid-wait SW reload destroys the polling context and
 * throws even though the predicate would be true on the settled page.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Function} fn
 * @param {{timeout?: number}} [opts]
 */
async function safeWaitForFunction(page, fn, opts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.waitForFunction(fn, null, opts || {});
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (attempt < 4
          && /Execution context was destroyed|interrupted by another navigation|navigating and changing|Target closed/i.test(msg)) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      throw e;
    }
  }
}

/**
 * Log out by clearing Firebase auth state via the SDK already
 * loaded in the page. Safer than scrubbing localStorage manually
 * because it triggers the auth-state listener to detach Firestore
 * subscriptions cleanly.
 *
 * @param {import('@playwright/test').Page} page
 */
async function logout(page) {
  await page.evaluate(() => {
    // window.auth is the Firebase Auth instance set up by nbd-auth.js.
    // Fall back to firebase.auth() if the global hasn't been set yet.
    const auth = (typeof window !== 'undefined' && window.auth)
      || (typeof window !== 'undefined' && typeof window.firebase !== 'undefined'
          ? window.firebase.auth() : null);
    return auth && typeof auth.signOut === 'function' ? auth.signOut() : null;
  });
}

/**
 * Invoke a Firebase callable Cloud Function from inside the page
 * context. Avoids needing a Node-side Firebase Admin SDK + service
 * account in CI. The page is already authed (via loginAs) and has
 * App Check tokens minting, so the callable inherits everything it
 * needs.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name - the callable's exported name
 * @param {object} [data] - request body, defaults to {}
 * @returns {Promise<any>} the .data field from the callable response
 */
async function callCallableInPage(page, name, data) {
  return page.evaluate(async ({ fnName, payload }) => {
    const m = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
    const f = m.httpsCallable(m.getFunctions(), fnName);
    const r = await f(payload || {});
    return r && r.data;
  }, { fnName: name, payload: data || {} });
}

/**
 * Convenience wrapper for the destructive-test cleanup callable.
 * Page must be authed as the e2eTestAccount user.
 *
 * @param {import('@playwright/test').Page} page
 */
async function cleanupE2EData(page) {
  return callCallableInPage(page, 'cleanupE2ETestData');
}

module.exports = {
  requireTestUser,
  loginAs,
  logout,
  callCallableInPage,
  cleanupE2EData,
  safeEvaluate,
  safeWaitForFunction
};
