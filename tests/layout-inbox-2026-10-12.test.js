/**
 * tests/layout-inbox-2026-10-12.test.js — L05 Triage Inbox (D6): the merge /
 * ranking / timer rules (pure, require()'d) plus the contract the E2E cannot see.
 *
 *   1. one row per PERSON across every feed; ordering by reply-by; timer states
 *   2. what is excluded: snoozed leads, set-aside keys, handled / non-pending drafts
 *   3. thread rows: inbound / outbound / call notes in time order
 *   4. pipeline pane groups by stage in the board's order, capped per stage
 *   5. claim wording: every suggested reply and every UI string passes the
 *      claim-wording filter (with a control that it can fail)
 *   6. nothing is sent here: the only send is NBDPhoneShare.share (consent /
 *      STOP / quiet-hours check first); no tel:/sms: composer, no direct send
 *   7. reads are bounded and each feed reports its own failure
 *   8. keys are guarded (typing, modifiers, dialogs); legend is on screen
 *   9. registry + css contract: lazy, solid surfaces, glass only in the rail
 *
 * Run: node tests/layout-inbox-2026-10-12.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const L = require(path.join(ROOT, 'docs/pro/js/layouts/inbox.js'));
const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const SRC = read('docs/pro/js/layouts/inbox.js');
const CSS = read('docs/pro/css/layouts/inbox.css');
const CODE = strip(SRC);
const NOW = Date.UTC(2026, 9, 12, 15, 0, 0);
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

const leads = [
  { id: 'L1', firstName: 'Tina', lastName: 'Text', phone: '5135550101', stage: 'new', _stageKey: 'new', createdAt: NOW - 10 * MIN, source: 'website' },
  { id: 'L2', firstName: 'Cal', lastName: 'Caller', phone: '5135550102', stage: 'inspected', _stageKey: 'inspected' },
  { id: 'L3', firstName: 'Old', lastName: 'Lead', phone: '5135550103', stage: 'new', _stageKey: 'new', createdAt: NOW - 20 * DAY },
  { id: 'L4', firstName: 'Snow', lastName: 'Zed', phone: '5135550104', stage: 'new', _stageKey: 'new', createdAt: NOW - 5 * MIN, snoozed: true },
  { id: 'L5', firstName: 'Est', lastName: 'Opened', phone: '5135550105', stage: 'estimate_sent_cash', _stageKey: 'estimate_sent_cash' },
  { id: 'L6', firstName: 'Late', lastName: 'Lou', phone: '5135550106', stage: 'contacted', _stageKey: 'contacted' },
  { id: 'L7', firstName: 'Dee', lastName: 'Draft', phone: '5135550107', stage: 'contacted', _stageKey: 'contacted' },
];
// rows exactly as phone_calls / phone_text_days carry them
const rows = [
  { id: 'cube_a1', channel: 'call', leadId: 'L2', startedAtMs: NOW - 3 * HOUR, status: 'short', direction: 'inbound', phoneDigits: '5135550102' },
  { id: 'cube_a2', channel: 'call', leadId: 'L2', startedAtMs: NOW - 5 * HOUR, status: 'short', direction: 'inbound', phoneDigits: '5135550102' },
  { id: 'txt_20261012_1', channel: 'text', leadId: 'L1', startedAtMs: NOW - 20 * MIN, summary: 'Can you come Friday?', messageCount: 2, phoneDigits: '5135550101', urgent: false, promises: [{ who: 'jo', text: 'Reply today' }] },
  { id: 'cube_b1', channel: 'call', startedAtMs: NOW - 30 * MIN, bucket: 'insurance', phoneDigits: '5135559999', summary: 'Carrier called about a visit', status: 'noted', direction: 'inbound' },
];
const groups = HA.groupNeeds(rows, NOW);
const est = [
  { leadId: 'L5', name: 'Est Opened', opened: true, openedAtMs: NOW - 2 * HOUR, openedLabel: 'Opened 2h ago', daysOut: 3, bucket: 'd2' },
  { leadId: 'L6', name: 'Late Lou', opened: false, daysOut: 6, bucket: 'd5' },
];
const plan = {
  promised: [{ leadId: 'L6', name: 'Late Lou', tasks: [{ id: 't1', text: 'Send photos' }], promises: [], overdue: true, dueYmd: '2026-10-10' }],
  stalled: [{ leadId: 'L7', name: 'Dee Draft', daysLate: 2 }],
};
const ai = [
  { id: 'd1', leadId: 'L7', status: 'pending', draftText: 'Hi Dee, thanks for texting. When works to talk?', generatedAt: NOW - 30 * MIN, inboundText: 'Is anyone coming?' },
  { id: 'd2', leadId: 'L1', status: 'sent', draftText: 'old', generatedAt: NOW - DAY },
  { id: 'd3', leadId: 'L2', status: 'dismissed', draftText: 'old', generatedAt: NOW - DAY },
];
const build = (extra) => L.buildItems(Object.assign({ now: NOW, groups, leads, estimateRows: est, plan, aiDrafts: ai,
  isSnoozed: (l) => l.snoozed === true }, extra || {}));

console.log('\n1. one row per person, ranked by reply-by');
{
  const items = build();
  const byKey = {};
  items.forEach((i) => { byKey[i.key] = i; });
  ok('the shared groupNeeds rule found the people (control for the fixture)', groups.length === 3, 'groups=' + groups.length);
  ok('Cal called twice and is ONE row with both calls', byKey['lead:L2'] && byKey['lead:L2'].callIds.length === 2);
  ok('Tina has a text AND is a new web lead: one row, two reasons', byKey['lead:L1'] && byKey['lead:L1'].reasons.length === 2);
  ok('every key is unique (people, not events)', new Set(items.map((i) => i.key)).size === items.length);
  ok('an unfiled number is its own person by number', !!byKey['num:5135559999'] && byKey['num:5135559999'].primary === 'carrier');
  ok('a missed call is labelled missed', byKey['lead:L2'].primary === 'missed');
  ok('Tina: the new-lead 30 min window is the tighter reply-by', byKey['lead:L1'].reasons[0].kind === 'webLead');
  ok('sorted by reply-by, most overdue first', items.every((it, i) => i === 0 || items[i - 1].replyByMs <= it.replyByMs));
  const lou = byKey['lead:L6'];
  ok('Late Lou: an overdue task and a quiet estimate are one person', lou && lou.reasons.length === 2 && lou.taskRefs.length === 1 && lou.taskRefs[0].taskId === 't1');
  ok('an opened estimate gets 24 h from when it was opened', byKey['lead:L5'].reasons[0].kind === 'estimate' && byKey['lead:L5'].reasons[0].replyByMs === NOW - 2 * HOUR + DAY);
  ok('a pending AI draft carries its text into the suggestion', byKey['lead:L7'].suggested.indexOf('thanks for texting') !== -1);
  ok('the suggestion for a new lead is the plain call-time ask', /thanks for reaching out about your roof/.test(byKey['lead:L1'].suggested));
  ok('the missed-call suggestion is the apology rule', /sorry I missed you/.test(byKey['lead:L2'].suggested));
  const c = L.folderCounts(items);
  ok('folder counts are people: all = rows', c.all === items.length);
  ok('texts / calls / leads / carrier / estimates / drafts each count a person once', c.texts >= 1 && c.calls >= 1 && c.leads === 1 && c.carrier === 1 && c.estimates === 1 && c.drafts === 1, JSON.stringify(c));
}

console.log('\n2. the timer chip');
{
  ok('well inside the window is green', L.timer(NOW + 100 * MIN, 2 * HOUR, NOW).state === 'green');
  ok('half the window gone is gold', L.timer(NOW + 50 * MIN, 2 * HOUR, NOW).state === 'gold');
  ok('past is red and says overdue', L.timer(NOW - 90 * MIN, 2 * HOUR, NOW).state === 'red' && /^Overdue 1h/.test(L.timer(NOW - 90 * MIN, 2 * HOUR, NOW).label));
  ok('gold names the time left', /^50m left$/.test(L.timer(NOW + 50 * MIN, 2 * HOUR, NOW).label));
  ok('days read as days', L.dur(3 * DAY) === '3d');
  const urgent = L.buildItems({ now: NOW, leads: [], groups: HA.groupNeeds([{ id: 'cube_u', channel: 'call', startedAtMs: NOW - 5 * MIN, urgent: true, phoneDigits: '5135551111', bucket: 'unknown', status: 'noted' }], NOW) });
  ok('an urgent call is held to 30 minutes', urgent.length === 1 && urgent[0].replyByMs === NOW - 5 * MIN + 30 * MIN);
}

console.log('\n3. what is left out');
{
  const keys = build().map((i) => i.key);
  ok('a snoozed lead is not in the inbox (new-lead feed)', keys.indexOf('lead:L4') === -1);
  ok('control: without the snooze rule that same lead IS listed', build({ isSnoozed: null }).some((i) => i.key === 'lead:L4'));
  ok('a new lead older than 7 days is not a speed-to-lead row', keys.indexOf('lead:L3') === -1);
  ok('sent / dismissed drafts are not listed', build().filter((i) => i.reasons.some((r) => r.kind === 'draft')).map((i) => i.key).join() === 'lead:L7');
  ok('a set-aside key is skipped', build({ skip: (k) => k === 'lead:L2' }).every((i) => i.key !== 'lead:L2'));
  ok('control: not skipped it is there', build().some((i) => i.key === 'lead:L2'));
  ok('agent drafts become a Drafts-folder reason; non-draft items are ignored', (() => {
    const items = build({ agentDrafts: [{ id: 'a1', leadId: 'L6', kind: 'draft_text', text: 'x', createdAt: NOW - HOUR }, { id: 'a2', leadId: 'L6', kind: 'note' }] });
    const lou = items.filter((i) => i.key === 'lead:L6')[0];
    return lou.reasons.filter((r) => r.kind === 'agent').length === 1 && lou.agentIds.length === 1;
  })());
}

console.log('\n4. thread + pipeline');
{
  const t = L.threadRows(
    [{ direction: 'inbound', body: 'hello', date: NOW - 3 * HOUR }, { direction: 'outbound', body: 'hi back', date: NOW - 2 * HOUR }, { status: 'received', body: 'ok', date: NOW - HOUR }],
    [{ subject: 'Your estimate', date: NOW - 4 * HOUR }],
    [{ channel: 'text', summary: 'two texts', startedAtMs: NOW - 5 * HOUR }]);
  ok('oldest first', t.every((r, i) => i === 0 || t[i - 1].at <= r.at));
  ok('inbound and received are "in", the rest "out"', t.filter((r) => r.dir === 'in').length === 2 && t.filter((r) => r.channel === 'email')[0].dir === 'out');
  ok('call / text-day summaries are notes', t.filter((r) => r.dir === 'note').length === 1);
  const g = L.groupByStage([{ id: 1, _stageKey: 'a' }, { id: 2, _stageKey: 'b' }, { id: 3, _stageKey: 'a' }, { id: 4, _stageKey: 'z', deleted: true }, { id: 5, _stageKey: 'c' }], ['b', 'a'], (k) => k.toUpperCase(), 1);
  ok('board order first, then unknown stages', g.map((x) => x.key).join() === 'b,a,c');
  ok('deleted leads are not shown; the per-stage cap keeps the total', g[1].total === 2 && g[1].leads.length === 1);
}

console.log('\n5. claim wording');
{
  const strings = [];
  const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g; let m;
  while ((m = re.exec(CODE))) strings.push((m[1] != null ? m[1] : m[2]).replace(/\\'/g, "'"));
  const copy = strings.filter((s) => /\s/.test(s) && /[A-Za-z]{3}/.test(s));
  ok('there is copy to scan', copy.length > 40, 'n=' + copy.length);
  const hits = [];
  copy.forEach((s) => CW.scanText(s).forEach((h) => hits.push(h.rule + ': ' + h.sentence)));
  ok('no UI string trips the claim-wording rules', hits.length === 0, hits.slice(0, 3).join(' | '));
  const kinds = Object.keys(L.KINDS).concat(['', 'unknown']);
  const sug = kinds.map((k) => L.suggestFor(k, 'Pat Smith'));
  const sh = [];
  sug.forEach((s) => CW.scanText(s).forEach((h) => sh.push(h.rule + ': ' + h.sentence)));
  ok('every suggested reply passes', sh.length === 0, sh.join(' | '));
  const bad = /\b(claim|insur\w*|cover\w*|approv\w*|price|cost|guarantee\w*)\b|\$\d/i;
  ok('no suggestion talks about claims, coverage, price or outcome', !sug.some((s) => bad.test(s)));
  ok('control: the filter flags a claim-handling sentence', CW.scanText('We handle the insurance claim for you.').length > 0);
  ok('control: the outcome-word check can fail', bad.test(L.suggestFor('x', 'A') + ' we cover your claim'));
}

console.log('\n6. nothing is sent from here');
{
  ok('the one send is NBDPhoneShare.share', (CODE.match(/PS\.share\(/g) || []).length === 1 && /W\.NBDPhoneShare/.test(CODE));
  ok('it asks for Messages (preferSms) and logs a source', /preferSms: true/.test(CODE) && /source: 'triage_inbox'/.test(CODE));
  const send = /\b(sendSMS|sendSms|sendText|sendEmail|NBDComms|smsOutbox|NBDSmsOutbox|sendLeadText|twilio)\b/i;
  ok('no direct send call or Twilio reference', !send.test(CODE));
  ok('control: that check does catch a direct send', send.test('window.NBDComms.sendSMS({ to: x })'));
  ok('no tel:/sms:/mailto: link is built here (Text is only the composer, which checks first)', !/['"`](sms|mailto):/.test(CODE));
  ok('the facts bar leaves Text out (a bare sms: link would skip the check)', /\['call', 'navigate', 'open', 'snooze', 'done'\]/.test(CODE));
  ok('Send is the only way to the share (no keyboard shortcut sends)', !/k === 'enter'/.test(CODE) && (CODE.match(/doSend\(\)/g) || []).length === 2);
  ok('Done writes only through callCenterAction handled / NBDTasks.setDone', /callable\('callCenterAction', \{ id: id, action: 'handled' \}\)/.test(CODE) && /T\.setDone\(/.test(CODE));
  ok('the only direct doc write is dismissing a draft the rep just sent', (CODE.match(/updateDoc\(/g) || []).length === 1 && /status: 'dismissed'/.test(CODE));
}

console.log('\n7. reads: bounded, honest');
{
  const q = (CODE.match(/W\.query\(/g) || []).length, lim = (CODE.match(/W\.limit\(/g) || []).length;
  ok('every query is limit()ed', q >= 6 && q === lim, 'query=' + q + ' limit=' + lim);
  ok('each feed keeps its own state + error', /feeds\.calls\.state = 'error'/.test(CODE) && /feeds\.drafts\.state = 'error'/.test(CODE) && /feeds\.agent\.state = 'error'/.test(CODE));
  ok('a failed read raises the banner, with a retry', /Some feeds did not load/.test(CODE) && /data-ib="reload"/.test(CODE));
  ok('the empty message is only reachable when every feed answered (allFeedsOk)', /if \(!allFeedsOk\(\)\) return/.test(CODE) && /Nothing needs a reply/.test(CODE));
  ok('a missing shared "needs you" rule is an error, not an empty list', /needs-you rule not loaded/.test(CODE));
  ok('a failed thread read says so and offers retry', /Could not load this thread/.test(CODE) && /data-ib="retry"/.test(CODE));
  ok('ai_drafts is read per lead (no collection-group rule exists: a collectionGroup read is permission-denied)', CODE.indexOf("W.collection(W.db, 'leads', id, 'ai_drafts')") !== -1 && CODE.indexOf('collectionGroup(') === -1 && CODE.indexOf("W.where('userId', '==', u)") !== -1);
  ok('control: the rules really have no collection-group rule for ai_drafts', read('firestore.rules').indexOf('{path=**}/ai_drafts') === -1);
  ok('calls use the shared people grouping (groupNeeds), not a private rule', /HA\.groupNeeds/.test(CODE) && !/callNeedsYou/.test(CODE));
}

console.log('\n8. keys');
{
  const fn = /function onKey\(ev\) \{[\s\S]*?\n  \}\n/.exec(CODE);
  const body = fn ? fn[0] : '';
  ok('found onKey', body.length > 100);
  ok('typing in a field returns before any key is handled', body.indexOf('typingTarget(ev.target)') !== -1 && body.indexOf('typingTarget(ev.target)') < body.indexOf("k === 'j'"));
  ok('modifiers return early', /ev\.metaKey \|\| ev\.ctrlKey \|\| ev\.altKey\) return/.test(body));
  ok('an open dialog stops the keys (snooze overlay or nbdModal.anyOpen; aria-modal is always in the markup so it is NOT used)', body.indexOf('dialogOpen()) return') !== -1 && CODE.indexOf('nbd-snooze-overlay') !== -1 && CODE.indexOf('nbdModal.anyOpen()') !== -1 && CODE.indexOf('aria-modal') === -1);
  ok('keys are captured and stopped when handled (the global E = New Estimate must not also fire)', CODE.indexOf("addEventListener('keydown', onKey, true)") !== -1 && body.indexOf('ev.stopPropagation()') !== -1);
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  ok('control: the dashboard really has a global bubble-phase E hotkey that opens a new estimate', boot.indexOf("e.key === 'e'") !== -1 && boot.indexOf('startNewEstimate()') !== -1 && boot.indexOf("document.addEventListener('keydown', (e) =>") !== -1);
  ok('J K R E S are all wired', ["'j'", "'k'", "'r'", "'e'", "'s'"].every((k) => body.indexOf('k === ' + k) !== -1));
  ok('typing guard covers input / textarea / select / contenteditable', /INPUT/.test(CODE) && /TEXTAREA/.test(CODE) && /SELECT/.test(CODE) && /isContentEditable/.test(CODE));
  ok('the legend is rendered with the keys', /<kbd>J<\/kbd><kbd>K<\/kbd> move/.test(CODE) && /<kbd>R<\/kbd> reply/.test(CODE) && /<kbd>E<\/kbd> done/.test(CODE) && /<kbd>S<\/kbd> snooze/.test(CODE));
  ok('an unchanged render leaves the DOM alone (a refresh event must not eat a click)', CODE.indexOf('if (html === lastHtml) return;') !== -1 && CODE.indexOf('rootEl.innerHTML = html;') !== -1 && CODE.indexOf('if (html === lastHtml) return;') < CODE.indexOf('rootEl.innerHTML = html;'));
  ok('no inline handlers or inline styles are built', !/\son[a-z]+=|\sstyle=/.test(CODE));
}

console.log('\n9. registry + css');
{
  const d = R.get('inbox');
  ok('registered as "inbox"', !!d && d.id === 'inbox');
  ok('lazy: its own script and stylesheet, kit as a dependency', d && d.script === 'js/layouts/inbox.js' && d.css === 'css/layouts/inbox.css' && d.needs && d.needs.script[0] === 'js/layouts/kit.js');
  ok('glass is declared off', d && d.supports && d.supports.glass === false);
  ok('offered on every surface', d && ['phone', 'tablet', 'desktop'].every((s) => d.surfaces.indexOf(s) !== -1));
  const html = read('docs/pro/dashboard.html');
  ok('not a boot tag (dashboard.html never names it)', html.indexOf('layouts/inbox') === -1);
  ok('and none of the inbox logic is in the always-loaded layout-system file', read('docs/pro/js/layout-system.js').indexOf('NBDInboxLogic') === -1);
  const css = strip(CSS);
  const sels = css.split('}').map((r) => r.split('{').slice(-1).length ? r.split('{')[0].trim() : '').filter(Boolean).map((s) => s.replace(/^@media[^{]*$/, ''));
  const unscoped = sels.filter((s) => s && !/^html\[data-layout="inbox"\]/.test(s));
  ok('every rule is scoped under html[data-layout="inbox"]', unscoped.length === 0, unscoped.slice(0, 3).join(' | '));
  const blur = css.split('}').filter((r) => /backdrop-filter/.test(r));
  ok('blur / glass appears only on the folder rail, behind the wallpaper class', blur.length >= 1 && blur.every((r) => /\.my-skin-wallpaper \.ib-rail/.test(r.split('{')[0])));
  ok('control: that check would catch a glass rule on the list', blur.concat(['html[data-layout="inbox"] .ib-list { backdrop-filter: blur(4px)']).some((r) => !/\.my-skin-wallpaper \.ib-rail/.test(r.split('{')[0])));
  ok('timer chips use the red / gold / green tokens', /var\(--red/.test(css) && /var\(--gold/.test(css) && /var\(--green/.test(css));
  ok('no hard-coded colours outside token fallbacks', !/#[0-9a-f]{3,8}\b/i.test(css.replace(/var\(--[a-z-]+,\s*#[0-9a-f]{3,8}\)/gi, '')));
  ok('on a phone the app bottom nav is hidden (it covered the lowest rows; the E2E caught it)', /@media \(max-width: 768px\)[^]*html\[data-layout="inbox"\] #mobile-nav \{ display: none !important; \}/.test(css));
  ok('sizes come from --tap', (css.match(/var\(--tap\)/g) || []).length >= 3);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
