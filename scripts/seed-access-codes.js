/**
 * scripts/seed-access-codes.js
 *
 * Populates the `access_codes` Firestore collection with RANDOM codes,
 * prints them to stdout ONCE, and never writes them to disk. Anything
 * committed here is meant to be read by humans, so hardcoded codes =
 * public codes. Whoever pulls this repo (including ex-employees, old
 * laptops, forks) used to get a working Pro account.
 *
 * Previously this file hardcoded NBD-2026, DEMO, NBD-STORM, etc. All
 * of those were exploitable; everyone who viewed the repo could mint
 * themselves a free Growth-plan account by typing one on /pro/login.
 *
 * NEW FLOW:
 *   1. Set the number of each class of code via env:
 *        BETA_COUNT=10 DEMO_COUNT=3 node scripts/seed-access-codes.js
 *   2. This script mints `BETA_COUNT` beta codes + `DEMO_COUNT` demo
 *      codes, random 16-char alphanumeric, writes them to Firestore
 *      with maxUses + expiresAt, and PRINTS them ONCE to stdout.
 *   3. Copy the codes into your CRM / password manager / Notion. They
 *      are not re-derivable.
 *   4. To rotate, run the `rotateAccessCodes` Cloud Function from the
 *      admin dashboard or re-run this script — old codes are auto-
 *      expired by setting `active: false`.
 *
 * NO CODE IN THIS FILE GRANTS THE ADMIN ROLE. Admin access is claims-
 * only and is set via scripts/grant-admin-claim.js.
 *
 * SETUP (once):
 *   export GOOGLE_APPLICATION_CREDENTIALS=~/.nbd/nobigdeal-pro-sa.json
 *
 * RUN (dry run by default, CLAUDE.md rule f; repo sweep 2026-11-17):
 *   BETA_COUNT=10 DEMO_COUNT=3 node scripts/seed-access-codes.js           # shows the plan, writes nothing
 *   BETA_COUNT=10 DEMO_COUNT=3 node scripts/seed-access-codes.js --apply   # writes + prints the codes once
 *
 * The public 'DEMO' code (the /pro login "Launch Demo Dashboard" button) is
 * NOT rotated here any more (Jo, 2026-11-17): it is deliberately public and
 * managed by scripts/seed-demo-access.js. Rotating it broke Try Demo silently.
 */

// firebase-admin resolution + the modular API live in scripts/_admin.js
// (scripts/ and the repo root both have no node_modules).
const { initAdmin, getFirestore, FieldValue, Timestamp } = require('./_admin');
const crypto = require('crypto');

const BETA_COUNT = Number(process.env.BETA_COUNT || 0);
const DEMO_COUNT = Number(process.env.DEMO_COUNT || 0);
const EXPIRE_BETA_DAYS = Number(process.env.EXPIRE_BETA_DAYS || 90);
const EXPIRE_DEMO_DAYS = Number(process.env.EXPIRE_DEMO_DAYS || 14);
const MAX_USES = Number(process.env.MAX_USES || 1);

if (BETA_COUNT === 0 && DEMO_COUNT === 0) {
  console.error('Set BETA_COUNT and/or DEMO_COUNT env vars. Nothing to do.');
  process.exit(2);
}

function mintCode(prefix) {
  // 10 random chars + a prefix, e.g. "NBD-7K3M4X2P9L".
  // crypto.randomBytes avoids Math.random's predictability. Base32
  // alphabet avoids easy-confusable chars.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  let body = '';
  for (const b of bytes) body += alphabet[b % alphabet.length];
  return prefix + '-' + body;
}

async function main() {
  // initAdmin is idempotent (ADC credential by default).
  initAdmin();
  const db = getFirestore();

  // Step 1: deactivate any existing `active: true` codes that look like
  // legacy hardcoded ones. This renders every pre-rotation code dead.
  // 'DEMO' is not on this list (2026-11-17): it is the public Try Demo code.
  const LEGACY_IDS = ['NBD-2026','NBD-DEMO','TRYIT','DEAL-2026','ROOFCON26','NBD-STORM'];
  if (!process.argv.includes('--apply')) {
    const found = [];
    for (const legacy of LEGACY_IDS) {
      const snap = await db.doc('access_codes/' + legacy).get();
      if (snap.exists && snap.data().active !== false) found.push(legacy);
    }
    console.log('DRY RUN: nothing written, no codes minted.');
    console.log('Would deactivate legacy codes: ' + (found.length ? found.join(', ') : '(none active)'));
    console.log('Would mint ' + BETA_COUNT + ' beta (' + EXPIRE_BETA_DAYS + 'd) and ' + DEMO_COUNT + ' demo (' + EXPIRE_DEMO_DAYS + 'd) codes, maxUses ' + MAX_USES + '.');
    console.log('The public DEMO code is left alone. Re-run with --apply to write and print the codes once.');
    process.exit(0);
  }
  for (const legacy of LEGACY_IDS) {
    const ref = db.doc('access_codes/' + legacy);
    const snap = await ref.get();
    if (snap.exists) {
      await ref.update({
        active: false,
        rotatedAt: FieldValue.serverTimestamp(),
        rotatedReason: 'legacy hardcoded code — auto-disabled on rotation'
      });
      console.log('✗ deactivated legacy code ' + legacy);
    }
  }

  const now = Date.now();
  const minted = [];

  for (let i = 0; i < BETA_COUNT; i++) {
    const id = mintCode('NBD');
    await db.doc('access_codes/' + id).set({
      active: true,
      email: 'invite@nobigdeal.pro',
      role: 'member',
      plan: 'foundation',
      trialDays: EXPIRE_BETA_DAYS,
      displayName: 'Beta Member',
      maxUses: MAX_USES,
      useCount: 0,
      expiresAt: Timestamp.fromMillis(now + EXPIRE_BETA_DAYS * 86_400_000),
      createdAt: FieldValue.serverTimestamp(),
      kind: 'beta'
    });
    minted.push({ id, kind: 'beta', expiresInDays: EXPIRE_BETA_DAYS });
  }

  for (let i = 0; i < DEMO_COUNT; i++) {
    const id = mintCode('DEMO');
    await db.doc('access_codes/' + id).set({
      active: true,
      email: 'demo@nobigdeal.pro',
      role: 'member',
      plan: 'foundation',
      trialDays: EXPIRE_DEMO_DAYS,
      displayName: 'Demo User',
      maxUses: MAX_USES,
      useCount: 0,
      expiresAt: Timestamp.fromMillis(now + EXPIRE_DEMO_DAYS * 86_400_000),
      createdAt: FieldValue.serverTimestamp(),
      kind: 'demo'
    });
    minted.push({ id, kind: 'demo', expiresInDays: EXPIRE_DEMO_DAYS });
  }

  // ─── Print once. Never write to a file. ─────────────────────
  console.log('\n=============================================');
  console.log(' NEW ACCESS CODES — COPY NOW, NOT RECOVERABLE');
  console.log('=============================================\n');
  for (const m of minted) {
    console.log(' ' + m.id.padEnd(16) + '  ' + m.kind + '  expires in ' + m.expiresInDays + 'd');
  }
  console.log('\nStore these in your password manager. Any codes left in');
  console.log('this terminal window should be cleared after saving.');
  console.log('\nLegacy codes (NBD-2026 etc) have been deactivated.');
  process.exit(0);
}

main().catch(e => {
  console.error('FAILED:', e.message || e);
  console.error(e.stack);
  process.exit(1);
});
