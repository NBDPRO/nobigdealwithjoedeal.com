/**
 * tests/crm-theme-contract.test.js — CRM theme-defect batch 1 invariants
 * (2026-07-19 visual audit).
 *
 * Root cause of the audit's hard defects: JS-rendered views guessing token
 * names that don't exist (--h) or hardcoding dark-tuned pastels/surfaces
 * that break in the 186-theme system's light variants. These guards pin the
 * fixes:
 *
 *  1. --h is defined (47 var(--h,#fff) sites rendered white-on-white in
 *     light mode before the alias).
 *  2. Toast collision: the legacy singleton .toast block is scoped to
 *     #toast so container toasts (the live ui.js system) keep their
 *     opacity/pointer-events. Verified live: before = opacity 0 +
 *     pointer-events none at t+1.2s; after = 1/auto.
 *  3. No dark-tuned pastel text literals on themed surfaces (the light-mode
 *     killers: #cab8ff, #5eead4, #a890e8, #a5b4fc).
 *  4. RAF rule (d2d-map-raf-fix): goTo() never wraps map/draw view-inits in
 *     requestAnimationFrame.
 *  5. Invoice modals tokenized (no #14161a panels, no z-index:100000 above
 *     the toast layer).
 *  6. Estimate Builder v2 + command palette follow theme tokens.
 *  7. prefers-reduced-motion blanket gate + focus-visible vocabulary +
 *     desktop pressed states exist in dashboard-app.css.
 * 10. Banner z-index ladder: the fixed offline / delivery-health status
 *     strips reference --z-banner-status / --z-banner-alert instead of
 *     hardcoding 10006/10007, and those tokens stay above the toast and
 *     overlay layers (see the block itself for the layering rationale).
 *
 *  8. portal.html aliases --green/--orange (portal.js references were
 *     silently invalid); close-board generated page defines --orange so its
 *     color-mix glow renders.
 *
 * Zero deps. Run: node tests/crm-theme-contract.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const P = (rel) => path.join(__dirname, '..', rel);
const read = (rel) => fs.readFileSync(P(rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail, fix) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else {
    failed++; fails.push(name);
    console.log('  ✗ ' + name + (detail ? ' — ' + detail : '') + (fix ? '\n      fix: ' + fix : ''));
  }
}

// The repo-wide scans below report file:line and the replacement, so a red
// run says what to change (the shadcn/lint idea, Repo Lab 2026-10-01).
// Lines whose only match sits in a // comment still count: the scans have
// always been whole-file, and a comment quoting the bad form is rare enough
// to fix by rewording.
const JS_DIR = P('docs/pro/js');
const jsFiles = () => fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
function hits(re, files, dir) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir || JS_DIR, f), 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => { if (re.test(l)) out.push(f + ':' + (i + 1)); });
  }
  return out;
}
const firstFew = (list) => list.slice(0, 6).join(', ') + (list.length > 6 ? ` (+${list.length - 6} more)` : '');

console.log('CRM THEME CONTRACT — batch 1 invariants');

// 1. --h alias
ok('theme-system defines --h (heading dialect alias)',
  /--h:\s*var\(--t\)/.test(read('docs/pro/css/theme-system.css')));

// 2. toast scoping
{
  const s = read('docs/pro/css/dashboard-app.css');
  ok('legacy singleton toast block is scoped to #toast',
    /#toast\.toast\{position:fixed/.test(s));
  const bare = s.match(/(^|\n)\.toast\{position:fixed/g) || [];
  ok('no bare .toast{position:fixed} rule remains', bare.length === 0);
  ok('container toasts have a warning border color',
    /\.toast\.toast-warning\{border-left-color:var\(--gold\)/.test(s));
  // The load-bearing half of this assertion is the SELECTOR, not the offset:
  // the mobile bottom override must stay scoped to `.toast-container,
  // #toast.toast` so it can never leak back onto every `.toast` and re-break
  // the container toasts (defect 2 above). The px value is deliberately NOT
  // pinned — it is a geometry constant owned by the bottom-edge budget and it
  // moves whenever that corner is re-apportioned (2026-07: 72px → 134px, to
  // clear #nbd-fab-dial, which occupies y 78→126 on mobile). Pinning the
  // literal guarded nothing about the theme contract while forcing a test
  // edit for every layout tweak. \d{2,3} still fails the two regressions that
  // matter: the calc()/env() offset being dropped altogether, or the toast
  // collapsing back onto the bottom edge at a single-digit offset.
  ok('mobile toast offset targets the container (not all .toast)',
    /\.toast-container, #toast\.toast \{ bottom:calc\(\d{2,3}px/.test(s));
}

// 2b. Shared satellite toast module — stored-XSS contract.
// Toast text routinely carries lead-supplied data (names, addresses,
// error strings echoing a field value), and public-lead fields are
// stored-XSS sources in this repo. The shared module MUST set the
// message via textContent and MUST NOT build the toast body with
// innerHTML. The satellite pages that used to ship divergent local
// builders (one of which interpolated ${msg} straight into innerHTML)
// must delegate here rather than re-growing their own.
{
  const t = read('docs/pro/js/toast.js');
  ok('shared toast module sets the message via textContent',
    /msg\.textContent\s*=\s*message/.test(t));
  ok('shared toast module never assigns innerHTML',
    !/\.innerHTML\s*=/.test(t));
  ok('shared toast module registers dismiss via addEventListener (no inline on*=)',
    /close\.addEventListener\('click'/.test(t) && !/\son[a-z]+\s*=\s*["']/.test(t));
  ok('shared toast module yields to a page that already owns window.showToast',
    /if\s*\(window\.showToast\)\s*return;/.test(t));

  // The satellite pages must load the shared module...
  const SATELLITES = [
    'docs/pro/ai-tool-finder.html', 'docs/pro/analytics.html',
    'docs/pro/understand.html', 'docs/pro/photo-review.html',
    'docs/pro/vault.html', 'docs/pro/daily-success/index.html',
  ];
  for (const rel of SATELLITES) {
    ok(rel + ' loads the shared toast module',
      /<script src="\/pro\/js\/toast\.js/.test(read(rel)));
  }

  // ...and must not rebuild a local innerHTML toast body.
  ok('ai-tool-finder toast no longer interpolates the message into innerHTML',
    !/innerHTML\s*=\s*`[^`]*\$\{msg\}/.test(read('docs/pro/js/ai-tool-finder-page-2.js')));
}

// 3. pastel literals gone from the themed CRM surfaces
{
  const surfaces = [
    'docs/pro/js/crm-pipeline.js', 'docs/pro/customer.html',
    'docs/pro/js/notif-bell.js', 'docs/pro/js/activity-feed.js',
    'docs/pro/js/customer-ai-drafts-panel.js', 'docs/pro/js/customer-smart-followup-panel.js',
  ];
  const bad = [];
  for (const rel of surfaces) {
    read(rel).split(/\r?\n/).forEach((l, i) => {
      for (const hex of ['#cab8ff', '#5eead4', '#a890e8', '#a5b4fc']) {
        if (l.includes(hex)) bad.push(rel + ':' + (i + 1) + ' ' + hex);
      }
    });
  }
  ok('no dark-tuned pastel text literals on themed surfaces', bad.length === 0, firstFew(bad),
    'use a theme token instead: var(--t) for text, var(--m) muted, var(--blue)/var(--green)/var(--gold) for status tints');
}

// 4. RAF rule
{
  const s = read('docs/pro/js/dashboard-actions.js');
  ok('goTo() does not wrap initMainMap/initDrawMap in requestAnimationFrame',
    !/requestAnimationFrame\(\(\)=>\{ initMainMap\(\)/.test(s)
    && !/requestAnimationFrame\(\(\)=>\{ initDrawMap\(\)/.test(s));
  // Hotfix regression guard: the RAF removal once left a parenthesized
  // arrow function that PARSED but was never invoked — map/draw views never
  // initialized. The inits must be immediately-invoked.
  ok('map/draw view-inits are actually INVOKED (trailing () present)',
    /\(\(\)=>\{ initMainMap\(\); mapInited\.map=true;[^}]*\}\)\(\);/.test(s)
    && /\(\(\)=>\{ initDrawMap\(\); mapInited\.draw=true;[^}]*\}\)\(\);/.test(s));
}

// 5. invoice modals
{
  const s = read('docs/pro/js/invoice-pipeline.js');
  ok('invoice modals use surface tokens (no #14161a panels)', !s.includes('#14161a') || /var\(--s,#14161a\)/.test(s));
  ok('invoice overlays stay below the toast layer (no z-index:100000+)',
    !/z-index:10000[01]/.test(s));
}

// 6. estimate-v2 + command palette tokenized
ok('estimate-v2 UI surfaces are tokenized',
  /var\(--s,#111418\)/.test(read('docs/pro/js/estimate-v2-ui.js'))
  && /var\(--orange,#BD5728\)/.test(read('docs/pro/js/estimate-v2-ui.js')));
ok('command palette surfaces are tokenized',
  /var\(--s,#0f1729\)/.test(read('docs/pro/js/command-palette.js')));

// 7. interaction polish block
{
  const s = read('docs/pro/css/dashboard-app.css');
  ok('prefers-reduced-motion blanket gate present',
    /@media \(prefers-reduced-motion: reduce\)\{\s*\*,\*::before,\*::after\{animation-duration:\.001ms/.test(s));
  ok('shared focus-visible vocabulary present',
    /:where\(\.btn,\.crm-sec-btn,\.kview-btn/.test(s) && /toggle-switch input:focus-visible/.test(s));
  ok('desktop pressed-state rule present',
    /:where\(\.btn,\.hdr-tool,[^)]*\):active\{transform:scale\(\.97\)\}/.test(s));
}

// 8. portal aliases + close-board token
ok('portal.html aliases --green/--orange to nbd-brand tokens',
  /--green: var\(--nbd-success\)/.test(read('docs/pro/portal.html'))
  && /--orange: var\(--nbd-orange\)/.test(read('docs/pro/portal.html')));
// #1005 upgraded the literal to the tenant-brand accent (NBD default kept
// as the _dealBrand fallback) — the invariant is that the generated page
// still DEFINES --orange so its color-mix glow resolves.
ok('close-board generated page defines --orange for its color-mix glow',
  /:root\{--orange:\$\{BRAND\.accent\};\}/.test(read('docs/pro/js/close-board.js'))
  && /accent = [^;]*'#BD5728'/.test(read('docs/pro/js/close-board.js')));
ok('portal Cal.com embed uses light theme', /embed=true&theme=light/.test(read('docs/pro/js/portal.js')));

// 9. misc regressions
ok('photo empty state uses an emoji icon, not the word "Camera"',
  !/pe-empty-icon">Camera</.test(read('docs/pro/js/photo-engine.js')));
ok('search placeholder uses the muted token',
  /\.search-row input::placeholder\{color:var\(--m/.test(read('docs/pro/css/dashboard-app.css')));
ok('collapsed sidebar rail is scrollable',
  /body\.sidebar-collapsed \.sidebar\{[^}]*overflow-y:auto/.test(read('docs/pro/css/kanban-force.css').replace(/\n/g, '')));

// ── certification 2026-07-19 (post-ship interaction fixes) ──
{
  const pi = read('docs/pro/js/property-intel.js');
  ok('property-intel modals toggle the .open class (always-flex .modal-bg contract)',
    (pi.match(/classList\.add\('open'\)/g) || []).length >= 2
    && (pi.match(/classList\.remove\('open'\)/g) || []).length >= 2);
  const css = read('docs/pro/css/dashboard-app.css');
  ok('modal card entrance is scoped to the open state',
    /\.modal-bg\.open \.modal\{animation:modalSlideIn/.test(css)
    && !/\.modal \{\s*animation: modalSlideIn/.test(css));
  const cb = read('docs/pro/js/close-board.js');
  ok('deal-room send flows use the same brand resolver as the page',
    (cb.match(/const brand = _dealBrand\(\)\.name;/g) || []).length === 2);
  ok('deal-room generated style block is accent-tokenized (no bare #BD5728 rules)',
    !/color:#BD5728|background:#BD5728|solid #BD5728/.test(cb.slice(cb.indexOf('<style>'), cb.indexOf('</style>'))));
  ok('ann-bar honors prefers-reduced-motion',
    /prefers-reduced-motion/.test(read('docs/assets/js/ann-bar.js')));
  ok('collapsed-rail badges skip .dn and the health dot yields the corner',
    /\.nbadge:not\(\.dn\)/.test(read('docs/pro/css/kanban-force.css'))
    && /collapsed health dot yields the corner/.test(read('docs/pro/css/kanban-force.css')));
  ok('photos skeleton targets the real container id',
    /getElementById\('photoLeadsList'\)/.test(read('docs/pro/js/ui.js')));
  ok('every sidebar .ni item is keyboard-focusable',
    !/<div class="ni( active)?" data-action=/.test(read('docs/pro/dashboard.html')));
  ok('portal + estimate-view derive a readable foreground for tenant accents',
    /--nbd-ink-on-orange/.test(read('docs/pro/js/portal.js'))
    && /--nbd-ink-on-orange/.test(read('docs/pro/js/estimate-view.js')));
}

// 10. Banner z-index contract (2026-07-20).
// The two fixed status strips hardcoded 10006/10007 while the token scale
// stopped at --z-toast:10002 and advertised a 9500 "--z-banner" tier that
// had zero consumers. Runtime and documentation disagreed, and "fixing" it
// by wiring the strips to 9500 would have dropped them under every modal
// backdrop (--z-overlay:10000) — the silent demotion that got #1013 closed.
// Resolution: the strips were RIGHT, the scale was incomplete. These guards
// pin the ladder, the single source of truth, and the removed footgun.
{
  const css = read('docs/pro/css/dashboard-app.css');
  // Matches a definition (`--x:123;`) but never a `var(--x)` reference.
  const num = (src, name) => {
    const m = new RegExp('--' + name + ':\\s*(\\d+)\\s*;').exec(src);
    return m ? Number(m[1]) : NaN;
  };

  const LADDER = ['z-fab', 'z-overlay', 'z-overlay-top', 'z-toast',
    'z-banner-status', 'z-banner-alert'];
  const vals = LADDER.map((n) => num(css, n));
  ok('every layer of the documented ladder is defined',
    vals.every(Number.isFinite),
    LADDER.map((n, i) => n + '=' + vals[i]).join(' '));
  ok('ladder ascends: fab < overlay < overlay-top < toast < banner-status < banner-alert',
    vals.every((v, i) => i === 0 || v > vals[i - 1]), vals.join(' < '));

  // The deliberate layering call, asserted on its own so a future edit that
  // "tidies" the strips below the toast layer fails loudly here.
  ok('offline status strip sits ABOVE the toast layer (it annotates those toasts)',
    num(css, 'z-banner-status') > num(css, 'z-toast'));
  ok('status strips sit above the overlay layer (readable over an open modal)',
    num(css, 'z-banner-status') > num(css, 'z-overlay-top'));
  ok('delivery-health strip outranks the offline strip',
    num(css, 'z-banner-alert') > num(css, 'z-banner-status'));
  ok('no low "--z-banner" tier exists to re-demote the strips under modals',
    !/--z-banner:\s*\d+/.test(css));

  // One source of truth: the strips reference tokens, and the inline
  // fallback literal may not drift from the token it mirrors.
  const STRIPS = [
    ['docs/pro/js/offline-banner.js', 'z-banner-status'],
    ['docs/pro/js/alert-health-banner.js', 'z-banner-alert'],
  ];
  for (const [rel, token] of STRIPS) {
    const s = read(rel);
    const m = new RegExp('z-index:var\\(--' + token + ',\\s*(\\d+)\\)').exec(s);
    ok(rel + ' references var(--' + token + ')', !!m);
    ok(rel + ' fallback literal matches the token value',
      !!m && Number(m[1]) === num(css, token),
      m ? 'fallback=' + m[1] + ' token=' + num(css, token) : 'no var() reference');
    ok(rel + ' has no bare numeric z-index left', !/z-index:\s*\d/.test(s));
    ok(rel + ' uses no inline on*= handler', !/\son[a-z]+\s*=\s*["']/.test(s));
  }
  ok('alert-health dismiss is a delegated listener in the rendering file',
    /close\.addEventListener\('click'/.test(read('docs/pro/js/alert-health-banner.js')));

  // customer.html loads offline-banner.js but NOT dashboard-app.css, so its
  // inline mirror must carry the same value or the strip silently falls back
  // on that page alone.
  const cust = read('docs/pro/customer.html');
  ok('customer.html mirrors --z-banner-status at the canonical value',
    num(cust, 'z-banner-status') === num(css, 'z-banner-status'),
    'customer=' + num(cust, 'z-banner-status') + ' canonical=' + num(css, 'z-banner-status'));
  ok('customer.html mirror keeps the strip above that page\'s toast layer',
    num(cust, 'z-banner-status') > num(cust, 'z-toast'));
}

// 11. Guessed-token landmine class (2026-07-19 audit root cause, follow-up).
//     The audit's hard defects came from JS-rendered views naming compat
//     tokens (--h/--text/--surface/--muted) that only exist as :root aliases,
//     paired with dark-tuned hardcoded fallbacks. The base :root is a LIGHT
//     theme (--t:#1a1612), so a bare `var(--h,#fff)` renders white-on-white
//     the instant the alias is refactored away or the node renders detached.
//     Same trap for the undefined rep-side --accent(-weak): its literal
//     never tracks the theme/tenant accent. Canonical tokens (--t/--s/--m/
//     --orange) carry no such fallback, so rep-side JS must use them.
//     Allowlist: portal.js + before-after-slider.js run under portal.html's
//     locked nbd-brand.css, where --accent is the INTENDED tenant-injected
//     variable (portal.js:343 st.setProperty('--accent', ...)).
{
  const GUESSED = /var\(--(?:h|text|surface|muted|accent|accent-weak)\s*,\s*(?:#[0-9a-fA-F]{3,6}|rgba\()/;
  const ALLOW = new Set(['portal.js', 'before-after-slider.js']);
  const offenders = hits(GUESSED, jsFiles().filter((f) => !ALLOW.has(f)));
  ok('no rep-side JS renders a guessed compat token with a hardcoded color fallback',
    offenders.length === 0, firstFew(offenders),
    'use the canonical token with no literal fallback: --h/--text → var(--t), --surface → var(--s), --muted → var(--m), --accent → var(--orange), --accent-weak → color-mix(in srgb, var(--orange) 15%, transparent)');
}

// 12. Base overlay/toast z-index tier is TOKEN-WIRED (audit "z-index wiring").
//     The three canonical layers have exact tokens in dashboard-app.css
//     (--z-overlay:10000, --z-overlay-top:10001, --z-toast:10002). JS-rendered
//     overlays/toasts must reference the token (with the literal as fallback)
//     so the ladder has more than one consumer and can be reasoned about
//     centrally. A bare `z-index:10000/10001/10002` in JS is a regression.
//     (The ad-hoc higher tiers 10005-10600 and the "nuclear" 99xxx/999999/
//     maxint values are NOT asserted here — renumbering those against the
//     never-demote banner rule is a deliberate ladder decision, not a swap.)
{
  const BARE = /z-index:\s*1000[0-2](?![0-9])/;
  const bare = hits(BARE, jsFiles());
  ok('no JS renders a bare base-tier z-index (10000/10001/10002 must use the token)',
    bare.length === 0, firstFew(bare),
    'z-index:10000 → z-index:var(--z-overlay,10000); 10001 → var(--z-overlay-top,10001); 10002 → var(--z-toast,10002)');
}

// 13. Orange accent bypass (audit "~219 raw hexes bypass theme accents").
//     --orange is the THEME-ACCENT token — the 186 themes set it to blues,
//     greens, purples, etc., and dashboard-custom-theme.js / maps.js /
//     theme-gx.js override it at runtime. A property-value bare `#BD5728`
//     therefore stays NBD-orange on a blue/green theme while everything on
//     var(--orange) recolors. Property-value oranges must go through the
//     token (keeping #BD5728 as the fallback for any pre-theme surface).
//     Gradient stops / other-token fallbacks (`,#BD5728`) are out of scope
//     here — this guards only the clear `PROP:#BD5728` drift.
{
  const BAREHEX = /:\s*#BD5728\b/i;
  const bare = hits(BAREHEX, jsFiles());
  ok('no JS renders a bare property-value #BD5728 (orange must track the theme accent)',
    bare.length === 0, firstFew(bare),
    'color:#BD5728 → color:var(--orange,#BD5728) (same for background, border and fill)');
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) {
  console.log('\nFailures:');
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
