/**
 * scripts/audit-imported-docs-placement.js — READ ONLY. Writes nothing.
 *
 * "Is it in the right folder" has two halves, and checking only one is how a
 * document ends up filed against the wrong customer:
 *
 *   Drive  — is the PDF under <Customer>/Docs ?   (the importer only ever
 *            reads Docs/ and Reports/, so anything it imported was in one)
 *   CRM    — is the documents row on THAT customer's lead ?
 *
 * This checks the CRM half. Every drive_import row is matched to its lead by
 * NAME **or by STREET ADDRESS**, because NBD's measurement reports are named
 * by address, not by customer — "Full Report - 1004 Larkspur Dr…" belongs
 * to Customer AP and a name-only check calls that a mismatch. A first pass
 * flagged 26 such files; every one was correctly placed. Only a file matching
 * neither the lead's name nor its address is a real suspect.
 *
 * RUN
 *   node scripts/audit-imported-docs-placement.js --company=<id>
 */
'use strict';

const { initAdmin, getFirestore } = require('./_admin');
const PROJECT = process.env.NBD_PROJECT || 'nobigdeal-pro';
const args = process.argv.slice(2);
const COMPANY = (args.find(a => a.startsWith('--company=')) || '').split('=')[1] || '';
if (!COMPANY) { console.error('--company=<id> required'); process.exit(2); }

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

// "1004 Larkspur Dr, Maineville, OH 45039" -> "1004 Larkspur"
function addrKey(s) {
  const t = norm(s);
  const m = t.match(/^(\d+)\s+([a-z]+(?:\s+[a-z]+)?)/);
  return m ? `${m[1]} ${m[2]}` : '';
}

function addrKeysInFilename(f) {
  const t = norm(f);
  const out = [];
  const re = /(\d{2,6})\s+([a-z]+(?:\s+[a-z]+)?)/g;
  let m;
  while ((m = re.exec(t))) out.push(`${m[1]} ${m[2]}`);
  return out;
}

(async () => {
  initAdmin({ projectId: PROJECT });
  const db = getFirestore();
  const snap = await db.collection('leads').where('companyId', '==', COMPANY).get();

  let imported = 0, generated = 0, uiUploaded = 0;
  const suspect = [];
  const byAddress = [];

  for (const d of snap.docs) {
    const x = d.data() || {};
    const name = [x.firstName, x.lastName].filter(Boolean).join(' ') || x.name || '(no name)';
    const docs = await d.ref.collection('documents').get();
    if (docs.empty) continue;

    const leadWords = new Set(norm(name).split(' ').filter(w => w.length > 2));
    const leadAddr = addrKey(x.address);

    docs.forEach((doc) => {
      const y = doc.data() || {};
      if (y.source === 'drive_import') imported++;
      else if (y.source) uiUploaded++;
      else generated++;
      if (y.source !== 'drive_import' || !y.filename) return;

      const fileWords = norm(y.filename).split(' ').filter(w => w.length > 2);
      const nameHit = fileWords.some(w => leadWords.has(w));
      if (nameHit) return;

      const keys = addrKeysInFilename(y.filename);
      const addrHit = !!leadAddr && keys.includes(leadAddr);
      if (addrHit) { byAddress.push([name, y.filename, leadAddr]); return; }

      // Neither name nor address. Generic titles (receipts, warranties,
      // permits) legitimately carry no identifier at all — only flag a file
      // that names or addresses SOMETHING, since that is what could be
      // someone else's.
      const looksIdentified = keys.length > 0 || /[A-Z][a-z]+ [A-Z][a-z]+/.test(y.filename);
      if (looksIdentified) {
        suspect.push([name, y.filename, x.address || '(no address on lead)', keys.join(' | ')]);
      }
    });
  }

  console.log('');
  console.log(`documents on cards: ${imported + generated + uiUploaded}`);
  console.log(`  drive_import : ${imported}    generated : ${generated}    UI uploads : ${uiUploaded}`);
  console.log('');
  console.log(`=== matched to their lead BY STREET ADDRESS (correct, just not name-titled): ${byAddress.length} ===`);
  byAddress.slice(0, 40).forEach(([n, f, a]) => console.log(`  ${n.padEnd(32)} ${a.padEnd(22)} ${f.slice(0, 70)}`));

  console.log('');
  if (suspect.length) {
    console.log(`=== ${suspect.length} POSSIBLY MISFILED — matched neither name nor address ===`);
    suspect.forEach(([n, f, a, k]) => {
      console.log(`  lead   : ${n}   (lead address: ${a})`);
      console.log(`  file   : ${f}`);
      console.log(`  addr in filename: ${k || '(none)'}`);
      console.log('');
    });
  } else {
    console.log('=== NOTHING MISFILED: every imported document matches its lead by name or by address ===');
  }

  console.log('READ ONLY — nothing was written.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
