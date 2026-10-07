/**
 * tests/estimate-hub-controls.test.js — the per-customer Estimates hub must not
 * hide a destructive action behind a benign label, and must not report success
 * for an action whose result the rep will never see.
 *
 * 1. "🗄 Archive" dispatched deleteEstimateAction -> window._deleteEstimate ->
 *    deleteDoc(). An archive box is the universal "filed away, still there"
 *    affordance; this permanently destroyed the document. The confirm did say
 *    "This cannot be undone", so the control contradicted itself — and the
 *    reassuring half is the part a rep reads first. The dashboard's own
 *    estimates list already calls this exact action "delete"; the hub was the
 *    outlier.
 *
 *    Relabelled rather than converted to a soft delete on purpose: the tenant
 *    estimates snapshots that populate window._estimates apply no `deleted`
 *    filter, so a soft-deleted estimate would stay visible on the dashboard and
 *    Archive would merely look broken instead. A real archive means updating
 *    those readers first — a feature, not a bug fix. This test pins the reason,
 *    so if someone adds the filter later they can see the constraint has lifted.
 *
 * 2. "⎘ Copy" routed to duplicateEstimateAction, whose underlying
 *    _duplicateEstimate deliberately sets `leadId = null` so the copy can be
 *    assigned from the dashboard list — the right default THERE. In a hub that
 *    lists by leadId, the copy was filtered straight out: the rep got
 *    "✓ Estimate duplicated", an unchanged list and an unchanged count.
 *
 * 3. "👤 Assign" (estimate-crm-ops.js's showAssignLeadPicker, opened from the
 *    hub via customer-estimate-hub.js:539) called
 *    window.__NBD_CALL_REGISTRY._assignEstimateToLead with no existence guard.
 *    That function is registered only by dashboard-bootstrap.module.js, which
 *    customer.html never loads (it loads customer-bootstrap.module.js instead)
 *    — so on the customer page the picker opened, the modal closed on
 *    Unassign/a lead click, and the call threw inside an unguarded async
 *    handler: an unhandled rejection, no toast, no assignment. Fixed with the
 *    same typeof-guard-then-toast pattern _deleteEstimate/_renameEstimate
 *    already use in this file, rather than duplicating the ~90-line
 *    money/pipeline stamp-back logic onto a second page (see
 *    docs/dev/globals-tranche3-plan.md's 2026-09-18 estimate-CRUD-edge note —
 *    Duplicate/Delete/Rename are ALSO dashboard-bootstrap-only and were
 *    already degrading to a toast instead of working; Assign now matches).
 *
 * Zero deps.  Run: node tests/estimate-hub-controls.test.js
 */
'use strict';

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PRO_JS = path.join(ROOT, 'docs/pro/js');
const read = (p) => fs.readFileSync(path.join(PRO_JS, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const decomment = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

console.log('ESTIMATE HUB — destructive label honesty + copy attachment');

const HUB = read('customer-estimate-hub.js');
const HUB_CODE = decomment(HUB);

// ── 1. The destructive control says what it does ──────────────────────
{
  // 2026-10-06 (after R5-8-2 #2286): the action is a soft delete now, so the
  // button is honestly an Archive again and the confirm must say so. The old
  // "cannot be undone" wording described the deleteDoc and is now false.
  ok('the hub button is labelled "Archive" (it soft-deletes since R5-8-2)',
    /data-ceh-act="archive"[^>]*>🗄 Archive</.test(HUB_CODE),
    'the action archives; a Delete label overstates it');
  ok('the hub button is no longer labelled "Delete"',
    !/>🗑 Delete</.test(HUB_CODE));
  const OPS1 = decomment(read('estimate-crm-ops.js'));
  const delBody = (OPS1.match(/async function deleteEstimateAction\(id\) \{[\s\S]*?\n\}/) || [''])[0];
  ok('deleteEstimateAction\'s confirm says the estimate is archived and removed from totals',
    /_ask\('Archive "' \+ label \+ '"\? It will be removed from your estimate lists and from this customer\\'s totals\.'\)/.test(delBody),
    delBody.slice(0, 400));
  ok('deleteEstimateAction\'s confirm no longer claims it "cannot be undone"',
    delBody.length > 0 && !/cannot be undone/i.test(delBody));
  ok('the success toast says archived, not deleted',
    /Estimate archived/.test(delBody) && !/Estimate deleted/.test(delBody));
  const WIDGETS = decomment(read('dashboard-widgets.js'));
  ok('the dashboard estimates-list button (same action) is titled Archive, selector unchanged',
    /data-act="delete" title="Archive estimate"/.test(WIDGETS) && !/title="Delete estimate"/.test(WIDGETS));

  // The action it dispatches must still be the real delete — relabelling would
  // be worse than useless if the wiring silently changed too.
  ok('it still dispatches deleteEstimateAction',
    /case 'archive':\s*withEstimates\('deleteEstimateAction'/.test(HUB_CODE));

  // Review R5-8-2 (2026-10-06): _deleteEstimate is now a SOFT delete through
  // estimate-lead-sync.js (same write as the customer page's Archive, plus the
  // lead primary/jobValue sync), and the dashboard estimates readers drop
  // deleted:true. The hub label went back to "Archive" on 2026-10-06 (above).
  // Globals Tranche 3 T3-C (2026-09-18): real declaration now, not window.X.
  const boot = read('dashboard-bootstrap.module.js');
  ok('_deleteEstimate is a soft delete through archiveEstimateAndSyncLead (no deleteDoc)',
    /async function _deleteEstimate\(id\) \{[\s\S]{0,1200}archiveEstimateAndSyncLead\(/.test(boot)
      && !/async function _deleteEstimate\(id\) \{[\s\S]{0,1200}deleteDoc\(doc\(db, 'estimates', id\)\)/.test(boot),
    'R5-8-2: never deleteDoc an estimate');

  // The constraint that made relabel (not soft-delete) the right call. Scope
  // this to the ESTIMATES listeners specifically — dashboard-bootstrap also
  // queries where('deleted','==',true) against /leads for the trash view, and a
  // whole-file grep matches that and reports the opposite of the truth.
  const estQueryLines = boot.split('\n').filter((l) => /collection\(db, ?'estimates'\)/.test(l));
  // The filter is applied client-side (filter(e => e.deleted !== true)), not as
  // a where() — a where('deleted', ...) would also drop every estimate that has
  // no `deleted` field at all.
  ok('the tenant estimates queries apply no where(\'deleted\') (filtered client-side instead)',
    estQueryLines.length > 0 && !estQueryLines.some((l) => /where\('deleted'/.test(l)),
    'a where on deleted hides every estimate without the field');
}

// ── 2. A duplicate made from a customer stays with that customer ──────
{
  ok('the hub no longer routes Copy through the unassigning generic action',
    !/case 'duplicate':\s*withEstimates\('duplicateEstimateAction'/.test(HUB_CODE),
    'that path nulls leadId, so the copy is filtered out of this leadId-listed hub');
  ok('the hub has its own duplicate handler', /function doDuplicate\(id\)/.test(HUB_CODE));
  ok('the copy is attached to the hub\'s lead',
    /updateDoc\(window\.doc\(window\.db, 'estimates', newId\), \{ leadId: lead \}\)/.test(HUB_CODE));
  ok('the lead is pinned before the async duplicate (not read back later)',
    /var lead = _leadId;/.test(HUB_CODE));
  ok('the in-memory copy is patched so the repaint shows it',
    /arr\[i\]\.leadId = lead;/.test(HUB_CODE),
    'the hub renders from window._estimates and the reload races the attach');
  ok('success is only claimed once the copy is actually attached',
    /Estimate duplicated, but not attached to this customer/.test(HUB_CODE),
    'a failed attach must not toast plain success — the rep would go looking for it');

  // The generic action must KEEP its unassigning behaviour: it is correct on
  // the dashboard list, which is a different surface with a different meaning.
  const boot = read('dashboard-bootstrap.module.js');
  ok('the dashboard duplicate still intentionally leaves the copy unassigned',
    /copy\.leadId = null;/.test(boot),
    'this fix must not change the dashboard-list default');
}

// ── 3. Assign is guarded against the dashboard-only registry entry ────
{
  const OPS = read('estimate-crm-ops.js');
  const OPS_CODE = decomment(OPS);

  // Both call sites inside showAssignLeadPicker — the "Unassign" button and
  // a lead row — must guard before calling into the registry.
  const guardedCallRe =
    /var _nbdReg = window\.__NBD_CALL_REGISTRY;\s*if \(!_nbdReg \|\| typeof _nbdReg\._assignEstimateToLead !== 'function'\) \{\s*showToast\([^)]*'error'\);\s*return;\s*\}\s*const ok = await _nbdReg\._assignEstimateToLead\(estimateId, (null|lead\.id)\);/g;
  const guardedCalls = OPS_CODE.match(guardedCallRe) || [];
  ok('both showAssignLeadPicker call sites guard _assignEstimateToLead before calling it',
    guardedCalls.length === 2,
    `found ${guardedCalls.length} guarded call sites, expected 2 (Unassign button + lead row click)`);

  ok('no call site invokes _assignEstimateToLead straight off window.__NBD_CALL_REGISTRY (unguarded)',
    !/window\.__NBD_CALL_REGISTRY\._assignEstimateToLead\(/.test(OPS_CODE),
    'the guarded form reads the registry into _nbdReg first and calls _nbdReg._assignEstimateToLead — a direct window.__NBD_CALL_REGISTRY._assignEstimateToLead(...) call bypasses the guard and reintroduces the unhandled-rejection bug');

  ok('a missing _assignEstimateToLead shows an error toast, not a silent no-op',
    (OPS_CODE.match(/showToast\('Assign not available on this page/g) || []).length === 2);

  // Root cause stays true: _assignEstimateToLead is dashboard-bootstrap-only.
  // If a future migration moves/mirrors it onto customer-bootstrap.module.js
  // (or registers a customer.html fallback), this guard becomes dead code
  // worth revisiting — not a false alarm.
  const dashBoot = read('dashboard-bootstrap.module.js');
  const custBoot = read('customer-bootstrap.module.js');
  ok('_assignEstimateToLead is still defined in dashboard-bootstrap.module.js',
    /async function _assignEstimateToLead\(id, leadId\)/.test(dashBoot));
  ok('_assignEstimateToLead is still absent from customer-bootstrap.module.js',
    !/_assignEstimateToLead/.test(custBoot),
    'if this now exists, the guard added here may no longer be the right fix — re-check whether Assign can just work on customer.html');
}

console.log('\n──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
