// Fake firebase-app.js for the browser-only sample account (Pro demo phase 2).
// initializeApp ignores whatever config it is handed: the demo app carries no
// project id, no API key, and is tagged __nbdDemo so anything can tell.
const _apps = new Map();

function makeApp(name) {
  return Object.freeze({
    name,
    options: Object.freeze({ projectId: 'sample-account', __nbdDemo: true }),
    automaticDataCollectionEnabled: false,
    __nbdDemo: true
  });
}

export const SDK_VERSION = '10.12.2-nbd-demo';

export function initializeApp(_config, nameOrSettings) {
  const name = typeof nameOrSettings === 'string' ? nameOrSettings
    : (nameOrSettings && nameOrSettings.name) || '[DEFAULT]';
  if (!_apps.has(name)) _apps.set(name, makeApp(name));
  return _apps.get(name);
}
export function getApp(name) {
  const n = name || '[DEFAULT]';
  if (!_apps.has(n)) _apps.set(n, makeApp(n));
  return _apps.get(n);
}
export function getApps() { return Array.from(_apps.values()); }
export async function deleteApp(app) { if (app) _apps.delete(app.name); }
export function registerVersion() {}
export function setLogLevel() {}
export function onLog() {}
export const __nbdDemo = true;
