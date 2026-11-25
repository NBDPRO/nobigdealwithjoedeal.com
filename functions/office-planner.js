'use strict';
/**
 * office-planner.js — officePlanner (2026-11-25, roadmap step 17 part B;
 * documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §4: "An
 * office-planner cron owns the CRM lanes (new-lead reminders, quiet
 * proposals, overdue follow-ups) and writes with dedupe keys"). Joe decided:
 * everything deterministic runs on the server, so it works with the laptop
 * off. 08:00, 12:00 and 17:00 America/New_York.
 *
 * The lanes (the office sweep's §3-§4 rules and the local radar's, moved here):
 *   leadFirst  Marcus  reminder  a lead still in the first stage that came in
 *                                within NEW_LEAD_HOURS ("First contact"), not
 *                                a CSV import (importedAt)
 *                                key lead:first:<leadId>, once per lead
 *   quiet      Marcus  reminder  a sent proposal with no activity for
 *                                QUIET_DAYS (not accepted, lead not closed)
 *                                key radar:quiet:<estimateId>, again after 7 days
 *   followup   Tucker  reminder  a follow-up date in the past on an open lead
 *                                key radar:followup:<leadId>, again after 7 days
 *   postJob30  Tucker  draft     "how's everything holding up", ~30 days
 *                                after the job finished (completedAt or
 *                                installCompletedAt only)
 *                                key postjob:30d:<leadId>, once per lead
 *   postJob1y  Tucker  draft     the one-year check-in, unless the anniversary
 *                                touch already went out
 *                                key postjob:1y:<leadId>, once per lead
 * A lead with an overdue follow-up gets that reminder, not a quiet-proposal
 * one as well (radar.js did the same), and while one radar reminder for a lead
 * is waiting no other is filed for it (a revised quote has a new estimate id).
 * Post-job drafts skip a customer who still owes money (the CRM's
 * invoice-overdue tasks own that), a job marked finished after the fact, a
 * warranty_claim or collections stage, a do-not-contact customer and one the
 * text gate would refuse (no textable phone, declined texting). Review asks are
 * never drafted here (roadmap step 5: review-ask-auto and review_sprint own
 * them); the text is fixed wording, never AI, and never mentions a review.
 * Caps per company (GROUPS, counted on the cap doc's plannerByDay): first
 * contact 10 a run / 30 a day; overdue + quiet together 8 a day (the radar's
 * 8, which ran once a day); post-job drafts 10 a day. A refused or deduped
 * filing uses no slot (at most TRIES_PER_SLOT tries per slot).
 *
 * The SAME filing path the crmMcp tools use: runTool (agent-mcp.js) with a
 * server key for the house bot that owns the lane — file_reminder /
 * draft_text with a dedupe_key, so the reminder wording gates, the Do-Not-
 * Text check, the Quinn gate (a draft lands "Not checked by Quinn", step 8)
 * and fileItemOnce's dedupe transaction are the bots' own. The key carries
 * platform 'server' (stamped keyPlatform on the item and platform on the
 * audit row) and counts its daily filings on system/officePlanner/companies/
 * {companyId}, since it has no agent_keys doc. Before filing, the planner
 * reads each candidate's dedupe lock (agent_inbox_keys) and the item it points
 * at: a once-only lane skips any key it ever filed; a key whose item is still
 * waiting is skipped (it would only dedupe); a 7-day lane skips a key filed or
 * decided (decidedAt) in the last 7 days, so a dismissal gives 7 quiet days. Nothing is ever sent:
 * drafts wait in the Agent inbox for the owner, so the customer send window
 * (send-window.js) does not apply.
 *
 * Gates: OFFICE_PLANNER_ENABLED=true (anything else: a no-op, no reads), the
 * global AGENT_MCP_DISABLED env and feature_flags/global.agentMcpDisabled,
 * then per company: agent_settings/{companyId}.officePlanner === true (the
 * opt-in; every other company is never read), the company's bots switch and
 * plan (L.accessDecision, the door's own gate) and the runtime pause
 * (paused / pausedPlatforms incl. 'server' / pausedBots, L.pauseDecision).
 *
 * Indexes: agent_settings where officePlanner == true is a single-field
 * equality (Firestore's automatic index); every other read is an existing
 * agent-mcp.js read (companyLeads, companyDocs, companyDealRooms) or a doc
 * get (locks, their items, the cap doc). No composite index is needed (the emulator never enforces one, so
 * this is reasoned, not tested).
 *
 * A failed company or filing is logged (counts only, no names) and the run
 * reports failed through softFail (integrations/heartbeat.js); so does a
 * refusal that stops a lane (the daily limit, a wording gate). One customer's
 * own text refusal (Do-Not-Text, no phone) is counted, not a failure.
 */
const { onSchedule, softFail } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler; softFail = a caught main failure still fails the run
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const L = require('./agent-mcp-logic');
const SR = require('./stage-roles');

const DAY = 86400000;
const NEW_LEAD_HOURS = 48;
const QUIET_DAYS = 5;
const POST_30 = [28, 40];
const POST_1Y = [358, 380];
// The server "key": never an agent_keys doc, so no bearer token can be it.
const SERVER_KEY_ID = 'office-plan';
const capDocFor = (companyId) => 'system/officePlanner/companies/' + companyId;

/** againDays 0 = once per key, ever. */
const LANES = Object.freeze({
  leadFirst: Object.freeze({ botId: 'marcus', tool: 'file_reminder', group: 'leadFirst', againDays: 0, prefix: 'lead:first:' }),
  quiet: Object.freeze({ botId: 'marcus', tool: 'file_reminder', group: 'radar', againDays: 7, prefix: 'radar:quiet:' }),
  followup: Object.freeze({ botId: 'tucker', tool: 'file_reminder', group: 'radar', againDays: 7, prefix: 'radar:followup:' }),
  postJob30: Object.freeze({ botId: 'tucker', tool: 'draft_text', group: 'postJob', againDays: 0, prefix: 'postjob:30d:' }),
  postJob1y: Object.freeze({ botId: 'tucker', tool: 'draft_text', group: 'postJob', againDays: 0, prefix: 'postjob:1y:' }),
});
// Filings per company per day (counted on the cap doc's plannerByDay) and per
// run. radar = the local radar's max_reminders_per_run (8): it ran once a day
// and shared it between overdue and quiet. postJob = the sweep's "Max 10
// Tucker drafts". First contact keeps 10 a run (30 a day): one per new lead.
const GROUPS = Object.freeze({
  leadFirst: Object.freeze({ perRun: 10, perDay: 30 }),
  radar: Object.freeze({ perRun: 8, perDay: 8 }),
  postJob: Object.freeze({ perRun: 10, perDay: 10 }),
});
// A refused filing does not use a slot, but a run tries at most this many per slot.
const TRIES_PER_SLOT = 3;
// Won stages where a "how is everything holding up" text is wrong: an open claim, an account in collections.
const NO_CHECKIN_STAGES = ['warranty_claim', 'collections'];
const BOT_IDS = ['marcus', 'tucker'];
const MARK = ' (Office planner)';

const enabled = () => process.env.OFFICE_PLANNER_ENABLED === 'true';
const oneLine = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const truthy = (v) => v === true || /^(true|yes|1)$/i.test(String(v == null ? '' : v));
const firstName = (l) => oneLine(l && l.firstName, 40).replace(/[^A-Za-zÀ-ɏ' -]/g, '').trim();
const ymdMs = (s) => Date.parse(String(s) + 'T12:00:00Z');
// The read tools clamp to L.MAX_LIST rows. The planner needs every row, so it
// runs them over chunks of at most MAX_LIST leads and joins the answers.
function everyRow(leads, fn) {
  const out = [];
  for (let i = 0; i < leads.length; i += L.MAX_LIST) out.push(...fn(leads.slice(i, i + L.MAX_LIST)));
  return out;
}
// A recorded finish only: a stage move or a later edit is not "we finished your project".
const finishedMs = (l) => L.ms(l.completedAt) || L.ms(l.installCompletedAt);

/** blockers: other dedupe keys; while any of their items is still waiting, this one is not filed. */
function candidate(lane, id, leadId, score, args, blockers) {
  const ln = LANES[lane];
  return { lane, botId: ln.botId, tool: ln.tool, dedupeKey: ln.prefix + id, leadId, score, blockers: blockers || [], args: Object.assign({ lead_id: leadId }, args) };
}

/** The post-job draft body (fixed wording; buildTextDraft adds the STOP line). */
function postJobBody(lead, company, year) {
  const first = firstName(lead);
  return (first ? 'Hi ' + first + ', this is ' : 'Hi, this is ') + company + '. '
    + (year ? 'It has been about a year since we finished your project, so we wanted to check in. How is everything holding up? If anything needs a look, reply here.'
      : 'It has been about a month since we finished your project. How is everything holding up? If anything looks off, reply here and we will take a look.');
}

/**
 * Every candidate filing for one company, per lane, best first (pure).
 * input: { leads, estimates, deals, invoices, nowMs, tz, names } — names =
 * L.companyNames(profile, isNbd): the company's own name, never NBD's for
 * another tenant. → { leadFirst: [...], quiet, followup, postJob30, postJob1y }
 */
function plan(input) {
  const x = input || {};
  const nowMs = x.nowMs;
  const tz = x.tz;
  const today = L.dayInZone(nowMs, tz);
  const act = L.activeLeads(x.leads);
  const byId = {};
  act.forEach((l) => { byId[l.id] = l; });
  const out = { leadFirst: [], quiet: [], followup: [], postJob30: [], postJob1y: [] };

  act.forEach((l) => {
    const created = L.ms(l.createdAt);
    if (l.isProspect || (SR.canonicalStageKey(l.stage) || 'new') !== 'new') return;
    // A CSV import (data-import.js) stamps createdAt now and importedAt: not a new lead.
    if (l.importedAt) return;
    if (!created || created > nowMs || nowMs - created > NEW_LEAD_HOURS * 3600000) return;
    const m = L.minimalLead(l, tz);
    const src = oneLine(l.source, 60);
    const what = oneLine(m.damage_type, 60);
    out.leadFirst.push(candidate('leadFirst', l.id, l.id, -created, { due_date: today,
      text: 'First contact: new lead ' + oneLine(m.name, 80) + (src ? ' from ' + src : '') + (what ? ', ' + what : '') + '. Came in ' + L.dayInZone(created, tz) + '.' + MARK }));
  });

  // One waiting radar reminder per lead: each quiet / follow-up key names the
  // lead's other radar keys as blockers (a revised quote is a new estimate id).
  const quietKeys = {};
  (x.estimates || []).forEach((e) => {
    if (e && e.id && e.leadId && e.deleted !== true) (quietKeys[e.leadId] = quietKeys[e.leadId] || []).push(LANES.quiet.prefix + e.id);
  });
  const overdueIds = {};
  everyRow(act, (chunk) => L.overdueFollowups(chunk, today, L.MAX_LIST, tz)).forEach((c) => {
    overdueIds[c.lead_id] = true;
    const late = Math.max(0, Math.round((ymdMs(today) - ymdMs(c.follow_up)) / DAY));
    out.followup.push(candidate('followup', c.lead_id, c.lead_id, (c.job_value || 0) + late * 50, { due_date: today,
      text: 'Follow up with ' + oneLine(c.name, 80) + ': ' + oneLine(c.stage, 40) + (c.job_value ? ', ' + money(c.job_value) : '') + '. Follow-up was due ' + c.follow_up + ' (' + late + ' days ago).' + MARK },
    quietKeys[c.lead_id] || []));
  });

  everyRow(act, (chunk) => L.estimatesStatus(x.estimates, x.deals, chunk, { quiet_days: QUIET_DAYS, limit: L.MAX_LIST }, nowMs, tz)).forEach((e) => {
    if (!e.estimate_id || overdueIds[e.lead_id]) return;
    const p = e.proposal || {};
    const last = p.last_viewed || p.sent || e.made;
    const key = LANES.quiet.prefix + e.estimate_id;
    out.quiet.push(candidate('quiet', e.estimate_id, e.lead_id, Number(e.total_customer_facing) || 0, { due_date: today,
      text: 'Proposal gone quiet for ' + (oneLine(e.name, 80) || 'this customer') + (e.total_customer_facing ? ' (' + money(e.total_customer_facing) + ')' : '')
        + (last ? ', last activity ' + String(last).slice(0, 10) : '') + '. Check in.' + MARK },
    (quietKeys[e.lead_id] || []).filter((k) => k !== key).concat(LANES.followup.prefix + e.lead_id)));
  });

  const company = (x.names || []).filter(Boolean)[0] || '';
  // Only a recorded finish, never a closeout stage where a check-in is wrong,
  // and only a customer the text gate would let a draft through for (the
  // Do-Not-Text list itself is read by draft_text).
  const inWindow = (w) => act.filter((l) => {
    const t = finishedMs(l);
    const d = t ? (nowMs - t) / DAY : -1;
    return d >= w[0] && d <= w[1] && NO_CHECKIN_STAGES.indexOf(SR.canonicalStageKey(l.stage)) === -1 && !L.textGate(l, { optedOut: false }).error;
  });
  [['postJob30', POST_30, false], ['postJob1y', POST_1Y, true]].forEach(([lane, w, year]) => {
    if (!company) return; // no company name: a text could not say who it is from
    everyRow(inWindow(w), (chunk) => L.postJob(chunk, x.invoices, nowMs, { days: w[1] + 5, limit: L.MAX_LIST }, tz)).forEach((j) => {
      const l = byId[j.lead_id];
      if (!l || j.balance_owed > 0 || j.quiet_backfill || truthy(l.doNotContact) || truthy(l.dnc)) return;
      if (year && j.anniversary_touch_sent) return;
      out[lane].push(candidate(lane, j.lead_id, j.lead_id, -(j.days_since || 0), {
        body: postJobBody(l, company, year),
        reason: 'Office planner: ' + (year ? 'one-year' : '30-day') + ' check-in; the job finished ' + (j.finished || 'recently') + '. Nothing is sent until you send it.',
      }));
    });
  });

  Object.keys(out).forEach((k) => out[k].sort((a, b) => b.score - a.score));
  return out;
}

/**
 * What may be filed this run (pure), per group: { budget, list }. list = the
 * group's lanes merged best first, without a key that is once-only and was
 * ever filed, a key whose item is still waiting (it would only dedupe), a
 * 7-day key filed or decided less than 7 days ago, or a key with a waiting
 * blocker. budget = what the run may still file: min(perRun, perDay - used).
 * The run fills the budget from the list; a refused filing uses no slot.
 * locks: { dedupeKey: { updatedAtMs, pending, decidedAtMs } } (keys with a lock).
 * used: { group: filings already made today }.
 */
function pick(planned, locks, nowMs, used) {
  const lk = locks || {};
  const waiting = (k) => !!(lk[k] && lk[k].pending);
  const out = {};
  Object.keys(GROUPS).forEach((g) => {
    const lanes = Object.keys(LANES).filter((lane) => LANES[lane].group === g);
    const list = [].concat(...lanes.map((lane) => ((planned || {})[lane] || []).filter((c) => {
      const l = lk[c.dedupeKey];
      if ((c.blockers || []).some(waiting)) return false;
      if (!l) return true;
      if (!LANES[lane].againDays || l.pending) return false;
      const last = Math.max(l.updatedAtMs || 0, l.decidedAtMs || 0);
      return nowMs - last >= LANES[lane].againDays * DAY;
    }))).sort((a, b) => b.score - a.score);
    const G = GROUPS[g];
    out[g] = { budget: Math.max(0, Math.min(G.perRun, G.perDay - (Number((used || {})[g]) || 0))), list };
  });
  return out;
}

function bodyOf(res) { try { return JSON.parse(res.content[0].text) || {}; } catch (_) { return {}; } }
/** A refusal's kind: 'customer' = that one customer's text gate (expected, the run is fine); 'lane' = anything that stops every filing (the daily limit, a wording gate, a missing name). */
function refusalKind(res) {
  const msg = String((((res || {}).content || [])[0] || {}).text || '');
  return /no textable phone|declined texting|Do-Not-Text list \(they replied STOP\)|company's Do-Not-Text list/i.test(msg) ? 'customer' : 'lane';
}
// Reads in chunks (getAll is one request; keep each small).
async function getAllChunked(db, refs) {
  const out = [];
  for (let i = 0; i < refs.length; i += 100) out.push(...(await db.getAll(...refs.slice(i, i + 100))));
  return out;
}

async function runCompany({ db, mcp, companyId, flags, nowMs, out }) {
  const keys = {};
  for (const botId of BOT_IDS) {
    keys[botId] = await mcp.contextFor({ id: SERVER_KEY_ID, botId, companyId, platform: 'server', capDoc: capDocFor(companyId) });
  }
  const any = keys[BOT_IDS[0]];
  if (!any) return;
  const sub = any.isNbd ? null : await db.doc('subscriptions/' + companyId).get().then((s) => (s.exists ? s.data() : null));
  if (!L.accessDecision({ settings: any.settings, isNbd: any.isNbd, personal: false, sub }).ok) { out.gated++; return; }
  const live = BOT_IDS.filter((b) => keys[b] && !L.pauseDecision({ settings: keys[b].settings, flags, platform: 'server', botId: b }));
  if (!live.length) { out.paused++; return; }

  const leads = await mcp.companyLeads(companyId);
  const [estimates, deals, invoices] = await Promise.all([
    mcp.companyDocs('estimates', companyId, ['companyId', 'userId']), mcp.companyDealRooms(companyId, leads),
    mcp.companyDocs('invoices', companyId, ['companyId', 'createdBy']),
  ]);
  const planned = plan({ leads, estimates, deals, invoices, nowMs, tz: any.tz, names: L.companyNames(any.profile, any.isNbd) });
  // Every key a candidate names (its own and its blockers): the lock, then the item the lock points at.
  const keySet = {};
  Object.keys(planned).forEach((lane) => planned[lane].forEach((c) => { keySet[c.dedupeKey] = true; c.blockers.forEach((k) => { keySet[k] = true; }); }));
  const allKeys = Object.keys(keySet);
  const locks = {};
  const lockSnaps = await getAllChunked(db, allKeys.map((k) => db.doc('agent_inbox_keys/' + L.dedupeLockId(companyId, k))));
  const itemOf = {};
  lockSnaps.forEach((s, i) => {
    if (!s.exists) return;
    const d = s.data() || {};
    locks[allKeys[i]] = { updatedAtMs: L.ms(d.updatedAt) };
    const itemId = String(d.itemId || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (itemId) itemOf[allKeys[i]] = itemId;
  });
  const withItem = Object.keys(itemOf);
  const itemSnaps = await getAllChunked(db, withItem.map((k) => db.doc('agent_inbox/' + itemOf[k])));
  itemSnaps.forEach((s, i) => {
    const it = s.exists ? (s.data() || {}) : null;
    const lk = locks[withItem[i]];
    lk.pending = !!it && L.dedupeOpen(it, companyId, withItem[i]);
    if (it) lk.decidedAtMs = L.ms(it.decidedAt);
  });

  const day = L.dayInZone(nowMs, any.tz);
  const capRef = db.doc(capDocFor(companyId));
  const capSnap = await capRef.get();
  const used = (((capSnap.exists ? capSnap.data() : null) || {}).plannerByDay || {})[day] || {};
  const picked = pick(planned, locks, nowMs, used);
  live.forEach((b) => { keys[b].leads = leads; });
  Object.keys(planned).forEach((lane) => {
    const row = out.lanes[lane] || (out.lanes[lane] = { planned: 0, filed: 0, deduped: 0, refused: 0, failed: 0 });
    row.planned += planned[lane].length;
  });
  const filedToday = {};
  for (const g of Object.keys(picked)) {
    const { budget, list } = picked[g];
    let filed = 0, tries = 0;
    for (const c of list) {
      if (filed >= budget || tries >= budget * TRIES_PER_SLOT) break;
      const key = keys[c.botId];
      if (live.indexOf(c.botId) === -1) continue;
      const row = out.lanes[c.lane];
      tries++;
      try {
        const res = await mcp.runTool(c.tool, Object.assign({}, c.args, { dedupe_key: c.dedupeKey }), key);
        const b = bodyOf(res);
        if (res.isError) {
          row.refused++;
          const kind = refusalKind(res);
          row.refusedBy = row.refusedBy || {};
          row.refusedBy[kind] = (row.refusedBy[kind] || 0) + 1;
          if (kind === 'lane') out.refusedLane++;
        } else if (b.deduped) row.deduped++;
        else if (b.filed) { row.filed++; filed++; }
        mcp.auditRow(key, c.tool, Object.assign({ ok: !res.isError, server: 'officePlanner' }, b.deduped ? { deduped: true } : {}));
      } catch (e) {
        row.failed++; out.failed++;
        logger.warn('[officePlanner] filing failed', { lane: c.lane, msg: e && e.message });
      }
    }
    if (filed) filedToday[g] = (Number(used[g]) || 0) + filed;
  }
  // The day's planner counts, beside fileItemOnce's filedByDay on the same doc.
  if (Object.keys(filedToday).length) await capRef.set({ plannerByDay: { [day]: filedToday } }, { merge: true });
}

/**
 * One run over every opted-in company. deps: { db, nowMs, enabled, mcp } —
 * mcp defaults to agent-mcp.js's internals (contextFor, companyLeads,
 * companyDocs, companyDealRooms, runTool, auditRow).
 */
async function runOfficePlanner(deps) {
  const d = deps || {};
  if (!d.enabled) return { dark: true };
  if (process.env.AGENT_MCP_DISABLED === 'true') return { off: 'AGENT_MCP_DISABLED' };
  const db = d.db;
  const mcp = d.mcp || require('./agent-mcp')._internal;
  const fl = await db.doc('feature_flags/global').get();
  const flags = fl.exists ? (fl.data() || {}) : {};
  if (flags.agentMcpDisabled === true) return { off: 'agentMcpDisabled' };
  const snap = await db.collection('agent_settings').where('officePlanner', '==', true).limit(500).get();
  const out = { companies: 0, gated: 0, paused: 0, failed: 0, failedCompanies: 0, refusedLane: 0, lanes: {} };
  for (const doc of snap.docs) {
    const settings = doc.data() || {};
    if (settings.officePlanner !== true) continue;
    out.companies++;
    try {
      await runCompany({ db, mcp, companyId: doc.id, flags, nowMs: d.nowMs, out });
    } catch (e) {
      out.failedCompanies++; out.failed++;
      logger.warn('[officePlanner] company failed', { msg: e && e.message });
    }
  }
  return out;
}

/** The scheduled body: run, log counts only, and report a failure, or a refusal that stops a lane, through softFail. */
async function tick(deps) {
  try {
    const r = await runOfficePlanner(deps);
    logger.info('[officePlanner]', r);
    if (r.failed) softFail(new Error('officePlanner: ' + r.failed + ' failure(s) (' + r.failedCompanies + ' company read(s))'));
    else if (r.refusedLane) softFail(new Error('officePlanner: ' + r.refusedLane + ' filing(s) refused (daily limit, wording gate or company name); see the lane counts'));
    return r;
  } catch (e) {
    logger.warn('[officePlanner] run failed', { msg: e && e.message });
    softFail(e);
    return { error: String((e && e.message) || e) };
  }
}

exports.officePlanner = onSchedule(
  { schedule: '0 8,12,17 * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 300, memory: '512MiB' },
  () => tick({ db: getFirestore(), nowMs: Date.now(), enabled: enabled() }),
);
exports._test = { LANES, GROUPS, TRIES_PER_SLOT, NEW_LEAD_HOURS, QUIET_DAYS, POST_30, POST_1Y, SERVER_KEY_ID, capDocFor, plan, pick, postJobBody, runOfficePlanner, tick };
