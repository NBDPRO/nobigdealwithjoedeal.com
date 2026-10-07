// endpoints.js — the sample account's answers to the CRM's few DIRECT Cloud
// Function calls (Pro demo phase 2, wave 4, 2026-10-07).
//
// Most of the CRM reaches the server through httpsCallable (the fake in
// firebase-functions.js answers those). Three money / messaging paths POST
// straight to https://us-central1-nobigdeal-pro.cloudfunctions.net/<name>
// with fetch instead:
//   createStripePaymentLink  invoice-pipeline.js: the homeowner's "Pay online" link
//   sendEmail / sendSMS      nbd-comms.js: an invoice, a receipt, a stage email
// docs/pro/js/demo-mode.js recognises exactly those POSTs in its fetch
// wrapper and hands them here BEFORE they could leave the browser (the
// request is never made). Every other function URL is still blocked by the
// tripwire, and the demo route's CSP (connect-src 'self') refuses it anyway.
//
// createStripePaymentLink mirrors the real server's checks that matter here:
// nothing owed → refused; a Kentucky insurance job inside the hold (the REAL
// ky-insurance-law.js payLinkHold, KRS 367.626) → refused with the same
// KY_CANCELLATION_WINDOW error, so the CRM shows its own Kentucky message.
// Otherwise the "link" is a page in the sample account that says it is a
// sample: /pro/explore/sample-pay. No Stripe, no charge.
//
// sendEmail / sendSMS show the "Nothing was sent" sheet (send-preview.js)
// with exactly what would have gone out, then answer with a refusal (403),
// which nbd-comms.js treats as "not sent" and never turns into a mailto: /
// sms: handoff. The CRM's own status says it was not sent.
import { ready, rawGet, seedMeta, demoNotice } from './_store.js';
import { showSendPreview } from './send-preview.js';

const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'X-NBD-Demo': 'sample-endpoint' };
const json = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: HEADERS });

function record(kind, detail) {
  try {
    const st = window.__NBD_DEMO__;
    if (!st) return;
    st.endpointAnswers = st.endpointAnswers || [];
    st.endpointAnswers.push(Object.assign({ fn: kind, at: Date.now() }, detail || {}));
  } catch (_) { /* no demo state */ }
}
function company() {
  try {
    const b = typeof window._brand === 'function' ? window._brand() : null;
    if (b && (b.displayName || b.legalName)) return String(b.displayName || b.legalName);
  } catch (_) { /* fall through */ }
  return (seedMeta().company && seedMeta().company.name) || 'Sample Roofing Co.';
}
function leadOf(id) {
  const l = id ? rawGet('leads/' + id) : null;
  return l ? Object.assign({ id }, l) : null;
}
function nameOf(l) { return l ? (l.name || ((l.firstName || '') + ' ' + (l.lastName || '')).trim()) : ''; }
function money(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function plain(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// The page a sample pay link opens (docs/pro/explore/sample-pay.html).
export function samplePayUrl(invoiceId, amount) {
  const q = 'invoice=' + encodeURIComponent(String(invoiceId || '').replace(/[^\w-]/g, '').slice(0, 40)) +
    '&amount=' + (Math.max(0, Number(amount) || 0)).toFixed(2);
  return location.origin + '/pro/explore/sample-pay?' + q;
}

let linkN = 0;
async function createStripePaymentLink(body) {
  const invoiceId = String((body && body.invoiceId) || '');
  const inv = invoiceId ? rawGet('invoices/' + invoiceId) : null;
  if (!inv) return json({ error: 'Invoice not found' }, 404);
  const due = Number(inv.balanceDue != null ? inv.balanceDue : inv.total) || 0;
  if (String(inv.status) === 'paid' || !(due > 0)) return json({ error: 'Nothing is owed on this invoice, so there is no pay link to make.' }, 400);
  // The Kentucky insurance hold, exactly as the real server applies it.
  const J = window.NBDJurisdiction;
  const lead = inv.leadId ? leadOf(inv.leadId) : null;
  if (inv.leadId && !lead) return json({ error: 'Invoice customer not found' }, 404);
  if (!J || typeof J.payLinkHold !== 'function') return json({ error: 'KY_CANCELLATION_WINDOW: the Kentucky rules could not be checked, so no link was made.' }, 409);
  const hold = J.payLinkHold(lead, inv, new Date());
  if (hold.held) {
    record('createStripePaymentLink', { invoiceId, held: true });
    return json({ error: 'KY_CANCELLATION_WINDOW: ' + ((J.MSG && J.MSG.payLinkHeld) || 'Online payment link withheld until the Kentucky cancellation window has run.') }, 409);
  }
  const url = samplePayUrl(invoiceId, due);
  const paymentLinkId = 'plink_sample_' + invoiceId + '_' + (++linkN);
  record('createStripePaymentLink', { invoiceId, url, amount: due });
  demoNotice('Sample pay link made. In your real account this is a Stripe link your homeowner pays by card; here it opens a page that says it is a sample, and nothing is charged.', { kind: 'pay-link', invoiceId });
  return json({ url, paymentLinkId, amount: due, sample: true });
}

function refusal(kind, what) {
  const msg = 'Sample account: nothing was sent. In your real account this would ' + what + '.';
  record(kind, { refused: true });
  return json({ error: msg, code: 'sample_account' }, 403);
}

async function sendEmail(body) {
  const b = body || {};
  const inv = b.invoiceId ? rawGet('invoices/' + b.invoiceId) : null;
  const l = leadOf(b.leadId || (inv && inv.leadId));
  const to = String(b.to || '');
  const who = nameOf(l) || to || 'the customer';
  showSendPreview({
    kind: 'email',
    would: 'email this to ' + who + ' from NBD Pro on your company’s behalf',
    channel: 'Email',
    to: [(nameOf(l) ? nameOf(l) + ' ' : '') + (to ? '<' + to + '>' : '')],
    subject: String(b.subject || ''),
    from: company() + ' (through NBD Pro)',
    message: b.html ? '' : plain(b.body),
    pageTitle: b.html ? 'The email (read-only preview)' : '',
    pageHtml: b.html ? String(b.html) : '',
    pageNote: b.html ? 'Read-only preview of the email body. In your real account it is sent from NBD Pro with your company name, and a copy is logged on the customer.' : ''
  });
  return refusal('sendEmail', 'email ' + who);
}

async function sendSMS(body) {
  const b = body || {};
  const l = leadOf(b.leadId);
  const to = String(b.to || '');
  const who = nameOf(l) || to || 'the customer';
  showSendPreview({
    kind: 'text',
    would: 'text this to ' + who + ' from your business line',
    channel: 'Text message',
    to: [(nameOf(l) ? nameOf(l) + ' · ' : '') + to],
    from: company() + ' business line (through NBD Pro)',
    message: String(b.body || ''),
    pageTitle: 'How texts go out in a real account',
    pageNote: 'Texts go out from your own business number, only to customers who can be texted, and every one is logged on the customer.'
  });
  return refusal('sendSMS', 'text ' + who);
}

// navigator.share in the sample account (demo-mode.js): the job sheet "Send
// to sub" and other share-sheet sends show what would have been shared.
export function previewShare(data) {
  const d = data || {};
  record('share', {});
  showSendPreview({
    kind: 'share',
    would: 'open your phone’s share sheet with this message, for you to send from your own Messages or Mail',
    channel: 'Share sheet (your own phone)',
    to: ['Whoever you pick on your phone'],
    from: 'Your own phone',
    subject: String(d.title || ''),
    message: String(d.text || d.url || '')
  });
}

const FNS = { createStripePaymentLink, sendEmail, sendSMS };

/** Names demo-mode.js may hand here (POST only). */
export const NAMES = Object.keys(FNS);

/** Answer one recognised function POST from the sample account. */
export async function answerFunction(name, bodyText) {
  await ready();
  let body = {};
  try { body = bodyText ? JSON.parse(String(bodyText)) : {}; } catch (_) { body = {}; }
  const fn = Object.prototype.hasOwnProperty.call(FNS, name) ? FNS[name] : null;
  if (!fn) return json({ error: '"' + name + '" runs on NBD Pro servers, so it is not in the sample account.' }, 404);
  return fn(body);
}

const api = { answerFunction, NAMES, samplePayUrl, previewShare };
if (typeof window !== 'undefined' && window.__NBD_DEMO__ && typeof window.__NBD_DEMO__.endpointsLoaded === 'function') {
  window.__NBD_DEMO__.endpointsLoaded(api);
}
export default api;
