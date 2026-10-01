#!/usr/bin/env node
/**
 * scripts/build-theme-art.mjs — builds docs/pro/css/theme-art.css.
 *
 * Theme art packs (2026-10-01). Most CRM themes were colour swaps on a phone:
 * the animated canvas overlays in theme-overlays.js skip phones and reduced
 * motion. This adds STATIC art: an original SVG tile per theme, painted on
 * the page background behind everything. It's cheap, works on every device
 * and never moves.
 *
 * Every tile here is drawn from scratch in code (no third-party art), low
 * contrast against the theme's page colour so text on the page stays readable.
 * Packs:
 *   construction: blueprint, hard-hat, concrete, copper-pipe, safety-orange,
 *                 crane, diesel, sawdust, brick, toolbox
 *
 * Edit the TILES below, then:  node scripts/build-theme-art.mjs
 * CI drift check:              node scripts/build-theme-art.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/pro/css/theme-art.css');

const svg = (w, h, body) => `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`;
// Encode for a CSS url("data:…"): keep it readable, escape what CSS/URLs need.
const dataUri = (s) => 'data:image/svg+xml,' + s.replace(/\s{2,}/g, ' ').replace(/[%#<>"{}|\\^`]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export const TILES = {
  // Drafting grid: 20px minor, 100px major, small registration crosses.
  'blueprint': { size: [100, 100], svg: svg(100, 100,
    `<g fill='none' stroke='rgba(56,189,248,.09)' stroke-width='1'>` +
    [20, 40, 60, 80].map((v) => `<path d='M${v}.5 0V100M0 ${v}.5H100'/>`).join('') + `</g>` +
    `<path d='M.5 0V100M0 .5H100' fill='none' stroke='rgba(56,189,248,.2)' stroke-width='1'/>` +
    `<path d='M47 50h6M50 47v6' stroke='rgba(224,242,255,.18)' stroke-width='1'/>`) },

  // Site survey contour lines (tile repeats seamlessly left to right).
  'hard-hat': { size: [240, 120], svg: svg(240, 120,
    `<g fill='none' stroke='rgba(234,179,8,.10)' stroke-width='1.2'>` +
    [14, 38, 62, 86, 110].map((y, i) => `<path d='M0 ${y} C60 ${y - 10 - i} 60 ${y + 10 + i} 120 ${y} S180 ${y - 10 - i} 240 ${y}'/>`).join('') + `</g>`) },

  // Poured concrete: stitched fractal noise plus a few aggregate flecks.
  'concrete': { size: [180, 180], svg: svg(180, 180,
    `<filter id='n' x='0' y='0'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='2' stitchTiles='stitch'/>` +
    `<feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .11 0'/></filter>` +
    `<rect width='180' height='180' filter='url(#n)'/>` +
    `<g fill='rgba(226,232,240,.07)'><circle cx='23' cy='41' r='1.6'/><circle cx='131' cy='19' r='1.2'/><circle cx='97' cy='122' r='1.8'/><circle cx='158' cy='151' r='1.1'/><circle cx='51' cy='160' r='1.4'/></g>`) },

  // Copper pipe runs: a horizontal run, an elbow into a vertical drop, couplings.
  'copper-pipe': { size: [160, 160], svg: svg(160, 160,
    `<g fill='none' stroke-linecap='butt'>` +
    `<path d='M0 40H96a24 24 0 0 1 24 24V160' stroke='rgba(194,119,74,.16)' stroke-width='12'/>` +
    `<path d='M0 37H96a27 27 0 0 1 27 27V160' stroke='rgba(245,222,179,.08)' stroke-width='2'/>` +
    `<path d='M120 0V16' stroke='rgba(194,119,74,.16)' stroke-width='12'/></g>` +
    `<g fill='rgba(194,119,74,.22)'><rect x='40' y='32' width='8' height='16' rx='1.5'/><rect x='112' y='110' width='16' height='8' rx='1.5'/></g>`) },

  // Hazard striping, kept faint so it reads as texture, not warning.
  'safety-orange': { size: [48, 48], svg: svg(48, 48,
    `<path d='M0 48L48 0H24L0 24ZM48 24V48H24Z' fill='rgba(249,115,22,.07)'/>`) },

  // Tower-crane lattice: chords top and bottom, a zig-zag web between.
  'crane': { size: [80, 140], svg: svg(80, 140,
    `<g fill='none' stroke='rgba(251,191,36,.12)' stroke-width='1.4'>` +
    `<path d='M0 20.5H80M0 60.5H80'/><path d='M0 60L20 20L40 60L60 20L80 60'/></g>`) },

  // Diamond plate: raised treads in two directions with a top highlight.
  'diesel': { size: [36, 36], svg: svg(36, 36,
    `<g fill='rgba(232,232,224,.06)' stroke='rgba(232,232,224,.10)' stroke-width='.8'>` +
    `<rect x='3' y='8' width='14' height='4' rx='2' transform='rotate(45 10 10)'/>` +
    `<rect x='21' y='26' width='14' height='4' rx='2' transform='rotate(-45 28 28)'/></g>`) },

  // Wood grain: noise stretched along the board, warm-tinted.
  'sawdust': { size: [240, 240], svg: svg(240, 240,
    `<filter id='g' x='0' y='0'><feTurbulence type='fractalNoise' baseFrequency='.008 .16' numOctaves='3' seed='7' stitchTiles='stitch'/>` +
    `<feColorMatrix values='0 0 0 0 .63  0 0 0 0 .45  0 0 0 0 .29  0 0 0 .16 0'/></filter>` +
    `<rect width='240' height='240' filter='url(#g)'/>`) },

  // Running-bond brick: faces faintly lit, mortar is the page colour.
  'brick': { size: [120, 60], svg: svg(120, 60,
    `<g fill='rgba(185,28,28,.11)'>` +
    `<rect x='1' y='1' width='58' height='27' rx='1'/><rect x='61' y='1' width='58' height='27' rx='1'/>` +
    `<rect x='-29' y='31' width='58' height='27' rx='1'/><rect x='31' y='31' width='58' height='27' rx='1'/><rect x='91' y='31' width='58' height='27' rx='1'/></g>` +
    `<g fill='rgba(255,228,214,.04)'><rect x='1' y='1' width='58' height='3'/><rect x='61' y='1' width='58' height='3'/><rect x='31' y='31' width='58' height='3'/></g>`) },

  // Pegboard: punched holes with a faint lit rim.
  'toolbox': { size: [28, 28], svg: svg(28, 28,
    `<circle cx='14' cy='14' r='3.2' fill='rgba(0,0,0,.45)'/>` +
    `<circle cx='14' cy='14' r='3.6' fill='none' stroke='rgba(226,232,240,.07)' stroke-width='.8'/>`) },
};

export function buildCss() {
  const lines = [];
  lines.push('/* GENERATED by scripts/build-theme-art.mjs — do not edit by hand.');
  lines.push(' * Static theme art: an original SVG tile per theme on the page background.');
  lines.push(' * Works on phones and under reduced motion (nothing animates). Yields to');
  lines.push(' * My Skin\'s wallpaper (it paints a layer above the page background) and is');
  lines.push(' * dropped entirely when the user asks for more contrast. */');
  for (const [id, t] of Object.entries(TILES)) {
    const sel = `:root[data-theme="${id}"]`;
    lines.push('');
    lines.push(`${sel} {`);
    lines.push(`  background-color: var(--bg);`);
    lines.push(`  background-image: url("${dataUri(t.svg)}");`);
    lines.push(`  background-size: ${t.size[0]}px ${t.size[1]}px;`);
    lines.push(`  background-attachment: fixed;`);
    lines.push('}');
    lines.push(`${sel} body {`);
    lines.push('  background: transparent;');
    lines.push('}');
  }
  lines.push('');
  lines.push('@media (prefers-contrast: more) {');
  lines.push('  ' + Object.keys(TILES).map((id) => `:root[data-theme="${id}"]`).join(',\n  ') + ' {');
  lines.push('    background-image: none;');
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const css = buildCss();
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (cur !== css) { console.error('theme-art.css is stale: run node scripts/build-theme-art.mjs'); process.exit(1); }
    console.log(`theme-art: ${Object.keys(TILES).length} tiles, theme-art.css up to date`);
  } else {
    fs.writeFileSync(OUT, css);
    console.log(`theme-art: wrote ${Object.keys(TILES).length} tiles to docs/pro/css/theme-art.css (${css.length} bytes)`);
  }
}
