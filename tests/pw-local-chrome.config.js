// TEMPORARY, uncommitted: the installed Chrome (Playwright CDN is blocked here).
const base = require('./playwright.config.js');
const { devices } = require('@playwright/test');
module.exports = {
  ...base,
  retries: 0,
  projects: [{
    name: 'local-chrome',
    testMatch: /(phone-estimate-from-lead|phone-v3-wizard|phone-estimate-funnel|phone-customer|phone-estbuilder).spec.js/,
    use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  }],
};
