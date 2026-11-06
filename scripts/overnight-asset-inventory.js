#!/usr/bin/env node
/**
 * scripts/overnight-asset-inventory.js — read-only inventory of what the public
 * site (and /pro HTML) ships: images, CSS, JS, fonts, with per-page reference
 * counts and <img> hygiene (width/height, lazy, srcset, <picture>).
 *
 *   node scripts/overnight-asset-inventory.js              # print Markdown to stdout
 *   node scripts/overnight-asset-inventory.js --out overnight/baseline/assets.md
 *   node scripts/overnight-asset-inventory.js --json       # machine-readable
 *   node scripts/overnight-asset-inventory.js --check      # exit 1 if any <img> in the
 *                                                          # public site lacks width/height
 *
 * Needs `sharp` for pixel dimensions (resolved from functions/node_modules, where it
 * is already a dependency); without it dimensions are omitted. Writes nothing
 * except --out.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };

let sharp = null;
try { sharp = require(path.join(ROOT, 'functions', 'node_modules', 'sharp')); } catch (_) { /* optional */ }

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const htmlFiles = walk(DOCS, []).filter((p) => p.endsWith('.html'));
const isPro = (p) => path.relative(DOCS, p).replace(/\\/g, '/').startsWith('pro/');

function localPath(ref, fromFile) {
  if (!ref || /^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) return null;
  const clean = ref.split('#')[0].split('?')[0];
  if (!clean) return null;
  const abs = clean.startsWith('/') ? path.join(DOCS, clean) : path.join(path.dirname(fromFile), clean);
  return abs;
}

const assets = new Map(); // abs -> {kind, pages:Set, imgTags:[...]}
const bump = (abs, kind, page, extra) => {
  if (!abs) return;
  let a = assets.get(abs);
  if (!a) { a = { kind, pages: new Set(), imgs: [] }; assets.set(abs, a); }
  a.pages.add(page);
  if (extra) a.imgs.push(extra);
};

const missingDims = [];
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const page = path.relative(DOCS, file).replace(/\\/g, '/');
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\ssrc=["']([^"']+)["']/i) || [])[1];
    const attrs = {
      w: /\swidth=["']?\d/i.test(tag), h: /\sheight=["']?\d/i.test(tag),
      lazy: /\sloading=["']lazy["']/i.test(tag), srcset: /\ssrcset=/i.test(tag),
      priority: /fetchpriority=["']high["']/i.test(tag),
    };
    const abs = localPath(src, file);
    bump(abs, 'img', page, attrs);
    if (abs && !isPro(file) && !(attrs.w && attrs.h)) missingDims.push(page + ' -> ' + src);
  }
  for (const m of html.matchAll(/<source\b[^>]*\ssrcset=["']([^"']+)["']/gi)) {
    for (const part of m[1].split(',')) bump(localPath(part.trim().split(/\s+/)[0], file), 'img', page);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = (m[0].match(/\shref=["']([^"']+)["']/i) || [])[1];
    if (/rel=["']stylesheet["']/i.test(m[0])) bump(localPath(href, file), 'css', page);
    else if (/rel=["']preload["']/i.test(m[0]) && /as=["']font["']/i.test(m[0])) bump(localPath(href, file), 'font', page);
    else if (/rel=["']preload["']/i.test(m[0]) && /as=["']image["']/i.test(m[0])) bump(localPath(href, file), 'img', page);
  }
  for (const m of html.matchAll(/<script\b[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi)) bump(localPath(m[1], file), 'js', page);
}

async function build() {
  const rows = [];
  for (const [abs, a] of assets) {
    let bytes = null; try { bytes = fs.statSync(abs).size; } catch (_) { bytes = null; }
    const row = { file: path.relative(DOCS, abs).replace(/\\/g, '/'), kind: a.kind, pages: a.pages.size, bytes, missing: bytes === null };
    row.ext = path.extname(abs).slice(1).toLowerCase();
    if (a.kind === 'img' && bytes !== null && sharp && /^(png|jpe?g|webp|avif|gif)$/.test(row.ext)) {
      try { const md = await sharp(abs).metadata(); row.dim = md.width + 'x' + md.height; row.realFormat = md.format; } catch (_) { /* ignore */ }
    }
    if (a.imgs.length) {
      const n = a.imgs.length;
      row.tags = n; row.withDims = a.imgs.filter((i) => i.w && i.h).length;
      row.lazy = a.imgs.filter((i) => i.lazy).length; row.srcset = a.imgs.filter((i) => i.srcset).length;
    }
    rows.push(row);
  }
  return rows;
}

(async () => {
  const rows = await build();
  if (flag('--check')) {
    if (missingDims.length) { console.error('overnight-asset-inventory: ' + missingDims.length + ' <img> without width+height'); missingDims.slice(0, 20).forEach((l) => console.error('  ' + l)); process.exit(1); }
    console.log('overnight-asset-inventory: every public <img> declares width+height'); return;
  }
  if (flag('--json')) { console.log(JSON.stringify(rows, null, 1)); return; }
  const kb = (b) => (b === null ? 'MISSING' : (b / 1024).toFixed(1));
  const lines = ['# Asset inventory', '', `Generated by scripts/overnight-asset-inventory.js — ${htmlFiles.length} HTML files scanned (${htmlFiles.filter(isPro).length} under /pro).`, ''];
  const mism = rows.filter((r) => r.realFormat && r.ext !== r.realFormat && !(r.ext === 'jpg' && r.realFormat === 'jpeg') && !(r.ext === 'avif' && r.realFormat === 'heif')); // sharp reports AVIF's container as heif
  const sizeOf = (k) => rows.filter((r) => r.kind === k).reduce((s, r) => s + (r.bytes || 0), 0);
  lines.push('## Totals', '', `| Kind | Files | Total KB |`, '|---|---|---|');
  for (const k of ['img', 'css', 'js', 'font']) lines.push(`| ${k} | ${rows.filter((r) => r.kind === k).length} | ${(sizeOf(k) / 1024).toFixed(0)} |`);
  lines.push('', `Missing referenced local files: ${rows.filter((r) => r.missing).length}`, `Extension/format mismatches: ${mism.length}`, '');
  if (mism.length) { lines.push('### Extension does not match real format', '', '| File | Ext | Real | Pages | KB |', '|---|---|---|---|---|'); mism.forEach((r) => lines.push(`| ${r.file} | ${r.ext} | ${r.realFormat} | ${r.pages} | ${kb(r.bytes)} |`)); lines.push(''); }
  lines.push(`Public \`<img>\` tags missing width/height: ${missingDims.length}`, '');
  const top = (kind, n) => rows.filter((r) => r.kind === kind).sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, n);
  lines.push('## Largest images', '', '| File | Dim | KB | Pages | <img> tags | w/h | lazy | srcset |', '|---|---|---|---|---|---|---|---|');
  top('img', 40).forEach((r) => lines.push(`| ${r.file} | ${r.dim || ''} | ${kb(r.bytes)} | ${r.pages} | ${r.tags || 0} | ${r.withDims || 0} | ${r.lazy || 0} | ${r.srcset || 0} |`));
  lines.push('', '## Images used on most pages', '', '| File | Dim | KB | Pages |', '|---|---|---|---|');
  rows.filter((r) => r.kind === 'img').sort((a, b) => b.pages - a.pages).slice(0, 25).forEach((r) => lines.push(`| ${r.file} | ${r.dim || ''} | ${kb(r.bytes)} | ${r.pages} |`));
  for (const [k, title] of [['css', 'CSS'], ['js', 'JS'], ['font', 'Fonts']]) {
    lines.push('', `## ${title} (largest 25)`, '', '| File | KB | Pages |', '|---|---|---|');
    top(k, 25).forEach((r) => lines.push(`| ${r.file} | ${kb(r.bytes)} | ${r.pages} |`));
  }
  if (missingDims.length) { lines.push('', '## <img> without width+height (first 40)', ''); missingDims.slice(0, 40).forEach((l) => lines.push('- ' + l)); }
  const out = lines.join('\n') + '\n';
  if (val('--out')) { fs.writeFileSync(path.resolve(ROOT, val('--out')), out); console.log('wrote ' + val('--out')); } else process.stdout.write(out);
})();
