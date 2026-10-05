'use strict';

/**
 * functions/ops-scorecard.js — the weekly keep-or-cut scorecard (2026-10-04).
 *
 * Jo asked for data before deciding whether to keep the Grok Bot team and
 * Thursday (the Bland phone receptionist), instead of cutting them blind. The
 * health digest carries this section every day over the LAST 7 DAYS:
 *
 *   Bots      agent_inbox items filed (by bot) · agent_audit calls (by tool)
 *   Thursday  calls · silent · tests · new leads · existing customers ·
 *             unreviewed · minutes · extraction cost
 *
 * Reads only single-field range queries (createdAt / at >= 7 days ago), which
 * need no composite index. Pure summarisers are exported for the tests.
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;

function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Date.parse(v) || 0;
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  return 0;
}

function countBy(rows, keyOf) {
  const out = {};
  for (const r of rows) { const k = keyOf(r) || 'unknown'; out[k] = (out[k] || 0) + 1; }
  return Object.entries(out).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, n }));
}

/** agent_inbox + agent_audit rows (already windowed) → the bots half. */
function summarizeBots({ inbox, audit }) {
  const i = inbox || [];
  const a = audit || [];
  return {
    filed: i.length,
    filedByBot: countBy(i, (r) => r.bot || r.botId),
    approved: i.filter((r) => r.status === 'approved' || r.status === 'done').length,
    pending: i.filter((r) => r.status === 'pending').length,
    calls: a.length,
    callsByTool: countBy(a, (r) => r.tool),
    errors: a.filter((r) => r.ok === false).length,
  };
}

/** thursday_calls rows (already windowed) → the Thursday half. */
function summarizeThursday(calls) {
  const c = calls || [];
  const type = (r) => String(r.callerType || (r.extraction && r.extraction.caller_type) || 'unknown');
  let costUsd = 0;
  let seconds = 0;
  for (const r of c) {
    costUsd += Number(r.extractionMeta && r.extractionMeta.costUsd) || 0;
    seconds += Number(r.durationSec) || 0;
  }
  return {
    calls: c.length,
    silent: c.filter((r) => type(r) === 'silent').length,
    tests: c.filter((r) => type(r) === 'test').length,
    spam: c.filter((r) => type(r) === 'spam').length,
    newLeads: c.filter((r) => type(r) === 'new_lead').length,
    existingCustomers: c.filter((r) => type(r) === 'existing_customer').length,
    unreviewed: c.filter((r) => r.reviewed !== true).length,
    minutes: Math.round(seconds / 60),
    extractionCostUsd: Math.round(costUsd * 100) / 100,
  };
}

async function windowRows(db, collection, field, sinceMs) {
  const snap = await db.collection(collection).where(field, '>=', new Date(sinceMs)).limit(5000).get();
  const out = [];
  snap.forEach((d) => out.push(Object.assign({ id: d.id }, d.data() || {})));
  return out.filter((r) => toMs(r[field]) >= sinceMs);
}

async function gatherScorecard(db, nowMs) {
  const since = nowMs - WEEK_MS;
  const [inbox, audit, thursday] = await Promise.all([
    windowRows(db, 'agent_inbox', 'createdAt', since).catch(() => []),
    windowRows(db, 'agent_audit', 'at', since).catch(() => []),
    windowRows(db, 'thursday_calls', 'createdAt', since).catch(() => []),
  ]);
  return { bots: summarizeBots({ inbox, audit }), thursday: summarizeThursday(thursday) };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** HTML section for the health digest. */
function scorecardHtml(sc) {
  const b = (sc && sc.bots) || summarizeBots({});
  const t = (sc && sc.thursday) || summarizeThursday([]);
  const list = (rows) => rows.length ? rows.slice(0, 8).map((r) => esc(r.key) + ' ' + r.n).join(' · ') : '—';
  return [
    '<div style="font-size:13px;line-height:1.6;margin-bottom:14px;">',
    '<strong>Grok Bot team (7 days):</strong> ' + b.filed + ' inbox item' + (b.filed === 1 ? '' : 's') + ' filed (' + b.pending + ' pending) — by bot: ' + list(b.filedByBot) + '<br>',
    'CRM tool calls: <strong>' + b.calls + '</strong>' + (b.errors ? ' (' + b.errors + ' errors)' : '') + ' — by tool: ' + list(b.callsByTool) + '<br>',
    '<strong>Thursday (7 days):</strong> ' + t.calls + ' calls · ' + t.silent + ' silent · ' + t.tests + ' tests · ' + t.newLeads + ' new leads · '
      + t.existingCustomers + ' existing customers · ' + t.unreviewed + ' unreviewed · ' + t.minutes + ' min · $' + t.extractionCostUsd.toFixed(2) + ' extraction',
    '</div>',
    '<div style="font-size:11px;color:#888;margin-bottom:14px;">Keep or cut: Jo decides after a week of these numbers.</div>',
  ].join('\n');
}

module.exports = { WEEK_MS, summarizeBots, summarizeThursday, gatherScorecard, scorecardHtml, toMs };
