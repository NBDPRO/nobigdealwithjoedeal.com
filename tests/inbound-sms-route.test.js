/**
 * tests/inbound-sms-route.test.js — tenant-safe inbound-SMS routing decision
 * (functions/inbound-sms-route-logic.js, shared verbatim by the incomingSMS
 * webhook).
 *
 * Guards the audit 2026-08-02 HIGH-5 invariant: one shared Twilio number
 * serves every tenant, so a reply must NEVER be guessed into another
 * company's lead. The full decision table is pinned here — especially the
 * two cases that motivated the fix: cross-tenant with no outbound signal →
 * unmatched (triage, not a guess), and cross-tenant with exactly one fresh
 * outbound → routes to the tenant that was actually texting them.
 *
 * Zero deps (the logic module has no firebase imports).
 * Run: node tests/inbound-sms-route.test.js
 */
'use strict';

const path = require('path');
const R = require(path.join('..', 'functions', 'inbound-sms-route-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

const NOW = 1_800_000_000_000;           // fixed clock for every case
const DAY = 24 * 60 * 60 * 1000;
const pick = (cands, opts) => R.pickLeadForInbound(cands, Object.assign({ now: NOW }, opts));
const lead = (over) => Object.assign({
  id: 'L?', companyId: null, userId: null,
  lastOutboundAt: null, lastContactedAt: null, createdAt: null,
}, over);

console.log('INBOUND-SMS ROUTE — tenant-safe decision table');

// ── trivial cases ──────────────────────────────────────────────
{
  const r0 = pick([]);
  ok('0 candidates → unmatched, no ambiguity', r0.decision === 'unmatched' && r0.ambiguity === null);

  const r1 = pick([lead({ id: 'L1', companyId: 'coA', userId: 'u1' })]);
  ok('1 candidate → routes to it (the common case, unchanged)',
    r1.decision === 'route' && r1.leadId === 'L1' && r1.ambiguity === null);

  ok('garbage input never throws',
    pick(null).decision === 'unmatched' &&
    pick([null, undefined, {}]).decision === 'unmatched');
}

// ── same tenant, several leads: always routes, most-recently-worked wins ──
{
  const r = pick([
    lead({ id: 'Lold', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 20 * DAY }),
    lead({ id: 'Lnew', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 2 * DAY }),
  ]);
  ok('same tenant → routes (never triaged) to newest outbound',
    r.decision === 'route' && r.leadId === 'Lnew' && r.ambiguity === 'same-tenant');

  const r2 = pick([
    lead({ id: 'La', companyId: 'coA', userId: 'u1', lastContactedAt: NOW - 9 * DAY }),
    lead({ id: 'Lb', companyId: 'coA', userId: 'u1', lastContactedAt: NOW - 1 * DAY }),
  ]);
  ok('same tenant, no outbound history → lastContactedAt tiebreak',
    r2.decision === 'route' && r2.leadId === 'Lb');

  const r3 = pick([
    lead({ id: 'Lc', companyId: 'coA', userId: 'u1', createdAt: NOW - 40 * DAY }),
    lead({ id: 'Ld', companyId: 'coA', userId: 'u1', createdAt: NOW - 3 * DAY }),
  ]);
  ok('same tenant, cold leads → createdAt tiebreak', r3.decision === 'route' && r3.leadId === 'Ld');

  // Solo-owner convention: companyId may be absent; userId is the tenant key.
  const r4 = pick([
    lead({ id: 'Ls1', userId: 'solo' }),
    lead({ id: 'Ls2', userId: 'solo', lastContactedAt: NOW - DAY }),
  ]);
  ok('companyId-less solo leads group by userId (still same-tenant)',
    r4.decision === 'route' && r4.ambiguity === 'same-tenant');
}

// ── cross-tenant: THE misroute cases ───────────────────────────
{
  // No outbound signal on either side → refuse to guess.
  const r = pick([
    lead({ id: 'LA', companyId: 'coA', userId: 'u1', lastContactedAt: NOW - DAY }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2', lastContactedAt: NOW - 2 * DAY }),
  ]);
  ok('cross-tenant, no outbound signal → UNMATCHED (never guesses by activity)',
    r.decision === 'unmatched' && r.ambiguity === 'cross-tenant-unresolved');

  // Exactly one tenant texted them recently → that thread owns the reply.
  const r2 = pick([
    lead({ id: 'LA', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 2 * DAY }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2' }),
  ]);
  ok('cross-tenant, one fresh outbound → routes to the texting tenant',
    r2.decision === 'route' && r2.leadId === 'LA' && r2.ambiguity === 'cross-tenant-resolved');

  // Both tenants texted recently → the ESTABLISHED thread keeps the reply
  // (2026-10-03 reply-hijack fix). Before: the strictly-newest outbound won,
  // so tenant B could text tenant A's customer once and capture the replies.
  const r3 = pick([
    lead({ id: 'LA', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 5 * DAY }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2', lastOutboundAt: NOW - 1 * DAY }),
  ]);
  ok('cross-tenant, both fresh → the established (earlier) thread keeps the reply, NOT the newest',
    r3.decision === 'route' && r3.leadId === 'LA', JSON.stringify(r3));
  ok('…and the newer tenant\'s lead is flagged',
    Array.isArray(r3.flaggedLeadIds) && r3.flaggedLeadIds.length === 1 && r3.flaggedLeadIds[0] === 'LB'
      && r3.ambiguity === 'cross-tenant-contested', JSON.stringify(r3));

  // …but an exact tie is not a signal.
  const r4 = pick([
    lead({ id: 'LA', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - DAY }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2', lastOutboundAt: NOW - DAY }),
  ]);
  ok('cross-tenant, tied outbound timestamps → UNMATCHED',
    r4.decision === 'unmatched' && r4.ambiguity === 'cross-tenant-unresolved');

  // A stale outbound (outside the window) is no signal at all.
  const r5 = pick([
    lead({ id: 'LA', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 45 * DAY }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2' }),
  ]);
  ok('cross-tenant, only a stale (>30d) outbound → UNMATCHED',
    r5.decision === 'unmatched' && r5.ambiguity === 'cross-tenant-unresolved');

  // Window is configurable (webhook passes the default; tests prove the knob).
  const r6 = pick([
    lead({ id: 'LA', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 45 * DAY }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2' }),
  ], { recencyWindowMs: 60 * DAY });
  ok('recency window is configurable', r6.decision === 'route' && r6.leadId === 'LA');

  // 3-way: two leads in tenant A (one fresh), one in tenant B (cold) — the
  // fresh outbound uniquely identifies the thread even with a same-tenant
  // sibling in the mix.
  const r7 = pick([
    lead({ id: 'LA1', companyId: 'coA', userId: 'u1', lastOutboundAt: NOW - 2 * DAY }),
    lead({ id: 'LA2', companyId: 'coA', userId: 'u1' }),
    lead({ id: 'LB', companyId: 'coB', userId: 'u2' }),
  ]);
  ok('3-way cross-tenant with one fresh outbound → routes to it',
    r7.decision === 'route' && r7.leadId === 'LA1');
}

// ── reply hijack (security batch 2026-10-03) ───────────────────
// Tenant A has a months-long thread with the homeowner; tenant B (any
// account — sendSMS takes any `to`) texts the same number today. One shared
// Twilio number, so the homeowner's next reply arrives with no tenant on it.
{
  const hijack = [
    lead({ id: 'A-lead', companyId: 'coA', userId: 'uA',
      firstOutboundAt: NOW - 90 * DAY, lastOutboundAt: NOW - 3 * DAY, createdAt: NOW - 95 * DAY }),
    lead({ id: 'B-lead', companyId: 'coB', userId: 'uB',
      firstOutboundAt: NOW - 60 * 1000, lastOutboundAt: NOW - 60 * 1000, createdAt: NOW - 2 * 60 * 1000 }),
  ];
  const r = pick(hijack);
  ok('hijack: B texted a minute ago, A has the established thread → reply stays with A',
    r.decision === 'route' && r.leadId === 'A-lead', JSON.stringify(r));
  ok('hijack: B\'s lead is flagged for review', JSON.stringify(r.flaggedLeadIds) === '["B-lead"]');

  // Input order must not matter (Firestore returns candidates in id order).
  const rRev = pick(hijack.slice().reverse());
  ok('hijack: candidate order does not change the decision', rRev.decision === 'route' && rRev.leadId === 'A-lead');

  // B keeps texting — many recent outbound texts never make B's thread older.
  const r2 = pick([
    hijack[0],
    lead({ id: 'B-lead', companyId: 'coB', userId: 'uB',
      firstOutboundAt: NOW - 2 * DAY, lastOutboundAt: NOW - 1000 }),
  ]);
  ok('hijack: repeated texting by the newer tenant still loses to the established thread',
    r2.decision === 'route' && r2.leadId === 'A-lead');

  // A's thread went quiet (last text 45 days ago) and B is texting now: no
  // tenant can be trusted with it → triage, never B.
  const r3 = pick([
    lead({ id: 'A-lead', companyId: 'coA', userId: 'uA',
      firstOutboundAt: NOW - 120 * DAY, lastOutboundAt: NOW - 45 * DAY }),
    lead({ id: 'B-lead', companyId: 'coB', userId: 'uB',
      firstOutboundAt: NOW - DAY, lastOutboundAt: NOW - DAY }),
  ]);
  ok('stale established thread + fresh newer tenant → UNMATCHED (contested), never the newer tenant',
    r3.decision === 'unmatched' && r3.ambiguity === 'cross-tenant-contested'
      && JSON.stringify(r3.flaggedLeadIds) === '["B-lead"]', JSON.stringify(r3));

  // A has two leads with this number; the reply goes to A's most recently
  // texted one (same within-tenant rule as before).
  const r4 = pick([
    lead({ id: 'A-old', companyId: 'coA', userId: 'uA', firstOutboundAt: NOW - 200 * DAY, lastOutboundAt: NOW - 150 * DAY }),
    lead({ id: 'A-new', companyId: 'coA', userId: 'uA', firstOutboundAt: NOW - 20 * DAY, lastOutboundAt: NOW - 2 * DAY }),
    lead({ id: 'B-lead', companyId: 'coB', userId: 'uB', firstOutboundAt: NOW - DAY, lastOutboundAt: NOW - DAY }),
  ]);
  ok('established tenant with two leads → its most recently texted lead',
    r4.decision === 'route' && r4.leadId === 'A-new');

  // B holds the number as a lead but never texted it: nothing to flag.
  const r5 = pick([
    hijack[0],
    lead({ id: 'B-cold', companyId: 'coB', userId: 'uB', createdAt: NOW - DAY }),
  ]);
  ok('newer tenant without outbound history is not flagged',
    r5.decision === 'route' && r5.leadId === 'A-lead' && r5.ambiguity === 'cross-tenant-resolved'
      && r5.flaggedLeadIds.length === 0, JSON.stringify(r5));

  // Single-tenant behaviour is untouched: B alone, however new, routes.
  const r6 = pick([hijack[1]]);
  ok('single candidate still routes regardless of history', r6.decision === 'route' && r6.leadId === 'B-lead' && r6.ambiguity === null);
  const r7 = pick([
    lead({ id: 'A1', companyId: 'coA', userId: 'uA', firstOutboundAt: NOW - 90 * DAY, lastOutboundAt: NOW - 80 * DAY }),
    lead({ id: 'A2', companyId: 'coA', userId: 'uA', firstOutboundAt: NOW - DAY, lastOutboundAt: NOW - DAY }),
  ]);
  ok('same tenant still routes to the newest outbound (unchanged)',
    r7.decision === 'route' && r7.leadId === 'A2' && r7.ambiguity === 'same-tenant');
}

// ── module contract ────────────────────────────────────────────
{
  ok('default window is 30 days', R.DEFAULT_RECENCY_WINDOW_MS === 30 * DAY);
  ok('tenantOf falls back companyId → userId → per-lead key',
    R.tenantOf({ companyId: 'c' }) === 'c' &&
    R.tenantOf({ userId: 'u' }) === 'u' &&
    R.tenantOf({ id: 'x' }) === 'lead:x');
  ok('stays firebase-free (pure, requirable with zero deps)',
    !require('fs').readFileSync(path.join(__dirname, '..', 'functions', 'inbound-sms-route-logic.js'), 'utf8')
      .includes("require('firebase"));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.error('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
