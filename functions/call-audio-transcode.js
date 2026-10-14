'use strict';
/**
 * call-audio-transcode.js - make a phone recording acceptable to the
 * transcriber.
 *
 * Groq's speech endpoint only accepts flac mp3 mp4 mpeg mpga m4a ogg opus
 * wav webm. Cube ACR saves .amr (and some phones .3gp / .aac), which Groq
 * rejects with "file must be one of the following types" - three strikes and
 * the call parked at status 'stored' for good (9 calls, up to 12 days old,
 * 2026-10-14). Anything outside the accepted list is re-encoded to FLAC
 * (mono, lossless, native encoder in every ffmpeg build) before the upload.
 *
 * Pure part (needsTranscode, GROQ_EXTS) is unit-tested; toFlac takes an
 * injectable runner so the test never needs a binary.
 */

const GROQ_EXTS = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm'];

function cleanExt(ext) {
  return String(ext || '').toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '');
}

/** true when the extension is NOT one Groq accepts (an unknown ext transcodes too). */
function needsTranscode(ext) {
  return GROQ_EXTS.indexOf(cleanExt(ext)) === -1;
}

/**
 * Re-encode `buffer` (container guessed from `ext`) to mono FLAC.
 * io = { withWorkDir, run, fs, path } - defaults to reel-ffmpeg + node fs.
 * Resolves { buffer, ext: 'flac' }. Rejects with an 'ffmpeg ...' message.
 */
async function toFlac(buffer, ext, io) {
  const i = io || {};
  const fs = i.fs || require('fs');
  const path = i.path || require('path');
  const R = (i.withWorkDir && i.run) ? null : require('./reel-ffmpeg');
  const withWorkDir = i.withWorkDir || R.withWorkDir;
  const run = i.run || R.run;
  const inExt = cleanExt(ext) || 'bin';
  return withWorkDir(async (dir) => {
    const inFile = path.join(dir, 'in.' + inExt);
    const outFile = path.join(dir, 'out.flac');
    fs.writeFileSync(inFile, buffer);
    await run(['-hide_banner', '-nostdin', '-y', '-i', inFile, '-vn', '-ac', '1', '-c:a', 'flac', outFile], { cwd: dir, timeoutMs: 240000 });
    const out = fs.readFileSync(outFile);
    if (!out || !out.length) throw new Error('ffmpeg produced no audio');
    return { buffer: out, ext: 'flac' };
  });
}

/**
 * What to hand the transcriber for a stored recording: transcodes when the
 * container is not one Groq accepts. Resolves { buffer, ext, mimeType, filename }.
 */
async function prepareForGroq(buffer, ext, io) {
  let buf = buffer;
  let e = cleanExt(ext) || 'm4a';
  if (needsTranscode(e)) {
    const t = await ((io && io.toFlac) || toFlac)(buf, e, io);
    buf = t.buffer;
    e = t.ext;
  }
  const mimeType = e === 'm4a' || e === 'mp4' ? 'audio/mp4' : (e === 'flac' ? 'audio/flac' : 'audio/mpeg');
  return { buffer: buf, ext: e, mimeType, filename: 'call.' + e };
}

module.exports = { GROQ_EXTS, needsTranscode, toFlac, prepareForGroq, cleanExt };
