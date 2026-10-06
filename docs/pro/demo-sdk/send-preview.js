// send-preview.js — "Nothing was sent": the read-only preview of what a send
// would have sent, for the browser-only sample account (Pro demo phase 2,
// wave 2, 2026-10-06).
//
// firebase-functions.js calls previewFor(name, payload) for the callables
// whose real job is to send a homeowner something to sign:
//   sendEstimateEnvelope   the V2/V3 builder's "Send for Signature"
//   createSignRequest      the document viewer's "Send for Signature"
//   createDealAcceptToken  "Send to homeowner" / "Sign on this phone" (deal page)
// It shows who it would go to, the subject and message, and the page the
// homeowner would open — read-only (the document or deal page the CRM itself
// built, in a sandboxed frame with no scripts, so nothing on it can be
// signed, accepted or submitted). The callable still rejects with its honest
// "In your real account this would…" error afterwards, so the CRM's own
// status line says the same thing. Nothing here sends, stores or fetches
// anything beyond the same-origin, in-browser fake store.
import { rawGet, seedMeta, DEMO_UID } from './_store.js';
import { getStorage, ref, getBlob } from './firebase-storage.js';

const SHEET_ID = 'nbd-send-preview';

function companyName() {
  try {
    const b = typeof window._brand === 'function' ? window._brand() : null;
    if (b && b.legalName) return String(b.legalName);
  } catch (_) { /* fall through */ }
  const m = seedMeta();
  return (m && m.company && m.company.name) || 'Sample Roofing Co.';
}
function money(n) {
  const v = Number(n);
  return isFinite(v) ? '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '';
}
function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || 'there'; }

async function htmlAt(path) {
  if (!path) return '';
  try { const b = await getBlob(ref(getStorage(), path)); return b ? await b.text() : ''; } catch (_) { return ''; }
}
// The preview frame runs no scripts (sandbox=""); drop them so the console
// stays quiet about it.
function noScripts(html) { return String(html || '').replace(/<script\b[\s\S]*?<\/script>/gi, ''); }
function leadName(leadId) {
  const l = leadId ? rawGet('leads/' + leadId) : null;
  return l ? (l.name || ((l.firstName || '') + ' ' + (l.lastName || '')).trim()) : '';
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
}
function rows(pairs) {
  const dl = el('dl', 'nbd-sp-rows');
  pairs.filter((p) => p && p[1]).forEach(([k, v]) => { dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', v)); });
  return dl;
}
function section(title, body, note) {
  const s = el('section', 'nbd-sp-sec');
  s.appendChild(el('div', 'nbd-sp-sec-h', title));
  s.appendChild(body);
  if (note) s.appendChild(el('div', 'nbd-sp-note', note));
  return s;
}

export function closeSendPreview() {
  const old = document.getElementById(SHEET_ID);
  if (old) old.remove();
}

// spec: { kind, would, to[], channel, subject, message, pageTitle, pageHtml,
//         pageNote, facts[[k,v]] }
export function showSendPreview(spec) {
  if (typeof document === 'undefined' || !document.body) return null;
  closeSendPreview();
  const back = el('div', 'nbd-sp-back');
  back.id = SHEET_ID;
  back.setAttribute('data-kind', spec.kind || '');
  const box = el('div', 'nbd-sp');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', SHEET_ID + '-h');
  box.appendChild(el('span', 'nbd-sp-kicker', 'Sample account'));
  const h = el('h2', '', 'Nothing was sent');
  h.id = SHEET_ID + '-h';
  box.appendChild(h);
  box.appendChild(el('p', 'nbd-sp-lede', 'In your real account this would ' + spec.would + '. Here is exactly what would go out. The sample account never contacts anyone.'));

  box.appendChild(section(spec.channel || 'Email', rows([
    ['To', (spec.to || []).filter(Boolean).join(', ') || 'The homeowner on this job'],
    ['From', companyName() + ' (through NBD Pro)'],
    ['Subject', spec.subject || '']
  ])));
  if (spec.message) box.appendChild(section('Message', el('p', 'nbd-sp-msg', spec.message)));
  if (spec.facts && spec.facts.length) box.appendChild(section('What they are signing', rows(spec.facts)));
  if (spec.pageHtml) {
    const f = document.createElement('iframe');
    f.className = 'nbd-sp-frame';
    // No allow-scripts, no allow-same-origin, no allow-forms: a picture of
    // the page, nothing on it can be signed, accepted or submitted.
    f.setAttribute('sandbox', '');
    f.setAttribute('title', spec.pageTitle || 'The page the homeowner would open (preview)');
    f.srcdoc = noScripts(spec.pageHtml);
    box.appendChild(section(spec.pageTitle || 'The page they would open (read-only preview)', f, spec.pageNote ||
      'Read-only preview. In your real account the homeowner opens this on their own phone from a one-time link, signs, and you get a notification.'));
  } else if (spec.pageNote) {
    box.appendChild(section(spec.pageTitle || 'The page they would open', el('p', 'nbd-sp-msg', spec.pageNote)));
  }

  const foot = el('div', 'nbd-sp-foot');
  const ok = el('button', 'nbd-sp-btn', 'Got it');
  ok.type = 'button';
  ok.setAttribute('data-nbd-sp', 'close');
  foot.appendChild(ok);
  box.appendChild(foot);
  back.appendChild(box);
  back.addEventListener('click', (e) => {
    if (e.target === back || (e.target.closest && e.target.closest('[data-nbd-sp="close"]'))) closeSendPreview();
  });
  back.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSendPreview(); });
  document.body.appendChild(back);
  try { ok.focus({ preventScroll: true }); } catch (_) { /* old browser */ }
  return back;
}

function estimateFacts(est) {
  if (!est) return [];
  const plan = est.depositPlan || null;
  const tierKey = est.tier || est.selectedTier || '';
  let pkg = est.package || '';
  try {
    const cfg = window.NBD_ESTIMATE_CONFIG;
    if (tierKey && cfg && typeof cfg.tierLabel === 'function') pkg = cfg.tierLabel(tierKey) || pkg;
  } catch (_) { /* keep the saved name */ }
  return [
    ['Job', est.address || est.owner || ''],
    ['Package', pkg],
    ['Total', money(est.grandTotal != null ? est.grandTotal : est.total)],
    [plan && plan.label ? plan.label : 'Due at signing', plan ? (plan.valueText || money(plan.depositCents / 100)) : ''],
    ['Payment terms', plan ? (plan.summary || plan.terms || '') : '']
  ];
}

const BUILDERS = {
  async sendEstimateEnvelope(p) {
    const est = p && p.estimateId ? rawGet('estimates/' + p.estimateId) : null;
    const signers = (p && Array.isArray(p.signers)) ? p.signers : [];
    const to = signers.map((s) => (s.name || '') + (s.email ? ' <' + s.email + '>' : ''));
    const co = companyName();
    return {
      kind: 'esign-envelope',
      would: p && p.sendEmail === false ? 'open the signing page on this phone' : 'email the contract for e-signature',
      channel: p && p.sendEmail === false ? 'Signing in person' : 'Email',
      to,
      subject: 'Please review and sign: your roofing contract from ' + co,
      message: 'Hi ' + firstName(signers[0] && signers[0].name) + ',\n\n' + co + ' sent your roofing contract to review and sign on your phone. ' +
        'Open the secure link, read each page, then sign where it asks. It takes about two minutes.\n\n[Review and sign]  (a one-time link)\n\n' +
        'When everyone has signed, a copy of the signed contract is emailed to you.',
      facts: estimateFacts(est),
      pageTitle: 'The signing page',
      pageNote: 'In your real account NBD Pro builds the contract PDF from this saved estimate on its servers, places a signature box for each signer and emails the one-time link. The homeowner signs on their own phone; the signed PDF files itself on the customer.'
    };
  },
  async createSignRequest(p) {
    const leadId = p && p.leadId;
    const meta = (leadId && p.docId) ? rawGet('leads/' + leadId + '/documents/' + p.docId) : null;
    let html = await htmlAt(meta && meta.htmlPath);
    if (!html) {
      const v = document.getElementById('nbdv-iframe');
      html = (v && v.srcdoc) || '';
    }
    const co = companyName();
    const docName = (meta && meta.typeName) || 'document';
    const who = (p && p.signerName) || leadName(leadId);
    return {
      kind: 'sign-request',
      would: 'email a signing link for this ' + docName.toLowerCase(),
      channel: 'Email',
      to: [who + (p && p.signerEmail ? ' <' + p.signerEmail + '>' : '')],
      subject: 'Please sign: ' + docName + ' from ' + co,
      message: 'Hi ' + firstName(who) + ',\n\n' + co + ' sent you a ' + docName.toLowerCase() + ' to review and sign. ' +
        'Tap the link to open it on your phone and sign where it asks.\n\n[Review and sign]  (a one-time link)',
      pageTitle: 'The page they would open (read-only preview)',
      pageHtml: html
    };
  },
  async createDealAcceptToken(p) {
    const dealId = p && p.dealId;
    let deal = null;
    try { deal = (window.CloseBoard && typeof window.CloseBoard.getDeals === 'function' ? window.CloseBoard.getDeals() : []).find((d) => d && d.id === dealId) || null; } catch (_) { deal = null; }
    const html = await htmlAt(dealId ? 'deal_rooms/' + DEMO_UID + '/' + dealId + '.html' : '');
    const name = (deal && (deal.customerName || deal.name)) || leadName(deal && deal.leadId);
    const phone = (deal && (deal.customerPhone || deal.phone)) || '';
    const email = (deal && (deal.customerEmail || deal.email)) || '';
    const co = companyName();
    return {
      kind: 'deal-link',
      would: 'create the one-time link to this deal page, ready for you to text or email it from your phone',
      channel: 'Text message (sent from your phone)',
      to: [name + (phone ? ' · ' + phone : '') + (email ? ' · ' + email : '')],
      subject: 'Your roof estimate from ' + co,
      message: 'Hi ' + firstName(name) + '! Here\'s your roof estimate from ' + co + '. Compare the options and sign here: [one-time link]',
      pageTitle: 'The deal page they would open (read-only preview)',
      pageHtml: html
    };
  }
};

export function hasPreview(name) { return Object.prototype.hasOwnProperty.call(BUILDERS, name); }

export async function previewFor(name, payload) {
  if (!hasPreview(name)) return null;
  let spec = null;
  try { spec = await BUILDERS[name](payload || {}); } catch (e) { console.warn('[sample account] preview failed:', e); return null; }
  const node = showSendPreview(spec);
  try {
    const st = window.__NBD_DEMO__;
    if (st) {
      st.previews = st.previews || [];
      st.previews.push({ callable: name, kind: spec.kind, to: spec.to, subject: spec.subject, hasPage: !!spec.pageHtml, at: Date.now() });
    }
  } catch (_) { /* no demo state */ }
  return node;
}
