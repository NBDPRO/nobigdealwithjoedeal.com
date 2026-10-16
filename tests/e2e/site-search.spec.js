// @ts-check
// Site search (Pagefind, 2026-10-16): /search finds the homeowner pages, with
// typos, under the page's REAL CSP (this file does not bypass it: the point is
// that 'wasm-unsafe-eval' on /search and /pagefind/** is enough, and only
// there). Runs on Chromium AND mobile WebKit (iPhone SE: the iOS Safari check).
//
// Needs the index: `node scripts/build-site-search.mjs` writes docs/pagefind
// (ci.yml public-e2e builds it before this spec; the deploy builds it too).
const { test, expect } = require('@playwright/test');

test.use({ bypassCSP: false });

async function search(page, q) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.disposition + ' ' + e.effectiveDirective + ' ' + e.blockedURI + ' ' + (e.sample || '').slice(0, 40)));
  });
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    return /^(127\.0\.0\.1|localhost)$/.test(u.hostname) ? route.continue() : route.abort();
  });
  await page.goto('/search?q=' + encodeURIComponent(q));
  const first = page.locator('pagefind-results a[href]').first();
  await expect(first).toBeVisible({ timeout: 15_000 });
  const hrefs = await page.locator('pagefind-results a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  const csp = await page.evaluate(() => window.__csp);
  return { hrefs, csp, errors };
}

test('a homeowner question finds the right pages, under the real CSP', async ({ page }) => {
  const r = await search(page, 'gutter cleaning');
  expect(r.hrefs.some((h) => /\/services\/gutter-cleaning/.test(h)), r.hrefs.join(' ')).toBe(true);
  expect(r.csp.filter((v) => /^enforce /.test(v)), 'nothing blocked by the CSP on /search').toEqual([]);
  expect(r.csp.filter((v) => /^report style-src-attr/.test(v)), 'no style-attribute report flood (Report-Only here = the enforced policy)').toEqual([]);
});

test('a town + service question finds that town ("florence gutters")', async ({ page }) => {
  const r = await search(page, 'florence gutters');
  expect(r.hrefs.some((h) => /gutter-replacement-florence-ky/.test(h)), r.hrefs.join(' ')).toBe(true);
});

test('the CRM is never in public search', async ({ page }) => {
  const r = await search(page, 'roof');
  expect(r.hrefs.length).toBeGreaterThan(0);
  expect(r.hrefs.filter((h) => /^\/?(pro|admin|sites|tools|dev)\b|\/pro\//.test(h.replace(/^https?:\/\/[^/]+/, ''))), 'no private paths').toEqual([]);
});

test('only /search and /pagefind/** carry wasm-unsafe-eval', async ({ request }) => {
  const csp = async (p) => (await request.get(p)).headers()['content-security-policy'] || '';
  const home = await csp('/');
  test.skip(!home, 'this server sends no firebase.json headers (Windows hosting emulator)');
  expect(await csp('/search')).toContain("'wasm-unsafe-eval'");
  expect(await csp('/pagefind/pagefind-worker.js')).toContain("'wasm-unsafe-eval'");
  expect(home).not.toContain('wasm-unsafe-eval');
  expect(await csp('/inspect')).not.toContain('wasm-unsafe-eval');
});

test('the header links to search; the drawer starts with it', async ({ page }) => {
  await page.goto('/about');
  const desktop = page.locator('#navLinks .nav-search');
  const drawer = page.locator('#mobileNav .mnav-search');
  await expect(desktop).toHaveAttribute('href', '/search');
  await expect(drawer).toHaveAttribute('href', '/search');
  await expect(desktop).toHaveAttribute('aria-label', 'Search the site');
});
