/**
 * tests/silent-failures-2026-11-06.test.js — CRM audit 2026-11-06: screens
 * that said "saved" / "All clear" when they weren't.
 *
 * Behaviour (real code in a vm):
 *   PL-F13 dashboard-bootstrap _loadDeletedLeads + crm-portal-bridge
 *          renderDeletedDrawer: a failed read showed "All Clear"; before auth it
 *          returned undefined and the drawer stuck on "Loading…"; a manager
 *          never saw a teammate's deleted lead.
 *   VW-F51 nbd-doc-viewer handleSave: "✓ Document saved" after a document that
 *          was never attached to the customer.
 * Source checks (thin UI branches, asserted on the shipped text):
 *   ST-F05 Company info / Notification preferences "✓ saved" after a failed
 *          server write → "Saved on this device only".
 *   VW-F157 Agent Inbox "All clear" after a failed load → "Could not load".
 *   VW-F158 voicemail "✓ Voicemail saved" when the timeline write failed.
 *   VW-F01 Prospects blank forever for a company with zero leads.
 * Zero deps. Run: node tests/silent-failures-2026-11-06.test.js
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
const read = (f) => fs.readFileSync(path.join(JS, f), 'utf8');
function slice(src, start, endAt) {
  const s = src.indexOf(start);
  if (s < 0) return '';
  const e = src.indexOf(endAt, s);
  return e < 0 ? '' : src.slice(s, e + endAt.length);
}

(async () => {
  console.log('DELETED BIN (PL-F13)');
  {
    const BOOT = read('dashboard-bootstrap.module.js');
    const eol = BOOT.includes('\r\n') ? '\r\n' : '\n';
    const fn = slice(BOOT, '  async function _loadDeletedLeads() {', eol + '  }' + eol);
    const BR = read('crm-portal-bridge.js');
    const beol = BR.includes('\r\n') ? '\r\n' : '\n';
    const draw = slice(BR, 'async function renderDeletedDrawer() {', beol + '}' + beol);
    ok('both functions found (positive control)', fn.length > 100 && draw.length > 100);
    const run = async (opts) => {
      const queries = [];
      const body = { innerHTML: '' };
      const win = { _user: opts.uid ? { uid: opts.uid } : null, _userClaims: opts.claims || {} };
      const sandbox = { window: win, console: { log() {}, warn() {}, error() {} }, Object, db: {},
        collection: (d, c) => c, where: (f, op, v) => ({ f, v }), limit: (n) => ({ limit: n }),
        query: (c, ...fs2) => ({ c, fs: fs2 }),
        getDocs: async (q) => { queries.push(q); if (opts.fail) throw Object.assign(new Error('offline'), { code: 'unavailable' });
          const scope = q.fs.find((x) => x.f === 'userId' || x.f === 'companyId');
          return { docs: (opts.docs || []).filter((d) => d[scope.f] === scope.v).map((d) => ({ id: d.id, data: () => d })) }; },
        document: { getElementById: () => body }, escHtml: (s) => String(s) };
      vm.createContext(sandbox);
      vm.runInContext(fn + '\nwindow.__NBD_CALL_REGISTRY = { _loadDeletedLeads };\n' + draw, sandbox);
      const loaded = await sandbox.window.__NBD_CALL_REGISTRY._loadDeletedLeads();
      let drawErr = null;
      try { await sandbox.renderDeletedDrawer(); } catch (e) { drawErr = e; }
      return { loaded, html: body.innerHTML, queries, drawErr };
    };
    const off = await run({ uid: 'u1', fail: true });
    ok('a failed read returns null, not []', off.loaded === null);
    ok('…and the drawer says it could not load, not "All Clear"', /Could not load deleted leads/.test(off.html) && !/All Clear/.test(off.html), off.html.slice(0, 80));
    const pre = await run({ uid: null });
    // Since the steward review of #2949: before sign-in the loader returns
    // undefined ("not looked yet"), and the drawer keeps "Loading..." instead
    // of "All Clear".
    ok('before sign-in it returns undefined, the drawer keeps "Loading..." (never "All Clear") and does not throw',
      pre.loaded === undefined && /Loading/.test(pre.html) && !/All Clear/.test(pre.html) && !pre.drawErr, pre.html.slice(0, 60));
    // Restore / Remove only where firestore.rules allows them on that lead.
    const bin = [{ id: 'mine', userId: 'u1', companyId: 'co' }, { id: 'teammate', userId: 'u2', companyId: 'co' }];
    const btns = (html, id) => ({ restore: new RegExp('nbd-dc-restore" data-id="' + id + '"').test(html), remove: new RegExp('nbd-dc-perm" data-id="' + id + '"').test(html) });
    const asViewer = await run({ uid: 'u1', claims: { role: 'viewer', companyId: 'co' }, docs: bin });
    ok('a viewer sees the bin but no Restore / Remove at all', !/nbd-dc-restore|nbd-dc-perm/.test(asViewer.html) && /teammate|deleted-card/.test(asViewer.html));
    const asMgr = await run({ uid: 'u1', claims: { role: 'manager', companyId: 'co' }, docs: bin });
    ok('a manager can Restore a teammate\'s lead but not Remove it (rules: delete is company_admin)', btns(asMgr.html, 'teammate').restore && !btns(asMgr.html, 'teammate').remove);
    ok('…and keeps both on their own lead (positive control)', btns(asMgr.html, 'mine').restore && btns(asMgr.html, 'mine').remove);
    const asAdmin = await run({ uid: 'u1', claims: { role: 'company_admin', companyId: 'co' }, docs: bin });
    ok('a company_admin keeps both on a teammate\'s lead', btns(asAdmin.html, 'teammate').restore && btns(asAdmin.html, 'teammate').remove);
    const mgr = await run({ uid: 'u1', claims: { role: 'manager', companyId: 'co' },
      docs: [{ id: 'mine', userId: 'u1', companyId: 'co' }, { id: 'teammate', userId: 'u2', companyId: 'co' }] });
    ok('a manager sees a teammate\'s deleted lead (company scope)', mgr.loaded.map((d) => d.id).sort().join(',') === 'mine,teammate', JSON.stringify(mgr.loaded));
    ok('every read is capped', mgr.queries.every((q) => q.fs.some((x) => x && x.limit)));
    const rep = await run({ uid: 'u1', claims: { role: 'sales_rep', companyId: 'co' }, docs: [{ id: 'mine', userId: 'u1' }, { id: 'teammate', userId: 'u2', companyId: 'co' }] });
    ok('a sales rep reads only their own deletes', rep.loaded.map((d) => d.id).join(',') === 'mine');
  }

  console.log('DOCUMENT VIEWER SAVE (VW-F51)');
  {
    const V = read('nbd-doc-viewer.js');
    const eol = V.includes('\r\n') ? '\r\n' : '\n';
    const fn = slice(V, '  async function handleSave() {', eol + '  }' + eol);
    ok('handleSave found (positive control)', fn.length > 100);
    const run = async (result) => {
      const toasts = [];
      const flashes = [];
      const sandbox = { window: { showToast: (m, k) => toasts.push(k + ':' + m) }, console: { log() {}, warn() {}, error() {} },
        currentContext: { onSave: async () => result }, dirty: true, flashStatus: (m) => flashes.push(m), finalizeSignaturesIfPresent: async () => null };
      vm.createContext(sandbox);
      vm.runInContext('var currentContext = globalThis.currentContext; var dirty = true;\n' + fn + '\nglobalThis.__s = handleSave;', sandbox);
      await sandbox.__s();
      return { toasts, flashes };
    };
    const saved = await run(true);
    ok('an attached document still says saved (positive control)', saved.toasts.some((t) => /Document saved/.test(t)));
    const not = await run({ notSaved: true });
    ok('a document never attached does NOT say "Document saved"', !not.toasts.some((t) => /Document saved/.test(t)), not.toasts.join(' | '));
    ok('…the viewer says "Not saved to the customer"', not.flashes.indexOf('Not saved to the customer') !== -1);
    const DG = read('document-generator.js');
    ok('the generator reports notSaved when nothing was attached', /return attachedToLead \? true : \{ notSaved: true \};/.test(DG));
  }

  console.log('SOURCE CHECKS: ST-F05, VW-F157, VW-F158, VW-F01');
  {
    const BOOT = read('dashboard-bootstrap.module.js');
    ok('Company info: a failed sync says "Saved on this device only"', /_coSyncFailed = true/.test(BOOT) && /_coSyncFailed \? 'Saved on this device only/.test(BOOT));
    ok('Notifications: same', /_ntSyncFailed = true/.test(BOOT) && /_ntSyncFailed \? 'Saved on this device only/.test(BOOT));
    ok('…and neither catch is silent any more', !/\{ notifications: data, updatedAt: new Date\(\)\.toISOString\(\) \},\s*\{ merge: true \}\s*\);\s*\}\s*\} catch \(e\) \{\}/.test(BOOT));
    const AI = read('agent-inbox.js');
    ok('Agent Inbox flags a failed load', /_items = \[\]; _loadFailed = true;/.test(AI));
    ok('…and paints "Could not load" instead of "All clear"', /_loadFailed \? 'Could not load' : 'All clear'/.test(AI) && /Could not load the inbox/.test(AI));
    const VM = read('voicemail.js');
    ok('voicemail: success toast only with an activity id', /if \(activityId\) toast\(`✓ Voicemail saved/.test(VM) && /NOT saved to the customer timeline/.test(VM));
    const PR = read('prospects.js');
    ok('Prospects renders once the wait ends, even with zero leads', /setTimeout\(\(\) => \{ clearInterval\(t\); render\(\); \}, 8000\);/.test(PR));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
