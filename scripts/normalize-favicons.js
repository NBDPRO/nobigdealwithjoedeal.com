#!/usr/bin/env node
/**
 * scripts/normalize-favicons.js — two icons across the whole site, by audience.
 *
 * WHY (2026-09-13)
 * ────────────────
 * Jo: "make the homeowner facing pages all have the same favicon and same for
 * the pro pages. only two across every page." Before this script the tree
 * carried the homeowner roof mark on 31 of the 36 /pro pages (while 23 of them
 * used the NBD PRO apple-touch icon — two different marks on one page), the
 * NBD PRO favicon on exactly one page (pro/photo-review.html, which is
 * homeowner-facing), no icon at all on 13 pages (the admin console, /tools,
 * /sites, four /pro signing/referral pages), and 17 homeowner pages with a
 * favicon but no apple-touch icon. Favicons are hand-inlined per page — no
 * <head> partial exists (site-src/partials is body chrome only), so
 * apply-partials cannot own them. This script does. Evidence and the audit
 * that preceded it: documentation/audit/GROKBOT-BRIEF-VERIFICATION-2026-09-13.md §3.4
 * and documentation/audit/FAVICON-NORMALIZATION-2026-09-13.md.
 *
 * THE RULE — by PATH, then a short override map. No page allowlist.
 * ─────────────────────────────────────────────────────────────────
 *   skip       googlee<hex>.html — Search Console verification token, no <head>.
 *              Never edited: a changed byte risks losing verification.
 *   excluded   sites/oaks/**  — Scott's Oaks microsite, a portable hand-off
 *              deliverable with its own relative icon. sites/t/** — the
 *              universal tenant template; identity is injected per tenant, so
 *              an NBD icon here is a cross-tenant leak. Excluded pages are
 *              NEVER written, and --check FAILS if one carries an NBD icon href.
 *              sites/oaks/404.html stays iconless on purpose: it is served by
 *              the /sites/oaks/** rewrite (firebase.json) for any mistyped URL,
 *              so a relative href resolves against the bogus path and a
 *              site-absolute one puts NBD's mark on a client's 404.
 *   pro        pro/**, admin/**, tools/** — the CRM, the admin console, the
 *              internal ops hub.
 *   homeowner  everything else.
 *   OVERRIDES  pages whose audience is not their directory's — see below. A
 *              new page under pro/ defaults to PRO; if a homeowner will see
 *              it, add ONE line here with the reason.
 *
 * WHAT A NORMALIZED PAGE LOOKS LIKE
 * ─────────────────────────────────
 * (2026-09-13 wording; homeowner-site pages now carry the six-line block in
 * the section below.)
 * Exactly two icon <link> tags — the canonical pair for its audience, byte-for-
 * byte (the homeowner strings are the ones 256 pages already carried, so those
 * pages are no-ops). Every other rel=icon / shortcut icon / apple-touch-icon /
 * apple-touch-icon-precomposed / mask-icon tag is removed. The pair goes where
 * the first removed tag was (same indentation), or, on a page with none, on
 * the line after <title>…</title>, or failing that immediately before </head>.
 *
 * LARGE CONTEXTS GET THE LETTERED MARK (2026-09-27)
 * ─────────────────────────────────────────────────
 * Jo's iPhone test: Safari's home-screen icon and Google's result favicon
 * showed the lettered NBD mark, but a Brave saved-site tile showed the
 * wordless roofline — Brave ignores apple-touch-icon and picks from rel="icon",
 * where favicon.svg was the only candidate. Homeowner-SITE pages (homeowner
 * audience, not under pro/) now carry a six-line block instead of the pair:
 *   favicon.svg (unchanged — the small tab mark stays the wordless roofline),
 *   apple-touch-icon with sizes="180x180",
 *   rel="icon" PNGs at 192 and 512 (the lettered mark; large-tile consumers
 *     choose the biggest sized icon, tabs keep the SVG),
 *   rel="manifest" → /manifest.webmanifest (the homeowner web-app manifest),
 *   <meta name="apple-mobile-web-app-title" content="No Big Deal"> (the
 *     home-screen label; without it iOS truncates the full <title>).
 * The manifest link and the title meta are owned here too: on a homeowner-
 * site page any other rel=manifest / apple-mobile-web-app-title is replaced.
 * Homeowner-audience pages INSIDE the CRM app (the pro/ OVERRIDES above) keep
 * the original pair and gain no manifest — docs/pro is the CRM lane's tree
 * and ships its own /pro/manifest.json; flip that in canonFor() if wanted.
 * The PNGs are build products of scripts/render-apple-touch-icon.js.
 *
 * LINE ENDINGS (CLAUDE.md) — the tree is CRLF. Lines are split on the file's
 * own EOL and rejoined with it once; inserted lines carry no EOL of their own;
 * the result is asserted to contain no lone CR (0x0D not followed by 0x0A)
 * and no bare LF in a CRLF file before anything is written.
 *
 * Usage:
 *   node scripts/normalize-favicons.js           # write
 *   node scripts/normalize-favicons.js --check   # CI gate, no writes, exit 1 on drift
 *   node scripts/normalize-favicons.js --list    # print rel / audience / reason
 *   node scripts/normalize-favicons.js --root <dir>   # alternate docs root (tests)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DOCS = path.join(__dirname, '..', 'docs');

const HOMEOWNER_ICON = '<link rel="icon" href="/favicon.svg" type="image/svg+xml">';
const HOMEOWNER_TOUCH = '<link rel="apple-touch-icon" href="/assets/images/apple-touch-icon.png" sizes="180x180">';
const HOMEOWNER_ICON_192 = '<link rel="icon" type="image/png" sizes="192x192" href="/assets/images/home-icon-192.png">';
const HOMEOWNER_ICON_512 = '<link rel="icon" type="image/png" sizes="512x512" href="/assets/images/home-icon-512.png">';
// The original pair, kept by homeowner-audience pages inside docs/pro (see header).
const HOMEOWNER_TOUCH_IN_PRO = '<link rel="apple-touch-icon" href="/assets/images/apple-touch-icon.png">';
const PRO_ICON = '<link rel="icon" href="/pro/favicon.svg" type="image/svg+xml">';
const PRO_TOUCH = '<link rel="apple-touch-icon" href="/pro/img/nbd-icon-192.png">';
const HOMEOWNER_MANIFEST = '<link rel="manifest" href="/manifest.webmanifest">';
const HOMEOWNER_APP_TITLE = '<meta name="apple-mobile-web-app-title" content="No Big Deal">';

const CANON = {
  homeowner: [HOMEOWNER_ICON, HOMEOWNER_TOUCH, HOMEOWNER_ICON_192, HOMEOWNER_ICON_512],
  pro: [PRO_ICON, PRO_TOUCH],
};
const HOMEOWNER_IN_PRO = [HOMEOWNER_ICON, HOMEOWNER_TOUCH_IN_PRO];
const HOMEOWNER_EXTRAS = [HOMEOWNER_MANIFEST, HOMEOWNER_APP_TITLE];

// The hrefs that identify an NBD icon. An excluded page carrying any of
// them in an icon <link> is a cross-brand leak.
const NBD_ICON_HREFS = ['/favicon.svg', '/assets/images/apple-touch-icon.png', '/assets/images/home-icon-192.png', '/assets/images/home-icon-512.png', '/pro/favicon.svg', '/pro/img/nbd-icon-192.png'];

/**
 * The tags a page must carry, by audience and path.
 *   icons  — the exact set of icon <link> tags
 *   extras — the manifest link + home-screen title meta (homeowner site only)
 * rel omitted → treated as a page outside pro/.
 */
function canonFor(audience, rel = '') {
  if (!CANON[audience]) throw new Error('canonFor: audience must be homeowner or pro, got ' + audience);
  if (audience === 'pro') return { icons: CANON.pro, extras: [] };
  if (String(rel).replace(/\\/g, '/').startsWith('pro/')) return { icons: HOMEOWNER_IN_PRO, extras: [] };
  return { icons: CANON.homeowner, extras: HOMEOWNER_EXTRAS };
}

const SKIP = [
  { re: /^googlee?[0-9a-f]+\.html$/, reason: 'Search Console verification token (no <head>) — never edited' },
];

const EXCLUDED = [
  { re: /^sites\/oaks\//, reason: 'Oaks client microsite — third-party brand, portable hand-off with its own icon' },
  { re: /^sites\/t\//, reason: 'tenant template — identity injected per tenant; an NBD icon is a cross-tenant leak' },
];

const PRO_DIRS = /^(pro|admin|tools)\//;

// One line per page whose audience is not its directory's. Jo, 2026-09-13.
const OVERRIDES = {
  'sites/index.html': { audience: 'pro', reason: 'contractor-websites offering page (B2B audience)' },
  'sites/free-guide/index.html': { audience: 'pro', reason: 'contractor lead magnet (B2B audience)' },
  'pro/portal.html': { audience: 'homeowner', reason: 'homeowner project portal' },
  'pro/estimate-view.html': { audience: 'homeowner', reason: 'homeowner itemized estimate viewer, linked from the portal' },
  'pro/photo-review.html': { audience: 'homeowner', reason: 'homeowner photo review (nbd-brand.css surface)' },
  'pro/sign.html': { audience: 'homeowner', reason: 'homeowner remote-signing page' },
  'pro/esign.html': { audience: 'homeowner', reason: 'homeowner PDF envelope signing page' },
  'pro/refer.html': { audience: 'homeowner', reason: 'homeowner referral form, reached from the portal' },
  'pro/invoice-success.html': { audience: 'homeowner', reason: 'homeowner lands here after paying an invoice (functions/stripe.js success_url)' },
};

const ICON_RELS = new Set(['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon']);
const LINK_RE = /<link\b[^>]*>/gi;
const TAG_RE = /<(?:link|meta)\b[^>]*>/gi;

function relTokens(tag) {
  const m = tag.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!m) return [];
  return (m[1] ?? m[2] ?? m[3]).toLowerCase().split(/\s+/).filter(Boolean);
}

function hrefOf(tag) {
  const m = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

/** True when a <link> tag is an icon tag ("shortcut icon" matches on "icon"). */
function isIconLink(tag) {
  return relTokens(tag).some((r) => ICON_RELS.has(r));
}

/** Every icon <link> tag in the page, in document order. */
function iconLinks(html) {
  return (html.match(LINK_RE) || []).filter(isIconLink);
}

/** rel="manifest" <link> tags. */
function isManifestLink(tag) {
  return /^<link\b/i.test(tag) && relTokens(tag).includes('manifest');
}
function manifestLinks(html) {
  return (html.match(LINK_RE) || []).filter(isManifestLink);
}

/** <meta name="apple-mobile-web-app-title"> tags. */
function isAppTitleMeta(tag) {
  return /^<meta\b/i.test(tag) && /\bname\s*=\s*["']?apple-mobile-web-app-title["'\s>]/i.test(tag);
}
function appTitleMetas(html) {
  return (html.match(/<meta\b[^>]*>/gi) || []).filter(isAppTitleMeta);
}

/** A tag this script owns on a page whose canon carries extras (or not). */
function isOwnedTag(tag, withExtras) {
  if (/^<link\b/i.test(tag) && isIconLink(tag)) return true;
  return withExtras && (isManifestLink(tag) || isAppTitleMeta(tag));
}

/**
 * Classify a docs-relative path (forward slashes).
 * Returns { audience: 'homeowner'|'pro'|'excluded'|'skip', reason }.
 */
function classify(rel) {
  rel = rel.replace(/\\/g, '/');
  for (const s of SKIP) if (s.re.test(rel)) return { audience: 'skip', reason: s.reason };
  for (const x of EXCLUDED) if (x.re.test(rel)) return { audience: 'excluded', reason: x.reason };
  if (OVERRIDES[rel]) return { audience: OVERRIDES[rel].audience, reason: 'override: ' + OVERRIDES[rel].reason };
  if (PRO_DIRS.test(rel)) return { audience: 'pro', reason: 'under ' + rel.split('/')[0] + '/' };
  return { audience: 'homeowner', reason: 'default' };
}

function eolOf(html) {
  return html.includes('\r\n') ? '\r\n' : '\n';
}

function assertCleanEol(out, eol, label) {
  if (/\r(?!\n)/.test(out)) throw new Error(`normalize-favicons: lone CR produced in ${label} — refusing to write`);
  if (eol === '\r\n' && /(^|[^\r])\n/.test(out)) throw new Error(`normalize-favicons: bare LF produced in CRLF file ${label} — refusing to write`);
}

/** Exactly the tags in `want` (any order), each once. */
function exactSet(found, want) {
  return found.length === want.length && want.every((t) => found.includes(t)) && new Set(found).size === found.length;
}

/**
 * True when the page carries exactly its canonical icon tags (any order) and,
 * on a homeowner-site page, exactly one manifest link and one home-screen
 * title meta, both canonical. rel omitted → a page outside pro/.
 */
function isCanonical(html, audience, rel = '') {
  const { icons, extras } = canonFor(audience, rel);
  if (!exactSet(iconLinks(html), icons)) return false;
  if (!extras.length) return true;
  return exactSet(manifestLinks(html), [HOMEOWNER_MANIFEST]) && exactSet(appTitleMetas(html), [HOMEOWNER_APP_TITLE]);
}

/**
 * Pure transform. Returns { html, changed, refused, reason }.
 *   refused — the page does not have exactly one </head> (nothing is changed).
 * rel (docs-relative path) decides the homeowner variant; omitted → outside pro/.
 */
function normalizeIcons(html, audience, label = '(page)', rel = '') {
  if (!CANON[audience]) throw new Error('normalizeIcons: audience must be homeowner or pro, got ' + audience);
  const heads = (html.match(/<\/head>/gi) || []).length;
  if (heads !== 1) return { html, changed: false, refused: true, reason: `${heads} </head> tags (need exactly 1)` };
  if (isCanonical(html, audience, rel)) return { html, changed: false, refused: false };

  const eol = eolOf(html);
  const lines = html.split(eol);
  const headLine = lines.findIndex((l) => /<\/head>/i.test(l));
  const { icons, extras } = canonFor(audience, rel);
  const pair = [...icons, ...extras];

  let insertAt = -1;
  let indent = '';
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > headLine) { out.push(line); continue; }
    const tags = (line.match(TAG_RE) || []).filter((t) => isOwnedTag(t, extras.length > 0));
    if (!tags.length) { out.push(line); continue; }
    let rest = line;
    for (const t of tags) rest = rest.replace(t, '');
    if (insertAt < 0) {
      insertAt = out.length;
      indent = (line.match(/^[ \t]*/) || [''])[0];
    }
    if (rest.trim() !== '') out.push(rest);
  }

  if (insertAt < 0) {
    const titleIdx = out.findIndex((l, i) => i <= headLine && /<\/title>/i.test(l) && !/<\/head>/i.test(l));
    if (titleIdx >= 0) {
      insertAt = titleIdx + 1;
      indent = (out[titleIdx].match(/^[ \t]*/) || [''])[0];
    } else {
      const h = out.findIndex((l) => /<\/head>/i.test(l));
      const hl = out[h];
      const col = hl.search(/<\/head>/i);
      if (col > 0 && hl.slice(0, col).trim() !== '') {
        // </head> shares a line with other content: split it off so the pair lands before it.
        out.splice(h, 1, hl.slice(0, col), hl.slice(col));
        insertAt = h + 1;
      } else {
        insertAt = h;
      }
      indent = '';
    }
  }

  out.splice(insertAt, 0, ...pair.map((t) => indent + t));
  const next = out.join(eol);
  assertCleanEol(next, eol, label);
  if (!isCanonical(next, audience, rel)) throw new Error(`normalizeIcons: post-condition failed for ${label}`);
  return { html: next, changed: next !== html, refused: false };
}

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
      walk(p, out);
    } else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/**
 * Scan a docs root. Pure with respect to the filesystem unless write=true.
 * registryChecks — also fail on a stale OVERRIDES entry or an EXCLUDED
 * pattern that matches nothing. On by default for the real tree; off for a
 * scratch fixture root, which naturally lacks those pages.
 */
function run({ root = DEFAULT_DOCS, write = false, registryChecks = root === DEFAULT_DOCS } = {}) {
  const files = walk(root).sort();
  const result = { pages: files.length, written: [], drift: [], refused: [], leaks: [], unchanged: 0, excluded: 0, skipped: 0, byAudience: { homeowner: 0, pro: 0, excluded: 0, skip: 0 }, problems: [] };
  const rels = files.map((f) => path.relative(root, f).replace(/\\/g, '/'));

  for (let i = 0; i < files.length; i++) {
    const rel = rels[i];
    const { audience } = classify(rel);
    result.byAudience[audience]++;
    if (audience === 'skip') { result.skipped++; continue; }
    const html = fs.readFileSync(files[i], 'utf8');
    if (audience === 'excluded') {
      result.excluded++;
      const bad = iconLinks(html).map(hrefOf).filter((h) => NBD_ICON_HREFS.includes(h));
      bad.push(...manifestLinks(html).map(hrefOf).filter((h) => h === '/manifest.webmanifest'));
      if (bad.length) result.leaks.push(`${rel} carries NBD icon href(s): ${bad.join(', ')}`);
      continue;
    }
    const r = normalizeIcons(html, audience, rel, rel);
    if (r.refused) { result.refused.push(`${rel} (${r.reason})`); continue; }
    if (!r.changed) { result.unchanged++; continue; }
    result.drift.push(`${rel} [${audience}]`);
    if (write) { fs.writeFileSync(files[i], r.html); result.written.push(rel); }
  }

  // Stale rules fail loudly — a guard defeated by its own list is how four
  // gates in this repo went quiet (scripts/check-chrome-governance.js header).
  if (registryChecks) {
    for (const p of Object.keys(OVERRIDES)) {
      if (!rels.includes(p)) result.problems.push(`stale override: ${p} does not exist under ${path.basename(root)}/`);
    }
    for (const x of EXCLUDED) {
      if (!rels.some((r) => x.re.test(r))) result.problems.push(`stale exclusion: ${x.re} matches no page`);
    }
  }
  return result;
}

function main(argv) {
  const check = argv.includes('--check');
  const list = argv.includes('--list');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(argv[rootIdx + 1]) : DEFAULT_DOCS;

  if (list) {
    for (const f of walk(root).sort()) {
      const rel = path.relative(root, f).replace(/\\/g, '/');
      const c = classify(rel);
      console.log(`${c.audience.padEnd(9)}  ${rel}  — ${c.reason}`);
    }
    return 0;
  }

  const r = run({ root, write: !check });
  const failures = [...r.refused.map((x) => 'no single </head>: ' + x), ...r.leaks, ...r.problems];
  if (check) {
    if (r.drift.length || failures.length) {
      console.error(`normalize-favicons --check: ${r.drift.length} page(s) out of contract, ${failures.length} other problem(s).`);
      for (const d of r.drift) console.error('  - ' + d);
      for (const f of failures) console.error('  ! ' + f);
      if (r.drift.length) console.error('Run: node scripts/normalize-favicons.js');
      return 1;
    }
    console.log(`normalize-favicons --check: all ${r.pages - r.skipped - r.excluded} in-scope pages carry exactly their audience's icon tags (${r.byAudience.homeowner} homeowner — the site's with the manifest + home-screen title — ${r.byAudience.pro} pro; ${r.excluded} excluded, ${r.skipped} skipped).`);
    return 0;
  }
  console.log(JSON.stringify({ written: r.written.length, unchanged: r.unchanged, excluded: r.excluded, skipped: r.skipped, byAudience: r.byAudience, refused: r.refused, leaks: r.leaks, problems: r.problems }, null, 2));
  for (const w of r.written) console.log('  wrote ' + w);
  return failures.length ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  classify, normalizeIcons, isCanonical, iconLinks, manifestLinks, appTitleMetas, hrefOf, run, walk, canonFor,
  CANON, OVERRIDES, EXCLUDED, SKIP, NBD_ICON_HREFS, HOMEOWNER_IN_PRO, HOMEOWNER_EXTRAS,
  HOMEOWNER_ICON, HOMEOWNER_TOUCH, HOMEOWNER_ICON_192, HOMEOWNER_ICON_512, HOMEOWNER_TOUCH_IN_PRO,
  HOMEOWNER_MANIFEST, HOMEOWNER_APP_TITLE, PRO_ICON, PRO_TOUCH,
};
