#!/usr/bin/env node
/**
 * Ask Joe actions (2026-10-02): Joe can look things up and — after a confirm
 * card — text one customer, add a reminder, or move a stage.
 *
 *   A. Server: the tool list is server-side and named; the browser cannot
 *      send its own tools; tools count against the budget reservation.
 *   B. History → API messages: every tool_use is answered by the next user
 *      message (synthetic "not run" when the user moved on), orphans dropped,
 *      cards never sent, window starts on a real user message.
 *   C. Cards: escaped, refuse a lead with no phone / bad date / bad stage.
 *   D. Execute: send_text reports the TRUE outcome per nbd-comms mode
 *      (platform sent / queued / handed to Messages / refused), reminders
 *      write the canonical task shape, stage moves go through moveCard with
 *      an undo, viewers are refused.
 *   E. ai.js: toolset requested, a pending card is cancelled when the user
 *      types on, card buttons are delegated (no inline handlers).
 *
 * Run: node tests/ask-joe-actions-2026-10-02.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

console.log('A. server tool list');
{
  const T = require(path.join(ROOT, 'functions', 'ask-joe-tools.js'));
  const tools = T.toolsFor('joe-actions-v1');
  // + add_note and agent_inbox_summary (2026-10-02: Jo prefers notes and
  // reminders in the CRM over texting).
  ok('joe-actions-v1 has the seven tools', Array.isArray(tools) && tools.map((t) => t.name).join() === 'find_customer,get_schedule,send_text,add_reminder,add_note,agent_inbox_summary,move_stage');
  ok('every tool has a JSON schema with required fields', tools.every((t) => t.input_schema && t.input_schema.type === 'object' && Array.isArray(t.input_schema.required)));
  ok('unknown / absent / prototype names give no tools', T.toolsFor('x') === null && T.toolsFor(undefined) === null && T.toolsFor('__proto__') === null && T.toolsFor('constructor') === null);
  ok('no bulk / list texting tool exists yet (needs the consent gate)', !tools.some((t) => /bulk|list|campaign|blast/i.test(t.name)));
  const ai = read('functions/handlers/ai.js');
  ok('claudeProxy attaches tools ONLY from the server list, by name', /const tools = require\('\.\.\/ask-joe-tools'\)\.toolsFor\(toolset\);/.test(ai) && /if \(tools\) anthropicBody\.tools = tools;/.test(ai) && !/req\.body\.tools|\btools\s*\}\s*=\s*req\.body/.test(ai));
  ok('tool tokens count against the budget reservation', /estimateInputTokens\(messages, safeSystem\)\s*\+ \(tools \? Math\.ceil\(JSON\.stringify\(tools\)\.length \/ 4\) : 0\)/.test(ai));
}

// Client module in a vm.
function loadActions(extra) {
  const win = Object.assign({ _leads: [], _user: { uid: 'u1', email: 'jo@x.test' }, _userClaims: {} }, extra || {});
  win.window = win;
  const ctx = vm.createContext({ window: win, console, JSON, Date, Math, Promise, Set });
  vm.runInContext(read('docs/pro/js/ask-joe-actions.js'), ctx);
  return win;
}

console.log('B. history → API messages');
{
  const W = loadActions(); const A = W.NBDJoeActions;
  const tu = (id, name) => ({ type: 'tool_use', id, name, input: {} });
  const H = [
    { role: 'joe', content: 'Hey Jo' },
    { role: 'user', content: 'text Maria' },
    { role: 'joe', content: [{ type: 'text', text: 'Looking her up' }, tu('t1', 'find_customer')] },
    { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }] },
    { role: 'joe', content: [tu('t2', 'send_text')] },
    { role: 'card', id: 't2', name: 'send_text', status: 'pending' },
    { role: 'user', content: 'actually wait' },
  ];
  const m = A.buildApiMessages(H, 20);
  ok('starts on a user message (the greeting is dropped)', m[0].role === 'user' && m[0].content === 'text Maria');
  ok('roles alternate', m.every((x, i) => i === 0 || x.role !== m[i - 1].role), JSON.stringify(m.map((x) => x.role)));
  ok('cards are never sent', !JSON.stringify(m).includes('"pending"'));
  const last = m[m.length - 1];
  ok('an unanswered tool_use gets a synthetic "not run" result, merged before the user text',
    last.role === 'user' && Array.isArray(last.content) && last.content[0].type === 'tool_result' && last.content[0].tool_use_id === 't2' && last.content[0].is_error === true && last.content[1].type === 'text' && last.content[1].text === 'actually wait', JSON.stringify(last));
  const orphan = A.buildApiMessages([{ role: 'user', content: 'hi' }, { role: 'joe', content: 'yo' }, { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'zz', content: 'x' }] }, { role: 'user', content: 'ok' }], 20);
  ok('a tool result with no matching tool_use is dropped', !JSON.stringify(orphan).includes('"zz"'), JSON.stringify(orphan));
  const long = [];
  for (let i = 0; i < 30; i++) { long.push({ role: 'user', content: 'q' + i }); long.push({ role: 'joe', content: [tu('x' + i, 'find_customer')] }); long.push({ role: 'tool', content: [{ type: 'tool_result', tool_use_id: 'x' + i, content: '{}' }] }); long.push({ role: 'joe', content: 'a' + i }); }
  const w = A.buildApiMessages(long, 20);
  ok('a trimmed window never starts on a tool result', w[0].role === 'user' && typeof w[0].content === 'string' && w.length <= 20, JSON.stringify(w[0]));
  ok('textOf joins only text blocks', A.textOf([{ type: 'text', text: 'a' }, tu('q', 'x'), { type: 'text', text: 'b' }]) === 'a\nb');
}

console.log('C. cards');
{
  const leads = [
    { id: 'L1', firstName: 'Maria', lastName: '<img src=x onerror=alert(1)>', phone: '(859) 555-0147', stage: 'negotiating' },
    { id: 'L2', firstName: 'Bob', lastName: 'Nophone', phone: '', stage: 'new' },
  ];
  const W = loadActions({ _leads: leads, stageLabel: (k) => ({ negotiating: 'Negotiating', contract_signed: 'Contract Signed', new: 'New' }[k] || k), normalizeStage: (s) => String(s).toLowerCase().trim().replace(/\s+/g, '_') });
  const A = W.NBDJoeActions;
  const html = A.cardHtml({ id: 't9"><b', name: 'send_text', input: { lead_id: 'L1', message: 'Hi <script>x</script>' }, status: 'pending' });
  ok('everything in a card is escaped (name, message, id)', !/<img|<script|t9"><b/.test(html) && /&lt;img/.test(html) && /&lt;script&gt;/.test(html), html.slice(0, 300));
  ok('text card shows only the last 4 digits and an editable message', /••• 0147/.test(html) && /<textarea class="joe-card-text"/.test(html) && !/555-0147/.test(html));
  ok('no phone on file → refused card', A.describe('send_text', { lead_id: 'L2', message: 'x' }).error === 'Bob Nophone has no phone number on file.');
  ok('unknown customer → refused', /not on your board/.test(A.describe('send_text', { lead_id: 'NOPE', message: 'x' }).error));
  ok('reminder needs a real date', /needs a date/.test(A.describe('add_reminder', { lead_id: 'L1', due_date: 'Friday', note: 'x' }).error));
  ok('a made-up stage is refused; a real one shows from → to', /not a pipeline stage/.test(A.describe('move_stage', { lead_id: 'L1', stage: 'banana' }).error) && A.describe('move_stage', { lead_id: 'L1', stage: 'Contract Signed' }).sub === 'Negotiating → Contract Signed');
}

console.log('D. execute');
(async () => {
  const lead = { id: 'L1', firstName: 'Maria', lastName: 'Lopez', phone: '8595550147', stage: 'negotiating', userId: 'u1' };
  const sent = [];
  function W(mode, extra) {
    return loadActions(Object.assign({
      _leads: [lead],
      NBDComms: { sendSMS: async (o) => { sent.push(o); return mode; } },
      stageLabel: (k) => ({ negotiating: 'Negotiating', contract_signed: 'Contract Signed' }[k] || k),
      normalizeStage: (s) => s,
    }, extra || {})).NBDJoeActions;
  }
  const card = { id: 'c1', name: 'send_text', input: { lead_id: 'L1', message: 'Hi Maria' }, editedMessage: 'Hi Maria, Thursday 2 PM works.' };
  let r = await W({ success: true, mode: 'platform' }).execute(card);
  ok('platform send → "Sent", with the EDITED message, the lead id and source', r.ok && /Sent to Maria Lopez/.test(r.text) && sent[0].message === 'Hi Maria, Thursday 2 PM works.' && sent[0].leadId === 'L1' && sent[0].to === '8595550147' && sent[0].source === 'ask_joe');
  r = await W({ success: true, mode: 'sms' }).execute(card);
  ok('handed to the Messages app → NOT reported as sent', !r.ok && /Messages app/.test(r.text));
  r = await W({ success: true, mode: 'queued' }).execute(card);
  ok('queued offline → says it sends when back online', r.ok && /back online/.test(r.text));
  r = await W({ success: false, mode: 'platform', error: 'forbidden', message: 'This recipient has opted out of SMS (replied STOP).' }).execute(card);
  ok('an opt-out refusal is reported, not hidden', !r.ok && /opted out/.test(r.text));
  r = await W({ success: true, mode: 'platform' }, { _userClaims: { role: 'viewer' } }).execute(card);
  ok('a viewer is refused before anything sends', !r.ok && /view-only/.test(r.text));

  const writes = [];
  const fb = { db: {}, collection: (...a) => a.slice(1).join('/'), addDoc: async (col, data) => { writes.push({ col, data }); return { id: 'n1' }; }, serverTimestamp: () => 'TS' };
  r = await W({ success: true, mode: 'platform' }, fb).execute({ id: 'c2', name: 'add_reminder', input: { lead_id: 'L1', due_date: '2026-10-09', note: 'Call about gutters' } });
  const w = writes[0];
  ok('reminder writes the canonical task under the lead', r.ok && w && w.col === 'leads/L1/tasks' && w.data.title === 'Call about gutters' && w.data.text === 'Call about gutters' && w.data.dueDate === '2026-10-09' && w.data.done === false && w.data.userId === 'u1' && w.data.leadId === 'L1', JSON.stringify(w));

  const moves = [];
  const mv = { moveCard: async (id, st) => { moves.push([id, st]); return true; } };
  const A = W({}, mv);
  const sc = { id: 'c3', name: 'move_stage', input: { lead_id: 'L1', stage: 'contract_signed' } };
  r = await A.execute(sc);
  ok('stage move goes through moveCard and offers an undo to the old stage', r.ok && moves[0][1] === 'contract_signed' && r.undo && r.undo.stage === 'negotiating');
  sc.undo = r.undo;
  r = await A.undo(sc);
  ok('undo moves it back through moveCard', r.ok && moves[1][0] === 'L1' && moves[1][1] === 'negotiating');
  r = await W({}, { moveCard: async () => false }).execute(sc);
  ok('a refused / cancelled move is reported as not moved', !r.ok && /Not moved/.test(r.text));

  console.log('D2. notes + the bot inbox');
  writes.length = 0;
  r = await W({ success: true, mode: 'platform' }, fb).execute({ id: 'c4', name: 'add_note', input: { lead_id: 'L1', text: 'Wants the HailGuard upgrade priced.' } });
  const nw = writes[0];
  ok('add_note writes a card note (top-level notes, the card\'s own shape)', r.ok && nw && nw.col === 'notes' && nw.data.leadId === 'L1' && nw.data.userId === 'u1' && nw.data.text === 'Wants the HailGuard upgrade priced.' && nw.data.source === 'ask_joe', JSON.stringify(nw));
  ok('an empty note is refused before anything is written', !!W({}).describe('add_note', { lead_id: 'L1', text: '  ' }).error);
  ok('add_note is an action (confirm card), the inbox summary is a read', W({}).isAction('add_note') && W({}).isRead('agent_inbox_summary'));
  const inboxDocs = [{ bot: 'Marcus · NBD Ops', kind: 'note', leadId: 'L1', text: 'quiet since June', verified: true, createdAt: { seconds: 2 } }, { bot: 'Marcus · NBD Ops', kind: 'reminder', leadId: 'L1', dueDate: '2026-10-09', text: 'call', createdAt: { seconds: 3 } }, { bot: 'Theo · Venture Scout', kind: 'report', text: 'storms', createdAt: { seconds: 1 } }];
  const sumW = W({}, { db: {}, collection: () => 'c', where: () => 'w', query: () => 'q', getDocs: async () => ({ docs: inboxDocs.map((d) => ({ data: () => d })) }) });
  const sum = JSON.parse(await sumW.runRead('agent_inbox_summary', {}));
  ok('inbox summary: counts by bot and kind, newest first, customer names', sum.waiting === 3 && sum.by_bot['Marcus · NBD Ops'].notes === 1 && sum.by_bot['Marcus · NBD Ops'].reminders === 1 && sum.by_bot['Theo · Venture Scout'].reports === 1 && sum.newest[0].kind === 'reminder' && sum.newest[0].customer === 'Maria Lopez', JSON.stringify(sum));
  ok('the system prompt steers "note that / remind me" to notes and reminders', /Jo prefers NOTES and REMINDERS/.test(read('docs/pro/js/ask-joe-actions.js')));

  console.log('E. ai.js wiring');
  const ai = read('docs/pro/js/ai.js');
  ok('the dashboard chat asks for the named toolset', /if \(A\) req\.toolset = A\.TOOLSET;/.test(ai));
  ok('reads run at once; only the FIRST action becomes a card', /A\.isRead\(u\.name\)[\s\S]{0,200}A\.runRead\(u\.name, u\.input\)/.test(ai) && /A\.isAction\(u\.name\) && !action/.test(ai));
  ok('typing on cancels a pending card before the new message', /joeCancelPendingCard\(\);\s*appendJoeMessage\('user', text\);/.test(ai));
  ok('card buttons are delegated (no inline handlers)', /closest\('\[data-joe-card\]'\)/.test(ai) && !/onclick=/.test(read('docs/pro/js/ask-joe-actions.js')));
  ok('the tool loop is bounded', /const JOE_MAX_ROUNDS = 4;/.test(ai));
  const dash = read('docs/pro/dashboard.html');
  ok('dashboard loads ask-joe-actions.js before ai.js, plus its CSS', dash.indexOf('js/ask-joe-actions.js?v=') > 0 && dash.indexOf('js/ask-joe-actions.js?v=') < dash.indexOf('js/ai.js?v=') && /css\/ask-joe-actions\.css\?v=\d+/.test(dash));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
