/**
 * tests/estimate-delete-lead-sync-2026-10-06.test.js — review finding R5-8-2.
 *
 * The dashboard's Delete hard-deleted an estimate (deleteDoc) and the customer
 * page's Archive soft-deleted it; neither touched the lead. lead.primaryEstimateId
 * kept pointing at the gone estimate and lead.jobValue kept its dollars, so the
 * pipeline card, KPI tiles and leaderboard still counted it and the next
 * estimate was treated as a revision of a ghost.
 *
 * Fix: docs/pro/js/estimate-lead-sync.js — archiveEstimateAndSyncLead()
 * soft-deletes and then fixes the lead through the pure
 * planLeadAfterEstimateRemoval(). Both pages call it.
 *
 * Part 1 runs the real module (behaviour). Part 2 checks the wiring in source,
 * comments stripped and scoped to the function body.
 *
 * Pure Node, no emulator. Run: node tests/estimate-delete-lead-sync-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function bodyAfter(src, anchor) {
  const at = src.indexOf(anchor);
  if (at === -1) return null;
  const open = src.indexOf('{', at + anchor.length - 1);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}

// Same two-shape reader the pages use (grandTotal, else total, else amount).
const estValue = (e) => Number(e && (e.grandTotal != null ? e.grandTotal : e.total != null ? e.total : e.amount)) || 0;
const ts = (ms) => ({ toMillis: () => ms });

(async () => {
  let M = null;
  try {
    M = await import(pathToFileURL(path.join(ROOT, 'docs', 'pro', 'js', 'estimate-lead-sync.js')).href);
  } catch (e) {
    ok('estimate-lead-sync.js loads', false, e && e.message);
  }

  // ── Part 1: planLeadAfterEstimateRemoval (pure) ─────────────────────────
  console.log('planLeadAfterEstimateRemoval');
  if (M && typeof M.planLeadAfterEstimateRemoval === 'function') {
    const plan = M.planLeadAfterEstimateRemoval;
    const A = { id: 'A', leadId: 'L1', grandTotal: 12000, createdAt: ts(3000) };
    const B = { id: 'B', leadId: 'L1', total: '9,500', createdAt: ts(2000) };
    const B2 = { id: 'B', leadId: 'L1', total: 9500, createdAt: ts(2000) };
    const C = { id: 'C', leadId: 'L1', amount: 7000, createdAt: ts(1000) };
    const DEL = { id: 'D', leadId: 'L1', grandTotal: 99000, createdAt: ts(9000), deleted: true };
    const OTHER = { id: 'O', leadId: 'L2', grandTotal: 55000, createdAt: ts(8000) };

    // Primary deleted, another live estimate → newest live promoted + jobValue restamped.
    let p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: A, estimates: [A, B2, C, DEL, OTHER], estValue });
    ok('primary deleted with another live estimate → newest live one promoted',
      p && p.patch.primaryEstimateId === 'B', JSON.stringify(p));
    ok('… and the ghost jobValue is restamped from it, no confirm',
      p && p.patch.jobValue === 9500 && p.confirm === null, JSON.stringify(p));

    // Primary deleted, no others → cleared (ghost jobValue cleared with it).
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: A, estimates: [A, DEL, OTHER], estValue });
    ok('primary deleted, no other live estimate → primaryEstimateId cleared',
      p && p.patch.primaryEstimateId === null, JSON.stringify(p));
    ok('… and the jobValue that came from it is cleared',
      p && 'jobValue' in p.patch && p.patch.jobValue === null, JSON.stringify(p));

    // Non-primary deleted → no patch.
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: C, estimates: [A, B2, C], estValue });
    ok('non-primary estimate deleted → no lead patch', p === null, JSON.stringify(p));
    p = plan({ lead: { id: 'L1', jobValue: 5000 }, leadId: 'L1', removedEstimate: A, estimates: [A, B2], estValue });
    ok('lead with no primary → no lead patch', p === null, JSON.stringify(p));

    // Already-deleted estimates are ignored (the newest one here is deleted).
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: A, estimates: [DEL, A, C], estValue });
    ok('already-deleted estimates are never promoted', p && p.patch.primaryEstimateId === 'C', JSON.stringify(p));
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: A, estimates: [DEL, A], estValue });
    ok('only deleted estimates left → treated as none', p && p.patch.primaryEstimateId === null, JSON.stringify(p));
    ok('another lead\'s estimate is never promoted', p && p.patch.primaryEstimateId !== 'O');

    // A rep-confirmed value (not the deleted estimate's) → the revision confirm.
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 15000 }, leadId: 'L1',
      removedEstimate: A, estimates: [A, B2], estValue });
    ok('rep-set jobValue → promoted, jobValue only on confirm',
      p && p.patch.primaryEstimateId === 'B' && !('jobValue' in p.patch) && p.confirm && p.confirm.newVal === 9500,
      JSON.stringify(p));
    ok('… with _assignEstimateToLead\'s revision wording',
      p && p.confirm && /currently \$15,000 \(from an earlier estimate\)\. Use this estimate's \$9,500 instead\?/.test(p.confirm.message),
      p && p.confirm && p.confirm.message);
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 15000 }, leadId: 'L1',
      removedEstimate: A, estimates: [A], estValue });
    ok('rep-set jobValue, no other estimate → pointer cleared, value kept',
      p && p.patch.primaryEstimateId === null && !('jobValue' in p.patch), JSON.stringify(p));

    // Never stamps a $0 (canStampJobValue).
    const Z = { id: 'Z', leadId: 'L1', grandTotal: 0, createdAt: ts(5000) };
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: A, estimates: [A, Z], estValue });
    ok('next estimate with no value → promoted, ghost cleared, never stamped 0',
      p && p.patch.primaryEstimateId === 'Z' && p.patch.jobValue === null && p.confirm === null, JSON.stringify(p));
    // String totals read through the same reader (Classic "$9,500"-style).
    p = plan({ lead: { id: 'L1', primaryEstimateId: 'A', jobValue: 12000 }, leadId: 'L1',
      removedEstimate: A, estimates: [A, B], estValue: (e) => {
        const v = e.grandTotal != null ? e.grandTotal : e.total != null ? e.total : e.amount;
        return typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.]/g, '')) || 0;
      } });
    ok('value read through the page\'s estValue', p && p.patch.jobValue === 9500, JSON.stringify(p));
  } else {
    ok('planLeadAfterEstimateRemoval is exported', false);
  }

  // ── Part 1b: archiveEstimateAndSyncLead with a fake Firestore ────────────
  console.log('archiveEstimateAndSyncLead');
  if (M && typeof M.archiveEstimateAndSyncLead === 'function') {
    const mkFs = (docs) => {
      const writes = [];
      return {
        writes,
        fs: {
          db: {},
          doc: (_db, col, id) => ({ path: col + '/' + id }),
          getDoc: async (ref) => ({ exists: () => !!docs[ref.path], data: () => ({ ...docs[ref.path] }) }),
          updateDoc: async (ref, patch) => { writes.push({ path: ref.path, patch }); },
          serverTimestamp: () => '__ts__',
        },
      };
    };
    const A = { id: 'A', leadId: 'L1', grandTotal: 12000, createdAt: ts(3000) };
    const B = { id: 'B', leadId: 'L1', grandTotal: 9500, createdAt: ts(2000) };

    let f = mkFs({ 'leads/L1': { primaryEstimateId: 'A', jobValue: 12000 } });
    let r = await M.archiveEstimateAndSyncLead({ estimateId: 'A', estimate: A, estimates: [A, B], fs: f.fs, estValue });
    ok('soft-deletes with exactly the Archive fields',
      f.writes[0] && f.writes[0].path === 'estimates/A'
        && JSON.stringify(f.writes[0].patch) === JSON.stringify({ deleted: true, deletedAt: '__ts__' }),
      JSON.stringify(f.writes));
    ok('then writes the lead patch (promote + restamp)',
      f.writes[1] && f.writes[1].path === 'leads/L1' && f.writes[1].patch.primaryEstimateId === 'B' && f.writes[1].patch.jobValue === 9500,
      JSON.stringify(f.writes));
    ok('returns the patch it wrote', r && r.leadPatch && r.leadPatch.primaryEstimateId === 'B');

    f = mkFs({ 'leads/L1': { primaryEstimateId: 'A', jobValue: 15000 } });
    let asked = null;
    await M.archiveEstimateAndSyncLead({ estimateId: 'A', estimate: A, estimates: [A, B], fs: f.fs, estValue,
      ask: async (m) => { asked = m; return true; } });
    ok('rep-set value: confirm asked, Yes stamps the new value',
      asked && f.writes[1] && f.writes[1].patch.jobValue === 9500, JSON.stringify(f.writes));
    f = mkFs({ 'leads/L1': { primaryEstimateId: 'A', jobValue: 15000 } });
    await M.archiveEstimateAndSyncLead({ estimateId: 'A', estimate: A, estimates: [A, B], fs: f.fs, estValue,
      ask: async () => false });
    ok('rep-set value: No keeps it but still repoints the primary',
      f.writes[1] && f.writes[1].patch.primaryEstimateId === 'B' && !('jobValue' in f.writes[1].patch), JSON.stringify(f.writes));

    f = mkFs({ 'leads/L1': { primaryEstimateId: 'B', jobValue: 9500 } });
    await M.archiveEstimateAndSyncLead({ estimateId: 'A', estimate: A, estimates: [A, B], fs: f.fs, estValue });
    ok('non-primary: only the estimate is written', f.writes.length === 1 && f.writes[0].path === 'estimates/A', JSON.stringify(f.writes));

    f = mkFs({ 'estimates/A': { leadId: 'L1', grandTotal: 12000 }, 'leads/L1': { primaryEstimateId: 'A', jobValue: 12000 } });
    await M.archiveEstimateAndSyncLead({ estimateId: 'A', estimates: [], fs: f.fs, estValue });
    ok('estimate not in memory: read from Firestore, lead still cleared',
      f.writes[1] && f.writes[1].patch.primaryEstimateId === null && f.writes[1].patch.jobValue === null, JSON.stringify(f.writes));
  } else {
    ok('archiveEstimateAndSyncLead is exported', false);
  }

  // ── Part 2: wiring (comments stripped, brace-scoped) ─────────────────────
  console.log('wiring');
  const dash = stripComments(read('docs/pro/js/dashboard-bootstrap.module.js'));
  const del = bodyAfter(dash, 'async function _deleteEstimate(');
  ok('dashboard _deleteEstimate found', !!del);
  ok('_deleteEstimate no longer calls deleteDoc', del && !/deleteDoc\s*\(/.test(del), del);
  ok('_deleteEstimate calls archiveEstimateAndSyncLead', del && /\barchiveEstimateAndSyncLead\s*\(/.test(del));
  ok('dashboard imports the shared helper',
    /import\s*\{[^}]*\barchiveEstimateAndSyncLead\b[^}]*\}\s*from\s*["']\.\/estimate-lead-sync\.js["']/.test(dash));

  const rebuild = bodyAfter(dash, 'const rebuild = () =>');
  ok('live estimates snapshot drops soft-deleted estimates',
    rebuild && /\.filter\(\s*\(?\s*e\s*\)?\s*=>\s*[^)]*\.deleted\s*!==\s*true/.test(rebuild), rebuild);
  const load = bodyAfter(dash, 'async function loadEstimates(');
  ok('one-shot loadEstimates drops soft-deleted estimates',
    load && /\.filter\(\s*\(?\s*e\s*\)?\s*=>\s*[^)]*\.deleted\s*!==\s*true/.test(load), load && load.slice(0, 200));

  const cust = stripComments(read('docs/pro/js/customer-bootstrap.module.js'));
  ok('customer page imports the shared helper',
    /import\s*\{[^}]*\barchiveEstimateAndSyncLead\b[^}]*\}\s*from\s*["']\.\/estimate-lead-sync\.js["']/.test(cust));
  const arch = bodyAfter(cust, 'async function _archiveCustomerEstimate(');
  ok('customer page _archiveCustomerEstimate calls archiveEstimateAndSyncLead',
    arch && /\barchiveEstimateAndSyncLead\s*\(/.test(arch), arch);
  const onArchive = bodyAfter(cust, 'onArchive: async function');
  ok('preview Archive goes through _archiveCustomerEstimate',
    onArchive && /\b_archiveCustomerEstimate\s*\(/.test(onArchive) && !/deleted:\s*true/.test(onArchive), onArchive);
  const btn = bodyAfter(cust, "getElementById('deleteEstimateBtn').onclick = async () =>");
  ok('fallback Archive button goes through _archiveCustomerEstimate',
    btn && /\b_archiveCustomerEstimate\s*\(/.test(btn) && !/deleted:\s*true/.test(btn), btn);
  ok('no estimate soft-delete left inline on the customer page',
    !/updateDoc\(doc\(db,\s*'estimates'[^)]*\),\s*\{\s*deleted:\s*true/.test(cust));

  const portal = stripComments(read('functions/portal.js'));
  ok('homeowner portal list skips soft-deleted estimates',
    /const estimates = estSnap\.docs\.map\([^;]*\.filter\(\s*e\s*=>\s*e\.deleted\s*!==\s*true\s*\)/.test(portal));
  ok('homeowner portal single-estimate view 404s a soft-deleted estimate',
    /if \(!estSnap\.exists \|\| estSnap\.data\(\)\.deleted === true\)/.test(portal));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
