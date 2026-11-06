#!/usr/bin/env node
/**
 * scripts/index-anchor.js — put a PR's one-line additions where parallel PRs
 * won't collide (PR steward 2026-11-06).
 *
 * Why: on 2026-11-05/06 every PR added its vault line to documentation/INDEX.md
 * and its suite to tests/ci-manifest.json at the SAME spot (the end of the most
 * recent cluster). Git treats two inserts at the same or adjacent line as a
 * conflict, so every merge in the queue knocked the next PR out (4 PRs on
 * 11-05; 11 CRM PRs on 11-06 all inserted after line 715 of the manifest).
 * The fix is placement, not tooling magic: each line goes to a position
 * derived from a hash of its own text, inside the right list. Two PRs then
 * collide only when their hashes land within one line of each other, which
 * is rare in lists of 70+ (INDEX audits) or 840+ (manifest node bucket).
 *
 * Usage (repo root):
 *   node scripts/index-anchor.js index --section "Audits" --line "- [NAME](audit/NAME.md) — what it is"
 *   node scripts/index-anchor.js manifest --test my-thing-2026-11-06.test.js [--bucket node]
 *   add --check to print where it would go without writing.
 *
 * Both modes are idempotent (an existing identical line / entry is left alone)
 * and keep the file's own line endings (CRLF working trees stay CRLF; no lone
 * CR is ever written — see CLAUDE.md "Editing files on Windows").
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX = path.join(ROOT, 'documentation', 'INDEX.md');
const MANIFEST = path.join(ROOT, 'tests', 'ci-manifest.json');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const CHECK = process.argv.includes('--check');

// FNV-1a, 32-bit: stable across Node versions and platforms.
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

function readLines(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const eol = /\r\n/.test(raw) ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  return { eol, lines };
}
function writeLines(file, eol, lines) {
  const out = lines.join(eol);
  for (let i = 0; i < out.length; i++) {
    if (out.charCodeAt(i) === 13 && out.charCodeAt(i + 1) !== 10) throw new Error('refusing to write a lone CR at byte ' + i);
  }
  fs.writeFileSync(file, out);
}

// Pick an insertion slot in [lo, hi] (insert BEFORE that line index; hi = after the last item).
function slot(key, lo, hi) {
  const n = hi - lo + 1;
  return lo + (hash(key) % n);
}

function placeIndex(lines, section, line) {
  const h = lines.findIndex((l) => l.replace(/\s+$/, '') === '## ' + section);
  if (h < 0) throw new Error('INDEX.md has no "## ' + section + '" heading. Headings: ' + lines.filter((l) => /^## /.test(l)).map((l) => l.slice(3)).join(' | '));
  let end = lines.findIndex((l, i) => i > h && /^## /.test(l));
  if (end < 0) end = lines.length;
  // The section's top-level list items ("- " at column 0).
  const items = [];
  for (let i = h + 1; i < end; i++) if (/^- /.test(lines[i])) items.push(i);
  if (!items.length) throw new Error('section "' + section + '" has no "- " list to insert into');
  if (lines.slice(h, end).some((l) => l === line)) return { already: true };
  const k = slot(line, 0, items.length); // 0..items.length
  const at = k < items.length ? items[k] : items[items.length - 1] + 1;
  return { at, of: items.length, k };
}

function placeManifest(lines, bucket, test) {
  const open = lines.findIndex((l) => l === '  "' + bucket + '": [');
  if (open < 0) throw new Error('ci-manifest.json has no top-level "' + bucket + '" array');
  const close = lines.findIndex((l, i) => i > open && /^ {2}\]/.test(l));
  const items = [];
  for (let i = open + 1; i < close; i++) if (/^ {4}"/.test(lines[i])) items.push(i);
  if (items.some((i) => lines[i].trim().replace(/,$/, '') === JSON.stringify(test))) return { already: true };
  if (!items.length) throw new Error('bucket "' + bucket + '" is empty');
  // Insert BEFORE an existing item (so the new line always ends with a comma
  // and the array's last line is never touched).
  const k = slot(test, 0, items.length - 1);
  return { at: items[k], of: items.length, k, text: '    ' + JSON.stringify(test) + ',' };
}

function main() {
  const mode = process.argv[2];
  if (mode === 'index') {
    const section = arg('section');
    const line = arg('line');
    if (!section || !line || !/^- \[/.test(line)) throw new Error('index mode needs --section "<heading>" and --line "- [Name](path) — …"');
    const { eol, lines } = readLines(INDEX);
    const p = placeIndex(lines, section, line);
    if (p.already) { console.log('index-anchor: line already in "' + section + '" — nothing to do'); return; }
    console.log('index-anchor: "' + section + '" slot ' + p.k + ' of ' + p.of + ' (INDEX.md line ' + (p.at + 1) + ')' + (CHECK ? ' [--check, not written]' : ''));
    if (CHECK) return;
    lines.splice(p.at, 0, line);
    writeLines(INDEX, eol, lines);
    return;
  }
  if (mode === 'manifest') {
    const test = arg('test');
    const bucket = arg('bucket', 'node');
    if (!test || !/\.test\.js$/.test(test) || /[\\/]/.test(test)) throw new Error('manifest mode needs --test <file>.test.js (a bare file name under tests/)');
    const { eol, lines } = readLines(MANIFEST);
    const p = placeManifest(lines, bucket, test);
    if (p.already) { console.log('index-anchor: ' + test + ' already in "' + bucket + '" — nothing to do'); return; }
    console.log('index-anchor: "' + bucket + '" slot ' + p.k + ' of ' + p.of + ' (ci-manifest.json line ' + (p.at + 1) + ')' + (CHECK ? ' [--check, not written]' : ''));
    if (CHECK) return;
    lines.splice(p.at, 0, p.text);
    const out = lines.join(eol);
    JSON.parse(out); // must still be valid JSON
    writeLines(MANIFEST, eol, lines);
    return;
  }
  console.log('usage: node scripts/index-anchor.js index --section "<heading>" --line "- [Name](path) — …" [--check]\n       node scripts/index-anchor.js manifest --test <file>.test.js [--bucket node] [--check]');
  process.exit(mode ? 1 : 0);
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('index-anchor: ' + e.message); process.exit(1); }
}
module.exports = { hash, placeIndex, placeManifest };
