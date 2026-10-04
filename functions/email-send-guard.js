/**
 * email-send-guard.js — who sendEmail may write to, and what HTML it may send
 * (security batch 2026-10-03). Dependency-free so tests can require() it.
 *
 * WHY: sendEmail took `to`, raw `html` and `replyTo` straight from the caller.
 * Sign-up is open, so any verified account could send arbitrary HTML from the
 * company's noreply@ address to anyone — a phishing relay on a trusted domain.
 * Now:
 *   1. RECIPIENT BINDING — the call must name a record the caller can open
 *      (a lead, and/or an invoice in their tenant), and `to` must be an email
 *      ON that record. Every CRM call site already passes the leadId (and the
 *      invoice paths their invoiceId).
 *   2. HTML SANITIZING — script-capable and form elements, event-handler
 *      attributes and javascript:/data: URLs are stripped. Links and inline
 *      styles stay (invoices carry a pay link and a <style> block).
 *   3. replyTo — honoured only when it is the caller's own (verified) email.
 */
'use strict';

function normEmail(e) {
  return String(e == null ? '' : e).trim().toLowerCase();
}

// Lead read access, mirroring firestore.rules /leads read: the owner, a
// platform admin, or a company reader (company_admin / manager — a viewer is
// refused earlier by sendEmail) of the lead's own tenant. A sales_rep reads
// only their own leads, here as in the rules.
function callerCanAccessLead(decoded, lead) {
  if (!decoded || !lead) return false;
  if (lead.userId && lead.userId === decoded.uid) return true;
  if (decoded.role === 'admin') return true;
  const role = decoded.role || '';
  return (role === 'company_admin' || role === 'manager')
    && !!decoded.companyId && !!lead.companyId && lead.companyId === decoded.companyId;
}

// Invoice access = tenancy (functions/stripe.js D5): any member of the
// invoice's tenant; legacy invoices without companyId fall back to creator.
function callerCanAccessInvoice(decoded, invoice) {
  if (!decoded || !invoice) return false;
  if (decoded.role === 'admin') return true;
  const tenantId = decoded.companyId || decoded.uid;
  return invoice.companyId
    ? invoice.companyId === tenantId
    : (!!invoice.createdBy && invoice.createdBy === decoded.uid) || (!!invoice.userId && invoice.userId === decoded.uid);
}

// The email addresses a record carries. Leads: `email` (homeownerEmail /
// customerEmail are aliases some writers use). Invoices: customerEmail.
function recordEmails(lead, invoice) {
  const out = new Set();
  for (const r of [lead, invoice]) {
    if (!r) continue;
    for (const k of ['email', 'customerEmail', 'homeownerEmail']) {
      const v = normEmail(r[k]);
      if (v) out.add(v);
    }
  }
  return out;
}

function recipientOnRecord(to, lead, invoice) {
  const t = normEmail(to);
  return !!t && recordEmails(lead, invoice).has(t);
}

// Elements removed WITH their content (they run code or embed other docs).
const DROP_WITH_CONTENT = ['script', 'iframe', 'object', 'embed', 'applet', 'frame', 'frameset',
  'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'button'];
// Tags removed, content kept (form chrome; document-level metadata).
const DROP_TAG_ONLY = ['form', 'input', 'option', 'base', 'link', 'isindex', 'keygen'];

function sanitizeEmailHtml(html) {
  let s = String(html == null ? '' : html);
  for (const t of DROP_WITH_CONTENT) {
    s = s.replace(new RegExp('<' + t + '\\b[\\s\\S]*?<\\/' + t + '\\s*>', 'gi'), '');
    // An unclosed opener: drop the tag itself.
    s = s.replace(new RegExp('<\\/?' + t + '\\b[^>]*>', 'gi'), '');
  }
  for (const t of DROP_TAG_ONLY) {
    s = s.replace(new RegExp('<\\/?' + t + '\\b[^>]*>', 'gi'), '');
  }
  // <meta http-equiv=refresh …> redirects; <meta charset> is harmless.
  s = s.replace(/<meta\b(?![^>]*\bcharset\s*=)[^>]*>/gi, '');
  // Event-handler attributes, quoted or bare.
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Script-scheme URLs in any attribute value (entity/whitespace-obfuscated
  // forms included). data: is allowed only for images (data:image/...).
  s = s.replace(/(\s(?:href|src|action|formaction|xlink:href|background|poster|srcset)\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, pre, val) => {
      const raw = val.replace(/^["']|["']$/g, '');
      const decoded = raw
        .replace(/&#x([0-9a-f]+);?/gi, (x, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d+);?/g, (x, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '')
        .replace(/[\u0000- ]+/g, '')
        .toLowerCase();
      if (/^(javascript|vbscript|livescript):/.test(decoded)) return pre + '"#"';
      if (/^data:/.test(decoded) && !/^data:image\/(png|jpe?g|gif|webp);/.test(decoded)) return pre + '"#"';
      return m;
    });
  // CSS expression()/javascript: inside style attributes (legacy IE/Outlook).
  s = s.replace(/\sstyle\s*=\s*("[^"]*(?:expression\s*\(|javascript:)[^"]*"|'[^']*(?:expression\s*\(|javascript:)[^']*')/gi, '');
  return s;
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Plain-text body → HTML: escaped, newlines kept.
function plainTextToHtml(body) {
  return '<p>' + escapeHtml(body).replace(/\r?\n/g, '<br>') + '</p>';
}

// replyTo is honoured only when it is the caller's own (verified) address.
function safeReplyTo(replyTo, decoded) {
  const r = normEmail(replyTo);
  const own = normEmail(decoded && decoded.email);
  return (r && own && r === own && decoded.email_verified === true) ? String(decoded.email).trim() : undefined;
}

module.exports = {
  callerCanAccessLead,
  callerCanAccessInvoice,
  recordEmails,
  recipientOnRecord,
  sanitizeEmailHtml,
  plainTextToHtml,
  safeReplyTo,
  escapeHtml,
  normEmail,
};
