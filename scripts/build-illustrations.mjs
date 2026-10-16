#!/usr/bin/env node
// scripts/build-illustrations.mjs — NBD's technical illustrations (2026-10-16).
//
// The drawings are code (scripts/illustrations/*.mjs: one camera, one palette,
// one callout style). What each figure says, and which primary sources back
// it, is data (site-src/illustrations/figures.json + sources.json).
//
//   node scripts/build-illustrations.mjs --svg [name…]   write docs/assets/images/illustrations/*.svg
//   npx --yes svgo@3.3.2 --config scripts/illustrations/svgo.config.cjs -f docs/assets/images/illustrations
//   node scripts/build-illustrations.mjs --stamp          restamp the page regions (figures, inline
//                                                         components, sources) from the final SVGs
//   node scripts/build-illustrations.mjs --check          write nothing; exit 1 if any page region drifted
//
// Order matters: --svg, then the PINNED svgo, then --stamp (the ?v= cache
// buster is a hash of the optimized file). Edit the modules or the JSON, never
// the SVGs or the stamped regions by hand. Regions:
//   <!-- ILLUS:<id>:START --> … <!-- ILLUS:<id>:END -->              a figure
//   <!-- ILLUS-INLINE:roof-explode:START --> … END                     the pull-apart roof
//   <!-- ILLUS-INLINE:vent-flow:START --> … END                        the airflow animation
//   <!-- ILLUS-SOURCES:START --> … <!-- ILLUS-SOURCES:END -->          the sources list
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FIGURES } from './illustrations/index.mjs';
import { systemInline, LAYERS } from './illustrations/fig-system.mjs';
import { ventilationInline } from './illustrations/fig-vent.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'assets', 'images', 'illustrations');
const DATA = JSON.parse(fs.readFileSync(path.join(ROOT, 'site-src', 'illustrations', 'figures.json'), 'utf8'));
const SRC = JSON.parse(fs.readFileSync(path.join(ROOT, 'site-src', 'illustrations', 'sources.json'), 'utf8')).sources;
export const BADGE = 'Illustration · not a photo of an actual job';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function writeSvgs(only) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [name, fn] of Object.entries(FIGURES)) {
    if (only.length && !only.includes(name)) continue;
    const svg = fn();
    fs.writeFileSync(path.join(OUT, name + '.svg'), svg + '\n');
    console.log(`  ${name}.svg  ${(svg.length / 1024).toFixed(1)} KB (before svgo)`);
  }
}

// LF-normalised so a Windows checkout (CRLF) and CI (LF) agree on the hash
const hashOf = (id) => crypto.createHash('md5').update(fs.readFileSync(path.join(OUT, id + '.svg'), 'utf8').replace(/\r\n/g, '\n').trimEnd()).digest('hex').slice(0, 8);

function sourceLine(ids) {
  const links = ids.map((k) => {
    const s = SRC[k];
    if (!s) throw new Error('unknown source id ' + k);
    if (!s.verified || !s.url) throw new Error('source ' + k + ' is not verified/linkable');
    return `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.linkLabel)}</a>`;
  });
  if (!links.length) return '';
  const joined = links.length === 1 ? links[0] : links.slice(0, -1).join(', ') + ' and ' + links[links.length - 1];
  return `<p class="illus-src">Details per ${joined}.</p>`;
}

export function figureHtml(id) {
  const f = DATA.figures[id];
  if (!f) throw new Error('no figure data for ' + id);
  const lines = [
    `<figure class="illus" id="fig-${id}" data-illustration="${id}">`,
    `  <div class="illus-frame">`,
    `    <img src="/assets/images/illustrations/${id}.svg?v=${hashOf(id)}" width="1200" height="900" loading="lazy" decoding="async" alt="${esc(f.alt)}">`,
    `    <span class="illus-badge">${BADGE}</span>`,
    `  </div>`,
    `  <figcaption class="illus-cap">`,
    `    <p class="illus-title">${esc(f.title)}</p>`,
    `    <ol class="illus-key">${f.key.map(([t, d]) => `<li><strong>${esc(t)}:</strong> ${esc(d)}</li>`).join('')}</ol>`,
  ];
  if (f.note) lines.push(`    <p class="illus-note">${esc(f.note)}</p>`);
  const sl = f.generic ? '' : sourceLine(f.sources);
  if (sl) lines.push('    ' + sl);
  lines.push(`  </figcaption>`, `</figure>`);
  return lines.join('\n');
}

function explodeHtml() {
  const svg = systemInline();
  const f = DATA.figures['roof-system-exploded'];
  const btns = LAYERS.map((L, i) => `<li><button type="button" class="rx-btn" data-rx-layer="${L.key}" data-rx-name="${esc(L.name)}" data-rx-text="${esc(L.text)}" aria-pressed="false" aria-controls="rx-info"><span class="rx-n" aria-hidden="true">${i + 1}</span>${esc(L.name)}</button></li>`).join('\n      ');
  return [
    `<figure class="rx" id="explode-the-roof" data-roof-explode>`,
    `  <div class="rx-frame">`,
    `    <span class="illus-badge">${BADGE}</span>`,
    `    <div class="rx-stage" data-rx-stage>${svg}</div>`,
    `  </div>`,
    `  <div class="rx-panel">`,
    `    <div class="rx-control">`,
    `      <label class="rx-label" for="rx-range">Pull the layers apart</label>`,
    `      <input class="rx-range" id="rx-range" type="range" min="0" max="100" step="1" value="100" aria-valuetext="Pulled apart" data-rx-range>`,
    `      <p class="rx-ends" aria-hidden="true"><span>Together</span><span>Apart</span></p>`,
    `    </div>`,
    `    <div class="rx-info" id="rx-info" aria-live="polite">`,
    `      <p class="rx-info-title" data-rx-info-title>Tap a layer</p>`,
    `      <p class="rx-info-text" data-rx-info-text>Pick any layer to see what it does. Drag the slider to put the roof back together or pull it apart.</p>`,
    `    </div>`,
    `    <ol class="rx-legend">`,
    `      ${btns}`,
    `    </ol>`,
    `  </div>`,
    `  <figcaption class="illus-cap">${sourceLine(f.sources)}</figcaption>`,
    `</figure>`,
  ].join('\n');
}

function ventHtml() {
  const svg = ventilationInline();
  const f = DATA.figures['attic-ventilation'];
  return [
    `<figure class="vx" id="attic-airflow" data-vent-flow>`,
    `  <div class="illus-frame vx-frame">`,
    `    <div class="vx-stage">${svg}</div>`,
    `    <span class="illus-badge">${BADGE}</span>`,
    `  </div>`,
    `  <div class="vx-bar">`,
    `    <button type="button" class="vx-toggle" data-vx-toggle aria-pressed="false" hidden>Pause the airflow</button>`,
    `    <p class="vx-legend"><span class="vx-cool">Cool air in, low</span><span class="vx-warm">Warm air out, high</span></p>`,
    `  </div>`,
    `  <figcaption class="illus-cap">`,
    `    <ol class="illus-key">${f.key.map(([t, d]) => `<li><strong>${esc(t)}:</strong> ${esc(d)}</li>`).join('')}</ol>`,
    `    <p class="illus-note">${esc(f.note)}</p>`,
    `    ${sourceLine(f.sources)}`,
    `  </figcaption>`,
    `</figure>`,
  ].join('\n');
}

function sourcesHtml() {
  const items = Object.entries(SRC).filter(([, s]) => s.verified && s.url).map(([, s]) =>
    `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span class="illus-pub">${esc(s.publisher)}</span></li>`);
  return `<ul class="illus-sources">\n${items.join('\n')}\n</ul>`;
}

// ── stamping ──────────────────────────────────────────────────────────────
function stampText(html) {
  const lf = html.replace(/\r\n/g, '\n');
  let out = lf.replace(/<!-- ILLUS:([a-z0-9-]+):START -->[\s\S]*?<!-- ILLUS:\1:END -->/g,
    (m, id) => `<!-- ILLUS:${id}:START -->\n${figureHtml(id)}\n<!-- ILLUS:${id}:END -->`);
  out = out.replace(/<!-- ILLUS-INLINE:roof-explode:START -->[\s\S]*?<!-- ILLUS-INLINE:roof-explode:END -->/g,
    () => `<!-- ILLUS-INLINE:roof-explode:START -->\n${explodeHtml()}\n<!-- ILLUS-INLINE:roof-explode:END -->`);
  out = out.replace(/<!-- ILLUS-INLINE:vent-flow:START -->[\s\S]*?<!-- ILLUS-INLINE:vent-flow:END -->/g,
    () => `<!-- ILLUS-INLINE:vent-flow:START -->\n${ventHtml()}\n<!-- ILLUS-INLINE:vent-flow:END -->`);
  out = out.replace(/<!-- ILLUS-SOURCES:START -->[\s\S]*?<!-- ILLUS-SOURCES:END -->/g,
    () => `<!-- ILLUS-SOURCES:START -->\n${sourcesHtml()}\n<!-- ILLUS-SOURCES:END -->`);
  return out;
}

function pages() {
  return Object.keys(DATA.pages);
}

function stamp(check) {
  let drift = 0;
  for (const rel of pages()) {
    const file = path.join(ROOT, rel);
    const raw = fs.readFileSync(file, 'utf8');
    const crlf = /\r\n/.test(raw);
    const lf = raw.replace(/\r\n/g, '\n');
    // every listed figure must have a region on that page (and only those)
    const found = [...lf.matchAll(/<!-- ILLUS:([a-z0-9-]+):START -->/g)].map((m) => m[1]);
    const want = DATA.pages[rel];
    const missing = want.filter((id) => !found.includes(id)), extra = found.filter((id) => !want.includes(id));
    if (missing.length || extra.length) { console.error(`  ✗ ${rel}: missing [${missing}] extra [${extra}]`); drift++; continue; }
    const next = stampText(lf);
    if (next !== lf) {
      drift++;
      if (check) { console.error(`  ✗ ${rel}: stamped regions are stale (run --stamp)`); continue; }
      let outText = crlf ? next.replace(/\n/g, '\r\n') : next;
      if (/\r(?!\n)/.test(outText)) throw new Error('lone CR in ' + rel);
      fs.writeFileSync(file, outText);
      console.log(`  stamped ${rel}`);
    }
  }
  if (check) {
    for (const id of Object.keys(FIGURES)) if (!fs.existsSync(path.join(OUT, id + '.svg'))) { console.error('  ✗ missing SVG ' + id); drift++; }
    if (drift) { console.error(`build-illustrations --check: ${drift} problem(s)`); process.exit(1); }
    console.log('build-illustrations --check: all regions current');
  }
}

const args = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (args.includes('--svg')) writeSvgs(args.filter((a) => !a.startsWith('--')));
  else if (args.includes('--stamp')) stamp(false);
  else if (args.includes('--check')) stamp(true);
  else { console.log('usage: --svg [names] | --stamp | --check'); process.exit(2); }
}
