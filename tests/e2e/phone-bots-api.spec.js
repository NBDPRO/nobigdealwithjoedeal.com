/**
 * tests/e2e/phone-bots-api.spec.js — Settings → Bots & API at phone size
 * (390 × 844), 2026-10-04. A company owner connects their OWN bot:
 *
 *   - opens Settings on the Bots & API tab (?settings=bots)
 *   - makes a bot (name, what it does, starter tools)
 *   - creates its key: shown ONCE, copyable; after "I saved it" only the
 *     9-character prefix is left on the page
 *   - the key really works: tools/list on the bot connection (the functions
 *     emulator's crmMcp) answers with exactly the bot's tools
 *   - revokes it: the row goes, and the connection refuses the key (401)
 *   - removes the bot; no horizontal overflow at 390 px
 *
 * Needs the FUNCTIONS emulator (real callables + crmMcp), so it runs in the
 * functions shard. @stranger — Authed E2E (emulators) job, NBD_EMU_FUNCTIONS=1.
 * The seeded E2E owner is a non-NBD company on an active Growth plan.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeWaitForFunction } = require('./fixtures/auth');
const { installLocalSdkShim } = require('./fixtures/local-sdk');

const MCP = 'http://127.0.0.1:5001/nobigdeal-pro/us-central1/crmMcp';

async function mcp(key, method) {
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
  });
  let body = null;
  try { body = await r.json(); } catch (_) { body = null; }
  return { status: r.status, body };
}

test.describe.serial('Bots & API — an owner connects their own bot @stranger', () => {
  test('make a bot, see its key once, use it, revoke it (390 × 844)', async ({ page }) => {
    test.setTimeout(180_000);
    const creds = requireTestUser();
    await installLocalSdkShim(page);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {} });
    // Revoke / remove ask first: the browser's confirm here (the installed
    // app uses its own dialog — handled by confirmIfAsked too).
    page.on('dialog', (d) => d.accept());
    const confirmIfAsked = async () => { const okBtn = page.locator('.sa-btn-ok'); try { await okBtn.waitFor({ state: 'visible', timeout: 2000 }); await okBtn.click(); } catch (_) { /* native dialog, already accepted */ } };
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!window._user && !!window._functions && typeof window.goTo === 'function', null, { timeout: 30_000 });

    await page.goto('/pro/dashboard.html?settings=bots');
    await expect(page.locator('#stab-panel-bots')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#agentBotsMount .ab-h2')).toContainText('Bots & API', { timeout: 30_000 });
    await expect(page.locator('#agentBotsMount')).toContainText('Nothing a bot does is ever sent to a customer');
    // A non-NBD company never sees NBD's house team.
    await expect(page.locator('#agentBotsMount')).not.toContainText('NBD house team');

    const name = 'E2E Bot ' + Date.now().toString(36);
    await page.locator('#abBotName').fill(name);
    await page.locator('#abBotRole').fill('Finds customers who went quiet');
    // Opening the tab loads it more than once (deep link, goTo's tab timer,
    // the hashchange re-entry), and a render that lands after the owner typed
    // used to wipe the form — "Create bot" then stopped at "Give the bot a
    // name" (this spec, red on main 2026-10-05). Force one more render now,
    // deterministically, and the typing must survive it.
    const reloaded = page.waitForResponse((r) => /\/listAgentKeys$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 30_000 });
    await page.evaluate(() => window.switchSettingsTab('bots'));
    await reloaded;
    await expect(page.locator('#abBotName')).toHaveValue(name);
    await expect(page.locator('#abBotRole')).toHaveValue('Finds customers who went quiet');
    await page.locator('#abMkBot').click();
    const card = page.locator('.ab-bot', { hasText: name });
    await expect(card).toBeVisible({ timeout: 30_000 });
    const toolCount = await page.locator('input[name="abTool"]:checked').count();

    await card.locator('[data-ab-act="mkkey"]').click();
    const fresh = page.locator('#abFreshKey');
    await expect(fresh).toBeVisible({ timeout: 30_000 });
    const key = (await fresh.textContent() || '').trim();
    expect(key, 'a key is shown').toMatch(/^nbdk_[A-Za-z0-9_-]{20,80}$/);
    await expect(page.locator('#abFresh')).toContainText('shown once');

    // The key works against the real connection, with exactly the bot's tools.
    const listed = await mcp(key, 'tools/list');
    expect(listed.status, JSON.stringify(listed.body)).toBe(200);
    expect(listed.body.result.tools.length).toBe(toolCount);
    const init = await mcp(key, 'initialize');
    expect(init.body.result.instructions).toContain(name);
    expect(init.body.result.instructions).not.toMatch(/\bJo\b|Jo's|Quinn/);

    // "I saved it": the key is gone from the page for good — only its prefix.
    await page.locator('[data-ab-act="hidekey"]').click();
    await expect(page.locator('#abFreshKey')).toHaveCount(0);
    await expect(card).toContainText(key.slice(0, 9) + '…');
    expect(await page.content(), 'the full key never stays on the page').not.toContain(key);

    // Phone fit: nothing wider than the screen.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'no horizontal overflow at 390 px').toBeLessThanOrEqual(1);
    const tap = await card.locator('[data-ab-act="revoke"]').boundingBox();
    expect(tap && tap.height, 'Revoke is a 44px tap target').toBeGreaterThanOrEqual(43);

    // Revoke (confirm in the app's own dialog).
    await card.locator('[data-ab-act="revoke"]').click();
    await confirmIfAsked();
    await expect(card.locator('[data-ab-act="revoke"]')).toHaveCount(0, { timeout: 30_000 });
    const after = await mcp(key, 'tools/list');
    expect(after.status, 'a revoked key is refused').toBe(401);

    // Clean up: remove the bot.
    await card.locator('[data-ab-act="rmbot"]').click();
    await confirmIfAsked();
    await expect(page.locator('.ab-bot', { hasText: name })).toHaveCount(0, { timeout: 30_000 });
  });
});
