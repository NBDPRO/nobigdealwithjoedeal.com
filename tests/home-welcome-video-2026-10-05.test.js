/**
 * tests/home-welcome-video-2026-10-05.test.js — the homepage "Meet Thursday"
 * welcome video (Jo, 2026-10-05).
 *
 * The old #intro-video slot waited for a YouTube ID and never shipped. It is
 * now a self-hosted 30-second look at the free inspection, presented by
 * Thursday (NBD's assistant presenter). Pins:
 *   - exactly one <video> in #intro-video, with controls + playsinline +
 *     preload="none" + a poster, and NO autoplay / muted / loop;
 *   - a WebVTT captions <track>. The web copy has NO burned-in captions
 *     (Remotion re-finish, 2026-10-06), so the track is the only caption
 *     layer: CC button, screen readers, and no doubled-up text;
 *   - width/height attributes, so the box is reserved before anything loads
 *     (CLS 0), and a plain visible label;
 *   - every referenced file exists under docs/assets/, the mp4 is web-sized
 *     (< 4 MB) and faststart (moov before mdat, so it starts on play without
 *     a full download), the VTT is real WebVTT, the poster is a WebP with no
 *     EXIF/XMP chunk;
 *   - the site CSP still admits same-origin media (media-src 'self').
 *
 * Swapping the video = replace the three files and bump ?v= in the one
 * <video> block in docs/index.html.
 *
 * Run: node tests/home-welcome-video-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('HOME WELCOME VIDEO');
const html = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');
const sec = (/<section[^>]*id="intro-video"[\s\S]*?<\/section>/.exec(html) || [''])[0];
ok('#intro-video section exists and is not hidden', sec.length > 0 && !/<section[^>]*\bhidden\b/.test(sec.slice(0, sec.indexOf('>') + 1)));
const videos = sec.match(/<video\b[^>]*>/g) || [];
ok('exactly one <video> in the section', videos.length === 1, String(videos.length));
const tag = videos[0] || '';
const attr = (t, n) => { const m = new RegExp('\\s' + n + '(?:="([^"]*)")?(?=[\\s>])').exec(t); return m ? (m[1] == null ? '' : m[1]) : null; };
ok('controls + playsinline', attr(tag, 'controls') !== null && attr(tag, 'playsinline') !== null, tag);
ok('preload="none"', attr(tag, 'preload') === 'none', tag);
ok('no autoplay, no muted, no loop', attr(tag, 'autoplay') === null && attr(tag, 'muted') === null && attr(tag, 'loop') === null, tag);
ok('width/height reserve a 9:16 box', attr(tag, 'width') === '540' && attr(tag, 'height') === '960', tag);
ok('no YouTube left in the slot', !/youtube|data-yt/i.test(sec));
ok('plain visible label "Meet Thursday"', />\s*Meet Thursday\s*</.test(sec));

const local = (u) => path.join(DOCS, String(u || '').split('?')[0]);
const poster = attr(tag, 'poster');
const src = ((/<source\b[^>]*\ssrc="([^"]+)"[^>]*type="video\/mp4"/.exec(sec)) || [])[1];
const trackTag = (sec.match(/<track\b[^>]*>/g) || [])[0] || '';
ok('captions <track kind="captions" srclang="en">', attr(trackTag, 'kind') === 'captions' && attr(trackTag, 'srclang') === 'en', trackTag);
const vtt = attr(trackTag, 'src');
ok('all three files are same-origin /assets/ paths',
  [poster, src, vtt].every((u) => /^\/assets\/(img|video)\/[A-Za-z0-9._-]+(\?v=\d+)?$/.test(String(u))), [poster, src, vtt].join(' '));

if (src && fs.existsSync(local(src))) {
  const buf = fs.readFileSync(local(src));
  ok('mp4 is web-sized (< 4 MB)', buf.length < 4 * 1024 * 1024, buf.length + ' bytes');
  const moov = buf.indexOf('moov'), mdat = buf.indexOf('mdat');
  ok('mp4 is faststart (moov before mdat)', moov > 0 && mdat > 0 && moov < mdat, moov + ' / ' + mdat);
} else ok('mp4 exists', false, src);

if (vtt && fs.existsSync(local(vtt))) {
  const t = fs.readFileSync(local(vtt), 'utf8').replace(/^\uFEFF/, '');
  ok('captions file is WebVTT with cues', /^WEBVTT\r?\n/.test(t) && /\d\d:\d\d:\d\d\.\d{3} --> \d\d:\d\d:\d\d\.\d{3}/.test(t));
} else ok('captions file exists', false, vtt);

if (poster && fs.existsSync(local(poster))) {
  const b = fs.readFileSync(local(poster));
  ok('poster is WebP', b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP');
  ok('poster carries no EXIF/XMP chunk', b.indexOf('EXIF') < 0 && b.indexOf('XMP ') < 0);
} else ok('poster exists', false, poster);

const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const star = fb.hosting.headers.find((h) => h.source === '**');
const csp = ((star && star.headers.find((h) => h.key === 'Content-Security-Policy')) || {}).value || '';
ok("site CSP admits same-origin media (media-src 'self')", /media-src [^;]*'self'/.test(csp));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
