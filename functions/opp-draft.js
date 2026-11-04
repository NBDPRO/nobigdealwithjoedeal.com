'use strict';
/**
 * opp-draft.js — oppDraftFile: file ONE first-message draft for ONE shortlisted
 * Thumbtack Opportunity (2026-11-04, flag thumbtackOpportunities, ships dark).
 *
 * It builds the text from a FIXED template (opp-draft-templates.js, three
 * wordings per trade) plus three facts, and files it as `opp_drafts` with status
 * `pending`. It sends nothing, contacts nobody, reads nothing from Thumbtack and
 * has no approve or send path: a draft only waits. Approving it is a later PR and
 * a tap by Jo.
 *
 *   input   { oppId, templateKey?, problemPhrase? }
 *           oppId        the id of an opp_seen record already filed by oppShortlistFile
 *           templateKey  optional; one of that trade's three keys, else the server picks one
 *           problemPhrase optional; the customer's own problem words. They are DATA: sanitized to a
 *                        short lower-case quote (no links, digits, phone shapes, instructions or
 *                        insurance talk, 120 characters) or dropped for our own fallback phrase.
 *           Nothing else is read. There is no field in which anyone can put words of their own.
 *   output  { ok:true, status:'filed'|'already_filed'|'not_allowed', code, message, templateKey?, draftText?, usedQuote? }
 *   throws  unauthenticated, permission-denied (not the owner), invalid-argument (bad oppId or key),
 *           resource-exhausted (rate limit), unavailable (a read failed: fail closed).
 *
 * Who: OWNER ONLY (opp-access.js). App Check enforced. Flag off / killSwitch: not_allowed, nothing filed.
 *
 * Only a SHOW record that carries no instruction flag gets a draft. The phone-shaped-text
 * refuser, the link refuser, the Kentucky wording gate and the banned-claims list run on the
 * FINISHED text (opp-draft-logic.js draftProblem) before anything is written: a refusal files nothing.
 *
 * Idempotent and create-only: opp_drafts/{companyId}_{oppId} is written with create(), so a second
 * tap, a second tab or a retry files nothing new and never overwrites the first draft ('already_filed').
 * Logs the template key and outcome only: no text, no id.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { enforceRateLimit } = require('./integrations/upstash-ratelimit');
const Access = require('./opp-access');
const AL = require('./agent-mcp-logic');
const OL = require('./opp-shortlist-logic');
const TPL = require('./opp-draft-templates');
const D = require('./opp-draft-logic');

const CORS_ORIGINS = ['https://nobigdealwithjoedeal.com', 'https://www.nobigdealwithjoedeal.com', 'https://nobigdeal-pro.web.app'];
const DRAFTS_PER_HOUR = 60;
const RETAIN_MS = 90 * 24 * 3600000;
const db = () => getFirestore();

const MESSAGES = Object.freeze({
  filed: 'Draft filed. It is waiting for your approval. Nothing was sent.',
  already_filed: 'A draft for that opportunity was already filed. Nothing new was written and nothing was sent.',
  feature_off: Access.MESSAGES.feature_off,
  kill_switch: Access.MESSAGES.kill_switch,
  not_found: 'That opportunity was not filed yet, so there is nothing to draft for.',
  not_shortlisted: 'Only an opportunity the shortlist marked SHOW can be drafted.',
  text_refused: 'That message could not be drafted.',
});

const notAllowed = (code, message) => ({ ok: true, status: 'not_allowed', code, message: message || MESSAGES[code] || MESSAGES.text_refused });

async function oppDraftFile(request) {
  const c = Access.ownerOf(request);
  const data = request.data || {};
  const oppId = OL.safeOppId(data.oppId);
  if (!oppId) throw new HttpsError('invalid-argument', 'oppId is required.');
  let templateKey = null;
  if (data.templateKey !== undefined && data.templateKey !== null) {
    if (!TPL.isTemplateKey(data.templateKey)) throw new HttpsError('invalid-argument', 'templateKey must be one of: ' + TPL.TEMPLATE_KEYS.join(', ') + '.');
    templateKey = data.templateKey;
  }
  const phrase = typeof data.problemPhrase === 'string' ? data.problemPhrase.slice(0, 2000) : null;

  const g = await Access.gate(db(), c);
  if (!g.ok) {
    logger.info('[oppDraftFile] skipped', { why: g.code });
    return notAllowed(g.code, g.message);
  }
  try {
    await enforceRateLimit('callable:oppDraftFile:uid', c.uid, DRAFTS_PER_HOUR, 60 * 60000);
  } catch (e) {
    if (e && e.rateLimited) throw new HttpsError('resource-exhausted', 'Too many drafts this hour. Try again later.');
    throw e;
  }

  const docId = OL.docIdFor(c.company, oppId);
  if (!docId) throw new HttpsError('invalid-argument', 'oppId is required.');
  const seen = await Access.readDocOrThrow(db(), 'opp_seen/' + docId);
  if (!seen || seen.companyId !== c.company) { logger.info('[oppDraftFile] skipped', { why: 'not_found' }); return notAllowed('not_found'); }
  if (seen.decision !== 'SHOW' || (Array.isArray(seen.flags) && seen.flags.indexOf('instruction_text') !== -1)) {
    logger.info('[oppDraftFile] skipped', { why: 'not_shortlisted' });
    return notAllowed('not_shortlisted');
  }
  if (templateKey && TPL.TEMPLATES[templateKey].trade !== seen.tradeKey) {
    throw new HttpsError('invalid-argument', 'templateKey is for a different kind of job than this opportunity.');
  }

  const profile = await Access.readDocOrThrow(db(), 'companyProfile/' + c.company);
  const names = AL.companyNames(profile, true);
  const built = D.buildOppDraft({
    templateKey, tradeKey: seen.tradeKey, oppId, phrase, summary: seen.summary, city: seen.city,
    hasPhotos: typeof seen.photos === 'number' && seen.photos > 0, company: names[0],
  });
  if (!built.ok) {
    logger.info('[oppDraftFile] skipped', { why: built.code });
    return notAllowed('text_refused', built.error);
  }

  try {
    await db().doc('opp_drafts/' + docId).create({
      companyId: c.company, createdBy: c.uid, oppId, tradeKey: seen.tradeKey,
      templateKey: built.templateKey, draftText: built.text, usedQuote: built.usedQuote,
      status: 'pending', createdAt: FieldValue.serverTimestamp(), expireAt: new Date(Date.now() + RETAIN_MS),
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) {
      logger.info('[oppDraftFile] already filed', { template: built.templateKey });
      return { ok: true, status: 'already_filed', code: 'already_filed', message: MESSAGES.already_filed };
    }
    logger.warn('[oppDraftFile] write failed', { template: built.templateKey, msg: e && e.message });
    throw new HttpsError('unavailable', 'Could not file the draft just now. Try again in a moment.');
  }
  logger.info('[oppDraftFile] filed', { template: built.templateKey });
  return { ok: true, status: 'filed', code: 'filed', message: MESSAGES.filed, templateKey: built.templateKey, draftText: built.text, usedQuote: built.usedQuote };
}

exports.oppDraftFile = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 20, memory: '256MiB' },
  require('./tenant-guard').wrapCallable(oppDraftFile)
);
exports._internal = { oppDraftFile, MESSAGES };
