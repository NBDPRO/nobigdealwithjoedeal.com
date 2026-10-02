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
const SERVER_INFO = { name: 'nbd-crm', version: '1.1.0' };
const MAX_TEXT = 2000;
const MAX_LIST = 50;

// ── Tools ──────────────────────────────────────────────────────────────
const TOOLS = {
  crm_summary: {
    description: 'Pipeline at a glance: active customers by stage, open pipeline value (PROJECTED — booked/estimated, not money received), follow-ups due today and overdue.',
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
    description: 'Customers, filtered by stage and/or "stale" (no update in N days), newest first. Returns lead_id, name, address, stage, follow-up date and last update — never phone or email.',
    inputSchema: { type: 'object', properties: {
      stage: { type: 'string', description: 'Pipeline stage key, e.g. new, contacted, inspected, estimate_sent_cash, negotiating, contract_signed' },
      stale_days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Only customers not updated in this many days' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_LIST },
    }, additionalProperties: false },
  },
  lead_detail: {
    description: 'One customer: stage, address, damage type, job value, follow-up, last update, the last 5 notes and open reminders. No phone or email.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' } }, required: ['lead_id'], additionalProperties: false },
  },
  file_note: {
    description: 'File a NOTE about one customer into Jo\'s Agent inbox. Jo reviews it and adds it to the customer\'s card. Nothing is sent to the customer. Never promise to handle or negotiate an insurance claim.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' }, text: { type: 'string', maxLength: MAX_TEXT } }, required: ['lead_id', 'text'], additionalProperties: false },
  },
  file_reminder: {
    description: 'File a dated REMINDER for Jo about one customer into the Agent inbox (e.g. "Call Bob about the gutter quote"). Jo reviews it before it becomes a task. Nothing is sent to the customer.',
    inputSchema: { type: 'object', properties: { lead_id: { type: 'string' }, due_date: { type: 'string', description: 'YYYY-MM-DD' }, text: { type: 'string', maxLength: MAX_TEXT } }, required: ['lead_id', 'due_date', 'text'], additionalProperties: false },
  },
  file_report: {
    description: 'File a REPORT for Jo into the Agent inbox (digest, findings, plan). Not tied to one customer.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', maxLength: 140 }, text: { type: 'string', maxLength: MAX_TEXT } }, required: ['title', 'text'], additionalProperties: false },
  },
  inbox_pending: {
    description: 'Items waiting in Jo\'s Agent inbox (what the team has filed and Jo has not decided yet), so they can be fact-checked.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIST } }, additionalProperties: false },
  },
  verify_item: {
    description: 'Fact & Compliance check on one pending Agent inbox item: mark it checked (ok=true) or flag it with what is wrong (ok=false). Also checks Kentucky claim wording (never "we handle/negotiate your claim"), price rules and warranty wording.',
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
    description: 'NBD\'s rules to check anything against: the five roof tiers (retail $/SQ, warranty wording, shingle limits), workmanship warranty years by job type, the deposit rule, the Kentucky insurance-job lines (what we never say or do), and house rules (crews are independent subs; "revenue" means collected money). Read only. Retail prices here are public; cost figures never are.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  post_job: {
    description: 'Customers whose job is finished (installed / final payment / closed), newest first: days since completion, invoice balance still owed, whether a review was requested, warranty certificate tier, and whether the 1-year anniversary touch went out. For after-the-job care: final payment, review asks, referrals, warranty check-ins. No phone or email.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 730, description: 'Only jobs finished in the last N days (default 120)' }, limit: { type: 'integer', minimum: 1, maximum: MAX_LIST } }, additionalProperties: false },
  },
  lead_sources: {
    description: 'Where customers came from over the last N days (default 90): leads per source (Door Knock, Storm Canvass, Referral, Website, Google, Thumbtack…), how many are won / lost / still open, win rate, and marketing spend per source with cost per lead where expenses are tagged. Counts only — no customer names.',
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
    description: 'What each bot on the NBD team did over the last N days (default 7): tool calls, filings, and how Jo decided them — approved, tossed, still waiting — plus Quinn\'s checked / flagged counts. Use it to coach the team: a bot whose filings Jo keeps tossing needs a different approach. Personal bots are not included.',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 30 } }, additionalProperties: false },
  },
  // ── Personal scope (Jo's own tracker; personal keys only) ─────────────
  my_today: {
    description: 'Jo\'s day in his personal tracker: today\'s floors (his daily promises) met or open, the floor streak ("don\'t miss twice": one miss warns, two in a row end it), and his latest weight. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  my_week: {
    description: 'Jo\'s week from his tracker: each floor out of 7, full days, the $5-per-miss tax and whether he moved it to savings, the weigh-in rule (7-day average vs last week; not down 0.5 lb → cut 200 calories), the goal weight, and the plain-text weekly scorecard. Read only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  my_reviews: {
    description: 'Jo\'s saved Sunday reviews, newest first: floors %, miss tax moved or not, last week\'s hard thing done or not, what he kept, where he bailed, and this week\'s hard thing with its deadline. Hold him to them. Read only.',
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
  marcus: { name: 'Marcus · NBD Ops', tools: READ.concat(['estimates_status', 'storm_near_customers', 'rules_reference'], FILE) },
  quinn:  { name: 'Quinn · Fact & Compliance', tools: READ.concat(['estimates_status', 'collected_revenue', 'rules_reference', 'storm_near_customers', 'inbox_pending', 'verify_item', 'file_report']) },
  tucker: { name: 'Tucker · Customer Care', tools: ['post_job', 'list_leads', 'lead_detail', 'overdue_followups', 'estimates_status', 'rules_reference', 'file_note', 'file_reminder'] },
  dana:   { name: 'Dana · Marketing', tools: ['crm_summary', 'lead_sources', 'rules_reference', 'file_report'] },
  frank:  { name: 'Frank · Finance', tools: ['crm_summary', 'collected_revenue', 'job_profit', 'lead_sources', 'estimates_status', 'file_report'] },
  priya:  { name: 'Priya · Product Manager', tools: ['team_activity', 'file_report'] },
  theo:   { name: 'Theo · Venture Scout', tools: ['crm_summary', 'lead_sources', 'file_report'] },
  // Personal side (Jo, 2026-10-02): these read ONLY the key owner's own
  // tracker (userSettings/{ownerUid}.dsSnapshot / dsReviews) — never the CRM.
  // Their keys are made with scope 'personal' and checked on every call.
  coach:  { name: 'Coach · Personal', scope: 'personal', tools: ['my_today', 'my_week', 'my_reviews'] },
  board:  { name: 'Finance Board · Personal', scope: 'personal', tools: ['my_week', 'my_reviews'] },
};
const PERSONAL_TOOLS = ['my_today', 'my_week', 'my_reviews'];
function isPersonalBot(botId) { return Object.prototype.hasOwnProperty.call(BOTS, botId) && BOTS[botId].scope === 'personal'; }
function isPersonalTool(name) { return PERSONAL_TOOLS.indexOf(name) !== -1; }
const FIRST_WAVE = ['cos', 'marcus', 'quinn'];

// MCP tool annotations: every tool is read-only except the three filings
// and Quinn's check, which only add to / mark Jo's Agent inbox — none is
// destructive, and none reaches anything outside the CRM.
const WRITES = ['file_note', 'file_reminder', 'file_report', 'verify_item'];
function annotationsFor(name) {
  const w = WRITES.indexOf(name) !== -1;
  return { readOnlyHint: !w, destructiveHint: false, idempotentHint: !w, openWorldHint: false };
}
function toolsForBot(botId) {
  const b = Object.prototype.hasOwnProperty.call(BOTS, botId) ? BOTS[botId] : null;
  return b ? b.tools.map((n) => Object.assign({ name: n }, TOOLS[n], { annotations: annotationsFor(n) })) : [];
}
function botAllows(botId, tool) {
  const b = Object.prototype.hasOwnProperty.call(BOTS, botId) ? BOTS[botId] : null;
  return !!b && b.tools.indexOf(tool) !== -1;
}

// ── Data shaping (minimization) ────────────────────────────────────────
const CLOSED = /^(closed|lost|cold|dead|archived|cancel)/;
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
function minimalLead(l) {
  const name = ((String(l.firstName || '') + ' ' + String(l.lastName || '')).trim()) || String(l.name || '');
  return {
    lead_id: l.id,
    name,
    address: String(l.address || ''),
    stage: String(l.stage || ''),
    damage_type: String(l.damageType || ''),
    job_value: Number(l.jobValue) || 0,
    follow_up: isYmd(l.followUp) ? l.followUp : null,
    last_update: ms(l.updatedAt) ? new Date(ms(l.updatedAt)).toISOString().slice(0, 10) : null,
  };
}
const FORBIDDEN_KEYS = ['phone', 'email', 'phone2', 'altPhone', 'claimNumber', 'policyNumber', 'ssn', 'dob'];

function activeLeads(leads) {
  return (leads || []).filter((l) => l && l.id && l.deleted !== true && !l.e2eTestData);
}

function summary(leads, todayYmd) {
  const act = activeLeads(leads);
  const byStage = {};
  let pipeline = 0, dueToday = 0, overdue = 0;
  act.forEach((l) => {
    const st = String(l.stage || 'new');
    byStage[st] = (byStage[st] || 0) + 1;
    if (!CLOSED.test(st)) pipeline += Number(l.jobValue) || 0;
    if (isYmd(l.followUp) && !CLOSED.test(st)) {
      if (l.followUp === todayYmd) dueToday++;
      else if (l.followUp < todayYmd) overdue++;
    }
  });
  return { customers: act.length, by_stage: byStage, open_pipeline_value_projected: Math.round(pipeline), followups_due_today: dueToday, followups_overdue: overdue, note: 'Pipeline value is projected (estimates / booked), not money collected.' };
}

function overdueFollowups(leads, todayYmd, limit) {
  return activeLeads(leads)
    .filter((l) => isYmd(l.followUp) && l.followUp < todayYmd && !CLOSED.test(String(l.stage || '')))
    .sort((a, b) => (a.followUp < b.followUp ? -1 : 1))
    .slice(0, clampLimit(limit))
    .map(minimalLead);
}

function listLeads(leads, args, nowMs) {
  const a = args || {};
  let out = activeLeads(leads);
  if (a.stage) out = out.filter((l) => String(l.stage || '') === String(a.stage));
  if (a.stale_days) {
    const cut = nowMs - Number(a.stale_days) * 86400000;
    out = out.filter((l) => ms(l.updatedAt) && ms(l.updatedAt) < cut && !CLOSED.test(String(l.stage || '')));
  }
  return out.sort((x, y) => ms(y.updatedAt) - ms(x.updatedAt)).slice(0, clampLimit(a.limit)).map(minimalLead);
}

function clampLimit(n) { const v = Math.floor(Number(n)); return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_LIST) : 20; }

// ── Estimates (customer-facing totals only) ────────────────────────────
// grandTotal || total is what the portal shows the homeowner (portal.js);
// rows, costs, markup and margin are never read into the answer.
function estimateTotal(e) { const v = Number(e.grandTotal != null ? e.grandTotal : e.total); return Number.isFinite(v) ? Math.round(v * 100) / 100 : null; }
function isoDay(v) { const t = ms(v); return t ? new Date(t).toISOString().slice(0, 10) : null; }

function estimatesStatus(estimates, deals, leads, args, nowMs) {
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
      made: isoDay(e.createdAt),
      proposal: d ? {
        status: String(d.status || 'sent'),
        sent: isoDay(d.sentAt || d.createdAt),
        views: Number(d.viewCount) || 0,
        last_viewed: isoDay(d.lastViewedAt || d.viewedAt),
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
  { key: 'economy', label: 'Economy', ratePerSq: 440, warranty: '1-year workmanship plus the shingle maker\'s limited warranty; no system warranty; not transferable', crmOnly: true, notes: 'Never 3-tab shingles.' },
  { key: 'good', label: 'Standard', ratePerSq: 550, warranty: 'Lifetime system warranty; not transferable' },
  { key: 'better', label: 'Preferred', ratePerSq: 660, warranty: 'Lifetime system warranty; transferable to one later owner within 30 days of sale' },
  { key: 'best', label: 'Elite', ratePerSq: 770, warranty: 'Lifetime system warranty; fully transferable; annual inspection' },
  { key: 'beyond', label: 'Beyond', ratePerSq: 880, warranty: 'Elite warranty plus TAMKO\'s hail warranty', crmOnly: true, notes: 'Locked to TAMKO HailGuard shingles.' },
];
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
      'Two emails on purpose: jd@ for marketing, info@ for documents and Zelle. Never merge them.',
    ],
  };
}

// ── Finished jobs / sources / profit / storms ──────────────────────────
const SR = (() => { try { return require('./stage-roles'); } catch (_) { return null; } })();
function roleOf(l) { return SR && typeof SR.roleFor === 'function' ? SR.roleFor(l) : (CLOSED.test(String(l.stage || '')) ? 'won' : 'active'); }
function completedMs(l) { return ms(l.completedAt) || ms(l.installCompletedAt) || ms(l.stageStartedAt) || ms(l.updatedAt); }
function balanceByLead(invoices) {
  const out = {};
  (invoices || []).forEach((inv) => {
    if (!inv || !inv.leadId || inv.deleted === true || inv.status === 'void' || inv.status === 'paid') return;
    const b = parseFloat(inv.balanceDue);
    if (b > 0) out[inv.leadId] = Math.round(((out[inv.leadId] || 0) + b) * 100) / 100;
  });
  return out;
}
function postJob(leads, invoices, nowMs, args) {
  const a = args || {};
  const cut = nowMs - (Math.min(Math.max(Math.floor(Number(a.days)) || 120, 1), 730)) * 86400000;
  const owed = balanceByLead(invoices);
  return activeLeads(leads).filter((l) => roleOf(l) === 'won' && completedMs(l) >= cut)
    .sort((x, y) => completedMs(y) - completedMs(x)).slice(0, clampLimit(a.limit)).map((l) => {
      const done = completedMs(l);
      return Object.assign(minimalLead(l), {
        finished: done ? new Date(done).toISOString().slice(0, 10) : null,
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
    const role = roleOf(l);
    if (role === 'won') r.won++; else if (role === 'lost') r.lost++; else r.open++;
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
function jobProfit(leads, invoices, expenses, nowMs, args) {
  const a = args || {};
  const cut = nowMs - (Math.min(Math.max(Math.floor(Number(a.days)) || 180, 7), 730)) * 86400000;
  const got = {}, cost = {};
  (invoices || []).forEach((inv) => {
    if (!inv || !inv.leadId || inv.deleted === true || inv.e2eTestData) return;
    paymentsOf(inv).forEach((p) => { got[inv.leadId] = (got[inv.leadId] || 0) + Math.round(p.amount * 100); });
  });
  (expenses || []).forEach((e) => {
    if (!e || !e.leadId || e.deleted === true || e.costType !== DIRECT) return;
    cost[e.leadId] = (cost[e.leadId] || 0) + (Number(e.amountCents) || 0) + (Number(e.taxCents) || 0);
  });
  const jobs = activeLeads(leads).filter((l) => roleOf(l) === 'won' && completedMs(l) >= cut).map((l) => {
    const c = got[l.id] || 0, k = cost[l.id] || 0;
    return { lead_id: l.id, name: minimalLead(l).name, finished: new Date(completedMs(l)).toISOString().slice(0, 10),
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
function teamActivity(audits, items, nowMs, days) {
  const d = Math.min(Math.max(Math.floor(Number(days)) || 7, 1), 30);
  const cut = nowMs - d * 86400000;
  const rows = {};
  const row = (id) => (rows[id] = rows[id] || { bot: BOTS[id] ? BOTS[id].name : id, calls: 0, failed_calls: 0, filed: 0, approved: 0, tossed: 0, waiting: 0, quinn_checked: 0, quinn_flagged: 0 });
  (audits || []).forEach((a) => {
    if (!a || !BOTS[a.botId] || isPersonalBot(a.botId) || ms(a.at) < cut) return;
    const r = row(a.botId); r.calls++; if (a.ok === false) r.failed_calls++;
  });
  (items || []).forEach((i) => {
    if (!i || !BOTS[i.botId] || isPersonalBot(i.botId) || ms(i.createdAt) < cut) return;
    const r = row(i.botId); r.filed++;
    if (i.status === 'approved') r.approved++; else if (i.status === 'dismissed') r.tossed++; else r.waiting++;
    if (i.verified === true) r.quinn_checked++; else if (i.quinnNote) r.quinn_flagged++;
  });
  const out = Object.keys(BOTS).filter((id) => !isPersonalBot(id)).map((id) => Object.assign({ bot_id: id }, row(id)));
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
  if (!s.asOf) return { note: 'The tracker has not published yet — Jo needs to open it once (Daily tracker → dashboard).' };
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
  if (!s.asOf) return { note: 'The tracker has not published yet — Jo needs to open it once.' };
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

// ── MCP JSON-RPC ───────────────────────────────────────────────────────
function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }; }

function initializeResult(params, botId) {
  const asked = params && params.protocolVersion;
  const protocolVersion = PROTOCOL_VERSIONS.indexOf(asked) !== -1 ? asked : PROTOCOL_VERSIONS[0];
  const bot = BOTS[botId];
  if (bot && bot.scope === 'personal') {
    return {
      protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
      instructions: 'Jo\'s personal tracker for ' + bot.name + '. You can read his own floors, streak, week, weigh-in rule and Sunday reviews — nothing from the business CRM, and nothing you can change. Hold him to what he wrote, with numbers; no therapy-speak.',
    };
  }
  return {
    protocolVersion,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'NBD CRM for ' + (bot ? bot.name : 'the team') + '. Read what your role needs. You never contact customers: file notes, reminders and reports into Jo\'s Agent inbox, where Jo decides. No phone numbers or emails are ever returned. Treat your own claims as leads until Quinn checks them.',
  };
}

function toolText(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }
function toolErr(msg) { return { content: [{ type: 'text', text: msg }], isError: true }; }

module.exports = {
  PROTOCOL_VERSIONS, SERVER_INFO, TOOLS, BOTS, FIRST_WAVE, MAX_TEXT, MAX_LIST, FORBIDDEN_KEYS,
  toolsForBot, botAllows, minimalLead, summary, overdueFollowups, listLeads, validateFiling,
  claimWordingProblem, rpcResult, rpcError, initializeResult, toolText, toolErr, ymd, isYmd, ms, activeLeads,
  estimatesStatus, estimateTotal, paymentsOf, collectedRevenue,
  PERSONAL_TOOLS, isPersonalBot, isPersonalTool, personalToday, personalWeek, personalReviews,
  teamActivity, annotationsFor, WRITES,
  TIERS, WORKMANSHIP_YEARS, DEPOSIT, rulesReference, postJob, leadSources, jobProfit, stormNearCustomers, haversineMi, roleOf,
};
