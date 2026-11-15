/**
 * tests/ds-cloud-win-streak-2026-11-14.test.js
 *
 * Audit 2026-11-14 #6: the streaks doc the sync writes to users/{uid}/ds_meta/streaks counted "win days" from
 * l-sleep / l-workout / l-protein / l-task / l-journal, keys no page has ever had. The floors are
 * floormet-<floor id> (app.js getFloors(): Jo's own floors, or the five defaults qs1..qs5). So runWin / maxWin
 * were always 0. Now the cloud doc uses the same floors and the same 67% rule as the Dash (app.js renderDash).
 *
 * Run: node tests/ds-cloud-win-streak-2026-11-14.test.js
 */
'use strict';
const { boot } = require('./helpers/ds-sync-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) { if (cond) { console.log('  ✓ ' + label); passed++; } else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; } }
const met = (ids) => Object.fromEntries(ids.map((id) => ['floormet-' + id, '1']));
const pg = (id, dk, data) => ({ id, dk, suf: 1, name: '', data, kpi: { doors: 0 }, exercises: [], mt: 10 });

(async () => {
  console.log('\n1. default floors (qs1..qs5): 4 of 5 met is a win, 3 of 5 is not (0.6 < 0.67)');
  {
    const pages = [
      pg(1, '2026-11-10', met(['qs1', 'qs2', 'qs3', 'qs4'])),
      pg(2, '2026-11-11', met(['qs1', 'qs2', 'qs3', 'qs4', 'qs5'])),
      pg(3, '2026-11-12', met(['qs1', 'qs2', 'qs3'])),
      pg(4, '2026-11-13', met(['qs2', 'qs3', 'qs4', 'qs5'])),
    ];
    const h = boot({ storage: { nbd_dsp_v1: pages, nbd_last_uid: 'U1' } });
    await h.signIn('U1');
    const s = h.cloud.get('users/U1/ds_meta/streaks');
    ok('the streaks doc was written', !!s);
    ok('best win run is 2 (Nov 10-11)', s && s.maxWin === 2, JSON.stringify(s));
    ok('current win run is 1 (Nov 13)', s && s.runWin === 1, JSON.stringify(s));
  }

  console.log('\n2. Jo\'s own floors from nbd_user_config are the ones counted');
  {
    const cfg = { floors: [{ id: 'f-a', label: 'A' }, { id: 'f-b', label: 'B' }, { id: 'f-c', label: 'C' }] };
    const pages = [pg(1, '2026-11-12', met(['f-a', 'f-b'])), pg(2, '2026-11-13', met(['f-a', 'f-b', 'f-c']))];
    const h = boot({ storage: { nbd_dsp_v1: pages, nbd_last_uid: 'U1', nbd_user_config: cfg } });
    await h.signIn('U1');
    const s = h.cloud.get('users/U1/ds_meta/streaks');
    ok('3 of 3 custom floors is a win; 2 of 3 (0.667) is not, the same 0.67 line as the Dash', s && s.runWin === 1 && s.maxWin === 1, JSON.stringify(s));
    ok('control: the default ids do not count when custom floors are set', (() => { const h2 = boot({ storage: { nbd_dsp_v1: [pg(1, '2026-11-13', met(['qs1', 'qs2', 'qs3', 'qs4', 'qs5']))], nbd_last_uid: 'U1', nbd_user_config: cfg } }); return h2.signIn('U1').then(() => h2.cloud.get('users/U1/ds_meta/streaks').runWin === 0); })());
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
