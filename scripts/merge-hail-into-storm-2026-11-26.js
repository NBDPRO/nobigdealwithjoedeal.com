#!/usr/bin/env node
/*
 * GSC content merge (Jo, 2026-11-26): fold each /services/hail-damage-<town>
 * page into its twin /services/storm-damage-<town>, then delete the hail page
 * (firebase.json 301s carry the old URLs). Search Console, Sep 26 - Nov 24
 * 2026: 15 of the 26 hail town pages appeared at all, 65 impressions, 0 clicks.
 * See documentation/audit/GSC-CONTENT-MERGES-2026-11-26.md.
 *
 * Per town, nothing unique is lost:
 *   - the hail page's local section (the "Hail Damage Inspection in <Town>"
 *     box with its NOAA hail facts and the paragraphs under it) goes in
 *     verbatim, right after the storm page's own local section;
 *   - hail "What's included" bullets with no close storm twin are added;
 *   - hail FAQs the storm page lacks are added to BOTH the visible list and
 *     the FAQPage JSON-LD (answers copied verbatim from each);
 *   - title / H1 / og / twitter / WebPage name become
 *     "Hail & Storm Damage Roof Repair in <Town>";
 *   - the storm page's own "Hail Damage in <Town>" card (now a self-link) goes.
 *
 * Usage: node scripts/merge-hail-into-storm-2026-11-26.js [--write]
 * Dry run by default; prints a per-town report.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const SVC = path.resolve(__dirname, '..', 'docs', 'services');
const TODAY = '2026-11-26';
const TODAY_LONG = 'November 26, 2026';

const towns = fs.readdirSync(SVC)
  .map((f) => f.match(/^hail-damage-([a-z-]+-(?:oh|ky))\.html$/))
  .filter((m) => m && !m[1].startsWith('insurance-claim'))
  .map((m) => m[1])
  .sort();

function read(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { crlf: raw.includes('\r\n'), text: raw.replace(/\r\n/g, '\n') };
}
function write(file, text, crlf) {
  const out = crlf ? text.replace(/\n/g, '\r\n') : text;
  for (let i = 0; i < out.length; i++) {
    if (out.charCodeAt(i) === 13 && out.charCodeAt(i + 1) !== 10) throw new Error('lone CR in ' + file);
  }
  fs.writeFileSync(file, out);
}
const decode = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
  .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const norm = (s) => decode(s).toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (s) => new Set(norm(s).split(' ').filter((w) => w.length > 2));
function jaccard(a, b) {
  const A = words(a), B = words(b);
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n || 1);
}

// The section that holds .local-box, from its <section> to its </section>.
function localSection(html, file) {
  const i = html.indexOf('class="local-box"');
  if (i < 0) throw new Error('no local-box in ' + file);
  const start = html.lastIndexOf('<section', i);
  const end = html.indexOf('</section>', i) + '</section>'.length;
  const block = html.slice(start, end);
  if ((block.match(/<section/g) || []).length !== 1) throw new Error('nested section in ' + file);
  return { start, end, block };
}

const FAQ_RE = /( *)<div class="faq-item">\s*<div class="faq-q">([\s\S]*?)<span class="faq-arrow">(?:▸|►|&#9658;)<\/span><\/div>\s*<div class="faq-a">([\s\S]*?)<\/div>\s*<\/div>\n?/g;
function faqs(html) {
  return [...html.matchAll(FAQ_RE)].map((m) => ({ full: m[0], q: m[2].trim(), a: m[3], index: m.index }));
}
function faqSchema(html, file) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  const hits = [...html.matchAll(re)].filter((m) => /"@type":\s*"FAQPage"/.test(m[1]));
  if (hits.length !== 1) throw new Error(hits.length + ' FAQPage blocks in ' + file);
  const m = hits[0];
  const body = m[1].replace(/^\s+/, '');
  return { m: [m[0], body], obj: JSON.parse(body) };
}

// Python json.dumps default style (", " / ": "), which some pages were stamped with.
function pyDumps(v) {
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + pyDumps(x)).join(', ') + '}';
  return JSON.stringify(v);
}

const INC_RE = /( *)<(div|li) class="inc-item"><span class="inc-check">(✓|&#10003;)<\/span> ([^\n]*?)<\/\2>/g;
// Share of a's words found in b: a hail bullet mostly said already by one storm bullet is not new.
function containment(a, b) {
  const A = words(a), B = words(b);
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size || 1);
}

const report = [];
for (const town of towns) {
  const hFile = path.join(SVC, `hail-damage-${town}.html`);
  const sFile = path.join(SVC, `storm-damage-${town}.html`);
  if (!fs.existsSync(sFile)) throw new Error('no storm twin for ' + town);
  const H = read(hFile).text;
  const Sr = read(sFile);
  let S = Sr.text;
  const r = { town, faqs: 0, bullets: 0 };

  // 1. hail local section, verbatim, after the storm one. The hail hero
  //    paragraph (most towns' NOAA hail facts live there) goes into it, under
  //    the box, unless the storm page already says it word for word.
  const hl = localSection(H, hFile);
  const sl = localSection(S, sFile);
  let block = hl.block;
  const hero = H.match(/<h1>[\s\S]*?<\/h1>\s*<p>([\s\S]*?)<\/p>/);
  r.hero = 'no';
  if (hero && !norm(S).includes(norm(hero[1]))) {
    const boxStart = block.indexOf('class="local-box"');
    const boxEnd = block.indexOf('</div>', boxStart) + '</div>'.length;
    if (block.slice(boxStart, boxEnd).includes('<div')) throw new Error('nested div in local-box ' + town);
    block = block.slice(0, boxEnd)
      + `\n\n    <p style="font-size:.88rem;color:var(--gray);line-height:1.7;margin-top:16px">${hero[1].trim()}</p>`
      + block.slice(boxEnd);
    r.hero = 'yes';
  }
  // Hail-only topic sections (e.g. "Hail Damage on Older Anderson Township
  // Homes"): any titled section that is not the template's scope / FAQ /
  // more-services / nearby / jobs block.
  const extras = [];
  for (const m of H.matchAll(/\n<section[^>]*>[\s\S]*?<\/section>/g)) {
    const t = (m[0].match(/<h2 class="sec-title">([\s\S]*?)<\/h2>/) || [])[1];
    if (!t || m[0].includes('class="local-box"')) continue;
    if (/Full Scope|FAQ|Services|Nearby Cities|Jobs in|reviews/i.test(decode(t))) continue;
    if (norm(S).includes(norm(m[0]))) continue;
    extras.push(m[0]);
  }
  r.extra = extras.length;
  S = S.slice(0, sl.end) + '\n\n' + block + extras.join('') + S.slice(sl.end);

  // 2. hail bullets with no close storm twin.
  const sInc = [...S.matchAll(INC_RE)];
  const hInc = [...H.matchAll(INC_RE)];
  if (!sInc.length || !hInc.length) throw new Error(`no bullets (storm ${sInc.length}, hail ${hInc.length}) ${town}`);
  const [, indent, tag, check] = sInc[0];
  const kept = sInc.map((s) => s[4]);
  const add = [];
  r.skipped = [];
  for (const h of hInc) {
    const text = h[4];
    if (kept.some((k) => containment(text, k) >= 0.6 || jaccard(text, k) >= 0.5)) { r.skipped.push(decode(text)); continue; }
    kept.push(text);
    add.push(`${indent}<${tag} class="inc-item"><span class="inc-check">${check}</span> ${text}</${tag}>\n`);
  }
  if (add.length) {
    const pledge = sInc.find((s) => /NBD Pledge/.test(s[4]));
    const last = sInc[sInc.length - 1];
    const at = pledge ? pledge.index : S.indexOf('\n', last.index + last[0].length) + 1;
    S = S.slice(0, at) + add.join('') + S.slice(at);
    r.bullets = add.length;
    if (process.env.VERBOSE) for (const a of add) console.log(town, '+', decode(a));
  }
  if (process.env.VERBOSE) for (const a of r.skipped) console.log(town, '-', a);
  r.skipped = r.skipped.length;

  // 3. FAQs the storm page lacks: visible list + JSON-LD, kept in step.
  const sF = faqs(S);
  const hF = faqs(H);
  for (const [n, h, list] of [['storm', S, sF], ['hail', H, hF]]) {
    const q = (h.match(/"@type":\s*"Question"/g) || []).length;
    if (!list.length || list.length !== q) throw new Error(`${n} FAQ count: ${list.length} visible vs ${q} schema (${town})`);
  }
  const sQ = new Set(sF.map((f) => norm(f.q)));
  const newF = hF.filter((f) => !sQ.has(norm(f.q)));
  if (newF.length) {
    const last = sF[sF.length - 1];
    const at = last.index + last.full.length;
    const indent = last.full.match(/^ */)[0];
    const blocks = newF.map((f) => f.full.replace(/^ */, indent).replace(/\n?$/, '\n')).join('');
    S = S.slice(0, at) + blocks + S.slice(at);
    const hs = faqSchema(H, hFile).obj;
    const ss = faqSchema(S, sFile);
    const before = ss.m[1];
    const fmt = [(o) => JSON.stringify(o, null, 2), pyDumps].find((f) => f(ss.obj) === before.trim());
    if (!fmt) throw new Error('storm FAQPage JSON in an unknown format: ' + town);
    for (const f of newF) {
      const ent = hs.mainEntity.find((e) => norm(e.name) === norm(f.q));
      if (!ent) throw new Error(`hail JSON-LD lacks "${decode(f.q)}" (${town})`);
      if (norm(ent.acceptedAnswer.text) !== norm(f.a)) throw new Error(`hail visible/schema answer differ: "${decode(f.q)}" (${town})`);
      ss.obj.mainEntity.push(ent);
    }
    const trail = before.slice(before.trimEnd().length);
    S = S.replace(before, () => fmt(ss.obj) + trail);
    r.faqs = newF.length;
  }

  // 4. retitle.
  const swaps = [
    [/<title>Wind &amp; Storm Damage Roof Repair in /, '<title>Hail &amp; Storm Damage Roof Repair in '],
    [/(<meta property="og:title" content=")Wind &amp; Storm Damage Roof Repair in /, '$1Hail &amp; Storm Damage Roof Repair in '],
    [/(<meta name="twitter:title" content=")Wind &amp; Storm Damage Roof Repair in /, '$1Hail &amp; Storm Damage Roof Repair in '],
    [/<h1>Wind &amp; Storm Damage Repair<br>in /, '<h1>Hail &amp; Storm Damage Roof Repair<br>in '],
    [/"serviceType": "Wind & Storm Damage Roof Repair"/, '"serviceType": "Hail & Storm Damage Roof Repair"'],
    [/("@type":"WebPage"[^\n]*?"name":")Wind & Storm Damage Roof Repair in /, '$1Hail & Storm Damage Roof Repair in '],
    [/("@type":"WebPage"[^\n]*?"dateModified":")\d{4}-\d{2}-\d{2}"/, `$1${TODAY}"`],
    [/(<div class="nbd-updated"[^\n]*?Last updated <time datetime=")\d{4}-\d{2}-\d{2}">[^<]*</, `$1${TODAY}">${TODAY_LONG}<`],
  ];
  for (const [re, to] of swaps) {
    if (!re.test(S)) throw new Error(`retitle miss ${re} (${town})`);
    S = S.replace(re, to);
  }

  // 5. drop the storm page's card to its own hail twin (single- or multi-line).
  const selfCard = new RegExp(`\\n[ \\t]*<a href="/services/hail-damage-${town}" class="svc-card">[\\s\\S]*?</a>(?=\\n)`, 'g');
  const cards = S.match(selfCard) || [];
  if (cards.length > 1) throw new Error('several self cards ' + town);
  S = S.replace(selfCard, '');
  if (S.includes(`hail-damage-${town}`)) throw new Error('hail link left on storm page ' + town);

  r.lines = S.split('\n').length - Sr.text.split('\n').length;
  report.push(r);
  if (WRITE) {
    write(sFile, S, Sr.crlf);
    fs.unlinkSync(hFile);
  }
}
console.table(report);
console.log(WRITE ? `merged ${report.length} towns` : 'dry run (pass --write)');
