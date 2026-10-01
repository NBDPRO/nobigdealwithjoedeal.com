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
 *   sci-fi:       matrix, neon, synthwave, vaporwave, deep-space, galaxy, plasma,
 *                 cyberpunk, hologram, quantum, starship, neon-rain, terminal
 *   nature:       forest, ocean, desert, aurora, volcano, glacier, thunderstorm,
 *                 sunset, canyon, coral-reef, tundra, rainforest, underwater, volcanic
 * Themes named after real products or franchises stay colour-only here; a
 * user can put licensed art on their own screen with My Skin.
 *
 * Edit the TILES below, then:  node scripts/build-theme-art.mjs
 * CI drift check:              node scripts/build-theme-art.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs/pro/css/theme-art.css');

// Deterministic scatter (same tiles every build): a small LCG.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const r1 = (n) => Math.round(n * 10) / 10;
function scatter(seed, n, w, h, draw) {
  const r = rng(seed); let out = '';
  for (let i = 0; i < n; i++) out += draw(r1(r() * w), r1(r() * h), r(), i);
  return out;
}
// A sine path across a tile of width w (seamless left↔right).
const wave = (y, amp, w) => `M0 ${y} C${w / 4} ${y - amp} ${w / 4} ${y + amp} ${w / 2} ${y} S${(3 * w) / 4} ${y - amp} ${w} ${y}`;

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

  // ── Sci-fi pack ───────────────────────────────────────────────────────────
  // Glyph rain, frozen: columns of short dashes of different lengths.
  'matrix': { size: [120, 160], svg: svg(120, 160,
    `<g fill='rgba(34,197,94,.10)'>` + scatter(11, 26, 120, 160, (x, y, k) => `<rect x='${Math.round(x / 12) * 12 + 4}' y='${y}' width='3' height='${r1(4 + k * 10)}' rx='1'/>`) + `</g>`) },
  // Neon tubes: two thin diagonal lines with a soft halo.
  'neon': { size: [140, 140], svg: svg(140, 140,
    `<path d='M0 140L140 0M-70 140L70 0M70 140L210 0' stroke='rgba(236,72,153,.06)' stroke-width='6'/>` +
    `<path d='M0 140L140 0M-70 140L70 0M70 140L210 0' stroke='rgba(255,240,246,.10)' stroke-width='1'/>`) },
  // Retro grid: a square floor grid with a brighter horizon line.
  'synthwave': { size: [80, 80], svg: svg(80, 80,
    `<path d='M.5 0V80M0 .5H80' stroke='rgba(244,114,182,.12)' stroke-width='1'/>` +
    `<path d='M0 40.5H80' stroke='rgba(244,114,182,.05)' stroke-width='1'/>`) },
  // Checker floor with soft dots.
  'vaporwave': { size: [64, 64], svg: svg(64, 64,
    `<path d='M0 0H32V32H0ZM32 32H64V64H32Z' fill='rgba(240,171,252,.05)'/>` +
    `<circle cx='48' cy='16' r='1.6' fill='rgba(240,171,252,.14)'/><circle cx='16' cy='48' r='1.6' fill='rgba(240,171,252,.14)'/>`) },
  // Star field: scattered points of three sizes.
  'deep-space': { size: [220, 220], svg: svg(220, 220,
    scatter(21, 34, 220, 220, (x, y, k) => `<circle cx='${x}' cy='${y}' r='${k > .92 ? 1.4 : k > .6 ? .9 : .5}' fill='rgba(224,222,255,${k > .92 ? .22 : .14})'/>`)) },
  // Galaxy: stars plus a faint diagonal dust lane.
  'galaxy': { size: [240, 240], svg: svg(240, 240,
    `<path d='M-20 200C60 150 140 110 260 40' stroke='rgba(99,102,241,.07)' stroke-width='40' fill='none'/>` +
    scatter(37, 30, 240, 240, (x, y, k) => `<circle cx='${x}' cy='${y}' r='${k > .9 ? 1.3 : .7}' fill='rgba(232,234,255,.16)'/>`)) },
  // Plasma: interference waves.
  'plasma': { size: [160, 80], svg: svg(160, 80,
    `<g fill='none' stroke-width='1.2'><path d='${wave(20, 14, 160)}' stroke='rgba(168,85,247,.12)'/><path d='${wave(60, 10, 160)}' stroke='rgba(243,232,255,.07)'/></g>`) },
  // Circuit traces with solder pads.
  'cyberpunk': { size: [120, 120], svg: svg(120, 120,
    `<g fill='none' stroke='rgba(236,72,153,.11)' stroke-width='1.2'><path d='M0 30H40L60 50H120M30 120V90L50 70H80V0M90 120V100H120'/></g>` +
    `<g fill='rgba(255,240,246,.12)'><circle cx='40' cy='30' r='2.2'/><circle cx='50' cy='70' r='2.2'/><circle cx='90' cy='100' r='2.2'/></g>`) },
  // Hologram: thin scan lines.
  'hologram': { size: [8, 8], svg: svg(8, 8, `<rect y='0' width='8' height='1' fill='rgba(187,222,251,.07)'/>`) },
  // Quantum: a dot lattice with an orbit ring.
  'quantum': { size: [72, 72], svg: svg(72, 72,
    `<g fill='rgba(59,130,246,.16)'><circle cx='12' cy='12' r='1.4'/><circle cx='48' cy='48' r='1.4'/></g>` +
    `<ellipse cx='48' cy='48' rx='16' ry='6' fill='none' stroke='rgba(224,242,254,.07)' stroke-width='1' transform='rotate(-30 48 48)'/>`) },
  // Hull plating: panel seams and rivets.
  'starship': { size: [120, 80], svg: svg(120, 80,
    `<path d='M0 .5H120M.5 0V80M60.5 40V80M0 40.5H120' stroke='rgba(226,232,240,.07)' stroke-width='1'/>` +
    `<g fill='rgba(226,232,240,.10)'><circle cx='6' cy='6' r='1.2'/><circle cx='114' cy='6' r='1.2'/><circle cx='66' cy='46' r='1.2'/><circle cx='6' cy='46' r='1.2'/></g>`) },
  // Neon rain: slanted streaks.
  'neon-rain': { size: [120, 160], svg: svg(120, 160,
    `<g stroke='rgba(255,45,155,.13)' stroke-width='1' stroke-linecap='round'>` + scatter(53, 18, 120, 160, (x, y, k) => `<path d='M${x} ${y}l-${r1(3 + k * 4)} ${r1(14 + k * 20)}'/>`) + `</g>`) },
  // Terminal: CRT scan lines.
  'terminal': { size: [6, 6], svg: svg(6, 6, `<rect width='6' height='1' fill='rgba(0,255,0,.06)'/>`) },

  // ── Nature pack ───────────────────────────────────────────────────────────
  // Pine silhouettes along the bottom of each tile.
  'forest': { size: [160, 160], svg: svg(160, 160,
    `<g fill='rgba(34,197,94,.08)'>` + [10, 46, 90, 128].map((x, i) => `<path d='M${x} ${150 - i * 6}l14-38l14 38z'/><path d='M${x + 3} ${126 - i * 6}l11-28l11 28z'/>`).join('') + `</g>`) },
  'ocean': { size: [160, 60], svg: svg(160, 60,
    `<g fill='none' stroke-width='1.4'><path d='${wave(18, 8, 160)}' stroke='rgba(6,182,212,.12)'/><path d='${wave(44, 6, 160)}' stroke='rgba(232,244,248,.06)'/></g>`) },
  // Dune contours.
  'desert': { size: [240, 120], svg: svg(240, 120,
    `<g fill='none' stroke='rgba(212,160,87,.12)' stroke-width='1.2'>` + [20, 50, 80, 110].map((y, i) => `<path d='${wave(y, 12 + i * 2, 240)}'/>`).join('') + `</g>`) },
  // Aurora: soft vertical curtains.
  'aurora': { size: [200, 200], svg: svg(200, 200,
    `<g fill='none' stroke-width='14' stroke-linecap='round'><path d='M30 0C50 70 10 130 30 200' stroke='rgba(52,211,153,.06)'/><path d='M110 0C90 60 140 140 120 200' stroke='rgba(52,211,153,.05)'/><path d='M170 0C185 80 160 120 175 200' stroke='rgba(224,242,241,.04)'/></g>`) },
  // Cooling lava cracks.
  'volcano': { size: [160, 160], svg: svg(160, 160,
    `<path d='M0 40L30 52L44 90L80 98L96 140L160 150M44 90L20 130M80 98L120 60L160 70M120 60L110 0' fill='none' stroke='rgba(239,68,68,.12)' stroke-width='1.4'/>`) },
  // Ice facets.
  'glacier': { size: [120, 120], svg: svg(120, 120,
    `<path d='M0 60L40 20L80 50L120 10M40 20L50 80L0 60M50 80L80 50L110 100L120 60M50 80L60 120M110 100L120 120' fill='none' stroke='rgba(125,211,252,.10)' stroke-width='1'/>`) },
  // Rain with one distant bolt.
  'thunderstorm': { size: [160, 200], svg: svg(160, 200,
    `<g stroke='rgba(232,234,246,.08)' stroke-width='1' stroke-linecap='round'>` + scatter(71, 16, 160, 200, (x, y, k) => `<path d='M${x} ${y}l-2 ${r1(12 + k * 14)}'/>`) + `</g>` +
    `<path d='M120 10l-10 28h8l-12 30' fill='none' stroke='rgba(251,191,36,.14)' stroke-width='1.6' stroke-linejoin='round'/>`) },
  // Sunset: banded horizon stripes.
  'sunset': { size: [40, 40], svg: svg(40, 40, `<rect y='0' width='40' height='3' fill='rgba(249,115,22,.07)'/><rect y='20' width='40' height='1' fill='rgba(255,224,210,.05)'/>`) },
  // Canyon strata.
  'canyon': { size: [240, 90], svg: svg(240, 90,
    `<g fill='none' stroke-width='3'><path d='${wave(15, 4, 240)}' stroke='rgba(194,65,12,.10)'/><path d='${wave(45, 6, 240)}' stroke='rgba(245,222,179,.05)'/><path d='${wave(75, 3, 240)}' stroke='rgba(194,65,12,.08)'/></g>`) },
  // Coral reef: rising bubbles and a branch.
  'coral-reef': { size: [160, 160], svg: svg(160, 160,
    scatter(83, 12, 160, 160, (x, y, k) => `<circle cx='${x}' cy='${y}' r='${r1(1.5 + k * 3)}' fill='none' stroke='rgba(224,242,241,.10)' stroke-width='1'/>`) +
    `<path d='M30 160V130L18 112M30 130L44 110M44 110L40 96' fill='none' stroke='rgba(244,114,182,.12)' stroke-width='2.4' stroke-linecap='round'/>`) },
  // Tundra: wind-blown snow.
  'tundra': { size: [160, 160], svg: svg(160, 160,
    scatter(97, 30, 160, 160, (x, y, k) => `<circle cx='${x}' cy='${y}' r='${k > .8 ? 1.3 : .7}' fill='rgba(226,232,240,.14)'/>`)) },
  // Rainforest leaves.
  'rainforest': { size: [140, 140], svg: svg(140, 140,
    `<g fill='rgba(16,185,129,.08)'><path d='M20 40C40 10 70 10 80 30C60 30 40 40 20 40Z'/><path d='M80 110C100 80 130 80 140 100C120 100 100 110 80 110Z'/><path d='M10 120C20 100 40 96 50 104C38 108 24 116 10 120Z'/></g>`) },
  // Underwater: bubbles and light rays.
  'underwater': { size: [180, 180], svg: svg(180, 180,
    `<path d='M40 0L20 180M120 0L150 180' stroke='rgba(216,255,248,.04)' stroke-width='18'/>` +
    scatter(101, 10, 180, 180, (x, y, k) => `<circle cx='${x}' cy='${y}' r='${r1(1.5 + k * 3.5)}' fill='none' stroke='rgba(0,229,204,.12)' stroke-width='1'/>`)) },
  // Volcanic: glowing fissures.
  'volcanic': { size: [180, 180], svg: svg(180, 180,
    `<path d='M0 90L40 80L60 110L100 104L130 140L180 130M60 110L70 180M100 104L120 60L180 40M120 60L100 0' fill='none' stroke='rgba(255,61,0,.14)' stroke-width='1.6'/>`) },
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
