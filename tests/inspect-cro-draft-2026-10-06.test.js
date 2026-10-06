/**
 * tests/inspect-cro-draft-2026-10-06.test.js — the /inspect CRO findings that
 * need Jo's eye (nbd-content/inspect-cro-review-2026-10-06.md #6 #7 #8),
 * stacked on the short form (#2230).
 *
 *  #6  "What happens next" (3 steps) + a 4-question FAQ under the form. Every
 *      fact is one the site already prints (free, Joe on the roof, 45-60 min,
 *      $150 written report); the "be home" answer is Jo's 2026-10-06 wording;
 *      the insurance answer is the allowed wording only.
 *  #7  A one-line kicker for known QR sources, set with textContent; nothing
 *      for unknown sources.
 *  #8  ?ref=CODE prefills a hidden referralCode (normalised like the server)
 *      that rides on the submit; the details-step field folds behind
 *      "Have a referral code?" and hides when the URL already supplied one.
 *
 * Zero deps. Run: node tests/inspect-cro-draft-2026-10-06.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + JSON.stringify(detail) : '')); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const HTML = read('docs/inspect.html').replace(/<!--[\s\S]*?-->/g, '');
const JS = read('docs/assets/js/inspect-form.js');

console.log('#6 what happens next + FAQ');
const NEXT = (HTML.match(/<section class="ins-next"[\s\S]*?<\/section>/) || [''])[0];
const NEXT_TEXT = NEXT.replace(/<[^>]+>/g, ' ').replace(/&rsquo;/g, '’').replace(/\s+/g, ' ');
ok('the section sits after the form, before the tagline bar',
  NEXT.length > 0 && HTML.indexOf('id="inspectSuccess"') < HTML.indexOf('class="ins-next"') && HTML.indexOf('class="ins-next"') < HTML.indexOf('class="tagline-bar"'));
ok('three numbered steps', (NEXT.match(/<li>/g) || []).length === 3 && /<ol class="ins-steps">/.test(NEXT));
ok('step facts match the roof-inspection page: 45 minutes to an hour, $150 report',
  /45 minutes to an hour/.test(NEXT_TEXT) && /written photo report is \$150/.test(NEXT_TEXT));
const svc = read('docs/services/roof-inspection.html');
ok('...and the service page still prints both facts', /45 minutes to an hour/.test(svc) && /written photo report is \$150/.test(svc));
const faqs = [...NEXT.matchAll(/<details><summary>([^<]+)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map((m) => [m[1], m[2]]);
ok('four FAQ questions, native <details>', faqs.length === 4, faqs.map((f) => f[0]));
const ans = (q) => (faqs.find((f) => f[0] === q) || [])[1] || '';
ok('"Do I need to be home?" = Jo\'s 2026-10-06 wording, word for word',
  ans('Do I need to be home?') === 'You don&rsquo;t have to be home, but you&rsquo;re welcome to walk it with Joe.');
const ins = ans('What about insurance?');
ok('insurance answer uses the allowed wording', /document it with photos/.test(ins) && /meet your adjuster/.test(ins), ins);
ok('no claim-handling / outcome promises anywhere in the section',
  !/handle your claim|we handle|get (it|your claim) (approved|paid)|insurance (will|should) (pay|cover)|free roof|deductible|insurance specialist|public adjuster/i.test(NEXT_TEXT), NEXT_TEXT);
ok('no "Licensed" and no founding year', !/licensed/i.test(NEXT_TEXT) && !/(since|founded|est\.?)\s*(19|20)\d\d/i.test(NEXT_TEXT));
ok('no inline handlers or inline script in the section', !/\son[a-z]+=/i.test(NEXT) && !/<script/i.test(NEXT));

console.log('\n#7 / #8 markup');
ok('kicker ships empty and hidden above the badge', /<p class="qr-kicker" id="insKicker" hidden><\/p>\s*<div class="hero-badge">/.test(HTML));
const FORM = (HTML.match(/<form id="inspectForm"[\s\S]*?<\/form>/) || [''])[0];
ok('hidden referralCode input on the form, empty by default', /<input type="hidden" name="referralCode" id="insRefCode" value="">/.test(FORM));
ok('"code applied" note ships hidden', /<p class="ins-ref-note" id="insRefNote" hidden>/.test(FORM));
ok('details-step referral field folds behind "Have a referral code?"',
  /<details class="ins-ref" id="insRefWrap">\s*<summary>Have a referral code\?<\/summary>[\s\S]*?id="f-referral"[\s\S]*?<\/details>/.test(HTML));
ok('inspect-form.js cache-buster bumped to v=5', /inspect-form\.js\?v=5/.test(HTML));
ok('no innerHTML in inspect-form.js kicker/ref code', !/insKicker[\s\S]{0,200}innerHTML|insRefNoteCode[\s\S]{0,200}innerHTML/.test(JS));

console.log('\n#7 / #8 executed');
function run(search) {
  const els = {}; const calls = []; const handlers = {};
  const mk = (id, props) => {
    const el = Object.assign({ id, value: '', attrs: {}, textContent: '', disabled: false, hidden: false, style: {}, checked: false,
      classList: { add() {} }, setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      focus() {}, remove() {}, scrollIntoView() {}, addEventListener(t, fn) { handlers[id + ':' + t] = fn; }, appendChild() {}, querySelector: () => null }, props || {});
    els[id] = el; return el;
  };
  ['utm_source', 'utm_medium', 'utm_campaign'].forEach((k) => mk(k));
  mk('insKicker', { hidden: true }); mk('insRefCode'); mk('insRefNote', { hidden: true }); mk('insRefNoteCode'); mk('insRefWrap');
  const form = mk('inspectForm');
  mk('f-name', { value: 'Pat Example' }); mk('f-address', { value: '12 Elm St, Goshen OH' }); mk('f-phone', { value: '8595550100' });
  mk('ins-consent', { checked: true }); mk('inspectSubmit'); mk('inspectSuccess');
  ['insThanksTitle', 'insThanksText', 'insPickTime', 'insDetails', 'insDetailsSave', 'insDetailsStatus', 'insIntakeAfter', 'insXIntake', 'f-story', 'f-email', 'f-referral'].forEach((id) => mk(id));
  // FormData sees what a browser would: every named input, empty or not.
  function FormData() {
    this._f = { utm_source: els.utm_source.value, utm_medium: els.utm_medium.value, utm_campaign: els.utm_campaign.value,
      referralCode: els.insRefCode.value, name: els['f-name'].value, address: els['f-address'].value, phone: els['f-phone'].value, nbd_hp: '' };
  }
  FormData.prototype.forEach = function (cb) { Object.keys(this._f).forEach((k) => cb(this._f[k], k)); };
  const window = {
    location: { search }, open() {},
    NBDIntake: { read: () => ({ fields: { scheduling: 'contact_me' }, files: [] }), html: () => '', calendarUrl: () => '', afterSubmit() {} },
    nbdPublicFunctionsBase: () => 'https://fn.test',
    submitPublicLead: (kind, data) => { calls.push({ kind, data }); return Promise.resolve({ ok: true, photoToken: null }); },
  };
  const document = { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => mk('__n' + Object.keys(els).length), addEventListener() {} };
  form.addEventListener = (t, fn) => { handlers['form:' + t] = fn; };
  vm.runInNewContext(JS, { window, document, FormData, URLSearchParams, fetch: async () => ({ ok: true }), Promise, console: { error() {}, warn() {}, log() {} } });
  if (handlers['form:submit']) handlers['form:submit']({ preventDefault() {} });
  return { els, calls };
}

[['?utm_source=yard-sign&utm_medium=qr', 'Saw my sign on your street?'],
 ['?utm_source=banner-neighbor', 'Saw my sign on your street?'],
 ['?utm_source=hanger', 'Got my door hanger?'],
 ['?utm_source=card', 'Thanks for keeping my card.']].forEach(([q, line]) => {
  const r = run(q);
  ok('kicker for ' + q, r.els.insKicker.hidden === false && r.els.insKicker.textContent === line, r.els.insKicker.textContent);
});
['', '?utm_source=banner-event', '?utm_source=sticker', '?utm_source=__proto__', '?utm_source=<b>x</b>', '?utm_source=google'].forEach((q) => {
  const r = run(q);
  ok('no kicker for "' + q + '"', r.els.insKicker.hidden === true && r.els.insKicker.textContent === '', r.els.insKicker);
});

{
  const r = run('?ref=john-ab12%3Cscript%3E');
  ok('?ref is normalised like the server (upper-case, A-Z 0-9 -)', r.els.insRefCode.value === 'JOHN-AB12SCRIPT', r.els.insRefCode.value);
  ok('...the "applied" note shows the code via textContent', r.els.insRefNote.hidden === false && r.els.insRefNoteCode.textContent === 'JOHN-AB12SCRIPT');
  ok('...the details-step referral field hides (already sent)', r.els.insRefWrap.hidden === true);
  const d = (r.calls[0] || {}).data || {};
  ok('...and the code rides on the submit', r.calls.length === 1 && d.referralCode === 'JOHN-AB12SCRIPT', d);
}
{
  const r = run('?ref=' + 'A'.repeat(33));
  ok('a code over 32 characters is ignored', r.els.insRefCode.value === '' && r.els.insRefNote.hidden === true && r.els.insRefWrap.hidden === false);
}
{
  const r = run('?ref=%21%21%21');
  ok('a code that normalises to nothing is ignored', r.els.insRefCode.value === '' && r.els.insRefNote.hidden === true);
  const d = (r.calls[0] || {}).data || {};
  ok('...and an empty code is never posted', r.calls.length === 1 && !('referralCode' in d), d);
}
{
  const r = run('');
  const d = (r.calls[0] || {}).data || {};
  ok('no ?ref: field stays folded-in and visible, nothing posted', r.els.insRefWrap.hidden === false && !('referralCode' in d), d);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
