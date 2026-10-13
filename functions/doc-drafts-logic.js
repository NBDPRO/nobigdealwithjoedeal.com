/**
 * doc-drafts-logic.js — the PURE decisions behind the stage-triggered
 * "Docs to review" queue (Jo, 2026-10-13). functions/doc-drafts.js does the
 * Firestore I/O.
 *
 * When the job spine records a stage event, the server drafts the customer
 * email that belongs to that moment and parks it on the customer card for
 * Jo's review. NOTHING here sends: a draft goes out only from the CRM's Send
 * button (docs/pro/js/doc-drafts-ui.js -> NBDComms.sendEmail).
 *
 *   event                       draft kind          email `kind`  (sendEmail)
 *   contract_signed/deal_accepted  schedule_confirm  appointment   transactional
 *   scheduled (crew scheduled)     crew_reminder     appointment   transactional
 *   installed                      warranty          document      transactional
 *   installed                      thank_you         (none)        COMMERCIAL
 *   paid_in_full                   paid_receipt      receipt       transactional
 *
 * The thank-you carries the review ask, so it has NO kind: functions/
 * email-suppression.js treats an unmarked email as commercial and refuses it
 * for an unsubscribed address. The proposal (estimate shared), the deposit
 * invoice and the final invoice already have their own drafts/paths.
 *
 * Wording rules (documentation/ + memory, 2026-10): the company's name, phone
 * and sign-off come from the TENANT's companyProfile — never hardcoded; the
 * warranty text states the written labor term ONLY for NBD with a sold tier
 * (TIER_LABOR_YEARS, estimate-config.js) and the manufacturer warranty as its
 * own line; anything unknown is a `[[placeholder]]` that blocks Send; no
 * insurance-claim wording at all (Kentucky KRS 367.628); fully-insured only
 * ever by the company profile, never claimed here.
 */
'use strict';

const L = require('./job-spine-logic');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Mirror of docs/pro/js/estimate-config.js TIER_LABOR_YEARS (test-pinned). */
const TIER_LABOR_YEARS = Object.freeze({ economy: 1, good: 5, better: 10, best: 20, beyond: 20 });
const TIER_LABEL = Object.freeze({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' });

const DRAFT_KINDS = Object.freeze({
  schedule_confirm: { emailKind: 'appointment', label: 'Schedule confirmation' },
  crew_reminder:    { emailKind: 'appointment', label: 'Crew date confirmation' },
  warranty:         { emailKind: 'document',    label: 'Warranty summary' },
  thank_you:        { emailKind: '',            label: 'Thank-you + review ask' },
  paid_receipt:     { emailKind: 'receipt',     label: 'Paid-in-full receipt' },
});

// event -> draft kinds, in the order they appear in the queue.
const EVENT_PLAN = Object.freeze({
  contract_signed: ['schedule_confirm'],
  deal_accepted:   ['schedule_confirm'],
  scheduled:       ['crew_reminder'],
  installed:       ['warranty', 'thank_you'],
  paid_in_full:    ['paid_receipt'],
});
const DRAFT_EVENTS = Object.freeze(Object.keys(EVENT_PLAN));

function planFor(event) {
  return (EVENT_PLAN[String(event || '')] || []).slice();
}

function _seg(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60); }
function _validJobId(v) { return (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) ? v : null; }
function _str(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max || 200); }
function _isEmail(v) { return typeof v === 'string' && v.length <= 254 && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v); }

/**
 * The UTC day (YYYYMMDD) the lead entered its current stage — a stable,
 * per-job suffix for a lead with no activeJobId, so a LATER job on the same
 * customer does not silently collide with the first one's draft ids.
 */
function stageDayOf(lead, nowMs) {
  const t = lead && lead.stageStartedAt;
  let ms = NaN;
  if (t && typeof t.toMillis === 'function') ms = t.toMillis();
  else if (t && (typeof t.seconds === 'number' || typeof t._seconds === 'number')) ms = (t.seconds != null ? t.seconds : t._seconds) * 1000;
  else if (typeof t === 'number') ms = t;
  else if (typeof t === 'string') ms = Date.parse(t);
  if (!Number.isFinite(ms)) ms = Number(nowMs) || Date.now();
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}
/** The job part of an id: the job id, else 'nj<stage-entry day>'. */
function jobKeyFor(lead, jobId, nowMs) { return jobId || ('nj' + stageDayOf(lead, nowMs)); }

/** ddraft_<leadId>_<kind>_<jobKey> — one draft per lead + kind + job. */
function draftId(leadId, kind, jobId) {
  return 'ddraft_' + _seg(leadId) + '_' + _seg(kind) + '_' + _seg(jobId || 'job');
}

/** Thumbtack / Yelp customers are reached inside those apps: COPY, not send. */
function isMarketplaceSource(lead) {
  const s = [lead && lead.source, lead && lead.leadSource, lead && lead.sourceChannel]
    .map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
  return /thumbtack|yelp/.test(s);
}

/** 'email' (one-click send) or 'copy' (marketplace customer / no email on file). */
function channelFor(lead) {
  if (isMarketplaceSource(lead)) return 'copy';
  return _isEmail(String((lead && lead.email) || '').trim()) ? 'email' : 'copy';
}

function _isLost(lead) {
  if (!lead) return false;
  if (lead.lost === true) return true;
  return L.normalizeStageKey(lead._stageKey || lead.stage) === 'lost' || String(lead.stageRole || '').toLowerCase() === 'lost';
}

/**
 * Should this kind be drafted for this lead? Pure.
 * → { ok: true } | { ok: false, reason }
 */
function shouldDraft(lead, kind, ctx) {
  if (!lead) return { ok: false, reason: 'no_lead' };
  if (L.isDeleted(lead)) return { ok: false, reason: 'deleted' };
  if (_isLost(lead)) return { ok: false, reason: 'lost' };
  if (String(lead.jobType || '').toLowerCase() === 'warranty') return { ok: false, reason: 'warranty_visit' };
  // Jo's rule: a job marked finished after the fact is silent — no email of
  // any kind is queued for it.
  if (require('./quiet-backfill').isQuietBackfill(lead)) return { ok: false, reason: 'quiet_backfill' };
  if (kind === 'thank_you') {
    if (lead.reviewAskDeclined === true) return { ok: false, reason: 'review_declined' };
    if (!(ctx && ctx.jobId) && lead.reviewRequested === true) return { ok: false, reason: 'already_asked' };
  }
  return { ok: true };
}

// ── Branding (tenant companyProfile, never hardcoded) ─────────────────────
/** → { name, phone, email, reviewUrl, isNbd } — '' for anything the profile lacks. */
function brandOf(profile, tenantKey) {
  const p = (profile && typeof profile === 'object') ? profile : {};
  const b = (p.brand && typeof p.brand === 'object') ? p.brand : {};
  const c = (b.contact && typeof b.contact === 'object') ? b.contact : {};
  const i = (b.integrations && typeof b.integrations === 'object') ? b.integrations : {};
  const name = _str(b.displayName || b.legalName || p.businessName || p.companyName, 80);
  const phone = _str(c.phone || p.businessPhone || p.phone, 40);
  const review = _str(i.reviewUrl, 300);
  return {
    name, phone,
    email: _str(c.email || p.businessEmail, 120),
    reviewUrl: /^https:\/\//i.test(review) ? review : '',
    isNbd: String(tenantKey || '') === NBD_OWNER_UID,
  };
}

const PH = Object.freeze({
  company: '[[company name]]',
  phone: '[[company phone]]',
  review: '[[review link]]',
  warranty: '[[workmanship warranty term — see the signed contract]]',
  date: '[[install date]]',
  amount: '[[amount paid]]',
});

// ── Money (cents) ─────────────────────────────────────────────────────────
function fmtCents(cents) {
  const n = Math.round(Number(cents) || 0);
  const neg = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const dollars = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return neg + '$' + dollars + '.' + String(a % 100).padStart(2, '0');
}

// ── Dates ─────────────────────────────────────────────────────────────────
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function ymdLong(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return '';
  return DOW[d.getUTCDay()] + ', ' + MON[d.getUTCMonth()] + ' ' + (+m[3]);
}
function timeLong(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return '';
  const h = +m[1]; const mi = +m[2];
  if (h > 23 || mi > 59) return '';
  return ((h % 12) || 12) + ':' + String(mi).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function scheduleOf(lead) {
  const day = ymdLong(lead && lead.scheduledDate);
  const t = timeLong(lead && lead.scheduledStart);
  return day ? (t ? day + ' at ' + t : day) : '';
}

// ── Builders ──────────────────────────────────────────────────────────────
function firstNameOf(lead) {
  const l = lead || {};
  const raw = _str(l.firstName || l.name || l.customerName, 80);
  const f = raw.split(' ')[0] || '';
  return /^[A-Za-z][A-Za-z'’.-]{0,30}$/.test(f) ? f : '';
}

function _sign(brand) {
  return '— ' + (brand.name || PH.company) + '\n' + (brand.phone || PH.phone);
}
function _hi(lead) { const f = firstNameOf(lead); return f ? 'Hi ' + f + ',' : 'Hi,'; }

/** The warranty email's two separate warranty lines. → { labor, manufacturer } */
function warrantyLines(tier, isNbd) {
  const t = String(tier || '').toLowerCase();
  const years = TIER_LABOR_YEARS[t];
  let labor;
  if (isNbd && years) {
    labor = 'Workmanship (labor) warranty: ' + years + (years === 1 ? ' year' : ' years') + ' from the installation date, as written in your signed paperwork.';
  } else {
    labor = 'Workmanship (labor) warranty: ' + PH.warranty + '.';
  }
  let manufacturer;
  if (t === 'economy') {
    manufacturer = 'Manufacturer warranty (separate, from the shingle maker): the shingles carry the manufacturer\'s standard limited warranty. No system warranty is included with this package.';
  } else if (t === 'beyond' && isNbd) {
    manufacturer = 'Manufacturer warranty (separate, from TAMKO): the TAMKO HailGuard shingles carry TAMKO\'s HailGuard hail warranty. TAMKO\'s terms apply.';
  } else {
    manufacturer = 'Manufacturer warranty (separate, from the maker of your materials): see your estimate and the manufacturer\'s own paperwork for exactly what it covers.';
  }
  return { labor, manufacturer };
}

/**
 * Build one draft's subject + body. Pure; unknowns become [[placeholders]].
 * ctx: { lead, brand, event, paidCents, tier }
 */
function build(kind, ctx) {
  const lead = (ctx && ctx.lead) || {};
  const brand = (ctx && ctx.brand) || { name: '', phone: '', reviewUrl: '', isNbd: false };
  const co = brand.name || PH.company;
  const hi = _hi(lead);
  const sign = _sign(brand);
  if (kind === 'schedule_confirm') {
    const when = scheduleOf(lead);
    return {
      subject: 'Your project with ' + co + ' — next steps',
      body: hi + '\n\nThanks for signing. Here is what happens next: we order your materials and book your crew. '
        + 'Target start: ' + (when || PH.date) + '.\n\n'
        + 'We will confirm the exact day with you before anyone shows up. If something about the date does not work, reply here or call ' + (brand.phone || PH.phone) + '.\n\n' + sign,
    };
  }
  if (kind === 'crew_reminder') {
    const when = scheduleOf(lead);
    return {
      subject: 'Your crew date with ' + co,
      body: hi + '\n\nYour crew is on the schedule for ' + (when || PH.date) + '.\n\n'
        + 'A few things that help: move cars out of the driveway, and let us know about anything we should watch for around the house. '
        + 'If you need to move the date, call or text ' + (brand.phone || PH.phone) + ' and we will sort it out.\n\n' + sign,
    };
  }
  if (kind === 'warranty') {
    const tier = String((ctx && ctx.tier) || '').toLowerCase();
    const wl = warrantyLines(tier, !!brand.isNbd);
    const pkg = TIER_LABEL[tier] ? 'Your package: ' + TIER_LABEL[tier] + '.\n\n' : '';
    return {
      subject: 'Your warranty summary — ' + co,
      body: hi + '\n\nYour project is complete. Here is a plain summary of your warranty coverage. These are two separate warranties.\n\n'
        + pkg + wl.labor + '\n\n' + wl.manufacturer + '\n\n'
        + 'This is a summary. Your signed paperwork and the manufacturer\'s terms are what control. Keep this email for your records, and call ' + (brand.phone || PH.phone) + ' if anything looks off.\n\n' + sign,
    };
  }
  if (kind === 'thank_you') {
    return {
      subject: 'Thank you — ' + co,
      body: hi + '\n\nThank you for letting us take care of your project. It was a pleasure working on your home.\n\n'
        + 'If you have a minute, a review helps neighbors find a contractor they can trust: ' + (brand.reviewUrl || PH.review) + '\n\n'
        + 'No pressure either way. If anything about the work is not right, tell us first at ' + (brand.phone || PH.phone) + ' and we will make it right.\n\n' + sign,
    };
  }
  if (kind === 'paid_receipt') {
    const cents = Number(ctx && ctx.paidCents);
    const amt = Number.isFinite(cents) && cents > 0 ? fmtCents(cents) : PH.amount;
    return {
      subject: 'Paid in full — receipt from ' + co,
      body: hi + '\n\nThis confirms your project is paid in full. Total received: ' + amt + '.\n\n'
        + 'Thank you. Keep this email as your receipt. If you need a copy of anything, call ' + (brand.phone || PH.phone) + '.\n\n' + sign,
    };
  }
  return null;
}

/** Placeholders still in a string: ['[[x]]', ...]. */
function placeholdersIn(text) {
  return String(text == null ? '' : text).match(/\[\[[^\]]*\]\]/g) || [];
}

/**
 * The whole decision for one (lead, event, kind). Pure.
 * ctx: { leadId, event, kind, lead, profile, tenantKey, jobId, paidCents, nowMs }
 * → { action:'skip', reason } | { action:'create', id, doc }
 */
function decide(ctx) {
  const kind = ctx.kind;
  if (!DRAFT_KINDS[kind]) return { action: 'skip', reason: 'unknown_kind' };
  if (planFor(ctx.event).indexOf(kind) === -1) return { action: 'skip', reason: 'not_planned' };
  const leadId = String(ctx.leadId || '');
  if (!ID_RE.test(leadId)) return { action: 'skip', reason: 'bad_lead_id' };
  const gate = shouldDraft(ctx.lead, kind, { jobId: ctx.jobId });
  if (!gate.ok) return { action: 'skip', reason: gate.reason };
  const lead = ctx.lead;
  const brand = brandOf(ctx.profile, ctx.tenantKey);
  const tier = String(lead.soldTier || '').toLowerCase();
  const text = build(kind, { lead, brand, event: ctx.event, paidCents: ctx.paidCents, tier });
  if (!text) return { action: 'skip', reason: 'no_template' };
  const channel = channelFor(lead);
  const id = draftId(leadId, kind, jobKeyFor(lead, ctx.jobId, ctx.nowMs));
  const spec = DRAFT_KINDS[kind];
  return {
    action: 'create', id,
    doc: {
      status: 'draft',
      kind,
      label: spec.label,
      emailKind: spec.emailKind,   // '' = commercial (thank-you review ask)
      event: String(ctx.event),
      channel,
      to: channel === 'email' ? String(lead.email).trim() : '',
      subject: text.subject,
      body: text.body,
      leadId,
      jobId: ctx.jobId || '',
      companyId: lead.companyId || null,
      userId: lead.userId || null,
      customerName: _str(lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.customerName, 100),
      sourceId: _str(ctx.sourceId, 120),
      // The schedule a date in the text was baked from; the queue re-derives
      // it at send time and blocks when the schedule was cleared.
      scheduleBasis: (kind === 'schedule_confirm' || kind === 'crew_reminder') ? scheduleOf(lead) : '',
    },
  };
}

module.exports = {
  EVENT_PLAN, DRAFT_EVENTS, DRAFT_KINDS, TIER_LABOR_YEARS, TIER_LABEL, PH, NBD_OWNER_UID,
  planFor, draftId, stageDayOf, jobKeyFor, channelFor, isMarketplaceSource, shouldDraft, brandOf, build, decide,
  placeholdersIn, fmtCents, ymdLong, timeLong, scheduleOf, warrantyLines, firstNameOf,
};
