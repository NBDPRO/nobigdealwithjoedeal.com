/**
 * functions/google-calendar-logic.js — the pure half of the Google Calendar
 * sync (calendar hub Phase 2: documentation/projects/
 * CALENDAR-HUB-PLAN-2026-09-29.md).
 *
 * Jo's decisions (2026-09-29): Google Calendar is the hub; almost everything
 * Jo needs to remember goes to Google; ONE "NBD Jobs" calendar, just Jo's;
 * conflicts warn, never block.
 *
 * The events are built from the SAME normalizers as the .ics feed
 * (calendar-feed-logic.js normalizeLead / normalizeAdjusterMeeting), so a job
 * reads identically on the phone's subscribed feed and in Google.
 *
 * No I/O here: google-calendar.js does the reading and writing.
 */
'use strict';

const FEED = require('./calendar-feed-logic');
const JOBS = require('./jobs-logic');

const TZ = 'America/New_York';
const APP_URL = 'https://nobigdealwithjoedeal.com/pro/customer.html?id=';

/**
 * A stable Google event id per (lead, kind). Google allows base32hex
 * characters [a-v0-9], 5–1024 long; hex is a subset. The same lead always
 * maps to the same id, so an update never makes a duplicate and a retry is a
 * no-op.
 */
function eventIdFor(kind, leadId, jobId) {
  // Multi-job (2026-09-30): a customer's ACTIVE job keeps the per-lead id (its
  // fields live on the lead). Any other job is keyed by lead + job; '/' can
  // never occur in a Firestore document id, so these can never collide with
  // a per-lead id.
  const key = jobId ? String(leadId) + '/' + String(jobId) : String(leadId);
  const hex = Buffer.from(key, 'utf8').toString('hex');
  return 'nbd' + (kind === 'adjuster' ? 'a' : 'j') + hex;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * A normalized feed event → a Google Calendar event resource.
 * Timed → dateTime in New York time; all-day → date / exclusive end date.
 * Busy/free (transparency) follows Jo's rule: anything with a time — and a
 * multi-day project, which fills the days — shows BUSY so Cal.com will not
 * offer those hours; a date-only job with no time shows FREE (it is a
 * reminder, not a block), the same choice the .ics feed made.
 */
function toGoogleEvent(ev, lead, job, ctx) {
  if (!ev) return null;
  const isAdj = ev.kind === 'adjuster';
  // A customer's other job names itself, so two jobs for one customer read apart.
  const name = (ev.title || 'Scheduled job') + (job && job.title ? ' — ' + job.title : '');
  const summary = isAdj ? name : ('🔨 ' + name + (ev.windowNote ? ' · ' + ev.windowNote : ''));
  const lines = [];
  if (isAdj) {
    if (ev.carrier) lines.push('Carrier: ' + ev.carrier);
    if (ev.claimNumber) lines.push('Claim #: ' + ev.claimNumber);
    if (ev.adjusterName) lines.push('Adjuster: ' + ev.adjusterName + (ev.adjusterPhone ? ' · ' + ev.adjusterPhone : ''));
  } else {
    if (ev.stage) lines.push('Stage: ' + ev.stage);
    if (ev.phone) lines.push('Homeowner: ' + ev.phone);
    // Production flow (2026-10-04): the sub on the job — an independent
    // subcontractor from the company's roster (lead.crew holds the name).
    const sub = String((lead && lead.crew) || '').trim();
    if (sub) lines.push('Sub: ' + sub.slice(0, 80));
    // The weather.gov forecast for the job's days in the next week (warns only).
    for (const l of weatherLines(ev, ctx && ctx.weather)) lines.push(l);
  }
  if (lead && lead.customerId) lines.push('Customer # ' + lead.customerId);
  lines.push('Open in NBD Pro: ' + APP_URL + encodeURIComponent(ev.id));
  lines.push('(Managed by NBD Pro — change it in the CRM; edits here are overwritten.)');

  const timed = ev.startMs != null && ev.endMs != null;
  const multiDay = !timed && ev.endExclusive && ev.endExclusive !== FEED.nextDate(ev.date);
  const out = {
    id: eventIdFor(ev.kind, ev.id, job && job.id),
    summary,
    location: ev.location || undefined,
    description: lines.join('\n'),
    start: timed ? { dateTime: iso(ev.startMs), timeZone: TZ } : { date: ev.date },
    end: timed ? { dateTime: iso(ev.endMs > ev.startMs ? ev.endMs : ev.startMs + FEED.DEFAULT_DURATION_MS), timeZone: TZ } : { date: ev.endExclusive },
    transparency: (timed || multiDay || /\d{1,2}:\d{2}/.test(ev.windowNote || '')) ? 'opaque' : 'transparent',
    extendedProperties: { private: { nbdManaged: '1', nbdLeadId: String(ev.id), nbdKind: isAdj ? 'adjuster' : 'job' } },
    source: { title: 'NBD Pro', url: APP_URL + encodeURIComponent(ev.id) },
  };
  if (!out.location) delete out.location;
  if (job && job.id) out.extendedProperties.private.nbdJobId = String(job.id);
  return out;
}

/**
 * The forecast lines for a job event: one per job day that has a forecast in
 * `weather` ({ 'YYYY-MM-DD': { label, level } } from job-weather.js). A warn
 * day is flagged so it stands out on the phone.
 */
function weatherLines(ev, weather) {
  if (!ev || !weather || typeof weather !== 'object') return [];
  const first = ev.date || (ev.startMs != null ? nyDate(ev.startMs) : null);
  if (!first) return [];
  const lastExcl = ev.endExclusive || FEED.nextDate(first);
  const out = [];
  for (let d = first, i = 0; d && d < lastExcl && i < 14; d = FEED.nextDate(d), i++) {
    const w = weather[d];
    if (w && w.label) out.push((w.level === 'warn' ? '⚠ ' : '') + 'Weather ' + d + ': ' + w.label);
  }
  return out;
}

/**
 * Every Google event a lead should have right now (0, 1 or 2).
 * Tenant scoping is the caller's job — only the platform tenant's leads come
 * in here. ctx (optional): { weather } — see weatherLines.
 */
function desiredEventsForLead(lead, job, ctx) {
  if (!lead || lead.deleted === true) return [];
  const doc = Object.assign({}, lead, { id: lead.id });
  const out = [];
  const ev = FEED.normalizeLead(doc);
  if (ev) out.push(toGoogleEvent(ev, lead, job, ctx));
  else {
    const wk = weekEventFor(doc, lead, job);
    if (wk) out.push(wk);
  }
  const adj = FEED.normalizeAdjusterMeeting(doc);
  if (adj) out.push(toGoogleEvent(adj, lead, job));
  return out;
}

/**
 * Multi-job (2026-09-30): the events for one of a customer's OTHER jobs (not
 * the active one — the lead's own events cover that). Built from the lead
 * with the job's fields laid over it (jobs-logic jobView), keyed per job so
 * a second job never overwrites the first job's event. A job that is the
 * active one, or has no id → none (its events are the lead's).
 */
function desiredEventsForJob(lead, job, ctx) {
  if (!lead || !job || !job.id || job.id === lead.activeJobId) return [];
  const view = Object.assign(JOBS.jobView(lead, job), { id: lead.id });
  return desiredEventsForLead(view, { id: String(job.id), title: job.title || null }, ctx);
}

// ── CRM-booked appointments (production flow, 2026-10-04) ─────────────────
// leads/{leadId}/tasks/{taskId} with type:'event' (lead-events.js) — the
// customer page's Add Event and the door-knock "Appointment Set". A set time
// is a commitment: a timed BUSY event, so Cal.com (which checks Jo's Google
// calendars) will not offer that slot to an online booker. 'e' + lead/task.
// The lead id rides in nbdEventLeadId (not nbdLeadId) so the double-booking
// check's "skip the lead being edited" rule never hides a real appointment.
function leadEventEventId(leadId, taskId) {
  return 'nbde' + Buffer.from(String(leadId) + '/' + String(taskId), 'utf8').toString('hex');
}
function desiredEventForLeadEvent(task, lead, leadId, taskId) {
  if (!lead) return null;
  const a = FEED.normalizeAppointment(FEED.leadEventToAppointment(task, lead, leadId, taskId));
  if (!a) return null;
  const lines = [];
  if (a.description) lines.push(a.description.slice(0, 500));
  if (a.attendeePhone) lines.push('Homeowner: ' + a.attendeePhone);
  if (lead.customerId) lines.push('Customer # ' + lead.customerId);
  lines.push('Open in NBD Pro: ' + APP_URL + encodeURIComponent(String(leadId)));
  lines.push('(Booked in NBD Pro — change it there; edits here are overwritten.)');
  const out = {
    id: leadEventEventId(leadId, taskId),
    summary: '📅 ' + a.title,
    location: a.location || undefined,
    description: lines.join('\n'),
    start: { dateTime: iso(a.startMs), timeZone: TZ },
    end: { dateTime: iso(a.endMs), timeZone: TZ },
    transparency: 'opaque',
    extendedProperties: { private: { nbdManaged: '1', nbdKind: 'event', nbdEventLeadId: String(leadId), nbdTaskId: String(taskId) } },
    source: { title: 'NBD Pro', url: APP_URL + encodeURIComponent(String(leadId)) },
  };
  if (!out.location) delete out.location;
  return out;
}
const EVENT_TASK_WATCHED = ['type', 'title', 'text', 'eventAt', 'durationMin', 'notes', 'deleted', 'cancelled', 'status'];
function eventTaskFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  if (a.type !== 'event' && b.type !== 'event') return false;           // a plain task — nothing on the calendar
  return EVENT_TASK_WATCHED.some((k) => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
}

// ── material deliveries (production flow, 2026-10-04) ─────────────────────
// leads/{leadId}/jobs/{jobId}/orders/{orderId}: { store, orderedDate,
// deliveryDate, status }. One all-day FREE event on the delivery day — a
// heads-up, not a slot (Jo needn't be there for a drop-off). Flags a delivery
// that lands after the job's start day. 'o' + lead/job/order.
function orderEventId(leadId, jobId, orderId) {
  return 'nbdo' + Buffer.from([leadId, jobId, orderId].map(String).join('/'), 'utf8').toString('hex');
}
function desiredEventForOrder(order, lead, leadId, jobId, orderId) {
  if (!order || !lead || lead.deleted === true || order.deleted === true) return null;
  if (order.status === 'cancelled') return null;
  const date = String(order.deliveryDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !FEED.nextDate(date)) return null;
  const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || String(lead.address || '') || 'Job';
  const store = String(order.store || '').trim().slice(0, 60);
  const lines = [];
  if (store) lines.push('Store: ' + store);
  if (order.orderNumber) lines.push('Order #: ' + String(order.orderNumber).slice(0, 40));
  if (order.orderedDate) lines.push('Ordered: ' + String(order.orderedDate).slice(0, 10));
  if (Array.isArray(order.items) && order.items.length) lines.push(order.items.length + ' line' + (order.items.length === 1 ? '' : 's') + ' on the materials list');
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(lead.scheduledDate || '')) ? lead.scheduledDate : null;
  if (start && date > start) lines.push('⚠ Arrives AFTER the job starts (' + start + ')');
  else if (start) lines.push('Job starts ' + start);
  lines.push('Open in NBD Pro: ' + APP_URL + encodeURIComponent(String(leadId)));
  lines.push('(Managed by NBD Pro — change it in the CRM; edits here are overwritten.)');
  const out = {
    id: orderEventId(leadId, jobId, orderId),
    summary: '🚚 Delivery' + (store ? ' (' + store + ')' : '') + ' — ' + name + (order.status === 'delivered' ? ' ✓' : ''),
    location: String(lead.address || '') || undefined,
    description: lines.join('\n'),
    start: { date },
    end: { date: FEED.nextDate(date) },
    transparency: 'transparent',
    extendedProperties: { private: { nbdManaged: '1', nbdKind: 'delivery', nbdOrderLeadId: String(leadId), nbdOrderId: String(orderId) } },
    source: { title: 'NBD Pro', url: APP_URL + encodeURIComponent(String(leadId)) },
  };
  if (!out.location) delete out.location;
  return out;
}
const ORDER_WATCHED = ['store', 'orderNumber', 'orderedDate', 'deliveryDate', 'status', 'deleted', 'items'];
function orderFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  const norm = (k, v) => (k === 'items' ? (Array.isArray(v) ? v.length : 0) : (v === undefined ? null : v));
  return ORDER_WATCHED.some((k) => JSON.stringify(norm(k, a[k])) !== JSON.stringify(norm(k, b[k])));
}

/** The two ids one of a customer's other jobs can own. */
function allIdsForJob(leadId, jobId) {
  return [eventIdFor('job', leadId, jobId), eventIdFor('adjuster', leadId, jobId)];
}

/**
 * A job planned to a WEEK but not a day yet (lead.scheduledWeek = that
 * week's Monday, no scheduledDate — Jo, 2026-09-29: "assign them to a week
 * and then refine"). One all-day bar Monday–Friday, FREE, so it never blocks
 * Cal.com or trips the double-booking warning: it is a plan, not a slot. It
 * uses the job's own event id, so setting a real date later updates this
 * event in place instead of leaving a stray.
 */
function weekEventFor(doc, lead, job) {
  // Same week event the .ics feed shows (calendar-feed-logic normalizeLeadWeek).
  const ev = FEED.normalizeLeadWeek(doc);
  if (!ev) return null;
  const g = toGoogleEvent(ev, lead, job);
  g.summary = '📆 ' + ev.title + (job && job.title ? ' — ' + job.title : '');
  g.transparency = 'transparent';
  g.description = 'Planned for this week — exact day not set yet. Set the date in NBD Pro (Schedule → Plan Jobs).\n' + g.description;
  return g;
}

/** The two ids a lead can ever own — what to delete when it has none. */
function allIdsForLead(leadId) {
  return [eventIdFor('job', leadId), eventIdFor('adjuster', leadId)];
}

// Only the fields Google shows, compared as a string — "did anything the
// homeowner-facing event carries change?" (ignores Google's own fields).
function eventSignature(e) {
  if (!e) return '';
  const pick = { s: e.summary || '', l: e.location || '', d: e.description || '', t: e.transparency || 'opaque',
    st: (e.start && (e.start.dateTime ? Date.parse(e.start.dateTime) : e.start.date)) || '',
    en: (e.end && (e.end.dateTime ? Date.parse(e.end.dateTime) : e.end.date)) || '' };
  return JSON.stringify(pick);
}

/**
 * desired: Google events we want. existing: managed events Google has (from
 * a list call, filtered to nbdManaged). Returns { upserts, deletes, same }.
 * An existing managed event nobody wants any more is deleted — the lead was
 * unscheduled, deleted, or moved to another tenant.
 */
function planSync(desired, existing) {
  const want = new Map((desired || []).filter(Boolean).map((e) => [e.id, e]));
  const have = new Map((existing || []).filter((e) => e && e.id && e.status !== 'cancelled').map((e) => [e.id, e]));
  const upserts = [], deletes = [];
  let same = 0;
  for (const [id, e] of want) {
    const h = have.get(id);
    if (h && eventSignature(h) === eventSignature(e)) same++;
    else upserts.push(e);
  }
  for (const [id] of have) if (!want.has(id)) deletes.push(id);
  return { upserts, deletes, same };
}

// ── yard-sign pickups (Jo, 2026-09-29 §6.2: pickups go to Google too) ──────
// One all-day reminder on the pickup day, FREE (a to-do, not a slot: it never
// blocks Cal.com or trips the double-booking warning). Keyed per sign; 's'
// because Google ids allow only [a-v0-9].
const DASHBOARD_URL = 'https://nobigdealwithjoedeal.com/pro/dashboard.html';
function signEventId(signId) { return 'nbds' + Buffer.from(String(signId), 'utf8').toString('hex'); }
function msOf(v) {
  if (v == null || v === '') return NaN;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v);
  const s = v.seconds != null ? v.seconds : v._seconds;
  return s != null ? s * 1000 : NaN;
}
/** The New York calendar day of an instant, 'YYYY-MM-DD'. */
function nyDate(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}
/**
 * A yard sign → its pickup reminder, or null (removed, picked up, missing, no
 * date). Still out past its pickup day → the reminder sits on TODAY, marked
 * overdue (the nightly reconcile moves it each morning), so it never strands
 * on a day Jo has already scrolled past.
 */
function desiredEventForSign(sign, nowMs) {
  if (!sign || !sign.id || sign.deleted === true) return null;
  if (sign.status === 'picked_up' || sign.status === 'missing') return null;
  const due = msOf(sign.dueAt);
  if (!isFinite(due)) return null;
  const dueDate = nyDate(due);
  const today = nyDate(nowMs == null ? Date.now() : nowMs);
  const overdue = dueDate < today;
  const date = overdue ? today : dueDate;
  const addr = String(sign.address || '').trim();
  const lines = [];
  const placed = msOf(sign.placedAt);
  if (isFinite(placed)) lines.push('Placed ' + nyDate(placed) + (sign.durationDays ? ' · ' + sign.durationDays + ' days' : ''));
  lines.push('Mark it picked up (or extend it) in NBD Pro → Yard Signs: ' + DASHBOARD_URL);
  lines.push('(Managed by NBD Pro — change it in the CRM; edits here are overwritten.)');
  const out = {
    id: signEventId(sign.id),
    summary: '🪧 Pick up yard sign' + (overdue ? ' (overdue since ' + dueDate + ')' : '') + (addr ? ' — ' + addr : ''),
    location: addr || undefined,
    description: lines.join('\n'),
    start: { date },
    end: { date: FEED.nextDate(date) },
    transparency: 'transparent',
    extendedProperties: { private: { nbdManaged: '1', nbdKind: 'yardsign', nbdSignId: String(sign.id) } },
    source: { title: 'NBD Pro', url: DASHBOARD_URL },
  };
  if (!out.location) delete out.location;
  return out;
}
const SIGN_WATCHED = ['dueAt', 'placedAt', 'durationDays', 'status', 'deleted', 'address', 'userId', 'companyId'];
function signCalendarFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  const norm = (k, v) => (k === 'dueAt' || k === 'placedAt') ? (isFinite(msOf(v)) ? msOf(v) : null) : (v === undefined ? null : v);
  return SIGN_WATCHED.some((k) => JSON.stringify(norm(k, a[k])) !== JSON.stringify(norm(k, b[k])));
}

// ── D2D knock follow-ups with a time (Jo, 2026-09-30: "only the latest knock") ─
// A re-knock writes a NEW knock doc and leaves the old one's follow-up behind,
// so the calendar shows ONE follow-up per door: the newest knock's, and only
// when it carries both a date and a time (Jo §6.2: "follow-ups when they carry
// a time"). The newest knock without a timed follow-up clears the door's event.
// Keyed by the door (the tracker's own normalizeAddress), so a re-knock moves
// the event in place. Knocks with no address are skipped (no door to key on).
const KNOCK_MIN = 30;
function knockAddrKey(addr) { return String(addr || '').toLowerCase().trim().replace(/\s+/g, ' '); }
function knockEventId(addrKey) { return 'nbdk' + require('crypto').createHash('sha1').update(String(addrKey), 'utf8').digest('hex'); }
/** Newest knock per door → Map(addrKey → knock). Ties: the larger doc id. */
function latestKnockPerDoor(knocks) {
  const out = new Map();
  for (const k of knocks || []) {
    if (!k) continue;
    const key = knockAddrKey(k.address);
    if (!key) continue;
    const t = msOf(k.createdAt), cur = out.get(key);
    const ct = cur ? msOf(cur.createdAt) : -Infinity;
    const tt = isFinite(t) ? t : -Infinity;
    if (!cur || tt > ct || (tt === ct && String(k.id) > String(cur.id))) out.set(key, k);
  }
  return out;
}
/** The newest knock at a door → its follow-up event, or null. localToUtcMs from schedule-window.js. */
function desiredEventForKnock(knock, localToUtcMs) {
  if (!knock) return null;
  const key = knockAddrKey(knock.address);
  const time = String(knock.followUpTime || '').trim();
  const due = msOf(knock.followUpDate);
  if (!key || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || !isFinite(due)) return null;
  const date = nyDate(due);
  const startMs = localToUtcMs(date, time, TZ);
  if (typeof startMs !== 'number' || !isFinite(startMs)) return null;   // null on a bad date/time (isFinite(null) is true)
  const who = String(knock.homeowner || '').trim();
  const addr = String(knock.address).trim();
  const lines = [];
  if (knock.disposition) lines.push('Last knock: ' + String(knock.disposition).replace(/_/g, ' '));
  if (knock.phone) lines.push('Phone: ' + knock.phone);
  lines.push('Door-to-door follow-up — open NBD Pro → D2D: ' + DASHBOARD_URL + '?tab=d2d');
  lines.push('(Managed by NBD Pro — the newest knock at this door decides it; edits here are overwritten.)');
  return {
    id: knockEventId(key),
    summary: '📞 Follow up — ' + (who ? who + ' · ' : '') + addr,
    location: addr,
    description: lines.join('\n'),
    start: { dateTime: new Date(startMs).toISOString(), timeZone: TZ },
    end: { dateTime: new Date(startMs + KNOCK_MIN * 60000).toISOString(), timeZone: TZ },
    // A set time is a commitment: BUSY, like every other timed event here.
    transparency: 'opaque',
    extendedProperties: { private: { nbdManaged: '1', nbdKind: 'knock', nbdKnockId: String(knock.id || '') } },
    source: { title: 'NBD Pro', url: DASHBOARD_URL + '?tab=d2d' },
  };
}
/** Every door's follow-up event from a set of knocks (newest per door wins). */
function desiredKnockEvents(knocks, localToUtcMs) {
  const out = [];
  for (const k of latestKnockPerDoor(knocks).values()) { const e = desiredEventForKnock(k, localToUtcMs); if (e) out.push(e); }
  return out;
}
/**
 * The morning follow-up push uses the same rule (Jo, 2026-09-30: "only the
 * latest knock"): of `candidates` (knocks with a follow-up due), keep the ones
 * that are still the newest knock at their door, judged against `all` knocks
 * at those doors within the SAME company (two companies can knock one door).
 * A candidate with no address has no door to compare, so it is kept.
 */
function keepNewestPerDoor(candidates, all) {
  const tenant = (k) => String((k && (k.companyId || k.userId)) || '');
  const byTenant = new Map();
  for (const k of [].concat(all || [], candidates || [])) {
    if (!k) continue;
    const t = tenant(k);
    if (!byTenant.has(t)) byTenant.set(t, new Map());
    byTenant.get(t).set(String(k.id), k);              // de-dupe: a candidate is also in `all`
  }
  const newestIds = new Set();
  for (const ks of byTenant.values()) for (const k of latestKnockPerDoor([...ks.values()]).values()) newestIds.add(String(k.id));
  return (candidates || []).filter((k) => k && (!knockAddrKey(k.address) || newestIds.has(String(k.id))));
}
const KNOCK_WATCHED = ['followUpDate', 'followUpTime', 'address', 'homeowner', 'phone', 'disposition', 'createdAt', 'userId', 'companyId'];
function knockCalendarFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  const norm = (k, v) => (k === 'followUpDate' || k === 'createdAt') ? (isFinite(msOf(v)) ? msOf(v) : null) : (v === undefined ? null : v);
  return KNOCK_WATCHED.some((k) => JSON.stringify(norm(k, a[k])) !== JSON.stringify(norm(k, b[k])));
}

/** Did a lead write change anything the calendar shows? (cheap trigger gate) */
const WATCHED = ['scheduledDate', 'scheduledWeek', 'scheduledStart', 'scheduledDurationMin', 'scheduledEndDate', 'adjusterMeetingDate',
  'adjusterMeetingStart', 'adjusterName', 'adjusterPhone', 'firstName', 'lastName', 'address', 'deleted', 'stage', 'phone',
  'customerId', 'insCarrier', 'insuranceCarrier', 'claimNumber', 'companyId', 'userId',
  // Multi-job: a promotion swaps which job the lead's events describe.
  'activeJobId',
  // Production flow (2026-10-04): the sub's name rides in the job's description.
  'crew'];
// A job doc: its own fields plus what its event title / place come from.
const JOB_WATCHED = JOBS.JOB_FIELDS.filter((f) => WATCHED.includes(f)).concat(['title', 'property', 'companyId', 'userId']);
function jobCalendarFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  return JOB_WATCHED.some((k) => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
}
function calendarFieldsChanged(before, after) {
  const a = before || {}, b = after || {};
  return WATCHED.some((k) => JSON.stringify(a[k] === undefined ? null : a[k]) !== JSON.stringify(b[k] === undefined ? null : b[k]));
}

/** Busy blocks from a freeBusy response, merged and sorted. */
function busyBlocks(fb) {
  const all = [];
  const cals = (fb && fb.calendars) || {};
  for (const id of Object.keys(cals)) {
    for (const b of (cals[id].busy || [])) all.push({ startMs: Date.parse(b.start), endMs: Date.parse(b.end), calendar: id, title: b.title || null });
  }
  all.sort((x, y) => x.startMs - y.startMs);
  const merged = [];
  for (const b of all) {
    const last = merged[merged.length - 1];
    if (last && b.startMs < last.endMs) { last.endMs = Math.max(last.endMs, b.endMs); last.calendars.add(b.calendar); if (b.title) last.titles.add(b.title); }
    else merged.push({ startMs: b.startMs, endMs: b.endMs, calendars: new Set([b.calendar]), titles: new Set(b.title ? [b.title] : []) });
  }
  return merged.map((m) => ({ startMs: m.startMs, endMs: m.endMs, calendars: [...m.calendars], titles: [...m.titles] }));
}

/**
 * NBD Jobs events in a window → busy entries (freeBusy shape + title),
 * skipping FREE (transparent) events and the lead being edited — its own
 * current event must not warn about itself. All-day events cover whole New
 * York days (localToUtcMs from schedule-window.js).
 */
function jobsBusy(events, excludeLeadId, localToUtcMs) {
  const out = [];
  for (const e of events || []) {
    if (!e || e.status === 'cancelled' || e.transparency === 'transparent') continue;
    const p = (e.extendedProperties && e.extendedProperties.private) || {};
    // The lead being edited: skip ITS OWN (active-job) events only — the same
    // customer's other job on that day is a real clash and still warns.
    if (excludeLeadId && p.nbdLeadId === String(excludeLeadId) && !p.nbdJobId) continue;
    const s = e.start || {}, en = e.end || {};
    const startMs = s.dateTime ? Date.parse(s.dateTime) : (s.date ? localToUtcMs(s.date, '00:00', TZ) : NaN);
    const endMs = en.dateTime ? Date.parse(en.dateTime) : (en.date ? localToUtcMs(en.date, '00:00', TZ) : NaN);
    if (!isFinite(startMs) || !isFinite(endMs)) continue;
    out.push({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), title: e.summary || 'NBD job' });
  }
  return out;
}

/** Blocks overlapping [startMs, endMs) — the conflict warning. */
function conflictsWith(blocks, startMs, endMs, ignoreEventCalendar) {
  return (blocks || []).filter((b) => b.startMs < endMs && b.endMs > startMs
    && !(ignoreEventCalendar && b.calendars.length === 1 && b.calendars[0] === ignoreEventCalendar));
}

module.exports = {
  TZ, eventIdFor, toGoogleEvent, desiredEventsForLead, allIdsForLead, eventSignature, planSync,
  calendarFieldsChanged, busyBlocks, jobsBusy, conflictsWith, WATCHED, weekEventFor,
  desiredEventsForJob, allIdsForJob, jobCalendarFieldsChanged, JOB_WATCHED,
  signEventId, desiredEventForSign, signCalendarFieldsChanged, nyDate,
  knockAddrKey, knockEventId, latestKnockPerDoor, desiredEventForKnock, desiredKnockEvents, knockCalendarFieldsChanged, keepNewestPerDoor,
  weatherLines, leadEventEventId, desiredEventForLeadEvent, eventTaskFieldsChanged,
  orderEventId, desiredEventForOrder, orderFieldsChanged,
};
