/**
 * receipt-inbox.js — phase 1 of the Receipt and job-cost inbox (2026-11-04 design).
 *
 * submitInboxReceipt({ storagePath }) reads ONE uploaded receipt / invoice / credit memo
 * (a phone photo or PDF the signed-in person already put at receipts/{uid}/inbox/...) and
 * files a DRAFT at receipt_inbox/{companyId}__rcpt_<hash>. It NEVER writes an expense, a
 * job, a total or anything that counts: the person approves one row at a time on the
 * client, and only that tap creates an expense.
 *
 * Gates, in this order (same as extractReceiptData, plus the inbox cap):
 *   signed in -> not a viewer -> AI kill switch -> 20 reads/min rate limit -> path is the
 *   caller's own receipts/{uid}/inbox/ -> config `paused` -> RECEIPT_INBOX_ENABLED
 *   (unset = DRY RUN: validates and reports, reads no file, calls no AI, writes nothing)
 *   -> same-file check (sha256, company scoped, free) -> inbox cap ($10/month default,
 *   hard stop AT the cap) -> the reader.
 *
 * Safety:
 *   - The reader gets no tools and a fixed prompt; the file is DATA (see the prompt in
 *     receipt-inbox-logic.js). Its JSON is re-validated field by field, so a job id, an
 *     "approve" or any other extra key in the reply is dropped. The JOB is never chosen
 *     here at all: the screen suggests one with deterministic code and a person taps.
 *   - A document the reader calls personal / not a business receipt is DROPPED: the file
 *     is deleted from Storage and only its hash, a status and a counter are kept.
 *   - Receipt text is never logged. The raw model reply is never stored or logged.
 *   - The dedupe key is company scoped (the doc id), unlike the shared visionCache.
 *   - Credit memos are read as credits (positive cents, documentType 'credit'); the old
 *     reader's "negative total = unreadable" rule in receipt-vision.js is untouched.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const crypto = require('crypto');
const { withSentry } = require('./integrations/sentry');
const { callableRateLimit, assertNotViewer } = require('./shared');
const L = require('./receipt-inbox-logic');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1500;
// Haiku 4.5: $1/M in, $5/M out (same constants as receipt-vision.js).
const COST_INPUT_PER_TOKEN = 1.00 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 5.00 / 1_000_000;
const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
// A draft stuck in 'reading' (instance died) can be taken over after this long.
const READING_STALE_MS = 5 * 60 * 1000;

// Dry-run unless the literal 'true' (kind 'enabled' in flags-registry.js).
const enabled = () => process.env.RECEIPT_INBOX_ENABLED === 'true';

const configPath = (companyId) => `integrations/receiptInbox/companies/${companyId}`;

exports.submitInboxReceipt = onCall({
  region: 'us-central1',
  cors: CORS_ORIGINS,
  enforceAppCheck: true,
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 90,
  memory: '1GiB', // HEIC decode inflates a 12MP photo to a ~40-50MB raw buffer
  maxInstances: 10,
  concurrency: 20,
}, withSentry('submitInboxReceipt', async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  // A viewer is read-only everywhere (decision B, 2026-09-25): refused before ANY side effect.
  assertNotViewer(request.auth.token);

  if (await require('./integrations/killswitch').isAiDisabled()) {
    throw new HttpsError('unavailable', 'AI temporarily disabled');
  }

  await callableRateLimit(request, 'submitInboxReceipt', 20, 60_000);

  const storagePath = typeof request.data?.storagePath === 'string' ? request.data.storagePath : null;
  if (!storagePath) throw new HttpsError('invalid-argument', 'storagePath required');
  // The caller's OWN inbox folder only. Unlike extractReceiptData there is no admin bypass:
  // a draft is filed under the signed-in person's company and nobody else's.
  if (!L.inboxPathOk(storagePath, uid)) throw new HttpsError('permission-denied', 'Not your inbox receipt path');

  const companyId = (request.auth.token && request.auth.token.companyId) || uid;
  const db = getFirestore();
  const monthKey = L.inboxMonthKey(Date.now());
  const userMeterRef = db.doc(`userCostMeter/${uid}__${monthKey}`);
  const cfgRef = db.doc(configPath(companyId));
  const [meterSnap, cfgSnap] = await Promise.all([userMeterRef.get(), cfgRef.get()]);
  const meter = meterSnap.exists ? (meterSnap.data() || {}) : {};
  const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  const cap = L.inboxCapState({ spentUsd: meter.inboxUsd, capUsd: cfg.monthlyCapUsd, count: meter.inboxCount, countCap: cfg.monthlyCountCap });
  const capInfo = { spentUsd: cap.spentUsd, capUsd: cap.capUsd };

  if (cfg.paused === true) return { skipped: true, reason: 'paused', ...capInfo };
  if (!enabled()) {
    // DRY RUN: nothing read, nothing spent, nothing written.
    return { skipped: true, dryRun: true, reason: 'dry-run', wouldBlock: cap.blocked, ...capInfo };
  }

  // ── Read the file ──
  let buf, contentType;
  try {
    const file = getStorage().bucket().file(storagePath);
    const [meta] = await file.getMetadata();
    contentType = (meta && meta.contentType) || 'application/octet-stream';
    if (meta && meta.size && Number(meta.size) > MAX_RECEIPT_BYTES) throw new HttpsError('invalid-argument', 'Receipt too large');
    [buf] = await file.download();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.warn('receipt-inbox.read_failed', { code: 'storage' });
    throw new HttpsError('not-found', 'Receipt file not found');
  }

  // The same-file key is the hash of the ORIGINAL bytes, company scoped by the doc id.
  const fileHash = crypto.createHash('sha256').update(buf).digest('hex');
  const inboxId = L.inboxDocId(companyId, fileHash);
  if (!inboxId) throw new HttpsError('failed-precondition', 'Could not key this receipt');
  const ref = db.doc(`receipt_inbox/${inboxId}`);

  // Same file already filed (free, before any AI spend): hand back the existing draft.
  const existing = await ref.get();
  if (existing.exists) {
    const d = existing.data() || {};
    const recvMs = d.receivedAt && typeof d.receivedAt.toMillis === 'function' ? d.receivedAt.toMillis() : 0;
    const stale = d.status === 'reading' && recvMs && Date.now() - recvMs > READING_STALE_MS;
    if (d.status !== 'failed' && !stale) return { inboxId, existing: true, status: d.status || 'ready', ...capInfo };
  }

  // ── Inbox cap: a hard stop AT the cap, checked before the reader is paid ──
  if (cap.blocked) {
    logger.info('receipt-inbox.cap', { uid, monthKey, reason: cap.reason });
    return { skipped: true, reason: 'inbox-cap', capReason: cap.reason, ...capInfo };
  }

  // HEIC -> JPEG (the iPhone default); Claude vision takes jpeg/png/gif/webp and PDF only.
  let sendBuf = buf;
  if (/^image\/(heic|heif)$/.test(contentType) || L.isHeicBytes(buf)) {
    try {
      const convert = require('heic-convert');
      sendBuf = Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: 0.85 }));
      contentType = 'image/jpeg';
    } catch (e) {
      logger.warn('receipt-inbox.heic_decode_failed', { code: 'heic' });
      return { skipped: true, reason: 'unsupported-format', ...capInfo };
    }
  }
  const isPdf = contentType === 'application/pdf';
  const isImage = /^image\//.test(contentType);
  if (!isPdf && !isImage) throw new HttpsError('invalid-argument', 'Unsupported receipt type');
  if (isImage && !CLAUDE_IMAGE_TYPES.has(contentType)) return { skipped: true, reason: 'unsupported-format', ...capInfo };

  // Claim the draft (so two taps on the same file read it once).
  const claimed = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists) {
      const d = s.data() || {};
      const recvMs = d.receivedAt && typeof d.receivedAt.toMillis === 'function' ? d.receivedAt.toMillis() : 0;
      const stale = d.status === 'reading' && recvMs && Date.now() - recvMs > READING_STALE_MS;
      if (d.status !== 'failed' && !stale) return false;
    }
    tx.set(ref, {
      companyId, ownerUid: uid, source: 'upload', storagePath, fileHash, mime: contentType,
      status: 'reading', receivedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (!claimed) return { inboxId, existing: true, status: 'reading', ...capInfo };

  const failDraft = async (reason) => {
    try { await ref.set({ status: 'failed', failReason: reason, updatedAt: FieldValue.serverTimestamp() }, { merge: true }); } catch (_) { /* best effort */ }
  };

  // ── The reader ──
  const base64 = sendBuf.toString('base64');
  const mediaBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } };
  const body = L.buildInboxRequestBody({ model: MODEL, maxTokens: MAX_TOKENS, mediaBlock });

  let response, data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ANTHROPIC_API_KEY.value(),
      },
      body: JSON.stringify(body),
    });
    data = await response.json();
  } catch (e) {
    logger.error('receipt-inbox.fetch_failed', { code: 'network' });
    await failDraft('ocr-unavailable');
    throw new HttpsError('internal', 'Receipt reader request failed');
  }
  if (!response.ok) {
    logger.warn('receipt-inbox.api_error', { status: response.status });
    await failDraft('ocr-unavailable');
    return { skipped: true, reason: 'ocr-unavailable', status: response.status, ...capInfo };
  }

  const usage = data.usage || {};
  const callCostUsd = ((usage.input_tokens || 0) * COST_INPUT_PER_TOKEN) + ((usage.output_tokens || 0) * COST_OUTPUT_PER_TOKEN);
  const aiSpend = require('./ai-spend');
  await aiSpend.recordAiSpend(aiSpend.rowFromAnthropic('receipt-inbox', MODEL, data), { log: logger });
  await userMeterRef.set({
    uid, monthKey,
    inboxUsd: FieldValue.increment(callCostUsd),
    inboxCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  const spentAfter = cap.spentUsd + callCostUsd;

  // ── Parse + re-validate (extra keys are dropped; nothing is logged) ──
  const textBlock = Array.isArray(data.content) ? data.content.find((b) => b && b.type === 'text') : null;
  const parsed = L.parseInboxModelJson((textBlock && textBlock.text) || '');
  if (!parsed) {
    logger.warn('receipt-inbox.unparseable', { code: 'parse' });
    await failDraft('unreadable');
    return { inboxId, status: 'failed', reason: 'unreadable', spentUsd: spentAfter, capUsd: cap.capUsd };
  }
  const read = L.sanitizeInboxRead(parsed);

  // Personal / not a business receipt: dropped. Delete the file, keep only the hash + a counter.
  if (read.documentType === L.PERSONAL_DOC_TYPE) {
    let deleted = true;
    try { await getStorage().bucket().file(storagePath).delete(); } catch (e) { deleted = false; logger.warn('receipt-inbox.skip_delete_failed', { code: 'storage' }); }
    const skipped = L.buildSkippedFields({ companyId, ownerUid: uid, fileHash, mime: contentType, model: MODEL, costUsd: callCostUsd });
    if (!deleted) skipped.storagePath = storagePath;   // never claim a delete that did not happen
    await ref.set({ ...skipped, receivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await cfgRef.set({ skippedPersonal: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { inboxId, status: 'not_business', spentUsd: spentAfter, capUsd: cap.capUsd };
  }

  const fields = L.buildInboxDraftFields({
    read, companyId, ownerUid: uid, storagePath, fileHash, mime: contentType,
    model: MODEL, costUsd: callCostUsd, cardMap: cfg.cardMap, todayYmd: new Date().toISOString().slice(0, 10),
  });
  await ref.set({ ...fields, receivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { inboxId, status: fields.status, costUsd: callCostUsd, spentUsd: spentAfter, capUsd: cap.capUsd };
}));
