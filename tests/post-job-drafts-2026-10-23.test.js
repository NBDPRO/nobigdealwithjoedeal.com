#!/usr/bin/env node
/**
 * Review-ask and referral-ask drafts (2026-10-23):
 * docs/pro/js/post-job-drafts-logic.js (pure) and its use on the finished-job
 * card (docs/pro/js/job-closeout.js). Draft-only: nothing here sends.
 *
 * Run: node tests/post-job-drafts-2026-10-23.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const D = require(path.join(ROOT, 'docs/pro/js/post-job-drafts-logic.js'));
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const base = { id: 'L1', firstName: 'Pat', email: 'pat@example.org', phone: '(859) 555-0100', tcpaConsentText: 'consent v1' };
const PAID = { paidInFull: true };

console.log('moments');
let m = D.moments(base, PAID);
ok('paid, nothing asked yet: review yes, referral no', m.review === true && m.referral === false);
m = D.moments(Object.assign({}, base, { reviewRequested: true }), PAID);
ok('review asked: no second review ask, referral yes', m.review === false && m.referral === true);
m = D.moments(Object.assign({}, base, { warrantyCertFiledAt: 1 }), PAID);
ok('warranty filed: referral yes', m.referral === true && m.review === true);
m = D.moments(Object.assign({}, base, { reviewRequested: true, warrantyCertFiledAt: 1 }), { paidInFull: false });
ok('negative control: not paid in full = no ask at all', m.review === false && m.referral === false);
ok('paidInFull must be exactly true', D.moments(base, { paidInFull: 'yes' }).review === false && D.moments(base, null).review === false);
m = D.moments(Object.assign({}, base, { reviewRequested: true, doNotContact: true }), PAID);
ok('do-not-contact: no asks', !m.review && !m.referral);
m = D.moments(Object.assign({}, base, { completedBackfill: true }), PAID);
ok('job marked finished after the fact: no asks', !m.review && !m.referral);

console.log('channels');
ok('text needs consent + phone + no opt-out', D.canText(base) === true);
ok('no stored consent: no text', D.canText(Object.assign({}, base, { tcpaConsentText: '' })) === false);
ok('smsOptOut: no text', D.canText(Object.assign({}, base, { smsOptOut: true })) === false);
ok('short phone: no text', D.canText(Object.assign({}, base, { phone: '555' })) === false);
ok('email needs a valid address and no DNC', D.canEmail(base) && !D.canEmail(Object.assign({}, base, { email: 'nope' })) && !D.canEmail(Object.assign({}, base, { dnc: true })));

console.log('review draft');
const rv = D.build('review', base, { link: 'https://g.page/r/abc', company: 'Test Roofing Co' });
const rvAll = rv.email.subject + ' ' + rv.email.body + ' ' + rv.text;
ok('has the review link in email and text', rv.email.body.includes('https://g.page/r/abc') && rv.text.includes('https://g.page/r/abc'));
ok('text ends with STOP line', /Reply STOP to opt out\.$/.test(rv.text));
ok('FTC: no rating gate, no incentive, no referral', !/if you (were|are) happy|5[- ]star|five star|\$\d|discount|gift|reward|referral|refer /i.test(rvAll));
ok('negative control: referral draft does mention the amount', /\$100/.test(D.build('referral', base, { link: 'https://x.test/r' }).text));
ok('first name used', /^Hi Pat,/.test(rv.text));

console.log('referral draft');
const rf = D.build('referral', base, { link: 'https://nobigdealwithjoedeal.com/pro/refer.html?ref=L1&code=PAT-AB12', company: 'Test Roofing Co' });
const rfAll = rf.email.subject + ' ' + rf.email.body + ' ' + rf.text;
ok('flat $100 stated, paid-in-full condition stated', /\$100 thank-you/.test(rf.text) && /completed and paid in full/.test(rf.text));
ok('no other dollar amount', (rfAll.match(/\$\d+/g) || []).every((x) => x === '$100'));
ok('KY: never ties the amount to a deductible, claim, insurer or discount', !/deductible|claim|insur|discount|rebate|waive|free roof/i.test(rfAll));
ok('never mentions a review', !/review|rating|stars?/i.test(rfAll));
ok('has the customer link', rf.text.includes('code=PAT-AB12') && rf.email.body.includes('code=PAT-AB12'));
const ins = D.build('referral', Object.assign({}, base, { jobType: 'insurance' }), { link: 'https://x.test/r' });
ok('insurance job: same flat wording, same amount', ins.text.replace(/https\S+/, '') === D.build('referral', base, { link: 'https://x.test/r' }).text.replace(/https\S+/, ''));
ok('amount constant matches the server credit', D.REFERRAL_BONUS_USD === 100 && /REFERRAL_BONUS_USD = 100;/.test(read('functions/referral-rewards.js')));
ok('amount never exceeds the Kentucky $100 cap', D.REFERRAL_BONUS_USD <= 100);

console.log('shared rules');
[rvAll, rfAll, rv.notes.join(' ') + rf.notes.join(' ')].forEach((s, i) => {
  ok('claim-wording filter finds nothing (' + i + ')', CW.scanText(s).length === 0);
  ok('no in-house / W2 / employee / IKO / Owens Corning wording (' + i + ')', !/in-house|\bW-?2\b|employee|\bIKO\b|Owens Corning|our crew/i.test(s));
});
ok('email-only lead: no text draft', D.build('review', Object.assign({}, base, { tcpaConsentText: '' }), { link: 'u' }).text === null);
ok('no channel: a note says ask in person', /No usable channel/.test(D.build('review', { id: 'x' }, { link: 'u' }).notes.join(' ')));
ok('no link: no draft', D.build('review', base, { link: '' }) === null && D.build('bogus', base, { link: 'u' }) === null);
ok('texts carry the 8am-9pm note', /8am and 9pm/.test(rv.notes.join(' ')));
ok('every draft says nothing is sent from here', /Nothing is sent from here/.test(rv.notes.join(' ')) && /Nothing is sent from here/.test(rf.notes.join(' ')));

console.log('on the card');
function sandbox(lead) {
  const panel = { innerHTML: '', hidden: true, handlers: {}, addEventListener(n, f) { this.handlers[n] = f; } };
  const sent = [];
  const win = {
    document: { getElementById: (id) => (id === 'closeoutPanel' ? panel : null) },
    _currentLead: lead, _customerPhotos: [{ phase: 'after' }],
    _companyProfile: { companyName: 'Test Roofing Co' },
    NBDRevenue: { cached: () => [{ leadId: 'L1', status: 'sent', balanceDue: 0 }] },
    ReviewEngine: { paidInFullFor: () => true, getReviewLink: async () => 'https://g.page/r/abc',
 referralLinkFor: async () => 'https://x.test/r?code=PAT-1' },
    NBDComms: { sendSMS: () => sent.push('sms'), sendEmail: () => sent.push('email') },
    showToast() {}
  };
  win.window = win;
  vm.runInNewContext(read('docs/pro/js/post-job-drafts-logic.js'), win);
  vm.runInNewContext(read('docs/pro/js/job-closeout.js'), win);
  return { win, panel, sent };
}
(async () => {
  let s = sandbox(Object.assign({}, base, { stage: 'closed' }));
  s.win.JobCloseout.render();
  ok('paid, unasked: only the review button shows', /data-jco-draft="review"/.test(s.panel.innerHTML) && !/data-jco-draft="referral"/.test(s.panel.innerHTML));
  const target = (k) => ({ closest: () => ({ hasAttribute: (a) => a === 'data-jco-draft', getAttribute: () => k }) });
  s.panel.handlers.click({ target: target('review') });
  await new Promise((r) => setTimeout(r, 10));
  ok('clicking it shows the draft text, labelled, in a read-only box', /readonly/.test(s.panel.innerHTML) && /https:\/\/g\.page\/r\/abc/.test(s.panel.innerHTML) && /Draft review ask \(not sent\)/.test(s.panel.innerHTML));
  ok('nothing was sent', s.sent.length === 0);
  s = sandbox(Object.assign({}, base, { stage: 'closed', reviewRequested: true }));
  s.win.JobCloseout.render();
  ok('review asked: referral button shows, review button gone', /data-jco-draft="referral"/.test(s.panel.innerHTML) && !/data-jco-draft="review"/.test(s.panel.innerHTML));
  s.panel.handlers.click({ target: target('referral') });
  await new Promise((r) => setTimeout(r, 10));
  ok('referral draft carries the link and $100', /code=PAT-1/.test(s.panel.innerHTML) && /\$100/.test(s.panel.innerHTML));
  s = sandbox(Object.assign({}, base, { stage: 'closed', doNotContact: true }));
  s.win.JobCloseout.render();
  ok('negative control: do-not-contact shows no draft buttons', !/data-jco-draft/.test(s.panel.innerHTML));
  s = sandbox(Object.assign({}, base, { stage: 'closed' }));
  s.win.ReviewEngine.paidInFullFor = () => false;
  s.win.JobCloseout.render();
  ok('negative control: not paid in full shows no draft buttons', !/data-jco-draft/.test(s.panel.innerHTML));
  const src = read('docs/pro/js/post-job-drafts-logic.js') + read('docs/pro/js/job-closeout.js');
  ok('no send calls anywhere in the draft code', !/sendSMS|sendEmail|sendReview|sendReferral|fetch\(|updateDoc|setDoc|addDoc|sms:|mailto:/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('wired: customer.html loads the logic before the card', /post-job-drafts-logic\.js\?v=\d+"><\/script>\s*<script defer src="js\/job-closeout\.js/.test(read('docs/pro/customer.html')));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
