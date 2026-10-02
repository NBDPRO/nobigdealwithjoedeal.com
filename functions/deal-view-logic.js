'use strict';
/**
 * deal-view-logic.js — pure rules for "Maria opened her proposal 3 times,
 * 12 min read" (Jo, 2026-10-02; idea #3 from the GameForce review).
 *
 * getDealRoom (deal-acceptance.js) counts a view and decides whether to tell
 * the rep; dealRoomReadPing records time on page. No I/O here — unit-tested
 * in tests/deal-room-views-2026-10-02.test.js.
 */

// Link-preview fetchers open the link the moment it is TEXTED — iMessage,
// Facebook/Messenger, Slack, WhatsApp, Google and friends. Counting them would
// report a view the homeowner never made and ping the rep for nothing.
const PREVIEW_BOT_RE = /(facebookexternalhit|facebot|twitterbot|slackbot|slack-imgproxy|whatsapp|telegrambot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|applebot|embedly|pinterest|vkshare|redditbot|preview|crawler|spider|headlesschrome|bot\b)/i;

function isPreviewBot(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return true; // a real browser always sends one
  return PREVIEW_BOT_RE.test(ua);
}

// One read ping carries the seconds since the last ping (the page sends on
// hide/close). Clamp to a sane window: a tab left open overnight is not a
// 9-hour read, and a negative / NaN value is nothing.
const MAX_PING_SECONDS = 900;
function clampReadSeconds(n) {
  const s = Math.floor(Number(n));
  if (!Number.isFinite(s) || s <= 0) return 0;
  return Math.min(s, MAX_PING_SECONDS);
}

// Tell the rep on the FIRST open, and again on a re-open once at least
// RENOTIFY_MS has passed since the last heads-up (a homeowner coming back
// the next evening is a buying signal; five refreshes in a minute are not).
const RENOTIFY_MS = 6 * 3600 * 1000;
function shouldNotifyView(room, nowMs) {
  const r = room || {};
  if (!(Number(r.viewCount) > 0)) return true;
  const last = r.lastViewNotifiedAt && typeof r.lastViewNotifiedAt.toMillis === 'function'
    ? r.lastViewNotifiedAt.toMillis()
    : Number(r.lastViewNotifiedAt) || 0;
  return !last || (nowMs - last) >= RENOTIFY_MS;
}

/** "12 min" / "45 sec" / "" for the readout and the message. */
function fmtReadTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return '';
  if (s < 60) return s + ' sec';
  return Math.round(s / 60) + ' min';
}

/** The heads-up the rep gets. viewNumber = this open's count (1 = first). */
function viewMessage(customerName, viewNumber, readSeconds) {
  const who = String(customerName || '').trim() || 'Your customer';
  const n = Math.max(1, Math.floor(Number(viewNumber) || 1));
  const first = n === 1;
  const read = fmtReadTime(readSeconds);
  return {
    title: first ? 'Proposal opened 👀' : 'Proposal opened again 👀',
    body: first
      ? who + ' just opened their proposal.'
      : who + ' opened their proposal again (' + n + ' times' + (read ? ', ' + read + ' read so far' : '') + ').',
  };
}

module.exports = { isPreviewBot, clampReadSeconds, shouldNotifyView, fmtReadTime, viewMessage, MAX_PING_SECONDS, RENOTIFY_MS };
