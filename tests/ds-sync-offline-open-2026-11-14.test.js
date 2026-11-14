/**
 * tests/ds-sync-offline-open-2026-11-14.test.js
 *
 * Audit 2026-11-14 #4. Opened with no signal, the cloud pull used getDocs(), which in Firestore 10.12.2 does not fail
 * offline: it resolves an EMPTY snapshot from the local cache (measured in a real browser with the app's vendored SDK,
 * 2026-11-14: size 0, fromCache true, 50 ms). The sync then took "the cloud has nothing", forgot what it had sent, and
 * queued EVERY local page with deleted:false, which landed when the signal came back: another device's deletes were
 * undone and its newer edits overwritten by this phone's stale copy.
 * Now: every cloud read on the sync path asks the server; offline it fails, the chip says failed, nothing is queued,
 * and the "online" retry pulls first and merges properly.
 *
 * Run: node tests/ds-sync-offline-open-2026-11-14.test.js
 */
'use strict';

const { boot } = require('./helpers/ds-sync-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }

const page = (id, dk, mt, data) => ({ id, dk, suf: 1, name: '', data: data || {}, kpi: {}, exercises: [], mt });

(async () => {
  // The phone last synced days ago. Since then the laptop deleted page 2 and edited page 1 (newer mt).
  const phonePages = [page(1, '2026-11-10', 1000, { 'l-win': 'old phone text' }), page(2, '2026-11-11', 1000, { 'l-win': 'deleted on laptop' })];
  const cloud = {
    'users/U1/ds_pages/1': page(1, '2026-11-10', 5000, { 'l-win': 'newer laptop text' }),
    'users/U1/ds_pages/2': { id: 2, deleted: true },
  };

  console.log('\n1. control: opened ONLINE, the merge keeps the newer cloud copy and the delete');
  {
    const h = boot({ storage: { nbd_dsp_v1: phonePages, nbd_last_uid: 'U1' }, cloud });
    await h.signIn('U1');
    const local = h.read('nbd_dsp_v1');
    ok('the deleted page is gone from the phone', !local.some((p) => p.id === 2), JSON.stringify(local.map((p) => p.id)));
    ok('the laptop edit won on the phone', local.find((p) => p.id === 1).data['l-win'] === 'newer laptop text');
    ok('the cloud still holds the laptop edit and the delete', h.cloud.get('users/U1/ds_pages/1').data['l-win'] === 'newer laptop text' && h.cloud.get('users/U1/ds_pages/2').deleted === true);
  }

  console.log('\n2. opened OFFLINE, then the signal comes back');
  {
    const h = boot({ storage: { nbd_dsp_v1: phonePages, nbd_last_uid: 'U1' }, cloud, offline: true });
    await h.signIn('U1');
    ok('nothing is queued for the cloud while the pull could not reach the server', h.queued.filter((w) => /ds_pages/.test(w.p)).length === 0, JSON.stringify(h.queued.map((w) => w.p)));
    ok('the chip says the sync failed (not synced)', h.chipEvents.some((e) => e.cloud === 'failed') && !h.chipEvents.some((e) => e.cloud === 'synced'), JSON.stringify(h.chipEvents.map((e) => e.cloud)));
    ok('the phone copy is left alone (nothing lost locally)', h.read('nbd_dsp_v1').length === 2);
    await h.goOnline();
    await h.advance(60000);
    ok('after the signal returns, the laptop delete is NOT undone in the cloud', h.cloud.get('users/U1/ds_pages/2').deleted === true, JSON.stringify(h.cloud.get('users/U1/ds_pages/2')));
    ok('...the laptop edit is NOT overwritten by the stale phone copy', h.cloud.get('users/U1/ds_pages/1').data['l-win'] === 'newer laptop text', JSON.stringify(h.cloud.get('users/U1/ds_pages/1').data));
    const local = h.read('nbd_dsp_v1');
    ok('...and the retry merged properly on the phone (delete applied, newer text in)', !local.some((p) => p.id === 2) && local.find((p) => p.id === 1).data['l-win'] === 'newer laptop text', JSON.stringify(local));
    ok('...and the chip ends synced', h.chipEvents.length && h.chipEvents[h.chipEvents.length - 1].cloud === 'synced', JSON.stringify(h.chipEvents.map((e) => e.cloud)));
  }

  console.log('\n3. offline: workouts and settings are not pushed blind either');
  {
    const h = boot({ storage: { nbd_dsp_v1: phonePages, nbd_last_uid: 'U1', nbd_ds_workouts: [{ id: 'w1', date: '2026-11-10', mt: 1, exercises: [] }], nbd_gt: { a: 1 }, nbd_gt_at: '1' }, cloud: Object.assign({ 'users/U1/ds_workouts/w1': { id: 'w1', date: '2026-11-10', mt: 9, exercises: [{ exId: 'x' }] }, 'userSettings/U1': { dsGoalTargets: { a: 2 }, dsGoalTargetsAt: 9 } }, cloud), offline: true });
    await h.signIn('U1');
    ok('no workout or settings write is queued from an offline open', h.queued.length === 0, JSON.stringify(h.queued.map((w) => w.p)));
    await h.goOnline(); await h.advance(60000);
    ok('the newer cloud workout and settings survive the reconnect', h.cloud.get('users/U1/ds_workouts/w1').mt === 9 && h.cloud.get('userSettings/U1').dsGoalTargets.a === 2);
  }

  console.log('\n4. a settings read that fails (online) is not reported as synced');
  {
    const h = boot({ storage: { nbd_dsp_v1: phonePages, nbd_last_uid: 'U1', nbd_gt: { a: 1 }, nbd_gt_at: '5' }, cloud, failReads: /^userSettings\// });
    await h.signIn('U1');
    ok('the chip says failed, not synced, when settings could not be read', h.chipEvents.some((e) => e.cloud === 'failed') && !h.chipEvents.some((e) => e.cloud === 'synced'), JSON.stringify(h.chipEvents.map((e) => e.cloud)));
    ok('control: the pages still synced (the settings failure is isolated)', h.read('nbd_dsp_v1').find((p) => p.id === 1).data['l-win'] === 'newer laptop text');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
