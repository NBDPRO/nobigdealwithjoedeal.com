/**
 * Project photo captions must not name Joe when the photo is not Joe.
 *
 * THE DEFECT (2026-10-07)
 * ──────────────────────────────────────────────────────────────────
 * /assets/images/projects/cincinnati-oh-smartside-trim-repair-2026-1.jpg
 * (a man kneeling on a roof edge prying off a corner trim board) was
 * captioned "Joe kneeling on a roof edge…" in docs/assets/data/projects.json,
 * and build-projects.mjs fanned that alt/figcaption/schema text out to
 * /our-work, the case page, the siding hubs, /areas/cincinnati-oh and the
 * homepage photo wall. Jo confirmed the photo shows a crew member, not Joe.
 * Naming the owner in a photo of someone else is an inaccurate claim on a
 * real-job page.
 *
 * WHAT THIS SUITE PINS
 * 1. The source manifest's alt for that photo exists and does not say Joe.
 * 2. The derived homepage wall manifest agrees.
 * 3. Every generated HTML surface that renders the photo carries an alt (and
 *    figcaption, where present) that does not say Joe — and at least one
 *    surface does render it, so the check cannot pass vacuously.
 *
 * Pure Node, zero deps. Run: node tests/project-photo-crew-not-joe-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SRC = '/assets/images/projects/cincinnati-oh-smartside-trim-repair-2026-1.jpg';
const NAMES_JOE = /\bjoe\b/i;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

function projectsArray(json) {
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.projects)) return json.projects;
  const arr = Object.values(json).find(Array.isArray);
  if (!arr) throw new Error('projects.json: no project array found');
  return arr;
}

test('projects.json alt for the trim-repair photo does not name Joe', () => {
  const projects = projectsArray(JSON.parse(fs.readFileSync(path.join(DOCS, 'assets/data/projects.json'), 'utf8')));
  const photos = projects.flatMap((p) => p.photos || []).filter((ph) => ph.src === SRC);
  assert.strictEqual(photos.length, 1, 'expected exactly one manifest entry for ' + SRC);
  assert.ok(photos[0].alt && photos[0].alt.trim(), 'photo must keep a non-empty alt');
  assert.ok(!NAMES_JOE.test(photos[0].alt), 'alt names Joe: ' + photos[0].alt);
});

test('homeowner-wall.json entry for the photo does not name Joe', () => {
  const wall = JSON.parse(fs.readFileSync(path.join(DOCS, 'assets/data/homeowner-wall.json'), 'utf8'));
  for (const e of wall.filter((x) => x.image === SRC)) {
    assert.ok(!NAMES_JOE.test(e.alt || ''), 'wall alt names Joe: ' + e.alt);
  }
});

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'pro' && ent.name !== 'node_modules') walk(p, out); }
    else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

test('every generated surface renders the photo without naming Joe', () => {
  const esc = SRC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const imgRe = new RegExp('<img\\b[^>]*src="' + esc + '"[^>]*>', 'g');
  let seen = 0;
  for (const file of walk(DOCS, [])) {
    const html = fs.readFileSync(file, 'utf8');
    if (!html.includes(SRC)) continue;
    const rel = path.relative(ROOT, file);
    for (const tag of html.match(imgRe) || []) {
      seen++;
      const alt = (tag.match(/\balt="([^"]*)"/) || [])[1];
      assert.ok(alt && alt.trim(), rel + ': img for the photo has no alt');
      assert.ok(!NAMES_JOE.test(alt), rel + ': alt names Joe: ' + alt);
    }
    // figcaption that follows the img (case page gallery)
    const figRe = new RegExp('src="' + esc + '"[\\s\\S]{0,600}?<figcaption[^>]*>([\\s\\S]*?)</figcaption>', 'g');
    let m;
    while ((m = figRe.exec(html))) {
      assert.ok(!NAMES_JOE.test(m[1]), rel + ': figcaption names Joe: ' + m[1]);
    }
    // JSON-LD / data-project blobs: any caption text tied to this photo
    const blobRe = new RegExp(esc + '[^<]{0,400}', 'g');
    for (const b of html.match(blobRe) || []) {
      const cap = b.match(/(?:caption|alt|description)(?:&quot;|")\s*:\s*(?:&quot;|")([^"&]*)/);
      if (cap) assert.ok(!NAMES_JOE.test(cap[1]), rel + ': schema/data text names Joe: ' + cap[1]);
    }
  }
  assert.ok(seen >= 3, 'expected the photo on several generated surfaces, saw ' + seen);
});

console.log('\nproject-photo-crew-not-joe: ' + passed + ' passed');
