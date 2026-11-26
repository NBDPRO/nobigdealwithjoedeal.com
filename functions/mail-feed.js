'use strict';
/**
 * mail-feed.js — mailFeed (2026-11-25, roadmap step 17 part A; audit
 * documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §4 "server
 * mail feed").
 *
 * WHY: the office sweep read Gmail through a connector and the combined iCloud
 * inbox (jd@ + info@) by driving a signed-in Chrome, so jd@ / info@ were never
 * processed while Chrome was closed. This is the READ-ONLY server half: every
 * 15 minutes it copies a small, redacted record of each new inbox message into
 * Firestore. The office planner that classifies and drafts from it is a later
 * PR; nothing here sends, drafts, labels, moves or marks anything.
 *
 * STRICTLY READ-ONLY (Joe: "leave the mailbox exactly as found"):
 *   iCloud  IMAP over TLS (imap.mail.me.com:993) with an app-specific password.
 *           The client is wrapped in readOnlyImap(): only READ_ONLY_IMAP_METHODS
 *           exist on it, INBOX is opened with { readOnly: true } (EXAMINE, so
 *           the server cannot set \Seen) and refused if the server reports it
 *           read-write; bodies come through imapflow's download(), which uses
 *           BODY.PEEK. Never STORE / MOVE / EXPUNGE / APPEND.
 *   Gmail   REST, GET only, with an OAuth refresh token minted for the
 *           gmail.readonly scope alone; a token carrying any other scope is
 *           refused before the first request.
 *
 * STORED (admin SDK only; firestore.rules denies every client):
 *   mail_feed/{companyId}/messages/{sha256(source|messageId)} =
 *     { source, to, fromName, fromDomain, fromHash, subject, snippet,
 *       receivedAt, receivedAtMs, unread, labels | mailbox, threadKey, fetchedAtMs }
 *   The sender's full address is kept only as sha256 (fromHash). That hash is
 *   for matching a sender to a lead server-side, NOT anonymisation: anyone who
 *   can read the feed and holds a candidate address can recompute it.
 *   Subject, sender name and snippet are masked (maskMail: emails, phones incl.
 *   7-digit local numbers, links reduced to their host, one-time codes); a
 *   security email (sign-in / reset / verification) keeps no body text. Subject
 *   and sender name have every angle bracket neutralised (ai-fence.js) and the
 *   snippet (~500 chars) is fenced as untrusted email data, so no stored free
 *   text can close or forge a fence in a later prompt.
 *   `to` is which configured inbox (MAIL_FEED_INBOXES) the To / Cc line names,
 *   else null. Same message twice = one doc (create(), ALREADY_EXISTS skipped).
 *   Docs older than 30 days are deleted every run, in batches, including runs
 *   where the feed is off or unconfigured (nothing is read then).
 *   mail_feed_state/{companyId} = per-source cursor: the first run reads the
 *   last 3 days, later runs read from the last successful run (10 min overlap;
 *   a capped run resumes exactly at its last stored message, and one that
 *   cannot advance soft-fails).
 *
 * Tenant: the platform owner (NBD_OWNER_UID from tenant-ops-logic.js).
 *
 * Gate: MAIL_FEED_ENABLED=true AND at least one source's secrets set (not the
 * deploy's __unset__ stub); otherwise no mailbox is touched: the 30-day
 * retention still runs and one log line is written. A source
 * whose sign-in or read fails calls softFail(): the cron ledger marks the run
 * failed and cronDeadman alerts. No secret value is ever logged.
 *
 * Setup / on / off: documentation/runbooks/MAIL-FEED-SETUP.md.
 */
const crypto = require('crypto');
const { onSchedule, softFail, redactText } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { fence, neutralise } = require('./ai-fence');
const { NBD_OWNER_UID } = require('./tenant-ops-logic');

const ICLOUD_IMAP_USER = defineSecret('ICLOUD_IMAP_USER');
const ICLOUD_IMAP_APP_PASSWORD = defineSecret('ICLOUD_IMAP_APP_PASSWORD');
const GMAIL_OAUTH_CLIENT_ID = defineSecret('GMAIL_OAUTH_CLIENT_ID');
const GMAIL_OAUTH_CLIENT_SECRET = defineSecret('GMAIL_OAUTH_CLIENT_SECRET');
const GMAIL_OAUTH_REFRESH_TOKEN = defineSecret('GMAIL_OAUTH_REFRESH_TOKEN');
const SECRET_NAMES = ['ICLOUD_IMAP_USER', 'ICLOUD_IMAP_APP_PASSWORD', 'GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET', 'GMAIL_OAUTH_REFRESH_TOKEN'];

const MIN = 60000;
const DAY = 24 * 60 * MIN;
const FIRST_RUN_LOOKBACK_MS = 3 * DAY;
const OVERLAP_MS = 10 * MIN;
const RETENTION_MS = 30 * DAY;
const PER_RUN = 150;          // messages stored per source per run (oldest first)
const LIST_CEILING = 1000;    // iCloud uids looked at per run (search is oldest first)
const GMAIL_LIST_CEILING = 5000; // Gmail ids listed per run (the list is newest first, so it pages to the oldest)
const BODY_MAX_BYTES = 16384;
const SNIPPET_CHARS = 500;
const RETENTION_BATCH = 400;
const RETENTION_ROUNDS = 10;

const IMAP_HOST = 'imap.mail.me.com';
const IMAP_PORT = 993;
const MAILBOX = 'INBOX';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/';

/** The only IMAP client methods the feed may call. No write command is here. */
const READ_ONLY_IMAP_METHODS = Object.freeze(['connect', 'mailboxOpen', 'search', 'fetch', 'download', 'logout', 'close']);

const gateOn = (env) => !!env && env.MAIL_FEED_ENABLED === 'true';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/** A secret's value, or '' when unset / blank / the deploy stub. */
function secretText(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s !== '__unset__' ? s : '';
}

function parseInboxes(raw) {
  return String(raw || '').split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
}

const ADDR_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Every address in a header value or an imapflow address list. */
function addressesOf(v) {
  if (Array.isArray(v)) return v.flatMap((a) => (a && typeof a === 'object' ? [String(a.address || '')] : addressesOf(a))).map((x) => x.trim().toLowerCase()).filter(Boolean);
  return (String(v || '').match(ADDR_RE) || []).map((a) => a.toLowerCase());
}

/** Which configured inbox the To line (then Cc) names; null when none does. */
function detectInbox(to, cc, inboxes) {
  const set = new Set(inboxes || []);
  if (!set.size) return null;
  for (const a of addressesOf(to).concat(addressesOf(cc))) if (set.has(a)) return a;
  return null;
}

/** "Name <a@b>" / bare address → { name, address }. */
function parseFrom(v) {
  if (Array.isArray(v)) {
    const a = v[0] || {};
    return { name: String(a.name || '').trim(), address: String(a.address || '').trim().toLowerCase() };
  }
  const s = String(v || '').trim();
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (m) return { name: m[1].trim(), address: m[2].trim().toLowerCase() };
  const addr = (s.match(ADDR_RE) || [''])[0].toLowerCase();
  return { name: '', address: addr };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => { const c = Number(n); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]+);/gi, (m, n) => { const c = parseInt(n, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&amp;/gi, '&');
}

function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '));
}

const URL_RE = /\b(?:https?:\/\/|www\.)([^\s/?#<>"')\]]+)[^\s<>"')\]]*/gi;
const CODE_WORD = '(?:code|passcode|password|otp|pin|verification|verify|one[- ]time|2fa|token)';
const CODE_AFTER_RE = new RegExp('(\\b' + CODE_WORD + '\\b[^0-9\\n]{0,40}?)\\b[A-Z0-9]*\\d[A-Z0-9]{3,9}\\b', 'gi');
const CODE_BEFORE_RE = new RegExp('\\b\\d{4,8}\\b(?=[^0-9\\n]{0,30}?\\b(?:is your|' + CODE_WORD + '|to sign in|to log in|to verify)\\b)', 'gi');
const SECURITY_RE = /\b(?:verification code|verify your|security code|sign[- ]?in code|log[- ]?in code|one[- ]time (?:code|pass(?:code|word)?)|passcode|password reset|reset your password|reset password|magic link|two[- ]factor|2fa|confirm your (?:email|account))\b|\b(?:otp)\b/i;

/**
 * Mail-feed masking (feed-local; heartbeat's redactText is left as it is for
 * its other callers): links → [link:host] (paths and query strings can carry
 * reset tokens), then redactText (emails, 10-15 digit phones, token values),
 * then 7-digit local numbers and one-time codes next to a code word.
 */
function maskMail(text) {
  return redactText(String(text == null ? '' : text).replace(URL_RE, (m, host) => '[link:' + String(host).toLowerCase().slice(0, 80) + ']'))
    .replace(/(?<![\d-])\d{3}[-.\s]\d{4}(?![\d-])/g, '[phone]')
    .replace(CODE_AFTER_RE, '$1[code]')
    .replace(CODE_BEFORE_RE, '[code]');
}

/** A sign-in / reset / verification email: its body is not kept at all. */
function isSecurityMail(subject, text) {
  return SECURITY_RE.test(String(subject || '')) || SECURITY_RE.test(String(text || '').slice(0, SNIPPET_CHARS));
}

/** Masked, fenced ~500-char snippet. Masked BEFORE the cut so half a number never survives. */
function snippetOf(text, subject) {
  if (isSecurityMail(subject, text)) return fence('email', '[security email: body not kept]');
  const flat = decodeEntities(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS * 4);
  return fence('email', maskMail(flat).slice(0, SNIPPET_CHARS).trim());
}

function normMessageId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '').trim();
}

/** One stored doc from a normalised message. */
function buildDoc(source, m, inboxes, nowMs) {
  const from = parseFrom(m.from);
  const domain = from.address.includes('@') ? from.address.split('@').pop() : '';
  const doc = {
    source,
    to: detectInbox(m.to, m.cc, inboxes),
    fromName: neutralise(maskMail(from.name)).slice(0, 120),
    fromDomain: domain.slice(0, 120),
    fromHash: from.address ? sha256(from.address) : null,
    subject: neutralise(maskMail(String(m.subject || '').replace(/\s+/g, ' ').trim())).slice(0, 300),
    snippet: snippetOf(m.text, m.subject),
    receivedAt: new Date(m.receivedAtMs),
    receivedAtMs: m.receivedAtMs,
    unread: !!m.unread,
    threadKey: sha256(source + '|thread|' + (m.threadRoot || m.messageId || m.fallbackId)).slice(0, 32),
    fetchedAtMs: nowMs,
  };
  if (source === 'gmail') doc.labels = (m.labels || []).slice(0, 30);
  else doc.mailbox = m.mailbox || MAILBOX;
  return doc;
}

function docIdFor(source, m) {
  return sha256(source + '|' + (normMessageId(m.messageId) || m.fallbackId));
}

/** An error message safe to log: no secret value, emails / phones masked, short. */
function safeError(source, err, secretValues) {
  const auth = !!(err && err.authenticationFailed);
  const code = auth ? 'auth' : String((err && (err.code || err.status)) || '');
  let msg = auth ? 'sign-in refused' : String((err && err.message) || err || 'failed');
  for (const v of secretValues || []) if (v && v.length >= 4) msg = msg.split(v).join('[secret]');
  return source + ': ' + (code && !msg.startsWith(code) ? code + ' ' : '') + redactText(msg).slice(0, 200);
}

// ── iCloud (IMAP) ───────────────────────────────────────────────────────

function imapOptions({ user, pass }) {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: true, auth: { user, pass },
    logger: false, disableAutoIdle: true,
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 60000,
  };
}

function makeImapClient(creds) {
  const { ImapFlow } = require('imapflow'); // lazy: only a configured, enabled run loads it
  const client = new ImapFlow(imapOptions(creds));
  // An unhandled 'error' event would crash the instance; the failing command still rejects.
  client.on('error', (e) => logger.warn('mail_feed_imap_socket_error', { code: String((e && e.code) || 'error').slice(0, 40) }));
  return client;
}

/**
 * The only face of the IMAP client the feed sees: the read-only methods, a
 * mailboxOpen that always asks for EXAMINE and refuses a read-write mailbox.
 */
function readOnlyImap(client) {
  const g = {};
  for (const name of READ_ONLY_IMAP_METHODS) {
    if (typeof client[name] !== 'function') continue;
    g[name] = (...args) => client[name](...args);
  }
  g.mailboxOpen = async (path, opts) => {
    if (opts && opts.readOnly === false) throw new Error('mail feed opens mailboxes read-only only');
    const box = await client.mailboxOpen(path, Object.assign({}, opts, { readOnly: true }));
    const info = box || client.mailbox;
    // EXAMINE was sent, so the server cannot set \Seen. Refuse only an explicit
    // [READ-WRITE]; a server that omits the response code leaves readOnly unset.
    if (!info || info.readOnly === false) throw new Error('mailbox opened read-write; refusing to read');
    return info;
  };
  return Object.freeze(g);
}

function textPartOf(node) {
  let html = null;
  const walk = (n) => {
    if (!n) return null;
    if (Array.isArray(n.childNodes) && n.childNodes.length) {
      for (const c of n.childNodes) { const r = walk(c); if (r) return r; }
      return null;
    }
    if (n.disposition === 'attachment') return null;
    if (n.type === 'text/plain') return { part: n.part || '1', html: false };
    if (n.type === 'text/html' && !html) html = { part: n.part || '1', html: true };
    return null;
  };
  return walk(node) || html;
}

async function readStream(stream, max) {
  const chunks = [];
  let n = 0;
  for await (const c of stream) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    chunks.push(b); n += b.length;
    if (n >= max) break;
  }
  return Buffer.concat(chunks).slice(0, max).toString('utf8');
}

function referencesRoot(headers) {
  const s = Buffer.isBuffer(headers) ? headers.toString('utf8') : String(headers || '');
  const m = /^references:\s*([\s\S]*?)(?:\r?\n(?![ \t])|$)/im.exec(s);
  const ids = m ? m[1].match(/<[^>]+>/g) : null;
  return ids && ids.length ? normMessageId(ids[0]) : '';
}

/** New INBOX messages since sinceMs, oldest first, at most PER_RUN. */
async function readIcloud({ creds, sinceMs, imapFactory, perRun }) {
  const cap = perRun || PER_RUN;
  const raw = (imapFactory || makeImapClient)(creds);
  const imap = readOnlyImap(raw);
  try {
    await imap.connect();
  } catch (e) {
    try { if (imap.close) imap.close(); } catch (_) { /* best effort */ }
    throw e;
  }
  try {
    await imap.mailboxOpen(MAILBOX, { readOnly: true });
    // SINCE is a calendar date (imapflow sends sinceMs's UTC date) that the server
    // compares with INTERNALDATE's date in ITS zone; a day early so a server behind
    // UTC cannot drop evening mail. The internalDate filter below trims the extra day.
    let uids = await imap.search({ since: new Date(sinceMs - DAY) }, { uid: true });
    uids = Array.isArray(uids) ? uids.slice(0, LIST_CEILING) : [];
    const metas = [];
    if (uids.length) {
      const query = { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true, headers: ['references'] };
      for await (const msg of imap.fetch(uids, query, { uid: true })) {
        const t = msg.internalDate ? new Date(msg.internalDate).getTime() : 0;
        if (t >= sinceMs) metas.push(msg);
      }
    }
    metas.sort((a, b) => new Date(a.internalDate) - new Date(b.internalDate));
    const capped = metas.length > cap;
    const out = [];
    for (const msg of metas.slice(0, cap)) {
      const env = msg.envelope || {};
      const part = textPartOf(msg.bodyStructure);
      let text = '';
      if (part) {
        const dl = await imap.download(msg.uid, part.part, { uid: true, maxBytes: BODY_MAX_BYTES });
        text = dl && dl.content ? await readStream(dl.content, BODY_MAX_BYTES) : '';
        if (part.html) text = htmlToText(text);
      }
      const flags = msg.flags instanceof Set ? msg.flags : new Set(msg.flags || []);
      out.push({
        messageId: env.messageId, fallbackId: 'uid:' + msg.uid,
        receivedAtMs: new Date(msg.internalDate).getTime(),
        from: env.from, to: env.to, cc: env.cc, subject: env.subject, text,
        unread: !flags.has('\\Seen'), mailbox: MAILBOX,
        threadRoot: referencesRoot(msg.headers) || normMessageId(env.inReplyTo) || normMessageId(env.messageId),
      });
    }
    return { items: out, capped };
  } finally {
    try { await imap.logout(); } catch (_) { /* best effort */ }
  }
}

// ── Gmail (REST, GET only) ──────────────────────────────────────────────

async function gmailAccessToken({ clientId, clientSecret, refreshToken }) {
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  const r = await client.getAccessToken();
  return { token: r && r.token, scope: r && r.res && r.res.data && r.res.data.scope };
}

function gmailBody(payload) {
  let html = '';
  const walk = (p) => {
    if (!p) return '';
    if (Array.isArray(p.parts) && p.parts.length) {
      for (const c of p.parts) { const r = walk(c); if (r) return r; }
      return '';
    }
    if (p.filename) return '';
    const data = p.body && p.body.data ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
    if (p.mimeType === 'text/plain' && data) return data;
    if (p.mimeType === 'text/html' && data && !html) html = data;
    return '';
  };
  return walk(payload) || (html ? htmlToText(html) : '');
}

async function readGmail({ creds, sinceMs, gmailToken, fetchImpl, perRun, listCeiling }) {
  const cap = perRun || PER_RUN;
  const ceiling = listCeiling || GMAIL_LIST_CEILING;
  const t = await (gmailToken || gmailAccessToken)(creds);
  if (!t || !t.token) throw new Error('no access token');
  const scopes = String(t.scope || GMAIL_SCOPE).split(/\s+/).filter(Boolean);
  if (scopes.some((s) => s !== GMAIL_SCOPE)) throw Object.assign(new Error('the token has more than read-only access; mint it with the gmail.readonly scope only'), { code: 'scope' });
  const get = async (url) => {
    const res = await (fetchImpl || fetch)(url, { method: 'GET', headers: { Authorization: 'Bearer ' + t.token }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw Object.assign(new Error('http ' + res.status), { code: 'http_' + res.status });
    return res.json();
  };
  const ids = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ q: 'in:inbox after:' + Math.floor(sinceMs / 1000), maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await get(GMAIL_API + 'messages?' + q.toString());
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < ceiling);
  // The list is newest first. Past the ceiling the OLDEST ids were never listed,
  // and the cursor would move past them: report it (truncated → softFail).
  const truncated = !!pageToken || ids.length > ceiling;
  const ordered = ids.slice(0, ceiling).reverse();
  const capped = ordered.length > cap || truncated;
  const out = [];
  for (const id of ordered.slice(0, cap)) {
    const m = await get(GMAIL_API + 'messages/' + encodeURIComponent(id) + '?format=full');
    const h = {};
    for (const x of (m.payload && m.payload.headers) || []) h[String(x.name).toLowerCase()] = x.value;
    const receivedAtMs = Number(m.internalDate) || 0;
    if (receivedAtMs < sinceMs) continue;
    const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
    out.push({
      messageId: h['message-id'], fallbackId: 'gmail-id:' + m.id, receivedAtMs,
      from: h.from, to: h.to, cc: h.cc, subject: h.subject,
      text: gmailBody(m.payload) || decodeEntities(m.snippet),
      unread: labels.includes('UNREAD'), labels, threadRoot: 'gmail-thread:' + m.threadId,
    });
  }
  out.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
  return { items: out, capped, truncated };
}

// ── the run ─────────────────────────────────────────────────────────────

async function storeAll(db, companyId, source, items, inboxes, nowMs) {
  const col = db.collection('mail_feed/' + companyId + '/messages');
  let stored = 0, skipped = 0;
  for (const m of items) {
    try {
      await col.doc(docIdFor(source, m)).create(buildDoc(source, m, inboxes, nowMs));
      stored++;
    } catch (e) {
      if (e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(String(e.message)))) skipped++;
      else throw e;
    }
  }
  return { stored, skipped };
}

async function deleteOlder(db, companyId, cutoffMs, batchSize) {
  const col = db.collection('mail_feed/' + companyId + '/messages');
  let deleted = 0;
  for (let round = 0; round < RETENTION_ROUNDS; round++) {
    const snap = await col.where('receivedAtMs', '<', cutoffMs).limit(batchSize).get();
    if (snap.empty) break;
    const b = db.batch();
    snap.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
    deleted += snap.size;
    if (snap.size < batchSize) break;
  }
  return deleted;
}

/**
 * One feed pass. Every dependency is injected (tests run it with fakes):
 * { db, nowMs, enabled, inboxes, secrets, log, companyId?, imapFactory?,
 *   gmailToken?, fetchImpl?, softFail?, retentionBatch?, perRun?, listCeiling? }
 */
async function runMailFeed(d) {
  const log = d.log || logger;
  const s = {};
  for (const n of SECRET_NAMES) s[n] = secretText(d.secrets && d.secrets[n]);
  const secretValues = Object.values(s).filter(Boolean);
  const icloud = s.ICLOUD_IMAP_USER && s.ICLOUD_IMAP_APP_PASSWORD ? { user: s.ICLOUD_IMAP_USER, pass: s.ICLOUD_IMAP_APP_PASSWORD } : null;
  const gmail = s.GMAIL_OAUTH_CLIENT_ID && s.GMAIL_OAUTH_CLIENT_SECRET && s.GMAIL_OAUTH_REFRESH_TOKEN
    ? { clientId: s.GMAIL_OAUTH_CLIENT_ID, clientSecret: s.GMAIL_OAUTH_CLIENT_SECRET, refreshToken: s.GMAIL_OAUTH_REFRESH_TOKEN } : null;
  const db = d.db;
  const nowMs = d.nowMs;
  const companyId = d.companyId || NBD_OWNER_UID;
  const floorMs = nowMs - RETENTION_MS;
  const retention = async () => {
    try { return { deleted: await deleteOlder(db, companyId, floorMs, d.retentionBatch || RETENTION_BATCH), error: null }; } catch (e) {
      const msg = safeError('retention', e, secretValues);
      log.warn('mail_feed_retention_failed', { error: msg });
      return { deleted: 0, error: msg };
    }
  };
  if (!d.enabled || (!icloud && !gmail)) {
    // Off: no mailbox is touched, but stored copies still age out at 30 days.
    const reason = !d.enabled ? 'disabled' : 'unconfigured';
    const r = db ? await retention() : { deleted: 0, error: null };
    log.info('mail_feed_off', { reason: !d.enabled ? 'MAIL_FEED_ENABLED is not "true"' : 'no mail secrets set', deleted: r.deleted });
    if (r.error) (d.softFail || softFail)(new Error(r.error));
    return { ran: false, reason, deleted: r.deleted };
  }

  const inboxes = parseInboxes(d.inboxes);
  const stateRef = db.doc('mail_feed_state/' + companyId);
  const stateSnap = await stateRef.get();
  const state = (stateSnap.exists && stateSnap.data()) || {};
  const prev = state.sources || {};
  const result = { ran: true, sources: {}, deleted: 0 };
  const nextSources = {};
  const failures = [];

  const plan = [];
  if (icloud) plan.push(['icloud', (sinceMs) => readIcloud({ creds: icloud, sinceMs, imapFactory: d.imapFactory, perRun: d.perRun })]);
  if (gmail) plan.push(['gmail', (sinceMs) => readGmail({ creds: gmail, sinceMs, gmailToken: d.gmailToken, fetchImpl: d.fetchImpl, perRun: d.perRun, listCeiling: d.listCeiling })]);

  for (const [source, read] of plan) {
    const p = prev[source] || {};
    // A capped cursor sits on the last message it stored: resume exactly there
    // (create() skips the ties), so a burst inside the overlap cannot stall it.
    const sinceMs = p.cursorMs ? Math.max(p.cursorMs - (p.capped ? 0 : OVERLAP_MS), floorMs) : nowMs - FIRST_RUN_LOOKBACK_MS;
    try {
      const { items, capped, truncated } = await read(sinceMs);
      const r = await storeAll(db, companyId, source, items, inboxes, nowMs);
      const cursorMs = capped && items.length ? items[items.length - 1].receivedAtMs : nowMs;
      nextSources[source] = { cursorMs, capped: !!(capped && items.length), lastOkAtMs: nowMs, lastCount: items.length, lastError: null };
      result.sources[source] = { read: items.length, stored: r.stored, skipped: r.skipped, capped: !!capped };
      if (capped && items.length && r.stored === 0) {
        const msg = source + ': capped run stored nothing new (more than ' + items.length + ' messages share one arrival time); the cursor cannot advance';
        failures.push(msg);
        log.warn('mail_feed_source_stuck', { source, read: items.length });
      }
      if (truncated) {
        const msg = source + ': more inbox messages since the cursor than one run can list; the oldest were skipped';
        failures.push(msg);
        log.warn('mail_feed_source_truncated', { source });
      }
    } catch (e) {
      const msg = safeError(source, e, secretValues);
      failures.push(msg);
      nextSources[source] = { lastErrorAtMs: nowMs, lastError: msg };
      result.sources[source] = { error: msg };
      log.warn('mail_feed_source_failed', { source, error: msg });
    }
  }

  const ret = await retention();
  result.deleted = ret.deleted;
  if (ret.error) failures.push(ret.error);

  await stateRef.set({ sources: nextSources, lastRunAtMs: nowMs }, { merge: true });
  if (failures.length) (d.softFail || softFail)(new Error(failures.join('; ')));
  log.info('mail_feed_run', result);
  return result;
}

exports.mailFeed = onSchedule(
  {
    schedule: 'every 15 minutes', timeZone: 'America/New_York', timeoutSeconds: 240, memory: '256MiB', maxInstances: 1,
    secrets: [ICLOUD_IMAP_USER, ICLOUD_IMAP_APP_PASSWORD, GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN],
  },
  async () => {
    const { getFirestore } = require('firebase-admin/firestore');
    const secrets = {};
    for (const n of SECRET_NAMES) secrets[n] = process.env[n];
    await runMailFeed({
      db: getFirestore(), nowMs: Date.now(), enabled: gateOn({ MAIL_FEED_ENABLED: process.env.MAIL_FEED_ENABLED }),
      inboxes: process.env.MAIL_FEED_INBOXES, secrets, log: logger,
    });
  }
);

exports._test = {
  runMailFeed, readOnlyImap, imapOptions, READ_ONLY_IMAP_METHODS, GMAIL_SCOPE, gateOn,
  parseInboxes, detectInbox, parseFrom, buildDoc, docIdFor, snippetOf, safeError, secretText, htmlToText, maskMail,
};
