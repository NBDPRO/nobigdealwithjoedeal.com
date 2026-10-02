#!/usr/bin/env node
/**
 * Agent inbox (2026-10-02): the Grok Bot team's notes / reminders / reports
 * land here for Jo; approving writes ONLY to the CRM (a customer note or a
 * dated task) — there is no send path.
 *
 *   A. writeFor: note → top-level notes (the card's own note shape),
 *      reminder → leads/{id}/tasks (canonical task), report → no write;
 *      empty text / missing customer / bad date are refused; edited text wins.
 *   B. sortItems: reminders by date first, then notes, then reports.
 *   C. Wiring: no send/SMS/email call anywhere in the file; everything painted
 *      is escaped; the 🤖 bell notification opens ?agentInbox=1; rules keep
 *      items server-created and decisions one-way (section 45 in
 *      firestore-rules.test.js runs them for real).
 *
 * Run: node tests/agent-inbox-2026-10-02.test.js
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

const win = { location: { search: '', pathname: '/pro/dashboard.html', hash: '' }, history: { replaceState() {} } };
win.window = win;
const ctx = vm.createContext({ window: win, document: { readyState: 'complete', addEventListener() {} }, console, setTimeout, JSON, Math, String });
vm.runInContext(read('docs/pro/js/agent-inbox.js'), ctx);
const A = win.NBDAgentInbox;

console.log('A. what an approval writes');
const note = { id: 'n1', kind: 'note', leadId: 'L1', bot: 'Marcus · NBD Ops', text: 'Went quiet after the estimate in June. Ask about the gutter add-on.' };
let w = A.writeFor(note, 'u1', 'jo@x.test');
ok('note → top-level notes with the card’s own fields, credited to the bot', w.path.join('/') === 'notes' && w.data.leadId === 'L1' && w.data.userId === 'u1' && /— filed by Marcus · NBD Ops$/.test(w.data.text) && w.data.source === 'agent_inbox' && w.data.agentItemId === 'n1');
const rem = { id: 'r1', kind: 'reminder', leadId: 'L1', bot: 'Tucker', text: 'Call about final payment', dueDate: '2026-10-09' };
w = A.writeFor(rem, 'u1', 'jo@x.test', 'Call Maria about final payment');
ok('reminder → canonical task under the customer, due date kept, edited text wins', w.path.join('/') === 'leads/L1/tasks' && w.data.title === 'Call Maria about final payment' && w.data.text === w.data.title && w.data.dueDate === '2026-10-09' && w.data.done === false && w.data.userId === 'u1');
ok('report → no CRM write', A.writeFor({ id: 'p1', kind: 'report', text: 'Weekly margins' }, 'u1').path === null);
ok('empty text is refused', !!A.writeFor(Object.assign({}, note, { text: '   ' }), 'u1').error);
ok('a note with no customer is refused', !!A.writeFor(Object.assign({}, note, { leadId: null }), 'u1').error);
ok('a reminder with a bad date is refused', !!A.writeFor(Object.assign({}, rem, { dueDate: 'Friday' }), 'u1').error);
ok('an unknown kind is refused', !!A.writeFor({ id: 'x', kind: 'send_text', leadId: 'L1', text: 'hi' }, 'u1').error);

console.log('B. order');
const sorted = A.sortItems([{ id: 'a', kind: 'report' }, { id: 'b', kind: 'note' }, { id: 'c', kind: 'reminder', dueDate: '2026-10-20' }, { id: 'd', kind: 'reminder', dueDate: '2026-10-05' }]);
ok('reminders by date, then notes, then reports', sorted.map((x) => x.id).join() === 'd,c,b,a');

console.log('C. wiring');
const src = read('docs/pro/js/agent-inbox.js');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok('no send path at all (no SMS / email / comms call)', !/sendSMS|sendEmail|NBDComms|sendQueued/.test(code));
ok('the only server calls are the bot-key callables', (code.match(/callable\('(\w+)'/g) || []).every((m) => /createAgentKey|listAgentKeys|revokeAgentKey/.test(m)));
ok('everything painted is escaped', /esc\(leadName\(it\.leadId\)\)/.test(src) && /esc\(it\.text \|\| ''\)/.test(src) && /esc\(it\.bot \|\| 'Agent'\)/.test(src) && /esc\(it\.title\)/.test(src));
const bell = read('docs/pro/js/notif-bell.js');
ok('the 🤖 bell notification opens the inbox', /agent_inbox: '🤖'/.test(bell) && /n\.type === 'agent_inbox' \? '\/pro\/dashboard\.html\?agentInbox=1'/.test(bell));
const rules = read('firestore.rules');
const block = (rules.match(/match \/agent_inbox\/\{itemId\} \{([\s\S]*?)\n    \}/) || [])[1] || '';
ok('rules: items are server-created only, never deleted from the client', /allow create, delete: if false;/.test(block));
ok('rules: a decision is one-way and only touches the decision fields', /resource\.data\.status == 'pending'/.test(block) && /request\.resource\.data\.status in \['approved', 'dismissed'\]/.test(block) && /affectedKeys\(\)\.hasOnly\(\['status', 'decidedAt', 'decidedBy', 'result', 'text'\]\)/.test(block));
const dash = read('docs/pro/dashboard.html');
ok('dashboard loads the inbox + its CSS', /<script defer src="js\/agent-inbox\.js\?v=\d+"><\/script>/.test(dash) && /css\/agent-inbox\.css\?v=\d+/.test(dash));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
