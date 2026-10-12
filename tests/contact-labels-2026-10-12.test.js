/**
 * tests/contact-labels-2026-10-12.test.js — per-number contact labels
 * (documentation/projects/CONTACT-ROUTING-TREE-2026-10-12.md, phase 1).
 *
 *   A. the pure registry rules (contact-labels-logic.js)
 *   B. home-attention.js callNeedsYou / groupNeeds / hiddenPeople read labels:
 *      hide never counts, quiet only through a promise, an explicit label beats
 *      the AI callType, NO labels = exactly the old rule
 *   C. Today (today-plan.js buildTodayPlan) drops a hidden person and the
 *      "N things today" total falls with it
 *   D. wiring + drift pins: the lazy bundle (no boot bytes), the doc shape the
 *      rules accept = the shape the logic writes, role gating on the button
 *
 * Every absence assertion has a positive control in the same block (the same
 * input WITHOUT the label does appear), so a harness that blanks the data
 * cannot pass.
 *
 * Run: node tests/contact-labels-2026-10-12.test.js
 */
'use strict';
process.env.TZ = 'America/New_York';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + detail : '')); }
}

const LG = require(path.join(ROOT, 'docs/pro/js/contact-labels-logic.js'));
const HA = require(path.join(ROOT, 'docs/pro/js/home-attention.js'));
const TP = require(path.join(ROOT, 'docs/pro/js/today-plan.js'));

const NOW = Date.parse('2026-10-12T15:00:00Z');
const MIN = 60000;
const ownerOpts = { companyId: 'co-a', uid: 'u1', nowMs: NOW };

// ── A. the pure registry ──────────────────────────────────────────────
console.log('A. registry rules');
{
  ok('digits10 strips +1 and punctuation', LG.digits10('+1 (555) 014-2222') === '5550142222');
  ok('digits10 rejects short / long', LG.digits10('555014') === '' && LG.digits10('155501422223') === '');
  const d = LG.buildDoc(Object.assign({ digits: '(555) 014-2222', kind: 'sub' }, ownerOpts));
  ok('buildDoc: valid kind builds with the kind default policy (sub → quiet)', d && d.kind === 'sub' && d.policy === 'quiet' && d.digits === '5550142222');
  ok('buildDoc: personal defaults to hide, spam to hide, customer to surface',
    LG.defaultPolicy('personal') === 'hide' && LG.defaultPolicy('spam') === 'hide' && LG.defaultPolicy('customer') === 'surface');
  ok('buildDoc: an explicit policy overrides the default', LG.buildDoc(Object.assign({ digits: '5550142222', kind: 'sub', policy: 'surface' }, ownerOpts)).policy === 'surface');
  ok('buildDoc: junk policy falls back to the default', LG.buildDoc(Object.assign({ digits: '5550142222', kind: 'spam', policy: 'block' }, ownerOpts)).policy === 'hide');
  ok('buildDoc: unknown kind → null', LG.buildDoc(Object.assign({ digits: '5550142222', kind: 'vip' }, ownerOpts)) === null);
  ok('buildDoc: bad digits / no company / no uid → null',
    LG.buildDoc(Object.assign({ digits: '12', kind: 'sub' }, ownerOpts)) === null
    && LG.buildDoc({ digits: '5550142222', kind: 'sub', uid: 'u1' }) === null
    && LG.buildDoc({ digits: '5550142222', kind: 'sub', companyId: 'co-a' }) === null);
  const long = LG.buildDoc(Object.assign({ digits: '5550142222', kind: 'sub', name: 'n'.repeat(200), note: 'x'.repeat(500) }, ownerOpts));
  ok('buildDoc: name capped at 80, note at 200', long.name.length === 80 && long.note.length === 200);
  ok('buildDoc carries ONLY the keys the rules allow', Object.keys(d).sort().join() === LG.DOC_KEYS.slice().sort().join());

  const idx = LG.indexLabels([
    { id: '5550142222', data: { kind: 'sub', policy: 'hide' } },
    { id: '5550142223', data: { kind: 'wizard' } },
    { id: 'abc', data: { kind: 'sub' } },
    { id: '5550142224', data: { kind: 'personal' } },
  ]);
  ok('indexLabels keeps good docs, drops bad kind and bad id', !!idx['5550142222'] && !idx['5550142223'] && !idx.abc);
  ok('indexLabels: missing policy falls back to the kind default', idx['5550142224'].policy === 'hide');
  ok('lookup works on a plain object and on a Map', LG.lookup(idx, '(555) 014-2222').kind === 'sub'
    && LG.lookup(new Map([['5550142222', { kind: 'spam' }]]), '5550142222').kind === 'spam' && LG.lookup(idx, '5559999999') === null);

  ok('suppresses: hide always', LG.suppresses({ kind: 'spam', policy: 'hide' }, true) === true);
  ok('suppresses: quiet only without a promise', LG.suppresses({ kind: 'sub', policy: 'quiet' }, false) === true && LG.suppresses({ kind: 'sub', policy: 'quiet' }, true) === false);
  ok('suppresses: surface / no label never', LG.suppresses({ kind: 'customer', policy: 'surface' }, false) === false && LG.suppresses(null, false) === false);
  ok('effectiveBucket: an adjuster label makes it insurance', LG.effectiveBucket({ kind: 'insurance' }, 'unknown') === 'insurance' && LG.effectiveBucket({ kind: 'sub' }, 'unknown') === 'unknown');
  ok('chipFor: tone follows the policy', LG.chipFor({ kind: 'spam', policy: 'hide' }).tone === 'hidden'
    && LG.chipFor({ kind: 'sub', policy: 'quiet' }).tone === 'quiet' && LG.chipFor({ kind: 'customer', policy: 'surface' }).tone === 'neutral' && LG.chipFor(null) === null);
  ok('a seed from a contact tag NEVER proposes a kind that hides', ['customer', 'sub', 'vendor', 'referral'].every((t) => {
    const k = LG.seedKindFromTags([t]); return k && LG.defaultPolicy(k) !== 'hide';
  }) && LG.seedKindFromTags(['nope']) === null && LG.seedKindFromTags([]) === null);
  ok('checkTarget: a proxy line (3+ leads) cannot be a customer', LG.checkTarget('5550142222', 'customer', { leadCount: 3 }).ok === false
    && LG.checkTarget('5550142222', 'customer', { leadCount: 1 }).ok === true && LG.checkTarget('5550142222', 'spam', { leadCount: 3 }).ok === true);
  ok('checkTarget: own number refused, no digits refused, bad kind refused',
    LG.checkTarget('5550142222', 'sub', { ownDigits: ['(555) 014-2222'] }).ok === false && LG.checkTarget('', 'sub').ok === false && LG.checkTarget('5550142222', 'x').ok === false);
}

// ── B. "needs you" reads labels ───────────────────────────────────────
console.log('B. callNeedsYou / groupNeeds');
const call = (o) => Object.assign({ id: 'c1', channel: 'call', direction: 'inbound', status: 'noted', bucket: 'unknown', phoneDigits: '5550142222', startedAtMs: NOW - 60 * MIN }, o);
const L = (kind, policy) => ({ '5550142222': { kind, policy: policy || LG.defaultPolicy(kind) } });
{
  const unk = call({});
  ok('control: an unknown number with a note counts with NO labels', HA.callNeedsYou(unk, NOW, null) === true);
  ok('control: ... and with an empty label map (nothing changes)', HA.callNeedsYou(unk, NOW, { labels: {} }) === true);
  ok('hide: the same call no longer counts', HA.callNeedsYou(unk, NOW, { labels: L('personal') }) === false);
  ok('hide beats urgent', HA.callNeedsYou(call({ urgent: true }), NOW, { labels: L('spam') }) === false
    && HA.callNeedsYou(call({ urgent: true }), NOW, null) === true);
  ok('hide beats a promise Jo made', HA.callNeedsYou(call({ promises: [{ who: 'jo', text: 'call back' }] }), NOW, { labels: L('personal') }) === false
    && HA.callNeedsYou(call({ promises: [{ who: 'jo', text: 'call back' }] }), NOW, null) === true);
  ok('hide beats a missed call', HA.callNeedsYou(call({ status: 'short' }), NOW, { labels: L('personal') }) === false
    && HA.callNeedsYou(call({ status: 'short' }), NOW, { labels: {} }) === true);
  ok('quiet: an urgent unknown call does NOT count', HA.callNeedsYou(call({ urgent: true }), NOW, { labels: L('sub') }) === false);
  ok('quiet: a promise Jo made DOES count (the old sub/supplier rule)', HA.callNeedsYou(call({ promises: [{ who: 'jo', text: 'send the quote' }] }), NOW, { labels: L('sub') }) === true);
  ok('quiet: a promise THEY made does not', HA.callNeedsYou(call({ promises: [{ who: 'them', text: 'text me' }] }), NOW, { labels: L('sub') }) === false);
  ok('no label + AI callType sub: still promise-only (regression of the old rule)',
    HA.callNeedsYou(call({ callType: 'sub', urgent: true }), NOW, null) === false
    && HA.callNeedsYou(call({ callType: 'sub', promises: [{ who: 'jo', text: 'x' }] }), NOW, null) === true);
  ok('an explicit surface label beats the AI callType sub (Jo said keep it on Today)',
    HA.callNeedsYou(call({ callType: 'sub', urgent: true }), NOW, { labels: L('sub', 'surface') }) === true);
  ok('adjuster label counts a no-lead call even when the bucket is unknown', HA.callNeedsYou(call({ status: 'short', direction: 'outbound' }), NOW, { labels: L('insurance') }) === true
    && HA.callNeedsYou(call({ status: 'short', direction: 'outbound' }), NOW, null) === false);
  ok('the label is looked up by the call\'s own number (another number is untouched)',
    HA.callNeedsYou(call({ phoneDigits: '5550149999' }), NOW, { labels: L('personal') }) === true);
  ok('a Map works as the label store', HA.callNeedsYou(unk, NOW, { labels: new Map([['5550142222', { kind: 'spam', policy: 'hide' }]]) }) === false);
  ok('spam call type and personal status stay excluded (label cannot resurrect them)',
    HA.callNeedsYou(call({ callType: 'spam' }), NOW, { labels: L('customer') }) === false && HA.callNeedsYou(call({ status: 'personal' }), NOW, { labels: L('customer') }) === false);

  const rows = [
    call({ id: 'a1', phoneDigits: '5550142222', startedAtMs: NOW - 10 * MIN }),
    call({ id: 'a2', phoneDigits: '5550142222', startedAtMs: NOW - 20 * MIN }),
    call({ id: 'b1', phoneDigits: '5550143333', startedAtMs: NOW - 30 * MIN }),
  ];
  ok('control: two people need you with no labels', HA.groupNeeds(rows, NOW).length === 2 && HA.callersNeedingYou(rows, NOW) === 2);
  const lab = { '5550142222': { kind: 'personal', policy: 'hide' } };
  ok('a hidden person (two calls) leaves one person', HA.groupNeeds(rows, NOW, lab).length === 1 && HA.callersNeedingYou(rows, NOW, lab) === 1
    && HA.groupNeeds(rows, NOW, lab)[0].key === 'num:5550143333');
  ok('callsNeedingYou takes labels', HA.callsNeedingYou(rows, NOW, lab) === 1 && HA.callsNeedingYou(rows, NOW) === 3);
  ok('hiddenPeople counts people, not calls', HA.hiddenPeople(rows, NOW, lab) === 1 && HA.hiddenPeople(rows, NOW, null) === 0 && HA.hiddenPeople(rows, NOW, {}) === 0);
  ok('a person on a lead is one person by lead: label by number still hides their number\'s calls',
    HA.groupNeeds([call({ id: 'l1', leadId: 'L1', promises: [{ who: 'jo', text: 'x' }] })], NOW, { '5550142222': { kind: 'personal', policy: 'hide' } }).length === 0
    && HA.groupNeeds([call({ id: 'l1', leadId: 'L1', promises: [{ who: 'jo', text: 'x' }] })], NOW).length === 1);
}

// ── C. Today ──────────────────────────────────────────────────────────
console.log('C. Today plan');
{
  const rows = [
    call({ id: 'a1', phoneDigits: '5550142222', startedAtMs: NOW - 10 * MIN }),
    call({ id: 'b1', phoneDigits: '5550143333', startedAtMs: NOW - 30 * MIN }),
  ];
  const plan = (labels) => TP.buildTodayPlan({ now: NOW, leads: [], callGroups: HA.groupNeeds(rows, NOW, labels), env: {}, handled: new Set() });
  const base = plan(null), hid = plan({ '5550142222': { kind: 'spam', policy: 'hide' } });
  ok('control: both people are on Today without labels', base.calls.length === 2 && base.total === 2);
  ok('a hidden number is off Today and out of "N things today"', hid.calls.length === 1 && hid.total === 1 && hid.calls[0].phone === '5550143333');
  const quiet = plan({ '5550142222': { kind: 'sub', policy: 'quiet' } });
  ok('a quiet number is off Today until Jo promises something', quiet.calls.length === 1
    && TP.buildTodayPlan({ now: NOW, leads: [], env: {}, callGroups: HA.groupNeeds([call({ id: 'p1', promises: [{ who: 'jo', text: 'x' }] })], NOW, { '5550142222': { kind: 'sub', policy: 'quiet' } }) }).calls.length === 1);
}

// ── D. wiring + drift ─────────────────────────────────────────────────
console.log('D. wiring');
{
  // The bundle is registered at runtime by home-attention.js (deferred), NOT in
  // script-loader.js: that is a BLOCKING script with ~300 B of budget left.
  const m = /bundles\.contactlabels = \[([^\]]*)\]/.exec(read('docs/pro/js/home-attention.js'));
  ok('home-attention registers a contactlabels bundle with css + logic + data/sheet', !!m && /contact-labels\.css/.test(m[1]) && /contact-labels-logic\.js/.test(m[1]) && /contact-labels\.js/.test(m[1]));
  ok('logic loads BEFORE the data module in the bundle', !!m && m[1].indexOf('contact-labels-logic.js') < m[1].indexOf('contact-labels.js'));
  ok('script-loader.js (a blocking script) carries no label code', !/contact-?labels/i.test(read('docs/pro/js/script-loader.js')));
  const dash = read('docs/pro/dashboard.html');
  ok('NO boot bytes: dashboard.html never loads the label files', !/contact-labels/.test(dash));
  ok('control: dashboard.html still loads home-attention.js (the grep can see tags)', /home-attention\.js\?v=/.test(dash));
  const ha = read('docs/pro/js/home-attention.js');
  ok('home-attention loads the bundle lazily, then the registry, and treats failure as "no labels"',
    /loadBundle\('contactlabels'\)/.test(ha) && /NBDContactLabels\.load/.test(ha) && /labels = null/.test(ha));
  const th = read('docs/pro/js/today-home.js');
  ok('the Label button is hidden for a viewer and a sales_rep', /canLabel = !ro && r\.phone && \(\(\(w\._userClaims \|\| \{\}\)\.role \|\| ''\) !== 'sales_rep'\)/.test(th));
  ok('Today repaints on nbd:labels-changed', /'nbd:labels-changed'/.test(th));
  ok('Today groups calls WITH the loaded labels (not the bare rule)', /HA\.groupNeeds\(HA\.lastRows, now, HA\.lastLabels \|\| null\)/.test(th));
  ok('home-attention counts the strip with the labels too', /callersNeedingYou\(callRows, Date\.now\(\), labels\)/.test(ha));
  const cc = read('docs/pro/js/call-center-view.js');
  ok('Call Center: Labeled filter, chip and Label button exist', /\['labeled', 'Labeled'/.test(cc) && /function labelChip/.test(cc) && /data-cc="label"/.test(cc));
  ok('Call Center groups and tests "needs attention" with the labels', /HA\.groupNeeds\(rows, Date\.now\(\), labelsNow\(\)\)/.test(cc) && /reach\.ctx\.labels = lb/.test(cc));
  ok('no inline handlers or styles in the new files', ['docs/pro/js/contact-labels.js', 'docs/pro/js/contact-labels-logic.js'].every((f) => !/\son[a-z]+=|style="/.test(read(f))));
  const css = read('docs/pro/css/contact-labels.css');
  ok('the stylesheet carries the sheet, the undo bar and all three chip tones', /\.cl-sheet/.test(css) && /\.cl-undo/.test(css) && /\.cl-chip-quiet/.test(css) && /\.cl-chip-hidden/.test(css));

  // The rules accept exactly what the logic writes.
  const rules = read('firestore.rules');
  const fn = /function contactLabelOk[\s\S]*?\n    }\n/.exec(rules);
  ok('firestore.rules has contactLabelOk and the contact_labels match', !!fn && /match \/contact_labels\/\{digits\}/.test(rules));
  const only = fn && /hasOnly\(\[([^\]]*)\]\)/.exec(fn[0]);
  const keys = only ? only[1].split(',').map((s) => s.replace(/['\s]/g, '')).filter(Boolean) : [];
  ok('rules hasOnly keys == logic DOC_KEYS (no drift)', keys.slice().sort().join() === LG.DOC_KEYS.slice().sort().join(), keys.join());
  const enumOf = (re) => { const x = re.exec(fn ? fn[0] : ''); return x ? x[1].split(',').map((s) => s.replace(/['\s]/g, '')).filter(Boolean) : []; };
  ok('rules kind enum == logic KINDS', enumOf(/d\.kind in \[([^\]]*)\]/).join() === LG.KINDS.join());
  ok('rules policy enum == logic POLICIES', enumOf(/d\.policy in \[([^\]]*)\]/).join() === LG.POLICIES.join());
  ok('rules source enum == logic SOURCES', enumOf(/d\.source in \[([^\]]*)\]/).join() === LG.SOURCES.join());
  ok('rules name / note caps == logic caps', /d\.name\.size\(\) <= 80/.test(fn[0]) && LG.NAME_MAX === 80 && /d\.note\.size\(\) <= 200/.test(fn[0]) && LG.NOTE_MAX === 200);

  const man = JSON.parse(read('tests/ci-manifest.json'));
  ok('the rules suite is wired in the manifest and in ci.yml + the deploy gate',
    man['wired-individually'].includes('firestore-rules.contact-labels.test.js')
    && /firestore-rules\.contact-labels\.test\.js/.test(read('.github/workflows/ci.yml'))
    && /firestore-rules\.contact-labels\.test\.js/.test(read('.github/workflows/firebase-deploy.yml')));
  ok('no index needed: contact_labels never appears in firestore.indexes.json (whole-collection read by path)', !/contact_labels/.test(read('firestore.indexes.json')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
