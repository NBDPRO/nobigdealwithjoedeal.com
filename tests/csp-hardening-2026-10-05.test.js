/**
 * tests/csp-hardening-2026-10-05.test.js — three CSP tightenings Jo approved
 * on 2026-10-05, checked against the EFFECTIVE policy a path receives (header
 * rules are last-match-wins per key, so a rule-by-rule check can pass while
 * the page still gets the old header).
 *
 *   1. form-action 'self' on every CSP (enforced and Report-Only), and every
 *      <form> under docs/ posts same-origin, so the directive breaks nothing.
 *   2. img-src admits Firebase Storage only for NBD's own bucket (read from
 *      the client firebase config), not every bucket on storage.googleapis.com
 *      / firebasestorage.googleapis.com / *.firebasestorage.app.
 *   3. Microsoft Clarity hosts reach the public marketing pages only; /pro,
 *      /admin, /dev and /sites get the same policy with Clarity removed.
 *
 * Run: node tests/csp-hardening-2026-10-05.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const rules = fb.hosting.headers;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

const CSP_KEYS = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only'];
const parse = (v) => {
  const out = {};
  String(v || '').split(';').map((d) => d.trim()).filter(Boolean).forEach((d) => {
    const t = d.split(/\s+/); out[t[0]] = t.slice(1);
  });
  return out;
};

// Firebase header globs as used in firebase.json: **, *, @(a|b).
function globRe(g) {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '@' && g[i + 1] === '(') {
      const end = g.indexOf(')', i);
      re += '(?:' + g.slice(i + 2, end).split('|').map((s) => s.replace(/[.+?^${}()[\]\\]/g, '\\$&')).join('|') + ')';
      i = end;
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
function effective(p, key) {
  let val = null;
  for (const r of rules) {
    const hit = r.source ? globRe(r.source).test(p) : (r.regex ? new RegExp(r.regex).test(p) : false);
    if (!hit) continue;
    const h = (r.headers || []).find((x) => x.key === key);
    if (h) val = h.value;
  }
  return val;
}

// CSP source-expression matching (scheme, host with *. wildcard, path prefix).
function sourceAllows(src, url) {
  if (src === "'self'") return false;
  const m = /^(https?):\/\/([^/]+)(\/.*)?$/.exec(src);
  if (!m) return false;
  const u = new URL(url);
  if (u.protocol !== m[1] + ':') return false;
  const host = m[2];
  if (host.startsWith('*.')) { if (!u.hostname.endsWith(host.slice(1))) return false; }
  else if (u.hostname !== host) return false;
  if (!m[3]) return true;
  const pathName = decodeURIComponent(u.pathname);
  return m[3].endsWith('/') ? pathName.startsWith(m[3]) : pathName === m[3];
}
const imgAllows = (p, url) => CSP_KEYS.every((k) => (parse(effective(p, k))['img-src'] || []).some((s) => sourceAllows(s, url)));

// ── 1. form-action ──────────────────────────────────────────────────
console.log("\n1. form-action 'self'");
{
  const all = [];
  rules.forEach((r) => (r.headers || []).forEach((h) => { if (CSP_KEYS.includes(h.key)) all.push([r.source || r.regex, h.key, h.value]); }));
  ok('positive control: firebase.json carries 10+ CSP headers', all.length >= 10, String(all.length));
  const bad = all.filter(([, , v]) => JSON.stringify(parse(v)['form-action']) !== JSON.stringify(["'self'"]));
  ok("every CSP and Report-Only policy has form-action 'self' (exactly)", bad.length === 0, bad.map((b) => b[0] + ' ' + b[1]).join(', '));

  // Every form the site ships must post same-origin, or the directive breaks it.
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f); else if (/\.(html|js|mjs)$/.test(e.name)) files.push(f);
    }
  })(path.join(ROOT, 'docs'));
  const offsite = [];
  let forms = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/<form\b[^>]*>/gi)) {
      forms++;
      const a = /\saction\s*=\s*["']([^"']*)["']/i.exec(m[0]);
      if (a && /^(https?:)?\/\//i.test(a[1].trim())) offsite.push(path.relative(ROOT, f) + ': ' + a[1]);
    }
    for (const m of src.matchAll(/\bformaction\s*=\s*["'](?:https?:)?\/\/[^"']*/gi)) offsite.push(path.relative(ROOT, f) + ': ' + m[0]);
    for (const m of src.matchAll(/\.action\s*=\s*['"`](?:https?:)?\/\//g)) offsite.push(path.relative(ROOT, f) + ': ' + m[0]);
  }
  ok('positive control: the walker found the site forms', forms >= 8, String(forms));
  ok('no <form action> / formaction / form.action under docs/ targets another origin', offsite.length === 0, offsite.join('\n      '));
}

// ── 2. img-src scoped to NBD's bucket ────────────────────────────────
console.log("\n2. img-src: Firebase Storage limited to NBD's bucket");
{
  const buckets = new Set();
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'vendor') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(html|js|mjs)$/.test(e.name)) {
        for (const m of fs.readFileSync(f, 'utf8').matchAll(/storageBucket["']?\s*:\s*["']([^"']+)["']/g)) buckets.add(m[1]);
      }
    }
  })(path.join(ROOT, 'docs'));
  ok('the client firebase config names exactly one bucket', buckets.size === 1, [...buckets].join(', '));
  const B = [...buckets][0];

  const broad = ['https://storage.googleapis.com', 'https://firebasestorage.googleapis.com', 'https://*.firebasestorage.app'];
  const wide = [];
  rules.forEach((r) => (r.headers || []).forEach((h) => {
    if (!CSP_KEYS.includes(h.key)) return;
    const img = parse(h.value)['img-src'] || [];
    broad.forEach((s) => { if (img.includes(s)) wide.push((r.source || r.regex) + ' ' + h.key + ' ' + s); });
  }));
  ok('no img-src admits a whole Storage host', wide.length === 0, wide.join('\n      '));

  const dl = `https://firebasestorage.googleapis.com/v0/b/${B}/o/photos%2Fabc%2Froof.jpg?alt=media&token=t`;
  const signed = `https://storage.googleapis.com/${B}/public-lead-photos/x/roof.jpg?X-Goog-Signature=s`;
  for (const p of ['/pro/dashboard', '/pro/customer', '/pro/portal', '/pro/login', '/pro/leaderboard', '/pro/ai-tree', '/']) {
    ok(`${p}: NBD download-token URLs still render`, imgAllows(p, dl));
  }
  for (const p of ['/pro/dashboard', '/pro/customer', '/pro/portal', '/']) {
    ok(`${p}: NBD signed Storage URLs still render`, imgAllows(p, signed));
  }
  ok('/pro/dashboard: another bucket on storage.googleapis.com is refused', !imgAllows('/pro/dashboard', 'https://storage.googleapis.com/someone-else/x.png'));
  ok('/pro/dashboard: another bucket on firebasestorage.googleapis.com is refused', !imgAllows('/pro/dashboard', 'https://firebasestorage.googleapis.com/v0/b/someone-else.appspot.com/o/x.png?alt=media'));
  ok('/pro/portal: a look-alike bucket prefix is refused', !imgAllows('/pro/portal', `https://storage.googleapis.com/${B}-evil/x.png`));
  ok('/pro/dashboard: map tiles and Google avatars still render (unrelated hosts kept)',
    imgAllows('/pro/dashboard', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/1/1/1')
    && imgAllows('/pro/dashboard', 'https://lh3.googleusercontent.com/a/x'));
}

// ── 3. Clarity only on the public site ───────────────────────────────
console.log('\n3. Clarity hosts: public site only');
{
  const CLARITY = /clarity\.ms|c\.bing\.com/;
  for (const p of ['/', '/services/roof-replacement', '/about', '/blog/x', '/process']) {
    ok(`${p} (public) admits Clarity on both CSP headers`, CSP_KEYS.every((k) => CLARITY.test(effective(p, k) || '')));
  }
  const crm = ['/pro', '/pro/', '/pro/dashboard', '/pro/customer', '/pro/vault', '/pro/login', '/pro/register',
    '/pro/portal', '/pro/ai-tree', '/pro/daily-success/x', '/admin', '/admin/vault', '/admin/login', '/dev/x', '/sites/oaks', '/sites/t/abc'];
  for (const p of crm) {
    const leak = CSP_KEYS.filter((k) => !effective(p, k) || CLARITY.test(effective(p, k)));
    ok(`${p} gets a CSP on both headers with no Clarity host`, leak.length === 0, leak.join(', '));
  }

  // Drift guard: the no-Clarity rules are the '**' policies minus Clarity, so
  // the CRM keeps every other directive and a later '**' change can't leave
  // it on a stale copy.
  const star = rules.find((r) => r.source === '**');
  const strip = (v) => String(v).replace(/ https:\/\/(www|scripts|\*)\.clarity\.ms| https:\/\/c\.bing\.com/g, '');
  for (const k of CSP_KEYS) {
    const g = star.headers.find((h) => h.key === k).value;
    ok(`${k}: /pro/dashboard = '**' minus Clarity, nothing else changed`, effective('/pro/dashboard', k) === strip(g));
    ok(`${k}: /sites/oaks = '**' minus Clarity`, effective('/sites/oaks', k) === strip(g));
  }
  ok('the per-page /pro/login policy still wins over the no-Clarity rule',
    effective('/pro/login', 'Content-Security-Policy') === rules.filter((r) => r.source === '/pro/login').map((r) => (r.headers || []).find((h) => h.key === 'Content-Security-Policy')).filter(Boolean).pop().value);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
