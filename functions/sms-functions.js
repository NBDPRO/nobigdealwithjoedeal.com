/**
 * NBD Pro — SMS Cloud Functions
 * ═══════════════════════════════════════════════════════════════
 *
 * SMS sending via Twilio
 * Webhook handling for incoming SMS replies
 *
 * Functions:
 *   - sendSMS (HTTP)
 *   - sendD2DSMS (HTTP)
 *   - incomingSMS (HTTP webhook — no auth)
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onDocumentUpdated, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging');
// Modular FieldValue: FieldValue is undefined inside the
// Functions emulator runtime (see PR #556 / emulator-compat). The modular
// import works in BOTH prod and the emulator, so T-2's send trigger can be
// exercised against the emulator. Existing prod code in this file still uses
// the namespaced form; new code uses this.
const { FieldValue } = require('firebase-admin/firestore');
// Lazy require (2026-08-07) — see lead-alert.js: ~21 MB SDK off the
// cold-start path; call sites use _twilio()(...) and the signature
// validator uses _twilio().validateRequest.
let _twilioSdk = null;
const _twilio = () => (_twilioSdk = _twilioSdk || require('twilio'));
// C4: use the Upstash-first rate-limit adapter so busy SMS windows
// don't hammer the shared Firestore rate_limits doc. Falls back to
// the Firestore limiter when Upstash isn't configured.
const { enforceRateLimit, httpRateLimit, clientIp } = require('./integrations/upstash-ratelimit');
// Canonical phone normalization — the lead-write paths stamp `phoneDigits`
// (last-10 US digits) on every lead; incomingSMS normalizes the Twilio
// sender the same way so an E.164 inbound matches a free-form-typed lead.
const { phoneDigits10 } = require('./phone-utils');
// TCPA opt-out register. One module owns the key derivation because this file
// used to write the register under an 11-digit key and read it under a
// 10-digit one, so no STOP was ever honoured on an outbound send.
const OptOut = require('./sms-optout');
// Tenant-safe inbound routing (audit 2026-08-02 HIGH-5): one shared Twilio
// number serves every tenant, so the lead match must consider ALL candidates
// and refuse to guess across tenants. Pure module — decision table lives (and
// is unit-tested) there, not here.
const { pickLeadForInbound } = require('./inbound-sms-route-logic');
// Offline outbox (docs/pro/js/sms-outbox.js): the checks a QUEUED send must
// pass before it goes — idempotency, quiet hours, staleness, competing
// activity. Pure; the Firestore reads that feed it live in queuedSendGate().
const Outbox = require('./sms-outbox-guard');

// Minimal HTML escaper for values we store from untrusted SMS webhooks.
function escForStore(s) {
  return String(s == null ? '' : s)
    .replace(/[<>]/g, ch => ({ '<':'&lt;','>':'&gt;' }[ch]))
    .slice(0, 4000);
}

// Secrets
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');

// T-1 step 2: pull in the AI-texting draft generator + its secret
// declaration so we can register the same ANTHROPIC_API_KEY secret on
// incomingSMS without redeclaring it (defineSecret is idempotent by
// name, but using the re-export keeps the source-of-truth in
// handlers/ai-texting.js).
const { generateAIDraft, ANTHROPIC_API_KEY: AI_ANTHROPIC_KEY } = require('./handlers/ai-texting');
const { isPortalDraft, clampPortalText } = require('./ai-draft-routing');
const { applyRepReplyEffects } = require('./portal-reply-effects');

// CORS origins
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ═══════════════════════════════════════════════════════════════
// SMS TEMPLATES
// ═══════════════════════════════════════════════════════════════

const D2D_SMS_TEMPLATES = {
  interested: {
    label: 'Thanks for Chatting',
    body: 'Hey {name}! This is {rep} from NBD Home Solutions. Great chatting today — I\'d love to take a closer look at your roof. Let me know a good time!'
  },
  appointment: {
    label: 'Appointment Confirmation',
    body: 'Hi {name}! {rep} from NBD confirming our upcoming roof inspection on {appointmentDate} at {appointmentTime}. Looking forward to it!'
  },
  storm_damage: {
    label: 'Storm Damage Alert',
    body: 'Hi {name}, {rep} from NBD. I noticed some storm damage on your roof today. I offer free inspections — would you like me to come take a closer look?'
  },
  ins_has_claim: {
    label: 'Insurance Claim Alert',
    body: 'Hi {name}! {rep} from NBD. I see your roof has damage that your insurance should cover. We help with the claims process at no cost to you. Want to talk?'
  },
  follow_up: {
    label: 'Follow-Up',
    body: 'Hi {name}! Just following up from our conversation last time. Still interested in getting that roof inspected? Give me a call or text back!'
  },
  not_home: {
    label: 'Not Home Follow-Up',
    body: 'Hi {name}! I stopped by but didn\'t catch you home. Would love to chat about your roof. Free inspection — no pressure. Hit me back!'
  }
};

// ═══════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Validate US/Canada phone number format. We explicitly REJECT international
 * numbers — international SMS is a toll-fraud ("SMS pumping") target.
 */
function isValidPhoneNumber(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length === 10) return true;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return true;
  return false;
}

/**
 * Format phone number to E.164 — US/Canada only. Returns null for anything else.
 */
function formatPhoneNumber(phone) {
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length === 10) return `+1${cleaned}`;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
  return null;
}

/**
 * Log SMS to Firestore
 *
 * `extra` (optional) carries the offline-outbox provenance of a queued send —
 * { queued: true, queuedAt, clientMsgId } — which the competing-activity check
 * reads to tell a rep's own earlier queued texts from someone else's.
 */
async function logSMSToFirestore(db, to, body, uid, leadId = null, status = 'sent', twilioSid = null, companyId = null, extra = null) {
  try {
    const ts = FieldValue.serverTimestamp();
    const row = {
      to,
      body,
      uid,
      leadId: leadId || null,
      // `date` is the field the customer-page Communication Log orders by (and
      // the {leadId, uid, date} composite index keys on); `sentAt` is kept for
      // existing readers. Both carry the same server timestamp.
      date: ts,
      sentAt: ts,
      status,
      twilioSid: twilioSid || null,
      // Canonical last-10 key of the OTHER party (the recipient of an outbound
      // row, the sender of a 'received' row). `to` is stored however it was
      // typed or delivered, so it cannot be queried by number; this can. The
      // offline-outbox check (sms-outbox-guard.js) scans {toDigits, date}.
      toDigits: OptOut.optOutKey(to) || null
    };
    if (companyId) row.companyId = companyId;
    if (extra && typeof extra === 'object') Object.assign(row, extra);
    await db.collection('sms_log').add(row);
  } catch (e) {
    logger.warn('sms_log_write_failed', { err: e.message });
  }
}

/**
 * Verify Firebase ID token
 */
async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!idToken) return null;

  try {
    return await getAuth().verifyIdToken(idToken);
  } catch (e) {
    logger.warn('sms_auth_verify_failed', { err: e.message });
    return null;
  }
}

// C-02: require the caller to hold an active paid subscription AND
// a verified email before they can send SMS. The helper lives in
// functions/shared.js (B2) so claudeProxy + future billable endpoints
// can adopt the same gate without inlining another copy.
const { requirePaidSubscription } = require('./shared');

// ── Send-path response codes ─────────────────────────────────────
// docs/pro/js/nbd-comms.js turns some failures into a device-Messages handoff
// (the rep's own phone, text pre-filled). A handoff IS a text to that person,
// so the client may only do it after the opt-out register was read and came
// back clean. These codes are how the server says which side of that line a
// failure is on; the human-readable `error` field stays for older clients.
//   opted_out          403 — register hit, or Twilio's own STOP list (21610)
//   optout_unverified  503 — the register could not be read, or did not answer
//                            within OptOut.READ_TIMEOUT_MS; nothing sent
//   provider_error     502 — Twilio failed AFTER the opt-out check passed
const OPTOUT_UNVERIFIED_MSG = 'Could not verify this number can be texted — nothing was sent. Try again in a moment.';

// .catch() for the opt-out read in the two HTTP send paths. A throw, or a read
// that outlives OptOut.READ_TIMEOUT_MS, lands here; the caller answers the
// null with 503 optout_unverified. It never returns a verdict: an unknown
// opt-out status is not a clean one.
function optOutCheckFailed(fn) {
  return (e) => {
    logger.error('optout_check_error', {
      fn, err: e && e.message, timedOut: !!e && e.code === 'optout_read_timeout',
    });
    return null;
  };
}

// Twilio 21610 = "Attempt to send to unsubscribed recipient". Twilio keeps its
// own STOP list for our number and its keyword set is wider than STOP_WORDS
// below (it also honours e.g. OPTOUT / REVOKE), and incomingSMS's
// recordOptOut can fail after Twilio has already applied the STOP. Either way
// the register missed a real opt-out.
function isTwilioUnsubscribed(e) {
  return !!e && Number(e.code) === 21610;
}

// Copy Twilio's STOP into the register so every later send — including the
// AI-draft trigger, which consults only the register — is refused before it
// reaches Twilio. Best-effort: the send has already been refused either way.
async function recordCarrierOptOut(db, phone, fn) {
  try {
    await OptOut.recordOptOut(db, phone, {
      optedOutAt: FieldValue.serverTimestamp(),
      source: 'twilio_21610',
    });
  } catch (e) {
    logger.error('optout_record_error', { fn, source: 'twilio_21610', err: e && e.message });
  }
}

// ── Offline outbox: queued sends (sendQueuedSMS, or body.queued === true) ──
// docs/pro/js/sms-outbox.js replays a text the rep wrote while offline, via
// the sendQueuedSMS endpoint (see its export for why it is not sendSMS). The
// response codes it acts on:
//   200 { success, sid }                 sent
//   200 { success, duplicate: true }     this clientMsgId already went out
//   409 { code: 'held', reason }         not sent; waits for the rep in the
//                                        Pending texts tray (Outbox.HOLD_REASONS)
//   409 { code: 'not_claimed' }          (peek only) nothing of it reached Twilio
//   503 { code: 'outbox_unverified' }    a check could not be read; not sent,
//                                        stays queued (fails CLOSED, like the
//                                        opt-out read)
//   503 { code: 'outbox_throttled' }     the per-uid queued-gate budget is
//                                        spent; not sent, stays queued
// A queued text Twilio may or may not have taken (socket error, Twilio 5xx)
// answers 409 held 'in_flight', not 502: its claim is kept, so no retry of it
// can go out a second time.
// The outbox never turns any of these into a device-Messages handoff on its
// own; the tray's "Open in Messages" does, only on a FRESH 402/429/
// provider_error answer to a request made at the moment of the tap.
const OUTBOX_UNVERIFIED_MSG = 'Could not check this queued text against recent activity — nothing was sent. It stays in Pending texts.';

// A queued send's reads are bounded like the opt-out read (Outbox.READ_TIMEOUT_MS,
// read at call time). Nothing hands a queued send off, but an unbounded read
// would run into the function's own 30s timeout and answer with the
// framework's plain-text 500.
function withReadTimeout(promise, what) {
  let timer;
  const ms = Outbox.READ_TIMEOUT_MS;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(what + ' did not answer within ' + ms + 'ms');
      e.code = 'outbox_read_timeout';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function heldResponse(reason) {
  return { status: 409, body: { error: Outbox.holdMessage(reason), code: 'held', reason } };
}

function unverifiedResponse() {
  return { status: 503, body: { error: OUTBOX_UNVERIFIED_MSG, code: 'outbox_unverified' } };
}

// A LIVE send whose clientMsgId claim could not be written. nbd-comms.js
// refuses any 5xx that is not 'provider_error' (no handoff), so this reads
// to the rep as "nothing was sent, try again".
const LIVE_CLAIM_UNVERIFIED_MSG = 'Could not start this text safely — nothing was sent. Try again in a moment.';

/** What an existing claim doc means for a retry of the same clientMsgId. */
function claimVerdict(existing) {
  if (existing && existing.status === 'sent') {
    return { status: 200, body: { success: true, duplicate: true, sid: existing.twilioSid || null } };
  }
  // 'claimed': another request holds it (or crashed holding it). Twilio may or
  // may not have the text; do not guess, and do not send a second copy.
  return heldResponse('in_flight');
}

/**
 * Every check a queued send must pass after the opt-out register and BEFORE
 * the paid gate, the limiters and Twilio. Returns { respond } to answer now,
 * or { ctx } to carry on. Never sends.
 */
async function queuedSendGate(db, decoded, reqBody, to) {
  const now = Outbox.nowMs();
  const v = Outbox.validateQueuedFields(reqBody, now);
  if (!v.ok) {
    return { respond: { status: 400, body: { error: v.error, code: 'bad_queued_request' } } };
  }
  const uid = decoded.uid;
  const toDigits = Outbox.recipientKey(to);
  const leadId = (reqBody && typeof reqBody.leadId === 'string' && reqBody.leadId) || null;
  const claimRef = db.collection('sms_client_ids').doc(Outbox.claimDocId(uid, v.clientMsgId));

  // (a) Idempotency, read side. A retry of a text that already went out (the
  // response was lost on a bad connection) answers "duplicate" here, before
  // quiet hours or any hold could make an already-sent text look pending.
  // The transactional claim itself is taken immediately before Twilio (see
  // sendSMS): claiming here would leave a claim behind every hold, 402 and
  // 429, and the rep's later retry would be told "already sent" for a text
  // that never went.
  let existing;
  try {
    existing = await withReadTimeout(claimRef.get(), 'idempotency read');
  } catch (e) {
    logger.error('outbox_check_error', { stage: 'idempotency', err: e && e.message, code: e && e.code });
    return { respond: unverifiedResponse() };
  }
  if (existing && existing.exists) return { respond: claimVerdict(existing.data() || {}) };

  // An EDIT (docs/pro/js/sms-outbox.js editAndSend) is a new clientMsgId that
  // replaces earlier ones. If one of those reached Twilio — its response was
  // lost, or it is still in flight — the edit would be a second text, so the
  // originals' claims are checked here (Outbox.supersededVerdict). Bounded
  // and fail-closed like every other read on this path.
  if (v.supersedes.length) {
    let claims;
    try {
      claims = await withReadTimeout(Promise.all(v.supersedes.map((id) =>
        db.collection('sms_client_ids').doc(Outbox.claimDocId(uid, id)).get()
          .then((s) => (s && s.exists ? (s.data() || {}) : null)))), 'superseded read');
    } catch (e) {
      logger.error('outbox_check_error', { stage: 'superseded', err: e && e.message, code: e && e.code });
      return { respond: unverifiedResponse() };
    }
    const prior = Outbox.supersededVerdict(claims);
    if (prior && !(v.overrideActivity && Outbox.isActivityOverridable(prior))) {
      return { respond: heldResponse(prior) };
    }
  }

  // (b) Quiet hours — never overridable.
  if (!Outbox.isWithinSendWindow(now)) return { respond: heldResponse('quiet_hours') };

  // Stale — overridable only by the rep's explicit "Send now" (overrideStale).
  // On the server's clock (effectiveQueuedAt): a fast device clock must not
  // make an old text look fresh.
  if (!v.overrideStale && Outbox.isStale(v.effectiveQueuedAt, now)) return { respond: heldResponse('stale') };

  // (c) The lead, BEFORE any sms_log read. A lead the caller cannot open reads
  // exactly like a deleted one (lead_gone), and answering that first means the
  // activity scan below never runs for a lead that is not the caller's — the
  // scan's answer is not an oracle about someone else's customer. lead_changed
  // is kept and applied AFTER the activity check: "the homeowner texted since"
  // is the reason the rep most needs to see, and both are overridable by the
  // same "Send anyway", which must not skip a reply the rep was never shown.
  let leadHold = null;
  let lead = null;
  if (leadId) {
    try {
      const snap = await withReadTimeout(db.collection('leads').doc(leadId).get(), 'lead read');
      lead = snap && snap.exists ? (snap.data() || {}) : null;
    } catch (e) {
      logger.error('outbox_check_error', { stage: 'lead', err: e && e.message, code: e && e.code });
      return { respond: unverifiedResponse() };
    }
    leadHold = Outbox.evaluateLead(lead, {
      uid, companyId: decoded.companyId || null, role: decoded.role || '',
      leadStageAtQueue: v.leadStageAtQueue,
    });
    // lead_gone is never overridable.
    if (leadHold === 'lead_gone') return { respond: heldResponse('lead_gone') };
  }

  // (d) Competing activity since the text was written, IN THE CALLER'S
  // TENANT (Outbox.activityScope): one bounded, indexed query on the
  // recipient's canonical key plus the tenant field
  // ({toDigits, companyId|uid, date DESC}, firestore.indexes.json) finds both
  // directions — outbound rows are keyed by recipient, inbound ('received')
  // rows by sender and stamped with the matched lead's tenant.
  //   Plus, only for a lead that passed (c) AND whose own number this is:
  // inbound rows incomingSMS could not route to any tenant (no lead matched,
  // or the number matched leads in several tenants — uid null). The homeowner
  // may well have been answering this rep.
  let activity = null;
  try {
    const scope = Outbox.activityScope(decoded);
    const since = new Date(Outbox.activitySince(v.effectiveQueuedAt));
    const scan = (field, value) => db.collection('sms_log')
      .where('toDigits', '==', toDigits)
      .where(field, '==', value)
      .where('date', '>', since)
      .orderBy('date', 'desc')
      .limit(Outbox.ACTIVITY_SCAN_LIMIT)
      .get();
    // (lead_gone already answered above: a lead here is the caller's.)
    const unrouted = !!lead && Outbox.leadPhoneKey(lead) === toDigits;
    const snaps = await withReadTimeout(Promise.all(
      [scan(scope.field, scope.value)].concat(unrouted ? [scan('uid', null)] : [])), 'activity read');
    const rows = [];
    let truncated = false;
    for (const s of snaps) {
      const page = s.docs.map((d) => d.data());
      if (page.length >= Outbox.ACTIVITY_SCAN_LIMIT) truncated = true;
      rows.push(...page);
    }
    activity = Outbox.evaluateActivityRows(rows, {
      uid, queuedAt: v.queuedAt, effectiveQueuedAt: v.effectiveQueuedAt, clientMsgId: v.clientMsgId,
      truncated,
    });
  } catch (e) {
    logger.error('outbox_check_error', { stage: 'activity', err: e && e.message, code: e && e.code });
    return { respond: unverifiedResponse() };
  }
  if (activity && !(v.overrideActivity && Outbox.isActivityOverridable(activity))) {
    return { respond: heldResponse(activity) };
  }
  // lead_changed is overridable ("Send anyway").
  if (leadHold && !(v.overrideActivity && Outbox.isActivityOverridable(leadHold))) {
    return { respond: heldResponse(leadHold) };
  }

  return { ctx: { claimRef, clientMsgId: v.clientMsgId, queuedAt: v.queuedAt, toDigits, uid } };
}

/**
 * A PEEK — "Check again" in the tray, and the flush's re-ask about a text
 * whose last answer never arrived. Reads this id's claim (and the claims of
 * the ids an edit replaces) and answers from them alone:
 *   200 { success, duplicate: true } — it went out
 *   409 held in_flight              — claimed / outcome unknown
 *   409 held recent_outbound        — an edit whose original went out
 *   409 { code: 'not_claimed' }     — nothing of it reached Twilio
 * NEVER sends, so it runs before the opt-out register (a text that already
 * went out before a STOP is still "duplicate", and its receipt still stamps
 * the invoice) and needs no number or message. Fail-closed reads, like the
 * rest of this path.
 */
async function queuedPeek(db, decoded, reqBody) {
  const v = Outbox.validatePeekFields(reqBody);
  if (!v.ok) return { status: 400, body: { error: v.error, code: 'bad_queued_request' } };
  const uid = decoded.uid;
  const claimRef = (id) => db.collection('sms_client_ids').doc(Outbox.claimDocId(uid, id));
  let own;
  let prior;
  try {
    own = await withReadTimeout(claimRef(v.clientMsgId).get(), 'idempotency read');
    if (!(own && own.exists) && v.supersedes.length) {
      prior = await withReadTimeout(Promise.all(v.supersedes.map((id) => claimRef(id).get()
        .then((s) => (s && s.exists ? (s.data() || {}) : null)))), 'superseded read');
    }
  } catch (e) {
    logger.error('outbox_check_error', { stage: 'peek', err: e && e.message, code: e && e.code });
    return unverifiedResponse();
  }
  if (own && own.exists) return claimVerdict(own.data() || {});
  const p = Outbox.supersededVerdict(prior || []);
  if (p) return heldResponse(p);
  return { status: 409, body: { error: 'This text has not been sent.', code: 'not_claimed' } };
}

/**
 * The queued gate's own per-uid budget (Outbox.QUEUED_GATE_LIMIT), taken
 * before any outbox read. Returns null to carry on, or a response.
 */
async function queuedGateLimit(decoded) {
  try {
    await enforceRateLimit('sendQueuedSMS:uid', decoded.uid, Outbox.QUEUED_GATE_LIMIT, Outbox.QUEUED_GATE_WINDOW_MS);
    return null;
  } catch (e) {
    if (e && e.rateLimited) {
      // 503, not 429: the client reads a 429 on a queued text as a handoff
      // verdict ("the holds passed, only the limit did not"). This one comes
      // BEFORE the holds. Nothing was sent; the text stays queued.
      return {
        status: 503,
        body: { error: 'Too many queued-text checks — nothing was sent. It stays in Pending texts.', code: 'outbox_throttled' },
      };
    }
    logger.error('outbox_check_error', { stage: 'gate_limit', err: e && e.message, code: e && e.code });
    return unverifiedResponse();
  }
}

// ═══════════════════════════════════════════════════════════════
// CLOUD FUNCTIONS
// ═══════════════════════════════════════════════════════════════

// sendSMS and sendQueuedSMS: one handler, one configuration.
const SEND_SMS_OPTS = Object.freeze({
  cors: CORS_ORIGINS,
  secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
  maxInstances: 20,
  concurrency: 40,
  timeoutSeconds: 30,
  memory: '256MiB'
});

/**
 * The send handler behind both endpoints.
 * @param {boolean} queuedEndpoint  true for sendQueuedSMS: every request is a
 *   queued (offline-outbox) send, whatever its body says, or a peek.
 */
async function handleSendSMS(req, res, queuedEndpoint) {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    // Verify Firebase auth
    const decoded = await verifyAuth(req);
    if (!decoded) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // "Check again" / the flush re-asking about a text whose answer was lost:
    // claims only, never a send (queuedPeek). Metered like every queued request.
    if (queuedEndpoint && req.body && req.body.peek === true) {
      const limited = await queuedGateLimit(decoded);
      const r = limited || await queuedPeek(getFirestore(), decoded, req.body);
      res.status(r.status).json(r.body);
      return;
    }

    const { to, body, leadId } = req.body || {};
    // A text replayed from the offline outbox (docs/pro/js/sms-outbox.js):
    // everything sent to sendQueuedSMS, or `queued: true` here. Strictly
    // `=== true`: live sends — everything that does not set it — take exactly
    // the path they always did.
    const queued = queuedEndpoint || (!!req.body && req.body.queued === true);

    // Validate input
    if (!to || !isValidPhoneNumber(to)) {
      res.status(400).json({ error: 'Invalid phone number format' });
      return;
    }

    // F3: TCPA. If the recipient replied STOP, we must not message them again —
    // civil penalties per message are steep.
    //
    // This runs BEFORE the paid gate and EVERY limiter (per-IP included), on
    // purpose. The client answers a 402 or 429 by opening the rep's Messages
    // app with the text filled in, so any 402/429 sent ahead of this check
    // handed a possibly-STOP'd number to a device-side send — the 6th text of
    // the day to an opted-out number got the per-recipient 429 and a handoff.
    // Here, a 402/429 can only mean "this number is textable".
    //
    // Fail CLOSED with a distinguishable 503 (the onAiDraftApproved stance). A
    // read error used to escape as the framework's plain-text 500, which the
    // client could not tell apart from a Twilio outage and handed off.
    //
    // Bounded (timeoutMs): a read that HANGS must also end in that 503. The
    // client aborts at 25s and hands the abort off like being offline, so a
    // read still pending then handed off a number nobody had checked.
    const optOut = await OptOut.isOptedOut(getFirestore(), to, { timeoutMs: OptOut.READ_TIMEOUT_MS })
      .catch(optOutCheckFailed('sendSMS'));
    if (optOut && optOut.optedOut) {
      if (optOut.viaLegacyKey) {
        logger.info('optout.legacy_key_hit', { fn: 'sendSMS', key: optOut.key });
      }
      res.status(403).json({
        error: 'This recipient has opted out of SMS (replied STOP). Contact them by phone or email.',
        code: 'opted_out',
      });
      return;
    }
    if (!optOut) {
      res.status(503).json({ error: OPTOUT_UNVERIFIED_MSG, code: 'optout_unverified' });
      return;
    }

    // Offline outbox. After the opt-out register (a STOP is a 403 whether the
    // text was queued or not) and BEFORE the paid gate, the limiters and
    // Twilio: a held or duplicate queued text must neither burn budget nor
    // come back as a 402/429. Live sends skip this block entirely.
    let queuedCtx = null;
    if (queued) {
      const limited = await queuedGateLimit(decoded);
      if (limited) {
        res.status(limited.status).json(limited.body);
        return;
      }
      const gate = await queuedSendGate(getFirestore(), decoded, req.body, to);
      if (gate.respond) {
        res.status(gate.respond.status).json(gate.respond.body);
        return;
      }
      queuedCtx = gate.ctx;
    }

    // Per-IP cap: 30 SMS/hour from a single IP. After the opt-out check (it
    // used to run first) because its 429 is handed off like the others.
    // Unauthenticated callers are already turned away by verifyAuth above.
    if (!(await httpRateLimit(req, res, 'sendSMS:ip', 30, 3_600_000))) return;

    // C-02: paid-subscription + email-verify gate. Rejected callers
    // NEVER reach the per-uid rate-limit increment below, so a
    // failed gate doesn't burn their budget.
    const subGate = await requirePaidSubscription(getFirestore(), decoded);
    if (!subGate.ok) {
      res.status(subGate.status).json({ error: subGate.error });
      return;
    }

    // Per-uid cap: 100 SMS/day.
    try {
      await enforceRateLimit('sendSMS:uid', decoded.uid, 100, 86_400_000);
    } catch (e) {
      if (e.rateLimited) { res.status(429).json({ error: 'Daily SMS limit exceeded' }); return; }
      throw e;
    }

    // C4: per-recipient cap — even if a rep has budget remaining,
    // no single phone number should receive >5 SMS/day from this
    // app across ALL reps. Anti-harassment + TCPA defense.
    // Canonical last-10 key. The old plain digit-strip split this bucket in
    // two — a rep-typed '(859) 555-0134' and the AI path's E.164 fallback
    // counted separately, so the same person could receive 10/day against a
    // stated cap of 5.
    const toDigits = OptOut.optOutKey(to);
    try {
      await enforceRateLimit('sendSMS:to', toDigits, 5, 86_400_000);
    } catch (e) {
      if (e.rateLimited) {
        res.status(429).json({
          error: 'This recipient has received the maximum SMS for today. Try tomorrow or contact them directly.'
        });
        return;
      }
      throw e;
    }

    if (!body || body.trim().length === 0) {
      res.status(400).json({ error: 'Body cannot be empty' });
      return;
    }

    if (body.length > 1600) {
      res.status(400).json({ error: 'Message too long (max 1600 characters)' });
      return;
    }

    const db = getFirestore();
    const companyId = decoded.companyId || null;

    // Idempotency, write side: claim this clientMsgId in a transaction
    // immediately before Twilio, after every hold and gate has passed.
    //   queued: required (validated by queuedSendGate). Two concurrent replays
    //           of the same text (two tabs, a retry racing a slow first
    //           attempt) cannot both get past this.
    //   live:   optional. nbd-comms.js mints the id BEFORE the attempt and,
    //           when the attempt dies at the client with status 0 (network
    //           drop, the 25s abort), the outbox stores the text under that
    //           SAME id. If this request had already reached here, its claim
    //           makes the replay answer "in_flight" / "duplicate" — without
    //           it, the replay's activity check ran before this send's
    //           sms_log row existed and the homeowner got the text twice.
    //           No id (older clients, other callers): no claim, the
    //           pre-outbox path exactly.
    // A claim is released below only when Twilio DEFINITELY did not take the
    // text, marked 'unknown' when that cannot be known, and 'sent' when it did.
    let claimCtx = queuedCtx;
    if (!claimCtx) {
      const liveId = req.body && req.body.clientMsgId;
      if (typeof liveId === 'string' && Outbox.CLIENT_MSG_ID_RE.test(liveId)) {
        claimCtx = {
          claimRef: db.collection('sms_client_ids').doc(Outbox.claimDocId(decoded.uid, liveId)),
          clientMsgId: liveId, queuedAt: null, toDigits, uid: decoded.uid, live: true,
        };
      }
    }
    let outboxLog = null;
    if (claimCtx) {
      let claim;
      try {
        claim = await db.runTransaction(async (tx) => {
          const snap = await tx.get(claimCtx.claimRef);
          if (snap.exists) return { existing: snap.data() || {} };
          const doc = {
            uid: claimCtx.uid,
            clientMsgId: claimCtx.clientMsgId,
            toDigits: claimCtx.toDigits,
            queuedAt: claimCtx.queuedAt,
            status: 'claimed',
            claimedAt: FieldValue.serverTimestamp(),
            // TTL (firestore.indexes.json): the claim outlives every replay
            // that could still carry this id, then goes.
            expireAt: Outbox.claimExpireAt(Outbox.nowMs()),
          };
          if (claimCtx.live) doc.live = true;
          tx.create(claimCtx.claimRef, doc);
          return { claimed: true };
        });
      } catch (e) {
        // ALREADY_EXISTS at commit: a concurrent replay of this same text won
        // the create between our read and our write. It is in flight — the
        // same answer as finding its claim.
        const lostRace = !!e && (e.code === 6 || e.code === 'already-exists' || /ALREADY_EXISTS/.test(String(e.message || '')));
        if (lostRace) {
          const r = heldResponse('in_flight');
          res.status(r.status).json(r.body);
          return;
        }
        logger.error('outbox_check_error', { stage: 'claim', live: !!claimCtx.live, err: e && e.message, code: e && e.code });
        if (claimCtx.live) {
          res.status(503).json({ error: LIVE_CLAIM_UNVERIFIED_MSG, code: 'outbox_unverified' });
          return;
        }
        const r = unverifiedResponse();
        res.status(r.status).json(r.body);
        return;
      }
      if (!claim || claim.existing) {
        const r = claimVerdict(claim && claim.existing);
        res.status(r.status).json(r.body);
        return;
      }
      outboxLog = claimCtx.live
        ? { clientMsgId: claimCtx.clientMsgId }
        : { queued: true, queuedAt: claimCtx.queuedAt, clientMsgId: claimCtx.clientMsgId };
    }
    // Best-effort: a claim that cannot be released surfaces to the rep as an
    // 'in_flight' hold on the next attempt, never as a second send.
    const releaseClaim = async () => {
      if (!claimCtx) return;
      try { await claimCtx.claimRef.delete(); }
      catch (e) { logger.error('outbox_claim_release_failed', { err: e && e.message }); }
    };
    // Twilio may or may not have the text: keep the claim, say so. A retry of
    // this id then holds as 'in_flight' (claimVerdict) — the rep checks the
    // thread instead of the app guessing and texting the homeowner twice.
    const markClaimUnknown = async () => {
      if (!claimCtx) return;
      try {
        await claimCtx.claimRef.set({ status: 'unknown', failedAt: FieldValue.serverTimestamp() }, { merge: true });
      } catch (e) { logger.error('outbox_claim_mark_unknown_failed', { err: e && e.message }); }
    };

    let message;
    // Set immediately before messages.create: an error thrown earlier (client
    // construction, a secret read, a bad number) never reached Twilio.
    let twilioAttempted = false;
    try {
      // Initialize Twilio client
      const client = _twilio()(
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value()
      );

      const formattedTo = formatPhoneNumber(to);
      const fromPhone = TWILIO_PHONE_NUMBER.value();

      if (!formattedTo) {
        await releaseClaim();
        res.status(400).json({ error: 'Could not format phone number' });
        return;
      }

      // Send SMS
      twilioAttempted = true;
      message = await client.messages.create({
        body,
        from: fromPhone,
        to: formattedTo
      });
    } catch (e) {
      logger.error('sendSMS error', { err: e && e.message, code: e && e.code, status: e && e.status });

      // Did the text DEFINITELY not go? Only a Twilio 4xx answer (or an error
      // before the request left) says so. ECONNRESET, a socket timeout, a
      // Twilio 5xx — Twilio may have accepted the text before the connection
      // broke, and releasing the claim then let the rep's retry send it again.
      const definite = !twilioAttempted || Outbox.isDefiniteProviderRejection(e);
      if (definite) await releaseClaim();   // free the id so a retry can send
      else await markClaimUnknown();        // a retry of this id holds instead

      // Log failure. An unknown outcome is marked as such: the competing-
      // activity check (sms-outbox-guard.js) must not treat a text the
      // homeowner may well have as "nothing reached them".
      const failExtra = definite ? outboxLog : Object.assign({}, outboxLog || {}, { deliveryUnknown: true });
      await logSMSToFirestore(db, to, body, decoded.uid, leadId || null, 'failed', null, companyId, failExtra);

      if (isTwilioUnsubscribed(e)) {
        await recordCarrierOptOut(db, to, 'sendSMS');
        res.status(403).json({
          error: 'This recipient has opted out of SMS (replied STOP). Contact them by phone or email.',
          code: 'opted_out',
        });
        return;
      }
      // A QUEUED text whose outcome is unknown is not a provider error the rep
      // may retry or hand to Messages: it may already be on their phone.
      if (queuedCtx && !definite) {
        const r = heldResponse('in_flight');
        res.status(r.status).json(r.body);
        return;
      }
      // The opt-out check passed, so this is the one 5xx the client may hand
      // off to device Messages (Twilio trial / A2P / outage). Live sends keep
      // this answer whatever the cause — the #1667 contract.
      res.status(502).json({ error: 'Failed to send SMS', code: 'provider_error' });
      return;
    }

    if (claimCtx) {
      try {
        await claimCtx.claimRef.set({
          status: 'sent',
          twilioSid: message.sid || null,
          sentAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (e) {
        // The text went out. A claim stuck at 'claimed' makes a retry hold as
        // 'in_flight' rather than send twice, which is the safe failure.
        logger.error('outbox_claim_mark_sent_failed', { err: e && e.message });
      }
    }

    // Log to Firestore
    await logSMSToFirestore(db, to, body, decoded.uid, leadId || null, 'sent', message.sid, companyId, outboxLog);

    res.json({
      success: true,
      sid: message.sid
    });
}

/**
 * sendSMS — HTTP function (POST, authenticated)
 * Sends an SMS message to a phone number (live sends; `queued: true` bodies
 * are still honoured here, but the outbox posts to sendQueuedSMS).
 */
exports.sendSMS = onRequest({ ...SEND_SMS_OPTS }, (req, res) => handleSendSMS(req, res, false));

/**
 * sendQueuedSMS — HTTP function (POST, authenticated)
 * The offline outbox's endpoint (docs/pro/js/nbd-comms.js sendQueued /
 * peekQueued): every request is a queued send (the full queued gate in
 * sms-outbox-guard.js) or a peek. Same handler as sendSMS.
 *
 * Why a separate endpoint and not just `queued: true` on sendSMS: Hosting
 * deploys before Functions (.github/workflows/firebase-deploy.yml), a
 * functions deploy can fail while Hosting stays live, and a hosting-only
 * deploy or a functions rollback puts new pages in front of an old fleet.
 * An old sendSMS ignores `queued` and would send every replay as a live text
 * — no quiet hours, no staleness, no activity check, no idempotency claim.
 * An old fleet has no sendQueuedSMS at all: the request fails (404 / CORS)
 * and the outbox keeps the text queued until the new function is live.
 */
exports.sendQueuedSMS = onRequest({ ...SEND_SMS_OPTS }, (req, res) => handleSendSMS(req, res, true));

/**
 * sendD2DSMS — HTTP function (POST, authenticated)
 * Sends a D2D-specific SMS using predefined templates
 */
exports.sendD2DSMS = onRequest(
  {
    cors: CORS_ORIGINS,
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
    maxInstances: 20,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    if (!(await httpRateLimit(req, res, 'sendD2DSMS:ip', 60, 3_600_000))) return;

    // Verify Firebase auth
    const decoded = await verifyAuth(req);
    if (!decoded) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    // C-02: paid-subscription + email-verify gate (see sendSMS).
    const subGate = await requirePaidSubscription(getFirestore(), decoded);
    if (!subGate.ok) {
      res.status(subGate.status).json({ error: subGate.error });
      return;
    }

    try {
      await enforceRateLimit('sendD2DSMS:uid', decoded.uid, 200, 86_400_000);
    } catch (e) {
      if (e.rateLimited) { res.status(429).json({ error: 'Daily SMS limit exceeded' }); return; }
      throw e;
    }

    const { knockId, templateKey } = req.body;

    if (!knockId || !templateKey) {
      res.status(400).json({ error: 'knockId and templateKey required' });
      return;
    }

    if (!D2D_SMS_TEMPLATES[templateKey]) {
      res.status(400).json({
        error: 'Invalid template key',
        validKeys: Object.keys(D2D_SMS_TEMPLATES)
      });
      return;
    }

    try {
      const db = getFirestore();

      // C-01: collection is `knocks` (matches firestore.rules:282,
      // functions/index.js:2217,2448, seed-demo.js:487, and every
      // client writer in docs/pro/js/). Previous code hit a legacy
      // non-existent collection name so every call 404'd — rename
      // fixes the correctness bug AND lands the IDOR fix.
      const knockSnap = await db.doc(`knocks/${knockId}`).get();
      // firebase-admin v12 DocumentSnapshot.exists is a property,
      // not a method — the previous `.exists()` call threw
      // TypeError and fell through to the 500 catch branch.
      if (!knockSnap.exists) {
        res.status(404).json({ error: 'Knock not found' });
        return;
      }

      const knock = knockSnap.data();

      // C-01: ownership check. Without this, any authenticated
      // user could trigger an SMS from the platform Twilio number
      // to any knock's homeowner by guessing/leaking the knockId
      // (the admin SDK lookup bypasses the Firestore rule at
      // firestore.rules:282-288). Mirror the rule's authorization
      // matrix: owner, platform admin, or a manager/company_admin
      // in the same tenant.
      const callerRole = decoded.role || '';
      const callerCompanyId = decoded.companyId || null;
      const isPlatformAdmin = callerRole === 'admin';
      const isOwnKnock = knock.userId === decoded.uid;
      const isManagerInSameCompany =
        ['manager', 'company_admin'].includes(callerRole)
        && callerCompanyId
        && knock.companyId
        && knock.companyId === callerCompanyId;
      if (!isPlatformAdmin && !isOwnKnock && !isManagerInSameCompany) {
        logger.warn('sendD2DSMS IDOR attempt', {
          caller: decoded.uid,
          knockId,
          knockOwner: knock.userId,
        });
        res.status(403).json({ error: 'Not your knock' });
        return;
      }

      const phoneNumber = knock.phone || knock.phoneNumber;

      if (!phoneNumber || !isValidPhoneNumber(phoneNumber)) {
        res.status(400).json({ error: 'Knock has invalid phone number' });
        return;
      }

      // F3: TCPA — check opt-out list before sending, as early as the
      // recipient is known (the knock has to be read and authorised first,
      // so unlike sendSMS the paid gate and per-uid cap stay ahead of it —
      // nothing in docs/ calls this endpoint, so no client hands those off).
      // Ahead of the per-recipient cap so an attempt to an opted-out number
      // neither burns that bucket nor comes back as a 429. Fails CLOSED with
      // a 503 on a read error or a read that outlives the bound, same as
      // sendSMS.
      const optOut = await OptOut.isOptedOut(getFirestore(), phoneNumber, { timeoutMs: OptOut.READ_TIMEOUT_MS })
        .catch(optOutCheckFailed('sendD2DSMS'));
      if (optOut && optOut.optedOut) {
        if (optOut.viaLegacyKey) {
          logger.info('optout.legacy_key_hit', { fn: 'sendD2DSMS', key: optOut.key });
        }
        res.status(403).json({
          error: 'This number has opted out of SMS (replied STOP).',
          code: 'opted_out',
        });
        return;
      }
      if (!optOut) {
        res.status(503).json({ error: OPTOUT_UNVERIFIED_MSG, code: 'optout_unverified' });
        return;
      }

      // C4: per-recipient cap — 5/day across all reps.
      // Same canonical key as sendSMS so a knock and a CRM text share one
      // per-recipient bucket instead of two.
      const toDigits = OptOut.optOutKey(phoneNumber);
      try {
        await enforceRateLimit('sendSMS:to', toDigits, 5, 86_400_000);
      } catch (e) {
        if (e.rateLimited) {
          res.status(429).json({
            error: 'This recipient has received the max SMS for today.'
          });
          return;
        }
        throw e;
      }

      // Multi-tenant branding: sendD2DSMS is reachable by ANY tenant (the auth
      // gate is owner / platform-admin / manager-in-same-company, keyed off
      // knock.companyId), but the D2D templates hardcode NBD's brand
      // ('NBD Home Solutions' / 'NBD'). A non-NBD rep must not text a homeowner
      // under NBD's name. Resolve the tenant's legal name once (best-effort) and
      // swap the NBD brand tokens for it. NBD (companyProfile absent, or its
      // brand.legalName is NBD's own) leaves tenantName '' → NO swap → the
      // template renders byte-identical to before.
      let tenantName = '';
      const tenantKey = knock.companyId || knock.userId;
      if (tenantKey) {
        try {
          const cpSnap = await db.doc(`companyProfile/${tenantKey}`).get();
          if (cpSnap.exists) {
            const legal = ((cpSnap.data() || {}).brand || {}).legalName || '';
            if (legal && legal !== 'No Big Deal Home Solutions') tenantName = legal;
          }
        } catch (e) {
          logger.warn('sendD2DSMS tenant resolve failed', { knockId, err: e.message });
        }
      }

      // Get template
      const template = D2D_SMS_TEMPLATES[templateKey];

      // Populate template variables
      let body = template.body;
      const variables = {
        name: knock.firstName || knock.name || 'there',
        rep: knock.repName || 'Joe',
        appointmentDate: knock.appointmentDate || '[TBD]',
        appointmentTime: knock.appointmentTime || '[TBD]'
      };

      Object.keys(variables).forEach(key => {
        body = body.replace(new RegExp(`\\{${key}\\}`, 'g'), variables[key]);
      });

      // Non-NBD tenant: replace NBD's brand mentions with the tenant's name.
      // Longer token first so 'NBD Home Solutions' doesn't half-match the
      // '\bNBD\b' rule. NBD tenants skip this entirely (tenantName '').
      if (tenantName) {
        body = body.replace(/NBD Home Solutions/g, tenantName).replace(/\bNBD\b/g, tenantName);
      }

      if (body.length > 1600) {
        res.status(400).json({ error: 'Generated message too long' });
        return;
      }

      const formattedTo = formatPhoneNumber(phoneNumber);
      if (!formattedTo) {
        res.status(400).json({ error: 'Could not format phone number' });
        return;
      }

      // Send SMS. Only the provider call is scoped here: a Twilio failure
      // gets the same codes as sendSMS; anything else still reaches the
      // outer 500.
      let message;
      try {
        const client = _twilio()(
          TWILIO_ACCOUNT_SID.value(),
          TWILIO_AUTH_TOKEN.value()
        );
        message = await client.messages.create({
          body,
          from: TWILIO_PHONE_NUMBER.value(),
          to: formattedTo
        });
      } catch (e) {
        logger.error('sendD2DSMS error', { err: e && e.message, code: e && e.code });
        if (isTwilioUnsubscribed(e)) {
          await recordCarrierOptOut(db, phoneNumber, 'sendD2DSMS');
          res.status(403).json({
            error: 'This number has opted out of SMS (replied STOP).',
            code: 'opted_out',
          });
          return;
        }
        res.status(502).json({ error: 'Failed to send D2D SMS', code: 'provider_error' });
        return;
      }

      // Update knock with lastSmsSent
      await db.doc(`knocks/${knockId}`).update({
        lastSmsSent: FieldValue.serverTimestamp()
      });

      // Log to Firestore. companyId: the offline outbox's activity check reads
      // sms_log per tenant (sms-outbox-guard.js activityScope), so a D2D text
      // must carry its sender's company to count as a competitor there.
      await logSMSToFirestore(db, phoneNumber, body, decoded.uid, knockId, 'sent', message.sid, decoded.companyId || null);

      res.json({
        success: true,
        sid: message.sid
      });

    } catch (e) {
      logger.error('sendD2DSMS error', { err: e.message });
      res.status(500).json({
        error: 'Failed to send D2D SMS'
      });
    }
  }
);

/**
 * incomingSMS — HTTP function (POST, no auth)
 * Webhook for Twilio incoming SMS messages
 * Verifies Twilio signature instead of Firebase auth
 */
exports.incomingSMS = onRequest(
  {
    cors: false, // Webhooks don't use CORS
    // ANTHROPIC_API_KEY is for T-1 AI-texting draft generation; if the
    // secret isn't set the generateAIDraft() call no-ops cleanly per
    // its own contract, so listing it here is safe even before the
    // secret is configured in Firebase.
    secrets: [TWILIO_AUTH_TOKEN, AI_ANTHROPIC_KEY],
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    try {
      // Verify Twilio signature using the ACTUAL validator. The previous code
      // called `twilio.webhook(...)` which is an Express middleware FACTORY —
      // it returns a function, not a boolean, so the `if (!isValid)` branch
      // was never taken and the signature check was effectively off.
      const twilioSignature = req.headers['x-twilio-signature'] || '';
      const authToken = TWILIO_AUTH_TOKEN.value();
      const url = `https://${req.get('host')}${req.originalUrl}`;

      // Twilio signs the sorted set of POSTed form fields as an object.
      const params = (req.body && typeof req.body === 'object') ? req.body : {};

      const isValid = _twilio().validateRequest(authToken, twilioSignature, url, params);
      if (!isValid) {
        logger.warn('incomingSMS signature verification failed', {
          host: req.get('host'),
          ip: clientIp(req),
        });
        res.status(403).json({ error: 'Webhook signature verification failed' });
        return;
      }

      // Extract + sanitize fields.
      const fromPhone    = escForStore(req.body.From);
      const messageBody  = escForStore(req.body.Body);
      const messageSid   = escForStore(req.body.MessageSid);

      if (!fromPhone || !messageBody) {
        res.status(400).json({ error: 'Missing From or Body' });
        return;
      }

      const db = getFirestore();

      // F3: TCPA compliance. Any of the opt-out keywords
      // (per CTIA Short Code Monitoring Handbook § 5.2) must be
      // honored on the same day. We add the phone to
      // sms_opt_outs/{digits} and respond with TwiML confirming
      // the opt-out. The sendSMS + sendD2DSMS functions check
      // this collection before sending.
      const opt = String(messageBody || '').trim().toUpperCase();
      const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
      const HELP_WORDS = new Set(['HELP', 'INFO']);
      // CTIA-standard resume keywords ONLY. 'YES' was here too, but a customer
      // replying "YES" to a rep's question would short-circuit the whole inbound
      // pipeline — auto-send a "Welcome back" reply with NO rep approval and
      // never create the AI draft / reach the rep. (TCPA resume ≠ "yes".)
      const START_WORDS = new Set(['START', 'UNSTOP']);
      // Canonical last-10 key — NOT a plain digit strip. Twilio delivers
      // E.164, so the old strip kept the leading country-code 1 and wrote a
      // key no sender ever looked up. See functions/sms-optout.js.
      const phoneDigits = OptOut.optOutKey(fromPhone);
      if (phoneDigits && STOP_WORDS.has(opt)) {
        await OptOut.recordOptOut(db, fromPhone, {
          optedOutAt: FieldValue.serverTimestamp(),
          keyword: opt,
          twilioSid: messageSid
        });
        // TwiML reply confirming opt-out. Twilio sends this back.
        res.set('Content-Type', 'text/xml');
        res.status(200).send(
          '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          '<Message>You\'ve been unsubscribed from NBD Pro SMS. ' +
          'Reply START to resume, HELP for help.</Message></Response>'
        );
        return;
      }
      if (phoneDigits && HELP_WORDS.has(opt)) {
        res.set('Content-Type', 'text/xml');
        res.status(200).send(
          '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          '<Message>NBD Pro: Msg & data rates may apply. Reply STOP to ' +
          'unsubscribe. Support: (859) 420-7382.</Message></Response>'
        );
        return;
      }
      if (phoneDigits && START_WORDS.has(opt)) {
        // Resume — delete the opt-out record so the phone is live again.
        // Clears BOTH the canonical and the legacy key: leaving a
        // pre-migration record behind would keep the lookup's legacy branch
        // suppressing someone who explicitly asked to resume.
        await OptOut.clearOptOut(db, fromPhone);
        res.set('Content-Type', 'text/xml');
        res.status(200).send(
          '<?xml version="1.0" encoding="UTF-8"?><Response>' +
          '<Message>Welcome back to NBD Pro SMS. Reply STOP anytime to ' +
          'unsubscribe.</Message></Response>'
        );
        return;
      }

      // Idempotency: Twilio retries the webhook on any non-2xx / timeout, which
      // would otherwise create DUPLICATE inbound notes + AI drafts + push
      // notifications. Claim the MessageSid once (mirrors the Stripe webhook's
      // eventRef.create dedup); a retry hits the existing doc and no-ops.
      if (messageSid) {
        try {
          await db.doc('sms_inbound_seen/' + messageSid)
            .create({ from: fromPhone, at: FieldValue.serverTimestamp() });
        } catch (e) {
          logger.info('[incomingSMS] duplicate webhook ignored', { messageSid });
          res.set('Content-Type', 'text/xml');
          res.status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
          return;
        }
      }

      // Match phone number to a lead in Firestore.
      //
      // Twilio delivers the sender in E.164 (+15551234567); leads store the
      // phone however the rep typed it ("(555) 123-4567"), so an exact
      // `phone == fromPhone` match almost never hit — most inbound texts
      // never tied to a lead (no inbound note, no AI draft, rep never saw
      // it). We now match on the normalized `phoneDigits` key (last-10 US
      // digits) that every lead-write path stamps. Admin SDK + single-field
      // equality → auto single-field index (no composite needed).
      //
      // The exact-`phone` fallback covers any lead not yet backfilled with
      // phoneDigits (defense-in-depth until the backfill has fully run).
      const fromDigits = phoneDigits10(fromPhone);
      // Tenant-safe match (audit 2026-08-02 HIGH-5): the old `.limit(1)` +
      // first-doc pick could file a homeowner's reply into ANOTHER company's
      // lead when two tenants both hold this number. Collect ALL candidates
      // (bounded) from both match keys, then let pickLeadForInbound decide —
      // cross-tenant with no fresh outbound signal goes to unmatched_sms
      // triage, never a guess.
      const MATCH_LIMIT = 10;
      const digitsSnap = fromDigits
        ? await db.collection('leads').where('phoneDigits', '==', fromDigits).limit(MATCH_LIMIT).get()
        : { empty: true, docs: [] };
      // Exact-`phone` fallback still covers any lead not yet backfilled with
      // phoneDigits — now merged in unconditionally so an un-backfilled lead
      // in a SECOND tenant can't be invisible to the ambiguity check.
      const phoneSnap = await db
        .collection('leads')
        .where('phone', '==', fromPhone)
        .limit(MATCH_LIMIT)
        .get();
      const docsById = new Map();
      for (const d of [...digitsSnap.docs, ...phoneSnap.docs]) {
        if (!docsById.has(d.id)) docsById.set(d.id, d);
      }
      if (docsById.size >= MATCH_LIMIT) {
        logger.warn('[incomingSMS] candidate cap hit — match set may be incomplete', { fromDigits });
      }

      const tsMillis = (v) => (v && typeof v.toMillis === 'function') ? v.toMillis()
        : (typeof v === 'number' ? v : null);
      const candidates = [];
      for (const [id, d] of docsById) {
        const data = d.data();
        candidates.push({
          id,
          companyId: data.companyId || null,
          userId: data.userId || null,
          lastOutboundAt: null,
          lastContactedAt: tsMillis(data.lastContactedAt),
          createdAt: tsMillis(data.createdAt),
        });
      }
      // Outbound-SMS recency is only needed to break ties — skip the extra
      // reads for the common single-match case. Uses the existing
      // {leadId, uid, date} composite (firestore.indexes.json); outbound rows
      // are any status other than 'received'.
      if (candidates.length > 1) {
        for (const c of candidates) {
          if (!c.userId) continue;
          try {
            const out = await db.collection('sms_log')
              .where('leadId', '==', c.id)
              .where('uid', '==', c.userId)
              .orderBy('date', 'desc')
              .limit(3)
              .get();
            const sent = out.docs.map(x => x.data()).find(x => x && x.status !== 'received');
            c.lastOutboundAt = sent ? tsMillis(sent.date) : null;
          } catch (e) {
            // Recency is best-effort; a failed lookup just means this lead
            // can't win a cross-tenant tiebreak (fails toward triage).
            logger.warn('[incomingSMS] outbound-recency lookup failed', { leadId: c.id, err: e.message });
          }
        }
      }

      const route = pickLeadForInbound(candidates, { now: Date.now() });
      if (route.ambiguity) {
        logger.warn('[incomingSMS] ambiguous phone match', {
          ambiguity: route.ambiguity,
          decision: route.decision,
          candidateLeadIds: candidates.map(c => c.id),
        });
      }

      let leadId = null;
      let lead = null;
      if (route.decision === 'route') {
        leadId = route.leadId;
        lead = docsById.get(leadId).data();

        // Create a note on the lead with the incoming SMS. Capture the
        // ref so T-1 can link the generated draft back to the source
        // incoming note via `incomingMsgId` (lets the rep UI later show
        // "draft for: <quoted incoming message>").
        const incomingNoteRef = await db.collection('leads').doc(leadId).collection('notes').add({
          type: 'sms',
          direction: 'incoming',
          from: fromPhone,
          body: messageBody,
          twilioSid: messageSid,
          createdAt: FieldValue.serverTimestamp()
        });

        // Update lead's lastContactedAt
        await db.doc(`leads/${leadId}`).update({
          lastContactedAt: FieldValue.serverTimestamp()
        });

        // T-1 step 2: generate an AI-suggested reply draft. Best-effort:
        // generateAIDraft() handles its own errors and returns null on
        // missing secret / Claude timeout / write failure. Awaited so the
        // draft lands in Firestore before the TwiML 200 returns. The
        // module's internal 10s Claude timeout keeps total webhook time
        // under Twilio's 15s ceiling. T-2 will ship the rep UI to view +
        // approve/edit/send these drafts; for now they accumulate at
        // /leads/{leadId}/ai_drafts/{draftId} with status:'pending'.
        // Phase-4.1: per-number cap on AI draft generation. incomingSMS
        // has no other rate limit, and generateAIDraft calls Anthropic
        // directly (outside the claudeProxy token budget), so a chatty or
        // abusive number could otherwise drive unbounded Claude cost +
        // Firestore writes. 12 drafts/number/hour is generous for a real
        // back-and-forth, tight against a flood. On overflow we skip ONLY
        // the draft — the inbound SMS is still saved + the rep notified.
        let aiDraftAllowed = true;
        try {
          await enforceRateLimit('aiDraft:phone', phoneDigits || fromPhone, 12, 60 * 60_000);
        } catch (e) {
          if (e.rateLimited) {
            aiDraftAllowed = false;
            logger.info('[incomingSMS] AI draft skipped — per-number hourly cap', { leadId });
          }
          // Non-rate-limit error (limiter unavailable): fall through and
          // attempt the draft rather than dropping a legit reply.
        }
        if (aiDraftAllowed) {
          try {
            await generateAIDraft({
              db, leadId, lead,
              incomingBody:   messageBody,
              incomingNoteId: incomingNoteRef.id,
              incomingPhone:  fromPhone
            });
          } catch (e) {
            // Defensive belt-and-suspenders; the module already swallows
            // its own errors but a missing import or a thrown sync error
            // shouldn't take down the webhook.
            logger.warn('[incomingSMS] generateAIDraft threw unexpectedly', { err: e && e.message });
          }
        }

        // Notify the assigned rep, falling back to the lead's OWNER
        // (userId). No lead-write path sets `assignedTo`, so without this
        // fallback the inbound-SMS push was dead for every lead — the rep
        // never got told a customer texted back. userId is present on
        // every matched lead (the phoneDigits match queries by it).
        const notifyUid = lead.assignedTo || lead.userId;
        if (notifyUid) {
          // Get rep's FCM token
          const repTokensSnap = await db
            .collection('users')
            .doc(notifyUid)
            .collection('fcmTokens')
            .limit(1)
            .get();

          if (!repTokensSnap.empty) {
            const tokenDoc = repTokensSnap.docs[0];
            const token = tokenDoc.data().token;

            try {
              await getMessaging().send({
                token,
                notification: {
                  title: `New Message from ${lead.firstName || 'Customer'}`,
                  body: messageBody.substring(0, 100)
                },
                data: {
                  leadId,
                  type: 'incoming_sms',
                  from: fromPhone
                }
              });
            } catch (e) {
              logger.warn('push_notification_failed', { err: e.message });
            }
          }
        }
      } else {
        // Phone number not found (or cross-tenant ambiguous) — log for admin
        // review. The ambiguity fields let the triage inbox show WHY a text
        // that clearly matched leads still landed here.
        const unmatchedRow = {
          from: fromPhone,
          body: messageBody,
          twilioSid: messageSid,
          receivedAt: FieldValue.serverTimestamp()
        };
        if (route.ambiguity) {
          unmatchedRow.ambiguous = true;
          unmatchedRow.ambiguity = route.ambiguity;
          unmatchedRow.candidateLeadIds = candidates.map(c => c.id);
          unmatchedRow.candidateCompanyIds = [...new Set(
            candidates.map(c => c.companyId || c.userId).filter(Boolean))];
        }
        await db.collection('unmatched_sms').add(unmatchedRow);
      }

      // Log SMS. When routed, stamp the lead's uid + companyId — the Comm Log
      // contract ({leadId, uid, date}) and its composite index key on uid, so
      // the old `uid: null` rows were invisible to the per-lead
      // Communication Log reader. companyId falls back to userId (solo-tenant
      // convention).
      await logSMSToFirestore(
        db, fromPhone, messageBody,
        lead ? (lead.userId || null) : null,
        leadId, 'received', messageSid,
        lead ? (lead.companyId || lead.userId || null) : null);

      // Return TwiML response (empty OK)
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
</Response>`);

    } catch (e) {
      logger.error('incomingSMS error', { err: e.message });
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  }
);

logger.info('sms_functions_loaded');

// ═══════════════════════════════════════════════════════════════
// STORM ALERT SMS — Scheduled weather check
// ═══════════════════════════════════════════════════════════════

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler

/**
 * checkStormAlerts — Scheduled function (every 30 minutes)
 * Polls NWS weather alerts for subscriber zip codes
 * Sends SMS when severe weather is detected
 *
 * Setup: firebase deploy --only functions
 * Requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER secrets
 */
exports.checkStormAlerts = onSchedule(
  {
    schedule: 'every 30 minutes',
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: '256MiB'
  },
  async (event) => {
    const db = getFirestore();

    try {
      // Get all active subscribers
      const subsSnap = await db.collection('storm_alert_subscribers')
        .where('active', '==', true)
        .get();

      if (subsSnap.empty) {
        logger.info('storm_alerts_no_subscribers');
        return;
      }

      // Group subscribers by zip
      const byZip = {};
      subsSnap.docs.forEach(doc => {
        const data = doc.data();
        if (!byZip[data.zip]) byZip[data.zip] = [];
        byZip[data.zip].push({ id: doc.id, ...data });
      });

      const uniqueZips = Object.keys(byZip);
      logger.info('storm_alerts_scan_start', { zips: uniqueZips.length, subscribers: subsSnap.size });

      const alertUrl = 'https://api.weather.gov/alerts/active?area=OH,KY&severity=Severe,Extreme';
      const alertResp = await fetch(alertUrl, {
        headers: { 'User-Agent': 'NBDHomeStormAlerts/1.0 (jd@nobigdealwithjoedeal.com)' }
      });
      if (!alertResp.ok) { logger.error('NWS API error', { status: alertResp.status }); return; }

      const alertData = await alertResp.json();
      const features = alertData.features || [];

      const stormKeywords = ['hail', 'tornado', 'severe thunderstorm', 'wind'];
      const relevantAlerts = features.filter(f => {
        const event = (f.properties?.event || '').toLowerCase();
        const desc = (f.properties?.description || '').toLowerCase();
        return stormKeywords.some(k => event.includes(k) || desc.includes(k));
      });
      if (relevantAlerts.length === 0) { logger.info('storm_alerts_none'); return; }

      // Load zip → county/city mapping (static, packaged with the function).
      // Falls back to empty map if the file is missing, in which case we
      // REFUSE to send rather than blasting every subscriber (the old bug).
      let zipToAreas = {};
      try {
        zipToAreas = require('./data/zip-to-county.json');
      } catch (e) {
        logger.error('zip-to-county mapping missing — refusing to fan out');
        return;
      }

      // Dedup by (alertId, subscriberId).
      const alreadySent = new Set();
      const recentSent = await db.collection('storm_alerts_sent')
        .where('sentAt', '>', new Date(Date.now() - 48 * 60 * 60 * 1000))
        .get();
      // Count how many SMS already went out today (UTC) so a multi-day storm
      // can't blow past the daily budget across many 30-min runs.
      const startOfTodayMs = new Date().setUTCHours(0, 0, 0, 0);
      let sentToday = 0;
      recentSent.docs.forEach(d => {
        const r = d.data();
        if (r.alertId && r.subscriberId) alreadySent.add(`${r.alertId}::${r.subscriberId}`);
        const ms = r.sentAt && typeof r.sentAt.toMillis === 'function' ? r.sentAt.toMillis() : 0;
        if (ms >= startOfTodayMs) sentToday++;
      });

      const client = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
      const fromPhone = TWILIO_PHONE_NUMBER.value();
      // 2.3: hard ceiling on SMS per run. A large multi-county Severe/
      // Extreme event × many subscribers could otherwise blast thousands of
      // Twilio messages (and dollars) from a single tick. When the cap
      // trips we stop and log loudly; remaining subscribers are picked up
      // on the next 30-min tick (the (alertId,subscriberId) dedup prevents
      // anyone being messaged twice for the same alert). Override via env.
      const MAX_SMS_PER_RUN = Number(process.env.STORM_MAX_SMS_PER_RUN) || 250;
      // Daily ceiling across all runs (defends a multi-day storm event). Set
      // STORM_MAX_SMS_PER_DAY=0 to halt storm SMS entirely (kill-switch).
      const MAX_SMS_PER_DAY = Number(process.env.STORM_MAX_SMS_PER_DAY) || 2000;
      let totalSent = 0;
      let capHit = false;
      let capScope = null;

      // Helper: does subscriber's zip fall inside this alert's areaDesc?
      function zipMatchesArea(zip, areaDescLower) {
        const areas = zipToAreas[zip];
        if (!Array.isArray(areas) || areas.length === 0) return false;
        return areas.some(name => areaDescLower.includes(String(name).toLowerCase()));
      }

      // Respect Twilio 1-per-second per-number pacing.
      async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

      fanout:
      for (const alert of relevantAlerts) {
        const alertId = alert.properties?.id || alert.id;
        if (!alertId) continue;

        const event = alert.properties?.event || 'Severe Weather';
        const headline = alert.properties?.headline || '';
        const areasLower = (alert.properties?.areaDesc || '').toLowerCase();
        if (!areasLower) continue;

        for (const zip of uniqueZips) {
          if (!zipMatchesArea(zip, areasLower)) continue; // <-- the real fix
          for (const sub of byZip[zip]) {
            if (totalSent >= MAX_SMS_PER_RUN) { capHit = true; capScope = 'run'; break fanout; }
            if (sentToday + totalSent >= MAX_SMS_PER_DAY) { capHit = true; capScope = 'day'; break fanout; }
            const dedupKey = `${alertId}::${sub.id}`;
            if (alreadySent.has(dedupKey)) continue;

            const phone = formatPhoneNumber(sub.phone);
            if (!phone) continue;

            const body = `⛈️ NBD Storm Alert: ${event} reported near ${zip}. ${String(headline).substring(0, 120)} — Free roof inspection: nobigdealwithjoedeal.com or call Joe (859) 420-7382. Reply STOP to unsubscribe.`;

            try {
              await client.messages.create({
                body: body.substring(0, 1600),
                from: fromPhone,
                to: phone,
              });
              totalSent++;
              alreadySent.add(dedupKey);

              await db.collection('storm_alerts_sent').add({
                alertId,
                subscriberId: sub.id,
                event,
                headline,
                areas: areasLower,
                zip,
                sentAt: FieldValue.serverTimestamp(),
              });
            } catch (e) {
              logger.warn('storm_alert_sms_failed', { sub: sub.id, err: e.message });
              if (e.code === 21211 || e.code === 21614) {
                await db.doc(`storm_alert_subscribers/${sub.id}`).update({ active: false });
              }
            }

            // Twilio default per-number cap is 1 msg/sec.
            await sleep(1100);
          }
        }
      }

      if (capHit) {
        logger.warn('storm_alerts_cap_hit', {
          scope: capScope, totalSent, sentToday,
          cap: capScope === 'day' ? MAX_SMS_PER_DAY : MAX_SMS_PER_RUN,
        });
      }
      logger.info('storm_alerts_complete', { totalSent, sentToday, capHit, capScope });

    } catch (e) {
      logger.error('checkStormAlerts error', { err: e.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// T-2: AI DRAFT SEND-ON-APPROVE — Firestore trigger
// ═══════════════════════════════════════════════════════════════
//
// Closes the AI-texting loop. The incomingSMS webhook writes an AI
// reply draft to /leads/{leadId}/ai_drafts/{draftId} with
// status:'pending' (see generateAIDraft in handlers/ai-texting.js).
// The rep reviews it in the customer-page panel
// (docs/pro/js/customer-ai-drafts-panel.js) and either:
//   - edits the text + taps "Approve & Send" → rules-constrained
//     client update sets status:'approved' (+ optional edited
//     draftText). THIS trigger then sends it through the Twilio
//     business line — the SAME number the homeowner texted — so the
//     thread stays coherent on the customer's phone.
//   - taps "Dismiss" → status:'dismissed' (this trigger ignores it).
//
// Why a server trigger instead of a client → sendSMS call: the
// outbound MUST originate from the Twilio number, not the rep's
// personal handset, and the rep's browser has no Twilio creds / can't
// satisfy sendSMS's App Check. The trigger runs with admin privileges
// and the Twilio secrets already in this module. The client only
// touches Firestore (rules-governed), never Twilio.
//
// Idempotency: keyed on the pending→approved transition. A re-fire
// (or a later status edit) is ignored because `before.status` is no
// longer pending. Terminal states are 'sent' / 'failed'.
// Producer: when a homeowner sends an inbound portal message, draft a reply
// into leads/{id}/ai_drafts (triggerType 'portal_message_in') so it flows
// through the same rep approve/edit/send loop as inbound SMS — persona voice,
// approval gate, audit. generateAIDraft self-gates (no-ops when the Anthropic
// secret is unset or persona/opt-out gates decline), so this is safe to deploy
// dark. Fires only on source:'homeowner' — never on our own rep replies.
exports.onPortalMessageDraft = onDocumentCreated(
  {
    document: 'leads/{leadId}/portal_messages/{msgId}',
    secrets: [AI_ANTHROPIC_KEY],
    memory: '256MiB',
    timeoutSeconds: 30,
    maxInstances: 10,
  },
  async (event) => {
    const msg = event.data && event.data.data();
    if (!msg || msg.source !== 'homeowner') return;
    const text = String(msg.text || '').trim();
    if (!text) return;
    const { leadId, msgId } = event.params;
    // No feature_flags/global check here — generateAIDraft() (below) gates
    // itself on aiDraftDisabled, same switch that covers incomingSMS and
    // convertUnmatchedSms (SPEND_KILLSWITCH.md). One flag, one place, so no
    // caller can ship ungated.
    const db = getFirestore();
    try {
      const leadSnap = await db.doc('leads/' + leadId).get();
      if (!leadSnap.exists) return;
      await generateAIDraft({
        db, leadId, lead: leadSnap.data() || {},
        incomingBody: text,
        incomingNoteId: msgId,
        triggerType: 'portal_message_in',
      });
    } catch (e) {
      logger.warn('[onPortalMessageDraft] draft generation threw', { leadId, err: e && e.message });
    }
  }
);

exports.onAiDraftApproved = onDocumentUpdated(
  {
    document: 'leads/{leadId}/ai_drafts/{draftId}',
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER],
    maxInstances: 10,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (event) => {
    const before = event.data?.before?.data();
    const after  = event.data?.after?.data();
    if (!before || !after) return;

    // Only act on the first pending→approved flip. Any other write
    // (dismiss, the trigger's own status:'sent' update, an edit after
    // send) is a no-op so we never double-send.
    if (before.status === 'approved') return;
    if (after.status !== 'approved') return;

    const { leadId, draftId } = event.params;
    const db = getFirestore();
    const draftRef = db.doc(`leads/${leadId}/ai_drafts/${draftId}`);

    const fail = (reason, detail) => draftRef.update({
      status: 'failed',
      failureReason: reason,
      ...(detail ? { failureDetail: String(detail).slice(0, 200) } : {}),
      sentAt: FieldValue.serverTimestamp(),
    }).catch((e) => logger.warn('[ai-draft-send] fail-mark write failed', { leadId, draftId, err: e.message }));

    // ── Channel fork ──────────────────────────────────────────────────────
    // A portal-sourced draft is a homeowner reply that belongs in the portal
    // thread, NOT an SMS. Handle it here and return; EVERYTHING BELOW (phone
    // validation, TCPA opt-out, Twilio send) is the SMS path and stays
    // byte-identical for the default inbound_sms draft. Portal replies also
    // sidestep the Twilio A2P block entirely.
    if (isPortalDraft(after)) {
      const text = clampPortalText(after.draftText, 2000);
      if (!text) { await fail('empty_body'); return; }
      let portalMsgId = null;
      try {
        // Mirror replyToPortalMessage's rep-reply write (portal.js).
        const msgRef = await db.collection(`leads/${leadId}/portal_messages`).add({
          leadId,
          ownerUid: after.userId || null,
          companyId: after.companyId || after.userId || null,
          source: 'rep',
          text,
          aiDraftId: draftId,
          createdAt: FieldValue.serverTimestamp(),
          readBySender: true,
          readByRecipient: false,
        });
        portalMsgId = msgRef.id;
        await draftRef.update({ status: 'sent', sentChannel: 'portal', sentAt: FieldValue.serverTimestamp() });
        logger.info('[ai-draft-send] portal reply posted', { leadId, draftId });
      } catch (e) {
        await fail('portal_send_error', e && e.message);
        return;
      }
      // ...and the rest of what a rep reply does (mark-read, lead bump,
      // timeline entry) — shared with replyToPortalMessage so the AI path
      // can't silently do less than the human one. Deliberately OUTSIDE the
      // try above and .catch()-guarded: the reply is already delivered and the
      // draft already says 'sent', so nothing here may flip it to failed and
      // tell the rep a send broke that the homeowner has already received.
      await applyRepReplyEffects({
        db, FieldValue, leadId,
        ownerUid: after.userId || null,
        companyId: after.companyId || after.userId || null,
        messageId: portalMsgId,
        textPreview: text,
        logger,
      }).catch((e) => logger.warn('[ai-draft-send] portal reply side effects failed', { leadId, draftId, err: e && e.message }));
      return;
    }

    const to   = after.customerPhone || after.incomingPhone || null;
    const body = String(after.draftText || '').trim();

    if (!body) { await fail('empty_body'); return; }
    if (body.length > 1600) { await fail('too_long'); return; }
    if (!to || !isValidPhoneNumber(to)) { await fail('invalid_phone'); return; }

    // TCPA: never message a number that replied STOP. incomingSMS
    // records opt-outs at sms_opt_outs/{digits}; honor them here too.
    try {
      const optOut = await OptOut.isOptedOut(db, to);
      if (optOut.optedOut) {
        if (optOut.viaLegacyKey) {
          logger.info('optout.legacy_key_hit', { fn: 'onAiDraftApproved', key: optOut.key });
        }
        await fail('opted_out'); return;
      }
    } catch (e) {
      // Fail CLOSED on the AI-draft path: if the opt-out lookup errors we must
      // NOT let an auto-generated reply reach a possibly-STOP'd number (TCPA).
      // The draft stays unsent and the rep can retry. (Was fail-open — sent
      // anyway — unlike sendSMS/sendD2DSMS which fail closed.)
      await fail('optout_check_error', e && e.message); return;
    }

    try {
      const client = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
      const formattedTo = formatPhoneNumber(to);
      const fromPhone = TWILIO_PHONE_NUMBER.value();
      if (!formattedTo) { await fail('unformattable_phone'); return; }

      const message = await client.messages.create({ body, from: fromPhone, to: formattedTo });

      // Mirror the incomingSMS inbound-note shape so the rep's thread
      // view AND the next AI draft's context (buildLeadContext reads
      // notes where type=='sms') see this outbound reply.
      await db.collection('leads').doc(leadId).collection('notes').add({
        type: 'sms',
        direction: 'outgoing',
        to,
        body,
        twilioSid: message.sid,
        source: 'ai_draft',
        draftId,
        sentBy: after.approvedBy || after.userId || null,
        createdAt: FieldValue.serverTimestamp(),
      });

      // companyId (the draft's tenant, same fallback as the portal branch
      // above): the offline outbox's per-tenant activity check must see an
      // approved AI reply as a competing text.
      await logSMSToFirestore(db, to, body, after.approvedBy || after.userId || null, leadId, 'sent', message.sid,
        after.companyId || after.userId || null);

      await draftRef.update({
        status: 'sent',
        twilioSid: message.sid,
        sentAt: FieldValue.serverTimestamp(),
      });

      // Keep the lead's recency signal fresh, same as incomingSMS.
      await db.doc(`leads/${leadId}`).update({
        lastContactedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});

      logger.info('[ai-draft-send] sent', { leadId, draftId, sid: message.sid });
    } catch (e) {
      logger.error('[ai-draft-send] twilio send failed', { leadId, draftId, err: e.message });
      await fail('twilio_error', e.message);
    }
  }
);
