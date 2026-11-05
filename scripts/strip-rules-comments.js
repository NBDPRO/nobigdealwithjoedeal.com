#!/usr/bin/env node
/**
 * strip-rules-comments.js — keep firestore.rules under Google's upload cap.
 *
 * The Rules API refuses a ruleset whose sources total 262,144 bytes or more
 * ("Total size of sources must be smaller than 262144"). firestore.rules is
 * about 55% comments, and #2792 pushed the commented file to 263,469 bytes:
 * every deploy from 2026-11-05 02:50Z stopped at "Deploy Firestore rules", so
 * indexes, Storage rules and Cloud Functions stopped shipping too (Hosting
 * deploys first and kept going).
 *
 * The fix keeps the comments in the repo and drops them from the copy that is
 * uploaded. Only lines that are nothing but a `//` comment are removed (plus
 * trailing whitespace and runs of blank lines). A `//` after code, or inside a
 * string such as 'https://...', is never touched, so every code line deploys
 * byte-for-byte as tested. --write proves that before it writes: the code lines
 * of the output must equal the code lines of the input, in order.
 *
 *   node scripts/strip-rules-comments.js --check [file]   report; exit 1 if the
 *                                                          stripped copy would
 *                                                          still be too big
 *   node scripts/strip-rules-comments.js --write [file]   strip in place (the
 *                                                          deploy job only)
 *
 * file defaults to firestore.rules. Sizes are counted with LF line endings,
 * which is what the Linux deploy runner checks out.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LIMIT = 262144;
// Warn well before the cap so the next big rules PR gets a heads-up in CI
// instead of a dead deploy.
const WARN_AT = 240000;

function isCommentOnly(line) {
  return /^\s*\/\//.test(line);
}

function strip(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const raw of lines) {
    if (isCommentOnly(raw)) continue;
    const line = raw.replace(/\s+$/, '');
    if (line === '' && out.length && out[out.length - 1] === '') continue;
    out.push(line);
  }
  while (out.length && out[0] === '') out.shift();
  return out.join('\n').replace(/\n*$/, '\n');
}

function codeLines(src) {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !isCommentOnly(l))
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '');
}

function main(argv) {
  const mode = argv[0];
  if (mode !== '--check' && mode !== '--write') {
    console.error('usage: strip-rules-comments.js --check|--write [file]');
    return 2;
  }
  const file = path.resolve(argv[1] || 'firestore.rules');
  const src = fs.readFileSync(file, 'utf8');
  const rawBytes = Buffer.byteLength(src.replace(/\r\n/g, '\n'), 'utf8');
  const out = strip(src);
  const outBytes = Buffer.byteLength(out, 'utf8');

  const a = codeLines(src);
  const b = codeLines(out);
  if (a.length !== b.length || a.some((l, i) => l !== b[i])) {
    console.error('::error::strip-rules-comments: stripping changed a code line; refusing.');
    return 1;
  }

  const name = path.basename(file);
  console.log(`${name}: ${rawBytes} bytes with comments, ${outBytes} bytes uploaded (limit ${LIMIT}).`);
  if (outBytes >= LIMIT) {
    console.error(`::error::${name} is still ${outBytes} bytes without comments; the Rules API caps uploads at ${LIMIT}. Split or shrink the rules.`);
    return 1;
  }
  if (outBytes >= WARN_AT) {
    console.log(`::warning::${name} uploads at ${outBytes} bytes, close to the ${LIMIT} cap.`);
  }
  if (mode === '--write') fs.writeFileSync(file, out);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { strip, codeLines, isCommentOnly, LIMIT };
