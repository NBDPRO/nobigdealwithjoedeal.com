/**
 * tests/stage-actor-no-next-step-2026-10-03.test.js
 *
 * 1. Stage changes record WHO made them (stage-write.js stageActor).
 *    Every owner-tenant stageHistory entry before 2026-09-15 says user
 *    "unknown": moveCard read window._currentUser?.email, a global only the
 *    vault pages set. Callers still pass that dead global as actorLabel. Now
 *    the uid is always stamped (`by`), plus email / display name from the
 *    signed-in Firebase user at write time — never "unknown" while signed in.
 *    Drives the real commitStageChange in a vm (export stripped).
 *
 * 2. The "No next step" list (no-next-step.js buildNoNextStep): open leads
 *    with no follow-up and no open task, counted by PERSON, oldest first,
 *    door-knock leads with no phone grouped apart. Pure function, required.
 *
 * Zero deps.  Run: node tests/stage-actor-no-next-step-2026-10-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const ROOT = path.join(__dirname, '..');

// ── 1. actor stamping ────────────────────────────────────────────────────
const SW = fs.readFileSync(path.join(ROOT, 'docs/pro/js/stage-write.js'), 'utf8');
function runStageWrite(win, opts) {
  const writes = [];
  Object.assign(win, {
    db: {},
    doc: (db, c, id) => ({ c, id }),
    collection: (db, c) => ({ c }),
    serverTimestamp: () => 'TS',
    arrayUnion: (x) => ({ union: x }),
    addDoc: async () => ({}),
    runTransaction: async (db, fn) => fn({
      get: async () => ({ exists: () => true, data: () => ({ stage: 'contacted' }) }),
      update: (ref, payload) => writes.push(payload),
    }),
  });
  const sandbox = { window: win, console: { log() {}, warn() {} }, Date, Promise, Object, Error, String, JSON };
  vm.runInNewContext(SW.replace(/^export\s+/gm, '') + '\nwindow.__cs = commitStageChange;', sandbox, { filename: 'stage-write.js' });
  return win.__cs('L1', 'inspected', 'contacted', opts || {}).then((r) => ({ r, writes }));
}

(async () => {
  console.log('STAGE ACTOR');
  {
    // The dashboard as it really is: window.auth set, window._currentUser NOT set,
    // and moveCard passes actorLabel: window._currentUser?.email (undefined).
    const { r, writes } = await runStageWrite({ auth: { currentUser: { uid: 'jo-uid', email: 'jo@nbd.test', displayName: 'Jo Deal' } } }, { actorLabel: undefined });
    const ev = r.historyEvent;
    ok('history entry stamps the uid (`by`)', ev.by === 'jo-uid', JSON.stringify(ev));
    ok('history entry carries the email as `user` + byEmail', ev.user === 'jo@nbd.test' && ev.byEmail === 'jo@nbd.test');
    ok('history entry carries the display name', ev.byName === 'Jo Deal');
    ok('the transaction writes that same entry', writes[0] && writes[0].stageHistory && writes[0].stageHistory.union === ev);
  }
  {
    // A phone / custom-token sign-in with no email — must not say "unknown".
    const { r } = await runStageWrite({ _auth: { currentUser: { uid: 'phone-uid', email: null, displayName: null } } });
    ok('no-email account: uid stamped, label is the uid (not "unknown")',
      r.historyEvent.by === 'phone-uid' && r.historyEvent.user === 'phone-uid', JSON.stringify(r.historyEvent));
  }
  {
    // window.auth missing (another page): falls back to window._user.
    const { r } = await runStageWrite({ _user: { uid: 'u2', email: 'rep@nbd.test' } });
    ok('falls back to window._user when no auth global', r.historyEvent.by === 'u2' && r.historyEvent.user === 'rep@nbd.test');
  }
  {
    const { r } = await runStageWrite({ auth: { currentUser: { uid: 'u3', email: 'a@b.test' } } }, { actorLabel: 'stripe (online payment)' });
    ok('an explicit actorLabel still wins for `user`, uid still stamped', r.historyEvent.user === 'stripe (online payment)' && r.historyEvent.by === 'u3');
  }

  // ── 2. No next step ──────────────────────────────────────────────────
  console.log('NO NEXT STEP');
  const N = require(path.join(ROOT, 'docs/pro/js/no-next-step.js'));
  const DAY = 86400000, NOW = Date.UTC(2026, 9, 3, 15);
  const ago = (d) => new Date(NOW - d * DAY);
  const roles = { lost: 'lost', closed: 'won', install_complete: 'won', install_in_progress: 'job' };
  const env = { now: NOW, stageRole: (k) => roles[k] || 'active' };
  const L = (id, extra) => Object.assign({ id, firstName: 'C', lastName: id, stage: 'contacted', updatedAt: ago(10), phone: '(859) 555-01' + String(id).padStart(2, '0').slice(-2) }, extra || {});
  const leads = [
    L('a1', { updatedAt: ago(90) }),                                    // listed (oldest)
    L('a2', { updatedAt: ago(40) }),                                    // listed
    L('f1', { followUp: '2026-10-10' }),                                // has follow-up
    L('f2', { followUp: '2026-09-01' }),                                // overdue follow-up is still a next step
    L('t1'),                                                            // open task
    L('t2', { updatedAt: ago(5) }),                                     // only a DONE task → listed
    L('s1', { snoozedUntil: new Date(NOW + 5 * DAY) }),                 // snoozed into the future
    L('s2', { snoozedUntil: new Date(NOW - 5 * DAY), updatedAt: ago(20) }), // snooze expired → listed
    L('x1', { stage: 'lost' }), L('x2', { stage: 'closed' }), L('x3', { deleted: true }),
    L('x4', { stage: 'install_in_progress' }), L('x5', { stage: 'Complete' }),
    // one person, two lead docs (same phone): one has a follow-up → person NOT listed
    L('p1', { phone: '(859) 555-7777' }), L('p2', { phone: '859.555.7777', followUp: '2026-10-20' }),
    // one person, two docs, neither has a next step → ONE row, both ids
    L('q1', { phone: '(859) 555-8888', updatedAt: ago(60) }), L('q2', { phone: '8595558888', updatedAt: ago(30) }),
    // door knocks with no phone → their own group
    L('k1', { source: 'Door Knock', phone: '', address: '1 Elm St', updatedAt: ago(70) }),
    L('k2', { source: 'D2D', d2dKnockId: 'kn2', phone: '555', address: '2 Elm St', updatedAt: ago(80) }),
    // a knock WITH a phone is an ordinary lead
    L('k3', { source: 'Door Knock', phone: '(859) 555-9999', updatedAt: ago(15) }),
    // teammate's lead the user can't change
    L('tm', { userId: 'someone-else' }),
  ];
  const tasks = { t1: [{ id: 'x', done: false }], t2: [{ id: 'y', done: true }] };
  const r = N.buildNoNextStep(leads, tasks, Object.assign({ canChange: (l) => l.userId !== 'someone-else' }, env));
  const ids = r.people.map((p) => p.leadIds.join('+'));
  const knock = r.knockNoPhone.map((p) => p.leadIds.join('+'));
  ok('lists open leads with no follow-up and no open task', ['a1', 'a2', 't2', 's2', 'k3'].every((i) => ids.includes(i)), JSON.stringify(ids));
  ok('a follow-up date (even overdue) is a next step', !ids.includes('f1') && !ids.includes('f2'));
  ok('an open task is a next step; a done task is not', !ids.includes('t1') && ids.includes('t2'));
  ok('a future snooze is a next step; an expired one is not', !ids.includes('s1') && ids.includes('s2'));
  ok('lost / closed / deleted / in-production / Complete are excluded', !['x1', 'x2', 'x3', 'x4', 'x5'].some((i) => ids.join(',').includes(i)));
  ok('counts people: a person whose OTHER lead has a follow-up is not listed', !ids.some((s) => /p1|p2/.test(s)));
  ok('counts people: two docs for one person → one row carrying both ids', ids.filter((s) => /q/.test(s)).length === 1 && ids.includes('q2+q1'), JSON.stringify(ids));
  ok('door knocks with no phone are grouped apart', knock.includes('k1') && knock.includes('k2') && !ids.includes('k1'), JSON.stringify(knock));
  ok('a door knock WITH a phone stays in the main list', ids.includes('k3'));
  ok('leads the user cannot change are left out', !ids.includes('tm'));
  // A person's age is their MOST RECENT touch across their docs (q: 30d).
  ok('oldest first (longest untouched at the top)',
    JSON.stringify(ids) === JSON.stringify(['a1', 'a2', 'q2+q1', 's2', 'k3', 't2']), JSON.stringify(ids));
  ok('knock group oldest first', knock[0] === 'k2');
  ok('total = people + knock group', r.total === r.people.length + r.knockNoPhone.length && r.total === ids.length + 2);
  ok('daysUntouched is computed', r.people[0].daysUntouched === 90);
  ok('followUpIn gives a local YYYY-MM-DD n days out', N.followUpIn(7, new Date(2026, 9, 3, 23, 30)) === '2026-10-10');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
