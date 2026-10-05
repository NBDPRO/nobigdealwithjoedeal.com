/* portal-signature-repaint.test.js
 *
 * HISTORY. The homeowner portal's 30-second poll replaced #mainWrap.innerHTML
 * wholesale, which tore down and recreated the BoldSign signing iframe —
 * destroying whatever the homeowner had drawn inside it. A bounded deferral
 * (_signatureInFlight + MAX_SIGN_DEFERRALS) protected it.
 *
 * 2026-10-04: BoldSign is retired. The portal no longer embeds a signing
 * iframe at all — it LINKS the in-house signing page (esign.html), which is
 * its own page, so a portal repaint has nothing in flight to destroy and the
 * deferral is gone. This suite now pins the replacement:
 *
 *   1. no signing iframe is rendered, and the deferral machinery is gone (a
 *      deferral with nothing to protect only delays real updates);
 *   2. the signing link is accepted ONLY if it is our esign.html link with a
 *      token — the same origin pin the BoldSign embed carried (Wave 87),
 *      lifted and RUN against hostile inputs, not regex-matched;
 *   3. the server hands out only the FIRST signer's live link (the portal
 *      token is the homeowner's; a co-owner signs from their own email), and
 *      never calls BoldSign.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const PORTAL = read('docs/pro/js/portal.js');
const SERVER = read('functions/portal.js');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

group('1. No iframe, no deferral', () => {
  assert('the portal renders no signing iframe', !/title="Sign Contract"/.test(PORTAL) && !/<iframe[^>]*signEmbedUrl/.test(PORTAL));
  assert('the repaint deferral is gone (nothing in flight to protect)',
    !/_signatureInFlight\(/.test(PORTAL) && !/MAX_SIGN_DEFERRALS/.test(PORTAL));
  const i = PORTAL.indexOf('async function _pollOnce()');
  const region = i === -1 ? '' : PORTAL.slice(i, i + 2500);
  assert('_pollOnce found', i !== -1);
  assert('a changed view repaints right away (_lastView advanced, then renderView)',
    /_lastView = view;\s*if \(events\) \{[\s\S]{0,400}renderView\(view\);/.test(region));
  assert('and the page still repaints wholesale (why the iframe used to break)',
    /getElementById\('mainWrap'\)\.innerHTML = parts\.join\(''\);/.test(PORTAL));
});

group('2. The signing link is ours or nothing (lifted and run)', () => {
  const m = /const signLink = \(u\) => \{[\s\S]*?\n  \};/.exec(PORTAL);
  assert('signLink found', !!m, 'if it moved, update the extractor — do not delete the suite');
  if (!m) return;
  const sb = {};
  vm.createContext(sb);
  vm.runInContext(m[0] + '\nthis.f = signLink;', sb);
  const f = sb.f;
  const good = 'https://nobigdealwithjoedeal.com/pro/esign.html?t=ABCDEFGHJKMNPQRSTUVWXYZ2';
  assert('our signing link passes', f(good) === good);
  for (const bad of [
    'https://app.boldsign.com/document/sign/?documentId=x',
    'https://evil.example/pro/esign.html?t=ABCDEFGHJKMN',
    'https://nobigdealwithjoedeal.com.evil.example/pro/esign.html?t=ABCDEFGHJKMN',
    'http://nobigdealwithjoedeal.com/pro/esign.html?t=ABCDEFGHJKMN',
    'javascript:alert(1)//https://nobigdealwithjoedeal.com/pro/esign.html?t=ABCDEFGHJKMN',
    'https://nobigdealwithjoedeal.com/pro/esign.html?t=ABC"><img src=x>',
    'https://nobigdealwithjoedeal.com/pro/esign.html?t=SHORT',
    '', null, undefined,
  ]) {
    assert('refused: ' + String(bad).slice(0, 70), f(bad) === '');
  }
  assert('the card renders only with a passing link',
    /const signUrl = signLink\(view\.estimate && view\.estimate\.signUrl\);[\s\S]{0,60}if \(awaitingSign && signUrl\)/.test(PORTAL));
});

group('3. Server: first signer only, never BoldSign', () => {
  assert('getHomeownerPortalView no longer calls BoldSign', !/api\.boldsign\.com/.test(SERVER) && !/BOLDSIGN/.test(SERVER));
  assert('the link is looked up only for an in-house envelope on THIS lead',
    /latest\.signatureProvider === 'nbd-esign'/.test(SERVER) && /e\.leadId === tok\.leadId/.test(SERVER));
  assert('only while it is the FIRST signer\'s turn, and only that signer\'s token',
    /\(e\.currentSignerId \|\| firstId\) === firstId/.test(SERVER) && /\(t\.signerId \|\| 'signer'\) === firstId/.test(SERVER));
  assert('an expired token is never handed out', /exp > now/.test(SERVER));
  assert('historical BoldSign signedDocumentUrl stays readable',
    /signedDocumentUrl: latest\.signedDocumentUrl \|\| signedEnvelopeUrl \|\| null/.test(SERVER));
});

console.log('\n──────────────────────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
