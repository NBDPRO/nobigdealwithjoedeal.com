// Fake firebase-app-check.js (Pro demo phase 2). No reCAPTCHA, no token
// exchange: the sample account never calls a server that would check one.
export class ReCaptchaEnterpriseProvider { constructor(siteKey) { this.siteKey = '(demo)'; void siteKey; } }
export class ReCaptchaV3Provider { constructor(siteKey) { this.siteKey = '(demo)'; void siteKey; } }
export class CustomProvider { constructor(opts) { this._opts = opts || {}; } }
export function initializeAppCheck(app) { return { app, __nbdDemo: true }; }
export async function getToken() { return { token: 'sample-account-no-app-check' }; }
export async function getLimitedUseToken() { return { token: 'sample-account-no-app-check' }; }
export function setTokenAutoRefreshEnabled() {}
export function onTokenChanged() { return () => {}; }
export const __nbdDemo = true;
