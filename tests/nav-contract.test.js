/* nav-contract.test.js
 *
 * The header, the mobile drawer and the Services dropdown, pinned.
 *
 * WHAT WENT WRONG (2026-09-08 nav reliability audit)
 * --------------------------------------------------
 * Every nav rule was hand-inlined into each page's <style> block. 233 copies
 * drifted into 6 different `.mobile-nav` variants; 46 files carried 2-4
 * competing definitions of it in the same file. Measured on WebKit at 320x508
 * (iPod touch), the shipped drawer was broken four ways at once:
 *
 *   - `top:70px` / `top:108px` were constants, but the header's real bottom
 *     edge moves between 70px and 129px as the announcement bar scrolls out
 *     from above a position:sticky nav. Every page was wrong at one scroll
 *     position or the other: 40-59px of the drawer hidden behind the header,
 *     or a 38px gap leaking page content through.
 *   - Nothing locked body scroll, so the page scrolled freely underneath the
 *     pinned drawer. Reported as "the slider moves but the page doesn't".
 *   - `.mobile-cta-strip` is fixed at z-index 999 — the drawer's z-index, and
 *     later in the DOM — so the Call/Text bar painted over the drawer's
 *     bottom, which is where Book Inspection lives.
 *   - Net effect: 6 of 32 links reachable without scrolling a position:fixed
 *     overflow container, the least reliable thing to ask of old iOS Safari.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS
 * -----------------------------------
 * Coverage is the assertion that would actually have caught the bug: 10 pages
 * (including the homepage) live outside the nbd:partial markers, so stamping
 * the partials reached 222 files and silently missed those. A gate that only
 * checked the partials would have been green while / was still broken.
 *
 * The z-index check compares PARSED NUMBERS from two real files rather than
 * grepping for a literal, so bumping .mobile-cta-strip to 1200 tomorrow fails
 * here instead of silently re-covering the drawer.
 *
 * Geometry itself is not assertable without a browser — that half lives in
 * tests/e2e/marketing.spec.js, which opens the drawer at 320x508 and measures
 * it. This file is the cheap always-runs half.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const read = (abs) => fs.readFileSync(abs, 'utf8');

let passed = 0, failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}
function group(name, fn) { console.log('\n' + name); fn(); }

/* Every .html under docs/, minus nothing — the drawer ships on marketing and
   on /pro alike, and /pro/blog is exactly where the second toggler lived. */
function walk(dir, out) {
  out = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const pages = walk(DOCS);
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

const navCssRel = 'docs/assets/css/nbd-nav.css';
const navJsRel = 'docs/assets/js/nbd-nav.js';
/* Strip /* … *​/ comments before matching. These files explain themselves at
   length, and those comments quote the very declarations under test (e.g.
   "max-height:calc(100vh - 70px)"), so matching raw text passes and fails for
   the wrong reasons. */
const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
/* Same trap on the JS side: these files document the very code they replaced
   ("It also called a.blur()…"), so an absence assertion matched the
   explanation and failed on a file that was already correct. Strip block
   comments and whole-line // comments; leave inline // alone so `https://`
   inside code is untouched. */
const decommentJs = (js) => decomment(js).replace(/^\s*\/\/.*$/gm, '');
const navCss = decomment(read(path.join(ROOT, navCssRel)));
const navJs = decommentJs(read(path.join(ROOT, navJsRel)));

/* The stripper is only safe on files with no regex literals — on `docs/pro/js`
   and `functions/` the same expression eats 10-48% of the source, because
   comment-looking sequences live inside regexes and strings. An ABSENCE
   assertion over a corpus missing the region it guards passes VACUOUSLY, which
   is worse than the defect it was written for. These four files have no regex
   literals, but that has to be asserted rather than assumed, or every
   "controller uses no optional chaining"-style check below is unfalsifiable. */
group('The comment stripper did not eat the code these assertions guard', () => {
  for (const [label, corpus, landmark] of [
    ['nbd-nav.css keeps its drawer rule', navCss, '#mobileNav.mobile-nav'],
    ['nbd-nav.css keeps its dropdown rule', navCss, '#navLinks .dropdown-menu'],
    ['nbd-nav.js keeps setOpen', navJs, 'function setOpen'],
    ['nbd-nav.js keeps initDropdowns', navJs, 'function initDropdowns'],
    ['nbd-nav.js keeps the scroll lock', navJs, 'function lockScroll'],
  ]) assert(label, corpus.indexOf(landmark) > -1, 'stripped corpus lost ' + landmark);
});

group('Coverage: every page with a drawer loads the one stylesheet and the one controller', () => {
  const withDrawer = pages.filter((p) => read(p).includes('id="mobileNav"'));
  assert('at least 200 pages carry a drawer (sanity: the scan found them)',
    withDrawer.length >= 200, 'found ' + withDrawer.length);

  const missingCss = withDrawer.filter((p) => !read(p).includes('/assets/css/nbd-nav.css'));
  const missingJs = withDrawer.filter((p) => !read(p).includes('/assets/js/nbd-nav.js'));

  assert('every drawer page links nbd-nav.css', missingCss.length === 0,
    missingCss.length + ' missing, e.g. ' + missingCss.slice(0, 5).map(rel).join(', '));
  assert('every drawer page loads nbd-nav.js', missingJs.length === 0,
    missingJs.length + ' missing, e.g. ' + missingJs.slice(0, 5).map(rel).join(', '));
});

group('nbd-nav.css is linked in <head>, exactly once (render-blocking perf, 2026-10-03)', () => {
  /* The four nav partials used to carry the <link> inside <nav>, i.e. mid-
     <body>: a stylesheet there blocks rendering of everything after it and
     can flash an unstyled header. It now lives once in each page's <head>
     (the nav rules are all #id-scoped, so moving it ahead of the page's own
     styles is cascade-neutral — measured: 0 computed-style diffs on every nav
     element at 390/1280 px, drawer open and closed). Scope: the marketing
     tree apply-partials governs; /pro, /admin and /dev are separate apps. */
  const NAV_LINK_RE = /<link\b[^>]*href="\/assets\/css\/nbd-nav\.css(?:\?[^"]*)?"[^>]*>/g;
  const marketing = pages.filter((p) => !/^docs\/(pro|admin|dev)\//.test(rel(p)));
  const scoped = marketing.filter((p) => {
    const html = read(p);
    return /<!--\s*nbd:partial\s+nav-(standard|blog|tool|microsite)\b/.test(html)
      || html.includes('/assets/css/nbd-nav.css');
  });
  // Positive controls: the scan found the partial pages AND the hand-authored
  // homepage, whose nav lives outside the markers.
  assert('at least 280 marketing pages carry a nav partial or link nbd-nav.css',
    scoped.length >= 280, 'found ' + scoped.length);
  assert('the homepage is in scope', scoped.some((p) => rel(p) === 'docs/index.html'));

  const bad = { missing: [], twice: [], body: [] };
  for (const p of scoped) {
    const html = read(p);
    const headEnd = html.indexOf('</head>');
    const links = [];
    let m;
    NAV_LINK_RE.lastIndex = 0;
    while ((m = NAV_LINK_RE.exec(html)) !== null) links.push(m.index);
    if (links.length === 0) bad.missing.push(rel(p));
    if (links.length > 1) bad.twice.push(rel(p) + ' x' + links.length);
    if (headEnd < 0 || links.some((i) => i > headEnd)) bad.body.push(rel(p));
  }
  assert('every nav page links nbd-nav.css', bad.missing.length === 0,
    bad.missing.length + ' missing, e.g. ' + bad.missing.slice(0, 5).join(', '));
  assert('no nav page links nbd-nav.css twice', bad.twice.length === 0,
    bad.twice.slice(0, 5).join(', '));
  assert('nbd-nav.css is never linked after </head> (no render-blocking mid-body link)',
    bad.body.length === 0, bad.body.length + ' page(s), e.g. ' + bad.body.slice(0, 5).join(', '));

  // The partials are stamped into <body>, so they must not carry it either —
  // re-adding it there would put it back mid-body on ~290 pages at once.
  for (const name of ['nav-standard', 'nav-blog', 'nav-tool', 'nav-microsite']) {
    const src = read(path.join(ROOT, 'site-src', 'partials', name + '.html'));
    assert('partial ' + name + ' does not link nbd-nav.css', !src.includes('nbd-nav.css'));
  }
});

group('Single owner: no page loads a second, competing drawer toggler', () => {
  /* Two togglers that both BIND to the hamburger cancel each other inside a
     single click dispatch — one sets open, the other toggles it straight
     back — and the hamburger dies with nothing in the console. Only these two
     ever bound a listener; they are retired.

     Deliberately NOT listed: inline/307ae4e90e.js, inline/72f02d79d0.js and
     inline/3117b8ac17.js. They define toggleMobileNav/closeMobileNav as bare
     globals and never bind them (the inline onclick that used to call them
     has been CSP-dead since the app CSP landed), so they cannot double-toggle.
     They DO still call closeMobileNav() from their smooth-scroll handler,
     which strips `.open` behind the controller's back — covered by the
     MutationObserver backstop asserted under "Scroll lock" below. Removing
     them would mean hand-editing @generated bundles that also carry the live
     smooth-scroll and back-to-top code, for no behavioural gain. */
  const RIVALS = ['assets/js/inline/479bd49556.js', 'assets/js/blog-nav.js'];
  for (const rival of RIVALS) {
    const offenders = pages.filter((p) => read(p).includes(rival));
    assert('no page loads ' + rival, offenders.length === 0,
      offenders.length + ' page(s), e.g. ' + offenders.slice(0, 5).map(rel).join(', '));
  }

  const doubled = pages.filter((p) => (read(p).match(/\/assets\/js\/nbd-nav\.js/g) || []).length > 1);
  assert('no page loads nbd-nav.js twice', doubled.length === 0,
    doubled.slice(0, 5).map(rel).join(', '));
});

group('Drawer CSS contract: the four properties that make it unbreakable', () => {
  const block = (navCss.match(/#mobileNav\.mobile-nav\s*\{[\s\S]*?\}/) || [''])[0];
  assert('#mobileNav.mobile-nav rule exists (id+class beats every inlined .mobile-nav copy)',
    block.length > 0);

  /* Full-viewport sheet: it cannot misalign with a header it never
     references. top+bottom rather than height:100vh — on iOS 100vh is the
     URL-bar-hidden height and overflows the real viewport. */
  assert('drawer is pinned to all four edges', /top:\s*0/.test(block) && /bottom:\s*0/.test(block)
    && /left:\s*0/.test(block) && /right:\s*0/.test(block));
  assert('drawer does not use 100vh for its height', !/height:\s*[^;]*100vh/.test(block));

  /* The per-page copies all carry max-height:calc(100vh - 70px). Pinning
     top/bottom does NOT beat it — max-height still clips the box, leaving the
     drawer 438px tall on a 508px screen with live page content underneath.
     This exact bug survived the first pass of the fix. */
  assert('drawer neutralises the inherited max-height', /max-height:\s*none/.test(block));

  assert('drawer contains its own scroll (no chaining to the page behind)',
    /overscroll-behavior:\s*contain/.test(block));
  assert('drawer reserves room for the header via a variable, with a fallback',
    /padding-top:\s*var\(--nbd-header-h,\s*\d+px\)/.test(block));
  assert('drawer paints a literal background, not a var() that some templates never define',
    /background:\s*#[0-9a-fA-F]{3,8}/.test(block));
});

group('Stacking order: header above drawer above the fixed CTA bar', () => {
  /* A selector can own several rules (.mobile-cta-strip has a bare
     `{display:none}` at the top of the file and the real one inside a media
     query). Scan every rule the selector opens and take the z-index that is
     actually declared, rather than whichever rule happens to match first. */
  const zOf = (css, sel) => {
    const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(esc + '\\s*[^{]*\\{([^}]*)\\}', 'g');
    let m, found = null;
    while ((m = re.exec(css)) !== null) {
      const z = m[1].match(/z-index:\s*(\d+)/);
      if (z) found = Number(z[1]);
    }
    return found;
  };
  const drawerZ = zOf(navCss, '#mobileNav.mobile-nav');
  const headerZ = zOf(navCss, 'nav#mainNav.nav');
  const ctaCss = decomment(read(path.join(DOCS, 'assets/css/mobile-cta.css')));
  const ctaZ = zOf(ctaCss, '.mobile-cta-strip');

  assert('all three z-indexes are parseable', drawerZ !== null && headerZ !== null && ctaZ !== null,
    'drawer=' + drawerZ + ' header=' + headerZ + ' cta=' + ctaZ);
  assert('drawer paints above the fixed Call/Text bar', drawerZ > ctaZ,
    'drawer=' + drawerZ + ' cta=' + ctaZ);
  assert('header paints above the drawer, so the X always closes it', headerZ > drawerZ,
    'header=' + headerZ + ' drawer=' + drawerZ);
  assert('the CTA bar is hidden outright while the drawer is open',
    /body\.nbd-nav-open[\s\S]*?\.mobile-cta-strip[\s\S]*?display:\s*none/.test(navCss));
});

group('Scroll lock: the reported symptom', () => {
  assert('CSS pins the body while the drawer is open',
    /body\.nbd-nav-open\s*\{[\s\S]*?position:\s*fixed/.test(navCss));
  assert('JS saves the scroll offset before locking',
    /savedScrollY\s*=\s*window\.pageYOffset/.test(navJs));
  assert('JS restores the scroll offset on close (or the page jumps to the top)',
    /jumpTo\(savedScrollY\)/.test(navJs) && /function jumpTo\(y\)/.test(navJs));

  /* The close path must not be guarded on a state transition. Three pages
     ship a legacy closeMobileNav() bound to the <a> itself; a target-phase
     listener on the link runs before the controller's bubble-phase listener
     on the drawer, so `.open` is already gone by the time setOpen(false)
     runs. A `if (isOpen() === open) return;` there leaves the body pinned
     with position:fixed and the page unrecoverably frozen. */
  assert('closing is never skipped by a transition guard',
    /if \(open && isOpen\(\)\) return;/.test(navJs) && !/if \(isOpen\(\) === open\) return;/.test(navJs));
  assert('a MutationObserver backstops any third party that strips .open',
    /MutationObserver/.test(navJs) && /attributeFilter: \['class'\]/.test(navJs));

  /* html{scroll-behavior:smooth} is set sitewide, so a bare scrollTo turns the
     restore into a half-second glide the reader watches — and an interrupted
     glide lands them somewhere they never chose. CI caught it mid-animation
     reading 410 and 68 against a saved offset of ~1200. */
  assert('the scroll restore is forced instant, not smooth',
    /scrollBehavior = 'auto'/.test(navJs) && /behavior: 'instant'/.test(navJs) && /jumpTo\(savedScrollY\)/.test(navJs));
});

group('The open animation must not move a full-viewport sheet', () => {
  /* nbd-mobile.css reveals .mobile-nav.open with
     `@keyframes nbdRevealIn{from{transform:translateY(-6px)}}`. Fine for a
     panel hanging below the header; on a sheet pinned to all four edges it
     lifts the bottom edge 6px INSIDE the viewport and shows live page content
     underneath for the length of the animation. CI measured the drawer's
     bottom at 502 against a 508px viewport. */
  const openBlock = (navCss.match(/#mobileNav\.mobile-nav\.open\s*\{[\s\S]*?\}/) || [''])[0];
  assert('the drawer overrides the translating reveal animation',
    /animation:\s*nbdNavFadeIn/.test(openBlock), 'open rule: ' + openBlock.slice(0, 120));
  const frames = (navCss.match(/@keyframes nbdNavFadeIn\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert('that animation changes opacity only — never transform',
    frames.length > 0 && /opacity/.test(frames) && !/transform/.test(frames));
});

group('Services dropdown: reachable on a laptop and on a touch screen', () => {
  /* 24 items render 993px tall; on a 1366x768 laptop that overflowed by
     311px with no max-height and no overflow, and the menu is
     position:absolute so there was nothing to scroll. */
  const block = (navCss.match(/#navLinks \.dropdown-menu\s*\{[\s\S]*?\}/) || [''])[0];
  assert('dropdown menu is height-capped', /max-height:/.test(block));
  assert('dropdown menu scrolls when capped', /overflow-y:\s*auto/.test(block));
  assert('an explicit .open state exists for touch and keyboard',
    /#navLinks \.dropdown\.open\s*>\s*\.dropdown-menu/.test(navCss));
  assert('JS actually sets .open (the CSS supported it for months; nothing set it)',
    /classList\.add\('open'\)/.test(navJs));
  assert('Escape closes the dropdown', /closeAllDropdowns/.test(navJs) && /Escape/.test(navJs));

  /* One owner. nav-faq.js used to toggle the dropdown from a document-level
     delegate while nbd-nav.js binds to the trigger itself: nbd-nav opened the
     menu in the target phase, the delegate then saw it open and closed it in
     the same click, so on any touch device wider than 900px the menu opened
     and vanished. */
  const faq = decommentJs(read(path.join(DOCS, 'assets/js/nav-faq.js')));
  assert('nav-faq.js no longer toggles the nav dropdown',
    !/classList\.contains\('dropdown'\)/.test(faq) && !/\.blur\(\)/.test(faq));
  assert('modifier-clicks on Services still open a new tab',
    /e\.metaKey \|\| e\.ctrlKey/.test(navJs));
});

group('Desktop dropdown and mobile drawer stay in sync', () => {
  /* The Roof Visualizer was in the mobile drawer and in neither the desktop
     dropdown nor the top-level nav, so a desktop visitor could not reach it
     from the header at all. It was fixed twice — once in the partial (177
     pages) and once by hand in docs/index.html, whose nav lives outside the
     markers. That "fix the partial, miss the homepage" split is the same gap
     that left / broken, so it gets an assertion rather than a memory. */
  const offenders = pages.filter((p) => {
    const html = read(p);
    const menu = html.match(/<ul class="dropdown-menu">[\s\S]*?<\/ul>/);
    if (!menu) return false;
    // Only menus that carry the tools group — nav-blog's is a services-only list.
    if (menu[0].indexOf('/roof-score') === -1) return false;
    return menu[0].indexOf('/visualizer') === -1;
  });
  assert('every desktop tools dropdown offers the Roof Visualizer', offenders.length === 0,
    offenders.length + ' page(s), e.g. ' + offenders.slice(0, 5).map(rel).join(', '));
});

group('Old-device rendering: things that silently no-op on iOS 12', () => {
  assert('sticky header carries the -webkit- prefix (iOS <= 12.5 ignores the bare value)',
    /position:\s*-webkit-sticky/.test(navCss));
  assert('hamburger bar spacing survives without flex gap (iOS < 14.1)',
    /#hamburger\.hamburger\s*>\s*span \+ span\s*\{[^}]*margin-top:\s*6px/.test(navCss));
  assert('drawer rows meet the 44px tap minimum',
    /#mobileNav\.mobile-nav a\s*\{[^}]*min-height:\s*44px/.test(navCss));
  assert('drawer section headers get a literal colour, not an undefined token',
    /#mobileNav\.mobile-nav \.mnav-group\s*\{[^}]*color:\s*#[0-9a-fA-F]{3,6}/.test(navCss));
});

group('Old-Safari floor: iOS 12 must parse and run this', () => {
  /* A syntax error in the controller is not a degraded menu — it is no menu.
     Optional chaining is Safari 13.4+, nullish coalescing 14+. */
  assert('controller uses no optional chaining', !/[^/*]\?\./.test(navJs.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert('controller uses no nullish coalescing', !/\?\?/.test(navJs.replace(/\/\*[\s\S]*?\*\//g, '')));
  assert('stylesheet avoids the inset shorthand (iOS 14.1+)', !/^\s*inset:/m.test(navCss));
  assert('stylesheet avoids dvh/svh/lvh units (iOS 15.4+)', !/\d(dvh|svh|lvh)/.test(navCss));
  /* NodeList.forEach is fine on iOS 12, but the old toggler called it on the
     result of querySelectorAll and would throw partway through setOpen,
     leaving the button stuck as an X. Indexing cannot half-fail. */
  assert('controller indexes the hamburger bars rather than iterating them',
    /bars\[0\]/.test(navJs) && !/bars\.forEach/.test(navJs));
});

group('Drawer close paths: every way out of the sheet', () => {
  for (const [label, re] of [
    ['Escape closes the drawer', /e\.key === 'Escape'/],
    ['tapping outside closes it', /if \(mn\.contains\(t\)\) return;/],
    ['following a link closes it', /t\.closest\('a'\)/],
    ['growing past the mobile breakpoint closes it', /window\.innerWidth > MOBILE_MAX/],
    ['bfcache restore resets it', /'pageshow'/],
    ['hash navigation closes it', /'hashchange'/],
  ]) assert(label, re.test(navJs));
});

// Exact restore (2026-10-02): a close that navigates nowhere (hamburger,
// Escape, tap outside) re-applies ANY drift; only a drawer-link close keeps
// the near-0-only rule so a link's own smooth scroll to a section is never
// fought. CI mobile WebKit landed 55-72 px off with the near-0-only rule.
console.log('\nExact scroll restore');
assert('a drawer link marks its close as navigational', /closest\('a'\)\) \{ closingViaLink = true; setOpen\(false\); \}/.test(navJs));
assert('unlockScroll reads and clears the link flag', /var exact = !closingViaLink;\s*closingViaLink = false;/.test(navJs));
assert('re-apply is exact (any drift) unless a link closed it', /if \(exact \? Math\.abs\(at - target\) <= 2 : at > 2\) return;/.test(navJs));
assert('the reader scrolling themselves always wins', /if \(userMoved\) return;/.test(navJs));

console.log('\n' + '─'.repeat(50));
console.log(passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
