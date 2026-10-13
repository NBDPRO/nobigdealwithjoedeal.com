#!/usr/bin/env node
/**
 * build-credentials.mjs - regenerates every credential surface from
 * docs/assets/data/credentials.json (the single source of truth):
 *
 *   1. docs/credentials.html - the cards (CREDENTIALS-CARDS-START/END) and the
 *      head JSON-LD (CREDENTIALS-SCHEMA-START/END)
 *   2. every page carrying a <!-- CREDENTIALS-STRIP-START --> ... END region
 *      (homepage trust row, /about hero): the compact "top 3" strip, rendered
 *      from site-src/partials/credentials-strip.html + the rows with
 *      showInStrip. Pages opt in by carrying the marker pair; nothing is
 *      inserted for them, so area pages pick it up only if they carry it.
 *
 * WHY: the badges were hand-copied across ~280 pages and 4 footer partials,
 * and "what are we allowed to claim" lived in people's heads. One data file
 * means a credential is added, expired or reworded in one place, and the
 * guard test (tests/credentials-2026-10-13.test.js) can prove what renders.
 *
 * RULES THE VALIDATOR ENFORCES (a violation is fatal, nothing is written):
 *   - status is active | pending | expired; ONLY active rows render, anywhere
 *   - an active row needs id, name, issuer, type, summary, claimWording,
 *     confirmedBy, confirmedAt, order
 *   - the honesty words (Master Elite, President's Club, Licensed) are refused
 *     in any field - Jo's rule is "Fully insured", never "Licensed"
 *   - a warranty/rebate string requires warrantyVerified: true on that row
 *   - verifyUrl must be https; a badge must exist on disk
 *   - at most 3 strip rows; ids and orders unique; unknown keys refused
 *     (this page is public - a cost/margin key must never ride along)
 *
 * USAGE:
 *   node scripts/build-credentials.mjs            # restamp all surfaces
 *   node scripts/build-credentials.mjs --check    # write nothing; exit 1 on drift
 *
 * Runbook: documentation/runbooks/ADD-A-CREDENTIAL.md
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'assets', 'data', 'credentials.json');
const PAGE = path.join(DOCS, 'credentials.html');
const STRIP_TPL = path.join(ROOT, 'site-src', 'partials', 'credentials-strip.html');
const ORIGIN = 'https://nobigdealwithjoedeal.com';
const CHECK = process.argv.includes('--check');
const SKIP_TOP = new Set(['pro', 'admin', 'dev', 'sites']);

const TYPES = ['manufacturer', 'insurance', 'membership', 'supplier-material'];
const STATUSES = ['active', 'pending', 'expired'];
// Card groups, in page order. A group with no rendered rows is omitted.
const GROUPS = [
  { type: 'manufacturer', heading: 'Manufacturer certifications', blurb: 'Roofing manufacturers certify the contractors who install their systems. Each of these is issued and kept up by the manufacturer, not by us.' },
  { type: 'insurance', heading: 'Insured', blurb: null },
  { type: 'membership', heading: 'Memberships', blurb: null },
  { type: 'supplier-material', heading: 'Materials we install', blurb: null },
];
const KNOWN = new Set([
  'id', 'name', 'issuer', 'issuerShort', 'issuerUrl', 'type', 'status',
  'contractorId', 'verifyUrl', 'since', 'expires', 'summary', 'badge',
  'badgeAlt', 'claimWording', 'warrantyVerified', 'confirmedBy', 'confirmedAt',
  'order', 'showInStrip', '_todo',
]);
const STRIP_MAX = 3;
// Words the public site must never say about NBD's credentials.
const FORBIDDEN = /master\s*elite|president['\u2019]?s\s*club|\blicensed\b/i;
const WARRANTY_WORDS = /warrant|rebate/i;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const toEol = (s, eol) => (eol === '\n' ? s : s.replace(/\n/g, eol));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const prettySince = (s) => {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(s);
  return m && m[2] ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : s;
};

// ── load + validate ──────────────────────────────────────────────────────
const errors = [];
const fail = (m) => errors.push(m);

function load() {
  let raw;
  try { raw = JSON.parse(readFileSync(DATA, 'utf8')); } catch (e) { console.error(`FATAL: cannot parse credentials.json: ${e.message}`); process.exit(2); }
  if (!raw || !Array.isArray(raw.credentials)) { console.error('FATAL: credentials.json needs a credentials[] array'); process.exit(2); }
  const ids = new Set(), orders = new Set();
  // CRM/Salesforce-style account IDs (001 + 15 chars) are private; refuse them in ANY string.
  const scan = (v, at) => { if (typeof v === 'string') { if (/^001[A-Za-z0-9]{15}$/.test(v.trim())) fail(`${at}: looks like a private account ID (001...) - never publish it`); } else if (Array.isArray(v)) v.forEach((x, n) => scan(x, `${at}[${n}]`)); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${at}.${k}`); };
  scan(raw, 'credentials.json');
  raw.credentials.forEach((c, i) => {
    const at = `credentials[${i}]${c && c.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') return fail(`${at}: not an object`);
    for (const k of Object.keys(c)) if (!KNOWN.has(k)) fail(`${at}: unknown field "${k}" - this file is public; add the field to KNOWN only if it is safe to publish`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.id || '')) fail(`${at}: id must be kebab-case`);
    if (ids.has(c.id)) fail(`${at}: duplicate id`); ids.add(c.id);
    if (!TYPES.includes(c.type)) fail(`${at}: type must be one of ${TYPES.join(' | ')}`);
    if (!STATUSES.includes(c.status)) fail(`${at}: status must be one of ${STATUSES.join(' | ')}`);
    if (!Number.isInteger(c.order)) fail(`${at}: order must be an integer`);
    else { if (orders.has(c.order)) fail(`${at}: duplicate order ${c.order}`); orders.add(c.order); }
    if (c.since !== undefined && !/^\d{4}(-(0[1-9]|1[0-2]))?$/.test(c.since)) fail(`${at}: since must be YYYY or YYYY-MM`);
    if (c.expires !== undefined && !/^\d{4}-\d{2}(-\d{2})?$/.test(c.expires)) fail(`${at}: expires must be YYYY-MM or YYYY-MM-DD`);
    if (c.confirmedAt !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(c.confirmedAt)) fail(`${at}: confirmedAt must be YYYY-MM-DD`);
    if (c.verifyUrl !== undefined && !/^https:\/\/[^\s]+$/.test(c.verifyUrl)) fail(`${at}: verifyUrl must be an https URL`);
    if (c.issuerUrl !== undefined && !/^https:\/\/[^\s]+$/.test(c.issuerUrl)) fail(`${at}: issuerUrl must be an https URL`);
    if (c.contractorId !== undefined && !/^[A-Za-z0-9-]{3,24}$/.test(c.contractorId)) fail(`${at}: contractorId must be 3-24 letters/digits/dashes`);
    if (typeof c.showInStrip !== 'boolean') fail(`${at}: showInStrip must be true or false`);
    if (c.status === 'active') {
      for (const k of ['name', 'issuer', 'summary', 'claimWording', 'confirmedBy', 'confirmedAt']) {
        if (typeof c[k] !== 'string' || !c[k].trim()) fail(`${at}: an active row needs a non-empty ${k}`);
      }
      if (c.badge !== undefined) {
        if (!/^\/assets\/[A-Za-z0-9_\/.-]+\.png$/.test(c.badge)) fail(`${at}: badge must be a repo-local /assets/ .png path`);
        else if (!existsSync(path.join(DOCS, c.badge))) fail(`${at}: badge file ${c.badge} does not exist under docs/`);
        if (!c.badgeAlt) fail(`${at}: a badge needs badgeAlt`);
      }
      const text = ['name', 'issuer', 'summary', 'claimWording', 'badgeAlt'].map((k) => c[k] || '').join(' | ');
      if (FORBIDDEN.test(text)) fail(`${at}: contains a forbidden claim word (Master Elite / President's Club / Licensed)`);
      if (WARRANTY_WORDS.test(text) && c.warrantyVerified !== true) fail(`${at}: mentions a warranty/rebate but warrantyVerified is not true - verify the program terms first`);
    }
  });
  return raw.credentials;
}

const creds = load();
const live = creds.filter((c) => c.status === 'active').sort((a, b) => a.order - b.order);
const stripRows = live.filter((c) => c.showInStrip);
if (stripRows.length > STRIP_MAX) fail(`${stripRows.length} rows have showInStrip - the strip is capped at ${STRIP_MAX}`);
const todayIso = new Date().toISOString().slice(0, 10);
for (const c of live) if (c.expires && c.expires.slice(0, 10) < todayIso) console.warn(`WARN: ${c.id} expired ${c.expires} but is still status active - renew it or set status "expired"`);

if (errors.length) {
  console.error('credentials.json is invalid - nothing written:');
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}

// ── renderers ────────────────────────────────────────────────────────────
function pngSize(rel) {
  const b = readFileSync(path.join(DOCS, rel));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}
function badgeImg(c, h) {
  if (!c.badge) return '';
  const { w: iw, h: ih } = pngSize(c.badge);
  const w = Math.round((h * iw) / ih);
  return `<img src="${esc(c.badge)}" alt="${esc(c.badgeAlt)}" width="${w}" height="${h}" loading="lazy">`;
}
const issuerShort = (c) => c.issuerShort || c.issuer;

function stripItem(c) {
  const verify = c.verifyUrl
    ? `\n      <a class="cred-chip-verify" href="${esc(c.verifyUrl)}" target="_blank" rel="noopener">Verify on ${esc(issuerShort(c))}</a>`
    : '';
  return `    <li class="cred-chip" data-cred="${esc(c.id)}">
      <a class="cred-chip-main" href="/credentials#${esc(c.id)}">${badgeImg(c, 40)}<span class="cred-chip-name">${esc(c.claimWording)}</span></a>${verify}
    </li>`;
}
function stripBlock() {
  const tpl = readFileSync(STRIP_TPL, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const items = stripRows.map(stripItem).join('\n');
  return tpl.replace('{{items}}', () => items);
}

function card(c) {
  const meta = [`Issued by ${esc(c.issuer)}`];
  if (c.since) meta.push(`${c.type === 'manufacturer' ? 'Certified' : 'Active from'} ${esc(prettySince(c.since))}`);
  if (c.expires) meta.push(`Renews ${esc(prettySince(c.expires.slice(0, 7)))}`);
  const facts = c.contractorId
    ? `\n      <p class="cred-id">${esc(issuerShort(c))} contractor ID <b>${esc(c.contractorId)}</b></p>`
    : '';
  const verify = c.verifyUrl
    ? `\n      <a class="cred-verify" href="${esc(c.verifyUrl)}" target="_blank" rel="noopener">Verify on ${esc(issuerShort(c))} <span aria-hidden="true">&rarr;</span></a>`
    : '';
  return `    <article class="cred-card" id="${esc(c.id)}">
      <div class="cred-card-head">${badgeImg(c, 56)}
        <div>
          <h3>${esc(c.name)}</h3>
          <p class="cred-meta">${meta.join(' &middot; ')}</p>
        </div>
      </div>
      <p class="cred-summary">${esc(c.summary)}</p>${facts}${verify}
    </article>`;
}
function cardsBlock() {
  const out = [];
  for (const g of GROUPS) {
    const rows = live.filter((c) => c.type === g.type);
    if (!rows.length) continue;
    out.push(`  <h2 class="cred-group" id="group-${g.type}">${esc(g.heading)}</h2>`);
    if (g.blurb) out.push(`  <p class="cred-group-note">${esc(g.blurb)}</p>`);
    out.push(`  <div class="cred-grid">`, rows.map(card).join('\n'), `  </div>`);
  }
  return out.join('\n');
}

// JSON-LD. schema.org has no "insurance" credential and a supplier brand is a
// relationship, not a credential, so only manufacturer certifications
// (EducationalOccupationalCredential) and memberships (ProgramMembership) get
// nodes. They hang off the page, which points at the ONE business entity by
// @id (defined in site-src/partials/schema-entity.html) - no second
// Organization node is ever defined here.
function schemaBlock() {
  const url = `${ORIGIN}/credentials`;
  const nodes = [];
  const items = [];
  for (const c of live) {
    const nid = `${url}#${c.id}`;
    if (c.type === 'manufacturer') {
      const n = {
        '@type': 'EducationalOccupationalCredential', '@id': nid, name: c.name,
        description: c.summary, credentialCategory: 'certification',
        recognizedBy: { '@type': 'Organization', name: c.issuer, ...(c.issuerUrl ? { url: c.issuerUrl } : {}) },
      };
      if (c.contractorId) n.identifier = c.contractorId;
      if (c.verifyUrl) n.url = c.verifyUrl;
      nodes.push(n); items.push(nid);
    } else if (c.type === 'membership') {
      const n = {
        '@type': 'ProgramMembership', '@id': nid, name: c.name, description: c.summary,
        hostingOrganization: { '@type': 'Organization', name: c.issuer, ...(c.issuerUrl ? { url: c.issuerUrl } : {}) },
      };
      if (c.contractorId) n.membershipNumber = c.contractorId;
      nodes.push(n); items.push(nid);
    }
  }
  const graph = [
    {
      '@type': 'CollectionPage', '@id': `${url}#page`, url,
      name: 'Credentials | No Big Deal Home Solutions',
      isPartOf: { '@id': `${ORIGIN}/#website` },
      about: { '@id': `${ORIGIN}/#org` },
      mainEntity: { '@type': 'ItemList', itemListElement: items.map((id, i) => ({ '@type': 'ListItem', position: i + 1, item: { '@id': id } })) },
    },
    {
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
        { '@type': 'ListItem', position: 2, name: 'Credentials', item: url },
      ],
    },
    ...nodes,
  ];
  // "<" cannot appear in a script block's JSON; escape defensively.
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }, null, 2).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">\n${json}\n</script>`;
}

// ── region stamping ──────────────────────────────────────────────────────
function stamp(src, start, end, block, where) {
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lf = src.replace(/\r\n/g, '\n');
  const i = lf.indexOf(start), j = lf.indexOf(end);
  if (i < 0 || j < i) { console.error(`FATAL: ${where}: missing ${start} / ${end}`); process.exit(2); }
  const out = lf.slice(0, i) + start + '\n' + block + '\n' + lf.slice(j);
  return toEol(out, eol);
}
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (dir === DOCS && SKIP_TOP.has(e.name)) continue; walk(full, out); }
    else if (e.isFile() && e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

const jobs = []; // [file, next]
if (!existsSync(PAGE)) { console.error('FATAL: docs/credentials.html does not exist'); process.exit(2); }
const SB = '<!-- CREDENTIALS-STRIP-START -->', SE = '<!-- CREDENTIALS-STRIP-END -->';
for (const file of walk(DOCS)) {
  const before = readFileSync(file, 'utf8');
  let next = before;
  if (file === PAGE) {
    next = stamp(next, '<!-- CREDENTIALS-CARDS-START -->', '<!-- CREDENTIALS-CARDS-END -->', cardsBlock(), 'docs/credentials.html');
    next = stamp(next, '<!-- CREDENTIALS-SCHEMA-START -->', '<!-- CREDENTIALS-SCHEMA-END -->', schemaBlock(), 'docs/credentials.html');
  }
  if (next.includes(SB)) {
    const eol = next.includes('\r\n') ? '\r\n' : '\n';
    const lf = next.replace(/\r\n/g, '\n');
    const re = new RegExp(`([ \\t]*)${SB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${SE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
    const block = stripBlock();
    next = toEol(lf.replace(re, (_, indent) => `${indent}${SB}\n${block.split('\n').map((l) => (l ? indent + l : l)).join('\n')}\n${indent}${SE}`), eol);
  }
  if (next !== before) jobs.push([file, next]);
}

// A lone CR turns git's text detection off for the whole file (CLAUDE.md).
for (const [file, next] of jobs) {
  if (/\r(?!\n)/.test(next)) { console.error(`FATAL: ${file}: output would contain a lone CR`); process.exit(2); }
}

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
if (CHECK) {
  if (!jobs.length) {
    console.log(`build-credentials --check: ${live.length} active credential(s), ${stripRows.length} in the strip - all surfaces current.`);
    process.exit(0);
  }
  console.error('credential surfaces are stale (run: node scripts/build-credentials.mjs):');
  jobs.forEach(([f]) => console.error('  - ' + rel(f)));
  process.exit(1);
}
for (const [f, next] of jobs) writeFileSync(f, next);
console.log(`build-credentials: ${live.length} active credential(s); ${jobs.length} file(s) restamped${jobs.length ? ': ' + jobs.map(([f]) => rel(f)).join(', ') : ''}.`);
