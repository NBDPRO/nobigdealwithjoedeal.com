/**
 * tests/ds-sync-device-data-2026-11-14.test.js
 *
 * Audit 2026-11-14 #2: body measurements, saved routines, custom lifts and morning check-ins lived only in this
 * phone's localStorage. A lost or replaced phone lost them, and so did another account signing in on it (the
 * account-switch purge wipes every nbd_ key). They were also missing from "Download my data".
 * Now they sync through userSettings/{uid} like the other settings, stamped at every write, and the first sync of
 * a device that already has its own copy MERGES with the cloud instead of being replaced by it.
 *
 * Run: node tests/ds-sync-device-data-2026-11-14.test.js
 */
'use strict';
const path = require('path');
const { boot } = require('./helpers/ds-sync-harness.js');
const { makeHarness } = require('./helpers/coach-ui-harness.js');
const E = require(path.join(__dirname, '..', 'docs', 'pro', 'daily-success', 'js', 'export-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const meas = [{ date: '2026-11-10', site: 'waist', mm: 900 }];
const routines = [{ id: 'rA', name: 'Push A', split: 'push', lifts: [] }];
const custom = [{ id: 'cx_a', name: 'Sled push', pattern: 'squat', equip: 'machine' }];
const ready = { '2026-11-13': { sleep: 2, sore: 1, energy: 2 } };

(async () => {
  console.log('\n1. the phone that has them sends them to the cloud');
  {
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_ds_measurements: meas, nbd_ds_coach_routines: routines, nbd_ds_coach_custom: custom, nbd_ds_coach_ready: ready } });
    await h.signIn('U1');
    const us = h.cloud.get('userSettings/U1') || {};
    ok('measurements reach userSettings', JSON.stringify(us.dsMeasurements) === JSON.stringify(meas), JSON.stringify(us));
    ok('routines, custom lifts and check-ins reach userSettings', JSON.stringify(us.dsCoachRoutines) === JSON.stringify(routines) && JSON.stringify(us.dsCoachCustom) === JSON.stringify(custom) && JSON.stringify(us.dsCoachReady) === JSON.stringify(ready));
  }

  console.log('\n2. a new phone gets them back');
  {
    const cloud = { 'userSettings/U1': { dsMeasurements: meas, dsMeasurementsAt: 50, dsCoachRoutines: routines, dsCoachRoutinesAt: 50, dsCoachCustom: custom, dsCoachCustomAt: 50, dsCoachReady: ready, dsCoachReadyAt: 50 } };
    let reloaded = 0;
    const h = boot({ storage: { nbd_last_uid: 'U1' }, cloud, window: { dispatchEvent: (e) => { if (e.type === 'nbd-ds-settings-restored') reloaded++; return true; } } });
    await h.signIn('U1');
    ok('all four lists are restored on the phone', JSON.stringify(h.read('nbd_ds_measurements')) === JSON.stringify(meas) && JSON.stringify(h.read('nbd_ds_coach_routines')) === JSON.stringify(routines) && JSON.stringify(h.read('nbd_ds_coach_custom')) === JSON.stringify(custom) && JSON.stringify(h.read('nbd_ds_coach_ready')) === JSON.stringify(ready));
    ok('the coach is told to reload its in-memory routines and lifts', reloaded >= 1, String(reloaded));
  }

  console.log('\n3. first sync on a second phone that has its own: merged, not replaced');
  {
    const cloud = { 'userSettings/U1': { dsCoachRoutines: routines, dsCoachRoutinesAt: 50, dsMeasurements: meas, dsMeasurementsAt: 50, dsCoachReady: ready, dsCoachReadyAt: 50 } };
    const mine = [{ id: 'rB', name: 'Legs B', split: 'legs', lifts: [] }];
    const myMeas = [{ date: '2026-11-12', site: 'chest', mm: 1000 }, { date: '2026-11-10', site: 'waist', mm: 905 }];
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_ds_coach_routines: mine, nbd_ds_measurements: myMeas, nbd_ds_coach_ready: { '2026-11-14': { sleep: 1 } } }, cloud });
    await h.signIn('U1');
    const r = h.read('nbd_ds_coach_routines').map((x) => x.id).sort().join(',');
    ok('both phones\' routines are kept', r === 'rA,rB', r);
    const m = h.read('nbd_ds_measurements');
    ok('measurements union by day+site; on a clash the cloud copy wins', m.length === 2 && m.find((x) => x.site === 'waist').mm === 900, JSON.stringify(m));
    ok('check-ins union by date', Object.keys(h.read('nbd_ds_coach_ready')).sort().join(',') === '2026-11-13,2026-11-14');
    ok('...and the merged copy goes back to the cloud', (h.cloud.get('userSettings/U1').dsCoachRoutines || []).length === 2);
  }

  console.log('\n4. after that, a delete travels (newest wins, the merge is first-sync only)');
  {
    const cloud = { 'userSettings/U1': { dsCoachRoutines: routines.concat([{ id: 'rB', name: 'Legs B', split: 'legs', lifts: [] }]), dsCoachRoutinesAt: 50 } };
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_ds_coach_routines: routines, nbd_ds_coach_routines_at: '90' }, cloud });
    await h.signIn('U1');
    ok('a routine deleted here (newer stamp) stays deleted in the cloud', (h.cloud.get('userSettings/U1').dsCoachRoutines || []).map((x) => x.id).join(',') === 'rA', JSON.stringify(h.cloud.get('userSettings/U1').dsCoachRoutines));
  }

  console.log('\n4b. a settings save that races the first cloud read does not upload never-synced lists as newest');
  {
    let release; const hold = new Promise((r) => { release = r; });
    const cloud = { 'userSettings/U1': { dsMeasurements: meas, dsMeasurementsAt: 50 } };
    const old = [{ date: '2026-10-01', site: 'waist', mm: 950 }];
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_ds_measurements: old, nbd_ds_food: { favs: [] }, nbd_ds_food_at: '60' }, cloud, holdReads: hold });
    await h.signIn('U1');                                   // onAuth is waiting on the cloud read
    await h.window.NBDDsCloud.pushSettings();               // e.g. a food favourite saved meanwhile
    const racedAt = (h.cloud.get('userSettings/U1') || {}).dsMeasurementsAt;
    release(); await h.flush(); await h.advance(1000);
    const us = h.cloud.get('userSettings/U1');
    ok('the raced push did not stamp this phone\'s never-synced measurements as newest', racedAt === 50, String(racedAt));
    ok('after the read, the two copies are merged (both entries kept)', (us.dsMeasurements || []).length === 2, JSON.stringify(us.dsMeasurements));
  }

  console.log('\n5. every coach write is stamped so it syncs');
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14' });
    const stamped = [];
    h.sandbox.dsSettingsChanged = (k) => stamped.push(k);
    h.click('start'); h.click('done', { i: 0, s: 0 });
    h.click('routine-save');
    ok('saving a routine stamps it', stamped.includes('nbd_ds_coach_routines'), JSON.stringify(stamped));
    h.field('cx', 0, 0, 'Sled push', { k: 'name' }); h.click('custom-add');
    ok('adding a custom lift stamps it', stamped.includes('nbd_ds_coach_custom'), JSON.stringify(stamped));
  }

  console.log('\n5b. the coach picks up routines the sync restored');
  {
    const h = makeHarness({ storage: { nbd_ds_workouts: [] }, today: '2026-11-14', fitness: true });
    ok('control: no routines on the card yet', !/My routines/.test(h.card()));
    h.store.set('nbd_ds_coach_routines', JSON.stringify([{ id: 'rC', name: 'Cloud Push', split: 'push', lifts: [{ exId: 'bb_bench', name: 'Bench', slot: 0, sets: 3 }] }]));
    ok('control: written to storage alone, the coach still shows its old in-memory list', !/Cloud Push/.test(h.card()));
    h.fireWindow('nbd-ds-settings-restored');
    ok('after the sync says it restored settings, the card lists the restored routine', /Cloud Push/.test(h.card()), h.card().slice(0, 200));
  }

  console.log('\n6. "Download my data" includes them');
  {
    const raw = { [E.KEYS.pages]: '[]', nbd_ds_measurements: JSON.stringify(meas), nbd_ds_coach_routines: JSON.stringify(routines), nbd_ds_coach_custom: JSON.stringify(custom), nbd_ds_coach_ready: JSON.stringify(ready), nbd_ds_coach_live: JSON.stringify({ id: 'wLive', exercises: [] }) };
    const x = E.buildExport(raw, 1763100000000);
    ok('measurements, routines, custom lifts, check-ins and the live workout are in the JSON', JSON.stringify(x.measurements) === JSON.stringify(meas) && JSON.stringify(x.routines) === JSON.stringify(routines) && JSON.stringify(x.customLifts) === JSON.stringify(custom) && JSON.stringify(x.checkins) === JSON.stringify(ready) && x.liveWorkout && x.liveWorkout.id === 'wLive', Object.keys(x).join(','));
  }

  console.log('\n7. the real page: logging a measurement or a check-in stamps it');
  {
    const { chromium } = require('playwright');
    const { start } = require('./lib/demo-hosting-server.js');
    const srv = await start({ root: path.join(__dirname, '..', 'docs') });
    const browser = await chromium.launch();
    try {
      const page = await (await browser.newContext({ viewport: { width: 390, height: 760 } })).newPage();
      page.setDefaultTimeout(30000);
      await page.addInitScript(() => { localStorage.setItem('nbd-welcome-seen', '1'); localStorage.setItem('welcomeModal', 'none'); localStorage.setItem('nbd_ds_layout', 'classic'); });
      await page.goto(srv.origin + '/pro/daily-success/', { waitUntil: 'load' });
      await page.waitForFunction(() => typeof switchTo === 'function' && window.NBDMeasureUI && window.NBDCheckinUI && pages.length > 0);
      const r = await page.evaluate(() => {
        switchTo(Math.max(0, pages.findIndex((p) => p.dk === todayKey())));   // a check-in belongs to the open day page
        const btn = (attrs) => { const b = document.createElement('button'); Object.keys(attrs).forEach((k) => b.setAttribute(k, attrs[k])); document.body.appendChild(b); return b; };
        // the measurement card's own handlers: a number in #msInput, then its Log today button
        let inp = document.getElementById('msInput');
        if (!inp) { inp = document.createElement('input'); inp.id = 'msInput'; document.body.appendChild(inp); }
        inp.value = '34.5'; inp.dispatchEvent(new Event('input', { bubbles: true }));
        btn({ 'data-ms-action': 'save' }).click();
        btn({ 'data-ck-action': 'tap', 'data-k': 'sleep', 'data-v': '2' }).click();
        return { m: localStorage.getItem('nbd_ds_measurements_at'), c: localStorage.getItem('nbd_ds_coach_ready_at'), mv: localStorage.getItem('nbd_ds_measurements'), cv: localStorage.getItem('nbd_ds_coach_ready') };
      });
      ok('control: the measurement and the check-in were written', !!r.mv && !!r.cv, JSON.stringify(r));
      ok('the measurement write is stamped (nbd_ds_measurements_at)', Number(r.m) > 0, JSON.stringify(r));
      ok('the check-in write is stamped (nbd_ds_coach_ready_at)', Number(r.c) > 0, JSON.stringify(r));
    } finally { await browser.close(); if (srv.close) srv.close(); }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
