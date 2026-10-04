/**
 * integrations/thursday-logic.js — pure logic for the Thursday (Bland AI
 * receptionist) → NBD Pro call pipeline.
 *
 * Firebase-free on purpose: integrations/thursday.js (the Cloud Functions),
 * scripts/thursday-backfill.js and tests/thursday-logic.test.js all require
 * this file, and the backfill's dry-run must reach the SAME route decision
 * the live trigger would — so every decision lives here, not in the handlers.
 *
 * Pipeline (see documentation/architecture/THURSDAY-BLAND-2026-09-26.md):
 *   webhook → verifyBlandSignature → normalizeCall → thursday_calls doc
 *   trigger → buildExtractionRequest / parseExtractionResponse →
 *             sanitizeExtraction → matchLeads → decideRoute →
 *             buildLeadDoc / buildTask / buildActivity → notify bodies
 *
 * TENANT SCOPING: Thursday answers NBD's number, so every lead she creates or
 * touches belongs to NBD's companyId. The handler's Firestore query is
 * already `where('companyId','==',cid)`; matchLeads() filters on companyId a
 * second time so a query mistake can never attach a caller to another
 * tenant's customer (tests/thursday-logic.test.js pins this).
 */

'use strict';

const crypto = require('crypto');
const { phoneDigits10 } = require('../phone-utils');

// ── Constants ───────────────────────────────────────────────────────────────

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const THURSDAY_NUMBER = '+15139405589';
const DOC_PREFIX = 'bland_calls__';
const INTAKE_LABEL = 'Phone — Thursday';
const SOURCE_PAGE = 'phone:thursday';
const PUBLIC_LEAD_KIND = 'thursday_call';
const CUSTOMER_URL = 'https://nobigdealwithjoedeal.com/pro/customer.html?id=';
const INBOX_URL = 'https://nobigdealwithjoedeal.com/pro/dashboard.html#thursday';

// Extraction model. Opus 5 at low effort: a 3–5 minute receptionist call is a
// few thousand tokens, so a call costs a few cents, and name/address accuracy
// is the whole point of the pipeline (a misheard street is a missed match).
const EXTRACTION_MODEL = 'claude-opus-5';
const MODEL_PRICE_PER_MTOK = { input: 5, output: 25 };

// The twelve canonical lead sources (scripts/normalize-lead-source.js:19).
// Never invent a new one — the funnel is recorded separately as `intake`.
const CANONICAL_SOURCES = [
  'Door Knock', 'Storm Canvass', 'Storm Alert', 'Referral', 'Thumbtack', 'Yelp',
  'Angi', 'Website', 'Google', 'Online', 'Direct', 'Other',
];

const CALLER_TYPES = [
  'new_lead', 'existing_customer', 'adjuster', 'supplier_sub',
  'job_seeker', 'spam', 'test', 'silent',
];
const LOG_ONLY_TYPES = ['spam', 'test', 'silent'];

// Calls where the CALLER said fewer words than this never reach the model.
// Measured on Thursday's first ten real calls (2026-09-26): every silent call
// had 0-2 caller words ("Hello?"), while "Hey it's Mike, call me back" is 6 —
// the original threshold of 12 would have thrown that caller away.
const SILENT_WORD_THRESHOLD = 4;

// Jo's own phones. A call from one is Jo testing the line, never a lead
// (the first real call, 2026-09-24, was Jo — it would have become "Caller
// 7382"). thursday_config.ownerNumbers extends this list without a deploy.
const OWNER_NUMBERS_DEFAULT = ['+18594207382'];

// ── Small utils ─────────────────────────────────────────────────────────────

function str(v, max) {
  if (v == null) return '';
  let s = String(v).replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max).trim();
  return s;
}

function bool(v) {
  if (v === true || v === false) return v;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === 'y' || s === '1';
}

function toE164(phone) {
  const d = phoneDigits10(phone);
  return d.length === 10 ? '+1' + d : '';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Eastern-time calendar date, the format task readers expect ('YYYY-MM-DD').
function etYmd(d) {
  const js = d instanceof Date ? d : new Date(d == null ? Date.now() : d);
  if (isNaN(js.getTime())) return null;
  return js.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ── Ids + signature ─────────────────────────────────────────────────────────

// Bland call ids are UUIDs; accept a conservative superset and refuse anything
// that could escape a Firestore doc id or Storage path.
function isValidCallId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,128}$/.test(id);
}

function callDocId(callId) {
  if (!isValidCallId(callId)) throw new Error('invalid call_id');
  return DOC_PREFIX + callId;
}

// Deterministic child ids so a re-run of the trigger overwrites instead of
// duplicating (the lead id matches the brief: bland_calls__{call_id}).
function leadDocIdForCall(callId) { return callDocId(callId); }
function taskIdForCall(callId) { return 'thursday-' + callId; }
function activityIdForCall(callId) { return 'thursday-' + callId; }
function recordingPathFor(ownerUid, callId) {
  return 'calls/' + ownerUid + '/' + callId + '.mp3';
}

// Bland signs the raw request body: hex HMAC-SHA256 in X-Webhook-Signature
// (docs.bland.ai/tutorials/webhook-signing). No timestamp is signed, so replay
// protection is the call_id idempotency in the webhook, not here.
function verifyBlandSignature(rawBody, signature, secret) {
  if (!secret || !signature || rawBody == null) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const got = String(signature).trim().replace(/^sha256=/i, '').toLowerCase();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Constant-time bearer check for the live caller-lookup endpoint.
function bearerMatches(authHeader, token) {
  if (!token || !authHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader).trim());
  if (!m) return false;
  const a = crypto.createHash('sha256').update(m[1].trim()).digest();
  const b = crypto.createHash('sha256').update(String(token)).digest();
  return crypto.timingSafeEqual(a, b);
}

// ── Call normalization ──────────────────────────────────────────────────────

function isoOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Bland's webhook payload and GET /v1/calls/{id} share one call shape; this
// keeps what the CRM uses and caps every free-text field.
function normalizeCall(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const callId = str(p.call_id || p.c_id || p.id, 128);
  const turns = Array.isArray(p.transcripts) ? p.transcripts : [];
  const transcripts = turns.slice(0, 400).map((t) => ({
    user: str(t && t.user, 20),
    text: str(t && t.text, 2000),
    at: isoOrNull(t && t.created_at),
  })).filter((t) => t.text);
  let transcript = typeof p.concatenated_transcript === 'string' ? p.concatenated_transcript.trim() : '';
  if (!transcript && transcripts.length) {
    transcript = transcripts.map((t) => (t.user || 'unknown') + ': ' + t.text).join('\n');
  }
  if (transcript.length > 60000) transcript = transcript.slice(0, 60000);
  const minutes = Number(p.call_length);
  return {
    callId,
    from: str(p.from, 32),
    to: str(p.to, 32),
    inbound: p.inbound === undefined ? null : bool(p.inbound),
    createdAt: isoOrNull(p.created_at),
    startedAt: isoOrNull(p.started_at) || isoOrNull(p.created_at),
    endedAt: isoOrNull(p.end_at || p.ended_at),
    durationSec: isFinite(minutes) && minutes > 0 ? Math.round(minutes * 60) : 0,
    callEndedBy: str(p.call_ended_by, 32),
    transferredTo: str(p.transferred_to, 32),
    summary: str(p.summary, 4000),
    transcript,
    transcripts,
    recordingUrl: typeof p.recording_url === 'string' ? p.recording_url.trim() : '',
    status: str(p.status || p.queue_status, 40),
    answeredBy: str(p.answered_by, 40),
    pathwayId: str(p.pathway_id, 80),
    errorMessage: str(p.error_message, 500),
    price: isFinite(Number(p.price)) ? Number(p.price) : null,
    completed: p.completed === undefined ? null : bool(p.completed),
  };
}

// The thursday_calls doc the webhook AND the backfill create (the handler /
// script add createdAt). Everything the trigger needs rides on it, so a
// reprocess never depends on Bland still holding the call.
function buildPendingCallDoc(call, source, extra) {
  return Object.assign({
    companyId: NBD_OWNER_UID,
    userId: NBD_OWNER_UID,
    callId: call.callId,
    call,
    from: call.from,
    fromDigits: phoneDigits10(call.from),
    to: call.to,
    startedAt: call.startedAt ? new Date(call.startedAt) : null,
    status: 'pending',
    source,
    reviewed: false,
  }, extra || {});
}

// Only Thursday's own inbound calls enter the pipeline. An outbound call or a
// call to another Bland number on the same account must not create NBD leads.
function isThursdayCall(call, agentNumber) {
  const want = phoneDigits10(agentNumber || THURSDAY_NUMBER);
  if (!call || phoneDigits10(call.to) !== want) return false;
  return call.inbound !== false;
}

function transcriptWordCount(call) {
  const userText = (call.transcripts || [])
    .filter((t) => /^user$/i.test(t.user))
    .map((t) => t.text).join(' ');
  const basis = userText || '';
  return basis ? basis.split(/\s+/).filter(Boolean).length : 0;
}

// True when the CALLER said essentially nothing. Uses only the user turns, so
// Thursday's own greeting never makes a hang-up look like a conversation.
function isEffectivelySilent(call) {
  if (!call) return true;
  if ((call.transcripts || []).length) return transcriptWordCount(call) < SILENT_WORD_THRESHOLD;
  const words = String(call.transcript || '').split(/\s+/).filter(Boolean).length;
  return words < SILENT_WORD_THRESHOLD * 2;
}

// ── Extraction (Claude) ─────────────────────────────────────────────────────

// Every property is required and typed as a plain string/boolean; "unknown"
// is the empty string. Structured outputs (output_config.format) guarantee
// the JSON parses — sanitizeExtraction() still clamps every value, because a
// valid-JSON answer can still be the wrong enum casing or a 400-char "town".
const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'caller_name', 'callback_number', 'alt_contact', 'email', 'address', 'town',
    'state', 'zip', 'issue', 'insurance', 'urgent', 'urgent_reason',
    'callback_window', 'caller_type', 'heard_about_us', 'language',
    'existing_job_reference', 'confidence',
  ],
  properties: {
    caller_name: { type: 'string', description: 'Full name as the caller gave it; "" if never given.' },
    callback_number: { type: 'string', description: 'Best number to call back, digits as spoken; "" if they said to use the number they called from or never said.' },
    alt_contact: { type: 'string', description: 'Any second phone, spouse/tenant contact, or other way to reach them; "".' },
    email: { type: 'string', description: 'Email address if spelled out; "".' },
    address: { type: 'string', description: 'Street address of the property (number + street + unit), no town; "".' },
    town: { type: 'string', description: 'City/town of the property; "".' },
    state: { type: 'string', description: 'Two-letter state (OH, KY, IN) if known; "".' },
    zip: { type: 'string', description: '5-digit ZIP if given; "".' },
    issue: { type: 'string', description: 'One short sentence: what they need (e.g. "Leak over the kitchen after Tuesday storm").' },
    insurance: {
      type: 'object',
      additionalProperties: false,
      required: ['involved', 'carrier', 'claim_filed', 'claim_number'],
      properties: {
        involved: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        carrier: { type: 'string', description: 'Insurance company name; "".' },
        claim_filed: { type: 'string', enum: ['yes', 'no', 'unknown'] },
        claim_number: { type: 'string', description: 'Claim number if read out; "".' },
      },
    },
    urgent: { type: 'boolean', description: 'True for active leaks, open roof/tarp needed, storm damage exposing the house, safety hazards, or the caller saying it is urgent.' },
    urgent_reason: { type: 'string', description: 'Why it is urgent; "" if not urgent.' },
    callback_window: { type: 'string', description: 'When they want a call back ("today after 3pm"); "".' },
    caller_type: { type: 'string', enum: CALLER_TYPES },
    heard_about_us: { type: 'string', description: 'How they found NBD in their words ("Google", "neighbor Jim", "Thumbtack", "yard sign"); "".' },
    language: { type: 'string', description: 'Language the caller spoke, e.g. "en", "es", "pl".' },
    existing_job_reference: { type: 'string', description: 'If they reference an existing job/estimate/claim with NBD, what they said; "".' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

const EXTRACTION_SYSTEM = [
  'You read transcripts of calls answered by Thursday, the AI receptionist for No Big Deal Home Solutions',
  '(Joe Deal, roofing / siding / gutters / exterior contractor in Greater Cincinnati, Northern Kentucky',
  'and Southwest Ohio). Extract what the CALLER said into the JSON schema. Use "" for anything the caller',
  'did not say; never invent names, numbers, or addresses, and never copy Thursday\'s own words as the',
  'caller\'s details. Spell names and streets the way the caller spelled them when they spelled them out.',
  '',
  'caller_type:',
  '- new_lead: a homeowner/property manager wanting an inspection, estimate, repair or replacement.',
  '- existing_customer: someone NBD already works with (mentions their job, estimate, crew, invoice, warranty).',
  '- adjuster: an insurance adjuster or carrier calling about a claim or inspection.',
  '- supplier_sub: a supplier, distributor, subcontractor or crew calling about materials or work.',
  '- job_seeker: asking about employment or subcontracting opportunities for themselves.',
  '- spam: sales pitches, robocalls, SEO/marketing/lead-gen vendors, scams.',
  '- test: Joe or someone clearly testing the phone line.',
  '- silent: nobody speaks, only noise, or the caller hangs up before saying anything meaningful.',
].join('\n');

function buildExtractionRequest(call) {
  const lines = [];
  lines.push('Call from: ' + (call.from || 'unknown'));
  if (call.startedAt) lines.push('Started: ' + call.startedAt);
  if (call.summary) lines.push('Bland summary: ' + call.summary);
  lines.push('', 'Transcript:', call.transcript || '(empty)');
  return {
    model: EXTRACTION_MODEL,
    max_tokens: 8000,
    fallbacks: 'default',
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema: EXTRACTION_SCHEMA },
    },
    system: EXTRACTION_SYSTEM,
    messages: [{ role: 'user', content: lines.join('\n') }],
  };
}

// Headers for the raw /v1/messages call (the repo calls Claude with fetch,
// no SDK — see functions/dictate.js). The fallback beta pairs with
// `fallbacks: 'default'` above; the two must travel together or it 400s.
function extractionHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'server-side-fallback-2026-07-01',
  };
}

class ExtractionError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function stripFences(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  return i >= 0 && j > i ? t.slice(i, j + 1) : t;
}

// Turns a /v1/messages response body into { parsed, usage, costUsd }.
// Throws ExtractionError for refusal / truncation / non-JSON so the trigger
// records the reason and still notifies Jo with the raw summary.
function parseExtractionResponse(resp) {
  if (!resp || typeof resp !== 'object') throw new ExtractionError('bad-response');
  if (resp.type === 'error' || resp.error) {
    throw new ExtractionError('api-error', str(resp.error && resp.error.message, 300) || 'api error');
  }
  if (resp.stop_reason === 'refusal') throw new ExtractionError('refusal');
  if (resp.stop_reason === 'max_tokens') throw new ExtractionError('max-tokens');
  const blocks = Array.isArray(resp.content) ? resp.content : [];
  const text = blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  if (!text) throw new ExtractionError('empty');
  let parsed;
  try { parsed = JSON.parse(stripFences(text)); } catch (e) { throw new ExtractionError('bad-json'); }
  const usage = resp.usage || {};
  const inTok = Number(usage.input_tokens) || 0;
  const outTok = Number(usage.output_tokens) || 0;
  const costUsd = (inTok * MODEL_PRICE_PER_MTOK.input + outTok * MODEL_PRICE_PER_MTOK.output) / 1e6;
  return {
    parsed,
    usage: { inputTokens: inTok, outputTokens: outTok },
    costUsd: Math.round(costUsd * 10000) / 10000,
    model: str(resp.model, 60) || EXTRACTION_MODEL,
  };
}

// NBD's service area, spelled out or abbreviated; anything else that is
// already a 2-letter code passes, everything else is dropped (never 'KE').
const STATE_NAMES = { ohio: 'OH', kentucky: 'KY', indiana: 'IN', 'west virginia': 'WV', tennessee: 'TN', michigan: 'MI', pennsylvania: 'PA' };
function normState(v) {
  const s = str(v, 30).toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (STATE_NAMES[s]) return STATE_NAMES[s];
  return /^[a-z]{2}$/.test(s) ? s.toUpperCase() : '';
}

function triState(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === 'yes' || s === 'true' || s === 'y') return 'yes';
  if (s === 'no' || s === 'false' || s === 'n') return 'no';
  return 'unknown';
}

// Clamp a model answer into the exact shape the router expects. Anything the
// model got "creative" with collapses to the safe value, never passes through.
function sanitizeExtraction(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const ins = r.insurance && typeof r.insurance === 'object' ? r.insurance : {};
  let callerType = str(r.caller_type, 40).toLowerCase().replace(/[\s-]+/g, '_');
  if (CALLER_TYPES.indexOf(callerType) === -1) callerType = 'new_lead';
  const zipMatch = /\b(\d{5})(?:-\d{4})?\b/.exec(str(r.zip, 20)) || /\b(\d{5})(?:-\d{4})?\b/.exec(str(r.address, 200));
  const cb = phoneDigits10(r.callback_number);
  const email = str(r.email, 120).toLowerCase().replace(/\s+/g, '');
  const conf = str(r.confidence, 10).toLowerCase();
  const out = {
    caller_name: str(r.caller_name, 80),
    callback_number: cb.length === 10 ? cb : '',
    alt_contact: str(r.alt_contact, 160),
    email: /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email) ? email : '',
    address: str(r.address, 160),
    town: str(r.town, 60),
    state: normState(r.state),
    zip: zipMatch ? zipMatch[1] : '',
    issue: str(r.issue, 300),
    insurance: {
      involved: triState(ins.involved),
      carrier: str(ins.carrier, 80),
      claim_filed: triState(ins.claim_filed),
      claim_number: str(ins.claim_number, 60),
    },
    urgent: bool(r.urgent),
    urgent_reason: str(r.urgent_reason, 200),
    callback_window: str(r.callback_window, 120),
    caller_type: callerType,
    heard_about_us: str(r.heard_about_us, 120),
    language: str(r.language, 20).toLowerCase() || 'en',
    existing_job_reference: str(r.existing_job_reference, 300),
    confidence: ['high', 'medium', 'low'].indexOf(conf) === -1 ? 'medium' : conf,
  };
  if (out.insurance.claim_number && out.insurance.claim_filed === 'unknown') out.insurance.claim_filed = 'yes';
  if (out.insurance.carrier && out.insurance.involved === 'unknown') out.insurance.involved = 'yes';
  return out;
}

// The extraction for a call nobody spoke on — no model call needed.
// `spoke` records whether the caller said anything at all ("Hello?"): that
// is a real person who did not connect, worth a call back, not just noise.
//
// A caller who stayed on the line counts too, even without a word. Since
// 2026-09-28 Thursday greets on connect (static first_sentence, vault note
// §10), so anyone still there at 2 s heard her start and chose to hang up — a
// real caller Jo wants to call back (his call on a 3 s hang-up that day).
// Under 2 s is a line blip. (Before the fix this was 10 s: people sat through
// dead air first, so short silent calls looked like pocket-dials.)
const SILENT_WAITED_SECONDS = 2;
function silentExtraction(call) {
  const words = call ? transcriptWordCount(call) : 0;
  const waited = !!call && (Number(call.durationSec) || 0) >= SILENT_WAITED_SECONDS;
  return Object.assign(sanitizeExtraction({ caller_type: 'silent', confidence: 'high', issue: '' }), { spoke: words > 0 || waited });
}

// Facts the model cannot know, applied after sanitizeExtraction():
//   - a call from one of Jo's own numbers is a test, whatever was said.
function applyCallOverrides(extraction, call, opts) {
  const ex = Object.assign({}, extraction || {});
  const owners = [].concat(OWNER_NUMBERS_DEFAULT, (opts && opts.ownerNumbers) || [])
    .map((n) => phoneDigits10(n)).filter((d) => d.length === 10);
  if (call && owners.indexOf(phoneDigits10(call.from)) !== -1) {
    ex.caller_type = 'test';
    ex.owner_call = true;
  }
  return ex;
}

// "How did you hear about us?" → one of the twelve canonical sources.
// Order matters: "google reviews from my neighbor" is a Referral? No — the
// first strong platform word wins, then referral words, then generic web.
const SOURCE_RULES = [
  [/thumb\s*tack/i, 'Thumbtack'],
  [/\byelp\b/i, 'Yelp'],
  [/\bangi\b|angie'?s?\s*list|home\s*advisor/i, 'Angi'],
  [/storm\s*alert/i, 'Storm Alert'],
  [/\bgoogle\b|\bgbp\b|google\s*maps/i, 'Google'],
  [/door|knock(ed)?|came\s*by|stopped\s*by|flyer|door\s*hanger/i, 'Door Knock'],
  [/canvass|after\s*the\s*storm.*(came|stopped)/i, 'Storm Canvass'],
  [/refer|friend|neighbou?r|family|relative|co-?worker|word\s*of\s*mouth|recommend|brother|sister|mom|dad|cousin|previous\s*customer/i, 'Referral'],
  [/website|web\s*site|your\s*site|nobigdeal|online\s*form/i, 'Website'],
  [/facebook|instagram|nextdoor|tiktok|social|internet|online|search|ad\b|advert/i, 'Online'],
  [/yard\s*sign|truck|saw\s*(your|the)\s*(sign|truck)|already\s*had\s*(your|the)\s*number|business\s*card|called\s*(joe|you)\s*directly|direct/i, 'Direct'],
];

function mapHeardAboutToSource(heard) {
  const s = str(heard, 200);
  if (!s) return 'Other';
  const exact = CANONICAL_SOURCES.find((c) => c.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  for (const [re, src] of SOURCE_RULES) if (re.test(s)) return src;
  return 'Other';
}

// ── Matching ────────────────────────────────────────────────────────────────

// Thumbtack leads carry a Thumbtack PROXY number (669 area code) instead of
// the homeowner's real one — same rule as docs/pro/js/dup-review.js _isProxy
// and needs-attention-filter.js isProxyPhone. A proxy number never matches.
function isProxyLead(lead) {
  const d = phoneDigits10(lead && (lead.phoneDigits || lead.phone));
  return d.length === 10 && d.slice(0, 3) === '669' && /thumbtack/i.test(String((lead && lead.source) || ''));
}

const STREET_SUFFIX = {
  street: 'st', st: 'st', str: 'st', avenue: 'ave', ave: 'ave', av: 'ave',
  road: 'rd', rd: 'rd', drive: 'dr', dr: 'dr', lane: 'ln', ln: 'ln',
  court: 'ct', ct: 'ct', crt: 'ct', circle: 'cir', cir: 'cir', boulevard: 'blvd',
  blvd: 'blvd', place: 'pl', pl: 'pl', parkway: 'pkwy', pkwy: 'pkwy', way: 'way',
  terrace: 'ter', ter: 'ter', trail: 'trl', trl: 'trl', pike: 'pike', highway: 'hwy',
  hwy: 'hwy', square: 'sq', sq: 'sq', row: 'row', run: 'run', point: 'pt', pt: 'pt',
};
const DIRECTIONS = { north: 'n', south: 's', east: 'e', west: 'w', n: 'n', s: 's', e: 'e', w: 'w' };

// '2718 Linden Ave., Covington KY' → { number:'1912', name:'linden', suffix:'ave' }
function parseStreet(address) {
  const s = String(address || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /^(\d+[a-z]?)\s+(.+)$/.exec(s);
  if (!m) return null;
  const words = m[2].split(' ').filter(Boolean);
  const nameParts = [];
  let suffix = '';
  for (const w of words) {
    if (DIRECTIONS[w] && !nameParts.length) continue; // leading N/S/E/W
    if (STREET_SUFFIX[w]) { suffix = STREET_SUFFIX[w]; break; }
    if (/^(apt|unit|suite|ste|lot)$/.test(w)) break;
    nameParts.push(w);
    if (nameParts.length >= 3) break;
  }
  if (!nameParts.length) return null;
  return { number: m[1], name: nameParts.join(' '), suffix };
}

function zipOf(s) {
  const m = /\b(\d{5})(?:-\d{4})?\b/.exec(String(s || ''));
  return m ? m[1] : '';
}

function normName(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitCallerName(name) {
  const parts = normName(name).split(' ').filter((p) => p && !/^(mr|mrs|ms|miss|dr|jr|sr|ii|iii)$/.test(p));
  if (!parts.length) return { first: '', last: '' };
  return { first: parts[0], last: parts.length > 1 ? parts[parts.length - 1] : '' };
}

function leadNames(lead) {
  const first = normName(lead.firstName || '').split(' ')[0] || '';
  let last = normName(lead.lastName || '').split(' ').pop() || '';
  if (!first && !last && lead.name) {
    const sp = splitCallerName(lead.name);
    return sp;
  }
  return { first, last };
}

function leadAddressText(lead) {
  return [lead.address, lead.street, lead.city, lead.town, lead.state, lead.zip]
    .filter(Boolean).join(' ');
}

function isDeletedLead(lead) {
  return !!(lead && (lead.deleted === true || lead.isDeleted === true || lead.deletedAt));
}

// Score one candidate. Returns { level: 'strong'|'possible'|null, reasons[] }.
function scoreLead(lead, probe) {
  const reasons = [];
  let phone = false;
  if (!isProxyLead(lead)) {
    const ld = phoneDigits10(lead.phoneDigits || lead.phone);
    const alt = phoneDigits10(lead.altPhoneDigits || lead.altPhone || lead.phone2 || '');
    const hits = [ld, alt].filter((d) => d.length === 10);
    if (hits.some((d) => probe.phones.indexOf(d) !== -1)) { phone = true; reasons.push('phone'); }
  }

  const ln = leadNames(lead);
  const firstHit = !!(probe.first && ln.first && (ln.first === probe.first ||
    (ln.first.length >= 3 && probe.first.length >= 3 && (ln.first.startsWith(probe.first) || probe.first.startsWith(ln.first)))));
  const lastHit = !!(probe.last && ln.last && ln.last.length > 1 && ln.last === probe.last);
  // Thumbtack leads arrive as "Halina N." — a one-letter last name can only
  // ever corroborate, never carry a match on its own.
  const lastInitialHit = !lastHit && !!(probe.last && ln.last && ln.last.length === 1 && probe.last.charAt(0) === ln.last);
  if (firstHit) reasons.push('first-name');
  if (lastHit) reasons.push('last-name');
  if (lastInitialHit) reasons.push('last-initial');

  // Place (ZIP or town) — independent of the street, because Thumbtack and
  // Cal.com leads often carry only "West Chester, OH 45069".
  const lAddr = leadAddressText(lead);
  const lZip = zipOf(lead.zip) || zipOf(lAddr);
  const lTown = normName(lead.city || lead.town || '');
  const lAddrNorm = normName(lAddr);
  const zipHit = !!(probe.zip && lZip && probe.zip === lZip);
  const townHit = !!(probe.town && probe.town.length >= 3 && (lTown === probe.town || lAddrNorm.indexOf(probe.town) !== -1));
  const placeHit = zipHit || townHit;
  const placeKnown = !!((probe.zip && lZip) || (probe.town && (lTown || lAddrNorm)));
  const placeConflict = placeKnown && !placeHit;
  if (placeHit) reasons.push(zipHit ? 'zip' : 'town');

  let streetHit = false;
  const ls = parseStreet(lead.address || lead.street || '');
  if (probe.street && ls && ls.number === probe.street.number && ls.name === probe.street.name) {
    streetHit = true;
    reasons.push('street');
  }

  const claimHit = !!(probe.claim && lead.claimNumber &&
    String(lead.claimNumber).replace(/[^a-z0-9]/gi, '').toLowerCase() === probe.claim);
  if (claimHit) reasons.push('claim-number');

  const nameHit = firstHit || lastHit;
  let level = null;
  if (phone || claimHit) level = 'strong';
  else if (streetHit && nameHit && !placeConflict) level = 'strong';
  else if (streetHit && (nameHit || placeHit)) level = 'possible';
  else if (firstHit && lastHit) level = 'possible';
  else if (firstHit && (lastInitialHit || !probe.last) && placeHit) level = 'possible';
  else if (lastHit && placeHit) level = 'possible';
  return { level, reasons };
}

// Match a call against the tenant's leads. `leads` = [{ id, ...data }].
// Returns { confidence:'strong'|'possible'|'none', lead, strong[], possible[] }.
// More than one strong candidate is downgraded to 'possible' — never guess.
function matchLeads(args) {
  const a = args || {};
  const cid = String(a.companyId || '');
  const ex = a.extraction || {};
  const call = a.call || {};
  if (!cid) throw new Error('matchLeads: companyId required');

  const phones = [phoneDigits10(call.from), phoneDigits10(ex.callback_number)]
    .filter((d, i, arr) => d.length === 10 && arr.indexOf(d) === i)
    // Never match on Thursday's own number or a 669 Thumbtack proxy caller.
    .filter((d) => d !== phoneDigits10(THURSDAY_NUMBER));
  const nm = splitCallerName(ex.caller_name);
  const probe = {
    phones,
    first: nm.first,
    last: nm.last,
    street: parseStreet(ex.address),
    zip: ex.zip || zipOf(ex.address),
    town: normName(ex.town),
    claim: String((ex.insurance && ex.insurance.claim_number) || '').replace(/[^a-z0-9]/gi, '').toLowerCase(),
  };
  if (probe.claim.length < 5) probe.claim = '';

  const strong = [];
  const possible = [];
  for (const lead of Array.isArray(a.leads) ? a.leads : []) {
    if (!lead || String(lead.companyId || '') !== cid) continue; // tenant guard #2
    if (isDeletedLead(lead)) continue;
    const s = scoreLead(lead, probe);
    if (!s.level) continue;
    const row = { leadId: String(lead.id), name: displayName(lead), reasons: s.reasons, lead };
    (s.level === 'strong' ? strong : possible).push(row);
  }

  if (strong.length === 1) return { confidence: 'strong', lead: strong[0], strong, possible };
  if (strong.length > 1) {
    return { confidence: 'possible', lead: null, strong: [], possible: strong.concat(possible) };
  }
  if (possible.length) return { confidence: 'possible', lead: null, strong, possible };
  return { confidence: 'none', lead: null, strong, possible };
}

function displayName(lead) {
  const n = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
  return n || String(lead.name || lead.address || lead.id || 'Unnamed lead');
}

// ── Routing ─────────────────────────────────────────────────────────────────

// Decide what the call does to the CRM. Pure: the handler executes it.
//   action: create_lead | attach | possible_match | inbox | log_only
function decideRoute(extraction, match) {
  const ex = extraction || {};
  const m = match || { confidence: 'none', possible: [] };
  const type = ex.caller_type;
  const urgent = !!ex.urgent;
  const possibleMatches = (m.possible || []).slice(0, 5).map((p) => ({
    leadId: p.leadId, name: p.name, reasons: p.reasons,
  }));
  const base = {
    action: 'log_only', leadId: null, possibleMatches, urgent,
    createTask: false, notifyPush: false, notifyEmail: false, notifySms: false,
    label: 'Logged',
  };

  // Someone said "Hello?" and hung up: a real missed caller. Inbox row, no
  // alerts (these are also pocket-dials and robocalls often enough).
  if (type === 'silent' && ex.spoke) {
    return Object.assign(base, { action: 'inbox', label: 'Hung up — call back?' });
  }
  if (LOG_ONLY_TYPES.indexOf(type) !== -1) {
    return Object.assign(base, { label: type === 'spam' ? 'Spam' : type === 'test' ? (ex.owner_call ? 'Test call (your phone)' : 'Test call') : 'Silent / hang-up' });
  }
  if (type === 'job_seeker') {
    return Object.assign(base, { action: 'inbox', notifyEmail: true, label: 'Job seeker' });
  }

  const loud = { notifyPush: true, notifyEmail: true, notifySms: true };

  if (type === 'adjuster' || type === 'supplier_sub') {
    const label = type === 'adjuster' ? 'Adjuster' : 'Supplier / sub';
    if (m.confidence === 'strong') {
      return Object.assign(base, loud, { action: 'attach', leadId: m.lead.leadId, createTask: true, label });
    }
    return Object.assign(base, loud, { action: 'inbox', label });
  }

  // new_lead / existing_customer
  if (m.confidence === 'strong') {
    return Object.assign(base, loud, {
      action: 'attach', leadId: m.lead.leadId, createTask: true,
      label: type === 'existing_customer' ? 'Existing customer' : 'Known caller',
    });
  }
  if (m.confidence === 'possible') {
    return Object.assign(base, loud, {
      action: 'possible_match',
      leadId: possibleMatches.length === 1 ? possibleMatches[0].leadId : null,
      createTask: possibleMatches.length === 1,
      label: 'Possible match',
    });
  }
  return Object.assign(base, loud, {
    action: 'create_lead', createTask: true,
    label: type === 'existing_customer' ? 'Existing customer (no CRM match)' : 'New lead',
  });
}

// ── Builders ────────────────────────────────────────────────────────────────

function composeAddress(ex) {
  const cityLine = [ex.town, [ex.state, ex.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [ex.address, cityLine].filter(Boolean).join(', ');
}

function titleCase(s) {
  return String(s || '').replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

function callNotes(ex, call) {
  const lines = ['📞 Thursday call ' + (call.startedAt ? etYmd(call.startedAt) : '') + ': ' + (ex.issue || call.summary || '(no summary)')];
  if (ex.urgent) lines.push('URGENT' + (ex.urgent_reason ? ' — ' + ex.urgent_reason : ''));
  if (ex.callback_window) lines.push('Best time to call: ' + ex.callback_window);
  if (ex.alt_contact) lines.push('Alt contact: ' + ex.alt_contact);
  if (ex.heard_about_us) lines.push('Heard about us: ' + ex.heard_about_us);
  if (ex.insurance.involved === 'yes') {
    lines.push('Insurance: ' + (ex.insurance.carrier || 'carrier unknown') +
      (ex.insurance.claim_filed === 'yes' ? ', claim filed' : ex.insurance.claim_filed === 'no' ? ', no claim yet' : '') +
      (ex.insurance.claim_number ? ' (#' + ex.insurance.claim_number + ')' : ''));
  }
  if (ex.language && ex.language !== 'en' && ex.language !== 'english') lines.push('Language: ' + ex.language);
  if (ex.caller_type === 'existing_customer') lines.push('Caller says they are an existing customer — no CRM match was found.');
  return lines.join('\n');
}

// A brand-new CRM lead from a call. Mirrors lead-bridge-logic.js
// mapPublicLeadToLead (same owner/tenant/stage conventions) minus the
// serverTimestamp fields, which the handler adds.
function buildLeadDoc(args) {
  const ex = args.extraction;
  const call = args.call;
  const nm = String(ex.caller_name || '').trim().split(/\s+/).filter(Boolean);
  const phone = ex.callback_number || phoneDigits10(call.from);
  const doc = {
    userId: args.ownerUid,
    companyId: args.companyId,
    firstName: nm.length ? titleCase(nm[0]) : 'Caller ' + phoneDigits10(call.from).slice(-4),
    lastName: nm.length > 1 ? titleCase(nm.slice(1).join(' ')) : '',
    address: composeAddress(ex),
    phone: phone ? toE164(phone) || phone : '',
    phoneDigits: phoneDigits10(phone),
    email: ex.email || '',
    // Canonical key + role (2026-10-04 numbers audit: 64 leads stored the
    // legacy display name 'New' and 62 had no stageRole). Migration 008
    // heals the ones already written.
    stage: 'new',
    stageRole: 'new',
    status: 'new',
    source: mapHeardAboutToSource(ex.heard_about_us),
    intake: INTAKE_LABEL,
    sourcePage: SOURCE_PAGE,
    notes: callNotes(ex, call),
    webLead: false,
    publicLeadKind: PUBLIC_LEAD_KIND,
    publicLeadCollection: 'thursday_calls',
    publicLeadId: callDocId(call.callId),
    thursdayCallId: call.callId,
    urgent: !!ex.urgent,
  };
  if (ex.zip) doc.zip = ex.zip;
  if (ex.town) doc.city = titleCase(ex.town);
  if (ex.state) doc.state = ex.state;
  if (ex.alt_contact) doc.altContact = ex.alt_contact;
  if (ex.insurance.involved === 'yes') {
    doc.jobType = 'insurance';
    if (ex.insurance.carrier) doc.insCarrier = ex.insurance.carrier;
    if (ex.insurance.claim_number) doc.claimNumber = ex.insurance.claim_number;
    doc.claimStatus = ex.insurance.claim_filed === 'yes' ? 'Claim Filed' : 'No Claim';
  }
  return doc;
}

function shortIssue(ex, call) {
  return str(ex.issue || call.summary || 'called', 90);
}

// Task on the lead (leads/{id}/tasks/thursday-{callId}). Shape matches the
// readers in docs/pro/js/tasks.js + customer-bootstrap.module.js.
function buildTask(args) {
  const ex = args.extraction;
  const call = args.call;
  const route = args.route;
  const who = ex.caller_name || toE164(ex.callback_number || call.from) || 'caller';
  let text;
  if (route.action === 'possible_match') {
    text = 'Possible match: Thursday call from ' + who + ' — confirm it\'s them, then call back';
  } else if (ex.caller_type === 'adjuster') {
    text = 'Call adjuster back: ' + who + ' — ' + shortIssue(ex, call);
  } else if (ex.caller_type === 'supplier_sub') {
    text = 'Call back ' + who + ' (supplier/sub) — ' + shortIssue(ex, call);
  } else {
    text = (ex.urgent ? '🚨 URGENT — ' : '') + 'Call back ' + who + ' — ' + shortIssue(ex, call);
  }
  const notes = [
    ex.callback_window ? 'Best time: ' + ex.callback_window : '',
    'Number: ' + (toE164(ex.callback_number || call.from) || 'unknown'),
    ex.urgent_reason ? 'Urgent: ' + ex.urgent_reason : '',
    call.summary ? 'Summary: ' + str(call.summary, 600) : '',
  ].filter(Boolean).join('\n');
  return {
    leadId: args.leadId,
    userId: args.ownerUid,
    title: str(text, 200),
    text: str(text, 200),
    notes,
    dueDate: etYmd(args.now || Date.now()),
    priority: ex.urgent ? 'high' : 'normal',
    done: false,
    source: 'thursday',
    thursdayCallId: call.callId,
    createdBy: 'Thursday (AI receptionist)',
  };
}

// leads/{id}/activity/thursday-{callId} — read by ai-texting.js for context.
function buildActivity(args) {
  const ex = args.extraction;
  const call = args.call;
  return {
    userId: args.ownerUid,
    companyId: args.companyId,
    type: 'call',
    direction: 'inbound',
    source: 'thursday',
    label: 'Thursday call — ' + (args.route.label || ''),
    summary: str(ex.issue || call.summary, 600),
    transcriptExcerpt: str(call.transcript, 1500),
    durationSec: call.durationSec || 0,
    from: toE164(call.from) || call.from,
    urgent: !!ex.urgent,
    matchConfidence: args.route.action === 'possible_match' ? 'possible' : 'strong',
    thursdayCallId: call.callId,
  };
}

// ── Notifications ───────────────────────────────────────────────────────────

function whoLine(ex, call) {
  return ex.caller_name || toE164(ex.callback_number || call.from) || 'Unknown caller';
}

// ≤ 300 chars: name · town · issue · URGENT · link. Bland's SMS and Twilio
// both split longer bodies into multiple billed segments.
function buildSmsText(args) {
  const ex = args.extraction;
  const call = args.call;
  const route = args.route;
  const link = args.leadId ? CUSTOMER_URL + encodeURIComponent(args.leadId) : INBOX_URL;
  const head = (ex.urgent ? '🚨 URGENT ' : '') + '📞 Thursday: ' + route.label;
  const who = whoLine(ex, call) + (ex.town ? ' (' + ex.town + ')' : '');
  const cb = toE164(ex.callback_number || call.from);
  let body = head + '\n' + who + (cb ? ' ' + cb : '') + '\n' + shortIssue(ex, call);
  const tail = '\n' + link;
  const room = 300 - tail.length;
  if (body.length > room) body = body.slice(0, Math.max(0, room - 1)) + '…';
  return body + tail;
}

function buildPush(args) {
  const ex = args.extraction;
  const call = args.call;
  const title = (ex.urgent ? '🚨 URGENT · ' : '') + 'Thursday: ' + args.route.label;
  const body = str(whoLine(ex, call) + (ex.town ? ', ' + ex.town : '') + ' — ' + shortIssue(ex, call), 180);
  return { title, body, url: args.leadId ? '/pro/customer.html?id=' + encodeURIComponent(args.leadId) : '/pro/dashboard.html#thursday' };
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}

function buildEmail(args) {
  const ex = args.extraction || sanitizeExtraction({});
  const call = args.call;
  const route = args.route || { label: 'Call' };
  const link = args.leadId ? CUSTOMER_URL + encodeURIComponent(args.leadId) : INBOX_URL;
  const who = whoLine(ex, call);
  const subject = '📞 Thursday — ' + route.label + ': ' + who +
    (ex.town ? ', ' + ex.town : '') + (ex.urgent ? ' · URGENT' : '');
  const rows = [
    ['Caller', who],
    ['Callback', toE164(ex.callback_number || call.from) || call.from],
    ['Alt contact', ex.alt_contact],
    ['Email', ex.email],
    ['Address', composeAddress(ex)],
    ['Issue', ex.issue],
    ['Urgent', ex.urgent ? 'YES' + (ex.urgent_reason ? ' — ' + ex.urgent_reason : '') : ''],
    ['Best time', ex.callback_window],
    ['Insurance', ex.insurance.involved === 'yes'
      ? [ex.insurance.carrier || 'carrier unknown', ex.insurance.claim_filed === 'yes' ? 'claim filed' : ex.insurance.claim_filed === 'no' ? 'no claim yet' : '', ex.insurance.claim_number ? '#' + ex.insurance.claim_number : ''].filter(Boolean).join(', ')
      : ex.insurance.involved === 'no' ? 'No' : ''],
    ['Heard about us', ex.heard_about_us ? ex.heard_about_us + ' → ' + mapHeardAboutToSource(ex.heard_about_us) : ''],
    ['Caller type', ex.caller_type],
    ['Language', ex.language && ex.language !== 'en' ? ex.language : ''],
    ['CRM', route.action === 'create_lead' ? 'New lead created'
      : route.action === 'attach' ? 'Attached to existing lead'
      : route.action === 'possible_match' ? 'Possible match — confirm in the Thursday inbox'
      : route.action === 'inbox' ? 'In the Thursday inbox (no lead)' : 'Logged only'],
    ['Possible matches', (route.possibleMatches || []).map((p) => p.name + ' (' + p.reasons.join(', ') + ')').join('; ')],
    ['Duration', fmtDuration(call.durationSec) + (call.callEndedBy ? ' · ended by ' + call.callEndedBy.toLowerCase() : '')],
    ['Transferred to', call.transferredTo],
    ['Recording', call.recordingUrl || args.recordingSaved ? 'Play it on the customer card / Thursday inbox (sign-in required)' : ''],
    ['Extraction', args.extractionError ? 'FAILED (' + args.extractionError + ') — details below are Bland\'s summary only' : ''],
  ].filter((r) => r[1]);
  const tableRows = rows.map((r) => '<tr><td style="padding:4px 12px 4px 0;color:#6b7280;vertical-align:top;white-space:nowrap">' +
    escapeHtml(r[0]) + '</td><td style="padding:4px 0">' + escapeHtml(r[1]) + '</td></tr>').join('');
  const transcriptHtml = escapeHtml(call.transcript || '(no transcript)').replace(/\n/g, '<br>');
  const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;color:#111">' +
    (ex.urgent ? '<p style="background:#fee2e2;color:#991b1b;padding:8px 12px;border-radius:6px;font-weight:700">URGENT' +
      (ex.urgent_reason ? ' — ' + escapeHtml(ex.urgent_reason) : '') + '</p>' : '') +
    '<p style="margin:0 0 12px"><a href="' + escapeHtml(link) + '" style="background:#A14A22;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:700">Open in NBD Pro</a></p>' +
    (call.summary ? '<p><strong>Summary:</strong> ' + escapeHtml(call.summary) + '</p>' : '') +
    '<table style="border-collapse:collapse">' + tableRows + '</table>' +
    '<h3 style="margin:18px 0 6px">Transcript</h3><div style="background:#f9fafb;padding:10px 12px;border-radius:6px;line-height:1.5">' +
    transcriptHtml + '</div>' +
    '<p style="color:#9ca3af;font-size:12px">Thursday · call ' + escapeHtml(call.callId) + '</p></div>';
  const text = [subject, '', link, '', call.summary ? 'Summary: ' + call.summary : '']
    .concat(rows.map((r) => r[0] + ': ' + r[1]))
    .concat(['', 'Transcript:', call.transcript || '(none)']).join('\n');
  return { subject: str(subject, 200), html, text };
}

// ── Live caller lookup (greeting by name) ───────────────────────────────────

const STAGE_HINTS = [
  [/new|contact|lead/i, 'your roofing request'],
  [/inspect/i, 'your inspection'],
  [/estimate|quote|proposal|negotiat/i, 'your estimate'],
  [/contract|signed|approved|won/i, 'your upcoming project'],
  [/install|product|schedul|build/i, 'your project'],
  [/closed|complete|paid|warranty/i, 'your finished project'],
];

function jobHintForStage(stage) {
  const s = String(stage || '');
  for (const [re, hint] of STAGE_HINTS) if (re.test(s)) return hint;
  return '';
}

// Minimal disclosure: a spoofed caller ID learns a first name and a
// stage-level phrase at most — never an address, price, claim, or last name.
// Exactly one non-proxy phone match in the tenant, or nothing.
// The name Thursday asks about. A couple's lead ("Tom & Maria") is
// greeted "Is this Tom or Maria?" — a real call on 2026-09-26 came from the
// wife on a lead the husband's name leads.
function lookupFirstName(lead) {
  const raw = String((lead && lead.firstName) || '').trim();
  const parts = raw.split(/\s*(?:&|\+|\/|\band\b)\s*/i)
    .map((p) => titleCase(normName(p).split(' ')[0] || ''))
    .filter((p) => p && !/^(caller|unknown|web|mr|mrs|ms)$/i.test(p));
  return parts.slice(0, 2).join(' or ');
}

// Minimal disclosure: a spoofed caller ID learns a first name and a
// stage-level phrase at most — never an address, price, claim, or last name.
// Exactly one lead in the tenant whose main OR second number is this caller.
function buildLookupResponse(args) {
  const cid = String(args.companyId || '');
  const d = phoneDigits10(args.from);
  const unknown = { known: false, first_name: '', job_hint: '' };
  if (d.length !== 10 || !cid) return unknown;
  const seen = {};
  const hits = (args.leads || []).filter((l) => {
    if (!l || String(l.companyId || '') !== cid || isDeletedLead(l)) return false;
    const main = !isProxyLead(l) && phoneDigits10(l.phoneDigits || l.phone) === d;
    const alt = phoneDigits10(l.altPhoneDigits || l.altPhone) === d;
    if (!(main || alt) || seen[l.id]) return false;
    seen[l.id] = true;
    return true;
  });
  if (hits.length !== 1) return unknown;
  const first = lookupFirstName(hits[0]);
  if (!first) return unknown;
  return { known: true, first_name: first, job_hint: jobHintForStage(hits[0].stage) };
}

// Fields to add to a lead a call was attached to (strong match only): fill a
// blank phone, otherwise remember the OTHER number the caller used as the
// lead's second number — so the next call from it is recognized by both the
// matcher and the live greeting. Never overwrites anything already set.
function secondNumberPatch(lead, call, extraction) {
  const l = lead || {};
  const ex = extraction || {};
  const own = phoneDigits10(THURSDAY_NUMBER);
  const main = phoneDigits10(l.phoneDigits || l.phone);
  const alt = phoneDigits10(l.altPhoneDigits || l.altPhone);
  const candidates = [phoneDigits10(call && call.from), phoneDigits10(ex.callback_number)]
    .filter((d, i, a) => d.length === 10 && d !== own && a.indexOf(d) === i);
  const patch = {};
  if (!main) {
    if (candidates[0]) { patch.phone = '+1' + candidates[0]; patch.phoneDigits = candidates[0]; }
    return patch;
  }
  if (alt) return patch;
  const other = candidates.find((d) => d !== main && !(isProxyLead(l) && d.slice(0, 3) === '669'));
  if (other) { patch.altPhone = '+1' + other; patch.altPhoneDigits = other; }
  return patch;
}

module.exports = {
  NBD_OWNER_UID, THURSDAY_NUMBER, DOC_PREFIX, INTAKE_LABEL, SOURCE_PAGE, PUBLIC_LEAD_KIND,
  CUSTOMER_URL, INBOX_URL, EXTRACTION_MODEL, CANONICAL_SOURCES, CALLER_TYPES, LOG_ONLY_TYPES,
  EXTRACTION_SCHEMA,
  str, bool, toE164, escapeHtml, etYmd,
  isValidCallId, callDocId, leadDocIdForCall, taskIdForCall, activityIdForCall, recordingPathFor,
  verifyBlandSignature, bearerMatches,
  normalizeCall, buildPendingCallDoc, isThursdayCall, isEffectivelySilent, transcriptWordCount,
  buildExtractionRequest, extractionHeaders, parseExtractionResponse, ExtractionError,
  sanitizeExtraction, silentExtraction, applyCallOverrides, OWNER_NUMBERS_DEFAULT, mapHeardAboutToSource,
  isProxyLead, parseStreet, splitCallerName, matchLeads, displayName,
  decideRoute, buildLeadDoc, buildTask, buildActivity,
  buildSmsText, buildPush, buildEmail, fmtDuration,
  jobHintForStage, buildLookupResponse, lookupFirstName, secondNumberPatch,
};
