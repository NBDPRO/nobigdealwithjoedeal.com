/**
 * tests/intake-forms-2026-09-30.test.js
 *
 * Jo (2026-09-30): every homeowner service form must (a) REQUIRE a scheduling
 * choice — book a time now, or "please contact me" — (b) take real photo
 * uploads, (c) require phone + address with email optional, and (d) capture
 * best time / insurance / how-heard. Covers:
 *   functions/public-lead-photos.js      grant + parse + re-encode (real sharp)
 *   functions/handlers/integrations.js   intake allowlist, enums, photo grant
 *   functions/lead-bridge-logic.js       intake answers reach the CRM note
 *   docs/assets/js/intake-extras.js + the four forms (wiring)
 * Synthetic data only.
 *
 * Run: node tests/intake-forms-2026-09-30.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { createRequire } = require('module');
const fnRequire = createRequire(path.join(FN, 'package.json'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

(async () => {
  const PLP = require(path.join(FN, 'public-lead-photos.js'))._internal;
  const sharp = fnRequire('sharp');

  console.log('\n1. photo upload — parsing and the one-time grant');
  {
    ok('a JPEG data URL parses', PLP.parseDataUrl('data:image/jpeg;base64,/9j/4AAQ').mime === 'image/jpeg');
    ok('HEIC is accepted (iPhone originals)', !PLP.parseDataUrl('data:image/heic;base64,AAAA').error);
    ok('non-images are refused', PLP.parseDataUrl('data:text/html;base64,PGgxPg==').error === 'bad-format' && PLP.parseDataUrl('data:image/svg+xml;base64,PHN2Zz4=').error === 'bad-format');
    ok('an oversized upload is refused before decoding', PLP.parseDataUrl('data:image/jpeg;base64,' + 'A'.repeat(12 * 1024 * 1024)).error === 'too-large');
    const now = 1_800_000_000_000;
    const g = { collection: 'contact_leads', publicId: 'AbC123', exp: now + 60_000, max: 10, used: 3 };
    ok('a live grant with room passes', PLP.checkGrant(g, now).ok === true);
    ok('an expired grant is refused (410) with the text-us fallback', PLP.checkGrant(Object.assign({}, g, { exp: now - 1 }), now).status === 410 && /text/i.test(PLP.checkGrant(Object.assign({}, g, { exp: now - 1 }), now).error));
    ok('the 11th photo is refused (429)', PLP.checkGrant(Object.assign({}, g, { used: 10 }), now).status === 429);
    ok('a grant for a list-signup collection is refused', PLP.checkGrant(Object.assign({}, g, { collection: 'storm_alert_subscribers' }), now).ok === false);
    ok('a path-shaped public id is refused', PLP.checkGrant(Object.assign({}, g, { publicId: '../users/x' }), now).ok === false);
    ok('no grant → 404', PLP.checkGrant(null, now).status === 404);

    const writes = [];
    const fakeDb = { collection: (c) => ({ doc: (id) => ({ set: async (d) => { writes.push({ c, id, d }); } }) }) };
    const tok = await PLP.mintPhotoGrant(fakeDb, { collection: 'inspect_leads', publicId: 'P1', companyId: null });
    ok('the token is 48 hex chars', /^[a-f0-9]{48}$/.test(tok));
    ok('only its SHA-256 is stored (the raw token never is)', writes.length === 1 && writes[0].id === PLP.hashToken(tok) && !JSON.stringify(writes[0].d).includes(tok));
    ok('the grant carries collection, id, a 60-minute expiry and a cap of 10',
      writes[0].d.collection === 'inspect_leads' && writes[0].d.publicId === 'P1' && writes[0].d.max === 10 && writes[0].d.used === 0 && writes[0].d.exp > Date.now() + 59 * 60_000);
    ok('no grant for a non-service collection', (await PLP.mintPhotoGrant(fakeDb, { collection: 'guide_leads', publicId: 'P2' })) === null);
    // Emulator E2E (2026-09-30) found a non-image upload used up a slot: the
    // reserve ran before the decode. Now: cheap grant check → decode → reserve.
    const src = strip(read('functions/public-lead-photos.js'));
    const iPre = src.indexOf('await ref.get()'), iDec = src.indexOf('reencode(Buffer.from('), iTx = src.indexOf('db.runTransaction(');
    ok('a photo is decoded BEFORE a slot is reserved (a bad file never uses one of the ten)', iPre > 0 && iDec > iPre && iTx > iDec, [iPre, iDec, iTx].join());
    ok('signing is best-effort: a stored photo never errors on a failed signed URL', /signing failed — stored without a baked url/.test(read('functions/public-lead-photos.js')));
  }

  console.log('\n2. photo upload — re-encoding (real sharp)');
  {
    // A synthetic 4000x3000 JPEG carrying EXIF incl. a GPS position.
    const withGps = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: { r: 120, g: 90, b: 60 } } })
      .jpeg()
      .withExif({ IFD0: { Make: 'ZZ_QA Camera' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 6/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 30/1 0/1' } })
      .toBuffer();
    const before = await sharp(withGps).metadata();
    ok('fixture: the source really has EXIF (positive control)', !!before.exif && before.exif.length > 20);
    const out = await PLP.reencode(withGps);
    const after = await sharp(out).metadata();
    ok('re-encoded output has NO EXIF (GPS gone)', !after.exif, 'exif bytes: ' + (after.exif ? after.exif.length : 0));
    ok('capped at 2560px on the long edge, aspect kept', after.width === 2560 && after.height === 1920, after.width + 'x' + after.height);
    ok('output is JPEG', after.format === 'jpeg');
    const small = await PLP.reencode(await sharp({ create: { width: 800, height: 600, channels: 3, background: '#888' } }).png().toBuffer());
    ok('small images are not enlarged', (await sharp(small).metadata()).width === 800);
    let threw = false;
    try { await PLP.reencode(Buffer.from('<html>not an image</html>')); } catch (_) { threw = true; }
    ok('a non-image payload fails to decode (refused)', threw);
  }

  console.log('\n3. the gateway — required fields, intake answers, photo grant');
  {
    const S = require(path.join(FN, 'handlers', 'integrations.js'))._publicLeadSpec;
    const K = S.PUBLIC_LEAD_KINDS;
    ok('phone is required on every service kind', ['contact', 'inspect', 'free_roof'].every((k) => K[k].required.includes('phone')));
    ok('service kinds accept the intake answers', S.SERVICE_KINDS.every((k) => ['scheduling', 'bestTime', 'insuranceClaim', 'howHeard'].every((f) => K[k].optional.includes(f))));
    ok('list signups do NOT (storm alerts, guide)', !K.storm.optional.includes('scheduling') && !K.guide.optional.includes('scheduling'));
    ok('scheduling / insurance are enum-checked', S.INTAKE_ENUMS.scheduling.join() === 'calendar,contact_me' && S.INTAKE_ENUMS.insuranceClaim.includes('not_sure'));
    const src = strip(read('functions/handlers/integrations.js'));
    ok('an off-list enum value is dropped, never stored', /if \(data\[k\] != null && !allowed\.includes\(data\[k\]\)\) delete data\[k\];/.test(src));
    ok('a service lead without an address is FLAGGED (not refused — a stale cached page never loses a lead)', /if \(SERVICE_KINDS\.includes\(kind\) && !data\.address\) data\.missingAddress = true;/.test(src));
    ok('the photo grant is minted only when the page asks, and never blocks the lead',
      /body\.wantsPhotos === true \|\| body\.wantsPhotos === 'true'/.test(src) && /photo grant failed/.test(src) && /photoToken \? \{ photoToken \} : \{\}/.test(src));
    const idx = read('functions/index.js');
    ok('the upload endpoint is exported', /exports\.uploadPublicLeadPhoto\s*=\s*require\('\.\/public-lead-photos'\)\.uploadPublicLeadPhoto/.test(idx));
    ok('...and documented', /`uploadPublicLeadPhoto` \| onRequest/.test(read('functions/FUNCTIONS_INDEX.md')));
  }

  console.log('\n4. the CRM note carries the answers');
  {
    const B = require(path.join(FN, 'lead-bridge-logic.js'));
    const lead = B.mapPublicLeadToLead({ collection: 'contact_leads', sourceId: 'X1', ownerUid: 'o', companyId: 'o',
      data: { firstName: 'ZZ_QA', phone: '5135550100', scheduling: 'contact_me', bestTime: 'Evening', insuranceClaim: 'not_sure', howHeard: 'Yard sign', photoCount: 3, missingAddress: true } });
    ok('scheduling choice in the note + as a field', /asked to be contacted to set a time/.test(lead.notes) && lead.schedulingPreference === 'contact_me');
    ok('best time, insurance, how-heard in the note', /Best time to reach: Evening/.test(lead.notes) && /Insurance claim: not sure/.test(lead.notes) && /Heard about us: Yard sign/.test(lead.notes));
    ok('photos + missing address called out', /attached 3 photo\(s\)/.test(lead.notes) && /No address given/.test(lead.notes));
    const cal = B.mapPublicLeadToLead({ collection: 'contact_leads', sourceId: 'X2', ownerUid: 'o', companyId: 'o', data: { firstName: 'A', phone: '1', scheduling: 'calendar' } });
    ok('"book now" reads as booking on the calendar', /booking a time on the calendar/.test(cal.notes) && cal.schedulingPreference === 'calendar');
  }

  console.log('\n5. the forms');
  {
    const ie = strip(read('docs/assets/js/intake-extras.js'));
    ok('the scheduling choice is REQUIRED (no choice → error)', /if \(!picked\) \{/.test(ie) && /Choose how you’d like to schedule/.test(read('docs/assets/js/intake-extras.js')));
    ok('up to 10 photos, downscaled in the browser before upload', /MAX_PHOTOS = 10/.test(ie) && /toDataURL\('image\/jpeg', 0\.85\)/.test(ie));
    ok('a text-us fallback is always offered', /Or text photos to/.test(ie));
    ok('a contractor microsite never says "Joe" or links NBD\'s calendar', /calUrl: null/.test(read('docs/sites/t/site.js')) && /o\.calUrl \? '<label/.test(ie));
    ok('no inline handlers (CSP); stylesheet linked, not injected', !/\son[a-z]+=/.test(ie) && /l\.rel = 'stylesheet'/.test(ie));

    const home = read('docs/index.html');
    ok('homepage: address required, email marked optional, intake block present',
      /id="fieldAddress"[^>]*required/.test(home) && /Email <span class="form-optional">\(optional\)<\/span>/.test(home) && /data-nbd-intake="hp"/.test(home) && /intake-extras\.js/.test(home));
    const hpjs = strip(read('docs/assets/js/inline/72f02d79d0.js'));
    ok('homepage: address + intake validated before sending, answers posted, photos after success',
      /if\(!first \|\| !phoneOk \|\| !addressOk\)/.test(hpjs) && /NBDIntake\.read\(document\.getElementById\('formFields'\), 'hp'\)/.test(hpjs) && /\.\.\.intake\.fields/.test(hpjs) && /NBDIntake\.afterSubmit\(success/.test(hpjs));

    const q = strip(read('docs/assets/js/quick-lead-form.js'));
    ok('quick form (185 pages): address required, optional email, 10-digit phone, intake read',
      /Street address \*/.test(q) && /Email <em>\(optional\)<\/em>/.test(q) && /var phoneOk = /.test(q) && /NBDIntake\.read\(form, uid \+ 'i'\)/.test(q));

    const insHtml = read('docs/inspect.html');
    const ins = strip(read('docs/assets/js/inspect-form.js'));
    ok('/inspect: real photo upload replaces the file-names-only field', /data-nbd-intake="ins"/.test(insHtml) && !/photoNames/.test(ins) && !/inspectPhotoNote/.test(insHtml));
    ok('/inspect: intake validated + posted + photos uploaded', /NBDIntake\.read\(form, 'ins'\)/.test(ins) && /NBDIntake\.afterSubmit\(ok/.test(ins));

    const t = read('docs/sites/t/index.html');
    const ts = strip(read('docs/sites/t/site.js'));
    ok('microsite: address required, email optional, intake validated', /Street address \*<input id="qAddress"[^>]*required/.test(t) && /NBDIntake\.read\(form, 'tq'\)/.test(ts) && /var phoneOk = /.test(ts));

    const fr = strip(read('docs/assets/js/inline/0a394536a8.js'));
    ok('Free Roof: its required fields are finally enforced in the page', /if \(!payload\.nomineeName \|\| !phoneOk \|\| !addressOk \|\| !payload\.story\)/.test(fr));

    const pls = strip(read('docs/assets/js/public-lead-submit.js'));
    ok('the gateway client passes the photo token back to the page', /photoToken: data\.photoToken \|\| null/.test(pls) && /window\.nbdPublicFunctionsBase = baseUrl/.test(pls));
    // Found in the sandboxed browser run: a microsite (no calendar) must not
    // be told to "pick a time", and /inspect already says who reaches out.
    const ieRaw = read('docs/assets/js/intake-extras.js');
    ok('no-calendar pages get a contact-me-only scheduling error', /hasCal \?/.test(ieRaw) && /Please check “Please contact me to coordinate scheduling”/.test(ieRaw));
    ok('/inspect suppresses the duplicate "will reach out" line', /quietContact: true/.test(read('docs/assets/js/inspect-form.js')) && /!i\.quietContact/.test(ieRaw));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
