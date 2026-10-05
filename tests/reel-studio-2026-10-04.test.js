#!/usr/bin/env node
/**
 * Reel Studio (2026-10-04) — behaviour tests. No real API calls: Claude
 * vision, Groq Whisper and the Meta Graph API are stubs, Firestore is an
 * in-memory fake, Storage is a fake bucket. Every assertion runs the real
 * module code; sections D, H and I run REAL ffmpeg (ffmpeg-static from
 * functions/node_modules, or FFMPEG_PATH) and skip loudly when neither runs.
 *
 *   A. Templates: request validation, render plans per template (intro +
 *      outro cards, 9:16 / 1:1, the 90 s cap, drone window + speed ramp,
 *      talking-head trim + caption windows, job-of-the-week lines).
 *   B. Caption grouping: 2–4 words, sentence / pause / length breaks.
 *   C. The Social Studio safety filter on captions + on-screen text
 *      (names, streets, house numbers, KY claim wording, deductibles, prices).
 *   D. Metadata stripping: the argv, then real ffmpeg on a clip carrying
 *      GPS / ©xyz / make / creation_time atoms — none survive.
 *   E. The AI-image rule (logic, callable core, publisher, rules).
 *   F. Privacy flags + gating (vision sanitizer, statuses, blur regions,
 *      approval refused until confirmed / blurred, publisher re-check).
 *   G. Publisher idempotency for video: FB Page video + IG Reels (resume the
 *      same container, two runs = one post), manual platforms.
 *   H. The render worker end to end with real ffmpeg (job photos re-encoded,
 *      vision flags → blur → drafts re-pointed), the emulator stub, the
 *      AI kill switch, the daily cap.
 *   I. Ingest: upload → metadata-stripped intermediate, raw always deleted,
 *      no slot → refused.
 *   J. Media route Range parsing + wiring (exports, rules, index, deps, page).
 *   K. Review hardening (post-merge review of #2171): blur radii inside
 *      ffmpeg's chroma limits, even dims for odd sources, ONE talking-head
 *      trim window for render + Whisper, confidence 0 stays 0, the Reel
 *      Studio on/off switch (default off) + kill switch, ffmpeg-static optional.
 *
 * Run: node tests/reel-studio-2026-10-04.test.js
 * Local real-ffmpeg: FFMPEG_PATH=/path/to/ffmpeg node tests/reel-studio-2026-10-04.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
// The storage trigger needs a bucket name at definition time.
process.env.FIREBASE_CONFIG = process.env.FIREBASE_CONFIG || JSON.stringify({ projectId: 'demo-reel', storageBucket: 'demo-reel.appspot.com' });
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-reel';

const RL = require(path.join(FN, 'reel-logic.js'));
const L = require(path.join(FN, 'social-logic.js'));
const A = require(path.join(FN, 'social-adapters.js'));
const P = require(path.join(FN, 'social-publisher.js'));
const RC = require(path.join(ROOT, 'docs', 'pro', 'js', 'reel-studio-logic.js'));
let RS = null, RF = null, SS = null, sharp = null;
try { RS = require(path.join(FN, 'reel-studio.js'))._test; SS = require(path.join(FN, 'social-studio.js'))._test; } catch (e) { console.log('  (functions deps missing: ' + e.message.split('\n')[0] + ')'); }
try { RF = require(path.join(FN, 'reel-ffmpeg.js')); } catch (_) { RF = null; }
try { sharp = require(require.resolve('sharp', { paths: [FN] })); } catch (_) { sharp = null; }
const FF = RF && RF.ffmpegPath();

const LEAD = {
  firstName: 'Margaret', lastName: 'Okonkwo', name: 'Margaret Okonkwo',
  address: '4417 Whispering Pines Dr, Florence, KY 41042', phone: '(859) 555-0142', email: 'margaret@example.org',
  lat: 38.99871, lng: -84.62661, acceptedTier: 'better', shingleLine: 'TAMKO Titan XT',
  stage: 'install_complete', stageRole: 'won', companyId: 'co1', userId: 'co1',
};
const TERMS = L.privateTerms(LEAD);

// ── Fakes ────────────────────────────────────────────────────────────────
function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
let autoId = 0;
function fakeDb() {
  const store = new Map();
  let chain = Promise.resolve();
  function setPath(obj, dotted, v) {
    const parts = dotted.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] && typeof o[parts[i]] === 'object' ? o[parts[i]] : {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = v;
  }
  function ref(p) {
    const r = {
      path: p, id: p.split('/').pop(),
      async get() { const d = store.get(p); return { exists: !!d, id: r.id, ref: r, data: () => clone(d) }; },
      async update(patch) {
        if (!store.has(p)) throw new Error('no doc ' + p);
        const cur = clone(store.get(p));
        for (const [k, v] of Object.entries(clone(patch))) { if (k.includes('.')) setPath(cur, k, v); else cur[k] = v; }
        store.set(p, cur);
      },
      async set(data, opts) { store.set(p, opts && opts.merge ? Object.assign({}, store.get(p) || {}, clone(data)) : clone(data)); },
      async delete() { store.delete(p); },
      collection: (name) => col(p + '/' + name),
    };
    return r;
  }
  function query(prefixOrName, group) {
    const filters = [];
    let lim = 1e9;
    const q = {
      where(f, op, v) { filters.push([f, op, v]); return q; },
      limit(n) { lim = n; return q; },
      async get() {
        const docs = [];
        for (const [p, d] of store) {
          const segs = p.split('/');
          if (group ? segs[segs.length - 2] !== prefixOrName : (p.slice(0, p.lastIndexOf('/')) !== prefixOrName)) continue;
          const pass = filters.every(([f, op, v]) => (op === '==' ? d[f] === v : op === 'in' ? v.includes(d[f]) : op === '<=' ? (d[f] != null && d[f] <= v) : op === '<' ? (d[f] != null && d[f] < v) : false));
          if (pass) docs.push({ ref: ref(p), id: segs[segs.length - 1], data: () => clone(store.get(p)) });
        }
        const out = docs.slice(0, lim);
        return { docs: out, size: out.length, forEach: (fn) => out.forEach(fn) };
      },
    };
    return q;
  }
  function col(prefix) {
    const c = query(prefix, false);
    c.doc = (id) => ref(prefix + '/' + (id || ('auto' + (++autoId))));
    return c;
  }
  return {
    store,
    doc: ref,
    collection: col,
    collectionGroup: (name) => query(name, true),
    runTransaction(fn) {
      const run = chain.then(async () => {
        const writes = [];
        const tx = { get: (r) => r.get(), update: (r, patch) => writes.push(['u', r, patch]), set: (r, d, o) => writes.push(['s', r, d, o]) };
        const out = await fn(tx);
        for (const [k, r, a, b] of writes) { if (k === 'u') await r.update(a); else await r.set(a, b); }
        return out;
      });
      chain = run.catch(() => {});
      return run;
    },
  };
}
function fakeBucket(files) {
  const f = files || new Map();
  const deleted = [];
  return {
    files: f, deleted,
    file: (p) => ({
      name: p,
      async download() { if (!f.has(p)) throw new Error('no such object ' + p); return [f.get(p)]; },
      async save(buf) { f.set(p, Buffer.from(buf)); },
      async delete() { deleted.push(p); f.delete(p); },
      async getMetadata() { return [{ size: (f.get(p) || []).length }]; },
    }),
    async getFiles() { return [[]]; },
  };
}
function graphStub(script) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const body = init && init.body ? Object.fromEntries(new URLSearchParams(init.body)) : Object.fromEntries(new URL(url).searchParams);
    const u = new URL(url);
    calls.push({ method: (init && init.method) || 'GET', path: u.pathname.replace('/' + A.GRAPH_VERSION, ''), body });
    const r = script(calls[calls.length - 1], calls.length);
    if (r instanceof Error) throw r;
    return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body || {} };
  };
  return { fetchFn, calls };
}
const META_ENV = { META_PAGE_ID: 'PAGE1', META_PAGE_ACCESS_TOKEN: 'tok', IG_BUSINESS_ACCOUNT_ID: 'IG1' };
const mediaUrl = (k) => 'https://nobigdealwithjoedeal.com/api/social-media?k=' + k;
const K1 = 'a'.repeat(32), K2 = 'b'.repeat(32), KT = 'c'.repeat(32), KAI = 'd'.repeat(32);

function seedReel(db, id, over) {
  db.store.set('companies/co1/reels/' + id, Object.assign({
    template: 'slideshow', aspect: '9:16', status: 'rendered', companyId: 'co1',
    output: { key: K1, thumbKey: KT, durationSec: 12 }, privacy: { status: 'clear', flags: [] }, postIds: [],
  }, over || {}));
}
function seedReelPost(db, id, over) {
  const p = 'companies/co1/social_posts/' + id;
  db.store.set(p, Object.assign({
    platform: 'facebook', kind: 'job_showcase', status: 'scheduled', scheduledAt: 1000, format: 'reel',
    caption: 'New roof in Florence, KY. Call or text me.', hashtags: ['#Florence', '#roofing'],
    media: [{ key: K1, role: 'video' }], video: { key: K1, thumbKey: KT, durationSec: 12, aspect: '9:16', thumbOffsetMs: 4000 },
    reelId: 'r1', companyId: 'co1', publish: { attempts: 0 },
  }, over || {}));
  return p;
}
function enable(db) { db.store.set('companies/co1/social_settings/config', { enabled: true, platforms: {} }); }

(async () => {
  // ── A. templates ────────────────────────────────────────────────────────
  console.log('A. templates — data-driven render plans');
  const bad = (req) => { try { RL.validateRequest(req); return null; } catch (e) { return e.message; } };
  ok('unknown template refused', /template/i.test(bad({ template: 'remotion', clips: [] })));
  ok('before/after needs exactly two', /needs 2/.test(bad({ template: 'before_after', clips: [{ type: 'photo' }] })));
  ok('drone cut takes video only', /video/.test(bad({ template: 'drone_cut', clips: [{ type: 'photo' }] })));
  ok('an AI-made clip can never go in a reel', /AI-made/.test(bad({ template: 'slideshow', clips: [{ type: 'photo', aiGenerated: true }] })));
  ok('every template exists with label + sources', RL.TEMPLATE_IDS.join() === 'before_after,drone_cut,slideshow,talking_head,job_of_week');
  const v1 = RL.validateRequest({ template: 'slideshow', aspect: 'weird', clips: [{ type: 'photo' }, { type: 'photo' }] });
  ok('unknown aspect falls back to 9:16', v1.aspect === '9:16');
  const plan1 = RL.buildPlan(v1, [{ file: 'c0.jpg', type: 'photo' }, { file: 'c1.jpg', type: 'photo' }], { title: 'New roof · Union, KY' });
  ok('plan: intro card + body + outro card', plan1.segments.length === 4 && plan1.segments[0].name === 's00.mp4' && plan1.segments[3].name === 's99.mp4');
  ok('plan: 1080x1920 for 9:16', plan1.w === 1080 && plan1.h === 1920 && plan1.segments[0].args.some((a) => /s=1080x1920/.test(a)));
  ok('plan: Ken Burns (zoompan) on each photo', plan1.segments.slice(1, 3).every((s) => s.args.some((a) => /zoompan=/.test(a))));
  ok('plan: brand logo + fonts on the cards', plan1.segments[0].args.includes('logo.png') && /BarlowCondensed-800\.ttf/.test(plan1.segments[0].args.join(' ')) && /0x1a3057/.test(plan1.segments[0].args.join(' ')));
  const allArgs = plan1.segments.map((s) => s.args.join(' ')).join(' ');
  ok('plan: on-screen text only via textfile= with expansion=none (no inline text=)', /textfile='t\d+\.txt':expansion=none/.test(allArgs) && !/[:=]text=/.test(allArgs));
  ok('plan: the title text lives in a text file, not the argv', plan1.segments[0].texts.some((t) => t.text === 'New roof · Union, KY') && !/Union/.test(allArgs));
  ok('plan: every segment strips metadata', plan1.segments.every((s) => s.args.join(' ').includes('-map_metadata -1') && s.args.includes('-dn')) && plan1.concat.args.join(' ').includes('-map_metadata -1'));
  const sq = RL.buildPlan(RL.validateRequest({ template: 'slideshow', aspect: '1:1', clips: [{ type: 'photo' }] }), [{ file: 'c0.jpg', type: 'photo' }], {});
  ok('plan: 1:1 option is 1080x1080', sq.w === 1080 && sq.h === 1080 && sq.segments[1].args.some((a) => /s=1080x1080/.test(a)));
  const many = RL.validateRequest({ template: 'slideshow', clips: Array.from({ length: 20 }, () => ({ type: 'photo' })), params: { perPhoto: 6 } });
  const planMany = RL.buildPlan(many, Array.from({ length: 20 }, (_, i) => ({ file: 'c' + i + '.jpg', type: 'photo' })), {});
  ok('plan: never longer than 90 s (20 photos × 6 s squeezed)', planMany.duration <= RL.MAX_DURATION_S && planMany.concat.args.includes(String(Math.min(planMany.duration, 90))));
  const ba = RL.buildPlan(RL.validateRequest({ template: 'before_after', clips: [{ type: 'photo' }, { type: 'video' }], params: { reveal: 'slide' } }), [{ file: 'c0.jpg', type: 'photo' }, { file: 'c1.mp4', type: 'video', durationSec: 10 }], {});
  ok('before/after: xfade reveal (slide) with BEFORE/AFTER labels', /xfade=transition=slideleft/.test(ba.segments[1].args.join(' ')) && ba.segments[1].texts.map((t) => t.text).join() === 'BEFORE,AFTER');
  ok('before/after: wipe is the default reveal', /wipeleft/.test(RL.buildPlan(RL.validateRequest({ template: 'before_after', clips: [{ type: 'photo' }, { type: 'photo' }] }), [{ file: 'a.jpg', type: 'photo' }, { file: 'b.jpg', type: 'photo' }], {}).segments[1].args.join(' ')));
  // drone
  const w1 = RL.pickBestWindow(100, 15);
  ok('drone: skips take-off and landing without scores', w1.start >= 12 && w1.end <= 90 && Math.abs(w1.end - w1.start - 15) < 0.01, JSON.stringify(w1));
  const scores = Array.from({ length: 100 }, (_, i) => (i >= 60 && i < 75 ? 0.08 : 0.005));
  scores[20] = 0.9; // one whip-pan spike is not "interesting"
  const w2 = RL.pickBestWindow(100, 15, scores);
  ok('drone: picks the steady-motion window, not a single spike', w2.start >= 59 && w2.start <= 61, JSON.stringify(w2));
  ok('drone: a short clip is used whole', JSON.stringify(RL.pickBestWindow(8, 15)) === JSON.stringify({ start: 0, end: 8 }));
  const parts = RL.droneParts({ start: 10, end: 30 }, true);
  ok('drone: speed ramp = 1x / 2x / 1x and shortens the cut', parts.length === 3 && parts[1].speed === 2 && RL.partsDuration(parts) === 16);
  const dr = RL.buildPlan(RL.validateRequest({ template: 'drone_cut', clips: [{ type: 'video' }], params: { seconds: 20, speedRamp: true } }), [{ file: 'c0.mp4', type: 'video', durationSec: 120 }], {}, { droneScores: null });
  ok('drone: plan trims + ramps (setpts 0.5) + blurred fill, silent', /setpts=0\.5\*/.test(dr.segments[1].args.join(' ')) && /boxblur/.test(dr.segments[1].args.join(' ')) && dr.segments[1].args.includes('1:a'));
  // talking head
  const th = RL.buildPlan(RL.validateRequest({ template: 'talking_head', clips: [{ type: 'video' }], params: { trimStart: 2, trimEnd: 12 } }),
    [{ file: 'c0.mp4', type: 'video', durationSec: 30, hasAudio: true }], { captionGroups: [{ text: 'Check your', start: 0.1, end: 0.9 }, { text: 'flashing first.', start: 1, end: 2.2 }, { text: 'late', start: 50, end: 51 }] });
  const thArgs = th.segments[1].args.join(' ');
  ok('talking head: trim 2–12 s on video AND audio', /trim=start=2:end=12/.test(thArgs) && /atrim=start=2:end=12/.test(thArgs) && th.segments[1].duration === 10);
  ok('talking head: one drawtext per caption line, timed', (thArgs.match(/drawtext=/g) || []).length === 2 && /between\(t,0\.1,0\.9\)/.test(thArgs) && /between\(t,1,2\.2\)/.test(thArgs));
  ok('talking head: captions sit in the bottom-safe area (y = 70% of 9:16)', /y=h\*0\.70/.test(thArgs));
  ok('talking head: captions off → no drawtext', !/drawtext/.test(RL.buildPlan(RL.validateRequest({ template: 'talking_head', clips: [{ type: 'video' }], params: { captions: false } }), [{ file: 'c0.mp4', type: 'video', durationSec: 30, hasAudio: true }], { captionGroups: [{ text: 'x y', start: 0, end: 1 }] }).segments[1].args.join(' ')));
  // job of the week
  const lines = RL.jobOfWeekLines(L.jobFacts(LEAD), TERMS);
  ok('job of the week: town, package (tier), shingle — nothing else', lines.join('|') === 'Florence, KY|Better package|TAMKO Titan XT', lines.join('|'));
  const jw = RL.buildPlan(RL.validateRequest({ template: 'job_of_week', clips: [{ type: 'photo' }] }), [{ file: 'c0.jpg', type: 'photo' }], { lines });
  ok('job of the week: header + lines on the photo', jw.segments[1].texts.map((t) => t.text).join('|') === 'JOB OF THE WEEK|Florence, KY|Better package|TAMKO Titan XT');
  ok('job of the week: no price ever reaches the screen', !/\$|\d{3,}/.test(JSON.stringify(jw.segments.map((s) => s.texts))));
  ok('every template maps showcase templates to job_showcase posts', RL.reelPostKind('slideshow', 'tip') === 'job_showcase' && RL.reelPostKind('talking_head', 'storm_psa') === 'storm_psa' && RL.reelPostKind('talking_head', 'nope') === 'tip');

  // ── B. caption grouping ─────────────────────────────────────────────────
  console.log('B. caption grouping');
  const W = (s, t0, step) => s.split(' ').map((w, i) => ({ word: w, start: t0 + i * step, end: t0 + i * step + step * 0.9 }));
  const g1 = RL.groupWords(W('Look up at your roof after a big wind storm today.', 0, 0.3));
  ok('lines are 2–4 words', g1.every((g) => { const n = g.text.split(' ').length; return n >= 2 && n <= 4; }), JSON.stringify(g1.map((g) => g.text)));
  ok('no line passes 22 characters', g1.every((g) => g.text.length <= 22));
  ok('words keep their order and none are lost', g1.map((g) => g.text).join(' ') === 'Look up at your roof after a big wind storm today.');
  const g2 = RL.groupWords(W('Done. Next one', 0, 0.3).concat(W('after lunch', 5, 0.3)));
  ok('breaks after a sentence and on a long pause', g2.map((g) => g.text).join('|') === 'Done. Next one|after lunch', g2.map((g) => g.text).join('|'));
  ok('a lone trailing word merges into the line before when it fits', RL.groupWords(W('Call or text me', 0, 0.2)).map((g) => g.text).join('|') === 'Call or text me');
  ok('times are increasing and each line shows ≥ 0.5 s when room allows', g1.every((g, i) => g.end > g.start && (i === 0 || g.start >= g1[i - 1].start)) && RL.groupWords([{ word: 'Hi', start: 0, end: 0.1 }, { word: 'there', start: 0.1, end: 0.2 }])[0].end >= 0.5);
  const segW = RL.wordsFromSegments([{ start: 1, end: 3, text: ' four words in here ' }]);
  ok('segment-only transcripts spread words evenly', segW.length === 4 && segW[0].start === 1 && segW[3].end === 3);
  ok('garbage words are ignored', RL.groupWords([{ word: '', start: 0, end: 1 }, { word: 'ok', start: NaN, end: 1 }, null]).length === 0);

  // ── C. safety filter ────────────────────────────────────────────────────
  console.log('C. safety filter on captions + on-screen text');
  const said = W('We finished the roof for Margaret today.', 0, 0.3)
    .concat(W('It is at 4417 Whispering Pines Dr.', 3, 0.3))
    .concat(W('We handle your insurance claim start to finish.', 6, 0.3))
    .concat(W('Know your deductible.', 9, 0.3))
    .concat(W('Clean lines and a clean yard.', 11, 0.3));
  const fl = RL.filterTranscriptWords(said, TERMS);
  const kept = fl.words.map((w) => w.word).join(' ');
  ok('caption sentence naming the customer is removed', !/Margaret/.test(kept));
  ok('caption sentence with the street / house number is removed', !/4417|Whispering/.test(kept));
  ok('Kentucky claim-handling wording is removed', !/handle/.test(kept));
  ok('anything about deductibles is removed', !/deductible/i.test(kept));
  ok('clean speech survives as captions', kept === 'Clean lines and a clean yard.', kept);
  ok('every removal is reported (the audio still says it)', fl.dropped.length === 4 && fl.dropped.every((d) => /^(private|street|ky:|social:)/.test(d.rule)), JSON.stringify(fl.dropped.map((d) => d.rule)));
  ok('on-screen text: a customer name is blanked', RL.safeOverlayText('Margaret’s new roof', TERMS).text === '');
  ok('on-screen text: prices / cost / margin are refused', ['$12,400 roof', 'Only 9800 dollars', 'Cost per sq', 'Great margin'].every((t) => RL.safeOverlayText(t, []).text === '' && RL.safeOverlayText(t, []).dropped === 'price'));
  ok('on-screen text: a phone / email / GPS is blanked', RL.safeOverlayText('Call 859-555-0142', TERMS).text === '' && RL.safeOverlayText('margaret@example.org', TERMS).text === '' && RL.safeOverlayText('38.99871, -84.62661', []).text === '');
  ok('on-screen text: a clean title passes untouched', RL.safeOverlayText('New roof · Florence, KY', TERMS).text === 'New roof · Florence, KY');

  // ── D. metadata stripping ──────────────────────────────────────────────
  console.log('D. metadata stripping (GPS) — argv + real ffmpeg');
  const na = RL.normalizeArgs('raw', 'norm.mp4');
  const naj = na.join(' ');
  ok('normalize: global + per-stream metadata dropped', naj.includes('-map_metadata -1') && naj.includes('-map_metadata:s:v -1') && naj.includes('-map_metadata:s:a -1'));
  ok('normalize: data / subtitle streams + chapters dropped, only first video + audio mapped', na.includes('-dn') && na.includes('-sn') && naj.includes('-map_chapters -1') && naj.includes('-map 0:v:0 -map 0:a:0?'));
  ok('normalize: first 180 s only, 30 fps, H.264 + AAC, faststart', naj.includes('-t 180') && naj.includes('libx264') && naj.includes('-c:a aac') && naj.includes('+faststart'));
  ok('frame + audio + blur argv strip metadata too', [RL.frameArgs('a', 1, 'b'), RL.audioArgs('a', 0, 1, 'b'), RL.blurArgs('a', 'b', [{ x: 0, y: 0, w: 16, h: 16, start: 0, end: 1 }])].every((x) => x.join(' ').includes('-map_metadata -1')));
  if (!FF) {
    ok('ffmpeg unavailable here — real-ffmpeg checks SKIPPED (CI installs ffmpeg-static with functions deps)', true);
  } else {
    await RF.withWorkDir(async (dir) => {
      await RF.run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2',
        '-metadata', 'location=+38.9987-084.6266/', '-metadata', 'com.apple.quicktime.location.ISO6709=+38.9987-084.6266+000.000/',
        '-metadata', 'make=ZZPhone', '-metadata', 'creation_time=2026-10-01T10:00:00Z',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mov', '-movflags', 'use_metadata_tags', 'gps.mov'], { cwd: dir });
      const src = fs.readFileSync(path.join(dir, 'gps.mov'));
      const srcProbe = await RF.run(['-hide_banner', '-i', 'gps.mov'], { cwd: dir, allowFail: true });
      ok('positive control: the source clip carries the GPS + device atoms', src.includes(Buffer.from('+38.9987')) && /location/.test(srcProbe.stderr) && src.includes(Buffer.from('ZZPhone')));
      const pr = await RF.normalize(path.join(dir, 'gps.mov'), path.join(dir, 'clean.mp4'));
      const out = fs.readFileSync(path.join(dir, 'clean.mp4'));
      const outProbe = await RF.run(['-hide_banner', '-i', 'clean.mp4'], { cwd: dir, allowFail: true });
      ok('normalized clip: no GPS bytes, no ©xyz / ISO6709 location atom', !out.includes(Buffer.from('+38.9987')) && !out.includes(Buffer.from('©xyz', 'latin1')) && !out.includes(Buffer.from('ISO6709')));
      ok('normalized clip: no device make, no creation_time', !out.includes(Buffer.from('ZZPhone')) && !/creation_time|location|make\s*:/.test(outProbe.stderr), outProbe.stderr.slice(0, 400));
      ok('normalized clip still plays (video + audio, 2 s)', pr.hasVideo && pr.hasAudio && Math.abs(pr.durationSec - 2) < 0.2, JSON.stringify(pr));
    });
  }

  // ── E. AI-image rule ────────────────────────────────────────────────────
  console.log('E. AI images — tip / storm PSA only, never real work');
  ok('allowed kinds are exactly tip + storm_psa', RL.AI_IMAGE_KINDS.join() === 'tip,storm_psa' && !RL.aiImageAllowedFor('job_showcase') && !RL.aiImageAllowedFor('review') && !RL.aiImageAllowedFor('behind_scenes'));
  const idx = { [KAI]: { aiGenerated: true }, [K1]: {} };
  ok('rule: AI image on a tip post → ok', RL.checkAiImageRule({ kind: 'tip', media: [{ key: KAI }] }, idx).ok);
  ok('rule: AI image on a job showcase → refused', !RL.checkAiImageRule({ kind: 'job_showcase', media: [{ key: KAI }] }, idx).ok);
  ok('rule: aiGenerated flag on a showcase → refused even without the index', !RL.checkAiImageRule({ kind: 'job_showcase', aiGenerated: true, media: [] }, {}).ok);
  ok('rule: AI image inside a reel post → refused', !RL.checkAiImageRule({ kind: 'tip', format: 'reel', media: [{ key: KAI }] }, idx).ok);
  ok('rule: a real photo on a showcase → ok', RL.checkAiImageRule({ kind: 'job_showcase', media: [{ key: K1 }] }, idx).ok);
  {
    const db = fakeDb();
    db.store.set('social_media/' + KAI, { aiGenerated: true, path: 'social-media/co1/' + KAI + '.jpg' });
    const b1 = await P.postBlockers(db, 'co1', { kind: 'job_showcase', media: [{ key: KAI }] });
    const b2 = await P.postBlockers(db, 'co1', { kind: 'storm_psa', media: [{ key: KAI }] });
    ok('postBlockers (approval + publish): AI media on a showcase blocked via the media index', b1 && b1.code === 'ai_image_rule' && b2 === null);
    enable(db);
    const p = 'companies/co1/social_posts/ai1';
    db.store.set(p, { platform: 'facebook', kind: 'job_showcase', status: 'scheduled', scheduledAt: 1, caption: 'Call or text me.', hashtags: [], media: [{ key: KAI }], publish: {} });
    const g = graphStub(() => ({ body: { id: 'x', post_id: 'PAGE1_1' } }));
    const alerts = [];
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl, alert: async (e) => alerts.push(e) });
    ok('publisher refuses an AI image dressed as a job showcase (no Graph call, alert)', db.store.get(p).status === 'failed' && db.store.get(p).failReason === 'ai_image_rule' && g.calls.length === 0 && alerts.length === 1);
  }
  if (RS) {
    const db = fakeDb(); const bucket = fakeBucket();
    const ctx = { uid: 'co1', companyId: 'co1' };
    db.store.set('companies/co1/reel_media/m1', { purpose: 'ai_image', aiGenerated: true, postKind: 'tip', status: 'ready', workPath: 'reel-work/co1/m1.jpg' });
    bucket.files.set('reel-work/co1/m1.jpg', Buffer.from('jpegbytes'));
    let err = null;
    try { await RS.aiImagePostsFor(db, bucket, ctx, 'm1', { kind: 'job_showcase', platforms: ['facebook'] }); } catch (e) { err = e; }
    ok('callable core: an AI image can never become a job showcase post', err && /tip and storm-season/.test(err.message));
    const res = await RS.aiImagePostsFor(db, bucket, ctx, 'm1', { platforms: ['facebook', 'instagram'] });
    const posts = res.created.map((c) => db.store.get('companies/co1/social_posts/' + c.id));
    ok('callable core: tip drafts tagged aiGenerated with an honest caption', posts.length === 2 && posts.every((x) => x.aiGenerated === true && x.kind === 'tip' && x.status === 'draft' && /made with AI/.test(x.caption)));
    const key = posts[0].media[0].key;
    ok('…and the served copy is indexed as AI-generated', db.store.get('social_media/' + key).aiGenerated === true);
    db.store.set('companies/co1/reel_media/m2', { purpose: 'clip', aiGenerated: false, status: 'ready', workPath: 'x' });
    err = null; try { await RS.aiImagePostsFor(db, bucket, ctx, 'm2', {}); } catch (e) { err = e; }
    ok('callable core: a real photo cannot be posted through the AI path', err && /not found/.test(err.message));
  }
  const rules = read('firestore.rules');
  ok('rules: client may not create a post carrying reelId / video / aiGenerated', /hasAny\(\['approvedAt', 'approvedBy', 'publish', 'platformPostId', 'sourceLeadId', 'reelId', 'video', 'aiGenerated'\]\)/.test(rules));
  ok('rules: aiGenerated / reelId / video frozen on update + AI never a showcase', /'captionFilter', 'reelId', 'video', 'aiGenerated'\]\)\s*&& socialAiRuleOk\(\)/.test(rules) && /get\('aiGenerated', false\) == true\s*&& request\.resource\.data\.get\('kind', ''\) == 'job_showcase'/.test(rules));

  // ── F. privacy flags + gating ───────────────────────────────────────────
  console.log('F. privacy flags + approval gating');
  const times = RL.frameTimes(20);
  ok('frames: one every 2 s from 0.5 s', times[0] === 0.5 && times[1] === 2.5 && times.length === 10);
  ok('frames: capped (90 s → ≤ 45 frames)', RL.frameTimes(90).length <= RL.MAX_FRAMES);
  const sv = RL.sanitizeVision({ frames: [
    { i: 1, flags: [{ type: 'house_number', box: [0.1, 0.2, 0.05, 0.04], confidence: 0.9 }, { type: 'pet', confidence: 0.9 }, { type: 'face', confidence: 0.1 }] },
    { i: 2, flags: [{ type: 'license_plate', box: [2, -1, 5, 5], confidence: 0.8 }], heroScore: 0.99 },
    { i: 3, flags: [], heroScore: 0.7 }, { i: 99, flags: [{ type: 'face', confidence: 1 }] },
  ] }, times);
  ok('vision: unknown types, low confidence and out-of-range frames dropped', sv.flags.length === 2 && sv.flags[0].type === 'house_number' && sv.flags[0].t === 2.5);
  ok('vision: boxes clamped to the frame (or null)', JSON.stringify(sv.flags[0].box) === '[0.1,0.2,0.05,0.04]' && sv.flags[1].box === null);
  ok('vision: hero = best-scored frame with nothing flagged', sv.heroIndex === 3);
  ok('status: clear / flagged / unchecked', RL.privacyStatusFrom({ ran: true, flags: [] }) === 'clear' && RL.privacyStatusFrom({ ran: true, flags: [1] }) === 'flagged' && RL.privacyStatusFrom({ ran: true, flags: [], speechDropped: [1] }) === 'flagged' && RL.privacyStatusFrom({ ran: false }) === 'unchecked');
  const rd = (pv) => ({ status: 'rendered', output: { key: K1 }, privacy: pv });
  ok('gate: flagged → NOT approvable', !RL.canApproveReel(rd({ status: 'flagged' })).ok);
  ok('gate: unchecked (AI off / vision failed) → NOT approvable', !RL.canApproveReel(rd({ status: 'unchecked' })).ok);
  ok('gate: pending / still rendering → NOT approvable', !RL.canApproveReel(rd({ status: 'pending' })).ok && !RL.canApproveReel({ status: 'rendering', privacy: { status: 'clear' } }).ok);
  ok('gate: clear / confirmed / blurred → approvable', ['clear', 'confirmed', 'blurred'].every((s) => RL.canApproveReel(rd({ status: s })).ok));
  ok('blur offered only when every flag has a box and no speech was removed',
    RL.blurAvailable({ privacy: { status: 'flagged', flags: [{ box: [0, 0, 0.1, 0.1] }] } }) &&
    !RL.blurAvailable({ privacy: { status: 'flagged', flags: [{ box: [0, 0, 0.1, 0.1] }, { box: null }] } }) &&
    !RL.blurAvailable({ privacy: { status: 'flagged', flags: [{ box: [0, 0, 0.1, 0.1] }], speechDropped: [{}] } }) &&
    !RL.blurAvailable({ privacy: { status: 'unchecked', flags: [] } }));
  const regs = RL.blurRegions([{ t: 2.5, box: [0.1, 0.2, 0.05, 0.04] }, { t: 4.5, box: [0.11, 0.21, 0.05, 0.04] }, { t: 30, box: [0.7, 0.7, 0.1, 0.1] }], 1080, 1920, 40);
  ok('blur regions: consecutive flags on the same spot merge; time ranges cover the gap', regs.length === 2 && regs[0].start === 1.3 && regs[0].end === 5.7, JSON.stringify(regs));
  ok('blur regions: even pixel boxes inside the frame', regs.every((r) => r.x % 2 === 0 && r.w % 2 === 0 && r.x + r.w <= 1080 && r.y + r.h <= 1920));
  ok('blur argv: crop + boxblur + overlay enabled only in the flagged range', /crop=\d+:\d+:\d+:\d+,boxblur/.test(RL.blurArgs('in.mp4', 'out.mp4', regs).join(' ')) && /enable='between\(t,1\.3,5\.7\)'/.test(RL.blurArgs('in.mp4', 'out.mp4', regs).join(' ')));
  // client mirrors the server gate
  ok('page logic mirrors the gate (flagged: confirm, blur; not approvable)', (() => { const v = RC.privacyView(rd({ status: 'flagged', flags: [{ type: 'face', t: 3, box: [0, 0, 0.2, 0.2] }] })); return v.canConfirm && v.canBlur && !v.approvable && /face/.test(v.lines[0]); })());
  ok('page logic: unchecked → confirm only; clear → approvable', RC.privacyView(rd({ status: 'unchecked' })).canConfirm && !RC.privacyView(rd({ status: 'unchecked' })).canBlur && RC.privacyView(rd({ status: 'clear' })).approvable);
  {
    const db = fakeDb(); enable(db);
    seedReel(db, 'r1', { privacy: { status: 'flagged', flags: [{ type: 'face', t: 3, box: null }] } });
    const p = seedReelPost(db, 'p1');
    const g = graphStub(() => ({ body: { id: 'v1' } }));
    const alerts = [];
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl, alert: async (e) => alerts.push(e) });
    ok('publisher: a flagged reel never posts (failed reel_privacy, alert, zero Graph calls)', db.store.get(p).status === 'failed' && db.store.get(p).failReason === 'reel_privacy' && g.calls.length === 0 && alerts.length === 1);
    const b = await P.postBlockers(db, 'co1', { format: 'reel', reelId: 'r1', media: [{ key: K1 }] });
    ok('approval uses the same gate (socialApprovePost → postBlockers)', b && b.code === 'reel_privacy' && /approvalBlockers\(db, ctx\.companyId, post\)/.test(read('functions/social-studio.js')));
    seedReel(db, 'r2', { privacy: { status: 'confirmed', flags: [] }, output: { key: K2 } });
    const st = await P.postBlockers(db, 'co1', { format: 'reel', reelId: 'r2', media: [{ key: K1 }] });
    ok('a post still pointing at the pre-blur MP4 is refused (reel_stale)', st && st.code === 'reel_stale');
    const miss = await P.postBlockers(db, 'co1', { format: 'reel', media: [{ key: K1 }] });
    ok('a video post without its reel is refused', miss && miss.code === 'reel_missing');
  }

  // ── G. publisher idempotency for video ──────────────────────────────────
  console.log('G. publisher — video, idempotent');
  {
    const db = fakeDb(); enable(db); seedReel(db, 'r1'); const p = seedReelPost(db, 'p1');
    const g = graphStub((c) => (c.path === '/PAGE1/videos' ? { body: { id: 'vid9' } } : { status: 404, body: { error: { message: 'unexpected', code: 100 } } }));
    const deps = { db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl };
    const c1 = await P.runPublisher(deps);
    const c2 = await P.runPublisher(Object.assign({}, deps, { nowMs: 9000 }));
    ok('FB Page video: one POST /PAGE1/videos with file_url = our public MP4 URL', g.calls.length === 1 && g.calls[0].path === '/PAGE1/videos' && g.calls[0].body.file_url === mediaUrl(K1) && /New roof/.test(g.calls[0].body.description));
    ok('FB video: posted with the video URL; second run does nothing', c1.posted === 1 && c2.posted === 0 && db.store.get(p).status === 'posted' && db.store.get(p).postUrl === 'https://www.facebook.com/PAGE1/videos/vid9');
    ok('the MP4 URL is our media route, never a Storage token', !/token=|firebasestorage/.test(g.calls[0].body.file_url));
  }
  {
    const db = fakeDb(); enable(db); seedReel(db, 'r1'); seedReelPost(db, 'p1');
    let vids = 0;
    const g = graphStub((c) => { if (c.path.endsWith('/videos')) vids++; return { body: { id: 'v' + vids } }; });
    const deps = { db, adapters: A.makeAdapters(META_ENV, g.fetchFn), nowMs: 5000, mediaUrl };
    const [a, b] = await Promise.all([P.runPublisher(deps), P.runPublisher(deps)]);
    ok('two OVERLAPPING runs = one FB video (claim before publish)', vids === 1 && a.posted + b.posted === 1);
  }
  {
    const db = fakeDb(); enable(db); seedReel(db, 'r1'); const p = seedReelPost(db, 'p1', { platform: 'instagram' });
    let containers = 0, statusChecks = 0, publishes = 0, ready = false;
    const g = graphStub((c) => {
      if (c.method === 'POST' && c.path === '/IG1/media') { containers++; return { body: { id: '17890001' } }; }
      if (c.method === 'GET' && c.path === '/17890001') { statusChecks++; return { body: { status_code: ready ? 'FINISHED' : 'IN_PROGRESS' } }; }
      if (c.path === '/IG1/media_publish') { publishes++; return { body: { id: '17990002' } }; }
      if (c.method === 'GET' && c.body.fields === 'permalink') return { body: { permalink: 'https://www.instagram.com/reel/xyz/' } };
      return { status: 404, body: { error: { message: 'unexpected ' + c.path, code: 100 } } };
    });
    const ad = A.makeAdapters(META_ENV, g.fetchFn, { sleep: async () => {}, reelPolls: 2 });
    await P.runPublisher({ db, adapters: ad, nowMs: 5000, mediaUrl });
    let d = db.store.get(p);
    ok('IG Reels: REELS container with video_url, share_to_feed, cover_url', containers === 1 && g.calls[0].body.media_type === 'REELS' && g.calls[0].body.video_url === mediaUrl(K1) && g.calls[0].body.share_to_feed === 'true' && g.calls[0].body.cover_url === mediaUrl(KT));
    ok('IG Reels: still processing → back to scheduled with resume.containerId (retryable)', d.status === 'scheduled' && d.publish.resume && d.publish.resume.containerId === '17890001' && d.publish.attempts === 1 && publishes === 0);
    ready = true;
    await P.runPublisher({ db, adapters: ad, nowMs: d.publish.nextAttemptAtMs, mediaUrl });
    d = db.store.get(p);
    ok('IG Reels: the next attempt polls the SAME container — never a second upload', containers === 1 && publishes === 1 && d.status === 'posted' && d.postUrl === 'https://www.instagram.com/reel/xyz/' && d.publish.resume === null);
    await P.runPublisher({ db, adapters: ad, nowMs: 9e12, mediaUrl });
    ok('IG Reels: a later run does nothing (two runs = one post)', publishes === 1 && containers === 1);
  }
  {
    const db = fakeDb(); enable(db); seedReel(db, 'r1'); const p = seedReelPost(db, 'p1', { platform: 'instagram' });
    const alerts = [];
    const g = graphStub((c) => (c.method === 'POST' && c.path === '/IG1/media' ? { body: { id: '17890001' } } : c.method === 'GET' ? { body: { status_code: 'ERROR' } } : { body: {} }));
    await P.runPublisher({ db, adapters: A.makeAdapters(META_ENV, g.fetchFn, { sleep: async () => {} }), nowMs: 5000, mediaUrl, alert: async (e) => alerts.push(e) });
    ok('IG Reels: container ERROR → failed + alert (definite, not retried)', db.store.get(p).status === 'failed' && db.store.get(p).failReason === 'error' && alerts.length === 1);
  }
  {
    const db = fakeDb(); enable(db); seedReel(db, 'r1'); const p = seedReelPost(db, 'p1', { platform: 'instagram' });
    let publishes = 0;
    const g = graphStub((c) => {
      if (c.method === 'POST' && c.path === '/IG1/media') return { body: { id: '17890001' } };
      if (c.method === 'GET') return { body: { status_code: 'FINISHED' } };
      if (c.path === '/IG1/media_publish') { publishes++; return new Error('socket hang up'); }
      return { body: {} };
    });
    const deps = { db, adapters: A.makeAdapters(META_ENV, g.fetchFn, { sleep: async () => {} }), nowMs: 5000, mediaUrl, alert: async () => {} };
    await P.runPublisher(deps);
    await P.runPublisher(Object.assign({}, deps, { nowMs: 9e12 }));
    ok('IG Reels: network drop on media_publish → outcome unknown, never retried', db.store.get(p).failReason === 'outcome_unknown' && publishes === 1);
  }
  {
    const db = fakeDb(); enable(db); seedReel(db, 'r1');
    const p1 = seedReelPost(db, 'p1', { platform: 'tiktok' });
    const p2 = seedReelPost(db, 'p2', { platform: 'gbp' });
    const g = graphStub(() => ({ body: {} }));
    const env = Object.assign({ SOCIAL_GBP_ENABLED: 'true', GBP_CLIENT_ID: 'a', GBP_CLIENT_SECRET: 'b', GBP_REFRESH_TOKEN: 'c', GBP_ACCOUNT_ID: 'd', GBP_LOCATION_ID: 'e' }, META_ENV);
    const c = await P.runPublisher({ db, adapters: A.makeAdapters(env, g.fetchFn, { getGbpAccessToken: async () => 't' }), nowMs: 5000, mediaUrl });
    ok('reels on TikTok / GBP (no video adapter) → Ready to post with a Download-MP4 reason', c.ready === 2 && db.store.get(p1).status === 'ready' && /Download MP4/.test(db.store.get(p2).readyReason) && g.calls.length === 0);
  }
  ok('adapters: FB + IG declare video; GBP + manual do not', (() => { const a = A.makeAdapters(META_ENV, null); return a.facebook.video === true && a.instagram.video === true && !a.gbp.video && !a.tiktok.video; })());

  // ── H. render worker ────────────────────────────────────────────────────
  console.log('H. render worker — real ffmpeg, stub, kill switch, cap');
  if (!RS) {
    ok('functions deps missing — worker tests SKIPPED', true);
  } else {
    // Daily cap
    {
      const db = fakeDb();
      let n = 0, err = null;
      try { for (let i = 0; i < 5; i++) { await RS.takeRenderSlot(db, 'co1', Date.UTC(2026, 9, 4, 16), 3); n++; } } catch (e) { err = e; }
      ok('daily render cap: the 4th render of the day is refused', n === 3 && err && /daily cap/.test(err.message));
      ok('…and the counter is per Eastern day', await RS.takeRenderSlot(db, 'co1', Date.UTC(2026, 9, 5, 16), 3) === 1);
    }
    const baseDeps = (db, bucket, extra) => Object.assign({
      db, bucket, ff: RF, logger: null, stub: false, nowMs: Date.now(),
      reencode: async (buf) => (sharp ? sharp(buf).rotate().jpeg().toBuffer() : buf),
      visionGate: async () => null, meter: async () => {}, reelsGate: async () => null,
      vision: async () => ({ ran: true, raw: { frames: [] }, costUsd: 0.01 }),
      transcribeGate: async () => null, transcribe: async () => ({ words: [], segments: [] }),
    }, extra || {});
    // Emulator stub: no ffmpeg needed, privacy unchecked → confirm required.
    {
      const db = fakeDb(); const bucket = fakeBucket();
      db.store.set('companies/co1/reels/rs', { template: 'slideshow', aspect: '9:16', params: {}, clips: [{ source: 'job_photo', type: 'photo', storagePath: 'photos/co1/x.jpg' }], status: 'queued', op: 'render', companyId: 'co1', requestedBy: 'co1', facts: {} });
      let visionCalls = 0;
      const ffStub = Object.assign({}, RF, { ffmpegPath: () => null, probe: async () => ({ durationSec: 3 }) });
      const res = await RS.processReel('co1', 'rs', baseDeps(db, bucket, { ff: ffStub, stub: true, reencode: async () => Buffer.from('jpg'), vision: async () => { visionCalls++; return { ran: true, raw: { frames: [] } }; } }));
      const r = db.store.get('companies/co1/reels/rs');
      ok('emulator stub: renders without ffmpeg (stub MP4 stored)', res.ok && r.status === 'rendered' && r.output.stub === true && bucket.files.has('social-media/co1/' + r.output.key + '.mp4'));
      ok('emulator stub: no vision call; privacy unchecked → must be confirmed', visionCalls === 0 && r.privacy.status === 'unchecked' && !RL.canApproveReel(r).ok);
      const again = await RS.processReel('co1', 'rs', baseDeps(db, bucket, { ff: ffStub, stub: true }));
      ok('worker claim: a rendered reel is not re-rendered by a second trigger', again.skipped === true);
    }
    if (!FF || !sharp) {
      ok('ffmpeg/sharp unavailable — real render SKIPPED (CI runs it)', true);
    } else {
      const db = fakeDb(); const bucket = fakeBucket();
      db.store.set('leads/L1', LEAD);
      const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 160, g: 90, b: 50 } } }).jpeg()
        .withExifMerge({ IFD0: { Make: 'ZZPhone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 59/1 55/1', GPSLongitudeRef: 'W', GPSLongitude: '84/1 37/1 36/1' } }).toBuffer();
      bucket.files.set('photos/co1/after.jpg', photo);
      db.store.set('companies/co1/reels/rr', {
        template: 'job_of_week', aspect: '1:1', params: RL.validateRequest({ template: 'job_of_week', clips: [{ type: 'photo' }], params: { perPhoto: 2 } }).params,
        clips: [{ source: 'job_photo', type: 'photo', storagePath: 'photos/co1/after.jpg' }], status: 'queued', op: 'render',
        companyId: 'co1', requestedBy: 'co1', sourceLeadId: 'L1', facts: L.jobFacts(LEAD), postIds: [],
      });
      let framesSeen = 0, metered = 0;
      const t0 = Date.now();
      const res = await RS.processReel('co1', 'rr', baseDeps(db, bucket, {
        meter: async (uid, usd) => { metered += usd; },
        vision: async (frames) => { framesSeen = frames.length; return { ran: true, costUsd: 0.02, raw: { frames: frames.map((f, i) => ({ i, flags: i === 1 ? [{ type: 'house_number', box: [0.4, 0.4, 0.1, 0.05], confidence: 0.9 }] : [], heroScore: i === 2 ? 0.9 : 0.1 })) } }; },
      }));
      const r = db.store.get('companies/co1/reels/rr');
      ok('real render: job of the week, 1:1, rendered + stored', res.ok && r.status === 'rendered' && bucket.files.has('social-media/co1/' + r.output.key + '.mp4'), JSON.stringify(res) + ' ' + (Date.now() - t0) + 'ms');
      const mp4 = bucket.files.get('social-media/co1/' + (r.output && r.output.key) + '.mp4') || Buffer.alloc(0);
      ok('real render: ≤ 90 s, intro + photo + outro (≈ 6.5 s)', !!r.output && r.output.durationSec > 5 && r.output.durationSec < 8, String(r.output && r.output.durationSec));
      ok('real render: the output carries no EXIF / GPS / device name from the job photo', !mp4.includes(Buffer.from('ZZPhone')) && !mp4.includes(Buffer.from('Exif')));
      ok('real render: frames sampled every ~2 s went to vision, cost metered', framesSeen >= RL.frameTimes(r.output.durationSec).length - 1 && framesSeen >= 3 && Math.abs(metered - 0.02) < 1e-9);
      ok('real render: house number flagged with a box → flagged, blur available, not approvable', r.privacy.status === 'flagged' && r.privacy.flags.length === 1 && RL.blurAvailable(r) && !RL.canApproveReel(r).ok);
      ok('real render: hero thumbnail = the vision pick, stored as a JPEG', r.privacy.heroT === RL.frameTimes(r.output.durationSec)[2] && bucket.files.has('social-media/co1/' + r.output.thumbKey + '.jpg'));
      ok('real render: the index doc serves it as video/mp4', db.store.get('social_media/' + r.output.key).contentType === 'video/mp4' && db.store.get('social_media/' + r.output.key).kind === 'reel');
      // To Social Studio, then blur.
      const sent = await RS.reelPostsFor(db, { uid: 'co1', companyId: 'co1' }, 'rr', r, { platforms: ['facebook', 'instagram'] });
      const posts = sent.created.map((c) => db.store.get('companies/co1/social_posts/' + c.id));
      ok('reel → Social Studio drafts (format reel, video key, scheduled tomorrow, showcase kind)', posts.length === 2 && posts.every((p) => p.status === 'draft' && p.format === 'reel' && p.video.key === r.output.key && p.kind === 'job_showcase' && p.reelId === 'rr' && p.scheduledAt));
      ok('reel drafts: caption + tags name the town only, never the customer', !/Margaret|Okonkwo|Whispering|4417|41042/.test(JSON.stringify(posts)) && /Florence/.test(posts[0].caption));
      db.store.set('companies/co1/reels/rr', Object.assign(db.store.get('companies/co1/reels/rr'), { postIds: sent.created.map((c) => c.id), status: 'queued', op: 'blur', blurRequestedBy: 'co1' }));
      const oldKey = r.output.key;
      const bres = await RS.processReel('co1', 'rr', baseDeps(db, bucket));
      const rb = db.store.get('companies/co1/reels/rr');
      ok('blur: re-rendered → privacy blurred → approvable', bres.ok && rb.privacy.status === 'blurred' && rb.privacy.blurRegions.length === 1 && RL.canApproveReel(rb).ok && rb.output.key !== oldKey);
      const after = sent.created.map((c) => db.store.get('companies/co1/social_posts/' + c.id));
      ok('blur: the drafts now point at the blurred MP4 and need approval again', after.every((p) => p.media[0].key === rb.output.key && p.video.key === rb.output.key && p.status === 'draft'));
      ok('blur: the unblurred MP4 is deleted', !bucket.files.has('social-media/co1/' + oldKey + '.mp4') && !db.store.has('social_media/' + oldKey));
      const okNow = await P.postBlockers(db, 'co1', after[0]);
      ok('blur: the gate now lets the post through', okNow === null);
    }
    // AI kill switch / budget → no vision, unchecked.
    {
      const db = fakeDb();
      const k = await RS.visionBlocked(db, 'u1', 'co1', { aiDisabled: async () => true, emulator: false, apiKey: 'x' });
      const e = await RS.visionBlocked(db, 'u1', 'co1', { aiDisabled: async () => false, emulator: true, apiKey: 'x' });
      const n = await RS.visionBlocked(db, 'u1', 'co1', { aiDisabled: async () => false, emulator: false, apiKey: null });
      const month = new Date().toISOString().slice(0, 7);
      db.store.set('userCostMeter/u1__' + month, { visionUsd: 30 });
      const b = await RS.visionBlocked(db, 'u1', 'co1', { aiDisabled: async () => false, emulator: false, apiKey: 'x' });
      db.store.set('subscriptions/co1', { plan: 'growth' });
      const b2 = await RS.visionBlocked(db, 'u1', 'co1', { aiDisabled: async () => false, emulator: false, apiKey: 'x' });
      ok('vision gate: AI kill switch / emulator / no key / over budget all block', k === 'ai_disabled' && e === 'emulator' && n === 'not_configured' && b === 'budget' && b2 === null);
      // callVision against a stub fetch: base64 frames, Haiku, parsed + incomplete answers refused
      const calls = [];
      const fetchFn = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ usage: { input_tokens: 1000, output_tokens: 100 }, content: [{ type: 'text', text: '```json\n{"frames":[{"i":0,"flags":[]},{"i":1,"flags":[]}]}\n```' }] }) }; };
      const vr = await RS.callVision([{ t: 0.5, b64: 'AAAA' }, { t: 2.5, b64: 'BBBB' }], { apiKey: 'k', fetchFn });
      ok('vision call: Haiku 4.5, base64 JPEG frames, cost from usage', vr.ran && calls[0].model === 'claude-haiku-4-5-20251001' && calls[0].messages[0].content.filter((c) => c.type === 'image').length === 2 && Math.abs(vr.costUsd - 0.0015) < 1e-9);
      const vr2 = await RS.callVision([{ t: 0.5, b64: 'A' }, { t: 2.5, b64: 'B' }], { apiKey: 'k', fetchFn: async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"frames":[{"i":0,"flags":[]}]}' }] }) }) });
      ok('vision call: a reply that skips frames counts as NOT run (→ Jo confirms)', vr2.ran === false);
      const vr3 = await RS.callVision([{ t: 0.5, b64: 'A' }], { apiKey: 'k', fetchFn: async () => { throw new Error('offline'); } });
      ok('vision call: network failure → not run, never throws', vr3.ran === false);
    }
  }

  // ── I. ingest ───────────────────────────────────────────────────────────
  console.log('I. ingest — raw upload → clean intermediate, raw deleted');
  if (!RS) ok('functions deps missing — ingest SKIPPED', true);
  else {
    ok('upload path shape: reel-uploads/{company}/{uid}/{mediaId}', RS.UPLOAD_RE.test('reel-uploads/co1/u1/abc') && !RS.UPLOAD_RE.test('reel-uploads/co1/abc') && !RS.UPLOAD_RE.test('photos/co1/u1/abc'));
    {
      const db = fakeDb(); const bucket = fakeBucket();
      bucket.files.set('reel-uploads/co1/u1/nope', Buffer.from('x'));
      const r = await RS.ingestUpload('reel-uploads/co1/u1/nope', 'video/mp4', 1, { db, bucket, ff: RF || { withWorkDir: async (f) => f('.') }, reelsGate: async () => null });
      ok('an upload with no server-minted slot is refused AND deleted', r.refused && bucket.deleted.includes('reel-uploads/co1/u1/nope'));
      db.store.set('companies/co1/reel_media/m9', { status: 'awaiting_upload', uploadPath: 'reel-uploads/co1/u1/m9', createdBy: 'someone-else', kind: 'video' });
      bucket.files.set('reel-uploads/co1/u1/m9', Buffer.from('x'));
      const r2 = await RS.ingestUpload('reel-uploads/co1/u1/m9', 'video/mp4', 1, { db, bucket, ff: RF || { withWorkDir: async (f) => f('.') }, reelsGate: async () => null });
      ok('an upload into someone else’s slot is refused and deleted', r2.refused && !bucket.files.has('reel-uploads/co1/u1/m9'));
    }
    if (!FF) ok('ffmpeg unavailable — real ingest SKIPPED (CI runs it)', true);
    else {
      const db = fakeDb(); const bucket = fakeBucket();
      const raw = await RF.withWorkDir(async (dir) => {
        await RF.run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
          '-metadata', 'location=+38.9987-084.6266/', '-metadata', 'make=ZZPhone', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'mov', '-movflags', 'use_metadata_tags', 'r.mov'], { cwd: dir });
        return fs.readFileSync(path.join(dir, 'r.mov'));
      });
      db.store.set('companies/co1/reel_media/m1', { status: 'awaiting_upload', uploadPath: 'reel-uploads/co1/u1/m1', createdBy: 'u1', kind: 'video' });
      bucket.files.set('reel-uploads/co1/u1/m1', raw);
      const r = await RS.ingestUpload('reel-uploads/co1/u1/m1', 'video/quicktime', raw.length, { db, bucket, ff: RF, reelsGate: async () => null });
      const m = db.store.get('companies/co1/reel_media/m1');
      const work = bucket.files.get('reel-work/co1/m1.mp4') || Buffer.alloc(0);
      ok('ingest: ready, 3 s, audio kept', r.ok && m.status === 'ready' && Math.abs(m.durationSec - 3) < 0.2 && m.hasAudio === true, JSON.stringify(r));
      ok('ingest: intermediate has no GPS / device metadata', work.length > 0 && !work.includes(Buffer.from('+38.9987')) && !work.includes(Buffer.from('ZZPhone')));
      ok('ingest: the raw upload (with GPS) is deleted', !bucket.files.has('reel-uploads/co1/u1/m1') && bucket.deleted.includes('reel-uploads/co1/u1/m1'));
      db.store.set('companies/co1/reel_media/m2', { status: 'awaiting_upload', uploadPath: 'reel-uploads/co1/u1/m2', createdBy: 'u1', kind: 'video' });
      bucket.files.set('reel-uploads/co1/u1/m2', Buffer.from('not a video at all'));
      const r2 = await RS.ingestUpload('reel-uploads/co1/u1/m2', 'video/mp4', 18, { db, bucket, ff: RF, reelsGate: async () => null });
      ok('ingest: garbage → failed, raw still deleted', r2.error && db.store.get('companies/co1/reel_media/m2').status === 'failed' && !bucket.files.has('reel-uploads/co1/u1/m2'));
    }
  }

  // ── J. media route + wiring ─────────────────────────────────────────────
  console.log('J. media route + wiring');
  if (SS) {
    ok('Range: bytes=0-99 → 0..99', JSON.stringify(SS.parseRange('bytes=0-99', 1000)) === '{"start":0,"end":99}');
    ok('Range: open end + suffix', JSON.stringify(SS.parseRange('bytes=900-', 1000)) === '{"start":900,"end":999}' && JSON.stringify(SS.parseRange('bytes=-100', 1000)) === '{"start":900,"end":999}');
    ok('Range: unsatisfiable → invalid; none → whole file', SS.parseRange('bytes=5000-', 1000) === 'invalid' && SS.parseRange(undefined, 1000) === null && SS.parseRange('items=0-1', 10) === null);
    ok('media route serves only re-encoded JPEG / rendered MP4 under social-media/', SS.MEDIA_PATH_RE.test('social-media/co1/' + K1 + '.mp4') && !SS.MEDIA_PATH_RE.test('reel-work/co1/x.mp4') && !SS.MEDIA_PATH_RE.test('social-media/co1/' + K1 + '.mov') && !SS.MEDIA_PATH_RE.test('reel-uploads/co1/u1/' + K1));
  }
  const index = read('functions/index.js');
  ok('functions/index.js exports all eleven reel functions', ['reelStartUpload', 'reelJobMedia', 'reelCreate', 'reelConfirmPrivacy', 'reelApplyBlur', 'reelRetry', 'reelToPosts', 'reelAiImagePost', 'reelRenderWorker', 'reelIngestUpload', 'reelCleanup'].every((n) => new RegExp('exports\\.' + n + ' = reelStudio\\.' + n).test(index)));
  ok('rules: reels / reel_media / reel_usage readable by managers, server-only writes', /match \/reels\/\{reelId\}\s*\{ allow read: if socialManager\(\); allow write: if false; \}/.test(rules) && /match \/reel_media\/\{mediaId\}\s*\{ allow read: if socialManager\(\); allow write: if false; \}/.test(rules));
  const srules = read('storage.rules');
  ok('storage: reel-uploads create-only, never client-readable, 500 MB, video/image only', /match \/reel-uploads\/\{companyId\}\/\{uid\}\/\{mediaId\}[\s\S]{0,120}allow read: if false;[\s\S]{0,700}500 \* 1024 \* 1024[\s\S]{0,300}allow update, delete: if false;/.test(srules));
  const fbj = JSON.parse(read('firestore.indexes.json'));
  ok('index: reel_media.createdAtMs COLLECTION_GROUP (cleanup sweep)', fbj.fieldOverrides.some((f) => f.collectionGroup === 'reel_media' && f.fieldPath === 'createdAtMs' && f.indexes.some((i) => i.queryScope === 'COLLECTION_GROUP')));
  const pkg = JSON.parse(read('functions/package.json'));
  const lock = JSON.parse(read('functions/package-lock.json'));
  ok('ffmpeg-static is an OPTIONAL functions dependency, locked', /^\^?5\./.test((pkg.optionalDependencies || {})['ffmpeg-static'] || '') && lock.packages['node_modules/ffmpeg-static'] && lock.packages[''].optionalDependencies['ffmpeg-static']);
  ok('lockfile keeps every glibc constraint (npm on Windows strips them)', JSON.stringify(lock).split('"glibc"').length - 1 >= 17);
  ok('brand assets ship with the functions (fonts TTF + logo + emulator stub)', ['BarlowCondensed-800.ttf', 'BarlowCondensed-600.ttf', 'logo.png', 'emulator-stub.mp4'].every((f) => fs.existsSync(path.join(FN, 'assets', 'reel', f))));
  ok('worker: 2nd gen, 4 GiB / 4 vCPU, 540 s, one render per instance', /reelRenderWorker = onDocumentWritten\(\{[\s\S]{0,200}memory: '4GiB', cpu: 4, timeoutSeconds: 540, concurrency: 1/.test(read('functions/reel-studio.js')));
  ok('Whisper reuse: transcribeGroqBuffer asks for word stamps only when told', /if \(words\) form\.append\('timestamp_granularities\[\]', 'word'\)/.test(read('functions/integrations/voice-intelligence.js')));
  const page = read('docs/pro/social.html');
  ok('page: Reels tab + panel, no inline scripts / handlers / styles', /data-tab="reels"/.test(page) && /data-panel="reels"/.test(page) && !/<script(?![^>]*\bsrc=)[^>]*>/.test(page) && !/\son[a-z]+=/i.test(page) && !/\sstyle=/.test(page));
  ok('page: reel logic loaded; module cache-busted', /js\/reel-studio-logic\.js\?v=1/.test(page) && /js\/pages\/social-studio\.js\?v=3/.test(page));
  const mod = read('docs/pro/js/pages/social-reels.js');
  ok('reels module: resumable upload to the server-minted path; no style= strings', /uploadBytesResumable\(sref\(storage, slot\.path\)/.test(mod) && !/style=/.test(mod));
  ok('upload checks on the page: type + 500 MB', RC.uploadProblem({ type: 'application/zip', size: 10 }) !== '' && RC.uploadProblem({ type: 'video/quicktime', size: 501 * 1024 * 1024 }) !== '' && RC.uploadProblem({ type: '', name: 'IMG_1.MOV', size: 10 }) === '' && RC.uploadProblem({ type: 'video/mp4', size: 10 }, 'ai_image') !== '');
  ok('page picks: before/after = first before + last after', RC.defaultPicks('before_after', [{ id: 'a', phase: 'before' }, { id: 'b', phase: 'after' }, { id: 'c', phase: 'after' }]).join() === 'a,c');
  ok('cost estimate: a 60 s reel is pennies (< $0.10)', RL.estimateCostUsd({ durationSec: 60 }).total < 0.10 && RL.estimateCostUsd({ durationSec: 60 }).total > 0.01);

  // ── K. review hardening (2026-10-04, post-merge review of #2171) ────────
  console.log('K. review hardening — blur radii, even dims, shared trim window, confidence 0, on/off switch, optional ffmpeg');
  // K1. sanitizeVision: an explicit 0 confidence stays 0 (dropped); missing → 0.5.
  {
    const box = [0.1, 0.1, 0.2, 0.2];
    const sv0 = RL.sanitizeVision({ frames: [
      { i: 0, flags: [{ type: 'face', box, confidence: 0 }] },
      { i: 1, flags: [{ type: 'face', box }] },
      { i: 2, flags: [{ type: 'license_plate', box, confidence: '0' }] },
      { i: 3, flags: [{ type: 'street_sign', box, confidence: null }] },
    ] }, [0.5, 2.5, 4.5, 6.5]);
    ok('vision: confidence exactly 0 (number or "0") is dropped, not promoted to 0.5', !sv0.flags.some((f) => f.frame === 0 || f.frame === 2), JSON.stringify(sv0.flags));
    ok('vision: a missing / null confidence still flags at 0.5 (Jo looks)', sv0.flags.length === 2 && sv0.flags.every((f) => f.confidence === 0.5) && sv0.flags.map((f) => f.frame).join() === '1,3', JSON.stringify(sv0.flags));
  }
  // K2. Blur radii inside ffmpeg's limits for luma AND the half-size chroma planes.
  {
    const sizes = [[16, 16], [20, 40], [30, 30], [32, 64], [48, 48], [100, 60], [400, 300]];
    const bad = sizes.filter(([w, h]) => {
      const r = RL.blurRadii(w, h);
      const m = Math.min(w, h);
      return !(r.luma >= 1 && r.chroma >= 1 && r.luma <= Math.floor(m / 2) && r.chroma <= Math.floor(Math.ceil(m / 2) / 2));
    });
    ok('blur radii: luma ≤ min/2, chroma ≤ min/4 (yuv420p chroma is half size) for every box size', bad.length === 0, JSON.stringify(bad));
    ok('blur radii: big boxes keep a strong blur (≥ 8)', RL.blurRadii(300, 200).luma >= 8 && RL.blurRadii(300, 200).chroma >= 8);
    const edge = RL.blurRegions([{ t: 1, box: [0.985, 0.985, 0.01, 0.01] }, { t: 1, box: [0, 0, 0.01, 0.01] }], 160, 120, 4);
    ok('blur regions: at least 48 px a side, slid inside the frame at the edges (never shrunk)', edge.length >= 1 && RL.MIN_BLUR_PX === 48 && edge.every((r) => r.w >= 48 && r.h >= 48 && r.x >= 0 && r.y >= 0 && r.x + r.w <= 160 && r.y + r.h <= 120 && r.x % 2 === 0 && r.y % 2 === 0), JSON.stringify(edge));
  }
  // K3. Talking head: ONE trim window for the render and the Whisper audio.
  {
    const W1 = RL.talkingHeadWindow({ trimStart: 2, trimEnd: 12 }, 30);
    ok('trim window: 2–12 s of a 30 s clip', W1.start === 2 && W1.end === 12 && W1.duration === 10, JSON.stringify(W1));
    const W2 = RL.talkingHeadWindow({ trimStart: 5, trimEnd: 0 }, 200);
    ok('trim window: no end → capped at the reel body room (90 − intro − outro)', W2.start === 5 && W2.end === 5 + RL.MAX_DURATION_S - RL.INTRO_S - RL.OUTRO_S, JSON.stringify(W2));
    const W3 = RL.talkingHeadWindow({ trimStart: 50, trimEnd: 99 }, 20);
    ok('trim window: start past the end clamps inside the clip', W3.start === 19 && W3.end === 20 && W3.duration === 1, JSON.stringify(W3));
    for (const [prm, dur] of [[{ trimStart: 1.25, trimEnd: 7.5 }, 9.876], [{ trimStart: 0, trimEnd: 0 }, 41.3333], [{ trimStart: 3.3333, trimEnd: 2 }, 12]]) {
      const req = RL.validateRequest({ template: 'talking_head', clips: [{ type: 'video' }], params: prm });
      const plan = RL.buildPlan(req, [{ file: 'c0.mp4', type: 'video', durationSec: dur, hasAudio: true }], {});
      const w = RL.talkingHeadWindow(req.params, dur);
      const a = plan.segments[1].args.join(' ');
      ok('trim window ' + JSON.stringify(prm) + ' @' + dur + 's: buildPlan trims video + audio to exactly the shared window',
        plan.segments[1].trim.start === w.start && plan.segments[1].trim.end === w.end && plan.segments[1].duration === w.duration &&
        a.includes('trim=start=' + w.start + ':end=' + w.end) && a.includes('atrim=start=' + w.start + ':end=' + w.end), a.slice(0, 200));
    }
  }
  // K4. The on/off switch (default OFF) + platform kill switch.
  {
    ok('switch: no settings → off', !RL.reelSwitch(null, {}).ok && !RL.reelSwitch({}, {}).ok && !RL.reelSwitch({ enabled: true }, {}).ok);
    ok('switch: reels: true → on; reels: "true" (string) → off', RL.reelSwitch({ reels: true }, {}).ok && !RL.reelSwitch({ reels: 'true' }, {}).ok);
    ok('switch: feature_flags/global.reelStudioDisabled beats the company switch', !RL.reelSwitch({ reels: true }, { reelStudioDisabled: true }).ok);
  }
  if (RS) {
    {
      const db = fakeDb();
      const off0 = await RS.reelsBlocked(db, 'co1', async () => ({}));
      db.store.set('companies/co1/social_settings/config', { enabled: true });
      const off1 = await RS.reelsBlocked(db, 'co1', async () => ({}));
      db.store.set('companies/co1/social_settings/config', { enabled: false, reels: true });
      const on = await RS.reelsBlocked(db, 'co1', async () => ({}));
      const killed = await RS.reelsBlocked(db, 'co1', async () => ({ reelStudioDisabled: true }));
      const broken = await RS.reelsBlocked({ doc: () => ({ get: async () => { throw new Error('firestore down'); } }) }, 'co1', async () => ({}));
      ok('reelsBlocked: off by default, off with only auto-publish on, on with reels: true', !!off0 && !!off1 && on === null, [off0, off1, on].join(' | '));
      ok('reelsBlocked: kill switch blocks; a settings read error fails CLOSED', !!killed && !!broken);
    }
    // Every spending callable asks the switch BEFORE it spends (comments stripped; order asserted).
    {
      const src = read('functions/reel-studio.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1');
      const body = (name) => { const i = src.indexOf('exports.' + name + ' = onCall('); const j = src.indexOf('\nexports.', i + 10); return i < 0 ? '' : src.slice(i, j < 0 ? undefined : j); };
      const before = (name, spend) => { const b = body(name); const g = b.indexOf('await requireReelsOn(db, ctx.companyId)'); const s = b.indexOf(spend); return g > 0 && s > 0 && g < s; };
      ok('reelStartUpload checks the switch before minting an upload slot', before('reelStartUpload', 'await ref.set('));
      ok('reelCreate checks the switch (and the ffmpeg binary) before taking a render slot', before('reelCreate', 'await takeRenderSlot(') && body('reelCreate').indexOf('FFMPEG_MISSING') < body('reelCreate').indexOf('await takeRenderSlot('));
      ok('reelApplyBlur + reelRetry check the switch before taking a render slot', before('reelApplyBlur', 'await takeRenderSlot(') && before('reelRetry', 'await takeRenderSlot('));
      ok('the live worker / ingest deps carry the switch', /reelsGate: \(companyId\) => reelsBlocked\(db, companyId, killswitch\.getFlags\)/.test(src));
    }
    // Worker + ingest honour the switch; no ffmpeg → a clear failure, never a stub in prod.
    {
      const db = fakeDb(); const bucket = fakeBucket();
      db.store.set('companies/co1/reels/off1', { template: 'slideshow', aspect: '9:16', params: {}, clips: [{ source: 'job_photo', type: 'photo', storagePath: 'photos/co1/x.jpg' }], status: 'queued', op: 'render', companyId: 'co1', requestedBy: 'co1', facts: {} });
      let runs = 0;
      const ffSpy = Object.assign({}, RF || {}, { run: async () => { runs++; throw new Error('should not run'); }, withWorkDir: (RF && RF.withWorkDir) || (async (fn) => fn(os.tmpdir())), ffmpegPath: () => 'ffmpeg' });
      const deps = { db, bucket, ff: ffSpy, logger: null, stub: false, nowMs: 1, reencode: async (b) => b, visionGate: async () => null, meter: async () => {}, vision: async () => ({ ran: false }), transcribeGate: async () => 'x', transcribe: async () => ({}) };
      const r1 = await RS.processReel('co1', 'off1', Object.assign({}, deps, { reelsGate: async () => 'Reel Studio is off.' }));
      const d1 = db.store.get('companies/co1/reels/off1');
      ok('worker: switch off → the queued reel is failed with the reason, nothing rendered', r1.off === true && d1.status === 'failed' && /off/.test(d1.render.error) && runs === 0 && bucket.files.size === 0);
      db.store.set('companies/co1/reels/off2', Object.assign({}, d1, { status: 'queued', render: {} }));
      const r2 = await RS.processReel('co1', 'off2', deps);
      ok('worker: no gate wired → fails CLOSED', r2.off === true && db.store.get('companies/co1/reels/off2').status === 'failed' && runs === 0);
      db.store.set('companies/co1/reels/nf', Object.assign({}, d1, { status: 'queued', render: {} }));
      const r3 = await RS.processReel('co1', 'nf', Object.assign({}, deps, { reelsGate: async () => null, ff: Object.assign({}, ffSpy, { ffmpegPath: () => null }) }));
      const d3 = db.store.get('companies/co1/reels/nf');
      ok('worker: ffmpeg binary missing (optional dep failed) → failed with the clear message, no stub', r3.ok === false && d3.status === 'failed' && d3.render.error === RS.FFMPEG_MISSING && runs === 0 && bucket.files.size === 0, JSON.stringify(d3.render));
      db.store.set('companies/co1/reel_media/moff', { status: 'awaiting_upload', uploadPath: 'reel-uploads/co1/u1/moff', createdBy: 'u1', kind: 'video' });
      bucket.files.set('reel-uploads/co1/u1/moff', Buffer.from('raw-with-gps'));
      const ri = await RS.ingestUpload('reel-uploads/co1/u1/moff', 'video/mp4', 12, { db, bucket, ff: ffSpy, reelsGate: async () => 'Reel Studio is off.' });
      ok('ingest: switch off → refused, slot failed, raw (GPS) still deleted', ri.refused === 'off' && db.store.get('companies/co1/reel_media/moff').status === 'failed' && !bucket.files.has('reel-uploads/co1/u1/moff') && runs === 0);
    }
  }
  // K5. ffmpeg-static is OPTIONAL (a failed binary download must not fail the deploy) and the lock agrees.
  {
    const pkgK = JSON.parse(read('functions/package.json'));
    const lockK = JSON.parse(read('functions/package-lock.json'));
    ok('ffmpeg-static: optionalDependencies, not dependencies (package.json + lock root)', /^\^?5\./.test((pkgK.optionalDependencies || {})['ffmpeg-static'] || '') && !(pkgK.dependencies || {})['ffmpeg-static'] &&
      (lockK.packages[''].optionalDependencies || {})['ffmpeg-static'] === pkgK.optionalDependencies['ffmpeg-static'] && !(lockK.packages[''].dependencies || {})['ffmpeg-static']);
    // npm's rule: a package is "optional" exactly when no path of required edges reaches it from the root.
    const PK = lockK.packages;
    const resolveK = (from, name) => { let base = from; for (;;) { const c = (base ? base + '/' : '') + 'node_modules/' + name; if (PK[c]) return c; if (!base) return null; const i = base.lastIndexOf('/node_modules/'); base = i >= 0 ? base.slice(0, i) : ''; } };
    const reqd = new Set(['']); const qk = [''];
    while (qk.length) {
      const loc = qk.shift(); const p = PK[loc]; const meta = p.peerDependenciesMeta || {};
      const names = Object.keys(p.dependencies || {}).concat(Object.keys(p.peerDependencies || {}).filter((n) => !(meta[n] && meta[n].optional)));
      for (const n of names) { const r = resolveK(loc, n); if (r && !reqd.has(r)) { reqd.add(r); qk.push(r); } }
    }
    const wrong = Object.keys(PK).filter((loc) => loc && (PK[loc].optional === true) !== !reqd.has(loc));
    ok('lock: every package reachable only through ffmpeg-static is flagged optional (and nothing else changed)', wrong.length === 0 && PK['node_modules/ffmpeg-static'].optional === true, wrong.slice(0, 8).join(', '));
    // CI caught it: ffmpeg-static 5.3.0's Linux binary (FFmpeg 7.0.2) has no drawtext
    // (FFmpeg 7 needs libharfbuzz for it), so EVERY brand card failed in production.
    // 5.2.0 ships FFmpeg 6.0 with drawtext. Pinned exactly; a caret would float back to 5.3.
    ok('ffmpeg-static pinned to exactly 5.2.0 (5.3.0 Linux binary lacks drawtext) — package.json + lock', pkgK.optionalDependencies['ffmpeg-static'] === '5.2.0' && lockK.packages[''].optionalDependencies['ffmpeg-static'] === '5.2.0' && PK['node_modules/ffmpeg-static'].version === '5.2.0' && /ffmpeg-static-5\.2\.0\.tgz$/.test(PK['node_modules/ffmpeg-static'].resolved));
    if (RF) {
      const linux7 = ' T.. xfade             VV->V      Cross fade\n ... zoompan           V->V       zoom\n T.C boxblur           V->V       blur\n ..C overlay           VV->V      overlay\n T.C drawbox           V->V       box\n ..C scale             V->V       scale\n ..C crop              V->V       crop\n ... tpad              V->V       pad\n T.. fade              V->V       fade\n ..C concat            N->N       concat\n ... atrim             A->A       trim\n';
      ok('ffmpegPath rejects a binary without drawtext (the 5.3.0 Linux build)', JSON.stringify(RF.missingFilters(linux7)) === '["drawtext"]' && RF.missingFilters(linux7 + ' T.C drawtext          V->V       Draw text\n').length === 0 && RF.REQUIRED_FILTERS.includes('drawtext'));
    }
    ok('reel-ffmpeg resolves ffmpeg-static inside try/catch (a missing package is not a crash)', /try \{ const p = require\('ffmpeg-static'\); if \(p\) candidates\.push\(p\); \} catch/.test(read('functions/reel-ffmpeg.js')));
  }
  // K6. Real ffmpeg: the fixed argv actually runs.
  // The binary check runs on the RAW candidate (FFMPEG_PATH, else ffmpeg-static's
  // path) — ffmpegPath() would reject a drawtext-less binary and every real-ffmpeg
  // section below would then skip green. In CI (GitHub sets CI=true) a usable
  // ffmpeg is REQUIRED: the 5.3.0 drawtext gap was only visible because the real
  // render ran there.
  if (RF) {
    let cand = process.env.FFMPEG_PATH || null;
    if (!cand) { try { cand = require(require.resolve('ffmpeg-static', { paths: [FN] })); } catch (_) { cand = null; } }
    if (cand && fs.existsSync(cand)) {
      const fr = require('child_process').spawnSync(cand, ['-hide_banner', '-filters'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      const miss = RF.missingFilters(fr.stdout);
      ok('the installed ffmpeg binary has every template filter (drawtext, xfade, zoompan, boxblur, …)', fr.status === 0 && miss.length === 0, 'missing: ' + miss.join(', ') + ' in ' + cand);
    } else ok('no ffmpeg binary installed here' + (process.env.CI ? ' — REQUIRED in CI' : ' — binary filter check SKIPPED'), !process.env.CI);
    ok('CI renders with real ffmpeg (never a silent skip)', !process.env.CI || !!FF);
  }
  if (!FF) {
    ok('ffmpeg unavailable — real blur / odd-size checks SKIPPED (CI installs ffmpeg-static)', true);
  } else {
    await RF.withWorkDir(async (dir) => {
      await RF.run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:r=30:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'small.mp4'], { cwd: dir });
      let err16 = '';
      try { await RF.run(RL.blurArgs('small.mp4', 'b16.mp4', [{ x: 0, y: 0, w: 16, h: 16, start: 0, end: 1 }, { x: 140, y: 100, w: 20, h: 20, start: 0.5, end: 2 }]), { cwd: dir }); } catch (e) { err16 = e.message; }
      ok('real ffmpeg: blur on 16 px + 20 px boxes renders (chroma radius capped for the half-size planes)', !err16 && fs.existsSync(path.join(dir, 'b16.mp4')), err16.slice(0, 300));
      const regsK = RL.blurRegions([{ t: 0.5, box: [0.97, 0.97, 0.02, 0.02] }, { t: 1.2, box: [0.3, 0.4, 0.05, 0.05] }], 160, 120, 2);
      let errR = '';
      try { await RF.run(RL.blurArgs('small.mp4', 'br.mp4', regsK), { cwd: dir }); } catch (e) { errR = e.message; }
      ok('real ffmpeg: blurRegions output on a small frame (edge box) renders', !errR && fs.existsSync(path.join(dir, 'br.mp4')), errR.slice(0, 300));
      // Odd-dimension sources (ffv1 + yuv444p keep them odd; libx264 yuv420p refuses them).
      await RF.run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=s=641x361:r=30:d=1', '-pix_fmt', 'yuv444p', '-c:v', 'ffv1', 'oddw.mkv'], { cwd: dir });
      await RF.run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc=s=361x641:r=30:d=1', '-pix_fmt', 'yuv444p', '-c:v', 'ffv1', 'oddh.mkv'], { cwd: dir });
      const oddProbe = await RF.run(['-hide_banner', '-i', 'oddw.mkv'], { cwd: dir, allowFail: true }).catch(() => ({ stderr: '' }));
      ok('positive control: the fixture really is odd-sized (641x361)', /641x361/.test(oddProbe.stderr), oddProbe.stderr.slice(-300));
      for (const [src, wantW, wantH] of [['oddw.mkv', 640, 360], ['oddh.mkv', 360, 640]]) {
        let errN = '', pr = null;
        try { pr = await RF.normalize(path.join(dir, src), path.join(dir, src + '.mp4')); } catch (e) { errN = e.message; }
        ok('real ffmpeg: normalize an odd-size ' + src.replace('.mkv', '') + ' source → even ' + wantW + 'x' + wantH + ' H.264', !errN && pr && pr.width === wantW && pr.height === wantH, errN.slice(0, 300) || JSON.stringify(pr));
      }
    });
    // Talking head end to end: the audio Whisper hears is EXACTLY the rendered window.
    if (RS) {
      const db = fakeDb(); const bucket = fakeBucket();
      const clip = await RF.withWorkDir(async (dir) => {
        await RF.run(['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=12', '-f', 'lavfi', '-i', 'sine=d=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', 'th.mp4'], { cwd: dir });
        return fs.readFileSync(path.join(dir, 'th.mp4'));
      });
      bucket.files.set('reel-work/co1/th.mp4', clip);
      const params = RL.validateRequest({ template: 'talking_head', clips: [{ type: 'video' }], params: { trimStart: 3.25, trimEnd: 8.5, captions: true } }).params;
      db.store.set('companies/co1/reels/th', { template: 'talking_head', aspect: '9:16', params, clips: [{ source: 'upload', mediaId: 'mth', type: 'video', storagePath: 'reel-work/co1/th.mp4', durationSec: 12, hasAudio: true }], status: 'queued', op: 'render', companyId: 'co1', requestedBy: 'co1', facts: {}, postIds: [] });
      const runs = [];
      let heardSec = -1;
      const ffT = Object.assign({}, RF, { run: (args, o) => { runs.push(args); return RF.run(args, o); } });
      const res = await RS.processReel('co1', 'th', {
        db, bucket, ff: ffT, logger: null, stub: false, nowMs: Date.now(), reelsGate: async () => null,
        reencode: async (b) => b, visionGate: async () => 'ai_disabled', meter: async () => {}, vision: async () => ({ ran: false }),
        transcribeGate: async () => null,
        transcribe: async (buf) => {
          heardSec = await RF.withWorkDir(async (d2) => { fs.writeFileSync(path.join(d2, 'h.m4a'), buf); return (await RF.probe(path.join(d2, 'h.m4a'), { cwd: d2 })).durationSec; });
          return { words: [{ word: 'Fresh', start: 0.2, end: 0.5 }, { word: 'ridge', start: 0.5, end: 0.8 }, { word: 'vent.', start: 0.8, end: 1.2 }] };
        },
      });
      const r = db.store.get('companies/co1/reels/th');
      const win = RL.talkingHeadWindow(params, 12);
      const aud = runs.find((a) => a.includes('-vn')) || [];
      ok('talking head e2e: rendered with burned captions', res.ok && r.status === 'rendered' && r.captions.status === 'burned' && r.captions.groups >= 1, JSON.stringify(res) + JSON.stringify(r.captions));
      ok('talking head e2e: Whisper audio range = the render trim window (same -ss/-to; reel = intro + window + outro)', aud[aud.indexOf('-ss') + 1] === String(win.start) && aud[aud.indexOf('-to') + 1] === String(win.end) && Math.abs(r.output.durationSec - (RL.INTRO_S + win.duration + RL.OUTRO_S)) < 0.25, JSON.stringify(aud) + ' out ' + (r.output && r.output.durationSec));
      ok('talking head e2e: the audio Whisper heard lasts exactly the window (' + win.duration + ' s)', Math.abs(heardSec - win.duration) < 0.1, String(heardSec));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
