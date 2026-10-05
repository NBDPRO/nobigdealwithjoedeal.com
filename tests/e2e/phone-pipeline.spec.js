// tests/e2e/phone-pipeline.spec.js — the pipeline works on Jo's phone.
//
// Jo runs the business from an Android at ~412px, and his standing rule is
// that the CRM must fit and work flawlessly there (2026-09-24). The
// 2026-09-25 phone audit found the pipeline broken in ways no gate could
// see, because every existing check read state instead of behaviour:
//
//   - The Tools (⋯) and Filters menus opened with .open set, display:block
//     and opacity 1 — and painted nothing, at every width including
//     desktop, because their parent row was a 42px scroll box that clipped
//     them. pro-authed.spec.js checked the .open class and clicked the menu
//     item through JS .click(), so it stayed green for months while Find
//     duplicates, Deleted leads, Bulk select and all four filters were
//     unreachable by a finger.
//   - Phone list cards read "New Lead" for jobs being installed or already
//     closed, and swiping one said "Already at the last stage".
//   - The job-detail stage picker ran past the bottom of the screen.
//   - The stage chip was 1.25:1 dark-on-navy.
//   - Search results sat under an unfiltered follow-up block.
//   - Board card ⋮ buttons hung outside the card.
//   - A cancelled swipe left a card stuck sideways.
//   - Add Lead pairs had no gutter.
//
// Follow-ups to the menu fix (2026-09-25, once the menus painted):
//   - A second tap on ⋯ did not close Tools (the tap lands on the <svg>).
//   - On Jo's iPhone a tap beside an open menu did not close it (WebKit sends
//     no click for a tap on plain page, only pointerdown).
//   - After a rotate the menu kept its portrait placement, off-screen.
//   - The FAB stack painted over the menu's right edge on a landscape phone.
//   - Deleted leads and Prospects left their menu open behind them.
//
// Phone nav polish (2026-09-25, after those landed):
//   - The header ⋮ kebab had the old menu lifecycle: a touch beside it with
//     no click left it open on the iPhone, every close from the button leaked
//     a listener, and an item left it open over what it opened.
//   - The list chose phone cards or the desktop table (and Auto chose List
//     or Board) when it rendered, never on a rotate: a refresh that landed
//     while the phone was sideways brought it back upright to a blank list.
//   - Card density closed Tools after every step of its three-way cycle.
//
// So every assertion here is behavioural: elementFromPoint at a control's
// centre must return that control, and taps are real touch events
// (touchscreen.tap / CDP touch sequences) at on-screen coordinates, never
// locator.tap() — which scrolls clipped content into view in ways a finger
// can't — and never element.click().
//
// Each describe logs in once, seeds its own leads under a unique surname
// token (so it neither depends on nor disturbs shared emulator data), and
// deletes them afterwards. Cloud Functions calls are fulfilled locally.
// Tagged @audit so it rides the audit shard of the authed emulator job:
//   cd tests && npm run test:e2e:authed:emu   (PLAYWRIGHT_GREP=@audit)
const { test, expect } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

// ── page-side helpers, installed on every page of the context ─────────
//   __ppHit(el): the element's centre is on screen and the element (or a
//     descendant) is what a finger there would hit.
//   __ppRgb(css): any computed CSS colour (rgb(), color(srgb …), color-mix
//     results) → [r,g,b], via a 1px canvas.
function installHelpers() {
  // Ask Joe's once-a-day proactive scans raise a warning toast a few
  // seconds after load; mark today's as done so one can't land on top of
  // a menu mid-hit-test (it's a transient overlay, not what's under test).
  try {
    const today = new Date().toISOString().split('T')[0];
    ['overdue_scan', 'pending_estimate_scan', 'morning_briefing'].forEach((k) => localStorage.setItem('nbd_proactive_' + k, today));
    // The first-run tour (onboarding-tour.js) can open after skipTour() has
    // looked for it and cover the whole page; mark it done up front.
    localStorage.setItem('nbd-onboarding-complete', '1');
  } catch (_) { /* storage blocked: quietToasts below still covers it */ }
  window.__ppHit = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (!r.width || !r.height || cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
    const h = document.elementFromPoint(cx, cy);
    return !!h && (h === el || el.contains(h));
  };
  window.__ppRgb = (css) => {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillStyle = css; g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]];
  };
}

async function setupContext(context) {
  await context.addInitScript(installHelpers);
  // Never let a test run hit production Cloud Functions or telemetry
  // (CI's hosting-only emulator leaves callable URLs pointing at prod).
  await context.route(/cloudfunctions\.net\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"result":{}}' }));
  await context.route(/sentry\.io\//, (r) => r.fulfill({ status: 200, body: '' }));
}

// safeWaitForFunction takes no page argument; this is the same
// navigation-race tolerance with one.
async function waitWith(page, fn, arg, timeout, polling) {
  for (let attempt = 0; ; attempt++) {
    try { return await page.waitForFunction(fn, arg, polling ? { timeout, polling } : { timeout }); } catch (e) {
      if (attempt < 4 && /Execution context was destroyed|interrupted by another navigation|navigating and changing/i.test(String(e && e.message))) {
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        continue;
      }
      throw e;
    }
  }
}

// Let any toast finish (they self-remove) before hit-testing what's under it.
async function quietToasts(page) {
  await waitWith(page, () => !document.querySelector('#toastContainer .toast'), null, 8_000)
    .catch(() => safeEvaluate(page, () => document.querySelectorAll('#toastContainer .toast').forEach((t) => t.remove())));
}

async function skipTour(page) {
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => {});
}

// Create this run's leads straight through the page's own Firestore SDK.
async function seedLeads(page, token) {
  await safeWaitForFunction(page, () => typeof window.addDoc === 'function' && typeof window.collection === 'function'
    && !!window.db && !!window._user && typeof window._loadLeads === 'function', { timeout: 30_000 });
  const ids = await safeEvaluate(page, async (tok) => {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const yesterday = d.toISOString().split('T')[0];
    const uid = window._user.uid;
    const base = { userId: uid, companyId: (window._userClaims && window._userClaims.companyId) || uid, jobType: 'insurance',
      source: 'Door Knock', damageType: 'Roof - Hail', claimStatus: 'No Claim', createdAt: new Date(), updatedAt: new Date() };
    const rows = {
      install: { firstName: 'Pp', lastName: tok + 'Install', stage: 'install_in_progress', jobValue: 41200, address: '10 Pipe St, Milford OH 45150', phone: '(513) 555-0190', followUp: '' },
      closed: { firstName: 'Pp', lastName: tok + 'Closed', stage: 'closed', jobValue: 15600, address: '11 Pipe St, Milford OH 45150', phone: '(513) 555-0191', followUp: '' },
      contacted: { firstName: 'Pp', lastName: tok + 'Contact', stage: 'contacted', jobValue: 9000, address: '12 Pipe St, Milford OH 45150', phone: '(513) 555-0192', followUp: '' },
      fu1: { firstName: 'Pp', lastName: tok + 'FuOne', stage: 'new', jobValue: 8000, address: '13 Pipe St, Milford OH 45150', phone: '(513) 555-0193', followUp: yesterday },
      fu2: { firstName: 'Pp', lastName: tok + 'FuTwo', stage: 'new', jobValue: 8000, address: '14 Pipe St, Milford OH 45150', phone: '(513) 555-0194', followUp: yesterday },
      fu3: { firstName: 'Pp', lastName: tok + 'FuThree', stage: 'new', jobValue: 8000, address: '15 Pipe St, Milford OH 45150', phone: '(513) 555-0195', followUp: yesterday },
      fu4: { firstName: 'Pp', lastName: tok + 'FuFour', stage: 'new', jobValue: 8000, address: '16 Pipe St, Milford OH 45150', phone: '(513) 555-0196', followUp: yesterday },
    };
    const out = {};
    for (const [k, v] of Object.entries(rows)) {
      const ref = await window.addDoc(window.collection(window.db, 'leads'), Object.assign({ meter: 'manual' }, base, v)); // server lead meter (firestore.rules leadMeterOk, 2026-10-04)
      out[k] = ref.id;
    }
    await window._loadLeads();
    return out;
  }, token);
  await waitWith(page, (tok) => (window._leads || []).filter((l) => l && String(l.lastName || '').indexOf(tok) === 0).length >= 7,
    token, 60_000);
  return ids;
}

// Best effort and bounded: a slow emulator must not turn cleanup into a
// hook timeout (emulator state evaporates when emulators:exec exits anyway).
async function deleteLeads(page, ids) {
  if (!page || !ids) return;
  await Promise.race([
    safeEvaluate(page, (list) => Promise.all(list.map((id) => window.deleteDoc(window.doc(window.db, 'leads', id)).catch(() => {}))),
      Object.values(ids)).catch(() => {}),
    new Promise((r) => setTimeout(r, 15_000)),
  ]);
}

// Seeding fires a burst of live refreshes (snapshot → leadsChanged →
// renderLeads) that rebuild the board and list for a few seconds; acting
// during the burst aims at cards that are about to move. Wait for 1.5s with
// no leadsChanged (bounded — a quiet rig just proceeds).
async function settle(page) {
  await safeEvaluate(page, () => {
    window.__ppLastChange = performance.now();
    if (!window.__ppSettleHook) {
      window.__ppSettleHook = true;
      document.addEventListener('leadsChanged', () => { window.__ppLastChange = performance.now(); });
    }
  });
  await waitWith(page, () => performance.now() - window.__ppLastChange > 1500, null, 20_000).catch(() => {});
}

async function openCrm(page) {
  await safeWaitForFunction(page, () => typeof window.goTo === 'function', { timeout: 30_000 });
  await safeEvaluate(page, () => window.goTo('crm'));
  await safeWaitForFunction(page, () => typeof window.toggleCrmToolsMenu === 'function'
    && !!document.getElementById('crmToolsBtn') && document.getElementById('view-crm').offsetParent !== null, { timeout: 30_000 });
  await skipTour(page);
}

// Bring the pipeline header back into view (whatever element is scrolling),
// the way a rep scrolls back up before reaching for the search box.
async function toTop(page) {
  await safeEvaluate(page, () => document.querySelector('#view-crm .crm-header').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(150);
}

async function centre(page, selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error('no box for ' + selector);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Open a header menu with a real tap/click on its button, then report which
// of its visible items a finger or cursor could actually hit.
async function openMenuAndHitTest(page, btnSel, menuId, touch) {
  await safeEvaluate(page, () => { window.closeCrmToolsMenu(); window.closeCrmFiltersMenu(); });
  await quietToasts(page);
  const c = await centre(page, btnSel);
  if (touch) await page.touchscreen.tap(c.x, c.y); else await page.mouse.click(c.x, c.y);
  await waitWith(page, (id) => document.getElementById(id).classList.contains('open'), menuId, 5_000);
  return safeEvaluate(page, (id) => {
    const items = [...document.getElementById(id).querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none');
    return { n: items.length, missed: items.filter((b) => !window.__ppHit(b)).map((b) => b.innerText.trim().replace(/\s+/g, ' ')) };
  }, menuId);
}

const MENUS = [['#crmToolsBtn', 'crmToolsMenu'], ['#crmFiltersBtn', 'crmFiltersMenu']];

// Wait (bounded) for a header menu to reach an open/closed state, then return
// the state it is actually in. A menu that never gets there fails the expect()
// after it with a readable message instead of a timeout.
async function menuSettles(page, id, want, ms = 1_500) {
  await waitWith(page, ([i, w]) => document.getElementById(i).classList.contains('open') === w, [id, want], ms).catch(() => {});
  return safeEvaluate(page, (i) => document.getElementById(i).classList.contains('open'), id);
}

// Where an open header menu sits and whether a finger can reach what it
// shows. Only items whose centre is inside the menu's own (scrolling) box
// count. Each is hit-tested at its centre AND 12px in from each side edge,
// because the FAB stack used to cover only a menu's right edge. fabs lists
// the visible FABs whose box overlaps the menu's.
async function menuReport(page, id) {
  return safeEvaluate(page, (i) => {
    const m = document.getElementById(i); const mr = m.getBoundingClientRect();
    const nav = document.getElementById('mobile-nav'); const nr = nav && nav.getBoundingClientRect();
    const limit = nr && nr.height > 0 && nr.top > 0 && nr.top < innerHeight ? nr.top : innerHeight;
    const tag = (h) => (h ? h.tagName + (h.id ? '#' + h.id : '') : 'nothing');
    // Inside the border and padding: an item scrolled to where its centre
    // sits on the menu's own edge is cut in half, not covered.
    const cs = getComputedStyle(m);
    const top = mr.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
    const bot = mr.bottom - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom);
    const shown = [...m.querySelectorAll('button')].filter((b) => getComputedStyle(b).display !== 'none')
      .filter((b) => { const q = b.getBoundingClientRect(); const c = q.top + q.height / 2; return c > top && c < bot; });
    const covered = [];
    for (const b of shown) {
      const q = b.getBoundingClientRect(); const cy = q.top + q.height / 2;
      for (const x of [q.left + 12, q.left + q.width / 2, q.right - 12]) {
        const h = document.elementFromPoint(x, cy);
        if (!h || !b.contains(h)) { covered.push(b.innerText.trim().replace(/\s+/g, ' ') + ' @x' + Math.round(x) + ' under ' + tag(h)); break; }
      }
    }
    const fabs = ['addLeadFab', 'nbd-whisper-fab', 'nbd-qc-fab', 'nbd-qci-fab', 'nbd-fab-dial'].map((f) => document.getElementById(f))
      .filter((f) => f && f.getClientRects().length && getComputedStyle(f).opacity !== '0' && getComputedStyle(f).visibility !== 'hidden')
      .filter((f) => { const r = f.getBoundingClientRect(); return r.left < mr.right && r.right > mr.left && r.top < mr.bottom && r.bottom > mr.top; })
      .map((f) => f.id);
    return { open: m.classList.contains('open'), left: mr.left, right: mr.right, bottom: mr.bottom, vw: document.documentElement.clientWidth,
      limit, n: shown.length, covered, fabs };
  }, id);
}

// A real one-finger drag through CDP (a touchscreen swipe; Playwright has no
// touch-move API). `cancel` ends it with touchcancel instead of touchend.
async function touchDrag(cdp, page, from, dx, dy, steps, cancel) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
}

function contrast(a, b) {
  const lum = (rgb) => { const x = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2]; };
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
// The theme is account state: it hydrates from the (shared) test user's
// userSettings a few seconds after load, so a contrast check measured
// whatever theme another run left behind — and on a light theme the old raw
// #374151 reads fine, so the desktop check passed with the bug present (a
// 2026-09-25 break-test caught that). Pin it for the measurement without
// saving: ThemeEngine.apply(key, false) never writes localStorage/Firestore.
// Transitions are switched off first: the desktop .cd-stage-chip has
// `transition: all .15s`, and a theme switch with the modal already open left
// its var(--t)-based colour at the pre-switch value in headless Chromium. A
// rep picks a theme and then opens a card, so the end state is what counts.
async function useTheme(page, key) {
  await safeEvaluate(page, (k) => {
    if (!document.getElementById('pp-no-transitions')) {
      const st = document.createElement('style');
      st.id = 'pp-no-transitions';
      st.textContent = '*, *::before, *::after { transition: none !important; }';
      document.head.appendChild(st);
    }
    if (window.ThemeEngine && typeof window.ThemeEngine.apply === 'function') window.ThemeEngine.apply(k, false);
    else document.documentElement.setAttribute('data-theme', k);
  }, key);
  await page.waitForTimeout(150);
}
const CHIP_THEMES = ['nbd-original', 'paper']; // the default navy, and a light theme

async function chipContrast(page, chipSel, bgVar) {
  // The desktop .cd-stage-chip transitions its colours, so right after a
  // theme switch getComputedStyle returns mid-animation values. Wait until
  // two reads 120ms apart agree.
  await waitWith(page, (sel) => {
    const el = document.querySelector(sel); const cs = getComputedStyle(el);
    const now = cs.color + '|' + cs.backgroundColor;
    const same = window.__ppChipLast === now; window.__ppChipLast = now; return same;
  }, chipSel, 3_000, 120).catch(() => {});
  const r = await safeEvaluate(page, ([sel, v]) => {
    const el = document.querySelector(sel);
    // Resolved where the chip is, not on :root — a container may scope it.
    const bg = getComputedStyle(el).getPropertyValue(v).trim();
    return { text: el.textContent.trim(), fg: window.__ppRgb(getComputedStyle(el).color), bg: window.__ppRgb(bg),
      diag: `inline=${el.style.color} computed=${getComputedStyle(el).color} ${v}=${bg} theme=${document.documentElement.getAttribute('data-theme')}` };
  }, [chipSel, bgVar]);
  return { text: r.text, ratio: contrast(r.fg, r.bg), diag: r.diag };
}

// ══════════════════════════════════════════════════════════════════════
test.describe('phone pipeline @audit', () => {
  test.describe.configure({ mode: 'serial' });
  let creds = null, context = null, page = null, cdp = null, ids = null;
  const TOKEN = 'Zpp' + Math.random().toString(36).slice(2, 7);

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    try { creds = requireTestUser(); } catch (e) { console.warn('[phone-pipeline] ' + e.message); return; }
    context = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, userAgent: ANDROID_UA, serviceWorkers: 'block' });
    await setupContext(context);
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
    await loginAs(page, creds);
    await skipTour(page);
    ids = await seedLeads(page, TOKEN);
    await openCrm(page);
    await settle(page);
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    if (page) { await safeEvaluate(page, () => { try { localStorage.removeItem('nbd_crm_search'); } catch (_) {} }).catch(() => {}); await deleteLeads(page, ids); }
    if (context) await context.close();
  });
  test.beforeEach(async ({}, testInfo) => { if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set'); });

  test('Tools and Filters menus paint on top and take real taps (pipeline#0)', async () => {
    test.setTimeout(90_000);
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      for (const [btn, menu] of [['#crmToolsBtn', 'crmToolsMenu'], ['#crmFiltersBtn', 'crmFiltersMenu']]) {
        const r = await openMenuAndHitTest(page, btn, menu, true);
        expect(r.n, `${menu} has items at ${width}px`).toBeGreaterThan(3);
        expect(r.missed, `${menu} items a finger can't reach at ${width}px`).toEqual([]);
      }
    }
    await page.setViewportSize({ width: 412, height: 860 });
    // A real finger tap on "Find duplicates" opens the review — before the
    // fix the same tap landed on the lead card underneath.
    await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', true);
    const dup = await centre(page, '#crmToolsMenu button[data-fn="openDupReview"]');
    await page.touchscreen.tap(dup.x, dup.y);
    await safeWaitForFunction(page, () => !!document.getElementById('dupReviewOverlay'), { timeout: 5_000 });
    expect(page.url(), 'the tap stayed on the dashboard').toMatch(/\/pro\/dashboard/);
    await safeEvaluate(page, () => { const o = document.getElementById('dupReviewOverlay'); if (o) o.remove(); });
    // A real tap on a filter toggles it (then untoggle).
    await safeWaitForFunction(page, () => !!(window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.toggleNeedsAttention === 'function'), { timeout: 15_000 });
    for (const want of [true, false]) {
      await openMenuAndHitTest(page, '#crmFiltersBtn', 'crmFiltersMenu', true);
      const na = await centre(page, '#needsAttentionBtn');
      await page.touchscreen.tap(na.x, na.y);
      await waitWith(page, (w) => document.getElementById('needsAttentionBtn').classList.contains('active') === w, want, 5_000);
      await safeWaitForFunction(page, () => !document.getElementById('crmFiltersMenu').classList.contains('open'), { timeout: 5_000 });
    }
    // Short screen: the menu stops above the phone nav bar and scrolls, so
    // its last item is still reachable by a finger drag.
    await page.setViewportSize({ width: 412, height: 640 });
    await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', true);
    const fit = await safeEvaluate(page, () => {
      const m = document.getElementById('crmToolsMenu').getBoundingClientRect();
      const nav = document.getElementById('mobile-nav');
      const limit = nav && nav.getBoundingClientRect().height ? nav.getBoundingClientRect().top : innerHeight;
      const el = document.getElementById('crmToolsMenu');
      return { bottom: m.bottom, limit, scrolls: el.scrollHeight > el.clientHeight };
    });
    expect(fit.bottom, 'Tools menu ends above the phone nav bar').toBeLessThanOrEqual(fit.limit + 1);
    const box = await page.locator('#crmToolsMenu').boundingBox();
    expect(fit.scrolls, 'the capped menu scrolls').toBe(true);
    await touchDrag(cdp, page, { x: box.x + box.width / 2, y: box.y + box.height - 30 }, 0, -300, 20, false);
    await page.waitForTimeout(400);
    const last = await safeEvaluate(page, () => window.__ppHit(document.getElementById('kanbanDensityToggleBtn')));
    expect(last, 'after a finger drag, the last Tools item is reachable').toBe(true);
    await safeEvaluate(page, () => window.closeCrmToolsMenu());
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('header menus: a second tap or a touch beside closes them; they follow a rotate and paint over the FABs (pipeline#0 follow-ups)', async () => {
    test.setTimeout(120_000);
    const closeAll = () => safeEvaluate(page, () => { window.closeCrmToolsMenu(); window.closeCrmFiltersMenu(); });
    // The previous test ends on a CDP finger drag, and the first tap after a
    // synthetic drag is sometimes swallowed as a fling-stop (the pipeline
    // review saw it on main's ⋮ menu; it cost this test its first tap once).
    // Stop any fling with a touch that fires no click, so the first real tap
    // below counts.
    await toTop(page);
    const title0 = await centre(page, '#view-crm .crm-hdr-title');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: title0.x, y: title0.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(200);
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await toTop(page);
      for (const [btn, menu] of MENUS) {
        await closeAll();
        await quietToasts(page);
        const c = await centre(page, btn);
        // The old ⋯ check compared e.target.id, and a finger lands on the icon.
        const lands = await safeEvaluate(page, ([s, x, y]) => { const b = document.querySelector(s); const h = document.elementFromPoint(x, y); return !!h && h !== b && b.contains(h); }, [btn, c.x, c.y]);
        expect(lands, `a finger on ${btn} lands on its icon, not the button element itself (${width}px)`).toBe(true);
        await page.touchscreen.tap(c.x, c.y);
        expect(await menuSettles(page, menu, true), `first tap opens ${menu} (${width}px)`).toBe(true);
        await page.touchscreen.tap(c.x, c.y);
        expect(await menuSettles(page, menu, false), `a second tap on ${btn} closes ${menu} (${width}px)`).toBe(false);
        await page.touchscreen.tap(c.x, c.y);
        expect(await menuSettles(page, menu, true), `a third tap reopens ${menu} (${width}px)`).toBe(true);
        // A touch beside the menu that arrives with NO click. WebKit (Jo's
        // iPhone app) sends no click for a tap on plain page like the title;
        // touchStart + touchCancel gives Chromium the same shape (pointerdown,
        // no click).
        const t = await centre(page, '#view-crm .crm-hdr-title');
        expect(await safeEvaluate(page, ([x, y, id]) => !document.getElementById(id).contains(document.elementFromPoint(x, y)), [t.x, t.y, menu]),
          'the title is beside the menu, not under it').toBe(true);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: t.x, y: t.y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        expect(await menuSettles(page, menu, false), `a touch beside ${menu} closes it with no click (${width}px)`).toBe(false);
      }
      // The two menus still close each other.
      await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', true);
      const f = await centre(page, '#crmFiltersBtn');
      await page.touchscreen.tap(f.x, f.y);
      expect(await menuSettles(page, 'crmFiltersMenu', true), `Filters opens from under an open Tools menu (${width}px)`).toBe(true);
      expect(await menuSettles(page, 'crmToolsMenu', false), `… and Tools closes (${width}px)`).toBe(false);
      await closeAll();
    }

    // Landscape phone: the FAB column overlaps the Tools menu's right edge,
    // and the menu must be what paints there. Opened fresh in landscape, so
    // this checks the stacking alone. (Before the rotate block, whose
    // landscape hit-tests would otherwise catch a z regression first.)
    await page.setViewportSize({ width: 860, height: 412 });
    await toTop(page);
    await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', true);
    const z = await menuReport(page, 'crmToolsMenu');
    expect(z.fabs, 'precondition: on a landscape phone the FAB stack overlaps the open Tools menu').not.toEqual([]);
    expect(z.covered, 'Tools items painted over by the FAB stack').toEqual([]);
    await closeAll();

    // Turn the phone with a menu open, and back: it is re-placed each time.
    for (const [btn, menu] of MENUS) {
      await page.setViewportSize({ width: 412, height: 860 });
      await toTop(page);
      await openMenuAndHitTest(page, btn, menu, true);
      for (const vp of [{ width: 860, height: 412 }, { width: 412, height: 860 }]) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(300);
        const r = await menuReport(page, menu);
        const at = `${menu} after turning to ${vp.width}x${vp.height}`;
        expect(r.open, `${at}: still open`).toBe(true);
        expect(r.left, `${at}: left edge on screen`).toBeGreaterThanOrEqual(0);
        expect(r.right, `${at}: right edge on screen (vw ${r.vw})`).toBeLessThanOrEqual(r.vw);
        expect(r.bottom, `${at}: ends above the nav bar / screen bottom`).toBeLessThanOrEqual(r.limit + 1);
        expect(r.n, `${at}: shows items`).toBeGreaterThan(2);
        expect(r.covered, `${at}: items a finger can't reach`).toEqual([]);
      }
      await closeAll();
    }
    await page.setViewportSize({ width: 412, height: 860 });
    // No re-render here any more: the list and the follow-up block follow a
    // rotate on their own now (2026-09-25 phone nav polish; pinned by the
    // "a rotate re-renders the list" test below), so the tests after this
    // one start from the phone layout because the app put it back.
    await settle(page);
  });

  // Runs before the follow-up test on purpose: that one taps "+ N more",
  // which keeps every row for the session, and the row count is how this
  // test sees the follow-up block re-fit.
  test('a rotate re-renders the list and the follow-up rows for the new width; the pipeline never comes back blank (nav polish #2)', async () => {
    test.setTimeout(120_000);
    const saved = await safeEvaluate(page, () => { try { return localStorage.getItem('nbd-crm-view-mode'); } catch (_) { return null; } });
    // Counts can move under a live refresh (the book is shared), so the
    // list is checked by this run's own Installing lead as well as by count.
    const state = () => safeEvaluate(page, (id) => {
      const shown = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).length;
      const label = (document.getElementById('followUpAlertsLabel') || {}).textContent || '';
      return { listMode: document.body.classList.contains('crm-list-mode'),
        cards: shown('#crmListWrap .cl-card'), rows: shown('#crmListWrap tr.crm-list-row'), board: shown('#kanbanBoard .k-card'),
        myCard: shown(`#crmListWrap .cl-card[data-id="${id}"]`) > 0, myRow: shown(`#crmListWrap tr.crm-list-row[data-id="${id}"]`) > 0,
        fu: shown('#followUpAlerts .follow-up-alert'), due: parseInt(label, 10) || 0 };
    }, ids.install);
    // What lands while the phone is sideways: a live refresh (snapshot →
    // renderLeads). Without one the old layout just sat there.
    const refresh = () => safeEvaluate(page, () => window.renderLeads(window._leads));
    const turn = async (width, height) => { await page.setViewportSize({ width, height }); await page.waitForTimeout(400); };
    try {
      // Auto (no saved choice): List on a phone, Board on anything wider.
      await safeEvaluate(page, () => { try { localStorage.removeItem('nbd_crm_followup_hidden'); } catch (_) {} window.crmViewAuto(); });
      for (const [w, h] of [[412, 860], [360, 780]]) {
        await turn(w, h);
        await waitWith(page, () => document.querySelectorAll('#crmListWrap .cl-card').length > 0, null, 10_000);
        const up = await state();
        expect(up.listMode, `Auto on a ${w}px phone is the list`).toBe(true);
        expect(up.due, 'precondition: more follow-ups due than a phone shows').toBeGreaterThanOrEqual(4);
        expect(up.fu, `a ${w}px phone shows three follow-up rows`).toBe(3);
        await turn(h, w);
        await refresh();
        const side = await state();
        expect(side.cards + side.rows + side.board, `sideways (${h}x${w}) after a refresh: the pipeline is not blank`).toBeGreaterThan(0);
        expect(side.listMode, `sideways (${h}x${w}), Auto shows the board, as a fresh load at that width does`).toBe(false);
        expect(side.fu, `sideways (${h}x${w}): the wider screen's five follow-up rows`).toBe(Math.min(5, side.due));
        await turn(w, h);
        const back = await state();
        expect({ cards: back.cards > 0, mine: back.myCard }, `upright again (${w}x${h}): the list cards are back`).toEqual({ cards: true, mine: true });
        expect(back.listMode, `upright again (${w}x${h}): the list`).toBe(true);
        expect(back.fu, `upright again (${w}x${h}): three follow-up rows`).toBe(3);
      }

      // Saved List: phone cards upright, the desktop table sideways, cards again.
      await turn(412, 860);
      await safeEvaluate(page, () => window.crmViewList());
      await waitWith(page, () => document.querySelectorAll('#crmListWrap .cl-card').length > 0, null, 10_000);
      await turn(860, 412);
      const tbl = await state();
      expect({ listMode: tbl.listMode, cards: tbl.cards, table: tbl.rows > 0, mine: tbl.myRow }, 'saved List sideways: the table').toEqual({ listMode: true, cards: 0, table: true, mine: true });
      await turn(412, 860);
      const cards = await state();
      expect({ cards: cards.cards > 0, mine: cards.myCard, rows: cards.rows }, 'saved List upright again: the cards').toEqual({ cards: true, mine: true, rows: 0 });

      // Saved Board: the board both ways; only the follow-up rows re-fit
      // (no refresh in between — the rows follow the rotate by themselves).
      await safeEvaluate(page, () => window.crmViewBoard());
      await waitWith(page, () => !document.body.classList.contains('crm-list-mode'), null, 10_000);
      await turn(860, 412);
      const bSide = await state();
      expect({ listMode: bSide.listMode, board: bSide.board > 0, fu: bSide.fu }, 'saved Board sideways: the board, five follow-up rows')
        .toEqual({ listMode: false, board: true, fu: Math.min(5, bSide.due) });
      await turn(412, 860);
      const bUp = await state();
      expect({ listMode: bUp.listMode, board: bUp.board > 0, fu: bUp.fu }, 'saved Board upright: the board, three follow-up rows')
        .toEqual({ listMode: false, board: true, fu: 3 });
    } finally {
      await page.setViewportSize({ width: 412, height: 860 });
      await safeEvaluate(page, (s) => {
        if (s === 'list') window.crmViewList(); else if (s === 'board') window.crmViewBoard(); else window.crmViewAuto();
      }, saved);
      await settle(page);
    }
  });

  test('list cards show the real stage; swipe advances it; a cancelled swipe snaps back (pipeline#1, #11)', async () => {
    await waitWith(page, (id) => !!document.querySelector(`#crmListWrap .cl-card[data-id="${id}"]`), ids.install, 15_000);
    const shown = await safeEvaluate(page, (list) => list.map((id) => {
      const card = document.querySelector(`#crmListWrap .cl-card[data-id="${id}"]`);
      const sel = card.querySelector('.cl-stage-select');
      return { shows: sel.options[sel.selectedIndex].textContent, truth: window.stageLabel(card.getAttribute('data-stage')) };
    }), [ids.install, ids.closed]);
    expect(shown[0], 'an Installing job reads Installing, not New Lead').toEqual({ shows: 'Installing', truth: 'Installing' });
    expect(shown[1], 'a Closed job reads Closed').toEqual({ shows: 'Closed', truth: 'Closed' });

    // Swipe left on the installing job (moveCard stubbed: nothing is written).
    await safeEvaluate(page, () => {
      window.__ppMoves = []; window.__ppToasts = [];
      window.__ppMoveCard = window.moveCard; window.moveCard = (id, st) => { window.__ppMoves.push([id, st]); };
      window.__ppToast = window.showToast; window.showToast = (m) => { window.__ppToasts.push(m); };
    });
    try {
      const card = page.locator(`#crmListWrap .cl-card[data-id="${ids.install}"]`);
      // Centre it: at the bottom edge the floating ⋯ speed dial covers Open.
      await card.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const a = await card.locator('.cl-card-addr').boundingBox();
      await touchDrag(cdp, page, { x: a.x + a.width * 0.8, y: a.y + a.height / 2 }, -170, 0, 12, false);
      await page.waitForTimeout(300);
      const res = await safeEvaluate(page, () => ({ moves: window.__ppMoves, toasts: window.__ppToasts }));
      expect(res.toasts, 'no false "last stage" toast').not.toContain('Already at the last stage');
      expect(res.moves, 'swipe-left moves an installing job to Install Done').toEqual([[ids.install, 'install_complete']]);

      // Swipe right then have the OS cancel the touch (#11): the card must
      // snap back with Open on screen, and nothing may fire.
      const card2 = page.locator(`#crmListWrap .cl-card[data-id="${ids.closed}"]`);
      await card2.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      const a2 = await card2.locator('.cl-card-addr').boundingBox();
      await touchDrag(cdp, page, { x: a2.x + a2.width * 0.2, y: a2.y + a2.height / 2 }, 120, 0, 12, true);
      await page.waitForTimeout(250);
      await quietToasts(page);
      const st = await safeEvaluate(page, (id) => {
        const c = document.querySelector(`#crmListWrap .cl-card[data-id="${id}"]`);
        return { transform: c.style.transform, swipeClass: /cl-card-swipe-/.test(c.className), openHit: window.__ppHit(c.querySelector('.cl-open')), moves: window.__ppMoves.length };
      }, ids.closed);
      expect(st, 'touchcancel resets the card without acting').toEqual({ transform: '', swipeClass: false, openHit: true, moves: 1 });
    } finally {
      await safeEvaluate(page, () => { window.moveCard = window.__ppMoveCard; window.showToast = window.__ppToast; });
    }
  });

  test('follow-up rows fit a phone, and search results come first (pipeline#6, #7)', async () => {
    await safeEvaluate(page, () => { try { localStorage.removeItem('nbd_crm_followup_hidden'); } catch (_) {} if (window.renderLeads) window.renderLeads(window._leads); });
    await safeWaitForFunction(page, () => getComputedStyle(document.getElementById('followUpAlertsWrap')).display !== 'none', { timeout: 10_000 });
    await toTop(page);
    await quietToasts(page);
    const rows = await safeEvaluate(page, () => {
      const hit = window.__ppHit;
      const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size; };
      return [...document.querySelectorAll('#followUpAlerts .follow-up-alert')].map((row) => {
        const b = row.querySelector('.fa-btn');
        return { btnH: Math.round(b.getBoundingClientRect().height), btnHit: hit(b), dateLines: lines(row.querySelector('.fa-date')), btnLines: lines(b) };
      });
    });
    expect(rows.length, 'a phone shows three follow-up rows').toBe(3);
    for (const r of rows) {
      expect(r.btnH, 'View button is thumb-sized').toBeGreaterThanOrEqual(40);
      expect(r, 'row keeps its date and button on one line each and is tappable').toMatchObject({ btnHit: true, dateLines: 1, btnLines: 1 });
    }
    // "+ N more" is a real button that opens the rest.
    const more = await centre(page, '#followUpAlerts .fa-more');
    await page.touchscreen.tap(more.x, more.y);
    await safeWaitForFunction(page, () => document.querySelectorAll('#followUpAlerts .follow-up-alert').length >= 4, { timeout: 5_000 });

    // Search: a real tap into the box, typed query → the unfiltered follow-up
    // block stands aside and a match sits inside a keyboard-height screen.
    await toTop(page);
    const s = await centre(page, '#crmSearch');
    await page.touchscreen.tap(s.x, s.y);
    await page.keyboard.type(TOKEN + 'Contact');
    await safeWaitForFunction(page, () => /\b1 match\b/.test(document.getElementById('crmSearchCount').textContent), { timeout: 10_000 });
    expect(await safeEvaluate(page, () => getComputedStyle(document.getElementById('followUpAlertsWrap')).display),
      'follow-ups hide while the board is narrowed').toBe('none');
    await page.setViewportSize({ width: 412, height: 530 }); // Android keyboard up
    await quietToasts(page);
    const visible = await safeEvaluate(page, (id) => window.__ppHit(document.querySelector(`#crmListWrap .cl-card[data-id="${id}"] .cl-card-name`)), ids.contacted);
    expect(visible, 'the match is on screen above the keyboard').toBe(true);
    await page.setViewportSize({ width: 412, height: 860 });
    const clr = await centre(page, '#crmSearchClear');
    await page.touchscreen.tap(clr.x, clr.y);
    await safeWaitForFunction(page, () => getComputedStyle(document.getElementById('followUpAlertsWrap')).display !== 'none', { timeout: 10_000 });
  });

  test('Add Lead pairs keep a gutter and line up (pipeline#12)', async () => {
    await toTop(page);
    const b = await centre(page, '#crmAddLeadBtn');
    await page.touchscreen.tap(b.x, b.y);
    await safeWaitForFunction(page, () => document.getElementById('leadModal').classList.contains('open'), { timeout: 10_000 });
    await page.waitForTimeout(400);
    const m = await safeEvaluate(page, () => {
      const rows = [...document.querySelectorAll('#leadModal .mrow')].filter((r) => r.offsetParent);
      const pairs = rows.map((row) => {
        const ctl = [...row.children].filter((c) => c.offsetParent).map((f) => f.querySelector('input,select,textarea'));
        if (ctl.length !== 2 || !ctl[0] || !ctl[1]) return null;
        const a = ctl[0].getBoundingClientRect(), c = ctl[1].getBoundingClientRect();
        return { pair: ctl[0].id + '|' + ctl[1].id, gap: Math.round(c.left - a.right), dy: Math.round(c.top - a.top) };
      }).filter(Boolean);
      const sel = document.getElementById('lDamageType'); const cs = getComputedStyle(sel);
      const g = document.createElement('canvas').getContext('2d'); g.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const inner = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return { pairs, dmgFits: g.measureText(sel.options[sel.selectedIndex].text).width <= inner };
    });
    expect(m.pairs.length, 'two-column rows found').toBeGreaterThanOrEqual(6);
    for (const p of m.pairs) {
      expect(p.gap, `${p.pair} has a gutter`).toBeGreaterThanOrEqual(8);
      expect(Math.abs(p.dy), `${p.pair} inputs line up`).toBeLessThanOrEqual(1);
    }
    expect(m.pairs.map((p) => p.pair), 'Date of Loss stays beside Damage Type (#1743)').toContain('lDamageType|lDateOfLoss');
    expect(m.dmgFits, 'the damage-type placeholder is not cut off').toBe(true);
    const x = await centre(page, '#leadModal .m-modal-bar-x');
    await page.touchscreen.tap(x.x, x.y);
    await safeWaitForFunction(page, () => !document.getElementById('leadModal').classList.contains('open'), { timeout: 5_000 });
  });

  test('board cards keep every control inside the card (pipeline#9)', async () => {
    test.setTimeout(60_000);
    const bb = await centre(page, '#crmViewBoardBtn');
    await page.touchscreen.tap(bb.x, bb.y);
    await waitWith(page, (id) => !document.body.classList.contains('crm-list-mode')
      && !!document.querySelector(`#kanbanBoard .k-card[data-id="${id}"]`), ids.contacted, 10_000);
    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await page.waitForTimeout(300);
      const r = await safeEvaluate(page, () => {
        const bad = [];
        let checked = 0;
        document.querySelectorAll('#kanbanBoard .k-card').forEach((card) => {
          const f = card.querySelector('.kc-footer'); const o = card.querySelector('.kc-overflow');
          if (!f || !o || !card.offsetParent) return;
          checked++;
          const cr = card.getBoundingClientRect(), orr = o.getBoundingClientRect(), clip = card.closest('.kcol-body').getBoundingClientRect();
          if (f.scrollWidth > f.clientWidth + 1 || orr.right > cr.right + 0.5 || orr.right > clip.right + 0.5) bad.push(card.querySelector('.kc-name').textContent.trim());
        });
        const tags = [...document.querySelectorAll('#kanbanBoard .k-card .kc-tag')].filter((t) => t.offsetParent);
        const chips = [...document.querySelectorAll('#kanbanBoard .k-card [data-action="run-next-action"], #kanbanBoard .k-card .kc-phone-link')].filter((t) => t.offsetParent);
        return { bad, checked, nTags: tags.length, nChips: chips.length,
          tagPx: Math.min(...tags.map((t) => parseFloat(getComputedStyle(t).fontSize))),
          chipH: Math.min(...chips.map((t) => t.getBoundingClientRect().height)) };
      });
      expect(r.checked, 'board cards were measured').toBeGreaterThanOrEqual(7);
      expect(r.nTags * r.nChips, 'tags and tappable chips were measured').toBeGreaterThan(0);
      expect(r.bad, `cards whose ⋮ or footer spills out at ${width}px`).toEqual([]);
      expect(r.tagPx, `card tags readable at ${width}px`).toBeGreaterThanOrEqual(10);
      expect(r.chipH, `tappable card chips are 32px tall at ${width}px`).toBeGreaterThanOrEqual(32);
      // A real thumb on the ⋮ of a two-arrow card opens its menu.
      await quietToasts(page);
      const g = await safeEvaluate(page, (id) => {
        const card = document.querySelector(`#kanbanBoard .k-card[data-id="${id}"]`);
        const board = card.closest('.kanban-board');
        board.scrollLeft += card.closest('.kanban-col').getBoundingClientRect().left - 12;
        card.scrollIntoView({ block: 'center' });
        const o = card.querySelector('.kc-overflow'); const r2 = o.getBoundingClientRect();
        return { x: r2.left + r2.width / 2, y: r2.top + r2.height / 2, arrows: card.querySelectorAll('.kc-arrow').length, hit: window.__ppHit(o) };
      }, ids.contacted);
      expect(g.arrows, 'the Contacted card has both arrows').toBe(2);
      expect(g.hit, `⋮ centre is the ⋮ at ${width}px`).toBe(true);
      await page.touchscreen.tap(g.x, g.y);
      await safeWaitForFunction(page, () => !!document.getElementById('nbd-kanban-ctx-menu'), { timeout: 5_000 });
      await safeEvaluate(page, () => window.KanbanContextMenu.close());
    }
    await page.setViewportSize({ width: 412, height: 860 });
  });

  test('job-detail stage chip is readable and its picker reaches Lost (pipeline#2, #4)', async () => {
    // Board mode (the card-tap route into the job detail); a no-op after the
    // board test, needed when this test runs alone.
    if (await safeEvaluate(page, () => document.body.classList.contains('crm-list-mode'))) {
      await toTop(page);
      const bb = await centre(page, '#crmViewBoardBtn');
      await page.touchscreen.tap(bb.x, bb.y);
      await safeWaitForFunction(page, () => !document.body.classList.contains('crm-list-mode'), { timeout: 10_000 });
    }
    await page.setViewportSize({ width: 412, height: 680 });
    // Tap the card's name. Right after login, live refreshes rebuild the
    // board and can move the card between aiming and tapping, so re-aim and
    // retry (never re-tapping once the job detail is open).
    const jdOpen = () => safeEvaluate(page, () => { const e = document.getElementById('mJobDetail'); return !!e && !e.hidden && e.classList.contains('open'); });
    for (let attempt = 0; attempt < 3 && !(await jdOpen()); attempt++) {
      await quietToasts(page);
      await waitWith(page, (id) => !!document.querySelector(`#kanbanBoard .k-card[data-id="${id}"] .kc-name`), ids.fu1, 15_000);
      const n = await safeEvaluate(page, (id) => {
        const card = document.querySelector(`#kanbanBoard .k-card[data-id="${id}"]`);
        card.closest('.kanban-board').scrollLeft = 0;
        card.scrollIntoView({ block: 'center' });
        const r = card.querySelector('.kc-name').getBoundingClientRect();
        return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
      }, ids.fu1);
      await page.touchscreen.tap(n.x, n.y);
      await waitWith(page, () => { const e = document.getElementById('mJobDetail'); return e && !e.hidden && e.classList.contains('open'); }, null, 4_000).catch(() => {});
    }
    expect(await jdOpen(), 'a tap on a board card opens the job detail').toBe(true);
    for (const theme of CHIP_THEMES) {
      await useTheme(page, theme);
      for (const sel of ['#mJdStatus', '#mJdJobType']) {
        const c = await chipContrast(page, sel, '--bg');
        expect(c.ratio, `${sel} "${c.text}" contrast on the top bar (${c.diag})`).toBeGreaterThanOrEqual(4.5);
      }
    }
    await useTheme(page, 'nbd-original');
    const chip = await centre(page, '#mJdStatus');
    await page.touchscreen.tap(chip.x, chip.y);
    await safeWaitForFunction(page, () => !!document.getElementById('nbd-kanban-ctx-menu'), { timeout: 5_000 });
    const fit = await safeEvaluate(page, () => { const m = document.getElementById('nbd-kanban-ctx-menu'); return { bottom: m.getBoundingClientRect().bottom, vh: innerHeight }; });
    expect(fit.bottom, 'the stage picker fits the screen').toBeLessThanOrEqual(fit.vh);
    // A live data refresh re-renders the pipeline behind the overlay; the
    // page shrinks for a frame and scrollY clamps. That scroll used to
    // dismiss the picker mid-choice (seen at scrollY 369→169 on this very
    // test). The overlay anchor doesn't move, so the picker must stay.
    await safeEvaluate(page, () => {
      if (window.renderLeads) window.renderLeads(window._leads);
      window.scrollBy(0, -120);
      window.dispatchEvent(new Event('scroll'));
    });
    await page.waitForTimeout(250);
    expect(await safeEvaluate(page, () => !!document.getElementById('nbd-kanban-ctx-menu')),
      'a page scroll / re-render behind the job detail leaves the stage picker open').toBe(true);
    const box = await page.locator('#nbd-kanban-ctx-menu').boundingBox();
    await touchDrag(cdp, page, { x: box.x + box.width / 2, y: box.y + box.height - 40 }, 0, -500, 25, false);
    await page.waitForTimeout(400);
    await quietToasts(page);
    const lost = await safeEvaluate(page, () => {
      const m = document.getElementById('nbd-kanban-ctx-menu');
      const item = m && [...m.querySelectorAll('.nbd-ctx-item')].find((b) => /\bLost\b/.test(b.textContent));
      if (!item) return { ok: false, diag: m ? 'no Lost item' : 'picker closed' };
      const r = item.getBoundingClientRect();
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { ok: window.__ppHit(item), diag: `menu scrollTop=${m.scrollTop}/${m.scrollHeight - m.clientHeight} Lost y=${Math.round(r.top)}-${Math.round(r.bottom)} vh=${innerHeight} hit=${h ? h.tagName + '#' + h.id + '.' + String(h.className).split(' ')[0] : 'none'}` };
    });
    expect(lost.ok, `after a finger drag, Lost is on screen and tappable (${lost.diag})`).toBe(true);
    await safeEvaluate(page, () => { window.KanbanContextMenu.close(); if (window.closeMobileJobDetail) window.closeMobileJobDetail(); });
    await page.setViewportSize({ width: 412, height: 860 });
  });

  // The header's ⋮ kebab (Theme & Font / Settings / Theme Guide) had the
  // same lifecycle bugs the pipeline menus were fixed for (2026-09-25 phone
  // nav polish): click-only outside closing, which WebKit never triggers for
  // a tap on plain page; one leaked listener per close from the button; and
  // an item left it open over what it opened.
  test('header kebab: a touch beside closes it with no click, an item closes it, no close leaves a listener behind (nav polish #1)', async () => {
    test.setTimeout(90_000);
    // Count the kebab's document capture listeners as they are added and
    // removed. Own properties on document sit in front of whatever wraps
    // addEventListener further up (Sentry does), and only listeners whose
    // source names #hdrMobileBtn count, so other modules can't move the tally.
    await safeEvaluate(page, () => {
      const live = window.__ppKebabLive = new Set();
      const ids = new WeakMap(); let n = 0;
      const key = (t, f) => { if (!ids.has(f)) ids.set(f, ++n); return t + ':' + ids.get(f); };
      const mine = (t, f, o) => (t === 'click' || t === 'pointerdown') && typeof f === 'function'
        && (o === true || !!(o && o.capture)) && String(f).indexOf('#hdrMobileBtn') !== -1;
      const add = document.addEventListener, rem = document.removeEventListener;
      document.addEventListener = function (t, f, o) { if (mine(t, f, o)) live.add(key(t, f)); return add.call(this, t, f, o); };
      document.removeEventListener = function (t, f, o) { if (mine(t, f, o)) live.delete(key(t, f)); return rem.call(this, t, f, o); };
    });
    const settles = async (want) => {
      await waitWith(page, (w) => document.getElementById('hdrMobileMenu').classList.contains('open') === w, want, 1_500).catch(() => {});
      return safeEvaluate(page, () => document.getElementById('hdrMobileMenu').classList.contains('open'));
    };
    // toTop() lines the pipeline header up with the top of the screen, which
    // can scroll the app header (and ⋮) off it. Bring the app header in, then
    // the pipeline title only if it isn't already on screen.
    const headerInView = async () => {
      await safeEvaluate(page, () => {
        document.getElementById('hdrMobileBtn').scrollIntoView({ block: 'start' });
        document.querySelector('#view-crm .crm-hdr-title').scrollIntoView({ block: 'nearest' });
      });
      await page.waitForTimeout(150);
      expect(await safeEvaluate(page, () => window.__ppHit(document.getElementById('hdrMobileBtn'))
        && window.__ppHit(document.querySelector('#view-crm .crm-hdr-title'))), 'precondition: ⋮ and the pipeline title are both on screen').toBe(true);
    };
    // The previous test ends on a CDP finger drag, and the first tap after one
    // can be swallowed as a fling-stop (see the header menus test above). A
    // touch that fires no click stops any fling first.
    await headerInView();
    const t0 = await centre(page, '#view-crm .crm-hdr-title');
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: t0.x, y: t0.y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(200);
    try {
      for (const width of [412, 360]) {
        await page.setViewportSize({ width, height: 860 });
        await headerInView();
        await quietToasts(page);
        const k = await centre(page, '#hdrMobileBtn');
        await page.touchscreen.tap(k.x, k.y);
        expect(await settles(true), `a tap on ⋮ opens the kebab (${width}px)`).toBe(true);
        // A touch beside it that arrives with NO click, which is what WebKit
        // sends for a tap on the pipeline title (touchStart + touchCancel
        // gives Chromium the same shape: pointerdown, no click).
        const t = await centre(page, '#view-crm .crm-hdr-title');
        expect(await safeEvaluate(page, ([x, y]) => !document.getElementById('hdrMobileMenu').contains(document.elementFromPoint(x, y)), [t.x, t.y]),
          'the title is beside the kebab menu, not under it').toBe(true);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: t.x, y: t.y }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        expect(await settles(false), `a touch beside the kebab closes it with no click (${width}px)`).toBe(false);
        await page.touchscreen.tap(k.x, k.y);
        expect(await settles(true), `⋮ reopens it (${width}px)`).toBe(true);
        await page.touchscreen.tap(k.x, k.y);
        expect(await settles(false), `a second tap on ⋮ closes it (${width}px)`).toBe(false);
      }
      // An item that acts closes the kebab: Theme Guide opens its sheet over
      // the pipeline, with the kebab gone from behind it.
      await page.setViewportSize({ width: 412, height: 860 });
      await headerInView();
      const k = await centre(page, '#hdrMobileBtn');
      await page.touchscreen.tap(k.x, k.y);
      expect(await settles(true), 'the kebab opens for the item tap').toBe(true);
      const g = await centre(page, '#hdrMobileMenu [data-fn="nbdHowtoOpen"]');
      await page.touchscreen.tap(g.x, g.y);
      await waitWith(page, () => document.getElementById('nbd-howto-modal').classList.contains('open'), null, 5_000);
      expect(await settles(false), 'Theme Guide closes the kebab').toBe(false);
      expect(await safeEvaluate(page, () => document.getElementById('hdrMobileBtn').getAttribute('aria-expanded')), 'aria-expanded follows the close').toBe('false');
      expect(await safeEvaluate(page, () => window.__ppKebabLive.size), 'kebab outside-tap listeners still attached after every close').toBe(0);
    } finally {
      await safeEvaluate(page, () => {
        delete document.addEventListener; delete document.removeEventListener;
        if (typeof window.nbdHowtoClose === 'function') window.nbdHowtoClose();
        document.getElementById('hdrMobileMenu').classList.remove('open');
      });
      await page.setViewportSize({ width: 412, height: 860 });
    }
  });

  // Card density opens nothing, and a rep steps it Compact → Comfortable →
  // Spacious looking at the board. The "an item that acts closes its menu"
  // rule closed Tools after every step (2026-09-25 phone nav polish).
  test('Card density steps through its sizes with Tools left open; other Tools items still close it (nav polish #4)', async () => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 412, height: 860 });
    await toTop(page);
    const density = () => safeEvaluate(page, () => { try { return localStorage.getItem('nbd-kanban-density') || 'comfortable'; } catch (_) { return 'comfortable'; } });
    const start = await density();
    const ORDER = ['compact', 'comfortable', 'spacious'];
    const NAMES = { compact: 'Compact', comfortable: 'Comfortable', spacious: 'Spacious' };
    const label = () => safeEvaluate(page, () => document.querySelector('#kanbanDensityToggleBtn .crm-hdr-btn-label').textContent.trim());
    try {
      await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', true);
      expect(await label(), 'opening Tools names the current size').toBe('Card density: ' + NAMES[start]);
      let cur = start;
      for (let i = 0; i < 3; i++) {
        // No waiting for toasts between steps: a rep taps again straight
        // away. Each step used to toast its size onto the button itself
        // (412x860), so the next tap closed Tools instead of stepping.
        const d = await safeEvaluate(page, () => {
          const b = document.getElementById('kanbanDensityToggleBtn');
          b.scrollIntoView({ block: 'nearest' });
          const r = b.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, hit: window.__ppHit(b) };
        });
        expect(d.hit, `Card density is reachable in the open Tools menu (step ${i + 1})`).toBe(true);
        await page.touchscreen.tap(d.x, d.y);
        const want = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
        await waitWith(page, (w) => (localStorage.getItem('nbd-kanban-density') || 'comfortable') === w, want, 5_000);
        cur = want;
        await page.waitForTimeout(400); // past the delegate's 220ms toggle close, had it applied
        expect(await safeEvaluate(page, () => document.getElementById('crmToolsMenu').classList.contains('open')),
          `Tools stays open after stepping density to ${want}`).toBe(true);
        expect(await label(), 'the item names the size it stepped to').toBe('Card density: ' + NAMES[want]);
      }
      expect(cur, 'three taps come back round to where the rep started').toBe(start);
      // The exemption is density's alone: Find duplicates still closes Tools.
      await quietToasts(page);
      const dup = await centre(page, '#crmToolsMenu button[data-fn="openDupReview"]');
      await page.touchscreen.tap(dup.x, dup.y);
      await safeWaitForFunction(page, () => !!document.getElementById('dupReviewOverlay'), { timeout: 5_000 });
      expect(await menuSettles(page, 'crmToolsMenu', false), 'Find duplicates still closes Tools').toBe(false);
    } finally {
      await safeEvaluate(page, (s) => {
        const o = document.getElementById('dupReviewOverlay'); if (o) o.remove();
        if (typeof window.setKanbanDensity === 'function') window.setKanbanDensity(s);
        window.closeCrmToolsMenu();
      }, start);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// The menu clipping (#0), the list-table stage select (#1) and the stage
// chip contrast (#4) were desktop bugs too.
test.describe('pipeline on desktop @audit', () => {
  test.describe.configure({ mode: 'serial' });
  let creds = null, context = null, page = null, ids = null;
  const TOKEN = 'Zpd' + Math.random().toString(36).slice(2, 7);

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    try { creds = requireTestUser(); } catch (e) { return; }
    context = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: 'block' });
    await setupContext(context);
    page = await context.newPage();
    await loginAs(page, creds);
    await skipTour(page);
    ids = await seedLeads(page, TOKEN);
    await openCrm(page);
    await settle(page);
  });
  test.afterAll(async () => {
    test.setTimeout(60_000);
    if (page) await deleteLeads(page, ids);
    if (context) await context.close();
  });
  test.beforeEach(async ({}, testInfo) => { if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set'); });

  test('Tools and Filters menus take real clicks at 1280px (pipeline#0)', async () => {
    for (const [btn, menu] of [['#crmToolsBtn', 'crmToolsMenu'], ['#crmFiltersBtn', 'crmFiltersMenu']]) {
      const r = await openMenuAndHitTest(page, btn, menu, false);
      expect(r.missed, `${menu} items a cursor can't reach`).toEqual([]);
    }
    await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', false);
    const dup = await centre(page, '#crmToolsMenu button[data-fn="openDupReview"]');
    await page.mouse.click(dup.x, dup.y);
    await safeWaitForFunction(page, () => !!document.getElementById('dupReviewOverlay'), { timeout: 5_000 });
    await safeEvaluate(page, () => { const o = document.getElementById('dupReviewOverlay'); if (o) o.remove(); });
  });

  test('a second click closes a menu; Deleted leads closes Tools; a resize re-places an open menu (pipeline#0 follow-ups)', async () => {
    for (const [btn, menu] of MENUS) {
      await openMenuAndHitTest(page, btn, menu, false);
      const c = await centre(page, btn);
      await page.mouse.click(c.x, c.y);
      expect(await menuSettles(page, menu, false), `a second click on ${btn} closes ${menu}`).toBe(false);
    }
    // The menu paints above the FAB stack now, so one left open behind the
    // Deleted leads drawer (z 1500) would paint over the drawer.
    await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', false);
    const was = await page.locator('#crmToolsMenu').boundingBox();
    const del = await centre(page, '#crmToolsMenu [data-fn="openDeletedDrawer"]');
    await page.mouse.click(del.x, del.y);
    await waitWith(page, () => { const d = document.getElementById('deletedDrawer'); return d.classList.contains('open') && Math.abs(d.getBoundingClientRect().right - innerWidth) < 1; }, null, 5_000);
    const r = await safeEvaluate(page, (b) => {
      const h = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { toolsOpen: document.getElementById('crmToolsMenu').classList.contains('open'),
        onDrawer: !!h && document.getElementById('deletedDrawer').contains(h), by: h ? h.tagName + '#' + h.id + '.' + String(h.className).split(' ')[0] : 'nothing' };
    }, was);
    expect(r.toolsOpen, 'Deleted leads closes the Tools menu').toBe(false);
    expect(r.onDrawer, `the drawer, not the menu, is on top where the menu was (hit ${r.by})`).toBe(true);
    await safeEvaluate(page, () => document.getElementById('deletedDrawer').classList.remove('open'));
    await page.waitForTimeout(400);
    // Narrow the window with Tools open: the phone layout moves the button
    // to the left, and the menu has to follow it.
    await openMenuAndHitTest(page, '#crmToolsBtn', 'crmToolsMenu', false);
    await page.setViewportSize({ width: 700, height: 860 });
    await page.waitForTimeout(300);
    const n = await menuReport(page, 'crmToolsMenu');
    await page.setViewportSize({ width: 1280, height: 860 });
    await safeEvaluate(page, () => window.closeCrmToolsMenu());
    expect(n.open, 'Tools stays open through the resize').toBe(true);
    expect(n.left, 'Tools left edge on screen at 700px').toBeGreaterThanOrEqual(0);
    expect(n.right, 'Tools right edge on screen at 700px').toBeLessThanOrEqual(n.vw);
    expect(n.covered, 'Tools items a cursor can\'t reach at 700px').toEqual([]);
  });

  test('list table shows the real stage; card-detail chips are readable (pipeline#1, #4)', async () => {
    await page.locator('#crmViewListBtn').click();
    await waitWith(page, (id) => !!document.querySelector(`#crmListWrap tr.crm-list-row[data-id="${id}"]`), ids.install, 10_000);
    const shows = await safeEvaluate(page, (id) => { const s = document.querySelector(`#crmListWrap tr.crm-list-row[data-id="${id}"] .cl-stage-select`); return s.options[s.selectedIndex].textContent; }, ids.install);
    expect(shows, 'an Installing job reads Installing in the table').toBe('Installing');
    await page.locator('#crmViewBoardBtn').click();
    await waitWith(page, (id) => !!document.querySelector(`#kanbanBoard .k-card[data-id="${id}"] .kc-name`), ids.fu1, 10_000);
    await safeEvaluate(page, (id) => document.querySelector(`#kanbanBoard .k-card[data-id="${id}"]`).scrollIntoView({ block: 'center' }), ids.fu1);
    await page.locator(`#kanbanBoard .k-card[data-id="${ids.fu1}"] .kc-name`).click();
    await safeWaitForFunction(page, () => document.getElementById('cardDetailModal').classList.contains('open'), { timeout: 10_000 });
    for (const theme of CHIP_THEMES) {
      await useTheme(page, theme);
      for (const sel of ['#cardDetailStage', '#cardDetailJobType']) {
        const c = await chipContrast(page, sel, '--s2');
        expect(c.ratio, `${sel} "${c.text}" contrast (${c.diag})`).toBeGreaterThanOrEqual(4.5);
      }
    }
    await useTheme(page, 'nbd-original');
  });
});
