// @ts-check
// Tenant filename prefix — the customer-facing leak fix (2026-09-06).
//
// Five renderers hardcoded 'NBD-' as the PDF filename prefix, and
// functions/render-pdf.js takes the filename FROM THE CLIENT — so a non-NBD
// contractor's estimate, photo report and rep report all reached their
// homeowner named "NBD-…". Static assertions can prove the hardcoded string is
// gone; only a real signed-in tenant proves the RESOLVER returns that tenant's
// own prefix rather than 'NBD'.
//
// The seeded emulator tenant is "E2E Test Roofing" with no reserved docPrefix,
// so company-profile.js derives one (tests/cust-id-prefix.test.js pins the
// derivation). Whatever it derives, the one answer that must never appear is
// 'NBD' — that is the leak.
//
// Runs in the emulator harness: npm run test:e2e:authed:emu

const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate } = require('./fixtures/auth');

test.describe('tenant filename prefix — no NBD leak for a non-NBD tenant @engines', () => {
  test('the resolver returns the tenant prefix, never NBD', async ({ page }) => {
    const creds = requireTestUser(test);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

    await loginAs(page, creds);
    await page.waitForFunction(() => typeof window._tenantFilePrefix === 'function', null, { timeout: 20_000 });

    const r = await safeEvaluate(page, async () => {
      // The helper awaits company-profile hydration itself — that is the whole
      // point of it being async, so call it exactly as the renderers do.
      const prefix = await window._tenantFilePrefix();
      const name = await window._tenantFileName('HomeownerReport-smith-2026-09-06.pdf');
      return {
        prefix,
        name,
        hydrated: window._companyProfileLoaded === true,
        custIdPrefix: typeof window._custIdPrefix === 'function' ? window._custIdPrefix() : null,
      };
    });

    // The seeded tenant is NOT the NBD platform tenant.
    expect(r.hydrated, 'company profile must hydrate for the prefix to be trustworthy').toBe(true);
    expect(r.prefix, 'a hydrated non-NBD tenant must resolve a real prefix').toBeTruthy();
    expect(r.prefix, 'THE LEAK: a non-NBD tenant resolved to the platform prefix').not.toBe('NBD');
    expect(r.prefix, 'the helper must agree with the customer-ID resolver').toBe(r.custIdPrefix);

    // …and the filename actually carries it.
    expect(r.name.startsWith(r.prefix + '-'), 'filename must carry the tenant prefix, got: ' + r.name).toBe(true);
    expect(r.name.startsWith('NBD-'), 'THE LEAK: filename still NBD-branded').toBe(false);
    expect(r.name.endsWith('.pdf')).toBe(true);

    expect(errors).toEqual([]);
  });

  test('an unhydrated profile yields no prefix rather than guessing NBD', async ({ page }) => {
    const creds = requireTestUser(test);
    await loginAs(page, creds);
    await page.waitForFunction(() => typeof window._tenantFilePrefix === 'function', null, { timeout: 20_000 });

    // Simulate the failure mode that made the naive fix dangerous: hydration
    // never completes (getDoc throws and is swallowed). The helper must return
    // '' and the filename must go out UNPREFIXED — never 'NBD-'.
    const r = await safeEvaluate(page, async () => {
      const realLoad = window._loadCompanyProfile;
      const realLoaded = window._companyProfileLoaded;
      try {
        window._companyProfileLoaded = false;
        window._loadCompanyProfile = async () => { /* never sets the flag */ };
        const prefix = await window._tenantFilePrefix();
        const name = await window._tenantFileName('Estimate-smith-42.pdf');
        return { prefix, name };
      } finally {
        window._loadCompanyProfile = realLoad;
        window._companyProfileLoaded = realLoaded;
      }
    });

    expect(r.prefix, 'unknown brand must yield an empty prefix').toBe('');
    expect(r.name, 'and an unprefixed — not NBD-prefixed — filename').toBe('Estimate-smith-42.pdf');
    expect(r.name.startsWith('NBD'), 'guessing NBD here is the original bug').toBe(false);
  });
});
