'use strict';
/**
 * scripts/lib/toplevel-scan.js — find a classic script's top-level declarations without a parser dependency.
 *
 * Used by scripts/concat-shipped.js (CRM speed-up Phase 2) and its guard tests. A small scanner tracks {} depth while
 * skipping comments, strings, template literals (with nested ${}) and regex literals; a `function` / `let` / `const`
 * / `class` declaration at depth 0 is top level. It reports `balanced: false` when a file does not end at depth 0, so a
 * misread is never silent. It also reports a top-level 'use strict' directive (the first statement of the file).
 */

const REGEX_BEFORE = /[(,=:[!&|?{};+\-*%<>~^]/;
const REGEX_AFTER_WORD = /^(return|typeof|case|in|of|delete|void|throw|new|else|do|instanceof|yield|await)$/;

function topLevelDecls(src) {
  const names = new Set();
  let depth = 0, i = 0, prev = '';
  const tmpl = []; // brace depth at which each open template's ${ ... } began
  const n = src.length;
  const isIdent = (c) => /[\w$]/.test(c);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; prev = 'x'; continue; }
    if (c === '`' || (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === depth)) {
      if (c === '}') tmpl.pop();
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { tmpl.push(depth); i += 2; break; }
        i++;
      }
      if (src[i] === '`') i++;
      prev = 'x';
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_BEFORE.test(prev) || REGEX_AFTER_WORD.test(prev))) {
      i++; let cls = false;
      while (i < n) {
        const r = src[i];
        if (r === '\\') { i += 2; continue; }
        if (r === '[') cls = true; else if (r === ']') cls = false; else if ((r === '/' && !cls) || r === '\n') break;
        i++;
      }
      i++; while (i < n && /[a-z]/.test(src[i])) i++;
      prev = 'x';
      continue;
    }
    if (isIdent(c)) {
      let j = i; while (j < n && isIdent(src[j])) j++;
      const word = src.slice(i, j);
      if (depth === 0 && !/[.\w$]/.test(src[i - 1] || '')) {
        const rest = src.slice(j, j + 120);
        let m = null;
        if (word === 'function') m = rest.match(/^\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
        else if (word === 'let' || word === 'const' || word === 'class') m = rest.match(/^\s+([A-Za-z_$][\w$]*)/);
        if (m) names.add(m[1]);
      }
      prev = word; i = j; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return { names, balanced: depth === 0 && tmpl.length === 0, useStrict: hasTopLevelUseStrict(src) };
}

/** True when the file's first statement (after comments) is a 'use strict' directive. */
function hasTopLevelUseStrict(src) {
  const head = src.replace(/^﻿/, '').replace(/^(\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*))*\s*/, '');
  return /^(['"])use strict\1/.test(head);
}

/**
 * The source with comments and string / template-literal TEXT blanked to spaces (same length, newlines kept), so a
 * search for an identifier only ever hits code. Template ${…} expressions are code and are kept. Regex literal bodies
 * are blanked too.
 */
function codeOnly(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0, prev = '';
  const tmpl = [];
  let depth = 0;
  const n = src.length;
  const isIdent = (c) => /[\w$]/.test(c);
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { const s = i; while (i < n && src[i] !== '\n') i++; blank(s, i); continue; }
    if (c === '/' && d === '*') { const s = i; const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; blank(s, i); continue; }
    if (c === '"' || c === "'") { const s = i; i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; blank(s + 1, i - 1); prev = 'x'; continue; }
    if (c === '`' || (c === '}' && tmpl.length && tmpl[tmpl.length - 1] === depth)) {
      if (c === '}') tmpl.pop();
      i++; const s = i;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') { tmpl.push(depth); break; }
        i++;
      }
      blank(s, i);
      if (src[i] === '$') i += 2; else if (src[i] === '`') i++;
      prev = 'x';
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_BEFORE.test(prev) || REGEX_AFTER_WORD.test(prev))) {
      const s = i; i++; let cls = false;
      while (i < n) { const r = src[i]; if (r === '\\') { i += 2; continue; } if (r === '[') cls = true; else if (r === ']') cls = false; else if ((r === '/' && !cls) || r === '\n') break; i++; }
      i++; while (i < n && /[a-z]/.test(src[i])) i++;
      blank(s, i); prev = 'x';
      continue;
    }
    if (isIdent(c)) { let j = i; while (j < n && isIdent(src[j])) j++; prev = src.slice(i, j); i = j; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

/** files: [[name, text], ...] → { dups: [[id, [names]]], unbalanced: [names] } */
function duplicates(files) {
  const seen = new Map();
  const unbalanced = [];
  for (const [name, text] of files) {
    const r = topLevelDecls(text);
    if (!r.balanced) unbalanced.push(name);
    for (const id of r.names) (seen.get(id) || seen.set(id, []).get(id)).push(name);
  }
  return { dups: [...seen].filter(([, where]) => where.length > 1), unbalanced };
}

module.exports = { topLevelDecls, hasTopLevelUseStrict, duplicates, codeOnly };
