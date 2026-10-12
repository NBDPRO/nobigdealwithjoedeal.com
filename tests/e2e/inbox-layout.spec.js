/**
 * tests/e2e/inbox-layout.spec.js — L05 Triage Inbox end to end on the emulators
 * (2026-10-12, D6 of the style integration).
 *
 * A signed-in rep who chose the Triage Inbox sees the people who need a reply
 * (one row per person, with a reply-by timer chip), a thread with the real
 * sms_log history, a DRAFTED reply in a composer, and the customer's facts.
 * J/K move, R replies, Esc leaves the composer, and NO hotkey fires while
 * typing in the composer. Send goes through the existing phone-share path
 * (consent / STOP / quiet-hours check first): with the server unreachable it is
 * refused and nothing opens. A missing feed is a banner with Retry, never an
 * empty list. Pipeline is the same layout grouped by stage.
 *
 * Desktop 1280 on a light theme (daylight), then iPhone width 390 on a dark one
 * (midnight). Nothing is sent to anyone.
 *
 * @shard2 — runs in the Authed E2E (emulators) job.
 */
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

function adb() {
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  return getFirestore();
}

async function seed(page, tag) {
  const uid = await safeEvaluate(page, () => window._user.uid);
  const companyId = await safeEvaluate(page, () => (window._userClaims || {}).companyId || null);
  const s = Date.now();
  const leadId = await safeEvaluate(page, (a) => window._saveLead({
    firstName: 'ZZIB' + a.tag, lastName: 'Reply' + a.s, address: '9 Inbox Ln, Mason, OH 45040', phone: '5135550188', stage: 'new',
  }), { tag, s });
  expect(leadId).toBeTruthy();
  const db = adb();
  const { Timestamp } = require('firebase-admin/firestore');
  const t = (minsAgo) => Timestamp.fromMillis(Date.now() - minsAgo * 60000);
  await db.collection('phone_text_days').doc('txt_20261012_' + s).set({
    userId: uid, companyId, leadId, startedAtMs: Date.now() - 12 * 60000, channel: 'text', phoneDigits: '5135550188',
    summary: 'Asked if someone can come Friday.', messageCount: 2, status: 'noted',
    promises: [{ who: 'jo', text: 'Reply today' }], e2eTestData: true,
  });
  await db.collection('sms_log').add({
    uid, companyId, leadId, date: t(15), sentAt: t(15), body: 'Hi, this is the first text from the office.', direction: 'outbound', status: 'sent', e2eTestData: true,
  });
  await db.collection('sms_log').add({
    uid, companyId, leadId, date: t(12), sentAt: t(12), body: 'Can someone come out Friday morning?', direction: 'inbound', status: 'received', e2eTestData: true,
  });
  return { leadId, s, uid };
}

async function chooseInbox(page, device) {
  const saved = await safeEvaluate(page, (d) => window.LayoutEngine.saveUser({ id: 'inbox', device: d }), device);
  expect(saved.saved).toBe(true);
  await page.reload();
  await safeWaitForFunction(page, () => document.documentElement.getAttribute('data-layout') === 'inbox' && !!document.getElementById('nbdInboxRoot'), null, { timeout: 40_000 });
}
async function setTheme(page, theme) {
  await safeEvaluate(page, () => window.ScriptLoader && window.ScriptLoader.loadBundle ? window.ScriptLoader.loadBundle('theme') : null);
  await safeWaitForFunction(page, () => !!(window.ThemeEngine && window.ThemeEngine.apply), null, { timeout: 30_000 });
  await safeEvaluate(page, (t) => { window.ThemeEngine.apply(t, false); }, theme);
  await safeWaitForFunction(page, (t) => document.documentElement.getAttribute('data-theme') === t, theme, { timeout: 10_000 });
}

test.describe.serial('Triage Inbox @shard2', () => {
  test('desktop, light theme: list -> thread -> draft -> keys never fire while typing -> send is gated -> pipeline', async ({ page }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    // the server is unreachable: the consent check cannot be answered, so nothing may be handed to Messages
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });
    const { leadId } = await seed(page, 'D');
    await chooseInbox(page, 'desktop');
    await setTheme(page, 'daylight');

    // the person needing a reply is in the list, once, with a timer chip
    const row = page.locator('.ib-row', { hasText: 'ZZIBD' }).first();
    await row.waitFor({ state: 'visible', timeout: 60_000 });
    expect(await page.locator('.ib-row', { hasText: 'ZZIBD' }).count()).toBe(1);
    await expect(row.locator('[data-ib-timer]')).toBeVisible();
    expect(await row.locator('[data-ib-timer]').getAttribute('class')).toMatch(/ib-timer-(red|gold|green)/);
    // visible shortcut legend
    await expect(page.locator('.ib-legend')).toContainText('J');
    await expect(page.locator('.ib-legend')).toContainText('snooze');

    // positive control for the seed: the same rows the thread reads are really there for this rep
    const seeded = await safeEvaluate(page, async (a) => {
      const snap = await window.getDocs(window.query(window.collection(window.db, 'sms_log'),
        window.where('leadId', '==', a.leadId), window.where('uid', '==', window._user.uid), window.orderBy('date', 'desc'), window.limit(30)));
      return { n: snap.size, claims: { role: (window._userClaims || {}).role || null, companyId: (window._userClaims || {}).companyId || null, owner: (window._userClaims || {}).owner === true } };
    }, { leadId });
    console.log('[inbox-e2e] sms_log rows visible to the rep: ' + JSON.stringify(seeded));
    expect(seeded.n).toBe(2);

    // surfaces are solid (glass off) and the thread is the real sms_log history
    await row.click();
    await expect(page.locator('.ib-banner')).toHaveCount(0);
    await expect(page.locator('.ib-bubble', { hasText: 'Can someone come out Friday morning?' })).toBeVisible({ timeout: 20_000 });
    const solid = await safeEvaluate(page, () => {
      const q = (s) => getComputedStyle(document.querySelector(s));
      return ['.ib-list', '.ib-thread', '.ib-side'].map((s) => q(s).backdropFilter || q(s).webkitBackdropFilter || 'none');
    });
    expect(solid.every((v) => v === 'none')).toBe(true);

    // the composer holds a DRAFT; nothing was sent
    const ta = page.locator('#ibComposer');
    await expect(ta).toHaveValue(/thanks for reaching out|got your message/);
    await expect(page.locator('.ib-comp-k')).toContainText('nothing is sent until you press Send');

    // R focuses the composer; typing J / K / E / S there is just typing
    const before = await page.locator('.ib-row.is-on .ib-name').innerText();
    await page.keyboard.press('r');
    await expect(ta).toBeFocused();
    await ta.fill('');
    await page.keyboard.type('jkes ok');
    await expect(ta).toHaveValue('jkes ok');
    expect(await page.locator('.ib-row.is-on .ib-name').innerText()).toBe(before);
    expect(await page.locator('#nbd-snooze-overlay').count()).toBe(0);
    await page.keyboard.press('Escape');
    await expect(ta).not.toBeFocused();

    // Send is gated by the server's consent check (unreachable here): refused, nothing handed to Messages
    const urlBefore = page.url();
    await page.locator('[data-ib="send"]').click();
    await expect(page.locator('#toastContainer, .toast').first()).toBeVisible({ timeout: 15_000 });
    expect(page.url()).toBe(urlBefore);
    await expect(page.locator('#ibComposer')).toHaveValue('jkes ok');

    // J / K move between people when focus is not in a field
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    await expect(page.locator('.ib-row.is-on')).toHaveCount(1);

    // facts + quick actions
    await expect(page.locator('.ib-side')).toContainText('(513) 555-0188');
    await expect(page.locator('.ib-side [data-lk-link="call"]')).toHaveAttribute('href', 'tel:+15135550188');
    expect(await page.locator('.ib-side [data-lk-link="text"]').count()).toBe(0);

    // a failed feed is said out loud (the shared "needs you" rule missing => banner + retry, not an empty list)
    await safeEvaluate(page, async () => { window.__ibHA = window.NBDHomeAttention; window.NBDHomeAttention = undefined; await window.NBDInbox.reload(); });
    await expect(page.locator('.ib-banner[role="alert"]')).toContainText('needs-you rule not loaded');
    await expect(page.locator('.ib-list')).not.toContainText('Nothing needs a reply');
    await safeEvaluate(page, () => { window.NBDHomeAttention = window.__ibHA; });
    await page.locator('[data-ib="reload"]').click();
    await expect(page.locator('.ib-banner')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.locator('.ib-row', { hasText: 'ZZIBD' })).toHaveCount(1);

    // pipeline: the same three panes, grouped by stage
    await page.locator('[data-ib="pane"][data-pane="pipeline"]').click();
    await expect(page.locator('.ib-stage').first()).toBeVisible();
    const lead = page.locator('.ib-row-lead', { hasText: 'ZZIBD' }).first();
    await lead.click();
    await expect(page.locator('.ib-title')).toContainText('ZZIBD');
    await expect(page.locator('.ib-side')).toContainText('Stage');
    expect(leadId).toBeTruthy();
  });

  test('iPhone width, dark theme: list, then one thread at a time, 56px targets, no sideways scroll', async ({ page }) => {
    test.setTimeout(240_000);
    const creds = requireTestUser();
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await page.route(/cloudfunctions\.net|\.run\.app/, (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => typeof window._saveLead === 'function' && !!window._user && !!window.LayoutEngine, null, { timeout: 30_000 });
    await seed(page, 'P');
    await chooseInbox(page, 'phone');
    await setTheme(page, 'midnight');

    const row = page.locator('.ib-row', { hasText: 'ZZIBP' }).first();
    await row.waitFor({ state: 'visible', timeout: 60_000 });
    // list pane only
    await expect(page.locator('.ib-thread')).toBeHidden();
    await row.click();
    await expect(page.locator('.ib-thread')).toBeVisible();
    await expect(page.locator('.ib-list')).toBeHidden();
    await expect(page.locator('.ib-back')).toBeVisible();
    await expect(page.locator('#ibComposer')).toBeVisible();

    const small = await safeEvaluate(page, () => Array.from(document.querySelectorAll('#nbdInboxRoot .ib-btn, #nbdInboxRoot .ib-back'))
      .filter((e) => e.getBoundingClientRect().height < 55).map((e) => e.className));
    expect(small).toEqual([]);
    const overflow = await safeEvaluate(page, () => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    await page.locator('.ib-back').click();
    await expect(page.locator('.ib-list')).toBeVisible();
  });
});
