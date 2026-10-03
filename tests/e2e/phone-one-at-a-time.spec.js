// tests/e2e/phone-one-at-a-time.spec.js — big lists, one at a time (Jo,
// 2026-10-02: "when it says 100+ customers to sort I should be able to do
// one at a time and have it save that … like swiping left and right through
// Gmail … or a third … with options to click").
//
// Installed iPhone app (standalone rules forced), 390 × 844, real taps and
// a real pointer drag:
//   Sort my customers — banner "One at a time" opens the deck; the main
//     button saves the suggested type to THAT lead at once; Undo puts it
//     back; ⋯ picks any type; a left swipe skips it (back of the line, and
//     remembered for next time); closing keeps what was saved.
//   Call Center — "One at a time" on Needs attention: Handled saves for
//     every open call of that person; Undo sends "unhandled".
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const IPHONE = {
  isMobile: true, hasTouch: true, serviceWorkers: 'block',
  viewport: { width: 390, height: 844 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
let creds = null;
try { creds = requireTestUser(); } catch (_) { creds = null; }

let _db = null;
function adb() {
  if (_db) return _db;
  const { initializeApp, getApps } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  if (!getApps().length) initializeApp({ projectId: 'nobigdeal-pro' });
  _db = getFirestore();
  return _db;
}

async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const i of r.cssRules) css += i.cssText + '\n';
    }
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    return css.length;
  });
}
async function reachable(locator) {
  await locator.page().evaluate(() => document.querySelectorAll('.toast-container .toast, #toast.toast, [id^="toast-"]').forEach((t) => t.remove()));
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!h && (h === el || el.contains(h));
  });
}
const deck = (page) => page.locator('#nbdTriageDeck.open');
const card = (page) => page.locator('#nbdTriageDeck .deck-card[data-id]');
const leftCount = async (page) => Number(((await page.locator('#nbdTriageDeck .deck-progress').textContent()) || '').match(/(\d+) left/)?.[1] || 0);
const jobTypeOf = async (id) => ((await adb().doc('leads/' + id).get()).data() || {}).jobType || '';

async function swipe(page, dir) {
  const box = await card(page).boundingBox();
  const y = box.y + box.height / 2, x0 = box.x + box.width / 2;
  await page.mouse.move(x0, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x0 + dir * (box.width * 0.5) * (i / 8), y);
  await page.mouse.up();
}

test.describe('phone: one at a time @shard2', () => {
  test.skip(!creds, 'PLAYWRIGHT_TEST_USER_EMAIL / _PASSWORD not set');
  test.use(IPHONE);

  test('Sort my customers: each decision saves at once; Undo; ⋯ any type; swipe left = later, remembered', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDSortCustomers && window.NBDTriageDeck), null, { timeout: 30_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const s = Date.now();
    const base = { userId: who.uid, companyId: who.co, stage: 'new', e2eTestData: true, createdAt: new Date(), deleted: false };
    const ids = [];
    for (const extra of [
      { firstName: 'ZZOne', lastName: 'Carrier' + s, insCarrier: 'State Farm' },
      { firstName: 'ZZOne', lastName: 'Loan' + s, loanAmount: 12000 },
      { firstName: 'ZZOne', lastName: 'Blank' + s },
    ]) ids.push((await adb().collection('leads').add(Object.assign({}, base, extra))).id);
    await safeEvaluate(page, async () => { if (typeof window._loadLeads === 'function') await window._loadLeads(); else if (typeof window.loadLeads === 'function') await window.loadLeads(); });
    await page.waitForFunction((want) => want.every((id) => (window._leads || []).some((l) => l.id === id)), ids, { timeout: 30_000 });
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await page.evaluate(() => { window.goTo && window.goTo('crm'); window.NBDSortCustomers.refresh(); });

    // The banner re-renders as leads load; the locator re-resolves at tap time.
    const openBtn = page.locator('#sortCustomersWrap [data-sc="deck"]');
    await expect(openBtn, 'the banner offers One at a time').toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await openBtn.tap();
    await expect(deck(page)).toBeVisible();
    const start = await leftCount(page);
    expect(start, 'the deck counts what is left').toBeGreaterThanOrEqual(3);

    // The bar under the thumb: reachable, thumb-sized.
    for (const sel of ['.deck-left', '.deck-dots']) {
      const b = page.locator('#nbdTriageDeck ' + sel);
      if (await b.isVisible()) { expect(await reachable(b), sel + ' reachable').toBe(true); expect((await b.boundingBox()).height).toBeGreaterThanOrEqual(48); }
    }

    // Strong suggestions come first: the main button saves that type now.
    const right = page.locator('#nbdTriageDeck .deck-right');
    await expect(right).toBeVisible();
    const firstId = await card(page).getAttribute('data-id');
    const label = ((await right.textContent()) || '').replace('›', '').trim();
    await right.tap();
    await expect.poll(() => jobTypeOf(firstId), { message: 'saved to that lead at once' }).not.toBe('');
    const savedType = await jobTypeOf(firstId);
    expect(label.toLowerCase(), 'the button named the type it saved').toContain(savedType.slice(0, 4));
    await expect.poll(() => leftCount(page)).toBe(start - 1);

    // Undo puts it back, on the lead and in the deck.
    await page.locator('#nbdTriageDeck .deck-undo').tap();
    await expect.poll(() => jobTypeOf(firstId), { message: 'undo restores the old (empty) type' }).toBe('');
    await expect(card(page)).toHaveAttribute('data-id', firstId);
    await expect.poll(() => leftCount(page)).toBe(start);

    // ⋯ → pick a different type.
    await page.locator('#nbdTriageDeck .deck-dots').tap();
    const svc = page.locator('#nbdTriageDeck .deck-opt', { hasText: /Service/i });
    await expect(svc).toBeVisible();
    expect(await reachable(svc)).toBe(true);
    await svc.tap();
    await expect.poll(() => jobTypeOf(firstId)).toBe('service');
    await expect(card(page), 'the next card is up').not.toHaveAttribute('data-id', firstId, { timeout: 5_000 });
    await page.waitForTimeout(300);

    // Swipe left = later: it goes to the back and is remembered.
    const skipId = await card(page).getAttribute('data-id');
    await swipe(page, -1);
    await expect(card(page)).not.toHaveAttribute('data-id', skipId, { timeout: 5_000 });
    await expect(page.locator('#nbdTriageDeck .deck-progress')).toContainText('1 for later');
    expect(await jobTypeOf(skipId), 'a skip writes nothing').toBe('');
    const remembered = await page.evaluate((id) => Object.keys(localStorage).some((k) => k.indexOf('nbd_triage_skips:') === 0 && (localStorage.getItem(k) || '').indexOf(id) !== -1), skipId);
    expect(remembered, 'the skip is remembered for next time').toBe(true);

    // Close: what was saved stays saved; reopen starts with ones not yet seen.
    await page.locator('#nbdTriageDeck .deck-close').tap();
    await expect(deck(page)).toHaveCount(0);
    expect(await jobTypeOf(firstId)).toBe('service');
    await page.evaluate(() => window.NBDSortCustomers.openDeck());
    await expect(deck(page)).toBeVisible();
    expect(await card(page).getAttribute('data-id'), 'the skipped one is not first next time').not.toBe(skipId);
    await page.locator('#nbdTriageDeck .deck-close').tap();
  });

  test('Follow-ups due: Followed up moves it 7 days out; Undo; ⋯ Tomorrow', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.removeItem('nbd_crm_followup_hidden'); } catch (_) {} });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDFollowUpDeck && window.NBDTriageDeck), { timeout: 30_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const yday = await safeEvaluate(page, () => window.NBDFollowUpDeck._inDays(-1));
    const s = Date.now();
    const base = { userId: who.uid, companyId: who.co, stage: 'contacted', e2eTestData: true, createdAt: new Date(), deleted: false, followUp: yday };
    const id = (await adb().collection('leads').add(Object.assign({}, base, { firstName: 'ZZFollow', lastName: 'Up' + s, phone: '(513) 555-0177', notes: 'Wants a quote after the weekend.' }))).id;
    await adb().collection('leads').add(Object.assign({}, base, { firstName: 'ZZFollow', lastName: 'Two' + s }));
    await safeEvaluate(page, async () => { if (typeof window._loadLeads === 'function') await window._loadLeads(); else if (typeof window.loadLeads === 'function') await window.loadLeads(); });
    await page.waitForFunction((want) => (window._leads || []).some((l) => l.id === want), id, { timeout: 30_000 });
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await page.evaluate(() => { window.goTo && window.goTo('crm'); if (typeof window.renderLeads === 'function') window.renderLeads(window._leads, null); });
    const open = page.locator('#followUpAlerts .fa-deck');
    await expect(open, 'the Follow-ups Due list offers One at a time').toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await open.tap();
    await expect(deck(page)).toBeVisible();
    for (let i = 0; i < 40 && (await card(page).getAttribute('data-id')) !== id; i++) { await page.locator('#nbdTriageDeck .deck-left').tap(); await page.waitForTimeout(200); }
    await expect(card(page)).toHaveAttribute('data-id', id);
    await expect(card(page)).toContainText('1 day overdue');
    await expect(card(page)).toContainText('Wants a quote after the weekend.');
    const followUpOf = async () => ((await adb().doc('leads/' + id).get()).data() || {}).followUp;
    const plus7 = await safeEvaluate(page, () => window.NBDFollowUpDeck._inDays(7));
    await page.locator('#nbdTriageDeck .deck-right').tap();
    await expect.poll(followUpOf, { message: 'Followed up = next follow-up in 7 days' }).toBe(plus7);
    await page.locator('#nbdTriageDeck .deck-undo').tap();
    await expect.poll(followUpOf, { message: 'Undo restores the old date' }).toBe(yday);
    await expect(card(page)).toHaveAttribute('data-id', id);
    await page.locator('#nbdTriageDeck .deck-dots').tap();
    await expect(page.locator('#nbdTriageDeck .deck-opt', { hasText: 'Call' })).toBeVisible();
    const tmrw = await safeEvaluate(page, () => window.NBDFollowUpDeck._inDays(1));
    await page.locator('#nbdTriageDeck .deck-opt', { hasText: 'Tomorrow' }).tap();
    await expect.poll(followUpOf).toBe(tmrw);
    await page.locator('#nbdTriageDeck .deck-close').tap();
  });

  test('Agent inbox: Add to CRM writes the note; ⋯ Toss dismisses', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDAgentInbox && window.NBDTriageDeck && window.getDocs), { timeout: 30_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, key: (window._userClaims && window._userClaims.companyId) || window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const s = Date.now();
    const leadId = (await adb().collection('leads').add({ userId: who.uid, companyId: who.co, firstName: 'ZZInbox', lastName: 'Cust' + s, stage: 'new', e2eTestData: true, createdAt: new Date(), deleted: false })).id;
    const noteId = (await adb().collection('agent_inbox').add({ companyId: who.key, status: 'pending', kind: 'note', bot: 'Marcus', leadId, text: 'ZZINBOX gutters sag on the north side.', verified: true, verifiedBy: 'Quinn', createdAt: new Date(s) })).id;
    const reportId = (await adb().collection('agent_inbox').add({ companyId: who.key, status: 'pending', kind: 'report', bot: 'Frank', title: 'ZZINBOX weekly money', text: 'Collected this week: $0.', createdAt: new Date(s + 1) })).id;
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await page.evaluate(() => window.NBDAgentInbox.open());
    const btn = page.locator('#aiOverlay #aiDeck');
    await expect(btn, 'the inbox offers One at a time').toBeVisible({ timeout: 20_000 });
    await btn.tap();
    await expect(deck(page)).toBeVisible();
    const statusOf = async (id) => ((await adb().doc('agent_inbox/' + id).get()).data() || {}).status;
    for (let i = 0; i < 40 && (await card(page).getAttribute('data-id')) !== noteId; i++) { await page.locator('#nbdTriageDeck .deck-left').tap(); await page.waitForTimeout(200); }
    await expect(card(page)).toContainText('gutters sag on the north side');
    await expect(page.locator('#nbdTriageDeck .deck-right')).toHaveText(/Add to CRM/);
    await page.locator('#nbdTriageDeck .deck-right').tap();
    await expect.poll(() => statusOf(noteId), { message: 'the item is approved' }).toBe('approved');
    const notes = await adb().collection('notes').where('agentItemId', '==', noteId).get();
    expect(notes.size, 'the note landed on the customer').toBe(1);
    expect(notes.docs[0].data().leadId).toBe(leadId);
    for (let i = 0; i < 40 && (await card(page).getAttribute('data-id')) !== reportId; i++) { await page.locator('#nbdTriageDeck .deck-left').tap(); await page.waitForTimeout(200); }
    await expect(page.locator('#nbdTriageDeck .deck-right')).toHaveText(/Got it/);
    await page.locator('#nbdTriageDeck .deck-dots').tap();
    await page.locator('#nbdTriageDeck .deck-opt', { hasText: 'Toss' }).tap();
    await expect.poll(() => statusOf(reportId), { message: 'Toss dismisses it' }).toBe('dismissed');
    await page.locator('#nbdTriageDeck .deck-close').tap();
  });

  test('Review asks: Home shows the count; Text the ask sends + marks it; Don\'t ask sticks', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); } catch (_) {} });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && window.NBDReviewDeck && window.ReviewEngine && window.NBDTriageDeck), { timeout: 30_000 });
    const who = await safeEvaluate(page, () => ({ uid: window._user.uid, co: (window._userClaims && window._userClaims.companyId) || window._user.uid }));
    const s = Date.now();
    const won = { userId: who.uid, companyId: who.co, stage: 'closed', stageRole: 'won', e2eTestData: true, createdAt: new Date(), deleted: false, stageStartedAt: new Date(s - 3 * 86400000) };
    const askId = (await adb().collection('leads').add(Object.assign({}, won, { firstName: 'ZZReview', lastName: 'Ask' + s, phone: '(513) 555-0166', email: 'delivered@resend.dev', address: '9 Review Rd, Mason, OH 45040' }))).id;
    const skipId = (await adb().collection('leads').add(Object.assign({}, won, { firstName: 'ZZReview', lastName: 'Skip' + s, phone: '(513) 555-0167' }))).id;
    await safeEvaluate(page, async () => { if (typeof window._loadLeads === 'function') await window._loadLeads(); else if (typeof window.loadLeads === 'function') await window.loadLeads(); });
    await page.waitForFunction((ids) => ids.every((id) => (window._leads || []).some((l) => l.id === id)), [askId, skipId], { timeout: 30_000 });
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    // No real text leaves the test: capture what would be sent.
    await page.evaluate(() => {
      window.__sent = [];
      window.NBDComms = Object.assign({}, window.NBDComms, { sendSMS: async (o) => { window.__sent.push(o); return { success: true, mode: 'sent' }; } });
    });
    await page.evaluate(() => { window.goTo && window.goTo('home'); return window.NBDHomeAttention && window.NBDHomeAttention.render(true); });
    const chip = page.locator('#homeAttention [data-review-deck]');
    await expect(chip, 'Home shows the review asks waiting').toContainText(/review asks? waiting/, { timeout: 15_000 });
    await chip.tap();
    await expect(deck(page)).toBeVisible();
    const leadOf = async (id) => (await adb().doc('leads/' + id).get()).data() || {};
    for (let i = 0; i < 40 && (await card(page).getAttribute('data-id')) !== askId; i++) { await page.locator('#nbdTriageDeck .deck-left').tap(); await page.waitForTimeout(200); }
    await expect(card(page)).toContainText('Won 3 days ago');
    await expect(page.locator('#nbdTriageDeck .deck-right')).toHaveText(/Text the ask/);
    await page.locator('#nbdTriageDeck .deck-right').tap();
    await expect.poll(async () => (await leadOf(askId)).reviewRequested, { message: 'the lead is marked asked' }).toBe(true);
    const sent = await page.evaluate(() => window.__sent);
    expect(sent.length, 'one text, through the platform sender').toBe(1);
    expect(sent[0].to).toBe('5135550166');
    expect(sent[0].source).toBe('review_request');
    expect(sent[0].message, 'the ask carries the Google review link').toMatch(/review/i);
    for (let i = 0; i < 40 && (await card(page).getAttribute('data-id')) !== skipId; i++) { await page.locator('#nbdTriageDeck .deck-left').tap(); await page.waitForTimeout(200); }
    await page.locator('#nbdTriageDeck .deck-dots').tap();
    await page.locator('#nbdTriageDeck .deck-opt', { hasText: "Don't ask this one" }).tap();
    await expect.poll(async () => (await leadOf(skipId)).reviewAskDeclined).toBe(true);
    expect((await page.evaluate(() => window.__sent)).length, "Don't ask sends nothing").toBe(1);
    await page.locator('#nbdTriageDeck .deck-close').tap();
    const left = await page.evaluate((ids) => window.NBDReviewDeck.candidates(window._leads).filter((l) => ids.includes(l.id)).length, [askId, skipId]);
    expect(left, 'neither comes back as a candidate').toBe(0);
  });

  test('Call Center: one person at a time; Handled covers all their open calls; Undo', async ({ page }) => {
    test.setTimeout(150_000);
    const actions = [];
    await page.addInitScript(() => { try { localStorage.setItem('nbd-onboarding-complete', '1'); localStorage.setItem('nbd_push_optin_snoozed_until', String(Date.now() + 3600_000)); } catch (_) {} });
    await page.route(/callCenterAction/, async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}').data || {}; } catch (_) {}
      actions.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { ok: true } }) });
    });
    await loginAs(page, creds);
    await safeWaitForFunction(page, () => !!(window._user && typeof window.goTo === 'function' && window.NBDTriageDeck), null, { timeout: 30_000 });
    const uid = await safeEvaluate(page, () => window._user.uid);
    const s = Date.now();
    const base = { userId: uid, companyId: uid, source: 'cube-acr', status: 'noted', createdAtMs: s, alternateLeadIds: [], tags: [] };
    const calls = {
      a: { bucket: 'unknown', phoneDigits: '5135550191', direction: 'inbound', startedAtMs: s - 1000, summary: 'ZZONE asked for a roof quote.', promises: [{ who: 'jo', text: 'Call back today' }] },
      b: { bucket: 'unknown', phoneDigits: '5135550191', direction: 'inbound', startedAtMs: s - 9000, summary: 'ZZONE first call.', promises: [] },
    };
    for (const [k, v] of Object.entries(calls)) await adb().doc('phone_calls/zzone' + s + k).set(Object.assign({}, base, v));
    expect(await forceStandalone(page)).toBeGreaterThan(200);
    await page.evaluate(() => window.goTo('calls'));
    await safeWaitForFunction(page, () => !!window.NBDCallCenter && window.NBDCallCenter._state.loaded, { timeout: 20_000 });
    // The list may have loaded before the seed landed: reload it.
    await expect.poll(async () => {
      await page.evaluate(async () => { await window.NBDCallCenter.reload(); });
      return page.evaluate(() => window.NBDCallCenter._state.calls.some((c) => c.phoneDigits === '5135550191'));
    }, { timeout: 30_000, intervals: [1000, 2000, 3000] }).toBe(true);
    const btn = page.locator('#view-calls [data-cc="deck"]');
    await expect(btn).toBeVisible();
    await btn.tap();
    await expect(deck(page)).toBeVisible();
    // Find our person (other specs may have seeded calls for this user).
    for (let i = 0; i < 20 && (await card(page).getAttribute('data-id')) !== 'num:5135550191'; i++) await page.locator('#nbdTriageDeck .deck-left').tap();
    await expect(card(page)).toHaveAttribute('data-id', 'num:5135550191');
    await expect(card(page)).toContainText('2 open');
    await expect(card(page)).toContainText('You: Call back today');
    const right = page.locator('#nbdTriageDeck .deck-right');
    await expect(right).toHaveText(/Handled \(all 2\)/);
    await right.tap();
    await expect.poll(() => ['a', 'b'].every((k) => actions.some((x) => x.id === 'zzone' + s + k && x.action === 'handled')), { timeout: 10_000 }).toBe(true);
    await page.locator('#nbdTriageDeck .deck-undo').tap();
    await expect.poll(() => ['a', 'b'].every((k) => actions.some((x) => x.id === 'zzone' + s + k && x.action === 'unhandled')), { timeout: 10_000 }).toBe(true);
    await expect(card(page)).toHaveAttribute('data-id', 'num:5135550191');
    await page.locator('#nbdTriageDeck .deck-close').tap();
    for (const k of Object.keys(calls)) await adb().doc('phone_calls/zzone' + s + k).delete().catch(() => {});
  });
});
