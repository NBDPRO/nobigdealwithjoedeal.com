/**
 * price-doc-read.js: priceDocRead, read a supplier's PDF or photo into draft price
 * lines (live supplier pricing slice 9, 2026-11-18, flag supplierPricing; Jo's
 * decisions in documentation/projects/LIVE-SUPPLIER-PRICING-2026-11-17.md).
 *
 *   priceDocRead  { file: 'data:application/pdf;base64,…' | 'data:image/…', fileName, supplierId? }
 *     owner / company_admin (priceCaller 'admin', the per-person flag). Answers
 *     { ok: true, docId, read, existing?, spentUsd, capUsd } or { ok: false, reason, message }.
 *
 * Nothing is saved as a price here. The lines go back to the Import prices screen,
 * where a person checks the pre-filled kind, dates and tax and saves (or not).
 *
 * The rules this file keeps:
 *   - the file is UNTRUSTED DATA: no tools, a fixed prompt, every field re-checked
 *     (price-doc-logic.js); the same file read twice is answered from the first read
 *   - the original is stored privately at price-docs/{companyId}/{docId}.{ext}
 *     (Storage rule: the owner and company admins only, through getBlob)
 *   - a monthly cap per company (companyProfile.pricing.supplierCompare.docReadCapUsd,
 *     $10 unless set, at most $50): a reservation is booked on
 *     priceBook/{companyId}/priceMeter/docs_<YYYY-MM> before the reader is paid,
 *     settled to the real cost after, released when nothing was billed and kept when
 *     billing is unknown. At the cap the screen says so and nothing is read.
 *   - the AI kill switch and the paid-plan gate run first
 *   - logs: event names and counts only, never the document's text or a price
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const { withSentry } = require('./integrations/sentry');
const D = require('./price-doc-logic');
const L = require('./price-logic');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 6000;
// Haiku 4.5: $1/M in, $5/M out (the receipt inbox's constants).
const COST_INPUT_PER_TOKEN = 1.00 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 5.00 / 1_000_000;
const RESERVE_USD = 0.25;
const MAX_DOC_BYTES = 7 * 1024 * 1024;   // a callable carries about 10 MB, and base64 adds a third
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const MESSAGES = {
  bad_file: 'Choose a PDF, or a JPG, PNG, WebP or iPhone (HEIC) photo.',
  too_big: 'That file is over 7 MB. Choose a smaller one, or split the PDF.',
  cap: 'This month\'s document reading limit is reached. It starts again next month, or raise the limit in Company Settings.',
  reader_unavailable: 'The reader is not available just now. Try again in a minute.',
  unreadable: 'That document could not be read. Try a clearer photo, or the PDF from the supplier.',
  heic_failed: 'That iPhone photo could not be opened. Take it again, or share it as a JPG.',
  ai_off: 'Document reading is switched off for now.',
};
const fail = (reason, extra) => Object.assign({ ok: false, reason, message: MESSAGES[reason] || 'That did not go through.' }, extra || {});

async function priceDocRead(request, deps) {
  const caller = await deps.priceCaller(request, 'admin', 'priceDocRead', 10);
  // A second, local gate: the reader spends money, so only the owner or a company admin
  // (a platform admin on their own tenant) gets past here, whatever priceCaller answered.
  const callerRole = caller && caller.role;
  if (!['admin', 'owner', 'company_admin'].includes(callerRole)) throw new HttpsError('permission-denied', 'Owner or admin access required');
  const db = deps.db();
  if (await deps.isAiDisabled()) return fail('ai_off');
  await deps.assertAiEntitled(db, request.auth);

  const data = (request.data && typeof request.data === 'object') ? request.data : {};
  let decoded = D.decodeDocDataUrl(data.file);
  if (!decoded) return fail('bad_file');
  if (decoded.bytes.length > MAX_DOC_BYTES) return fail('too_big');
  const fileName = String(data.fileName == null ? '' : data.fileName).replace(/[\u0000-\u001F\u007F/\\]/g, ' ').trim().slice(0, 120) || 'document';
  const supplierId = (typeof data.supplierId === 'string' && L.supplierOf(data.supplierId)) ? data.supplierId : null;
  const companyId = caller.companyId;
  const docId = 'd_' + crypto.createHash('sha256').update(decoded.bytes).digest('hex').slice(0, 32);
  // An iPhone photo (HEIC / HEIF): converted to JPEG here, before anything is reserved or
  // paid; the reader takes JPEG, PNG, WebP, GIF and PDF only. The JPEG is what is read and
  // stored (a browser can open it); the id stays the original file's, so the same photo
  // sent twice is still answered from its first read.
  if (decoded.mime === 'image/heic' || decoded.mime === 'image/heif' || deps.isHeicBytes(decoded.bytes)) {
    try { decoded = { bytes: await deps.heicToJpeg(decoded.bytes), mime: 'image/jpeg' }; }
    catch (e) { deps.logger.warn('[priceDocRead] heic decode failed'); return fail('heic_failed'); }
  }
  const base = 'priceBook/' + companyId;
  const docRef = db.doc(base + '/priceDocs/' + docId);

  const profileSnap = await db.doc('companyProfile/' + companyId).get();
  const capUsd = D.docCapUsd(profileSnap.exists ? (profileSnap.data() || {}) : {});
  const monthKey = D.docMonthKey(deps.nowMs());
  const meterRef = db.doc(base + '/priceMeter/docs_' + monthKey);

  // The same file read before (and not removed): answered from that read, free.
  const prev = await docRef.get();
  if (prev.exists && (prev.data() || {}).state === 'read') {
    const m = await meterRef.get();
    return { ok: true, docId, existing: true, read: (prev.data() || {}).read, spentUsd: m.exists ? Number((m.data() || {}).usd) || 0 : 0, capUsd };
  }

  // Reserve before paying: the real gate on the cap.
  const reserved = await db.runTransaction(async (tx) => {
    const s = await tx.get(meterRef);
    const used = s.exists ? Number((s.data() || {}).usd) || 0 : 0;
    if (used + RESERVE_USD > capUsd) return null;
    tx.set(meterRef, { usd: FieldValue.increment(RESERVE_USD), count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { used };
  });
  if (!reserved) { deps.logger.info('[priceDocRead] cap', { monthKey }); return fail('cap', { capUsd }); }
  const settle = async (usd, count) => {
    try { await meterRef.set(Object.assign({ usd: FieldValue.increment(usd), updatedAt: FieldValue.serverTimestamp() }, count ? { count: FieldValue.increment(count) } : {}), { merge: true }); }
    catch (e) { deps.logger.warn('[priceDocRead] meter settle failed'); }
  };

  // The original, private.
  const storagePath = 'price-docs/' + companyId + '/' + docId + '.' + EXT[decoded.mime];
  await deps.bucket().file(storagePath).save(decoded.bytes, { resumable: false, contentType: decoded.mime, metadata: { cacheControl: 'private, max-age=0' } });

  const b64 = decoded.bytes.toString('base64');
  const mediaBlock = decoded.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: decoded.mime, data: b64 } };
  let response, body;
  try {
    response = await deps.fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': deps.apiKey() },
      body: JSON.stringify(D.buildDocRequestBody({ model: MODEL, maxTokens: MAX_TOKENS, mediaBlock })),
    });
    body = await response.json();
  } catch (e) {
    // Billing unknown: the reservation is kept, so the cap can only be undershot.
    deps.logger.error('[priceDocRead] fetch failed');
    return fail('reader_unavailable');
  }
  if (!response.ok) {
    deps.logger.warn('[priceDocRead] reader refused', { status: response.status });
    await settle(-RESERVE_USD, -1);
    return fail('reader_unavailable');
  }
  const usage = (body && body.usage) || {};
  const costUsd = ((usage.input_tokens || 0) * COST_INPUT_PER_TOKEN) + ((usage.output_tokens || 0) * COST_OUTPUT_PER_TOKEN);
  await settle(costUsd - RESERVE_USD, 0);
  try { await deps.recordAiSpend('price-doc-read', MODEL, body); } catch (e) { deps.logger.warn('[priceDocRead] ai spend log failed'); }

  const text = Array.isArray(body && body.content) ? (body.content.find((c) => c && c.type === 'text') || {}).text : '';
  const parsed = D.parseDocJson(text);
  const read = parsed ? D.sanitizeDocRead(parsed) : null;
  await docRef.set({
    v: 1, state: read ? 'read' : 'failed', fileName, mime: decoded.mime, bytes: decoded.bytes.length, storagePath, supplierId,
    read: read || null, lineCount: read ? read.lines.length : 0, model: MODEL, costUsd,
    createdAt: FieldValue.serverTimestamp(), createdBy: caller.uid,
  });
  const spentUsd = reserved.used + costUsd;
  deps.logger.info('[priceDocRead] done', { lines: read ? read.lines.length : 0, ok: !!read });
  if (!read) return fail('unreadable', { docId, spentUsd, capUsd });
  return { ok: true, docId, read, spentUsd, capUsd };
}

const realDeps = () => ({
  db: getFirestore,
  bucket: () => getStorage().bucket(),
  fetch: (url, opts) => fetch(url, opts),
  apiKey: () => ANTHROPIC_API_KEY.value(),
  nowMs: () => Date.now(),
  logger,
  priceCaller: require('./price-ledger')._internal.priceCaller,
  isAiDisabled: () => require('./integrations/killswitch').isAiDisabled(),
  assertAiEntitled: (db, auth) => require('./ai-gate').assertAiEntitled(db, auth),
  isHeicBytes: (buf) => require('./receipt-inbox-logic').isHeicBytes(buf),
  heicToJpeg: async (buf) => Buffer.from(await require('heic-convert')({ buffer: buf, format: 'JPEG', quality: 0.85 })),
  recordAiSpend: (feature, model, body) => { const s = require('./ai-spend'); return s.recordAiSpend(s.rowFromAnthropic(feature, model, body), { log: logger }); },
});

const OPTS = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: '1GiB', maxInstances: 5, concurrency: 4 };   // 1GiB: a 12MP HEIC decodes to a ~40-50MB raw buffer (as the receipt inbox)
exports.priceDocRead = onCall(OPTS, withSentry('priceDocRead', require('./tenant-guard').wrapCallable((request) => priceDocRead(request, realDeps()))));
exports._internal = { priceDocRead, MESSAGES, MAX_DOC_BYTES, RESERVE_USD, MODEL, HttpsError };
