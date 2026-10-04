/* portal-progress-steps-2026-10-03.test.js
 *
 * The homeowner portal's progress tracker, rebuilt from 5 steps to 9
 * (functions/homeowner-progress.js).
 *
 * The defect it replaces: the old 5th step read "Complete — final
 * walkthrough done" and opened the rating + refer-a-friend cards from
 * final_photos on, i.e. while the homeowner still owed the final invoice.
 * Now: Inspection → Estimate → Signed → Build day set → Build → Final
 * walkthrough → Final payment → Warranty → Review, and the review ask waits
 * for PAID IN FULL.
 *
 * Runs the real module (it is pure) and lifts the client's pure helpers
 * from docs/pro/js/portal.js with vm. Covers:
 *   1. every crm-stages.js stage key (and every legacy display stage) maps
 *   2. payment / review gating
 *   3. the build-day date display
 *   4. the wording constant: Jo's draft, KY insurance law, subcontractor
 *      crews, and "one place" (no tracker copy anywhere else)
 *   5. the wiring in functions/portal.js and the client
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const HP = require(path.join(ROOT, 'functions', 'homeowner-progress.js'));
const PORTAL_FN = read('functions/portal.js');
const PORTAL = read('docs/pro/js/portal.js');
const STAGES_SRC = read('docs/pro/js/crm-stages.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

// Line-wise comment strip (a /*...*/ regex eats code in these files — see
// portal-refer-gate.test.js).
const code = (s) => s.split('\n').filter((l) => {
  const t = l.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}).join('\n');

const R = (lead, invoices, repName) => HP.resolveHomeownerProgress(lead, { invoices: invoices || [], repName });
const STEP_KEYS = HP.HOMEOWNER_PROGRESS_COPY.steps.map((s) => s.key);

/* ══════════════════════════════════════════════════════════════════
   1. Mapping completeness
   ══════════════════════════════════════════════════════════════════ */
function objectBlock(src, decl) {
  const a = src.indexOf(decl);
  if (a < 0) return null;
  const b = src.indexOf('\n};', a);
  return b < 0 ? null : src.slice(a, b);
}
const sBlock = objectBlock(STAGES_SRC, 'export const S = {');
const crmKeys = sBlock ? [...code(sBlock).matchAll(/^\s*[A-Z_]+:\s*'([a-z_]+)'/gm)].map((m) => m[1]) : [];
const legacyBlock = objectBlock(STAGES_SRC, 'export const LEGACY_MAP = {');
const legacyNames = legacyBlock ? [...code(legacyBlock).matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]) : [];
const stageRoles = read('functions/stage-roles.js');
const aliasBlock = stageRoles.slice(stageRoles.indexOf('const ALIAS = {'), stageRoles.indexOf('};', stageRoles.indexOf('const ALIAS = {')));
const aliasNames = [...aliasBlock.matchAll(/'([^']+)':\s*'/g)].map((m) => m[1]);

group('Every crm-stages.js stage key maps to a step', () => {
  assert('read the stage keys out of crm-stages.js S (sanity: 30+ keys, includes lost + collections)',
    crmKeys.length >= 30 && crmKeys.includes('lost') && crmKeys.includes('collections'),
    'got ' + crmKeys.length + ': ' + crmKeys.join(','));
  const unmapped = crmKeys.filter((k) => !HP.STAGE_TO_STEP[k]);
  assert('no crm-stages.js key is unmapped', unmapped.length === 0,
    'add these to STAGE_TO_STEP in functions/homeowner-progress.js: ' + unmapped.join(', '));
  const badTargets = Object.entries(HP.STAGE_TO_STEP).filter(([, v]) => !STEP_KEYS.includes(v));
  assert('every mapped stage lands on a real step', badTargets.length === 0, JSON.stringify(badTargets));
  const extra = Object.keys(HP.STAGE_TO_STEP).filter((k) => !crmKeys.includes(k));
  assert('the map carries no stage crm-stages.js does not define', extra.length === 0, extra.join(', '));
});

group('Every legacy display stage resolves to a mapped key', () => {
  assert('read LEGACY_MAP (sanity: includes Complete + Closed Lost)',
    legacyNames.includes('Complete') && legacyNames.includes('Closed Lost'), legacyNames.join(','));
  assert('read the stage-roles.js ALIASes (sanity: includes Won)', aliasNames.includes('Won'), aliasNames.join(','));
  const names = [...new Set(legacyNames.concat(aliasNames))];
  const bad = names.filter((n) => !HP.stageKeyFor({ stage: n }) || !HP.STAGE_TO_STEP[HP.stageKeyFor({ stage: n })]);
  assert('all ' + names.length + ' legacy names resolve', bad.length === 0, bad.join(', '));
  assert('"Complete" is closed, "Closed Lost" is lost, "In Progress" is the build',
    HP.stageKeyFor({ stage: 'Complete' }) === 'closed'
      && HP.stageKeyFor({ stage: 'Closed Lost' }) === 'lost'
      && R({ stage: 'In Progress' }).currentKey === 'build');
  assert('matching is case-insensitive ("closed won")', HP.stageKeyFor({ stage: 'closed won' }) === 'closed');
});

group('Where each kind of lead lands', () => {
  const at = (stage, extra) => R(Object.assign({ stage }, extra || {})).currentKey;
  assert('new / contacted → Inspection, still upcoming',
    at('new') === 'inspection' && R({ stage: 'new' }).pending === true && R({ stage: 'contacted' }).pending === true);
  assert('inspected → Inspection, reached', at('inspected') === 'inspection' && R({ stage: 'inspected' }).pending === false);
  assert('insurance stages before a number → Inspection (as before)',
    at('claim_filed') === 'inspection' && at('adjuster_meeting_scheduled') === 'inspection');
  assert('insurance stages with a number → Estimate (as before)',
    ['adjuster_inspection_done', 'scope_received', 'estimate_submitted', 'supplement_requested', 'supplement_approved']
      .every((s) => at(s) === 'estimate'));
  assert('cash / finance → Estimate', ['estimate_sent_cash', 'negotiating', 'prequal_sent', 'loan_approved'].every((s) => at(s) === 'estimate'));
  assert('contract through materials, no date → Signed',
    ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered', 'materials_delivered'].every((s) => at(s) === 'signed'));
  assert('materials delivered is NOT "the crew is working" (it was "install" before)', at('materials_delivered') !== 'build');
  assert('crew_scheduled → Build day set', at('crew_scheduled') === 'scheduled');
  assert('install_in_progress → Build (in progress, not counted done)',
    at('install_in_progress') === 'build' && R({ stage: 'install_in_progress' }).pending === true);
  assert('install_complete / final_photos → Final walkthrough',
    at('install_complete') === 'walkthrough' && at('final_photos') === 'walkthrough');
});

group('Lost and closed-lost keep today\'s behaviour', () => {
  // The old tracker put a lost lead on its first step via the role fallback
  // ('lost' role → 'inspected'). Same position now; never a money or review step.
  ['lost', 'Lost', 'Closed Lost'].forEach((stage) => {
    const r = R({ stage });
    assert('"' + stage + '" → Inspection, not paid, no pay link to anything', r.currentKey === 'inspection' && r.paidInFull === false);
  });
  assert('a lost lead with a paid invoice is still not "paid in full" (no review ask)',
    R({ stage: 'lost', stageRole: 'lost' }, [{ balanceDue: 0, status: 'paid' }]).paidInFull === false);
});

/* ══════════════════════════════════════════════════════════════════
   2. Payment / review gating
   ══════════════════════════════════════════════════════════════════ */
group('Unpaid never reaches Review', () => {
  const owed = [{ balanceDue: 4200, status: 'sent' }];
  const r1 = R({ stage: 'final_photos' }, owed);
  assert('unpaid final_photos → Final walkthrough, NOT review (the reported defect)',
    r1.currentKey === 'walkthrough' && r1.paidInFull === false, JSON.stringify(r1));
  assert('final_photos with no invoice at all is not paid either', R({ stage: 'final_photos' }).paidInFull === false);
  const r2 = R({ stage: 'final_payment' }, owed);
  assert('final_payment with money still owed → Final payment, current, unpaid',
    r2.currentKey === 'payment' && r2.pending === true && r2.paidInFull === false);
  assert('…and its sentence is "Your final invoice is ready."', r2.currentBlurb === 'Your final invoice is ready.');
  const r3 = R({ stage: 'closed' }, owed);
  assert('even "closed" with money owed is unpaid', r3.currentKey === 'payment' && !r3.paidInFull);
  assert('collections is unpaid even when no invoice is in the system',
    R({ stage: 'collections' }).currentKey === 'payment' && R({ stage: 'collections' }).paidInFull === false);
  assert('deductible_collected with nothing invoiced stays at the walkthrough (money step not started)',
    R({ stage: 'deductible_collected' }).currentKey === 'walkthrough');
  assert('deductible_collected with an open invoice → Final payment',
    R({ stage: 'deductible_collected' }, owed).currentKey === 'payment');
  assert('one owed invoice among paid ones still blocks it',
    R({ stage: 'final_payment' }, [{ balanceDue: 0 }, { balanceDue: 1 }]).paidInFull === false);
});

group('Paid in full opens Review', () => {
  const r = R({ stage: 'final_payment' }, [{ balanceDue: 0, status: 'paid' }]);
  assert('final_payment, nothing owed → Review, paid', r.currentKey === 'review' && r.paidInFull === true);
  assert('the paid line is "Paid in full — thank you."', r.paidLine === 'Paid in full — thank you.');
  assert('Review asks "How did we do?" and is pending until rated', r.currentBlurb === 'How did we do?' && r.pending === true);
  assert('closed with no invoice in the system → paid (unchanged for old jobs)', R({ stage: 'closed' }).paidInFull === true);
  const rated = R({ stage: 'closed', customerRating: 5, warranty: { tier: 'preferred' } });
  assert('rated + warranty on file → every step done', rated.doneCount === 9 && rated.total === 9 && rated.pending === false,
    JSON.stringify({ d: rated.doneCount, t: rated.total }));
  const noCert = R({ stage: 'closed' });
  assert('no warranty cert → the Warranty step is skipped, not shown done',
    noCert.steps.find((s) => s.key === 'warranty').state === 'skipped' && noCert.total === 8, JSON.stringify(noCert.steps));
  assert('paidInFullFor is the same answer as the resolver',
    HP.paidInFullFor({ stage: 'closed' }, []) === true && HP.paidInFullFor({ stage: 'final_photos' }, []) === false);
  // The shared owed rule (functions/invoice-owed.js, #2112/#2131): a draft
  // was never sent — e.g. the server's draft deposit invoice on a signed
  // contract — so it owes nothing; void / cancelled / deleted neither.
  const draft = { status: 'draft', balanceDue: 15000, total: 15000 };
  assert('a DRAFT with a balance does not owe (drafts were never sent)', HP.invoiceOwes(draft) === false);
  assert('void / cancelled / deleted with a balance do not owe; sent and partial do',
    !HP.invoiceOwes({ status: 'void', balanceDue: 10 }) && !HP.invoiceOwes({ status: 'Cancelled', balanceDue: 10 })
      && !HP.invoiceOwes({ status: 'sent', balanceDue: 10, deleted: true })
      && HP.invoiceOwes({ status: 'sent', balanceDue: 10 }) && HP.invoiceOwes({ status: 'partial', balanceDue: 10 }));
  assert('a draft never holds back paid in full, and never becomes the Final payment step',
    R({ stage: 'final_payment' }, [draft]).paidInFull === true
      && R({ stage: 'deductible_collected' }, [draft]).currentKey === 'walkthrough');
  assert('…but a sent invoice beside the draft still does',
    R({ stage: 'final_payment' }, [draft, { status: 'sent', balanceDue: 2000 }]).paidInFull === false);
  assert('the module uses invoice-owed.js, not its own status list',
    /require\('\.\/invoice-owed'\)/.test(read('functions/homeowner-progress.js'))
      && !/['"]draft['"]/.test(code(read('functions/homeowner-progress.js'))));
  assert('an invoice with a negative/zero/blank balance does not owe',
    !HP.invoiceOwes({ balanceDue: 0 }) && !HP.invoiceOwes({ balanceDue: -5 }) && !HP.invoiceOwes({}) && HP.invoiceOwes({ balanceDue: '12.50' }));
});

group('Step states and counts are coherent', () => {
  const r = R({ stage: 'crew_scheduled', scheduledDate: '2026-10-12' });
  assert('steps before current are done, current is current, after is upcoming',
    r.steps.slice(0, 3).every((s) => s.state === 'done') && r.steps[3].state === 'current'
      && r.steps.slice(4).every((s) => s.state === 'upcoming'), JSON.stringify(r.steps));
  assert('a reached current step counts as done (4 of 9)', r.doneCount === 4 && r.total === 9);
  assert('a pending current step does not (new lead: 0 of 9)', R({ stage: 'new' }).doneCount === 0);
  assert('next step is named', r.nextLabel === 'Build' && R({ stage: 'new' }).nextLabel === 'Estimate');
});

/* ══════════════════════════════════════════════════════════════════
   3. The build-day date
   ══════════════════════════════════════════════════════════════════ */
group('Build day set shows the date when there is one', () => {
  const withDate = R({ stage: 'crew_scheduled', scheduledDate: '2026-10-12' });
  assert('with a date: "Your build day: {date}." (filled in the reader\'s timezone)',
    withDate.currentBlurb === 'Your build day: {date}.', withDate.currentBlurb);
  const noDate = R({ stage: 'crew_scheduled' });
  assert('without one: "We\'ll confirm your build day soon."', noDate.currentBlurb === 'We\'ll confirm your build day soon.');
  assert('a malformed date counts as no date', R({ stage: 'crew_scheduled', scheduledDate: '10/12/2026' }).currentBlurb === 'We\'ll confirm your build day soon.');
  assert('a signed job with a date on the lead is at Build day set',
    R({ stage: 'contract_signed', scheduledDate: '2026-10-12' }).currentKey === 'scheduled');
  assert('the server ships the raw date alongside it', /scheduledDate: \/\^\\d\{4\}/.test(PORTAL_FN));
});

function lift(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) return null;
  const b = src.indexOf(end, a);
  return b < 0 ? null : src.slice(a, b + end.length);
}
const helperSrc = [
  lift(PORTAL, 'function _buildDayLabel(ymd) {', '\n  }\n'),
  lift(PORTAL, 'function _fillCopy(text, vars) {', '\n  }\n'),
  lift(PORTAL, 'function _progressBlurb(text, scheduledDate) {', '\n  }\n'),
  lift(PORTAL, 'function _progressSteps(milestones, idx) {', '\n  }\n'),
];
group('The client fills {date} correctly', () => {
  assert('found the four client helpers', helperSrc.every(Boolean));
});
if (helperSrc.every(Boolean)) {
  const ctx = { Date, String, Number, Object, Array };
  vm.createContext(ctx);
  vm.runInContext(helperSrc.join('\n') + '\nthis.__b = _progressBlurb; this.__d = _buildDayLabel; this.__s = _progressSteps; this.__f = _fillCopy;', ctx);
  group('…behaviour', () => {
    const line = ctx.__b('Your build day: {date}.', '2026-10-12');
    assert('2026-10-12 reads as Monday, October 12 — the local day, not UTC\'s day before',
      /Monday/.test(line) && /October/.test(line) && /12/.test(line) && !/\{date\}/.test(line), line);
    assert('a bad date drops the sentence rather than printing {date} or Invalid Date',
      ctx.__b('Your build day: {date}.', '2026-02-30') === '' && ctx.__b('Your build day: {date}.', null) === '');
    assert('a sentence without {date} passes through', ctx.__b('The crew is working on your home.', null) === 'The crew is working on your home.');
    assert('{done} of {total} fills', ctx.__f('{done} of {total} done', { done: 4, total: 9 }) === '4 of 9 done');
    const legacy = ctx.__s([{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }], 1);
    assert('an old 5-step payload with no states is derived from currentIndex',
      legacy.map((s) => s.state).join() === 'done,current,upcoming');
  });
}

/* ══════════════════════════════════════════════════════════════════
   4. The wording constant
   ══════════════════════════════════════════════════════════════════ */
group('The constant is Jo\'s draft, verbatim', () => {
  const want = [
    ['inspection', 'Inspection', '{rep} has looked at your roof.', '{rep} will come out and look at your roof.'],
    ['estimate', 'Estimate', 'You have a written quote.'],
    ['signed', 'Signed', 'You\'re signed. Next: getting you on the schedule.'],
    ['scheduled', 'Build day set', 'Your build day: {date}.', 'We\'ll confirm your build day soon.'],
    ['build', 'Build', 'The crew is working on your home.'],
    ['walkthrough', 'Final walkthrough', 'Done. {rep} walks the job with you and sends your final photos.'],
    ['payment', 'Final payment', 'Your final invoice is ready.'],
    ['warranty', 'Warranty', 'Your warranty paperwork is on file.'],
    ['review', 'Review', 'How did we do?'],
  ];
  const steps = HP.HOMEOWNER_PROGRESS_COPY.steps;
  assert('nine steps, in order', steps.map((s) => s.key).join() === want.map((w) => w[0]).join());
  want.forEach(([k, label, blurb, upcoming], i) => {
    const s = steps[i];
    assert(k + ': "' + label + '" / "' + blurb + '"' + (upcoming ? ' / "' + upcoming + '"' : ''),
      s.label === label && s.blurb === blurb && (!upcoming || s.upcoming === upcoming), JSON.stringify(s));
  });
  assert('paid wording: "Paid in full — thank you."', steps[6].paid === 'Paid in full — thank you.');
  assert('the constant is frozen (nothing mutates the copy at runtime)',
    Object.isFrozen(HP.HOMEOWNER_PROGRESS_COPY) && Object.isFrozen(steps) && Object.isFrozen(steps[0]));
  assert('{rep} → the rep\'s first name ("Joe has looked at your roof.")',
    R({ stage: 'inspected' }, [], 'Joe Deal').currentBlurb === 'Joe has looked at your roof.');
  assert('{rep} with no rep name → "Your rep", never a blank or "{rep}"',
    R({ stage: 'new' }, [], '').currentBlurb === 'Your rep will come out and look at your roof.'
      && R({ stage: 'new' }, [], 'Your Rep').currentBlurb === 'Your rep will come out and look at your roof.');
});

group('Kentucky insurance-job law + subcontractor wording scan', () => {
  const all = JSON.stringify(HP.HOMEOWNER_PROGRESS_COPY);
  const banned = [
    [/\bhandl/i, '"handle" (we handle your claim)'],
    [/negotiat/i, '"negotiate"'],
    [/\bmanag/i, '"manage"'],
    [/\bclaim/i, 'any claim talk'],
    [/deductib/i, 'deductibles'],
    [/\bwaiv/i, '"waive"'],
    [/insur/i, 'insurance'],
    [/adjuster/i, 'adjusters'],
    [/employee/i, '"employees"'],
    [/in-house|in house/i, '"in-house"'],
    [/our (team|staff|guys)/i, '"our team/staff"'],
  ];
  banned.forEach(([re, what]) => {
    const m = all.match(re);
    assert('no ' + what, !m, m && ('found "' + m[0] + '" in HOMEOWNER_PROGRESS_COPY'));
  });
  assert('the scan is not vacuous (the constant serialises to real text)', all.length > 600 && /crew/.test(all));
});

group('One constant: no tracker wording anywhere else', () => {
  const phrases = ['Build day set', 'Final walkthrough', 'Paid in full', 'Your build day', 'has looked at your roof',
    'confirm your build day', 'warranty paperwork is on file', 'Your final invoice is ready', 'of {total} done'];
  const fnCode = code(PORTAL_FN);
  const clientCode = code(PORTAL);
  const leaks = phrases.filter((p) => fnCode.includes(p) || clientCode.includes(p));
  assert('functions/portal.js and docs/pro/js/portal.js carry none of it', leaks.length === 0, leaks.join(' | '));
  assert('the old 5-step copy is gone', !/final walkthrough done/i.test(fnCode + clientCode) && !/key: 'complete'/.test(fnCode));
  assert('the client renders the UI strings from progress.copy', /const copy = p\.copy \|\| \{\};/.test(PORTAL));
});

/* ══════════════════════════════════════════════════════════════════
   5. Wiring
   ══════════════════════════════════════════════════════════════════ */
group('Server wiring', () => {
  const fn = code(PORTAL_FN);
  assert('the view sends the copy and the step states', /copy:\s+HOMEOWNER_PROGRESS_COPY\.ui,/.test(fn) && /milestones:\s+hp\.steps,/.test(fn));
  assert('the pay link is the EXISTING rep-sent link, only on an unpaid Final payment step',
    /if \(hp\.currentKey === 'payment' && hp\.pending && _balance && _balance\.stripePaymentLink\) \{\s*progress\.payLink = _balance\.stripePaymentLink;/.test(fn));
  assert('no Stripe call was added to the view', !/paymentLinks\.create/.test(fn.slice(fn.indexOf('exports.getHomeownerPortalView'), fn.indexOf('exports.', fn.indexOf('exports.getHomeownerPortalView') + 10))));
  assert('the balance card and the payment step share one "owes" predicate', /tenantInvoices\s*\n?\s*\.filter\(invoiceOwes\)/.test(fn));
});

group('Client wiring', () => {
  const c = code(PORTAL);
  assert('the pay button only renders from progress.payLink through safeUrl',
    /if \(p\.payLink && safeUrl\(p\.payLink\) && copy\.payLink\) \{/.test(c));
  assert('the review link only renders with the rating card (canRate, not yet rated)',
    /p\.currentKey === 'review' && ratingInfoP\.canRate && !ratingInfoP\.submitted/.test(c));
  assert('the full list is a native <details> (no script, no handler)', /<details class="progress-all">/.test(c) && /<summary>/.test(c));
  const blockRaw = PORTAL.slice(PORTAL.indexOf('// ── Project progress tracker ──'), PORTAL.indexOf('// B6 — Reorder'));
  assert('the tracker render carries no inline style and no on*= handler',
    blockRaw.length > 1000 && !/style="/.test(blockRaw) && !/\son[a-z]+=/.test(blockRaw), 'block ' + blockRaw.length);
  assert('the referral card waits for the same paid-in-full flag', /const jobComplete = !!\(view\.rating && view\.rating\.canRate === true\);/.test(c));
  assert('(sanity) the sliced render block is the real one', /progress-card/.test(blockRaw) && /parts\.push\(/.test(blockRaw));
});

group('Phone layout: 44px targets in the stylesheet', () => {
  const html = read('docs/pro/portal.html').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => { const i = html.indexOf(sel + '{'); return i < 0 ? '' : html.slice(i, html.indexOf('}', i)); };
  assert('the <summary> is at least 44px tall', /min-height:44px/.test(rule('  .progress-all > summary')));
  assert('each list row is at least 44px tall', /min-height:44px/.test(rule('  .progress-item')));
  assert('the action buttons are at least 44px tall', /min-height:44px/.test(rule('  .progress-action')));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
