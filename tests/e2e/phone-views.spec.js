// tests/e2e/phone-views.spec.js — phone-scale regressions for the dashboard
// widgets, the header bell, Settings, Products and Sales Training.
//
// Phone audit 2026-09-25, lane "views" (Jo runs the business from an Android
// at ~412px; standing rule: the CRM must fit and work flawlessly there, in
// light AND dark mode). Each block below pins one fixed finding by its
// BEHAVIOUR — what a thumb can reach, what an eye can read — with real taps
// and hit-testing (document.elementFromPoint at a control's centre must be
// that control), never by checking that a class is present: the pipeline
// menus stayed "green" for months behind a test that only looked for `.open`.
//
//   views#4  Hot Leads rows showed no name (0px track) and 💤 clipped at 360
//   views#5  Next Best Actions cut every headline before the customer's name
//   views#8  bell rows squeezed to a 98px text column; 11px-tall header buttons
//   views#6  Settings > Profile stayed two 145px columns
//   views#7  Settings > Team invite box 66px wide, typed text invisible (light)
//   views#9  Pipelines editor: 22x20 arrows, Save only 7 screens up; and
//            (follow-up) leaving the tab or view silently dropped edits
//   views#13 brand colour pickers rendered as a 5px grey rule
//   views#14 Products: 22px Edit/Archive in an 88,000px list
//   views#3  Objection Obliterator text dark-on-navy in light mode
//   views#11 light-mode chrome / cohort / Talk Tank contrast
//   upgrades Settings > Estimates > Upgrade prices (2026-09-25, Upgrades &
//            Add-ons stage 2): price a needs_price item, switch one Off,
//            Save, reload — persisted in Firestore and seen by NBDUpgrades
//   profretry a companyProfile read that gave up at boot (2026-09-25) is
//            retried; Settings > Estimates refuses unhydrated saves out loud
//            and repaints when the read lands (412, 360, and desktop 1280);
//            really offline with a write pending, the SDK's partial local
//            copy never counts as loaded; a late landing keeps typing
//
// Every describe logs in ONCE and walks its surfaces in steps, so the whole
// file stays around two minutes at --workers=1. Tagged @audit so it rides the
// audit shard of the authed emulator job. Run locally against a served tree:
//   cd tests && PLAYWRIGHT_BASE_URL=http://127.0.0.1:5000 \
//     PLAYWRIGHT_TEST_USER_EMAIL=playwright-e2e@nbd.test \
//     PLAYWRIGHT_TEST_USER_PASSWORD=nbd-e2e-password-1 \
//     npx playwright test --config=playwright.config.js phone-views.spec.js --workers=1
const { test, expect } = require('@playwright/test');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { devices } = require('@playwright/test');
const { requireTestUser, loginAs, safeEvaluate, safeWaitForFunction } = require('./fixtures/auth');

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

test.use({
  viewport: { width: 412, height: 860 },
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
  userAgent: ANDROID_UA,
  // A tap that can't land should fail naming the control, not burn the
  // whole test timeout retrying.
  actionTimeout: 15_000,
});

let creds;
test.beforeAll(() => {
  try { creds = requireTestUser(); }
  catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[phone-views] ' + e.message);
  }
});

test.beforeEach(async ({ page }, testInfo) => {
  if (!creds) testInfo.skip(true, 'PLAYWRIGHT_TEST_USER_EMAIL not set');
  // Transient overlays aren't what this spec measures, and on a fresh
  // profile they land on top of the controls it hit-tests: the first-run
  // onboarding tour (a full-screen overlay that swallows taps) and Ask Joe's
  // once-a-day proactive nudges (a toast that sat over the brand colour
  // picker). Mark both as already done for today.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      const today = new Date().toISOString().split('T')[0];
      localStorage.setItem('nbd_proactive_overdue_scan', today);
      localStorage.setItem('nbd_proactive_pending_estimate_scan', today);
    } catch (_) { /* storage blocked: the hit-test polls below still cope */ }
  });
  // No Cloud Function call leaves this spec: with --only hosting a callable
  // would reach PRODUCTION (ci-e2e-calls-production-functions), and the Next
  // Best Actions AI enrichment would rewrite the headlines under the
  // assertions. An immediate UNAVAILABLE keeps the heuristic headlines.
  await page.route(/cloudfunctions\.net|\.run\.app\/|127\.0\.0\.1:5001\//, (route) => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'mocked by phone-views.spec' } }),
  }));
});

// ── helpers ────────────────────────────────────────────────────────────────

async function skipTour(page) {
  const skip = page.getByText('Skip tour', { exact: true });
  if (await skip.isVisible().catch(() => false)) await skip.tap({ timeout: 3_000 }).catch(() => {});
}

// The lead widgets re-render on every nbd:data-refreshed (and the leads
// snapshot can land mid-test), which detaches rows under a locator. Wait
// until the container has stopped changing before measuring or tapping.
async function settled(page, selector) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const html = el.innerHTML;
    const now = Date.now();
    const s = (window.__pvSettle = window.__pvSettle || {});
    if (s[sel] !== html) { s[sel] = html; s[sel + ':t'] = now; return false; }
    return now - s[sel + ':t'] >= 1000;
  }, selector, { timeout: 20_000, polling: 100 });
}

// Settings panels fade in; a screenshot or contrast read mid-fade sees the
// page through the panel. Wait out finite animations (infinite ones — a
// pulsing status dot — never finish and don't matter here).
async function animationsDone(page) {
  await safeWaitForFunction(page, () => document.getAnimations().every((a) => {
    const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : {};
    return a.playState !== 'running' || t.iterations === Infinity;
  }), { timeout: 10_000 });
}

async function boot(page, { reload = false } = {}) {
  await loginAs(page, creds);
  if (reload) {
    // Second boot: a returning phone has nbd_pro_theme saved, so the lazy
    // theme bundle loads and paints the light palette (the first boot of a
    // fresh profile never does).
    await page.reload();
    await page.waitForURL(/\/pro\/dashboard/);
  }
  await safeWaitForFunction(page, () => typeof window.goTo === 'function' && Array.isArray(window._leads), { timeout: 30_000 });
  await skipTour(page);
  // Demo leads carry phone + email, so the lead widgets render the full
  // 📞💬📧🔍💤 cluster the bugs needed. Seed once per emulator, never twice.
  await safeEvaluate(page, async () => {
    const have = (window._leads || []).some((l) => l && !l.deleted && l.lastName === 'Kowalski');
    if (!have && typeof window.seedDemoLeads === 'function' && window._user) {
      await window.seedDemoLeads(window._user.uid);
      if (typeof window._loadLeads === 'function') await window._loadLeads();
    }
  });
  await skipTour(page);
}

async function openMore(page, target) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#mni-more').tap();
  const item = page.locator(`#mobile-more-menu .mm-item[data-target="${target}"]`);
  await item.scrollIntoViewIfNeeded();
  await item.tap();
  await skipTour(page);
}

async function openSettingsTab(page, tab) {
  const btn = page.locator(`#stab-${tab}`);
  await btn.scrollIntoViewIfNeeded();
  await btn.tap();
  await expect(page.locator(`#stab-panel-${tab}`)).toBeVisible();
  await animationsDone(page);
}

// Is el's centre topmost? Returns a failure string or ''.
function hitProbeSrc() {
  window.__pvHit = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return 'zero-size';
    const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (h && (h === el || el.contains(h))) return '';
    return 'covered by ' + (h ? h.tagName.toLowerCase() + (h.id ? '#' + h.id : '') + (typeof h.className === 'string' && h.className ? '.' + h.className.split(' ')[0] : '') : 'nothing (off-screen)');
  };
  // Contrast of el's text against what is actually painted behind it:
  // translucent layers composited up the tree, a gradient read at its first
  // stop, white canvas underneath.
  window.__pvContrast = (el) => {
    const parse = (s) => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const over = (t, b) => { const a = t.a + b.a * (1 - t.a); return { r: (t.r * t.a + b.r * b.a * (1 - t.a)) / a, g: (t.g * t.a + b.g * b.a * (1 - t.a)) / a, b: (t.b * t.a + b.b * b.a * (1 - t.a)) / a, a }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (/gradient/.test(cs.backgroundImage)) { const g = parse((cs.backgroundImage.match(/rgba?\([^)]+\)/) || [])[0]); if (g) { layers.push(g); if (g.a >= 1) break; } }
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    let fg = parse(getComputedStyle(el).color);
    if (fg.a < 1) fg = over(fg, bg);
    const l1 = lum(fg), l2 = lum(bg);
    return +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
  };
  // Is `needle` inside el's text laid out entirely within el's own box (not
  // clipped by an ellipsis, a line clamp, or a zero-width track)?
  window.__pvTextVisible = (el, needle) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1) return 'element is ' + box.width + 'px wide';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walker.nextNode());) {
      const i = n.textContent.indexOf(needle);
      if (i < 0) continue;
      const range = document.createRange();
      range.setStart(n, i); range.setEnd(n, i + needle.length);
      const rects = [...range.getClientRects()];
      const out = rects.filter((q) => q.left < box.left - 1 || q.right > box.right + 1 || q.top < box.top - 1 || q.bottom > box.bottom + 1);
      if (!rects.length) return 'no layout for "' + needle + '"';
      return out.length ? '"' + needle + '" runs outside the ' + Math.round(box.width) + 'x' + Math.round(box.height) + ' box' : '';
    }
    return 'text "' + needle + '" not found in "' + el.textContent.trim().slice(0, 60) + '"';
  };
}

async function installProbes(page) { await safeEvaluate(page, hitProbeSrc); }

// Minimal PNG reader (8-bit RGB/RGBA, non-interlaced — what Chromium's
// screenshots are) so a swatch's painted colour can be sampled.
function decodePng(buf) {
  let p = 8; let w; let h; let depth; let type; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const kind = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    p += 12 + len;
  }
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 0;
  if (depth !== 8 || !bpp) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type})`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y ? px[dst - stride + x] : 0;
      const c = x >= bpp && y ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c; const pa = Math.abs(q - a); const pb = Math.abs(q - b); const pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  return { w, h, at: (x, y) => { const i = y * stride + x * bpp; return [px[i], px[i + 1], px[i + 2]]; } };
}

// ── dashboard widgets + bell ───────────────────────────────────────────────

test.describe('phone views: dashboard lead widgets and the bell @audit', () => {
  test('Hot Leads, Next Best Actions and the bell fit 412 and 360', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    await installProbes(page);

    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator('#mni-dash').tap();
      await safeEvaluate(page, () => window.dispatchEvent(new Event('nbd:data-refreshed')));
      await expect(page.locator('#hot-leads-body .hot-lead-row').first()).toBeVisible({ timeout: 15_000 });
      await settled(page, '#hot-leads-body');

      await test.step(`views#4 Hot Leads rows show the name and every action @${width}`, async () => {
        const rows = await page.evaluate(async () => {
          const out = [];
          const SEL = '#hot-leads-body .hot-lead-row';
          for (let i = 0; i < document.querySelectorAll(SEL).length; i++) {
            document.querySelectorAll(SEL)[i].scrollIntoView({ block: 'center' });
            await new Promise((r) => setTimeout(r, 60));
            // Re-query after the wait: a data refresh re-renders the widget
            // and would leave a held row detached. Measure synchronously.
            const row = document.querySelectorAll(SEL)[i];
            if (!row) break;
            const nameLine = row.children[1] && row.children[1].firstElementChild;
            const lead = (window._leads || []).find((l) => l && l.id === row.getAttribute('data-lead-id')) || {};
            const first = String(lead.firstName || '').trim() || (nameLine ? nameLine.textContent.trim().split(/\s+/)[0] : '');
            const panel = row.closest('.panel').getBoundingClientRect();
            const acts = [...row.querySelectorAll('.hl-action')].map((a) => {
              const r = a.getBoundingClientRect();
              const inPanel = r.left >= panel.left - 1 && r.right <= panel.right + 1;
              return (inPanel ? '' : `${a.dataset.action} outside the card (${Math.round(r.left)}-${Math.round(r.right)} vs ${Math.round(panel.left)}-${Math.round(panel.right)}) `) + (window.__pvHit(a) ? `${a.dataset.action} ${window.__pvHit(a)}` : '');
            }).filter(Boolean);
            out.push({ first, nameProblem: nameLine ? window.__pvTextVisible(nameLine, first) : 'no name line', acts, nActs: row.querySelectorAll('.hl-action').length });
          }
          return out;
        });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.some((r) => r.nActs >= 4), 'at least one row carries a 4-5 action cluster (the case that squeezed the name)').toBe(true);
        for (const r of rows) {
          expect(r.nameProblem, `Hot Leads row for "${r.first}" must show the name`).toBe('');
          expect(r.acts, `Hot Leads row for "${r.first}": every action inside the card and tappable`).toEqual([]);
        }
      });

      await test.step(`views#4 a real tap on 💤 opens snooze without sliding the card @${width}`, async () => {
        await settled(page, '#hot-leads-body');
        const snooze = page.locator('#hot-leads-body .hot-lead-row .hl-action[data-action="snooze"]').last();
        await snooze.tap();
        await expect(page.locator('#nbd-snooze-overlay')).toBeVisible();
        // A button past the card's overflow:hidden edge is only "tappable" to
        // Playwright, which scrolls the clipped card sideways to reach it — a
        // finger can't. The card must not have moved.
        const scrollLeft = await page.evaluate(() => document.querySelector('#hot-leads-body').closest('.panel').scrollLeft);
        expect(scrollLeft, 'Hot Leads card was scrolled sideways to reach 💤').toBe(0);
        await page.locator('#nbd-snooze-cancel').tap();
        await expect(page.locator('#nbd-snooze-overlay')).toHaveCount(0);
      });

      await test.step(`views#5 Next Best Actions headlines reach the customer's name @${width}`, async () => {
        await expect(page.locator('#smart-followup-briefing-body .sfb-row').first()).toBeVisible({ timeout: 15_000 });
        await settled(page, '#smart-followup-briefing-body');
        const rows = await page.evaluate(async () => {
          const out = [];
          const SEL = '#smart-followup-briefing-body .sfb-row';
          for (let i = 0; i < document.querySelectorAll(SEL).length; i++) {
            document.querySelectorAll(SEL)[i].scrollIntoView({ block: 'center' });
            await new Promise((r) => setTimeout(r, 60));
            const row = document.querySelectorAll(SEL)[i];
            if (!row) break;
            const lead = (window._leads || []).find((l) => l && l.id === row.getAttribute('data-sfb-lead-id')) || {};
            const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
            const headline = row.querySelector('.sfb-headline');
            if (!name || !headline.textContent.includes(name)) { out.push({ name, skipped: true }); continue; }
            out.push({
              name,
              nameProblem: window.__pvTextVisible(headline, name),
              acts: [...row.querySelectorAll('.sfb-action')].map((a) => window.__pvHit(a)).filter(Boolean),
              minAct: Math.min(...[...row.querySelectorAll('.sfb-action')].map((a) => Math.min(a.getBoundingClientRect().width, a.getBoundingClientRect().height))),
            });
          }
          return out;
        });
        const checked = rows.filter((r) => !r.skipped);
        expect(checked.length, 'at least one headline names its customer').toBeGreaterThan(0);
        for (const r of checked) {
          expect(r.nameProblem, `Next Best Actions headline must show "${r.name}"`).toBe('');
          expect(r.acts, `Next Best Actions actions for ${r.name} tappable`).toEqual([]);
          // Same 36px touch floor as the other lead widgets' actions (Wave 81).
          expect(r.minAct, `Next Best Actions action size for ${r.name}`).toBeGreaterThanOrEqual(36);
        }
      });

      await test.step(`views#8 the bell's rows give the title the row, and every control is thumb-sized @${width}`, async () => {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator('#notifBtn').tap();
        await expect(page.locator('#notifDropdown')).toBeVisible();
        const bell = await page.evaluate(() => {
          const dd = document.getElementById('notifDropdown');
          const items = [...dd.querySelectorAll('#notifList .notif-item')].slice(0, 4).map((it) => {
            const col = it.children[1];
            return { title: col.children[0].textContent.trim().slice(0, 40), colW: col.getBoundingClientRect().width, itemW: it.getBoundingClientRect().width };
          });
          const controls = [...dd.querySelectorAll('button[data-fn="markAllNotificationsRead"], #clearAllNotifBtn, #notifList .notif-item button[data-nb-action="dismiss"]')].slice(0, 3).map((b) => {
            const r = b.getBoundingClientRect();
            return { label: b.textContent.trim() || b.title, h: Math.round(r.height), w: Math.round(r.width), hit: window.__pvHit(b) };
          });
          const nav = document.getElementById('mobile-nav').getBoundingClientRect();
          const list = document.getElementById('notifList');
          return { items, controls, ddBottom: dd.getBoundingClientRect().bottom, navTop: nav.top, listH: list.clientHeight, listMore: list.scrollHeight > list.clientHeight + 1 };
        });
        expect(bell.items.length, 'bell has rows to measure').toBeGreaterThan(0);
        for (const it of bell.items) {
          expect(it.colW, `bell row "${it.title}": the text column should get most of the row, not a sliver beside the actions`).toBeGreaterThanOrEqual(it.itemW * 0.6);
        }
        for (const c of bell.controls) {
          expect(c.h, `bell control "${c.label}" height`).toBeGreaterThanOrEqual(32);
          expect(c.w, `bell control "${c.label}" width`).toBeGreaterThanOrEqual(32);
          expect(c.hit, `bell control "${c.label}"`).toBe('');
        }
        expect(bell.ddBottom, 'the open bell panel must stop above the bottom nav').toBeLessThanOrEqual(bell.navTop);
        // With more alerts than fit, the list uses the panel's height rather
        // than its old inline 300px cap (2-3 of 10 rows visible).
        if (bell.listMore) expect(bell.listH, 'bell list height when it has more to show').toBeGreaterThan(300);
        await page.locator('#notifBtn').tap();
        await expect(page.locator('#notifDropdown')).toBeHidden();
      });
    }
  });
});

// ── Settings ───────────────────────────────────────────────────────────────

test.describe('phone views: Settings panels @audit', () => {
  test('Profile, Team, Company Profile and Pipelines work at phone width', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);
    await installProbes(page);
    await openMore(page, 'settings');
    await expect(page.locator('#stab-panel-profile')).toBeVisible({ timeout: 15_000 });

    for (const width of [412, 360]) {
      await page.setViewportSize({ width, height: 860 });
      await test.step(`views#6 Profile fields stack one per row @${width}`, async () => {
        await openSettingsTab(page, 'profile');
        const rows = await page.evaluate(() => [...document.querySelectorAll('#stab-panel-profile .sf-row')].map((row) => {
          const rw = row.getBoundingClientRect().width;
          return { label: (row.querySelector('label') || row).textContent.trim().slice(0, 30), rw, fields: [...row.children].map((f) => f.getBoundingClientRect().width) };
        }));
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
          for (const fw of r.fields) expect(fw, `Profile field "${r.label}" should span the row on a phone`).toBeGreaterThanOrEqual(r.rw * 0.9);
        }
        const digestLabelH = await page.evaluate(() => document.getElementById('settingsWeeklyDigest').closest('label').getBoundingClientRect().height);
        expect(digestLabelH, '"Send me the weekly digest" should read in a few lines, not a 9px column').toBeLessThanOrEqual(64);
      });

      // 2026-09-25 follow-up: Team, the brand colour pickers and Pipelines
      // ran at 412 only; they walk 360 too now, in the same pass as Profile.
      await test.step(`views#7 Team: the invite address is full width and its text visible @${width}`, async () => {
        await openSettingsTab(page, 'team');
        const email = page.locator('#inviteRepEmail');
        await email.scrollIntoViewIfNeeded();
        await email.tap();
        await page.keyboard.type('alice.estimator@example.test');
        const m = await page.evaluate(() => {
          const el = document.getElementById('inviteRepEmail');
          const send = document.querySelector('[data-fn="inviteTeamMember"]');
          return { w: el.clientWidth, sw: el.scrollWidth, contrast: window.__pvContrast(el), owner: window.__pvContrast(document.getElementById('teamOwnerName')), sendHit: window.__pvHit(send) };
        });
        expect(m.w, 'invite email box width').toBeGreaterThanOrEqual(200);
        expect(m.sw, 'the whole typed address fits the box').toBeLessThanOrEqual(m.w + 2);
        expect(m.contrast, 'typed address contrast').toBeGreaterThanOrEqual(4.5);
        expect(m.owner, 'owner name contrast').toBeGreaterThanOrEqual(4.5);
        expect(m.sendHit, 'Send Invite reachable').toBe('');
        await email.fill('');
      });

      await test.step(`views#13 brand colour pickers show the saved colour @${width}`, async () => {
        await openSettingsTab(page, 'company-profile');
        const picker = page.locator('#cp_brand_colorAccent');
        await picker.scrollIntoViewIfNeeded();
        await animationsDone(page);
        // Nothing may sit on top of it when it is sampled (a toast would make
        // the pixel read meaningless) — and it must be reachable anyway.
        await expect.poll(() => page.evaluate(() => window.__pvHit(document.getElementById('cp_brand_colorAccent'))), { timeout: 12_000 }).toBe('');
        const hex = await picker.inputValue();
        const box = await picker.boundingBox();
        expect(box.height, 'colour picker height').toBeGreaterThanOrEqual(36);
        const shot = decodePng(await picker.screenshot());
        const got = shot.at(Math.floor(shot.w / 2), Math.floor(shot.h / 2));
        const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        const off = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
        expect(off, `swatch centre should paint ${hex}, painted rgb(${got.join(',')})`).toBeLessThanOrEqual(16);
      });

      await test.step(`views#9 Pipelines: thumb-sized reorder controls and a Save that follows you @${width}`, async () => {
        await openSettingsTab(page, 'pipelines');
        const rows = page.locator('#pipelineBuilderRoot .pb-stage-row');
        await expect(rows.first()).toBeVisible({ timeout: 15_000 });
        // Save must never write the shared tenant config from a test: stub the
        // profile writer and record what Save hands it.
        await page.evaluate(() => {
          window.__pvSaves = [];
          window._saveCompanyProfile = async (patch) => { window.__pvSaves.push(patch); };
        });

        // Edit the LAST stage of the LAST pipeline — the far end of a ~6,600px
        // panel, where the header's Save is screens away.
        const rename = page.locator('#pipelineBuilderRoot input[data-pb-action="rename"]').last();
        await rename.scrollIntoViewIfNeeded();
        await rename.tap();
        await page.keyboard.type('X');
        const bar = await page.evaluate(() => {
          const vh = window.innerHeight;
          const inView = [...document.querySelectorAll('#pipelineBuilderRoot [data-pb-action="save"]')].filter((b) => {
            const r = b.getBoundingClientRect();
            return r.height > 0 && r.top >= 0 && r.bottom <= vh && !window.__pvHit(b);
          });
          return { n: inView.length, h: inView[0] ? inView[0].getBoundingClientRect().height : 0 };
        });
        expect(bar.n, `a tappable Save is on screen right after editing the last stage @${width}`).toBe(1);
        expect(bar.h).toBeGreaterThanOrEqual(36);
        const visibleSave = page.locator('#pipelineBuilderRoot .pb-savebar [data-pb-action="save"]');
        await visibleSave.tap();
        await expect.poll(() => page.evaluate(() => window.__pvSaves.length)).toBe(1);
        expect(await page.evaluate(() => !!(window.__pvSaves[0] && window.__pvSaves[0].pipelines))).toBe(true);
        await expect(visibleSave).toBeHidden();

        // Touch-sized ▲ / ▼ / 👁 / ✕, and ▼ really reorders.
        const first = rows.first();
        await first.scrollIntoViewIfNeeded();
        const sizes = await first.evaluate((row) => [...row.querySelectorAll('button.pb-mini')].map((b) => {
          const r = b.getBoundingClientRect();
          return { a: b.dataset.pbAction, w: r.width, h: r.height, hit: window.__pvHit(b) };
        }));
        for (const s of sizes) {
          expect(s.w, `${s.a} width`).toBeGreaterThanOrEqual(36);
          expect(s.h, `${s.a} height`).toBeGreaterThanOrEqual(36);
          expect(s.hit, `${s.a} reachable`).toBe('');
        }
        const view = await first.getAttribute('data-view');
        const order = () => page.evaluate((v) => [...document.querySelectorAll(`#pipelineBuilderRoot .pb-stage-row[data-view="${v}"]`)].map((r) => r.dataset.stage), view);
        const before = await order();
        await first.locator('button.pb-mini[data-pb-action="down"]').tap();
        const after = await order();
        expect(after.slice(0, 2), '▼ on the first stage swaps it with the second').toEqual([before[1], before[0]]);
      });

      // Follow-up (views#9 review): the bar said "Unsaved changes", but leaving
      // the tab or the view threw the edit away without a word — openBuilder()
      // re-clones the saved config on every open. The ▼ above left an unsaved
      // reorder; leaving must ask, Cancel must keep it, OK must discard it.
      // It walks every width and ends on a clean editor (OK discarded the ▼,
      // then a tab switch asks nothing), so the next width starts from
      // Profile with nothing pending — left out of the loop, the 360 pass's
      // first tab tap would raise this prompt and stay on Pipelines.
      await test.step(`views#9 leaving Pipelines with unsaved edits asks first @${width}`, async () => {
        const view = await page.locator('#pipelineBuilderRoot .pb-stage-row').first().getAttribute('data-view');
        const order = () => page.evaluate((v) => [...document.querySelectorAll(`#pipelineBuilderRoot .pb-stage-row[data-view="${v}"]`)].map((r) => r.dataset.stage), view);
        const saveBar = page.locator('#pipelineBuilderRoot .pb-savebar [data-pb-action="save"]');
        const edited = await order();
        await expect(saveBar, 'the ▼ left unsaved edits').toBeVisible();
        const asked = [];
        let accept = false;
        const onDialog = (d) => { asked.push(d.message()); (accept ? d.accept() : d.dismiss()).catch(() => {}); };
        page.on('dialog', onDialog);
        const tapTab = async (tab) => {
          const b = page.locator(`#stab-${tab}`);
          await b.scrollIntoViewIfNeeded();
          await b.tap();
        };
        const litTabs = () => page.evaluate(() => [...document.querySelectorAll('#mobile-nav .mn-item.active')].map((e) => e.id).sort());
        // All that may be lit while the rep is in Settings: a Settings tab, if
        // the rep has put one in the bar.
        const settingsTabs = () => page.evaluate(() => (document.getElementById('mni-settings') ? ['mni-settings'] : []));
        try {
          // Another Settings tab → Cancel: still on Pipelines, edit intact.
          await tapTab('profile');
          await expect.poll(() => asked.length, { message: 'switching tabs asks' }).toBe(1);
          expect(asked[0]).toMatch(/unsaved pipeline changes/i);
          await expect(page.locator('#stab-panel-pipelines')).toBeVisible();
          await expect(page.locator('#stab-panel-profile')).toBeHidden();
          expect(await order(), 'Cancel keeps the reorder').toEqual(edited);

          // The bottom nav → Cancel: still in Settings, edit intact.
          await page.locator('#mni-dash').tap();
          await expect.poll(() => asked.length, { message: 'leaving the view asks' }).toBe(2);
          expect(await page.evaluate(() => (document.querySelector('.view.active') || {}).id)).toBe('view-settings');
          expect(await order(), 'Cancel keeps the reorder').toEqual(edited);
          await expect(saveBar).toBeVisible();
          // ...and the bar does not claim the rep went Home (2026-09-25 phone
          // nav polish: mobileNav lit the tapped tab whether or not goTo
          // left). Settings has no tab in the default bar, so nothing is lit.
          await page.waitForTimeout(300);
          expect(await litTabs(), `after Cancel, the bottom nav lights no tab the rep did not go to @${width}`).toEqual(await settingsTabs());

          // The installed app. There the leave prompt is nbdConfirm, a DOM
          // modal that answers later (standalone-compat.js), not the blocking
          // confirm() above; it is stood in for here by a promise the test
          // settles, so the bar can be read while the prompt is still up.
          await page.evaluate(() => {
            window.__pvNbdConfirm = Object.getOwnPropertyDescriptor(window, 'nbdConfirm') || null;
            window.__pvLeave = [];
            window.nbdConfirm = (msg) => new Promise((resolve) => { window.__pvLeave.push({ msg, resolve }); });
          });
          try {
            // A bottom-nav tap: Home is not lit while the rep is still in
            // Settings being asked, nor after Cancel.
            await page.locator('#mni-dash').tap();
            await expect.poll(() => page.evaluate(() => window.__pvLeave.length), { message: 'the tap asks through nbdConfirm' }).toBe(1);
            expect(await litTabs(), `while the leave prompt is up, the bottom nav does not light Home @${width}`).toEqual(await settingsTabs());
            await page.evaluate(() => window.__pvLeave[0].resolve(false));
            await page.waitForTimeout(300);
            expect(await page.evaluate(() => (document.querySelector('.view.active') || {}).id), 'Cancel stays in Settings').toBe('view-settings');
            expect(await litTabs(), `after Cancel in the installed app, the bottom nav does not light Home @${width}`).toEqual(await settingsTabs());

            // A cancelled Back. Back moves the hash first, so the bar lights
            // the Back target while the modal is up; Cancel puts the hash back
            // without a hashchange, and the bar must follow it back.
            await page.evaluate(() => {
              // The rep came to Settings from the pipeline: that is where Back goes.
              history.pushState(null, '', '#/crm');
              history.pushState(null, '', '#/settings');
            });
            await page.evaluate(() => history.back());
            await expect.poll(() => page.evaluate(() => window.__pvLeave.length), { message: 'Back asks through nbdConfirm' }).toBe(2);
            expect(await page.evaluate(() => window.__pvLeave[1].msg)).toMatch(/unsaved pipeline changes/i);
            await page.evaluate(() => window.__pvLeave[1].resolve(false));
            await expect.poll(() => page.evaluate(() => location.hash), { message: 'Cancel puts the Settings hash back' }).toBe('#/settings');
            expect(await page.evaluate(() => (document.querySelector('.view.active') || {}).id), 'Cancel stays in Settings').toBe('view-settings');
            await page.waitForTimeout(300);
            expect(await litTabs(), `after a cancelled Back, the bottom nav does not light the Back target (CRM) @${width}`).toEqual(await settingsTabs());
            expect(await order(), 'a cancelled Back keeps the reorder').toEqual(edited);
          } finally {
            await page.evaluate(() => {
              if (window.__pvNbdConfirm) Object.defineProperty(window, 'nbdConfirm', window.__pvNbdConfirm);
              else delete window.nbdConfirm;
            });
          }
          expect(asked.length, 'the installed-app prompt stood in for confirm()').toBe(2);

          // Tapping Pipelines again while it is open keeps the working copy.
          await tapTab('pipelines');
          await page.waitForTimeout(400);
          expect(asked.length, 're-selecting Pipelines does not ask').toBe(2);
          expect(await order(), 're-selecting Pipelines keeps the reorder').toEqual(edited);

          // OK discards: Profile opens, and Pipelines comes back as saved.
          accept = true;
          await tapTab('profile');
          await expect.poll(() => asked.length).toBe(3);
          await expect(page.locator('#stab-panel-profile')).toBeVisible();
          await openSettingsTab(page, 'pipelines');
          await expect.poll(async () => (await order()).slice(0, 2), { message: 'the discarded ▼ is undone' }).toEqual([edited[1], edited[0]]);
          await expect(saveBar).toBeHidden();

          // Nothing unsaved: leaving asks nothing.
          await tapTab('profile');
          await expect(page.locator('#stab-panel-profile')).toBeVisible();
          expect(asked.length, 'a clean editor never asks').toBe(3);
        } finally {
          page.off('dialog', onDialog);
        }
      });
    }
  });
});

// ── Lazy view templates run each of their scripts once ─────────────────────
//
// 2026-09-25 phone nav polish. _hydrateViewTemplate (dashboard-ui.js) appended
// a view's cloned <template>, then swapped every cloned <script> for a fresh
// one on the premise that a clone is inert. It is not, so every template
// script ran TWICE: each Settings shard wrapped switchSettingsTab twice,
// opening Billing fired loadSubscription twice, opening Team loaded the plan
// and roster twice, and pipeline-builder.js needed a guard of its own (#1767).
// Each script's response gets a one-line run counter prepended (the file is
// otherwise served as is), so a run is counted however the page inserts it.
// Checked at phone width and at 1280 (the desktop header's Settings button).

// The template scripts, read from the page source so the list can't drift.
function templateScripts() {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'pro', 'dashboard.html'), 'utf8');
  const out = {};
  for (const m of html.matchAll(/<template id="(tpl-view-[\w-]+)">([\s\S]*?)<\/template>/g)) {
    const names = [...m[2].matchAll(/<script\b[^>]*\bsrc="js\/([\w.-]+)\.js/g)].map((s) => s[1]);
    if (names.length) out[m[1]] = names;
  }
  return out;
}

// holdBack delays one script's response by that many ms. 2026-09-25 review
// fixup: served locally the template scripts tend to finish loading in page
// order anyway, so "in page order" passed by luck with the ordering fix
// removed (red at 412, green at 1280 in the same run). Holding the FIRST
// Settings script back makes every later one land before it, so only a page
// that really runs them in document order (async = false) can pass.
async function countScriptRuns(page, names, holdBack) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page.route(new RegExp('/pro/js/(' + names.map(esc).join('|') + ')\\.js(\\?|$)'), async (route) => {
    const name = route.request().url().match(/\/pro\/js\/([\w.-]+)\.js/)[1];
    const resp = await route.fetch();
    const body = await resp.text();
    if (holdBack && holdBack[name]) await new Promise((r) => setTimeout(r, holdBack[name]));
    await route.fulfill({ response: resp, body: '(window.__pvRuns = window.__pvRuns || []).push(' + JSON.stringify(name) + ');\n' + body });
  });
}

// What each Settings tab renders once its script has run. A tab missing here
// is only checked for opening.
const SETTINGS_RENDERS = {
  pipelines: '#pipelineBuilderRoot .pb-stage-row',
  'ai-texting': '#aiPersonaMount > *',
  appearance: '#sidebarCustomizerGrid > *',
  help: '#hotkeyTogglesGrid > *',
  billing: '#billingPlanCards > *',
};

const templateSuite = (label, use, touch) => test.describe(`phone views: lazy view templates run each script once (${label}) @audit`, () => {
  test.use(use);

  test('every template script runs once, in page order, and every Settings tab still works', async ({ page }) => {
    test.setTimeout(180_000);
    const TPL = templateScripts();
    const settingsNames = TPL['tpl-view-settings'] || [];
    expect(settingsNames.length, 'the Settings template carries its scripts').toBeGreaterThanOrEqual(5);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e).slice(0, 200)));
    await countScriptRuns(page, [].concat(...Object.values(TPL)), { [settingsNames[0]]: 1500 });
    await boot(page);
    await installProbes(page);
    const runs = (names) => page.evaluate((n) => (window.__pvRuns || []).filter((x) => n.includes(x)), names);
    const press = (loc) => (touch ? loc.tap() : loc.click());

    // Settings, opened the way a rep opens it.
    if (touch) await openMore(page, 'settings');
    else await press(page.locator('.hdr-tool[data-target="settings"]'));
    await expect(page.locator('#stab-panel-profile')).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => { const r = await runs(settingsNames); return settingsNames.every((n) => r.includes(n)); },
      { message: 'every Settings template script ran', timeout: 20_000 }).toBe(true);
    await page.waitForTimeout(1500); // room for a second run to land
    expect(await runs(settingsNames), `each Settings template script ran exactly once, in page order (${label})`).toEqual(settingsNames);

    // Count plan loads per tab open. Billing's and Team's hooks both load
    // the plan, and each hook ran once per copy of its script.
    await page.evaluate(() => {
      const B = window.NBDBilling;
      window.__pvSubs = 0;
      if (B && typeof B.loadSubscription === 'function' && !B.__pvWrapped) {
        const orig = B.loadSubscription;
        B.loadSubscription = function () { window.__pvSubs++; return orig.apply(this, arguments); };
        B.__pvWrapped = true;
      }
    });
    expect(await page.evaluate(() => !!(window.NBDBilling && window.NBDBilling.__pvWrapped)), 'precondition: the plan loader is counted').toBe(true);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#stab-bar .stab-btn')]
      .filter((b) => b.getClientRects().length && getComputedStyle(b).display !== 'none').map((b) => b.dataset.target));
    expect(tabs.length, 'Settings tabs to walk').toBeGreaterThanOrEqual(10);
    for (const tab of tabs) {
      await page.evaluate(() => { window.__pvSubs = 0; });
      const btn = page.locator(`#stab-${tab}`);
      await btn.scrollIntoViewIfNeeded();
      await press(btn);
      await expect(page.locator(`#stab-panel-${tab}`), `Settings → ${tab} opens (${label})`).toBeVisible();
      if (SETTINGS_RENDERS[tab]) {
        await expect.poll(() => page.evaluate((s) => document.querySelectorAll(s).length, SETTINGS_RENDERS[tab]),
          { message: `Settings → ${tab} renders ${SETTINGS_RENDERS[tab]} (${label})`, timeout: 15_000 }).toBeGreaterThan(0);
      }
      if (tab === 'billing' || tab === 'team') {
        await expect.poll(() => page.evaluate(() => window.__pvSubs), { message: `Settings → ${tab} loads the plan` }).toBeGreaterThanOrEqual(1);
        await page.waitForTimeout(800);
        expect(await page.evaluate(() => window.__pvSubs), `opening Settings → ${tab} loads the plan once (${label})`).toBe(1);
      }
      if (tab === 'team') {
        await expect.poll(() => page.evaluate(() => (document.getElementById('teamOwnerName') || {}).textContent || ''),
          { message: 'Team renders its owner card', timeout: 15_000 }).not.toMatch(/^\s*(Loading|\.\.\.)/i);
      }
    }

    // The other templated views that carry scripts.
    for (const [tpl, names] of Object.entries(TPL)) {
      if (tpl === 'tpl-view-settings') continue;
      const view = tpl.replace(/^tpl-view-/, '');
      await page.evaluate((v) => window.goTo(v), view);
      await expect.poll(async () => { const r = await runs(names); return names.every((n) => r.includes(n)); },
        { message: `${view}: its template scripts ran`, timeout: 20_000 }).toBe(true);
      await page.waitForTimeout(1000);
      expect(await runs(names), `${view}: each template script ran exactly once (${label})`).toEqual(names);
    }
    expect(errors, `page errors (${label})`).toEqual([]);
  });
});
templateSuite('phone 412', {}, true);
templateSuite('desktop 1280', { viewport: { width: 1280, height: 860 }, isMobile: false, hasTouch: false, userAgent: devices['Desktop Chrome'].userAgent }, false);

// ── Settings → Estimates → Upgrade prices ──────────────────────────────────
//
// Upgrades & Add-ons stage 2 (2026-09-25). No research-guess price may reach
// a homeowner, so six gutter upgrades ship with NO price and stay off every
// quote until the company saves one here. This drives the real panel with
// real taps — at 412 and 360, and with the installed app's
// @media(display-mode: standalone) cascade forced on (Jo prices from the
// iPhone home-screen app; a browser tab never matches that query) — then
// proves the save is REAL: the Firestore doc holds whole cents, NBDUpgrades
// quotes it with no argument passed, and a reload paints it back.

// The installed-app cascade, copied to the top level (same technique as
// phone-dashnav.spec.js 'draw (installed app)').
async function forceStandalone(page) {
  return safeEvaluate(page, () => {
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) {
          for (const inner of r.cssRules) css += inner.cssText + '\n';
        }
      }
    }
    const s = document.createElement('style');
    s.id = 'e2e-force-standalone';
    s.textContent = css;
    document.head.appendChild(s);
    return css.length;
  });
}
async function unforceStandalone(page) {
  await safeEvaluate(page, () => { const s = document.getElementById('e2e-force-standalone'); if (s) s.remove(); });
}

// companyProfile/{key}.pricing.upgradePrices as the SERVER holds it — read
// with getDoc, not window._companyProfile, which _saveCompanyProfile updates
// before its write has landed.
async function serverUpgradePrices(page) {
  return safeEvaluate(page, async () => {
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const key = await window._resolveCompanyKey();
    const snap = await fs.getDoc(fs.doc(window.db, 'companyProfile', String(key)));
    const d = snap.exists() ? snap.data() : {};
    return { key: String(key), map: (d.pricing && d.pricing.upgradePrices) || null };
  });
}

test.describe('phone views: Settings upgrade prices @audit', () => {
  test('price a needs_price item, switch one Off, Save, reload: persisted and quoted', async ({ page }) => {
    test.setTimeout(180_000);
    const ROWS = '#upgPriceRows';
    const FASCIA = '[data-upg-id="fascia_wrap"]';
    const FLIP = '[data-upg-id="flip_up_extension"]';
    const APRON = '[data-upg-id="gutter_apron"]';

    const openPanel = async () => {
      await openMore(page, 'settings');
      await openSettingsTab(page, 'estimates');
      await expect(page.locator(ROWS)).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
      await expect(page.locator(ROWS)).toHaveAttribute('data-editable', '1');
    };

    await boot(page);
    await installProbes(page);
    await openPanel();

    // This test writes the seeded tenant's companyProfile — a real save and
    // reload is the point. Snapshot the one field it touches and put it back
    // whatever happens: later specs in the shard read the same doc.
    const original = await serverUpgradePrices(page);
    try {
      const libCount = await page.evaluate(() => window.NBD_UPGRADE_LIBRARY.items.length);

      const layout = async (label) => {
        const m = await safeEvaluate(page, () => {
          const panel = document.getElementById('upgPricePanel').getBoundingClientRect();
          const out = { overflow: document.documentElement.scrollWidth - window.innerWidth, rows: [] };
          document.querySelectorAll('#upgPriceRows [data-upg-id]').forEach((row) => {
            const r = row.getBoundingClientRect();
            const ctl = [row.querySelector('[data-upg-price]'), row.querySelector('[data-upg-enabled]')];
            out.rows.push({
              id: row.dataset.upgId,
              inside: r.left >= panel.left - 0.5 && r.right <= panel.right + 0.5,
              hits: ctl.map((el) => { el.scrollIntoView({ block: 'center' }); return window.__pvHit(el); }),
              heights: ctl.map((el) => Math.round(el.closest('label').getBoundingClientRect().height)),
            });
          });
          const save = document.getElementById('upgPriceSave');
          save.scrollIntoView({ block: 'center' });
          out.save = window.__pvHit(save);
          out.saveH = Math.round(save.getBoundingClientRect().height);
          return out;
        });
        expect(m.overflow, `${label}: the page does not scroll sideways`).toBeLessThanOrEqual(0);
        expect(m.rows.length, `${label}: one row per library upgrade`).toBe(libCount);
        for (const r of m.rows) {
          expect(r.inside, `${label}: ${r.id} row stays inside the panel`).toBe(true);
          expect(r.hits, `${label}: ${r.id} price field and On/Off switch are reachable`).toEqual(['', '']);
          for (const h of r.heights) expect(h, `${label}: ${r.id} control is thumb-sized`).toBeGreaterThanOrEqual(44);
        }
        expect(m.save, `${label}: Save upgrade prices reachable`).toBe('');
        expect(m.saveH, `${label}: Save height`).toBeGreaterThanOrEqual(44);
      };

      for (const width of [412, 360]) {
        await page.setViewportSize({ width, height: 860 });
        await test.step(`upgrade rows fit and every control is reachable @${width}`, () => layout('@' + width));
      }
      await page.setViewportSize({ width: 412, height: 860 });
      expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);

      await test.step('installed app: rows fit and a bad price saves nothing', async () => {
        await layout('installed app @412');
        const apron = page.locator(APRON + ' [data-upg-price]');
        await apron.tap();
        await page.keyboard.type('6,50');
        await expect(page.locator(APRON + ' [data-upg-error]')).toHaveText(/dot for cents/);
        await page.locator('#upgPriceSave').tap();
        await expect(page.locator('#upgPriceMsg')).toHaveText(/Nothing was saved/);
        expect((await serverUpgradePrices(page)).map, 'the refused save wrote nothing').toEqual(original.map);
        await apron.fill('');
        await expect(page.locator(APRON + ' [data-upg-badge]')).toBeVisible();
      });

      // ANOTHER device (Jo's desktop, say) saves Alu-Rex at $19.00 after this
      // one painted the panel. Nothing refreshes this device's profile, so
      // its row still shows the $18 default: a save from here must not put
      // that back (2026-09-25 review of PR #1762 — the whole map used to ride
      // every save).
      const OTHER_DEVICE = { cents: 1900, enabled: true, installerName: 'Other Device Gutters' };
      const alurexPainted = await page.locator('[data-upg-id="alurex"] [data-upg-price]').inputValue();
      expect(alurexPainted, 'the seeded tenant has not priced Alu-Rex (the other device\'s save must be news here)').not.toBe('19.00');
      await safeEvaluate(page, async ({ key, entry }) => {
        const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        await fs.setDoc(fs.doc(window.db, 'companyProfile', key), { pricing: { upgradePrices: { alurex: entry } } }, { merge: true });
      }, { key: original.key, entry: OTHER_DEVICE });
      await expect(page.locator('[data-upg-id="alurex"] [data-upg-price]'), 'this device still shows its stale paint').toHaveValue(alurexPainted);

      await test.step('installed app: price the fascia wrap, switch flip-ups Off, Save', async () => {
        const fascia = page.locator(FASCIA + ' [data-upg-price]');
        await expect(fascia, 'fascia wrap starts unpriced').toHaveValue('');
        await expect(page.locator(FASCIA + ' [data-upg-badge]')).toHaveText('Set a price');
        await fascia.tap();
        await page.keyboard.type('9.75');
        await expect(page.locator(FASCIA + ' [data-upg-status]')).toHaveText('Offered at $9.75 per foot (your price).');
        await expect(page.locator(FASCIA + ' [data-upg-badge]')).toBeHidden();

        const flip = page.locator(FLIP + ' [data-upg-enabled]');
        await expect(flip, 'flip-up extension starts On').toBeChecked();
        await flip.tap();
        await expect(flip).not.toBeChecked();
        await expect(page.locator(FLIP + ' [data-upg-onoff]')).toHaveText('Off');
        await expect(page.locator(FLIP + ' [data-upg-status]')).toHaveText('Off. Reps never see it.');

        await page.locator('#upgPriceSave').tap();
        await expect(page.locator('#upgPriceMsg')).toHaveText('✓ Upgrade prices saved for your whole company.', { timeout: 20_000 });
        // Pressing Save again sends nothing: those two rows are now what this
        // device shows as saved.
        const afterSave = (await serverUpgradePrices(page)).map;
        await page.locator('#upgPriceSave').tap();
        await expect(page.locator('#upgPriceMsg')).toHaveText('No changes to save.');
        expect((await serverUpgradePrices(page)).map, 'the second press wrote nothing').toEqual(afterSave);
      });

      await test.step('Firestore holds whole cents, only the two edits were written, and NBDUpgrades quotes it with no argument', async () => {
        const saved = (await serverUpgradePrices(page)).map;
        expect(saved.fascia_wrap).toEqual({ cents: 975, enabled: true });
        expect(saved.flip_up_extension).toEqual({ cents: null, enabled: false });
        expect(saved.alurex, 'the other device\'s Alu-Rex price survived this device\'s save').toEqual(OTHER_DEVICE);
        const before = original.map || {};
        for (const id of Object.keys(saved)) {
          if (id === 'fascia_wrap' || id === 'flip_up_extension' || id === 'alurex') continue;
          expect(saved[id], `${id} was not edited here, so the save left it alone`).toEqual(before[id]);
        }
        const seen = await safeEvaluate(page, () => {
          const m = {};
          // A gutter repair family offers both items; no tenantOverrides
          // argument — the builder card reads the saved Settings this way.
          window.NBDUpgrades.offeredFor('jt_gr_reseal', { lines: [] }).forEach((o) => { m[o.id] = o; });
          const q = window.NBDUpgrades.price([{ id: 'fascia_wrap', qty: 40 }], { templateIds: ['jt_gr_reseal'], lines: [], taxRate: 0 });
          return {
            fascia: [m.fascia_wrap.state, m.fascia_wrap.unitCents, m.fascia_wrap.priceSource],
            flip: m.flip_up_extension.state,
            quote: [q.errors.length, q.upgradeCents, q.rows[0] && q.rows[0].total],
          };
        });
        expect(seen.fascia).toEqual(['available', 975, 'tenant']);
        expect(seen.flip).toBe('hidden');
        expect(seen.quote, '40 ft × $9.75 = $390.00 exactly').toEqual([0, 39000, 390]);
      });

      await test.step('installed app: Save All carries only what changed on this device', async () => {
        // Capture the company write instead of making it, and park window._db
        // so Save All's userSettings / county writes are skipped: this step
        // proves WHAT Save All would write, without touching the shared
        // tenant beyond the one field the finally restores.
        await safeEvaluate(page, () => {
          window.__e2eUpg = { save: window._saveCompanyProfile, db: window._db, writes: [] };
          window._saveCompanyProfile = async (o) => { window.__e2eUpg.writes.push(JSON.parse(JSON.stringify(o))); return window._companyProfile; };
          window._db = null;
        });
        try {
          const saveAll = page.locator('button[data-fn="_saveEstimateDefaultsV2"]');
          const pressSaveAll = async (n) => {
            // Save All is the last thing on the page, and the previous press's
            // "saved" toast sits over it until it clears itself (~2.6s) — a
            // person waits for that too.
            await expect.poll(() => safeEvaluate(page, () => {
              const b = document.querySelector('button[data-fn="_saveEstimateDefaultsV2"]');
              b.scrollIntoView({ block: 'center' });
              return window.__pvHit(b);
            }), { message: 'Save All reachable', timeout: 10_000 }).toBe('');
            await saveAll.tap();
            await expect.poll(() => page.evaluate(() => window.__e2eUpg.writes.length), { timeout: 15_000 }).toBe(n);
            return page.evaluate((i) => window.__e2eUpg.writes[i].pricing, n - 1);
          };
          // The panel is untouched since its own Save landed.
          const first = await pressSaveAll(1);
          expect(first.addonPrices, 'Save All still writes the rest of company pricing').toBeTruthy();
          expect(first.upgradePrices, 'an untouched upgrade panel adds nothing to Save All').toBeUndefined();
          // One row edited here → exactly that row rides Save All.
          const apron = page.locator(APRON + ' [data-upg-price]');
          await apron.tap();
          await page.keyboard.type('4.50');
          const second = await pressSaveAll(2);
          expect(second.upgradePrices, 'only the row edited here').toEqual({ gutter_apron: { cents: 450, enabled: true } });
          // …and once that write landed, pressing again does not resend it.
          const third = await pressSaveAll(3);
          expect(third.upgradePrices, 'no resend after the save').toBeUndefined();
        } finally {
          await safeEvaluate(page, () => {
            window._saveCompanyProfile = window.__e2eUpg.save;
            window._db = window.__e2eUpg.db;
          });
        }
      });
      await unforceStandalone(page);

      await test.step('reload: the panel paints the saved price and the Off switch back', async () => {
        await page.reload();
        await page.waitForURL(/\/pro\/dashboard/);
        await safeWaitForFunction(page, () => typeof window.goTo === 'function', { timeout: 30_000 });
        await skipTour(page);
        await installProbes(page);
        await openPanel();
        await expect(page.locator(FASCIA + ' [data-upg-price]')).toHaveValue('9.75');
        await expect(page.locator(FASCIA + ' [data-upg-status]')).toHaveText('Offered at $9.75 per foot (your price).');
        await expect(page.locator(FLIP + ' [data-upg-enabled]')).not.toBeChecked();
        await expect(page.locator(FLIP + ' [data-upg-status]')).toHaveText('Off. Reps never see it.');
        // The other device's save, which this device never showed, is intact.
        await expect(page.locator('[data-upg-id="alurex"] [data-upg-price]')).toHaveValue('19.00');
        await expect(page.locator('[data-upg-id="alurex"] [data-upg-installer]')).toHaveValue(OTHER_DEVICE.installerName);
      });

      await test.step('a tab painted before the upgrade files arrive shows a loading line, then the rows', async () => {
        // The race the review found: ui.js paints this tab as soon as
        // EstimateBuilderV2 exists, but the upgrade files are the LAST entries
        // of that bundle. Put the panel back in its first state, hold the
        // bundle, paint the tab, then let the bundle land — and once more with
        // a bundle that never delivers the module.
        const r = await safeEvaluate(page, async () => {
          const reg = window.__NBD_CALL_REGISTRY;
          const host = document.getElementById('upgPriceRows');
          const mod = window.NBDUpgradePriceSettings;
          const realLoad = window.ScriptLoader.loadBundle;
          const tick = () => new Promise((res) => setTimeout(res, 100));
          const firstState = () => {
            host.textContent = '';
            const p = document.createElement('p');
            p.className = 'upg-loading';
            p.textContent = 'Loading your saved upgrade prices…';
            host.appendChild(p);
            host.setAttribute('data-state', 'loading');
            host.removeAttribute('data-editable');
          };
          const snap = () => ({ state: host.getAttribute('data-state'), text: host.textContent.trim(), rows: host.querySelectorAll('[data-upg-id]').length });
          let release = null;
          window.ScriptLoader.loadBundle = (name) => new Promise((res) => { release = () => res(name); });
          try {
            firstState();
            delete window.NBDUpgradePriceSettings;
            reg._loadEstimateDefaultsV2();
            await tick();
            const arriving = snap();
            const waitedFor = typeof release === 'function';
            window.NBDUpgradePriceSettings = mod;
            if (release) release();
            await tick();
            const landed = snap();

            firstState();
            release = null;
            delete window.NBDUpgradePriceSettings;
            reg._loadEstimateDefaultsV2();
            if (release) release();
            await tick();
            const neverCame = Object.assign(snap(), { saveDisabled: document.getElementById('upgPriceSave').disabled });
            return { arriving, waitedFor, landed, neverCame };
          } finally {
            window.ScriptLoader.loadBundle = realLoad;
            window.NBDUpgradePriceSettings = mod;
            firstState();
            reg._loadEstimateDefaultsV2();
          }
        });
        expect(r.waitedFor, 'the paint waited for the estimates bundle').toBe(true);
        expect(r.arriving, 'while the bundle is arriving: a loading line, never an empty box').toEqual({ state: 'loading', text: 'Loading your saved upgrade prices…', rows: 0 });
        expect(r.landed.state, 'the rows paint once the bundle lands, with no second tab open').toBe('ready');
        expect(r.landed.rows).toBe(libCount);
        expect(r.neverCame, 'a bundle that never delivers the module says so, and Save is off').toEqual({ state: 'unavailable', text: 'Upgrade prices could not load. Reload the page to try again.', rows: 0, saveDisabled: true });
        await expect(page.locator(ROWS), 'the panel is back to normal').toHaveAttribute('data-state', 'ready');
      });

      await test.step('a company-profile read that gave up at boot is retried by the panel', async () => {
        // Desktop 1280 on this rig: the boot read gave up ("client is
        // offline") and nothing retried it, so the panel sat on "Loading…"
        // and then "did not load". The panel now asks for the read itself.
        const r = await safeEvaluate(page, async () => {
          const host = document.getElementById('upgPriceRows');
          const real = window._loadCompanyProfile;
          let calls = 0;
          window._loadCompanyProfile = function () { calls++; return real.apply(this, arguments); };
          window._companyProfileLoaded = false; // the boot read gave up
          try {
            window.NBDUpgradePriceSettings.render();
            const during = host.getAttribute('data-state');
            for (let i = 0; i < 40 && host.getAttribute('data-state') !== 'ready'; i++) await new Promise((res) => setTimeout(res, 250));
            return { during, calls, after: host.getAttribute('data-state'), loaded: window._companyProfileLoaded === true };
          } finally {
            window._loadCompanyProfile = real;
            window._companyProfileLoaded = true;
          }
        });
        expect(r.during, 'unhydrated: the loading line, Save off').toBe('loading');
        expect(r.calls, 'the panel asked for the profile read').toBe(1);
        expect(r.loaded, 'the read landed').toBe(true);
        expect(r.after, 'and the rows painted without reopening the tab').toBe('ready');
      });
    } finally {
      await unforceStandalone(page).catch(() => {});
      await safeEvaluate(page, async (o) => {
        const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        await fs.updateDoc(fs.doc(window.db, 'companyProfile', o.key), {
          'pricing.upgradePrices': o.map == null ? fs.deleteField() : o.map,
        });
      }, original);
    }
  });
});

// ── A company-profile read that gives up at boot (2026-09-25, profretry) ────
//
// On a cold Firestore channel the ONE boot read of companyProfile threw
// "client is offline" three times inside ~2.4s and nothing asked again, so
// window._companyProfileLoaded stayed unset all session (reproduced on this
// rig at 1280: unset for 26s while a manual _loadCompanyProfile() landed in
// ~13ms). Settings > Estimates then said "Loading your saved jurisdictions…"
// until its poll quit, "+ Add Jurisdiction" took typing that could never be
// saved, and Save All left county rates and jurisdictions out of the company
// write under a green "✓ … saved".
//
// The cold channel is forced deterministically: while
// window.__e2eProfileOffline is true, every companyProfile read that goes
// through nbdRetryOffline throws the SDK's "client is offline" error (the
// same wrapper company-profile.js defines, installed before the page runs).
// Set to 'hang', the read never settles (a stuck getDoc, counted in
// __e2eProfileHung) — which parks the page's retry run for its 20s
// per-attempt cap. Set to false, reads reach the real SDK. The spec's own
// getDoc/updateDoc calls don't go through it, so it can read the server copy
// the whole time.

async function installProfileOfflineSwitch(page) {
  await page.addInitScript(() => {
    window.__e2eProfileOffline = true;
    window.__e2eProfileReads = 0;
    window.__e2eProfileHung = 0;
    const retry = async function (fn, tries, delay) {
      tries = tries || 3; delay = delay || 800;
      for (let i = 0; ; i++) {
        try {
          if (/companyProfile/.test(String(fn))) {
            window.__e2eProfileReads++;
            if (window.__e2eProfileOffline === 'hang') {
              window.__e2eProfileHung++;
              await new Promise(() => {});
            }
            if (window.__e2eProfileOffline) {
              throw Object.assign(new Error('Failed to get document because the client is offline.'), { code: 'unavailable' });
            }
          }
          return await fn();
        } catch (e) {
          const m = ((e && (e.code || e.message)) || '') + '';
          if (i >= tries - 1 || !/offline|unavailable|deadline|backend|network/i.test(m)) throw e;
          await new Promise((r) => setTimeout(r, delay * (i + 1)));
        }
      }
    };
    Object.defineProperty(window, 'nbdRetryOffline', { configurable: true, get() { return retry; }, set() { /* keep the switch */ } });
  });
}

// companyProfile/{key}.pricing as the SERVER holds it (never window._companyProfile).
async function serverPricing(page) {
  return safeEvaluate(page, async () => {
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const key = String(await window._resolveCompanyKey());
    const snap = await fs.getDoc(fs.doc(window.db, 'companyProfile', key));
    const p = (snap.exists() && snap.data().pricing) || {};
    const pick = (k) => (p[k] === undefined ? null : p[k]);
    return {
      key,
      customJurisdictions: pick('customJurisdictions'), permits: pick('permits'), countyTax: pick('countyTax'),
      fallbackTaxRate: pick('fallbackTaxRate'), addonPrices: pick('addonPrices'),
    };
  });
}
async function restorePricing(page, original) {
  await safeEvaluate(page, async (o) => {
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const put = (v) => (v == null ? fs.deleteField() : v);
    await fs.updateDoc(fs.doc(window.db, 'companyProfile', o.key), {
      'pricing.customJurisdictions': put(o.customJurisdictions),
      'pricing.permits': put(o.permits),
      'pricing.countyTax': put(o.countyTax),
      'pricing.fallbackTaxRate': put(o.fallbackTaxRate),
      'pricing.addonPrices': put(o.addonPrices),
      // Written by the offline step's pending merge write.
      e2eProfretryProbe: fs.deleteField(),
    });
  }, original);
}

const E2E_JUR = { slug: 'custom-e2e-boot-retry-county', name: 'E2E Boot Retry County', cost: 175, rate: 0.0725 };

// The whole walk, shared by the phone and desktop tests. `act` is how a
// person presses things there: a tap on the phone, a click at 1280.
async function profileRetryWalk(page, { act, openEstimatesTab, widths }) {
  const JUR = '#jurRows';
  const SAVE_ALL = 'button[data-fn="_saveEstimateDefaultsV2"]';

  await test.step('the boot read gave up, and is asked again without anyone opening a tab', async () => {
    // Boot 3 tries + the retry run's first attempt (3 more). Before
    // 2026-09-25 this sat at 3 for good.
    await expect.poll(() => page.evaluate(() => window.__e2eProfileReads), {
      message: 'companyProfile read attempts', timeout: 20_000,
    }).toBeGreaterThanOrEqual(6);
    expect(await page.evaluate(() => window._companyProfileLoaded === true), 'no read landed, so not loaded').toBe(false);
  });

  // Put a jurisdiction on the server for this tenant (restored in the
  // caller's finally), so the landing has a row to paint.
  const original = await serverPricing(page);
  await safeEvaluate(page, async ({ key, map }) => {
    const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    await fs.updateDoc(fs.doc(window.db, 'companyProfile', key), { 'pricing.customJurisdictions': map });
  }, { key: original.key, map: Object.assign({}, original.customJurisdictions || {}, { [E2E_JUR.slug]: { name: E2E_JUR.name, cost: E2E_JUR.cost, rate: E2E_JUR.rate } }) });
  const seeded = await serverPricing(page);

  try {
    await openEstimatesTab();

    await test.step('Estimates tab, profile not loaded: a loading line, and + Add refuses rather than take typing', async () => {
      await expect(page.locator(JUR)).toHaveAttribute('data-jur-wait', 'loading');
      await expect(page.locator(JUR)).toHaveText('Loading your saved jurisdictions…');
      await expect(page.locator('#upgPriceRows')).toHaveAttribute('data-state', 'loading');
      const add = page.locator('button[data-fn="_addJurisdictionRow"]');
      await add.scrollIntoViewIfNeeded();
      await act(add);
      await expect(page.locator('#toastContainer .toast', { hasText: 'Your saved jurisdictions are still loading' })).toBeVisible();
      expect(await page.locator(JUR + ' [data-jur-row]').count(), 'no row taken next to the loading line').toBe(0);
    });

    await test.step('Save All while unloaded: a warning that stays, and NOTHING company-wide written', async () => {
      const save = page.locator(SAVE_ALL);
      await expect.poll(() => safeEvaluate(page, (sel) => {
        const b = document.querySelector(sel);
        b.scrollIntoView({ block: 'center' });
        return window.__pvHit(b);
      }, SAVE_ALL), { message: 'Save All reachable', timeout: 10_000 }).toBe('');
      await act(save);
      const msg = page.locator('#v2save-msg');
      await expect(msg).toBeVisible();
      await expect(msg).toHaveAttribute('data-kind', 'warn');
      await expect(msg).toContainText('NOT saved for your company');
      await expect(page.locator('#toastContainer .toast', { hasText: 'Company rates not saved' })).toBeVisible();
      // A clean save fades after 5s; the warning must still be up after that.
      await page.waitForTimeout(5_600);
      await expect(msg, 'the warning stays until the next save').toBeVisible();
      expect(await serverPricing(page), 'company pricing on the server is untouched').toEqual(seeded);
      expect(await page.evaluate(() => window._companyProfileLoaded === true), 'a refused save never marks the profile loaded').toBe(false);
      for (const w of widths) {
        await page.setViewportSize({ width: w.width, height: w.height });
        const m = await safeEvaluate(page, (sel) => {
          const el = document.getElementById('v2save-msg');
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          // Its last line, not just its box: the phone bottom bar sits over
          // the end of the page.
          const at = document.elementFromPoint(r.left + 12, r.bottom - 4);
          const b = document.querySelector(sel);
          b.scrollIntoView({ block: 'center' });
          return {
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            left: r.left, right: r.right, vw: window.innerWidth,
            msgSeen: !!at && (at === el || el.contains(at)),
            save: window.__pvHit(b),
          };
        }, SAVE_ALL);
        expect(m.overflow, `@${w.width}: no sideways scroll`).toBeLessThanOrEqual(0);
        expect(m.left >= 0 && m.right <= m.vw, `@${w.width}: the warning fits the screen`).toBe(true);
        expect(m.msgSeen, `@${w.width}: the warning's last line is not under the bottom bar`).toBe(true);
        expect(m.save, `@${w.width}: Save All reachable`).toBe('');
        // Kept with the run's output, for a person to look at.
        await page.locator('#v2save-msg').screenshot({ path: test.info().outputPath(`profile-warn-${w.width}.png`) });
      }
    });

    // PR #1774 review (blocking): offline, getDoc does not throw once the
    // SDK holds a local view of the doc — and a merge write issued before
    // hydration (Settings > Company Profile's Save, the AI persona's "team
    // default") puts a PARTIAL doc there. Taking that snapshot marked the
    // profile loaded with no customJurisdictions, and Save All wiped the
    // company's list under a "✓ saved". The switch fakes offline above the
    // SDK, so this step goes REALLY offline and lets the reads through.
    await test.step('really offline with a company write pending: the SDK\'s partial local copy never counts as loaded', async () => {
      await page.context().setOffline(true);
      await page.evaluate(() => {
        window.__e2eProfileOffline = false; // the real SDK from here
        window.__e2ePendingAcked = false;
        window._saveCompanyProfile({ e2eProfretryProbe: 1 }).then(() => { window.__e2ePendingAcked = true; }, () => {});
      });
      // Positive control: the SDK really does serve the device's partial copy
      // now — the one written field, from cache, write pending.
      const local = await safeEvaluate(page, async () => {
        const fs = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
        const snap = await fs.getDoc(fs.doc(window.db, 'companyProfile', String(await window._resolveCompanyKey())));
        return { fromCache: snap.metadata.fromCache, pending: snap.metadata.hasPendingWrites, keys: Object.keys(snap.data() || {}) };
      });
      expect(local, 'offline, the SDK hands out the partial doc (the hole under test)').toEqual({ fromCache: true, pending: true, keys: ['e2eProfretryProbe'] });
      // Ask for the read the way a rep does: reopen the tab.
      const before = await page.evaluate(() => window.__e2eProfileReads);
      await openEstimatesTab();
      await expect.poll(() => page.evaluate((b) => window._companyProfileLoaded === true || window.__e2eProfileReads >= b + 3, before), {
        message: 'a full read attempt against the offline SDK', timeout: 30_000,
      }).toBe(true);
      expect(await page.evaluate(() => window._companyProfileLoaded === true), 'a local-copy snapshot never marks the profile loaded').toBe(false);
      await expect(page.locator(JUR)).toHaveAttribute('data-jur-wait', /^(loading|failed)$/);
      // Save All with no signal (PR #1774 second review): it awaited the
      // per-user settings write, which settles only on the server's ack, so
      // the rep saw nothing at all — not even this warning — until the
      // connection came back. Cleared first: the last step's warning stays up.
      await page.evaluate(() => {
        const m = document.getElementById('v2save-msg');
        m.style.display = 'none';
        m.textContent = '';
        m.removeAttribute('data-kind');
      });
      await safeEvaluate(page, (sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), SAVE_ALL);
      await act(page.locator(SAVE_ALL));
      const offMsg = page.locator('#v2save-msg');
      await expect(offMsg, 'offline, the warning shows straight away').toBeVisible({ timeout: 3_000 });
      await expect(offMsg).toHaveAttribute('data-kind', 'warn', { timeout: 1_000 });
      await expect(offMsg).toContainText('NOT saved for your company', { timeout: 1_000 });
      // Back online with reads still refused, so the write is acked before
      // any read can land.
      await page.evaluate(() => { window.__e2eProfileOffline = true; });
      await page.context().setOffline(false);
      await expect.poll(() => page.evaluate(() => window.__e2ePendingAcked), { message: 'the pending write was acked', timeout: 30_000 }).toBe(true);
      expect(await page.evaluate(() => window._companyProfileLoaded === true), 'still not loaded: no server read has landed').toBe(false);
    });

    // PR #1774 review: the repaint used to come from the tab's own wait
    // settling, so nothing proved the landing EVENT repaints it — a landing
    // from any other reader (the document generator, maps and the pipeline
    // builder each make one on-demand read). Here the tab's retry run is
    // parked in a stuck read for 20s while another read lands, so only the
    // event can repaint the tab inside 5s. And that repaint must keep what
    // the rep typed into this device's own fields.
    await test.step('another panel\'s read lands while the retry is stuck: the event repaints the tab, keeping the rep\'s typing', async () => {
      // A per-device field (cost basis): package prices are company-wide
      // since 2026-10-04, so the cost basis is what stays the rep's own.
      const rate = page.locator('#v2costGood');
      const steep = page.locator('#v2addonSteep');
      const rateSaved = await rate.inputValue();
      await rate.fill('777'); // this device's cost basis, not yet saved
      await steep.fill('99'); // company-wide, and not saveable while unloaded
      const hung = await page.evaluate(() => window.__e2eProfileHung);
      await page.evaluate(() => {
        window.__e2eProfileOffline = 'hang';
        window.dispatchEvent(new Event('online')); // kicks the retry into its next read now
      });
      await expect.poll(() => page.evaluate(() => window.__e2eProfileHung), {
        message: 'the retry run is parked in a stuck read', timeout: 10_000,
      }).toBeGreaterThan(hung);
      await page.evaluate(() => {
        window.__e2eProfileOffline = false;
        window._loadCompanyProfile(); // another reader, outside the retry run
      });
      await expect.poll(() => page.evaluate(() => window._companyProfileLoaded === true), {
        message: 'the other reader\'s read landed', timeout: 10_000,
      }).toBe(true);
      await expect(page.locator(`${JUR} [data-jur-name][value="${E2E_JUR.name}"]`), 'the saved jurisdiction painted by the landing event, not the parked retry').toHaveCount(1, { timeout: 5_000 });
      await expect(page.locator(JUR)).not.toHaveAttribute('data-jur-wait', /.*/);
      await expect(page.locator('#upgPriceRows')).toHaveAttribute('data-state', 'ready');
      await expect(rate, 'the rep\'s unsaved cost basis survives the landing').toHaveValue('777');
      await expect(steep, 'the add-on rate now shows the company value').not.toHaveValue('99');
      const msg = page.locator('#v2save-msg');
      await expect(msg).toHaveAttribute('data-kind', 'warn');
      await expect(msg).toContainText('replaced a county, tax or add-on rate you had changed');
      await page.locator(JUR).screenshot({ path: test.info().outputPath('profile-landed.png') });
      await msg.screenshot({ path: test.info().outputPath('profile-landed-notice.png') });
      await rate.fill(rateSaved); // the next Save stores this device's own value
    });

    await test.step('now Save All publishes the jurisdiction edit company-wide', async () => {
      const row = page.locator(`${JUR} [data-jur-row]`).filter({ has: page.locator(`[data-jur-name][value="${E2E_JUR.name}"]`) });
      const cost = row.locator('[data-jur-cost]');
      await cost.scrollIntoViewIfNeeded();
      await cost.fill('180');
      await page.locator(SAVE_ALL).scrollIntoViewIfNeeded();
      await act(page.locator(SAVE_ALL));
      await expect(page.locator('#v2save-msg')).toHaveAttribute('data-kind', 'ok');
      await expect.poll(async () => {
        const p = await serverPricing(page);
        return p.customJurisdictions && p.customJurisdictions[E2E_JUR.slug] && p.customJurisdictions[E2E_JUR.slug].cost;
      }, { message: 'the edited cost on the server', timeout: 10_000 }).toBe(180);
    });

    // PR #1774 second review: every re-read reset the in-memory profile to
    // defaults + this tenant's cache before its getDoc. A re-read that then
    // failed left that copy under a flag still saying "loaded" — bare
    // defaults when the cache was gone and could not be written (storage
    // blocked, quota full) — and Save All full-replaced the company's
    // jurisdictions with nothing, under "✓ saved" (reproduced on the rig).
    await test.step('loaded, then a re-read fails with this tenant\'s cache gone and unwritable: the jurisdictions stay, and Save All keeps them', async () => {
      await page.evaluate(() => {
        Object.keys(localStorage).filter((k) => k.indexOf('nbd_company_profile_v1:') === 0).forEach((k) => localStorage.removeItem(k));
        window.__e2eRealSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name, v) {
          if (String(name).indexOf('nbd_company_profile_v1') === 0) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
          return window.__e2eRealSetItem.call(this, name, v);
        };
        window.__e2eProfileOffline = true; // the re-read fails
      });
      try {
        const r = await safeEvaluate(page, async () => {
          await window._loadCompanyProfile(); // Settings > Company Profile, a document generator…
          const cj = (window._companyProfile.pricing && window._companyProfile.pricing.customJurisdictions) || {};
          return { loaded: window._companyProfileLoaded === true, slugs: Object.keys(cj) };
        });
        expect(r.loaded, 'still loaded').toBe(true);
        expect(r.slugs, 'the server copy is still what is in memory').toContain(E2E_JUR.slug);
        await openEstimatesTab();
        await expect(page.locator(`${JUR} [data-jur-name][value="${E2E_JUR.name}"]`), 'the tab paints the company\'s jurisdiction').toHaveCount(1);
        // The last save left data-kind="ok": clear it so the check below
        // waits for THIS save.
        await page.evaluate(() => document.getElementById('v2save-msg').removeAttribute('data-kind'));
        await safeEvaluate(page, (sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), SAVE_ALL);
        await act(page.locator(SAVE_ALL));
        await expect(page.locator('#v2save-msg')).toHaveAttribute('data-kind', 'ok');
        await expect.poll(async () => {
          const p = await serverPricing(page);
          return p.customJurisdictions && p.customJurisdictions[E2E_JUR.slug] && p.customJurisdictions[E2E_JUR.slug].cost;
        }, { message: 'the company\'s jurisdiction is still on the server after Save All', timeout: 10_000 }).toBe(180);
      } finally {
        await page.evaluate(() => {
          if (window.__e2eRealSetItem) Storage.prototype.setItem = window.__e2eRealSetItem;
          window.__e2eProfileOffline = false;
        }).catch(() => {});
      }
    });
  } finally {
    // Back online first: a step that failed mid-offline would otherwise leave
    // the restore write queued forever, and the seeded jurisdiction on the
    // server for the next run (it did, in a break-test, 2026-09-25).
    await page.context().setOffline(false).catch(() => {});
    await restorePricing(page, original).catch(() => {});
  }
}

test.describe('phone views: a company-profile read that gave up at boot @audit', () => {
  test('is retried; the Estimates tab refuses unhydrated saves out loud, then repaints when it lands', async ({ page }) => {
    test.setTimeout(150_000);
    await installProfileOfflineSwitch(page);
    await boot(page);
    await installProbes(page);
    // Jo prices from the installed iPhone app: its display-mode:standalone
    // cascade is on for the whole walk.
    expect(await forceStandalone(page), 'found the standalone rules to force').toBeGreaterThan(200);
    try {
      await profileRetryWalk(page, {
        act: (loc) => loc.tap(),
        openEstimatesTab: async () => { await openMore(page, 'settings'); await openSettingsTab(page, 'estimates'); },
        widths: [{ width: 412, height: 860 }, { width: 360, height: 780 }],
      });
    } finally {
      await unforceStandalone(page).catch(() => {});
    }
  });
});

test.describe('desktop 1280: a company-profile read that gave up at boot @audit', () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, userAgent: devices['Desktop Chrome'].userAgent });
  test('is retried; the Estimates tab refuses unhydrated saves out loud, then repaints when it lands', async ({ page }) => {
    test.setTimeout(150_000);
    await installProfileOfflineSwitch(page);
    await boot(page);
    await installProbes(page);
    await profileRetryWalk(page, {
      act: (loc) => loc.click(),
      openEstimatesTab: async () => {
        await safeEvaluate(page, () => window.goTo('settings'));
        const btn = page.locator('#stab-estimates');
        await btn.scrollIntoViewIfNeeded();
        await btn.click();
        await expect(page.locator('#stab-panel-estimates')).toBeVisible();
        await animationsDone(page);
      },
      widths: [{ width: 1280, height: 900 }],
    });
  });
});

// ── Products + Sales Training ──────────────────────────────────────────────

// 2026-09-25 follow-up: this ran at 412 only. One describe per phone width
// now (called below the describe), each a fresh login: "starts collapsed"
// needs a Products view nobody has opened yet.
const productsSuite = (width) => test.describe(`phone views: Products and Sales Training at ${width}px @audit`, () => {
  test.use({ viewport: { width, height: 860 } });

  test('Products opens collapsed with thumb-sized card buttons; the drill opens', async ({ page }) => {
    test.setTimeout(90_000);
    await boot(page);
    await installProbes(page);

    await test.step('views#14 Products starts collapsed on a phone', async () => {
      await openMore(page, 'products');
      await expect(page.locator('#productLibraryContainer [data-pl-action="toggleCategory"]').first()).toBeVisible({ timeout: 15_000 });
      const m = await page.evaluate(() => ({
        openGrids: [...document.querySelectorAll('#productLibraryContainer .pl-product-grid')].filter((g) => g.offsetParent !== null).length,
        docH: document.documentElement.scrollHeight,
      }));
      expect(m.openGrids, 'no category grid open on arrival').toBe(0);
      expect(m.docH, 'the library is a list of categories, not ~88,000px of cards').toBeLessThan(12_000);
    });

    await test.step('views#14 a tapped category shows 36px+ Edit / Archive, and Edit opens the editor', async () => {
      const header = page.locator('#productLibraryContainer [data-pl-action="toggleCategory"]').first();
      await header.scrollIntoViewIfNeeded();
      await header.tap();
      const edit = page.locator('#productLibraryContainer [data-pl-action="editProduct"]').first();
      await expect(edit).toBeVisible();
      await edit.scrollIntoViewIfNeeded();
      const m = await page.evaluate(() => ['editProduct', 'archiveProduct'].map((a) => {
        const b = document.querySelector(`#productLibraryContainer [data-pl-action="${a}"]`);
        const r = b.getBoundingClientRect();
        return { a, h: r.height, hit: window.__pvHit(b) };
      }));
      for (const b of m) {
        expect(b.h, `${b.a} height`).toBeGreaterThanOrEqual(36);
        expect(b.hit, `${b.a} reachable`).toBe('');
      }
      await edit.tap();
      await expect(page.locator('#product-edit-modal')).toBeVisible();
      const cancel = page.locator('#product-edit-modal [data-pl-action="closeModal"]', { hasText: 'Cancel' });
      await cancel.scrollIntoViewIfNeeded();
      await cancel.tap();
      await expect(page.locator('#product-edit-modal')).toHaveCount(0);
    });

    await test.step('views#14 a search shows its matches without tapping a category', async () => {
      const search = page.locator('#product-search');
      await search.scrollIntoViewIfNeeded();
      await search.fill('shingle');
      await expect(page.locator('#productLibraryContainer .pl-card').first()).toBeVisible();
      await page.locator('#product-search').fill('');
    });

    await test.step('Sales Training: the Objection Obliterator drill opens from a tap', async () => {
      await openMore(page, 'training');
      const banner = page.locator('.rapid-banner');
      // Sales Training is a ~150KB lazy bundle (script-loader.js `training`);
      // on a loaded runner it outlasts the 15s action timeout.
      await expect(banner).toBeVisible({ timeout: 45_000 });
      await banner.scrollIntoViewIfNeeded();
      await banner.tap();
      await expect(page.locator('.rapid-objection')).toBeVisible();
    });
  });
});
for (const width of [412, 360]) productsSuite(width);

// ── light mode ─────────────────────────────────────────────────────────────

// Per phone width, like Products above (412 only until the 2026-09-25
// follow-up).
const lightSuite = (width) => test.describe(`phone views: light mode stays readable at ${width}px @audit`, () => {
  test.use({ colorScheme: 'light', viewport: { width, height: 860 } });

  test('chrome, dashboard labels, Talk Tank, the drill and Settings clear contrast', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page, { reload: true });
    await installProbes(page);
    const palette = await page.evaluate(() => {
      const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g).map(Number);
      return { mode: document.documentElement.getAttribute('data-mode'), light: (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.5 };
    });
    expect(palette, 'the light palette is painted on the second boot').toEqual({ mode: 'light', light: true });

    await test.step('views#11 header wordmark, header icons and bottom-nav labels', async () => {
      const c = await page.evaluate(() => ({
        logo: window.__pvContrast(document.querySelector('header .logo')),
        // The ↻ beside the sync dot (connection-status-btn.js) had no colour of
        // its own, so it painted the UA's black buttontext on the dark bar.
        sync: (() => { const g = document.querySelector('#nbd-conn-btn span:last-child'); return g ? window.__pvContrast(g) : null; })(),
        tools: [...document.querySelectorAll('header .hdr-tool')].filter((b) => b.offsetParent !== null).map((b) => window.__pvContrast(b)),
        nav: [...document.querySelectorAll('#mobile-nav .mn-item:not(.active):not(.mn-fab) .mn-lbl')].map((l) => ({ t: l.textContent.trim(), c: window.__pvContrast(l) })),
      }));
      expect(c.logo, '"NBD" wordmark on the dark header').toBeGreaterThanOrEqual(4.5);
      expect(c.sync, 'the header sync button renders').not.toBeNull();
      expect(c.sync, '↻ sync glyph on the dark header').toBeGreaterThanOrEqual(4.5);
      for (const t of c.tools) expect(t, 'header icon').toBeGreaterThanOrEqual(3);
      expect(c.nav.length).toBeGreaterThan(0);
      for (const n of c.nav) expect(n.c, `bottom-nav "${n.t}"`).toBeGreaterThanOrEqual(4.5);
      // :hover turned a header icon var(--t) — #0f172a on the near-black bar,
      // 1.04:1 — and on Android a tap leaves :hover stuck on what was tapped,
      // so the bell went dark-on-dark right after you opened it. Tap it for
      // real, then let the icon's .15s colour transition finish: read
      // immediately, it still shows the resting colour and the check passes
      // with the bug present.
      await page.locator('#notifBtn').tap();
      await animationsDone(page);
      const hovered = await page.evaluate(() => {
        const b = document.getElementById('notifBtn');
        return { stuck: b.matches(':hover'), c: window.__pvContrast(b) };
      });
      expect(hovered.stuck, 'a tap leaves :hover on the bell (the Android case this pins)').toBe(true);
      expect(hovered.c, 'hovered header icon on the dark header').toBeGreaterThanOrEqual(3);
      await page.locator('#notifBtn').tap();
      await expect(page.locator('#notifDropdown')).toBeHidden();
    });

    await test.step('views#11 Engagement Cohort + Next Best Actions labels', async () => {
      await page.locator('#mni-dash').tap();
      await safeEvaluate(page, () => window.dispatchEvent(new Event('nbd:data-refreshed')));
      // Tier rows: the grid children of the cohort list (label | bar | count).
      await safeWaitForFunction(page, () => [...document.querySelectorAll('#engagement-cohort-body > div:first-child > div')].some((r) => getComputedStyle(r).display === 'grid'), { timeout: 15_000 });
      await expect(page.locator('#smart-followup-briefing-body .sfb-row').first()).toBeVisible({ timeout: 15_000 });
      const c = await page.evaluate(() => ({
        // Empty tiers are dimmed to .45 on purpose; judge the live ones.
        cohort: [...document.querySelectorAll('#engagement-cohort-body > div:first-child > div')]
          .filter((r) => getComputedStyle(r).display === 'grid' && getComputedStyle(r).opacity === '1')
          .map((r) => ({ t: r.firstElementChild.textContent.trim(), c: window.__pvContrast(r.firstElementChild) })),
        // The TODAY / URGENT label: first span of the row's text column.
        sfb: [...document.querySelectorAll('#smart-followup-briefing-body .sfb-row > div:nth-child(2) > div:first-child > span:first-child')].map((l) => ({ t: l.textContent.trim(), c: window.__pvContrast(l) })),
      }));
      expect(c.cohort.length, 'at least one populated cohort tier').toBeGreaterThan(0);
      for (const x of c.cohort) expect(x.c, `cohort "${x.t}"`).toBeGreaterThanOrEqual(4.5);
      expect(c.sfb.length).toBeGreaterThan(0);
      for (const x of c.sfb) expect(x.c, `Next Best Actions "${x.t}" label`).toBeGreaterThanOrEqual(4.5);
    });

    await test.step('views#11 Talk Tank active filter chip', async () => {
      // Talk Tank has no phone entry point yet (views#1, another lane), so it
      // is opened the way the sidebar does it.
      await safeEvaluate(page, () => window.goTo('talk-tank'));
      const chip = page.locator('#view-talk-tank .tt-chip[data-tt-id]').first();
      await expect(chip).toBeVisible({ timeout: 15_000 });
      const c = await page.evaluate(() => {
        const a = document.querySelector('#view-talk-tank .tt-chip-active') || document.querySelector('#view-talk-tank .tt-chip');
        const bg = getComputedStyle(a).backgroundColor;
        return { bgPainted: !/rgba\(0, 0, 0, 0\)|transparent/.test(bg), c: window.__pvContrast(a) };
      });
      expect(c.bgPainted, 'the active chip has a fill').toBe(true);
      expect(c.c, 'active chip text').toBeGreaterThanOrEqual(4.5);
    });

    await test.step('views#3 Objection Obliterator banner and drill', async () => {
      await openMore(page, 'training');
      const banner = page.locator('.rapid-banner');
      await expect(banner).toBeVisible({ timeout: 45_000 }); // lazy `training` bundle, see above
      await banner.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => window.__pvContrast(document.querySelector('.rb-title'))), 'banner title').toBeGreaterThanOrEqual(4.5);
      await banner.tap();
      await expect(page.locator('.rapid-objection')).toBeVisible();
      expect(await page.evaluate(() => window.__pvContrast(document.querySelector('.rapid-objection'))), 'the objection to answer').toBeGreaterThanOrEqual(4.5);
    });

    await test.step('views#7 siblings: Team owner name and Billing usage figures', async () => {
      await openMore(page, 'settings');
      await openSettingsTab(page, 'team');
      expect(await page.evaluate(() => window.__pvContrast(document.getElementById('teamOwnerName'))), 'owner name').toBeGreaterThanOrEqual(4.5);
      await openSettingsTab(page, 'billing');
      const figs = await page.evaluate(() => ['billingLeadsUsed', 'billingReportsUsed', 'billingAIUsed'].map((id) => ({ id, c: window.__pvContrast(document.getElementById(id)) })));
      for (const f of figs) expect(f.c, f.id).toBeGreaterThanOrEqual(4.5);
    });
  });
});
for (const width of [412, 360]) lightSuite(width);
