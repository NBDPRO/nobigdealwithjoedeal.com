/**
 * functions/handlers/ai-texting.js — T-1: AI Texting foundation
 * ═══════════════════════════════════════════════════════════════
 *
 * KICKOFF STATE: this is the canonical home for the T-1 module
 * (ported from the WIP at `claude/t1-ai-texting-foundation` commit
 * `013f457`, paused during v2.0-final cleanup). It exports
 * `generateAIDraft` but is not yet imported anywhere — the file
 * deploys with zero new triggers. The next PR (T-1 step 2) will
 * require it from `sms-functions.js`'s incomingSMS handler and start
 * writing drafts to `/leads/{leadId}/ai_drafts`. Until then this is a
 * pure helper module gated on ANTHROPIC_API_KEY (already declared by
 * `handlers/ai.js` for the Claude proxy, so no new secret setup is
 * needed when step 2 lands).
 *
 * Drafts SMS replies for the rep to one-tap send. Triggered by the
 * incomingSMS webhook (functions/sms-functions.js) — when a homeowner
 * texts in, this module:
 *
 *   1. Pulls lead context (lead doc + recent SMS history + recent
 *      notes/activity) so Claude has a real conversation memory
 *   2. Calls Claude Haiku 4.5 with the "Joe's assistant" persona +
 *      hard guardrails (no pricing, no scope commitments, no
 *      scheduling promises)
 *   3. Writes a doc to /leads/{leadId}/ai_drafts/{draftId} with the
 *      draft + status:'pending'
 *   4. Sends a rep-bell notification with the draft text
 *
 * The rep sees this in the CRM (T-2 ships the UI), can edit / send
 * with one tap, or skip. No customer-facing autonomous send in v1
 * — every text the customer receives is rep-approved.
 *
 * Persona: "Joe's assistant texting on his behalf" — TCPA-clean
 * identification, sets expectations that the homeowner is talking
 * to an assistant, not Joe directly.
 *
 * Guardrails (encoded in the system prompt):
 *   - NEVER quote a price
 *   - NEVER commit to a scope of work
 *   - NEVER commit to a date without "I'll have Joe confirm"
 *   - ALWAYS identify as Joe's assistant on first message
 *   - When unsure, escalate ("Let me grab Joe on that")
 *
 * Cost: ~$0.01 per draft (Haiku is ~$0.25/M input + $1.25/M output;
 * average draft = 800 input tokens + 80 output tokens = ~$0.0003).
 * At 1000 inbound SMS/month, ~$0.30/mo of AI cost.
 */

'use strict';

const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { FieldValue } = require('firebase-admin/firestore');
const { buildPersonaPrompt, sanitizeMultiline } = require('./ai-persona');
const { channelForTriggerType } = require('../ai-draft-routing');

// Neutralize customer-controlled text before it goes INTO the AI prompt:
// sanitizeMultiline kills forged "═══" section headers; the replace strips
// forged speaker labels ([HOMEOWNER]/[JOE/ASSISTANT]) so an inbound SMS can't
// inject a fake conversation turn or override the system instructions. Rep
// persona input was already sanitized; the homeowner side was not.
function cleanInbound(s, max) {
  return sanitizeMultiline(s, max || 240)
    .replace(/\[\s*(HOMEOWNER|JOE\s*\/\s*ASSISTANT|ASSISTANT|JOE|SYSTEM|USER)\s*\]/gi, '( )');
}

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const { secretValue } = require('../integrations/_shared');
const { isAiDraftDisabled } = require('../integrations/killswitch');

// ─── Persona system prompt ─────────────────────────────────────
// Locked in this module so every draft uses the same identity +
// guardrails. If we want a per-rep persona later (Joe's assistant
// vs. another rep's), add a per-user setting and template-merge
// the rep's first name in.
const PERSONA_PROMPT = `You are "Joe's assistant" — an AI texting on behalf of Joe Deal of No Big Deal Home Solutions, a residential roofing company in Greater Cincinnati. Joe is a hands-on field rep; you handle his first-touch SMS replies while he's on a roof.

═══ IDENTITY ═══
- On a FIRST message to a new homeowner: open with "Hi {firstName} — this is Joe's assistant texting on his behalf while he's in the field." Be transparent. Never pretend to be Joe.
- On a CONTINUING thread: drop the intro. Just respond naturally as Joe's assistant would.
- Sign off with "— Joe's assistant" only when it feels natural; not every message needs it.

═══ TONE ═══
- Warm, brief, professional. Match how a small-business owner in Cincinnati would text — friendly but not chatty.
- Texts should usually be 1-3 sentences. Long replies feel robotic over SMS.
- Use the homeowner's first name once if you have it.

═══ HARD RULES — NEVER VIOLATE ═══
1. NEVER quote a price or estimate. If asked "how much?" → "Joe handles all pricing personally — he'll come out, take a look, and put a real number on it for you. Want to set up a free inspection?"
2. NEVER commit to a date or time without checking. If asked "when can you come?" → "Let me check Joe's schedule and I'll text back a couple options."
3. NEVER promise scope ("yes we'll replace your gutters too"). If asked → "That's exactly the kind of thing Joe wants to look at in person."
4. NEVER make up details about a customer or job you don't see in context.
5. If a homeowner sounds angry, frustrated, or mentions a complaint → don't try to fix it via text. Reply: "I want to make sure Joe gets this directly — he'll call you back today. Best number to reach you?"
6. If asked anything legal, insurance, or technical that's outside basic info → escalate: "Joe's the one to answer that — he'll get back to you shortly."

═══ THINGS YOU CAN HELP WITH ═══
- Confirming/rescheduling inspections (offer to check Joe's calendar)
- Sharing the company portal link if the homeowner is already a customer
- Acknowledging messages so the homeowner knows we got them
- Asking for basic info if they're a new lead (address, what's going on with the roof)
- Reminding about upcoming appointments
- Saying thanks after a job + asking how the work is holding up

═══ FORMAT ═══
Return ONLY the SMS text — no preamble, no commentary, no "Here's a draft:". Just the message a human would tap Send on.`;

// ─── Anthropic call ────────────────────────────────────────────
async function callClaudeForDraft({ system, userText, maxTokens, apiKey }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
      'Anthropic-Version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    logger.warn('[ai-texting] Claude error', { status: res.status, body: body.slice(0, 300) });
    throw new Error('AI draft generation failed');
  }
  const data = await res.json();
  const text = (data?.content?.[0]?.text || '').trim();
  return { text, usage: data?.usage || null };
}

// ─── Context builder ───────────────────────────────────────────
// Pulls the conversation memory Claude needs:
//   - Lead identity (firstName, lastName, address, stage)
//   - Last N inbound/outbound SMS for this lead (so the AI sees the
//     thread, not just the latest message)
//   - The 3 most recent activity entries (notes, voice memos, etc.)
//
// Output is a compact text block ready to splice into the prompt.
async function buildLeadContext(db, leadId, lead, incomingBody) {
  const firstName = lead.firstName || '';
  const lastName  = lead.lastName  || '';
  const stage     = lead.stage     || 'new';
  const address   = lead.address   || '';
  // Won by role (2026-10-04), not the one legacy spelling 'Complete' — a
  // closed / final-payment / install-complete customer is a customer too.
  const isCustomer= require('../stage-roles').isWon(lead) || lead.completedAt || lead.installCompletedAt;
  const isProspect= !!lead.isProspect;

  // ── Conversation history: SMS thread, homeowner-portal thread, activity ──
  // All three are independent, so they run CONCURRENTLY: generateAIDraft is
  // awaited inside the incomingSMS webhook against Twilio's 15s ceiling, and
  // serial round-trips here spend that budget for nothing. Each query keeps its
  // own skip-on-error semantics (a missing index must degrade, never throw).
  //
  // The portal is a SECOND conversation channel (onPortalMessageDraft drafts
  // replies to it). Without the portal read every portal draft was generated as
  // a cold first contact — the thread section below claimed "first inbound
  // SMS", so the persona re-introduced itself on every message and the AI could
  // cite neither the homeowner's earlier question nor its own prior answer.
  const leadRef = db.collection('leads').doc(leadId);
  const [threadSnap, portalSnap, activitySnap] = await Promise.all([
    leadRef.collection('notes')
      .where('type', '==', 'sms')
      .orderBy('createdAt', 'desc')
      .limit(12).get().catch((e) => { logger.warn('ai_sms_thread_read_failed', { leadId, code: e && e.code, err: String((e && e.message) || e).slice(0, 200) }); return null; }),
    leadRef.collection('portal_messages')
      .orderBy('createdAt', 'desc')
      .limit(12).get().catch(() => null),      // no portal thread / no index; skip
    leadRef.collection('activity')
      .orderBy('createdAt', 'desc')
      .limit(5).get().catch(() => null),       // no activity yet; skip
  ]);
  // .reverse() → chronological, matching the "oldest → newest" headers below.
  const thread       = threadSnap ? threadSnap.docs.map(d => d.data()).reverse() : [];
  const portalThread = portalSnap ? portalSnap.docs.map(d => d.data()).reverse() : [];
  const activity     = activitySnap ? activitySnap.docs.map(d => d.data()) : [];

  // ── Format ──
  const lines = [];
  lines.push('═══ WHO THIS IS ═══');
  lines.push(`Name: ${firstName} ${lastName}`.trim() || 'Name: (unknown)');
  if (address) lines.push(`Address: ${address}`);
  lines.push(`Relationship: ${isCustomer ? 'Past customer (job complete)' : isProspect ? 'Prospect (not yet qualified)' : 'Active lead — stage ' + stage}`);
  if (lead.jobType) lines.push(`Job type: ${lead.jobType}`);
  if (lead.insCarrier) lines.push(`Insurance carrier: ${lead.insCarrier}`);
  if (lead.claimNumber) lines.push(`Claim no.: ${lead.claimNumber}`);

  if (thread.length > 0) {
    lines.push('');
    lines.push('═══ RECENT TEXT THREAD (oldest → newest) ═══');
    for (const m of thread) {
      const dir = m.direction === 'incoming' ? 'HOMEOWNER' : 'JOE/ASSISTANT';
      const body = cleanInbound(m.body, 240);
      lines.push(`[${dir}] ${body}`);
    }
  } else {
    lines.push('');
    lines.push('═══ RECENT TEXT THREAD ═══');
    lines.push('(no prior text history with this lead)');
  }

  if (portalThread.length > 0) {
    lines.push('');
    lines.push('═══ HOMEOWNER PORTAL THREAD (oldest → newest) ═══');
    for (const m of portalThread) {
      const dir = m.source === 'homeowner' ? 'HOMEOWNER' : 'JOE/ASSISTANT';
      lines.push(`[${dir}] ${cleanInbound(m.text, 240)}`);
    }
  }

  // Nothing at all on EITHER channel is the only true first contact — say so
  // explicitly rather than letting the empty-SMS branch above imply it.
  if (thread.length === 0 && portalThread.length === 0) {
    lines.push('(this is your first exchange with this lead on any channel)');
  }

  if (activity.length > 0) {
    lines.push('');
    lines.push('═══ RECENT ACTIVITY ═══');
    for (const a of activity) {
      // EVERY field here can be homeowner-authored: textPreview on a
      // portal_message_in entry is the raw inbound text (portal.js only trims +
      // clamps it), so it must go through cleanInbound like the thread lines
      // above — otherwise '═══' headers and '[HOMEOWNER]' labels survive into
      // the prompt and can forge a conversation turn / argue with the locked
      // guardrails. This block feeds the SMS draft path too (the activity query
      // is unfiltered), so an unsanitized preview would be a live-SMS hole.
      const label = cleanInbound(a.label || a.type || 'activity', 60);
      const msg = cleanInbound(a.message || a.transcript || a.textPreview || '', 120);
      lines.push(`- ${label}${msg ? ': ' + msg : ''}`);
    }
  }

  lines.push('');
  lines.push('═══ THE NEW INBOUND MESSAGE TO REPLY TO ═══');
  lines.push(cleanInbound(incomingBody, 600));

  return lines.join('\n');
}

// ─── T-4: persona resolution ───────────────────────────────────
// Returns the persona CONFIG (structured slider/identity object) to use
// for this lead, or null to fall back to the original locked PERSONA_PROMPT.
// Precedence: the lead owner's per-rep persona, then the company default.
//
// Multi-tenant branding (gauntlet Batch 3): the hardcoded PERSONA_PROMPT names
// "Joe Deal of No Big Deal Home Solutions … Greater Cincinnati", so it may
// ONLY be used for the NBD tenant. Two adjustments make this safe:
//   (1) A configured persona that never set its own companyName/identityName
//       is gap-filled from the tenant's companyProfile.brand.legalName (+ the
//       rep's display name), so its buildPersonaPrompt output is tenant-branded.
//   (2) When NO persona is configured, a NON-NBD tenant gets a minimal
//       SYNTHESIZED branded config (routed through buildPersonaPrompt by the
//       caller) instead of the NBD PERSONA_PROMPT.
// NBD stays byte-identical: brand.legalName is 'No Big Deal Home Solutions'
// (== buildPersonaPrompt's DEFAULT_COMPANY_NAME) so the companyName fill is a
// no-op; identityName is filled only for non-NBD tenants (NBD keeps its 'Joe'
// default); and a null persona for NBD still returns null → PERSONA_PROMPT.
// All reads are best-effort; any failure falls through, never blocks a draft.
async function resolvePersona(db, userId, companyId, repDisplayName) {
  // ONE companyProfile read, reused for BOTH the company-default persona and
  // the tenant brand used to fill/synthesize below.
  let brand = {};
  let companyPersona = null;
  const cid = companyId || userId;
  if (cid) {
    try {
      const snap = await db.collection('companyProfile').doc(String(cid)).get();
      if (snap.exists) {
        const data = snap.data() || {};
        const at = data.aiTexting;
        if (at && at.defaultPersona && at.defaultPersona.enabled !== false) companyPersona = at.defaultPersona;
        brand = data.brand || {};
      }
    } catch (e) { logger.warn('[ai-texting] persona read (company) failed', { companyId, err: e.message }); }
  }

  // User-level persona wins over the company default (same precedence as before).
  let persona = null;
  try {
    if (userId) {
      const snap = await db.collection('users').doc(String(userId)).collection('settings').doc('aiPersona').get();
      if (snap.exists) {
        const d = snap.data() || {};
        if (d.enabled !== false && (d.traits || d.presetId || d.customInstructions || d.identityName)) persona = d;
      }
    }
  } catch (e) { logger.warn('[ai-texting] persona read (user) failed', { userId, err: e.message }); }
  if (!persona) persona = companyPersona;

  const legalName = brand.legalName || '';
  const isNBD = !legalName || legalName === 'No Big Deal Home Solutions';
  let repName = (repDisplayName && String(repDisplayName).slice(0, 40)) || '';
  // Callers pass lead.repName, which the lead form never writes — so a tenant
  // draft fell back to the COMPANY name as the rep ("this is Demo Roofing Co's
  // assistant … while Demo Roofing Co is in the field"). The owning rep's
  // profile name is the right fallback. Only read for non-NBD (NBD keeps its
  // 'Joe' default byte-identical).
  if (!repName && !isNBD && userId) {
    try {
      const u = await db.collection('users').doc(String(userId)).get();
      let dn = u.exists ? String((u.data() || {}).displayName || '').trim() : '';
      if (!dn) {
        // No profile doc yet (invited reps often have none) — the sign-in name.
        const { getAuth } = require('firebase-admin/auth');
        const rec = await getAuth().getUser(String(userId));
        dn = String((rec && rec.displayName) || '').trim();
      }
      if (dn) repName = dn.split(/\s+/)[0].slice(0, 40); // first name, as a homeowner would hear it
    } catch (e) { /* best-effort — falls back to the company name below */ }
  }

  if (persona) {
    // Fill only the GAPS so a tenant that set its own companyName/identityName
    // keeps them. companyName ← legalName is byte-safe for NBD (== the builder's
    // DEFAULT_COMPANY_NAME); identityName is filled only for a NON-NBD tenant so
    // NBD keeps buildPersonaPrompt's 'Joe' default → byte-identical.
    const p = Object.assign({}, persona);
    if (!p.companyName && legalName) p.companyName = legalName;
    // Fill identityName for ANY non-NBD tenant, even when repName is empty —
    // otherwise buildPersonaPrompt falls to DEFAULT_REP_NAME='Joe', leaking
    // Joe's name into a stranger tenant's homeowner SMS. Falls back to legalName
    // (matches the no-persona branch below). NBD keeps the 'Joe' default.
    if (!p.identityName && !isNBD) p.identityName = repName || legalName;
    return p;
  }

  // No persona configured. A NON-NBD tenant must NOT fall through to the
  // NBD-hardcoded PERSONA_PROMPT — synthesize a minimal branded config so the
  // caller routes it through buildPersonaPrompt with the tenant's own identity.
  if (!isNBD) {
    return { companyName: legalName, identityName: repName || legalName };
  }
  // NBD (or brand-less): null → caller uses the locked PERSONA_PROMPT, unchanged.
  return null;
}

// ─── Main entry ────────────────────────────────────────────────
// Called by sms-functions.js's incomingSMS webhook. Generates a
// draft + writes to /leads/{leadId}/ai_drafts. Returns the draftId
// (or null on failure — caller logs but doesn't fail the webhook).
//
// Wrapped in a 12s safety timeout so a slow Claude response can't
// blow Twilio's 15s webhook ceiling.
async function generateAIDraft({ db, leadId, lead, incomingBody, incomingNoteId, incomingPhone, triggerType = 'inbound_sms' }) {
  if (!leadId || !lead || !incomingBody) return null;

  let apiKey;
  apiKey = secretValue(ANTHROPIC_API_KEY); // '__unset__' stub → null
  if (!apiKey) {
    logger.info('[ai-texting] ANTHROPIC_API_KEY unset — skipping draft generation');
    return null;
  }

  // Global kill switch (SPEND_KILLSWITCH.md). One write to
  // feature_flags/global.aiDraftDisabled stops this Anthropic call across
  // ALL three callers (incomingSMS, onPortalMessageDraft,
  // convertUnmatchedSms) without a deploy. Checked here rather than at each
  // call site so no future caller can accidentally ship ungated. The
  // underlying inbound message/lead is unaffected either way — only the
  // drafted reply is skipped.
  if (await isAiDraftDisabled()) {
    logger.warn('[ai-texting] draft generation skipped — aiDraftDisabled flag is set', { leadId, triggerType });
    return null;
  }

  const t0 = Date.now();
  // Build context + resolve the persona in parallel so persona lookup adds
  // no latency to the webhook's budget.
  const [contextBlock, persona] = await Promise.all([
    buildLeadContext(db, leadId, lead, incomingBody),
    resolvePersona(db, lead.userId, lead.companyId, lead.repName),
  ]);

  // Use the rep/company persona when one is configured; otherwise the
  // original locked prompt (zero behavior change for un-customized accounts).
  let systemPrompt = PERSONA_PROMPT;
  let personaPreset = null;
  let personaName = null;
  if (persona) {
    try {
      systemPrompt = buildPersonaPrompt(persona);
      personaPreset = persona.presetId || 'custom';
      personaName = (persona.identityName && String(persona.identityName).slice(0, 40)) || null;
    } catch (e) {
      logger.warn('[ai-texting] persona prompt build failed — using default', { err: e.message });
      systemPrompt = PERSONA_PROMPT;
    }
  }

  // Hard 10s timeout on the Claude call so the webhook stays under
  // Twilio's 15s ceiling even if Anthropic is being slow.
  const claudePromise = callClaudeForDraft({
    system: systemPrompt,
    userText: contextBlock,
    maxTokens: 280, // SMS = 1-3 sentences; 280 tokens ≈ 200 words ≈ 1300 chars
    apiKey,
  });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('claude_timeout')), 10_000));

  let result;
  try {
    result = await Promise.race([claudePromise, timeout]);
  } catch (e) {
    logger.warn('[ai-texting] draft generation failed', { leadId, err: e.message });
    return null;
  }

  const draftText = (result.text || '').trim();
  if (!draftText) return null;

  const ownerUid  = lead.userId || null;
  const companyId = lead.companyId || ownerUid || null;
  const customerName = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || null;

  try {
    const ref = await db.collection('leads').doc(leadId).collection('ai_drafts').add({
      leadId,
      userId: ownerUid,
      companyId,
      triggerType:   triggerType || 'inbound_sms',
      // Explicit delivery channel alongside triggerType. onAiDraftApproved
      // accepts either signal, so a portal reply can never fall through to the
      // SMS branch (and get TEXTED) just because triggerType went missing.
      channel:       channelForTriggerType(triggerType),
      incomingMsgId: incomingNoteId || null,
      incomingBody:  String(incomingBody).slice(0, 1600),
      incomingPhone: incomingPhone || null,
      draftText,
      model:        'claude-haiku-4-5-20251001',
      personaPreset, // which persona produced this draft (null = default locked prompt)
      personaName,
      status:       'pending',
      customerName,
      customerPhone: lead.phone || incomingPhone || null,
      generatedAt:  FieldValue.serverTimestamp(),
      generationMs: Date.now() - t0,
      promptTokens:     result.usage?.input_tokens || null,
      completionTokens: result.usage?.output_tokens || null,
    });
    logger.info('[ai-texting] draft created', { leadId, draftId: ref.id, ms: Date.now() - t0 });
    return ref.id;
  } catch (e) {
    logger.warn('[ai-texting] draft write failed', { leadId, err: e.message });
    return null;
  }
}

module.exports = {
  generateAIDraft,
  buildLeadContext,         // exported for unit tests + T-3..T-5 reuse
  resolvePersona,           // T-4: persona lookup (user → company → default)
  callClaudeForDraft,       // T-4: reused by the live-preview callable
  ANTHROPIC_API_KEY,        // re-exported so sms-functions.js can declare the secret dependency
  PERSONA_PROMPT,           // the original locked prompt (default when no persona configured)
};
