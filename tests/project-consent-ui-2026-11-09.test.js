/**
 * tests/project-consent-ui-2026-11-09.test.js — the customer page's project-page
 * consent tick (content plan §2 step 1).
 *
 * leads/{id}.projectConsent = { on, by, at }. Only the owner side (platform
 * admin, the lead's company_admin, a solo operator who owns the lead) may set
 * or clear it; firestore.rules enforces that (projectConsentWriteOk, proved by
 * tests/firestore-rules.project-consent.test.js) and this UI mirrors it so a
 * manager or rep sees the state but no live checkbox.
 *
 * Boot budget: the customer page has ~10 bytes of shipped-JS headroom, so the
 * control costs no boot JS. The button dispatches ScriptLoader.load for
 * js/project-consent.js through the existing data-action delegate; the file
 * then re-points the button at NBDProjectConsent.open and opens the panel.
 *
 * Run: node tests/project-consent-ui-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/project-consent.js');
let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ ' + label + (extra ? '  >>> ' + extra : '')); }
}

// ── customer.html wiring ────────────────────────────────────────────
const html = fs.readFileSync(path.join(ROOT, 'docs/pro/customer.html'), 'utf8');
const btn = (html.match(/<button[^>]*id="projectConsentBtn"[^>]*>/) || [''])[0];
ok('customer.html has the #projectConsentBtn button', !!btn);
ok('the button loads the file lazily through ScriptLoader.load', /data-action="ScriptLoader\.load"/.test(btn) && /data-arg="js\/project-consent\.js\?v=\d+"/.test(btn), btn);
ok('customer.html has no <script> tag for project-consent.js (no boot cost)', !/<script[^>]+project-consent\.js/.test(html));
ok('customer.html has the #projectConsentPanel container, hidden', /<div[^>]*id="projectConsentPanel"[^>]*hidden/.test(html));
ok('no inline handler on the new markup', !/on[a-z]+=/i.test(btn));

// ── the file ────────────────────────────────────────────────────────
ok('docs/pro/js/project-consent.js exists', fs.existsSync(SRC_PATH));
if (!fs.existsSync(SRC_PATH)) { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
const src = fs.readFileSync(SRC_PATH, 'utf8');
ok('no inline handlers or style attributes in rendered markup', !/\son[a-z]+=|style="/i.test(src));
ok('no eval / new Function', !/\beval\(|new Function\(/.test(src));

function makeEl(id) {
  return { id, hidden: true, innerHTML: '', dataset: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = v; },
    removeAttribute(k) { delete this.attrs[k]; if (k.startsWith('data-')) delete this.dataset[k.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())]; },
    querySelector() { return null; } };
}
function boot(opts) {
  const els = { projectConsentBtn: makeEl('projectConsentBtn'), projectConsentPanel: makeEl('projectConsentPanel') };
  els.projectConsentBtn.setAttribute('data-action', 'ScriptLoader.load');
  els.projectConsentBtn.setAttribute('data-arg', 'js/project-consent.js?v=1');
  const writes = [];
  const toasts = [];
  const win = {
    _user: { uid: opts.uid },
    _userClaims: opts.claims || {},
    _customerId: opts.leadId || 'lead1',
    _currentLead: opts.lead,
    db: {},
    doc: (db, coll, id) => ({ path: coll + '/' + id }),
    updateDoc: async (ref, patch) => { writes.push({ ref, patch }); },
    serverTimestamp: () => ({ __sts: true }),
    showToast: (m, t) => toasts.push([m, t]),
    navigator: { clipboard: { writeText: async () => {} } },
  };
  win.window = win;
  const document = { getElementById: (id) => els[id] || null };
  const sandbox = { window: win, document, console, Promise, setTimeout, navigator: win.navigator };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'project-consent.js' });
  return { win, els, writes, toasts, P: win.NBDProjectConsent };
}

const owned = { companyId: 'co-a', userId: 'co-a' };
const repLead = { companyId: 'co-a', userId: 'rep1' };

(async () => {
  // canSet mirrors the rules' writer set (confirmedSourceRoleOk).
  const b0 = boot({ uid: 'co-a', claims: {}, lead: owned });
  const P = b0.P;
  ok('window.NBDProjectConsent is defined', !!P && typeof P.canSet === 'function');
  ok('solo owner (no role, own lead) CAN set', P.canSet({}, 'co-a', owned) === true);
  ok('solo owner with companyId == uid CAN set', P.canSet({ companyId: 'co-a' }, 'co-a', owned) === true);
  ok('company_admin of the lead\'s company CAN set', P.canSet({ role: 'company_admin', companyId: 'co-a' }, 'carol', owned) === true);
  ok('company_admin of another company CANNOT', P.canSet({ role: 'company_admin', companyId: 'co-b' }, 'eve', owned) === false);
  ok('platform admin CAN set', P.canSet({ role: 'admin' }, 'joe', owned) === true);
  ok('manager CANNOT', P.canSet({ role: 'manager', companyId: 'co-a' }, 'mike', owned) === false);
  ok('sales rep CANNOT, even on their own lead', P.canSet({ role: 'sales_rep', companyId: 'co-a' }, 'rep1', repLead) === false);
  ok('viewer CANNOT', P.canSet({ role: 'viewer', companyId: 'co-a' }, 'vera', owned) === false);
  ok('no-role user on a lead they do not own CANNOT', P.canSet({}, 'someone', owned) === false);
  ok('no-role user carrying a foreign companyId CANNOT', P.canSet({ companyId: 'co-z' }, 'co-a', owned) === false);
  ok('signed out CANNOT', P.canSet({}, null, owned) === false);

  // The patch is exactly the shared contract.
  const pt = P.patchFor(true, 'co-a', { __sts: true });
  ok('patchFor(true) = { projectConsent: { on: true, by, at } }', JSON.stringify(Object.keys(pt.projectConsent).sort()) === '["at","by","on"]' && pt.projectConsent.on === true && pt.projectConsent.by === 'co-a' && pt.projectConsent.at.__sts === true, JSON.stringify(pt));
  ok('patchFor(false) keeps the stamp with on: false', P.patchFor(false, 'co-a', 1).projectConsent.on === false);
  ok('isOn is true only for on === true', P.isOn({ projectConsent: { on: true } }) && !P.isOn({ projectConsent: { on: 'true' } }) && !P.isOn({}) && !P.isOn(null));

  // The draft command is only offered for a safe lead id.
  ok('commandFor builds the dry-run draft command', P.commandFor('abc_123-XY') === 'node scripts/draft-project-page.mjs --lead abc_123-XY', P.commandFor('abc_123-XY'));
  ok('commandFor refuses an id with shell characters', P.commandFor('a;rm -rf') === '' && P.commandFor('') === '');

  // Lazy hand-off: loading the file re-points the button and opens the panel.
  ok('on load the button now dispatches NBDProjectConsent.open', b0.els.projectConsentBtn.dataset.action === 'NBDProjectConsent.open' && b0.els.projectConsentBtn.dataset.arg === undefined, JSON.stringify(b0.els.projectConsentBtn.dataset));
  ok('on load the panel is open', b0.els.projectConsentPanel.hidden === false);
  ok('owner sees a live checkbox', /type="checkbox"/.test(b0.els.projectConsentPanel.innerHTML) && !/disabled/.test(b0.els.projectConsentPanel.innerHTML), b0.els.projectConsentPanel.innerHTML);

  // Owner ticks: one write with the contract shape.
  await P.setConsent(true);
  ok('owner tick writes leads/<id> once', b0.writes.length === 1 && b0.writes[0].ref.path === 'leads/lead1', JSON.stringify(b0.writes));
  const w = b0.writes[0] && b0.writes[0].patch.projectConsent;
  ok('the write is { on: true, by: uid, at: serverTimestamp() }', w && w.on === true && w.by === 'co-a' && w.at && w.at.__sts === true, JSON.stringify(b0.writes[0]));
  ok('the write touches projectConsent (and updatedAt) only', b0.writes[0] && Object.keys(b0.writes[0].patch).every((k) => k === 'projectConsent' || k === 'updatedAt'), JSON.stringify(b0.writes[0] && b0.writes[0].patch));
  ok('after ticking, the panel offers the draft command', /draft-project-page\.mjs --lead lead1/.test(b0.els.projectConsentPanel.innerHTML));

  // A manager sees the state but cannot write.
  const b1 = boot({ uid: 'mike', claims: { role: 'manager', companyId: 'co-a' }, lead: Object.assign({ projectConsent: { on: true, by: 'co-a', at: new Date('2026-11-01') } }, owned) });
  ok('manager sees a disabled checkbox', /type="checkbox"[^>]*disabled/.test(b1.els.projectConsentPanel.innerHTML), b1.els.projectConsentPanel.innerHTML);
  ok('manager sees that the owner sets it', /owner/i.test(b1.els.projectConsentPanel.innerHTML));
  await b1.P.setConsent(false);
  ok('manager setConsent writes nothing', b1.writes.length === 0);

  // Escaping: a hostile lead id never reaches the markup raw.
  const b2 = boot({ uid: 'co-a', claims: {}, lead: owned, leadId: '<img src=x>' });
  ok('a hostile lead id is not rendered raw', !/<img/.test(b2.els.projectConsentPanel.innerHTML));

  console.log('\nproject consent UI: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
