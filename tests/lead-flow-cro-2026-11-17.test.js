/**
 * tests/lead-flow-cro-2026-11-17.test.js — the /inspect, /storm-check and
 * /estimate lead-flow CRO pass (Jo approved, 2026-11-17).
 *
 *  /inspect      one 24-hour reply promise (thank-you too), a Text link beside
 *                Call, form panel ahead of the trust pills on phones, scroll
 *                clearance for #inspectForm, a storm line with no outcome
 *                promise, "no deposit" in the FAQ/steps, Pick My Time in the
 *                same tab, no "door to door" claim.
 *  /storm-check  the contact step saves the lead on name + phone + scheduling
 *                choice; the other answers move to the result screen and are
 *                saved with updatePublicLeadIntake; the booking link is the
 *                prefilled calendar URL; no emoji in UI text.
 *  /estimate     buttons say what happens next, loading lines follow real
 *                stages, the result booking link is prefilled.
 *
 * HTML is checked through parseTags (structure, not file text). Zero deps.
 * Run: node tests/lead-flow-cro-2026-11-17.test.js
 */
'use strict';
const K = require('./lib/src-kit');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}
const page = (r) => K.parseTags(K.read(r));
const css = (doc) => doc.$$('style').map((s) => s.html).join('\n');
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const ins = page('docs/inspect.html');
const sc = page('docs/roof-check.html');
const est = page('docs/estimate.html');
const insMain = ins.byId('main');
const insCss = css(ins);

console.log('/inspect');
ok('badge keeps the 24-hour promise', ins.$('.hero-badge').text.trim() === 'Reply within 24 hours, usually the same day');
ok('thank-you headline matches it', ins.byId('insThanksTitle').text.trim() === 'Joe will reply within 24 hours, usually the same day');
const row = ins.$('.cta-row');
ok('a Text link (sms:) sits beside the Call button, both tel/sms to the one number',
  !!row && row.$('a.phone-cta').attrs.href === 'tel:+18594207382' && row.$('a.text-cta').attrs.href === 'sms:+18594207382' && !/Call or Text/.test(insMain.text));
ok('phones: the form panel is ordered ahead of the trust pills and owner line',
  /@media\(max-width:880px\)\{[\s\S]*\.hero-left\{display:contents\}[\s\S]*\.form-panel\{order:1/.test(insCss));
ok('#inspectForm has scroll-margin-top', /#inspectForm\{scroll-margin-top:\d+px\}/.test(insCss));
const storm = ins.$('.storm-line');
ok('storm subline: adjuster after you have filed, no outcome promise',
  !!storm && /after you(&rsquo;|\u2019)ve filed/.test(storm.text) && !/approved|guarantee|covered|pay out/i.test(storm.text));
ok('"no deposit to look at your roof" is in the FAQ and the steps',
  /no deposit/i.test(ins.$$('.ins-faq details')[0].text) && /no deposit/i.test(ins.$$('.ins-steps li')[1].text));
ok('no "door to door" claim', !/door[- ]to[- ]door/i.test(insMain.text));
const pick = ins.byId('insPickTime');
ok('Pick My Time opens in a new tab (so Add details stays reachable) and says so',
  pick.attrs.target === '_blank' && pick.attrs.rel === 'noopener' && /new tab/.test(ins.byId('insPickNote').text) && ins.byId('insPickNote').attrs.hidden !== undefined);
ok('the glow dot on .hero-badge is gone', !/\.hero-badge::before/.test(insCss));
ok('subhead uses the homepage wording', /7\+ years on Cincinnati roofs, now under my own name/.test(ins.$('.subhead').text));

// 2026-11-25: /storm-check merged into /roof-check. Its contact step also asks
// an OPTIONAL email up front: the storm-report copy is emailed by an onCreate
// trigger (stormReportEmail), so an email added later on the result screen
// would never get it. It is labelled optional; nothing else was added.
console.log('/roof-check');
const step5 = sc.byId('rc-step4');
ok('contact step asks name, phone, scheduling choice, consent and an email marked optional, nothing more',
  !!step5 && !!step5.$('#rc-firstName') && !!step5.$('#rc-phone') && !!step5.$('#rc-intake') && !!step5.$('#rc-consent') && !!step5.$('#rc-email')
  && /optional/i.test(step5.text) && step5.$$('input').length === 4, step5 && step5.$$('input').map((i) => i.attrs.id).join(','));
const details = sc.byId('rc-details');
ok('the result screen carries the optional details block (hidden until a grant) with a save action',
  !!details && details.attrs.hidden !== undefined && details.$('#rc-details-save').attrs['data-action'] === 'saveDetails');
const book = sc.byId('rc-book');
ok('result booking link exists and tells the visitor it opens in a new tab', !!book && book.attrs.target === '_blank' && /new tab/.test(book.text));
ok('no emoji in the page text', !EMOJI.test(sc.byId('rc-result').text + step5.text + sc.byId('rc-teaser').text));
const scjs = K.read('docs/assets/js/roof-check.js');
ok('roof-check.js: extras off the contact step, grant requested, extras saved via updatePublicLeadIntake, booking link prefilled, no emoji',
  /NBDIntake\.html\(IP, \{ extras: false \}\)/.test(scjs) && /payload\.wantsFollowUp = true/.test(scjs) &&
  /updatePublicLeadIntake/.test(scjs) && /NBDIntake\.calendarUrl\(calInfo\(\)\)/.test(scjs) && !EMOJI.test(scjs));

console.log('/estimate');
const btns = est.$$('button.btn-primary').map((b) => b.text.trim());
ok('the two "See My Estimate" buttons say what happens',
  !btns.some((t) => /See My Estimate/.test(t)) && btns.some((t) => /^Show My Ballpark Range/.test(t)) && btns.some((t) => /^Continue to My Contact Info/.test(t)), btns.join(' | '));
const ls = ['ls1', 'ls2', 'ls3', 'ls4'].map((i) => est.byId(i).text.trim());
ok('loading lines name only what the code does',
  ls.join('|') === 'Saving your request for Joe...|Looking for a measured roof size from aerial imagery...|Working out your price ranges...|Drafting a short note from your answers...', ls.join('|'));
const wiz = K.read('docs/assets/js/inline/4053149b2f.js');
ok('wizard: loading lines advance on real stages (no timer), result booking link prefilled via NBDIntake.calendarUrl',
  /function lsMark\(idx\)/.test(wiz) && !/idx \* 900/.test(wiz) && /a\[data-cta="inspection"\]/.test(wiz) && /NBDIntake\.calendarUrl\(\{/.test(wiz));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
