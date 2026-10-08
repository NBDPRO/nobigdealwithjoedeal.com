/**
 * scripts/backfill-oaks-brand.js — Phase A (TenantContext) Oaks brand backfill.
 *
 * Writes Oaks's real brand into `companyProfile/oaks.brand` so the TenantContext
 * resolver (window._brand() in docs/pro/js/company-profile.js) returns OAKS
 * branding for Oaks-tenant users instead of the NBD defaults. Deep-merges over
 * the NBD defaults client-side, so only the fields set here change for Oaks.
 *
 * ⚠ THIS WRITES TO PROD FIRESTORE. Jo runs this (Claude does not write prod).
 *   Auth: GOOGLE_APPLICATION_CREDENTIALS env var (same as functions/seed-demo.js).
 *
 * SAFETY (same rails as the other prod backfills, 2026-10-07)
 *   • Dry-run by default — reads the current doc and prints exactly what it
 *     would write (target doc, merge mode, full payload) and which fields
 *     change. Writes nothing.
 *   • --apply requires --yes as well.
 *   • One-shot guard (scripts/_migration-guard.js); --force overrides for a
 *     deliberate re-run (e.g. after editing OAKS_BRAND).
 *   tests/backfill-oaks-brand-dryrun-2026-10-07.test.js pins all three.
 *
 * RUN
 *   node scripts/backfill-oaks-brand.js                 # dry-run
 *   node scripts/backfill-oaks-brand.js --apply --yes   # actually write
 *
 * Tenant key note: `companyProfile/{companyId}`. Oaks users carry companyId
 * 'oaks' (companies/oaks). If Oaks's owner is a solo operator whose claim is
 * their uid instead, change OAKS_KEY to that uid.
 */
'use strict';

const { initAdmin, getFirestore } = require('./_admin');
const { assertNotCompleted, recordCompletion } = require('./_migration-guard');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const FORCE = args.includes('--force');
const MIGRATION = 'backfill-oaks-brand';
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';

const OAKS_KEY = 'oaks';

// Oaks's real brand, extracted from the live microsite (docs/sites/oaks/).
// NOTE: accent is #C2410C (burnt orange) — deliberately distinct from NBD's
// #E8720C per the 2026-06-07 brand-sweep decision. Swap if you/Scott prefer a
// different Oaks accent. The Oaks PUBLIC microsite (docs/sites/oaks/style.css)
// still uses #E8720C — changing the live partner site's color needs Scott's
// OK, so that's left for a separate call (this only affects generated docs).
const OAKS_BRAND = {
  brand: {
    displayName: 'Oaks Roofing & Construction',
    legalName:   'Oaks Roofing & Construction',
    seal:        'ORC',
    docPrefix:   'OAK',   // customer IDs / doc numbers: OAK-0001, OAK-WC-…
    tagline:     'Roofing, Siding, Gutters — 5-Year Labor Warranty on All Installs',
    smsSignOff:  'Scott from Oaks Roofing',
    logoUrl:     'https://nobigdealwithjoedeal.com/sites/oaks/logo-orange.svg',
    colors: {
      primary:   '#333333',  // charcoal (Oaks)
      secondary: '#1A1A1A',  // near-black (nav/hero)
      accent:    '#C2410C',  // Oaks burnt-orange — distinct from NBD's #E8720C (sweep decision)
      ink:       '#222222',
      charcoal:  '#1A1A1A',
      cream:     '#F5F5F5'
    },
    fonts: {
      display:    'Montserrat',
      body:       'Open Sans',
      docDisplay: 'Montserrat',
      docBody:    'Open Sans'
    },
    contact: {
      phone:      '(513) 827-5297',
      email:      'joe@oaksrfc.com',
      website:    'oaksroofingandconstruction.com',
      address:    'Goshen, OH',
      alertEmail: 'joe@oaksrfc.com',  // Phase C: route Oaks public leads to Scott, not Joe
      alertSms:   '+15138275297',     // Phase C: Oaks alert SMS (verify Scott's number)
      slackWebhook: ''                // Phase C: optional Oaks Slack lead alert
    },
    // Phase C: Oaks integration endpoints. TODO values are placeholders until
    // Oaks provisions its own. Empty/absent = fall through to the platform default.
    integrations: {
      twilioNumber: '',               // TODO: Oaks's own A2P-approved SMS number
      resendDomain: 'oaksrfc.com',    // Oaks sender domain (verify in Resend before relying on it)
      reviewUrl:    '',               // TODO: Oaks Google review link
      calLink:      ''                // TODO: Oaks Cal.com booking link
    }
  }
};

/** Leaf paths in `next` whose value differs from `cur` (what a merge changes). */
function changedLeaves(cur, next, prefix) {
  const out = [];
  for (const k of Object.keys(next)) {
    const p = prefix ? prefix + '.' + k : k;
    const n = next[k];
    const c = cur && typeof cur === 'object' ? cur[k] : undefined;
    if (n && typeof n === 'object' && !Array.isArray(n)) out.push(...changedLeaves(c, n, p));
    else if (JSON.stringify(c) !== JSON.stringify(n)) out.push({ path: p, from: c, to: n });
  }
  return out;
}

async function main() {
  if (APPLY && !YES) {
    console.error('Refusing to --apply without --yes. Re-run with: --apply --yes');
    process.exit(2);
    return;
  }
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  await assertNotCompleted(MIGRATION, { apply: APPLY, force: FORCE });

  const target = 'companyProfile/' + OAKS_KEY;
  const ref = db.collection('companyProfile').doc(OAKS_KEY);
  const snap = await ref.get();
  const current = (snap.exists && snap.data()) || {};
  const changes = changedLeaves(current, OAKS_BRAND, '');

  console.log('Backfill Oaks brand');
  console.log('  project : ' + PROJECT);
  console.log('  mode    : ' + (APPLY ? 'APPLY (writing)' : 'DRY-RUN (no changes)'));
  console.log('  target  : ' + target + (snap.exists ? '' : '  (doc does not exist yet — would be created)'));
  console.log('  write   : set(<payload>, { merge: true })');
  console.log('  payload :');
  console.log(JSON.stringify(OAKS_BRAND, null, 2).replace(/^/gm, '    '));
  console.log('\n  fields that change (' + changes.length + '):');
  for (const c of changes) {
    console.log('    ' + c.path + ': ' + JSON.stringify(c.from === undefined ? null : c.from) + ' → ' + JSON.stringify(c.to));
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing written. Re-run with --apply --yes to write.');
    return;
  }

  await ref.set(OAKS_BRAND, { merge: true });
  console.log(`\n✅ Backfilled ${target}.brand (Oaks) — ${changes.length} field(s) changed`);
  if (APPLY) await recordCompletion(MIGRATION, { changed: changes.length });
}

main()
  .then(async () => { try { await getFirestore().terminate(); } catch (_) {} process.exit(0); })
  .catch((e) => { console.error('❌ backfill failed:', e); process.exit(1); });
