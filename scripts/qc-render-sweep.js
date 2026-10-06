#!/usr/bin/env node
/*
 * qc-render-sweep.js — the first RENDERED check in this repo.
 *
 * Why this exists: every other gate here is grep-shaped
 * (check-site-integrity, ensure-icon-css, ensure-nav-css,
 * check-inline-html-scripts, apply-partials --check). None of them can see a
 * cascade-order or layout defect, because none of them ever computes a style.
 * That blind spot is not theoretical — it has shipped four times:
 *
 *   2026-08-17  invisible orange-on-orange icon chips on the homepage
 *   2026-08-17  nav-base CSS missing on 18 pages -> dropdown splattered open
 *   2026-08-17  docs/index.html carried its whole <style> block TWICE;
 *               edits to the first copy were silently dead
 *   2026-08-18  /sites/free-guide rendered svg.ico at 1227x1227px
 *
 * All four were caught by Jo's eyes, not by CI. This sweep asserts the
 * signatures those four share, against a real browser.
 *
 * Usage:
 *   node scripts/qc-render-sweep.js                 # sweep, exit 1 on findings
 *   node scripts/qc-render-sweep.js --report-only   # always exit 0 (advisory)
 *   node scripts/qc-render-sweep.js --json out.json # machine-readable report
 *   node scripts/qc-render-sweep.js --limit 25      # first N pages (smoke)
 *   node scripts/qc-render-sweep.js --base http://localhost:5000
 *
 * Expects a server already serving docs/ (npx firebase serve --only hosting).
 * Run from the repo root. Playwright resolves from tests/node_modules.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

// Playwright lives in tests/, not at the repo root (there is no root package.json).
const testRequire = createRequire(path.join(ROOT, 'tests', 'package.json'));
let chromium;
try {
  ({ chromium } = testRequire('playwright'));
} catch {
  console.error('qc-render-sweep: playwright not found. Run `npm install` in tests/.');
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};
const REPORT_ONLY = argv.includes('--report-only');
const BASE = (flag('--base', 'http://localhost:5000') || '').replace(/\/$/, '');
const JSON_OUT = flag('--json');
const LIMIT = Number(flag('--limit', '0')) || 0;
const MOBILE_W = 390;

// Every page renders at 1280 + 390. Two more widths render for the service
// surface only, because 390px is the one width that misses the defect class
// fixed on 2026-09-08 (see documentation/audit/SERVICE-PAGE-OVERFLOW-2026-09-08.md):
//
//   320px — the narrow-phone floor. /services/roof-replacement carried 59px of
//     real document overflow here and 0px at 390px, so this sweep called it
//     clean for three weeks. iPhone SE/5 and Android at 200% text zoom land here.
//   820px — between the trust bar's mobile scroller (which stopped at 768px)
//     and the 920px its five items need. 100px of overflow at 820px, invisible
//     to both existing widths.
//
// Service-surface-only is a deliberate scope, not a preference: at 320px the
// blog surface (12 pages, 37px — .author-box flex items) and two /pro pages
// (46px, a long <code> URL) carry the same class of pre-existing defect. They
// are real and filed, but each needs its own layout decision, and reddening
// this gate on them would have meant landing them unreviewed. Widen NARROW_SURFACE
// as each surface is fixed — the intent is that it eventually matches everything.
const NARROW_VIEWPORTS = [['narrow', 320], ['band', 820]];
const NARROW_SURFACE = (urlPath) => urlPath.startsWith('/services/');

// Directories that are not part of the homeowner marketing surface.
// 'pro'/'admin' are app surfaces behind auth; sweeping them wholesale would
// mostly report login-wall noise.
const SKIP_DIRS = new Set(['assets', 'admin', 'pro', 'deploy', '_archive', 'archive']);

// …but the PUBLIC /pro acquisition pages render for anonymous visitors and are
// exactly as regression-prone as the homeowner surface, while sitting outside
// check-site-integrity too (it skips docs/pro/** entirely). Re-include them by
// name. Anything requiring a session stays out — see crm-audit.js for those.
const PRO_PUBLIC = [
  'index.html', 'pricing.html', 'how-to.html', 'terms.html',
  'register.html', 'login.html', 'sandbox.html',
].map((f) => path.join(DOCS, 'pro', f));
// Pages that are intentionally bare or non-visual. 404.html got real
// nav/mobile-nav/footer chrome (2026-09-17) — it's exactly the
// dropdown-open-at-rest / invisible-icon class of page this sweep exists
// to catch now, so it no longer belongs here.
const SKIP_FILES = new Set(['offline.html', 'googlee5b8f461f0f8e74b.html']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.name.endsWith('.html') && !SKIP_FILES.has(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// docs/services/foo.html -> /services/foo   (firebase cleanUrls + trailingSlash:false)
function toUrlPath(file) {
  const rel = path.relative(DOCS, file).split(path.sep).join('/');
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'/index.html'.length);
  return '/' + rel.replace(/\.html$/, '');
}

/* ---------- static check: duplicated <style> blocks ---------------------
 * docs/index.html once shipped its entire page <style> twice. Edits to the
 * first copy were silently dead — the kind of bug that wastes a whole
 * session. Cheap to detect without a browser, so do it from source. */
function duplicateStyleBlocks(file) {
  const html = fs.readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => m[1].trim())
    .filter((b) => b.length > 400); // ignore tiny guards/shims
  const seen = new Map();
  const dupes = [];
  for (const b of blocks) {
    const key = b.replace(/\s+/g, ' ');
    if (seen.has(key)) dupes.push({ bytes: b.length, firstSeenIndex: seen.get(key) });
    else seen.set(key, seen.size);
  }
  return dupes;
}

/* ---------- in-page probe (runs inside the browser) ------------------- */
function probe() {
  const findings = [];
  const de = document.documentElement;
  const desc = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).slice(0, 2).join('.');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };

  // 1. Oversized inline SVG — the /sites/free-guide defect (1227px).
  // Real icons here are 13-26px; a hero illustration can legitimately be
  // larger, so 64px is a deliberately loose floor that still catches
  // "unsized SVG filled the viewport".
  for (const svg of document.querySelectorAll('svg.ico, svg.nav-ico')) {
    const r = svg.getBoundingClientRect();
    if (r.width > 64 || r.height > 64) {
      findings.push({
        type: 'oversized-icon',
        el: desc(svg),
        detail: Math.round(r.width) + 'x' + Math.round(r.height) + 'px',
      });
    }
  }

  // 2. Icon invisible against its own chip — the 2026-08-17 cascade bug,
  // where nbd-icons.css out-cascaded a per-page white-icon <style> and left
  // orange icons on solid-orange chips.
  const parseRgb = (s) => (s.match(/\d+/g) || []).slice(0, 3).map(Number);
  const opaqueBgOf = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      const p = parseRgb(bg);
      const alpha = bg.startsWith('rgba') ? Number(bg.split(',')[3]) : 1;
      if (p.length === 3 && alpha > 0.5) return p;
    }
    return null;
  };
  for (const svg of document.querySelectorAll('svg.ico, svg.nav-ico')) {
    const cs = getComputedStyle(svg);
    // Icons here are stroked outlines; the visible ink is stroke or color.
    const ink = parseRgb(cs.stroke !== 'none' ? cs.stroke : cs.color);
    const bg = opaqueBgOf(svg);
    if (ink.length === 3 && bg) {
      const dist = Math.abs(ink[0] - bg[0]) + Math.abs(ink[1] - bg[1]) + Math.abs(ink[2] - bg[2]);
      if (dist < 40) {
        findings.push({
          type: 'invisible-icon',
          el: desc(svg),
          detail: 'ink rgb(' + ink + ') vs bg rgb(' + bg + '), distance ' + dist,
        });
      }
    }
  }

  // 3. Dropdown menu rendered open at rest — the /the-pledge nav-base bug,
  // where missing CSS left the Services dropdown splattered over the header.
  for (const menu of document.querySelectorAll('.dropdown-menu')) {
    const r = menu.getBoundingClientRect();
    const cs = getComputedStyle(menu);
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1;
    if (visible && r.height > 0 && !menu.closest('.mobile-nav')) {
      findings.push({
        type: 'dropdown-open-at-rest',
        el: desc(menu),
        detail: Math.round(r.width) + 'x' + Math.round(r.height) + 'px, display=' + cs.display,
      });
    }
  }

  // 4. Horizontal overflow — reported at the caller's viewport width.
  if (de.scrollWidth > de.clientWidth + 2) {
    const culprits = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > de.clientWidth + 2 && el.children.length === 0) {
        culprits.push(desc(el) + ' (right=' + Math.round(r.right) + ')');
        if (culprits.length >= 3) break;
      }
    }
    findings.push({
      type: 'horizontal-overflow',
      el: 'document',
      detail: de.scrollWidth + 'px content in ' + de.clientWidth + 'px viewport'
        + (culprits.length ? ' — e.g. ' + culprits.join(', ') : ''),
    });
  }

  return findings;
}

/* ---------- main ------------------------------------------------------ */
(async () => {
  let files = walk(DOCS).concat(PRO_PUBLIC.filter((f) => fs.existsSync(f)));
  files.sort();
  if (LIMIT) files = files.slice(0, LIMIT);

  const browser = await chromium.launch({ headless: true });

  /* Firebase Hosting applies cleanUrls (/services/foo -> foo.html); a plain
   * static server (http-server, as CI uses) does not. Probe once and fall
   * back to explicit .html paths rather than reporting 208 phantom 404s. */
  let cleanUrls = true;
  {
    const probePage = await browser.newPage();
    try {
      const r = await probePage.goto(BASE + '/about', { waitUntil: 'commit', timeout: 15000 });
      cleanUrls = !!r && r.status() < 400;
    } catch { cleanUrls = false; }
    await probePage.close();
    if (!cleanUrls) console.error('qc-render-sweep: server has no cleanUrls — using .html paths');
  }
  // Literal on-disk path for servers without cleanUrls. Directory indexes
  // stay directory URLs (/areas/), only leaf pages regain the .html.
  const rawPath = (file) => {
    const rel = path.relative(DOCS, file).split(path.sep).join('/');
    if (rel === 'index.html') return '/';
    if (rel.endsWith('/index.html')) return '/' + rel.slice(0, -'index.html'.length);
    return '/' + rel;
  };
  // A leaf page whose basename collides with a same-named sibling directory
  // (our-work.html next to our-work/<slug>.html, added 2026-09-17) is
  // genuinely ambiguous for a plain static file server: Firebase Hosting's
  // real cleanUrls priority is exact file, then +.html, then /index.html —
  // our-work.html wins there — but http-server (what CI runs) resolves the
  // directory first, redirects to our-work/, and 404s with no index.html
  // inside it. Route around that one case rather than trusting the global
  // cleanUrls probe, which only sampled a collision-free page (/about).
  const collidesWithDir = (file) => {
    const rel = path.relative(DOCS, file).split(path.sep).join('/');
    if (rel === 'index.html' || rel.endsWith('/index.html')) return false;
    const base = path.join(DOCS, rel.replace(/\.html$/, ''));
    return fs.existsSync(base) && fs.statSync(base).isDirectory();
  };

  const report = [];
  let scanned = 0;

  for (const file of files) {
    const urlPath = toUrlPath(file);
    const fetchPath = (cleanUrls && !collidesWithDir(file)) ? urlPath : rawPath(file);
    const findings = [];

    for (const d of duplicateStyleBlocks(file)) {
      findings.push({
        type: 'duplicate-style-block',
        el: '<style>',
        detail: d.bytes + ' bytes duplicated — edits to the first copy are dead',
      });
    }

    const viewports = [['desktop', 1280], ['mobile', MOBILE_W]];
    if (NARROW_SURFACE(urlPath)) viewports.push(...NARROW_VIEWPORTS);

    for (const [label, width] of viewports) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const resp = await page.goto(BASE + fetchPath, { waitUntil: 'load', timeout: 20000 });
        if (!resp || resp.status() >= 400) {
          findings.push({
            type: 'page-error',
            el: 'http',
            detail: 'status ' + (resp ? resp.status() : 'no response'),
            viewport: label,
          });
        } else {
          for (const f of await page.evaluate(probe)) {
            // Overflow is viewport-specific; the rest repeat across widths.
            if (label === 'desktop' || f.type === 'horizontal-overflow') {
              findings.push({ ...f, viewport: label });
            }
          }
        }
      } catch (e) {
        findings.push({
          type: 'page-error', el: 'navigation',
          detail: String(e.message || e).split('\n')[0].slice(0, 120), viewport: label,
        });
      } finally {
        await page.close();
      }
    }

    scanned++;
    if (findings.length) report.push({ page: urlPath, findings });
    if (scanned % 25 === 0) process.stderr.write('  ...' + scanned + '/' + files.length + '\n');
  }

  await browser.close();

  const byType = {};
  for (const p of report) for (const f of p.findings) byType[f.type] = (byType[f.type] || 0) + 1;
  const total = Object.values(byType).reduce((a, b) => a + b, 0);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ scanned, total, byType, report }, null, 2));
    console.log('qc-render-sweep: wrote ' + JSON_OUT);
  }

  console.log('\nqc-render-sweep: ' + scanned + ' page(s) rendered at 1280px + ' + MOBILE_W
    + 'px, plus ' + NARROW_VIEWPORTS.map(v => v[1] + 'px').join(' + ') + ' on /services/');
  if (!total) {
    console.log('  clean — no findings.');
    process.exit(0);
  }
  console.log('  ' + total + ' finding(s) across ' + report.length + ' page(s):');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log('    ' + String(n).padStart(4) + '  ' + t);
  }
  console.log('');
  for (const p of report) {
    console.log('  ' + p.page);
    for (const f of p.findings) {
      console.log('      [' + f.type + '] ' + f.el + (f.viewport ? ' @' + f.viewport : '') + ' — ' + f.detail);
    }
  }
  process.exit(REPORT_ONLY ? 0 : 1);
})().catch((e) => {
  console.error('qc-render-sweep: fatal', e);
  process.exit(2);
});
