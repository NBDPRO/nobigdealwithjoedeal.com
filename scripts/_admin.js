/**
 * scripts/_admin.js — the one firebase-admin entrypoint for scripts/.
 *
 * WHY THIS EXISTS
 * ───────────────
 * firebase-admin v14 removed the legacy namespace from the default export.
 * Everything these scripts reached for is now undefined and throws on first
 * use — not at require time, so a stale script looks fine until you run it:
 *
 *   admin.apps            admin.firestore()        admin.firestore.FieldValue
 *   admin.auth()          admin.app()              admin.firestore.Timestamp
 *   admin.credential      admin.storage()          admin.firestore.FieldPath
 *
 * Nineteen scripts had that break. They got it by copy-paste — each new script
 * cloned the init block of whichever one was open at the time, so one stale
 * pattern propagated and every fix had to be made nineteen times. Hence one
 * module: import the pieces from here and the next script inherits a working
 * pattern instead of a dead one.
 *
 * Module resolution is also centralised. scripts/ has no node_modules and
 * neither does the repo root, so a bare require('firebase-admin') from here
 * cannot resolve — it has to come from functions/. The scripts previously
 * spelled that three different ways (plain require, createRequire, and a
 * hardcoded '../functions/node_modules/firebase-admin' path); this resolves it
 * once.
 *
 * USAGE
 *   const { initAdmin, getFirestore, FieldValue } = require('./_admin');
 *   initAdmin({ projectId: PROJECT });        // ADC credential by default
 *   const db = getFirestore();
 *
 * Pass an explicit `credential` to override, or `{ credential: null }` for the
 * emulator, where ADC must not be used.
 */
'use strict';

const path = require('path');

// scripts/ and the repo root both lack node_modules, so fall back to resolving
// every entrypoint out of functions/ — one resolver, so they cannot come from
// two different installs.
let req = require;
try { require.resolve('firebase-admin'); }
catch (_) { req = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json')); }

const { initializeApp, applicationDefault, getApps, getApp } = req('firebase-admin/app');
const { getFirestore, FieldValue, FieldPath, Timestamp } = req('firebase-admin/firestore');
const { getAuth } = req('firebase-admin/auth');
const { getStorage } = req('firebase-admin/storage');

/**
 * Initialise the default app once, and return it.
 *
 * Idempotent: re-calling is a no-op rather than the "app already exists" throw
 * the old scripts each caught by string-matching the error message.
 *
 * @param {object} [opts] initializeApp options. `credential` defaults to
 *   applicationDefault(); pass `credential: null` to omit it entirely (the
 *   emulator path — seed-emulator.js must never present real credentials).
 */
function initAdmin(opts) {
  if (!getApps().length) {
    const o = Object.assign({ credential: applicationDefault() }, opts || {});
    if (o.credential === null) delete o.credential;
    initializeApp(o);
  }
  return getApp();
}

/** projectId of the initialised app, with the usual env fallbacks. */
function projectId() {
  const o = (getApps().length && getApp().options) || {};
  return o.projectId
    || process.env.GOOGLE_CLOUD_PROJECT
    || process.env.GCLOUD_PROJECT
    || '(inferred from ADC)';
}

module.exports = {
  initAdmin,
  projectId,
  // modular re-exports — import from here, never off the default export
  getApp,
  getApps,
  applicationDefault,
  getFirestore,
  FieldValue,
  FieldPath,
  Timestamp,
  getAuth,
  getStorage,
};
