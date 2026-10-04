/**
 * integrations/thursday.js — Thursday (Bland AI receptionist) → NBD Pro.
 *
 * Thursday answers (513) 940-5589; Jo's cell forwards busy/unanswered calls to
 * her. Before this module nothing she heard reached the CRM.
 *
 *   thursdayWebhook       onRequest  Bland post-call webhook. Verifies the
 *                                    X-Webhook-Signature HMAC, then .create()s
 *                                    thursday_calls/bland_calls__{call_id}
 *                                    (status 'pending') and answers 200 fast.
 *                                    A redelivery hits "already exists" → 200.
 *   thursdayCallProcess   onDocumentWritten thursday_calls/{id} — runs only
 *                                    for status 'pending' | 'reprocess'
 *                                    (claimed in a transaction). Hydrates the
 *                                    call from GET /v1/calls/{id}, copies the
 *                                    recording into Storage, extracts JSON
 *                                    with Claude, matches NBD leads, routes
 *                                    (create lead / attach / possible match /
 *                                    inbox / log only), notifies Jo.
 *   thursdayCallerLookup  onRequest  Live lookup from Thursday's pathway so she
 *                                    greets a known caller by first name.
 *                                    Bearer THURSDAY_LOOKUP_TOKEN; returns
 *                                    first name + stage hint only.
 *   getThursdayRecording  onCall     Streams a saved recording to an
 *                                    authorised CRM user as base64 (no bearer
 *                                    URL ever leaves the server).
 *   thursdayCallAction    onCall     Thursday-inbox actions: mark reviewed,
 *                                    confirm a possible match, create a lead,
 *                                    attach to a lead, reprocess.
 *
 * The backfill (scripts/thursday-backfill.js) writes the SAME pending docs with
 * source 'backfill' and notify 'suppress', so history runs through this exact
 * pipeline without texting Jo thirty times.
 *
 * All decisions live in thursday-logic.js (pure, unit-tested). Setup and the
 * runbook: documentation/architecture/THURSDAY-BLAND-2026-09-26.md.
 */

'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { SECRETS, getSecret, hasSecret, secretValue, secretOr } = require('./_shared');
const { enforceRateLimit, clientIp } = require('./upstash-ratelimit');
const { resendRejected, resendErrorMessage } = require('../resend-guard');
const T = require('./thursday-logic');
const { createLeadWithCustomerId, isAlreadyExists } = require('../customer-id-mint');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const REGION = 'us-central1';
const BLAND_API = 'https://api.bland.ai/v1';
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_RECORDING_BYTES = 25 * 1024 * 1024;
// Callable responses cap at 10 MB after base64 (×4/3), so recordings stream
// in 5 MB parts. Bland records WAV (~1 MB/min) and the agent allows 10-minute
// calls, so one part was never enough.
const RECORDING_PART_BYTES = 5 * 1024 * 1024;
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const COMPANY_STAFF = ['company_admin', 'manager'];
const COMPANY_READERS = ['company_admin', 'manager', 'viewer'];

// Jo's defaults; thursday_config/{companyId} overrides without a deploy.
// (scripts/thursday-config.js writes that doc.)
const DEFAULT_CONFIG = {
  enabled: true,
  agentNumber: T.THURSDAY_NUMBER,
  smsEnabled: false,           // Bland SMS needs the Agent Phone Plan
  smsTo: '+18594207382',       // same cell as lead-alert.js ALERT_SMS
  emailTo: ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'],
  pushEnabled: true,
  ownerNumbers: T.OWNER_NUMBERS_DEFAULT,   // Jo's phones — calls from them are tests
};

function db() { return getFirestore(); }

async function loadConfig(companyId) {
  try {
    const snap = await db().doc('thursday_config/' + companyId).get();
    const c = snap.exists ? snap.data() || {} : {};
    return {
      enabled: c.enabled !== false,
      agentNumber: T.toE164(c.agentNumber) || DEFAULT_CONFIG.agentNumber,
      smsEnabled: c.smsEnabled === true,
      smsTo: T.toE164(c.smsTo) || DEFAULT_CONFIG.smsTo,
      emailTo: Array.isArray(c.emailTo) && c.emailTo.length ? c.emailTo.map(String) : DEFAULT_CONFIG.emailTo,
      pushEnabled: c.pushEnabled !== false,
      pushUid: String(c.pushUid || companyId),
      ownerNumbers: [].concat(DEFAULT_CONFIG.ownerNumbers, Array.isArray(c.ownerNumbers) ? c.ownerNumbers.map(String) : []),
    };
  } catch (e) {
    logger.warn('thursday: config read failed, using defaults', { err: e && e.message });
    return Object.assign({}, DEFAULT_CONFIG, { pushUid: companyId });
  }
}

// A trimmed copy of the raw payload for debugging. The transcript already
// lives on the doc; pathway_logs can be huge, so only small scalars and the
// variables map are kept (capped), never the whole body.
function trimRaw(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (v == null) continue;
    if (['string', 'number', 'boolean'].indexOf(typeof v) !== -1) {
      out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
    }
  }
  if (body && body.variables && typeof body.variables === 'object') {
    try { out.variablesJson = JSON.stringify(body.variables).slice(0, 8000); } catch (e) { /* ignore */ }
  }
  delete out.concatenated_transcript;
  return out;
}

// ── Webhook ─────────────────────────────────────────────────────────────────

exports.thursdayWebhook = onRequest(
  {
    region: REGION,
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: '256MiB',
    secrets: [SECRETS.BLAND_WEBHOOK_SECRET],
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    // Fail closed: without the signing secret anyone who learns the URL could
    // create CRM leads in NBD's pipeline.
    if (!hasSecret('BLAND_WEBHOOK_SECRET')) {
      logger.error('thursdayWebhook: BLAND_WEBHOOK_SECRET not set — rejecting');
      res.status(503).json({ error: 'Webhook not configured' });
      return;
    }
    if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
      res.status(400).json({ error: 'Missing body' });
      return;
    }
    if (req.rawBody.length > MAX_WEBHOOK_BYTES) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    const sig = req.headers['x-webhook-signature'];
    if (!T.verifyBlandSignature(req.rawBody, sig, getSecret('BLAND_WEBHOOK_SECRET'))) {
      logger.warn('thursdayWebhook: bad signature', { hasSig: !!sig, bytes: req.rawBody.length });
      res.status(401).json({ error: 'Bad signature' });
      return;
    }

    let body;
    try { body = JSON.parse(req.rawBody.toString('utf8')); } catch (e) {
      res.status(400).json({ error: 'Bad JSON' });
      return;
    }
    const call = T.normalizeCall(body);
    // SMS-conversation webhooks and other non-call events carry no call_id.
    // 200 so Bland does not retry-storm something we deliberately ignore.
    if (!T.isValidCallId(call.callId)) {
      logger.info('thursdayWebhook: ignored payload without a call id', { keys: Object.keys(body || {}).slice(0, 20) });
      res.status(200).json({ ok: true, ignored: 'no-call-id' });
      return;
    }
    const cfg = await loadConfig(T.NBD_OWNER_UID);
    if (!T.isThursdayCall(call, cfg.agentNumber)) {
      logger.info('thursdayWebhook: not a Thursday inbound call — ignored', { callId: call.callId, toLast4: String(call.to || '').replace(/\D/g, '').slice(-4), inbound: call.inbound });
      res.status(200).json({ ok: true, ignored: 'not-thursday' });
      return;
    }

    const ref = db().doc('thursday_calls/' + T.callDocId(call.callId));
    try {
      await ref.create(Object.assign(T.buildPendingCallDoc(call, 'webhook', { raw: trimRaw(body) }),
        { createdAt: FieldValue.serverTimestamp() }));
    } catch (e) {
      if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) {
        logger.info('thursdayWebhook: duplicate delivery', { callId: call.callId });
        res.status(200).json({ ok: true, duplicate: true });
        return;
      }
      logger.error('thursdayWebhook: write failed', { callId: call.callId, err: e && e.message });
      res.status(500).json({ error: 'Write failed' });   // Bland retries on 5xx
      return;
    }
    logger.info('thursdayWebhook: call queued', { callId: call.callId, durationSec: call.durationSec });
    res.status(200).json({ ok: true });
  }
);

// ── Bland API helpers ───────────────────────────────────────────────────────

function blandKey() {
  return hasSecret('BLAND_API_KEY') ? getSecret('BLAND_API_KEY') : null;
}

async function fetchBlandCall(callId, key) {
  const r = await fetch(BLAND_API + '/calls/' + encodeURIComponent(callId), {
    headers: { authorization: key },
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('bland GET call ' + r.status);
  return r.json();
}

function extForContentType(ct) {
  const c = String(ct || '').toLowerCase();
  if (c.indexOf('wav') !== -1) return 'wav';
  if (c.indexOf('ogg') !== -1) return 'ogg';
  if (c.indexOf('mp4') !== -1 || c.indexOf('m4a') !== -1) return 'm4a';
  return 'mp3';
}

// Bland's recording_url needs the API key, so the browser can never play it.
// Copy it once into Storage (server-only path, read through the callable).
async function saveRecording(call, key, ownerUid) {
  const tries = [];
  if (call.recordingUrl) tries.push({ url: call.recordingUrl, headers: { authorization: key } });
  tries.push({ url: BLAND_API + '/calls/' + encodeURIComponent(call.callId) + '/recording', headers: { authorization: key } });
  let lastErr = null;
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { headers: t.headers, signal: AbortSignal.timeout(60000) });
      if (!r.ok) { lastErr = new Error('recording ' + r.status); continue; }
      const ct = r.headers.get('content-type') || 'audio/mpeg';
      if (/json|html|text/i.test(ct)) { lastErr = new Error('recording not audio: ' + ct); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) { lastErr = new Error('recording empty'); continue; }
      if (buf.length > MAX_RECORDING_BYTES) { lastErr = new Error('recording too large: ' + buf.length); continue; }
      const ext = extForContentType(ct);
      const path = 'calls/' + ownerUid + '/' + call.callId + '.' + ext;
      await getStorage().bucket().file(path).save(buf, {
        resumable: false,
        metadata: {
          contentType: ct.split(';')[0].trim(),
          cacheControl: 'private, max-age=0',
          metadata: { callId: call.callId, source: 'thursday' },
        },
      });
      return { path, bytes: buf.length, contentType: ct.split(';')[0].trim() };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('recording unavailable');
}

async function extract(call) {
  if (T.isEffectivelySilent(call)) {
    return { extraction: T.silentExtraction(call), meta: { skipped: 'silent' } };
  }
  const key = secretValue(ANTHROPIC_API_KEY);
  if (!key) throw new T.ExtractionError('anthropic-not-configured');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: T.extractionHeaders(key),
      body: JSON.stringify(T.buildExtractionRequest(call)),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw new T.ExtractionError('network', String(e && e.message).slice(0, 200));
  }
  const json = await r.json().catch(() => null);
  if (!r.ok) {
    throw new T.ExtractionError('api-' + r.status, String((json && json.error && json.error.message) || '').slice(0, 300));
  }
  const p = T.parseExtractionResponse(json);
  return {
    extraction: T.sanitizeExtraction(p.parsed),
    meta: { model: p.model, inputTokens: p.usage.inputTokens, outputTokens: p.usage.outputTokens, costUsd: p.costUsd },
  };
}

const LEAD_MATCH_FIELDS = [
  'companyId', 'firstName', 'lastName', 'name', 'address', 'street', 'city', 'town', 'state', 'zip',
  'phone', 'phoneDigits', 'altPhone', 'altPhoneDigits', 'phone2', 'source', 'stage', 'claimNumber', 'deleted', 'isDeleted', 'deletedAt',
];

// Tenant guard #1: the query itself is scoped to the company.
async function loadCompanyLeads(companyId) {
  const snap = await db().collection('leads').where('companyId', '==', companyId).select(...LEAD_MATCH_FIELDS).get();
  return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
}

// Tenant guard #3: re-read a lead before writing under it.
async function assertCompanyLead(leadId, companyId) {
  if (!leadId || typeof leadId !== 'string' || leadId.indexOf('/') !== -1) throw new Error('bad lead id');
  const snap = await db().doc('leads/' + leadId).get();
  if (!snap.exists) throw new Error('lead not found: ' + leadId);
  const d = snap.data() || {};
  if (String(d.companyId || '') !== String(companyId)) throw new Error('lead outside tenant: ' + leadId);
  return d;
}

async function createIfAbsent(ref, data) {
  try { await ref.create(data); return true; } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) return false;
    throw e;
  }
}

// Writes the route's CRM effects. Returns { leadId, taskId }.
async function applyRoute(args) {
  const { route, extraction, call, companyId, ownerUid } = args;
  let leadId = route.leadId || null;

  if (route.action === 'create_lead') {
    leadId = T.leadDocIdForCall(call.callId);
    const doc = T.buildLeadDoc({ extraction, call, ownerUid, companyId });
    // Create-if-absent, with the customerId minted in the same transaction.
    try {
      await createLeadWithCustomerId(db(), db().doc('leads/' + leadId), Object.assign(doc, {
        createdAt: FieldValue.serverTimestamp(),
        stageStartedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }));
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
  }
  if (!leadId || route.action === 'inbox' || route.action === 'log_only') return { leadId: null, taskId: null };

  const lead = await assertCompanyLead(leadId, companyId);

  // Strong attach: fill blanks only — never overwrite what Jo typed, never
  // touch stage/source. A Thumbtack lead's proxy number stays; the caller's
  // real number goes in altPhone so the next call (and inbound SMS) matches.
  if (route.action === 'attach') {
    const patch = Object.assign({ thursdayLastCallAt: FieldValue.serverTimestamp() },
      T.secondNumberPatch(lead, call, extraction));
    if (extraction.email && !lead.email) patch.email = extraction.email;
    await db().doc('leads/' + leadId).set(patch, { merge: true });
  }

  const activity = T.buildActivity({ extraction, call, route, ownerUid, companyId });
  await db().doc('leads/' + leadId + '/activity/' + T.activityIdForCall(call.callId))
    .set(Object.assign(activity, { createdAt: FieldValue.serverTimestamp() }));

  let taskId = null;
  if (route.createTask) {
    taskId = T.taskIdForCall(call.callId);
    const task = T.buildTask({ extraction, call, route, leadId, ownerUid });
    // create(): a reprocess must never un-tick a task Jo already completed.
    await createIfAbsent(db().doc('leads/' + leadId + '/tasks/' + taskId),
      Object.assign(task, { createdAt: FieldValue.serverTimestamp() }));
  }
  return { leadId, taskId };
}

// ── Notifications ───────────────────────────────────────────────────────────

async function sendEmail(cfg, mail) {
  const key = secretValue(RESEND_API_KEY);
  if (!key) return 'skipped:no-resend-key';
  const { Resend } = require('resend');
  const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
  // Email category: INTERNAL — Jo's own call alert inbox. Out of scope for the
  // homeowner unsubscribe register (email-suppression.js SEND_PATHS).
  const resp = await new Resend(key).emails.send({
    from, to: cfg.emailTo, subject: mail.subject, html: mail.html, text: mail.text,
  });
  if (resendRejected(resp)) throw new Error(resendErrorMessage(resp));
  return 'sent';
}

async function sendPush(cfg, push, callId, urgent) {
  const { sendCustomNotification } = require('../push-functions');
  const r = await sendCustomNotification(cfg.pushUid, push.title, push.body, {
    type: 'thursday_call',
    clickUrl: push.url,
    notificationId: 'thursday-' + callId,
    requireInteraction: urgent ? 'true' : 'false',
  });
  return r && r.sent > 0 ? 'sent' : 'skipped:no-device';
}

// Bland SMS works only on the Agent Phone Plan. Until Jo is on it the flag
// stays off; when it is on and Bland still refuses, record why, never throw.
async function sendSms(cfg, text) {
  if (!cfg.smsEnabled) return 'skipped:flag-off';
  const key = blandKey();
  if (!key) return 'skipped:no-bland-key';
  const r = await fetch(BLAND_API + '/sms/send', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({ user_number: cfg.smsTo, agent_number: cfg.agentNumber, agent_message: text }),
    signal: AbortSignal.timeout(20000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok || (json && json.errors && json.errors.length)) {
    const msg = JSON.stringify((json && (json.errors || json.message)) || r.status).slice(0, 300);
    const planIssue = /plan|enterprise|not\s*(enabled|available)|upgrade|subscription/i.test(msg);
    logger.warn('thursday: Bland SMS not delivered' + (planIssue ? ' — Agent Phone Plan required?' : ''), { status: r.status, msg });
    return (planIssue ? 'plan_required:' : 'failed:') + msg;
  }
  return 'sent';
}

async function notifyAll(ref, data, ctx) {
  if (data.notify === 'suppress') return;
  const sent = (data.notifyState || {});
  const results = {};
  const jobs = [];
  if (ctx.route.notifyEmail && !(sent.email && sent.email.sentAt)) {
    jobs.push(['email', () => sendEmail(ctx.cfg, T.buildEmail(ctx.bodyArgs))]);
  }
  if (ctx.route.notifyPush && ctx.cfg.pushEnabled && !(sent.push && sent.push.sentAt)) {
    jobs.push(['push', () => sendPush(ctx.cfg, T.buildPush(ctx.bodyArgs), ctx.call.callId, ctx.route.urgent)]);
  }
  if (ctx.route.notifySms && !(sent.sms && sent.sms.sentAt)) {
    jobs.push(['sms', () => sendSms(ctx.cfg, T.buildSmsText(ctx.bodyArgs))]);
  }
  await Promise.all(jobs.map(async ([ch, fn]) => {
    let status;
    try { status = await fn(); } catch (e) { status = 'failed:' + String(e && e.message || e).slice(0, 200); }
    results['notifyState.' + ch] = status === 'sent'
      ? { status, sentAt: FieldValue.serverTimestamp() }
      : { status, attemptedAt: FieldValue.serverTimestamp() };
    if (status !== 'sent') logger.info('thursday: ' + ch + ' not sent', { callId: ctx.call.callId, status });
  }));
  if (Object.keys(results).length) await ref.update(results);
}

// ── Processing trigger ──────────────────────────────────────────────────────

// A 'processing' claim older than STALE_PROCESSING_MS (> the trigger's 300s
// timeout) belongs to a run that was killed mid-flight — a timeout kill never
// reaches the catch below, so nothing else would ever move the doc on.
function isStaleProcessing(d, now) {
  if (!d || d.status !== 'processing') return false;
  const at = d.processingStartedAt;
  const ms = at && typeof at.toMillis === 'function' ? at.toMillis() : null;
  // No usable start stamp on a 'processing' doc: nothing can be running it.
  if (ms == null) return true;
  return (now == null ? Date.now() : now) - ms > STALE_PROCESSING_MS;
}

async function claim(ref) {
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const d = snap.data() || {};
    const stale = isStaleProcessing(d);
    if (d.status !== 'pending' && d.status !== 'reprocess' && !stale) return null;
    tx.update(ref, { status: 'processing', processingStartedAt: FieldValue.serverTimestamp(), attempts: FieldValue.increment(1) });
    return d;
  });
}

async function processCall(ref, data) {
  const companyId = String(data.companyId || T.NBD_OWNER_UID);
  const ownerUid = String(data.userId || companyId);
  const cfg = await loadConfig(companyId);
  let call = Object.assign({}, data.call || {});
  const key = blandKey();
  const update = {};

  // 1. Hydrate — the webhook may arrive before Bland finishes the transcript.
  if (key && (!call.transcript || !call.recordingUrl || !call.summary)) {
    try {
      const fresh = T.normalizeCall(await fetchBlandCall(call.callId, key));
      for (const k of Object.keys(fresh)) {
        const v = fresh[k];
        const empty = call[k] == null || call[k] === '' || (Array.isArray(call[k]) && !call[k].length) || call[k] === 0;
        if (empty && v != null && v !== '') call[k] = v;
      }
      update.call = call;
    } catch (e) {
      logger.warn('thursday: hydrate failed', { callId: call.callId, err: e && e.message });
    }
  }

  // 2. Recording → Storage.
  if (!data.recordingPath && key) {
    try {
      const rec = await saveRecording(call, key, ownerUid);
      update.recordingPath = rec.path;
      update.recordingBytes = rec.bytes;
      update.recordingContentType = rec.contentType;
      update.recordingError = FieldValue.delete();
    } catch (e) {
      update.recordingError = String(e && e.message || e).slice(0, 200);
    }
  }

  // 3. Extraction.
  let extraction = null;
  let extractionError = null;
  try {
    const x = await extract(call);
    extraction = T.applyCallOverrides(x.extraction, call, { ownerNumbers: cfg.ownerNumbers });
    update.extractionMeta = x.meta;
  } catch (e) {
    extractionError = (e && e.code) || 'error';
    update.extractionError = extractionError + (e && e.message && e.message !== e.code ? ': ' + String(e.message).slice(0, 200) : '');
    logger.error('thursday: extraction failed', { callId: call.callId, err: update.extractionError });
  }

  // 4 + 5. Match + route. A failed extraction still reaches Jo (inbox + email
  // + push with Bland's summary) — a call must never vanish.
  let route;
  let match = { confidence: 'none', possible: [] };
  if (extraction) {
    match = T.matchLeads({ companyId, extraction, call, leads: await loadCompanyLeads(companyId) });
    route = T.decideRoute(extraction, match);
  } else {
    route = {
      action: 'inbox', leadId: null, possibleMatches: [], urgent: false, createTask: false,
      notifyPush: true, notifyEmail: true, notifySms: false, label: 'Needs review',
    };
  }
  const effects = extraction ? await applyRoute({ route, extraction, call, companyId, ownerUid }) : { leadId: null, taskId: null };

  Object.assign(update, {
    extraction: extraction || null,
    callerType: extraction ? extraction.caller_type : 'unknown',
    callerName: extraction ? extraction.caller_name : '',
    town: extraction ? extraction.town : '',
    issue: extraction ? extraction.issue : T.str(call.summary, 300),
    urgent: !!(extraction && extraction.urgent),
    route: {
      action: route.action, label: route.label,
      leadId: effects.leadId, possibleMatches: route.possibleMatches || [],
    },
    leadId: effects.leadId || null,
    taskId: effects.taskId || null,
    startedAt: call.startedAt ? new Date(call.startedAt) : (data.startedAt || null),
    durationSec: call.durationSec || 0,
    reviewed: route.action === 'log_only' ? true : !!data.reviewed && data.status === 'reprocess',
    status: extraction ? 'processed' : 'failed',
    processedAt: FieldValue.serverTimestamp(),
  });
  await ref.update(update);

  // 6. Notify (idempotent per channel).
  await notifyAll(ref, data, {
    cfg, route, call,
    bodyArgs: {
      extraction, call, route: Object.assign({}, route, { possibleMatches: route.possibleMatches }),
      leadId: effects.leadId || route.leadId, recordingSaved: !!(update.recordingPath || data.recordingPath),
      extractionError,
    },
  });
  logger.info('thursday: call processed', { callId: call.callId, action: route.action, leadId: effects.leadId, match: match.confidence });
}

exports.thursdayCallProcess = onDocumentWritten(
  {
    document: 'thursday_calls/{docId}',
    region: REGION,
    timeoutSeconds: 300,
    memory: '512MiB',
    maxInstances: 5,
    secrets: [SECRETS.BLAND_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, EMAIL_FROM],
  },
  async (event) => {
    const after = event.data && event.data.after;
    if (!after || !after.exists) return;
    const status = (after.data() || {}).status;
    if (status !== 'pending' && status !== 'reprocess') return;
    const ref = after.ref;
    const data = await claim(ref);
    if (!data) return;
    try {
      await processCall(ref, data);
    } catch (e) {
      logger.error('thursday: processing failed', { doc: ref.id, err: e && e.stack || e });
      await ref.update({ status: 'failed', processError: String(e && e.message || e).slice(0, 300), processedAt: FieldValue.serverTimestamp() })
        .catch((w) => {
          // Was swallowed silently: the doc then stays 'processing' with no
          // trace of why. It is recoverable (reprocess once the claim is
          // stale) but only if someone can see it happened.
          logger.error('thursday: failure write failed — call left processing', {
            doc: ref.id, err: w && w.message, processErr: String(e && e.message || e).slice(0, 200),
          });
        });
    }
  }
);

// ── Live caller lookup ──────────────────────────────────────────────────────

exports.thursdayCallerLookup = onRequest(
  {
    region: REGION,
    maxInstances: 5,
    timeoutSeconds: 10,
    memory: '256MiB',
    secrets: [SECRETS.THURSDAY_LOOKUP_TOKEN],
  },
  async (req, res) => {
    const unknown = { known: false, first_name: '', job_hint: '' };
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!hasSecret('THURSDAY_LOOKUP_TOKEN')) { res.status(503).json(unknown); return; }
    if (!T.bearerMatches(req.headers.authorization, getSecret('THURSDAY_LOOKUP_TOKEN'))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      await enforceRateLimit('thursdayLookup:ip', String(clientIp(req) || 'unknown'), 120, 60_000);
    } catch (e) {
      if (e && e.rateLimited) { res.set('Retry-After', '60'); res.status(429).json(unknown); return; }
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const from = T.str(body.from || body.phone_number || body.caller || '', 32);
    const digits = String(from).replace(/\D/g, '').replace(/^1/, '').slice(-10);
    if (digits.length !== 10) { res.status(200).json(unknown); return; }
    try {
      const col = db().collection('leads').where('companyId', '==', T.NBD_OWNER_UID);
      const [byMain, byAlt] = await Promise.all([
        col.where('phoneDigits', '==', digits).select(...LEAD_MATCH_FIELDS).limit(5).get(),
        col.where('altPhoneDigits', '==', digits).select(...LEAD_MATCH_FIELDS).limit(5).get(),
      ]);
      const leads = byMain.docs.concat(byAlt.docs).map((d) => Object.assign({ id: d.id }, d.data()));
      const out = T.buildLookupResponse({ companyId: T.NBD_OWNER_UID, from: digits, leads });
      logger.info('thursdayCallerLookup', { last4: digits.slice(-4), known: out.known, candidates: leads.length });
      res.status(200).json(out);
    } catch (e) {
      logger.error('thursdayCallerLookup failed', { err: e && e.message });
      res.status(200).json(unknown);   // never block the greeting
    }
  }
);

// ── CRM callables ───────────────────────────────────────────────────────────

async function loadCallForCaller(request, opts) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const callId = String((request.data && request.data.callId) || '');
  if (!T.isValidCallId(callId)) throw new HttpsError('invalid-argument', 'Bad call id.');
  const ref = db().doc('thursday_calls/' + T.callDocId(callId));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Call not found.');
  const d = snap.data() || {};
  const token = request.auth.token || {};
  const role = String(token.role || '');
  const isAdmin = role === 'admin';
  const isOwner = request.auth.uid === d.userId;
  const sameCompany = !!(token.companyId && d.companyId && token.companyId === d.companyId);
  if (opts.write) {
    if (role === 'viewer') throw new HttpsError('permission-denied', 'Your role is view-only.');
    if (!(isAdmin || isOwner || (sameCompany && COMPANY_STAFF.indexOf(role) !== -1))) {
      throw new HttpsError('permission-denied', 'Not your call.');
    }
  } else if (!(isAdmin || isOwner || (sameCompany && COMPANY_READERS.indexOf(role) !== -1))) {
    // Same audience as the firestore.rules read on thursday_calls.
    throw new HttpsError('permission-denied', 'Not your call.');
  }
  return { ref, data: d, callId };
}

exports.getThursdayRecording = onCall(
  { region: REGION, enforceAppCheck: true, memory: '512MiB', timeoutSeconds: 60, maxInstances: 10 },
  async (request) => {
    const { data } = await loadCallForCaller(request, { write: false });
    if (!data.recordingPath) throw new HttpsError('not-found', 'No recording saved for this call.');
    const file = getStorage().bucket().file(data.recordingPath);
    const [meta] = await file.getMetadata();
    const total = Number(meta.size) || 0;
    const parts = Math.max(1, Math.ceil(total / RECORDING_PART_BYTES));
    const part = Math.floor(Number((request.data && request.data.part) || 0));
    if (!(part >= 0 && part < parts)) throw new HttpsError('invalid-argument', 'Bad part.');
    const start = part * RECORDING_PART_BYTES;
    const end = Math.min(total, start + RECORDING_PART_BYTES) - 1;
    const [buf] = await file.download(total ? { start, end } : {});
    return { contentType: meta.contentType || 'audio/mpeg', base64: buf.toString('base64'), part, parts, totalBytes: total };
  }
);

exports.thursdayCallAction = onCall(
  { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60, maxInstances: 10 },
  async (request) => {
    const { ref, data, callId } = await loadCallForCaller(request, { write: true });
    const action = String((request.data && request.data.action) || '');
    const companyId = String(data.companyId);
    const ownerUid = String(data.userId || companyId);
    const by = { uid: request.auth.uid, at: FieldValue.serverTimestamp() };

    if (action === 'mark_reviewed' || action === 'mark_unreviewed') {
      await ref.update({ reviewed: action === 'mark_reviewed', reviewedBy: by });
      return { ok: true };
    }
    if (action === 'reprocess') {
      // A live run is refused; a STALE claim (killed by the trigger's
      // timeout — the doc would otherwise sit in 'processing' forever) is
      // re-queued. Same staleness rule as claim().
      if (data.status === 'processing' && !isStaleProcessing(data)) {
        throw new HttpsError('failed-precondition', 'Already processing.');
      }
      await ref.update({ status: 'reprocess', reprocessRequestedBy: by, notify: 'suppress' });
      return { ok: true };
    }

    const extraction = data.extraction ? T.sanitizeExtraction(data.extraction) : null;
    const call = data.call || {};
    if (!extraction) throw new HttpsError('failed-precondition', 'This call has no extracted details yet — reprocess it first.');

    let leadId;
    if (action === 'create_lead') {
      const route = { action: 'create_lead', createTask: true, label: 'New lead', urgent: extraction.urgent };
      const fx = await applyRoute({ route, extraction, call, companyId, ownerUid });
      leadId = fx.leadId;
      await ref.update({ leadId, taskId: fx.taskId, reviewed: true, reviewedBy: by,
        route: { action: 'create_lead', label: 'New lead (from inbox)', leadId, possibleMatches: (data.route && data.route.possibleMatches) || [] } });
      return { ok: true, leadId };
    }
    if (action === 'confirm_match' || action === 'attach_to') {
      leadId = String((request.data && request.data.leadId) || (data.route && data.route.leadId) || '');
      if (action === 'confirm_match') {
        const allowed = ((data.route && data.route.possibleMatches) || []).map((p) => p.leadId);
        if (allowed.indexOf(leadId) === -1) throw new HttpsError('invalid-argument', 'Not one of the possible matches.');
      }
      try { await assertCompanyLead(leadId, companyId); } catch (e) {
        throw new HttpsError('permission-denied', 'That lead is not in your company.');
      }
      const route = { action: 'attach', leadId, createTask: true, label: 'Attached from inbox', urgent: extraction.urgent };
      const fx = await applyRoute({ route, extraction, call, companyId, ownerUid });
      await ref.update({ leadId, taskId: fx.taskId, reviewed: true, reviewedBy: by,
        route: { action: 'attach', label: 'Attached from inbox', leadId, possibleMatches: (data.route && data.route.possibleMatches) || [] } });
      return { ok: true, leadId };
    }
    throw new HttpsError('invalid-argument', 'Unknown action.');
  }
);

module.exports = exports;
