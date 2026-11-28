/**
 * before-after-component.test.js — the before/after comparison and job-clip
 * component (2026-11-27): scripts/lib/before-after.mjs validation and markup,
 * plus what build-projects.mjs stamped from projects.json.
 *
 * Guards the promises the PR makes: a pair is two of the job's own published
 * photos and names the service it shows; a clip never autoplays, starts muted,
 * loads nothing until played and carries captions; a clip file holding
 * location metadata is refused; a town page never labels another town's job
 * as being in that town.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
};

(async () => {
  const lib = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/before-after.mjs')).href);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const P = '/assets/images/projects/';
  const job = {
    slug: 'x-job', title: 'X <Job>', city: 'Mason, OH', services: ['roof-replacement'],
    photos: [{ src: P + 'a.jpg', alt: 'old roof' }, { src: P + 'b.jpg', alt: 'new roof' }],
  };
  const all = () => true;

  // ── validation ──
  const good = { ...job, beforeAfter: [{ before: P + 'a.jpg', after: P + 'b.jpg', service: 'roof-replacement' }] };
  ok('a valid pair passes', lib.mediaErrors(good, { exists: all }).length === 0, lib.mediaErrors(good, { exists: all }).join(' | '));
  const foreign = { ...job, beforeAfter: [{ before: P + 'a.jpg', after: P + 'elsewhere.jpg', service: 'roof-replacement' }] };
  ok('a pair photo outside the job\'s photos[] is refused', lib.mediaErrors(foreign, { exists: all }).some((e) => /after: .*photos\[\]/.test(e)));
  const wrongSvc = { ...job, beforeAfter: [{ before: P + 'a.jpg', after: P + 'b.jpg', service: 'siding-repair' }] };
  ok('a pair naming a service the job lacks is refused', lib.mediaErrors(wrongSvc, { exists: all }).some((e) => /service/.test(e)));
  const same = { ...job, beforeAfter: [{ before: P + 'a.jpg', after: P + 'a.jpg', service: 'roof-replacement' }] };
  ok('the same photo as before and after is refused', lib.mediaErrors(same, { exists: all }).some((e) => /same photo/.test(e)));

  const V = '/assets/video/projects/';
  const clip = { src: V + 'x-1.mp4', poster: P + 'a.jpg', captions: V + 'x-1.en.vtt', title: 'Tear-off', width: 720, height: 1280 };
  const clean = Buffer.from('....ftypisom....moov....');
  ok('a complete clip passes', lib.mediaErrors({ ...job, clips: [clip] }, { exists: all, read: () => clean }).length === 0);
  const noVtt = { ...clip }; delete noVtt.captions;
  ok('a clip without captions is refused', lib.mediaErrors({ ...job, clips: [noVtt] }, { exists: all }).some((e) => /captions/.test(e)));
  ok('a clip from outside /assets/video/projects/ is refused',
    lib.mediaErrors({ ...job, clips: [{ ...clip, src: 'https://firebasestorage.googleapis.com/x.mp4?token=1' }] }, { exists: all }).some((e) => /\.src/.test(e)));
  const gps = Buffer.concat([clean, Buffer.from([0xa9, 0x78, 0x79, 0x7a]), Buffer.from('+39.1-084.4/')]);
  ok('a clip still holding a QuickTime location atom is refused',
    lib.mediaErrors({ ...job, clips: [clip] }, { exists: all, read: () => gps }).some((e) => /location metadata/.test(e)));
  ok('…and the iPhone location key too', lib.videoHasLocation(Buffer.from('mdta com.apple.quicktime.location.ISO6709')));

  // ── markup ──
  const fig = lib.baFigure({
    p: job, ba: good.beforeAfter[0], esc, loc: 'Mason, OH', altOf: (s) => job.photos.find((ph) => ph.src === s).alt,
    pic: (src, img) => img,
  });
  ok('figure is marked for the slider and carries both photos with their alt text',
    /data-bac/.test(fig) && /alt="old roof"/.test(fig) && /alt="new roof"/.test(fig));
  ok('both photos are labelled in the markup (the no-JS comparison)', /bac-tag">Before</.test(fig) && /bac-tag">After</.test(fig));
  ok('photos lazy-load by default', (fig.match(/loading="lazy"/g) || []).length === 2);
  ok('text is escaped', /X &lt;Job&gt;/.test(fig) && !/X <Job>/.test(fig));
  const v = lib.clipFigure({ c: clip, esc });
  ok('clip: controls, muted, playsinline, preload="none", no autoplay',
    /<video controls muted playsinline preload="none"/.test(v) && !/autoplay/.test(v));
  ok('clip: poster + captions track', /poster="\/assets\/images\/projects\/a\.jpg"/.test(v) && /<track kind="captions"[^>]*srclang="en"/.test(v));

  // ── what the generator stamped ──
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const projects = JSON.parse(read('docs/assets/data/projects.json')).projects;
  const ourWork = read('docs/our-work.html');
  const pairs = projects.filter((p) => p.beforeAfter);
  ok('every project pair is on /our-work', pairs.every((p) => ourWork.includes(`<a href="/our-work/${p.slug}">`) && ourWork.includes(p.beforeAfter[0].after)));
  ok('the component JS is loaded external + deferred, never inline', /<script src="\/assets\/js\/before-after\.js" defer><\/script>/.test(ourWork));

  // Town pages: "in <Town>" only when the pair's job city IS that town.
  const areasDir = path.join(ROOT, 'docs/areas');
  const lies = [];
  let seen = 0;
  for (const f of fs.readdirSync(areasDir)) {
    const html = fs.readFileSync(path.join(areasDir, f), 'utf8');
    const m = /Before &amp; After (in|Near) <span>([^<]+)<\/span>/.exec(html);
    if (!m) continue;
    seen++;
    const loc = /class="bac-loc">([^<&]+)/.exec(html)[1].trim();
    const locTown = loc.replace(/, [A-Z]{2}$/, '');
    if (m[1] === 'in' && locTown !== m[2]) lies.push(`${f}: "in ${m[2]}" for a ${loc} job`);
    if (m[1] === 'Near' && !new RegExp(`mi from ${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(html)) lies.push(`${f}: nearby pair without its distance`);
  }
  ok(`town pages never place a job in a town it wasn't in (${seen} pages with a pair)`, seen > 0 && lies.length === 0, lies.join(' | '));

  console.log('\n' + '─'.repeat(30));
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
