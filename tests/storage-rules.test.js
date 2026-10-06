/**
 * Storage rules tests for NBD Pro (F5).
 *
 * RUN:
 *   cd tests && npm install
 *   firebase emulators:exec --only storage --project nbd-rules-test 'node storage-rules.test.js'
 *
 * Asserts the D2 hardening:
 *   - photos/ accepts only image/* + enforces 15MB cap
 *   - docs/ accepts PDF/Office/text/images + 25MB cap
 *   - portals/ accepts only text/html + 5MB cap
 *   - null content-type uploads are rejected (D2 fix)
 *   - cross-owner reads/writes are denied
 *   - delete requires owner or platform admin
 *   - pdf-renders/ is owner/admin read and write-denied to every client
 *     (2026-09-08 — the prefix previously had no rule block at all)
 *   - homeowner-uploads/ is owner/admin read and write-denied to every
 *     client (2026-09-14 — same gap, same shape, one prefix later)
 *   - a 'viewer' writes nothing, even under its own uid prefix, and still
 *     reads its own objects (2026-09-25, Jo's decision B)
 */

'use strict';

const { initializeTestEnvironment, assertFails, assertSucceeds } =
  require('@firebase/rules-unit-testing');
const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'nbd-storage-rules-test';

function buf(size) { return Buffer.alloc(size, 0); }

async function run() {
  const env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    storage: {
      rules: fs.readFileSync(path.resolve(__dirname, '../storage.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 9199
    }
  });

  const alice = env.authenticatedContext('alice', { role: 'sales_rep', companyId: 'co-a' }).storage();
  const bob   = env.authenticatedContext('bob',   { role: 'sales_rep', companyId: 'co-b' }).storage();
  const admin = env.authenticatedContext('joe',   { role: 'admin' }).storage();
  const anon  = env.unauthenticatedContext().storage();
  // 2026-09-25 (decision B): a read-only viewer, and a no-role solo owner as
  // the control that the same upload is otherwise legal.
  const vic   = env.authenticatedContext('vic',   { role: 'viewer', companyId: 'co-v' }).storage();
  const solo  = env.authenticatedContext('solo1', {}).storage();

  const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

  // 1. alice can upload an image to photos/alice/
  await assertSucceeds(uploadBytes(
    ref(alice, 'photos/alice/roof.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));

  // 2. alice CANNOT upload octet-stream as photos (D2 fix: null /
  //    bogus content-type no longer passes the image check).
  await assertFails(uploadBytes(
    ref(alice, 'photos/alice/evil.bin'),
    buf(1024),
    { contentType: 'application/octet-stream' }
  ));

  // 3. bob CANNOT upload into alice's photos path
  await assertFails(uploadBytes(
    ref(bob, 'photos/alice/sneak.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));

  // 4. alice CANNOT upload a 20MB image (over 15MB cap)
  await assertFails(uploadBytes(
    ref(alice, 'photos/alice/huge.jpg'),
    buf(20 * 1024 * 1024),
    { contentType: 'image/jpeg' }
  ));

  // 5. alice can upload a PDF to docs/alice/ (contract)
  await assertSucceeds(uploadBytes(
    ref(alice, 'docs/alice/contract.pdf'),
    buf(8 * 1024),
    { contentType: 'application/pdf' }
  ));

  // 6. alice CANNOT upload an executable to docs/alice/ (not in allowlist)
  await assertFails(uploadBytes(
    ref(alice, 'docs/alice/mal.exe'),
    buf(1024),
    { contentType: 'application/x-msdownload' }
  ));

  // 7. alice CANNOT upload HTML to docs/alice/ (html only allowed in portals/)
  await assertFails(uploadBytes(
    ref(alice, 'docs/alice/page.html'),
    buf(1024),
    { contentType: 'text/html' }
  ));

  // 7b. (2026-10-01) alice CANNOT upload an SVG to docs/alice/ — it can carry
  // script that runs from its download URL; a raster image still goes.
  await assertFails(uploadBytes(
    ref(alice, 'docs/alice/logo.svg'),
    buf(1024),
    { contentType: 'image/svg+xml' }
  ));
  await assertSucceeds(uploadBytes(
    ref(alice, 'docs/alice/scan.png'),
    buf(1024),
    { contentType: 'image/png' }
  ));

  // 8. alice can upload HTML to portals/alice/
  await assertSucceeds(uploadBytes(
    ref(alice, 'portals/alice/lead42.html'),
    buf(1024),
    { contentType: 'text/html' }
  ));

  // 9. alice CANNOT upload an image to portals/alice/ (html only)
  await assertFails(uploadBytes(
    ref(alice, 'portals/alice/photo.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));

  // 9b. alice CAN upload generated-doc HTML to documents/alice/ (Signatures
  //     PR4 / doc-generator persist — this path was previously default-denied).
  await assertSucceeds(uploadBytes(
    ref(alice, 'documents/alice/lead42/docABC.html'),
    buf(1024),
    { contentType: 'text/html' }
  ));
  // 9c. bob CANNOT upload to alice's documents/ (cross-user)
  await assertFails(uploadBytes(
    ref(bob, 'documents/alice/lead42/docABC.html'),
    buf(1024),
    { contentType: 'text/html' }
  ));

  // 9d. NEW-D13: alice CAN upload her deal-room share page (text/html) —
  //     the old isDocType() gate didn't match text/html, so Close Board's
  //     Copy/Text/Email link generation always failed storage/unauthorized.
  await assertSucceeds(uploadBytes(
    ref(alice, 'deal_rooms/alice/dr_test123.html'),
    buf(1024),
    { contentType: 'text/html' }
  ));
  // 9e. bob CANNOT upload into alice's deal_rooms (cross-user)
  await assertFails(uploadBytes(
    ref(bob, 'deal_rooms/alice/dr_evil.html'),
    buf(1024),
    { contentType: 'text/html' }
  ));
  // 9f. non-HTML uploads to deal_rooms stay blocked
  await assertFails(uploadBytes(
    ref(alice, 'deal_rooms/alice/payload.zip'),
    buf(1024),
    { contentType: 'application/zip' }
  ));

  // 10. bob CANNOT read alice's photos
  await assertFails(getBytes(ref(bob, 'photos/alice/roof.jpg')));

  // 11. admin CAN read alice's docs (support context)
  await assertSucceeds(getBytes(ref(admin, 'docs/alice/contract.pdf')));

  // 12. alice can delete her own photos
  await assertSucceeds(deleteObject(ref(alice, 'photos/alice/roof.jpg')));

  // 13. anon CANNOT write anything
  await assertFails(uploadBytes(
    ref(anon, 'photos/alice/anon-attack.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));

  // 14. anon CANNOT read anything
  await assertFails(getBytes(ref(anon, 'docs/alice/contract.pdf')));

  // 15. Legacy flat paths (photos/<file> with no uid) always deny
  await assertFails(uploadBytes(
    ref(alice, 'photos/hash123.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));

  // ── EXPENSE RECEIPTS (receipts/{uid}/) ─────────────────────────────
  // 16. alice can upload a receipt photo (camera capture)
  await assertSucceeds(uploadBytes(
    ref(alice, 'receipts/alice/2026-06-27_abc.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));
  // 17. alice can upload a receipt PDF (emailed/scanned receipt)
  await assertSucceeds(uploadBytes(
    ref(alice, 'receipts/alice/beacon-invoice.pdf'),
    buf(8 * 1024),
    { contentType: 'application/pdf' }
  ));
  // 18. executables/archives stay blocked
  await assertFails(uploadBytes(
    ref(alice, 'receipts/alice/mal.exe'),
    buf(1024),
    { contentType: 'application/x-msdownload' }
  ));
  // 19. over the 25MB cap → blocked
  await assertFails(uploadBytes(
    ref(alice, 'receipts/alice/huge.pdf'),
    buf(26 * 1024 * 1024),
    { contentType: 'application/pdf' }
  ));
  // 20. bob CANNOT upload into alice's receipts (cross-user)
  await assertFails(uploadBytes(
    ref(bob, 'receipts/alice/sneak.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));
  // 21. bob CANNOT read alice's receipts; admin CAN (support context)
  await assertFails(getBytes(ref(bob, 'receipts/alice/2026-06-27_abc.jpg')));
  await assertSucceeds(getBytes(ref(admin, 'receipts/alice/2026-06-27_abc.jpg')));
  // 22. owner can delete; legacy flat receipts/<file> path always denies
  await assertSucceeds(deleteObject(ref(alice, 'receipts/alice/2026-06-27_abc.jpg')));
  await assertFails(uploadBytes(
    ref(alice, 'receipts/hash123.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));

  // ── PAYMENT PROOFS (payment-proofs/{uid}/{invoiceId}/, 2026-09-29) ─────
  // Same posture as receipts/: check photo or PDF, 25MB, owner write,
  // owner + platform admin read, flat path denied.
  // 22a. alice can upload a check photo and a bank PDF under her uid
  await assertSucceeds(uploadBytes(
    ref(alice, 'payment-proofs/alice/inv1/1790000000000_check.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));
  await assertSucceeds(uploadBytes(
    ref(alice, 'payment-proofs/alice/inv1/1790000000001_ach.pdf'),
    buf(8 * 1024),
    { contentType: 'application/pdf' }
  ));
  // 22b. executables blocked; over 25MB blocked
  await assertFails(uploadBytes(
    ref(alice, 'payment-proofs/alice/inv1/mal.exe'),
    buf(1024),
    { contentType: 'application/x-msdownload' }
  ));
  await assertFails(uploadBytes(
    ref(alice, 'payment-proofs/alice/inv1/huge.pdf'),
    buf(26 * 1024 * 1024),
    { contentType: 'application/pdf' }
  ));
  // 22c. bob cannot write into or read alice's proofs; admin reads; anon never
  await assertFails(uploadBytes(
    ref(bob, 'payment-proofs/alice/inv1/sneak.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));
  await assertFails(getBytes(ref(bob, 'payment-proofs/alice/inv1/1790000000000_check.jpg')));
  await assertFails(getBytes(ref(anon, 'payment-proofs/alice/inv1/1790000000000_check.jpg')));
  await assertSucceeds(getBytes(ref(alice, 'payment-proofs/alice/inv1/1790000000000_check.jpg')));
  await assertSucceeds(getBytes(ref(admin, 'payment-proofs/alice/inv1/1790000000000_check.jpg')));
  // 22d. owner deletes; the bare prefix always denies
  await assertSucceeds(deleteObject(ref(alice, 'payment-proofs/alice/inv1/1790000000001_ach.pdf')));
  await assertFails(uploadBytes(
    ref(alice, 'payment-proofs/flat.jpg'),
    buf(1024),
    { contentType: 'image/jpeg' }
  ));


  // ── UNTESTED-FOR-A-MONTH PREFIXES (2026-09-02) ───────────────────────
  // galleries/, reports/, shared_docs/ and audio/ carried owner-only rules
  // with ZERO assertions; a regression there would have shipped unseen.
  // 23. galleries/: owner image ok; PDF blocked; 11MB blocked; cross-user blocked;
  //     bob/anon can't read, admin can.
  await assertSucceeds(uploadBytes(ref(alice, 'galleries/alice/lead42/g1.jpg'), buf(1024), { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(alice, 'galleries/alice/lead42/g2.pdf'), buf(1024), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(alice, 'galleries/alice/lead42/huge.jpg'), buf(11 * 1024 * 1024), { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(bob,   'galleries/alice/lead42/sneak.jpg'), buf(1024), { contentType: 'image/jpeg' }));
  await assertFails(getBytes(ref(bob,   'galleries/alice/lead42/g1.jpg')));
  await assertFails(getBytes(ref(anon,  'galleries/alice/lead42/g1.jpg')));
  await assertSucceeds(getBytes(ref(admin, 'galleries/alice/lead42/g1.jpg')));
  // 24. reports/: PDF ok; HTML blocked (isDocType excludes text/html); 11MB blocked; cross-user blocked.
  await assertSucceeds(uploadBytes(ref(alice, 'reports/alice/r1.pdf'), buf(2048), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(alice, 'reports/alice/r1.html'), buf(1024), { contentType: 'text/html' }));
  await assertFails(uploadBytes(ref(alice, 'reports/alice/huge.pdf'), buf(11 * 1024 * 1024), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(bob,   'reports/alice/sneak.pdf'), buf(1024), { contentType: 'application/pdf' }));
  await assertFails(getBytes(ref(bob, 'reports/alice/r1.pdf')));
  // 25. shared_docs/: PDF ok; exe blocked; 26MB blocked; cross-user blocked.
  await assertSucceeds(uploadBytes(ref(alice, 'shared_docs/alice/s1.pdf'), buf(2048), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(alice, 'shared_docs/alice/mal.exe'), buf(1024), { contentType: 'application/x-msdownload' }));
  await assertFails(uploadBytes(ref(alice, 'shared_docs/alice/huge.pdf'), buf(26 * 1024 * 1024), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(bob,   'shared_docs/alice/sneak.pdf'), buf(1024), { contentType: 'application/pdf' }));
  await assertFails(getBytes(ref(bob, 'shared_docs/alice/s1.pdf')));
  // 26. audio/: MediaRecorder (webm) + Safari (mp4) ok; image blocked; cross-user
  //     blocked; bob can't read, admin can; owner deletes. The 200MB cap is
  //     deliberately not exercised — a >200MB emulator upload is too slow for CI.
  await assertSucceeds(uploadBytes(ref(alice, 'audio/alice/lead42/rec1.webm'), buf(4096), { contentType: 'audio/webm' }));
  await assertSucceeds(uploadBytes(ref(alice, 'audio/alice/lead42/rec2.m4a'),  buf(4096), { contentType: 'audio/mp4' }));
  await assertFails(uploadBytes(ref(alice, 'audio/alice/lead42/not-audio.jpg'), buf(1024), { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(bob,   'audio/alice/lead42/sneak.webm'), buf(1024), { contentType: 'audio/webm' }));
  await assertFails(getBytes(ref(bob, 'audio/alice/lead42/rec1.webm')));
  await assertSucceeds(getBytes(ref(admin, 'audio/alice/lead42/rec1.webm')));
  await assertSucceeds(deleteObject(ref(alice, 'audio/alice/lead42/rec1.webm')));

  // ── SERVER-RENDERED PDFs (pdf-renders/{uid}/) ────────────────────────
  // 27. This prefix had NO rule block until 2026-09-08 — it fell through to
  //     the catch-all deny. The block now states the intent: owner/admin read,
  //     nobody writes (render-pdf.js uploads through the admin SDK, which
  //     bypasses rules; the retention reaper deletes the same way).
  //
  //     Every other prefix here seeds its read fixtures by uploading as the
  //     owner. That is impossible by design now, so seed with rules disabled —
  //     otherwise the read assertions below would pass vacuously against an
  //     object that never existed (getBytes on a missing object fails for the
  //     wrong reason, and assertFails cannot tell the two apart).
  await env.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(
      ref(context.storage(), 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf'),
      buf(2048),
      { contentType: 'application/pdf' }
    );
  });
  // 27a. owner reads her own render; admin reads it (support context).
  await assertSucceeds(getBytes(ref(alice, 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf')));
  await assertSucceeds(getBytes(ref(admin, 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf')));
  // 27b. a different rep and an anonymous caller cannot. These are the
  //      assertions that matter: this prefix holds invoices, contracts and
  //      warranties for every tenant.
  await assertFails(getBytes(ref(bob,  'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf')));
  await assertFails(getBytes(ref(anon, 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf')));
  // 27c. NOBODY writes through the client SDK — not even the owner, and not
  //      with a valid content type. `allow write: if false` also denies
  //      update and delete, so the owner cannot overwrite a rendered document
  //      or destroy the audit trail.
  await assertFails(uploadBytes(
    ref(alice, 'pdf-renders/alice/forged-invoice.pdf'),
    buf(2048),
    { contentType: 'application/pdf' }
  ));
  await assertFails(uploadBytes(
    ref(alice, 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf'),
    buf(2048),
    { contentType: 'application/pdf' }
  ));
  await assertFails(deleteObject(ref(alice, 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf')));
  await assertFails(deleteObject(ref(admin, 'pdf-renders/alice/1781053546220-NBD-Roofing-Contract.pdf')));
  // 27d. cross-tenant write is denied for the same reason, stated separately
  //      so a future loosening of 27c to `isOwner(uid)` still trips this.
  await assertFails(uploadBytes(
    ref(bob, 'pdf-renders/alice/sneak.pdf'),
    buf(2048),
    { contentType: 'application/pdf' }
  ));

  // ── HOMEOWNER PORTAL UPLOADS (homeowner-uploads/{uid}/) ───────────────
  // 28. Same shape and same history as pdf-renders above: this prefix had
  //     NO rule block until 2026-09-14 — functions/portal.js has written
  //     here (via the admin SDK, from a burned single-use portal token)
  //     since W134, and it fell through to the catch-all deny the whole
  //     time. Unlike pdf-renders, a client (the rep) legitimately needs to
  //     READ these once the 7-day baked-in signed URL expires — that is
  //     the whole point of adding the rule now, alongside the matching
  //     functions/handlers/photo.js signImageUrl allowlist entry.
  await env.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(
      ref(context.storage(), 'homeowner-uploads/alice/lead42/1781053546220.jpg'),
      buf(2048),
      { contentType: 'image/jpeg' }
    );
  });
  // 28a. owner reads it; platform admin reads it (support context).
  await assertSucceeds(getBytes(ref(alice, 'homeowner-uploads/alice/lead42/1781053546220.jpg')));
  await assertSucceeds(getBytes(ref(admin, 'homeowner-uploads/alice/lead42/1781053546220.jpg')));
  // 28b. a different rep and an anonymous caller cannot — these are
  //      homeowner-submitted photos on someone else's job file.
  await assertFails(getBytes(ref(bob,  'homeowner-uploads/alice/lead42/1781053546220.jpg')));
  await assertFails(getBytes(ref(anon, 'homeowner-uploads/alice/lead42/1781053546220.jpg')));
  // 28c. NOBODY writes through the client SDK, not even the owner — these
  //      only ever land via the admin SDK from a validated portal token.
  await assertFails(uploadBytes(
    ref(alice, 'homeowner-uploads/alice/lead42/forged.jpg'),
    buf(2048),
    { contentType: 'image/jpeg' }
  ));
  await assertFails(deleteObject(ref(alice, 'homeowner-uploads/alice/lead42/1781053546220.jpg')));
  await assertFails(deleteObject(ref(admin, 'homeowner-uploads/alice/lead42/1781053546220.jpg')));
  // 28d. cross-tenant write denied for the same reason, stated separately.
  await assertFails(uploadBytes(
    ref(bob, 'homeowner-uploads/alice/lead42/sneak.jpg'),
    buf(2048),
    { contentType: 'image/jpeg' }
  ));

  // ── VIEWER IS READ-ONLY (2026-09-25, Jo's decision B) ─────────────────
  // 29. Every client-writable prefix is keyed by the uploader's uid, so a
  //     viewer could upload photos, contracts, receipts and audio under its
  //     OWN prefix even though firestore.rules refuses every doc that would
  //     point at them. ownerWrites() now bars role == 'viewer' on write and
  //     delete. For each prefix: the viewer's upload is refused, the SAME
  //     upload by a no-role solo succeeds (so the refusal is the role, not
  //     the payload), the viewer cannot delete an object already under its
  //     prefix, and can still read it.
  const VIEWER_PREFIXES = [
    ['photos',      'r.jpg',              'image/jpeg'],
    ['docs',        'c.pdf',              'application/pdf'],
    ['portals',     'lead42.html',        'text/html'],
    ['documents',   'lead42/d.html',      'text/html'],
    ['esign',       'lead42/env1/source.pdf', 'application/pdf'],
    ['deal_rooms',  'dr.html',            'text/html'],
    ['galleries',   'lead42/g.jpg',       'image/jpeg'],
    ['reports',     'r.pdf',              'application/pdf'],
    ['shared_docs', 's.pdf',              'application/pdf'],
    ['audio',       'lead42/rec.webm',    'audio/webm'],
    ['receipts',    'rc.jpg',             'image/jpeg'],
    ['yard-signs',  'ys.jpg',             'image/jpeg'],
    ['payment-proofs', 'inv1/pp.jpg',     'image/jpeg'],
  ];
  await env.withSecurityRulesDisabled(async (context) => {
    for (const [p, name, type] of VIEWER_PREFIXES) {
      await uploadBytes(ref(context.storage(), p + '/vic/seeded-' + name.split('/').join('-')), buf(1024), { contentType: type });
    }
  });
  for (const [p, name, type] of VIEWER_PREFIXES) {
    const seeded = p + '/vic/seeded-' + name.split('/').join('-');
    await assertFails(uploadBytes(ref(vic, p + '/vic/' + name), buf(1024), { contentType: type }));
    await assertSucceeds(uploadBytes(ref(solo, p + '/solo1/' + name), buf(1024), { contentType: type }));
    await assertFails(uploadBytes(ref(vic, seeded), buf(1024), { contentType: type }));   // overwrite
    await assertFails(deleteObject(ref(vic, seeded)));
    await assertSucceeds(getBytes(ref(vic, seeded)));
    await assertSucceeds(deleteObject(ref(solo, p + '/solo1/' + name)));
  }
  // Platform admin still deletes a viewer's object (support context, unchanged).
  await assertSucceeds(deleteObject(ref(admin, 'photos/vic/seeded-r.jpg')));

  // ── Signed documents are locked (2026-09-29, Jo: a signed contract is
  //    never changed). In-person signing uploads the signed HTML with
  //    customMetadata { signed: 'true' }; after that no client overwrites or
  //    deletes it. An unsigned draft keeps its normal rights.
  const signedPath = 'documents/alice/lead42/doc-signed.html';
  await assertSucceeds(uploadBytes(ref(alice, signedPath), buf(1024), { contentType: 'text/html' }));             // the draft
  await assertSucceeds(uploadBytes(ref(alice, signedPath), buf(1024),                                             // signing: draft → signed
    { contentType: 'text/html', customMetadata: { signed: 'true' } }));
  await assertFails(uploadBytes(ref(alice, signedPath), buf(1024), { contentType: 'text/html' }));                // overwrite a signed record
  await assertFails(uploadBytes(ref(alice, signedPath), buf(1024),                                                // ...even re-tagged as signed
    { contentType: 'text/html', customMetadata: { signed: 'true' } }));
  await assertFails(deleteObject(ref(alice, signedPath)));                                                        // owner delete
  await assertFails(deleteObject(ref(admin, signedPath)));                                                        // platform admin delete
  await assertSucceeds(getBytes(ref(alice, signedPath)));                                                         // still readable
  await assertSucceeds(uploadBytes(ref(alice, 'documents/alice/lead42/docABC.html'), buf(1024), { contentType: 'text/html' })); // unsigned overwrite
  await assertSucceeds(deleteObject(ref(alice, 'documents/alice/lead42/docABC.html')));                          // unsigned delete
  // e-sign: the rep's source.pdf as before; signed.pdf is the function's alone.
  await assertSucceeds(uploadBytes(ref(alice, 'esign/alice/lead42/env1/source.pdf'), buf(1024), { contentType: 'application/pdf' }));
  await assertFails(uploadBytes(ref(alice, 'esign/alice/lead42/env1/signed.pdf'), buf(1024), { contentType: 'application/pdf' }));
  // The function writes the real signed.pdf (admin SDK — rules off here).
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), 'esign/alice/lead42/env1/signed.pdf'), buf(1024), { contentType: 'application/pdf' });
  });
  await assertFails(deleteObject(ref(alice, 'esign/alice/lead42/env1/signed.pdf')));
  await assertFails(uploadBytes(ref(alice, 'esign/alice/lead42/env1/signed.pdf'), buf(1024), { contentType: 'application/pdf' })); // overwrite
  await assertSucceeds(deleteObject(ref(alice, 'esign/alice/lead42/env1/source.pdf')));
  console.log('  signed-document lock: 15 storage checks passed');

  // ── My Skin (2026-10-01): skins/{uid}/{slot} is strictly personal. ──
  await assertSucceeds(uploadBytes(ref(alice, 'skins/alice/wallpaper'), buf(2048), { contentType: 'image/jpeg' }));
  await assertSucceeds(uploadBytes(ref(alice, 'skins/alice/mascot'), buf(2048), { contentType: 'image/png' }));
  await assertSucceeds(uploadBytes(ref(alice, 'skins/alice/texture'), buf(2048), { contentType: 'image/webp' }));
  await assertSucceeds(uploadBytes(ref(alice, 'skins/alice/wallpaper'), buf(4096), { contentType: 'image/jpeg' })); // replace
  await assertSucceeds(getBytes(ref(alice, 'skins/alice/wallpaper')));
  await assertFails(getBytes(ref(bob, 'skins/alice/wallpaper')));                 // another user
  await assertFails(getBytes(ref(admin, 'skins/alice/wallpaper')));               // even a platform admin
  await assertFails(getBytes(ref(anon, 'skins/alice/wallpaper')));
  await assertFails(uploadBytes(ref(bob, 'skins/alice/wallpaper'), buf(2048), { contentType: 'image/jpeg' }));
  await assertFails(uploadBytes(ref(alice, 'skins/alice/avatar'), buf(2048), { contentType: 'image/png' }));        // unknown slot
  await assertFails(uploadBytes(ref(alice, 'skins/alice/x/wallpaper'), buf(2048), { contentType: 'image/png' }));   // nested path
  await assertFails(uploadBytes(ref(alice, 'skins/alice/mascot'), buf(2048), { contentType: 'image/svg+xml' }));    // script-capable
  await assertFails(uploadBytes(ref(alice, 'skins/alice/mascot'), buf(2048), { contentType: 'image/gif' }));        // not re-encoded
  await assertFails(uploadBytes(ref(alice, 'skins/alice/mascot'), buf(2048)));                                      // no content type
  await assertFails(uploadBytes(ref(alice, 'skins/alice/wallpaper'), buf(4 * 1024 * 1024 + 1), { contentType: 'image/jpeg' })); // over 4MB
  await assertSucceeds(uploadBytes(ref(vic, 'skins/vic/wallpaper'), buf(2048), { contentType: 'image/jpeg' }));    // a viewer styles their own screen
  await assertFails(deleteObject(ref(bob, 'skins/alice/mascot')));
  await assertFails(deleteObject(ref(admin, 'skins/alice/mascot')));
  await assertSucceeds(deleteObject(ref(alice, 'skins/alice/mascot')));
  console.log('  my-skin: 19 storage checks passed');

  // ── Reel Studio (2026-10-04): reel-uploads/{companyId}/{uid}/{mediaId} —
  // create-only by the uploader, owner or company_admin of THAT company,
  // video/image only, never readable / deletable by a client. ──
  const cadm = env.authenticatedContext('cadm1', { role: 'company_admin', companyId: 'co-r' }).storage();
  await assertSucceeds(uploadBytes(ref(solo, 'reel-uploads/solo1/solo1/m1'), buf(4096), { contentType: 'video/quicktime' }));   // solo owner: company == uid
  await assertSucceeds(uploadBytes(ref(cadm, 'reel-uploads/co-r/cadm1/m2'), buf(4096), { contentType: 'video/mp4' }));        // company_admin of co-r
  await assertSucceeds(uploadBytes(ref(cadm, 'reel-uploads/co-r/cadm1/m3'), buf(4096), { contentType: 'image/heic' }));       // phone photo / AI graphic
  await assertFails(uploadBytes(ref(alice, 'reel-uploads/co-a/alice/m4'), buf(4096), { contentType: 'video/mp4' }));        // a sales rep is not a social manager
  await assertFails(uploadBytes(ref(vic, 'reel-uploads/co-v/vic/m5'), buf(4096), { contentType: 'video/mp4' }));             // viewer
  await assertFails(uploadBytes(ref(cadm, 'reel-uploads/co-other/cadm1/m6'), buf(4096), { contentType: 'video/mp4' }));      // another company
  await assertFails(uploadBytes(ref(cadm, 'reel-uploads/co-r/someone/m7'), buf(4096), { contentType: 'video/mp4' }));        // someone else's folder
  await assertFails(uploadBytes(ref(solo, 'reel-uploads/solo1/solo1/m8'), buf(4096), { contentType: 'application/zip' }));   // not a video / photo
  await assertFails(uploadBytes(ref(solo, 'reel-uploads/solo1/solo1/m9'), buf(4096), { contentType: 'image/svg+xml' }));     // script-capable
  await assertFails(uploadBytes(ref(solo, 'reel-uploads/solo1/solo1/m1'), buf(4096), { contentType: 'video/mp4' }));         // write-once: no overwrite
  await assertFails(getBytes(ref(solo, 'reel-uploads/solo1/solo1/m1')));                                                     // raw (GPS) never readable
  await assertFails(deleteObject(ref(solo, 'reel-uploads/solo1/solo1/m1')));
  await assertFails(getBytes(ref(solo, 'reel-work/solo1/m1.mp4')));                                                          // intermediates server-only
  await assertFails(uploadBytes(ref(solo, 'social-media/solo1/' + 'a'.repeat(32) + '.mp4'), buf(4096), { contentType: 'video/mp4' })); // nor the served copies
  // Review hardening (2026-10-04): a rep / viewer of ANOTHER company cannot
  // open a "company of one" folder named for themselves; a solo owner whose
  // token names their own uid as the company still can.
  await assertFails(uploadBytes(ref(alice, 'reel-uploads/alice/alice/m10'), buf(4096), { contentType: 'video/mp4' }));       // rep of co-a, self-named folder
  await assertFails(uploadBytes(ref(vic, 'reel-uploads/vic/vic/m11'), buf(4096), { contentType: 'video/mp4' }));             // viewer, self-named folder
  const soloTok = env.authenticatedContext('solo2', { companyId: 'solo2' }).storage();
  await assertSucceeds(uploadBytes(ref(soloTok, 'reel-uploads/solo2/solo2/m12'), buf(4096), { contentType: 'video/mp4' }));  // solo owner, companyId claim == uid
  console.log('  reel studio: 17 storage checks passed');

  // KNOWN BUG R3-4 (phased review round 3, 2026-10-06; report
  // nbd-content/review-r3-2026-10-06.md). money-paper files invoice/receipt
  // PDFs at documents/{ownerUid}/{leadId}/{id}.pdf with NO signed tag, and
  // createEstimateReviewLink checks "is a PDF" only at mint. The owner can
  // then overwrite that object with text/html, and getSharedReport serves
  // the object's CURRENT Content-Type from a Cloud Function response that
  // carries no CSP (live /report/* responses have none) — stored HTML on
  // nobigdealwithjoedeal.com. This pins today's behaviour: the overwrite is
  // ALLOWED. When the fix lands (freeze filed PDFs), flip assertSucceeds to
  // assertFails in that PR, with Jo's OK.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await uploadBytes(ref(ctx.storage(), 'documents/alice/r3lead/inv-r3.pdf'), buf(2048), { contentType: 'application/pdf' });
  });
  await assertSucceeds(uploadBytes(
    ref(alice, 'documents/alice/r3lead/inv-r3.pdf'),
    Buffer.from('<html><body>not a pdf</body></html>'),
    { contentType: 'text/html' }
  ));
  console.log('  KNOWN BUG R3-4: owner can overwrite a filed PDF with text/html (pinned)');

  console.log('✓ All storage rules tests passed');
  await env.cleanup();
}

run().catch((e) => {
  console.error('✗ storage rules tests failed:', e);
  process.exit(1);
});
