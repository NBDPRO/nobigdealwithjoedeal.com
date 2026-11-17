/**
 * tests/look-sync-2026-11-17.test.js
 *
 * The theme and accent follow the account (docs/pro/daily-success/js/look-sync.js), so an installed app with its own storage
 * (iPhone) wears the look picked elsewhere; and the Workout app may wear its own theme (Jo, 2026-11-17).
 *
 * Two "phones" share one fake cloud. Each phone runs the REAL look-sync.js against its own storage and the REAL
 * ds-firebase-sync.js (tests/helpers/ds-sync-harness.js) for every sync.
 *
 *   1. A look picked before this existed reaches a fresh install, whichever phone syncs first.
 *   2. A fresh install never sends "default" over a look chosen elsewhere.
 *   3. A new pick wins by time and reaches the other phone; picking the default again travels too.
 *   4. The Workout app's own theme is a separate record: it travels, it never touches the Daily Success look, and
 *      "Same as Daily Success" travels as well.
 *   7. The Workout app's own accent rides in the same record as its own theme: an accent, 'none' (the theme's own colour) or
 *      "same as Daily Success"; it never touches the Daily Success accent, and theme and accent change independently.
 *   8. A custom theme's five colours travel with the record that names it, so a phone that never made the theme can draw it: the
 *      Workout app gets it in its device list, Daily Success also in app.js's in-memory list, before the theme is applied.
 *   5. Applying a synced look is not itself a new choice (nothing is re-stamped), and a restore that changes nothing does nothing.
 *   6. Only well-formed ids are stored or applied.
 *
 * Run: node tests/look-sync-2026-11-17.test.js
 */
'use strict';

const kit = require('./lib/src-kit');
const { boot } = require('./helpers/ds-sync-harness.js');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

let clock = 1763100000000;            // every stamp and every sync moves time forward
const tick = () => (clock += 60000);

// One phone, one page. kind 'ds' = the Daily Success page (it has nbdApplyTheme and the accent setter); 'workout' = the Workout app.
function phone(kind, storage) {
  const store = new Map(Object.entries(storage || {}));
  const calls = { applied: [], accents: [], repaints: 0, stamps: [] };
  const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
  const listeners = {};
  const win = {
    addEventListener: (n, f) => { listeners[n] = f; },
    // app.js dsSettingsChanged / workout-shell.js: stamp the key (the push is the sync's job, driven below)
    dsSettingsChanged: (k) => { store.set(k + '_at', String(tick())); calls.stamps.push(k); },
  };
  if (kind === 'ds') {
    // what app.js nbdApplyTheme and accent-ui.js set() do to storage, then tell look-sync
    win.nbdApplyTheme = (id) => { calls.applied.push(id); store.set('nbd-theme', id); store.set('nbd_pro_theme', id === 'default' ? 'nbd-original' : id); win.NBDLook.changed(); };
    win.NBDAccent = { set: (id) => { calls.accents.push(id); if (id) store.set('nbd_ds_accent', id); else store.delete('nbd_ds_accent'); win.NBDLook.changed(); } };
  } else {
    win.NBDWorkoutTheme = { apply: () => { calls.repaints++; } };
  }
  // app.js's in-memory list of custom themes (a top-level `let`, so a bare global to other scripts): only the Daily Success page has it
  const mem = kind === 'ds' ? (() => { try { return JSON.parse(store.get('nbd-customs') || '[]'); } catch (_) { return []; } })() : null;
  kit.loadInVm(['docs/pro/daily-success/js/custom-theme-logic.js', 'docs/pro/daily-success/js/look-sync.js'], Object.assign({ window: win, localStorage: ls }, mem ? { _nbd_customs: mem } : {}));
  const look = win.NBDLook;
  return {
    store, calls, look, win, mem,
    get: (k) => (store.has(k) ? store.get(k) : null),
    json: (k) => { try { return JSON.parse(store.get(k)); } catch (_) { return null; } },
    // the theme the Workout app would draw from this storage (workout-theme.js themeId, the real one)
    workoutTheme: () => {
      const w = { addEventListener: () => {} };
      kit.loadInVm(['docs/pro/daily-success/js/custom-theme-logic.js', 'docs/pro/workout/js/workout-theme.js'], { window: w, document: { documentElement: { getAttribute: () => null, setAttribute: () => {}, style: { setProperty: () => {}, removeProperty: () => {} } }, addEventListener: () => {} },
        localStorage: ls, getComputedStyle: () => ({ getPropertyValue: () => '' }) });
      return w.NBDWorkoutTheme.themeId(ls.getItem);
    },
    // one sign-in sync against the shared cloud; the page's listener runs if the sync restored anything
    sync: async (cloud) => {
      let restored = 0;
      const h = boot({ storage: Object.assign({ nbd_last_uid: 'U1' }, Object.fromEntries(store)), cloud: Object.fromEntries([...cloud].map(([k, v]) => [k, Object.assign({}, v)])), now: tick(),
        window: { dispatchEvent: (e) => { if (e && e.type === 'nbd-ds-settings-restored') restored++; return true; } } });
      await h.signIn('U1');
      await h.flush();
      store.clear(); h.store.forEach((v, k) => store.set(k, v));
      cloud.clear(); h.cloud.forEach((v, k) => cloud.set(k, v));
      if (restored && listeners['nbd-ds-settings-restored']) listeners['nbd-ds-settings-restored']();
      return restored;
    },
  };
}
const settings = (cloud) => cloud.get('userSettings/U1') || {};

(async () => {
  console.log('\n1. A look picked before this existed reaches a fresh install');
  {
    const cloud = new Map();
    const android = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean', nbd_ds_accent: 'teal' });
    ok('the phone that has a look records it on load, without a stamp', JSON.stringify(android.json('nbd_ds_look')) === '{"theme":"ocean","accent":"teal"}' && android.get('nbd_ds_look_at') === null);
    await android.sync(cloud);
    ok('its first sync sends it', JSON.stringify(settings(cloud).dsLook) === '{"theme":"ocean","accent":"teal"}' && settings(cloud).dsLookAt > 0, JSON.stringify(settings(cloud)));
    const iphone = phone('workout', {});
    ok('a fresh install records nothing', iphone.get('nbd_ds_look') === null && iphone.get('nbd_wk_look') === null);
    await iphone.sync(cloud);
    ok('the fresh Workout app receives the look and repaints', iphone.get('nbd-theme') === 'ocean' && iphone.get('nbd_pro_theme') === 'ocean' && iphone.get('nbd_ds_accent') === 'teal' && iphone.calls.repaints === 1);
    ok('and draws it', iphone.workoutTheme() === 'ocean');
    const ds2 = phone('ds', {});
    await ds2.sync(cloud);
    ok('a fresh Daily Success install applies it through its own theme and accent functions', ds2.calls.applied.join() === 'ocean' && ds2.calls.accents.join() === 'teal');
    ok('applying a synced look is not a new choice: nothing is re-stamped', ds2.calls.stamps.length === 0 && iphone.calls.stamps.length === 0);
  }

  console.log('\n2. A fresh install never sends "default" over a look chosen elsewhere');
  {
    const cloud = new Map();
    const iphone = phone('workout', {});
    await iphone.sync(cloud);                                    // the fresh phone happens to sync FIRST
    ok('the fresh phone sends no look at all', settings(cloud).dsLook === undefined && settings(cloud).dsWkLook === undefined, JSON.stringify(settings(cloud)));
    const android = phone('ds', { 'nbd-theme': 'forest', nbd_pro_theme: 'forest' });
    await android.sync(cloud);
    ok('the phone with the look keeps it and sends it', android.get('nbd-theme') === 'forest' && settings(cloud).dsLook.theme === 'forest');
    await iphone.sync(cloud);
    ok('and the fresh phone picks it up on its next sync', iphone.get('nbd-theme') === 'forest' && iphone.workoutTheme() === 'forest');
  }
  {
    const cloud = new Map();
    const a = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean' });
    await a.sync(cloud);
    // a second phone whose only "choice" is the default it shipped with, and whose user then picks a Workout-only theme
    const b = phone('workout', {});
    b.store.set('nbd_wk_theme', 'midnight'); b.look.changed();
    ok('a Workout-only pick on a phone with no Daily Success look says nothing about that look', b.get('nbd_ds_look') === null && b.calls.stamps.join() === 'nbd_wk_look');
    await b.sync(cloud);
    ok('so the look chosen elsewhere is still there', settings(cloud).dsLook.theme === 'ocean' && settings(cloud).dsWkLook.theme === 'midnight', JSON.stringify(settings(cloud)));
  }

  console.log('\n3. A new pick wins by time');
  {
    const cloud = new Map();
    const a = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean' });
    const b = phone('ds', {});
    await a.sync(cloud); await b.sync(cloud);
    b.win.nbdApplyTheme('ember');                                // picked on phone B
    ok('a pick is recorded and stamped', b.json('nbd_ds_look').theme === 'ember' && Number(b.get('nbd_ds_look_at')) > 0 && b.calls.stamps.join() === 'nbd_ds_look');
    await b.sync(cloud); await a.sync(cloud);
    ok('and reaches the other phone', a.get('nbd-theme') === 'ember' && a.calls.applied.join() === 'ember');
    a.win.NBDAccent.set('plum');
    await a.sync(cloud); await b.sync(cloud);
    ok('an accent pick travels the same way', b.get('nbd_ds_accent') === 'plum' && b.json('nbd_ds_look').accent === 'plum');
    b.win.nbdApplyTheme('default'); b.win.NBDAccent.set('');
    await b.sync(cloud); await a.sync(cloud);
    ok('going back to the default theme with no accent travels too', a.get('nbd-theme') === 'default' && a.get('nbd_ds_accent') === null && JSON.stringify(settings(cloud).dsLook) === '{"theme":"default","accent":null}', JSON.stringify(settings(cloud).dsLook));
    // an older choice on a phone that was offline loses to the newer one
    const stale = phone('ds', { 'nbd-theme': 'terminal', nbd_pro_theme: 'terminal', nbd_ds_look: '{"theme":"terminal","accent":null}', nbd_ds_look_at: '1000' });
    await stale.sync(cloud);
    ok('an older stamped choice loses to the newer one in the cloud', stale.get('nbd-theme') === 'default' && settings(cloud).dsLook.theme === 'default');
  }

  console.log('\n4. The Workout app\'s own theme');
  {
    const cloud = new Map();
    const a = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean' });
    await a.sync(cloud);
    const w = phone('workout', {});
    await w.sync(cloud);
    ok('with no theme of its own it follows Daily Success', w.workoutTheme() === 'ocean');
    w.store.set('nbd_wk_theme', 'midnight'); w.look.changed();   // workout-theme.js setOwn('midnight')
    ok('its own theme wins on that phone', w.workoutTheme() === 'midnight' && w.json('nbd_wk_look').theme === 'midnight');
    ok('and the Daily Success look is not touched', w.json('nbd_ds_look').theme === 'ocean' && w.calls.stamps.join() === 'nbd_wk_look');
    await w.sync(cloud); await a.sync(cloud);
    ok('it travels as its own record', settings(cloud).dsWkLook.theme === 'midnight' && settings(cloud).dsLook.theme === 'ocean');
    ok('a Daily Success page that receives it keeps its own theme and only stores the Workout one', a.get('nbd_wk_theme') === 'midnight' && a.get('nbd-theme') === 'ocean' && a.calls.applied.length === 0);
    ok('so a Workout app sharing that phone\'s storage wears it', a.workoutTheme() === 'midnight');
    a.win.nbdApplyTheme('forest');
    await a.sync(cloud); await w.sync(cloud);
    ok('a later Daily Success pick does not undo the Workout app\'s own theme', w.workoutTheme() === 'midnight' && w.get('nbd-theme') === 'forest');
    w.store.delete('nbd_wk_theme'); w.look.changed();            // setOwn(''): "Same as Daily Success"
    ok('"Same as Daily Success" is recorded as such', w.json('nbd_wk_look').theme === '' && w.workoutTheme() === 'forest');
    await w.sync(cloud); await a.sync(cloud);
    ok('and travels: the other phone drops the Workout theme too', a.get('nbd_wk_theme') === null && a.workoutTheme() === 'forest', String(a.get('nbd_wk_theme')));
  }

  console.log('\n5. Nothing happens without a reason');
  {
    const p = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean', nbd_ds_look: '{"theme":"ocean","accent":null}', nbd_ds_look_at: '5' });
    ok('a restore that would change nothing does nothing', p.look.restore() === false && p.calls.applied.length === 0);
    ok('a "change" to the look already recorded is not stamped again', p.look.changed() === false && p.get('nbd_ds_look_at') === '5');
    const fresh = phone('ds', {});
    ok('a phone with nothing picked and no record has nothing to send', fresh.look.changed() === false && fresh.get('nbd_ds_look') === null);
    const dflt = phone('ds', { 'nbd-theme': 'default', nbd_pro_theme: 'nbd-original' });
    ok('the dashboard\'s name for the default theme (nbd-original) is read as the default, and is not a choice to send', dflt.look.current().look.theme === 'default' && dflt.get('nbd_ds_look') === null);
  }

  console.log('\n6. Only well-formed ids');
  {
    const L = phone('ds', {}).look;
    const bad = [null, 'ocean', [], {}, { theme: '' }, { theme: 'Ocean' }, { theme: '<b>' }, { theme: 'a'.repeat(41) }, { theme: ' ocean' }, { theme: 5 }, { theme: '../x' }];
    ok('a record without a clean theme id is no record', bad.every((v) => L.norm(v) === null));
    ok('a bad accent is dropped, the theme kept', JSON.stringify(L.norm({ theme: 'ocean', accent: '#ff0000' })) === '{"theme":"ocean","accent":null}');
    ok('extra fields are not carried', JSON.stringify(L.norm({ theme: 'ocean', accent: 'teal', evil: 'x', wk: 'y' })) === '{"theme":"ocean","accent":"teal"}');
    ok('the Workout record is a theme and an accent, each an id or the empty "same as Daily Success"', JSON.stringify(L.normWk({ theme: '', accent: '' })) === '{"theme":"","accent":""}'
      && JSON.stringify(L.normWk({ theme: 'midnight', accent: 'rose', x: 1 })) === '{"theme":"midnight","accent":"rose"}' && L.normWk({ theme: 'Bad Id' }) === null && L.normWk({}) === null);
    ok('a Workout record from before it had an accent reads as "same as Daily Success" for the accent', JSON.stringify(L.normWk({ theme: 'ember' })) === '{"theme":"ember","accent":""}');
    ok('a bad Workout accent is dropped, the theme kept', JSON.stringify(L.normWk({ theme: 'ember', accent: '#ff0000' })) === '{"theme":"ember","accent":""}');
    const p = phone('workout', { nbd_ds_look: '{"theme":"<script>","accent":null}', nbd_wk_look: 'not json' });
    ok('a malformed stored record is ignored on restore', p.look.restore() === false && p.get('nbd-theme') === null && p.calls.repaints === 0);
  }

  console.log('\n7. The Workout app\'s own accent');
  {
    const cloud = new Map();
    const a = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean', nbd_ds_accent: 'teal' });
    await a.sync(cloud);
    const w = phone('workout', {});
    await w.sync(cloud);
    ok('with none of its own the Workout phone has the Daily Success accent', w.get('nbd_ds_accent') === 'teal' && w.get('nbd_wk_accent') === null);
    w.store.set('nbd_wk_accent', 'rose'); w.look.changed();      // workout-theme.js setOwnAccent('rose')
    ok('its own accent is recorded with the Workout theme record, and only that record', JSON.stringify(w.json('nbd_wk_look')) === '{"theme":"","accent":"rose"}' && w.calls.stamps.join() === 'nbd_wk_look' && w.json('nbd_ds_look').accent === 'teal');
    await w.sync(cloud); await a.sync(cloud);
    ok('it travels', settings(cloud).dsWkLook.accent === 'rose' && a.get('nbd_wk_accent') === 'rose');
    ok('the Daily Success accent is untouched on both phones and in the cloud', a.get('nbd_ds_accent') === 'teal' && w.get('nbd_ds_accent') === 'teal' && settings(cloud).dsLook.accent === 'teal' && a.calls.accents.length === 0);
    w.store.set('nbd_wk_theme', 'midnight'); w.look.changed();
    ok('picking a Workout theme keeps the Workout accent', JSON.stringify(w.json('nbd_wk_look')) === '{"theme":"midnight","accent":"rose"}');
    w.store.set('nbd_wk_accent', 'none'); w.look.changed();
    await w.sync(cloud); await a.sync(cloud);
    ok('"Theme default" (no accent) is a choice of its own and travels', a.get('nbd_wk_accent') === 'none' && a.get('nbd_wk_theme') === 'midnight');
    w.store.delete('nbd_wk_accent'); w.look.changed();
    await w.sync(cloud); await a.sync(cloud);
    ok('"Same as Daily Success" for the accent travels, and leaves the Workout theme alone', a.get('nbd_wk_accent') === null && a.get('nbd_wk_theme') === 'midnight' && JSON.stringify(settings(cloud).dsWkLook) === '{"theme":"midnight","accent":""}', JSON.stringify(settings(cloud).dsWkLook));
    a.win.NBDAccent.set('plum');
    await a.sync(cloud); await w.sync(cloud);
    ok('a later Daily Success accent pick reaches the Workout phone as the Daily Success accent', w.get('nbd_ds_accent') === 'plum' && w.get('nbd_wk_accent') === null);
  }
  {
    const cloud = new Map();
    const a = phone('ds', { 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean', nbd_ds_accent: 'teal' });
    await a.sync(cloud);
    const fresh = phone('workout', {});
    fresh.store.set('nbd_wk_accent', 'amber'); fresh.look.changed();   // picked before this phone ever synced
    await fresh.sync(cloud);
    ok('a Workout-only accent picked on a fresh phone does not disturb the Daily Success look', JSON.stringify(settings(cloud).dsLook) === '{"theme":"ocean","accent":"teal"}' && settings(cloud).dsWkLook.accent === 'amber');
    const seeded = phone('workout', { nbd_wk_accent: 'sky' });
    ok('an accent already on the phone is recorded on load, without a stamp', JSON.stringify(seeded.json('nbd_wk_look')) === '{"theme":"","accent":"sky"}' && seeded.get('nbd_wk_look_at') === null);
  }

  console.log('\n8. Custom themes travel with their colours');
  {
    const C1 = { id: 'custom-1700000000001', name: 'Night shift', cat: 'custom', plan: 'command', accent: '#22aa66', bg: '#101820', s: '#1c2836', tc: '#f0f0f0', m: '#99aabb' };
    const DEF = '{"id":"custom-1700000000001","name":"Night shift","accent":"#22aa66","bg":"#101820","s":"#1c2836","tc":"#f0f0f0","m":"#99aabb"}';
    const cloud = new Map();
    const a = phone('ds', { 'nbd-customs': JSON.stringify([C1]), 'nbd-theme': C1.id, nbd_pro_theme: C1.id });
    ok('a look that names a custom theme records its definition (id, name and the five colours only)', JSON.stringify(a.json('nbd_ds_look').custom) === DEF, JSON.stringify(a.json('nbd_ds_look')));
    await a.sync(cloud);
    ok('the definition reaches the cloud with the look', JSON.stringify(settings(cloud).dsLook.custom) === DEF);
    const w = phone('workout', {});
    ok('before the sync the fresh Workout app cannot draw it', w.workoutTheme() === 'default');
    await w.sync(cloud);
    const got = w.json('nbd-customs') || [];
    ok('after the sync its device list holds the theme, in the shape Daily Success stores', got.length === 1 && got[0].id === C1.id && got[0].cat === 'custom' && got[0].tc === '#f0f0f0' && got[0].name === 'Night shift', JSON.stringify(got));
    ok('and it wears it', w.get('nbd-theme') === C1.id && w.workoutTheme() === C1.id && w.calls.repaints === 1);
    await w.sync(cloud);
    ok('a second sync does not add it twice or re-stamp anything', (w.json('nbd-customs') || []).length === 1 && w.calls.stamps.length === 0);
    // a phone that already has the theme in its list (it made it, or got it earlier) and now receives a look that names it
    const has = phone('workout', { 'nbd-customs': JSON.stringify([C1]), 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean', nbd_ds_look: JSON.stringify({ theme: C1.id, accent: null, custom: JSON.parse(DEF) }), nbd_ds_look_at: '9' });
    ok('receiving a theme the phone already has does not list it twice', has.look.restore() === true && (has.json('nbd-customs') || []).length === 1 && has.get('nbd-theme') === C1.id);
    const hasDs = phone('ds', { 'nbd-customs': JSON.stringify([C1]), 'nbd-theme': 'ocean', nbd_pro_theme: 'ocean', nbd_ds_look: JSON.stringify({ theme: C1.id, accent: null, custom: JSON.parse(DEF) }), nbd_ds_look_at: '9' });
    hasDs.look.restore();
    ok('nor twice in Daily Success\'s in-memory list', hasDs.mem.filter((x) => x.id === C1.id).length === 1 && (hasDs.json('nbd-customs') || []).length === 1);
    const ds2 = phone('ds', {});
    let memAtApply = -1;
    const realApply = ds2.win.nbdApplyTheme;
    ds2.win.nbdApplyTheme = (id) => { memAtApply = ds2.mem.filter((x) => x.id === id).length; realApply(id); };
    await ds2.sync(cloud);
    ok('a fresh Daily Success install has the theme in app.js\'s in-memory list BEFORE nbdApplyTheme looks it up', memAtApply === 1 && ds2.calls.applied.join() === C1.id);
    ok('and in its stored list for the next load', (ds2.json('nbd-customs') || []).some((x) => x.id === C1.id));

    // the Workout app's own custom theme
    const C2 = Object.assign({}, C1, { id: 'custom-1700000000002', name: 'Gym', accent: '#aa2266' });
    w.store.set('nbd-customs', JSON.stringify((w.json('nbd-customs') || []).concat([C2])));
    w.store.set('nbd_wk_theme', C2.id); w.look.changed();
    ok('a custom theme picked as the Workout app\'s own carries its definition in the Workout record', w.json('nbd_wk_look').custom.id === C2.id && w.json('nbd_wk_look').custom.accent === '#aa2266' && w.calls.stamps.join() === 'nbd_wk_look');
    await w.sync(cloud); await a.sync(cloud);
    ok('the other phone receives it and a Workout app there wears it, while Daily Success keeps its own', a.workoutTheme() === C2.id && a.get('nbd-theme') === C1.id && a.mem.some((x) => x.id === C2.id));
    a.win.nbdApplyTheme('ocean');
    ok('going back to a built-in theme drops the definition from the look', a.json('nbd_ds_look').custom === undefined && a.json('nbd_ds_look').theme === 'ocean');
  }
  {
    const Lk = phone('ds', {}).look;
    const good = { id: 'custom-1700000000009', name: 'X', accent: '#112233', bg: '#000000', s: '#111111', tc: '#ffffff', m: '#aaaaaa' };
    const bad = [null, {}, Object.assign({}, good, { id: 'ocean' }), Object.assign({}, good, { id: 'custom-abc' }), Object.assign({}, good, { bg: 'red' }), Object.assign({}, good, { tc: '#fff' }),
      Object.assign({}, good, { accent: 'url(javascript:1)' }), Object.assign({}, good, { s: '#11111g' }), Object.assign({}, good, { m: undefined })];
    ok('a definition needs a custom id and five six-digit hex colours', bad.every((c) => Lk.normCustom(c) === null) && Lk.normCustom(good) !== null);
    ok('nothing else rides along, and a long or odd name is tidied', JSON.stringify(Object.keys(Lk.normCustom(Object.assign({}, good, { evil: 1, cat: 'x', name: '  a   b ' + 'z'.repeat(80) })))) === '["id","name","accent","bg","s","tc","m"]'
      && Lk.normCustom(Object.assign({}, good, { name: '  a   b ' + 'z'.repeat(80) })).name.length === 40 && Lk.normCustom(Object.assign({}, good, { name: 7 })).name === 'Custom');
    ok('a record cannot smuggle in a definition for a different theme than the one it names', Lk.norm({ theme: 'ocean', custom: good }).custom === undefined && Lk.norm({ theme: 'custom-1700000000001', custom: good }).custom === undefined && Lk.normWk({ theme: '', custom: good }).custom === undefined);
    const p = phone('workout', { nbd_ds_look: JSON.stringify({ theme: good.id, accent: null, custom: Object.assign({}, good, { bg: 'expression(alert(1))' }) }) });
    p.look.restore();
    ok('a restored record with a malformed definition adds nothing to the device list', p.get('nbd-customs') === null && p.workoutTheme() === 'default');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
