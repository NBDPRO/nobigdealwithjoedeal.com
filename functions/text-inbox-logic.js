/**
 * functions/text-inbox-logic.js — pure decisions for the Text Inbox ingest
 * (Call Center stage 4, 2026-10-01). Jo: "Probably everything … half or
 * more customers are contacts in my phone plus random numbers that gets
 * hard to filter".
 *
 * Jo's Android phone runs SMS Backup & Restore, which writes a scheduled
 * backup of EVERY text (received and sent, SMS and MMS) to Google Drive as
 * sms-<YYYYMMDDHHMMSS>.xml in its "SMSBackupRestore" folder. The format:
 *
 *   <smses count="2">
 *     <sms protocol="0" address="+15135550100" date="1727800000000" type="1"
 *          body="Can you come Tuesday?" contact_name="Pat Example" … />
 *     <mms date="1727800000" msg_box="2" address="+15135550100" contact_name="…">
 *       <parts><part ct="text/plain" text="On my way" … /></parts>
 *       <addrs><addr address="+15135550100" type="151" … /></addrs>
 *     </mms>
 *   </smses>
 *
 * sms type: 1 received, 2 sent (3 draft, 4 outbox, 5 failed, 6 queued are
 * skipped). mms msg_box: 1 inbox, 2 sent; mms `date` is in SECONDS.
 *
 * Sorted the same way calls are (call-center-logic.js): customer /
 * insurance / contact / unknown — nothing a person sent is dropped. The
 * one exception is SHORT CODES (5–6 digit senders: verification codes,
 * bank and delivery alerts): never stored — a 2FA code has no business in
 * the CRM.
 *
 * A dependency-free regex scan, not an XML library: the file is one flat
 * list of self-describing elements and attribute values are XML-escaped,
 * so this stays small, fast on a multi-MB backup, and fully unit-tested.
 */
'use strict';

const crypto = require('crypto');
const { phoneDigits10 } = require('./phone-utils');

function unescapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** `a="1" b="x &amp; y"` → { a: '1', b: 'x & y' } */
function parseAttrs(s) {
  const out = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = unescapeXml(m[2]);
  return out;
}

function isShortCode(address) {
  const d = String(address || '').replace(/\D/g, '');
  return d.length >= 3 && d.length <= 6;
}

function cleanName(n) {
  const s = String(n || '').trim();
  return !s || /^\(unknown\)$/i.test(s) || s === 'null' ? '' : s;
}

/**
 * Parse a backup into messages newer than sinceMs (inclusive). Returns
 * { messages, skipped: { shortCode, otherType, old, noNumber } }.
 */
function parseSmsBackup(xml, { sinceMs = 0 } = {}) {
  const text = String(xml || '');
  const messages = [];
  const skipped = { shortCode: 0, otherType: 0, old: 0, noNumber: 0 };

  const smsRe = /<sms\b([^>]*?)\/?>/g;
  let m;
  while ((m = smsRe.exec(text))) {
    const a = parseAttrs(m[1]);
    const type = String(a.type || '');
    if (type !== '1' && type !== '2') { skipped.otherType++; continue; }
    const dateMs = Number(a.date) || 0;
    if (dateMs < sinceMs) { skipped.old++; continue; }
    if (isShortCode(a.address)) { skipped.shortCode++; continue; }
    const digits = phoneDigits10(a.address);
    if (digits.length !== 10) { skipped.noNumber++; continue; }
    messages.push({
      kind: 'sms', phoneDigits: digits, direction: type === '1' ? 'inbound' : 'outbound',
      dateMs, body: a.body === 'null' ? '' : String(a.body || ''), contactName: cleanName(a.contact_name), group: false,
    });
  }

  const mmsRe = /<mms\b([^>]*)>([\s\S]*?)<\/mms>/g;
  while ((m = mmsRe.exec(text))) {
    const a = parseAttrs(m[1]);
    const box = String(a.msg_box || '');
    if (box !== '1' && box !== '2') { skipped.otherType++; continue; }
    const dateMs = (Number(a.date) || 0) * 1000;
    if (dateMs < sinceMs) { skipped.old++; continue; }
    // Group texts carry several numbers joined by "~".
    const numbers = String(a.address || '').split('~').map((x) => x.trim()).filter(Boolean);
    if (numbers.length && numbers.every(isShortCode)) { skipped.shortCode++; continue; }
    const digits = phoneDigits10(numbers.find((x) => !isShortCode(x)) || '');
    if (digits.length !== 10) { skipped.noNumber++; continue; }
    const parts = [];
    const partRe = /<part\b([^>]*?)\/?>/g;
    let p;
    let images = 0;
    while ((p = partRe.exec(m[2]))) {
      const pa = parseAttrs(p[1]);
      if (pa.ct === 'text/plain' && pa.text && pa.text !== 'null') parts.push(pa.text);
      else if (/^image\//.test(pa.ct || '')) images++;
    }
    messages.push({
      kind: 'mms', phoneDigits: digits, direction: box === '1' ? 'inbound' : 'outbound', dateMs,
      body: parts.join('\n') + (images ? (parts.length ? '\n' : '') + '[' + images + ' photo' + (images === 1 ? '' : 's') + ']' : ''),
      contactName: cleanName(a.contact_name), group: numbers.length > 1,
    });
  }
  messages.sort((x, y) => x.dateMs - y.dateMs);
  return { messages, skipped };
}

/** Deterministic id: the same text in two backups is one doc. */
function textDocId(msg) {
  const h = crypto.createHash('sha1')
    .update([msg.phoneDigits, msg.dateMs, msg.direction, msg.kind, msg.body].join('|'))
    .digest('hex');
  return 'sms_' + h.slice(0, 28);
}

/** The newest sms-*.xml backup in a folder listing (calls-*.xml ignored). */
function pickNewestBackup(files) {
  return (files || [])
    .filter((f) => f && /^sms-\d{14}\.xml$/i.test(String(f.name || '')))
    .sort((a, b) => String(b.name).localeCompare(String(a.name)))[0] || null;
}

// How far back texts go (Jo, 2026-10-02: "yes texts back to 2026 too", the
// same floor as calls in call-center-logic.js HISTORY_FROM). Midnight
// Eastern on 2026-01-01; January is EST, UTC-5. A backup holds Jo's whole
// texting history, and nothing older than this is ever read.
const HISTORY_FROM_MS = Date.parse('2026-01-01T05:00:00Z');

/**
 * Where to read from: the history floor on the first run; after that, 3
 * days of overlap before the cursor (dedupe makes it free), never earlier
 * than the floor. (nowMs is kept for the callers' signature.)
 */
function sinceFor(cursorMs, nowMs) {
  const floor = HISTORY_FROM_MS;
  return cursorMs ? Math.max(floor, cursorMs - 3 * 24 * 3600 * 1000) : floor;
}

function buildTextDoc({ ownerUid, msg, match, bucket, fileId, nowMs }) {
  return {
    userId: ownerUid,
    companyId: ownerUid,
    source: 'sms-backup',
    kind: msg.kind,
    direction: msg.direction,
    sentAtMs: msg.dateMs,
    phoneDigits: msg.phoneDigits,
    contactName: msg.contactName,
    body: String(msg.body || '').slice(0, 5000),
    group: !!msg.group,
    bucket,
    leadId: (match && match.leadId) || null,
    alternateLeadIds: (match && match.alternates) || [],
    backupFileId: fileId || null,
    createdAtMs: nowMs,
  };
}

// ── Text notes (2026-10-01) ──────────────────────────────────────────────
//
// Texts are read a CONVERSATION-DAY at a time: every text with one number on
// one Eastern calendar day. A day is noted once it has gone quiet for two
// hours (the back-and-forth has settled), and again only if new texts land
// that day (the signature changes). Notes use the call notes' shape and
// sanitizer, so the sweep email treats a texted promise exactly like a spoken
// one.

const QUIET_MS = 2 * 3600 * 1000;

function etYmd(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * phone_texts rows → conversation-days ready to note (quiet for QUIET_MS),
 * newest first. Each: { id, phoneDigits, ymd, leadId, contactName, lastAtMs,
 * sig, messages }. Group texts are skipped (several people, unclear who
 * promised what).
 */
function groupTextDays(texts, { nowMs, quietMs = QUIET_MS } = {}) {
  const byKey = new Map();
  for (const t of texts || []) {
    if (!t || !t.phoneDigits || !t.sentAtMs || t.group) continue;
    const ymd = etYmd(t.sentAtMs);
    const key = t.phoneDigits + '_' + ymd;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(t);
  }
  const out = [];
  for (const [key, msgs] of byKey) {
    msgs.sort((a, b) => a.sentAtMs - b.sentAtMs);
    const last = msgs[msgs.length - 1];
    if (nowMs - last.sentAtMs < quietMs) continue; // still talking
    const sig = crypto.createHash('sha1').update(msgs.map((m) => m.id || m.sentAtMs + m.direction).join('|')).digest('hex').slice(0, 16);
    out.push({
      id: 'txt_' + key.replace(/-/g, ''),
      phoneDigits: msgs[0].phoneDigits,
      ymd: etYmd(last.sentAtMs),
      leadId: msgs.map((m) => m.leadId).filter(Boolean).pop() || null,
      contactName: msgs.map((m) => m.contactName).filter(Boolean).pop() || '',
      lastAtMs: last.sentAtMs,
      sig,
      messages: msgs,
    });
  }
  return out.sort((a, b) => b.lastAtMs - a.lastAtMs);
}

const TEXT_NOTES_SYSTEM = [
  'You read one day of text messages between Jo, who runs No Big Deal Home Solutions (a small roofing / gutters / siding contractor near Cincinnati), and one other person.',
  'Return ONE JSON object and nothing else:',
  '{"call_type": one of ["customer","insurance","supplier","sub","lead","personal","spam","other"],',
  ' "summary": "1-2 plain sentences: what the texts were about and what was decided",',
  ' "promises": [{"who": "jo" | "them", "text": "a concrete thing someone said they would do, imperative, under 120 chars", "due": "YYYY-MM-DD" or null}],',
  ' "follow_up_date": "YYYY-MM-DD" or null,',
  ' "urgent": true | false (an active leak, safety issue, or a hard deadline within 48 hours)}',
  'Rules: only promises actually made in these texts, at most 6. Resolve relative dates against the dates shown.',
  'Texts about family, friends or anything not business are "personal": summary "Personal texts." and promises [].',
  'Never invent prices, names or dates that were not written.',
].join('\n');

function buildTextNotesPrompt({ day, leadName }) {
  const lines = day.messages.map((m) => {
    const t = new Date(m.sentAtMs).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
    return '[' + t + '] ' + (m.direction === 'outbound' ? 'Jo' : 'Them') + ': ' + String(m.body || '').slice(0, 2000);
  });
  return [
    'Date (Eastern): ' + day.ymd,
    'Other person (from Jo\'s phone contacts): ' + (day.contactName || 'not a saved contact'),
    leadName ? 'CRM customer this number belongs to: ' + leadName : 'Not matched to a CRM customer.',
    '',
    'Texts:',
    lines.join('\n').slice(0, 30000),
  ].join('\n');
}

module.exports = {
  QUIET_MS,
  groupTextDays,
  TEXT_NOTES_SYSTEM,
  buildTextNotesPrompt,
  unescapeXml,
  parseAttrs,
  isShortCode,
  parseSmsBackup,
  textDocId,
  pickNewestBackup,
  sinceFor,
  HISTORY_FROM_MS,
  buildTextDoc,
};
