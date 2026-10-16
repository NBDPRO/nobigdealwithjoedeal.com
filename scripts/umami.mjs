#!/usr/bin/env node
/**
 * scripts/umami.mjs — switch Umami (cookie-free analytics) on or off for the
 * PUBLIC homeowner site (2026-10-16). Off by default; nothing ships until Jo
 * runs --enable with a website ID he created himself, in a PR.
 *
 *   node scripts/umami.mjs --status
 *   node scripts/umami.mjs --enable <website-uuid> [--host https://cloud.umami.is]
 *   node scripts/umami.mjs --disable
 *
 * --enable does exactly three things, and --disable undoes exactly them:
 *   1. docs/assets/js/umami-loader.js: WEBSITE_ID and SCRIPT_URL (<host>/script.js)
 *   2. the loader tag, right after the clarity-loader tag, on every public page
 *      that has one (never docs/pro, admin, dev or sites)
 *   3. firebase.json: the Umami host in script-src, script-src-elem and
 *      connect-src of every PUBLIC policy (the ones that already admit
 *      Microsoft Clarity: '**' and its copies such as /search). The /pro,
 *      /admin, /dev and /sites policies never get it.
 * Line endings are preserved file by file. NBD_REPO_ROOT points it at a copy
 * (tests/umami-2026-10-16.test.js runs the round trip there).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = process.env.NBD_REPO_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(REPO, 'docs');
const LOADER = path.join(DOCS, 'assets', 'js', 'umami-loader.js');
const FIREBASE = path.join(REPO, 'firebase.json');
const CLARITY_TAG = '<script defer src="/assets/js/clarity-loader.js"></script>';
const TAG = '<script defer src="/assets/js/umami-loader.js"></script>';
const EXCLUDED = ['pro', 'admin', 'dev', 'sites'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_HOST = 'https://cloud.umami.is';

function rw(file, fn) {
  const raw = fs.readFileSync(file, 'utf8');
  const crlf = raw.includes('\r\n');
  const out = fn(raw.replace(/\r\n/g, '\n'));
  if (out == null) return false;
  const final = crlf ? out.replace(/\n/g, '\r\n') : out;
  if (final === raw) return false;
  fs.writeFileSync(file, final);
  return true;
}

export function publicPages() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!(dir === DOCS && EXCLUDED.includes(e.name)) && e.name !== 'pagefind') walk(p); }
      else if (e.name.endsWith('.html')) out.push(p);
    }
  })(DOCS);
  return out.filter((f) => fs.readFileSync(f, 'utf8').includes(CLARITY_TAG));
}

/** Add or remove `host` in the three directives of every public policy value. */
export function cspWith(value, host, on) {
  return value.split(';').map((part) => {
    const d = part.trim().split(/\s+/)[0];
    if (!['script-src', 'script-src-elem', 'connect-src'].includes(d)) return part;
    const tokens = part.trim().split(/\s+/).filter((t) => t !== host);
    if (on) tokens.push(host);
    return (part.startsWith(' ') ? ' ' : '') + tokens.join(' ');
  }).join(';');
}

function status() {
  const src = fs.readFileSync(LOADER, 'utf8');
  const id = (src.match(/var WEBSITE_ID = '([^']*)';/) || [])[1] || '';
  const url = (src.match(/var SCRIPT_URL = '([^']*)';/) || [])[1] || '';
  const tagged = publicPages().filter((f) => fs.readFileSync(f, 'utf8').includes(TAG)).length;
  const fb = fs.readFileSync(FIREBASE, 'utf8');
  const host = url ? new URL(url).origin : DEFAULT_HOST;
  return { enabled: !!id, websiteId: id, scriptUrl: url, pagesTagged: tagged, cspHasHost: fb.includes(host + ' ') || fb.includes(host + ';') };
}

function setLoader(id, url) {
  rw(LOADER, (s) => s.replace(/var WEBSITE_ID = '[^']*';/, "var WEBSITE_ID = '" + id + "';").replace(/var SCRIPT_URL = '[^']*';/, "var SCRIPT_URL = '" + url + "';"));
}

function setTags(on) {
  let n = 0;
  for (const f of publicPages()) {
    if (rw(f, (s) => {
      const has = s.includes(TAG);
      if (on && !has) return s.replace(CLARITY_TAG, CLARITY_TAG + '\n' + TAG);
      if (!on && has) return s.split('\n' + TAG).join('').split(TAG).join('');
      return null;
    })) n++;
  }
  return n;
}

function setCsp(host, on) {
  rw(FIREBASE, (s) => {
    const j = JSON.parse(s);
    let changed = 0;
    for (const rule of j.hosting.headers) {
      for (const h of rule.headers || []) {
        if (!/^Content-Security-Policy(-Report-Only)?$/.test(h.key) || !/clarity\.ms/.test(h.value)) continue;
        const next = cspWith(h.value, host, on);
        if (next !== h.value) {
          s = s.split(JSON.stringify(h.value)).join(JSON.stringify(next));
          changed++;
        }
      }
    }
    JSON.parse(s);
    return changed ? s : null;
  });
}

function main(argv) {
  const i = argv.indexOf('--host');
  const host = (i !== -1 ? argv[i + 1] : DEFAULT_HOST).replace(/\/+$/, '');
  if (argv.includes('--status')) { console.log(JSON.stringify(status(), null, 2)); return 0; }
  if (argv.includes('--enable')) {
    const id = argv[argv.indexOf('--enable') + 1] || '';
    if (!UUID.test(id)) { console.error('--enable needs the Umami website ID (a UUID)'); return 2; }
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(host)) { console.error('--host must be https://hostname'); return 2; }
    setLoader(id, host + '/script.js');
    const n = setTags(true);
    setCsp(host, true);
    console.log('Umami ON: ' + n + ' pages tagged, CSP admits ' + host);
    return 0;
  }
  if (argv.includes('--disable')) {
    const st = status();
    const h = st.scriptUrl ? new URL(st.scriptUrl).origin : host;
    setLoader('', DEFAULT_HOST + '/script.js');
    const n = setTags(false);
    setCsp(h, false);
    console.log('Umami OFF: tag removed from ' + n + ' pages, ' + h + ' removed from the CSP');
    return 0;
  }
  console.error('usage: node scripts/umami.mjs --status | --enable <uuid> [--host https://...] | --disable');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
