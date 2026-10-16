/**
 * tests/hero-video.test.js — background hero video loops (2026-10-16).
 *
 * WHAT IT PINS
 *  1. The mapping is applied: scripts/hero-video.mjs --check is clean, every
 *     page site-src/data/hero-video.json maps carries the component inside its
 *     hero and the stylesheet in <head>, every clip is used somewhere, and the
 *     job-captioned photo heroes (svc-hero--photo, "see this job") never get a
 *     loop from a different job.
 *  2. Never sound, never autoplay-by-markup: each <video data-hero-video> is
 *     muted, playsinline, preload="none", aria-hidden, has no src/autoplay/
 *     controls attribute, and every media file has exactly one track: video.
 *  3. Reduced motion, Save-Data and 2g get no video: the stylesheet hides it
 *     and the script (run here in a stub DOM) never assigns a src. The normal
 *     path picks AV1 when the browser says "probably", MP4 otherwise, the
 *     portrait cut on portrait phones, and swallows a rejected play().
 *  4. No location or device metadata ships: the committed MP4/WebM/WebP bytes
 *     are parsed (MP4 boxes, WebM EBML elements, WebP RIFF chunks) and only
 *     muxer/encoder tags are allowed — no ©xyz/loci GPS atom, no creation
 *     time, no make/model/serial. If ffprobe is on PATH its tag dump is
 *     checked too (CI may not have it; the byte parse always runs).
 *  5. Each file's name carries its own content hash (the immutable cache on
 *     /assets/video/hero/** depends on it) and firebase.json sets that cache.
 *
 * Zero deps. Run: node tests/hero-video.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const MEDIA = path.join(DOCS, 'assets', 'video', 'hero');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'site-src', 'data', 'hero-video.json'), 'utf8'));
const rules = cfg.rules.map((r) => ({ re: new RegExp(r.pages), clip: r.clip }));
const clipFor = (rel) => (rules.find((r) => r.re.test(rel)) || {}).clip || null;

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!(dir === DOCS && ['pro', 'admin', 'dev'].includes(e.name))) walk(full, out); }
    else if (e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

console.log('\nHERO VIDEO — mapped pages, muted/no-autoplay markup, reduced-motion path, metadata-free media\n');

// ── 1. mapping ──────────────────────────────────────────────────────────────
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'hero-video.mjs'), '--check'], { encoding: 'utf8' });
  ok('scripts/hero-video.mjs --check is clean', r.status === 0, (r.stderr || r.stdout || '').trim().split('\n').slice(0, 5).join(' | '));

  const used = new Set();
  let mapped = 0;
  const wrong = [];
  for (const file of walk(DOCS)) {
    const rel = path.relative(DOCS, file).replace(/\\/g, '/');
    const html = fs.readFileSync(file, 'utf8');
    const clip = clipFor(rel);
    const head = html.slice(0, html.indexOf('</head>'));
    const vids = html.match(/<video[^>]*data-hero-video[^>]*>/g) || [];
    if (!clip) {
      if (vids.length || /hero-video\.css/.test(html)) wrong.push(`${rel}: has a hero video but no rule maps it`);
      continue;
    }
    mapped++; used.add(clip);
    if (vids.length !== 1) { wrong.push(`${rel}: ${vids.length} hero videos`); continue; }
    if (!/<link rel="stylesheet" href="\/assets\/css\/hero-video\.css\?v=\d+">/.test(head)) wrong.push(`${rel}: hero-video.css not linked in <head>`);
    if (!new RegExp(`<div class="hv hv--[a-z]+" data-clip="${clip}">`).test(html)) wrong.push(`${rel}: component is not ${clip}`);
    if (!/<script src="\/assets\/js\/hero-video\.js\?v=\d+" defer><\/script>/.test(html)) wrong.push(`${rel}: hero-video.js not loaded with defer`);
    const hero = html.match(/<section class="(?:hx-hero|combo-hero|city-hero|service-hero)[^"]*"[^>]*>[\s\S]*?<\/section>/);
    if (!hero || !/data-hero-video/.test(hero[0])) wrong.push(`${rel}: the video is not inside the page's hero section`);
    if (/svc-hero--photo/.test(hero ? hero[0].slice(0, 200) : '')) wrong.push(`${rel}: a job-captioned photo hero got a loop`);
  }
  ok(`every mapped page (${mapped}) carries exactly one component, in its hero, with its css+js`, wrong.length === 0 && mapped > 100, wrong.slice(0, 5).join(' | '));
  const unused = Object.keys(cfg.clips).filter((c) => !used.has(c));
  ok('every clip in hero-video.json is shown on at least one page', unused.length === 0, unused.join(', '));
  ok('the homepage shows topdown-install-spin and keeps its crew photo + caption', (() => {
    const h = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
    return /data-clip="topdown-install-spin"/.test(h) && /class="hx-hero-img"/.test(h) && /Our crew &middot; <b>real job<\/b>, not stock/.test(h);
  })());
}

// ── 2. markup: muted, no autoplay, no src ──────────────────────────────────
{
  const partials = fs.readdirSync(path.join(ROOT, 'site-src', 'partials')).filter((n) => n.startsWith('hero-video-'));
  const bad = [];
  for (const n of partials) {
    const body = fs.readFileSync(path.join(ROOT, 'site-src', 'partials', n), 'utf8');
    const tag = (body.match(/<video[\s\S]*?>/) || [''])[0];
    for (const need of [' muted', ' playsinline', ' loop', 'preload="none"', 'aria-hidden="true"', 'tabindex="-1"', 'disablepictureinpicture']) {
      if (!tag.includes(need)) bad.push(`${n}: <video> lacks ${need.trim()}`);
    }
    // The element ships with no source at all: hero-video.js picks one.
    const el = (body.match(/<video[\s\S]*?<\/video>/) || [''])[0];
    for (const never of [/\sautoplay/, /\scontrols/, /\ssrc=/, /<source/]) if (never.test(el)) bad.push(`${n}: <video> has ${never}`);
    if (/style=/.test(body)) bad.push(`${n}: inline style attribute`);
  }
  ok(`all ${partials.length} hero-video partials: muted, playsinline, preload=none, aria-hidden; no autoplay/controls/src/inline style`, bad.length === 0 && partials.length >= 5, bad.join(' | '));

  const js = fs.readFileSync(path.join(DOCS, 'assets', 'js', 'hero-video.js'), 'utf8');
  ok('hero-video.js forces muted and never unmutes or adds controls', /\.muted = true/.test(js) && !/muted\s*=\s*false|\.controls\s*=\s*true|volume\s*=/.test(js));
}

// ── 3. reduced motion / Save-Data / 2g, and source choice (stub DOM) ───────
function runScript(opts) {
  const js = fs.readFileSync(path.join(DOCS, 'assets', 'js', 'hero-video.js'), 'utf8');
  const attrs = {
    'data-src-av1': '/v/720.av1.webm', 'data-src-mp4': '/v/720.mp4',
    'data-src-av1-portrait': '/v/p.av1.webm', 'data-src-mp4-portrait': '/v/p.mp4',
  };
  const listeners = {};
  const video = {
    src: '', muted: false, defaultMuted: false, paused: true, plays: 0,
    classList: { add() {}, remove() {} },
    getAttribute: (k) => attrs[k] || null, hasAttribute: (k) => k in attrs,
    canPlayType: (t) => (/av01/.test(t) && opts.av1 ? 'probably' : ''),
    addEventListener() {},
    play() { this.plays++; this.paused = false; return opts.reject ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve(); },
    pause() { this.paused = true; },
  };
  let ioCb = null;
  const win = {
    matchMedia: (q) => ({
      matches: /reduce/.test(q) ? !!opts.reduce : /portrait/.test(q) ? !!opts.portrait : false,
      addEventListener() {},
    }),
    IntersectionObserver: function (cb) { ioCb = cb; this.observe = () => {}; },
    requestIdleCallback: (cb) => cb(),
    addEventListener: (ev, cb) => { listeners[ev] = cb; },
    innerWidth: 1440, devicePixelRatio: 1,
  };
  const ctx = {
    window: win, navigator: { connection: opts.connection || {} },
    document: { readyState: 'loading', hidden: false, querySelectorAll: () => [video], addEventListener() {} },
    setTimeout: (cb) => cb(), Array, String,
  };
  ctx.window.window = win;
  Object.assign(ctx, { IntersectionObserver: win.IntersectionObserver, matchMedia: win.matchMedia });
  vm.createContext(ctx);
  vm.runInContext(js, ctx);
  if (listeners.load) listeners.load();
  if (ioCb) ioCb([{ isIntersecting: true }]);
  return video;
}
{
  ok('reduced motion: no src is ever assigned', runScript({ reduce: true, av1: true }).src === '');
  ok('Save-Data: no src', runScript({ connection: { saveData: true } }).src === '');
  ok('2g and slow-2g: no src', runScript({ connection: { effectiveType: '2g' } }).src === '' && runScript({ connection: { effectiveType: 'slow-2g' } }).src === '');
  const a = runScript({ av1: true });
  ok('normal path: AV1 720p when canPlayType says probably, muted, play() called', a.src === '/v/720.av1.webm' && a.muted === true && a.plays === 1, a.src);
  ok('no AV1 support: H.264 MP4', runScript({ av1: false }).src === '/v/720.mp4');
  ok('portrait phone: the 720x1280 cut', runScript({ av1: true, portrait: true }).src === '/v/p.av1.webm');
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  runScript({ av1: true, reject: true });
  setTimeout(() => {
    process.off('unhandledRejection', onUnhandled);
    ok('a refused play() is swallowed (poster stays, no unhandled rejection)', !unhandled);
    finish();
  }, 30);

  const css = fs.readFileSync(path.join(DOCS, 'assets', 'css', 'hero-video.css'), 'utf8').replace(/\s+/g, '');
  ok('hero-video.css hides the video under prefers-reduced-motion', /@media\(prefers-reduced-motion:reduce\)\{\.hx-bg\{display:none\}\}/.test(css));
  ok('the video stays transparent until it is actually playing', /\.hx-bg\{[^}]*opacity:0/.test(css) && /\.hx-bg\.is-playing\{opacity:1\}/.test(css));
}

// ── 4 + 5. media bytes ─────────────────────────────────────────────────────
const ALLOWED_TAGS = new Set(['encoder', 'duration', 'language', 'handler_name', 'major_brand', 'minor_version', 'compatible_brands']);

function mp4Problems(buf) {
  const out = [];
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf']);
  const FORBIDDEN = new Set(['©xyz', 'loci', 'uuid', 'meco', 'XMP_', '©mak', '©mod', '©day', 'mdta', 'keys']);
  const handlers = [];
  (function walkBoxes(start, end, depth) {
    let p = start;
    while (p + 8 <= end) {
      let size = buf.readUInt32BE(p);
      const type = buf.toString('latin1', p + 4, p + 8);
      let hdr = 8;
      if (size === 1) { size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16; }
      if (size === 0) size = end - p;
      if (size < hdr || p + size > end) { out.push(`bad box ${JSON.stringify(type)} at ${p}`); return; }
      if (FORBIDDEN.has(type)) out.push(`forbidden box ${type}`);
      if (type === 'hdlr') handlers.push(buf.toString('latin1', p + hdr + 8, p + hdr + 12));
      if (type === 'mvhd' || type === 'tkhd' || type === 'mdhd') {
        // creation/modification time live in these headers, not in tags.
        const v1 = buf[p + hdr] === 1;
        const created = v1 ? buf.readBigUInt64BE(p + hdr + 4) : BigInt(buf.readUInt32BE(p + hdr + 4));
        const modified = v1 ? buf.readBigUInt64BE(p + hdr + 12) : BigInt(buf.readUInt32BE(p + hdr + 8));
        if (created !== 0n || modified !== 0n) out.push(`${type} carries a creation/modification time`);
      }
      if (type === 'ilst') {
        // iTunes-style tags: only the encoder (©too) is allowed.
        for (let q = p + hdr; q + 8 <= p + size;) {
          const s = buf.readUInt32BE(q);
          const t = buf.toString('latin1', q + 4, q + 8);
          if (t !== '©too') out.push('metadata item ' + t);
          if (s < 8) break;
          q += s;
        }
      } else if (type === 'meta') walkBoxes(p + hdr + 4, p + size, depth + 1);
      else if (CONTAINERS.has(type)) walkBoxes(p + hdr, p + size, depth + 1);
      p += size;
    }
  })(0, buf.length, 0);
  const bad = handlers.filter((h) => !['vide', 'mdir'].includes(h));
  if (bad.length) out.push(`non-video track handler(s): ${bad.join(',')}`);
  if (!handlers.includes('vide')) out.push('no video track');
  return out;
}

function webmProblems(buf) {
  const out = [];
  const vint = (p, keepMarker) => {
    const b = buf[p];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(b & mask)) { len++; mask >>= 1; }
    let v = keepMarker ? b : b & (mask - 1);
    for (let i = 1; i < len; i++) v = v * 256 + buf[p + i];
    return { v, len };
  };
  const ids = { SEGMENT: 0x18538067, INFO: 0x1549A966, TRACKS: 0x1654AE6B, TRACKENTRY: 0xAE, TRACKTYPE: 0x83, CODECID: 0x86,
    TAGS: 0x1254C367, TAG: 0x7373, SIMPLETAG: 0x67C8, TAGNAME: 0x45A3, DATEUTC: 0x4461, TITLE: 0x7BA9, ATTACH: 0x1941A469, CHAPTERS: 0x1043A770 };
  const types = [];
  const tagNames = [];
  (function walk(start, end, depth) {
    let p = start;
    while (p < end) {
      const id = vint(p, true); const sz = vint(p + id.len, false);
      const body = p + id.len + sz.len;
      const unknown = sz.v === Math.pow(2, 7 * sz.len) - 1;
      const stop = unknown ? end : Math.min(end, body + sz.v);
      if (id.v === ids.DATEUTC) out.push('DateUTC (creation time) in Info');
      if (id.v === ids.TITLE) out.push('Title in Info');
      if (id.v === ids.ATTACH || id.v === ids.CHAPTERS) out.push('attachments/chapters');
      if (id.v === ids.TRACKTYPE) types.push(buf[body]);
      if (id.v === ids.TAGNAME) tagNames.push(buf.toString('utf8', body, stop));
      if ([ids.SEGMENT, ids.INFO, ids.TRACKS, ids.TRACKENTRY, ids.TAGS, ids.TAG, ids.SIMPLETAG].includes(id.v)) walk(body, stop, depth + 1);
      if (unknown) return;
      p = stop;
    }
  })(0, buf.length, 0);
  if (types.length !== 1 || types[0] !== 1) out.push(`track types ${JSON.stringify(types)} (want exactly one video track)`);
  for (const t of tagNames) if (!ALLOWED_TAGS.has(t.toLowerCase())) out.push(`tag ${t}`);
  return out;
}

function webpProblems(buf) {
  const out = [];
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return ['not a RIFF/WEBP file'];
  for (let p = 12; p + 8 <= buf.length;) {
    const id = buf.toString('latin1', p, p + 4);
    const sz = buf.readUInt32LE(p + 4);
    if (!['VP8 ', 'VP8L', 'VP8X', 'ALPH'].includes(id)) out.push(`chunk ${id}`);
    p += 8 + sz + (sz & 1);
  }
  return out;
}

{
  const files = fs.readdirSync(MEDIA);
  const probs = [];
  let bytes = 0;
  for (const name of files) {
    const buf = fs.readFileSync(path.join(MEDIA, name));
    bytes += buf.length;
    const m = /\.([0-9a-f]{10})\.(mp4|av1\.webm|webp)$/.exec(name);
    if (!m) { probs.push(`${name}: unexpected name`); continue; }
    if (crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10) !== m[1]) probs.push(`${name}: hash in name does not match content`);
    const p = m[2] === 'mp4' ? mp4Problems(buf) : m[2] === 'webp' ? webpProblems(buf) : webmProblems(buf);
    for (const x of p) probs.push(`${name}: ${x}`);
  }
  ok(`byte scan of ${files.length} files (${(bytes / 1048576).toFixed(1)} MB): one video track, no audio, no GPS/creation-time/device tags, hash-named`, probs.length === 0 && files.length > 0, probs.slice(0, 6).join(' | '));
  ok('total hero media stays under the 40 MB budget', bytes < 40 * 1048576, `${(bytes / 1048576).toFixed(1)} MB`);

  const probe = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) {
    const bad = [];
    for (const name of files.filter((n) => !n.endsWith('.webp'))) {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:stream_tags:format_tags', '-of', 'json', path.join(MEDIA, name)], { encoding: 'utf8' });
      const j = JSON.parse(r.stdout || '{}');
      const streams = j.streams || [];
      if (streams.length !== 1 || streams[0].codec_type !== 'video') bad.push(`${name}: streams ${streams.map((s) => s.codec_type).join(',')}`);
      const tags = Object.assign({}, (j.format || {}).tags, ...(streams.map((s) => s.tags || {})));
      for (const k of Object.keys(tags)) if (!ALLOWED_TAGS.has(k.toLowerCase())) bad.push(`${name}: tag ${k}`);
    }
    ok('ffprobe agrees: one video stream, only muxer/encoder tags', bad.length === 0, bad.slice(0, 5).join(' | '));
  } else {
    console.log('  · ffprobe not on PATH — byte scan above is the check');
  }

  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8')).hosting.headers;
  const idx = fb.findIndex((h) => h.source === '/assets/video/hero/**');
  const cc = idx >= 0 && (fb[idx].headers.find((h) => h.key === 'Cache-Control') || {}).value;
  const later = fb.slice(idx + 1).filter((h) => /assets\/(\*\*|@\(.*video|video)/.test(h.source) && h.headers.some((x) => x.key === 'Cache-Control'));
  ok('firebase.json: /assets/video/hero/** is public, one year, immutable — and no later rule overrides it', cc === 'public, max-age=31536000, immutable' && later.length === 0, String(cc));
}

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
}
