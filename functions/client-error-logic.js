/**
 * functions/client-error-logic.js — pure rules for the clientError endpoint
 * (handlers/monitoring.js). No Firebase, no network: required by the handler
 * and by tests/client-error-reporting-2026-10-04.test.js.
 *
 * The browser half (docs/pro/js/client-error-reporter.js) scrubs before it
 * sends. This file scrubs AGAIN on the server: the endpoint is public, so a
 * report can come from anything, and nothing un-scrubbed may reach the logs.
 * The two scrub() copies are pinned to the same fixtures by that test.
 */
'use strict';

const crypto = require('crypto');

const MAX_BODY_BYTES = 4096;
const MAX_MESSAGE = 300;
const MAX_STACK = 1500;
const MAX_STACK_LINES = 8;
const KINDS = new Set(['error', 'unhandledrejection', 'callable', 'manual']);

// Order matters: tokens and URLs first (an email or digit run inside a URL
// query would otherwise be half-replaced and leave the rest behind).
const SCRUBBERS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [token]'],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[jwt]'],
  // Any query string or fragment on a URL: ?token=, ?email=, portal links.
  [/(\b(?:https?|blob|webkit-masked-url):\/\/[^\s?#'"()<>]*)[?#][^\s'"()<>]*?(?=:\d+(?::\d+)?(?![\w.])|[\s'"()<>]|$)/gi, '$1'],
  [/([A-Za-z0-9_./-]+\.(?:js|mjs|html|css))\?[^\s:'"()<>]*/g, '$1'],
  [/\b(?:token|idToken|access_token|key|code|sig|signature)=[^&\s'"]+/gi, '[param]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'],
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[phone]'],
  [/\b\d{7,}\b/g, '[num]'],
  [/\b\d{1,6}\s+(?:[A-Z][A-Za-z]*\.?\s+){1,4}(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Boulevard|Way|Pl|Place|Pike|Cir|Circle|Ter|Terrace|Trl|Trail|Pkwy|Parkway|Hwy|Highway)\b\.?/g, '[address]'],
];

function scrub(input) {
  let s = String(input == null ? '' : input);
  for (const [re, rep] of SCRUBBERS) s = s.replace(re, rep);
  return s;
}

function trimStack(stack) {
  const lines = scrub(stack).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, MAX_STACK_LINES);
  return lines.join('\n').slice(0, MAX_STACK);
}

// Stable across occurrences: digits and quoted values normalised out of the
// message, and only the FIRST stack frame's file:line (no column, no query).
function topFrame(stack) {
  const lines = String(stack || '').split(/\r?\n/);
  for (const l of lines) {
    const m = l.match(/([A-Za-z0-9_.-]+\.(?:js|mjs|html))(?:\?[^:\s)]*)?:(\d+)/);
    if (m) return m[1] + ':' + m[2];
  }
  return '';
}
function normalizeMessage(msg) {
  return String(msg || '')
    .replace(/(["'`]).*?\1/g, '"_"')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
function signature(kind, message, stack) {
  return crypto.createHash('sha256')
    .update(String(kind) + '|' + normalizeMessage(message) + '|' + topFrame(stack))
    .digest('hex').slice(0, 12);
}

const SLUG = /^[A-Za-z0-9_.:/-]{1,60}$/;
function slug(v) {
  const s = String(v == null ? '' : v).slice(0, 60);
  return SLUG.test(s) ? s : '';
}

/**
 * Parse + validate one report body. Returns { ok: true, entry } with every
 * field bounded and scrubbed, or { ok: false, reason }.
 *   body: req.body as Express parsed it (object, string or Buffer)
 *   raw:  req.rawBody (Buffer) — used when the body arrived as text/plain
 */
function parseReport(body, raw) {
  if (raw && raw.length > MAX_BODY_BYTES) return { ok: false, reason: 'too_large' };
  let b = body;
  const emptyObj = b && typeof b === 'object' && !Buffer.isBuffer(b) && !Array.isArray(b) && Object.keys(b).length === 0;
  if (b == null || emptyObj || Buffer.isBuffer(b) || typeof b === 'string') {
    const text = typeof b === 'string' ? b : (Buffer.isBuffer(b) ? b.toString('utf8') : (raw ? raw.toString('utf8') : ''));
    if (text.length > MAX_BODY_BYTES) return { ok: false, reason: 'too_large' };
    try { b = JSON.parse(text); } catch (_) { return { ok: false, reason: 'bad_json' }; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, reason: 'not_object' };
  if (typeof b.message !== 'string' || !b.message.trim()) return { ok: false, reason: 'no_message' };
  const kind = KINDS.has(b.kind) ? b.kind : 'manual';
  const message = scrub(b.message).slice(0, MAX_MESSAGE);
  const stack = typeof b.stack === 'string' ? trimStack(b.stack) : '';
  const uidHash = typeof b.uidHash === 'string' && /^[a-f0-9]{8,64}$/.test(b.uidHash) ? b.uidHash : '';
  return {
    ok: true,
    entry: {
      sig: signature(kind, message, stack),
      kind,
      message,
      stack,
      page: slug(b.page),
      view: slug(b.view),
      build: slug(b.build),
      userAgent: scrub(typeof b.ua === 'string' ? b.ua : '').slice(0, 200),
      standalone: b.standalone === true,
      online: b.online !== false,
      uidHash,
    },
  };
}

module.exports = { scrub, trimStack, signature, normalizeMessage, topFrame, parseReport, MAX_BODY_BYTES, MAX_MESSAGE, MAX_STACK };
