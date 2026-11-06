/**
 * functions/portal-booking.js — the homeowner portal's "your appointment"
 * card and shared reports (2026-11-04,
 * documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md Phase 4).
 *
 * Jo's decisions:
 *   - Reschedule / cancel happen on Cal.com's own pages, linked from the
 *     portal (the booking's uid is the key Cal.com uses). Self-serve stops
 *     once the job is past the estimate: after signing a change is a message
 *     to the rep, never a click.
 *   - A report shows in the portal only after Jo shares it (the Documents
 *     tab's "Share link", functions/report-sharing.js, which writes
 *     shareUrl / shareExpiresAt back onto the row).
 *
 * Pure: getHomeownerPortalView does the reads and hands the rows in.
 */
'use strict';

const CALCOM_BASE = 'https://app.cal.com';
// report-sharing.js REPORT_URL_BASE. Only links of exactly this shape are
// ever shown — a row's shareUrl is never trusted as an arbitrary URL.
const REPORT_URL_BASE = 'https://nobigdealwithjoedeal.com/report/';
// Cal.com booking uids are opaque url-safe strings; a numeric id (older
// payloads) cannot build the reschedule/cancel pages, so it gets no links.
const UID_RE = /^[A-Za-z0-9_-]{10,64}$/;
const SELF_SERVE_STEPS = new Set(['inspection', 'estimate']);

const toMs = (t) => (t && typeof t.toMillis === 'function' ? t.toMillis()
  : (t instanceof Date ? t.getTime() : (Number.isFinite(t) ? t : NaN)));

/**
 * The next upcoming Cal.com appointment for the lead, or null.
 *   appts: appointment docs (already tenant-filtered), currentKey: the
 *   tracker's current step, nowMs.
 * → { startMs, endMs, title, manage: { reschedule, cancel } | null }
 */
function bookingCard(appts, currentKey, nowMs) {
  const live = (Array.isArray(appts) ? appts : [])
    .filter((a) => a && (a.status === 'booked' || a.status === 'rescheduled'))
    .map((a) => Object.assign({}, a, { _start: toMs(a.startTime), _end: toMs(a.endTime) }))
    .filter((a) => Number.isFinite(a._start) && a._start > nowMs)
    .sort((x, y) => x._start - y._start);
  const a = live[0];
  if (!a) return null;
  const uid = a.source === 'calcom' && typeof a.bookingId === 'string' && UID_RE.test(a.bookingId) ? a.bookingId : '';
  const selfServe = SELF_SERVE_STEPS.has(String(currentKey || ''));
  return {
    startMs: a._start,
    endMs: Number.isFinite(a._end) && a._end > a._start ? a._end : null,
    title: String(a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
    manage: uid && selfServe ? {
      reschedule: CALCOM_BASE + '/reschedule/' + encodeURIComponent(uid),
      cancel: CALCOM_BASE + '/booking/' + encodeURIComponent(uid) + '?cancel=true',
    } : null,
  };
}

/**
 * Reports Jo shared with "Share link" that are not already on the shelf
 * (rows the shelf shows are passed as shownIds). → document-shelf rows.
 */
function sharedReportRows(docRows, shownIds, nowMs) {
  const shown = shownIds instanceof Set ? shownIds : new Set(shownIds || []);
  return (Array.isArray(docRows) ? docRows : []).filter((d) => d && d.deleted !== true && !shown.has(d.id)
    && typeof d.shareUrl === 'string' && d.shareUrl.indexOf(REPORT_URL_BASE) === 0
    && /^[A-Za-z0-9_-]{10,128}$/.test(d.shareUrl.slice(REPORT_URL_BASE.length))
    && toMs(d.shareExpiresAt) > nowMs)
    .map((d) => {
      const at = toMs(d.sharedAt);
      return {
        id: d.id,
        name: String(d.name || (d.reportNumber ? 'Photo report ' + d.reportNumber : 'Report')).slice(0, 120),
        date: Number.isFinite(at) ? new Date(at).toISOString() : null,
        url: d.shareUrl,
        viaHtml: false,
      };
    });
}

module.exports = { bookingCard, sharedReportRows, CALCOM_BASE, REPORT_URL_BASE };
