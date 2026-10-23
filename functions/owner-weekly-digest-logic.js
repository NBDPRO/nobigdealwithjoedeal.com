'use strict';
/**
 * owner-weekly-digest-logic.js — pure rules for the Monday owner digest
 * (2026-10-22). One Agent-inbox `report` per company per week, for the OWNER:
 *   - collected last week (payments by the date received, refunds subtracted)
 *   - estimates awaiting signature (a sent proposal not yet signed; PROJECTED)
 *   - calls to return (the Call Center "you said you'd" list; NBD only today)
 *   - jobs on the calendar this week
 * No cost, margin or profit figure: that is the weekly job-margin note's job.
 * Nothing here sends anything; owner-weekly-digest.js files the report.
 * Money in cents. Reuses agent-mcp-logic (collectedRevenue, estimatesStatus,
 * activeLeads) so the numbers match what the bots and Home already show.
 */
const L = require('./agent-mcp-logic');
const stageRoles = require('./stage-roles');

const MAX_LINES = 8; // per section; the rest is a "+N more" line
const SIGNED = /^(accepted|signed|declined|expired|void|cancel)/i;

/** Mon..Sun ymd for the week that CONTAINS `ymd`. */
function weekBounds(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dow = new Date(t).getUTCDay();            // 0 = Sun
  const back = (dow + 6) % 7;                     // days since Monday
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(t - back * 86400000), to: iso(t + (6 - back) * 86400000) };
}

/** The week that just ended (Mon..Sun) when the digest runs on `todayYmd`. */
function lastWeek(todayYmd) {
  const cur = weekBounds(todayYmd);
  const [y, m, d] = cur.from.split('-').map(Number);
  const prevSun = new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
  return weekBounds(prevSun);
}

function leadOut(l) {
  const r = stageRoles.roleFor(l);
  return stageRoles.isSale(l) || r === stageRoles.ROLE.LOST || r === stageRoles.ROLE.WON;
}

const cents = (dollars) => Math.round((Number(dollars) || 0) * 100);
function money(c) {
  const neg = c < 0;
  const s = String(Math.abs(Math.round(c / 100))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-$' : '$') + s;
}

function jobsThisWeek(leads, jobsByLead, bounds) {
  const out = [];
  const inWeek = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && v >= bounds.from && v <= bounds.to;
  const name = (l) => L.minimalLead(l).name || 'Customer';
  L.activeLeads(leads).forEach((l) => {
    const rows = [l].concat(((jobsByLead && jobsByLead[l.id]) || []).filter((j) => j && j.deleted !== true && j.id !== l.activeJobId));
    rows.forEach((r) => {
      if (inWeek(r.scheduledDate)) out.push({ leadId: l.id, name: name(l), day: r.scheduledDate });
    });
  });
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
}

/**
 * inputs: { leads, jobsByLead, invoices, estimates, deals, callItems (collectSweepItems rows, or null when
 *           the company has no Call Center), todayYmd, tz }
 */
function buildDigest(inp) {
  const tz = inp.tz || 'America/New_York';
  const week = lastWeek(inp.todayYmd);
  const thisWeek = weekBounds(inp.todayYmd);
  const leads = inp.leads || [];
  const rev = L.collectedRevenue(inp.invoices || [], leads, week.from, week.to, tz);

  const byId = {};
  L.activeLeads(leads).forEach((l) => { byId[l.id] = l; });
  const awaiting = L.estimatesStatus(inp.estimates || [], inp.deals || [], leads, { limit: 50 }, Date.parse(inp.todayYmd + 'T12:00:00Z'), tz)
    .filter((r) => r.proposal && !SIGNED.test(r.proposal.status) && byId[r.lead_id] && !leadOut(byId[r.lead_id]))
    .map((r) => ({ leadId: r.lead_id, name: r.name || 'Customer', totalCents: cents(r.total_customer_facing), sent: r.proposal.sent, views: r.proposal.views }))
    .sort((a, b) => b.totalCents - a.totalCents);

  const calls = inp.callItems == null ? null : inp.callItems.map((c) => ({ who: c.who, kind: c.kind, due: c.due }));
  return {
    week, thisWeek,
    collectedCents: cents(rev.collected), refundCents: cents(rev.refunds_subtracted), payments: rev.payments,
    awaiting, awaitingCents: awaiting.reduce((s, a) => s + a.totalCents, 0),
    calls,
    jobs: jobsThisWeek(leads, inp.jobsByLead, thisWeek),
  };
}

function section(title, lines) {
  if (!lines.length) return [];
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) shown.push('+ ' + (lines.length - MAX_LINES) + ' more');
  return [title].concat(shown.map((s) => '- ' + s));
}

/** { title, text } for an agent_inbox report (text <= MAX_TEXT). */
function render(d) {
  const out = [];
  out.push('Collected ' + d.week.from + ' to ' + d.week.to + ': ' + money(d.collectedCents) + ' in ' + d.payments + ' payment' + (d.payments === 1 ? '' : 's')
    + (d.refundCents ? ' (refunds of ' + money(d.refundCents) + ' already subtracted)' : '') + '. Money received only.');
  out.push('');
  out.push.apply(out, section('Estimates awaiting signature (' + d.awaiting.length + ', ' + money(d.awaitingCents) + ' PROJECTED, not collected):',
    d.awaiting.map((a) => a.name + ' ' + money(a.totalCents) + (a.sent ? ', sent ' + a.sent : '') + (a.views ? ', opened ' + a.views + 'x' : ', not opened'))));
  if (!d.awaiting.length) out.push('Estimates awaiting signature: none.');
  out.push('');
  if (d.calls == null) {
    // no Call Center for this company: say nothing rather than "0 calls"
  } else if (!d.calls.length) out.push('Calls to return: none.');
  else out.push.apply(out, section('Calls to return (' + d.calls.length + '):', d.calls.map((c) => c.who + (c.kind === 'urgent' ? ' (urgent)' : ''))));
  if (d.calls != null) out.push('');
  out.push.apply(out, section('Jobs on the calendar ' + d.thisWeek.from + ' to ' + d.thisWeek.to + ' (' + d.jobs.length + '):',
    d.jobs.map((j) => j.day + ' ' + j.name)));
  if (!d.jobs.length) out.push('Jobs on the calendar this week: none.');
  const text = out.join('\n').trim().slice(0, L.MAX_TEXT);
  return { title: ('Monday digest, week of ' + d.thisWeek.from).slice(0, 140), text };
}

module.exports = { weekBounds, lastWeek, buildDigest, render, money, jobsThisWeek };
