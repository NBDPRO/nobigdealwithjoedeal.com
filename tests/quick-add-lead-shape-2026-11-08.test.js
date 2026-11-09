/**
 * quick-add-lead-shape-2026-11-08.test.js — a Quick Add lead carries a job
 * type and a numeric job value (audit 2026-11-06, PL-F15).
 *
 * The doorstep Quick Add form (dashboard.html #quickAddModal, tools.js
 * saveQuickLead) wrote no `jobType` at all and `jobValue: ''`. An untyped
 * lead shows only on the All and Insurance boards and sits in "Sort my
 * customers" until someone types it by hand; the full form refuses a new
 * lead without one and writes `jobValue` as a number.
 *
 *   A. saveQuickLead, EXECUTED in a vm with a stub DOM: the payload handed
 *      to window._saveLead has the picked jobType and jobValue === 0
 *      (a number). An empty pick still saves (the pick is optional).
 *   B. openQuickAddLead, EXECUTED: qaJobType resets to '' and defaults to
 *      the board view on insurance/cash/finance (the full form's own
 *      whitelist, crm-leads.js openLeadModal), and stays '' elsewhere.
 *   C. Static: #qaJobType offers exactly #lJobType's options, in order.
 *
 * Run: node tests/quick-add-lead-shape-2026-11-08.test.js   (no deps, no DOM)
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
const TOOLS = read('docs/pro/js/tools.js');
const HTML = read('docs/pro/dashboard.html');

// Index just past the '}' matching the '{' at `open` (string-, template- and
// comment-aware; same walker as lead-task-writer-shape.test.js).
function matchBrace(src, open) {
  let depth = 0;
  const tmpl = [];
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

function el(value) {
  return { value: value, style: {}, textContent: '', selectedIndex: -1, classList: { add() {} }, focus() {} };
}

async function runSave(jobType) {
  const els = {
    qaAddr: el('12 Main St'), qaPhone: el(''), qaDamage: el('Roof - Hail'),
    qaSource: el('Door Knock'), qaErr: el(''),
  };
  if (jobType !== undefined) els.qaJobType = el(jobType);
  const calls = [];
  const win = {
    _saveLead: async (data) => { calls.push(data); return 'L1'; },
  };
  const ctx = vm.createContext({
    window: win,
    console,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => ({ textContent: '+ Add Lead', disabled: false }),
    },
    _qaCreateEverything: async () => {},
    showToast: () => {},
    closeQuickAddLead: () => {},
    loadLeads: () => {},
  });
  vm.runInContext(extractFunction(TOOLS, 'saveQuickLead') + '\n;this.__fn = saveQuickLead;', ctx);
  await ctx.__fn();
  return { calls, els };
}

function runOpen(viewKey, startValue) {
  const els = {
    qaAddr: el('old'), qaPhone: el('old'), qaErr: el(''),
    qaDamage: el('Roof - Wind'), qaSource: el('Referral'), qaJobType: el(startValue),
  };
  const win = { _currentViewKey: viewKey, nbdModal: { open() {} } };
  const ctx = vm.createContext({
    window: win,
    console,
    document: { getElementById: (id) => els[id] || null },
    _qaClearGpsLatch: () => {},
    _qaResetGpsBtn: () => {},
    setTimeout: () => {},
  });
  vm.runInContext(extractFunction(TOOLS, 'openQuickAddLead') + '\n;this.__fn = openQuickAddLead;', ctx);
  ctx.__fn();
  return els;
}

(async () => {
  console.log('\nA. tools.js saveQuickLead payload (executed)');
  {
    const { calls } = await runSave('cash');
    const p = calls[0] || {};
    ok('save reaches window._saveLead once', calls.length === 1, 'calls=' + calls.length);
    ok('payload carries the picked jobType', p.jobType === 'cash', 'jobType=' + JSON.stringify(p.jobType));
    ok('payload jobValue is the number 0, not empty text', p.jobValue === 0 && typeof p.jobValue === 'number',
      'jobValue=' + JSON.stringify(p.jobValue));
    ok('payload keeps its quick-add tag and fields', p._createdVia === 'quick-add' && p.address === '12 Main St' &&
      p.damageType === 'Roof - Hail' && p.source === 'Door Knock' && p.stage === 'new');
  }
  {
    const { calls } = await runSave('');
    const p = calls[0] || {};
    ok('an empty pick still saves (the pick is optional)', calls.length === 1);
    ok('an empty pick writes jobType ""', p.jobType === '', 'jobType=' + JSON.stringify(p.jobType));
  }
  {
    // A page without the select (stale cached markup) degrades, never throws.
    const { calls } = await runSave(undefined);
    ok('missing #qaJobType degrades to jobType "" and still saves',
      calls.length === 1 && calls[0].jobType === '', JSON.stringify(calls[0] && calls[0].jobType));
  }

  console.log('\nB. tools.js openQuickAddLead job-type default (executed)');
  for (const v of ['insurance', 'cash', 'finance']) {
    const els = runOpen(v, '');
    ok('view "' + v + '" defaults the pick to ' + v, els.qaJobType.value === v, 'value=' + JSON.stringify(els.qaJobType.value));
  }
  for (const v of ['simple', 'jobs', 'warranty', 'service', '']) {
    const els = runOpen(v, 'cash');
    ok('view "' + v + '" resets the previous pick to ""', els.qaJobType.value === '', 'value=' + JSON.stringify(els.qaJobType.value));
  }

  console.log('\nC. dashboard.html #qaJobType mirrors #lJobType');
  {
    const opts = (id) => {
      const m = new RegExp('<select[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</select>').exec(HTML);
      return m ? [...m[1].matchAll(/<option\s+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((o) => o[1] + '=' + o[2].trim()) : null;
    };
    const qa = opts('qaJobType'), full = opts('lJobType');
    ok('#lJobType found with its six options', !!full && full.length === 6, JSON.stringify(full));
    ok('#qaJobType exists inside #quickAddModal', !!qa && HTML.indexOf('id="qaJobType"') > HTML.indexOf('id="quickAddModal"') &&
      HTML.indexOf('id="qaJobType"') < HTML.indexOf('id="qaErr"'));
    ok('#qaJobType options equal #lJobType options, in order', !!qa && !!full && JSON.stringify(qa) === JSON.stringify(full),
      JSON.stringify(qa) + ' vs ' + JSON.stringify(full));
    const tag = (/<select[^>]*id="qaJobType"[^>]*>/.exec(HTML) || [''])[0];
    ok('#qaJobType carries no inline style or handler', !!tag && !/\bstyle\s*=|\son[a-z]+\s*=/i.test(tag), tag);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failed:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
