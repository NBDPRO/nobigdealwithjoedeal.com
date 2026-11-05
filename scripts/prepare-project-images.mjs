#!/usr/bin/env node
/**
 * prepare-project-images.mjs — re-encode job photos for the Featured
 * Projects gallery. LOCAL-ONLY tool; never runs in CI.
 *
 * Takes original photos (CRM exports, phone shots) and produces the
 * repo-standard 800×600 JPG + WebP pair under docs/assets/images/projects/,
 * named <slug>-<n>.{jpg,webp}. The sharp re-encode drops ALL metadata
 * (EXIF/GPS) by default — that is the point: originals carry camera GPS and
 * must never be committed as-is. Same stripping property as the CRM's own
 * functions/image-pipeline.js.
 *
 * Zero new dependencies: sharp is loaded from functions/node_modules
 * (a firebase-functions dependency already in the tree). Run
 * `cd functions && npm install` first if it's missing.
 *
 * USAGE:
 *   node scripts/prepare-project-images.mjs <slug> <photo1> [photo2 ...]
 *
 * Prints a ready-to-paste photos[] JSON stub with EMPTY alt fields —
 * writing real alt text is deliberately left as a manual step (never reuse
 * CRM caption/location text; it can be property-derived).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets', 'images', 'projects');

const [, , slug, ...files] = process.argv;
if (!slug || !files.length) {
  console.error('usage: node scripts/prepare-project-images.mjs <slug> <photo1> [photo2 ...]');
  process.exit(1);
}
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
  console.error(`slug "${slug}" must be kebab-case (it becomes the filename prefix)`);
  process.exit(1);
}

let sharp;
try {
  sharp = createRequire(path.join(ROOT, 'functions', 'package.json'))('sharp');
} catch (e) {
  console.error('sharp not found — run `cd functions && npm install` first (it is an existing functions dependency).');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const stubs = [];
let n = 0;
for (const file of files) {
  if (!existsSync(file)) { console.error(`skip: ${file} does not exist`); continue; }
  n++;
  const base = `${slug}-${n}`;
  const jpg = path.join(OUT, `${base}.jpg`);
  const webp = path.join(OUT, `${base}.webp`);
  // No .withMetadata() — sharp strips EXIF/GPS/ICC by default, deliberately.
  const src = sharp(file).rotate().resize(800, 600, { fit: 'cover' });
  await src.clone().jpeg({ quality: 82, mozjpeg: true }).toFile(jpg);
  await src.clone().webp({ quality: 80 }).toFile(webp);
  // Card-size copies (speed audit 2026-11-04): build-projects.mjs offers <base>-400/-640 in srcset when they exist.
  for (const w of [400, 640]) {
    await sharp(jpg).resize(w, Math.round(w * 0.75), { fit: 'cover' }).webp({ quality: 78 }).toFile(path.join(OUT, `${base}-${w}.webp`));
  }
  console.log(`✓ ${path.relative(ROOT, jpg)} + .webp + -400/-640.webp`);
  stubs.push({ src: `/assets/images/projects/${base}.jpg`, alt: '' });
}

if (stubs.length) {
  console.log('\nPaste into the project entry in docs/assets/data/projects.json');
  console.log('(fill in every alt — the build refuses empty alt text):\n');
  console.log(JSON.stringify({ hero: stubs[0].src, photos: stubs }, null, 2));
}
