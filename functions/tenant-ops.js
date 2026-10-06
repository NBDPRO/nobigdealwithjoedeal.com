/**
 * tenant-ops.js — the functions that make NBD Pro work for a new contractor
 * without Jo (2026-10-04, tenant-ready). Pure rules: tenant-ops-logic.js.
 *
 *   adminListTenants   onCall      Platform admin only (role 'admin' claim, or
 *                                  the NBD owner uid): one row per company —
 *                                  plan, status, lead / estimate / invoice
 *                                  counts, Stripe Connect, last active, site.
 *   onCompanyCreated   Firestore   companies/{id} created → a signup alert to
 *                                  Jo and a welcome email to the new owner
 *                                  (email_queue; both are platform onboarding
 *                                  mail to the CONTRACTOR, never a homeowner).
 *   exportCompanyData  onCall      Owner / company admin: the whole company as
 *                                  a ZIP of JSON + CSV, named after the company.
 *   uploadCompanyLogo  onCall      Owner / company admin: re-encodes the image
 *                                  (sharp strips EXIF/GPS), stores it under
 *                                  tenant-logos/, saves a PUBLIC first-party
 *                                  URL — never a Storage ?token= link.
 *   tenantLogo         onRequest   Serves /tenant-logo/<companyId>/<hash>.png
 *                                  (firebase.json rewrite) from Storage.
 *
 * Cross-tenant isolation: every per-company callable resolves the company
 * from the caller's own claims through requireTeamAdmin (a company_admin can
 * only ever reach their own company; only a platform admin may name another).
 */
'use strict';

const crypto = require('crypto');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { getAuth } = require('firebase-admin/auth');
const { CORS_ORIGINS, requireTeamAdmin } = require('./handlers/_shared');
const { callableRateLimit } = require('./shared');
const T = require('./tenant-ops-logic');
const { buildZip } = require('./zip-lite');

const NBD_OWNER_UID = T.NBD_OWNER_UID;
const PLATFORM_ALERT_EMAIL = process.env.PLATFORM_ALERT_EMAIL || 'jd@nobigdealwithjoedeal.com';
const PUBLIC_ORIGIN = 'https://nobigdealwithjoedeal.com';
const KEY_RE = /^[A-Za-z0-9_-]{6,128}$/;
const LOGO_FILE_RE = /^[a-f0-9]{16,64}\.png$/;

function isPlatformAdmin(request) {
  const t = (request.auth && request.auth.token) || {};
  return t.role === 'admin' || (request.auth && request.auth.uid === NBD_OWNER_UID);
}

async function countWhere(db, coll, field, value) {
  try {
    const agg = await db.collection(coll).where(field, '==', value).count().get();
    return agg.data().count;
  } catch (e) {
    logger.warn('adminListTenants count failed', { coll, err: e && e.message });
    return null;
  }
}

// ── Admin Tenants ─────────────────────────────────────────────────────────
async function listTenants(db, auth) {
  const snap = await db.collection('companies').limit(300).get();
  const rows = [];
  for (const d of snap.docs) {
    const co = d.data() || {};
    const cid = d.id;
    const [subSnap, connSnap, leads, estimates, invoices] = await Promise.all([
      db.doc(`subscriptions/${cid}`).get(),
      db.doc(`connectAccounts/${cid}`).get(),
      countWhere(db, 'leads', 'companyId', cid),
      countWhere(db, 'estimates', 'companyId', cid),
      countWhere(db, 'invoices', 'companyId', cid),
    ]);
    let ownerEmail = '';
    let lastActive = null;
    if (co.ownerId) {
      try {
        const u = await auth.getUser(co.ownerId);
        ownerEmail = u.email || '';
        lastActive = (u.metadata && (u.metadata.lastRefreshTime || u.metadata.lastSignInTime)) || null;
        if (lastActive) lastActive = new Date(lastActive).toISOString();
      } catch (_) { /* deleted owner account */ }
    }
    rows.push(T.tenantRow({
      companyId: cid,
      company: co,
      subscription: subSnap.exists ? subSnap.data() : null,
      connect: connSnap.exists ? connSnap.data() : null,
      counts: { leads, estimates, invoices },
      ownerEmail,
      lastActive,
    }));
  }
  rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return rows;
}

exports.adminListTenants = onCall({ region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required');
  // Platform admin only: the role === 'admin' claim, or the NBD owner uid.
  const platform = request.auth.token.role === 'admin' || request.auth.uid === NBD_OWNER_UID;
  if (!platform || !isPlatformAdmin(request)) throw new HttpsError('permission-denied', 'Platform admin only');
  await callableRateLimit(request, 'adminListTenants', 60, 3_600_000);
  const rows = await listTenants(getFirestore(), getAuth());
  return { tenants: rows, generatedAt: new Date().toISOString() };
});

// ── Signup alert + welcome email ──────────────────────────────────────────
async function enqueueOnce(db, id, doc) {
  try {
    await db.doc(`email_queue/${id}`).create(Object.assign({ status: 'pending', createdAt: FieldValue.serverTimestamp() }, doc));
    return true;
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) return false; // retried trigger
    throw e;
  }
}

async function handleCompanyCreated(db, auth, companyId, company) {
  const co = company || {};
  if (companyId === NBD_OWNER_UID) return { skipped: 'platform' };
  let ownerEmail = '';
  if (co.ownerId) {
    try { ownerEmail = (await auth.getUser(co.ownerId)).email || ''; } catch (_) { ownerEmail = ''; }
  }
  const alert = T.signupAlertEmail(co, ownerEmail, companyId);
  await enqueueOnce(db, `signup-alert-${companyId}`, Object.assign({ to: PLATFORM_ALERT_EMAIL, source: 'platform_signup_alert', companyId }, alert));
  let welcomed = false;
  if (T.isEmail(ownerEmail)) {
    const w = T.welcomeEmail(co);
    welcomed = await enqueueOnce(db, `welcome-${companyId}`, Object.assign({ to: ownerEmail, source: 'platform_welcome', companyId, replyTo: PLATFORM_ALERT_EMAIL }, w));
  }
  return { alerted: true, welcomed };
}

exports.onCompanyCreated = onDocumentCreated({ document: 'companies/{companyId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 60 }, async (event) => {
  const co = event.data && event.data.data();
  if (!co) return;
  try {
    await handleCompanyCreated(getFirestore(), getAuth(), event.params.companyId, co);
  } catch (e) {
    logger.error('onCompanyCreated failed', { companyId: event.params.companyId, err: e && e.message });
  }
});

// ── Full company export ───────────────────────────────────────────────────
const EXPORT_COLLECTIONS = [
  // [file name, collection, company field, legacy owner field]
  ['leads', 'leads', 'companyId', 'userId'],
  ['estimates', 'estimates', 'companyId', 'userId'],
  ['invoices', 'invoices', 'companyId', 'createdBy'],
  ['contracts', 'esign_envelopes', 'companyId', 'userId'],
  ['documents', 'documents', 'companyId', 'userId'],
  ['lead_documents', 'lead_documents', 'companyId', 'userId'],
  ['photos', 'photos', 'companyId', 'userId'],
];
const EXPORT_LIMIT = 5000;
const SIGN_LIMIT = 300;
const MAX_ZIP_BYTES = 8 * 1024 * 1024;

// R4-7-3 (2026-10-06): a failed query used to be logger.warn'ed and the
// export shipped with 0 rows for that collection, and a collection over
// EXPORT_LIMIT was cut off with no notice. A tenant leaving in the grace
// period could walk away with an export missing their invoices and never
// know. Now a failed read FAILS the export (they can retry), and a capped
// read is named in `truncated` so the README says so.
function exportReadFailed(name, coll, e) {
  logger.error('export query failed', { coll, err: e && e.message });
  return new HttpsError('unavailable', 'Your export could not read your ' + name.replace(/_/g, ' ')
    + ' just now, so no file was made (an export missing records would look complete). Please try again in a minute.');
}

async function collectCompany(db, companyId, ownerId, truncated) {
  const out = {};
  for (const [name, coll, field, legacy] of EXPORT_COLLECTIONS) {
    const byId = new Map();
    let capped = false;
    const take = (snap) => {
      if (snap.docs.length >= EXPORT_LIMIT) capped = true;
      snap.docs.forEach((d) => { if (!byId.has(d.id)) byId.set(d.id, d); });
    };
    try { take(await db.collection(coll).where(field, '==', companyId).limit(EXPORT_LIMIT).get()); } catch (e) { throw exportReadFailed(name, coll, e); }
    // Legacy docs written before companyId was stamped belong to the owner.
    if (ownerId) {
      let legacySnap;
      try { legacySnap = await db.collection(coll).where(legacy, '==', ownerId).limit(EXPORT_LIMIT).get(); }
      catch (e) { throw exportReadFailed(name, coll, e); }
      if (legacySnap.docs.length >= EXPORT_LIMIT) capped = true;
      legacySnap.docs.forEach((d) => {
        const c = (d.data() || {})[field];
        if (!c || c === companyId) { if (!byId.has(d.id)) byId.set(d.id, d); }
      });
    }
    out[name] = Array.from(byId.values());
    if (capped && Array.isArray(truncated)) truncated.push(name);
  }
  return out;
}

async function buildCompanyExport(db, bucket, companyId, opts) {
  const o = opts || {};
  const coSnap = await db.doc(`companies/${companyId}`).get();
  const co = coSnap.exists ? (coSnap.data() || {}) : {};
  const profSnap = await db.doc(`companyProfile/${companyId}`).get();
  const prof = profSnap.exists ? (profSnap.data() || {}) : {};
  const companyName = (prof.brand && (prof.brand.displayName || prof.brand.legalName)) || co.name || '';
  const slug = T.companySlug(companyName, companyId);
  const now = o.now || new Date();
  const day = now.toISOString().slice(0, 10);
  // companyId == the owner's uid for every self-serve company (provisioning.js).
  const truncated = [];
  const docs = await collectCompany(db, companyId, co.ownerId || companyId, truncated);

  const files = [];
  const counts = {};
  let signed = 0, unsigned = 0;
  for (const name of Object.keys(docs)) {
    const rows = [];
    for (const d of docs[name]) {
      const row = Object.assign({ id: d.id }, T.plain(d.data() || {}));
      if (name === 'photos') {
        const path = typeof row.storagePath === 'string' ? row.storagePath : (typeof row.path === 'string' ? row.path : '');
        row.storagePath = path || null;
        delete row.url; delete row.downloadURL; delete row.thumbUrl;
        if (path && bucket && signed < SIGN_LIMIT && o.sign !== false) {
          try {
            const [url] = await bucket.file(path).getSignedUrl({ action: 'read', expires: now.getTime() + 24 * 3600 * 1000 });
            row.signedUrl24h = url;
            signed++;
          } catch (_) { unsigned++; }
        } else if (path) { unsigned++; }
      }
      rows.push(row);
    }
    counts[name] = rows.length;
    files.push({ name: `${slug}-${name}.json`, data: JSON.stringify(rows, null, 2) });
    files.push({ name: `${slug}-${name}.csv`, data: T.toCsv(rows) });
  }
  const companyRow = Object.assign({ id: companyId }, T.plain(co));
  const profileRow = T.plain(prof);
  files.unshift({ name: `${slug}-company.json`, data: JSON.stringify({ company: companyRow, profile: profileRow }, null, 2) });
  const photoNote = signed
    ? (signed + ' photo(s) carry a download link valid for 24 hours (signedUrl24h).' + (unsigned ? ' The other ' + unsigned + ' list their storage path only — ask NBD Pro support for a photo archive.' : ''))
    : 'Download links could not be created for this export — each photo lists its storage path; ask NBD Pro support for a photo archive.';
  files.unshift({ name: 'README.txt', data: T.exportReadme(companyName, counts, photoNote, now.toISOString(), { truncated, limit: EXPORT_LIMIT }) });
  if (truncated.length) logger.warn('export truncated at EXPORT_LIMIT', { companyId, truncated });
  const zip = buildZip(files, now);
  return { zip, filename: `${slug}-export-${day}.zip`, counts, signed, unsigned, truncated };
}

exports.exportCompanyData = onCall({ region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 300, memory: '1GiB' }, async (request) => {
  await callableRateLimit(request, 'exportCompanyData', 5, 3_600_000);
  const { companyId } = await requireTeamAdmin(request);
  const out = await buildCompanyExport(getFirestore(), getStorage().bucket(), companyId);
  if (out.zip.length > MAX_ZIP_BYTES) {
    throw new HttpsError('resource-exhausted', 'Your export is larger than this download allows — contact NBD Pro support and we will send it to you.');
  }
  logger.info('exportCompanyData', { companyId, bytes: out.zip.length, counts: out.counts });
  return { filename: out.filename, base64: out.zip.toString('base64'), counts: out.counts };
});

// ── Logo upload ───────────────────────────────────────────────────────────
const MAX_LOGO_BYTES = 3 * 1024 * 1024;

function decodeImage(data) {
  const s = String((data && data.image) || '');
  const m = s.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
  return buf.length ? buf : null;
}

// Re-encode to PNG: sharp drops EXIF / GPS / ICC metadata unless asked to
// keep it (we never call withMetadata), and rotate() bakes the EXIF
// orientation into the pixels first so a phone photo does not come out sideways.
async function reencodeLogo(buf) {
  const sharp = require('sharp');
  return sharp(buf, { failOn: 'error' })
    .rotate()
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function logoUrlFor(companyId, file) {
  return `${PUBLIC_ORIGIN}/tenant-logo/${companyId}/${file}`;
}

exports.uploadCompanyLogo = onCall({ region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 60, memory: '512MiB' }, async (request) => {
  await callableRateLimit(request, 'uploadCompanyLogo', 20, 3_600_000);
  const { companyId } = await requireTeamAdmin(request);
  if (!KEY_RE.test(companyId)) throw new HttpsError('failed-precondition', 'Unknown company');
  const raw = decodeImage(request.data);
  if (!raw) throw new HttpsError('invalid-argument', 'Choose a PNG, JPG, WebP or GIF image.');
  if (raw.length > MAX_LOGO_BYTES) throw new HttpsError('invalid-argument', 'That image is over 3 MB — choose a smaller one.');
  let png;
  try { png = await reencodeLogo(raw); } catch (e) {
    throw new HttpsError('invalid-argument', 'That file could not be read as an image.');
  }
  const hash = crypto.createHash('sha256').update(png).digest('hex').slice(0, 32);
  const file = `${hash}.png`;
  await getStorage().bucket().file(`tenant-logos/${companyId}/${file}`).save(png, {
    resumable: false,
    contentType: 'image/png',
    metadata: { cacheControl: 'public, max-age=31536000, immutable' },
  });
  const url = logoUrlFor(companyId, file);
  await getFirestore().doc(`companyProfile/${companyId}`).set({ brand: { logoUrl: url } }, { merge: true });
  logger.info('uploadCompanyLogo', { companyId, bytes: png.length });
  return { logoUrl: url };
});

exports.tenantLogo = onRequest({ region: 'us-central1', invoker: 'public', memory: '256MiB', timeoutSeconds: 30, maxInstances: 20 }, async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).send('Method not allowed'); return; }
  const parts = String(req.path || '').split('/').filter(Boolean);
  // /tenant-logo/<companyId>/<hash>.png
  const i = parts.indexOf('tenant-logo');
  const cid = i >= 0 ? parts[i + 1] : parts[0];
  const file = i >= 0 ? parts[i + 2] : parts[1];
  if (!KEY_RE.test(String(cid || '')) || !LOGO_FILE_RE.test(String(file || ''))) { res.status(404).send('Not found'); return; }
  try {
    const f = getStorage().bucket().file(`tenant-logos/${cid}/${file}`);
    const [buf] = await f.download();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.status(200).send(req.method === 'HEAD' ? '' : buf);
  } catch (_) {
    res.status(404).send('Not found');
  }
});

exports._test = { listTenants, handleCompanyCreated, buildCompanyExport, decodeImage, reencodeLogo, logoUrlFor, isPlatformAdmin, enqueueOnce };
