/**
 * tests/favicon-contract.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Until 2026-09-13 the site flew two brands' icons on the wrong audiences:
 * 31 of 36 /pro CRM pages carried the homeowner favicon (while 23 of them used
 * the NBD PRO apple-touch icon), the one page carrying the PRO favicon was a
 * homeowner-facing photo review, 13 pages carried no icon at all, and a
 * scope "/" Pro manifest sat at the site root linked by nothing. Nothing
 * noticed, because no test pinned a per-page icon — the only favicon
 * assertions (marketing-polish-contract.test.js 1c) check that the two SVG
 * files are real markup. Jo's rule: two icons across every page, by audience.
 *
 * This pins that rule without a page list. Every page under docs/ is walked
 * from the filesystem and classified by scripts/normalize-favicons.js's PATH
 * rule, so a page added tomorrow is covered the day it lands:
 *   - homeowner pages carry exactly /favicon.svg + /assets/images/apple-touch-icon.png
 *   - pro pages carry exactly /pro/favicon.svg + /pro/img/nbd-icon-192.png
 *   - Oaks and the tenant template carry NO NBD icon href (cross-brand leak)
 *   - the Google verification stub is byte-for-byte untouched
 * It also proves the codemod is a gate and not a rubber stamp: the pure
 * transform changes a wrong page, leaves a right page alone, keeps CRLF
 * clean, and refuses a malformed <head>; `--check` exits 1 on a scratch tree
 * that is out of contract and 0 once it is fixed.
 *
 * documentation/audit/FAVICON-NORMALIZATION-2026-09-13.md
 * Pure-Node, zero deps. Run: node tests/favicon-contract.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SCRIPT = path.join(ROOT, 'scripts', 'normalize-favicons.js');
const tool = require(SCRIPT);

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const head = (inner) => `<!doctype html><html><head>\n<meta charset="utf-8">\n<title>t</title>\n${inner}</head><body></body></html>`;
const iconCount = (html) => tool.iconLinks(html).length;

console.log('\nTHE TRANSFORM CAN FAIL — and leaves a correct page alone');
{
  const H = tool.CANON.homeowner, P = tool.CANON.pro;
  // A homeowner-SITE page (2026-09-27): four icon tags + manifest + home-screen title.
  const HB = [...H, ...tool.HOMEOWNER_EXTRAS];

  const wrong = head(`${P[0]}\n${P[1]}\n<link rel="stylesheet" href="/a.css">\n`);
  const r1 = tool.normalizeIcons(wrong, 'homeowner');
  ok('a homeowner page carrying the PRO pair is changed', r1.changed === true && !r1.refused);
  ok('…to exactly the homeowner block, in place', iconCount(r1.html) === 4 && r1.html.includes(HB.join('\n') + '\n<link rel="stylesheet"'));
  ok('…and no PRO href survives', !r1.html.includes('/pro/favicon.svg') && !r1.html.includes('/pro/img/nbd-icon-192.png'));

  const right = head(`${HB.join('\n')}\n`);
  const r2 = tool.normalizeIcons(right, 'homeowner');
  ok('a page already carrying its canonical block is returned unchanged (strict ===)', r2.changed === false && r2.html === right);
  const reversed = head(`${[...HB].reverse().join('\n')}\n`);
  ok('…in any order (pro/daily-success puts apple-touch first)', tool.normalizeIcons(reversed, 'homeowner').html === reversed);

  // Jo 2026-09-27: Brave's saved-site tile showed the wordless roofline because
  // favicon.svg was the only rel="icon". The old pair on a homeowner-site page
  // is now drift, so the sized lettered PNGs cannot silently fall off a page.
  const oldPair = head(`${tool.HOMEOWNER_ICON}\n${tool.HOMEOWNER_TOUCH_IN_PRO}\n`);
  const r9 = tool.normalizeIcons(oldPair, 'homeowner', 'services/x.html', 'services/x.html');
  ok('the pre-2026-09-27 pair on a homeowner-site page is out of contract', r9.changed === true);
  ok('…and becomes the six-line block where the pair was', r9.html.includes('<title>t</title>\n' + HB.join('\n') + '\n</head>'));
  ok('the block keeps favicon.svg (small tab mark) and adds 192/512 PNG icons, a sized apple-touch icon, the manifest and the title',
    H.includes('<link rel="icon" href="/favicon.svg" type="image/svg+xml">')
    && /sizes="192x192"[^>]*home-icon-192\.png/.test(H.join(' ')) && /sizes="512x512"[^>]*home-icon-512\.png/.test(H.join(' '))
    && /apple-touch-icon[^>]*sizes="180x180"/.test(H.join(' '))
    && tool.HOMEOWNER_EXTRAS.includes('<link rel="manifest" href="/manifest.webmanifest">')
    && tool.HOMEOWNER_EXTRAS.includes('<meta name="apple-mobile-web-app-title" content="No Big Deal">'));
  const strayExtras = head(`<meta name="apple-mobile-web-app-title" content="Roofing">\n${H.join('\n')}\n<link rel="manifest" href="/pro/manifest.json">\n`);
  const r10 = tool.normalizeIcons(strayExtras, 'homeowner');
  ok('a stray manifest link and a different home-screen title on a homeowner-site page are replaced, one of each',
    tool.isCanonical(r10.html, 'homeowner') && tool.manifestLinks(r10.html).length === 1 && tool.appTitleMetas(r10.html).length === 1 && !r10.html.includes('/pro/manifest.json'));
  const inPro = tool.normalizeIcons(head(`${H.join('\n')}\n`), 'homeowner', 'pro/portal.html', 'pro/portal.html');
  ok('a homeowner page inside docs/pro keeps the original pair and gets no manifest or title (the CRM lane owns docs/pro)',
    inPro.changed && iconCount(inPro.html) === 2 && tool.HOMEOWNER_IN_PRO.every((t) => inPro.html.includes(t))
    && tool.manifestLinks(inPro.html).length === 0 && tool.appTitleMetas(inPro.html).length === 0);
  const proWithManifest = head(`${P[0]}\n${P[1]}\n<link rel="manifest" href="/pro/manifest.json">\n`);
  ok('a pro page\'s own /pro/manifest.json link is not touched', tool.normalizeIcons(proWithManifest, 'pro', 'pro/x.html', 'pro/x.html').html === proWithManifest);
  ok('re-running on the transform\'s own output is a no-op (idempotent)', tool.normalizeIcons(r1.html, 'homeowner').html === r1.html);

  const none = head('<link rel="stylesheet" href="/a.css">\n');
  const r3 = tool.normalizeIcons(none, 'pro');
  ok('a page with no icon gets the pair on the line after <title>', r3.html.includes('<title>t</title>\n' + P[0] + '\n' + P[1] + '\n'));
  ok('…exactly once', iconCount(r3.html) === 2);
  const noTitle = '<html><head>\n<meta charset="utf-8">\n</head><body></body></html>';
  const r4 = tool.normalizeIcons(noTitle, 'pro');
  ok('a page with no icon and no <title> gets the pair immediately before </head>', r4.html.includes(P[1] + '\n</head>') && iconCount(r4.html) === 2);

  const legacy = head(`<link rel="shortcut icon" href="/favicon.ico">\n  <link rel="mask-icon" href="/x.svg" color="#000">\n<link rel="apple-touch-icon-precomposed" href="/y.png">\n${H[0]}\n${H[0]}\n`);
  const r5 = tool.normalizeIcons(legacy, 'homeowner');
  ok('shortcut icon, mask-icon, apple-touch-icon-precomposed and a duplicate are all removed', iconCount(r5.html) === 4 && tool.isCanonical(r5.html, 'homeowner'));
  ok('…and the block takes the first removed tag\'s position', r5.html.includes('<title>t</title>\n' + HB.join('\n') + '\n</head>'));

  const indented = '<html>\n  <head>\n    <title>t</title>\n    <link rel="icon" href="/favicon.svg">\n  </head>\n</html>';
  const r6 = tool.normalizeIcons(indented, 'pro');
  ok('the removed tag\'s indentation is kept', r6.html.includes('\n    ' + P[0] + '\n    ' + P[1] + '\n  </head>'));

  const preload = head(`<link rel="preload" as="image" href="/favicon.svg">\n${HB.join('\n')}\n`);
  ok('a non-icon <link> that merely points at /favicon.svg is not an icon tag', tool.normalizeIcons(preload, 'homeowner').html === preload);

  const crlf = wrong.replace(/\n/g, '\r\n');
  const r7 = tool.normalizeIcons(crlf, 'homeowner');
  ok('CRLF in → CRLF out: no bare LF', r7.changed && !/(^|[^\r])\n/.test(r7.html));
  ok('…and no lone CR (the \\r\\r\\n double-conversion that makes git call a file binary)', !/\r(?!\n)/.test(r7.html));
  const r7b = tool.normalizeIcons(none.replace(/\n/g, '\r\n'), 'pro');
  ok('an insertion into a CRLF page with no icon is CRLF too', !/(^|[^\r])\n/.test(r7b.html) && !/\r(?!\n)/.test(r7b.html) && iconCount(r7b.html) === 2);

  const zero = '<html><body><link rel="icon" href="/favicon.svg"></body></html>';
  const r8 = tool.normalizeIcons(zero, 'homeowner');
  ok('a page with no </head> is refused and returned untouched', r8.refused === true && r8.html === zero);
  const two = '<head><title>a</title></head><head></head>';
  ok('a page with two </head> is refused', tool.normalizeIcons(two, 'pro').refused === true);
  let threw = false; try { tool.normalizeIcons(right, 'excluded'); } catch (e) { threw = true; }
  ok('the transform refuses to run for an audience that has no canonical pair', threw);
}

console.log('\nCLASSIFICATION — by path, then the override map; never a page list');
{
  const cls = (p) => tool.classify(p).audience;
  for (const p of ['pro/dashboard.html', 'pro/blog/index.html', 'pro/daily-success/index.html', 'admin/index.html', 'tools/index.html', 'pro/esign-setup.html']) {
    ok(`${p} → pro`, cls(p) === 'pro', cls(p));
  }
  for (const p of ['index.html', 'blog/why-class-4-impact-shingles.html', 'areas/mason-oh.html', 'services/storm-damage.html']) {
    ok(`${p} → homeowner`, cls(p) === 'homeowner', cls(p));
  }
  ok('a page that does not exist yet under services/ → homeowner (the default rule, not a list)', cls('services/brand-new-page.html') === 'homeowner');
  ok('a page that does not exist yet under pro/ → pro (new CRM pages default to the PRO mark)', cls('pro/brand-new-page.html') === 'pro');
  for (const p of ['sites/oaks/index.html', 'sites/oaks/404.html', 'sites/oaks/services/roof-repair.html', 'sites/t/index.html']) {
    ok(`${p} → excluded`, cls(p) === 'excluded', cls(p));
  }
  ok('the Google verification stub → skip', cls('googlee5b8f461f0f8e74b.html') === 'skip');
  ok('Windows separators classify the same as forward slashes', cls('pro\\dashboard.html') === 'pro');

  // Jo, 2026-09-13: pages a homeowner sees wear the roof mark even under /pro;
  // contractor-facing pages under /sites wear the PRO mark. Pinned so a change
  // to who sees what is a deliberate edit to this list, not a drive-by.
  const HOMEOWNER_UNDER_PRO = ['pro/esign.html', 'pro/estimate-view.html', 'pro/invoice-success.html', 'pro/photo-review.html', 'pro/portal.html', 'pro/refer.html', 'pro/sign.html'];
  const PRO_UNDER_SITES = ['sites/free-guide/index.html', 'sites/index.html'];
  for (const p of HOMEOWNER_UNDER_PRO) ok(`${p} → homeowner (override)`, cls(p) === 'homeowner', cls(p));
  for (const p of PRO_UNDER_SITES) ok(`${p} → pro (override)`, cls(p) === 'pro', cls(p));
  const keys = Object.keys(tool.OVERRIDES).sort();
  ok('the override map is exactly those nine pages', JSON.stringify(keys) === JSON.stringify([...HOMEOWNER_UNDER_PRO, ...PRO_UNDER_SITES].sort()), keys.join(', '));
  ok('every override page exists on disk (a stale override is a silent hole)', keys.every((k) => fs.existsSync(path.join(DOCS, k))), keys.filter((k) => !fs.existsSync(path.join(DOCS, k))).join(', '));
}

console.log('\nTHE TREE — every page under docs/, walked from the filesystem');
{
  // Own walker, deliberately with NO skip list: marketing-polish's listHtml
  // skips pro/ and admin/, and admin/** is guarded by no other HTML gate.
  const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (e.name.endsWith('.html')) o.push(p); } return o; };
  const files = walk(DOCS);
  ok('the walk found the whole site, not an empty directory (≥ 280 pages)', files.length >= 280, String(files.length));

  const counts = { homeowner: 0, pro: 0, excluded: 0, skip: 0 };
  const wrong = [], leaks = [];
  for (const f of files) {
    const rel = path.relative(DOCS, f).replace(/\\/g, '/');
    const { audience } = tool.classify(rel);
    counts[audience]++;
    const html = fs.readFileSync(f, 'utf8');
    if (audience === 'homeowner' || audience === 'pro') {
      const tags = tool.iconLinks(html);
      const { icons, extras } = tool.canonFor(audience, rel);
      if (!(tags.length === icons.length && icons.every((t) => tags.includes(t)))) wrong.push(`${rel} [${audience}] has ${tags.length}: ${tags.map(tool.hrefOf).join(' ')}`);
      else if (extras.length && !tool.isCanonical(html, audience, rel)) wrong.push(`${rel} [${audience}] lacks exactly one manifest link + home-screen title`);
      if (extras.length) counts.site = (counts.site || 0) + 1;
    } else if (audience === 'excluded') {
      const bad = tool.iconLinks(html).map(tool.hrefOf).filter((h) => tool.NBD_ICON_HREFS.includes(h));
      if (bad.length) leaks.push(`${rel}: ${bad.join(', ')}`);
    }
  }
  ok(`every homeowner page (${counts.homeowner}) and pro page (${counts.pro}) carries exactly its audience's icon tags (+ manifest and home-screen title on homeowner-site pages)`, wrong.length === 0, wrong.slice(0, 5).join(' | ') + (wrong.length > 5 ? ` … +${wrong.length - 5}` : ''));
  ok('the homeowner-site block is actually in force (≥ 250 pages carry the manifest + title)', (counts.site || 0) >= 250, String(counts.site));
  ok(`no excluded page (${counts.excluded}: Oaks + tenant template) carries an NBD icon href`, leaks.length === 0, leaks.join(' | '));
  ok('both audiences are actually populated (a classifier that sends everything one way would pass the check above)', counts.homeowner >= 200 && counts.pro >= 30, JSON.stringify(counts));
  ok('the excluded set is non-empty (a dead exclusion pattern is a stale rule)', counts.excluded >= 2);
  const stub = path.join(DOCS, 'googlee5b8f461f0f8e74b.html');
  ok('the Google verification stub is byte-for-byte its token', fs.readFileSync(stub, 'utf8') === 'google-site-verification: googlee5b8f461f0f8e74b.html');
  const oaks404 = fs.readFileSync(path.join(DOCS, 'sites/oaks/404.html'), 'utf8');
  ok('the Oaks 404 stays iconless (served for any mistyped /sites/oaks/** URL)', tool.iconLinks(oaks404).length === 0);
}

console.log('\nASSETS — the four icon hrefs resolve to real files of the right kind');
{
  const png = (rel) => { const b = fs.readFileSync(path.join(DOCS, rel)); return { sig: b.slice(0, 8).toString('hex'), chunk: b.slice(12, 16).toString('latin1'), w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
  // Signature + IHDR are not enough, and that is not hypothetical: from #1467
  // (2026-09-07) to 2026-09-13 apple-touch-icon.png carried a valid signature
  // and a valid 180x180 IHDR while its IDAT length was short and its CRC wrong,
  // so browsers decoded the top rows and painted the rest black — the iOS
  // home-screen icon for every homeowner page. Walk every chunk: bounds, CRC,
  // IEND with nothing after it, and IDAT inflating to exactly the declared size.
  const zlib = require('zlib');
  const crc32 = (buf) => { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };
  const pngProblem = (b) => {
    let off = 8, ihdr = null; const idat = [];
    while (off + 12 <= b.length) {
      const len = b.readUInt32BE(off), type = b.slice(off + 4, off + 8).toString('latin1');
      if (!/^[A-Za-z]{4}$/.test(type) || off + 12 + len > b.length) return `chunk at byte ${off} overruns the file or is not a chunk`;
      if (crc32(b.slice(off + 4, off + 8 + len)) !== b.readUInt32BE(off + 8 + len)) return `bad CRC on ${type} at byte ${off}`;
      if (type === 'IHDR') ihdr = { w: b.readUInt32BE(off + 8), h: b.readUInt32BE(off + 12), depth: b[off + 16], ctype: b[off + 17], interlace: b[off + 20] };
      if (type === 'IDAT') idat.push(b.slice(off + 8, off + 8 + len));
      off += 12 + len;
      if (type === 'IEND') return off === b.length ? (ihdr ? inflateProblem(ihdr, idat) : 'no IHDR') : `${b.length - off} byte(s) after IEND`;
    }
    return 'no IEND';
  };
  const inflateProblem = (ihdr, idat) => {
    let raw; try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch (e) { return 'IDAT does not inflate: ' + e.message; }
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.ctype];
    if (ihdr.interlace || !ch) return null;
    const want = (Math.ceil((ihdr.w * ch * ihdr.depth) / 8) + 1) * ihdr.h;
    return raw.length === want ? null : `IDAT inflates to ${raw.length} bytes, IHDR needs ${want}`;
  };
  for (const rel of ['favicon.svg', 'pro/favicon.svg']) {
    const p = path.join(DOCS, rel);
    ok(`/${rel} exists and is SVG markup`, fs.existsSync(p) && fs.readFileSync(p, 'utf8').trimStart().startsWith('<svg'));
  }
  const PNGS = [['assets/images/apple-touch-icon.png', 180], ['assets/images/home-icon-192.png', 192], ['assets/images/home-icon-512.png', 512], ['assets/images/home-icon-maskable-512.png', 512], ['pro/img/nbd-icon-192.png', 192]];
  // The homeowner PNGs are build products of render-apple-touch-icon.js; pin its target table to this list.
  const { TARGETS } = require(path.join(ROOT, 'scripts', 'render-apple-touch-icon.js'));
  ok('render-apple-touch-icon.js renders exactly the four homeowner PNGs at their declared sizes',
    JSON.stringify(TARGETS.map((t) => [path.relative(DOCS, t.out).replace(/\\/g, '/'), t.size])) === JSON.stringify(PNGS.slice(0, 4)),
    JSON.stringify(TARGETS.map((t) => [path.basename(t.out), t.size])));
  ok('…the maskable one from the pack\'s safe-zone (maskable) SVG, the rest from the lettered icon SVG',
    TARGETS.every((t) => path.basename(t.svg) === (/maskable/.test(t.out) ? 'home-solutions-maskable.svg' : 'home-solutions-icon.svg')));
  for (const [rel, dim] of PNGS) {
    const exists = fs.existsSync(path.join(DOCS, rel));
    const m = exists ? png(rel) : {};
    ok(`/${rel} is a PNG`, exists && m.sig === '89504e470d0a1a0a' && m.chunk === 'IHDR');
    ok(`/${rel} is ${dim}×${dim}`, exists && m.w === dim && m.h === dim, `${m.w}x${m.h}`);
    const problem = exists ? pngProblem(fs.readFileSync(path.join(DOCS, rel))) : 'missing';
    ok(`/${rel} is structurally whole (every chunk in bounds with a valid CRC, IDAT inflates to the declared size)`, problem === null, problem);
  }
  ok('the canonical icon tags point at exactly the NBD icon hrefs', JSON.stringify([...tool.CANON.homeowner, ...tool.CANON.pro].map(tool.hrefOf)) === JSON.stringify(tool.NBD_ICON_HREFS));
}

console.log('\nTHE GATE IS A GATE — --check fails on a bad tree and passes once it is fixed');
{
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const r0 = run(['--check']);
  ok('`normalize-favicons.js --check` exits 0 on the committed tree', r0.status === 0, (r0.stderr || r0.stdout).slice(0, 300));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-favicon-'));
  try {
    const put = (rel, html) => { const p = path.join(tmp, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, html); return p; };
    const H = tool.CANON.homeowner, P = tool.CANON.pro;
    put('services/x.html', head(`${P[0]}\r\n${P[1]}\r\n`).replace(/(?<!\r)\n/g, '\r\n'));
    put('pro/y.html', head('<link rel="stylesheet" href="/a.css">\n').replace(/\n/g, '\r\n'));

    const r1 = run(['--check', '--root', tmp]);
    ok('--check exits 1 on a tree with a homeowner page on the PRO pair and a pro page with no icon', r1.status === 1, 'status ' + r1.status);
    ok('…naming both pages', /services\/x\.html/.test(r1.stderr) && /pro\/y\.html/.test(r1.stderr), r1.stderr.slice(0, 300));
    const before = fs.readFileSync(path.join(tmp, 'services/x.html'), 'utf8');
    ok('--check writes nothing', before.includes(P[0]));

    const w = run(['--root', tmp]);
    ok('write mode fixes the tree', w.status === 0, (w.stderr || w.stdout).slice(0, 300));
    ok('--check exits 0 afterwards', run(['--check', '--root', tmp]).status === 0);
    const fixed = fs.readFileSync(path.join(tmp, 'services/x.html'), 'utf8');
    ok('…and the fixed page is CRLF-clean with the homeowner pair', tool.isCanonical(fixed, 'homeowner') && !/(^|[^\r])\n/.test(fixed) && !/\r(?!\n)/.test(fixed));

    const leakHtml = head(`${H[0]}\n`);
    const leak = put('sites/oaks/z.html', leakHtml);
    const r2 = run(['--check', '--root', tmp]);
    ok('--check exits 1 when an excluded (Oaks) page carries an NBD icon', r2.status === 1 && /sites\/oaks\/z\.html/.test(r2.stderr), r2.stderr.slice(0, 300));
    run(['--root', tmp]);
    ok('…and write mode never "fixes" an excluded page (it is left for a human)', fs.readFileSync(leak, 'utf8') === leakHtml);
    fs.unlinkSync(leak);

    const reg = tool.run({ root: tmp, registryChecks: true });
    ok('a registry check against a tree without the override pages reports every override as stale', reg.problems.filter((p) => /stale override/.test(p)).length === Object.keys(tool.OVERRIDES).length, reg.problems.join(' | '));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('\nMANIFEST — two manifests, one per audience, never crossed');
{
  // 2026-09-13: the Pro-branded orphan at docs/manifest.json (scope "/") was
  // deleted. 2026-09-27: the homeowner site got its own manifest at
  // /manifest.webmanifest, with real lettered 192/512/maskable PNGs.
  ok('docs/manifest.json does not exist (scope "/" Pro copy deleted 2026-09-13)', !fs.existsSync(path.join(DOCS, 'manifest.json')));
  const walk = (d, o = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (e.name.endsWith('.html')) o.push(p); } return o; };
  const offenders = [];
  let linkedPro = 0, linkedHome = 0;
  for (const f of walk(DOCS)) {
    const html = fs.readFileSync(f, 'utf8');
    const rel = path.relative(DOCS, f).replace(/\\/g, '/');
    const { audience } = tool.classify(rel);
    for (const tag of html.match(/<link\b[^>]*\brel=["']?manifest\b[^>]*>/gi) || []) {
      const href = tool.hrefOf(tag);
      if (href === '/pro/manifest.json' && rel.startsWith('pro/')) linkedPro++;
      else if (href === '/manifest.webmanifest' && audience === 'homeowner' && !rel.startsWith('pro/')) linkedHome++;
      else offenders.push(`${rel}: ${href}`);
    }
  }
  ok('every rel="manifest" is /pro/manifest.json on a /pro page or /manifest.webmanifest on a homeowner-site page', offenders.length === 0, offenders.join(' | '));
  ok('…and the PRO manifest is still linked somewhere (≥ 1)', linkedPro >= 1);
  ok('…and the homeowner manifest is linked site-wide (≥ 250 pages)', linkedHome >= 250, String(linkedHome));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
