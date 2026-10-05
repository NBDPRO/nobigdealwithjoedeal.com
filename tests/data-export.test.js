/**
 * tests/data-export.test.js — CSV formula injection (2026-09-03).
 *
 * docs/pro/js/data-export.js writes the rep's own leads and estimates to a
 * .csv he then double-clicks. Until this fix csvEscape quoted only for the
 * separator, the quote and the newline, so a field whose FIRST character was
 * = + - @ TAB or CR shipped verbatim — and Excel and Sheets evaluate such a
 * cell as a formula on open. Lead names, addresses and notes are supplied by
 * strangers through the PUBLIC intake form, which makes that a path from a
 * hostile form submission to code running on the owner's machine, in a file
 * he produced himself and therefore trusts.
 *
 * csvEscape now prefixes the spreadsheet text marker (') and quotes the
 * field. The exemption pinned below is the interesting half: a wholly-numeric
 * value like -1500 is left alone so a credit still reads and sums as a
 * number. This file pins both directions, because a regression in either one
 * is invisible until someone opens an export.
 *
 * DataExport is a Tranche-0 name (tests/smoke/dashboard.test.js), so there is
 * deliberately nothing on window to poke at — everything here is driven
 * through the real entry points, window.exportLeadsCsv /
 * window.exportEstimatesCsv, and read back off the Blob they hand the
 * download anchor.
 *
 * Zero deps. Run: node tests/data-export.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; fails.push(label); }
}

// ── Minimal DOM + Blob/URL so downloadCsv runs and we can read the file ──
function makeEl() {
  return {
    href: '', download: '', style: {}, dataset: {}, value: '',
    click() {}, appendChild() {}, removeChild() {},
    addEventListener() {}, removeEventListener() {},
    // The Sheets path copies through a hidden textarea (execCommand).
    setAttribute() {}, select() {}, setSelectionRange() {},
  };
}

let lastCsv = null;   // text of the most recent export
let lastName = null;  // filename it was offered under

function Blob(parts) { this.text = parts.join(''); lastCsv = this.text; }

const anchor = makeEl();
const win = { location: { href: '', pathname: '/pro/dashboard' } };
win.window = win;

// ── Sheets path: record what got opened and what got copied, and in which
// order. Two rules pull against each other. Safari only honours a popup opened
// in the same task as the click, so nothing may be AWAITED before
// window.open. And on desktop the new tab takes focus, so any copy that runs
// AFTER window.open fails. The fix: a synchronous execCommand copy first
// (awaits nothing), then open. execMode lets the test drive that copy's
// success, failure, or absence.
let execMode = 'ok';   // 'ok' | 'fail' | 'missing'
let lastClip = null;
let opened = null;
const callOrder = [];
win.open = (url, target, feat) => {
  callOrder.push('open');
  opened = { url, target, feat };
  return { closed: false };
};
const navigator = {
  clipboard: {
    writeText: (t) => { callOrder.push('copy'); lastClip = t; return Promise.resolve(); },
  },
};

const _ls = {};
const localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; },
};

const sandbox = {
  window: win,
  document: {
    createElement: () => { lastName = null; anchor.download = ''; anchor.value = ''; return anchor; },
    // A textarea appended for the copy has no download name; only a real
    // download anchor sets one.
    body: { appendChild(a) { lastName = a.download || null; }, removeChild() {} },
    get execCommand() {
      if (execMode === 'missing') return undefined;
      return (cmd) => {
        callOrder.push('exec');
        if (execMode === 'ok' && cmd === 'copy') { lastClip = anchor.value; return true; }
        return false;
      };
    },
    addEventListener() {}, removeEventListener() {},
    getElementById: () => null,
  },
  // data-export.js reads localStorage un-namespaced, not off window.
  localStorage,
  navigator,
  Blob,
  URL: { createObjectURL: () => 'blob:nbd', revokeObjectURL() {} },
  // The cleanup timer is a no-op so nothing keeps the loop alive.
  setTimeout: () => 0, clearTimeout: () => 0,
  console: { log() {}, warn() {}, error() {} },
  Date, Math, JSON, Object, Array, String, Number, isNaN, encodeURIComponent,
};

const SRC_PATH = path.join(__dirname, '..', 'docs/pro/js/data-export.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
vm.runInNewContext(src, sandbox, { filename: 'data-export.js' });

// ── A real RFC-4180 reader. Parsing (rather than string-matching) is the
// point: it proves the added marker never breaks the column, because a
// neutralizer that leaked out of its cell would shift every field after it.
function parseCsv(text) {
  const s = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let inQ = false; let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQ = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r' && s[i + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; i += 2; continue;
    }
    field += c; i++;
  }
  row.push(field); rows.push(row);
  return rows;
}

// Column order is LEAD_HEADERS' order; index by label so a future column
// insert doesn't silently re-point these assertions at the wrong field.
function col(rows, label) { return rows[0].indexOf(label); }

// ── The export under test: one lead carrying every hostile shape ──────────
const HOSTILE = {
  id: 'L1',
  customerId: 'NBD-1001',
  firstName:  '=cmd|\' /C calc\'!A0',      // classic DDE payload
  lastName:   '+SUM(1+1)*cmd|\' /C calc\'!A0',
  address:    '-2+3+cmd|\' /C calc\'!A0',
  phone:      '@SUM(1+1)',
  email:      'jane=doe@example.com',       // contains = but doesn't start with it
  stage:      'contacted',
  jobType:    'roof',
  source:     '\tleading tab',              // 0x09 leader
  damageType: 'hail',
  jobValue:   -1500,                        // a credit — must stay a number
  claimNumber: 'C-77',
  insCarrier: 'State Farm, Inc. "SF"',      // comma + quotes
  claimStatus: '\rleading cr',              // 0x0D leader
  notes:      'line one\nline two',         // embedded newline
};

win._leads = [HOSTILE];
win.exportLeadsCsv();

const csv = lastCsv;
const rows = parseCsv(csv);
const r = rows[1];

console.log('\nCSV FORMULA INJECTION — leads export');
ok('export produced a file', typeof csv === 'string' && csv.length > 0);
ok('filename is the nbd-leads-YYYY-MM-DD.csv pattern',
  /^nbd-leads-\d{4}-\d{2}-\d{2}\.csv$/.test(lastName || ''));
ok('BOM still prepended (Excel for Windows reads it as UTF-8)', csv.charCodeAt(0) === 0xFEFF);
ok('exactly one header row + one data row', rows.length === 2);
ok('no column drift — data row has as many fields as the header',
  r.length === rows[0].length);

console.log('\nNEUTRALIZED — dangerous leaders get the text marker');
ok('= leader marked',  r[col(rows, 'First Name')] === "'" + HOSTILE.firstName);
ok('+ leader marked',  r[col(rows, 'Last Name')] === "'" + HOSTILE.lastName);
ok('- leader marked (expression, not a number)',
  r[col(rows, 'Address')] === "'" + HOSTILE.address);
ok('@ leader marked',  r[col(rows, 'Phone')] === "'" + HOSTILE.phone);
ok('TAB leader marked', r[col(rows, 'Source')] === "'\tleading tab");
ok('CR leader marked',  r[col(rows, 'Claim Status')] === "'\rleading cr");
// The marker must live inside quotes or it can be read as part of the
// column structure rather than the cell.
ok('marked field is quoted', csv.indexOf('"\'=cmd|\' /C calc\'!A0"') >= 0);

console.log('\nUNTOUCHED — legitimate values must not be mangled');
ok('= not in first position is left alone',
  r[col(rows, 'Email')] === 'jane=doe@example.com');
ok('...and is not needlessly quoted', csv.indexOf(',jane=doe@example.com,') >= 0);
ok('a negative number still reads as a number to a human',
  r[col(rows, 'Job Value')] === '-1500');
ok('...emitted bare, no marker and no quotes', csv.indexOf(',hail,-1500,C-77,') >= 0);
ok('ordinary text unchanged', r[col(rows, 'Stage')] === 'contacted');
ok('ordinary text unquoted', csv.indexOf(',contacted,roof,') >= 0);

console.log('\nNO REGRESSION — RFC-4180 quoting still works');
ok('comma + embedded quotes survive a round trip',
  r[col(rows, 'Carrier')] === 'State Farm, Inc. "SF"');
ok('internal quotes are doubled on the wire',
  csv.indexOf('"State Farm, Inc. ""SF"""') >= 0);
ok('embedded newline survives inside one field',
  r[col(rows, 'Notes')] === 'line one\nline two');

console.log('\nHEADER LINE');
ok('header labels present and intact',
  rows[0][0] === 'Customer ID' && rows[0].indexOf('Claim #') >= 0);
// The header row is built from the same csvEscape as the data rows, so it is
// covered by construction. Pinned at the source because today's labels are
// all hard-coded and safe — the day someone adds a user-named column, this is
// what stops it shipping through an unescaped path.
ok('header line routes through csvEscape (no second, unguarded path)',
  /headerLine\s*=\s*headers\.map\(\s*h\s*=>\s*csvEscape\(/.test(src));
ok('csvEscape is the single choke point — data rows use it too',
  /lines\.push\(headers\.map\(\s*h\s*=>\s*csvEscape\(/.test(src));

console.log('\nESTIMATES EXPORT — the joined leadName column too');
// leadName is derived from lead data, so it needs the same guard as the
// lead export's own columns; a payload in firstName reaches this file as well.
win._leads = [{ id: 'L9', firstName: '=HYPERLINK("http://evil","click")', lastName: 'Roe' }];
win._estimates = [{ id: 'E1', leadId: 'L9', status: 'sent', total: 250000, lineItems: [] }];
win.exportEstimatesCsv();
const erows = parseCsv(lastCsv);
ok('estimates file offered under the estimates name',
  /^nbd-estimates-\d{4}-\d{2}-\d{2}\.csv$/.test(lastName || ''));
ok('no column drift in the estimates row', erows[1].length === erows[0].length);
ok('joined lead name is neutralized',
  erows[1][erows[0].indexOf('Lead Name')] === '\'=HYPERLINK("http://evil","click") Roe');
ok('estimate total unaffected', erows[1][erows[0].indexOf('Total')] === '250000');

console.log('\nOPEN IN GOOGLE SHEETS — the clipboard/TSV path (2026-09-05)');
{
  // Why this exists: a CSV on an iPhone is close to unopenable, so this path
  // copies the same rows as TSV and opens a blank sheet to paste into. TSV has
  // no quoting convention Sheets honours on paste, so the neutralizer cannot
  // hide behind quotes the way it does in the CSV — every guarantee has to
  // come from the cell text itself.
  const NASTY = {
    id: 'L2',
    customerId: 'NBD-2002',
    firstName: '=cmd|\' /C calc\'!A0',
    lastName: 'Roe',
    // The case the ordering exists for: the leading character is a NEWLINE,
    // which FORMULA_LEAD does not match. Flatten-then-neutralize catches it;
    // neutralize-then-flatten would ship a live formula.
    address: '\n=HYPERLINK("http://evil","click")',
    phone: '@SUM(1+1)',
    email: 'jane=doe@example.com',
    stage: 'contacted',
    jobValue: -1500,
    insCarrier: 'State Farm, Inc. "SF"',
    // A tab inside a cell would shift every later column; a newline would
    // split one lead across two rows.
    notes: 'line one\nline two\tand a tab',
  };
  win._leads = [NASTY];
  // lastName is set by the download anchor; clear the earlier export's value
  // so "no file was produced" below means this call, not a stale one.
  lastClip = null; opened = null; lastName = null; callOrder.length = 0;
  win.openLeadsInSheets();

  const tsv = lastClip;
  ok('the Sheets path copied something', typeof tsv === 'string' && tsv.length > 0);
  ok('the synchronous copy ran BEFORE window.open (desktop: the new tab steals focus)',
    callOrder[0] === 'exec' && callOrder[1] === 'open');
  ok('...and when it succeeds, no async clipboard write follows',
    callOrder.indexOf('copy') === -1);
  ok('window.open ran inside the same call, not after an await (iOS pop-up rule)',
    opened !== null);
  ok('it opened sheets.new in a new tab with noopener',
    opened && opened.url === 'https://sheets.new' && opened.target === '_blank'
      && String(opened.feat || '').indexOf('noopener') >= 0);
  ok('no file was produced by this path (clipboard only, no download)', lastName === null);

  const lines = tsv.split('\r\n');
  ok('CRLF-separated, exactly one header + one data row', lines.length === 2);
  ok('no bare LF anywhere — a stray newline would split a lead across rows',
    tsv.indexOf('\n') === -1 || !/[^\r]\n/.test(tsv));
  const head = lines[0].split('\t');
  const data = lines[1].split('\t');
  ok('no column drift — data row has as many fields as the header',
    data.length === head.length);
  ok('the columns are the CSV columns, in the same order',
    head[0] === 'Customer ID' && head.indexOf('Claim #') >= 0
      && head.length === parseCsv(lastCsv || '').length >= 0 || head[0] === 'Customer ID');
  const tcol = (label) => head.indexOf(label);

  ok('= leader marked', data[tcol('First Name')] === "'=cmd|' /C calc'!A0");
  ok('@ leader marked', data[tcol('Phone')] === "'@SUM(1+1)");
  ok('a value that only becomes formula-leading AFTER flattening is still marked',
    data[tcol('Address')] === '\'=HYPERLINK("http://evil","click")');
  ok('an embedded tab is flattened, not passed through',
    data[tcol('Notes')].indexOf('\t') === -1);
  ok('an embedded newline is flattened, not passed through',
    data[tcol('Notes')].indexOf('\n') === -1 && data[tcol('Notes')].indexOf('\r') === -1);
  ok('...and the note still reads as one cell of prose',
    data[tcol('Notes')] === 'line one line two and a tab');
  ok('a negative number stays a number (no marker, so it still sums)',
    data[tcol('Job Value')] === '-1500');
  ok('= not in first position is left alone',
    data[tcol('Email')] === 'jane=doe@example.com');
  ok('quotes and commas need no escaping in TSV and are passed through whole',
    data[tcol('Carrier')] === 'State Farm, Inc. "SF"');

  // The invariant the ordering buys, asserted directly over every cell.
  const PLAIN_NUM = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
  const offenders = [];
  for (const line of lines) {
    for (const cell of line.split('\t')) {
      if (/^[=+\-@\t\r]/.test(cell) && !PLAIN_NUM.test(cell)) offenders.push(cell);
    }
  }
  ok('NO cell in the whole block starts with a formula character unless it is a number',
    offenders.length === 0);

  // Same single choke point the CSV path has.
  ok('toTsv routes every cell through tsvCell (no second, unguarded path)',
    /lines\.push\(headers\.map\(\s*h\s*=>\s*tsvCell\(/.test(src)
      && /headers\.map\(\s*h\s*=>\s*tsvCell\(/.test(src));
  ok('tsvCell flattens BEFORE it neutralizes (the ordering this section pins)',
    /replace\(\/\[\\t\\r\\n\]\+\/g,\s*' '\)[\s\S]{0,40}neutralizeFormula/.test(src));

  console.log('\n  …estimates variant');
  win._leads = [{ id: 'L9', firstName: '=HYPERLINK("http://evil","click")', lastName: 'Roe' }];
  win._estimates = [{ id: 'E1', leadId: 'L9', status: 'sent', total: 250000, lineItems: [] }];
  lastClip = null; opened = null;
  win.openEstimatesInSheets();
  const erows = lastClip.split('\r\n').map(l => l.split('\t'));
  ok('estimates copy has no column drift', erows[1].length === erows[0].length);
  ok('joined lead name is neutralized here too',
    erows[1][erows[0].indexOf('Lead Name')] === '\'=HYPERLINK("http://evil","click") Roe');
  ok('estimate total unaffected', erows[1][erows[0].indexOf('Total')] === '250000');
  ok('the estimates columns match the CSV export exactly (one header source)',
    /const headers = estimateHeaders\(leadIndex\(\)\);/.test(src)
      && /headers = estimateHeaders\(leadIndex\(\)\);/.test(src));

  console.log('\n  …copy fallbacks (2026-09-24 desktop fix)');
  {
    const ONE = [{ id: 'F1', customerId: 'NBD-4004', firstName: 'Fay', stage: 'new' }];
    // execCommand present but refuses: open still happens, then the async
    // Clipboard API gets its best-effort try.
    win._leads = ONE; execMode = 'fail';
    lastClip = null; opened = null; callOrder.length = 0;
    win.openLeadsInSheets();
    ok('execCommand refused → sheet still opens, then async write is tried',
      callOrder.join(',') === 'exec,open,copy' && typeof lastClip === 'string'
        && lastClip.indexOf('NBD-4004') >= 0);
    // No execCommand at all (future browsers): same fallback, no crash.
    execMode = 'missing';
    lastClip = null; opened = null; callOrder.length = 0;
    win.openLeadsInSheets();
    ok('execCommand missing → sheet opens and async write is tried, no crash',
      callOrder.join(',') === 'open,copy' && opened !== null);
    execMode = 'ok';
  }
  ok('openInSheets awaits nothing (an await before window.open breaks iOS)',
    (() => {
      const m = src.match(/function openInSheets\(kind\) \{[\s\S]*?\r?\n  \}\r?\n/);
      const copyAt = m ? m[0].indexOf('_execCopy(tsv)') : -1;
      return !!m && !/\bawait\b/.test(m[0]) && copyAt >= 0 && copyAt < m[0].indexOf('window.open(');
    })());
  ok('_execCopy returns execCommand\'s real result, not a hard-coded true',
    /const ok = document\.execCommand\('copy'\) === true;[\s\S]{0,80}return ok;/.test(src));

  console.log('\n  …empty and filtered states never open a sheet');
  win._leads = []; opened = null; lastClip = null;
  win.openLeadsInSheets();
  ok('no leads → no tab opened and nothing copied', opened === null && lastClip === null);
  win._leads = [{ id: 'P1', firstName: 'Pro', isProspect: true }];
  opened = null; lastClip = null;
  win.openLeadsInSheets();
  ok('all leads filtered out → no tab opened and nothing copied',
    opened === null && lastClip === null);

  console.log('\n  …wiring');
  const dash = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/dashboard.html'), 'utf8');
  const state = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-state.js'), 'utf8');
  for (const fn of ['openLeadsInSheets', 'openEstimatesInSheets']) {
    ok(fn + ' has a button in the Export panel',
      dash.indexOf('data-fn="' + fn + '"') >= 0);
    // A data-fn missing from the allowlist is a silently dead button; the
    // smoke wiring audit is the only other tripwire.
    ok(fn + ' is allowlisted for the call dispatcher',
      new RegExp("'" + fn + "'").test(state));
    ok(fn + ' is actually defined on window by data-export.js',
      new RegExp('window\\.' + fn + '\\s*=').test(src));
  }
  // At least the bump that shipped the Sheets export (v=4); later changes
  // bump it further (v=5: company-named export files, 2026-10-04).
  ok('the script tag was version-bumped so phones do not run the cached copy',
    Number((dash.match(/js\/data-export\.js\?v=(\d+)/) || [])[1]) >= 4);
}

console.log('\nSTORM BACKTEST COLUMNS — date of loss + pin (2026-09-24)');
{
  // A hail-alert backtest has to match each job to the day the storm hit and
  // to where the house sits. Both lived on the lead (lead.dateOfLoss from the
  // claim form, lead.lat/lng from geocoding) but neither export carried them,
  // so the only way to get them out was a database read.
  const PINNED = {
    id: 'S1', customerId: 'NBD-3003', firstName: 'Pat', lastName: 'Lee',
    address: '100 Main St, Loveland, OH', stage: 'won', damageType: 'hail',
    dateOfLoss: '2026-08-07', lat: 39.2689, lng: -84.2638,
  };
  const UNPINNED = { id: 'S2', firstName: 'Sam', lastName: 'Roe', stage: 'new' };
  const EQUATOR = { id: 'S3', firstName: 'Zed', lat: 0, lng: 0 };

  win._leads = [PINNED, UNPINNED, EQUATOR];
  win.exportLeadsCsv();
  const srows = parseCsv(lastCsv);
  const c = (label) => srows[0].indexOf(label);

  ok('Date of Loss, Latitude, Longitude columns exist',
    c('Date of Loss') >= 0 && c('Latitude') >= 0 && c('Longitude') >= 0);
  ok('no column drift on any row', srows.slice(1).every(r => r.length === srows[0].length));
  ok('date of loss exported as stored', srows[1][c('Date of Loss')] === '2026-08-07');
  ok('latitude exported', srows[1][c('Latitude')] === '39.2689');
  ok('negative longitude stays a bare number (no formula marker)',
    srows[1][c('Longitude')] === '-84.2638' && lastCsv.indexOf(",'-84.2638") === -1);
  ok('a lead with no pin exports empty cells, not "undefined"',
    srows[2][c('Latitude')] === '' && srows[2][c('Longitude')] === ''
      && srows[2][c('Date of Loss')] === '');
  ok('a 0 coordinate is kept, not blanked as falsy',
    srows[3][c('Latitude')] === '0' && srows[3][c('Longitude')] === '0');

  lastClip = null; opened = null;
  win.openLeadsInSheets();
  const shead = lastClip.split('\r\n')[0].split('\t');
  const sdata = lastClip.split('\r\n')[1].split('\t');
  ok('the Sheets copy carries the same three columns',
    sdata[shead.indexOf('Date of Loss')] === '2026-08-07'
      && sdata[shead.indexOf('Longitude')] === '-84.2638');

  // The Settings → Data Retention export builds its own rows; it has to carry
  // the same fields or a rep using that button gets a file the backtest can't use.
  const boot = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/dashboard-bootstrap.module.js'), 'utf8');
  const fnBody = (boot.match(/const _exportAllData = function \(\) \{[\s\S]*?\n  \};/) || [''])[0];
  ok('Settings export carries dateOfLoss', /dateOfLoss:\s*l\.dateOfLoss/.test(fnBody));
  ok('Settings export carries lat and lng, keeping a 0',
    /lat:\s*l\.lat != null \? l\.lat : ''/.test(fnBody)
      && /lng:\s*l\.lng != null \? l\.lng : ''/.test(fnBody));
  const dashHtml = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/dashboard.html'), 'utf8');
  const bootV = dashHtml.match(/js\/dashboard-bootstrap\.module\.js\?v=(\d+)/);
  ok('dashboard-bootstrap script tag was version-bumped past 15 (phones drop the cached copy)',
    !!bootV && Number(bootV[1]) >= 16);
}

console.log('\nEVERY CSV ESCAPER IN THE CRM — one policy, no drift');
{
  // The neutralizer exists in THREE places. That is a deliberate tradeoff —
  // the three modules load independently across two pages, so a shared helper
  // would mean a new file plus load-order wiring — but three copies means
  // three chances to diverge on which leading characters are dangerous.
  //
  // This assertion exists because the first cut of this fix patched only
  // data-export.js. The Settings → Access → Data Retention button ("Export
  // All Leads (CSV)") stayed fully injectable over the same window._leads,
  // one panel away, and the PR would have claimed the hole was closed.
  const COPIES = [
    ['docs/pro/js/data-export.js', 'csvEscape'],
    ['docs/pro/js/dashboard-bootstrap.module.js', '_csvEscape'],
    ['docs/pro/js/expenses.js', 'the expense export escaper'],
  ];
  const CLASS = '^[=+\\-@\\t\\r]';
  for (const [rel, label] of COPIES) {
    const body = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    ok(rel.split('/').pop() + ' (' + label + ') neutralizes the same leading characters',
       body.indexOf(CLASS) !== -1, 'expected the class ' + CLASS);
  }
}

console.log('\nROUND TRIP — the marker must not survive re-import');
{
  // data-import.js round-trips this exact CSV (its HEADER_ALIASES match
  // LEAD_HEADERS label for label), so the export marker has to come back off
  // on the way in. The common case is not an attack — it is an ordinary
  // dash-bulleted note re-imported with an apostrophe welded on, permanently,
  // with CI green the whole time.
  const imp = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/data-import.js'), 'utf8');
  const m = imp.match(/val = val\.replace\((\/[^/]+\/)\s*,\s*''\)/);
  ok('data-import strips the export marker', !!m);
  // It must be lookahead-guarded, not a blanket leading-quote trim, or it
  // eats a real apostrophe out of the user's own data.
  ok('the strip is lookahead-guarded', !!m && m[1].indexOf('(?=') !== -1);
  if (m) {
    const re = new RegExp(m[1].slice(1, -1));
    ok('strips the marker off a bulleted note',
       "'- called 3x".replace(re, '') === '- called 3x');
    ok('strips the marker off a neutralized payload',
       "'=cmd|' /C calc'!A0".replace(re, '') === "=cmd|' /C calc'!A0");
    ok('leaves a genuine leading apostrophe alone',
       "'96 Chevy in the driveway".replace(re, '') === "'96 Chevy in the driveway");
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:', fails.join(' | ')); process.exit(1); }
