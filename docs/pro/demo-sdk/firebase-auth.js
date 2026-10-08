// Fake firebase-auth.js for the browser-only sample account (Pro demo phase 2).
// One signed-in sample owner whose token carries a companyId claim. No identity
// toolkit, no secure-token refresh, no network. Real sign-in methods reject
// with an honest message: they belong to a real account.
import { ready, seedMeta, demoNotice, DEMO_UID } from './_store.js';

const _authListeners = new Set();
const _tokenListeners = new Set();

function notReal(what) {
  const e = new Error(what + ' is part of a real NBD Pro account, not the sample account.');
  e.code = 'auth/operation-not-allowed';
  e.name = 'FirebaseError';
  return e;
}

function buildUser() {
  const m = seedMeta();
  const u = m.user || {};
  const claims = Object.assign({ companyId: DEMO_UID }, m.claims || {});
  const now = Date.now();
  const user = {
    uid: u.uid || DEMO_UID,
    email: u.email || 'owner@sample-roofing.example',
    emailVerified: true,
    displayName: u.displayName || 'Sam Sample',
    photoURL: null,
    phoneNumber: null,
    isAnonymous: false,
    tenantId: null,
    providerId: 'firebase',
    providerData: [{ providerId: 'password', uid: u.email || 'owner@sample-roofing.example', email: u.email || 'owner@sample-roofing.example', displayName: u.displayName || 'Sam Sample' }],
    metadata: { creationTime: new Date(now - 90 * 864e5).toUTCString(), lastSignInTime: new Date(now).toUTCString() },
    __nbdDemo: true,
    async getIdToken() { return 'sample-account-token'; },
    async getIdTokenResult() {
      return {
        token: 'sample-account-token',
        claims: Object.assign({ user_id: user.uid, sub: user.uid, email: user.email, email_verified: true }, claims),
        authTime: new Date(now).toUTCString(),
        issuedAtTime: new Date(now).toUTCString(),
        expirationTime: new Date(now + 3600e3).toUTCString(),
        signInProvider: 'password',
        signInSecondFactor: null
      };
    },
    async reload() {},
    async delete() { throw notReal('Deleting an account'); },
    toJSON() { return { uid: user.uid, email: user.email, displayName: user.displayName }; }
  };
  return user;
}

const AUTH = {
  __nbdDemo: true,
  app: null,
  name: '[DEFAULT]',
  currentUser: null,
  languageCode: 'en',
  tenantId: null,
  settings: { appVerificationDisabledForTesting: true },
  config: { apiKey: '(sample)', authDomain: '(sample)' },
  onAuthStateChanged(next, error) { return onAuthStateChanged(AUTH, next, error); },
  onIdTokenChanged(next, error) { return onIdTokenChanged(AUTH, next, error); },
  async signOut() { return signOut(AUTH); },
  async authStateReady() { await _signedIn; },
  useDeviceLanguage() {},
  setPersistence: async () => {}
};

const _signedIn = ready().then(() => { AUTH.currentUser = buildUser(); return AUTH.currentUser; });

function fire(set, user) {
  for (const cb of Array.from(set)) { try { cb(user); } catch (e) { console.error('[demo] auth listener:', e); } }
}

export function getAuth(app) { if (app) AUTH.app = app; return AUTH; }
export function initializeAuth(app) { return getAuth(app); }
export function connectAuthEmulator() {}

export function onAuthStateChanged(_auth, next, error) {
  const cb = typeof next === 'function' ? next : (next && next.next ? (u) => next.next(u) : null);
  if (!cb) return () => {};
  _authListeners.add(cb);
  _signedIn.then(() => setTimeout(() => { if (_authListeners.has(cb)) { try { cb(AUTH.currentUser); } catch (e) { if (error) error(e); else console.error(e); } } }, 0));
  return () => _authListeners.delete(cb);
}
export function onIdTokenChanged(_auth, next) {
  const cb = typeof next === 'function' ? next : (next && next.next ? (u) => next.next(u) : null);
  if (!cb) return () => {};
  _tokenListeners.add(cb);
  _signedIn.then(() => setTimeout(() => { if (_tokenListeners.has(cb)) cb(AUTH.currentUser); }, 0));
  return () => _tokenListeners.delete(cb);
}
export function beforeAuthStateChanged() { return () => {}; }

export async function signOut() {
  await _signedIn;
  demoNotice('Signed out of the sample account.', { kind: 'signout' });
  AUTH.currentUser = null;
  fire(_authListeners, null);
  fire(_tokenListeners, null);
}

export async function setPersistence() {}
export const browserLocalPersistence = { type: 'LOCAL' };
export const browserSessionPersistence = { type: 'SESSION' };
export const inMemoryPersistence = { type: 'NONE' };
export const indexedDBLocalPersistence = { type: 'LOCAL' };
export const browserPopupRedirectResolver = {};

export class GoogleAuthProvider {
  constructor() { this.providerId = 'google.com'; this._scopes = []; }
  addScope(s) { this._scopes.push(s); return this; }
  setCustomParameters() { return this; }
  static credential() { return null; }
  static credentialFromResult() { return null; }
  static credentialFromError() { return null; }
}
export class EmailAuthProvider {
  static credential(email) { return { providerId: 'password', email }; }
}

export async function signInWithEmailAndPassword() { throw notReal('Signing in'); }
export async function createUserWithEmailAndPassword() { throw notReal('Creating a login'); }
// Arrow form on purpose: tests/google-signin-popup.test.js finds popup-auth
// CALLS by name + '(' and maps them to pages; this stub is never a popup.
export const signInWithPopup = async () => { throw notReal('Google sign-in'); };
export async function signInWithRedirect() { throw notReal('Google sign-in'); }
export async function getRedirectResult() { return null; }
export async function signInWithCustomToken() { throw notReal('Signing in'); }
export async function sendPasswordResetEmail() { throw notReal('Password reset email'); }
export async function sendEmailVerification() { throw notReal('Email verification'); }
export async function sendSignInLinkToEmail() { throw notReal('Email sign-in links'); }
export function isSignInWithEmailLink() { return false; }
export async function signInWithEmailLink() { throw notReal('Email sign-in links'); }
export async function fetchSignInMethodsForEmail() { return []; }
export async function reauthenticateWithCredential() { throw notReal('Re-authenticating'); }
export async function updatePassword() { throw notReal('Changing a password'); }
export async function updateEmail() { throw notReal('Changing a login email'); }
export async function verifyBeforeUpdateEmail() { throw notReal('Changing a login email'); }
export async function deleteUser() { throw notReal('Deleting an account'); }
export async function confirmPasswordReset() { throw notReal('Password reset'); }
export async function verifyPasswordResetCode() { throw notReal('Password reset'); }
export async function applyActionCode() { throw notReal('Email actions'); }
export async function checkActionCode() { throw notReal('Email actions'); }

// Display name / photo edits stay in this browser, like every other sample change.
export async function updateProfile(user, profile) {
  if (user && profile) {
    if ('displayName' in profile) user.displayName = profile.displayName;
    if ('photoURL' in profile) user.photoURL = profile.photoURL;
  }
}
export async function getIdToken(user) { return user ? user.getIdToken() : null; }
export async function getIdTokenResult(user) { return user ? user.getIdTokenResult() : null; }
export const __nbdDemo = true;
