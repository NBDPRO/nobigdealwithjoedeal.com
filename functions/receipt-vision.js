/**
 * receipt-vision.js — Phase 2 of the expense subsystem: receipt OCR.
 *
 * The client uploads a receipt image/PDF to receipts/{uid}/... (Storage),
 * then calls extractReceiptData({ storagePath }). We read the bytes with the
 * admin SDK (no signed URL needed), send them to Claude Haiku vision, and
 * return a STRUCTURED extraction the entry form pre-fills — the rep ALWAYS
 * confirms before saving. The LLM is never accounting ground truth: a server
 * sum-reconcile (line items + tax vs total) sets a needsReview flag.
 *
 *   { extracted: { vendor, date, subtotalCents, taxCents, totalCents,
 *                  currency, lineItems[{description,amountCents}],
 *                  suggestedCategory, confidence },
 *     reconcile: { lineSumCents, taxCents, totalCents, diffCents, matched },
 *     needsReview, cached, costUsd }
 *
 * Deliberately mirrors analyzePhotoVision (functions/photo-vision.js): same
 * onCall + App Check + killswitch + rate limit, the SAME vision cost meters
 * (userCostMeter/{uid}__{month}.visionUsd — one shared AI budget), the same
 * sha256 content cache, and the same "re-clamp every field, never trust raw
 * output" discipline. Differences: receipts have no leadId at scan time (cap
 * by user only), the image comes from Storage as base64 (not a public URL),
 * and the schema is financial.
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

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ─── Tunables ──────────────────────────────────────────────────────
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 1500; // line-item receipts need more headroom than photo tags

// Haiku 4.5 pricing (verified 2026-05): $0.80/M in, $4.00/M out.
const COST_INPUT_PER_TOKEN  = 0.80 / 1_000_000;
const COST_OUTPUT_PER_TOKEN = 4.00 / 1_000_000;

// Per-user monthly vision spend cap — shared with photo-vision (same budget).
const PER_USER_MONTHLY_USD_CAP = 50.00;
const PER_USER_MONTHLY_USD_CAP_BY_PLAN = {
  // 'free' explicit (gap #6 seeds plan:'free') = $25, same as the Math.min
  // fallback below already gives it — pinned so it stays $25 even if the cap
  // set changes.
  free: 25.00,
  lite: 25.00, foundation: 25.00, starter: 25.00,
  // Team had no row (see photo-vision.js's sibling map for the same gap).
  blueprint: 40.00, team: 50.00, growth: 75.00, professional: 150.00,
};

const MAX_RECEIPT_BYTES = 25 * 1024 * 1024;
// Claude vision accepts only these image media types. HEIC/AVIF (allowed by
// the Storage rule) are NOT accepted — return a friendly error so the client
// falls back to manual entry rather than 500-ing.
const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// Category enum mirror (single source of truth is docs/pro/js/expense-config.js).
// Used only to re-clamp Claude's free-form category guess. Keep in sync.
const ALLOWED_CATEGORIES = new Set([
  'materials', 'subcontractor', 'direct_labor', 'equipment_dumpster', 'permits_fees',
  'disposal', 'vehicle_fuel', 'insurance', 'marketing', 'software', 'phone_internet',
  'office_supplies', 'professional_admin',
]);

// ─── Prompt ────────────────────────────────────────────────────────
const SYSTEM_PROMPT = [
  "You extract structured data from a photographed or scanned RECEIPT or SUPPLIER INVOICE",
  "for a roofing contractor's expense records. Output STRICT JSON only — no markdown fences,",
  "no explanation, no preamble.",
  "",
  "Schema:",
  "{",
  '  "vendor":    "merchant/supplier name as printed, or null if unreadable",',
  '  "date":      "YYYY-MM-DD of the purchase, or null if unreadable",',
  '  "subtotal":  number (pre-tax) or null,',
  '  "tax":       number (sales tax) or 0 if none shown,',
  '  "total":     number (grand total actually paid) or null,',
  '  "currency":  "USD",',
  '  "lineItems": [ { "description": "item text", "amount": number }, ... ]  (omit if not itemized),',
  '  "suggestedCategory": one of ["materials","subcontractor","direct_labor","equipment_dumpster",',
  '       "permits_fees","disposal","vehicle_fuel","insurance","marketing","software",',
  '       "phone_internet","office_supplies","professional_admin"] or null,',
  '  "confidence": 0.0-1.0',
  "}",
  "",
  "Rules:",
  "- All money values are plain numbers in dollars (e.g. 1234.56), NOT strings, NO currency symbols.",
  "- Return null for ANY field you cannot read confidently. Do NOT guess a total.",
  "- For a roofing-supplier receipt (shingles, underlayment, flashing) suggestedCategory is usually \"materials\".",
  "- A dump/landfill ticket -> \"disposal\"; equipment/dumpster rental -> \"equipment_dumpster\"; fuel -> \"vehicle_fuel\".",
  "- confidence reflects overall legibility/certainty. A blurry or partial receipt should score low (<0.5).",
  "- If the image is clearly NOT a receipt, return all-null money fields, confidence < 0.3, vendor describing what you see.",
].join('\n');

// ─── Number + extraction sanitizers ─────────────────────────────────
function dollarsToCents(v) {
  let n;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    // Strip currency symbol + thousands separators + whitespace, then require the
    // WHOLE remaining string to be a clean number. Plain parseFloat('2,450.00')
    // stops at the comma and returns 2 → a $2,450 receipt silently booked as $2.00
    // (thousands are the norm on a roofing-supplier order).
    const s = v.replace(/[$,\s]/g, '');
    n = /^-?\d*\.?\d+$/.test(s) ? parseFloat(s) : NaN;
  } else {
    n = NaN;
  }
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function sanitizeReceipt(raw) {
  const out = {
    vendor: '', date: null, subtotalCents: null, taxCents: 0, totalCents: null,
    currency: 'USD', lineItems: [], suggestedCategory: null, confidence: 0.5,
  };
  if (raw && typeof raw === 'object') {
    if (typeof raw.vendor === 'string') out.vendor = raw.vendor.slice(0, 120).trim();
    if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date.trim())) out.date = raw.date.trim();
    const sub = dollarsToCents(raw.subtotal); if (sub !== null) out.subtotalCents = sub;
    const tax = dollarsToCents(raw.tax); out.taxCents = tax === null ? 0 : tax;
    const tot = dollarsToCents(raw.total); if (tot !== null) out.totalCents = tot;
    if (ALLOWED_CATEGORIES.has(raw.suggestedCategory)) out.suggestedCategory = raw.suggestedCategory;
    // Accept a numeric OR numeric-string confidence (the model sometimes emits
    // "0.2"). A confidence that is PRESENT but unreadable is treated as untrusted
    // (0) so computeNeedsReview flags it — the old code discarded a string
    // confidence and silently kept the 0.5 default, hiding a low-confidence scan.
    let conf = 0.5;
    if (typeof raw.confidence === 'number' && !isNaN(raw.confidence)) conf = raw.confidence;
    else if (typeof raw.confidence === 'string' && /^\d*\.?\d+$/.test(raw.confidence.trim())) conf = parseFloat(raw.confidence.trim());
    else if (raw.confidence != null) conf = 0;
    out.confidence = Math.max(0, Math.min(1, conf));
    if (Array.isArray(raw.lineItems)) {
      out.lineItems = raw.lineItems.slice(0, 50).map((li) => {
        const amt = li ? dollarsToCents(li.amount) : null;
        const desc = (li && typeof li.description === 'string') ? li.description.slice(0, 120).trim() : '';
        return { description: desc, amountCents: amt === null ? 0 : amt };
      }).filter((li) => li.description || li.amountCents);
    }
  }
  return out;
}

// Server-side reconcile — the human-in-the-loop guard against a bad extraction.
function reconcile(r) {
  const lineSumCents = r.lineItems.reduce((s, li) => s + (li.amountCents || 0), 0);
  let diffCents = 0;
  let matched = true;
  if (r.totalCents != null) {
    // Prefer line-items+tax when itemized; else subtotal+tax; else nothing to check.
    let basis = null;
    if (r.lineItems.length) basis = lineSumCents + (r.taxCents || 0);
    else if (r.subtotalCents != null) basis = r.subtotalCents + (r.taxCents || 0);
    if (basis != null) {
      diffCents = Math.abs(basis - r.totalCents);
      matched = diffCents <= 2; // within 2 cents (rounding)
    }
  }
  return { lineSumCents, taxCents: r.taxCents || 0, totalCents: r.totalCents, diffCents, matched };
}

function computeNeedsReview(extracted, recon) {
  if (!recon.matched) return true;
  if (extracted.confidence < 0.5) return true;
  if (extracted.totalCents == null) return true;
  if (!extracted.vendor) return true;
  return false;
}

// HEIC/HEIF detection by ISOBMFF ftyp brand (bytes 4-8 = 'ftyp', 8-12 = brand).
// Trust the magic bytes over the client-declared content-type (often empty/wrong
// for camera uploads).
function isHeicBytes(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  var brand = buf.toString('ascii', 8, 12).toLowerCase();
  return ['heic', 'heix', 'mif1', 'heif', 'hevc', 'heim', 'heis', 'hevm', 'hevs'].indexOf(brand) !== -1;
}

// ─── Main handler ──────────────────────────────────────────────────
exports.extractReceiptData = onCall({
  region: 'us-central1',
  cors: CORS_ORIGINS,
  enforceAppCheck: true,
  secrets: [ANTHROPIC_API_KEY],
  timeoutSeconds: 60,
  memory: '1GiB', // HEIC decode inflates a 12MP image to a ~40-50MB raw buffer
  maxInstances: 20,
  concurrency: 40,
}, withSentry('extractReceiptData', async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  // 2026-09-25 (decision B, #1780 review): a viewer is refused. Each call
  // bills a Claude vision read, and its only use is filling in a new expense
  // — the Log Expense form role-gate.js hides from a viewer, whose expense
  // writes and receipts/{uid}/ uploads the rules refuse. So the spend buys a
  // viewer nothing (a pre-demotion receipt could otherwise be re-read).
  assertNotViewer(request.auth.token);

  if (await require('./integrations/killswitch').isAiDisabled()) {
    throw new HttpsError('unavailable', 'AI temporarily disabled');
  }

  // 30 receipts/min/uid — plenty for real use, blocks runaway loops.
  await callableRateLimit(request, 'extractReceiptData', 30, 60_000);

  const storagePath = typeof request.data?.storagePath === 'string' ? request.data.storagePath : null;
  if (!storagePath) throw new HttpsError('invalid-argument', 'storagePath required');

  // Owner-scope: the path MUST be under receipts/. A platform admin may OCR any
  // user's receipt (support), but NOT an arbitrary Storage object — so admins
  // are still confined to the receipts/ prefix, not given a blanket bypass
  // (QA finding).
  const isAdmin = request.auth.token && request.auth.token.role === 'admin';
  const requiredPrefix = isAdmin ? 'receipts/' : `receipts/${uid}/`;
  if (storagePath.indexOf(requiredPrefix) !== 0) {
    throw new HttpsError('permission-denied', 'Not your receipt path');
  }

  const db = getFirestore();

  // ── Per-user monthly cap (shared vision budget) ──
  const monthKey = new Date().toISOString().slice(0, 7);
  const userMeterRef = db.doc(`userCostMeter/${uid}__${monthKey}`);
  // Plan from the COMPANY subscription (companyId claim || uid) — uid-keyed
  // reads capped paying tenants' reps at the 'lite' budget (gauntlet gap).
  // The spend meter itself stays per-uid.
  const billingKey = (request.auth.token && request.auth.token.companyId) || uid;
  const [userMeterSnap, subSnap] = await Promise.all([
    userMeterRef.get(),
    db.doc(`subscriptions/${billingKey}`).get(),
  ]);
  const userUsd = (userMeterSnap.exists && userMeterSnap.data().visionUsd) || 0;
  const plan = (subSnap.exists && subSnap.data().plan) || 'lite';
  // Unmapped/legacy/free plans get the most CONSERVATIVE cap, not the $50
  // global mid-range (QA finding).
  var planCaps = Object.values(PER_USER_MONTHLY_USD_CAP_BY_PLAN);
  const userMonthlyCap = PER_USER_MONTHLY_USD_CAP_BY_PLAN[plan] ?? Math.min.apply(null, planCaps);
  if (userUsd >= userMonthlyCap) {
    logger.info('receipt-vision.cap.user', { uid, monthKey, userUsd, plan, cap: userMonthlyCap });
    return { skipped: true, reason: 'user-cap', userUsd, cap: userMonthlyCap };
  }

  // ── Read the receipt bytes via admin SDK ──
  let buf, contentType;
  try {
    const file = getStorage().bucket().file(storagePath);
    const [meta] = await file.getMetadata();
    contentType = (meta && meta.contentType) || 'application/octet-stream';
    if (meta && meta.size && Number(meta.size) > MAX_RECEIPT_BYTES) {
      throw new HttpsError('invalid-argument', 'Receipt too large');
    }
    [buf] = await file.download();
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.warn('receipt-vision.read_failed', { storagePath, err: e.message });
    throw new HttpsError('not-found', 'Receipt file not found');
  }

  // Decode HEIC/HEIF (the iPhone default) to JPEG — Claude vision only accepts
  // jpeg/png/gif/webp. Sniff the ftyp magic bytes, since camera uploads often
  // send an empty or wrong content-type. heic-convert is pure-JS/WASM (no
  // system libs) so it runs in the Functions runtime; require it lazily so
  // non-HEIC receipts don't pay the WASM init. (sharp can ENCODE jpeg but its
  // prebuilt binary can't DECODE heic, so it's not an option here.)
  if (/^image\/(heic|heif)$/.test(contentType) || isHeicBytes(buf)) {
    try {
      const convert = require('heic-convert');
      const out = await convert({ buffer: buf, format: 'JPEG', quality: 0.85 });
      buf = Buffer.from(out);
      contentType = 'image/jpeg';
    } catch (e) {
      logger.warn('receipt-vision.heic_decode_failed', { err: e.message });
      return { skipped: true, reason: 'unsupported-format', contentType: 'image/heic' };
    }
  }

  const isPdf = contentType === 'application/pdf';
  const isImage = /^image\//.test(contentType);
  if (!isPdf && !isImage) throw new HttpsError('invalid-argument', 'Unsupported receipt type');
  if (isImage && !CLAUDE_IMAGE_TYPES.has(contentType)) {
    // Still-unsupported (e.g. AVIF/TIFF) — Claude can't read these. Fall back.
    return { skipped: true, reason: 'unsupported-format', contentType };
  }

  // ── Content cache (sha256 of bytes): re-scanning the same receipt is free ──
  const cacheKey = 'rcpt_' + crypto.createHash('sha256').update(buf).digest('hex').slice(0, 28);
  const cacheRef = db.doc(`visionCache/${cacheKey}`);
  const cacheSnap = await cacheRef.get();
  if (cacheSnap.exists && cacheSnap.data().receipt) {
    const cached = cacheSnap.data().receipt;
    return { extracted: cached, reconcile: reconcile(cached), needsReview: computeNeedsReview(cached, reconcile(cached)), cached: true, costUsd: 0 };
  }

  const base64 = buf.toString('base64');
  const imageBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } };

  // ── Call Anthropic ──
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [imageBlock, { type: 'text', text: 'Extract the receipt data as strict JSON.' }],
    }],
  };

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
    logger.error('receipt-vision.fetch_failed', { err: e.message });
    throw new HttpsError('internal', 'Receipt OCR request failed');
  }
  if (!response.ok) {
    const msg = (data && data.error && data.error.message) || ('HTTP ' + response.status);
    logger.warn('receipt-vision.api_error', { status: response.status, msg });
    // Transient provider blip -> graceful manual-entry fallback (same path as
    // an unsupported format), not a 500 with raw provider text (QA finding).
    return { skipped: true, reason: 'ocr-unavailable', status: response.status };
  }

  // ── Parse + sanitize ──
  const textBlock = data.content && Array.isArray(data.content)
    ? data.content.find((b) => b && b.type === 'text') : null;
  const text = (textBlock && textBlock.text) || '';
  let rawExtraction;
  try {
    const cleaned = text.replace(/^```(?:json)?\s*|\s*```\s*$/g, '').trim();
    rawExtraction = JSON.parse(cleaned);
  } catch (e) {
    logger.warn('receipt-vision.unparseable', { snippet: text.slice(0, 200) });
    throw new HttpsError('internal', 'AI returned unparseable response');
  }
  const extracted = sanitizeReceipt(rawExtraction);
  const recon = reconcile(extracted);
  const needsReview = computeNeedsReview(extracted, recon);

  // ── Cost from usage block ──
  const usage = data.usage || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const callCostUsd = (inputTokens * COST_INPUT_PER_TOKEN) + (outputTokens * COST_OUTPUT_PER_TOKEN);

  // ── Atomically record cost + cache ──
  await db.runTransaction(async (tx) => {
    tx.set(userMeterRef, {
      uid, monthKey,
      visionUsd: FieldValue.increment(callCostUsd),
      visionCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.set(cacheRef, {
      cacheKey, receipt: extracted, model: MODEL,
      tokensIn: inputTokens, tokensOut: outputTokens, costUsd: callCostUsd,
      createdAt: FieldValue.serverTimestamp(),
    });
  });

  return { extracted, reconcile: recon, needsReview, cached: false, costUsd: callCostUsd };
}));

// Export the pure helpers for unit testing.
exports._test = { sanitizeReceipt, reconcile, computeNeedsReview, dollarsToCents, isHeicBytes };
