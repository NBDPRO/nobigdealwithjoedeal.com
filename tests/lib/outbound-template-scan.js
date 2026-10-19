/**
 * tests/lib/outbound-template-scan.js — find banned wording in outbound
 * customer templates (texts, emails, customer documents).
 *
 * Banned or counsel-review phrases (Kentucky insurance-job law, the crews are
 * independent subcontractors, "fully insured" not "licensed"; Jo 2026-10-19):
 * this module only FINDS them. It never edits wording: legal wording is for
 * Jo / counsel (documentation/audit/MESSAGING-TEMPLATE-REVIEW-2026-10-19.md).
 *
 * Comments are stripped first, so a comment that quotes a banned phrase
 * (the rule "never say we handle the claim") neither hides nor causes a hit.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { stripJsComments } = require('./strip-js-comments');

const ROOT = path.join(__dirname, '..', '..');

const PHRASES = Object.freeze([
  { id: 'we_handle', re: /\bwe(?:['’]ll| will)? handle\b/gi, why: '"we handle ..." next to claims reads as claim handling (KRS 367 / no claim promises)' },
  { id: 'damage_free_before_insurance', re: /documents? damage free before you call (?:your )?insurance/gi, why: 'steers the homeowner to the contractor before the insurer' },
  { id: 'insurance_meant_to_cover', re: /exactly what homeowners insurance is meant to cover/gi, why: 'a coverage statement / outcome promise' },
  { id: 'handle_everything', re: /handle everything from the first inspection/gi, why: '"handle everything" from inspection on reads as handling the claim' },
  { id: 'in_house', re: /\bin[- ]house\b/gi, why: 'crews are independent subcontractors, never "in-house"' },
  { id: 'w2', re: /\bW-?2\b/g, why: 'crews are independent subcontractors, never W-2 employees' },
  { id: 'licensed', re: /\blicensed\b/gi, why: 'say "fully insured", not "licensed"' },
]);

/**
 * Every file that carries customer-facing outbound wording. Add a new template
 * file here (the test also auto-discovers any functions/ file that calls
 * emails.send / messages.create / .twiml so a new sender cannot hide).
 */
const TEMPLATE_FILES = Object.freeze([
  'functions/sms-functions.js',
  'functions/sms-keyword-replies.js',
  'functions/lead-alert.js',
  'functions/lead-followup.js',
  'functions/funnel-recovery.js',
  'functions/review-ask-auto.js',
  'functions/review-ask-auto-logic.js',
  'functions/missed-call-reply-logic.js',
  'functions/missed-call-autotext.js',
  'functions/storm-watch.js',
  'functions/storm-confirm.js',
  'functions/storm-report-email.js',
  'functions/estimate-email.js',
  'functions/email-functions.js',
  'functions/esign-io.js',
  'functions/esign-logic.js',
  'functions/esign-reminders.js',
  'functions/remote-signing.js',
  'functions/report-sharing.js',
  'functions/pro-prospects.js',
  'functions/doc-drafts-logic.js',
  'functions/render-pdf.js',
  'functions/verify-functions.js',
  'functions/alert-recipients-fns.js',
  'docs/pro/js/agent-inbox.js',
  'docs/pro/js/estimate-followups.js',
  'docs/pro/js/invoice-reminder.js',
  'docs/pro/js/review-engine.js',
  'docs/pro/js/smart-followup.js',
  'docs/pro/js/winback.js',
  'docs/pro/js/winback-logic.js',
  'docs/pro/js/document-generator-templates.js',
  'docs/pro/js/document-generator-library.js',
  'docs/pro/js/nbd-comms.js',
]);

/**
 * functions/ files that call a send API but only to the OWNER / staff /
 * platform (internal alerts, digests, account mail), or are the guard itself.
 * A new sender must be on this list or on TEMPLATE_FILES: it cannot ship unclassified.
 */
const INTERNAL_SENDERS = Object.freeze([
  'functions/anniversary-touch.js', 'functions/call-center.js', 'functions/call-watch.js',
  'functions/dormant-leads.js', 'functions/handlers/invites.js',
  'functions/integrations/email-queue-worker.js', 'functions/integrations/thursday.js',
  'functions/lead-digest.js', 'functions/marketing-report.js', 'functions/messaging-controls.js',
  'functions/morning-brief.js', 'functions/review-request-nudge.js', 'functions/storm-poller.js',
  'functions/weekly-digest.js',
  'functions/storm-watch.js', 'functions/verify-functions.js',   // internal: Jo's storm / new-lead alert (the customer texts in these files are covered by the SMS rules)
]);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** functions/ files that send a customer message but are not on TEMPLATE_FILES. */
function discoverSenders() {
  const known = new Set(TEMPLATE_FILES);
  const found = [];
  for (const abs of walk(path.join(ROOT, 'functions'), [])) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (rel.indexOf('functions/tests/') === 0) continue;
    const src = stripJsComments(fs.readFileSync(abs, 'utf8'));
    if (/emails\.send\(|messages\.create\(|KeywordReplies\.twiml\(/.test(src)) found.push({ rel, known: known.has(rel) });
  }
  return found;
}

/** [{ id, line, text }] for one source string (comments already stripped by the caller or not). */
function scanSource(src, opts) {
  const code = (opts && opts.keepComments) ? String(src) : stripJsComments(src);
  const out = [];
  const lines = code.split(/\r?\n/);
  lines.forEach((ln, i) => {
    for (const p of PHRASES) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(ln))) {
        out.push({ id: p.id, line: i + 1, text: ln.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50).trim() });
        if (m[0].length === 0) p.re.lastIndex++;
      }
    }
  });
  return out;
}

function scanFile(rel) {
  return scanSource(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

module.exports = { PHRASES, TEMPLATE_FILES, INTERNAL_SENDERS, discoverSenders, scanSource, scanFile, ROOT };
