#!/usr/bin/env node
/**
 * stamp-page-dates.mjs — a visible "Last updated <date>" line plus a matching
 * WebPage `dateModified` in JSON-LD on every service and area page.
 *
 * WHY (SEO/AEO audit 2026-10-06, issue 6): 0 of the 193 service and area
 * pages carried a freshness date, visible or in schema. Blog posts do. Answer
 * engines and Google both use a page's stated modified date, and the two have
 * to agree, so one script writes both from one value.
 *
 * TARGETS: docs/services/*.html, docs/services/<dir>/index.html,
 * docs/areas/*.html (193 pages on 2026-10-06).
 *
 * REGIONS (generator-owned — never hand-edit between the markers):
 *   <!-- nbd:updated-schema -->  … WebPage JSON-LD with dateModified, before </head>
 *   <!-- nbd:updated -->         … the visible line, just before </main>
 * Each ends at the matching <!-- /nbd:updated… --> marker. The first --write
 * inserts them; later runs restamp between them.
 *
 * THE DATE is a stamped value, not a build-time guess: it is the day a person
 * last changed the page's content. When you change a page, restamp it:
 *   node scripts/stamp-page-dates.mjs --write --date=YYYY-MM-DD docs/services/x.html
 * With no file list every target is restamped; with no --date, today (local).
 * --check keeps an existing date and only verifies (exit 1 on any problem):
 * every target has both regions, both say the same date, the date is a real
 * calendar day and not in the future, and the regions match what the
 * generator would write (so a hand edit between markers goes red).
 *
 * EOL: pages are CRLF in a Windows worktree and LF on CI. Blocks are rendered
 * in LF and converted once to the file's ending; every write is checked for
 * lone CR bytes.
 *
 * Usage:
 *   node scripts/stamp-page-dates.mjs --check
 *   node scripts/stamp-page-dates.mjs --write [--date=YYYY-MM-DD] [files…]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const ORIGIN = 'https://nobigdealwithjoedeal.com';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

export function targets() {
  const out = [];
  const svc = path.join(DOCS, 'services');
  for (const e of readdirSync(svc, { withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.html')) out.push(path.join(svc, e.name));
    else if (e.isDirectory() && existsSync(path.join(svc, e.name, 'index.html'))) out.push(path.join(svc, e.name, 'index.html'));
  }
  const areas = path.join(DOCS, 'areas');
  for (const e of readdirSync(areas)) if (e.endsWith('.html')) out.push(path.join(areas, e));
  return out.sort();
}

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function validDate(iso, today = todayLocal()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return false;
  return iso <= today && iso >= '2024-01-01';
}

export function human(iso) {
  const [y, mo, d] = iso.split('-').map(Number);
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&middot;/g, '·');

function pageFacts(src, rel) {
  const canon = /<link rel="canonical" href="([^"]+)"/.exec(src);
  const title = /<title>([^<]*)<\/title>/.exec(src);
  if (!canon) throw new Error(rel + ': no <link rel="canonical">');
  if (!title) throw new Error(rel + ': no <title>');
  return { url: canon[1], name: decode(title[1]).replace(/\s*\|\s*(NBD|No Big Deal[^|]*)\s*$/, '').trim() };
}

export function renderSchema(facts, iso) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    '@id': facts.url + '#webpage',
    url: facts.url,
    name: facts.name,
    dateModified: iso,
    isPartOf: { '@id': ORIGIN + '/#website' },
    about: { '@id': ORIGIN + '/#org' },
  };
  return '<!-- nbd:updated-schema -->\n<script type="application/ld+json">' +
    JSON.stringify(ld).replace(/</g, '\\u003c') + '</script>\n<!-- /nbd:updated-schema -->';
}

export function renderLine(iso) {
  return '<!-- nbd:updated -->\n' +
    '<div class="nbd-updated" style="max-width:1100px;margin:0 auto;padding:18px 20px 22px;text-align:center">' +
    '<p style="margin:0;font-size:13px;line-height:1.5;color:#5b6472">Last updated <time datetime="' + iso + '">' + human(iso) + '</time></p>' +
    '</div>\n<!-- /nbd:updated -->';
}

const RE_SCHEMA = /<!-- nbd:updated-schema -->[\s\S]*?<!-- \/nbd:updated-schema -->/;
const RE_LINE = /<!-- nbd:updated -->[\s\S]*?<!-- \/nbd:updated -->/;

export function readStamp(src) {
  const s = RE_SCHEMA.exec(src);
  const l = RE_LINE.exec(src);
  const sd = s && /"dateModified":"([^"]+)"/.exec(s[0]);
  const ld = l && /<time datetime="([^"]+)">/.exec(l[0]);
  return { schema: sd ? sd[1] : null, line: ld ? ld[1] : null, hasSchema: !!s, hasLine: !!l };
}

// Returns the new LF text for `src` (LF) stamped with `iso`.
export function stamp(srcLF, rel, iso) {
  const facts = pageFacts(srcLF, rel);
  const schema = renderSchema(facts, iso);
  const line = renderLine(iso);
  let out = srcLF;
  if (RE_SCHEMA.test(out)) out = out.replace(RE_SCHEMA, () => schema);
  else {
    if ((out.match(/<\/head>/g) || []).length !== 1) throw new Error(rel + ': expected exactly one </head>');
    out = out.replace('</head>', () => schema + '\n</head>');
  }
  if (RE_LINE.test(out)) out = out.replace(RE_LINE, () => line);
  else {
    if ((out.match(/<\/main>/g) || []).length !== 1) throw new Error(rel + ': expected exactly one </main>');
    out = out.replace('</main>', () => line + '\n</main>');
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const CHECK = argv.includes('--check');
  const WRITE = argv.includes('--write');
  if (CHECK === WRITE) { console.error('usage: --check | --write [--date=YYYY-MM-DD] [files…]'); process.exit(2); }
  const dateArg = (argv.find((a) => a.startsWith('--date=')) || '').slice(7);
  const files = argv.filter((a) => !a.startsWith('--'));
  const all = targets();
  const list = files.length ? files.map((f) => path.resolve(f)) : all;
  const allSet = new Set(all);
  const problems = [];
  let changed = 0;

  for (const abs of list) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (!allSet.has(abs)) { problems.push(rel + ': not a service/area page target'); continue; }
    const raw = readFileSync(abs, 'utf8');
    const crlf = raw.includes('\r\n');
    const lf = raw.replace(/\r\n/g, '\n');
    const cur = readStamp(lf);
    if (CHECK) {
      if (!cur.hasSchema) { problems.push(rel + ': missing nbd:updated-schema region'); continue; }
      if (!cur.hasLine) { problems.push(rel + ': missing visible nbd:updated line'); continue; }
      if (cur.schema !== cur.line) { problems.push(rel + `: visible date ${cur.line} != dateModified ${cur.schema}`); continue; }
      if (!validDate(cur.line)) { problems.push(rel + `: bad or future date ${cur.line}`); continue; }
      let want;
      try { want = stamp(lf, rel, cur.line); } catch (e) { problems.push(e.message); continue; }
      if (want !== lf) problems.push(rel + ': stamp regions drifted from the generator (the <title> or canonical changed, or a hand edit) — rerun --write --date=' + cur.line);
      continue;
    }
    const iso = dateArg || todayLocal();
    if (!validDate(iso)) { console.error('bad --date ' + iso); process.exit(2); }
    let next;
    try { next = stamp(lf, rel, iso); } catch (e) { problems.push(e.message); continue; }
    if (next === lf) continue;
    const outText = crlf ? next.replace(/\n/g, '\r\n') : next;
    if (/\r(?!\n)/.test(outText)) throw new Error(rel + ': lone CR in output');
    writeFileSync(abs, outText);
    changed++;
  }

  if (CHECK) {
    console.log(`stamp-page-dates --check: ${list.length} pages, ${problems.length} problem(s)`);
  } else {
    console.log(`stamp-page-dates --write: ${changed} of ${list.length} pages restamped`);
  }
  problems.slice(0, 40).forEach((p) => console.log('  ✗ ' + p));
  if (problems.length) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
