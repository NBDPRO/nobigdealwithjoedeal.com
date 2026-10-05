/**
 * functions/reel-logic.js — the pure half of Reel Studio (2026-10-04).
 *
 * Reel Studio is Social Studio's short-form video pipeline: Jo's drone clips,
 * phone walk-arounds, talking-to-camera clips and job photos become 9:16
 * (1080x1920) or 1:1 (1080x1080) reels, rendered server-side with ffmpeg
 * (functions/reel-ffmpeg.js runs the argv this file builds), and land in
 * Social Studio as ordinary draft posts (format 'reel').
 *
 * Everything here is pure (no firebase, no child_process) so the templates,
 * caption grouping, metadata stripping argv, privacy gating and the
 * AI-image rule unit-test without emulators or ffmpeg.
 *
 * Templates are DATA (TEMPLATES below), not a Remotion/HyperFrames
 * dependency. Every template = brand intro card + body segments + brand
 * outro card. A render plan is a list of segments, each one ffmpeg run that
 * writes a uniform clip (same size / fps / codecs / audio layout), then one
 * concat run that writes the reel.
 */
'use strict';

const L = require('./social-logic');

// ── Output + limits ─────────────────────────────────────────────────────
const ASPECTS = Object.freeze({
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
});
const FPS = 30;
const MAX_DURATION_S = 90;          // a reel never runs longer than this
const MAX_SOURCE_S = 180;           // ingest keeps at most the first 3 min of a clip
const INTRO_S = 2;
const OUTRO_S = 2.5;
const DAILY_RENDER_CAP = 20;        // renders (incl. blur re-renders) per company per day
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const FRAME_EVERY_S = 2;            // privacy check samples one frame every ~2 s
const MAX_FRAMES = 45;
const FRAME_WIDTH = 512;            // frames sent to vision are 512 px wide (cost)
const STALE_RENDER_MS = 12 * 60 * 1000;
const MIN_BLUR_PX = 48;             // smallest blur box side (px, even)

const BRAND = Object.freeze({
  navy: '0x1a3057',
  orange: '0xbd5728',
  offWhite: '0xf5f3ef',
  fontBold: 'BarlowCondensed-800.ttf',
  fontSemi: 'BarlowCondensed-600.ttf',
  logo: 'logo.png',
  name: 'No Big Deal Home Solutions',
  site: 'nobigdealwithjoedeal.com',
});

// Upload content types (phone clips + photos; AI graphics are images).
const VIDEO_TYPES = /^video\/(mp4|quicktime|x-m4v|webm|3gpp)$/;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;

// ── Templates (data) ────────────────────────────────────────────────────
// sources: what each template accepts. defaultKind: the Social Studio post
// kind a reel from this template becomes. jobShowcase: shows real work.
const TEMPLATES = Object.freeze({
  before_after: {
    label: 'Before / after reveal', sources: ['photo', 'video'], min: 2, max: 2,
    defaultKind: 'job_showcase', jobShowcase: true,
  },
  drone_cut: {
    label: 'Drone cut', sources: ['video'], min: 1, max: 1,
    defaultKind: 'job_showcase', jobShowcase: true,
  },
  slideshow: {
    label: 'Photo slideshow', sources: ['photo'], min: 1, max: 20,
    defaultKind: 'job_showcase', jobShowcase: true,
  },
  talking_head: {
    label: 'Talking to camera', sources: ['video'], min: 1, max: 1,
    defaultKind: 'tip', jobShowcase: false,
  },
  job_of_week: {
    label: 'Job of the week', sources: ['photo'], min: 1, max: 6,
    defaultKind: 'job_showcase', jobShowcase: true,
  },
});
const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

// AI-generated images (Jo's SuperGrok / Gemini graphics, uploaded by hand)
// may only illustrate these post kinds — never a job showcase, never
// anything presented as real work.
const AI_IMAGE_KINDS = Object.freeze(['tip', 'storm_psa']);

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function r3(n) { return Math.round(n * 1000) / 1000; }

// ── Params ──────────────────────────────────────────────────────────────
/**
 * Normalise a reel request. Throws Error(message) with a human message on
 * anything that cannot render. clips = [{ type: 'photo'|'video', durationSec,
 * aiGenerated }].
 */
function validateRequest(req) {
  const r = req || {};
  const tpl = TEMPLATES[r.template];
  if (!tpl) throw new Error('Pick a template.');
  const aspect = ASPECTS[r.aspect] ? r.aspect : '9:16';
  const clips = Array.isArray(r.clips) ? r.clips : [];
  if (clips.length < tpl.min) throw new Error(tpl.label + ' needs ' + tpl.min + (tpl.min === 1 ? ' clip.' : ' clips.'));
  if (clips.length > tpl.max) throw new Error(tpl.label + ' takes at most ' + tpl.max + '.');
  for (const c of clips) {
    if (!tpl.sources.includes(c.type)) throw new Error(tpl.label + ' takes ' + tpl.sources.join(' or ') + 's only.');
    if (c.aiGenerated) throw new Error('AI-made images cannot go in a reel. They are for tip and storm-season posts only.');
  }
  const p = r.params || {};
  const params = {
    title: typeof p.title === 'string' ? p.title.slice(0, 60) : '',
    seconds: clamp(Math.round(num(p.seconds, 15)), 5, 60),
    speedRamp: p.speedRamp === true,
    trimStart: Math.max(0, num(p.trimStart, 0)),
    trimEnd: Math.max(0, num(p.trimEnd, 0)),
    captions: p.captions !== false,
    reveal: p.reveal === 'slide' ? 'slide' : 'wipe',
    perPhoto: clamp(num(p.perPhoto, 3), 1.5, 6),
  };
  return { template: r.template, aspect, clips, params };
}

// ── Drone: best window ──────────────────────────────────────────────────
/**
 * Pick the best N-second window of a drone clip. Skips take-off (first 12%)
 * and landing (last 10%). With per-second motion scores (scene-change score
 * from a cheap low-res ffmpeg pass) it prefers steady movement: the window
 * whose mean score is highest after clipping spikes (a whip pan or a
 * propeller-in-frame jolt is not "interesting"). Without scores: the middle
 * of the usable range.
 * → { start, end }
 */
function pickBestWindow(durationSec, n, scores) {
  const d = Math.max(0, num(durationSec, 0));
  const want = Math.max(1, num(n, 15));
  if (d <= want) return { start: 0, end: r3(d) };
  let lo = d * 0.12;
  let hi = d * 0.90;
  if (hi - lo < want) { lo = Math.max(0, (d - want) / 2); hi = lo + want; }
  const s = Array.isArray(scores) ? scores.map((x) => clamp(num(x, 0), 0, 0.25)) : null;
  if (!s || s.length < 2) {
    const start = lo + ((hi - lo) - want) / 2;
    return { start: r3(start), end: r3(start + want) };
  }
  let best = lo;
  let bestScore = -1;
  for (let st = Math.floor(lo); st + want <= hi + 1e-9; st += 1) {
    let sum = 0;
    let cnt = 0;
    for (let t = Math.floor(st); t < st + want && t < s.length; t++) { sum += s[t]; cnt++; }
    const mean = cnt ? sum / cnt : 0;
    if (mean > bestScore + 1e-9) { bestScore = mean; best = st; }
  }
  return { start: r3(best), end: r3(Math.min(d, best + want)) };
}

/** Drone pieces: plain trim, or 1x / 2x / 1x when the speed ramp is on. */
function droneParts(win, speedRamp) {
  const len = win.end - win.start;
  if (!speedRamp || len < 4) return [{ start: win.start, end: win.end, speed: 1 }];
  const a = win.start + len * 0.3;
  const b = win.start + len * 0.7;
  return [
    { start: r3(win.start), end: r3(a), speed: 1 },
    { start: r3(a), end: r3(b), speed: 2 },
    { start: r3(b), end: r3(win.end), speed: 1 },
  ];
}
function partsDuration(parts) { return r3(parts.reduce((s, p) => s + (p.end - p.start) / p.speed, 0)); }

// ── Captions ────────────────────────────────────────────────────────────
/**
 * Words → caption lines of 2–4 words (bottom-safe area). Breaks on sentence
 * punctuation, on a pause longer than maxGap, and when a line would pass
 * maxChars. A trailing single word joins the previous line when it fits.
 * words: [{ word, start, end }] (Whisper word timestamps, seconds).
 * → [{ text, start, end }]
 */
function groupWords(words, opts) {
  const o = Object.assign({ min: 2, max: 4, maxChars: 22, maxGap: 0.6, minShow: 0.5 }, opts || {});
  const ws = (words || [])
    .map((w) => ({ word: String((w && (w.word || w.text)) || '').replace(/\s+/g, ' ').trim(), start: num(w && w.start, NaN), end: num(w && w.end, NaN) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) { groups.push(cur); cur = []; } };
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const text = cur.map((x) => x.word).join(' ') + ' ' + w.word;
      const gap = w.start - prev.end;
      if (cur.length >= o.max || text.length > o.maxChars || gap > o.maxGap) flush();
    }
    cur.push(w);
    if (/[.!?]$/.test(w.word) && cur.length >= o.min) flush();
  }
  flush();
  // Merge a lone word into its neighbour when the result still fits.
  for (let i = groups.length - 1; i > 0; i--) {
    if (groups[i].length === 1) {
      const merged = groups[i - 1].concat(groups[i]);
      const text = merged.map((x) => x.word).join(' ');
      const gap = groups[i][0].start - groups[i - 1][groups[i - 1].length - 1].end;
      if (merged.length <= o.max && text.length <= o.maxChars && gap <= o.maxGap) { groups[i - 1] = merged; groups.splice(i, 1); }
    }
  }
  const out = groups.map((g) => ({ text: g.map((x) => x.word).join(' '), start: g[0].start, end: g[g.length - 1].end }));
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    if (out[i].end - out[i].start < o.minShow) out[i].end = next ? Math.min(next.start, out[i].start + o.minShow) : out[i].start + o.minShow;
    out[i].start = r3(out[i].start);
    out[i].end = r3(out[i].end);
  }
  return out;
}

/** Segment-only transcripts (no word stamps): spread each segment's words evenly. */
function wordsFromSegments(segments) {
  const out = [];
  for (const s of segments || []) {
    const parts = String((s && s.text) || '').trim().split(/\s+/).filter(Boolean);
    const st = num(s && s.start, 0);
    const en = Math.max(st, num(s && s.end, st));
    const step = parts.length ? (en - st) / parts.length : 0;
    parts.forEach((w, i) => out.push({ word: w, start: r3(st + i * step), end: r3(st + (i + 1) * step) }));
  }
  return out;
}

/**
 * Run the transcript through the SAME Social Studio filter (privacy scrub +
 * Kentucky claim wording + deductibles). Whole sentences that trip it are
 * removed from the captions, and reported: the AUDIO still says it, so a
 * reel with dropped speech needs Jo's confirmation before it can be approved.
 * → { words, dropped: [{ rule, sentence }] }
 */
function filterTranscriptWords(words, privateTerms) {
  const ws = (words || []).slice();
  const sentences = [];
  let cur = [];
  for (const w of ws) {
    cur.push(w);
    if (/[.!?]["')]?$/.test(String(w.word || ''))) { sentences.push(cur); cur = []; }
  }
  if (cur.length) sentences.push(cur);
  const kept = [];
  const dropped = [];
  for (const s of sentences) {
    const text = s.map((w) => String(w.word || '').trim()).join(' ');
    const res = L.cleanCaption(text, { privateTerms: privateTerms || [] });
    if (res.dropped.length) dropped.push({ rule: res.dropped[0].rule, sentence: text.slice(0, 160) });
    else kept.push(...s);
  }
  return { words: kept, dropped };
}

/**
 * On-screen text (titles, job-of-the-week lines) through the same filter. A
 * line that trips any rule is blanked, never rewritten. Prices are refused
 * outright: a reel names the town, package and tier only — never cost,
 * margin, or a dollar figure.
 */
function safeOverlayText(text, privateTerms) {
  const t = String(text == null ? '' : text).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!t) return { text: '', dropped: null };
  if (/[$€£]|\b\d+(\.\d+)?\s*(usd|dollars?|bucks|k)\b|\b(cost|margin|markup|profit|per\s*sq)\b/i.test(t)) return { text: '', dropped: 'price' };
  const res = L.cleanCaption(t, { privateTerms: privateTerms || [] });
  if (res.dropped.length) return { text: '', dropped: res.dropped[0].rule };
  return { text: t, dropped: null };
}

/** Job-of-the-week lines: town, package (tier) and shingle names only. */
function jobOfWeekLines(facts, privateTerms) {
  const f = facts || {};
  const lines = [];
  const where = f.town ? f.town + (f.state ? ', ' + f.state : '') : '';
  for (const raw of [where, f.packageLabel, f.shingle]) {
    const s = safeOverlayText(raw, privateTerms);
    if (s.text) lines.push(s.text);
  }
  return lines;
}

// ── ffmpeg argv builders ────────────────────────────────────────────────
// Every argv is relative to a work dir (cwd) so font / text files need no
// path escaping in the filtergraph. Text always comes from textfile= with
// expansion=none, so nothing Jo types (or Whisper hears) can inject filter
// syntax or %{} expansions.

const ENC_V = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-g', String(FPS * 2)];
const ENC_A = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
// Strip everything that is not picture or sound: global + per-stream
// metadata (GPS ©xyz / com.apple.quicktime.location.*, creation time, device
// make/model), chapters, data / timed-metadata tracks (iPhone 'mebx'),
// subtitles. Used on EVERY ffmpeg output, ingest and render alike.
const STRIP = ['-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1', '-dn', '-sn', '-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact'];
const MP4_OUT = ['-movflags', '+faststart', '-f', 'mp4'];

function coverChain(w, h) {
  return 'scale=' + w + ':' + h + ':force_original_aspect_ratio=increase,crop=' + w + ':' + h + ',setsar=1';
}
function finishChain() { return 'fps=' + FPS + ',format=yuv420p,settb=AVTB'; }

/**
 * Normalise an uploaded clip to the intermediate every template reads:
 * long edge ≤ 1920, 30 fps CFR, H.264 + AAC, first MAX_SOURCE_S seconds,
 * auto-rotated, and ALL metadata / data streams gone (GPS!).
 */
function normalizeArgs(input, output, opts) {
  const o = opts || {};
  const maxS = Math.min(MAX_SOURCE_S, num(o.maxSeconds, MAX_SOURCE_S));
  // libx264 + yuv420p refuses odd dimensions ("width not divisible by 2"),
  // so the capped edge is rounded down to even too — a 1281x720 screen
  // recording or an odd-cropped phone export must not fail the ingest.
  const vf = "scale='if(gt(iw,ih),trunc(min(1920,iw)/2)*2,-2)':'if(gt(iw,ih),-2,trunc(min(1920,ih)/2)*2)'," + finishChain();
  return ['-hide_banner', '-nostdin', '-y', '-i', input, '-t', String(maxS),
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf]
    .concat(ENC_V, ENC_A, STRIP, MP4_OUT, [output]);
}

function drawText(file, font, size, y, extra) {
  return "drawtext=fontfile='" + font + "':textfile='" + file + "':expansion=none:fontsize=" + size +
    ':fontcolor=white:borderw=' + Math.max(2, Math.round(size / 14)) + ':bordercolor=black@0.85:x=(w-text_w)/2:y=' + y + (extra || '');
}

/**
 * The talking-head trim window, in source seconds. ONE function for both
 * the video/audio trim in buildPlan and the audio range sent to Whisper
 * (reel-studio.js doRender): caption timestamps are relative to the start
 * of that audio, so the two windows must be identical or every caption
 * drifts. → { start, end, duration } (duration ≥ 1 s, ≤ the reel's body room)
 */
function talkingHeadWindow(params, durationSec) {
  const p = params || {};
  const dur = Math.max(0, num(durationSec, 0));
  const start = clamp(Math.max(0, num(p.trimStart, 0)), 0, Math.max(0, dur - 1));
  const te = Math.max(0, num(p.trimEnd, 0));
  const endRaw = te > start ? te : dur;
  const end = Math.min(dur, endRaw, start + (MAX_DURATION_S - INTRO_S - OUTRO_S));
  return { start: r3(start), end: r3(end), duration: r3(Math.max(1, end - start)) };
}

/**
 * The render plan. inputs:
 *   req      validateRequest() output
 *   clips    [{ file, type, durationSec, hasAudio }] local work-dir names, in order
 *   texts    { title, lines[], captionGroups[] } — ALREADY filtered
 *   probe    { droneScores: [] } optional
 * → { aspect, w, h, segments: [{ name, args, duration, texts: [{ file, text }] }], concat: { list, args }, duration }
 */
function buildPlan(req, clips, texts, probe) {
  const A = ASPECTS[req.aspect] || ASPECTS['9:16'];
  const W = A.w, H = A.h;
  const t = texts || {};
  const segs = [];
  let textN = 0;
  const textFile = (seg, text) => { const f = 't' + (textN++) + '.txt'; seg.texts.push({ file: f, text: String(text) }); return f; };
  const silent = (d) => ['-f', 'lavfi', '-t', String(d), '-i', 'anullsrc=r=48000:cl=stereo'];
  const segOut = (name, d, mapV, mapA) => ['-map', mapV, '-map', mapA, '-t', String(d)].concat(ENC_V, ENC_A, STRIP, MP4_OUT, [name]);
  const big = Math.round(W * 0.085);   // 92 px at 1080 wide
  const mid = Math.round(W * 0.06);
  const small = Math.round(W * 0.045);

  // Brand card: navy, logo, orange rule, two lines. Used for intro + outro.
  function card(name, d, line1, line2) {
    const seg = { name, duration: d, texts: [] };
    const f1 = line1 ? textFile(seg, line1) : null;
    const f2 = line2 ? textFile(seg, line2) : null;
    const logoW = Math.round(W * 0.62);
    let fc = '[1:v]scale=' + logoW + ':-1[lg];[0:v][lg]overlay=(W-w)/2:H*0.34-h/2,' +
      'drawbox=x=' + Math.round(W * 0.3) + ':y=' + Math.round(H * 0.52) + ':w=' + Math.round(W * 0.4) + ':h=' + Math.max(6, Math.round(H * 0.005)) + ':color=' + BRAND.orange + ':t=fill';
    if (f1) fc += ',' + drawText(f1, BRAND.fontBold, mid, 'h*0.56');
    if (f2) fc += ',' + drawText(f2, BRAND.fontSemi, small, 'h*0.56+' + Math.round(mid * 1.5));
    fc += ',fade=t=in:st=0:d=0.25,fade=t=out:st=' + r3(d - 0.25) + ':d=0.25,' + finishChain() + '[v]';
    seg.args = ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=' + BRAND.navy + ':s=' + W + 'x' + H + ':r=' + FPS + ':d=' + d,
      '-loop', '1', '-t', String(d), '-i', BRAND.logo].concat(silent(d), ['-filter_complex', fc], segOut(name, d, '[v]', '2:a'));
    return seg;
  }

  // A still with a slow Ken Burns move (zoom in; alternate pan direction).
  function still(name, file, d, idx, overlays) {
    const seg = { name, duration: d, texts: [] };
    const frames = Math.round(d * FPS);
    const bw = Math.round(W * 1.5 / 2) * 2, bh = Math.round(H * 1.5 / 2) * 2;
    const dir = idx % 2 === 0 ? "iw/2-(iw/zoom/2)" : "(iw-iw/zoom)*(1-on/" + frames + ")";
    let fc = '[0:v]scale=' + bw + ':' + bh + ':force_original_aspect_ratio=increase,crop=' + bw + ':' + bh +
      ",zoompan=z='min(1+0.0009*on,1.18)':x='" + dir + "':y='ih/2-(ih/zoom/2)':d=" + frames + ':s=' + W + 'x' + H + ':fps=' + FPS + ',setsar=1';
    for (const ov of overlays || []) fc += ',' + drawText(textFile(seg, ov.text), ov.font || BRAND.fontBold, ov.size || big, ov.y);
    fc += ',fade=t=in:st=0:d=0.3,fade=t=out:st=' + r3(d - 0.3) + ':d=0.3,' + finishChain() + '[v]';
    seg.args = ['-hide_banner', '-nostdin', '-y', '-i', file].concat(silent(d), ['-filter_complex', fc], segOut(name, d, '[v]', '1:a'));
    return seg;
  }

  segs.push(card('s00.mp4', INTRO_S, t.title || BRAND.name, t.title ? BRAND.name : ''));

  const tpl = req.template;
  const p = req.params;
  if (tpl === 'slideshow' || tpl === 'job_of_week') {
    const room = MAX_DURATION_S - INTRO_S - OUTRO_S;
    const per = r3(Math.min(p.perPhoto || 3, room / clips.length));
    clips.forEach((c, i) => {
      const ov = [];
      if (tpl === 'job_of_week') {
        ov.push({ text: 'JOB OF THE WEEK', y: 'h*0.08', size: big });
        (t.lines || []).slice(0, 3).forEach((line, k) => ov.push({ text: line, y: 'h*0.74+' + Math.round(k * mid * 1.35), size: mid, font: k === 0 ? BRAND.fontBold : BRAND.fontSemi }));
      }
      segs.push(still('s' + String(i + 1).padStart(2, '0') + '.mp4', c.file, per, i, ov));
    });
  } else if (tpl === 'before_after') {
    const [b, a] = clips;
    const holdB = 2.5, holdA = 3.5, xf = 1.0;
    const d = r3(holdB + holdA - xf);
    const seg = { name: 's01.mp4', duration: d, texts: [] };
    const inB = b.type === 'photo' ? ['-loop', '1', '-t', String(holdB + 0.5), '-i', b.file] : ['-t', String(holdB + 0.5), '-i', b.file];
    const inA = a.type === 'photo' ? ['-loop', '1', '-t', String(holdA + 0.5), '-i', a.file] : ['-t', String(holdA + 0.5), '-i', a.file];
    const lb = textFile(seg, 'BEFORE');
    const la = textFile(seg, 'AFTER');
    const pad = (n) => ",tpad=stop_mode=clone:stop_duration=" + n;
    const fc = '[0:v]' + coverChain(W, H) + pad(holdB) + ',trim=duration=' + holdB + ',' + drawText(lb, BRAND.fontBold, big, 'h*0.08') + ',' + finishChain() + '[b];' +
      '[1:v]' + coverChain(W, H) + pad(holdA) + ',trim=duration=' + holdA + ',' + drawText(la, BRAND.fontBold, big, 'h*0.08') + ',' + finishChain() + '[a];' +
      '[b][a]xfade=transition=' + (p.reveal === 'slide' ? 'slideleft' : 'wipeleft') + ':duration=' + xf + ':offset=' + r3(holdB - xf) + ',' + finishChain() + '[v]';
    seg.args = ['-hide_banner', '-nostdin', '-y'].concat(inB, inA, silent(d), ['-filter_complex', fc], segOut(seg.name, d, '[v]', '2:a'));
    segs.push(seg);
  } else if (tpl === 'drone_cut') {
    const c = clips[0];
    const want = Math.min(p.seconds, MAX_DURATION_S - INTRO_S - OUTRO_S);
    const win = pickBestWindow(c.durationSec, want, probe && probe.droneScores);
    const parts = droneParts(win, p.speedRamp);
    const d = partsDuration(parts);
    const seg = { name: 's01.mp4', duration: d, texts: [], window: win, parts };
    // Landscape drone footage keeps its framing on a blurred fill of itself.
    let fc = '';
    parts.forEach((pt, i) => {
      fc += '[0:v]trim=start=' + pt.start + ':end=' + pt.end + ',setpts=' + (pt.speed === 1 ? '' : (1 / pt.speed) + '*') + '(PTS-STARTPTS)[p' + i + '];';
    });
    fc += parts.map((_, i) => '[p' + i + ']').join('') + 'concat=n=' + parts.length + ':v=1:a=0,split=2[x][y];' +
      '[x]' + coverChain(W, H) + ',boxblur=24:2[bg];[y]scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease[fg];' +
      '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,' + finishChain() + '[v]';
    // Propeller noise is never wanted: drone cuts are silent.
    seg.args = ['-hide_banner', '-nostdin', '-y', '-i', c.file].concat(silent(d), ['-filter_complex', fc], segOut(seg.name, d, '[v]', '1:a'));
    segs.push(seg);
  } else if (tpl === 'talking_head') {
    const c = clips[0];
    const { start, end, duration: d } = talkingHeadWindow(p, c.durationSec);
    const seg = { name: 's01.mp4', duration: d, texts: [], trim: { start, end } };
    let fc = '[0:v]trim=start=' + start + ':end=' + end + ',setpts=PTS-STARTPTS,' + coverChain(W, H);
    // Captions: bottom-safe area (above the platform's own UI chrome).
    const capY = req.aspect === '1:1' ? 'h*0.80' : 'h*0.70';
    for (const g of (p.captions ? (t.captionGroups || []) : [])) {
      if (g.end <= 0 || g.start >= d) continue;
      fc += ',' + drawText(textFile(seg, g.text), BRAND.fontBold, big, capY, ":enable='between(t," + r3(Math.max(0, g.start)) + ',' + r3(Math.min(d, g.end)) + ")'");
    }
    fc += ',' + finishChain() + '[v]';
    let mapA;
    if (c.hasAudio) {
      fc += ';[0:a]atrim=start=' + start + ':end=' + end + ',asetpts=PTS-STARTPTS,aresample=48000[a]';
      mapA = '[a]';
    } else {
      mapA = '1:a';
    }
    seg.args = ['-hide_banner', '-nostdin', '-y', '-i', c.file].concat(c.hasAudio ? [] : silent(d), ['-filter_complex', fc], segOut(seg.name, d, '[v]', mapA));
    segs.push(seg);
  }

  segs.push(card('s99.mp4', OUTRO_S, 'Call or text Joe', BRAND.site));

  const duration = r3(segs.reduce((s, x) => s + x.duration, 0));
  const list = segs.map((s) => "file '" + s.name + "'").join('\n') + '\n';
  const concatArgs = ['-hide_banner', '-nostdin', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt',
    '-map', '0:v:0', '-map', '0:a:0', '-t', String(Math.min(duration, MAX_DURATION_S))].concat(ENC_V, ENC_A, STRIP, MP4_OUT, ['out.mp4']);
  return { aspect: req.aspect, w: W, h: H, segments: segs, concat: { list, args: concatArgs }, duration: Math.min(duration, MAX_DURATION_S) };
}

/** Frames for the privacy check: one every FRAME_EVERY_S, 512 px wide. */
function frameTimes(durationSec) {
  const d = Math.max(0, num(durationSec, 0));
  const out = [];
  for (let t = 0.5; t < d && out.length < MAX_FRAMES; t += FRAME_EVERY_S) out.push(r3(t));
  return out;
}
function frameArgs(input, t, output, width) {
  return ['-hide_banner', '-nostdin', '-y', '-ss', String(t), '-i', input, '-frames:v', '1', '-vf', 'scale=' + (width || FRAME_WIDTH) + ':-2', '-q:v', '4'].concat(STRIP, [output]);
}
/** Talking-head audio for Whisper: mono 16 kHz m4a of the trimmed range. */
function audioArgs(input, start, end, output) {
  return ['-hide_banner', '-nostdin', '-y', '-ss', String(start), '-to', String(end), '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k'].concat(STRIP, ['-f', 'mp4', output]);
}
/** Low-res motion pass for the drone window picker. */
function sceneArgs(input) {
  return ['-hide_banner', '-nostdin', '-i', input, '-an', '-vf', "scale=160:-2,fps=4,select='gte(scene,0)',metadata=print:file=-", '-f', 'null', '-'];
}
/** Parse "pts_time:12.25 ... lavfi.scene_score=0.0123" lines → per-second mean scores. */
function parseSceneScores(text) {
  const per = [];
  let t = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) { t = Number(m[1]); continue; }
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (s && t != null) {
      const k = Math.floor(t);
      (per[k] || (per[k] = [])).push(Number(s[1]));
    }
  }
  const out = [];
  for (let i = 0; i < per.length; i++) { const a = per[i] || []; out.push(a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0); }
  return out;
}

/** "Duration: 00:01:02.50" + stream lines from `ffmpeg -i` stderr. */
function parseProbe(stderr) {
  const s = String(stderr || '');
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(s);
  const durationSec = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  const v = /Stream #\d+:\d+[^:]*: Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(s);
  return {
    durationSec: r3(durationSec),
    hasVideo: /Stream #\d+:\d+[^:]*: Video:/.test(s),
    hasAudio: /Stream #\d+:\d+[^:]*: Audio:/.test(s),
    width: v ? Number(v[1]) : 0,
    height: v ? Number(v[2]) : 0,
  };
}

// ── Privacy flags + approval gating ─────────────────────────────────────
const FLAG_TYPES = Object.freeze({
  house_number: 'Readable house number',
  license_plate: 'License plate',
  street_sign: 'Street sign',
  face: "A person's face",
});

/** Clamp a vision box [x, y, w, h] (fractions of the frame) or null. */
function cleanBox(b) {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const v = b.map((x) => Number(x));
  if (v.some((x) => !Number.isFinite(x))) return null;
  let [x, y, w, h] = v;
  x = clamp(x, 0, 1); y = clamp(y, 0, 1);
  w = clamp(w, 0, 1 - x); h = clamp(h, 0, 1 - y);
  if (w < 0.01 || h < 0.01) return null;
  return [r3(x), r3(y), r3(w), r3(h)];
}

/**
 * Vision output (any shape the model returns) → sanitized flags.
 * raw: { frames: [{ i, flags: [{ type, box, confidence }], hero }] , hero }
 * times: frame index → seconds. → { flags: [{ type, t, box|null, confidence }], heroIndex, heroScore }
 */
function sanitizeVision(raw, times) {
  const flags = [];
  let heroIndex = -1, heroScore = -1;
  const frames = (raw && Array.isArray(raw.frames)) ? raw.frames : [];
  for (const f of frames) {
    const i = Math.round(Number(f && f.i));
    if (!Number.isInteger(i) || i < 0 || i >= (times || []).length) continue;
    for (const fl of (Array.isArray(f.flags) ? f.flags : [])) {
      const type = String(fl && fl.type || '');
      if (!FLAG_TYPES[type]) continue;
      // A missing / non-numeric confidence counts as 0.5 (flag it, Jo looks);
      // an explicit 0 is the model saying "not there" and must stay 0 — the
      // old `Number(x) || 0.5` turned it into a 0.5 flag.
      const rawConf = (fl.confidence === null || fl.confidence === undefined || fl.confidence === '') ? NaN : Number(fl.confidence);
      const conf = clamp(Number.isFinite(rawConf) ? rawConf : 0.5, 0, 1);
      if (conf < 0.35) continue;
      flags.push({ type, t: times[i], frame: i, box: cleanBox(fl.box), confidence: r3(conf) });
    }
    const hs = Number(f && f.heroScore);
    if (Number.isFinite(hs) && hs > heroScore && !(Array.isArray(f.flags) && f.flags.length)) { heroScore = hs; heroIndex = i; }
  }
  return { flags: flags.slice(0, 60), heroIndex, heroScore: r3(Math.max(0, heroScore)) };
}

/**
 * Privacy status after the check:
 *   'clear'      nothing found
 *   'flagged'    vision found something (or speech/text the filter removed)
 *   'unchecked'  the check could not run (AI switched off, over budget,
 *                vision error, emulator) — Jo must look and confirm
 * Then Jo moves flagged/unchecked → 'confirmed' or (boxes only) 'blurred'.
 */
function privacyStatusFrom(check) {
  const c = check || {};
  if (!c.ran) return 'unchecked';
  return ((c.flags || []).length || (c.speechDropped || []).length || (c.textDropped || []).length) ? 'flagged' : 'clear';
}

/** Can the auto-blur fix this reel? Only visual flags, every one with a box. */
function blurAvailable(reel) {
  const pv = (reel && reel.privacy) || {};
  if (pv.status !== 'flagged') return false;
  if ((pv.speechDropped || []).length || (pv.textDropped || []).length) return false;
  const fl = pv.flags || [];
  return fl.length > 0 && fl.every((f) => Array.isArray(f.box) && f.box.length === 4);
}

/**
 * The gate. A reel's posts can be approved (and published) only when the
 * render finished AND privacy is clear, confirmed by Jo, or blurred.
 * → { ok, reason }
 */
function canApproveReel(reel) {
  const r = reel || {};
  if (r.status !== 'rendered' || !r.output || !r.output.key) return { ok: false, reason: 'The reel has not finished rendering.' };
  const st = (r.privacy || {}).status;
  if (st === 'clear' || st === 'confirmed' || st === 'blurred') return { ok: true, reason: '' };
  if (st === 'flagged') return { ok: false, reason: 'The privacy check flagged frames in this reel. Look at them, then confirm or blur before approving.' };
  if (st === 'unchecked') return { ok: false, reason: 'The privacy check could not run. Watch the reel and confirm nothing private shows before approving.' };
  return { ok: false, reason: 'The privacy check has not finished.' };
}

/**
 * Blur boxes over time: each flag at time t covers [t - 1.2, t + 1.2]
 * (frames are ~2 s apart), merged per overlapping region. Pixel boxes,
 * even-sized, inside the frame. → [{ x, y, w, h, start, end }]
 */
function blurRegions(flags, w, h, durationSec) {
  const out = [];
  const half = FRAME_EVERY_S * 0.6;
  for (const f of flags || []) {
    const b = cleanBox(f && f.box);
    if (!b) continue;
    const pad = 0.04;
    const x0 = clamp(b[0] - pad, 0, 1), y0 = clamp(b[1] - pad, 0, 1);
    const x1 = clamp(b[0] + b[2] + pad, 0, 1), y1 = clamp(b[1] + b[3] + pad, 0, 1);
    // At least MIN_BLUR_PX a side; a box at the frame edge slides back
    // inside instead of shrinking (the old shrink could leave a 10 px box,
    // which boxblur then refused — see blurRadii).
    const even = (v) => Math.floor(v / 2) * 2;
    const bw = Math.min(even(w), Math.max(MIN_BLUR_PX, even((x1 - x0) * w)));
    const bh = Math.min(even(h), Math.max(MIN_BLUR_PX, even((y1 - y0) * h)));
    const r = {
      x: Math.min(even(x0 * w), even(w - bw)), y: Math.min(even(y0 * h), even(h - bh)),
      w: bw, h: bh,
      start: r3(Math.max(0, f.t - half)), end: r3(Math.min(durationSec || 1e9, f.t + half)),
    };
    const same = out.find((o) => Math.abs(o.x - r.x) < w * 0.08 && Math.abs(o.y - r.y) < h * 0.08 && r.start <= o.end + 0.01);
    if (same) {
      same.end = Math.max(same.end, r.end);
      const ex = Math.max(same.x + same.w, r.x + r.w), ey = Math.max(same.y + same.h, r.y + r.h);
      same.x = Math.min(same.x, r.x); same.y = Math.min(same.y, r.y);
      same.w = Math.floor((ex - same.x) / 2) * 2; same.h = Math.floor((ey - same.y) / 2) * 2;
    } else out.push(r);
  }
  return out.slice(0, 24);
}

/**
 * boxblur radii for a w x h crop. ffmpeg refuses a radius above half the
 * plane's smaller side, and in yuv420p the two chroma planes are HALF size —
 * so the chroma radius gets its own, smaller cap. (The old single radius,
 * at least 8, made boxblur fail on any crop under 32 px: "Invalid chroma
 * radius value 8, must be >= 0 and <= 7" — the blur re-render died.)
 * → { luma, chroma }
 */
function blurRadii(w, h) {
  const m = Math.max(2, Math.min(num(w, 0), num(h, 0)));
  const luma = Math.max(1, Math.min(Math.floor(m / 2) - 1, Math.max(8, Math.round(m / 6))));
  const chroma = Math.max(1, Math.min(luma, Math.floor(m / 4) - 1));
  return { luma, chroma };
}

function blurArgs(input, output, regions) {
  if (!regions.length) throw new Error('nothing to blur');
  let fc = '[0:v]split=' + (regions.length + 1) + '[base]' + regions.map((_, i) => '[c' + i + ']').join('') + ';';
  regions.forEach((r, i) => {
    const br = blurRadii(r.w, r.h);
    fc += '[c' + i + ']crop=' + r.w + ':' + r.h + ':' + r.x + ':' + r.y +
      ',boxblur=luma_radius=' + br.luma + ':luma_power=3:chroma_radius=' + br.chroma + ':chroma_power=3[b' + i + '];';
  });
  let cur = '[base]';
  regions.forEach((r, i) => {
    const nxt = i === regions.length - 1 ? '[v]' : '[o' + i + ']';
    fc += cur + '[b' + i + ']overlay=' + r.x + ':' + r.y + ":enable='between(t," + r.start + ',' + r.end + ")'" + nxt + (i === regions.length - 1 ? '' : ';');
    cur = nxt;
  });
  return ['-hide_banner', '-nostdin', '-y', '-i', input, '-filter_complex', fc, '-map', '[v]', '-map', '0:a:0?']
    .concat(ENC_V, ['-c:a', 'copy'], STRIP, MP4_OUT, [output]);
}

// ── AI images ───────────────────────────────────────────────────────────
function aiImageAllowedFor(kind) { return AI_IMAGE_KINDS.includes(kind); }

/**
 * The AI-image rule for a post: an AI-generated image (post.aiGenerated, or
 * any media whose index doc says aiGenerated) may only sit on a tip or
 * storm-season post — never a job showcase or anything presented as real
 * work. mediaIndex: { key: { aiGenerated } }. → { ok, reason }
 */
function checkAiImageRule(post, mediaIndex) {
  const p = post || {};
  const idx = mediaIndex || {};
  const anyAi = p.aiGenerated === true || (p.media || []).some((m) => m && idx[m.key] && idx[m.key].aiGenerated === true);
  if (!anyAi) return { ok: true, reason: '' };
  if (p.format === 'reel' || p.reelId) return { ok: false, reason: 'AI-made images cannot be part of a reel.' };
  if (!aiImageAllowedFor(p.kind)) return { ok: false, reason: 'AI-made images are for tip and storm-season posts only — never a job showcase or real work.' };
  return { ok: true, reason: '' };
}

/** Which Social Studio post kind a reel becomes; job-showcase templates stay showcases. */
function reelPostKind(template, wanted) {
  const tpl = TEMPLATES[template];
  if (!tpl) return 'behind_scenes';
  if (tpl.jobShowcase) return 'job_showcase';
  return L.KINDS[wanted] ? wanted : tpl.defaultKind;
}

// ── On / off ────────────────────────────────────────────────────────────
/**
 * Reel Studio is OFF until the company turns it on, and the platform can
 * pull it for everyone. Renders spend compute, and the privacy check +
 * captions spend Claude / Groq money, so every spending path (upload slot,
 * create, blur, retry, the render worker, ingest) asks this first.
 *   settings  companies/{c}/social_settings/config  — needs reels === true
 *   flags     feature_flags/global                  — reelStudioDisabled kills it
 * → { ok, reason }
 */
function reelSwitch(settings, flags) {
  if (flags && flags.reelStudioDisabled === true) return { ok: false, reason: 'Reel Studio is switched off for maintenance.' };
  if (!settings || settings.reels !== true) return { ok: false, reason: 'Reel Studio is off. Turn it on in Social Studio → Settings.' };
  return { ok: true, reason: '' };
}

// ── Cost ────────────────────────────────────────────────────────────────
// Cloud Functions gen2 (Tier 1): $0.000024 / vCPU-s, $0.0000025 / GiB-s.
// Haiku 4.5: $1 / M input, $5 / M output. A 512x910 frame ≈ 620 tokens.
// Groq whisper-large-v3-turbo: $0.04 / audio hour.
function estimateCostUsd(o) {
  const x = o || {};
  const cpu = num(x.vcpu, 4), mem = num(x.gib, 4);
  const renderS = num(x.renderSeconds, Math.max(30, num(x.durationSec, 60) * 1.3));
  const compute = renderS * (cpu * 0.000024 + mem * 0.0000025);
  const frames = Math.min(MAX_FRAMES, Math.ceil(num(x.durationSec, 60) / FRAME_EVERY_S));
  const vision = x.vision === false ? 0 : (frames * 620 + 900) / 1e6 * 1 + 400 * 5 / 1e6 * Math.ceil(frames / 10);
  const whisper = x.transcribe ? num(x.durationSec, 60) / 3600 * 0.04 : 0;
  return { compute: r3(compute), vision: r3(vision), whisper: r3(whisper), total: r3(compute + vision + whisper) };
}

function dayKey(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: L.TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms || Date.now()));
}

module.exports = {
  ASPECTS, FPS, MAX_DURATION_S, MAX_SOURCE_S, INTRO_S, OUTRO_S, DAILY_RENDER_CAP, MAX_UPLOAD_BYTES,
  FRAME_EVERY_S, MAX_FRAMES, FRAME_WIDTH, STALE_RENDER_MS, MIN_BLUR_PX, BRAND, VIDEO_TYPES, IMAGE_TYPES,
  TEMPLATES, TEMPLATE_IDS, AI_IMAGE_KINDS, FLAG_TYPES, STRIP,
  validateRequest, pickBestWindow, droneParts, partsDuration, groupWords, wordsFromSegments,
  filterTranscriptWords, safeOverlayText, jobOfWeekLines,
  normalizeArgs, talkingHeadWindow, buildPlan, frameTimes, frameArgs, audioArgs, sceneArgs, parseSceneScores, parseProbe,
  cleanBox, sanitizeVision, privacyStatusFrom, blurAvailable, canApproveReel, blurRegions, blurRadii, blurArgs,
  aiImageAllowedFor, checkAiImageRule, reelPostKind, reelSwitch, estimateCostUsd, dayKey,
};
