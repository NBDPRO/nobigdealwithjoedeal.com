/**
 * tests/team-pipeline-states-2026-11-06.test.js — CRM audit 2026-11-06.
 *
 * ST-F38 dashboard-team-tab.js loadTeamMembers: no loading row, and a failed
 *        read only reached console.warn, so the Team panel was blank.
 * ST-F51 pipeline-builder.js "remove from this pipeline" (✕): no occupancy
 *        check, so leads on that stage fell into the view's first column.
 *        Same guard (canDeleteStage) as 🗑 delete.
 * Zero deps. Run: node tests/team-pipeline-states-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const JS = path.join(__dirname, '..', 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

(async function main() {
  console.log('TEAM ROSTER STATES (ST-F38)');
  {
    const SRC = read('dashboard-team-tab.js');
    const s = SRC.indexOf('      async function loadTeamMembers() {');
    const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n      }\n', s) + 9) : '';
    ok('loadTeamMembers found (positive control)', fn.length > 1000);
    async function run(getDocs) {
      const list = { innerHTML: '' };
      const seen = [];
      const sb = {
        window: { _user: { uid: 'OWNER' }, _userClaims: {}, db: {}, collection: () => ({}), getDocs: async () => { seen.push(list.innerHTML); return getDocs(); } },
        document: { getElementById: (id) => (id === 'teamMembersList' ? list : null) },
        _teamOwnerMod: async () => null, _nbdEscHtml: (x) => String(x), _renderSeatPanel() {}, _renderSeatBuy() {}, console: { warn() {} }, Date,
      };
      vm.createContext(sb);
      vm.runInContext(fn + '\nglobalThis.__p = loadTeamMembers();', sb);
      await sb.__p;
      return { html: list.innerHTML, during: seen[0] || '' };
    }
    const bad = await run(async () => { throw new Error('offline'); });
    ok('while the roster loads, it says so', /Loading your team/.test(bad.during), bad.during);
    ok('a failed read says it could not load (not a blank panel)', /Could not load your team/.test(bad.html), bad.html);
    const good = await run(async () => ({ empty: false, docs: [{ id: 'a@x.test', data: () => ({ email: 'a@x.test', role: 'sales_rep', status: 'active' }) }] }));
    ok('a good read paints the roster and drops the loading row (positive control)', /a@x\.test/.test(good.html) && !/Loading your team/.test(good.html));
  }

  console.log('REMOVE A STAGE FROM A PIPELINE (ST-F51)');
  {
    const P = read('pipeline-builder.js');
    const r = P.indexOf("    } else if (action === 'remove') {");
    const branch = r >= 0 ? P.slice(r, P.indexOf("    } else if (action === 'togglehide') {", r)) : '';
    ok('the remove branch is found (positive control)', /ensureViewStages\(vk, res\)/.test(branch));
    const guardAt = branch.indexOf('canDeleteStage(key)');
    const spliceAt = branch.indexOf('a2.splice(j, 1)');
    ok('it applies the same occupancy guard as delete, before removing', guardAt !== -1 && spliceAt !== -1 && guardAt < spliceAt);
    ok('…refuses while leads are unhydrated', /rv\.unhydrated\)[\s\S]{0,120}return;/.test(branch));
    ok('…and refuses when leads are still on the stage', /if \(!rv\.ok\) \{[\s\S]{0,600}still on[\s\S]{0,200}return;/.test(branch));
    ok('the delete branch keeps its own guard (positive control)', /action === 'delete'\) \{\n\s*var verdict = canDeleteStage\(key\);/.test(P));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
