/**
 * docs/pro/js/social-studio-logic.js — pure helpers for the Social Studio
 * page (calendar grid, reschedule, Ready-to-post queue, export). No DOM, no
 * Firebase: loaded by /pro/social.html as a classic script
 * (window.NBDSocialLogic) and by Node tests via module.exports.
 *
 * Time zone: every calendar day is an America/New_York day — the publisher
 * and "Plan N weeks" schedule in Eastern time, so the grid must too.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.NBDSocialLogic = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var TZ = 'America/New_York';
  var PLATFORMS = {
    facebook: { label: 'Facebook', auto: true },
    instagram: { label: 'Instagram', auto: true },
    gbp: { label: 'Google Business', auto: true },
    tiktok: { label: 'TikTok', auto: false },
    nextdoor: { label: 'Nextdoor', auto: false },
    linkedin: { label: 'LinkedIn', auto: false },
    x: { label: 'X', auto: false },
  };
  var PLATFORM_ORDER = ['facebook', 'instagram', 'gbp', 'tiktok', 'nextdoor', 'linkedin', 'x'];
  var STATUS_LABELS = {
    draft: 'Draft', approved: 'Approved', scheduled: 'Scheduled', publishing: 'Posting…',
    ready: 'Ready to post', posted: 'Posted', failed: 'Failed', cancelled: 'Cancelled',
  };
  var KIND_LABELS = {
    job_showcase: 'Job showcase', tip: 'Roof tip', storm_psa: 'Storm PSA', review: 'Review', behind_scenes: 'Behind the scenes',
  };

  function ms(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }

  function parts(utcMs) {
    var dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    var o = {};
    dtf.formatToParts(new Date(utcMs)).forEach(function (p) { o[p.type] = p.value; });
    return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
  }
  function offsetMin(utcMs) {
    var p = parts(utcMs);
    return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - utcMs) / 60000);
  }
  /** UTC ms of a wall-clock Eastern time. */
  function zonedMs(y, m, d, h, mi) {
    var guess = Date.UTC(y, m - 1, d, h || 0, mi || 0);
    var o1 = offsetMin(guess);
    var t = guess - o1 * 60000;
    var o2 = offsetMin(t);
    return o2 === o1 ? t : guess - o2 * 60000;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function ymdKey(utcMs) { var p = parts(utcMs); return p.y + '-' + pad(p.m) + '-' + pad(p.d); }
  function parseYmd(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  /** "YYYY-MM-DDTHH:MM" Eastern, for <input type="datetime-local">. */
  function toLocalInput(utcMs) {
    if (!utcMs) return '';
    var p = parts(utcMs);
    return p.y + '-' + pad(p.m) + '-' + pad(p.d) + 'T' + pad(p.h) + ':' + pad(p.mi);
  }
  function fromLocalInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
    return m ? zonedMs(+m[1], +m[2], +m[3], +m[4], +m[5]) : 0;
  }

  /** Month grid: weeks (Sun–Sat) of { key, day, inMonth } for y/m (1-12). */
  function monthGrid(y, m) {
    var first = new Date(Date.UTC(y, m - 1, 1));
    var start = Date.UTC(y, m - 1, 1 - first.getUTCDay());
    var weeks = [];
    for (var w = 0; w < 6; w++) {
      var row = [];
      for (var i = 0; i < 7; i++) {
        var d = new Date(start + (w * 7 + i) * 86400000);
        row.push({ key: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()), day: d.getUTCDate(), inMonth: d.getUTCMonth() === m - 1 });
      }
      weeks.push(row);
      var next = new Date(start + (w + 1) * 7 * 86400000);
      if (next.getUTCMonth() !== m - 1 && w >= 3) break;
    }
    return weeks;
  }

  /** The 7 day keys (Sun–Sat) of the Eastern week containing anchorMs. */
  function weekKeys(anchorMs) {
    var p = parts(anchorMs);
    var base = Date.UTC(p.y, p.m - 1, p.d);
    var dow = new Date(base).getUTCDay();
    var out = [];
    for (var i = 0; i < 7; i++) {
      var d = new Date(base + (i - dow) * 86400000);
      out.push(d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()));
    }
    return out;
  }

  /** { 'YYYY-MM-DD': { platform: [posts] } } for scheduled/posted items. */
  function bucketByDay(posts) {
    var out = {};
    (posts || []).forEach(function (p) {
      var t = ms(p.postedAt) || ms(p.scheduledAt);
      if (!t || p.status === 'cancelled') return;
      var k = ymdKey(t);
      var day = out[k] || (out[k] = {});
      (day[p.platform] || (day[p.platform] = [])).push(p);
    });
    Object.keys(out).forEach(function (k) {
      Object.keys(out[k]).forEach(function (pl) {
        out[k][pl].sort(function (a, b) { return ms(a.scheduledAt) - ms(b.scheduledAt); });
      });
    });
    return out;
  }

  /** Platforms that have at least one post — the calendar's lanes. */
  function lanes(posts, chosen) {
    var seen = {};
    (posts || []).forEach(function (p) { seen[p.platform] = true; });
    (chosen || []).forEach(function (p) { seen[p] = true; });
    return PLATFORM_ORDER.filter(function (p) { return seen[p]; });
  }

  var MOVABLE = { draft: 1, approved: 1, scheduled: 1, ready: 1, failed: 1, cancelled: 1 };

  /**
   * Reschedule a post to newMs. → { ok: true, patch } | { ok: false, error }
   * The patch keeps status, except a 'ready' post (it was due, waiting for a
   * hand post) moved into the future goes back to 'scheduled'. Approved +
   * dated = scheduled. Posted / publishing posts never move.
   */
  function reschedule(post, newMs, nowMs) {
    var p = post || {};
    var now = nowMs || Date.now();
    if (!MOVABLE[p.status]) return { ok: false, error: p.status === 'posted' ? 'Already posted.' : 'This post is being published right now.' };
    if (!newMs || isNaN(newMs)) return { ok: false, error: 'Pick a date and time.' };
    if (newMs < now - 60000) return { ok: false, error: 'That time has already passed.' };
    var patch = { scheduledAtMs: newMs };
    if (p.status === 'approved' || p.status === 'ready') patch.status = 'scheduled';
    return { ok: true, patch: patch };
  }

  /** Drop onto a calendar day: keep the post's Eastern time of day (default 9:00). */
  function dropOnDay(post, dayKey, nowMs) {
    var d = parseYmd(dayKey);
    if (!d) return { ok: false, error: 'Bad day.' };
    var t = ms(post && post.scheduledAt);
    var hh = 9, mm = 0;
    if (t) { var p = parts(t); hh = p.h; mm = p.mi; }
    return reschedule(post, zonedMs(d.y, d.m, d.d, hh, mm), nowMs);
  }

  /** The manual queue: anything 'ready', plus due scheduled manual-platform posts. */
  function readyQueue(posts, nowMs) {
    var now = nowMs || Date.now();
    return (posts || []).filter(function (p) {
      if (p.status === 'ready') return true;
      return p.status === 'scheduled' && PLATFORMS[p.platform] && !PLATFORMS[p.platform].auto && ms(p.scheduledAt) <= now;
    }).sort(function (a, b) { return ms(a.scheduledAt) - ms(b.scheduledAt); });
  }

  function needsApproval(posts) {
    return (posts || []).filter(function (p) { return p.status === 'draft' || p.status === 'failed'; })
      .sort(function (a, b) { return (ms(a.scheduledAt) || 9e15) - (ms(b.scheduledAt) || 9e15); });
  }

  // ── Export (Jo's IP) ──────────────────────────────────────────────────
  var CSV_COLS = ['id', 'platform', 'kind', 'status', 'scheduledAt', 'postedAt', 'postUrl', 'caption', 'hashtags', 'media', 'town', 'packageLabel'];
  function iso(v) { var t = ms(v); return t ? new Date(t).toISOString() : ''; }
  function csvCell(v) {
    var s = String(v == null ? '' : v);
    // Spreadsheet formula injection: a cell starting with = + - @ is text.
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportRow(p, mediaBase) {
    return {
      id: p.id || '', platform: p.platform || '', kind: p.kind || '', status: p.status || '',
      scheduledAt: iso(p.scheduledAt), postedAt: iso(p.postedAt), postUrl: p.postUrl || '',
      caption: p.caption || '', hashtags: (p.hashtags || []).join(' '),
      media: (p.media || []).map(function (m) { return (mediaBase || '') + '?k=' + m.key; }).join(' '),
      town: p.town || '', packageLabel: p.packageLabel || '',
    };
  }
  function toCSV(posts, mediaBase) {
    var lines = [CSV_COLS.join(',')];
    (posts || []).forEach(function (p) {
      var r = exportRow(p, mediaBase);
      lines.push(CSV_COLS.map(function (c) { return csvCell(r[c]); }).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }
  function toJSON(posts, mediaBase, meta) {
    return JSON.stringify({
      exportedAt: new Date((meta && meta.nowMs) || Date.now()).toISOString(),
      companyId: (meta && meta.companyId) || null,
      count: (posts || []).length,
      posts: (posts || []).map(function (p) { return exportRow(p, mediaBase); }),
    }, null, 2);
  }

  return {
    TZ: TZ, PLATFORMS: PLATFORMS, PLATFORM_ORDER: PLATFORM_ORDER, STATUS_LABELS: STATUS_LABELS, KIND_LABELS: KIND_LABELS,
    ms: ms, zonedMs: zonedMs, ymdKey: ymdKey, parseYmd: parseYmd, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput,
    monthGrid: monthGrid, weekKeys: weekKeys, bucketByDay: bucketByDay, lanes: lanes,
    reschedule: reschedule, dropOnDay: dropOnDay, readyQueue: readyQueue, needsApproval: needsApproval,
    toCSV: toCSV, toJSON: toJSON, csvCell: csvCell,
  };
});
