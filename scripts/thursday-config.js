#!/usr/bin/env node
/**
 * scripts/thursday-config.js — view / set thursday_config/{companyId}, the
 * Thursday notification settings the Cloud Functions read on every call
 * (integrations/thursday.js loadConfig). Changing a flag here needs no deploy.
 *
 * DRY-RUN by default: prints the current doc and what would change.
 *
 *   node scripts/thursday-config.js                      # show current + defaults
 *   node scripts/thursday-config.js --sms-enabled=true   # dry-run a change
 *   node scripts/thursday-config.js --sms-enabled=true --apply --yes
 *
 * Flags (all optional):
 *   --sms-enabled=true|false   Bland SMS (needs the Agent Phone Plan)
 *   --sms-to=+18594207382      number that receives call texts
 *   --email-to=a@x.com,b@y.com call emails
 *   --push-enabled=true|false  push to the installed NBD Pro app
 *   --push-uid=<uid>           whose devices get the push (default: owner)
 *   --enabled=true|false       master switch for the CRM inbox widget
 *   --owner-numbers=+1...,+1...  Jo's extra phones — calls from them are tests
 *                              (added to the built-in cell, never replacing it)
 *   --company=<companyId>      default NBD 1phDvAVXHSg82wDLegAbQFq14Ci1
 *
 * Env: NBD_PROJECT (default nobigdeal-pro). ADC credentials
 * (gcloud auth application-default login). FIRESTORE_EMULATOR_HOST → emulator.
 */
'use strict';

const { initAdmin, getFirestore, FieldValue } = require('./_admin');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
function flag(name) {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : undefined;
}
function boolFlag(name) {
  const v = flag(name);
  if (v === undefined) return undefined;
  if (!/^(true|false)$/.test(v)) { console.error('--' + name + ' must be true or false'); process.exit(2); }
  return v === 'true';
}
function e164(v) {
  const d = String(v || '').replace(/\D/g, '').replace(/^1/, '').slice(-10);
  return d.length === 10 ? '+1' + d : '';
}

const DEFAULTS = {
  enabled: true,
  agentNumber: '+15139405589',
  smsEnabled: false,
  smsTo: '+18594207382',
  emailTo: ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'],
  pushEnabled: true,
};

async function main() {
  if (APPLY && !YES) { console.error('Refusing to --apply without --yes. Re-run with: --apply --yes'); process.exit(2); }
  const companyId = flag('company') || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  const EMULATED = !!process.env.FIRESTORE_EMULATOR_HOST;
  initAdmin(EMULATED ? { projectId: PROJECT, credential: null } : { projectId: PROJECT });
  const db = getFirestore();
  const ref = db.doc('thursday_config/' + companyId);
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : null;

  const patch = {};
  const b = (k, f) => { const v = boolFlag(f); if (v !== undefined) patch[k] = v; };
  b('smsEnabled', 'sms-enabled'); b('pushEnabled', 'push-enabled'); b('enabled', 'enabled');
  if (flag('sms-to') !== undefined) {
    const n = e164(flag('sms-to'));
    if (!n) { console.error('--sms-to must be a 10-digit US number'); process.exit(2); }
    patch.smsTo = n;
  }
  if (flag('email-to') !== undefined) {
    const list = flag('email-to').split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length || list.some((e) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e))) { console.error('--email-to must be comma-separated emails'); process.exit(2); }
    patch.emailTo = list;
  }
  if (flag('push-uid') !== undefined) patch.pushUid = flag('push-uid');
  if (flag('owner-numbers') !== undefined) {
    const nums = flag('owner-numbers').split(',').map((s) => e164(s.trim())).filter(Boolean);
    if (!nums.length) { console.error('--owner-numbers must be comma-separated 10-digit US numbers'); process.exit(2); }
    patch.ownerNumbers = nums;
  }
  const next = Object.assign({}, DEFAULTS, current || {}, patch);
  if (!current) Object.assign(next, { pushUid: next.pushUid || companyId });

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Thursday config — thursday_config/' + companyId);
  console.log('  project : ' + PROJECT + (EMULATED ? ' (EMULATOR)' : ''));
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)'));
  console.log('═══════════════════════════════════════════════════════════');
  console.log('current :', current ? JSON.stringify(current, null, 2) : '(no doc — functions use built-in defaults)');
  console.log('after   :', JSON.stringify(next, null, 2));
  if (!APPLY) { console.log('\nDry run only. Add --apply --yes to write.'); return; }
  const { updatedAt, ...toWrite } = next; // eslint-disable-line no-unused-vars
  await ref.set(Object.assign(toWrite, { updatedAt: FieldValue.serverTimestamp() }), { merge: true });
  const back = (await ref.get()).data();
  console.log('\nWritten. Read back:', JSON.stringify(back, null, 2));
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
