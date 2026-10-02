#!/usr/bin/env node
/**
 * scripts/build-three-roof.mjs — rebuilds docs/assets/js/vendor/three-roof.min.js,
 * the trimmed Three.js the 3D roof (docs/assets/js/roof-3d.js) imports.
 *
 * The site's CSP only allows scripts from 'self', so Three.js is vendored, not
 * CDN-loaded; and only the classes roof-3d.js actually uses are bundled
 * (tree-shaken + minified), so the 3D view costs a fraction of the full
 * library — and nothing at all until a visitor taps "See it in 3D".
 *
 * Neither three nor esbuild is a repo dependency. To rebuild (e.g. after
 * roof-3d.js starts using another class — tests/roof-3d-2026-10-02.test.js
 * fails and names it):
 *
 *   npm install --no-save --prefix <dir> three esbuild
 *   node scripts/build-three-roof.mjs <dir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) { console.error('usage: node scripts/build-three-roof.mjs <dir with node_modules/three + esbuild>'); process.exit(2); }
const require = createRequire(join(dir, 'package.json'));
const esbuild = require('esbuild');
const threePkg = JSON.parse(readFileSync(join(dir, 'node_modules/three/package.json'), 'utf8'));

const src = readFileSync(join(ROOT, 'docs/assets/js/roof-3d.js'), 'utf8');
const names = [...new Set([...src.matchAll(/\bT\.([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
const entry = 'export { ' + names.join(', ') + " } from 'three';\n";

const out = join(ROOT, 'docs/assets/js/vendor/three-roof.min.js');
mkdirSync(dirname(out), { recursive: true });
const res = await esbuild.build({
  stdin: { contents: entry, resolveDir: dir, loader: 'js' },
  bundle: true, minify: true, format: 'esm', target: 'es2020', write: false, legalComments: 'none',
});
const banner = '/* three-roof.min.js — Three.js r' + threePkg.version + ' (MIT, see three-LICENSE.txt), trimmed to: ' + names.join(', ') + '. Built by scripts/build-three-roof.mjs. */\n';
writeFileSync(out, banner + res.outputFiles[0].text);
writeFileSync(join(ROOT, 'docs/assets/js/vendor/three-LICENSE.txt'), readFileSync(join(dir, 'node_modules/three/LICENSE'), 'utf8'));
console.log('wrote', out, (banner.length + res.outputFiles[0].text.length) + ' bytes,', names.length, 'exports');
