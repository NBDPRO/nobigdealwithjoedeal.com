/**
 * tests/leaderboard-rep-names-2026-09-28.test.js
 *
 * CRM sweep R14 (emulator, 2026-09-28) — Analytics & Leaderboard rep naming.
 *
 * THE BUGS:
 *  - "Top Reps" named a rep whose leads carry no repName "Teammate Y6HCf6"
 *    (a uid fragment) — the company roster was never read.
 *  - The D2D "Rep Leaderboard" keyed rows by the knock's free-text repName:
 *    one person split into "Casey ZZ_QA" and "You", and a teammate's unnamed
 *    knocks were credited to the viewer.
 *  - Its company-wide knock read excluded company_admin (the tenant owner),
 *    though the /knocks rule allows it — teammates' D2D revenue landed in
 *    "Unattributed".
 *
 * THE FIX: team-names.js (window.NBDTeamNames) maps uid → roster name; both
 * boards use it; the D2D board keys by knock owner uid and reads team knocks
 * for company_admin.
 *
 * Runs the REAL team-names.js in a vm; checks the two consumers.
 * Break-test: against main these go red.
 *
 * Zero deps. Run: node tests/leaderboard-rep-names-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const TN_PATH = path.join(__dirname, '..', 'docs/pro/js/team-names.js');
const AK = read('docs/pro/js/analytics-kpi.js');
const API = read('docs/pro/js/dashboard-api.js');
const DASH = read('docs/pro/dashboard.html');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  console.log('TEAM NAMES — roster lookup');
  ok('team-names.js exists', fs.existsSync(TN_PATH));
  if (fs.existsSync(TN_PATH)) {
    let reads = 0;
    const win = {
      _userClaims: { companyId: 'co1' },
      _user: { uid: 'me', displayName: 'Casey' },
      db: {},
      collection: (_db, a, b, c) => [a, b, c].join('/'),
      getDocs: async (p) => {
        reads++;
        if (p !== 'companies/co1/members') throw new Error('wrong path ' + p);
        return { docs: [
          { id: 'rep@x.test', data: () => ({ uid: 'u-rep', displayName: 'Sam Rep', email: 'rep@x.test' }) },
          { id: 'v@x.test', data: () => ({ uid: 'u-v', email: 'v@x.test' }) },
        ] };
      },
    };
    vm.runInNewContext(fs.readFileSync(TN_PATH, 'utf8'), { window: win });
    const TN = win.NBDTeamNames;
    ok('before load: no name (callers fall back)', TN.nameFor('u-rep') === null);
    await TN.load(); await TN.load();
    ok('reads the company roster once', reads === 1, 'reads=' + reads);
    ok('uid → displayName', TN.nameFor('u-rep') === 'Sam Rep');
    ok('no displayName → email', TN.nameFor('u-v') === 'v@x.test');
    ok('the viewer is named by their own profile', TN.nameFor('me') === 'Casey');
    ok('unknown uid → null', TN.nameFor('nobody') === null);
  }
  ok('dashboard.html loads team-names.js before dashboard-api.js',
    DASH.indexOf('js/team-names.js') > 0 && DASH.indexOf('js/team-names.js') < DASH.indexOf('js/dashboard-api.js'));

  console.log('TOP REPS (dashboard-api.js)');
  ok('names reps from the roster before the uid-fragment fallback',
    /await window\.NBDTeamNames\.load\(\)/.test(API) && /const rosterName = window\.NBDTeamNames \? window\.NBDTeamNames\.nameFor\(r\.owner\) : null;\s*if \(rosterName\) r\.name = rosterName;/.test(API));

  console.log('D2D REP LEADERBOARD (analytics-kpi.js)');
  ok('company_admin reads the company\'s knocks', /const canReadTeam = [^;]*c\.role === 'company_admin'/.test(AK));
  ok('rows are keyed by the knock owner uid, not the free-text repName',
    /const _repKey = \(uid, repName\) => uid \? 'u:' \+ uid/.test(AK) && !/bump\(k\.repName \|\| 'You'\)/.test(AK));
  ok('revenue without a loaded knock goes to the lead owner, not straight to Unattributed',
    /const uid = \(k && k\.userId\) \|\| l\.userId \|\| null;/.test(AK) && !/bump\(\(k && k\.repName\) \|\| 'Unattributed'\)/.test(AK));

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
