/**
 * tests/ds-repull-on-return-2026-11-14.test.js
 *
 * Audit 2026-11-14 #5: the cloud pull ran only at sign-in. A phone left open on today's page kept its old copy while
 * the laptop logged to the same day; the next tap on the phone saved the whole page (app.js collectPage writes every
 * field) with a newer mt, and the whole-page newest-wins merge threw the laptop's entries away.
 * Now coming back to the app (visibilitychange -> visible, pageshow) pulls and merges first, at most every 15 s,
 * never while a field is being typed in, and not offline.
 *
 * Run: node tests/ds-repull-on-return-2026-11-14.test.js
 */
'use strict';
const { boot } = require('./helpers/ds-sync-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }
const pg = (id, dk, mt, data) => ({ id, dk, suf: 1, name: '', data, kpi: {}, exercises: [], mt });

(async () => {
  console.log('\n1. the laptop logs to today while the phone sits open; the phone comes back');
  {
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_dsp_v1: [pg(1, '2026-11-14', 100, { 'l-win': 'phone' })] }, cloud: { 'users/U1/ds_pages/1': pg(1, '2026-11-14', 100, { 'l-win': 'phone' }) } });
    await h.signIn('U1');
    await h.advance(60000);
    // the laptop edits the same day
    h.cloud.set('users/U1/ds_pages/1', pg(1, '2026-11-14', 500, { 'l-win': 'phone', 'l-task': 'laptop: called Miller' }));
    const before = h.counts().refreshes;
    await h.fireDocument('visibilitychange');
    const local = h.read('nbd_dsp_v1')[0];
    ok('the phone pulled the laptop\'s entry on return', local.data['l-task'] === 'laptop: called Miller', JSON.stringify(local.data));
    ok('...and redrew the view, so the next save carries it', h.counts().refreshes > before);
    ok('...and the cloud still has it', h.cloud.get('users/U1/ds_pages/1').data['l-task'] === 'laptop: called Miller');
  }

  console.log('\n2. guards');
  {
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_dsp_v1: [pg(1, '2026-11-14', 100, {})] }, cloud: { 'users/U1/ds_pages/1': pg(1, '2026-11-14', 100, {}) } });
    await h.signIn('U1');
    h.cloud.set('users/U1/ds_pages/1', pg(1, '2026-11-14', 500, { x: 'laptop' }));
    await h.fireDocument('visibilitychange');
    ok('not again within 15 s of the last pull (a quick app switch is not a sync)', !h.read('nbd_dsp_v1')[0].data.x);
    await h.advance(20000);
    h.document.visibilityState = 'hidden';
    await h.fireDocument('visibilitychange');
    ok('going to the background does not pull', !h.read('nbd_dsp_v1')[0].data.x);
    h.document.visibilityState = 'visible';
    h.goOffline();
    await h.fireDocument('visibilitychange');
    ok('offline: no pull, nothing queued', !h.read('nbd_dsp_v1')[0].data.x && h.queued.length === 0);
    await h.goOnline(); await h.advance(20000);
    await h.fireWindow('pageshow');
    ok('control: pageshow after the gap pulls', h.read('nbd_dsp_v1')[0].data.x === 'laptop', JSON.stringify(h.read('nbd_dsp_v1')[0].data));
  }
  {
    // back to the app with the keyboard up in a field: the pull waits, but it is not dropped
    const h = boot({ storage: { nbd_last_uid: 'U1', nbd_dsp_v1: [pg(1, '2026-11-14', 100, {})] }, cloud: { 'users/U1/ds_pages/1': pg(1, '2026-11-14', 100, {}) } });
    await h.signIn('U1');
    await h.advance(60000);
    h.cloud.set('users/U1/ds_pages/1', pg(1, '2026-11-14', 500, { x: 'laptop' }));
    h.document.activeElement = { tagName: 'TEXTAREA' };
    await h.fireDocument('visibilitychange');
    ok('control: nothing is merged under a field being typed in', !h.read('nbd_dsp_v1')[0].data.x);
    h.document.activeElement = null;
    await h.advance(5000);
    ok('once the field is let go, the deferred pull still lands', h.read('nbd_dsp_v1')[0].data.x === 'laptop', JSON.stringify(h.read('nbd_dsp_v1')[0].data));
  }
  {
    // the deferred pull's retry fails (a bad moment on the network): the pull stays owed, not downgraded to a push
    const o = { storage: { nbd_last_uid: 'U1', nbd_dsp_v1: [pg(1, '2026-11-14', 100, {})] }, cloud: { 'users/U1/ds_pages/1': pg(1, '2026-11-14', 100, {}) } };
    const h = boot(o);
    await h.signIn('U1');
    await h.advance(60000);
    h.cloud.set('users/U1/ds_pages/1', pg(1, '2026-11-14', 500, { x: 'laptop' }));
    h.document.activeElement = { tagName: 'INPUT' };
    await h.fireDocument('visibilitychange');
    h.document.activeElement = null;
    o.failReads = /ds_pages$/;
    await h.advance(4000);                       // the deferred retry runs and its pull fails
    ok('control: the failed retry merged nothing', !h.read('nbd_dsp_v1')[0].data.x);
    delete o.failReads;
    await h.advance(120000);                     // the backoff retry
    ok('the next retry pulls again and the laptop entry lands', h.read('nbd_dsp_v1')[0].data.x === 'laptop', JSON.stringify(h.read('nbd_dsp_v1')[0].data));
  }
  {
    const h = boot({ storage: { nbd_last_uid: 'U1' } });
    await h.fireDocument('visibilitychange');
    ok('signed out: nothing is read or written', h.cloud.size === 0 && h.queued.length === 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
