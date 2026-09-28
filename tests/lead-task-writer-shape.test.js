/**
 * lead-task-writer-shape.test.js — every writer of leads/{id}/tasks emits
 * the shape the task READERS render.
 *
 * The readers (tasks.js renderTaskList / renderTodayTasks, notif-bell.js,
 * activity-feed.js, ai.js, customer-bootstrap loadTimeline) read
 * {text, title, done, dueDate}. On 2026-09-26 two writers were found
 * emitting {title, body, status:'open'} with no `text` and no `done`:
 *   • voicemail.js writeActionItemTasks — blank row, no dueDate, so it never
 *     reached Today's Tasks or the bell either
 *   • tools.js _qaCreateEverything (Quick Add "Reach out within 24h") — a
 *     blank line in Today's Tasks whose overdue alert read "undefined"
 * (documentation/audit/LEAD-TASK-SHAPE-2026-09-26.md)
 *
 * Three layers:
 *   1. The two fixed writers are EXECUTED (function source extracted and run
 *      in a vm against a stub Firestore) and the captured doc is checked.
 *   2. A sweep of every client addDoc into a leads/…/tasks collection under
 *      docs/pro/js — the sibling writers this bug hid among — asserts each
 *      literal carries `text` and `done`. Floor on the count so the sweep
 *      cannot go vacuous.
 *   3. scripts/backfill-lead-tasks-shape.js canonicalPatch, the pure decision
 *      the backfill applies to already-written rows.
 *
 * Run: node tests/lead-task-writer-shape.test.js   (no deps, no DOM)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (extra ? '\n      ' + extra : '')); }
}

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Index just past the '}' matching the '{' at `open`. String-, template- and
// comment-aware; good enough for hand-written writer code (no regex literals
// containing braces in the spans this is pointed at).
function matchBrace(src, open) {
  let depth = 0;
  const tmpl = []; // stack of brace depths at which a `${` opened
  for (let i = open; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '/' && nx === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && nx === '*') { i = src.indexOf('*/', i + 2) + 1; if (i <= 0) return -1; continue; }
    if (ch === '\'' || ch === '"') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (ch === '`') {
      for (i++; i < src.length && src[i] !== '`'; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { tmpl.push(depth); depth++; i++; break; }
      }
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (tmpl.length && tmpl[tmpl.length - 1] === depth) {
        tmpl.pop();
        // resume the template literal
        for (i++; i < src.length && src[i] !== '`'; i++) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === '$' && src[i + 1] === '{') { tmpl.push(depth); depth++; i++; break; }
        }
        continue;
      }
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractFunction(src, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function ' + name + ' not found');
  const open = src.indexOf('{', src.indexOf(')', m.index));
  const end = matchBrace(src, open);
  if (end < 0) throw new Error('unbalanced function ' + name);
  return src.slice(m.index, end);
}

// Stub Firestore that records every addDoc by collection path.
function makeWindow() {
  const writes = [];
  const win = {
    _db: {},
    _user: { uid: 'u1' },
    _userClaims: { companyId: 'c1' },
    collection: (_db, ...segs) => ({ __path: segs.join('/') }),
    addDoc: async (ref, data) => { writes.push({ path: ref.__path, data }); return { id: 'id' + writes.length }; },
    serverTimestamp: () => '__TS__',
  };
  win.window = win;
  return { win, writes };
}

function localYmd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function assertReaderShape(label, data, wantText) {
  ok(label + ': text is the item label', data.text === wantText, JSON.stringify(data));
  ok(label + ': title mirrors text', data.title === data.text);
  ok(label + ': done is boolean false', data.done === false);
  ok(label + ': dueDate is YYYY-MM-DD', typeof data.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.dueDate),
    'dueDate=' + JSON.stringify(data.dueDate));
  ok(label + ': no dead status field', !('status' in data));
}

(async () => {
  // ── 1a. voicemail.js writeActionItemTasks, executed ─────────────
  console.log('\nvoicemail.js writeActionItemTasks (executed)');
  {
    const fn = extractFunction(read('docs/pro/js/voicemail.js'), 'writeActionItemTasks');
    const { win, writes } = makeWindow();
    const ctx = vm.createContext({ window: win, console });
    vm.runInContext(fn + '\n;this.__fn = writeActionItemTasks;', ctx);
    const ids = await ctx.__fn({ leadId: 'L1', actionItems: ['  Call back about the leak  ', '', 42, 'Send the estimate'] });
    ok('writes one task per non-empty string item', writes.length === 2 && ids.length === 2, 'writes=' + writes.length);
    ok('writes land in leads/L1/tasks', writes.every(w => w.path === 'leads/L1/tasks'));
    if (writes[0]) {
      assertReaderShape('voicemail task', writes[0].data, 'Call back about the leak');
      ok('voicemail task: due today (local date)', writes[0].data.dueDate === localYmd(new Date()));
      ok('voicemail task: stamped userId/companyId/leadId',
        writes[0].data.userId === 'u1' && writes[0].data.companyId === 'c1' && writes[0].data.leadId === 'L1');
    }
    if (writes[1]) ok('second item keeps its own label', writes[1].data.text === 'Send the estimate');
  }

  // ── 1b. tools.js _qaCreateEverything (Quick Add), executed ──────
  console.log('\ntools.js _qaCreateEverything (executed)');
  {
    const fn = extractFunction(read('docs/pro/js/tools.js'), '_qaCreateEverything');
    const { win, writes } = makeWindow();
    const ctx = vm.createContext({ window: win, console, Date, String });
    vm.runInContext(fn + '\n;this.__fn = _qaCreateEverything;', ctx);
    await ctx.__fn('L2', { source: 'door', damage: 'hail' });
    const task = writes.find(w => w.path === 'leads/L2/tasks');
    ok('Quick Add writes a follow-up task', !!task, 'paths=' + writes.map(w => w.path).join(','));
    if (task) {
      assertReaderShape('quick-add task', task.data, 'Reach out within 24h');
      ok('quick-add task: due tomorrow (local date)',
        task.data.dueDate === localYmd(new Date(Date.now() + 24 * 60 * 60 * 1000)), 'dueDate=' + task.data.dueDate);
    }
  }

  // ── 2. every client addDoc into leads/…/tasks carries text + done ──
  console.log('\nsweep: client addDoc(…leads…tasks) literals');
  {
    const dir = path.join(ROOT, 'docs/pro/js');
    const files = fs.readdirSync(dir).filter(f => /\.m?js$/.test(f));
    const CALL = /addDoc\(\s*(?:[\w.]+\.)?collection\(\s*[^)]*?['"]leads['"]\s*,\s*[^,)]+,\s*['"]tasks['"]\s*\)\s*,\s*\{/g;
    const found = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      let m;
      CALL.lastIndex = 0;
      while ((m = CALL.exec(src))) {
        const open = m.index + m[0].length - 1;
        const end = matchBrace(src, open);
        const lit = src.slice(open, end)
          .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); // assertions must not match comments
        const line = src.slice(0, m.index).split('\n').length;
        found.push({ where: f + ':' + line, lit });
      }
    }
    ok('sweep found the known client writers (>= 7)', found.length >= 7, 'found ' + found.length + ': ' + found.map(x => x.where).join(', '));
    for (const w of found) {
      const hasText = /(^|[{,\s])text\s*[:,}]/.test(w.lit);
      const hasDone = /(^|[{,\s])done\s*:/.test(w.lit);
      ok(w.where + ' writes text + done', hasText && hasDone, (hasText ? '' : 'no text; ') + (hasDone ? '' : 'no done'));
    }
  }

  // ── 3. backfill canonicalPatch ──────────────────────────────────
  console.log('\nscripts/backfill-lead-tasks-shape.js canonicalPatch');
  {
    const { canonicalPatch } = require(path.join(ROOT, 'scripts/backfill-lead-tasks-shape.js'));
    const oldVm = { title: 'Call back', body: 'Auto-created from voicemail action items.', status: 'open',
      priority: 'normal', sourceType: 'voicemail', userId: 'u', companyId: 'c' };
    const p = canonicalPatch(oldVm);
    ok('old voicemail row: text from title, done false, dueDate null, notes from body',
      p && p.text === 'Call back' && p.done === false && p.dueDate === null && p.notes === oldVm.body, JSON.stringify(p));
    const oldQa = { title: 'Reach out within 24h', body: 'x', dueDate: '2026-09-01', status: 'open' };
    const q = canonicalPatch(oldQa);
    ok('old quick-add row: keeps its dueDate (no dueDate key in patch)', q && !('dueDate' in q) && q.text === 'Reach out within 24h');
    ok('status "completed" maps to done:true', canonicalPatch({ title: 'x', status: 'completed' }).done === true);
    ok('existing done:true is never overwritten', !('done' in (canonicalPatch({ title: 'x', status: 'open', done: true }) || {})));
    ok('canonical row → null (idempotent re-run)', canonicalPatch({ text: 'a', title: 'a', done: false, dueDate: '' }) === null);
    ok('Add-Event doc → null (own shape)', canonicalPatch({ type: 'event', title: 'Walkthrough' }) === null);
    ok('existing text is never overwritten', !('text' in (canonicalPatch({ text: 'mine', title: 'other' }) || {})));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failed:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
