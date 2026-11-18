#!/usr/bin/env node
/**
 * worth-a-claim-sweep-2026-11-18.js — one-off, idempotent page sweep (Jo approved
 * 2026-11-18). Finishes the claim-prediction cleanup PR #3162 started on three
 * pages. NBD documents damage; the homeowner decides whether to file; NBD never
 * predicts that a claim is worth filing, will be covered, approved or paid.
 *
 * Every swap is an exact, case-sensitive string replacement applied to ALL
 * occurrences in the file, so the visible text and the matching FAQPage JSON-LD /
 * meta / og copy change together. Files are read, normalised to LF, edited and
 * written back in the file's own EOL (one conversion at write time, asserted free
 * of lone CR). Re-running is a no-op. A swap whose old text is gone but whose new
 * text is present counts as already done; anything else is an error.
 *
 *   A  "I'll tell you honestly if it's worth a claim" and close variants
 *   B  "whether yours is worth filing depends on your roof and your policy"
 *   C  "See if it's worth a claim" CTA and the storm-report lead line
 *   D  FAQ answers that predicted or promised an outcome (questions stay)
 *   E  "covered by insurance?" answers that promised coverage (questions stay)
 *
 * Guide pages are built from site-src/guides/*.md by build-guides.js: the Markdown
 * and the page get the same swap, and build-guides --check proves they agree.
 * docs/llms-full.txt regenerates at deploy and is not touched. Generated marker
 * regions (nbd:partial, TOWN*) hold none of these strings (build-town-pages
 * --check and apply-partials --check stay green).
 *
 * Usage: node scripts/worth-a-claim-sweep-2026-11-18.js [--check] [--list]
 * After a real run: node scripts/stamp-page-dates.mjs --write --date=2026-11-18 <touched docs/services + docs/areas pages>
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CHECK = process.argv.includes('--check');

const DOC = 'I document the damage with photos so you can decide whether to file a claim.';

// [pattern, files[], [[old, new], ...]]
const SWEEP = [];
const add = (pattern, files, pairs) => SWEEP.push({ pattern, files, pairs });
const D = (f) => 'docs/' + f;

// ── A: "I'll tell you honestly if it's worth a claim" (and variants) ──────────
add('A', ['guides/hail-photo-baseline-sheet.html', 'guides/home-care-warranty-card.html', 'guides/kentucky-ohio-storm-claim-guide.html',
  'guides/roof-financing-explained.html', 'blog/signs-your-roof-needs-replacement-vs-repair.html'].map(D)
  .concat(['site-src/guides/hail-photo-baseline-sheet.md', 'site-src/guides/home-care-warranty-card.md',
    'site-src/guides/kentucky-ohio-storm-claim-guide.md', 'site-src/guides/roof-financing-explained.md']),
  [["I'll tell you honestly if it's worth a claim.", DOC]]);
add('A', [D('guides/kentucky-ohio-storm-claim-guide.html'), 'site-src/guides/kentucky-ohio-storm-claim-guide.md'], [
  ["I'll tell you straight whether it's storm damage, and whether it's worth a claim.",
    "I'll tell you straight whether it's storm damage. I document it with photos so you can decide whether to file a claim."]]);
add('A', [D('guides/kentucky-ohio-storm-claim-guide.html')], [
  ["tell you straight whether it's storm damage and whether it's worth a claim.",
    "tell you straight whether it's storm damage. I document it with photos so you can decide whether to file a claim."]]);
add('A', ['batavia-oh', 'cincinnati-oh', 'loveland-oh', 'mason-oh', 'west-chester-oh'].map((t) => D('services/roof-repair-' + t + '.html')), [
  ["and the damage, and I'll tell you honestly if it's worth a claim. If it is, I document the damage — and if it's maintenance-related,",
    'and the damage. ' + DOC.replace(/\.$/, '') + ", and if it's maintenance-related,"]]);
add('A', [D('services/roof-repair.html')], [
  ['it may be worth a claim. Whether insurance covers it depends on your policy and the damage, and I\'ll tell you honestly if it\'s worth a claim. Joe will document everything and explain how the claim process works.',
    'a claim may be an option. Whether insurance covers it depends on your policy and the damage. ' + DOC + ' Joe will also explain how the claim process works.']]);
add('A', [D('services/roof-repair-anderson-township-oh.html')], [
  ['I also assess whether a claim is worth filing for the repair scope.',
    'I also document the damage with photos so you can decide whether to file a claim for the repair scope.']]);
add('A', [D('services/roof-replacement.html')], [
  ["Whether insurance covers it depends on your policy and the damage — I'll tell you honestly if it's worth a claim. Joe will inspect your roof, document the damage, and tell you honestly whether you have a claim worth filing — before you do anything else.",
    'Whether insurance covers it depends on your policy and the damage. Joe will inspect your roof and document the damage with photos so you can decide whether to file a claim, before you do anything else.']]);
add('A', [D('services/roof-replacement-erlanger-ky.html')], [
  ['it may be worth a claim.', 'a claim may be an option.'],
  ['will assess whether your damage qualifies and document it so you can file the claim with the right evidence.',
    'will document the damage so you can decide whether to file, with the right evidence in hand.']]);
add('A', [D('services/roof-inspection.html')], [
  ['and whether storm damage is worth a claim.', 'and any storm damage, documented with photos so you can decide whether to file a claim.']]);
add('A', [D('services/siding-repair.html')], [
  ['<strong>it may be worth an insurance claim</strong>', '<strong>a claim may be an option</strong>']]);
add('A', [D('services/storm-damage.html')], [
  ["he'll inspect the damage and tell you honestly whether you have a claim worth filing.",
    "he'll inspect the damage and document it with photos so you can decide whether to file a claim."],
  ['I photograph every hit and tell you straight whether it&rsquo;s worth filing.', 'I photograph every hit so you can decide whether to file.']]);
add('A', [D('services/storm-damage-blue-ash-oh.html')], [
  ["my free inspection will tell you whether you have a claim worth filing. If the answer is no, you've lost nothing. If the answer is yes, early documentation",
    "my free inspection documents the damage with photos so you can decide whether to file a claim. If you decide not to file, you've lost nothing. If you do file, early documentation"]]);
add('A', [D('services/storm-damage-covington-ky.html')], [
  ['call Joe first for a free inspection so you know whether there is a claim worth filing, and file with my documentation package in hand.',
    'call Joe first for a free inspection, then decide whether to file with my documentation package in hand.']]);
add('A', [D('services/storm-damage-lexington-ky.html')], [
  ['an honest read on whether a claim is worth filing,', 'photos so you can decide whether to file a claim,']]);
add('A', [D('services/hail-damage-fayetteville-oh.html')], [
  ['and help you determine if a claim is worth filing.', 'and document it with photos so you can decide whether to file a claim.']]);
add('A', [D('services/hail-damage-insurance-claim.html')], [
  ["Joe will tell you upfront if your deductible situation makes filing worth it or not.",
    'Joe documents the damage so you can weigh it against your deductible and decide whether to file.']]);
add('A', [D('services/hail-damage-blanchester-oh.html')], [
  ['homeowners never find out whether a claim was worth filing.', 'homeowners never find out what is actually on their roof.']]);
add('A', [D('services/hail-damage-blue-ash-oh.html')], [
  ["If there's no claim-worthy damage, I'll tell you honestly. If there is, I walk you through the next steps.",
    DOC.replace(/\.$/, '') + ', and I walk you through the next steps.']]);
add('A', [D('services/hail-damage-lexington-ky.html')], [
  ["My free inspection answers it definitively — if there's claim-worthy damage I document it, and if there isn't, I'll tell you to keep your deductible in your pocket.",
    'My free inspection shows what is actually on your roof. ' + DOC],
  ["and if your roof doesn't have claim-worthy damage, I'll tell you that too.", 'and I document what I find with photos so you can decide whether to file a claim.']]);
add('A', [D('services/hail-damage-amelia-oh.html')], [
  ['Even modest hail can cause claim-worthy damage on these older roofs.', 'Even modest hail can damage these older roofs.']]);
add('A', [D('services/hail-damage-mt-orab-oh.html')], [
  ['is the only way to confirm claim-worthy damage.', 'is the only way to confirm hail damage.']]);
add('A', [D('blog/cincinnati-hail-season-2026.html')], [
  ["and notes, and you'll know whether there's a claim worth filing. If you file,", 'and notes, so you can decide whether to file a claim. If you file,']]);
add('A', [D('blog/how-long-roof-insurance-claim-ohio.html')], [
  ["an inspection first tells you whether there's a claim worth filing — then call your insurer", 'an inspection first documents the damage so you can decide whether to file — then call your insurer']]);
add('A', [D('blog/how-to-choose-a-roofer-after-a-storm.html')], [
  ['An honest verdict, including "don\'t file."</strong> Some damage isn\'t worth a claim.', 'An honest write-up, including "nothing here."</strong> Some roofs have no storm damage.']]);
add('A', [D('blog/how-to-file-storm-damage-insurance-claim-ohio.html')], [
  ["and whether it looks worth filing. What a claim pays", 'and you have the photos to decide whether to file. What a claim pays']]);
add('A', [D('blog/my-roof-is-too-old-will-insurance-still-pay.html')], [
  ["Whether yours is worth a claim depends on your policy and the damage, and I'll tell you honestly.",
    'Whether to file a claim is your call, and it depends on your policy and the damage. I document the damage with photos so you can decide.'],
  ["I'll tell you honestly what's there. If there's nothing worth filing, I'll say so. If there is — I'll make sure you know your options.",
    "I'll tell you honestly what's there. " + DOC]]);

// ── B: hail-damage town pages ────────────────────────────────────────────────
add('B', ['batavia-oh', 'cincinnati-oh', 'florence-ky', 'loveland-oh', 'mason-oh', 'west-chester-oh'].map((t) => D('services/hail-damage-' + t + '.html')), [
  ["Your neighbor's claim doesn't decide yours; whether yours is worth filing depends on your roof and your policy.",
    "Your neighbor's claim doesn't decide yours. Whether to file is your call; I document what I find so you can decide."]]);

// ── C: CTA and lead lines that describe a claim verdict instead of the tool ──
add('C', [D('storm-alerts.html')], [['See if it\'s worth a claim →', 'Check recent storm activity at your address →']]);
add('C', [D('storm-report.html')], [['every event, a map, and whether it\'s worth a claim.', 'every event and a map of storm activity near your address.']]);

// ── D: FAQ answers (questions stay) ──────────────────────────────────────────
add('D', [D('services/storm-damage-erlanger-ky.html')], [
  ["That depends on your deductible and the actual scope of damage. My inspection is free — I assess the real damage, give you an honest read on whether a claim makes sense, and let you decide. No pressure either way.",
    'That depends on your policy, your deductible and the actual scope of damage. My inspection is free. I document the real damage with photos so you can decide whether to file a claim. No pressure either way.']]);
add('D', [D('services/storm-damage-indian-hill-oh.html')], [
  ["On high-value Indian Hill properties, the repair scope is often large enough that the claim exceeds the deductible by a significant margin. My free inspection determines the full scope before you decide whether to file. There's no cost to find out what you're dealing with.",
    "That depends on your policy, your deductible and the actual scope of damage. My free inspection documents the full scope with photos so you can decide whether to file. There's no cost to find out what you're dealing with."]]);
add('D', [D('services/hail-damage-lebanon-oh.html')], [
  ['My free inspection determines whether damage meets the threshold for a successful Warren County claim.',
    'My free inspection documents the damage with photos so you can decide whether to file a claim.']]);

// ── E: "covered by insurance?" answers (questions stay) ──────────────────────
add('E', [D('services/roof-replacement-fort-mitchell-ky.html')], [
  ["Yes, if the damage qualifies as a covered event under your Kentucky homeowner's policy. I have 7+ years of insurance restoration experience and will assess whether your roof damage meets the threshold, document it for your claim, and meet your adjuster on-site.",
    "It depends on your policy and the damage. Whether your Kentucky homeowner's policy covers it, and what it pays, is between you and your insurer. I have 7+ years of insurance restoration experience, document the damage with photos so you can decide whether to file a claim, and can meet your adjuster on-site after you file."]]);
add('E', [D('services/storm-damage-mason-oh.html')], [
  ['Wind, hail, and falling debris are standard covered perils in Ohio. I document the damage',
    'Wind, hail, and falling debris are commonly covered perils on Ohio policies, but whether yours covers your damage is between you and your insurer. I document the damage']]);

// ── drive ────────────────────────────────────────────────────────────────────
const touched = new Map(); // rel -> Set(pattern)
const counts = new Map();  // pattern -> Set(rel)
const errors = [];
const byFile = new Map();
for (const s of SWEEP) for (const f of s.files) {
  if (!byFile.has(f)) byFile.set(f, []);
  for (const [o, n] of s.pairs) byFile.get(f).push({ pattern: s.pattern, o, n });
}
for (const [rel, swaps] of byFile) {
  const file = path.join(ROOT, rel);
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const before = raw.replace(/\r\n/g, '\n');
  let after = before;
  for (const sw of swaps) {
    if (after.includes(sw.o)) {
      after = after.split(sw.o).join(sw.n);
      if (!touched.has(rel)) touched.set(rel, new Set());
      touched.get(rel).add(sw.pattern);
    } else if (!after.includes(sw.n)) {
      errors.push(rel + ': neither old nor new text found for ' + JSON.stringify(sw.o.slice(0, 70)));
    }
  }
  if (after === before) continue;
  const out = crlf ? after.replace(/\n/g, '\r\n') : after;
  if (/\r(?!\n)/.test(out)) throw new Error('lone CR in ' + rel);
  if (!CHECK) fs.writeFileSync(file, out);
}
if (errors.length) { console.error(errors.join('\n')); process.exit(2); }
for (const [rel, pats] of touched) for (const p of pats) { if (!counts.has(p)) counts.set(p, new Set()); counts.get(p).add(rel); }
console.log((CHECK ? 'would change ' : 'changed ') + touched.size + ' file(s): ' +
  [...counts].sort().map(([p, s]) => p + '=' + s.size).join(' '));
if (process.argv.includes('--list')) console.log([...touched.keys()].join('\n'));
if (CHECK && touched.size) process.exit(1);
