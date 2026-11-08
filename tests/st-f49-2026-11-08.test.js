/**
 * tests/st-f49-2026-11-08.test.js — CRM audit 2026-11-06, ST-F49.
 *
 * dashboard-api.js window._gdprRequestErasure() chose its close-account
 * warning from the companyId claim alone (claim set and != my uid = "team
 * member, you will be SUSPENDED"). An owner hand-off (transferCompanyOwnership)
 * keeps the company id, which is the former owner's uid, and moves
 * companies/{id}.ownerId to the new owner. The server decides member vs owner
 * from that ownerId (functions/integrations/erasure-scope.js: isOwner =
 * ownerId ? ownerId === uid : companyId === uid), so after a hand-off the
 * warning said the opposite of what the server does: the new owner read
 * "suspended", the former owner read "permanently delete".
 *
 * The warning now reads companies/{claim companyId}.ownerId when it can and
 * falls back to the claim comparison when the read fails or names no owner.
 * Only the two existing warnings are chosen between. Real code in a vm.
 * Zero deps. Run: node tests/st-f49-2026-11-08.test.js
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
const SRC = fs.readFileSync(path.join(JS, 'dashboard-api.js'), 'utf8').replace(/\r\n/g, '\n');
const s = SRC.indexOf('window._gdprRequestErasure = async function');
const e = s >= 0 ? SRC.indexOf('\n};', s) : -1;
const block = s >= 0 && e > s ? SRC.slice(s, e + 3) : '';

const SUSPEND = /SUSPENDED, not deleted/;
const DELETE = /PERMANENTLY DELETE/;

// opts.companies: { id: data | null } (null = doc missing); opts.getDocThrows;
// opts.noFirestore: leave getDoc/doc off window (pages that never wired them).
async function run(opts) {
  let seen = null;
  const reads = [];
  const win = {
    _user: { uid: opts.uid },
    _userClaims: opts.claims,
    db: { name: 'db' },
    nbdConfirm: async (m) => { seen = m; return false; },
  };
  if (!opts.noFirestore) {
    win.doc = (db, col, id) => ({ db, col, id });
    win.getDoc = async (ref) => {
      reads.push(ref.col + '/' + ref.id);
      if (opts.getDocThrows) throw new Error('Missing or insufficient permissions');
      const data = Object.prototype.hasOwnProperty.call(opts.companies || {}, ref.id) ? opts.companies[ref.id] : null;
      return { exists: () => data != null, data: () => data };
    };
  }
  const ctx = vm.createContext({ window: win, showToast() {}, console: { log() {}, warn() {}, error() {} } });
  vm.runInContext(block, ctx);
  await win._gdprRequestErasure();
  return { msg: seen || '', reads };
}

(async function main() {
  console.log('CLOSE-ACCOUNT WARNING AFTER AN OWNER HAND-OFF (ST-F49)');
  ok('_gdprRequestErasure found (positive control)', /requestAccountErasure/.test(block));

  // (a) New owner after a hand-off: the company id is the former owner's uid.
  const newOwner = await run({ uid: 'newo', claims: { companyId: 'fo', role: 'company_admin' }, companies: { fo: { ownerId: 'newo' } } });
  ok('the new owner (claim = former owner\'s uid, ownerId = me) sees the delete warning, not the suspend one',
    DELETE.test(newOwner.msg) && !SUSPEND.test(newOwner.msg), newOwner.msg.slice(0, 80));
  ok('the owner check reads companies/{claim companyId}', newOwner.reads.length === 1 && newOwner.reads[0] === 'companies/fo', JSON.stringify(newOwner.reads));

  // (b) Former owner: their claim still equals their own uid, ownerId moved on.
  const formerOwner = await run({ uid: 'fo', claims: { companyId: 'fo', role: 'company_admin' }, companies: { fo: { ownerId: 'newo' } } });
  ok('the former owner (claim = my uid, ownerId = someone else) sees the suspend warning, not the delete one',
    SUSPEND.test(formerOwner.msg) && !DELETE.test(formerOwner.msg), formerOwner.msg.slice(0, 80));

  // Controls: an ordinary member and an ordinary solo owner keep today's copy.
  const member = await run({ uid: 'rep', claims: { companyId: 'co-a', role: 'sales_rep' }, companies: { 'co-a': { ownerId: 'boss' } } });
  ok('control: an ordinary member still sees the suspend warning', SUSPEND.test(member.msg) && !DELETE.test(member.msg));
  const solo = await run({ uid: 'solo', claims: { companyId: 'solo' }, companies: { solo: { ownerId: 'solo' } } });
  ok('control: a solo owner still sees the delete warning', DELETE.test(solo.msg) && !SUSPEND.test(solo.msg));

  // (c) The read fails: fall back to the claim comparison, both ways.
  const deniedMember = await run({ uid: 'rep', claims: { companyId: 'co-a' }, getDocThrows: true });
  ok('a failed company read falls back to the claim (claim != uid: suspend)', SUSPEND.test(deniedMember.msg), deniedMember.msg.slice(0, 80));
  const deniedSolo = await run({ uid: 'solo', claims: { companyId: 'solo' }, getDocThrows: true });
  ok('a failed company read falls back to the claim (claim == uid: delete)', DELETE.test(deniedSolo.msg), deniedSolo.msg.slice(0, 80));

  // A missing doc, or one with no usable ownerId, also falls back (server: ownerId ? ... : companyId === uid).
  const noDoc = await run({ uid: 'rep', claims: { companyId: 'co-a' }, companies: {} });
  ok('no company doc falls back to the claim (suspend)', SUSPEND.test(noDoc.msg));
  const noOwner = await run({ uid: 'solo', claims: { companyId: 'solo' }, companies: { solo: { name: 'Acme' } } });
  ok('a company doc with no ownerId falls back to the claim (delete)', DELETE.test(noOwner.msg));
  const badOwner = await run({ uid: 'rep', claims: { companyId: 'co-a' }, companies: { 'co-a': { ownerId: 42 } } });
  ok('a non-string ownerId is ignored like the server ignores it (claim fallback: suspend)', SUSPEND.test(badOwner.msg));

  // No companyId claim: nothing to read, today's delete warning.
  const noClaim = await run({ uid: 'solo', claims: {}, companies: {} });
  ok('no companyId claim: no company read, delete warning', noClaim.reads.length === 0 && DELETE.test(noClaim.msg), JSON.stringify(noClaim.reads));

  // A page without getDoc/doc on window (typeof guard): claim comparison, no throw.
  const bare = await run({ uid: 'rep', claims: { companyId: 'co-a' }, noFirestore: true });
  ok('without window.getDoc/doc the claim comparison still decides (suspend)', SUSPEND.test(bare.msg));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
