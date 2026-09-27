#!/usr/bin/env node
/**
 * scripts/thursday-backfill.js — run Thursday's past calls through the SAME
 * pipeline the live webhook uses (functions/integrations/thursday-logic.js).
 *
 * DRY-RUN (default): lists Thursday's inbound calls from Bland, extracts each
 * one with Claude, matches it against NBD's leads (read-only) and prints the
 * route it WOULD take — create lead / attach / possible match / inbox / log.
 * Nothing is written.
 *
 * --expect=<name-regex>:<attach|possible_match|no_new_lead> (repeatable) prints
 * PASS/FAIL for each call whose caller name or transcript matches — how the
 * brief's two acceptance cases are checked WITHOUT committing customers'
 * names to this public repo (they live in Jo's shell history only).
 *
 * APPLY (--apply --yes): writes a `pending` thursday_calls doc for each call
 * that has none yet (source 'backfill', notify 'suppress'). The deployed
 * thursdayCallProcess trigger then processes it exactly like a live call —
 * lead / task / activity / recording — but sends NO text, email or push, so a
 * backfill never floods Jo's phone. Calls already in thursday_calls are skipped.
 *
 *   node scripts/thursday-backfill.js                         # dry-run, since 2026-09-20
 *   node scripts/thursday-backfill.js --since=2026-09-24 --limit=50
 *   node scripts/thursday-backfill.js --call=<call_id>        # one call
 *   node scripts/thursday-backfill.js --no-extract            # list only, no Claude cost
 *   node scripts/thursday-backfill.js --apply --yes
 *
 * Cost: the dry-run calls Claude once per call (a few cents each); --apply
 * extracts again inside the trigger.
 * Env: NBD_PROJECT (default nobigdeal-pro), ADC credentials for Firestore,
 * BLAND_API_KEY / ANTHROPIC_API_KEY (else Secret Manager — scripts/_bland.js).
 */
'use strict';

const path = require('path');
const { initAdmin, getFirestore, FieldValue } = require('./_admin');
const { bland, secret, PROJECT } = require('./_bland');
const T = require(path.join('..', 'functions', 'integrations', 'thursday-logic.js'));

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const YES = args.includes('--yes');
const NO_EXTRACT = args.includes('--no-extract');
function flag(name) {
  const a = args.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : undefined;
}
const SINCE = flag('since') || '2026-09-20';
const LIMIT = Math.max(1, Math.min(1000, Number(flag('limit')) || 200));
const ONE = flag('call');
const EXPECTS = args.filter((x) => x.startsWith('--expect=')).map((x) => {
  const v = x.slice(9);
  const i = v.lastIndexOf(':');
  return { re: new RegExp(v.slice(0, i), 'i'), want: v.slice(i + 1) };
});

async function listCallIds() {
  if (ONE) return [ONE];
  const qs = new URLSearchParams({
    to_number: T.THURSDAY_NUMBER, inbound: 'true', limit: String(LIMIT), start_date: SINCE, ascending: 'true',
  });
  const j = await bland('/calls?' + qs.toString());
  const calls = (j && (j.calls || (j.data && j.data.calls))) || [];
  return calls.map((c) => c.call_id || c.c_id || c.id).filter(Boolean);
}

async function extract(call) {
  if (T.isEffectivelySilent(call)) return { extraction: T.silentExtraction(call), note: 'silent (no model call)' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: T.extractionHeaders(secret('ANTHROPIC_API_KEY')),
    body: JSON.stringify(T.buildExtractionRequest(call)),
    signal: AbortSignal.timeout(120000),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error('Claude ' + r.status + ' ' + JSON.stringify(json && json.error).slice(0, 200));
  const p = T.parseExtractionResponse(json);
  return { extraction: T.sanitizeExtraction(p.parsed), note: '$' + p.costUsd.toFixed(4) };
}

function line(s) { console.log(s); }

async function main() {
  if (APPLY && !YES) { console.error('Refusing to --apply without --yes. Re-run with: --apply --yes'); process.exit(2); }
  const EMULATED = !!process.env.FIRESTORE_EMULATOR_HOST;
  initAdmin(EMULATED ? { projectId: PROJECT, credential: null } : { projectId: PROJECT });
  const db = getFirestore();
  const companyId = T.NBD_OWNER_UID;

  line('═══════════════════════════════════════════════════════════');
  line('Thursday backfill → CRM');
  line('  project : ' + PROJECT + (EMULATED ? ' (EMULATOR)' : ''));
  line('  calls   : ' + (ONE ? 'one (' + ONE + ')' : 'inbound to ' + T.THURSDAY_NUMBER + ' since ' + SINCE + ' (limit ' + LIMIT + ')'));
  line('  mode    : ' + (APPLY ? 'APPLY (pending docs → trigger; notifications suppressed)' : 'DRY-RUN (no changes)'));
  line('═══════════════════════════════════════════════════════════');

  const ids = await listCallIds();
  line('Calls from Bland: ' + ids.length);
  // Tenant guard #1 — same query the trigger runs.
  const leadsSnap = NO_EXTRACT ? null : await db.collection('leads').where('companyId', '==', companyId).get();
  const leads = leadsSnap ? leadsSnap.docs.map((d) => Object.assign({ id: d.id }, d.data())) : [];
  const cfgSnap = await db.doc('thursday_config/' + companyId).get();
  const ownerNumbers = (cfgSnap.exists && Array.isArray(cfgSnap.data().ownerNumbers)) ? cfgSnap.data().ownerNumbers : [];
  if (leadsSnap) line('NBD leads loaded for matching: ' + leads.length);

  const results = [];
  let queued = 0, skippedExisting = 0, ignored = 0;
  for (const id of ids) {
    if (!T.isValidCallId(id)) { ignored++; continue; }
    let call;
    try { call = T.normalizeCall(await bland('/calls/' + encodeURIComponent(id))); } catch (e) {
      line('\n✗ ' + id + ': ' + e.message); continue;
    }
    if (!T.isThursdayCall(call)) { ignored++; continue; }
    const ref = db.doc('thursday_calls/' + T.callDocId(call.callId));
    const exists = (await ref.get()).exists;

    line('\n── ' + call.callId + '  ' + (call.startedAt || '?') + '  from ' + call.from + '  ' + T.fmtDuration(call.durationSec) + (exists ? '  [already in CRM]' : ''));
    if (call.summary) line('   summary : ' + call.summary.slice(0, 200));

    if (!NO_EXTRACT) {
      try {
        const x = await extract(call);
        const note = x.note;
        // Same overrides the trigger applies (Jo's own phones → test).
        const extraction = T.applyCallOverrides(x.extraction, call, { ownerNumbers: ownerNumbers });
        const match = T.matchLeads({ companyId, extraction, call, leads });
        const route = T.decideRoute(extraction, match);
        line('   caller  : ' + (extraction.caller_name || '?') + ' · ' + extraction.caller_type + (extraction.urgent ? ' · URGENT' : '') + '  (' + note + ')');
        line('   address : ' + [extraction.address, extraction.town, extraction.zip].filter(Boolean).join(', '));
        line('   issue   : ' + extraction.issue);
        line('   source  : ' + (extraction.heard_about_us || '—') + ' → ' + T.mapHeardAboutToSource(extraction.heard_about_us));
        line('   match   : ' + match.confidence + (match.lead ? ' → ' + match.lead.name + ' [' + match.lead.leadId + '] (' + match.lead.reasons.join(', ') + ')' : '') +
          (match.possible.length ? '  possible: ' + match.possible.map((p) => p.name + ' [' + p.leadId + ']').join('; ') : ''));
        line('   ROUTE   : ' + route.action.toUpperCase() + (route.leadId ? ' → ' + route.leadId : '') + ' · ' + route.label);
        results.push({ call, extraction, match, route });
      } catch (e) {
        line('   ✗ extraction failed: ' + e.message);
      }
    }

    if (APPLY && !exists) {
      await ref.create(Object.assign(T.buildPendingCallDoc(call, 'backfill', { notify: 'suppress' }),
        { createdAt: FieldValue.serverTimestamp() }));
      queued++;
      line('   → queued for processing');
    } else if (exists) {
      skippedExisting++;
    }
  }

  // Acceptance checks (--expect), e.g. an existing customer must attach,
  // a Thumbtack lead must be flagged rather than duplicated.
  if (!NO_EXTRACT) {
    if (EXPECTS.length) line('\n═══ Expectations ═══');
    for (const e of EXPECTS) {
      const hits = results.filter((r) => e.re.test((r.extraction.caller_name || '') + ' ' + r.call.transcript));
      if (!hits.length) { line(e.re + ' : no call in this window matches'); continue; }
      for (const r of hits) {
        const good = e.want === 'no_new_lead' ? r.route.action !== 'create_lead' : r.route.action === e.want;
        line(e.re + ' : ' + (good ? 'PASS' : 'FAIL') + ' — ' + r.route.action + (r.route.leadId ? ' → ' + r.route.leadId : ''));
      }
    }
    const tally = results.reduce((m, r) => { m[r.route.action] = (m[r.route.action] || 0) + 1; return m; }, {});
    line('\nRoutes: ' + JSON.stringify(tally));
  }
  line('\nIgnored (not Thursday inbound / bad id): ' + ignored + ' · already in CRM: ' + skippedExisting + (APPLY ? ' · queued: ' + queued : ''));
  if (!APPLY) line('Dry run only. Add --apply --yes to queue the new calls.');
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
