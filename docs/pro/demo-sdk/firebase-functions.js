// Fake firebase-functions.js for the browser-only sample account (Pro demo
// phase 2). httpsCallable never reaches Cloud Functions. A short list of
// callables gets a canned, honest answer; every other name rejects with a
// clear "not in the sample account" error (and a visible notice) instead of
// hanging, so a screen that needs a server says so.
import { ready, demoNotice, rawGet } from './_store.js';
import { previewFor } from './send-preview.js';
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
  }
};

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
  recordInPersonSignature: 'record the in-person signature on NBD Pro servers'
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
