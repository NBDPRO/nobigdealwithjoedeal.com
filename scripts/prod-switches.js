#!/usr/bin/env node
/**
 * scripts/prod-switches.js — flip a company's per-company production switches.
 *
 *   --coach-ai on|off    companyProfile/{companyId}.coachAiEnabled
 *                        (NBD OS Coach's AI focus line; functions/coach-line.js)
 *   --auto-brief on|off  companies/{companyId}/settings/callBrief.autoBrief
 *                        (Call to Close auto-brief; functions/call-brief.js)
 *
 * Writes exactly what the CRM's own owner UI writes, merged, nothing else.
 * DRY RUN by default: prints the current values and the planned change.
 * --yes writes, then re-reads and prints the result.
 *
 * Credentials: Application Default Credentials (`gcloud auth
 * application-default login`), or a short-lived token in NBD_ACCESS_TOKEN
 * (`NBD_ACCESS_TOKEN=$(gcloud auth print-access-token)`), which goes over
 * Firestore REST (scripts/_firestore-rest.js).
 *
 * Usage:
 *   node scripts/prod-switches.js --company <companyId> --coach-ai on --auto-brief on          # dry run
 *   node scripts/prod-switches.js --company <companyId> --coach-ai on --auto-brief on --yes    # write
 */
'use strict';

const SWITCHES = {
  coachAi: { flag: '--coach-ai', field: 'coachAiEnabled', path: (c) => 'companyProfile/' + c },
  autoBrief: { flag: '--auto-brief', field: 'autoBrief', path: (c) => 'companies/' + c + '/settings/callBrief' },
};

function parseArgs(argv) {
  const out = { company: '', project: 'nobigdeal-pro', yes: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--yes') { out.yes = true; continue; }
    if (k === '--company' || k === '--project') { out[k.slice(2)] = String(argv[++i] || ''); continue; }
    const sw = Object.keys(SWITCHES).find((s) => SWITCHES[s].flag === k);
    if (sw) {
      const v = String(argv[++i] || '').toLowerCase();
      if (v !== 'on' && v !== 'off') throw new Error(k + ' takes on or off');
      out[sw] = v === 'on';
      continue;
    }
    throw new Error('unknown argument: ' + k);
  }
  if (!out.company) throw new Error('--company <companyId> is required');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(out.company)) throw new Error('--company must be a document id');
  if (!Object.keys(SWITCHES).some((s) => typeof out[s] === 'boolean')) throw new Error('give at least one switch: --coach-ai on|off, --auto-brief on|off');
  return out;
}

/** current: { coachAiEnabled, autoBrief }; wanted: { coachAi?, autoBrief? } → changes. Absent counts as off. */
function plan(current, wanted) {
  const changes = [];
  for (const key of Object.keys(SWITCHES)) {
    if (typeof wanted[key] !== 'boolean') continue;
    const from = current[SWITCHES[key].field] === true;
    if (from !== wanted[key]) changes.push({ key, field: SWITCHES[key].field, from, to: wanted[key] });
  }
  return changes;
}

async function readState(db, company) {
  const cp = await db.doc(SWITCHES.coachAi.path(company)).get();
  const cb = await db.doc(SWITCHES.autoBrief.path(company)).get();
  return {
    coachAiEnabled: cp.exists ? (cp.data() || {}).coachAiEnabled : undefined,
    autoBrief: cb.exists ? (cb.data() || {}).autoBrief : undefined,
  };
}

async function run({ db, args, log = console.log, serverTimestamp }) {
  const co = await db.doc('companies/' + args.company).get();
  if (!co.exists) throw new Error('no companies/' + args.company + ' in ' + args.project + '; nothing written');
  const before = await readState(db, args.company);
  const show = (s) => 'coachAiEnabled=' + (s.coachAiEnabled === true ? 'on' : 'off') + ', autoBrief=' + (s.autoBrief === true ? 'on' : 'off');
  log('company ' + args.company + ' (' + args.project + '): ' + show(before));
  const changes = plan(before, args);
  if (!changes.length) { log('nothing to change'); return { wrote: false, changes, before, after: before }; }
  changes.forEach((c) => log('  ' + c.field + ': ' + (c.from ? 'on' : 'off') + ' -> ' + (c.to ? 'on' : 'off')));
  if (!args.yes) { log('DRY RUN: nothing written. Add --yes to write.'); return { wrote: false, changes, before, after: before }; }
  for (const c of changes) {
    const ref = db.doc(SWITCHES[c.key].path(args.company));
    if (c.key === 'coachAi') await ref.set({ coachAiEnabled: c.to }, { merge: true });
    else await ref.set({ autoBrief: c.to, updatedBy: 'script:prod-switches', updatedAt: serverTimestamp() }, { merge: true });
  }
  const after = await readState(db, args.company);
  log('written. now: ' + show(after));
  return { wrote: true, changes, before, after };
}

module.exports = { parseArgs, plan, run, SWITCHES };

if (require.main === module) {
  (async () => {
    let args;
    try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    if (process.env.NBD_ACCESS_TOKEN) {
      // Token mode: Firestore REST with a short-lived access token (scripts/_firestore-rest.js).
      const R = require('./_firestore-rest');
      const db = R.restFirestore({ projectId: args.project, token: process.env.NBD_ACCESS_TOKEN });
      await run({ db, args, serverTimestamp: R.serverTimestamp });
      return;
    }
    const { initAdmin, getFirestore, FieldValue } = require('./_admin');
    initAdmin({ projectId: args.project });
    await run({ db: getFirestore(), args, serverTimestamp: () => FieldValue.serverTimestamp() });
  })().catch((e) => { console.error(e.message || e); process.exit(1); });
}
