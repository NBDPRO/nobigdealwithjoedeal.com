// Fake firebase-functions.js for the browser-only sample account (Pro demo
// phase 2). httpsCallable never reaches Cloud Functions. A short list of
// callables gets a canned, honest answer; every other name rejects with a
// clear "not in the sample account" error (and a visible notice) instead of
// hanging, so a screen that needs a server says so.
import { ready, demoNotice, rawGet, rawSet, rawUpdate, autoId, seedMeta, reviveSeed, Timestamp, DEMO_UID } from './_store.js';
import { previewFor, showSendPreview } from './send-preview.js';
import { getStorage, ref, getBlob } from './firebase-storage.js';

const FUNCTIONS = { __nbdDemo: true, region: 'us-central1', app: null };

// Canned answers. Each returns { data } like the real SDK. Nothing here sends,
// charges, texts or emails anyone.
const CANNED = {
  // Usage counters only feed plan limits; the sample account has none.
  trackUsage: () => ({ ok: true, sample: true }),
  // Owner-claim healing is a real-account login step.
  mintOwnerClaims: () => ({ ok: true, changed: false, sample: true }),
  backfillAnalytics: () => ({ ok: true, sample: true }),
  // Boot-time checks the dashboard makes on every load. The sample owner has
  // no pending team invite and no third-party integrations connected.
  claimInvite: () => ({ claimed: false, reason: 'no_invite', sample: true }),
  integrationAvailability: () => ({ configured: {}, sample: true }),
  getGameCard: () => ({ ok: false, sample: true, reason: 'Leaderboards fill in from a real team.' }),
  // Wave 2: reopening a generated document from the customer's Documents
  // list. The real callable reads the saved HTML out of Storage after an
  // ownership check; here the CRM's own upload is still in this tab's fake
  // Storage (memory only, like every sample upload).
  getDocumentHtml: async (p) => {
    const meta = (p && p.leadId && p.docId) ? rawGet('leads/' + p.leadId + '/documents/' + p.docId) : null;
    let html = '';
    if (meta && meta.htmlPath) {
      try { html = await (await getBlob(ref(getStorage(), meta.htmlPath))).text(); } catch (_) { html = ''; }
    }
    if (!html) {
      const e = new Error('The sample account keeps generated documents in this tab only. Generate it again to see it.');
      e.code = 'functions/not-found';
      throw e;
    }
    return { html, typeName: meta.typeName || 'Document', filename: meta.filename || 'document.pdf', sample: true };
  },
  // Wave 3: the Agent inbox's drafts. 'check' is the recipient check the real
  // server makes when the inbox opens (Do-Not-Text / unsubscribe lists); here
  // the sample customers are all reachable. 'sent' is the owner's one tap:
  // in a real account the text has already opened in their own Messages app
  // and the server only logs it. Here nothing opens and nothing is sent: the
  // "Nothing was sent" sheet shows exactly what would have gone out, and the
  // item is filed with a note on the customer's card that says so.
  agentDraftAction: (p) => agentDraftAction(p || {}),
  // Wave 3, door-knocking map: the server's Google / county-parcel address
  // check. The sample map's own addresses answer instead (offline.js), so
  // this adds nothing and never fails.
  resolveAddress: () => ({ sample: true }),
  // Wave 3: the hail lookup behind the map's Hail and Storm-zone buttons:
  // the seed's sample hail reports (the story's storm), with its swath.
  getHailHistory: (p) => hailHistory(p || {})
};

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function hailHistory(p) {
  const o = (seedMeta() && seedMeta().offline) || {};
  const lat = Number(p.lat), lng = Number(p.lng), r = Number(p.radiusMi) || 3;
  const swath = Array.isArray(o.swath) ? o.swath.map((q) => [q[1], q[0]]) : null; // GeoJSON [lng, lat]
  const hits = reviveSeed(o.hail || []).filter((h) => !isFinite(lat) || !isFinite(lng) || haversineMi(lat, lng, h.lat, h.lng) <= r);
  // The swath travels on the first hit, the way a provider swath does.
  if (hits.length && swath) hits[0] = Object.assign({}, hits[0], { polygon: { type: 'Polygon', coordinates: [swath] } });
  return { hits, sample: true, source: 'Sample storm reports (not real NWS data)' };
}

function nameOf(l) { return l ? (l.name || ((l.firstName || '') + ' ' + (l.lastName || '')).trim()) : ''; }
function agentDraftAction(p) {
  const action = String(p.action || '');
  if (action === 'check') {
    const results = {};
    (Array.isArray(p.ids) ? p.ids : []).forEach((id) => {
      const it = rawGet('agent_inbox/' + id);
      const l = it && it.leadId ? rawGet('leads/' + it.leadId) : null;
      if (!it || !l) { results[id] = { ok: false, reason: 'No customer on this draft.' }; return; }
      const to = it.kind === 'draft_email' ? (l.email || '') : (l.phoneDigits ? '+1' + l.phoneDigits : '');
      results[id] = to ? { ok: true, to, name: nameOf(l), consentOnFile: !!it.consentOnFile, sample: true }
        : { ok: false, reason: 'No ' + (it.kind === 'draft_email' ? 'email' : 'phone') + ' on this sample customer.', name: nameOf(l) };
    });
    return { results, sample: true };
  }
  if (action === 'sent') {
    const it = p.id ? rawGet('agent_inbox/' + p.id) : null;
    if (!it || it.status !== 'pending') return { ok: true, already: true, sample: true };
    const l = it.leadId ? rawGet('leads/' + it.leadId) : null;
    const isEmail = it.kind === 'draft_email';
    const body = String(p.body != null ? p.body : it.text || '').slice(0, 2000);
    const subject = String(p.subject != null ? p.subject : it.title || '').slice(0, 200);
    const who = nameOf(l) || 'the customer';
    showSendPreview({
      kind: isEmail ? 'agent-email' : 'agent-text',
      would: isEmail ? 'open this email in your own Mail app for you to send, then log it on ' + who + '’s card'
        : 'open this text in your own Messages app for you to send from your phone, then log it on ' + who + '’s card',
      channel: isEmail ? 'Email (from your own Mail app)' : 'Text message (from your own phone)',
      to: [who + (l ? (isEmail ? (l.email ? ' <' + l.email + '>' : '') : (l.phone ? ' · ' + l.phone : '')) : '')],
      subject: isEmail ? subject : '',
      from: isEmail ? 'Your own email (' + ((seedMeta().user || {}).displayName || 'the owner') + ')' : 'Your own phone (' + ((seedMeta().user || {}).displayName || 'the owner') + ')',
      pageTitle: 'Who wrote it',
      message: body,
      pageNote: 'Drafted by ' + (it.bot || 'a bot') + '. Bots never contact a customer: a draft waits here until you send it yourself.'
    });
    const now = Timestamp.now();
    rawUpdate('agent_inbox/' + p.id, { status: 'approved', decidedAt: now, decidedBy: DEMO_UID, result: 'sample:not-sent', text: body });
    if (it.leadId) {
      rawSet('notes/' + autoId(), {
        leadId: it.leadId, userId: DEMO_UID, companyId: DEMO_UID, type: 'note', source: 'agent_inbox', agentItemId: p.id, isSample: true,
        text: 'Approved ' + (it.bot || 'the bot') + '’s ' + (isEmail ? 'email' : 'text') + ' draft in the sample account. Nothing was sent.\n\n' + body,
        createdBy: 'Agent inbox', createdAt: now
      });
    }
    try {
      const st = window.__NBD_DEMO__;
      if (st) { st.previews = st.previews || []; st.previews.push({ callable: 'agentDraftAction', kind: isEmail ? 'agent-email' : 'agent-text', to: [who], at: Date.now() }); }
    } catch (_) { /* no demo state */ }
    return { ok: true, sample: true, sent: false };
  }
  const e = new Error('That draft action is not in the sample account.');
  e.code = 'functions/invalid-argument';
  throw e;
}

// Callables whose real job is to contact someone, publish something or move
// money: answered with an explanation, never a fake success.
const WOULD = {
  sendEstimateEnvelope: 'email the estimate to the homeowner',
  sendEsignEnvelope: 'send the contract for e-signature',
  createEsignEnvelope: 'create an e-signature envelope',
  createSignRequest: 'send a signing request',
  createTeamInvite: 'email a team invite',
  createPortalToken: 'create a customer portal link',
  createReportShareToken: 'create a shareable report link',
  createDealAcceptToken: 'create a deal acceptance link',
  replyToPortalMessage: 'reply to the homeowner in their portal',
  requestMeasurement: 'order a roof measurement report',
  analyzePhotoVision: 'run AI photo analysis',
  dictate: 'transcribe a voice note',
  transcribeVoiceMemo: 'transcribe a voice memo',
  extractReceiptData: 'read a receipt with AI',
  renderPdf: 'render the PDF on the server',
  getDocumentPdfUrl: 'render the PDF on the server',
  exportMyData: 'export your company data',
  requestAccountErasure: 'erase an account',
  createCompany: 'create a company',
  claimInvite: 'join a company',
  publishTenantSite: 'publish your website',
  setSiteSlug: 'reserve your website address',
  previewAiPersona: 'preview the AI texting persona',
  recordInPersonSignature: 'record the in-person signature on NBD Pro servers',
  // Wave 3: on a real address only.
  attachStormProof: 'look up verified hail reports near this address and attach a server-stamped storm proof to the customer',
  reverifyCompanyKnocks: 're-check every door address against Google and county parcel records',
  lookupParcel: 'look up the county parcel record for this door'
};

export function sampleCallableMessage(name) {
  const doing = WOULD[name];
  return doing
    ? 'In your real account this would ' + doing + '. The sample account never contacts anyone.'
    : '"' + name + '" runs on NBD Pro servers, so it is not in the sample account.';
}

function callableError(name) {
  const e = new Error(sampleCallableMessage(name));
  e.code = 'functions/failed-precondition';
  e.name = 'FirebaseError';
  e.details = { sampleAccount: true, callable: name };
  return e;
}

export function getFunctions(app, region) { if (app) FUNCTIONS.app = app; if (region) FUNCTIONS.region = region; return FUNCTIONS; }
export function connectFunctionsEmulator() {}

export function httpsCallable(_functions, name) {
  const fn = async (payload) => {
    await ready();
    if (Object.prototype.hasOwnProperty.call(CANNED, name)) return { data: await CANNED[name](payload) };
    // Wave 2: a send-to-sign callable shows exactly what it would have sent
    // (read-only) before it says no. send-preview.js.
    const shown = await previewFor(name, payload);
    const e = callableError(name);
    // The preview already says it; a second toast on top of it is noise.
    if (!shown) demoNotice(e.message, { kind: 'callable', callable: name });
    throw e;
  };
  fn.stream = async () => { throw callableError(name); };
  return fn;
}
export function httpsCallableFromURL(_functions, url) {
  return httpsCallable(_functions, String(url).split('/').pop() || 'callable');
}
export const __nbdDemo = true;
