/**
 * tests/install-completed-at-2026-11-09.test.js
 *
 * The install-complete date (CONTENT-PHOTOS-CREDENTIALS-PLAN-2026-11-09 §1
 * step 3). Before this, a normal move onto Install Done (install_complete)
 * recorded no completion date: installCompletedAt was read by
 * social-studio.js, agent-mcp-logic.js, anniversary-touch.js and
 * ai-texting.js but written by nothing, so they all fell back to
 * stageStartedAt, which the NEXT stage move overwrites.
 *
 * Rule: the FIRST move onto install_complete stamps installCompletedAt with
 * server time, once. A lead that already carries one keeps it on every later
 * move (back off and onto Install Done again included). Both writers:
 *   1. the client (docs/pro/js/stage-write.js commitStageChange), run for real
 *      in a vm with a fake Firestore that applies the patch;
 *   2. the server job spine (functions/job-spine-logic.js movePayload, used by
 *      job-spine.js and deal-prequal.js), required directly.
 * The quiet "already completed" backfill is left alone: it writes the real
 * day into completedAt, which every reader takes next, and a server-time
 * installCompletedAt would put today ahead of that day.
 *
 * Every absence assertion has a positive control beside it. Synthetic data only.
 * Run: node tests/install-completed-at-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

const JOB_KEYS = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered', 'crew_scheduled', 'install_in_progress'];
const ROLE = (k) => (['install_complete', 'final_photos', 'final_payment', 'closed'].includes(k) ? 'won' : (k === 'lost' ? 'lost' : (JOB_KEYS.includes(k) ? 'job' : 'active')));

const SW_SRC = fs.readFileSync(path.join(ROOT, 'docs/pro/js/stage-write.js'), 'utf8').replace(/^export (async )?function/gm, '$1function');
function loadSW(win) {
  const sandbox = { window: win, console: { warn() {}, log() {} }, Date, Math, JSON, Promise, Object, Array, String, Number, Error };
  vm.createContext(sandbox);
  return vm.runInContext(SW_SRC + '\n;({ commitStageChange })', sandbox, { filename: 'stage-write.js' });
}

// A fake page: runTransaction reads the stored lead and applies the patch.
function mkWin(seed, opts) {
  const state = { lead: Object.assign({ stage: 'install_in_progress', stageRole: 'job', closedAt: 'T-SOLD', stageHistory: [] }, seed || {}) };
  const rec = { patches: [], transactions: 0 };
  let tick = 0;
  const apply = (cur, patch) => {
    const out = Object.assign({}, cur);
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      out[k] = (v && v.__union) ? (out[k] || []).concat(v.__union) : (v === '__TS__' ? 'SERVER@' + (++tick) : v);
    });
    return out;
  };
  const win = {
    db: {}, auth: { currentUser: { uid: 'u-jo', email: 'jo@nbd.test' } },
    doc: (db, c, id) => ({ path: c + '/' + id }),
    collection: (db, c) => ({ path: c }),
    serverTimestamp: () => '__TS__',
    arrayUnion: (...x) => ({ __union: x }),
    updateDoc: async (r, p) => { rec.patches.push(p); state.lead = apply(state.lead, p); },
    addDoc: async () => {},
    stageRole: (k) => ROLE(k),
  };
  if (!(opts && opts.noTransaction)) {
    win.runTransaction = async (db, fn) => {
      rec.transactions++;
      const pending = [];
      await fn({ get: async () => ({ exists: () => true, data: () => Object.assign({}, state.lead) }), update: (r, p) => pending.push(p) });
      pending.forEach((p) => { rec.patches.push(p); state.lead = apply(state.lead, p); });
    };
  }
  return { win, rec, state };
}

(async () => {
  console.log('\n1. client: stage-write.js commitStageChange');
  {
    const { win, rec, state } = mkWin({});
    const SW = loadSW(win);
    await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', {});
    const p = rec.patches[0] || {};
    ok('the first move onto Install Done stamps installCompletedAt with server time', p.installCompletedAt === '__TS__', JSON.stringify(p));
    ok('…and the stored lead now carries it', typeof state.lead.installCompletedAt === 'string' && state.lead.installCompletedAt.indexOf('SERVER@') === 0);
    const first = state.lead.installCompletedAt;

    // Later moves never touch it: forward, back to open work, and onto Install Done again.
    await SW.commitStageChange('L1', 'final_photos', 'install_complete', {});
    ok('a later forward move does not write installCompletedAt', !('installCompletedAt' in rec.patches[1]), JSON.stringify(rec.patches[1]));
    await SW.commitStageChange('L1', 'install_in_progress', 'final_photos', {});
    ok('a move back to open work does not clear it', !('installCompletedAt' in rec.patches[2]) && state.lead.installCompletedAt === first);
    await SW.commitStageChange('L1', 'install_complete', 'install_in_progress', {});
    ok('a SECOND move onto Install Done does not overwrite the first date', !('installCompletedAt' in rec.patches[3]) && state.lead.installCompletedAt === first,
      JSON.stringify(rec.patches[3]));
    ok('control: that second move still restamps stageStartedAt (the field that used to be the only date)', rec.patches[3].stageStartedAt === '__TS__');
  }
  {
    const { win, rec } = mkWin({ stage: 'crew_scheduled' });
    await loadSW(win).commitStageChange('L2', 'final_payment', 'crew_scheduled', {});
    ok('a move that skips Install Done (straight to Final Payment) records no install date', !('installCompletedAt' in rec.patches[0]));
  }
  {
    const { win, rec } = mkWin({ stage: 'contract_signed', installCompletedAt: 'T-IMPORTED' });
    await loadSW(win).commitStageChange('L3', 'install_complete', 'contract_signed', {});
    ok('a lead that already has installCompletedAt (from anywhere) keeps it', !('installCompletedAt' in rec.patches[0]));
  }
  {
    const { win, rec } = mkWin({});
    await loadSW(win).commitStageChange('L4', 'install_complete', 'install_in_progress', { backfill: { date: '2026-10-01', today: '2026-10-13' } });
    const p = rec.patches[0] || {};
    ok('the quiet "already completed" backfill writes its real day into completedAt…', p.completedAt instanceof Date || (p.completedAt && typeof p.completedAt.getTime === 'function'));
    ok('…and no server-time installCompletedAt that every reader would take ahead of that day', !('installCompletedAt' in p), JSON.stringify(p));
  }
  {
    // No runTransaction: no server read, so "first" cannot be known. Never-overwrite wins.
    const { win, rec } = mkWin({ installCompletedAt: 'T-FIRST' }, { noTransaction: true });
    await loadSW(win).commitStageChange('L5', 'install_complete', 'install_in_progress', {});
    ok('the no-transaction fallback writes no installCompletedAt (it cannot see a stored one)', rec.transactions === 0 && rec.patches.length === 1 && !('installCompletedAt' in rec.patches[0]));
  }

  console.log('\n2. server: job-spine-logic.js movePayload');
  {
    const L = require(path.join(ROOT, 'functions/job-spine-logic.js'));
    const fv = { serverTimestamp: () => 'TS', arrayUnion: (x) => ({ u: x }) };
    const mp = (lead, ev) => L.movePayload(lead, L.planJobEvent(lead, ev), { actor: 'a', atIso: 'T', event: ev }, fv).payload;
    const p1 = mp({ stage: 'crew_scheduled', jobType: 'cash' }, 'installed');
    ok('the spine\'s "installed" move onto Install Done stamps installCompletedAt', p1.stage === 'install_complete' && p1.installCompletedAt === 'TS', JSON.stringify(p1));
    ok('…not when the lead already has one', !('installCompletedAt' in mp({ stage: 'crew_scheduled', jobType: 'cash', installCompletedAt: 'X' }, 'installed')));
    const p3 = mp({ stage: 'install_complete', jobType: 'cash' }, 'paid_in_full');
    ok('a spine move to another stage (Final Payment) records none', p3.stage === 'final_payment' && !('installCompletedAt' in p3));
    ok('a legacy "Install Complete" display name is the same stage, not a fresh entry', L.planJobEvent({ stage: 'Install Complete', jobType: 'cash' }, 'installed').action === 'skip');
  }

  console.log('\n3. the readers take it first');
  {
    const src = fs.readFileSync(path.join(ROOT, 'functions/social-studio.js'), 'utf8');
    ok('social-studio.js orders won jobs by installCompletedAt before its fallbacks', /L\.ms\(lead\.installCompletedAt\)\s*\|\|\s*L\.ms\(lead\.completedAt\)/.test(src));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
