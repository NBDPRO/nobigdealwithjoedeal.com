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
 * Whole-string matches only, https only, no query beyond the one Google
 * writereview placeid, no redirector (google.com/url) and no look-alike host.
 */

const SHAPES = Object.freeze([
  /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]{2,128}(\/review)?\/?$/,
  /^https:\/\/search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]{10,300}$/,
  /^https:\/\/maps\.app\.goo\.gl\/[A-Za-z0-9_-]{4,64}$/,
  /^https:\/\/(www\.)?google\.com\/maps\/place\/[A-Za-z0-9_.,+%@!:=\/-]{1,400}$/,
]);

/** The link trimmed when it is a Google review / Maps page, else ''. */
function cleanReviewUrl(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  return s.length <= 500 && SHAPES.some((re) => re.test(s)) ? s : '';
}

const isGoogleReviewUrl = (raw) => cleanReviewUrl(raw) !== '';

module.exports = { cleanReviewUrl, isGoogleReviewUrl, SHAPES };
