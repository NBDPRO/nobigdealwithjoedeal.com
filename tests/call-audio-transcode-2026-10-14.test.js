/**
 * tests/call-audio-transcode-2026-10-14.test.js - Cube ACR .amr recordings are
 * re-encoded before they reach the transcriber.
 *
 * Found 2026-10-14: 9 phone_calls (source cube-acr, up to 12 days old) sat at
 * status 'stored', transcribeAttempts 3, "Groq rejected: file must be one of
 * the following types: [flac mp3 mp4 mpeg mpga m4a ogg opus wav webm]". Topping
 * up credit could not bring them back: the container itself was refused.
 *
 *   1. needsTranscode: amr / 3gp / aac / unknown transcode; every Groq type
 *      does not (positive AND negative controls, case + dot tolerant)
 *   2. prepareForGroq: an accepted file passes through byte-identical
 *   3. prepareForGroq: an .amr is handed to the encoder and comes back flac
 *   4. toFlac: asks ffmpeg for mono FLAC from the right input file, and an
 *      empty output is an error (never an empty upload)
 *   5. call-center.js transcribes through prepareForGroq
 *   6. real ffmpeg (when present): a generated tone round-trips to a valid FLAC
 *
 * Run: node tests/call-audio-transcode-2026-10-14.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const T = require(path.join(__dirname, '..', 'functions', 'call-audio-transcode.js'));

let pass = 0; let fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name); } }

(async () => {
  console.log('1. needsTranscode');
  ['amr', '.AMR', '3gp', 'aac', 'caf', '', undefined, 'wma'].forEach((e) => ok('transcodes ' + JSON.stringify(e), T.needsTranscode(e) === true));
  ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm', 'M4A', '.mp3'].forEach((e) => ok('passes ' + JSON.stringify(e), T.needsTranscode(e) === false));

  console.log('2. accepted file is untouched');
  const orig = Buffer.from('ID3-original-bytes');
  let called = 0;
  const p1 = await T.prepareForGroq(orig, 'mp3', { toFlac: async () => { called++; return { buffer: Buffer.from('x'), ext: 'flac' }; } });
  ok('mp3 bytes identical', p1.buffer === orig && p1.ext === 'mp3' && p1.mimeType === 'audio/mpeg' && p1.filename === 'call.mp3');
  ok('encoder not called for mp3', called === 0);
  const pm = await T.prepareForGroq(orig, 'm4a', {});
  ok('m4a keeps audio/mp4', pm.mimeType === 'audio/mp4' && pm.filename === 'call.m4a');

  console.log('3. .amr goes through the encoder');
  const flac = Buffer.from('fLaC-fake');
  let seen = null;
  const p2 = await T.prepareForGroq(Buffer.from('#!AMR\n'), 'amr', { toFlac: async (b, e) => { seen = { b: b.toString('latin1'), e }; return { buffer: flac, ext: 'flac' }; } });
  ok('encoder got the amr bytes + ext', seen && seen.e === 'amr' && seen.b === '#!AMR\n');
  ok('result is the flac, named call.flac, audio/flac', p2.buffer === flac && p2.filename === 'call.flac' && p2.mimeType === 'audio/flac');

  console.log('4. toFlac builds the right ffmpeg call');
  let args = null; let writtenIn = null;
  const io = {
    fs: { writeFileSync: (f, b) => { writtenIn = { f, n: b.length }; }, readFileSync: () => Buffer.from('fLaC-out') },
    path,
    withWorkDir: async (fn) => fn('/work'),
    run: async (a) => { args = a; return { code: 0 }; },
  };
  const r = await T.toFlac(Buffer.from('abc'), 'amr', io);
  ok('input file keeps the .amr extension', writtenIn && /in\.amr$/.test(writtenIn.f) && writtenIn.n === 3);
  ok('mono flac, no video, output out.flac', args.indexOf('-ac') !== -1 && args[args.indexOf('-ac') + 1] === '1' && args.indexOf('flac') !== -1 && args.indexOf('-vn') !== -1 && /out\.flac$/.test(args[args.length - 1]));
  ok('returns { buffer, ext: flac }', r.ext === 'flac' && r.buffer.toString() === 'fLaC-out');
  let empty = null;
  try { await T.toFlac(Buffer.from('abc'), 'amr', Object.assign({}, io, { fs: { writeFileSync() {}, readFileSync: () => Buffer.alloc(0) } })); } catch (e) { empty = e; }
  ok('empty output rejects (control: non-empty above resolved)', !!empty && /no audio/.test(empty.message));
  let boom = null;
  try { await T.toFlac(Buffer.from('abc'), 'amr', Object.assign({}, io, { run: async () => { throw new Error('ffmpeg exited 1: bad'); } })); } catch (e) { boom = e; }
  ok('ffmpeg failure propagates', !!boom && /ffmpeg exited 1/.test(boom.message));

  console.log('5. call-center.js uses it');
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', 'call-center.js'), 'utf8');
  ok('transcribe goes through prepareForGroq', /prepareForGroq\(buffer, ext\)/.test(src));
  ok('the old direct-ext mime mapping is gone', !/mimeType: ext === 'm4a' \? 'audio\/mp4' : 'audio\/mpeg', filename: 'call\.' \+ \(ext/.test(src));

  console.log('5b. the stuck calls can be reopened');
  const RO = require(path.join(__dirname, '..', 'scripts', 'reopen-provider-outage-calls.js'));
  const plan = RO.planReopen([
    { id: 'a', data: { status: 'stored', transcribeError: 'Groq rejected: file must be one of the following types: [flac mp3]' } },
    { id: 'b', data: { status: 'stored', transcribeError: 'notes: no JSON' } },
    { id: 'c', data: { status: 'noted', transcribeError: 'Groq rejected: file must be one of the following types: [flac]' } },
  ]);
  ok('unsupported-format stored call is matched', plan.matched.join() === 'a' && plan.byKind['groq:unsupported_format'] === 1);
  ok('own-fault and non-stored calls are left alone', plan.skipped === 2);

  console.log('6. real ffmpeg');
  let bin = null;
  try { const R = require(path.join(__dirname, '..', 'functions', 'reel-ffmpeg.js')); bin = R.ffmpegPath(); } catch (_) { /* none */ }
  if (!bin) {
    ok('no ffmpeg here - real round-trip SKIPPED (CI has one)', true);
  } else {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'amrt-'));
    try {
      const wav = path.join(d, 't.wav');
      cp.spawnSync(bin, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '8000', '-ac', '1', wav], { windowsHide: true });
      const real = await T.toFlac(fs.readFileSync(wav), 'wav');
      ok('real: output is a FLAC stream', real.buffer.slice(0, 4).toString('latin1') === 'fLaC' && real.buffer.length > 100);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
