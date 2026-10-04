/**
 * tests/faq-schema-sync-2026-10-03.test.js — every FAQPage JSON-LD answer on
 * the public site says what the page visibly says.
 *
 * WHY: Google's FAQ structured-data guidelines require the marked-up answer to
 * be the answer the visitor can read on the page. A 2026-10-03 audit found 17
 * answers on 9 pages that had drifted — the visible copy was reworded (pricing,
 * pledge and guarantee wording, Kentucky-safe claim wording) and the JSON-LD
 * copy was not. The visible text is the source of truth; the schema follows it.
 *
 * HOW: for every public .html under docs/ (pro/, admin/, sites/, dev/ are the
 * CRM and private trees — skipped), parse each application/ld+json block, find
 * FAQPage nodes (top level, arrays, or @graph), and for each Question assert
 * that the acceptedAnswer text — tags stripped, entities decoded, whitespace,
 * quotes and dashes normalised — appears verbatim in the page's visible text
 * (the same page with <script>, <style>, <template>, <noscript> and comments
 * removed). A paraphrase, an extra clause, or a stale figure all fail.
 *
 * The helpers are exported so the behaviour fixtures below prove the matcher
 * can go red (a drifted answer fails, an identical answer with different
 * markup/whitespace passes).
 *
 * Run: node tests/faq-schema-sync-2026-10-03.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const SKIP_TOP = /^(pro|admin|sites|dev)(\/|$)/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'vendor']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"',
  hellip: '...', rarr: '->', larr: '<-', trade: '(tm)', reg: '(r)', copy: '(c)',
  times: 'x', middot: '.', bull: '.', deg: ' degrees', frac12: '1/2', shy: '',
};

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

function norm(s) {
  return decode(String(s)
    // inline tags join their neighbours ("<a>Permit Central</a>’s"); block
    // tags separate words
    .replace(/<\/?(a|strong|em|b|i|u|span|abbr|sup|sub|small|mark|code|time)\b[^>]*>/gi, '')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‒–—―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/™/g, '(tm)').replace(/®/g, '(r)').replace(/©/g, '(c)')
    .replace(/→/g, '->')
    .replace(/[   ​]/g, ' ')
    .replace(/\s+/g, ' ')
    // spacing around punctuation differs between markup and JSON copies
    .replace(/\s+([.,;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s*-\s*/g, ' - ')
    .trim();
}

function visibleText(html) {
  return norm(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' '));
}

function faqPairs(html) {
  const out = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    const isFaq = t === 'FAQPage' || (Array.isArray(t) && t.includes('FAQPage'));
    if (isFaq) {
      const ents = [].concat(node.mainEntity || []);
      for (const q of ents) {
        if (!q || !q.acceptedAnswer) continue;
        const a = [].concat(q.acceptedAnswer)[0];
        out.push({ q: String(q.name || ''), a: String((a && a.text) || '') });
      }
    }
    if (node['@graph']) walk(node['@graph']);
  };
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    walk(data);
  }
  return out;
}

function mismatches(html) {
  const vis = visibleText(html);
  return faqPairs(html).filter((p) => !vis.includes(norm(p.a)));
}

module.exports = { norm, visibleText, faqPairs, mismatches };

if (require.main === module) {
  let failed = 0;
  let passed = 0;
  const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.error('  ✗ ' + msg); } };

  // ── Behaviour fixtures: the matcher must be able to go red ──
  const page = (visible, answer) => `<!doctype html><html><head><title>x</title>
<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q?', acceptedAnswer: { '@type': 'Answer', text: answer } }] })}</script>
</head><body><details><summary>Q?</summary><p>${visible}</p></details></body></html>`;
  ok(mismatches(page('Yes &mdash; most roofs take <strong>one day</strong>.', 'Yes — most roofs take one day.')).length === 0,
    'fixture: identical answer with different markup/entities/dashes passes');
  ok(mismatches(page('Most roofs take one day.', 'Most roofs take one day, sometimes two.')).length === 1,
    'fixture: answer with an extra clause the page does not show fails');
  ok(mismatches(page('The plan is $199 a year.', 'The plan is $149 a year.')).length === 1,
    'fixture: stale figure fails');
  ok(mismatches(`<html><head><script type="application/ld+json">{"@graph":[{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q","acceptedAnswer":{"@type":"Answer","text":"Hidden only in schema."}}]}]}</script></head><body><p>Something else.</p></body></html>`).length === 1,
    'fixture: FAQPage inside @graph is checked');
  ok(mismatches(`<html><head></head><body><script>var a = "Only in a script.";</script><script type="application/ld+json">{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Q","acceptedAnswer":{"@type":"Answer","text":"Only in a script."}}]}</script></body></html>`).length === 1,
    'fixture: text that exists only inside a <script> does not count as visible');

  // ── The real tree ──
  const files = [];
  (function walkDir(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(DOCS, abs).split(path.sep).join('/');
      if (SKIP_TOP.test(rel)) continue;
      if (ent.isDirectory()) walkDir(abs);
      else if (ent.name.endsWith('.html')) files.push([rel, abs]);
    }
  })(DOCS);

  let pages = 0;
  let answers = 0;
  for (const [rel, abs] of files) {
    const html = fs.readFileSync(abs, 'utf8');
    if (!/FAQPage/.test(html)) continue;
    const pairs = faqPairs(html);
    if (!pairs.length) continue;
    pages++;
    answers += pairs.length;
    for (const p of mismatches(html)) {
      ok(false, `${rel}: FAQ answer not found in visible text\n      Q: ${p.q}\n      A: ${norm(p.a).slice(0, 220)}`);
    }
  }
  ok(pages > 50, `scanned a plausible number of FAQ pages (got ${pages})`);
  ok(answers > 300, `scanned a plausible number of FAQ answers (got ${answers})`);

  console.log(`faq-schema-sync: ${pages} pages, ${answers} answers — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
