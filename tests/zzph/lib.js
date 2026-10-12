// AUDIT-ONLY (uncommitted) helpers for the 2026-10-07 CRM phone audit.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.join(__dirname, '..', 'package.json'));
const { chromium } = req('playwright');

const BASE = 'http://127.0.0.1:5500';
const SHOTS = 'C:/Users/jonat/nbd-content/phone-D-shots/' + (process.env.PHASE || 'x');
const DATA = path.join(SHOTS, '_data');
fs.mkdirSync(DATA, { recursive: true });
const CREDS = { email: 'playwright-e2e@nbd.test', password: 'nbd-e2e-password-1' };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block', deviceScaleFactor: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' };
const DESK = { viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' };

const fnCalls = [];
const blocked = [];

async function launch() {
  return chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
}

async function context(browser, phone) {
  const ctx = await browser.newContext(Object.assign({ geolocation: { latitude: 39.3601, longitude: -84.3099 }, permissions: ['geolocation', 'microphone'] }, phone ? PHONE : DESK));
  // Private emulator ports (another lane holds the defaults).
  await ctx.route('**/nbd-emulator-connect.js*', async (route) => {
    const r = await route.fetch();
    let body = await r.text();
    body = body.replace("'http://127.0.0.1:9099'", "'http://127.0.0.1:9499'").replace("'127.0.0.1', 8080", "'127.0.0.1', 8480").replace("'127.0.0.1', 9199", "'127.0.0.1', 9599");
    route.fulfill({ response: r, body });
  });
  // SAFETY: nothing leaves. Every callable is answered by a stub and logged;
  // every send provider is aborted.
  await ctx.route(/(127\.0\.0\.1:5001|cloudfunctions\.net|\.run\.app)\//, (route) => {
    const u = route.request().url();
    fnCalls.push(u.replace(/^.*\//, ''));
    if (/dictate$/.test(u) && global.__dictateOk) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { transcript: 'Dana wants the charcoal shingle and a gutter quote by Friday.', summary: { overview: 'Dana picked charcoal; wants a gutter quote by Friday.', actionItems: ['Send Dana a gutter quote'], category: 'lead' } } }) });
    route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'stubbed by phone qw' } }) });
  });
  await ctx.route(/(api\.twilio\.com|api\.resend\.com|api\.stripe\.com|fcm\.googleapis\.com|api\.anthropic\.com|api\.openai\.com|api\.deepgram\.com)/, (route) => { blocked.push(route.request().url()); route.abort(); });
  await ctx.route('**/nominatim.openstreetmap.org/**', (r) => /reverse/.test(r.request().url()) ? r.fulfill({ contentType: 'application/json', body: JSON.stringify({ display_name: '320 Knock Knock Lane, Mason, Ohio, 45040', address: { house_number: '320', road: 'Knock Knock Lane', city: 'Mason', state: 'Ohio', postcode: '45040' } }) }) : r.fulfill({ contentType: 'application/json', body: '[]' }));
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('nbd-onboarding-complete', '1');
      const today = new Date().toISOString().split('T')[0];
      localStorage.setItem('nbd_proactive_overdue_scan', today);
      localStorage.setItem('nbd_proactive_pending_estimate_scan', today);
    } catch (e) {}
    navigator.share = async (d) => { window.__shared = d; };
    // Re-apply forced standalone rules on every navigation once flagged.
    window.__forceStandalone = function () {
      if (document.getElementById('audit-force-standalone')) return -1;
      let css = '';
      for (const sh of document.styleSheets) { let rules; try { rules = sh.cssRules; } catch (e) { continue; }
        for (const r of rules) if (r.media && /display-mode:\s*standalone/.test(r.conditionText || r.media.mediaText)) for (const inner of r.cssRules) css += inner.cssText + '\n'; }
      const s = document.createElement('style'); s.id = 'audit-force-standalone'; s.textContent = css; document.head.appendChild(s);
      return css.length;
    };
  });
  return ctx;
}

async function login(page) {
  const t0 = Date.now();
  await page.goto(BASE + '/pro/login.html');
  await page.waitForSelector('#loginBtn:not([disabled])', { timeout: 30000 });
  await page.fill('#emailInput', CREDS.email);
  await page.fill('#passwordInput', CREDS.password);
  await Promise.all([page.waitForURL(/\/pro\/dashboard(\.html)?([?#]|$)/, { timeout: 45000 }), page.click('#loginBtn')]);
  await page.waitForFunction(() => !!(window._user && window._user.uid), null, { timeout: 45000 });
  return Date.now() - t0;
}

async function standalone(page) { return page.evaluate(() => window.__forceStandalone && window.__forceStandalone()).catch(() => 0); }
async function skipTour(page) {
  const s = page.getByText('Skip tour', { exact: true });
  if (await s.isVisible().catch(() => false)) await s.click({ timeout: 3000 }).catch(() => {});
}

// ── per-task meter ──
class Meter {
  constructor(name, page) { this.name = name; this.page = page; this.taps = 0; this.typed = 0; this.t0 = Date.now(); this.notes = []; this.steps = []; }
  async tap(locator, label) {
    const box = await locator.boundingBox().catch(() => null);
    this.taps++;
    this.steps.push({ t: Date.now() - this.t0, tap: label, box: box && { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } });
    await locator.click({ timeout: 15000 });
  }
  async type(locator, text, label) {
    this.typed += text.length;
    this.steps.push({ t: Date.now() - this.t0, type: label, n: text.length });
    await locator.fill(text);
  }
  note(s) { this.notes.push(s); }
  done(ok, extra) {
    const r = Object.assign({ task: this.name, ok, taps: this.taps, typedChars: this.typed, ms: Date.now() - this.t0, steps: this.steps, notes: this.notes }, extra || {});
    fs.writeFileSync(path.join(DATA, 'task-' + this.name.replace(/\W+/g, '_') + '-' + this.page.viewportSize().width + '.json'), JSON.stringify(r, null, 2));
    return r;
  }
}

// ── page measurements (thumb zone, tap targets, small text, contrast, overflow) ──
async function measure(page) {
  return page.evaluate(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const sel = (el) => { let s = el.tagName.toLowerCase(); if (el.id) s += '#' + el.id; else if (el.className && typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.'); const da = el.getAttribute('data-action') || el.getAttribute('data-fn'); if (da) s += '[' + da + ']'; return s; };
    const covered = (el) => { const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; if (cx < 0 || cy < 0 || cx > W || cy > H) return null; const hit = document.elementFromPoint(cx, cy); return hit && !(hit === el || el.contains(hit) || hit.contains(el)) ? sel(hit) : null; };
    const taps = [], coveredBy = [];
    document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button], [data-action], summary, label[for]').forEach((el) => {
      if (!vis(el)) return; const r = el.getBoundingClientRect();
      if (el.tagName === 'A' && getComputedStyle(el).display === 'inline' && el.closest('p,li,small')) return;
      const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      if ((r.height < 44 || r.width < 44) && r.top < H * 3) taps.push({ s: sel(el), t, w: Math.round(r.width), h: Math.round(r.height), y: Math.round(r.top + window.scrollY) });
      if (r.top >= 0 && r.bottom <= H) { const c = covered(el); if (c) coveredBy.push(sel(el) + ' "' + t + '" under ' + c); }
    });
    const small = []; const seen = new Set();
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
    while ((n = tw.nextNode())) {
      const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t.length < 3) continue;
      const el = n.parentElement; if (!el || seen.has(el) || !vis(el)) continue; seen.add(el);
      const f = parseFloat(getComputedStyle(el).fontSize); if (f < 12) small.push(f + 'px ' + sel(el) + ' "' + t.slice(0, 50) + '"');
    }
    const lum = (c) => { let m = c.match(/[\d.]+/g); if (!m) return null; if (/^color\(/.test(c)) m = m.map((v) => v * 255); const [r, g, b] = m.slice(0, 3).map((v) => { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    const bgOf = (el) => { for (let p = el; p; p = p.parentElement) { const b = getComputedStyle(p).backgroundColor; const a = b.match(/[\d.]+/g); const alpha = /\//.test(b) ? parseFloat(b.split('/')[1]) : (a && a.length >= 4 ? Number(a[3]) : 1); if (a && alpha > 0.5) return b; } return getComputedStyle(document.body).backgroundColor || 'rgb(0,0,0)'; };
    const lowc = []; const seen2 = new Set();
    const tw2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while ((n = tw2.nextNode())) {
      const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t.length < 3) continue;
      const el = n.parentElement; if (!el || seen2.has(el) || !vis(el)) continue; seen2.add(el);
      const r = el.getBoundingClientRect(); if (r.top > H * 2) continue;
      const cs = getComputedStyle(el); const L1 = lum(cs.color), L2 = lum(bgOf(el)); if (L1 == null || L2 == null) continue;
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      // "sunlight" bar: 4.5:1 for everything (outdoor glare eats ~1 step)
      if (ratio < 4.5) lowc.push(ratio.toFixed(2) + ':1 ' + parseFloat(cs.fontSize) + 'px ' + sel(el) + ' "' + t.slice(0, 40) + '"');
    }
    const fixed = [];
    document.querySelectorAll('body *').forEach((el) => { const cs = getComputedStyle(el); if ((cs.position === 'fixed' || cs.position === 'sticky') && vis(el)) { const r = el.getBoundingClientRect(); if (r.width * r.height > 1500) fixed.push(sel(el) + ' ' + cs.position + ' [' + Math.round(r.top) + '..' + Math.round(r.bottom) + '] h=' + Math.round(r.height)); } });
    const se = document.scrollingElement;
    return { url: location.pathname + location.hash, W, H, docScrollX: document.documentElement.scrollWidth - document.documentElement.clientWidth, pageHeight: se.scrollHeight, screens: +(se.scrollHeight / H).toFixed(1),
      tapsUnder44: taps.slice(0, 60), tapsUnder44Count: taps.length, coveredBy: coveredBy.slice(0, 20), smallText: small.slice(0, 40), smallTextCount: small.length, lowContrast: lowc.slice(0, 40), lowContrastCount: lowc.length, fixed: fixed.slice(0, 15),
      text: document.body.innerText.slice(0, 6000) };
  });
}

async function shot(page, name, opts) {
  const o = opts || {};
  const w = page.viewportSize().width;
  const file = path.join(SHOTS, name + '-' + w + '.png'); fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.waitForTimeout(o.settle == null ? 500 : o.settle);
  await page.screenshot({ path: file, fullPage: !!o.full });
  let m = null;
  if (o.measure !== false) { m = await measure(page).catch((e) => ({ error: String(e) })); m.shot = file; fs.writeFileSync(path.join(DATA, name.replace(/[/]/g, '__') + '-' + w + '.json'), JSON.stringify(m, null, 2)); }
  return m || { shot: file };
}

// elements in the bottom 1/3 = easy thumb, top 1/4 = stretch (one-handed on a 6.1" phone)
async function zone(page, locator) {
  const b = await locator.boundingBox().catch(() => null); if (!b) return 'hidden';
  const H = page.viewportSize().height; const cy = b.y + b.height / 2;
  if (cy < 0 || cy > H) return 'offscreen(y=' + Math.round(cy) + ')';
  return (cy < H * 0.25 ? 'STRETCH-top' : cy > H * 0.6 ? 'thumb' : 'mid') + '(y=' + Math.round(cy) + ',h=' + Math.round(b.height) + ')';
}

module.exports = { BASE, SHOTS, DATA, PHONE, DESK, fnCalls, blocked, launch, context, login, standalone, skipTour, Meter, measure, shot, zone };
