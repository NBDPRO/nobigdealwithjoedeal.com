// @ts-check
// Playwright config for NBD Pro smoke/E2E tests.
//
// Target: the live production site by default so we can verify what
// real users see. Set PLAYWRIGHT_BASE_URL to run against a local server
// (e.g. `firebase serve` on http://localhost:5000).
//
// Run:     npm --prefix tests run test:e2e
// Headed:  npm --prefix tests run test:e2e:headed
// Specific: npx playwright test --grep "pricing"

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // A stray test.only / describe.only committed to a spec would silently
  // shrink a CI shard to that one test while the job stays green.
  forbidOnly: !!process.env.CI,
  // 2 (was 3, 2026-10-03). 3 was raised on 2026-07-05 when the Java
  // Firestore emulator dropped reads ('client is offline') under the
  // 16-journey single-session load; the shard split and the race fixes since
  // (#842, #912) took that load off, and 4 attempts per test was enough to
  // hide a genuinely intermittent product bug. 2 still absorbs a one-off
  // emulator hiccup; going to 1 in one step would invite a flake wave.
  retries: process.env.CI ? 2 : 0,
  // A pass-on-retry must be VISIBLE, not just green. 'line' prints the
  // "N flaky" summary with each flaky test named; 'github' adds a job
  // annotation per failed/flaky test so it shows on the PR checks page.
  reporter: process.env.CI ? [['line'], ['github']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'https://nobigdealwithjoedeal.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // Service workers are blocked in E2E. Every test context starts with a
    // pristine profile, so the first dashboard load installs /pro/sw.js
    // fresh; when the new SW takes control, dashboard-sw-bootstrap.js's
    // controllerchange handler reloads the page once, and that reload races
    // the spec's first post-login page.evaluate ("Execution context was
    // destroyed", reproduced 2026-07-06 on the emulator run). No spec
    // exercises the SW (sw.js is covered statically by pwa-manifest.test.js
    // and the smoke suite), and the app fully supports SW-less operation
    // (?nosw=1 kill-switch), so blocking registration is the deterministic
    // fix. Registration fails into the bootstrap's .catch → console.warn.
    serviceWorkers: 'block',
    // Emulator mode: the hosting emulator serves the PRODUCTION security
    // headers from firebase.json, and that CSP's connect-src has no
    // carve-out for the local emulator ports (127.0.0.1:9099 auth /
    // :8080 firestore — 'self' only covers :5000). The browser refuses the
    // SDK's sign-in and Firestore calls, so login can never complete.
    // Bypass CSP only when targeting a local server; prod-targeted runs
    // (Path A) keep the real policy enforced.
    ...(/^https?:\/\/(127\.0\.0\.1|localhost)([:/]|$)/.test(process.env.PLAYWRIGHT_BASE_URL || '')
      ? { bypassCSP: true }
      : {}),
    // Escape hatches for sandboxed environments (no effect when unset):
    // - PLAYWRIGHT_CHROMIUM_PATH: use a pre-installed Chromium when the
    //   pinned browser build can't be downloaded.
    // - PLAYWRIGHT_PROXY_SERVER: route browser traffic through an egress
    //   proxy (with 127.0.0.1 bypassed so emulator traffic stays direct).
    //   Implies ignoreHTTPSErrors because such proxies MITM TLS with a CA
    //   Chromium doesn't trust — never set this against production.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
    ...(process.env.PLAYWRIGHT_PROXY_SERVER
      ? {
          proxy: { server: process.env.PLAYWRIGHT_PROXY_SERVER, bypass: '127.0.0.1,localhost' },
          ignoreHTTPSErrors: true,
        }
      : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // nav-drawer runs on WebKit only — see below.
      testIgnore: /nav-drawer\.spec\.js/,
    },
    {
      // The mobile drawer was reported broken on an iPod touch, and the whole
      // failure class is iOS-shaped: 100vh meaning the URL-bar-hidden height,
      // position:fixed overflow containers that do not scroll reliably, and
      // body{overflow:hidden} being ignored as a scroll lock. Chromium hides
      // every one of those. Until 2026-09-08 this repo ran Desktop Chrome
      // only, so no gate could have reproduced the report at all.
      //
      // Scoped to the one spec so the existing suite's timing and flake
      // profile are untouched, and sized to an iPod touch minus Safari's
      // chrome — the smallest screen the site has to serve.
      name: 'mobile-webkit',
      testMatch: /nav-drawer\.spec\.js/,
      use: {
        ...devices['iPhone SE'],
        viewport: { width: 320, height: 508 },
      },
    },
    // Uncomment to expand browser coverage once the smoke suite is stable:
    // { name: 'webkit',  use: { ...devices['Desktop Safari']  } },
    // { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});
