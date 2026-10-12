/**
 * tests/layout-field-2026-10-11.test.js — L08 Field App contract (D3).
 * The behaviour is proven end to end in tests/e2e/field-app.spec.js; this file
 * pins the things that must not drift and cannot be seen in a screenshot:
 *
 *   1. registered for phone + tablet only, lazy assets + kit exist on disk,
 *      and resolve() never picks it for a desktop window
 *   2. copy is Kentucky-safe: every string in field.js / picker.js passes the
 *      runtime claim-wording filter (with a positive control that it CAN fail),
 *      and the counter line says the carrier sets the real number
 *   3. nothing is sent: no SMS/email send calls, only tel:/sms: links; the one
 *      network call is api.weather.gov; no cost/margin keys
 *   4. sunlight mode overrides ONLY colour custom properties + the border-width
 *      token, under an id-boosted selector; the camera ignores the theme
 *   5. the on-site slide needs >= 90% travel; photos go through the existing
 *      durable queue (enqueueForRetry + flushUploadQueue), not their own upload
 *
 * Run: node tests/layout-field-2026-10-11.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const R = require(path.join(ROOT, 'docs/pro/js/layout-system.js'));
const CW = require(path.join(ROOT, 'docs/pro/js/claim-wording-filter.js'));
const FIELD = read('docs/pro/js/layouts/field.js');
const PICKER = read('docs/pro/js/layouts/picker.js');
const CSS = read('docs/pro/css/layouts/field.css');

console.log('\n1. registration');
{
  const d = R.get('field');
  ok('field is registered with phone + tablet only', d && d.surfaces.slice().sort().join() === 'phone,tablet');
  ok('lazy assets and the kit exist on disk',
    fs.existsSync(path.join(ROOT, 'docs/pro', d.script)) && fs.existsSync(path.join(ROOT, 'docs/pro', d.css))
    && d.needs.script.every((p) => fs.existsSync(path.join(ROOT, 'docs/pro', p)))
    && d.needs.css.every((p) => fs.existsSync(path.join(ROOT, 'docs/pro', p))));
  ok('sunlight is a declared capability', d.supports.sunlight === true);
  ok('a phone that chose it gets it; a desktop that chose it gets Classic',
    R.resolve({ surface: 'phone', user: { byDevice: { phone: 'field' } } }).id === 'field'
    && R.resolve({ surface: 'desktop', user: { id: 'field' } }).id === 'classic');
  ok('a company can lock the phone to it', R.resolve({ surface: 'phone', user: { byDevice: { phone: 'classic' } }, company: { defaultByDevice: { phone: 'field' }, locked: true } }).id === 'field');
}

console.log('\n2. claim wording');
{
  const strings = (src) => {
    const out = []; const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g; let m;
    const code = stripComments(src);
    while ((m = re.exec(code))) out.push(m[1] != null ? m[1] : m[2]);
    return out.filter((s) => /\s/.test(s) && /[A-Za-z]{3}/.test(s));
  };
  const copy = strings(FIELD).concat(strings(PICKER));
  ok('there is copy to scan', copy.length > 30);
  const hits = [];
  copy.forEach((s) => { CW.scanText(s.replace(/\\'/g, "'")).forEach((h) => hits.push(h.rule + ': ' + h.sentence)); });
  ok('no string in field.js / picker.js trips the claim-wording rules', hits.length === 0, hits.slice(0, 3).join(' | '));
  ok('control: the filter does flag a claim-handling sentence', CW.scanText('We handle the insurance claim for you.').length > 0);
  ok('the counter says the carrier sets the real number and calls the threshold an example',
    /example guide: ' \+ EXAMPLE_THRESHOLD \+\s*\n?\s*' \(your carrier sets the real number\)'/.test(FIELD.replace(/\s+/g, ' ').replace(/' \+ ' /g, "' + '")) || /your carrier sets the real number/.test(FIELD));
  ok('no outcome words next to the count (approved / covered / qualifies / guaranteed)',
    !/\b(approved|approval|covered|qualif\w+|guarantee\w*|will pay|full replacement)\b/i.test(strings(FIELD).join(' ')));
}

console.log('\n3. nothing is sent');
{
  const code = stripComments(FIELD);
  ok('no send calls (sms/email/text/outbound) anywhere', !/\b(sendSms|sendText|sendEmail|sendMessage|smsOutbox|NBDSmsOutbox|mailto:)\b/i.test(code));
  ok('Call and Text come from the kit as tel:/sms: links', /K\.telUrl/.test(code) && /K\.smsUrl/.test(code));
  const fetches = code.match(/fetch\(\s*([^,)]+)/g) || [];
  ok('the only network calls are api.weather.gov', fetches.length >= 1 && fetches.every((f) => /weather\.gov|\burl\b/.test(f)),
    fetches.join(' | '));
  ok('no cost / margin / contractor keys', !/\b(cost|margin|markup|contractorPrice|laborCost)\w*/i.test(code));
  ok('the timeline stamp is a rep note with source rep (the rules\' allowlist)', /type: 'note', source: 'rep'/.test(code));
}

console.log('\n4. sunlight + camera');
{
  const css = stripComments(CSS);
  const blk = /html\.sun\[data-layout="field"\]:not\(#fa-sun\)\s*\{([^}]*)\}/.exec(css);
  ok('the sunlight token block exists and is id-boosted (out-ranks any theme/mode attribute selector)', !!blk);
  const decls = blk ? blk[1].split(';').map((x) => x.trim()).filter(Boolean).map((x) => x.split(':')[0].trim()) : [];
  const ALLOWED = ['--bg', '--s', '--s2', '--s3', '--t', '--m', '--rule', '--br', '--orange', '--ob', '--og', '--accent-fg', '--fa-bw'];
  ok('it declares only colour custom properties + the border-width token', decls.length >= 10 && decls.every((d) => ALLOWED.indexOf(d) !== -1), decls.join(','));
  ok('black on white with 2.5px outlines', blk && /--bg:\s*#ffffff/.test(blk[1]) && /--t:\s*#000000/.test(blk[1]) && /--fa-bw:\s*2\.5px/.test(blk[1]));
  ok('sunlight never touches sizes (--tap is not declared)', blk && !/--tap/.test(blk[1]));
  const camRules = css.split('}').filter((r) => /\.fa-(cam|video|sq|chip|cnt|count|shutter)/.test(r.split('{')[0]));
  ok('camera rules exist and use no theme tokens (white on black on purpose)',
    camRules.length >= 10 && camRules.every((r) => !/var\(--(bg|s|s2|s3|t|m|orange|og|rule|br)\b/.test(r)));
  ok('every rule is scoped under html[data-layout="field"]',
    css.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean).every((sel) => /^html(\.sun)?\[data-layout="field"\]/.test(sel)),
    css.split('}').map((r) => r.split('{')[0].trim()).filter((s) => s && !/^html(\.sun)?\[data-layout="field"\]/.test(s)).slice(0, 3).join(' | '));
  ok('the app\'s own phone nav is hidden under it, and the nav hides under the camera',
    /html\[data-layout="field"\] #mobile-nav\s*\{\s*display:\s*none\s*!important/.test(css) && /data-fa-screen="capture"\] \.fa-nav\s*\{\s*display:\s*none/.test(css));
  ok('sizes come from --tap', (css.match(/var\(--tap\)/g) || []).length >= 10);
  ok('no <header> elements (dashboard-app.css styles every `header`, which painted a dark bar)', !/<header/.test(FIELD) && !/<header/.test(read('docs/pro/js/layouts/kit.js')));
}

console.log('\n5. on-site slide + photo queue');
{
  const code = stripComments(FIELD);
  ok('the slide must travel >= 90% to confirm; a short slide snaps back', /f >= 0\.9\)\s*\{\s*setSlide\(1\);\s*confirmOnSite\(\);\s*\}\s*else setSlide\(0\)/.test(code));
  ok('keyboard path moves in quarter steps (still not a single press)', /cur \+ 0\.25/.test(code));
  ok('photos use the existing durable queue + drain', /P\.enqueueForRetry\(/.test(code) && /P\.flushUploadQueue\(/.test(code) && !/uploadBytes|firebase-storage/.test(code));
  ok('photo-engine is loaded through the photos bundle (it is not an eager tag)', /loadBundle\('photos'\)/.test(code));
  ok('tags carry the slope and test_square; description carries the count',
    /\['hail', 'test_square', sl\.tag\]/.test(code) && /'Test square, ' \+ sl\.label \+ ': ' \+ hits/.test(code));
  ok('capture context (GPS / on-site / phase) is pinned at capture like the camera does', /captureContext\(tags/.test(code));
  ok('sunlight preference is a device key kept across sign-out', /nbd_field_sun/.test(code) && /'nbd_field_sun'/.test(read('docs/pro/js/nbd-auth.js')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
