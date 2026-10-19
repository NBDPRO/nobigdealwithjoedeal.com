/**
 * tests/lib/strip-js-comments.js — drop JS comments before a source-regex
 * assertion, so a comment that quotes the bug (or a banned phrase) can neither
 * satisfy a presence check nor trip an absence check.
 *
 * A small string-aware scanner (not a regex): it leaves '...', "..." and `...`
 * literals alone, so 'https://x' is not eaten as a line comment.
 */
'use strict';

function stripJsComments(src) {
  const s = String(src);
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n && s[i] !== q) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i]; i++;
      }
      out += q; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

module.exports = { stripJsComments };
