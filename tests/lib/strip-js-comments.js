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
  // A whole-line // comment is always a comment, even if an earlier stray quote
  // or backtick (in a regex literal, say) left the scanner thinking it is
  // inside a string. Blank it first; the scanner below handles the rest.
  const s = String(src).replace(/^[ \t]*\/\/.*$/gm, '');
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    const c = s[i], d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      // keep the newlines so line numbers in a report still match the file
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c; i++;
      // '...' and "..." cannot span a line (only `...` can), so a stray quote
      // inside a regex literal desyncs at most ONE line instead of the file.
      while (i < n && s[i] !== q && (q === '`' || s[i] !== '\n')) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        out += s[i]; i++;
      }
      if (i < n && s[i] === q) { out += q; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

module.exports = { stripJsComments };
