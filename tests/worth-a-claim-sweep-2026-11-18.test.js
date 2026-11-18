/**
 * tests/worth-a-claim-sweep-2026-11-18.test.js
 *
 * NBD documents damage; the homeowner decides whether to file. The public site
 * never has Joe predict that a claim is worth filing (Jo, 2026-11-18, finishing
 * the sweep PR #3162 started). Structural scan of every text file under docs/
 * for the retired phrasings:
 *   A  "I'll tell you honestly if it's worth a claim" and its close variants
 *      ("a claim worth filing", "worth a claim", "if a claim is worth filing",
 *      "claim-worthy damage")
 *   B  "whether yours is worth filing depends on your roof and your policy"
 *   C  the "See if it's worth a claim" CTA / "whether it's worth a claim" lead
 * Left alone on purpose: FAQ QUESTIONS people ask ("is it worth filing a claim?"),
 * docs/terms.html, docs/llms-full.txt (regenerates at deploy), docs/pro/ (CRM).
 * The rules are proven red against fixtures below, so they cannot go vacuous.
 * Run: node tests/worth-a-claim-sweep-2026-11-18.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const K = require('./lib/src-kit');
const T = K.suite('WORTH-A-CLAIM SWEEP (2026-11-18)');
const { ok, section } = T;

const DOCS = path.join(K.ROOT, 'docs');
const SKIP = /^(pro\/|admin\/|sites\/|dev\/|terms\.html$|llms-full\.txt$)/;
const RULES = {
  'A: Joe predicts a claim is worth it': /worth a claim|worth an insurance claim|claim[ -]worth(?:y|\s+(?:filing|pursuing))|(?:if|whether)\s+(?:it(?:'|’|&rsquo;)s|a claim is|you have a claim)[^.<>"]{0,40}worth\s+(?:filing|pursuing)|whether[^.<>"]{0,30}claim was worth filing/i,
  'B: "whether yours is worth filing depends on"': /whether yours is worth filing/i,
  'C: worth-a-claim CTA / lead': /See if it(?:'|’|&rsquo;)s worth a claim|whether it(?:'|’|&rsquo;)s worth a claim/i,
};

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(html|txt|xml|js|json|md)$/.test(e.name)) out.push(path.relative(DOCS, p).split(path.sep).join('/'));
  }
  return out;
}

section('the rules can fail (fixtures)');
const FIXTURES = {
  'A: Joe predicts a claim is worth it': ["I'll tell you honestly if it's worth a claim.", 'you have a claim worth filing', 'help you determine if a claim is worth filing.', 'if there&#39;s claim-worthy damage', 'tell you whether it&rsquo;s worth a claim'],
  'B: "whether yours is worth filing depends on"': ['whether yours is worth filing depends on your roof and your policy.'],
  'C: worth-a-claim CTA / lead': ["See if it's worth a claim →", "and whether it's worth a claim."],
};
for (const [name, samples] of Object.entries(FIXTURES)) {
  ok('rule "' + name + '" flags its fixtures', samples.every((s) => RULES[name].test(s.replace('&#39;', "'"))));
}
ok('FAQ questions stay allowed', !Object.values(RULES).some((r) => r.test('Is it still worth filing a storm damage claim?') || r.test('hail damage worth claiming?')));
ok('the replacement wording passes', !Object.values(RULES).some((r) => r.test('I document the damage with photos so you can decide whether to file a claim.')));

section('docs/ is clean');
const files = walk(DOCS, []).filter((r) => !SKIP.test(r));
ok('scanned a real tree', files.length > 300, String(files.length));
for (const [name, re] of Object.entries(RULES)) {
  const hits = [];
  for (const r of files) {
    const t = fs.readFileSync(path.join(DOCS, r), 'utf8');
    const m = t.match(re);
    if (m) hits.push(r + ' :: ' + m[0].slice(0, 60));
  }
  ok(name + ' appears nowhere under docs/', hits.length === 0, hits.slice(0, 5).join(' | '));
}

T.done();
