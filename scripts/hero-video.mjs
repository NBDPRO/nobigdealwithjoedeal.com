#!/usr/bin/env node
/**
 * hero-video.mjs — background hero video loops, one component on every page
 * that shows one.
 *
 * WHAT IT OWNS
 *   site-src/data/hero-video.json         the page -> loop mapping (edit this)
 *   site-src/partials/hero-video-*.html   RENDERED HERE from the single
 *                                         template below: hero-video-<clip>
 *                                         for every clip, plus
 *                                         hero-video-<clip>-poster for clips
 *                                         with "poster": true
 *   in each mapped page: the <!-- nbd:partial hero-video-… look="…" -->
 *   marker inside its hero, and in <head> the hero-video.css link (plus, on
 *   poster pages, the poster preloads)
 *
 * The markup between the markers is stamped by scripts/apply-partials.js like
 * every other partial (this script runs it after placing markers), so the
 * drift gate there covers the bodies; --check here covers the mapping, the
 * partial files, the <head> tags and the media hashes.
 *
 * POSTER OR NOT. Heroes that already have a background photo (homepage crew
 * photo, combo/city stock photos) keep it: it is preloaded, it is the LCP
 * element, and it stays the no-JS / reduced-motion picture; the loop fades in
 * over it. Only the plain navy service heroes, which had no image, get the
 * loop's own poster (the -poster partial). Its file is ≥ the video's own
 * frame size (1280x720 / 540x960) on purpose: Chrome counts a playing video's
 * first frame as an LCP candidate, and only a strictly LARGER candidate
 * replaces the current one, so an equal-sized poster keeps the LCP at poster
 * time instead of moving it to "video started".
 *
 * Media lives in docs/assets/video/hero/ as <clip>-<variant>.<hash10>.<ext>
 * where hash10 is the first 10 hex of the file's sha256. The name changes when
 * the bytes do, which is what makes firebase.json's one-year immutable cache
 * on /assets/video/hero/** safe. --import copies a fresh encode in under its
 * hashed name (and drops the stale one).
 *
 * Usage:
 *   node scripts/hero-video.mjs                 # render partials, place markers, restamp
 *   node scripts/hero-video.mjs --check         # write nothing; exit 1 on drift
 *   node scripts/hero-video.mjs --import <dir>  # copy <clip>-<variant>.<ext> files in, hashed
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(REPO, 'docs');
const MEDIA_DIR = path.join(DOCS, 'assets', 'video', 'hero');
const MEDIA_URL = '/assets/video/hero/';
const PARTIALS = path.join(REPO, 'site-src', 'partials');
const CONFIG = path.join(REPO, 'site-src', 'data', 'hero-video.json');

// Bump when hero-video.css / hero-video.js change (the 24h /assets/{css,js}
// cache would otherwise serve the old file to repeat visitors).
export const ASSET_VERSION = 1;
export const CSS_HREF = `/assets/css/hero-video.css?v=${ASSET_VERSION}`;
export const JS_SRC = `/assets/js/hero-video.js?v=${ASSET_VERSION}`;
export const PORTRAIT = '(max-width: 600px) and (orientation: portrait)';

const VARIANT = '(1080|720x1280|720|poster-1280|poster-540x960)';
const MEDIA_RE = new RegExp(`^([a-z0-9-]+?)-${VARIANT}\\.([0-9a-f]{10})\\.(mp4|av1\\.webm|webp)$`);
const IMPORT_RE = new RegExp(`^([a-z0-9-]+?)-${VARIANT}\\.(mp4|av1\\.webm|webp)$`);
const SKIP_TOP = new Set(['pro', 'admin', 'dev']);

const CHECK = process.argv.includes('--check');
const IMPORT_AT = process.argv.indexOf('--import');

const sha10 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

/** clip -> { '<variant>.<ext>': url } from the files on disk; hash mismatches are problems. */
export function scanMedia() {
  const byClip = {};
  const problems = [];
  if (!fs.existsSync(MEDIA_DIR)) return { byClip, problems: ['docs/assets/video/hero/ does not exist'] };
  for (const name of fs.readdirSync(MEDIA_DIR).sort()) {
    const m = MEDIA_RE.exec(name);
    if (!m) { problems.push(`unexpected file docs/assets/video/hero/${name} (want <clip>-<variant>.<hash10>.<ext>)`); continue; }
    const [, clip, variant, hash, ext] = m;
    const real = sha10(fs.readFileSync(path.join(MEDIA_DIR, name)));
    if (real !== hash) problems.push(`${name}: name says ${hash} but content hashes to ${real}; re-import it`);
    const key = `${variant}.${ext}`;
    byClip[clip] ??= {};
    if (byClip[clip][key]) problems.push(`${clip}: two files for ${key}`);
    byClip[clip][key] = MEDIA_URL + name;
  }
  return { byClip, problems };
}

const needFrom = (clip, files) => (k) => {
  if (!files[k]) throw new Error(`hero-video: clip "${clip}" has no ${k} under docs/assets/video/hero/`);
  return files[k];
};

/** The ONE template. Every hero-video partial is this with the clip's file names filled in. */
export function renderPartial(clip, files, withPoster) {
  const need = needFrom(clip, files);
  const lines = [`<div class="hv hv--{{look}}" data-clip="${clip}">`];
  if (withPoster) {
    lines.push(`<picture class="hv-poster"><source media="${PORTRAIT}" srcset="${need('poster-540x960.webp')}" type="image/webp"><img src="${need('poster-1280.webp')}" alt="" width="1280" height="720" decoding="async"></picture>`);
  }
  const attrs = [
    `data-src-av1="${need('720.av1.webm')}"`,
    `data-src-mp4="${need('720.mp4')}"`,
    `data-src-av1-portrait="${need('720x1280.av1.webm')}"`,
    `data-src-mp4-portrait="${need('720x1280.mp4')}"`,
  ];
  if (files['1080.mp4'] || files['1080.av1.webm']) {
    attrs.push(`data-src-av1-1080="${need('1080.av1.webm')}"`, `data-src-mp4-1080="${need('1080.mp4')}"`);
  }
  lines.push(`<video class="hx-bg" muted playsinline loop preload="none" aria-hidden="true" tabindex="-1" disablepictureinpicture disableremoteplayback data-hero-video`);
  for (const a of attrs) lines.push(`  ${a}`);
  lines[lines.length - 1] += '></video>';
  lines.push('</div>');
  lines.push(`<script src="${JS_SRC}" defer></script>`);
  return lines.join('\n') + '\n';
}

// Where the marker goes in each hero family. `look` picks the scrim in
// hero-video.css. `poster`: the family has no background image of its own.
const HEROES = [
  { look: 'home', poster: false, open: /<section class="hx-hero"[^>]*>/, after: /^[ \t]*<picture>.*<\/picture>[ \t]*$/m },
  { look: 'combo', poster: false, open: /<section class="combo-hero">/, after: /^[ \t]*<div class="combo-hero-bg"><\/div>[ \t]*$/m },
  { look: 'city', poster: false, open: /<section class="city-hero">/, after: /^[ \t]*<div class="city-hero-bg"><\/div>[ \t]*$/m },
  // Plain service heroes only: svc-hero--photo heroes carry a job photo and a
  // "see this job" caption that a different job's loop would contradict.
  { look: 'svc', poster: true, open: /<section class="service-hero(?: svc-hero)?">/, after: null },
];

const REGION_ANY = /^[ \t]*<!--\s*nbd:partial hero-video-[a-z0-9-]+[^>]*-->\r?\n[\s\S]*?<!--\s*\/nbd:partial hero-video-[a-z0-9-]+\s*-->[ \t]*\r?\n/gm;
const CSS_LINK_ANY = /^[ \t]*<link rel="stylesheet" href="\/assets\/css\/hero-video\.css[^"]*">[ \t]*\r?\n/gm;
const PRELOAD_ANY = /^[ \t]*<link rel="preload" as="image" href="\/assets\/video\/hero\/[^"]*"[^>]*>[ \t]*\r?\n/gm;

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  cfg.rules = cfg.rules.map((r) => ({ ...r, re: new RegExp(r.pages) }));
  for (const r of cfg.rules) if (!cfg.clips[r.clip]) throw new Error(`hero-video.json: rule ${r.pages} names unknown clip ${r.clip}`);
  return cfg;
}

export function clipFor(cfg, rel) {
  const hit = cfg.rules.find((r) => r.re.test(rel));
  return hit ? hit.clip : null;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!(dir === DOCS && SKIP_TOP.has(e.name))) walk(full, out); }
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

/**
 * Desired page text (LF in; the caller restores the file's EOL). Throws when
 * a mapped page has no hero that can hold the video, or needs a poster the
 * clip does not have — a mapping must never silently miss a page.
 */
export function placeInPage(lf, clip, rel, cfg, files) {
  let text = lf.replace(REGION_ANY, '').replace(CSS_LINK_ANY, '').replace(PRELOAD_ANY, '');
  if (!clip) return text;
  const hero = HEROES.find((h) => h.open.test(text));
  if (!hero) throw new Error(`${rel}: mapped to ${clip} but has no supported hero section`);
  if (hero.poster && !cfg.clips[clip].poster) throw new Error(`${rel}: a ${hero.look} hero needs a poster but ${clip} has "poster": false`);
  const openIdx = text.search(hero.open);
  const openEnd = text.indexOf('\n', openIdx) + 1;
  let at = openEnd;
  if (hero.after) {
    const rest = text.slice(openEnd);
    const m = hero.after.exec(rest);
    // The anchor must be inside this hero (within its first few lines).
    if (!m || rest.slice(0, m.index).split('\n').length > 3) throw new Error(`${rel}: ${hero.look} hero has no anchor line for the video`);
    at = openEnd + m.index + m[0].length + 1;
  }
  const name = `hero-video-${clip}${hero.poster ? '-poster' : ''}`;
  text = text.slice(0, at) + `  <!-- nbd:partial ${name} look="${hero.look}" -->\n  <!-- /nbd:partial ${name} -->\n` + text.slice(at);

  const headEnd = text.indexOf('</head>');
  if (headEnd < 0) throw new Error(`${rel}: no </head>`);
  const closeLine = text.lastIndexOf('\n', headEnd) + 1;
  text = text.slice(0, closeLine) + `<link rel="stylesheet" href="${CSS_HREF}">\n` + text.slice(closeLine);
  if (hero.poster) {
    // The poster is this hero's LCP image: preload it ahead of the
    // stylesheets, one per orientation (media-gated so only one is fetched),
    // like the combo/city pages already preload their stock photo.
    const need = needFrom(clip, files);
    const firstCss = text.search(/^[ \t]*<link rel="stylesheet"/m);
    if (firstCss < 0 || firstCss > headEnd) throw new Error(`${rel}: no stylesheet link in <head> to anchor the poster preload`);
    const tags = `<link rel="preload" as="image" href="${need('poster-1280.webp')}" type="image/webp" fetchpriority="high" media="not all and ${PORTRAIT}">\n`
      + `<link rel="preload" as="image" href="${need('poster-540x960.webp')}" type="image/webp" fetchpriority="high" media="${PORTRAIT}">\n`;
    text = text.slice(0, firstCss) + tags + text.slice(firstCss);
  }
  return text;
}

/** Compare ignoring the generated bodies (apply-partials owns those). */
const skeleton = (t) => t.replace(/(<!--\s*nbd:partial (hero-video-[a-z0-9-]+)[^>]*-->\n)[\s\S]*?(<!--\s*\/nbd:partial \2\s*-->)/g, '$1$3');

function doImport(dir) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = IMPORT_RE.exec(name);
    if (!m) continue;
    const [, clip, variant, ext] = m;
    const buf = fs.readFileSync(path.join(dir, name));
    for (const old of fs.readdirSync(MEDIA_DIR)) {
      const o = MEDIA_RE.exec(old);
      if (o && o[1] === clip && o[2] === variant && o[4] === ext) fs.unlinkSync(path.join(MEDIA_DIR, old));
    }
    fs.writeFileSync(path.join(MEDIA_DIR, `${clip}-${variant}.${sha10(buf)}.${ext}`), buf);
    n++;
  }
  console.log(`hero-video --import: ${n} file(s) copied into docs/assets/video/hero/`);
}

function main() {
  if (IMPORT_AT > 0) doImport(path.resolve(process.argv[IMPORT_AT + 1]));
  const cfg = loadConfig();
  const { byClip, problems } = scanMedia();
  const drift = [...problems];

  // 1. partials
  const wantPartials = new Map();
  for (const [clip, spec] of Object.entries(cfg.clips)) {
    try {
      wantPartials.set(`hero-video-${clip}.html`, renderPartial(clip, byClip[clip] || {}, false));
      if (spec.poster) wantPartials.set(`hero-video-${clip}-poster.html`, renderPartial(clip, byClip[clip] || {}, true));
    } catch (e) { drift.push(e.message); }
  }
  for (const name of fs.readdirSync(PARTIALS).filter((n) => n.startsWith('hero-video-'))) {
    if (!wantPartials.has(name)) {
      if (CHECK) drift.push(`site-src/partials/${name}: not rendered from hero-video.json`); else fs.unlinkSync(path.join(PARTIALS, name));
    }
  }
  for (const [name, body] of wantPartials) {
    const p = path.join(PARTIALS, name);
    const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n') : null;
    if (have !== body) { if (CHECK) drift.push(`site-src/partials/${name} differs from the template`); else fs.writeFileSync(p, body); }
  }
  for (const clip of Object.keys(byClip)) if (!cfg.clips[clip]) drift.push(`docs/assets/video/hero/: files for ${clip}, which hero-video.json does not list`);
  for (const [clip, spec] of Object.entries(cfg.clips)) {
    const files = byClip[clip] || {};
    if (!spec.poster && (files['poster-1280.webp'] || files['poster-540x960.webp'])) drift.push(`docs/assets/video/hero/: ${clip} has poster files but "poster": false (dead weight)`);
  }

  // 2. pages
  const counts = {};
  for (const file of walk(DOCS)) {
    const rel = path.relative(DOCS, file).replace(/\\/g, '/');
    const raw = fs.readFileSync(file, 'utf8');
    const clip = clipFor(cfg, rel);
    if (!clip && !raw.includes('hero-video')) continue;
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const lf = raw.replace(/\r\n/g, '\n');
    let want;
    try { want = placeInPage(lf, clip, rel, cfg, clip ? byClip[clip] || {} : {}); } catch (e) { drift.push(e.message); continue; }
    if (clip) counts[clip] = (counts[clip] || 0) + 1;
    if (skeleton(want) === skeleton(lf)) continue;
    if (CHECK) { drift.push(`docs/${rel}: hero video marker or <head> tags are not what hero-video.json says (${clip || 'none'})`); continue; }
    fs.writeFileSync(file, eol === '\n' ? want : want.replace(/\n/g, '\r\n'));
  }

  if (drift.length) {
    for (const d of drift) console.error('✗ ' + d);
    console.error(`\nhero-video: ${drift.length} problem(s). Run: node scripts/hero-video.mjs (then commit the partials and pages).`);
    process.exit(1);
  }
  const summary = Object.entries(counts).map(([c, n]) => `${c}=${n}`).join(' ');
  if (CHECK) { console.log(`hero-video --check: clean (${summary})`); return; }
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'apply-partials.js')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  console.log(`hero-video: placed (${summary})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
