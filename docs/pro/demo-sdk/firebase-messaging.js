// Fake firebase-messaging.js (Pro demo phase 2). Push notifications are a
// real-account feature; the sample account never registers for them.
export function getMessaging() { return { __nbdDemo: true }; }
export async function isSupported() { return false; }
export async function getToken() { throw Object.assign(new Error('Push notifications are available in your real account.'), { code: 'messaging/unsupported-browser' }); }
export async function deleteToken() { return true; }
export function onMessage() { return () => {}; }
export const __nbdDemo = true;
