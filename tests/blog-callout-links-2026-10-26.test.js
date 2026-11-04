/**
 * tests/blog-callout-links-2026-10-26.test.js
 *
 * An inline link inside a navy .callout must be readable. Found 2026-10-26 (overnight pass, rendered in Chromium at 1280):
 * 11 links in 7 blog posts painted orange on an orange pill, 1:1 contrast, so the sentence read as a gap
 * (hail-season-prep-checklist, how-long-does-roof-replacement-take-cincinnati, how-to-choose-a-roofer-after-a-storm,
 * the-pipe-boot-fork, why-i-install-lumanail-on-every-elite-roof, why-roofivent-is-on-my-roofs,
 * gaf-vs-owens-corning-vs-atlas-shingles).
 *
 * Cause: each post carries the right rule (2026-08-11: the pill is for the CTA anchor that is a DIRECT child of
 * .callout, `.callout > a`; links inside a <p>/<li> are text: `.callout p a`), and a later <style> block that
 * re-declared the old bare `.callout a{...background...}`. The bare rule has the pill's orange background and the
 * `.callout p a` rule has orange text, so a link inside a paragraph was orange on orange.
 *
 * Source-level, over every public page with a .callout (docs/**, not /pro):
 *   1. no bare `.callout a{...background...}` rule on a page that has a link inside a callout paragraph or list item;
 *   2. no link inside a callout carries an inline `style="color:var(--orange)"` (roof-financing-cincinnati-explained worked
 *      around the bug that way, which left its three links at 3.45:1 once the bug was gone);
 *   3. the colour of those inline links is a light tint that reads on navy (#DD875F, brand orange-light, 4.85:1 or
 *      better) or white, never the brand orange #BD5728, which is 2.8:1 on navy (DESIGN.md "Accent text").
 *
 * Run: node tests/blog-callout-links-2026-10-26.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, '..', 'docs');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' -- ' + String(detail).slice(0, 400) : '')); }
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'pro' && e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const css = (html) => (html.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n').replace(/<\/?style[^>]*>/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ');
// A callout holds no nested <div>, so the first </div> closes it.
const CALLOUT = '<div class="(?:[^"]* )?callout(?: [^"]*)?"[^>]*>';
const callouts = (html) => [...html.matchAll(new RegExp(CALLOUT + '([\\s\\S]*?)</div>', 'g'))].map((m) => m[1]);
const hasInlineLink = (inner) => /<(p|li)\b[^>]*>(?:(?!<\/(?:p|li)>)[\s\S])*?<a\b/.test(inner);
const rule = (sheet, selector) => {
  const out = [];
  const re = new RegExp('(?:^|[}\\s,])' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
  let m; while ((m = re.exec(sheet))) out.push(m[1]);
  return out;
};

const pages = walk(DOCS, []).map((f) => ({ f, html: fs.readFileSync(f, 'utf8') })).filter((p) => new RegExp(CALLOUT).test(p.html));
const withInline = pages.filter((p) => callouts(p.html).some(hasInlineLink));

console.log('\npages with a .callout: ' + pages.length + ', with a link inside a callout paragraph or list item: ' + withInline.length);
ok('the scan finds the pages it is about (22 callout pages, at least 7 with inline links)', pages.length >= 20 && withInline.length >= 7, pages.length + ' / ' + withInline.length);

for (const p of withInline) {
  const name = path.relative(DOCS, p.f).replace(/\\/g, '/');
  const sheet = css(p.html);
  const bare = rule(sheet, '.callout a').filter((body) => /background/.test(body));
  ok(name + ': no bare ".callout a" pill rule beside inline callout links', bare.length === 0, bare[0]);
  const colours = [...rule(sheet, '.callout p a'), ...rule(sheet, '.callout li a')].map((b) => (b.match(/(?:^|;)\s*color:\s*([^;]+)/) || [])[1]).filter(Boolean);
  const painted = callouts(p.html).join('\n').match(/<a\b[^>]*\bstyle="[^"]*color:\s*(?:var\(--orange\)|#bd5728)[^"]*"/gi) || [];
  ok(name + ': no callout link is forced back to brand orange by an inline style (the old workaround)', painted.length === 0, painted[0]);
  ok(name + ': inline callout links are a light tint or white, not brand orange', colours.length > 0 && colours.every((c) => /#dd875f|orange-light|#fff|white/i.test(c) && !/#bd5728/i.test(c)), colours.join(' | '));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
