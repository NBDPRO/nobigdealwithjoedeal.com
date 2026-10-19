/**
 * tests/lib/sender-scan.js — find every place a source file can message a person, and say whether the
 * object it sends through came from a kill-switch guard factory (guardTwilio / guardResend).
 *
 * Not a full parser (no parser is vendored); a comment-stripped, site-by-site scanner that is strict where
 * it matters and fails CLOSED on shapes it cannot follow:
 *
 *   SITE        `<receiver>.messages.create(` / `<receiver>.emails.send(` / `<receiver>.verifications.create(`
 *               The receiver's root identifier is resolved to its NEAREST PRECEDING assignment; the site is
 *               guarded only if that right-hand side (up to `;`) contains `guardTwilio(` / `guardResend(`,
 *               or the call itself is chained straight off one (`guardResend(db, resend).emails.send(`).
 *   BANNED      shapes that hide a send from the site pattern, flagged wherever they appear:
 *               destructuring `{ messages }` / `{ emails }` out of a client, aliasing `x = y.messages`,
 *               bracket access `['create']` / `['send']`, `.batch.send(`, a raw HTTP call to
 *               api.resend.com / api.twilio.com.
 *
 * `scan(source)` -> { sites: [{ line, receiver, guarded }], banned: [{ line, kind, text }] }
 */
'use strict';

const { stripJsComments } = require('./strip-js-comments');

const CALL = /([A-Za-z_$][\w$]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)?((?:\.[A-Za-z_$][\w$]*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*)\.(messages\.create|emails\.send|verifications\.create)\s*\(/g;

function lineOf(src, idx) { return src.slice(0, idx).split('\n').length; }

/** The statement text that starts at the nearest `receiver =` before idx (up to the next `;`), or ''. */
function nearestAssignment(src, name, idx) {
  const re = new RegExp('(?:^|[^\\w$.])' + name.replace(/\$/g, '\\$') + '\\s*=(?!=)', 'g');
  let m; let last = null;
  const before = src.slice(0, idx);
  while ((m = re.exec(before))) last = m;
  if (!last) return '';
  const start = last.index + last[0].length;
  const end = src.indexOf(';', start);
  return src.slice(start, end === -1 ? Math.min(src.length, start + 400) : end);
}

function scan(source) {
  const src = stripJsComments(source);
  const sites = [];
  const banned = [];
  let m;
  CALL.lastIndex = 0;
  while ((m = CALL.exec(src))) {
    const full = m[0];
    const chain = (m[1] || '') + (m[2] || '');
    const rootMatch = /^([A-Za-z_$][\w$]*)/.exec(chain);
    const root = rootMatch ? rootMatch[1] : '';
    // The statement text from the previous `;`/`{`/`}` up to the call: an inline
    // `guardResend(db, new Resend(k)).emails.send(` (or a multi-line chain) is guarded even when the
    // receiver nests deeper than CALL's own pattern follows.
    const stmtStart = Math.max(src.lastIndexOf(';', m.index), src.lastIndexOf('{', m.index), src.lastIndexOf('}', m.index)) + 1;
    let guarded = /guard(Twilio|Resend)\s*\(/.test(src.slice(stmtStart, m.index + full.length));
    if (!guarded && root) {
      const rhs = nearestAssignment(src, root, m.index);
      guarded = /guard(Twilio|Resend)\s*\(/.test(rhs);
    }
    // `resend.emails.send(gated.msg)`: the message came out of guardEmail() (kill switch + canary applied).
    if (!guarded) {
      const arg = /^\s*([A-Za-z_$][\w$]*)\.msg\s*\)/.exec(src.slice(m.index + full.length));
      if (arg) guarded = /guardEmail\s*\(/.test(nearestAssignment(src, arg[1], m.index));
    }
    sites.push({ line: lineOf(src, m.index), receiver: chain || root || '(unknown)', guarded, text: full.slice(0, 80) });
  }
  const ban = (re, kind) => {
    const r = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
    let b;
    while ((b = r.exec(src))) banned.push({ line: lineOf(src, b.index), kind, text: b[0].slice(0, 80) });
  };
  ban(/\{[^{}]*\b(messages|emails|verifications)\b[^{}]*\}\s*=\s*[A-Za-z_$(]/, 'destructured-client');
  ban(/=\s*[A-Za-z_$][^;=]*?\.(messages|emails|verifications)\s*[;,)]/, 'aliased-client');
  ban(/\.(messages|emails|verifications)\s*\[\s*['"`]/, 'bracket-access');
  ban(/\[\s*['"`](messages|emails)['"`]\s*\]/, 'bracket-access');
  ban(/\.(messages|emails|verifications)\.(bind|call|apply)\b/, 'bound-call');
  ban(/\.batch\.send\s*\(|emails\.batch\b/, 'batch-send');
  ban(/api\.resend\.com|api\.twilio\.com|verify\.twilio\.com/, 'raw-http-host');
  return { sites, banned };
}

module.exports = { scan };
