#!/usr/bin/env node
/**
 * Remove named documents from lead cards, Storage object included.
 *
 * Written for one narrow job: the branded PDFs were regenerated (logo added,
 * Customer DU's placeholders filled) and the earlier copies are still sitting on
 * the CRM cards. The importer skips a filename it has already seen, so without
 * this the cards keep the superseded file — and in Customer DU's case a document
 * literally titled "DRAFT - do not send" stays one click from being sent.
 *
 * Deletes only filenames listed on the command line, only within one company,
 * and prints everything it would touch before --apply lets it touch anything.
 *
 *   node scripts/prune-superseded-lead-docs.js --company=<uid> --name="<file>" [--name=...]
 *   node scripts/prune-superseded-lead-docs.js --company=<uid> --name="<file>" --apply --yes
 */
import { initAdmin, getFirestore, getStorage } from './_admin.js';

const args = process.argv.slice(2);
const companyId = (args.find((a) => a.startsWith('--company=')) || '').split('=')[1];
const names = args.filter((a) => a.startsWith('--name=')).map((a) => a.slice('--name='.length));
// Windows hands argv to node in the console codepage, so a filename with an
// em dash arrives mangled and matches nothing. --prefix= takes the ASCII
// document number instead, which is unambiguous and survives the round trip.
const prefixes = args.filter((a) => a.startsWith('--prefix=')).map((a) => a.slice('--prefix='.length));
const matches = (filename) =>
  typeof filename === 'string' &&
  (names.includes(filename) || prefixes.some((p) => filename.startsWith(p)));
const apply = args.includes('--apply') && args.includes('--yes');

if (!companyId) {
  console.error('Refusing to run without --company=<uid>. /leads is multi-tenant.');
  process.exit(1);
}
if (!names.length && !prefixes.length) {
  console.error('Nothing to do: pass at least one --name="<exact filename>" or --prefix=<doc no>.');
  process.exit(1);
}

initAdmin();
const db = getFirestore();
const BUCKET = process.env.NBD_BUCKET || 'nobigdeal-pro.firebasestorage.app';
const bucket = getStorage().bucket(BUCKET);

console.log('');
console.log('  company :', companyId);
console.log('  mode    :', apply ? 'APPLY (deleting)' : 'DRY-RUN');
console.log('  names   :');
for (const n of names) console.log('     ', n);
console.log('');

const leads = await db.collection('leads').where('companyId', '==', companyId).get();

let found = 0;
let deleted = 0;
let storageGone = 0;

for (const lead of leads.docs) {
  const docs = await lead.ref.collection('documents').get();
  for (const d of docs.docs) {
    const v = d.data();
    if (!matches(v.filename)) continue;
    found += 1;
    const who = v.leadName || lead.data().name || lead.data().customerName || lead.id;
    console.log(`  ${apply ? 'delete' : 'would delete'}  ${who}  ::  ${v.filename}`);
    if (!apply) continue;

    // Storage first: a dangling Firestore record is recoverable, a dangling
    // Storage object is invisible and billed forever.
    const path = storagePathFrom(v.url);
    if (path) {
      try {
        await bucket.file(path).delete();
        storageGone += 1;
      } catch (err) {
        if (err.code !== 404) console.log(`      ! storage: ${err.message}`);
      }
    }
    await d.ref.delete();
    deleted += 1;
  }
}

console.log('');
if (apply) {
  console.log(`  removed ${deleted} document record(s), ${storageGone} storage object(s)`);
} else {
  console.log(`  ${found} document record(s) match. Re-run with --apply --yes to remove them.`);
}
process.exit(0);

/** Pull the object path back out of a Firebase download URL. */
function storagePathFrom(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
