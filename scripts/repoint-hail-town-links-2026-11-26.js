#!/usr/bin/env node
/*
 * Companion to merge-hail-into-storm-2026-11-26.js: after the 26
 * /services/hail-damage-<town> pages were folded into storm-damage-<town>,
 * repoint every internal link so nothing walks through a 301.
 *
 *   - a svc-card to hail-damage-<town> on a page that already links
 *     storm-damage-<town> is dropped (it would be a duplicate card);
 *   - every other link is repointed to storm-damage-<town>;
 *   - the hail hub's city pills / intro link read "Hail & Storm Damage".
 * The hub /services/hail-damage-insurance-claim is a real page and is never
 * touched by the pattern (every town slug ends in -oh / -ky).
 *
 * Usage: node scripts/repoint-hail-town-links-2026-11-26.js [--write]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const WRITE = process.argv.includes('--write');
const DOCS = path.resolve(__dirname, '..', 'docs');
const TOWN = '([a-z-]+-(?:oh|ky))';

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) files.push(p);
  }
})(DOCS);

let changed = 0, dropped = 0, repointed = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  if (!/\/services\/hail-damage-[a-z-]+-(?:oh|ky)\b/.test(raw)) continue;
  const crlf = raw.includes('\r\n');
  let s = raw.replace(/\r\n/g, '\n');

  // 1. duplicate cards: whole <a class="svc-card"> (one line or several).
  s = s.replace(new RegExp(`\\n[ \\t]*<a href="/services/hail-damage-${TOWN}" class="svc-card">[\\s\\S]*?</a>(?=\\n)`, 'g'), (card, town) => {
    if (town.startsWith('insurance-claim')) return card;
    if (!s.includes(`href="/services/storm-damage-${town}"`)) return card;
    dropped++;
    return '';
  });
  // 2. hub wording, then every remaining link.
  s = s.replace(new RegExp(`(<a href="/services/hail-damage-${TOWN}"[^>]*>)Hail Damage Repair — `, 'g'), '$1Hail &amp; Storm Damage Repair — ');
  s = s.replace(/(<a href="\/services\/hail-damage-cincinnati-oh"[^>]*>)hail damage in Cincinnati</g, '$1hail and storm damage in Cincinnati<');
  s = s.replace(new RegExp(`/services/hail-damage-${TOWN}\\b`, 'g'), (m, town) => {
    if (town.startsWith('insurance-claim')) return m;
    repointed++;
    return `/services/storm-damage-${town}`;
  });

  if (s === raw.replace(/\r\n/g, '\n')) continue;
  changed++;
  console.log(path.relative(DOCS, file));
  if (WRITE) {
    const out = crlf ? s.replace(/\n/g, '\r\n') : s;
    for (let i = 0; i < out.length; i++) {
      if (out.charCodeAt(i) === 13 && out.charCodeAt(i + 1) !== 10) throw new Error('lone CR in ' + file);
    }
    fs.writeFileSync(file, out);
  }
}
console.log({ changed, dropped, repointed, write: WRITE });
