#!/usr/bin/env node
/**
 * claim-verdict-sweep-2026-11-26.js — one-off, idempotent page sweep (Jo approved
 * 2026-11-26). Finishes what worth-a-claim-sweep-2026-11-18.js (#3169) left on
 * purpose: lines where Joe gives a verdict on the claim ("tell you / walk you
 * through whether a claim makes sense", "advise whether an insurance path makes
 * sense", "determine whether a repair-level claim ... is appropriate", "tell you
 * upfront whether filing makes sense"). Each becomes Jo's approved sentence:
 *
 *   "I document the damage with photos so you can decide whether to file a claim"
 *
 * (third person on pages that speak of "Joe"). tests/claim-wording.test.js now
 * fails the old phrasing through the `claim-verdict` rule in
 * docs/pro/js/claim-wording-filter.js.
 *
 * Same mechanics as the 2026-11-18 sweep: exact, case-sensitive swaps over ALL
 * occurrences in a file (visible FAQ text and FAQPage JSON-LD change together),
 * LF-normalised, written back in the file's own EOL once, asserted free of lone
 * CR. Re-running is a no-op; a swap whose old text is gone but whose new text is
 * present counts as done, anything else is an error. No generated marker region
 * holds these strings.
 *
 * Usage: node scripts/claim-verdict-sweep-2026-11-26.js [--check] [--list]
 * After a real run: node scripts/stamp-page-dates.mjs --write --date=2026-11-26 <touched docs/services pages>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK = process.argv.includes('--check');

const DOC = 'I document the damage with photos so you can decide whether to file a claim';

// [files[], [[old, new], ...]]
const SWEEP = [];
const add = (files, pairs) => SWEEP.push({ files, pairs });
const D = (f) => 'docs/' + f;

// Three blog posts share one closing CTA paragraph.
// docs/llms-full.txt is a deploy-regenerated seed, but tests/claim-wording.test.js
// scans it, so the same three sentences are swapped in it (no full regen: the seed
// lags in git and a regen would carry ~600 lines of unrelated drift).
add(['hail-season-prep-checklist', 'how-to-choose-a-roofer-after-a-storm', 'how-to-file-storm-damage-insurance-claim-ohio'].map((b) => D('blog/' + b + '.html')).concat([D('llms-full.txt')]), [
  ["I'll get on the roof, document everything, and tell you whether a claim makes sense — no pressure either way.",
    "I'll get on the roof and document the damage with photos so you can decide whether to file a claim — no pressure either way."]]);
add([D('services/hail-damage-insurance-claim.html'), D('llms-full.txt')], [
  ["I'll get on your roof, tell you what you actually have, and walk you through whether a claim makes sense.",
    "I'll get on your roof and tell you what you actually have. " + DOC + '.']]);
add([D('services/siding-repair.html'), D('llms-full.txt')], [
  ['Joe will inspect the damage, document it thoroughly, and tell you honestly whether a claim makes sense before you do anything.',
    'Joe will inspect the damage and document it with photos so you can decide whether to file a claim, before you do anything.']]);
add([D('services/hail-damage-covington-ky.html')], [
  ['my free inspection will confirm whether damage occurred and whether a claim makes sense.',
    'my free inspection will confirm whether damage occurred. ' + DOC + '.']]);
add([D('services/roof-repair-fairfield-oh.html')], [
  ['I assess the cause and advise whether an insurance path makes sense before you file anything.',
    'I assess the cause and document the damage with photos so you can decide whether to file a claim.']]);
add([D('services/roof-repair-florence-ky.html')], [
  ['I evaluate storm-related damage and help property owners determine whether a repair-level claim or full replacement claim is appropriate based on what the inspection actually shows.',
    'I evaluate storm-related damage and document it with photos so you can decide whether to file a claim.']]);
// Not on the 2026-11-17 handoff list; the new gate rule found it (same class).
add([D('services/storm-damage-blanchester-oh.html')], [
  ['I document the damage, meet your adjuster, and will tell you upfront whether filing makes sense.',
    DOC + ', and I can meet your adjuster after you file.']]);

// ── drive ────────────────────────────────────────────────────────────────────
const touched = [];
const errors = [];
const byFile = new Map();
for (const s of SWEEP) for (const f of s.files) {
  if (!byFile.has(f)) byFile.set(f, []);
  for (const [o, n] of s.pairs) byFile.get(f).push({ o, n });
}
for (const [rel, swaps] of byFile) {
  const file = path.join(ROOT, rel);
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const before = raw.replace(/\r\n/g, '\n');
  let after = before;
  for (const sw of swaps) {
    if (after.includes(sw.o)) after = after.split(sw.o).join(sw.n);
    else if (!after.includes(sw.n)) errors.push(rel + ': neither old nor new text found for ' + JSON.stringify(sw.o.slice(0, 70)));
  }
  if (after === before) continue;
  touched.push(rel);
  const out = crlf ? after.replace(/\n/g, '\r\n') : after;
  if (/\r(?!\n)/.test(out)) throw new Error('lone CR in ' + rel);
  if (!CHECK) fs.writeFileSync(file, out);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(2); }
console.log((CHECK ? 'would change ' : 'changed ') + touched.length + ' file(s)');
if (process.argv.includes('--list')) console.log(touched.join('\n'));
if (CHECK && touched.length) process.exit(1);
