#!/usr/bin/env node
/**
 * scripts/seasonal-ann-slide.js: the seasonal slide in the homeowner announcement bar (2026-11-26).
 *
 * The announcement bar (`<div class="ann-bar">` with its `.ann-slide`s) is hand-copied into every homeowner page,
 * not a partial, and several pages run their own slide rotator, which reads the slides once at load. So a seasonal
 * message has to be in the static HTML to rotate correctly. This script owns ONE marker-tagged slide
 * (`data-nbd-season-ann="<season>"`), placed second, right after the first (active) slide, so it shows 4 seconds in.
 *
 *   node scripts/seasonal-ann-slide.js --season=winter   turn a season on (replaces any other season's slide)
 *   node scripts/seasonal-ann-slide.js --off             turn the seasonal slide off everywhere
 *   node scripts/seasonal-ann-slide.js --check           report which season is on, and exit 1 if pages disagree
 *
 * Add a dry run with --dry. Edits keep each file's line endings. To change the wording, edit SEASONS below and
 * rerun --season. Contractor surfaces (pro/, sites/, admin/) never get it. The free-roof slide is a separate,
 * deliberately-off thing (scripts/wire-free-roof-entry-points.js); this script never adds or removes it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOCS = path.resolve(__dirname, '..', 'docs');
const SKIP_DIRS = new Set(['admin', 'pro', 'sites', 'assets', 'deploy', 'tools', 'dev']);
const ATTR = 'data-nbd-season-ann';

// Claim rule: "24/7 same-day tarping when daylight and weather allow" is Jo's approved wording (2026-11-17).
const SEASONS = {
  winter: {
    href: '/services/emergency-roof-tarping',
    icon: '<path d="M12 2 V22"/><path d="M3.3 7 L20.7 17"/><path d="M3.3 17 L20.7 7"/>',
    long: 'Ice Dam or Storm Leak? 24/7 Same-Day Tarping When Daylight &amp; Weather Allow',
    short: 'Winter Leak? Emergency Tarping',
  },
};

function slideHtml(season) {
  const s = SEASONS[season];
  return `<div class="ann-slide" ${ATTR}="${season}"><svg class="ico" viewBox="0 0 24 24" style="margin-right:6px">${s.icon}</svg>`
    + `<a href="${s.href}" style="color:inherit;text-decoration:none"><span class="ann-text" data-long="${s.long}" data-short="${s.short}">${s.long}</span></a></div>`;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.isFile() && e.name.endsWith('.html')) out.push(path.join(dir, e.name));
  }
  return out;
}

const SEASON_LINE = new RegExp(`\\r?\\n[ \\t]*<div class="ann-slide" ${ATTR}="[^"]*">.*?</div>(?=\\r?\\n)`, 'g');

/** Removes any seasonal slide line. */
function strip(html) { return html.replace(SEASON_LINE, ''); }

/** Inserts the season's slide after the first slide of the first .ann-bar; null when the page has no slide bar. */
function insert(html, season) {
  const bar = html.indexOf('<div class="ann-bar"');
  if (bar < 0) return null;
  const first = html.indexOf('<div class="ann-slide', bar);
  const barEnd = html.indexOf('\n</div>', bar);
  if (first < 0 || (barEnd >= 0 && first > barEnd)) return null;
  const close = html.indexOf('</div>', first); // slides hold an svg, a span and maybe a link, never a nested div
  if (close < 0) return null;
  const lineStart = html.lastIndexOf('\n', first) + 1;
  const indent = html.slice(lineStart, first).match(/^[ \t]*/)[0];
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const at = close + '</div>'.length;
  return html.slice(0, at) + eol + indent + slideHtml(season) + html.slice(at);
}

function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const off = args.includes('--off');
  const check = args.includes('--check');
  const seasonArg = (args.find((a) => a.startsWith('--season=')) || '').slice('--season='.length);
  if (!off && !check && !SEASONS[seasonArg]) {
    console.error(`usage: --season=<${Object.keys(SEASONS).join('|')}> | --off | --check  [--dry]`);
    process.exit(2);
  }
  const files = walk(DOCS);
  const state = new Map();
  let changed = 0;
  for (const f of files) {
    const html = fs.readFileSync(f, 'utf8');
    if (!html.includes('<div class="ann-bar"') || !html.includes('class="ann-slide')) continue;
    const m = html.match(new RegExp(`${ATTR}="([^"]*)"`));
    const now = m ? m[1] : 'off';
    state.set(now, (state.get(now) || 0) + 1);
    if (check) continue;
    let next = strip(html);
    if (!off) next = insert(next, seasonArg) || next;
    if (/\r(?!\n)/.test(next)) throw new Error(`lone CR would be written to ${f}`);
    if (next !== html) {
      changed++;
      if (!dry) fs.writeFileSync(f, next);
    }
  }
  const summary = [...state].map(([k, v]) => `${k}: ${v}`).join(', ');
  if (check) {
    console.log(`seasonal slide by page: ${summary}`);
    process.exit(state.size > 1 ? 1 : 0);
  }
  console.log(`${dry ? '[dry] would change' : 'changed'} ${changed} page(s); before: ${summary}; now: ${off ? 'off' : seasonArg}`);
}

if (require.main === module) main();
module.exports = { insert, strip, slideHtml, SEASONS, ATTR };
