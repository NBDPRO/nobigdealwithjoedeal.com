#!/usr/bin/env node
/**
 * scripts/build-project-thumbs.mjs — 400 px copies of every manifest project photo.
 *
 * The case-study gallery (`.pd-photo`, 157-341 px wide on phones) was handed the 800 px
 * file for photos 2..N because only each job's hero had -400/-640 copies. This makes
 * <name>-400.webp / <name>-400.avif next to each committed 800 px WebP/AVIF that lacks one.
 * Source is the committed (already EXIF-stripped) copy, so no metadata can come back;
 * sharp writes none. scripts/build-projects.mjs offers the -400 copy via <picture> srcset.
 *
 *   node scripts/build-project-thumbs.mjs            # dry run: list what would be made
 *   node scripts/build-project-thumbs.mjs --apply    # write the missing files
 *   node scripts/build-project-thumbs.mjs --check    # exit 1 if any manifest photo lacks a -400 copy
 *
 * sharp comes from functions/node_modules (cd functions && npm install).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
const manifest = JSON.parse(readFileSync(join(ROOT, 'docs/assets/data/projects.json'), 'utf8'));
const projects = Array.isArray(manifest) ? manifest : manifest.projects;
const srcs = new Set();
for (const p of projects) for (const ph of p.photos || []) srcs.add(ph.src);

const todo = [];
for (const src of srcs) {
  for (const ext of ['webp', 'avif']) {
    const base = src.replace(/\.(jpg|jpeg|png)$/, '.' + ext);
    if (base === src) continue;
    const abs = join(ROOT, 'docs', base);
    const out = abs.replace(/\.(webp|avif)$/, '-400.$1');
    if (existsSync(abs) && !existsSync(out)) todo.push({ abs, out, ext });
  }
}

if (check) {
  if (todo.length) { console.error('build-project-thumbs: ' + todo.length + ' manifest photo copy(ies) lack a -400 variant'); todo.slice(0, 10).forEach((t) => console.error('  ' + t.out.replace(ROOT, ''))); process.exit(1); }
  console.log('build-project-thumbs: every manifest photo has a -400 copy'); process.exit(0);
}
console.log((apply ? 'making ' : 'would make ') + todo.length + ' file(s) from ' + srcs.size + ' manifest photos');
if (apply) {
  const sharp = createRequire(join(ROOT, 'functions', 'package.json'))('sharp');
  let bytes = 0;
  for (const t of todo) {
    const pipe = sharp(t.abs).resize({ width: 400, withoutEnlargement: true });
    await (t.ext === 'webp' ? pipe.webp({ quality: 76, effort: 4 }) : pipe.avif({ quality: 48, effort: 4 })).toFile(t.out);
    bytes += statSync(t.out).size;
  }
  console.log('wrote ' + todo.length + ' file(s), ' + Math.round(bytes / 1024) + ' KB total');
}
