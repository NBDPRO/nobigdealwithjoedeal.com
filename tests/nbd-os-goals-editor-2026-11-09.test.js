/**
 * tests/nbd-os-goals-editor-2026-11-09.test.js - NBD OS P2, the daily goals
 * editor (the P1 follow-up "goals have no editor",
 * documentation/projects/SESSION-2026-11-09-nbd-os-p1.md section 4).
 *
 * companies/{companyId}/settings/goals { callsPerDay, followUpsPerDay,
 * doorsPerDay } had a reader (os/ds-business.js) and rules (firestore.rules
 * "DAILY GOALS", tests/firestore-rules.os-daily-goals.test.js) but no writer.
 * The Daily Success widget (L; an M card has no room) now carries:
 *   - "Set goals" for the solo owner or a company_admin (the layout's
 *     canAdmin): a native <dialog> with three number fields; Save writes the
 *     one doc the rules allow (all three goals, updatedAt, updatedBy = the
 *     writer), refuses anything that is not a whole number 0-500, and drops
 *     the osdsbiz cache so the widget reads the new goals
 *   - "Team goals" for anyone else, read-only, only once goals exist
 * The sheet is os/ds-goals.js, the runtime ScriptLoader bundle osdsgoals,
 * loaded on the first tap: no boot bytes, no <script> tag.
 *
 * Run: node tests/nbd-os-goals-editor-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, byKey, text, click, key, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)));
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const GL = req('docs/pro/js/os/ds-goals.js');
const SRC = read('docs/pro/js/os/ds-goals.js');

async function run() {
  console.log('\n1. the pure parts');
  ok('docs/pro/js/os/ds-goals.js require()s in Node', !!GL && typeof GL.parseGoal === 'function');
  if (!GL) return;
  ok('blank is 0 (no goal); whole numbers 0-500 pass', GL.parseGoal('') === 0 && GL.parseGoal('  ') === 0 && GL.parseGoal('0') === 0 && GL.parseGoal('40') === 40
    && GL.parseGoal(' 7 ') === 7 && GL.parseGoal('500') === 500);
  ok('501, negative, fractional, words, exponents are refused (null)', ['501', '-1', '2.5', 'abc', '1e2', '40 doors', '0x10'].every((t) => GL.parseGoal(t) === null));
  const P = GL.payload({ callsPerDay: 10, followUpsPerDay: 0, doorsPerDay: 40 }, 'u1', 'TS');
  ok('payload: all three goals, updatedAt, updatedBy = the writer', J(P) === J({ callsPerDay: 10, followUpsPerDay: 0, doorsPerDay: 40, updatedAt: 'TS', updatedBy: 'u1' }), J(P));
  ok('payload: a bad value or no writer -> null (nothing is written)', GL.payload({ callsPerDay: 501, followUpsPerDay: 0, doorsPerDay: 0 }, 'u1', 'TS') === null
    && GL.payload({ callsPerDay: null, followUpsPerDay: 0, doorsPerDay: 0 }, 'u1', 'TS') === null && GL.payload({ callsPerDay: 1, followUpsPerDay: 0, doorsPerDay: 0 }, '', 'TS') === null);
  const rules = read('firestore.rules');
  const keys = (/function goalsDocOk\(\)[\s\S]*?hasOnly\(\[([^\]]*)\]\)/.exec(rules) || [])[1] || '';
  ok('the payload\'s keys are exactly the ones firestore.rules goalsDocOk allows', J(Object.keys(P).sort()) === J(keys.split(',').map((k) => k.trim().replace(/'/g, '')).sort()), keys);
  ok('rows(): only the goals that are set, in order', J(GL.rows({ callsPerDay: 10, doorsPerDay: 40, followUpsPerDay: 0 })) === J([{ label: 'Calls a day', n: 10 }, { label: 'Doors a day', n: 40 }])
    && J(GL.rows(null)) === '[]');
  ok('prefill(): whole goals 1-500 as text; 0, missing, junk or no doc -> blank', J(GL.prefill({ callsPerDay: 10, followUpsPerDay: 0, doorsPerDay: 501 })) === J({ callsPerDay: '10', followUpsPerDay: '', doorsPerDay: '' })
    && J(GL.prefill(null)) === J({ callsPerDay: '', followUpsPerDay: '', doorsPerDay: '' }) && GL.prefill({ callsPerDay: '7', doorsPerDay: 2.5 }).callsPerDay === '');

  console.log('\n2. the widget: Set goals for an owner or admin, Team goals for anyone else');
  const summary = JSON.stringify({ v: 1, uid: 'u1', asOf: NOW - 20 * 60000, calls: 3, followUps: 5, jobs: 2 });
  function widget(o) {
    const opt = o || {};
    const T = makeWin({ surface: 'phone', loader: true, uid: 'u1', claims: opt.claims || { role: 'company_admin', companyId: 'c1' },
      store: { nbd_today_summary: summary }, home: { phone: [{ id: 'daily', s: opt.s || 'l' }], desk: [] } });
    const W = T.W;
    const log = { getDoc: [], setDoc: [], goals: opt.goals };
    W.getDoc = (ref) => { log.getDoc.push(ref); if (log.readFail) return Promise.reject(new Error('unavailable')); return Promise.resolve({ exists: () => log.goals !== undefined, data: () => log.goals }); };
    W.doc = (...a) => a.slice(1).join('/');
    W.setDoc = (ref, data) => {
      log.setDoc.push([ref, JSON.parse(JSON.stringify(data))]);
      if (opt.fail) return Promise.reject(new Error('permission-denied'));
      log.goals = { callsPerDay: data.callsPerDay, followUpsPerDay: data.followUpsPerDay, doorsPerDay: data.doorsPerDay };
      return Promise.resolve();
    };
    W.serverTimestamp = () => ({ ts: 'server' });
    W._impl.mount({ surface: 'phone' });
    return { T, W, log, card: () => byKey(T.document.getElementById('osPhone'), 'daily-1'), dlg: () => T.document.querySelector('dialog.os-hw-goals') };
  }
  {
    const { T, W, log, card, dlg } = widget({ goals: { doorsPerDay: 40 } });
    ok('no button before the goals answer lands (nothing to prefill from)', !card().querySelector('[data-oshw-goals]'));
    await settle();
    const b = card().querySelector('[data-oshw-goals]');
    ok('a company_admin sees "Set goals" (a 44px os-hw-btn)', !!b && text(b) === 'Set goals' && b.classList.contains('os-hw-btn'), text(card()));
    ok('the sheet is not loaded until the tap', !W.NBDOSDsGoals && W.ScriptLoader.calls.indexOf('osdsgoals') === -1);
    click(T.dom, b);
    await settle();
    ok('the tap loads the osdsgoals bundle (js/os/ds-goals.js) and opens a modal dialog', W.ScriptLoader.calls.indexOf('osdsgoals') !== -1
      && J(W.ScriptLoader.bundles.osdsgoals) === J(['js/os/ds-goals.js?v=1']) && !!dlg() && dlg().modal === true);
    const ins = dlg().querySelectorAll('[data-oshw-goal]');
    ok('three number fields, 0-500, whole numbers, each with its label', ins.length === 3 && ins.every((i) => i.getAttribute('type') === 'number' && i.getAttribute('min') === '0'
      && i.getAttribute('max') === '500' && i.getAttribute('step') === '1') && /Calls a day/.test(text(dlg())) && /Follow-ups a day/.test(text(dlg())) && /Doors a day/.test(text(dlg())));
    ok('prefilled from the goals on file (doors 40, the others blank)', ins.map((i) => i.getAttribute('value')).join() === ',,40');
    ok('the sheet reads the goals doc again when it opens (the widget\'s answer can be 5 minutes old)', log.getDoc.filter((r) => r === 'companies/c1/settings/goals').length >= 2, J(log.getDoc));
    ok('focus starts on the first field', T.document.activeElement === ins[0]);
    ins[0].value = '12'; ins[1].value = '501'; ins[2].value = '40';
    click(T.dom, dlg().querySelector('[data-oshw-goals="save"]'));
    await settle();
    ok('501 is refused on its field: nothing written, the field marked and focused, the reason said', log.setDoc.length === 0 && ins[1].getAttribute('aria-invalid') === 'true'
      && T.document.activeElement === ins[1] && /Follow-ups a day: a whole number from 0 to 500/.test(text(dlg().querySelector('.os-hw-pub-status'))), text(dlg()));
    // review 2026-11-09: a type=number field holding '1e', '-' or a lone 'e' reports value '' to JS with
    // validity.badInput set; parseGoal('') is 0 (no goal), so the typo used to clear that goal silently
    ins[1].value = ''; ins[1].validity = { badInput: true };
    click(T.dom, dlg().querySelector('[data-oshw-goals="save"]'));
    await settle();
    ok('a field the browser could not parse (badInput, value \'\') is refused, never read as blank = no goal', log.setDoc.length === 0 && ins[1].getAttribute('aria-invalid') === 'true'
      && T.document.activeElement === ins[1] && /Follow-ups a day: a whole number from 0 to 500/.test(text(dlg().querySelector('.os-hw-pub-status'))), text(dlg()));
    ins[1].validity = { badInput: false };
    const reads = log.getDoc.length;
    click(T.dom, dlg().querySelector('[data-oshw-goals="save"]'));
    await settle();
    ok('Save writes one doc: companies/c1/settings/goals, blank = 0, stamped, updatedBy = the writer', log.setDoc.length === 1 && log.setDoc[0][0] === 'companies/c1/settings/goals'
      && J(log.setDoc[0][1]) === J({ callsPerDay: 12, followUpsPerDay: 0, doorsPerDay: 40, updatedAt: { ts: 'server' }, updatedBy: 'u1' }), J(log.setDoc));
    ok('the sheet closes and says so', !dlg() && W.toasts.some((t) => /Daily goals saved/.test(t.msg)));
    await settle();
    ok('the widget reads the goals again (the osdsbiz cache was dropped)', log.getDoc.length > reads, log.getDoc.length + ' vs ' + reads);
  }
  {
    // review 2026-11-09: the widget's goals can be stale (another admin, inside the 5-minute TTL) or
    // unknown (the read failed, cache goals null). Save writes all three keys, so a sheet prefilled from
    // that would overwrite the real goals with blanks. The sheet re-reads the doc on open.
    const { T, log, card, dlg } = widget({ goals: { doorsPerDay: 40 } });
    await settle();
    log.goals = { callsPerDay: 25, followUpsPerDay: 8, doorsPerDay: 60 };   // another admin changed them since
    click(T.dom, card().querySelector('[data-oshw-goals]'));
    await settle();
    const ins = dlg().querySelectorAll('[data-oshw-goal]');
    ok('prefilled from the doc as it is now, not the widget\'s cached answer', ins.map((i) => i.getAttribute('value')).join() === '25,8,60', ins.map((i) => i.getAttribute('value')).join());
    ok('the fields and Save are live once the read lands', ins.every((i) => !i.hasAttribute('disabled')) && !dlg().querySelector('[data-oshw-goals="save"]').hasAttribute('disabled'));
  }
  {
    const { T, log, card, dlg } = widget({ goals: { doorsPerDay: 40 } });
    await settle();
    log.readFail = true;   // the goals read fails now
    click(T.dom, card().querySelector('[data-oshw-goals]'));
    await settle();
    const ins = dlg().querySelectorAll('[data-oshw-goal]');
    const sv = dlg().querySelector('[data-oshw-goals="save"]');
    ok('a failed read: the fields and Save are disabled and the sheet says why', ins.length === 3 && ins.every((i) => i.hasAttribute('disabled'))
      && !!sv && sv.hasAttribute('disabled') && /Couldn't read the goals on file/.test(text(dlg())), text(dlg()));
    ins.forEach((i) => { i.value = '1'; });
    click(T.dom, sv);
    key(T.dom, ins[0], 'Enter');
    await settle();
    ok('...and nothing can be written over goals nobody could read', log.setDoc.length === 0, J(log.setDoc));
  }
  {
    const { T, log, card, dlg } = widget({ goals: { doorsPerDay: 40 } });
    await settle();
    delete log.goals;   // the doc was deleted since: no goals on file
    click(T.dom, card().querySelector('[data-oshw-goals]'));
    await settle();
    const ins = dlg().querySelectorAll('[data-oshw-goal]');
    ok('no goals doc: three blank live fields (blank is the truth, not a guess)', ins.map((i) => i.getAttribute('value')).join() === ',,' && ins.every((i) => !i.hasAttribute('disabled')));
  }
  {
    const { T, log, card, dlg } = widget({ goals: { doorsPerDay: 40 }, fail: true });
    await settle();
    click(T.dom, card().querySelector('[data-oshw-goals]'));
    await settle();
    dlg().querySelectorAll('[data-oshw-goal]').forEach((i, k) => { i.value = ['5', '5', '5'][k]; });
    click(T.dom, dlg().querySelector('[data-oshw-goals="save"]'));
    await settle();
    ok('a refused write keeps the sheet open and says why (never "saved")', log.setDoc.length === 1 && !!dlg() && /Couldn't save the goals/.test(text(dlg())), text(dlg && dlg()));
    key(T.dom, dlg(), 'Escape');
    ok('Escape closes it', !dlg());
  }
  {
    const { T, card, dlg } = widget({ goals: { callsPerDay: 10, doorsPerDay: 40 }, claims: { role: 'sales_rep', companyId: 'c1' } });
    await settle();
    const b = card().querySelector('[data-oshw-goals]');
    ok('a rep sees "Team goals", never "Set goals"', !!b && text(b) === 'Team goals', text(card()));
    click(T.dom, b);
    await settle();
    ok('read-only: the goals that are set, no field and no Save', !!dlg() && !dlg().querySelector('input') && !dlg().querySelector('[data-oshw-goals="save"]')
      && /Calls a day\s*10/.test(text(dlg())) && /Doors a day\s*40/.test(text(dlg())) && !/Follow-ups/.test(text(dlg())) && /owner or admin sets these/.test(text(dlg())), text(dlg()));
  }
  {
    const { card } = widget({ claims: { role: 'manager', companyId: 'c1' } });
    await settle();
    ok('a manager with no goals on file: no button at all (nothing to show, not theirs to set)', !card().querySelector('[data-oshw-goals]'), text(card()));
  }
  {
    const { card } = widget({ claims: { role: 'viewer', companyId: 'c1' } });
    await settle();
    ok('a viewer is never offered Set goals (the rules refuse viewers)', !card().querySelector('[data-oshw-goals="set"]'));
  }
  {
    const { card } = widget({ goals: { doorsPerDay: 40 }, claims: { role: 'owner' } });
    await settle();
    const b = card().querySelector('[data-oshw-goals]');
    ok('the solo owner (no companyId claim) sees Set goals', !!b && text(b) === 'Set goals');
  }
  {
    const { card } = widget({ goals: { doorsPerDay: 40 }, s: 's' });
    await settle();
    ok('the small widget stays one thing: no goals button', !card().querySelector('[data-oshw-goals]'));
    const m = widget({ goals: { doorsPerDay: 40 }, s: 'm' });
    await settle();
    // screenshots (2026-11-09): a 44px button clipped at the foot of the 160px desk M card
    ok('the medium widget has no room for it either: L only', !m.card().querySelector('[data-oshw-goals]') && /Doors 0 of 40|Doors \d+ of 40|Left today/.test(text(m.card())), text(m.card()));
  }

  console.log('\n3. house rules');
  const code = noComments(SRC);
  ok('no inline style, no inline handler, no innerHTML without esc()', !/style=|\.style\b|\son[a-z]+=/.test(code)
    && (code.match(/\+ esc\(|' \+ MAX \+ '/g) || []).length >= 5);
  ok('the only write is setDoc on companies/{cid}/settings/goals', (code.match(/setDoc\(/g) || []).length === 1 && /'companies', cid, 'settings', 'goals'/.test(code)
    && !/addDoc|updateDoc|deleteDoc|fetch\(|import\(/.test(code));
  ok('not in dashboard.html, not in a layout needs list (a tap-time bundle)', !/ds-goals/.test(read('docs/pro/dashboard.html')) && !/ds-goals/.test(read('docs/pro/js/layout-system.js')));
  ok('the dialog CSS: 44px rows and fields, 16px field text (no iOS zoom), tokens only', /\.os-hw-goals-in \{[^}]*min-height: 44px[^}]*font-size: 16px/.test(read('docs/pro/css/os/home.css'))
    && /\.os-hw-goals-row, \.os-hw-goals-list li \{[^}]*min-height: 44px/.test(read('docs/pro/css/os/home.css')));
}

run().then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
