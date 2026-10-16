/**
 * tests/one-stop-line-2026-10-16.test.js — one text opt-out line everywhere.
 *
 * WHY: the vault rulebook (Company/Wording Rules.md → Texts, Jo): every text
 * includes "Reply STOP to opt out." The CRM templates, the lead
 * acknowledgement, the storm-watch alert and the HELP reply already said it.
 * Three places did not:
 *   - functions/agent-mcp-logic.js STOP_LINE, the line every bot text draft
 *     gets ("Reply STOP and we'll stop texting."),
 *   - the NWS storm text in functions/sms-functions.js ("Reply STOP to
 *     unsubscribe."),
 *   - the /storm-alerts signup note ("Reply STOP to unsubscribe anytime.").
 *
 * The registered A2P strings stay exactly as registered. The consent boxes'
 * "Reply STOP to opt out, HELP for help." and the START reply's "Reply HELP
 * for help, STOP to opt out." are word for word in the message flow and
 * sample list Jo pastes into Twilio
 * (documentation/projects/TWILIO-A2P-REAPPLY-PACKET-2026-10-13.md, section
 * 5), so this test pins the code to the packet rather than rewording them.
 *
 *   1. STOP_LINE is the rulebook line, and a bot draft gets it.
 *   2. No customer-text source (functions/, docs/pro/js, docs/assets/js, the
 *      public and CRM pages), comments stripped, carries another opt-out
 *      wording ("…and we'll stop texting", "…to unsubscribe", "…to stop",
 *      "…to cancel", "…anytime").
 *   3. Every sample message and keyword reply in the packet still matches
 *      what the code sends, and each one carries a STOP line.
 *
 * Run: node tests/one-stop-line-2026-10-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (r) => fs.readFileSync(path.join(ROOT, r), 'utf8');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const RULE = 'Reply STOP to opt out.';

// ── 1. The bot draft line ───────────────────────────────────────────────
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));
ok('STOP_LINE is the rulebook line', L.STOP_LINE === RULE, L.STOP_LINE);
{
  const d = L.buildTextDraft({ body: 'Hi Sam, Joe with No Big Deal — your estimate is ready.', reason: 'follow-up' }, ['No Big Deal']);
  ok('a bot text draft ends with it', d && typeof d.body === 'string' && d.body.endsWith('\n' + RULE), d && (d.body || d.error));
}

// ── 2. No other opt-out wording in customer-text source ─────────────────
function stripComments(src, file) {
  if (/\.(js|mjs)$/.test(file)) return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\'"])\/\/[^\n]*/g, '$1');
  return src.replace(/<!--[\s\S]*?-->/g, ' ');
}
const SKIP = new Set(['node_modules', 'vendor', 'sites', 'dev']);
const FILES = [];
function walk(dir, re) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, re); continue; }
    if (re.test(e.name) && !/\.min\.js$/.test(e.name)) FILES.push(p);
  }
}
walk(path.join(ROOT, 'functions'), /\.(js|hbs|html|txt)$/);
walk(path.join(ROOT, 'docs'), /\.(js|html)$/);
const OTHER = /\b(reply|text)\s+["']?STOP["']?\s+(and we('|’|\\')?ll stop|and we will stop|to unsubscribe|to stop|to cancel|to end|anytime|at any time|to quit)/i;
// The Terms page's SMS section keeps the CTIA wording Twilio checks for
// ("Reply STOP to cancel", error 30561), pinned by terms-page-2026-10-06.
const ALLOW = { 'docs/terms.html': 'CTIA Terms wording, Twilio 30561' };
const hits = [];
for (const f of FILES) {
  if (ALLOW[path.relative(ROOT, f).split(path.sep).join('/')]) continue;
  const t = stripComments(fs.readFileSync(f, 'utf8'), f).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const m = t.match(OTHER);
  if (m) hits.push(path.relative(ROOT, f).split(path.sep).join('/') + ': "' + t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20) + '"');
}
ok('scanned the texting source (' + FILES.length + ' files)', FILES.length > 500, String(FILES.length));
ok('no other opt-out wording than "Reply STOP to opt out"', !hits.length, hits.slice(0, 10).join('\n      '));
{
  const smsf = stripComments(read('functions/sms-functions.js'), 'x.js');
  ok('the NWS storm text ends with the rulebook line', /Storm Alert: \$\{event\} reported near \$\{zip\}\.[^`]*Reply STOP to opt out\.`/.test(smsf));
  const sa = read('docs/storm-alerts.html');
  ok('/storm-alerts signup note says "Reply STOP to opt out."', /Usually 2-4 times per season\. Reply STOP to opt out\.<\/div>/.test(sa));
}

// ── 3. The registered (packet) strings still match the code ─────────────
{
  const packet = read('documentation/projects/TWILIO-A2P-REAPPLY-PACKET-2026-10-13.md');
  const K = require(path.join(ROOT, 'functions/sms-keyword-replies.js'));
  const cell = (field) => { const m = packet.match(new RegExp('\\| ' + field + ' \\| `([^`]+)` \\|')); return m ? m[1] : null; };
  const help = cell('Help reply'), start = cell('Opt-in reply'), stop = cell('Opt-out reply');
  ok('packet: the HELP reply is the code\'s, word for word', help && help === K.helpReply(K.NBD_BRAND), help + ' | ' + K.helpReply(K.NBD_BRAND));
  ok('packet: the START reply is the code\'s, word for word', start && start === K.startReply(K.NBD_BRAND), start + ' | ' + K.startReply(K.NBD_BRAND));
  ok('packet: the opt-out reply is the code\'s, word for word', stop && stop === K.stopReply(K.NBD_BRAND));
  ok('…the HELP reply ends with the rulebook line', help && help.endsWith(RULE));
  ok('…the START reply keeps its registered "Reply HELP for help, STOP to opt out."', start && start.endsWith('Reply HELP for help, STOP to opt out.'));

  const sec = packet.slice(packet.indexOf('**Sample messages.**'), packet.indexOf('**Other customer texts'));
  const samples = (sec.match(/```\r?\n([\s\S]*?)\r?\n```/g) || []).map((b) => b.replace(/```\r?\n?/g, '').trim());
  ok('packet: three sample messages found', samples.length === 3, String(samples.length));
  samples.forEach((s, i) => ok('sample ' + (i + 1) + ' carries a STOP line', /Reply STOP to opt out\.$|Reply HELP for help, STOP to opt out\.$/.test(s), s));
  // Sample 2 is the storm-watch template, with its two variables.
  const sw = read('functions/storm-watch.js');
  const tpl = samples[1] && samples[1].replace('{event}', '${eventLabel(a.event)}').replace('{city}', "${a.event.city || 'your area'}");
  ok('sample 2 is functions/storm-watch.js\'s storm alert, word for word', !!tpl && sw.indexOf(tpl) !== -1, tpl);
  ok('sample 3 is the START reply', samples[2] === K.startReply(K.NBD_BRAND));
  const consent = 'Reply STOP to opt out, HELP for help.';
  ok('packet: the consent wording the pages show keeps "' + consent + '"', packet.indexOf(consent) !== -1 && read('docs/inspect.html').indexOf(consent) !== -1);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
