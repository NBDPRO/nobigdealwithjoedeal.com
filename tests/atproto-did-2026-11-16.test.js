/**
 * tests/atproto-did-2026-11-16.test.js
 *
 * WHY THIS EXISTS
 * ───────────────
 * Three things were added on 2026-11-16 so outside services can tie No Big
 * Deal's new public profiles to this site. None of them shows up on a page if
 * it breaks, so they are pinned here.
 *
 *   1. Bluesky domain handle. Bluesky fetches /.well-known/atproto-did and
 *      expects the account DID as the whole body. firebase.json's hosting
 *      "ignore" drops **\/.* so a real docs/.well-known/ folder would never
 *      deploy; a rewrite points the path at docs/atproto-did.txt instead.
 *      A trailing newline, a moved file or a reordered rewrite fails quietly.
 *   2. Pinterest website claim: the p:domain_verify meta on the homepage head.
 *   3. The new profiles in the homepage RoofingContractor sameAs and the footer
 *      social strip (both generated from site-src/partials/).
 *
 * Pure Node, no network. Run: node tests/atproto-did-2026-11-16.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DID = 'did:plc:o75hfu3pkeo6odz6x7dsdhrd';
let passed = 0;
let failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.log('  ✗ ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const firebase = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
const hosting = firebase.hosting;
const home = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');

console.log('Profiles + verification (2026-11-16)');

check('docs/atproto-did.txt is exactly the DID, no newline or BOM', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'docs', 'atproto-did.txt'));
  assert(buf.toString('latin1') === DID, 'body was ' + JSON.stringify(buf.toString('latin1')));
});

check('/.well-known/atproto-did rewrites to /atproto-did.txt', () => {
  const r = (hosting.rewrites || []).find((x) => x.source === '/.well-known/atproto-did');
  assert(r, 'no rewrite for /.well-known/atproto-did');
  assert(r.destination === '/atproto-did.txt', 'destination is ' + r.destination);
  assert(hosting.public === 'docs', 'hosting.public moved to ' + hosting.public);
});

check('no redirect or earlier rewrite captures /.well-known/atproto-did first', () => {
  const rewrites = hosting.rewrites || [];
  const idx = rewrites.findIndex((x) => x.source === '/.well-known/atproto-did');
  for (const r of rewrites.slice(0, idx)) {
    assert(!/^\*\*|^\/\*\*|^\/\.well-known/.test(r.source), 'earlier rewrite ' + r.source + ' can match it');
  }
  for (const r of hosting.redirects || []) {
    assert(!/^\*\*|^\/\*\*|^\/\.well-known/.test(r.source || ''), 'redirect ' + r.source + ' can match it');
  }
});

check('the dotfile ignore still stands (the rewrite exists because of it)', () => {
  assert((hosting.ignore || []).includes('**/.*'), 'ignore no longer drops dotfiles; revisit the rewrite');
});

check('homepage <head> carries the Pinterest domain-verify meta', () => {
  const head = home.slice(0, home.indexOf('</head>'));
  assert(head.includes('<meta name="p:domain_verify" content="36fcd1959b62cfdadcca7e73489a03e8"/>'), 'meta missing from <head>');
});

const PROFILES = [
  'https://www.youtube.com/@nobigdealhomesolutions',
  'https://www.tiktok.com/@nobigdealhomesolutions',
  'https://www.pinterest.com/nobigdealhomesolutions/',
  'https://www.threads.com/@nbdhomesolutions',
  'https://www.houzz.com/pro/webuser_74770817020',
  'https://nextdoor.com/pages/no-big-deal-home-solutions-cincinnati-oh/',
  'https://x.com/NBDHomeSolution',
  'https://bsky.app/profile/nbdhomesolutions.bsky.social',
];

check('homepage RoofingContractor sameAs lists every new profile', () => {
  const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const nodes = blocks.flatMap((b) => b['@graph'] || [b]);
  const org = nodes.find((n) => n['@id'] === 'https://nobigdealwithjoedeal.com/#org');
  assert(org && Array.isArray(org.sameAs), 'no #org node with sameAs');
  for (const u of PROFILES) assert(org.sameAs.includes(u), 'sameAs missing ' + u);
  assert(!org.sameAs.some((u) => /linkedin\.com\/in\//.test(u)), 'a personal LinkedIn is in sameAs');
});

check('homepage footer social strip links every new profile', () => {
  const at = home.indexOf('data-nbd-social="v1"');
  assert(at > -1, 'no footer social strip');
  const strip = home.slice(at, home.indexOf('</span>', at));
  for (const u of PROFILES) assert(strip.includes('href="' + u + '"'), 'footer missing ' + u);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
