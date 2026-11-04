/**
 * storm-outreach-logic.js — storm REPORTS → who to check in on, with a draft
 * (2026-10-22, storm-and-demand queue).
 *
 * `storm_events` (storm-watch.js) holds the NWS/IEM local storm reports that
 * qualified for the service area (hail >= 0.75", wind >= 58 mph or a wind
 * damage report, any tornado). This turns one report into two lists, with a
 * fixed-wording draft each:
 *   - past_customer: a lead at a WON stage (the job was done)
 *   - open_lead:     anyone still in play (not won, not lost, not in
 *                    production — a customer mid-job is already being served)
 * A customer in Collections is left out too (no marketing text to someone who owes us).
 * Lost leads are left out. Pure: no I/O, no clock (nowMs is passed in).
 *
 * DRAFTS ONLY. The text is a draft for the owner to approve in the Agent
 * inbox; nothing here sends. It goes through buildTextDraft (company name +
 * STOP line + 480 cap) and the Kentucky claim-wording gate, and says nothing
 * about claims, outcomes, deductibles, prices or insurance. It states only
 * what the report says (a storm of that kind was reported near a town on a
 * date): no hail size, no gust speed, no promise there is damage.
 * Quiet hours (8am-9pm homeowner-local), STOP / Do-Not-Text / consent and the
 * texting switch are re-checked at SEND by agentDraftAction, not here.
 *
 * Returned lists never carry a phone number or email: only whether a phone is
 * on file.
 */
'use strict';

const L = require('./agent-mcp-logic');
const SR = require('./stage-roles');
const ST = require('./storm-time');
const { phoneDigits10 } = require('./phone-utils');

const MAX_EVENTS = 10;
const MAX_PER_EVENT = 40;

/** 'past_customer' | 'open_lead' | null (left out: lost, or already a job). */
function cohortOf(lead) {
  const l = lead || {};
  const withKey = Object.assign({}, l, { _stageKey: SR.canonicalStageKey(l.stage) || String(l.stage || 'new') });
  if (withKey._stageKey === 'collections') return null; // owes us money: no marketing text
  const role = SR.roleFor(withKey);
  if (role === SR.ROLE.WON) return 'past_customer';
  if (role === SR.ROLE.LOST || SR.isSale(withKey)) return null;
  return 'open_lead';
}

/** The hazard word the draft uses. A tornado report gets the plain "severe storm". */
function hazardOf(kind) {
  if (kind === 'hail') return 'hail';
  if (kind === 'wind') return 'wind';
  return 'storm';
}

function placeOf(ev) {
  return String((ev && ev.city) || '').replace(/[^A-Za-zÀ-ɏ'. -]/g, '').trim().slice(0, 40);
}

/**
 * One report + one customer → { body, reason } or { error }. Fixed wording; the
 * client never supplies text.
 */
function buildStormReportCheckIn(lead, names, ev) {
  const first = String((lead && lead.firstName) || '').replace(/[^A-Za-zÀ-ɏ' -]/g, '').trim().slice(0, 40);
  const company = (names || []).filter(Boolean)[0] || '';
  const what = { hail: 'a storm with hail', wind: 'a storm with damaging wind', storm: 'a severe storm' }[hazardOf(ev && ev.kind)];
  const place = placeOf(ev);
  const date = ST.dateTextEt(ev && ev.valid);
  const body = (first ? 'Hi ' + first + ', this is ' : 'Hi, this is ') + company + '. '
    + (what.charAt(0).toUpperCase() + what.slice(1)) + ' was reported ' + (place ? 'near ' + place : 'in the area') + (date ? ' on ' + date : '')
    + '. If you would like, we are happy to look over your roof and send you photos of what we find.';
  const d = L.buildTextDraft({ body, reason: 'Storm report: ' + what + ' was reported near this address. A check-in the owner approves.' }, names);
  if (d.error) return d;
  const wording = L.claimWordingProblem(d.body);
  if (wording) return { error: wording };
  return d;
}

function located(l) {
  return Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng)) && (Number(l.lat) || Number(l.lng));
}

/** Miles from a report to a lead, or null when either has no location. */
function milesTo(ev, lead) {
  if (!ev || !Number.isFinite(Number(ev.lat)) || !Number.isFinite(Number(ev.lon)) || !located(lead || {})) return null;
  return L.haversineMi(Number(ev.lat), Number(ev.lon), Number(lead.lat), Number(lead.lng));
}

const MAX_DAYS = 60; // the oldest report the list will ever show; filing refuses anything older

/** When a report happened (epoch ms), or 0 when it cannot be told. */
function reportMs(ev) {
  return ST.validMs(ev && ev.valid) || L.ms(ev && ev.processedAt);
}

/** May a draft still be filed from this report? Not when it is undated, in the future, or older than MAX_DAYS. */
function reportAgeOk(ev, nowMs) {
  const t = reportMs(ev);
  return t <= nowMs + 86400000 && t >= nowMs - MAX_DAYS * 86400000; // an undated report (t = 0) fails the lower bound
}

function clampArgs(args) {
  const a = args || {};
  return {
    days: Math.min(Math.max(Math.floor(Number(a.days)) || 14, 1), MAX_DAYS),
    miles: Math.min(Math.max(Number(a.miles) || 3, 0.5), 10),
  };
}

/**
 * events: storm_events docs (with .key); leads: the company's; names: the
 * company's draft-from names. → { days, miles, events: [...], without_location }.
 */
function planStormOutreach(events, leads, names, nowMs, args) {
  const { days, miles } = clampArgs(args);
  const cut = nowMs - days * 86400000;
  const when = (e) => ST.validMs(e.valid) || L.ms(e.processedAt);
  const live = L.activeLeads(leads);
  const place = live.filter(located);
  const out = (events || [])
    .filter((e) => e && e.key && Number.isFinite(Number(e.lat)) && Number.isFinite(Number(e.lon)) && when(e) >= cut)
    .sort((x, y) => when(y) - when(x))
    .slice(0, MAX_EVENTS)
    .map((e) => {
      const near = place.map((l) => ({ l, c: cohortOf(l), d: milesTo(e, l) }))
        .filter((x) => x.c && x.d != null && x.d <= miles)
        .sort((x, y) => x.d - y.d);
      const counts = { past_customer: 0, open_lead: 0 };
      near.forEach((x) => { counts[x.c]++; });
      return {
        key: String(e.key), kind: String(e.kind || ''), hazard: hazardOf(e.kind), where: [e.city, e.county, e.st].filter(Boolean).join(', '),
        when: String(e.valid || ''), when_text: ST.whenTextEt(e.valid), report: String(e.typetext || ''),
        counts,
        customers: near.slice(0, MAX_PER_EVENT).map((x) => {
          const d = buildStormReportCheckIn(x.l, names, e);
          const m = L.minimalLead(x.l);
          return Object.assign({ lead_id: m.lead_id, name: m.name, address: m.address, stage: m.stage }, {
            cohort: x.c, miles: Math.round(x.d * 10) / 10, has_phone: phoneDigits10(x.l.phone).length === 10,
            declined_texting: x.l.tcpaConsent === false, draft: d.error ? null : d.body, draft_problem: d.error || null,
          });
        }),
      };
    });
  return {
    days, miles, events: out, without_location: live.length - place.length,
    note: 'Storm REPORTS from the NWS feed, not per-roof proof. Drafts only: the owner approves every one; nothing is sent from here. Never promise a homeowner their claim will be paid.',
  };
}

module.exports = { MAX_EVENTS, MAX_PER_EVENT, MAX_DAYS, reportMs, reportAgeOk, cohortOf, hazardOf, buildStormReportCheckIn, milesTo, clampArgs, planStormOutreach };
