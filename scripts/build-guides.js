#!/usr/bin/env node
/**
 * scripts/build-guides.js — renders the free guides' Markdown into their web
 * pages, so a page and its printable PDF are built from the same words.
 * ═══════════════════════════════════════════════════════════════
 *
 * WHY (2026-10-16, site-docs revamp): each free guide (the NBD Pro playbook
 * and the homeowner guides under /guides/) is written ONCE, as Markdown in
 * site-src/guides/<slug>.md. The same file is the source for the typeset PDF
 * (built separately by the Typst-based Docs Studio pipeline, not by a browser
 * print). This script stamps the guide body into the page between
 *   <!-- GUIDE-BODY:START <slug> -->  …  <!-- GUIDE-BODY:END <slug> -->
 * markers. The region is generator-owned: edit the Markdown and re-run.
 *
 *   node scripts/build-guides.js            write every page
 *   node scripts/build-guides.js --check    exit 1 if any page is stale
 *
 * The Markdown dialect is the Docs Studio subset the guides use:
 *   # chapter   ## section   ### sub-section
 *   ::: lede … :::            the opening paragraph of a chapter
 *   > [!TIP|NOTE|WARNING|KY|OH|PLEDGE] Title   callouts (`>` lines)
 *   - [ ] item                checklist
 *   - item / 1. item          lists
 *   | a | b |                 tables (first row is the header)
 *   **bold**  *italic*  [text](url)
 * Phone numbers, emails and bare nobigdealwithjoedeal.com URLs become links.
 * Everything else is escaped: the Markdown is trusted repo content, but the
 * output never contains a raw tag from it.
 *
 * No dependencies (the repo's scripts run on a bare Node checkout).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// slug → the page that carries its body. Add a row when a guide ships.
const GUIDES = [
  { slug: 'nbd-pro-playbook', page: 'docs/pro/playbook.html' },
  // Homeowner guides (/guides/<slug>), 2026-10-16 onward.
  { slug: 'kentucky-ohio-storm-claim-guide', page: 'docs/guides/kentucky-ohio-storm-claim-guide.html' },
  { slug: 'hail-photo-baseline-sheet', page: 'docs/guides/hail-photo-baseline-sheet.html' },
];

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(s) {
  return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function splitFrontMatter(src) {
  const m = String(src).replace(/^﻿/, '').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: String(src).replace(/\r\n/g, '\n') };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/);
    if (kv && kv[2] !== '') meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

// Inline: escape first, then re-introduce only the markup we allow.
function inline(text) {
  const links = [];
  let s = String(text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    links.push({ label, url });
    return '\u0000' + (links.length - 1) + '\u0000';
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[\[icon:[a-z0-9-]+\]\]\s*/g, '');
  // Auto-links: email, NBD phone, bare site URLs (never inside an existing link).
  s = s.replace(/\b([A-Za-z0-9._%+-]+@nobigdealwithjoedeal\.com)\b/g, '<a href="mailto:$1">$1</a>');
  s = s.replace(/\(859\) 420-7382/g, '<a href="tel:+18594207382">(859) 420-7382</a>');
  s = s.replace(/(^|[\s(])nobigdealwithjoedeal\.com(\/[A-Za-z0-9\-/_.#]*[A-Za-z0-9\-/_#])?/g, (_, pre, p) => {
    const href = p || '/';
    return pre + '<a href="' + href + '">nobigdealwithjoedeal.com' + (p || '') + '</a>';
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const l = links[Number(i)];
    let url = l.url;
    if (/^https:\/\/nobigdealwithjoedeal\.com(\/|$)/.test(url)) url = url.replace(/^https:\/\/nobigdealwithjoedeal\.com/, '') || '/';
    const ext = /^https?:\/\//.test(url);
    if (!/^(https?:\/\/|\/|#|mailto:|tel:|sms:)/.test(url)) throw new Error('build-guides: unsupported link target ' + url);
    return '<a href="' + esc(url) + '"' + (ext ? ' target="_blank" rel="noopener"' : '') + '>' + inline(l.label) + '</a>';
  });
  return s;
}

const CALLOUT = { tip: 'tip', note: 'note', info: 'note', warning: 'warning', important: 'warning', caution: 'warning', ky: 'ky', oh: 'oh', pledge: 'pledge' };
const CALLOUT_LABEL = { tip: 'Template', note: 'Note', warning: 'Heads up', ky: 'Kentucky', oh: 'Ohio', pledge: 'The NBD Pledge' };

function renderBody(body) {
  const lines = body.split('\n');
  const out = [];
  const toc = [];
  let i = 0;
  let inChapter = false;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  const isBlockStart = (l) => /^(#{1,4} |::: ?|> |- |\d+\. |\||<!--)/.test(l) || l.trim() === '';
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || /^<!--.*-->$/.test(line.trim())) { flushPara(); i++; continue; }
    let m;
    if ((m = line.match(/^# (.+)$/))) {
      flushPara();
      if (inChapter) out.push('</section>');
      const title = m[1].trim();
      const num = title.match(/^(\d+)\.\s+(.*)$/);
      const id = num ? 'chapter-' + num[1] : slugify(title);
      toc.push({ id, title });
      out.push('<section class="g-chapter" id="' + id + '">');
      out.push(num
        ? '<h2 class="g-ch-title"><span class="g-ch-num">' + num[1] + '</span> ' + inline(num[2]) + '</h2>'
        : '<h2 class="g-ch-title">' + inline(title) + '</h2>');
      inChapter = true; i++; continue;
    }
    if ((m = line.match(/^(#{2,4}) (.+)$/))) {
      flushPara();
      const level = m[1].length + 1;
      out.push('<h' + level + '>' + inline(m[2].trim()) + '</h' + level + '>');
      i++; continue;
    }
    if ((m = line.match(/^:::\s*([a-z-]+)\s*(.*)$/))) {
      flushPara();
      const name = m[1];
      const inner = [];
      i++;
      while (i < lines.length && !/^:::\s*$/.test(lines[i])) { inner.push(lines[i]); i++; }
      i++;
      if (name === 'lede') {
        out.push('<p class="g-lede">' + inline(inner.filter((l) => l.trim()).join(' ')) + '</p>');
      } else {
        const cap = (m[2].match(/caption="([^"]*)"/) || [])[1];
        out.push('<div class="g-' + name + '">' + (cap ? '<p class="g-caption">' + inline(cap) + '</p>' : '') + renderBody(inner.join('\n')).html + '</div>');
      }
      continue;
    }
    if (/^> /.test(line) || line === '>') {
      flushPara();
      const block = [];
      while (i < lines.length && (/^> /.test(lines[i]) || lines[i] === '>')) { block.push(lines[i].replace(/^> ?/, '')); i++; }
      const head = block[0].match(/^\[!([A-Za-z]+)\]\s*(.*)$/);
      const kind = head ? (CALLOUT[head[1].toLowerCase()] || 'note') : 'note';
      const title = head ? head[2].trim() : '';
      const rest = head ? block.slice(1) : block;
      const paras = rest.join('\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      out.push('<aside class="g-callout g-callout-' + kind + '">'
        + '<p class="g-callout-title">' + inline(title || CALLOUT_LABEL[kind]) + '</p>'
        + paras.map((p) => '<p>' + inline(p.replace(/\n/g, ' ')) + '</p>').join('')
        + '</aside>');
      continue;
    }
    if (/^- \[[ x]\] /.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^- \[[ x]\] /.test(lines[i])) { items.push(lines[i].replace(/^- \[[ x]\] /, '')); i++; }
      out.push('<ul class="g-check">' + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^- /.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^- /.test(lines[i])) { items.push(lines[i].slice(2)); i++; }
      out.push('<ul>' + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ul>');
      continue;
    }
    if (/^\d+\. /.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(lines[i].replace(/^\d+\. /, '')); i++; }
      out.push('<ol>' + items.map((t) => '<li>' + inline(t) + '</li>').join('') + '</ol>');
      continue;
    }
    if (/^\|/.test(line)) {
      flushPara();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push('<div class="g-table-wrap"><table class="g-table"><thead><tr>' + head.map((c) => '<th scope="col">' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
        + body.map((r) => '<tr>' + r.map((c, k) => (k === 0 ? '<th scope="row">' + inline(c) + '</th>' : '<td>' + inline(c) + '</td>')).join('') + '</tr>').join('')
        + '</tbody></table></div>');
      continue;
    }
    // Paragraph text: gather until a block starts.
    para.push(line.trim());
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) { para.push(lines[i].trim()); i++; }
    flushPara();
  }
  flushPara();
  if (inChapter) out.push('</section>');
  return { html: out.join('\n'), toc };
}

function render(md) {
  const { meta, body } = splitFrontMatter(md);
  const { html, toc } = renderBody(body);
  const nav = toc.length > 2
    ? '<nav class="g-toc" aria-label="Contents"><p class="g-toc-title">Contents</p><ul>'
      + toc.map((t) => {
        const n = t.title.match(/^(\d+)\.\s+(.*)$/);
        return '<li><a href="#' + t.id + '">' + (n ? '<span class="g-toc-num">' + n[1] + '</span>' + inline(n[2]) : '<span class="g-toc-num"></span>' + inline(t.title)) + '</a></li>';
      }).join('') + '</ul></nav>\n'
    : '';
  return { meta, html: nav + html };
}

// Plain text for JSON-LD: links keep their label, emphasis is dropped.
function plain(s) {
  return String(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\s+/g, ' ').trim();
}

// Lines of one "# Chapter" (by exact title), up to the next chapter.
function chapterLines(body, title) {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex((l) => l.trim() === '# ' + title);
  if (at === -1) return null;
  const out = [];
  for (let i = at + 1; i < lines.length && !/^# /.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

/**
 * Schema.org JSON-LD built from the SAME Markdown, so it can never disagree
 * with the visible text: FAQPage from the front matter's faq_chapter (each
 * "## question" + its paragraphs), HowTo from howto_chapter (its numbered
 * list, "**Step name:** text"). Returns '' when the guide names neither.
 */
function schema(md) {
  const { meta, body } = splitFrontMatter(md);
  const blocks = [];
  if (meta.faq_chapter) {
    const ls = chapterLines(body, meta.faq_chapter);
    if (!ls) throw new Error('build-guides: faq_chapter "' + meta.faq_chapter + '" not found');
    const qa = [];
    for (const l of ls) {
      const q = l.match(/^## (.+)$/);
      if (q) { qa.push({ q: plain(q[1]), a: [] }); continue; }
      if (qa.length && l.trim()) qa[qa.length - 1].a.push(l.trim());
    }
    blocks.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: qa.map((x) => ({ '@type': 'Question', name: x.q, acceptedAnswer: { '@type': 'Answer', text: plain(x.a.join(' ')) } })) });
  }
  if (meta.howto_chapter) {
    const ls = chapterLines(body, meta.howto_chapter);
    if (!ls) throw new Error('build-guides: howto_chapter "' + meta.howto_chapter + '" not found');
    const steps = ls.filter((l) => /^\d+\. /.test(l)).map((l) => {
      const t = l.replace(/^\d+\. /, '');
      const n = t.match(/^\*\*([^*]+?):?\*\*:?\s*(.*)$/);
      return n ? { '@type': 'HowToStep', name: plain(n[1]), text: plain(n[2] || n[1]) } : { '@type': 'HowToStep', text: plain(t) };
    });
    blocks.push({ '@context': 'https://schema.org', '@type': 'HowTo', name: meta.howto_name || meta.title, step: steps });
  }
  return blocks.map((b) => '<script type="application/ld+json">' + JSON.stringify(b).replace(/</g, '\\u003c') + '</script>').join('\n');
}

// Stamp an optional second region (GUIDE-SCHEMA in <head>).
function stampRegion(pageSrc, kind, slug, html, optional) {
  const start = '<!-- GUIDE-' + kind + ':START ' + slug + ' -->';
  const end = '<!-- GUIDE-' + kind + ':END ' + slug + ' -->';
  if (optional && pageSrc.indexOf(start) === -1 && pageSrc.indexOf(end) === -1) return pageSrc;
  const crlf = /\r\n/.test(pageSrc);
  const src = pageSrc.replace(/\r\n/g, '\n');
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error('build-guides: ' + kind + ' markers for ' + slug + ' not found');
  let next = src.slice(0, a + start.length) + '\n' + html + '\n' + src.slice(b);
  if (crlf) next = next.replace(/\n/g, '\r\n');
  return next;
}

function stamp(pageSrc, slug, html) {
  const crlf = /\r\n/.test(pageSrc);
  const src = pageSrc.replace(/\r\n/g, '\n');
  const start = '<!-- GUIDE-BODY:START ' + slug + ' -->';
  const end = '<!-- GUIDE-BODY:END ' + slug + ' -->';
  const a = src.indexOf(start);
  const b = src.indexOf(end);
  if (a === -1 || b === -1 || b < a) throw new Error('build-guides: markers for ' + slug + ' not found');
  let next = src.slice(0, a + start.length) + '\n' + html + '\n' + src.slice(b);
  if (crlf) next = next.replace(/\n/g, '\r\n');
  return next;
}

function main() {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const g of GUIDES) {
    const md = fs.readFileSync(path.join(ROOT, 'site-src/guides', g.slug + '.md'), 'utf8');
    const pagePath = path.join(ROOT, g.page);
    const cur = fs.readFileSync(pagePath, 'utf8');
    const sch = schema(md);
    const next = stampRegion(stamp(cur, g.slug, render(md).html), 'SCHEMA', g.slug, sch, !sch);
    if (next === cur) continue;
    if (check) { stale++; console.error('build-guides: ' + g.page + ' is stale — run node scripts/build-guides.js'); }
    else { fs.writeFileSync(pagePath, next); console.log('build-guides: wrote ' + g.page); }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('build-guides --check: ' + GUIDES.length + ' guide page(s) match their Markdown — clean.');
}

if (require.main === module) main();

module.exports = { GUIDES, render, renderBody, inline, stamp, stampRegion, schema, plain, splitFrontMatter, slugify };
