'use strict';
/**
 * google-review-url.js — is this one of Google's own review / Maps pages? PURE.
 *
 * users/{uid}.googleReviewUrl is typed by each user on their own doc. Before
 * 2026-11-26 the server put ANY https link from it into NBD's review-ask email
 * (review-ask-auto-logic.js reviewUrlFor), the portal's review button
 * (portal.js portalReviewUrl) and the agent review sprint (agent-mcp.js).
 * R12 of the review-ask guardrail plan: only these shapes are used; anything
 * else is treated as "no link" (NBD then falls back to its own review link).
 *
 * Whole-string matches only, Google's own hosts only, no redirector
 * (google.com/url) and no look-alike host. A query is allowed only as plain
 * key=value pairs (letters, digits, . _ -), so no URL can ride inside one.
 * An http:// Google link is upgraded to https.
 */

// Extra share-sheet parameters (?g_st=ic, &source=g.page.m): values hold no ':' or '/'.
const PARAMS = '(?:[?&][A-Za-z0-9_]{1,32}=[A-Za-z0-9_.-]{0,64}){0,6}';
const SHAPES = Object.freeze([
  /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]{2,128}(\/review)?\/?$/,
  /^https:\/\/g\.page\/[A-Za-z0-9_-]{2,128}\/review\/?$/,                       // the older g.page/<name>/review form
  new RegExp('^https://search\\.google\\.com/local/writereview\\?placeid=[A-Za-z0-9_-]{10,300}' + PARAMS.replace('[?&]', '&') + '$'),
  new RegExp('^https://maps\\.app\\.goo\\.gl/[A-Za-z0-9_-]{4,64}' + PARAMS + '$'),
  /^https:\/\/g\.co\/kgs\/[A-Za-z0-9_-]{4,64}$/,
  /^https:\/\/(www\.)?google\.com\/maps\/place\/[A-Za-z0-9_.,+%@!:=\/-]{1,400}$/,
]);

/** The link trimmed (and http upgraded to https) when it is a Google review / Maps page, else ''. */
function cleanReviewUrl(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim().replace(/^http:\/\//i, 'https://');
  if (s.length > 500 || !SHAPES.some((re) => re.test(s))) return '';
  // What a browser will actually open must be exactly this string: dot segments
  // (../, %2e%2e/) would resolve onto another google.com path (security review, R12).
  if (/(^|\/)(\.|%2e){1,2}(\/|$|\?)/i.test(s.replace(/^https:\/\/[^/]+/, ''))) return '';
  // Encoded slashes / backslashes could hide a path a server decodes (security review, #3293).
  if (/%2f|%5c/i.test(s)) return '';
  let href = '';
  try { href = new URL(s).href; } catch (_) { return ''; }
  return href === s ? s : '';
}

const isGoogleReviewUrl = (raw) => cleanReviewUrl(raw) !== '';

module.exports = { cleanReviewUrl, isGoogleReviewUrl, SHAPES };
