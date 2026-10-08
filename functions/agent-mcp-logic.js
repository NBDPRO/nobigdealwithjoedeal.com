'use strict';
/**
 * agent-mcp-logic.js — pure rules for the NBD CRM connection the Grok Bot
 * team uses (MCP over HTTPS, functions/agent-mcp.js). Plan:
 * documentation/projects/GROKBOT-CRM-INTEGRATION-PLAN-2026-10-02.md.
 *
 * Jo's calls (2026-10-02):
 *   - customer data MINIMIZED: names + addresses where the role needs them,
 *     never phone numbers or email addresses;
 *   - bots never act on a customer — they read, and FILE notes / reminders /
 *     reports into the Agent inbox (agent_inbox/{id}) for Jo to add later;
 *   - CoS, Marcus and Quinn first; the rest of the team after a trial run;
 *     Nova (Eromify) never gets an NBD key.
 *
 * No I/O here. Unit-tested in tests/agent-mcp-2026-10-02.test.js.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'nbd-crm', version: '1.3.0' };
const MAX_TEXT = 2000;
const MAX_LIST = 50;
const LIST_CURSOR_MAX = 400;
// Draft limits (2026-10-06; the draft rules sit above the company-bot section).
const SMS_MAX = 480;
// The STOP line on a draft the owner sends from their OWN phone (review R2-3-1,
// Jo 2026-10-06). "to opt out" promised an opt-out system that never sees the
// reply — it lands on the owner's phone. This wording is true: the owner reads
// it, and records it with "They replied STOP" (phone-text-check.js 'stop').
// TODO(TWILIO_INBOUND_ENABLED): once the business line's inbound is live,
// drafts should go through it, where a STOP is recorded by itself.
const STOP_LINE = "Reply STOP and we'll stop texting.";
const REASON_MAX = 300;
const EMAIL_SUBJECT_MAX = 140;

// ── Tools ──────────────────────────────────────────────────────────────
const TOOLS = {
  crm_summary: {
    description: 'Pipeline at a glance: active customers by stage, open pipeline value (PROJECTED — deals still in play; a signed contract or a job in production is booked, not pipeline; never money received), follow-ups due today and overdue.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  schedule: {
    description: 'What is on the schedule for one day (YYYY-MM-DD): scheduled jobs, adjuster meetings, appointments, and follow-ups due.',
    inputSchema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD' } }, required: ['date'], additionalProperties: false },
  },
  overdue_followups: {
    description: 'Customers whose follow-up date has passed, oldest first (up to 50).',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIST } }, additionalProperties: false },
  },
  list_leads: {
    description: 'Customers, filtered by stage and/or "stale" (no update in N days), newest added first. Returns ONE PAGE (limit, default 20, max 50) of lead_id, name, address, stage, follow-up date and last update — never phone or email — plus total (how many customers match the filters) and next_cursor. One page is NOT the whole list: while next_cursor is not null, call list_leads again with the SAME stage / stale_days and cursor = next_cursor, and keep going until next_cursor is null. Only then do you have every match (check your count against total).',
    inputSchema: { type: 'object', properties: {
      stage: { type: 'string', maxLength: 60, description: 'Pipeline stage key, the same keys crm_summary counts in by_stage, e.g. new, contacted, inspected, estimate_sent_cash, negotiating, contract_signed' },
      stale_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Only customers not updated in this many days' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIST, description: 'Page size (default 20, max 50)' },
      cursor: { type: 'string', maxLength: LIST_CURSOR_MAX, description: 'The next_cursor from the previous page of the SAME query. Leave it out for the first page.' },
    }, additionalProperties: false },
  },
  lead_detail: {
    description: 'One customer: stage, address, damage type, job value, follow-up, last update, the last 5 notes and open reminders. No phone or email.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'], additionalProperties: false },
  },
  file_note: {
    description: 'File a NOTE about one customer into your company\'s Agent inbox. The owner reviews it and adds it to the customer\'s card. Nothing is sent to the customer. Never promise to handle or negotiate an insurance claim.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' }, text: { type: 'string', maxLength: MAX_TEXT } }, required: ['lead_id', 'text'], additionalProperties: false },
  },
  file_reminder: {
    description: 'File a dated REMINDER about one customer into the Agent inbox (e.g. "Call Bob about the gutter quote"). The owner reviews it before it becomes a task. Nothing is sent to the customer.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, text: { type: 'string', maxLength: MAX_TEXT } }, required: ['lead_id', 'due_date', 'text'], additionalProperties: false },
  },
  file_report: {
    description: 'File a REPORT into the Agent inbox (digest, findings, plan) for the owner to read. Not tied to one customer.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 140 }, text: { type: 'string', maxLength: MAX_TEXT } }, required: ['title', 'text'], additionalProperties: false },
  },
  inbox_pending: {
    description: 'Items waiting in the Agent inbox (what the bots have filed and the owner has not decided yet), so they can be fact-checked.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIST } }, additionalProperties: false },
  },
  verify_item: {
    description: 'Fact & compliance check on one pending Agent inbox item: mark it checked (ok=true) or flag it with what is wrong (ok=false). Check it against rules_reference: insurance-claim wording (never "we handle/negotiate your claim"), prices and warranty wording.',
    inputSchema: { type: 'object', properties: { item_id: { type: 'string' }, ok: { type: 'boolean' }, note: { type: 'string', maxLength: 500 } }, required: ['item_id', 'ok'], additionalProperties: false },
  },
  estimates_status: {
    description: 'Each customer\'s latest estimate: the customer-facing total (what the homeowner sees — never cost or margin), tier, when it was made, and the proposal link status (sent / viewed / accepted, view count, last viewed). Filter to one customer, or to proposals sent but not accepted for N+ days ("gone quiet").',
    inputSchema: { type: 'object', properties: {
      lead_id: { type: 'string' },
      quiet_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Only proposals sent or viewed but not accepted, with no view for this many days' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIST },
    }, additionalProperties: false },
  },
  rules_reference: {
    description: 'The company\'s own rules to check anything against: its roof tiers and retail $/SQ, warranty wording and deposit rule where the company has set them, its house rules for bots, general guidance ("revenue" means collected money; cost and margin are never public), and the Kentucky insurance-job lines (what is never said or done on a Kentucky property). Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  post_job: {
    description: 'Customers whose job is finished (installed / final payment / closed), newest first: days since completion, invoice balance still owed, whether a review was requested, warranty certificate tier, and whether the 1-year anniversary touch went out. For after-the-job care: final payment, review asks, referrals, warranty check-ins. No phone or email.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 730, description: 'Only jobs finished in the last N days (default 120)' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST } }, additionalProperties: false },
  },
  lead_sources: {
    description: 'Where customers came from over the last N days (default 90): leads per source (Door Knock, Storm Canvass, Referral, Website, Google, Thumbtack…), how many are won (a signed contract, in production or finished) / lost / still open, win rate, and marketing spend per source with cost per lead where expenses are tagged. Counts only — no customer names.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 730 } }, additionalProperties: false },
  },
  job_profit: {
    description: 'Per finished job: money COLLECTED on its invoices (refunds off) minus the DIRECT costs logged against it (materials, subs, labor, dumpster, permits, disposal — tax included), giving profit and margin. Jobs still being paid show low until the final payment lands. Internal only — never put these cost or margin figures anywhere public.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 730, description: 'Jobs finished in the last N days (default 180)' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST } }, additionalProperties: false },
  },
  storm_near_customers: {
    description: 'Hail / wind / tornado reports from the NWS storm feed (stormWatch) in the last N days (default 14), each with the customers whose address lies within R miles (default 3). For storm response: knock plans, checking a date of loss, proof for an adjuster meeting. Names + addresses only.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 60 }, miles: { type: 'number', minimum: 0.5, maximum: 10 } }, additionalProperties: false },
  },
  team_activity: {
    description: 'What each of the company\'s bots did over the last N days (default 7): tool calls, filings, and how the owner decided them — approved, tossed, still waiting — plus fact-check counts (checked / flagged). Use it to coach the bots: a bot whose filings keep getting tossed needs a different approach. Personal bots are not included.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
  },
  // ── Drafts (2026-10-06): filed for the owner to send; nothing auto-sends ──
  draft_text: {
    description: 'DRAFT a text message to one customer for the owner to send from their own phone. It waits in the Agent inbox; nothing is sent by you or the CRM. The CRM finds the number itself (you never see it) and refuses a customer on the Do-Not-Text list or without a textable number. Max ' + SMS_MAX + ' characters; it must say the company name; "' + STOP_LINE + '" is added if missing. Never promise to handle or negotiate an insurance claim.',
    inputSchema: { type: 'object', properties: {
      lead_id: { type: 'string' },
      body: { type: 'string', maxLength: SMS_MAX },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why this customer, why now (shown to the owner, not the customer)' },
    }, required: ['lead_id', 'body', 'reason'], additionalProperties: false },
  },
  draft_email: {
    description: 'DRAFT an email to one customer for the owner to send from their own mail app. It waits in the Agent inbox; nothing is sent by you or the CRM. The CRM finds the address itself (you never see it) and refuses a customer who unsubscribed. from: "jd" for marketing / follow-ups, "info" for documents / payments.',
    inputSchema: { type: 'object', properties: {
      lead_id: { type: 'string' },
      subject: { type: 'string', maxLength: EMAIL_SUBJECT_MAX },
      body: { type: 'string', maxLength: MAX_TEXT },
      reason: { type: 'string', maxLength: REASON_MAX, description: 'Why this customer, why now (shown to the owner, not the customer)' },
      from: { type: 'string', enum: ['jd', 'info'] },
    }, required: ['lead_id', 'subject', 'body', 'reason', 'from'], additionalProperties: false },
  },
  file_social_draft: {
    description: 'File a social media post DRAFT (caption, optional image link and wished-for date) into the Agent inbox; the owner sends it to Social Studio, where it is checked and approved before anything is posted. Never publishes. brand: "nbd" (the roofing company) or "pro" (the CRM product). No customer names or addresses in a caption.',
    inputSchema: { type: 'object', properties: {
      brand: { type: 'string', enum: ['nbd', 'pro'] },
      platform: { type: 'string', enum: ['facebook', 'instagram', 'gbp', 'tiktok', 'nextdoor', 'linkedin', 'x'] },
      caption: { type: 'string', maxLength: 5000 },
      media_url: { type: 'string', description: 'Optional https:// link to the image or video to use' },
      scheduled_for: { type: 'string', description: 'Optional YYYY-MM-DD or YYYY-MM-DDTHH:MM (Eastern)' },
      reason: { type: 'string', maxLength: REASON_MAX },
    }, required: ['brand', 'platform', 'caption', 'reason'], additionalProperties: false },
  },
  // ── Personal scope (Jo's own tracker; personal keys only) ─────────────
  my_today: {
    description: 'The key owner\'s day in their personal tracker: today\'s floors (their daily promises) met or open, the floor streak ("don\'t miss twice": one miss warns, two in a row end it), and the latest weight. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  my_week: {
    description: 'The key owner\'s week from their tracker: each floor out of 7, full days, the $5-per-miss tax and whether he moved it to savings, the weigh-in rule (7-day average vs last week; not down 0.5 lb → cut 200 calories), the goal weight, and the plain-text weekly scorecard. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  my_money: {
    description: 'The key owner\'s money tab (Finance Board only): their paycheck and how often, the zero-based plan for one paycheck (bills, card minimums, kept subscriptions, auto-saves, spending buffer, emergency fund, extra to the highest-APR card), the emergency fund vs target, each card (nickname, balance, APR, minimum), the payoff order and debt-free estimate, and their subscriptions marked keep / cut. Nicknames and amounts only — never account or card numbers. Read only; the owner edits it in the tracker.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  my_reviews: {
    description: 'The key owner\'s saved Sunday reviews, newest first: floors %, miss tax moved or not, last week\'s hard thing done or not, what they kept, where they bailed, and this week\'s hard thing with its deadline. Hold them to it. Read only.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 12 } }, additionalProperties: false },
  },
  collected_revenue: {
    description: 'Money actually COLLECTED (invoice payments by the date they arrived, refunds subtracted) between two dates. This is the only figure to call "revenue". Defaults to this month. Returns totals, by month, and the top customers by collected amount.',
    inputSchema: { type: 'object', properties: {
      from: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
      to: { type: 'string', description: 'YYYY-MM-DD (inclusive)' },
    }, additionalProperties: false },
  },
};

const READ = ['crm_summary', 'schedule', 'overdue_followups', 'list_leads', 'lead_detail'];
const FILE = ['file_note', 'file_reminder', 'file_report'];

// ── Bots → tools ───────────────────────────────────────────────────────
// Nova is deliberately absent: no NBD key can be made for her.
const BOTS = {
  cos:    { name: 'Chief of Staff', tools: ['crm_summary', 'schedule', 'overdue_followups', 'collected_revenue', 'lead_sources', 'inbox_pending', 'team_activity', 'file_report'] },
  marcus: { name: 'Marcus · NBD Ops', tools: READ.concat(['estimates_status', 'storm_near_customers', 'rules_reference'], FILE, ['draft_text', 'draft_email']) },
  quinn:  { name: 'Quinn · Fact & Compliance', tools: READ.concat(['estimates_status', 'collected_revenue', 'rules_reference', 'storm_near_customers', 'inbox_pending', 'verify_item', 'file_report']) },
  tucker: { name: 'Tucker · Customer Care', tools: ['post_job', 'list_leads', 'lead_detail', 'overdue_followups', 'estimates_status', 'rules_reference', 'file_note', 'file_reminder', 'draft_text', 'draft_email'] },
  dana:   { name: 'Dana · Marketing', tools: ['crm_summary', 'lead_sources', 'rules_reference', 'file_report', 'file_social_draft'] },
  frank:  { name: 'Frank · Finance', tools: ['crm_summary', 'collected_revenue', 'job_profit', 'lead_sources', 'estimates_status', 'post_job', 'file_report', 'file_reminder'] },
  priya:  { name: 'Priya · Product Manager', tools: ['team_activity', 'file_report', 'file_social_draft'] },
  theo:   { name: 'Theo · Venture Scout', tools: ['crm_summary', 'lead_sources', 'file_report'] },
  // Personal side (Jo, 2026-10-02): these read ONLY the key owner's own
  // tracker (userSettings/{ownerUid}.dsSnapshot / dsReviews) — never the CRM.
  // Their keys are made with scope 'personal' and checked on every call.
  coach:  { name: 'Coach · Personal', scope: 'personal', tools: ['my_today', 'my_week', 'my_reviews'] },
  board:  { name: 'Finance Board · Personal', scope: 'personal', tools: ['my_money', 'my_week', 'my_reviews'] },
};
const PERSONAL_TOOLS = ['my_today', 'my_week', 'my_reviews', 'my_money'];
function isPersonalBot(botId) { return Object.prototype.hasOwnProperty.call(BOTS, botId) && BOTS[botId].scope === 'personal'; }
function isPersonalTool(name) { return PERSONAL_TOOLS.indexOf(name) !== -1; }
const FIRST_WAVE = ['cos', 'marcus', 'quinn'];

// MCP tool annotations: every tool is read-only except the three filings
// and Quinn's check, which only add to / mark Jo's Agent inbox — none is
// destructive, and none reaches anything outside the CRM.
const WRITES = ['file_note', 'file_reminder', 'file_report', 'verify_item', 'draft_text', 'draft_email', 'file_social_draft'];
function annotationsFor(name) {
  const w = WRITES.indexOf(name) !== -1;
  return { readOnlyHint: !w, destructiveHint: false, idempotentHint: !w, openWorldHint: false };
}
// A house bot id ('marcus') or an already-resolved bot object → the bot.
function botFor(botOrId) {
  if (botOrId && typeof botOrId === 'object') return botOrId;
  return Object.prototype.hasOwnProperty.call(BOTS, botOrId) ? BOTS[botOrId] : null;
}
function toolsForBot(botOrId) {
  const b = botFor(botOrId);
  return b ? b.tools.filter((n) => Object.prototype.hasOwnProperty.call(TOOLS, n)).map((n) => Object.assign({ name: n }, TOOLS[n], { annotations: annotationsFor(n) })) : [];
}
function botAllows(botOrId, tool) {
  const b = botFor(botOrId);
  return !!b && Array.isArray(b.tools) && b.tools.indexOf(tool) !== -1 && Object.prototype.hasOwnProperty.call(TOOLS, tool);
}

// ── Data shaping (minimization) ────────────────────────────────────────
const CLOSED = /^(closed|lost|cold|dead|archived|cancel)/;
// Stored stage → canonical key before any test (2026-10-04): 'New' / 'Closed
// Won' / 'Complete' were their own buckets here and 'Closed Won' slipped past
// the case-sensitive CLOSED test into the open pipeline. Custom stages keep
// their key; a won-role stage is closed.
const _SRK = require('./stage-roles');
// The ONE money reader (customer-estimate-rows.js moneyValue): legacy text
// jobValue like '$45,000' reads 45000, the same as the CRM (review R2, 2026-10-06).
const { moneyValue } = require('./customer-estimate-rows');
const { jobRecords } = require('./jobs-logic');
function stageKeyOf(l) { return _SRK.canonicalStageKey(l && l.stage) || String((l && l.stage) || 'new'); }
function isClosedLead(l) { const r = _SRK.roleFor(Object.assign({}, l, { _stageKey: stageKeyOf(l) })); return r === 'won' || r === 'lost' || CLOSED.test(stageKeyOf(l)); }
// Out of the OPEN pipeline: closed/lost above, or BOOKED — a signed contract
// or an in-production job (Jo, 2026-10-06; stage-roles.js isSale, the test
// the kanban header, Home KPI tiles and weekly digest use). Follow-ups keep
// isClosedLead: a signed job still has production follow-ups.
function isOutOfPipeline(l) { return isClosedLead(l) || _SRK.isSale(l); }
function ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
}
function ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function isYmd(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }

/** One lead → what a bot may see. NEVER phone / email / financing / claim numbers. */
// Bot-facing dates are the company's calendar day (the same zone as the
// tools' "today", dayInZone) — the UTC date read 9pm ET activity as tomorrow.
// No zone given: America/New_York (nyDay).
function dayOf(v, tz) { const t = ms(v); return t ? nyDay(t, tz) : null; }
function minimalLead(l, tz) {
  const name = ((String(l.firstName || '') + ' ' + String(l.lastName || '')).trim()) || String(l.name || '');
  return {
    lead_id: l.id,
    name,
    address: String(l.address || ''),
    stage: String(l.stage || ''),
    damage_type: String(l.damageType || ''),
    job_value: moneyValue(l.jobValue),
    follow_up: isYmd(l.followUp) ? l.followUp : null,
    last_update: dayOf(l.updatedAt, tz),
  };
}
const FORBIDDEN_KEYS = ['phone', 'email', 'phone2', 'altPhone', 'claimNumber', 'policyNumber', 'ssn', 'dob'];

function activeLeads(leads) {
  return (leads || []).filter((l) => l && l.id && l.deleted !== true && !l.e2eTestData);
}

// jobsByLead (optional): { leadId: [jobs] } — the open pipeline then counts
// every open JOB, like the Home KPI tiles (review R2-2-7, 2026-10-06); the
// customer and follow-up counts stay on the leads.
function summary(leads, todayYmd, jobsByLead) {
  const act = activeLeads(leads);
  const byStage = {};
  let pipeline = 0, dueToday = 0, overdue = 0;
  jobRecords(act, jobsByLead).forEach((r) => {
    if (!isOutOfPipeline(r)) pipeline += moneyValue(r.jobValue);
  });
  act.forEach((l) => {
    const st = stageKeyOf(l);
    byStage[st] = (byStage[st] || 0) + 1;
    const closed = isClosedLead(l);
    if (isYmd(l.followUp) && !closed) {
      if (l.followUp === todayYmd) dueToday++;
      else if (l.followUp < todayYmd) overdue++;
    }
  });
  return { customers: act.length, by_stage: byStage, open_pipeline_value_projected: Math.round(pipeline), followups_due_today: dueToday, followups_overdue: overdue, note: 'Pipeline value is projected: open deals only (a signed contract or a job in production is booked, not pipeline), not money collected.' };
}

function overdueFollowups(leads, todayYmd, limit, tz) {
  return activeLeads(leads)
    .filter((l) => isYmd(l.followUp) && l.followUp < todayYmd && !isClosedLead(l))
    .sort((a, b) => (a.followUp < b.followUp ? -1 : 1))
    .slice(0, clampLimit(limit))
    .map((l) => minimalLead(l, tz));
}

// ── list_leads paging (2026-10-06) ─────────────────────────────────────
// One page was all a bot ever saw (max 50) — NBD has 76 'new' leads, so the
// office sweep could not see 26 of them. Now: a STABLE order (date added,
// newest first; lead id breaks ties — createdAt never changes, so a lead
// edited between pages cannot jump pages), a keyset cursor, and the total.
// The stage filter uses the same canonical stage key as crm_summary's
// by_stage ('New' / '' / 'new' are one bucket), so total matches that count.
//
// The cursor is opaque base64url JSON {v, k, i, t}: k/i = the last lead's
// createdAt ms + id, t = a tag over (company, filters, k, i). A cursor from
// another company or another filter, or with any field edited, fails the tag
// and is refused. It is NOT a secret-keyed MAC: someone who reads this file
// can mint a valid tag for their OWN company + filters, which only moves
// where their own page starts — the company still comes only from the key
// and every row is still minimalLead. No data a bot could not list anyway.
const LIST_CURSOR_RE = /^[A-Za-z0-9_-]{1,400}$/;
const LEAD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_ERR = 'invalid cursor — it must be the next_cursor from the previous page of the same list_leads query. Start again without a cursor.';
const _crypto = require('crypto');
function createdMs(l) { const t = Math.floor(ms(l && l.createdAt)); return Number.isFinite(t) && t > 0 ? t : 0; }
function cmpListOrder(x, y) {
  const d = createdMs(y) - createdMs(x);
  if (d) return d;
  return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
}
function wantStage(stage) {
  const s = String(stage == null ? '' : stage).trim();
  if (!s) return '';
  return _SRK.canonicalStageKey(s) || s;
}
function cursorTag(scope, stage, staleDays, k, i) {
  return _crypto.createHash('sha256').update(['nbd-list-leads-v1', String(scope || ''), stage, String(staleDays || 0), String(k), String(i)].join('')).digest('hex').slice(0, 24);
}
function encodeListCursor(scope, stage, staleDays, lead) {
  const k = createdMs(lead), i = String(lead.id);
  return Buffer.from(JSON.stringify({ v: 1, k, i, t: cursorTag(scope, stage, staleDays, k, i) }), 'utf8').toString('base64url');
}
function decodeListCursor(cur, scope, stage, staleDays) {
  if (typeof cur !== 'string' || !LIST_CURSOR_RE.test(cur)) return null;
  let o;
  try { o = JSON.parse(Buffer.from(cur, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (Object.keys(o).sort().join() !== 'i,k,t,v' || o.v !== 1) return null;
  if (!Number.isSafeInteger(o.k) || o.k < 0) return null;
  if (typeof o.i !== 'string' || !LEAD_ID_RE.test(o.i)) return null;
  if (typeof o.t !== 'string' || o.t !== cursorTag(scope, stage, staleDays, o.k, o.i)) return null;
  return { k: o.k, i: o.i };
}

/**
 * One page of list_leads → { customers, total, next_cursor, page_size } or
 * { error }. scope = the key's company id (binds the cursor to it).
 */
function listLeadsPage(leads, args, nowMs, scope, tz) {
  const a = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
  if (a.stage != null && (typeof a.stage !== 'string' || a.stage.length > 60)) return { error: 'stage must be a pipeline stage key (text)' };
  if (a.stale_days != null && !(Number.isInteger(Number(a.stale_days)) && Number(a.stale_days) >= 1 && Number(a.stale_days) <= 3650)) return { error: 'stale_days must be a whole number from 1 to 3650' };
  if (a.cursor != null && typeof a.cursor !== 'string') return { error: CURSOR_ERR };
  const stage = wantStage(a.stage);
  const staleDays = a.stale_days != null ? Number(a.stale_days) : 0;
  let out = activeLeads(leads);
  if (stage) out = out.filter((l) => stageKeyOf(l) === stage);
  if (staleDays) {
    const cut = nowMs - staleDays * 86400000;
    out = out.filter((l) => ms(l.updatedAt) && ms(l.updatedAt) < cut && !CLOSED.test(String(l.stage || '')));
  }
  out.sort(cmpListOrder);
  const total = out.length;
  let start = 0;
  if (a.cursor != null && a.cursor !== '') {
    const c = decodeListCursor(a.cursor, scope, stage, staleDays);
    if (!c) return { error: CURSOR_ERR };
    // Keyset: the first lead strictly after (k, i) in the order — a lead
    // deleted since the last page does not shift anything.
    start = out.findIndex((l) => createdMs(l) < c.k || (createdMs(l) === c.k && l.id > c.i));
    if (start === -1) start = out.length;
  }
  const size = clampLimit(a.limit);
  const page = out.slice(start, start + size);
  const more = start + page.length < out.length;
  return {
    customers: page.map((l) => minimalLead(l, tz)),
    total,
    next_cursor: more && page.length ? encodeListCursor(scope, stage, staleDays, page[page.length - 1]) : null,
    page_size: size,
  };
}

// First page only (kept for callers that want just the rows).
function listLeads(leads, args, nowMs, scope, tz) {
  const p = listLeadsPage(leads, Object.assign({}, args || {}, { cursor: undefined }), nowMs, scope, tz);
  return p.error ? [] : p.customers;
}

function clampLimit(n) { const v = Math.floor(Number(n)); return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_LIST) : 20; }

// ── Estimates (customer-facing totals only) ────────────────────────────
// grandTotal || total is what the portal shows the homeowner (portal.js);
// rows, costs, markup and margin are never read into the answer.
function estimateTotal(e) { const v = Number(e.grandTotal != null ? e.grandTotal : e.total); return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }
function isoDay(v, tz) { return dayOf(v, tz); }

function estimatesStatus(estimates, deals, leads, args, nowMs, tz) {
  const a = args || {};
  const leadById = {};
  activeLeads(leads).forEach((l) => { leadById[l.id] = l; });
  const latest = {};
  (estimates || []).forEach((e) => {
    if (!e || !e.leadId || e.deleted === true || !leadById[e.leadId]) return;
    const cur = latest[e.leadId];
    if (!cur || ms(e.createdAt) > ms(cur.createdAt)) latest[e.leadId] = e;
  });
  const dealFor = {};
  (deals || []).forEach((d) => {
    if (!d) return;
    const k = d.estimateId || d.leadId;
    if (!k) return;
    const cur = dealFor[k];
    if (!cur || ms(d.createdAt || d.sentAt) > ms(cur.createdAt || cur.sentAt)) dealFor[k] = d;
  });
  let out = Object.keys(latest).map((leadId) => {
    const e = latest[leadId];
    const d = dealFor[e.id] || dealFor[leadId] || null;
    return {
      lead_id: leadId,
      name: minimalLead(leadById[leadId]).name,
      stage: String(leadById[leadId].stage || ''),
      estimate_id: e.id,
      total_customer_facing: estimateTotal(e),
      tier: String(e.tier || e.tierName || ''),
      made: isoDay(e.createdAt, tz),
      proposal: d ? {
        status: String(d.status || 'sent'),
        sent: isoDay(d.sentAt || d.createdAt, tz),
        views: Number(d.viewCount) || 0,
        last_viewed: isoDay(d.lastViewedAt || d.viewedAt, tz),
      } : null,
    };
  });
  if (a.lead_id) out = out.filter((r) => r.lead_id === String(a.lead_id));
  if (a.quiet_days) {
    const cut = nowMs - Number(a.quiet_days) * 86400000;
    out = out.filter((r) => r.proposal && r.proposal.status !== 'accepted' && !CLOSED.test(r.stage)
      && Date.parse(r.proposal.last_viewed || r.proposal.sent || '1970-01-01') < cut);
  }
  return out.sort((x, y) => String(y.made || '').localeCompare(String(x.made || ''))).slice(0, clampLimit(a.limit));
}

// ── Rules reference (Quinn + anyone writing copy) ──────────────────────
// Mirrors docs/pro/js/estimate-config.js (TIER_RATES, TIER_DISPLAY,
// WORKMANSHIP_WARRANTY, DEPOSIT_RULE) — tests/agent-mcp-roles-v2 loads that
// file and fails on any drift. Kentucky lines come from the server's own
// copy of the jurisdiction module.
const TIERS = [
  { key: 'economy', label: 'Economy', ratePerSq: 440, warranty: '1-year written workmanship (labor) warranty plus the shingle maker\'s limited warranty; no system warranty; not transferable', crmOnly: true, notes: 'Never 3-tab shingles.' },
  // GAF System Plus (Standard and up, Jo 2026-10-05) is GAF's MANUFACTURER
  // warranty, included in the tier price — never sold as a separate line,
  // never described as workmanship.
  { key: 'good', label: 'Standard', ratePerSq: 550, warranty: '5-year written workmanship (labor) warranty; not transferable; GAF System Plus warranty included (GAF manufacturer warranty on the shingles + qualifying GAF accessories, not workmanship)' },
  { key: 'better', label: 'Preferred', ratePerSq: 660, warranty: '10-year written workmanship (labor) warranty; transferable to one later owner within 30 days of sale; GAF System Plus warranty included (GAF manufacturer warranty on the shingles + qualifying GAF accessories, not workmanship)' },
  { key: 'best', label: 'Elite', ratePerSq: 770, warranty: '20-year written workmanship (labor) warranty; fully transferable; annual inspection; GAF System Plus warranty included (GAF manufacturer warranty on the shingles + qualifying GAF accessories, not workmanship)' },
  { key: 'beyond', label: 'Beyond', ratePerSq: 880, warranty: '20-year written workmanship (labor) warranty; fully transferable; annual inspection (Elite terms) plus TAMKO\'s hail warranty; no GAF System Plus (not a GAF roof)', crmOnly: true, notes: 'Locked to TAMKO HailGuard shingles.' },
];
// The NBD Pledge (Jo, 2026-10-06): a PROMISE on every NBD job, every tier —
// never call it (or anything) a "lifetime warranty". Same text as
// docs/pro/js/estimate-config.js PLEDGE_PROMISE (pinned by test).
const PLEDGE_PROMISE = 'NBD Pledge: for as long as you own the home, we\'ll come back and make it right.';
const WORKMANSHIP_YEARS = { gutter_system: 5, guard_only: 2, install_default: 2, repair: 1, none: 0 };
const DEPOSIT = { cashNoDepositUnderCents: 200000, cashDepositPct: 50, insurance: 'Kentucky insurance job: nothing due at signing; deductible + ACV due after the carrier\'s written decision and the 5-business-day cancellation window.' };
let KY = null;
try { KY = require('./ky-insurance-law'); } catch (_) { KY = null; }
function rulesReference() {
  const msg = (KY && KY.MSG) || {};
  return {
    tiers: TIERS.map((t) => Object.assign({}, t)),
    tier_note: 'Per-SQ retail rates exclude delivery and add-ons. Economy and Beyond are CRM-only (not on the public site). Older jobs keep the year and "priced in <year>" context.',
    workmanship_warranty_years: Object.assign({}, WORKMANSHIP_YEARS),
    repair_warranty_note: 'Repairs carry 1 year only when the rep ticks the box.',
    pledge: PLEDGE_PROMISE,
    pledge_note: 'The NBD Pledge is a promise on every NBD job, every tier. It is not a warranty term: the written labor warranty is by package (1 to 20 years, above). Never write "lifetime warranty" or "lifetime workmanship", and never call a product warranty lifetime.',
    deposit: { cash_under_2000: 'no deposit', cash_2000_and_up: DEPOSIT.cashDepositPct + '% at signing', insurance: DEPOSIT.insurance },
    kentucky_insurance_jobs: {
      never_say: ['we handle your claim', 'we negotiate with your insurance', 'we manage / deal with / fight the adjuster for you'],
      never_do: ['Assignment of Benefits or Direction to Pay', 'take payment before the carrier\'s written decision + 5 business days (emergency tarp/repair excepted)', 'give the insured more than $100 in value'],
      say_instead: 'We document the damage and meet the adjuster; the claim stays the homeowner\'s.',
      crm_messages: { depositHold: msg.depositHold || null, payLinkHeld: msg.payLinkHeld || null, aobRetired: msg.aobRetired || null },
    },
    house_rules: [
      'Crews are independent subcontractors carrying their own insurance; never write "in-house crews" or W-2 employees. Jo is on every roof; no salespeople.',
      '"Revenue" means money collected (payments by date received). Estimates, contracts and pipeline are projected.',
      'Never publish cost, contractor price or margin figures anywhere public. Retail prices are fine.',
      'Two emails on purpose: jd@ for marketing and Zelle (Zelle: (859) 420-7382 or jd@), info@ for documents. Never merge them.',
    ],
  };
}

// ── Finished jobs / sources / profit / storms ──────────────────────────
const SR = (() => { try { return require('./stage-roles'); } catch (_) { return null; } })();
const { isOwedInvoice } = require('./invoice-owed');
function roleOf(l) { return SR && typeof SR.roleFor === 'function' ? SR.roleFor(l) : (CLOSED.test(String(l.stage || '')) ? 'won' : 'active'); }
function completedMs(l) { return ms(l.completedAt) || ms(l.installCompletedAt) || ms(l.stageStartedAt) || ms(l.updatedAt); }
function balanceByLead(invoices) {
  const out = {};
  (invoices || []).forEach((inv) => {
    // Owed only (invoice-owed.js) — a draft, incl. the server's draft deposit
    // invoice, was never sent and is not owed.
    if (!inv || !inv.leadId || !isOwedInvoice(inv)) return;
    const b = parseFloat(inv.balanceDue);
    if (b > 0) out[inv.leadId] = Math.round(((out[inv.leadId] || 0) + b) * 100) / 100;
  });
  return out;
}
function postJob(leads, invoices, nowMs, args, tz) {
  const a = args || {};
  const cut = nowMs - (Math.min(Math.max(Math.floor(Number(a.days)) || 120, 1), 730)) * 86400000;
  const owed = balanceByLead(invoices);
  return activeLeads(leads).filter((l) => roleOf(l) === 'won' && completedMs(l) >= cut)
    .sort((x, y) => completedMs(y) - completedMs(x)).slice(0, clampLimit(a.limit)).map((l) => {
      const done = completedMs(l);
      return Object.assign(minimalLead(l, tz), {
        finished: done ? nyDay(done, tz) : null,
        days_since: done ? Math.floor((nowMs - done) / 86400000) : null,
        balance_owed: owed[l.id] || 0,
        review_requested: l.reviewRequested === true || !!ms(l.reviewRequestedAt),
        warranty_tier: (l.warranty && (l.warranty.tierLabel || l.warranty.tier)) || null,
        anniversary_touch_sent: !!ms(l.anniversaryTouchedAt),
      });
    });
}
function leadSources(leads, expenses, nowMs, days) {
  const d = Math.min(Math.max(Math.floor(Number(days)) || 90, 7), 730);
  const cut = nowMs - d * 86400000;
  const rows = {};
  const row = (k) => (rows[k] = rows[k] || { source: k, leads: 0, won: 0, lost: 0, open: 0, spend: 0 });
  activeLeads(leads).forEach((l) => {
    const t = ms(l.createdAt) || ms(l.updatedAt);
    if (!t || t < cut) return;
    const r = row(String(l.source || '').trim() || 'Unknown'); r.leads++;
    // Won = THE sale test (stage-roles.js isSale: won, in production or
    // Contract Signed), the same set as the CRM's lead-source table — the won
    // role alone counted a signed contract as open.
    if (_SRK.isSale(l)) r.won++; else if (roleOf(l) === 'lost') r.lost++; else r.open++;
  });
  (expenses || []).forEach((e) => {
    if (!e || !e.marketingSource || e.deleted === true) return;
    const t = Date.parse(e.date) || ms(e.createdAt);
    if (!t || t < cut) return;
    row(String(e.marketingSource).trim()).spend += (Number(e.amountCents) || 0) + (Number(e.taxCents) || 0);
  });
  const out = Object.values(rows).map((r) => ({
    source: r.source, leads: r.leads, won: r.won, lost: r.lost, open: r.open,
    win_rate: (r.won + r.lost) ? Math.round(r.won / (r.won + r.lost) * 100) : null,
    spend: r.spend ? r.spend / 100 : 0,
    cost_per_lead: r.spend && r.leads ? Math.round(r.spend / r.leads) / 100 : null,
  })).sort((x, y) => y.leads - x.leads);
  return { days: d, sources: out, note: 'win_rate = won ÷ decided (won + lost). Spend counts expenses tagged with a marketing source.' };
}
const DIRECT = 'direct';
// jobsByLead (optional, { leadId: [jobs] }): the finished jobs are JOB
// records (jobs-logic.js jobRecords — the rule every other money surface
// uses), so a repeat customer whose card moved on to a signed second job
// still shows the finished first job (review R6-2-10). An invoice or expense
// that names its job (jobId) lands on that job; one that names none is the
// customer's and lands on one finished job of theirs (the card's own job when
// it is finished, else the latest), so nothing is counted twice.
function jobProfit(leads, invoices, expenses, nowMs, args, tz, jobsByLead) {
  const a = args || {};
  const cut = nowMs - (Math.min(Math.max(Math.floor(Number(a.days)) || 180, 7), 730)) * 86400000;
  const recs = jobRecords(activeLeads(leads), jobsByLead);
  const jobOf = (r) => r._jobId || r.activeJobId || null;
  const known = {};
  recs.forEach((r) => { const j = jobOf(r); if (j) known[r.id + '/' + j] = 1; });
  const got = {}, cost = {};
  const add = (map, leadId, jobId, cents) => {
    const k = (jobId && known[leadId + '/' + jobId]) ? leadId + '/' + jobId : leadId;
    map[k] = (map[k] || 0) + cents;
  };
  (invoices || []).forEach((inv) => {
    if (!inv || !inv.leadId || inv.deleted === true || inv.e2eTestData) return;
    paymentsOf(inv).forEach((p) => add(got, inv.leadId, inv.jobId, Math.round(p.amount * 100)));
  });
  (expenses || []).forEach((e) => {
    if (!e || !e.leadId || e.deleted === true || e.costType !== DIRECT) return;
    add(cost, e.leadId, e.jobId, (Number(e.amountCents) || 0) + (Number(e.taxCents) || 0));
  });
  // A non-card job's finish date is its own (stage start / close), not the
  // customer's latest edit.
  const finishedMs = (r) => (r._jobId ? (ms(r.stageStartedAt) || ms(r.closedAt) || completedMs(r)) : completedMs(r));
  const done = recs.filter((r) => roleOf(r) === 'won' && finishedMs(r) >= cut);
  const home = {};
  done.forEach((r) => {
    const h = home[r.id];
    if (!h || (h._jobId && (!r._jobId || finishedMs(r) > finishedMs(h)))) home[r.id] = r;
  });
  const jobs = done.map((r) => {
    const j = jobOf(r), own = j ? r.id + '/' + j : null;
    const shared = home[r.id] === r;
    const c = (own ? got[own] || 0 : 0) + (shared ? got[r.id] || 0 : 0);
    const k = (own ? cost[own] || 0 : 0) + (shared ? cost[r.id] || 0 : 0);
    return { lead_id: r.id, job_id: j, name: minimalLead(r).name, finished: nyDay(finishedMs(r), tz),
      collected: c / 100, direct_costs: k / 100, profit: (c - k) / 100, margin_pct: c > 0 ? Math.round((c - k) / c * 100) : null,
      costs_logged: k > 0 };
  }).sort((x, y) => String(y.finished).localeCompare(String(x.finished))).slice(0, clampLimit(a.limit));
  const tc = jobs.reduce((s, j) => s + Math.round(j.collected * 100), 0), tk = jobs.reduce((s, j) => s + Math.round(j.direct_costs * 100), 0);
  return { jobs, totals: { collected: tc / 100, direct_costs: tk / 100, profit: (tc - tk) / 100, margin_pct: tc > 0 ? Math.round((tc - tk) / tc * 100) : null },
    note: 'INTERNAL. Collected money minus direct job costs. A job with no costs logged (costs_logged false) overstates profit until its receipts are added.' };
}
function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, toR = (x) => x * Math.PI / 180;
  const dLa = toR(la2 - la1), dLo = toR(lo2 - lo1);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function stormNearCustomers(events, leads, nowMs, args) {
  const a = args || {};
  const days = Math.min(Math.max(Math.floor(Number(a.days)) || 14, 1), 60);
  const miles = Math.min(Math.max(Number(a.miles) || 3, 0.5), 10);
  const cut = nowMs - days * 86400000;
  const located = activeLeads(leads).filter((l) => Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)) && (Number(l.lat) || Number(l.lng)));
  const out = (events || []).filter((e) => e && Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lon)) && (Date.parse(e.valid) || ms(e.processedAt)) >= cut)
    .sort((x, y) => (Date.parse(y.valid) || ms(y.processedAt)) - (Date.parse(x.valid) || ms(x.processedAt)))
    .slice(0, 25).map((e) => {
      const near = located.map((l) => ({ l, d: haversineMi(Number(e.lat), Number(e.lon), Number(l.lat), Number(l.lng)) }))
        .filter((x) => x.d <= miles).sort((x, y) => x.d - y.d);
      return { kind: String(e.kind || ''), size: e.mag != null ? Number(e.mag) : null, where: [e.city, e.county, e.st].filter(Boolean).join(', '),
        when: String(e.valid || ''), report: String(e.typetext || ''),
        customers_within: near.length, customers: near.slice(0, 15).map((x) => ({ lead_id: x.l.id, name: minimalLead(x.l).name, address: String(x.l.address || ''), stage: String(x.l.stage || ''), miles: Math.round(x.d * 10) / 10 })) };
    });
  return { days, miles, events: out, customers_without_location: activeLeads(leads).length - located.length,
    note: 'NWS local storm reports (area reports, not per-roof proof). Never promise a homeowner their claim will be paid.' };
}

// ── Team activity (CoS) ────────────────────────────────────────────────
// audits: agent_audit docs {botId, tool, ok, at}; items: agent_inbox docs
// {botId, bot, kind, status, verified, quinnNote, createdAt}. Personal bots
// are never reported to the business side.
// roster: { botKey: { name, scope } } — the bots to report on (default: the
// house roster). A company's own bots are keyed 'c_<id>' (customBotKey).
function teamActivity(audits, items, nowMs, days, roster) {
  const R = roster || BOTS;
  const has = (id) => Object.prototype.hasOwnProperty.call(R, id) && !!R[id] && R[id].scope !== 'personal';
  const d = Math.min(Math.max(Math.floor(Number(days)) || 7, 1), 30);
  const cut = nowMs - d * 86400000;
  const rows = {};
  const row = (id) => (rows[id] = rows[id] || { bot: R[id] ? R[id].name : id, calls: 0, failed_calls: 0, filed: 0, approved: 0, tossed: 0, waiting: 0, quinn_checked: 0, quinn_flagged: 0 });
  (audits || []).forEach((a) => {
    if (!a || !has(a.botId) || ms(a.at) < cut) return;
    const r = row(a.botId); r.calls++; if (a.ok === false) r.failed_calls++;
  });
  (items || []).forEach((i) => {
    if (!i || !has(i.botId) || ms(i.createdAt) < cut) return;
    const r = row(i.botId); r.filed++;
    if (i.status === 'approved' || i.status === 'sent_by_owner') r.approved++; else if (i.status === 'dismissed') r.tossed++; else r.waiting++;
    if (i.verified === true) r.quinn_checked++; else if (i.quinnNote) r.quinn_flagged++;
  });
  const out = Object.keys(R).filter(has).map((id) => Object.assign({ bot_id: id }, row(id)));
  out.forEach((r) => { const decided = r.approved + r.tossed; r.approval_rate = decided ? Math.round(r.approved / decided * 100) : null; });
  return { days: d, bots: out, note: 'approval_rate = approved ÷ (approved + tossed). Silent bots (0 calls) may need a nudge or a different cadence.' };
}

// ── Personal tracker (snapshot the tracker publishes; nothing recomputed) ──
// The tracker writes userSettings/{uid}.dsSnapshot on every dashboard paint
// (review-ui.js). The server only reads and trims it, so a bot sees exactly
// what Jo's screen shows. Strings are length-capped; unknown keys dropped.
const cap = (s, n) => String(s == null ? '' : s).slice(0, n);
const numOr = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
function snapshotAge(snap, nowMs) {
  const at = numOr(snap && snap.asOf);
  return at ? Math.max(0, Math.round((nowMs - at) / 3600000)) : null;
}
function personalToday(snap, nowMs) {
  const s = snap || {};
  if (!s.asOf) return { note: 'The tracker has not published yet — the owner needs to open it once (Daily tracker → dashboard).' };
  const t = s.today || {};
  return {
    as_of_hours_ago: snapshotAge(s, nowMs), day: cap(t.dk, 10),
    floors: (Array.isArray(t.floors) ? t.floors : []).slice(0, 12).map((f) => ({ floor: cap(f.label, 60), met: f.met === true })),
    all_met: t.allMet === true,
    streak: s.streak ? { days: numOr(s.streak.count) || 0, missed_yesterday: s.streak.warned === true, ended: s.streak.broken === true } : null,
    weight: s.weight ? { latest: numOr(s.weight.latest), avg7: numOr(s.weight.avg7) } : null,
  };
}
function personalWeek(snap, nowMs) {
  const s = snap || {};
  if (!s.asOf) return { note: 'The tracker has not published yet — the owner needs to open it once.' };
  const w = s.week || {};
  return {
    as_of_hours_ago: snapshotAge(s, nowMs), from: cap(w.from, 10), to: cap(w.to, 10),
    floors_pct: numOr(w.pct), full_days: numOr(w.fullDays),
    floors: (Array.isArray(w.rows) ? w.rows : []).slice(0, 12).map((r) => ({ floor: cap(r.label, 60), hit: numOr(r.hit), of: numOr(r.of) })),
    miss_tax_dollars: numOr(w.missTaxCents) != null ? Number(w.missTaxCents) / 100 : null,
    weigh_in: s.weight ? { change_7d: numOr(s.weight.change7), verdict: cap(s.weight.verdict, 12), rule: cap(s.weight.text, 240) } : null,
    goal: s.goal ? { now: numOr(s.goal.now), goal: numOr(s.goal.goal), to_go: numOr(s.goal.left) } : null,
    scorecard: cap(s.scorecard, 2500),
  };
}
// The money plan the tracker publishes (dsSnapshot.money = money-logic
// boardView). Trimmed and capped; any string that looks like an account or
// card number (6+ digits) is dropped as a last line of defence.
function personalMoney(snap, nowMs) {
  const s = snap || {};
  const m = s.money;
  if (!m || typeof m !== 'object') return { note: 'No money plan yet — the owner fills it in on the tracker (💵 Money → Plan my paycheck).' };
  const safe = (v, n) => { const t = cap(v, n || 60); return /\d{6,}/.test(t.replace(/[\s-]/g, '').replace(/[$.,]/g, '')) && !/^[-−]?\$/.test(t) ? '' : t; };
  const arr = (a, f, n) => (Array.isArray(a) ? a : []).slice(0, n || 40).map(f);
  return {
    as_of_hours_ago: snapshotAge(s, nowMs),
    paycheck: safe(m.paycheck, 60),
    plan: arr(m.plan, (l) => ({ line: safe(l && l.line, 80), amount: cap(l && l.amount, 20) })),
    short_by: m.short_by ? cap(m.short_by, 20) : null,
    emergency_fund: m.emergency_fund ? { balance: cap(m.emergency_fund.balance, 20), target: cap(m.emergency_fund.target, 20), paychecks_to_target: numOr(m.emergency_fund.paychecks_to_target) } : null,
    cards: arr(m.cards, (c) => ({ card: safe(c && c.card, 40), balance: cap(c && c.balance, 20), apr_pct: numOr(c && c.apr_pct), minimum: cap(c && c.minimum, 20) })),
    payoff: m.payoff ? { debt_free_months: numOr(m.payoff.debt_free_months), interest_to_pay: cap(m.payoff.interest_to_pay, 20), order: arr(m.payoff.order, (o) => safe(o, 40), 20) } : null,
    subscriptions: arr(m.subscriptions, (x) => ({ name: safe(x && x.name, 40), monthly: cap(x && x.monthly, 20), keep: !!(x && x.keep) })),
    monthly: m.monthly ? { income: cap(m.monthly.income, 20), bills: cap(m.monthly.bills, 20), subscriptions: cap(m.monthly.subscriptions, 20), card_minimums: cap(m.monthly.card_minimums, 20) } : null,
    note: 'A pressure-test, not licensed advice. Big moves (closing cards, retirement, taxes) → tell the owner to confirm with a professional.',
  };
}
function personalReviews(reviews, limit) {
  const weeks = (reviews && typeof reviews.weeks === 'object' && reviews.weeks) || {};
  const n = Math.min(Math.max(Math.floor(Number(limit)) || 4, 1), 12);
  return Object.keys(weeks).filter(isYmd).sort().reverse().slice(0, n).map((dk) => {
    const r = weeks[dk] || {};
    return {
      week_ending: dk, floors_pct: numOr(r.pct), full_days: numOr(r.fullDays),
      miss_tax_dollars: numOr(r.missTaxCents) != null ? Number(r.missTaxCents) / 100 : null, moved_to_savings: r.taxMoved === true,
      last_hard_thing_done: r.lastDone === true ? true : r.lastDone === false ? false : null,
      kept: cap(r.kept, 600), bailed: cap(r.bailed, 600), hard_thing: cap(r.scary, 200), hard_thing_due: isYmd(r.scaryDue) ? r.scaryDue : null,
      weight_change: numOr(r.weightChange),
    };
  });
}

// ── Collected revenue ──────────────────────────────────────────────────
// Same ledger as docs/pro/js/collected-revenue.js paymentsOf (payments[] +
// synthetic remainder, else one lump; refunds negative on their own date).
// tests/agent-mcp-more-tools-2026-10-02.test.js runs both on the same
// invoices so they cannot drift.
function paymentsOf(inv) {
  const total = parseFloat(inv.total) || 0;
  const bal = inv.balanceDue != null ? (parseFloat(inv.balanceDue) || 0) : 0;
  const collectedCents = Math.round(Math.max(0, total - bal) * 100);
  let out = [];
  let done = false;
  if (Array.isArray(inv.payments) && inv.payments.length) {
    let ledgerCents = 0, earliestAt = null, earliestMs = Infinity;
    inv.payments.forEach((p) => {
      const amt = parseFloat(p && p.amount);
      const at = p && (p.at != null ? p.at : p.date);
      if (!(amt > 0) || at == null) return;
      out.push({ amount: amt, at });
      ledgerCents += Math.round(amt * 100);
      const t = ms(at);
      if (t && t < earliestMs) { earliestMs = t; earliestAt = at; }
    });
    if (out.length) {
      done = true;
      const rem = collectedCents - ledgerCents;
      if (rem >= 1) {
        const remAt = earliestAt != null ? earliestAt : (inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt);
        if (remAt != null) out.push({ amount: rem / 100, at: remAt, synthetic: true });
      }
    }
  }
  if (!done) {
    out = [];
    const payDate = inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt;
    if (collectedCents > 0 && payDate != null) out.push({ amount: collectedCents / 100, at: payDate });
  }
  (Array.isArray(inv.refunds) ? inv.refunds : []).forEach((r) => {
    const amt = parseFloat(r && r.amount);
    const at = r && (r.at != null ? r.at : r.date);
    if (!(amt > 0) || at == null || r.status === 'failed' || r.status === 'canceled' || r.status === 'won') return;
    out.push({ amount: -amt, at, refund: true });
  });
  return out;
}

// Inclusive YYYY-MM-DD range in the house timezone's calendar (dates are
// compared as America/New_York days).
function nyDay(t, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}
function collectedRevenue(invoices, leads, from, to, tz) {
  const nameOf = {};
  (leads || []).forEach((l) => { if (l && l.id) nameOf[l.id] = minimalLead(l).name; });
  let cents = 0, refundCents = 0, payments = 0;
  const byMonth = {}, byLead = {};
  (invoices || []).forEach((inv) => {
    if (!inv || inv.deleted === true || inv.e2eTestData) return;
    paymentsOf(inv).forEach((p) => {
      const t = ms(p.at instanceof Date ? p.at.getTime() : p.at);
      if (!t) return;
      const day = nyDay(t, tz);
      if (day < from || day > to) return;
      const c = Math.round(p.amount * 100);
      cents += c;
      if (p.refund) refundCents += -c; else payments++;
      const m = day.slice(0, 7);
      byMonth[m] = (byMonth[m] || 0) + c;
      const k = inv.leadId || '(no customer)';
      byLead[k] = (byLead[k] || 0) + c;
    });
  });
  const top = Object.keys(byLead).sort((x, y) => byLead[y] - byLead[x]).slice(0, 10)
    .map((k) => ({ lead_id: k === '(no customer)' ? null : k, name: nameOf[k] || null, collected: byLead[k] / 100 }));
  const months = {}; Object.keys(byMonth).sort().forEach((m) => { months[m] = byMonth[m] / 100; });
  return { from, to, collected: cents / 100, refunds_subtracted: refundCents / 100, payments, by_month: months, top_customers: top,
    note: 'Collected money only (payments by the date received, refunds subtracted). Estimates, signed contracts and pipeline are projected, not revenue.' };
}

// ── Filing (validation of what a bot may put in the inbox) ─────────────
function validateFiling(tool, args, leadExists) {
  const a = args || {};
  const text = String(a.text || '').trim();
  if (!text) return { error: 'text is required' };
  if (text.length > MAX_TEXT) return { error: 'text is too long (max ' + MAX_TEXT + ')' };
  if (tool === 'file_report') {
    const title = String(a.title || '').trim();
    if (!title) return { error: 'title is required' };
    return { item: { kind: 'report', leadId: null, title: title.slice(0, 140), text, dueDate: null } };
  }
  if (!a.lead_id || !leadExists) return { error: 'unknown lead_id — use list_leads or overdue_followups first' };
  if (tool === 'file_note') return { item: { kind: 'note', leadId: String(a.lead_id), title: '', text, dueDate: null } };
  if (tool === 'file_reminder') {
    if (!isYmd(a.due_date)) return { error: 'due_date must be YYYY-MM-DD' };
    return { item: { kind: 'reminder', leadId: String(a.lead_id), title: '', text, dueDate: a.due_date } };
  }
  return { error: 'unknown filing tool' };
}

// Kentucky claim-wording guard on anything filed (the same lines the site
// gate and Ask Joe rules hold): a filing that promises to handle / negotiate
// / manage the insurance claim is refused outright.
const CLAIM_PROMISE = /\b(we|i|nbd|joe)\b[^.\n]{0,40}\b(handle|negotiate|manage|deal with|take care of|fight)\b[^.\n]{0,30}\b(claim|insurance|adjuster)\b/i;
function claimWordingProblem(text) {
  return CLAIM_PROMISE.test(String(text || '')) ? 'Kentucky rule: we never handle, negotiate or manage the homeowner\'s insurance claim — reword it (we document the damage and meet the adjuster; the claim stays theirs).' : null;
}

// ── Drafts the owner sends (Jo, 2026-10-06) ───────────────────────────
// "Bots may DRAFT outbound customer messages; NOTHING ever auto-sends; Jo
// sends with one tap." A draft is one more Agent inbox item: the server
// resolves who it goes to (the bot never sees a phone number or an email
// address, and none is ever in a tool answer), refuses a customer on the
// Do-Not-Text register (sms_opt_outs, the STOP list) or the email
// suppression list, and the owner sends it from their own phone / mail app
// in the Agent inbox. Social drafts go to Social Studio as a draft — never
// published from here.
const EMAIL_FROM = { jd: 'jd@nobigdealwithjoedeal.com', info: 'info@nobigdealwithjoedeal.com' };
const SOCIAL_BRANDS = { nbd: 'No Big Deal', pro: 'NBD Pro' };
const DRAFT_TOOLS = ['draft_text', 'draft_email', 'file_social_draft'];
const DRAFT_KINDS = ['draft_text', 'draft_email', 'social_draft'];
let SOCIAL = null;
try { SOCIAL = require('./social-logic'); } catch (_) { SOCIAL = null; }
const { phoneDigits10 } = require('./phone-utils');

// Plain text a customer will read: no control characters (newlines kept),
// trimmed, CRLF folded.
function draftText(v) {
  return String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
}
/** The names a draft may use to say who it is from (the company profile's, NBD's short name). */
function companyNames(profile, isNbd) {
  const p = profile || {};
  const b = p.brand || {};
  const out = [b.name, b.legalName, b.shortName, p.companyName, p.name].map((s) => clean(s, 120)).filter(Boolean);
  if (isNbd) out.push('No Big Deal');
  return out.filter((n, i, a) => a.indexOf(n) === i);
}
function hasStopLine(body) { return /\b(reply|text)\s+["']?stop\b/i.test(String(body || '')); }

/**
 * The checks a text draft must pass — at filing AND again on the edited text
 * when the owner taps send (review R2-3-1): the company name, a STOP line, the
 * Kentucky claim wording. Never appends: an edit that removed the
 * STOP line is refused, not repaired behind the owner's back.
 * @returns {string|null} what is wrong, or null
 */
function editedTextProblem(body, names) {
  const b = draftText(body);
  if (!b) return 'The text is empty.';
  const ns = (names || []).filter(Boolean);
  if (!ns.length) return 'The company has no name set on its profile, so a text cannot say who it is from.';
  const low = b.toLowerCase();
  if (!ns.some((n) => low.indexOf(n.toLowerCase()) !== -1)) return 'Say who it is from: the text must include the company name ("' + ns[ns.length - 1] + '").';
  if (!hasStopLine(b)) return 'Keep the STOP line in the text ("' + STOP_LINE + '").';
  const claim = claimWordingProblem(b);
  if (claim) return claim;
  return null;
}

/** draft_text args → { body } (company name checked, STOP line appended) or { error }. */
function buildTextDraft(args, names) {
  const a = args || {};
  let body = draftText(a.body);
  const reason = clean(a.reason, REASON_MAX);
  if (!body) return { error: 'body is required' };
  if (!reason) return { error: 'reason is required — say why this customer should get this text now' };
  const ns = (names || []).filter(Boolean);
  if (!ns.length) return { error: 'The company has no name set on its profile, so a text cannot say who it is from. Ask the owner to set it.' };
  const low = body.toLowerCase();
  if (!ns.some((n) => low.indexOf(n.toLowerCase()) !== -1)) return { error: 'Say who it is from: the text must include the company name ("' + ns[ns.length - 1] + '").' };
  if (!hasStopLine(body)) body = body + '\n' + STOP_LINE;
  if (body.length > SMS_MAX) return { error: 'The text is too long: ' + SMS_MAX + ' characters at most, including the "' + STOP_LINE + '" line.' };
  return { body, reason };
}

/** May this customer get a text draft at all? Reads the stored facts only. */
function textGate(lead, optOut) {
  const l = lead || {};
  if (phoneDigits10(l.phone).length !== 10) return { error: 'This customer has no textable phone number on file. File a note instead.' };
  // An explicit "no" on a consent form is a refusal; an absent field is not
  // consent either, but a one-to-one text the owner sends from their own
  // phone does not need the written-consent record an automated text does —
  // the inbox shows whether one is on file.
  if (l.tcpaConsent === false) return { error: 'This customer declined texting on their form. No text draft — file a note instead.' };
  // source 'dnc' = the company's own Do Not Text list (sms-optout.js), not a STOP reply.
  if (optOut && optOut.optedOut && optOut.source === 'dnc') return { error: 'This customer is on your company\'s Do-Not-Text list. No text draft — file a note instead.' };
  if (!optOut || optOut.optedOut !== false) return { error: optOut && optOut.optedOut ? 'This customer is on the Do-Not-Text list (they replied STOP). No text draft — file a note instead.' : 'The Do-Not-Text list could not be checked. Try again later.' };
  return { ok: true, consentOnFile: l.tcpaConsent === true };
}

const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** draft_email args → { subject, body, from, fromAddress } or { error }. */
function buildEmailDraft(args) {
  const a = args || {};
  const subject = clean(a.subject, EMAIL_SUBJECT_MAX + 1);
  const body = draftText(a.body);
  const reason = clean(a.reason, REASON_MAX);
  if (!subject) return { error: 'subject is required' };
  if (subject.length > EMAIL_SUBJECT_MAX) return { error: 'subject is too long (max ' + EMAIL_SUBJECT_MAX + ')' };
  if (!body) return { error: 'body is required' };
  if (body.length > MAX_TEXT) return { error: 'body is too long (max ' + MAX_TEXT + ')' };
  if (!reason) return { error: 'reason is required — say why this customer should get this email now' };
  if (!Object.prototype.hasOwnProperty.call(EMAIL_FROM, a.from)) return { error: 'from must be "jd" (marketing, follow-ups) or "info" (documents, payments)' };
  return { subject, body, reason, from: a.from, fromAddress: EMAIL_FROM[a.from] };
}
function emailGate(lead, suppression) {
  const e = String((lead && lead.email) || '').trim();
  if (!EMAIL_RE.test(e)) return { error: 'This customer has no email address on file. File a note instead.' };
  if (!suppression || suppression.suppressed !== false) return { error: suppression && suppression.suppressed ? 'This customer unsubscribed from email. No email draft — file a note instead.' : 'The unsubscribe list could not be checked. Try again later.' };
  return { ok: true };
}

/** file_social_draft args → the inbox item fields, or { error }. Never published from here. */
function buildSocialDraft(args) {
  const a = args || {};
  const P = (SOCIAL && SOCIAL.PLATFORMS) || {};
  if (!Object.prototype.hasOwnProperty.call(SOCIAL_BRANDS, a.brand)) return { error: 'brand must be "nbd" or "pro"' };
  if (!Object.prototype.hasOwnProperty.call(P, a.platform)) return { error: 'platform must be one of: ' + Object.keys(P).join(', ') };
  const caption = draftText(a.caption);
  if (!caption) return { error: 'caption is required' };
  const max = Number(P[a.platform].maxCaption) || MAX_TEXT;
  if (caption.length > max) return { error: 'caption is too long for ' + P[a.platform].label + ' (max ' + max + ')' };
  const reason = clean(a.reason, REASON_MAX);
  if (!reason) return { error: 'reason is required — say why this post, now' };
  const media = a.media_url == null || a.media_url === '' ? null : String(a.media_url).trim();
  if (media && (media.length > 500 || !/^https:\/\/[^\s"'<>]+$/.test(media))) return { error: 'media_url must be one https:// link' };
  const when = a.scheduled_for == null || a.scheduled_for === '' ? null : String(a.scheduled_for).trim();
  if (when && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(when)) return { error: 'scheduled_for must be YYYY-MM-DD or YYYY-MM-DDTHH:MM' };
  return {
    item: { kind: 'social_draft', leadId: null, title: SOCIAL_BRANDS[a.brand] + ' · ' + P[a.platform].label, text: caption, dueDate: null,
      reason, brand: a.brand, platform: a.platform, mediaUrl: media, scheduledFor: when },
    needsMedia: !!P[a.platform].needsMedia && !media,
  };
}

// ── Company-made bots (Settings → Bots & API, 2026-10-04) ──────────────
// Any NBD Pro company on a paid plan can make its own bots: a name, what it
// does, which tools it may use (any CRM tool — never the personal tracker
// ones) and who its filings notify. Stored server-only in agent_bots/{id};
// a key for one is agent_keys/{hash} { botId: 'c_<id>', customBotId: id }.
// The safety model is the same as the house roster: read minimized data,
// FILE notes / reminders / reports — nothing is ever sent to a customer.
// The draft tools are NBD's house roster only (2026-10-06): they put words in
// front of a customer under the company's name, and the compliance copy
// (STOP line, sender name, From addresses) is written for NBD.
const CUSTOM_TOOLS = Object.keys(TOOLS).filter((n) => PERSONAL_TOOLS.indexOf(n) === -1 && DRAFT_TOOLS.indexOf(n) === -1);
const ROUTE_TO = ['owner', 'creator'];
const MAX_CUSTOM_BOTS = 20;
function customBotKey(id) { return 'c_' + String(id || ''); }
function customBotIdFromKey(botKey) { const m = /^c_([A-Za-z0-9]{8,40})$/.exec(String(botKey || '')); return m ? m[1] : null; }
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** What the owner typed → a bot to store, or { error }. */
function normalizeBotInput(input) {
  const a = input || {};
  const name = clean(a.name, 60);
  if (!name) return { error: 'Give the bot a name.' };
  const role = clean(a.role, 300);
  const asked = Array.isArray(a.tools) ? a.tools.map(String) : [];
  const tools = CUSTOM_TOOLS.filter((t) => asked.indexOf(t) !== -1);
  if (!tools.length) return { error: 'Pick at least one tool the bot may use.' };
  const unknown = asked.filter((t) => CUSTOM_TOOLS.indexOf(t) === -1);
  if (unknown.length) return { error: 'Not a tool a company bot can use: ' + unknown.slice(0, 3).join(', ') };
  const routeTo = ROUTE_TO.indexOf(a.routeTo) !== -1 ? a.routeTo : 'owner';
  return { bot: { name, role, tools, routeTo } };
}

/** agent_bots doc → the bot object the connection works with. */
function customBotView(id, d) {
  const doc = d || {};
  return {
    id: customBotKey(id), name: clean(doc.name, 60) || 'Bot', role: clean(doc.role, 300),
    tools: (Array.isArray(doc.tools) ? doc.tools : []).filter((t) => CUSTOM_TOOLS.indexOf(t) !== -1),
    scope: 'crm', custom: true, routeTo: ROUTE_TO.indexOf(doc.routeTo) !== -1 ? doc.routeTo : 'owner', createdBy: doc.createdBy || null,
  };
}

// ── Per-company switch + plan gate ─────────────────────────────────────
// Plans: any ACTIVE or TRIALING paid plan (not 'free') — the same test as
// shared.js requirePaidSubscription and the AI gate. The platform tenant
// (NBD) and personal tracker keys are exempt from the plan gate; the
// company's own switch (agent_settings/{companyId}.enabled === false) turns
// every key of that company off, house roster included.
function planAllowsBots(sub) {
  return !!(sub && (sub.status === 'active' || sub.status === 'trialing') && sub.plan && sub.plan !== 'free');
}
function accessDecision(o) {
  const x = o || {};
  if (x.settings && x.settings.enabled === false) {
    return { ok: false, status: 403, code: -32003, message: 'Bots are switched off for this company. The owner can turn them back on in Settings → Bots & API.' };
  }
  if (x.isNbd || x.personal) return { ok: true };
  if (!planAllowsBots(x.sub)) {
    return { ok: false, status: 402, code: -32004, message: 'Connecting bots needs a paid NBD Pro plan. The owner can upgrade in Settings → Billing.' };
  }
  return { ok: true };
}

// ── Timezone ───────────────────────────────────────────────────────────
// The company profile's IANA zone (timezone / timeZone, or the brand's).
// America/New_York is the default ONLY for NBD (Cincinnati + Northern KY);
// any other company without one runs on UTC until the owner sets it (the
// Bots & API page sets it from the owner's browser when the first bot is made).
function validTimeZone(z) {
  if (!z || typeof z !== 'string' || z.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }).format(0); return true; } catch (_) { return false; }
}
// settingsZone: agent_settings.timezone — used only when the company has no
// companyProfile doc yet to hold one.
function companyTimeZone(profile, isNbd, settingsZone) {
  const p = profile || {};
  const b = p.brand || {};
  const c = [p.timezone, p.timeZone, b.timezone, b.timeZone, settingsZone].find(validTimeZone);
  if (c) return { tz: c, set: true };
  return { tz: isNbd ? 'America/New_York' : 'UTC', set: false };
}
function dayInZone(t, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: validTimeZone(tz) ? tz : 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

// ── Rules for a company that is not NBD ────────────────────────────────
// Each company's own rules: tiers / warranty wording / deposit from its
// companyProfile.businessRules (#2152 tenant-rules — read only when present)
// and its pricing.tierRates, plus the house rules the owner types on the
// Bots & API page. Never NBD's tiers, prices, warranties or house rules.
const NEUTRAL_GUIDANCE = [
  'Bots read and file only: notes, reminders and reports go to the Agent inbox, where the owner decides. Nothing is ever sent to a customer.',
  '"Revenue" means money collected (payments by the date received). Estimates, contracts and pipeline value are projected.',
  'Never publish cost, contractor price or margin figures anywhere public. Retail prices are fine.',
  'Never promise a homeowner that their insurance claim will be paid, and never offer to handle or negotiate their claim.',
  'When a rule is not set here, ask the owner instead of guessing.',
];
const TIER_KEYS = ['economy', 'good', 'better', 'best', 'beyond'];
function houseRuleLines(text) {
  return String(text == null ? '' : text).split(/\r?\n/).map((l) => clean(l.replace(/^\s*[-*•]\s*/, ''), 300)).filter(Boolean).slice(0, 25);
}
function rulesReferenceFor(o) {
  const x = o || {};
  if (x.isNbd) return rulesReference();
  const p = x.profile || {};
  const br = (p.businessRules && typeof p.businessRules === 'object') ? p.businessRules : {};
  const t = (br.tiers && typeof br.tiers === 'object') ? br.tiers : {};
  const rates = (p.pricing && p.pricing.tierRates && typeof p.pricing.tierRates === 'object') ? p.pricing.tierRates : {};
  const enabled = Array.isArray(t.enabled) ? TIER_KEYS.filter((k) => t.enabled.indexOf(k) !== -1) : null;
  const keys = enabled || TIER_KEYS.filter((k) => Number(rates[k]) > 0);
  const tiers = keys.map((k) => ({
    key: k,
    label: clean(t.labels && t.labels[k], 40) || null,
    retail_per_sq: Number(rates[k]) > 0 ? Math.round(Number(rates[k]) * 100) / 100 : null,
    warranty: clean(t.warranty && t.warranty[k], 400) || null,
  }));
  const dep = (br.deposit && typeof br.deposit === 'object') ? br.deposit : null;
  const depPct = dep ? Number(dep.depositPct) : NaN;
  const deposit = dep && Number.isFinite(depPct)
    ? { cash_deposit_pct: depPct, no_deposit_under: Number(dep.noDepositUnderCents) > 0 ? Number(dep.noDepositUnderCents) / 100 : 0 }
    : null;
  const msg = (KY && KY.MSG) || {};
  const own = houseRuleLines(x.houseRules);
  return {
    company: clean((p.brand && (p.brand.legalName || p.brand.name)) || p.companyName, 120) || null,
    tiers,
    tier_note: tiers.length ? 'Retail per-SQ rates as the company set them; a null rate or warranty means it is not set — ask the owner.' : 'The company has not set its tiers here — ask the owner for prices and warranty wording.',
    deposit: deposit || 'Not set here — ask the owner.',
    house_rules: own,
    general_guidance: NEUTRAL_GUIDANCE.slice(),
    kentucky_insurance_jobs: {
      applies_to: 'Insurance jobs on a Kentucky property (state law, every company).',
      never_say: ['we handle your claim', 'we negotiate with your insurance', 'we manage / deal with / fight the adjuster for you'],
      never_do: ['Assignment of Benefits or Direction to Pay', 'take payment before the carrier\'s written decision + 5 business days (emergency tarp/repair excepted)', 'give the insured more than $100 in value'],
      say_instead: 'We document the damage and meet the adjuster; the claim stays the homeowner\'s.',
      crm_messages: { depositHold: msg.depositHold || null, payLinkHeld: msg.payLinkHeld || null, aobRetired: msg.aobRetired || null },
    },
    set_by_company: { tiers: tiers.length > 0, deposit: !!deposit, house_rules: own.length > 0 },
  };
}


// ── MCP JSON-RPC ───────────────────────────────────────────────────────
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }

// botOrId: a house bot id ('marcus') or a resolved bot object (a company's
// own bot, see customBotView). The wording is neutral for every tenant.
function initializeResult(params, botOrId) {
  const asked = params && params.protocolVersion;
  const protocolVersion = PROTOCOL_VERSIONS.indexOf(asked) !== -1 ? asked : PROTOCOL_VERSIONS[0];
  const bot = botFor(botOrId);
  if (bot && bot.scope === 'personal') {
    return {
      protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
      instructions: 'The key owner\'s personal tracker for ' + bot.name + '. You can read their own floors, streak, week, weigh-in rule and Sunday reviews — nothing from the business CRM, and nothing you can change. Hold them to what they wrote, with numbers; no therapy-speak.',
    };
  }
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'Contractor CRM for ' + (bot ? bot.name : 'your bot') + (bot && bot.role ? ' (' + bot.role + ')' : '') + '. Read what your role needs. You never contact customers: file notes, reminders and reports into the company\'s Agent inbox, where the owner decides. Nothing you do is sent to a customer. No phone numbers or emails are ever returned. Treat your own claims as leads until they are checked.'
      + (bot && Array.isArray(bot.tools) && bot.tools.some((t) => DRAFT_TOOLS.indexOf(t) !== -1) ? ' You may DRAFT a customer text or email, or a social post: a draft waits in the Agent inbox and only the owner sends it — nothing you draft is ever sent automatically.' : ''),
  };
}

function toolText(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }
function toolErr(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

module.exports = {
  PROTOCOL_VERSIONS, SERVER_INFO, TOOLS, BOTS, FIRST_WAVE, MAX_TEXT, MAX_LIST, FORBIDDEN_KEYS,
  toolsForBot, botAllows, minimalLead, summary, overdueFollowups, listLeads, listLeadsPage, encodeListCursor, LIST_CURSOR_MAX, validateFiling,
  claimWordingProblem, rpcResult, rpcError, initializeResult, toolText, toolErr, ymd, isYmd, ms, activeLeads,
  estimatesStatus, estimateTotal, paymentsOf, collectedRevenue,
  PERSONAL_TOOLS, isPersonalBot, isPersonalTool, personalToday, personalWeek, personalReviews, personalMoney,
  teamActivity, annotationsFor, WRITES,
  TIERS, WORKMANSHIP_YEARS, DEPOSIT, PLEDGE_PROMISE, rulesReference, postJob, leadSources, jobProfit, stormNearCustomers, haversineMi, roleOf,
  botFor, CUSTOM_TOOLS, ROUTE_TO, MAX_CUSTOM_BOTS, customBotKey, customBotIdFromKey, normalizeBotInput, customBotView,
  SMS_MAX, STOP_LINE, EMAIL_FROM, SOCIAL_BRANDS, DRAFT_TOOLS, DRAFT_KINDS, companyNames, hasStopLine, editedTextProblem, buildTextDraft, textGate, buildEmailDraft, emailGate, buildSocialDraft,
  planAllowsBots, accessDecision, validTimeZone, companyTimeZone, dayInZone, rulesReferenceFor, houseRuleLines, NEUTRAL_GUIDANCE,
};
