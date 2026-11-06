/**
 * tests/team-roles-2026-11-06.test.js — CRM audit 2026-11-06, role gating in
 * Settings.
 *
 * ST-F36 dashboard-team-tab.js: the Team tab showed invite, Cancel invite,
 *        Disable, Re-enable, Remove and the seat controls to every role. The
 *        server (requireTeamAdmin) refuses all but the owner, a company_admin
 *        and the platform admin.
 * ST-F50 tenant-rules-settings.js: Business Rules was an editable form for
 *        every role, refused on Save.
 * Zero deps. Run: node tests/team-roles-2026-11-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'docs', 'pro', 'js');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8').replace(/\r\n/g, '\n');

(async function main() {
  console.log('TEAM TAB CONTROLS (ST-F36)');
  {
    const SRC = read('dashboard-team-tab.js');
    const s = SRC.indexOf('      async function loadTeamMembers() {');
    const fn = s >= 0 ? SRC.slice(s, SRC.indexOf('\n      }\n', s) + 9) : '';
    ok('loadTeamMembers found (positive control)', fn.length > 2000);
    async function run(claims, uid) {
      const list = { innerHTML: '' };
      const invite = { hidden: false };
      const seat = { panel: 0, buy: 0 };
      const members = [
        { email: 'a@a.test', role: 'sales_rep', status: 'active' },
        { email: 'b@a.test', role: 'viewer', status: 'invited' },
        { email: 'c@a.test', role: 'manager', status: 'disabled' },
      ];
      const sandbox = {
        window: { _user: { uid }, _userClaims: claims, db: {}, collection: () => ({}),
          getDocs: async () => ({ empty: false, docs: members.map((m) => ({ id: m.email, data: () => m })) }) },
        document: { getElementById: (id) => ({ teamMembersList: list, teamInviteForm: invite }[id] || null) },
        _teamOwnerMod: async () => null,
        _nbdEscHtml: (x) => String(x),
        _renderSeatPanel: () => { seat.panel++; },
        _renderSeatBuy: () => { seat.buy++; },
        console: { warn() {} },
        Date,
      };
      vm.createContext(sandbox);
      vm.runInContext(fn + '\nglobalThis.__p = loadTeamMembers();', sandbox);
      await sandbox.__p;
      return { html: list.innerHTML, invite, seat };
    }
    const rep = await run({ role: 'sales_rep', companyId: 'OWNER' }, 'REP');
    ok('a sales rep still sees the roster', /a@a\.test/.test(rep.html) && /c@a\.test/.test(rep.html));
    ok('…but no Disable / Remove / Cancel invite buttons', !/data-team-action=/.test(rep.html), (rep.html.match(/data-team-action="\w+"/g) || []).join(','));
    ok('…no invite form', rep.invite.hidden === true);
    ok('…and no seat controls', rep.seat.panel === 0 && rep.seat.buy === 0, JSON.stringify(rep.seat));
    const viewer = await run({ role: 'viewer', companyId: 'OWNER' }, 'V');
    ok('a viewer gets no controls either', !/data-team-action=/.test(viewer.html) && viewer.invite.hidden === true);
    const owner = await run({}, 'OWNER');
    ok('the solo owner keeps Disable, Cancel invite and Remove (positive control)',
      /data-team-action="disable"/.test(owner.html) && /data-team-action="cancel"/.test(owner.html) && /data-team-action="remove"/.test(owner.html));
    ok('…the invite form', owner.invite.hidden === false);
    ok('…and the seat controls', owner.seat.panel === 1 && owner.seat.buy === 1);
    const ca = await run({ role: 'company_admin', companyId: 'OWNER' }, 'CA');
    ok('a company_admin keeps the controls (the server allows them)', /data-team-action="disable"/.test(ca.html) && ca.invite.hidden === false);
    const html = fs.readFileSync(path.join(ROOT, 'docs', 'pro', 'dashboard.html'), 'utf8');
    ok('the invite form carries the id the gate hides', /<div id="teamInviteForm"[^>]*>[\s\S]{0,200}Invite a Rep/.test(html));
  }

  console.log('BUSINESS RULES READ-ONLY (ST-F50)');
  {
    const SRC = read('tenant-rules-settings.js');
    ok('render found (positive control)', SRC.indexOf('  function render() {') >= 0);
    function mkHost() {
      const els = [];
      const host = {
        attrs: {}, _html: '',
        set innerHTML(v) {
          this._html = v; els.length = 0;
          (v.match(/<(input|textarea)\b/g) || []).forEach(() => els.push({ disabled: false }));
          this._actions = /class="tr-actions"/.test(v) ? { innerHTML: (v.match(/<div class="tr-actions">([\s\S]*?)<\/div>$/) || ['', ''])[1] } : null;
        },
        get innerHTML() { return this._html; },
        setAttribute(k, v) { this.attrs[k] = String(v); },
        removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
        querySelectorAll(sel) { return sel === 'input, textarea' ? els : []; },
        querySelector(sel) { return sel === '.tr-actions' ? this._actions : null; },
        els,
      };
      return host;
    }
    function run(claims, uid) {
      const host = mkHost();
      const win = {
        _user: uid ? { uid } : null, _userClaims: claims, _companyProfileLoaded: true,
        NBDTenantRules: { resolved: () => ({ enabled: ['good'], tiers: { good: { label: 'Good' } }, deposit: {} }) },
      };
      win.window = win;
      const sandbox = { window: win, document: { getElementById: (id) => (id === 'tenantRulesPanel' ? host : null), addEventListener() {}, readyState: 'complete' },
        setTimeout() {}, console };
      vm.createContext(sandbox);
      vm.runInContext(SRC, sandbox); // renders once at load
      if (win.NBDTenantRulesSettings) win.NBDTenantRulesSettings.render();
      return host;
    }
    const rep = run({ role: 'sales_rep', companyId: 'OWNER' }, 'REP');
    ok('the panel renders for a rep (positive control)', rep.getAttribute('data-state') === 'ready', JSON.stringify(rep.attrs));
    ok('a rep\'s Business Rules fields are disabled', rep.els.length > 3 && rep.els.every((e) => e.disabled), rep.els.filter((e) => e.disabled).length + '/' + rep.els.length);
    ok('…and Save is replaced by who can change them', !!rep._actions && /Only an owner or company admin/.test(rep._actions.innerHTML) && !/tenantRulesSave/.test(rep._actions.innerHTML));
    const owner = run({}, 'OWNER');
    ok('the owner keeps an editable form with Save (positive control)', owner.els.length > 3 && owner.els.every((e) => !e.disabled) && /tenantRulesSave/.test(owner.innerHTML));
    const viewer = run({ role: 'viewer' }, 'V');
    ok('a viewer is read-only even without a companyId', viewer.els.every((e) => e.disabled));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
