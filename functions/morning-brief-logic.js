/**
 * functions/morning-brief-logic.js — the 6:45 am appointment brief, pure.
 *
 * Jo's idea triage ("a scraper that pulls today's calendar meetings,
 * researches each attendee, and emails a brief"), built for a roofer: one
 * email to the OWNER, before the day starts, listing TODAY's appointments
 * with what the CRM already knows about each property. Never a homeowner.
 *
 * No firebase, no network, no clock of its own. functions/morning-brief.js
 * reads Firestore and hands plain docs in; everything that decides what is
 * "today", what goes in the email and how it is escaped lives here so
 * tests/morning-brief-2026-10-01.test.js can drive it with literals.
 *
 * "Today" is the America/New_York calendar day of nowMs — the same rule the
 * .ics feed uses (calendar-feed-logic.nyDateOf). An appointment at 11:30 pm
 * ET last night is yesterday even though it is "today" in UTC.
 *
 * Sources (all owner-tenant, read by morning-brief.js):
 *   appointments/{id}            Cal.com bookings (startTime, leadId)
 *   leads/{id}                   scheduledDate + window (schedule-window.js)
 *                                and the adjuster meeting
 *   leads/{id}/jobs/{jobId}      a customer's OTHER jobs (multi-job) — the
 *                                active one is the lead's own fields
 *   invoices (leadId)            open balance (balanceDue, dollars → cents)
 *   leads/{id}/activity          newest row → last-activity snippet
 *   leads/{id}.stormEvents[]     storm-zone attachments (storm-integration.js)
 *   leads/{id}/storm_proofs      server-verified hail lookups (storm-proof.js)
 * Nothing here calls a weather API: storm lines show only what is on file.
 */
'use strict';

const SW = require('./schedule-window');
const CF = require('./calendar-feed-logic');
const JOBS = require('./jobs-logic');
const roles = require('./stage-roles');
const { isOwedInvoice } = require('./invoice-owed');

const CUSTOMER_URL = 'https://nobigdealwithjoedeal.com/pro/customer.html';
const DASHBOARD_URL = 'https://nobigdealwithjoedeal.com/pro/dashboard.html';
const MAPS_URL = 'https://www.google.com/maps/search/?api=1&query=';
const SNIPPET_MAX = 160;
const MAX_ITEMS = 40;           // a day with more than this is a data problem
const MAX_OTHER_JOBS = 5;

const TYPE = Object.freeze({
  INSPECTION: 'Inspection',
  INSTALL: 'Install',
  REPAIR: 'Repair',
  ADJUSTER: 'Adjuster meeting',
});

// ─── primitives ──────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Plain-text part: strip control characters and collapse whitespace so a
// homeowner-typed note cannot inject header-looking lines or ragged output.
function plain(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x1F\x7F]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  const t = plain(s);
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

const toMs = CF.toMs;
const nyDateOf = CF.nyDateOf;

const NY_HM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
});
/** ms → 'HH:MM' wall clock in America/New_York. */
function nyHm(ms) {
  const parts = {};
  NY_HM.formatToParts(new Date(ms)).forEach((p) => { parts[p.type] = p.value; });
  const h = (+parts.hour) % 24;
  return String(h).padStart(2, '0') + ':' + parts.minute;
}

const NY_LONG = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric',
});
function nyLongDate(ms) { return NY_LONG.format(new Date(ms)); }

function fmtCents(c) {
  const n = Math.round(Number(c) || 0);
  const s = (Math.abs(n) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (n < 0 ? '-$' : '$') + s;
}

function telHref(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  return d ? 'tel:' + d : '';
}

function customerUrl(leadId) {
  return CUSTOMER_URL + '?id=' + encodeURIComponent(String(leadId));
}

function mapsUrl(address) {
  return MAPS_URL + encodeURIComponent(String(address));
}

function fullName(o) {
  return `${(o && o.firstName) || ''} ${(o && o.lastName) || ''}`.trim();
}

// ─── what kind of visit is it ────────────────────────────────────

/** Text says what it is → a TYPE, or null when the words don't say. */
function typeFromText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/adjust/.test(t)) return TYPE.ADJUSTER;
  if (/repair|leak|patch|warranty|fix\b/.test(t)) return TYPE.REPAIR;
  if (/inspect|estimate|assess|consult|quote|free roof/.test(t)) return TYPE.INSPECTION;
  if (/install|replace|re-?roof|tear.?off|new roof/.test(t)) return TYPE.INSTALL;
  return null;
}

/**
 * A scheduled lead/job day → its TYPE. The job's own words first (subType,
 * jobType, title); then the pipeline: a job-stage lead (crew scheduled,
 * install in progress) is an install, a won one back on the calendar is
 * warranty/repair work, anything earlier is an inspection.
 */
function typeForJob(view) {
  const v = view || {};
  const fromText = typeFromText([v.subType, v.jobType, v._jobTitle].filter(Boolean).join(' '));
  if (fromText && fromText !== TYPE.ADJUSTER) return fromText;
  const role = roles.roleFor(v);
  if (role === roles.ROLE.JOB) return TYPE.INSTALL;
  if (role === roles.ROLE.WON) return TYPE.REPAIR;
  return TYPE.INSPECTION;
}

/** A Cal.com booking → its TYPE. Online bookings are inspections unless the words say otherwise. */
function typeForAppointment(appt) {
  const t = typeFromText([appt && appt.title, appt && appt.description].filter(Boolean).join(' '));
  return t || TYPE.INSPECTION;
}

// ─── today's items ───────────────────────────────────────────────

/**
 * Every appointment / job day / adjuster meeting on the New York calendar
 * day of nowMs, sorted: all-day items first, then by start time.
 *
 * @param {object} o
 * @param {object[]} o.appointments raw appointment docs (id included)
 * @param {object[]} o.leads        raw owner lead docs (id included)
 * @param {object[]} o.jobs         raw job docs, each with leadId + id
 * @param {number}   o.nowMs
 * @returns {object[]} items: { key, source, type, leadId, jobId, name,
 *   address, phone, sortMs, timeLabel, allDay, title }
 */
function collectTodayItems(o) {
  const opts = o || {};
  const nowMs = Number(opts.nowMs);
  const today = nyDateOf(nowMs);
  const leads = (Array.isArray(opts.leads) ? opts.leads : []).filter((l) => l && l.id && l.deleted !== true);
  const leadsById = new Map(leads.map((l) => [String(l.id), l]));
  const items = [];

  // 1. Cal.com appointments whose start is on today's NY day.
  const appts = [];
  for (const raw of (Array.isArray(opts.appointments) ? opts.appointments : [])) {
    const a = CF.normalizeAppointment(raw);
    if (!a || nyDateOf(a.startMs) !== today) continue;
    appts.push(a);
    const lead = a.leadId ? leadsById.get(String(a.leadId)) : null;
    const startHm = nyHm(a.startMs);
    const durMin = Math.max(0, Math.round((a.endMs - a.startMs) / 60000));
    items.push({
      key: 'appt:' + a.id,
      source: 'appointment',
      type: typeForAppointment(raw),
      leadId: lead ? String(lead.id) : (a.leadId ? String(a.leadId) : null),
      jobId: null,
      name: (lead && fullName(lead)) || a.attendeeName || a.title || 'Appointment',
      address: (lead && lead.address) || a.location || '',
      phone: (lead && lead.phone) || a.attendeePhone || '',
      title: a.title || '',
      sortMs: a.startMs,
      allDay: false,
      timeLabel: SW.timeLabel({ start: startHm, durationMin: durMin > 0 && durMin < SW.MAX_DURATION_MIN ? durMin : null }),
    });
  }

  // 2. Job days: the lead's own (active) job, and each OTHER job laid over
  //    its customer (jobs-logic.jobView, the calendar's overlay).
  const views = [];
  for (const l of leads) views.push({ view: l, leadId: String(l.id), jobId: l.activeJobId || null, jobTitle: null, other: false });
  for (const j of (Array.isArray(opts.jobs) ? opts.jobs : [])) {
    if (!j || !j.leadId || !j.id) continue;
    const lead = leadsById.get(String(j.leadId));
    if (!lead || lead.activeJobId === j.id) continue;   // the active job IS the lead's fields
    if (j.deleted === true) continue;
    const view = Object.assign(JOBS.jobView(lead, j), { id: lead.id, _jobTitle: j.title || null });
    views.push({ view, leadId: String(lead.id), jobId: String(j.id), jobTitle: j.title || null, other: true });
  }

  // A booking on the lead today already shows the visit; drop the lead's own
  // job day (the feed's dedupLeads rule). Other jobs keep their own line.
  const bookedToday = new Set(appts.filter((a) => a.leadId).map((a) => String(a.leadId)));

  for (const { view, leadId, jobId, jobTitle, other } of views) {
    if (SW.coversDay(view, today) && !(bookedToday.has(leadId) && !other)) {
      const w = SW.normalize(view);
      const dayN = SW.parseYmd(today).day - SW.parseYmd(w.date).day + 1;
      const timed = w.start != null;
      const timeBits = [];
      if (timed) timeBits.push(dayN === 1 ? SW.timeLabel(w) : SW.fmtTime12(hmToMin(w.start)));
      else timeBits.push('All day');
      if (w.days > 1) timeBits.push('day ' + dayN + ' of ' + w.days);
      items.push({
        key: 'job:' + leadId + '/' + (jobId || '-'),
        source: 'job',
        type: typeForJob(view),
        leadId,
        jobId: jobId || null,
        name: fullName(view) || view.address || 'Scheduled job',
        address: view.address || '',
        phone: view.phone || '',
        title: jobTitle || '',
        sortMs: timed ? SW.localToUtcMs(today, w.start) : null,
        allDay: !timed,
        timeLabel: timeBits.join(' · '),
      });
    }
    // Adjuster meeting on this job/lead today.
    const adj = CF.normalizeAdjusterMeeting(view);
    if (adj && adj.date === today) {
      items.push({
        key: 'adj:' + leadId + '/' + (jobId || '-'),
        source: 'adjuster',
        type: TYPE.ADJUSTER,
        leadId,
        jobId: jobId || null,
        name: fullName(view) || view.address || 'Claim',
        address: view.address || '',
        phone: view.phone || '',
        title: jobTitle || '',
        sortMs: adj.startMs,
        allDay: adj.startMs == null,
        timeLabel: adj.startMs == null ? 'All day' : SW.fmtTime12(hmToMin(view.adjusterMeetingStart)),
        adjusterName: adj.adjusterName,
        adjusterPhone: adj.adjusterPhone,
        carrier: adj.carrier,
        claimNumber: adj.claimNumber,
      });
    }
  }

  // Dedup by key (a doc read twice through companyId + userId lanes).
  const seen = new Set();
  const out = items.filter((it) => (seen.has(it.key) ? false : (seen.add(it.key), true)));
  out.sort((a, b) => {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    const as = a.sortMs == null ? 0 : a.sortMs, bs = b.sortMs == null ? 0 : b.sortMs;
    if (as !== bs) return as - bs;
    return String(a.name).localeCompare(String(b.name)) || a.key.localeCompare(b.key);
  });
  return out.slice(0, MAX_ITEMS);
}

function hmToMin(hm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
}

// ─── property history ────────────────────────────────────────────

function yearOf(job) {
  const ms = toMs(job.closedAt) || toMs(job.stageStartedAt) || null;
  if (ms) return nyDateOf(ms).slice(0, 4);
  const sd = SW.parseYmd(job.scheduledDate);
  if (sd) return String(sd.y);
  const c = toMs(job.createdAt);
  return c ? nyDateOf(c).slice(0, 4) : '';
}

/**
 * Open balance in cents across the lead's invoices. Only owed invoices count
 * (invoice-owed.js): void / cancelled / deleted, and drafts — never sent, incl.
 * the draft deposit invoice the server makes on a signed contract.
 */
function openBalanceCents(invoices) {
  let total = 0;
  for (const inv of (Array.isArray(invoices) ? invoices : [])) {
    if (!isOwedInvoice(inv)) continue;
    let bal;
    if (inv.balanceDue != null && Number.isFinite(Number(inv.balanceDue))) bal = Math.round(Number(inv.balanceDue) * 100);
    else if (inv.total != null) bal = Math.round(Number(inv.total) * 100) - Math.round((Number(inv.amountPaid) || 0) * 100);
    else continue;
    if (Number.isFinite(bal) && bal > 0) total += bal;
  }
  return total;
}

function lastActivity(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  if (!list.length) return null;
  const newest = list.slice().sort((a, b) => (toMs(b.createdAt) || 0) - (toMs(a.createdAt) || 0))[0];
  const body = newest.text || newest.message || newest.note || newest.content || newest.body
    || (newest.summary && newest.summary.overview) || newest.transcript || '';
  const label = newest.label || newest.title || String(newest.type || '').replace(/_/g, ' ');
  const snippet = truncate([label, body].filter(Boolean).join(' — '), SNIPPET_MAX);
  if (!snippet) return null;
  const at = toMs(newest.createdAt);
  return { snippet, date: at ? nyLongDate(at) : '' };
}

function fmtDateish(v) {
  const ms = toMs(v);
  return ms ? nyLongDate(ms) + ', ' + nyDateOf(ms).slice(0, 4) : '';
}

/** Storm lines from what is already stored on the lead. [] when nothing is. */
function stormLines(lead, proofs) {
  const out = [];
  const pList = (Array.isArray(proofs) ? proofs : []).filter(Boolean)
    .sort((a, b) => (toMs(b.verifiedAt) || 0) - (toMs(a.verifiedAt) || 0));
  if (pList.length) {
    const p = pList[0];
    const size = Number(p.maxSizeInches);
    const bits = [
      (p.verified ? 'Verified hail' : 'Hail check — not verified')
        + (Number.isFinite(size) && size > 0 ? ' up to ' + size + '"' : ''),
      Number.isFinite(Number(p.hitCount)) ? p.hitCount + ' report' + (Number(p.hitCount) === 1 ? '' : 's')
        + (p.daysBack ? ' in ' + p.daysBack + ' days' : '') : '',
      p.strongestHit && p.strongestHit.at ? 'strongest ' + fmtDateish(p.strongestHit.at) : '',
      p.provider ? String(p.provider).toUpperCase() : '',
    ].filter(Boolean);
    out.push(bits.join(' · '));
  }
  const events = (lead && Array.isArray(lead.stormEvents) ? lead.stormEvents : []).filter(Boolean)
    .sort((a, b) => (toMs(b.effectiveAt) || 0) - (toMs(a.effectiveAt) || 0));
  for (const e of events.slice(0, 2)) {
    const bits = [
      e.zoneName || 'Storm zone',
      String(e.alertType || '').replace(/_/g, ' '),
      e.hailSize ? 'hail ' + e.hailSize : '',
      e.windSpeed ? 'wind ' + e.windSpeed : '',
      fmtDateish(e.effectiveAt),
    ].filter(Boolean);
    out.push(bits.join(' · '));
  }
  return out.map((s) => truncate(s, SNIPPET_MAX));
}

/**
 * The CRM's view of the property behind an item.
 * @returns {{stage, jobType, otherJobs:{count, list:[{title, year}]},
 *   lastActivity, balanceCents, storm:string[]}}
 */
function propertyHistory(item, ctx) {
  const c = ctx || {};
  const lead = item.leadId ? (c.leadsById && c.leadsById.get(String(item.leadId))) : null;
  if (!lead) return null;
  const jobs = (c.jobsByLead && c.jobsByLead.get(String(lead.id))) || [];
  const currentJob = item.jobId || lead.activeJobId || null;
  const job = item.jobId && item.jobId !== lead.activeJobId ? jobs.find((j) => j.id === item.jobId) : null;
  const view = job ? JOBS.jobView(lead, job) : lead;
  const others = jobs.filter((j) => j && j.id !== currentJob && j.deleted !== true);
  return {
    stage: String(view.stage || ''),
    jobType: String(view.subType || view.jobType || '').replace(/_/g, ' '),
    otherJobs: {
      count: others.length,
      list: others.slice(0, MAX_OTHER_JOBS).map((j) => ({ title: j.title || JOBS.titleFor(j), year: yearOf(j) })),
    },
    lastActivity: lastActivity(c.activityByLead && c.activityByLead.get(String(lead.id))),
    balanceCents: openBalanceCents(c.invoicesByLead && c.invoicesByLead.get(String(lead.id))),
    storm: stormLines(lead, c.stormProofsByLead && c.stormProofsByLead.get(String(lead.id))),
  };
}

// ─── render ──────────────────────────────────────────────────────

const STYLES = `
  body { font-family:'Barlow','Segoe UI',Roboto,sans-serif; line-height:1.5; color:#333; background:#f5f5f5; margin:0; padding:0; }
  .container { max-width:640px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden; }
  .header { background:linear-gradient(135deg,#1a3057,#12223d); color:#fff; padding:22px 20px; text-align:center; }
  .header h1 { margin:0 0 4px; font-size:22px; }
  .header p { margin:0; font-size:13px; opacity:.85; }
  .content { padding:18px 16px; }
  .item { border:1px solid #e5e7eb; border-radius:8px; padding:12px 14px; margin-bottom:12px; }
  .when { font-weight:700; color:#BD5728; font-size:14px; }
  .pill { display:inline-block; background:#fef3c7; color:#92400e; font-size:10px; font-weight:700; padding:2px 8px; border-radius:999px; text-transform:uppercase; letter-spacing:.4px; margin-left:6px; }
  .name { font-size:16px; font-weight:700; color:#111827; text-decoration:none; }
  .meta { font-size:13px; color:#4b5563; margin-top:2px; }
  .hist { font-size:12px; color:#6b7280; margin:6px 0 0; padding:0 0 0 16px; }
  .footer { background:#1a3057; color:#94a3b8; padding:14px 20px; text-align:center; font-size:11px; }
  .brief { font-size:13px; color:#1a3057; background:#eef2f7; border-radius:6px; padding:6px 8px; margin-top:6px; }
  .section { margin-top:18px; }
  .section h2 { font-size:15px; margin:0 0 8px; color:#1a3057; border-bottom:2px solid #BD5728; padding-bottom:4px; }
  .row { font-size:13px; padding:6px 0; border-bottom:1px solid #eee; }
  .sub { font-size:12px; color:#6b7280; }
  a { color:#BD5728; }
`;

function historyLines(h) {
  if (!h) return [];
  const lines = [];
  const what = [h.stage ? 'Stage: ' + h.stage : '', h.jobType ? 'Job type: ' + h.jobType : ''].filter(Boolean).join(' · ');
  if (what) lines.push(what);
  if (h.otherJobs.count) {
    lines.push('Other jobs (' + h.otherJobs.count + '): '
      + h.otherJobs.list.map((j) => j.title + (j.year ? ' (' + j.year + ')' : '')).join('; ')
      + (h.otherJobs.count > h.otherJobs.list.length ? '; …' : ''));
  }
  if (h.balanceCents > 0) lines.push('Open balance: ' + fmtCents(h.balanceCents));
  if (h.lastActivity) lines.push('Last activity' + (h.lastActivity.date ? ' (' + h.lastActivity.date + ')' : '') + ': ' + h.lastActivity.snippet);
  for (const s of h.storm) lines.push('Storm: ' + s);
  return lines;
}

function itemHtml(it) {
  const name = escapeHtml(it.name);
  const nameHtml = it.leadId
    ? `<a class="name" href="${escapeHtml(customerUrl(it.leadId))}">${name}</a>`
    : `<span class="name">${name}</span>`;
  const meta = [];
  if (it.title) meta.push(escapeHtml(it.title));
  if (it.address) meta.push(`${escapeHtml(it.address)} · <a href="${escapeHtml(mapsUrl(it.address))}">Map</a>`);
  const tel = telHref(it.phone);
  if (tel) meta.push(`<a href="${escapeHtml(tel)}">${escapeHtml(it.phone)}</a>`);
  if (it.source === 'adjuster') {
    const adj = [it.carrier, it.adjusterName, it.adjusterPhone, it.claimNumber ? 'Claim #' + it.claimNumber : ''].filter(Boolean);
    if (adj.length) meta.push('Adjuster: ' + escapeHtml(adj.join(' · ')));
  }
  const hist = historyLines(it.history).map((l) => `<li>${escapeHtml(l)}</li>`).join('');
  return `
    <div class="item">
      <div><span class="when">${escapeHtml(it.timeLabel)}</span><span class="pill">${escapeHtml(it.type)}</span></div>
      <div style="margin-top:4px;">${nameHtml}</div>
      ${it.briefLine ? `<div class="brief">Brief: ${escapeHtml(it.briefLine)}</div>` : ''}
      ${meta.map((m) => `<div class="meta">${m}</div>`).join('')}
      ${hist ? `<ul class="hist">${hist}</ul>` : ''}
    </div>`;
}

function itemText(it) {
  const out = [];
  out.push(plain(it.timeLabel) + ' — ' + plain(it.type) + ' — ' + plain(it.name));
  if (it.briefLine) out.push('  Brief: ' + plain(it.briefLine));
  if (it.title) out.push('  ' + plain(it.title));
  if (it.address) out.push('  ' + plain(it.address) + '  ' + mapsUrl(it.address));
  if (it.phone) out.push('  ' + plain(it.phone));
  if (it.source === 'adjuster') {
    const adj = [it.carrier, it.adjusterName, it.adjusterPhone, it.claimNumber ? 'Claim #' + it.claimNumber : ''].filter(Boolean);
    if (adj.length) out.push('  Adjuster: ' + plain(adj.join(' · ')));
  }
  for (const l of historyLines(it.history)) out.push('  - ' + plain(l));
  if (it.leadId) out.push('  ' + customerUrl(it.leadId));
  return out.join('\n');
}

// ─── absorbed sections (2026-10-04: ONE morning email) ─────────────
// newLeads    — functions/lead-digest.js gatherDigestRows rows (was 07:00)
// promises    — functions/call-center.js gatherSweep items (was 07:15)
// reviewAsks  — functions/review-request-nudge.js nudgeUser leads (was 08:15)
const SECTION_SHOW = 15;

function sectionCounts(sec) {
  const s = sec || {};
  return {
    newLeads: (s.newLeads || []).length,
    promises: (s.promises || []).length,
    reviewAsks: (s.reviewAsks || []).length,
  };
}
function sectionsHaveContent(sec) {
  const c = sectionCounts(sec);
  return c.newLeads + c.promises + c.reviewAsks > 0;
}
function promiseLine(i) {
  const label = { urgent: 'URGENT', due: 'Due', nofile: 'No customer on file' }[i.kind] || 'Due';
  const what = (i.promises && i.promises.length ? i.promises.join('; ') : i.summary) || '';
  return { label, who: i.who || 'Unknown', what, due: i.due || '', leadId: i.leadId || null };
}
function leadRowName(r) { return r.name || '(no name)'; }
function reviewAskName(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || 'Customer'; }

function sectionsHtml(sec) {
  const s = sec || {};
  const parts = [];
  const nl = s.newLeads || [];
  if (nl.length) {
    parts.push('<div class="section"><h2>New leads — last 24h (' + nl.length + ')</h2>'
      + nl.slice(0, SECTION_SHOW).map((r) => {
        const tel = telHref(r.phone);
        return '<div class="row"><strong>' + escapeHtml(leadRowName(r)) + '</strong>'
          + (tel ? ' · <a href="' + escapeHtml(tel) + '">' + escapeHtml(r.phone) + '</a>' : '')
          + '<div class="sub">' + escapeHtml([r.label, r.when, r.address].filter(Boolean).join(' · ')) + '</div></div>';
      }).join('')
      + (nl.length > SECTION_SHOW ? '<div class="sub">…and ' + (nl.length - SECTION_SHOW) + ' more in the CRM.</div>' : '')
      + '</div>');
  }
  const pr = s.promises || [];
  if (pr.length) {
    parts.push('<div class="section"><h2>You said you&#39;d… (' + pr.length + ')</h2>'
      + pr.slice(0, SECTION_SHOW).map((i) => {
        const p = promiseLine(i);
        const who = p.leadId ? '<a href="' + escapeHtml(customerUrl(p.leadId)) + '">' + escapeHtml(p.who) + '</a>' : escapeHtml(p.who);
        return '<div class="row"><span class="pill">' + escapeHtml(p.label) + '</span> ' + who
          + (p.due ? ' <span class="sub">· ' + escapeHtml(p.due) + '</span>' : '')
          + '<div class="sub">' + escapeHtml(truncate(p.what, 220)) + '</div></div>';
      }).join('')
      + (pr.length > SECTION_SHOW ? '<div class="sub">…and ' + (pr.length - SECTION_SHOW) + ' more on the Call Center&#39;s &quot;Said you&#39;d do&quot; list.</div>' : '')
      + '</div>');
  }
  const ra = s.reviewAsks || [];
  if (ra.length) {
    parts.push('<div class="section"><h2>Ready for a review ask (' + ra.length + ')</h2>'
      + ra.slice(0, SECTION_SHOW).map((l) => '<div class="row"><a href="' + escapeHtml(customerUrl(l.id)) + '">' + escapeHtml(reviewAskName(l)) + '</a>'
        + '<div class="sub">' + escapeHtml(l.jobTitle ? l.jobTitle + ' job wrapped' : 'Job wrapped') + ' — tap "Ask for review" on the customer.</div></div>').join('')
      + '</div>');
  }
  return parts.join('');
}

function sectionsText(sec) {
  const s = sec || {};
  const out = [];
  const nl = s.newLeads || [];
  if (nl.length) {
    out.push('NEW LEADS — last 24h (' + nl.length + ')');
    for (const r of nl.slice(0, SECTION_SHOW)) out.push('  ' + plain(leadRowName(r)) + (r.phone ? '  ' + plain(r.phone) : '') + '  [' + plain([r.label, r.when].filter(Boolean).join(' · ')) + ']' + (r.address ? '\n    ' + plain(r.address) : ''));
    out.push('');
  }
  const pr = s.promises || [];
  if (pr.length) {
    out.push("YOU SAID YOU'D… (" + pr.length + ')');
    for (const i of pr.slice(0, SECTION_SHOW)) { const p = promiseLine(i); out.push('  [' + p.label + '] ' + plain(p.who) + (p.due ? ' · ' + p.due : '') + ' — ' + truncate(p.what, 220) + (p.leadId ? '\n    ' + customerUrl(p.leadId) : '')); }
    out.push('');
  }
  const ra = s.reviewAsks || [];
  if (ra.length) {
    out.push('READY FOR A REVIEW ASK (' + ra.length + ')');
    for (const l of ra.slice(0, SECTION_SHOW)) out.push('  ' + plain(reviewAskName(l)) + '  ' + customerUrl(l.id));
    out.push('');
  }
  return out.join('\n');
}

/**
 * Build the whole brief.
 * @param {object} o  collectTodayItems' inputs plus:
 *   invoices: raw invoice docs (leadId on each)
 *   activityByLead / stormProofsByLead: { [leadId]: docs[] } (or Map)
 * @returns {{ today, items, subject, html, text }}  items [] → nothing to send
 */
function buildBrief(o) {
  const opts = o || {};
  const nowMs = Number(opts.nowMs);
  const items = collectTodayItems(opts);
  const leads = (Array.isArray(opts.leads) ? opts.leads : []).filter((l) => l && l.id);
  const toMap = (m) => (m instanceof Map ? m : new Map(Object.entries(m || {})));
  const jobsByLead = new Map();
  for (const j of (Array.isArray(opts.jobs) ? opts.jobs : [])) {
    if (!j || !j.leadId) continue;
    const k = String(j.leadId);
    if (!jobsByLead.has(k)) jobsByLead.set(k, []);
    jobsByLead.get(k).push(j);
  }
  const invoicesByLead = new Map();
  for (const inv of (Array.isArray(opts.invoices) ? opts.invoices : [])) {
    if (!inv || !inv.leadId) continue;
    const k = String(inv.leadId);
    if (!invoicesByLead.has(k)) invoicesByLead.set(k, []);
    invoicesByLead.get(k).push(inv);
  }
  const ctx = {
    leadsById: new Map(leads.map((l) => [String(l.id), l])),
    jobsByLead,
    invoicesByLead,
    activityByLead: toMap(opts.activityByLead),
    stormProofsByLead: toMap(opts.stormProofsByLead),
  };
  for (const it of items) it.history = propertyHistory(it, ctx);
  // One line per appointment from "Brief me" (lead-brief.js), by lead id.
  const briefLines = toMap(opts.briefLines);
  for (const it of items) if (it.leadId && briefLines.get(String(it.leadId))) it.briefLine = truncate(briefLines.get(String(it.leadId)), 200);
  const sections = opts.sections || null;
  const hasSections = sectionsHaveContent(sections);
  const counts = sectionCounts(sections);
  const extra = [
    counts.newLeads ? counts.newLeads + ' new lead' + (counts.newLeads === 1 ? '' : 's') : '',
    counts.promises ? counts.promises + " said you'd do" : '',
    counts.reviewAsks ? counts.reviewAsks + ' review ask' + (counts.reviewAsks === 1 ? '' : 's') : '',
  ].filter(Boolean).join(' · ');

  const today = nyDateOf(nowMs);
  const dateLabel = nyLongDate(nowMs);
  const n = items.length;
  const firstTimed = items.find((it) => !it.allDay);
  // Sends on a day with no appointments when another section has content.
  const sendable = n > 0 || hasSections;
  const subject = !sendable ? '' : n === 0
    ? `Today (${dateLabel}): no appointments — ${extra}`
    : `Today (${dateLabel}): ${n} appointment${n === 1 ? '' : 's'}`
      + (firstTimed ? ` — first at ${SW.fmtTime12(hmToMin(nyHm(firstTimed.sortMs)))}` : '')
      + (extra ? ` · ${extra}` : '');
  const headline = n === 0 ? 'No appointments today' : `${n} appointment${n === 1 ? '' : 's'} today`;

  const html = !sendable ? '' : `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${headline}</h1>
      <p>NBD Pro · Morning brief · ${escapeHtml(dateLabel)}</p>
    </div>
    <div class="content">
      ${items.map(itemHtml).join('')}
      ${hasSections ? sectionsHtml(sections) : ''}
      <p style="font-size:12px;color:#6b7280;text-align:center;margin-top:16px;">
        From the CRM only — open a customer for the full record. <a href="${DASHBOARD_URL}#settings">Manage email preferences</a>.
      </p>
    </div>
    <div class="footer">
      <p>No Big Deal Home Solutions · internal brief for the account owner</p>
    </div>
  </div>
</body>
</html>`;

  const text = !sendable ? '' : [
    `${headline} — ${dateLabel}`,
    '',
    items.map(itemText).join('\n\n'),
    '',
    hasSections ? sectionsText(sections) : '',
    'Internal brief for the account owner. Preferences: ' + DASHBOARD_URL + '#settings',
  ].join('\n');

  return { today, items, subject, html, text, sendable, sectionCounts: counts };
}

module.exports = {
  TYPE,
  CUSTOMER_URL,
  MAX_ITEMS,
  escapeHtml,
  nyHm,
  typeFromText,
  typeForJob,
  typeForAppointment,
  collectTodayItems,
  openBalanceCents,
  lastActivity,
  stormLines,
  propertyHistory,
  buildBrief,
  sectionsHaveContent,
  sectionsHtml,
  sectionsText,
};
