/**
 * inbound-sms-route-logic.js — pure tenant-safe routing decision for the
 * incomingSMS webhook (audit 2026-08-02 HIGH-5). Dependency-free (no firebase)
 * so tests/inbound-sms-route.test.js can require() it directly and the webhook
 * (sms-functions.js) shares the exact same code path — no logic mirror to
 * drift (pattern: inbound-sms-convert-logic.js).
 *
 * WHY: one shared Twilio number serves every tenant, so a bare
 * `phoneDigits == fromDigits` match with limit(1) could file a homeowner's
 * reply — and the AI draft generated from it — into ANOTHER company's lead.
 * This module takes ALL candidate leads for the sender's number and decides:
 *
 *   - 0 candidates                     → unmatched (existing triage inbox)
 *   - 1 candidate                      → route (the common case, unchanged)
 *   - N candidates, one tenant        → route to the most-recently-worked
 *                                        lead (outbound SMS recency, then
 *                                        lastContactedAt, then createdAt) —
 *                                        tenant is unambiguous so a wrong
 *                                        pick stays inside the right company
 *   - N candidates, multiple tenants  → route to the ESTABLISHED tenant: the
 *                                        one whose first outbound text to this
 *                                        number is the oldest — provided it
 *                                        has also texted within the recency
 *                                        window. Newer tenants' leads are
 *                                        returned as flaggedLeadIds (a newer
 *                                        thread can never take the reply
 *                                        over — 2026-10-03 hijack fix). No
 *                                        outbound history, a tie, or a stale
 *                                        established thread → UNMATCHED. We
 *                                        never guess across tenants: a
 *                                        misroute is a cross-company PII
 *                                        leak, a triaged message is a
 *                                        30-second admin task.
 *
 * Candidate shape (all timestamps in epoch millis or null):
 *   { id, companyId, userId, firstOutboundAt, lastOutboundAt, lastContactedAt, createdAt }
 * (firstOutboundAt absent → lastOutboundAt stands in for it.)
 *
 * Returns:
 *   { decision: 'route', leadId, ambiguity: null|'same-tenant'|'cross-tenant-resolved'|'cross-tenant-contested', flaggedLeadIds? }
 *   { decision: 'unmatched',     ambiguity: null|'cross-tenant-unresolved'|'cross-tenant-contested', flaggedLeadIds? }
 */
'use strict';

// A reply more than 30 days after the last outbound text isn't safely
// attributable to that thread — beyond this window we file to triage instead.
const DEFAULT_RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Tenant key: companyId with the repo-wide solo-owner fallback (companyId ==
// uid for solo tenants — see buildConvertedLead). A lead with neither (should
// not exist; rules require userId) gets a per-lead key so it can never be
// silently grouped with anything.
function tenantOf(c) {
  return c.companyId || c.userId || ('lead:' + (c.id || ''));
}

// Most-recently-worked comparator: outbound SMS recency beats lastContactedAt
// beats createdAt. Nulls sort last. Stable for full ties (Array.sort is stable
// in Node ≥ 12), so equal candidates keep query order.
function newestFirst(a, b) {
  const byOut = (b.lastOutboundAt || 0) - (a.lastOutboundAt || 0);
  if (byOut) return byOut;
  const byContact = (b.lastContactedAt || 0) - (a.lastContactedAt || 0);
  if (byContact) return byContact;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function pickLeadForInbound(candidates, opts) {
  const list = Array.isArray(candidates) ? candidates.filter(c => c && c.id) : [];
  const now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
  const windowMs = (opts && typeof opts.recencyWindowMs === 'number')
    ? opts.recencyWindowMs
    : DEFAULT_RECENCY_WINDOW_MS;

  if (list.length === 0) return { decision: 'unmatched', ambiguity: null };
  if (list.length === 1) return { decision: 'route', leadId: list[0].id, ambiguity: null };

  const tenants = new Set(list.map(tenantOf));
  if (tenants.size === 1) {
    const sorted = list.slice().sort(newestFirst);
    return { decision: 'route', leadId: sorted[0].id, ambiguity: 'same-tenant' };
  }

  // Cross-tenant (security batch 2026-10-03 — reply hijack). The old rule
  // routed to whichever tenant held the strictly-NEWEST outbound text. sendSMS
  // accepts any `to`, so any tenant could text another tenant's customer once
  // and capture every reply after it. Now the thread that was there FIRST
  // owns the reply: the tenant whose earliest outbound text to this number is
  // oldest (the established conversation). A newer tenant's thread can never
  // take it over — its leads come back in `flaggedLeadIds` for the caller to
  // log. The established tenant must still be FRESH (an outbound within the
  // window); if it has gone quiet while a newer tenant is texting, nobody can
  // be told apart from a hijacker, so the reply goes to triage.
  const firstOut = (c) => {
    const f = (typeof c.firstOutboundAt === 'number' && c.firstOutboundAt > 0) ? c.firstOutboundAt : 0;
    const l = (typeof c.lastOutboundAt === 'number' && c.lastOutboundAt > 0) ? c.lastOutboundAt : 0;
    // A row read without its first-outbound time falls back to the last one —
    // never later than the truth, so it can only make a lead look NEWER.
    return f && l ? Math.min(f, l) : (f || l);
  };
  const byTenant = new Map();
  for (const c of list) {
    const first = firstOut(c);
    if (!first) continue;                       // never texted by anyone here
    const key = tenantOf(c);
    const t = byTenant.get(key) || { key, first: Infinity, last: 0, leads: [] };
    t.first = Math.min(t.first, first);
    t.last = Math.max(t.last, (typeof c.lastOutboundAt === 'number' && c.lastOutboundAt > 0) ? c.lastOutboundAt : first);
    t.leads.push(c);
    byTenant.set(key, t);
  }
  if (byTenant.size === 0) return { decision: 'unmatched', ambiguity: 'cross-tenant-unresolved' };

  const ordered = Array.from(byTenant.values()).sort((a, b) => a.first - b.first);
  const established = ordered[0];
  const newer = ordered.slice(1);
  const flaggedLeadIds = [];
  for (const t of newer) for (const c of t.leads) flaggedLeadIds.push(c.id);

  // Two tenants that started on the same millisecond: no established thread.
  if (newer.length && newer[0].first === established.first) {
    return { decision: 'unmatched', ambiguity: 'cross-tenant-unresolved', flaggedLeadIds: [] };
  }
  if ((now - established.last) > windowMs) {
    return {
      decision: 'unmatched',
      ambiguity: newer.length ? 'cross-tenant-contested' : 'cross-tenant-unresolved',
      flaggedLeadIds,
    };
  }
  const pick = established.leads.slice().sort(newestFirst)[0];
  return {
    decision: 'route',
    leadId: pick.id,
    ambiguity: newer.length ? 'cross-tenant-contested' : 'cross-tenant-resolved',
    flaggedLeadIds,
  };
}

module.exports = { pickLeadForInbound, tenantOf, DEFAULT_RECENCY_WINDOW_MS };
