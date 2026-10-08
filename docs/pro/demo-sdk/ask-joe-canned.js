// ask-joe-canned.js — Ask Joe in the sample account (Pro demo phase 2,
// wave 3, 2026-10-06).
//
// The real Ask Joe sends the conversation to claudeProxy (a Cloud Function
// that calls the model). The sample account never does: docs/pro/js/demo-mode.js
// keeps window.callClaude pointed at offline.js, which hands Ask Joe's turns
// here. A short list of set questions (the chat's own starter buttons plus a
// few more) is answered from the SAMPLE data on the page (window._leads and
// the in-browser store); anything else gets an honest "sample answers only"
// reply. Every answer ends by saying it is a sample answer and that no AI
// model was called.
//
// Answers speak for the sample company (Sample Roofing Co.), never for NBD:
// no NBD Pledge, no NBD warranty, no "lifetime" promise, no promise about
// what an insurance company will pay. Kentucky insurance jobs: nothing is
// due at signing.
import { rawList } from './_store.js';

export const SAMPLE_FOOTER = 'Sample answer: the sample account answers a few set questions from its sample data. No AI model was called. In your real account Ask Joe answers any question from your own customers, jobs and schedule.';

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
const leads = () => (typeof window !== 'undefined' && Array.isArray(window._leads) ? window._leads : []).filter((l) => l && !l.deleted);
const nameOf = (l) => ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Customer';
const roleOf = (l) => {
  try { if (window.NBDNumbers && typeof window.NBDNumbers.roleOf === 'function') return window.NBDNumbers.roleOf(l); } catch (_) { /* fall through */ }
  return l.stage === 'closed' ? 'won' : l.stage === 'lost' ? 'lost' : 'active';
};
// NBDNumbers roles are finer than active / won / lost (new, working, …): 'open' = neither won nor lost.
const isOpen = (l) => { const r = roleOf(l); return r !== 'won' && r !== 'lost'; };
const stageName = (l) => {
  try { if (typeof window.stageLabel === 'function') { const s = window.stageLabel(l.stage); if (s) return s; } } catch (_) { /* fall through */ }
  return String(l.stage || 'new').replace(/_/g, ' ');
};
function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function focusToday() {
  const t = todayYmd();
  const active = leads().filter((l) => isOpen(l));
  const due = active.filter((l) => l.followUp && String(l.followUp) <= t)
    .sort((a, b) => String(a.followUp).localeCompare(String(b.followUp)));
  const fresh = active.filter((l) => l.stage === 'new');
  const tasks = [];
  for (const l of active) {
    for (const [, d] of rawList('leads/' + l.id + '/tasks')) {
      if (!d.done && d.dueDate && String(d.dueDate) <= t) tasks.push({ who: nameOf(l), text: d.text || d.title || 'Task' });
    }
  }
  const lines = ['Here is today for the sample company:', ''];
  if (due.length) {
    lines.push('**Follow-ups due (' + due.length + ')**');
    due.slice(0, 5).forEach((l) => lines.push('- ' + nameOf(l) + ' (' + stageName(l) + ')' + (String(l.followUp) < t ? ', overdue' : '')));
    lines.push('');
  }
  if (tasks.length) {
    lines.push('**Tasks due (' + tasks.length + ')**');
    tasks.slice(0, 5).forEach((x) => lines.push('- ' + x.who + ': ' + x.text));
    lines.push('');
  }
  if (fresh.length) lines.push('**New leads to call first:** ' + fresh.map(nameOf).join(', ') + '.', '');
  lines.push('Start with the oldest overdue follow-up, then the new leads while the storm is fresh.');
  return lines.join('\n');
}

function likelyToClose() {
  const LATE = ['estimate_submitted', 'estimate_sent_cash', 'negotiating', 'prequal_sent', 'scope_received', 'supplement_requested', 'adjuster_meeting_scheduled'];
  const rank = (l) => LATE.indexOf(l.stage);
  const hot = leads().filter((l) => isOpen(l) && rank(l) !== -1)
    .sort((a, b) => (Number(b.jobValue) || 0) - (Number(a.jobValue) || 0)).slice(0, 4);
  if (!hot.length) return 'No sample jobs are far enough along to call yet.';
  return ['The sample jobs closest to a yes, biggest first:', '']
    .concat(hot.map((l) => '- **' + nameOf(l) + '**: ' + stageName(l) + (Number(l.jobValue) ? ', ' + money(l.jobValue) : '') + (l.jobType === 'insurance' ? ' (insurance job)' : '')))
    .concat(['', 'They already have a price or a scope in hand. A short check-in call beats another text.'])
    .join('\n');
}

function pipeline() {
  const all = leads();
  const active = all.filter((l) => isOpen(l));
  const won = all.filter((l) => roleOf(l) === 'won');
  const lost = all.filter((l) => roleOf(l) === 'lost');
  const value = active.reduce((s, l) => s + (Number(l.jobValue) || 0), 0);
  const byStage = {};
  active.forEach((l) => { const k = stageName(l); byStage[k] = (byStage[k] || 0) + 1; });
  const top = Object.entries(byStage).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return ['**Sample pipeline right now**', '',
    '- ' + active.length + ' active jobs, ' + money(value) + ' in job value',
    '- ' + won.length + ' won, ' + lost.length + ' lost',
    '', '**Where the active jobs sit**']
    .concat(top.map(([k, v]) => '- ' + k + ': ' + v))
    .join('\n');
}

function supplement() {
  return ['Here is a supplement request you can adapt (sample: Theo Barnes, scope missing starter and drip edge):', '',
    'Subject: Supplement request, claim SAMPLE-4110',
    '',
    'Hello, after reviewing the carrier\'s scope for the roof at 940 Example Point Dr, two items needed to complete the replacement are missing: starter strip at the eaves and rakes, and drip edge. ' +
    'Both are required by the shingle manufacturer\'s installation instructions. Attached: photos of each eave and rake, the measurement report and the line items with quantities. Please review and let us know if you need anything else.',
    '',
    '- Stick to facts: what is missing, why it is needed, the proof attached.',
    '- Send it with the homeowner\'s OK; it is their claim and their carrier decides.'].join('\n');
}

function lowball() {
  return ['When the carrier\'s estimate looks low:', '',
    '- Compare it line by line with your measured scope. Most gaps are missing items or wrong quantities, not price.',
    '- Send what is missing with photos and measurements, and ask for a re-inspection if the damage was missed.',
    '- Keep it factual and keep the homeowner in the loop. It is their claim: they and their carrier decide. Never promise how a claim will turn out.',
    '- Never offer to cover or waive a deductible.'].join('\n');
}

function kentucky() {
  return ['On a Kentucky insurance job, **nothing is due at signing**.', '',
    '- The contract carries the Kentucky notices, including the homeowner\'s right to cancel.',
    '- The deductible is collected after the carrier\'s decision, as the contract says, and is never waived or covered.',
    '- On a retail (cash) job the sample company takes a 50% deposit at signing; Kentucky insurance jobs never do.',
    '', 'The sample account follows the same rule: open Jordan Avery\'s estimate and the deal page shows $0 due at signing.'].join('\n');
}

function storm() {
  const zone = leads().filter((l) => l.hailHit || l.stormZone);
  return ['**The sample storm: Fort Thomas north**', '',
    '- Sample hail reports up to 1.75", ten days ago (sample data, not real reports).',
    '- The swath is drawn on the Door-to-Door map and in Storm Center as a zone.',
    '- ' + (zone.length ? zone.map(nameOf).join(', ') + ' is the lead from it so far.' : 'No lead from it yet.'),
    '', 'Open Door-to-Door to see every knocked door in the swath.'].join('\n');
}

function warranty() {
  return ['The sample company\'s packages: Standard, Preferred and Elite, each with the **GAF System Plus Limited Warranty** (sample prices).', '',
    'Workmanship warranty terms are whatever your written agreement says. Ask Joe never promises a warranty your company has not put in writing.'].join('\n');
}

const RULES = [
  [/focus|today|first|priorit|to.?do/i, focusToday],
  [/close|closing|likely|hot|warm/i, likelyToClose],
  [/supplement/i, supplement],
  [/lowball|low.?ball|adjuster|carrier.*(low|short)|underpa/i, lowball],
  [/kentucky|\bky\b|deposit|due at sign|signing|deductible/i, kentucky],
  [/pipeline|how many|value|stage|board/i, pipeline],
  [/storm|hail|swath|door|knock|d2d/i, storm],
  [/warrant|pledge|guarantee|lifetime/i, warranty]
];

function lastUserText(req) {
  const msgs = (req && Array.isArray(req.messages)) ? req.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ');
      if (t) return t;
      return ''; // a tool result: nothing new asked
    }
  }
  return '';
}

/** Ask Joe's turn → an Anthropic Messages-shaped reply, text only, no model. */
export function answerJoe(req) {
  const q = lastUserText(req);
  const hit = RULES.find(([re]) => re.test(q));
  const body = hit ? hit[1]() : 'In the sample account Ask Joe answers a few set questions. Try one of the buttons below the chat, or ask about today, your pipeline, a supplement, a lowball adjuster estimate, the storm, or what is due at signing on a Kentucky insurance job.';
  return {
    id: 'sample-' + Date.now().toString(36), type: 'message', role: 'assistant', model: 'sample-canned-answer',
    content: [{ type: 'text', text: body + '\n\n' + SAMPLE_FOOTER }],
    stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 }, sample: true
  };
}
