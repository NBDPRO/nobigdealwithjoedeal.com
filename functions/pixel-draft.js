'use strict';
/**
 * pixel-draft.js — fileLeadTextDraft: Pixel World's "DRAFT TEXT" (2026-10-11).
 *
 * The game (docs/pro/js/pixel-world.js) never writes Firestore, and
 * agent_inbox is `create: false` for every client (firestore.rules), so a
 * draft has to be filed by the server. This callable files ONE text draft for
 * ONE lead into the caller's company's agent_inbox, the same item shape the
 * bots' draft_text and Storm Mode's fileStormDrafts file, and the owner sends
 * it from the Agent inbox exactly like those: agentDraftAction 'sent'
 * re-checks STOP / Do Not Text / consent / the texting switch / texting hours
 * (8am-9pm in the homeowner's time) before anything is logged as sent.
 *
 *   input   { leadId: string, template: one of TEMPLATE_KEYS }
 *           Nothing else is read. There is no field a client can put words in.
 *   output  { ok: true, status: 'filed' | 'already_filed' | 'not_allowed',
 *             code, message }   -- plain words for the game to show; no phone
 *           number, address or lead name is ever returned.
 *   throws  unauthenticated (signed out), permission-denied (viewer,
 *           access-code member, anonymous), invalid-argument (bad leadId or
 *           an unknown template), resource-exhausted (rate limit),
 *           unavailable (the lead could not be read: fail closed).
 *
 * Who: any signed-in company member except a viewer / member / anonymous.
 * Owner, company_admin, manager (and a platform admin) may draft for any lead
 * of the company; a sales_rep only for a lead they own (the same split
 * firestore.rules makes for lead updates). Only the owner and company_admin
 * can SEE the Agent inbox, so a manager's or rep's draft waits there for them:
 * the message says so.
 *
 * Skipped with status 'not_allowed' (never an error, never a draft):
 *   not_on_board   no such lead, deleted, test data, or another company's
 *                  (one answer for all four: no existence leak across tenants)
 *   not_your_lead  a sales_rep and the lead is a teammate's
 *   cannot_text    no textable phone, declined texting on the form, on the
 *                  STOP register, or on the company's Do Not Text list; the
 *                  register could not be read (fail closed)
 *   text_refused   the wording gate or the company-name check refused it
 *
 * Idempotent: the item id is pxd_<template>_<lead>_<company-local day>, written
 * with create(), so a double click, a second tab or a second device files
 * once; the repeat answers 'already_filed'. Per-uid limit: 60 an hour.
 * Never sends, never writes sms_log. Logs the template key and the outcome
 * only: no lead id, name, phone or address.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
const { assertNotViewer } = require('./shared');
const L = require('./agent-mcp-logic');
const P = require('./pixel-draft-logic');
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];
const DRAFTS_PER_HOUR = 60;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const READ_ONLY_ROLES = new Set(['viewer', 'member']);
const STAFF_ROLES = new Set(['company_admin', 'manager', 'admin']);

const db = () => getFirestore();

const INBOX_NOTE = ' It is in the Agent inbox for the owner or an admin to send. Nothing was texted.';
const MESSAGES = Object.freeze({
  filed: 'Draft filed.' + INBOX_NOTE,
  already_filed: 'That draft was already filed today.' + INBOX_NOTE,
  not_on_board: 'That customer is not on your board.',
  not_your_lead: 'That is a teammate\'s lead. Ask them or an admin to draft it.',
  text_refused: 'That message could not be drafted for this customer.',
});

function callerOf(request) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  const token = request.auth.token || {};
  assertNotViewer(token);
  const role = typeof token.role === 'string' ? token.role.trim().toLowerCase() : '';
  if (READ_ONLY_ROLES.has(role)) throw new HttpsError('permission-denied', 'Your role is view-only, so it cannot draft texts.');
  const uid = request.auth.uid;
  const company = (typeof token.companyId === 'string' && token.companyId) || uid;
  // The owner (company id == own uid) and company_admin / manager may work any
  // company lead; everyone else (sales_rep, an unknown role) only their own.
  const staff = company === uid || STAFF_ROLES.has(role);
  return { uid, company, staff, isNbd: company === NBD_OWNER_UID || uid === NBD_OWNER_UID };
}

async function readDoc(path) {
  try {
    const s = await db().doc(path).get();
    return s.exists ? (s.data() || {}) : null;
  } catch (e) {
    logger.warn('[fileLeadTextDraft] read failed', { path: path.split('/')[0], msg: e && e.message });
    throw new HttpsError('unavailable', 'Could not read that customer just now. Try again in a moment.');
  }
}

const notAllowed = (code, message) => ({ ok: true, status: 'not_allowed', code, message: message || MESSAGES[code] || MESSAGES.text_refused });

async function fileLeadTextDraft(request) {
  const c = callerOf(request);
  const data = request.data || {};
  const leadId = typeof data.leadId === 'string' ? data.leadId : '';
  if (!SAFE_ID_RE.test(leadId)) throw new HttpsError('invalid-argument', 'leadId is required.');
  if (!P.isTemplateKey(data.template)) throw new HttpsError('invalid-argument', 'template must be one of: ' + P.TEMPLATE_KEYS.join(', ') + '.');
  const template = data.template;

  try {
    await enforceRateLimit('callable:fileLeadTextDraft:uid', c.uid, DRAFTS_PER_HOUR, 60 * 60000);
  } catch (e) {
    if (e && e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many drafts this hour. Try again later.');
    throw e;
  }

  const lead = await readDoc('leads/' + leadId);
  if (!lead || lead.deleted === true || lead.e2eTestData || (lead.companyId !== c.company && lead.userId !== c.company)) {
    logger.info('[fileLeadTextDraft] skipped', { template, why: 'not_on_board' });
    return notAllowed('not_on_board');
  }
  if (!c.staff && lead.userId !== c.uid) {
    logger.info('[fileLeadTextDraft] skipped', { template, why: 'not_your_lead' });
    return notAllowed('not_your_lead');
  }

  const profile = await readDoc('companyProfile/' + c.company);
  const names = L.companyNames(profile, c.isNbd);
  const built = P.buildLeadTextDraft(template, lead, names);
  if (built.error) {
    logger.info('[fileLeadTextDraft] skipped', { template, why: built.code });
    return notAllowed('text_refused', built.error);
  }

  // Whose Do Not Text list applies: the caller's company and the lead's own
  // tenant key (sms-optout.js de-duplicates). A read error is a refusal.
  const tenants = [c.company, TextingGate.tenantKeyOfRecord(lead)].filter(Boolean);
  const optOut = await OptOut.isOptedOut(db(), lead.phone, { companyId: tenants, timeoutMs: OptOut.READ_TIMEOUT_MS }).catch(() => null);
  const gate = L.textGate(lead, optOut);
  if (gate.error) {
    logger.info('[fileLeadTextDraft] skipped', { template, why: 'cannot_text' });
    return notAllowed('cannot_text', gate.error);
  }

  const day = L.dayInZone(Date.now(), L.companyTimeZone(profile, c.isNbd, null).tz).replace(/-/g, '');
  const itemId = 'pxd_' + template + '_' + leadId + '_' + day;
  try {
    await db().doc('agent_inbox/' + itemId).create({
      companyId: c.company, bot: 'Pixel World', botId: 'pixel-world', keyId: 'pixel-world',
      status: 'pending', verified: false, createdAt: FieldValue.serverTimestamp(),
      kind: 'draft_text', leadId, title: '', text: built.body, reason: built.reason,
      consentOnFile: gate.consentOnFile, dueDate: null, pixelTemplate: template, filedBy: c.uid,
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) {
      logger.info('[fileLeadTextDraft] already filed', { template });
      return { ok: true, status: 'already_filed', code: 'already_filed', message: MESSAGES.already_filed };
    }
    logger.warn('[fileLeadTextDraft] write failed', { template, msg: e && e.message });
    throw new HttpsError('unavailable', 'Could not file the draft just now. Try again in a moment.');
  }
  logger.info('[fileLeadTextDraft] filed', { template });
  return { ok: true, status: 'filed', code: 'filed', message: MESSAGES.filed };
}

exports.fileLeadTextDraft = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  fileLeadTextDraft
);
exports._internal = { fileLeadTextDraft, callerOf, MESSAGES };
