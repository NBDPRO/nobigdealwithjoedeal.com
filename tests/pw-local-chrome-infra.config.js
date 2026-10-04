// TEMPORARY, uncommitted: the installed Chrome (Playwright CDN is blocked here).
const base = require('./playwright.config.js');
const { devices } = require('@playwright/test');
module.exports = {
  ...base,
  retries: 2,
  projects: [{
    name: 'local-chrome',
    use: { ...devices['Desktop Chrome'], launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  }],
};
