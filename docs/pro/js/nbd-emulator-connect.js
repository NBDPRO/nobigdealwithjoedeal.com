// nbd-emulator-connect.js — local-only Firebase Emulator wiring (Audit #3).
//
// PURPOSE
//   Point the client SDK at the local Firebase Emulator Suite when — and ONLY
//   when — the page is being served from localhost. In production this module
//   is a hard no-op: `isLocalEmulatorEnv()` returns false for any hostname
//   other than localhost/127.0.0.1/[::1], so `connectEmulatorsIfLocal()`
//   returns immediately without importing or touching anything. The
//   production host is nobigdealwithjoedeal.com, so this can never fire there.
//
// WHY A SHARED HELPER
//   The CRM has ~11 independent initializeApp() sites (nbd-auth, dashboard
//   bootstrap, the per-page modules, customer.html, etc.). Each must connect
//   its OWN auth/db/functions/storage instances to the emulator before first
//   use. Centralising the host/port + the guard keeps every site honest and
//   makes "is this safe in prod?" a single-file answer.
//
// PORTS — must match the `emulators` block in firebase.json:
//   auth 9099 · firestore 8080 · functions 5001 · storage 9199
//
// SAFETY
//   - Pure localhost guard (no env var, no build step) → cannot mis-fire in prod.
//   - connect*Emulator() must run BEFORE the instance is used; callers invoke
//     this immediately after getAuth()/getFirestore()/etc.
//   - Per-instance WeakSets stop a double-connect on a REUSED instance (which
//     Firestore throws on) while still allowing a FRESH instance from another
//     initializeApp() site to connect independently.

let __NBD_EMU_LOGGED; // module-local (globals Tranche 1 — was window.*)
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];

const SDK = '/assets/vendor/firebase/12.19.0';

// Per-instance dedupe — keyed on the actual SDK object, so reused instances
// are skipped but distinct app instances each get wired.
const _connected = { auth: new WeakSet(), db: new WeakSet(), fn: new WeakSet(), st: new WeakSet() };

export function isLocalEmulatorEnv() {
  try {
    return typeof location !== 'undefined' && LOCAL_HOSTS.includes(location.hostname);
  } catch { return false; }
}

/**
 * HTTP base URL for direct (non-SDK-callable) Cloud Function fetches — the
 * createStripePaymentLink/createCheckoutSession-style endpoints that module
 * scripts hit with a plain fetch() rather than an SDK httpsCallable. Mirrors
 * connectEmulatorsIfLocal's local/prod split so a raw fetch() lands on the
 * Functions emulator instead of CORS-failing against prod's CORS_ORIGINS
 * allowlist when tested from localhost (Audit #3).
 * @returns {string} base URL with no trailing slash
 */
export function getFunctionsBase() {
  return isLocalEmulatorEnv()
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
}

/**
 * Emulator-mode App Check. No-op (returns false) off-localhost.
 *
 * Callables shipped with `enforceAppCheck: true` (createCompany, claimInvite,
 * setSiteSlug, …) reject requests with NO X-Firebase-AppCheck header even in
 * the Functions emulator — but the emulator always runs the functions runtime
 * with the `skipTokenVerification` debug feature, which unsafe-decodes the
 * token instead of verifying it (firebase-tools functionsEmulator.js
 * getEmulatorEnvs). So a well-formed, unsigned JWT is sufficient AND required.
 * The real ReCaptchaEnterpriseProvider can't mint one on localhost (no
 * reCAPTCHA origin registration), so callers use this INSTEAD of their
 * production App Check init when local. Enforcement stays ON server-side —
 * the "token present and decoded" path is exercised, only the signature
 * check is emulator-skipped.
 *
 * @param {object} app - the initialized Firebase app
 * @returns {Promise<boolean>} true if local (App Check emulator shim installed)
 */
export function emulatorAppCheckFakeToken() {
  const b64url = (obj) => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const token = [
    b64url({ alg: 'none', typ: 'JWT' }),
    // The emulator's unsafe decoder reads app_id from `sub`.
    b64url({ sub: 'nbd-emulator-app', iat: now, exp: now + 3600 }),
    b64url({ sig: 'emulator' }),
  ].join('.');
  return { token, expireTimeMillis: (now + 3600) * 1000 };
}

export async function emulatorAppCheckIfLocal(app) {
  if (!isLocalEmulatorEnv() || !app) return false;
  try {
    const { initializeAppCheck, CustomProvider } = await import(`${SDK}/firebase-app-check.js`);
    initializeAppCheck(app, {
      provider: new CustomProvider({ getToken: async () => emulatorAppCheckFakeToken() }),
      isTokenAutoRefreshEnabled: false,
    });
  } catch (e) {
    // "already initialized" on a shared app instance is harmless.
    console.warn('[nbd-emulator-connect] app-check shim warning:', e && e.message);
  }
  return true;
}

/**
 * Connect any provided SDK instances to the local emulators. No-op off-localhost.
 * @param {{auth?:object, db?:object, functions?:object, storage?:object}} svc
 * @returns {Promise<boolean>} true if running locally (whether or not any svc was passed)
 */
export async function connectEmulatorsIfLocal(svc = {}) {
  if (!isLocalEmulatorEnv()) return false;
  const { auth, db, functions, storage } = svc;
  try {
    if (auth && !_connected.auth.has(auth)) {
      const { connectAuthEmulator } = await import(`${SDK}/firebase-auth.js`);
      connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      _connected.auth.add(auth);
    }
    if (db && !_connected.db.has(db)) {
      const { connectFirestoreEmulator } = await import(`${SDK}/firebase-firestore.js`);
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      _connected.db.add(db);
    }
    if (functions && !_connected.fn.has(functions)) {
      const { connectFunctionsEmulator } = await import(`${SDK}/firebase-functions.js`);
      connectFunctionsEmulator(functions, '127.0.0.1', 5001);
      _connected.fn.add(functions);
    }
    if (storage && !_connected.st.has(storage)) {
      const { connectStorageEmulator } = await import(`${SDK}/firebase-storage.js`);
      connectStorageEmulator(storage, '127.0.0.1', 9199);
      _connected.st.add(storage);
    }
    // The app's DEFAULT functions instance too. ~20 call sites do a bare
    // `getFunctions()` later (customer-portal.js mintTokenUrl, admin-manager,
    // d2d, dashboard-api …) and pages don't pass a functions instance here, so
    // locally those callables hit PRODUCTION with an emulator token — portal
    // links, Team Manager and friends were untestable in the rig. Same SDK URL
    // everywhere (10.12.2), so this is the instance they get.
    // NOT awaited: pages top-level-await this function, and fetching the
    // functions SDK here delayed every page's own setup (pricing.html's
    // window.subscribe went missing in the public E2E). Those callables fire
    // on user actions, long after this resolves.
    const app = (auth && auth.app) || (db && db.app) || (storage && storage.app) || null;
    if (app) {
      import(`${SDK}/firebase-functions.js`).then(({ getFunctions, connectFunctionsEmulator }) => {
        const defFns = getFunctions(app);
        if (!_connected.fn.has(defFns)) {
          connectFunctionsEmulator(defFns, '127.0.0.1', 5001);
          _connected.fn.add(defFns);
        }
      }).catch((e) => console.warn('[nbd-emulator-connect] functions connect warning:', e && e.message));
    }
    if (!__NBD_EMU_LOGGED) {
      __NBD_EMU_LOGGED = true;
      console.info('[nbd-emulator-connect] LOCAL emulator mode — client wired to 127.0.0.1 (auth/firestore/functions/storage). This NEVER runs in production.');
    }
  } catch (e) {
    // "already started"/"already connected" is harmless on re-entry.
    console.warn('[nbd-emulator-connect] connect warning:', e && e.message);
  }
  return true;
}
