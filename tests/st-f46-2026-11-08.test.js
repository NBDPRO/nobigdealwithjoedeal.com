/**
 * tests/st-f46-2026-11-08.test.js — Settings > Team can invite a Company Admin
 * (CRM audit 2026-11-06, ST-F46).
 *
 * THE BUG: the "Invite a Rep" role select (#inviteRepRole) offered Sales Rep /
 * Manager / Viewer only. The server's createTeamInvite accepts company_admin
 * (INVITE_ALLOWED_ROLES in functions/handlers/_shared.js), onRepSignup and
 * claimInvite keep it, and Team Manager's own create / edit selects offer it:
 * only this invite form could not.
 *
 * THE FIX: #inviteRepRole lists every role the invite allowlist accepts, as
 * Team Manager does. inviteTeamMember (dashboard-team-tab.js) passes the value
 * through unchanged; the server still gates who may invite (requireTeamAdmin).
 *
 * Reads the real dashboard.html and the server allowlist source (no functions/
 * deps needed). Zero deps. Run: node tests/st-f46-2026-11-08.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('docs/pro/dashboard.html');
const SHARED = read('functions/handlers/_shared.js');
const INVITES = read('functions/handlers/invites.js');
const TEAM_TAB = read('docs/pro/js/dashboard-team-tab.js');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
function selectOptions(id) {
  const m = HTML.match(new RegExp('<select[^>]*\\bid="' + id + '"[^>]*>([\\s\\S]*?)</select>'));
  if (!m) return null;
  return [...m[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((x) => [x[1], x[2]]);
}
const sorted = (a) => a.slice().sort();

console.log('\nST-F46 — the invite form offers every role the invite accepts');
const allowSrc = (SHARED.match(/const INVITE_ALLOWED_ROLES = new Set\(\[([^\]]*)\]\)/) || [])[1] || '';
const allowed = [...allowSrc.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
ok('control: INVITE_ALLOWED_ROLES parsed from functions/handlers/_shared.js', allowed.length >= 4 && allowed.includes('company_admin'), allowed.join());
ok('control: createTeamInvite checks the role against INVITE_ALLOWED_ROLES', /createTeamInvite[\s\S]*?INVITE_ALLOWED_ROLES\.has\(role\)/.test(INVITES));
ok('control: inviteTeamMember sends the select value through unchanged', /getElementById\('inviteRepRole'\)\?\.value \|\| 'sales_rep'/.test(TEAM_TAB) && /inviteFn\(\{ email: [^}]*role: role \}\)/.test(TEAM_TAB));

const invite = selectOptions('inviteRepRole') || [];
const values = invite.map((o) => o[0]);
ok('control: #inviteRepRole is found', invite.length >= 3, JSON.stringify(invite));
ok('#inviteRepRole offers exactly the roles the invite allowlist accepts', JSON.stringify(sorted(values)) === JSON.stringify(sorted(allowed)), values.join() + ' vs ' + allowed.join());
ok('…including Company Admin, labelled as in Team Manager', invite.some((o) => o[0] === 'company_admin' && o[1] === 'Company Admin'), JSON.stringify(invite));
ok('Sales Rep stays the first (default) choice', values[0] === 'sales_rep', values[0]);
ok('the platform admin role is never offered', !values.includes('admin'));

const create = (selectOptions('adminNewRole') || []).map((o) => o[0]);
const edit = (selectOptions('adminEditRole') || []).map((o) => o[0]);
ok('same role set as Team Manager\'s create and edit selects', create.length > 0 && JSON.stringify(sorted(values)) === JSON.stringify(sorted(create)) && JSON.stringify(sorted(values)) === JSON.stringify(sorted(edit)),
  values.join() + ' / ' + create.join() + ' / ' + edit.join());

console.log('\n──────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
process.exit(0);
