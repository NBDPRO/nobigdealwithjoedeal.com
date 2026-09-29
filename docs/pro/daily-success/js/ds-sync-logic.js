/**
 * ds-sync-logic.js — the pure half of the Daily Success cloud sync.
 *
 * No DOM, no Firebase: ds-firebase-sync.js (module) and js/app.js (classic
 * script) both call into this, and tests/daily-success-sync-2026-09-29.test.js
 * drives it directly.
 *
 * What it fixes (2026-09-29, Phase 0 of the tracker revamp —
 * documentation/projects/DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md):
 *
 *   1. Deleted pages came back. The pull merged cloud pages into local ones
 *      and nothing ever told the cloud a page was deleted, so the next sign-in
 *      restored it. Deletes are now tombstones: the cloud doc is soft-deleted
 *      ({deleted:true}) and a merge drops any page the cloud or this device
 *      has tombstoned.
 *   2. The cloud copy always won. A page edited on this phone while offline
 *      was overwritten by the older cloud copy on the next load. Each page now
 *      carries `mt` (ms of its last change, stamped by stampChanged) and the
 *      newer copy wins; a tie or two unstamped copies keeps the old behaviour
 *      (cloud wins) so nothing that worked before changes.
 *   3. Every save rewrote EVERY page in one writeBatch. A batch holds at most
 *      500 writes, so after ~16 months of daily pages every sync failed, and
 *      until then each keystroke-save cost N writes. Only pages whose `mt`
 *      differs from what the cloud last saw are pushed, in chunks of 400.
 *   4. Settings (floors, bodyweight, North Star) and the goal targets lived
 *      only in `nbd_` localStorage, which purgeAccountStorage wipes on every
 *      sign-out. They now ride on userSettings/{uid} with a timestamp each, and
 *      pickSettings decides which copy is newer.
 */
(function (root) {
  'use strict';

  const CHUNK = 400;

  const idOf = (p) => String(p && p.id);
  const mtOf = (p) => (p && typeof p.mt === 'number' && isFinite(p.mt) ? p.mt : 0);
  const byDay = (a, b) => (a.dk > b.dk ? 1 : a.dk < b.dk ? -1 : 0);

  // The page as a comparable string, without the stamp itself — so stamping
  // a page does not make it look changed again.
  function snapshotOf(p) {
    const copy = Object.assign({}, p);
    delete copy.mt;
    return JSON.stringify(copy);
  }

  /**
   * Stamp `mt = now` on every page whose content differs from `snap`
   * (a Map id → snapshot string), and record the new snapshots. A page not in
   * `snap` counts as changed only if it has no stamp yet — so seeding `snap`
   * at load (seedSnapshots) and then saving stamps nothing that was untouched.
   * Returns the ids it stamped.
   */
  function stampChanged(pages, snap, now) {
    const stamped = [];
    for (const p of pages || []) {
      if (!p) continue;
      const k = idOf(p);
      const s = snapshotOf(p);
      const had = snap.has(k);
      if ((had && snap.get(k) !== s) || (!had && !mtOf(p))) {
        p.mt = now;
        stamped.push(k);
      }
      snap.set(k, s);
    }
    return stamped;
  }

  function seedSnapshots(pages, snap) {
    snap.clear();
    for (const p of pages || []) if (p) snap.set(idOf(p), snapshotOf(p));
    return snap;
  }

  /**
   * Merge local pages with the cloud's.
   *   - a cloud doc with deleted:true, or an id in `tombstones`, is dropped
   *   - same id on both sides: the higher `mt` wins; a tie goes to the cloud
   *   - one side only: kept
   * Returns { pages (sorted by day), removed: ids dropped from local,
   *           cloudDeleted: ids the cloud has tombstoned }.
   */
  // The page app.js loadPages() creates when localStorage is empty — the state
  // after every sign-out. Untouched: no name, first entry of its day, nothing
  // typed, no KPI counted.
  function isBlankAutoPage(p) {
    if (!p || p.name || (p.suf && p.suf !== 1)) return false;
    const vals = Object.values(p.data || {});
    if (vals.some((v) => v != null && String(v).trim() !== '')) return false;
    if (Object.values(p.kpi || {}).some((v) => Number(v) > 0)) return false;
    const rows = [].concat(p.exercises || [], p.objections || [], p.commissions || []);
    return !rows.some((r) => r && Object.values(r).some((v) => v != null && String(v).trim() !== ''));
  }

  function mergePages(local, cloud, tombstones) {
    const tomb = new Set((tombstones || []).map(String));
    const cloudDeleted = [];
    const map = new Map();
    const cloudIds = new Set();
    const cloudDays = new Set();
    for (const cp of cloud || []) if (cp && !cp.deleted) { cloudIds.add(idOf(cp)); cloudDays.add(cp.dk); }
    for (const p of local || []) {
      if (!p || tomb.has(idOf(p))) continue;
      // Every sign-in used to add a second, empty "today": the blank page
      // loadPages() makes for an empty device, next to the real one from the
      // cloud. A blank local-only page loses to a cloud page on the same day.
      if (!cloudIds.has(idOf(p)) && cloudDays.has(p.dk) && isBlankAutoPage(p)) continue;
      map.set(idOf(p), p);
    }
    for (const cp of cloud || []) {
      if (!cp) continue;
      const k = idOf(cp);
      if (cp.deleted) { cloudDeleted.push(k); tomb.add(k); map.delete(k); continue; }
      if (tomb.has(k)) continue;
      const lp = map.get(k);
      if (!lp || mtOf(cp) >= mtOf(lp)) map.set(k, cp);
    }
    const removed = (local || []).filter((p) => p && !map.has(idOf(p))).map(idOf);
    return { pages: [...map.values()].sort(byDay), removed, cloudDeleted };
  }

  /**
   * Pages the cloud has not seen at their current `mt`. `ledger` is a Map
   * id → mt the cloud last held (seeded from the pull, updated after a push).
   * A page with no stamp that the ledger has never seen is pushed (a brand-new
   * cloud backup); one with no stamp that the ledger already holds at 0 is not.
   */
  function changedSince(pages, ledger) {
    return (pages || []).filter((p) => {
      if (!p) return false;
      const k = idOf(p);
      return !ledger.has(k) || ledger.get(k) !== mtOf(p);
    });
  }

  function chunk(arr, size) {
    const n = Math.max(1, Math.min(size || CHUNK, 499));
    const out = [];
    for (let i = 0; i < (arr || []).length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  function parseJson(str) {
    if (str == null || str === '') return null;
    try { const v = JSON.parse(str); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
  }

  /**
   * Decide which copy of a synced setting is current.
   *   local: { value, at }   cloud: { value, at }   (at = ms, 0/absent = unknown)
   * Returns 'local' | 'cloud' | 'none'.
   *   - only one side has a value → that side
   *   - both → the newer `at`; a tie (incl. both unknown) keeps local, because
   *     it is what this device is showing right now and pushing it is harmless
   */
  function pickSettings(local, cloud) {
    const lv = local && local.value != null;
    const cv = cloud && cloud.value != null;
    if (!lv && !cv) return 'none';
    if (lv && !cv) return 'local';
    if (!lv && cv) return 'cloud';
    return (Number(cloud.at) || 0) > (Number(local.at) || 0) ? 'cloud' : 'local';
  }

  /**
   * The Home widgets read `nbd_ds_config`, a derived shape. Same transform as
   * app.js syncToWidgetKeys() and dashboard-actions.js saveDsSettings(), kept
   * here so a restored config can rebuild it without either page open.
   */
  function widgetCfgFrom(config, floors) {
    const cfg = config || {};
    const fl = floors || cfg.floors || [];
    return {
      northStar: (cfg.northStar && (cfg.northStar.target || cfg.northStar.category)) || '',
      northStarDeadline: (cfg.northStar && cfg.northStar.deadline) || '',
      floors: fl.map((f) => ({ label: f.label, target: parseFloat(f.targetValue) || 1, unit: f.unit || '' })),
      goldenGoose: cfg.goose || '',
    };
  }

  const api = { CHUNK, isBlankAutoPage, snapshotOf, stampChanged, seedSnapshots, mergePages, changedSince, chunk, parseJson, pickSettings, widgetCfgFrom, mtOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDDsSync = api;
})(typeof window !== 'undefined' ? window : null);
