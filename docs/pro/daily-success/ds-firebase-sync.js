// NBD Pro — Daily Success Firebase Sync v2.0
// Loaded at the bottom of pro/daily-success/index.html, after
// js/ds-sync-logic.js (the pure merge/chunk/settings rules — window.NBDDsSync).
//
// v2 (2026-09-29, tracker revamp Phase 0): deletes stick (tombstones), the
// newer copy of a page wins instead of the cloud always winning, only changed
// pages are pushed and in batches of ≤400 (one 500-write batch used to hold
// EVERY page, so sync died at ~16 months of pages), and the settings +
// goal targets survive sign-out on userSettings/{uid}. Why each rule is what
// it is lives in js/ds-sync-logic.js.

import { initializeApp, getApps } from '/assets/vendor/firebase/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged } from '/assets/vendor/firebase/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, getDoc, setDoc, getDocs,
  collection, writeBatch, serverTimestamp
} from '/assets/vendor/firebase/10.12.2/firebase-firestore.js';
import { connectEmulatorsIfLocal } from '/pro/js/nbd-emulator-connect.js';

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
  authDomain: "nobigdeal-pro.firebaseapp.com",
  projectId: "nobigdeal-pro",
  storageBucket: "nobigdeal-pro.firebasestorage.app",
  messagingSenderId: "717435841570",
  appId: "1:717435841570:web:c2338e11052c96fde02e7b"
};

const fbApp = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
const auth  = getAuth(fbApp);
const db    = getFirestore(fbApp);
// Localhost only (no-op in prod): this module can win the race against
// nbd-auth.js and must never send an emulator session's reads to production.
await connectEmulatorsIfLocal({ auth, db });

const STORE = 'nbd_dsp_v1';
const TOMB  = 'nbd_dsp_tomb';
// localStorage key ↔ userSettings field. `<key>_at` is the local stamp
// (app.js dsSettingsChanged); `<field>At` is the cloud one.
const SETTINGS = [
  { key: 'nbd_user_config', field: 'dsConfig' },
  { key: 'nbd_gt',          field: 'dsGoalTargets' },
  { key: 'nbd_ds_coach',    field: 'dsCoach' },        // Workout Coach: rotation / freshness / equipment
  { key: 'nbd_ds_coach_notes', field: 'dsCoachNotes' }, // Workout Coach: per-lift notes ("last time: ...")
  { key: 'nbd_ds_food',     field: 'dsFood' },         // Food card: favorites + protein / calorie targets
  { key: 'nbd_ds_reviews',  field: 'dsReviews' },      // Sunday review: weekly records + goal weight
  { key: 'nbd_ds_snapshot', field: 'dsSnapshot' },     // what the personal bots read (review-ui publish)
  { key: 'nbd_ds_eod',      field: 'dsEod' },          // end-of-day review: one short note per date
  { key: 'nbd_ds_money',    field: 'dsMoney' },        // money tab: paycheck plan (nicknames + amounts only)
];
const WKEY = 'nbd_ds_workouts'; // Workout Coach sessions (users/{uid}/ds_workouts)

let _uid = null, _syncTimer = null, _badge = null;
let _pushing = null;              // the in-flight push, so two never overlap
const _ledger = new Map();        // page id → mt the cloud last held
const DEBOUNCE = 2000;
const L = () => window.NBDDsSync;

function injectBadge() {
  if (document.getElementById('ds-sync-badge')) return;
  const b = document.createElement('div');
  b.id = 'ds-sync-badge';
  b.style.cssText = 'position:fixed;top:10px;right:16px;z-index:9999;font-family:Montserrat,sans-serif;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:20px;background:rgba(189,87,40,.12);border:1px solid rgba(189,87,40,.3);color:var(--ac-text,#E4783F);transition:opacity .4s;opacity:0;pointer-events:none;';
  document.body.appendChild(b);
  _badge = b;
}

// One hide timer, cleared on every call: a stale "Saving..." timer used to hide a
// "Sync failed" pill 0.1-0.4 s after it appeared. Errors stay up longer than
// success messages so a failed save is actually seen.
const BADGE_MS = 2400, BADGE_ERR_MS = 7000;
let _badgeTimer = null;
function showBadge(text, color, ms) {
  if (!_badge) return;
  _badge.textContent = text;
  _badge.style.color = color || 'var(--ac-text,#E4783F)';
  _badge.style.opacity = '1';
  clearTimeout(_badgeTimer);
  _badgeTimer = setTimeout(() => { _badge.style.opacity = '0'; }, ms || BADGE_MS);
}
const showError = (text) => showBadge(text, null, BADGE_ERR_MS);

const readJson = (k, fallback) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? fallback : v; } catch (_) { return fallback; } };

function computeStreaks(pages) {
  let runD = 0, runW = 0, runWin = 0, maxD = 0, maxW = 0, maxWin = 0;
  let totalDoors = 0, totalCloses = 0, totalRevenue = 0;
  const sorted = [...pages].sort((a, b) => a.dk > b.dk ? 1 : -1);
  for (const p of sorted) {
    const d = p.data || {}, kpi = p.kpi || {};
    const doors = kpi.doors || 0;
    const floors = ['l-sleep','l-workout','l-protein','l-task','l-journal'];
    const pct = floors.filter(f => d[f] === '1').length / floors.length;
    runD = doors >= 60 ? runD + 1 : 0;
    runW = d['habit-1-0'] === '1' ? runW + 1 : 0;
    runWin = pct >= 0.67 ? runWin + 1 : 0;
    if (runD > maxD) maxD = runD;
    if (runW > maxW) maxW = runW;
    if (runWin > maxWin) maxWin = runWin;
    totalDoors += doors;
    totalCloses += kpi.closes || 0;
    totalRevenue += parseFloat(d['s-revenue'] || 0) || 0;
  }
  return { runD, runW, runWin, maxD, maxW, maxWin, totalDoors, totalCloses, totalRevenue };
}

// Push the pages the cloud hasn't seen at their current `mt`, the pending
// tombstones, and the streaks doc — chunked, so no batch passes 400 writes.
async function pushToFirestore(pages) {
  if (!_uid || !L()) return;
  if (_pushing) { try { await _pushing; } catch (_) {} }
  _pushing = (async () => {
    const changed = L().changedSince(pages, _ledger);
    const tomb = readJson(TOMB, []).map(String);
    const writes = changed.map(p => ({
      ref: doc(db, 'users', _uid, 'ds_pages', String(p.id)),
      data: { ...p, _uid, _updatedAt: serverTimestamp() }, merge: true,
    }));
    // Soft delete: the doc stays (nothing is ever hard-deleted from here), it
    // just says so, and every device's merge drops it.
    for (const id of tomb) {
      writes.push({ ref: doc(db, 'users', _uid, 'ds_pages', id),
        data: { id, deleted: true, deletedAt: serverTimestamp(), _uid }, merge: true });
    }
    // NO leaderboard/{uid} write here. firestore.rules deliberately sets
    // `allow write: if false` on /leaderboard (client-inflatable stats must
    // come from an admin-SDK aggregator) — and because a writeBatch commits
    // atomically, the old leaderboard set() in the batch made EVERY signed-in
    // sync fail wholesale ("Sync failed" badge, cloud copy never written).
    // The streaks doc is the authoritative owner-side source a future Cloud
    // Function aggregator can fan into /leaderboard.
    writes.push({ ref: doc(db, 'users', _uid, 'ds_meta', 'streaks'),
      data: { ...computeStreaks(pages), _updatedAt: serverTimestamp() }, merge: false });

    for (const group of L().chunk(writes, L().CHUNK)) {
      const batch = writeBatch(db);
      for (const w of group) {
        if (w.merge) batch.set(w.ref, w.data, { merge: true });
        else batch.set(w.ref, w.data);
      }
      await batch.commit();
    }
    for (const p of changed) _ledger.set(String(p.id), L().mtOf(p));
    if (tomb.length) {
      // Keep any tombstone added while this push was in flight.
      const left = readJson(TOMB, []).map(String).filter(id => !tomb.includes(id));
      if (left.length) localStorage.setItem(TOMB, JSON.stringify(left)); else localStorage.removeItem(TOMB);
      for (const id of tomb) _ledger.delete(id);
    }
  })();
  try { await _pushing; showBadge('Synced', '#2ECC8A'); }
  finally { _pushing = null; }
}

async function pullFromFirestore() {
  if (!_uid) return null;
  try {
    const snap = await getDocs(collection(db, 'users', _uid, 'ds_pages'));
    const pages = [];
    snap.forEach(d => { const data = d.data(); delete data._uid; delete data._updatedAt; delete data.deletedAt; pages.push(data); });
    return pages;
  } catch(e) { return null; }
}

// ── settings + goal targets (userSettings/{uid}) ──────────────────────────
function localSetting(s) {
  return { value: L().parseJson(localStorage.getItem(s.key)), at: Number(localStorage.getItem(s.key + '_at')) || 0 };
}

async function pushSettings() {
  if (!_uid || !L()) return;
  const patch = {};
  for (const s of SETTINGS) {
    const loc = localSetting(s);
    if (loc.value == null) continue;
    patch[s.field] = loc.value;
    patch[s.field + 'At'] = loc.at || Date.now();
  }
  if (!Object.keys(patch).length) return;
  try { await setDoc(doc(db, 'userSettings', _uid), patch, { merge: true }); }
  catch (e) { console.warn('[ds-sync] settings push failed', e && e.code); }
}

// Returns true when a cloud copy was restored into localStorage.
async function syncSettings() {
  let cloudDoc = {};
  try { const snap = await getDoc(doc(db, 'userSettings', _uid)); cloudDoc = snap.exists() ? (snap.data() || {}) : {}; }
  catch (e) { return false; }
  let restored = false, needPush = false;
  for (const s of SETTINGS) {
    const loc = localSetting(s);
    const cv = cloudDoc[s.field];
    const cloud = { value: cv && typeof cv === 'object' ? cv : null, at: Number(cloudDoc[s.field + 'At']) || 0 };
    const which = L().pickSettings(loc, cloud);
    if (which === 'cloud') {
      localStorage.setItem(s.key, JSON.stringify(cloud.value));
      localStorage.setItem(s.key + '_at', String(cloud.at || Date.now()));
      if (s.key === 'nbd_user_config') {
        try { localStorage.setItem('nbd_ds_config', JSON.stringify(L().widgetCfgFrom(cloud.value))); } catch (_) {}
      }
      restored = true;
    } else if (which === 'local' && JSON.stringify(loc.value) !== JSON.stringify(cloud.value)) {
      needPush = true;
    }
  }
  if (needPush) await pushSettings();
  return restored;
}

// ── Workout Coach sessions (users/{uid}/ds_workouts) ─────────────────────
// Same newer-mt-wins merge as the pages (NBDCoach.mergeSessions). A session
// finished offline lives in localStorage and is pushed on the next sync.
async function syncWorkouts() {
  if (!_uid || !window.NBDCoach || !L()) return;
  const cloud = [];
  try {
    const snap = await getDocs(collection(db, 'users', _uid, 'ds_workouts'));
    snap.forEach(d => { const x = d.data(); delete x._uid; delete x._updatedAt; cloud.push(x); });
  } catch (e) { return; }
  const merged = window.NBDCoach.mergeSessions(readJson(WKEY, []), cloud);
  // A full / private-mode localStorage must not abort the cloud pushes below; the failure is rethrown at the end so the caller shows it.
  let cacheErr = null;
  try { localStorage.setItem(WKEY, JSON.stringify(merged)); } catch (e) { cacheErr = e; }
  const inCloud = new Map(cloud.map(x => [String(x.id), x]));
  const push = merged.filter(x => { const c = inCloud.get(String(x.id)); return !c || (Number(x.mt) || 0) > (Number(c.mt) || 0); });
  for (const group of L().chunk(push, L().CHUNK)) {
    const batch = writeBatch(db);
    for (const x of group) batch.set(doc(db, 'users', _uid, 'ds_workouts', String(x.id)), { ...x, _uid, _updatedAt: serverTimestamp() }, { merge: true });
    await batch.commit();
  }
  if (window.NBDCoachUI && typeof window.NBDCoachUI.refresh === 'function') window.NBDCoachUI.refresh();
  if (cacheErr) throw cacheErr;
}

async function pushWorkout(session) {
  if (!_uid || !session || !session.id) return false;
  try {
    await setDoc(doc(db, 'users', _uid, 'ds_workouts', String(session.id)), { ...session, _uid, _updatedAt: serverTimestamp() }, { merge: true });
    return true;
  } catch (e) { console.warn('[ds-sync] workout push failed', e && e.code); return false; }
}

window.NBDDsCloud = { pushSettings, pushWorkout };

function installInterceptor() {
  const orig = window.savePages;
  if (!orig) { setTimeout(installInterceptor, 500); return; }
  window.savePages = function() {
    orig.apply(this, arguments);
    if (!_uid) return;
    clearTimeout(_syncTimer);
    showBadge('Saving...');
    _syncTimer = setTimeout(() => {
      pushToFirestore(readJson(STORE, [])).catch(() => showError('Sync failed'));
    }, DEBOUNCE);
  };
}

injectBadge();

onAuthStateChanged(auth, async user => {
  if (!user) { showBadge('Offline mode'); return; }
  _uid = user.uid;
  installInterceptor();
  showBadge('Loading...');
  try {
    if (!L()) { showError('Sync error'); return; }
    // Shared phone: another account was last signed in here (the dashboard records nbd_last_uid), so its local pages, workouts, food
    // log and money plan must not be merged into THIS account's cloud. The same purge the dashboard runs on an account switch.
    // This module can win the race against nbd-auth.js, so wait (up to ~3 s) for the purge to exist. If it never does, pause the sync rather
    // than merge the other account's data: the local copy is untouched and the next load retries.
    let lastUid = null;
    try { lastUid = localStorage.getItem('nbd_last_uid'); } catch (_) { /* unreadable: treated as no record */ }
    if (L().accountSwitched(lastUid, user.uid)) {
      const canPurge = () => !!(window.NBDAuth && typeof window.NBDAuth.purgeAccountStorage === 'function');
      for (let i = 0; i < 30 && !canPurge(); i++) await new Promise((r) => setTimeout(r, 100));
      if (!canPurge()) { showBadge('Sync paused'); return; }
      try { await window.NBDAuth.purgeAccountStorage(); } catch (_) { showBadge('Sync paused'); return; }   // a rejected purge pauses the sync: nbd_last_uid is not advanced
      try { if (typeof window.loadPages === 'function') window.loadPages(); } catch (_) { /* the purge already ran; the sync below repopulates */ }
    }
    try { localStorage.setItem('nbd_last_uid', user.uid); } catch (_) { /* best-effort */ }
    const restored = await syncSettings();
    const cloud = await pullFromFirestore();
    if (cloud === null) { showError('Sync error'); return; }
    _ledger.clear();
    for (const cp of cloud) if (!cp.deleted) _ledger.set(String(cp.id), L().mtOf(cp));
    const local = readJson(STORE, []);
    const merged = L().mergePages(local, cloud, readJson(TOMB, []));
    const changedLocal = merged.removed.length || merged.pages.length !== local.length
      || merged.pages.some((p, i) => p !== local[i] && JSON.stringify(p) !== JSON.stringify(local[i]));
    if (changedLocal) {
      localStorage.setItem(STORE, JSON.stringify(merged.pages));
      if (typeof window.loadPages === 'function') window.loadPages();
    }
    if (restored && typeof window.hideBanner === 'function' && localStorage.getItem('nbd_user_config')) window.hideBanner();
    if (changedLocal || restored) {
      // The CURRENT view — forcing renderDash() here left `cur` on a page the
      // screen wasn't showing, and the next tab tap wiped that page's rows.
      if (typeof window.dsRefreshView === 'function') window.dsRefreshView();
    }
    // Isolated: a failing pages push must not skip the workout sync (or the reverse).
    let failed = false;
    try { await pushToFirestore(merged.pages); } catch (e) { failed = true; console.warn('[ds-sync] pages push failed', e && e.code); }
    try { await syncWorkouts(); } catch (e) { failed = true; console.warn('[ds-sync] workout sync failed', e && e.code); }
    if (failed) showError('Sync error');
    else showBadge(merged.pages.length + ' days loaded', '#2ECC8A');
  } catch(e) { showError('Sync error'); }
});
