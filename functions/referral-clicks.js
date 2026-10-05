/**
 * functions/referral-clicks.js — count referral-link opens (2026-10-04).
 *
 * "Reviews and referrals results" (the numbers audit) wants referral links
 * CLICKED per month beside referred leads and referred wins. Nothing counted
 * an open: /pro/refer.html only ever talked to the server on submit. This is
 * a counter, nothing more — refer.js POSTs { ref } once per browser session
 * when the page opens with a ?ref= code.
 *
 * The code's tenant is resolved the same way submitReferral does it (the
 * leading prefix → docPrefixes/{PREFIX}.companyId). An unknown prefix is
 * dropped silently: no lead lookup, no PII, no write. A known one increments
 *   companies/{companyId}/owner_numbers/referral_clicks_YYYY-MM
 *     { month, clicks, byCode: { CODE: n }, updatedAt }
 * which only the company owner can read (firestore.rules owner_numbers).
 *
 * Abuse: per-IP 20 / 10 min, POST only, the code is shape-checked; the worst
 * a flood can do is inflate a click count the owner reads as a soft signal.
 */
'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { httpRateLimit } = require('./integrations/upstash-ratelimit');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

/** 'NBD-0042' → { code, prefix } or null. Pure. */
function parseRef(raw) {
  const code = String(raw || '').trim().toUpperCase();
  if (code.length < 4 || code.length > 32 || !/^[A-Z0-9-]+$/.test(code)) return null;
  const prefix = code.split('-')[0] || '';
  if (!/^[A-Z0-9]{2,12}$/.test(prefix) || prefix === code) return null;
  return { code, prefix };
}

/** 'YYYY-MM' in Eastern time. */
function monthEt(ms) {
  try {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(new Date(ms));
    const g = (t) => (p.find((x) => x.type === t) || {}).value;
    return g('year') + '-' + g('month');
  } catch (_) { return new Date(ms).toISOString().slice(0, 7); }
}

async function recordClick(db, rawRef, nowMs) {
  const r = parseRef(rawRef);
  if (!r) return { skipped: 'bad_ref' };
  const pfx = await db.doc('docPrefixes/' + r.prefix).get();
  let companyId = pfx.exists ? pfx.get('companyId') : null;
  if (!companyId) {
    // Legacy codes minted before prefix reservation (NBD-####): resolve by the
    // one lead that carries the code, exactly as submitReferral falls back.
    // Two or more matches = ambiguous → not counted.
    const q = await db.collection('leads').where('customerId', '==', r.code).limit(2).get();
    if (q.size === 1) companyId = q.docs[0].get('companyId') || q.docs[0].get('userId') || null;
  }
  if (!companyId || typeof companyId !== 'string' || companyId.indexOf('/') !== -1) return { skipped: 'unknown_prefix' };
  const month = monthEt(nowMs);
  await db.doc('companies/' + companyId + '/owner_numbers/referral_clicks_' + month).set({
    month,
    clicks: FieldValue.increment(1),
    byCode: { [r.code]: FieldValue.increment(1) },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { counted: true, companyId, month };
}

exports.referralLinkOpened = onRequest(
  { region: 'us-central1', cors: false, maxInstances: 10, concurrency: 60, timeoutSeconds: 10, memory: '256MiB' },
  async (req, res) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.includes(origin)) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    if (!(await httpRateLimit(req, res, 'refclick:ip', 20, 10 * 60_000))) return;
    try {
      await recordClick(getFirestore(), (req.body || {}).ref, Date.now());
    } catch (e) {
      logger.warn('[referralLinkOpened] failed', { err: e && e.message });
    }
    // Same answer either way — the page never learns whether a code is real.
    res.status(204).end();
  }
);

exports._test = { parseRef, monthEt, recordClick };
