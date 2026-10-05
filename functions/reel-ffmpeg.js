/**
 * functions/reel-ffmpeg.js — runs the argv reel-logic.js builds (Reel
 * Studio, 2026-10-04). The only file that spawns ffmpeg.
 *
 * Binary: FFMPEG_PATH (tests / local), else the ffmpeg-static package (a
 * static Linux build ships with the functions deploy — `npm ci` in Cloud
 * Build downloads it), else an `ffmpeg` on PATH. ffmpeg-static is an
 * OPTIONAL dependency: if its install-time download fails, npm drops it and
 * the deploy still succeeds. ffmpegPath() then returns null and the caller
 * decides (reelCreate refuses before taking a render slot, the worker and
 * ingest fail the reel / upload with reel-studio.js FFMPEG_MISSING; the
 * emulator uses its stub).
 *
 * Every run is argv (spawn, no shell) with cwd = a private work dir under
 * os.tmpdir(); on Cloud Functions gen2 /tmp is memory-backed, so the work
 * dir is always removed (withWorkDir's finally).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const RL = require('./reel-logic');

const ASSET_DIR = path.join(__dirname, 'assets', 'reel');
let _bin;

function ffmpegPath() {
  if (_bin !== undefined) return _bin;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = require('ffmpeg-static'); if (p) candidates.push(p); } catch (_) { /* not installed */ }
  candidates.push('ffmpeg');
  _bin = null;
  for (const c of candidates) {
    try {
      // A binary only counts if it has every filter the templates use. The
      // ffmpeg-static 5.3.0 Linux build (FFmpeg 7.0.2) has NO drawtext —
      // FFmpeg 7 needs libharfbuzz for it — so every brand card failed with
      // "No such filter: 'drawtext'". Pinned to 5.2.0 (FFmpeg 6.0) in
      // functions/package.json; this check catches a future regression.
      const r = spawnSync(c, ['-hide_banner', '-filters'], { timeout: 15000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (r.status === 0 && missingFilters(r.stdout).length === 0) { _bin = c; break; }
    } catch (_) { /* next */ }
  }
  return _bin;
}

const REQUIRED_FILTERS = ['drawtext', 'drawbox', 'overlay', 'xfade', 'zoompan', 'boxblur', 'scale', 'crop', 'tpad', 'fade', 'concat', 'atrim'];
/** `ffmpeg -filters` output → the template filters it lacks ([] = usable). */
function missingFilters(filtersText) {
  const have = new Set();
  for (const line of String(filtersText || '').split(/\r?\n/)) {
    const m = /^\s*[A-Z.|]{2,4}\s+(\w+)\s/.exec(line);
    if (m) have.add(m[1]);
  }
  return REQUIRED_FILTERS.filter((f) => !have.has(f));
}
function _resetBin() { _bin = undefined; }

/** Run ffmpeg → { code, stdout, stderr }. Rejects on non-zero (stderr tail in the message). */
function run(args, opts) {
  const o = opts || {};
  const bin = o.bin || ffmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg is not available'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: o.cwd, windowsHide: true });
    const out = [];
    const err = [];
    let errLen = 0;
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { if (errLen < 4e6) { err.push(d); errLen += d.length; } });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, o.timeoutMs || 420000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const res = { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
      if (code === 0 || o.allowFail) resolve(res);
      else reject(new Error('ffmpeg exited ' + code + ': ' + res.stderr.split(/\r?\n/).filter(Boolean).slice(-4).join(' | ').slice(0, 600)));
    });
  });
}

/** Duration / streams of a local file (ffmpeg -i exits 1 with no output; parse stderr). */
async function probe(file, opts) {
  const r = await run(['-hide_banner', '-nostdin', '-i', file], Object.assign({}, opts, { allowFail: true }));
  return RL.parseProbe(r.stderr);
}

async function withWorkDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-' + crypto.randomBytes(4).toString('hex') + '-'));
  try { return await fn(dir); } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
}

/** Copy the brand fonts + logo into the work dir (relative names in filters). */
function stageBrand(dir) {
  for (const f of [RL.BRAND.fontBold, RL.BRAND.fontSemi, RL.BRAND.logo]) {
    fs.copyFileSync(path.join(ASSET_DIR, f), path.join(dir, f));
  }
}

/** Normalise one upload (metadata stripped). → probe of the output */
async function normalize(inFile, outFile, opts) {
  const dir = path.dirname(outFile);
  await run(RL.normalizeArgs(path.basename(inFile), path.basename(outFile), opts), { cwd: dir });
  return probe(outFile, { cwd: dir });
}

/** Execute a render plan in `dir` (clip files already there). → absolute out.mp4 */
async function renderPlan(dir, plan, opts) {
  stageBrand(dir);
  for (const seg of plan.segments) {
    for (const t of seg.texts) fs.writeFileSync(path.join(dir, t.file), t.text, 'utf8');
    await run(seg.args, { cwd: dir, timeoutMs: opts && opts.segmentTimeoutMs });
  }
  fs.writeFileSync(path.join(dir, 'list.txt'), plan.concat.list, 'utf8');
  await run(plan.concat.args, { cwd: dir });
  return path.join(dir, 'out.mp4');
}

async function droneScores(dir, file) {
  try {
    const r = await run(RL.sceneArgs(file), { cwd: dir, timeoutMs: 120000 });
    return RL.parseSceneScores(r.stdout + '\n' + r.stderr);
  } catch (_) { return null; }
}

/** Sample frames → [{ t, file }] (JPEG, 512 px wide, no metadata). */
async function sampleFrames(dir, file, durationSec, width) {
  const times = RL.frameTimes(durationSec);
  const out = [];
  for (let i = 0; i < times.length; i++) {
    const name = 'f' + String(i).padStart(3, '0') + '.jpg';
    try {
      await run(RL.frameArgs(file, times[i], name, width), { cwd: dir, timeoutMs: 30000 });
      // A seek at the very end exits 0 with no frame written.
      if (fs.existsSync(path.join(dir, name))) out.push({ t: times[i], file: path.join(dir, name) });
    } catch (_) { /* skip */ }
  }
  return out;
}

module.exports = { ffmpegPath, missingFilters, REQUIRED_FILTERS, _resetBin, run, probe, withWorkDir, stageBrand, normalize, renderPlan, droneScores, sampleFrames, ASSET_DIR };
