// TEMPORARY, uncommitted: the installed Chrome (Playwright CDN is blocked here).
const base = require('./playwright.config.js');
const { devices } = require('@playwright/test');
const match = process.env.PW_MATCH || 'phone-customer-order';
module.exports = {
  ...base,
  retries: 0,
  workers: 1,
  projects: [{
    name: 'local-chrome',
    testMatch: new RegExp('(' + match + ')\.spec\.js'),
    use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  }],
};
