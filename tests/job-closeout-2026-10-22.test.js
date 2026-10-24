#!/usr/bin/env node
/**
 * Finished-job check card (2026-10-22): docs/pro/js/job-closeout.js.
 * Pure evaluate() with positive + negative controls, the render in a vm
 * sandbox, and the wiring (panel, script, hooks) that makes it appear.
 *
 * Run: node tests/job-closeout-2026-10-22.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const C = require(path.join(ROOT, 'docs/pro/js/job-closeout.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const st = (r, k) => r.rows.filter((x) => x.key === k)[0].state;

console.log('evaluate');
const all = C.evaluate({ warrantyCertFiledAt: 1, reviewRequested: true },
  { photos: [{ phase: 'After' }], invoices: [{ status: 'sent' }], paidInFull: true });
ok('everything done = complete, 5 of 5', all.complete && all.done === 5 && all.next === null);
const none = C.evaluate({}, { photos: [{ phase: 'before' }], invoices: [{ status: 'draft' }], paidInFull: false });
ok('negative control: nothing done = 0 of 5', none.done === 0 && !none.complete);
ok('a Before photo is not an After photo', st(none, 'photos') === 'todo');
ok('a draft invoice is not a final invoice', st(none, 'invoice') === 'todo');
ok('void/cancelled invoices do not count', st(C.evaluate({}, { photos: [], invoices: [{ status: 'void' }, { status: 'cancelled' }] }), 'invoice') === 'todo');
ok('deleted invoice does not count', st(C.evaluate({}, { photos: [], invoices: [{ status: 'sent', deleted: true }] }), 'invoice') === 'todo');
ok('paid needs paidInFull === true, not truthy', st(C.evaluate({}, { photos: [], invoices: [], paidInFull: 'yes' }), 'paid') === 'todo');
ok('not-loaded photos/invoices are unknown, never done', st(C.evaluate({}, {}), 'photos') === 'unknown' && st(C.evaluate({}, {}), 'invoice') === 'unknown' && st(C.evaluate({}, {}), 'paid') === 'unknown');
ok('warranty row reads warrantyCertFiledAt only', st(C.evaluate({ warrantyCertFiledAt: 1 }, {}), 'warranty') === 'done' && st(C.evaluate({ warranty: { tier: 'good' } }, {}), 'warranty') === 'todo');
ok('review row: reviewRequested or reviewRequestedAt', st(C.evaluate({ reviewRequestedAt: 5 }, {}), 'review') === 'done' && st(C.evaluate({}, {}), 'review') === 'todo');
ok('next is the first todo row, in order', none.next && none.next.key === 'photos');
ok('null lead and null ctx do not throw', C.evaluate(null, null).total === 5);

console.log('isFinishedJob');
['install_complete', 'final_payment', 'closed', 'Complete'].forEach((s) => ok('finished: ' + s, C.isFinishedJob({ stage: s })));
['new', 'estimate_sent', 'approved', 'scheduled'].forEach((s) => ok('not finished: ' + s, !C.isFinishedJob({ stage: s })));
ok('custom won stage counts via stageRole', C.isFinishedJob({ stage: 'my_custom', stageRole: 'won' }));
ok('deleted lead is not finished', !C.isFinishedJob({ stage: 'closed', deleted: true }));

console.log('render');
function sandbox(lead, extra) {
  const panel = { innerHTML: '', hidden: true, handlers: {}, addEventListener(n, f) { this.handlers[n] = f; } };
  const win = Object.assign({
    document: { getElementById: (id) => (id === 'closeoutPanel' ? panel : null) },
    _currentLead: lead,
    _customerPhotos: [{ phase: 'after' }],
    NBDRevenue: { cached: () => [{ leadId: 'L1', status: 'sent', balanceDue: 0 }] },
    ReviewEngine: { paidInFullFor: () => true }
  }, extra || {});
  win.window = win;
  vm.runInNewContext(read('docs/pro/js/job-closeout.js'), win);
  return { win, panel };
}
let s = sandbox({ id: 'L1', stage: 'closed', warrantyCertFiledAt: 1, reviewRequested: true });
s.win.JobCloseout.render();
ok('finished job renders the card with All done', s.panel.hidden === false && /All done/.test(s.panel.innerHTML));
s = sandbox({ id: 'L1', stage: 'closed' });
s.win.JobCloseout.render();
ok('missing warranty shows its hint', /Generate the warranty certificate/.test(s.panel.innerHTML) && /2 of 5|3 of 5/.test(s.panel.innerHTML));
s = sandbox({ id: 'L1', stage: 'approved' });
s.win.JobCloseout.render();
ok('negative control: unfinished job hides the card', s.panel.hidden === true && s.panel.innerHTML === '');
s = sandbox({ id: 'L1', stage: 'closed' }, { _customerPhotos: [] });
s.win.JobCloseout.render();
ok('empty photos before load = unknown, not a false todo', !/Upload the After set/.test(s.panel.innerHTML));
s.win.JobCloseout.render(null, { photosLoaded: true });
ok('empty photos after load = todo', /Upload the After set/.test(s.panel.innerHTML));
s = sandbox({ id: 'L1', stage: 'closed' }, { NBDRevenue: { cached: () => null } });
s.win.JobCloseout.render();
ok('invoice cache not loaded = unknown, no hint, no false paid', !/Create and send the final invoice/.test(s.panel.innerHTML));
s = sandbox({ id: 'L1', stage: 'closed', firstName: '<img src=x onerror=1>' });
s.win.JobCloseout.render();
ok('no lead text reaches the markup', !/<img/.test(s.panel.innerHTML));

s = sandbox({ id: 'L1', stage: 'closed', warrantyCertFiledAt: 1 });
s.win.JobCloseout.render();
ok('each row states done / to do in text for screen readers', /Done: <\/span>Warranty/.test(s.panel.innerHTML) && /To do: <\/span>Review asked/.test(s.panel.innerHTML));
console.log('warranty prompt');
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));
const copy = C.WARRANTY_PROMPT.title + ' ' + C.WARRANTY_PROMPT.steps.join(' ');
ok('credentials are exactly the two NBD holds', JSON.stringify(C.CREDENTIALS) === JSON.stringify(['GAF Certified #1162011', 'TAMKO Pro Gold #181382']));
ok('prompt names both real credentials', /GAF Certified #1162011/.test(copy) && /TAMKO Pro Gold #181382/.test(copy));
ok('prompt never names IKO, Owens Corning, Master Elite, Golden/Silver Pledge', !/\bIKO\b|Owens Corning|Master Elite|Golden Pledge|Silver Pledge/i.test(copy));
ok('prompt never says in-house, W2 or employee', !/in-house|\bW-?2\b|employee/i.test(copy));
ok('prompt says nothing is filed or sent for the rep', /nothing is filed or sent/i.test(copy));
ok('prompt passes the claim-wording filter untouched', CW.scanText(copy).length === 0);
s = sandbox({ id: 'L1', stage: 'closed' });
s.win.JobCloseout.render();
ok('warranty open: prompt shown', /Register the warranty/.test(s.panel.innerHTML) && /GAF Certified #1162011/.test(s.panel.innerHTML));
s = sandbox({ id: 'L1', stage: 'closed', warrantyCertFiledAt: 1 });
s.win.JobCloseout.render();
ok('negative control: warranty filed, no prompt', !/Register the warranty/.test(s.panel.innerHTML));
s = sandbox({ id: 'L1', stage: 'approved' });
s.win.JobCloseout.render();
ok('negative control: unfinished job, no prompt', !/Register the warranty/.test(s.panel.innerHTML));

console.log('wiring');
const html = read('docs/pro/customer.html');
ok('customer.html has the panel', /id="closeoutPanel"/.test(html));
ok('customer.html loads job-closeout.js with defer, before the checklist', /<script defer src="js\/job-closeout\.js\?v=\d+"><\/script>\s*<script defer src="js\/customer-checklist\.js/.test(html));
ok('checklist render calls JobCloseout', /JobCloseout\.render\(lead\)/.test(read('docs/pro/js/customer-checklist.js')));
ok('photo load re-renders it (both branches)', (read('docs/pro/js/customer-bootstrap.module.js').match(/JobCloseout\.render\(window\._currentLead, \{ photosLoaded: true \}\)/g) || []).length === 2);
ok('no inline style attributes in the module', !/\bstyle\s*=/.test(read('docs/pro/js/job-closeout.js').replace(/\/\*[\s\S]*?\*\//g, '')));
ok('no inline handlers or writes in the module', !/\bon\w+=|updateDoc|setDoc|addDoc/.test(read('docs/pro/js/job-closeout.js').replace(/\/\*[\s\S]*?\*\//g, '')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
