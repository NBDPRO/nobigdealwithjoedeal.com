/**
 * tests/bulk-carrier-field-2026-09-28.test.js
 *
 * CRM sweep R14 (2026-09-28) — kanban bulk "Set carrier" / bulk counts.
 *
 * THE BUG: bulkAssignCarrier wrote `carrier`, but the lead form, claim core,
 * card detail, photo report and KY-law checks read `insCarrier` FIRST — so a
 * bulk-set carrier was invisible on every lead that already had one, and the
 * Edit Lead form never showed it (its next save kept the old insCarrier).
 * Bulk delete / bulk set also toasted ids.length even when teammate-owned
 * leads were skipped by commitBulkLeadOp.
 *
 * THE FIX: bulk carrier writes insCarrier; the toasts report `applied`.
 *
 * Runs the REAL bulkAssignCarrier / bulkAssignField / bulkDelete /
 * commitBulkLeadOp (+ the allowlist) lifted out of crm-portal-bridge.js in a
 * vm with a fake writeBatch. Break-test: against main these go red.
 *
 * Zero deps. Run: node tests/bulk-carrier-field-2026-09-28.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/crm-portal-bridge.js'), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function extractFn(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) return '';
  const open = src.indexOf('{', start + sig.length - 1);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const allow = (SRC.match(/^const BULK_LEAD_FIELDS = new Set\([^\n]*\);$/m) || [''])[0];
const code = [allow,
  extractFn(SRC, 'async function commitBulkLeadOp('),
  extractFn(SRC, 'async function bulkAssignField('),
  extractFn(SRC, 'async function bulkAssignCarrier('),
  extractFn(SRC, 'async function bulkDelete('),
].join('\n') + '\nglobalThis.api = { bulkAssignCarrier, bulkDelete };';

function rig(me, leads, selected, carrier) {
  const writes = [], toasts = [];
  const win = {
    _user: { uid: me }, _userClaims: { role: 'sales_rep' }, _leads: leads, _filteredLeads: null,
    db: {}, doc: (_db, c, id) => ({ id }),
    writeBatch: () => ({ update: (ref, patch) => writes.push({ id: ref.id, patch }), commit: async () => {} }),
    nbdConfirm: async () => true,
    showToast: (m, t) => toasts.push({ m: String(m), t }),
  };
  const ctx = vm.createContext({
    window: win, console: { error() {}, warn() {}, log() {} },
    document: { getElementById: (id) => (id === 'bulkCarrierSelect' ? { value: carrier } : null) },
    getBulkSelected: () => new Set(selected),
    showToast: win.showToast, renderLeads() {}, clearBulkSelection() {}, toggleBulkMode() {},
    loadLeads: async () => {}, _serverTimestamp: () => 'ts',
  });
  vm.runInContext(code, ctx);
  return { api: ctx.api, writes, toasts };
}

(async () => {
  console.log('BULK — carrier field');
  {
    const r = rig('me', [{ id: 'A', userId: 'me', insCarrier: 'Allstate' }], ['A'], 'State Farm');
    await r.api.bulkAssignCarrier();
    const p = r.writes[0] && r.writes[0].patch;
    ok('bulk "Set carrier" writes insCarrier (what the form and readers use)', !!p && p.insCarrier === 'State Farm', JSON.stringify(p));
    ok('…not the unread `carrier` field', !!p && !('carrier' in p));
  }

  console.log('BULK — counts report what was applied');
  {
    const leads = [{ id: 'A', userId: 'me' }, { id: 'B', userId: 'teammate' }];
    const r = rig('me', leads, ['A', 'B'], 'State Farm');
    await r.api.bulkAssignCarrier();
    const done = r.toasts.find((t) => /^Updated/.test(t.m));
    ok('a skipped teammate lead is not counted as updated', !!done && /^Updated 1 lead/.test(done.m), done && done.m);
    ok('…and only the own lead was written', r.writes.map((w) => w.id).join() === 'A');
  }
  {
    const leads = [{ id: 'A', userId: 'me' }, { id: 'B', userId: 'teammate' }];
    const r = rig('me', leads, ['A', 'B'], '');
    await r.api.bulkDelete();
    const done = r.toasts.find((t) => /^Deleted/.test(t.m));
    ok('bulk delete counts only the deleted leads', !!done && /^Deleted 1 lead/.test(done.m), done && done.m);
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
