/**
 * tests/pwa-manifest.test.js — Phase 11 PWA / offline / service worker.
 *
 * Static-but-real integrity checks that catch install-breaking PWA regressions:
 *   - docs/pro/manifest.json: valid JSON, required install fields, 192/512 +
 *     maskable icons whose files actually exist on disk, valid theme colors,
 *     start_url inside scope. The root docs/manifest.json must NOT exist (see
 *     the ROOT MANIFEST block below).
 *   - sw.js: parses, declares a shell cache version, wires install/activate/
 *     fetch handlers, every precached URL exists on disk, and NO_CACHE_HTML
 *     excludes the auth-gated + destructive pages (post-logout stale-shell leak
 *     guard). Offline-queue behaviour itself is IndexedDB/browser → needs-browser.
 *
 * Zero deps. Run: node tests/pwa-manifest.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const docPath = (url) => path.join(ROOT, 'docs', url.replace(/^\//, ''));
const isHex = (s) => typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);

let passed = 0, failed = 0; const fails = [];
function ok(name, cond) { if (cond) { passed++; console.log('  ✓ ' + name); } else { failed++; fails.push(name); console.log('  ✗ ' + name); } }

function checkManifest(rel, { scope } = {}) {
  console.log(`MANIFEST — ${rel}`);
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let m = null; try { m = JSON.parse(raw); } catch {}
  ok(`${rel} is valid JSON`, !!m);
  if (!m) return;
  for (const f of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    ok(`${rel} has "${f}"`, m[f] !== undefined);
  }
  ok(`${rel} display is a standalone-capable mode`, ['standalone', 'fullscreen', 'minimal-ui'].includes(m.display));
  ok(`${rel} theme_color is valid hex`, isHex(m.theme_color));
  ok(`${rel} background_color is valid hex`, isHex(m.background_color));
  ok(`${rel} has >=1 icon`, Array.isArray(m.icons) && m.icons.length >= 1);
  const sizes = (m.icons || []).map(i => i.sizes);
  ok(`${rel} has a 192x192 icon`, sizes.includes('192x192'));
  ok(`${rel} has a 512x512 icon`, sizes.includes('512x512'));
  ok(`${rel} has a maskable icon`, (m.icons || []).some(i => /maskable/.test(i.purpose || '')));
  for (const ic of (m.icons || [])) {
    ok(`${rel} icon file exists: ${ic.src}`, fs.existsSync(docPath(ic.src)));
    // Existence alone let a manifest lie about sizes (the 2026-09-13 worry that
    // kept the homeowner manifest out): read the PNG's IHDR and compare.
    if (fs.existsSync(docPath(ic.src))) {
      const b = fs.readFileSync(docPath(ic.src));
      const real = b.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && b.slice(12, 16).toString('latin1') === 'IHDR'
        ? `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}` : 'not a PNG';
      ok(`${rel} icon ${ic.src} really is ${ic.sizes} (IHDR ${real})`, real === ic.sizes);
    }
  }
  if (scope) ok(`${rel} start_url is within scope ${scope}`, m.start_url.startsWith(scope));
  if (scope) ok(`${rel} scope is ${scope}`, m.scope === scope);
  return m;
}

checkManifest('docs/pro/manifest.json', { scope: '/pro/' });

// ── Homeowner manifest (2026-09-27) ──
// Jo's iPhone test: Brave's saved-site tile showed the wordless roofline and
// /manifest.webmanifest 404'd. The homeowner site now ships its own manifest
// with the lettered NBD mark rendered by scripts/render-apple-touch-icon.js.
// Linked from every homeowner-site page by scripts/normalize-favicons.js.
{
  const home = checkManifest('docs/manifest.webmanifest', { scope: '/' });
  if (home) {
    ok('homeowner manifest name is the business name', home.name === 'No Big Deal Home Solutions');
    ok('homeowner manifest short_name is "No Big Deal" (the home-screen label)', home.short_name === 'No Big Deal');
    ok('homeowner manifest starts at the homepage', home.start_url === '/');
    ok('homeowner manifest icons all come from /assets/images (never the Pro art)', home.icons.every((i) => i.src.startsWith('/assets/images/home-icon-')));
    ok('homeowner manifest has a 512 maskable icon', home.icons.some((i) => i.purpose === 'maskable' && i.sizes === '512x512'));
  }
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const rules = (fb.hosting.headers || []).filter((h) => h.source === '/manifest.webmanifest');
  ok('firebase.json serves /manifest.webmanifest as application/manifest+json',
    rules.length === 1 && rules[0].headers.some((h) => h.key === 'Content-Type' && h.value === 'application/manifest+json'));
}

// ── Root manifest ──
// docs/manifest.json was deleted 2026-09-13. It was a copy of the PRO manifest
// ("NBD Pro — Contractor Platform", start_url /pro/dashboard.html) with
// scope "/", linked by no page — an install from anywhere on the homeowner
// site would have claimed the whole origin for the CRM. A homeowner manifest
// is not a rename away: no homeowner 192/512/maskable PNG exists, and the
// icon checks above only test existence, so a rewrite could pass by lying
// about sizes. Build real assets first if one is ever wanted.
// (2026-09-27: done — real assets, a separate file at /manifest.webmanifest,
// and the icon checks above now read each PNG's IHDR. This path stays gone.)
// documentation/audit/FAVICON-NORMALIZATION-2026-09-13.md
console.log('\nROOT MANIFEST — docs/manifest.json');
ok('docs/manifest.json does not exist (Pro-branded orphan with scope "/" deleted 2026-09-13)',
   !fs.existsSync(path.join(ROOT, 'docs/manifest.json')));

// ── Service worker ──
console.log('\nSERVICE WORKER — docs/pro/sw.js');
const swFile = path.join(ROOT, 'docs/pro/sw.js');
let syntaxOk = true;
try { execSync(`node --check "${swFile}"`, { stdio: 'pipe' }); } catch { syntaxOk = false; }
ok('sw.js parses (node --check)', syntaxOk);

const sw = fs.readFileSync(swFile, 'utf8');
ok('declares a shell cache version', /shell:\s*'nbd-shell-v\d+'/.test(sw));
ok('wires install handler', /addEventListener\(\s*'install'/.test(sw));
ok('wires activate handler (old-cache cleanup)', /addEventListener\(\s*'activate'/.test(sw));
ok('wires fetch handler', /addEventListener\(\s*'fetch'/.test(sw));

// precache list — every URL must exist on disk (a missing one fails SW install)
const addAll = sw.match(/addAll\(\[([\s\S]*?)\]\)/);
ok('has a precache addAll() list', !!addAll);
if (addAll) {
  const urls = [...addAll[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  ok('precache list is non-empty', urls.length > 0);
  for (const u of urls) ok(`precached file exists: ${u}`, fs.existsSync(docPath(u)));
}

// security: auth-gated + destructive pages must be in NO_CACHE_HTML
const noCache = sw.match(/NO_CACHE_HTML\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
ok('declares NO_CACHE_HTML set', !!noCache);
if (noCache) {
  const block = noCache[1];
  for (const p of ['/pro/dashboard.html', '/pro/login.html', '/pro/customer.html', '/pro/vault.html', '/pro/register.html']) {
    ok(`NO_CACHE_HTML excludes auth-gated ${p}`, block.includes(`'${p}'`));
  }
  ok('NO_CACHE_HTML excludes destructive account-erasure', /account-erasure/.test(block));
}

// ── One scriptURL per scope ──
// A different scriptURL for the same scope is a NEW registration, not an
// update: the browser installs it, sw.js calls skipWaiting + clients.claim,
// and dashboard-sw-bootstrap.js reloads the page on SW_UPDATE_AVAILABLE /
// controllerchange. Until 2026-09-02 offline-manager.js (customer/login)
// registered '/pro/sw.js?v=13' while the dashboard registered '/pro/sw.js',
// so every dashboard ↔ customer hop churned the worker and force-reloaded
// the dashboard on arrival. Every register() call under docs/pro must name
// the identical URL, with no query string.
console.log('\nSERVICE WORKER — one scriptURL across docs/pro');
{
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
      else if (/\.(js|html)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const files = walk(path.join(ROOT, 'docs/pro'));
  const calls = [];
  const re = /serviceWorker\s*\.\s*register\(\s*([^,)]+)(?:,\s*(\{[^}]*\}))?/g;
  for (const f of files) {
    // Drop comment lines first — pages/sw-register.js documents the inline
    // snippet it replaced, and that prose would otherwise match.
    const src = fs.readFileSync(f, 'utf8').split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    let m;
    while ((m = re.exec(src)) !== null) {
      calls.push({ file: path.relative(ROOT, f).split(path.sep).join('/'), arg: m[1].trim(), opts: (m[2] || '').trim(), src });
    }
  }
  ok('found the SW register() call sites (>= 3)', calls.length >= 3);
  // The offline/PWA worker: every registration must be the identical literal.
  // [/'"]sw.js, not bare sw.js: the sample account's /pro/explore/demo-sw.js
  // (Pro demo phase 2) is a separate worker and must fall to the sub-scope
  // check below instead.
  const pwa = calls.filter(c => /[\/'"]sw\.js/.test(c.arg) && !/messaging/.test(c.arg));
  ok('offline worker is registered from >= 3 pages (dashboard, customer/login, simple pages)', pwa.length >= 3);
  const urls = new Set(pwa.map(c => c.arg));
  ok('every offline-worker register() names the same scriptURL literal: ' + [...urls].join(' | '),
    urls.size === 1 && (urls.has("'/pro/sw.js'") || urls.has('"/pro/sw.js"')));
  for (const c of pwa) {
    ok(`${c.file} registers /pro/sw.js with no query string or concatenation`,
      /^['"]\/pro\/sw\.js['"]$/.test(c.arg));
  }
  // Any OTHER worker (today: the FCM messaging worker in push-registration.js)
  // must claim its own sub-scope, or it competes with sw.js for '/pro/'.
  for (const c of calls.filter(c => !pwa.includes(c))) {
    const scopeVar = /scope\s*:\s*([A-Za-z_$][\w$]*)/.exec(c.opts);
    const scopeLit = /scope\s*:\s*['"]([^'"]+)['"]/.exec(c.opts);
    let scope = scopeLit ? scopeLit[1] : null;
    if (!scope && scopeVar) {
      const decl = new RegExp('(?:var|let|const)\\s+' + scopeVar[1] + '\\s*=\\s*[\'"]([^\'"]+)[\'"]').exec(c.src);
      scope = decl ? decl[1] : null;
    }
    ok(`${c.file} registers ${c.arg} on a dedicated sub-scope (got ${scope || 'none'})`,
      !!scope && scope.startsWith('/pro/') && scope !== '/pro/');
  }
}

console.log('\n──────────────────────────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.log('\nFailures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
