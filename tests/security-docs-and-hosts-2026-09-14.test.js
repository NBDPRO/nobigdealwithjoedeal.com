/**
 * tests/security-docs-and-hosts-2026-09-14.test.js
 *
 * Guards PR-4b of the Grok Pro/CRM audit evaluation
 * (documentation/audit/GROK-CRM-AUDIT-EVALUATION-2026-09-13.md, verdict rows
 * 8/13/26 in Part 1, "Security/ops" in Part 2): host-name accuracy, the
 * Cloudflare-worker retirement status, the /pro/privacy routing gap, the
 * homeowner-portal SaaS-privacy disclosure, the nosw kill-switch's third
 * blind spot, and a stale CORS-allowlist typo shared by two functions.
 *
 * Pure-Node, no emulator. Run: node tests/security-docs-and-hosts-2026-09-14.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { passed++; }
  else { failed++; fails.push(label + (detail ? ' — ' + detail : '')); }
}

console.log('security-docs-and-hosts-2026-09-14: PR-4b regression guard\n');

// ── SECURITY.md ──────────────────────────────────────────────────────────
{
  const sec = read('SECURITY.md');

  // The "Corrected 2026-09-14" prose legitimately quotes the old wrong host
  // while explaining the fix, so check the *live* claim — the "Production
  // domains:" bullet up to that correction note — not whole-file absence
  // (see tests/test-assertions-match-their-own-comments precedent).
  const domainsBullet = (sec.match(/Production domains:[\s\S]{0,300}?(?=\*\*Corrected 2026-09-14\*\*)/) || [''])[0];
  ok('SECURITY.md "Production domains" bullet no longer LISTS the never-existed nbd-pro.web.app host',
    domainsBullet.length > 0 && !/nbd-pro\.web\.app/.test(domainsBullet),
    JSON.stringify(domainsBullet));
  ok('SECURITY.md production domains include nobigdeal-pro.web.app',
    /nobigdeal-pro\.web\.app/.test(sec));
  ok('SECURITY.md production domains include the authDomain nobigdeal-pro.firebaseapp.com',
    /nobigdeal-pro\.firebaseapp\.com/.test(sec));

  // swathWebhook left the list when the Swath code was removed (2026-10-04).
  ok('SECURITY.md webhook list includes thumbtackWebhook',
    /thumbtackWebhook/.test(sec));
  ok('SECURITY.md webhook list includes stripeConnectWebhook',
    /stripeConnectWebhook/.test(sec));

  // Row 8 — four Cloudflare workers, not one; the ops action still stands.
  ok('SECURITY.md documents all four Cloudflare workers, not just nbd-ai-proxy',
    /nbd-ai-visualizer/.test(sec) && /nbd-mailerlite/.test(sec) && /nbd-stripe-webhook/.test(sec));
  ok('SECURITY.md still carries the ops action to delete the worker(s)',
    /Ops action still required/.test(sec));
  // The smoke-test pin (tests/smoke/functions.test.js L-02) requires this
  // substring shape to survive untouched — assert it here too so a future
  // edit to either file catches drift against the other.
  ok('SECURITY.md still matches the L-02 smoke-test pin shape',
    /Retired surfaces[\s\S]{0,600}nbd-ai-proxy[\s\S]{0,600}Cloudflare dashboard/.test(sec));

  // The new-device Slack alert is dead twice over (stub secret + removed caller).
  ok('SECURITY.md documents the new-device Slack alert is dark',
    /does not fire\s*\n?\s*today/.test(sec) || /but it does not fire/.test(sec));
  ok('SECURITY.md names the missing client caller as one reason the alert is dark',
    /no client caller/.test(sec) || /removed under "D9"/.test(sec));
  ok('SECURITY.md names the unset secret as the other reason the alert is dark',
    /SLACK_WEBHOOK_URL/.test(sec) && /which it is not/.test(sec));

  // Reviewer-checklist bullet must describe BOTH onCall and onRequest gating,
  // not just assert enforceAppCheck (a no-op on onRequest per the App Check
  // note higher in the same file).
  ok('SECURITY.md reviewer checklist distinguishes onCall vs onRequest gating',
    /onRequest[^\n]*functions have[^\n]*(signature verification|ID-token check|per-IP rate limit)/i.test(sec));
  ok('SECURITY.md reviewer checklist notes enforceAppCheck is a no-op on onRequest',
    /enforceAppCheck.{0,20}is a no-op/.test(sec));

  // Dated decision line recording "repo stays public this quarter".
  ok('SECURITY.md version history records the 2026-09-14 stays-public decision',
    /2026-09-14/.test(sec) && /stays public this quarter/.test(sec));
}

// ── SECRET_ROTATION.md ───────────────────────────────────────────────────
{
  const rot = read('documentation/runbooks/SECRET_ROTATION.md');
  ok('SECRET_ROTATION.md documents the three additional Cloudflare workers',
    /nbd-ai-visualizer/.test(rot) && /nbd-mailerlite/.test(rot) && /nbd-stripe-webhook/.test(rot));
  ok('SECRET_ROTATION.md still instructs deleting all four workers',
    /delete all four/i.test(rot));
}

// ── functions/report-sharing.js + functions/calendar-feed.js CORS typo ───
// A header comment above the array deliberately quotes the old typo while
// explaining the fix ("Was 'nbd-pro.web.app' ... Fixed 2026-09-14."), so
// check the array LITERAL's actual string entries, not the whole array
// block (which would false-positive on that comment).
for (const rel of ['functions/report-sharing.js', 'functions/calendar-feed.js']) {
  const src = read(rel);
  const arrMatch = src.match(/const CORS_ORIGINS = \[([\s\S]*?)\];/);
  const arrBody = arrMatch ? arrMatch[1] : '';
  const stringLiterals = arrBody.match(/'https:\/\/[^']+'/g) || [];
  ok(rel + ': CORS_ORIGINS array found', arrMatch !== null);
  ok(rel + ': CORS_ORIGINS string literals no longer include the never-existed nbd-pro.web.app typo',
    !stringLiterals.some((s) => s === "'https://nbd-pro.web.app'"),
    JSON.stringify(stringLiterals));
  ok(rel + ': CORS_ORIGINS string literals include the real nobigdeal-pro.web.app host',
    stringLiterals.some((s) => s === "'https://nobigdeal-pro.web.app'"));
}

// ── firebase.json — /pro/privacy 301 redirect (not a rewrite) ───────────
{
  const fb = JSON.parse(read('firebase.json'));
  const hosting = Array.isArray(fb.hosting) ? fb.hosting[0] : fb.hosting;
  const redirects = (hosting && hosting.redirects) || [];
  const rewrites = (hosting && hosting.rewrites) || [];

  const bare = redirects.find((r) => r.source === '/pro/privacy');
  const html = redirects.find((r) => r.source === '/pro/privacy.html');
  ok('firebase.json redirects /pro/privacy -> /privacy',
    !!bare && bare.destination === '/privacy' && bare.type === 301);
  ok('firebase.json redirects /pro/privacy.html -> /privacy',
    !!html && html.destination === '/privacy' && html.type === 301);
  ok('/pro/privacy is a redirect, not a rewrite (destination page assumes the /privacy URL)',
    !rewrites.some((r) => r.source === '/pro/privacy' || r.source === '/pro/privacy.html'));
}

// ── docs/privacy.html — NBD Pro sub-processor disclosure ─────────────────
{
  const priv = read('docs/privacy.html');
  ok('privacy.html discloses Groq (primary voice transcription vendor)',
    /Groq/.test(priv));
  ok('privacy.html discloses Deepgram (fallback voice transcription vendor)',
    /Deepgram/.test(priv));
  ok('privacy.html discloses Google Maps / Nominatim / Census for address lookups',
    /Google Maps/.test(priv) && /Nominatim/.test(priv) && /Census/.test(priv));
  ok('privacy.html discloses Upstash (rate-limit infra)',
    /Upstash/.test(priv));
  ok('privacy.html discloses Thumbtack as a lead-forwarding source',
    /Thumbtack/.test(priv));
  ok('privacy.html adds an NBD Pro software / controller-processor section',
    /NBD Pro/.test(priv) && /processor/i.test(priv) && /controller/i.test(priv));
  ok('privacy.html "Last Updated" was bumped off the stale August 2026 stamp',
    !/Last Updated:\s*August 2026/.test(priv));
  // Not older than the 2026-09 revision (later updates bump it — 2026-10-02
  // added the A2P mobile-information sentence).
  ok('privacy.html "Last Updated" reads September 2026 or later',
    // A day is allowed since 2026-10-03 ("October 3, 2026").
    /Last Updated:\s*(?:(?:September|October|November|December)(?: \d{1,2},)? 2026|\w+(?: \d{1,2},)? 20(?:2[7-9]|[3-9]\d))/.test(priv));
}

// ── docs/pro/README-killswitch.md — corrected example URL ────────────────
{
  const readme = read('docs/pro/README-killswitch.md');
  // The correction note legitimately quotes the old dead URL while
  // explaining why it never worked, so check the fenced example block
  // (the thing a reader would actually copy-paste) rather than the whole
  // doc.
  const exampleBlock = (readme.match(/```\r?\n([\s\S]*?)\r?\n```/) || [''])[0];
  ok('README-killswitch.md example block found', exampleBlock.length > 0);
  ok('README-killswitch.md example block no longer gives the dead /pro/?nosw=1 URL',
    !/\/pro\/\?nosw=1/.test(exampleBlock), exampleBlock);
  ok('README-killswitch.md example block gives a working URL that loads offline-manager.js',
    /\/pro\/dashboard\.html\?nosw=1/.test(exampleBlock));
  ok('README-killswitch.md names both files this PR patched (offline-manager.js, sw-register.js)',
    /offline-manager\.js/.test(readme) && /sw-register\.js/.test(readme));
}

// ── docs/pro/js/offline-manager.js — nosw kill-switch honored ────────────
{
  const om = read('docs/pro/js/offline-manager.js');
  ok('offline-manager.js checks the ?nosw=1 URL param',
    /new URLSearchParams\(location\.search\)\.has\(['"]nosw['"]\)/.test(om));
  ok('offline-manager.js checks the /pro/nosw.txt remote kill file',
    /\/pro\/nosw\.txt/.test(om));
  ok('offline-manager.js unregisters existing service workers when killed',
    /getRegistrations\(\)/.test(om) && /unregister\(\)/.test(om));
  // The fix must NOT use an early return for the kill branch, since
  // non-SW init work (online listener, status indicator, queue flush)
  // has to keep running either way — that was the draft bug caught and
  // fixed during PR-4b's own review.
  ok('offline-manager.js gates SW registration with a flag, not an early return',
    /swKilled/.test(om)
    && /if\s*\(\s*['"]serviceWorker['"]\s*in\s*navigator\s*&&\s*!swKilled\s*\)/.test(om));
  ok('offline-manager.js still runs its non-SW init work unconditionally',
    /addEventListener\(['"]online['"]/.test(om));
}

// ── docs/pro/js/pages/sw-register.js — the third blind spot, now fixed ───
{
  const sw = read('docs/pro/js/pages/sw-register.js');
  ok('sw-register.js checks the ?nosw=1 URL param',
    /new URLSearchParams\(location\.search\)\.has\(['"]nosw['"]\)/.test(sw));
  ok('sw-register.js checks the /pro/nosw.txt remote kill file',
    /\/pro\/nosw\.txt/.test(sw));
  ok('sw-register.js still registers /pro/sw.js when not killed',
    /navigator\.serviceWorker\.register\(['"]\/pro\/sw\.js['"]\)/.test(sw));
  ok('sw-register.js unregisters existing service workers when killed',
    /getRegistrations\(\)/.test(sw) && /unregister\(\)/.test(sw));
  ok('leaderboard.html (the page that only loads sw-register.js) still wires it up',
    /js\/pages\/sw-register\.js/.test(read('docs/pro/leaderboard.html')));
}

// ── functions/FUNCTIONS_INDEX.md — three stale lines corrected ───────────
{
  const idx = read('functions/FUNCTIONS_INDEX.md');
  ok('FUNCTIONS_INDEX.md carries a 2026-09-14 re-enumeration with the current export count',
    /re-enumerated 2026-09-14:\s*\*\*208 keys = 184 deployed \+ 24 helper\*\*/.test(idx));
  ok('FUNCTIONS_INDEX.md no longer says the dead-export console deletion is "queued"',
    !/console deletion queued in WEEKLY_CADENCE/.test(idx));
  ok('FUNCTIONS_INDEX.md records the dead-export console deletion as done (2026-09-04)',
    /console deletion is DONE, not queued/.test(idx));
  ok('FUNCTIONS_INDEX.md visualizerImageGen rate limit corrected to 5\\/hr\\/IP',
    // \b so "15/hr/IP" (the stale value) can't vacuously satisfy a bare
    // "5/hr/IP" substring match.
    /visualizerImageGen[\s\S]{0,80}\| onRequest \|[\s\S]{0,600}\b5\/hr\/IP/.test(idx));
  ok('FUNCTIONS_INDEX.md no longer claims visualizerImageGen is 15/hr/IP',
    !/visualizerImageGen[\s\S]{0,80}\| onRequest \|[\s\S]{0,600}15\/hr\/IP,?\s*\|/.test(idx));
  ok('FUNCTIONS_INDEX.md visualizerImageGen row names both Replicate model tiers',
    /flux-kontext-pro/.test(idx) && /flux-kontext-max/.test(idx));
  // The row now legitimately quotes the retired claim ("not \"exported but
  // never deployed\"") while correcting it — check the ASSERTED-AS-FACT
  // bold form is gone, not the whole substring.
  ok('FUNCTIONS_INDEX.md onRepSignup no longer ASSERTS "exported but never deployed" as fact',
    !/onRepSignup[\s\S]{0,400}\*\*exported but never deployed\*\*/.test(idx));
  ok('FUNCTIONS_INDEX.md onRepSignup now states it IS deployed and active',
    /onRepSignup[\s\S]{0,200}it IS deployed and active/.test(idx));
  ok('FUNCTIONS_INDEX.md keeps the "do not remove the export" guidance for onRepSignup',
    /onRepSignup[\s\S]{0,900}Do NOT remove the export/.test(idx));
}

console.log('\n──────────────────────────────────');
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
